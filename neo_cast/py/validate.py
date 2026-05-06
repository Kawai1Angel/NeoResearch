"""
Validate neo-cast payloads and run the smoke gate.

Usage:
    python validate.py candidate /path/to/candidate.json
    python validate.py recipe /path/to/recipe.json
    python validate.py model-recipe /path/to/model_recipe.json
    python validate.py task-spec /path/to/task_spec.json
    python validate.py research-trace /path/to/research_trace.json
    python validate.py user-corrections /path/to/user_corrections.json
    python validate.py metadata /path/to/metadata.json
    python validate.py smoke --candidate-path .neo-cast/current_candidate.json
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator


PY_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = Path(os.environ.get("NEO_CAST_PROJECT_ROOT", PY_ROOT.parent)).expanduser().resolve()
SCHEMA_DIR = PY_ROOT / "schemas"
DEFAULT_STATE_DIR = PROJECT_ROOT / ".neo-cast"
DEFAULT_CANDIDATE_PATH = DEFAULT_STATE_DIR / "current_candidate.json"
DEFAULT_RESOLVED_PATH = DEFAULT_STATE_DIR / "resolved_candidate.json"
DEFAULT_ARTIFACTS_DIR = DEFAULT_STATE_DIR / "artifacts"
DEFAULT_SCHEMAS = {
    "candidate": SCHEMA_DIR / "candidate_schema.json",
    "dataset": SCHEMA_DIR / "dataset_schema.json",
    "metadata": SCHEMA_DIR / "metadata_schema.json",
    "model-recipe": SCHEMA_DIR / "model_recipe_schema.json",
    "recipe": SCHEMA_DIR / "recipe_schema.json",
    "research-trace": SCHEMA_DIR / "research_trace_schema.json",
    "task-spec": SCHEMA_DIR / "task_spec_schema.json",
    "user-corrections": SCHEMA_DIR / "user_correction_memory_schema.json",
}


def load_json(path: str | Path) -> object:
    json_path = Path(path).expanduser()
    with json_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_validator(schema_path: str | Path) -> Draft202012Validator:
    schema = load_json(schema_path)
    return Draft202012Validator(schema)


def validate_payload(kind: str, payload_path: str | Path, schema_path: str | Path | None = None) -> list[str]:
    selected_schema = Path(schema_path).expanduser() if schema_path is not None else DEFAULT_SCHEMAS[kind]
    validator = load_validator(selected_schema)
    payload = load_json(payload_path)

    errors: list[str] = []
    for error in sorted(validator.iter_errors(payload), key=lambda exc: list(exc.absolute_path)):
        path = ".".join(str(part) for part in error.absolute_path)
        location = path if path else "<root>"
        errors.append(f"{location}: {error.message}")
    if kind == "recipe" and not errors:
        from registry.action_specs import validate_recipe_against_registry

        if isinstance(payload, dict):
            errors.extend(validate_recipe_against_registry(payload))
    if kind == "model-recipe" and not errors:
        from model_recipe import compile_model_recipe
        from registry.action_specs import validate_recipe_against_registry

        if isinstance(payload, dict):
            try:
                compiled = compile_model_recipe(payload)
                errors.extend(
                    f"compiled_recipe.{item}"
                    for item in validate_recipe_against_registry(
                        compiled,
                        input_len=int(payload.get("input", {}).get("history_window", 0)) or None,
                    )
                )
            except Exception as exc:
                errors.append(str(exc))
    return errors


def detect_payload_kind(payload_path: str | Path) -> str:
    payload = load_json(payload_path)
    if not isinstance(payload, dict):
        raise ValueError(f"Expected JSON object at {payload_path}")
    if payload.get("recipe_version") == "recipe_schema_v1":
        return "recipe"
    if payload.get("schema_version") == "model_recipe.v1":
        return "model-recipe"
    raise ValueError(
        "Unknown payload kind. Expected recipe_version='recipe_schema_v1' or schema_version='model_recipe.v1'."
    )


def _emit_validation_result(kind: str, payload: str | Path, errors: list[str]) -> int:
    if errors:
        print("validation_status: invalid")
        for item in errors:
            print(f"error: {item}")
        return 1

    print("validation_status: valid")
    print(f"schema_kind: {kind}")
    print(f"payload_path: {Path(payload).expanduser()}")
    return 0


def _iter_ndjson_lines(stream) -> tuple[dict[str, Any], ...]:
    records: list[dict[str, Any]] = []
    if stream is None:
        raise RuntimeError("validation subprocess stdout pipe is unavailable")
    for raw_line in stream:
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
    return tuple(records)


def _spawn_and_forward(cmd: list[str]) -> tuple[int, tuple[dict[str, Any], ...]]:
    proc = subprocess.Popen(
        cmd,
        cwd=str(PROJECT_ROOT),
        stdout=subprocess.PIPE,
        stderr=sys.stderr,
        text=True,
    )
    records = _iter_ndjson_lines(proc.stdout)
    exit_code = proc.wait()
    return exit_code, records


def _run_smoke(candidate_path: Path, resolved_path: Path, artifacts_dir: Path) -> int:
    try:
        payload_kind = detect_payload_kind(candidate_path)
        errors = validate_payload(payload_kind, candidate_path)
    except Exception as exc:
        errors = [str(exc)]
    if errors:
        for item in errors:
            print(f"error: {item}")
        return 2

    renderer_cmd = [
        sys.executable,
        str(PY_ROOT / "renderer.py"),
        "--candidate-path",
        str(candidate_path),
        "--resolved-path",
        str(resolved_path),
    ]
    renderer_exit, renderer_records = _spawn_and_forward(renderer_cmd)
    if renderer_exit != 0:
        return renderer_exit if renderer_exit in {2, 4} else 1

    resolved_ok = any(record.get("event") == "candidate_resolved" for record in renderer_records)
    if not resolved_ok:
        print("error: renderer did not emit candidate_resolved")
        return 1

    train_cmd = [
        sys.executable,
        str(PY_ROOT / "train.py"),
        "--resolved-candidate",
        str(resolved_path),
        "--artifacts-dir",
        str(artifacts_dir),
        "--smoke",
    ]
    train_exit, train_records = _spawn_and_forward(train_cmd)
    if train_exit != 0:
        return train_exit if train_exit in {3, 4, 124} else 1

    smoke_ok = any(record.get("event") in {"smoke_eval_done", "eval_done"} for record in train_records)
    done_success = any(record.get("event") == "done" and record.get("status") == "success" for record in train_records)
    if smoke_ok and done_success:
        return 0

    print("error: smoke run did not emit smoke_eval_done/eval_done + done:success")
    return 3


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Validate neo-cast payloads and smoke runs.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    json_parser = subparsers.add_parser("json", help="Validate a JSON payload against a schema.")
    json_parser.add_argument("kind", choices=sorted(DEFAULT_SCHEMAS.keys()))
    json_parser.add_argument("payload", type=str)
    json_parser.add_argument("--schema", type=str, default=None)

    smoke_parser = subparsers.add_parser("smoke", help="Resolve a candidate and run the smoke gate.")
    smoke_parser.add_argument("--candidate-path", default=str(DEFAULT_CANDIDATE_PATH))
    smoke_parser.add_argument("--resolved-path", default=str(DEFAULT_RESOLVED_PATH))
    smoke_parser.add_argument("--artifacts-dir", default=str(DEFAULT_ARTIFACTS_DIR))
    return parser


def _maybe_rewrite_legacy_args(argv: list[str]) -> list[str]:
    if not argv:
        return argv
    if argv[0] in DEFAULT_SCHEMAS:
        rewritten = ["json", argv[0]]
        if len(argv) > 1:
            rewritten.append(argv[1])
        if len(argv) > 2:
            rewritten.extend(argv[2:])
        return rewritten
    return argv


def main() -> None:
    argv = _maybe_rewrite_legacy_args(sys.argv[1:])
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "json":
        errors = validate_payload(args.kind, args.payload, args.schema)
        raise SystemExit(_emit_validation_result(args.kind, args.payload, errors))

    if args.command == "smoke":
        exit_code = _run_smoke(
            Path(args.candidate_path).expanduser(),
            Path(args.resolved_path).expanduser(),
            Path(args.artifacts_dir).expanduser(),
        )
        raise SystemExit(exit_code)

    raise SystemExit(1)


if __name__ == "__main__":
    main()
