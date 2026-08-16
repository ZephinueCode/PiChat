from __future__ import annotations

import json
import os
import re
from copy import deepcopy
from pathlib import Path
from typing import Any


def _resolve_path(value: str, root: Path) -> str:
    path = Path(os.path.expandvars(os.path.expanduser(value)))
    return str(path if path.is_absolute() else (root / path).resolve())


def _normalize_profile(profile: dict[str, Any], root: Path) -> dict[str, Any]:
    normalized = dict(profile)
    for key in ("model", "refAudio"):
        value = normalized.get(key)
        if value and not Path(os.path.expandvars(os.path.expanduser(str(value)))).is_absolute():
            normalized[key] = _resolve_path(str(value), root)
    return normalized


def refresh_voice_profiles(config: dict[str, Any]) -> list[dict[str, Any]]:
    tts = config["tts"]
    configured = deepcopy(tts.get("_configuredProfiles", {}))
    profiles: dict[str, dict[str, Any]] = {}
    sources: dict[str, str] = {}
    voice_root = Path(config["storage"]["voices"])
    for manifest_path in sorted(voice_root.rglob("voice.json")):
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            voice_id = str(manifest.get("id", "")).strip()
            if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", voice_id):
                continue
            if str(manifest.get("provider", "qwen3-tts")).lower() != "qwen3-tts":
                continue
            profile = {
                key: value
                for key, value in manifest.items()
                if key in {"displayName", "mode", "model", "speaker", "language", "instruct", "refAudio", "refText", "xVectorOnly"}
            }
            profiles[voice_id] = _normalize_profile(profile, manifest_path.parent)
            sources[voice_id] = "manifest"
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            continue
    for voice_id, profile in configured.items():
        profiles[voice_id] = deepcopy(profile)
        sources[voice_id] = "config"
    tts["profiles"] = profiles

    default_model = str(tts.get("model", ""))
    default_profile = str(tts.get("defaultProfile", "default"))
    voices = []
    for voice_id, profile in sorted(profiles.items()):
        model = str(profile.get("model", default_model))
        model_available = bool(model) and (Path(model).exists() or ("/" in model and not Path(model).is_absolute()))
        voices.append(
            {
                "id": voice_id,
                "displayName": str(profile.get("displayName", voice_id)),
                "mode": str(profile.get("mode", "customVoice")),
                "language": str(profile.get("language", "Auto")),
                "isDefault": voice_id == default_profile,
                "available": model_available,
                "source": sources[voice_id],
            }
        )
    return voices


def load_config(config_path: str) -> dict[str, Any]:
    path = Path(config_path).resolve()
    with path.open("r", encoding="utf-8") as handle:
        config = json.load(handle)
    root = path.parent
    config["_configRoot"] = str(root)

    storage = config.setdefault("storage", {})
    for key in ("models", "cache", "recordings", "generated", "voices"):
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

    tts = config.setdefault("tts", {})
    tts["_configuredProfiles"] = deepcopy(tts.get("profiles", {}))
    refresh_voice_profiles(config)

    os.environ.setdefault("MODELSCOPE_CACHE", storage["models"])
    os.environ.setdefault("HF_HOME", str(Path(storage["cache"]) / "huggingface"))
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    os.environ.setdefault("PYTHONUTF8", "1")
    return config
