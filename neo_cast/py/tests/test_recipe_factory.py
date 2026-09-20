from __future__ import annotations

import sys
import tempfile
import unittest
import json
from pathlib import Path
from typing import Any

import torch


PY_ROOT = Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

from factory.build_model import build_model  # noqa: E402
from model_recipe import compile_model_recipe  # noqa: E402
from registry.action_specs import validate_recipe_against_registry, validate_scheduler_warmup  # noqa: E402
import train as train_module  # noqa: E402
from train import _build_scheduler, _build_train_loss, _LinearWarmupWrapper, _step_scheduler  # noqa: E402
from validate import validate_payload  # noqa: E402


def make_recipe(
    *,
    preprocessing: list[dict[str, Any]] | None = None,
    embedding: dict[str, Any] | None = None,
    backbone: dict[str, Any] | None = None,
    fusion: dict[str, Any] | None = None,
    prediction_head: dict[str, Any] | None = None,
    training_strategy: dict[str, Any] | None = None,
    channel_mode: str = "independent",
) -> dict[str, Any]:
    return {
        "recipe_version": "recipe_schema_v1",
        "recipe_id": "test_recipe",
        "hypothesis": "Test recipe for native recipe factory.",
        "preprocessing": {"actions": preprocessing or [{"type": "none"}]},
        "embedding": embedding or {"type": "none"},
        "backbone": backbone or {"type": "linear", "shared": False, "bias": True},
        "fusion": fusion or {"type": "temporal", "channel_mode": channel_mode},
        "prediction_head": prediction_head or {
            "type": "linear",
            "output_distribution": "point",
            "share_across_horizons": False,
        },
        "training_strategy": training_strategy or {
            "loss": {"base": "mse", "horizon_weighting": "uniform"},
            "optimizer": {"type": "adam", "lr": 0.001, "weight_decay": 0.0},
            "scheduler": {"type": "none", "warmup_steps": 0},
            "regularization": {"dropout": 0.1, "grad_clip": 1.0},
            "budget": {"max_epochs": 1, "time_budget_s": 10, "batch_size": 2, "patience": 1, "seed": 42},
        },
        "constraints": {"max_params": 1000000, "latency_priority": "medium"},
    }


class RecipeFactoryTest(unittest.TestCase):
    def assert_forward_shape(self, recipe: dict[str, Any], *, input_len: int = 32, horizon: int = 8) -> None:
        torch.manual_seed(7)
        model_config = {"recipe": recipe}
        if recipe["embedding"]["type"] == "invert" or recipe["fusion"].get("type") != "temporal" or recipe["fusion"].get("channel_mode") == "shared":
            model_config["num_channels"] = 3
        model = build_model(model_config, input_len=input_len, horizon=horizon)
        model.eval()
        x = torch.randn(2, input_len, 3)
        kwargs = {"calendar_features": torch.tensor([[[12., 2., 15., 6.]]]).expand(2, input_len, 4)} if recipe["embedding"]["type"] == "calendar" else {}
        with torch.no_grad():
            y = model(x, **kwargs)
        self.assertEqual(tuple(y.shape), (2, horizon, 3))
        self.assertTrue(torch.isfinite(y).all().item())

    def test_linear_none_recipe_forward(self) -> None:
        self.assert_forward_shape(make_recipe())

    def test_patch_mlp_recipe_forward(self) -> None:
        recipe = make_recipe(
            embedding={"type": "patch", "patch_len": 8, "stride": 4, "d_model": 16},
            backbone={"type": "mlp", "depth": 2, "hidden_dim": 16, "activation": "gelu", "dropout": 0.1},
        )
        self.assert_forward_shape(recipe)

    def test_multiscale_patch_mlp_recipe_forward(self) -> None:
        recipe = make_recipe(
            embedding={
                "type": "multiscale_patch",
                "scales": [
                    {"patch_len": 4, "stride": 2},
                    {"patch_len": 8, "stride": 4},
                    {"patch_len": 16, "stride": 8},
                ],
                "d_model": 16,
            },
            backbone={"type": "mlp", "depth": 2, "hidden_dim": 16, "activation": "gelu", "dropout": 0.1},
        )
        self.assert_forward_shape(recipe)

    def test_instance_norm_patch_transformer_recipe_forward(self) -> None:
        recipe = make_recipe(
            preprocessing=[{"type": "instance_norm", "affine": False, "eps": 1e-5}],
            embedding={"type": "patch", "patch_len": 8, "stride": 8, "d_model": 16},
            backbone={
                "type": "transformer",
                "d_model": 16,
                "n_heads": 4,
                "n_layers": 1,
                "dropout": 0.1,
                "ffn_mult": 2.0,
            },
        )
        self.assert_forward_shape(recipe)

    def test_multiscale_patch_transformer_recipe_forward(self) -> None:
        recipe = make_recipe(
            embedding={
                "type": "multiscale_patch",
                "scales": [
                    {"patch_len": 4, "stride": 4},
                    {"patch_len": 8, "stride": 8},
                ],
                "d_model": 16,
            },
            backbone={
                "type": "transformer",
                "d_model": 16,
                "n_heads": 4,
                "n_layers": 1,
                "dropout": 0.1,
                "ffn_mult": 2.0,
            },
        )
        self.assert_forward_shape(recipe)

    def test_series_decomposition_linear_recipe_forward(self) -> None:
        recipe = make_recipe(
            preprocessing=[{"type": "series_decomposition", "method": "moving_average", "kernel_size": 9}],
        )
        self.assert_forward_shape(recipe)

    def test_dlinear_recipe_forward(self) -> None:
        recipe = make_recipe(
            embedding={"type": "none"},
            backbone={"type": "dlinear", "kernel_size": 9, "bias": True},
        )
        self.assert_forward_shape(recipe)

    def test_dlinear_individual_recipe_forward(self) -> None:
        recipe = make_recipe(
            embedding={"type": "none"},
            backbone={"type": "dlinear", "kernel_size": 9, "bias": True, "individual": True},
        )
        torch.manual_seed(7)
        model = build_model({"recipe": recipe, "num_channels": 3}, input_len=32, horizon=8)
        model.eval()
        x = torch.randn(2, 32, 3)
        with torch.no_grad():
            y = model(x)
        self.assertEqual(tuple(y.shape), (2, 8, 3))
        self.assertTrue(torch.isfinite(y).all().item())

    def test_tcn_recipe_forward(self) -> None:
        recipe = make_recipe(
            embedding={"type": "none"},
            backbone={
                "type": "tcn",
                "hidden_dim": 16,
                "n_layers": 2,
                "kernel_size": 3,
                "activation": "gelu",
                "dropout": 0.1,
            },
        )
        self.assert_forward_shape(recipe)

    def test_nbeats_recipe_forward(self) -> None:
        recipe = make_recipe(
            embedding={"type": "none"},
            backbone={
                "type": "nbeats",
                "hidden_dim": 32,
                "n_blocks": 2,
                "n_layers": 2,
                "activation": "gelu",
                "dropout": 0.1,
            },
        )
        self.assert_forward_shape(recipe)

    def test_timesnet_recipe_forward(self) -> None:
        recipe = make_recipe(
            embedding={"type": "none"},
            backbone={
                "type": "timesnet",
                "hidden_dim": 16,
                "n_layers": 1,
                "top_k": 2,
                "kernel_size": 3,
                "dropout": 0.1,
            },
        )
        self.assert_forward_shape(recipe)

    def test_shared_channel_mixer_patch_mlp_recipe_forward(self) -> None:
        recipe = make_recipe(
            channel_mode="shared",
            embedding={"type": "patch", "patch_len": 8, "stride": 4, "d_model": 16},
            backbone={"type": "mlp", "depth": 1, "hidden_dim": 16, "activation": "gelu", "dropout": 0.1},
        )
        self.assert_forward_shape(recipe)

    def test_shared_channel_mixer_requires_num_channels(self) -> None:
        recipe = make_recipe(channel_mode="shared")
        with self.assertRaisesRegex(ValueError, "num_channels"):
            build_model({"recipe": recipe}, input_len=32, horizon=8)

    def test_phase2_invert_rnn_feature_direct_head_recipe_forward(self) -> None:
        recipe = make_recipe(
            preprocessing=[{"type": "seasonal_differencing", "period": 4, "order": 1}],
            embedding={"type": "invert", "d_model": 12},
            backbone={"type": "rnn", "cell": "gru", "hidden_dim": 16, "num_layers": 1, "dropout": 0.0},
            fusion={"type": "feature"},
            prediction_head={
                "type": "direct_multi_horizon",
                "output_distribution": "point",
                "horizon_specific": True,
            },
        )

        self.assertEqual(validate_recipe_against_registry(recipe, input_len=32), [])
        self.assert_forward_shape(recipe)

    def test_frequency_mixer_gated_hybrid_quantile_recipe_forward(self) -> None:
        recipe = make_recipe(
            preprocessing=[{"type": "missing_mask", "mask_channel": True, "fill_policy": "mean"}],
            embedding={"type": "frequency", "n_freq": 6, "d_model": 10, "complex_mode": "real_imag"},
            backbone={
                "type": "mixer",
                "hidden_dim": 16,
                "depth": 2,
                "temporal_mixing": "mlp",
                "channel_mixing": "mlp",
                "dropout": 0.1,
            },
            fusion={"type": "gated_hybrid", "gate_type": "learned"},
            prediction_head={
                "type": "quantile",
                "output_distribution": "quantile",
                "quantiles": [0.1, 0.5, 0.9],
            },
            training_strategy={
                "loss": {"base": "quantile", "quantiles": [0.1, 0.5, 0.9], "horizon_weighting": "uniform"},
                "optimizer": {"type": "adamw", "lr": 0.001, "weight_decay": 0.0001},
                "scheduler": {"type": "one_cycle", "warmup_steps": 0},
                "regularization": {"dropout": 0.1, "grad_clip": 1.0},
                "budget": {"max_epochs": 1, "time_budget_s": 10, "batch_size": 2, "patience": 1, "seed": 42},
            },
        )

        self.assertEqual(validate_recipe_against_registry(recipe, input_len=32), [])
        self.assert_forward_shape(recipe)

    def test_quantile_head_exposes_full_distribution_for_training(self) -> None:
        recipe = make_recipe(
            preprocessing=[{"type": "missing_mask", "mask_channel": True, "fill_policy": "mean"}],
            embedding={"type": "frequency", "n_freq": 6, "d_model": 10, "complex_mode": "real_imag"},
            backbone={
                "type": "mixer",
                "hidden_dim": 16,
                "depth": 1,
                "temporal_mixing": "mlp",
                "channel_mixing": "mlp",
                "dropout": 0.0,
            },
            fusion={"type": "gated_hybrid", "gate_type": "learned"},
            prediction_head={
                "type": "quantile",
                "output_distribution": "quantile",
                "quantiles": [0.1, 0.5, 0.9],
            },
            training_strategy={
                "loss": {"base": "quantile", "quantiles": [0.1, 0.5, 0.9], "horizon_weighting": "uniform"},
                "optimizer": {"type": "adamw", "lr": 0.001, "weight_decay": 0.0001},
                "scheduler": {"type": "none", "warmup_steps": 0},
                "regularization": {"dropout": 0.0, "grad_clip": 1.0},
                "budget": {"max_epochs": 1, "time_budget_s": 10, "batch_size": 2, "patience": 1, "seed": 42},
            },
        )
        model = build_model({"recipe": recipe, "num_channels": 3}, input_len=32, horizon=8)
        x = torch.randn(2, 32, 3)
        x[0, 0, 0] = float("nan")

        with torch.no_grad():
            point = model(x)
            quantiles = model.forward_quantiles(x)
            training_pred = train_module._predict_for_training(model, {"recipe": recipe}, x)

        self.assertEqual(tuple(point.shape), (2, 8, 3))
        self.assertEqual(tuple(quantiles.shape), (2, 8, 3, 3))
        self.assertEqual(tuple(training_pred.shape), (2, 8, 3, 3))
        self.assertTrue(torch.isfinite(quantiles).all().item())

    def test_structured_exogenous_inputs_are_native_and_target_only(self) -> None:
        recipe = make_recipe(
            fusion={"type": "temporal", "channel_mode": "independent"},
            prediction_head={
                "type": "quantile",
                "output_distribution": "quantile",
                "quantiles": [0.1, 0.5, 0.9],
            },
        )
        model = build_model(
            {
                "recipe": recipe,
                "num_channels": 3,
                "num_target_channels": 1,
                "num_past_covariate_channels": 2,
                "num_future_covariate_channels": 1,
                "num_input_channels": 3,
                "num_output_channels": 1,
                "future_covariate_mode": "none",
            },
            input_len=32,
            horizon=8,
        )
        target_history = torch.randn(2, 32, 1)
        exogenous_past = torch.randn(2, 32, 2)
        exogenous_future = torch.randn(2, 8, 1)

        with torch.no_grad():
            point = model(
                target_history=target_history,
                exogenous_past=exogenous_past,
                exogenous_future=exogenous_future,
            )
            quantiles = model.forward_quantiles(
                target_history=target_history,
                exogenous_past=exogenous_past,
                exogenous_future=exogenous_future,
            )

        self.assertEqual(tuple(point.shape), (2, 8, 1))
        self.assertEqual(tuple(quantiles.shape), (2, 8, 1, 3))

    def test_recipe_execution_summary_records_phase2_distribution_actions(self) -> None:
        recipe = make_recipe(
            preprocessing=[
                {"type": "seasonal_differencing", "period": 4, "order": 1},
                {"type": "missing_mask", "mask_channel": True, "fill_policy": "mean"},
            ],
            embedding={"type": "frequency", "n_freq": 6, "d_model": 10, "complex_mode": "real_imag"},
            backbone={"type": "mixer", "hidden_dim": 16, "depth": 1, "dropout": 0.0},
            fusion={"type": "gated_hybrid", "gate_type": "learned"},
            prediction_head={
                "type": "quantile",
                "output_distribution": "quantile",
                "quantiles": [0.1, 0.5, 0.9],
            },
            training_strategy={
                "loss": {"base": "quantile", "quantiles": [0.1, 0.5, 0.9], "horizon_weighting": "tail_heavy"},
                "optimizer": {"type": "adamw", "lr": 0.001, "weight_decay": 0.0001},
                "scheduler": {"type": "plateau", "warmup_steps": 0},
                "regularization": {"dropout": 0.0, "grad_clip": 1.0},
                "budget": {"max_epochs": 1, "time_budget_s": 10, "batch_size": 2, "patience": 1, "seed": 42},
            },
        )

        summary = train_module._recipe_execution_summary({"recipe": recipe})

        self.assertEqual(summary["preprocessing_actions"], ["seasonal_differencing", "missing_mask"])
        self.assertEqual(summary["embedding"], "frequency")
        self.assertEqual(summary["backbone"], "mixer")
        self.assertEqual(summary["fusion"], "gated_hybrid")
        self.assertEqual(summary["prediction_head"], "quantile")
        self.assertEqual(summary["output_distribution"], "quantile")
        self.assertEqual(summary["quantiles"], [0.1, 0.5, 0.9])
        self.assertEqual(summary["training_prediction"], "quantile_distribution")
        self.assertEqual(summary["loss"], "quantile")

    def test_missing_mask_channel_expands_fusion_width_and_restores_output_channels(self) -> None:
        recipe = make_recipe(
            preprocessing=[{"type": "missing_mask", "mask_channel": True, "fill_policy": "zero"}],
            fusion={"type": "feature"},
        )
        model = build_model({"recipe": recipe, "num_channels": 3}, input_len=32, horizon=8)
        self.assertEqual(model.channel_mixer.num_channels, 6)

        x = torch.randn(2, 32, 3)
        x[0, 0, 0] = float("nan")
        with torch.no_grad():
            y = model(x)
        self.assertEqual(tuple(y.shape), (2, 8, 3))
        self.assertTrue(torch.isfinite(y).all().item())

    def test_calendar_ssm_graph_gaussian_recipe_forward(self) -> None:
        recipe = make_recipe(
            preprocessing=[{"type": "sample_reweighting", "scheme": "horizon_tail"}],
            embedding={"type": "calendar", "fields": ["hour", "dayofweek"], "embed_dim": 12},
            backbone={"type": "ssm", "state_dim": 14, "depth": 2, "dropout": 0.1},
            fusion={"type": "graph", "graph_type": "learned"},
            prediction_head={"type": "gaussian", "output_distribution": "gaussian", "variance_floor": 0.0001},
        )
        recipe["training_strategy"]["loss"]["base"] = "gaussian_nll"

        self.assertEqual(validate_recipe_against_registry(recipe, input_len=32), [])
        self.assert_forward_shape(recipe)

    def test_residual_correction_head_recipe_forward(self) -> None:
        recipe = make_recipe(
            prediction_head={
                "type": "residual_correction",
                "output_distribution": "point",
                "base_head": "linear",
                "correction_dim": 16,
            },
        )

        self.assertEqual(validate_recipe_against_registry(recipe, input_len=32), [])
        self.assert_forward_shape(recipe)

    def test_phase2_recipe_schema_accepts_native_action_space(self) -> None:
        recipe = make_recipe(
            preprocessing=[
                {"type": "seasonal_differencing", "period": 24, "order": 1},
                {"type": "missing_mask", "mask_channel": False, "fill_policy": "ffill"},
            ],
            embedding={"type": "frequency", "n_freq": 8, "d_model": 16, "complex_mode": "magnitude"},
            backbone={"type": "mixer", "hidden_dim": 16, "depth": 1, "dropout": 0.0},
            fusion={"type": "temporal_then_feature"},
            prediction_head={
                "type": "residual_correction",
                "output_distribution": "point",
                "base_head": "linear",
                "correction_dim": 16,
            },
            training_strategy={
                "loss": {"base": "quantile", "quantiles": [0.1, 0.5, 0.9], "horizon_weighting": "tail_heavy"},
                "optimizer": {"type": "adamw", "lr": 0.001, "weight_decay": 0.0001},
                "scheduler": {"type": "plateau", "warmup_steps": 0},
                "regularization": {"dropout": 0.1, "grad_clip": 1.0},
                "budget": {"max_epochs": 2, "time_budget_s": 10, "batch_size": 2, "patience": 1, "seed": 42},
            },
        )
        with tempfile.TemporaryDirectory() as tmp:
            recipe_path = Path(tmp) / "recipe.json"
            recipe_path.write_text(f"{json.dumps(recipe)}\n", encoding="utf-8")

            self.assertEqual(validate_payload("recipe", recipe_path), [])

    def test_recipe_schema_rejects_runtime_required_action_fields(self) -> None:
        recipe = make_recipe(embedding={"type": "patch"})
        with tempfile.TemporaryDirectory() as tmp:
            recipe_path = Path(tmp) / "recipe.json"
            recipe_path.write_text(f"{json.dumps(recipe)}\n", encoding="utf-8")

            errors = validate_payload("recipe", recipe_path)

        self.assertTrue(any("embedding" in error and "d_model" in error for error in errors))
        self.assertTrue(any("embedding" in error and "patch_len" in error for error in errors))

    def test_registry_rejects_runtime_required_action_fields(self) -> None:
        recipe = make_recipe(
            preprocessing=[{"type": "series_decomposition"}],
            embedding={"type": "patch"},
            backbone={"type": "transformer", "d_model": 16},
        )

        errors = validate_recipe_against_registry(recipe, input_len=32)

        self.assertIn("preprocessing.actions[0].type='series_decomposition' requires kernel_size", errors)
        self.assertIn("embedding.type='patch' requires d_model", errors)
        self.assertIn("backbone.type='transformer' requires n_heads", errors)

    def test_recipe_schema_accepts_opencode_fusion_parameters(self) -> None:
        for fusion in (
            {"type": "feature", "variate_token": True, "cross_attention": False},
            {"type": "temporal_then_feature", "gate": True, "residual": True},
            {"type": "feature_then_temporal", "gate": True, "residual": True},
            {"type": "graph", "adjacency_source": "correlation", "sparsity": 0.1},
            {"type": "gated_hybrid", "gate_type": "channel"},
        ):
            recipe = make_recipe(
                embedding={"type": "frequency", "n_freq": 8, "d_model": 16, "complex_mode": "magnitude"},
                backbone={"type": "mixer", "hidden_dim": 16, "depth": 1, "dropout": 0.0},
                fusion=fusion,
                prediction_head={
                    "type": "direct_multi_horizon",
                    "output_distribution": "point",
                    "horizon_specific": True,
                },
            )
            with tempfile.TemporaryDirectory() as tmp:
                recipe_path = Path(tmp) / "recipe.json"
                recipe_path.write_text(f"{json.dumps(recipe)}\n", encoding="utf-8")

                self.assertEqual(validate_payload("recipe", recipe_path), [])

    def test_phase2_ordered_fusion_variants_execute_forward(self) -> None:
        for fusion in (
            {"type": "temporal_then_feature", "gate": True, "residual": True},
            {"type": "feature_then_temporal", "gate": True, "residual": True},
        ):
            with self.subTest(fusion=fusion["type"]):
                recipe = make_recipe(
                    preprocessing=[{"type": "sample_reweighting", "scheme": "horizon_tail"}],
                    embedding={"type": "calendar", "fields": ["position", "dayofweek"], "embed_dim": 12},
                    backbone={"type": "ssm", "state_dim": 12, "depth": 1, "dropout": 0.0},
                    fusion=fusion,
                    prediction_head={
                        "type": "direct_multi_horizon",
                        "output_distribution": "point",
                        "horizon_specific": True,
                    },
                )

                self.assertEqual(validate_recipe_against_registry(recipe, input_len=32), [])
                self.assert_forward_shape(recipe)

    def test_quantile_loss_and_new_schedulers_execute(self) -> None:
        recipe = make_recipe(
            prediction_head={
                "type": "quantile",
                "output_distribution": "quantile",
                "quantiles": [0.1, 0.5, 0.9],
            },
            training_strategy={
                "loss": {"base": "quantile", "quantiles": [0.1, 0.5, 0.9], "horizon_weighting": "front_heavy"},
                "optimizer": {"type": "adam", "lr": 0.001, "weight_decay": 0.0},
                "scheduler": {"type": "plateau", "warmup_steps": 0},
                "regularization": {"dropout": 0.0, "grad_clip": 1.0},
                "budget": {"max_epochs": 2, "time_budget_s": 10, "batch_size": 2, "patience": 1, "seed": 42},
            },
        )
        candidate = {"recipe": recipe}
        pred = torch.zeros(2, 8, 3, 3)
        target = torch.ones(2, 8, 3)
        loss = _build_train_loss(candidate)(pred, target)
        self.assertGreater(float(loss.item()), 0.0)

        parameter = torch.nn.Parameter(torch.tensor([1.0]))
        optimizer = torch.optim.Adam([parameter], lr=0.001)
        plateau = _build_scheduler(optimizer, candidate, max_epochs=2)
        self.assertIsNotNone(plateau)
        _step_scheduler(plateau, 1.0)

        recipe["training_strategy"]["scheduler"] = {"type": "one_cycle", "warmup_steps": 0}
        one_cycle = _build_scheduler(optimizer, candidate, max_epochs=2)
        self.assertIsNotNone(one_cycle)
        optimizer.step()
        _step_scheduler(one_cycle, 1.0)

    def test_datasci_lradj_schedulers_match_epoch_end_rules(self) -> None:
        recipe = make_recipe(
            training_strategy={
                "loss": {"base": "mse", "horizon_weighting": "uniform"},
                "optimizer": {"type": "adam", "lr": 0.0001, "weight_decay": 0.0},
                "scheduler": {"type": "lradj_type1", "warmup_steps": 0},
                "regularization": {"dropout": 0.0, "grad_clip": 1.0},
                "budget": {"max_epochs": 10, "time_budget_s": 10, "batch_size": 2, "patience": 3, "seed": 42},
            },
        )
        candidate = {"recipe": recipe}
        parameter = torch.nn.Parameter(torch.tensor([1.0]))
        optimizer = torch.optim.Adam([parameter], lr=0.0001)
        scheduler = _build_scheduler(optimizer, candidate, max_epochs=10)
        self.assertIsNotNone(scheduler)

        _step_scheduler(scheduler, 1.0)
        self.assertAlmostEqual(optimizer.param_groups[0]["lr"], 0.0001)
        _step_scheduler(scheduler, 1.0)
        self.assertAlmostEqual(optimizer.param_groups[0]["lr"], 0.00005)

        recipe["training_strategy"]["scheduler"] = {"type": "lradj_type3", "warmup_steps": 0}
        parameter = torch.nn.Parameter(torch.tensor([1.0]))
        optimizer = torch.optim.Adam([parameter], lr=0.0001)
        scheduler = _build_scheduler(optimizer, candidate, max_epochs=10)
        self.assertIsNotNone(scheduler)
        for _ in range(3):
            _step_scheduler(scheduler, 1.0)
        self.assertAlmostEqual(optimizer.param_groups[0]["lr"], 0.0001)
        _step_scheduler(scheduler, 1.0)
        self.assertAlmostEqual(optimizer.param_groups[0]["lr"], 0.00009)

    def test_distillation_loss_blends_supervised_and_teacher_targets(self) -> None:
        recipe = make_recipe(
            training_strategy={
                "loss": {
                    "base": "distillation",
                    "horizon_weighting": "uniform",
                    "supervised_weight": 0.25,
                    "teacher_weight": 0.75,
                    "teacher": {"type": "last_value"},
                },
                "optimizer": {"type": "adam", "lr": 0.001, "weight_decay": 0.0},
                "scheduler": {"type": "none", "warmup_steps": 0},
                "regularization": {"dropout": 0.0, "grad_clip": 1.0},
                "budget": {"max_epochs": 1, "time_budget_s": 10, "batch_size": 2, "patience": 1, "seed": 42},
            }
        )
        candidate = {"recipe": recipe}
        context = torch.full((2, 8, 3), 2.0)
        target = torch.ones(2, 4, 3)
        prediction = torch.zeros(2, 4, 3)

        loss = _build_train_loss(candidate)(prediction, target, context)

        self.assertAlmostEqual(float(loss.item()), 3.25, places=6)

    def test_sample_reweighting_changes_training_loss(self) -> None:
        plain = make_recipe(training_strategy={
            "loss": {"base": "mse", "horizon_weighting": "uniform"},
            "optimizer": {"type": "adam", "lr": 0.001, "weight_decay": 0.0},
            "scheduler": {"type": "none", "warmup_steps": 0},
            "regularization": {"dropout": 0.0, "grad_clip": 1.0},
            "budget": {"max_epochs": 1, "time_budget_s": 10, "batch_size": 2, "patience": 1, "seed": 42},
        })
        robust = make_recipe(
            preprocessing=[{"type": "sample_reweighting", "scheme": "outlier_robust"}],
            training_strategy=plain["training_strategy"],
        )
        pred = torch.zeros(2, 8, 3)
        target = torch.ones(2, 8, 3)
        target[1] = 100.0

        plain_loss = _build_train_loss({"recipe": plain})(pred, target)
        robust_loss = _build_train_loss({"recipe": robust})(pred, target)

        self.assertLess(float(robust_loss.item()), float(plain_loss.item()))

    def test_transformer_rejects_invalid_head_count(self) -> None:
        recipe = make_recipe(
            embedding={"type": "patch", "patch_len": 8, "stride": 8, "d_model": 10},
            backbone={
                "type": "transformer",
                "d_model": 10,
                "n_heads": 4,
                "n_layers": 1,
                "dropout": 0.0,
                "ffn_mult": 2.0,
            },
        )
        with self.assertRaisesRegex(ValueError, "divisible"):
            build_model({"recipe": recipe}, input_len=32, horizon=8)

    def test_mixer_temporal_conv_channel_mlp_recipe_forward(self) -> None:
        recipe = make_recipe(
            backbone={
                "type": "mixer",
                "hidden_dim": 16,
                "depth": 1,
                "dropout": 0.0,
                "temporal_mixing": "conv",
                "channel_mixing": "mlp",
            },
        )
        self.assert_forward_shape(recipe)

    def test_mixer_temporal_mlp_channel_identity_recipe_forward(self) -> None:
        recipe = make_recipe(
            backbone={
                "type": "mixer",
                "hidden_dim": 16,
                "depth": 1,
                "dropout": 0.0,
                "temporal_mixing": "mlp",
                "channel_mixing": "identity",
            },
        )
        self.assert_forward_shape(recipe)

    def test_mixer_temporal_conv_channel_identity_recipe_forward(self) -> None:
        recipe = make_recipe(
            backbone={
                "type": "mixer",
                "hidden_dim": 16,
                "depth": 1,
                "dropout": 0.0,
                "temporal_mixing": "conv",
                "channel_mixing": "identity",
            },
        )
        self.assert_forward_shape(recipe)

    def test_mixer_rejects_unsupported_mixing_value(self) -> None:
        recipe = make_recipe(
            backbone={
                "type": "mixer",
                "hidden_dim": 16,
                "depth": 1,
                "dropout": 0.0,
                "temporal_mixing": "unsupported",
                "channel_mixing": "mlp",
            },
        )
        with self.assertRaisesRegex(ValueError, "Unsupported mixer"):
            build_model({"recipe": recipe}, input_len=32, horizon=8)

    def test_raw_backbones_reject_patch_embedding(self) -> None:
        for backbone in (
            {"type": "dlinear", "kernel_size": 9, "bias": True},
            {"type": "tcn", "hidden_dim": 16, "n_layers": 2, "kernel_size": 3, "dropout": 0.1},
            {"type": "nbeats", "hidden_dim": 32, "n_blocks": 2, "n_layers": 2, "dropout": 0.1},
            {"type": "timesnet", "hidden_dim": 16, "n_layers": 1, "top_k": 2, "kernel_size": 3, "dropout": 0.1},
        ):
            recipe = make_recipe(
                embedding={"type": "patch", "patch_len": 8, "stride": 4, "d_model": 16},
                backbone=backbone,
            )
            errors = validate_recipe_against_registry(recipe, input_len=32)
            self.assertIn(f"backbone.type='{backbone['type']}' requires embedding.type='none'", errors)

    def test_compile_training_warmup_ratio_to_steps(self) -> None:
        model_recipe = {
            "schema_version": "model_recipe.v1",
            "model_name": "WarmupTest",
            "hypothesis": "Warmup ratio should compile to clamped warmup_steps.",
            "input": {"history_window": 96, "prediction_horizon": 24, "covariates": False},
            "architecture": {"backbone": "linear"},
            "training": {
                "loss": "mse",
                "optimizer": "adamw",
                "learning_rate": 0.001,
                "batch_size": 32,
                "max_epochs": 8,
                "warmup_ratio": 0.25,
            },
            "constraints": {"max_params": "1M", "latency_sensitive": False},
        }
        compiled = compile_model_recipe(model_recipe)
        self.assertEqual(compiled["training_strategy"]["scheduler"], {"type": "none", "warmup_steps": 2})

        model_recipe["training"]["max_epochs"] = 2
        model_recipe["training"]["warmup_ratio"] = 0.5
        compiled = compile_model_recipe(model_recipe)
        self.assertEqual(compiled["training_strategy"]["scheduler"]["warmup_steps"], 1)

        model_recipe["training"]["warmup_ratio"] = 0.0
        compiled = compile_model_recipe(model_recipe)
        self.assertEqual(compiled["training_strategy"]["scheduler"]["warmup_steps"], 0)

    def test_validate_scheduler_warmup(self) -> None:
        strategy = {"scheduler": {"type": "none", "warmup_steps": 2}, "budget": {"max_epochs": 2}}
        self.assertEqual(
            validate_scheduler_warmup(strategy),
            ["scheduler.warmup_steps must be < budget.max_epochs"],
        )
        strategy["budget"]["max_epochs"] = 3
        self.assertEqual(validate_scheduler_warmup(strategy), [])

    def test_linear_warmup_wrapper_then_cosine(self) -> None:
        recipe = make_recipe(
            training_strategy={
                "loss": {"base": "mse", "horizon_weighting": "uniform"},
                "optimizer": {"type": "adam", "lr": 0.001, "weight_decay": 0.0},
                "scheduler": {"type": "cosine", "warmup_steps": 1},
                "regularization": {"dropout": 0.0, "grad_clip": 1.0},
                "budget": {"max_epochs": 3, "time_budget_s": 10, "batch_size": 2, "patience": 1, "seed": 42},
            },
        )
        candidate = {"recipe": recipe}
        parameter = torch.nn.Parameter(torch.tensor([1.0]))
        optimizer = torch.optim.Adam([parameter], lr=0.001)
        scheduler = _build_scheduler(optimizer, candidate, max_epochs=3)
        self.assertIsInstance(scheduler, _LinearWarmupWrapper)

        warmed_up_lr = optimizer.param_groups[0]["lr"]
        self.assertLess(warmed_up_lr, 0.001)

        _step_scheduler(scheduler, 1.0)
        self.assertAlmostEqual(optimizer.param_groups[0]["lr"], 0.001)

        _step_scheduler(scheduler, 1.0)
        self.assertLess(optimizer.param_groups[0]["lr"], 0.001)

    def test_build_scheduler_no_warmup_unchanged(self) -> None:
        recipe = make_recipe(
            training_strategy={
                "loss": {"base": "mse", "horizon_weighting": "uniform"},
                "optimizer": {"type": "adam", "lr": 0.001, "weight_decay": 0.0},
                "scheduler": {"type": "none", "warmup_steps": 0},
                "regularization": {"dropout": 0.0, "grad_clip": 1.0},
                "budget": {"max_epochs": 3, "time_budget_s": 10, "batch_size": 2, "patience": 1, "seed": 42},
            },
        )
        candidate = {"recipe": recipe}
        parameter = torch.nn.Parameter(torch.tensor([1.0]))
        optimizer = torch.optim.Adam([parameter], lr=0.001)
        self.assertIsNone(_build_scheduler(optimizer, candidate, max_epochs=3))


if __name__ == "__main__":
    unittest.main()
