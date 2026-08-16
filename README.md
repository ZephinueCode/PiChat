# PiChat

PiChat is a local Pi package that makes interactive Pi sessions read like a private chat while preserving Pi's coding-agent controls. It can also run an optional, fully local voice layer based on Qwen3-TTS and FunASR.

## Behavior

- User messages render as compact, right-aligned green bubbles.
- Assistant prose renders as compact, left-aligned neutral bubbles.
- Reasoning text is not rendered in the transcript. During generation, the working row says `Pi Agent is typing…`.
- Fenced code blocks stay outside chat bubbles and use Pi's native Markdown/code renderer.
- Tool calls and tool results remain in Pi's native tool components, including collapse/expand behavior.
- Optional TTS keeps the in-progress reply behind the typing indicator, reveals the complete message when speech synthesis finishes, and then starts playback.
- TTS reads only conversational prose. Thinking, tool calls/results, fenced and inline code, code-like lines, URLs, paths, logs, tables, math, emoji, and decorative symbols are excluded.
- Optional microphone input uses silence detection and local FunASR transcription.
- The editor, footer, abort keys, model controls, session storage, and LLM context are unchanged.

The presentation layer does not rewrite user messages, assistant messages, tool results, or saved session content. Voice-call transcripts are ordinary user messages and therefore are saved in the session just like typed messages.

## Design

Pi 0.84 exposes complete renderers for custom messages but not a replacement renderer for built-in user and assistant messages. PiChat therefore combines:

1. A standard Pi package and theme.
2. The documented working-indicator, header, status, and theme APIs.
3. A guarded runtime display patch on Pi's publicly exported `UserMessageComponent` and `AssistantMessageComponent` classes.

The patch keeps tool rendering untouched and calls Pi's original component methods whenever PiChat is disabled or no TUI theme is available. The global patch symbols prevent recursive patch stacking during `/reload`.

## Install

Install directly from GitHub:

```bash
pi install https://github.com/ZephinueCode/PiChat
```

For local development, install the checkout by path:

```bash
pi install /path/to/PiChat
```

Set these user settings for the intended experience:

```json
{
  "theme": "pichat-dark",
  "hideThinkingBlock": true
}
```

PiChat also suppresses thinking blocks in its patched assistant renderer; the setting provides a safe fallback if a future Pi release changes the component implementation.

Inside Pi:

```text
/pichat
/pichat off
/pichat on
```

### Optional local audio setup

Run the setup script once from the PiChat checkout.

On Windows:

```powershell
.\audio\setup.ps1
```

On Linux:

```bash
chmod +x audio/setup.sh
./audio/setup.sh
```

The Linux script supports apt, dnf, pacman, and zypper for the PortAudio system dependency. Use `--skip-system-packages` when PortAudio is already available or system packages are managed separately.

Both setup scripts create `audio/.venv`, install normal Python dependencies from the Tsinghua PyPI mirror, install PyTorch from PyTorch's official wheel index, and download these model weights from ModelScope:

- `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`
- `iic/SenseVoiceSmall`

PyTorch wheels are not published on standard PyPI mirrors, so PyTorch is the only dependency that does not come from the Tsinghua mirror. To make a CPU-only environment, use:

```powershell
.\audio\setup.ps1 -CpuOnly
```

```bash
./audio/setup.sh --cpu-only
```

To install dependencies without downloading the model weights, use `-SkipModels` on Windows or `--skip-models` on Linux. Linux and Windows virtual environments cannot share the same `audio/.venv` directory.

Restart Pi or run `/reload`, then use:

```text
/tts     Toggle automatic speech for assistant replies
/mic     Start recording; silence or a second /mic stops it
/call    Toggle a hands-free speech → reply → speech loop
```

Outside call mode, `/mic` inserts the transcript into the editor so it can be reviewed before sending. In call mode, the transcript is sent immediately; after the assistant finishes and audio playback completes, recording starts again.

`/tts`, `/mic`, `/call`, `tts_speak`, and `asr_transcribe` all refuse to operate after `/pichat off`. `/pichat off` also stops recording/playback, unloads TTS, and shuts down the localhost service.

The model can call two reusable tools:

- `tts_speak` synthesizes an explicit utterance and optionally plays it.
- `asr_transcribe` transcribes an existing audio file; it never opens the microphone.

Automatic per-reply TTS is handled by Pi lifecycle events rather than relying on the model to call a tool. While TTS is enabled, the extension holds back streamed assistant prose, waits for `agent_settled`, generates one complete utterance, reveals the full reply, starts playback, and only advances the call loop after playback finishes. Tool rendering remains native and is never folded into the held text bubble or speech input.

Local settings live in `audio/config.local.json`. The committed example is [`audio/config.example.json`](audio/config.example.json). Relevant options include TTS/ASR device selection (`auto`, `cuda`, or `cpu`), microphone/output device IDs, VAD timing, and named voice profiles. A profile may use the shared CustomVoice model and a built-in speaker, override `model` with another local checkpoint, or use `mode: "voiceClone"` with `refAudio`/`refText`. Switching profiles unloads the previous TTS checkpoint so only one is resident. Persona skills should refer only to a profile name; model paths, devices, reference recordings, and service details stay in this package.

The audio service binds only to `127.0.0.1` and requires a random per-process bearer token. Environments, models, caches, generated audio, recordings, private profiles, and local configuration are excluded by `.gitignore`.

Use `/reload` after editing the extension. Restart Pi after changing global settings.

## Remove

```bash
pi remove https://github.com/ZephinueCode/PiChat
```

Then change `theme` back to `dark` and remove or disable `hideThinkingBlock` if desired.

## Compatibility

Developed against Pi 0.84.2, Qwen3-TTS 0.1.1, and FunASR 1.4.2. The documented public TUI APIs are stable, but the compact built-in message layout depends on the exported message component fields used by that Pi version. If those fields change, PiChat falls back to the native renderer rather than modifying session data.

Official references:

- <https://pi.dev/docs/latest/extensions>
- <https://pi.dev/docs/latest/tui>
- <https://pi.dev/docs/latest/packages>
- <https://github.com/QwenLM/Qwen3-TTS>
- <https://github.com/modelscope/FunASR>
