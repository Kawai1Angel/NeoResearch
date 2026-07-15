#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import multiprocessing as mp
import sys
from pathlib import Path
from typing import Any

import torch


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def metric_columns_for_horizons(horizons: list[int]) -> list[str]:
    columns: list[str] = []
    for split in ("train", "val", "ref_test", "test"):
        columns.extend([f"{split}_avg_mse", f"{split}_avg_mae"])
        for horizon in horizons:
            columns.extend([f"{split}_h{horizon}_mse", f"{split}_h{horizon}_mae"])
    return columns


def move_batch(batch: Any, device: torch.device) -> tuple[Any, torch.Tensor]:
    if isinstance(batch, dict):
        moved = {key: value.to(device) for key, value in batch.items()}
        return moved, moved["target"]
    x, y = batch
    return x.to(device), y.to(device)


def model_inputs(x: Any) -> Any:
    if isinstance(x, dict):
        return {
            "target_history": x["target_history"],
            "exogenous_past": x["exogenous_past"],
            "exogenous_future": x["exogenous_future"],
        }
    return x


def forward_model(model: torch.nn.Module, x: Any) -> torch.Tensor:
    inputs = model_inputs(x)
    pred = model(**inputs) if isinstance(inputs, dict) else model(inputs)
    if isinstance(pred, (tuple, list)):
        pred = pred[0]
    return pred


def evaluate_train_split(models: dict[int, torch.nn.Module], horizons: tuple[int, ...], batch_size: int) -> dict[str, float]:
    from prepare_tsf import make_dataloader

    device = next(iter(models.values())).parameters().__next__().device
    results: dict[str, float] = {}
    mse_values: list[float] = []
    mae_values: list[float] = []
    for horizon in horizons:
        model = models[horizon]
        was_training = model.training
        model.eval()
        total_sq_error = 0.0
        total_abs_error = 0.0
        total_values = 0
        with torch.no_grad():
            for batch in make_dataloader("train", horizon, batch_size=batch_size, shuffle=False):
                x, y = move_batch(batch, device)
                pred = forward_model(model, x)
                if pred.shape != y.shape:
                    raise ValueError(
                        f"train prediction shape mismatch for horizon={horizon}: "
                        f"expected {tuple(y.shape)}, got {tuple(pred.shape)}"
                    )
                diff = pred - y
                total_sq_error += diff.pow(2).sum().item()
                total_abs_error += diff.abs().sum().item()
                total_values += diff.numel()
        if was_training:
            model.train()
        mse = total_sq_error / total_values
        mae = total_abs_error / total_values
        results[f"train_h{horizon}_mse"] = mse
        results[f"train_h{horizon}_mae"] = mae
        mse_values.append(mse)
        mae_values.append(mae)
    results["train_avg_mse"] = sum(mse_values) / len(mse_values)
    results["train_avg_mae"] = sum(mae_values) / len(mae_values)
    return results


def load_models(artifact_dir: Path) -> tuple[dict[int, torch.nn.Module], tuple[int, ...], dict[str, Any]]:
    from prepare_tsf import (
        ACTIVE_SPEC,
        INPUT_LEN,
        KNOWN_FUTURE_COVARIATES,
        PAST_COVARIATE_COLUMNS,
        TARGET_COLUMNS,
    )
    from families import FAMILY_REGISTRY

    checkpoint = torch.load(artifact_dir / "model.pt", map_location="cpu")
    candidate = checkpoint.get("candidate")
    model_family = checkpoint.get("model_family")
    state_dict_layout = checkpoint.get("state_dict_layout")
    state_dicts = checkpoint.get("state_dicts")
    artifact_schema_version = checkpoint.get("dataset_schema_version")

    if not isinstance(candidate, dict):
        raise ValueError(f"artifact missing candidate payload: {artifact_dir}")
    if not isinstance(model_family, str) or model_family not in FAMILY_REGISTRY:
        raise ValueError(f"artifact has unknown model_family={model_family!r}: {artifact_dir}")
    if state_dict_layout != "per_horizon" or not isinstance(state_dicts, dict):
        raise ValueError(f"unsupported checkpoint layout in {artifact_dir}")
    if artifact_schema_version is not None and artifact_schema_version != ACTIVE_SPEC.schema_version:
        raise ValueError(
            f"dataset schema mismatch for {artifact_dir}: artifact={artifact_schema_version!r}, "
            f"active={ACTIVE_SPEC.schema_version!r}"
        )

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    family_module = FAMILY_REGISTRY[model_family]
    horizons = tuple(int(h) for h in candidate["task"]["horizons"])
    models: dict[int, torch.nn.Module] = {}
    for horizon in horizons:
        state_key = str(horizon)
        if state_key not in state_dicts:
            raise ValueError(f"missing state_dict for horizon={horizon}: {artifact_dir}")
        state_dict = state_dicts[state_key]
        if ACTIVE_SPEC.schema_version == "dataset.v2":
            if any(str(key).startswith(("backbone.", "target_head.", "concat_head.", "future_")) for key in state_dict):
                raise ValueError(
                    "Legacy CovariateConditionedForecaster checkpoints are no longer supported. "
                    "Re-train the candidate with native fusion."
                )
            model_config = dict(candidate["model_config"])
            model_config.pop("covariate_fusion", None)
            model_config["num_target_channels"] = len(TARGET_COLUMNS)
            model_config["num_past_covariate_channels"] = len(PAST_COVARIATE_COLUMNS)
            model_config["num_future_covariate_channels"] = len(KNOWN_FUTURE_COVARIATES)
            model_config["num_input_channels"] = len(TARGET_COLUMNS) + len(PAST_COVARIATE_COLUMNS)
            model_config["num_output_channels"] = len(TARGET_COLUMNS)
            model_config["num_channels"] = model_config["num_input_channels"]
            model_config["future_covariate_mode"] = str(model_config.get("future_covariate_mode", "none"))
        else:
            model_config = candidate["model_config"]
        model = family_module.build_model(model_config, INPUT_LEN, horizon).to(device)
        model.load_state_dict(state_dict)
        model.eval()
        models[horizon] = model
    return models, horizons, candidate


def runner_artifact_dir(artifacts: list[dict[str, Any]], run_id: str) -> Path | None:
    for artifact in artifacts:
        if artifact.get("runID") == run_id and artifact.get("kind") == "runner_artifact":
            uri = str(artifact.get("uri", ""))
            return Path(uri.removeprefix("file://")).expanduser()
    return None


def checkpoint_horizons(artifact_dir: Path | None) -> list[int]:
    if artifact_dir is None or not (artifact_dir / "model.pt").exists():
        return []
    try:
        checkpoint = torch.load(artifact_dir / "model.pt", map_location="cpu")
        candidate = checkpoint.get("candidate")
        horizons = candidate.get("task", {}).get("horizons", []) if isinstance(candidate, dict) else []
        return sorted({int(horizon) for horizon in horizons})
    except Exception:
        return []


def evaluate_run_row(
    *,
    run: dict[str, Any],
    artifact_dir: str | None,
    task_id: str,
    dataset: str,
    batch_size: int,
) -> dict[str, Any]:
    from prepare_tsf import evaluate_ref_test_tsf, evaluate_val_tsf

    run_id = str(run["id"])
    artifact_path = Path(artifact_dir).expanduser() if artifact_dir else None
    row: dict[str, Any] = {
        "task_id": task_id,
        "dataset": dataset,
        "research_run_id": run_id,
        "candidate_id": run.get("candidateID", ""),
        "stage": run.get("stage", ""),
        "run_status": run.get("status", ""),
        "updated": run.get("time", {}).get("updated", ""),
        "artifact_dir": str(artifact_path or ""),
        "status": "ok",
    }
    try:
        if artifact_path is None:
            raise FileNotFoundError(f"no runner_artifact for run {run_id}")
        if not (artifact_path / "model.pt").exists():
            raise FileNotFoundError(f"missing model.pt in {artifact_path}")
        models, horizons, candidate = load_models(artifact_path)
        row["model_family"] = candidate.get("model_family", "")
        row["horizons"] = ",".join(str(h) for h in horizons)
        device = next(iter(models.values())).parameters().__next__().device
        row.update(evaluate_train_split(models, horizons, batch_size))
        row.update(evaluate_val_tsf(models, device=device, horizons=horizons))
        ref_test_metrics = evaluate_ref_test_tsf(models, device=device, horizons=horizons)
        row.update(ref_test_metrics)
        for key, value in ref_test_metrics.items():
            if key.startswith("ref_test_"):
                row[f"test_{key[len('ref_test_'):]}"] = value
    except Exception as exc:
        row["status"] = "error"
        row["error"] = str(exc)
    return row


def evaluate_run_worker(queue: mp.Queue, kwargs: dict[str, Any]) -> None:
    queue.put(evaluate_run_row(**kwargs))


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate full-run Neo-Cast checkpoints on train, val, and ref_test splits.")
    parser.add_argument("--task-results-dir", required=True, type=Path)
    parser.add_argument("--limit", type=int, default=3, help="Maximum number of recent full runs to evaluate. Use 0 for all.")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--neo-cast-py", required=True, type=Path)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--per-run-timeout-s", type=int, default=0, help="Seconds before marking one run timeout. Use 0 to disable.")
    parser.add_argument("--run-ids", default="", help="Comma-separated research run ids to evaluate. Empty means use recent/all by --limit.")
    args = parser.parse_args()

    sys.path.insert(0, str(args.neo_cast_py.resolve()))
    from prepare_tsf import DATASET

    runs = read_json(args.task_results_dir / "runs.json")
    artifacts = read_json(args.task_results_dir / "artifacts.json")
    full_runs = [
        run for run in runs
        if run.get("stage") == "full"
    ]
    full_runs.sort(key=lambda run: run.get("time", {}).get("updated", run.get("time", {}).get("created", 0)), reverse=True)
    requested_run_ids = [item.strip() for item in args.run_ids.split(",") if item.strip()]
    if requested_run_ids:
        run_by_id = {str(run["id"]): run for run in full_runs}
        selected = [run_by_id[run_id] for run_id in requested_run_ids if run_id in run_by_id]
        missing = [run_id for run_id in requested_run_ids if run_id not in run_by_id]
        if missing:
            raise SystemExit(f"Unknown full run id(s): {', '.join(missing)}")
    else:
        selected = full_runs if args.limit <= 0 else full_runs[: args.limit]

    selected_artifact_dirs = {
        str(run["id"]): runner_artifact_dir(artifacts, str(run["id"]))
        for run in selected
    }
    all_horizons = sorted({
        horizon
        for artifact_dir in selected_artifact_dirs.values()
        for horizon in checkpoint_horizons(artifact_dir)
    })

    base_columns = [
        "task_id",
        "dataset",
        "research_run_id",
        "candidate_id",
        "stage",
        "run_status",
        "updated",
        "model_family",
        "horizons",
        "status",
        "error",
        "artifact_dir",
    ]
    columns = base_columns + metric_columns_for_horizons(all_horizons)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator="\n")
        writer.writeheader()

        for index, run in enumerate(selected, start=1):
            run_id = str(run["id"])
            artifact_dir = selected_artifact_dirs.get(run_id)
            print(f"[{index}/{len(selected)}] evaluating {run_id}", file=sys.stderr, flush=True)
            worker_kwargs = {
                "run": run,
                "artifact_dir": str(artifact_dir) if artifact_dir is not None else None,
                "task_id": args.task_results_dir.parent.name,
                "dataset": DATASET,
                "batch_size": args.batch_size,
            }
            if args.per_run_timeout_s <= 0:
                row = evaluate_run_row(**worker_kwargs)
            else:
                queue: mp.Queue = mp.Queue()
                process = mp.Process(target=evaluate_run_worker, args=(queue, worker_kwargs))
                process.start()
                process.join(args.per_run_timeout_s)
                if process.is_alive():
                    process.terminate()
                    process.join(10)
                    row = {
                        "task_id": args.task_results_dir.parent.name,
                        "dataset": DATASET,
                        "research_run_id": run_id,
                        "candidate_id": run.get("candidateID", ""),
                        "stage": run.get("stage", ""),
                        "run_status": run.get("status", ""),
                        "updated": run.get("time", {}).get("updated", ""),
                        "artifact_dir": str(artifact_dir or ""),
                        "status": "timeout",
                        "error": f"per-run timeout after {args.per_run_timeout_s}s",
                    }
                else:
                    row = queue.get() if not queue.empty() else {
                        "task_id": args.task_results_dir.parent.name,
                        "dataset": DATASET,
                        "research_run_id": run_id,
                        "candidate_id": run.get("candidateID", ""),
                        "stage": run.get("stage", ""),
                        "run_status": run.get("status", ""),
                        "updated": run.get("time", {}).get("updated", ""),
                        "artifact_dir": str(artifact_dir or ""),
                        "status": "error",
                        "error": f"worker exited with code {process.exitcode} without result",
                    }
            writer.writerow({key: row.get(key, "") for key in columns})
            handle.flush()
    print(args.output)


if __name__ == "__main__":
    main()
