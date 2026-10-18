from __future__ import annotations

from typing import Any
import hashlib
import json

import torch
import torch.nn as nn
import torch.nn.functional as F


FAMILY_SPEC = {
    "name": "recipe_factory",
    "model_impl_entry": "model_impl.py:build_model",
    "state_dict_layout": "per_horizon",
}

RUNTIME_SEMANTICS_REVISION = 2


def parameter_graph_digest(model: nn.Module) -> str:
    """Portable structural signature used by training and standalone exports."""
    keys = ("p", "residual", "gate_type", "source", "sparsity", "stride", "eps", "mask_channel", "scheme")
    if getattr(model, "runtime_semantics_revision", 2) >= 3:
        keys += ("layout", "readout", "top_k", "variant", "backend", "period_selection")
    graph = {"modules": [[name, type(module).__name__] for name, module in model.named_modules()],
             "parameters": {name: list(p.shape) for name, p in model.named_parameters()},
             "semantics": {name: {key: getattr(module, key) for key in keys
                                   if isinstance(getattr(module, key, None), (bool, int, float, str, tuple))}
                           for name, module in model.named_modules()}}
    return hashlib.sha256(json.dumps(graph, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

ACTION_FIELDS = {
    "preprocessing": {
        "none": [
            "type"
        ],
        "instance_norm": [
            "type",
            "affine",
            "eps"
        ],
        "series_decomposition": [
            "type",
            "method",
            "kernel_size"
        ],
        "seasonal_differencing": [
            "type",
            "period",
            "order"
        ],
        "missing_mask": [
            "type",
            "mask_channel"
        ],
        "sample_reweighting": [
            "type",
            "scheme"
        ],
        "last_value_centering": [
            "type"
        ]
    },
    "embedding": {
        "none": [
            "type"
        ],
        "patch": [
            "type",
            "patch_len",
            "stride",
            "d_model"
        ],
        "multiscale_patch": [
            "type",
            "scales",
            "d_model",
            "num_blocks"
        ],
        "invert": [
            "type",
            "d_model"
        ],
        "frequency": [
            "type",
            "n_freq",
            "d_model",
            "complex_mode"
        ],
        "calendar": [
            "type",
            "fields",
            "embed_dim"
        ]
    },
    "backbone": {
        "linear": [
            "type",
            "shared",
            "bias",
            "attention"
        ],
        "mlp": [
            "type",
            "depth",
            "hidden_dim",
            "activation",
            "dropout",
            "attention"
        ],
        "transformer": [
            "type",
            "d_model",
            "n_heads",
            "n_layers",
            "ffn_mult",
            "dropout",
            "attention"
        ],
        "rnn": [
            "type",
            "cell",
            "hidden_dim",
            "num_layers",
            "dropout",
            "attention"
        ],
        "dlinear": [
            "type",
            "kernel_size",
            "bias",
            "individual",
            "attention"
        ],
        "tcn": [
            "type",
            "hidden_dim",
            "n_layers",
            "kernel_size",
            "activation",
            "dropout",
            "attention"
        ],
        "nbeats": [
            "type",
            "hidden_dim",
            "n_blocks",
            "n_layers",
            "activation",
            "dropout",
            "attention"
        ],
        "timesnet_lite": [
            "type",
            "hidden_dim",
            "n_layers",
            "top_k",
            "kernel_size",
            "dropout",
            "attention"
        ],
        "gated_depthwise_conv": [
            "type",
            "hidden_dim",
            "depth",
            "kernel_size",
            "dropout",
            "attention"
        ],
        "mixer": [
            "type",
            "hidden_dim",
            "depth",
            "temporal_mixing",
            "channel_mixing",
            "dropout",
            "activation",
            "attention"
        ]
    },
    "fusion": {
        "temporal": [
            "type",
            "channel_mode"
        ],
        "variate_attention": [
            "type"
        ],
        "temporal_then_feature": [
            "type",
            "gate",
            "residual"
        ],
        "feature_then_temporal": [
            "type",
            "gate",
            "residual"
        ],
        "graph": [
            "type",
            "adjacency_source",
            "sparsity",
            "topology_artifact"
        ],
        "gated_hybrid": [
            "type",
            "gate_type"
        ],
        "feature_mlp": [
            "type"
        ]
    },
    "prediction_head": {
        "linear": [
            "type",
            "output_distribution"
        ],
        "quantile": [
            "type",
            "output_distribution",
            "quantiles"
        ],
        "gaussian": [
            "type",
            "output_distribution",
            "variance_floor"
        ],
        "residual_correction": [
            "type",
            "output_distribution",
            "correction_dim"
        ]
    }
}


def _activation(name: str | None) -> nn.Module:
    if name == "relu":
        return nn.ReLU()
    if name == "silu":
        return nn.SiLU()
    return nn.GELU()


class InstanceNormAction(nn.Module):
    def __init__(self, *, affine: bool = False, eps: float = 1e-5, num_channels: int = 1) -> None:
        super().__init__()
        self.affine = affine
        self.eps = eps
        if affine:
            self.scale = nn.Parameter(torch.ones(1, 1, num_channels))
            self.shift = nn.Parameter(torch.zeros(1, 1, num_channels))

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
            y = (y - self.shift) / self.safe_scale()
        return y * std + mean

    def safe_scale(self) -> torch.Tensor:
        return torch.where(self.scale >= 0, self.scale.clamp_min(self.eps), self.scale.clamp_max(-self.eps))


class LastValueCenteringAction(nn.Module):
    def forward_transform(self, x: torch.Tensor, contexts: list[tuple[str, Any]]) -> torch.Tensor:
        location = x[:, -1:, :]
        contexts.append(("last_value_centering", location))
        return x - location

    def inverse_transform(self, y: torch.Tensor, context: Any) -> torch.Tensor:
        return y + context


class SeriesDecompositionAction(nn.Module):
    def __init__(self, *, kernel_size: int, input_len: int | None = None, horizon: int | None = None) -> None:
        super().__init__()
        self.kernel_size = kernel_size
        self.trend_model = nn.Linear(input_len, horizon) if input_len is not None and horizon is not None else None

    def _moving_average(self, x: torch.Tensor) -> torch.Tensor:
        pad = (self.kernel_size - 1) // 2
        values = x.permute(0, 2, 1)
        padded = F.pad(values, (pad, self.kernel_size - 1 - pad), mode="replicate")
        trend = F.avg_pool1d(padded, kernel_size=self.kernel_size, stride=1)
        return trend.permute(0, 2, 1)

    def forward_transform(self, x: torch.Tensor, contexts: list[tuple[str, Any]]) -> torch.Tensor:
        trend = self._moving_average(x)
        if self.trend_model is None:
            raise ValueError("Decomposition requires input_len and horizon for its trainable trend branch")
        contexts.append(("series_decomposition", self.trend_model(trend.transpose(1, 2)).transpose(1, 2)))
        return x - trend

    def inverse_transform(self, y: torch.Tensor, context: Any) -> torch.Tensor:
        return y + context


class NoOpPreprocessing(nn.Module):
    def forward_transform(self, x: torch.Tensor, contexts: list[tuple[str, Any]]) -> torch.Tensor:
        contexts.append(("none", None))
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
    def __init__(self, *, mask_channel: bool = True) -> None:
        super().__init__()
        self.mask_channel = mask_channel

    def forward_transform(self, x: torch.Tensor, contexts: list[tuple[str, Any]], original_mask: torch.Tensor | None = None) -> torch.Tensor:
        contexts.append(("missing_mask", {"original_channels": x.size(-1)}))
        missing = torch.isnan(x)
        if original_mask is not None:
            if original_mask.shape != x.shape or not torch.all((original_mask == 0) | (original_mask == 1)):
                raise ValueError("missing_mask must be binary and match history [B,T,C]")
            missing = missing | original_mask.bool()
            # Dataset-level imputation already ran. The mask must not trigger a second fill.
            filled = torch.nan_to_num(x, nan=0.0)
            return torch.cat([filled, missing.to(x.dtype)], dim=-1) if self.mask_channel else filled
        if not bool(missing.any()):
            filled = x
        else:
            filled = torch.nan_to_num(x, nan=0.0)
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


class PatchFlattenReadout(nn.Module):
    """Normalize token features, then retain feature-major token positions."""

    def __init__(self, width: int, token_count: int, latent_dim: int) -> None:
        super().__init__()
        if token_count < 1:
            raise ValueError("Patch readout requires at least one token")
        self.width, self.token_count = width, token_count
        self.norm = nn.LayerNorm(width)
        self.projection = nn.Linear(width * token_count, latent_dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if x.ndim < 3 or x.shape[-2:] != (self.token_count, self.width):
            raise ValueError(f"Patch readout requires [...,{self.token_count},{self.width}], got {tuple(x.shape)}")
        return self.projection(self.norm(x).transpose(-1, -2).flatten(start_dim=-2))


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
        num_blocks: int = 1,
        dropout: float = 0.0,
    ) -> None:
        super().__init__()
        if not scales:
            raise ValueError("multiscale_patch requires at least one scale")
        if num_blocks < 1:
            raise ValueError("multiscale_patch num_blocks must be >= 1")

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
        self.scale_embeddings = nn.ParameterList(
            [nn.Parameter(torch.zeros(1, 1, d_model)) for _ in scales]
        )
        self.blocks = nn.ModuleList(
            [MultiScalePatchBlock(d_model, len(scales), dropout=dropout) for _ in range(num_blocks)]
        )
        self.token_count = sum(
            1 + (input_len - int(scale["patch_len"])) // int(scale["stride"])
            for scale in scales
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        branches = [
            embedding(x) + scale_embedding
            for embedding, scale_embedding in zip(self.embeddings, self.scale_embeddings)
        ]
        for block in self.blocks:
            branches = block(branches)
        return torch.cat(branches, dim=1)


class MultiScalePatchBlock(nn.Module):
    """Process each resolution independently, then exchange pooled scale context."""

    def __init__(self, d_model: int, num_scales: int, *, dropout: float = 0.0) -> None:
        super().__init__()
        self.branch_norms = nn.ModuleList([nn.LayerNorm(d_model) for _ in range(num_scales)])
        self.branch_mlps = nn.ModuleList(
            [
                nn.Sequential(
                    nn.Linear(d_model, d_model * 2),
                    nn.GELU(),
                    nn.Dropout(dropout),
                    nn.Linear(d_model * 2, d_model),
                    nn.Dropout(dropout),
                )
                for _ in range(num_scales)
            ]
        )
        heads = next(candidate for candidate in (4, 2, 1) if d_model % candidate == 0)
        self.scale_norm = nn.LayerNorm(d_model)
        self.scale_attention = nn.MultiheadAttention(
            d_model,
            heads,
            dropout=dropout,
            batch_first=True,
        )
        self.dropout = nn.Dropout(dropout)

    def forward(self, branches: list[torch.Tensor]) -> list[torch.Tensor]:
        local = [
            branch + mlp(norm(branch))
            for branch, norm, mlp in zip(branches, self.branch_norms, self.branch_mlps)
        ]
        summaries = torch.stack([branch.mean(dim=1) for branch in local], dim=1)
        normalized = self.scale_norm(summaries)
        cross_scale = self.scale_attention(normalized, normalized, normalized, need_weights=False)[0]
        return [
            branch + self.dropout(cross_scale[:, index : index + 1, :])
            for index, branch in enumerate(local)
        ]


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
        if x.dim() != 3:
            raise ValueError("invert requires [batch, variables, history] input")
        return self.proj(x)


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

    def _calendar_features(self, values: torch.Tensor) -> torch.Tensor:
        # Input columns: hour, dayofweek, day (1-based), month (1-based).
        columns = {"hour": 0, "dayofweek": 1, "day": 2, "month": 3}
        features: list[torch.Tensor] = []
        for field in self.fields:
            if field == "position":
                phase = 2.0 * torch.pi * torch.arange(values.size(1), device=values.device, dtype=values.dtype) / self.input_len
                features.extend([phase.sin().expand(values.size(0), -1), phase.cos().expand(values.size(0), -1)])
                continue
            if field not in columns:
                raise ValueError(f"Unsupported real calendar field: {field}")
            value = values[..., columns[field]] - (1 if field in {"day", "month"} else 0)
            phase = 2.0 * torch.pi * value / float(self.PERIODS[field])
            features.extend([torch.sin(phase), torch.cos(phase)])
        return torch.stack(features, dim=-1)

    def forward(self, x: torch.Tensor, calendar_features: torch.Tensor | None = None) -> torch.Tensor:
        if calendar_features is None or calendar_features.shape != (*x.shape, 4):
            raise ValueError("calendar embedding requires real calendar_features [batch, history, 4]")
        calendar = self._calendar_features(calendar_features.to(device=x.device, dtype=x.dtype))
        return self.proj(torch.cat([x.unsqueeze(-1), calendar], dim=-1))


class ResidualMLPBlock(nn.Module):
    def __init__(self, hidden_dim: int, dropout: float, activation: str | None, expansion: float = 2.0) -> None:
        super().__init__()
        self.norm = nn.LayerNorm(hidden_dim)
        self.ffn = nn.Sequential(
            nn.Linear(hidden_dim, int(hidden_dim * expansion)),
            _activation(activation),
            nn.Dropout(dropout),
            nn.Linear(int(hidden_dim * expansion), hidden_dim),
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
    def __init__(self, num_channels: int, *, dropout: float = 0.0, source: str = "learned", adjacency: list[list[float]] | None = None, sparsity: float = 0.0) -> None:
        super().__init__()
        self.num_channels = num_channels
        self.source = source
        self.sparsity = sparsity
        if source == "learned":
            self.adjacency_logits = nn.Parameter(torch.eye(num_channels))
        else:
            if adjacency is None:
                raise ValueError(f"graph.{source} requires a fitted/persisted adjacency")
            matrix = torch.tensor(adjacency, dtype=torch.float32)
            if matrix.shape != (num_channels, num_channels) or not torch.isfinite(matrix).all():
                raise ValueError("graph adjacency must be a finite C x C matrix in input channel order")
            self.register_buffer("adjacency", matrix)
        self.proj = nn.Sequential(
            nn.LayerNorm(num_channels),
            nn.Linear(num_channels, num_channels),
            nn.Dropout(dropout),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if x.size(-1) != self.num_channels:
            raise ValueError(f"Expected {self.num_channels} channels, got {x.size(-1)}")
        adjacency = self.matrix()
        mixed = torch.einsum("ij,btj->bti", adjacency, x)
        return x + self.proj(mixed)

    def matrix(self) -> torch.Tensor:
        matrix = self.adjacency_logits.softmax(dim=-1) if self.source == "learned" else self.adjacency
        keep = max(1, round(self.num_channels * (1 - self.sparsity)))
        if keep < self.num_channels:
            indices = matrix.abs().topk(keep, dim=-1).indices
            matrix = matrix * torch.zeros_like(matrix).scatter(-1, indices, 1)
        return matrix / matrix.abs().sum(dim=-1, keepdim=True).clamp_min(1e-8)


class DLinearCore(nn.Module):
    def __init__(
        self,
        *,
        input_len: int,
        horizon: int,
        kernel_size: int,
        bias: bool = True,
        individual: bool = False,
        num_channels: int | None = None,
    ) -> None:
        super().__init__()
        self.kernel_size = kernel_size
        self.individual = bool(individual)
        self.num_channels = int(num_channels or 0)
        if self.individual:
            if self.num_channels <= 0:
                raise ValueError("DLinear individual=True requires num_channels")
            self.seasonal_layers = nn.ModuleList(
                [nn.Linear(input_len, horizon, bias=bias) for _ in range(self.num_channels)]
            )
            self.trend_layers = nn.ModuleList(
                [nn.Linear(input_len, horizon, bias=bias) for _ in range(self.num_channels)]
            )
        else:
            self.seasonal = nn.Linear(input_len, horizon, bias=bias)
            self.trend = nn.Linear(input_len, horizon, bias=bias)

    def _moving_average(self, x: torch.Tensor) -> torch.Tensor:
        pad = (self.kernel_size - 1) // 2
        padded = F.pad(x.unsqueeze(1), (pad, self.kernel_size - 1 - pad), mode="replicate")
        return F.avg_pool1d(padded, kernel_size=self.kernel_size, stride=1).squeeze(1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        trend = self._moving_average(x)
        seasonal = x - trend
        if self.individual:
            if x.size(0) % self.num_channels != 0:
                raise ValueError(
                    f"DLinear individual=True expected batch*channels rows divisible by {self.num_channels}, "
                    f"got {x.size(0)}"
                )
            batch_size = x.size(0) // self.num_channels
            seasonal_by_channel = seasonal.reshape(batch_size, self.num_channels, seasonal.size(-1))
            trend_by_channel = trend.reshape(batch_size, self.num_channels, trend.size(-1))
            outputs = [
                self.seasonal_layers[index](seasonal_by_channel[:, index, :])
                + self.trend_layers[index](trend_by_channel[:, index, :])
                for index in range(self.num_channels)
            ]
            return torch.stack(outputs, dim=1).reshape(x.size(0), -1)
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
        input_channels: int = 1,
        token_count: int | None = None,
    ) -> None:
        super().__init__()
        layers: list[nn.Module] = []
        in_channels = input_channels
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
        self.patch_tokens = token_count
        self.head = (PatchFlattenReadout(hidden_dim, token_count, horizon) if token_count is not None
                     else nn.Sequential(nn.LayerNorm(hidden_dim), nn.Linear(hidden_dim, horizon)))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        features = self.blocks(x.unsqueeze(1) if self.patch_tokens is None else x.transpose(1, 2)).transpose(1, 2)
        return self.head(features[:, -1, :] if self.patch_tokens is None else features)


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
        self.kernel_size = kernel_size
        self.top_k = top_k
        self.conv = nn.Sequential(
            nn.Conv2d(hidden_dim, hidden_dim, kernel_size=kernel_size, padding=kernel_size // 2 if kernel_size % 2 else 0),
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
        if self.kernel_size % 2 == 0:
            left = (self.kernel_size - 1) // 2
            right = self.kernel_size - 1 - left
            grid = F.pad(grid, (left, right, left, right))
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


class GatedDepthwiseConvBlock(nn.Module):
    def __init__(self, *, hidden_dim: int, kernel_size: int, dropout: float) -> None:
        super().__init__()
        self.kernel_size = kernel_size
        self.norm = nn.LayerNorm(hidden_dim)
        self.depthwise = nn.Conv1d(
            hidden_dim,
            hidden_dim,
            kernel_size=kernel_size,
            padding=kernel_size // 2 if kernel_size % 2 else 0,
            groups=hidden_dim,
        )
        self.gate = nn.Linear(hidden_dim, hidden_dim)
        self.out = nn.Linear(hidden_dim, hidden_dim)
        self.dropout = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        residual = x
        y = self.norm(x)
        y = y.transpose(1, 2)
        if self.kernel_size % 2 == 0:
            left = (self.kernel_size - 1) // 2
            y = F.pad(y, (left, self.kernel_size - 1 - left))
        y = self.depthwise(y).transpose(1, 2)
        y = torch.tanh(y) * torch.sigmoid(self.gate(y))
        return residual + self.dropout(self.out(y))


class TokenMixerBlock(nn.Module):
    def __init__(
        self,
        *,
        token_count: int,
        hidden_dim: int,
        dropout: float,
        activation: str | None,
        temporal_mixing: str = "mlp",
        channel_mixing: str = "mlp",
    ) -> None:
        super().__init__()
        self.token_norm = nn.LayerNorm(hidden_dim)
        if temporal_mixing == "mlp":
            self.token_mixer = nn.Sequential(
                nn.Linear(token_count, token_count),
                _activation(activation),
                nn.Dropout(dropout),
                nn.Linear(token_count, token_count),
                nn.Dropout(dropout),
            )
        elif temporal_mixing == "conv":
            kernel_size = 3
            self.token_mixer = nn.Sequential(
                nn.Conv1d(hidden_dim, hidden_dim, kernel_size=kernel_size, padding=kernel_size // 2, groups=hidden_dim),
                _activation(activation),
                nn.Dropout(dropout),
            )
        else:
            raise ValueError(f"Unsupported mixer.temporal_mixing: {temporal_mixing}")

        self.feature_norm = nn.LayerNorm(hidden_dim)
        if channel_mixing == "mlp":
            self.feature_mlp = nn.Sequential(
                nn.Linear(hidden_dim, hidden_dim * 2),
                _activation(activation),
                nn.Dropout(dropout),
                nn.Linear(hidden_dim * 2, hidden_dim),
                nn.Dropout(dropout),
            )
        elif channel_mixing == "identity":
            self.feature_mlp = nn.Identity()
        else:
            raise ValueError(f"Unsupported mixer.channel_mixing: {channel_mixing}")

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y = self.token_norm(x).transpose(1, 2)
        x = x + self.token_mixer(y).transpose(1, 2)
        return x if isinstance(self.feature_mlp, nn.Identity) else x + self.feature_mlp(self.feature_norm(x))


class LinearHead(nn.Linear):
    """The sole latent-to-horizon projection for a point forecast."""


class IdentityForecastHead(nn.Identity):
    """Pass an already horizon-sized forecast through without parameters."""


class ChannelLinear(nn.Module):
    def __init__(self, input_dim: int, output_dim: int, channels: int, bias: bool) -> None:
        super().__init__()
        self.layers = nn.ModuleList([nn.Linear(input_dim, output_dim, bias=bias) for _ in range(channels)])

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        values = x.reshape(-1, len(self.layers), x.size(-1))
        return torch.stack([layer(values[:, i]) for i, layer in enumerate(self.layers)], dim=1).reshape(-1, self.layers[0].out_features)


class OrderedChannelMixer(nn.Module):
    def __init__(self, channels: int, *, gate: bool, residual: bool, dropout: float) -> None:
        super().__init__()
        self.branch = ChannelMixer(channels, dropout=dropout).net
        self.gate = nn.Sequential(nn.Linear(channels, channels), nn.Sigmoid()) if gate else None
        self.residual = residual

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        branch = self.branch(x)
        if self.gate is not None:
            gate = self.gate(x)
            return gate * branch + ((1 - gate) * x if self.residual else 0)
        return branch + (x if self.residual else 0)


class VariateAttention(nn.Module):
    def __init__(self, width: int) -> None:
        super().__init__()
        self.attention = nn.MultiheadAttention(width, 1, batch_first=True)
        self.norm = nn.LayerNorm(width)

    def forward(self, latent: torch.Tensor) -> torch.Tensor:
        tokens = self.norm(latent)
        return latent + self.attention(tokens, tokens, tokens, need_weights=False)[0]


class HybridLatentFusion(nn.Module):
    def __init__(self, input_len: int, channels: int, width: int, gate_type: str, dropout: float) -> None:
        super().__init__()
        self.gate_type = gate_type
        self.feature_mixer = ChannelMixer(channels, dropout=dropout)
        self.feature_encoder = nn.Sequential(nn.Linear(input_len, width), nn.GELU())
        if gate_type == "learned":
            self.gate_logits = nn.Parameter(torch.zeros(1, channels, 1))
        elif gate_type == "scalar":
            self.gate = nn.Linear(input_len * channels, 1)
        elif gate_type == "channel":
            self.gate = nn.Linear(input_len, 1)
        elif gate_type == "time":
            self.gate = nn.Linear(channels, 1)
        else:
            raise ValueError(f"Unsupported gate_type: {gate_type}")

    def forward(self, history: torch.Tensor, temporal: torch.Tensor) -> torch.Tensor:
        feature = self.feature_encoder(self.feature_mixer(history).transpose(1, 2))
        if self.gate_type == "learned":
            gate = self.gate_logits.sigmoid()
        elif self.gate_type == "scalar":
            gate = self.gate(history.flatten(1)).sigmoid().unsqueeze(-1)
        elif self.gate_type == "channel":
            gate = self.gate(history.transpose(1, 2)).sigmoid()
        else:
            gate = self.gate(history).sigmoid().mean(dim=1, keepdim=True)
        return gate * temporal + (1 - gate) * feature


class ResidualCorrectionHead(nn.Module):
    def __init__(self, *, horizon: int, correction_dim: int, latent_dim: int, dropout: float = 0.0) -> None:
        super().__init__()
        self.base = LinearHead(latent_dim, horizon)
        self.net = nn.Sequential(
            nn.LayerNorm(latent_dim),
            nn.Linear(latent_dim, correction_dim),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(correction_dim, horizon),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.base(x) + self.net(x)


class QuantilePointHead(nn.Module):
    def __init__(self, *, horizon: int, quantiles: list[float], latent_dim: int) -> None:
        super().__init__()
        self.quantiles = quantiles or [0.5]
        self.horizon = horizon
        self.proj = nn.Linear(latent_dim, horizon * len(self.quantiles))
        self.point_index = min(range(len(self.quantiles)), key=lambda idx: abs(self.quantiles[idx] - 0.5))

    def forward_quantiles(self, x: torch.Tensor) -> torch.Tensor:
        return self.proj(x).reshape(*x.shape[:-1], self.horizon, len(self.quantiles))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        quantile_values = self.forward_quantiles(x)
        return quantile_values[:, :, self.point_index]


class GaussianPointHead(nn.Module):
    def __init__(self, *, horizon: int, latent_dim: int, variance_floor: float = 1e-6) -> None:
        super().__init__()
        self.mean = nn.Linear(latent_dim, horizon)
        self.log_var = nn.Linear(latent_dim, horizon)
        self.variance_floor = variance_floor
        self.quantiles = [0.1, 0.5, 0.9]

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.mean(x)

    def forward_distribution(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        return self.mean(x), (F.softplus(self.log_var(x)) + self.variance_floor).sqrt()


class TokenAttention(nn.Module):
    """Residual token attention: full softmax or linear-complexity positive features."""

    def __init__(self, width: int, heads: int, mode: str, dropout: float = 0.0) -> None:
        super().__init__()
        if width % heads:
            raise ValueError("attention width must be divisible by heads")
        self.mode, self.heads = mode, heads
        self.norm = nn.Identity() if mode == "none" else nn.LayerNorm(width)
        if mode == "full":
            self.attention = nn.MultiheadAttention(width, heads, dropout=dropout, batch_first=True)
        elif mode == "lightweight":
            self.qkv = nn.Linear(width, width * 3)
            self.proj = nn.Linear(width, width)
        elif mode != "none":
            raise ValueError(f"Unknown attention mode: {mode}")
        self.dropout = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if self.mode == "none":
            return x
        z = self.norm(x)
        if self.mode == "full":
            y = self.attention(z, z, z, need_weights=False)[0]
        else:
            b, n, d = z.shape
            q, k, v = self.qkv(z).reshape(b, n, 3, self.heads, d // self.heads).permute(2, 0, 3, 1, 4)
            q, k = F.elu(q) + 1, F.elu(k) + 1
            kv = k.transpose(-2, -1) @ v
            denominator = (q * k.sum(dim=-2, keepdim=True)).sum(dim=-1, keepdim=True).clamp_min(1e-6)
            y = self.proj(((q @ kv) / denominator).transpose(1, 2).reshape(b, n, d))
        return x + self.dropout(y)


class RecipeModel(nn.Module):
    def __init__(
        self,
        recipe: dict[str, Any],
        input_len: int,
        horizon: int,
        *,
        num_channels: int | None = None,
        num_target_channels: int | None = None,
        num_past_covariate_channels: int = 0,
        num_future_covariate_channels: int = 0,
        num_output_channels: int | None = None,
        graph_adjacency: list[list[float]] | None = None,
    ) -> None:
        super().__init__()
        self.recipe = recipe
        self.input_len = input_len
        self.horizon = horizon
        self.latent_dim = int(recipe.get("representation", {}).get("latent_dim", min(input_len, 64)))
        self.runtime_semantics_revision = 3 if recipe.get("recipe_version") == "recipe_schema_v3" else RUNTIME_SEMANTICS_REVISION
        self.embedding_cfg = recipe["embedding"]
        self.backbone_cfg = recipe["backbone"]
        self.fusion_cfg = recipe["fusion"]
        self.head_cfg = recipe["prediction_head"]
        self.backbone_type = self.backbone_cfg["type"]
        self.embedding_type = self.embedding_cfg["type"]
        self.fusion_type = self.fusion_cfg.get("type", "temporal")
        self.channel_mode = self.fusion_cfg.get("channel_mode", "independent")
        self.num_channels = num_channels
        self.num_target_channels = int(num_target_channels if num_target_channels is not None else num_channels or 0)
        self.num_past_covariate_channels = int(num_past_covariate_channels)
        self.num_future_covariate_channels = int(num_future_covariate_channels)
        if self.num_future_covariate_channels:
            raise ValueError("UNSUPPORTED_COVARIATE: num_future_covariate_channels must be zero")
        self.num_output_channels = int(num_output_channels if num_output_channels is not None else self.num_target_channels)
        self.model_num_channels = self._effective_num_channels(num_channels)
        self.preprocessing = nn.ModuleList(self._build_preprocessing(recipe))
        self.uses_missing_mask = any(isinstance(module, MissingMaskAction) for module in self.preprocessing)
        self.graph_adjacency = graph_adjacency
        self.channel_mixer, self.output_mixer = self._build_fusion_modules()
        self.latent_mixer: nn.Module = nn.Identity()
        if self.fusion_type == "variate_attention":
            self.latent_mixer = VariateAttention(self.latent_dim)
        elif self.fusion_type == "temporal_then_feature":
            self.latent_mixer = OrderedChannelMixer(self._require_num_channels("ordered fusion"), gate=self.fusion_cfg.get("gate", False), residual=self.fusion_cfg.get("residual", False), dropout=float(self.backbone_cfg.get("dropout", 0)))
        elif self.fusion_type == "gated_hybrid":
            self.latent_mixer = HybridLatentFusion(input_len, self._require_num_channels("hybrid fusion"), self.latent_dim, self.fusion_cfg.get("gate_type", "channel"), float(self.backbone_cfg.get("dropout", 0)))

        if self.backbone_type in {"diagonal_ssm", "timesblock_encoder", "mamba"}:
            self.model = self._build_sequence_model()
        elif self.backbone_type == "linear":
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
        elif self.backbone_type == "timesnet_lite":
            self.model = self._build_timesnet_model()
        elif self.backbone_type == "rnn":
            self.model = self._build_rnn_model()
        elif self.backbone_type == "gated_depthwise_conv":
            self.model = self._build_gated_depthwise_conv_model()
        elif self.backbone_type == "mixer":
            self.model = self._build_mixer_model()
        else:
            raise ValueError(f"Unsupported backbone type: {self.backbone_type}")
        self.prediction_head = self._build_prediction_head()
        attention = self.backbone_cfg.get("attention", "none")
        self.input_attention = None
        if self.backbone_type != "transformer" and attention != "none":
            width = int(self.backbone_cfg.get("hidden_dim", 64))
            self.input_attention = nn.Sequential(nn.Linear(1, width), TokenAttention(width, 1, attention), nn.Linear(width, 1))

    def _require_num_channels(self, reason: str) -> int:
        if self.model_num_channels is None:
            raise ValueError(f"{reason} requires model_config.num_channels")
        return int(self.model_num_channels)

    def _effective_num_channels(self, num_channels: int | None) -> int | None:
        if num_channels is None:
            return None
        multiplier = 1
        for action in self.recipe.get("preprocessing", {}).get("actions", []):
            if action.get("type") == "missing_mask" and bool(action.get("mask_channel", True)):
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
        if self.fusion_type == "feature_mlp":
            return ChannelMixer(channels, dropout=dropout), nn.Identity()
        if self.fusion_type == "feature_then_temporal":
            return OrderedChannelMixer(channels, gate=self.fusion_cfg.get("gate", False), residual=self.fusion_cfg.get("residual", False), dropout=dropout), nn.Identity()
        if self.fusion_type in {"temporal_then_feature", "variate_attention", "gated_hybrid"}:
            return nn.Identity(), nn.Identity()
        if self.fusion_type == "graph":
            return GraphChannelMixer(channels, dropout=dropout, adjacency=self.graph_adjacency, source=self.fusion_cfg.get("adjacency_source", "learned"), sparsity=float(self.fusion_cfg.get("sparsity", 0))), nn.Identity()
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
        channels = self.num_channels
        for action in recipe.get("preprocessing", {}).get("actions", [{"type": "none"}]):
            action_type = action["type"]
            if action_type == "none":
                modules.append(NoOpPreprocessing())
            elif action_type == "last_value_centering":
                modules.append(LastValueCenteringAction())
            elif action_type == "instance_norm":
                if action.get("affine") and channels is None:
                    raise ValueError("affine instance_norm requires num_channels")
                modules.append(
                    InstanceNormAction(
                        affine=bool(action.get("affine", False)),
                        eps=float(action.get("eps", 1e-5)),
                        num_channels=channels or 1,
                    )
                )
            elif action_type == "series_decomposition":
                modules.append(SeriesDecompositionAction(kernel_size=int(action["kernel_size"]), input_len=self.input_len, horizon=self.horizon))
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
                        mask_channel=bool(action.get("mask_channel", True)),
                    )
                )
                if action.get("mask_channel", True) and channels is not None:
                    channels *= 2
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
            return self._require_num_channels("invert embedding")
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
                num_blocks=int(self.embedding_cfg.get("num_blocks", 1)),
                dropout=float(self.backbone_cfg.get("dropout", 0.0)),
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
        def projection(width: int) -> nn.Module:
            bias = bool(self.backbone_cfg.get("bias", True))
            if self.backbone_cfg.get("shared", True):
                return nn.Linear(width, self.latent_dim, bias=bias)
            return ChannelLinear(width, self.latent_dim, self._require_num_channels("linear.shared=false"), bias)
        if self.embedding_type == "invert":
            return nn.Sequential(self._build_temporal_embedding(), projection(self._embedding_d_model()))
        if self.embedding_type == "none":
            return projection(self.input_len)

        d_model = self._embedding_d_model()
        return nn.Sequential(
            self._build_temporal_embedding(d_model),
            nn.Flatten(start_dim=1),
            projection(self._embedding_token_count() * d_model),
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
            layers.extend([nn.Dropout(dropout), nn.Linear(hidden_dim, self.latent_dim)])
            return nn.Sequential(*layers)

        return nn.ModuleDict(
            {
                "embedding": self._build_temporal_embedding(self._embedding_d_model()),
                "input_proj": nn.Linear(self._embedding_d_model(), hidden_dim),
                "blocks": nn.Sequential(
                    *[ResidualMLPBlock(hidden_dim, dropout, activation) for _ in range(depth)]
                ),
                "head": (PatchFlattenReadout(hidden_dim, self._embedding_token_count(), self.latent_dim)
                         if self.embedding_type in {"patch", "multiscale_patch"}
                         else nn.Sequential(nn.LayerNorm(hidden_dim), nn.Linear(hidden_dim, self.latent_dim))),
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
                ) if self.embedding_type != "invert" else nn.Identity(),
                "encoder": nn.TransformerEncoder(
                    encoder_layer,
                    num_layers=int(self.backbone_cfg["n_layers"]),
                ) if self.backbone_cfg.get("attention", "full") == "full" else nn.Sequential(*[
                    nn.Sequential(TokenAttention(d_model, n_heads, self.backbone_cfg["attention"], float(self.backbone_cfg["dropout"])), ResidualMLPBlock(d_model, float(self.backbone_cfg["dropout"]), "gelu", float(self.backbone_cfg.get("ffn_mult", 4.0))))
                    for _ in range(int(self.backbone_cfg["n_layers"]))
                ]),
                "head": (PatchFlattenReadout(d_model, token_count, self.latent_dim)
                         if self.embedding_type in {"patch", "multiscale_patch"}
                         else nn.Sequential(nn.LayerNorm(d_model), nn.Linear(d_model, self.latent_dim))),
            }
        )

    def _require_raw_embedding(self, backbone_type: str) -> None:
        if self.embedding_type != "none":
            raise ValueError(f"backbone.type='{backbone_type}' requires embedding.type='none'")

    def _build_dlinear_model(self) -> nn.Module:
        self._require_raw_embedding("dlinear")
        return DLinearCore(
            input_len=self.input_len,
            horizon=self.latent_dim,
            kernel_size=int(self.backbone_cfg["kernel_size"]),
            bias=bool(self.backbone_cfg.get("bias", True)),
            individual=bool(self.backbone_cfg.get("individual", False)),
            num_channels=self.model_num_channels,
        )

    def _build_tcn_model(self) -> nn.Module:
        if self.embedding_type not in {"none", "patch", "multiscale_patch"}:
            raise ValueError("backbone.type='tcn' supports embedding none, patch or multiscale_patch")
        patched = self.embedding_type != "none"
        core = TCNCore(
            horizon=self.latent_dim,
            hidden_dim=int(self.backbone_cfg["hidden_dim"]),
            n_layers=int(self.backbone_cfg["n_layers"]),
            kernel_size=int(self.backbone_cfg["kernel_size"]),
            dropout=float(self.backbone_cfg["dropout"]),
            activation=self.backbone_cfg.get("activation", "gelu"),
            input_channels=self._embedding_d_model() if patched else 1,
            token_count=self._embedding_token_count() if patched else None,
        )
        return nn.Sequential(self._build_temporal_embedding(), core) if patched else core

    def _build_nbeats_model(self) -> nn.Module:
        self._require_raw_embedding("nbeats")
        return NBeatsCore(
            input_len=self.input_len,
            horizon=self.latent_dim,
            hidden_dim=int(self.backbone_cfg["hidden_dim"]),
            n_blocks=int(self.backbone_cfg["n_blocks"]),
            n_layers=int(self.backbone_cfg["n_layers"]),
            dropout=float(self.backbone_cfg["dropout"]),
            activation=self.backbone_cfg.get("activation", "gelu"),
        )

    def _build_timesnet_model(self) -> nn.Module:
        self._require_raw_embedding("timesnet_lite")
        return TimesNetLiteCore(
            input_len=self.input_len,
            horizon=self.latent_dim,
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
                "head": nn.Sequential(nn.LayerNorm(hidden_dim), nn.Dropout(dropout), nn.Linear(hidden_dim, self.latent_dim)),
            }
        )

    def _build_gated_depthwise_conv_model(self) -> nn.Module:
        hidden_dim = int(self.backbone_cfg["hidden_dim"])
        embedding, token_dim, _ = self._build_token_embedding_stack(hidden_dim)
        dropout = float(self.backbone_cfg.get("dropout", 0.0))
        kernel_size = int(self.backbone_cfg.get("kernel_size", 5))
        depth = int(self.backbone_cfg.get("depth", 1))
        return nn.ModuleDict(
            {
                "embedding": embedding,
                "input_proj": nn.Identity() if token_dim == hidden_dim else nn.Linear(token_dim, hidden_dim),
                "blocks": nn.Sequential(
                    *[GatedDepthwiseConvBlock(hidden_dim=hidden_dim, kernel_size=kernel_size, dropout=dropout) for _ in range(depth)]
                ),
                "head": nn.Sequential(nn.LayerNorm(hidden_dim), nn.Linear(hidden_dim, self.latent_dim)),
            }
        )

    def _build_mixer_model(self) -> nn.Module:
        hidden_dim = int(self.backbone_cfg["hidden_dim"])
        embedding, token_dim, token_count = self._build_token_embedding_stack(hidden_dim)
        depth = int(self.backbone_cfg.get("depth", self.backbone_cfg.get("n_layers", 1)))
        dropout = float(self.backbone_cfg.get("dropout", 0.0))
        activation = self.backbone_cfg.get("activation", "gelu")
        temporal_mixing = str(self.backbone_cfg.get("temporal_mixing", "mlp"))
        channel_mixing = str(self.backbone_cfg.get("channel_mixing", "mlp"))
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
                            temporal_mixing=temporal_mixing,
                            channel_mixing=channel_mixing,
                        )
                        for _ in range(depth)
                    ]
                ),
                "head": nn.Sequential(nn.LayerNorm(hidden_dim), nn.Linear(hidden_dim, self.latent_dim)),
            }
        )

    def _build_prediction_head(self) -> nn.Module:
        head_type = self.head_cfg["type"]
        if head_type == "identity":
            if self.recipe.get("recipe_version") != "recipe_schema_v3":
                raise ValueError("prediction_head.identity requires recipe_schema_v3")
            if self.latent_dim != self.horizon:
                raise ValueError("prediction_head.identity requires representation.latent_dim equal to the forecast horizon")
            return IdentityForecastHead()
        if head_type == "linear":
            return LinearHead(self.latent_dim, self.horizon)
        if head_type == "residual_correction":
            return ResidualCorrectionHead(
                latent_dim=self.latent_dim,
                horizon=self.horizon,
                correction_dim=int(self.head_cfg.get("correction_dim", max(self.horizon, 8))),
                dropout=float(self.backbone_cfg.get("dropout", 0.0)),
            )
        if head_type == "quantile":
            return QuantilePointHead(
                latent_dim=self.latent_dim,
                horizon=self.horizon,
                quantiles=[float(value) for value in self.head_cfg.get("quantiles", [0.5])],
            )
        if head_type == "gaussian":
            return GaussianPointHead(
                latent_dim=self.latent_dim,
                horizon=self.horizon,
                variance_floor=float(self.head_cfg.get("variance_floor", 1e-6)),
            )
        raise ValueError(f"Unsupported prediction head type: {head_type}")

    def _prepare_flat_series(
        self,
        x: torch.Tensor,
        missing_mask: torch.Tensor | None = None,
    ) -> tuple[torch.Tensor, int, int, tuple[torch.Tensor, torch.Tensor], list[tuple[str, Any]]]:
        contexts: list[tuple[str, Any]] = []
        for module in self.preprocessing:
            x = module.forward_transform(x, contexts, missing_mask) if isinstance(module, MissingMaskAction) else module.forward_transform(x, contexts)

        x = self.channel_mixer(x)
        if self.embedding_type == "invert":
            location = x.mean(dim=1, keepdim=True).detach()
            scale = torch.sqrt(x.var(dim=1, keepdim=True, unbiased=False) + 1e-5).detach()
        else:
            location = torch.zeros_like(x[:, -1:, :])
            scale = torch.ones_like(location)
        series = (x - location) / scale
        batch_size, seq_len, channels = series.shape
        flat = series.permute(0, 2, 1).reshape(batch_size * channels, seq_len)
        if self.input_attention is not None:
            flat = flat + self.input_attention(flat.unsqueeze(-1)).squeeze(-1)
        if self.embedding_type == "invert":
            flat = flat.reshape(batch_size, channels, seq_len)
        return flat, batch_size, channels, (location, scale), contexts

    def _merge_history(
        self,
        x: torch.Tensor | None = None,
        *,
        target_history: torch.Tensor | None = None,
        exogenous_past: torch.Tensor | None = None,
        exogenous_future: torch.Tensor | None = None,
    ) -> torch.Tensor:
        if exogenous_future is not None and exogenous_future.numel():
            raise ValueError("UNSUPPORTED_COVARIATE: exogenous_future is not supported")
        if x is not None:
            if target_history is not None or exogenous_past is not None or exogenous_future is not None:
                raise ValueError("Provide either x or structured covariate inputs, not both")
            return x
        if target_history is None:
            raise ValueError("RecipeModel.forward requires x or target_history")
        if exogenous_past is None:
            return target_history
        if exogenous_past.size(-1) == 0:
            return target_history
        if target_history.shape[:2] != exogenous_past.shape[:2]:
            raise ValueError(
                "target_history and exogenous_past must share batch and input length, "
                f"got {tuple(target_history.shape)} and {tuple(exogenous_past.shape)}"
            )
        return torch.cat([target_history, exogenous_past], dim=-1)

    def _slice_output_channels(self, y: torch.Tensor) -> torch.Tensor:
        if self.num_output_channels <= 0 or y.size(-2) == 0:
            return y
        if y.dim() == 4:
            return y[:, :, : self.num_output_channels, :]
        if y.dim() >= 3:
            return y[..., : self.num_output_channels]
        return y

    def _restore_point_forecast(
        self,
        flat_pred: torch.Tensor,
        *,
        batch_size: int,
        channels: int,
        normalization: tuple[torch.Tensor, torch.Tensor],
        contexts: list[tuple[str, Any]],
    ) -> torch.Tensor:
        pred = flat_pred.reshape(batch_size, channels, self.horizon).permute(0, 2, 1)
        location, scale = normalization
        y = pred * scale + location
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
        normalization: tuple[torch.Tensor, torch.Tensor],
        contexts: list[tuple[str, Any]],
    ) -> torch.Tensor:
        quantiles = flat_quantiles.reshape(batch_size, channels, self.horizon, flat_quantiles.size(-1))
        location, scale = normalization
        y = quantiles.permute(0, 2, 1, 3) * scale.unsqueeze(-1) + location.unsqueeze(-1)
        y = self._apply_output_mixer_quantiles(y)
        return self._inverse_quantile_forecast(y, contexts)

    def _forward_core(self, series: torch.Tensor, calendar_features: torch.Tensor | None = None) -> torch.Tensor:
        def embed(module: nn.Module) -> torch.Tensor:
            if self.embedding_type == "calendar":
                features = calendar_features
                if features is not None:
                    features = features.repeat_interleave(series.size(0) // features.size(0), dim=0)
                return module(series, features)
            return module(series)

        def output(module: nn.Module, tokens: torch.Tensor) -> torch.Tensor:
            values = module(tokens if self.embedding_type == "invert" or isinstance(module, PatchFlattenReadout) else tokens.mean(dim=1))
            return values.reshape(-1, self.latent_dim)

        if self.backbone_type == "linear":
            if self.embedding_type == "calendar":
                return self.model[1:](embed(self.model[0]))
            return self.model(series).reshape(-1, self.latent_dim)

        if self.backbone_type in {"dlinear", "tcn", "nbeats", "timesnet_lite"}:
            return self.model(series)

        if self.backbone_type == "mlp" and self.embedding_type == "none":
            return self.model(series)

        if self.backbone_type == "mlp":
            modules = self.model
            tokens = embed(modules["embedding"])
            tokens = modules["input_proj"](tokens)
            tokens = modules["blocks"](tokens)
            return output(modules["head"], tokens)

        if self.backbone_type == "rnn":
            modules = self.model
            tokens = embed(modules["embedding"])
            encoded, _ = modules["rnn"](tokens)
            return modules["head"](encoded if self.embedding_type == "invert" else encoded[:, -1, :]).reshape(-1, self.latent_dim)

        if self.backbone_type == "gated_depthwise_conv":
            modules = self.model
            tokens = modules["input_proj"](embed(modules["embedding"]))
            tokens = modules["blocks"](tokens)
            return output(modules["head"], tokens)

        if self.backbone_type == "mixer":
            modules = self.model
            tokens = modules["input_proj"](embed(modules["embedding"]))
            tokens = modules["blocks"](tokens)
            return output(modules["head"], tokens)

        modules = self.model
        tokens = embed(modules["embedding"])
        if isinstance(modules["position"], nn.Identity):
            encoded = modules["encoder"](tokens)
        else:
            position = modules["position"]["weight"][:, : tokens.size(1), :]
            encoded = modules["encoder"](tokens + position)
        return output(modules["head"], encoded)

    def _encode_prepared(self, flat: torch.Tensor, batch: int, channels: int, calendar_features: torch.Tensor | None) -> torch.Tensor:
        latent = self._forward_core(flat, calendar_features).reshape(batch, channels, self.latent_dim)
        if isinstance(self.latent_mixer, HybridLatentFusion):
            history = flat.reshape(batch, channels, self.input_len).transpose(1, 2)
            latent = self.latent_mixer(history, latent)
        elif isinstance(self.latent_mixer, OrderedChannelMixer):
            latent = self.latent_mixer(latent.transpose(1, 2)).transpose(1, 2)
        else:
            latent = self.latent_mixer(latent)
        return latent.reshape(-1, self.latent_dim)

    def encode(self, x: torch.Tensor, *, missing_mask: torch.Tensor | None = None, calendar_features: torch.Tensor | None = None) -> torch.Tensor:
        flat, batch, channels, _, _ = self._prepare_flat_series(x, missing_mask)
        return self._encode_prepared(flat, batch, channels, calendar_features).reshape(batch, channels, self.latent_dim)

    def forward_quantiles(
        self,
        x: torch.Tensor | None = None,
        *,
        target_history: torch.Tensor | None = None,
        exogenous_past: torch.Tensor | None = None,
        exogenous_future: torch.Tensor | None = None,
        calendar_features: torch.Tensor | None = None,
        missing_mask: torch.Tensor | None = None,
    ) -> torch.Tensor:
        if isinstance(self.prediction_head, GaussianPointHead):
            mean, scale = self.forward_distribution(x, target_history=target_history, exogenous_past=exogenous_past, exogenous_future=exogenous_future, calendar_features=calendar_features, missing_mask=missing_mask)
            levels = mean.new_tensor(self.prediction_head.quantiles)
            z = torch.distributions.Normal(0.0, 1.0).icdf(levels)
            return mean.unsqueeze(-1) + scale.unsqueeze(-1) * z
        x = self._merge_history(
            x,
            target_history=target_history,
            exogenous_past=exogenous_past,
            exogenous_future=exogenous_future,
        )
        flat, batch_size, channels, normalization, contexts = self._prepare_flat_series(x, missing_mask)
        base_pred = self._encode_prepared(flat, batch_size, channels, calendar_features)
        if hasattr(self.prediction_head, "forward_quantiles"):
            quantiles = self.prediction_head.forward_quantiles(base_pred)
        else:
            quantiles = self.prediction_head(base_pred).unsqueeze(-1)
        return self._slice_output_channels(self._restore_quantile_forecast(
            quantiles,
            batch_size=batch_size,
            channels=channels,
            normalization=normalization,
            contexts=contexts,
        ))

    def forward(
        self,
        x: torch.Tensor | None = None,
        *,
        target_history: torch.Tensor | None = None,
        exogenous_past: torch.Tensor | None = None,
        exogenous_future: torch.Tensor | None = None,
        calendar_features: torch.Tensor | None = None,
        missing_mask: torch.Tensor | None = None,
    ) -> torch.Tensor:
        x = self._merge_history(
            x,
            target_history=target_history,
            exogenous_past=exogenous_past,
            exogenous_future=exogenous_future,
        )
        flat, batch_size, channels, normalization, contexts = self._prepare_flat_series(x, missing_mask)
        pred = self._encode_prepared(flat, batch_size, channels, calendar_features)
        pred = self.prediction_head(pred)
        return self._slice_output_channels(self._restore_point_forecast(
            pred,
            batch_size=batch_size,
            channels=channels,
            normalization=normalization,
            contexts=contexts,
        ))

    def forward_distribution(self, x: torch.Tensor | None = None, *, calendar_features: torch.Tensor | None = None, missing_mask: torch.Tensor | None = None, **inputs) -> tuple[torch.Tensor, torch.Tensor]:
        if not isinstance(self.prediction_head, GaussianPointHead):
            raise ValueError("forward_distribution requires a Gaussian head")
        if not isinstance(self.output_mixer, nn.Identity):
            raise ValueError("Gaussian output requires an identity output fusion; use input fusion")
        x = self._merge_history(x, **inputs)
        flat, batch, channels, normalization, contexts = self._prepare_flat_series(x, missing_mask)
        mean, scale = self.prediction_head.forward_distribution(self._encode_prepared(flat, batch, channels, calendar_features))
        location, normalization_scale = normalization
        mean = mean.reshape(batch, channels, self.horizon).permute(0, 2, 1) * normalization_scale + location
        variance = scale.reshape(batch, channels, self.horizon).permute(0, 2, 1).square() * normalization_scale.square()
        for module, (_, context) in zip(reversed(self.preprocessing), reversed(contexts)):
            if isinstance(module, InstanceNormAction):
                factor = context[1]
                if module.affine:
                    factor = factor / module.safe_scale()
                variance = variance * factor.square()
            elif isinstance(module, SeasonalDifferencingAction):
                raise ValueError("Gaussian inverse seasonal differencing requires a joint covariance model")
            mean = module.inverse_transform(mean, context)
        return self._slice_output_channels(mean), self._slice_output_channels(variance.clamp_min(1e-12).sqrt())


def _extract_recipe(model_config: dict[str, Any]) -> dict[str, Any]:
    recipe = model_config.get("recipe", model_config)
    if not isinstance(recipe, dict):
        raise ValueError("recipe_factory requires model_config.recipe")
    if recipe.get("recipe_version") == "recipe_schema_v3":
        from validate import validate_recipe_object
        errors = validate_recipe_object(recipe)
        if errors:
            raise ValueError("; ".join(errors))
        return recipe
    if recipe.get("recipe_version") != "recipe_schema_v2":
        raise ValueError("recipe_factory requires recipe_version='recipe_schema_v2'")
    for kind, choices in ACTION_FIELDS.items():
        actions = recipe.get("preprocessing", {}).get("actions", []) if kind == "preprocessing" else [recipe.get(kind, {})]
        for action in actions:
            allowed = choices.get(action.get("type"))
            if allowed is None or set(action) - set(allowed):
                raise ValueError(f"Unsupported {kind} fields/action: {action}; migrate to recipe_schema_v2")
    if "dropout" in recipe.get("training_strategy", {}).get("regularization", {}):
        raise ValueError("regularization.dropout was removed; configure backbone.dropout")
    actions = recipe.get("preprocessing", {}).get("actions", [])
    if any(a.get("type") == "missing_mask" and a.get("mask_channel", True) is not True for a in actions):
        raise ValueError("missing_mask.mask_channel must be true; remove the action to disable it")
    return recipe


def build_model(model_config: dict[str, Any], input_len: int, horizon: int) -> nn.Module:
    # Keep the exported model implementation self-contained.
    for field in ("known_future_covariates", "known_future_source", "known_future_available", "static_covariates"):
        if model_config.get(field):
            raise ValueError(f"UNSUPPORTED_COVARIATE: {field} is not supported")
    if model_config.get("future_covariate_mode") not in (None, "", "none") or model_config.get("covariate_fusion"):
        raise ValueError("UNSUPPORTED_COVARIATE: future conditioning/legacy wrappers require retraining")
    num_channels = model_config.get("num_channels")
    num_target_channels = model_config.get("num_target_channels")
    num_past_covariate_channels = model_config.get("num_past_covariate_channels", 0)
    num_future_covariate_channels = model_config.get("num_future_covariate_channels", 0)
    num_output_channels = model_config.get("num_output_channels")
    recipe = _extract_recipe(model_config)
    model_class = RecipeModel
    if recipe.get("recipe_version") == "recipe_schema_v3":
        from factory.typed_model import TypedRecipeModel
        model_class = TypedRecipeModel
    return model_class(
        recipe,
        input_len=input_len,
        horizon=horizon,
        num_channels=int(num_channels) if num_channels is not None else None,
        num_target_channels=int(num_target_channels) if num_target_channels is not None else None,
        num_past_covariate_channels=int(num_past_covariate_channels),
        num_future_covariate_channels=int(num_future_covariate_channels),
        num_output_channels=int(num_output_channels) if num_output_channels is not None else None,
        graph_adjacency=model_config.get("graph_adjacency"),
    )
