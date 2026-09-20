# TrainEval 与 Reflection 间超参数 Checker 修改方案

## 1. 目标

在 `TrainEvalAgent` 与 `ReflectionAgent` 之间增加一个受控的超参数检查与校准阶段，用于识别“模型结构合理，但训练超参数不合适”的情况，避免系统过早把训练问题归因于 backbone、embedding 或 fusion。

该阶段暂命名为 `HyperparameterChecker`。第一阶段不把它注册为新的自主 Agent，也不创建独立 Session agent，而是作为 Research Service/NAS 流程中的确定性内部阶段：

```text
TrainEvalAgent
  -> HyperparameterChecker
       -> keep: 直接进入 ReflectionAgent
       -> retune: 创建 tuned child candidate
                   -> TrainEvalAgent 最多重跑一次
                   -> HyperparameterChecker 对比前后结果
                   -> ReflectionAgent
       -> reject_invalid: 记录诊断后进入 ReflectionAgent
```

主要目标：

1. 根据训练曲线、验证指标、CV 稳定性、资源消耗和异常状态诊断训练问题。
2. 只修改白名单内的训练超参数，第一阶段不更换 backbone、embedding、fusion 或 prediction head。
3. 每个候选最多自动 retune 一次，严格受 task budget 和 wall-clock budget 约束。
4. 调整必须创建新的 child candidate 和 run，保留原始实验，保证结果可归因和可复现。
5. Checker 结果作为结构化 artifact 和 ReflectionAgent 输入，而不是覆盖 ReflectionAgent 的研究决策职责。
6. Checker 只能读取 train/validation/CV 信号，完全隔离 `ref_test` 和 `blind_test`。

## 2. 为什么需要该阶段

当前流程已经具备训练、验证、mutation 和 Reflection，但超参数调整分散在多个位置：

- Neo-Cast mutation 可以调整部分学习率、优化器、loss、MLP 容量和 Transformer 容量。
- ReflectionAgent 能根据训练曲线提出下一步方向。
- NAS 可以创建新 candidate，但结构变化和训练参数变化可能同时发生。

这会导致以下问题：

1. 某个 backbone 可能只因学习率过高、训练轮数不足或正则过强而被淘汰。
2. 不同 backbone 使用同一默认训练策略时，候选比较不一定公平。
3. ReflectionAgent 同时承担故障诊断、超参数调整和结构研究，输出不容易形成稳定的自动执行契约。
4. mutation 可能同时改变结构与训练参数，难以判断指标提升来自哪里。
5. 已经存在训练曲线和资源证据，但尚未形成统一、可审计的诊断结果。

新增 Checker 的核心价值是将两类决策分开：

```text
HyperparameterChecker：这个结构是否因为训练设置不当而没有被公平评估？
ReflectionAgent：根据完整实验结果，下一轮研究方向和结构应该如何变化？
```

## 3. 职责边界

### 3.1 Checker 负责

- 检查训练 run 是否有效、稳定且达到基本收敛条件。
- 识别欠拟合、过拟合、震荡、NaN、过早停止、预算不足和多 seed 不稳定。
- 检查参数之间的静态兼容性，例如 warmup 与 max epochs、batch size 与资源限制。
- 生成白名单内、单变量优先的超参数 patch。
- 判断 patch 是否值得消耗一次额外训练预算。
- 对原 run 和 tuned run 做配对比较。
- 将诊断、patch、证据和比较结果持久化。

### 3.2 Checker 不负责

- 不更换 backbone、embedding、fusion、prediction head 或 preprocessing。
- 不根据 `ref_test` 或 `blind_test` 调参。
- 不直接替换 champion。
- 不自行恢复 NAS 搜索或增加 task budget。
- 不覆盖原 candidate 或原 run。
- 不通过自由文本直接修改任意 recipe 字段。
- 不无限循环调参。

### 3.3 ReflectionAgent 继续负责

- 解释训练、验证、Checker 和多轮搜索结果。
- 决定是否改变模型结构或研究假设。
- 决定是否保留 Checker 的经验到 memory。
- 对失败、无效尝试和下一步研究方向做综合总结。

## 4. 流程位置与状态机

### 4.1 推荐流程

```text
candidate prepared
  -> TrainEvalAgent(original candidate)
  -> HyperparameterChecker.check(original run)
       ├─ keep
       │    -> ReflectionAgent
       ├─ reject_invalid
       │    -> 记录 invalid diagnosis
       │    -> ReflectionAgent
       └─ retune
            -> budget/gate 检查
            -> 创建 tuned child candidate
            -> TrainEvalAgent(tuned candidate)
            -> HyperparameterChecker.compare(original, tuned)
            -> ReflectionAgent
```

### 4.2 单候选状态机

```text
unchecked
  -> checked_keep
  -> checked_invalid
  -> tuning_requested

tuning_requested
  -> tuning_skipped_budget
  -> tuned_once

tuned_once
  -> tuned_improved
  -> tuned_neutral
  -> tuned_regressed
  -> tuned_failed
```

`tuned_once` 是终态边界。无论 tuned run 结果如何，Checker 都不能再次自动创建第三个 candidate。

### 4.3 与 task status 的关系

MVP 不增加新的 task status。Checker 在现有 NAS/evaluation 生命周期内部运行：

- task 仍保持 `running` 或当前 NAS 阶段状态。
- Checker 失败不能静默吞掉；应记录失败 artifact，但默认不阻断 ReflectionAgent。
- 只有出现结果污染、数据泄漏或不可执行 recipe 等完整性问题时，才将 run 标记为 rejected/failed。

## 5. 输入契约

新增受控输入 `HyperparameterCheckInput`：

```ts
type HyperparameterCheckInput = {
  schemaVersion: "neo_research_hparam_check_input.v1"
  taskID: ResearchTaskID
  candidate: ResearchCandidate
  run: ResearchRun
  recipe: TSFCandidateRecipe
  taskSpec: TSFTaskSpec
  primaryMetric: {
    name: string
    direction: "minimize" | "maximize"
  }
  trainingCurve: Array<{
    epoch: number
    trainLoss?: number
    valLoss?: number
    learningRate?: number
    gradNorm?: number
    elapsedSec?: number
  }>
  validationMetrics: Record<string, number>
  cvMetrics: Record<string, number>
  seedSummary?: {
    seeds: number[]
    mean: number
    std?: number
    ci95HalfWidth?: number
  }
  resourceUsage: JsonRecord
  budgetRemaining: {
    runCount: number
    wallClockSec?: number
  }
  priorCheckerDecisions: HyperparameterCheckDecision[]
}
```

输入来源必须是 Research Service 已注册的数据：

- `ResearchRun.metrics`
- `ResearchRun.resourceUsage`
- `runner_progress_jsonl` 或等价训练曲线 artifact
- candidate recipe
- task evaluation/budget 配置
- 同 candidate 的 seed runs
- 已登记的 Checker artifact

明确禁止读取：

- `ref_test_*` 指标和 ref-test artifact
- blind-test 结果
- 未注册工作区文件
- 其他 task 的 run、candidate 或 memory
- provider key、token 和本地私有配置

构建输入时应主动删除所有 `ref_test_*`、`blind_test_*` 字段；如果输入中检测到这些字段，Checker 返回 `reject_invalid`，并记录隔离违规。

## 6. 输出契约

```ts
type HyperparameterCheckDecision = {
  schemaVersion: "neo_research_hparam_check_decision.v1"
  taskID: ResearchTaskID
  candidateID: ResearchCandidateID
  runID: ResearchRunID
  decision: "keep" | "retune" | "reject_invalid"
  diagnoses: Array<{
    code:
      | "healthy"
      | "underfit"
      | "overfit"
      | "unstable_loss"
      | "nan_or_inf"
      | "early_plateau"
      | "insufficient_epochs"
      | "seed_instability"
      | "resource_pressure"
      | "invalid_hyperparameters"
      | "forbidden_evidence"
    severity: "info" | "warning" | "error"
    evidence: JsonRecord
    message: string
  }>
  patch: Array<{
    op: "replace"
    path: HyperparameterPatchPath
    before: string | number | boolean
    after: string | number | boolean
    reason: string
  }>
  expectedEffect?: string
  confidence: number
  requiresRerun: boolean
  estimatedCost?: JsonRecord
  source: "deterministic" | "session" | "direct"
  createdAt: string
}
```

MVP 的 `source` 固定为 `deterministic`。保留枚举是为了后续可选的 Session 辅助诊断，但 LLM 输出也必须经过同一个白名单 validator。

## 7. Patch 白名单

### 7.1 MVP 允许字段

```text
trainingStrategy.optimizer.lr
trainingStrategy.optimizer.weightDecay
trainingStrategy.scheduler.type
trainingStrategy.scheduler.warmupSteps
trainingStrategy.regularization.dropout
trainingStrategy.regularization.gradClip
trainingStrategy.budget.maxEpochs
trainingStrategy.budget.batchSize
trainingStrategy.budget.patience
```

可选加入：

```text
trainingStrategy.loss.base
```

但只有在 task 的 prediction mode、prediction head 和 loss contract 兼容时才能修改。例如 probabilistic quantile head 不允许被 Checker 任意改回 MSE。

### 7.2 第二阶段可选容量字段

```text
backbone.hiddenDim
backbone.dModel
backbone.depth
backbone.nLayers
backbone.numLayers
backbone.nHeads
backbone.kernelSize
```

容量字段不建议进入 MVP。启用后必须额外满足：

- backbone type 不变。
- 每次最多调整一个容量维度。
- Transformer 保证 `dModel % nHeads === 0`。
- 不超过 recipe schema、task 参数量预算和 Checker 专用上下限。
- tuned candidate 必须标记 `mutationClass = "capacity_calibration"`，与结构创新区分。

### 7.3 永久禁止字段

```text
backbone.type
embedding.type
fusion.type
predictionHead.type
preprocessing
dataset / split / horizons
ref-test configuration
candidate identity fields
```

## 8. 确定性诊断规则

所有阈值应从 task policy 读取，并提供保守默认值。不要把启发式阈值散落在 service.ts。

```ts
type HyperparameterCheckerPolicy = {
  enabled: boolean
  maxRetunesPerCandidate: 1
  minEpochsForDiagnosis: number
  overfitRelativeGap: number
  plateauEpochs: number
  oscillationWindow: number
  oscillationCoefficient: number
  seedStdThreshold?: number
  maxLearningRateChangeFactor: number
  maxEpochMultiplier: number
  maxEstimatedExtraWallClockSec?: number
  allowLossChange: boolean
  allowCapacityChange: boolean
}
```

建议规则：

| 诊断 | 主要证据 | 优先 patch |
| --- | --- | --- |
| `nan_or_inf` | loss/metric 非有限值 | 降低 LR、启用/收紧 grad clip；run 标记无效 |
| `unstable_loss` | 滑动窗口方差或尖峰过高 | LR × 0.5、增加 warmup、降低 batch size |
| `overfit` | train 持续下降、val 明显恶化 | 增大 dropout/weight decay、减少 patience |
| `underfit` | train/val 都高且仍下降 | 增加 max epochs/patience；第二阶段才允许增加容量 |
| `early_plateau` | 多 epoch 无有效改进 | plateau/cosine scheduler、调整 LR |
| `insufficient_epochs` | 到 max epochs 时仍明显下降 | 在预算内增加 max epochs |
| `seed_instability` | 多 seed std/CI 超阈值 | 增强正则；不自动用单个幸运 seed 晋级 |
| `resource_pressure` | 时间、显存、参数量接近预算 | 降低 batch size；第二阶段才缩小容量 |
| `invalid_hyperparameters` | warmup≥epochs、非法组合 | 修复到 schema 合法值或 reject |

Patch 选择原则：

1. 单次最多生成 1–3 个相关 patch。
2. 优先修改最可能的根因变量。
3. 不同时增加模型容量和训练预算。
4. 不同时改变 loss、optimizer 和 scheduler，除非原配置不可执行。
5. 所有数值变化设置上下限，例如 LR 单次最多 ×2 或 ×0.5。
6. `confidence` 低于阈值时输出 `keep`，仅把诊断交给 ReflectionAgent。

## 9. Tuned Candidate 与谱系

Checker 不修改原 candidate，而是创建 child candidate：

```ts
createCandidate({
  taskID,
  parentCandidateID: originalCandidate.id,
  candidateSpec: applyValidatedPatch(originalCandidate.candidateSpec, decision.patch),
  rationale: "HyperparameterChecker retune after run <run_id>",
  metadata: {
    origin: "hyperparameter_checker",
    checkerDecisionArtifactID,
    tunedFromRunID: originalRun.id,
    retuneIndex: 1,
    changedPaths: decision.patch.map((item) => item.path),
  },
})
```

一致性要求：

- child candidate 的结构字段必须与 parent 完全相同。
- candidate fingerprint 必须包含 training strategy，避免 tuned candidate 被错误去重。
- original/tuned run 使用同一数据切分与评估协议。
- 配对比较优先使用同 seed；多 seed 模式保持相同 seed 集合。
- champion 选择仍走现有 Evaluation/Verifier 路径，Checker 不直接晋级 candidate。

## 10. 预算与自动重跑门控

自动 retune 必须同时满足：

```text
checker.enabled = true
decision = retune
confidence >= configured threshold
candidate 尚未 retune
patch 非空且通过 schema/registry 验证
剩余 run budget >= 1（多 seed 时为所需 seed 数）
预计额外 wall-clock 未超过剩余预算
没有 pending human checkpoint 阻止执行
当前 stage 不是 ref_test/blind_test
```

如果不满足，Checker 不报错，而是输出：

```json
{
  "decision": "keep",
  "diagnoses": [{ "code": "resource_pressure", "severity": "warning" }],
  "requiresRerun": false
}
```

并在 metadata 中记录 `retuneSkippedReason`。

为了避免调参消耗主体搜索预算，建议增加独立预算项：

```ts
taskSpec.search.hyperparameterChecker = {
  enabled: false,
  maxRetunesPerCandidate: 1,
  maxRetuneRuns: 2,
  maxRetuneWallClockSec: 1200,
  autoExecute: true,
}
```

默认 `enabled: false` 可以保持现有任务的行为兼容；在验证稳定后再考虑默认开启。

## 11. ReflectionAgent 接入

ReflectionAgent 输入增加最近一次 Checker 摘要：

```ts
type HyperparameterCheckerContext = {
  originalRunID: string
  tunedRunID?: string
  diagnosisCodes: string[]
  patch: HyperparameterPatch[]
  comparison?: {
    primaryMetricBefore: number
    primaryMetricAfter: number
    relativeChange: number
    resourceChange?: JsonRecord
    outcome: "improved" | "neutral" | "regressed" | "failed"
  }
}
```

Reflection prompt 明确：

1. Checker 结果是训练公平性和超参数校准证据，不是新的结构假设。
2. 如果 tuned run 提升，应区分“结构有效”和“训练设置修复”的贡献。
3. 如果 tuned run 无提升，不应重复相同 patch。
4. 不允许从 Checker 上下文推断或使用 ref-test。
5. 下一轮若改变结构，应说明 Checker 是否已经排除了训练配置问题。

Reflection artifact、memory 和 failure log 中应记录 original/tuned 配对关系。

## 12. Artifact 与事件

新增 artifact kind：

```text
hyperparameter_check_input_json
hyperparameter_check_decision_json
hyperparameter_patch_json
hyperparameter_tuning_comparison_json
```

建议路径：

```text
.neo-research/sessions/<task_id>/hyperparameter-checks/<original_run_id>/
├── check_input.json
├── decision.json
├── patch.json
└── comparison.json
```

MVP 不新增独立 Agent 生命周期事件。可增加通用内部阶段事件，或者扩展 TrainEval/NAS 事件 metadata：

```text
phase=hyperparameter_check
phase=hyperparameter_retune
phase=hyperparameter_compare
```

如果后续 UI 需要完整进度，再新增：

```text
HyperparameterCheckStarted
HyperparameterCheckCompleted
HyperparameterCheckFailed
```

但这些事件不代表新的 LLM Agent，也不新增 `research-hyperparameter-checker` Session agent。

## 13. 幂等与恢复

Checker 输入摘要：

```text
task_id
+ candidate_id
+ run_id
+ run_metrics_digest
+ training_curve_digest
+ checker_policy_digest
+ checker_version
```

规则：

- 摘要相同且已有 decision artifact 时直接复用。
- 已存在 `retuneIndex=1` 的 child candidate 时不得再次创建。
- child candidate 已创建但 run 未执行时，恢复执行现有 child，不创建重复 candidate。
- tuned run 已完成但 comparison 缺失时，只补 comparison。
- policy 或原 run 结果变化时生成新 decision，但仍受单次 retune 上限约束。

## 14. 安全与评估隔离

必须满足：

1. Checker 只在 `smoke/full/evaluate` 等可见训练与验证阶段工作。
2. `ref_test` run 完成后不再触发 Checker。
3. Checker 输入构造函数拒绝任何 `ref_test_*` 和 `blind_test_*` 字段。
4. tuned candidate 使用与 parent 相同的数据 contract、split digest 和 evaluator contract。
5. Checker 不读取逐样本预测或私有标签。
6. 自动 patch 只通过白名单 setter 应用，禁止 JSON Pointer 任意写入。
7. patch 后必须重新通过 TSF candidate schema、recipe registry 和资源预算校验。

## 15. 预计代码改动

### 15.1 OpenCode Research Service

新增：

```text
opencode/packages/opencode/src/research/hyperparameter-checker.ts
opencode/packages/opencode/src/research/hyperparameter-policy.ts
```

职责：

- `buildHyperparameterCheckInput()`
- `diagnoseTrainingRun()`
- `proposeHyperparameterPatch()`
- `validateHyperparameterPatch()`
- `applyHyperparameterPatch()`
- `compareTunedRun()`
- `checkerInputDigest()`

修改：

- `opencode/packages/opencode/src/research/service.ts`
  - 在 TrainEval/NAS 完成 run 后、Reflection 前调用 Checker。
  - 创建 tuned child candidate 和 retune run。
  - 实现幂等恢复和预算门控。
  - 将 Checker context 注入 ReflectionAgent。
- `opencode/packages/opencode/src/research/schema.ts`
  - 增加 Checker policy、decision、patch 和 comparison schema。
  - 不新增 Agent 枚举。
- `opencode/packages/opencode/src/research/domains/tsf.ts`
  - 提供 TSF 训练策略白名单 patch、兼容性验证和成本估计。
- `opencode/packages/opencode/src/research/agents/reflection-agent.ts`
  - 增加 Checker context 和 paired-run 解释。
- CLI/Web/TUI
  - 展示诊断、patch、retune 状态和前后指标。

### 15.2 Neo-Cast

MVP 尽量不修改训练主流程，但需要确保训练曲线契约稳定：

- progress JSONL 提供 epoch、train loss、val loss、learning rate、耗时；grad norm 可选。
- run metadata 保存 early stopping 原因、best epoch、total epochs 和最终 scheduler 状态。
- recipe export 保存最终有效 training strategy。
- runner 能接受 tuned candidate 的相同执行协议。

如果现有 artifact 已满足上述字段，则 Neo-Cast 第一阶段只补契约测试。

## 16. 测试方案

### 16.1 纯函数测试

1. 健康训练曲线返回 `keep`。
2. NaN/Inf 返回 `reject_invalid` 或安全 retune patch。
3. 明显震荡产生降低 LR/grad clip patch。
4. 过拟合产生正则 patch。
5. 未收敛且预算允许时增加 epoch/patience。
6. 低 confidence 不自动 retune。
7. patch 不能修改 backbone type 等禁止字段。
8. patch 后 recipe 仍通过 schema 和 registry。
9. 输入含 `ref_test_*` 时拒绝执行。
10. 相同输入产生相同 decision 和 digest。

### 16.2 Service 流程测试

1. TrainEval 后按顺序调用 Checker，再调用 ReflectionAgent。
2. `keep` 不创建新 candidate/run。
3. `retune` 创建 parent 指向原 candidate 的 child candidate。
4. tuned child 只改变白名单字段。
5. 每个 candidate 最多 retune 一次。
6. run budget 不足时跳过重跑并记录原因。
7. tuned run 使用与原 run 相同的 split、seed 和 evaluation protocol。
8. original/tuned comparison 被传入 ReflectionAgent。
9. Checker 失败时 ReflectionAgent 仍能继续，并看到失败状态。
10. pipeline 恢复时不重复创建 child candidate。
11. ref-test 完成后不会触发 Checker。
12. Checker 不产生新的 Agent/Session 身份。

### 16.3 回归测试

- Checker 默认关闭时，现有 pipeline 行为和 candidate 数量不变。
- champion 选择规则不被 Checker 直接绕过。
- multi-seed 汇总仍以完整 seed coverage 为准。
- final report 能展示 Checker 诊断和 tuned pair，但不把 ref-test 作为调参依据。

## 17. 分阶段实施

### Phase 1：确定性诊断，只报告不重跑

- 建立 input/decision schema。
- 从 run 和 training curve 提取诊断。
- 输出 `hyperparameter_check_decision_json`。
- 将摘要传给 ReflectionAgent。
- 默认不自动应用 patch。

验收：系统能够稳定区分健康、欠拟合、过拟合、震荡和无效 run，且不改变现有实验数量。

### Phase 2：受控单次 retune

- 实现 patch 白名单和 validator。
- 创建 tuned child candidate。
- 增加 budget gate、单次重跑和 paired comparison。
- 实现幂等恢复。

验收：满足条件的 candidate 最多产生一个 tuned child，前后差异可完整追踪。

### Phase 3：策略优化与界面

- 用历史实验校准诊断阈值。
- Web/TUI 展示诊断和 paired comparison。
- 增加按 backbone/profile 的训练策略先验。
- 评估是否需要 Session 辅助解释。

### Phase 4：可选容量校准

- 在严格边界内开放 hidden dimension/depth 等容量字段。
- 增加参数量和 wall-clock 成本预测。
- 区分 capacity calibration 与 architecture mutation。

## 18. MVP 范围

建议首个可交付版本只包含：

1. Checker 是确定性内部阶段，不新增 Agent 类型。
2. 只读取 train/val/CV、训练曲线和资源信息。
3. 支持 `keep | retune | reject_invalid`。
4. patch 仅覆盖 LR、weight decay、scheduler、dropout、grad clip、epochs、batch size、patience。
5. 每个 candidate 最多 retune 一次。
6. tuned candidate 保留 parent lineage 和精确 patch artifact。
7. 预算不足时不重跑，只将建议交给 ReflectionAgent。
8. Checker 默认关闭，通过 task policy 显式开启。
9. 不使用 LLM，不接入新 Session agent。
10. 不修改 ref-test、champion 和最终发布边界。

## 19. 验收标准

- TrainEval 与 Reflection 之间存在可观测的 Checker 内部阶段。
- 健康 run 不产生额外 candidate 或训练开销。
- 训练配置明显不合理时能生成结构化、证据可追溯的 patch。
- 自动 retune 严格限制为每个 candidate 一次，并受独立预算控制。
- tuned candidate 与 parent 的非白名单字段完全一致。
- original/tuned run 可以按相同协议公平比较。
- ReflectionAgent 能读取诊断、patch 和前后比较结果。
- Checker 不读取或使用 ref-test/blind-test 信息。
- Checker 不直接选择 champion，不替代 ReflectionAgent/NAS。
- 默认关闭时不改变现有任务行为。
- pipeline 中断恢复不会重复创建 tuned candidate 或重复消耗预算。

## 20. 结论

该 Checker 值得实现，但应定位为“训练公平性检查与有限超参数校准器”，而不是第二个 ReflectionAgent 或新的开放式搜索 Agent。

推荐从确定性诊断开始，再增加受预算约束的单次 retune。这样能够减少因训练配置不当导致的错误淘汰，同时保持实验归因、搜索预算、评估隔离和系统复杂度可控。
