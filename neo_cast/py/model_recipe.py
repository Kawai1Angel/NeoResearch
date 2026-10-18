from __future__ import annotations

import re
from typing import Any


MODEL_RECIPE_VERSION = "model_recipe.v1"
RECIPE_VERSION = "recipe_schema_v2"

DEFAULT_SCALES = [
    {"patch_len": 8, "stride": 4},
    {"patch_len": 16, "stride": 8},
    {"patch_len": 32, "stride": 16},
    {"patch_len": 64, "stride": 32},
]

BACKBONE_MAP = {
    "linear": "linear",
    "mlp": "mlp",
    "transformer": "transformer",
    "temporal_conv": "tcn",
    "dlinear": "dlinear",
    "nbeats": "nbeats",
    "timesnet_lite": "timesnet_lite",
    "rnn": "rnn",
    "gated_depthwise_conv": "gated_depthwise_conv",
    "mixer": "mixer",
}

RAW_BACKBONES = {"dlinear", "nbeats", "timesnet_lite"}


def is_model_recipe_payload(payload: dict[str, Any]) -> bool:
    return payload.get("schema_version") in {MODEL_RECIPE_VERSION, "model_recipe.v2"}


def parse_max_params(value: Any) -> int:
    if isinstance(value, bool):
        raise ValueError("max_params must be an integer or unit string")
    if isinstance(value, int):
        if value <= 0:
            raise ValueError("max_params must be positive")
        return value
    if isinstance(value, float):
        if value <= 0:
            raise ValueError("max_params must be positive")
        return int(value)
    if isinstance(value, str):
        match = re.fullmatch(r"\s*([0-9]+(?:\.[0-9]+)?)([KkMmBb]?)\s*", value)
        if not match:
            raise ValueError("max_params must look like 5000000, 750K, or 5M")
        number = float(match.group(1))
        suffix = match.group(2).lower()
        multiplier = {"": 1, "k": 1_000, "m": 1_000_000, "b": 1_000_000_000}[suffix]
        parsed = int(number * multiplier)
        if parsed <= 0:
            raise ValueError("max_params must be positive")
        return parsed
    raise ValueError("max_params must be an integer or unit string")


def _safe_model_slug(model_name: str) -> str:
    slug = "".join(ch.lower() for ch in model_name if ch.isalnum() or ch in "._-")
    slug = slug.strip("._-") or "model"
    return slug[:48]


def _positive_int(value: Any, fallback: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


def _number(value: Any, fallback: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed


def prediction_horizons_from_input(model_input: dict[str, Any]) -> list[int]:
    primary = _positive_int(model_input.get("prediction_horizon"), 96)
    raw_horizons = model_input.get("prediction_horizons")
    if raw_horizons is None:
        return [primary]
    if not isinstance(raw_horizons, list) or len(raw_horizons) == 0:
        raise ValueError("input.prediction_horizons must be a non-empty array")

    horizons: list[int] = []
    for index, item in enumerate(raw_horizons):
        try:
            horizon = int(item)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"input.prediction_horizons[{index}] must be a positive integer") from exc
        if horizon <= 0:
            raise ValueError(f"input.prediction_horizons[{index}] must be a positive integer")
        if horizon in horizons:
            raise ValueError("input.prediction_horizons must not contain duplicates")
        horizons.append(horizon)

    if primary not in horizons:
        raise ValueError("input.prediction_horizons must include input.prediction_horizon")
    return horizons


def _compile_preprocessing(architecture: dict[str, Any]) -> dict[str, Any]:
    if architecture.get("last_value_centering"):
        if architecture.get("decomposition"):
            raise ValueError("Choose last_value_centering or decomposition, not both")
        return {"actions": [{"type": "last_value_centering"}]}
    if architecture.get("decomposition") and architecture["backbone"] != "dlinear":
        return {
            "actions": [
                {
                    "type": "series_decomposition",
                    "method": "moving_average",
                    "kernel_size": _positive_int(architecture.get("decomposition_kernel"), 25),
                }
            ]
        }
    return {"actions": [{"type": "none"}]}


def _compile_embedding(architecture: dict[str, Any], low_backbone: str, input_len: int) -> dict[str, Any]:
    requested = architecture.get("embedding", "auto")
    if low_backbone == "tcn" and requested not in {"auto", "none", "patch", "multiscale_patch"}:
        raise ValueError(f"embedding={requested} is incompatible with backbone=tcn")
    if low_backbone in RAW_BACKBONES and requested not in {"auto", "none"}:
        raise ValueError(f"embedding={requested} is incompatible with backbone={low_backbone}")
    blocks = int(architecture.get("multiscale_blocks", 0))
    if blocks and (low_backbone in RAW_BACKBONES or requested not in {"auto", "multiscale_patch"}):
        raise ValueError("multiscale_blocks requires a compatible multiscale embedding; use layers for backbone depth")
    if low_backbone in RAW_BACKBONES or requested == "none":
        return {"type": "none"}

    d_model = _positive_int(architecture.get("d_model"), _positive_int(architecture.get("hidden_dim"), 64))
    multiscale_blocks = _positive_int(architecture.get("multiscale_blocks"), 0)
    if requested == "multiscale_patch" or (requested == "auto" and multiscale_blocks > 0):
        # Scale selection depends only on the available history; multiscale_blocks
        # controls the depth of cross-scale processing rather than the scale count.
        scales = [dict(scale) for scale in DEFAULT_SCALES if int(scale["patch_len"]) <= input_len]
        if not scales:
            raise ValueError("multiscale_patch requires history_window >= 8")
        return {
            "type": "multiscale_patch",
            "scales": scales,
            "d_model": d_model,
            "num_blocks": multiscale_blocks or 1,
        }
    if requested == "invert":
        return {"type": "invert", "d_model": d_model}
    if requested == "frequency":
        return {"type": "frequency", "n_freq": 16, "d_model": d_model, "complex_mode": "magnitude"}
    if requested == "calendar":
        return {"type": "calendar", "fields": ["hour", "dayofweek", "month"], "embed_dim": d_model}
    if low_backbone in {"linear", "tcn"} and requested == "auto":
        return {"type": "none"}
    return {
        "type": "patch",
        "patch_len": _positive_int(architecture.get("patch_len"), 16),
        "stride": _positive_int(architecture.get("stride"), 8),
        "d_model": d_model,
    }


def _compile_backbone(architecture: dict[str, Any], low_backbone: str) -> dict[str, Any]:
    hidden_dim = _positive_int(architecture.get("hidden_dim"), 64)
    d_model = _positive_int(architecture.get("d_model"), hidden_dim)
    layers = _positive_int(architecture.get("layers"), 1)
    dropout = _number(architecture.get("dropout"), 0.1)
    kernel_size = _positive_int(architecture.get("kernel_size"), 3)

    if low_backbone == "linear":
        return {"type": "linear", "shared": False, "bias": True}
    if low_backbone == "mlp":
        return {"type": "mlp", "depth": layers, "hidden_dim": hidden_dim, "activation": "gelu", "dropout": dropout}
    if low_backbone == "transformer":
        heads = _positive_int(architecture.get("heads"), 4)
        if d_model % heads:
            raise ValueError("architecture.d_model must be divisible by architecture.heads")
        return {
            "type": "transformer",
            "d_model": d_model,
            "n_heads": max(heads, 1),
            "n_layers": layers,
            "dropout": dropout,
            "ffn_mult": 4.0,
        }
    if low_backbone == "dlinear":
        return {"type": "dlinear", "kernel_size": _positive_int(architecture.get("decomposition_kernel"), 25), "bias": True}
    if low_backbone == "tcn":
        return {
            "type": "tcn",
            "hidden_dim": hidden_dim,
            "n_layers": layers,
            "kernel_size": kernel_size,
            "activation": "gelu",
            "dropout": dropout,
        }
    if low_backbone == "nbeats":
        return {
            "type": "nbeats",
            "hidden_dim": hidden_dim,
            "n_blocks": layers,
            "n_layers": 2,
            "activation": "gelu",
            "dropout": dropout,
        }
    if low_backbone == "timesnet_lite":
        return {
            "type": "timesnet_lite",
            "hidden_dim": hidden_dim,
            "n_layers": layers,
            "top_k": 1,
            "kernel_size": kernel_size,
            "dropout": dropout,
        }
    if low_backbone == "rnn":
        return {"type": "rnn", "cell": "gru", "hidden_dim": hidden_dim, "num_layers": layers, "dropout": dropout}
    if low_backbone == "gated_depthwise_conv":
        return {"type": "gated_depthwise_conv", "hidden_dim": hidden_dim, "depth": layers, "kernel_size": kernel_size, "dropout": dropout}
    if low_backbone == "mixer":
        return {
            "type": "mixer",
            "hidden_dim": hidden_dim,
            "depth": layers,
            "temporal_mixing": "mlp",
            "channel_mixing": "mlp",
            "dropout": dropout,
        }
    raise ValueError(f"Unsupported architecture.backbone: {architecture.get('backbone')}")


def _compile_fusion(model_input: dict[str, Any], architecture: dict[str, Any]) -> dict[str, Any]:
    requested = architecture.get("channel_fusion")
    if requested == "variate_attention":
        return {"type": "variate_attention",}
    if requested == "gated_hybrid":
        return {"type": "gated_hybrid", "gate_type": "learned"}
    return {
        "type": "temporal",
        "channel_mode": requested if requested in {"shared", "independent"} else ("shared" if model_input.get("covariates") else "independent"),
    }


def _compile_prediction_head(architecture: dict[str, Any]) -> dict[str, Any]:
    distribution = architecture.get("output_distribution", "point")
    if distribution == "quantile":
        return {"type": "quantile", "output_distribution": "quantile", "quantiles": [0.1, 0.5, 0.9]}
    if distribution == "gaussian":
        return {"type": "gaussian", "output_distribution": "gaussian", "variance_floor": 1e-6}
    return {"type": "linear", "output_distribution": "point"}


def _compile_training(training: dict[str, Any]) -> dict[str, Any]:
    max_epochs = _positive_int(training.get("max_epochs"), 10)
    warmup_ratio = float(training.get("warmup_ratio", 0.0))
    warmup_steps = round(warmup_ratio * max_epochs)
    warmup_steps = max(0, min(warmup_steps, max_epochs - 1))

    return {
        "loss": {
            "base": training["loss"],
            "horizon_weighting": "uniform",
            **({"quantiles": [0.1, 0.5, 0.9]} if training["loss"] == "quantile" else {}),
        },
        "optimizer": {
            "type": training["optimizer"],
            "lr": float(training["learning_rate"]),
            "weight_decay": float(training.get("weight_decay", 0.0)),
        },
        "scheduler": {"type": "none", "warmup_steps": warmup_steps},
        "regularization": {
            "grad_clip": float(training.get("grad_clip", 1.0)),
        },
        "budget": {
            "max_epochs": max_epochs,
            "time_budget_s": _positive_int(training.get("time_budget_s"), 1200),
            "batch_size": _positive_int(training.get("batch_size"), 32),
            "patience": _positive_int(training.get("patience"), 5),
            "seed": int(training.get("seed", 42)),
        },
    }


def _compile_constraints(constraints: dict[str, Any]) -> dict[str, Any]:
    latency_sensitive = bool(constraints.get("latency_sensitive", False))
    return {
        "max_params": parse_max_params(constraints["max_params"]),
        **({"max_latency_ms": float(constraints["max_latency_ms"])} if "max_latency_ms" in constraints else {}),
        "latency_priority": "high" if latency_sensitive else "medium",
    }


def compile_model_recipe(model_recipe: dict[str, Any]) -> dict[str, Any]:
    if not is_model_recipe_payload(model_recipe):
        raise ValueError("compile_model_recipe expects schema_version='model_recipe.v1'")
    if model_recipe.get("schema_version") == "model_recipe.v2":
        import copy
        from validate import load_validator, SCHEMA_DIR, validate_recipe_object
        load_validator(SCHEMA_DIR / "model_recipe_v2_schema.json").validate(model_recipe)
        if model_recipe["input"].get("known_future_covariates"):
            raise ValueError("UNSUPPORTED_COVARIATE: known_future_covariates")
        horizons = prediction_horizons_from_input(model_recipe["input"])
        architecture = model_recipe["architecture"]
        if architecture["prediction_head"]["type"] == "identity":
            widths = [architecture["representation"]["latent_dim"]]
            secondary = architecture.get("composition", {}).get("secondary")
            if secondary:
                widths.append(secondary["representation"]["latent_dim"])
            if any(width != horizon for width in widths for horizon in horizons):
                raise ValueError("prediction_head.identity requires each representation.latent_dim to equal every forecast horizon")
        result = {
            "recipe_version": "recipe_schema_v3",
            "recipe_id": f"recipe_{_safe_model_slug(model_recipe['model_name'])}",
            "hypothesis": model_recipe["hypothesis"],
            **copy.deepcopy(model_recipe["architecture"]),
            "training_strategy": _compile_training(model_recipe["training"]),
            "constraints": _compile_constraints(model_recipe["constraints"]),
        }
        errors = validate_recipe_object(result, input_len=model_recipe["input"]["history_window"])
        if errors:
            raise ValueError("; ".join(errors))
        return result

    model_input = model_recipe["input"]
    prediction_horizons = prediction_horizons_from_input(model_input)
    architecture = model_recipe["architecture"]
    training = model_recipe["training"]
    constraints = model_recipe["constraints"]
    low_backbone = BACKBONE_MAP.get(str(architecture["backbone"]))
    if low_backbone is None:
        raise ValueError(f"Unsupported architecture.backbone: {architecture['backbone']}")
    distribution = architecture.get("output_distribution", "point")
    allowed_losses = {"point": {"mse", "mae", "huber", "distillation"}, "quantile": {"quantile"}, "gaussian": {"gaussian_nll"}}
    if training["loss"] not in allowed_losses[distribution]:
        raise ValueError(f"output_distribution={distribution} requires loss in {sorted(allowed_losses[distribution])}")
    backbone = _compile_backbone(architecture, low_backbone)
    if "attention" in architecture:
        backbone["attention"] = architecture["attention"]

    notes = [
        "compiled_from=model_recipe.v1",
        f"model_name={model_recipe['model_name']}",
        f"history_window={model_input['history_window']}",
        f"prediction_horizon={model_input['prediction_horizon']}",
        f"prediction_horizons={prediction_horizons}",
    ]
    if model_recipe.get("notes"):
        notes.append(str(model_recipe["notes"]))

    return {
        "recipe_version": RECIPE_VERSION,
        "recipe_id": f"recipe_{_safe_model_slug(model_recipe['model_name'])}",
        "hypothesis": model_recipe["hypothesis"],
        "preprocessing": _compile_preprocessing(architecture),
        "embedding": _compile_embedding(architecture, low_backbone, int(model_input["history_window"])),
        "backbone": backbone,
        "fusion": _compile_fusion(model_input, architecture),
        "prediction_head": _compile_prediction_head(architecture),
        "post_processing": {"type": "auto"},
        "training_strategy": _compile_training(training),
        "constraints": _compile_constraints(constraints),
        "notes": "; ".join(notes),
    }
