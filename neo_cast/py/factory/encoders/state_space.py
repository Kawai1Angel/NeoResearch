"""Auditable PyTorch state-space reference implementations.

Mamba1 follows the Mamba-1 block's real selective recurrence, not ZOH B.
Independent forward calls start with zero state; streaming state is explicit.
"""
from __future__ import annotations

import math
import torch
from torch import nn
from torch.nn import functional as F


class DiagonalSSM(nn.Module):
    def __init__(self, d_model: int, state_dim: int) -> None:
        super().__init__()
        self.d_model, self.state_dim = d_model, state_dim
        self.in_proj = nn.Linear(d_model, d_model)
        self.A_log = nn.Parameter(torch.arange(1, state_dim + 1).float().log().repeat(d_model, 1))
        self.dt_raw = nn.Parameter(torch.full((d_model,), -3.0))
        self.B = nn.Parameter(torch.randn(d_model, state_dim) / math.sqrt(state_dim))
        self.C = nn.Parameter(torch.randn(d_model, state_dim) / math.sqrt(state_dim))
        self.D = nn.Parameter(torch.ones(d_model))
        self.out_proj = nn.Linear(d_model, d_model)
        self.A_log._no_weight_decay = True
        self.dt_raw._no_weight_decay = True

    def forward_state(self, x: torch.Tensor, state: torch.Tensor | None = None):
        u = self.in_proj(x)
        a = -self.A_log.float().exp()
        dt = F.softplus(self.dt_raw.float())[:, None]
        z = dt * a
        abar = z.exp()
        # expm1 avoids cancellation; clamp also covers an underflowed A.
        bbar = (torch.expm1(z) / a.clamp_max(-torch.finfo(a.dtype).tiny)) * self.B.float()
        if state is None:
            state = torch.zeros(x.size(0), self.d_model, self.state_dim, device=x.device, dtype=a.dtype)
        outputs = []
        for value in u.unbind(1):
            state = abar * state + bbar * value.float().unsqueeze(-1)
            outputs.append((state * self.C.float()).sum(-1) + self.D.float() * value.float())
        return self.out_proj(torch.stack(outputs, 1).to(u.dtype)), state

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.forward_state(x)[0]


class Mamba1(nn.Module):
    """Mamba-1 CPU/device reference; canonical official parameter names."""

    backend = "torch_reference"
    variant = "mamba1"

    def __init__(self, d_model: int, d_state: int = 16, d_conv: int = 4, expand: int = 2,
                 backend: str = "torch_reference") -> None:
        super().__init__()
        if backend != "torch_reference":
            raise ValueError("UNSUPPORTED_BACKEND: Mamba CUDA backend has not been reference-verified; use torch_reference")
        self.d_model, self.d_state, self.d_conv = d_model, d_state, d_conv
        self.d_inner, self.dt_rank = d_model * expand, math.ceil(d_model / 16)
        self.in_proj = nn.Linear(d_model, 2 * self.d_inner, bias=False)
        self.conv1d = nn.Conv1d(self.d_inner, self.d_inner, d_conv, groups=self.d_inner, bias=True)
        self.x_proj = nn.Linear(self.d_inner, self.dt_rank + 2 * d_state, bias=False)
        self.dt_proj = nn.Linear(self.dt_rank, self.d_inner, bias=True)
        nn.init.uniform_(self.dt_proj.weight, -self.dt_rank ** -0.5, self.dt_rank ** -0.5)
        dt = torch.exp(torch.rand(self.d_inner) * math.log(100) + math.log(0.001))
        with torch.no_grad():
            self.dt_proj.bias.copy_(dt + torch.log(-torch.expm1(-dt)))
        self.dt_proj.bias._no_reinit = True
        self.A_log = nn.Parameter(torch.arange(1, d_state + 1).float().log().repeat(self.d_inner, 1))
        self.D = nn.Parameter(torch.ones(self.d_inner))
        self.A_log._no_weight_decay = self.D._no_weight_decay = True
        self.out_proj = nn.Linear(self.d_inner, d_model, bias=False)

    def forward_state(self, x: torch.Tensor, state=None):
        xz = self.in_proj(x)
        u, gate = xz.chunk(2, dim=-1)
        if state is None:
            conv = u.new_zeros(u.size(0), self.d_inner, self.d_conv - 1)
            hidden = torch.zeros(u.size(0), self.d_inner, self.d_state, device=x.device, dtype=torch.float32)
        else:
            conv, hidden = state
        history = torch.cat((conv, u.transpose(1, 2)), -1)
        u = F.silu(self.conv1d(history).transpose(1, 2))
        conv = history[..., -(self.d_conv - 1):] if self.d_conv > 1 else history[..., :0]
        dt, b, c = torch.split(self.x_proj(u), [self.dt_rank, self.d_state, self.d_state], -1)
        dt = F.softplus(self.dt_proj(dt).float())
        a = -self.A_log.float().exp()
        values = []
        for ut, delta, bt, ct, zt in zip(u.unbind(1), dt.unbind(1), b.unbind(1), c.unbind(1), gate.unbind(1)):
            hidden = (delta.unsqueeze(-1) * a).exp() * hidden + delta.unsqueeze(-1) * bt.float().unsqueeze(1) * ut.float().unsqueeze(-1)
            y = (hidden * ct.float().unsqueeze(1)).sum(-1) + self.D.float() * ut.float()
            values.append(y * F.silu(zt.float()))
        return self.out_proj(torch.stack(values, 1).to(xz.dtype)), (conv, hidden)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.forward_state(x)[0]
