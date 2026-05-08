"use strict";

const fs = require("fs");
const { getProjectPaths, loadResults } = require("./python-bridge");

function loadRunnerState(projectRoot = process.cwd()) {
  const paths = getProjectPaths(projectRoot);
  if (!fs.existsSync(paths.runnerStatePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(paths.runnerStatePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function getSessionRows(projectRoot = process.cwd()) {
  const state = loadRunnerState(projectRoot);
  const rows = loadResults(projectRoot);
  if (!state) {
    return rows;
  }
  return rows.filter((row) => row.session_id === state.session_id);
}

function getLatestSessionRow(projectRoot = process.cwd()) {
  const rows = getSessionRows(projectRoot);
  return rows.length ? rows[rows.length - 1] : null;
}

// Champion ground truth lives in the TS Research Service (research_champion table).
// In the legacy `neo-cast design` CLI we no longer rely on Python writing `is_best=1`;
// instead we derive the session-local best by scanning val_avg_mse over completed rows.
// Tie-break is "first occurrence wins" so the originally improving run keeps the BEST tag.
function getBestSessionRow(projectRoot = process.cwd()) {
  const rows = getSessionRows(projectRoot);
  let best = null;
  let bestMse = Infinity;
  for (const row of rows) {
    const status = row.status;
    if (status === "crash" || status === "smoke_fail" || status === "invalid") continue;
    const mse = parseFloat(row.val_avg_mse);
    if (!Number.isFinite(mse)) continue;
    if (mse < bestMse) {
      bestMse = mse;
      best = row;
    }
  }
  return best;
}

module.exports = {
  getBestSessionRow,
  getLatestSessionRow,
  getSessionRows,
  loadRunnerState,
};
