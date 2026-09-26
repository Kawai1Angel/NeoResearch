from __future__ import annotations

import json
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from pathlib import Path

import numpy as np
import torch
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from model_recipe import compile_model_recipe
from factory.build_model import build_model, SeriesDecompositionAction, DLinearCore
from renderer import resolve_payload, DEFAULT_PARAM_BUDGET_M
from train import _build_train_loss, _predict_for_training, measure_latency_ms
from prepare_tsf import calendar_values, _empty_probabilistic_state, _update_probabilistic_state, _finalize_probabilistic_state
from export import render_inference_py
import prepare_tsf
from validate import validate_payload


def recipe(**architecture):
    return {
        "schema_version": "model_recipe.v1", "model_name": "ConsistencyTest",
        "hypothesis": "Every declared mechanism must execute with its original meaning.",
        "input": {"history_window": 96, "prediction_horizon": 8, "covariates": False},
        "architecture": {"backbone": "transformer", "d_model": 16, "hidden_dim": 16, "heads": 4, "dropout": 0., **architecture},
        "training": {"loss": "mse", "optimizer": "adam", "learning_rate": .001, "batch_size": 2},
        "constraints": {"max_params": "5M", "latency_sensitive": False},
    }


def model_for(payload):
    compiled = compile_model_recipe(payload)
    return build_model({"recipe": compiled, "num_channels": 3}, 96, 8), {"recipe": compiled}


class ModelRecipeConsistencyTest(unittest.TestCase):
    def test_calendar_windows_follow_real_timestamp_slices(self):
        # Irregular starts must not reset calendar phase to zero for each window.
        dates = pd.to_datetime(["2026-01-01T23:00Z", "2026-01-02T02:00Z", "2026-01-03T07:00Z", "2026-01-04T10:00Z", "2026-01-05T12:00Z"])
        values = np.zeros((5, 3), dtype=np.float32)
        bundle = SimpleNamespace(frame=pd.DataFrame({"date": dates}), scaled_values=values, target_values=values, past_covariate_values=np.empty((5, 0), dtype=np.float32), future_covariate_values=np.empty((5, 0), dtype=np.float32))
        with patch.object(prepare_tsf, "_load_visible_bundle", return_value=bundle), patch.object(prepare_tsf, "TIMESTAMP_COL", "date"), patch.object(prepare_tsf, "INPUT_LEN", 2), patch.object(prepare_tsf, "HORIZONS", (1,)), patch.object(prepare_tsf, "BORDER_TRAIN", (0, 5)):
            dataset = prepare_tsf.WindowDataset("train", 1, include_calendar=True)
            self.assertEqual(dataset[0]["calendar_features"][:, 0].tolist(), [23., 2.])
            self.assertEqual(dataset[1]["calendar_features"][:, 0].tolist(), [2., 7.])

    def test_attention_modes_have_distinct_structures_and_gradients(self):
        for backbone in ("transformer", "temporal_conv"):
            counts = []
            structures = []
            for mode in ("none", "lightweight", "full"):
                model, _ = model_for(recipe(backbone=backbone, attention=mode))
                y = model(torch.randn(2, 96, 3))
                self.assertEqual(y.shape, (2, 8, 3))
                y.square().mean().backward()
                counts.append(sum(p.numel() for p in model.parameters()))
                structures.append(str(model))
                if mode != "none":
                    self.assertTrue(any(p.grad is not None and p.grad.abs().sum() > 0 for name, p in model.named_parameters() if "qkv" in name or "in_proj_weight" in name or "self_attn" in name))
            self.assertEqual(len(set(structures)), 3)
            self.assertLess(counts[0], min(counts[1:]))

    def test_invert_preserves_variable_tokens_and_cross_variable_attention(self):
        model, _ = model_for(recipe(embedding="invert", attention="full"))
        model.eval()
        self.assertIsInstance(model.model["position"], torch.nn.Identity)
        shapes = []
        handle = model.model["encoder"].register_forward_pre_hook(lambda module, args: shapes.append(tuple(args[0].shape)))
        x = torch.randn(2, 96, 3, requires_grad=True)
        y = model(x)
        y[:, :, 0].sum().backward()
        handle.remove()
        self.assertEqual(shapes, [(2, 3, 16)])
        self.assertGreater(x.grad[:, :, 1:].abs().sum().item(), 0)
        with torch.no_grad():
            base = model(x.detach())
            affine = model(x.detach() * 2.5 + 7.0)
        self.assertTrue(torch.allclose(affine, base * 2.5 + 7.0, atol=2e-4, rtol=2e-4))
        for backbone in ("linear", "mlp", "rnn", "gated_depthwise_conv", "mixer"):
            with self.subTest(backbone=backbone):
                other, _ = model_for(recipe(backbone=backbone, embedding="invert"))
                self.assertEqual(other(x.detach()).shape, (2, 8, 3))

    def test_gaussian_trains_scale_and_reports_nll(self):
        payload = recipe(output_distribution="gaussian", decomposition=True, decomposition_kernel=24)
        payload["training"]["loss"] = "gaussian_nll"
        model, candidate = model_for(payload)
        x, target = torch.randn(2, 96, 3), torch.randn(2, 8, 3)
        mean, scale = _predict_for_training(model, candidate, x)
        self.assertTrue((scale > 0).all())
        self.assertEqual(mean.shape, target.shape)
        loss = _build_train_loss(candidate)((mean, scale), target)
        loss.backward()
        self.assertGreater(model.prediction_head.log_var.weight.grad.abs().sum().item(), 0)
        state = _empty_probabilistic_state()
        _update_probabilistic_state(state, model, x, target, horizon=8, prefix="test")
        self.assertIn("gaussian_nll", _finalize_probabilistic_state(state))
        self.assertEqual(model.forward_quantiles(x).shape, (2, 8, 3, 3))

    def test_distribution_loss_matrix_and_schema_preservation(self):
        for distribution, loss in (("point", "mse"), ("quantile", "quantile"), ("gaussian", "gaussian_nll")):
            payload = recipe(output_distribution=distribution)
            payload["training"]["loss"] = loss
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "recipe.json"
                path.write_text(json.dumps(payload))
                self.assertEqual(validate_payload("model-recipe", path), [])
            payload["training"]["loss"] = "quantile" if distribution != "quantile" else "mse"
            with self.assertRaisesRegex(ValueError, "requires loss"):
                compile_model_recipe(payload)

    def test_multiscale_blocks_control_processing_depth_not_scale_count(self):
        parameter_counts = []
        for count in range(1, 5):
            compiled = compile_model_recipe(recipe(embedding="multiscale_patch", multiscale_blocks=count, layers=2))
            self.assertEqual(len(compiled["embedding"]["scales"]), 4)
            self.assertEqual(compiled["embedding"]["num_blocks"], count)
            self.assertEqual(compiled["backbone"]["n_layers"], 2)
            model = build_model({"recipe": compiled, "num_channels": 3}, 96, 8)
            output = model(torch.randn(2, 96, 3))
            self.assertEqual(output.shape, (2, 8, 3))
            self.assertEqual(len(model.model["embedding"].blocks), count)
            parameter_counts.append(sum(parameter.numel() for parameter in model.parameters()))
        self.assertEqual(parameter_counts, sorted(parameter_counts))
        self.assertEqual(len(set(parameter_counts)), 4)
        for settings in ({"backbone": "timesnet_lite", "embedding": "frequency"}, {"embedding": "frequency", "multiscale_blocks": 2}, {"heads": 6}):
            with self.assertRaises(ValueError):
                compile_model_recipe(recipe(**settings))

    def test_even_kernel_is_preserved_and_dlinear_decomposes_once(self):
        action = SeriesDecompositionAction(kernel_size=24)
        values = torch.randn(2, 96, 3)
        self.assertEqual(action._moving_average(values).shape, values.shape)
        self.assertEqual(action.kernel_size, 24)
        core = DLinearCore(input_len=96, horizon=8, kernel_size=24)
        self.assertEqual(core.kernel_size, 24)
        self.assertEqual(core(torch.randn(6, 96)).shape, (6, 8))
        model, candidate = model_for(recipe(backbone="dlinear", decomposition=True, decomposition_kernel=24))
        self.assertEqual(candidate["recipe"]["preprocessing"]["actions"], [{"type": "none"}])
        self.assertEqual(model.model.kernel_size, 24)

    def test_runtime_budgets_fusion_and_seed_are_preserved(self):
        payload = recipe(channel_fusion="independent")
        payload["input"]["covariates"] = True
        payload["training"].update(time_budget_s=1200, seed=0)
        payload["constraints"]["max_latency_ms"] = 17
        resolved = resolve_payload(payload)
        self.assertEqual(resolved["constraints"]["time_budget_s"], 1200)
        self.assertEqual(resolved["constraints"]["max_latency_ms"], 17)
        self.assertEqual(resolved["train_config"]["seed"], 0)
        self.assertEqual(resolved["recipe"]["fusion"]["channel_mode"], "independent")
        payload["constraints"]["max_params"] = int(DEFAULT_PARAM_BUDGET_M * 1e6) + 1
        with self.assertRaisesRegex(ValueError, "system limit"):
            resolve_payload(payload)
        model, _ = model_for(recipe())
        self.assertGreater(measure_latency_ms(model, torch.randn(2, 96, 3), repeats=2), 0)
        self.assertTrue(model.training)

    def test_calendar_uses_actual_dates_and_exports_distribution(self):
        dates = np.datetime64("2026-01-01T00") + np.arange(96).astype("timedelta64[h]")
        features = calendar_values(dates)
        payload = recipe(embedding="calendar", output_distribution="gaussian")
        payload["training"]["loss"] = "gaussian_nll"
        model, _ = model_for(payload)
        model.eval()
        x = torch.randn(1, 96, 3)
        with self.assertRaisesRegex(ValueError, "real calendar_features"):
            model(x)
        first = model(x, calendar_features=torch.from_numpy(features).unsqueeze(0))
        shifted = model(x, calendar_features=torch.from_numpy(calendar_values(dates + np.timedelta64(5, "h"))).unsqueeze(0))
        self.assertFalse(torch.allclose(first, shifted))
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "model_impl.py").write_text("from factory.build_model import build_model\n")
            namespace = {"__file__": str(Path(tmp, "inference.py"))}
            exec(render_inference_py(), namespace)
            bundle = {"models": {8: model}, "metadata": {"horizons": [8], "input_len": 96, "num_channels": 3}, "device": "cpu", "preprocess": {"scaler_mean": [10., 20., 30.], "scaler_std": [2., 3., 4.]}}
            history = {"history": x[0].numpy(), "timestamps": dates}
            result = namespace["predict_distribution_normalized"](bundle, history, 8)
            self.assertEqual(result["mean"].shape, (8, 3))
            self.assertTrue((result["scale"] > 0).all())
            raw = namespace["predict_distribution_raw"](bundle, history, 8)
            normalized = namespace["_normalize_history"](history, bundle["preprocess"])
            reference = namespace["predict_distribution_normalized"](bundle, normalized, 8)
            np.testing.assert_allclose(raw["scale"], reference["scale"] * [2., 3., 4.], rtol=1e-6)


if __name__ == "__main__":
    unittest.main()
