import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { HandoffPacket } from "./handoff-protocol.ts";

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function safeSegment(value: string, label: string): string {
  if (!SAFE_SEGMENT.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function isPacket(value: unknown): value is HandoffPacket {
  if (!value || typeof value !== "object") return false;
  const packet = value as Partial<HandoffPacket>;
  return Boolean(
    packet.version === 1 &&
      typeof packet.packetId === "string" &&
      typeof packet.createdAt === "string" &&
      typeof packet.contentHash === "string" &&
      packet.source && typeof packet.source.sessionId === "string" &&
      packet.target && typeof packet.target.sessionId === "string" &&
      Array.isArray(packet.items),
  );
}

export function defaultHandoffRoot(): string {
  const override = process.env.PICHAT_HANDOFF_DIR?.trim();
  if (override) return path.resolve(override);
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(homedir(), ".pi", "agent");
  return path.join(agentDir, "pichat", "handoffs");
}

export class HandoffStore {
  readonly root: string;

  constructor(root = defaultHandoffRoot()) {
    this.root = root;
  }

  private sessionDir(state: "inbox" | "archive", sessionId: string): string {
    return path.join(this.root, state, safeSegment(sessionId, "session ID"));
  }

  private packetPath(
    state: "inbox" | "archive",
    sessionId: string,
    packetId: string,
  ): string {
    return path.join(
      this.sessionDir(state, sessionId),
      `${safeSegment(packetId, "packet ID")}.json`,
    );
  }

  private readPacketFile(filePath: string): HandoffPacket | undefined {
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      return isPacket(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private listFiles(state: "inbox" | "archive", sessionId: string): string[] {
    const directory = this.sessionDir(state, sessionId);
    if (!existsSync(directory)) return [];
    try {
      return readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => path.join(directory, name));
    } catch {
      return [];
    }
  }

  queue(packet: HandoffPacket): void {
    safeSegment(packet.packetId, "packet ID");
    safeSegment(packet.target.sessionId, "session ID");
    const directory = this.sessionDir("inbox", packet.target.sessionId);
    mkdirSync(directory, { recursive: true });
    const destination = this.packetPath("inbox", packet.target.sessionId, packet.packetId);
    if (existsSync(destination)) throw new Error(`Handoff packet ${packet.packetId} already exists.`);
    const temporary = path.join(directory, `.${packet.packetId}.${process.pid}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(packet, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      renameSync(temporary, destination);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  listUnread(sessionId: string): HandoffPacket[] {
    return this.listFiles("inbox", sessionId)
      .map((filePath) => this.readPacketFile(filePath))
      .filter((packet): packet is HandoffPacket =>
        Boolean(packet && packet.target.sessionId === sessionId),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  unreadCount(sessionId: string): number {
    return this.listUnread(sessionId).length;
  }

  findDuplicateUnread(sessionId: string, contentHash: string): HandoffPacket | undefined {
    return this.listUnread(sessionId).find((packet) => packet.contentHash === contentHash);
  }

  getForSession(sessionId: string, packetId: string): HandoffPacket | undefined {
    for (const state of ["inbox", "archive"] as const) {
      const packet = this.readPacketFile(this.packetPath(state, sessionId, packetId));
      if (packet?.target.sessionId === sessionId) return packet;
    }
    return undefined;
  }

  markDelivered(sessionId: string, packetId: string): void {
    const source = this.packetPath("inbox", sessionId, packetId);
    if (!existsSync(source)) return;
    const archiveDir = this.sessionDir("archive", sessionId);
    mkdirSync(archiveDir, { recursive: true });
    const destination = this.packetPath("archive", sessionId, packetId);
    if (existsSync(destination)) {
      rmSync(source, { force: true });
      return;
    }
    renameSync(source, destination);
  }

  discardSession(sessionId: string): void {
    safeSegment(sessionId, "session ID");
    for (const state of ["inbox", "archive"] as const) {
      rmSync(this.sessionDir(state, sessionId), { recursive: true, force: true });
    }
  }
}
