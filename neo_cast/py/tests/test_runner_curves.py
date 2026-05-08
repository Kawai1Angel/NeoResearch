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

        self.assertEqual(payload, {"curves_by_horizon": {"96": [0.724, 0.712], "720": [1.518, 1.514]}})

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

        self.assertEqual(payload, {"curves_by_horizon": {"96": [0.724], "720": [1.514]}})

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

        self.assertEqual(exit_code, 2)
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


if __name__ == "__main__":
    unittest.main()
