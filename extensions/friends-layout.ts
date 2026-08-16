export const FRIENDS_MIN_WIDTH = 18;
export const CHAT_MIN_WIDTH = 72;
export const FRIENDS_WIDTH_PARTS = 1;
export const CHAT_WIDTH_PARTS = 4;
export const FRIENDS_MIN_TERMINAL_WIDTH = FRIENDS_MIN_WIDTH + CHAT_MIN_WIDTH;

export interface FriendsLayoutWidths {
  visible: boolean;
  friends: number;
  chat: number;
}

/**
 * Resolve the regular-TUI split without changing the document's height.
 * The fullscreen TUI uses the same 1:4 ratio through its native layout engine.
 */
export function getFriendsLayoutWidths(
  terminalWidth: number,
  enabled = true,
): FriendsLayoutWidths {
  const width = Math.max(1, Math.floor(terminalWidth));
  if (!enabled || width < FRIENDS_MIN_TERMINAL_WIDTH) {
    return { visible: false, friends: 0, chat: width };
  }

  const idealFriends = Math.floor(
    (width * FRIENDS_WIDTH_PARTS) / (FRIENDS_WIDTH_PARTS + CHAT_WIDTH_PARTS),
  );
  const friends = Math.max(FRIENDS_MIN_WIDTH, idealFriends);
  const chat = width - friends;
  if (chat < CHAT_MIN_WIDTH) {
    return { visible: false, friends: 0, chat: width };
  }
  return { visible: true, friends, chat };
}

/**
 * In regular (scrollback) mode, keep the roster in the currently visible tail
 * without adding rows or moving Pi's editor vertically.
 */
export function getFriendsViewportStart(
  documentLineCount: number,
  terminalHeight: number,
): number {
  const lines = Math.max(0, Math.floor(documentLineCount));
  const height = Math.max(1, Math.floor(terminalHeight));
  return Math.max(0, lines - height);
}
