"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const VENV_PYTHON = path.join(REPO_ROOT, ".neo-cast", "runtime", ".venv", "bin", "python");
const PYTHON = process.env.NEO_CAST_PYTHON || (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3");

test("python unit tests pass", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "neo-cast-py-unit-data-"));
  fs.writeFileSync(
    path.join(dataRoot, "dataset_spec.json"),
    `${JSON.stringify({
      schema_version: "dataset.v1",
      task_id: "etth1",
      timestamp_col: "date",
      feature_columns: ["HUFL", "HULL", "MUFL", "MULL", "LUFL", "LULL", "OT"],
      input_len: 512,
      horizons: [96, 192, 336, 720],
      splits: {
        train: [0, 8640],
        val: [8640, 11520],
        ref_test: [11520, 14400],
      },
      normalization: { type: "standard", fit_split: "train" },
      missing: { strategy: "forward_fill", limit: null },
      time: { frequency: "auto", allow_irregular: true, irregular_ratio_warn: 0.01 },
    }, null, 2)}\n`,
    "utf8"
  );

  const result = spawnSync(
    PYTHON,
    ["-m", "unittest", "discover", "-s", "py/tests"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PYTHONPATH: path.join(REPO_ROOT, "py"),
        NEO_TSF_DATA_ROOT: dataRoot,
      },
      encoding: "utf8",
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
