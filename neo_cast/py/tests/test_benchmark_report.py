from __future__ import annotations

import csv
import json
import sys
import tempfile
import unittest
from pathlib import Path


PY_ROOT = Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

import benchmark_report  # noqa: E402
import dataset_contract  # noqa: E402


class BenchmarkReportTest(unittest.TestCase):
    def write_rows(self, rows: list[dict[str, str]]) -> Path:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "results.csv"
        columns = dataset_contract.benchmark_manifest()["result_table_expected_columns"]
        with path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=columns)
            writer.writeheader()
            writer.writerows(rows)
        return path

    def test_loads_valid_result_table_and_summarizes_champions(self) -> None:
        path = self.write_rows(
            [
                {
                    "dataset_id": "etth1",
                    "horizon": "96",
                    "model_id": "baseline",
                    "run_id": "run-001",
                    "primary_metric": "mse",
                    "mse": "0.25",
                    "mae": "0.4",
                    "trained_at": "2026-04-28T12:00:00Z",
                    "data_file": "ETTh1.csv",
                    "git_commit": "abc123",
                    "notes": "",
                },
                {
                    "dataset_id": "etth1",
                    "horizon": "96",
                    "model_id": "candidate",
                    "run_id": "run-002",
                    "primary_metric": "mse",
                    "mse": "0.2",
                    "mae": "0.35",
                    "trained_at": "2026-04-28T12:30:00Z",
                    "data_file": "ETTh1.csv",
                    "git_commit": "abc123",
                    "notes": "phase2",
                },
            ]
        )

        rows = benchmark_report.load_result_rows(path)
        validation = benchmark_report.validate_result_rows(rows, dataset_contract.benchmark_manifest())
        summary = benchmark_report.summarize_champions(rows)

        self.assertEqual(validation, {"ok": True, "errors": [], "row_count": 2})
        self.assertEqual(summary["champions"][0]["model_id"], "candidate")
        self.assertEqual(summary["champions"][0]["mse"], 0.2)
        json.dumps(summary)

    def test_validation_rejects_unknown_dataset_horizon_and_metric(self) -> None:
        rows = [
            {
                "dataset_id": "unknown",
                "horizon": "999",
                "model_id": "bad",
                "run_id": "run-003",
                "primary_metric": "mae",
                "mse": "not-a-number",
                "mae": "0.1",
                "trained_at": "",
                "data_file": "",
                "git_commit": "",
                "notes": "",
            }
        ]

        validation = benchmark_report.validate_result_rows(rows, dataset_contract.benchmark_manifest())

        self.assertFalse(validation["ok"])
        self.assertIn("row 1: unsupported dataset_id unknown", validation["errors"])
        self.assertIn("row 1: horizon 999 is not supported for dataset unknown", validation["errors"])
        self.assertIn("row 1: primary_metric must be mse", validation["errors"])
        self.assertIn("row 1: mse must be numeric", validation["errors"])

    def test_write_empty_template_uses_manifest_columns(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "template.csv"
            benchmark_report.write_template(path, dataset_contract.benchmark_manifest())

            header = path.read_text(encoding="utf-8").splitlines()[0]
            self.assertEqual(header.split(","), dataset_contract.benchmark_manifest()["result_table_expected_columns"])


if __name__ == "__main__":
    unittest.main()
