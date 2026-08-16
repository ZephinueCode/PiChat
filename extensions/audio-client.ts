import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ServiceStatus {
  ready: boolean;
  ttsLoaded: boolean;
  asrLoaded: boolean;
  playbackActive: boolean;
  recording?: { id: string; state: string };
}

export interface SpeechResult {
  requestId: string;
  durationMs: number;
  played: boolean;
  profile: string;
  outputPath: string;
}

export interface TranscriptionResult {
  text: string;
  language: string;
  durationMs: number;
  source: string;
}

export interface RecordingStatus {
  id: string;
  state: "recording" | "finished" | "stopped" | "error";
  reason?: string;
  path?: string;
  durationMs?: number;
  error?: string;
}

interface ClientConfig {
  service?: { host?: string; port?: number };
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const audioRoot = path.join(packageRoot, "audio");

function localConfigPath(): string {
  const fromEnvironment = process.env.PICHAT_AUDIO_CONFIG?.trim();
  if (fromEnvironment) return path.resolve(fromEnvironment);
  const local = path.join(audioRoot, "config.local.json");
  return existsSync(local) ? local : path.join(audioRoot, "config.example.json");
}

function readClientConfig(configPath: string): ClientConfig {
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as ClientConfig;
  } catch {
    return {};
  }
}

function pythonExecutable(): string {
  const configured = process.env.PICHAT_AUDIO_PYTHON?.trim();
  if (configured) return configured;
  const candidates = process.platform === "win32"
    ? [path.join(audioRoot, ".venv", "Scripts", "python.exe")]
    : [path.join(audioRoot, ".venv", "bin", "python")];
  return candidates.find(existsSync) ?? (process.platform === "win32" ? "python" : "python3");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AudioServiceClient {
  private child?: ChildProcess;
  private startPromise?: Promise<void>;
  private readonly configPath = localConfigPath();
  private readonly token = randomUUID();
  private readonly host: string;
  private readonly port: number;
  private outputTail = "";

  constructor() {
    const config = readClientConfig(this.configPath);
    this.host = config.service?.host ?? "127.0.0.1";
    this.port = config.service?.port ?? 17863;
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  async ensureStarted(): Promise<void> {
    if (await this.isHealthy()) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.startProcess();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async startProcess(): Promise<void> {
    const script = path.join(audioRoot, "service", "server.py");
    if (!existsSync(script)) throw new Error(`PiChat audio service is missing: ${script}`);

    const child = spawn(
      pythonExecutable(),
      [script, "--config", this.configPath, "--host", this.host, "--port", String(this.port)],
      {
        cwd: audioRoot,
        env: {
          ...process.env,
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
          PICHAT_AUDIO_TOKEN: this.token,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.child = child;
    this.outputTail = "";
    const remember = (chunk: unknown) => {
      this.outputTail = `${this.outputTail}${String(chunk)}`.slice(-6000);
    };
    child.stdout?.on("data", remember);
    child.stderr?.on("data", remember);
    child.once("exit", () => {
      if (this.child === child) this.child = undefined;
    });

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await this.isHealthy()) return;
      if (child.exitCode !== null) {
        throw new Error(`PiChat audio service exited (${child.exitCode}). ${this.outputTail.trim()}`);
      }
      await sleep(200);
    }
    child.kill();
    throw new Error(`PiChat audio service did not become ready. ${this.outputTail.trim()}`);
  }

  private async isHealthy(): Promise<boolean> {
    try {
      const result = await this.request<{ ready: boolean }>("GET", "/health", undefined, 800);
      return result.ready === true;
    } catch {
      return false;
    }
  }

  async status(): Promise<ServiceStatus> {
    await this.ensureStarted();
    return this.request("GET", "/v1/status");
  }

  async loadTts(): Promise<ServiceStatus> {
    await this.ensureStarted();
    return this.request("POST", "/v1/tts/load", {}, 300_000);
  }

  async unloadTts(): Promise<ServiceStatus> {
    if (!(await this.isHealthy())) return {
      ready: false,
      ttsLoaded: false,
      asrLoaded: false,
      playbackActive: false,
    };
    return this.request("POST", "/v1/tts/unload", {}, 30_000);
  }

  async speak(input: {
    text: string;
    profile?: string;
    language?: string;
    play?: boolean;
    interrupt?: boolean;
  }): Promise<SpeechResult> {
    await this.ensureStarted();
    return this.request("POST", "/v1/audio/speech", input, 600_000);
  }

  async transcribe(input: {
    source: string;
    language?: string;
    timestamps?: boolean;
  }): Promise<TranscriptionResult> {
    await this.ensureStarted();
    return this.request("POST", "/v1/audio/transcriptions", input, 300_000);
  }

  async startRecording(): Promise<RecordingStatus> {
    await this.ensureStarted();
    return this.request("POST", "/v1/recordings/start", {});
  }

  async recording(id: string): Promise<RecordingStatus> {
    return this.request("GET", `/v1/recordings/${encodeURIComponent(id)}`);
  }

  async stopRecording(id: string): Promise<RecordingStatus> {
    return this.request("POST", `/v1/recordings/${encodeURIComponent(id)}/stop`, {});
  }

  async stopPlayback(): Promise<void> {
    if (await this.isHealthy()) await this.request("POST", "/v1/playback/stop", {});
  }

  async shutdown(): Promise<void> {
    if (await this.isHealthy()) {
      try {
        await this.request("POST", "/shutdown", {}, 3000);
      } catch {
        // The server may close the connection while shutting down.
      }
    }
    const child = this.child;
    if (child && child.exitCode === null) {
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        sleep(2500),
      ]);
      if (child.exitCode === null) child.kill();
    }
    this.child = undefined;
  }

  private async request<T>(
    method: "GET" | "POST",
    route: string,
    body?: unknown,
    timeoutMs = 20_000,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || `Audio service request failed (${response.status})`);
      }
      return payload as T;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Audio service timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
