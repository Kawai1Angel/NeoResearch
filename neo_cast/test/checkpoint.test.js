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

test("checkpoint request/status/approve persists runtime approval state", () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "neo-cast-checkpoint-"));
  const stateDir = path.join(projectDir, ".neo-cast");
  fs.mkdirSync(stateDir, { recursive: true });
  const candidatePath = path.join(stateDir, "current_candidate.json");
  fs.writeFileSync(candidatePath, '{"recipe_id":"recipe_gate_001"}\n', "utf8");

  const request = runNode([
    "checkpoint",
    "request",
    "model_design",
    "--subject",
    candidatePath,
    "--summary",
    "Approve compact DLinear before training",
  ], { cwd: projectDir });

  assert.equal(request.status, 0, request.stderr || request.stdout);
  assert.match(request.stdout, /checkpoint_status=pending/);

  const statusBefore = runNode(["checkpoint", "status"], { cwd: projectDir });
  assert.equal(statusBefore.status, 0, statusBefore.stderr || statusBefore.stdout);
  assert.match(statusBefore.stdout, /current_stage=model_design_pending_approval/);
  assert.match(statusBefore.stdout, /model_design=pending/);

  const approve = runNode([
    "checkpoint",
    "approve",
    "model_design",
    "--by",
    "tester",
    "--note",
    "Looks safe",
  ], { cwd: projectDir });

  assert.equal(approve.status, 0, approve.stderr || approve.stdout);
  assert.match(approve.stdout, /checkpoint_status=approved/);

  const payload = JSON.parse(fs.readFileSync(path.join(stateDir, "approval_state.json"), "utf8"));
  assert.equal(payload.schema_version, "approval_state.v1");
  assert.equal(payload.current_stage, "train_eval_ready");
  assert.equal(payload.checkpoints.model_design.status, "approved");
  assert.equal(payload.checkpoints.model_design.approved_by, "tester");
  assert.equal(payload.checkpoints.model_design.note, "Looks safe");
  assert.equal(payload.history.length, 2);
});
