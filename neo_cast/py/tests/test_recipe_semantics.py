from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path

import torch

PY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PY_ROOT))

from factory.build_model import build_model
from registry.action_specs import validate_output_contract
from search.mutate import mutate_recipe
from train import _build_train_loss, _predict_for_training
from validate import validate_recipe_object


def recipe() -> dict:
    return json.loads((PY_ROOT / "schemas/recipe_native.example.json").read_text())


class RecipeSemanticsTest(unittest.TestCase):
    def test_discriminators_reject_fields_from_other_actions(self) -> None:
        for field, config, unexpected in (
            ("backbone", {"type": "linear", "top_k": 2}, "top_k"),
            ("fusion", {"type": "graph", "cross_attention": True}, "cross_attention"),
            ("prediction_head", {"type": "linear", "output_distribution": "point", "quantiles": [0.5]}, "quantiles"),
            ("embedding", {"type": "none", "d_model": 16}, "d_model"),
            ("preprocessing", {"actions": [{"type": "none", "eps": 1e-5}]}, "eps"),
        ):
            with self.subTest(field=field):
                payload = recipe()
                payload[field] = config
                errors = validate_recipe_object(payload)
                self.assertTrue(any(field in error and unexpected in error for error in errors), errors)

    def test_complete_head_distribution_loss_matrix(self) -> None:
        for head in ("linear", "residual_correction", "quantile", "gaussian"):
            expected = head if head in {"quantile", "gaussian"} else "point"
            for distribution in ("point", "quantile", "gaussian"):
                for loss in ("mse", "mae", "huber", "distillation", "quantile", "gaussian_nll"):
                    allowed = {"point": {"mse", "mae", "huber", "distillation"}, "quantile": {"quantile"}, "gaussian": {"gaussian_nll"}}
                    with self.subTest(head=head, distribution=distribution, loss=loss):
                        errors = validate_output_contract({"type": head, "output_distribution": distribution}, {"base": loss})
                        self.assertEqual(not errors, distribution == expected and loss in allowed[expected])

    def test_quantile_levels_must_match_and_be_ordered(self) -> None:
        for levels in ([0.5, 0.1], [0.5, 0.5], [], [0, 0.5], [True], [float("nan")]):
            with self.subTest(levels=levels):
                self.assertTrue(validate_output_contract({"type": "quantile", "output_distribution": "quantile", "quantiles": levels}, {"base": "quantile"}))
        self.assertTrue(validate_output_contract({"type": "quantile", "output_distribution": "quantile", "quantiles": [0.1, 0.9]}, {"base": "quantile", "quantiles": [0.2, 0.8]}))

    def test_distribution_parameters_receive_gradients(self) -> None:
        for head, loss in (("quantile", "quantile"), ("gaussian", "gaussian_nll")):
            with self.subTest(head=head):
                torch.manual_seed(17)
                payload = recipe()
                payload["embedding"] = {"type": "none"}
                payload["backbone"] = {"type": "linear", "shared": True, "bias": True}
                payload["fusion"] = {"type": "temporal", "channel_mode": "independent"}
                payload["prediction_head"] = {"type": head, "output_distribution": head}
                if head == "quantile":
                    payload["prediction_head"]["quantiles"] = [0.1, 0.5, 0.9]
                payload["training_strategy"]["loss"] = {"base": loss}
                self.assertEqual(validate_recipe_object(payload), [])
                model = build_model({"recipe": payload, "num_channels": 2}, 8, 3)
                candidate = {"recipe": payload}
                pred = _predict_for_training(model, candidate, torch.randn(4, 8, 2))
                target = torch.randn(4, 3, 2)
                _build_train_loss(candidate)(pred, target).backward()
                for name, parameter in model.prediction_head.named_parameters():
                    self.assertIsNotNone(parameter.grad, name)
                    self.assertGreater(parameter.grad.abs().sum().item(), 0, name)
                if head == "quantile":
                    with self.assertRaisesRegex(ValueError, "prediction shape"):
                        _build_train_loss(candidate)(torch.zeros_like(target), target)

    def test_bias_mutations_are_valid_and_leave_parent_intact(self) -> None:
        parent = recipe()
        before = copy.deepcopy(parent)
        for bias in ("seasonal", "cross_var", "distribution_shift", "missing_values"):
            with self.subTest(bias=bias):
                result = mutate_recipe(parent, search_biases=[bias])
                self.assertEqual(validate_recipe_object(result), [])
        seasonal = mutate_recipe(parent, search_biases=["seasonal"])
        self.assertEqual(seasonal["preprocessing"]["actions"], [{"type": "series_decomposition", "method": "moving_average", "kernel_size": 25}])
        self.assertEqual(parent, before)

    def test_invalid_mutation_cannot_escape_validator(self) -> None:
        parent = recipe()
        parent["prediction_head"]["quantiles"] = [0.5]
        with self.assertRaisesRegex(ValueError, "Invalid mutated recipe.*prediction_head"):
            mutate_recipe(parent, search_biases=["seasonal"])


if __name__ == "__main__":
    unittest.main()
