"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { checkStoppingConditions, parseTimeBudget } = require("../src/loop");

test("checkStoppingConditions stops when time budget is exhausted", () => {
  const result = checkStoppingConditions(
    { candidate_counter: 3, no_improve_streak: 2, crash_streak: 0 },
    { timeBudgetMs: 1000, sessionStartMs: Date.now() - 2000, maxNoImprove: 8, maxCandidates: Infinity },
  );

  assert.deepEqual(result, { stop: true, reason: "time_budget_exhausted" });
});

test("checkStoppingConditions stops on no-improve plateau", () => {
  const result = checkStoppingConditions(
    { candidate_counter: 10, no_improve_streak: 8, crash_streak: 0 },
    { timeBudgetMs: null, sessionStartMs: Date.now(), maxNoImprove: 8, maxCandidates: Infinity },
  );

  assert.equal(result.stop, true);
  assert.match(result.reason, /^no_improve_plateau:8_rounds$/);
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
