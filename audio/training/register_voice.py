from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Register a private Qwen3-TTS checkpoint as a PiChat voice.")
    parser.add_argument("--id", required=True)
    parser.add_argument("--display-name", required=True)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--speaker", required=True)
    parser.add_argument("--voice-root", type=Path, default=Path(__file__).resolve().parents[1] / "voices" / "private")
    parser.add_argument("--language", default="Auto")
    parser.add_argument("--skill-dir", type=Path)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", args.id):
        raise SystemExit("Voice ID must contain only lowercase letters, digits, hyphens, or underscores.")
    model = args.model.resolve()
    if not (model / "model.safetensors").is_file():
        raise SystemExit(f"Complete checkpoint not found: {model}")
    voice_dir = args.voice_root.resolve() / args.id
    manifest_path = voice_dir / "voice.json"
    if manifest_path.exists() and not args.force:
        raise SystemExit(f"Voice already exists: {manifest_path}; use --force to replace it.")
    voice_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "id": args.id,
        "displayName": args.display_name,
        "provider": "qwen3-tts",
        "mode": "customVoice",
        "model": os.path.relpath(model, voice_dir),
        "speaker": args.speaker,
        "language": args.language,
    }
    atomic_json(manifest_path, manifest)
    if args.skill_dir:
        skill_dir = args.skill_dir.resolve()
        if not (skill_dir / "SKILL.md").is_file():
            raise SystemExit(f"Skill directory has no SKILL.md: {skill_dir}")
        atomic_json(skill_dir / "pichat.json", {"voice": args.id})
    print(manifest_path)


if __name__ == "__main__":
    main()
