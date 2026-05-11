"use strict";

const { formatUserCorrections } = require("./corrections");
const { isMockLlmEnabled } = require("./mock-mode");

// ---------------------------------------------------------------------------
// Heuristic fallback (used when LLM is mocked or API fails)
// ---------------------------------------------------------------------------

function _modelNameForFamily(modelFamily, useMultiscale) {
  const names = {
    tiny_transformer: useMultiscale ? "MultiScaleTinyTransformer" : "TinyTransformerForecaster",
    patch_mlp: useMultiscale ? "MultiScalePatchMLPForecaster" : "PatchMLPForecaster",
    dlinear: "DLinearTinyForecaster",
    tcn: useMultiscale ? "MultiScaleTemporalConvForecaster" : "TemporalConvForecaster",
    nbeats: "NBeatsLiteForecaster",
    timesnet: "TimesNetLiteForecaster",
    nlinear: "LinearTinyForecaster",
  };
  return names[modelFamily] || "TinyForecaster";
}

function _architectureBackboneForFamily(modelFamily) {
  if (modelFamily === "tiny_transformer") return "transformer";
  if (modelFamily === "patch_mlp") return "mlp";
  if (modelFamily === "tcn") return "temporal_conv";
  if (modelFamily === "nlinear") return "linear";
  return modelFamily;
}

function _taskHorizons(taskContext = {}) {
  const rawHorizons = Array.isArray(taskContext.horizons) && taskContext.horizons.length > 0
    ? taskContext.horizons
    : [96, 192, 336, 720];
  const horizons = rawHorizons
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);
  return horizons.length > 0 ? Array.from(new Set(horizons)) : [96, 192, 336, 720];
}

function _candidateRecipeToModelRecipe(recipe, taskContext = {}, options = {}) {
  const modelFamily = options.modelFamily || "model";
  const text = String(options.requirement || "").toLowerCase();
  const architecture = recipe.backbone || {};
  const embedding = recipe.embedding || {};
  const strategy = recipe.training_strategy || {};
  const budget = strategy.budget || {};
  const optimizer = strategy.optimizer || {};
  const wantsDecomposition = (
    text.includes("decomposition") ||
    text.includes("decompose") ||
    text.includes("trend") ||
    text.includes("seasonal") ||
    text.includes("seasonality") ||
    text.includes("分解") ||
    text.includes("趋势") ||
    text.includes("季节")
  );
  const latencySensitive = (
    text.includes("latency") ||
    text.includes("deployment") ||
    text.includes("deploy") ||
    text.includes("inference") ||
    text.includes("部署") ||
    text.includes("推理")
  );
  const horizons = _taskHorizons(taskContext);
  const multiscaleBlocks = embedding.type === "multiscale_patch"
    ? embedding.scales?.length || 3
    : Math.max(Number(architecture.n_layers || architecture.n_blocks || architecture.depth || 1), options.useMultiscale ? 3 : 0);

  return {
    schema_version: "model_recipe.v1",
    model_name: _modelNameForFamily(modelFamily, Boolean(options.useMultiscale)),
    hypothesis: recipe.hypothesis,
    input: {
      history_window: Number(taskContext.input_len || 512),
      prediction_horizon: Number(horizons[0] || 96),
      prediction_horizons: horizons.map((horizon) => Number(horizon)),
      covariates: recipe.fusion?.channel_mode === "shared",
    },
    architecture: {
      backbone: _architectureBackboneForFamily(modelFamily),
      decomposition: wantsDecomposition || modelFamily === "dlinear",
      multiscale_blocks: multiscaleBlocks,
      attention: modelFamily === "tiny_transformer" || text.includes("attention") ? "lightweight" : "none",
      channel_fusion: recipe.fusion?.channel_mode || "independent",
      hidden_dim: Number(architecture.hidden_dim || architecture.d_model || embedding.d_model || 64),
      d_model: Number(architecture.d_model || embedding.d_model || architecture.hidden_dim || 64),
      layers: Number(architecture.n_layers || architecture.n_blocks || architecture.depth || 1),
      heads: Number(architecture.n_heads || 4),
      kernel_size: Number(architecture.kernel_size || 3),
      patch_len: Number(embedding.patch_len || 16),
      stride: Number(embedding.stride || 8),
      dropout: Number(architecture.dropout || 0.1),
      output_distribution: recipe.prediction_head?.output_distribution || "point",
    },
    training: {
      loss: strategy.loss?.base || "mse",
      optimizer: optimizer.type || "adam",
      learning_rate: Number(optimizer.lr || 0.001),
      weight_decay: Number(optimizer.weight_decay || 0.0),
      batch_size: Number(budget.batch_size || 32),
      max_epochs: Number(budget.max_epochs || 8),
      time_budget_s: Number(budget.time_budget_s || 600),
      patience: Number(budget.patience || 4),
      seed: Number(budget.seed || 42),
      grad_clip: Number(strategy.regularization?.grad_clip || 1.0),
    },
    constraints: {
      max_params: `${Math.max(1, Math.round(Number(recipe.constraints?.max_params || 1_000_000) / 1_000_000))}M`,
      latency_sensitive: latencySensitive || recipe.constraints?.latency_priority === "high",
      max_latency_ms: Number(recipe.constraints?.max_latency_ms || 50),
    },
    notes: recipe.notes,
  };
}

function _buildHeuristicCandidate(requirement, attempt = 1, taskContext = {}) {
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
    return _candidateRecipeToModelRecipe({
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
    }, taskContext, { modelFamily, requirement, useMultiscale });
  }
  if (modelFamily === "patch_mlp") {
    const dModel = attempt >= 3 ? 256 : 128;
    return _candidateRecipeToModelRecipe({
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
    }, taskContext, { modelFamily, requirement, useMultiscale });
  }
  if (modelFamily === "dlinear") {
    return _candidateRecipeToModelRecipe({
      ...baseRecipe,
      embedding: { type: "none" },
      backbone: { type: "dlinear", kernel_size: 25, bias: true },
    }, taskContext, { modelFamily, requirement, useMultiscale });
  }
  if (modelFamily === "tcn") {
    return _candidateRecipeToModelRecipe({
      ...baseRecipe,
      embedding: { type: "none" },
      backbone: { type: "tcn", hidden_dim: 16, n_layers: useMultiscale ? 3 : 1, kernel_size: 3, activation: "gelu", dropout: 0.1 },
    }, taskContext, { modelFamily, requirement, useMultiscale });
  }
  if (modelFamily === "nbeats") {
    return _candidateRecipeToModelRecipe({
      ...baseRecipe,
      embedding: { type: "none" },
      backbone: { type: "nbeats", hidden_dim: 128, n_blocks: 3, n_layers: 2, activation: "gelu", dropout: 0.1 },
    }, taskContext, { modelFamily, requirement, useMultiscale });
  }
  if (modelFamily === "timesnet") {
    return _candidateRecipeToModelRecipe({
      ...baseRecipe,
      embedding: { type: "none" },
      backbone: { type: "timesnet", hidden_dim: 16, n_layers: 1, top_k: 1, kernel_size: 3, dropout: 0.1 },
    }, taskContext, { modelFamily, requirement, useMultiscale });
  }

  return _candidateRecipeToModelRecipe({
    ...baseRecipe,
    embedding: { type: "none" },
    backbone: { type: "linear", shared: false, bias: true },
  }, taskContext, { modelFamily, requirement, useMultiscale });
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
  const correctionContext = formatUserCorrections(taskContext.user_corrections || []);

  const lines = [
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
  ];
  if (correctionContext) {
    lines.push(correctionContext);
  }
  return lines.join("\n");
}

function _buildSystemPrompt(taskContext = {}) {
  return `\
You are a time-series forecasting model designer for the neo-cast system.
Your job is to propose one concrete model candidate for the prepared multivariate forecasting task.

## Task context
${_formatTaskContext(taskContext)}

## Supported ModelRecipe DSL controlled design space

You must output a high-level ModelRecipe DSL object, not natural language and not Python code.
The runtime will compile model_recipe.v1 into the executable recipe_schema_v1 factory format.

- preprocessing: none, instance_norm, series_decomposition, seasonal_differencing, missing_mask, sample_reweighting
- embedding: none, patch, multiscale_patch, invert, frequency, calendar
- backbone: linear, mlp, transformer, temporal_conv, dlinear, nbeats, timesnet, rnn, ssm, mixer
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
  schema_version: "model_recipe.v1"
  model_name: PascalCase model name, e.g. "MultiScaleTinyForecaster"
  hypothesis: 1-2 sentence rationale for why this candidate may improve val_avg_mse
  input: { history_window, prediction_horizon, prediction_horizons, covariates }
  architecture: { backbone, decomposition, multiscale_blocks, attention, channel_fusion, hidden_dim, d_model, layers, heads, kernel_size, patch_len, stride, dropout, output_distribution }
  training: { loss, optimizer, learning_rate, batch_size, max_epochs, time_budget_s, patience, seed, weight_decay, grad_clip }
  constraints: { max_params, latency_sensitive, max_latency_ms }

Use history_window, prediction_horizon, and prediction_horizons from the task context.
Set input.prediction_horizons to the full task horizon list, not just the first horizon.
constraints.max_params may be an integer or a human-readable string like "5M".
constraints.latency_sensitive should be true when deployment, inference speed, or compact serving is important.

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
    instruction: "Propose the next model_recipe.v1 candidate. Return JSON only.",
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

function _looksLikeModelRecipe(candidate) {
  return candidate?.schema_version === "model_recipe.v1"
    || candidate?.model_name
    || candidate?.architecture
    || candidate?.training
    || candidate?.input;
}

function _ensureCandidateDefaults(candidate, prefix, attempt) {
  if (_looksLikeModelRecipe(candidate) && !candidate.recipe_version) {
    if (!candidate.schema_version) candidate.schema_version = "model_recipe.v1";
    if (!candidate.model_name) candidate.model_name = `TinyForecaster${attempt}`;
    if (!candidate.hypothesis) candidate.hypothesis = "Structured model recipe generated for the prepared forecasting task.";
    if (!candidate.input) {
      candidate.input = { history_window: 512, prediction_horizon: 96, prediction_horizons: [96], covariates: true };
    }
    if (candidate.input.history_window === undefined) candidate.input.history_window = 512;
    if (candidate.input.prediction_horizon === undefined) candidate.input.prediction_horizon = 96;
    if (candidate.input.prediction_horizons === undefined) candidate.input.prediction_horizons = [candidate.input.prediction_horizon];
    if (candidate.input.covariates === undefined) candidate.input.covariates = true;
    if (!candidate.architecture) candidate.architecture = { backbone: "linear" };
    if (!candidate.architecture.backbone) candidate.architecture.backbone = "linear";
    if (candidate.architecture.decomposition === undefined) candidate.architecture.decomposition = false;
    if (candidate.architecture.multiscale_blocks === undefined) candidate.architecture.multiscale_blocks = 0;
    if (!candidate.architecture.attention) candidate.architecture.attention = "none";
    if (!candidate.training) {
      candidate.training = {
        loss: "mse",
        optimizer: "adam",
        learning_rate: 0.001,
        batch_size: 32,
        max_epochs: 50,
        time_budget_s: 600,
        patience: 5,
        seed: 42,
      };
    }
    if (!candidate.training.loss) candidate.training.loss = "mse";
    if (!candidate.training.optimizer) candidate.training.optimizer = "adam";
    if (candidate.training.learning_rate === undefined) candidate.training.learning_rate = 0.001;
    if (candidate.training.batch_size === undefined) candidate.training.batch_size = 32;
    if (candidate.training.max_epochs === undefined) candidate.training.max_epochs = 50;
    if (candidate.training.time_budget_s === undefined) candidate.training.time_budget_s = 600;
    if (candidate.training.patience === undefined) candidate.training.patience = 5;
    if (candidate.training.seed === undefined) candidate.training.seed = 42;
    if (!candidate.constraints) {
      candidate.constraints = { max_params: "1M", latency_sensitive: false, max_latency_ms: 50 };
    }
    if (candidate.constraints.max_params === undefined) candidate.constraints.max_params = "1M";
    if (candidate.constraints.latency_sensitive === undefined) candidate.constraints.latency_sensitive = false;

    if (process.env.NEO_CAST_FAST_E2E) {
      candidate.training = {
        ...candidate.training,
        batch_size: Math.min(Number(candidate.training.batch_size || 32), 16),
        max_epochs: Math.min(Number(candidate.training.max_epochs || 50), 2),
        patience: Math.min(Number(candidate.training.patience || 5), 2),
      };
    }
    return candidate;
  }

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

  if (candidate.embedding?.type === "frequency") {
    if (candidate.embedding.n_freq === undefined) candidate.embedding.n_freq = 16;
    if (candidate.embedding.complex_mode === undefined) candidate.embedding.complex_mode = "magnitude";
  }

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

function _alignCandidateWithTaskContext(candidate, taskContext = {}) {
  if (!_looksLikeModelRecipe(candidate)) return candidate;
  const horizons = _taskHorizons(taskContext);
  if (!candidate.input) {
    candidate.input = {
      history_window: Number(taskContext.input_len || 512),
      prediction_horizon: horizons[0],
      covariates: true,
    };
  }
  if (candidate.input.history_window === undefined && taskContext.input_len !== undefined) {
    candidate.input.history_window = Number(taskContext.input_len);
  }
  candidate.input.prediction_horizons = horizons;
  if (!horizons.includes(Number(candidate.input.prediction_horizon))) {
    candidate.input.prediction_horizon = horizons[0];
  }
  return candidate;
}

function _resolveLlmTimeoutMs(llm = {}, fallbackSeconds = 120) {
  const seconds = Number(llm.timeout_seconds ?? fallbackSeconds);
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : fallbackSeconds;
  return Math.ceil(safeSeconds * 1000);
}

async function _withLlmTimeout(llm, operation, label = "LLM request") {
  const timeoutMs = _resolveLlmTimeoutMs(llm);
  const timeoutSeconds = Number((timeoutMs / 1000).toFixed(3));
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let didTimeout = false;
  let timeout = null;

  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      didTimeout = true;
      if (controller) controller.abort();
      reject(new Error(`${label} timed out after ${timeoutSeconds}s`));
    }, timeoutMs);
    if (typeof timeout.unref === "function") timeout.unref();
  });

  try {
    return await Promise.race([
      operation(controller?.signal),
      timeoutPromise,
    ]);
  } catch (error) {
    if (didTimeout) {
      throw new Error(`${label} timed out after ${timeoutSeconds}s`);
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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

  const message = await _withLlmTimeout(
    llm,
    (signal) => client.messages.create({
      model: llm.model || "claude-sonnet-4-6",
      max_tokens: llm.max_tokens || 1024,
      temperature: llm.temperature ?? 0.3,
      system: _buildSystemPrompt(taskContext),
      messages: [{ role: "user", content: _buildUserMessage(requirement, history, attempt, taskContext) }],
    }, signal ? { signal } : undefined),
    "Anthropic LLM request",
  );

  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  if (!text) throw new Error("Anthropic API returned empty content.");

  const candidate = _extractJsonObject(text);

  return _alignCandidateWithTaskContext(_ensureCandidateDefaults(candidate, "llm", attempt), taskContext);
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
  const { ok, status, payload } = await _withLlmTimeout(
    llm,
    async (signal) => {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        signal,
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
      return { ok: response.ok, status: response.status, payload };
    },
    "OpenAI-compatible LLM request",
  );
  if (!ok) {
    const message = payload?.error?.message || payload?.message || JSON.stringify(payload).slice(0, 500);
    throw new Error(`${status} ${message}`);
  }

  const text = payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.text || "";
  if (!text) {
    throw new Error(`OPENAI-compatible API returned empty content: ${JSON.stringify(payload).slice(0, 500)}`);
  }

  const candidate = _extractJsonObject(text);
  return _alignCandidateWithTaskContext(_ensureCandidateDefaults(candidate, "glm", attempt), taskContext);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function generateCandidate(requirement, history, resolvedConfig, options = {}) {
  const attempt = options.attempt || 1;
  const useMock = isMockLlmEnabled(options);
  const taskContext = options.taskContext || {};

  if (useMock) {
    return { candidate: _buildHeuristicCandidate(requirement, attempt, taskContext), source: "heuristic_mock" };
  }

  const provider = resolvedConfig?.llm?.provider || "anthropic";
  if (
    provider === "anthropic"
    && !process.env.ANTHROPIC_API_KEY
  ) {
    console.error("[neo-cast] ANTHROPIC_API_KEY not set — falling back to heuristic candidate.");
    return { candidate: _buildHeuristicCandidate(requirement, attempt, taskContext), source: "heuristic_fallback:no_api_key" };
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
    return { candidate: _buildHeuristicCandidate(requirement, attempt, taskContext), source: `heuristic_fallback:${err.message.slice(0, 80)}` };
  }
}

module.exports = {
  generateCandidate,
  _buildHeuristicCandidate,
  _buildSystemPrompt,
  _buildUserMessage,
  _ensureCandidateDefaults,
  _extractJsonObject,
  _resolveLlmTimeoutMs,
  _taskHorizons,
  _withLlmTimeout,
};
