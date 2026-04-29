"use strict";

const {
  buildPublicConfigView,
  ensureUserConfigFile,
  resolveConfig,
} = require("./config");
const { formatDoctorReport, runDoctor } = require("./doctor");
const { generateCandidate } = require("./llm");
const { collectSocraticRequirement } = require("./modes/socratic");
const {
  buildCompanionRequirement,
  printCompanionAttempt,
  printCompanionFinalSummary,
  printCompanionHeader,
  printCompanionResult,
  watchForStop,
} = require("./modes/companion");
const { printFinalSummary, printRequirementSummary } = require("./output");
const { getBestSessionRow, getLatestSessionRow } = require("./session");
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
  neo-cast validate <candidate|recipe|dataset|metadata> <payload.json> [--schema /path/to/schema.json]
  neo-cast validate smoke [--candidate-path /path/to/candidate.json]
  neo-cast config init
  neo-cast config show
  neo-cast init-runtime [--skip-install]
  neo-cast prepare-data --source /path/to/data.csv [--task-id etth1] [--feature-cols a,b,c]
  neo-cast runner init [--force]
  neo-cast runner run --description "baseline"
  neo-cast runner ref-test [--run-id 20260424-...]
  neo-cast runner blind-test [--run-id 20260424-...]
  neo-cast runner status
  neo-cast design --requirement "small transformer for ETTh1" [--mode socratic|companion] [--max-candidates 3]
                  [--mock-llm] [--use-mutation] [--use-reflection] [--stop-on-keep]
  neo-cast design --requirement "small transformer for ETTh1" --autonomous [--time-budget 2h]
                  [--max-no-improve 8] [--mock-llm] [--use-reflection] [--use-mutation]

Commands:
  doctor         Check python3, uv, API key, and resolved config
  validate       Validate JSON payloads or run the smoke gate
  config init    Create the default user config file if missing
  config show    Print the resolved config with secrets masked
  init-runtime   Create the project-local Python runtime under .neo-cast/runtime/.venv
  prepare-data   Materialize ETTh1 visible/ref-test splits into the dataset cache
  runner         Run the project-local smoke/full/ref-test experiment loop
  design         Generate candidates and run the local design loop

Design flags:
  --use-reflection   After each run, ask the reflection agent to analyze results and propose the next candidate
                     (takes priority over --use-mutation; falls back to mutation on reflection failure)
  --autonomous       Continue iterating until budget, plateau, or crash stopping conditions are met
  --time-budget      Autonomous wall-clock budget, e.g. 2h, 90m, 3600s
  --max-no-improve   Autonomous plateau limit; defaults to 8 consecutive non-improving runs
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
  const specPath = path.join(projectRoot, ".neo-cast", "dataset_spec.json");
  if (!fs.existsSync(specPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(specPath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function describeCandidateId(payload) {
  return payload.candidate_id || payload.recipe_id || "NA";
}

function describeCandidateFamily(payload) {
  if (payload.model_family) return payload.model_family;
  if (payload.recipe_version === "recipe_schema_v1") {
    const embedding = payload.embedding?.type || "unknown_embedding";
    const backbone = payload.backbone?.type || "unknown_backbone";
    return `recipe:${embedding}+${backbone}`;
  }
  return "unknown";
}

function latestValMetricsPath(projectRoot, row) {
  if (!row || !row.run_id || row.run_id.startsWith("crash_") || row.run_id.startsWith("smoke_")) {
    return null;
  }
  const metricsPath = path.join(projectRoot, ".neo-cast", "artifacts", `run_${row.run_id}`, "val_metrics.json");
  return fs.existsSync(metricsPath) ? metricsPath : null;
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
    console.error("Usage: neo-cast validate <candidate|recipe|dataset|metadata> <payload.json> [--schema /path/to/schema.json]");
    return 1;
  }

  const args = [validateScriptPath, kind, payloadPath];
  if (rawFlags.schema && rawFlags.schema !== true) {
    args.push("--schema", rawFlags.schema);
  }
  return runPythonScript(args, { projectRoot });
}

function handleRunner(positionals, rawFlags) {
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
  }
  if ((subcommand === "ref-test" || subcommand === "blind-test") && rawFlags["run-id"] && rawFlags["run-id"] !== true) {
    args.push("--run-id", rawFlags["run-id"]);
  }

  return runPythonScript(args, { projectRoot });
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

function handlePrepareData(rawFlags) {
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
    ["timestamp-col", "--timestamp-col"],
    ["feature-cols", "--feature-cols"],
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
  return runPythonScript(args, { projectRoot });
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

  const configResult = resolveConfig({
    projectRoot,
    flags: mapCliFlags(rawFlags),
  });
  if (configResult.validationErrors.length > 0 && !rawFlags["mock-llm"]) {
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
  const taskContext = loadPreparedDatasetSpec(projectRoot);

  if (isAutonomous) {
    const { parseTimeBudget, runAutonomousLoop } = require("./loop");
    const maxNoImprove = Number(rawFlags["max-no-improve"] || 8);
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
      mockLlm: Boolean(rawFlags["mock-llm"]),
      useReflection: Boolean(rawFlags["use-reflection"]),
      useMutation: Boolean(rawFlags["use-mutation"]),
      skipSmoke: Boolean(rawFlags["skip-smoke"]),
      onRoundComplete: mode === "companion" ? (_attempt, row) => printCompanionResult(row) : null,
    });
    const paths = getProjectPaths(projectRoot);
    if (mode === "companion") {
      printCompanionFinalSummary(bestRow);
    } else {
      printFinalSummary(bestRow);
    }
    console.log(`results_path=${paths.resultsPath}`);
    return 0;
  }

  let lastExitCode = 0;
  let hadHardFailure = false;
  let stopRequested = false;
  let previousRow = null;

  // Companion mode: watch stdin for "stop" between rounds
  const stopWatcher = mode === "companion"
    ? watchForStop(() => { stopRequested = true; })
    : () => {};

  for (let attempt = 1; attempt <= maxCandidates; attempt += 1) {
    if (stopRequested) break;

    let result;
    if (attempt > 1 && rawFlags["use-reflection"]) {
      const { reflectAndPropose } = require("./reflect");
      const reflected = await reflectAndPropose(
        requirementBundle.requirementText,
        history,
        previousRow,
        configResult.resolved,
        {
          projectRoot,
          mockLlm: Boolean(rawFlags["mock-llm"]),
          taskContext,
          attempt,
        }
      );

      if (reflected) {
        result = reflected;
      } else if (rawFlags["use-mutation"]) {
        try {
          const candidate = await mutateCandidate(projectRoot, {
            metricsPath: latestValMetricsPath(projectRoot, previousRow),
            index: attempt - 1,
            statePath: getProjectPaths(projectRoot).runnerStatePath,
          });
          result = { candidate, source: "mutation_policy" };
        } catch (error) {
          console.error(`[neo-cast] mutation also failed: ${error.message}`);
          result = await generateCandidate(
            requirementBundle.requirementText,
            history,
            configResult.resolved,
            { attempt, mockLlm: Boolean(rawFlags["mock-llm"]), taskContext }
          );
        }
      } else {
        result = await generateCandidate(
          requirementBundle.requirementText,
          history,
          configResult.resolved,
          { attempt, mockLlm: Boolean(rawFlags["mock-llm"]), taskContext }
        );
      }
    } else if (attempt > 1 && rawFlags["use-mutation"]) {
      try {
        const candidate = await mutateCandidate(projectRoot, {
          metricsPath: latestValMetricsPath(projectRoot, previousRow),
          index: attempt - 1,
          statePath: getProjectPaths(projectRoot).runnerStatePath,
        });
        result = { candidate, source: "mutation_policy" };
      } catch (error) {
        console.error(`[neo-cast] mutation failed: ${error.message}`);
        result = await generateCandidate(
          requirementBundle.requirementText,
          history,
          configResult.resolved,
          { attempt, mockLlm: Boolean(rawFlags["mock-llm"]), taskContext }
        );
      }
    } else {
      result = await generateCandidate(
        requirementBundle.requirementText,
        history,
        configResult.resolved,
        { attempt, mockLlm: Boolean(rawFlags["mock-llm"]), taskContext }
      );
    }

    const candidate = result.candidate;
    if (mode === "companion") {
      printCompanionAttempt(attempt, candidate, result.source);
    }

    const candidatePath = writeCurrentCandidate(projectRoot, candidate);
    console.log(`design_attempt=${attempt}`);
    console.log(`candidate_source=${result.source}`);
    console.log(`candidate_path=${candidatePath}`);
    console.log(`candidate_family=${describeCandidateFamily(candidate)}`);
    console.log(`candidate_id=${describeCandidateId(candidate)}`);

    const description = candidate.hypothesis || `${candidate.model_family} attempt ${attempt}`;
    lastExitCode = await runRunner(projectRoot, description, {
      skipSmoke: Boolean(rawFlags["skip-smoke"]),
    });
    history = loadResults(projectRoot);
    previousRow = getLatestSessionRow(projectRoot);

    if (mode === "companion") {
      printCompanionResult(previousRow);
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
  if (mode === "companion") {
    printCompanionFinalSummary(getBestSessionRow(projectRoot));
  } else {
    printFinalSummary(getBestSessionRow(projectRoot));
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
  handleDesign,
  handleDoctor,
  handleInitRuntime,
  handlePrepareData,
  handleRunner,
  handleValidate,
  parseArgs,
  printHelp,
  runCli,
  runPythonScript,
};
