"""TimesBlock mechanism with explicitly sample-local period selection."""
from __future__ import annotations

import torch
from torch import nn
from torch.nn import functional as F


class Inception2D(nn.Module):
    def __init__(self, in_channels: int, out_channels: int, num_kernels: int) -> None:
        super().__init__()
        self.kernels = nn.ModuleList(nn.Conv2d(in_channels, out_channels, 2 * i + 1, padding=i) for i in range(num_kernels))
        for kernel in self.kernels:
            nn.init.kaiming_normal_(kernel.weight, mode="fan_out", nonlinearity="relu")
            nn.init.zeros_(kernel.bias)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return torch.stack([kernel(x) for kernel in self.kernels], -1).mean(-1)


class TimesBlock(nn.Module):
    period_selection = "per_sample"

    def __init__(self, d_model: int, d_ff: int, top_k: int, num_kernels: int) -> None:
        super().__init__()
        self.top_k = top_k
        self.conv = nn.Sequential(Inception2D(d_model, d_ff, num_kernels), nn.GELU(), Inception2D(d_ff, d_model, num_kernels))

    def periods(self, x: torch.Tensor):
        if not 1 <= self.top_k <= x.size(1) // 2:
            raise ValueError("top_k must be between 1 and floor(history_length/2)")
        amplitudes = torch.fft.rfft(x.float(), dim=1).abs().mean(-1)
        # Stable sort makes zero/constant/tied spectra deterministic; DC excluded.
        indices = torch.argsort(amplitudes[:, 1:], dim=-1, descending=True, stable=True)[:, :self.top_k] + 1
        return x.size(1) // indices, amplitudes.gather(1, indices).softmax(-1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        periods, weights = self.periods(x)
        length, width = x.shape[1:]
        outputs = []
        for index, sample in enumerate(x.split(1)):
            branches = []
            for period_tensor in periods[index]:
                period = int(period_tensor.item())
                padded_len = ((length + period - 1) // period) * period
                padded = F.pad(sample, (0, 0, 0, padded_len - length))
                grid = padded.reshape(1, padded_len // period, period, width).permute(0, 3, 1, 2).contiguous()
                restored = self.conv(grid).permute(0, 2, 3, 1).reshape(1, padded_len, width)[:, :length]
                branches.append(restored)
            outputs.append((torch.stack(branches, -1) * weights[index].to(x.dtype)).sum(-1))
        return x + torch.cat(outputs, 0)
