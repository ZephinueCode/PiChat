import { Type } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { AudioServiceClient, type RecordingStatus } from "./audio-client.ts";
import { runtimeState, splitMarkdownSegments } from "./chat-layout.ts";

const AUDIO_STATUS_KEY = "pichat-audio";

interface AudioRuntime {
  ttsEnabled: boolean;
  ttsLoaded: boolean;
  callEnabled: boolean;
  mic: "idle" | "recording" | "transcribing";
  activeRecordingId?: string;
  pendingAssistantText?: string;
  generation: number;
  sessionActive: boolean;
}

interface AssistantMessageLike {
  role: string;
  content?: Array<
    | { type: "text"; text: string }
    | { type: string; [key: string]: unknown }
  >;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { error: message },
    isError: true,
  };
}

function speechText(message: AssistantMessageLike): string {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
  const prose = message.content
    .filter((item): item is { type: "text"; text: string } =>
      item.type === "text" && typeof item.text === "string")
    .flatMap((item) => splitMarkdownSegments(item.text))
    .filter((segment) => segment.kind === "chat")
    .map((segment) => segment.text)
    .join("\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/`[^`\n]+`/g, "")
    .replace(/^\s{0,3}(?:#{1,6}|[-*+] |>+)\s*/gm, "")
    .replace(/\*\*|__|~~/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return prose;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface AudioController {
  disable(ctx: ExtensionContext): Promise<void>;
  shutdown(ctx: ExtensionContext): Promise<void>;
}

export function installAudioExtension(pi: ExtensionAPI): AudioController {
  const client = new AudioServiceClient();
  const state: AudioRuntime = {
    ttsEnabled: false,
    ttsLoaded: false,
    callEnabled: false,
    mic: "idle",
    generation: 0,
    sessionActive: true,
  };

  const safeNotify = (
    ctx: ExtensionContext,
    message: string,
    type: "info" | "warning" | "error" = "info",
  ): void => {
    try {
      ctx.ui.notify(message, type);
    } catch {
      // Session teardown can race a final agent_settled callback.
    }
  };

  const requirePiChat = (ctx: ExtensionContext): boolean => {
    if (runtimeState.enabled) return true;
    ctx.ui.notify("Audio commands are available only while PiChat is enabled.", "warning");
    return false;
  };

  const updateStatus = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    if (!runtimeState.enabled || (!state.ttsEnabled && !state.callEnabled && state.mic === "idle")) {
      ctx.ui.setStatus(AUDIO_STATUS_KEY, undefined);
      return;
    }
    const parts = [
      state.ttsEnabled ? "TTS" : undefined,
      state.mic === "recording" ? "REC" : state.mic === "transcribing" ? "ASR" : undefined,
      state.callEnabled ? "CALL" : undefined,
    ].filter(Boolean);
    ctx.ui.setStatus(AUDIO_STATUS_KEY, ctx.ui.theme.fg("accent", `● ${parts.join(" · ")}`));
  };

  const enableTts = async (ctx: ExtensionContext, notify = true): Promise<void> => {
    if (notify) ctx.ui.notify("Starting Qwen3-TTS and loading the default voice…", "info");
    await client.loadTts();
    state.ttsLoaded = true;
    state.ttsEnabled = true;
    updateStatus(ctx);
    if (notify) ctx.ui.notify("TTS is on.", "info");
  };

  const cancelAudio = async (ctx: ExtensionContext, unloadTts: boolean): Promise<void> => {
    state.generation += 1;
    state.callEnabled = false;
    const recordingId = state.activeRecordingId;
    state.activeRecordingId = undefined;
    state.mic = "idle";
    if (recordingId) {
      try { await client.stopRecording(recordingId); } catch { /* already stopped */ }
    }
    try { await client.stopPlayback(); } catch { /* service may not be running */ }
    if (unloadTts) {
      try { await client.unloadTts(); } catch { /* service may not be running */ }
      state.ttsLoaded = false;
      state.ttsEnabled = false;
    }
    updateStatus(ctx);
  };

  const finishRecording = async (
    initial: RecordingStatus,
    ctx: ExtensionCommandContext,
    cycle: number,
    autoSend: boolean,
  ): Promise<void> => {
    let recording = initial;
    try {
      while (recording.state === "recording" && cycle === state.generation) {
        await wait(250);
        recording = await client.recording(recording.id);
      }
      if (cycle !== state.generation) return;
      state.activeRecordingId = undefined;
      if (!recording.path || recording.state === "error") {
        state.mic = "idle";
        updateStatus(ctx);
        const detail = recording.error || recording.reason || "No speech was captured.";
        ctx.ui.notify(`Recording ended: ${detail}`, "warning");
        if (state.callEnabled) await startRecording(ctx, true);
        return;
      }

      state.mic = "transcribing";
      updateStatus(ctx);
      const result = await client.transcribe({ source: recording.path, language: "auto" });
      if (cycle !== state.generation) return;
      state.mic = "idle";
      updateStatus(ctx);
      const transcript = result.text.trim();
      if (!transcript) {
        ctx.ui.notify("No speech was recognized.", "warning");
        if (state.callEnabled) await startRecording(ctx, true);
        return;
      }

      if (autoSend && state.callEnabled) {
        ctx.ui.notify(`Heard: ${transcript}`, "info");
        pi.sendUserMessage(transcript);
      } else {
        const current = ctx.ui.getEditorText().trim();
        ctx.ui.setEditorText(current ? `${current}\n${transcript}` : transcript);
        ctx.ui.notify("Transcript inserted into the editor. Review it, then press Enter.", "info");
      }
    } catch (error) {
      if (cycle !== state.generation) return;
      state.activeRecordingId = undefined;
      state.mic = "idle";
      updateStatus(ctx);
      ctx.ui.notify(`Microphone/ASR failed: ${errorText(error)}`, "error");
    }
  };

  const startRecording = async (
    ctx: ExtensionCommandContext,
    autoSend: boolean,
  ): Promise<void> => {
    if (!runtimeState.enabled || state.activeRecordingId) return;
    const cycle = state.generation;
    const recording = await client.startRecording();
    if (cycle !== state.generation) {
      try { await client.stopRecording(recording.id); } catch { /* cancelled */ }
      return;
    }
    state.activeRecordingId = recording.id;
    state.mic = "recording";
    updateStatus(ctx);
    ctx.ui.notify("Recording… Speak naturally; silence will stop it automatically. Run /mic again to stop now.", "info");
    void finishRecording(recording, ctx, cycle, autoSend);
  };

  pi.registerCommand("tts", {
    description: "Toggle automatic Qwen3-TTS speech for PiChat replies",
    handler: async (_args, ctx) => {
      if (!requirePiChat(ctx)) return;
      try {
        if (state.ttsEnabled) {
          await cancelAudio(ctx, true);
          ctx.ui.notify("TTS is off.", "info");
        } else {
          await enableTts(ctx);
        }
      } catch (error) {
        state.ttsEnabled = false;
        updateStatus(ctx);
        ctx.ui.notify(`TTS failed: ${errorText(error)}`, "error");
      }
    },
  });

  pi.registerCommand("mic", {
    description: "Start or stop microphone recording and transcribe with FunASR",
    handler: async (_args, ctx) => {
      if (!requirePiChat(ctx)) return;
      try {
        if (state.activeRecordingId) {
          ctx.ui.notify("Stopping recording…", "info");
          await client.stopRecording(state.activeRecordingId);
          return;
        }
        await startRecording(ctx, state.callEnabled);
      } catch (error) {
        state.mic = "idle";
        state.activeRecordingId = undefined;
        updateStatus(ctx);
        ctx.ui.notify(`Microphone failed: ${errorText(error)}`, "error");
      }
    },
  });

  pi.registerCommand("call", {
    description: "Toggle hands-free PiChat voice-call mode",
    handler: async (_args, ctx) => {
      if (!requirePiChat(ctx)) return;
      try {
        if (state.callEnabled) {
          await cancelAudio(ctx, false);
          ctx.ui.notify("Voice-call mode is off.", "info");
          return;
        }
        if (!state.ttsEnabled) await enableTts(ctx, false);
        state.callEnabled = true;
        state.generation += 1;
        updateStatus(ctx);
        ctx.ui.notify("Voice-call mode is on.", "info");
        await startRecording(ctx, true);
      } catch (error) {
        state.callEnabled = false;
        updateStatus(ctx);
        ctx.ui.notify(`Voice-call mode failed: ${errorText(error)}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "tts_speak",
    label: "TTS Speak",
    description: "Synthesize and optionally play speech through PiChat's local Qwen3-TTS service. Use for an explicit requested utterance; normal PiChat automatic reply speech is controlled by /tts and does not require this tool.",
    promptSnippet: "Synthesize an explicit utterance with the local PiChat TTS service",
    parameters: Type.Object({
      text: Type.String({ description: "Text to speak" }),
      profile: Type.Optional(Type.String({ description: "Voice profile name; defaults to the configured profile" })),
      language: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("zh"), Type.Literal("en")])),
      play: Type.Optional(Type.Boolean({ description: "Play after synthesis; defaults to true" })),
      interrupt: Type.Optional(Type.Boolean({ description: "Stop current playback first; defaults to true" })),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!runtimeState.enabled) return toolError("tts_speak is unavailable because PiChat is disabled.");
      try {
        if (!state.ttsLoaded) {
          await client.loadTts();
          state.ttsLoaded = true;
        }
        const result = await client.speak(params);
        return {
          content: [{ type: "text", text: `Speech synthesized${result.played ? " and played" : ""} (${result.durationMs} ms, profile ${result.profile}).` }],
          details: result,
        };
      } catch (error) {
        return toolError(`TTS failed: ${errorText(error)}`);
      } finally {
        updateStatus(ctx);
      }
    },
  });

  pi.registerTool({
    name: "asr_transcribe",
    label: "ASR Transcribe",
    description: "Transcribe an existing local audio file with PiChat's FunASR service. This tool never opens the microphone; /mic is user-controlled.",
    promptSnippet: "Transcribe an existing audio file with local FunASR",
    parameters: Type.Object({
      source: Type.String({ description: "Absolute or working-directory-relative audio file path" }),
      language: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("zh"), Type.Literal("en")])),
      timestamps: Type.Optional(Type.Boolean({ description: "Request timestamps when supported" })),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!runtimeState.enabled) return toolError("asr_transcribe is unavailable because PiChat is disabled.");
      try {
        const source = params.source.match(/^[A-Za-z]:[\\/]/) ? params.source : `${_ctx.cwd}/${params.source}`;
        const result = await client.transcribe({ ...params, source });
        return {
          content: [{ type: "text", text: result.text || "No speech was recognized." }],
          details: result,
        };
      } catch (error) {
        return toolError(`ASR failed: ${errorText(error)}`);
      }
    },
  });

  pi.on("agent_start", () => {
    state.pendingAssistantText = undefined;
  });

  pi.on("session_start", () => {
    state.sessionActive = true;
  });

  pi.on("message_end", (event) => {
    if (!runtimeState.enabled) return;
    const text = speechText(event.message as AssistantMessageLike);
    if (text) state.pendingAssistantText = text;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!state.sessionActive || !runtimeState.enabled || !state.ttsEnabled) return;
    const text = state.pendingAssistantText;
    state.pendingAssistantText = undefined;
    const cycle = state.generation;
    try {
      if (text) {
        safeNotify(ctx, "Generating speech…");
        await client.speak({ text, play: true, interrupt: true });
      }
      if (cycle === state.generation && state.callEnabled && ctx.mode === "tui") {
        await startRecording(ctx as ExtensionCommandContext, true);
      }
    } catch (error) {
      if (!state.sessionActive || cycle !== state.generation) return;
      safeNotify(ctx, `Automatic TTS failed: ${errorText(error)}`, "error");
      if (state.callEnabled) {
        state.callEnabled = false;
        updateStatus(ctx);
      }
    }
  });

  const controller: AudioController = {
    async disable(ctx) {
      await cancelAudio(ctx, true);
      await client.shutdown();
      ctx.ui.setStatus(AUDIO_STATUS_KEY, undefined);
    },
    async shutdown(ctx) {
      state.sessionActive = false;
      await cancelAudio(ctx, true);
      await client.shutdown();
      ctx.ui.setStatus(AUDIO_STATUS_KEY, undefined);
    },
  };
  return controller;
}
