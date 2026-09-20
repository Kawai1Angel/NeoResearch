from __future__ import annotations
import copy
import json
import tempfile
import unittest
from pathlib import Path

from execution_contract import (
    canonicalize,
    compare,
    describe_model,
    digest,
    verify_models,
)
from factory.build_model import build_model


class ExecutionContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.recipe = json.loads(
            (
                Path(__file__).parents[1] / "schemas/recipe_native.example.json"
            ).read_text()
        )
        self.recipe["embedding"] = {"type": "none"}
        self.recipe["backbone"] = {
            "type": "timesnet",
            "hidden_dim": 8,
            "n_layers": 1,
            "top_k": 2,
            "kernel_size": 3,
            "dropout": 0.0,
        }
        self.recipe["prediction_head"]["type"] = "direct_multi_horizon"
        self.config = {
            "recipe": self.recipe,
            "num_channels": 7,
            "num_target_channels": 1,
            "num_past_covariate_channels": 6,
            "num_future_covariate_channels": 0,
            "num_output_channels": 1,
        }
        self.model = build_model(self.config, 32, 8)
        self.contract = {
            "schema_version": "research_execution_contract.v1",
            "task_id": "task",
            "candidate_id": "candidate",
            "hypothesis_id": "H1",
            "candidate_spec_sha256": digest(self.recipe),
            "expected": {
                key: value
                for key, value in describe_model(self.model).items()
                if key not in {"model_class", "backbone_module_class", "num_parameters"}
            },
        }

    def verify(self, model=None, recipe=None):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "candidate.json"
            file.write_text(json.dumps(recipe or self.recipe))
            return verify_models(
                self.contract,
                [self.model if model is None else model],
                file,
                {"model_config": self.config},
            )

    def test_timesnet_verified(self):
        manifests, mismatches = self.verify()
        self.assertEqual(mismatches, [])
        self.assertEqual(manifests[0]["actual"]["backbone"], "timesnet")

    def test_recipe_claims_timesnet_but_instantiated_mlp(self):
        import torch.nn as nn

        self.model.model = nn.Sequential(nn.Linear(32, 8), nn.GELU(), nn.Linear(8, 8))
        _, mismatches = self.verify()
        self.assertTrue(
            any(
                item["path"] == "backbone" and item["actual"] == "mlp"
                for item in mismatches
            )
        )

    def test_preprocessing_order(self):
        from factory.build_model import SeriesDecompositionAction

        self.model.preprocessing.append(SeriesDecompositionAction(kernel_size=3))
        self.contract["expected"]["preprocessing"] = [
            "series_decomposition",
            "instance_norm",
        ]
        _, mismatches = self.verify()
        self.assertTrue(any(item["path"] == "preprocessing" for item in mismatches))

    def test_future_channels(self):
        self.model.num_future_covariate_channels = 2
        _, mismatches = self.verify()
        self.assertTrue(
            any(item["path"] == "future_exogenous_channels" for item in mismatches)
        )

    def test_digest_change(self):
        recipe = copy.deepcopy(self.recipe)
        recipe["notes"] = "changed"
        _, mismatches = self.verify(recipe=recipe)
        self.assertTrue(
            any(item["path"] == "candidate_spec_sha256" for item in mismatches)
        )

    def test_missing_manifest_fails_closed(self):
        self.assertTrue(compare(self.contract, {}))

    def test_contract_digest_change(self):
        manifests, _ = self.verify()
        manifests[0]["contract_digest"] = "wrong"
        self.assertTrue(
            any(
                item["path"] == "contract_digest"
                for item in compare(self.contract, manifests[0])
            )
        )

    def test_canonical_numbers_and_unicode(self):
        self.assertEqual(
            canonicalize({"z": 1e-5, "a": [1.0, "中文", 1e-7, 1e21]}),
            '{"a":[1,"中文",1e-7,1e+21],"z":0.00001}',
        )

    def test_smoke_violation_precedes_optimizer_and_first_epoch(self):
        import contextlib
        import io
        import train
        import torch.nn as nn
        from unittest.mock import patch

        candidate = train.build_default_candidate()
        candidate["model_config"] = self.config
        candidate["model_family"] = "recipe_factory"
        candidate["smoke_config"]["horizon"] = 8
        self.model.model = nn.Sequential(nn.Linear(32, 8), nn.GELU(), nn.Linear(8, 8))
        with tempfile.TemporaryDirectory() as directory:
            candidate_file = Path(directory) / "candidate.json"
            contract_file = Path(directory) / "contract.json"
            candidate_file.write_text(json.dumps(self.recipe))
            contract_file.write_text(json.dumps(self.contract))
            output = io.StringIO()
            with patch.object(
                train, "_build_runtime_model", return_value=self.model
            ), patch.object(
                train, "_build_optimizer"
            ) as optimizer, contextlib.redirect_stdout(
                output
            ):
                status = train.train_models(
                    candidate=candidate,
                    smoke=True,
                    artifact_root=Path(directory),
                    execution_contract_path=str(contract_file),
                    candidate_path=str(candidate_file),
                )
            self.assertEqual(status, 5)
            optimizer.assert_not_called()
            records = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertTrue(
                any(r["event"] == "execution_contract_violation" for r in records)
            )
            self.assertFalse(
                any(
                    r["event"] in {"epoch_end", "smoke_eval_done", "eval_done"}
                    for r in records
                )
            )
