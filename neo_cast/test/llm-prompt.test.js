"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { _buildSystemPrompt } = require("../src/llm");

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
