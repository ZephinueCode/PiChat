from __future__ import annotations

import unittest

import torch

from losses import causal_codec_loss, parallel_codebook_loss


class LossAlignmentTests(unittest.TestCase):
    def test_ar_targets_are_shifted_exactly_once(self) -> None:
        logits = torch.full((1, 4, 5), -8.0)
        labels = torch.tensor([[-100, 1, 2, 3]])
        logits[0, 0, 1] = 8.0
        logits[0, 1, 2] = 8.0
        logits[0, 2, 3] = 8.0
        self.assertLess(float(causal_codec_loss(logits, labels)), 1e-4)

        double_shifted = logits.clone()
        double_shifted[0, 0, :] = -8.0
        double_shifted[0, 0, 2] = 8.0
        self.assertGreater(float(causal_codec_loss(double_shifted, labels)), 1.0)

    def test_sub_codebooks_are_not_time_or_group_shifted(self) -> None:
        targets = torch.tensor([[1, 2, 3]])
        logits = torch.full((1, 3, 5), -8.0)
        for group, target in enumerate(targets[0]):
            logits[0, group, target] = 8.0
        self.assertLess(float(parallel_codebook_loss(logits, targets)), 1e-4)


if __name__ == "__main__":
    unittest.main()
