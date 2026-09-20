import type { LLMTokenUsage } from "../llm-proposal"
import type {
  JsonRecord,
  ResearchArtifact,
  ResearchCandidate,
  ResearchChampion,
  ResearchRun,
  ResearchTask,
  ResearchTaskID,
} from "../schema"

export type ReflectionDecision = "continue" | "stop" | "request_human"

export interface ReflectionEffectiveChange {
  readonly candidateID: string
  readonly runID: string
  readonly metricValue: number
  readonly delta: number
  readonly summary: string
}

export interface ReflectionIneffectiveChange {
  readonly candidateID: string
  readonly runID: string
  readonly metricValue: number
  readonly delta: number
  readonly summary: string
}

export interface ReflectionFailure {
  readonly runID: string
  readonly candidateID?: string
  readonly category: "oom" | "nan" | "not_converge" | "script_error" | "rejected" | "other"
  readonly summary: string
}

export interface ReflectionAnalysis {
  readonly primaryMetricName: string
  readonly direction: "minimize" | "maximize"
  readonly bestMetric?: number
  readonly bestRunID?: string
  readonly bestCandidateID?: string
  readonly latestMetric?: number
  readonly latestDelta?: number
  readonly succeededRuns: number
  readonly failedRuns: number
  readonly rejectedRuns: number
  readonly plateauStreak: number
  readonly effectiveChanges: ReflectionEffectiveChange[]
  readonly ineffectiveChanges: ReflectionIneffectiveChange[]
  readonly failures: ReflectionFailure[]
  readonly decision: ReflectionDecision
  readonly decisionReason: string
}

export interface ReflectionLLMAnalysis {
  /** Training process health: convergence, train/val gap, loss stability, whether results are trustworthy. */
  readonly trainingHealthAssessment: string
  /** Hypothesis validation: was the original hypothesis supported or refuted by the results? */
  readonly hypothesisValidation: string
  /** Attribution analysis: why did performance improve or degrade? */
  readonly attributionAnalysis: string
  /** Historical comparison: how does this iteration fit into the overall research trajectory? */
  readonly historicalComparison: string
  /** Model design reflection: which architecture or training choices should be revisited? */
  readonly modelDesignReflection: string
  /** Next-step recommendation: continue, modify, abandon, or change direction — and why. */
  readonly nextStepRecommendation: string
  /** Distillable memory: a self-contained summary (proposal + likely issues) for downstream agents. */
  readonly distillableMemory: string
}

export interface ReflectionAgentResult {
  readonly agent: "ReflectionAgent"
  readonly taskID: ResearchTaskID
  readonly reflectionNotesMarkdown: string
  readonly nextExperimentPlanMarkdown: string
  readonly failureLogMarkdown: string
  readonly analysis: ReflectionAnalysis
  readonly llm: {
    readonly status: "disabled" | "not_configured" | "used" | "failed"
    readonly model?: string
    readonly text?: string
    readonly structured?: ReflectionLLMAnalysis
    readonly error?: string
    readonly usage?: LLMTokenUsage
  }
}

interface ReflectionInputs {
  readonly task: ResearchTask
  readonly runs: readonly ResearchRun[]
  readonly candidates: readonly ResearchCandidate[]
  readonly champion?: ResearchChampion
  readonly stoppedReason?: string
  readonly artifact?: ResearchArtifact
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function objectiveMetricName(objective: ResearchTask["objective"]) {
  const record = recordValue(objective)
  if (typeof record.primaryMetric === "string") return record.primaryMetric
  if (typeof record.metric === "string") return record.metric
  return "val_avg_mse"
}

function objectiveDirection(objective: ResearchTask["objective"]): "minimize" | "maximize" {
  const direction = recordValue(objective).direction
  return direction === "maximize" ? "maximize" : "minimize"
}

function metricValue(metrics: ResearchRun["metrics"], metricName: string) {
  const value = (metrics as Record<string, unknown>)[metricName]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function classifyFailure(run: ResearchRun): ReflectionFailure["category"] {
  const error = (run.error ?? "").toLowerCase()
  if (run.status === "rejected") return "rejected"
  if (error.includes("out of memory") || error.includes("oom") || error.includes("cuda")) return "oom"
  if (error.includes("nan")) return "nan"
  if (error.includes("not converge") || error.includes("diverged")) return "not_converge"
  if (error.length > 0) return "script_error"
  return "other"
}

function recoveryActionForFailure(category: ReflectionFailure["category"]) {
  if (category === "oom") return "reduce_resource_pressure"
  if (category === "nan") return "stabilize_training"
  if (category === "not_converge") return "tune_optimization_budget"
  if (category === "script_error") return "inspect_runner_or_recipe"
  if (category === "rejected") return "review_verifier_decision"
  return "inspect_failure_context"
}

function recoverySummaryForFailure(category: ReflectionFailure["category"]) {
  if (category === "oom") return "降低 batch size、模型宽度或训练并行度，然后重试同一候选或相邻保守候选。"
  if (category === "nan") return "降低学习率、启用梯度裁剪或切换稳健损失，并检查异常值处理。"
  if (category === "not_converge") return "调整 optimizer/scheduler、训练步数或 patience，确认 loss 曲线进入下降通道。"
  if (category === "script_error") return "先修复 runner、依赖、recipe 序列化或数据路径问题，再恢复 NAS 搜索。"
  if (category === "rejected") return "读取 verifier_decision.json，按拒绝分类决定回退、重测或进入人工审批。"
  return "保留上下文并人工复核 stderr、runner records 与候选定义。"
}

function isBetter(direction: "minimize" | "maximize", next: number, current: number) {
  return direction === "minimize" ? next < current : next > current
}

function describeCandidate(candidate: ResearchCandidate | undefined) {
  if (!candidate) return "(unknown candidate)"
  const spec = recordValue(candidate.candidateSpec)
  const recipeID =
    typeof spec.recipeID === "string"
      ? spec.recipeID
      : typeof spec.recipe_id === "string"
        ? (spec.recipe_id as string)
        : undefined
  const action = recordValue(spec.action)
  const backbone = typeof action.backbone === "string" ? action.backbone : undefined
  const head = typeof action.head === "string" ? action.head : undefined
  const parts: string[] = []
  if (recipeID) parts.push(recipeID)
  if (backbone) parts.push(`backbone=${backbone}`)
  if (head) parts.push(`head=${head}`)
  if (parts.length === 0) return candidate.id
  return `${candidate.id} (${parts.join(", ")})`
}

function decide(input: {
  readonly stoppedReason?: string
  readonly plateauStreak: number
  readonly failedStreak: number
  readonly succeededRuns: number
}): { decision: ReflectionDecision; reason: string } {
  const { stoppedReason, plateauStreak, failedStreak, succeededRuns } = input
  if (stoppedReason === "target_reached") return { decision: "stop", reason: "已达到目标指标，反思建议停止迭代并发布。" }
  if (stoppedReason === "budget_exhausted")
    return { decision: "stop", reason: "预算已耗尽，反思建议停止迭代并整理产物。" }
  if (stoppedReason === "approval_required")
    return { decision: "request_human", reason: "需要人工确认才能继续，进入 Companion checkpoint。" }
  if (stoppedReason === "crash_streak_exceeded" || failedStreak >= 3)
    return {
      decision: "request_human",
      reason: "连续多次失败，建议人工介入排查代码、依赖或资源问题。",
    }
  if (succeededRuns === 0)
    return {
      decision: "request_human",
      reason: "尚无成功 run，先确认数据准备与训练脚本是否健康。",
    }
  if (plateauStreak >= 4)
    return {
      decision: "stop",
      reason: "已连续多轮 plateau，建议固化当前 champion 并发布。",
    }
  return { decision: "continue", reason: "继续执行下一步实验。" }
}

export function analyzeReflection(input: ReflectionInputs): ReflectionAnalysis {
  const primaryMetricName = objectiveMetricName(input.task.objective)
  const direction = objectiveDirection(input.task.objective)
  const candidatesByID = new Map(input.candidates.map((candidate) => [candidate.id, candidate] as const))

  const ordered = input.runs.filter((run) => run.status !== "invalid").sort((a, b) => a.time.created - b.time.created)
  const succeeded: { run: ResearchRun; metric: number }[] = []
  const ineffective: ReflectionIneffectiveChange[] = []
  const effective: ReflectionEffectiveChange[] = []
  const failures: ReflectionFailure[] = []

  let bestMetric: number | undefined
  let bestRunID: string | undefined
  let bestCandidateID: string | undefined
  let plateauStreak = 0
  let failedStreak = 0
  let latestMetric: number | undefined
  let latestDelta: number | undefined

  for (const run of ordered) {
    if (run.status === "succeeded") {
      const value = metricValue(run.metrics, primaryMetricName)
      if (value === undefined) continue
      const candidate = run.candidateID ? candidatesByID.get(run.candidateID) : undefined
      latestMetric = value
      const delta = bestMetric === undefined ? 0 : value - bestMetric
      latestDelta = bestMetric === undefined ? 0 : delta
      const summary = describeCandidate(candidate)
      if (bestMetric === undefined || isBetter(direction, value, bestMetric)) {
        if (bestMetric !== undefined) effective.push({
          candidateID: candidate?.id ?? "",
          runID: run.id,
          metricValue: value,
          delta,
          summary,
        })
        bestMetric = value
        bestRunID = run.id
        bestCandidateID = candidate?.id
        plateauStreak = 0
      } else {
        ineffective.push({
          candidateID: candidate?.id ?? "",
          runID: run.id,
          metricValue: value,
          delta,
          summary,
        })
        plateauStreak += 1
      }
      succeeded.push({ run, metric: value })
      failedStreak = 0
    } else if (run.status === "failed" || run.status === "rejected") {
      const candidate = run.candidateID ? candidatesByID.get(run.candidateID) : undefined
      failures.push({
        runID: run.id,
        candidateID: candidate?.id,
        category: classifyFailure(run),
        summary: run.error?.split("\n")[0] ?? `${run.status} run`,
      })
      failedStreak += 1
    }
  }

  const fingerprintProfile = recordValue(recordValue(input.task.taskSpec).profile)
  const datasetProfile = recordValue(recordValue(input.task.taskSpec).datasetProfile)
  const profile = { ...datasetProfile, ...fingerprintProfile }
  const biasArray = (recordValue(input.task.taskSpec).searchBiases ?? recordValue(input.task.taskSpec).search_biases) as
    | unknown[]
    | undefined
  const searchBiases = Array.isArray(biasArray)
    ? biasArray.filter((item): item is string => typeof item === "string")
    : []

  const succeededCount = succeeded.length
  const rejectedCount = ordered.filter((run) => run.status === "rejected").length
  const failedCount = ordered.filter((run) => run.status === "failed").length

  const { decision, reason } = decide({
    stoppedReason: input.stoppedReason,
    plateauStreak,
    failedStreak,
    succeededRuns: succeededCount,
  })

  return {
    primaryMetricName,
    direction,
    bestMetric,
    bestRunID,
    bestCandidateID: bestCandidateID ?? input.champion?.candidateID,
    latestMetric,
    latestDelta,
    succeededRuns: succeededCount,
    failedRuns: failedCount,
    rejectedRuns: rejectedCount,
    plateauStreak,
    effectiveChanges: effective,
    ineffectiveChanges: ineffective,
    failures,
    decision,
    decisionReason: reason,
  }
}

function fmt(value: number | undefined, digits = 6) {
  return value === undefined || !Number.isFinite(value) ? "n/a" : Number(value.toFixed(digits))
}

export function buildReflectionNotesMarkdown(input: {
  readonly task: ResearchTask
  readonly analysis: ReflectionAnalysis
  readonly stoppedReason?: string
}) {
  const { task, analysis, stoppedReason } = input
  const lines: string[] = [
    "# Reflection Notes",
    "",
    `- Agent: ReflectionAgent`,
    `- Task ID: ${task.id}`,
    `- Domain: ${task.domainID}`,
    `- Primary metric: ${analysis.primaryMetricName} (${analysis.direction})`,
    stoppedReason ? `- NAS stopped reason: ${stoppedReason}` : `- NAS stopped reason: (none)`,
    "",
    "## Run Summary",
    "",
    `- Succeeded runs: ${analysis.succeededRuns}`,
    `- Failed runs: ${analysis.failedRuns}`,
    `- Rejected runs: ${analysis.rejectedRuns}`,
    `- Plateau streak: ${analysis.plateauStreak}`,
    `- Best ${analysis.primaryMetricName}: ${fmt(analysis.bestMetric)}${
      analysis.bestRunID ? ` (run ${analysis.bestRunID})` : ""
    }`,
    `- Latest ${analysis.primaryMetricName}: ${fmt(analysis.latestMetric)} (delta vs best: ${fmt(
      analysis.latestDelta,
    )})`,
    "",
    "## Effective Changes",
    "",
    ...(analysis.effectiveChanges.length === 0
      ? ["- No improving iteration recorded yet."]
      : analysis.effectiveChanges.map(
          (item) =>
            `- ${item.summary}: ${analysis.primaryMetricName}=${fmt(item.metricValue)}, delta=${fmt(item.delta)}`,
        )),
    "",
    "## Ineffective Changes",
    "",
    ...(analysis.ineffectiveChanges.length === 0
      ? ["- No regressing iteration recorded yet."]
      : analysis.ineffectiveChanges.map(
          (item) =>
            `- ${item.summary}: ${analysis.primaryMetricName}=${fmt(item.metricValue)}, delta=${fmt(item.delta)}`,
        )),
    "",
    "## Failures",
    "",
    ...(analysis.failures.length === 0
      ? ["- No failed or rejected runs in this window."]
      : analysis.failures.map(
          (item) => `- [${item.category}] run ${item.runID}: ${item.summary}`,
        )),
    "",
    "## Decision",
    "",
    `- ${analysis.decision}: ${analysis.decisionReason}`,
    "",
  ]
  return `${lines.join("\n")}\n`
}

export function buildNextExperimentPlanMarkdown(input: {
  readonly task: ResearchTask
  readonly analysis: ReflectionAnalysis
}) {
  const { task, analysis } = input
  const lines: string[] = [
    "# Next Experiment Plan",
    "",
    `- Agent: ReflectionAgent`,
    `- Task ID: ${task.id}`,
    `- Decision: ${analysis.decision}`,
    `- Reason: ${analysis.decisionReason}`,
    "",
  ]
  lines.push(
    "## Recommended Next Action",
    "",
    analysis.decision === "stop"
      ? "- Run PublishAgent on the current champion."
      : analysis.decision === "request_human"
        ? "- Pause autonomous loop and surface a Human Checkpoint."
        : "- Trigger the next NAS iteration consuming the hypotheses above as mutation hints.",
    "",
  )
  return `${lines.join("\n")}\n`
}

export function buildFailureLogMarkdown(input: {
  readonly task: ResearchTask
  readonly analysis: ReflectionAnalysis
  readonly stoppedReason?: string
}) {
  const { task, analysis, stoppedReason } = input
  const lines: string[] = [
    "# Failure Log",
    "",
    `- schema_version: neo-research.failure_log.v1`,
    `- agent: ReflectionAgent`,
    `- task_id: ${task.id}`,
    `- domain: ${task.domainID}`,
    `- stopped_reason: ${stoppedReason ?? "(none)"}`,
    "",
    "## Failure Records",
    "",
  ]
  if (analysis.failures.length === 0) {
    lines.push("- No failed or rejected runs in this reflection window.", "")
  } else {
    for (let index = 0; index < analysis.failures.length; index++) {
      const failure = analysis.failures[index]!
      lines.push(
        `### F${index + 1}`,
        "",
        `- run_id: ${failure.runID}`,
        `- candidate_id: ${failure.candidateID ?? "(none)"}`,
        `- category: ${failure.category}`,
        `- recovery_action: ${recoveryActionForFailure(failure.category)}`,
        `- recovery_summary: ${recoverySummaryForFailure(failure.category)}`,
        `- summary: ${failure.summary}`,
        "",
      )
    }
  }
  lines.push(
    "## Decision",
    "",
    `- decision: ${analysis.decision}`,
    `- reason: ${analysis.decisionReason}`,
    "",
  )
  return `${lines.join("\n")}\n`
}

export function summarizeReflectionAgent(input: ReflectionInputs): ReflectionAgentResult {
  const analysis = analyzeReflection(input)
  return {
    agent: "ReflectionAgent",
    taskID: input.task.id,
    analysis,
    reflectionNotesMarkdown: buildReflectionNotesMarkdown({
      task: input.task,
      analysis,
      stoppedReason: input.stoppedReason,
    }),
    nextExperimentPlanMarkdown: buildNextExperimentPlanMarkdown({
      task: input.task,
      analysis,
    }),
    failureLogMarkdown: buildFailureLogMarkdown({
      task: input.task,
      analysis,
      stoppedReason: input.stoppedReason,
    }),
    llm: { status: "disabled" },
  }
}

export function reflectionAgentMetadata(result: ReflectionAgentResult): JsonRecord {
  return {
    decision: result.analysis.decision,
    decisionReason: result.analysis.decisionReason,
    primaryMetricName: result.analysis.primaryMetricName,
    bestMetric: result.analysis.bestMetric ?? null,
    plateauStreak: result.analysis.plateauStreak,
    succeededRuns: result.analysis.succeededRuns,
    failedRuns: result.analysis.failedRuns,
    rejectedRuns: result.analysis.rejectedRuns,
    failureCount: result.analysis.failures.length,
    failureCategories: result.analysis.failures.map((failure) => failure.category),
  }
}
