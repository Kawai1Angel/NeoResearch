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
    load_contract,
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
            "type": "timesnet_lite",
            "hidden_dim": 8,
            "n_layers": 1,
            "top_k": 2,
            "kernel_size": 3,
            "dropout": 0.0,
        }
        self.recipe["prediction_head"]["type"] = "linear"
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
                if key in {
                    "runtime_semantics_revision", "recipe_version", "preprocessing",
                    "embedding", "backbone", "fusion", "channel_mode", "prediction_head",
                    "target_channels", "past_exogenous_channels", "future_exogenous_channels",
                    "output_channels", "input_length", "head_input_width",
                    "head_channel_shared", "mechanisms",
                }
            },
        }

    def test_load_contract_accepts_legacy_and_experiment_constraints_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "contract.json"
            for extra in ({}, {"experiment_constraints_sha256": digest({"frozen": ["backbone"]})}):
                with self.subTest(extra=extra):
                    contract = {**self.contract, **extra}
                    file.write_text(json.dumps(contract))
                    self.assertEqual(load_contract(file), contract)

    def test_load_contract_rejects_invalid_digest_and_unknown_fields(self):
        from jsonschema import ValidationError

        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "contract.json"
            for extra in (
                {"experiment_constraints_sha256": "not-a-digest"},
                {"experiment_constraints_sha256": "a" * 63},
                {"experiment_constraints_sha256": None},
                {"experiment_constraints_sha256": 123},
                {"unknown_contract_field": "value"},
            ):
                with self.subTest(extra=extra):
                    file.write_text(json.dumps({**self.contract, **extra}))
                    with self.assertRaises(ValidationError):
                        load_contract(file)

    def test_experiment_constraints_digest_is_bound_to_manifest(self):
        self.contract["experiment_constraints_sha256"] = digest({"frozen": ["backbone"]})
        manifests, mismatches = self.verify()
        self.assertEqual(mismatches, [])
        self.contract["experiment_constraints_sha256"] = digest({"frozen": ["embedding"]})
        self.assertTrue(any(item["path"] == "contract_digest"
                            for item in compare(self.contract, manifests[0])))

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

    def test_dlinear_latent_width_and_shared_head_are_reported(self):
        recipe = copy.deepcopy(self.recipe)
        recipe["backbone"] = {"type": "dlinear", "kernel_size": 25}
        model = build_model({**self.config, "recipe": recipe}, 336, 96)
        actual = describe_model(model)
        self.assertEqual(actual["input_length"], 336)
        self.assertEqual(actual["head_input_width"], 64)
        self.assertEqual(actual["forecast_horizon"], 96)
        self.assertTrue(actual["head_channel_shared"])
        self.assertEqual(actual["mechanisms"], ["moving_average_decomposition"])
        self.assertEqual(model.model.seasonal.out_features, 64)

    def test_generic_nbeats_does_not_claim_fixed_bases_or_multirate(self):
        recipe = copy.deepcopy(self.recipe)
        recipe["backbone"] = {"type": "nbeats", "hidden_dim": 16, "n_blocks": 2,
                              "n_layers": 2, "dropout": 0.0, "activation": "gelu"}
        model = build_model({**self.config, "recipe": recipe}, 336, 96)
        self.assertEqual(describe_model(model)["mechanisms"], ["learned_residual_backcast"])
        import torch.nn as nn
        # The recipe still says nbeats; a replaced module must change actual facts.
        model.model = nn.Linear(336, 64)
        self.assertEqual(describe_model(model)["mechanisms"], [])
        self.assertEqual(describe_model(model)["backbone"], "linear")

    def test_replaced_head_width_is_a_contract_violation(self):
        from factory.build_model import LinearHead
        self.contract["expected"]["head_input_width"] = 32
        self.model.prediction_head = LinearHead(16, 8)
        _, mismatches = self.verify()
        self.assertTrue(any(item["path"] == "head_input_width" and item["actual"] == 16
                            for item in mismatches))

    def test_timesnet_verified(self):
        manifests, mismatches = self.verify()
        self.assertEqual(mismatches, [])
        self.assertEqual(manifests[0]["actual"]["backbone"], "timesnet_lite")

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
            canonicalize({"z": 1e-5, "a": [1.0, "café", 1e-7, 1e21]}),
            '{"a":[1,"café",1e-7,1e+21],"z":0.00001}',
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
        self.contract["experiment_constraints_sha256"] = digest({"frozen": ["backbone"]})
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
            self.assertTrue(any(
                mismatch["path"] == "backbone"
                for record in records if record["event"] == "execution_contract_violation"
                for mismatch in record["mismatches"]
            ))
            self.assertFalse(
                any(
                    r["event"] in {"epoch_end", "smoke_eval_done", "eval_done"}
                    for r in records
                )
            )
