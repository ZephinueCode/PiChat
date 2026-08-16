from __future__ import annotations

import argparse
import gc
import json
import random
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel


DEFAULT_TEXTS = [
    "今天还挺顺利的，先把眼前这个问题解决掉吧。",
    "我刚看完结果，整体没问题，不过还有一个小地方可以再确认一下。",
    "这个方案听起来可行，我们明天再接着聊。",
]


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate the same evaluation suite for Qwen3-TTS checkpoints.")
    parser.add_argument("--checkpoints", required=True, type=Path)
    parser.add_argument("--speaker", required=True)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--texts", type=Path)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--attention", default="sdpa")
    parser.add_argument("--language", default="Chinese")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    checkpoints = sorted(
        path for path in args.checkpoints.glob("checkpoint-epoch-*") if (path / "model.safetensors").is_file()
    )
    if not checkpoints and (args.checkpoints / "model.safetensors").is_file():
        checkpoints = [args.checkpoints]
    if not checkpoints:
        raise SystemExit("No complete checkpoints found.")
    texts = (
        [line.strip() for line in args.texts.read_text(encoding="utf-8").splitlines() if line.strip()]
        if args.texts
        else DEFAULT_TEXTS
    )
    args.output_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, object]] = []
    for checkpoint in checkpoints:
        model = Qwen3TTSModel.from_pretrained(
            str(checkpoint),
            device_map=args.device,
            dtype=torch.bfloat16,
            attn_implementation=args.attention,
        )
        for index, text in enumerate(texts, start=1):
            sample_seed = args.seed + index
            random.seed(sample_seed)
            np.random.seed(sample_seed)
            torch.manual_seed(sample_seed)
            if torch.cuda.is_available():
                torch.cuda.manual_seed_all(sample_seed)
            start = time.perf_counter()
            wavs, sample_rate = model.generate_custom_voice(
                text=text, language=args.language, speaker=args.speaker
            )
            synthesis_seconds = time.perf_counter() - start
            audio = wavs[0]
            duration = len(audio) / sample_rate
            destination = args.output_dir / f"{checkpoint.name}-{index:02d}.wav"
            sf.write(str(destination), audio, sample_rate)
            row = {
                "checkpoint": checkpoint.name,
                "sample": index,
                "text": text,
                "audio": str(destination.resolve()),
                "durationSeconds": round(duration, 4),
                "synthesisSeconds": round(synthesis_seconds, 4),
                "realTimeFactor": round(synthesis_seconds / max(duration, 1e-6), 4),
                "charactersPerSecond": round(len(text) / max(duration, 1e-6), 4),
            }
            rows.append(row)
            print(json.dumps(row, ensure_ascii=False), flush=True)
        del model
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    (args.output_dir / "evaluation.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
