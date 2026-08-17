import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deleteSessionFile,
  resolveDeletableSessionPath,
} from "../extensions/session-delete.ts";

test("session deletion accepts only a listed inactive JSONL session", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pichat-session-delete-"));
  try {
    const current = path.join(root, "current.jsonl");
    const target = path.join(root, "target.jsonl");
    const textFile = path.join(root, "notes.txt");
    assert.equal(
      resolveDeletableSessionPath({
        candidatePath: target,
        currentPath: current,
        listedPaths: [current, target],
      }),
      path.resolve(target),
    );
    assert.throws(
      () => resolveDeletableSessionPath({ candidatePath: current, currentPath: current, listedPaths: [current] }),
      /active chat cannot be deleted/,
    );
    assert.throws(
      () => resolveDeletableSessionPath({ candidatePath: target, currentPath: current, listedPaths: [current] }),
      /no longer in the saved chat list/,
    );
    assert.throws(
      () => resolveDeletableSessionPath({ candidatePath: textFile, currentPath: current, listedPaths: [textFile] }),
      /Only Pi JSONL session files/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session deletion falls back to unlink when trash is unavailable", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pichat-session-delete-"));
  try {
    const target = path.join(root, "target.jsonl");
    writeFileSync(target, "{}\n", "utf8");
    const result = await deleteSessionFile(target, () => ({
      status: null,
      error: "trash command unavailable",
    }));
    assert.equal(result.method, "unlink");
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
