"use strict";

const fs = require("fs");
const path = require("path");
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

function formatMinutes(timeBudgetMs) {
  if (!timeBudgetMs) return "unlimited";
  return `${Math.round(timeBudgetMs / 60_000)}min`;
}

function printAttemptResult(attempt, source, candidate, row) {
  const status = row?.status ? String(row.status).toUpperCase() : "UNKNOWN";
  const mse = row?.val_avg_mse || "NA";
  const noImprove = row?.status === "discard" ? ` no_improve=${row.no_improve_streak || "?"}` : "";
  console.log(
    `[attempt ${String(attempt).padStart(2, " ")}] source=${source} family=${describeCandidateFamily(candidate)} val_avg_mse=${mse} -> ${status}${noImprove}`,
  );
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

  console.log("[loop] autonomous iteration started");
  console.log(`[loop] time_budget=${formatMinutes(timeBudgetMs)} max_no_improve=${maxNoImprove}`);

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
      console.log(`[loop] stopping: ${stop.reason}`);
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
    console.log(`design_attempt=${attempt}`);
    console.log(`candidate_source=${result.source}`);
    console.log(`candidate_path=${candidatePath}`);
    console.log(`candidate_family=${describeCandidateFamily(candidate)}`);
    console.log(`candidate_id=${describeCandidateId(candidate)}`);

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
      console.log(`[loop] hard failure at attempt ${attempt}, exiting`);
      break;
    }
  }

  const finalState = readRunnerState(projectRoot);
  console.log(
    `[loop] total_time=${formatMinutes(Date.now() - sessionStartMs)} total_attempts=${attempt} keep_count=${numeric(finalState?.keep_count, 0)}`,
  );
  if (stoppedReason) console.log(`[loop] stopped_reason=${stoppedReason}`);
  return getBestSessionRow(projectRoot);
}

module.exports = {
  checkStoppingConditions,
  parseTimeBudget,
  runAutonomousLoop,
};
