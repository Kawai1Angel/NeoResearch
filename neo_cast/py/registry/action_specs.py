from __future__ import annotations

from typing import Any


ACTION_SPECS: dict[str, dict[str, dict[str, Any]]] = {
    "preprocessing": {
        "none": {"phase_min": "phase0b", "bridge_supported": True},
        "instance_norm": {"phase_min": "phase1", "bridge_supported": False},
        "series_decomposition": {"phase_min": "phase1", "bridge_supported": False},
        "seasonal_differencing": {"phase_min": "phase2", "bridge_supported": False},
        "missing_mask": {"phase_min": "phase2", "bridge_supported": False},
        "sample_reweighting": {"phase_min": "phase2", "bridge_supported": False},
    },
    "embedding": {
        "none": {"phase_min": "phase0b", "bridge_supported": True},
        "patch": {"phase_min": "phase0b", "bridge_supported": True},
        "multiscale_patch": {"phase_min": "phase2", "bridge_supported": False},
        "invert": {"phase_min": "phase2", "bridge_supported": False},
        "frequency": {"phase_min": "phase2", "bridge_supported": False},
        "calendar": {"phase_min": "phase2", "bridge_supported": False},
    },
    "backbone": {
        "linear": {"phase_min": "phase0b", "bridge_supported": True},
        "mlp": {"phase_min": "phase0b", "bridge_supported": True},
        "transformer": {"phase_min": "phase0b", "bridge_supported": True},
        "rnn": {"phase_min": "phase2", "bridge_supported": False},
        "dlinear": {"phase_min": "phase2", "bridge_supported": False},
        "tcn": {"phase_min": "phase2", "bridge_supported": False},
        "nbeats": {"phase_min": "phase2", "bridge_supported": False},
        "timesnet": {"phase_min": "phase2", "bridge_supported": False},
        "ssm": {"phase_min": "phase2", "bridge_supported": False},
        "mixer": {"phase_min": "phase2", "bridge_supported": False},
    },
    "fusion": {
        "temporal": {"phase_min": "phase0b", "bridge_supported": True},
        "feature": {"phase_min": "phase2", "bridge_supported": False},
        "temporal_then_feature": {"phase_min": "phase2", "bridge_supported": False},
        "feature_then_temporal": {"phase_min": "phase2", "bridge_supported": False},
        "graph": {"phase_min": "phase2", "bridge_supported": False},
        "gated_hybrid": {"phase_min": "phase2", "bridge_supported": False},
    },
    "head": {
        "linear": {"phase_min": "phase0b", "bridge_supported": True},
        "direct_multi_horizon": {"phase_min": "phase2", "bridge_supported": False},
        "quantile": {"phase_min": "phase2", "bridge_supported": False},
        "gaussian": {"phase_min": "phase2", "bridge_supported": False},
        "residual_correction": {"phase_min": "phase2", "bridge_supported": False},
    },
    "loss": {
        "mse": {"phase_min": "phase0b", "bridge_supported": True},
        "mae": {"phase_min": "phase1", "bridge_supported": False},
        "huber": {"phase_min": "phase1", "bridge_supported": False},
        "quantile": {"phase_min": "phase2", "bridge_supported": False},
        "distillation": {"phase_min": "phase2", "bridge_supported": False},
    },
    "optimizer": {
        "adam": {"phase_min": "phase0b", "bridge_supported": True},
        "adamw": {"phase_min": "phase0b", "bridge_supported": True},
        "sgd": {"phase_min": "phase1", "bridge_supported": False},
    },
    "scheduler": {
        "none": {"phase_min": "phase0b", "bridge_supported": True},
        "cosine": {"phase_min": "phase1", "bridge_supported": False},
        "one_cycle": {"phase_min": "phase2", "bridge_supported": False},
        "plateau": {"phase_min": "phase2", "bridge_supported": False},
    },
}

ACTION_REQUIRED_FIELDS: dict[str, dict[str, tuple[str, ...]]] = {
    "preprocessing": {
        "series_decomposition": ("kernel_size",),
        "seasonal_differencing": ("period",),
    },
    "embedding": {
        "patch": ("patch_len", "stride", "d_model"),
        "multiscale_patch": ("scales", "d_model"),
        "invert": ("d_model",),
        "frequency": ("n_freq", "d_model"),
        "calendar": ("fields", "embed_dim"),
    },
    "backbone": {
        "mlp": ("depth", "hidden_dim", "dropout"),
        "transformer": ("d_model", "n_heads", "n_layers", "dropout"),
        "rnn": ("hidden_dim",),
        "dlinear": ("kernel_size",),
        "tcn": ("hidden_dim", "n_layers", "kernel_size", "dropout"),
        "nbeats": ("hidden_dim", "n_blocks", "n_layers", "dropout"),
        "timesnet": ("hidden_dim", "n_layers", "top_k", "kernel_size", "dropout"),
        "ssm": ("state_dim",),
        "mixer": ("hidden_dim",),
    },
}


def _preprocessing_types(recipe: dict[str, Any]) -> list[str]:
    actions = recipe.get("preprocessing", {}).get("actions", [])
    return [str(action.get("type")) for action in actions]


def _get_type(recipe: dict[str, Any], field: str) -> str:
    value = recipe.get(field, {})
    if not isinstance(value, dict):
        return ""
    return str(value.get("type", ""))


def _require_fields(errors: list[str], label: str, action: Any, action_type: str, kind: str) -> None:
    if not isinstance(action, dict):
        return
    for field in ACTION_REQUIRED_FIELDS.get(kind, {}).get(action_type, ()):
        if field not in action:
            errors.append(f"{label}.type='{action_type}' requires {field}")


def validate_recipe_against_registry(
    recipe: dict[str, Any],
    *,
    input_len: int | None = None,
    bridge_only: bool = False,
) -> list[str]:
    errors: list[str] = []

    preprocessing_types = _preprocessing_types(recipe)
    if not preprocessing_types:
        errors.append("preprocessing.actions must contain at least one action")
    for action_type in preprocessing_types:
        if action_type not in ACTION_SPECS["preprocessing"]:
            errors.append(f"Unsupported preprocessing action: {action_type}")
    for index, action in enumerate(recipe.get("preprocessing", {}).get("actions", [])):
        if isinstance(action, dict):
            _require_fields(errors, f"preprocessing.actions[{index}]", action, str(action.get("type", "")), "preprocessing")
    if "none" in preprocessing_types and len(preprocessing_types) > 1:
        errors.append("preprocessing action 'none' cannot be combined with other preprocessing actions")

    embedding_type = _get_type(recipe, "embedding")
    backbone_type = _get_type(recipe, "backbone")
    fusion_type = _get_type(recipe, "fusion")
    head_type = _get_type(recipe, "prediction_head")
    loss_type = str(recipe.get("training_strategy", {}).get("loss", {}).get("base", ""))
    optimizer_type = str(recipe.get("training_strategy", {}).get("optimizer", {}).get("type", ""))
    scheduler_type = str(recipe.get("training_strategy", {}).get("scheduler", {}).get("type", "none"))

    for kind, action_type in (
        ("embedding", embedding_type),
        ("backbone", backbone_type),
        ("fusion", fusion_type),
        ("head", head_type),
        ("loss", loss_type),
        ("optimizer", optimizer_type),
        ("scheduler", scheduler_type),
    ):
        if action_type not in ACTION_SPECS[kind]:
            errors.append(f"Unsupported {kind} action: {action_type}")

    _require_fields(errors, "embedding", recipe.get("embedding"), embedding_type, "embedding")
    _require_fields(errors, "backbone", recipe.get("backbone"), backbone_type, "backbone")

    if fusion_type == "temporal":
        channel_mode = recipe.get("fusion", {}).get("channel_mode", "independent")
        if channel_mode not in {"independent", "shared"}:
            errors.append("Current recipe factory supports channel_mode='independent' or 'shared'")
    elif recipe.get("fusion", {}).get("channel_mode") not in {None, "independent", "shared"}:
        errors.append("fusion.channel_mode must be 'independent' or 'shared' when provided")

    output_distribution = recipe.get("prediction_head", {}).get("output_distribution", "point")
    allowed_distribution = {
        "linear": {"point"},
        "direct_multi_horizon": {"point"},
        "residual_correction": {"point"},
        "quantile": {"point", "quantile"},
        "gaussian": {"point", "gaussian"},
    }.get(head_type, set())
    if allowed_distribution and output_distribution not in allowed_distribution:
        errors.append(f"prediction_head.type='{head_type}' does not support output_distribution='{output_distribution}'")

    if bridge_only:
        bridge_supported_preprocessing = preprocessing_types == ["none"]
        if not bridge_supported_preprocessing:
            errors.append("Phase A/B bridge only supports preprocessing.actions=[{'type':'none'}]")
        if recipe.get("fusion", {}).get("channel_mode", "independent") != "independent":
            errors.append("Phase A/B bridge only supports fusion.channel_mode='independent'")

        allowed_pairs = {
            ("none", "linear"),
            ("patch", "mlp"),
            ("patch", "transformer"),
        }
        if (embedding_type, backbone_type) not in allowed_pairs:
            errors.append(
                "Phase A/B bridge supports only: none+linear, patch+mlp, patch+transformer"
            )

    embedding = recipe.get("embedding", {})
    if embedding_type == "patch":
        errors.extend(
            _validate_patch_scale(
                "embedding",
                int(embedding.get("patch_len", 0)),
                int(embedding.get("stride", 0)),
                input_len=input_len,
            )
        )
    elif embedding_type == "multiscale_patch":
        scales = embedding.get("scales", [])
        seen_scales: set[tuple[int, int]] = set()
        if isinstance(scales, list):
            for index, scale in enumerate(scales):
                if not isinstance(scale, dict):
                    errors.append(f"embedding.scales[{index}] must be an object")
                    continue
                patch_len = int(scale.get("patch_len", 0))
                stride = int(scale.get("stride", 0))
                errors.extend(
                    _validate_patch_scale(
                        f"embedding.scales[{index}]",
                        patch_len,
                        stride,
                        input_len=input_len,
                    )
                )
                scale_key = (patch_len, stride)
                if scale_key in seen_scales:
                    errors.append(f"Duplicate multiscale patch scale: patch_len={patch_len}, stride={stride}")
                seen_scales.add(scale_key)
    elif embedding_type == "frequency":
        n_freq = int(embedding.get("n_freq", 0))
        if n_freq < 1:
            errors.append("embedding.n_freq must be >= 1")
        if input_len is not None and n_freq > input_len // 2 + 1:
            errors.append(f"embedding.n_freq={n_freq} exceeds rfft bins for input_len={input_len}")
    elif embedding_type == "calendar":
        fields = embedding.get("fields", [])
        if not isinstance(fields, list) or not fields:
            errors.append("embedding.fields must contain at least one field for calendar embedding")

    backbone = recipe.get("backbone", {})
    if backbone_type == "transformer":
        d_model = int(backbone.get("d_model", embedding.get("d_model", 0)))
        n_heads = int(backbone.get("n_heads", 0))
        if n_heads and d_model % n_heads != 0:
            errors.append(f"backbone.d_model={d_model} must be divisible by n_heads={n_heads}")
        embedding_d_model = embedding.get("embed_dim") if embedding_type == "calendar" else embedding.get("d_model")
        if embedding_type != "none" and int(embedding_d_model or d_model) != d_model:
            errors.append("embedding.d_model/embed_dim must match backbone.d_model for transformer recipes")
    if backbone_type in {"dlinear", "tcn", "nbeats", "timesnet"} and embedding_type != "none":
        errors.append(f"backbone.type='{backbone_type}' requires embedding.type='none'")
    if backbone_type == "rnn" and str(backbone.get("cell", "gru")) not in {"gru", "lstm", "rnn"}:
        errors.append("backbone.cell must be one of: gru, lstm, rnn")

    return errors


def _validate_patch_scale(
    label: str,
    patch_len: int,
    stride: int,
    *,
    input_len: int | None,
) -> list[str]:
    errors: list[str] = []
    if input_len is not None and patch_len > input_len:
        errors.append(f"{label}.patch_len={patch_len} exceeds input_len={input_len}")
    if stride > patch_len:
        errors.append(f"{label}.stride={stride} cannot exceed patch_len={patch_len}")
    return errors
