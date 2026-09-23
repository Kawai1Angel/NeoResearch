from __future__ import annotations

import math
import io
import json
from contextlib import redirect_stdout
import sys
import unittest
from unittest.mock import Mock, patch
from pathlib import Path

PY_ROOT = Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

from cv_train import _run_train, aggregate_cv_metrics, build_ratio_folds, run_cv_folds_parallel, validate_folds
from prepare_tsf import _split_bounds_with_cv_override


class CvTrainTest(unittest.TestCase):
    def test_fold_output_marks_temporary_artifacts_without_mutating_metrics(self) -> None:
        process = Mock(stdout=io.StringIO('{"event":"done","artifact_dir":"/tmp/fold","val_avg_mse":1.0}\n'))
        process.wait.return_value = 0
        output = io.StringIO()
        with patch("cv_train.subprocess.Popen", return_value=process), redirect_stdout(output):
            code, records = _run_train(["fixture"], {"NEO_CAST_CV_FOLD_INDEX": "2"})
        forwarded = json.loads(output.getvalue())
        self.assertEqual(code, 0)
        self.assertTrue(forwarded["ephemeral"])
        self.assertEqual(forwarded["cv_fold_index"], 2)
        self.assertEqual(forwarded["val_avg_mse"], 1.0)
        self.assertNotIn("ephemeral", records[0])

    def test_builds_expected_ratio_folds(self) -> None:
        folds = build_ratio_folds((0, 10_000), num_folds=4, initial_train_ratio=0.6)
        self.assertEqual(folds[0].train_rows, (0, 6000))
        self.assertEqual(folds[0].val_rows, (6000, 7000))
        self.assertEqual(folds[-1].train_rows, (0, 9000))
        self.assertEqual(folds[-1].val_rows, (9000, 10_000))

    def test_non_round_length_is_contiguous_and_ends_exactly(self) -> None:
        folds = build_ratio_folds((11, 12_358), num_folds=4, initial_train_ratio=0.6)
        self.assertEqual(folds[-1].val_rows[1], 12_358)
        for previous, current in zip(folds, folds[1:]):
            self.assertEqual(previous.val_rows[1], current.val_rows[0])
            self.assertGreater(current.train_rows[1], previous.train_rows[1])

    def test_rejects_insufficient_windows(self) -> None:
        folds = build_ratio_folds((0, 100), num_folds=4, initial_train_ratio=0.6)
        with self.assertRaisesRegex(ValueError, "required"):
            validate_folds(folds, visible_rows=(0, 100), ref_test_start=100,
                           input_len=48, max_horizon=24, min_train_windows=1, min_eval_windows=1)

    def test_aggregates_macro_mean_and_population_std(self) -> None:
        folds = build_ratio_folds((0, 1000), num_folds=2, initial_train_ratio=0.6)
        result = aggregate_cv_metrics(folds, [
            {"val_avg_mse": 1.0, "val_avg_mae": 2.0, "val_h96_mse": 0.8},
            {"val_avg_mse": 3.0, "val_avg_mae": 4.0, "val_h96_mse": 1.2},
        ], initial_train_ratio=0.6)
        self.assertEqual(result["cv_avg_mse"], 2.0)
        self.assertEqual(result["cv_std_mse"], 1.0)
        self.assertTrue(math.isclose(result["cv_h96_mse"], 1.0))

    @patch("cv_train.run_cv_fold")
    def test_parallel_folds_return_metrics_in_fold_order(self, run_fold) -> None:
        folds = build_ratio_folds((0, 1000), num_folds=4, initial_train_ratio=0.6)
        run_fold.side_effect = lambda fold, **_: (fold.fold_index, {"val_avg_mse": float(fold.fold_index)})
        result = run_cv_folds_parallel(folds, train_cmd=["train"], temp_root=Path("/tmp/cv"), max_workers=4)
        self.assertEqual([item["val_avg_mse"] for item in result], [0.0, 1.0, 2.0, 3.0])
        self.assertEqual(run_fold.call_count, 4)

    def test_parallel_folds_reject_invalid_worker_count(self) -> None:
        folds = build_ratio_folds((0, 1000), num_folds=4, initial_train_ratio=0.6)
        with self.assertRaisesRegex(ValueError, "max_workers"):
            run_cv_folds_parallel(folds, train_cmd=["train"], temp_root=Path("/tmp/cv"), max_workers=0)

    def test_split_override_requires_pair_and_stays_before_ref_test(self) -> None:
        with patch.dict("os.environ", {"NEO_CAST_TRAIN_ROWS": "0:600"}, clear=True):
            with self.assertRaisesRegex(ValueError, "provided together"):
                _split_bounds_with_cv_override((0, 700), (700, 900), (900, 1000))
        with patch.dict("os.environ", {
            "NEO_CAST_TRAIN_ROWS": "0:600", "NEO_CAST_VAL_ROWS": "600:901"
        }, clear=True):
            with self.assertRaisesRegex(ValueError, "outside visible"):
                _split_bounds_with_cv_override((0, 700), (700, 900), (900, 1000))


if __name__ == "__main__":
    unittest.main()
