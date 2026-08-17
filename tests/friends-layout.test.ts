import assert from "node:assert/strict";
import test from "node:test";
import {
  FRIENDS_MIN_TERMINAL_WIDTH,
  FRIENDS_SCROLLBACK_OVERSCAN,
  getFriendsLayoutWidths,
  getFriendsViewportRange,
  getFriendsViewportStart,
} from "../extensions/friends-layout.ts";

test("friends layout uses a stable one-fifth / four-fifths split", () => {
  assert.deepEqual(getFriendsLayoutWidths(120), {
    visible: true,
    friends: 24,
    chat: 96,
  });
  assert.deepEqual(getFriendsLayoutWidths(200), {
    visible: true,
    friends: 40,
    chat: 160,
  });
});

test("friends layout falls back to Pi's full-width renderer on narrow terminals", () => {
  const width = FRIENDS_MIN_TERMINAL_WIDTH - 1;
  assert.deepEqual(getFriendsLayoutWidths(width), {
    visible: false,
    friends: 0,
    chat: width,
  });
  assert.deepEqual(getFriendsLayoutWidths(160, false), {
    visible: false,
    friends: 0,
    chat: 160,
  });
});

test("regular TUI roster occupies the visible tail without adding document rows", () => {
  assert.equal(getFriendsViewportStart(8, 30), 0);
  assert.equal(getFriendsViewportStart(120, 30), 90);
  assert.equal(getFriendsViewportStart(120, 0), 119);
  assert.deepEqual(getFriendsViewportRange(5_000, 40, FRIENDS_SCROLLBACK_OVERSCAN), {
    start: 4_800,
    end: 5_000,
  });
  assert.deepEqual(getFriendsViewportRange(120, 30, FRIENDS_SCROLLBACK_OVERSCAN), {
    start: 0,
    end: 120,
  });
});
