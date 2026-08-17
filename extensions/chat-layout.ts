import {
  AssistantMessageComponent,
  UserMessageComponent,
  type MarkdownTransformer,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  HStack,
  Markdown,
  Spacer,
  Text,
  TuiAltScreen,
  TuiMainScreen,
  compositeTuiLine,
  isViewportTUI,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  type Component,
  type MarkdownTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  CHAT_MIN_WIDTH,
  FRIENDS_MIN_TERMINAL_WIDTH,
  FRIENDS_MIN_WIDTH,
  getFriendsLayoutWidths,
  getFriendsViewportRange,
} from "./friends-layout.ts";
import { splitMarkdownSegments } from "./markdown-segments.ts";

export { splitMarkdownSegments } from "./markdown-segments.ts";

type MessageType = "user" | "assistant" | "assistant-thinking";
type BubbleSide = "left" | "right";

interface RuntimeState {
  enabled: boolean;
  theme?: Theme;
  assistantTextHeld: boolean;
  heldAssistantComponents: Set<AssistantComponentInternals>;
  friendsVisible: boolean;
  friendsPane?: Component;
  layoutTui?: TUI;
}

interface AssistantComponentInternals {
  contentContainer: Container;
  hasToolCalls: boolean;
  isStreaming: boolean;
  lastMessage?: AssistantMessageLike;
  markdownTheme: MarkdownTheme;
  markdownTransformers: readonly MarkdownTransformer[];
  outputPad: number;
}

interface UserComponentInternals {
  clear(): void;
  addChild(component: Component): void;
  markdownTheme: MarkdownTheme;
  markdownTransformers: readonly MarkdownTransformer[];
  outputPad: number;
  text: string;
}

interface UserComponentBuildState {
  enabled: boolean;
  theme?: Theme;
}

interface AssistantMessageLike {
  content: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string }
    | { type: "toolCall" }
    | { type: string; [key: string]: unknown }
  >;
  errorMessage?: string;
  stopReason?: string;
}

const GLOBAL_STATE_KEY = "__pichatRuntimeStateV2";
const ORIGINAL_ASSISTANT_UPDATE = Symbol.for("pichat.original.assistant.updateContent");
const ORIGINAL_USER_REBUILD = Symbol.for("pichat.original.user.rebuild");
const ORIGINAL_USER_INVALIDATE = Symbol.for("pichat.original.user.invalidate");
const ORIGINAL_MAIN_RENDER = Symbol.for("pichat.original.tui-main-screen.render");
const ORIGINAL_ALT_SET_LAYOUT_ROOT = Symbol.for("pichat.original.tui-alt-screen.setLayoutRoot");
const FRIENDS_SPLIT_ROOT_PROPERTY = "__pichatFriendsSplitRoot" as const;
const LAYOUT_CAPTURE_WIDGET_KEY = "pichat-friends-layout-capture";

export const PICHAT_TYPING_WIDGET_KEY = "pichat-typing";

const globalStore = globalThis as typeof globalThis & {
  [GLOBAL_STATE_KEY]?: RuntimeState;
};

const userComponentBuildStates = new WeakMap<object, UserComponentBuildState>();

export const runtimeState: RuntimeState = (globalStore[GLOBAL_STATE_KEY] ??= {
  enabled: true,
  assistantTextHeld: false,
  heldAssistantComponents: new Set(),
  friendsVisible: true,
});

// Older in-process runtimes may not have the model-friends fields after /reload.
if (typeof runtimeState.friendsVisible !== "boolean") runtimeState.friendsVisible = true;

type RenderFunction = (this: TUI, width: number) => string[];
type SetLayoutRootFunction = (this: TuiAltScreen, component: Component | undefined) => void;

interface SplitRootComponent extends Component {
  [FRIENDS_SPLIT_ROOT_PROPERTY]: true;
  nativeRoot: Component;
}

class EmptyLayoutCapture implements Component {
  render(): string[] {
    return [];
  }

  invalidate(): void {}
}

function friendsPaneEnabled(width: number): boolean {
  return Boolean(
    runtimeState.enabled &&
      runtimeState.friendsVisible &&
      runtimeState.friendsPane &&
      width >= FRIENDS_MIN_TERMINAL_WIDTH,
  );
}

function paintPaneLine(source: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const contentWidth = Math.max(0, safeWidth - 1);
  const clipped = visibleWidth(source) > contentWidth
    ? sliceByColumn(source, 0, contentWidth, true)
    : source;
  const plainPadding = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
  const theme = runtimeState.theme;
  const padding = theme
    ? theme.bg("customMessageBg", plainPadding)
    : plainPadding;
  const divider = safeWidth > 1
    ? theme?.fg("borderMuted", "│") ?? "│"
    : "";
  return `${clipped}${padding}${divider}`;
}

class FriendsPaneSlot implements Component {
  constructor(private readonly tui: TUI) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const contentWidth = Math.max(1, safeWidth - 1);
    const height = Math.max(1, this.tui.terminal.rows);
    const content = runtimeState.friendsPane?.render(contentWidth) ?? [];
    return Array.from({ length: height }, (_, index) =>
      paintPaneLine(content[index] ?? "", safeWidth),
    );
  }

  invalidate(): void {
    runtimeState.friendsPane?.invalidate();
  }
}

class FriendsSplitRoot extends HStack implements SplitRootComponent {
  readonly [FRIENDS_SPLIT_ROOT_PROPERTY] = true as const;

  constructor(
    tui: TUI,
    readonly nativeRoot: Component,
  ) {
    super(
      [
        {
          component: new FriendsPaneSlot(tui),
          basis: 0,
          grow: 1,
          shrink: 1,
          minSize: FRIENDS_MIN_WIDTH,
          visible: (viewport) => friendsPaneEnabled(viewport.width),
        },
        {
          component: nativeRoot,
          basis: 0,
          grow: 4,
          shrink: 1,
          minSize: CHAT_MIN_WIDTH,
        },
      ],
      { gap: 0, align: "stretch" },
    );
  }
}

function isFriendsSplitRoot(component: Component | undefined): component is SplitRootComponent {
  return Boolean(
    component &&
      (component as Partial<SplitRootComponent>)[FRIENDS_SPLIT_ROOT_PROPERTY] === true,
  );
}

function wrapFullscreenRoot(tui: TuiAltScreen, component: Component): Component {
  if (isFriendsSplitRoot(component)) return component;
  return new FriendsSplitRoot(tui, component);
}

function renderRegularSplit(
  tui: TUI,
  width: number,
  renderNative: RenderFunction,
): string[] {
  const layout = getFriendsLayoutWidths(width, friendsPaneEnabled(width));
  if (!layout.visible) return renderNative.call(tui, width);

  const chatLines = renderNative.call(tui, layout.chat);
  if (chatLines.length === 0) return chatLines;

  const paneLines = new FriendsPaneSlot(tui).render(layout.friends);
  const viewport = getFriendsViewportRange(chatLines.length, tui.terminal.rows);
  const blank = " ".repeat(layout.friends);
  // TuiMainScreen's native Container render returns a fresh document array.
  // Mutate only its visible tail so the cost of adding the sidebar is bounded
  // by terminal height instead of growing with the complete transcript.
  for (let index = viewport.start; index < viewport.end; index += 1) {
    const line = chatLines[index]!;
    const paneIndex = index - viewport.start;
    const paneLine = paneIndex >= 0 && paneIndex < paneLines.length
      ? paneLines[paneIndex]!
      : blank;
    chatLines[index] = compositeTuiLine(
      paneLine,
      line,
      layout.friends,
      layout.chat,
      width,
    );
  }
  return chatLines;
}

function patchRootLayout(): void {
  const mainPrototype = TuiMainScreen.prototype as unknown as Record<
    PropertyKey,
    RenderFunction
  >;
  if (!mainPrototype[ORIGINAL_MAIN_RENDER]) {
    mainPrototype[ORIGINAL_MAIN_RENDER] = mainPrototype.render;
  }
  mainPrototype.render = function (this: TUI, width: number): string[] {
    return renderRegularSplit(
      this,
      width,
      mainPrototype[ORIGINAL_MAIN_RENDER]!,
    );
  };

  const altPrototype = TuiAltScreen.prototype as unknown as Record<
    PropertyKey,
    SetLayoutRootFunction
  >;
  if (!altPrototype[ORIGINAL_ALT_SET_LAYOUT_ROOT]) {
    altPrototype[ORIGINAL_ALT_SET_LAYOUT_ROOT] = altPrototype.setLayoutRoot;
  }
  altPrototype.setLayoutRoot = function (
    this: TuiAltScreen,
    component: Component | undefined,
  ): void {
    const nativeRoot = isFriendsSplitRoot(component) ? component.nativeRoot : component;
    altPrototype[ORIGINAL_ALT_SET_LAYOUT_ROOT]!.call(
      this,
      nativeRoot ? wrapFullscreenRoot(this, nativeRoot) : undefined,
    );
  };
}

function attachCurrentTui(tui: TUI): void {
  runtimeState.layoutTui = tui;
  if (isViewportTUI(tui)) {
    const current = (tui as unknown as { layoutRoot?: Component }).layoutRoot;
    if (current) tui.setLayoutRoot(current);
  }
  tui.requestRender(true);
}

/** Capture Pi's current renderer without leaving a widget or taking keyboard focus. */
export function attachFriendsLayout(ctx: {
  mode: string;
  ui: {
    setWidget(
      key: string,
      content:
        | ((tui: TUI) => Component)
        | undefined,
      options?: { placement?: "aboveEditor" | "belowEditor" },
    ): void;
  };
}): void {
  if (ctx.mode !== "tui") return;
  ctx.ui.setWidget(
    LAYOUT_CAPTURE_WIDGET_KEY,
    (tui) => {
      attachCurrentTui(tui);
      return new EmptyLayoutCapture();
    },
    { placement: "aboveEditor" },
  );
  ctx.ui.setWidget(LAYOUT_CAPTURE_WIDGET_KEY, undefined);
}

export function refreshFriendsLayout(): void {
  try {
    runtimeState.layoutTui?.requestRender(true);
  } catch {
    // The renderer may already have stopped during shutdown or a TUI mode switch.
  }
}

export function releaseAssistantText(): void {
  runtimeState.assistantTextHeld = false;
  const held = [...runtimeState.heldAssistantComponents];
  runtimeState.heldAssistantComponents.clear();
  const update = (AssistantMessageComponent.prototype as unknown as Record<
    PropertyKey,
    (...args: never[]) => unknown
  >).updateContent;
  if (typeof update !== "function") return;
  for (const component of held) {
    if (!component.lastMessage) continue;
    update.call(component, component.lastMessage as never, component.isStreaming as never);
  }
}

export function holdNextAssistantText(): void {
  releaseAssistantText();
  runtimeState.assistantTextHeld = true;
}

function markdownTransform(
  messageType: MessageType,
  isStreaming: boolean,
  transformers: readonly MarkdownTransformer[],
): (markdown: string, availableWidth: number) => string {
  return (markdown, availableWidth) => {
    let transformed = markdown;
    for (const transformer of transformers) {
      try {
        const next = transformer(transformed, {
          messageType,
          isStreaming,
          availableWidth,
        });
        if (typeof next === "string") transformed = next;
      } catch {
        // A display transformer must never break the transcript.
      }
    }
    return transformed;
  };
}

class ChatBubble implements Component {
  private readonly markdown: Markdown;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    source: string,
    private readonly side: BubbleSide,
    markdownTheme: MarkdownTheme,
    transformers: readonly MarkdownTransformer[],
    isStreaming: boolean,
    private readonly theme: Theme,
  ) {
    const messageType: MessageType = side === "right" ? "user" : "assistant";
    const colorToken = side === "right" ? "userMessageText" : "customMessageText";
    this.markdown = new Markdown(
      source,
      0,
      0,
      markdownTheme,
      { color: (text) => theme.fg(colorToken, text) },
      {
        preserveOrderedListMarkers: side === "right",
        preserveBackslashEscapes: side === "right",
        transform: markdownTransform(messageType, isStreaming, transformers),
      },
    );
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

    const margin = width >= 24 ? 2 : 0;
    const tailWidth = width >= 16 ? 1 : 0;
    const available = Math.max(4, width - margin * 2 - tailWidth);
    const maximumBubbleWidth = Math.max(
      4,
      Math.min(available, Math.floor(width * 0.72)),
    );
    const maximumContentWidth = Math.max(2, maximumBubbleWidth - 2);
    const rendered = this.markdown.render(maximumContentWidth);
    if (rendered.length === 0) return [];

    const contentWidth = Math.max(
      1,
      ...rendered.map((line) => Math.min(maximumContentWidth, visibleWidth(line))),
    );
    const bubbleWidth = Math.min(maximumBubbleWidth, contentWidth + 2);
    const bubbleStart =
      this.side === "right"
        ? Math.max(0, width - margin - tailWidth - bubbleWidth)
        : margin + tailWidth;
    const label = this.side === "right" ? "User" : "Pi Agent";
    const background = this.side === "right" ? "userMessageBg" : "customMessageBg";
    const tailColor = this.side === "right" ? "accent" : "borderMuted";
    const tail = tailWidth
      ? this.theme.fg(tailColor, this.side === "right" ? "▶" : "◀")
      : "";

    const output = [
      `${" ".repeat(bubbleStart)}${this.theme.fg("dim", label)}`,
    ];

    rendered.forEach((line, index) => {
      const fitted = truncateToWidth(line, contentWidth, "", true);
      const body = this.theme.bg(background, ` ${fitted} `);
      const firstLineTail = index === 0 ? tail : " ".repeat(tailWidth);
      if (this.side === "right") {
        output.push(`${" ".repeat(bubbleStart)}${body}${firstLineTail}`);
      } else {
        output.push(`${" ".repeat(margin)}${firstLineTail}${body}`);
      }
    });

    this.cachedWidth = width;
    this.cachedLines = output;
    return output;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.markdown.invalidate();
  }
}

function addSeparated(container: Container, child: Component, hasContent: boolean): boolean {
  if (hasContent) container.addChild(new Spacer(1));
  container.addChild(child);
  return true;
}

function addTextSegments(
  container: Container,
  source: string,
  side: BubbleSide,
  markdownTheme: MarkdownTheme,
  transformers: readonly MarkdownTransformer[],
  isStreaming: boolean,
  outputPad: number,
  theme: Theme,
  hasContent: boolean,
): boolean {
  for (const segment of splitMarkdownSegments(source)) {
    if (segment.kind === "chat") {
      hasContent = addSeparated(
        container,
        new ChatBubble(
          segment.text,
          side,
          markdownTheme,
          transformers,
          isStreaming,
          theme,
        ),
        hasContent,
      );
      continue;
    }

    hasContent = addSeparated(
      container,
      new Markdown(
        segment.text,
        outputPad,
        0,
        markdownTheme,
        undefined,
        {
          transform: markdownTransform(
            side === "right" ? "user" : "assistant",
            isStreaming,
            transformers,
          ),
        },
      ),
      hasContent,
    );
  }
  return hasContent;
}

function patchAssistantComponent(): void {
  const prototype = AssistantMessageComponent.prototype as unknown as Record<
    PropertyKey,
    (...args: never[]) => unknown
  >;

  if (typeof prototype.updateContent !== "function") return;
  if (!prototype[ORIGINAL_ASSISTANT_UPDATE]) {
    prototype[ORIGINAL_ASSISTANT_UPDATE] = prototype.updateContent!;
  }

  prototype.updateContent = function (
    this: AssistantComponentInternals,
    message: AssistantMessageLike,
    isStreaming = this.isStreaming,
  ): void {
    const original = prototype[ORIGINAL_ASSISTANT_UPDATE]!;
    const theme = runtimeState.theme;
    const compatible =
      Array.isArray(message?.content) &&
      typeof this.contentContainer?.clear === "function" &&
      Array.isArray(this.markdownTransformers) &&
      Boolean(this.markdownTheme);
    if (!runtimeState.enabled || !theme || !compatible) {
      original.call(this, message, isStreaming);
      return;
    }

    this.lastMessage = message;
    this.isStreaming = isStreaming;
    this.contentContainer.clear();
    if (runtimeState.assistantTextHeld && isStreaming) {
      runtimeState.heldAssistantComponents.add(this);
    }
    const hideText =
      runtimeState.assistantTextHeld &&
      runtimeState.heldAssistantComponents.has(this);
    let hasContent = false;

    for (const content of message.content) {
      if (!hideText && content.type === "text" && content.text.trim()) {
        hasContent = addTextSegments(
          this.contentContainer,
          content.text.trim(),
          "left",
          this.markdownTheme,
          this.markdownTransformers,
          isStreaming,
          this.outputPad,
          theme,
          hasContent,
        );
      }
      // Thinking blocks are intentionally omitted from the transcript.
      // The extension's working row represents them as “Pi Agent is typing…”.
    }

    const hasToolCalls = message.content.some((content) => content.type === "toolCall");
    this.hasToolCalls = hasToolCalls;

    let errorText: string | undefined;
    if (message.stopReason === "length") {
      errorText = "The response was truncated before completion.";
    } else if (!hasToolCalls && message.stopReason === "aborted") {
      errorText =
        message.errorMessage && message.errorMessage !== "Request was aborted"
          ? message.errorMessage
          : "Generation interrupted";
    } else if (!hasToolCalls && message.stopReason === "error") {
      errorText = `Generation failed: ${message.errorMessage || "Unknown error"}`;
    }

    if (errorText) {
      if (hasContent) this.contentContainer.addChild(new Spacer(1));
      this.contentContainer.addChild(
        new Text(theme.fg("error", errorText), this.outputPad, 0),
      );
    }
  } as never;
}

function patchUserComponent(): void {
  const prototype = UserMessageComponent.prototype as unknown as Record<
    PropertyKey,
    (...args: never[]) => unknown
  >;

  if (
    typeof prototype.rebuild !== "function" ||
    typeof prototype.invalidate !== "function"
  ) {
    return;
  }
  if (!prototype[ORIGINAL_USER_REBUILD]) {
    prototype[ORIGINAL_USER_REBUILD] = prototype.rebuild!;
  }
  if (!prototype[ORIGINAL_USER_INVALIDATE]) {
    prototype[ORIGINAL_USER_INVALIDATE] = prototype.invalidate!;
  }

  prototype.rebuild = function (this: UserComponentInternals): void {
    const original = prototype[ORIGINAL_USER_REBUILD]!;
    const theme = runtimeState.theme;
    const compatible =
      typeof this.clear === "function" &&
      typeof this.addChild === "function" &&
      typeof this.text === "string" &&
      Array.isArray(this.markdownTransformers) &&
      Boolean(this.markdownTheme);
    if (!runtimeState.enabled || !theme || !compatible) {
      original.call(this);
      userComponentBuildStates.set(this, { enabled: false });
      return;
    }

    this.clear();
    addTextSegments(
      this as unknown as Container,
      this.text,
      "right",
      this.markdownTheme,
      this.markdownTransformers,
      false,
      this.outputPad,
      theme,
      false,
    );
    userComponentBuildStates.set(this, { enabled: true, theme });
  } as never;

  prototype.invalidate = function (this: UserComponentInternals): void {
    const theme = runtimeState.theme;
    const enabled = Boolean(runtimeState.enabled && theme);
    const previous = userComponentBuildStates.get(this);
    if (
      !previous ||
      previous.enabled !== enabled ||
      (enabled && previous.theme !== theme)
    ) {
      (prototype.rebuild as (...args: never[]) => unknown).call(this);
      return;
    }
    prototype[ORIGINAL_USER_INVALIDATE]!.call(this);
  } as never;
}

export function installChatLayoutPatch(): void {
  patchRootLayout();
  patchAssistantComponent();
  patchUserComponent();
}
