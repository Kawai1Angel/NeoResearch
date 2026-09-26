"""V3 typed adapters and bounded two-branch composition.

The v2 preprocessing/output contracts remain the boundary of this module.
"""
from __future__ import annotations

import copy
import torch
from torch import nn
from torch.nn import functional as F

from factory.build_model import RecipeModel, OrderedChannelMixer, HybridLatentFusion
from factory.adapters import SequenceReadout
from factory.encoders import DiagonalSSM, Mamba1, TimesBlock
from factory.representations import SEQUENCE_ENCODERS, validate_typed_recipe


class ResidualSequenceLayer(nn.Module):
    def __init__(self, core: nn.Module, width: int, dropout: float):
        super().__init__()
        self.norm, self.core, self.dropout = nn.LayerNorm(width), core, nn.Dropout(dropout)

    def forward(self, x):
        # TimesBlock owns its residual; state-space blocks use pre-norm residual.
        if isinstance(self.core, TimesBlock):
            return self.norm(x + self.dropout(self.core(x) - x))
        return x + self.dropout(self.core(self.norm(x)))


class TypedRecipeModel(RecipeModel):
    def __init__(self, recipe, input_len, horizon, **kwargs):
        errors = validate_typed_recipe(recipe, input_len)
        if errors:
            raise ValueError("; ".join(errors))
        self.representation = recipe["representation"]
        self.composition_config = recipe.get("composition", {"type": "single"})
        super().__init__(recipe, input_len, horizon, **kwargs)
        self.secondary = None
        self.merge = self.composition_config.get("merge", "sum")
        if self.composition_config["type"] != "single":
            second = copy.deepcopy(recipe)
            second.pop("composition", None)
            second.update(self.composition_config["secondary"])
            second["preprocessing"] = {"actions": [{"type": "none"}]}
            secondary_kwargs = dict(kwargs, num_channels=self.model_num_channels,
                                    num_target_channels=self.model_num_channels, num_output_channels=self.model_num_channels,
                                    num_past_covariate_channels=0)
            self.secondary = TypedRecipeModel(second, input_len, horizon, **secondary_kwargs)
            if self.merge in {"latent_gate", "history_time_gate"}:
                # These paths have one shared final head, not unused branch heads.
                self.secondary.prediction_head = nn.Identity()
            if self.merge == "history_time_gate":
                self.secondary.readout_adapter = nn.Identity()
                width = int(self.backbone_cfg["d_model"])
                self.branch_gate = nn.Linear(2 * width, 1)
            elif self.merge == "latent_gate":
                self.branch_gate = nn.Linear(2 * self.latent_dim, self.latent_dim)
            elif self.merge == "forecast_step_gate":
                self.branch_gate = nn.Linear(self.latent_dim + self.secondary.latent_dim, horizon)
        cap = int(recipe.get("constraints", {}).get("max_params", 100_000_000))
        if sum(p.numel() for p in self.parameters()) > cap:
            raise ValueError("RESOURCE_LIMIT: model including adapters, gates and branches exceeds max_params")

    def _build_sequence_model(self):
        cfg = self.backbone_cfg
        width = cfg["d_model"]
        channels = self._require_num_channels("typed sequence encoder")
        layout = self.representation["layout"]
        self.readout_adapter = SequenceReadout(layout, self.representation["readout"], width, self.latent_dim, channels)
        layers = []
        for _ in range(cfg["depth"]):
            if cfg["type"] == "diagonal_ssm":
                core = DiagonalSSM(width, cfg["state_dim"])
            elif cfg["type"] == "mamba":
                core = Mamba1(width, cfg["d_state"], cfg["d_conv"], cfg["expand"], cfg["backend"])
            else:
                core = TimesBlock(width, cfg["d_ff"], cfg["top_k"], cfg["num_kernels"])
            layers.append(ResidualSequenceLayer(core, width, cfg["dropout"]))
        return nn.Sequential(nn.Linear(channels if layout == "sequence_latent" else 1, width), *layers)

    def _sequence_tokens(self, flat, batch, channels):
        expanded = batch * self.input_len * self.backbone_cfg["d_model"]
        if self.representation["layout"] == "channel_sequence":
            expanded *= channels
        limit = int(self.recipe.get("constraints", {}).get("max_activation_elements", 16_777_216))
        if expanded > limit:
            raise ValueError("RESOURCE_LIMIT: sequence representation exceeds max_activation_elements")
        if self.representation["layout"] == "sequence_latent":
            return self.model(flat.reshape(batch, channels, self.input_len).transpose(1, 2))
        return self.model(flat.reshape(batch * channels, self.input_len, 1)).reshape(batch, channels, self.input_len, -1)

    def _single_latent(self, flat, batch, channels, calendar_features):
        if self.backbone_type not in SEQUENCE_ENCODERS:
            return super()._encode_prepared(flat, batch, channels, calendar_features).reshape(batch, channels, self.latent_dim)
        latent = self.readout_adapter(self._sequence_tokens(flat, batch, channels))
        if isinstance(self.latent_mixer, OrderedChannelMixer):
            return self.latent_mixer(latent.transpose(1, 2)).transpose(1, 2)
        if isinstance(self.latent_mixer, HybridLatentFusion):
            return self.latent_mixer(flat.reshape(batch, channels, self.input_len).transpose(1, 2), latent)
        return self.latent_mixer(latent)

    def _branch_inputs(self, flat, batch, channels):
        if self.composition_config["type"] != "decomposition_two_branch":
            return flat, flat
        history = flat.reshape(batch, channels, self.input_len)
        count = self.num_channels
        kernel = self.composition_config["kernel_size"]
        trend = F.avg_pool1d(F.pad(history[:, :count], (kernel // 2, kernel // 2), mode="replicate"), kernel, stride=1)
        residual = history[:, :count] - trend
        # Extra original-missing indicators are conditioned on, never decomposed.
        trend = torch.cat((trend, history[:, count:]), 1)
        residual = torch.cat((residual, history[:, count:]), 1)
        return trend.reshape(batch * channels, -1), residual.reshape(batch * channels, -1)

    def _encode_prepared(self, flat, batch, channels, calendar_features):
        if self.secondary is None:
            return self._single_latent(flat, batch, channels, calendar_features).reshape(-1, self.latent_dim)
        if self.merge in {"sum", "forecast_step_gate"}:
            raise ValueError("forecast-space composition has no single shared latent; call forward")
        if self.merge == "history_time_gate":
            left = self._sequence_tokens(flat, batch, channels)
            right = self.secondary._sequence_tokens(flat, batch, channels)
            gate = self.branch_gate(torch.cat((left, right), -1)).sigmoid()
            latent = self.readout_adapter(gate * left + (1 - gate) * right)
        else:
            left = self._single_latent(flat, batch, channels, calendar_features)
            right = self.secondary._single_latent(flat, batch, channels, calendar_features)
            gate = self.branch_gate(torch.cat((left, right), -1)).sigmoid()
            latent = gate * left + (1 - gate) * right
        return latent.reshape(-1, self.latent_dim)

    def forward(self, x=None, *, missing_mask=None, calendar_features=None, **inputs):
        if self.secondary is None or self.merge not in {"sum", "forecast_step_gate"}:
            return super().forward(x, missing_mask=missing_mask, calendar_features=calendar_features, **inputs)
        x = self._merge_history(x, **inputs)
        flat, batch, channels, normalization, contexts = self._prepare_flat_series(x, missing_mask)
        left_input, right_input = self._branch_inputs(flat, batch, channels)
        left = self._single_latent(left_input, batch, channels, calendar_features)
        right = self.secondary._single_latent(right_input, batch, channels, calendar_features)
        lpred = self.prediction_head(left.reshape(-1, self.latent_dim))
        rpred = self.secondary.prediction_head(right.reshape(-1, self.secondary.latent_dim))
        if self.merge == "sum":
            pred = lpred + rpred
        else:
            gate = self.branch_gate(torch.cat((left, right), -1)).sigmoid().reshape(-1, self.horizon)
            pred = gate * lpred + (1 - gate) * rpred
        return self._slice_output_channels(self._restore_point_forecast(pred, batch_size=batch, channels=channels,
                                                                        normalization=normalization, contexts=contexts))

    def forward_quantiles(self, x=None, **kwargs):
        if self.secondary is not None and self.merge in {"sum", "forecast_step_gate"}:
            return self.forward(x, **kwargs).unsqueeze(-1)
        return super().forward_quantiles(x, **kwargs)
