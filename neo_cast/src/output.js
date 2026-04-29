"use strict";

function printRequirementSummary(mode, summary) {
  console.log(`design_mode=${mode}`);
  console.log("requirement_summary_start");
  console.log(summary);
  console.log("requirement_summary_end");
}

function printCompanionAttempt(attempt, candidate, source) {
  console.log(`companion_attempt=${attempt}`);
  console.log(`companion_source=${source}`);
  console.log(`companion_candidate_id=${candidate.candidate_id || "NA"}`);
  console.log(`companion_model_family=${candidate.model_family}`);
  console.log(`companion_hypothesis=${candidate.hypothesis}`);
}

function printCompanionResult(row) {
  if (!row) {
    console.log("companion_result=unavailable");
    return;
  }
  console.log(`companion_status=${row.status}`);
  console.log(`companion_run_id=${row.run_id}`);
  console.log(`companion_val_avg_mse=${row.val_avg_mse}`);
  console.log(`companion_is_best=${row.is_best}`);
}

function printFinalSummary(bestRow) {
  if (!bestRow) {
    console.log("design_best=unavailable");
    return;
  }
  console.log(`design_best_run_id=${bestRow.run_id}`);
  console.log(`design_best_candidate_id=${bestRow.candidate_id}`);
  console.log(`design_best_model_family=${bestRow.model_family}`);
  console.log(`design_best_val_avg_mse=${bestRow.val_avg_mse}`);
}

module.exports = {
  printCompanionAttempt,
  printCompanionResult,
  printFinalSummary,
  printRequirementSummary,
};
