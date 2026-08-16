# Adapted from QwenLM/Qwen3-TTS finetuning/dataset.py (Apache-2.0).
from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
import torch
from qwen_tts.core.models.modeling_qwen3_tts import mel_spectrogram
from torch.utils.data import Dataset


class TTSDataset(Dataset):
    def __init__(self, rows: list[dict[str, Any]], processor: Any, config: Any) -> None:
        if not rows:
            raise ValueError("Training dataset is empty.")
        self.rows = rows
        self.processor = processor
        self.config = config
        refs = {str(Path(row["ref_audio"]).resolve()) for row in rows}
        if len(refs) != 1:
            raise ValueError("All rows must use one fixed ref_audio for speaker consistency.")
        self.ref_mel = self._extract_ref_mel(next(iter(refs)))

    def __len__(self) -> int:
        return len(self.rows)

    @staticmethod
    def _load_audio(path: str) -> tuple[np.ndarray, int]:
        audio, sample_rate = sf.read(path, dtype="float32", always_2d=True)
        return audio.mean(axis=1), int(sample_rate)

    @torch.inference_mode()
    def _extract_ref_mel(self, path: str) -> torch.Tensor:
        audio, sample_rate = self._load_audio(path)
        if sample_rate != 24_000:
            raise ValueError(f"Reference audio must be 24 kHz: {path}")
        return mel_spectrogram(
            torch.from_numpy(audio).unsqueeze(0),
            n_fft=1024,
            num_mels=128,
            sampling_rate=24_000,
            hop_size=256,
            win_size=1024,
            fmin=0,
            fmax=12_000,
        ).transpose(1, 2)

    def _text_ids(self, text: str) -> torch.Tensor:
        formatted = f"<|im_start|>assistant\n{text}<|im_end|>\n<|im_start|>assistant\n"
        tokenized = self.processor(text=formatted, return_tensors="pt", padding=True)
        ids = tokenized["input_ids"]
        if ids.ndim == 1:
            ids = ids.unsqueeze(0)
        return ids[:, :-5]

    def __getitem__(self, index: int) -> dict[str, torch.Tensor]:
        row = self.rows[index]
        codes = torch.tensor(row["audio_codes"], dtype=torch.long)
        if codes.ndim != 2 or codes.shape[1] != 16:
            raise ValueError(f"Expected 16 codebooks for row {index}, got {tuple(codes.shape)}")
        return {
            "text_ids": self._text_ids(str(row["text"])),
            "audio_codes": codes,
            "ref_mel": self.ref_mel,
        }

    def collate_fn(self, batch: list[dict[str, torch.Tensor]]) -> dict[str, torch.Tensor]:
        item_lengths = [item["text_ids"].shape[1] + item["audio_codes"].shape[0] for item in batch]
        batch_size = len(batch)
        time = max(item_lengths) + 8
        input_ids = torch.zeros((batch_size, time, 2), dtype=torch.long)
        codec_ids = torch.zeros((batch_size, time, 16), dtype=torch.long)
        text_mask = torch.zeros((batch_size, time), dtype=torch.bool)
        codec_embedding_mask = torch.zeros((batch_size, time), dtype=torch.bool)
        codec_mask = torch.zeros((batch_size, time), dtype=torch.bool)
        attention_mask = torch.zeros((batch_size, time), dtype=torch.long)
        codec_0_labels = torch.full((batch_size, time), -100, dtype=torch.long)

        cfg = self.config
        talker = cfg.talker_config
        for index, item in enumerate(batch):
            text_ids = item["text_ids"]
            audio_codes = item["audio_codes"]
            codec_0 = audio_codes[:, 0]
            text_len = text_ids.shape[1]
            codec_len = codec_0.shape[0]
            codec_start = 8 + text_len - 2

            input_ids[index, :3, 0] = text_ids[0, :3]
            input_ids[index, 3:7, 0] = cfg.tts_pad_token_id
            input_ids[index, 7, 0] = cfg.tts_bos_token_id
            input_ids[index, 8 : 8 + text_len - 3, 0] = text_ids[0, 3:]
            input_ids[index, 8 + text_len - 3, 0] = cfg.tts_eos_token_id
            input_ids[index, 8 + text_len - 2 : 8 + text_len + codec_len, 0] = cfg.tts_pad_token_id
            text_mask[index, : 8 + text_len + codec_len] = True

            input_ids[index, 3:8, 1] = torch.tensor(
                [
                    talker.codec_nothink_id,
                    talker.codec_think_bos_id,
                    talker.codec_think_eos_id,
                    0,
                    talker.codec_pad_id,
                ]
            )
            input_ids[index, 8 : 8 + text_len - 2, 1] = talker.codec_pad_id
            input_ids[index, codec_start, 1] = talker.codec_bos_id
            input_ids[index, codec_start + 1 : codec_start + 1 + codec_len, 1] = codec_0
            input_ids[index, codec_start + 1 + codec_len, 1] = talker.codec_eos_token_id

            codec_0_labels[index, codec_start + 1 : codec_start + 1 + codec_len] = codec_0
            codec_0_labels[index, codec_start + 1 + codec_len] = talker.codec_eos_token_id
            codec_ids[index, codec_start + 1 : codec_start + 1 + codec_len, :] = audio_codes

            codec_embedding_mask[index, 3 : 8 + text_len + codec_len] = True
            codec_embedding_mask[index, 6] = False
            codec_mask[index, codec_start + 1 : codec_start + 1 + codec_len] = True
            attention_mask[index, : 8 + text_len + codec_len] = True

        return {
            "input_ids": input_ids,
            "ref_mels": torch.cat([item["ref_mel"] for item in batch], dim=0),
            "attention_mask": attention_mask,
            "text_embedding_mask": text_mask.unsqueeze(-1),
            "codec_embedding_mask": codec_embedding_mask.unsqueeze(-1),
            "codec_0_labels": codec_0_labels,
            "codec_ids": codec_ids,
            "codec_mask": codec_mask,
        }
