"""
Session-oriented experiment runner for neo-cast.

It handles:
- project-local runner state
- smoke gate execution
- full training execution
- NDJSON event parsing
- results.tsv keep/discard/crash bookkeeping
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import secrets
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from runtime_config import DATASET, PROMOTION_TOKEN_ENV
from research_trace import append_trace_jsonl


PY_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = Path(os.environ.get("NEO_CAST_PROJECT_ROOT", PY_ROOT.parent)).expanduser().resolve()
STATE_DIR = PROJECT_ROOT / ".neo-cast"
RESULTS_PATH = STATE_DIR / "results.tsv"
STATE_PATH = STATE_DIR / "runner_state.json"
CURRENT_CANDIDATE_PATH = STATE_DIR / "current_candidate.json"
RESOLVED_CANDIDATE_PATH = STATE_DIR / "resolved_candidate.json"
ARTIFACTS_DIR = STATE_DIR / "artifacts"
TRACE_PATH = STATE_DIR / "research_trace.jsonl"
APPROVAL_STATE_PATH = STATE_DIR / "approval_state.json"

RESULTS_HEADER = [
    "session_id",
    "run_id",
    "candidate_id",
    "model_family",
    "cv_avg_mse",
    "cv_std_mse",
    "val_avg_mse",
    "val_h96_mse",
    "val_h720_mse",
    "params_M",
    "status",
    "is_best",
    "timestamp",
]


@dataclass
class RunnerState:
    session_id: str
    best_run_id: str | None
    best_val_avg_mse: float | None
    keep_count: int
    crash_streak: int
    candidate_counter: int
    initialized_at: str
    session_started_at: str
    no_improve_streak: int = 0
    last_improve_at: str | None = None
    best_cv_avg_mse: float | None = None
    best_cv_protocol_id: str | None = None

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "RunnerState":
        if "session_started_at" not in payload:
            payload = {**payload, "session_started_at": payload.get("initialized_at", _now_iso())}
        payload.setdefault("no_improve_streak", 0)
        payload.setdefault("last_improve_at", None)
        payload.setdefault("best_cv_avg_mse", None)
        payload.setdefault("best_cv_protocol_id", None)
        return cls(**payload)


def _make_session_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    suffix = hex(int(time.time() * 1_000_000))[-4:]
    return f"{stamp}-{suffix}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def ensure_state_dir() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)


def ensure_results_file(force: bool = False) -> None:
    ensure_state_dir()
    if RESULTS_PATH.exists() and not force:
        return
    with RESULTS_PATH.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, delimiter="\t", lineterminator="\n")
        writer.writerow(RESULTS_HEADER)


def load_state() -> RunnerState:
    if not STATE_PATH.exists():
        raise FileNotFoundError(f"{STATE_PATH} not found. Run `python runner.py init` first.")
    with STATE_PATH.open("r", encoding="utf-8") as handle:
        return RunnerState.from_dict(json.load(handle))


def save_state(state: RunnerState) -> None:
    ensure_state_dir()
    with STATE_PATH.open("w", encoding="utf-8") as handle:
        json.dump(asdict(state), handle, indent=2, sort_keys=True)
        handle.write("\n")


def init_state(force: bool) -> RunnerState:
    state = RunnerState(
        session_id=_make_session_id(),
        best_run_id=None,
        best_val_avg_mse=None,
        best_cv_avg_mse=None,
        best_cv_protocol_id=None,
        keep_count=0,
        crash_streak=0,
        candidate_counter=0,
        initialized_at=_now_iso(),
        session_started_at=_now_iso(),
        no_improve_streak=0,
        last_improve_at=None,
    )
    if STATE_PATH.exists() and not force:
        raise FileExistsError(f"{STATE_PATH} already exists. Use --force to overwrite it.")
    ensure_results_file(force=force)
    save_state(state)
    return state


def load_results() -> list[dict[str, str]]:
    if not RESULTS_PATH.exists():
        return []
    with RESULTS_PATH.open("r", newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle, delimiter="\t"))


def save_results(rows: list[dict[str, str]]) -> None:
    ensure_results_file(force=True)
    with RESULTS_PATH.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=RESULTS_HEADER, delimiter="\t", lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def append_result(row: dict[str, str]) -> None:
    rows = load_results()
    rows.append(row)
    save_results(rows)


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError(f"Expected object at {path}, got {type(payload).__name__}")
    return payload


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{json.dumps(payload, indent=2, sort_keys=True)}\n", encoding="utf-8")


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_approval_state() -> dict[str, Any] | None:
    if not APPROVAL_STATE_PATH.exists():
        return None
    try:
        payload = read_json(APPROVAL_STATE_PATH)
    except (OSError, json.JSONDecodeError, ValueError):
        return None
    return payload if payload.get("schema_version") == "approval_state.v1" else None


def _save_approval_state(payload: dict[str, Any]) -> None:
    write_json(APPROVAL_STATE_PATH, payload)


def _approval_block_reason() -> dict[str, str] | None:
    payload = _load_approval_state()
    if payload is None:
        return None
    checkpoint = (payload.get("checkpoints") or {}).get("model_design")
    if not isinstance(checkpoint, dict):
        return None
    expected_hash = checkpoint.get("subject_hash")
    if not expected_hash:
        return None
    status = str(checkpoint.get("status") or "pending")
    try:
        current_hash = _file_sha256(CURRENT_CANDIDATE_PATH)
    except OSError:
        return {
            "status": str(checkpoint.get("status") or "unknown"),
            "reason": "candidate_missing",
        }
    if current_hash != expected_hash:
        if status == "approved":
            return None
        return {
            "status": status,
            "reason": "checkpoint_subject_mismatch",
        }
    if status != "approved":
        return {
            "status": status,
            "reason": "checkpoint_not_approved",
        }
    return None


def _set_approval_stage(stage: str) -> None:
    payload = _load_approval_state()
    if payload is None:
        return
    payload["current_stage"] = stage
    _save_approval_state(payload)


def format_metric(value: float | None, decimals: int = 6) -> str:
    if value is None:
        return "NA"
    return f"{value:.{decimals}f}"


def _run_and_capture(cmd: list[str]) -> tuple[int, list[dict[str, Any]]]:
    proc = subprocess.Popen(
        cmd,
        cwd=str(PROJECT_ROOT),
        stdout=subprocess.PIPE,
        stderr=sys.stderr,
        text=True,
    )
    records: list[dict[str, Any]] = []
    if proc.stdout is None:
        raise RuntimeError("runner subprocess stdout pipe is unavailable")
    for raw_line in proc.stdout:
        line = raw_line.rstrip("\n")
        if not line:
            continue
        print(line, flush=True)
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            records.append(payload)
    return proc.wait(), records


def _parse_artifact_record(records: list[dict[str, Any]]) -> tuple[str | None, Path | None]:
    for record in reversed(records):
        if record.get("event") == "artifact_ready":
            run_id = record.get("run_id")
            artifact_dir = record.get("artifact_dir")
            return run_id, Path(artifact_dir).expanduser() if isinstance(artifact_dir, str) else None
    return None, None


def _parse_eval_metrics(records: list[dict[str, Any]]) -> dict[str, float] | None:
    for event_name in ("cv_eval_done", "eval_done", "smoke_eval_done"):
      for record in reversed(records):
        if record.get("event") == event_name:
            return {
                key: value
                for key, value in record.items()
                if (key.startswith("val_") or key.startswith("cv_")) and isinstance(value, (int, float, str))
            }
    return None


def _records_indicate_candidate_failure(records: list[dict[str, Any]]) -> bool:
    candidate_error_kinds = {"param_budget_exceeded"}
    for record in records:
        if record.get("event") == "error" and record.get("kind") in candidate_error_kinds:
            return True
        if record.get("event") == "done" and record.get("status") in {"smoke_fail", "full_fail"}:
            return True
    return False


def _candidate_safe_exit_code(exit_code: int, records: list[dict[str, Any]]) -> int:
    if exit_code == 0:
        return 0
    if exit_code == 2:
        return 1
    if _records_indicate_candidate_failure(records):
        return 1
    return exit_code


def _metric_horizons(metrics: dict[str, Any] | None) -> list[int]:
    if not isinstance(metrics, dict):
        return []
    horizons: list[int] = []
    for key in metrics.keys():
        if not key.startswith("val_h") or not key.endswith("_mse"):
            continue
        raw_horizon = key[len("val_h") : -len("_mse")]
        try:
            horizon = int(raw_horizon)
        except ValueError:
            continue
        if horizon not in horizons:
            horizons.append(horizon)
    return sorted(horizons)


def _candidate_task_horizons(candidate: dict[str, Any]) -> list[int]:
    try:
        horizons = candidate.get("task", {}).get("horizons", [])
        return sorted({int(horizon) for horizon in horizons})
    except (TypeError, ValueError):
        return []


def _val_metrics_for_run(run_id: str | None) -> dict[str, Any] | None:
    if not run_id:
        return None
    metrics_path = ARTIFACTS_DIR / f"run_{run_id}" / "val_metrics.json"
    try:
        return read_json(metrics_path)
    except (FileNotFoundError, json.JSONDecodeError, OSError, ValueError):
        return None


def _horizon_signature(horizons: list[int]) -> str:
    return ",".join(str(horizon) for horizon in sorted(horizons)) or "unknown"


def _best_is_comparable(state: RunnerState, current_horizons: list[int]) -> bool:
    if state.best_val_avg_mse is None or state.best_run_id is None:
        return True
    best_horizons = _metric_horizons(_val_metrics_for_run(state.best_run_id))
    if not best_horizons or not current_horizons:
        return True
    return best_horizons == sorted(current_horizons)


def _cv_improved(state: RunnerState, cv_avg_mse: float, protocol_id: str) -> tuple[bool, bool]:
    comparable = state.best_cv_protocol_id in {None, protocol_id}
    improved = state.best_cv_avg_mse is None or not comparable or cv_avg_mse < state.best_cv_avg_mse
    return improved, comparable


def _write_training_curves(records: list[dict[str, Any]], artifact_dir: Path | None) -> None:
    if artifact_dir is None:
        return
    epoch_records = [record for record in records if record.get("event") == "epoch_end"]
    if not epoch_records:
        return

    curves: dict[str, list[float]] = {}
    for record in epoch_records:
        horizon = str(record.get("horizon", "unknown"))
        try:
            value = float(record["val_loss"])
        except (TypeError, ValueError):
            continue
        except KeyError:
            continue
        curves.setdefault(horizon, []).append(value)

    try:
        training_curves_path = artifact_dir / "training_curves.json"
        training_curves_path.write_text(
            f"{json.dumps({'curves_by_horizon': curves}, indent=2)}\n",
            encoding="utf-8",
        )
    except OSError:
        pass


def _resolve_candidate() -> int:
    renderer_cmd = [
        sys.executable,
        str(PY_ROOT / "renderer.py"),
        "--candidate-path",
        str(CURRENT_CANDIDATE_PATH),
        "--resolved-path",
        str(RESOLVED_CANDIDATE_PATH),
    ]
    renderer_exit, _ = _run_and_capture(renderer_cmd)
    return renderer_exit


def _resolved_candidate_is_fresh() -> bool:
    try:
        if not CURRENT_CANDIDATE_PATH.exists() or not RESOLVED_CANDIDATE_PATH.exists():
            return False
        if RESOLVED_CANDIDATE_PATH.stat().st_mtime < CURRENT_CANDIDATE_PATH.stat().st_mtime:
            return False
        resolved = read_json(RESOLVED_CANDIDATE_PATH)
    except (OSError, json.JSONDecodeError, ValueError):
        return False
    return isinstance(resolved.get("candidate_id"), str) and isinstance(resolved.get("model_family"), str)


def _export_artifact(
    *,
    state: RunnerState,
    run_id: str,
    artifact_dir: Path,
    ref_test_metrics_json: Path | None = None,
) -> int:
    export_cmd = [
        sys.executable,
        str(PY_ROOT / "export.py"),
        "--artifact-dir",
        str(artifact_dir),
        "--run-id",
        run_id,
        "--session-id",
        state.session_id,
    ]
    if ref_test_metrics_json is not None:
        export_cmd.extend(["--ref-test-metrics-json", str(ref_test_metrics_json)])
    export_exit, _ = _run_and_capture(export_cmd)
    return export_exit


def _append_artifact_trace(artifact_dir: Path) -> None:
    trace_json_path = artifact_dir / "research_trace.json"
    try:
        trace = read_json(trace_json_path)
        append_trace_jsonl(TRACE_PATH, trace)
    except (FileNotFoundError, json.JSONDecodeError, OSError, ValueError):
        return


def _candidate_context() -> tuple[str, str]:
    resolved = read_json(RESOLVED_CANDIDATE_PATH)
    return str(resolved["candidate_id"]), str(resolved["model_family"])


def _candidate_context_from_current(fallback_candidate_id: str) -> tuple[str, str]:
    try:
        payload = read_json(CURRENT_CANDIDATE_PATH)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return fallback_candidate_id, "unknown"
    if not isinstance(payload, dict):
        return fallback_candidate_id, "unknown"

    candidate_id = payload.get("candidate_id") or payload.get("recipe_id") or fallback_candidate_id
    model_family = payload.get("model_family")
    if model_family is None and payload.get("recipe_version") == "recipe_schema_v1":
        backbone = payload.get("backbone")
        backbone_type = backbone.get("type") if isinstance(backbone, dict) else "unknown"
        model_family = f"recipe:{backbone_type}"
    return str(candidate_id), str(model_family or "unknown")


# NOTE: The `is_best` column is preserved in RESULTS_HEADER for backward-compat
# schema reasons, but it is no longer authoritative. The TS Research Service's
# `research_champion` table is the single source of truth for champion selection.
# This writer always emits "0" so the Python runner cannot drift from the TS DB.
def _write_result_row(
    *,
    state: RunnerState,
    run_id: str,
    candidate_id: str,
    model_family: str,
    val_metrics: dict[str, float] | None,
    cv_metrics: dict[str, Any] | None = None,
    params_m: float | None,
    status: str,
) -> None:
    append_result(
        {
            "session_id": state.session_id,
            "run_id": run_id,
            "candidate_id": candidate_id,
            "model_family": model_family,
            "cv_avg_mse": format_metric(cv_metrics.get("cv_avg_mse") if cv_metrics else None),
            "cv_std_mse": format_metric(cv_metrics.get("cv_std_mse") if cv_metrics else None),
            "val_avg_mse": format_metric(val_metrics.get("val_avg_mse") if val_metrics else None),
            "val_h96_mse": format_metric(val_metrics.get("val_h96_mse") if val_metrics else None),
            "val_h720_mse": format_metric(val_metrics.get("val_h720_mse") if val_metrics else None),
            "params_M": format_metric(params_m, decimals=2),
            "status": status,
            "is_best": "0",
            "timestamp": _now_iso(),
        }
    )


def run_experiment(state: RunnerState, *, description: str, skip_smoke: bool) -> int:
    if not CURRENT_CANDIDATE_PATH.exists():
        raise FileNotFoundError(
            f"{CURRENT_CANDIDATE_PATH} not found. Write a candidate JSON there or pass --candidate-path in a later CLI layer."
        )
    block_reason = _approval_block_reason()
    if block_reason is not None:
        print("runner_status=pending_approval")
        print("runner_checkpoint_stage=model_design")
        print(f"runner_checkpoint_status={block_reason['status']}")
        print(f"runner_checkpoint_reason={block_reason['reason']}")
        return 5

    contract_path = os.environ.get("NEO_CAST_EXECUTION_CONTRACT")
    if contract_path and skip_smoke:
        from execution_contract import load_contract, digest, compare
        try:
            contract = load_contract(contract_path)
            proof = read_json(Path(os.environ.get("NEO_CAST_CONTRACT_VERIFICATION", "")))
            current_digest = digest(read_json(CURRENT_CANDIDATE_PATH))
            if proof.get("status") != "verified" or proof.get("candidate_id") != contract["candidate_id"] or proof.get("contract_digest") != digest(contract) or current_digest != contract["candidate_spec_sha256"] or compare(contract, proof.get("manifest", {})):
                raise ValueError("No matching verified smoke contract")
        except Exception as exc:
            print(json.dumps({"event": "execution_contract_violation", "status": "invalid", "mismatches": [{"path": "smoke_verification", "expected": "matching verified smoke", "actual": str(exc)}]}), flush=True)
            return 5

    state.candidate_counter += 1
    save_state(state)
    _set_approval_stage("train_eval_running")

    if skip_smoke:
        if not _resolved_candidate_is_fresh():
            renderer_exit = _resolve_candidate()
            if renderer_exit != 0:
                return renderer_exit
        candidate_id, model_family = _candidate_context()
    else:
        candidate_id = f"smoke_{state.candidate_counter}"
        model_family = "unknown"

    if not skip_smoke:
        smoke_cmd = [
            sys.executable,
            str(PY_ROOT / "validate.py"),
            "smoke",
            "--candidate-path",
            str(CURRENT_CANDIDATE_PATH),
            "--resolved-path",
            str(RESOLVED_CANDIDATE_PATH),
            "--artifacts-dir",
            str(ARTIFACTS_DIR),
        ]
        smoke_exit, smoke_records = _run_and_capture(smoke_cmd)

        if smoke_exit != 0:
            candidate_id, model_family = _candidate_context_from_current(f"smoke_{state.candidate_counter}")
            status = "invalid" if smoke_exit in {2, 5} else "smoke_fail"
            state.crash_streak = state.crash_streak + 1 if status == "smoke_fail" else state.crash_streak
            save_state(state)
            run_id, _ = _parse_artifact_record(smoke_records)
            _write_result_row(
                state=state,
                run_id=run_id or f"smoke_{state.candidate_counter}",
                candidate_id=candidate_id,
                model_family=model_family,
                val_metrics=_parse_eval_metrics(smoke_records),
                params_m=None,
                status=status,
            )
            return _candidate_safe_exit_code(smoke_exit, smoke_records)

        candidate_id, model_family = _candidate_context()

    train_cmd = [
        sys.executable,
        str(PY_ROOT / "cv_train.py"),
        "--resolved-candidate",
        str(RESOLVED_CANDIDATE_PATH),
        "--artifacts-dir",
        str(ARTIFACTS_DIR),
        "--num-folds",
        "4",
        "--max-parallel-folds",
        "4",
    ]
    train_exit, train_records = _run_and_capture(train_cmd)
    candidate_id, model_family = _candidate_context()
    run_id, artifact_dir = _parse_artifact_record(train_records)
    val_metrics = _parse_eval_metrics(train_records)

    if any(record.get("event") == "execution_contract_violation" for record in train_records):
        return 5
    if train_exit != 0 or run_id is None or artifact_dir is None or val_metrics is None:
        state.crash_streak += 1
        save_state(state)
        _write_result_row(
            state=state,
            run_id=run_id or f"crash_{state.candidate_counter}",
            candidate_id=candidate_id,
            model_family=model_family,
            val_metrics=val_metrics,
            params_m=None,
            status="crash",
        )
        return _candidate_safe_exit_code(train_exit if train_exit != 0 else 1, train_records)

    training_summary = read_json(artifact_dir / "training_summary.json")
    cv_metrics = read_json(artifact_dir / "cv_metrics.json")
    resolved_candidate = read_json(RESOLVED_CANDIDATE_PATH)
    params_m = float(training_summary.get("num_params_M", 0.0))
    val_avg_mse = float(val_metrics["val_avg_mse"])
    cv_avg_mse = float(cv_metrics["cv_avg_mse"])
    cv_protocol_id = str(cv_metrics["protocol"]["protocol_id"])
    _write_training_curves(train_records, artifact_dir)

    export_exit = _export_artifact(state=state, run_id=run_id, artifact_dir=artifact_dir)
    if export_exit != 0:
        state.crash_streak += 1
        save_state(state)
        _write_result_row(
            state=state,
            run_id=run_id,
            candidate_id=candidate_id,
            model_family=model_family,
            val_metrics=val_metrics,
            params_m=params_m,
            status="crash",
        )
        return export_exit
    _append_artifact_trace(artifact_dir)

    current_horizons = _metric_horizons(val_metrics) or _candidate_task_horizons(resolved_candidate)
    improved, comparable = _cv_improved(state, cv_avg_mse, cv_protocol_id)
    if not comparable:
        print(f"runner_champion_standoff=current_horizons:{_horizon_signature(current_horizons)}")
    status = "keep" if improved else "discard"

    if improved:
        state.best_cv_avg_mse = cv_avg_mse
        state.best_cv_protocol_id = cv_protocol_id
        state.best_run_id = run_id
        state.keep_count += 1
        state.crash_streak = 0
        state.no_improve_streak = 0
        state.last_improve_at = _now_iso()
    else:
        state.crash_streak = 0
        state.no_improve_streak += 1
    save_state(state)
    _set_approval_stage("train_eval_completed")

    _write_result_row(
        state=state,
        run_id=run_id,
        candidate_id=candidate_id,
        model_family=model_family,
        val_metrics=val_metrics,
        cv_metrics=cv_metrics,
        params_m=params_m,
        status=status,
    )

    print(f"runner_status={status}")
    print(f"runner_description={description}")
    print(f"runner_run_id={run_id}")
    print(f"runner_val_avg_mse={val_avg_mse:.6f}")
    print(f"runner_cv_avg_mse={cv_avg_mse:.6f}")
    print(f"runner_cv_std_mse={float(cv_metrics['cv_std_mse']):.6f}")
    if state.crash_streak >= 3:
        print("runner_pause_reason=crash_streak")
    return 0 if improved else 1


def _artifact_dir_for_run(run_id: str) -> Path:
    artifact_dir = ARTIFACTS_DIR / f"run_{run_id}"
    if not artifact_dir.exists():
        raise FileNotFoundError(f"Artifact directory not found for run_id={run_id}: {artifact_dir}")
    return artifact_dir


def run_ref_test(state: RunnerState, *, run_id: str | None) -> int:
    from prepare_tsf import query_ref_test

    target_run_id = run_id or state.best_run_id
    if not target_run_id:
        raise ValueError("No run_id provided and no best_run_id is available in runner state.")

    artifact_dir = _artifact_dir_for_run(target_run_id)
    promotion_token = secrets.token_urlsafe(24)
    previous_token = os.environ.get(PROMOTION_TOKEN_ENV)
    os.environ[PROMOTION_TOKEN_ENV] = promotion_token
    try:
        metrics = query_ref_test(str(artifact_dir), DATASET, promotion_token)
    finally:
        if previous_token is None:
            os.environ.pop(PROMOTION_TOKEN_ENV, None)
        else:
            os.environ[PROMOTION_TOKEN_ENV] = previous_token

    ref_test_metrics_path = artifact_dir / "ref_test_metrics.json"
    ref_test_metrics_path.write_text(
        f"{json.dumps(metrics, indent=2, sort_keys=True)}\n",
        encoding="utf-8",
    )

    export_exit = _export_artifact(
        state=state,
        run_id=target_run_id,
        artifact_dir=artifact_dir,
        ref_test_metrics_json=ref_test_metrics_path,
    )
    if export_exit != 0:
        return export_exit

    print(json.dumps({"event": "ref_test_done", "run_id": target_run_id, **metrics}, sort_keys=True))
    print(f"runner_ref_test_run_id={target_run_id}")
    print(f"runner_ref_test_metrics_path={ref_test_metrics_path.resolve()}")
    return 0


def run_blind_test(state: RunnerState, *, run_id: str | None) -> int:
    from prepare_tsf import query_blind_test

    target_run_id = run_id or state.best_run_id
    if not target_run_id:
        raise ValueError("No run_id provided and no best_run_id is available in runner state.")

    artifact_dir = _artifact_dir_for_run(target_run_id)
    promotion_token = secrets.token_urlsafe(24)
    metrics = query_blind_test(str(artifact_dir), DATASET, promotion_token)

    blind_test_metrics_path = artifact_dir / "blind_test_metrics.json"
    blind_test_metrics_path.write_text(
        f"{json.dumps(metrics, indent=2, sort_keys=True)}\n",
        encoding="utf-8",
    )

    print(json.dumps({"event": "blind_test_done", "run_id": target_run_id, **metrics}, sort_keys=True))
    print(f"runner_blind_test_run_id={target_run_id}")
    print(f"runner_blind_test_metrics_path={blind_test_metrics_path.resolve()}")
    return 0


def print_status(state: RunnerState) -> None:
    payload: dict[str, Any] = asdict(state)
    payload["results_path"] = str(RESULTS_PATH.resolve())
    payload["current_candidate_path"] = str(CURRENT_CANDIDATE_PATH.resolve())
    payload["resolved_candidate_path"] = str(RESOLVED_CANDIDATE_PATH.resolve())
    payload["artifacts_dir"] = str(ARTIFACTS_DIR.resolve())
    print(json.dumps(payload, indent=2, sort_keys=True))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Session-oriented neo-cast experiment runner.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init", help="Initialize .neo-cast runner state.")
    init_parser.add_argument("--force", action="store_true")

    run_parser = subparsers.add_parser("run", help="Run the current candidate through smoke + full training.")
    run_parser.add_argument("--description", required=True)
    run_parser.add_argument("--skip-smoke", action="store_true")
    run_parser.add_argument("--execution-contract", default=os.environ.get("NEO_CAST_EXECUTION_CONTRACT"))
    run_parser.add_argument("--contract-verification", default=os.environ.get("NEO_CAST_CONTRACT_VERIFICATION"))

    ref_test_parser = subparsers.add_parser(
        "ref-test",
        help="Evaluate a frozen artifact on the runner-only hidden reference test split.",
    )
    ref_test_parser.add_argument("--run-id", default=None)

    blind_test_parser = subparsers.add_parser(
        "blind-test",
        help="Submit a frozen artifact to the external private blind-test sidecar.",
    )
    blind_test_parser.add_argument("--run-id", default=None)

    subparsers.add_parser("status", help="Print runner state and paths.")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    try:
        if args.command == "init":
            state = init_state(args.force)
            print_status(state)
            return
        if args.command == "status":
            print_status(load_state())
            return
        if args.command == "run":
            state = load_state()
            if args.execution_contract:
                os.environ["NEO_CAST_EXECUTION_CONTRACT"] = args.execution_contract
                os.environ["NEO_CAST_CONTRACT_CANDIDATE"] = str(CURRENT_CANDIDATE_PATH)
            if args.contract_verification:
                os.environ["NEO_CAST_CONTRACT_VERIFICATION"] = args.contract_verification
            raise SystemExit(run_experiment(state, description=args.description, skip_smoke=args.skip_smoke))
        if args.command == "ref-test":
            state = load_state()
            raise SystemExit(run_ref_test(state, run_id=args.run_id))
        if args.command == "blind-test":
            state = load_state()
            raise SystemExit(run_blind_test(state, run_id=args.run_id))
    except Exception as exc:  # pragma: no cover
        print(f"runner_error={exc}", file=sys.stderr)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
