"use strict";

const fs = require("fs");
const path = require("path");

const TASK_SPEC_SCHEMA_VERSION = "task_spec.v1";
const SUPPORTED_TASK_TYPES = new Set(["time_series_forecasting"]);
const SUPPORTED_INTERACTION_MODES = new Set(["socratic", "cognitive_copilot"]);
const ROOT_KEYS = new Set([
  "schema_version",
  "task_id",
  "task_type",
  "domain",
  "target_column",
  "time_column",
  "frequency",
  "history_window",
  "prediction_horizon",
  "prediction_horizons",
  "metrics",
  "constraints",
  "output",
  "interaction_mode",
]);
const CONSTRAINT_KEYS = new Set([
  "max_model_params",
  "max_training_hours",
  "prefer_lightweight_model",
]);
const OUTPUT_KEYS = new Set(["report", "model_code", "checkpoint", "inference_api"]);

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function assertKnownKeys(payload, allowed, name) {
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      throw new Error(`${name} contains unsupported field: ${key}`);
    }
  }
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalNonEmptyString(value, name) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return nonEmptyString(value, name);
}

function taskIdString(value) {
  const taskId = nonEmptyString(value, "task_id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(taskId)) {
    throw new Error("task_id must start with an alphanumeric character and contain only letters, numbers, dot, underscore, or dash");
  }
  return taskId;
}

function positiveInteger(value, name) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function positiveNumber(value, name) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function uniqueNonEmptyStrings(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty array`);
  }
  const items = value.map((item, index) => nonEmptyString(item, `${name}[${index}]`).toLowerCase());
  if (new Set(items).size !== items.length) {
    throw new Error(`${name} must not contain duplicates`);
  }
  return items;
}

function uniquePositiveIntegers(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty array`);
  }
  const items = value.map((item, index) => positiveInteger(item, `${name}[${index}]`));
  if (new Set(items).size !== items.length) {
    throw new Error(`${name} must not contain duplicates`);
  }
  return items;
}

function normalizeConstraints(rawConstraints) {
  const constraints = rawConstraints || {};
  assertPlainObject(constraints, "constraints");
  assertKnownKeys(constraints, CONSTRAINT_KEYS, "constraints");

  const normalized = {};
  if (constraints.max_model_params !== undefined) {
    if (typeof constraints.max_model_params === "number") {
      normalized.max_model_params = positiveInteger(constraints.max_model_params, "constraints.max_model_params");
    } else {
      normalized.max_model_params = nonEmptyString(constraints.max_model_params, "constraints.max_model_params");
    }
  }
  if (constraints.max_training_hours !== undefined) {
    normalized.max_training_hours = positiveNumber(
      constraints.max_training_hours,
      "constraints.max_training_hours"
    );
  }
  if (constraints.prefer_lightweight_model !== undefined) {
    if (typeof constraints.prefer_lightweight_model !== "boolean") {
      throw new Error("constraints.prefer_lightweight_model must be a boolean");
    }
    normalized.prefer_lightweight_model = constraints.prefer_lightweight_model;
  }
  return normalized;
}

function normalizeOutput(rawOutput) {
  const output = rawOutput || {};
  assertPlainObject(output, "output");
  assertKnownKeys(output, OUTPUT_KEYS, "output");
  const normalized = {};
  for (const key of OUTPUT_KEYS) {
    normalized[key] = Boolean(output[key]);
  }
  return normalized;
}

function normalizeTaskSpec(payload) {
  assertPlainObject(payload, "task spec");
  assertKnownKeys(payload, ROOT_KEYS, "task spec");

  const schemaVersion = payload.schema_version || TASK_SPEC_SCHEMA_VERSION;
  if (schemaVersion !== TASK_SPEC_SCHEMA_VERSION) {
    throw new Error(`schema_version must be ${TASK_SPEC_SCHEMA_VERSION}`);
  }

  const taskType = nonEmptyString(payload.task_type, "task_type");
  if (!SUPPORTED_TASK_TYPES.has(taskType)) {
    throw new Error(`task_type must be one of: ${Array.from(SUPPORTED_TASK_TYPES).join(", ")}`);
  }

  const predictionHorizon = positiveInteger(payload.prediction_horizon, "prediction_horizon");
  const predictionHorizons = payload.prediction_horizons === undefined
    ? [predictionHorizon]
    : uniquePositiveIntegers(payload.prediction_horizons, "prediction_horizons");
  if (!predictionHorizons.includes(predictionHorizon)) {
    throw new Error("prediction_horizons must include prediction_horizon");
  }

  const interactionMode = payload.interaction_mode || "cognitive_copilot";
  if (!SUPPORTED_INTERACTION_MODES.has(interactionMode)) {
    throw new Error(`interaction_mode must be one of: ${Array.from(SUPPORTED_INTERACTION_MODES).join(", ")}`);
  }

  const normalized = {
    schema_version: TASK_SPEC_SCHEMA_VERSION,
    task_id: taskIdString(payload.task_id),
    task_type: taskType,
  };
  const domain = optionalNonEmptyString(payload.domain, "domain");
  if (domain) {
    normalized.domain = domain;
  }
  normalized.target_column = nonEmptyString(payload.target_column, "target_column");
  normalized.time_column = nonEmptyString(payload.time_column, "time_column");
  normalized.frequency = nonEmptyString(payload.frequency, "frequency");
  normalized.history_window = positiveInteger(payload.history_window, "history_window");
  normalized.prediction_horizon = predictionHorizon;
  normalized.prediction_horizons = predictionHorizons;
  normalized.metrics = uniqueNonEmptyStrings(payload.metrics, "metrics");
  normalized.constraints = normalizeConstraints(payload.constraints);
  normalized.output = normalizeOutput(payload.output);
  normalized.interaction_mode = interactionMode;
  return normalized;
}

function loadJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function buildTaskSpecFromDatasetSpec(datasetSpec, overrides = {}) {
  assertPlainObject(datasetSpec, "dataset spec");
  if (!["dataset.v1", "dataset.v2"].includes(datasetSpec.schema_version)) {
    throw new Error("dataset spec schema_version must be dataset.v1 or dataset.v2");
  }
  const featureColumns = datasetSpec.schema_version === "dataset.v2"
    ? (Array.isArray(datasetSpec.target_columns) ? datasetSpec.target_columns : [])
    : (Array.isArray(datasetSpec.feature_columns) ? datasetSpec.feature_columns : []);
  if (featureColumns.length === 0) {
    throw new Error("dataset spec target/feature columns must be a non-empty array");
  }
  const horizons = uniquePositiveIntegers(datasetSpec.horizons, "dataset spec horizons");
  const frequency = datasetSpec.time && datasetSpec.time.frequency
    ? String(datasetSpec.time.frequency)
    : "auto";
  const targetColumn = overrides.target_column || overrides.targetColumn || featureColumns[featureColumns.length - 1];
  const predictionHorizons = overrides.prediction_horizons || overrides.predictionHorizons || horizons;
  const predictionHorizon = overrides.prediction_horizon
    || overrides.predictionHorizon
    || Math.max(...predictionHorizons.map((item) => positiveInteger(item, "prediction_horizons[]")));

  return normalizeTaskSpec({
    schema_version: TASK_SPEC_SCHEMA_VERSION,
    task_id: overrides.task_id || overrides.taskId || datasetSpec.task_id,
    task_type: overrides.task_type || overrides.taskType || "time_series_forecasting",
    domain: overrides.domain,
    target_column: targetColumn,
    time_column: overrides.time_column || overrides.timeColumn || datasetSpec.timestamp_col,
    frequency: overrides.frequency || frequency,
    history_window: overrides.history_window || overrides.historyWindow || datasetSpec.input_len,
    prediction_horizon: predictionHorizon,
    prediction_horizons: predictionHorizons,
    metrics: overrides.metrics || ["mse", "mae"],
    constraints: overrides.constraints || {},
    output: overrides.output || {
      report: true,
      model_code: true,
      checkpoint: true,
      inference_api: false,
    },
    interaction_mode: overrides.interaction_mode || overrides.interactionMode || "cognitive_copilot",
  });
}

function defaultTaskSpecPath(projectRoot = process.cwd()) {
  return path.join(projectRoot, ".neo-cast", "task_spec.json");
}

function writeTaskSpec(spec, outputPath, options = {}) {
  const normalized = normalizeTaskSpec(spec);
  const resolvedPath = path.resolve(outputPath || defaultTaskSpecPath(options.projectRoot));
  if (fs.existsSync(resolvedPath) && !options.force) {
    throw new Error(`${resolvedPath} already exists. Re-run with --force to overwrite it.`);
  }
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return resolvedPath;
}

module.exports = {
  TASK_SPEC_SCHEMA_VERSION,
  buildTaskSpecFromDatasetSpec,
  defaultTaskSpecPath,
  loadJsonFile,
  normalizeTaskSpec,
  writeTaskSpec,
};
