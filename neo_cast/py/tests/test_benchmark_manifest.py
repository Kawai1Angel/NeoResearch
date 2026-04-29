from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path


PY_ROOT = Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))
PROJECT_ROOT = PY_ROOT.parent

import dataset_contract  # noqa: E402


class BenchmarkManifestTest(unittest.TestCase):
    def test_manifest_lists_supported_benchmark_presets_with_complete_metadata(self) -> None:
        manifest = dataset_contract.benchmark_manifest()

        self.assertEqual(manifest["schema_version"], "benchmark_manifest.v1")
        self.assertEqual(
            sorted(manifest["datasets"].keys()),
            ["etth1", "ettm1", "traffic", "weather"],
        )
        json.dumps(manifest)

        for dataset_id, entry in manifest["datasets"].items():
            with self.subTest(dataset_id=dataset_id):
                self.assertEqual(entry["dataset_id"], dataset_id)
                self.assertIn(entry["split_policy"], {"fixed_rows", "tsl_custom_70_10_20"})
                self.assertEqual(entry["default_context"], 512)
                self.assertEqual(entry["default_horizons"], [96, 192, 336, 720])
                self.assertEqual(entry["primary_metric"], "mse")
                self.assertEqual(entry["reference_metrics"], ["mse", "mae"])
                self.assertIs(entry["requires_external_data_file"], True)
                self.assertTrue(entry["expected_data_files"])
                self.assertTrue(entry["notes"])

    def test_manifest_uses_existing_preset_defaults(self) -> None:
        manifest = dataset_contract.benchmark_manifest()

        for dataset_id, entry in manifest["datasets"].items():
            preset = dataset_contract.dataset_preset_payload(dataset_id)
            with self.subTest(dataset_id=dataset_id):
                self.assertEqual(entry["default_context"], preset["input_len"])
                self.assertEqual(entry["default_horizons"], preset["horizons"])

    def test_static_benchmark_manifest_template_matches_python_manifest(self) -> None:
        manifest_path = PROJECT_ROOT / "benchmarks" / "tsf_benchmark_manifest.json"
        static_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

        self.assertEqual(static_manifest, dataset_contract.benchmark_manifest())


if __name__ == "__main__":
    unittest.main()
