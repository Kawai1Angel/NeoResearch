"use strict";

const readline = require("readline/promises");

function buildRequirementSummary(requirement, answers) {
  const lines = [
    `Base requirement: ${requirement}`,
    `Model preference: ${answers.modelPreference || "unspecified"}`,
    `Params budget (M): ${answers.paramsBudget || "default"}`,
    `Latency priority: ${answers.latencyPriority || "default"}`,
    `Notes: ${answers.notes || "none"}`,
  ];
  return lines.join("\n");
}

async function collectSocraticRequirement(requirement, rawFlags, io = {}) {
  const answers = {
    modelPreference: rawFlags["model-preference"] && rawFlags["model-preference"] !== true ? String(rawFlags["model-preference"]) : "",
    paramsBudget: rawFlags["params-budget"] && rawFlags["params-budget"] !== true ? String(rawFlags["params-budget"]) : "",
    latencyPriority:
      rawFlags["latency-priority"] && rawFlags["latency-priority"] !== true
        ? String(rawFlags["latency-priority"])
        : "",
    notes: rawFlags.notes && rawFlags.notes !== true ? String(rawFlags.notes) : "",
  };

  const input = io.input || process.stdin;
  const output = io.output || process.stdout;
  const interactive = !rawFlags.yes && input.isTTY && output.isTTY;

  if (interactive) {
    const rl = readline.createInterface({ input, output });
    try {
      if (!answers.modelPreference) {
        answers.modelPreference = (await rl.question("Model preference (transformer / dlinear / tcn / nbeats / timesnet / patch_mlp, blank to skip): ")).trim();
      }
      if (!answers.paramsBudget) {
        answers.paramsBudget = (await rl.question("Parameter budget in millions (blank for default): ")).trim();
      }
      if (!answers.latencyPriority) {
        answers.latencyPriority = (await rl.question("Latency priority (low / medium / high, blank for default): ")).trim();
      }
      if (!answers.notes) {
        answers.notes = (await rl.question("Any extra notes? (blank to skip): ")).trim();
      }

      const summary = buildRequirementSummary(requirement, answers);
      const confirm = (await rl.question(`Proceed with:\n${summary}\nProceed? [Y/n]: `)).trim().toLowerCase();
      if (confirm === "n" || confirm === "no") {
        return {
          cancelled: true,
          summary,
        };
      }
      return {
        cancelled: false,
        summary,
        requirementText: `${requirement}\n${summary}`,
      };
    } finally {
      rl.close();
    }
  }

  const summary = buildRequirementSummary(requirement, answers);
  return {
    cancelled: false,
    summary,
    requirementText: `${requirement}\n${summary}`,
  };
}

module.exports = {
  collectSocraticRequirement,
};
