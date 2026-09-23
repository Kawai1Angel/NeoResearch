"""Keep orchestration entrypoints free of training-library startup costs."""

from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path


PY_ROOT = Path(__file__).resolve().parents[1]


class LightweightEntrypointTests(unittest.TestCase):
    def test_orchestration_imports_do_not_load_training_libraries(self) -> None:
        script = (
            "import sys; "
            "import renderer, cv_train, runner; "
            "assert 'torch' not in sys.modules; "
            "assert 'pandas' not in sys.modules"
        )
        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=PY_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
