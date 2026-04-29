"use strict";

const fs = require("fs");
const path = require("path");
const {
  _buildHeuristicCandidate,
  _ensureCandidateDefaults,
  _extractJsonObject,
} = require("./llm");

function numberOrNull(value) {
  if (value === undefined || value === null || value === "NA") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildReflectionContext(previousCandidate = {}, previousRow = {}, history = [], artifactData = null) {
  return {
    previous_recipe: {
      backbone: previousCandidate.backbone ?? null,
      embedding: previousCandidate.embedding ?? null,
      preprocessing: previousCandidate.preprocessing ?? null,
      fusion: previousCandidate.fusion ?? null,
      prediction_head: previousCandidate.prediction_head ?? null,
    },
    previous_result: {
      status: previousRow?.status ?? null,
      val_avg_mse: numberOrNull(previousRow?.val_avg_mse),
      val_h96_mse: numberOrNull(previousRow?.val_h96_mse),
      val_h720_mse: numberOrNull(previousRow?.val_h720_mse),
      params_M: numberOrNull(previousRow?.params_M),
    },
    training_curves: artifactData?.training_curves ?? null,
    training_summary: artifactData?.training_summary ?? null,
    experiment_history: history.slice(-6).map((row) => ({
      candidate_id: row.candidate_id ?? null,
      model_family: row.model_family ?? null,
      val_avg_mse: numberOrNull(row.val_avg_mse),
      val_h96_mse: numberOrNull(row.val_h96_mse),
      val_h720_mse: numberOrNull(row.val_h720_mse),
      status: row.status ?? null,
    })),
  };
}

function formatTaskContext(taskContext = {}) {
  const taskId = taskContext.task_id || "etth1";
  const featureColumns = Array.isArray(taskContext.feature_columns)
    ? taskContext.feature_columns
    : ["HUFL", "HULL", "MUFL", "MULL", "LUFL", "LULL", "OT"];
  const inputLen = taskContext.input_len || 512;
  const horizons = Array.isArray(taskContext.horizons) ? taskContext.horizons : [96, 192, 336, 720];
  const trainRows = taskContext.splits?.train || [0, 8640];
  const valRows = taskContext.splits?.val || [8640, 11520];
  const missingStrategy = taskContext.missing?.strategy || "forward_fill";
  const frequency = taskContext.time?.frequency || "auto";

  return [
    `- Dataset/task: ${taskId}`,
    `- Channels: ${featureColumns.length} (${featureColumns.join(", ")})`,
    `- Input window: ${inputLen} time steps`,
    `- Prediction horizons evaluated: ${horizons.join(", ")} (averaged)`,
    `- Train rows: [${trainRows[0]}, ${trainRows[1]})`,
    `- Validation rows: [${valRows[0]}, ${valRows[1]})`,
    `- Missing value strategy: ${missingStrategy}`,
    `- Frequency policy: ${frequency}`,
    "- Primary metric: val_avg_mse (lower is better, StandardScaler-normalised space)",
    "- Parameter budget: soft limit 1M params total across all horizon models",
    "- Training budget: 10 minutes wall-clock per run",
  ].join("\n");
}

function _buildReflectionSystemPrompt(taskContext = {}) {
  return `\
You are a time-series model design critic for the neo-cast system.
Your job is NOT to pick a model from a predefined list -
your job is to reason about WHY the previous model performed as it did,
and propose ONE better successor recipe based on that reasoning.

## Task context
${formatTaskContext(taskContext)}

## Analysis protocol
1. Examine the previous recipe: backbone, embedding, preprocessing, fusion, head.
2. Look at per-horizon validation metrics. Is the h720/h96 gap large? Does MSE grow super-linearly with horizon? Does the model underperform on short or long horizons?
3. If training_curves are provided:
   - Fast drop then plateau -> capacity bottleneck or LR too low
   - Oscillation -> LR too high or batch size too small
   - h720 diverges while h96 converges -> long-horizon gradient interference
   - All horizons flat from epoch 1 -> model lacks expressiveness
4. Identify the ONE primary bottleneck: architecture capacity, temporal receptive field, normalization, channel interaction, or optimization dynamics.
5. Propose a recipe that directly addresses this bottleneck. Be specific about what changed and why.

## Full supported action space

### preprocessing.actions
- { "type": "none" }
- { "type": "instance_norm", "affine": false, "eps": 0.00001 }
- { "type": "series_decomposition", "method": "moving_average", "kernel_size": 25 }
- { "type": "seasonal_differencing", "period": 24, "order": 1 }
- { "type": "missing_mask", "mask_channel": true, "fill_policy": "mean" }
- { "type": "sample_reweighting", "scheme": "uniform"|"horizon_tail"|"outlier_robust" }

### embedding
- { "type": "none" }
- { "type": "patch", "patch_len": 8|16|32, "stride": 4|8|16|32, "d_model": 32|64|128|256 }
- { "type": "multiscale_patch", "scales": [{ "patch_len": 8, "stride": 4 }, { "patch_len": 16, "stride": 8 }, { "patch_len": 32, "stride": 16 }], "d_model": 32|64|128 }
- { "type": "invert", "d_model": 16|32|64 }
- { "type": "frequency", "n_freq": 4|8|16|32, "d_model": 16|32|64, "complex_mode": "real_imag"|"magnitude" }
- { "type": "calendar", "fields": ["hour","dayofweek","day","month","position"], "embed_dim": 8|16|32 }

### backbone
- { "type": "linear", "shared": false, "bias": true }
- { "type": "mlp", "depth": 1|2|3, "hidden_dim": 64|128|256, "activation": "gelu", "dropout": 0.0|0.1 }
- { "type": "transformer", "d_model": 32|64|128, "n_heads": 1|2|4|8, "n_layers": 1|2|3, "dropout": 0.0|0.1, "ffn_mult": 2.0|4.0 }
- { "type": "rnn", "cell": "gru"|"lstm", "hidden_dim": 32|64|128, "num_layers": 1|2, "dropout": 0.0|0.1 }
- { "type": "dlinear", "kernel_size": 25, "bias": true } [requires embedding none]
- { "type": "tcn", "hidden_dim": 16|32|64, "n_layers": 1|2|3, "kernel_size": 3|5, "activation": "gelu", "dropout": 0.0|0.1 } [requires embedding none]
- { "type": "nbeats", "hidden_dim": 64|128|256, "n_blocks": 2|3|4, "n_layers": 2|3, "activation": "gelu", "dropout": 0.0|0.1 } [requires embedding none]
- { "type": "timesnet", "hidden_dim": 8|16|32, "n_layers": 1|2, "top_k": 1|2, "kernel_size": 3|5, "dropout": 0.0|0.1 } [requires embedding none]
- { "type": "ssm", "state_dim": 16|32|64, "depth": 1|2|3, "dropout": 0.0|0.1 }
- { "type": "mixer", "hidden_dim": 32|64|128, "depth": 1|2|3, "temporal_mixing": "mlp"|"conv", "channel_mixing": "mlp"|"identity", "dropout": 0.0|0.1 }

### fusion
- { "type": "temporal", "channel_mode": "independent"|"shared" }
- { "type": "feature" }
- { "type": "temporal_then_feature" }
- { "type": "feature_then_temporal" }
- { "type": "graph", "graph_type": "learned" }
- { "type": "gated_hybrid", "gate_type": "learned"|"scalar"|"channel"|"time" }

### prediction_head
- { "type": "linear", "output_distribution": "point", "share_across_horizons": false }
- { "type": "direct_multi_horizon", "output_distribution": "point", "horizon_specific": true }
- { "type": "quantile", "output_distribution": "quantile", "quantiles": [0.1,0.5,0.9] }
- { "type": "gaussian", "output_distribution": "gaussian", "variance_floor": 0.0001 }
- { "type": "residual_correction", "output_distribution": "point", "base_head": "linear", "correction_dim": 16 }

### training_strategy
- loss.base: "mse"|"mae"|"huber"|"quantile"|"distillation"
- optimizer.type: "adam"|"adamw"|"sgd"
- scheduler.type: "none"|"cosine"|"one_cycle"|"plateau"
- budget: { max_epochs: 10-100, time_budget_s: <=600, batch_size: 16|32|64, patience: 3-10, seed: 42 }

## Output format
Return a single JSON object. No markdown, no explanation outside the JSON.

Required fields: recipe_version, recipe_id, hypothesis, preprocessing, embedding,
backbone, fusion, prediction_head, post_processing, training_strategy, constraints

The hypothesis field MUST follow this format, max 1200 chars:
"Previous [backbone+embedding]: [observed metric pattern]. Diagnosis: [root cause]. Proposed change: [what changed] because [why this addresses the bottleneck]."

constraints: { "max_params": 1000000, "max_latency_ms": 50, "latency_priority": "medium" }`;
}

function _buildReflectionUserMessage(requirement, attempt, context) {
  return JSON.stringify(
    {
      user_requirement: requirement,
      attempt,
      reflection_context: context,
      instruction: "Analyze the previous result and propose an improved recipe. Return JSON only.",
    },
    null,
    2,
  );
}

async function callAnthropic(systemPrompt, userMessage, resolvedConfig) {
  const llm = resolvedConfig.llm || {};
  const Anthropic = require("@anthropic-ai/sdk");
  const clientOptions = { apiKey: process.env.ANTHROPIC_API_KEY };
  if (llm.base_url) clientOptions.baseURL = llm.base_url;
  const client = new Anthropic.default(clientOptions);
  const message = await client.messages.create({
    model: llm.model || "claude-sonnet-4-6",
    max_tokens: llm.max_tokens || 1200,
    temperature: llm.temperature ?? 0.2,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  if (!text) throw new Error("Anthropic API returned empty content.");
  return _extractJsonObject(text);
}

async function callOpenAICompatible(systemPrompt, userMessage, resolvedConfig) {
  const llm = resolvedConfig.llm || {};
  const apiKey = process.env.NEO_CAST_LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.AIGCBEST_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI-compatible provider requires NEO_CAST_LLM_API_KEY, OPENAI_API_KEY, or AIGCBEST_API_KEY.");
  }
  if (!llm.base_url) throw new Error("OPENAI-compatible provider requires llm.base_url.");

  const response = await fetch(`${String(llm.base_url).replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: llm.model,
      max_tokens: llm.max_tokens || 1200,
      temperature: llm.temperature ?? 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }),
  });
  const payload = await response.json().catch(async () => ({ error: { message: await response.text() } }));
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || JSON.stringify(payload).slice(0, 500);
    throw new Error(`${response.status} ${message}`);
  }
  const text = payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.text || "";
  if (!text) throw new Error(`OPENAI-compatible API returned empty content: ${JSON.stringify(payload).slice(0, 500)}`);
  return _extractJsonObject(text);
}

function readPreviousCandidate(projectRoot) {
  const recipePath = path.join(projectRoot, ".neo-cast", "current_candidate.json");
  try {
    return JSON.parse(fs.readFileSync(recipePath, "utf8"));
  } catch (_error) {
    return {};
  }
}

async function reflectAndPropose(requirement, history, previousRow, resolvedConfig, options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const attempt = options.attempt || 2;

  if (options.mockLlm || process.env.NEO_CAST_MOCK_LLM) {
    const candidate = _buildHeuristicCandidate(requirement, attempt);
    candidate.recipe_id = `recipe_reflect_mock_${Date.now()}_${attempt}`;
    _ensureCandidateDefaults(candidate, "reflect_mock", attempt);
    return { candidate, source: "heuristic_mock" };
  }

  try {
    const { loadArtifactData } = require("./python-bridge");
    const artifactData = previousRow?.run_id ? loadArtifactData(projectRoot, previousRow.run_id) : null;
    const context = buildReflectionContext(readPreviousCandidate(projectRoot), previousRow || {}, history, artifactData);
    const systemPrompt = _buildReflectionSystemPrompt(options.taskContext || {});
    const userMessage = _buildReflectionUserMessage(requirement, attempt, context);
    const provider = resolvedConfig?.llm?.provider || "anthropic";
    const rawCandidate = provider === "anthropic"
      ? await callAnthropic(systemPrompt, userMessage, resolvedConfig || {})
      : await callOpenAICompatible(systemPrompt, userMessage, resolvedConfig || {});
    _ensureCandidateDefaults(rawCandidate, "reflect", attempt);
    return { candidate: rawCandidate, source: "llm_reflection" };
  } catch (error) {
    console.error(`[neo-cast] reflection LLM call failed (attempt ${attempt}): ${error.message}`);
    return null;
  }
}

module.exports = {
  reflectAndPropose,
  buildReflectionContext,
  _buildReflectionSystemPrompt,
  _buildReflectionUserMessage,
};
