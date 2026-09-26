from __future__ import annotations

import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

import torch
from torch.utils.data import DataLoader, TensorDataset

import train
from dataset_contract import DatasetSpec, DEFAULT_ETTH1_SPEC
from recipe_identity import recipe_identity
from tests.test_train_execution import phase2_invert_rnn_candidate
from tests.test_recipe_v3 import recipe


class TrainingIdentityV3Tests(unittest.TestCase):
    def test_full_training_reuses_without_new_epoch_and_keeps_horizons_independent(self):
        torch.set_num_threads(1)
        candidate = phase2_invert_rnn_candidate()
        candidate["recipe"] = recipe("mamba")
        candidate["model_config"]["recipe"] = candidate["recipe"]
        candidate["task"]["horizons"] = [4, 6]
        candidate["constraints"]["time_budget_s"] = 120

        def identity(candidate, **kwargs):
            return recipe_identity(candidate["recipe"], input_spec=candidate["task"], experiment={
                "data_digest": "fixture", "split_protocol": "fixture", "backend": "cpu", "precision": "float32", "runtime_digest": "fixture",
                "resolved_training": candidate["train_config"],
            })

        def loader(split, horizon, batch_size, shuffle, **kwargs):
            return DataLoader(TensorDataset(torch.randn(4, 16, 3), torch.randn(4, horizon, 3)), batch_size=2)

        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(train, "ACTIVE_SPEC", DatasetSpec.from_payload(DEFAULT_ETTH1_SPEC)),
            patch.object(train, "INPUT_LEN", 16), patch.object(train, "NUM_CHANNELS", 3),
            patch.object(train, "make_dataloader", loader),
            patch.object(train, "measure_latency_ms", return_value=0.1),
            patch.object(train, "evaluate_val_tsf", return_value={"val_avg_mse": 0.5, "val_h4_mse": 0.4, "val_h6_mse": 0.6}),
            patch.object(train, "build_preprocess_spec", return_value={"feature_names": ["a", "b", "c"], "scaler": {"type": "identity"}}),
            patch("training_identity.training_identity", side_effect=identity),
            patch.object(train, "run_epoch", wraps=train.run_epoch) as epoch,
        ):
            root = Path(directory)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(train.train_models(candidate=candidate, smoke=False, artifact_root=root), 0)
            self.assertEqual(epoch.call_count, 2)
            artifact = next(root.glob("run_*"))
            checkpoint = torch.load(artifact / "model.pt", weights_only=False)
            self.assertEqual(checkpoint["runtime_semantics_revision"], 3)
            self.assertEqual(set(checkpoint["state_dicts"]), {"4", "6"})
            self.assertFalse(torch.equal(checkpoint["state_dicts"]["4"]["model.0.weight"], checkpoint["state_dicts"]["6"]["model.0.weight"]))
            renamed = copy.deepcopy(candidate)
            renamed["candidate_id"] = "renamed_candidate"
            renamed["recipe"]["recipe_id"] = "renamed_recipe"
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(train.train_models(candidate=renamed, smoke=False, artifact_root=root), 0)
            self.assertEqual(epoch.call_count, 2)
            events = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertTrue(any(e["event"] == "experiment_reused" for e in events))
            self.assertTrue(events[-1]["reused"])
            renamed["train_config"]["seed"] += 1
            with redirect_stdout(io.StringIO()):
                self.assertEqual(train.train_models(candidate=renamed, smoke=False, artifact_root=root), 0)
            self.assertEqual(epoch.call_count, 4)


if __name__ == "__main__":
    unittest.main()
