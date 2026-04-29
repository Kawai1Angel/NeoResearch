from __future__ import annotations

import argparse
import copy
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_SCALES = [
    {"patch_len": 8, "stride": 4},
    {"patch_len": 16, "stride": 8},
    {"patch_len": 32, "stride": 16},
]


@dataclass(frozen=True)
class MutationPolicy:
    max_hidden_dim: int = 256
    min_hidden_dim: int = 32
    max_depth: int = 4
    min_lr: float = 1e-4
    max_lr: float = 3e-3
    poor_val_mse: float = 1.1
    good_val_mse: float = 0.9


def load_json(path: str | Path) -> dict[str, Any]:
    json_path = Path(path).expanduser()
    with json_path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError(f"Expected object at {json_path}, got {type(payload).__name__}")
    return payload


def write_json(path: str | Path, payload: dict[str, Any]) -> None:
    json_path = Path(path).expanduser()
    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(f"{json.dumps(payload, indent=2, sort_keys=True)}\n", encoding="utf-8")


def _metric(metrics: dict[str, Any], key: str) -> float | None:
    value = metrics.get(key)
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _append_note(recipe: dict[str, Any], note: str) -> None:
    previous = recipe.get("notes")
    recipe["notes"] = f"{previous} | mutation:{note}" if previous else f"mutation:{note}"


def _set_recipe_id(recipe: dict[str, Any], parent_id: str, note: str, index: int) -> None:
    safe_note = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in note.lower())[:32]
    recipe["recipe_id"] = f"{parent_id}_mut{index}_{safe_note}"[:64].rstrip("._-")


def _ensure_training_defaults(recipe: dict[str, Any]) -> None:
    strategy = recipe.setdefault("training_strategy", {})
    strategy.setdefault("loss", {"base": "mse", "horizon_weighting": "uniform"})
    strategy.setdefault("optimizer", {"type": "adam", "lr": 0.001, "weight_decay": 0.0})
    strategy.setdefault("scheduler", {"type": "none", "warmup_steps": 0})
    strategy.setdefault("regularization", {"dropout": 0.1, "grad_clip": 1.0})
    strategy.setdefault("budget", {"max_epochs": 50, "time_budget_s": 600, "batch_size": 32, "patience": 5, "seed": 42})


def _to_multiscale_patch(recipe: dict[str, Any]) -> str | None:
    embedding = recipe.get("embedding", {})
    if embedding.get("type") != "patch":
        return None
    recipe["embedding"] = {
        "type": "multiscale_patch",
        "scales": copy.deepcopy(DEFAULT_SCALES),
        "d_model": int(embedding.get("d_model", 64)),
    }
    return "patch_to_multiscale"


def _enable_shared_channel(recipe: dict[str, Any]) -> str | None:
    fusion = recipe.setdefault("fusion", {"type": "temporal", "channel_mode": "independent"})
    if fusion.get("channel_mode") == "shared":
        return None
    fusion["type"] = "temporal"
    fusion["channel_mode"] = "shared"
    return "enable_shared_channel"


def _enable_instance_norm(recipe: dict[str, Any]) -> str | None:
    preprocessing = recipe.setdefault("preprocessing", {"actions": [{"type": "none"}]})
    actions = preprocessing.get("actions", [])
    if actions and actions[0].get("type") == "instance_norm":
        return None
    preprocessing["actions"] = [{"type": "instance_norm", "affine": False, "eps": 1e-5}]
    return "enable_instance_norm"


def _increase_mlp_capacity(recipe: dict[str, Any], policy: MutationPolicy) -> str | None:
    backbone = recipe.get("backbone", {})
    if backbone.get("type") != "mlp":
        return None
    changed = False
    hidden_dim = int(backbone.get("hidden_dim", 64))
    if hidden_dim < policy.max_hidden_dim:
        backbone["hidden_dim"] = min(hidden_dim * 2, policy.max_hidden_dim)
        changed = True
    depth = int(backbone.get("depth", 1))
    if depth < policy.max_depth:
        backbone["depth"] = depth + 1
        changed = True
    embedding = recipe.get("embedding", {})
    if embedding.get("type") in {"patch", "multiscale_patch"}:
        embedding["d_model"] = min(int(embedding.get("d_model", backbone.get("hidden_dim", 64))) * 2, policy.max_hidden_dim)
    return "increase_mlp_capacity" if changed else None


def _reduce_transformer_cost(recipe: dict[str, Any]) -> str | None:
    backbone = recipe.get("backbone", {})
    if backbone.get("type") != "transformer":
        return None
    changed = False
    if int(backbone.get("n_layers", 1)) > 1:
        backbone["n_layers"] = int(backbone["n_layers"]) - 1
        changed = True
    if int(backbone.get("d_model", 64)) > 32:
        backbone["d_model"] = max(int(backbone["d_model"]) // 2, 32)
        changed = True
        embedding = recipe.get("embedding", {})
        if embedding.get("type") in {"patch", "multiscale_patch"}:
            embedding["d_model"] = backbone["d_model"]
    n_heads = int(backbone.get("n_heads", 1))
    d_model = int(backbone.get("d_model", 32))
    while n_heads > 1 and d_model % n_heads != 0:
        n_heads //= 2
    backbone["n_heads"] = max(n_heads, 1)
    return "reduce_transformer_cost" if changed else None


def _switch_to_raw_backbone(recipe: dict[str, Any], backbone: dict[str, Any], note: str) -> str | None:
    current_type = recipe.get("backbone", {}).get("type")
    if current_type == backbone["type"]:
        return None
    recipe["embedding"] = {"type": "none"}
    recipe["backbone"] = copy.deepcopy(backbone)
    return note


def _switch_to_dlinear(recipe: dict[str, Any]) -> str | None:
    return _switch_to_raw_backbone(
        recipe,
        {"type": "dlinear", "kernel_size": 25, "bias": True},
        "switch_to_dlinear",
    )


def _switch_to_tcn(recipe: dict[str, Any]) -> str | None:
    return _switch_to_raw_backbone(
        recipe,
        {"type": "tcn", "hidden_dim": 16, "n_layers": 1, "kernel_size": 3, "activation": "gelu", "dropout": 0.1},
        "switch_to_tcn",
    )


def _switch_to_nbeats(recipe: dict[str, Any]) -> str | None:
    return _switch_to_raw_backbone(
        recipe,
        {"type": "nbeats", "hidden_dim": 128, "n_blocks": 3, "n_layers": 2, "activation": "gelu", "dropout": 0.1},
        "switch_to_nbeats",
    )


def _switch_to_timesnet(recipe: dict[str, Any]) -> str | None:
    return _switch_to_raw_backbone(
        recipe,
        {"type": "timesnet", "hidden_dim": 16, "n_layers": 1, "top_k": 1, "kernel_size": 3, "dropout": 0.1},
        "switch_to_timesnet",
    )


def _switch_optimizer(recipe: dict[str, Any], policy: MutationPolicy, *, direction: str) -> str:
    _ensure_training_defaults(recipe)
    optimizer = recipe["training_strategy"]["optimizer"]
    optimizer["type"] = "adamw"
    optimizer["weight_decay"] = float(optimizer.get("weight_decay", 0.0001) or 0.0001)
    lr = float(optimizer.get("lr", 0.001))
    if direction == "down":
        optimizer["lr"] = max(lr * 0.5, policy.min_lr)
        return "adamw_lr_down"
    optimizer["lr"] = min(lr * 1.25, policy.max_lr)
    return "adamw_lr_up"


def _switch_loss(recipe: dict[str, Any]) -> str | None:
    _ensure_training_defaults(recipe)
    loss = recipe["training_strategy"]["loss"]
    if loss.get("base") == "huber":
        return None
    loss["base"] = "huber"
    loss.setdefault("horizon_weighting", "uniform")
    return "switch_loss_huber"


def _mutation_steps(recipe: dict[str, Any], metrics: dict[str, Any], policy: MutationPolicy) -> list[str]:
    val_avg_mse = _metric(metrics, "val_avg_mse")
    status = str(metrics.get("status", "")).lower()
    model_family = recipe.get("backbone", {}).get("type", "")

    if status in {"crash", "smoke_fail", "invalid"}:
        note = _reduce_transformer_cost(recipe)
        if note:
            return [note, _switch_optimizer(recipe, policy, direction="down")]
        return [_switch_optimizer(recipe, policy, direction="down")]

    note = _to_multiscale_patch(recipe)
    if note:
        notes = [note]
        shared_note = _enable_shared_channel(recipe)
        if shared_note:
            notes.append(shared_note)
        return notes

    if recipe.get("fusion", {}).get("channel_mode") != "shared":
        note = _enable_shared_channel(recipe)
        if note:
            return [note]

    if recipe.get("preprocessing", {}).get("actions", [{}])[0].get("type") == "none":
        note = _enable_instance_norm(recipe)
        if note:
            return [note]

    if model_family == "mlp" and (val_avg_mse is None or val_avg_mse > policy.good_val_mse):
        note = _increase_mlp_capacity(recipe, policy)
        if note:
            return [note]

    if model_family == "transformer" and val_avg_mse is not None and val_avg_mse > policy.poor_val_mse:
        note = _reduce_transformer_cost(recipe)
        if note:
            return [note]

    if val_avg_mse is None or val_avg_mse > policy.poor_val_mse:
        for switch in (_switch_to_dlinear, _switch_to_tcn, _switch_to_nbeats, _switch_to_timesnet):
            note = switch(recipe)
            if note:
                return [note]

    note = _switch_loss(recipe)
    if note:
        return [note]

    return [_switch_optimizer(recipe, policy, direction="down")]


def mutate_recipe(
    recipe: dict[str, Any],
    metrics: dict[str, Any] | None = None,
    *,
    policy: MutationPolicy | None = None,
    index: int = 1,
) -> dict[str, Any]:
    if recipe.get("recipe_version") != "recipe_schema_v1":
        raise ValueError("mutate_recipe expects recipe_version='recipe_schema_v1'")

    policy = policy or MutationPolicy()
    metrics = metrics or {}
    parent_id = str(recipe.get("recipe_id") or "recipe")
    mutated = copy.deepcopy(recipe)
    _ensure_training_defaults(mutated)

    notes = _mutation_steps(mutated, metrics, policy)
    mutation_note = "+".join(note for note in notes if note)
    _set_recipe_id(mutated, parent_id, mutation_note or "noop", index)
    mutated["hypothesis"] = (
        f"Mutation of {parent_id}: {mutation_note or 'minor optimizer adjustment'}; "
        "tests a bounded next-step recipe based on the previous validation result."
    )
    _append_note(mutated, mutation_note or "noop")
    return mutated


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Mutate a recipe_schema_v1 candidate into a bounded next recipe.")
    parser.add_argument("--recipe", required=True, help="Input recipe JSON path.")
    parser.add_argument("--metrics", default=None, help="Optional metrics JSON path, e.g. val_metrics.json.")
    parser.add_argument("--output", required=True, help="Output mutated recipe JSON path.")
    parser.add_argument("--index", type=int, default=1, help="Mutation index suffix.")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    recipe = load_json(args.recipe)
    metrics = load_json(args.metrics) if args.metrics else {}
    mutated = mutate_recipe(recipe, metrics, index=args.index)
    write_json(args.output, mutated)
    print(json.dumps({"event": "recipe_mutated", "recipe_id": mutated["recipe_id"], "output": str(Path(args.output).expanduser())}))


if __name__ == "__main__":
    main()
