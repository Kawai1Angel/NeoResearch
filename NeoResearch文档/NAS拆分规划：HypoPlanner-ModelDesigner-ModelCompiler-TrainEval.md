# NAS Loop 拆分规划：HypoPlanner / ModelDesigner / ModelCompiler / TrainEval

> 目标：将当前 `searching` 阶段的黑盒 NAS Loop 拆分为四个职责清晰的 Agent，使每个阶段有明确的输入输出契约、可独立测试、可被 TUI 观测。

---

## 1. 现状分析

### 当前 Pipeline Phases

```
intent_gathering → data_analysis → searching → reflection → publishing
```

`searching` 阶段对应 `runNASAgent` → `runAutonomousLoop` → `runAutonomousIteration`，每次迭代内部按顺序完成以下四件事，但没有边界隔离：

```
runAutonomousIteration:
  1. 构建 taskFingerprint + 读取 reflectionHypotheses   ← HypoPlanner 的职责
  2. seedBaselines / proposeLLMCandidate / DomainRegistry.proposeCandidate  ← ModelDesigner 的职责
  3. executeRun(stage: "smoke")                          ← ModelCompiler 的职责
  4. executeRun(stage: "low_fidelity" | "full")          ← TrainEval 的职责
  5. runVerifiers + 写 evaluation artifact               ← VerifierAgent（已独立，不动）
```

### 核心问题

- 四个职责共享同一个 `for` 循环，无法单独观测或跳过某一步
- `hypothesis` 只是 `candidateSpec` 里的一个字符串字段，没有结构化假设对象
- 没有独立的 smoke 编译验证阶段，模型直接进入 full 训练
- 假设生成完全依赖 LLM 凭空生成，没有来自 DataAnalysis 的结构化证据输入

---

## 2. 拆分后的 Pipeline

```
intent_gathering
  → data_analysis
  → hypo_planning          ← 新增阶段（每轮迭代开始前运行一次）
  → searching              ← 保留：每次迭代 = ModelDesigner + ModelCompiler + TrainEval
  → reflection
  → publishing
```

`searching` 阶段内部每次迭代拆分为三步：

```
iteration:
  ModelDesigner   → 生成候选 recipe（candidateSpec）
  ModelCompiler   → smoke 验证，通过才进入训练
  TrainEval       → low_fidelity / full 训练
  VerifierAgent   → 不变
```

`HypoPlanner` 作为前置阶段在 `data_analysis` 之后、搜索循环开始前运行**一次**，生成结构化实验计划，作为 ModelDesigner 在每轮迭代中的设计依据。

---

## 3. 新增 Agent 数据契约

### 3.1 HypoPlanner Agent

**文件：** `src/research/agents/hypo-planner-agent.ts`

```typescript
// 单个可验证假设
export interface HypothesisObject {
  readonly id: string                        // "H1", "H2", ...
  readonly statement: string                 // 一句话描述假设
  readonly motivation: readonly string[]     // 证据来源（来自 DataAnalysis 或文献）
  readonly suggestedBackbones: readonly string[]  // 建议优先探索的 backbone 类型
  readonly suggestedPreprocessing: readonly string[]
  readonly priority: "high" | "medium" | "low"
  readonly risk: string                      // 主要失败风险
  readonly testable: boolean                 // 是否可在当前 budget 内验证
}

// 实验计划：一组假设 + 搜索顺序 + 终止条件
export interface ExperimentPlan {
  readonly hypotheses: readonly HypothesisObject[]
  readonly baselineStrategy: string          // 哪个 recipe 作为 baseline
  readonly searchBiases: readonly string[]   // 传递给 ModelDesigner 的搜索偏置
  readonly stopConditions: {
    readonly maxTrials: number
    readonly noImprovementRounds: number
    readonly targetMetricValue?: number
  }
}

export interface HypoPlannerResult {
  readonly agent: "HypoPlannerAgent"
  readonly taskID: string
  readonly plan: ExperimentPlan
  readonly planMarkdown: string              // 可写入 artifact 的 md 文件
  readonly hypothesesYaml: string            // hypotheses.yaml 内容
  readonly evidenceSummary: string           // 来自 DataAnalysis 的证据摘要
}
```

**输入：** `task`, `dataAnalysisResult`, `runs`（历史），`memory`
**输出：** `HypoPlannerResult` + 写 artifact `hypo_plan.md`, `hypotheses.yaml`
**存储：** `plan` 序列化到 `taskSpec.metadata.hypothesisPlan`，供后续迭代读取

---

### 3.2 ModelDesigner Agent

**文件：** `src/research/agents/model-designer-agent.ts`

```typescript
export interface ModelDesignerResult {
  readonly agent: "ModelDesignerAgent"
  readonly taskID: string
  readonly candidateID: string
  readonly recipeID: string | undefined
  readonly hypothesis: string                // 本次对应的假设 ID 或描述
  readonly rationale: string                 // 设计理由
  readonly generatedBy: "llm" | "heuristic" | "domain"
  readonly llmStatus: "used" | "failed" | "disabled" | "invalid"
  readonly approvalStatus: string
  readonly selectionSource: "existing_frontier" | "domain_proposal"
}
```

**职责：** 从 HypoPlannerResult 中的 hypotheses 选取当前最优先的假设，生成对应的 `candidateSpec`（即现在的 `proposeLLMCandidate` + `DomainRegistry.proposeCandidate` 逻辑）。
**关键改动：** ModelDesigner 接收 `HypoPlannerResult.plan` 作为上下文，将 `hypotheses[0]` 的 `suggestedBackbones` 注入到 LLM system prompt 的 search biases 中。

---

### 3.3 ModelCompiler Agent

**文件：** `src/research/agents/model-compiler-agent.ts`

```typescript
export type ModelCompilerStatus = "passed" | "failed" | "timeout"

export interface ModelCompilerResult {
  readonly agent: "ModelCompilerAgent"
  readonly taskID: string
  readonly candidateID: string
  readonly runID: string                     // smoke run 的 ID
  readonly status: ModelCompilerStatus
  readonly smokeMetric?: number              // smoke 阶段的 val_avg_mse（如果有）
  readonly failureReason?: string
  readonly compileReportMarkdown: string
}
```

**职责：** 执行 `executeRun(stage: "smoke")`，验证模型可以运行、loss 不爆炸、输出 shape 正确。Smoke 通过才允许进入 TrainEval，否则标记 candidate 为 compile_failed 并跳过。
**关键改动：** 目前 smoke 只是一个 run stage，没有"编译结果"的概念。这里需要把 smoke run 结果语义化为 `passed/failed/timeout`。

---

### 3.4 TrainEval Agent

**文件：** `src/research/agents/train-eval-agent.ts`

```typescript
export interface TrainEvalResult {
  readonly agent: "TrainEvalAgent"
  readonly taskID: string
  readonly candidateID: string
  readonly runID: string
  readonly stage: "low_fidelity" | "full"
  readonly status: "succeeded" | "failed" | "rejected"
  readonly primaryMetric?: number
  readonly metrics: Record<string, unknown>
  readonly trainingLogSummary: string        // 训练过程摘要
  readonly verifierDecision: "accepted" | "rejected" | "skipped"
  readonly verifierRejectReason?: string
}
```

**职责：** 执行 `executeRun(stage: "low_fidelity" | "full")` + 触发 VerifierAgent。VerifierAgent 逻辑保持不变，TrainEval 负责把 `VerifierDecisionRecord` 的结论整合进自己的 result。

---

## 4. 修改文件清单

### 4.1 `src/research/schema.ts`

- 在 `PipelineWorkflowPhase` 中新增 `"hypo_planning"` 阶段

```typescript
// 改前
const PipelineWorkflowPhases = [
  "intent_gathering",
  "data_analysis",
  "searching",
  "reflection",
  "publishing",
] as const

// 改后
const PipelineWorkflowPhases = [
  "intent_gathering",
  "data_analysis",
  "hypo_planning",       // ← 新增
  "searching",
  "reflection",
  "publishing",
] as const
```

- 可选：新增 `HypothesisObject` schema（用于 DB 存储时类型安全）

---

### 4.2 `src/research/agents/hypo-planner-agent.ts`（新建）

**函数列表：**

```typescript
// 从 DataAnalysis 结果提取证据摘要
export function extractEvidenceSummary(dataAnalysis: DataAnalysisAgentResult): string

// 根据数据特征 + 历史 runs + memory 生成假设对象列表
export function generateHypotheses(input: {
  task: ResearchTask
  dataAnalysis: DataAnalysisAgentResult
  runs: ResearchRun[]
  memory: ResearchMemory[]
}): HypothesisObject[]

// 构建完整 ExperimentPlan
export function buildExperimentPlan(input: {
  hypotheses: HypothesisObject[]
  task: ResearchTask
}): ExperimentPlan

// 主入口：生成完整 HypoPlannerResult
export function buildHypoPlannerResult(input: {
  task: ResearchTask
  dataAnalysis: DataAnalysisAgentResult
  runs: ResearchRun[]
  memory: ResearchMemory[]
}): HypoPlannerResult

// 生成 hypotheses.yaml 文本
export function buildHypothesesYaml(plan: ExperimentPlan): string

// 生成 hypo_plan.md 文本
export function buildHypoPlanMarkdown(result: HypoPlannerResult): string
```

**初始实现策略：** 第一版不需要 LLM 调用，直接从 `taskFingerprint.searchBiases`（已有）+ DataAnalysis 的 `trend/seasonality/xcorr` 值 rule-based 生成 2-3 条假设。LLM 增强可在后续迭代中加入。

---

### 4.3 `src/research/agents/model-designer-agent.ts`（新建）

从 `runAutonomousIteration` 中提取候选生成逻辑：

```typescript
// 当前在 runAutonomousIteration 中的逻辑段：
// - seedBaselines（首次）
// - listCandidates → 找 ready candidate
// - 没有 ready candidate → proposeLLMCandidate + DomainRegistry.proposeCandidate
// - createCandidate + 可能 createApproval

export interface ModelDesignerInput {
  readonly taskID: string
  readonly hypothesisPlan: ExperimentPlan      // 来自 HypoPlanner
  readonly previousRuns: ResearchRun[]
  readonly candidates: ResearchCandidate[]
  readonly memory: ResearchMemory[]
  readonly champion: ResearchChampion | undefined
}

// 这个函数提取自 runAutonomousIteration，返回选中/创建的 candidate
export async function runModelDesigner(
  input: ModelDesignerInput,
  ctx: ModelDesignerContext,   // 包含 DomainRegistry, LLM config 等
): Promise<ModelDesignerResult>
```

---

### 4.4 `src/research/agents/model-compiler-agent.ts`（新建）

```typescript
export interface ModelCompilerInput {
  readonly taskID: string
  readonly candidateID: string
}

// 封装 executeRun(stage: "smoke") + 结果语义化
export function buildModelCompilerResult(input: {
  taskID: string
  candidateID: string
  smokeRun: ResearchRun
}): ModelCompilerResult
```

**关键逻辑：** smoke run 的 `status === "succeeded"` AND `val_avg_mse < 1e6` AND loss 不为 NaN → `passed`，否则 → `failed`。

---

### 4.5 `src/research/agents/train-eval-agent.ts`（新建）

```typescript
export function buildTrainEvalResult(input: {
  taskID: string
  run: ResearchRun
  candidate: ResearchCandidate
  stage: "low_fidelity" | "full"
  verifierReport: VerifierReport
}): TrainEvalResult
```

---

### 4.6 `src/research/service.ts`（修改）

#### A. 新增 PipelineWorkflowPhase

见 4.1。

#### B. 新增 Service 接口方法

```typescript
// 在 ResearchService interface 中新增：
readonly runHypoPlannerAgent: (input: HypoPlannerInput) => Effect.Effect<HypoPlannerResult>
readonly runModelDesignerAgent: (input: ModelDesignerInput) => Effect.Effect<ModelDesignerResult>
readonly runModelCompilerAgent: (input: ModelCompilerInput) => Effect.Effect<ModelCompilerResult>
readonly runTrainEvalAgent: (input: TrainEvalInput) => Effect.Effect<TrainEvalResult>
```

#### C. 重构 `runAutonomousIteration`

将当前单体函数拆分为依次调用四个 Agent：

```typescript
// 改前（伪代码）：
const runAutonomousIteration = function* (input) {
  // 1. fingerprint + hypothesis
  // 2. seedBaselines / propose candidate
  // 3. executeRun smoke
  // 4. executeRun full
  // 5. verifier
}

// 改后（伪代码）：
const runAutonomousIteration = function* (input) {
  const designerResult = yield* runModelDesignerAgent({...})     // 包含 seed/propose
  const compilerResult = yield* runModelCompilerAgent({
    taskID: input.taskID,
    candidateID: designerResult.candidateID,
  })
  if (compilerResult.status === "failed") {
    return buildFailedIterationResult(compilerResult)
  }
  const trainResult = yield* runTrainEvalAgent({
    taskID: input.taskID,
    candidateID: designerResult.candidateID,
    stage: input.stage,
  })
  return buildAutonomousIterationResult({ designerResult, compilerResult, trainResult })
}
```

#### D. 在 Pipeline 中插入 HypoPlanner 阶段

在 `runAutonomousPipeline` 的 `data_analysis` 之后、NAS loop 之前添加：

```typescript
// 改前：直接进入 runNASAgent
const nas = ... yield* runNASAgent({...})

// 改后：先 HypoPlanner，结果存入 taskSpec.metadata
const hypoPhase = workflow.completedPhases.includes("hypo_planning")
  ? yield* recoverHypoPlanning(currentTask)
  : yield* runHypoPlannerAgent({
      taskID: input.taskID,
      dataAnalysis,
    }).pipe(
      Effect.tap(() => markWorkflowPhase("hypo_planning")),
    )

// companion 模式下增加 checkpoint
// ...

const nas = ... yield* runNASAgent({...})  // nas-agent 内部读取 metadata.hypothesisPlan
```

#### E. 在 `runNASAgent` 中传递 HypoPlannerResult

`runNASAgent` 接收 `hypothesisPlan?: ExperimentPlan`，传给每次 `runAutonomousIteration`，再传给 `runModelDesignerAgent`。

---

### 4.7 TUI 侧边栏（`research-cockpit-data.ts`）

将 "NAS Agent 0/12 runs" 的单行显示拆分为：

```
✓ HypoPlanner Agent (3 hypotheses)
→ ModelDesigner Agent (iteration 4/12)
• ModelCompiler Agent
• TrainEval Agent
```

涉及修改：`formatResearchCockpitNextStep()` 和 `formatResearchCockpitProgress()`。

---

## 5. 实施顺序

按风险从低到高分四步实施，每步可独立测试：

### Step 1：HypoPlanner Agent（纯计算，无 I/O）

- 新建 `hypo-planner-agent.ts`（rule-based 版本，不调用 LLM）
- 单元测试：`test/research/hypo-planner-agent.test.ts`
- 在 service.ts 中添加 `runHypoPlannerAgent` 但暂不插入 pipeline
- 估计工作量：1-2 天

### Step 2：ModelDesigner Agent（提取已有逻辑）

- 新建 `model-designer-agent.ts`，将 `runAutonomousIteration` 前 50% 逻辑移入
- 修改 `runAutonomousIteration` 调用 `runModelDesignerAgent`
- 核心路径不变，只是有了边界隔离
- 单元测试：`test/research/model-designer-agent.test.ts`
- 估计工作量：1 天

### Step 3：ModelCompiler Agent（smoke 语义化）

- 新建 `model-compiler-agent.ts`，将 smoke stage 执行封装为编译结果
- 修改 `runAutonomousIteration`：smoke failed → 跳过 TrainEval，记录 `compile_failed`
- 单元测试：`test/research/model-compiler-agent.test.ts`
- 估计工作量：0.5 天

### Step 4：TrainEval Agent + Pipeline 接入 HypoPlanner

- 新建 `train-eval-agent.ts`（封装 full stage + verifier 结果整合）
- 在 `schema.ts` 新增 `"hypo_planning"` phase
- 在 `service.ts` pipeline 中插入 HypoPlanner 阶段
- 更新 `PipelineWorkflowPhases` 相关测试
- 更新 TUI 进度显示
- 估计工作量：1-2 天

---

## 6. 不改动的部分

- `VerifierAgent`：已独立，逻辑完整，TrainEval 只读取其输出
- `ReflectionAgent`：不变，继续接收 `AutonomousLoopResult`
- `PublishAgent`：不变
- `neo-cast-runner.ts`：Python 侧完全不动
- `DomainRegistry` / `tsf.ts`：不变
- DB schema（`research.sql.ts`）：不需要新表，HypoPlannerResult 序列化到 `taskSpec.metadata.hypothesisPlan`

---

## 7. 关键约束

1. **向后兼容**：现有 running tasks 在 `hypo_planning` phase 缺失时，`recoverHypoPlanning` 应合成一个 default plan（等价于现在没有 HypoPlanner 的行为），不能让旧任务卡住。

2. **ModelCompiler 失败处理**：smoke 失败不应该直接终止整个 loop，而是 `crashStreak += 1`，与现在的 run failed 处理保持一致。

3. **HypoPlanner 结果复用**：同一个 task 的 HypoPlanner 只运行一次（`hypo_planning` phase 记录），后续每轮迭代读取 `taskSpec.metadata.hypothesisPlan`，mid-loop reflection 可追加新假设。

4. **测试数量不减**：拆分后每个新 Agent 至少有 6 条单元测试，原有 `service.test.ts` 和 `nas-agent.test.ts` 测试全部继续通过。
