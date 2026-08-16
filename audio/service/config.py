from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


def _resolve_path(value: str, root: Path) -> str:
    path = Path(os.path.expandvars(os.path.expanduser(value)))
    return str(path if path.is_absolute() else (root / path).resolve())


def load_config(config_path: str) -> dict[str, Any]:
    path = Path(config_path).resolve()
    with path.open("r", encoding="utf-8") as handle:
        config = json.load(handle)
    root = path.parent

    storage = config.setdefault("storage", {})
    for key in ("models", "cache", "recordings", "generated"):
        storage[key] = _resolve_path(storage.get(key, key), root)
        Path(storage[key]).mkdir(parents=True, exist_ok=True)

    for section in ("tts", "asr"):
        model = config.get(section, {}).get("model")
        if model and (model.startswith(".") or model.startswith("models/") or model.startswith("models\\")):
            config[section]["model"] = _resolve_path(model, root)

    for profile in config.get("tts", {}).get("profiles", {}).values():
        for key in ("model", "refAudio"):
            value = profile.get(key)
            if value and (value.startswith(".") or value.startswith("models/") or value.startswith("models\\") or value.startswith("voices/") or value.startswith("voices\\")):
                profile[key] = _resolve_path(value, root)

    os.environ.setdefault("MODELSCOPE_CACHE", storage["models"])
    os.environ.setdefault("HF_HOME", str(Path(storage["cache"]) / "huggingface"))
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    os.environ.setdefault("PYTHONUTF8", "1")
    return config
