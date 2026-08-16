import {
  AssistantMessageComponent,
  UserMessageComponent,
  type MarkdownTransformer,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import { splitMarkdownSegments } from "./markdown-segments.ts";

export { splitMarkdownSegments } from "./markdown-segments.ts";

type MessageType = "user" | "assistant" | "assistant-thinking";
type BubbleSide = "left" | "right";

interface RuntimeState {
  enabled: boolean;
  theme?: Theme;
  assistantTextHeld: boolean;
  heldAssistantComponents: Set<AssistantComponentInternals>;
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

export const PICHAT_TYPING_WIDGET_KEY = "pichat-typing";

const globalStore = globalThis as typeof globalThis & {
  [GLOBAL_STATE_KEY]?: RuntimeState;
};

export const runtimeState: RuntimeState = (globalStore[GLOBAL_STATE_KEY] ??= {
  enabled: true,
  assistantTextHeld: false,
  heldAssistantComponents: new Set(),
});

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

    return output;
  }

  invalidate(): void {
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
  } as never;

  prototype.invalidate = function (this: UserComponentInternals): void {
    if (runtimeState.enabled && runtimeState.theme) {
      (prototype.rebuild as (...args: never[]) => unknown).call(this);
      return;
    }
    prototype[ORIGINAL_USER_INVALIDATE]!.call(this);
  } as never;
}

export function installChatLayoutPatch(): void {
  patchAssistantComponent();
  patchUserComponent();
}
