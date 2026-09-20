"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { getBestSessionRow, loadRunnerState } = require("../src/session");

function writeProjectState(projectRoot, state, rows) {
  const stateDir = path.join(projectRoot, ".neo-cast");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "runner_state.json"), `${JSON.stringify(state)}\n`, "utf8");
  fs.writeFileSync(
    path.join(stateDir, "results.tsv"),
    [
      "session_id\trun_id\tcandidate_id\tmodel_family\tcv_avg_mse\tval_avg_mse\tis_best",
      ...rows.map((row) =>
        [
          row.session_id,
          row.run_id,
          row.candidate_id,
          row.model_family,
          row.cv_avg_mse,
          row.val_avg_mse,
          row.is_best,
        ].join("\t"),
      ),
    ].join("\n"),
    "utf8",
  );
}

test("getBestSessionRow returns the latest best row for the active session", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "neo-cast-session-"));
  writeProjectState(
    projectRoot,
    { session_id: "session_a" },
    [
      { session_id: "session_a", run_id: "run_old", candidate_id: "old", model_family: "linear", cv_avg_mse: "0.20", val_avg_mse: "0.01", is_best: "1" },
      { session_id: "session_a", run_id: "run_new", candidate_id: "new", model_family: "mlp", cv_avg_mse: "0.10", val_avg_mse: "0.90", is_best: "1" },
      { session_id: "session_b", run_id: "run_other", candidate_id: "other", model_family: "tcn", cv_avg_mse: "0.05", val_avg_mse: "0.05", is_best: "1" },
    ],
  );

  assert.equal(getBestSessionRow(projectRoot)?.run_id, "run_new");
});

test("getBestSessionRow honors runner state when best_run_id defines the comparable champion", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "neo-cast-session-"));
  writeProjectState(
    projectRoot,
    { session_id: "session_a", best_run_id: "run_full" },
    [
      { session_id: "session_a", run_id: "run_single", candidate_id: "single", model_family: "linear", cv_avg_mse: "0.10", val_avg_mse: "0.10", is_best: "0" },
      { session_id: "session_a", run_id: "run_full", candidate_id: "full", model_family: "tcn", cv_avg_mse: "0.90", val_avg_mse: "0.90", is_best: "0" },
    ],
  );

  assert.equal(getBestSessionRow(projectRoot)?.run_id, "run_full");
});

test("loadRunnerState treats corrupt state JSON as unavailable", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "neo-cast-session-"));
  const stateDir = path.join(projectRoot, ".neo-cast");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "runner_state.json"), "{bad json", "utf8");

  assert.equal(loadRunnerState(projectRoot), null);
});
