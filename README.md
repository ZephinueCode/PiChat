# PiChat

PiChat is a local Pi package that makes interactive Pi sessions read like a private chat while preserving Pi's coding-agent controls.

## Behavior

- User messages render as compact, right-aligned green bubbles.
- Assistant prose renders as compact, left-aligned neutral bubbles.
- Reasoning text is not rendered in the transcript. During generation, the working row says `Pi Agent is typing…`.
- Fenced code blocks stay outside chat bubbles and use Pi's native Markdown/code renderer.
- Tool calls and tool results remain in Pi's native tool components, including collapse/expand behavior.
- The editor, footer, abort keys, model controls, session storage, and LLM context are unchanged.

The extension only changes presentation. It does not rewrite user messages, assistant messages, tool results, or saved session content.

## Design

Pi 0.84 exposes complete renderers for custom messages but not a replacement renderer for built-in user and assistant messages. PiChat therefore combines:

1. A standard Pi package and theme.
2. The documented working-indicator, header, status, and theme APIs.
3. A guarded runtime display patch on Pi's publicly exported `UserMessageComponent` and `AssistantMessageComponent` classes.

The patch keeps tool rendering untouched and calls Pi's original component methods whenever PiChat is disabled or no TUI theme is available. The global patch symbols prevent recursive patch stacking during `/reload`.

## Install

Install directly from GitHub after replacing `<owner>` with the repository owner:

```bash
pi install https://github.com/<owner>/PiChat
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

Use `/reload` after editing the extension. Restart Pi after changing global settings.

## Remove

```bash
pi remove https://github.com/<owner>/PiChat
```

Then change `theme` back to `dark` and remove or disable `hideThinkingBlock` if desired.

## Compatibility

Developed against Pi 0.84.2. The documented public TUI APIs are stable, but the compact built-in message layout depends on the exported message component fields used by that version. If those fields change, PiChat falls back to the native renderer rather than modifying session data.

Official references:

- <https://pi.dev/docs/latest/extensions>
- <https://pi.dev/docs/latest/tui>
- <https://pi.dev/docs/latest/packages>
