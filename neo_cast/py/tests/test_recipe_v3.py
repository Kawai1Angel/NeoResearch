from __future__ import annotations

import copy
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest

import torch

from factory.build_model import build_model
from factory.encoders import DiagonalSSM, Mamba1, TimesBlock
from recipe_identity import ExperimentStore, file_digest, migrate_recipe, recipe_identity
from validate import validate_recipe_object

ROOT = Path(__file__).resolve().parents[1]


def recipe(name="diagonal_ssm"):
    value = json.loads((ROOT / f"schemas/recipe_{name}.example.json").read_text())
    value["backbone"]["dropout"] = 0.0
    return value


class StateSpaceTests(unittest.TestCase):
    def setUp(self):
        torch.manual_seed(42)
        torch.set_num_threads(1)

    def test_chunk_step_causality_and_state_reset(self):
        for model in (DiagonalSSM(4, 3), Mamba1(4, 3, 3), Mamba1(4, 3, 1)):
            with self.subTest(model=type(model).__name__):
                x = torch.randn(2, 13, 4, requires_grad=True)
                expected, _ = model.forward_state(x)
                a, state = model.forward_state(x[:, :5])
                b, _ = model.forward_state(x[:, 5:], state)
                torch.testing.assert_close(torch.cat((a, b), 1), expected, atol=1e-5, rtol=1e-4)
                state, steps = None, []
                for xt in x.split(1, dim=1):
                    out, state = model.forward_state(xt, state)
                    steps.append(out)
                torch.testing.assert_close(torch.cat(steps, 1), expected, atol=1e-5, rtol=1e-4)
                changed = x.detach().clone()
                changed[:, 8:] += 100
                torch.testing.assert_close(model(changed)[:, :8], expected[:, :8])
                torch.testing.assert_close(model(x), expected)
                expected.square().mean().backward()
                for name, parameter in model.named_parameters():
                    self.assertIsNotNone(parameter.grad, name)
                    self.assertTrue(torch.isfinite(parameter.grad).all(), name)

    def test_mamba_explicit_scan_reference(self):
        # Independent vectorized convolution + loop recurrence (official Mamba-1 equations).
        import torch.nn.functional as F
        model = Mamba1(4, 3, 3)
        x = torch.randn(2, 9, 4, requires_grad=True)
        u, z = model.in_proj(x).chunk(2, -1)
        u = F.silu(F.conv1d(u.transpose(1, 2), model.conv1d.weight, model.conv1d.bias,
                            padding=2, groups=model.d_inner)[..., :9].transpose(1, 2))
        dt, b, c = model.x_proj(u).split([model.dt_rank, model.d_state, model.d_state], -1)
        dt = F.softplus(model.dt_proj(dt))
        hidden = torch.zeros(2, model.d_inner, model.d_state)
        outputs = []
        for t in range(9):
            transition = torch.exp(torch.einsum("bd,dn->bdn", dt[:, t], -model.A_log.exp()))
            hidden = transition * hidden + torch.einsum("bd,bn,bd->bdn", dt[:, t], b[:, t], u[:, t])
            outputs.append((torch.einsum("bdn,bn->bd", hidden, c[:, t]) + model.D * u[:, t]) * F.silu(z[:, t]))
        expected = model.out_proj(torch.stack(outputs, 1))
        actual = model(x)
        torch.testing.assert_close(actual, expected, atol=1e-5, rtol=1e-4)
        params = (x, *model.parameters())
        for left, right in zip(torch.autograd.grad(actual.sum(), params, retain_graph=True), torch.autograd.grad(expected.sum(), params)):
            torch.testing.assert_close(left, right, atol=1e-5, rtol=1e-4)

    def test_timesblock_sample_independence_period_and_gradients(self):
        model = TimesBlock(4, 8, 2, 2)
        wave = torch.sin(torch.arange(24) * (2 * torch.pi / 6)).reshape(1, 24, 1).repeat(1, 1, 4)
        self.assertEqual(model.periods(wave)[0][0, 0].item(), 6)
        x = torch.randn(2, 17, 4, requires_grad=True)
        actual = model(x)
        torch.testing.assert_close(actual, torch.cat([model(sample) for sample in x.split(1)]))
        actual.square().mean().backward()
        self.assertTrue(all(p.grad is not None for p in model.parameters()))
        self.assertTrue(torch.isfinite(x.grad).all())
        self.assertTrue(torch.isfinite(model(torch.zeros_like(x))).all())
        with self.assertRaises(ValueError):
            model(torch.zeros(1, 2, 4))

    def test_long_sequence_and_unavailable_backend(self):
        for model in (DiagonalSSM(4, 3), Mamba1(4, 3)):
            self.assertTrue(torch.isfinite(model(torch.randn(1, 1024, 4))).all())
        with self.assertRaisesRegex(ValueError, "UNSUPPORTED_BACKEND"):
            Mamba1(4, backend="cuda_optimized")

    def test_timesblock_single_sample_reference_and_gradient(self):
        # Official TimesBlock mechanism on one sample, with identical local weights.
        import torch.nn.functional as F
        model = TimesBlock(3, 5, 2, 2)
        x = torch.randn(1, 17, 3, requires_grad=True)
        spectrum = torch.fft.rfft(x, dim=1).abs().mean((0, 2))
        selected = torch.topk(spectrum[1:], 2).indices + 1
        branches = []
        for frequency in selected:
            period = 17 // int(frequency)
            length = ((17 + period - 1) // period) * period
            padded = torch.cat((x, x.new_zeros(1, length - 17, 3)), dim=1)
            grid = padded.reshape(1, length // period, period, 3).permute(0, 3, 1, 2)
            for index, layer in enumerate((model.conv[0], model.conv[2])):
                grid = sum(F.conv2d(grid, kernel.weight, kernel.bias, padding=kernel.padding)
                           for kernel in layer.kernels) / len(layer.kernels)
                if index == 0:
                    grid = F.gelu(grid)
            branches.append(grid.permute(0, 2, 3, 1).reshape(1, length, 3)[:, :17])
        expected = x + (torch.stack(branches, -1) * spectrum[selected].softmax(0)).sum(-1)
        actual = model(x)
        torch.testing.assert_close(actual, expected)
        parameters = (x, *model.parameters())
        for left, right in zip(torch.autograd.grad(actual.sum(), parameters, retain_graph=True),
                               torch.autograd.grad(expected.sum(), parameters)):
            torch.testing.assert_close(left, right, atol=1e-5, rtol=1e-4)


class TypedModelTests(unittest.TestCase):
    def setUp(self):
        torch.set_num_threads(1)

    def test_shapes_heads_masks_and_manifest(self):
        from execution_contract import describe_model
        for name in ("diagonal_ssm", "timesblock_encoder", "mamba"):
            for layout in ("sequence_latent", "channel_sequence"):
                for head, loss in (("linear", "mse"), ("quantile", "quantile"), ("gaussian", "gaussian_nll")):
                    with self.subTest(name=name, layout=layout, head=head):
                        r = recipe(name)
                        r["representation"]["layout"] = layout
                        r["prediction_head"] = {"type": head, "output_distribution": head if head != "linear" else "point"}
                        r["training_strategy"]["loss"]["base"] = loss
                        model = build_model({"recipe": r, "num_channels": 3, "num_target_channels": 2, "num_output_channels": 2}, 16, 4)
                        x = torch.randn(2, 16, 3)
                        self.assertEqual(model(x).shape, (2, 4, 2))
                        if head == "quantile":
                            self.assertEqual(model.forward_quantiles(x).shape, (2, 4, 2, 1))
                        if head == "gaussian":
                            mean, scale = model.forward_distribution(x)
                            self.assertTrue((scale > 0).all())
                            self.assertEqual(mean.shape, (2, 4, 2))
                        self.assertEqual(describe_model(model)["backbone"], name)
            r = recipe(name)
            r["preprocessing"] = {"actions": [{"type": "missing_mask", "mask_channel": True}]}
            model = build_model({"recipe": r, "num_channels": 3, "num_target_channels": 2, "num_output_channels": 2}, 16, 4).eval()
            x = torch.randn(2, 16, 3, requires_grad=True)
            mask = torch.zeros_like(x)
            a = model(x, missing_mask=mask)
            b = model(x, missing_mask=mask + 1)
            self.assertFalse(torch.allclose(a, b))
            a.sum().backward()
            self.assertGreater(x.grad[..., 2].abs().sum().item(), 0)

    def test_compositions_and_no_unused_parameters(self):
        for kind, merge in (("parallel_two_branch", "latent_gate"), ("parallel_two_branch", "history_time_gate"),
                            ("parallel_two_branch", "forecast_step_gate"), ("decomposition_two_branch", None)):
            r = recipe()
            other = recipe("mamba")
            secondary = {key: other[key] for key in ("embedding", "backbone", "representation")}
            r["composition"] = {"type": kind, "secondary": secondary, **({"merge": merge} if merge else {"kernel_size": 3})}
            model = build_model({"recipe": r, "num_channels": 2}, 16, 4)
            output = model(torch.randn(2, 16, 2))
            self.assertEqual(output.shape, (2, 4, 2))
            output.square().mean().backward()
            for name, p in model.named_parameters():
                self.assertIsNotNone(p.grad, f"{kind}/{merge}/{name}")

    def test_invalid_connections_and_budgets(self):
        r = recipe()
        r["representation"]["readout"] = "none"
        self.assertTrue(validate_recipe_object(r, input_len=16))
        r = recipe("timesblock_encoder")
        self.assertTrue(validate_recipe_object(r, input_len=2))
        r = recipe()
        r["constraints"]["max_params"] = 1
        with self.assertRaisesRegex(ValueError, "RESOURCE_LIMIT"):
            build_model({"recipe": r, "num_channels": 2}, 16, 4)
        r = recipe()
        r["constraints"]["max_activation_elements"] = 1
        model = build_model({"recipe": r, "num_channels": 2}, 16, 4)
        with self.assertRaisesRegex(ValueError, "RESOURCE_LIMIT"):
            model(torch.randn(2, 16, 2))

    def test_migration_preserves_legacy_predictions(self):
        old = json.loads((ROOT / "schemas/recipe_native.example.json").read_text())
        new = migrate_recipe(old, input_len=32)["recipe"]
        torch.manual_seed(42)
        a = build_model({"recipe": old, "num_channels": 2}, 32, 4).eval()
        torch.manual_seed(42)
        b = build_model({"recipe": new, "num_channels": 2}, 32, 4).eval()
        x = torch.randn(2, 32, 2)
        torch.testing.assert_close(a(x), b(x))

    def test_standalone_v3_export_has_no_workspace_import_dependency(self):
        from unittest.mock import patch
        import export
        from execution_contract import describe_model
        for name in ("diagonal_ssm", "timesblock_encoder", "mamba"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                r = recipe(name)
                config = {"recipe": r, "num_channels": 2}
                model = build_model(config, 16, 4).eval()
                manifest = describe_model(model)
                candidate = {"model_config": config, "model_family": "recipe_factory", "candidate_id": name,
                             "recipe": r, "task": {"input_len": 16, "horizons": [4]}}
                metadata = export.build_metadata(run_id=f"v3_{name}", model_family="recipe_factory", model_impl_entry="model_impl.py:build_model",
                                                 state_dict_layout="per_horizon", val_metrics={"val_avg_mse": 1.0}, horizons=[4],
                                                 training_summary={"runtime_semantics_revision": 3, "model_manifests": {"4": manifest}})
                metadata.update(input_len=16, num_channels=2, dataset_schema_version="dataset.v1")
                root = Path(directory)
                with patch.object(export, "build_preprocess_spec", return_value={}):
                    export.write_export_files(root, metadata, candidate=candidate)
                torch.save({"runtime_semantics_revision": 3, "candidate": candidate, "state_dicts": {"4": model.state_dict()},
                            "model_manifests": {"4": manifest}}, root / "model.pt")
                x = torch.randn(1, 16, 2)
                (root / "expected.json").write_text(json.dumps({"x": x.tolist(), "y": model(x).detach().tolist()}))
                script = "import sys,json,torch; sys.path.insert(0,sys.argv[1]); import inference; from pathlib import Path; d=json.loads((Path(sys.argv[1])/'expected.json').read_text()); b=inference.load_model('cpu'); torch.testing.assert_close(b['models'][4](torch.tensor(d['x'])),torch.tensor(d['y']),atol=1e-5,rtol=1e-4)"
                result = subprocess.run([sys.executable, "-I", "-c", script, directory], capture_output=True, text=True, timeout=60)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_behavior_probe_preserves_model_and_rng(self):
        from recipe_identity import behavior_probe
        model = build_model({"recipe": recipe(), "num_channels": 2}, 16, 4).train()
        state = torch.get_rng_state().clone()
        first = behavior_probe(model)
        self.assertEqual(first, behavior_probe(model))
        self.assertTrue(model.training)
        self.assertTrue(torch.equal(state, torch.get_rng_state()))
        self.assertTrue(all(p.grad is None for p in model.parameters()))
        self.assertTrue(first["diagnostic_only"])

    def test_v3_mutations_and_model_recipe_compiler(self):
        from search.mutate import mutate_recipe
        from model_recipe import compile_model_recipe
        for name in ("diagonal_ssm", "timesblock_encoder", "mamba"):
            for index in (1, 2):
                self.assertEqual(validate_recipe_object(mutate_recipe(recipe(name), index=index)), [])
        high = json.loads((ROOT / "schemas/model_recipe.example.json").read_text())
        high["schema_version"] = "model_recipe.v2"
        low = recipe()
        high["architecture"] = {k: low[k] for k in ("preprocessing", "embedding", "backbone", "fusion", "prediction_head", "representation", "composition")}
        self.assertEqual(compile_model_recipe(high)["recipe_version"], "recipe_schema_v3")


class IdentityTests(unittest.TestCase):
    def test_names_and_seeds(self):
        r = recipe()
        spec = {"input_len": 16, "channels": 2, "horizon": 4}
        experiment = dict(data_digest="data", split_protocol="fold1", backend="torch_reference", precision="float32", runtime_digest="test")
        first = recipe_identity(r, input_spec=spec, experiment=experiment)
        r["recipe_id"] = "different_name"
        r["hypothesis"] = "A different textual description"
        self.assertEqual(first, recipe_identity(r, input_spec=spec, experiment=experiment))
        r["training_strategy"]["budget"]["seed"] += 1
        second = recipe_identity(r, input_spec=spec, experiment=experiment)
        self.assertEqual(first["architecture_id"], second["architecture_id"])
        self.assertNotEqual(first["experiment_id"], second["experiment_id"])

    def test_alias_defaults(self):
        r = json.loads((ROOT / "schemas/recipe_shared_channel.example.json").read_text())
        r["fusion"] = {"type": "temporal", "channel_mode": "shared"}
        spec = {"input_len": 96, "channels": 2, "horizon": 4}
        a = recipe_identity(r, input_spec=spec)
        r["fusion"] = {"type": "feature_mlp"}
        self.assertEqual(a["architecture_id"], recipe_identity(r, input_spec=spec)["architecture_id"])

    def test_claim_recovery_and_corrupt_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ExperimentStore(Path(directory) / "claims.sqlite")
            a = store.claim("test")
            self.assertEqual(store.claim("test")["status"], "running")
            store.finish("test", a["owner"], error="environment unavailable")
            b = store.claim("test")
            self.assertEqual(b["attempt"], 2)
            artifact = Path(directory) / "artifact.json"
            artifact.write_text("{}")
            result = {"files": {str(artifact): file_digest(artifact)}}
            store.finish("test", b["owner"], result=result)
            self.assertEqual(store.claim("test")["status"], "completed")
            artifact.write_text("corrupted")
            self.assertEqual(store.claim("test")["status"], "claimed")
            c = store.claim("expired", lease_seconds=-1)
            d = store.claim("expired")
            with self.assertRaises(RuntimeError):
                store.heartbeat("expired", c["owner"])
            store.heartbeat("expired", d["owner"])

    def test_concurrent_claim_has_single_owner(self):
        from concurrent.futures import ThreadPoolExecutor
        with tempfile.TemporaryDirectory() as directory:
            store = ExperimentStore(Path(directory) / "claims.sqlite")
            with ThreadPoolExecutor(max_workers=4) as pool:
                claims = list(pool.map(lambda _: store.claim("same-experiment"), range(8)))
            self.assertEqual(sum(row["status"] == "claimed" for row in claims), 1)
            self.assertEqual(sum(row["status"] == "running" for row in claims), 7)


if __name__ == "__main__":
    unittest.main()
