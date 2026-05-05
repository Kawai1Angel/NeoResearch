"use strict";

const fs = require("fs");
const path = require("path");

const MEMORY_SCHEMA_VERSION = "user_correction_memory.v1";
const CORRECTION_SCHEMA_VERSION = "user_correction.v1";
const DEFAULT_STATUS = "active";
const VALID_SCOPES = new Set([
  "data_schema",
  "anomaly",
  "split_policy",
  "deployment",
  "metric",
  "model_constraint",
  "general",
]);
const VALID_STATUSES = new Set(["active", "resolved", "archived"]);

function defaultCorrectionMemoryPath(projectRoot = process.cwd()) {
  return path.join(projectRoot, ".neo-cast", "user_corrections.json");
}

function ensureStateDir(projectRoot) {
  fs.mkdirSync(path.join(projectRoot, ".neo-cast"), { recursive: true });
}

function makeCorrectionId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `uc_${stamp}_${suffix}`;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value, name) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string when provided`);
  }
  return value.trim();
}

function normalizeUserCorrection(raw = {}, options = {}) {
  const correction = requireNonEmptyString(raw.correction, "correction");
  const scope = optionalString(raw.scope, "scope") || "general";
  if (!VALID_SCOPES.has(scope)) {
    throw new Error(`scope must be one of: ${Array.from(VALID_SCOPES).join(", ")}`);
  }
  const status = optionalString(raw.status, "status") || DEFAULT_STATUS;
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`status must be one of: ${Array.from(VALID_STATUSES).join(", ")}`);
  }
  const now = options.now || new Date();
  const createdAt = optionalString(raw.created_at, "created_at") || now.toISOString();
  return {
    schema_version: CORRECTION_SCHEMA_VERSION,
    correction_id: optionalString(raw.correction_id, "correction_id") || makeCorrectionId(now),
    scope,
    field: optionalString(raw.field, "field"),
    correction,
    applies_to: optionalString(raw.applies_to, "applies_to"),
    status,
    created_by: optionalString(raw.created_by, "created_by") || "user",
    created_at: createdAt,
  };
}

function emptyCorrectionMemory() {
  return {
    schema_version: MEMORY_SCHEMA_VERSION,
    user_corrections: [],
  };
}

function normalizeCorrectionMemory(raw = {}) {
  if (Array.isArray(raw)) {
    return {
      schema_version: MEMORY_SCHEMA_VERSION,
      user_corrections: raw.map((item) => normalizeUserCorrection(item)),
    };
  }
  const records = Array.isArray(raw.user_corrections) ? raw.user_corrections : [];
  return {
    schema_version: MEMORY_SCHEMA_VERSION,
    user_corrections: records.map((item) => normalizeUserCorrection(item)),
  };
}

function loadCorrectionMemory(projectRoot = process.cwd()) {
  const memoryPath = defaultCorrectionMemoryPath(projectRoot);
  if (!fs.existsSync(memoryPath)) {
    return emptyCorrectionMemory();
  }
  const raw = JSON.parse(fs.readFileSync(memoryPath, "utf8"));
  return normalizeCorrectionMemory(raw);
}

function writeCorrectionMemory(projectRoot, memory) {
  ensureStateDir(projectRoot);
  const normalized = normalizeCorrectionMemory(memory);
  const memoryPath = defaultCorrectionMemoryPath(projectRoot);
  fs.writeFileSync(memoryPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return memoryPath;
}

function addUserCorrection(projectRoot = process.cwd(), raw = {}) {
  const memory = loadCorrectionMemory(projectRoot);
  const correction = normalizeUserCorrection(raw);
  const nextMemory = {
    schema_version: MEMORY_SCHEMA_VERSION,
    user_corrections: [...memory.user_corrections, correction],
  };
  const memoryPath = writeCorrectionMemory(projectRoot, nextMemory);
  return { correction, memoryPath, memory: nextMemory };
}

function loadUserCorrections(projectRoot = process.cwd(), options = {}) {
  const memory = loadCorrectionMemory(projectRoot);
  const status = options.status === undefined ? DEFAULT_STATUS : options.status;
  if (!status || status === "all") {
    return memory.user_corrections;
  }
  return memory.user_corrections.filter((item) => item.status === status);
}

function formatUserCorrections(corrections = [], options = {}) {
  const active = corrections.filter((item) => !item.status || item.status === DEFAULT_STATUS);
  if (active.length === 0) {
    return "";
  }
  const limit = Number.isFinite(options.limit) ? options.limit : 20;
  const lines = [
    "- Human Feedback Memory / User Correction Memory:",
  ];
  for (const item of active.slice(0, limit)) {
    const parts = [];
    if (item.scope) parts.push(`[${item.scope}]`);
    if (item.field) parts.push(`field=${item.field}`);
    if (item.applies_to) parts.push(`applies_to=${item.applies_to}`);
    const target = parts.length > 0 ? `${parts.join(" ")}: ` : "";
    lines.push(`  - ${target}${item.correction}`);
  }
  if (active.length > limit) {
    lines.push(`  - ... ${active.length - limit} more active corrections omitted`);
  }
  lines.push("- Treat user corrections as authoritative constraints unless newer evidence or newer user corrections explicitly supersede them.");
  return lines.join("\n");
}

module.exports = {
  CORRECTION_SCHEMA_VERSION,
  DEFAULT_STATUS,
  MEMORY_SCHEMA_VERSION,
  VALID_SCOPES,
  VALID_STATUSES,
  addUserCorrection,
  defaultCorrectionMemoryPath,
  emptyCorrectionMemory,
  formatUserCorrections,
  loadCorrectionMemory,
  loadUserCorrections,
  normalizeCorrectionMemory,
  normalizeUserCorrection,
  writeCorrectionMemory,
};
