from __future__ import annotations

import sys
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
    render_tool_schema,
    validate_metadata_payload,
)
from research_trace import build_research_trace  # noqa: E402


class ExportContractTest(unittest.TestCase):
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
                "recipe_version": "recipe_schema_v1",
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
        self.assertEqual(model_spec["output_shape"], [None, 96, 7, 3])
        self.assertEqual(model_spec["estimated_params"], 250_000)
        self.assertEqual(patch_bundle["proposal_id"], "cand_recipe_001")
        self.assertEqual(patch_bundle["compiled_model_delta"]["prediction_head"], "quantile")
        self.assertEqual(patch_bundle["manifest"]["change_type"], "registry_composition")


if __name__ == "__main__":
    unittest.main()
