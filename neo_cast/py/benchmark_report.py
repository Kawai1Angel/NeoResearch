from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any

import dataset_contract


def expected_columns(manifest: dict[str, Any] | None = None) -> list[str]:
    source = manifest or dataset_contract.benchmark_manifest()
    return [str(column) for column in source["result_table_expected_columns"]]


def write_template(path: Path, manifest: dict[str, Any] | None = None) -> None:
    columns = expected_columns(manifest)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()


def load_result_rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as handle:
        return [dict(row) for row in csv.DictReader(handle)]


def _numeric(value: str) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def validate_result_rows(rows: list[dict[str, str]], manifest: dict[str, Any] | None = None) -> dict[str, Any]:
    source = manifest or dataset_contract.benchmark_manifest()
    columns = expected_columns(source)
    datasets = source["datasets"]
    errors: list[str] = []
    seen_keys: set[tuple[str, str, str, str]] = set()

    for index, row in enumerate(rows, start=1):
        missing_columns = [column for column in columns if column not in row]
        if missing_columns:
            errors.append(f"row {index}: missing columns {', '.join(missing_columns)}")

        dataset_id = (row.get("dataset_id") or "").strip()
        dataset = datasets.get(dataset_id)
        if dataset is None:
            errors.append(f"row {index}: unsupported dataset_id {dataset_id or '<empty>'}")

        horizon_raw = (row.get("horizon") or "").strip()
        try:
            horizon = int(horizon_raw)
        except ValueError:
            horizon = None
            errors.append(f"row {index}: horizon must be an integer")
        if horizon is not None and horizon not in (dataset or {}).get("default_horizons", []):
            errors.append(f"row {index}: horizon {horizon} is not supported for dataset {dataset_id or '<empty>'}")

        expected_primary = (dataset or {}).get("primary_metric", "mse")
        if (row.get("primary_metric") or "").strip() != expected_primary:
            errors.append(f"row {index}: primary_metric must be {expected_primary}")

        for metric in ("mse", "mae"):
            value = _numeric((row.get(metric) or "").strip())
            if value is None:
                errors.append(f"row {index}: {metric} must be numeric")
            elif value < 0:
                errors.append(f"row {index}: {metric} must be non-negative")

        model_id = (row.get("model_id") or "").strip()
        run_id = (row.get("run_id") or "").strip()
        if not model_id:
            errors.append(f"row {index}: model_id is required")
        if not run_id:
            errors.append(f"row {index}: run_id is required")
        key = (dataset_id, horizon_raw, model_id, run_id)
        if key in seen_keys:
            errors.append(f"row {index}: duplicate dataset/horizon/model/run key")
        seen_keys.add(key)

    return {"ok": not errors, "errors": errors, "row_count": len(rows)}


def summarize_champions(rows: list[dict[str, str]]) -> dict[str, Any]:
    best: dict[tuple[str, int], dict[str, Any]] = {}
    for row in rows:
        mse = _numeric((row.get("mse") or "").strip())
        if mse is None:
            continue
        try:
            horizon = int((row.get("horizon") or "").strip())
        except ValueError:
            continue
        key = ((row.get("dataset_id") or "").strip(), horizon)
        current = best.get(key)
        if current is None or mse < current["mse"]:
            best[key] = {
                "dataset_id": key[0],
                "horizon": key[1],
                "model_id": (row.get("model_id") or "").strip(),
                "run_id": (row.get("run_id") or "").strip(),
                "mse": mse,
                "mae": _numeric((row.get("mae") or "").strip()),
                "trained_at": (row.get("trained_at") or "").strip(),
                "git_commit": (row.get("git_commit") or "").strip(),
            }

    champions = [best[key] for key in sorted(best.keys())]
    return {"schema_version": "benchmark_summary.v1", "champions": champions}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate and summarize Neo-Cast TSF benchmark results.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    template_parser = subparsers.add_parser("template", help="Write an empty benchmark result CSV template.")
    template_parser.add_argument("--output", required=True, type=Path)

    validate_parser = subparsers.add_parser("validate", help="Validate a benchmark result CSV.")
    validate_parser.add_argument("--results", required=True, type=Path)
    validate_parser.add_argument("--summary-json", type=Path)

    args = parser.parse_args(argv)
    if args.command == "template":
        write_template(args.output)
        print(json.dumps({"event": "benchmark_template_written", "path": str(args.output)}, sort_keys=True))
        return 0

    rows = load_result_rows(args.results)
    validation = validate_result_rows(rows)
    print(json.dumps({"event": "benchmark_results_validated", **validation}, sort_keys=True))
    if not validation["ok"]:
        return 1
    summary = summarize_champions(rows)
    if args.summary_json is not None:
        args.summary_json.parent.mkdir(parents=True, exist_ok=True)
        args.summary_json.write_text(f"{json.dumps(summary, indent=2, sort_keys=True)}\n", encoding="utf-8")
        print(json.dumps({"event": "benchmark_summary_written", "path": str(args.summary_json)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
