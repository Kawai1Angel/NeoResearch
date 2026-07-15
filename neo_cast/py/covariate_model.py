from __future__ import annotations

import torch
import torch.nn as nn


class CovariateConditionedForecaster(nn.Module):
    """Adapts an existing multivariate forecaster to target-only covariate forecasting."""

    def __init__(
        self,
        backbone: nn.Module,
        *,
        num_target_channels: int,
        num_past_covariate_channels: int,
        num_future_covariate_channels: int,
        covariate_fusion: str = "gated",
    ) -> None:
        super().__init__()
        if covariate_fusion not in {"concat", "gated", "none"}:
            raise ValueError("covariate_fusion must be one of: concat, gated, none")
        self.backbone = backbone
        self.num_target_channels = num_target_channels
        self.num_past_covariate_channels = num_past_covariate_channels
        self.num_future_covariate_channels = num_future_covariate_channels
        self.covariate_fusion = covariate_fusion
        historical_channels = num_target_channels + num_past_covariate_channels
        self.target_head = (
            nn.Identity()
            if historical_channels == num_target_channels
            else nn.Linear(historical_channels, num_target_channels)
        )
        if covariate_fusion == "concat" and num_future_covariate_channels > 0:
            self.concat_head = nn.Linear(
                historical_channels + num_future_covariate_channels,
                num_target_channels,
            )
        else:
            self.concat_head = None
        self.future_correction = None
        self.future_gate = None

    def _validate_inputs(
        self,
        target_history: torch.Tensor,
        exogenous_past: torch.Tensor,
        exogenous_future: torch.Tensor,
    ) -> None:
        expected = (
            ("target_history", target_history, self.num_target_channels),
            ("exogenous_past", exogenous_past, self.num_past_covariate_channels),
            ("exogenous_future", exogenous_future, self.num_future_covariate_channels),
        )
        for name, value, channels in expected:
            if value.dim() != 3 or value.size(-1) != channels:
                raise ValueError(f"{name} must have {channels} channels, got {tuple(value.shape)}")

    def _fuse(self, historical_forecast: torch.Tensor, exogenous_future: torch.Tensor) -> torch.Tensor:
        if self.concat_head is not None:
            return self.concat_head(torch.cat([historical_forecast, exogenous_future], dim=-1))
        base = self.target_head(historical_forecast)
        return base

    def forward(
        self,
        *,
        target_history: torch.Tensor,
        exogenous_past: torch.Tensor,
        exogenous_future: torch.Tensor,
    ) -> torch.Tensor:
        self._validate_inputs(target_history, exogenous_past, exogenous_future)
        historical = torch.cat([target_history, exogenous_past], dim=-1)
        forecast = self.backbone(historical)
        if isinstance(forecast, (tuple, list)):
            forecast = forecast[0]
        return self._fuse(forecast, exogenous_future)

    def forward_quantiles(
        self,
        *,
        target_history: torch.Tensor,
        exogenous_past: torch.Tensor,
        exogenous_future: torch.Tensor,
    ) -> torch.Tensor:
        if not hasattr(self.backbone, "forward_quantiles"):
            return self.forward(
                target_history=target_history,
                exogenous_past=exogenous_past,
                exogenous_future=exogenous_future,
            ).unsqueeze(-1)
        self._validate_inputs(target_history, exogenous_past, exogenous_future)
        historical = torch.cat([target_history, exogenous_past], dim=-1)
        forecast = self.backbone.forward_quantiles(historical)
        # Apply the same channel projection independently to each quantile.
        quantile_first = forecast.permute(0, 1, 3, 2)
        if self.concat_head is not None:
            future = exogenous_future.unsqueeze(2).expand(-1, -1, quantile_first.size(2), -1)
            result = self.concat_head(torch.cat([quantile_first, future], dim=-1))
        else:
            result = self.target_head(quantile_first)
        return result.permute(0, 1, 3, 2)

    @property
    def quantiles(self):
        return getattr(self.backbone, "quantiles", None)
