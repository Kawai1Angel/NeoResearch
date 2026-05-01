from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

import torch
from torch.utils.data import DataLoader, TensorDataset


PY_ROOT = Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

import train as train_module  # noqa: E402


def phase2_quantile_candidate() -> dict[str, Any]:
    recipe = {
        "recipe_version": "recipe_schema_v1",
        "recipe_id": "phase2_quantile_train_test",
        "hypothesis": "Tiny phase-two quantile recipe should execute through train_models.",
        "preprocessing": {"actions": [{"type": "missing_mask", "mask_channel": True, "fill_policy": "mean"}]},
        "embedding": {"type": "frequency", "n_freq": 4, "d_model": 8, "complex_mode": "magnitude"},
        "backbone": {"type": "mixer", "hidden_dim": 8, "depth": 1, "temporal_mixing": "mlp", "dropout": 0.0},
        "fusion": {"type": "gated_hybrid", "gate_type": "channel"},
        "prediction_head": {
            "type": "quantile",
            "output_distribution": "quantile",
            "quantiles": [0.1, 0.5, 0.9],
        },
        "training_strategy": {
            "loss": {"base": "quantile", "quantiles": [0.1, 0.5, 0.9], "horizon_weighting": "tail_heavy"},
            "optimizer": {"type": "adamw", "lr": 0.001, "weight_decay": 0.0},
            "scheduler": {"type": "none", "warmup_steps": 0},
            "regularization": {"dropout": 0.0, "grad_clip": 1.0},
            "budget": {"max_epochs": 1, "time_budget_s": 10, "batch_size": 2, "patience": 1, "seed": 42},
        },
        "constraints": {"max_params": 1000000, "latency_priority": "medium"},
    }
    return {
        "schema_version": "resolved_candidate.v1",
        "candidate_id": "phase2_quantile_train_test",
        "hypothesis": recipe["hypothesis"],
        "model_family": "recipe_factory",
        "model_config": {"recipe": recipe, "num_channels": 3},
        "recipe": recipe,
        "train_config": {
            "lr": 0.001,
            "batch_size": 2,
            "max_epochs": 1,
            "weight_decay": 0.0,
            "patience": 1,
            "seed": 42,
        },
        "constraints": {"param_budget_m": 1.0, "time_budget_s": 10, "latency_priority": "medium"},
        "smoke_config": {"horizon": 4, "batch_size": 2, "max_epochs": 1, "timeout_s": 10},
        "task": {"task_id": "unit_test", "input_len": 16, "horizons": [4], "num_channels": 3},
    }


def phase2_invert_rnn_candidate() -> dict[str, Any]:
    recipe = {
        "recipe_version": "recipe_schema_v1",
        "recipe_id": "phase2_invert_rnn_train_test",
        "hypothesis": "Tiny phase-two invert RNN recipe should execute through train_models.",
        "preprocessing": {"actions": [{"type": "seasonal_differencing", "period": 4, "order": 1}]},
        "embedding": {"type": "invert", "d_model": 8},
        "backbone": {"type": "rnn", "cell": "gru", "hidden_dim": 8, "num_layers": 1, "dropout": 0.0},
        "fusion": {"type": "feature", "variate_token": True, "cross_attention": False},
        "prediction_head": {
            "type": "direct_multi_horizon",
            "output_distribution": "point",
            "horizon_specific": True,
        },
        "training_strategy": {
            "loss": {"base": "mae", "horizon_weighting": "front_heavy"},
            "optimizer": {"type": "adamw", "lr": 0.001, "weight_decay": 0.0},
            "scheduler": {"type": "cosine", "warmup_steps": 0},
            "regularization": {"dropout": 0.0, "grad_clip": 1.0},
            "budget": {"max_epochs": 1, "time_budget_s": 10, "batch_size": 2, "patience": 1, "seed": 42},
        },
        "constraints": {"max_params": 1000000, "latency_priority": "medium"},
    }
    return {
        "schema_version": "resolved_candidate.v1",
        "candidate_id": "phase2_invert_rnn_train_test",
        "hypothesis": recipe["hypothesis"],
        "model_family": "recipe_factory",
        "model_config": {"recipe": recipe, "num_channels": 3},
        "recipe": recipe,
        "train_config": {
            "lr": 0.001,
            "batch_size": 2,
            "max_epochs": 1,
            "weight_decay": 0.0,
            "patience": 1,
            "seed": 42,
        },
        "constraints": {"param_budget_m": 1.0, "time_budget_s": 10, "latency_priority": "medium"},
        "smoke_config": {"horizon": 4, "batch_size": 2, "max_epochs": 1, "timeout_s": 10},
        "task": {"task_id": "unit_test", "input_len": 16, "horizons": [4], "num_channels": 3},
    }


class TrainExecutionTest(unittest.TestCase):
    def train_and_load_summary(self, candidate: dict[str, Any]) -> dict[str, Any]:
        torch.manual_seed(9)

        def fake_loader(split: str, horizon: int, batch_size: int, shuffle: bool) -> DataLoader:
            del split, shuffle
            x = torch.randn(4, 16, 3)
            y = torch.randn(4, horizon, 3)
            return DataLoader(TensorDataset(x, y), batch_size=batch_size)

        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp)
            with (
                patch.object(train_module, "INPUT_LEN", 16),
                patch.object(train_module, "NUM_CHANNELS", 3),
                patch.object(train_module, "make_dataloader", fake_loader),
                patch.object(
                    train_module,
                    "evaluate_val_tsf",
                    lambda models, *, device, horizons: {"val_avg_mse": 0.123, "val_avg_mae": 0.456},
                ),
                patch.object(
                    train_module,
                    "build_preprocess_spec",
                    lambda: {"feature_names": ["a", "b", "c"], "scaler": {"type": "identity"}},
                ),
            ):
                exit_code = train_module.train_models(candidate=candidate, smoke=True, artifact_root=artifact_root)

            self.assertEqual(exit_code, 0)
            summaries = list(artifact_root.glob("run_*/training_summary.json"))
            self.assertEqual(len(summaries), 1)
            return json.loads(summaries[0].read_text(encoding="utf-8"))

    def test_phase2_quantile_recipe_trains_and_writes_execution_summary(self) -> None:
        summary = self.train_and_load_summary(phase2_quantile_candidate())
        self.assertEqual(summary["preprocessing_actions"], ["missing_mask"])
        self.assertEqual(summary["embedding"], "frequency")
        self.assertEqual(summary["backbone"], "mixer")
        self.assertEqual(summary["fusion"], "gated_hybrid")
        self.assertEqual(summary["prediction_head"], "quantile")
        self.assertEqual(summary["output_distribution"], "quantile")
        self.assertEqual(summary["training_prediction"], "quantile_distribution")
        self.assertEqual(summary["loss"], "quantile")
        self.assertEqual(summary["quantiles"], [0.1, 0.5, 0.9])

    def test_phase2_invert_rnn_feature_recipe_trains_and_writes_execution_summary(self) -> None:
        summary = self.train_and_load_summary(phase2_invert_rnn_candidate())
        self.assertEqual(summary["preprocessing_actions"], ["seasonal_differencing"])
        self.assertEqual(summary["embedding"], "invert")
        self.assertEqual(summary["backbone"], "rnn")
        self.assertEqual(summary["fusion"], "feature")
        self.assertEqual(summary["prediction_head"], "direct_multi_horizon")
        self.assertEqual(summary["output_distribution"], "point")
        self.assertEqual(summary["training_prediction"], "point_forecast")
        self.assertEqual(summary["loss"], "mae")

    def test_smoke_rejects_models_over_declared_param_budget(self) -> None:
        candidate = phase2_quantile_candidate()
        candidate["constraints"]["param_budget_m"] = 0.000001
        events: list[dict[str, Any]] = []

        def fake_loader(split: str, horizon: int, batch_size: int, shuffle: bool) -> DataLoader:
            del split, shuffle
            x = torch.randn(2, 16, 3)
            y = torch.randn(2, horizon, 3)
            return DataLoader(TensorDataset(x, y), batch_size=batch_size)

        with tempfile.TemporaryDirectory() as tmp:
            with (
                patch.object(
                    train_module.FAMILY_REGISTRY[candidate["model_family"]],
                    "build_model",
                    lambda _config, _input_len, _horizon: torch.nn.Linear(1, 1),
                ),
                patch.object(train_module, "make_dataloader", fake_loader),
                patch.object(train_module, "run_epoch", lambda *args, **kwargs: None),
                patch.object(train_module, "compute_val_loss", lambda *args, **kwargs: 1.0),
                patch.object(
                    train_module,
                    "evaluate_val_tsf",
                    lambda models, *, device, horizons: {"val_avg_mse": 0.123, "val_avg_mae": 0.456},
                ),
                patch.object(train_module, "save_run_artifacts", lambda **kwargs: None),
                patch.object(train_module, "emit", lambda event, **payload: events.append({"event": event, **payload})),
            ):
                exit_code = train_module.train_models(
                    candidate=candidate,
                    smoke=True,
                    artifact_root=Path(tmp),
                )

        self.assertEqual(exit_code, 3)
        self.assertIn(
            {
                "event": "error",
                "kind": "param_budget_exceeded",
                "candidate_id": candidate["candidate_id"],
                "num_params_m": 0.000002,
                "allowed_m": 0.000001,
            },
            events,
        )
        self.assertIn({"event": "done", "status": "smoke_fail"}, events)

    def test_timeout_horizon_done_reason_is_timeout(self) -> None:
        candidate = phase2_quantile_candidate()
        candidate["smoke_config"]["timeout_s"] = 0
        events: list[dict[str, Any]] = []

        def fake_loader(split: str, horizon: int, batch_size: int, shuffle: bool) -> DataLoader:
            del split, shuffle
            x = torch.randn(2, 16, 3)
            y = torch.randn(2, horizon, 3)
            return DataLoader(TensorDataset(x, y), batch_size=batch_size)

        with tempfile.TemporaryDirectory() as tmp:
            with (
                patch.object(train_module, "make_dataloader", fake_loader),
                patch.object(train_module, "run_epoch", lambda *args, **kwargs: None),
                patch.object(train_module, "compute_val_loss", lambda *args, **kwargs: 1.0),
                patch.object(
                    train_module,
                    "evaluate_val_tsf",
                    lambda models, *, device, horizons: {"val_avg_mse": 0.123, "val_avg_mae": 0.456},
                ),
                patch.object(train_module, "save_run_artifacts", lambda **kwargs: None),
                patch.object(train_module, "emit", lambda event, **payload: events.append({"event": event, **payload})),
            ):
                exit_code = train_module.train_models(
                    candidate=candidate,
                    smoke=True,
                    artifact_root=Path(tmp),
                )

        self.assertEqual(exit_code, 0)
        horizon_done = [event for event in events if event["event"] == "horizon_done"]
        self.assertEqual(len(horizon_done), 1)
        self.assertEqual(horizon_done[0]["reason"], "timeout")


if __name__ == "__main__":
    unittest.main()
