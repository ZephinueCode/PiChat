from __future__ import annotations

import importlib.metadata
import json
import platform
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return "not installed"


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    import sounddevice as sd
    import torch

    report = {
        "python": platform.python_version(),
        "packages": {
            name: version(name)
            for name in ("qwen-tts", "funasr", "modelscope", "sounddevice", "soundfile", "torch")
        },
        "cuda": {
            "available": torch.cuda.is_available(),
            "version": torch.version.cuda,
            "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        },
        "models": {
            "qwen3_tts": (ROOT / "models" / "Qwen3-TTS-12Hz-0.6B-CustomVoice").is_dir(),
            "sensevoice": (ROOT / "models" / "SenseVoiceSmall").is_dir(),
        },
        "audio": {
            "default": list(sd.default.device),
            "devices": [
                {
                    "id": index,
                    "name": device["name"],
                    "inputs": device["max_input_channels"],
                    "outputs": device["max_output_channels"],
                }
                for index, device in enumerate(sd.query_devices())
            ],
        },
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
