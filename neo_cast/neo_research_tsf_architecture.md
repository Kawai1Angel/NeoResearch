# neo-research for TSF：架构设计文档 v3.1

> 面向时间序列预测领域的自主研究智能体系统 — **Forecast Research Operating System**
> 设计参照：Karpathy autoresearch（2026）、The AI Scientist（2024）、AutoML-Zero、TimeRecipe（ICLR 2026）
> 数据加载与评估协议参照：[Time-Series-Library](https://github.com/thuml/Time-Series-Library)（thuml，2024）

---

## 1. 系统定位与核心主张

### 1.1 问题陈述

时间序列预测（TSF）领域已经形成了高度碎片化的模型生态：Autoformer 用分解与 Auto-Correlation 切入长序列，PatchTST 用 patching + channel-independence 改造输入表示，iTransformer 把建模重心转到 variate token；但每一个"小模型"的诞生，都需要算法工程师大量人工投入——反复设计网络结构、调节优化策略、跑对比实验。这个过程**高度重复、耗时耗力，且严重依赖专家经验积累**。

### 1.2 核心主张

neo-research 系统通过把"设计 TSF 小模型"这件事转化为一个**可自动执行的闭环**，让 AI agent 在被严格约束的实验环境里，持续完成以下循环：

1. 发现问题与提出假设
2. 生成或修改模型结构
3. 生成或修改训练目标与训练策略
4. 自动运行实验并记录结果
5. 判断变化是否有效
6. 保留有效变化并继续迭代
7. 输出可复现的模型、代码、报告与知识沉淀

**系统目标不是"会聊天的时序助手"，而是一个 Forecast Research Operating System。**

### 1.3 系统定义

**Neo-Research** 不是简单的 AutoML（没有结构化搜索空间），也不是纯 LLM code agent（没有可审计的约束执行环境），而是把"研究假设—代码变更—实验执行—结果归因—知识积累"串成闭环的**受控研究系统**。

**研究对象**：重点针对**小模型**，即满足参数量、延迟、显存、训练成本等约束的定制化时序预测模型，不追求无限放大参数规模。

**研究产物**：

- 新模型结构
- 新 loss 组合
- 新的数据预处理/特征策略
- 新的训练配方（优化器、schedule、正则化组合）
- 新的推理/蒸馏/集成策略
- 可复现实验报告
- 可继承的研究记忆（跨任务经验）

---

## 2. 设计目标与系统边界

### 2.1 设计目标

| # | 目标 | 内涵 |
|---|------|------|
| 1 | **自动化** | 尽量减少算法工程师手动改模型、调 loss、跑 ablation 的工作量 |
| 2 | **约束性** | 所有实验在固定协议下执行，禁止任意绕过评测 |
| 3 | **可复现** | 任何"有效变化"都必须可回放、可审计、可比较 |
| 4 | **小模型优先** | 优化目标包括精度、参数量、延迟、稳定性，不单一追求 leaderboard |
| 5 | **可积累** | 系统逐渐形成"在什么样的时序任务上，什么样的结构/目标更有效"的经验库 |
| 6 | **人机协同** | 人负责定义任务边界、预算和研究方向；Agent 负责高频试验与局部创新 |

### 2.2 非目标（第一阶段）

1. 不做开放式文献综述 Agent
2. 不做自由无限制代码生成
3. 不以自动写论文为主目标
4. 不直接接管生产部署
5. 不追求覆盖所有时序任务，先聚焦 forecasting

### 2.3 核心原则

**原则一：先协议，后智能**
先把数据协议、评估协议、预算协议、代码协议定死，再让 Agent 在约束内创新。

**原则二：先 DSL/IR，后自由改代码**
最关键的工程决策是：**不要让 Agent 一开始就在整个代码仓里自由发挥**。更可行的做法是引入模型中间表示（IR）/配置 DSL，让 Agent 主要在声明式空间里搜索，再把少量高价值候选升级为代码级变更。

> **Phase 0 例外说明：** 为了最快验证闭环，MVP 允许 Agent 仅在 `train.py` **单文件内**自由改动；这不是对"全仓自由改代码"的放开。从 Phase 1 开始，新增结构原则上应先通过 registry / DSL 暴露，再允许受限 patch。

> **阶段口径说明：** Phase 0 分成两个子阶段。`Phase 0a` 只验证 autoresearch 式闭环，允许 `train.py` 单文件自由实验；`Phase 0b` 开始冻结 `CandidateRecipe v1` 和 baseline recipe，但仍可用 `train.py` 作为执行载体；`Phase 1` 才要求候选优先通过 action registry 与 `build_model(candidate_recipe)` 生成。

**原则三：先多阶段筛选，后完整评测**
所有候选不能直接上 full training，应采用：静态检查 → smoke run → 低保真实验 → 完整验证 → 多 seed 确认 → blind test 晋级。

> **Phase 0 例外说明：** 上述是完整系统的理想流程。MVP 阶段允许退化为"修改 `train.py` → 直接 full run → keep/discard"，不要求先实现 smoke harness、低保真筛选器或多 baseline 调度器。

**原则四：先保留有效增量，后追求颠覆式创新**
系统天然偏向 **delta-based research**：每轮只提出少量可验证改动，并保留有效 patch。

**原则五：精度不是唯一目标**
小模型研发必须做多目标优化：`accuracy + params + latency + robustness + reproducibility`。

---

## 3. 总体架构

### 3.1 MVP 文件结构（autoresearch 同构）

```
neo_research_tsf/
├── prepare_tsf.py     ← 【冻结】数据加载 / 评估 / 固定常量
├── train.py           ← 【Agent 唯一可编辑文件】模型架构 + 训练循环
├── program.md         ← 【人类编辑】研究策略 + 行为协议
├── results.tsv        ← 【不提交 git】实验日志
└── run.log            ← 【不提交 git】最近一次实验输出
```

三个文件的角色与 autoresearch 完全同构：

```
autoresearch          →  neo-research TSF
─────────────────────────────────────────
prepare.py            →  prepare_tsf.py     （冻结层）
train.py              →  train.py            （实验层）
program.md            →  program.md          （策略层）
val_bpb               →  val_avg_mse         （主指标，scaled space）
```

### 3.2 完整系统七层架构（长期目标）

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Human Control Layer（人类控制层）                   │
│         定义任务 · 批准搜索空间 · 审核晋级 · 冻结测试集 · 回滚终止       │
├─────────────────────────────────────────────────────────────────────┤
│                  Agent Orchestration Layer（智能编排层）               │
│       Research Manager + Diagnostic / Design / Coder / Runner /     │
│                        Analyst / Librarian                          │
├─────────────────────────────────────────────────────────────────────┤
│                    Search Space Layer（搜索空间层）                    │
│       CandidateRecipe DSL · action registry · loss DSL · trainer DSL │
├─────────────────────────────────────────────────────────────────────┤
│                   Protocol Layer（研究协议层）                         │
│       TaskSpec · 切分边界 · 评测指标 · 参数/延迟/预算约束               │
├─────────────────────────────────────────────────────────────────────┤
│                    Execution Layer（执行层）                           │
│        Sandbox · 训练器 · Static Validator · Artifact Store          │
├─────────────────────────────────────────────────────────────────────┤
│                   Evaluation Layer（评估层）                           │
│        指标计算 · 多阶段筛选 · 晋级判定 · 误差诊断 · Metrics DB         │
├─────────────────────────────────────────────────────────────────────┤
│                     Memory Layer（研究记忆层）                         │
│         实验谱系 · 成功/失败模式 · 任务指纹 · patch diff · champion     │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.3 核心模块划分

完整系统由 12 个核心服务模块组成：

| # | 模块 | 核心职责 |
|---|------|---------|
| 1 | **Task Manager** | 创建任务、校验协议、生成 task_id、管理生命周期 |
| 2 | **Dataset Service** | 数据加载、train/val/test 切分、特征物化、防泄漏 |
| 3 | **Diagnostic Service** | 数据集画像、产出 TaskFingerprint |
| 4 | **Baseline Builder** | 自动运行基线、生成 baseline metrics、产出初始 champion |
| 5 | **Search Space Registry** | 注册 preprocessing / embedding / backbone / fusion / head / trainer action，约束 Agent 搜索边界 |
| 6 | **Proposal Engine** | 基于指纹和历史记忆生成候选 hypothesis + CandidateRecipe |
| 7 | **Patch Generator** | 将 recipe 转为可执行配置或受限模板变更（RecipeDelta / CodePatch） |
| 8 | **Static Validator** | 检查 patch 合法性、接口兼容性、预算边界、越权检测 |
| 9 | **Experiment Runner** | 创建容器、注入配置、执行训练评估、收集 artifact |
| 10 | **Evaluator** | 统一指标计算、晋级判定、error analysis |
| 11 | **Memory Service** | 保存实验记录、patch lineage、相似任务召回 |
| 12 | **Governance Service** | blind test 保护、审批流、权限隔离、审计日志 |

**Search Space Registry 是系统核心防线之一**——它决定 Agent 能探索什么，是整个系统可控性的关键。

---

## 4. 研究协议层（Protocol Layer）

### 4.1 TaskSpec 定义

每个研究任务必须定义统一的 `TaskSpec`：

```yaml
task_id: etth1_multivar_96_720
task_type: forecasting
forecast_mode: point          # point | probabilistic
series_type: multivariate
context_length: 512
prediction_lengths: [96, 192, 336, 720]

dataset:
  loader_id: etth1_tslib_v1
  target_cols: [HUFL, HULL, MUFL, MULL, LUFL, LULL, OT]  # Phase 0 默认采用 M setting：预测全部 7 个变量
  known_future_covariates: []
  observed_past_covariates: []  # 仅表示额外的 past-only 输入；Phase 0 中不与 target_cols 重复声明
  static_covariates: []

split:
  scheme: fixed_row_index
  train: [0, 8640]            # 与 TSL Dataset_ETT_hour 完全一致
  val: [8640, 11520]
  test: [11520, 14400]        # 逻辑上的 public reference split；物理上仅 Runner 可见
  test_exposure: promotion_only
  blind_test: phase5_service  # 真正 blind test 在 Phase 5 以独立服务提供

evaluation:
  protocol: fixed_split
  metric_primary: val_avg_mse  # 在 StandardScaler 归一化空间计算
  metric_reference: ref_test_avg_mse
  seeds: [42]                  # MVP 阶段单 seed；Phase 3+ 扩展至多 seed

constraints:
  max_params: 10_000_000       # 10M 参数软上限
  max_training_seconds: 600
  max_gpu_hours_total: 100
  max_trials: 500
```

> **字段语义说明：** `target_cols` 是需要预测的内生变量集合；它们默认也会出现在历史窗口 `x` 中。`observed_past_covariates` 只表示额外的 past-only 输入，不能把已在 `target_cols` 中的列再次拼接一遍。

### 4.2 时序安全原则

必须强制执行：

- 所有归一化、缺失值填补、统计特征拟合**只允许在 train fold 上完成**
- 未来不可见特征禁止泄漏到训练样本
- `val` 是 Agent 唯一可高频查询的决策信号
- 仓库内自带的 `test` 只作为 **reference test**，默认仅在晋级节点由 Runner / Human Gate 查询，Agent 不直接读取
- reference test 结果必须写入 **privileged promotion log**，不得写入 Agent 可读的 `results.tsv`
- 真正 blind test 的标签和接口不进入仓库，Phase 5 才通过独立服务暴露

### 4.3 三层评估协议

建议分三层，避免系统对单一验证集过拟合：

| 层次 | 名称 | 使用场景 | 查询频率 |
|------|------|---------|--------|
| L1 | Dev Validation | 日常 keep/discard 决策 | 每次实验 |
| L2 | Reference Test / Shadow Holdout | 晋级筛选与对外参考对齐 | 每 N 次 keep，由 Runner/Human 查询并写入 privileged log |
| L3 | Blind Test | 最终 champion 确认 | 仅晋级节点，Phase 5 起可用 |

---

## 5. 搜索空间设计（Search Space Layer）

这是系统成败的核心。v3.1 将 Neo-Cast 的候选空间从"选择模型族 + 配模型参数"升级为 TimeRecipe 风格的**模块级配方搜索**：Agent 不再先问"用 PatchTST 还是 iTransformer"，而是按固定 pipeline 选择一组可注册 action，再由 runtime 组装成模型。

### 5.1 Canonical Recipe Pipeline

Neo-Cast 的候选模型统一抽象为：

```text
Input
  -> Preprocessing Action
  -> Embedding Action
  -> Backbone Action
  -> Fusion Action
  -> Prediction Head
  -> Post-processing Action
  -> Training Strategy
  -> Forecast
```

其中 `post_processing` 通常与 `preprocessing` 配对，例如 instance normalization 的反归一化、decomposition 的 trend/seasonal recomposition。第一阶段可以把 `post_processing` 作为自动派生字段，不暴露给 Agent 直接搜索。

### 5.2 CandidateRecipe Schema

候选不再以 `model_family` 为主键，而以 recipe 为主键：

```json
{
  "recipe_id": "etth1_patch_mlp_tf_mse_v1",
  "recipe_version": "recipe_schema_v1",
  "preprocessing": {
    "actions": [
      {"type": "instance_norm", "affine": false},
      {"type": "series_decomposition", "method": "moving_average", "kernel_size": 25}
    ]
  },
  "embedding": {
    "type": "patch",
    "patch_len": 16,
    "stride": 8,
    "d_model": 128
  },
  "backbone": {
    "type": "mlp",
    "depth": 3,
    "hidden_dim": 256,
    "dropout": 0.1
  },
  "fusion": {
    "type": "temporal",
    "channel_mode": "independent"
  },
  "prediction_head": {
    "type": "linear",
    "output_distribution": "point",
    "share_across_horizons": false
  },
  "post_processing": {
    "type": "auto"
  },
  "training_strategy": {
    "loss": {"base": "mse", "horizon_weighting": "uniform"},
    "optimizer": {"type": "adamw", "lr": 0.001, "weight_decay": 0.0001},
    "scheduler": {"type": "cosine", "warmup_steps": 0},
    "regularization": {"dropout": 0.1, "grad_clip": 1.0},
    "budget": {"max_epochs": 5, "time_budget_s": 600}
  },
  "constraints": {
    "max_params": 10000000,
    "max_latency_ms": 50
  }
}
```

这个 schema 的核心约束是：Agent 只能选择 registry 中存在的 action 和合法参数；`build_model(candidate_recipe)` 由 Python 端负责装配 PyTorch 模型，禁止候选直接注入任意模型代码。

### 5.3 Preprocessing Action Space

Preprocessing 负责处理尺度漂移、趋势/季节性、缺失和输入重采样。初期注册：

| Action | 参数 | 适用偏置 |
|--------|------|---------|
| `none` | - | 保留原始输入，作为必要对照 |
| `instance_norm` | `affine`, `eps` | distribution shift 明显、变量尺度不稳定 |
| `series_decomposition` | `method`, `kernel_size` | trend 强、长期预测、DLinear/Autoformer 类偏置 |
| `seasonal_differencing` | `period`, `order` | 强季节性、低频趋势干扰 |
| `missing_mask` | `mask_channel`, `fill_policy` | 缺失率高、需要显式缺失提示 |
| `sample_reweighting` | `scheme` | horizon 难度不均、异常点较多 |

### 5.4 Embedding Action Space

Embedding 决定序列如何进入 backbone。初期注册：

| Action | 参数 | 对应典型模型 |
|--------|------|-------------|
| `none` | - | NLinear / DLinear |
| `token` | `d_model`, `time_feature_mode` | Informer / Autoformer |
| `patch` | `patch_len`, `stride`, `d_model` | PatchTST |
| `invert` | `d_model` | iTransformer |
| `frequency` | `n_freq`, `complex_mode` | FITS / frequency MLP |
| `calendar` | `fields`, `embed_dim` | 有显式时间戳或已知未来协变量的任务；Phase 2+ 依赖冻结数据接口扩展 |

### 5.5 Backbone Action Space

Backbone 只表达主要建模算子，不再绑定完整论文模型名。初期注册：

| Action | 参数 | 核心偏置 |
|--------|------|---------|
| `linear` | `shared`, `bias` | 全局线性映射，强 baseline |
| `mlp` | `depth`, `hidden_dim`, `activation` | 轻量、低延迟、适合 recipe 穷举 |
| `rnn` | `cell`, `hidden_dim`, `num_layers` | 显式递归状态，适合变量多/短 horizon |
| `tcn` | `channels`, `kernel_size`, `dilation` | 局部时序模式与低延迟 |
| `transformer` | `n_layers`, `n_heads`, `d_model` | 长依赖、强季节性、变量相关性高 |
| `ssm` | `state_dim`, `depth` | 长上下文和线性复杂度探索 |
| `mixer` | `temporal_mixing`, `channel_mixing` | 多尺度 mixing、TimeMixer 类偏置 |

### 5.6 Fusion Action Space

Fusion 决定优先建模时间依赖还是变量间依赖。初期注册：

| Action | 参数 | 说明 |
|--------|------|------|
| `temporal` | `channel_mode: independent/shared` | 先沿时间维建模，适合 CI 与 PatchTST 类结构 |
| `feature` | `variate_token`, `cross_attention` | 先沿变量维建模，适合 iTransformer 类结构 |
| `temporal_then_feature` | `gate`, `residual` | 先时间后变量，适合中等变量数任务 |
| `feature_then_temporal` | `gate`, `residual` | 先变量后时间，适合强变量相关任务 |
| `graph` | `adjacency_source`, `sparsity` | 交通/传感器类拓扑任务 |
| `gated_hybrid` | `gate_type` | 在 temporal 与 feature 分支之间学习加权 |

### 5.7 Prediction Head Space

Prediction head 负责把 latent 表示映射到 horizon 输出：

| Head | 参数 | 适用场景 |
|------|------|---------|
| `linear` | `share_across_horizons` | point forecast 默认 head |
| `direct_multi_horizon` | `horizon_specific` | 一次输出多个 horizon，避免递推误差 |
| `quantile` | `quantiles` | 概率预测、P50/P90 场景 |
| `gaussian` | `variance_floor` | 分布式预测与不确定性估计 |
| `residual_correction` | `base_head`, `correction_dim` | 在强 baseline 上学习残差 |

### 5.8 Training Strategy Space

训练策略也进入 recipe，而不是散落在自由代码里：

```text
TrainingStrategy =
  Optimizer
  + Scheduler
  + LossRecipe
  + Regularization
  + EarlyStopping
  + FidelityBudget
  + OptionalDistillation
```

受限语法：

```text
Loss = alpha * BaseLoss + beta * HorizonLoss + gamma * Regularization + delta * Calibration

BaseLoss        in {MSE, MAE, Huber, Quantile}
HorizonLoss     in {uniform, front_heavy, tail_heavy, learned_static}
Regularization  in {none, smoothness, sparsity, decomposition_consistency}
Calibration     in {none, quantile_consistency, variance_penalty}
Optimizer       in {Adam, AdamW, SGD}
Scheduler       in {none, cosine, one_cycle, plateau}
Distillation    in {none, teacher_residual, ensemble_to_single}
```

> **Phase 0 例外说明：** MVP 为了验证闭环，允许 Agent 在 `train.py` 内写少量 ad-hoc loss 和训练循环；从 Phase 1 开始，候选必须优先表达为 `CandidateRecipe`，从 Phase 2 开始新的 action 必须先注册到 grammar / registry。

### 5.9 Dataset Profiler 与 Recipe Prior

TimeRecipe 的核心启发是：模块有效性依赖数据属性。Neo-Cast 需要在生成候选前先计算 `TaskFingerprint`，至少包括：

- 变量数量与序列数量
- lookback / horizon 比例
- trend 强度、seasonality 强度、transition / shift 指标
- stationarity / scale stability
- cross-variable correlation
- 缺失率、频率、样本长度
- 训练预算、参数量和延迟约束

初期使用 rule-based prior 给候选排序；中期用实验记录训练 rank predictor。当前实现已进入中期形态：`tsf_profile_learned_memory_ranker_v1` 会从 task/domain memory、run metric、champion 记录中抽取 action/interaction feature，学习 lightweight feature weights，并把 learned contribution 写入 candidate selection artifact；LightGBM 仍可作为后续可插拔替换。

```text
TaskFingerprint + CandidateRecipe
  -> rule-based prior / rank predictor
  -> top-k recipes
  -> low-fidelity evaluation
  -> full evaluation
  -> memory update
```

示例先验：

- 高 `horizon_context_ratio` + trend 强 → `series_decomposition`, `patch`, `temporal`, `linear/mlp` 优先
- 变量数高 + cross-var correlation 高 → `invert`, `feature`, `transformer/mlp` 优先
- seasonality 强 → `token/frequency`, `transformer`, `calendar` 候选优先
- distribution shift 高 → `instance_norm` 优先，但必须保留 no-IN 对照
- latency 约束强 → `none/patch` + `linear/mlp/tcn` + `linear head` 优先

这些规则只用于排序和解释，不直接锁死搜索空间。

### 5.10 Fingerprint Metric 计算口径

所有 `TaskFingerprint` 指标默认只在 train split 上计算，禁止读取 val/test 标签统计。指标输出统一归一到 `[0, 1]`，并记录原始统计量用于审计。

| 指标 | 初始计算口径 | 说明 |
|------|-------------|------|
| `trend_score` | STL / moving-average trend 方差占比 | 越高表示趋势成分越强 |
| `seasonality_score` | dominant autocorrelation peak / periodogram peak | 越高表示周期性越强 |
| `cross_var_corr_score` | train split 上变量相关矩阵非对角绝对值均值 | 多变量依赖强度 |
| `distribution_shift_score` | train 前后窗口均值/方差差异的归一化距离 | 只在 train 内部分段计算 |
| `transition_score` | change-point proxy 或一阶差分异常峰占比 | 结构突变强度 |
| `data_scale_stability` | rolling std 稳定性的反向指标 | 越高表示尺度越稳定 |
| `horizon_context_ratio` | `max(prediction_lengths) / context_length` | 可保留原值，同时提供 clipped score |

第一版实现可以用轻量启发式，后续再替换为更稳健的统计检验；关键是计算口径固定、可复现、无泄漏。

---

## 6. Agent 组织架构（Agent Orchestration Layer）

MVP 阶段采用**单 Agent + 固定工具调用**；完整系统采用 **1 个主控 Agent + 5 个工具型子代理**。

### 6.1 主控：Research Manager

职责：读取任务规格 → 维护全局状态 → 决定每轮研究目标 → 分配子任务 → 依据结果更新下一轮搜索方向

### 6.2 Diagnostic Agent

职责：对数据做结构化诊断，产出**任务指纹**，包括：

- 序列数量、频率、缺失率、是否多变量
- 季节性/趋势性/突变性强度
- context/horizon 比
- 数据规模与噪声水平
- 已知未来协变量情况

### 6.3 Design Agent

职责：基于任务指纹提出候选假设，选择 preprocessing / embedding / backbone / fusion / head / training strategy action，给出变更理由与预期收益。

输出示例：

```
- "长 horizon + trend 强，优先尝试 series_decomposition + patch + temporal fusion + MLP"
- "变量数高且相关性强，优先尝试 invert embedding + feature fusion + Transformer/MLP"
- "小数据场景，优先轻量 backbone + 强正则化或蒸馏"
```

### 6.4 Coder Agent

职责：将 Design Agent 的 CandidateRecipe 转换为 DSL 配置变更 / 模块参数变更 / 模板化代码 patch，并运行静态检查、接口测试。

### 6.5 Runner Agent

职责：提交实验 → 跟踪状态 → 捕获异常 → 管理资源预算 → 统一写入实验记录

### 6.6 Analyst Agent

职责：归因实验成败，比较候选与 champion，分析是"真提升"还是"seed 运气"，把结果压缩成下一轮可消费的研究记忆。

### 6.7 Librarian / Memory Agent

职责：管理实验谱系，相似任务检索，失败模式去重，把"经验"转成结构化规则。

---

## 7. 研究循环设计

### 7.1 任务生命周期状态机

```text
CREATED
→ DIAGNOSING
→ BASELINING
→ READY
→ RESEARCHING
→ REVIEWING
→ PROMOTED
→ PAUSED / STOPPED / FAILED
```

### 7.2 实验状态机

```text
QUEUED
→ VALIDATING      （Static Validator 检查）
→ RUNNING
→ SUCCEEDED / FAILED / INVALID
→ ARCHIVED
```

### 7.3 候选晋级状态机

```text
PROPOSED
→ PATCHED
→ VALIDATED       （static_valid）
→ SMOKE_PASS
→ LOW_FIDELITY_PASS
→ FULLY_EVALUATED
→ MULTI_SEED_PASS
→ ACCEPTED / REJECTED
```

### 7.4 任务初始化流程

```text
Create Task
→ Validate TaskSpec
→ Bind Dataset Version
→ Run Diagnostic         → 产出 TaskFingerprint
→ Build Baselines        → 运行 baseline recipes
→ Create Initial Champion Set
→ Ready for Research
```

### 7.5 单轮 Research Iteration

```text
Load task context
→ Retrieve relevant memory
→ Generate CandidateRecipes
→ Validate recipes         （Static Validator）
→ Build patches / configs
→ Run smoke tests
→ Run low-fidelity experiments
→ Rank candidates
→ Run full validation for top-k
→ Multi-seed confirmation
→ Compare with champion
→ Accept / Reject
→ Update memory and lineage
```

### 7.6 完整研究循环状态机（主循环）

```
          ┌──────────────────────────────────────────┐
          │           SETUP（人工触发一次）            │
          │  建分支 → 读文件 → 确认数据 → 初始化 tsv  │
          └──────────────────┬───────────────────────┘
                             │
                     第一次 baseline run（Round 0）
                             │
          ┌──────────────────▼───────────────────────┐
          │           EXPERIMENT LOOP                  │
          │                                            │
          │  提出假设 → 改 train.py → git commit       │
          │       ↓                                    │
          │  smoke run（快速检查 crash）                │
          │       ↓                                    │
          │  低保真实验（少 epoch / 子集）               │
          │       ↓                                    │
          │  通过? → 完整实验（full training）           │
          │       ↓                                    │
          │  ┌────┴────────────────────┐              │
          │  │ crash?                  │              │
          │  │  → tail run.log         │              │
          │  │  → 修复或标记 crash 跳过 │              │
          │  └────┬────────────────────┘              │
          │       ↓                                    │
          │  val_avg_mse 改善?                          │
          │  ├── YES → 记录 keep → Champion 比较        │
          │  └── NO  → 记录 discard → branch reset to   │
          │                last_keep_commit             │
          │                ↓                           │
          │         回到"提出假设"                      │
          └──────────────────────────────────────────┘
                    （人工 Ctrl+C 前不停止）
```

> **图示说明：** 上图是 Phase 1+ 的完整形态。Phase 0 MVP 可以省略 smoke run、低保真筛选和多 baseline 调度，直接执行"改 `train.py` → full run → keep/discard"。

### 7.7 Round 0：基线建立

系统先必须跑一组固定 baseline：

- 统计基线（均值填充预测）
- 线性基线（NLinear CI）← `train.py` 初始版本
- 轻量深度学习基线（MLP）
- 强参照基线（iTransformer 或 PatchTST）

目的不是拿最好分数，而是建立**任务下限、可行训练预算、误差结构**。

> **Phase 0 最低要求：** MVP 只要求把 `train.py` 初始版本的 NLinear CI 跑通并形成 keep/discard 闭环；其余 baseline 可由人工预跑，或延后到 Phase 1 再纳入统一调度。

### 7.8 低保真筛选

对候选先做：

- 少量 epoch（1/5 标准数量）
- 子集序列（1/3 数据）
- 缩短 horizon（仅 96, 720）
- 降低 hidden dim（1/2）
- 单 seed

表现差的候选直接淘汰（节省 GPU 小时）。

> **实现边界：** 低保真筛选是 Phase 1+ 的推荐能力，不是 Phase 0 MVP 的必选实现项。

### 7.9 候选接受规则

一个候选只有满足以下全部条件才能"保留"：

1. `val_avg_mse` 优于当前 champion
2. **Phase 0/1 默认阈值：**
   - 若 `Δval = champion_val_avg_mse - candidate_val_avg_mse >= 0.003`，可直接进入 keep 候选
   - 若 `0.001 <= Δval < 0.003`，仅当 `Δparams_M <= 0.5` 且 `delta_loc <= 40` 时保留
   - 若 `Δval < 0.001`，默认 discard；除非代码减少 ≥ 20 LOC 且参数量不增加
3. **Phase 3+ 多 seed 阈值：**
   - `mean(Δval) >= 0.005`
   - `std(val_avg_mse across seeds) <= 0.003`
4. 参数量/延迟不超预算；若超预算，则仅当 Utility > 0 时允许晋级
5. 无数据泄漏、无接口破坏
6. patch 能独立复现

> 以上阈值是默认初始值，后续可由 `program.md` 或任务级 heuristics 覆盖。

### 7.10 Champion / Challenger 机制

```text
AccuracyGain      = max(0, champion_val_avg_mse - candidate_val_avg_mse) / 0.01
ModelSizePenalty  = max(0, candidate_params_M - champion_params_M)
LatencyPenalty    = max(0, candidate_latency_ms - champion_latency_ms) / 10
VariancePenalty   = std_seed_val / 0.005
FailurePenalty    = failure_rate                      # crash / total_runs
ComplexityPenalty = max(0, delta_loc) / 50

Utility = 1.00 * AccuracyGain
        - 0.20 * ModelSizePenalty
        - 0.10 * LatencyPenalty
        - 0.30 * VariancePenalty
        - 2.00 * FailurePenalty
        - 0.05 * ComplexityPenalty
```

- **Phase 0-2：** Utility 只作为排序与 tie-breaker，不作为硬门槛
- **Phase 3+：** Utility > 0 才能晋级 champion 比较

系统天然朝"小而稳"方向演化。同时维护 Pareto Front：

| 维度 | 含义 |
|------|------|
| 精度最优 | val_avg_mse 最低 |
| 延迟最优 | 推理延迟最低 |
| 参数量最优 | 参数数量最少 |
| 综合最优 | Utility 评分最高 |

> **当前实现进展：** OpenCode Research Service 已在 `research_report_markdown` export 中加入候选级 multi-seed 汇总、95% CI half-width 和 Pareto Frontier 计算。当前 Pareto 使用主指标均值 + `resourceUsage.wallClockSec` 等运行成本字段；结果写入 Markdown 的 `Experiment Analysis` 段，并写入 artifact metadata（`evaluatedRunCount`, `multiSeedCandidateCount`, `paretoFrontierCount`），Web Dashboard 与 TUI Cockpit 会展示这些摘要。候选执行层已增加 `seed-sweep`：按 `taskSpec.evaluation.seeds` 或显式 seeds 顺序执行同一候选，并将 seed 写入 runner payload 与 `resourceUsage.seed`，Web Dashboard、TUI Cockpit、CLI 与 HTTP API 共用同一接口。概率预测链路已支持 `forecastMode=probabilistic`、`val_avg_pinball` / `val_avg_crps_approx` 主指标、quantile head 的 pinball/CRPS 近似/区间 coverage-width 评估与报告展示。`blind_test` 已形成 OpenCode stage / approval / query-limit / CLI/Web/TUI 操作入口 / Neo-Cast runner sidecar HTTP contract；Neo-Cast 已提供可独立部署的 `py/blind_test_sidecar.py` 服务模板，支持 bearer token、query limit 和私有审计 JSONL。真实私有数据接入与长期部署仍属于 Milestone 5 剩余项。

> **Utility 实现口径：** 当前 export 会产出 `Utility Ranking`，以当前 champion（若无则取最优 metric summary）为 reference，计算 accuracy gain，并扣除参数量、延迟、多 seed 方差和代码复杂度惩罚；结果写入 Markdown 与 artifact metadata（`utilityCandidateCount`）。当前 Utility 先用于排序和审计，不直接覆盖 champion 晋级策略。

### 7.11 指标统计口径

为了让接受规则和 Utility 真正可执行，以下观测量必须固定口径：

- `delta_loc`
  定义为当前候选相对父提交在 `train.py` 上的 **changed LOC = added_lines + deleted_lines**；
  统计方式以 `git diff --numstat <parent_commit> -- train.py` 为准，不看净增量。

- `candidate_latency_ms`
  定义为在**同一硬件**上、`device=batch GPU/CPU` 固定、`batch_size=1`、每个 horizon 各 warmup 10 次后再测 50 次 forward 的中位数；
  若当前系统是多 horizon bundle，则取各 horizon latency 的算术平均。

- `failure_rate`
  定义为**当前 task_id、当前 branch、最近 20 次实验**中的失败占比；
  失败包括：非零退出、OOM、NaN 指标、接口不匹配、超时被杀。

- `std_seed_val`
  定义为同一候选在约定 seed 集上的 `val_avg_mse` 标准差；当前 OpenCode export 已可对同一 candidate 的多次 succeeded run 做均值/标准差/最好/最差汇总，runner 侧可通过 `seed-sweep` 自动按约定 seeds 生成这些 run。

- `params_M`
  若当前实现采用多 horizon bundle（每个 horizon 一个模型），则 `params_M` 为 bundle 总参数量；
  所有参数量比较必须在**同一建模口径**下进行，不与单 horizon 单模型直接比较。

---

## 8. 研究记忆系统（Memory Layer）

这是 neo-research 与普通 AutoML **最大的区别**之一。

### 8.1 记忆单元

每次实验写成结构化记录：

```json
{
  "task_fingerprint": "etth1_multivar_512_96-720",
  "parent_recipe": "none_none_linear_temporal_linear_mse_v1",
  "candidate_recipe": "in_decomp_patch_mlp_temporal_linear_mse_v1",
  "hypothesis": "series_decomposition + patch embedding + temporal fusion can improve long-horizon trend fitting",
  "patch_diff": "--- train.py ... +++ train.py ...",
  "recipe_hash": "sha256:abc123",
  "metrics": {"val_avg_mse": 0.4213, "val_h720_mse": 0.4632},
  "resources": {"training_seconds": 412.3, "params_M": 2.14},
  "verdict": "accepted",
  "failure_tags": [],
  "analysis_summary": "decomposition + patch helped on long horizon with strong trend"
}
```

> **隔离说明：** Agent 可读的 research memory 只保存 `val_*`、资源消耗、失败标签和假设摘要；`ref_test_*` 必须进入 Runner/Human Gate 持有的 privileged promotion memory，不进入 Agent 上下文。

### 8.2 三类记忆

**短期记忆（Short-term）**
当前任务最近若干轮实验上下文，供 Research Manager 决策下一个假设。防止重复试验，让 Agent 连续迭代。

**任务记忆（Task-level）**
同一任务下哪些 recipe action 有效、哪些无效。例如："ETTh1 上 `series_decomposition + patch_len=16 + temporal fusion` 有效，`graph fusion` 无效"。记录哪类 action、loss、结构无效，以及哪些失败模式频繁出现。

**跨任务元记忆（Cross-task Meta）**
基于任务指纹进行迁移，例如：

- 强季节性 + 长 horizon → `series_decomposition` / `frequency` / `patch` 优先
- 多变量 + 变量相关性高 → `invert embedding` + `feature fusion` 优先
- 小样本 + 噪声大 → 轻量 `mlp/tcn` backbone + 强正则化或蒸馏优先
- 高频数据 + latency 约束强 → `temporal fusion` + `mlp/tcn/linear` 优先
- 高缺失场景 → 稳健方案优先
- 小数据场景 → 正则化 + 蒸馏优先

### 8.3 实验谱系图（Lineage Tree）

每个 recipe 不是孤立点，而是一棵谱系树：

```
none_none_linear_temporal_linear_mse_v1 (baseline)
├── none_patch_mlp_temporal_linear_mse_v1 [keep: -0.0163 val_mse]
│   ├── in_decomp_patch_mlp_temporal_linear_mse_v1 [keep: -0.0089]
│   │   └── in_decomp_patch_mixer_hybrid_linear_mse_v1 [discard: +0.0021]
│   └── none_patch_mlp_feature_linear_mse_v1 [discard: +0.0149, 8x params]
└── decomp_none_linear_temporal_linear_mse_v1 [discard: -0.0003, not worth added complexity]
```

---

## 9. 严格约束执行环境（Execution Layer）

### 9.1 Sandbox

每次实验在隔离容器里执行，固定：

- Python 版本
- 依赖版本（`pyproject.toml` / `uv.lock`）
- CUDA 环境
- 数据挂载目录（只读；Agent 侧仅挂载 train/val rows）
- 只读基线代码（`prepare_tsf.py`）
- 可写 patch 目录（`train.py`）
- Agent 容器**不挂载** reference test rows / 标签与 privileged promotion log

另设一个 **Runner-only sidecar / service**：

- 只接受已晋级 artifact 的路径或 checkpoint 引用
- 持有 reference test 所需的私有数据挂载或访问令牌
- 输出写入 privileged log（如 `promotion.tsv`），不回写到 Agent workspace
- Agent 进程中没有调用该接口所需的 token / socket / mount

### 9.2 权限控制

Agent 默认不能：

- 任意联网
- 任意安装新包
- 访问测试标签
- 修改评估代码（`prepare_tsf.py`）
- 修改数据加载协议
- 调用 reference test / blind test sidecar
- 跳过 Static Validator

### 9.3 Static Validator 拒绝条件

Static Validator 在每个 patch 执行前检查以下条件，任一触发则拒绝：

- 修改评估协议（`prepare_tsf.py` 相关逻辑）
- 修改数据 split 逻辑
- 越过参数量上限（hard cap: 2× `max_params`）
- 越过算力预算（训练时间预估超上限）
- 使用未注册 action 或非法 action 参数组合
- 接口不兼容（输入/输出 shape 不匹配）

### 9.4 三级代码变更模式

| 级别 | 名称 | 允许操作 | 风险 | 适用阶段 |
|------|------|---------|------|--------|
| L0 | Single-file Research | 只改 `train.py`，用于验证 keep/discard 闭环 | 中 | Phase 0a |
| L1 | Recipe Config Search | 只改已注册 action 的参数（patch size, depth, dropout, lr, scheduler, loss weighting）| 最低 | Phase 0b/1 |
| L2 | Registry Composition | 在注册表中组合已有 action（preprocessing, embedding, backbone, fusion, head, trainer）| 中 | Phase 1/2 |
| L3 | Template Patch | 在受限模板中新增/修改 action（new fusion block, new head, new loss component），需额外审计 | 较高 | Phase 3 |

---

## 10. 模块接口设计（Module Interfaces）

以下接口采用"逻辑接口"描述，后续可映射为 Python service class、gRPC 或 REST。

### 10.1 Task Manager Interface

```python
def create_task(task_spec: TaskSpec) -> TaskRecord
def get_task(task_id: str) -> TaskRecord
def update_task_status(task_id: str, status: TaskStatus) -> None
```

### 10.2 Dataset Service Interface

```python
def load_dataset(task_id: str) -> DatasetBundle
def build_splits(task_spec: TaskSpec) -> SplitBundle
def materialize_features(split_bundle: SplitBundle,
                         transform_spec: TransformSpec) -> FeatureBundle
```

### 10.3 Diagnostic Service Interface

```python
def diagnose_task(dataset_bundle: DatasetBundle,
                  task_spec: TaskSpec) -> TaskFingerprint
```

### 10.4 Baseline Builder Interface

```python
def run_baselines(task_id: str,
                  baseline_set: list[str]) -> list[ExperimentRecord]

def select_initial_champion(records: list[ExperimentRecord]) -> ChampionRecord
```

### 10.5 Proposal Engine Interface

```python
def generate_proposals(task_id: str,
                       fingerprint: TaskFingerprint,
                       champion: ChampionRecord,
                       memory_context: MemoryContext,
                       budget: BudgetSpec,
                       k: int) -> list[Proposal]
```

每个 `Proposal` 必须包含：`hypothesis`, `target_actions`, `candidate_recipe`, `expected_gain`, `risk_level`, `est_cost`。

### 10.6 Patch Generator Interface

```python
def build_patch(proposal: Proposal,
                base_recipe: CandidateRecipe) -> PatchBundle
```

`PatchBundle` 包括：`recipe_delta`, `compiled_model_delta`, `code_patch_text`, `validation_manifest`。

### 10.7 Static Validator Interface

```python
def validate_patch(task_spec: TaskSpec,
                   patch_bundle: PatchBundle,
                   budget: BudgetSpec) -> ValidationResult
# ValidationResult: passed: bool, violations: list[str], warnings: list[str]
```

### 10.8 Experiment Runner Interface

```python
def run_experiment(task_id: str,
                   experiment_spec: ExperimentSpec) -> ExperimentRecord

def run_multi_seed(task_id: str,
                   experiment_spec: ExperimentSpec,
                   seeds: list[int]) -> list[ExperimentRecord]
```

### 10.9 Evaluator Interface

```python
def evaluate_candidate(challenger: CandidateRecord,
                       champion: ChampionRecord,
                       promote_rule: PromoteRule) -> PromotionDecision

def generate_analysis(experiment_records: list[ExperimentRecord]) -> AnalysisReport
```

### 10.10 Memory Service Interface

```python
def write_memory(memory_item: MemoryItem) -> None

def retrieve_similar_tasks(fingerprint: TaskFingerprint,
                           top_k: int = 5) -> list[MemoryItem]

def retrieve_failure_patterns(task_id: str,
                              action_name: str) -> list[FailurePattern]
```

---

## 11. 核心数据结构设计（Core Data Structures）

### 11.1 TaskSpec

```python
from dataclasses import dataclass
from typing import Literal, Optional

@dataclass
class DatasetSpec:
    loader_id: str
    target_cols: list[str]
    known_future_covariates: list[str]
    observed_past_covariates: list[str]   # excludes cols already listed in target_cols
    static_covariates: list[str]

@dataclass
class TaskSpec:
    task_id: str
    name: str
    task_type: Literal["forecasting"]
    forecast_mode: Literal["point", "probabilistic"]
    series_type: Literal["univariate", "multivariate"]
    context_length: int
    prediction_lengths: list[int]
    dataset_spec: DatasetSpec
    split_spec: "SplitSpec"
    eval_spec: "EvalSpec"
    budget_spec: "BudgetSpec"
    search_space_spec: "SearchSpaceSpec"
```

### 11.2 SplitSpec

```python
@dataclass
class SplitSpec:
    scheme: Literal["fixed_row_index", "rolling_origin"]
    train: tuple[int, int]
    val: tuple[int, int]
    test: tuple[int, int] | None
    test_exposure: Literal["promotion_only", "hidden"]
    blind_test: Literal["none", "phase5_service"]
    rolling_windows: Optional[int] = None
```

### 11.3 EvalSpec

```python
@dataclass
class EvalSpec:
    protocol: Literal["fixed_split", "rolling_origin"]
    metrics: list[str]
    primary_metric: str
    reference_metric: str | None
    agent_visible_metrics: list[str]
    privileged_metric_names: list[str]
    seeds: list[int]
    promote_threshold: float | None
    use_shadow_holdout: bool
    use_blind_test: bool
```

### 11.4 BudgetSpec

```python
@dataclass
class BudgetSpec:
    max_trials: int
    max_gpu_hours: float
    max_params: int
    max_latency_ms: float
    max_peak_mem_mb: int
```

### 11.5 SearchSpaceSpec

```python
@dataclass
class SearchSpaceSpec:
    preprocessing_actions: list["ActionSpec"]
    embedding_actions: list["ActionSpec"]
    backbone_actions: list["ActionSpec"]
    fusion_actions: list["ActionSpec"]
    prediction_heads: list["ActionSpec"]
    training_strategies: list["ActionSpec"]
    loss_ops: list["ActionSpec"]
    patch_mode: Literal["config_only", "registry_only", "template_patch"]
```

### 11.5.1 ActionSpec

`ActionSpec` 是 Static Validator 能真正工作的基础。每个 action 必须声明参数 schema、shape contract、相邻 action 兼容性和预算估计器。

```python
@dataclass
class ShapeSpec:
    layout: Literal["BLC", "BCL", "BNC", "BHD", "custom"]
    rank: int
    semantic_axes: list[str]  # e.g. ["batch", "time", "channel"]

@dataclass
class ActionSpec:
    name: str
    kind: Literal["preprocessing", "embedding", "backbone", "fusion", "head", "postprocessing", "trainer", "loss"]
    param_schema: dict
    default_params: dict
    input_shape: ShapeSpec | None
    output_shape: ShapeSpec | None
    compatible_prev: list[str]
    compatible_next: list[str]
    requires_fields: list[str]      # e.g. ["time_features", "known_future_covariates"]
    phase_min: Literal["phase0b", "phase1", "phase2", "phase3"]
    estimate_params_fn: str | None
    estimate_latency_fn: str | None
```

### 11.6 TaskFingerprint

```python
@dataclass
class TaskFingerprint:
    freq: str
    n_series: int
    n_channels: int
    missing_ratio: float
    seasonality_score: float
    trend_score: float
    volatility_score: float
    intermittency_score: float
    cross_var_corr_score: float
    transition_score: float
    distribution_shift_score: float
    covariate_availability_score: float
    horizon_context_ratio: float
    data_scale_stability: float
```

### 11.7 CandidateRecipe

```python
@dataclass
class CandidateRecipe:
    recipe_id: str
    recipe_version: str
    preprocessing: dict
    embedding: dict
    backbone: dict
    fusion: dict
    prediction_head: dict
    post_processing: dict   # {"type": "auto"} allowed; runtime expands derived steps
    training_strategy: dict
    constraints: dict
    rationale: str
    estimated_params: int
```

### 11.8 ModelSpec

`ModelSpec` 是 runtime 从 `CandidateRecipe` 编译后的可执行模型规格，主要供 Runner、Evaluator 和 Artifact Store 使用。

```python
@dataclass
class ModelSpec:
    recipe_id: str
    compiled_modules: dict
    input_shape: tuple[int, ...]
    output_shape: tuple[int, ...]
    train_objective: dict
    inference_policy: dict
    estimated_params: int
```

### 11.9 Proposal

```python
@dataclass
class Proposal:
    proposal_id: str
    parent_recipe_id: str
    hypothesis: str
    target_actions: list[str]
    change_type: Literal["recipe", "loss", "trainer", "inference", "template_patch"]
    candidate_recipe: CandidateRecipe
    expected_gain: str
    risk_level: Literal["low", "medium", "high"]
    est_gpu_hours: float
    est_params_delta: int
```

### 11.10 PatchBundle

```python
@dataclass
class PatchBundle:
    proposal_id: str
    recipe_delta: dict
    compiled_model_delta: dict
    code_patch_text: str | None
    manifest: dict
```

### 11.11 ExperimentSpec

```python
@dataclass
class ExperimentSpec:
    experiment_id: str
    task_id: str
    stage: Literal["smoke", "low_fidelity", "full", "multi_seed"]
    parent_recipe_id: str
    candidate_recipe: CandidateRecipe
    model_spec: ModelSpec
    transform_spec: dict
    trainer_spec: dict
    eval_spec: EvalSpec
    seed: int
```

### 11.12 ExperimentRecord

```python
@dataclass
class ExperimentRecord:
    experiment_id: str
    task_id: str
    recipe_id: str
    status: Literal["queued", "running", "succeeded", "failed", "invalid"]
    agent_metrics: dict
    privileged_metrics_ref: str | None   # e.g. promotion_id / URI into privileged store
    resource_usage: dict
    artifacts: dict
    logs_uri: str
    error_message: str | None
```

### 11.13 ChampionRecord

```python
@dataclass
class ChampionRecord:
    recipe_id: str
    task_id: str
    candidate_recipe: CandidateRecipe
    model_spec: ModelSpec
    agent_aggregate_metrics: dict
    privileged_promotion_ref: str | None
    resource_profile: dict
    lineage_root: str
    accepted_at: str
```

### 11.14 PromotionDecision

```python
@dataclass
class PromotionDecision:
    promote: bool
    reason: str
    metric_delta: dict
    complexity_delta: dict
    stability_delta: dict
    violates_budget: bool
```

### 11.15 MemoryItem

```python
@dataclass
class MemoryItem:
    memory_id: str
    task_id: str
    fingerprint_summary: dict
    recipe_summary: dict
    hypothesis: str
    patch_summary: dict
    outcome: Literal["accepted", "rejected", "failed"]
    agent_gain_summary: dict
    privileged_gain_ref: str | None
    failure_tags: list[str]
    lesson: str
```

> **隔离约束：** `EvalSpec` 只能声明哪些指标属于 privileged 域；运行态记录中的 `privileged_*_ref` 都只能存 opaque 标识符（例如 `promotion_id`、对象存储 URI、Metrics DB 主键），不能直接内嵌 `ref_test_*` 数值；Agent 上下文只消费 `agent_*` 字段。

### 11.16 Supporting Records

接口层使用的辅助类型后续可以细化为独立 schema；第一版至少需要以下最小定义，避免服务接口只停留在占位符。

```python
@dataclass
class TaskRecord:
    task_id: str
    status: str
    task_spec: TaskSpec
    created_at: str

TaskStatus = Literal["created", "diagnosing", "baselining", "ready", "researching", "reviewing", "promoted", "paused", "stopped", "failed"]

@dataclass
class DatasetBundle:
    dataset_id: str
    train_ref: str
    val_ref: str
    metadata: dict

@dataclass
class SplitBundle:
    train: object
    val: object
    test_ref: str | None

@dataclass
class TransformSpec:
    recipe_id: str
    preprocessing: dict
    feature_fields: list[str]

@dataclass
class FeatureBundle:
    train_features_ref: str
    val_features_ref: str
    metadata: dict

@dataclass
class MemoryContext:
    similar_memories: list[MemoryItem]
    recent_task_memories: list[MemoryItem]
    failure_patterns: list["FailurePattern"]

@dataclass
class ValidationResult:
    passed: bool
    violations: list[str]
    warnings: list[str]

@dataclass
class CandidateRecord:
    candidate_recipe: CandidateRecipe
    model_spec: ModelSpec
    experiment_records: list[ExperimentRecord]
    aggregate_metrics: dict

@dataclass
class PromoteRule:
    primary_metric: str
    min_delta: float
    max_params: int
    max_latency_ms: float

@dataclass
class FailurePattern:
    action_name: str
    failure_tags: list[str]
    count: int
    lesson: str

@dataclass
class AnalysisReport:
    summary: str
    metric_breakdown: dict
    failure_analysis: dict
    next_suggestions: list[str]
```

---

## 12. 目录结构建议

完整系统的参考目录布局：

```text
neo_research/
  configs/
    tasks/              ← TaskSpec YAML 文件
    search_spaces/      ← SearchSpaceSpec YAML
    recipes/            ← CandidateRecipe YAML / JSON
    baselines/          ← baseline recipe 配置
  core/
    task_manager.py
    orchestrator.py
    state_machine.py
  datasets/
    loaders/
    splitters/
    transforms/
  diagnostics/
    fingerprint.py
    statistics.py
  registry/
    preprocessing/
    embeddings/
    backbones/
    fusions/
    heads/
    losses/
    trainers/
    postprocessing/
  factory/
    build_model.py      ← CandidateRecipe -> ModelSpec / nn.Module
    shape_inference.py
  proposals/
    proposal_engine.py
    heuristics.py
    llm_planner.py
  patching/
    patch_generator.py
    validators.py       ← Static Validator 实现
  execution/
    runner.py
    sandbox.py
    scheduler.py
  evaluation/
    metrics.py
    promotion.py        ← PromotionDecision 逻辑
    analysis.py
  memory/
    memory_store.py
    retriever.py
    lineage.py
  governance/
    permissions.py
    audit.py
    blind_test.py
  api/
    service.py
    schemas.py
  ui/
    dashboard/
```

Phase 0a 只需要：`prepare_tsf.py`, `train.py`, `program.md`。Phase 0b 开始补充 `configs/recipes/` 与最小 `CandidateRecipe` schema；其他目录随系统演进逐步填充。

---

## 13. MVP 实现层：文件结构与接口

### 13.1 冻结层：`prepare_tsf.py`

`prepare_tsf.py` 是实验的"不可动摇的地基"，其实现直接参照 Time-Series-Library 的数据加载与评估逻辑。agent **绝不可以**修改此文件。

**固定常量：**

```python
import os
# ─── 数据集 ──────────────────────────────────────────────────────────────────
DATASET        = "ETTh1"
DATA_PATH      = "ETTh1.csv"
# 数据根目录：由 Human/Runner 在 Agent 容器外预置本地 CSV；Phase 0 不依赖 Agent 联网下载
DATA_ROOT      = os.path.expanduser("~/.cache/neo_research_tsf/dataset/ETT-small/")
NUM_CHANNELS   = 7             # ETTh1 共 7 个变量（HUFL/HULL/.../OT）

# ─── 时间窗口 ────────────────────────────────────────────────────────────────
INPUT_LEN      = 512           # look-back window（agent 不可修改）
HORIZONS       = [96, 192, 336, 720]   # 全部 horizon 同时评估

# ─── ETTh1 数据集切分边界（硬编码，与 TSL Dataset_ETT_hour 完全一致）────────
# train: 行 [0,       8640)      → 12个月 × 30天 × 24小时
# val:   行 [8640,   11520)      → 再 4个月
# test:  行 [11520,  14400)      → 再 4个月
BORDER_TRAIN   = (0,                    12 * 30 * 24)                        # (0, 8640)
BORDER_VAL     = (12 * 30 * 24,         12 * 30 * 24 + 4 * 30 * 24)         # (8640, 11520)
BORDER_TEST    = (12 * 30 * 24 + 4 * 30 * 24, 12 * 30 * 24 + 8 * 30 * 24)  # (11520, 14400)

# ─── 计算预算 ────────────────────────────────────────────────────────────────
TIME_BUDGET    = 600           # 单次实验训练时长上限，秒（10 分钟）

# ─── 参数规模软约束 ──────────────────────────────────────────────────────────
PARAM_BUDGET   = 10_000_000    # 10M 参数软上限（超出在日志中 WARNING，不强制中止）

# ─── 随机种子 ────────────────────────────────────────────────────────────────
SEED           = 42
```

**标准化协议（TSL 一致）：**

完全采用 TSL 的标准化方式：**sklearn `StandardScaler`，仅在训练段 fit，并复用同一组 train 统计量**。实现上分成两个可见域：

- Agent workspace 只物化 `train + val` 行
- Runner sidecar 私有持有 `reference test` 行，并复用同一个 scaler

评估时不做 inverse transform（在 scaled space 中计算 MSE/MAE），与 TSL 默认行为（`args.inverse=False`）一致。

```python
from sklearn.preprocessing import StandardScaler

scaler = StandardScaler()
train_raw = df_visible[BORDER_TRAIN[0]:BORDER_TRAIN[1]].values   # shape: [8640, 7]
scaler.fit(train_raw)          # fit 仅在 train 段

# Agent 可见：只对 train/val rows 做 transform
visible_scaled = scaler.transform(df_visible.values)            # shape: [11520, 7]

# Runner sidecar 私有：对 reference test rows 复用同一 scaler
# ref_test_scaled = scaler.transform(df_ref_test.values)        # shape: [2880, 7]
```

> **为什么不用 RevIN？** RevIN 在 forward 时进行实例级动态归一化，会影响 agent 设计 loss 的方式（agent 需要感知是否已反归一化）。固定使用静态 StandardScaler 能让 agent 专注于模型架构本身，同时评估结果直接与 TSL 发布的 baseline 数字可比。

**Agent 可见数据加载接口（`make_dataloader`）：**

```python
def make_dataloader(split: str, horizon: int, batch_size: int,
                    shuffle: bool = None) -> DataLoader:
    """
    split: "train" | "val"
    horizon: 预测步数，从 HORIZONS 列表中取值

    每条样本：
      x: Tensor[INPUT_LEN, NUM_CHANNELS]     ← 历史观测（scaled）
      y: Tensor[horizon,   NUM_CHANNELS]     ← 预测目标（scaled）

    注意：
    - val 集 shuffle=False（固定顺序）
    - train 集 shuffle=True by default
    - Phase 0a 不返回 time features
    - Phase 1 之前，Agent 不应在 `train.py` 中私自回读原始 CSV 构造隐藏时间字段
    - `calendar` embedding 需要 Phase 2+ 通过冻结接口显式返回 x_mark / y_mark 或 known future covariates
    """
```

> **隔离要求：** `prepare_tsf.py` 对 Agent 只导出 `train/val` loader。reference test / blind test loader 若实现为本地函数，也必须位于 Runner sidecar 或 Agent 不可挂载的私有目录中，不能被 `train.py` import。

> **与 TSL 的简化差异：** TSL 的 `__getitem__` 同时返回 `(seq_x, seq_y, seq_x_mark, seq_y_mark)` 以支持 Transformer decoder 中的 teacher forcing。neo-research TSF 简化为 `(x, y)`，去掉 `label_len` 和时间戳特征。这使 agent 写模型时更简洁；若后续确实需要时间戳特征，应由 Human/Runner 在冻结层显式扩展接口，而不是让 `train.py` 私自回读原始 CSV 或重建隐藏字段。

**Agent 可见评估函数（主指标定义）：**

```python
@torch.no_grad()
def evaluate_val_tsf(model_or_models, device) -> dict:
    """
    仅在 val split 上评估所有 HORIZONS。

    计算在 SCALED SPACE（StandardScaler 归一化后）的 MSE 和 MAE，
    与 TSL exp_long_term_forecasting.py 的 metric() 函数行为一致。

    model_or_models：
      - 若为 dict {horizon: model}，则逐 horizon 分别评估
      - 若为单个 nn.Module，则用同一模型评估所有 horizon

    返回 dict，key 包括：
      "val_avg_mse"  — 多 horizon 平均 MSE（主指标）
      "val_avg_mae"  — 多 horizon 平均 MAE
      "val_h{H}_mse" — 各 horizon 的 MSE
      "val_h{H}_mae" — 各 horizon 的 MAE
    """
```

**Runner-only privileged 接口：**

```python
def query_ref_test(artifact_uri: str, task_id: str, promotion_token: str) -> dict:
    """
    由 Runner/Human Gate 调用的 privileged 接口。

    - 读取独立的 reference test 数据或服务
    - 返回 ref_test_* 指标
    - 结果写入 privileged promotion log，不暴露给 Agent 进程
    """

def query_blind_test(artifact_uri: str, task_id: str, promotion_token: str) -> dict:
    """
    由 Runner/Human Gate 调用的外部 blind-test sidecar 接口。

    - 通过 NEO_TSF_BLIND_TEST_URL / NEO_TSF_BLIND_TEST_TOKEN 调用私有服务
    - 仓库内只传递 artifact_uri、task_id、promotion_token
    - 返回 blind_test_* 指标；私有标签和评分实现不进入 Agent 可见仓库
    """
```

`train.py` 的标准调用方式：

```python
# keep/discard 依据：val 集
val_results = evaluate_val_tsf(models, device=device)

# 仅在 promotion 阶段，由 Runner/Human Gate 在 Agent 进程外调用：
# ref_test_results = query_ref_test(artifact_uri, task_id, promotion_token)
```

**默认 Summary 样例（Agent 可见，供 grep 解析，格式固定）：**

```
---
val_avg_mse:      0.437600
val_h96_mse:      0.391200   val_h96_mae:      0.402100
val_h192_mse:     0.423500   val_h192_mae:     0.427800
val_h336_mse:     0.453800   val_h336_mae:     0.451200
val_h720_mse:     0.481900   val_h720_mae:     0.479400
training_seconds: 587.2
total_seconds:    612.4
peak_vram_mb:     4210.3
num_params_M:     2.14
```

**Runner-side promotion log 样例（不由 `train.py` 打印，Agent 默认不可见）：**

```text
ref_test_avg_mse: 0.454800
ref_test_h96_mse: 0.397100   ref_test_h96_mae: 0.413200
...
```

> **为什么默认不输出 test？** `val_avg_mse` 是唯一 keep/discard 决策信号。公开 `test` 只在晋级节点由 Runner/Human Gate 查询，用于和 TSL 已发布结果做参考对齐；真正 blind test 进一步后移到独立服务。

---

### 13.2 实验层：`train.py`

**Phase 0/MVP 中 agent 的自由度范围：**

`train.py` 是 agent **唯一可以修改的文件**，可改动范围包括：

**模型架构（单文件内自由）：**
- 网络类型：Transformer、MLP、TCN、CNN、SSM、线性模型、混合架构等
- 深度与宽度：层数、隐藏维度、注意力头数
- Channel 策略：Channel-Independent（CI）或 Channel-Dependent（CD）
- Patch 设计：patch size、stride、是否使用 overlap
- 位置编码、归一化位置、激活函数、残差连接方式

**训练策略（单文件内自由）：**
- Loss 函数：MSE、MAE、Huber、分位数损失、自定义组合（仅限 Phase 0；Phase 2+ 应收敛到 grammar / registry）
- 优化器：Adam、AdamW、SGD、任意变体
- 学习率及 schedule：cosine、linear warmup/warmdown 等
- Batch size、训练 epoch 数量（在 TIME_BUDGET 范围内）
- Dropout、正则化方式
- 数据增强（仅对训练集，不能改验证/测试集）

**模型接口约定：**

```
x: FloatTensor [B, INPUT_LEN, NUM_CHANNELS]   ← 历史窗口，scaled
y: FloatTensor [B, horizon,   NUM_CHANNELS]   ← 预测目标，scaled

pred = model(x)   # → [B, horizon, NUM_CHANNELS]
```

**`train.py` 初始 baseline（NLinear CI）：**

```python
"""
neo-research TSF training script. Agent edits ONLY this file.
Usage: uv run train.py
"""
from prepare_tsf import (
    INPUT_LEN, HORIZONS, NUM_CHANNELS, TIME_BUDGET, PARAM_BUDGET, SEED,
    make_dataloader, evaluate_val_tsf,
)
import torch
import torch.nn.functional as F
import time

# ─── 超参数（agent 可直接修改这些以及下方所有内容）───────────────────────────
BATCH_SIZE  = 32
LR          = 1e-3
MAX_EPOCHS  = 100      # 在 TIME_BUDGET 内跑尽量多的 epoch；建议配合 early stopping

# ─── 模型定义 ──────────────────────────────────────────────────────────────────
class TSFModel(torch.nn.Module):
    """
    Baseline: Channel-Independent per-channel linear（NLinear-style）。
    每个 channel 独立做线性映射，是 TSF 领域最简的有效 baseline。
    参考：DLinear / NLinear (AAAI 2023)。
    """
    def __init__(self, input_len: int, horizon: int):
        super().__init__()
        self.linear = torch.nn.Linear(input_len, horizon)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: [B, L, C]  →  [B, H, C]
        B, L, C = x.shape
        x = x.permute(0, 2, 1).reshape(B * C, L)     # [B*C, L]
        out = self.linear(x)                           # [B*C, H]
        return out.reshape(B, C, -1).permute(0, 2, 1)  # [B, H, C]

# ─── 训练循环 ──────────────────────────────────────────────────────────────────
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
torch.manual_seed(SEED)
t_start = time.time()

models = {h: TSFModel(INPUT_LEN, h).to(device) for h in HORIZONS}
optimizers = {h: torch.optim.Adam(models[h].parameters(), lr=LR) for h in HORIZONS}

for horizon in HORIZONS:
    train_loader = make_dataloader("train", horizon, BATCH_SIZE, shuffle=True)
    val_loader   = make_dataloader("val",   horizon, BATCH_SIZE, shuffle=False)
    model, opt   = models[horizon], optimizers[horizon]

    best_val_loss = float("inf")
    patience_counter = 0
    PATIENCE = 7  # early stopping patience（参照 TSL 默认值）

    for epoch in range(MAX_EPOCHS):
        if time.time() - t_start >= TIME_BUDGET:
            break

        model.train()
        for x, y in train_loader:
            x, y = x.to(device), y.to(device)
            loss = F.mse_loss(model(x), y)
            opt.zero_grad(); loss.backward(); opt.step()

        model.eval()
        val_loss = 0.0
        with torch.no_grad():
            for x, y in val_loader:
                val_loss += F.mse_loss(model(x.to(device)), y.to(device)).item()
        val_loss /= len(val_loader)

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            patience_counter = 0
            torch.save(model.state_dict(), f"/tmp/neo_tsf_best_h{horizon}.pt")
        else:
            patience_counter += 1
            if patience_counter >= PATIENCE:
                break

    model.load_state_dict(torch.load(f"/tmp/neo_tsf_best_h{horizon}.pt"))
    model.eval()

# ─── 评估 ──────────────────────────────────────────────────────────────────────
t_train_end = time.time()
val_results = evaluate_val_tsf(models, device=device)

# ─── Summary 输出（格式固定，供 grep 解析）─────────────────────────────────────
training_seconds = t_train_end - t_start
total_seconds    = time.time() - t_start
num_params = sum(p.numel() for m in models.values() for p in m.parameters())

print("---")
print(f"val_avg_mse:      {val_results['val_avg_mse']:.6f}")
for h in HORIZONS:
    print(f"val_h{h}_mse:     {val_results[f'val_h{h}_mse']:.6f}   "
          f"val_h{h}_mae:     {val_results[f'val_h{h}_mae']:.6f}")
print(f"training_seconds: {training_seconds:.1f}")
print(f"total_seconds:    {total_seconds:.1f}")
print(f"peak_vram_mb:     {(torch.cuda.max_memory_allocated() / 1024 / 1024) if torch.cuda.is_available() else 0.0:.1f}")
print(f"num_params_M:     {num_params / 1e6:.2f}")
if num_params > PARAM_BUDGET:
    print(f"WARNING: num_params ({num_params/1e6:.1f}M) exceeds PARAM_BUDGET ({PARAM_BUDGET/1e6:.0f}M)")
```

---

### 13.3 策略层：`program.md`

`program.md` 是 **agent 行为协议**，由人类研究员编写和迭代。

**Setup 阶段：**

```markdown
## Setup

1. **约定实验 tag**：例如 `apr21-etth1`。创建分支 `neo-research/<tag>`。
2. **读入上下文文件**：
   - `prepare_tsf.py` — 了解固定常量、数据切分、评估协议
   - `train.py` — 了解 baseline 模型和当前实验起点
   - `results.tsv` — 了解历史实验轨迹（仅 Agent 可见指标）
3. **确认数据就绪**：检查数据集是否已下载到 `~/.cache/neo_research_tsf/`
4. **初始化 results.tsv**：写入 header 行
5. **初始化 promotion.tsv**：由 Runner/Human Gate 持有；Agent 不读取
6. **记录 `last_keep_commit`**：初始化为当前 baseline commit；之后每次 keep 成功都更新
7. **确认后开始实验循环**
```

**实验循环（核心协议）：**

```markdown
## 实验循环

LOOP FOREVER:

1. 查看当前 git 状态（所在 commit）
2. 提出一个研究假设（要修改什么、为什么可能有效）
3. 修改 `train.py`
4. git commit（带一句话描述）
5. 运行实验：`uv run train.py > run.log 2>&1`
6. 读取结果：
   `grep "^val_avg_mse:\|^num_params_M:\|^WARNING" run.log`
7. 若 grep 为空，则 crash：读 `tail -50 run.log`，尝试修复
8. 记录结果到 results.tsv（不提交 git）
9. 决策（以 val_avg_mse 为准）：
   - val_avg_mse **降低** → keep，保留 commit，并更新 `last_keep_commit=$(git rev-parse HEAD)`
   - val_avg_mse **持平或升高** → discard。语义上必须让实验分支的 `HEAD` 真正回到 `last_keep_commit`
     （专用 research branch 且 worktree clean 时：`git reset --hard <last_keep_commit>`）
     若存在其他未提交改动，则停止自动循环并交由 Human 处理；不要只恢复 `train.py` 内容而保留 rejected commit 为当前 `HEAD`
10. 若累计 `PROMOTION_INTERVAL`（默认 5）次 keep，则由 Runner/Human Gate 触发一次 reference test 查询；
    该结果只写入 `promotion.tsv`，不回灌进 Agent 上下文
11. 回到步骤 1
```

**TSF 专属研究方向提示：**

```markdown
## 研究方向参考（按优先级排序）

优先尝试：
- Channel-Independent（CI）→ Channel-Dependent（CD）策略切换
  （CI 对每 channel 独立预测；CD 显式建模 channel 间依赖，如 iTransformer）
- Patch 化输入（patch size = 16/32，stride = 8/16，参考 PatchTST）
- 去趋势分解：将序列分解为 trend（moving average）+ remainder，分别建模
  （参考 TSL 中的 DLinear 分解思路）
- 用 MLP-Mixer 替代 Attention（计算更高效，seq_len 长时收益明显）
- 频域特征：FFT 系数作为辅助输入（与时域特征 concat）

次要探索：
- 跨 horizon 参数共享：单模型 + 不同 pred_len projection head
- 多尺度时序特征融合（不同 patch size 并行 branch，最终 concat）
- 非对称 Loss：对上行/下行误差差异化惩罚
- Distillation：以 iTransformer 为 teacher，小 MLP 为 student

## 简洁性标准（继承自 autoresearch）

- 提升 0.005 val_avg_mse 但新增 80 行复杂代码：不值得保留
- 提升 0.005 val_avg_mse 且删减了代码：一定保留
- 提升为 0 但代码更简洁：保留（简化胜利）
- 参数量增加超过 5M 且提升 < 0.010 val_avg_mse：不保留

## 模型规模惩罚规则

当 val_avg_mse 改善量 Δ 与参数增量 ΔP 满足：
  Δ / (ΔP / 1e6) < 0.005
  （即每增加 1M 参数，改善不足 0.005 MSE）
→ 该变化视为"不划算"，建议 discard。
```

---

## 14. 日志文件设计（Tab 分隔，不提交 git）

### 14.1 `results.tsv`（Agent 可见）

```
commit	recipe_id	parent_recipe_id	recipe_hash	stage	seed	val_avg_mse	val_h96_mse	val_h720_mse	params_M	status	failure_tags	description
a1b2c3d	none_none_linear_temporal_linear_mse_v1	NA	sha256:aaa	full	42	0.437600	0.391200	0.481900	2.14	keep	[]	baseline: NLinear CI + early_stop p=7
b2c3d4e	none_patch_mlp_temporal_linear_mse_v1	none_none_linear_temporal_linear_mse_v1	sha256:bbb	full	42	0.421300	0.378400	0.463200	2.14	keep	[]	patch CI: patch=16 stride=8
c3d4e5f	none_token_transformer_feature_linear_mse_v1	none_patch_mlp_temporal_linear_mse_v1	sha256:ccc	full	42	0.443100	0.401200	0.485000	8.30	discard	[]	4-layer Transformer CD: worse+8x params
d4e5f6g	none_token_transformer_feature_linear_mse_v2	none_patch_mlp_temporal_linear_mse_v1	sha256:ddd	full	42	NA	NA	NA	NA	crash	["oom"]	OOM with full-attn bs=256
```

列说明：
- `recipe_id` / `parent_recipe_id` / `recipe_hash`：追踪 recipe 谱系与可复现配置
- `stage`：`smoke` / `low_fidelity` / `full` / `multi_seed`
- `seed`：当前实验随机种子
- `val_avg_mse`：**主指标**，keep/discard 的唯一决策依据（val 集，scaled space）
- `val_h96_mse` / `val_h720_mse`：短期和长期 horizon 代表值，便于观察是否偏科
- `params_M`：所有 horizon 模型参数总量（百万）
- `status`：`keep` / `discard` / `crash`
- `failure_tags`：结构化失败标签，如 `oom`, `nan`, `timeout`, `shape_mismatch`
- 当 `status=crash` 时，数值列应写 `NA`，并在任何排序、聚合、champion 比较前先过滤

### 14.2 `promotion.tsv`（privileged log，仅 Runner/Human Gate 可见）

```
commit	ref_test_avg_mse	ref_test_h96_mse	ref_test_h720_mse	latency_ms	promotion_note
b2c3d4e	0.439500	0.383200	0.489700	2.8	first promotion check passed
```

- `promotion.tsv` 不进入 Agent 上下文，不作为下一轮假设生成的输入
- Agent 只能看到 `results.tsv`
- `promotion.tsv` 只是逻辑示例名；物理上应存放在 Agent 不可挂载的私有目录、对象存储或 Metrics DB 中，而不是 Agent workspace

> **Sanity check：** baseline（NLinear CI，INPUT_LEN=512）的 `ref_test_h96_mse` 可参考 TSL 论文中 NLinear on ETTh1 H=96 的结果（约 0.386）。由于当前协议包含 `INPUT_LEN=512`、多 horizon 同轮评估、time-budget 和 early stopping 等差异，该检查只用于发现明显的数据切分或标准化错误，不作为严格 leaderboard 对齐阈值。若要严格对齐，应启用单独的 TSL-compatible baseline mode。

---

## 15. 时序预测专属能力

### 15.1 多任务类型支持

| 任务类型 | 描述 |
|---------|------|
| univariate forecasting | 单变量，标准 M4/M5 场景 |
| multivariate forecasting | 多变量联合预测，ETT/Weather/Traffic |
| exogenous forecasting | 含已知未来协变量（如日历特征） |
| point forecasting | 点预测，MSE/MAE 评估 |
| probabilistic forecasting | 分布预测，CRPS/Pinball 评估 |

> ProbTS 已明确表明，不同 horizon 与 point/distributional 设置会显著改变模型偏好，系统设计时不能只盯住单一 long-term point forecast。

### 15.2 任务指纹提取

建议对每个任务自动提取：

- seasonality period
- autocorrelation signature
- intermittency（间歇性）
- trend strength
- change points
- missing ratio
- covariate availability
- target scale stability
- horizon/context ratio

### 15.3 多维度误差诊断

Analyst Agent 除了看 aggregate metric，还应输出：

- 各 horizon 误差（是否长尾偏差）
- 各序列 bucket 误差（是否集中在某类序列）
- 峰值段误差（是否在高波动期表现差）
- 节假日/异常日误差
- 训练不稳定性（多 epoch 方差）

---

## 16. 人机协同机制（Human Control Layer）

系统不是取代研究员，而是把人从"重复调试"中解放出来。

### 16.1 人负责

- 定义任务（TaskSpec）
- 冻结数据协议与评估协议
- 批准搜索空间扩展（从 L1 到 L2/L3）
- 设定研究目标与迭代方向（编写/修改 `program.md`）
- 审核最终 champion，决定是否晋级 blind test
- 偶尔重写 `train.py` baseline，重置搜索起点

### 16.2 Agent 负责

- 高频试验（每轮提出假设、改代码、跑实验、记录结果）
- 自动归因实验成败
- patch 迭代（delta-based，keep/discard 循环）
- 失败总结与知识沉淀
- 候选生成与推荐

### 16.3 建议保留的人工闸门

| 闸门 | 触发时机 |
|-----|---------|
| 新任务立项 | 新建 TaskSpec 时 |
| 搜索空间扩展 | 从 L1 升 L2/L3 时 |
| Shadow Holdout 查询 | 每 N 次 keep 后 |
| Blind Test 晋级 | 最终 champion 候选 |
| 代码合并到主干 | 完整实验周期结束 |

### 16.4 审计与回滚

**审计日志**：每次候选都记录：谁提出、改了什么、在哪一版上改、跑了哪些实验、为什么晋级/拒绝、是否触发人工审批。

**回滚机制**：任何 champion 都必须支持：
- 一键回滚到父版本
- 一键重跑确认
- 一键导出 patch diff

---

## 17. 关键设计对比

### 17.1 与 autoresearch 的差异

| 维度 | autoresearch（LLM pretraining） | neo-research TSF |
|------|--------------------------------|-----------------|
| 任务类型 | 语言模型预训练 | 时间序列多步预测 |
| 数据规模 | 数十亿 token | 数万条时序样本 |
| 训练时间预算 | 300s（5 分钟） | 600s（10 分钟） |
| 主指标 | val_bpb（越低越好） | val_avg_mse（越低越好，scaled space） |
| 评估维度 | 单一语言建模指标 | 多 horizon（96/192/336/720）均值 |
| 模型类型 | GPT-style decoder | 任意架构（Linear/Attn/TCN/SSM 等） |
| 额外约束 | VRAM 软约束 | 参数量软约束 + VRAM 软约束 |
| channel 设计 | 不适用 | CI vs CD 是核心自由度 |
| loss 设计 | 固定 cross-entropy | Phase 0 可在单文件内自由组合；Phase 2+ 受 loss grammar 约束 |
| early stopping | 无（固定 time budget） | time budget + val early stopping 双重控制 |
| 参照 baseline | nanochat GPT | TSL NLinear（可与论文数字对齐验证） |

### 17.2 与 Time-Series-Library 的对接说明

neo-research TSF 的 `prepare_tsf.py` 在数据层**直接采用 TSL 的实现逻辑**，确保：

- **切分边界完全一致：** ETTh1 的 train/val/test 边界与 `Dataset_ETT_hour` 中的 `border1s` / `border2s` 硬编码值完全相同，具备与 TSL 发布结果做**参考对齐**的前提。
- **StandardScaler 行为一致：** fit on train only，并在 Agent 可见的 `train/val` 与 Runner 私有的 `reference test` 上复用同一组 train 统计量；评估在 scaled space（不 inverse transform），与 TSL 的 `exp_long_term_forecasting.py` 默认行为（`args.inverse=False`）一致。
- **数据获取兼容：** 默认由 Human/Runner 预置本地 CSV（`~/.cache/neo_research_tsf/dataset/ETT-small/ETTh1.csv`）；如需自动下载，应在 Agent 容器外的 prestage/setup 步骤完成，而不是由 Phase 0 Agent 在实验环内联网获取。

**与 TSL 的简化差异（有意为之）：**
- 去掉 `label_len`（decoder teacher forcing 输入），让 agent 写更简洁的 encoder-only 模型
- 去掉 `seq_x_mark` / `seq_y_mark`（时间戳特征）；若后续需要，应升级冻结接口，而不是要求 `train.py` 自行恢复
- 去掉 `args` 全局配置对象，改为顶层常量，agent 不能通过改 args 绕过固定设置

> **口径说明：** neo-research TSF 与 TSL 在数据切分和标准化上保持一致，但在 `INPUT_LEN=512`、多 horizon 同轮评估、time-budget 约束等实验协议上做了简化。因此这里的数字是**reference-comparable**，不是严格的 leaderboard apples-to-apples。若要做论文级严格对比，应在同一 window / horizon / budget 设置下重跑 TSL baseline。

---

## 18. 实施路线图与里程碑

### Milestone 0：基础底座（2～3 周）

**目标：** 最快验证"Agent 是否真能形成有效闭环"

交付：
- [x] 实现 `prepare_tsf.py`（ETTh1 / TSL 切分边界 / StandardScaler / make_dataloader / evaluate_val_tsf）
- [x] 实现 `train.py` baseline（NLinear CI + early stopping）
- [x] 实现 `program.md` 初版（setup + 实验循环协议）
- [ ] **Sanity check：** 人工或 Runner 查询一次 `ref_test_h96_mse`，确认没有明显偏离 TSL NLinear ETTh1 H=96 参考量级；严格对齐需另启 TSL-compatible baseline mode
- [x] 验证 agent 能读懂 program.md 并完成第一次自主实验（keep or discard 均可，验证闭环可运行）
- [x] TaskSpec / EvalSpec / BudgetSpec 数据结构定义完成
- [x] Phase 0b：CandidateRecipe v1 schema 定义完成，先覆盖 `none + linear + temporal + linear head` baseline
- [x] 能记录 baseline 结果、能产出初始 champion

### Milestone 1：Recipe 化受限研究闭环（3～4 周）

**目标：** 把候选从"模型族 + 参数"升级为"模块 action 组合"，开始具备可控的小模型结构自主设计能力

交付：
- [x] 引入 action registry：preprocessing / embedding / backbone / fusion / head / trainer（OpenCode domain registry + Neo-Cast Python action specs）
- [x] 实现 `build_model(candidate_recipe)`，由 recipe 组装 PyTorch 模型（`neo_cast/py/factory/build_model.py`）
- [x] 支持 CandidateRecipe DSL 配置变更（L1/L2 代码变更模式）
- [x] Proposal Engine v1 + recipe config search
- [x] Static Validator 实现
- [x] Dataset profiler v1：变量数、horizon/context、trend、seasonality、shift、cross-var correlation
- [x] Rule-based recipe prior v1，用 TaskFingerprint 对候选排序
- [x] Low-fidelity + Full train 流水线
- [x] 支持多数据集切换（Neo-Cast `prepare_tsf.py --dataset-preset` 已接入 `ettm1` 固定 TSL minute split，以及 `weather` / `traffic` 的 TSL Custom 70/10/20 split；仍保留显式 row range 的自定义任务入口）
- [x] 完善实验记录（自动生成谱系树；report export 已写入 Candidate Lineage root/edge 与 metadata）
- [x] 能自动生成候选、能自动筛选并晋级、能输出 challenger/champion 对比报告（当前为 heuristic/frontier + memory/ranker + report export）

### Milestone 2：TimeRecipe 风格模块组合搜索（4～6 周）

**目标：** 扩大 Neo-Cast 自主探索空间，使系统能在模块级组合上搜索，而不是只在少数完整模型之间切换

交付：
- [x] Registry Composition Search（L2）
- [x] ModelSpec / PatchBundle / Lineage 完整化（Neo-Cast export artifact 已落盘 `model_spec.json` 与 `patch_bundle.json`；OpenCode report 已写入 Candidate Lineage root/edge 与 metadata）
- [x] preprocessing 接入 `instance_norm`, `series_decomposition`, `seasonal_differencing`, `missing_mask`, `sample_reweighting`
- [x] embedding 接入 `none`, `patch`, `multiscale_patch`, `invert`, `frequency`, `calendar`
- [x] backbone 接入 `linear`, `mlp`, `rnn`, `dlinear`, `tcn`, `nbeats`, `timesnet`, `ssm`, `mixer`, `transformer`
- [x] fusion 接入 `temporal`, `feature`, `temporal_then_feature`, `feature_then_temporal`, `graph`, `gated_hybrid`
- [x] prediction head 接入 `linear`, `direct_multi_horizon`, `quantile`, `gaussian`, `residual_correction`
- [x] Loss grammar DSL（BaseLoss + HorizonLoss + Regularization + Calibration）
- [x] 支持 horizon weighting 策略
- [x] 加入 distillation objective（当前实现为可执行 teacher-policy distillation：`last_value` / `moving_average` teacher 与 supervised loss 加权混合；foundation-model teacher 接入仍可作为后续 teacher provider 扩展）
- [x] 能在 action registry 层面进行小模型结构创新、能形成 recipe 谱系树（当前谱系基于 parentCandidateID + report lineage，并在 artifact 中补充 PatchBundle / ModelSpec）

### Milestone 3：多 seed + Champion/Challenger + 研究记忆（4 周）

**目标：** 从"单次试验系统"升级为"可统计显著性验证的研究系统"

交付：
- [x] 支持多 seed 结果汇总与自动 seed sweep（同一 candidate 多 run 的 mean/std/ci95/best/worst；`seed-sweep` 按 task evaluation seeds 执行并记录 `resourceUsage.seed`）
- [x] 实现 Pareto Front 维护（export artifact + Dashboard/Cockpit metadata 摘要）
- [x] 实现 Shadow Holdout 审批 gate（`governance.requireShadowHoldout` / `requireBlindHoldout` 开启后，`ref_test` 前必须先批准 `shadow_holdout`）
- [x] 实现基础 reference/shadow/blind 查询限流 gate（`governance.refTestQueryLimit` / `referenceTestQueryLimit` / `blindTestQueryLimit`，超过后生成 budget approval）
- [x] 实现 Utility 评分（综合精度/参数量/延迟/多 seed 方差/代码复杂度；当前用于 report 排序与审计，不直接覆盖 champion 晋级）
- [x] Memory Service v1 + 相似任务召回
- [x] 能基于历史经验做 CandidateRecipe 排序

### Milestone 4：多任务元记忆（3～4 周）

**目标：** 从"自动试验机"升级为"会积累经验的研究系统"

交付：
- [x] 实现 task fingerprint 自动提取
- [x] 实现相似任务检索
- [x] 实现跨任务经验迁移
- [x] 实现跨任务 heuristics 库
- [x] 积累 benchmark 记录，训练 lightweight rank predictor 作为 training-free recipe recommender（当前为无新依赖 feature-weight learner；LightGBM 可后续替换）

### Milestone 5：治理与盲测（3～4 周）

**目标：** 研究过程正式受控，具备科研级可信度

交付：
- [ ] 实现外部 blind test 服务（私有标签隔离、独立 sidecar、正式 query 限流与审计；当前已完成 OpenCode `blind_test` stage、审批 gate、query-limit gate、CLI/Web/TUI 操作入口、API stage 表达、Neo-Cast runner HTTP sidecar contract 与 `py/blind_test_sidecar.py` 可部署服务模板；尚未接入真实私有 blind 数据与长期运行部署）
- [x] 实现基础研究审计日志 + 审批流（candidate / ref_test / shadow_holdout / budget / protocol / domain_action）
- [x] 支持概率预测任务类型（OpenCode `TSFTaskSpec.forecastMode=probabilistic` 可选 `val_avg_pinball` / `val_avg_crps_approx`；Neo-Cast runner 对 quantile head 产出 pinball、CRPS 近似、central interval coverage/width，并在 export report 中展示）
- [x] 完整研究报告自动生成（task/candidate/run/champion/memory + multi-seed/Pareto/Utility analysis）

### Milestone 6（P2 扩展）

- [ ] Template patch（L3 代码变更模式）
- [x] Distillation 模式完整支持（recipe schema / action registry / OpenCode runner payload / Neo-Cast train loss 已支持 `loss.base=distillation`、`supervised_weight`、`teacher_weight`、teacher policy）
- [ ] 多任务迁移

### 推荐研发分工

| 方向 | 负责模块 |
|------|---------|
| **算法方向** | action registry、baseline recipes、loss registry、promotion rules、error analysis |
| **平台方向** | experiment runner、sandbox、scheduler、artifact store、metrics db |
| **Agent 方向** | recipe proposal、patch generation、memory retrieval、analysis summarization |
| **治理方向** | permissions、blind test、audit、approval workflow |

### 推荐 MVP 技术路线

第一步：先做一个**单任务、`train.py` 单文件、可 keep/discard** 的 Phase 0a 闭环。
第二步：冻结 **CandidateRecipe v1 + baseline recipe**，把 Phase 0a 的有效实验回填成 recipe 记录。
第三步：把模型结构搜索升级为 **action registry composition**，优先覆盖 TimeRecipe 的 preprocessing / embedding / backbone / fusion / head。
第四步：再引入 loss 搜索、dataset profiler、recipe prior 和记忆迁移。

这样可以最大程度避免项目一开始就陷入"Agent 很聪明，但系统完全不可控"的问题。

---

## 19. 成功指标

### 19.1 研究效果

- 相对 baseline 的平均 val_avg_mse 提升幅度
- 在多少数据集上形成 Pareto 改进
- top-1 / top-3 CandidateRecipe 命中率（候选是否真的 keep）

### 19.2 研究效率

- 每次有效改进所需实验轮次数
- 每次有效改进所需 GPU 小时
- 候选到晋级的转化率（低保真筛选的召回率）

### 19.3 工程可靠性

- 实验复现通过率
- 训练失败率（crash + OOM 占比）
- patch 回滚率
- blind test 泄漏事件数

### 19.4 知识积累

- 可复用 heuristic 数量（如"强季节性数据 patch 有效"）
- 相似任务迁移成功率
- 失败模式覆盖率（已知陷阱是否被记忆系统捕获）

---

## 20. 设计哲学总结

neo-research TSF 的技术本质不是"做一个会写时序代码的大模型"，而是：

**在严格协议下，构建一个可持续迭代的小模型自动研究执行系统。**

它的核心竞争力来自四件事：

1. **受控搜索空间** — `train.py` 里可以改架构、改 loss、改优化器，但仍属于"一个文件内的局部搜索"。阶段性地引入 DSL/注册表，再逐步开放 patch 级创新，是从稳到强的最可行路径。

2. **可复现实验闭环** — `val_avg_mse`（val 集 scaled space 多 horizon 均值）是唯一的 keep/discard 依据。多 horizon 平均避免了 agent 专门优化短期、牺牲长期（或反之）。失败可逆：discard 时实验分支的 `HEAD` 要真实回到 `last_keep_commit`，crash 了就记录跳过。

3. **多目标 champion 机制** — 系统天然朝"小而稳"方向演化。精度不是唯一目标：`accuracy + params + latency + robustness + reproducibility`。评价成本足够低：10 分钟一次实验，一晚上可以跑 ~50 个实验。这是整个系统的经济基础。

4. **跨任务研究记忆** — 每一次失败、每一次成功，都沉淀为下一轮的先验知识。经验积累足够后，系统会对"在什么样的时序任务上，什么样的结构/目标更有效"形成超过单一算法工程师的洞察。这是与普通 AutoML 最大的区别。

**人类的角色不是被拿掉，而是从"写模型代码的人"变成"定义研究规则和约束的人"。** 人类最有价值的贡献是：设计 `prepare_tsf.py`（固定什么）、设计 `program.md`（agent 怎么研究）、偶尔重写 `train.py` 的 baseline（重置搜索起点）、审批 champion 晋级（把关研究边界）。
