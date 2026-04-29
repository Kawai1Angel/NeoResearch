"use strict";

const fs = require("fs");
const { getProjectPaths, loadResults } = require("./python-bridge");

function loadRunnerState(projectRoot = process.cwd()) {
  const paths = getProjectPaths(projectRoot);
  if (!fs.existsSync(paths.runnerStatePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(paths.runnerStatePath, "utf8"));
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

function getBestSessionRow(projectRoot = process.cwd()) {
  const rows = getSessionRows(projectRoot);
  return rows.find((row) => row.is_best === "1") || null;
}

module.exports = {
  getBestSessionRow,
  getLatestSessionRow,
  getSessionRows,
  loadRunnerState,
};
