import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { HANDOFF_PROTOCOL_VERSION, type HandoffPacket } from "../extensions/handoff-protocol.ts";
import { HandoffStore } from "../extensions/handoff-store.ts";

function packet(id: string): HandoffPacket {
  return {
    version: HANDOFF_PROTOCOL_VERSION,
    packetId: id,
    kind: "agent-share",
    createdAt: "2026-08-17T00:00:00.000Z",
    source: { sessionId: "source", sessionName: "Source", model: "test/model", cwd: "C:/repo" },
    target: { sessionId: "target", sessionName: "Target", cwd: "C:/repo" },
    purpose: "Review this",
    items: [{ id: "note", kind: "agent-note", label: "Agent handoff note", text: "Important finding" }],
    stats: { conversationMessages: 0, toolCalls: 0, toolResults: 0, rawCharacters: 17, projectionCharacters: 100, omittedItems: 0 },
    contentHash: "same-content",
    lineage: [],
    hopCount: 0,
  };
}

test("handoff store queues, counts, archives, and reads packets", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pichat-handoff-"));
  try {
    const store = new HandoffStore(root);
    const value = packet("shr_one");
    store.queue(value);
    assert.equal(store.unreadCount("target"), 1);
    assert.equal(store.listUnread("target")[0]?.packetId, "shr_one");
    assert.equal(store.findDuplicateUnread("target", "same-content")?.packetId, "shr_one");
    assert.equal(store.getForSession("target", "shr_one")?.items[0]?.text, "Important finding");

    store.markDelivered("target", "shr_one");
    assert.equal(store.unreadCount("target"), 0);
    assert.equal(store.getForSession("target", "shr_one")?.packetId, "shr_one");
    store.markDelivered("target", "shr_one");
    store.discardSession("target");
    assert.equal(store.getForSession("target", "shr_one"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff store rejects unsafe path segments and duplicate packet IDs", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pichat-handoff-"));
  try {
    const store = new HandoffStore(root);
    const value = packet("shr_two");
    store.queue(value);
    assert.throws(() => store.queue(value), /already exists/);
    assert.throws(() => store.unreadCount("../escape"), /Invalid session ID/);
    assert.throws(() => store.discardSession("../escape"), /Invalid session ID/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
