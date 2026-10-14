"""
Export a full neo-cast artifact package from a trained run directory.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from runtime_config import ACTIVE_SPEC, DATASET, HORIZONS, INPUT_LEN, NUM_CHANNELS
from research_trace import build_research_trace

FEATURE_COLUMNS = ACTIVE_SPEC.feature_columns
KNOWN_FUTURE_COVARIATES = ACTIVE_SPEC.known_future_covariates
PAST_COVARIATE_COLUMNS = tuple(dict.fromkeys((*ACTIVE_SPEC.observed_past_covariates, *KNOWN_FUTURE_COVARIATES)))


def build_preprocess_spec() -> dict[str, Any]:
    # Compatibility for old artifacts without the training-time snapshot.
    from prepare_tsf import build_preprocess_spec as build
    return build()


PY_ROOT = Path(__file__).resolve().parent
SCHEMA_DIR = PY_ROOT / "schemas"
METADATA_SCHEMA_PATH = SCHEMA_DIR / "metadata_schema.json"
DEFAULT_FILES = {
    "model_pt": "model.pt",
    "preprocess_json": "preprocess.json",
    "model_impl_py": "model_impl.py",
    "inference_py": "inference.py",
    "eval_report_md": "eval_report.md",
    "model_spec_json": "model_spec.json",
    "patch_bundle_json": "patch_bundle.json",
    "research_trace_json": "research_trace.json",
}
DEFAULT_REQUIREMENTS = [
    "mcp>=1.0",
    "numpy>=1.26",
    "torch>=2.2",
]


def load_json(path: str | Path) -> Any:
    resolved = Path(path).expanduser()
    with resolved.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, payload: Any) -> None:
    path.write_text(f"{json.dumps(payload, indent=2, sort_keys=True)}\n", encoding="utf-8")


def load_validator(schema_path: str | Path = METADATA_SCHEMA_PATH) -> Draft202012Validator:
    schema = load_json(schema_path)
    return Draft202012Validator(schema)


def validate_metadata_payload(payload: dict[str, Any]) -> list[str]:
    validator = load_validator()
    errors: list[str] = []
    for error in sorted(validator.iter_errors(payload), key=lambda exc: list(exc.absolute_path)):
        path = ".".join(str(part) for part in error.absolute_path)
        errors.append(f"{path or '<root>'}: {error.message}")
    return errors


def _load_optional_json(path: str | Path | None) -> dict[str, Any] | None:
    if not path:
        return None
    payload = load_json(path)
    if not isinstance(payload, dict):
        raise ValueError(f"Expected JSON object at {path}, got {type(payload).__name__}")
    return payload


def _load_family_module(model_family: str):
    family_path = PY_ROOT / "families" / f"{model_family}.py"
    if not family_path.exists():
        raise FileNotFoundError(f"Unknown family module for model_family={model_family}: {family_path}")
    spec = importlib.util.spec_from_file_location(f"neo_cast_family_{model_family}", family_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load family module: {family_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _metric_horizons(metrics: dict[str, Any] | None, *, prefix: str) -> list[int]:
    if not metrics:
        return []
    pattern = re.compile(rf"^{re.escape(prefix)}_h([0-9]+)_(?:mse|mae)$")
    horizons = {
        int(match.group(1))
        for key in metrics
        if isinstance(key, str) and (match := pattern.match(key))
    }
    return sorted(horizons)


def infer_export_horizons(
    *,
    val_metrics: dict[str, Any],
    ref_test_metrics: dict[str, Any] | None = None,
    candidate: dict[str, Any] | None = None,
) -> list[int]:
    horizons = _metric_horizons(val_metrics, prefix="val")
    if horizons:
        return horizons

    horizons = _metric_horizons(ref_test_metrics, prefix="ref_test")
    if horizons:
        return horizons

    candidate_horizons = (candidate or {}).get("task", {}).get("horizons", [])
    if isinstance(candidate_horizons, list) and candidate_horizons:
        return [int(horizon) for horizon in candidate_horizons]

    return list(HORIZONS)


def build_metadata(
    *,
    run_id: str,
    model_family: str,
    model_impl_entry: str,
    state_dict_layout: str,
    val_metrics: dict[str, Any],
    cv_metrics: dict[str, Any] | None = None,
    horizons: list[int] | None = None,
    session_id: str | None = None,
    candidate_id: str | None = None,
    ref_test_metrics: dict[str, Any] | None = None,
    training_summary: dict[str, Any] | None = None,
    created_at: str | None = None,
    preprocess: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from dataset_contract import reject_unsupported_covariates

    reject_unsupported_covariates(training_summary or {})
    try:
        feature_names = list((preprocess if preprocess is not None else build_preprocess_spec())["feature_names"])
    except FileNotFoundError:
        feature_names = list(FEATURE_COLUMNS)
    metadata = {
        "runtime_semantics_revision": (training_summary or {}).get("runtime_semantics_revision", 2),
        "artifact_version": "artifact.v1",
        "dataset_schema_version": ACTIVE_SPEC.schema_version,
        "run_id": run_id,
        "task_id": DATASET,
        "model_family": model_family,
        "model_impl_entry": model_impl_entry,
        "state_dict_layout": state_dict_layout,
        "input_len": INPUT_LEN,
        "horizons": list(horizons or HORIZONS),
        "num_channels": NUM_CHANNELS,
        "normalization_space": "standard_scaled",
        "feature_names": feature_names,
        "target_columns": list(ACTIVE_SPEC.target_columns),
        "used_observed_past_covariates": list(ACTIVE_SPEC.observed_past_covariates),
        "target_channels": NUM_CHANNELS,
        "past_exogenous_channels": len(PAST_COVARIATE_COLUMNS),
        "future_exogenous_channels": len(KNOWN_FUTURE_COVARIATES),
        "model_input_channels": NUM_CHANNELS + len(PAST_COVARIATE_COLUMNS),
        "model_output_channels": NUM_CHANNELS,
        "experiment_scope": ACTIVE_SPEC.experiment_scope or (
            "target_past_future_exogenous"
            if ACTIVE_SPEC.known_future_covariates
            else "target_past_exogenous"
            if ACTIVE_SPEC.observed_past_covariates
            else "target_only_baseline"
        ),
        "production_comparable": (
            ACTIVE_SPEC.production_comparable
            if ACTIVE_SPEC.production_comparable is not None
            else True
        ),
        "preprocess_entry": DEFAULT_FILES["preprocess_json"],
        "val_metrics": val_metrics,
        "files": DEFAULT_FILES.copy(),
        "created_at": created_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    if session_id:
        metadata["session_id"] = session_id
    if candidate_id:
        metadata["candidate_id"] = candidate_id
    if ref_test_metrics:
        metadata["ref_test_metrics"] = ref_test_metrics
    if cv_metrics:
        metadata["cv_metrics"] = cv_metrics
    if training_summary:
        metadata["training_summary"] = training_summary
    return metadata


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


def _recipe_module_type(recipe: dict[str, Any], key: str) -> str | None:
    value = recipe.get(key)
    if not isinstance(value, dict):
        return None
    module_type = value.get("type")
    return str(module_type) if module_type is not None else None


def _recipe_preprocessing_actions(recipe: dict[str, Any]) -> list[str]:
    preprocessing = recipe.get("preprocessing")
    if not isinstance(preprocessing, dict):
        return []
    actions = preprocessing.get("actions")
    if not isinstance(actions, list):
        return []
    result: list[str] = []
    for action in actions:
        if isinstance(action, dict) and action.get("type") is not None:
            result.append(str(action["type"]))
    return result


def build_model_spec(metadata: dict[str, Any], candidate: dict[str, Any] | None) -> dict[str, Any]:
    recipe = _candidate_recipe(candidate)
    training_summary = metadata.get("training_summary", {})
    if not isinstance(training_summary, dict):
        training_summary = {}
    prediction_head = recipe.get("prediction_head") if isinstance(recipe.get("prediction_head"), dict) else {}
    training_strategy = recipe.get("training_strategy") if isinstance(recipe.get("training_strategy"), dict) else {}
    output_distribution = (
        prediction_head.get("output_distribution")
        if isinstance(prediction_head, dict) and prediction_head.get("output_distribution") is not None
        else training_summary.get("output_distribution", "point")
    )
    quantiles = (
        prediction_head.get("quantiles")
        if isinstance(prediction_head, dict) and isinstance(prediction_head.get("quantiles"), list)
        else training_summary.get("quantiles", [])
    )
    horizon = max(int(item) for item in metadata["horizons"])
    input_channels = int(metadata.get("model_input_channels", metadata["num_channels"]))
    output_channels = int(metadata.get("model_output_channels", metadata["num_channels"]))
    output_shape: list[Any] = [None, horizon, output_channels]
    if output_distribution == "quantile" and isinstance(quantiles, list) and quantiles:
        output_shape.append(len(quantiles))

    num_params_m = training_summary.get("num_params_M")
    estimated_params = int(round(float(num_params_m) * 1_000_000)) if isinstance(num_params_m, (int, float)) else None

    return {
        "schema_version": "model_spec.v1",
        "recipe_id": str(recipe.get("recipe_id") or recipe.get("recipeID") or metadata.get("candidate_id") or metadata["run_id"]),
        "compiled_modules": {
            "preprocessing": _recipe_preprocessing_actions(recipe),
            "embedding": _recipe_module_type(recipe, "embedding"),
            "backbone": _recipe_module_type(recipe, "backbone"),
            "fusion": _recipe_module_type(recipe, "fusion"),
            "prediction_head": _recipe_module_type(recipe, "prediction_head")
            or str(training_summary.get("prediction_head", "unknown")),
        },
        "input_shape": [None, int(metadata["input_len"]), input_channels],
        "output_shape": output_shape,
        "train_objective": training_strategy.get("loss", {"base": training_summary.get("loss", "unknown")})
        if isinstance(training_strategy, dict)
        else {"base": training_summary.get("loss", "unknown")},
        "inference_policy": {
            "horizons": list(metadata["horizons"]),
            "output_distribution": output_distribution,
            **({"quantiles": quantiles} if isinstance(quantiles, list) and quantiles else {}),
        },
        "estimated_params": estimated_params,
        "runtime_semantics_revision": metadata.get("runtime_semantics_revision", 2),
        "implementation_status": "paper_derived" if _recipe_module_type(recipe, "backbone") == "timesnet_lite" else "native",
    }


def build_patch_bundle(
    metadata: dict[str, Any],
    candidate: dict[str, Any] | None,
    model_spec: dict[str, Any],
) -> dict[str, Any]:
    recipe = _candidate_recipe(candidate)
    candidate_id = (
        str(candidate.get("candidate_id") or candidate.get("id"))
        if isinstance(candidate, dict) and (candidate.get("candidate_id") or candidate.get("id"))
        else str(metadata.get("candidate_id") or model_spec["recipe_id"])
    )
    return {
        "schema_version": "patch_bundle.v1",
        "proposal_id": candidate_id,
        "recipe_delta": {
            "mode": "replace_recipe",
            "candidate_recipe": recipe,
        },
        "compiled_model_delta": dict(model_spec.get("compiled_modules", {})),
        "code_patch_text": None,
        "manifest": {
            "change_type": "registry_composition",
            "run_id": metadata["run_id"],
            "model_spec": metadata["files"]["model_spec_json"],
            "validation": "schema_validated",
        },
    }


def _metric_columns(metrics: dict[str, Any], *, prefix: str, horizons: list[int]) -> list[str]:
    candidate_columns = ["mse", "mae", "pinball", "crps_approx"]
    interval_columns: set[str] = set()
    interval_pattern = re.compile(rf"^{re.escape(prefix)}_(?:avg|h[0-9]+)_(interval_[0-9]+_(?:coverage|width))$")
    for key in metrics:
        match = interval_pattern.match(key)
        if match:
            interval_columns.add(match.group(1))

    columns = [
        column
        for column in candidate_columns
        if metrics.get(f"{prefix}_avg_{column}") is not None
        or any(metrics.get(f"{prefix}_h{horizon}_{column}") is not None for horizon in horizons)
    ]
    columns.extend(sorted(interval_columns))
    return columns or ["mse", "mae"]


def render_metrics_table(metrics: dict[str, Any], *, prefix: str, horizons: list[int]) -> list[str]:
    columns = _metric_columns(metrics, prefix=prefix, horizons=horizons)
    rows = [
        f"| split | {' | '.join(columns)} |",
        f"|---|{'|'.join('---:' for _ in columns)}|",
    ]
    rows.append(
        f"| avg | {' | '.join(format_metric(metrics.get(f'{prefix}_avg_{column}')) for column in columns)} |"
    )
    for horizon in horizons:
        rows.append(
            f"| h{horizon} | "
            f"{' | '.join(format_metric(metrics.get(f'{prefix}_h{horizon}_{column}')) for column in columns)} |"
        )
    return rows


def format_metric(value: Any) -> str:
    if value is None:
        return "NA"
    if isinstance(value, (int, float)):
        return f"{value:.6f}"
    return str(value)


def render_eval_report(metadata: dict[str, Any], research_trace: dict[str, Any] | None = None) -> str:
    val_metrics = metadata["val_metrics"]
    ref_test_metrics = metadata.get("ref_test_metrics")
    training_summary = metadata.get("training_summary", {})

    lines: list[str] = [
        "# neo-cast Evaluation Report",
        "",
        "## Task",
        f"- task_id: `{metadata['task_id']}`",
        f"- input_len: `{metadata['input_len']}`",
        f"- horizons: `{metadata['horizons']}`",
        f"- num_channels: `{metadata['num_channels']}`",
        f"- normalization_space: `{metadata['normalization_space']}`",
        f"- feature_names: `{metadata['feature_names']}`",
        f"- experiment_scope: `{metadata.get('experiment_scope', 'unspecified')}`",
        f"- production_comparable: `{metadata.get('production_comparable', True)}`",
        f"- preprocess_entry: `{metadata['preprocess_entry']}`",
        "",
        "## Model",
        f"- model_family: `{metadata['model_family']}`",
        f"- model_impl_entry: `{metadata['model_impl_entry']}`",
        f"- state_dict_layout: `{metadata['state_dict_layout']}`",
    ]
    if "candidate_id" in metadata:
        lines.append(f"- candidate_id: `{metadata['candidate_id']}`")
    if "session_id" in metadata:
        lines.append(f"- session_id: `{metadata['session_id']}`")
    if training_summary:
        for field in ("runtime_semantics_revision", "implementation_status", "backbone", "num_params_M", "training_seconds", "total_seconds", "peak_vram_mb"):
            if field in training_summary:
                lines.append(f"- {field}: `{training_summary[field]}`")

    lines.extend(["", "## Validation Metrics", ""])
    lines.extend(render_metrics_table(val_metrics, prefix="val", horizons=metadata["horizons"]))
    if ref_test_metrics:
        lines.extend(["", "## Reference Test Metrics", ""])
        lines.extend(render_metrics_table(ref_test_metrics, prefix="ref_test", horizons=metadata["horizons"]))
    trace_entries = research_trace.get("entries", []) if isinstance(research_trace, dict) else []
    if trace_entries:
        lines.extend(["", "## Research Trace", ""])
        for entry in trace_entries:
            if not isinstance(entry, dict):
                continue
            lines.append(f"- decision: `{entry.get('decision', 'NA')}`")
            lines.append(f"  - made_by: `{entry.get('made_by', 'NA')}`")
            evidence = entry.get("evidence", [])
            if isinstance(evidence, list):
                for item in evidence:
                    lines.append(f"  - evidence: {item}")
            lines.append(f"  - expected_effect: {entry.get('expected_effect', 'NA')}")
            lines.append(f"  - verification_plan: {entry.get('verification_plan', 'NA')}")
    lines.extend(["", "## Files"])
    for key, value in metadata["files"].items():
        lines.append(f"- {key}: `{value}`")
    lines.extend(["", f"created_at: `{metadata['created_at']}`"])
    return "\n".join(lines) + "\n"


def _artifact_quantiles(metadata: dict[str, Any]) -> list[float]:
    training_summary = metadata.get("training_summary", {})
    if not isinstance(training_summary, dict):
        return []
    if training_summary.get("output_distribution") != "quantile":
        return []
    quantiles = training_summary.get("quantiles", [])
    if not isinstance(quantiles, list):
        return []
    return [float(value) for value in quantiles]


def render_inference_py() -> str:
    return """from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import numpy as np
import torch

ARTIFACT_DIR = Path(__file__).resolve().parent


def _load_model_impl():
    model_impl_path = ARTIFACT_DIR / "model_impl.py"
    spec = importlib.util.spec_from_file_location("artifact_model_impl", model_impl_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load model_impl.py from {model_impl_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MODEL_IMPL = _load_model_impl()
BUILD_MODEL = MODEL_IMPL.build_model


def _load_json(name: str):
    with (ARTIFACT_DIR / name).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _native_model_config(candidate, metadata):
    config = dict(candidate["model_config"])
    if metadata.get("dataset_schema_version") != "dataset.v2":
        return config
    config.pop("covariate_fusion", None)
    config["num_target_channels"] = metadata["target_channels"]
    config["num_past_covariate_channels"] = metadata["past_exogenous_channels"]
    config["num_future_covariate_channels"] = metadata["future_exogenous_channels"]
    config["num_input_channels"] = metadata["model_input_channels"]
    config["num_output_channels"] = metadata["model_output_channels"]
    config["num_channels"] = metadata["model_input_channels"]
    config["future_covariate_mode"] = str(config.get("future_covariate_mode", "none"))
    return config


def _normalize_history(history, preprocess):
    if isinstance(history, dict):
        if np.asarray(history.get("exogenous_future", [])).size:
            raise ValueError("UNSUPPORTED_COVARIATE: exogenous_future is not supported")
        calendar = {key: history[key] for key in ("timestamps", "calendar_features", "missing_mask") if key in history}
        if "history" in history:
            return {"history": _normalize_history(history["history"], preprocess), **calendar}
        target = np.asarray(history["target_history"], dtype=np.float32)
        past = np.asarray(history.get("exogenous_past", []), dtype=np.float32)
        target_scaler = preprocess["target_scaler"]
        target = (target - np.asarray(target_scaler["mean"], dtype=np.float32)) / np.asarray(target_scaler["scale"], dtype=np.float32)
        covariate_scaler = preprocess.get("covariate_scaler")
        if covariate_scaler is not None:
            mean = np.asarray(covariate_scaler["mean"], dtype=np.float32)
            std = np.asarray(covariate_scaler["scale"], dtype=np.float32)
            past = (past - mean[:past.shape[-1]]) / std[:past.shape[-1]]
        return {"target_history": target, "exogenous_past": past, **calendar}
    array = np.asarray(history, dtype=np.float32)
    mean = np.asarray(preprocess["scaler_mean"], dtype=np.float32)
    std = np.asarray(preprocess["scaler_std"], dtype=np.float32)
    return (array - mean) / std


def load_model(device: str | None = None):
    metadata = _load_json("metadata.json")
    preprocess = _load_json("preprocess.json")
    checkpoint = torch.load(ARTIFACT_DIR / "model.pt", map_location=device or "cpu")
    if checkpoint.get("runtime_semantics_revision") not in (2, 3) or metadata.get("runtime_semantics_revision") != checkpoint.get("runtime_semantics_revision"):
        raise ValueError("Incompatible legacy runtime semantics; retrain with recipe_schema_v2")
    candidate = checkpoint["candidate"]
    for payload in (metadata, metadata.get("training_summary", {}), checkpoint, candidate.get("model_config", {}), preprocess):
        for field in ("used_known_future_covariates", "known_future_covariate_names", "num_future_covariate_channels", "future_exogenous_channels", "static_covariates", "covariate_fusion"):
            if payload.get(field):
                raise ValueError(f"UNSUPPORTED_COVARIATE: legacy artifact contains {field}; retrain without future/static conditioning")
        if payload.get("future_covariate_mode") not in (None, "", "none"):
            raise ValueError("UNSUPPORTED_COVARIATE: legacy future_covariate_mode; retrain")
    state_dicts = checkpoint["state_dicts"]

    device_obj = torch.device(device or "cpu")
    models = {}
    for horizon in metadata["horizons"]:
        state_dict = state_dicts[str(horizon)]
        if any(str(key).startswith(("backbone.", "target_head.", "concat_head.", "future_")) for key in state_dict):
            raise ValueError(
                "Legacy CovariateConditionedForecaster checkpoints are no longer supported. "
                "Re-train the candidate with native fusion."
            )
        model = BUILD_MODEL(_native_model_config(candidate, metadata), metadata["input_len"], horizon).to(device_obj)
        if getattr(model, "runtime_semantics_revision", 2) != checkpoint["runtime_semantics_revision"]:
            raise ValueError("Recipe and checkpoint runtime revisions differ")
        model.load_state_dict(state_dict)
        expected_manifest = checkpoint.get("model_manifests", {}).get(str(horizon), {})
        if expected_manifest.get("parameter_graph_digest"):
            if MODEL_IMPL.parameter_graph_digest(model) != expected_manifest["parameter_graph_digest"]:
                raise ValueError("Model parameter graph differs from the trained artifact; retrain")
        model.eval()
        models[horizon] = model
    return {
        "metadata": metadata,
        "preprocess": preprocess,
        "candidate": candidate,
        "models": models,
        "device": device_obj,
    }


def _inference_inputs(bundle, history, horizon):
    metadata = bundle["metadata"]
    if horizon not in metadata["horizons"]:
        raise ValueError(f"Unsupported horizon: {horizon}")
    calendar = None
    if isinstance(history, dict):
        if np.asarray(history.get("exogenous_future", [])).size:
            raise ValueError("UNSUPPORTED_COVARIATE: exogenous_future is not supported")
        calendar = history.get("calendar_features")
        if calendar is None and "timestamps" in history:
            dates = np.asarray(history["timestamps"], dtype="datetime64[s]")
            if np.isnat(dates).any():
                raise ValueError("calendar requires valid timestamps")
            days = dates.astype("datetime64[D]")
            months = dates.astype("datetime64[M]")
            calendar = np.stack([
                (dates - days).astype("timedelta64[h]").astype(int),
                (days.astype(int) + 3) % 7,
                (days - months.astype("datetime64[D]")).astype(int) + 1,
                months.astype(int) % 12 + 1,
            ], axis=-1).astype(np.float32)
    def tensor(value, shape, name):
        array = np.asarray(value, dtype=np.float32)
        if array.shape != shape:
            raise ValueError(f"Expected {name} shape {shape}, got {array.shape}")
        return torch.from_numpy(array).unsqueeze(0).to(bundle["device"])
    if metadata.get("dataset_schema_version") == "dataset.v2":
        if not isinstance(history, dict):
            raise ValueError("Covariate model requires structured history")
        inputs = {
            key: tensor(history[key], shape, key)
            for key, shape in {
                "target_history": (metadata["input_len"], metadata["target_channels"]),
                "exogenous_past": (metadata["input_len"], metadata["past_exogenous_channels"]),
            }.items()
        }
    else:
        values = history.get("history", history.get("target_history")) if isinstance(history, dict) else history
        inputs = {"x": tensor(values, (metadata["input_len"], metadata["num_channels"]), "history")}
    if calendar is not None:
        inputs["calendar_features"] = tensor(calendar, (metadata["input_len"], 4), "calendar_features")
    if isinstance(history, dict) and "missing_mask" in history:
        channels = metadata.get("model_input_channels", metadata.get("num_channels", metadata.get("target_channels")))
        inputs["missing_mask"] = tensor(history["missing_mask"], (metadata["input_len"], channels), "missing_mask")
    return inputs


def predict_normalized(bundle, history, horizon: int):
    inputs = _inference_inputs(bundle, history, horizon)
    with torch.no_grad():
        pred = bundle["models"][horizon](**inputs)
    return pred.squeeze(0).cpu().numpy()


def predict_quantiles_normalized(bundle, history, horizon: int):
    inputs = _inference_inputs(bundle, history, horizon)
    model = bundle["models"][horizon]
    with torch.no_grad():
        pred = model.forward_quantiles(**inputs) if hasattr(model, "forward_quantiles") else model(**inputs).unsqueeze(-1)
    return pred.squeeze(0).cpu().numpy()


def predict_distribution_normalized(bundle, history, horizon: int):
    inputs = _inference_inputs(bundle, history, horizon)
    with torch.no_grad():
        mean, scale = bundle["models"][horizon].forward_distribution(**inputs)
    return {"mean": mean.squeeze(0).cpu().numpy(), "scale": scale.squeeze(0).cpu().numpy()}


def predict_distribution_raw(bundle, history, horizon: int):
    result = predict_distribution_normalized(bundle, _normalize_history(history, bundle["preprocess"]), horizon)
    scaler = bundle["preprocess"].get("target_scaler")
    mean = np.asarray(scaler["mean"] if scaler else bundle["preprocess"]["scaler_mean"], dtype=np.float32)
    std = np.asarray(scaler["scale"] if scaler else bundle["preprocess"]["scaler_std"], dtype=np.float32)
    return {"mean": result["mean"] * std + mean, "scale": result["scale"] * np.abs(std)}


def predict_raw(bundle, history, horizon: int):
    normalized = _normalize_history(history, bundle["preprocess"])
    prediction = predict_normalized(bundle, normalized, horizon)
    scaler = bundle["preprocess"].get("target_scaler")
    if scaler is None:
        mean = np.asarray(bundle["preprocess"]["scaler_mean"], dtype=np.float32)
        std = np.asarray(bundle["preprocess"]["scaler_std"], dtype=np.float32)
    else:
        mean = np.asarray(scaler["mean"], dtype=np.float32)
        std = np.asarray(scaler["scale"], dtype=np.float32)
    return prediction * std + mean


def predict_quantiles_raw(bundle, history, horizon: int):
    normalized = _normalize_history(history, bundle["preprocess"])
    prediction = predict_quantiles_normalized(bundle, normalized, horizon)
    scaler = bundle["preprocess"].get("target_scaler")
    if scaler is None:
        mean = np.asarray(bundle["preprocess"]["scaler_mean"], dtype=np.float32)
        std = np.asarray(bundle["preprocess"]["scaler_std"], dtype=np.float32)
    else:
        mean = np.asarray(scaler["mean"], dtype=np.float32)
        std = np.asarray(scaler["scale"], dtype=np.float32)
    return prediction * std[:, None] + mean[:, None]
"""


def render_tool_schema(metadata: dict[str, Any]) -> dict[str, Any]:
    output_properties: dict[str, Any] = {
        "horizon": {"type": "integer", "enum": list(metadata["horizons"])},
        "prediction": {
            "type": "array",
            "description": "Point forecast with shape [horizon, num_channels].",
            "items": {"type": "array", "items": {"type": "number"}},
        },
        "normalization_space": {"type": "string"},
    }
    required = ["horizon", "prediction", "normalization_space"]
    summary = metadata.get("training_summary", {})
    if summary.get("output_distribution") == "gaussian":
        output_properties["mean"] = {"type": "array", "items": {"type": "array", "items": {"type": "number"}}}
        output_properties["scale"] = {"type": "array", "description": "Positive standard deviation, same units as mean.", "items": {"type": "array", "items": {"type": "number", "exclusiveMinimum": 0}}}
        required.extend(["mean", "scale"])
    quantiles = _artifact_quantiles(metadata)
    if quantiles:
        output_properties["quantiles"] = {
            "type": "array",
            "items": {"type": "number", "enum": quantiles},
        }
        output_properties["quantile_prediction"] = {
            "type": "array",
            "description": "Quantile forecast with shape [horizon, num_channels, quantile].",
            "items": {
                "type": "array",
                "items": {
                    "type": "array",
                    "items": {"type": "number"},
                },
            },
        }
        required.extend(["quantiles", "quantile_prediction"])

    return {
        "name": "forecast",
        "description": (
            f"Forecast {metadata['task_id']} multivariate time series from "
            f"a {metadata['input_len']}-step history window."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "history": {
                    "type": "array",
                    "description": (
                        f"Shape [{metadata['input_len']}, {metadata['num_channels']}] "
                        f"in raw feature space ordered as {metadata['feature_names']}"
                    ),
                    "items": {"type": "array", "items": {"type": "number"}},
                },
                "horizon": {
                    "type": "integer",
                    "enum": list(metadata["horizons"]),
                },
                "timestamps": {
                    "type": "array", "items": {"type": "string"},
                    "minItems": metadata["input_len"], "maxItems": metadata["input_len"],
                    "description": "Actual timestamps aligned with history rows; required for calendar embedding.",
                },
            },
            "required": ["history", "horizon"] + (["timestamps"] if summary.get("embedding") == "calendar" else []),
        },
        "outputSchema": {
            "type": "object",
            "properties": output_properties,
            "required": required,
        },
    }


def render_mcp_server_py() -> str:
    return """from __future__ import annotations

from mcp.server.fastmcp import FastMCP

from inference import load_model, predict_quantiles_raw, predict_distribution_raw, predict_raw


mcp = FastMCP("neo-cast-artifact")
MODEL_BUNDLE = load_model()


@mcp.tool()
def forecast(history: list[list[float]], horizon: int, timestamps: list[str] | None = None) -> dict:
    if timestamps is not None:
        history = {"history": history, "timestamps": timestamps}
    prediction = predict_raw(MODEL_BUNDLE, history, horizon)
    result = {
        "horizon": horizon,
        "prediction": prediction.tolist(),
        "normalization_space": MODEL_BUNDLE["metadata"]["normalization_space"],
    }
    training_summary = MODEL_BUNDLE["metadata"].get("training_summary", {})
    if training_summary.get("output_distribution") == "gaussian":
        distribution = predict_distribution_raw(MODEL_BUNDLE, history, horizon)
        result.update({key: value.tolist() for key, value in distribution.items()})
    if training_summary.get("output_distribution") == "quantile":
        quantile_prediction = predict_quantiles_raw(MODEL_BUNDLE, history, horizon)
        result["quantiles"] = training_summary.get("quantiles", [])
        result["quantile_prediction"] = quantile_prediction.tolist()
    return result


if __name__ == "__main__":
    mcp.run()
"""


def render_example_py() -> str:
    return """from __future__ import annotations

import json
import sys
from pathlib import Path

from inference import load_model, predict_raw


def main() -> None:
    preprocess = json.loads((Path(__file__).resolve().parent / "preprocess.json").read_text(encoding="utf-8"))
    bundle = load_model()
    metadata = bundle["metadata"]
    if len(sys.argv) == 2:
        history = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    elif len(sys.argv) != 1 or metadata.get("training_summary", {}).get("embedding") == "calendar":
        raise SystemExit("Usage: python example.py history.json (calendar models require real aligned timestamps)")
    elif metadata.get("dataset_schema_version") == "dataset.v2":
        history = {
            "target_history": [preprocess["target_scaler"]["mean"] for _ in range(metadata["input_len"])],
            "exogenous_past": [(preprocess.get("covariate_scaler") or {}).get("mean", []) for _ in range(metadata["input_len"])],
        }
    else:
        history = [preprocess["scaler_mean"] for _ in range(preprocess["input_len"])]
    prediction = predict_raw(bundle, history, bundle["metadata"]["horizons"][0])
    print(prediction.shape)


if __name__ == "__main__":
    main()
"""


def render_readme_md(metadata: dict[str, Any], candidate: dict[str, Any] | None) -> str:
    lines = [
        "# neo-cast Artifact",
        "",
        f"This artifact was exported by `neo-cast` for the `{metadata['task_id']}` task.",
        "",
        "## Summary",
        f"- model_family: `{metadata['model_family']}`",
        f"- candidate_id: `{metadata.get('candidate_id', 'NA')}`",
        f"- run_id: `{metadata['run_id']}`",
        f"- input_len: `{metadata['input_len']}`",
        f"- horizons: `{metadata['horizons']}`",
        f"- feature_names: `{metadata['feature_names']}`",
    ]
    if candidate and candidate.get("hypothesis"):
        lines.append(f"- hypothesis: `{candidate['hypothesis']}`")

    lines.extend(
        [
            "",
            "## Files",
            "- `model.pt`: trained weights and candidate payload",
            "- `preprocess.json`: feature order and scaler statistics",
            "- `model_impl.py`: model builder used by the artifact",
            "- `inference.py`: `load_model()`, `predict_normalized()`, `predict_raw()`, `predict_distribution_normalized()`, `predict_distribution_raw()`",
            "- `mcp_server.py`: MCP server exposing `forecast`",
            "- `tool_schema.json`: tool input schema",
            "- `eval_report.md`: validation and optional ref-test report",
            "",
            "## Quickstart",
            "```bash",
            "pip install -r requirements.txt",
            "python example.py",
            "python mcp_server.py",
            "```",
            "",
            "## Input Contract",
            "- Public entrypoint is raw-space input.",
            (
                f"- Input must be an object with `target_history` shape `[{metadata['input_len']}, {metadata['target_channels']}]` "
                f"and `exogenous_past` shape `[{metadata['input_len']}, {metadata['past_exogenous_channels']}]`, ordered as in `preprocess.json`."
                if metadata.get("dataset_schema_version") == "dataset.v2"
                else f"- `history` must be shape `[{metadata['input_len']}, {metadata['num_channels']}]` with feature order matching `preprocess.json`."
            ),
            "- `predict_raw()` normalizes with the stored scaler before inference.",
            "- Calendar models require `{\"history\": [...], \"timestamps\": [...]}` with real aligned timestamps (UTC; naive timestamps are treated as UTC). For dataset.v2, add timestamps to the structured covariate input. `example.py history.json` accepts this input.",
            "- Gaussian models expose `{mean, scale}` via `predict_distribution_raw()`; scale is positive standard deviation in target units. `predict_raw()` remains the point-mean interface.",
            "",
        ]
    )
    return "\n".join(lines) + "\n"


def write_requirements(path: Path) -> None:
    path.write_text("".join(f"{line}\n" for line in DEFAULT_REQUIREMENTS), encoding="utf-8")


def write_export_files(
    artifact_dir: Path,
    metadata: dict[str, Any],
    *,
    candidate: dict[str, Any] | None,
    preprocess: dict[str, Any] | None = None,
) -> tuple[Path, Path]:
    artifact_dir.mkdir(parents=True, exist_ok=True)

    metadata_path = artifact_dir / "metadata.json"
    report_path = artifact_dir / metadata["files"]["eval_report_md"]
    preprocess_path = artifact_dir / metadata["files"]["preprocess_json"]
    model_impl_path = artifact_dir / metadata["files"]["model_impl_py"]
    inference_path = artifact_dir / metadata["files"]["inference_py"]
    tool_schema_path = artifact_dir / "tool_schema.json"
    model_spec_path = artifact_dir / metadata["files"]["model_spec_json"]
    patch_bundle_path = artifact_dir / metadata["files"]["patch_bundle_json"]
    research_trace_path = artifact_dir / metadata["files"]["research_trace_json"]
    mcp_server_path = artifact_dir / "mcp_server.py"
    readme_path = artifact_dir / "README.md"
    example_path = artifact_dir / "example.py"
    requirements_path = artifact_dir / "requirements.txt"

    research_trace = build_research_trace(metadata, candidate)

    metadata_path.write_text(f"{json.dumps(metadata, indent=2, sort_keys=True)}\n", encoding="utf-8")
    write_json(research_trace_path, research_trace)
    report_path.write_text(render_eval_report(metadata, research_trace=research_trace), encoding="utf-8")
    # Keep the exact scaler/splits used by training, including on later exports.
    if not preprocess_path.exists():
        write_json(preprocess_path, preprocess if preprocess is not None else build_preprocess_spec())
    family_module_path = (
        PY_ROOT / "factory" / "build_model.py"
        if metadata["model_family"] == "recipe_factory"
        else PY_ROOT / "families" / f"{metadata['model_family']}.py"
    )
    model_impl_path.write_text(family_module_path.read_text(encoding="utf-8"), encoding="utf-8")
    if metadata.get("runtime_semantics_revision") == 3 and metadata["model_family"] == "recipe_factory":
        # Copy a uniquely named private runtime, avoiding imports from the host workspace.
        package_name = "_neocast_runtime_" + re.sub(r"[^a-zA-Z0-9_]", "_", metadata["run_id"])
        package_root = artifact_dir / package_name
        package_root.mkdir(exist_ok=True)
        (package_root / "__init__.py").write_text("")
        for directory in ("factory", "registry", "schemas"):
            shutil.copytree(PY_ROOT / directory, package_root / directory, dirs_exist_ok=True,
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        shutil.copy2(PY_ROOT / "validate.py", package_root / "validate.py")
        for source in package_root.rglob("*.py"):
            code = source.read_text()
            for module in ("factory", "registry", "validate"):
                code = code.replace(f"from {module}.", f"from {package_name}.{module}.")
                code = code.replace(f"from {module} import", f"from {package_name}.{module} import")
            source.write_text(code)
        model_impl_path.write_text(
            "import sys\nfrom pathlib import Path\n"
            "sys.path.insert(0, str(Path(__file__).resolve().parent))\n"
            f"from {package_name}.factory.build_model import build_model, parameter_graph_digest\n"
        )
    inference_path.write_text(render_inference_py(), encoding="utf-8")
    write_json(tool_schema_path, render_tool_schema(metadata))
    model_spec = build_model_spec(metadata, candidate)
    write_json(model_spec_path, model_spec)
    write_json(patch_bundle_path, build_patch_bundle(metadata, candidate, model_spec))
    mcp_server_path.write_text(render_mcp_server_py(), encoding="utf-8")
    readme_path.write_text(render_readme_md(metadata, candidate), encoding="utf-8")
    example_path.write_text(render_example_py(), encoding="utf-8")
    write_requirements(requirements_path)
    return metadata_path, report_path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Export a full neo-cast artifact package.")
    parser.add_argument("--artifact-dir", required=True, type=str)
    parser.add_argument("--run-id", required=True, type=str)
    parser.add_argument("--model-family", default=None, type=str)
    parser.add_argument("--model-impl-entry", default=None, type=str)
    parser.add_argument("--state-dict-layout", default=None, type=str)
    parser.add_argument("--val-metrics-json", default=None, type=str)
    parser.add_argument("--ref-test-metrics-json", default=None, type=str)
    parser.add_argument("--training-summary-json", default=None, type=str)
    parser.add_argument("--resolved-candidate-json", default=None, type=str)
    parser.add_argument("--session-id", default=None, type=str)
    parser.add_argument("--candidate-id", default=None, type=str)
    parser.add_argument("--created-at", default=None, type=str)
    return parser


def update_ref_test_export(artifact_dir: Path, *, run_id: str, metrics: dict[str, Any]) -> tuple[Path, Path]:
    """Refresh evaluation documents without rebuilding the trained runtime package."""
    metadata_path = artifact_dir / "metadata.json"
    metadata = load_json(metadata_path)
    if metadata["run_id"] != run_id:
        raise ValueError("Reference-test export run_id does not match the artifact")
    metadata["ref_test_metrics"] = metrics
    errors = validate_metadata_payload(metadata)
    if errors:
        raise ValueError("Invalid reference-test metadata: " + "; ".join(errors))
    candidate = load_json(artifact_dir / "resolved_candidate.json")
    trace = build_research_trace(metadata, candidate)
    report_path = artifact_dir / metadata["files"]["eval_report_md"]
    report = render_eval_report(metadata, research_trace=trace)
    write_json(metadata_path, metadata)
    write_json(artifact_dir / metadata["files"]["research_trace_json"], trace)
    report_path.write_text(report, encoding="utf-8")
    return metadata_path, report_path


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    artifact_dir = Path(args.artifact_dir).expanduser().resolve()
    resolved_candidate_path = (
        Path(args.resolved_candidate_json).expanduser()
        if args.resolved_candidate_json
        else artifact_dir / "resolved_candidate.json"
    )
    candidate = _load_optional_json(resolved_candidate_path)
    val_metrics = _load_optional_json(args.val_metrics_json or artifact_dir / "val_metrics.json")
    if val_metrics is None:
        raise SystemExit("error: val_metrics.json is required")
    ref_test_metrics = _load_optional_json(args.ref_test_metrics_json)
    training_summary = _load_optional_json(args.training_summary_json or artifact_dir / "training_summary.json")
    cv_metrics = _load_optional_json(artifact_dir / "cv_metrics.json")
    preprocess_path = artifact_dir / "preprocess.json"
    preprocess = load_json(preprocess_path) if preprocess_path.exists() else None

    model_family = args.model_family or (candidate or {}).get("model_family")
    if not model_family:
        raise SystemExit("error: model_family is required")

    family_spec = (training_summary or {}).get("export_spec")
    if family_spec is None:
        family_spec = _load_family_module(model_family).FAMILY_SPEC
    model_impl_entry = args.model_impl_entry or family_spec["model_impl_entry"]
    state_dict_layout = args.state_dict_layout or family_spec["state_dict_layout"]
    candidate_id = args.candidate_id or (candidate or {}).get("candidate_id")
    horizons = infer_export_horizons(
        val_metrics=val_metrics,
        ref_test_metrics=ref_test_metrics,
        candidate=candidate,
    )

    metadata = build_metadata(
        run_id=args.run_id,
        model_family=model_family,
        model_impl_entry=model_impl_entry,
        state_dict_layout=state_dict_layout,
        val_metrics=val_metrics,
        cv_metrics=cv_metrics,
        horizons=horizons,
        session_id=args.session_id,
        candidate_id=candidate_id,
        ref_test_metrics=ref_test_metrics,
        training_summary=training_summary,
        created_at=args.created_at,
        preprocess=preprocess,
    )

    errors = validate_metadata_payload(metadata)
    if errors:
        for item in errors:
            print(f"error: {item}")
        raise SystemExit(1)

    metadata_path, report_path = write_export_files(artifact_dir, metadata, candidate=candidate, preprocess=preprocess)
    print("export_status: success")
    print(f"artifact_dir: {artifact_dir}")
    print(f"metadata_path: {metadata_path}")
    print(f"eval_report_path: {report_path}")


if __name__ == "__main__":
    main()
