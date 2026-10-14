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


class DatasetDuplicatesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.original_spec = prepare_tsf.ACTIVE_SPEC
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "source.csv"
        self.frame = pd.DataFrame({
            "date": pd.date_range("1948-01-01", periods=100, freq="D"),
            "flow": range(100),
            "temperature": range(100),
        })

    def tearDown(self) -> None:
        prepare_tsf._apply_spec(self.original_spec)

    def materialize(self, frame: pd.DataFrame, **kwargs) -> dict[str, Path]:
        frame.to_csv(self.source, index=False)
        with patch.object(prepare_tsf, "DATA_ROOT", self.root / "dataset"), patch.object(
            prepare_tsf, "PROJECT_ROOT", self.root
        ):
            return prepare_tsf.materialize_visible_splits(
                self.source, task_id="mopex", target_columns=["flow"],
                observed_past_covariates=["temperature"], input_len=8, horizons=[4],
                allow_irregular=False, **kwargs,
            )

    def repeated_blocks(self) -> pd.DataFrame:
        return pd.concat([
            self.frame.iloc[:70], self.frame.iloc[60:70],
            self.frame.iloc[70:90], self.frame.iloc[80:90], self.frame.iloc[90:],
        ], ignore_index=True)

    def test_repeated_blocks_removed_before_ratio_splits_with_source_provenance(self) -> None:
        paths = self.materialize(self.repeated_blocks(), split_ratios=[7, 1, 2])
        spec = json.loads((self.root / "dataset" / "dataset_spec.json").read_text())
        self.assertEqual(spec["splits"], {"train": [0, 70], "val": [70, 80], "ref_test": [80, 100]})
        train = pd.read_csv(paths["train"])
        visible = pd.read_csv(paths["visible"])
        ref_test = pd.read_csv(paths["ref_test"])
        self.assertEqual(train["flow"].tolist(), list(range(70)))
        self.assertEqual(visible["flow"].tolist(), list(range(80)))
        self.assertEqual(ref_test["flow"].tolist(), list(range(80, 100)))
        self.assertTrue(set(visible["date"]).isdisjoint(ref_test["date"]))
        profile = json.loads(paths["profile"].read_text())
        self.assertEqual(profile["duplicate_action"], {
            "strategy": "drop_exact_source_rows", "rows_before": 120,
            "rows_after": 100, "rows_removed": 20,
        })
        self.assertEqual(profile["time"]["duplicate_timestamp_count"], 0)
        self.assertEqual(profile["time"]["inferred_frequency"], "D")
        provenance = json.loads((self.root / "dataset" / "profile_provenance.json").read_text())
        self.assertEqual(provenance["source_sha256"], hashlib.sha256(self.source.read_bytes()).hexdigest())
        self.assertEqual(len(pd.read_csv(self.source)), 120)

    def test_default_split_uses_deduplicated_row_count(self) -> None:
        self.materialize(self.repeated_blocks())
        self.assertEqual(prepare_tsf.ACTIVE_SPEC.ref_test, (80, 100))

    def test_custom_ratios_override_fixed_preset(self) -> None:
        self.materialize(self.repeated_blocks(), split_ratios=[3, 1, 1], dataset_preset="etth1")
        self.assertEqual(prepare_tsf.ACTIVE_SPEC.train, (0, 60))
        self.assertEqual(prepare_tsf.ACTIVE_SPEC.val, (60, 80))
        self.assertEqual(prepare_tsf.ACTIVE_SPEC.ref_test, (80, 100))

    def test_ratio_boundaries_match_integer_row_proportions(self) -> None:
        self.materialize(self.frame.iloc[:90], split_ratios=[7, 1, 2])
        self.assertEqual(prepare_tsf.ACTIVE_SPEC.train, (0, 63))
        self.assertEqual(prepare_tsf.ACTIVE_SPEC.val, (63, 72))

    def test_explicit_ranges_refer_to_deduplicated_rows(self) -> None:
        self.materialize(self.repeated_blocks(), train_rows=(0, 60), val_rows=(60, 80), ref_test_rows=(80, 100))
        self.assertEqual(prepare_tsf.ACTIVE_SPEC.train, (0, 60))
        with self.assertRaisesRegex(ValueError, "Expected at least 120, got 100"):
            self.materialize(self.repeated_blocks(), train_rows=(0, 60), val_rows=(60, 80), ref_test_rows=(80, 120))

    def test_conflicting_timestamp_values_remain_rejected(self) -> None:
        conflict = self.frame.iloc[[69]].copy()
        conflict["flow"] = 999
        frame = pd.concat([self.frame.iloc[:70], conflict, self.frame.iloc[70:]], ignore_index=True)
        with self.assertRaisesRegex(ValueError, "Duplicate timestamps found: 1.*different source values"):
            self.materialize(frame)
        self.assertFalse((self.root / "dataset").exists())

    def test_different_unselected_source_values_are_not_discarded(self) -> None:
        frame = self.frame.assign(site="a")
        conflict = frame.iloc[[69]].copy().assign(site="b")
        frame = pd.concat([frame.iloc[:70], conflict, frame.iloc[70:]], ignore_index=True)
        with self.assertRaisesRegex(ValueError, "Duplicate timestamps found: 1"):
            self.materialize(frame)

    def test_unique_out_of_order_rows_remain_rejected(self) -> None:
        frame = self.frame.iloc[[1, 0, *range(2, 100)]].reset_index(drop=True)
        with self.assertRaisesRegex(ValueError, "monotonic increasing"):
            self.materialize(frame)

    def test_invalid_and_conflicting_ratio_arguments(self) -> None:
        for ratios in ([7, 0, 2], [7, -1, 2], [7, 1], [float("nan"), 1, 2], [float("inf"), 1, 2]):
            with self.subTest(ratios=ratios), self.assertRaisesRegex(ValueError, "three finite positive"):
                self.materialize(self.frame, split_ratios=ratios)
        with self.assertRaisesRegex(ValueError, "cannot be combined"):
            self.materialize(self.frame, split_ratios=[7, 1, 2], train_rows=(0, 70), val_rows=(70, 80), ref_test_rows=(80, 100))


if __name__ == "__main__":
    unittest.main()
