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
  for (const value of ["rnn", "gated_depthwise_conv", "mixer", "gated_hybrid", "quantile", "gaussian"]) {
    assert.match(prompt, new RegExp(value));
  }
});

test("reflection system prompt includes active user correction memory", () => {
  const prompt = _buildReflectionSystemPrompt({
    task_id: "energy_hourly",
    user_corrections: [
      {
        schema_version: "user_correction.v1",
        scope: "split_policy",
        correction: "data must be split in chronological order only",
        status: "active",
      },
    ],
  });

  assert.match(prompt, /Human Feedback Memory/);
  assert.match(prompt, /split_policy/);
  assert.match(prompt, /chronological order only/);
});

test("reflectAndPropose mock mode returns a schema candidate without calling artifact APIs", async () => {
  const projectRoot = tempProject("neo-cast-reflect-mock-");
  writeCurrentCandidate(projectRoot, {
    recipe_version: "recipe_schema_v2",
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
  assert.equal(result.candidate.schema_version, "model_recipe.v2");
  assert.match(result.candidate.model_name, /Forecaster/);
});

test("reflectAndPropose real LLM path tags candidates as llm_reflection", async () => {
  const projectRoot = tempProject("neo-cast-reflect-real-");
  writeCurrentCandidate(projectRoot, {
    recipe_version: "recipe_schema_v2",
    recipe_id: "previous_linear",
    preprocessing: { actions: [{ type: "none" }] },
    embedding: { type: "none" },
    backbone: { type: "linear" },
    fusion: { type: "temporal", channel_mode: "independent" },
    prediction_head: { type: "linear", output_distribution: "point" },
  });
  const artifactDir = path.join(projectRoot, ".neo-cast", "artifacts", "run_prev");
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "training_curves.json"), JSON.stringify({ curves_by_horizon: { 720: [1.6] } }));

  const originalFetch = global.fetch;
  const originalKey = process.env.NEO_CAST_LLM_API_KEY;
  process.env.NEO_CAST_LLM_API_KEY = "test-key";
  global.fetch = async () => new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              recipe_version: "recipe_schema_v2",
              recipe_id: "recipe_reflect_patch_transformer",
              hypothesis: "Previous linear+none: h720 was much worse than h96. Diagnosis: temporal receptive field bottleneck. Proposed change: patch transformer because attention expands long-horizon context.",
              preprocessing: { actions: [{ type: "instance_norm", affine: false, eps: 0.00001 }] },
              embedding: { type: "patch", patch_len: 16, stride: 8, d_model: 64 },
              backbone: { type: "transformer", d_model: 64, n_heads: 4, n_layers: 2, dropout: 0.1, ffn_mult: 4.0 },
              fusion: { type: "temporal", channel_mode: "shared" },
              prediction_head: { type: "linear", output_distribution: "point"},
              post_processing: { type: "auto" },
              training_strategy: {
                loss: { base: "mse", horizon_weighting: "uniform" },
                optimizer: { type: "adamw", lr: 0.001, weight_decay: 0.0 },
                scheduler: { type: "none", warmup_steps: 0 },
                regularization: { grad_clip: 1.0 },
                budget: { max_epochs: 10, time_budget_s: 600, batch_size: 32, patience: 5, seed: 42 },
              },
              constraints: { max_params: 1000000, max_latency_ms: 50, latency_priority: "medium" },
            }),
          },
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

  try {
    const result = await reflectAndPropose(
      "improve long horizon",
      [],
      { run_id: "prev", val_h96_mse: "0.7", val_h720_mse: "1.6", status: "discard" },
      { llm: { provider: "openai-compatible", base_url: "https://example.invalid/v1", model: "test" } },
      { projectRoot, attempt: 2 },
    );

    assert.equal(result.source, "llm_reflection");
    assert.equal(result.candidate.backbone.type, "transformer");
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.NEO_CAST_LLM_API_KEY;
    else process.env.NEO_CAST_LLM_API_KEY = originalKey;
  }
});

test("reflectAndPropose honors llm timeout for OpenAI-compatible requests", async () => {
  const projectRoot = tempProject("neo-cast-reflect-timeout-");
  writeCurrentCandidate(projectRoot, {
    recipe_version: "recipe_schema_v2",
    recipe_id: "previous_linear",
    embedding: { type: "none" },
    backbone: { type: "linear" },
  });

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
      reflectAndPropose(
        "improve long horizon",
        [],
        { run_id: "missing", val_avg_mse: "1.0" },
        { llm: { provider: "openai-compatible", base_url: "https://example.invalid/v1", model: "test", timeout_seconds: 0.01 } },
        { projectRoot, attempt: 2 },
      ),
      new Promise((resolve) => setTimeout(() => resolve("timed_out"), 75)),
    ]);

    assert.equal(result, null);
    assert.equal(sawAbort, true);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.NEO_CAST_LLM_API_KEY;
    else process.env.NEO_CAST_LLM_API_KEY = originalKey;
  }
});
