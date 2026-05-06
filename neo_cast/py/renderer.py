from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from model_recipe import compile_model_recipe, is_model_recipe_payload
from prepare_tsf import DATASET, HORIZONS, INPUT_LEN, NUM_CHANNELS, PARAM_BUDGET, SEED, TIME_BUDGET
from recipe_bridge import is_recipe_payload, normalize_recipe_id
from validate import detect_payload_kind, validate_payload


PROJECT_ROOT = Path(os.environ.get("NEO_CAST_PROJECT_ROOT", Path(__file__).resolve().parent.parent)).expanduser().resolve()
DEFAULT_STATE_DIR = PROJECT_ROOT / ".neo-cast"
DEFAULT_CANDIDATE_PATH = DEFAULT_STATE_DIR / "current_candidate.json"
DEFAULT_RESOLVED_PATH = DEFAULT_STATE_DIR / "resolved_candidate.json"

DEFAULT_PARAM_BUDGET_M = PARAM_BUDGET / 1e6
DEFAULT_TIME_BUDGET_S = TIME_BUDGET
SMOKE_CONFIG = {
    "horizon": HORIZONS[0],
    "batch_size": 16,
    "max_epochs": 2,
    "timeout_s": 60,
}


def load_json(path: str | Path) -> dict[str, Any]:
    resolved = Path(path).expanduser()
    with resolved.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError(f"Expected JSON object at {resolved}, got {type(payload).__name__}")
    return payload


def resolve_recipe(recipe: dict[str, Any], *, model_recipe: dict[str, Any] | None = None) -> dict[str, Any]:
    recipe_id = normalize_recipe_id(recipe)
    normalized_recipe = {
        **recipe,
        "recipe_id": recipe_id,
    }
    strategy = normalized_recipe["training_strategy"]
    optimizer = strategy["optimizer"]
    budget = strategy["budget"]
    constraints = normalized_recipe.get("constraints") or {}
    max_params = constraints.get("max_params")
    task_input_len = int(model_recipe.get("input", {}).get("history_window", INPUT_LEN)) if model_recipe else INPUT_LEN
    task_horizon = int(model_recipe.get("input", {}).get("prediction_horizon", HORIZONS[0])) if model_recipe else None
    smoke_config = SMOKE_CONFIG.copy()
    if task_horizon:
        smoke_config["horizon"] = task_horizon
    resolved = {
        "schema_version": "resolved_candidate.v1",
        "candidate_id": recipe_id,
        "hypothesis": normalized_recipe["hypothesis"],
        "model_family": "recipe_factory",
        "model_config": {"recipe": normalized_recipe, "num_channels": NUM_CHANNELS},
        "train_config": {
            "lr": float(optimizer["lr"]),
            "batch_size": int(budget.get("batch_size", 32)),
            "max_epochs": int(budget["max_epochs"]),
            "weight_decay": float(optimizer.get("weight_decay", 0.0)),
            "patience": int(budget.get("patience", 7)),
            "seed": int(budget.get("seed", SEED)),
        },
        "constraints": {
            "param_budget_m": min(float(max_params) / 1_000_000, DEFAULT_PARAM_BUDGET_M)
            if max_params
            else DEFAULT_PARAM_BUDGET_M,
            "time_budget_s": min(int(budget["time_budget_s"]), DEFAULT_TIME_BUDGET_S),
            "latency_priority": constraints.get("latency_priority", "medium"),
        },
        "smoke_config": smoke_config,
        "task": {
            "task_id": DATASET,
            "input_len": task_input_len,
            "horizons": [task_horizon] if task_horizon else list(HORIZONS),
            "num_channels": NUM_CHANNELS,
        },
        "notes": normalized_recipe.get("notes"),
        "recipe": normalized_recipe,
    }
    if model_recipe:
        resolved["model_recipe"] = model_recipe
    return resolved


def resolve_payload(payload: dict[str, Any]) -> dict[str, Any]:
    if is_recipe_payload(payload):
        return resolve_recipe(payload)
    if is_model_recipe_payload(payload):
        return resolve_recipe(compile_model_recipe(payload), model_recipe=payload)
    raise ValueError(
        "Expected recipe_version='recipe_schema_v1' or schema_version='model_recipe.v1'. "
        "The legacy candidate.v1 format is no longer supported as pipeline input."
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Resolve a candidate JSON into a stable runtime config.")
    parser.add_argument("--candidate-path", default=str(DEFAULT_CANDIDATE_PATH))
    parser.add_argument("--resolved-path", default=str(DEFAULT_RESOLVED_PATH))
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    candidate_path = Path(args.candidate_path).expanduser()
    try:
        payload_kind = detect_payload_kind(candidate_path)
        errors = validate_payload(payload_kind, candidate_path)
    except Exception as exc:
        payload_kind = "unknown"
        errors = [str(exc)]
    if errors:
        for item in errors:
            print(f"error: {item}")
        raise SystemExit(2)

    payload = load_json(candidate_path)
    try:
        resolved = resolve_payload(payload)
    except Exception as exc:
        print(f"error: {exc}")
        raise SystemExit(2) from exc

    resolved_path = Path(args.resolved_path).expanduser()
    try:
        resolved_path.parent.mkdir(parents=True, exist_ok=True)
        resolved_path.write_text(f"{json.dumps(resolved, indent=2, sort_keys=True)}\n", encoding="utf-8")
    except OSError as exc:
        print(json.dumps({"event": "runner_error", "error_kind": "write_failed", "message": str(exc)}))
        raise SystemExit(4) from exc

    print(
        json.dumps(
            {
                "event": "candidate_resolved",
                "candidate_id": resolved["candidate_id"],
                "payload_kind": payload_kind,
                "resolved_candidate_path": str(resolved_path.resolve()),
            }
        )
    )
    print(json.dumps({"event": "done", "status": "success"}))


if __name__ == "__main__":
    main()
