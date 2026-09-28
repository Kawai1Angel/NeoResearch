from __future__ import annotations

import math
import os
import types
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

from cv_train import _run_standard_train, _run_train, aggregate_cv_metrics, build_ratio_folds, default_max_parallel_folds, run_cv_folds_parallel, validate_folds
from prepare_tsf import _split_bounds_with_cv_override


class CvTrainTest(unittest.TestCase):
    @patch("torch.cuda.is_available", return_value=True)
    def test_default_parallelism_serializes_cuda_folds(self, _cuda) -> None:
        self.assertEqual(default_max_parallel_folds(), 1)

    @patch("torch.cuda.is_available", return_value=False)
    def test_default_parallelism_keeps_cpu_folds_parallel(self, _cuda) -> None:
        self.assertEqual(default_max_parallel_folds(), 4)

    def test_standard_fit_reuses_parent_and_keeps_live_evidence(self) -> None:
        def entry(argv):
            self.assertEqual(argv, ["--resolved-candidate", "snapshot.json", "--artifacts-dir", "artifacts"])
            print('{"event":"experiment_reused","independent_evidence":false}')
            print('{"event":"eval_done","val_avg_mse":0.5}')
            print('{"event":"artifact_ready","run_id":"fixture","artifact_dir":"artifacts/run_fixture"}')
            raise SystemExit(0)
        with patch.dict(os.environ, {}, clear=True), patch.dict(sys.modules, {"train": types.SimpleNamespace(main=entry)}), \
             patch("cv_train.subprocess.Popen", side_effect=AssertionError("unexpected subprocess")), redirect_stdout(io.StringIO()) as out:
            code, records = _run_standard_train([sys.executable, "train.py", "--resolved-candidate", "snapshot.json"], "artifacts")
        self.assertEqual(code, 0)
        self.assertEqual(records, [json.loads(line) for line in out.getvalue().splitlines()])
        self.assertEqual(records[-1]["run_id"], "fixture")
        self.assertNotIn("cv_fold_index", records[-1])

    def test_standard_fit_with_parent_overrides_uses_clean_subprocess(self) -> None:
        with patch.dict(os.environ, {"NEO_CAST_TRAIN_ROWS": "0:600", "NEO_CAST_VAL_ROWS": "600:700", "NEO_CAST_CV_FOLD_INDEX": "1"}), \
             patch("cv_train._run_train", return_value=(5, [{"event": "execution_contract_violation"}])) as run:
            code, records = _run_standard_train([sys.executable, "train.py"], "artifacts")
        self.assertEqual(code, 5)
        self.assertEqual(records[0]["event"], "execution_contract_violation")
        self.assertFalse(any(key in run.call_args.args[1] for key in ("NEO_CAST_TRAIN_ROWS", "NEO_CAST_VAL_ROWS", "NEO_CAST_CV_FOLD_INDEX")))

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
