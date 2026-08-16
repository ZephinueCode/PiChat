import * as nodePath from "node:path";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionInfo,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import {
  attachFriendsLayout,
  refreshFriendsLayout,
  runtimeState,
} from "./chat-layout.ts";
import { FRIENDS_MIN_TERMINAL_WIDTH } from "./friends-layout.ts";

const CHAT_STATUS_KEY = "pichat-chat";
const MAX_FALLBACK_VISIBLE_CHATS = 12;

interface ChatSession {
  id: string;
  path?: string;
  title: string;
  modelLabel: string;
  modified: Date;
  messageCount: number;
  active: boolean;
}

export interface ModelFriendsController {
  sync(ctx: ExtensionContext): void;
  hide(ctx?: ExtensionContext): void;
  shutdown(ctx?: ExtensionContext): void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function oneLine(source: string | undefined, fallback: string): string {
  const text = source
    ? stripTerminalSequences(source)
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";
  return text || fallback;
}

/**
 * Pi's ANSI-aware truncator emits a full SGR reset around its ellipsis. That is
 * normally useful, but it also cancels a row background wrapped around the
 * result. Session labels are plain text, so remove those generated control
 * sequences before applying foreground and row-background styles.
 */
function truncatePlainText(source: string, width: number): string {
  const safe = oneLine(source, "");
  return stripTerminalSequences(truncateToWidth(safe, width, "…"));
}

function canonicalPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = nodePath.resolve(value).replaceAll("/", nodePath.sep);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(a: string | undefined, b: string | undefined): boolean {
  const left = canonicalPath(a);
  const right = canonicalPath(b);
  return Boolean(left && right && left === right);
}

function currentModelLabel(ctx: ExtensionContext): string {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "Default model";
}

function storedModelLabel(info: SessionInfo): string {
  try {
    const model = SessionManager.open(info.path).buildSessionContext().model;
    return model ? `${model.provider}/${model.modelId}` : "Default model";
  } catch {
    return "Model unavailable";
  }
}

function sessionTitle(info: SessionInfo): string {
  return oneLine(info.name, oneLine(info.firstMessage, "New chat"));
}

function toChatSessions(
  infos: readonly SessionInfo[],
  ctx: ExtensionContext,
): ChatSession[] {
  const currentPath = ctx.sessionManager.getSessionFile();
  const chats = infos
    .map((info): ChatSession => {
      const active = samePath(info.path, currentPath);
      return {
        id: info.id,
        path: info.path,
        title: sessionTitle(info),
        modelLabel: active ? currentModelLabel(ctx) : storedModelLabel(info),
        modified: info.modified,
        messageCount: info.messageCount,
        active,
      };
    })
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());

  if (!chats.some((chat) => chat.active)) {
    chats.unshift({
      id: ctx.sessionManager.getSessionId(),
      path: currentPath,
      title: oneLine(ctx.sessionManager.getSessionName(), "New chat"),
      modelLabel: currentModelLabel(ctx),
      modified: new Date(),
      messageCount: ctx.sessionManager.getEntries().filter((entry) => entry.type === "message").length,
      active: true,
    });
  }
  return chats;
}

function formatChatTime(date: Date, now = new Date()): string {
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

class ChatListPane implements Component {
  private chats: ChatSession[] = [];
  private selectedIndex = 0;
  private selecting = false;
  private loading = true;

  constructor(private readonly theme: Theme) {}

  update(chats: readonly ChatSession[]): void {
    const selectedId = this.chats[this.selectedIndex]?.id;
    this.chats = [...chats];
    const selected = selectedId
      ? this.chats.findIndex((chat) => chat.id === selectedId)
      : -1;
    const active = this.chats.findIndex((chat) => chat.active);
    this.selectedIndex = selected >= 0 ? selected : Math.max(0, active);
    this.loading = false;
  }

  setLoading(loading: boolean): void {
    this.loading = loading;
  }

  isSelecting(): boolean {
    return this.selecting;
  }

  beginSelection(): boolean {
    if (this.chats.length === 0) return false;
    this.selecting = true;
    const active = this.chats.findIndex((chat) => chat.active);
    this.selectedIndex = active >= 0 ? active : 0;
    return true;
  }

  endSelection(): void {
    this.selecting = false;
    const active = this.chats.findIndex((chat) => chat.active);
    if (active >= 0) this.selectedIndex = active;
  }

  move(delta: 1 | -1): void {
    if (this.chats.length === 0) return;
    this.selectedIndex =
      (this.selectedIndex + delta + this.chats.length) % this.chats.length;
  }

  moveTo(edge: "first" | "last"): void {
    if (this.chats.length === 0) return;
    this.selectedIndex = edge === "first" ? 0 : this.chats.length - 1;
  }

  selectedChat(): ChatSession | undefined {
    return this.chats[this.selectedIndex];
  }

  activeChat(): ChatSession | undefined {
    return this.chats.find((chat) => chat.active);
  }

  cycleTarget(delta: 1 | -1): ChatSession | undefined {
    if (this.chats.length < 2) return undefined;
    const active = this.chats.findIndex((chat) => chat.active);
    const start = active >= 0 ? active : 0;
    return this.chats[(start + delta + this.chats.length) % this.chats.length];
  }

  find(query: string): ChatSession[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    return this.chats.filter((chat) => {
      const haystack = `${chat.id} ${chat.title} ${chat.modelLabel} ${chat.path ?? ""}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }

  completionItems(prefix: string): Array<{ value: string; label: string; description: string }> {
    const normalized = prefix.trim().toLowerCase();
    return this.chats
      .filter((chat) => `${chat.title} ${chat.id}`.toLowerCase().includes(normalized))
      .slice(0, 20)
      .map((chat) => ({
        value: chat.id,
        label: chat.title,
        description: chat.modelLabel,
      }));
  }

  private row(
    text: string,
    width: number,
    background: "customMessageBg" | "selectedBg" = "customMessageBg",
  ): string {
    const clipped = visibleWidth(text) > width;
    const fitted = clipped ? sliceByColumn(text, 0, width, true) : text;
    // Reset text attributes without resetting the background wrapped below.
    const textReset = clipped ? "\x1b[22;23;24;27;29;39m" : "";
    const padded = `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
    return this.theme.bg(background, `${padded}${textReset}`);
  }

  private titleRow(chat: ChatSession, width: number, selected: boolean): string {
    const time = formatChatTime(chat.modified);
    const prefix = "  ";
    const titleWidth = Math.max(3, width - visibleWidth(prefix) - visibleWidth(time) - 1);
    const title = truncatePlainText(chat.title, titleWidth);
    const gap = " ".repeat(
      Math.max(1, width - visibleWidth(prefix) - visibleWidth(title) - visibleWidth(time)),
    );
    const styledTitle = this.theme.fg(
      chat.active ? "accent" : "text",
      title,
    );
    return this.row(
      `${prefix}${styledTitle}${gap}${this.theme.fg("dim", time)}`,
      width,
      selected ? "selectedBg" : "customMessageBg",
    );
  }

  private detailRow(chat: ChatSession, width: number, selected: boolean): string {
    const count = `${chat.messageCount} msg`;
    const prefix = "  ";
    const modelWidth = Math.max(3, width - visibleWidth(prefix) - visibleWidth(count) - 1);
    const model = truncatePlainText(chat.modelLabel, modelWidth);
    const gap = " ".repeat(
      Math.max(1, width - visibleWidth(prefix) - visibleWidth(model) - visibleWidth(count)),
    );
    return this.row(
      `${prefix}${this.theme.fg("muted", model)}${gap}${this.theme.fg("dim", count)}`,
      width,
      selected ? "selectedBg" : "customMessageBg",
    );
  }

  render(width: number): string[] {
    const w = Math.max(12, width);
    const count = this.loading ? "…" : `${this.chats.length}`;
    const title = " Chats";
    const titleGap = " ".repeat(
      Math.max(1, w - visibleWidth(title) - visibleWidth(count) - 1),
    );
    const lines = [
      this.row(
        `${this.theme.bold(this.theme.fg("text", title))}${titleGap}${this.theme.fg("dim", count)} `,
        w,
      ),
      this.row(
        this.theme.fg(
          "dim",
          truncatePlainText(
            this.selecting ? " ↑/↓ select · Enter open" : " /chat to select",
            w,
          ),
        ),
        w,
      ),
      this.row("", w),
    ];

    if (!this.loading && this.chats.length === 0) {
      lines.push(this.row(this.theme.fg("muted", "  No saved chats"), w));
      return lines;
    }

    const terminalRows = runtimeState.layoutTui?.terminal.rows ?? 30;
    const maxVisible = Math.max(
      3,
      Math.min(
        MAX_FALLBACK_VISIBLE_CHATS,
        Math.floor(Math.max(6, terminalRows - 5) / 2),
      ),
    );
    const focusIndex = this.selecting
      ? this.selectedIndex
      : Math.max(0, this.chats.findIndex((chat) => chat.active));
    const start = Math.max(
      0,
      Math.min(
        focusIndex - Math.floor(maxVisible / 2),
        Math.max(0, this.chats.length - maxVisible),
      ),
    );
    const end = Math.min(this.chats.length, start + maxVisible);

    for (let index = start; index < end; index++) {
      const chat = this.chats[index]!;
      const selected = this.selecting
        ? index === this.selectedIndex
        : chat.active;
      lines.push(
        this.titleRow(chat, w, selected),
        this.detailRow(chat, w, selected),
      );
    }

    if (start > 0 || end < this.chats.length) {
      lines.push(
        this.row(
          this.theme.fg("dim", `  ${focusIndex + 1}/${this.chats.length}`),
          w,
        ),
      );
    }
    return lines;
  }

  invalidate(): void {}
}

export function installModelFriends(pi: ExtensionAPI): ModelFriendsController {
  let pane: ChatListPane | undefined;
  let loadGeneration = 0;
  let inputUnsubscribe: (() => void) | undefined;

  const ensurePane = (ctx: ExtensionContext): ChatListPane => {
    if (!pane) {
      pane = new ChatListPane(ctx.ui.theme);
      runtimeState.friendsPane = pane;
    }
    return pane;
  };

  const updateStatus = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    const active = pane?.activeChat();
    if (!runtimeState.enabled || !active) {
      ctx.ui.setStatus(CHAT_STATUS_KEY, undefined);
      return;
    }
    ctx.ui.setStatus(
      CHAT_STATUS_KEY,
      ctx.ui.theme.fg("dim", `chat: ${active.title}`),
    );
  };

  const loadSessions = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui") return;
    const target = ensurePane(ctx);
    const generation = ++loadGeneration;
    target.setLoading(true);
    refreshFriendsLayout();
    try {
      const sessions = await SessionManager.list(
        ctx.sessionManager.getCwd(),
        ctx.sessionManager.getSessionDir(),
      );
      if (generation !== loadGeneration || target !== pane) return;
      target.update(toChatSessions(sessions, ctx));
      updateStatus(ctx);
      refreshFriendsLayout();
    } catch (error) {
      if (generation !== loadGeneration || target !== pane) return;
      target.setLoading(false);
      ctx.ui.notify(`Could not load chats: ${errorText(error)}`, "warning");
      refreshFriendsLayout();
    }
  };

  const sync = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    ensurePane(ctx);
    attachFriendsLayout(ctx);
    void loadSessions(ctx);
  };

  const finishSelection = (): void => {
    inputUnsubscribe?.();
    inputUnsubscribe = undefined;
    pane?.endSelection();
    refreshFriendsLayout();
  };

  const switchChat = async (
    ctx: ExtensionCommandContext,
    chat: ChatSession,
  ): Promise<void> => {
    if (chat.active) {
      ctx.ui.notify(`Already in '${chat.title}'.`, "info");
      return;
    }
    if (!chat.path) {
      ctx.ui.notify("This new chat has not been saved yet.", "info");
      return;
    }
    if (!ctx.isIdle()) {
      ctx.ui.notify("Wait for the current reply to finish before switching chats.", "warning");
      return;
    }
    try {
      const result = await ctx.switchSession(chat.path);
      if (result.cancelled) {
        ctx.ui.notify("Chat switch cancelled.", "info");
      }
    } catch (error) {
      ctx.ui.notify(`Chat switch failed: ${errorText(error)}`, "error");
      void loadSessions(ctx);
    }
  };

  const beginSidebarSelection = (ctx: ExtensionCommandContext): void => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/chat is available in Pi's interactive TUI.", "info");
      return;
    }
    if (!runtimeState.enabled || !runtimeState.friendsVisible) {
      ctx.ui.notify("Show PiChat's chat list with /chat show first.", "info");
      return;
    }
    const terminalWidth = runtimeState.layoutTui?.terminal.columns ?? 0;
    if (terminalWidth < FRIENDS_MIN_TERMINAL_WIDTH) {
      ctx.ui.notify(
        `The terminal must be at least ${FRIENDS_MIN_TERMINAL_WIDTH} columns to select from the chat list.`,
        "warning",
      );
      return;
    }
    const target = ensurePane(ctx);
    if (target.isSelecting()) return;
    if (!target.beginSelection()) {
      ctx.ui.notify("No saved chats are available yet.", "info");
      return;
    }

    inputUnsubscribe = ctx.ui.onTerminalInput((data) => {
      if (!target.isSelecting()) return undefined;
      if (matchesKey(data, Key.up)) {
        target.move(-1);
        refreshFriendsLayout();
        return { consume: true };
      }
      if (matchesKey(data, Key.down)) {
        target.move(1);
        refreshFriendsLayout();
        return { consume: true };
      }
      if (matchesKey(data, Key.home)) {
        target.moveTo("first");
        refreshFriendsLayout();
        return { consume: true };
      }
      if (matchesKey(data, Key.end)) {
        target.moveTo("last");
        refreshFriendsLayout();
        return { consume: true };
      }
      if (matchesKey(data, Key.enter)) {
        const selected = target.selectedChat();
        finishSelection();
        if (selected) void switchChat(ctx, selected);
        return { consume: true };
      }
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        finishSelection();
        return { consume: true };
      }
      return { consume: true };
    });
    refreshFriendsLayout();
  };

  const cycle = async (
    ctx: ExtensionCommandContext,
    delta: 1 | -1,
  ): Promise<void> => {
    const target = pane?.cycleTarget(delta);
    if (!target) {
      ctx.ui.notify("No other saved chat is available.", "info");
      return;
    }
    await switchChat(ctx, target);
  };

  pi.registerCommand("chat", {
    description: "Select and resume a saved chat from PiChat's left sidebar",
    getArgumentCompletions: (argumentPrefix) => {
      const prefix = argumentPrefix.trim().toLowerCase();
      const staticItems = [
        { value: "new", label: "new", description: "Start a new chat context" },
        { value: "show", label: "show", description: "Show the left chat list" },
        { value: "hide", label: "hide", description: "Hide the left chat list" },
        { value: "list", label: "list", description: "Toggle the left chat list" },
        { value: "next", label: "next", description: "Resume the next saved chat" },
        { value: "prev", label: "prev", description: "Resume the previous saved chat" },
        { value: "refresh", label: "refresh", description: "Reload saved chats" },
      ];
      return [
        ...staticItems.filter((item) => item.value.startsWith(prefix)),
        ...(pane?.completionItems(prefix) ?? []),
      ];
    },
    handler: async (rawArgs, ctx) => {
      const arg = rawArgs.trim();
      if (!arg) {
        beginSidebarSelection(ctx);
        return;
      }

      const normalized = arg.toLowerCase();
      if (normalized === "list" || normalized === "toggle") {
        if (pane?.isSelecting()) finishSelection();
        runtimeState.friendsVisible = !runtimeState.friendsVisible;
        refreshFriendsLayout();
        ctx.ui.notify(
          `PiChat chat list ${runtimeState.friendsVisible ? "shown" : "hidden"}.`,
          "info",
        );
        return;
      }
      if (normalized === "show") {
        runtimeState.friendsVisible = true;
        refreshFriendsLayout();
        ctx.ui.notify("PiChat chat list shown.", "info");
        return;
      }
      if (normalized === "hide") {
        if (pane?.isSelecting()) finishSelection();
        runtimeState.friendsVisible = false;
        refreshFriendsLayout();
        ctx.ui.notify("PiChat chat list hidden.", "info");
        return;
      }
      if (normalized === "refresh") {
        await loadSessions(ctx);
        ctx.ui.notify("Saved chats refreshed.", "info");
        return;
      }
      if (normalized === "new") {
        if (!ctx.isIdle()) {
          ctx.ui.notify("Wait for the current reply to finish before starting a new chat.", "warning");
          return;
        }
        await ctx.newSession();
        return;
      }
      if (normalized === "next") {
        await cycle(ctx, 1);
        return;
      }
      if (normalized === "prev" || normalized === "previous") {
        await cycle(ctx, -1);
        return;
      }

      const matches = pane?.find(arg) ?? [];
      if (matches.length === 1) {
        await switchChat(ctx, matches[0]!);
        return;
      }
      if (matches.length > 1) {
        ctx.ui.notify(
          `Multiple chats match '${arg}'. Run /chat and select one in the sidebar.`,
          "warning",
        );
        return;
      }
      ctx.ui.notify(`No saved chat matches '${arg}'.`, "warning");
    },
  });

  pi.on("model_select", (_event, ctx) => {
    sync(ctx);
  });

  pi.on("session_info_changed", (_event, ctx) => {
    void loadSessions(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    void loadSessions(ctx);
  });

  return {
    sync,
    hide(ctx) {
      finishSelection();
      if (ctx?.mode === "tui") ctx.ui.setStatus(CHAT_STATUS_KEY, undefined);
      refreshFriendsLayout();
    },
    shutdown(ctx) {
      loadGeneration++;
      finishSelection();
      runtimeState.friendsPane = undefined;
      pane = undefined;
      if (ctx?.mode === "tui") ctx.ui.setStatus(CHAT_STATUS_KEY, undefined);
      refreshFriendsLayout();
    },
  };
}
