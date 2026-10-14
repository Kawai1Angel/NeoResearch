from __future__ import annotations

import sys
import json
import os
import subprocess
import tempfile
from unittest.mock import patch
import unittest
from pathlib import Path


PY_ROOT = Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

from export import (  # noqa: E402
    build_metadata,
    build_model_spec,
    build_patch_bundle,
    infer_export_horizons,
    render_eval_report,
    render_inference_py,
    render_mcp_server_py,
    render_example_py,
    render_readme_md,
    render_tool_schema,
    validate_metadata_payload,
    write_export_files,
    update_ref_test_export,
)
from research_trace import build_research_trace  # noqa: E402


class ExportContractTest(unittest.TestCase):
    def test_example_preserves_dataset_input_roles_and_accepts_explicit_history(self) -> None:
        for schema, covariate_mean in (("dataset.v1", [7.0, 8.0]), ("dataset.v2", [7.0, 8.0]), ("dataset.v2", None)):
            with self.subTest(schema=schema, covariate_mean=covariate_mean), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                metadata = {"dataset_schema_version": schema, "input_len": 3, "horizons": [2]}
                preprocess = {"input_len": 3, "scaler_mean": [2.0], "target_scaler": {"mean": [2.0]}, "covariate_scaler": {"mean": covariate_mean} if covariate_mean else None}
                (root / "preprocess.json").write_text(json.dumps(preprocess))
                (root / "example.py").write_text(render_example_py())
                history = {"target_history": [[2.0]] * 3, "exogenous_past": [covariate_mean or []] * 3} if schema == "dataset.v2" else [[2.0]] * 3
                (root / "inference.py").write_text(
                    "import json, pathlib\n"
                    f"def load_model(): return {{'metadata': {metadata!r}}}\n"
                    "def predict_raw(bundle, history, horizon):\n"
                    f"    assert history == {history!r}\n"
                    "    assert horizon == 2\n"
                    "    return type('Prediction', (), {'shape': (2, 1)})()\n"
                )
                for args in ([], [str(root / "history.json")]):
                    (root / "history.json").write_text(json.dumps(history))
                    result = subprocess.run([sys.executable, str(root / "example.py"), *args], capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn("(2, 1)", result.stdout)

    def test_covariate_readme_describes_structured_history(self) -> None:
        metadata = {"dataset_schema_version": "dataset.v2", "task_id": "fixture", "model_family": "recipe_factory", "run_id": "fixture", "input_len": 96, "horizons": [96], "feature_names": ["target", "past"], "num_channels": 1, "target_channels": 1, "past_exogenous_channels": 4}
        readme = render_readme_md(metadata, None)
        self.assertIn("`target_history` shape `[96, 1]`", readme)
        self.assertIn("`exogenous_past` shape `[96, 4]`", readme)

    def test_export_cli_uses_snapshots_without_importing_training_stack(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            preprocess = {"feature_names": ["fixture"], "scaler_mean": [42.0]}
            summary = {"export_spec": {"model_impl_entry": "model_impl.py:build_model", "state_dict_layout": "per_horizon"}}
            for name, payload in {
                "preprocess.json": preprocess,
                "resolved_candidate.json": {"candidate_id": "fixture", "model_family": "recipe_factory"},
                "training_summary.json": summary,
                "val_metrics.json": {"val_avg_mse": 0.5, "val_h96_mse": 0.5},
                "cv_metrics.json": {},
            }.items():
                (root / name).write_text(json.dumps(payload))
            before = (root / "preprocess.json").read_bytes()
            script = """
import sys, importlib.abc
class BlockTraining(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in {'torch', 'prepare_tsf', 'pandas', 'sklearn'}:
            raise AssertionError('Unexpected training dependency: ' + fullname)
sys.meta_path.insert(0, BlockTraining())
import export
export.main()
"""
            result = subprocess.run([sys.executable, "-c", script, "--artifact-dir", str(root), "--run-id", "fixture"],
                                    env={**os.environ, "PYTHONPATH": str(PY_ROOT)}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / "preprocess.json").read_bytes(), before)
            metadata = json.loads((root / "metadata.json").read_text())
            self.assertEqual(metadata["feature_names"], ["fixture"])
            self.assertEqual(validate_metadata_payload(metadata), [])

    def test_ref_test_update_preserves_runtime_and_frozen_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = {"candidate_id": "fixture", "model_family": "recipe_factory"}
            metadata = build_metadata(run_id="fixture", model_family="recipe_factory",
                model_impl_entry="model_impl.py:build_model", state_dict_layout="per_horizon",
                val_metrics={"val_avg_mse": 0.5, "val_h96_mse": 0.5}, horizons=[96],
                preprocess={"feature_names": ["fixture"]})
            write_export_files(root, metadata, candidate=candidate, preprocess={"feature_names": ["fixture"]})
            (root / "resolved_candidate.json").write_text(json.dumps(candidate))
            unchanged = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in root.iterdir()
                         if p.name not in {"metadata.json", "research_trace.json", "eval_report.md"}}
            metrics = {"ref_test_avg_mse": 0.25, "ref_test_avg_mae": 0.2,
                       "ref_test_h96_mse": 0.25, "ref_test_h96_mae": 0.2}
            with patch("export.build_preprocess_spec", side_effect=AssertionError("must not reload data")):
                update_ref_test_export(root, run_id="fixture", metrics=metrics)
            updated = json.loads((root / "metadata.json").read_text())
            self.assertEqual(updated, {**metadata, "ref_test_metrics": metrics})
            self.assertIn("0.250000", (root / "eval_report.md").read_text())
            trace = json.loads((root / "research_trace.json").read_text())
            expected = build_research_trace(updated, candidate)
            for entry in trace["entries"]:
                entry.pop("created_at")
            for entry in expected["entries"]:
                entry.pop("created_at")
            self.assertEqual(trace, expected)
            for path, snapshot in unchanged.items():
                self.assertEqual((path.read_bytes(), path.stat().st_mtime_ns), snapshot)
            with self.assertRaisesRegex(ValueError, "run_id"):
                update_ref_test_export(root, run_id="wrong", metrics=metrics)
            before_invalid = (root / "metadata.json").read_bytes()
            with self.assertRaisesRegex(ValueError, "Invalid reference-test metadata"):
                update_ref_test_export(root, run_id="fixture", metrics={"unexpected": 1})
            self.assertEqual((root / "metadata.json").read_bytes(), before_invalid)

    def test_legacy_export_without_preprocess_snapshot_uses_data_builder(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            preprocess = {"feature_names": ["legacy"]}
            metadata = build_metadata(run_id="legacy", model_family="recipe_factory",
                model_impl_entry="model_impl.py:build_model", state_dict_layout="per_horizon",
                val_metrics={"val_avg_mse": 0.5, "val_h96_mse": 0.5}, horizons=[96], preprocess=preprocess)
            with patch("export.build_preprocess_spec", return_value=preprocess) as build:
                write_export_files(root, metadata, candidate=None)
            build.assert_called_once_with()
            self.assertEqual(json.loads((root / "preprocess.json").read_text()), preprocess)


    def test_smoke_horizon_is_inferred_from_val_metrics(self) -> None:
        val_metrics = {
            "val_avg_mse": 0.5,
            "val_avg_mae": 0.4,
            "val_h96_mse": 0.5,
            "val_h96_mae": 0.4,
        }
        horizons = infer_export_horizons(val_metrics=val_metrics)

        self.assertEqual(horizons, [96])

        metadata = build_metadata(
            run_id="run_test_001",
            model_family="recipe_factory",
            model_impl_entry="model_impl.py:build_model",
            state_dict_layout="per_horizon",
            val_metrics=val_metrics,
            horizons=horizons,
        )
        tool_schema = render_tool_schema(metadata)

        self.assertEqual(metadata["horizons"], [96])
        self.assertEqual(tool_schema["inputSchema"]["properties"]["horizon"]["enum"], [96])

    def test_full_horizons_are_inferred_from_val_metrics(self) -> None:
        val_metrics = {
            "val_avg_mse": 0.5,
            "val_h96_mse": 0.5,
            "val_h192_mse": 0.6,
            "val_h336_mse": 0.7,
            "val_h720_mse": 0.8,
        }

        self.assertEqual(infer_export_horizons(val_metrics=val_metrics), [96, 192, 336, 720])

    def test_quantile_artifact_schema_exposes_distribution_outputs(self) -> None:
        metadata = build_metadata(
            run_id="run_quantile_001",
            model_family="recipe_factory",
            model_impl_entry="model_impl.py:build_model",
            state_dict_layout="per_horizon",
            val_metrics={"val_avg_mse": 0.5, "val_h96_mse": 0.5},
            horizons=[96],
            training_summary={
                "output_distribution": "quantile",
                "prediction_head": "quantile",
                "training_prediction": "quantile_distribution",
                "quantiles": [0.1, 0.5, 0.9],
            },
        )

        tool_schema = render_tool_schema(metadata)

        self.assertEqual(validate_metadata_payload(metadata), [])
        self.assertEqual(
            tool_schema["outputSchema"]["properties"]["quantiles"]["items"]["enum"],
            [0.1, 0.5, 0.9],
        )
        self.assertIn("quantile_prediction", tool_schema["outputSchema"]["properties"])
        self.assertIn("[horizon, num_channels, quantile]", tool_schema["outputSchema"]["properties"]["quantile_prediction"]["description"])

    def test_exported_inference_runtime_contains_quantile_prediction_path(self) -> None:
        self.assertIn("def predict_quantiles_raw", render_inference_py())
        self.assertIn("quantile_prediction", render_mcp_server_py())

    def test_eval_report_surfaces_probabilistic_metrics(self) -> None:
        metadata = build_metadata(
            run_id="run_probabilistic_001",
            model_family="recipe_factory",
            model_impl_entry="model_impl.py:build_model",
            state_dict_layout="per_horizon",
            val_metrics={
                "val_avg_mse": 0.5,
                "val_avg_mae": 0.4,
                "val_avg_pinball": 0.07,
                "val_avg_crps_approx": 0.14,
                "val_avg_interval_80_coverage": 0.88,
                "val_avg_interval_80_width": 1.25,
                "val_h96_mse": 0.5,
                "val_h96_mae": 0.4,
                "val_h96_pinball": 0.07,
                "val_h96_crps_approx": 0.14,
                "val_h96_interval_80_coverage": 0.88,
                "val_h96_interval_80_width": 1.25,
            },
            horizons=[96],
        )

        report = render_eval_report(metadata)

        self.assertIn("| split | mse | mae | pinball | crps_approx | interval_80_coverage | interval_80_width |", report)
        self.assertIn("| avg | 0.500000 | 0.400000 | 0.070000 | 0.140000 | 0.880000 | 1.250000 |", report)
        self.assertIn("| h96 | 0.500000 | 0.400000 | 0.070000 | 0.140000 | 0.880000 | 1.250000 |", report)

    def test_eval_report_surfaces_research_trace(self) -> None:
        metadata = build_metadata(
            run_id="run_trace_report_001",
            model_family="recipe_factory",
            model_impl_entry="model_impl.py:build_model",
            state_dict_layout="per_horizon",
            val_metrics={"val_avg_mse": 0.5, "val_h96_mse": 0.5},
            horizons=[96],
        )
        candidate = {
            "candidate_id": "cand_trace_report_001",
            "model_family": "recipe_factory",
            "hypothesis": "Patch MLP should capture local temporal motifs.",
            "recipe": {
                "recipe_id": "recipe_trace_report_001",
                "embedding": {"type": "patch"},
                "backbone": {"type": "mlp"},
                "fusion": {"type": "temporal"},
                "prediction_head": {"type": "linear"},
            },
        }
        trace = build_research_trace(metadata, candidate, created_at="2026-05-05T00:00:00Z")

        report = render_eval_report(metadata, research_trace=trace)

        self.assertIn("## Research Trace", report)
        self.assertIn("use recipe modules", report)
        self.assertIn("Patch MLP should capture local temporal motifs.", report)

    def test_model_spec_and_patch_bundle_capture_compiled_recipe_artifacts(self) -> None:
        candidate = {
            "candidate_id": "cand_recipe_001",
            "recipe": {
                "recipe_version": "recipe_schema_v2",
                "recipe_id": "recipe_001",
                "preprocessing": {"actions": [{"type": "instance_norm"}]},
                "embedding": {"type": "patch"},
                "backbone": {"type": "mixer"},
                "fusion": {"type": "gated_hybrid"},
                "prediction_head": {
                    "type": "quantile",
                    "output_distribution": "quantile",
                    "quantiles": [0.1, 0.5, 0.9],
                },
                "training_strategy": {"loss": {"base": "quantile", "quantiles": [0.1, 0.5, 0.9]}},
            },
        }
        metadata = build_metadata(
            run_id="run_model_spec_001",
            model_family="recipe_factory",
            model_impl_entry="model_impl.py:build_model",
            state_dict_layout="per_horizon",
            val_metrics={"val_avg_mse": 0.5, "val_h96_mse": 0.5},
            horizons=[96],
            training_summary={
                "num_params_M": 0.25,
                "output_distribution": "quantile",
                "prediction_head": "quantile",
                "training_prediction": "quantile_distribution",
                "loss": "quantile",
                "quantiles": [0.1, 0.5, 0.9],
            },
        )

        model_spec = build_model_spec(metadata, candidate)
        patch_bundle = build_patch_bundle(metadata, candidate, model_spec)

        self.assertEqual(model_spec["recipe_id"], "recipe_001")
        self.assertEqual(model_spec["compiled_modules"]["backbone"], "mixer")
        self.assertEqual(model_spec["output_shape"], [None, 96, metadata["target_channels"], 3])
        self.assertEqual(model_spec["estimated_params"], 250_000)
        self.assertEqual(patch_bundle["proposal_id"], "cand_recipe_001")
        self.assertEqual(patch_bundle["compiled_model_delta"]["prediction_head"], "quantile")
        self.assertEqual(patch_bundle["manifest"]["change_type"], "registry_composition")


if __name__ == "__main__":
    unittest.main()
