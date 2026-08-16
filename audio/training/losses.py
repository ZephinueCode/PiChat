from __future__ import annotations

import torch
import torch.nn.functional as F


def causal_codec_loss(logits: torch.Tensor, labels: torch.Tensor) -> torch.Tensor:
    """Cross-entropy for codec-0 next-token prediction, shifted exactly once."""
    if logits.ndim != 3 or labels.ndim != 2:
        raise ValueError("Expected logits [batch, time, vocab] and labels [batch, time].")
    if logits.shape[:2] != labels.shape:
        raise ValueError("Logit and label batch/time dimensions must match.")
    return F.cross_entropy(
        logits[:, :-1, :].contiguous().view(-1, logits.shape[-1]),
        labels[:, 1:].contiguous().view(-1),
        ignore_index=-100,
    )


def parallel_codebook_loss(logits: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
    """Cross-entropy for codec groups 1..15 at the same acoustic frame."""
    if logits.ndim != 3 or targets.ndim != 2:
        raise ValueError("Expected logits [frames, groups, vocab] and targets [frames, groups].")
    if logits.shape[:2] != targets.shape:
        raise ValueError("Logit and target frame/group dimensions must match.")
    return F.cross_entropy(
        logits.contiguous().view(-1, logits.shape[-1]),
        targets.contiguous().view(-1),
    )
