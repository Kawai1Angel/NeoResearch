"use strict";

function printRequirementSummary(mode, summary) {
  console.log(`REQ:MODE=${mode}`);
  console.log(`REQ:SUMMARY=${summary}`);
}

function describeCandidateId(candidate) {
  return candidate.candidate_id || candidate.recipe_id || "NA";
}

function printCompanionAttempt(attempt, candidate, source) {
  const roundPrefix = `R${attempt}`;
  const modelFamily = candidate.model_family || "NA";

  console.log(`${roundPrefix}:CAN=trying ${modelFamily}`);
  console.log(`${roundPrefix}:HYP=${candidate.hypothesis}`);
  console.log(`${roundPrefix}:SRC=${source}`);
  console.log(`${roundPrefix}:ID=${describeCandidateId(candidate)}`);
}

function printCompanionResult(row, attempt = null) {
  const statusPrefix = attempt ? `R${attempt}` : "RUN";
  if (!row) {
    console.log(`${statusPrefix}:RES=unavailable`);
    return;
  }

  // BEST tag derives from the session-local `status === "keep"` signal: Python's
  // runner_state.best_val_avg_mse tracker still flips the row to "keep" when it
  // improves locally. The TS-driven champion table is the global authority.
  const sessionLocalBest = row.status === "keep" ? "1" : "0";
  console.log(`${statusPrefix}:STATUS=${row.status}`);
  console.log(`${statusPrefix}:RUN=${row.run_id}`);
  console.log(`${statusPrefix}:VAL=${row.val_avg_mse}`);
  console.log(`${statusPrefix}:BEST=${sessionLocalBest}`);
}

function printFinalSummary(bestRow) {
  if (!bestRow) {
    console.log("BEST:UNAVAILABLE=1");
    return;
  }
  console.log(`BEST:RUN=${bestRow.run_id}`);
  console.log(`BEST:ID=${bestRow.candidate_id || "NA"}`);
  console.log(`BEST:FAM=${bestRow.model_family || "NA"}`);
  console.log(`BEST:VAL=${bestRow.val_avg_mse}`);
}

module.exports = {
  printCompanionAttempt,
  printCompanionResult,
  printFinalSummary,
  printRequirementSummary,
};
