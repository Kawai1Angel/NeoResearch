"""Explicit sequence readout and channel decoding, with axis checks."""
from __future__ import annotations

import torch
from torch import nn


class SequenceReadout(nn.Module):
    def __init__(self, layout: str, readout: str, width: int, latent_dim: int, channels: int,
                 token_count: int | None = None):
        super().__init__()
        self.layout, self.readout, self.channels, self.latent_dim = layout, readout, channels, latent_dim
        if readout == "flatten":
            if layout != "channel_sequence" or token_count is None or token_count < 1:
                raise ValueError("flatten requires channel_sequence and a positive Patch token count")
            self.token_count, self.width = token_count, width
            self.norm = nn.LayerNorm(width)
        self.projection = nn.Linear(width * token_count if readout == "flatten" else width,
                                    latent_dim * channels if layout == "sequence_latent" else latent_dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        expected_rank = 3 if self.layout == "sequence_latent" else 4
        if x.ndim != expected_rank:
            raise ValueError(f"{self.layout} requires rank {expected_rank}, got {tuple(x.shape)}")
        if self.readout == "flatten":
            if x.shape[-2:] != (self.token_count, self.width):
                raise ValueError("Patch token count/feature width does not match the readout contract")
            values = self.norm(x).transpose(-1, -2).flatten(start_dim=-2)
        else:
            values = x.mean(-2) if self.readout == "mean" else x[..., -1, :]
        result = self.projection(values)
        return result.reshape(x.size(0), self.channels, self.latent_dim)
