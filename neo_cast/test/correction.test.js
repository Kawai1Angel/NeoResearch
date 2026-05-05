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
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
  });
}

test("correction add/list persists structured user correction memory", () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "neo-cast-correction-"));

  const add = runNode([
    "correction",
    "add",
    "--scope",
    "data_schema",
    "--field",
    "temperature_forecast",
    "--correction",
    "available only at prediction time",
  ], { cwd: projectDir });

  assert.equal(add.status, 0, add.stderr || add.stdout);
  assert.match(add.stdout, /correction_status=active/);
  assert.match(add.stdout, /correction_id=/);

  const memoryPath = path.join(projectDir, ".neo-cast", "user_corrections.json");
  const memory = JSON.parse(fs.readFileSync(memoryPath, "utf8"));
  assert.equal(memory.schema_version, "user_correction_memory.v1");
  assert.equal(memory.user_corrections.length, 1);
  assert.equal(memory.user_corrections[0].schema_version, "user_correction.v1");
  assert.equal(memory.user_corrections[0].scope, "data_schema");
  assert.equal(memory.user_corrections[0].field, "temperature_forecast");
  assert.equal(memory.user_corrections[0].correction, "available only at prediction time");
  assert.equal(memory.user_corrections[0].status, "active");

  const list = runNode(["correction", "list"], { cwd: projectDir });
  assert.equal(list.status, 0, list.stderr || list.stdout);
  assert.match(list.stdout, /correction_count=1/);
  assert.match(list.stdout, /temperature_forecast/);
  assert.match(list.stdout, /available only at prediction time/);
});

test("correction add rejects empty correction text", () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "neo-cast-correction-invalid-"));

  const add = runNode([
    "correction",
    "add",
    "--field",
    "holiday_flag",
  ], { cwd: projectDir });

  assert.equal(add.status, 1);
  assert.match(add.stderr, /--correction is required/);
});

test("validate user-corrections accepts correction memory files", () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "neo-cast-correction-validate-"));

  const add = runNode([
    "correction",
    "add",
    "--scope",
    "deployment",
    "--correction",
    "model must stay under the deployment size budget",
  ], { cwd: projectDir });
  assert.equal(add.status, 0, add.stderr || add.stdout);

  const result = runNode([
    "validate",
    "user-corrections",
    path.join(projectDir, ".neo-cast", "user_corrections.json"),
  ], { cwd: projectDir });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /validation_status: valid/);
  assert.match(result.stdout, /schema_kind: user-corrections/);
});
