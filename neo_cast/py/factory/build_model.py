from __future__ import annotations

from typing import Any

import torch
import torch.nn as nn
import torch.nn.functional as F


FAMILY_SPEC = {
    "name": "recipe_factory",
    "model_impl_entry": "model_impl.py:build_model",
    "state_dict_layout": "per_horizon",
}


def _activation(name: str | None) -> nn.Module:
    if name == "relu":
        return nn.ReLU()
    if name == "silu":
        return nn.SiLU()
    return nn.GELU()


class InstanceNormAction(nn.Module):
    def __init__(self, *, affine: bool = False, eps: float = 1e-5) -> None:
        super().__init__()
        self.affine = affine
        self.eps = eps
        if affine:
            self.scale = nn.Parameter(torch.ones(1, 1, 1))
            self.shift = nn.Parameter(torch.zeros(1, 1, 1))

    def forward_transform(self, x: torch.Tensor, contexts: list[tuple[str, Any]]) -> torch.Tensor:
        mean = x.mean(dim=1, keepdim=True)
        std = x.std(dim=1, keepdim=True, unbiased=False).clamp_min(self.eps)
        contexts.append(("instance_norm", (mean, std)))
        x = (x - mean) / std
        if self.affine:
            x = x * self.scale + self.shift
        return x

    def inverse_transform(self, y: torch.Tensor, context: Any) -> torch.Tensor:
        mean, std = context
        if self.affine:
            y = (y - self.shift) / self.scale.clamp_min(self.eps)
        return y * std + mean


class SeriesDecompositionAction(nn.Module):
    def __init__(self, *, kernel_size: int) -> None:
        super().__init__()
        if kernel_size % 2 == 0:
            kernel_size += 1
        self.kernel_size = kernel_size

    def _moving_average(self, x: torch.Tensor) -> torch.Tensor:
        pad = (self.kernel_size - 1) // 2
        values = x.permute(0, 2, 1)
        padded = F.pad(values, (pad, pad), mode="replicate")
        trend = F.avg_pool1d(padded, kernel_size=self.kernel_size, stride=1)
        return trend.permute(0, 2, 1)

    def forward_transform(self, x: torch.Tensor, contexts: list[tuple[str, Any]]) -> torch.Tensor:
        trend = self._moving_average(x)
        contexts.append(("series_decomposition", trend[:, -1:, :]))
        return x - trend

    def inverse_transform(self, y: torch.Tensor, context: Any) -> torch.Tensor:
        return y + context


class NoOpPreprocessing(nn.Module):
    def forward_transform(self, x: torch.Tensor, contexts: list[tuple[str, Any]]) -> torch.Tensor:
        return x

    def inverse_transform(self, y: torch.Tensor, context: Any) -> torch.Tensor:
        return y


class SeasonalDifferencingAction(nn.Module):
    def __init__(self, *, period: int, order: int = 1) -> None:
        super().__init__()
        if period < 1:
            raise ValueError("seasonal_differencing.period must be >= 1")
        if order < 1:
            raise ValueError("seasonal_differencing.order must be >= 1")
        self.period = period
        self.order = order

    def forward_transform(self, x: torch.Tensor, contexts: list[tuple[str, Any]]) -> torch.Tensor:
        histories: list[torch.Tensor] = []
        current = x
        for _ in range(self.order):
            period = min(self.period, current.size(1))
            histories.append(current[:, -period:, :])
            if current.size(1) <= self.period:
                current = current - current[:, -1:, :]
                continue

            diff = current.clone()
            diff[:, : self.period, :] = 0.0
            diff[:, self.period :, :] = current[:, self.period :, :] - current[:, : -self.period, :]
            current = diff
        contexts.append(("seasonal_differencing", histories))
        return current

    def inverse_transform(self, y: torch.Tensor, context: Any) -> torch.Tensor:
        current = y
        for history in reversed(context):
            period = history.size(1)
            restored_steps: list[torch.Tensor] = []
            for step in range(current.size(1)):
                if step < period:
                    base = history[:, step, :]
                else:
                    base = restored_steps[step - period]
                restored_steps.append(current[:, step, :] + base)
            current = torch.stack(restored_steps, dim=1)
        return current


class MissingMaskAction(nn.Module):
    def __init__(self, *, fill_policy: str = "zero", mask_channel: bool = False) -> None:
        super().__init__()
        self.fill_policy = fill_policy
        self.mask_channel = mask_channel

    def forward_transform(self, x: torch.Tensor, contexts: list[tuple[str, Any]]) -> torch.Tensor:
        contexts.append(("missing_mask", {"original_channels": x.size(-1)}))
        missing = torch.isnan(x)
        if not bool(missing.any()):
            filled = x
        elif self.fill_policy == "zero":
            filled = torch.nan_to_num(x, nan=0.0)
        elif self.fill_policy == "mean":
            valid = torch.where(missing, torch.zeros_like(x), x)
            counts = (~missing).sum(dim=1, keepdim=True).clamp_min(1)
            means = valid.sum(dim=1, keepdim=True) / counts
            filled = torch.where(missing, means, x)
        elif self.fill_policy == "ffill":
            first = torch.nan_to_num(x[:, :1, :], nan=0.0)
            values = [first[:, 0, :]]
            for step in range(1, x.size(1)):
                current = x[:, step, :]
                values.append(torch.where(torch.isnan(current), values[-1], current))
            filled = torch.stack(values, dim=1)
        else:
            raise ValueError(f"Unsupported missing_mask.fill_policy: {self.fill_policy}")
        if self.mask_channel:
            return torch.cat([filled, missing.to(dtype=filled.dtype)], dim=-1)
        return filled

    def inverse_transform(self, y: torch.Tensor, context: Any) -> torch.Tensor:
        if self.mask_channel:
            return y[:, :, : int(context["original_channels"])]
        return y


class SampleReweightingAction(nn.Module):
    def __init__(self, *, scheme: str = "uniform") -> None:
        super().__init__()
        self.scheme = scheme

    def forward_transform(self, x: torch.Tensor, contexts: list[tuple[str, Any]]) -> torch.Tensor:
        contexts.append(("sample_reweighting", None))
        return x

    def inverse_transform(self, y: torch.Tensor, context: Any) -> torch.Tensor:
        return y


class PatchEmbedding(nn.Module):
    def __init__(self, *, input_len: int, patch_len: int, stride: int, d_model: int) -> None:
        super().__init__()
        if patch_len > input_len:
            raise ValueError(f"patch_len={patch_len} exceeds input_len={input_len}")
        if stride < 1:
            raise ValueError("stride must be >= 1")
        if stride > patch_len:
            raise ValueError(f"stride={stride} cannot exceed patch_len={patch_len}")
        self.patch_len = patch_len
        self.stride = stride
        self.d_model = d_model
        self.proj = nn.Linear(patch_len, d_model)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        patches = x.unfold(dimension=-1, size=self.patch_len, step=self.stride)
        return self.proj(patches)


class MultiScalePatchEmbedding(nn.Module):
    def __init__(
        self,
        *,
        input_len: int,
        scales: list[dict[str, Any]],
        d_model: int,
    ) -> None:
        super().__init__()
        if len(scales) < 2:
            raise ValueError("multiscale_patch requires at least two scales")

        self.embeddings = nn.ModuleList(
            [
                PatchEmbedding(
                    input_len=input_len,
                    patch_len=int(scale["patch_len"]),
                    stride=int(scale["stride"]),
                    d_model=d_model,
                )
                for scale in scales
            ]
        )
        self.token_count = sum(
            1 + (input_len - int(scale["patch_len"])) // int(scale["stride"])
            for scale in scales
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return torch.cat([embedding(x) for embedding in self.embeddings], dim=1)


class SequenceEmbedding(nn.Module):
    def __init__(self, *, d_model: int) -> None:
        super().__init__()
        self.d_model = d_model
        self.proj = nn.Linear(1, d_model)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.proj(x.unsqueeze(-1))


class InvertEmbedding(nn.Module):
    def __init__(self, *, input_len: int, d_model: int) -> None:
        super().__init__()
        self.d_model = d_model
        self.proj = nn.Linear(input_len, d_model)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.proj(x).unsqueeze(1)


class FrequencyEmbedding(nn.Module):
    def __init__(self, *, input_len: int, n_freq: int, d_model: int, complex_mode: str = "magnitude") -> None:
        super().__init__()
        max_freq = input_len // 2 + 1
        self.n_freq = min(max(n_freq, 1), max_freq)
        self.complex_mode = complex_mode
        feature_dim = 2 if complex_mode == "real_imag" else 1
        self.proj = nn.Linear(feature_dim, d_model)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        spectrum = torch.fft.rfft(x.float(), dim=-1)[:, : self.n_freq]
        if self.complex_mode == "real_imag":
            features = torch.stack([spectrum.real, spectrum.imag], dim=-1)
        else:
            features = spectrum.abs().unsqueeze(-1)
        return self.proj(features.to(dtype=x.dtype))


class CalendarEmbedding(nn.Module):
    PERIODS = {
        "hour": 24,
        "dayofweek": 7,
        "day": 31,
        "month": 12,
        "position": 512,
    }

    def __init__(self, *, input_len: int, fields: list[str], embed_dim: int) -> None:
        super().__init__()
        self.input_len = input_len
        self.fields = fields or ["position"]
        self.proj = nn.Linear(1 + 2 * len(self.fields), embed_dim)

    def _calendar_features(self, *, device: torch.device, dtype: torch.dtype) -> torch.Tensor:
        positions = torch.arange(self.input_len, device=device, dtype=dtype)
        features: list[torch.Tensor] = []
        for field in self.fields:
            period = float(self.PERIODS.get(field, max(self.input_len, 1)))
            phase = 2.0 * torch.pi * positions / period
            features.extend([torch.sin(phase), torch.cos(phase)])
        return torch.stack(features, dim=-1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        calendar = self._calendar_features(device=x.device, dtype=x.dtype).unsqueeze(0).expand(x.size(0), -1, -1)
        return self.proj(torch.cat([x.unsqueeze(-1), calendar], dim=-1))


class ResidualMLPBlock(nn.Module):
    def __init__(self, hidden_dim: int, dropout: float, activation: str | None) -> None:
        super().__init__()
        self.norm = nn.LayerNorm(hidden_dim)
        self.ffn = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim * 2),
            _activation(activation),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim * 2, hidden_dim),
            nn.Dropout(dropout),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return x + self.ffn(self.norm(x))


class ChannelMixer(nn.Module):
    def __init__(self, num_channels: int, *, dropout: float = 0.0) -> None:
        super().__init__()
        hidden_dim = max(num_channels * 2, 4)
        self.num_channels = num_channels
        self.net = nn.Sequential(
            nn.LayerNorm(num_channels),
            nn.Linear(num_channels, hidden_dim),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim, num_channels),
            nn.Dropout(dropout),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if x.size(-1) != self.num_channels:
            raise ValueError(f"Expected {self.num_channels} channels, got {x.size(-1)}")
        return x + self.net(x)


class GraphChannelMixer(nn.Module):
    def __init__(self, num_channels: int, *, dropout: float = 0.0) -> None:
        super().__init__()
        self.num_channels = num_channels
        self.adjacency_logits = nn.Parameter(torch.eye(num_channels))
        self.proj = nn.Sequential(
            nn.LayerNorm(num_channels),
            nn.Linear(num_channels, num_channels),
            nn.Dropout(dropout),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if x.size(-1) != self.num_channels:
            raise ValueError(f"Expected {self.num_channels} channels, got {x.size(-1)}")
        adjacency = torch.softmax(self.adjacency_logits, dim=-1)
        mixed = torch.einsum("ij,btj->bti", adjacency, x)
        return x + self.proj(mixed)


class GatedHybridMixer(nn.Module):
    def __init__(self, num_channels: int, *, dropout: float = 0.0) -> None:
        super().__init__()
        self.feature_branch = ChannelMixer(num_channels, dropout=dropout)
        self.gate = nn.Sequential(
            nn.LayerNorm(num_channels),
            nn.Linear(num_channels, num_channels),
            nn.Sigmoid(),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        feature = self.feature_branch(x)
        gate = self.gate(x)
        return gate * feature + (1.0 - gate) * x


class DLinearCore(nn.Module):
    def __init__(self, *, input_len: int, horizon: int, kernel_size: int, bias: bool = True) -> None:
        super().__init__()
        if kernel_size % 2 == 0:
            kernel_size += 1
        self.kernel_size = kernel_size
        self.seasonal = nn.Linear(input_len, horizon, bias=bias)
        self.trend = nn.Linear(input_len, horizon, bias=bias)

    def _moving_average(self, x: torch.Tensor) -> torch.Tensor:
        pad = (self.kernel_size - 1) // 2
        padded = F.pad(x.unsqueeze(1), (pad, pad), mode="replicate")
        return F.avg_pool1d(padded, kernel_size=self.kernel_size, stride=1).squeeze(1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        trend = self._moving_average(x)
        seasonal = x - trend
        return self.seasonal(seasonal) + self.trend(trend)


class TemporalConvBlock(nn.Module):
    def __init__(
        self,
        *,
        in_channels: int,
        hidden_dim: int,
        kernel_size: int,
        dilation: int,
        dropout: float,
        activation: str | None,
    ) -> None:
        super().__init__()
        self.conv1 = nn.Conv1d(in_channels, hidden_dim, kernel_size=kernel_size, dilation=dilation)
        self.conv2 = nn.Conv1d(hidden_dim, hidden_dim, kernel_size=kernel_size, dilation=dilation)
        self.proj = nn.Conv1d(in_channels, hidden_dim, kernel_size=1) if in_channels != hidden_dim else nn.Identity()
        self.norm1 = nn.GroupNorm(1, hidden_dim)
        self.norm2 = nn.GroupNorm(1, hidden_dim)
        self.activation = _activation(activation)
        self.dropout = nn.Dropout(dropout)

    @staticmethod
    def _causal_conv(conv: nn.Conv1d, x: torch.Tensor) -> torch.Tensor:
        pad = (conv.kernel_size[0] - 1) * conv.dilation[0]
        return conv(F.pad(x, (pad, 0)))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        residual = self.proj(x)
        y = self._causal_conv(self.conv1, x)
        y = self.dropout(self.activation(self.norm1(y)))
        y = self._causal_conv(self.conv2, y)
        y = self.dropout(self.norm2(y))
        return self.activation(y + residual)


class TCNCore(nn.Module):
    def __init__(
        self,
        *,
        horizon: int,
        hidden_dim: int,
        n_layers: int,
        kernel_size: int,
        dropout: float,
        activation: str | None,
    ) -> None:
        super().__init__()
        layers: list[nn.Module] = []
        in_channels = 1
        for layer_index in range(n_layers):
            layers.append(
                TemporalConvBlock(
                    in_channels=in_channels,
                    hidden_dim=hidden_dim,
                    kernel_size=kernel_size,
                    dilation=2**layer_index,
                    dropout=dropout,
                    activation=activation,
                )
            )
            in_channels = hidden_dim
        self.blocks = nn.Sequential(*layers)
        self.head = nn.Sequential(nn.LayerNorm(hidden_dim), nn.Linear(hidden_dim, horizon))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        features = self.blocks(x.unsqueeze(1)).transpose(1, 2)
        return self.head(features[:, -1, :])


class NBeatsBlock(nn.Module):
    def __init__(
        self,
        *,
        input_len: int,
        horizon: int,
        hidden_dim: int,
        n_layers: int,
        dropout: float,
        activation: str | None,
    ) -> None:
        super().__init__()
        layers: list[nn.Module] = [nn.Linear(input_len, hidden_dim), _activation(activation)]
        for _ in range(max(n_layers - 1, 0)):
            layers.extend(
                [
                    nn.Dropout(dropout),
                    nn.Linear(hidden_dim, hidden_dim),
                    _activation(activation),
                ]
            )
        self.mlp = nn.Sequential(*layers)
        self.backcast = nn.Linear(hidden_dim, input_len)
        self.forecast = nn.Linear(hidden_dim, horizon)

    def forward(self, residual: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        hidden = self.mlp(residual)
        return self.backcast(hidden), self.forecast(hidden)


class NBeatsCore(nn.Module):
    def __init__(
        self,
        *,
        input_len: int,
        horizon: int,
        hidden_dim: int,
        n_blocks: int,
        n_layers: int,
        dropout: float,
        activation: str | None,
    ) -> None:
        super().__init__()
        self.blocks = nn.ModuleList(
            [
                NBeatsBlock(
                    input_len=input_len,
                    horizon=horizon,
                    hidden_dim=hidden_dim,
                    n_layers=n_layers,
                    dropout=dropout,
                    activation=activation,
                )
                for _ in range(n_blocks)
            ]
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        residual = x
        forecast = x.new_zeros(x.size(0), self.blocks[0].forecast.out_features)
        for block in self.blocks:
            backcast, block_forecast = block(residual)
            residual = residual - backcast
            forecast = forecast + block_forecast
        return forecast


class TimesBlockLite(nn.Module):
    def __init__(self, *, hidden_dim: int, top_k: int, kernel_size: int, dropout: float) -> None:
        super().__init__()
        if kernel_size % 2 == 0:
            kernel_size += 1
        self.top_k = top_k
        self.conv = nn.Sequential(
            nn.Conv2d(hidden_dim, hidden_dim, kernel_size=kernel_size, padding=kernel_size // 2),
            nn.GELU(),
            nn.Conv2d(hidden_dim, hidden_dim, kernel_size=1),
        )
        self.norm = nn.LayerNorm(hidden_dim)
        self.dropout = nn.Dropout(dropout)

    def _periods(self, x: torch.Tensor) -> list[tuple[int, torch.Tensor]]:
        spectrum = torch.fft.rfft(x.float(), dim=1)
        amplitude = spectrum.abs().mean(dim=(0, 2))
        if amplitude.numel() <= 1:
            return [(1, x.new_tensor(1.0))]
        amplitude = amplitude.clone()
        amplitude[0] = 0.0
        k = min(self.top_k, amplitude.numel() - 1)
        values, indices = torch.topk(amplitude[1:], k=k)
        frequencies = indices + 1
        weights = torch.softmax(values, dim=0)
        periods: list[tuple[int, torch.Tensor]] = []
        length = x.size(1)
        for frequency, weight in zip(frequencies, weights):
            period = max(length // int(frequency.item()), 1)
            periods.append((period, weight.to(dtype=x.dtype, device=x.device)))
        return periods

    def _period_conv(self, x: torch.Tensor, period: int) -> torch.Tensor:
        batch_size, length, hidden_dim = x.shape
        target_len = ((length + period - 1) // period) * period
        pad_len = target_len - length
        padded = F.pad(x, (0, 0, 0, pad_len)) if pad_len else x
        grid = padded.reshape(batch_size, target_len // period, period, hidden_dim).permute(0, 3, 1, 2)
        y = self.conv(grid).permute(0, 2, 3, 1).reshape(batch_size, target_len, hidden_dim)
        return y[:, :length, :]

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        mixed = x.new_zeros(x.shape)
        for period, weight in self._periods(x):
            mixed = mixed + self._period_conv(x, period) * weight
        return x + self.dropout(self.norm(mixed))


class TimesNetLiteCore(nn.Module):
    def __init__(
        self,
        *,
        input_len: int,
        horizon: int,
        hidden_dim: int,
        n_layers: int,
        top_k: int,
        kernel_size: int,
        dropout: float,
    ) -> None:
        super().__init__()
        self.input_proj = nn.Linear(1, hidden_dim)
        self.blocks = nn.ModuleList(
            [
                TimesBlockLite(hidden_dim=hidden_dim, top_k=top_k, kernel_size=kernel_size, dropout=dropout)
                for _ in range(n_layers)
            ]
        )
        self.norm = nn.LayerNorm(hidden_dim)
        self.temporal_head = nn.Linear(input_len, horizon)
        self.output_proj = nn.Linear(hidden_dim, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        tokens = self.input_proj(x.unsqueeze(-1))
        for block in self.blocks:
            tokens = block(tokens)
        tokens = self.norm(tokens)
        forecast_tokens = self.temporal_head(tokens.transpose(1, 2)).transpose(1, 2)
        return self.output_proj(forecast_tokens).squeeze(-1)


class SSMTokenBlock(nn.Module):
    def __init__(self, *, hidden_dim: int, kernel_size: int, dropout: float) -> None:
        super().__init__()
        if kernel_size % 2 == 0:
            kernel_size += 1
        self.norm = nn.LayerNorm(hidden_dim)
        self.depthwise = nn.Conv1d(
            hidden_dim,
            hidden_dim,
            kernel_size=kernel_size,
            padding=kernel_size // 2,
            groups=hidden_dim,
        )
        self.gate = nn.Linear(hidden_dim, hidden_dim)
        self.out = nn.Linear(hidden_dim, hidden_dim)
        self.dropout = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        residual = x
        y = self.norm(x)
        y = self.depthwise(y.transpose(1, 2)).transpose(1, 2)
        y = torch.tanh(y) * torch.sigmoid(self.gate(y))
        return residual + self.dropout(self.out(y))


class TokenMixerBlock(nn.Module):
    def __init__(self, *, token_count: int, hidden_dim: int, dropout: float, activation: str | None) -> None:
        super().__init__()
        self.token_norm = nn.LayerNorm(hidden_dim)
        self.token_mlp = nn.Sequential(
            nn.Linear(token_count, token_count),
            _activation(activation),
            nn.Dropout(dropout),
            nn.Linear(token_count, token_count),
            nn.Dropout(dropout),
        )
        self.feature_norm = nn.LayerNorm(hidden_dim)
        self.feature_mlp = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim * 2),
            _activation(activation),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim * 2, hidden_dim),
            nn.Dropout(dropout),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y = self.token_norm(x).transpose(1, 2)
        x = x + self.token_mlp(y).transpose(1, 2)
        return x + self.feature_mlp(self.feature_norm(x))


class ResidualCorrectionHead(nn.Module):
    def __init__(self, *, horizon: int, correction_dim: int, dropout: float = 0.0) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.LayerNorm(horizon),
            nn.Linear(horizon, correction_dim),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(correction_dim, horizon),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return x + self.net(x)


class QuantilePointHead(nn.Module):
    def __init__(self, *, horizon: int, quantiles: list[float]) -> None:
        super().__init__()
        self.quantiles = quantiles or [0.5]
        self.proj = nn.Linear(1, len(self.quantiles))
        self.point_index = min(range(len(self.quantiles)), key=lambda idx: abs(self.quantiles[idx] - 0.5))

    def forward_quantiles(self, x: torch.Tensor) -> torch.Tensor:
        return self.proj(x.unsqueeze(-1))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        quantile_values = self.forward_quantiles(x)
        return quantile_values[:, :, self.point_index]


class GaussianPointHead(nn.Module):
    def __init__(self, *, horizon: int, variance_floor: float = 1e-6) -> None:
        super().__init__()
        self.mean = nn.Linear(horizon, horizon)
        self.log_var = nn.Linear(horizon, horizon)
        self.variance_floor = variance_floor

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        _ = F.softplus(self.log_var(x)) + self.variance_floor
        return self.mean(x)


class RecipeModel(nn.Module):
    def __init__(
        self,
        recipe: dict[str, Any],
        input_len: int,
        horizon: int,
        *,
        num_channels: int | None = None,
    ) -> None:
        super().__init__()
        self.recipe = recipe
        self.input_len = input_len
        self.horizon = horizon

        self.preprocessing = nn.ModuleList(self._build_preprocessing(recipe))
        self.embedding_cfg = recipe["embedding"]
        self.backbone_cfg = recipe["backbone"]
        self.fusion_cfg = recipe["fusion"]
        self.head_cfg = recipe["prediction_head"]
        self.backbone_type = self.backbone_cfg["type"]
        self.embedding_type = self.embedding_cfg["type"]
        self.fusion_type = self.fusion_cfg.get("type", "temporal")
        self.channel_mode = self.fusion_cfg.get("channel_mode", "independent")
        self.num_channels = num_channels
        self.model_num_channels = self._effective_num_channels(num_channels)
        self.channel_mixer, self.output_mixer = self._build_fusion_modules()

        if self.backbone_type == "linear":
            self.model = self._build_linear_model()
        elif self.backbone_type == "mlp":
            self.model = self._build_mlp_model()
        elif self.backbone_type == "transformer":
            self.model = self._build_transformer_model()
        elif self.backbone_type == "dlinear":
            self.model = self._build_dlinear_model()
        elif self.backbone_type == "tcn":
            self.model = self._build_tcn_model()
        elif self.backbone_type == "nbeats":
            self.model = self._build_nbeats_model()
        elif self.backbone_type == "timesnet":
            self.model = self._build_timesnet_model()
        elif self.backbone_type == "rnn":
            self.model = self._build_rnn_model()
        elif self.backbone_type == "ssm":
            self.model = self._build_ssm_model()
        elif self.backbone_type == "mixer":
            self.model = self._build_mixer_model()
        else:
            raise ValueError(f"Unsupported backbone type: {self.backbone_type}")
        self.prediction_head = self._build_prediction_head()

    def _require_num_channels(self, reason: str) -> int:
        if self.model_num_channels is None:
            raise ValueError(f"{reason} requires model_config.num_channels")
        return int(self.model_num_channels)

    def _effective_num_channels(self, num_channels: int | None) -> int | None:
        if num_channels is None:
            return None
        multiplier = 1
        for action in self.recipe.get("preprocessing", {}).get("actions", []):
            if action.get("type") == "missing_mask" and bool(action.get("mask_channel", False)):
                multiplier += 1
        return int(num_channels) * multiplier

    def _build_fusion_modules(self) -> tuple[nn.Module, nn.Module]:
        if self.fusion_type == "temporal":
            if self.channel_mode == "independent":
                return nn.Identity(), nn.Identity()
            if self.channel_mode == "shared":
                channels = self._require_num_channels("fusion.channel_mode='shared'")
                dropout = float(self.backbone_cfg.get("dropout", 0.0))
                return ChannelMixer(channels, dropout=dropout), nn.Identity()
            raise ValueError(f"Unsupported fusion channel_mode: {self.channel_mode}")

        dropout = float(self.backbone_cfg.get("dropout", 0.0))
        channels = self._require_num_channels(f"fusion.type='{self.fusion_type}'")
        if self.fusion_type in {"feature", "feature_then_temporal"}:
            return ChannelMixer(channels, dropout=dropout), nn.Identity()
        if self.fusion_type == "temporal_then_feature":
            return nn.Identity(), ChannelMixer(channels, dropout=dropout)
        if self.fusion_type == "graph":
            return GraphChannelMixer(channels, dropout=dropout), nn.Identity()
        if self.fusion_type == "gated_hybrid":
            return GatedHybridMixer(channels, dropout=dropout), nn.Identity()
        raise ValueError(f"Unsupported fusion type: {self.fusion_type}")

    def _build_channel_mixer(self) -> nn.Module:
        if self.channel_mode == "independent":
            return nn.Identity()
        if self.channel_mode == "shared":
            if self.num_channels is None:
                raise ValueError("fusion.channel_mode='shared' requires model_config.num_channels")
            dropout = float(self.backbone_cfg.get("dropout", 0.0))
            return ChannelMixer(int(self.num_channels), dropout=dropout)
        raise ValueError(f"Unsupported fusion channel_mode: {self.channel_mode}")

    def _build_preprocessing(self, recipe: dict[str, Any]) -> list[nn.Module]:
        modules: list[nn.Module] = []
        for action in recipe.get("preprocessing", {}).get("actions", [{"type": "none"}]):
            action_type = action["type"]
            if action_type == "none":
                modules.append(NoOpPreprocessing())
            elif action_type == "instance_norm":
                modules.append(
                    InstanceNormAction(
                        affine=bool(action.get("affine", False)),
                        eps=float(action.get("eps", 1e-5)),
                    )
                )
            elif action_type == "series_decomposition":
                modules.append(SeriesDecompositionAction(kernel_size=int(action["kernel_size"])))
            elif action_type == "seasonal_differencing":
                modules.append(
                    SeasonalDifferencingAction(
                        period=int(action["period"]),
                        order=int(action.get("order", 1)),
                    )
                )
            elif action_type == "missing_mask":
                modules.append(
                    MissingMaskAction(
                        fill_policy=str(action.get("fill_policy", "zero")),
                        mask_channel=bool(action.get("mask_channel", False)),
                    )
                )
            elif action_type == "sample_reweighting":
                modules.append(SampleReweightingAction(scheme=str(action.get("scheme", "uniform"))))
            else:
                raise ValueError(f"Unsupported preprocessing action: {action_type}")
        return modules

    def _embedding_d_model(self) -> int:
        if self.embedding_type == "calendar":
            return int(self.embedding_cfg["embed_dim"])
        return int(self.embedding_cfg["d_model"])

    def _embedding_token_count(self) -> int:
        if self.embedding_type == "patch":
            patch_len = int(self.embedding_cfg["patch_len"])
            stride = int(self.embedding_cfg["stride"])
            return 1 + (self.input_len - patch_len) // stride
        if self.embedding_type == "multiscale_patch":
            return sum(
                1 + (self.input_len - int(scale["patch_len"])) // int(scale["stride"])
                for scale in self.embedding_cfg["scales"]
            )
        if self.embedding_type == "invert":
            return 1
        if self.embedding_type == "frequency":
            return min(int(self.embedding_cfg["n_freq"]), self.input_len // 2 + 1)
        if self.embedding_type == "calendar":
            return self.input_len
        return self.input_len

    def _build_temporal_embedding(self, d_model: int | None = None) -> nn.Module:
        if self.embedding_type == "patch":
            return PatchEmbedding(
                input_len=self.input_len,
                patch_len=int(self.embedding_cfg["patch_len"]),
                stride=int(self.embedding_cfg["stride"]),
                d_model=d_model or self._embedding_d_model(),
            )
        if self.embedding_type == "multiscale_patch":
            return MultiScalePatchEmbedding(
                input_len=self.input_len,
                scales=self.embedding_cfg["scales"],
                d_model=d_model or self._embedding_d_model(),
            )
        if self.embedding_type == "invert":
            return InvertEmbedding(input_len=self.input_len, d_model=d_model or self._embedding_d_model())
        if self.embedding_type == "frequency":
            return FrequencyEmbedding(
                input_len=self.input_len,
                n_freq=int(self.embedding_cfg["n_freq"]),
                d_model=d_model or self._embedding_d_model(),
                complex_mode=str(self.embedding_cfg.get("complex_mode", "magnitude")),
            )
        if self.embedding_type == "calendar":
            return CalendarEmbedding(
                input_len=self.input_len,
                fields=list(self.embedding_cfg.get("fields", ["position"])),
                embed_dim=d_model or self._embedding_d_model(),
            )
        raise ValueError(f"Unsupported temporal embedding type: {self.embedding_type}")

    def _build_linear_model(self) -> nn.Module:
        if self.embedding_type == "none":
            return nn.Linear(self.input_len, self.horizon, bias=bool(self.backbone_cfg.get("bias", True)))

        d_model = self._embedding_d_model()
        return nn.Sequential(
            self._build_temporal_embedding(d_model),
            nn.Flatten(start_dim=1),
            nn.Linear(self._embedding_token_count() * d_model, self.horizon),
        )

    def _build_mlp_model(self) -> nn.Module:
        depth = int(self.backbone_cfg["depth"])
        hidden_dim = int(self.backbone_cfg["hidden_dim"])
        dropout = float(self.backbone_cfg["dropout"])
        activation = self.backbone_cfg.get("activation", "gelu")

        if self.embedding_type == "none":
            layers: list[nn.Module] = [nn.Linear(self.input_len, hidden_dim), _activation(activation)]
            for _ in range(max(depth - 1, 0)):
                layers.extend(
                    [
                        nn.Dropout(dropout),
                        nn.Linear(hidden_dim, hidden_dim),
                        _activation(activation),
                    ]
                )
            layers.extend([nn.Dropout(dropout), nn.Linear(hidden_dim, self.horizon)])
            return nn.Sequential(*layers)

        return nn.ModuleDict(
            {
                "embedding": self._build_temporal_embedding(self._embedding_d_model()),
                "input_proj": nn.Linear(self._embedding_d_model(), hidden_dim),
                "blocks": nn.Sequential(
                    *[ResidualMLPBlock(hidden_dim, dropout, activation) for _ in range(depth)]
                ),
                "head": nn.Sequential(nn.LayerNorm(hidden_dim), nn.Linear(hidden_dim, self.horizon)),
            }
        )

    def _build_transformer_model(self) -> nn.Module:
        d_model = int(self.backbone_cfg["d_model"])
        n_heads = int(self.backbone_cfg["n_heads"])
        if d_model % n_heads != 0:
            raise ValueError(f"d_model={d_model} must be divisible by n_heads={n_heads}")

        if self.embedding_type == "none":
            embedding = SequenceEmbedding(d_model=d_model)
            token_count = self.input_len
        else:
            embedding: nn.Module = self._build_temporal_embedding(d_model)
            token_count = self._embedding_token_count()

        encoder_layer = nn.TransformerEncoderLayer(
            d_model=d_model,
            nhead=n_heads,
            dim_feedforward=int(d_model * float(self.backbone_cfg.get("ffn_mult", 4.0))),
            dropout=float(self.backbone_cfg["dropout"]),
            activation="gelu",
            batch_first=True,
            norm_first=True,
        )
        return nn.ModuleDict(
            {
                "embedding": embedding,
                "position": nn.ParameterDict(
                    {"weight": nn.Parameter(torch.zeros(1, token_count, d_model))}
                ),
                "encoder": nn.TransformerEncoder(
                    encoder_layer,
                    num_layers=int(self.backbone_cfg["n_layers"]),
                ),
                "head": nn.Sequential(nn.LayerNorm(d_model), nn.Linear(d_model, self.horizon)),
            }
        )

    def _require_raw_embedding(self, backbone_type: str) -> None:
        if self.embedding_type != "none":
            raise ValueError(f"backbone.type='{backbone_type}' requires embedding.type='none'")

    def _build_dlinear_model(self) -> nn.Module:
        self._require_raw_embedding("dlinear")
        return DLinearCore(
            input_len=self.input_len,
            horizon=self.horizon,
            kernel_size=int(self.backbone_cfg["kernel_size"]),
            bias=bool(self.backbone_cfg.get("bias", True)),
        )

    def _build_tcn_model(self) -> nn.Module:
        self._require_raw_embedding("tcn")
        return TCNCore(
            horizon=self.horizon,
            hidden_dim=int(self.backbone_cfg["hidden_dim"]),
            n_layers=int(self.backbone_cfg["n_layers"]),
            kernel_size=int(self.backbone_cfg["kernel_size"]),
            dropout=float(self.backbone_cfg["dropout"]),
            activation=self.backbone_cfg.get("activation", "gelu"),
        )

    def _build_nbeats_model(self) -> nn.Module:
        self._require_raw_embedding("nbeats")
        return NBeatsCore(
            input_len=self.input_len,
            horizon=self.horizon,
            hidden_dim=int(self.backbone_cfg["hidden_dim"]),
            n_blocks=int(self.backbone_cfg["n_blocks"]),
            n_layers=int(self.backbone_cfg["n_layers"]),
            dropout=float(self.backbone_cfg["dropout"]),
            activation=self.backbone_cfg.get("activation", "gelu"),
        )

    def _build_timesnet_model(self) -> nn.Module:
        self._require_raw_embedding("timesnet")
        return TimesNetLiteCore(
            input_len=self.input_len,
            horizon=self.horizon,
            hidden_dim=int(self.backbone_cfg["hidden_dim"]),
            n_layers=int(self.backbone_cfg["n_layers"]),
            top_k=int(self.backbone_cfg["top_k"]),
            kernel_size=int(self.backbone_cfg["kernel_size"]),
            dropout=float(self.backbone_cfg["dropout"]),
        )

    def _build_token_embedding_stack(self, hidden_dim: int) -> tuple[nn.Module, int, int]:
        if self.embedding_type == "none":
            return SequenceEmbedding(d_model=hidden_dim), hidden_dim, self.input_len
        return self._build_temporal_embedding(self._embedding_d_model()), self._embedding_d_model(), self._embedding_token_count()

    def _build_rnn_model(self) -> nn.Module:
        hidden_dim = int(self.backbone_cfg["hidden_dim"])
        embedding, token_dim, _ = self._build_token_embedding_stack(hidden_dim)
        cell = str(self.backbone_cfg.get("cell", "gru")).lower()
        num_layers = int(self.backbone_cfg.get("num_layers", self.backbone_cfg.get("n_layers", 1)))
        dropout = float(self.backbone_cfg.get("dropout", 0.0))
        rnn_dropout = dropout if num_layers > 1 else 0.0
        if cell == "lstm":
            rnn: nn.Module = nn.LSTM(token_dim, hidden_dim, num_layers=num_layers, dropout=rnn_dropout, batch_first=True)
        elif cell == "rnn":
            rnn = nn.RNN(token_dim, hidden_dim, num_layers=num_layers, dropout=rnn_dropout, batch_first=True)
        elif cell == "gru":
            rnn = nn.GRU(token_dim, hidden_dim, num_layers=num_layers, dropout=rnn_dropout, batch_first=True)
        else:
            raise ValueError(f"Unsupported rnn.cell: {cell}")
        return nn.ModuleDict(
            {
                "embedding": embedding,
                "rnn": rnn,
                "head": nn.Sequential(nn.LayerNorm(hidden_dim), nn.Linear(hidden_dim, self.horizon)),
            }
        )

    def _build_ssm_model(self) -> nn.Module:
        state_dim = int(self.backbone_cfg["state_dim"])
        embedding, token_dim, _ = self._build_token_embedding_stack(state_dim)
        dropout = float(self.backbone_cfg.get("dropout", 0.0))
        kernel_size = int(self.backbone_cfg.get("kernel_size", 5))
        depth = int(self.backbone_cfg.get("depth", 1))
        return nn.ModuleDict(
            {
                "embedding": embedding,
                "input_proj": nn.Identity() if token_dim == state_dim else nn.Linear(token_dim, state_dim),
                "blocks": nn.Sequential(
                    *[SSMTokenBlock(hidden_dim=state_dim, kernel_size=kernel_size, dropout=dropout) for _ in range(depth)]
                ),
                "head": nn.Sequential(nn.LayerNorm(state_dim), nn.Linear(state_dim, self.horizon)),
            }
        )

    def _build_mixer_model(self) -> nn.Module:
        hidden_dim = int(self.backbone_cfg["hidden_dim"])
        embedding, token_dim, token_count = self._build_token_embedding_stack(hidden_dim)
        depth = int(self.backbone_cfg.get("depth", self.backbone_cfg.get("n_layers", 1)))
        dropout = float(self.backbone_cfg.get("dropout", 0.0))
        activation = self.backbone_cfg.get("activation", "gelu")
        return nn.ModuleDict(
            {
                "embedding": embedding,
                "input_proj": nn.Identity() if token_dim == hidden_dim else nn.Linear(token_dim, hidden_dim),
                "blocks": nn.Sequential(
                    *[
                        TokenMixerBlock(
                            token_count=token_count,
                            hidden_dim=hidden_dim,
                            dropout=dropout,
                            activation=activation,
                        )
                        for _ in range(depth)
                    ]
                ),
                "head": nn.Sequential(nn.LayerNorm(hidden_dim), nn.Linear(hidden_dim, self.horizon)),
            }
        )

    def _build_prediction_head(self) -> nn.Module:
        head_type = self.head_cfg["type"]
        if head_type in {"linear", "direct_multi_horizon"}:
            return nn.Identity()
        if head_type == "residual_correction":
            return ResidualCorrectionHead(
                horizon=self.horizon,
                correction_dim=int(self.head_cfg.get("correction_dim", max(self.horizon, 8))),
                dropout=float(self.backbone_cfg.get("dropout", 0.0)),
            )
        if head_type == "quantile":
            return QuantilePointHead(
                horizon=self.horizon,
                quantiles=[float(value) for value in self.head_cfg.get("quantiles", [0.5])],
            )
        if head_type == "gaussian":
            return GaussianPointHead(
                horizon=self.horizon,
                variance_floor=float(self.head_cfg.get("variance_floor", 1e-6)),
            )
        raise ValueError(f"Unsupported prediction head type: {head_type}")

    def _prepare_flat_series(
        self,
        x: torch.Tensor,
    ) -> tuple[torch.Tensor, int, int, torch.Tensor, list[tuple[str, Any]]]:
        contexts: list[tuple[str, Any]] = []
        for module in self.preprocessing:
            x = module.forward_transform(x, contexts)

        x = self.channel_mixer(x)
        last_value = x[:, -1:, :]
        series = x - last_value
        batch_size, seq_len, channels = series.shape
        flat = series.permute(0, 2, 1).reshape(batch_size * channels, seq_len)
        return flat, batch_size, channels, last_value, contexts

    def _restore_point_forecast(
        self,
        flat_pred: torch.Tensor,
        *,
        batch_size: int,
        channels: int,
        last_value: torch.Tensor,
        contexts: list[tuple[str, Any]],
    ) -> torch.Tensor:
        pred = flat_pred.reshape(batch_size, channels, self.horizon).permute(0, 2, 1)
        y = pred + last_value
        y = self.output_mixer(y)
        for module, (_, context) in zip(reversed(self.preprocessing), reversed(contexts)):
            y = module.inverse_transform(y, context)
        return y

    def _apply_output_mixer_quantiles(self, y: torch.Tensor) -> torch.Tensor:
        if isinstance(self.output_mixer, nn.Identity):
            return y
        return torch.stack([self.output_mixer(y[..., index]) for index in range(y.size(-1))], dim=-1)

    def _inverse_quantile_forecast(
        self,
        y: torch.Tensor,
        contexts: list[tuple[str, Any]],
    ) -> torch.Tensor:
        for module, (_, context) in zip(reversed(self.preprocessing), reversed(contexts)):
            y = torch.stack([module.inverse_transform(y[..., index], context) for index in range(y.size(-1))], dim=-1)
        return y

    def _restore_quantile_forecast(
        self,
        flat_quantiles: torch.Tensor,
        *,
        batch_size: int,
        channels: int,
        last_value: torch.Tensor,
        contexts: list[tuple[str, Any]],
    ) -> torch.Tensor:
        quantiles = flat_quantiles.reshape(batch_size, channels, self.horizon, flat_quantiles.size(-1))
        y = quantiles.permute(0, 2, 1, 3) + last_value.unsqueeze(-1)
        y = self._apply_output_mixer_quantiles(y)
        return self._inverse_quantile_forecast(y, contexts)

    def _forward_core(self, series: torch.Tensor) -> torch.Tensor:
        if self.backbone_type == "linear":
            return self.model(series)

        if self.backbone_type in {"dlinear", "tcn", "nbeats", "timesnet"}:
            return self.model(series)

        if self.backbone_type == "mlp" and self.embedding_type == "none":
            return self.model(series)

        if self.backbone_type == "mlp":
            modules = self.model
            tokens = modules["embedding"](series)
            tokens = modules["input_proj"](tokens)
            tokens = modules["blocks"](tokens)
            pooled = tokens.mean(dim=1)
            return modules["head"](pooled)

        if self.backbone_type == "rnn":
            modules = self.model
            tokens = modules["embedding"](series)
            encoded, _ = modules["rnn"](tokens)
            return modules["head"](encoded[:, -1, :])

        if self.backbone_type == "ssm":
            modules = self.model
            tokens = modules["input_proj"](modules["embedding"](series))
            tokens = modules["blocks"](tokens)
            return modules["head"](tokens.mean(dim=1))

        if self.backbone_type == "mixer":
            modules = self.model
            tokens = modules["input_proj"](modules["embedding"](series))
            tokens = modules["blocks"](tokens)
            return modules["head"](tokens.mean(dim=1))

        modules = self.model
        tokens = modules["embedding"](series)
        position = modules["position"]["weight"][:, : tokens.size(1), :]
        encoded = modules["encoder"](tokens + position)
        pooled = encoded.mean(dim=1)
        return modules["head"](pooled)

    def forward_quantiles(self, x: torch.Tensor) -> torch.Tensor:
        flat, batch_size, channels, last_value, contexts = self._prepare_flat_series(x)
        base_pred = self._forward_core(flat)
        if hasattr(self.prediction_head, "forward_quantiles"):
            quantiles = self.prediction_head.forward_quantiles(base_pred)
        else:
            quantiles = self.prediction_head(base_pred).unsqueeze(-1)
        return self._restore_quantile_forecast(
            quantiles,
            batch_size=batch_size,
            channels=channels,
            last_value=last_value,
            contexts=contexts,
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        flat, batch_size, channels, last_value, contexts = self._prepare_flat_series(x)
        pred = self._forward_core(flat)
        pred = self.prediction_head(pred)
        return self._restore_point_forecast(
            pred,
            batch_size=batch_size,
            channels=channels,
            last_value=last_value,
            contexts=contexts,
        )


def _extract_recipe(model_config: dict[str, Any]) -> dict[str, Any]:
    recipe = model_config.get("recipe", model_config)
    if not isinstance(recipe, dict):
        raise ValueError("recipe_factory requires model_config.recipe")
    if recipe.get("recipe_version") != "recipe_schema_v1":
        raise ValueError("recipe_factory requires recipe_version='recipe_schema_v1'")
    return recipe


def build_model(model_config: dict[str, Any], input_len: int, horizon: int) -> nn.Module:
    num_channels = model_config.get("num_channels")
    return RecipeModel(
        _extract_recipe(model_config),
        input_len=input_len,
        horizon=horizon,
        num_channels=int(num_channels) if num_channels is not None else None,
    )
