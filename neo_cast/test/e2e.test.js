"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const BIN = path.join(REPO_ROOT, "bin", "neo-cast.js");
const DATASET = path.join(REPO_ROOT, "datasets (1)", "ETTh1.csv");

function runNode(args, options = {}) {
  const result = spawnSync("node", [BIN, ...args], {
    cwd: options.cwd || REPO_ROOT,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
  });
  return result;
}

test("prepare-data materializes visible and ref-test splits", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "neo-cast-data-"));
  const result = runNode(
    ["prepare-data", "--source", DATASET, "--force"],
    { env: { NEO_TSF_DATA_ROOT: dataRoot } }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(fs.existsSync(path.join(dataRoot, "ETTh1_visible.csv")));
  assert.ok(fs.existsSync(path.join(dataRoot, "ETTh1_ref_test.csv")));
});

test("init-runtime supports skip-install for fast project bootstrap", () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "neo-cast-runtime-"));
  const result = runNode(
    ["init-runtime", "--skip-install"],
    { cwd: projectDir }
  );
  const second = runNode(
    ["init-runtime", "--skip-install"],
    { cwd: projectDir }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.ok(fs.existsSync(path.join(projectDir, ".neo-cast", "runtime", ".venv", "bin", "python")));
});

test("design mock mode runs one candidate and updates results", () => {
  const before = fs.existsSync(path.join(REPO_ROOT, ".neo-cast", "results.tsv"))
    ? fs.readFileSync(path.join(REPO_ROOT, ".neo-cast", "results.tsv"), "utf8")
    : "";

  const result = runNode(
    [
      "design",
      "--requirement",
      "use nlinear baseline",
      "--mode",
      "companion",
      "--max-candidates",
      "1",
      "--mock-llm",
      "--skip-smoke",
    ],
    {
      cwd: REPO_ROOT,
      env: { NEO_CAST_FAST_E2E: "1" },
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const after = fs.readFileSync(path.join(REPO_ROOT, ".neo-cast", "results.tsv"), "utf8");
  assert.notEqual(after, before);
  assert.match(result.stdout, /design_best_run_id=/);
  const runId = /runner_run_id=([^\s]+)/.exec(result.stdout)?.[1];
  assert.ok(runId, "design output should expose current runner run id");
  const artifactDir = path.join(REPO_ROOT, ".neo-cast", "artifacts", `run_${runId}`);
  const tracePath = path.join(artifactDir, "research_trace.json");
  assert.ok(fs.existsSync(tracePath), "artifact should include research_trace.json");
  const trace = JSON.parse(fs.readFileSync(tracePath, "utf8"));
  assert.equal(trace.schema_version, "research_trace.v1");
  assert.ok(trace.entries.some((entry) => entry.made_by === "ModelDesigner Agent"));
  const validateTrace = runNode(["validate", "research-trace", tracePath], { cwd: REPO_ROOT });
  assert.equal(validateTrace.status, 0, validateTrace.stderr || validateTrace.stdout);
  const globalTracePath = path.join(REPO_ROOT, ".neo-cast", "research_trace.jsonl");
  assert.ok(fs.existsSync(globalTracePath), "runner should append global research_trace.jsonl");
  assert.match(fs.readFileSync(globalTracePath, "utf8"), new RegExp(runId));
});

test("mutation policy writes a schema-valid next recipe", () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "neo-cast-mutate-"));
  const recipePath = path.join(REPO_ROOT, "py", "schemas", "recipe.example.json");
  const metricsPath = path.join(workDir, "metrics.json");
  const outputPath = path.join(workDir, "mutated.json");
  fs.writeFileSync(metricsPath, '{"val_avg_mse": 1.2}\n', "utf8");

  const python = fs.existsSync(path.join(REPO_ROOT, ".neo-cast", "runtime", ".venv", "bin", "python"))
    ? path.join(REPO_ROOT, ".neo-cast", "runtime", ".venv", "bin", "python")
    : "python3";
  const result = spawnSync(
    python,
    [
      path.join(REPO_ROOT, "py", "search", "mutate.py"),
      "--recipe",
      recipePath,
      "--metrics",
      metricsPath,
      "--output",
      outputPath,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const candidate = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.equal(candidate.embedding.type, "multiscale_patch");
  assert.equal(candidate.fusion.channel_mode, "shared");
  assert.match(candidate.notes, /mutation:/);

  const validate = runNode(["validate", "recipe", outputPath], { cwd: REPO_ROOT });
  assert.equal(validate.status, 0, validate.stderr || validate.stdout);
});

test("runner ref-test evaluates the best artifact and updates metadata", () => {
  const statePath = path.join(REPO_ROOT, ".neo-cast", "runner_state.json");
  assert.ok(fs.existsSync(statePath), "runner state must exist before ref-test");

  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.ok(state.best_run_id, "best_run_id must be available before ref-test");

  const result = runNode(
    ["runner", "ref-test", "--run-id", state.best_run_id],
    { cwd: REPO_ROOT }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ref_test_done/);

  const artifactDir = path.join(REPO_ROOT, ".neo-cast", "artifacts", `run_${state.best_run_id}`);
  const metricsPath = path.join(artifactDir, "ref_test_metrics.json");
  const metadataPath = path.join(artifactDir, "metadata.json");

  assert.ok(fs.existsSync(metricsPath), "ref_test_metrics.json should exist after ref-test");
  assert.ok(fs.existsSync(metadataPath), "metadata.json should exist after ref-test");

  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  assert.ok(metadata.ref_test_metrics, "metadata should contain ref_test_metrics");
  assert.equal(typeof metadata.ref_test_metrics.ref_test_avg_mse, "number");
});
