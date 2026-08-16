import {
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  installChatLayoutPatch,
  runtimeState,
} from "./chat-layout.ts";
import { installAudioExtension } from "./audio.ts";

const THEME_NAME = "pichat-dark";
const STATUS_KEY = "pichat";
const TYPING_WIDGET_KEY = "pichat-typing";

class ChatHeader implements Component {
  constructor(private readonly theme: Theme) {}

  render(width: number): string[] {
    if (width < 20) return [this.theme.fg("accent", "● PiChat")];
    return [
      `${this.theme.fg("accent", "●")} ${this.theme.bold("PiChat · Private Chat")}`,
      this.theme.fg("dim", "  Enter send · Esc interrupt · Ctrl+O tools"),
      "",
    ];
  }

  invalidate(): void {}
}

function configureChatUi(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;

  runtimeState.enabled = true;
  const themeResult = ctx.ui.setTheme(THEME_NAME);
  runtimeState.theme = ctx.ui.theme;
  ctx.ui.setWorkingVisible(true);
  ctx.ui.setWorkingMessage("Pi Agent is typing…");
  ctx.ui.setWorkingIndicator({
    frames: ["·", "••", "•••"].map((frame) =>
      ctx.ui.theme.fg("accent", frame),
    ),
    intervalMs: 240,
  });
  ctx.ui.setHiddenThinkingLabel("Pi Agent is typing…");
  ctx.ui.setHeader((_tui, theme) => new ChatHeader(theme));
  ctx.ui.setStatus(
    STATUS_KEY,
    ctx.ui.theme.fg("accent", "● PiChat"),
  );
  ctx.ui.setTitle("PiChat");

  if (!themeResult.success) {
    ctx.ui.notify(`Failed to load the PiChat theme: ${themeResult.error}`, "warning");
  }
}

function disableChatUi(ctx: ExtensionContext): void {
  runtimeState.enabled = false;
  runtimeState.theme = ctx.ui.theme;
  if (ctx.mode !== "tui") return;
  ctx.ui.setWorkingVisible(true);
  ctx.ui.setWorkingMessage();
  ctx.ui.setWorkingIndicator();
  ctx.ui.setHiddenThinkingLabel();
  ctx.ui.setHeader(undefined);
  ctx.ui.setStatus(STATUS_KEY, undefined);
  ctx.ui.setWidget(TYPING_WIDGET_KEY, undefined);
  ctx.ui.setTitle("pi");
  ctx.ui.setTheme(ctx.ui.theme);
}

function showTyping(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui" || !runtimeState.enabled) return;
  ctx.ui.setWidget(
    TYPING_WIDGET_KEY,
    [ctx.ui.theme.fg("dim", "  Pi Agent is typing…")],
    { placement: "aboveEditor" },
  );
}

function hideTyping(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  ctx.ui.setWidget(TYPING_WIDGET_KEY, undefined);
}

export default function pichatExtension(pi: ExtensionAPI): void {
  installChatLayoutPatch();
  const audio = installAudioExtension(pi);

  pi.on("session_start", (_event, ctx) => {
    configureChatUi(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    showTyping(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    hideTyping(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    hideTyping(ctx);
    await audio.shutdown(ctx);
  });

  pi.registerCommand("pichat", {
    description: "Show or toggle the PiChat conversation UI",
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase();
      if (mode === "off") {
        disableChatUi(ctx);
        await audio.disable(ctx);
        ctx.ui.notify("PiChat UI is disabled for this process. It will be enabled again after restarting Pi.", "info");
        return;
      }
      if (mode === "on") {
        configureChatUi(ctx);
        ctx.ui.notify("PiChat UI is enabled.", "info");
        return;
      }
      if (mode) {
        ctx.ui.notify("Usage: /pichat [on|off]", "warning");
        return;
      }
      ctx.ui.notify(
        `PiChat UI is ${runtimeState.enabled ? "enabled" : "disabled"}. Recommended theme: ${THEME_NAME}.`,
        "info",
      );
    },
  });
}
