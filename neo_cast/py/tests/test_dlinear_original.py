from __future__ import annotations

import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import torch
from torch.nn import functional as F

from execution_contract import describe_model
from factory.build_model import build_model
from model_recipe import compile_model_recipe
from validate import validate_recipe_object

PY_ROOT = Path(__file__).resolve().parents[1]


def original_recipe() -> dict:
    return json.loads((PY_ROOT / "schemas/recipe_dlinear_original.example.json").read_text())


class OriginalDLinearTests(unittest.TestCase):
    def setUp(self) -> None:
        torch.manual_seed(2021)
        torch.set_num_threads(1)

    def test_direct_forecast_matches_original_equations_and_gradients(self) -> None:
        # Independent reference: replicate boundary values, decompose, project
        # each component directly from the history length to H, then add.
        for individual in (False, True):
            with self.subTest(individual=individual):
                recipe = original_recipe()
                recipe["backbone"]["individual"] = individual
                self.assertEqual(validate_recipe_object(recipe, input_len=168), [])
                model = build_model({"recipe": recipe, "num_channels": 3}, 168, 24)
                x = torch.randn(2, 168, 3, requires_grad=True)
                history = x.transpose(1, 2)
                padded = torch.cat((history[..., :1].expand(-1, -1, 12), history,
                                    history[..., -1:].expand(-1, -1, 12)), dim=-1)
                trend = F.avg_pool1d(padded, 25, stride=1)
                seasonal = history - trend
                core = model.model
                if individual:
                    expected = torch.stack([
                        F.linear(seasonal[:, i], core.seasonal_layers[i].weight, core.seasonal_layers[i].bias)
                        + F.linear(trend[:, i], core.trend_layers[i].weight, core.trend_layers[i].bias)
                        for i in range(3)
                    ], dim=1).transpose(1, 2)
                else:
                    expected = (F.linear(seasonal, core.seasonal.weight, core.seasonal.bias)
                                + F.linear(trend, core.trend.weight, core.trend.bias)).transpose(1, 2)
                actual = model(x)
                torch.testing.assert_close(actual, expected)
                parameters = (x, *model.parameters())
                left = torch.autograd.grad(actual.square().mean(), parameters, retain_graph=True)
                right = torch.autograd.grad(expected.square().mean(), parameters)
                for a, b in zip(left, right):
                    torch.testing.assert_close(a, b)
                    self.assertTrue(torch.isfinite(a).all())
                self.assertEqual(sum(p.numel() for p in model.parameters()), 8112 * (3 if individual else 1))
                self.assertFalse(list(model.prediction_head.parameters()))
                manifest = describe_model(model)
                self.assertEqual(manifest["prediction_head"], "identity")
                self.assertEqual(manifest["head_num_parameters"], 0)
                self.assertEqual(manifest["head_input_width"], 24)
                self.assertTrue(manifest["head_channel_shared"])
                self.assertIn("direct_horizon_forecast", manifest["mechanisms"])

    def test_target_only_output_is_independent_of_covariate_history(self) -> None:
        model = build_model({"recipe": original_recipe(), "num_channels": 3,
                             "num_target_channels": 1, "num_past_covariate_channels": 2,
                             "num_output_channels": 1}, 168, 24)
        x = torch.randn(2, 168, 3)
        expected = model(x)
        changed = x.clone()
        changed[..., 1:] += 100
        self.assertEqual(expected.shape, (2, 24, 1))
        torch.testing.assert_close(model(changed), expected)

    def test_rejects_wrong_width_legacy_version_and_extra_head_fields(self) -> None:
        recipe = original_recipe()
        with self.assertRaisesRegex(ValueError, "equal to the forecast horizon"):
            build_model({"recipe": recipe, "num_channels": 1}, 168, 48)
        legacy = copy.deepcopy(recipe)
        legacy["recipe_version"] = "recipe_schema_v2"
        legacy.pop("representation")
        legacy.pop("composition")
        self.assertTrue(validate_recipe_object(legacy, input_len=168))
        recipe["prediction_head"]["correction_dim"] = 16
        self.assertTrue(validate_recipe_object(recipe, input_len=168))

    def test_model_recipe_compiler_checks_all_requested_horizons(self) -> None:
        high = json.loads((PY_ROOT / "schemas/model_recipe_v2.example.json").read_text())
        recipe = original_recipe()
        high["architecture"] = {k: recipe[k] for k in
                                ("preprocessing", "embedding", "backbone", "fusion", "prediction_head", "representation", "composition")}
        self.assertEqual(compile_model_recipe(high)["prediction_head"]["type"], "identity")
        high["input"]["prediction_horizons"] = [24, 48]
        with self.assertRaisesRegex(ValueError, "every forecast horizon"):
            compile_model_recipe(high)

    def test_standalone_export_keeps_direct_structure_and_predictions(self) -> None:
        import export

        recipe = original_recipe()
        config = {"recipe": recipe, "num_channels": 2}
        model = build_model(config, 168, 24).eval()
        manifest = describe_model(model)
        candidate = {"model_config": config, "model_family": "recipe_factory", "candidate_id": "original_dlinear",
                     "recipe": recipe, "task": {"input_len": 168, "horizons": [24]}}
        metadata = export.build_metadata(run_id="original_dlinear", model_family="recipe_factory",
                                         model_impl_entry="model_impl.py:build_model", state_dict_layout="per_horizon",
                                         val_metrics={"val_avg_mse": 1.0}, horizons=[24],
                                         training_summary={"runtime_semantics_revision": 3, "model_manifests": {"24": manifest}})
        metadata.update(input_len=168, num_channels=2, dataset_schema_version="dataset.v1")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(export, "build_preprocess_spec", return_value={}):
                export.write_export_files(root, metadata, candidate=candidate)
            torch.save({"runtime_semantics_revision": 3, "candidate": candidate,
                        "state_dicts": {"24": model.state_dict()}, "model_manifests": {"24": manifest}}, root / "model.pt")
            x = torch.randn(1, 168, 2)
            (root / "expected.json").write_text(json.dumps({"x": x.tolist(), "y": model(x).detach().tolist()}))
            script = """import sys,json,torch
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import inference
d=json.loads((Path(sys.argv[1])/'expected.json').read_text())
model=inference.load_model('cpu')['models'][24]
assert sum(p.numel() for p in model.parameters()) == 8112
assert not list(model.prediction_head.parameters())
torch.testing.assert_close(model(torch.tensor(d['x'])),torch.tensor(d['y']),atol=1e-5,rtol=1e-4)
"""
            result = subprocess.run([sys.executable, "-I", "-c", script, directory],
                                    capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
