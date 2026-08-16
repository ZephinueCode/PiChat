from __future__ import annotations

import argparse
import json
from pathlib import Path

from qwen_tts import Qwen3TTSTokenizer


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract Qwen3-TTS 12 Hz audio codes.")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--tokenizer", required=True)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--batch-size", type=int, default=8)
    args = parser.parse_args()

    rows = [json.loads(line) for line in args.input.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not rows:
        raise SystemExit("Input manifest is empty.")
    tokenizer = Qwen3TTSTokenizer.from_pretrained(args.tokenizer, device_map=args.device)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8", newline="\n") as handle:
        for start in range(0, len(rows), args.batch_size):
            batch = rows[start : start + args.batch_size]
            encoded = tokenizer.encode([row["audio"] for row in batch])
            for row, codes in zip(batch, encoded.audio_codes, strict=True):
                row["audio_codes"] = codes.cpu().tolist()
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
            print(f"Encoded {min(start + len(batch), len(rows))}/{len(rows)}", flush=True)


if __name__ == "__main__":
    main()
