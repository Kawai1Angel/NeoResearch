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


def describe_model(model: Any) -> dict[str, Any]:
    import importlib

    factory = importlib.import_module("factory.build_model")
    import torch.nn as nn

    # Exact classes fail closed for unknown or replaced modules.
    preprocessing = {
        factory.NoOpPreprocessing: "none",
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
        factory.TimesNetLiteCore: "timesnet",
        nn.Linear: "linear",
    }
    if type(model) is not factory.RecipeModel:
        return {"model_class": type(model).__name__, "backbone": "unknown"}
    core = model.model
    embedding = "none"
    backbone = cores.get(type(core), "unknown")
    if isinstance(core, nn.Sequential):
        embedding = embeddings.get(type(core[0]), "none")
        backbone = (
            "linear"
            if embedding != "none" and len(core) == 3 and type(core[-1]) is nn.Linear
            else (
                "mlp"
                if sum(type(module) is nn.Linear for module in core) >= 2
                else "unknown"
            )
        )
    elif isinstance(core, nn.ModuleDict):
        embedding = embeddings.get(type(core["embedding"]), "unknown")
        if "encoder" in core and isinstance(core["encoder"], nn.TransformerEncoder):
            backbone = "transformer"
        elif "rnn" in core and isinstance(core["rnn"], (nn.GRU, nn.LSTM, nn.RNN)):
            backbone = "rnn"
        elif "blocks" in core and len(core["blocks"]):
            backbone = {
                "ResidualMLPBlock": "mlp",
                "SSMTokenBlock": "ssm",
                "TokenMixerBlock": "mixer",
            }.get(type(core["blocks"][0]).__name__, "unknown")
    mixer, output = model.channel_mixer, model.output_mixer
    fusion = "unknown"
    if type(mixer) is nn.Identity and type(output) is nn.Identity:
        fusion = "temporal"
    elif type(mixer) is factory.ChannelMixer and type(output) is nn.Identity:
        # These factory aliases execute the same feature mixing operation.
        fusion = (
            model.fusion_type
            if model.fusion_type in {"temporal", "feature", "feature_then_temporal"}
            else "unknown"
        )
    elif type(mixer) is nn.Identity and type(output) is factory.ChannelMixer:
        fusion = "temporal_then_feature"
    elif type(mixer) is factory.GraphChannelMixer:
        fusion = "graph"
    elif type(mixer) is factory.GatedHybridMixer:
        fusion = "gated_hybrid"
    head = {
        factory.ResidualCorrectionHead: "residual_correction",
        factory.QuantilePointHead: "quantile",
        factory.GaussianPointHead: "gaussian",
        LinearHead: "linear",
        DirectMultiHorizonHead: "direct_multi_horizon",
    }.get(type(model.prediction_head), "unknown")
    return {
        "model_class": type(model).__name__,
        "recipe_version": "recipe_schema_v1",
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


# Distinguish the two no-op head semantics at the object level.
from torch.nn import Identity


class LinearHead(Identity):
    pass


class DirectMultiHorizonHead(Identity):
    pass


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
