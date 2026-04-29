from __future__ import annotations

import torch
import torch.nn as nn


FAMILY_SPEC = {
    "name": "nlinear",
    "model_impl_entry": "model_impl.py:build_model",
    "state_dict_layout": "per_horizon",
}


class NLinearModel(nn.Module):
    def __init__(self, input_len: int, horizon: int, residual: bool = True) -> None:
        super().__init__()
        self.horizon = horizon
        self.residual = residual
        self.linear = nn.Linear(input_len, horizon)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        last_value = x[:, -1:, :]
        if self.residual:
            x = x - last_value

        batch_size, seq_len, channels = x.shape
        x = x.permute(0, 2, 1).reshape(batch_size * channels, seq_len)
        pred = self.linear(x)
        pred = pred.reshape(batch_size, channels, self.horizon).permute(0, 2, 1)
        return pred + last_value if self.residual else pred


def build_model(model_config: dict, input_len: int, horizon: int) -> nn.Module:
    residual = bool(model_config.get("residual", True))
    return NLinearModel(input_len=input_len, horizon=horizon, residual=residual)
