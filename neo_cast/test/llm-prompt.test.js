"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { _buildSystemPrompt, _ensureCandidateDefaults, generateCandidate } = require("../src/llm");

const REPO_ROOT = path.resolve(__dirname, "..");

function recipeSchema() {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "py", "schemas", "recipe_schema.json"), "utf8"));
}

function missingValues(prompt, values) {
  return values.filter((value) => !prompt.includes(value));
}

function promptActionList(prompt, section) {
  const match = prompt.match(new RegExp(`^- ${section}: (.+)$`, "m"));
  assert.ok(match, `${section} action list is missing from prompt`);
  return match[1]
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

test("LLM system prompt exposes recipe schema action spaces", () => {
  assert.equal(typeof _buildSystemPrompt, "function");
  const schema = recipeSchema();
  const defs = schema.$defs;
  const prompt = _buildSystemPrompt();
  const expected = {
    preprocessing: defs.preprocessingAction.properties.type.enum,
    embedding: defs.embeddingAction.properties.type.enum,
    backbone: defs.backboneAction.properties.type.enum,
    fusion: defs.fusionAction.properties.type.enum,
    prediction_head: defs.predictionHead.properties.type.enum,
    output_distribution: defs.predictionHead.properties.output_distribution.enum,
    loss: defs.trainingStrategy.properties.loss.properties.base.enum,
    scheduler: defs.trainingStrategy.properties.scheduler.properties.type.enum,
  };

  for (const [section, values] of Object.entries(expected)) {
    assert.deepEqual(missingValues(prompt, values), [], `${section} prompt values are missing`);
  }
});

test("LLM system prompt lists the full factory backbone action space", () => {
  const prompt = _buildSystemPrompt();

  assert.deepEqual(promptActionList(prompt, "backbone"), [
    "linear",
    "mlp",
    "transformer",
    "dlinear",
    "tcn",
    "nbeats",
    "timesnet",
    "rnn",
    "ssm",
    "mixer",
  ]);
});

test("LLM system prompt exposes advanced fusion and probabilistic heads", () => {
  const prompt = _buildSystemPrompt();

  assert.deepEqual(promptActionList(prompt, "fusion"), [
    "temporal",
    "feature",
    "temporal_then_feature",
    "feature_then_temporal",
    "graph",
    "gated_hybrid",
  ]);
  assert.deepEqual(promptActionList(prompt, "prediction_head"), [
    "linear",
    "direct_multi_horizon",
    "quantile",
    "gaussian",
    "residual_correction",
  ]);
  assert.deepEqual(promptActionList(prompt, "output_distribution"), [
    "point",
    "quantile",
    "gaussian",
  ]);
});

test("LLM system prompt includes active user correction memory", () => {
  const prompt = _buildSystemPrompt({
    task_id: "energy_hourly",
    user_corrections: [
      {
        schema_version: "user_correction.v1",
        scope: "data_schema",
        field: "temperature_forecast",
        correction: "available only at prediction time",
        status: "active",
      },
    ],
  });

  assert.match(prompt, /Human Feedback Memory/);
  assert.match(prompt, /temperature_forecast/);
  assert.match(prompt, /available only at prediction time/);
  assert.match(prompt, /authoritative constraints/);
});

test("LLM candidate defaults complete required frequency embedding fields", () => {
  const candidate = _ensureCandidateDefaults(
    {
      embedding: { type: "frequency", d_model: 64 },
      backbone: { type: "mixer", hidden_dim: 128, depth: 2, temporal_mixing: "mlp", channel_mixing: "mlp", dropout: 0.1 },
      fusion: { type: "gated_hybrid", gate_type: "learned" },
      prediction_head: { type: "linear", output_distribution: "point" },
    },
    "test",
    1,
  );

  assert.equal(candidate.embedding.n_freq, 16);
  assert.equal(candidate.embedding.complex_mode, "magnitude");
});

test("OpenAI-compatible candidate generation honors llm timeout", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.NEO_CAST_LLM_API_KEY;
  process.env.NEO_CAST_LLM_API_KEY = "test-key";

  let sawAbort = false;
  global.fetch = async (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => {
      sawAbort = true;
      const error = new Error("aborted by timeout");
      error.name = "AbortError";
      reject(error);
    });
  });

  try {
    const result = await Promise.race([
      generateCandidate(
        "fast timeout test",
        [],
        { llm: { provider: "openai-compatible", base_url: "https://example.invalid/v1", model: "test", timeout_seconds: 0.01 } },
      ),
      new Promise((resolve) => setTimeout(() => resolve("timed_out"), 75)),
    ]);

    assert.notEqual(result, "timed_out");
    assert.equal(sawAbort, true);
    assert.match(result.source, /^heuristic_fallback:/);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.NEO_CAST_LLM_API_KEY;
    else process.env.NEO_CAST_LLM_API_KEY = originalKey;
  }
});
