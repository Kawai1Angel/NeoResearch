from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


TRACE_SCHEMA_VERSION = "research_trace.v1"
TRACE_ENTRY_SCHEMA_VERSION = "research_trace_entry.v1"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _candidate_recipe(candidate: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(candidate, dict):
        return {}
    recipe = candidate.get("recipe")
    if isinstance(recipe, dict):
        return recipe
    model_config = candidate.get("model_config")
    if isinstance(model_config, dict) and isinstance(model_config.get("recipe"), dict):
        return model_config["recipe"]
    return {}


def _module_type(recipe: dict[str, Any], key: str) -> str | None:
    value = recipe.get(key)
    if not isinstance(value, dict):
        return None
    module_type = value.get("type")
    return str(module_type) if module_type is not None else None


def _preprocessing_summary(recipe: dict[str, Any]) -> str:
    preprocessing = recipe.get("preprocessing")
    if not isinstance(preprocessing, dict):
        return "none"
    actions = preprocessing.get("actions")
    if not isinstance(actions, list) or not actions:
        return "none"
    names = [
        str(action.get("type"))
        for action in actions
        if isinstance(action, dict) and action.get("type") is not None
    ]
    return "+".join(names) if names else "none"


def _candidate_id(metadata: dict[str, Any], candidate: dict[str, Any] | None) -> str:
    if isinstance(candidate, dict):
        value = candidate.get("candidate_id") or candidate.get("recipe_id")
        if value:
            return str(value)
    return str(metadata.get("candidate_id") or metadata["run_id"])


def _hypothesis(candidate: dict[str, Any] | None) -> str | None:
    if not isinstance(candidate, dict):
        return None
    value = candidate.get("hypothesis")
    return str(value) if value else None


def _format_metric(value: Any) -> str:
    if isinstance(value, (int, float)):
        return f"{float(value):.6f}"
    return "NA"


def _metric_evidence(metrics: dict[str, Any], horizons: list[int]) -> list[str]:
    evidence = []
    if "cv_avg_mse" in metrics:
        evidence.append(
            f"Cross-validation average MSE is {_format_metric(metrics.get('cv_avg_mse'))} "
            f"with population std {_format_metric(metrics.get('cv_std_mse'))}."
        )
    evidence.append(f"Final-checkpoint validation average MSE is {_format_metric(metrics.get('val_avg_mse'))}.")
    horizon_parts = []
    for horizon in horizons:
        key = f"val_h{horizon}_mse"
        if key in metrics:
            horizon_parts.append(f"h{horizon}={_format_metric(metrics[key])}")
    if horizon_parts:
        evidence.append(f"Per-horizon validation MSE: {', '.join(horizon_parts)}.")
    return evidence


def build_model_design_trace(
    metadata: dict[str, Any],
    candidate: dict[str, Any] | None,
    *,
    created_at: str | None = None,
) -> dict[str, Any]:
    recipe = _candidate_recipe(candidate)
    candidate_id = _candidate_id(metadata, candidate)
    if recipe:
        modules = {
            "preprocessing": _preprocessing_summary(recipe),
            "embedding": _module_type(recipe, "embedding") or "unknown",
            "backbone": _module_type(recipe, "backbone") or "unknown",
            "fusion": _module_type(recipe, "fusion") or "unknown",
            "prediction_head": _module_type(recipe, "prediction_head") or "unknown",
        }
        decision = (
            "use recipe modules "
            f"{modules['preprocessing']} -> {modules['embedding']} -> {modules['backbone']} "
            f"with {modules['fusion']} fusion and {modules['prediction_head']} head"
        )
    else:
        decision = f"use {metadata['model_family']} candidate"

    evidence = [
        (
            f"Task contract: task_id={metadata['task_id']}, input_len={metadata['input_len']}, "
            f"horizons={metadata['horizons']}, num_channels={metadata['num_channels']}."
        )
    ]
    hypothesis = _hypothesis(candidate)
    if hypothesis:
        evidence.insert(0, f"Candidate hypothesis: {hypothesis}")

    return {
        "schema_version": TRACE_ENTRY_SCHEMA_VERSION,
        "decision_id": f"model_design:{candidate_id}",
        "stage": "model_design",
        "decision": decision,
        "made_by": "ModelDesigner Agent",
        "candidate_id": candidate_id,
        "run_id": metadata["run_id"],
        "task_id": metadata["task_id"],
        "evidence": evidence,
        "expected_effect": hypothesis or "Improve validation forecasting metrics under the task contract.",
        "verification_plan": (
            "Run the smoke/CV/full training harness, compare cv_avg_mse against the current session best "
            "under the same protocol, and inspect cv_std_mse plus final-checkpoint validation metrics."
        ),
        "created_at": created_at or _now_iso(),
    }


def build_train_eval_trace(metadata: dict[str, Any], *, created_at: str | None = None) -> dict[str, Any]:
    horizons = [int(item) for item in metadata["horizons"]]
    metrics = metadata.get("val_metrics", {})
    evidence = _metric_evidence(metrics if isinstance(metrics, dict) else {}, horizons)
    return {
        "schema_version": TRACE_ENTRY_SCHEMA_VERSION,
        "decision_id": f"train_eval:{metadata['run_id']}",
        "stage": "train_eval",
        "decision": "evaluate candidate with the validation split before any reference-test promotion",
        "made_by": "TrainEval Agent",
        "candidate_id": str(metadata.get("candidate_id") or metadata["run_id"]),
        "run_id": metadata["run_id"],
        "task_id": metadata["task_id"],
        "evidence": evidence,
        "expected_effect": "Decide whether the candidate is worth keeping without contaminating reference-test metrics.",
        "verification_plan": "Reserve ref_test/blind_test for frozen-artifact checks after validation selection.",
        "created_at": created_at or _now_iso(),
    }


def build_research_trace(
    metadata: dict[str, Any],
    candidate: dict[str, Any] | None,
    *,
    created_at: str | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": TRACE_SCHEMA_VERSION,
        "run_id": metadata["run_id"],
        "task_id": metadata["task_id"],
        "candidate_id": _candidate_id(metadata, candidate),
        "entries": [
            build_model_design_trace(metadata, candidate, created_at=created_at),
            build_train_eval_trace(metadata, created_at=created_at),
        ],
    }


def append_trace_jsonl(trace_path: Path, trace: dict[str, Any]) -> None:
    entries = trace.get("entries", [])
    if not isinstance(entries, list):
        return
    trace_path.parent.mkdir(parents=True, exist_ok=True)
    with trace_path.open("a", encoding="utf-8") as handle:
        for entry in entries:
            if isinstance(entry, dict):
                handle.write(f"{json.dumps(entry, sort_keys=True)}\n")
