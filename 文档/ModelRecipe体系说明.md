# ModelRecipe / CandidateRecipe 体系说明

> 本文档总结 NeoResearch（neo_cast + opencode）当前的「模型配方」数据结构与流转路径，作为后续开发与 LLM Prompt 设计的参考。

## 1. 总览：两级配方结构

系统使用 **两层 DSL**：

```
ModelRecipe (model_recipe.v1)          ← LLM 面向的高层 DSL，字段少、易生成
        │  compile_model_recipe()
        ▼
CandidateRecipe (recipe_schema_v1)     ← 模块化低层配置，给 renderer / runner 用
        │  resolve_recipe()
        ▼
ResolvedCandidate (resolved_candidate.v1) ← 训练子进程实际读取的配置
```

关键文件：

| 文件 | 作用 |
|---|---|
| `neo_cast/py/model_recipe.py` | ModelRecipe → CandidateRecipe 编译逻辑 |
| `neo_cast/py/schemas/model_recipe_schema.json` | ModelRecipe JSON Schema |
| `neo_cast/py/schemas/model_recipe.example.json` | ModelRecipe 示例 |
| `neo_cast/py/schemas/recipe_schema.json` | CandidateRecipe JSON Schema |
| `neo_cast/py/schemas/recipe.example.json` | CandidateRecipe 示例（patch+mlp） |
| `neo_cast/py/registry/action_specs.py` | 各 action 的参数要求 / phase_min / bridge 支持 |
| `opencode/packages/opencode/src/research/domains/tsf.ts` | TS 端 Zod schema 与校验 |
| `opencode/packages/opencode/src/research/llm-proposal.ts` | LLM 生成候选 + `pruneCandidateSpec` 归一化 |
| `neo_cast/py/renderer.py` | CandidateRecipe → ResolvedCandidate（训练配置） |

---

## 2. ModelRecipe (model_recipe.v1) 字段

```json
{
  "schema_version": "model_recipe.v1",
  "model_name": "MultiScaleTinyForecaster",
  "hypothesis": "8~1200字，说明设计动机/数据特征/风险应对",
  "input": { ... },
  "architecture": { ... },
  "training": { ... },
  "constraints": { ... },
  "notes": "可选，≤2000字"
}
```

### 2.1 `input`
| 字段 | 类型 | 说明 |
|---|---|---|
| `history_window` | int 1-10000 | 输入回看窗口长度 |
| `prediction_horizon` | int 1-10000 | 主预测步长 |
| `prediction_horizons` | int[] 可选 | 多步长评估，需包含主 horizon |
| `covariates` | bool | 是否有外部协变量 |
| `known_future_covariates` | string[] 可选 | 已知未来协变量名称 |

### 2.2 `architecture`
| 字段 | 取值/范围 | 说明 |
|---|---|---|
| `backbone`（必填） | `linear / mlp / transformer / temporal_conv / dlinear / nbeats / timesnet / rnn / ssm / mixer` | 主干网络族 |
| `decomposition` | bool | 趋势-季节分解前处理；trendStrength≥0.2 或 seasonalityStrength≥0.4 时建议开启 |
| `decomposition_kernel` | int 2-255 | 分解核大小，默认 25 |
| `multiscale_blocks` | int 0-4 | 多尺度 patch 数；≥2 时自动切换为 multiscale_patch embedding |
| `attention` | `none / lightweight / full` | 注意力强度 |
| `embedding` | `auto / none / patch / multiscale_patch / invert / frequency / calendar` | `auto` 规则：linear→none，mlp/transformer→patch，dlinear/tcn/nbeats/timesnet→none |
| `channel_fusion` | `independent / shared / feature / gated_hybrid` | 多通道融合方式 |
| `hidden_dim` | int 8-4096 | 隐藏层维度 |
| `d_model` | int 8-1024 | embedding/transformer 维度 |
| `layers` | int 1-24 | 堆叠层数 |
| `heads` | int 1-32 | 注意力头数（transformer） |
| `kernel_size` | int 2-255 | 卷积/分解核大小 |
| `patch_len` / `stride` | int | patch embedding 参数 |
| `dropout` | 0.0-0.9 | dropout 比例 |
| `output_distribution` | `point / quantile / gaussian` | 输出分布类型 |

### 2.3 `training`
| 字段 | 范围 | 说明 |
|---|---|---|
| `loss` | `mse / mae / huber / quantile / distillation` | distillation 需附 teacher 配置（`type: last_value\|moving_average`, `window?`），`teacher_weight` / `supervised_weight` 控制蒸馏与监督信号比例 |
| `optimizer` | `adam / adamw / sgd` | |
| `learning_rate` | (0, 1.0] | |
| `weight_decay` | [0, 1.0] | |
| `batch_size` | 1-512 | |
| `max_epochs` | 1-1000 | |
| `time_budget_s` | ≥1 | 墙钟时间预算 |
| `patience` | 1-100 | 早停耐心 |
| `seed` | 0-2147483647 | |
| `grad_clip` | >0 可选 | 梯度裁剪阈值 |
| `warmup_ratio` | [0.0, 0.5]，默认 0.0 | 用前 `round(warmup_ratio * max_epochs)` 个 epoch 做线性 LR 预热（按 epoch 粒度），编译为 `training_strategy.scheduler.warmup_steps` |

### 2.4 `constraints`
| 字段 | 说明 |
|---|---|
| `max_params` | 整数或带单位字符串（`"5M"`, `"750K"`） |
| `latency_sensitive` | true 时 `max_latency_ms` 默认 50ms，否则 100ms |
| `max_latency_ms` | >0 可选，推理延迟预算（ms） |

---

## 3. CandidateRecipe (recipe_schema_v1) 结构

编译后的低层模块化配置，10 个顶层字段：

```typescript
interface TSFCandidateRecipe {
  recipeVersion: "recipe_schema_v1";
  recipeID?: string;            // ^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$
  hypothesis: string;           // 8-1200 字
  preprocessing: { actions: PreprocessingAction[] };
  embedding: Embedding;
  backbone: Backbone;
  fusion: Fusion;
  predictionHead: PredictionHead;
  trainingStrategy: TrainingStrategy;
  postProcessing?: { type: "auto" };
  constraints?: { maxParams?: int; maxLatencyMs?: number; latencyPriority?: "low"|"medium"|"high" };
  notes?: string;                // ≤2000字
}
```

### Backbone 名称映射 (BACKBONE_MAP)

```python
{
  "linear": "linear",
  "mlp": "mlp",
  "transformer": "transformer",
  "temporal_conv": "tcn",   # 注意：ModelRecipe 用 temporal_conv，编译后变 tcn
  "dlinear": "dlinear",
  "nbeats": "nbeats",
  "timesnet": "timesnet",
  "rnn": "rnn",
  "ssm": "ssm",
  "mixer": "mixer",
}
```

**Raw backbone**（必须 `embedding.type = "none"`）：`dlinear`、`tcn`、`nbeats`、`timesnet`，因为它们直接处理原始时间序列。

---

## 4. Action 注册表（phase_min / bridge_supported）

每个 action 都标注了「最低可用 phase」和「是否支持 bridge（快速冒烟）」。

### Preprocessing
| type | 关键参数 | phase_min | bridge |
|---|---|---|---|
| none | - | phase0b | ✓ |
| instance_norm | affine, eps | phase1 | ✗ |
| series_decomposition | kernel_size | phase1 | ✗ |
| seasonal_differencing | period, order | phase2 | ✗ |
| missing_mask | mask_channel, fill_policy | phase2 | ✗ |
| sample_reweighting | scheme (uniform/horizon_tail/outlier_robust) | phase2 | ✗ |

### Embedding
| type | 关键参数 | phase_min | bridge |
|---|---|---|---|
| none | - | phase0b | ✓ |
| patch | patch_len, stride, d_model | phase0b | ✓ |
| multiscale_patch | scales[], d_model | phase2 | ✗ |
| invert | d_model | phase2 | ✗ |
| frequency | n_freq, d_model, complex_mode | phase2 | ✗ |
| calendar | fields[], embed_dim | phase2 | ✗ |

### Backbone
| type | 关键参数 | phase_min | bridge | 备注 |
|---|---|---|---|---|
| linear | shared, bias | phase0b | ✓ | 单线性投影 |
| mlp | depth, hidden_dim, dropout | phase0b | ✓ | |
| transformer | d_model, n_heads, n_layers, dropout | phase0b | ✓ | 需 d_model % n_heads == 0 |
| dlinear | kernel_size, bias | phase2 | ✗ | 需 embedding=none |
| tcn | hidden_dim, n_layers, kernel_size, dropout | phase2 | ✗ | 需 embedding=none |
| nbeats | hidden_dim, n_blocks, n_layers, dropout | phase2 | ✗ | 需 embedding=none |
| timesnet | hidden_dim, n_layers, top_k, kernel_size, dropout | phase2 | ✗ | 需 embedding=none |
| rnn | hidden_dim, num_layers, cell(gru/lstm), dropout | phase2 | ✗ | |
| ssm | state_dim, depth, dropout | phase2 | ✗ | |
| mixer | hidden_dim, depth, temporal_mixing, channel_mixing, dropout | phase2 | ✗ | |

### Fusion
| type | 关键参数 | phase_min | bridge |
|---|---|---|---|
| temporal | channel_mode (independent/shared) | phase0b | ✓ |
| feature | variate_token, cross_attention | phase2 | ✗ |
| temporal_then_feature | gate, residual | phase2 | ✗ |
| feature_then_temporal | gate, residual | phase2 | ✗ |
| graph | adjacency_source, sparsity | phase2 | ✗ |
| gated_hybrid | gate_type (scalar/channel/time) | phase2 | ✗ |

### Prediction Head
| type | 关键参数 | phase_min | bridge | 输出分布 |
|---|---|---|---|---|
| linear | output_distribution | phase0b | ✓ | point |
| direct_multi_horizon | horizon_specific | phase2 | ✗ | point |
| quantile | quantiles[] | phase2 | ✗ | quantile |
| gaussian | variance_floor | phase2 | ✗ | gaussian |
| residual_correction | base_head, correction_dim | phase2 | ✗ | point |

### Loss / Optimizer / Scheduler
| Loss | phase_min | bridge |
|---|---|---|
| mse | phase0b | ✓ |
| mae | phase1 | ✗ |
| huber (delta) | phase1 | ✗ |
| quantile (quantiles[]) | phase2 | ✗ |
| distillation (teacher config) | phase2 | ✗ |

| Optimizer | phase_min | bridge |
|---|---|---|
| adam / adamw | phase0b | ✓ |
| sgd | phase1 | ✗ |

| Scheduler | phase_min | bridge |
|---|---|---|
| none | phase0b | ✓ |
| cosine | phase1 | ✗ |
| one_cycle / plateau | phase2 | ✗ |

### Bridge 限定组合
Bridge（Phase A/B 快速冒烟，分钟级）仅支持：
- preprocessing = none
- fusion.channel_mode = independent
- (embedding, backbone) ∈ { (none, linear), (patch, mlp), (patch, transformer) }

完整 recipe（其余组合）走 neo-cast Python native factory，分钟~小时级。

---

## 5. 示例

### 5.1 ModelRecipe 示例
```json
{
  "schema_version": "model_recipe.v1",
  "model_name": "MultiScaleTinyForecaster",
  "hypothesis": "A compact temporal convolution with decomposition should capture local multiscale dynamics under deployment constraints.",
  "input": {
    "history_window": 96,
    "prediction_horizon": 24,
    "prediction_horizons": [24],
    "covariates": true
  },
  "architecture": {
    "backbone": "temporal_conv",
    "decomposition": true,
    "multiscale_blocks": 3,
    "attention": "lightweight",
    "hidden_dim": 32,
    "kernel_size": 3,
    "dropout": 0.1
  },
  "training": {
    "loss": "mse",
    "optimizer": "adamw",
    "learning_rate": 0.001,
    "batch_size": 64,
    "max_epochs": 8,
    "time_budget_s": 600,
    "patience": 4,
    "seed": 42
  },
  "constraints": {
    "max_params": "5M",
    "latency_sensitive": true
  }
}
```

### 5.2 CandidateRecipe 示例（patch + mlp）
```json
{
  "recipe_version": "recipe_schema_v1",
  "recipe_id": "recipe_patch_mlp_temporal_example",
  "hypothesis": "Patch MLP can capture local temporal motifs with lower latency than attention while keeping the training budget small.",
  "preprocessing": { "actions": [{ "type": "none" }] },
  "embedding": { "type": "patch", "patch_len": 16, "stride": 8, "d_model": 128 },
  "backbone": { "type": "mlp", "depth": 2, "hidden_dim": 128, "activation": "gelu", "dropout": 0.1 },
  "fusion": { "type": "temporal", "channel_mode": "independent" },
  "prediction_head": { "type": "linear", "output_distribution": "point" },
  "training_strategy": {
    "loss": { "base": "mse", "horizon_weighting": "uniform" },
    "optimizer": { "type": "adam", "lr": 0.001, "weight_decay": 0.0 },
    "scheduler": { "type": "none", "warmup_steps": 0 },
    "regularization": { "dropout": 0.1, "grad_clip": 1.0 },
    "budget": { "max_epochs": 2, "time_budget_s": 600, "batch_size": 16, "patience": 2, "seed": 42 }
  },
  "constraints": { "max_params": 1000000, "max_latency_ms": 50, "latency_priority": "medium" },
  "notes": "Example native recipe-factory candidate."
}
```

### 5.3 CandidateRecipe 示例（DLinear，raw backbone）
```json
{
  "recipe_version": "recipe_schema_v1",
  "recipe_id": "recipe_dlinear_example",
  "hypothesis": "DLinear tests whether explicit moving-average trend decomposition plus linear seasonal/trend heads improves a compact ETTh-style forecasting baseline.",
  "preprocessing": { "actions": [{ "type": "none" }] },
  "embedding": { "type": "none" },
  "backbone": { "type": "dlinear", "kernel_size": 25, "bias": true },
  "fusion": { "type": "temporal", "channel_mode": "independent" },
  "prediction_head": { "type": "linear", "output_distribution": "point" },
  "training_strategy": {
    "loss": { "base": "mse", "horizon_weighting": "uniform" },
    "optimizer": { "type": "adam", "lr": 0.001, "weight_decay": 0.0 },
    "scheduler": { "type": "none", "warmup_steps": 0 },
    "regularization": { "dropout": 0.0, "grad_clip": 1.0 },
    "budget": { "max_epochs": 2, "time_budget_s": 120, "batch_size": 16, "patience": 2, "seed": 42 }
  },
  "constraints": { "max_params": 1000000, "max_latency_ms": 50, "latency_priority": "medium" },
  "notes": "DLinear requires embedding.type=none because it operates directly on raw per-channel sequences."
}
```

---

## 6. ResolvedCandidate（renderer.py 输出）

`resolve_recipe()` 把 CandidateRecipe 渲染成训练子进程可直接消费的配置：

```json
{
  "schema_version": "resolved_candidate.v1",
  "candidate_id": "recipe_...",
  "hypothesis": "...",
  "model_family": "recipe_factory",
  "model_config": {
    "recipe": "<compiled CandidateRecipe>",
    "num_channels": "<task.dataset.targetCount>"
  },
  "train_config": {
    "lr": "<training_strategy.optimizer.lr>",
    "batch_size": "<training_strategy.budget.batch_size>",
    "max_epochs": "<training_strategy.budget.max_epochs>",
    "weight_decay": "<training_strategy.optimizer.weight_decay>",
    "patience": "<training_strategy.budget.patience>",
    "seed": "<training_strategy.budget.seed>"
  },
  "constraints": {
    "param_budget_m": "<max_params> / 1_000_000",
    "time_budget_s": "<time_budget_s>",
    "latency_priority": "medium | high"
  },
  "smoke_config": {
    "horizon": "<first prediction_horizon>",
    "batch_size": 16,
    "max_epochs": 2,
    "timeout_s": 60
  },
  "task": {
    "task_id": "<dataset_loader_id>",
    "input_len": "<history_window>",
    "horizons": "<prediction_horizons>",
    "num_channels": "<target_count>"
  },
  "recipe": "<compiled CandidateRecipe>",
  "model_recipe": "<original ModelRecipe (若来源于此)>"
}
```

---

## 7. 端到端流转

```
用户/Socratic 需求
  → LLM 生成候选 (proposeLLMCandidate, snake_case JSON)
  → pruneCandidateSpec 归一化
      - snake_case → camelCase
      - 去除未知字段
      - 按 backbone/embedding 域约束补默认值
  → validateTSFCandidate (Zod schema 校验)
  → DomainCandidateProposal { candidateSpec, rationale, riskLevel, approvalStatus }
  → createTSFRunPlan
      - 写入 .neo-cast/current_candidate.json
      - 生成 runner 子进程命令
  → neo-cast-runner 子进程
      - renderer.py: resolve_recipe() → resolved_candidate.json
      - py/runner.py: smoke (60s) → run (≤600s)
      - 结果写入 .neo-cast/results.tsv 与 artifacts/run_<id>/
  → opencode Research Service 读取 DB + 事件
  → TUI cockpit / Web dashboard 展示
```

---

## 8. 设计要点小结

1. **两级 DSL**：ModelRecipe（高层，少字段，适合 LLM 生成）→ CandidateRecipe（模块化，确定性编译）。
2. **Phase 门控**：`phase0b`（bridge 冒烟）→ `phase1` → `phase2`，逐步放开复杂模块（mae/huber loss、cosine 调度器、高级 embedding/backbone/fusion）。
3. **Bridge 安全子集**：仅 `(none,linear)` / `(patch,mlp)` / `(patch,transformer)` + `fusion=temporal/independent` + `preprocessing=none` 可在 bridge 上分钟级跑通，用于早期可行性反馈。
4. **自动补全**：编译阶段为缺失数值字段填充合理默认值（如 `d_model` 默认 64），降低 LLM 生成负担。
5. **Raw backbone 约束**：`dlinear / tcn / nbeats / timesnet` 必须搭配 `embedding.type = "none"`，因为它们直接处理原始序列，与 patch/invert/frequency 等 embedding 不兼容。
