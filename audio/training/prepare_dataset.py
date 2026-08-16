from __future__ import annotations

import argparse
import json
import math
import re
import shutil
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly


def read_rows(path: Path) -> list[dict[str, Any]]:
    if path.suffix.lower() == ".json":
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, list):
            raise ValueError("JSON input must contain a list of objects.")
        return value
    return [json.loads(line) for line in path.read_text(encoding="utf-8-sig").splitlines() if line.strip()]


def normalize_audio(source: Path, destination: Path) -> tuple[float, float]:
    audio, sample_rate = sf.read(str(source), dtype="float32", always_2d=True)
    mono = audio.mean(axis=1)
    if mono.size == 0:
        raise ValueError("audio is empty")
    if sample_rate != 24_000:
        divisor = math.gcd(int(sample_rate), 24_000)
        mono = resample_poly(mono, 24_000 // divisor, int(sample_rate) // divisor).astype(np.float32)
    peak = float(np.max(np.abs(mono))) if mono.size else 0.0
    if peak > 0.99:
        mono = mono * (0.99 / peak)
    destination.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(destination), mono, 24_000, subtype="PCM_16")
    frame = max(1, 24_000 // 20)
    framed = mono[: len(mono) // frame * frame].reshape(-1, frame) if len(mono) >= frame else mono.reshape(1, -1)
    rms = np.sqrt(np.mean(np.square(framed, dtype=np.float64), axis=1) + 1e-12)
    noise = max(float(np.percentile(rms, 10)), 1e-5)
    signal = max(float(np.sqrt(np.mean(np.square(mono, dtype=np.float64)))), 1e-5)
    return len(mono) / 24_000, 20 * math.log10(signal / noise)


def main() -> None:
    parser = argparse.ArgumentParser(description="Normalize a clip-level manifest for Qwen3-TTS fine-tuning.")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--audio-root", type=Path)
    parser.add_argument("--audio-field", default="audio")
    parser.add_argument("--text-field", default="text")
    parser.add_argument("--filter-field")
    parser.add_argument("--filter-value")
    parser.add_argument("--min-seconds", type=float, default=2.0)
    parser.add_argument("--max-seconds", type=float, default=30.0)
    parser.add_argument("--ref-audio", type=Path)
    args = parser.parse_args()

    input_path = args.input.resolve()
    audio_root = (args.audio_root or input_path.parent).resolve()
    output_dir = args.output_dir.resolve()
    clip_dir = output_dir / "audio"
    clip_dir.mkdir(parents=True, exist_ok=True)

    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for source_index, row in enumerate(read_rows(input_path)):
        if args.filter_field and str(row.get(args.filter_field)) != str(args.filter_value):
            continue
        text = re.sub(r"\s+", " ", str(row.get(args.text_field, ""))).strip()
        raw_audio = str(row.get(args.audio_field, "")).strip()
        if not text or not raw_audio:
            rejected.append({"row": source_index, "reason": "missing audio or text"})
            continue
        source = Path(raw_audio).expanduser()
        if not source.is_absolute():
            source = audio_root / source
        if not source.is_file():
            rejected.append({"row": source_index, "reason": "audio not found"})
            continue
        destination = clip_dir / f"{len(accepted):05d}.wav"
        try:
            duration, snr = normalize_audio(source, destination)
        except Exception as error:
            rejected.append({"row": source_index, "reason": f"decode failed: {error}"})
            continue
        if not args.min_seconds <= duration <= args.max_seconds:
            destination.unlink(missing_ok=True)
            rejected.append({"row": source_index, "reason": "duration", "duration": round(duration, 3)})
            continue
        accepted.append(
            {
                "audio": str(destination.resolve()),
                "text": text,
                "duration": duration,
                "snr": snr,
                "sourceRow": source_index,
            }
        )

    if not accepted:
        raise SystemExit("No clips passed validation.")

    reference = output_dir / "reference.wav"
    if args.ref_audio:
        reference_duration, _ = normalize_audio(args.ref_audio.resolve(), reference)
        if not 3.0 <= reference_duration <= 15.0:
            reference.unlink(missing_ok=True)
            raise SystemExit("Reference audio must be between 3 and 15 seconds.")
    else:
        candidates = [row for row in accepted if 4.0 <= row["duration"] <= 10.0] or accepted
        chosen = max(candidates, key=lambda row: row["snr"])
        shutil.copyfile(chosen["audio"], reference)

    raw_manifest = output_dir / "raw.jsonl"
    with raw_manifest.open("w", encoding="utf-8", newline="\n") as handle:
        for row in accepted:
            handle.write(
                json.dumps(
                    {"audio": row["audio"], "text": row["text"], "ref_audio": str(reference.resolve())},
                    ensure_ascii=False,
                )
                + "\n"
            )

    report = {
        "inputRows": len(read_rows(input_path)),
        "acceptedClips": len(accepted),
        "rejectedClips": len(rejected),
        "acceptedMinutes": round(sum(row["duration"] for row in accepted) / 60, 3),
        "durationSeconds": {
            "minimum": round(min(row["duration"] for row in accepted), 3),
            "maximum": round(max(row["duration"] for row in accepted), 3),
        },
        "referenceAudio": str(reference.resolve()),
        "rejections": rejected,
    }
    (output_dir / "prepare-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({key: value for key, value in report.items() if key != "rejections"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
