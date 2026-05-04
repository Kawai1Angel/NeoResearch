"use strict";

const fs = require("fs");
const path = require("path");
const { describeCandidateFamily, describeCandidateId } = require("./candidate-utils");
const { generateCandidate } = require("./llm");
const { getBestSessionRow, getLatestSessionRow } = require("./session");
const {
  getProjectPaths,
  loadResults,
  mutateCandidate,
  readRunnerState,
  runRunner,
  writeCurrentCandidate,
} = require("./python-bridge");

function parseTimeBudget(raw) {
  if (!raw || raw === true) return null;
  const value = String(raw).trim().toLowerCase();
  const match = value.match(/^(\d+(?:\.\d+)?)(h|m|min|s|sec)?$/);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2] || "s";
  if (unit === "h") return amount * 3_600_000;
  if (unit === "m" || unit === "min") return amount * 60_000;
  return amount * 1_000;
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function checkStoppingConditions(state, options = {}) {
  const candidateCounter = numeric(state?.candidate_counter, 0);
  const noImproveStreak = numeric(state?.no_improve_streak, 0);
  const crashStreak = numeric(state?.crash_streak, 0);
  const maxCandidates = options.maxCandidates ?? Infinity;

  if (options.timeBudgetMs && Date.now() - numeric(options.sessionStartMs, Date.now()) > options.timeBudgetMs) {
    return { stop: true, reason: "time_budget_exhausted" };
  }

  if (Number.isFinite(maxCandidates) && candidateCounter >= maxCandidates) {
    return { stop: true, reason: "max_candidates_reached" };
  }

  if (options.maxNoImprove && noImproveStreak >= options.maxNoImprove) {
    return { stop: true, reason: `no_improve_plateau:${noImproveStreak}_rounds` };
  }

  if (crashStreak >= 5) {
    return { stop: true, reason: "crash_streak_exceeded" };
  }

  return { stop: false, reason: null };
}

function latestValMetricsPath(projectRoot, row) {
  if (!row || !row.run_id || row.run_id.startsWith("crash_") || row.run_id.startsWith("smoke_")) {
    return null;
  }
  const metricsPath = path.join(projectRoot, ".neo-cast", "artifacts", `run_${row.run_id}`, "val_metrics.json");
  return fs.existsSync(metricsPath) ? metricsPath : null;
}

function formatMinutes(timeBudgetMs) {
  if (!timeBudgetMs) return "unlimited";
  return `${Math.round(timeBudgetMs / 60_000)}min`;
}

function printAttemptResult(attempt, source, candidate, row) {
  const statusPrefix = `R${attempt}`;
  const status = row?.status ? String(row.status).toUpperCase() : "UNKNOWN";
  const mse = row?.val_avg_mse || "NA";
  console.log(`${statusPrefix}:SRC=${source}`);
  console.log(`${statusPrefix}:FAM=${describeCandidateFamily(candidate)}`);
  console.log(`${statusPrefix}:VAL=${mse}`);
  console.log(`${statusPrefix}:DEC=${status}`);
  if (row?.no_improve_streak !== undefined && row?.no_improve_streak !== null) {
    console.log(`${statusPrefix}:NOIMP=${row.no_improve_streak}`);
  }
}

async function proposeCandidate(requirementBundle, history, previousRow, resolvedConfig, options) {
  const attempt = options.attempt;
  if (attempt > 1 && options.useReflection) {
    const { reflectAndPropose } = require("./reflect");
    const reflected = await reflectAndPropose(
      requirementBundle.requirementText,
      history,
      previousRow,
      resolvedConfig,
      {
        projectRoot: options.projectRoot,
        mockLlm: options.mockLlm,
        taskContext: options.taskContext,
        attempt,
      },
    );
    if (reflected) return reflected;
  }

  if (attempt > 1 && options.useMutation) {
    try {
      const paths = getProjectPaths(options.projectRoot);
      const candidate = await mutateCandidate(options.projectRoot, {
        metricsPath: latestValMetricsPath(options.projectRoot, previousRow),
        index: attempt - 1,
        statePath: paths.runnerStatePath,
      });
      return { candidate, source: "mutation_policy" };
    } catch (error) {
      console.error(`[neo-cast] mutation failed: ${error.message}`);
    }
  }

  return generateCandidate(
    requirementBundle.requirementText,
    history,
    resolvedConfig,
    { attempt, mockLlm: options.mockLlm, taskContext: options.taskContext },
  );
}

async function runAutonomousLoop(requirementBundle, resolvedConfig, options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const timeBudgetMs = options.timeBudgetMs || null;
  const maxNoImprove = Number(options.maxNoImprove || 8);
  const maxCandidates = options.maxCandidates ?? Infinity;
  const sessionStartMs = Date.now();
  let attempt = 0;
  let history = loadResults(projectRoot);
  let previousRow = getLatestSessionRow(projectRoot);
  let stoppedReason = null;

  console.log(`LOOP:START=autonomous`);
  console.log(`LOOP:TIME=${formatMinutes(timeBudgetMs)}`);
  console.log(`LOOP:NOIMPROVE=${maxNoImprove}`);

  while (true) {
    const state = readRunnerState(projectRoot);
    const stop = checkStoppingConditions(state, {
      timeBudgetMs,
      maxNoImprove,
      maxCandidates,
      sessionStartMs,
    });
    if (stop.stop) {
      stoppedReason = stop.reason;
      console.log(`LOOP:STOP=${stop.reason}`);
      break;
    }

    attempt += 1;
    const result = await proposeCandidate(requirementBundle, history, previousRow, resolvedConfig, {
      attempt,
      mockLlm: Boolean(options.mockLlm),
      projectRoot,
      taskContext: options.taskContext,
      useMutation: Boolean(options.useMutation),
      useReflection: Boolean(options.useReflection),
    });

    const candidate = result.candidate;
    const candidatePath = writeCurrentCandidate(projectRoot, candidate);
    console.log(`R${attempt}:CAN=ready`);
    console.log(`R${attempt}:SRC=${result.source}`);
    console.log(`R${attempt}:PATH=${candidatePath}`);
    console.log(`R${attempt}:FAM=${describeCandidateFamily(candidate)}`);
    console.log(`R${attempt}:ID=${describeCandidateId(candidate)}`);

    const description = candidate.hypothesis || `${describeCandidateFamily(candidate)} autonomous attempt ${attempt}`;
    const exitCode = await runRunner(projectRoot, description, {
      skipSmoke: Boolean(options.skipSmoke),
    });
    history = loadResults(projectRoot);
    previousRow = getLatestSessionRow(projectRoot);
    printAttemptResult(attempt, result.source, candidate, previousRow);

    if (options.onRoundComplete) {
      await options.onRoundComplete(attempt, previousRow);
    }

    if (exitCode > 1) {
      stoppedReason = `hard_failure:${exitCode}`;
      console.log(`LOOP:HARD_FAIL=${attempt}`);
      break;
    }
  }

  const finalState = readRunnerState(projectRoot);
  console.log(
    `LOOP:END attempts=${attempt} time=${formatMinutes(Date.now() - sessionStartMs)} keep=${numeric(finalState?.keep_count, 0)}`,
  );
  if (stoppedReason) console.log(`LOOP:STOP_REASON=${stoppedReason}`);
  return getBestSessionRow(projectRoot);
}

module.exports = {
  checkStoppingConditions,
  parseTimeBudget,
  runAutonomousLoop,
};
