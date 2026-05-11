"use strict";

function isTruthyFlag(value) {
  if (value === undefined || value === null || value === false) {
    return false;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized || ["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return true;
}

function isMockLlmEnabled(options = {}, env = process.env) {
  return Boolean(
    isTruthyFlag(options.mockLlm)
    || isTruthyFlag(options["mock-llm"])
    || isTruthyFlag(env.NEO_CAST_USE_MOCK)
    || isTruthyFlag(env.NEO_CAST_MOCK_LLM)
  );
}

module.exports = {
  isMockLlmEnabled,
  isTruthyFlag,
};
