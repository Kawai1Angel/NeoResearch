"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  checkAnthropicApiKey,
  checkOpenAICompatibleApiKey,
  formatDoctorReport,
} = require("../src/doctor");
const { isMockLlmEnabled } = require("../src/mock-mode");

const REPO_ROOT = path.resolve(__dirname, "..");
const BIN = path.join(REPO_ROOT, "bin", "neo-cast.js");

test("doctor reports missing LLM keys as warnings with mock fallback guidance", () => {
  const env = {};
  const checks = [
    checkOpenAICompatibleApiKey(env),
    checkAnthropicApiKey(env),
  ];
  const report = formatDoctorReport({ ok: true, checks });

  assert.equal(checks[0].ok, true);
  assert.equal(checks[0].level, "warn");
  assert.equal(checks[1].ok, true);
  assert.equal(checks[1].level, "warn");
  assert.match(report, /^neo-cast doctor: OK/m);
  assert.match(report, /\[WARN\] openai_compatible_api_key: OPENAI-compatible API key is not set\./);
  assert.match(report, /\[WARN\] anthropic_api_key: ANTHROPIC_API_KEY is not set\./);
  assert.match(report, /--mock-llm/);
  assert.match(report, /NEO_CAST_USE_MOCK=1/);
});

test("help advertises the no-key mock LLM path", () => {
  const result = spawnSync("node", [BIN, "help"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /No API key\?/);
  assert.match(result.stdout, /--mock-llm/);
  assert.match(result.stdout, /NEO_CAST_USE_MOCK=1/);
});

test("NEO_CAST_USE_MOCK enables the same mock LLM path as --mock-llm", () => {
  assert.equal(isMockLlmEnabled({}, { NEO_CAST_USE_MOCK: "1" }), true);
  assert.equal(isMockLlmEnabled({ mockLlm: true }, {}), true);
  assert.equal(isMockLlmEnabled({}, { NEO_CAST_USE_MOCK: "0", NEO_CAST_MOCK_LLM: "" }), false);
});
