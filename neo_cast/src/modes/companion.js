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

function _refreshLine(text) {
  if (!isTTY) return;
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(text);
}

function _formatPulseElapsed(startTime) {
  const elapsed = Math.max(0, Date.now() - startTime);
  const totalSeconds = Math.floor(elapsed / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function startCompanionPulse(label, options = {}) {
  if (!isTTY) {
    return {
      stop: () => {},
      onOutput: () => {},
    };
  }

  const startTime = Date.now();
  const frames = options.frames || ["|", "/", "-", "\\"];
  let frameIndex = 0;
  let stopped = false;

  const render = () => {
    if (stopped) return;
    const frame = frames[frameIndex % frames.length];
    frameIndex += 1;
    _refreshLine(`  ${label} ${frame} ${_formatPulseElapsed(startTime)}`);
  };

  const timer = setInterval(render, 170);
  if (typeof timer.unref === "function") timer.unref();
  render();

  return {
    stop: (finalText = "done") => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      _refreshLine(`  ${finalText}`);
      process.stdout.write(`\n`);
    },
    onOutput: () => {
      _refreshLine("");
    },
  };
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
  _tag("REQ:TXT", requirement.split("\n")[0]);
  _tag("REQ:MAX", String(maxCandidates));
  _line("  SYS:CMD=stop_to_exit");
}

// Printed before each training run
function printCompanionAttempt(attempt, candidate, source) {
  const family = _candidateFamily(candidate);
  const trainInfo = _candidateTrainInfo(candidate);
  const sourceName = source.startsWith("anthropic")
    ? "openai_compat_anthropic"
    : source.startsWith("openai-compatible")
      ? "openai_compat"
      : source === "heuristic_mock"
        ? "mock_llm"
        : source === "mutation_policy"
          ? "mutation_policy"
          : "heuristic_fallback";
  // machine-readable (required by e2e)
  // human-readable narrative
  _line();
  _tag(`R${attempt}:CAN`, `trying ${family.toUpperCase()}`);
  _tag(`R${attempt}:HYP`, candidate.hypothesis);
  _tag(`R${attempt}:SRC`, sourceName);
  _tag(`R${attempt}:LR`, String(trainInfo.lr ?? "?"));
  _tag(`R${attempt}:BS`, String(trainInfo.batchSize ?? "?"));
}

// Printed after each training run
function printCompanionResult(row, attempt = null) {
  const statusPrefix = attempt ? `R${attempt}` : "RUN";
  if (!row) {
    // machine-readable
    _tag(`${statusPrefix}:RES`, "unavailable (no run recorded)");
    return;
  }

  // machine-readable (required by e2e)
  // human-readable narrative
  const verdict = row.status === "keep" ? "✓ KEEP" : row.status === "discard" ? "✗ DISCARD" : `⚠ ${row.status.toUpperCase()}`;
  const mse = row.val_avg_mse === "NA" ? "N/A" : `${parseFloat(row.val_avg_mse).toFixed(6)}`;
  _tag(`${statusPrefix}:VAL`, mse);
  _tag(`${statusPrefix}:DEC`, verdict);
  if (row.is_best === "1") {
    _tag(`${statusPrefix}:BEST`, "artifact saved");
  }
}

// Printed after all rounds complete
function printCompanionFinalSummary(bestRow) {
  _line();
  _banner("design complete");

  if (!bestRow) {
    _tag("BEST:UNAVAILABLE", "no successful run found");
    return;
  }

  // machine-readable (required by e2e)
  // human-readable
  _tag("BEST:MODEL", bestRow.model_family);
  _tag("BEST:VAL", parseFloat(bestRow.val_avg_mse).toFixed(6));
  _tag("BEST:RUN", bestRow.run_id);
  const artifactDir = `.neo-cast/artifacts/run_${bestRow.run_id}/`;
  _tag("BEST:ARTIFACT", artifactDir);
  _line(`  BEST:INFER=python ${artifactDir}example.py`);
  _line(`  BEST:MCP=python ${artifactDir}mcp_server.py\n`);
}

// ---------------------------------------------------------------------------
// Optional: stdin watcher so user can type "stop" during a run
// ---------------------------------------------------------------------------

function watchForStop(onStop) {
  if (!isTTY) return () => {};          // no-op in non-interactive mode

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (line.trim().toLowerCase() === "stop") {
      _line("\n  SYS:STOP=received");
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
  startCompanionPulse,
  watchForStop,
};
