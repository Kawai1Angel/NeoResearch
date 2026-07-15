"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.js");

function loadCliWithStubs(state = {}) {
  const originalLoad = Module._load;
  const runDescriptions = [];
  const generatedAttempts = [];
  const generatedTaskContexts = [];
  const reflectedAttempts = [];
  const reflectedTaskContexts = [];
  const mutationAttempts = [];
  const autonomousOptions = [];
  const checkpointRequests = [];
  const publishedReports = [];
  const versionCalls = [];
  const designRecords = [];
  const logs = [];

  const stubs = {
    "./config": {
      buildPublicConfigView: () => ({}),
      ensureUserConfigFile: () => "",
      resolveConfig: () => state.configResult || ({ resolved: {}, validationErrors: [] }),
    },
    "./checkpoint": {
      requestCheckpoint: (options) => {
        checkpointRequests.push(options);
        return {
          checkpoint_id: "checkpoint_model_design_001",
          stage: options.stage,
          status: "pending",
          subject_hash: "abc123",
        };
      },
    },
    "./corrections": {
      loadUserCorrections: () => state.userCorrections || [],
    },
    "./doctor": {
      formatDoctorReport: () => "",
      runDoctor: () => ({ ok: true }),
    },
    "./llm": {
      generateCandidate: async (_requirement, _history, _config, options) => {
        generatedAttempts.push(options.attempt);
        generatedTaskContexts.push(options.taskContext);
        return {
          source: "mock",
          candidate: {
            candidate_id: `candidate_${options.attempt}`,
            model_family: "mock_family",
            hypothesis: `candidate ${options.attempt}`,
          },
        };
      },
    },
    "./model-design-log": {
      appendModelDesignRecord: (_projectRoot, candidate, options) => {
        designRecords.push({ candidate, options });
        return {
          markdownPath: "/tmp/model_designs.md",
          jsonlPath: "/tmp/model_designs.jsonl",
          record: {},
        };
      },
    },
    "./loop": {
      parseTimeBudget: (raw) => (raw === "30m" ? 1_800_000 : null),
      runAutonomousLoop: async (_requirementBundle, _resolvedConfig, options) => {
        autonomousOptions.push(options);
        return { run_id: "run_auto", val_avg_mse: "0.8765" };
      },
    },
    "./modes/socratic": {
      collectSocraticRequirement: async (requirement) => ({
        requirementText: requirement,
        summary: requirement,
      }),
    },
    "./modes/companion": {
      buildCompanionRequirement: (requirement) => ({
        requirementText: requirement,
        summary: requirement,
      }),
      printCompanionAttempt: () => {},
      printCompanionFinalSummary: () => {},
      printCompanionHeader: () => {},
      printCompanionResult: () => {},
      watchForStop: () => () => {},
    },
    "./output": {
      printFinalSummary: () => {},
      printRequirementSummary: () => {},
    },
    "./session": {
      getBestSessionRow: () => ({ run_id: "run_1" }),
      getLatestSessionRow: () => ({ run_id: `run_${runDescriptions.length}` }),
    },
    "./report-output": {
      publishReleaseReport: (_projectRoot, options) => {
        publishedReports.push(options);
        return {
          copied: true,
          manifestPath: `/tmp/reports/${options.versionId}/release_manifest.json`,
          reportPath: `/tmp/reports/${options.versionId}/eval_report.md`,
        };
      },
    },
    "./versioning": {
      getLatestVersionRef: (_projectRoot, kind) => ({
        kind,
        logical_id: `latest_${kind}`,
        version_id: `${kind}_latest_v1`,
      }),
      getNextVersionId: (_projectRoot, kind, logicalId) => `${kind}_${logicalId}_v1`,
      registerVersion: (_projectRoot, options) => {
        versionCalls.push(options);
        return {
          kind: options.kind,
          logical_id: options.logicalId,
          version_id: `${options.kind}_${options.logicalId}_v1`,
        };
      },
    },
    "./python-bridge": {
      ensureRunnerInitialized: async () => {},
      getProjectPaths: () => ({ resultsPath: "/tmp/results.tsv" }),
      loadResults: () => [],
      mutateCandidate: async () => {
        mutationAttempts.push(mutationAttempts.length + 1);
        if (state.mutationCandidate) return state.mutationCandidate;
        throw new Error("mutation not used");
      },
      runPythonCommand: async () => ({ status: 0 }),
      runRunner: async (_projectRoot, description) => {
        runDescriptions.push(description);
        return state.runnerExitCode ?? 0;
      },
      writeCurrentCandidate: (_projectRoot, candidate) => `/tmp/${candidate.candidate_id}.json`,
    },
    "./reflect": {
      reflectAndPropose: async (_requirement, _history, _previousRow, _config, options) => {
        reflectedAttempts.push(options.attempt);
        reflectedTaskContexts.push(options.taskContext);
        if (Object.prototype.hasOwnProperty.call(state, "reflectionResult")) return state.reflectionResult;
        return {
          source: "llm_reflection",
          candidate: {
            candidate_id: `reflection_${options.attempt}`,
            model_family: "reflection_family",
            hypothesis: `reflection ${options.attempt}`,
          },
        };
      },
    },
    "./runtime": {
      getRuntimePaths: () => ({ pythonPath: "/tmp/python" }),
      initRuntime: () => 0,
      runtimeReady: () => true,
    },
  };

  Module._load = function load(request, parent, isMain) {
    if (parent?.filename === CLI_PATH && stubs[request]) {
      return stubs[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args.join(" "));
  };

  delete require.cache[CLI_PATH];
  const cli = require(CLI_PATH);

  return {
    cli,
    generatedAttempts,
    generatedTaskContexts,
    autonomousOptions,
    checkpointRequests,
    designRecords,
    logs,
    mutationAttempts,
    publishedReports,
    reflectedAttempts,
    reflectedTaskContexts,
    restore() {
      console.log = originalLog;
      Module._load = originalLoad;
      delete require.cache[CLI_PATH];
    },
    runDescriptions,
    versionCalls,
  };
}

test("design honors max-candidates by default after a kept candidate", async () => {
  const harness = loadCliWithStubs();
  try {
    const exitCode = await harness.cli.runCli([
      "design",
      "--requirement",
      "explore three variants",
      "--mode",
      "companion",
      "--max-candidates",
      "3",
      "--mock-llm",
      "--skip-smoke",
    ]);

    assert.equal(exitCode, 0);
    assert.deepEqual(harness.generatedAttempts, [1, 2, 3]);
    assert.equal(harness.logs.filter((line) => line.startsWith("design_attempt=")).length, 3);
  } finally {
    harness.restore();
  }
});

test("design injects user corrections into model design task context", async () => {
  const harness = loadCliWithStubs({
    userCorrections: [
      {
        schema_version: "user_correction.v1",
        scope: "data_schema",
        field: "temperature_forecast",
        correction: "available only at prediction time",
        status: "active",
      },
    ],
  });
  try {
    const exitCode = await harness.cli.runCli([
      "design",
      "--requirement",
      "respect user feedback memory",
      "--mode",
      "companion",
      "--max-candidates",
      "1",
      "--mock-llm",
      "--skip-smoke",
    ]);

    assert.equal(exitCode, 0);
    assert.equal(harness.generatedTaskContexts.length, 1);
    assert.deepEqual(harness.generatedTaskContexts[0].user_corrections, [
      {
        schema_version: "user_correction.v1",
        scope: "data_schema",
        field: "temperature_forecast",
        correction: "available only at prediction time",
        status: "active",
      },
    ]);
  } finally {
    harness.restore();
  }
});

test("design delegates autonomous mode to the autonomous loop with budgets", async () => {
  const harness = loadCliWithStubs();
  try {
    const exitCode = await harness.cli.runCli([
      "design",
      "--requirement",
      "run until plateau",
      "--mode",
      "companion",
      "--autonomous",
      "--time-budget",
      "30m",
      "--max-no-improve",
      "4",
      "--mock-llm",
      "--use-reflection",
      "--use-mutation",
      "--skip-smoke",
    ]);

    assert.equal(exitCode, 0);
    assert.equal(harness.generatedAttempts.length, 0);
    assert.equal(harness.autonomousOptions.length, 1);
    assert.equal(harness.autonomousOptions[0].timeBudgetMs, 1_800_000);
    assert.equal(harness.autonomousOptions[0].maxNoImprove, 4);
    assert.equal(harness.autonomousOptions[0].maxCandidates, Infinity);
    assert.equal(harness.autonomousOptions[0].mockLlm, true);
    assert.equal(harness.autonomousOptions[0].useReflection, true);
    assert.equal(harness.autonomousOptions[0].useMutation, true);
    assert.equal(harness.autonomousOptions[0].skipSmoke, true);
  } finally {
    harness.restore();
  }
});

test("design defaults autonomous max no-improve budget to 5", async () => {
  const harness = loadCliWithStubs();
  try {
    const exitCode = await harness.cli.runCli([
      "design",
      "--requirement",
      "run until default plateau",
      "--mode",
      "companion",
      "--autonomous",
      "--mock-llm",
    ]);

    assert.equal(exitCode, 0);
    assert.equal(harness.autonomousOptions.length, 1);
    assert.equal(harness.autonomousOptions[0].maxNoImprove, 5);
  } finally {
    harness.restore();
  }
});

test("design treats NEO_CAST_USE_MOCK as mock mode for config validation and generation", async () => {
  const previous = process.env.NEO_CAST_USE_MOCK;
  process.env.NEO_CAST_USE_MOCK = "1";
  const harness = loadCliWithStubs({
    configResult: {
      resolved: {},
      validationErrors: ["llm.base_url is required for openai-compatible provider."],
    },
  });
  try {
    const exitCode = await harness.cli.runCli([
      "design",
      "--requirement",
      "offline alpha demo",
      "--mode",
      "companion",
      "--max-candidates",
      "1",
      "--skip-smoke",
    ]);

    assert.equal(exitCode, 0);
    assert.deepEqual(harness.generatedAttempts, [1]);
  } finally {
    if (previous === undefined) {
      delete process.env.NEO_CAST_USE_MOCK;
    } else {
      process.env.NEO_CAST_USE_MOCK = previous;
    }
    harness.restore();
  }
});

test("design can stop early on keep when requested", async () => {
  const harness = loadCliWithStubs();
  try {
    const exitCode = await harness.cli.runCli([
      "design",
      "--requirement",
      "stop after first kept variant",
      "--mode",
      "companion",
      "--max-candidates",
      "3",
      "--mock-llm",
      "--skip-smoke",
      "--stop-on-keep",
    ]);

    assert.equal(exitCode, 0);
    assert.deepEqual(harness.generatedAttempts, [1]);
    assert.equal(harness.logs.filter((line) => line.startsWith("design_attempt=")).length, 1);
  } finally {
    harness.restore();
  }
});

test("design uses reflection after the first attempt when requested", async () => {
  const harness = loadCliWithStubs();
  try {
    const exitCode = await harness.cli.runCli([
      "design",
      "--requirement",
      "reflect on h720 failures",
      "--mode",
      "companion",
      "--max-candidates",
      "2",
      "--mock-llm",
      "--use-reflection",
      "--skip-smoke",
    ]);

    assert.equal(exitCode, 0);
    assert.deepEqual(harness.generatedAttempts, [1]);
    assert.deepEqual(harness.reflectedAttempts, [2]);
    assert.match(harness.logs.join("\n"), /candidate_source=llm_reflection/);
  } finally {
    harness.restore();
  }
});

test("design records recipe, experiment, and release versions for lineage", async () => {
  const harness = loadCliWithStubs();
  try {
    const exitCode = await harness.cli.runCli([
      "design",
      "--requirement",
      "version this candidate",
      "--mode",
      "companion",
      "--max-candidates",
      "1",
      "--mock-llm",
      "--skip-smoke",
    ]);

    assert.equal(exitCode, 0);
    assert.deepEqual(harness.versionCalls.map((call) => call.kind), [
      "recipe",
      "experiment",
      "release",
    ]);
    assert.equal(harness.versionCalls[0].logicalId, "candidate_1");
    assert.equal(harness.versionCalls[1].logicalId, "run_1");
    assert.equal(harness.versionCalls[2].logicalId, "run_1");
    assert.equal(harness.designRecords.length, 1);
    assert.equal(harness.designRecords[0].candidate.candidate_id, "candidate_1");
    assert.equal(harness.designRecords[0].options.recipeVersionId, "recipe_candidate_1_v1");
    assert.equal(harness.publishedReports.length, 1);
    assert.equal(harness.publishedReports[0].versionId, "release_run_1_v1");
    assert.match(harness.logs.join("\n"), /recipe_version=recipe_candidate_1_v/);
    assert.match(harness.logs.join("\n"), /model_designs_path=\/tmp\/model_designs\.md/);
  } finally {
    harness.restore();
  }
});

test("design falls back from reflection to mutation when both flags are set", async () => {
  const harness = loadCliWithStubs({
    reflectionResult: null,
    mutationCandidate: {
      candidate_id: "mutation_2",
      model_family: "mutation_family",
      hypothesis: "mutation fallback",
    },
  });
  try {
    const exitCode = await harness.cli.runCli([
      "design",
      "--requirement",
      "fallback chain",
      "--mode",
      "companion",
      "--max-candidates",
      "2",
      "--mock-llm",
      "--use-reflection",
      "--use-mutation",
      "--skip-smoke",
    ]);

    assert.equal(exitCode, 0);
    assert.deepEqual(harness.generatedAttempts, [1]);
    assert.deepEqual(harness.reflectedAttempts, [2]);
    assert.deepEqual(harness.mutationAttempts, [1]);
    assert.match(harness.logs.join("\n"), /candidate_source=mutation_policy/);
  } finally {
    harness.restore();
  }
});

test("design can pause at a model-design checkpoint before training", async () => {
  const harness = loadCliWithStubs();
  try {
    const exitCode = await harness.cli.runCli([
      "design",
      "--requirement",
      "approval-gated candidate",
      "--mode",
      "companion",
      "--max-candidates",
      "1",
      "--mock-llm",
      "--skip-smoke",
      "--require-approval",
    ]);

    assert.equal(exitCode, 2);
    assert.deepEqual(harness.generatedAttempts, [1]);
    assert.equal(harness.runDescriptions.length, 0);
    assert.equal(harness.checkpointRequests.length, 1);
    assert.equal(harness.checkpointRequests[0].stage, "model_design");
    assert.match(harness.logs.join("\n"), /checkpoint_status=pending/);
    assert.match(harness.logs.join("\n"), /checkpoint_approve_command=neo-cast checkpoint approve model_design/);
  } finally {
    harness.restore();
  }
});
