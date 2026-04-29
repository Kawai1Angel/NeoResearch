from __future__ import annotations

import torch
import torch.nn as nn


FAMILY_SPEC = {
    "name": "patch_mlp",
    "model_impl_entry": "model_impl.py:build_model",
    "state_dict_layout": "per_horizon",
}


class MixerBlock(nn.Module):
    def __init__(self, hidden_dim: int, dropout: float) -> None:
        super().__init__()
        self.norm = nn.LayerNorm(hidden_dim)
        self.ffn = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim * 2),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim * 2, hidden_dim),
            nn.Dropout(dropout),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return x + self.ffn(self.norm(x))


class PatchMLPModel(nn.Module):
    def __init__(
        self,
        input_len: int,
        horizon: int,
        patch_size: int,
        stride: int,
        hidden_dim: int,
        n_layers: int,
        dropout: float,
    ) -> None:
        super().__init__()
        if patch_size > input_len:
            raise ValueError(f"patch_size={patch_size} exceeds input_len={input_len}")
        if stride < 1:
            raise ValueError("stride must be >= 1")

        self.horizon = horizon
        self.patch_size = patch_size
        self.stride = stride
        self.patch_embed = nn.Linear(patch_size, hidden_dim)
        self.blocks = nn.Sequential(*[MixerBlock(hidden_dim, dropout) for _ in range(n_layers)])
        self.head = nn.Sequential(
            nn.LayerNorm(hidden_dim),
            nn.Linear(hidden_dim, horizon),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        last_value = x[:, -1:, :]
        x = x - last_value

        batch_size, seq_len, channels = x.shape
        x = x.permute(0, 2, 1).reshape(batch_size * channels, seq_len)
        patches = x.unfold(dimension=-1, size=self.patch_size, step=self.stride)
        tokens = self.patch_embed(patches)
        tokens = self.blocks(tokens)
        pooled = tokens.mean(dim=1)
        pred = self.head(pooled)
        pred = pred.reshape(batch_size, channels, self.horizon).permute(0, 2, 1)
        return pred + last_value


def build_model(model_config: dict, input_len: int, horizon: int) -> nn.Module:
    return PatchMLPModel(
        input_len=input_len,
        horizon=horizon,
        patch_size=int(model_config["patch_size"]),
        stride=int(model_config["stride"]),
        hidden_dim=int(model_config["hidden_dim"]),
        n_layers=int(model_config["n_layers"]),
        dropout=float(model_config["dropout"]),
    )
