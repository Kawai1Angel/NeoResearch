from __future__ import annotations

import sys
import hashlib
import json
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
        "known_future_covariates": [],
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
        "recipe_version": "recipe_schema_v2",
        "recipe_id": "native_exogenous_test",
        "hypothesis": "Native recipe factory handles structured exogenous inputs.",
        "preprocessing": {"actions": [{"type": "none"}]},
        "embedding": {"type": "none"},
        "backbone": {"type": "linear", "shared": False, "bias": True},
        "fusion": {"type": "temporal", "channel_mode": "independent"},
        "prediction_head": {"type": "linear", "output_distribution": "point"},
        "training_strategy": {
            "loss": {"base": "mse", "horizon_weighting": "uniform"},
            "optimizer": {"type": "adam", "lr": 0.001, "weight_decay": 0.0},
            "scheduler": {"type": "none", "warmup_steps": 0},
            "regularization": { "grad_clip": 1.0},
            "budget": {"max_epochs": 1, "time_budget_s": 10, "batch_size": 2, "patience": 1, "seed": 42},
        },
    }


class ExogenousSupportTest(unittest.TestCase):
    def tearDown(self) -> None:
        prepare_tsf._apply_spec(DatasetSpec.from_payload(prepare_tsf.DEFAULT_ETTH1_SPEC))

    def test_v2_allows_past_covariates_but_rejects_target_overlap(self) -> None:
        spec = DatasetSpec.from_payload(v2_payload())
        self.assertEqual(spec.feature_columns, ("power", "wind", "temp"))
        bad = v2_payload()
        bad["observed_past_covariates"] = ["power"]
        with self.assertRaisesRegex(ValueError, "target columns"):
            DatasetSpec.from_payload(bad)

    def test_future_and_static_requests_are_rejected_without_mutating_payload(self) -> None:
        from dataset_contract import reject_unsupported_covariates
        for field, value in (("known_future_covariates", ["wind"]), ("static_covariates", ["site"]),
                             ("known_future_source", "forecast"), ("known_future_available", True),
                             ("known_future_availability", {"available": True}),
                             ("future_covariate_mode", "concat_head"), ("num_future_covariate_channels", 1)):
            with self.subTest(field=field):
                payload = {field: value}
                with self.assertRaisesRegex(ValueError, f"UNSUPPORTED_COVARIATE: {field}"):
                    reject_unsupported_covariates(payload)
                self.assertEqual(payload[field], value)

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
                for field in ("known_future_covariates", "static_covariates"):
                    with self.subTest(field=field), self.assertRaisesRegex(ValueError, "UNSUPPORTED_COVARIATE"):
                        prepare_tsf.materialize_visible_splits(source, **{field: ["wind"]})
                    self.assertEqual(list(root.iterdir()), [source])
                prepare_tsf.materialize_visible_splits(
                    source,
                    force=True,
                    task_id="wind",
                    timestamp_col="date",
                    target_columns=["power"],
                    observed_past_covariates=["wind", "temp"],
                    input_len=4,
                    horizons=[2],
                    train_rows=(0, 12),
                    val_rows=(12, 16),
                    ref_test_rows=(16, 20),
                    missing_strategy="reject",
                    frequency="D",
                    allow_irregular=False,
                )
                provenance = json.loads((root / "profile_provenance.json").read_text())
                self.assertEqual(provenance["source_sha256"], hashlib.sha256(source.read_bytes()).hexdigest())
                self.assertEqual(provenance["train_sha256"], hashlib.sha256(prepare_tsf.TRAIN_DATA_PATH.read_bytes()).hexdigest())
                self.assertEqual(provenance["spec_sha256"], hashlib.sha256((root / "dataset_spec.json").read_bytes()).hexdigest())
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

    def test_exported_past_only_inputs_need_no_future_placeholder(self) -> None:
        from export import render_inference_py

        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "model_impl.py").write_text("from factory.build_model import build_model\n")
            namespace = {"__file__": str(Path(tmp, "inference.py"))}
            exec(render_inference_py(), namespace)
            metadata = {"dataset_schema_version": "dataset.v2", "input_len": 4, "horizons": [2], "target_channels": 1, "past_exogenous_channels": 2}
            bundle = {"metadata": metadata, "device": "cpu"}
            history = {"target_history": np.ones((4, 1)), "exogenous_past": np.ones((4, 2))}
            inputs = namespace["_inference_inputs"](bundle, history, 2)
            self.assertEqual(set(inputs), {"target_history", "exogenous_past"})
            with self.assertRaisesRegex(ValueError, "UNSUPPORTED_COVARIATE"):
                namespace["_inference_inputs"](bundle, {**history, "exogenous_future": np.ones((2, 2))}, 2)

    def test_native_recipe_model_accepts_exogenous_inputs_and_returns_target_only_output(self) -> None:
        target_history = torch.randn(3, 4, 1)
        past = torch.randn(3, 4, 2)
        future = torch.empty(3, 2, 0)
        model = build_model(
            {
                "recipe": recipe(),
                "num_channels": 3,
                "num_target_channels": 1,
                "num_past_covariate_channels": 2,
                "num_future_covariate_channels": 0,
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
        with self.assertRaisesRegex(ValueError, "UNSUPPORTED_COVARIATE"):
            model(target_history=target_history, exogenous_past=past, exogenous_future=torch.randn(3, 2, 1))
        with self.assertRaisesRegex(ValueError, "UNSUPPORTED_COVARIATE"):
            build_model({"recipe": recipe(), "num_future_covariate_channels": 1}, input_len=4, horizon=2)

    def test_observed_past_fusion_changes_target_and_receives_gradient(self) -> None:
        torch.manual_seed(7)
        payload = recipe()
        payload["fusion"] = {"type": "temporal", "channel_mode": "shared"}
        model = build_model({"recipe": payload, "num_channels": 3, "num_target_channels": 1,
                             "num_past_covariate_channels": 2, "num_output_channels": 1}, 4, 2)
        model.eval()
        target = torch.randn(3, 4, 1)
        past = torch.randn(3, 4, 2, requires_grad=True)
        output = model(target_history=target, exogenous_past=past)
        changed = model(target_history=target, exogenous_past=past + 2)
        self.assertFalse(torch.allclose(output, changed))
        output.square().mean().backward()
        self.assertGreater(past.grad.abs().sum().item(), 0)

if __name__ == "__main__":
    unittest.main()
