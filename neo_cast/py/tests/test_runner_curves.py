from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

PY_ROOT = Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

import runner


class RunnerTrainingCurvesTest(unittest.TestCase):
    def test_cv_decision_ignores_better_standard_validation_metric(self) -> None:
        state = runner.RunnerState(
            session_id="session_test", best_run_id="old", best_val_avg_mse=0.9,
            best_cv_avg_mse=0.4, best_cv_protocol_id="cv_v1", keep_count=1,
            crash_streak=0, candidate_counter=1, initialized_at="2026-04-29T00:00:00Z",
            session_started_at="2026-04-29T00:00:00Z",
        )
        improved, comparable = runner._cv_improved(state, 0.5, "cv_v1")
        self.assertTrue(comparable)
        self.assertFalse(improved)  # A candidate val_avg_mse of 0.1 must not affect this decision.

    def test_load_state_backfills_autonomous_fields_for_legacy_state(self) -> None:
        legacy = {
            "session_id": "session_legacy",
            "best_run_id": "run_best",
            "best_val_avg_mse": 1.0,
            "keep_count": 1,
            "crash_streak": 0,
            "candidate_counter": 2,
            "initialized_at": "2026-04-29T00:00:00Z",
        }

        state = runner.RunnerState.from_dict(legacy)

        self.assertEqual(state.session_started_at, legacy["initialized_at"])
        self.assertEqual(state.no_improve_streak, 0)
        self.assertIsNone(state.last_improve_at)

    def test_write_training_curves_groups_epoch_losses_by_horizon(self) -> None:
        records = [
            {"event": "epoch_end", "horizon": 96, "epoch": 1, "val_loss": 0.724},
            {"event": "epoch_end", "horizon": 720, "epoch": 1, "val_loss": 1.518},
            {"event": "epoch_end", "horizon": 96, "epoch": 2, "val_loss": 0.712},
            {"event": "horizon_done", "horizon": 96, "best_val_loss": 0.712},
            {"event": "epoch_end", "horizon": 720, "epoch": 2, "val_loss": 1.514},
        ]

        with tempfile.TemporaryDirectory() as tmp:
            artifact_dir = Path(tmp)
            runner._write_training_curves(records, artifact_dir)

            payload = json.loads((artifact_dir / "training_curves.json").read_text(encoding="utf-8"))

        self.assertEqual(payload["curves_by_horizon"], {"96": [0.724, 0.712], "720": [1.518, 1.514]})

    def test_write_training_curves_skips_invalid_epoch_losses(self) -> None:
        records = [
            {"event": "epoch_end", "horizon": 96, "epoch": 1, "val_loss": 0.724},
            {"event": "epoch_end", "horizon": 96, "epoch": 2, "val_loss": "not-a-float"},
            {"event": "epoch_end", "horizon": 720, "epoch": 1, "val_loss": None},
            {"event": "epoch_end", "horizon": 720, "epoch": 2, "val_loss": 1.514},
        ]

        with tempfile.TemporaryDirectory() as tmp:
            artifact_dir = Path(tmp)
            runner._write_training_curves(records, artifact_dir)

            payload = json.loads((artifact_dir / "training_curves.json").read_text(encoding="utf-8"))

        self.assertEqual(payload["curves_by_horizon"], {"96": [0.724], "720": [1.514]})

    def test_interleaved_cv_folds_are_separate_from_standard_fit(self) -> None:
        records = [
            {"event": "epoch_end", "horizon": 96, "epoch": 2, "cv_fold_index": 0, "val_loss": 1.0},
            {"event": "epoch_end", "horizon": 96, "epoch": 1, "cv_fold_index": 1, "val_loss": 0.3},
            {"event": "epoch_end", "horizon": 96, "epoch": 1, "cv_fold_index": 0, "val_loss": 1.2},
            {"event": "epoch_end", "horizon": 720, "epoch": 1, "cv_fold_index": 0, "val_loss": 1.8},
            {"event": "epoch_end", "horizon": 96, "epoch": 1, "val_loss": 0.4},
            {"event": "epoch_end", "horizon": 96, "epoch": 2, "val_loss": float("nan")},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            runner._write_training_curves(records, Path(tmp))
            payload = json.loads((Path(tmp) / "training_curves.json").read_text())
        self.assertEqual(payload["schema_version"], "training_curves.v2")
        self.assertEqual(payload["curves_by_horizon"], {"96": [0.4]})
        self.assertEqual(payload["curves_by_fold"]["fold_0"]["96"], [
            {"epoch": 1, "val_loss": 1.2}, {"epoch": 2, "val_loss": 1.0},
        ])
        self.assertEqual(payload["curves_by_fold"]["fold_1"]["96"][0]["val_loss"], 0.3)
        self.assertEqual(payload["curves_by_fold"]["fold_0"]["720"][0]["val_loss"], 1.8)

    def test_smoke_validation_failure_records_current_candidate_context_without_resolved_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / ".neo-cast"
            artifacts_dir = state_dir / "artifacts"
            state_dir.mkdir(parents=True)
            current_path = state_dir / "current_candidate.json"
            resolved_path = state_dir / "resolved_candidate.json"
            state_path = state_dir / "runner_state.json"
            results_path = state_dir / "results.tsv"
            current_path.write_text("{}\n", encoding="utf-8")
            resolved_path.write_text(
                '{"candidate_id":"stale_candidate","model_family":"stale_family"}\n',
                encoding="utf-8",
            )
            state = runner.RunnerState(
                session_id="session_test",
                best_run_id=None,
                best_val_avg_mse=None,
                keep_count=0,
                crash_streak=0,
                candidate_counter=0,
                initialized_at="2026-04-29T00:00:00Z",
                session_started_at="2026-04-29T00:00:00Z",
            )

            with (
                patch.object(runner, "STATE_DIR", state_dir),
                patch.object(runner, "ARTIFACTS_DIR", artifacts_dir),
                patch.object(runner, "CURRENT_CANDIDATE_PATH", current_path),
                patch.object(runner, "RESOLVED_CANDIDATE_PATH", resolved_path),
                patch.object(runner, "STATE_PATH", state_path),
                patch.object(runner, "RESULTS_PATH", results_path),
                patch.object(runner, "_run_and_capture", return_value=(2, [])),
            ):
                runner.ensure_results_file(force=True)
                exit_code = runner.run_experiment(state, description="bad candidate", skip_smoke=False)
                rows = runner.load_results()

        self.assertEqual(exit_code, 1)
        self.assertEqual(rows[-1]["status"], "invalid")
        self.assertEqual(rows[-1]["candidate_id"], "smoke_1")
        self.assertEqual(rows[-1]["model_family"], "unknown")

    def test_run_experiment_blocks_when_model_design_checkpoint_is_pending(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / ".neo-cast"
            artifacts_dir = state_dir / "artifacts"
            state_dir.mkdir(parents=True)
            current_path = state_dir / "current_candidate.json"
            state_path = state_dir / "runner_state.json"
            results_path = state_dir / "results.tsv"
            approval_path = state_dir / "approval_state.json"
            current_path.write_text('{"recipe_id":"recipe_gate_001"}\n', encoding="utf-8")
            approval_path.write_text(
                json.dumps(
                    {
                        "schema_version": "approval_state.v1",
                        "current_stage": "model_design_pending_approval",
                        "checkpoints": {
                            "model_design": {
                                "stage": "model_design",
                                "status": "pending",
                                "subject_hash": runner._file_sha256(current_path),
                            }
                        },
                        "history": [],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            state = runner.RunnerState(
                session_id="session_test",
                best_run_id=None,
                best_val_avg_mse=None,
                keep_count=0,
                crash_streak=0,
                candidate_counter=0,
                initialized_at="2026-04-29T00:00:00Z",
                session_started_at="2026-04-29T00:00:00Z",
            )

            with (
                patch.object(runner, "STATE_DIR", state_dir),
                patch.object(runner, "ARTIFACTS_DIR", artifacts_dir),
                patch.object(runner, "CURRENT_CANDIDATE_PATH", current_path),
                patch.object(runner, "STATE_PATH", state_path),
                patch.object(runner, "RESULTS_PATH", results_path),
                patch.object(runner, "APPROVAL_STATE_PATH", approval_path),
                patch.object(runner, "_resolve_candidate") as resolve_candidate,
            ):
                runner.ensure_results_file(force=True)
                exit_code = runner.run_experiment(state, description="gated candidate", skip_smoke=True)

        self.assertEqual(exit_code, 5)
        resolve_candidate.assert_not_called()

    def test_skip_smoke_reuses_fresh_resolved_candidate_without_rendering_again(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / ".neo-cast"
            artifacts_dir = state_dir / "artifacts"
            artifact_dir = artifacts_dir / "run_cached"
            state_dir.mkdir(parents=True)
            artifact_dir.mkdir(parents=True)
            current_path = state_dir / "current_candidate.json"
            resolved_path = state_dir / "resolved_candidate.json"
            state_path = state_dir / "runner_state.json"
            results_path = state_dir / "results.tsv"
            current_path.write_text('{"recipe_id":"recipe_cached"}\n', encoding="utf-8")
            resolved_path.write_text(
                '{"candidate_id":"recipe_cached","model_family":"recipe:mlp"}\n',
                encoding="utf-8",
            )
            (artifact_dir / "training_summary.json").write_text('{"num_params_M":0.25}\n', encoding="utf-8")
            (artifact_dir / "cv_metrics.json").write_text(
                '{"cv_avg_mse":0.2,"cv_std_mse":0.01,"protocol":{"protocol_id":"cv_v1"}}\n', encoding="utf-8"
            )
            # Make the resolved file newer than the candidate that smoke already rendered.
            current_mtime = 1_700_000_000
            resolved_mtime = current_mtime + 10
            current_path.touch()
            resolved_path.touch()
            current_path.chmod(0o644)
            resolved_path.chmod(0o644)
            import os

            os.utime(current_path, (current_mtime, current_mtime))
            os.utime(resolved_path, (resolved_mtime, resolved_mtime))
            state = runner.RunnerState(
                session_id="session_test",
                best_run_id=None,
                best_val_avg_mse=None,
                keep_count=0,
                crash_streak=0,
                candidate_counter=0,
                initialized_at="2026-04-29T00:00:00Z",
                session_started_at="2026-04-29T00:00:00Z",
            )
            train_records = [
                {"event": "cv_eval_done", "cv_avg_mse": 0.2, "cv_std_mse": 0.01,
                 "val_avg_mse": 0.111, "val_avg_mae": 0.222},
                {"event": "eval_done", "val_avg_mse": 0.111, "val_avg_mae": 0.222},
                {
                    "event": "artifact_ready",
                    "run_id": "cached",
                    "artifact_dir": str(artifact_dir),
                },
                {"event": "done", "status": "success"},
            ]

            with (
                patch.object(runner, "STATE_DIR", state_dir),
                patch.object(runner, "ARTIFACTS_DIR", artifacts_dir),
                patch.object(runner, "CURRENT_CANDIDATE_PATH", current_path),
                patch.object(runner, "RESOLVED_CANDIDATE_PATH", resolved_path),
                patch.object(runner, "STATE_PATH", state_path),
                patch.object(runner, "RESULTS_PATH", results_path),
                patch.object(runner, "_resolve_candidate") as resolve_candidate,
                patch.object(runner, "_run_and_capture", return_value=(0, train_records)),
                patch.object(runner, "_export_artifact", return_value=0),
            ):
                runner.ensure_results_file(force=True)
                exit_code = runner.run_experiment(state, description="cached candidate", skip_smoke=True)

        self.assertEqual(exit_code, 0)
        resolve_candidate.assert_not_called()

    def test_full_train_candidate_failure_returns_continue_safe_exit_code(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / ".neo-cast"
            artifacts_dir = state_dir / "artifacts"
            state_dir.mkdir(parents=True)
            current_path = state_dir / "current_candidate.json"
            resolved_path = state_dir / "resolved_candidate.json"
            state_path = state_dir / "runner_state.json"
            results_path = state_dir / "results.tsv"
            current_path.write_text('{"recipe_id":"recipe_too_large"}\n', encoding="utf-8")
            resolved_path.write_text(
                '{"candidate_id":"recipe_too_large","model_family":"recipe_factory"}\n',
                encoding="utf-8",
            )
            state = runner.RunnerState(
                session_id="session_test",
                best_run_id="run_best",
                best_val_avg_mse=0.5,
                keep_count=1,
                crash_streak=0,
                candidate_counter=0,
                initialized_at="2026-04-29T00:00:00Z",
                session_started_at="2026-04-29T00:00:00Z",
            )
            train_records = [
                {
                    "event": "error",
                    "kind": "param_budget_exceeded",
                    "candidate_id": "recipe_too_large",
                    "num_params_m": 2.3,
                    "allowed_m": 1.0,
                },
                {"event": "done", "status": "full_fail"},
            ]

            with (
                patch.object(runner, "STATE_DIR", state_dir),
                patch.object(runner, "ARTIFACTS_DIR", artifacts_dir),
                patch.object(runner, "CURRENT_CANDIDATE_PATH", current_path),
                patch.object(runner, "RESOLVED_CANDIDATE_PATH", resolved_path),
                patch.object(runner, "STATE_PATH", state_path),
                patch.object(runner, "RESULTS_PATH", results_path),
                patch.object(runner, "_run_and_capture", return_value=(3, train_records)),
            ):
                runner.ensure_results_file(force=True)
                exit_code = runner.run_experiment(state, description="oversized candidate", skip_smoke=True)
                rows = runner.load_results()
                saved_state = runner.load_state()

        self.assertEqual(exit_code, 1)
        self.assertEqual(rows[-1]["status"], "crash")
        self.assertEqual(saved_state.crash_streak, 1)

    def test_incomparable_best_horizons_start_new_champion_comparison_set(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / ".neo-cast"
            artifacts_dir = state_dir / "artifacts"
            old_artifact_dir = artifacts_dir / "run_old_single"
            new_artifact_dir = artifacts_dir / "run_new_full"
            old_artifact_dir.mkdir(parents=True)
            new_artifact_dir.mkdir(parents=True)
            (old_artifact_dir / "val_metrics.json").write_text(
                '{"val_avg_mse":0.1,"val_h96_mse":0.1}\n',
                encoding="utf-8",
            )
            (new_artifact_dir / "training_summary.json").write_text('{"num_params_M":0.25}\n', encoding="utf-8")
            (new_artifact_dir / "cv_metrics.json").write_text(
                '{"cv_avg_mse":0.9,"cv_std_mse":0.1,"protocol":{"protocol_id":"full_horizons_cv"}}\n', encoding="utf-8"
            )
            state_dir.mkdir(parents=True, exist_ok=True)
            current_path = state_dir / "current_candidate.json"
            resolved_path = state_dir / "resolved_candidate.json"
            state_path = state_dir / "runner_state.json"
            results_path = state_dir / "results.tsv"
            current_path.write_text('{"recipe_id":"recipe_full_horizons"}\n', encoding="utf-8")
            resolved_path.write_text(
                '{"candidate_id":"recipe_full_horizons","model_family":"recipe_factory"}\n',
                encoding="utf-8",
            )
            state = runner.RunnerState(
                session_id="session_test",
                best_run_id="old_single",
                best_val_avg_mse=0.1,
                keep_count=1,
                crash_streak=0,
                candidate_counter=0,
                initialized_at="2026-04-29T00:00:00Z",
                session_started_at="2026-04-29T00:00:00Z",
            )
            train_records = [
                {"event": "cv_eval_done", "cv_avg_mse": 0.9, "cv_std_mse": 0.1,
                 "val_avg_mse": 0.9, "val_h96_mse": 0.5, "val_h192_mse": 0.8,
                 "val_h336_mse": 1.0, "val_h720_mse": 1.3},
                {
                    "event": "eval_done",
                    "val_avg_mse": 0.9,
                    "val_h96_mse": 0.5,
                    "val_h192_mse": 0.8,
                    "val_h336_mse": 1.0,
                    "val_h720_mse": 1.3,
                },
                {
                    "event": "artifact_ready",
                    "run_id": "new_full",
                    "artifact_dir": str(new_artifact_dir),
                },
                {"event": "done", "status": "success"},
            ]

            with (
                patch.object(runner, "STATE_DIR", state_dir),
                patch.object(runner, "ARTIFACTS_DIR", artifacts_dir),
                patch.object(runner, "CURRENT_CANDIDATE_PATH", current_path),
                patch.object(runner, "RESOLVED_CANDIDATE_PATH", resolved_path),
                patch.object(runner, "STATE_PATH", state_path),
                patch.object(runner, "RESULTS_PATH", results_path),
                patch.object(runner, "_run_and_capture", return_value=(0, train_records)),
                patch.object(runner, "_export_artifact", return_value=0),
            ):
                runner.ensure_results_file(force=True)
                exit_code = runner.run_experiment(state, description="full horizon candidate", skip_smoke=True)
                rows = runner.load_results()
                saved_state = runner.load_state()

        self.assertEqual(exit_code, 0)
        self.assertEqual(rows[-1]["status"], "keep")
        self.assertEqual(saved_state.best_run_id, "new_full")
        self.assertEqual(saved_state.best_cv_avg_mse, 0.9)


if __name__ == "__main__":
    unittest.main()
