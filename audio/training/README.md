# Custom voice training

PiChat's training pipeline fine-tunes the official `Qwen3-TTS-12Hz-0.6B-Base` model into a local CustomVoice checkpoint. Audio, transcripts, generated samples, private manifests, and checkpoints should stay under ignored local directories.

## Why this trainer differs from the upstream example

The pipeline keeps the official dataset layout and checkpoint conversion, with two alignment corrections:

- The autoregressive talker receives text and codec group 0 only. Adding target groups 1–15 exposes future acoustic information that is absent during inference and can make speech progressively faster after each epoch.
- PiChat computes both losses explicitly. Codec-0 labels are shifted once for next-token prediction; parallel codec groups 1–15 are compared at the same frame. This avoids the additional automatic causal shift applied by recent Transformers loss helpers.

`test_losses.py` is a small regression test for both alignments.

## Models and environment

The setup scripts can add the training utilities and both training models while keeping ordinary Python packages on the Tsinghua mirror:

```powershell
.\audio\setup.ps1 -Training
```

```bash
./audio/setup.sh --training
```

For an existing audio environment whose inference models are already installed, the smaller dependency-only command is:

```powershell
audio\.venv\Scripts\python.exe -m pip install -r audio\training\requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

```bash
audio/.venv/bin/python -m pip install -r audio/training/requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

Download these two repositories with ModelScope and keep them in `audio/models/`:

- `Qwen/Qwen3-TTS-12Hz-0.6B-Base`
- `Qwen/Qwen3-TTS-Tokenizer-12Hz`

The 12GB preset uses batch size 1, four-step gradient accumulation, bf16, gradient checkpointing, and SDPA when FlashAttention is unavailable.

## 1. Prepare clip-level audio

Input can be JSON or JSONL. Each selected row needs an audio path and exact transcript. Long recordings should be segmented and transcribed/aligned before this step; do not split audio while retaining the complete recording transcript.

```powershell
audio\.venv\Scripts\python.exe audio\training\prepare_dataset.py `
  --input D:\private\voice.jsonl `
  --audio-root D:\private\export `
  --audio-field source_path `
  --text-field text `
  --filter-field user_id `
  --filter-value target-speaker `
  --output-dir audio\datasets\private\target-speaker `
  --max-seconds 30
```

All accepted clips are normalized to mono 24kHz PCM. The output uses one fixed reference WAV across every row, as recommended by Qwen. Pass `--ref-audio` to choose a clean 4–10 second reference yourself; otherwise the script selects a high-SNR accepted clip.

Review `prepare-report.json` and listen to a sample before continuing. Transcript/audio alignment matters more than retaining every minute of source material.

## 2. Extract 12Hz codec tokens

```powershell
audio\.venv\Scripts\python.exe audio\training\prepare_codes.py `
  --input audio\datasets\private\target-speaker\raw.jsonl `
  --output audio\datasets\private\target-speaker\coded.jsonl `
  --tokenizer audio\models\Qwen3-TTS-Tokenizer-12Hz `
  --batch-size 8
```

Reduce `--batch-size` if tokenization runs out of VRAM.

## 3. Fine-tune checkpoints

```powershell
audio\.venv\Scripts\python.exe audio\training\train.py `
  --model audio\models\Qwen3-TTS-12Hz-0.6B-Base `
  --train-jsonl audio\datasets\private\target-speaker\coded.jsonl `
  --output-dir audio\models\custom\target-speaker `
  --speaker target-speaker `
  --epochs 3 `
  --batch-size 1 `
  --gradient-accumulation 4 `
  --learning-rate 2e-6 `
  --attention auto
```

Loss alone does not select the best voice checkpoint. Three epochs is a starting point, not a target.

## 4. Compare pace and voice quality

```powershell
audio\.venv\Scripts\python.exe audio\training\evaluate.py `
  --checkpoints audio\models\custom\target-speaker `
  --speaker target-speaker `
  --output-dir audio\evaluations\private\target-speaker
```

Listen to the same sentences across epochs and inspect `evaluation.json`. Reject a checkpoint if later epochs become rushed, duration repeatedly shrinks, pronunciation degrades, or the voice loses similarity even while loss improves.
The evaluator resets the same sampling seed for each sentence at every checkpoint so pace comparisons are not dominated by one random generation.

For a repeatable intelligibility check, score the generated suite with the already installed local ASR model:

```powershell
audio\.venv\Scripts\python.exe audio\training\score_asr.py `
  --evaluation audio\evaluations\private\target-speaker\evaluation.json `
  --model audio\models\SenseVoiceSmall
```

Character error rate is only a guardrail: it can catch omissions, repetitions, or severely broken pronunciation, but it cannot judge speaker similarity or naturalness. Final checkpoint selection still requires listening.

The `--training` setup also downloads CAMPPlus. Use it for a consistent speaker-similarity comparison against the fixed reference:

```powershell
audio\.venv\Scripts\python.exe audio\training\score_speaker.py `
  --evaluation audio\evaluations\private\target-speaker\evaluation.json `
  --reference audio\datasets\private\target-speaker\reference.wav `
  --model audio\models\CAMPPlus
```

Compare checkpoint means and minima, rather than treating one sentence as decisive. Speaker similarity is still not a substitute for checking prosody and artifacts by ear.

## 5. Register the selected voice

```powershell
audio\.venv\Scripts\python.exe audio\training\register_voice.py `
  --id target-speaker `
  --display-name "Target speaker" `
  --model audio\models\custom\target-speaker\checkpoint-epoch-2 `
  --speaker target-speaker
```

The manifest is written to the ignored `audio/voices/private/<id>/voice.json`. Restart the audio service (toggle `/tts` off and on, or run `/reload`) and choose it with `/voice`.

A skill can request the same voice without containing a model path by adding a sidecar next to `SKILL.md`:

```json
{
  "voice": "target-speaker"
}
```

PiChat falls back to the manually selected/default voice when the requested ID is not installed or fails to synthesize.

## Upstream references

- Qwen3-TTS repository: <https://github.com/QwenLM/Qwen3-TTS>
- Official single-speaker fine-tuning example: <https://github.com/QwenLM/Qwen3-TTS/tree/main/finetuning>
- Causality issue and training-speed regression analysis: <https://github.com/QwenLM/Qwen3-TTS/pull/178>
