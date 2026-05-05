"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const APPROVAL_SCHEMA_VERSION = "approval_state.v1";
const CHECKPOINT_STAGES = new Set(["task", "data_diagnosis", "hypothesis", "model_design", "experiment_budget", "result_publish"]);

function nowIso() {
  return new Date().toISOString();
}

function getApprovalStatePath(projectRoot = process.cwd()) {
  return path.join(projectRoot, ".neo-cast", "approval_state.json");
}

function loadApprovalState(projectRoot = process.cwd()) {
  const statePath = getApprovalStatePath(projectRoot);
  if (!fs.existsSync(statePath)) {
    return {
      schema_version: APPROVAL_SCHEMA_VERSION,
      current_stage: "not_started",
      checkpoints: {},
      history: [],
    };
  }
  const payload = JSON.parse(fs.readFileSync(statePath, "utf8"));
  return {
    schema_version: payload.schema_version || APPROVAL_SCHEMA_VERSION,
    current_stage: payload.current_stage || "not_started",
    checkpoints: payload.checkpoints && typeof payload.checkpoints === "object" ? payload.checkpoints : {},
    history: Array.isArray(payload.history) ? payload.history : [],
  };
}

function saveApprovalState(projectRoot, state) {
  const statePath = getApprovalStatePath(projectRoot);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return statePath;
}

function assertStage(stage) {
  if (!CHECKPOINT_STAGES.has(stage)) {
    throw new Error(`checkpoint stage must be one of: ${Array.from(CHECKPOINT_STAGES).join(", ")}`);
  }
}

function fileSha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function nextStageForApproval(stage) {
  if (stage === "model_design") return "train_eval_ready";
  if (stage === "result_publish") return "result_publish_ready";
  return `${stage}_approved`;
}

function requestCheckpoint(options) {
  const projectRoot = options.projectRoot || process.cwd();
  const stage = String(options.stage || "");
  assertStage(stage);
  const subjectPath = options.subjectPath ? path.resolve(options.subjectPath) : null;
  const subjectHash = subjectPath && fs.existsSync(subjectPath) ? fileSha256(subjectPath) : null;
  const state = loadApprovalState(projectRoot);
  const requestedAt = nowIso();
  const checkpoint = {
    checkpoint_id: `${stage}_${requestedAt.replace(/[^0-9A-Za-z]/g, "").slice(0, 18)}`,
    stage,
    status: "pending",
    requested_by: options.requestedBy || "Runtime",
    requested_at: requestedAt,
    summary: options.summary || "",
    subject_path: subjectPath,
    subject_hash: subjectHash,
  };
  state.current_stage = `${stage}_pending_approval`;
  state.checkpoints[stage] = checkpoint;
  state.history.push({
    event: "checkpoint_requested",
    stage,
    status: "pending",
    checkpoint_id: checkpoint.checkpoint_id,
    subject_hash: subjectHash,
    at: requestedAt,
  });
  saveApprovalState(projectRoot, state);
  return checkpoint;
}

function updateCheckpointStatus(options) {
  const projectRoot = options.projectRoot || process.cwd();
  const stage = String(options.stage || "");
  assertStage(stage);
  const status = String(options.status || "");
  if (!["approved", "rejected"].includes(status)) {
    throw new Error("checkpoint status must be approved or rejected");
  }
  const state = loadApprovalState(projectRoot);
  const checkpoint = state.checkpoints[stage];
  if (!checkpoint) {
    throw new Error(`No checkpoint found for stage: ${stage}`);
  }
  const at = nowIso();
  checkpoint.status = status;
  checkpoint.note = options.note || "";
  if (status === "approved") {
    checkpoint.approved_at = at;
    checkpoint.approved_by = options.by || "user";
    state.current_stage = nextStageForApproval(stage);
  } else {
    checkpoint.rejected_at = at;
    checkpoint.rejected_by = options.by || "user";
    state.current_stage = `${stage}_rejected`;
  }
  state.history.push({
    event: status === "approved" ? "checkpoint_approved" : "checkpoint_rejected",
    stage,
    status,
    checkpoint_id: checkpoint.checkpoint_id,
    by: options.by || "user",
    note: options.note || "",
    at,
  });
  saveApprovalState(projectRoot, state);
  return checkpoint;
}

module.exports = {
  APPROVAL_SCHEMA_VERSION,
  CHECKPOINT_STAGES,
  fileSha256,
  getApprovalStatePath,
  loadApprovalState,
  requestCheckpoint,
  saveApprovalState,
  updateCheckpointStatus,
};
