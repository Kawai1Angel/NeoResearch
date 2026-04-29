"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const VENV_PYTHON = path.join(REPO_ROOT, ".neo-cast", "runtime", ".venv", "bin", "python");
const PYTHON = process.env.NEO_CAST_PYTHON || (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3");

test("python unit tests pass", () => {
  const result = spawnSync(
    PYTHON,
    ["-m", "unittest", "discover", "-s", "py/tests"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PYTHONPATH: path.join(REPO_ROOT, "py"),
      },
      encoding: "utf8",
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
