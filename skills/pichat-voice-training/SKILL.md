---
name: pichat-voice-training
description: Prepare datasets, fine-tune, evaluate, debug, select, and register custom local Qwen3-TTS voices for PiChat. Use when the user asks to train or improve a persona voice, investigate abnormal TTS training speed or loss, compare checkpoints, resume a training run, or connect a trained voice to a Pi skill.
---

# PiChat voice training

Treat voice customization as a staged local pipeline. Reuse valid artifacts instead of restarting from raw audio.

## Establish the current stage

1. Call `voice_training_status` when available. Otherwise inspect the equivalent paths under `../../audio/` without loading model weights.
2. Read `../../audio/training/README.md` completely before changing data or running a pipeline stage. Resolve this path from the directory containing this `SKILL.md`.
3. Determine whether the task concerns source preparation, codec extraction, training, evaluation, checkpoint selection, registration, or debugging.
4. Before a new run, establish the stable voice ID, source manifest, audio/text/speaker fields, speaker filter, output paths, and whether training dependencies and base models are ready. Do not guess private dataset fields.

## Follow the pipeline

- Use `prepare_dataset.py` to select clip-level utterances, normalize audio, and produce one consistent reference. Review its report and sample audio; transcript alignment matters more than retaining every clip.
- Use `prepare_codes.py` only after the normalized manifest is sound. Reuse an existing complete coded manifest.
- Use `train.py` with the documented conservative preset first. Inspect dataset size and actual optimizer steps when training appears implausibly fast; do not diagnose convergence from wall time or loss alone.
- Use `evaluate.py`, `score_asr.py`, and `score_speaker.py` on comparable fixed sentences. Select a checkpoint using pace, pronunciation, stability, similarity, and listening—not lowest loss or latest epoch alone.
- Use `register_voice.py` only after selection. Add a skill-side `pichat.json` only when the user wants that persona to request the voice.

Show the exact command and important paths for each long-running or mutating stage. Run only the stage the user authorized, verify its outputs, and report what can be resumed.

## Preserve local data

- Keep audio, transcripts, datasets, evaluations, manifests, and checkpoints in their ignored private directories. Never commit, upload, or quote private transcripts.
- Use the Tsinghua PyPI mirror specified in the training guide for ordinary Python dependencies.
- Do not overwrite an existing voice manifest or delete datasets/checkpoints without explicit user direction. Confirm exact resolved targets before cleanup.
- Do not claim a checkpoint is usable unless `model.safetensors` and its configuration are present.
