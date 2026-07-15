from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd
import torch


PY_ROOT = Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

import prepare_tsf  # noqa: E402
from dataset_contract import DatasetSpec  # noqa: E402
from factory.build_model import build_model  # noqa: E402


def v2_payload() -> dict:
    return {
        "schema_version": "dataset.v2",
        "task_id": "wind",
        "timestamp_col": "date",
        "target_columns": ["power"],
        "observed_past_covariates": ["wind", "temp"],
        "known_future_covariates": ["wind", "temp"],
        "static_covariates": [],
        "input_len": 4,
        "horizons": [2],
        "splits": {"train": [0, 12], "val": [12, 16], "ref_test": [16, 20]},
        "normalization": {"type": "standard", "fit_split": "train"},
        "missing": {"strategy": "reject", "limit": None},
        "time": {"frequency": "D", "allow_irregular": False, "irregular_ratio_warn": 0.01},
    }


def recipe() -> dict:
    return {
        "recipe_version": "recipe_schema_v1",
        "recipe_id": "native_exogenous_test",
        "hypothesis": "Native recipe factory handles structured exogenous inputs.",
        "preprocessing": {"actions": [{"type": "none"}]},
        "embedding": {"type": "none"},
        "backbone": {"type": "linear", "shared": False, "bias": True},
        "fusion": {"type": "temporal", "channel_mode": "independent"},
        "prediction_head": {"type": "linear", "output_distribution": "point", "share_across_horizons": False},
        "training_strategy": {
            "loss": {"base": "mse", "horizon_weighting": "uniform"},
            "optimizer": {"type": "adam", "lr": 0.001, "weight_decay": 0.0},
            "scheduler": {"type": "none", "warmup_steps": 0},
            "regularization": {"dropout": 0.0, "grad_clip": 1.0},
            "budget": {"max_epochs": 1, "time_budget_s": 10, "batch_size": 2, "patience": 1, "seed": 42},
        },
    }


class ExogenousSupportTest(unittest.TestCase):
    def tearDown(self) -> None:
        prepare_tsf._apply_spec(DatasetSpec.from_payload(prepare_tsf.DEFAULT_ETTH1_SPEC))

    def test_v2_allows_role_overlap_but_rejects_target_overlap(self) -> None:
        spec = DatasetSpec.from_payload(v2_payload())
        self.assertEqual(spec.feature_columns, ("power", "wind", "temp"))
        bad = v2_payload()
        bad["known_future_covariates"] = ["power"]
        with self.assertRaisesRegex(ValueError, "target columns"):
            DatasetSpec.from_payload(bad)

    def test_window_returns_target_only_structured_batch_and_train_fitted_scalers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            frame = pd.DataFrame({
                "date": pd.date_range("2026-01-01", periods=20, freq="D"),
                "power": np.arange(20, dtype=np.float32),
                "wind": np.arange(20, dtype=np.float32) * 2,
                "temp": np.arange(20, dtype=np.float32) + 10,
            })
            source = root / "wind.csv"
            frame.to_csv(source, index=False)
            with patch.object(prepare_tsf, "DATA_ROOT", root), patch.object(prepare_tsf, "PROJECT_ROOT", root):
                prepare_tsf.materialize_visible_splits(
                    source,
                    force=True,
                    task_id="wind",
                    timestamp_col="date",
                    target_columns=["power"],
                    observed_past_covariates=["wind", "temp"],
                    known_future_covariates=["wind", "temp"],
                    input_len=4,
                    horizons=[2],
                    train_rows=(0, 12),
                    val_rows=(12, 16),
                    ref_test_rows=(16, 20),
                    missing_strategy="reject",
                    frequency="D",
                    allow_irregular=False,
                )
                batch = prepare_tsf.WindowDataset("train", 2)[0]
                self.assertEqual(tuple(batch["target_history"].shape), (4, 1))
                self.assertEqual(tuple(batch["exogenous_past"].shape), (4, 2))
                self.assertEqual(tuple(batch["exogenous_future"].shape), (2, 0))
                self.assertEqual(tuple(batch["target"].shape), (2, 1))
                preprocess = prepare_tsf.build_preprocess_spec()
                self.assertEqual(preprocess["model_output_channels"], 1)
                self.assertEqual(preprocess["past_exogenous_channels"], 2)
                self.assertEqual(preprocess["known_future_covariate_names"], [])
                self.assertEqual(preprocess["future_exogenous_channels"], 0)
                self.assertAlmostEqual(preprocess["target_scaler"]["mean"][0], 5.5)

    def test_native_recipe_model_accepts_exogenous_inputs_and_returns_target_only_output(self) -> None:
        target_history = torch.randn(3, 4, 1)
        past = torch.randn(3, 4, 2)
        future = torch.randn(3, 2, 1)
        model = build_model(
            {
                "recipe": recipe(),
                "num_channels": 3,
                "num_target_channels": 1,
                "num_past_covariate_channels": 2,
                "num_future_covariate_channels": 1,
                "num_input_channels": 3,
                "num_output_channels": 1,
                "future_covariate_mode": "none",
            },
            input_len=4,
            horizon=2,
        )
        output = model(
            target_history=target_history,
            exogenous_past=past,
            exogenous_future=future,
        )
        self.assertEqual(tuple(output.shape), (3, 2, 1))

if __name__ == "__main__":
    unittest.main()
