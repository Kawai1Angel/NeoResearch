"""Mechanism tests: graph, gradients and real data flow, not merely class names."""
from __future__ import annotations

import copy
import importlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd
import torch

import prepare_tsf as data
import train
from dataset_contract import DatasetSpec
from execution_contract import describe_model
from factory.build_model import build_model, InstanceNormAction, MissingMaskAction
from registry.action_specs import ACTION_SPECS as ACTION_REGISTRY
from tests.test_recipe_factory import make_recipe
from validate import validate_recipe_object


class ActionSensitivityTest(unittest.TestCase):
    def setUp(self):
        torch.manual_seed(31)
        self.x = torch.randn(2, 16, 3)

    def model(self, recipe=None, horizon=4, **config):
        return build_model({"recipe": recipe or make_recipe(), "num_channels": 3, **config}, 16, horizon)

    def check(self, recipe, **kwargs):
        self.assertEqual(validate_recipe_object(recipe, input_len=16), [])
        model = self.model(recipe, **kwargs).eval()
        calendar = torch.tensor([12., 2., 15., 6.]).expand(2, 16, 4)
        x = self.x.clone().requires_grad_()
        output = model(x, calendar_features=calendar)
        self.assertEqual(output.shape, (2, 4, 3))
        self.assertTrue(torch.isfinite(output).all())
        output.square().mean().backward()
        self.assertGreater(x.grad.abs().sum().item(), 0)
        self.assertTrue(any(p.grad is not None and p.grad.abs().sum() > 0 for p in model.parameters()))
        self.assertNotEqual(describe_model(model)["backbone"], "unknown")
        return model

    def test_all_backbones_have_latents_and_gradients(self):
        configs = [
            {"type": "linear", "shared": False},
            {"type": "mlp", "hidden_dim": 8, "depth": 1, "dropout": 0.1},
            {"type": "transformer", "d_model": 8, "n_heads": 2, "n_layers": 1, "dropout": 0.1},
            {"type": "rnn", "hidden_dim": 8, "num_layers": 1, "cell": "gru", "dropout": 0.1},
            {"type": "dlinear", "kernel_size": 3},
            {"type": "tcn", "hidden_dim": 8, "n_layers": 1, "kernel_size": 3, "dropout": 0.1},
            {"type": "nbeats", "hidden_dim": 8, "n_layers": 1, "n_blocks": 2, "dropout": 0.1},
            {"type": "timesnet_lite", "hidden_dim": 8, "n_layers": 1, "top_k": 2, "kernel_size": 3, "dropout": 0.1},
            {"type": "gated_depthwise_conv", "hidden_dim": 8, "depth": 1, "dropout": 0.1},
            {"type": "mixer", "hidden_dim": 8, "depth": 1, "dropout": 0.1},
        ]
        self.assertEqual({c["type"] for c in configs}, set(ACTION_REGISTRY["backbone"]))
        for cfg in configs:
            with self.subTest(backbone=cfg["type"]):
                model = self.check(make_recipe(backbone=cfg))
                other = self.model(make_recipe(backbone=cfg), horizon=7)
                self.assertEqual(model.encode(self.x).shape, (2, 3, 16))
                self.assertEqual({k: v.shape for k, v in model.model.state_dict().items()}, {k: v.shape for k, v in other.model.state_dict().items()})
                self.assertGreater(describe_model(model)["head_num_parameters"], 0)

    def test_all_embeddings_affect_trainable_graph(self):
        configs = [
            {"type": "none"}, {"type": "patch", "patch_len": 4, "stride": 2, "d_model": 8},
            {"type": "multiscale_patch", "scales": [{"patch_len": 4, "stride": 2}, {"patch_len": 8, "stride": 4}], "d_model": 8},
            {"type": "invert", "d_model": 8},
            {"type": "frequency", "n_freq": 4, "d_model": 8, "complex_mode": "real_imag"},
            {"type": "calendar", "fields": ["hour", "dayofweek"], "embed_dim": 8},
        ]
        self.assertEqual({c["type"] for c in configs}, set(ACTION_REGISTRY["embedding"]))
        fingerprints = set()
        for cfg in configs:
            with self.subTest(embedding=cfg["type"]):
                model = self.check(make_recipe(embedding=cfg))
                fingerprints.add(describe_model(model)["parameter_graph_digest"])
        self.assertEqual(len(fingerprints), len(configs))

    def test_all_preprocessing_actions(self):
        configs = [{"type": "none"}, {"type": "last_value_centering"},
                   {"type": "instance_norm", "affine": True},
                   {"type": "series_decomposition", "kernel_size": 3},
                   {"type": "seasonal_differencing", "period": 4},
                   {"type": "missing_mask", "mask_channel": True},
                   {"type": "sample_reweighting", "scheme": "outlier_robust"}]
        self.assertEqual({c["type"] for c in configs}, set(ACTION_REGISTRY["preprocessing"]))
        for cfg in configs:
            with self.subTest(action=cfg["type"]):
                model = self.check(make_recipe(preprocessing=[cfg], fusion={"type": "feature_mlp"}))
                if cfg["type"] == "series_decomposition":
                    self.assertGreater(model.preprocessing[0].trend_model.weight.grad.abs().sum().item(), 0)

    def test_shared_linear_has_independent_channel_gradients(self):
        shared = self.model(make_recipe(backbone={"type": "linear", "shared": True}))
        independent = self.model()
        self.assertLess(sum(p.numel() for p in shared.parameters()), sum(p.numel() for p in independent.parameters()))
        independent(self.x)[:, :, 0].sum().backward()
        self.assertGreater(independent.model.layers[0].weight.grad.abs().sum().item(), 0)
        self.assertEqual(independent.model.layers[1].weight.grad.abs().sum().item(), 0)
        self.assertFalse(describe_model(independent)["linear_shared"])

    def test_centering_is_explicit_and_affine_is_per_variable(self):
        plain = self.model()
        for p in plain.parameters():
            p.data.zero_()
        self.assertTrue(torch.equal(plain(self.x), torch.zeros(2, 4, 3)))
        centered = self.model(make_recipe(preprocessing=[{"type": "last_value_centering"}]))
        for p in centered.parameters():
            p.data.zero_()
        self.assertTrue(torch.equal(centered(self.x), self.x[:, -1:, :].expand(2, 4, 3)))
        norm = InstanceNormAction(affine=True, num_channels=3)
        norm.scale.data[:] = torch.tensor([1., -0.5, 2.])
        norm.shift.data[:] = torch.tensor([0., 1., 2.])
        contexts = []
        normalized = norm.forward_transform(self.x, contexts)
        self.assertEqual(norm.scale.shape, (1, 1, 3))
        torch.testing.assert_close(norm.inverse_transform(normalized, contexts[0][1]), self.x)

    def test_all_fusions_and_ordered_toggles_are_distinct(self):
        configs = [{"type": "temporal", "channel_mode": "independent"}, {"type": "feature_mlp"},
                   {"type": "variate_attention"}, {"type": "graph", "adjacency_source": "learned"},
                   {"type": "gated_hybrid", "gate_type": "channel"},
                   {"type": "temporal_then_feature"}, {"type": "feature_then_temporal"}]
        self.assertEqual({c["type"] for c in configs}, set(ACTION_REGISTRY["fusion"]))
        fingerprints = set()
        for cfg in configs:
            model = self.check(make_recipe(fusion=cfg))
            fingerprints.add(describe_model(model)["parameter_graph_digest"])
        self.assertEqual(len(fingerprints), len(configs))
        for kind in ("temporal_then_feature", "feature_then_temporal"):
            outputs = []
            for gate, residual in ((False, False), (False, True), (True, False), (True, True)):
                torch.manual_seed(3)
                model = self.model(make_recipe(fusion={"type": kind, "gate": gate, "residual": residual})).eval()
                outputs.append(model(self.x))
            for i, left in enumerate(outputs):
                for right in outputs[i + 1:]:
                    self.assertFalse(torch.allclose(left, right))

    def test_hybrid_gate_types_have_distinct_graphs_and_nonzero_gradients(self):
        fingerprints = set()
        for kind in ("scalar", "channel", "time", "learned"):
            model = self.check(make_recipe(fusion={"type": "gated_hybrid", "gate_type": kind}))
            fingerprints.add(describe_model(model)["parameter_graph_digest"])
            self.assertTrue(any(p.grad is not None and p.grad.abs().sum() > 0 for n, p in model.latent_mixer.named_parameters() if "gate" in n))
        self.assertEqual(len(fingerprints), 4)

    def test_all_heads_own_output_parameters(self):
        fingerprints = set()
        for kind in ACTION_REGISTRY["head"]:
            head = {"type": kind, "output_distribution": kind if kind in {"quantile", "gaussian"} else "point"}
            if kind == "quantile":
                head["quantiles"] = [0.1, 0.5, 0.9]
            if kind == "residual_correction":
                head["correction_dim"] = 8
            recipe = make_recipe(prediction_head=head)
            recipe["training_strategy"]["loss"]["base"] = {"gaussian": "gaussian_nll", "quantile": "quantile"}.get(kind, "mse")
            self.assertEqual(validate_recipe_object(recipe), [])
            model = self.model(recipe)
            candidate = {"recipe": recipe}
            pred = train._predict_for_training(model, candidate, self.x)
            train._build_train_loss(candidate)(pred, torch.randn(2, 4, 3)).backward()
            for name, param in model.prediction_head.named_parameters():
                self.assertIsNotNone(param.grad, (kind, name))
                self.assertGreater(param.grad.abs().sum().item(), 0, (kind, name))
            fingerprints.add(describe_model(model)["parameter_graph_digest"])
        self.assertEqual(len(fingerprints), len(ACTION_REGISTRY["head"]))

    def test_dropout_and_transformer_ffn_settings_are_effective(self):
        for kind in ("mlp", "rnn", "gated_depthwise_conv", "mixer"):
            cfg = {"type": kind, "hidden_dim": 8, "dropout": 0., **({"num_layers": 1} if kind == "rnn" else {"depth": 1})}
            torch.manual_seed(5)
            left = self.model(make_recipe(backbone=cfg)).train()
            torch.manual_seed(5)
            right = self.model(make_recipe(backbone={**cfg, "dropout": 0.8})).train()
            self.assertFalse(torch.allclose(left(self.x), right(self.x)), kind)
        for mode in ("full", "lightweight", "none"):
            cfg = {"type": "transformer", "d_model": 8, "n_heads": 2, "n_layers": 1, "dropout": 0., "attention": mode}
            left = self.model(make_recipe(backbone={**cfg, "ffn_mult": 2}))
            right = self.model(make_recipe(backbone={**cfg, "ffn_mult": 4}))
            self.assertNotEqual(sum(p.numel() for p in left.parameters()), sum(p.numel() for p in right.parameters()))

    def test_removed_fields_and_legacy_recipe_fail_closed(self):
        for action, field, value in (("prediction_head", "share_across_horizons", True), ("prediction_head", "base_head", "linear"), ("fusion", "cross_attention", False)):
            recipe = make_recipe()
            recipe[action][field] = value
            self.assertTrue(validate_recipe_object(recipe))
            with self.assertRaises(ValueError):
                self.model(recipe)
        recipe = make_recipe()
        recipe["recipe_version"] = "recipe_schema_v1"
        with self.assertRaisesRegex(ValueError, "recipe_schema_v2"):
            self.model(recipe)

    def test_standalone_factory_field_contract_matches_schema(self):
        from factory.build_model import ACTION_FIELDS
        schema = json.loads((Path(__file__).parents[1] / "schemas/recipe_schema.json").read_text())
        for kind, definition in {"preprocessing": "preprocessingAction", "embedding": "embeddingAction", "backbone": "backboneAction", "fusion": "fusionAction", "prediction_head": "predictionHead"}.items():
            expected = {branch["properties"]["type"]["const"]: sorted(branch["properties"]) for branch in schema["$defs"][definition]["oneOf"]}
            self.assertEqual({name: sorted(fields) for name, fields in ACTION_FIELDS[kind].items()}, expected)

    def test_materialized_original_mask_reaches_loader_model_and_export(self):
        original_spec = data.ACTIVE_SPEC
        self.addCleanup(data._apply_spec, original_spec)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            frame = pd.DataFrame({"date": pd.date_range("2026-01-01", periods=40, freq="D"), "a": np.arange(40, dtype=float), "b": np.arange(40, dtype=float) * 2})
            frame.loc[[2, 26, 36], "b"] = np.nan
            source = root / "source.csv"
            frame.to_csv(source, index=False)
            with patch.object(data, "DATA_ROOT", root), patch.object(data, "PROJECT_ROOT", root):
                data.materialize_visible_splits(source, force=True, task_id="mask_test", timestamp_col="date", feature_columns=["a", "b"], input_len=16, horizons=[4], train_rows=(0, 24), val_rows=(24, 32), ref_test_rows=(32, 40), missing_strategy="mean_fill", frequency="D", allow_irregular=False)
                batch = next(iter(data.make_dataloader("train", 4, 2, shuffle=False, include_missing_mask=True)))
                self.assertEqual(batch["missing_mask"][0, 2, 1], 1)
                val_masks = [item["missing_mask"] for item in data.make_dataloader("val", 4, 2, shuffle=False, include_missing_mask=True)]
                self.assertGreater(sum(mask.sum().item() for mask in val_masks), 0)
                ref_batch = next(iter(data._iter_scaled_windows(data._build_ref_test_scaled_values(), horizon=4, batch_size=2, include_missing_mask=True)))
                self.assertEqual(ref_batch["missing_mask"][0, 10, 1], 1)
                self.assertTrue(torch.isfinite(batch["target_history"]).all())
                recipe = make_recipe(preprocessing=[{"type": "missing_mask", "mask_channel": True}], fusion={"type": "feature_mlp"})
                model = self.model(recipe, num_channels=2)
                pred = model(batch["target_history"], missing_mask=batch["missing_mask"])
                other = model(batch["target_history"], missing_mask=torch.zeros_like(batch["missing_mask"]))
                self.assertFalse(torch.allclose(pred, other))
                pred.square().mean().backward()
                mask_module = MissingMaskAction()
                values = torch.ones(1, 16, 2) * 9
                transformed = mask_module.forward_transform(values, [], torch.ones_like(values))
                torch.testing.assert_close(transformed[:, :, :2], values)
                from export import render_inference_py
                namespace = {"__file__": str(root / "inference.py")}
                (root / "model_impl.py").write_text("from factory.build_model import build_model\n")
                exec(render_inference_py(), namespace)
                inputs = namespace["_inference_inputs"]({"metadata": {"dataset_schema_version": "dataset.v1", "input_len": 16, "num_channels": 2, "target_channels": 2, "past_exogenous_channels": 0, "horizons": [4]}, "device": "cpu"}, {"target_history": values[0].numpy(), "missing_mask": np.ones((16, 2))}, 4)
                self.assertEqual(inputs["missing_mask"].sum(), 32)
                # A shorter CV train fold must refit the materialized imputation.
                with patch.object(data, "BORDER_TRAIN", (0, 8)), patch.object(data, "BORDER_VAL", (8, 16)), patch.object(data, "_VISIBLE_BUNDLE", None):
                    fold = data._load_visible_bundle()
                    self.assertAlmostEqual(fold.frame.loc[2, "b"], frame.loc[:7, "b"].mean())

    def test_graph_sources_are_fixed_or_trainable_and_digested(self):
        for source in ("learned", "static", "correlation"):
            fusion = {"type": "graph", "adjacency_source": source, "sparsity": 0.25}
            if source == "static":
                fusion["topology_artifact"] = "topology.json"
            model = self.check(make_recipe(fusion=fusion), graph_adjacency=np.eye(3).tolist())
            self.assertEqual(describe_model(model)["graph_source"], source)
            self.assertIn("adjacency_digest", describe_model(model))
            self.assertEqual(hasattr(model.channel_mixer, "adjacency_logits"), source == "learned")

    def test_correlation_graph_refits_on_each_train_fold_and_ignores_heldout(self):
        from types import SimpleNamespace
        values = np.random.default_rng(3).normal(size=(30, 3)).astype(np.float32)
        bundle = SimpleNamespace(target_values=values, past_covariate_values=np.empty((30, 0)))
        candidate = {"model_config": {"recipe": make_recipe(fusion={"type": "graph", "adjacency_source": "correlation"}), "num_channels": 3}}
        factory = importlib.import_module("factory.build_model")
        with patch.object(data, "_load_visible_bundle", return_value=bundle), patch.object(data, "TARGET_COLUMNS", ("a", "b", "c")), patch.object(data, "PAST_COVARIATE_COLUMNS", ()), patch.object(train, "_with_native_channel_roles", side_effect=lambda config: config):
            with patch.object(data, "BORDER_TRAIN", (0, 10)):
                train._build_runtime_model(factory, candidate, 16, 4)
                first = copy.deepcopy(candidate["model_config"]["graph_adjacency"])
                values[10:] *= -100
                train._build_runtime_model(factory, candidate, 16, 4)
                self.assertEqual(candidate["model_config"]["graph_adjacency"], first)
            with patch.object(data, "BORDER_TRAIN", (0, 20)):
                train._build_runtime_model(factory, candidate, 16, 4)
                self.assertNotEqual(candidate["model_config"]["graph_adjacency"], first)
                self.assertEqual(candidate["model_config"]["graph_provenance"]["train_rows"], [0, 20])
            with tempfile.TemporaryDirectory() as tmp:
                topology = Path(tmp) / "graph.json"
                topology.write_text(json.dumps({"channel_names": ["b", "a", "c"], "adjacency": np.eye(3).tolist()}))
                candidate["model_config"] = {"num_channels": 3, "recipe": make_recipe(fusion={"type": "graph", "adjacency_source": "static", "topology_artifact": str(topology)})}
                with self.assertRaisesRegex(ValueError, "channel_names"):
                    train._build_runtime_model(factory, candidate, 16, 4)

    def test_sample_reweighting_changes_loss_and_gradient(self):
        target = torch.zeros(2, 4, 3)
        target[0] = torch.arange(4).reshape(4, 1) * 10
        gradients = []
        for scheme in ("uniform", "horizon_tail", "outlier_robust"):
            pred = torch.ones_like(target, requires_grad=True)
            recipe = make_recipe(preprocessing=[{"type": "sample_reweighting", "scheme": scheme}])
            train._build_train_loss({"recipe": recipe})(pred, target).backward()
            gradients.append(pred.grad.clone())
        for i, left in enumerate(gradients):
            for right in gradients[i + 1:]:
                self.assertFalse(torch.allclose(left, right))

    def test_standalone_export_roundtrip_and_legacy_rejection(self):
        from export import render_inference_py
        from factory.build_model import parameter_graph_digest
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "model_impl.py").write_text((Path(__file__).parents[1] / "factory/build_model.py").read_text())
            metadata = {"runtime_semantics_revision": 2, "dataset_schema_version": "dataset.v1", "input_len": 16, "num_channels": 3, "horizons": [4]}
            (root / "metadata.json").write_text(json.dumps(metadata))
            (root / "preprocess.json").write_text("{}")
            for head in ("linear", "quantile", "gaussian", "residual_correction"):
                recipe = make_recipe(prediction_head={"type": head, "output_distribution": head if head in {"quantile", "gaussian"} else "point", **({"quantiles": [0.1, 0.5, 0.9]} if head == "quantile" else {}), **({"correction_dim": 8} if head == "residual_correction" else {})})
                model = self.model(recipe).eval()
                checkpoint = {"runtime_semantics_revision": 2, "candidate": {"model_config": {"recipe": recipe, "num_channels": 3}}, "state_dicts": {"4": model.state_dict()}, "model_manifests": {"4": {"parameter_graph_digest": parameter_graph_digest(model)}}}
                torch.save(checkpoint, root / "model.pt")
                namespace = {"__file__": str(root / "inference.py")}
                exec(render_inference_py(), namespace)
                bundle = namespace["load_model"]("cpu")
                loaded = bundle["models"][4]
                torch.testing.assert_close(model(self.x), loaded(self.x))
                if head == "quantile":
                    torch.testing.assert_close(model.forward_quantiles(self.x), loaded.forward_quantiles(self.x))
                if head == "gaussian":
                    torch.testing.assert_close(model.forward_distribution(self.x), loaded.forward_distribution(self.x))
            checkpoint.pop("runtime_semantics_revision")
            torch.save(checkpoint, root / "model.pt")
            with self.assertRaisesRegex(ValueError, "retrain"):
                namespace["load_model"]("cpu")


if __name__ == "__main__":
    unittest.main()
