from __future__ import annotations

import gc
import time
from typing import Any


class FunASRProvider:
    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self.model = None
        self.device = "cpu"

    @property
    def loaded(self) -> bool:
        return self.model is not None

    def load(self) -> None:
        if self.model is not None:
            return
        import torch
        from funasr import AutoModel

        requested = str(self.config.get("device", "cpu")).lower()
        self.device = "cuda" if requested == "auto" and torch.cuda.is_available() else requested
        if self.device == "auto":
            self.device = "cpu"
        self.model = AutoModel(
            model=self.config["model"],
            device=self.device,
            disable_update=True,
            trust_remote_code=True,
        )

    def unload(self) -> None:
        self.model = None
        gc.collect()

    def transcribe(self, source: str, language: str | None = None, timestamps: bool = False) -> dict[str, Any]:
        self.load()
        from funasr.utils.postprocess_utils import rich_transcription_postprocess

        selected_language = language or self.config.get("language", "auto")
        started = time.perf_counter()
        result = self.model.generate(
            input=source,
            cache={},
            language=selected_language,
            use_itn=bool(self.config.get("useItn", True)),
            batch_size_s=60,
        )
        item = result[0] if result else {}
        text = rich_transcription_postprocess(str(item.get("text", ""))).strip()
        response: dict[str, Any] = {
            "text": text,
            "language": selected_language,
            "durationMs": round((time.perf_counter() - started) * 1000),
            "source": source,
        }
        if timestamps:
            response["timestamps"] = item.get("timestamp") or item.get("sentence_info") or []
        return response
