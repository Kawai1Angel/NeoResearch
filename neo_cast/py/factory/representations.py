"""Compile-time typed connection checks, independent of torch."""
from __future__ import annotations

import copy

SEQUENCE_ENCODERS = frozenset({"diagonal_ssm", "timesblock_encoder", "mamba"})


def validate_typed_recipe(recipe: dict, input_len: int | None = None) -> list[str]:
    from registry.action_specs import validate_recipe_against_registry

    errors = []
    backbone = recipe["backbone"]
    representation = recipe["representation"]
    layout = representation["layout"]
    sequence = backbone["type"] in SEQUENCE_ENCODERS
    if sequence:
        if layout not in {"sequence_latent", "channel_sequence"}:
            errors.append("representation.layout: sequence encoders require sequence_latent or channel_sequence")
        if representation["readout"] not in {"mean", "last"}:
            errors.append("representation.readout: sequence encoders require explicit mean or last")
        if recipe["embedding"]["type"] != "none":
            errors.append("embedding: typed sequence encoders currently accept only none (their explicit input projection)")
        if backbone["type"] == "timesblock_encoder" and input_len is not None and backbone["top_k"] > input_len // 2:
            errors.append("backbone.top_k exceeds floor(input_len/2)")
    elif layout != "channel_latent" or representation["readout"] != "none":
        errors.append("representation: legacy backbones require channel_latent with readout=none")
    legacy = copy.deepcopy(recipe)
    legacy["recipe_version"] = "recipe_schema_v2"
    # Identity is a v3-only point head; reuse the legacy distribution/loss
    # checks without adding a new action to the frozen v2 registry.
    if legacy["prediction_head"]["type"] == "identity":
        legacy["prediction_head"]["type"] = "linear"
    if sequence:
        legacy["backbone"] = {"type": "linear", "shared": True}
        if layout == "sequence_latent" and legacy["fusion"] == {"type": "temporal", "channel_mode": "independent"}:
            # A joint input projection gives masks an actual path to targets.
            legacy["fusion"] = {"type": "feature_mlp"}
    legacy.pop("representation", None)
    legacy.pop("composition", None)
    errors.extend(validate_recipe_against_registry(legacy, input_len=input_len))
    composition = recipe.get("composition", {"type": "single"})
    if composition["type"] != "single":
        actions = recipe["preprocessing"]["actions"]
        if any(a["type"] in {"series_decomposition", "seasonal_differencing"} for a in actions):
            errors.append("composition: remove decomposition/differencing preprocessing; use one explicit decomposition")
        if recipe["fusion"] != {"type": "temporal", "channel_mode": "independent"}:
            errors.append("composition: use temporal/independent fusion; branch fusion is explicit in composition")
        other = copy.deepcopy(recipe)
        other.update(composition["secondary"])
        other.pop("composition", None)
        # Keep mask actions for reachability validation of both branches.
        errors.extend("composition.secondary." + error for error in validate_typed_recipe(other, input_len))
        merge = composition.get("merge", "sum")
        if merge in {"sum", "forecast_step_gate"} and recipe["prediction_head"].get("output_distribution", "point") != "point":
            errors.append("composition: forecast-space combinations only support point heads")
        if merge in {"latent_gate", "history_time_gate"} and representation["latent_dim"] != other["representation"]["latent_dim"]:
            errors.append("composition: latent widths must match; declare equal adapter output widths")
        if merge == "history_time_gate":
            if not sequence or other["backbone"]["type"] not in SEQUENCE_ENCODERS:
                errors.append("history_time_gate requires two sequence-preserving encoders")
            if layout != other["representation"]["layout"] or backbone.get("d_model") != other["backbone"].get("d_model"):
                errors.append("history_time_gate requires equal axis layout and d_model")
            if representation != other["representation"]:
                errors.append("history_time_gate requires the same explicit readout/adapter contract")
        if composition["type"] == "decomposition_two_branch":
            if composition["kernel_size"] % 2 == 0:
                errors.append("composition.kernel_size must be odd")
            if backbone["type"] == "dlinear" or other["backbone"]["type"] == "dlinear":
                errors.append("composition: DLinear already decomposes its inputs")
    return errors
