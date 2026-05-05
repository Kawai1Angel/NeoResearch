from __future__ import annotations

import sys
import unittest
from pathlib import Path


PY_ROOT = Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

from research_trace import build_research_trace  # noqa: E402


class ResearchTraceTest(unittest.TestCase):
    def test_build_research_trace_records_model_decision_with_evidence(self) -> None:
        metadata = {
            "run_id": "run_trace_001",
            "task_id": "etth1",
            "input_len": 512,
            "horizons": [96, 192],
            "num_channels": 7,
            "feature_names": ["HUFL", "HULL", "MUFL", "MULL", "LUFL", "LULL", "OT"],
            "val_metrics": {
                "val_avg_mse": 0.42,
                "val_h96_mse": 0.38,
                "val_h192_mse": 0.46,
            },
        }
        candidate = {
            "candidate_id": "cand_trace_001",
            "model_family": "recipe_factory",
            "hypothesis": "Multi-scale patches may stabilize longer-horizon forecasts.",
            "recipe": {
                "recipe_id": "recipe_trace_001",
                "preprocessing": {"actions": [{"type": "series_decomposition"}]},
                "embedding": {"type": "multiscale_patch"},
                "backbone": {"type": "mlp"},
                "fusion": {"type": "temporal"},
                "prediction_head": {"type": "linear"},
            },
        }

        trace = build_research_trace(metadata, candidate, created_at="2026-05-05T00:00:00Z")

        self.assertEqual(trace["schema_version"], "research_trace.v1")
        self.assertEqual(trace["run_id"], "run_trace_001")
        self.assertEqual(len(trace["entries"]), 2)
        design_entry = trace["entries"][0]
        self.assertEqual(design_entry["made_by"], "ModelDesigner Agent")
        self.assertIn("multiscale_patch", design_entry["decision"])
        self.assertIn("Multi-scale patches", " ".join(design_entry["evidence"]))
        self.assertIn("val_avg_mse", design_entry["verification_plan"])
        for field in ("decision", "made_by", "evidence", "expected_effect", "verification_plan"):
            self.assertIn(field, design_entry)

        eval_entry = trace["entries"][1]
        self.assertEqual(eval_entry["made_by"], "TrainEval Agent")
        self.assertIn("0.420000", " ".join(eval_entry["evidence"]))


if __name__ == "__main__":
    unittest.main()
