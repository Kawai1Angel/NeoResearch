from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

PY_ROOT = Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

import runner


class RunnerTrainingCurvesTest(unittest.TestCase):
    def test_write_training_curves_groups_epoch_losses_by_horizon(self) -> None:
        records = [
            {"event": "epoch_end", "horizon": 96, "epoch": 1, "val_loss": 0.724},
            {"event": "epoch_end", "horizon": 720, "epoch": 1, "val_loss": 1.518},
            {"event": "epoch_end", "horizon": 96, "epoch": 2, "val_loss": 0.712},
            {"event": "horizon_done", "horizon": 96, "best_val_loss": 0.712},
            {"event": "epoch_end", "horizon": 720, "epoch": 2, "val_loss": 1.514},
        ]

        with tempfile.TemporaryDirectory() as tmp:
            artifact_dir = Path(tmp)
            runner._write_training_curves(records, artifact_dir)

            payload = json.loads((artifact_dir / "training_curves.json").read_text(encoding="utf-8"))

        self.assertEqual(payload, {"curves_by_horizon": {"96": [0.724, 0.712], "720": [1.518, 1.514]}})


if __name__ == "__main__":
    unittest.main()
