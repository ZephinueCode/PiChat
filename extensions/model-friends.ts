import { statSync } from "node:fs";
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
import type {
  AgentShareController,
  HandoffTarget,
} from "./agent-share.ts";
import {
  deleteSessionFile,
  resolveDeletableSessionPath,
} from "./session-delete.ts";

const CHAT_STATUS_KEY = "pichat-chat";
const MAX_FALLBACK_VISIBLE_CHATS = 12;

interface ChatSession {
  id: string;
  path?: string;
  title: string;
  modelLabel: string;
  modified: Date;
  messageCount: number;
  unreadCount: number;
  active: boolean;
}

interface StoredModelCacheEntry {
  mtimeMs: number;
  size: number;
  label: string;
}

const storedModelCache = new Map<string, StoredModelCacheEntry>();

type SidebarSelectionMode =
  | { kind: "chat" }
  | { kind: "repost"; messageCount: number }
  | { kind: "delete" }
  | { kind: "delete-confirm"; chatId: string; chatTitle: string };

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
    const key = canonicalPath(info.path) ?? info.path;
    const stats = statSync(info.path);
    const cached = storedModelCache.get(key);
    if (cached?.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.label;
    }
    const model = SessionManager.open(info.path).buildSessionContext().model;
    const label = model ? `${model.provider}/${model.modelId}` : "Default model";
    storedModelCache.set(key, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      label,
    });
    return label;
  } catch {
    return "Model unavailable";
  }
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string"
        ? candidate.text
        : "";
    })
    .join("");
}

function currentChatSession(
  ctx: ExtensionContext,
  unreadCount: (sessionId: string) => number,
  previous?: ChatSession,
  bumpActivity = false,
): ChatSession {
  let messageCount = 0;
  let firstUserMessage = "";
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message") continue;
    messageCount += 1;
    if (firstUserMessage) continue;
    const message = entry.message as { role?: unknown; content?: unknown };
    if (message.role === "user") firstUserMessage = messageText(message.content);
  }

  const id = ctx.sessionManager.getSessionId();
  const fallbackTitle = oneLine(firstUserMessage, previous?.title ?? "New chat");
  return {
    id,
    path: ctx.sessionManager.getSessionFile(),
    title: oneLine(ctx.sessionManager.getSessionName(), fallbackTitle),
    modelLabel: currentModelLabel(ctx),
    modified: bumpActivity ? new Date() : (previous?.modified ?? new Date()),
    messageCount,
    unreadCount: unreadCount(id),
    active: true,
  };
}

function sessionTitle(info: SessionInfo): string {
  return oneLine(info.name, oneLine(info.firstMessage, "New chat"));
}

function toChatSessions(
  infos: readonly SessionInfo[],
  ctx: ExtensionContext,
  unreadCount: (sessionId: string) => number,
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
        unreadCount: unreadCount(info.id),
        active,
      };
    })
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());

  if (!chats.some((chat) => chat.active)) {
    chats.unshift(currentChatSession(ctx, unreadCount));
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
  private selectionMode: SidebarSelectionMode | undefined;
  private loading = true;
  private cachedWidth?: number;
  private cachedTerminalRows?: number;
  private cachedLines?: string[];

  constructor(private readonly theme: Theme) {}

  private clearRenderCache(): void {
    this.cachedWidth = undefined;
    this.cachedTerminalRows = undefined;
    this.cachedLines = undefined;
  }

  update(chats: readonly ChatSession[]): void {
    const selectedId = this.chats[this.selectedIndex]?.id;
    this.chats = [...chats];
    const selected = selectedId
      ? this.chats.findIndex((chat) => chat.id === selectedId)
      : -1;
    const active = this.chats.findIndex((chat) => chat.active);
    this.selectedIndex = selected >= 0 ? selected : Math.max(0, active);
    this.loading = false;
    this.clearRenderCache();
  }

  updateActive(
    chat: ChatSession,
    unreadCount: (sessionId: string) => number,
  ): void {
    const next = this.chats
      .filter((candidate) => candidate.id !== chat.id)
      .map((candidate) => ({
        ...candidate,
        active: false,
        unreadCount: unreadCount(candidate.id),
      }));
    next.push(chat);
    next.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    this.update(next);
  }

  setLoading(loading: boolean): void {
    if (this.loading === loading) return;
    this.loading = loading;
    this.clearRenderCache();
  }

  isSelecting(): boolean {
    return Boolean(this.selectionMode);
  }

  beginSelection(mode: SidebarSelectionMode): boolean {
    if (this.chats.length === 0) return false;
    this.selectionMode = mode;
    const active = this.chats.findIndex((chat) => chat.active);
    if (mode.kind === "repost" || mode.kind === "delete") {
      const firstTarget = this.chats.findIndex((chat) => !chat.active && Boolean(chat.path));
      if (firstTarget < 0) {
        this.selectionMode = undefined;
        this.clearRenderCache();
        return false;
      }
      this.selectedIndex = firstTarget;
    } else {
      this.selectedIndex = active >= 0 ? active : 0;
    }
    this.clearRenderCache();
    return true;
  }

  endSelection(): void {
    this.selectionMode = undefined;
    const active = this.chats.findIndex((chat) => chat.active);
    if (active >= 0) this.selectedIndex = active;
    this.clearRenderCache();
  }

  currentSelectionMode(): SidebarSelectionMode | undefined {
    return this.selectionMode;
  }

  confirmDelete(chat: ChatSession): void {
    this.selectionMode = {
      kind: "delete-confirm",
      chatId: chat.id,
      chatTitle: chat.title,
    };
    this.clearRenderCache();
  }

  move(delta: 1 | -1, targetsOnly = false): void {
    if (this.chats.length === 0) return;
    for (let step = 1; step <= this.chats.length; step += 1) {
      const candidate =
        (this.selectedIndex + delta * step + this.chats.length * step) % this.chats.length;
      const chat = this.chats[candidate]!;
      if (!targetsOnly || (!chat.active && Boolean(chat.path))) {
        this.selectedIndex = candidate;
        this.clearRenderCache();
        return;
      }
    }
  }

  moveTo(edge: "first" | "last", targetsOnly = false): void {
    if (this.chats.length === 0) return;
    const indexes = edge === "first"
      ? this.chats.map((_chat, index) => index)
      : this.chats.map((_chat, index) => index).reverse();
    const candidate = indexes.find((index) => {
      const chat = this.chats[index]!;
      return !targetsOnly || (!chat.active && Boolean(chat.path));
    });
    if (candidate !== undefined) {
      this.selectedIndex = candidate;
      this.clearRenderCache();
    }
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
    const unread = chat.unreadCount > 0 ? "(!)" : "";
    const prefix = "  ";
    const suffixWidth = visibleWidth(time) + (unread ? visibleWidth(unread) + 1 : 0);
    const titleWidth = Math.max(3, width - visibleWidth(prefix) - suffixWidth - 1);
    const title = truncatePlainText(chat.title, titleWidth);
    const gap = " ".repeat(
      Math.max(1, width - visibleWidth(prefix) - visibleWidth(title) - suffixWidth),
    );
    const styledTitle = this.theme.fg(
      chat.active ? "accent" : "text",
      title,
    );
    return this.row(
      `${prefix}${styledTitle}${gap}${unread ? `${this.theme.fg("warning", unread)} ` : ""}${this.theme.fg("dim", time)}`,
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
    const terminalRows = runtimeState.layoutTui?.terminal.rows ?? 30;
    if (
      this.cachedWidth === width &&
      this.cachedTerminalRows === terminalRows &&
      this.cachedLines
    ) {
      return this.cachedLines;
    }
    const w = Math.max(12, width);
    const count = this.loading ? "…" : `${this.chats.length}`;
    const title = this.selectionMode?.kind === "repost"
      ? ` Repost ${this.selectionMode.messageCount}`
      : this.selectionMode?.kind === "delete"
        ? " Delete chat"
        : this.selectionMode?.kind === "delete-confirm"
          ? " Delete chat? Y/n"
          : " Chats";
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
            this.selectionMode?.kind === "repost"
              ? " ↑/↓ target · Enter send"
              : this.selectionMode?.kind === "delete"
                ? " ↑/↓ select · Enter delete"
                : this.selectionMode?.kind === "delete-confirm"
                  ? ` ${truncatePlainText(this.selectionMode.chatTitle, Math.max(3, w - 2))}`
                  : this.selectionMode
                    ? " ↑/↓ select · Enter open"
                    : " /chat to select",
            w,
          ),
        ),
        w,
      ),
      this.row("", w),
    ];

    if (!this.loading && this.chats.length === 0) {
      lines.push(this.row(this.theme.fg("muted", "  No saved chats"), w));
      this.cachedWidth = width;
      this.cachedTerminalRows = terminalRows;
      this.cachedLines = lines;
      return lines;
    }

    const maxVisible = Math.max(
      3,
      Math.min(
        MAX_FALLBACK_VISIBLE_CHATS,
        Math.floor(Math.max(6, terminalRows - 5) / 2),
      ),
    );
    const focusIndex = this.selectionMode
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
      const selected = this.selectionMode
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
    this.cachedWidth = width;
    this.cachedTerminalRows = terminalRows;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.clearRenderCache();
  }
}

export function installModelFriends(
  pi: ExtensionAPI,
  handoff: AgentShareController,
): ModelFriendsController {
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
      target.update(toChatSessions(sessions, ctx, (sessionId) => handoff.unreadCount(sessionId)));
      updateStatus(ctx);
      refreshFriendsLayout();
    } catch (error) {
      if (generation !== loadGeneration || target !== pane) return;
      target.setLoading(false);
      ctx.ui.notify(`Could not load chats: ${errorText(error)}`, "warning");
      refreshFriendsLayout();
    }
  };

  const refreshActiveSession = (
    ctx: ExtensionContext,
    bumpActivity = false,
  ): void => {
    if (ctx.mode !== "tui") return;
    const target = ensurePane(ctx);
    const unreadCount = (sessionId: string): number => handoff.unreadCount(sessionId);
    target.updateActive(
      currentChatSession(ctx, unreadCount, target.activeChat(), bumpActivity),
      unreadCount,
    );
    updateStatus(ctx);
    refreshFriendsLayout();
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

  const sendRepost = async (
    ctx: ExtensionCommandContext,
    chat: ChatSession,
    messageCount: number,
  ): Promise<void> => {
    if (chat.active) {
      ctx.ui.notify("Choose another chat as the repost target.", "warning");
      return;
    }
    if (!chat.path) {
      ctx.ui.notify("The target chat has not been saved yet.", "warning");
      return;
    }
    try {
      const result = await handoff.repost(
        ctx,
        {
          id: chat.id,
          title: chat.title,
          cwd: ctx.sessionManager.getCwd(),
          path: chat.path,
        } satisfies HandoffTarget,
        messageCount,
      );
      ctx.ui.notify(
        `Reposted ${result.packet.stats.conversationMessages} message${result.packet.stats.conversationMessages === 1 ? "" : "s"} to '${chat.title}' (${result.packet.stats.toolCalls} tool call${result.packet.stats.toolCalls === 1 ? "" : "s"}, ${result.packet.stats.toolResults} result${result.packet.stats.toolResults === 1 ? "" : "s"}, ~${result.estimatedTokens} context tokens).`,
        "info",
      );
      await loadSessions(ctx);
    } catch (error) {
      ctx.ui.notify(`Repost failed: ${errorText(error)}`, "error");
    }
  };

  const deleteChat = async (
    ctx: ExtensionCommandContext,
    chat: ChatSession,
  ): Promise<void> => {
    try {
      const sessions = await SessionManager.list(
        ctx.sessionManager.getCwd(),
        ctx.sessionManager.getSessionDir(),
      );
      const listed = sessions.find((info) => info.id === chat.id && samePath(info.path, chat.path));
      const sessionPath = resolveDeletableSessionPath({
        candidatePath: listed?.path,
        currentPath: ctx.sessionManager.getSessionFile(),
        listedPaths: sessions.map((info) => info.path),
      });
      const result = await deleteSessionFile(sessionPath);
      let mailboxCleanupError: string | undefined;
      try {
        handoff.discardSession(chat.id);
      } catch (error) {
        mailboxCleanupError = errorText(error);
      }
      ctx.ui.notify(
        result.method === "trash"
          ? `Moved '${chat.title}' to trash.`
          : `Deleted '${chat.title}'.`,
        "info",
      );
      if (mailboxCleanupError) {
        ctx.ui.notify(`The chat was deleted, but its PiChat mailbox could not be cleared: ${mailboxCleanupError}`, "warning");
      }
      await loadSessions(ctx);
    } catch (error) {
      ctx.ui.notify(`Delete failed: ${errorText(error)}`, "error");
      await loadSessions(ctx);
    }
  };

  const beginSidebarSelection = (
    ctx: ExtensionCommandContext,
    mode: SidebarSelectionMode,
  ): void => {
    if (ctx.mode !== "tui") {
      const command = mode.kind === "chat" ? "chat" : mode.kind === "delete" ? "delete" : "repost";
      ctx.ui.notify(`/${command} is available in Pi's interactive TUI.`, "info");
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
    if (!target.beginSelection(mode)) {
      const emptyMessage = mode.kind === "repost"
        ? "No other saved chat is available as a repost target."
        : mode.kind === "delete"
          ? "No other saved chat is available to delete."
          : "No saved chats are available yet.";
      ctx.ui.notify(
        emptyMessage,
        "info",
      );
      return;
    }

    inputUnsubscribe = ctx.ui.onTerminalInput((data) => {
      if (!target.isSelecting()) return undefined;
      const mode = target.currentSelectionMode();
      if (mode?.kind === "delete-confirm") {
        if (
          matchesKey(data, "y") ||
          matchesKey(data, Key.shift("y")) ||
          matchesKey(data, Key.enter)
        ) {
          const selected = target.selectedChat();
          finishSelection();
          if (selected && selected.id === mode.chatId) void deleteChat(ctx, selected);
          return { consume: true };
        }
        if (
          matchesKey(data, "n") ||
          matchesKey(data, Key.shift("n")) ||
          matchesKey(data, Key.escape) ||
          matchesKey(data, Key.ctrl("c"))
        ) {
          finishSelection();
          return { consume: true };
        }
        return { consume: true };
      }
      const targetsOnly = mode?.kind === "repost" || mode?.kind === "delete";
      if (matchesKey(data, Key.up)) {
        target.move(-1, targetsOnly);
        refreshFriendsLayout();
        return { consume: true };
      }
      if (matchesKey(data, Key.down)) {
        target.move(1, targetsOnly);
        refreshFriendsLayout();
        return { consume: true };
      }
      if (matchesKey(data, Key.home)) {
        target.moveTo("first", targetsOnly);
        refreshFriendsLayout();
        return { consume: true };
      }
      if (matchesKey(data, Key.end)) {
        target.moveTo("last", targetsOnly);
        refreshFriendsLayout();
        return { consume: true };
      }
      if (matchesKey(data, Key.enter)) {
        const selected = target.selectedChat();
        const selectedMode = target.currentSelectionMode();
        if (selected && selectedMode?.kind === "delete") {
          target.confirmDelete(selected);
          refreshFriendsLayout();
          return { consume: true };
        }
        finishSelection();
        if (selected && selectedMode?.kind === "repost") {
          void sendRepost(ctx, selected, selectedMode.messageCount);
        } else if (selected) {
          void switchChat(ctx, selected);
        }
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
        beginSidebarSelection(ctx, { kind: "chat" });
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

  pi.registerCommand("repost", {
    description: "Repost recent chat messages and associated tool results to another saved PiChat session",
    handler: async (rawArgs, ctx) => {
      const value = rawArgs.trim();
      if (!/^\d+$/.test(value)) {
        ctx.ui.notify(`Usage: /repost N (N must be an integer from 1 to 50).`, "warning");
        return;
      }
      const messageCount = Number(value);
      if (!Number.isSafeInteger(messageCount) || messageCount < 1 || messageCount > 50) {
        ctx.ui.notify("Repost count must be an integer from 1 to 50.", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the current reply to finish before reposting its context.", "warning");
        return;
      }
      beginSidebarSelection(ctx, { kind: "repost", messageCount });
    },
  });

  pi.registerCommand("delete", {
    description: "Delete a saved chat selected from PiChat's left sidebar",
    handler: async (_rawArgs, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the current reply to finish before deleting a chat.", "warning");
        return;
      }
      beginSidebarSelection(ctx, { kind: "delete" });
    },
  });

  pi.on("model_select", (_event, ctx) => {
    refreshActiveSession(ctx);
  });

  pi.on("session_info_changed", (_event, ctx) => {
    refreshActiveSession(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    refreshActiveSession(ctx, true);
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
