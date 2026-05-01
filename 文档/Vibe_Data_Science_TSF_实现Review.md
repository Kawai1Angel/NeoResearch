# NeoResearch 对 Vibe Data Science(TSF) 目标的实现 Review

日期：2026-05-01

## 结论

当前 NeoResearch 已经实现了 **Time Series Forecasting 领域的本地 internal alpha 闭环**，不是概念 demo。它已经能把用户目标落到 TSF research task，做数据画像，生成候选小模型，规划 runner 执行，调用 Neo-Cast 训练/验证，回写 metrics、artifact、champion、memory，并导出研究报告。

但它还没有完整达到你描述的 **Vibe Data Science 产品化体验**。现在更准确的定位是：

> 已具备 TSF Vibe Data Science 的核心执行骨架，能本地跑通小模型研究闭环；但距离“一句话需求输入后自动完成数据分析、假设、实验迭代、收敛判断、统一产物交付”的产品形态仍有关键缺口。

完成度判断：

| 目标层级 | 当前状态 | 估计完成度 |
| --- | --- | ---: |
| TSF 本地研究闭环 | 已基本完成 | 75%-85% |
| Vibe Data Science 产品体验 | 部分完成 | 55%-65% |
| 可生产化 Research OS | 雏形完成 | 35%-45% |

## 需求链路逐项核对

| 你的目标 | 当前实现 | 判断 |
| --- | --- | --- |
| 用户提出需求 | TUI Cockpit、CLI、HTTP API 都能创建 `research task`；支持 CSV task、autonomous task、full-recipe task。 | 基本完成 |
| data 自动定性与定量分析 | TSF domain 会从 `dataset.path` 读取 CSV，计算 row count、target count、missing rate、trend、seasonality、cross-var correlation、distribution shift；`profileTask` 会持久化 profile artifact。Neo-Cast 也能 materialize visible/ref-test split 和 dataset profile。 | 部分完成 |
| 自主假设 | candidate 内有 `hypothesis` / `rationale`；LLM proposal prompt 和 domain proposal 都会生成候选假设；memory 会记录 accepted/rejected/failed lesson。 | 基本完成 |
| 规划小模型设计 | TSF `DomainRegistry`、TimeRecipe schema、action registry、ranker、LLM proposal、baseline/mutation/frontier 都已存在。 | 基本完成 |
| 按资源训练小模型 | task budget 有 `maxRuns/maxParallel`；candidate training strategy 有 `maxEpochs/timeBudgetS/batchSize/patience/seed`；Neo-Cast train 会按时间预算和 early stopping 训练。 | 基本完成 |
| 自主行动迭代一步模型设计 | `runAutonomousIteration` 会诊断、选择/生成 candidate、执行 runner、分析 metrics、写 memory、更新 champion。 | 基本完成 |
| 持续迭代直到不错的小模型 | `runAutonomousLoop` 支持多轮、budget stop、approval stop；Neo-Cast CLI loop 有 time budget/no-improve plateau。opencode 主 Research loop 目前缺少“质量达标/无提升 plateau/时间预算”统一停止策略。 | 部分完成 |
| 输出实验结果和实验报告 | `exportTaskArtifact` 会导出 Markdown research report；runner 会回写 execution log、metrics、runner artifact；Neo-Cast export 会生成 `eval_report.md`。 | 基本完成 |
| 输出小模型代码和训练参数 | Neo-Cast artifact 包含 `model.pt`、`model_impl.py`、`inference.py`、`metadata.json`、`model_spec.json`、`training_summary.json`、`preprocess.json`。 | 基本完成 |
| 统一交付最终产物 | report 和 Neo-Cast model artifact 当前是可关联的多个 artifact，不是一个一键打包的 final bundle。 | 未完成 |

## 代码证据

### Research OS 主体

- `opencode/packages/opencode/src/research/schema.ts`
  - 定义 task、candidate、run、artifact、memory、champion、approval。
- `opencode/packages/opencode/src/research/service.ts`
  - `profileTask`：生成 task fingerprint 和 profile artifact。
  - `seedBaselines`：生成 baseline candidates。
  - `prepareRun`：生成 runner plan artifact，并可入队 local runtime。
  - `executeRun`：执行 runner plan，解析 metrics/artifact，更新 run 状态。
  - `evaluateSucceededRun`：更新 champion，写入 memory。
  - `runAutonomousIteration`：执行一轮自主研究。
  - `runAutonomousLoop`：执行多轮自主循环。
  - `exportTaskArtifact`：导出 research report。
- `opencode/packages/opencode/src/research/runtime.ts`
  - 提供 local file queue、artifact store、metrics store、worker-once/worker-loop 的基础 runtime。
- `opencode/packages/opencode/src/server/routes/instance/research.ts`
  - 暴露 profile、baselines、prepare-run、execute-run、seed-sweep、autonomous iterate/loop、export、approval 等 HTTP API。
- `opencode/packages/opencode/src/cli/cmd/research.ts`
  - 提供 CLI 操作入口：create/status/prepare/run/iterate/loop/export/profile/artifacts/memory/approvals 等。
- `opencode/packages/opencode/src/cli/cmd/tui/routes/research-cockpit.tsx`
  - 提供 TUI Cockpit 工作区，覆盖创建 task、profile、seed、loop、candidate action、export、runner root 修复等交互。

### TSF domain

- `opencode/packages/opencode/src/research/domains/tsf.ts`
  - 定义 TSF task spec、TimeRecipe candidate spec、action registry。
  - `summarizeTSFTask` 会做数据画像并形成 search biases。
  - `rankTSFCandidateProposals` 会基于 profile、run history、memory、benchmark memory 排序候选。
  - `proposeTSFCandidate` 会生成 mutation/frontier proposal。
  - `createTSFRunPlan` 会把 candidate 转成 Neo-Cast runner payload。
- `opencode/packages/opencode/src/research/llm-proposal.ts`
  - LLM proposal prompt 已覆盖完整 TSF action space，包括 rnn/ssm/mixer、graph/gated_hybrid、quantile/gaussian 等。

### Neo-Cast runner

- `neo_cast/py/prepare_tsf.py`
  - 负责 dataset spec、visible/ref-test split、scaler、profile、dataloader、ref/blind test query。
- `neo_cast/py/renderer.py`
  - 把 recipe/candidate 渲染成 resolved candidate。
- `neo_cast/py/factory/build_model.py`
  - 支持 linear/mlp/transformer/dlinear/tcn/nbeats/timesnet/rnn/ssm/mixer 等 backbone，以及高级 fusion 和概率 head。
- `neo_cast/py/train.py`
  - 实际训练小模型，支持 time budget、early stopping、quantile loss、scheduler、训练摘要和 checkpoint。
- `neo_cast/py/runner.py`
  - 编排 smoke/full/ref_test/blind_test，维护 results、best run、runner state。
- `neo_cast/py/export.py`
  - 输出模型 artifact bundle：`model.pt`、`model_impl.py`、`inference.py`、`metadata.json`、`model_spec.json`、`eval_report.md` 等。

## 已经满足的核心能力

### 1. 从需求到 task

NeoResearch 现在可以通过 TUI、CLI、API 创建 TSF research task。TUI 的 home/cockpit 能从自然语言 goal 或 CSV 输入生成 autonomous task，并绑定 `taskSpec.runtime.neoCastProjectRoot`。

这一层已经足够支撑“用户提出需求”的最小产品路径。

### 2. 数据画像驱动设计

TSF domain 已经不是盲目选模型。它会读取 CSV 并提取：

- 行数；
- target 数；
- 缺失率；
- trend strength；
- seasonality strength；
- cross-variable correlation；
- distribution shift。

这些会转成 `searchBiases`，再影响 candidate ranking 和 native frontier proposal。

不足是：当前 profile 仍偏轻量启发式，没有 ACF/PACF、STL、stationarity test、outlier profile、leakage check、可视化图表，也没有生成面向用户的自然语言数据诊断报告。

### 3. 假设与小模型搜索空间

候选模型已经以 TimeRecipe 形式表达，而不是简单 `model_family` 枚举。当前已支持：

- preprocessing；
- embedding；
- backbone；
- fusion；
- prediction head；
- training strategy；
- probabilistic head/loss；
- phase2/native action。

候选里有 `hypothesis` 和 `rationale`，ranker/LLM/mutation 都能生成或保留假设。

### 4. 训练、评估、记忆和 champion

执行路径已经成立：

```text
candidate
  -> DomainRegistry.createRunPlan
  -> runner_plan_json
  -> Neo-Cast subprocess
  -> JSONL metrics/artifact events
  -> ResearchRun metrics
  -> runner_artifact
  -> champion update
  -> memory write
```

这说明“按资源训练小模型、看指标、自主记录经验”的基础已经完成。

### 5. 报告和模型产物

报告侧：

- `exportTaskArtifact` 会产出 research report markdown；
- report 汇总 task、candidate、run、approval、artifact、memory、champion；
- 包含 lineage、experiment analysis、utility ranking、Pareto frontier 等信息。

模型侧：

- Neo-Cast run artifact 已包含训练权重 `model.pt`；
- 包含模型代码 `model_impl.py`；
- 包含推理代码 `inference.py`；
- 包含元数据、模型规格、预处理规格和 eval report。

因此“产出实验报告、小模型代码、训练好的参数”在底层已经具备。

## 关键缺口

### P0：缺少“一键 Vibe Data Science pipeline”

当前能力是分散的：

```text
create task -> profile -> seed -> iterate/loop -> export
```

TUI 已经有推荐动作，但系统还没有一个明确的顶层 pipeline 命令，例如：

```bash
neo-research vibe tsf \
  --goal "Forecast ETTh1 horizon=24" \
  --csv /path/to/ETTh1.csv \
  --target OT \
  --budget-runs 12 \
  --time-budget 2h \
  --output ./vibe-result
```

理想行为应该是自动完成：

1. dataset materialize/profile；
2. 创建 task；
3. seed baseline；
4. autonomous loop；
5. 选择 champion；
6. 导出 report；
7. 打包 model artifact；
8. 输出一个最终目录。

现在这些步骤都存在，但还没有被产品化为一个稳定顶层流程。

### P0：opencode 主 autonomous loop 缺少“不错的小模型”停止条件

`runAutonomousLoop` 当前停止原因主要是：

- `max_iterations`；
- `budget_exhausted`；
- `approval_required`。

它没有统一实现：

- primary metric 达标停止；
- 连续 N 轮无提升停止；
- wall-clock time budget 停止；
- 最小相对提升阈值；
- champion 稳定性判断；
- smoke -> full -> ref_test 的自动晋级策略。

Neo-Cast CLI loop 已经有 time budget 和 no-improve plateau，但 opencode Research service 的 loop 还没对齐。这会导致“迭代出一个不错的小模型”目前更像“跑固定轮数后选当前 champion”。

### P0：最终交付不是统一 bundle

底层 artifact 已经齐全，但最终交付还分散在：

- `.neo-research/artifacts/<task>/research-report.md`；
- `.neo-research/runner-executions/<task>/<run>.json`；
- Neo-Cast `.neo-cast/artifacts/run_<id>/model.pt`；
- Neo-Cast `.neo-cast/artifacts/run_<id>/model_impl.py`；
- Neo-Cast `.neo-cast/artifacts/run_<id>/inference.py`；
- Neo-Cast `.neo-cast/artifacts/run_<id>/metadata.json`。

需要新增 final bundle，例如：

```text
vibe-result/
  report.md
  experiment_trace.json
  champion/
    model.pt
    model_impl.py
    inference.py
    metadata.json
    model_spec.json
    preprocess.json
  runs/
    ...
```

否则用户虽然能找到产物，但还不是“交付一个完整研究结果包”。

### P1：数据分析还不够 Data Scientist

当前 profiler 更像 fast heuristic fingerprint。建议补齐：

- timestamp frequency 和 gap diagnosis；
- ACF/PACF；
- STL 或 seasonal decomposition；
- stationarity test；
- anomaly/outlier profile；
- target leakage check；
- train/val distribution drift；
- horizon difficulty estimate；
- covariate usefulness estimate；
- 自动生成数据分析 markdown；
- 关键图表 artifact。

这会显著提升“data 自动定性与定量分析”的可信度。

### P1：研究报告还缺少完整实验轨迹解释

当前 report 能汇总结果，但对“为什么下一步这样改模型”的 narrative 还不够强。

建议报告增加：

- 每轮 hypothesis；
- 数据画像如何影响候选；
- ranker 为什么选择该候选；
- 训练曲线和失败原因；
- champion 变化轨迹；
- 被拒绝/失败候选总结；
- 最终小模型使用说明。

### P1：自主设计仍偏 heuristic + LLM proposal，缺少真正 planner

代码里已有 `managerTrace` 的 Diagnostic/Design/Coder/Runner/Analyst/Librarian 角色记录，但这更多是 trace，而不是独立多智能体 planner。

目前自主性主要来自：

- baseline/frontier；
- profile-aware ranking；
- memory-aware ranking；
- LLM proposal；
- mutation fallback。

它还没有形成稳定的“研究计划 -> 子目标 -> 实验队列 -> 动态重规划”结构。

### P1：runner/data 准备与 task 创建没有完全打通

TSF task 可以带 `dataset.path`，opencode profiler 会读这个 CSV；Neo-Cast runner 则依赖 `.neo-cast/dataset/dataset_spec.json` 和 visible/ref-test split。

现在两边都支持数据，但还需要一个明确桥接：

- task 创建后自动调用 Neo-Cast `prepare_tsf.py --materialize-visible`；
- 将 taskSpec dataset settings 同步到 Neo-Cast dataset_spec；
- smoke/full/ref_test 保证使用同一份 prepared split；
- TUI 中展示 dataset preparation 状态。

否则用户可能创建了 task，但 runner 实际使用的是旧的 `.neo-cast/dataset_spec.json`。

### P2：production runtime 还不是目标形态

当前 runtime 是 local file runtime，适合本地 alpha；生产还需要：

- durable queue；
- object store；
- metrics database；
- worker supervisor；
- heartbeat dashboard；
- lease recovery；
- secret management；
- remote GPU runner；
- run cancellation。

## 验收状态判断

按“是否能演示 TSF Vibe Data Science 闭环”判断：**可以**。

按“是否已经完成你描述的最终产品体验”判断：**还没有**。

当前最接近的可演示路径是：

```text
TUI/CLI 创建 autonomous CSV task
  -> profile
  -> seed baselines
  -> autonomous loop
  -> champion + memory
  -> export report
  -> 打开 Neo-Cast runner artifact 查看 model.pt/model_impl.py/inference.py
```

但理想产品路径应该是：

```text
用户输入一句需求 + 数据
  -> 系统自动完成所有步骤
  -> 输出一个最终 result bundle
```

这条路径还需要补 P0 三项：

1. 一键 pipeline；
2. 质量/plateau/time-budget 停止策略；
3. final deliverable bundle。

## 建议下一步

### Step 1：实现顶层 `vibe tsf` pipeline

新增一个 service/CLI/TUI 共用 orchestration：

```text
create task
prepare dataset
profile task
seed baselines
run autonomous loop
export final bundle
```

不要只做 CLI wrapper，应复用 Research service 并产出结构化 pipeline artifact。

### Step 2：补齐 autonomous loop stop policy

给 `AutonomousLoopInput` 增加：

- `maxWallClockMs`；
- `maxNoImprove`；
- `targetMetric`；
- `minRelativeImprovement`；
- `promotionPolicy`。

并把 stop reason 扩展为：

- `quality_reached`；
- `no_improve_plateau`；
- `time_budget_exhausted`；
- `budget_exhausted`；
- `approval_required`；
- `max_iterations`。

### Step 3：实现 final bundle exporter

新增 artifact kind：

```text
vibe_final_bundle
```

内容应包括：

- research report；
- experiment trace；
- task profile；
- candidate ranking；
- champion metadata；
- model weights；
- model code；
- inference code；
- training summary；
- metrics；
- reproducibility manifest。

### Step 4：升级 profiler 和 report narrative

把 profile 从 fingerprint 升级为数据科学分析产物，把 report 从“结果汇总”升级为“研究过程解释”。

## 最终判断

NeoResearch 当前已经完成了 **Vibe Data Science for TSF 的工程骨架和本地可运行闭环**。如果目标是内部演示和继续研发，它已经足够成立。

如果目标是你描述的完整体验：用户一句需求 + 数据，系统自动完成数据科学分析、自主实验、模型训练和最终交付，那么还需要补齐：

1. 顶层一键 pipeline；
2. 更强的数据分析报告；
3. autonomous loop 的质量收敛策略；
4. 最终统一 bundle；
5. 更产品化的 TUI/Web 展示。

优先修完前三项后，NeoResearch 才能从“TSF internal alpha”进入“Vibe Data Science alpha”。
