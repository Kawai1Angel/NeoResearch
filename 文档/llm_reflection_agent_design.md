# LLM 反思 Agent 设计方案

## 背景与动机

当前 NeoResearch 的 design loop 在 attempt > 1 时只使用 `mutate.py` 的规则链做下一步候选生成。规则是固定阈值的 if/else，不理解"为什么这个模型在 h720 上表现差但在 h96 上还行"。

**问题的具体表现**：5 次历史实验全部产出相同的 `linear+none` backbone，val_avg_mse 精确相同到 6 位小数，说明探索完全没有发生。原因是 `mutate.py` 里 `poor_val_mse=1.1` 的阈值正好高于 linear 的 1.0918，mutation 认为"还不够差，不需要切架构"。

**目标**：在每次训练结束后，用 LLM 分析本次运行的结果（per-horizon metrics、训练曲线、recipe 结构），产出对失败原因的推断，并生成下一个有针对性的候选 recipe。

**实现后效果对比**：

| 字段 | 当前 | 实现后 |
|---|---|---|
| `hypothesis` | `"DLinear: decomposes trend and seasonal..."` | `"h720 MSE 比 h96 高 2.2x，说明 linear 没有捕获长程依赖；切换到 patch_transformer 扩大感受野，同时加 instance_norm 稳定长 horizon 训练"` |
| `candidate_source` | `mutation_policy` | `llm_reflection` |
| 架构多样性 | 5 次相同 | 每轮不同，有推理链 |

---

## 涉及文件

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `py/runner.py` | 修改 | `run_experiment()` 里捕获 `epoch_end` 事件，写 `training_curves.json` |
| `src/reflect.js` | **新建** | LLM 反思 agent 核心逻辑 |
| `src/python-bridge.js` | 修改 | 新增 `loadArtifactData(projectRoot, runId)` |
| `src/cli.js` | 修改 | 新增 `--use-reflection` flag，接入 design loop |

---

## Step 1：保存 training_curves.json（`py/runner.py`）

### 背景

`train.py` 训练过程中每个 epoch 结束都会向 stdout emit：
```json
{"event": "epoch_end", "horizon": 96, "epoch": 3, "val_loss": 0.712}
```

`_run_and_capture()` 已经把所有 NDJSON records 收集进 `train_records` 列表，但当前没有持久化。

### 改动位置

`run_experiment()` 函数内，**训练成功检测通过后、调用 `_export_artifact` 之前**（当前代码约 355-359 行之间）。

### 改动代码

```python
# 在 training_summary 解析之后、export_exit 调用之前插入：
epoch_records = [r for r in train_records if r.get("event") == "epoch_end"]
if epoch_records and artifact_dir is not None:
    curves: dict[str, list[float]] = {}
    for r in epoch_records:
        h = str(r.get("horizon", "unknown"))
        curves.setdefault(h, []).append(float(r.get("val_loss", 0.0)))
    try:
        training_curves_path = artifact_dir / "training_curves.json"
        training_curves_path.write_text(
            f"{json.dumps({'curves_by_horizon': curves}, indent=2)}\n",
            encoding="utf-8",
        )
    except OSError:
        pass  # 写失败不影响主流程
```

### 产出文件结构

```json
{
  "curves_by_horizon": {
    "96":  [0.724, 0.712, 0.703, 0.698, 0.694],
    "192": [0.961, 0.948, 0.940],
    "336": [1.210, 1.204],
    "720": [1.518, 1.514, 1.511]
  }
}
```

曲线长度不等（早停时间不同），反思 agent 可以从中判断：收敛速度、是否平台、长短 horizon 差异。

---

## Step 2：新建 `src/reflect.js`

### 整体架构

```
reflectAndPropose()
  ├── mock 路径 → buildHeuristicCandidate（复用 llm.js）
  └── 真实 LLM 路径：
        loadArtifactData()  ← python-bridge.js
        buildReflectionContext()
        _buildReflectionSystemPrompt()
        _buildReflectionUserMessage()
        LLM API call（Anthropic / OpenAI-compatible）
        _ensureCandidateDefaults()  ← 复用 llm.js
        → { candidate, source: "llm_reflection" }
```

### 2a. `buildReflectionContext()`

```js
function buildReflectionContext(previousCandidate, previousRow, history, artifactData) {
  return {
    previous_recipe: {
      backbone:      previousCandidate.backbone      ?? null,
      embedding:     previousCandidate.embedding     ?? null,
      preprocessing: previousCandidate.preprocessing ?? null,
      fusion:        previousCandidate.fusion        ?? null,
      prediction_head: previousCandidate.prediction_head ?? null,
    },
    previous_result: {
      status:       previousRow.status,
      val_avg_mse:  Number(previousRow.val_avg_mse)  || null,
      val_h96_mse:  Number(previousRow.val_h96_mse)  || null,
      val_h720_mse: Number(previousRow.val_h720_mse) || null,
      params_M:     Number(previousRow.params_M)     || null,
    },
    training_curves:  artifactData?.training_curves  ?? null,
    training_summary: artifactData?.training_summary ?? null,
    experiment_history: history.slice(-6).map((r) => ({
      candidate_id:  r.candidate_id,
      model_family:  r.model_family,
      val_avg_mse:   r.val_avg_mse  === "NA" ? null : Number(r.val_avg_mse),
      val_h96_mse:   r.val_h96_mse  === "NA" ? null : Number(r.val_h96_mse),
      val_h720_mse:  r.val_h720_mse === "NA" ? null : Number(r.val_h720_mse),
      status:        r.status,
    })),
  };
}
```

### 2b. System Prompt（反思专用）

与 `llm.js` 的设计 prompt 完全分开。重点不是"选一个模型"，而是"分析失败原因"。同时包含**完整 action space（含 rnn/ssm/mixer）**，解决之前 prompt 与 factory 能力不对齐的问题。

```
You are a time-series model design critic for the neo-cast system.
Your job is NOT to pick a model from a predefined list —
your job is to reason about WHY the previous model performed as it did,
and propose ONE better successor recipe based on that reasoning.

## Task context
{task_context_lines}

## Analysis protocol (follow in order)
1. Examine the previous recipe: backbone, embedding, preprocessing, fusion, head.
2. Look at per-horizon validation metrics. Is the h720/h96 gap large? Does MSE grow
   super-linearly with horizon? Does the model underperform on short or long horizons?
3. If training_curves are provided:
   - Fast drop then plateau → capacity bottleneck or LR too low
   - Oscillation → LR too high or batch size too small
   - h720 diverges while h96 converges → long-horizon gradient interference
   - All horizons flat from epoch 1 → model lacks expressiveness
4. Identify the ONE primary bottleneck: architecture capacity, temporal receptive field,
   normalization, channel interaction, or optimization dynamics.
5. Propose a recipe that directly addresses this bottleneck. Be specific about what
   changed and why.

## Full supported action space

### preprocessing.actions (list, at least one):
- { "type": "none" }
- { "type": "instance_norm", "affine": false, "eps": 1e-5 }
- { "type": "series_decomposition", "method": "moving_average", "kernel_size": 25 }
- { "type": "seasonal_differencing", "period": 24, "order": 1 }
- { "type": "missing_mask", "mask_channel": true, "fill_policy": "mean" }
- { "type": "sample_reweighting", "scheme": "uniform"|"horizon_tail"|"outlier_robust" }

### embedding:
- { "type": "none" }
- { "type": "patch", "patch_len": 8|16|32, "stride": ≤patch_len, "d_model": 32|64|128|256 }
- { "type": "multiscale_patch", "scales": [...], "d_model": 32|64|128 }
- { "type": "invert", "d_model": 16|32|64 }
- { "type": "frequency", "n_freq": 4|8|16|32, "d_model": 16|32|64, "complex_mode": "real_imag"|"magnitude" }
- { "type": "calendar", "fields": ["hour","dayofweek","day","month","position"], "embed_dim": 8|16|32 }

### backbone:
- { "type": "linear", "shared": false, "bias": true }
- { "type": "mlp", "depth": 1|2|3, "hidden_dim": 64|128|256, "activation": "gelu", "dropout": 0.0|0.1 }
- { "type": "transformer", "d_model": 32|64|128, "n_heads": 1|2|4|8, "n_layers": 1|2|3, "dropout": 0.0|0.1, "ffn_mult": 2.0|4.0 }
- { "type": "rnn", "cell": "gru"|"lstm", "hidden_dim": 32|64|128, "num_layers": 1|2, "dropout": 0.0|0.1 }
- { "type": "dlinear", "kernel_size": 25, "bias": true }  [requires embedding none]
- { "type": "tcn", "hidden_dim": 16|32|64, "n_layers": 1|2|3, "kernel_size": 3|5, "activation": "gelu", "dropout": 0.0|0.1 }  [requires embedding none]
- { "type": "nbeats", "hidden_dim": 64|128|256, "n_blocks": 2|3|4, "n_layers": 2|3, "activation": "gelu", "dropout": 0.0|0.1 }  [requires embedding none]
- { "type": "timesnet", "hidden_dim": 8|16|32, "n_layers": 1|2, "top_k": 1|2, "kernel_size": 3|5, "dropout": 0.0|0.1 }  [requires embedding none]
- { "type": "ssm", "state_dim": 16|32|64, "depth": 1|2|3, "dropout": 0.0|0.1 }
- { "type": "mixer", "hidden_dim": 32|64|128, "depth": 1|2|3, "temporal_mixing": "mlp"|"conv", "channel_mixing": "mlp"|"identity", "dropout": 0.0|0.1 }

### fusion:
- { "type": "temporal", "channel_mode": "independent"|"shared" }
- { "type": "feature" }
- { "type": "temporal_then_feature" }
- { "type": "feature_then_temporal" }
- { "type": "graph", "graph_type": "learned" }
- { "type": "gated_hybrid", "gate_type": "learned"|"scalar"|"channel"|"time" }

### prediction_head:
- { "type": "linear", "output_distribution": "point", "share_across_horizons": false }
- { "type": "direct_multi_horizon", "output_distribution": "point", "horizon_specific": true }
- { "type": "quantile", "output_distribution": "quantile", "quantiles": [0.1,0.5,0.9] }
- { "type": "gaussian", "output_distribution": "gaussian", "variance_floor": 0.0001 }
- { "type": "residual_correction", "output_distribution": "point", "base_head": "linear", "correction_dim": 16 }

### training_strategy:
- loss.base: "mse"|"mae"|"huber"|"quantile"|"distillation"
- optimizer.type: "adam"|"adamw"|"sgd"
- scheduler.type: "none"|"cosine"|"one_cycle"|"plateau"
- budget: { max_epochs: 10–100, time_budget_s: ≤600, batch_size: 16|32|64, patience: 3–10, seed: 42 }

## Output format
Return a single JSON object. No markdown, no explanation outside the JSON.

Required fields: recipe_version, recipe_id, hypothesis, preprocessing, embedding,
backbone, fusion, prediction_head, post_processing, training_strategy, constraints

The hypothesis field MUST follow this format (max 1200 chars):
"Previous [backbone+embedding]: [observed metric pattern]. 
 Diagnosis: [root cause]. 
 Proposed change: [what changed] because [why this addresses the bottleneck]."

constraints: { "max_params": 1000000, "max_latency_ms": 50, "latency_priority": "medium" }
```

### 2c. `reflectAndPropose()` 主函数

```js
async function reflectAndPropose(requirement, history, previousRow, resolvedConfig, options = {}) {
  const { projectRoot, mockLlm, taskContext, attempt = 2 } = options;

  // mock 路径：复用 llm.js 的启发式候选，不调 API
  if (mockLlm) {
    const { _buildHeuristicCandidate, _ensureCandidateDefaults } = require("./llm");
    const candidate = _buildHeuristicCandidate(requirement, attempt);
    _ensureCandidateDefaults(candidate, "reflect_mock", attempt);
    return { candidate, source: "heuristic_mock" };
  }

  // 加载上一轮 artifact 数据
  const { loadArtifactData } = require("./python-bridge");
  const artifactData = previousRow?.run_id
    ? loadArtifactData(projectRoot, previousRow.run_id)
    : null;

  // 加载上一轮 recipe
  const recipePath = path.join(projectRoot, ".neo-cast", "current_candidate.json");
  let previousCandidate = {};
  try {
    previousCandidate = JSON.parse(fs.readFileSync(recipePath, "utf8"));
  } catch (_) {}

  const context = buildReflectionContext(previousCandidate, previousRow || {}, history, artifactData);
  const systemPrompt = _buildReflectionSystemPrompt(taskContext);
  const userMessage = JSON.stringify({
    user_requirement: requirement,
    attempt,
    reflection_context: context,
    instruction: "Analyze the previous result and propose an improved recipe. Return JSON only.",
  }, null, 2);

  try {
    const provider = resolvedConfig?.llm?.provider || "anthropic";
    let rawCandidate;
    if (provider === "anthropic") {
      rawCandidate = await _callAnthropic(systemPrompt, userMessage, resolvedConfig);
    } else {
      rawCandidate = await _callOpenAICompatible(systemPrompt, userMessage, resolvedConfig);
    }
    const { _ensureCandidateDefaults } = require("./llm");
    _ensureCandidateDefaults(rawCandidate, "reflect", attempt);
    return { candidate: rawCandidate, source: "llm_reflection" };
  } catch (err) {
    console.error(`[neo-cast] reflection LLM call failed (attempt ${attempt}): ${err.message}`);
    return null;  // 调用方负责 fallback
  }
}

module.exports = { reflectAndPropose };
```

---

## Step 3：`src/python-bridge.js` 新增 `loadArtifactData`

```js
function loadArtifactData(projectRoot, runId) {
  const artifactDir = path.join(projectRoot, ".neo-cast", "artifacts", `run_${runId}`);
  const result = {};
  const curvesPath  = path.join(artifactDir, "training_curves.json");
  const summaryPath = path.join(artifactDir, "training_summary.json");
  try { result.training_curves  = JSON.parse(fs.readFileSync(curvesPath,  "utf8")); } catch (_) {}
  try { result.training_summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")); } catch (_) {}
  return Object.keys(result).length > 0 ? result : null;
}
```

同时在 `module.exports` 末尾追加 `loadArtifactData`。

---

## Step 4：`src/cli.js` 接入

### 4a. 更新 printHelp

```
neo-cast design --requirement "..." [--mode socratic|companion] [--max-candidates 3]
                [--mock-llm] [--use-mutation] [--use-reflection] [--force-all-candidates]
```

新增一行说明：
```
  --use-reflection   After each run, call LLM to analyze results and propose the next candidate
                     (takes priority over --use-mutation; falls back to mutation on LLM failure)
```

### 4b. design loop 逻辑替换

当前代码（约 413 行）：
```js
if (attempt > 1 && rawFlags["use-mutation"]) {
  // 规则 mutation ...
} else {
  result = await generateCandidate(...);
}
```

替换为：
```js
if (attempt > 1 && rawFlags["use-reflection"]) {
  const { reflectAndPropose } = require("./reflect");
  const reflected = await reflectAndPropose(
    requirementBundle.requirementText,
    history,
    previousRow,
    configResult.resolved,
    {
      projectRoot,
      mockLlm: Boolean(rawFlags["mock-llm"]),
      taskContext,
      attempt,
    }
  );

  if (reflected) {
    result = reflected;
  } else if (rawFlags["use-mutation"]) {
    // reflection 失败 → fallback 到规则 mutation
    try {
      const candidate = mutateCandidate(projectRoot, {
        metricsPath: latestValMetricsPath(projectRoot, previousRow),
        index: attempt - 1,
      });
      result = { candidate, source: "mutation_policy" };
    } catch (mutateError) {
      console.error(`[neo-cast] mutation also failed: ${mutateError.message}`);
      result = await generateCandidate(
        requirementBundle.requirementText, history, configResult.resolved,
        { attempt, mockLlm: Boolean(rawFlags["mock-llm"]), taskContext }
      );
    }
  } else {
    // 两者都没有 → 重新 LLM 生成
    result = await generateCandidate(
      requirementBundle.requirementText, history, configResult.resolved,
      { attempt, mockLlm: Boolean(rawFlags["mock-llm"]), taskContext }
    );
  }

} else if (attempt > 1 && rawFlags["use-mutation"]) {
  // 原有 mutation 逻辑不变
  try {
    const candidate = mutateCandidate(projectRoot, {
      metricsPath: latestValMetricsPath(projectRoot, previousRow),
      index: attempt - 1,
    });
    result = { candidate, source: "mutation_policy" };
  } catch (error) {
    console.error(`[neo-cast] mutation failed: ${error.message}`);
    result = await generateCandidate(
      requirementBundle.requirementText, history, configResult.resolved,
      { attempt, mockLlm: Boolean(rawFlags["mock-llm"]), taskContext }
    );
  }

} else {
  result = await generateCandidate(
    requirementBundle.requirementText, history, configResult.resolved,
    { attempt, mockLlm: Boolean(rawFlags["mock-llm"]), taskContext }
  );
}
```

---

## 数据流（改后全貌）

```
attempt 1
  generateCandidate(requirement)
    → recipe JSON (recipe_schema_v1)
  writeCurrentCandidate()
    → .neo-cast/current_candidate.json
  runRunner()
    → train.py emit epoch_end × N
    → runner.py 过滤 → training_curves.json
    → export.py → artifact bundle (17 files)
  loadResults() → history 更新
  getLatestSessionRow() → previousRow

attempt 2 with --use-reflection
  loadArtifactData(projectRoot, previousRow.run_id)
    → training_curves.json   (per-epoch val_loss per horizon)
    → training_summary.json  (backbone, params, training_seconds...)
  fs.readFileSync(current_candidate.json) → previousCandidate (recipe)
  buildReflectionContext(previousCandidate, previousRow, history, artifactData)
    → {previous_recipe, previous_result, training_curves, experiment_history}
  LLM call (Anthropic / OpenAI-compatible)
    system: 反思分析框架 + 完整 action space (10 backbones)
    user:   反思上下文 JSON
    → recipe_schema_v1 (hypothesis 含推理链)
  _ensureCandidateDefaults()
    → { candidate, source: "llm_reflection" }
  writeCurrentCandidate()
  runRunner() → ...

fallback chain (reflection 失败时)
  --use-mutation set → mutateCandidate() → mutation_policy
  --use-mutation not set → generateCandidate() → llm / heuristic_fallback
```

---

## 验证方法

### 1. training_curves.json 生成验证（无 GPU）

```bash
cd neo_cast
export NEO_CAST_FAST_E2E=1

node bin/neo-cast.js runner run \
  --description "curves generation test" \
  --skip-smoke

# 期望：
ls .neo-cast/artifacts/run_*/training_curves.json
cat .neo-cast/artifacts/run_$(ls .neo-cast/artifacts/ | tail -1)/training_curves.json
# 应看到 curves_by_horizon 含 "96", "192", "336", "720" 四个 key，每个值是浮点数组
```

### 2. reflection 框架接通验证（mock 模式，不调 API）

```bash
export NEO_CAST_FAST_E2E=1

node bin/neo-cast.js design \
  --requirement "patch transformer for etth1" \
  --mode companion \
  --max-candidates 2 \
  --mock-llm \
  --use-reflection

# 期望输出：
# attempt=1: candidate_source=heuristic_mock
# attempt=2: candidate_source=heuristic_mock （mock 路径，不崩溃）
```

### 3. 真实 LLM 验证

```bash
export NEO_CAST_LLM_API_KEY="your-aigcbest-key"
export NEO_CAST_FAST_E2E=1

node bin/neo-cast.js design \
  --requirement "improve over linear baseline, focus on reducing h720 MSE" \
  --mode companion \
  --max-candidates 3 \
  --use-reflection \
  --force-all-candidates

# 期望：
# attempt=2: candidate_source=llm_reflection
# hypothesis 字段引用了 val_h720_mse 数值和上一轮 backbone 名称
# recipe 的 backbone 与 attempt=1 不同
```

### 4. 退化链验证（API key 缺失）

```bash
unset NEO_CAST_LLM_API_KEY
export NEO_CAST_FAST_E2E=1

node bin/neo-cast.js design \
  --requirement "test fallback chain" \
  --mode companion \
  --max-candidates 2 \
  --use-reflection \
  --use-mutation

# 期望：
# attempt=2: reflection 失败 → source=mutation_policy
# 全程不崩溃
```

---

## 注意事项

| 事项 | 处理方式 |
|---|---|
| `_ensureCandidateDefaults` 不重复实现 | `reflect.js` 通过 `require("./llm")` 引入 |
| `training_curves.json` 不存在（旧 artifact）| 反思 agent 降级为仅凭 metrics 分析，不影响运行 |
| `previousRow` 为 null（attempt=2 但无 session 记录）| `buildReflectionContext` 对所有字段做 null 防御 |
| reflection system prompt 的 action space | 必须包含完整 10 种 backbone（含 rnn/ssm/mixer），同时修复之前 llm.js 的 prompt 缺口 |
| `--use-reflection` 与 `--use-mutation` 组合 | reflection 优先，失败则 mutation 兜底，再失败则 generateCandidate |
| token 用量 | reflection prompt 含完整 action space + context JSON，约 1500-2000 tokens；输出约 800 tokens |

---

## 后续扩展方向

1. **多轮记忆**：reflection 不只看最近 1 轮，而是分析整个 session 的 keep/discard 模式，输出"已排除的架构列表"
2. **训练曲线分类器**：在 Python 侧对曲线做结构化分析（收敛速度、plateau epoch、h720/h96 gap 斜率），把结论作为符号化信号传给 LLM，减少 LLM 看数组的 token 消耗
3. **Surrogate Predictor**：基于历史 (recipe, val_avg_mse) 对训练一个代理模型，reflection 可以先向代理预测候选性能再决策，避免每次都真实训练
