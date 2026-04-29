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
  const logs = [];

  const stubs = {
    "./config": {
      buildPublicConfigView: () => ({}),
      ensureUserConfigFile: () => "",
      resolveConfig: () => ({ resolved: {}, validationErrors: [] }),
    },
    "./doctor": {
      formatDoctorReport: () => "",
      runDoctor: () => ({ ok: true }),
    },
    "./llm": {
      generateCandidate: async (_requirement, _history, _config, options) => {
        generatedAttempts.push(options.attempt);
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
    "./python-bridge": {
      ensureRunnerInitialized: async () => {},
      getProjectPaths: () => ({ resultsPath: "/tmp/results.tsv" }),
      loadResults: () => [],
      mutateCandidate: async () => {
        throw new Error("mutation not used");
      },
      runPythonCommand: async () => ({ status: 0 }),
      runRunner: async (_projectRoot, description) => {
        runDescriptions.push(description);
        return state.runnerExitCode ?? 0;
      },
      writeCurrentCandidate: (_projectRoot, candidate) => `/tmp/${candidate.candidate_id}.json`,
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
    logs,
    restore() {
      console.log = originalLog;
      Module._load = originalLoad;
      delete require.cache[CLI_PATH];
    },
    runDescriptions,
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
