import { Type } from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  AudioServiceClient,
  type RecordingStatus,
  type VoiceInfo,
} from "./audio-client.ts";
import {
  holdNextAssistantText,
  PICHAT_TYPING_WIDGET_KEY,
  releaseAssistantText,
  runtimeState,
} from "./chat-layout.ts";
import { sanitizeSpeechText, speechText } from "./speech-text.ts";

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
  manualVoice?: string;
  skillVoice?: string;
  activeSkillPath?: string;
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

  const activeVoice = (): string | undefined => state.skillVoice ?? state.manualVoice;

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

  const revealAssistant = (ctx?: ExtensionContext): void => {
    releaseAssistantText();
    if (ctx?.mode !== "tui") return;
    try {
      ctx.ui.setWidget(PICHAT_TYPING_WIDGET_KEY, undefined);
    } catch {
      // Session teardown can remove the TUI while synthesis is finishing.
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
      state.ttsEnabled ? `VOICE:${activeVoice() ?? "default"}` : undefined,
      state.mic === "recording" ? "REC" : state.mic === "transcribing" ? "ASR" : undefined,
      state.callEnabled ? "CALL" : undefined,
    ].filter(Boolean);
    ctx.ui.setStatus(AUDIO_STATUS_KEY, ctx.ui.theme.fg("accent", `● ${parts.join(" · ")}`));
  };

  const voiceList = async (): Promise<VoiceInfo[]> => {
    const result = await client.voices();
    return result.voices;
  };

  const clearFailedVoice = (voice: string): void => {
    if (state.skillVoice === voice) state.skillVoice = undefined;
    if (state.manualVoice === voice) state.manualVoice = undefined;
  };

  const loadActiveTts = async (ctx: ExtensionContext): Promise<void> => {
    const candidates: Array<string | undefined> = [state.skillVoice, state.manualVoice, undefined];
    const unique = candidates.filter(
      (candidate, index) => candidates.findIndex((value) => value === candidate) === index,
    );
    let lastError: unknown;
    for (const candidate of unique) {
      try {
        await client.loadTts(candidate);
        state.ttsLoaded = true;
        return;
      } catch (error) {
        lastError = error;
        if (candidate) {
          clearFailedVoice(candidate);
          updateStatus(ctx);
          safeNotify(
            ctx,
            `Voice '${candidate}' is unavailable; trying the fallback voice. ${errorText(error)}`,
            "warning",
          );
        }
      }
    }
    throw lastError ?? new Error("No TTS voice is available.");
  };

  const speakWithFallback = async (
    input: {
      text: string;
      profile?: string;
      language?: string;
      play?: boolean;
      interrupt?: boolean;
    },
    ctx: ExtensionContext,
  ) => {
    const requested = input.profile ?? activeVoice();
    const candidates: Array<string | undefined> = [requested];
    if (input.profile) candidates.push(activeVoice());
    if (state.skillVoice) candidates.push(state.manualVoice);
    candidates.push(undefined);
    const unique = candidates.filter(
      (candidate, index) => candidates.findIndex((value) => value === candidate) === index,
    );
    let lastError: unknown;
    for (const candidate of unique) {
      try {
        return await client.speak({ ...input, profile: candidate });
      } catch (error) {
        lastError = error;
        if (candidate) {
          clearFailedVoice(candidate);
          updateStatus(ctx);
          safeNotify(
            ctx,
            `Voice '${candidate}' failed; trying the fallback voice. ${errorText(error)}`,
            "warning",
          );
        }
      }
    }
    throw lastError ?? new Error("No TTS voice is available.");
  };

  const skillVoiceFromPath = (skillFile: string): string | undefined => {
    const configPath = path.join(path.dirname(skillFile), "pichat.json");
    if (!existsSync(configPath)) return undefined;
    try {
      const value = JSON.parse(readFileSync(configPath, "utf8")) as { voice?: unknown };
      const voice = typeof value.voice === "string" ? value.voice.trim() : "";
      return voice || undefined;
    } catch {
      return undefined;
    }
  };

  const activateSkillVoice = (
    skillFile: string,
    ctx: ExtensionContext,
    clearWhenMissing = false,
  ): void => {
    const resolved = path.resolve(skillFile);
    if (state.activeSkillPath === resolved) return;
    const requestedVoice = skillVoiceFromPath(resolved);
    if (!requestedVoice && !clearWhenMissing) return;
    state.activeSkillPath = resolved;
    state.skillVoice = requestedVoice;
    updateStatus(ctx);
  };

  const enableTts = async (ctx: ExtensionContext, notify = true): Promise<void> => {
    if (notify) ctx.ui.notify("Starting Qwen3-TTS and loading the selected voice…", "info");
    await loadActiveTts(ctx);
    state.ttsEnabled = true;
    updateStatus(ctx);
    if (notify) ctx.ui.notify("TTS is on.", "info");
  };

  const cancelAudio = async (ctx: ExtensionContext, unloadTts: boolean): Promise<void> => {
    state.generation += 1;
    state.callEnabled = false;
    revealAssistant(ctx);
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

  pi.registerCommand("voice", {
    description: "Choose the local voice used by PiChat TTS",
    handler: async (rawArgs, ctx) => {
      if (!requirePiChat(ctx)) return;
      try {
        const voices = await voiceList();
        const available = voices.filter((voice) => voice.available);
        const selectable = available.filter((voice) => !voice.isDefault);
        const argument = rawArgs.trim().toLowerCase();
        if (argument === "list") {
          const lines = voices.map(
            (voice) => `${voice.id}${voice.isDefault ? " (default)" : ""}${voice.available ? "" : " (unavailable)"}`,
          );
          ctx.ui.notify(lines.length ? lines.join("\n") : "No voices are configured.", "info");
          return;
        }

        let selectedId: string | undefined;
        if (argument) {
          if (argument !== "default") {
            const selected = voices.find((voice) => voice.id.toLowerCase() === argument);
            if (!selected) {
              ctx.ui.notify(`Unknown voice '${rawArgs.trim()}'. Run /voice list to see installed voices.`, "warning");
              return;
            }
            if (!selected.available) {
              ctx.ui.notify(`Voice '${selected.id}' has no available model.`, "warning");
              return;
            }
            selectedId = selected.id;
          }
        } else if (ctx.mode === "tui") {
          const defaultLabel = `Default${activeVoice() ? "" : " (current)"}`;
          const labels = [
            defaultLabel,
            ...selectable.map((voice) =>
              `${voice.displayName} [${voice.id}]${activeVoice() === voice.id ? " (current)" : ""}`,
            ),
          ];
          const chosen = await ctx.ui.select("Select a PiChat voice", labels);
          if (!chosen) return;
          if (chosen !== defaultLabel) {
            selectedId = selectable.find((voice) => chosen.includes(`[${voice.id}]`))?.id;
          }
        } else {
          ctx.ui.notify("Usage: /voice <id|default|list>", "info");
          return;
        }

        if (state.ttsEnabled) {
          await client.loadTts(selectedId);
          state.ttsLoaded = true;
        }
        state.manualVoice = selectedId;
        state.skillVoice = undefined;
        state.activeSkillPath = undefined;
        updateStatus(ctx);
        const selected = voices.find((voice) => voice.id === selectedId);
        ctx.ui.notify(`Voice set to ${selected?.displayName ?? "the configured default"}.`, "info");
      } catch (error) {
        ctx.ui.notify(`Voice selection failed: ${errorText(error)}`, "error");
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
        const text = sanitizeSpeechText(params.text);
        if (!text) return toolError("TTS found no speakable prose after removing code, markup, and symbols.");
        if (!state.ttsLoaded) {
          await loadActiveTts(ctx);
        }
        const result = await speakWithFallback({ ...params, text }, ctx);
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
    name: "voice_select",
    label: "Select Voice",
    description: "Select an installed PiChat voice by ID for the current persona. Use only when a skill explicitly requests a voice; use 'default' to clear it.",
    promptSnippet: "Select a local PiChat voice requested by the active skill",
    parameters: Type.Object({
      voice: Type.String({ description: "Installed voice ID, or 'default'" }),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!runtimeState.enabled) return toolError("voice_select is unavailable because PiChat is disabled.");
      const requested = params.voice.trim();
      if (requested.toLowerCase() === "default") {
        state.skillVoice = undefined;
        state.activeSkillPath = undefined;
        updateStatus(ctx);
        return { content: [{ type: "text", text: "PiChat will use the manual/default voice." }], details: {} };
      }
      try {
        const voices = await voiceList();
        const voice = voices.find((item) => item.id.toLowerCase() === requested.toLowerCase());
        if (!voice?.available) return toolError(`Voice '${requested}' is not installed or its model is unavailable.`);
        if (state.ttsEnabled) {
          await client.loadTts(voice.id);
          state.ttsLoaded = true;
        }
        state.skillVoice = voice.id;
        updateStatus(ctx);
        return {
          content: [{ type: "text", text: `PiChat voice selected: ${voice.displayName} (${voice.id}).` }],
          details: { voice: voice.id },
        };
      } catch (error) {
        return toolError(`Voice selection failed: ${errorText(error)}`);
      }
    },
  });

  pi.on("input", (event, ctx) => {
    if (!runtimeState.enabled) return;
    const match = event.text.match(/^\/skill:([^\s]+)/);
    if (!match) return;
    const command = pi.getCommands().find(
      (item) => item.source === "skill" && item.name.replace(/:\d+$/, "") === `skill:${match[1]}`,
    );
    if (command?.sourceInfo.path) activateSkillVoice(command.sourceInfo.path, ctx, true);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (!runtimeState.enabled || event.toolName !== "read") return;
    const args = event.args as Record<string, unknown>;
    const requestedPath = typeof args.path === "string" ? args.path : undefined;
    if (!requestedPath || path.basename(requestedPath).toLowerCase() !== "skill.md") return;
    const skillFile = path.isAbsolute(requestedPath) ? requestedPath : path.resolve(ctx.cwd, requestedPath);
    activateSkillVoice(skillFile, ctx);
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
    if (state.sessionActive && runtimeState.enabled && state.ttsEnabled) {
      holdNextAssistantText();
    } else {
      releaseAssistantText();
    }
  });

  pi.on("session_start", () => {
    state.sessionActive = true;
    state.skillVoice = undefined;
    state.activeSkillPath = undefined;
    releaseAssistantText();
  });

  pi.on("message_end", (event) => {
    if (!runtimeState.enabled) return;
    const text = speechText(event.message);
    if (text) state.pendingAssistantText = text;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!state.sessionActive || !runtimeState.enabled || !state.ttsEnabled) return;
    const text = state.pendingAssistantText;
    state.pendingAssistantText = undefined;
    const cycle = state.generation;
    try {
      if (text) {
        const result = await speakWithFallback({ text, play: false, interrupt: true }, ctx);
        if (cycle !== state.generation || !state.ttsEnabled) return;
        revealAssistant(ctx);
        await client.playGenerated(result.requestId, true);
      } else {
        revealAssistant(ctx);
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
    } finally {
      revealAssistant(ctx);
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
