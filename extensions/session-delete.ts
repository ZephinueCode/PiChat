import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

interface TrashAttempt {
  status: number | null;
  error?: string;
  stderr?: string;
}

export interface SessionDeleteResult {
  method: "trash" | "unlink";
}

export type TrashRunner = (sessionPath: string) => TrashAttempt;

function canonicalPath(value: string): string {
  const normalized = path.resolve(value).replaceAll("/", path.sep);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function resolveDeletableSessionPath(options: {
  candidatePath: string | undefined;
  currentPath: string | undefined;
  listedPaths: readonly string[];
}): string {
  if (!options.candidatePath) throw new Error("The selected chat has not been saved yet.");
  const candidate = canonicalPath(options.candidatePath);
  if (options.currentPath && candidate === canonicalPath(options.currentPath)) {
    throw new Error("The active chat cannot be deleted.");
  }
  const listed = options.listedPaths.find((value) => canonicalPath(value) === candidate);
  if (!listed) throw new Error("The selected chat is no longer in the saved chat list.");
  if (path.extname(listed).toLowerCase() !== ".jsonl") {
    throw new Error("Only Pi JSONL session files can be deleted.");
  }
  return path.resolve(listed);
}

function runTrash(sessionPath: string): TrashAttempt {
  const args = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
  const result = spawnSync("trash", args, {
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    status: result.status,
    error: result.error?.message,
    stderr: result.stderr?.trim().split("\n")[0],
  };
}

export async function deleteSessionFile(
  sessionPath: string,
  trashRunner: TrashRunner = runTrash,
): Promise<SessionDeleteResult> {
  let attempt: TrashAttempt;
  try {
    attempt = trashRunner(sessionPath);
  } catch (error) {
    attempt = {
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (attempt.status === 0 || !existsSync(sessionPath)) return { method: "trash" };

  try {
    await unlink(sessionPath);
    return { method: "unlink" };
  } catch (error) {
    const unlinkError = error instanceof Error ? error.message : String(error);
    const trashDetails = [attempt.error, attempt.stderr].filter(Boolean).join(" · ");
    throw new Error(trashDetails ? `${unlinkError} (trash: ${trashDetails.slice(0, 200)})` : unlinkError);
  }
}
