from __future__ import annotations

import torch
import torch.nn as nn


FAMILY_SPEC = {
    "name": "tiny_transformer",
    "model_impl_entry": "model_impl.py:build_model",
    "state_dict_layout": "per_horizon",
}


class TinyTransformerModel(nn.Module):
    def __init__(
        self,
        input_len: int,
        horizon: int,
        d_model: int,
        n_heads: int,
        n_layers: int,
        dropout: float,
        patch_size: int = 16,
        ffn_mult: float = 4.0,
    ) -> None:
        super().__init__()
        if input_len < patch_size:
            raise ValueError(f"patch_size={patch_size} exceeds input_len={input_len}")
        if d_model % n_heads != 0:
            raise ValueError(f"d_model={d_model} must be divisible by n_heads={n_heads}")

        self.horizon = horizon
        self.patch_size = patch_size
        self.stride = patch_size
        self.num_patches = 1 + (input_len - patch_size) // self.stride

        self.patch_embed = nn.Linear(patch_size, d_model)
        self.position_embed = nn.Parameter(torch.zeros(1, self.num_patches, d_model))
        encoder_layer = nn.TransformerEncoderLayer(
            d_model=d_model,
            nhead=n_heads,
            dim_feedforward=int(d_model * ffn_mult),
            dropout=dropout,
            activation="gelu",
            batch_first=True,
            norm_first=True,
        )
        self.encoder = nn.TransformerEncoder(encoder_layer, num_layers=n_layers)
        self.head = nn.Sequential(
            nn.LayerNorm(d_model),
            nn.Linear(d_model, horizon),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        last_value = x[:, -1:, :]
        x = x - last_value

        batch_size, seq_len, channels = x.shape
        x = x.permute(0, 2, 1).reshape(batch_size * channels, seq_len)
        patches = x.unfold(dimension=-1, size=self.patch_size, step=self.stride)
        tokens = self.patch_embed(patches)
        tokens = tokens + self.position_embed[:, : tokens.size(1)]
        encoded = self.encoder(tokens)
        pooled = encoded.mean(dim=1)
        pred = self.head(pooled)
        pred = pred.reshape(batch_size, channels, self.horizon).permute(0, 2, 1)
        return pred + last_value


def build_model(model_config: dict, input_len: int, horizon: int) -> nn.Module:
    return TinyTransformerModel(
        input_len=input_len,
        horizon=horizon,
        d_model=int(model_config["d_model"]),
        n_heads=int(model_config["n_heads"]),
        n_layers=int(model_config["n_layers"]),
        dropout=float(model_config["dropout"]),
        patch_size=int(model_config.get("patch_size", 16)),
        ffn_mult=float(model_config.get("ffn_mult", 4.0)),
    )
