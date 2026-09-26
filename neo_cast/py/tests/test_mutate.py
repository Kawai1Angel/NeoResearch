from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


PY_ROOT = Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

from registry.action_specs import validate_recipe_against_registry  # noqa: E402
from search.mutate import make_policy_from_state, mutate_recipe  # noqa: E402
from validate import validate_payload  # noqa: E402


def base_recipe(
    *,
    embedding: dict[str, Any] | None = None,
    backbone: dict[str, Any] | None = None,
    channel_mode: str = "independent",
) -> dict[str, Any]:
    return {
        "recipe_version": "recipe_schema_v2",
        "recipe_id": "recipe_base",
        "hypothesis": "Base recipe used for mutation tests.",
        "preprocessing": {"actions": [{"type": "none"}]},
        "embedding": embedding or {"type": "patch", "patch_len": 16, "stride": 8, "d_model": 64},
        "backbone": backbone or {"type": "mlp", "depth": 1, "hidden_dim": 64, "activation": "gelu", "dropout": 0.1},
        "fusion": {"type": "temporal", "channel_mode": channel_mode},
        "prediction_head": {"type": "linear", "output_distribution": "point"},
        "training_strategy": {
            "loss": {"base": "mse", "horizon_weighting": "uniform"},
            "optimizer": {"type": "adam", "lr": 0.001, "weight_decay": 0.0},
            "scheduler": {"type": "none", "warmup_steps": 0},
            "regularization": { "grad_clip": 1.0},
            "budget": {"max_epochs": 2, "time_budget_s": 60, "batch_size": 16, "patience": 2, "seed": 42},
        },
        "constraints": {"max_params": 1000000, "latency_priority": "medium"},
    }


class MutateRecipeTest(unittest.TestCase):
    def assert_valid_recipe(self, recipe: dict[str, Any]) -> None:
        self.assertEqual(validate_recipe_against_registry(recipe, input_len=512), [])

    def architecture_signature(self, recipe: dict[str, Any]) -> dict[str, Any]:
        return {
            key: recipe[key]
            for key in ("preprocessing", "embedding", "backbone", "fusion", "prediction_head")
        }

    def test_patch_recipe_mutates_to_multiscale_and_shared(self) -> None:
        mutated = mutate_recipe(base_recipe(), {"cv_avg_mse": 1.2})

        self.assertEqual(mutated["embedding"]["type"], "multiscale_patch")
        self.assertEqual(mutated["fusion"]["channel_mode"], "shared")
        self.assertIn("patch_to_multiscale", mutated["notes"])
        self.assert_valid_recipe(mutated)

    def test_multiscale_independent_recipe_mutates_to_shared(self) -> None:
        recipe = base_recipe(
            embedding={
                "type": "multiscale_patch",
                "scales": [{"patch_len": 8, "stride": 4}, {"patch_len": 16, "stride": 8}],
                "d_model": 64,
            },
            channel_mode="independent",
        )
        mutated = mutate_recipe(recipe, {"cv_avg_mse": 1.0})

        self.assertEqual(mutated["embedding"]["type"], "multiscale_patch")
        self.assertEqual(mutated["fusion"]["channel_mode"], "shared")
        self.assert_valid_recipe(mutated)

    def test_crashed_transformer_reduces_cost(self) -> None:
        recipe = base_recipe(
            embedding={"type": "patch", "patch_len": 16, "stride": 16, "d_model": 128},
            backbone={"type": "transformer", "d_model": 128, "n_heads": 8, "n_layers": 3, "dropout": 0.1, "ffn_mult": 4.0},
        )
        mutated = mutate_recipe(recipe, {"status": "crash"})

        self.assertLess(mutated["backbone"]["d_model"], 128)
        self.assertLess(mutated["backbone"]["n_layers"], 3)
        self.assertEqual(mutated["embedding"]["d_model"], mutated["backbone"]["d_model"])
        self.assertEqual(mutated["training_strategy"]["optimizer"]["type"], "adamw")
        self.assert_valid_recipe(mutated)

    def test_linear_none_near_poor_threshold_still_explores_backbone(self) -> None:
        recipe = base_recipe(
            embedding={"type": "none"},
            backbone={"type": "linear", "shared": False, "bias": True},
        )
        before_architecture = self.architecture_signature(recipe)

        mutated = mutate_recipe(recipe, {"cv_avg_mse": 1.09177}, index=1)

        self.assertNotEqual(self.architecture_signature(mutated), before_architecture)
        self.assertNotEqual(mutated["backbone"]["type"], "linear")
        self.assertIn(
            mutated["backbone"]["type"],
            {"tcn", "rnn", "gated_depthwise_conv", "mixer", "transformer", "dlinear", "nbeats", "timesnet_lite"},
        )
        self.assert_valid_recipe(mutated)

    def test_raw_backbone_switch_resets_shared_channel_fusion(self) -> None:
        recipe = base_recipe(
            embedding={"type": "none"},
            backbone={"type": "linear", "shared": False, "bias": True},
            channel_mode="shared",
        )

        mutated = mutate_recipe(recipe, {"cv_avg_mse": 1.09177}, index=1)

        self.assertEqual(mutated["embedding"], {"type": "none"})
        self.assertNotEqual(mutated["backbone"]["type"], "linear")
        self.assertEqual(mutated["fusion"], {"type": "temporal", "channel_mode": "independent"})
        self.assert_valid_recipe(mutated)

    def test_policy_from_state_uses_relative_thresholds(self) -> None:
        policy = make_policy_from_state({"best_cv_avg_mse": 1.09177})

        self.assertEqual(policy.baseline_val_mse, 1.09177)
        self.assertAlmostEqual(policy.baseline_val_mse * policy.poor_rel_threshold, 1.1463585)
        self.assertAlmostEqual(policy.baseline_val_mse * policy.good_rel_threshold, 1.0371815)

    def test_state_path_policy_keeps_baseline_relative_pressure(self) -> None:
        recipe = base_recipe(
            embedding={"type": "none"},
            backbone={"type": "linear", "shared": False, "bias": True},
        )
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "runner_state.json"
            state_path.write_text('{"best_cv_avg_mse": 1.09177}\n', encoding="utf-8")

            mutated = mutate_recipe(recipe, {"cv_avg_mse": 1.09177}, index=1, state_path=state_path)

        self.assertNotEqual(mutated["backbone"]["type"], "linear")
        self.assert_valid_recipe(mutated)

    def test_relative_poor_threshold_reduces_transformer_below_legacy_absolute_threshold(self) -> None:
        recipe = base_recipe(
            embedding={
                "type": "multiscale_patch",
                "scales": [{"patch_len": 8, "stride": 4}, {"patch_len": 16, "stride": 8}],
                "d_model": 128,
            },
            backbone={"type": "transformer", "d_model": 128, "n_heads": 8, "n_layers": 3, "dropout": 0.1, "ffn_mult": 4.0},
            channel_mode="shared",
        )
        recipe["preprocessing"] = {"actions": [{"type": "instance_norm", "affine": False, "eps": 1e-5}]}
        policy = make_policy_from_state({"best_cv_avg_mse": 1.0})

        mutated = mutate_recipe(recipe, {"cv_avg_mse": 1.08}, index=2, policy=policy)

        self.assertLess(mutated["backbone"]["d_model"], 128)
        self.assertLess(mutated["backbone"]["n_layers"], 3)
        self.assert_valid_recipe(mutated)

    def test_cli_writes_schema_valid_recipe(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            recipe_path = tmp_path / "recipe.json"
            metrics_path = tmp_path / "metrics.json"
            output_path = tmp_path / "mutated.json"
            recipe_path.write_text(f"{json.dumps(base_recipe())}\n", encoding="utf-8")
            metrics_path.write_text('{"cv_avg_mse": 1.2}\n', encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    str(PY_ROOT / "search" / "mutate.py"),
                    "--recipe",
                    str(recipe_path),
                    "--metrics",
                    str(metrics_path),
                    "--state-path",
                    str(tmp_path / "missing_state.json"),
                    "--output",
                    str(output_path),
                ],
                cwd=str(PY_ROOT.parent),
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            self.assertEqual(validate_payload("recipe", output_path), [])


if __name__ == "__main__":
    unittest.main()
