"""Deterministic execution checks. Actual semantics come from instantiated modules."""

from __future__ import annotations
import hashlib
import json
import math
from decimal import Decimal
from pathlib import Path
from typing import Any


def canonicalize(value: Any) -> str:
    if value is None or isinstance(value, (str, bool)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            raise ValueError("Non-finite contract number")
        if value == 0:
            return "0"
        text = str(value).lower()
        if 1e-6 <= abs(value) < 1e21:
            return (
                format(Decimal(text), "f").rstrip("0").rstrip(".")
                if "." in format(Decimal(text), "f")
                else format(Decimal(text), "f")
            )
        mantissa, _, exponent = text.partition("e")
        if not exponent:
            text = format(float(value), ".15e")
            mantissa, _, exponent = text.partition("e")
        exponent_int = int(exponent)
        return (
            mantissa.rstrip("0").rstrip(".")
            + "e"
            + ("+" if exponent_int >= 0 else "-")
            + str(abs(exponent_int))
        )
    if isinstance(value, list):
        return "[" + ",".join(canonicalize(item) for item in value) + "]"
    if isinstance(value, dict):
        return (
            "{"
            + ",".join(
                canonicalize(key) + ":" + canonicalize(value[key])
                for key in sorted(value)
            )
            + "}"
        )
    raise TypeError(f"Unsupported JSON value: {type(value)}")


def digest(value: Any) -> str:
    return hashlib.sha256(canonicalize(value).encode("utf-8")).hexdigest()


def load_contract(path: str | Path) -> dict[str, Any]:
    from jsonschema import Draft202012Validator

    contract = json.loads(Path(path).read_text(encoding="utf-8"))
    schema = json.loads(
        (Path(__file__).parent / "schemas/execution_contract_schema.json").read_text()
    )
    Draft202012Validator(schema).validate(contract)
    return contract


def describe_model(model: Any, _typed: bool = True) -> dict[str, Any]:
    import importlib

    factory = importlib.import_module("factory.build_model")
    import torch.nn as nn
    from factory.typed_model import TypedRecipeModel
    if _typed and isinstance(model, TypedRecipeModel):
        from factory.encoders import DiagonalSSM, Mamba1, TimesBlock
        sequence_types = {DiagonalSSM: "diagonal_ssm", Mamba1: "mamba", TimesBlock: "timesblock_encoder"}
        primary_core = next((module for module in model.model.modules() if type(module) in sequence_types), None)
        base = describe_model(model, _typed=False)
        backbone = sequence_types.get(type(primary_core), base["backbone"])
        return {
            **base,
            "runtime_semantics_revision": 3, "recipe_version": "recipe_schema_v3",
            "model_class": type(model).__name__, "backbone": backbone,
            "representation": model.representation,
            "composition": model.composition_config,
            "implementation_status": "paper_derived" if backbone == "timesblock_encoder" else "native",
            "backend": "torch_reference", "horizon_sharing": False,
            "target_channels": model.num_target_channels, "past_exogenous_channels": model.num_past_covariate_channels,
            "future_exogenous_channels": 0, "output_channels": model.num_output_channels,
            "num_parameters": sum(p.numel() for p in model.parameters()),
            "head_num_parameters": sum(p.numel() for p in model.prediction_head.parameters()),
            "module_dropout": {name: module.p for name, module in model.named_modules() if isinstance(module, nn.Dropout)},
            "parameter_graph_digest": factory.parameter_graph_digest(model),
            "secondary": describe_model(model.secondary) if model.secondary is not None else None,
        }

    # Exact classes fail closed for unknown or replaced modules.
    preprocessing = {
        factory.NoOpPreprocessing: "none",
        factory.LastValueCenteringAction: "last_value_centering",
        factory.InstanceNormAction: "instance_norm",
        factory.SeriesDecompositionAction: "series_decomposition",
        factory.SeasonalDifferencingAction: "seasonal_differencing",
        factory.MissingMaskAction: "missing_mask",
        factory.SampleReweightingAction: "sample_reweighting",
    }
    embeddings = {
        factory.PatchEmbedding: "patch",
        factory.MultiScalePatchEmbedding: "multiscale_patch",
        factory.InvertEmbedding: "invert",
        factory.FrequencyEmbedding: "frequency",
        factory.CalendarEmbedding: "calendar",
        factory.SequenceEmbedding: "none",
    }
    cores = {
        factory.DLinearCore: "dlinear",
        factory.TCNCore: "tcn",
        factory.NBeatsCore: "nbeats",
        factory.TimesNetLiteCore: "timesnet_lite",
        nn.Linear: "linear",
        factory.ChannelLinear: "linear",
    }
    if not isinstance(model, factory.RecipeModel):
        return {"model_class": type(model).__name__, "backbone": "unknown"}
    core = model.model
    embedding = "none"
    backbone = cores.get(type(core), "unknown")
    if isinstance(core, nn.Sequential):
        embedding = embeddings.get(type(core[0]), "none")
        backbone = (
            "linear"
            if embedding != "none" and len(core) in {2, 3} and type(core[-1]) in {nn.Linear, factory.ChannelLinear}
            else (
                "mlp"
                if sum(type(module) is nn.Linear for module in core) >= 2
                else "unknown"
            )
        )
    elif isinstance(core, nn.ModuleDict):
        embedding = embeddings.get(type(core["embedding"]), "unknown")
        if "encoder" in core and (isinstance(core["encoder"], nn.TransformerEncoder) or any(isinstance(m, factory.TokenAttention) for m in core["encoder"].modules())):
            backbone = "transformer"
        elif "rnn" in core and isinstance(core["rnn"], (nn.GRU, nn.LSTM, nn.RNN)):
            backbone = "rnn"
        elif "blocks" in core and len(core["blocks"]):
            backbone = {
                "ResidualMLPBlock": "mlp",
                "GatedDepthwiseConvBlock": "gated_depthwise_conv",
                "TokenMixerBlock": "mixer",
            }.get(type(core["blocks"][0]).__name__, "unknown")
    mixer, output = model.channel_mixer, model.output_mixer
    latent = model.latent_mixer
    fusion = "unknown"
    if type(mixer) is nn.Identity and type(output) is nn.Identity:
        fusion = "temporal"
    elif type(mixer) is factory.ChannelMixer and type(output) is nn.Identity:
        # These factory aliases execute the same feature mixing operation.
        fusion = (
            model.fusion_type
            if model.fusion_type in {"temporal", "variate_attention", "feature_then_temporal"}
            else "unknown"
        )
    elif type(mixer) is nn.Identity and type(output) is factory.ChannelMixer:
        fusion = "temporal_then_feature"
    elif type(mixer) is factory.GraphChannelMixer:
        fusion = "graph"
    if isinstance(latent, factory.VariateAttention):
        fusion = "variate_attention"
    elif isinstance(latent, factory.HybridLatentFusion):
        fusion = "gated_hybrid"
    elif isinstance(latent, factory.OrderedChannelMixer):
        fusion = "temporal_then_feature"
    elif isinstance(mixer, factory.OrderedChannelMixer):
        fusion = "feature_then_temporal"
    elif isinstance(mixer, factory.ChannelMixer) and model.fusion_type == "feature_mlp":
        fusion = "feature_mlp"
    head = {
        factory.IdentityForecastHead: "identity",
        factory.ResidualCorrectionHead: "residual_correction",
        factory.QuantilePointHead: "quantile",
        factory.GaussianPointHead: "gaussian",
        factory.LinearHead: "linear",
    }.get(type(model.prediction_head), "unknown")
    ordered = latent if isinstance(latent, factory.OrderedChannelMixer) else mixer
    return {
        **describe_implementation(model, factory),
        "runtime_semantics_revision": model.runtime_semantics_revision,
        "implementation_status": "paper_derived" if backbone == "timesnet_lite" else "native",
        "fusion_equivalence": "feature_mlp" if fusion == "temporal" and type(mixer) is factory.ChannelMixer else None,
        **({"fusion_gate_type": latent.gate_type} if isinstance(latent, factory.HybridLatentFusion) else {}),
        **({"fusion_gate": ordered.gate is not None, "fusion_residual": ordered.residual}
           if isinstance(ordered, factory.OrderedChannelMixer) else {}),
        "latent_shape": ["B", model.model_num_channels, model.latent_dim],
        "head_num_parameters": sum(p.numel() for p in model.prediction_head.parameters()),
        "linear_shared": not any(isinstance(m, factory.ChannelLinear) for m in model.modules()) if backbone == "linear" else None,
        "module_dropout": {name: module.p for name, module in model.named_modules() if isinstance(module, nn.Dropout)},
        "parameter_graph_digest": factory.parameter_graph_digest(model),
        **({"graph_source": mixer.source, "adjacency_digest": digest(mixer.matrix().detach().cpu().tolist())} if isinstance(mixer, factory.GraphChannelMixer) else {}),
        "model_class": type(model).__name__,
        "recipe_version": "recipe_schema_v2",
        "preprocessing": [
            preprocessing.get(type(module), "unknown") for module in model.preprocessing
        ],
        "embedding": embedding,
        "backbone": backbone,
        "backbone_module_class": type(core).__name__,
        "fusion": fusion,
        "channel_mode": (
            "independent"
            if type(mixer) is nn.Identity
            else "shared" if fusion == "temporal" else model.channel_mode
        ),
        "prediction_head": head,
        "target_channels": model.num_target_channels,
        "past_exogenous_channels": model.num_past_covariate_channels,
        "future_exogenous_channels": model.num_future_covariate_channels,
        "output_channels": model.num_output_channels,
        "num_parameters": sum(p.numel() for p in model.parameters()),
    }


def describe_implementation(model: Any, factory: Any) -> dict[str, Any]:
    """Report mechanisms from concrete modules, not recipe/backbone claims."""
    import torch.nn as nn

    modules = list(model.modules())
    mechanisms = set()
    if any(type(m) in {factory.DLinearCore, factory.SeriesDecompositionAction} for m in modules):
        mechanisms.add("moving_average_decomposition")
    if getattr(model, "composition_config", {}).get("type") == "decomposition_two_branch":
        # TypedRecipeModel executes the actual moving-average branch split.
        from factory.typed_model import TypedRecipeModel
        if type(model) is TypedRecipeModel and model.secondary is not None:
            mechanisms.add("moving_average_decomposition")
    if any(type(m) is factory.NBeatsCore and len(m.blocks) > 0
           and all(type(b) is factory.NBeatsBlock for b in m.blocks) for m in modules):
        mechanisms.add("learned_residual_backcast")
    if any(type(m) is factory.MultiScalePatchEmbedding and len(m.embeddings) > 1 for m in modules):
        mechanisms.add("multiscale_patches")
    head = model.prediction_head
    if type(head) is factory.IdentityForecastHead:
        mechanisms.add("direct_horizon_forecast")
    head_types = {factory.IdentityForecastHead, factory.LinearHead, factory.ResidualCorrectionHead,
                  factory.QuantilePointHead, factory.GaussianPointHead}
    projection = (head if type(head) is factory.LinearHead else
                  head.base if type(head) is factory.ResidualCorrectionHead else
                  head.proj if type(head) is factory.QuantilePointHead else
                  head.mean if type(head) is factory.GaussianPointHead else None)
    return {
        "input_length": model.input_len,
        "head_input_width": (model.latent_dim if type(head) is factory.IdentityForecastHead else
                             projection.in_features if isinstance(projection, nn.Linear) else None),
        "head_channel_shared": type(head) in head_types,
        "forecast_horizon": model.horizon,
        "mechanisms": sorted(mechanisms),
        "forecast_path": ("history -> horizon-sized encoder forecast -> identity head" if type(head) is factory.IdentityForecastHead else
                          "history -> encoder latent -> shared channel head -> horizon"),
    }


def compare(contract: dict[str, Any], manifest: dict[str, Any]) -> list[dict[str, Any]]:
    mismatches = []
    expected = {
        **contract["expected"],
        "candidate_id": contract["candidate_id"],
        "candidate_spec_sha256": contract["candidate_spec_sha256"],
        "contract_digest": digest(contract),
    }
    actual = {
        **manifest.get("actual", {}),
        **{
            key: manifest.get(key)
            for key in ("candidate_id", "candidate_spec_sha256", "contract_digest")
        },
    }
    for key, value in expected.items():
        if actual.get(key) != value:
            mismatches.append(
                {"path": key, "expected": value, "actual": actual.get(key)}
            )
    return mismatches


def verify_models(
    contract: dict[str, Any],
    models: list[Any],
    candidate_path: str | Path,
    resolved: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    payload = json.loads(Path(candidate_path).read_text(encoding="utf-8"))
    manifests = [
        {
            "event": "executed_model_manifest",
            "schema_version": "executed_model_manifest.v1",
            "candidate_id": contract["candidate_id"],
            "candidate_spec_sha256": digest(payload),
            "contract_digest": digest(contract),
            "actual": describe_model(model),
        }
        for model in models
    ]
    mismatches = [
        item for manifest in manifests for item in compare(contract, manifest)
    ]
    # Also catch changes introduced by rendering, including fields absent from the runtime object.
    recipe = resolved.get("model_config", {}).get("recipe", {})
    for key, actual in {
        "preprocessing": [
            a["type"] for a in recipe.get("preprocessing", {}).get("actions", [])
        ],
        "embedding": recipe.get("embedding", {}).get("type"),
        "backbone": recipe.get("backbone", {}).get("type"),
        "fusion": recipe.get("fusion", {}).get("type"),
        "channel_mode": recipe.get("fusion", {}).get("channel_mode", "independent"),
        "prediction_head": recipe.get("prediction_head", {}).get("type"),
    }.items():
        if actual != contract["expected"][key]:
            mismatches.append(
                {
                    "path": "resolved." + key,
                    "expected": contract["expected"][key],
                    "actual": actual,
                }
            )
    return manifests, mismatches
