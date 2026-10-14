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
  const actionTypes = (definition) => definition.oneOf.map((branch) => branch.properties.type.const);
  const expected = {
    preprocessing: actionTypes(defs.preprocessingAction),
    embedding: actionTypes(defs.embeddingAction),
    backbone: actionTypes(defs.backboneAction),
    fusion: actionTypes(defs.fusionAction),
    prediction_head: actionTypes(defs.predictionHead),
    output_distribution: [...new Set(defs.predictionHead.oneOf.map((branch) => branch.properties.output_distribution.const))],
    loss: defs.trainingStrategy.properties.loss.properties.base.enum,
    scheduler: defs.trainingStrategy.properties.scheduler.properties.type.enum,
  };

  for (const [section, values] of Object.entries(expected)) {
    assert.deepEqual(missingValues(prompt, values), [], `${section} prompt values are missing`);
  }
});

test("LLM system prompt lists the full factory backbone action space", () => {
  const prompt = _buildSystemPrompt();

  assert.deepEqual(promptActionList(prompt, "backbone").sort(), [
    "linear",
    "mlp",
    "transformer",
    "tcn",
    "dlinear",
    "nbeats",
    "timesnet_lite",
    "rnn",
    "gated_depthwise_conv",
    "mixer",
    "diagonal_ssm",
    "timesblock_encoder",
    "mamba",
  ].sort());
});

test("LLM system prompt exposes advanced fusion and probabilistic heads", () => {
  const prompt = _buildSystemPrompt();

  assert.deepEqual(promptActionList(prompt, "fusion").sort(), [
    "feature_mlp",
    "temporal",
    "variate_attention",
    "temporal_then_feature",
    "feature_then_temporal",
    "graph",
    "gated_hybrid",
  ].sort());
  assert.deepEqual(promptActionList(prompt, "prediction_head"), [
    "identity",
    "linear",
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

test("LLM system prompt requires the high-level model_recipe.v2 DSL", () => {
  const prompt = _buildSystemPrompt({ input_len: 96, horizons: [24] });

  assert.match(prompt, /ModelRecipe DSL/);
  assert.match(prompt, /schema_version: "model_recipe\.v2"/);
  assert.match(prompt, /model_name/);
  assert.match(prompt, /input/);
  assert.match(prompt, /architecture/);
  assert.match(prompt, /training/);
  assert.match(prompt, /latency_sensitive/);
});

test("LLM system prompt discourages redundant dlinear decomposition", () => {
  const prompt = _buildSystemPrompt();

  assert.match(prompt, /dlinear backbone already includes decomposition/);
  assert.match(prompt, /do not combine it with preprocessing series_decomposition/);
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

test("heuristic mock candidate emits a high-level model recipe", () => {
  const { _buildHeuristicCandidate } = require("../src/llm");

  const candidate = _buildHeuristicCandidate(
    "MultiScale tiny temporal conv model with deployment latency sensitivity",
    1,
    { input_len: 96, horizons: [24] },
  );

  assert.equal(candidate.schema_version, "model_recipe.v2");
  assert.equal(candidate.input.history_window, 96);
  assert.equal(candidate.input.prediction_horizon, 24);
  assert.equal(candidate.architecture.backbone.type, "tcn");
  assert.equal(candidate.architecture.embedding.type, "none");
  assert.equal(candidate.constraints.latency_sensitive, true);
});

test("ModelRecipe defaults preserve options and select a matching probabilistic loss", () => {
  for (const [distribution, loss] of [["gaussian", "gaussian_nll"], ["quantile", "quantile"]]) {
    const candidate = _ensureCandidateDefaults({schema_version: "model_recipe.v1", architecture: {backbone: "transformer", embedding: "calendar", output_distribution: distribution}}, "test", 1);
    assert.equal(candidate.architecture.attention, "full");
    assert.equal(candidate.architecture.embedding, "calendar");
    assert.equal(candidate.architecture.output_distribution, distribution);
    assert.equal(candidate.training.loss, loss);
  }
});

test("heuristic mock candidate preserves the full task horizon objective", () => {
  const { _buildHeuristicCandidate } = require("../src/llm");

  const candidate = _buildHeuristicCandidate(
    "small TSF baseline for ETTh1 with 4 horizons",
    1,
    { input_len: 512, horizons: [96, 192, 336, 720] },
  );

  assert.equal(candidate.schema_version, "model_recipe.v2");
  assert.equal(candidate.input.prediction_horizon, 96);
  assert.deepEqual(candidate.input.prediction_horizons, [96, 192, 336, 720]);
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
