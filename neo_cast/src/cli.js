"use strict";

const {
  buildPublicConfigView,
  ensureUserConfigFile,
  resolveConfig,
} = require("./config");
const { formatDoctorReport, runDoctor } = require("./doctor");
const { generateCandidate } = require("./llm");
const { describeCandidateFamily, describeCandidateId } = require("./candidate-utils");
const { appendModelDesignRecord } = require("./model-design-log");
const { collectSocraticRequirement } = require("./modes/socratic");
const {
  buildCompanionRequirement,
  printCompanionAttempt,
  printCompanionFinalSummary,
  printCompanionHeader,
  printCompanionResult,
  startCompanionPulse = () => ({ stop: () => {}, onOutput: () => {} }),
  watchForStop,
} = require("./modes/companion");
const { printFinalSummary, printRequirementSummary } = require("./output");
const { getBestSessionRow, getLatestSessionRow } = require("./session");
const {
  buildTaskSpecFromDatasetSpec,
  defaultTaskSpecPath,
  loadJsonFile,
  normalizeTaskSpec,
  writeTaskSpec,
} = require("./task-spec");
const {
  loadApprovalState,
  requestCheckpoint,
  updateCheckpointStatus,
} = require("./checkpoint");
const {
  addUserCorrection,
  defaultCorrectionMemoryPath,
  loadUserCorrections,
} = require("./corrections");
const {
  ensureRunnerInitialized,
  getProjectPaths,
  loadResults,
  mutateCandidate,
  runPythonCommand,
  runRunner,
  writeCurrentCandidate,
} = require("./python-bridge");
const { getRuntimePaths, initRuntime, runtimeReady } = require("./runtime");
const { isMockLlmEnabled } = require("./mock-mode");
const { publishReleaseReport } = require("./report-output");
const { getLatestVersionRef, getNextVersionId, registerVersion } = require("./versioning");
const fs = require("fs");
const path = require("path");
const PY_DIR = "py";

function getPackageVersion() {
  const packageJsonPath = path.join(__dirname, "..", "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return "0.0.0-dev";
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return pkg.version || "0.0.0-dev";
  } catch (_error) {
    return "0.0.0-dev";
  }
}

function printHelp() {
  const helpText = `
neo-cast ${getPackageVersion()}

Usage:
  neo-cast --version
  neo-cast help
  neo-cast doctor
  neo-cast validate <candidate|recipe|model-recipe|dataset|metadata|task-spec|research-trace|user-corrections> <payload.json> [--schema /path/to/schema.json]
  neo-cast validate smoke [--candidate-path /path/to/candidate.json]
  neo-cast config init
  neo-cast config show
  neo-cast init-runtime [--skip-install]
  neo-cast task-spec init [--from-dataset .neo-cast/dataset_spec.json] [--output .neo-cast/task_spec.json]
  neo-cast task-spec validate [.neo-cast/task_spec.json]
  neo-cast checkpoint <status|request|approve|reject> [stage]
  neo-cast correction <add|list> [--scope data_schema] [--field column] [--correction "..."]
  neo-cast prepare-data --source /path/to/data.csv [--target-cols y] [--observed-past-covariates x1,x2]
  neo-cast runner init [--force]
  neo-cast runner run --description "baseline"
  neo-cast runner ref-test [--run-id 20260424-...]
  neo-cast runner blind-test [--run-id 20260424-...]
  neo-cast runner status
  neo-cast design --requirement "small transformer for ETTh1" [--mode socratic|companion] [--max-candidates 3]
                  [--mock-llm] [--use-mutation] [--use-reflection] [--stop-on-keep] [--require-approval]
  neo-cast design --requirement "small transformer for ETTh1" --autonomous [--time-budget 2h]
                  [--max-no-improve 7] [--mock-llm] [--use-reflection] [--use-mutation]

Commands:
  doctor         Check python3, uv, API key, and resolved config
  validate       Validate JSON payloads or run the smoke gate
  config init    Create the default user config file if missing
  config show    Print the resolved config with secrets masked
  init-runtime   Create the project-local Python runtime under .neo-cast/runtime/.venv
  task-spec      Create or validate the task_spec.v1 research task contract
  checkpoint     Manage runtime human approval checkpoints
  correction     Persist and inspect Human Feedback Memory / User Correction Memory
  prepare-data   Materialize ETTh1 visible/ref-test splits into the dataset cache
  runner         Run the project-local smoke/full/ref-test experiment loop
  design         Generate candidates and run the local design loop

Design flags:
  --use-reflection   After each run, ask the reflection agent to analyze results and propose the next candidate
                     (takes priority over --use-mutation; falls back to mutation on reflection failure)
  --autonomous       Continue iterating until budget, plateau, or crash stopping conditions are met
  --require-approval Pause after model design and require: neo-cast checkpoint approve model_design
  --time-budget      Autonomous wall-clock budget, e.g. 2h, 90m, 3600s
  --max-no-improve   Autonomous plateau limit; defaults to 7 consecutive non-improving runs

No API key?
  Use \`--mock-llm\` on design commands, or set \`NEO_CAST_USE_MOCK=1\`, to run the
  offline heuristic candidate factory for alpha demos.
`.trim();
  console.log(helpText);
}

function parseArgs(argv) {
  const args = [...argv];
  const flags = {};
  const positionals = [];

  while (args.length > 0) {
    const token = args.shift();
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    if (token === "--help") {
      flags.help = true;
      continue;
    }
    if (token === "--version") {
      flags.version = true;
      continue;
    }

    const [key, inlineValue] = token.split("=", 2);
    const normalizedKey = key.slice(2);
    if (inlineValue !== undefined) {
      flags[normalizedKey] = inlineValue;
      continue;
    }

    const next = args[0];
    if (next && !next.startsWith("--")) {
      flags[normalizedKey] = args.shift();
    } else {
      flags[normalizedKey] = true;
    }
  }

  return { positionals, flags };
}

function mapCliFlags(rawFlags) {
  const mapped = {};
  if (rawFlags.provider) {
    mapped.provider = rawFlags.provider;
  }
  if (rawFlags.model) {
    mapped.model = rawFlags.model;
  }
  if (rawFlags["base-url"]) {
    mapped.baseUrl = rawFlags["base-url"];
  }
  if (rawFlags["max-tokens"]) {
    mapped.maxTokens = rawFlags["max-tokens"];
  }
  if (rawFlags.temperature) {
    mapped.temperature = rawFlags.temperature;
  }
  if (rawFlags["timeout-seconds"]) {
    mapped.timeoutSeconds = rawFlags["timeout-seconds"];
  }
  return mapped;
}

function loadPreparedDatasetSpec(projectRoot = process.cwd()) {
  const specPaths = [
    path.join(projectRoot, ".neo-cast", "dataset", "dataset_spec.json"),
    path.join(projectRoot, ".neo-cast", "dataset_spec.json"),
  ];
  for (const specPath of specPaths) {
    if (!fs.existsSync(specPath)) {
      continue;
    }
    try {
      return JSON.parse(fs.readFileSync(specPath, "utf8"));
    } catch (_error) {
      return null;
    }
  }
  return null;
}

function loadDesignTaskContext(projectRoot = process.cwd()) {
  const datasetSpec = loadPreparedDatasetSpec(projectRoot);
  const userCorrections = loadUserCorrections(projectRoot);
  if (userCorrections.length === 0) {
    return datasetSpec;
  }
  return {
    ...(datasetSpec || {}),
    user_corrections: userCorrections,
  };
}

function latestValMetricsPath(projectRoot, row) {
  if (!row || !row.run_id || row.run_id.startsWith("crash_") || row.run_id.startsWith("smoke_")) {
    return null;
  }
  const metricsPath = path.join(projectRoot, ".neo-cast", "artifacts", `run_${row.run_id}`, "val_metrics.json");
  return fs.existsSync(metricsPath) ? metricsPath : null;
}

function taskIdFromContext(taskContext) {
  return taskContext && taskContext.task_id ? String(taskContext.task_id) : null;
}

function latestResearchParentRefs(projectRoot, taskId) {
  return ["task", "data"]
    .map((kind) => getLatestVersionRef(projectRoot, kind, taskId || undefined))
    .filter(Boolean);
}

function candidateVersionId(candidate, attempt) {
  return String(
    candidate.recipe_id
    || candidate.candidate_id
    || candidate.model_name
    || candidate.id
    || `candidate_${attempt || 1}`
  );
}

function artifactPathForRun(projectRoot, runId, fileName) {
  return path.join(projectRoot, ".neo-cast", "artifacts", `run_${runId}`, fileName);
}

function registerRecipeLineage(projectRoot, candidate, candidatePath, options = {}) {
  const taskId = taskIdFromContext(options.taskContext);
  return registerVersion(projectRoot, {
    kind: "recipe",
    logicalId: candidateVersionId(candidate, options.attempt),
    artifactPath: candidatePath,
    payload: candidate,
    parentRefs: latestResearchParentRefs(projectRoot, taskId),
    metadata: {
      attempt: options.attempt || null,
      candidate_source: options.source || null,
      candidate_id: candidate.candidate_id || null,
      recipe_id: candidate.recipe_id || null,
      model_name: candidate.model_name || null,
      model_family: candidate.model_family || describeCandidateFamily(candidate),
      user_correction_count: Array.isArray(options.taskContext?.user_corrections)
        ? options.taskContext.user_corrections.length
        : 0,
    },
  });
}

function registerExperimentLineage(projectRoot, row, options = {}) {
  if (!row || !row.run_id) {
    return null;
  }
  return registerVersion(projectRoot, {
    kind: "experiment",
    logicalId: row.run_id,
    artifactPath: artifactPathForRun(projectRoot, row.run_id, "metadata.json"),
    parentRefs: options.parentRefs || [],
    metadata: {
      session_id: row.session_id || null,
      candidate_id: row.candidate_id || null,
      model_family: row.model_family || null,
      status: row.status || null,
      is_best: row.status === "keep" ? "1" : "0",
      cv_avg_mse: row.cv_avg_mse || null,
      cv_std_mse: row.cv_std_mse || null,
      val_avg_mse: row.val_avg_mse || null,
      val_h96_mse: row.val_h96_mse || null,
      val_h720_mse: row.val_h720_mse || null,
    },
  });
}

function registerReleaseLineage(projectRoot, row, options = {}) {
  if (!row || !row.run_id) {
    return null;
  }
  const logicalId = row.run_id;
  const versionId = getNextVersionId(projectRoot, "release", logicalId);
  const sourceReportPath = artifactPathForRun(projectRoot, logicalId, "eval_report.md");
  const published = publishReleaseReport(projectRoot, {
    versionId,
    sourceReportPath,
    manifest: {
      run_id: logicalId,
      release_type: options.releaseType || "eval_report",
      session_id: row.session_id || null,
      candidate_id: row.candidate_id || null,
      status: row.status || null,
      is_best: row.status === "keep" ? "1" : "0",
    },
  });
  return registerVersion(projectRoot, {
    kind: "release",
    logicalId,
    artifactPath: published.reportPath,
    parentRefs: options.parentRefs || [],
    metadata: {
      release_type: options.releaseType || "eval_report",
      session_id: row.session_id || null,
      candidate_id: row.candidate_id || null,
      status: row.status || null,
      is_best: row.status === "keep" ? "1" : "0",
      report_path: published.reportPath,
      report_manifest_path: published.manifestPath,
      report_copied: published.copied,
      source_report_path: sourceReportPath,
    },
  });
}

async function runPythonScript(args, options = {}) {
  const projectRoot = fs.realpathSync(options.projectRoot || process.cwd());
  const pythonCommand = options.pythonCommand
    || (runtimeReady(projectRoot) ? getRuntimePaths(projectRoot).pythonPath : "python3");
  try {
    const result = await runPythonCommand(projectRoot, args, {
      pythonCommand,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      killAfterMs: options.killAfterMs,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
      capture: options.capture,
    });
    if (typeof result.status === "number") {
      return result.status;
    }
    if (result.timedOut) return 124;
    if (result.aborted) return 130;
    console.error(`Python script terminated by ${result.signal || "unknown signal"}`);
    return 1;
  } catch (error) {
    console.error(`Failed to launch python script with ${pythonCommand}: ${error.message}`);
    return 1;
  }
}

function handleDoctor(rawFlags) {
  const report = runDoctor({
    flags: mapCliFlags(rawFlags),
  });
  console.log(formatDoctorReport(report));
  return report.ok ? 0 : 1;
}

function handleValidate(positionals, rawFlags) {
  const [, kind, payloadPath] = positionals;
  const validateScriptPath = path.join(__dirname, "..", PY_DIR, "validate.py");
  const projectRoot = process.cwd();

  if (kind === "smoke") {
    const args = [validateScriptPath, "smoke"];
    if (rawFlags["candidate-path"] && rawFlags["candidate-path"] !== true) {
      args.push("--candidate-path", rawFlags["candidate-path"]);
    }
    if (rawFlags["resolved-path"] && rawFlags["resolved-path"] !== true) {
      args.push("--resolved-path", rawFlags["resolved-path"]);
    }
    if (rawFlags["artifacts-dir"] && rawFlags["artifacts-dir"] !== true) {
      args.push("--artifacts-dir", rawFlags["artifacts-dir"]);
    }
    return runPythonScript(args, { projectRoot });
  }

  if (!kind || !payloadPath) {
    console.error("Usage: neo-cast validate <candidate|recipe|model-recipe|dataset|metadata|task-spec|research-trace|user-corrections> <payload.json> [--schema /path/to/schema.json]");
    return 1;
  }

  const args = [validateScriptPath, kind, payloadPath];
  if (rawFlags.schema && rawFlags.schema !== true) {
    args.push("--schema", rawFlags.schema);
  }
  return runPythonScript(args, { projectRoot });
}

async function handleRunner(positionals, rawFlags) {
  const [, subcommand] = positionals;
  const runnerScriptPath = path.join(__dirname, "..", PY_DIR, "runner.py");
  const projectRoot = process.cwd();

  if (!subcommand || !["init", "run", "ref-test", "blind-test", "status"].includes(subcommand)) {
    console.error("Usage: neo-cast runner <init|run|ref-test|blind-test|status> [flags]");
    return 1;
  }

  const args = [runnerScriptPath, subcommand];
  if (subcommand === "init" && rawFlags.force) {
    args.push("--force");
  }
  if (subcommand === "run") {
    if (!rawFlags.description || rawFlags.description === true) {
      console.error("Usage: neo-cast runner run --description \"experiment summary\" [--skip-smoke]");
      return 1;
    }
    args.push("--description", rawFlags.description);
    if (rawFlags["skip-smoke"]) {
      args.push("--skip-smoke");
    }

    const statusPrefix = "RUN";
    const completeLabel = " done";
    const abortedLabel = " failed";
    const trainLabel = "TRN";
    const startText = `${statusPrefix}:${trainLabel}`;
    const pulse = startCompanionPulse(startText, { frames: ["|", "/", "-", "\\"] });
    const paths = getProjectPaths(projectRoot);
    let recipeVersion = null;
    if (fs.existsSync(paths.currentCandidatePath)) {
      try {
        const candidate = loadJsonFile(paths.currentCandidatePath);
        recipeVersion = registerRecipeLineage(projectRoot, candidate, paths.currentCandidatePath, {
          source: "runner",
          taskContext: loadDesignTaskContext(projectRoot),
        });
        console.log(`recipe_version=${recipeVersion.version_id}`);
      } catch (error) {
        console.error(`[neo-cast] failed to register recipe version: ${error.message}`);
      }
    }
    let exitCode = 1;
    try {
      exitCode = await runPythonScript(args, {
        projectRoot,
        onStdout: () => {
          pulse.onOutput();
        },
        onStderr: () => {
          pulse.onOutput();
        },
      });
    } finally {
      pulse.stop(exitCode === 0
        ? `${statusPrefix}:${trainLabel}${completeLabel}`
        : `${statusPrefix}:${trainLabel}${abortedLabel}`);
    }
    if (exitCode <= 1) {
      const latestRow = getLatestSessionRow(projectRoot);
      if (latestRow && latestRow.run_id) {
        const experimentVersion = registerExperimentLineage(projectRoot, latestRow, {
          parentRefs: [recipeVersion].filter(Boolean),
        });
        const releaseVersion = registerReleaseLineage(projectRoot, latestRow, {
          parentRefs: [experimentVersion].filter(Boolean),
        });
        console.log(`experiment_version=${experimentVersion.version_id}`);
        console.log(`release_version=${releaseVersion.version_id}`);
      }
    }
    return exitCode;
  }
  if ((subcommand === "ref-test" || subcommand === "blind-test") && rawFlags["run-id"] && rawFlags["run-id"] !== true) {
    args.push("--run-id", rawFlags["run-id"]);
  }

  const exitCode = await runPythonScript(args, { projectRoot });
  if (exitCode === 0 && (subcommand === "ref-test" || subcommand === "blind-test")) {
    const targetRunId = rawFlags["run-id"] && rawFlags["run-id"] !== true
      ? String(rawFlags["run-id"])
      : getBestSessionRow(projectRoot)?.run_id;
    if (targetRunId) {
      const experimentRef = getLatestVersionRef(projectRoot, "experiment", targetRunId);
      const releaseVersion = registerReleaseLineage(projectRoot, { run_id: targetRunId }, {
        releaseType: subcommand,
        parentRefs: [experimentRef].filter(Boolean),
      });
      console.log(`release_version=${releaseVersion.version_id}`);
    }
  }
  return exitCode;
}

function handleConfigInit() {
  const filePath = ensureUserConfigFile();
  console.log(`Created config file: ${filePath}`);
  return 0;
}

function handleConfigShow(rawFlags) {
  const { resolved, validationErrors, paths } = resolveConfig({
    flags: mapCliFlags(rawFlags),
  });

  const publicView = buildPublicConfigView(resolved);
  const output = {
    ...publicView,
    paths,
    validation_errors: validationErrors,
  };
  console.log(JSON.stringify(output, null, 2));
  return validationErrors.length === 0 ? 0 : 1;
}

function handleInitRuntime(rawFlags) {
  const projectRoot = process.cwd();
  const exitCode = initRuntime(projectRoot, {
    skipInstall: Boolean(rawFlags["skip-install"]),
  });
  if (exitCode === 0) {
    const paths = getRuntimePaths(projectRoot);
    console.log(`runtime_ready=${paths.pythonPath}`);
  }
  return exitCode;
}

async function handlePrepareData(rawFlags) {
  for (const flag of ["known-future-covariates", "static-covariates", "known-future-source", "known-future-available"]) {
    if (rawFlags[flag]) {
      console.error(`UNSUPPORTED_COVARIATE: --${flag} is unavailable; use --target-cols and --observed-past-covariates.`);
      return 1;
    }
  }
  const projectRoot = process.cwd();
  const source = rawFlags.source || rawFlags["source-csv"];
  if (!source || source === true) {
    console.error("Usage: neo-cast prepare-data --source /path/to/ETTh1.csv [--force]");
    return 1;
  }

  const prepareScriptPath = path.join(__dirname, "..", PY_DIR, "prepare_tsf.py");
  const args = [prepareScriptPath, "--materialize-visible", "--source-csv", source];
  const passthroughFlags = [
    ["task-id", "--task-id"],
    ["dataset-preset", "--dataset-preset"],
    ["timestamp-col", "--timestamp-col"],
    ["feature-cols", "--feature-cols"],
    ["target-cols", "--target-cols"],
    ["observed-past-covariates", "--observed-past-covariates"],
    ["known-future-covariates", "--known-future-covariates"],
    ["static-covariates", "--static-covariates"],
    ["known-future-source", "--known-future-source"],
    ["known-future-available", "--known-future-available"],
    ["experiment-scope", "--experiment-scope"],
    ["input-len", "--input-len"],
    ["horizons", "--horizons"],
    ["train-rows", "--train-rows"],
    ["val-rows", "--val-rows"],
    ["ref-test-rows", "--ref-test-rows"],
    ["missing-strategy", "--missing-strategy"],
    ["missing-limit", "--missing-limit"],
    ["frequency", "--frequency"],
    ["irregular-ratio-warn", "--irregular-ratio-warn"],
  ];
  for (const [rawKey, pyFlag] of passthroughFlags) {
    if (rawFlags[rawKey] && rawFlags[rawKey] !== true) {
      args.push(pyFlag, String(rawFlags[rawKey]));
    }
  }
  if (rawFlags.force) {
    args.push("--force");
  }
  if (rawFlags["allow-irregular"]) {
    args.push("--allow-irregular");
  }
  if (rawFlags["reject-irregular"]) {
    args.push("--reject-irregular");
  }
  const exitCode = await runPythonScript(args, { projectRoot });
  if (exitCode === 0) {
    const datasetPath = path.join(projectRoot, ".neo-cast", "dataset_spec.json");
    if (fs.existsSync(datasetPath)) {
      const datasetSpec = loadJsonFile(datasetPath);
      const dataVersion = registerVersion(projectRoot, {
        kind: "data",
        logicalId: datasetSpec.task_id || rawFlags["task-id"] || "dataset",
        artifactPath: datasetPath,
        payload: datasetSpec,
        parentRefs: [getLatestVersionRef(projectRoot, "task", datasetSpec.task_id)].filter(Boolean),
        metadata: {
          schema_version: datasetSpec.schema_version,
          source_csv: path.resolve(String(source)),
          split_strategy: datasetSpec.split_strategy || null,
          horizons: datasetSpec.horizons || null,
          input_len: datasetSpec.input_len || null,
        },
      });
      console.log(`data_version=${dataVersion.version_id}`);
    }
  }
  return exitCode;
}

function parseCsvList(raw, name) {
  if (raw === undefined || raw === null || raw === true) {
    return undefined;
  }
  const items = String(raw).split(",").map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) {
    throw new Error(`${name} must contain at least one value`);
  }
  return items;
}

function buildTaskSpecOverrides(rawFlags) {
  const overrides = {};
  const scalarFlags = [
    ["task-id", "task_id"],
    ["task-type", "task_type"],
    ["domain", "domain"],
    ["target-column", "target_column"],
    ["time-column", "time_column"],
    ["frequency", "frequency"],
    ["history-window", "history_window"],
    ["prediction-horizon", "prediction_horizon"],
    ["interaction-mode", "interaction_mode"],
  ];
  for (const [flagName, fieldName] of scalarFlags) {
    if (rawFlags[flagName] && rawFlags[flagName] !== true) {
      overrides[fieldName] = rawFlags[flagName];
    }
  }
  const metrics = parseCsvList(rawFlags.metrics, "metrics");
  if (metrics) {
    overrides.metrics = metrics;
  }
  const predictionHorizons = parseCsvList(rawFlags["prediction-horizons"], "prediction-horizons");
  if (predictionHorizons) {
    overrides.prediction_horizons = predictionHorizons.map((item) => Number(item));
  }

  const constraints = {};
  if (rawFlags["max-model-params"] && rawFlags["max-model-params"] !== true) {
    constraints.max_model_params = rawFlags["max-model-params"];
  }
  if (rawFlags["max-training-hours"] && rawFlags["max-training-hours"] !== true) {
    constraints.max_training_hours = Number(rawFlags["max-training-hours"]);
  }
  if (rawFlags["prefer-lightweight-model"]) {
    constraints.prefer_lightweight_model = true;
  }
  if (Object.keys(constraints).length > 0) {
    overrides.constraints = constraints;
  }

  const output = {};
  const outputFlags = [
    ["report", "report"],
    ["model-code", "model_code"],
    ["checkpoint", "checkpoint"],
    ["inference-api", "inference_api"],
  ];
  for (const [flagName, fieldName] of outputFlags) {
    if (rawFlags[flagName]) {
      output[fieldName] = true;
    }
  }
  if (Object.keys(output).length > 0) {
    overrides.output = output;
  }
  return overrides;
}

function buildManualTaskSpecPayload(rawFlags, overrides) {
  return normalizeTaskSpec({
    schema_version: "task_spec.v1",
    task_id: overrides.task_id || "tsf_task",
    task_type: overrides.task_type || "time_series_forecasting",
    domain: overrides.domain,
    target_column: overrides.target_column,
    time_column: overrides.time_column,
    frequency: overrides.frequency,
    history_window: overrides.history_window,
    prediction_horizon: overrides.prediction_horizon,
    prediction_horizons: overrides.prediction_horizons,
    metrics: overrides.metrics || parseCsvList(rawFlags.metrics, "metrics"),
    constraints: overrides.constraints || {},
    output: overrides.output || {},
    interaction_mode: overrides.interaction_mode,
  });
}

function handleTaskSpec(positionals, rawFlags) {
  const [, subcommand, payloadPath] = positionals;
  const projectRoot = process.cwd();

  if (!subcommand || !["init", "validate"].includes(subcommand)) {
    console.error("Usage: neo-cast task-spec <init|validate> [flags]");
    return 1;
  }

  try {
    if (subcommand === "init") {
      const overrides = buildTaskSpecOverrides(rawFlags);
      const explicitDatasetPath = rawFlags["from-dataset"] && rawFlags["from-dataset"] !== true
        ? path.resolve(rawFlags["from-dataset"])
        : null;
      const defaultDatasetPath = path.join(projectRoot, ".neo-cast", "dataset_spec.json");
      const datasetPath = explicitDatasetPath || (fs.existsSync(defaultDatasetPath) ? defaultDatasetPath : null);
      const spec = datasetPath
        ? buildTaskSpecFromDatasetSpec(loadJsonFile(datasetPath), overrides)
        : buildManualTaskSpecPayload(rawFlags, overrides);
      const outputPath = rawFlags.output && rawFlags.output !== true
        ? path.resolve(rawFlags.output)
        : defaultTaskSpecPath(projectRoot);
      const writtenPath = writeTaskSpec(spec, outputPath, {
        projectRoot,
        force: Boolean(rawFlags.force),
      });
      const taskVersion = registerVersion(projectRoot, {
        kind: "task",
        logicalId: spec.task_id,
        artifactPath: writtenPath,
        payload: spec,
        metadata: {
          schema_version: spec.schema_version,
          task_type: spec.task_type,
          target_column: spec.target_column,
          prediction_horizons: spec.prediction_horizons,
        },
      });
      console.log(`task_spec_path=${writtenPath}`);
      console.log(`task_id=${spec.task_id}`);
      console.log(`task_version=${taskVersion.version_id}`);
      return 0;
    }

    const selectedPath = payloadPath
      ? path.resolve(payloadPath)
      : defaultTaskSpecPath(projectRoot);
    const spec = normalizeTaskSpec(loadJsonFile(selectedPath));
    console.log("validation_status: valid");
    console.log("schema_kind: task-spec");
    console.log(`task_id: ${spec.task_id}`);
    console.log(`payload_path: ${selectedPath}`);
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

function printCheckpointStatus(state) {
  console.log(`approval_schema=${state.schema_version}`);
  console.log(`current_stage=${state.current_stage}`);
  for (const [stage, checkpoint] of Object.entries(state.checkpoints || {})) {
    console.log(`${stage}=${checkpoint.status}`);
  }
}

function handleCheckpoint(positionals, rawFlags) {
  const [, subcommand, stage] = positionals;
  const projectRoot = process.cwd();
  try {
    if (!subcommand || subcommand === "status") {
      printCheckpointStatus(loadApprovalState(projectRoot));
      return 0;
    }
    if (subcommand === "request") {
      if (!stage) {
        console.error("Usage: neo-cast checkpoint request <stage> --subject .neo-cast/current_candidate.json [--summary ...]");
        return 1;
      }
      const checkpoint = requestCheckpoint({
        projectRoot,
        stage,
        subjectPath: rawFlags.subject && rawFlags.subject !== true ? rawFlags.subject : null,
        summary: rawFlags.summary && rawFlags.summary !== true ? String(rawFlags.summary) : "",
        requestedBy: rawFlags.by && rawFlags.by !== true ? String(rawFlags.by) : "Runtime",
      });
      console.log(`checkpoint_stage=${checkpoint.stage}`);
      console.log(`checkpoint_status=${checkpoint.status}`);
      console.log(`checkpoint_id=${checkpoint.checkpoint_id}`);
      return 0;
    }
    if (subcommand === "approve" || subcommand === "reject") {
      if (!stage) {
        console.error(`Usage: neo-cast checkpoint ${subcommand} <stage> [--note ...] [--by user]`);
        return 1;
      }
      const checkpoint = updateCheckpointStatus({
        projectRoot,
        stage,
        status: subcommand === "approve" ? "approved" : "rejected",
        note: rawFlags.note && rawFlags.note !== true ? String(rawFlags.note) : "",
        by: rawFlags.by && rawFlags.by !== true ? String(rawFlags.by) : "user",
      });
      console.log(`checkpoint_stage=${checkpoint.stage}`);
      console.log(`checkpoint_status=${checkpoint.status}`);
      console.log(`checkpoint_id=${checkpoint.checkpoint_id}`);
      return 0;
    }
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  console.error("Usage: neo-cast checkpoint <status|request|approve|reject> [stage]");
  return 1;
}

function handleCorrection(positionals, rawFlags) {
  const [, subcommand] = positionals;
  const projectRoot = process.cwd();

  try {
    if (subcommand === "add") {
      const correctionText = rawFlags.correction && rawFlags.correction !== true
        ? String(rawFlags.correction)
        : null;
      if (!correctionText || correctionText.trim().length === 0) {
        console.error("--correction is required");
        return 1;
      }
      const { correction, memoryPath } = addUserCorrection(projectRoot, {
        scope: rawFlags.scope && rawFlags.scope !== true ? String(rawFlags.scope) : "general",
        field: rawFlags.field && rawFlags.field !== true ? String(rawFlags.field) : null,
        correction: correctionText,
        applies_to: rawFlags["applies-to"] && rawFlags["applies-to"] !== true ? String(rawFlags["applies-to"]) : null,
        created_by: rawFlags.by && rawFlags.by !== true ? String(rawFlags.by) : "user",
      });
      console.log(`correction_id=${correction.correction_id}`);
      console.log(`correction_status=${correction.status}`);
      console.log(`correction_scope=${correction.scope}`);
      if (correction.field) {
        console.log(`correction_field=${correction.field}`);
      }
      console.log(`correction_memory_path=${memoryPath}`);
      return 0;
    }

    if (!subcommand || subcommand === "list") {
      const showAll = Boolean(rawFlags.all);
      const corrections = loadUserCorrections(projectRoot, { status: showAll ? "all" : "active" });
      console.log(`correction_memory_path=${defaultCorrectionMemoryPath(projectRoot)}`);
      console.log(`correction_count=${corrections.length}`);
      for (const item of corrections) {
        const field = item.field ? ` field=${item.field}` : "";
        const appliesTo = item.applies_to ? ` applies_to=${item.applies_to}` : "";
        console.log(`${item.correction_id} [${item.status}] ${item.scope}${field}${appliesTo}: ${item.correction}`);
      }
      return 0;
    }
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  console.error("Usage: neo-cast correction <add|list> [--correction ...] [--field column] [--scope data_schema]");
  return 1;
}

async function handleDesign(positionals, rawFlags) {
  const projectRoot = process.cwd();
  const rawRequirement = (rawFlags.requirement && rawFlags.requirement !== true)
    ? String(rawFlags.requirement)
    : positionals.slice(1).join(" ").trim();
  if (!rawRequirement) {
    console.error("Usage: neo-cast design --requirement \"small transformer for ETTh1\" [--max-candidates 3]");
    return 1;
  }
  const mode = rawFlags.mode && rawFlags.mode !== true ? String(rawFlags.mode) : "socratic";
  if (!["socratic", "companion"].includes(mode)) {
    console.error("--mode must be one of: socratic, companion");
    return 1;
  }

  const maxCandidates = Number(rawFlags["max-candidates"] || 1);
  if (!Number.isFinite(maxCandidates) || maxCandidates < 1) {
    console.error("--max-candidates must be a positive integer");
    return 1;
  }
  const isAutonomous = Boolean(rawFlags.autonomous);
  const mockLlm = isMockLlmEnabled({ mockLlm: rawFlags["mock-llm"] });

  const configResult = resolveConfig({
    projectRoot,
    flags: mapCliFlags(rawFlags),
  });
  if (configResult.validationErrors.length > 0 && !mockLlm) {
    console.error(`Config errors: ${configResult.validationErrors.join(" | ")}`);
    return 1;
  }

  if (!runtimeReady(projectRoot)) {
    const paths = getRuntimePaths(projectRoot);
    console.error(`Runtime not initialized. Run: neo-cast init-runtime`);
    console.error(`Expected python: ${paths.pythonPath}`);
    return 1;
  }

  await ensureRunnerInitialized(projectRoot);
  let requirementBundle;
  if (mode === "socratic") {
    requirementBundle = await collectSocraticRequirement(rawRequirement, rawFlags);
    if (requirementBundle.cancelled) {
      console.error("Design cancelled by user.");
      return 1;
    }
  } else {
    requirementBundle = buildCompanionRequirement(rawRequirement, rawFlags);
    printCompanionHeader(rawRequirement, isAutonomous ? "autonomous" : maxCandidates);
  }
  printRequirementSummary(mode, requirementBundle.summary);

  let history = loadResults(projectRoot);
  const taskContext = loadDesignTaskContext(projectRoot);

  if (isAutonomous) {
    const { parseTimeBudget, runAutonomousLoop } = require("./loop");
    const maxNoImprove = Number(rawFlags["max-no-improve"] || 7);
    if (!Number.isFinite(maxNoImprove) || maxNoImprove < 1) {
      console.error("--max-no-improve must be a positive integer");
      return 1;
    }
    const timeBudgetMs = parseTimeBudget(rawFlags["time-budget"]);
    const bestRow = await runAutonomousLoop(requirementBundle, configResult.resolved, {
      projectRoot,
      taskContext,
      timeBudgetMs,
      maxNoImprove,
      maxCandidates: Infinity,
      mockLlm,
      useReflection: Boolean(rawFlags["use-reflection"]),
      useMutation: Boolean(rawFlags["use-mutation"]),
      skipSmoke: Boolean(rawFlags["skip-smoke"]),
      onRoundComplete: mode === "companion" ? (_attempt, row) => printCompanionResult(row, _attempt) : null,
    });
    const paths = getProjectPaths(projectRoot);
    if (mode === "companion") {
      printCompanionFinalSummary(bestRow);
    } else {
      printFinalSummary(bestRow);
    }
    if (bestRow && bestRow.run_id) {
      const experimentRef = getLatestVersionRef(projectRoot, "experiment", bestRow.run_id)
        || registerExperimentLineage(projectRoot, bestRow);
      const releaseRef = getLatestVersionRef(projectRoot, "release", bestRow.run_id)
        || registerReleaseLineage(projectRoot, bestRow, {
          parentRefs: [experimentRef].filter(Boolean),
        });
      console.log(`release_version=${releaseRef.version_id}`);
    }
    console.log(`results_path=${paths.resultsPath}`);
    return 0;
  }

  let lastExitCode = 0;
  let hadHardFailure = false;
  let stopRequested = false;
  let previousRow = null;
  let duplicateStreak = 0;

  // Companion mode: watch stdin for "stop" between rounds
  const stopWatcher = mode === "companion"
    ? watchForStop(() => { stopRequested = true; })
    : () => {};

  for (let attempt = 1; attempt <= maxCandidates; attempt += 1) {
    if (stopRequested) break;

    const labels = {
      roundPrefix: "R",
      generating: "GEN",
      reflection: "REF",
      mutation: "MUT",
      training: "TRN",
      complete: " done",
      aborted: " failed",
    };

    let result;
    const roundLabelPrefix = `${labels.roundPrefix}${attempt}`;
    const formatPulseLabel = (label) => `${roundLabelPrefix}:${label}`;
    const runWithPulse = async (label, factory) => {
      const pulse = startCompanionPulse(formatPulseLabel(label), { frames: ["|", "/", "-", "\\"] });
      let hasFailed = false;
      try {
        return await factory();
      } catch (error) {
        hasFailed = true;
        throw error;
      } finally {
        pulse.stop(`${formatPulseLabel(label)}${hasFailed ? labels.aborted : labels.complete}`);
      }
    };

    const runCandidateGeneration = async () => runWithPulse(
      labels.generating,
      () => generateCandidate(
        requirementBundle.requirementText,
        history,
        configResult.resolved,
        { attempt, mockLlm, taskContext }
      )
    );

    if (attempt > 1 && rawFlags["use-reflection"]) {
      const { reflectAndPropose } = require("./reflect");
      result = await runWithPulse(labels.reflection, async () => {
        const reflected = await reflectAndPropose(
          requirementBundle.requirementText,
          history,
          previousRow,
          configResult.resolved,
          {
            projectRoot,
            mockLlm,
            taskContext,
            attempt,
          }
        );

        if (reflected) {
          return reflected;
        }
        if (!rawFlags["use-mutation"]) {
          return runCandidateGeneration();
        }

        return await runWithPulse(labels.mutation, async () => {
          try {
            const candidate = await mutateCandidate(projectRoot, {
              metricsPath: latestValMetricsPath(projectRoot, previousRow),
              index: attempt - 1,
              statePath: getProjectPaths(projectRoot).runnerStatePath,
            });
            return { candidate, source: "mutation_policy" };
          } catch (error) {
            console.error(`[neo-cast] mutation also failed: ${error.message}`);
            return runCandidateGeneration();
          }
        });
      });
    } else if (attempt > 1 && rawFlags["use-mutation"]) {
      result = await runWithPulse(labels.mutation, async () => {
        try {
          const candidate = await mutateCandidate(projectRoot, {
            metricsPath: latestValMetricsPath(projectRoot, previousRow),
            index: attempt - 1,
            statePath: getProjectPaths(projectRoot).runnerStatePath,
          });
          return { candidate, source: "mutation_policy" };
        } catch (error) {
          console.error(`[neo-cast] mutation failed: ${error.message}`);
          return runCandidateGeneration();
        }
      });
    } else {
      result = await runCandidateGeneration();
    }

    const candidate = result.candidate;
    if (mode === "companion") {
      printCompanionAttempt(attempt, candidate, result.source);
    }

    const candidatePath = writeCurrentCandidate(projectRoot, candidate);
    console.log(`${roundLabelPrefix}:CAN=ready`);
    console.log(`${roundLabelPrefix}:SRC=${result.source}`);
    console.log(`${roundLabelPrefix}:PATH=${candidatePath}`);
    console.log(`${roundLabelPrefix}:FAM=${describeCandidateFamily(candidate)}`);
    console.log(`${roundLabelPrefix}:ID=${describeCandidateId(candidate)}`);
    console.log(`design_attempt=${attempt}`);
    console.log(`candidate_source=${result.source}`);
    const recipeVersion = registerRecipeLineage(projectRoot, candidate, candidatePath, {
      attempt,
      source: result.source,
      taskContext,
    });
    console.log(`recipe_version=${recipeVersion.version_id}`);
    const designLog = appendModelDesignRecord(projectRoot, candidate, {
      attempt,
      source: result.source,
      candidatePath,
      recipeVersionId: recipeVersion.version_id,
    });
    console.log(`model_designs_path=${designLog.markdownPath}`);

    if (rawFlags["require-approval"]) {
      const checkpoint = requestCheckpoint({
        projectRoot,
        stage: "model_design",
        subjectPath: candidatePath,
        summary: candidate.hypothesis || describeCandidateFamily(candidate),
        requestedBy: "ModelDesigner Agent",
      });
      console.log(`checkpoint_stage=${checkpoint.stage}`);
      console.log(`checkpoint_status=${checkpoint.status}`);
      console.log(`checkpoint_id=${checkpoint.checkpoint_id}`);
      console.log("checkpoint_approve_command=neo-cast checkpoint approve model_design");
      console.log(`checkpoint_resume_command=neo-cast runner run --description ${JSON.stringify(candidate.hypothesis || describeCandidateFamily(candidate))}`);
      return 2;
    }

    const description = candidate.hypothesis || `${candidate.model_family} attempt ${attempt}`;
    const pulse = startCompanionPulse(formatPulseLabel(labels.training), { frames: ["|", "/", "-", "\\"] });

    let roundExitCode = 0;
    let runnerOutput = "";
    let duplicateExperiment = false;
    try {
      roundExitCode = await runRunner(projectRoot, description, {
        skipSmoke: Boolean(rawFlags["skip-smoke"]),
        onStdout: (text) => {
          if (pulse) pulse.onOutput();
          runnerOutput += text;
          const lines = runnerOutput.split("\n");
          runnerOutput = lines.pop();
          for (const line of lines) {
            try {
              if (JSON.parse(line).event === "candidate_duplicate") duplicateExperiment = true;
            } catch { /* Runner also emits human-readable progress. */ }
          }
        },
        onStderr: () => {
          if (pulse) pulse.onOutput();
        },
      });
      lastExitCode = roundExitCode;
    } finally {
      if (pulse) {
        pulse.stop(roundExitCode === 0
          ? `${formatPulseLabel(labels.training)}${labels.complete}`
          : `${formatPulseLabel(labels.training)}${labels.aborted}`);
      }
    }
    if (duplicateExperiment && roundExitCode === 0) {
      duplicateStreak += 1;
      console.log(`design_duplicate_streak=${duplicateStreak}`);
      if (duplicateStreak >= 3) {
        console.log("design_stop_reason=no_new_candidate");
        break;
      }
      continue;
    }
    duplicateStreak = 0;
    history = loadResults(projectRoot);
    previousRow = getLatestSessionRow(projectRoot);
    if (previousRow && previousRow.run_id) {
      const experimentVersion = registerExperimentLineage(projectRoot, previousRow, {
        parentRefs: [recipeVersion],
      });
      const releaseVersion = registerReleaseLineage(projectRoot, previousRow, {
        parentRefs: [experimentVersion],
      });
      console.log(`experiment_version=${experimentVersion.version_id}`);
      console.log(`release_version=${releaseVersion.version_id}`);
    }

    if (mode === "companion") {
      printCompanionResult(previousRow, attempt);
    }

    if (lastExitCode > 1) {
      hadHardFailure = true;
      break;
    }

    if (lastExitCode === 0 && rawFlags["stop-on-keep"]) {
      break;
    }
  }

  stopWatcher(); // close stdin watcher if open

  const paths = getProjectPaths(projectRoot);
  const bestRow = getBestSessionRow(projectRoot);
  if (mode === "companion") {
    printCompanionFinalSummary(bestRow);
  } else {
    printFinalSummary(bestRow);
  }
  if (bestRow && bestRow.run_id) {
    console.log(`design_best_run_id=${bestRow.run_id}`);
  }
  console.log(`results_path=${paths.resultsPath}`);
  return hadHardFailure ? lastExitCode : 0;
}

async function runCli(argv = process.argv.slice(2)) {
  const { positionals, flags } = parseArgs(argv);

  if (flags.version) {
    console.log(getPackageVersion());
    return 0;
  }

  if (flags.help || positionals.length === 0 || positionals[0] === "help") {
    printHelp();
    return 0;
  }

  const [command, subcommand] = positionals;

  if (command === "doctor") {
    return handleDoctor(flags);
  }
  if (command === "validate") {
    return handleValidate(positionals, flags);
  }
  if (command === "init-runtime") {
    return handleInitRuntime(flags);
  }
  if (command === "task-spec") {
    return handleTaskSpec(positionals, flags);
  }
  if (command === "checkpoint") {
    return handleCheckpoint(positionals, flags);
  }
  if (command === "correction") {
    return handleCorrection(positionals, flags);
  }
  if (command === "prepare-data") {
    return handlePrepareData(flags);
  }
  if (command === "runner") {
    return handleRunner(positionals, flags);
  }
  if (command === "design") {
    return handleDesign(positionals, flags);
  }
  if (command === "config" && subcommand === "init") {
    return handleConfigInit();
  }
  if (command === "config" && subcommand === "show") {
    return handleConfigShow(flags);
  }

  console.error(`Unknown command: ${positionals.join(" ")}`);
  printHelp();
  return 1;
}

module.exports = {
  getPackageVersion,
  handleConfigInit,
  handleConfigShow,
  handleCheckpoint,
  handleCorrection,
  handleDesign,
  handleDoctor,
  handleInitRuntime,
  handlePrepareData,
  handleRunner,
  handleTaskSpec,
  handleValidate,
  parseArgs,
  printHelp,
  runCli,
  runPythonScript,
};
