import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface PathAvailability {
  path: string;
  available: boolean;
}

export interface DatasetStatus {
  id: string;
  path: string;
  prepared: boolean;
  coded: boolean;
  referenceAudio: boolean;
  acceptedClips?: number;
  acceptedMinutes?: number;
}

export interface CheckpointStatus {
  name: string;
  path: string;
  complete: boolean;
}

export interface TrainingRunStatus {
  id: string;
  path: string;
  checkpoints: CheckpointStatus[];
  metricsAvailable: boolean;
  evaluationAvailable: boolean;
}

export interface RegisteredVoiceStatus {
  id: string;
  displayName: string;
  manifestPath: string;
  modelPath?: string;
  available: boolean;
}

export interface VoiceTrainingStatus {
  version: 1;
  platform: NodeJS.Platform;
  packageRoot: string;
  guide: PathAvailability;
  python: PathAvailability & {
    dependencies: "ready" | "missing" | "not_checked" | "unavailable";
    missingModules: string[];
  };
  models: {
    base: PathAvailability;
    tokenizer: PathAvailability;
    asr: PathAvailability;
    speakerEncoder: PathAvailability;
  };
  datasets: DatasetStatus[];
  runs: TrainingRunStatus[];
  registeredVoices: RegisteredVoiceStatus[];
}

export interface TrainingStatusOptions {
  platform?: NodeJS.Platform;
  probeDependencies?: boolean;
}

export const PICHAT_PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const TRAINING_MODULES = [
  "accelerate",
  "modelscope",
  "qwen_tts",
  "safetensors",
  "scipy",
  "torch",
];

function directories(root: string): string[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => path.join(root, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function safeJson(filePath: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(filePath) || statSync(filePath).size > 10_000_000) return undefined;
    const value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function availability(targetPath: string, marker?: string): PathAvailability {
  return {
    path: path.resolve(targetPath),
    available: existsSync(marker ?? targetPath),
  };
}

function pythonPath(audioRoot: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? path.join(audioRoot, ".venv", "Scripts", "python.exe")
    : path.join(audioRoot, ".venv", "bin", "python");
}

function dependencyStatus(
  executable: string,
  probe: boolean,
): { dependencies: VoiceTrainingStatus["python"]["dependencies"]; missingModules: string[] } {
  if (!existsSync(executable)) {
    return { dependencies: "unavailable", missingModules: [...TRAINING_MODULES] };
  }
  if (!probe) return { dependencies: "not_checked", missingModules: [] };
  const script = [
    "import importlib.util,json",
    `modules=${JSON.stringify(TRAINING_MODULES)}`,
    "missing=[name for name in modules if importlib.util.find_spec(name) is None]",
    "print(json.dumps({'missing':missing}))",
  ].join(";");
  try {
    const result = spawnSync(executable, ["-c", script], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    if (result.status !== 0) return { dependencies: "not_checked", missingModules: [] };
    const parsed = JSON.parse(result.stdout.trim()) as { missing?: unknown };
    const missingModules = Array.isArray(parsed.missing)
      ? parsed.missing.filter((value): value is string => typeof value === "string")
      : [];
    return {
      dependencies: missingModules.length ? "missing" : "ready",
      missingModules,
    };
  } catch {
    return { dependencies: "not_checked", missingModules: [] };
  }
}

function datasetStatuses(audioRoot: string): DatasetStatus[] {
  const privateRoot = path.join(audioRoot, "datasets", "private");
  return directories(privateRoot).map((datasetPath) => {
    const report = safeJson(path.join(datasetPath, "prepare-report.json"));
    const acceptedClips = report?.acceptedClips;
    const acceptedMinutes = report?.acceptedMinutes;
    return {
      id: path.basename(datasetPath),
      path: datasetPath,
      prepared: existsSync(path.join(datasetPath, "raw.jsonl")),
      coded: existsSync(path.join(datasetPath, "coded.jsonl")),
      referenceAudio: existsSync(path.join(datasetPath, "reference.wav")),
      ...(typeof acceptedClips === "number" ? { acceptedClips } : {}),
      ...(typeof acceptedMinutes === "number" ? { acceptedMinutes } : {}),
    };
  });
}

function trainingRuns(audioRoot: string): TrainingRunStatus[] {
  const customRoot = path.join(audioRoot, "models", "custom");
  const evaluationsRoot = path.join(audioRoot, "evaluations", "private");
  return directories(customRoot)
    .map((runPath) => {
      const checkpoints = directories(runPath)
        .filter((checkpointPath) => /^checkpoint-epoch-\d+$/.test(path.basename(checkpointPath)))
        .map((checkpointPath) => ({
          name: path.basename(checkpointPath),
          path: checkpointPath,
          complete: existsSync(path.join(checkpointPath, "model.safetensors")),
        }));
      return {
        id: path.basename(runPath),
        path: runPath,
        checkpoints,
        metricsAvailable: existsSync(path.join(runPath, "train-metrics.jsonl")),
        evaluationAvailable: existsSync(
          path.join(evaluationsRoot, path.basename(runPath), "evaluation.json"),
        ),
      };
    })
    .filter((run) => run.checkpoints.length > 0 || run.metricsAvailable || run.evaluationAvailable);
}

function registeredVoices(audioRoot: string): RegisteredVoiceStatus[] {
  const voiceRoot = path.join(audioRoot, "voices", "private");
  const voices: RegisteredVoiceStatus[] = [];
  for (const voicePath of directories(voiceRoot)) {
    const manifestPath = path.join(voicePath, "voice.json");
    const manifest = safeJson(manifestPath);
    if (!manifest || typeof manifest.id !== "string") continue;
    const modelValue = typeof manifest.model === "string" ? manifest.model : undefined;
    const modelPath = modelValue
      ? path.resolve(voicePath, modelValue)
      : undefined;
    voices.push({
      id: manifest.id,
      displayName: typeof manifest.displayName === "string" ? manifest.displayName : manifest.id,
      manifestPath,
      ...(modelPath ? { modelPath } : {}),
      available: Boolean(modelPath && existsSync(path.join(modelPath, "model.safetensors"))),
    });
  }
  return voices.sort((left, right) => left.id.localeCompare(right.id));
}

export function collectVoiceTrainingStatus(
  packageRoot = PICHAT_PACKAGE_ROOT,
  options: TrainingStatusOptions = {},
): VoiceTrainingStatus {
  const resolvedRoot = path.resolve(packageRoot);
  const audioRoot = path.join(resolvedRoot, "audio");
  const platform = options.platform ?? process.platform;
  const executable = pythonPath(audioRoot, platform);
  const dependencies = dependencyStatus(executable, options.probeDependencies !== false);
  const modelsRoot = path.join(audioRoot, "models");

  return {
    version: 1,
    platform,
    packageRoot: resolvedRoot,
    guide: availability(path.join(audioRoot, "training", "README.md")),
    python: {
      ...availability(executable),
      ...dependencies,
    },
    models: {
      base: availability(
        path.join(modelsRoot, "Qwen3-TTS-12Hz-0.6B-Base"),
        path.join(modelsRoot, "Qwen3-TTS-12Hz-0.6B-Base", "model.safetensors"),
      ),
      tokenizer: availability(
        path.join(modelsRoot, "Qwen3-TTS-Tokenizer-12Hz"),
        path.join(modelsRoot, "Qwen3-TTS-Tokenizer-12Hz", "model.safetensors"),
      ),
      asr: availability(
        path.join(modelsRoot, "SenseVoiceSmall"),
        path.join(modelsRoot, "SenseVoiceSmall", "model.pt"),
      ),
      speakerEncoder: availability(
        path.join(modelsRoot, "CAMPPlus"),
        path.join(modelsRoot, "CAMPPlus", "campplus_cn_common.bin"),
      ),
    },
    datasets: datasetStatuses(audioRoot),
    runs: trainingRuns(audioRoot),
    registeredVoices: registeredVoices(audioRoot),
  };
}
