from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

PY_ROOT = Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

from factory.build_model import build_model
from model_recipe import compile_model_recipe, parse_max_params
from renderer import resolve_payload
from validate import detect_payload_kind, validate_payload, validate_required_horizons


def make_model_recipe() -> dict:
    return {
        "schema_version": "model_recipe.v1",
        "model_name": "MultiScaleTinyForecaster",
        "hypothesis": "A compact temporal convolution with decomposition should capture local multiscale dynamics.",
        "input": {
            "history_window": 96,
            "prediction_horizon": 24,
            "covariates": True,
        },
        "architecture": {
            "backbone": "temporal_conv",
            "decomposition": True,
            "layers": 3,
            "attention": "lightweight",
            "hidden_dim": 32,
            "kernel_size": 3,
            "dropout": 0.1,
        },
        "training": {
            "loss": "mse",
            "optimizer": "adamw",
            "learning_rate": 0.001,
            "batch_size": 64,
            "max_epochs": 4,
            "time_budget_s": 600,
            "patience": 2,
            "seed": 42,
        },
        "constraints": {
            "max_params": "5M",
            "latency_sensitive": True,
        },
    }


class ModelRecipeDslTest(unittest.TestCase):
    def test_model_recipe_compiles_to_executable_candidate_recipe(self) -> None:
        compiled = compile_model_recipe(make_model_recipe())

        self.assertEqual(compiled["recipe_version"], "recipe_schema_v1")
        self.assertEqual(compiled["recipe_id"], "recipe_multiscaletinyforecaster")
        self.assertEqual(compiled["preprocessing"]["actions"][0]["type"], "series_decomposition")
        self.assertEqual(compiled["embedding"]["type"], "none")
        self.assertEqual(compiled["backbone"]["type"], "tcn")
        self.assertEqual(compiled["backbone"]["n_layers"], 3)
        self.assertEqual(compiled["fusion"]["channel_mode"], "shared")
        self.assertEqual(compiled["training_strategy"]["optimizer"]["type"], "adamw")
        self.assertEqual(compiled["training_strategy"]["optimizer"]["lr"], 0.001)
        self.assertEqual(compiled["training_strategy"]["budget"]["batch_size"], 64)
        self.assertEqual(compiled["constraints"]["max_params"], 5_000_000)
        self.assertEqual(compiled["constraints"]["latency_priority"], "high")
        self.assertIn("compiled_from=model_recipe.v1", compiled["notes"])

        model = build_model({"recipe": compiled, "num_channels": 3}, input_len=96, horizon=24)
        self.assertIsNotNone(model)

    def test_model_recipe_validation_and_renderer_accept_high_level_dsl(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            payload_path = Path(tmp_dir) / "model_recipe.json"
            payload_path.write_text(json.dumps(make_model_recipe()), encoding="utf-8")

            self.assertEqual(validate_payload("model-recipe", payload_path), [])
            self.assertEqual(detect_payload_kind(payload_path), "model-recipe")

        resolved = resolve_payload(make_model_recipe())
        self.assertEqual(resolved["schema_version"], "resolved_candidate.v1")
        self.assertEqual(resolved["model_config"]["recipe"]["recipe_version"], "recipe_schema_v1")
        self.assertEqual(resolved["model_recipe"]["schema_version"], "model_recipe.v1")
        self.assertEqual(resolved["task"]["input_len"], 96)
        self.assertEqual(resolved["task"]["horizons"], [24])

    def test_model_recipe_renderer_preserves_multiple_prediction_horizons(self) -> None:
        payload = make_model_recipe()
        payload["input"]["prediction_horizons"] = [24, 48, 96]

        with tempfile.TemporaryDirectory() as tmp_dir:
            payload_path = Path(tmp_dir) / "model_recipe.json"
            payload_path.write_text(json.dumps(payload), encoding="utf-8")

            self.assertEqual(validate_payload("model-recipe", payload_path), [])

        resolved = resolve_payload(payload)
        self.assertEqual(resolved["task"]["horizons"], [24, 48, 96])

    def test_required_horizon_validation_rejects_missing_objective_horizons(self) -> None:
        errors = validate_required_horizons(
            {"schema_version": "resolved_candidate.v1", "task": {"horizons": [96]}},
            required_horizons=[96, 192, 336, 720],
        )

        self.assertEqual(
            errors,
            ["task.horizons missing required prediction horizons: 192, 336, 720"],
        )

    def test_parse_max_params_accepts_human_readable_units(self) -> None:
        self.assertEqual(parse_max_params("5M"), 5_000_000)
        self.assertEqual(parse_max_params("750K"), 750_000)
        self.assertEqual(parse_max_params(123456), 123456)


if __name__ == "__main__":
    unittest.main()
