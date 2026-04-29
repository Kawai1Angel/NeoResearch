from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = PROJECT_ROOT / "scripts" / "neo_research_tsf_e2e.sh"
EXAMPLE_RECIPE = PROJECT_ROOT / "py" / "schemas" / "recipe.example.json"


class NeoResearchTsfE2EContractTest(unittest.TestCase):
    def run_dry_run(self, stage: str) -> str:
        result = subprocess.run(
            [
                "bash",
                str(SCRIPT_PATH),
                "--dry-run",
                "--project-root",
                str(PROJECT_ROOT),
                "--python",
                sys.executable,
                "--candidate",
                str(EXAMPLE_RECIPE),
                "--stage",
                stage,
                "--skip-ref-test",
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        return result.stdout

    def test_smoke_dry_run_prints_validate_command_and_candidate_write(self) -> None:
        output = self.run_dry_run("smoke")

        self.assertIn("write_candidate=", output)
        self.assertIn(".neo-cast/current_candidate.json", output)
        self.assertIn("py/validate.py smoke", output)
        self.assertIn("--candidate-path .neo-cast/current_candidate.json", output)
        self.assertIn("--resolved-path .neo-cast/resolved_candidate.json", output)
        self.assertIn("--artifacts-dir .neo-cast/artifacts", output)

    def test_full_dry_run_prints_runner_command_without_ref_test_when_skipped(self) -> None:
        output = self.run_dry_run("full")

        self.assertIn("py/runner.py init", output)
        self.assertIn("py/runner.py run --description", output)
        self.assertNotIn("py/runner.py ref-test", output)


if __name__ == "__main__":
    unittest.main()
