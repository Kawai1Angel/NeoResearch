"use strict";

const readline = require("readline");

// ---------------------------------------------------------------------------
// Requirement collection (non-interactive: companion starts immediately)
// ---------------------------------------------------------------------------

function buildCompanionRequirement(requirement, rawFlags) {
  const notes = rawFlags.notes && rawFlags.notes !== true ? String(rawFlags.notes) : "";
  const latency = rawFlags["latency-priority"] && rawFlags["latency-priority"] !== true
    ? String(rawFlags["latency-priority"])
    : "";
  const summary = [
    `Base requirement: ${requirement}`,
    `Latency priority: ${latency || "default"}`,
    `Notes: ${notes || "none"}`,
  ].join("\n");

  return {
    summary,
    requirementText: `${requirement}\n${summary}`,
  };
}

// ---------------------------------------------------------------------------
// Narrative printing helpers
// ---------------------------------------------------------------------------

const isTTY = process.stdout.isTTY;

function _line(text = "") {
  console.log(text);
}

function _banner(text) {
  const bar = "─".repeat(Math.min(60, text.length + 4));
  _line(`\n┌${bar}┐`);
  _line(`│  ${text.padEnd(bar.length - 2)}│`);
  _line(`└${bar}┘`);
}

function _tag(label, value) {
  const padded = `[${label}]`.padEnd(14);
  _line(`${padded} ${value}`);
}

function _candidateId(candidate) {
  return candidate.candidate_id || candidate.recipe_id || "NA";
}

function _candidateFamily(candidate) {
  if (candidate.model_family) return candidate.model_family;
  if (candidate.recipe_version === "recipe_schema_v1") {
    const embedding = candidate.embedding?.type || "unknown_embedding";
    const backbone = candidate.backbone?.type || "unknown_backbone";
    return `recipe:${embedding}+${backbone}`;
  }
  return "unknown";
}

function _candidateTrainInfo(candidate) {
  if (candidate.train_config) {
    return {
      lr: candidate.train_config.lr,
      batchSize: candidate.train_config.batch_size,
    };
  }
  const strategy = candidate.training_strategy || {};
  return {
    lr: strategy.optimizer?.lr,
    batchSize: strategy.budget?.batch_size,
  };
}

// Printed once at the start of the companion design loop
function printCompanionHeader(requirement, maxCandidates) {
  _banner("neo-cast companion mode");
  _tag("requirement", requirement.split("\n")[0]);
  _tag("max rounds", String(maxCandidates));
  _line("  I will explain each decision as we go. Type \"stop\" to end early.\n");
}

// Printed before each training run
function printCompanionAttempt(attempt, candidate, source) {
  const family = _candidateFamily(candidate);
  const trainInfo = _candidateTrainInfo(candidate);
  // machine-readable (required by e2e)
  console.log(`companion_attempt=${attempt}`);
  console.log(`companion_source=${source}`);
  console.log(`companion_candidate_id=${_candidateId(candidate)}`);
  console.log(`companion_model_family=${family}`);
  console.log(`companion_hypothesis=${candidate.hypothesis}`);

  // human-readable narrative
  _line();
  _tag(`Round ${attempt}`, `trying ${family.toUpperCase()}`);
  _tag("hypothesis", candidate.hypothesis);
  if (source.startsWith("anthropic")) {
    _tag("source", "Claude API");
  } else if (source.startsWith("openai-compatible")) {
    _tag("source", "OpenAI-compatible API");
  } else if (source === "heuristic_mock") {
    _tag("source", "mock (--mock-llm)");
  } else if (source === "mutation_policy") {
    _tag("source", "local mutation policy");
  } else {
    _tag("source", `heuristic fallback`);
  }
  _tag("lr", String(trainInfo.lr ?? "?"));
  _tag("batch_size", String(trainInfo.batchSize ?? "?"));
  _line("  Training…");
}

// Printed after each training run
function printCompanionResult(row) {
  if (!row) {
    // machine-readable
    console.log("companion_result=unavailable");
    _tag("result", "unavailable (no run recorded)");
    return;
  }

  // machine-readable (required by e2e)
  console.log(`companion_status=${row.status}`);
  console.log(`companion_run_id=${row.run_id}`);
  console.log(`companion_val_avg_mse=${row.val_avg_mse}`);
  console.log(`companion_is_best=${row.is_best}`);

  // human-readable narrative
  const verdict = row.status === "keep" ? "✓ KEEP" : row.status === "discard" ? "✗ DISCARD" : `⚠ ${row.status.toUpperCase()}`;
  const mse = row.val_avg_mse === "NA" ? "N/A" : `${parseFloat(row.val_avg_mse).toFixed(6)}`;
  _tag("val_avg_mse", mse);
  _tag("decision", verdict);
  if (row.is_best === "1") {
    _tag("note", "new best — artifact saved");
  }
}

// Printed after all rounds complete
function printCompanionFinalSummary(bestRow) {
  _line();
  _banner("design complete");

  if (!bestRow) {
    // machine-readable
    console.log("design_best=unavailable");
    _tag("best", "no successful run found");
    return;
  }

  // machine-readable (required by e2e)
  console.log(`design_best_run_id=${bestRow.run_id}`);
  console.log(`design_best_candidate_id=${bestRow.candidate_id}`);
  console.log(`design_best_model_family=${bestRow.model_family}`);
  console.log(`design_best_val_avg_mse=${bestRow.val_avg_mse}`);

  // human-readable
  _tag("best model", bestRow.model_family);
  _tag("val_avg_mse", parseFloat(bestRow.val_avg_mse).toFixed(6));
  _tag("run_id", bestRow.run_id);
  const artifactDir = `.neo-cast/artifacts/run_${bestRow.run_id}/`;
  _tag("artifact", artifactDir);
  _line("\n  Run inference:  python " + artifactDir + "example.py");
  _line("  Start MCP tool: python " + artifactDir + "mcp_server.py\n");
}

// ---------------------------------------------------------------------------
// Optional: stdin watcher so user can type "stop" during a run
// ---------------------------------------------------------------------------

function watchForStop(onStop) {
  if (!isTTY) return () => {};          // no-op in non-interactive mode

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (line.trim().toLowerCase() === "stop") {
      _line('\n[companion] "stop" received — finishing current run then exiting.');
      onStop();
    }
  });
  rl.on("close", () => {});
  return () => rl.close();
}

module.exports = {
  buildCompanionRequirement,
  printCompanionAttempt,
  printCompanionFinalSummary,
  printCompanionHeader,
  printCompanionResult,
  watchForStop,
};
