from __future__ import annotations

from typing import Any


ACTION_SPECS: dict[str, dict[str, dict[str, Any]]] = {
    "preprocessing": {
        "none": {"phase_min": "phase0b", "bridge_supported": True},
        "last_value_centering": {"phase_min": "phase2", "bridge_supported": False},
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
        "timesnet_lite": {"phase_min": "phase2", "bridge_supported": False},
        "gated_depthwise_conv": {"phase_min": "phase2", "bridge_supported": False},
        "mixer": {"phase_min": "phase2", "bridge_supported": False},
    },
    "fusion": {
        "feature_mlp": {"phase_min": "phase2", "bridge_supported": False},
        "temporal": {"phase_min": "phase0b", "bridge_supported": True},
        "variate_attention": {"phase_min": "phase2", "bridge_supported": False},
        "temporal_then_feature": {"phase_min": "phase2", "bridge_supported": False},
        "feature_then_temporal": {"phase_min": "phase2", "bridge_supported": False},
        "graph": {"phase_min": "phase2", "bridge_supported": False},
        "gated_hybrid": {"phase_min": "phase2", "bridge_supported": False},
    },
    "head": {
        "linear": {"phase_min": "phase0b", "bridge_supported": True},
        "quantile": {"phase_min": "phase2", "bridge_supported": False},
        "gaussian": {"phase_min": "phase2", "bridge_supported": False},
        "residual_correction": {"phase_min": "phase2", "bridge_supported": False},
    },
    "loss": {
        "mse": {"phase_min": "phase0b", "bridge_supported": True},
        "gaussian_nll": {"phase_min": "phase2", "bridge_supported": False},
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
        "lradj_type1": {"phase_min": "phase2", "bridge_supported": False},
        "lradj_type2": {"phase_min": "phase2", "bridge_supported": False},
        "lradj_type3": {"phase_min": "phase2", "bridge_supported": False},
        "lradj_3": {"phase_min": "phase2", "bridge_supported": False},
        "lradj_4": {"phase_min": "phase2", "bridge_supported": False},
        "lradj_5": {"phase_min": "phase2", "bridge_supported": False},
        "lradj_6": {"phase_min": "phase2", "bridge_supported": False},
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
        "timesnet_lite": ("hidden_dim", "n_layers", "top_k", "kernel_size", "dropout"),
        "gated_depthwise_conv": ("hidden_dim",),
        "mixer": ("hidden_dim",),
    },
}

# V2 stays frozen. V3 adds sequence-preserving encoders with its typed validator.
V3_ACTION_SPECS = {
    **ACTION_SPECS,
    "backbone": {**ACTION_SPECS["backbone"], **{
        name: {"phase_min": "phase2", "bridge_supported": False, "recipe_version": "recipe_schema_v3"}
        for name in ("diagonal_ssm", "timesblock_encoder", "mamba")
    }},
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


def validate_output_contract(head: dict[str, Any], loss: dict[str, Any]) -> list[str]:
    """Validate the distribution actually optimized and exported by the runtime."""
    errors: list[str] = []
    head_type = head.get("type", "linear")
    distribution = head.get("output_distribution", "point")
    expected = {"quantile": "quantile", "gaussian": "gaussian"}.get(head_type, "point")
    if distribution != expected:
        errors.append(f"prediction_head.output_distribution: {head_type} requires '{expected}'")
    allowed = {"point": {"mse", "mae", "huber", "distillation"},
               "quantile": {"quantile"}, "gaussian": {"gaussian_nll"}}
    if loss.get("base", "mse") not in allowed[expected]:
        errors.append(f"training_strategy.loss.base: {head_type} requires one of {sorted(allowed[expected])}")
    if head_type == "quantile":
        levels = head.get("quantiles", [0.5])
        for path, values in (("prediction_head.quantiles", levels),
                             ("training_strategy.loss.quantiles", loss.get("quantiles", levels))):
            if (not isinstance(values, list) or not values
                    or any(isinstance(q, bool) or not isinstance(q, (int, float)) or not 0 < q < 1 for q in values)
                    or any(a >= b for a, b in zip(values, values[1:]))):
                errors.append(f"{path}: levels must be strictly increasing, unique numbers in (0, 1)")
        if loss.get("quantiles", levels) != levels:
            errors.append("training_strategy.loss.quantiles must match prediction_head.quantiles")
    elif "quantiles" in loss:
        errors.append("training_strategy.loss.quantiles requires a quantile head and loss")
    return errors


def validate_recipe_against_registry(
    recipe: dict[str, Any],
    *,
    input_len: int | None = None,
    bridge_only: bool = False,
) -> list[str]:
    if recipe.get("recipe_version") == "recipe_schema_v3":
        from factory.representations import validate_typed_recipe
        if bridge_only:
            return ["recipe_schema_v3 requires the native recipe factory"]
        return validate_typed_recipe(recipe, input_len)
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
    if len(set(preprocessing_types)) != len(preprocessing_types):
        errors.append("preprocessing.actions must not repeat an action")
    if "missing_mask" in preprocessing_types and preprocessing_types[0] != "missing_mask":
        errors.append("preprocessing.actions: missing_mask must be first, before transformations")

    embedding_type = _get_type(recipe, "embedding")
    backbone_type = _get_type(recipe, "backbone")
    fusion_type = _get_type(recipe, "fusion")
    if "missing_mask" in preprocessing_types and fusion_type == "temporal" and recipe.get("fusion", {}).get("channel_mode", "independent") == "independent":
        errors.append("missing_mask requires cross-variable fusion so mask channels can affect forecasts")
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
    errors.extend(validate_output_contract(recipe.get("prediction_head", {}), recipe.get("training_strategy", {}).get("loss", {})))
    if output_distribution == "gaussian" and loss_type != "gaussian_nll":
        errors.append("Gaussian output requires loss.base='gaussian_nll'")
    if loss_type == "gaussian_nll" and (head_type != "gaussian" or output_distribution != "gaussian"):
        errors.append("gaussian_nll requires a Gaussian distribution head")
    if output_distribution == "gaussian" and "seasonal_differencing" in preprocessing_types:
        errors.append("Gaussian output does not support output channel mixing or inverse seasonal differencing without joint covariance")
    if backbone_type == "dlinear" and "series_decomposition" in preprocessing_types:
        errors.append("DLinear already decomposes its input; remove preprocessing.series_decomposition")
    if fusion_type == "graph":
        fusion = recipe["fusion"]
        if fusion.get("adjacency_source", "learned") == "static" and not fusion.get("topology_artifact"):
            errors.append("fusion.topology_artifact is required for static adjacency")
        if fusion.get("adjacency_source", "learned") != "static" and "topology_artifact" in fusion:
            errors.append("fusion.topology_artifact is only supported for static adjacency")
    allowed_distribution = {
        "linear": {"point"},
        "residual_correction": {"point"},
        "quantile": {"quantile"},
        "gaussian": {"gaussian"},
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
    if backbone_type in {"dlinear", "tcn", "nbeats", "timesnet_lite"} and embedding_type != "none":
        errors.append(f"backbone.type='{backbone_type}' requires embedding.type='none'")
    if backbone_type == "rnn" and str(backbone.get("cell", "gru")) not in {"gru", "lstm", "rnn"}:
        errors.append("backbone.cell must be one of: gru, lstm, rnn")
    if backbone_type == "mixer":
        if str(backbone.get("temporal_mixing", "mlp")) not in {"mlp", "conv"}:
            errors.append("backbone.temporal_mixing must be one of: mlp, conv")
        if str(backbone.get("channel_mixing", "mlp")) not in {"mlp", "identity"}:
            errors.append("backbone.channel_mixing must be one of: mlp, identity")

    errors.extend(validate_scheduler_warmup(recipe.get("training_strategy", {})))

    return errors


def validate_scheduler_warmup(training_strategy: dict[str, Any]) -> list[str]:
    errors = []
    scheduler = training_strategy.get("scheduler", {})
    warmup_steps = scheduler.get("warmup_steps", 0)
    max_epochs = training_strategy.get("budget", {}).get("max_epochs", 1)
    if warmup_steps and warmup_steps >= max_epochs:
        errors.append("scheduler.warmup_steps must be < budget.max_epochs")
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
