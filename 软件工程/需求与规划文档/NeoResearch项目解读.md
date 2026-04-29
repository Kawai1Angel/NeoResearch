# NeoResearch 项目解读

生成日期：2026-04-28（基于代码实际读取）

---

## 1. 一句话定位

`neo-research` 是一个面向**时间序列预测自动研究**的工程工作区。核心项目 `neo_cast` 实现了一个完整的闭环：给定时序数据和自然语言需求，系统通过 LLM 生成模块化模型 recipe，编译为 PyTorch 模型，自动训练评估，keep/discard 最优候选，并导出包含推理代码与评测报告的研究 artifact。

`opencode/` 是通用 AI coding agent 的参考源码，不参与 `neo_cast` 当前运行，作为后续 agent runtime 工程化的参照。

---

## 2. 根目录结构

```text
neo-research/
├── CLAUDE.md               # Agent 工作说明（仍描述 autoresearch，已与实际代码偏差）
├── neo_cast/               # 当前主实现
└── opencode/               # 通用 agent 参考源码副本
```

---

## 3. `neo_cast/` 完整目录

```text
neo_cast/
├── bin/neo-cast.js          # CLI 入口
├── src/
│   ├── cli.js               # 命令路由
│   ├── config.js            # 配置解析
│   ├── doctor.js            # 环境检查
│   ├── llm.js               # LLM 候选生成 + heuristic fallback
│   ├── python-bridge.js     # Node -> Python subprocess 桥接
│   ├── runtime.js           # venv 初始化
│   ├── session.js           # 读取 results.tsv
│   ├── output.js            # 打印摘要
│   └── modes/
│       ├── socratic.js      # 需求澄清模式
│       └── companion.js     # 多轮实验伴随模式
├── py/
│   ├── prepare_tsf.py       # 冻结评估协议（数据、切分、指标）
│   ├── dataset_contract.py  # dataset.v1 协议定义
│   ├── train.py             # 候选驱动训练入口
│   ├── runner.py            # session state、keep/discard、结果记录
│   ├── validate.py          # JSON Schema + registry + smoke gate 校验
│   ├── renderer.py          # candidate -> resolved candidate
│   ├── export.py            # artifact 导出
│   ├── recipe_bridge.py     # 统一 model_family 路由入口
│   ├── blind_test_sidecar.py # 盲测 HTTP sidecar 服务
│   ├── factory/
│   │   └── build_model.py   # RecipeModel：recipe -> PyTorch model 编译器
│   ├── families/
│   │   ├── nlinear.py       # legacy NLinear family
│   │   ├── patch_mlp.py     # legacy PatchMLP family
│   │   ├── tiny_transformer.py # legacy TinyTransformer family
│   │   └── recipe_factory.py   # 转发到 factory/build_model.py
│   ├── registry/
│   │   └── action_specs.py  # 合法 action 注册表 + phase 标记
│   ├── search/
│   │   └── mutate.py        # 规则驱动的 recipe mutation
│   ├── schemas/             # JSON Schema 定义 + 示例
│   └── tests/               # e2e + unit 测试
├── docs/                    # 协议文档
├── benchmarks/tsf_benchmark_manifest.json
├── results.tsv              # 实验结果记录（当前为空）
├── package.json             # Node.js 依赖
└── pyproject.toml           # Python 依赖
```

---

## 4. 核心数据流：一次完整实验的过程

```text
用户输入 --requirement "..."
         ↓
[Node.js] llm.js
  generateCandidate()
  → 调用 Anthropic API 或 heuristic fallback
  → 输出 recipe_schema_v1 JSON
         ↓
[Node.js] python-bridge.js
  → 写入 .neo-cast/current_candidate.json
         ↓
[Python] validate.py
  → JSON Schema 校验（recipe_schema.json）
  → registry 合法性校验（action_specs.py）
  → smoke run（2 epoch 冒烟训练）
         ↓
[Python] train.py
  → 加载 resolved_candidate.json
  → build_model(recipe, input_len, horizon)
  → 标准训练循环（早停 + 时间预算）
  → 发射 NDJSON 事件流
         ↓
[Python] runner.py
  → 读取 val_avg_mse
  → 与 best_val_avg_mse 比较
  → keep → 更新 runner_state.json
  → discard → 不更新 best
  → 追加行到 results.tsv
         ↓
[Python] export.py
  → 生成 artifact 包：
      model.pt
      preprocess.json
      model_impl.py
      inference.py
      eval_report.md
      model_spec.json
      patch_bundle.json
         ↓
[Python] runner.py --ref-test
  → 对 best artifact 做最终 ref_test 报告
```

---

## 5. 核心组件一：`factory/build_model.py` — Recipe Compiler

这是整个系统最重要的 Python 文件，约 1240 行。

它实现了 `RecipeModel(nn.Module)`：接受一个 `recipe_schema_v1` JSON，直接编译成可训练的 PyTorch 模型。

### 5.1 支持的 Action Space（实际代码）

**Preprocessing（支持链式组合）**

| Action | 实现类 | 说明 |
|--------|--------|------|
| `none` | `NoOpPreprocessing` | 无预处理 |
| `instance_norm` | `InstanceNormAction` | 实例归一化（支持 affine） |
| `series_decomposition` | `SeriesDecompositionAction` | 移动平均分解趋势/季节 |
| `seasonal_differencing` | `SeasonalDifferencingAction` | 季节差分（支持 order） |
| `missing_mask` | `MissingMaskAction` | 缺失值填补（zero/mean/ffill） + 可选 mask channel |
| `sample_reweighting` | `SampleReweightingAction` | 样本重权（hook 占位） |

Preprocessing 有配对的 `forward_transform / inverse_transform`，支持链式前向和反向恢复。

**Embedding**

| Action | 实现类 | 说明 |
|--------|--------|------|
| `none` | 直接序列或 `SequenceEmbedding` | 无嵌入 |
| `patch` | `PatchEmbedding` | 标准 patch 切片 |
| `multiscale_patch` | `MultiScalePatchEmbedding` | 多尺度 patch（2-4 个 scale） |
| `invert` | `InvertEmbedding` | 变量维度转置嵌入（invert embedding） |
| `frequency` | `FrequencyEmbedding` | FFT 频域嵌入（支持 magnitude / real_imag） |
| `calendar` | `CalendarEmbedding` | 日历时间特征嵌入（hour/dayofweek/month 等） |

**Backbone**

| Action | 实现类 | 说明 |
|--------|--------|------|
| `linear` | `nn.Linear` | 直接线性映射 |
| `mlp` | `ResidualMLPBlock` 堆叠 | 残差 MLP |
| `transformer` | `nn.TransformerEncoder` | Pre-norm Transformer |
| `rnn` | `nn.GRU/LSTM/RNN` | RNN（支持 gru/lstm/rnn cell） |
| `dlinear` | `DLinearCore` | 分解线性（趋势+季节各一个线性层） |
| `tcn` | `TCNCore` | 因果膨胀卷积（指数膨胀 dilation） |
| `nbeats` | `NBeatsCore` | N-BEATS（backcast + forecast block 堆叠） |
| `timesnet` | `TimesNetLiteCore` | TimesNet lite（FFT 周期检测 + 2D conv） |
| `ssm` | `SSMTokenBlock` 堆叠 | 类 SSM（深度可分卷积 + gating） |
| `mixer` | `TokenMixerBlock` 堆叠 | MLP-Mixer（token mixing + feature mixing） |

**Fusion（Channel 混合方式）**

| Action | 实现类 | 说明 |
|--------|--------|------|
| `temporal / independent` | `nn.Identity` | channel 独立（CI） |
| `temporal / shared` | `ChannelMixer` | 时序方向后做 channel mixing |
| `feature` | `ChannelMixer` | channel mixing 在 backbone 前 |
| `temporal_then_feature` | `ChannelMixer` after | 先时序再 feature fusion |
| `feature_then_temporal` | `ChannelMixer` before | 先 feature fusion 再时序 |
| `graph` | `GraphChannelMixer` | 可学习图邻接矩阵 channel mixing |
| `gated_hybrid` | `GatedHybridMixer` | gated feature mixing（sigmoid gate） |

**Prediction Head**

| Action | 实现类 | 说明 |
|--------|--------|------|
| `linear / direct_multi_horizon` | `nn.Identity`（head 已在 backbone 内） | 直接线性预测 |
| `residual_correction` | `ResidualCorrectionHead` | 在点预测上叠加非线性残差修正 |
| `quantile` | `QuantilePointHead` | 分位数预测（多分位点） |
| `gaussian` | `GaussianPointHead` | 高斯分布预测（mean + log_var） |

### 5.2 Forward 流程

```python
# RecipeModel.forward(x)
1. 链式 forward_transform（preprocessing stack）
2. channel_mixer（fusion 前向）
3. last_value 减法（mean subtraction proxy）
4. 展平为 [batch*channels, seq_len]（CI 模式）
5. _forward_core（embedding → backbone → head）
6. reshape 回 [batch, horizon, channels]
7. + last_value（反向 mean）
8. output_mixer（fusion 后向）
9. 链式 inverse_transform（preprocessing stack 反向）
```

这是一个完整的端到端可微分流水线，预处理的归一化和去归一化自动配对。

---

## 6. 核心组件二：`registry/action_specs.py` — Action 注册表

定义每个 action 的合法性和 phase 要求：

```python
ACTION_SPECS = {
    "preprocessing": {
        "none":                 {"phase_min": "phase0b", "bridge_supported": True},
        "instance_norm":        {"phase_min": "phase1",  "bridge_supported": False},
        "series_decomposition": {"phase_min": "phase1",  "bridge_supported": False},
        "seasonal_differencing":{"phase_min": "phase2",  "bridge_supported": False},
        "missing_mask":         {"phase_min": "phase2",  "bridge_supported": False},
        "sample_reweighting":   {"phase_min": "phase2",  "bridge_supported": False},
    },
    "embedding": {
        "none":             {"phase_min": "phase0b", "bridge_supported": True},
        "patch":            {"phase_min": "phase0b", "bridge_supported": True},
        "multiscale_patch": {"phase_min": "phase2",  "bridge_supported": False},
        "invert":           {"phase_min": "phase2",  "bridge_supported": False},
        "frequency":        {"phase_min": "phase2",  "bridge_supported": False},
        "calendar":         {"phase_min": "phase2",  "bridge_supported": False},
    },
    "backbone": {
        "linear":      {"phase_min": "phase0b", ...},
        "mlp":         {"phase_min": "phase0b", ...},
        "transformer": {"phase_min": "phase0b", ...},
        "rnn":         {"phase_min": "phase2",  ...},
        "dlinear":     {"phase_min": "phase2",  ...},
        "tcn":         {"phase_min": "phase2",  ...},
        "nbeats":      {"phase_min": "phase2",  ...},
        "timesnet":    {"phase_min": "phase2",  ...},
        "ssm":         {"phase_min": "phase2",  ...},
        "mixer":       {"phase_min": "phase2",  ...},
    },
    "fusion":     { temporal/feature/temporal_then_feature/feature_then_temporal/graph/gated_hybrid },
    "head":       { linear/direct_multi_horizon/quantile/gaussian/residual_correction },
    "loss":       { mse/mae/huber/quantile/distillation },
    "optimizer":  { adam/adamw/sgd },
    "scheduler":  { none/cosine/one_cycle/plateau },
}
```

**Phase 含义**：
- `phase0b`：当前 bridge 支持，legacy candidate 和 native recipe 均可用
- `phase1`：native recipe factory 支持，bridge 不支持
- `phase2`：扩展 action，需要更完整的 phase2 支持

**Validation 规则**（来自 `validate_recipe_against_registry`）：
- `none` 不能和其他 preprocessing 混用
- `dlinear / tcn / nbeats / timesnet` 要求 `embedding.type = "none"`
- `transformer` 要求 `d_model % n_heads == 0`，且 embedding d_model 必须匹配
- bridge_only 模式只允许 `(none+linear), (patch+mlp), (patch+transformer)`

---

## 7. 核心组件三：`search/mutate.py` — Recipe Mutation Engine

`mutate_recipe(recipe, metrics)` 是当前的"反思"机制，基于规则而非 LLM：

```text
规则优先级（按顺序执行，第一个命中即返回）：

1. crash / smoke_fail → reduce_transformer_cost + adamw_lr_down
2. embedding=patch → upgrade 到 multiscale_patch + enable_shared_channel
3. fusion.channel_mode != "shared" → enable_shared_channel
4. preprocessing=none → enable_instance_norm
5. backbone=mlp && val_avg_mse > good → increase_mlp_capacity（hidden_dim×2, depth+1）
6. backbone=transformer && val_avg_mse > poor → reduce_transformer_cost
7. val_avg_mse > poor → 依次尝试 switch_to_dlinear / switch_to_tcn / switch_to_nbeats / switch_to_timesnet
8. switch_loss_huber
9. adamw_lr_down（兜底）
```

`MutationPolicy`：
- `poor_val_mse = 1.1`，`good_val_mse = 0.9`
- `max_hidden_dim = 256`，`min_hidden_dim = 32`
- `max_depth = 4`
- `min_lr = 1e-4`，`max_lr = 3e-3`

mutation 结果写入 recipe 的 `hypothesis` 和 `notes` 字段，保留可溯源的修改历史。

---

## 8. 核心组件四：`runner.py` — 实验状态机

RunnerState（持久化到 `.neo-cast/runner_state.json`）：
```python
@dataclass
class RunnerState:
    session_id: str
    best_run_id: str | None
    best_val_avg_mse: float | None
    keep_count: int
    crash_streak: int
    candidate_counter: int
    initialized_at: str
```

results.tsv 列：
```
session_id | run_id | candidate_id | model_family | val_avg_mse
val_h96_mse | val_h720_mse | params_M | status | is_best | timestamp
```

keep/discard 逻辑：`val_avg_mse < best_val_avg_mse` 则 keep，更新 best。

---

## 9. 核心组件五：`prepare_tsf.py` — 冻结评估协议

这是系统的"地基"，其内容对 agent 不可修改：

```python
TIME_BUDGET = 600      # 10 分钟训练墙钟上限
PARAM_BUDGET = 10_000_000  # 10M 参数上限
HORIZONS = [96, 192, 336, 720]  # 评估的预测长度
```

评估指标：`val_avg_mse`（四个 horizon 上的平均 MSE，在 StandardScaler 归一化空间内）

数据切分：VISIBLE_DATA_PATH（train+val）vs REF_TEST_DATA_PATH（ref_test，对 agent 不可见）

---

## 10. 核心组件六：`llm.js` — 候选生成层

两套路径：

**LLM 路径（Anthropic API）**：
- 系统提示词包含 task_id、channels、input_len、horizons、train/val split、primary metric
- 要求模型输出 `recipe_schema_v1` JSON
- 支持 max-candidates 多轮采样

**Heuristic Fallback（无 API 时）**：
- 关键词匹配：检测 requirement 文本中的 "multiscale"、"dlinear"、"tcn"、"nbeats"、"timesnet"、"transformer"、"mlp"、"channel"、"cross" 等
- 中英文双语支持（如 "多尺度"、"卷积"、"相关"）
- attempt 参数：失败重试时自动升级 model family

---

## 11. 核心组件七：`blind_test_sidecar.py` — 盲测防泄露机制

这是一个值得注意的设计：单独的 HTTP 服务，用于保护 ref_test 数据不被 agent 高频访问。

功能：
- Token 认证（`NEO_TSF_BLIND_TEST_TOKEN`）
- 查询次数限制（`NEO_TSF_BLIND_QUERY_LIMIT`）
- 每次查询写入 audit log（`.neo-cast/blind_test_audit.jsonl`）

这保证了 `ref_test` 只在真正最终汇报时访问，避免 agent 对 test 集过拟合。

---

## 12. 操作模式

**Socratic 模式**（`--mode socratic`）：
- 多轮问答澄清需求（任务类型、目标指标、模型偏好等）
- 最终输出结构化 requirement summary

**Companion 模式**（`--mode companion`，默认）：
- 直接生成候选 → 训练 → 结果 → 可选 mutation → 下一轮
- `watchForStop()` 监听用户输入，随时可中止

---

## 13. Artifact 导出内容

`export.py` 输出：

| 文件 | 说明 |
|------|------|
| `model.pt` | PyTorch state_dict |
| `preprocess.json` | StandardScaler 参数 |
| `model_impl.py` | 完整 RecipeModel 实现（可独立运行） |
| `inference.py` | 推理脚本（加载 model.pt，标准输入输出接口） |
| `eval_report.md` | 评测报告（val + ref_test 指标） |
| `model_spec.json` | recipe + 元数据 |
| `patch_bundle.json` | 增量更新包（用于 diff 分发） |

所有文件通过 `metadata_schema.json` 做格式校验。

---

## 14. 当前 Action Space 的实际组合规模

```text
Preprocessing：6 种（none / instance_norm / series_decomposition / seasonal_differencing / missing_mask / sample_reweighting）
Embedding：    6 种（none / patch / multiscale_patch / invert / frequency / calendar）
Backbone：    10 种（linear / mlp / transformer / rnn / dlinear / tcn / nbeats / timesnet / ssm / mixer）
Fusion：       6 种（temporal / feature / temporal_then_feature / feature_then_temporal / graph / gated_hybrid）
  × channel_mode：2（independent / shared）
Head：         5 种（linear / direct_multi_horizon / quantile / gaussian / residual_correction）
Loss：         5 种（mse / mae / huber / quantile / distillation）
Optimizer：    3 种（adam / adamw / sgd）
Scheduler：    4 种（none / cosine / one_cycle / plateau）
```

主干组合（preprocessing × embedding × backbone × fusion）：约 **6 × 6 × 10 × 12 = 4320** 种（不算超参和约束）。
去掉非法组合（dlinear/tcn/nbeats/timesnet 要求 embedding=none 等），实际合法空间更小，但仍远超现有模型族。

---

## 15. 项目的工程成熟度评估

### 已完成

| 能力 | 状态 |
|------|------|
| CLI 入口 + 命令路由 | ✅ |
| 数据准备 + dataset.v1 协议 | ✅ |
| JSON Schema 校验（recipe/candidate/metadata/dataset）| ✅ |
| Registry 合法性校验 | ✅ |
| Smoke gate | ✅ |
| 完整训练循环（早停 + 时间预算 + seed 固定）| ✅ |
| Keep/discard + results.tsv | ✅ |
| Artifact 导出（model.pt / inference.py / report）| ✅ |
| Ref_test 最终汇报 | ✅ |
| Blind test sidecar（防泄露）| ✅ |
| LLM 候选生成 + heuristic fallback | ✅ |
| Rule-based mutation（基础 reflection）| ✅ |
| e2e 测试 + Python unit 测试 | ✅ |
| 10 种 backbone 的完整 PyTorch 实现 | ✅ |
| 6 种 embedding（包括 frequency / calendar）| ✅ |
| 6 种 fusion（包括 graph / gated_hybrid）| ✅ |
| 概率预测头（quantile / gaussian）| ✅ |

### 尚不具备

| 能力 | 状态 |
|------|------|
| Time-Series Profiler（数据画像 → action prior）| ❌ |
| 结构化 ResearchIntent | ❌ |
| Action Trajectory 记录（构建动作序列）| ❌ |
| Compiler 级 shape trace / graph | ❌ |
| LLM 驱动的 Reflection（per-horizon / per-variable 诊断）| ❌ |
| Research Memory（跨 session 经验积累）| ❌ |
| Profile-conditioned Router | ❌ |
| Mixture of Experts / 双分支结构 | ❌ |
| Surrogate Performance Predictor | ❌ |
| 形式化 reward 信号 | ❌ |

---

## 16. 关键设计亮点

**1. 预处理链可逆设计**

`InstanceNormAction` / `SeriesDecompositionAction` 都有 `forward_transform` 和 `inverse_transform`，通过 `contexts` 列表传递中间状态，在输出阶段自动还原。这是比"RevIN 附加 flag"更系统的做法。

**2. Recipe 作为唯一真相**

LLM 不直接写 PyTorch 代码，而是输出 JSON recipe。`RecipeModel` 负责 recipe → PyTorch 的确定性翻译。这使得：校验、审计、mutation、导出、复现全部基于同一份 recipe，而不是代码快照。

**3. Blind test sidecar 的科研信度设计**

`val_avg_mse` 是搜索信号，`ref_test` 通过独立 HTTP sidecar 保护，有 token 认证和查询计数，并写 audit log。这是少见的在研究系统 MVP 阶段就考虑"科研可信度"的设计。

**4. Hypothesis 字段**

每个 recipe 都有 `hypothesis` 文本字段（8-1200 字符，schema 强制），mutation 会自动更新它。这使得实验历史具有可解释性，而不只是参数变化。

**5. Phase 系统**

`action_specs.py` 的 `phase_min` 字段说明系统不是一次性 dump 所有功能，而是分阶段激活。bridge_only 模式只允许最小合法子集，保证早期 agent 不会越界。

---

## 17. 与最新研究思考（v0428）的对齐情况

| v0428 提出的设计 | 当前代码状态 |
|------|------|
| Action Space 7 层（含元架构层）| 实现了前 5 层，第七层（MoE/Router）尚无 |
| Model Recipe DSL + Compiler | ✅ 已实现（recipe_schema_v1 + RecipeModel） |
| MVP 120 种组合 | 实际 action space 更大（4000+），但有合法性约束缩减 |
| Time-Series Profiler | ❌ 未实现 |
| Reflection Loop（LLM 诊断）| 仅 rule-based mutation，无 LLM 反思 |
| Surrogate Predictor | ❌ 未实现 |
| Profile-conditioned Router | ❌ 未实现 |
| val/ref_test 严格分离 | ✅ 已实现（blind sidecar） |
| 序贯决策形式化 | ❌ 未编码（停留在思考层面） |
| 实验报告 artifact | ✅ 已实现 |

---

## 18. 推荐阅读顺序

```text
1.  py/schemas/recipe_schema.json              # 理解 recipe 数据结构
2.  py/registry/action_specs.py                # 理解合法 action 空间
3.  py/factory/build_model.py                  # 理解 recipe → PyTorch 编译
4.  py/prepare_tsf.py                          # 理解冻结评估协议
5.  py/search/mutate.py                        # 理解当前 mutation/reflection 机制
6.  py/runner.py                               # 理解 keep/discard 状态机
7.  src/llm.js                                 # 理解候选生成和 heuristic fallback
8.  src/cli.js                                 # 理解命令路由
9.  py/blind_test_sidecar.py                   # 理解盲测防泄露设计
10. py/export.py                               # 理解 artifact 导出
```

---

## 19. 总结

`neo_cast` 已经把 NeoResearch-TSF 的**工程骨架**搭好了：

- 有完整的数据协议、recipe 格式、合法性校验、PyTorch 编译器、训练循环、keep/discard、artifact 导出、盲测保护。
- 模型设计空间已经相当丰富（10 种 backbone、6 种 embedding、6 种 fusion）。
- 当前的"反思"是 rule-based mutation，能在有限步骤内探索 action space。

**下一步最高价值的工作是**：
1. 把 rule-based mutation 升级为**基于 per-horizon / per-variable 误差诊断的 LLM Reflection**
2. 加入**Time-Series Profiler**，让候选生成从"用户关键词匹配"变为"数据驱动的 action prior"
3. 记录 **Action Trajectory**（构建动作序列），让系统从"recipe 搜索"走向"architecture construction"
