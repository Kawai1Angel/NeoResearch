"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { checkStoppingConditions, parseTimeBudget } = require("../src/loop");

test("checkStoppingConditions stops when time budget is exhausted", () => {
  const result = checkStoppingConditions(
    { candidate_counter: 3, no_improve_streak: 2, crash_streak: 0 },
    { timeBudgetMs: 1000, sessionStartMs: Date.now() - 2000, maxNoImprove: 5, maxCandidates: Infinity },
  );

  assert.deepEqual(result, { stop: true, reason: "time_budget_exhausted" });
});

test("checkStoppingConditions stops on no-improve plateau", () => {
  const result = checkStoppingConditions(
    { candidate_counter: 10, no_improve_streak: 5, crash_streak: 0 },
    { timeBudgetMs: null, sessionStartMs: Date.now(), maxNoImprove: 5, maxCandidates: Infinity },
  );

  assert.equal(result.stop, true);
  assert.match(result.reason, /^no_improve_plateau:5_rounds$/);
});

test("checkStoppingConditions stops on crash streak and finite candidate caps", () => {
  assert.deepEqual(
    checkStoppingConditions(
      { candidate_counter: 5, no_improve_streak: 0, crash_streak: 0 },
      { sessionStartMs: Date.now(), maxCandidates: 5 },
    ),
    { stop: true, reason: "max_candidates_reached" },
  );

  assert.deepEqual(
    checkStoppingConditions(
      { candidate_counter: 1, no_improve_streak: 0, crash_streak: 5 },
      { sessionStartMs: Date.now(), maxCandidates: Infinity },
    ),
    { stop: true, reason: "crash_streak_exceeded" },
  );
});

test("parseTimeBudget accepts h/m/min/s values", () => {
  assert.equal(parseTimeBudget("2h"), 7_200_000);
  assert.equal(parseTimeBudget("90m"), 5_400_000);
  assert.equal(parseTimeBudget("1.5min"), 90_000);
  assert.equal(parseTimeBudget("45s"), 45_000);
  assert.equal(parseTimeBudget("30"), 30_000);
  assert.equal(parseTimeBudget(undefined), null);
  assert.equal(parseTimeBudget("bad"), null);
});

test("autonomous loop stops repeated cached experiments without creating evidence", async () => {
  const Module = require("node:module");
  const filename = require.resolve("../src/loop");
  const originalLoad = Module._load;
  const originalLog = console.log;
  const logs = [];
  const versions = [];
  let runs = 0;
  let completions = 0;
  const stubs = {
    "./llm": { generateCandidate: async () => ({ candidate: { candidate_id: "same", model_family: "linear" }, source: "mock" }) },
    "./model-design-log": { appendModelDesignRecord: () => ({ markdownPath: "/unused" }) },
    "./session": { getBestSessionRow: () => null, getLatestSessionRow: () => null },
    "./versioning": {
      getLatestVersionRef: () => null,
      registerVersion: (_, value) => { versions.push(value.kind); return { version_id: "recipe" }; },
    },
    "./python-bridge": {
      loadResults: () => [], readRunnerState: () => ({}), writeCurrentCandidate: () => "/unused",
      runRunner: async (_, description, options) => {
        runs += 1;
        options.onStdout('{"event":"candidate_duplicate"}\n');
        return 0;
      },
    },
  };
  Module._load = function (request, parent, isMain) {
    return parent?.filename === filename && stubs[request] ? stubs[request] : originalLoad.call(this, request, parent, isMain);
  };
  console.log = (line) => logs.push(line);
  delete require.cache[filename];
  try {
    const { runAutonomousLoop } = require(filename);
    await runAutonomousLoop({ requirementText: "repeat" }, {}, { maxCandidates: 8, onRoundComplete: () => { completions += 1; } });
    assert.equal(runs, 3);
    assert.equal(completions, 0);
    assert.deepEqual(versions, ["recipe", "recipe", "recipe"]);
    assert.ok(logs.includes("LOOP:STOP_REASON=no_new_candidate"));
  } finally {
    Module._load = originalLoad;
    console.log = originalLog;
    delete require.cache[filename];
  }
});
