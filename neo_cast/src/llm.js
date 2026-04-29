"use strict";

// ---------------------------------------------------------------------------
// Heuristic fallback (used when LLM is mocked or API fails)
// ---------------------------------------------------------------------------

function _buildHeuristicCandidate(requirement, attempt = 1) {
  const text = String(requirement || "").toLowerCase();
  const fastMode = Boolean(process.env.NEO_CAST_FAST_E2E);
  const channelMode = (
    text.includes("channel") ||
    text.includes("cross") ||
    text.includes("correlation") ||
    text.includes("sensor") ||
    text.includes("multivariate") ||
    text.includes("shared") ||
    text.includes("通道") ||
    text.includes("相关")
  ) ? "shared" : "independent";
  const useMultiscale = (
    text.includes("multiscale") ||
    text.includes("multi-scale") ||
    text.includes("multi scale") ||
    text.includes("multiple scale") ||
    text.includes("multi resolution") ||
    text.includes("multi-resolution") ||
    text.includes("多尺度") ||
    text.includes("多分辨率")
  );
  const wantsDLinear = text.includes("dlinear") || text.includes("d-linear") || text.includes("decomposition linear") || text.includes("分解线性");
  const wantsTCN = text.includes("tcn") || text.includes("temporal conv") || text.includes("causal conv") || text.includes("convolution") || text.includes("卷积");
  const wantsNBeats = text.includes("n-beats") || text.includes("nbeats") || text.includes("n beats");
  const wantsTimesNet = text.includes("timesnet") || text.includes("times net") || text.includes("periodic") || text.includes("fft") || text.includes("周期");

  let modelFamily = "nlinear";
  if (wantsTimesNet) {
    modelFamily = "timesnet";
  } else if (wantsNBeats) {
    modelFamily = "nbeats";
  } else if (wantsTCN) {
    modelFamily = "tcn";
  } else if (wantsDLinear) {
    modelFamily = "dlinear";
  } else if (text.includes("transformer") || text.includes("attention")) {
    modelFamily = "tiny_transformer";
  } else if (text.includes("mlp") || text.includes("mixer") || text.includes("patch") || useMultiscale) {
    modelFamily = "patch_mlp";
  } else if (attempt === 2) {
    modelFamily = "dlinear";
  } else if (attempt >= 3) {
    modelFamily = "patch_mlp";
  }

  const hypotheses = {
    tiny_transformer: "Patch transformer: captures temporal patterns with multi-head attention over patched windows.",
    patch_mlp: "Patch MLP-Mixer: mixes local patch features with compact MLP layers.",
    dlinear: "DLinear: decomposes trend and seasonal components with a compact linear forecast head.",
    tcn: "TCN: uses causal dilated convolutions to capture local and medium-range temporal dependencies.",
    nbeats: "N-BEATS-lite: stacks residual backcast/forecast blocks for expressive univariate temporal extrapolation.",
    timesnet: "TimesNet-lite: uses FFT-derived period grids and compact 2D convolutions to model periodic variation.",
    nlinear: "NLinear baseline: channel-independent linear mapping, strongest lightweight reference.",
  };
  const hypothesis = hypotheses[modelFamily] || hypotheses.nlinear;

  const budget = {
    max_epochs: fastMode ? 2 : 8,
    time_budget_s: 600,
    batch_size: fastMode ? 16 : 32,
    patience: fastMode ? 2 : 4,
    seed: 42,
  };

  const baseRecipe = {
    recipe_version: "recipe_schema_v1",
    recipe_id: `recipe_heuristic_${Date.now()}_${attempt}`,
    hypothesis,
    preprocessing: { actions: [{ type: "none" }] },
    fusion: { type: "temporal", channel_mode: channelMode },
    prediction_head: { type: "linear", output_distribution: "point", share_across_horizons: false },
    post_processing: { type: "auto" },
    training_strategy: {
      loss: { base: "mse", horizon_weighting: "uniform" },
      optimizer: { type: "adam", lr: 0.001, weight_decay: 0.0 },
      scheduler: { type: "none", warmup_steps: 0 },
      regularization: { dropout: 0.1, grad_clip: 1.0 },
      budget,
    },
    constraints: { max_params: 1_000_000, max_latency_ms: 50, latency_priority: "medium" },
    notes: `heuristic fallback for: ${requirement}`,
  };

  if (modelFamily === "tiny_transformer") {
    const dModel = attempt >= 3 ? 128 : 64;
    return {
      ...baseRecipe,
      embedding: useMultiscale
        ? {
            type: "multiscale_patch",
            scales: [
              { patch_len: 8, stride: 8 },
              { patch_len: 16, stride: 16 },
              { patch_len: 32, stride: 32 },
            ],
            d_model: dModel,
          }
        : { type: "patch", patch_len: 16, stride: 16, d_model: dModel },
      backbone: { type: "transformer", d_model: dModel, n_heads: 4, n_layers: attempt >= 2 ? 2 : 1, dropout: 0.1, ffn_mult: 4.0 },
    };
  }
  if (modelFamily === "patch_mlp") {
    const dModel = attempt >= 3 ? 256 : 128;
    return {
      ...baseRecipe,
      embedding: useMultiscale
        ? {
            type: "multiscale_patch",
            scales: [
              { patch_len: 8, stride: 4 },
              { patch_len: 16, stride: 8 },
              { patch_len: 32, stride: 16 },
            ],
            d_model: dModel,
          }
        : { type: "patch", patch_len: 16, stride: 8, d_model: dModel },
      backbone: { type: "mlp", depth: 2, hidden_dim: dModel, activation: "gelu", dropout: 0.1 },
    };
  }
  if (modelFamily === "dlinear") {
    return {
      ...baseRecipe,
      embedding: { type: "none" },
      backbone: { type: "dlinear", kernel_size: 25, bias: true },
    };
  }
  if (modelFamily === "tcn") {
    return {
      ...baseRecipe,
      embedding: { type: "none" },
      backbone: { type: "tcn", hidden_dim: 16, n_layers: 1, kernel_size: 3, activation: "gelu", dropout: 0.1 },
    };
  }
  if (modelFamily === "nbeats") {
    return {
      ...baseRecipe,
      embedding: { type: "none" },
      backbone: { type: "nbeats", hidden_dim: 128, n_blocks: 3, n_layers: 2, activation: "gelu", dropout: 0.1 },
    };
  }
  if (modelFamily === "timesnet") {
    return {
      ...baseRecipe,
      embedding: { type: "none" },
      backbone: { type: "timesnet", hidden_dim: 16, n_layers: 1, top_k: 1, kernel_size: 3, dropout: 0.1 },
    };
  }

  return {
    ...baseRecipe,
    embedding: { type: "none" },
    backbone: { type: "linear", shared: false, bias: true },
  };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function _formatTaskContext(taskContext = {}) {
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

function _buildSystemPrompt(taskContext = {}) {
  return `\
You are a time-series forecasting model designer for the neo-cast system.
Your job is to propose one concrete model candidate for the prepared multivariate forecasting task.

## Task context
${_formatTaskContext(taskContext)}

## Supported CandidateRecipe actions

You must output a module-level CandidateRecipe, not Python code.

- preprocessing: none, instance_norm, series_decomposition, seasonal_differencing, missing_mask, sample_reweighting
- embedding: none, patch, multiscale_patch, invert, frequency, calendar
- backbone: linear, mlp, transformer, dlinear, tcn, nbeats, timesnet, rnn, ssm, mixer
- fusion: temporal, feature, temporal_then_feature, feature_then_temporal, graph, gated_hybrid
- prediction_head: linear, direct_multi_horizon, quantile, gaussian, residual_correction
- output_distribution: point, quantile, gaussian
- loss: mse, mae, huber, quantile, distillation
- optimizer: adam, adamw, or sgd
- scheduler: none, cosine, one_cycle, plateau

Action parameters:
- preprocessing.actions: one or more of [{ "type": "none" }], [{ "type": "instance_norm", "affine": false, "eps": 0.00001 }], [{ "type": "series_decomposition", "method": "moving_average", "kernel_size": 25 }], [{ "type": "seasonal_differencing", "period": 24, "order": 1 }], [{ "type": "missing_mask", "mask_channel": true, "fill_policy": "zero"|"mean"|"ffill" }], [{ "type": "sample_reweighting", "scheme": "uniform"|"horizon_tail"|"outlier_robust" }]
- embedding none: { "type": "none" }
- embedding patch: { "type": "patch", "patch_len": 8|16|32, "stride": <= patch_len, "d_model": 32|64|128|256 }
- embedding multiscale_patch: { "type": "multiscale_patch", "scales": [{ "patch_len": 8, "stride": 4 }, { "patch_len": 16, "stride": 8 }, { "patch_len": 32, "stride": 16 }], "d_model": 32|64|128 }
- embedding invert: { "type": "invert", "d_model": 32|64|128 }
- embedding frequency: { "type": "frequency", "n_freq": 8|16|32, "complex_mode": "magnitude"|"real_imag", "d_model": 32|64|128 }
- embedding calendar: { "type": "calendar", "fields": ["hour", "dayofweek", "month"], "embed_dim": 16|32|64 }
- backbone linear: { "type": "linear", "shared": false, "bias": true }
- backbone mlp: { "type": "mlp", "depth": 1|2|3, "hidden_dim": 64|128|256, "activation": "gelu", "dropout": 0.0|0.1|0.2 }
- backbone transformer: { "type": "transformer", "d_model": 32|64|128, "n_heads": 1|2|4|8, "n_layers": 1|2|3, "dropout": 0.0|0.1|0.2, "ffn_mult": 2.0|4.0 }
- backbone rnn: { "type": "rnn", "cell": "gru"|"lstm"|"rnn", "hidden_dim": 32|64|128, "num_layers": 1|2|3, "dropout": 0.0|0.1|0.2 }
- backbone dlinear: { "type": "dlinear", "kernel_size": 25, "bias": true } and requires embedding none
- backbone tcn: { "type": "tcn", "hidden_dim": 16|32|64, "n_layers": 1|2|3, "kernel_size": 3|5, "activation": "gelu", "dropout": 0.0|0.1|0.2 } and requires embedding none
- backbone nbeats: { "type": "nbeats", "hidden_dim": 64|128|256, "n_blocks": 2|3|4, "n_layers": 2|3, "activation": "gelu", "dropout": 0.0|0.1|0.2 } and requires embedding none
- backbone timesnet: { "type": "timesnet", "hidden_dim": 8|16|32, "n_layers": 1|2, "top_k": 1|2, "kernel_size": 3|5, "dropout": 0.0|0.1|0.2 } and requires embedding none
- backbone ssm: { "type": "ssm", "state_dim": 32|64|128, "depth": 1|2|3, "kernel_size": 3|5, "dropout": 0.0|0.1|0.2 }
- backbone mixer: { "type": "mixer", "hidden_dim": 64|128|256, "depth": 1|2|3, "temporal_mixing": "mlp"|"conv", "channel_mixing": "mlp"|"identity", "dropout": 0.0|0.1|0.2 }
- fusion temporal: { "type": "temporal", "channel_mode": "independent" | "shared" }
- fusion feature: { "type": "feature", "variate_token": true, "cross_attention": false }
- fusion temporal_then_feature or feature_then_temporal: { "type": "temporal_then_feature"|"feature_then_temporal", "gate": true, "residual": true }
- fusion graph: { "type": "graph", "graph_type": "learned", "adjacency_source": "learned"|"static"|"correlation", "sparsity": 0.1 }
- fusion gated_hybrid: { "type": "gated_hybrid", "gate_type": "learned"|"scalar"|"channel"|"time", "residual": true }
- prediction_head linear: { "type": "linear", "output_distribution": "point", "share_across_horizons": false }
- prediction_head direct_multi_horizon: { "type": "direct_multi_horizon", "output_distribution": "point", "horizon_specific": true }
- prediction_head quantile: { "type": "quantile", "output_distribution": "quantile", "quantiles": [0.1, 0.5, 0.9] }
- prediction_head gaussian: { "type": "gaussian", "output_distribution": "gaussian", "variance_floor": 0.000001 }
- prediction_head residual_correction: { "type": "residual_correction", "output_distribution": "point", "base_head": "linear", "correction_dim": 32|64|128 }
- training_strategy.loss.base: "mse" | "mae" | "huber" | "quantile" | "distillation"
- quantile loss should include quantiles: [0.1, 0.5, 0.9]
- distillation loss should include supervised_weight, teacher_weight, and teacher: { "type": "last_value"|"moving_average", "window": 24 }
- training_strategy.optimizer.type: "adam" | "adamw" | "sgd"
- training_strategy.scheduler.type: "none" | "cosine" | "one_cycle" | "plateau"

## Output format
Return a single JSON object and nothing else. No markdown, no explanation outside the JSON.

Required fields:
  recipe_version: "recipe_schema_v1"
  recipe_id: unique string like "recipe_<embedding>_<backbone>_<short_reason>"
  hypothesis: 1-2 sentence rationale for why this candidate may improve val_avg_mse
  preprocessing, embedding, backbone, fusion, prediction_head, post_processing, training_strategy, constraints

training_strategy.budget: { max_epochs, time_budget_s, batch_size, patience, seed: 42 }
    lr: 0.0001–0.01
    batch_size: 16, 32, or 64
    max_epochs: 10–100
    patience: 3–10
    time_budget_s: <= 600
constraints: { max_params: 1000000, max_latency_ms: 50, latency_priority: "medium" }

## Design principles
- Avoid repeating module combinations that already appeared in recent history
- If recent history shows discard for a backbone, try a different backbone or meaningfully different config
- Smaller models are preferred when accuracy is comparable
- linear is a very strong baseline — only propose something more complex if there is a clear reason
- Try channel_mode="shared" only when cross-channel correlation may matter; it adds a residual channel mixer before the temporal backbone
- Prefer multiscale_patch when the requirement mentions multi-scale, mixed periodicity, or both short and long local motifs
- Prefer invert/calendar/frequency embeddings when requirements mention variate-token modeling, calendar features, or spectral patterns
- Prefer dlinear for trend/seasonality baseline checks; prefer tcn for local temporal motifs; prefer nbeats for residual extrapolation; prefer timesnet for explicit periodic or FFT-style requirements
- Prefer rnn for sequential memory, ssm for long-range stateful dynamics, and mixer for simple token/channel mixing
- Prefer graph or gated_hybrid fusion when cross-channel structure is central to the requirement
- Use quantile or gaussian heads only when probabilistic forecasts or uncertainty estimates are requested
- For attempt > 1, diversify: try a different backbone or substantially different hyperparameters`;
}

function _buildUserMessage(requirement, history, attempt, taskContext = {}) {
  const recentHistory = history.slice(-6).map((row) => ({
    candidate_id: row.candidate_id,
    model_family: row.model_family,
    val_avg_mse: row.val_avg_mse === "NA" ? null : Number(row.val_avg_mse),
    status: row.status,
  }));

  return JSON.stringify({
    user_requirement: requirement,
    attempt,
    task_context: taskContext,
    recent_experiment_history: recentHistory,
    instruction: "Propose the next candidate. Return JSON only.",
  }, null, 2);
}

// ---------------------------------------------------------------------------
// Extract JSON from LLM response text
// ---------------------------------------------------------------------------

function _extractJsonObject(text) {
  // Strip markdown code fences if present
  const stripped = text.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`No JSON object found in LLM response. Got: ${text.slice(0, 200)}`);
  }
  return JSON.parse(stripped.slice(start, end + 1));
}

function _ensureCandidateDefaults(candidate, prefix, attempt) {
  if (!candidate.recipe_version) candidate.recipe_version = "recipe_schema_v1";
  if (!candidate.recipe_id) candidate.recipe_id = `recipe_${prefix}_${Date.now()}_${attempt}`;
  if (!candidate.post_processing) candidate.post_processing = { type: "auto" };
  if (!candidate.constraints) {
    candidate.constraints = { max_params: 1_000_000, max_latency_ms: 50, latency_priority: "medium" };
  }
  if (!candidate.training_strategy) {
    candidate.training_strategy = {
      loss: { base: "mse", horizon_weighting: "uniform" },
      optimizer: { type: "adam", lr: 0.001, weight_decay: 0.0 },
      scheduler: { type: "none", warmup_steps: 0 },
      regularization: { dropout: 0.1, grad_clip: 1.0 },
      budget: { max_epochs: 50, time_budget_s: 600, batch_size: 32, patience: 5, seed: 42 },
    };
  }
  if (!candidate.training_strategy.budget) {
    candidate.training_strategy.budget = { max_epochs: 50, time_budget_s: 600, batch_size: 32, patience: 5, seed: 42 };
  }
  if (candidate.training_strategy.budget.seed === undefined) candidate.training_strategy.budget.seed = 42;
  if (candidate.training_strategy.budget.time_budget_s === undefined) candidate.training_strategy.budget.time_budget_s = 600;

  if (process.env.NEO_CAST_FAST_E2E) {
    candidate.training_strategy.budget = {
      ...candidate.training_strategy.budget,
      batch_size: Math.min(Number(candidate.training_strategy.budget.batch_size || 32), 16),
      max_epochs: Math.min(Number(candidate.training_strategy.budget.max_epochs || 50), 2),
      patience: Math.min(Number(candidate.training_strategy.budget.patience || 5), 2),
    };
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Anthropic API call via SDK
// ---------------------------------------------------------------------------

async function _generateWithAnthropic(requirement, history, resolvedConfig, attempt, taskContext = {}) {
  const llm = resolvedConfig.llm;
  const Anthropic = require("@anthropic-ai/sdk");

  const clientOptions = { apiKey: process.env.ANTHROPIC_API_KEY };
  if (llm.base_url) clientOptions.baseURL = llm.base_url;

  const client = new Anthropic.default(clientOptions);

  const message = await client.messages.create({
    model: llm.model || "claude-sonnet-4-6",
    max_tokens: llm.max_tokens || 1024,
    temperature: llm.temperature ?? 0.3,
    system: _buildSystemPrompt(taskContext),
    messages: [{ role: "user", content: _buildUserMessage(requirement, history, attempt, taskContext) }],
  });

  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  if (!text) throw new Error("Anthropic API returned empty content.");

  const candidate = _extractJsonObject(text);

  return _ensureCandidateDefaults(candidate, "llm", attempt);
}

async function _generateWithOpenAICompatible(requirement, history, resolvedConfig, attempt, taskContext = {}) {
  const llm = resolvedConfig.llm;
  const apiKey = process.env.NEO_CAST_LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.AIGCBEST_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI-compatible provider requires NEO_CAST_LLM_API_KEY, OPENAI_API_KEY, or AIGCBEST_API_KEY.");
  }
  if (!llm.base_url) {
    throw new Error("OPENAI-compatible provider requires llm.base_url.");
  }

  const baseUrl = String(llm.base_url).replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: llm.model,
      max_tokens: llm.max_tokens || 1024,
      temperature: llm.temperature ?? 0.3,
      messages: [
        { role: "system", content: _buildSystemPrompt(taskContext) },
        { role: "user", content: _buildUserMessage(requirement, history, attempt, taskContext) },
      ],
    }),
  });

  const payload = await response.json().catch(async () => ({
    error: { message: await response.text() },
  }));
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || JSON.stringify(payload).slice(0, 500);
    throw new Error(`${response.status} ${message}`);
  }

  const text = payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.text || "";
  if (!text) {
    throw new Error(`OPENAI-compatible API returned empty content: ${JSON.stringify(payload).slice(0, 500)}`);
  }

  const candidate = _extractJsonObject(text);
  return _ensureCandidateDefaults(candidate, "glm", attempt);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function generateCandidate(requirement, history, resolvedConfig, options = {}) {
  const attempt = options.attempt || 1;
  const useMock = Boolean(options.mockLlm || process.env.NEO_CAST_MOCK_LLM);
  const taskContext = options.taskContext || {};

  if (useMock) {
    return { candidate: _buildHeuristicCandidate(requirement, attempt), source: "heuristic_mock" };
  }

  const provider = resolvedConfig?.llm?.provider || "anthropic";
  if (
    provider === "anthropic"
    && !process.env.ANTHROPIC_API_KEY
  ) {
    console.error("[neo-cast] ANTHROPIC_API_KEY not set — falling back to heuristic candidate.");
    return { candidate: _buildHeuristicCandidate(requirement, attempt), source: "heuristic_fallback:no_api_key" };
  }

  try {
    if (provider === "anthropic") {
      const candidate = await _generateWithAnthropic(requirement, history, resolvedConfig, attempt, taskContext);
      return { candidate, source: "anthropic" };
    }
    if (provider === "openai-compatible") {
      const candidate = await _generateWithOpenAICompatible(requirement, history, resolvedConfig, attempt, taskContext);
      return { candidate, source: "openai-compatible" };
    }
    throw new Error(`Unsupported llm.provider: ${provider}`);
  } catch (err) {
    console.error(`[neo-cast] LLM call failed (attempt ${attempt}): ${err.message}`);
    console.error("[neo-cast] Falling back to heuristic candidate.");
    return { candidate: _buildHeuristicCandidate(requirement, attempt), source: `heuristic_fallback:${err.message.slice(0, 80)}` };
  }
}

module.exports = { generateCandidate, _buildSystemPrompt };
