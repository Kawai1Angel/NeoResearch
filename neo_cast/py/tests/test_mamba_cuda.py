"""Backend selection, ABI provenance and numerical parity of Mamba-1 scan."""
from __future__ import annotations

import copy
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import torch

from execution_contract import describe_model
from factory.build_model import build_model
from factory.encoders import Mamba1
from factory.encoders.mamba_scan import extension_status, extension_fingerprint, select_backend
from tests.test_recipe_v3 import recipe
from validate import validate_recipe_object

CUDA_READY = torch.cuda.is_available() and extension_status()[0] is not None


class MambaBackendTests(unittest.TestCase):
    def setUp(self):
        torch.manual_seed(42)
        torch.set_num_threads(1)

    def test_required_cuda_is_present(self):
        if os.environ.get("NEO_CAST_REQUIRE_MAMBA_CUDA") == "1":
            self.assertTrue(CUDA_READY, extension_status()[1])

    def test_auto_cpu_and_explicit_reference_preserve_outputs_weights_and_state(self):
        reference = Mamba1(8, 4, 3, backend="torch_reference")
        automatic = Mamba1(8, 4, 3, backend="auto")
        automatic.load_state_dict(reference.state_dict(), strict=True)
        self.assertEqual(list(reference.state_dict()), list(automatic.state_dict()))
        x = torch.randn(2, 17, 8)
        torch.testing.assert_close(automatic(x), reference(x), atol=0, rtol=0)
        a, state = automatic.forward_state(x[:, :7])
        b, _ = automatic.forward_state(x[:, 7:], state)
        torch.testing.assert_close(torch.cat((a, b), 1), automatic(x), atol=1e-6, rtol=1e-5)
        self.assertEqual(select_backend("auto", torch.device("cpu"), 4), ("torch_reference", "cpu_device"))

    def test_strict_backend_errors_and_auto_fallback_are_explicit(self):
        with self.assertRaisesRegex(RuntimeError, "MAMBA_CUDA_UNAVAILABLE.*cpu_device"):
            Mamba1(8, backend="cuda_optimized")(torch.randn(1, 4, 8))
        with self.assertRaisesRegex(ValueError, "d_state<=256"):
            Mamba1(8, d_state=512, backend="cuda_optimized")
        with patch("factory.encoders.mamba_scan.extension_status", return_value=(None, "fixture_missing_extension")):
            self.assertEqual(select_backend("auto", torch.device("cuda"), 16), ("torch_reference", "fixture_missing_extension"))
            with self.assertRaisesRegex(RuntimeError, "fixture_missing_extension"):
                select_backend("cuda_optimized", torch.device("cuda"), 16)
            self.assertEqual(select_backend("torch_reference", torch.device("cuda"), 16)[0], "torch_reference")
        self.assertEqual(select_backend("auto", torch.device("cuda"), 512)[0], "torch_reference")

    def test_schema_and_manifest_describe_requested_and_actual_execution(self):
        r = recipe("mamba")
        r["backbone"]["backend"] = "auto"
        self.assertEqual(validate_recipe_object(r, input_len=24), [])
        model = build_model({"recipe": r, "num_channels": 3, "num_target_channels": 1,
                             "num_output_channels": 1}, 24, 4)
        manifest = describe_model(model)
        self.assertEqual(manifest["requested_backend"], "auto")
        self.assertEqual(manifest["backend"], "torch_reference")
        self.assertEqual(manifest["backend_fallback_reason"], "cpu_device")
        r["backbone"]["d_state"] = 512
        r.pop("constraints", None)
        self.assertEqual(validate_recipe_object(r, input_len=24), [])
        r["backbone"]["backend"] = "cuda_optimized"
        self.assertTrue(any("256" in error for error in validate_recipe_object(r, input_len=24)))

    def test_execution_contract_checks_requested_backend(self):
        from execution_contract import compare, digest, load_contract
        r = recipe("mamba")
        r["backbone"]["backend"] = "auto"
        model = build_model({"recipe": r, "num_channels": 3, "num_target_channels": 1,
                             "num_output_channels": 1}, 24, 4)
        actual = describe_model(model)
        schema = json.loads((Path(__file__).resolve().parents[1] / "schemas/execution_contract_schema.json").read_text())
        contract = {"schema_version": "research_execution_contract.v1", "task_id": "task", "hypothesis_id": None,
                    "candidate_id": "candidate", "candidate_spec_sha256": "a" * 64,
                    "expected": {key: actual[key] for key in schema["properties"]["expected"]["required"]}}
        contract["expected"]["requested_backend"] = "auto"
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / "contract.json"
            p.write_text(json.dumps(contract))
            self.assertEqual(load_contract(p), contract)
        manifest = {"actual": actual, "candidate_id": "candidate", "candidate_spec_sha256": "a" * 64,
                    "contract_digest": digest(contract)}
        self.assertEqual(compare(contract, manifest), [])
        actual["requested_backend"] = "torch_reference"
        self.assertEqual(compare(contract, manifest)[0]["path"], "requested_backend")

    def test_cached_cpu_verification_keeps_original_training_backend(self):
        from training_identity import verify_cached_contract
        contract = {"candidate_id": "candidate", "candidate_spec_sha256": "a" * 64}
        checkpoint = {"state_dicts": {"4": {}}, "candidate": {"model_config": {}},
                      "model_manifests": {"4": {"backend": "cuda_optimized", "backend_provenance": {"binarySHA256": "source"}}}}
        manifests = [{"actual": {"backbone": "mamba", "backend": "torch_reference"}}]
        with tempfile.TemporaryDirectory() as directory:
            proof = Path(directory) / "verification.json"
            proof.write_text(json.dumps({"contract_digest": "fixture", "status": "verified"}))
            with (patch("execution_contract.load_contract", return_value=contract),
                  patch("execution_contract.digest", return_value="fixture"),
                  patch("torch.load", return_value=checkpoint), patch.object(importlib.import_module("factory.build_model"), "build_model"),
                  patch("execution_contract.verify_models", return_value=(manifests, []))):
                result = verify_cached_contract({"task": {"input_len": 24}},
                    {"execution_contract_path": "fixture", "verification_path": str(proof)}, {"artifact_dir": directory})
        actual = result[0]["actual"]
        self.assertEqual(actual["backend"], "torch_reference")
        self.assertEqual(actual["cache_verification_device"], "cpu")
        self.assertEqual(actual["source_training_backend"], "cuda_optimized")
        self.assertEqual(actual["source_training_backend_provenance"]["binarySHA256"], "source")

    def test_experiment_identity_tracks_selected_backend_and_binary(self):
        import prepare_tsf as data
        from training_identity import training_identity
        r = recipe("mamba")
        r["backbone"]["backend"] = "auto"
        candidate = {"model_config": {"recipe": r}, "task": {"input_len": 24, "horizons": [4]},
                     "train_config": {}, "constraints": {}}
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / "data.csv"
            p.write_text("x\n1\n")
            with (patch.object(data, "TRAIN_DATA_PATH", p), patch.object(data, "VISIBLE_DATA_PATH", p),
                  patch.object(data, "build_preprocess_spec", return_value={}),
                  patch("torch.cuda.is_available", return_value=True),
                  patch("torch.cuda.get_device_name", return_value="fixture GPU"),
                  patch("factory.encoders.mamba_scan.select_backend", return_value=("cuda_optimized", None)),
                  patch("factory.encoders.mamba_scan.extension_fingerprint", side_effect=[{"binarySHA256": "one"}, {"binarySHA256": "two"}])):
                a, b = training_identity(candidate), training_identity(candidate)
            self.assertEqual(a["architecture_id"], b["architecture_id"])
            self.assertNotEqual(a["experiment_id"], b["experiment_id"])

    @unittest.skipUnless(CUDA_READY, "Official CUDA scan is not installed")
    def test_official_cuda_matches_reference_outputs_and_every_gradient(self):
        for batch, length, width, states, conv in ((2, 1, 8, 4, 1), (2, 17, 8, 8, 3),
                                                   (4, 168, 64, 16, 4), (2, 257, 16, 32, 8),
                                                   (1, 33, 8, 256, 2)):
            with self.subTest(batch=batch, length=length, states=states, conv=conv):
                model = Mamba1(width, states, conv, backend="cuda_optimized").cuda()
                x = torch.randn(batch, length, width, device="cuda", requires_grad=True)
                actual, expected = model(x), model.forward_state(x)[0]
                torch.testing.assert_close(actual, expected, atol=2e-5, rtol=2e-4)
                probe = torch.randn_like(actual) / actual.numel() ** .5
                params = (x, *model.parameters())
                left = torch.autograd.grad((actual * probe).sum(), params)
                right = torch.autograd.grad((expected * probe).sum(), params)
                for a, b in zip(left, right):
                    self.assertTrue(torch.isfinite(a).all())
                    torch.testing.assert_close(a, b, atol=3e-5, rtol=3e-4)

    @unittest.skipUnless(CUDA_READY, "Official CUDA scan is not installed")
    def test_cuda_causality_and_sample_independence(self):
        model = Mamba1(16, 8, 4, backend="auto").cuda()
        x = torch.randn(3, 65, 16, device="cuda")
        with torch.no_grad():
            original = model(x)
            changed = x.clone()
            changed[:, 32:] += 10
            torch.testing.assert_close(model(changed)[:, :32], original[:, :32], atol=2e-5, rtol=2e-4)
            x[1:] += 100
            torch.testing.assert_close(model(x)[0], original[0], atol=2e-5, rtol=2e-4)
        self.assertTrue(extension_fingerprint()["available"])

    @unittest.skipUnless(CUDA_READY, "Official CUDA scan is not installed")
    def test_runtime_tf32_policy_matches_reference_at_large_state_dimension(self):
        previous = torch.get_float32_matmul_precision()
        try:
            torch.set_float32_matmul_precision("high")  # train.py's policy
            model = Mamba1(8, 256, 2, backend="auto").cuda()
            x = torch.randn(1, 33, 8, device="cuda", requires_grad=True)
            actual, expected = model(x), model.forward_state(x)[0]
            torch.testing.assert_close(actual, expected, atol=2e-5, rtol=2e-4)
            params = (x, *model.parameters())
            for left, right in zip(torch.autograd.grad(actual.square().mean(), params),
                                   torch.autograd.grad(expected.square().mean(), params)):
                torch.testing.assert_close(left, right, atol=3e-5, rtol=3e-4)
        finally:
            torch.set_float32_matmul_precision(previous)

    @unittest.skipUnless(CUDA_READY, "Official CUDA scan is not installed")
    def test_complete_raw_and_patch_models_train_and_reload_on_cpu(self):
        for patched in (False, True):
            with self.subTest(patched=patched):
                r = recipe("mamba")
                r["backbone"]["backend"] = "auto"
                if patched:
                    r["embedding"] = {"type": "patch", "patch_len": 4, "stride": 2, "d_model": r["backbone"]["d_model"]}
                    r["representation"].update(layout="channel_sequence", readout="flatten")
                cfg = {"recipe": r, "num_channels": 3, "num_target_channels": 1, "num_output_channels": 1}
                actual = build_model(cfg, 24, 4).cuda()
                reference = copy.deepcopy(actual)
                for m in reference.modules():
                    if isinstance(m, Mamba1):
                        m.backend = "torch_reference"
                optimizers = [torch.optim.Adam(m.parameters(), lr=3e-4) for m in (actual, reference)]
                for step in range(3):
                    x = torch.randn(4, 24, 3, device="cuda")
                    y = torch.randn(4, 4, 1, device="cuda")
                    losses = []
                    for model, optimizer in zip((actual, reference), optimizers):
                        torch.manual_seed(700 + step)
                        optimizer.zero_grad()
                        loss = (model(x) - y).square().mean()
                        loss.backward()
                        optimizer.step()
                        losses.append(loss.detach())
                    torch.testing.assert_close(*losses, atol=2e-5, rtol=2e-4)
                manifest = describe_model(actual)
                self.assertEqual(manifest["backend"], "cuda_optimized")
                self.assertTrue(manifest["backend_provenance"]["binarySHA256"])
                cpu = build_model(cfg, 24, 4).eval()
                cpu.load_state_dict(actual.cpu().state_dict(), strict=True)
                self.assertEqual(cpu(torch.randn(2, 24, 3)).shape, (2, 4, 1))
                self.assertEqual(describe_model(cpu)["backend"], "torch_reference")

    @unittest.skipUnless(CUDA_READY, "Official CUDA scan is not installed")
    def test_cuda_auto_checkpoint_exports_to_cpu_without_cuda_extension_imports(self):
        import export
        r = recipe("mamba")
        r["backbone"]["backend"] = "auto"
        config = {"recipe": r, "num_channels": 2}
        model = build_model(config, 16, 4).cuda().eval()
        manifest = describe_model(model)
        self.assertEqual(manifest["backend"], "cuda_optimized")
        candidate = {"model_config": config, "model_family": "recipe_factory", "candidate_id": "mamba_auto",
                     "recipe": r, "task": {"input_len": 16, "horizons": [4]}}
        metadata = export.build_metadata(run_id="mamba_auto_cuda", model_family="recipe_factory",
            model_impl_entry="model_impl.py:build_model", state_dict_layout="per_horizon",
            val_metrics={"val_avg_mse": 1.0}, horizons=[4],
            training_summary={"runtime_semantics_revision": 3, "model_manifests": {"4": manifest}})
        metadata.update(input_len=16, num_channels=2, dataset_schema_version="dataset.v1")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(export, "build_preprocess_spec", return_value={}):
                export.write_export_files(root, metadata, candidate=candidate)
            torch.save({"runtime_semantics_revision": 3, "candidate": candidate,
                        "state_dicts": {"4": model.cpu().state_dict()}, "model_manifests": {"4": manifest}}, root / "model.pt")
            x = torch.randn(1, 16, 2)
            (root / "expected.json").write_text(json.dumps({"x": x.tolist(), "y": model(x).detach().tolist()}))
            script = ("import sys,json,torch;sys.modules['_neo_cast_mamba_scan_build']=None;"
                      "sys.modules['_neo_cast_selective_scan_cuda']=None;sys.path.insert(0,sys.argv[1]);"
                      "import inference;from pathlib import Path;d=json.loads((Path(sys.argv[1])/'expected.json').read_text());"
                      "b=inference.load_model('cpu');torch.testing.assert_close(b['models'][4](torch.tensor(d['x'])),"
                      "torch.tensor(d['y']),atol=1e-5,rtol=1e-4)")
            result = subprocess.run([sys.executable, "-I", "-c", script, directory], capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
