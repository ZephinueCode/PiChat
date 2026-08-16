import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isVoiceTrainingIntent,
  voiceTrainingTurnPrompt,
} from "../extensions/training-context.ts";
import { collectVoiceTrainingStatus } from "../extensions/training-status.ts";

function write(root: string, relativePath: string, content = "fixture"): string {
  const destination = path.join(root, relativePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, content, "utf8");
  return destination;
}

test("reports training stages without reading transcript contents", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pichat-training-status-"));
  try {
    write(root, "audio/training/README.md", "guide");
    write(root, "audio/.venv/Scripts/python.exe");
    write(root, "audio/models/Qwen3-TTS-12Hz-0.6B-Base/model.safetensors");
    write(root, "audio/models/Qwen3-TTS-Tokenizer-12Hz/model.safetensors");
    write(root, "audio/models/SenseVoiceSmall/model.pt");
    write(root, "audio/models/CAMPPlus/campplus_cn_common.bin");

    write(root, "audio/datasets/private/sample-speaker/raw.jsonl", "private transcript text");
    write(root, "audio/datasets/private/sample-speaker/coded.jsonl");
    write(root, "audio/datasets/private/sample-speaker/reference.wav");
    write(
      root,
      "audio/datasets/private/sample-speaker/prepare-report.json",
      JSON.stringify({ acceptedClips: 42, acceptedMinutes: 7.5, rejections: ["private details"] }),
    );

    write(root, "audio/models/custom/sample-speaker/checkpoint-epoch-1/model.safetensors");
    mkdirSync(
      path.join(root, "audio/models/custom/sample-speaker/checkpoint-epoch-2"),
      { recursive: true },
    );
    write(root, "audio/models/custom/sample-speaker/train-metrics.jsonl");
    write(root, "audio/evaluations/private/sample-speaker/evaluation.json", "[]");
    write(
      root,
      "audio/voices/private/sample-speaker/voice.json",
      JSON.stringify({
        id: "sample-speaker",
        displayName: "Sample speaker",
        model: "../../../models/custom/sample-speaker/checkpoint-epoch-1",
      }),
    );

    const status = collectVoiceTrainingStatus(root, {
      platform: "win32",
      probeDependencies: false,
    });

    assert.equal(status.guide.available, true);
    assert.equal(status.python.available, true);
    assert.equal(status.python.dependencies, "not_checked");
    assert.deepEqual(
      Object.values(status.models).map((model) => model.available),
      [true, true, true, true],
    );
    assert.deepEqual(status.datasets, [{
      id: "sample-speaker",
      path: path.join(root, "audio/datasets/private/sample-speaker"),
      prepared: true,
      coded: true,
      referenceAudio: true,
      acceptedClips: 42,
      acceptedMinutes: 7.5,
    }]);
    assert.equal(status.runs[0]?.checkpoints[0]?.complete, true);
    assert.equal(status.runs[0]?.checkpoints[1]?.complete, false);
    assert.equal(status.runs[0]?.evaluationAvailable, true);
    assert.equal(status.registeredVoices[0]?.available, true);
    assert.equal(JSON.stringify(status).includes("private transcript text"), false);
    assert.equal(JSON.stringify(status).includes("private details"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handles an unconfigured installation without creating files", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pichat-training-empty-"));
  try {
    const status = collectVoiceTrainingStatus(root, {
      platform: "linux",
      probeDependencies: false,
    });

    assert.equal(status.guide.available, false);
    assert.equal(status.python.dependencies, "unavailable");
    assert.deepEqual(status.datasets, []);
    assert.deepEqual(status.runs, []);
    assert.deepEqual(status.registeredVoices, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publishes the bundled training skill through the Pi package manifest", () => {
  const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    pi?: { skills?: string[] };
  };

  assert.deepEqual(packageJson.pi?.skills, ["./skills"]);
  assert.match(
    readFileSync(path.join(process.cwd(), "skills/pichat-voice-training/SKILL.md"), "utf8"),
    /^---\r?\nname: pichat-voice-training\r?\n/,
  );
});

test("routes voice-training requests without matching ordinary voice chat", () => {
  assert.equal(isVoiceTrainingIntent("我想继续训练一个已有的 PiChat 自定义声音"), true);
  assert.equal(isVoiceTrainingIntent("给这个人格做一个专属音色模型"), true);
  assert.equal(isVoiceTrainingIntent("Compare two TTS checkpoints before registration"), true);
  assert.equal(isVoiceTrainingIntent("/skill:pichat-voice-training resume this run"), true);
  assert.equal(isVoiceTrainingIntent("打开语音聊天并选择一个 voice"), false);
  assert.equal(isVoiceTrainingIntent("Help train an unrelated image model"), false);

  const injection = voiceTrainingTurnPrompt("C:\\PiChat");
  assert.match(injection, /pichat-voice-training\/SKILL\.md/);
  assert.match(injection, /voice_training_status/);
});
