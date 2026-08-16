from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from funasr import AutoModel
from funasr.utils.postprocess_utils import rich_transcription_postprocess


def normalized(text: str) -> str:
    return "".join(re.findall(r"[\w\u4e00-\u9fff]", text.lower(), flags=re.UNICODE))


def edit_distance(left: str, right: str) -> int:
    previous = list(range(len(right) + 1))
    for left_index, left_char in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_char in enumerate(right, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[right_index] + 1,
                    previous[right_index - 1] + (left_char != right_char),
                )
            )
        previous = current
    return previous[-1]


def main() -> None:
    parser = argparse.ArgumentParser(description="Score generated checkpoint samples with local FunASR.")
    parser.add_argument("--evaluation", required=True, type=Path)
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    rows = json.loads(args.evaluation.read_text(encoding="utf-8"))
    model = AutoModel(model=args.model, device=args.device, disable_update=True, trust_remote_code=True)
    for row in rows:
        result = model.generate(
            input=row["audio"], cache={}, language="auto", use_itn=True, batch_size_s=60
        )
        raw = str(result[0].get("text", "")) if result else ""
        transcript = rich_transcription_postprocess(raw).strip()
        reference = normalized(str(row["text"]))
        hypothesis = normalized(transcript)
        distance = edit_distance(reference, hypothesis)
        row["asrText"] = transcript
        row["characterErrorRate"] = round(distance / max(len(reference), 1), 4)
        print(
            json.dumps(
                {
                    "checkpoint": row["checkpoint"],
                    "sample": row["sample"],
                    "asrText": transcript,
                    "characterErrorRate": row["characterErrorRate"],
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    output = args.output or args.evaluation.with_name("evaluation-asr.json")
    output.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
