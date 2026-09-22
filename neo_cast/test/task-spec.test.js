"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const REPO_ROOT = path.resolve(__dirname, "..");
const BIN = path.join(REPO_ROOT, "bin", "neo-cast.js");

function runNode(args, options = {}) {
  return spawnSync("node", [BIN, ...args], {
    cwd: options.cwd || REPO_ROOT,
    env: { ...require("./python-env"), ...(options.env || {}) },
    encoding: "utf8",
  });
}

test("normalizeTaskSpec turns a task DSL payload into a strict task contract", () => {
  const { normalizeTaskSpec } = require("../src/task-spec");

  const spec = normalizeTaskSpec({
    schema_version: "task_spec.v1",
    task_id: "tsf_energy_001",
    task_type: "time_series_forecasting",
    domain: "electric_load_forecasting",
    target_column: "load",
    time_column: "timestamp",
    frequency: "hourly",
    history_window: 96,
    prediction_horizon: 24,
    metrics: ["mse", "mae"],
    constraints: {
      max_model_params: "5M",
      max_training_hours: 3,
      prefer_lightweight_model: true,
    },
    output: {
      report: true,
      model_code: true,
      checkpoint: true,
    },
  });

  assert.deepEqual(spec, {
    schema_version: "task_spec.v1",
    task_id: "tsf_energy_001",
    task_type: "time_series_forecasting",
    domain: "electric_load_forecasting",
    target_column: "load",
    time_column: "timestamp",
    frequency: "hourly",
    history_window: 96,
    prediction_horizon: 24,
    prediction_horizons: [24],
    metrics: ["mse", "mae"],
    constraints: {
      max_model_params: "5M",
      max_training_hours: 3,
      prefer_lightweight_model: true,
    },
    output: {
      report: true,
      model_code: true,
      checkpoint: true,
      inference_api: false,
    },
    interaction_mode: "cognitive_copilot",
  });
});

test("normalizeTaskSpec rejects ambiguous or incomplete task DSL payloads", () => {
  const { normalizeTaskSpec } = require("../src/task-spec");

  assert.throws(
    () => normalizeTaskSpec({
      schema_version: "task_spec.v1",
      task_id: "bad",
      task_type: "time_series_forecasting",
      time_column: "timestamp",
      frequency: "hourly",
      history_window: 96,
      prediction_horizon: 24,
      metrics: ["mse"],
    }),
    /target_column must be a non-empty string/
  );

  assert.throws(
    () => normalizeTaskSpec({
      schema_version: "task_spec.v1",
      task_id: "bad",
      task_type: "time_series_forecasting",
      target_column: "load",
      time_column: "timestamp",
      frequency: "hourly",
      history_window: 96,
      prediction_horizon: 24,
      prediction_horizons: [96, 192],
      metrics: ["mse"],
    }),
    /prediction_horizons must include prediction_horizon/
  );

  assert.throws(
    () => normalizeTaskSpec({
      schema_version: "task_spec.v1",
      task_id: "bad task id",
      task_type: "time_series_forecasting",
      target_column: "load",
      time_column: "timestamp",
      frequency: "hourly",
      history_window: 96,
      prediction_horizon: 24,
      metrics: ["mse"],
    }),
    /task_id must start with an alphanumeric character/
  );
});

test("task-spec init creates a task contract from an existing dataset spec", () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "neo-cast-task-spec-"));
  const stateDir = path.join(projectDir, ".neo-cast");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "dataset_spec.json"),
    JSON.stringify({
      schema_version: "dataset.v1",
      task_id: "custom_load",
      timestamp_col: "timestamp",
      feature_columns: ["temperature", "load"],
      input_len: 96,
      horizons: [24, 48],
      splits: {
        train: [0, 1000],
        val: [1000, 1200],
        ref_test: [1200, 1400],
      },
      normalization: { type: "standard", fit_split: "train" },
      missing: { strategy: "forward_fill", limit: null },
      time: { frequency: "hourly", allow_irregular: false, irregular_ratio_warn: 0.01 },
    }),
    "utf8"
  );

  const outputPath = path.join(projectDir, "task_spec.json");
  const result = runNode([
    "task-spec",
    "init",
    "--from-dataset",
    path.join(stateDir, "dataset_spec.json"),
    "--output",
    outputPath,
  ], { cwd: projectDir });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /task_spec_path=/);

  const payload = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.equal(payload.schema_version, "task_spec.v1");
  assert.equal(payload.task_id, "custom_load");
  assert.equal(payload.target_column, "load");
  assert.equal(payload.time_column, "timestamp");
  assert.equal(payload.history_window, 96);
  assert.equal(payload.prediction_horizon, 48);
  assert.deepEqual(payload.prediction_horizons, [24, 48]);
  assert.match(result.stdout, /task_version=task_custom_load_v1/);

  const lineageIndexPath = path.join(stateDir, "lineage", "index.json");
  assert.ok(fs.existsSync(lineageIndexPath), "task-spec init should create a lineage index");
  const lineage = JSON.parse(fs.readFileSync(lineageIndexPath, "utf8"));
  assert.equal(lineage.latest.task, "task_custom_load_v1");
  assert.equal(lineage.records.task_custom_load_v1.artifact_path, "task_spec.json");
});

test("task-spec validate rejects a malformed task contract", () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "neo-cast-task-spec-invalid-"));
  const payloadPath = path.join(projectDir, "task_spec.json");
  fs.writeFileSync(
    payloadPath,
    JSON.stringify({
      schema_version: "task_spec.v1",
      task_id: "broken",
      task_type: "time_series_forecasting",
      target_column: "load",
      time_column: "timestamp",
      frequency: "hourly",
      history_window: 0,
      prediction_horizon: 24,
      metrics: ["mse"],
    }),
    "utf8"
  );

  const result = runNode(["task-spec", "validate", payloadPath], { cwd: projectDir });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /history_window must be a positive integer/);
});

test("validate task-spec accepts a schema-valid task contract", () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "neo-cast-task-spec-schema-"));
  const payloadPath = path.join(projectDir, "task_spec.json");
  fs.writeFileSync(
    payloadPath,
    JSON.stringify({
      schema_version: "task_spec.v1",
      task_id: "energy_hourly",
      task_type: "time_series_forecasting",
      target_column: "load",
      time_column: "timestamp",
      frequency: "hourly",
      history_window: 96,
      prediction_horizon: 24,
      prediction_horizons: [24],
      metrics: ["mse", "mae"],
      constraints: {
        max_model_params: "5M",
        max_training_hours: 3,
        prefer_lightweight_model: true,
      },
      output: {
        report: true,
        model_code: true,
        checkpoint: true,
        inference_api: false,
      },
      interaction_mode: "cognitive_copilot",
    }),
    "utf8"
  );

  const result = runNode(["validate", "task-spec", payloadPath], { cwd: projectDir });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /validation_status: valid/);
  assert.match(result.stdout, /schema_kind: task-spec/);
});
