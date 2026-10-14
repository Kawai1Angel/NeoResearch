from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd

PY_ROOT = Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

import prepare_tsf


class DatasetHeadersTest(unittest.TestCase):
    def setUp(self) -> None:
        self.original_spec = prepare_tsf.ACTIVE_SPEC
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "BE.csv"
        self.frame = pd.DataFrame({
            " date ": pd.date_range("2021-01-01", periods=100, freq="h"),
            " Generation forecast": range(100),
            " System load forecast ": range(100, 200),
            "OT": range(200, 300),
        })

    def tearDown(self) -> None:
        prepare_tsf._apply_spec(self.original_spec)

    def materialize(self, **kwargs) -> dict[str, Path]:
        self.frame.to_csv(self.source, index=False)
        with patch.object(prepare_tsf, "DATA_ROOT", self.root / "dataset"), patch.object(
            prepare_tsf, "PROJECT_ROOT", self.root
        ):
            return prepare_tsf.materialize_visible_splits(
                self.source, task_id="be", input_len=8, horizons=[4],
                split_ratios=[7, 1, 2], allow_irregular=False, **kwargs,
            )

    def test_be_role_columns_are_trimmed_in_splits_and_contract(self) -> None:
        paths = self.materialize(
            target_columns=["OT"],
            observed_past_covariates=["Generation forecast", "System load forecast"],
        )
        for split, start, end in (("train", 0, 70), ("visible", 0, 80), ("ref_test", 80, 100)):
            with self.subTest(split=split):
                frame = pd.read_csv(paths[split])
                self.assertEqual(frame.columns[:4].tolist(), [
                    "date", "OT", "Generation forecast", "System load forecast",
                ])
                self.assertEqual(frame["OT"].tolist(), list(range(200 + start, 200 + end)))
                self.assertEqual(frame["Generation forecast"].tolist(), list(range(start, end)))
                self.assertEqual(frame["System load forecast"].tolist(), list(range(100 + start, 100 + end)))
        spec = json.loads((self.root / "dataset" / "dataset_spec.json").read_text())
        self.assertEqual(spec["target_columns"], ["OT"])
        self.assertEqual(spec["observed_past_covariates"], ["Generation forecast", "System load forecast"])
        self.assertEqual(pd.read_csv(self.source).columns.tolist(), self.frame.columns.tolist())
        provenance = json.loads((self.root / "dataset" / "profile_provenance.json").read_text())
        self.assertEqual(provenance["source_sha256"], hashlib.sha256(self.source.read_bytes()).hexdigest())

    def test_inferred_and_explicit_features_use_trimmed_names(self) -> None:
        columns = ["Generation forecast", "System load forecast", "OT"]
        self.materialize()
        self.assertEqual(prepare_tsf.ACTIVE_SPEC.feature_columns, tuple(columns))
        self.materialize(feature_columns=columns, force=True)
        self.assertEqual(prepare_tsf.ACTIVE_SPEC.feature_columns, tuple(columns))

    def test_whitespace_name_collisions_are_rejected_before_writing(self) -> None:
        self.frame["Generation forecast"] = range(100)
        with self.assertRaisesRegex(ValueError, "duplicate column names after trimming whitespace.*Generation forecast"):
            self.materialize()
        self.assertFalse((self.root / "dataset").exists())

    def test_truly_missing_role_columns_remain_rejected(self) -> None:
        self.frame = self.frame.drop(columns=[" Generation forecast"])
        with self.assertRaisesRegex(ValueError, "missing required columns.*missing \\['Generation forecast'\\]"):
            self.materialize(
                target_columns=["OT"], observed_past_covariates=["Generation forecast"],
            )
        self.assertFalse((self.root / "dataset").exists())


if __name__ == "__main__":
    unittest.main()
