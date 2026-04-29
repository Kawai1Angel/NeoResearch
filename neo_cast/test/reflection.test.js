"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadArtifactData, writeCurrentCandidate } = require("../src/python-bridge");
const {
  _buildReflectionSystemPrompt,
  buildReflectionContext,
  reflectAndPropose,
} = require("../src/reflect");

function tempProject(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("loadArtifactData reads training curves and summary for a run", () => {
  const projectRoot = tempProject("neo-cast-reflect-artifacts-");
  const artifactDir = path.join(projectRoot, ".neo-cast", "artifacts", "run_run_123");
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactDir, "training_curves.json"),
    JSON.stringify({ curves_by_horizon: { 96: [0.72, 0.7], 720: [1.5] } }),
  );
  fs.writeFileSync(path.join(artifactDir, "training_summary.json"), JSON.stringify({ backbone: "linear" }));

  assert.deepEqual(loadArtifactData(projectRoot, "run_123"), {
    training_curves: { curves_by_horizon: { 96: [0.72, 0.7], 720: [1.5] } },
    training_summary: { backbone: "linear" },
  });
});

test("reflection context captures previous recipe, per-horizon metrics, curves, and recent history", () => {
  const context = buildReflectionContext(
    {
      preprocessing: { actions: [{ type: "none" }] },
      embedding: { type: "none" },
      backbone: { type: "linear" },
      fusion: { type: "temporal" },
      prediction_head: { type: "linear" },
    },
    {
      status: "discard",
      val_avg_mse: "1.091800",
      val_h96_mse: "0.710000",
      val_h720_mse: "1.560000",
      params_M: "0.03",
    },
    [
      { candidate_id: "old", model_family: "recipe:none+linear", val_avg_mse: "1.3", status: "discard" },
      {
        candidate_id: "latest",
        model_family: "recipe:none+linear",
        val_avg_mse: "1.0918",
        val_h96_mse: "0.71",
        val_h720_mse: "1.56",
        status: "discard",
      },
    ],
    { training_curves: { curves_by_horizon: { 720: [1.58, 1.56] } } },
  );

  assert.equal(context.previous_recipe.backbone.type, "linear");
  assert.equal(context.previous_result.val_h720_mse, 1.56);
  assert.deepEqual(context.training_curves.curves_by_horizon["720"], [1.58, 1.56]);
  assert.equal(context.experiment_history.at(-1).candidate_id, "latest");
});

test("reflection system prompt exposes long-horizon diagnosis protocol and full action space", () => {
  const prompt = _buildReflectionSystemPrompt({ task_id: "etth1", horizons: [96, 192, 336, 720] });

  assert.match(prompt, /h720\/h96 gap/i);
  for (const value of ["rnn", "ssm", "mixer", "gated_hybrid", "quantile", "gaussian"]) {
    assert.match(prompt, new RegExp(value));
  }
});

test("reflectAndPropose mock mode returns a schema candidate without calling artifact APIs", async () => {
  const projectRoot = tempProject("neo-cast-reflect-mock-");
  writeCurrentCandidate(projectRoot, {
    recipe_version: "recipe_schema_v1",
    recipe_id: "previous_linear",
    embedding: { type: "none" },
    backbone: { type: "linear" },
  });

  const result = await reflectAndPropose(
    "focus on h720",
    [],
    { run_id: "missing", val_avg_mse: "1.0" },
    {},
    { projectRoot, mockLlm: true, attempt: 2 },
  );

  assert.equal(result.source, "heuristic_mock");
  assert.equal(result.candidate.recipe_version, "recipe_schema_v1");
  assert.match(result.candidate.recipe_id, /reflect_mock/);
});
