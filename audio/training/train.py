from __future__ import annotations

import argparse
import importlib.util
import json
import os
import random
import shutil
import time
from pathlib import Path
from typing import Any

import numpy as np
import torch
from accelerate import Accelerator
from qwen_tts.inference.qwen3_tts_model import Qwen3TTSModel
from safetensors.torch import save_file
from torch.optim import AdamW
from torch.utils.data import DataLoader
from transformers import AutoConfig

from losses import causal_codec_loss, parallel_codebook_loss
from qwen_dataset import TTSDataset


def attention_backend(requested: str) -> str:
    if requested != "auto":
        return requested
    return "flash_attention_2" if importlib.util.find_spec("flash_attn") else "sdpa"


def copy_model_assets(source: Path, destination: Path) -> None:
    source = source.resolve()

    def ignore(path: str, names: list[str]) -> set[str]:
        if Path(path).resolve() == source:
            return {"model.safetensors"} & set(names)
        return set()

    shutil.copytree(source, destination, dirs_exist_ok=True, ignore=ignore)


def save_custom_voice_checkpoint(
    accelerator: Accelerator,
    model: torch.nn.Module,
    source_model: Path,
    output: Path,
    speaker_name: str,
    speaker_embedding: torch.Tensor,
) -> None:
    output.mkdir(parents=True, exist_ok=True)
    copy_model_assets(source_model, output)
    config_path = output / "config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config["tts_model_type"] = "custom_voice"
    talker_config = config.setdefault("talker_config", {})
    talker_config["spk_id"] = {speaker_name: 3000}
    talker_config["spk_is_dialect"] = {speaker_name: False}
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    unwrapped = accelerator.unwrap_model(model)
    state = {name: value.detach().cpu() for name, value in unwrapped.state_dict().items()}
    for name in [name for name in state if name.startswith("speaker_encoder")]:
        del state[name]
    weight = state["talker.model.codec_embedding.weight"]
    weight[3000] = speaker_embedding[0].to(device=weight.device, dtype=weight.dtype)
    temporary = output / "model.safetensors.tmp"
    save_file(state, str(temporary))
    os.replace(temporary, output / "model.safetensors")


def main() -> None:
    parser = argparse.ArgumentParser(description="Causality-correct Qwen3-TTS single-speaker fine-tuning.")
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--train-jsonl", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--speaker", required=True)
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--gradient-accumulation", type=int, default=4)
    parser.add_argument("--learning-rate", type=float, default=2e-6)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--max-grad-norm", type=float, default=1.0)
    parser.add_argument("--attention", choices=["auto", "sdpa", "flash_attention_2", "eager"], default="auto")
    parser.add_argument("--mixed-precision", choices=["bf16", "fp16", "no"], default="bf16")
    parser.add_argument("--gradient-checkpointing", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--save-every-epoch", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--max-steps", type=int, help="Optional smoke-test limit across all epochs")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    if not re_safe_speaker(args.speaker):
        raise SystemExit("Speaker ID must contain only lowercase letters, digits, hyphens, or underscores.")
    source_model = args.model.resolve()
    if not (source_model / "model.safetensors").is_file():
        raise SystemExit(f"Local base model not found: {source_model}")

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    accelerator = Accelerator(
        gradient_accumulation_steps=args.gradient_accumulation,
        mixed_precision=None if args.mixed_precision == "no" else args.mixed_precision,
    )
    backend = attention_backend(args.attention)
    accelerator.print(f"Loading {source_model} with attention={backend}")
    load_options: dict[str, Any] = {"attn_implementation": backend}
    if args.mixed_precision == "bf16":
        load_options["dtype"] = torch.bfloat16
    elif args.mixed_precision == "fp16":
        load_options["dtype"] = torch.float16
    wrapper = Qwen3TTSModel.from_pretrained(str(source_model), **load_options)
    config = AutoConfig.from_pretrained(str(source_model))
    model = wrapper.model
    for parameter in model.speaker_encoder.parameters():
        parameter.requires_grad_(False)
    if args.gradient_checkpointing:
        model.gradient_checkpointing_enable()
        model.config.use_cache = False

    rows = [
        json.loads(line)
        for line in args.train_jsonl.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    dataset = TTSDataset(rows, wrapper.processor, config)
    dataloader = DataLoader(
        dataset,
        batch_size=args.batch_size,
        shuffle=True,
        collate_fn=dataset.collate_fn,
        num_workers=0,
        pin_memory=torch.cuda.is_available(),
    )
    trainable = [parameter for parameter in model.talker.parameters() if parameter.requires_grad]
    optimizer = AdamW(trainable, lr=args.learning_rate, weight_decay=args.weight_decay)
    model, optimizer, dataloader = accelerator.prepare(model, optimizer, dataloader)
    model.train()

    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    log_path = output_dir / "train-metrics.jsonl"
    target_speaker_embedding: torch.Tensor | None = None
    global_step = 0
    started = time.perf_counter()

    for epoch in range(1, args.epochs + 1):
        epoch_loss = 0.0
        epoch_steps = 0
        for step, batch in enumerate(dataloader, start=1):
            with accelerator.accumulate(model):
                with torch.no_grad():
                    speaker_embedding = model.speaker_encoder(
                        batch["ref_mels"].to(device=accelerator.device, dtype=next(model.parameters()).dtype)
                    ).detach()
                if target_speaker_embedding is None:
                    target_speaker_embedding = speaker_embedding[:1].detach().cpu()

                input_ids = batch["input_ids"]
                input_text = model.talker.text_projection(
                    model.talker.get_text_embeddings()(input_ids[:, :, 0])
                )
                input_codec = model.talker.get_input_embeddings()(input_ids[:, :, 1])
                input_text = input_text * batch["text_embedding_mask"]
                input_codec = input_codec * batch["codec_embedding_mask"]
                input_codec[:, 6, :] = speaker_embedding
                # Deliberately do not add codec groups 1..15 here. They are future
                # information at inference time and leak the acoustic target.
                input_embeddings = input_text + input_codec

                outputs = model.talker(
                    inputs_embeds=input_embeddings,
                    attention_mask=batch["attention_mask"],
                    labels=None,
                    output_hidden_states=True,
                    use_cache=False,
                )
                ar_loss = causal_codec_loss(outputs.logits, batch["codec_0_labels"])
                hidden_states = outputs.hidden_states[0][-1]
                talker_hidden = hidden_states[batch["codec_mask"]]
                codec_targets = batch["codec_ids"][batch["codec_mask"]]
                sub_logits, _ = model.talker.forward_sub_talker_finetune(codec_targets, talker_hidden)
                sub_loss = parallel_codebook_loss(sub_logits, codec_targets[:, 1:])
                loss = ar_loss + 0.3 * sub_loss

                accelerator.backward(loss)
                if accelerator.sync_gradients:
                    accelerator.clip_grad_norm_(trainable, args.max_grad_norm)
                optimizer.step()
                optimizer.zero_grad()

            global_step += 1
            epoch_steps += 1
            epoch_loss += float(loss.detach())
            if step == 1 or step % 10 == 0 or step == len(dataloader):
                metric = {
                    "epoch": epoch,
                    "step": step,
                    "globalStep": global_step,
                    "loss": round(float(loss.detach()), 6),
                    "arLoss": round(float(ar_loss.detach()), 6),
                    "subLoss": round(float(sub_loss.detach()), 6),
                    "elapsedSeconds": round(time.perf_counter() - started, 2),
                }
                accelerator.print(json.dumps(metric, ensure_ascii=False))
                if accelerator.is_main_process:
                    with log_path.open("a", encoding="utf-8", newline="\n") as handle:
                        handle.write(json.dumps(metric, ensure_ascii=False) + "\n")
            if args.max_steps and global_step >= args.max_steps:
                break

        accelerator.wait_for_everyone()
        if args.max_steps and global_step >= args.max_steps:
            break
        summary = {"epoch": epoch, "meanLoss": epoch_loss / max(epoch_steps, 1)}
        accelerator.print(json.dumps(summary))
        if args.save_every_epoch and accelerator.is_main_process:
            assert target_speaker_embedding is not None
            checkpoint = output_dir / f"checkpoint-epoch-{epoch}"
            accelerator.print(f"Saving {checkpoint}")
            save_custom_voice_checkpoint(
                accelerator, model, source_model, checkpoint, args.speaker, target_speaker_embedding
            )
        accelerator.wait_for_everyone()


def re_safe_speaker(value: str) -> bool:
    import re

    return re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", value) is not None


if __name__ == "__main__":
    main()
