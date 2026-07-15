"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  appendModelDesignRecord,
  buildModelDesignRecord,
} = require("../src/model-design-log");

test("buildModelDesignRecord extracts model recipe architecture and training details", () => {
  const record = buildModelDesignRecord({
    schema_version: "model_recipe.v1",
    model_name: "TinyPatchForecaster",
    hypothesis: "try compact patch attention",
    input: { history_window: 96, prediction_horizons: [24, 48] },
    architecture: { backbone: "transformer", d_model: 64, layers: 2 },
    training: { optimizer: "adamw", learning_rate: 0.001, batch_size: 32 },
    constraints: { max_params: "1M" },
  }, {
    attempt: 2,
    source: "mock",
    candidatePath: "/tmp/current_candidate.json",
    recipeVersionId: "recipe_tiny_v1",
    recordedAt: "2026-06-24T00:00:00.000Z",
  });

  assert.equal(record.candidate_id, "TinyPatchForecaster");
  assert.equal(record.model_family, "model_recipe:transformer");
  assert.deepEqual(record.architecture.architecture, { backbone: "transformer", d_model: 64, layers: 2 });
  assert.deepEqual(record.training, { optimizer: "adamw", learning_rate: 0.001, batch_size: 32 });
});

test("appendModelDesignRecord writes ordered JSONL and markdown summaries", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "neo-cast-design-log-"));

  const first = appendModelDesignRecord(projectRoot, {
    recipe_version: "recipe_schema_v1",
    recipe_id: "recipe_dlinear",
    hypothesis: "baseline linear model",
    embedding: { type: "none" },
    backbone: { type: "dlinear", decomposition: true },
    fusion: { type: "temporal", channel_mode: "independent" },
    training_strategy: {
      optimizer: { type: "adam", lr: 0.001 },
      budget: { max_epochs: 2, batch_size: 16 },
      loss: { base: "mse" },
    },
  }, { attempt: 1, source: "heuristic" });

  appendModelDesignRecord(projectRoot, {
    schema_version: "model_recipe.v1",
    model_name: "TinyTransformer",
    architecture: { backbone: "transformer", d_model: 32 },
    training: { optimizer: "adamw", learning_rate: 0.0005 },
  }, { attempt: 2, source: "reflection" });

  const records = fs.readFileSync(first.jsonlPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.candidate_id), ["recipe_dlinear", "TinyTransformer"]);
  assert.deepEqual(records[0].architecture.backbone, { type: "dlinear", decomposition: true });
  assert.deepEqual(records[0].training.optimizer, { type: "adam", lr: 0.001 });

  const markdown = fs.readFileSync(first.markdownPath, "utf8");
  assert.match(markdown, /## 1\. recipe_dlinear/);
  assert.match(markdown, /## 2\. TinyTransformer/);
  assert.match(markdown, /"backbone": "transformer"/);
  assert.match(markdown, /"learning_rate": 0.0005/);
});
