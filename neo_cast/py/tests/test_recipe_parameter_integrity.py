from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from jsonschema import Draft202012Validator
import torch
import torch.nn.functional as F

from export import render_inference_py
from factory.build_model import build_model, GatedDepthwiseConvBlock, TimesBlockLite, parameter_graph_digest
from registry.action_specs import validate_recipe_against_registry
from test_recipe_factory import make_recipe
from validate import validate_recipe_object

PY_ROOT = Path(__file__).resolve().parents[1]


class RecipeParameterIntegrityTests(unittest.TestCase):
    def setUp(self) -> None:
        torch.manual_seed(31)
        torch.set_num_threads(1)

    def test_removed_head_is_rejected_by_every_schema_registry_and_factory(self) -> None:
        for schema_name, example_name in (
            ("recipe_schema.json", "recipe_native.example.json"),
            ("recipe_schema_v3.json", "recipe_diagonal_ssm.example.json"),
            ("model_recipe_v2_schema.json", "model_recipe_v2.example.json"),
        ):
            with self.subTest(schema=schema_name):
                schema = json.loads((PY_ROOT / "schemas" / schema_name).read_text())
                recipe = json.loads((PY_ROOT / "schemas" / example_name).read_text())
                section = recipe.get("architecture", recipe)
                section["prediction_head"] = {"type": "direct_multi_horizon", "output_distribution": "point"}
                self.assertTrue(list(Draft202012Validator(schema).iter_errors(recipe)))
                if "architecture" not in recipe:
                    self.assertTrue(validate_recipe_against_registry(recipe))
                    self.assertTrue(validate_recipe_object(recipe))
                    with self.assertRaises(ValueError):
                        build_model({"recipe": recipe, "num_channels": 2}, 16, 4)
                self.assertEqual(section["prediction_head"]["type"], "direct_multi_horizon")

    def test_convolution_preserves_requested_kernel_and_same_length(self) -> None:
        for kernel in (2, 3, 4):
            for name in ("gated_depthwise_conv", "timesnet_lite"):
                with self.subTest(backbone=name, kernel=kernel):
                    if name == "gated_depthwise_conv":
                        block = GatedDepthwiseConvBlock(hidden_dim=4, kernel_size=kernel, dropout=0)
                        self.assertEqual(block.depthwise.kernel_size, (kernel,))
                        x = torch.randn(2, 11, 4, requires_grad=True)
                        left = (kernel - 1) // 2
                        y = F.conv1d(F.pad(block.norm(x).transpose(1, 2), (left, kernel - 1 - left)),
                                     block.depthwise.weight, block.depthwise.bias, groups=4).transpose(1, 2)
                        expected = x + block.out(torch.tanh(y) * torch.sigmoid(block.gate(y)))
                        actual = block(x)
                    else:
                        block = TimesBlockLite(hidden_dim=4, top_k=2, kernel_size=kernel, dropout=0)
                        self.assertEqual(block.conv[0].kernel_size, (kernel, kernel))
                        x = torch.randn(2, 11, 4, requires_grad=True)
                        grid = F.pad(x, (0, 0, 0, 1)).reshape(2, 4, 3, 4).permute(0, 3, 1, 2)
                        left = (kernel - 1) // 2
                        y = F.conv2d(F.pad(grid, (left, kernel - 1 - left, left, kernel - 1 - left)),
                                     block.conv[0].weight, block.conv[0].bias)
                        expected = block.conv[2](F.gelu(y)).permute(0, 2, 3, 1).reshape(2, 12, 4)[:, :11]
                        actual = block._period_conv(x, 3)
                    torch.testing.assert_close(actual, expected)
                    self.assertEqual(actual.shape, x.shape)
                    actual.square().mean().backward()
                    self.assertTrue(torch.isfinite(x.grad).all())

    def test_even_kernel_training_and_standalone_export_roundtrip(self) -> None:
        for name in ("gated_depthwise_conv", "timesnet_lite"):
            with self.subTest(backbone=name), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                backbone = {"type": name, "hidden_dim": 8, "kernel_size": 2, "dropout": 0.0}
                backbone.update({"depth": 1} if name == "gated_depthwise_conv" else {"n_layers": 1, "top_k": 2})
                recipe = make_recipe(backbone=backbone)
                self.assertEqual(validate_recipe_object(recipe), [])
                config = {"recipe": recipe, "num_channels": 3}
                model = build_model(config, 16, 4)
                x = torch.randn(2, 16, 3)
                output = model(x)
                self.assertEqual(tuple(output.shape), (2, 4, 3))
                output.square().mean().backward()
                convs = [module for module in model.modules() if isinstance(module, (torch.nn.Conv1d, torch.nn.Conv2d))]
                self.assertTrue(any(module.kernel_size[0] == 2 for module in convs))
                self.assertFalse(any(module.kernel_size[0] == 3 for module in convs))
                model.eval()
                (root / "model_impl.py").write_text((PY_ROOT / "factory/build_model.py").read_text())
                (root / "metadata.json").write_text(json.dumps({"runtime_semantics_revision": 2,
                    "dataset_schema_version": "dataset.v1", "input_len": 16, "num_channels": 3, "horizons": [4]}))
                (root / "preprocess.json").write_text("{}")
                torch.save({"runtime_semantics_revision": 2, "candidate": {"model_config": config},
                            "state_dicts": {"4": model.state_dict()},
                            "model_manifests": {"4": {"parameter_graph_digest": parameter_graph_digest(model)}}}, root / "model.pt")
                namespace = {"__file__": str(root / "inference.py")}
                exec(render_inference_py(), namespace)
                loaded = namespace["load_model"]("cpu")["models"][4]
                torch.testing.assert_close(model(x), loaded(x))
