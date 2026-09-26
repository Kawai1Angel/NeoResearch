"""Explicit sequence readout and channel decoding, with axis checks."""
from __future__ import annotations

import torch
from torch import nn


class SequenceReadout(nn.Module):
    def __init__(self, layout: str, readout: str, width: int, latent_dim: int, channels: int):
        super().__init__()
        self.layout, self.readout, self.channels, self.latent_dim = layout, readout, channels, latent_dim
        self.projection = nn.Linear(width, latent_dim * channels if layout == "sequence_latent" else latent_dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        expected_rank = 3 if self.layout == "sequence_latent" else 4
        if x.ndim != expected_rank:
            raise ValueError(f"{self.layout} requires rank {expected_rank}, got {tuple(x.shape)}")
        values = x.mean(-2) if self.readout == "mean" else x[..., -1, :]
        result = self.projection(values)
        return result.reshape(x.size(0), self.channels, self.latent_dim)
