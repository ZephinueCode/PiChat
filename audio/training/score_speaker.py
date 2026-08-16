from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

import torch
from funasr import AutoModel


def main() -> None:
    parser = argparse.ArgumentParser(description="Score generated samples with a local CAMPPlus speaker model.")
    parser.add_argument("--evaluation", required=True, type=Path)
    parser.add_argument("--reference", required=True, type=Path)
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    model = AutoModel(model=args.model, device=args.device, disable_update=True)

    def embedding(path: Path) -> torch.Tensor:
        result = model.generate(input=str(path))
        if not result or "spk_embedding" not in result[0]:
            raise RuntimeError(f"Speaker model returned no embedding for {path}")
        return result[0]["spk_embedding"].flatten()

    reference = embedding(args.reference.resolve())
    rows = json.loads(args.evaluation.read_text(encoding="utf-8"))
    grouped: dict[str, list[float]] = defaultdict(list)
    for row in rows:
        generated = embedding(Path(row["audio"]))
        similarity = float(torch.nn.functional.cosine_similarity(reference, generated, dim=0))
        row["speakerSimilarity"] = round(similarity, 4)
        grouped[str(row["checkpoint"])].append(similarity)
    summary = {
        checkpoint: {
            "meanSpeakerSimilarity": round(sum(values) / len(values), 4),
            "minimumSpeakerSimilarity": round(min(values), 4),
        }
        for checkpoint, values in sorted(grouped.items())
    }
    output = args.output or args.evaluation.with_name("evaluation-speaker.json")
    output.write_text(
        json.dumps({"checkpoints": summary, "samples": rows}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
