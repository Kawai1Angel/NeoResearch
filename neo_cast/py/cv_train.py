"""Expanding-window ratio cross-validation wrapper around train.py."""

from __future__ import annotations

import argparse
import concurrent.futures
from contextlib import redirect_stdout
import hashlib
import json
import math
import os
import statistics
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import torch

from runtime_config import ACTIVE_SPEC, HORIZONS, INPUT_LEN


PY_ROOT = Path(__file__).resolve().parent
OVERRIDE_ENV = ("NEO_CAST_TRAIN_ROWS", "NEO_CAST_VAL_ROWS", "NEO_CAST_CV_FOLD_INDEX")


@dataclass(frozen=True)
class TimeSeriesFold:
    fold_index: int
    train_rows: tuple[int, int]
    val_rows: tuple[int, int]


def build_ratio_folds(
    visible_rows: tuple[int, int], *, num_folds: int, initial_train_ratio: float
) -> list[TimeSeriesFold]:
    if num_folds < 2:
        raise ValueError(f"num_folds must be >= 2, got {num_folds}")
    if not 0.0 < initial_train_ratio < 1.0:
        raise ValueError(f"initial_train_ratio must be between 0 and 1, got {initial_train_ratio}")
    visible_start, visible_end = visible_rows
    if visible_end <= visible_start:
        raise ValueError(f"visible_rows must be non-empty, got {visible_rows}")
    visible_length = visible_end - visible_start
    fold_val_ratio = (1.0 - initial_train_ratio) / num_folds
    folds: list[TimeSeriesFold] = []
    for fold_index in range(num_folds):
        train_end_ratio = initial_train_ratio + fold_index * fold_val_ratio
        val_end_ratio = initial_train_ratio + (fold_index + 1) * fold_val_ratio
        train_end = visible_start + round(visible_length * train_end_ratio)
        val_end = visible_end if fold_index == num_folds - 1 else visible_start + round(visible_length * val_end_ratio)
        folds.append(TimeSeriesFold(fold_index, (visible_start, train_end), (train_end, val_end)))
    return folds


def validate_folds(
    folds: list[TimeSeriesFold], *, visible_rows: tuple[int, int], ref_test_start: int,
    input_len: int, max_horizon: int, min_train_windows: int = 1, min_eval_windows: int = 1,
) -> None:
    required_train = input_len + max_horizon + min_train_windows - 1
    required_val = max_horizon + min_eval_windows - 1
    previous_val_end: int | None = None
    for fold in folds:
        train_length = fold.train_rows[1] - fold.train_rows[0]
        val_length = fold.val_rows[1] - fold.val_rows[0]
        valid = (
            fold.train_rows[0] == visible_rows[0]
            and fold.train_rows[1] == fold.val_rows[0]
            and fold.val_rows[1] <= visible_rows[1]
            and fold.val_rows[1] <= ref_test_start
            and (previous_val_end is None or fold.val_rows[0] == previous_val_end)
            and train_length >= required_train
            and val_length >= required_val
        )
        if not valid:
            raise ValueError(
                f"Invalid fold {fold.fold_index}: visible_rows={visible_rows}, train_rows={fold.train_rows} "
                f"(length={train_length}, required>={required_train}), val_rows={fold.val_rows} "
                f"(length={val_length}, required>={required_val}), ref_test_start={ref_test_start}"
            )
        previous_val_end = fold.val_rows[1]
    if not folds or folds[-1].val_rows[1] != visible_rows[1]:
        raise ValueError("Final fold validation range must end at visible_rows end")


def _run_train(cmd: list[str], env: dict[str, str]) -> tuple[int, list[dict[str, Any]]]:
    process = subprocess.Popen(cmd, cwd=str(PY_ROOT.parent), env=env, stdout=subprocess.PIPE, stderr=sys.stderr, text=True)
    records: list[dict[str, Any]] = []
    assert process.stdout is not None
    for line in process.stdout:
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            print(line.rstrip("\n"), flush=True)
            continue
        if isinstance(record, dict):
            records.append(record)
            forwarded = dict(record)
            if "NEO_CAST_CV_FOLD_INDEX" in env:
                forwarded["cv_fold_index"] = int(env["NEO_CAST_CV_FOLD_INDEX"])
                if "artifact_dir" in forwarded:
                    forwarded["ephemeral"] = True
            print(json.dumps(forwarded), flush=True)
        else:
            print(line.rstrip("\n"), flush=True)
    return process.wait(), records


def _event(records: list[dict[str, Any]], name: str) -> dict[str, Any] | None:
    return next((record for record in reversed(records) if record.get("event") == name), None)


class _ForwardingRecords:
    """Tee in-process training output live, retaining the same NDJSON evidence."""

    def __init__(self, output):
        self.output = output
        self.records: list[dict[str, Any]] = []
        self.pending = ""

    def write(self, text: str) -> int:
        self.output.write(text)
        self.pending += text
        while "\n" in self.pending:
            line, self.pending = self.pending.split("\n", 1)
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(record, dict):
                self.records.append(record)
        return len(text)

    def flush(self) -> None:
        self.output.flush()

    def __getattr__(self, name: str):
        return getattr(self.output, name)


def _run_standard_train(train_cmd: list[str], artifact_root: str) -> tuple[int, list[dict[str, Any]]]:
    # Only the standard fit reuses the CV parent. Folds keep independent processes,
    # globals, scalers and CUDA state. Unexpected parent split overrides require a
    # fresh process so prepare_tsf cannot retain the wrong cached split.
    if any(name in os.environ for name in OVERRIDE_ENV):
        env = {key: value for key, value in os.environ.items() if key not in OVERRIDE_ENV}
        return _run_train([*train_cmd, "--artifacts-dir", artifact_root], env)
    import train

    output = _ForwardingRecords(sys.stdout)
    with redirect_stdout(output):
        try:
            # Use the CLI entrypoint to preserve seed reset, normalization,
            # execution-contract verification and deduplication behavior.
            train.main([*train_cmd[2:], "--artifacts-dir", artifact_root])
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
        else:
            code = 0
    return code, output.records


def _finite_metrics(record: dict[str, Any] | None, prefix: str = "val_") -> dict[str, float]:
    if record is None:
        raise RuntimeError("Training subprocess did not emit eval_done")
    metrics = {key: float(value) for key, value in record.items() if key.startswith(prefix) and isinstance(value, (int, float))}
    if "val_avg_mse" not in metrics or any(not math.isfinite(value) for value in metrics.values()):
        raise RuntimeError(f"Training subprocess emitted invalid validation metrics: {metrics}")
    return metrics


def run_cv_fold(
    fold: TimeSeriesFold, *, train_cmd: list[str], temp_root: Path,
) -> tuple[int, dict[str, float]]:
    env = os.environ.copy()
    env.update({
        "NEO_CAST_TRAIN_ROWS": f"{fold.train_rows[0]}:{fold.train_rows[1]}",
        "NEO_CAST_VAL_ROWS": f"{fold.val_rows[0]}:{fold.val_rows[1]}",
        "NEO_CAST_CV_FOLD_INDEX": str(fold.fold_index),
    })
    exit_code, records = _run_train(
        [*train_cmd, "--artifacts-dir", str(temp_root / f"fold_{fold.fold_index}")], env
    )
    if exit_code != 0 or _event(records, "artifact_ready") is None:
        raise RuntimeError(f"CV fold {fold.fold_index} failed with exit code {exit_code}")
    metrics = _finite_metrics(_event(records, "eval_done"))
    missing = [f"val_h{horizon}_mse" for horizon in HORIZONS if f"val_h{horizon}_mse" not in metrics]
    if missing:
        raise RuntimeError(f"CV fold {fold.fold_index} is missing required metrics: {missing}")
    return fold.fold_index, metrics


def run_cv_folds_parallel(
    folds: list[TimeSeriesFold], *, train_cmd: list[str], temp_root: Path, max_workers: int,
) -> list[dict[str, float]]:
    if max_workers < 1:
        raise ValueError(f"max_workers must be >= 1, got {max_workers}")
    metrics_by_fold: dict[int, dict[str, float]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(max_workers, len(folds))) as executor:
        futures = [executor.submit(run_cv_fold, fold, train_cmd=train_cmd, temp_root=temp_root) for fold in folds]
        for future in concurrent.futures.as_completed(futures):
            fold_index, metrics = future.result()
            metrics_by_fold[fold_index] = metrics
    return [metrics_by_fold[fold.fold_index] for fold in folds]


def default_max_parallel_folds() -> int:
    """Avoid competing training processes on a single CUDA device."""
    return 1 if torch.cuda.is_available() else 4


def aggregate_cv_metrics(folds: list[TimeSeriesFold], metrics: list[dict[str, float]], *, initial_train_ratio: float) -> dict[str, Any]:
    if len(folds) != len(metrics):
        raise ValueError(f"Expected {len(folds)} completed folds, got {len(metrics)}")
    metric_keys = sorted(set.intersection(*(set(item) for item in metrics)))
    aggregate: dict[str, Any] = {
        "cv_avg_mse": statistics.fmean(item["val_avg_mse"] for item in metrics),
        "cv_std_mse": statistics.pstdev(item["val_avg_mse"] for item in metrics),
    }
    for key in metric_keys:
        if key == "val_avg_mse":
            continue
        aggregate[f"cv_{key[4:]}"] = statistics.fmean(item[key] for item in metrics)
    aggregate["folds"] = [
        {"fold_index": fold.fold_index, "train_rows": list(fold.train_rows), "val_rows": list(fold.val_rows), **metric}
        for fold, metric in zip(folds, metrics)
    ]
    return aggregate


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resolved-candidate", required=True)
    parser.add_argument("--artifacts-dir", required=True)
    parser.add_argument("--num-folds", type=int, default=4)
    parser.add_argument(
        "--max-parallel-folds",
        type=int,
        default=None,
        help="Concurrent CV folds; defaults to 1 with CUDA and 4 on CPU",
    )
    parser.add_argument("--initial-train-ratio", type=float, default=0.6)
    parser.add_argument("--min-train-windows", type=int, default=1)
    parser.add_argument("--min-eval-windows", type=int, default=1)
    args = parser.parse_args()

    from training_identity import deduplicate_training
    candidate = json.loads(Path(args.resolved_candidate).read_text())

    @deduplicate_training
    def execute(*, artifact_callback=None, **kwargs):
        return _execute_cv(args, artifact_callback)

    return execute(candidate=candidate, smoke=False, artifact_root=Path(args.artifacts_dir),
                   identity_protocol={"kind": "expanding_window_ratio", "num_folds": args.num_folds,
                                      "initial_train_ratio": args.initial_train_ratio, "min_train_windows": args.min_train_windows,
                                      "min_eval_windows": args.min_eval_windows})


def _execute_cv(args, artifact_callback=None):

    visible_rows = (ACTIVE_SPEC.train[0], ACTIVE_SPEC.val[1])
    if visible_rows[1] > ACTIVE_SPEC.ref_test[0]:
        raise ValueError(f"Visible rows {visible_rows} overlap ref-test {ACTIVE_SPEC.ref_test}")
    folds = build_ratio_folds(visible_rows, num_folds=args.num_folds, initial_train_ratio=args.initial_train_ratio)
    validate_folds(folds, visible_rows=visible_rows, ref_test_start=ACTIVE_SPEC.ref_test[0], input_len=INPUT_LEN,
                   max_horizon=max(HORIZONS), min_train_windows=args.min_train_windows, min_eval_windows=args.min_eval_windows)
    temp_workspace = tempfile.TemporaryDirectory(prefix="neo-cast-cv-")
    temp_root = Path(temp_workspace.name)
    candidate_payload = json.loads(Path(args.resolved_candidate).read_text(encoding="utf-8"))
    candidate_snapshot = temp_root / "resolved_candidate.json"
    candidate_snapshot.write_text(json.dumps(candidate_payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    train_cmd = [sys.executable, str(PY_ROOT / "train.py"), "--resolved-candidate", str(candidate_snapshot)]
    print(json.dumps({"event": "cv_candidate_snapshot", "candidate_id": candidate_payload.get("candidate_id"),
                      "snapshot_sha256": hashlib.sha256(candidate_snapshot.read_bytes()).hexdigest()}), flush=True)
    max_parallel_folds = (
        default_max_parallel_folds()
        if args.max_parallel_folds is None
        else args.max_parallel_folds
    )
    print(json.dumps({
        "event": "cv_parallelism",
        "max_parallel_folds": max_parallel_folds,
        "cuda_available": torch.cuda.is_available(),
    }), flush=True)
    fold_metrics = run_cv_folds_parallel(
        folds, train_cmd=train_cmd, temp_root=temp_root, max_workers=max_parallel_folds
    )

    started = time.perf_counter()
    exit_code, records = _run_standard_train(train_cmd, args.artifacts_dir)
    print(json.dumps({"event": "phase_timing", "phase": "standard_fit",
                      "duration_s": round(time.perf_counter() - started, 6)}), flush=True)
    artifact = _event(records, "artifact_ready")
    standard_metrics = _finite_metrics(_event(records, "eval_done")) if exit_code == 0 else {}
    if exit_code != 0 or artifact is None:
        raise RuntimeError(f"Standard training failed with exit code {exit_code}")

    revision = 3 if candidate_payload.get("model_config", {}).get("recipe", {}).get("recipe_version") == "recipe_schema_v3" else 2
    protocol = {"strategy": "expanding_window_ratio", "num_folds": args.num_folds, "runtime_semantics_revision": revision,
                "initial_train_ratio": args.initial_train_ratio,
                "fold_val_ratio": (1.0 - args.initial_train_ratio) / args.num_folds,
                "visible_rows": list(visible_rows), "input_len": INPUT_LEN, "horizons": list(HORIZONS),
                "min_train_windows": args.min_train_windows, "min_eval_windows": args.min_eval_windows}
    protocol["protocol_id"] = "expanding_window_ratio_" + hashlib.sha256(json.dumps(protocol, sort_keys=True).encode()).hexdigest()[:16]
    cv_metrics = {"schema_version": "cv_metrics.v1", "protocol": protocol,
                  **aggregate_cv_metrics(folds, fold_metrics, initial_train_ratio=args.initial_train_ratio)}
    artifact_dir = Path(str(artifact["artifact_dir"]))
    (artifact_dir / "cv_metrics.json").write_text(json.dumps(cv_metrics, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if artifact_callback:
        artifact_callback(artifact_dir)
    print(json.dumps({"event": "cv_eval_done", **standard_metrics,
                      **{key: value for key, value in cv_metrics.items() if key.startswith("cv_")},
                      "cv_protocol_id": protocol["protocol_id"]}), flush=True)
    print(json.dumps(artifact), flush=True)
    print(json.dumps({"event": "done", "status": "success"}), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"event": "error", "kind": exc.__class__.__name__.lower(), "message": str(exc)}), flush=True)
        print(json.dumps({"event": "done", "status": "crash"}), flush=True)
        raise SystemExit(1)
