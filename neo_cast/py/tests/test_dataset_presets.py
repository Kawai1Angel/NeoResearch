from __future__ import annotations

import sys
import unittest
from pathlib import Path

import pandas as pd


PY_ROOT = Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

import prepare_tsf  # noqa: E402


class DatasetPresetTest(unittest.TestCase):
    def test_ettm1_preset_uses_tsl_minute_splits_and_ett_features(self) -> None:
        df = pd.DataFrame(
            {
                "date": pd.date_range("2021-01-01", periods=57_600, freq="15min"),
                "HUFL": range(57_600),
                "HULL": range(57_600),
                "MUFL": range(57_600),
                "MULL": range(57_600),
                "LUFL": range(57_600),
                "LULL": range(57_600),
                "OT": range(57_600),
            }
        )

        spec = prepare_tsf._build_materialize_spec(
            df=df,
            dataset_preset="ettm1",
            task_id=None,
            timestamp_col=None,
            feature_columns=None,
            input_len=None,
            horizons=None,
            train_rows=None,
            val_rows=None,
            ref_test_rows=None,
            missing_strategy=None,
            missing_limit=None,
            frequency=None,
            allow_irregular=None,
            irregular_ratio_warn=None,
        )

        self.assertEqual(spec.task_id, "ettm1")
        self.assertEqual(spec.feature_columns, ("HUFL", "HULL", "MUFL", "MULL", "LUFL", "LULL", "OT"))
        self.assertEqual(spec.train, (0, 34_560))
        self.assertEqual(spec.val, (34_560, 46_080))
        self.assertEqual(spec.ref_test, (46_080, 57_600))

    def test_weather_preset_uses_tsl_custom_split_and_infers_numeric_features(self) -> None:
        df = pd.DataFrame(
            {
                "date": pd.date_range("2021-01-01", periods=1_000, freq="10min"),
                "temp": range(1_000),
                "humidity": range(1_000),
                "label": ["x"] * 1_000,
            }
        )

        spec = prepare_tsf._build_materialize_spec(
            df=df,
            dataset_preset="weather",
            task_id=None,
            timestamp_col=None,
            feature_columns=None,
            input_len=64,
            horizons=[24],
            train_rows=None,
            val_rows=None,
            ref_test_rows=None,
            missing_strategy=None,
            missing_limit=None,
            frequency=None,
            allow_irregular=None,
            irregular_ratio_warn=None,
        )

        self.assertEqual(spec.task_id, "weather")
        self.assertEqual(spec.feature_columns, ("temp", "humidity"))
        self.assertEqual(spec.train, (0, 700))
        self.assertEqual(spec.val, (700, 800))
        self.assertEqual(spec.ref_test, (800, 1_000))


if __name__ == "__main__":
    unittest.main()
