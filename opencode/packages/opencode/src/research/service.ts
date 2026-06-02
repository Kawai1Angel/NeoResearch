import { NamedError } from "@opencode-ai/core/util/error"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import { cp, mkdir, readFile, writeFile } from "fs/promises"
import { existsSync, openSync, readSync, closeSync } from "fs"
import { createHash } from "crypto"
import os from "os"
import path from "path"
import { deflateSync } from "zlib"
import z from "zod"
import { and, desc, eq, inArray, notInArray, isNull, lt, ne, Database, NotFoundError } from "@/storage"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import * as Process from "@/util/process"
import {
  ResearchApprovalTable,
  ResearchArtifactTable,
  ResearchCandidateTable,
  ResearchChampionTable,
  ResearchMemoryTable,
  ResearchRunTable,
  ResearchTaskTable,
} from "./research.sql"
import {
  AnswerIntentInput,
  AutonomousIterationInput,
  AutonomousLoopInput,
  CreateApprovalInput,
  CreateArtifactInput,
  CreateCandidateInput,
  CreateMemoryInput,
  CreateRunInput,
  CreateTaskInput,
  ExecuteSeedSweepInput,
  ExportTaskArtifactInput,
  ExportTaskArtifactResult,
  JsonRecord,
  ListApprovalInput,
  ListTaskInput,
  PrepareRunInput,
  PrepareTaskDatasetInput,
  PrepareTaskDatasetResult,
  ProfileTaskInput,
  ProfileTaskResult,
  ReflectionAgentInput,
  VerifierAgentRunInput,
  ReplyApprovalInput,
  ResearchApproval,
  ResearchApprovalID,
  ResearchArtifact,
  ResearchArtifactID,
  ResearchCandidate,
  ResearchCandidateID,
  ResearchChampion,
  ResearchMemory,
  ResearchMemoryID,
  ResearchRun,
  ResearchRunID,
  RunFullPipelineInput,
  SeedBaselinesInput,
  ResearchTask,
  ResearchTaskID,
  SetChampionInput,
  UpdateTaskSpecInput,
  UpdateRunStatusInput,
  UpdateTaskStatusInput,
} from "./schema"
import { Event } from "./event"
import {
  type DomainCandidateProposal,
  DomainRunPlan as DomainRunPlanSchema,
  issue,
  type DomainCandidateRanking,
  type DomainRunEvaluation,
  type DomainRunPlan,
  type DomainRunStage,
  type DomainValidationIssue,
} from "./domain"
import { DomainRegistry } from "./domain-registry"
import { apiKeyFor, extractJsonObject, proposeLLMCandidate, requestNeoCastLLM, requestNeoCastLLMStream, resolveNeoCastLLMConfig, resolveApiKeyFromAuthJson, usageToMetadata, type AuthJsonKeyResult } from "./llm-proposal"
import { createFileResearchRuntime, researchJobFromRunPlan } from "./runtime"
import { analyzeIntentTask, analyzeIntentTaskWithLLM, interpretSlotModificationWithLLM, normalizeIntentSlotKeys, parseSlotInputsWithLLM, type IntentAgentResult } from "./agents/intent-agent"
import {
  buildDatasetAnalysisReportMarkdown,
  type DatasetAnalysisSourceReport,
  summarizeDataAnalysisAgent,
  type DataAnalysisAgentResult,
} from "./agents/data-analysis-agent"
import {
  buildModelCompilerResult,
  type ModelCompilerResult,
} from "./agents/model-compiler-agent"
import {
  buildModelDesignerResult,
  buildModelDesignerTaskFingerprint,
  candidateAttemptStateFromRuns as modelDesignerCandidateAttemptStateFromRuns,
  selectHypothesisForDesign,
  selectModelDesignerCandidate,
  type ModelDesignerLLMStatus,
} from "./agents/model-designer-agent"
import {
  buildHypoPlanMarkdown,
  buildHypoPlannerResult,
  buildHypothesesYaml,
  extractEvidenceSummary,
  generateHypotheses,
  type ExperimentPlan,
  type HypoPlannerInput,
  type HypoPlannerResult,
  type HypothesisObject,
} from "./agents/hypo-planner-agent"
import { buildNASAgentResult, summarizeNASAgentLoop, type NASAgentResult } from "./agents/nas-agent"
import { summarizePublishAgent, type PublishAgentResult } from "./agents/publish-agent"
import { buildTrainEvalResult, type TrainEvalResult } from "./agents/train-eval-agent"
import {
  analyzeReflection,
  reflectionAgentMetadata,
  summarizeReflectionAgent,
  type ReflectionAgentResult,
  type ReflectionAnalysis,
} from "./agents/reflection-agent"
import {
  evaluateRun as evaluateRunWithVerifiers,
  verifierAgentMetadata,
  type VerifierAgentResult,
} from "./agents/verifier-agent"
import { buildEvaluationResultMarkdown, buildVerifierDecisionRecord, runVerifiers, type VerifierReport } from "./verifiers"

type DbClient = Parameters<typeof Database.use>[0] extends (trx: infer D) => unknown ? D : never
type ResearchTaskRow = typeof ResearchTaskTable.$inferSelect
type ResearchApprovalRow = typeof ResearchApprovalTable.$inferSelect
type ResearchCandidateRow = typeof ResearchCandidateTable.$inferSelect
type ResearchRunRow = typeof ResearchRunTable.$inferSelect
type ResearchArtifactRow = typeof ResearchArtifactTable.$inferSelect
type ResearchMemoryRow = typeof ResearchMemoryTable.$inferSelect
type ResearchChampionRow = typeof ResearchChampionTable.$inferSelect

export interface SeedBaselinesResult {
  readonly candidates: ResearchCandidate[]
  readonly approvals: ResearchApproval[]
}

export interface PreparedRun {
  readonly run: ResearchRun
  readonly runPlan: DomainRunPlan
}

export interface AutonomousIterationResult extends PreparedRun {
  readonly candidate: ResearchCandidate
  readonly seededCandidates: ResearchCandidate[]
  readonly approvals: ResearchApproval[]
  readonly managerTrace: ResearchManagerStep[]
  readonly selectionArtifact: ResearchArtifact
}

export interface SeedSweepResult {
  readonly seeds: readonly number[]
  readonly runs: readonly PreparedRun[]
}

export type ResearchManagerRole = "diagnostic" | "design" | "coder" | "runner" | "analyst" | "verifier" | "librarian"

export interface ResearchManagerStep {
  readonly role: ResearchManagerRole
  readonly status: "completed" | "skipped" | "blocked"
  readonly summary: string
  readonly metadata: JsonRecord
}

export type ResearchManagerTraceStep = ResearchManagerStep

export type AutonomousLoopStoppedReason =
  | "max_iterations"
  | "budget_exhausted"
  | "approval_required"
  | "seed_failed"
  | "target_reached"
  | "plateau"
  | "time_budget_exhausted"
  | "crash_streak_exceeded"

export interface AutonomousLoopResult {
  readonly iterations: AutonomousIterationResult[]
  readonly stoppedReason: AutonomousLoopStoppedReason
  readonly artifact: ResearchArtifact
}

export interface RunFullPipelineResult {
  readonly task: ResearchTask
  readonly intent: IntentAgentResult
  readonly dataAnalysis: DataAnalysisAgentResult
  readonly hypoPlanning: HypoPlannerResult
  readonly nas: NASAgentResult
  readonly reflection: ReflectionAgentResult
  readonly publish: PublishAgentResult
}

export interface ResearchLLMStatus {
  readonly status: "ready" | "not_configured" | "env_var"
  readonly provider: string
  readonly model: string
  readonly source: "env_var" | "auth_json" | "unconfigured"
}

const PipelineWorkflowPhases = [
  "intent_gathering",
  "data_analysis",
  "hypo_planning",
  "searching",
  "nas_budget_extended",
  "reflection",
  "publishing",
] as const
type PipelineWorkflowPhase = (typeof PipelineWorkflowPhases)[number]

interface PipelineWorkflowMetadata {
  readonly completedPhases: readonly PipelineWorkflowPhase[]
  readonly lastCheckpoint?: string
}

const ResearchValidationIssueSchema = z
  .object({
    path: z.string(),
    message: z.string(),
    severity: z.enum(["error", "warning"]),
  })
  .strict()

export const TaskSpecValidationError = NamedError.create(
  "ResearchTaskSpecValidationError",
  z.object({
    domainID: z.string(),
    issues: z.array(ResearchValidationIssueSchema),
  }),
)

export const CandidateValidationError = NamedError.create(
  "ResearchCandidateValidationError",
  z.object({
    taskID: z.string(),
    domainID: z.string(),
    issues: z.array(ResearchValidationIssueSchema),
  }),
)

export const BudgetExceededError = NamedError.create(
  "ResearchBudgetExceededError",
  z.object({
    taskID: z.string(),
    limit: z.number(),
    used: z.number(),
  }),
)

export const ApprovalRequiredError = NamedError.create(
  "ResearchApprovalRequiredError",
  z.object({
    taskID: z.string(),
    candidateID: z.string(),
    kind: z.string(),
  }),
)

export const PipelineBlockedError = NamedError.create(
  "ResearchPipelineBlockedError",
  z.object({
    taskID: z.string(),
    reason: z.enum([
      "pipeline_requires_autonomous",
      "intent_clarification_required",
      "human_checkpoint_required",
      "reflection_requested_human_review",
      "runner_not_configured",
    ]),
    missingFields: z.array(z.string()).optional(),
    clarifyingQuestions: z.array(z.string()).optional(),
    checkpointPhase: z.string().optional(),
  }),
)

export const SeedBaselinesError = NamedError.create(
  "ResearchSeedBaselinesError",
  z.object({
    taskID: z.string(),
    message: z.string(),
  }),
)

interface RunnerExecution {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly records: Record<string, unknown>[]
}

const RUNNER_IDLE_TIMEOUT_MS = 180_000
const RUNNER_ABORT_KILL_GRACE_MS = 5_000
const RUNNER_NAN_WATCHDOG_LIMIT = 3
const STALE_RUN_RECONCILE_MS = 5 * 60_000
const DEFAULT_CUSTOM_SPLIT_STRATEGY = "tsl_custom_70_10_20"
type DatasetSplitStrategy = "tsl_custom_70_10_20" | "contiguous_60_20_20"

interface RunBudgetExceeded {
  readonly limit: number
  readonly used: number
}

const db = <T>(fn: (d: DbClient) => T): Effect.Effect<T> =>
  Effect.try({
    try: () => Database.use(fn),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error: unknown) =>
      Effect.sync(() => {
        throw error
      }),
    ),
  )

function nowTime() {
  const now = Date.now()
  return { created: now, updated: now }
}

function missing(kind: string, id: string) {
  return new NotFoundError({ message: `${kind} not found: ${id}` })
}

function isTerminal(status: ResearchRun["status"]) {
  return status === "succeeded" || status === "failed" || status === "rejected"
}

function runnerPath(cwd: string, target: string) {
  return path.isAbsolute(target) ? target : path.join(cwd, target)
}

function taskInteractionMode(task: ResearchTask) {
  if (task.interactionMode === "companion" || task.interactionMode === "socratic") return task.interactionMode
  const taskSpec = task.taskSpec
  const metadata =
    taskSpec.metadata && typeof taskSpec.metadata === "object" && !Array.isArray(taskSpec.metadata)
      ? (taskSpec.metadata as Record<string, unknown>)
      : {}
  const raw = metadata.interactionMode ?? metadata.interaction_mode
  if (raw === "companion" || raw === "cognitive_companion") return "companion"
  if (raw === "socratic") return "socratic"
  return task.mode === "autonomous" ? "socratic" : undefined
}

function compactIntentValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(compactIntentValue).join(",")
  if (typeof value === "string") return value.trim() || "-"
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return "-"
}

function intentCheckpointSignature(task: ResearchTask) {
  const spec = recordValue(task.taskSpec)
  const dataset = recordValue(spec.dataset)
  const objective = recordValue(task.objective)
  const budget = recordValue(task.budget)
  return [
    `mode=${compactIntentValue(taskInteractionMode(task) ?? task.mode)}`,
    `dataset=${compactIntentValue(dataset.path ?? dataset.loaderID)}`,
    `targets=${compactIntentValue(dataset.targetCols)}`,
    `context=${compactIntentValue(spec.contextLength)}`,
    `horizons=${compactIntentValue(spec.predictionLengths)}`,
    `metric=${compactIntentValue(objective.primaryMetric)}`,
    `direction=${compactIntentValue(objective.direction)}`,
    `maxRuns=${compactIntentValue(budget.maxRuns)}`,
  ].join("|")
}

function buildIntentCheckpointReason(task: ResearchTask) {
  const spec = recordValue(task.taskSpec)
  const dataset = recordValue(spec.dataset)
  const objective = recordValue(task.objective)
  const budget = recordValue(task.budget)
  const metadata = recordValue(spec.metadata)
  // intentSlots holds values typed by the user (or LLM-parsed). Use them as fallback when
  // canonical fields are not yet set (e.g. natural-language input without a configured API key).
  const intentSlots = recordValue(metadata.intentSlots)
  function slotOr(canonical: unknown, slotKey: string) {
    return canonical !== undefined && canonical !== null ? canonical : intentSlots[slotKey]
  }
  return [
    "## 需求交流确认完成后，才能结束 Intent Agent",
    "",
    "请确认 Intent Agent 已完成需求交流，下面这些研究意图可以作为后续 Data Analysis、HypoPlanner 和实验循环的输入。",
    `Intent signature: ${intentCheckpointSignature(task)}`,
    `Interaction mode: ${compactIntentValue(taskInteractionMode(task) ?? task.mode)}`,
    `Task: ${task.title}`,
    `Dataset: ${compactIntentValue(slotOr(dataset.path ?? dataset.loaderID, "data_source"))}`,
    `Targets: ${compactIntentValue(slotOr(dataset.targetCols, "target_columns"))}`,
    `Forecast object: ${compactIntentValue(intentSlots.forecast_object ?? spec.forecastObject)}`,
    `Context length: ${compactIntentValue(slotOr(spec.contextLength, "lookback_window"))}`,
    `Prediction lengths: ${compactIntentValue(slotOr(spec.predictionLengths, "prediction_horizon"))}`,
    `Time grain: ${compactIntentValue(intentSlots.time_grain ?? spec.timeGrain ?? spec.frequency)}`,
    `Exogenous variables: ${compactIntentValue(intentSlots.exogenous_variables ?? dataset.exogenousCols)}`,
    `Primary metric: ${compactIntentValue(slotOr(objective.primaryMetric, "primary_metric"))}`,
    `Error preferences: ${compactIntentValue(intentSlots.error_preferences ?? objective.errorPreferences)}`,
    `Latency budget: ${compactIntentValue(intentSlots.latency_budget ?? budget.latencyBudget)}`,
    `Parameter budget: ${compactIntentValue(intentSlots.parameter_budget ?? budget.parameterBudget)}`,
    `Interpretability: ${compactIntentValue(intentSlots.interpretability ?? spec.interpretability)}`,
    `Deployment target: ${compactIntentValue(intentSlots.deployment_target ?? spec.deploymentTarget)}`,
    `Budget max runs: ${compactIntentValue(budget.maxRuns)}`,
    `Business context: ${compactIntentValue(intentSlots.business_context ?? metadata.businessContext ?? metadata.business_context)}`,
    "",
    "**建议操作：** 确认以上需求后 approve，系统才会结束 Intent Agent 并进入 Data Analysis；如需补充需求，请 reject 并逐一修改 slots 后重新确认。",
  ].join("\n")
}

function taskInteractionModeFromFields(mode: string, taskSpec: JsonRecord) {
  const metadata =
    taskSpec.metadata && typeof taskSpec.metadata === "object" && !Array.isArray(taskSpec.metadata)
      ? (taskSpec.metadata as Record<string, unknown>)
      : {}
  const raw = metadata.interactionMode ?? metadata.interaction_mode
  if (raw === "companion" || raw === "cognitive_companion") return "companion"
  if (raw === "socratic") return "socratic"
  return mode === "autonomous" ? "socratic" : undefined
}

function parseRunnerRecords(stdout: string) {
  const records: Record<string, unknown>[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) records.push(parsed)
    } catch {
      // Neo-Cast forwards human-readable runner_status lines too; ignore non-JSON output.
    }
  }
  return records
}

interface RunnerProgressFields {
  readonly event?: string
  readonly epoch?: number
  readonly horizon?: number
  readonly valLoss?: number
  readonly elapsedS?: number
}

function parseProgressLine(line: string): RunnerProgressFields {
  try {
    const parsed = JSON.parse(line)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const record = parsed as Record<string, unknown>
    const event = typeof record.event === "string" ? record.event : undefined
    const epoch = finiteNumber(record.epoch)
    const horizon = finiteNumber(record.horizon)
    const valLoss = finiteNumber(record.val_loss) ?? finiteNumber(record.valLoss)
    const elapsedS = finiteNumber(record.elapsed_s) ?? finiteNumber(record.elapsedS)
    return {
      ...(event === undefined ? {} : { event }),
      ...(epoch === undefined ? {} : { epoch }),
      ...(horizon === undefined ? {} : { horizon }),
      ...(valLoss === undefined ? {} : { valLoss }),
      ...(elapsedS === undefined ? {} : { elapsedS }),
    }
  } catch {
    return {}
  }
}

function runnerLineHasNaNValidationLoss(line: string) {
  if (/"val_loss"\s*:\s*NaN\b/i.test(line) || /\bval_loss\s*=\s*NaN\b/i.test(line)) return true
  try {
    const parsed = JSON.parse(line)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false
    const record = parsed as Record<string, unknown>
    const value = record.val_loss ?? record.valLoss
    return typeof value === "number" && Number.isNaN(value)
  } catch {
    return false
  }
}

function runnerLineHasFiniteValidationLoss(line: string) {
  try {
    const parsed = JSON.parse(line)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false
    const record = parsed as Record<string, unknown>
    return finiteNumber(record.val_loss) !== undefined || finiteNumber(record.valLoss) !== undefined
  } catch {
    return false
  }
}

function metricsFromRecords(records: Record<string, unknown>[], stage?: DomainRunStage) {
  const metrics: Record<string, number> = {}
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      const acceptsStageMetric =
        stage === "ref_test"
          ? key.startsWith("ref_test_")
          : stage === undefined
            ? key.startsWith("val_") || key.startsWith("ref_test_")
            : key.startsWith("val_")
      if (acceptsStageMetric && typeof value === "number") {
        metrics[key] = value
      }
    }
  }
  return metrics
}

function objectiveMetricName(objective: ResearchTask["objective"]) {
  const record = objective as Record<string, unknown>
  if (typeof record.primaryMetric === "string") return record.primaryMetric
  if (typeof record.metric === "string") return record.metric
  return "val_avg_mse"
}

function objectiveSecondaryMetricName(objective: ResearchTask["objective"], primaryMetricName: string) {
  const record = objective as Record<string, unknown>
  const configured = record.secondaryMetric ?? record.tieBreakerMetric ?? record.longHorizonMetric
  if (typeof configured === "string" && configured.length > 0) return configured
  return primaryMetricName === "val_avg_mse" ? "val_h720_mse" : undefined
}

function objectiveDirection(objective: ResearchTask["objective"]) {
  const direction = (objective as Record<string, unknown>).direction
  return direction === "maximize" ? "maximize" : "minimize"
}

function metricValue(metrics: ResearchRun["metrics"], metricName: string) {
  const value = (metrics as Record<string, unknown>)[metricName]
  return typeof value === "number" ? value : undefined
}

function fallbackRunEvaluation(task: ResearchTask, run: ResearchRun): DomainRunEvaluation {
  const primaryMetricName = objectiveMetricName(task.objective)
  const primaryMetric = metricValue(run.metrics, primaryMetricName)
  const direction = objectiveDirection(task.objective)
  return {
    primaryMetricName,
    primaryMetric,
    direction,
    utility: primaryMetric === undefined ? undefined : direction === "minimize" ? -primaryMetric : primaryMetric,
  }
}

function maxRunsLimit(budget: ResearchTask["budget"]) {
  const value = (budget as Record<string, unknown>).maxRuns
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

function maxParallelLimit(budget: ResearchTask["budget"]) {
  const value = (budget as Record<string, unknown>).maxParallel
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

function budgetLoopPolicy(task: ResearchTask) {
  const budget = recordValue(task.budget)
  return recordValue(budget.loop ?? budget.researchLoop ?? budget.autonomousLoop)
}

function numericPolicyValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function integerPolicyValue(value: unknown) {
  const parsed = numericPolicyValue(value)
  return parsed === undefined || parsed < 0 ? undefined : Math.floor(parsed)
}

function maxFailedCandidateRetries(task: ResearchTask) {
  const policy = budgetLoopPolicy(task)
  return integerPolicyValue(policy.maxFailedCandidateRetries ?? policy.maxRetriesPerCandidate) ?? 1
}

function loopPolicyValue(inputValue: unknown, task: ResearchTask, ...keys: string[]) {
  if (inputValue !== undefined) return numericPolicyValue(inputValue)
  const policy = budgetLoopPolicy(task)
  for (const key of keys) {
    const value = numericPolicyValue(policy[key])
    if (value !== undefined) return value
  }
  return undefined
}

function loopPolicyInteger(inputValue: unknown, task: ResearchTask, ...keys: string[]) {
  const value = loopPolicyValue(inputValue, task, ...keys)
  return value === undefined || value < 0 ? undefined : Math.floor(value)
}

function loopPolicyRate(inputValue: unknown, task: ResearchTask, ...keys: string[]) {
  const value = loopPolicyValue(inputValue, task, ...keys)
  if (value === undefined) return undefined
  return Math.max(0, Math.min(1, value))
}

function shouldForceExplorationIteration(index: number, explorationRate: number | undefined) {
  if (explorationRate === undefined || explorationRate <= 0) return false
  if (explorationRate >= 1) return true
  const interval = Math.max(1, Math.round(1 / explorationRate))
  return (index + 1) % interval === 0
}

function candidateRecipeID(candidateSpec: ResearchCandidate["candidateSpec"]) {
  const value = (candidateSpec as Record<string, unknown>).recipeID
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function rankingRecipeID(ranking: DomainCandidateRanking) {
  if (!ranking.candidateSpec || typeof ranking.candidateSpec !== "object" || Array.isArray(ranking.candidateSpec)) {
    return undefined
  }
  const recipeID = (ranking.candidateSpec as Record<string, unknown>).recipeID
  return typeof recipeID === "string" && recipeID.length > 0 ? recipeID : undefined
}

function rankingArtifactRecord(ranking: DomainCandidateRanking) {
  return {
    rank: ranking.rank,
    score: ranking.score,
    reasons: [...ranking.reasons],
    ...(ranking.predictorVersion === undefined ? {} : { predictorVersion: ranking.predictorVersion }),
    ...(ranking.features === undefined ? {} : { features: ranking.features }),
    ...(ranking.candidateActions === undefined ? {} : { candidateActions: ranking.candidateActions }),
    recipeID: rankingRecipeID(ranking),
    candidateSpec: ranking.candidateSpec,
    rationale: ranking.rationale,
    riskLevel: ranking.riskLevel,
    approvalStatus: ranking.approvalStatus,
    generatedBy: ranking.generatedBy,
  }
}

function rankPredictorArtifactRecord(rankings: readonly DomainCandidateRanking[]) {
  const predictorVersion = rankings.find((ranking) => ranking.predictorVersion !== undefined)?.predictorVersion
  const hasFeatures = rankings.some((ranking) => ranking.features !== undefined)
  const features = rankings.find((ranking) => ranking.features !== undefined)?.features
  return {
    version: predictorVersion ?? "unavailable",
    featureSource: hasFeatures ? "taskFingerprint.datasetProfile" : "unavailable",
    rankingCount: rankings.length,
    ...(typeof features?.historyMemoryCount === "number" ? { historyMemoryCount: features.historyMemoryCount } : {}),
    ...(typeof features?.historyTaskMemoryCount === "number"
      ? { historyTaskMemoryCount: features.historyTaskMemoryCount }
      : {}),
    ...(typeof features?.historyDomainMemoryCount === "number"
      ? { historyDomainMemoryCount: features.historyDomainMemoryCount }
      : {}),
    ...(typeof features?.memoryEvidenceCount === "number" ? { memoryEvidenceCount: features.memoryEvidenceCount } : {}),
    ...(typeof features?.benchmarkEvidenceCount === "number"
      ? { benchmarkEvidenceCount: features.benchmarkEvidenceCount }
      : {}),
    ...(typeof features?.metricEvidenceCount === "number" ? { metricEvidenceCount: features.metricEvidenceCount } : {}),
  }
}

function managerStep(
  role: ResearchManagerRole,
  status: ResearchManagerStep["status"],
  summary: string,
  metadata: Record<string, unknown> = {},
): ResearchManagerStep {
  return {
    role,
    status,
    summary,
    metadata: metadata as JsonRecord,
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function experimentPlanFromMetadata(value: unknown): ExperimentPlan | undefined {
  const record = recordValue(value)
  return Array.isArray(record.hypotheses) ? (value as ExperimentPlan) : undefined
}

function recoverHypoPlannerResultFromPlan(input: {
  readonly task: ResearchTask
  readonly dataAnalysis: DataAnalysisAgentResult
  readonly plan: ExperimentPlan
}): HypoPlannerResult {
  const evidenceSummary = extractEvidenceSummary(input.dataAnalysis)
  const partial = {
    agent: "HypoPlannerAgent" as const,
    taskID: input.task.id,
    plan: input.plan,
    hypothesesYaml: buildHypothesesYaml(input.plan),
    evidenceSummary,
    llm: { status: "skipped" as const },
  }
  return {
    ...partial,
    planMarkdown: buildHypoPlanMarkdown({ ...partial, planMarkdown: "" }),
  }
}

function modelDesignerLLMStatusFromMetadata(
  metadata: JsonRecord,
  generatedBy: ResearchCandidate["generatedBy"],
  selectionSource: "existing_frontier" | "domain_proposal",
): ModelDesignerLLMStatus {
  const status = metadata.llmStatus
  if (status === "used" || status === "failed" || status === "disabled" || status === "invalid") return status
  if (generatedBy === "llm") return "used"
  return selectionSource === "existing_frontier" ? "disabled" : "disabled"
}

function asPipelineWorkflowMetadata(input: unknown): PipelineWorkflowMetadata {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { completedPhases: [] }
  const candidate = input as Record<string, unknown>
  const raw = candidate.completedPhases
  const completedPhases = Array.isArray(raw)
    ? raw
        .filter((phase): phase is PipelineWorkflowPhase =>
          typeof phase === "string" &&
          (PipelineWorkflowPhases.includes(phase as PipelineWorkflowPhase) || phase === "intent_gathering" || phase === "data_analysis"),
        )
    : []
  return {
    completedPhases: [...new Set(completedPhases)],
    lastCheckpoint: typeof candidate.lastCheckpoint === "string" ? candidate.lastCheckpoint : undefined,
  }
}

function workflowMetadataFromTask(task: ResearchTask): PipelineWorkflowMetadata {
  const metadata = recordValue(task.taskSpec.metadata)
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return { completedPhases: [] }
  return asPipelineWorkflowMetadata(metadata.workflow)
}

function normalizeWorkflowMetadata(input: PipelineWorkflowMetadata): PipelineWorkflowMetadata {
  const completedPhases = new Map<string, PipelineWorkflowPhase>()
  for (const phase of input.completedPhases) {
    if (PipelineWorkflowPhases.includes(phase)) completedPhases.set(phase, phase)
  }
  return {
    completedPhases: PipelineWorkflowPhases.filter((phase) => completedPhases.has(phase)),
    ...(input.lastCheckpoint === undefined ? {} : { lastCheckpoint: input.lastCheckpoint }),
  }
}

function hasCompletedWorkflowPhase(task: ResearchTask, phase: PipelineWorkflowPhase) {
  return normalizeWorkflowMetadata(workflowMetadataFromTask(task)).completedPhases.includes(phase)
}

function errorMetadata(error: unknown): JsonRecord {
  return {
    error: error instanceof Error ? error.message : String(error),
    errorName: error instanceof Error ? error.name : "Error",
  } as JsonRecord
}

function cloneJsonRecord(value: JsonRecord): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

function candidateSpecWithSeed(candidateSpec: ResearchCandidate["candidateSpec"], seed: number): JsonRecord {
  const next = cloneJsonRecord(candidateSpec)
  const trainingStrategy =
    next.trainingStrategy && typeof next.trainingStrategy === "object" && !Array.isArray(next.trainingStrategy)
      ? (next.trainingStrategy as Record<string, unknown>)
      : {}
  next.trainingStrategy = trainingStrategy

  const budget =
    trainingStrategy.budget && typeof trainingStrategy.budget === "object" && !Array.isArray(trainingStrategy.budget)
      ? (trainingStrategy.budget as Record<string, unknown>)
      : {}
  trainingStrategy.budget = budget
  budget.seed = seed

  return next as JsonRecord
}

function taskEvaluationSeeds(task: ResearchTask, override?: readonly number[]) {
  const rawSeeds = override ?? recordValue(recordValue(task.taskSpec).evaluation).seeds
  const seeds = (Array.isArray(rawSeeds) ? rawSeeds : [])
    .filter((seed): seed is number => typeof seed === "number" && Number.isFinite(seed) && seed >= 0)
    .map((seed) => Math.floor(seed))
  return seeds.length > 0 ? [...new Set(seeds)] : [42]
}

function metricSamplesForCandidate(
  runs: readonly ResearchRun[],
  candidateID: ResearchCandidateID,
  metricName: string,
  stage: ResearchRun["stage"],
) {
  return runs
    .filter((item) => item.candidateID === candidateID && item.status === "succeeded" && item.stage === stage)
    .map((item) => metricValue(item.metrics, metricName))
    .filter((item): item is number => item !== undefined)
}

function metricSampleSummary(samples: readonly number[]) {
  const count = samples.length
  const mean = count === 0 ? undefined : samples.reduce((sum, value) => sum + value, 0) / count
  const variance =
    count < 2 || mean === undefined
      ? 0
      : samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count
  const std = Math.sqrt(variance)
  const ci95 = count < 2 ? 0 : 1.96 * (std / Math.sqrt(count))
  return { count, mean, std, ci95 }
}

function intervalsOverlap(aMean: number, aCi95: number, bMean: number, bCi95: number) {
  return aMean - aCi95 <= bMean + bCi95 && bMean - bCi95 <= aMean + aCi95
}

function typeValue(value: unknown) {
  const type = recordValue(value).type
  return typeof type === "string" ? type : undefined
}

function candidateActionSummary(candidateSpec: ResearchCandidate["candidateSpec"]) {
  const recipe = recordValue(candidateSpec)
  const preprocessing = recordValue(recipe.preprocessing).actions
  const preprocessingActions = Array.isArray(preprocessing)
    ? preprocessing.map(typeValue).filter((item): item is string => item !== undefined)
    : []
  const summary: Record<string, unknown> = {}
  if (preprocessingActions.length > 0) summary.preprocessing = preprocessingActions
  const entries = [
    ["embedding", typeValue(recipe.embedding)],
    ["backbone", typeValue(recipe.backbone)],
    ["fusion", typeValue(recipe.fusion)],
    ["predictionHead", typeValue(recipe.predictionHead)],
    ["loss", typeValue(recordValue(recipe.trainingStrategy).loss)],
    ["optimizer", typeValue(recordValue(recipe.trainingStrategy).optimizer)],
    ["scheduler", typeValue(recordValue(recipe.trainingStrategy).scheduler)],
  ] as const
  for (const [key, value] of entries) {
    if (value !== undefined) summary[key] = value
  }
  return summary
}

function runCandidateMemorySummary(
  candidate: ResearchCandidate | undefined,
  run: ResearchRun,
  extra: Record<string, unknown>,
) {
  const summary: Record<string, unknown> = {
    ...(candidate === undefined ? {} : { candidateID: candidate.id }),
    runID: run.id,
    stage: run.stage,
    ...extra,
  }
  if (candidate !== undefined) {
    const recipeID = candidateRecipeID(candidate.candidateSpec)
    if (recipeID !== undefined) summary.recipeID = recipeID
    summary.candidateSpec = candidate.candidateSpec
    const actions = candidateActionSummary(candidate.candidateSpec)
    if (Object.keys(actions).length > 0) summary.candidateActions = actions
  }
  return summary as JsonRecord
}

function candidateUsesNativeDomainAction(candidateSpec: ResearchCandidate["candidateSpec"]) {
  const recipe = candidateSpec as Record<string, unknown>
  const preprocessing = recordValue(recipe.preprocessing).actions
  const preprocessingActions = Array.isArray(preprocessing) ? preprocessing : []
  const hasNativePreprocessing = preprocessingActions.some((action) => {
    const type = typeValue(action)
    return type !== undefined && type !== "none"
  })
  const embedding = typeValue(recipe.embedding)
  const backbone = typeValue(recipe.backbone)
  const fusion = typeValue(recipe.fusion)
  const head = typeValue(recipe.predictionHead)
  const training = recordValue(recipe.trainingStrategy)
  const loss = typeValue(recordValue(training.loss))
  const scheduler = typeValue(recordValue(training.scheduler))

  return (
    hasNativePreprocessing ||
    (embedding !== undefined && !["none", "patch"].includes(embedding)) ||
    (backbone !== undefined && !["linear", "mlp", "transformer"].includes(backbone)) ||
    (fusion !== undefined && fusion !== "temporal") ||
    (head !== undefined && head !== "linear") ||
    (loss !== undefined && loss !== "mse") ||
    (scheduler !== undefined && scheduler !== "none")
  )
}

function stageRequiresDomainActionApproval(stage: ResearchRun["stage"]) {
  return stage === "low_fidelity" || stage === "full" || stage === "ref_test" || stage === "blind_test"
}

function taskRequiresStagePromotion(task: ResearchTask) {
  return recordValue(recordValue(task.budget).governance).requireStagePromotion === true
}

function taskRequiresShadowHoldout(task: ResearchTask) {
  const governance = recordValue(recordValue(task.budget).governance)
  return governance.requireShadowHoldout === true || governance.requireBlindHoldout === true
}

function promotionQueryLimit(task: ResearchTask, stage: ResearchRun["stage"]) {
  const governance = recordValue(recordValue(task.budget).governance)
  const value =
    stage === "blind_test"
      ? governance.blindTestQueryLimit
      : (governance.refTestQueryLimit ?? governance.referenceTestQueryLimit ?? governance.blindTestQueryLimit)
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

function predecessorStage(stage: ResearchRun["stage"]): ResearchRun["stage"] | undefined {
  if (stage === "low_fidelity") return "smoke"
  if (stage === "full") return "low_fidelity"
  if (stage === "ref_test") return "full"
  if (stage === "blind_test") return "ref_test"
  return undefined
}

function assertCandidateApproved(taskID: ResearchTaskID, candidate: ResearchCandidate) {
  if (candidate.approvalStatus === "approved" || candidate.approvalStatus === "auto_approved") return
  throw new ApprovalRequiredError({
    taskID,
    candidateID: candidate.id,
    kind: "candidate",
  })
}

function isBetterMetric(direction: "minimize" | "maximize", next: number, current: number) {
  return direction === "minimize" ? next < current : next > current
}

function isMeaningfulMetricImprovement(
  direction: "minimize" | "maximize",
  next: number,
  current: number,
  minRelativeImprovement: number,
) {
  if (!isBetterMetric(direction, next, current)) return false
  if (minRelativeImprovement <= 0) return true
  const delta = Math.abs(next - current)
  return delta / Math.max(Math.abs(current), 1e-12) >= minRelativeImprovement
}

function autonomousLoopMaxIterations(inputValue: unknown, task: ResearchTask) {
  const requested = integerPolicyValue(inputValue)
  if (requested !== undefined) return Math.max(1, Math.min(requested, 50))
  const budgetMaxRuns = maxRunsLimit(task.budget)
  return Math.max(1, Math.min(Math.max(budgetMaxRuns ?? 10, 10), 50))
}

function artifactDirsFromRecords(records: Record<string, unknown>[]) {
  return records
    .map((record) => record.artifact_dir)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
}

function jsonBlock(value: unknown) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``
}

function zodValidationIssues(error: z.ZodError): DomainValidationIssue[] {
  return error.issues.map((item) => issue(item.path.length ? item.path.join(".") : "$", item.message))
}

function normalizeTaskSpec(input: Pick<CreateTaskInput, "domainID" | "mode" | "interactionMode" | "taskSpec">) {
  const taskSpec =
    input.interactionMode === undefined
      ? input.taskSpec
      : {
          ...input.taskSpec,
          metadata: {
            ...(input.taskSpec.metadata && typeof input.taskSpec.metadata === "object" && !Array.isArray(input.taskSpec.metadata)
              ? (input.taskSpec.metadata as Record<string, unknown>)
              : {}),
            interactionMode: input.interactionMode,
          },
        }
  try {
    return DomainRegistry.createTaskSpec(input.domainID, taskSpec)
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new TaskSpecValidationError({
        domainID: input.domainID,
        issues: zodValidationIssues(error),
      })
    }
    throw error
  }
}

function validatedCandidateSpec(task: ResearchTask, input: CreateCandidateInput) {
  const issues: DomainValidationIssue[] = []
  if (input.domainID !== task.domainID) {
    issues.push(issue("domainID", `candidate domainID=${input.domainID} must match task domainID=${task.domainID}`))
  }

  const validation =
    input.domainID === task.domainID
      ? DomainRegistry.validateCandidate(task.domainID, {
          taskSpec: task.taskSpec,
          candidateSpec: input.candidateSpec,
        })
      : undefined
  if (validation) issues.push(...validation.issues)

  if (issues.some((item) => item.severity === "error")) {
    throw new CandidateValidationError({
      taskID: task.id,
      domainID: task.domainID,
      issues,
    })
  }

  return validation?.normalizedCandidateSpec ?? input.candidateSpec
}

interface CandidateRunMetricPoint {
  readonly candidateID: ResearchCandidateID
  readonly recipeID?: string
  readonly runID: ResearchRunID
  readonly stage: ResearchRun["stage"]
  readonly metric: number
  readonly resourceCost?: number
  readonly paramsM?: number
  readonly latencyMs?: number
  readonly codeDeltaLoc?: number
  readonly seed?: string | number
}

interface CandidateUtilityParts {
  readonly accuracyGain: number
  readonly modelSizePenalty: number
  readonly latencyPenalty: number
  readonly variancePenalty: number
  readonly codeComplexityPenalty: number
}

interface CandidateMetricSummary {
  readonly candidateID: ResearchCandidateID
  readonly recipeID?: string
  readonly runCount: number
  readonly seedCount: number
  readonly seeds: readonly (string | number)[]
  readonly metricMean: number
  readonly metricStd: number
  readonly metricCI95HalfWidth?: number
  readonly metricBest: number
  readonly metricWorst: number
  readonly bestRunID: ResearchRunID
  readonly resourceCostMean?: number
  readonly paramsMMean?: number
  readonly latencyMsMean?: number
  readonly codeDeltaLocMean?: number
  readonly utilityScore?: number
  readonly utilityParts?: CandidateUtilityParts
  readonly runs: readonly CandidateRunMetricPoint[]
}

interface ExperimentAnalysis {
  readonly primaryMetricName: string
  readonly direction: "minimize" | "maximize"
  readonly evaluatedRunCount: number
  readonly summaries: readonly CandidateMetricSummary[]
  readonly utilityRanking: readonly CandidateMetricSummary[]
  readonly paretoFrontier: readonly CandidateMetricSummary[]
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function runResourceCost(run: ResearchRun) {
  const usage = run.resourceUsage as Record<string, unknown>
  for (const key of [
    "wallClockSec",
    "wallClockSeconds",
    "durationSec",
    "runtimeSec",
    "runtimeSeconds",
    "elapsedSec",
    "timeSec",
    "trainSeconds",
    "gpuSeconds",
  ]) {
    const value = finiteNumber(usage[key])
    if (value !== undefined) return value
  }
  if (run.timeStarted !== undefined && run.timeFinished !== undefined && run.timeFinished >= run.timeStarted) {
    return (run.timeFinished - run.timeStarted) / 1000
  }
  return undefined
}

function runNumericObservation(run: ResearchRun, keys: readonly string[]) {
  const usage = run.resourceUsage as Record<string, unknown>
  const metrics = run.metrics as Record<string, unknown>
  for (const source of [usage, metrics]) {
    for (const key of keys) {
      const value = finiteNumber(source[key])
      if (value !== undefined) return value
    }
  }
  return undefined
}

function runParamsM(run: ResearchRun) {
  const paramsM = runNumericObservation(run, ["params_M", "paramsM", "num_params_M", "numParamsM"])
  if (paramsM !== undefined) return paramsM
  const params = runNumericObservation(run, ["params", "numParams", "parameterCount"])
  return params === undefined ? undefined : params / 1_000_000
}

function runLatencyMs(run: ResearchRun) {
  return runNumericObservation(run, ["latency_ms", "latencyMs", "avgLatencyMs", "inferenceLatencyMs"])
}

function runCodeDeltaLoc(run: ResearchRun) {
  return runNumericObservation(run, ["delta_loc", "deltaLoc", "codeDeltaLoc", "locDelta"])
}

function runSeed(run: ResearchRun) {
  const usage = run.resourceUsage as Record<string, unknown>
  const metrics = run.metrics as Record<string, unknown>
  for (const source of [usage, metrics]) {
    for (const key of ["seed", "randomSeed", "modelSeed", "dataSeed"]) {
      const value = source[key]
      if (typeof value === "string" || typeof value === "number") return value
    }
  }
  return undefined
}

function mean(values: readonly number[]) {
  return values.reduce((total, value) => total + value, 0) / values.length
}

function standardDeviation(values: readonly number[], average: number) {
  return Math.sqrt(values.reduce((total, value) => total + (value - average) ** 2, 0) / values.length)
}

function uniqueSeeds(points: readonly CandidateRunMetricPoint[]) {
  return [...new Set(points.map((point) => point.seed).filter((seed): seed is string | number => seed !== undefined))]
}

function summarizeCandidateMetrics(input: {
  readonly points: readonly CandidateRunMetricPoint[]
  readonly direction: "minimize" | "maximize"
}) {
  const { points, direction } = input
  const metrics = points.map((point) => point.metric)
  const metricMean = mean(metrics)
  const metricStd = standardDeviation(metrics, metricMean)
  const metricCI95HalfWidth = points.length > 1 ? (1.96 * metricStd) / Math.sqrt(points.length) : undefined
  const metricBest = direction === "minimize" ? Math.min(...metrics) : Math.max(...metrics)
  const metricWorst = direction === "minimize" ? Math.max(...metrics) : Math.min(...metrics)
  const bestRun = points.find((point) => point.metric === metricBest) ?? points[0]!
  const resourceCosts = points
    .map((point) => point.resourceCost)
    .filter((value): value is number => value !== undefined)
  const params = points.map((point) => point.paramsM).filter((value): value is number => value !== undefined)
  const latencies = points.map((point) => point.latencyMs).filter((value): value is number => value !== undefined)
  const codeDeltaLoc = points.map((point) => point.codeDeltaLoc).filter((value): value is number => value !== undefined)
  const seeds = uniqueSeeds(points)
  return {
    candidateID: bestRun.candidateID,
    recipeID: bestRun.recipeID,
    runCount: points.length,
    seedCount: seeds.length,
    seeds,
    metricMean,
    metricStd,
    ...(metricCI95HalfWidth === undefined ? {} : { metricCI95HalfWidth }),
    metricBest,
    metricWorst,
    bestRunID: bestRun.runID,
    ...(resourceCosts.length === 0 ? {} : { resourceCostMean: mean(resourceCosts) }),
    ...(params.length === 0 ? {} : { paramsMMean: mean(params) }),
    ...(latencies.length === 0 ? {} : { latencyMsMean: mean(latencies) }),
    ...(codeDeltaLoc.length === 0 ? {} : { codeDeltaLocMean: mean(codeDeltaLoc) }),
    runs: points,
  } satisfies CandidateMetricSummary
}

function utilityScore(input: {
  readonly direction: "minimize" | "maximize"
  readonly reference: CandidateMetricSummary
  readonly candidate: CandidateMetricSummary
}) {
  const { direction, reference, candidate } = input
  const metricDelta =
    direction === "minimize"
      ? reference.metricMean - candidate.metricMean
      : candidate.metricMean - reference.metricMean
  const accuracyGain = Math.max(0, metricDelta) / 0.01
  const modelSizePenalty =
    reference.paramsMMean === undefined || candidate.paramsMMean === undefined
      ? 0
      : Math.max(0, candidate.paramsMMean - reference.paramsMMean)
  const latencyPenalty =
    reference.latencyMsMean === undefined || candidate.latencyMsMean === undefined
      ? 0
      : Math.max(0, candidate.latencyMsMean - reference.latencyMsMean) / 10
  const variancePenalty = candidate.metricStd / 0.005
  const codeComplexityPenalty = Math.max(0, candidate.codeDeltaLocMean ?? 0) / 200
  const parts = {
    accuracyGain,
    modelSizePenalty,
    latencyPenalty,
    variancePenalty,
    codeComplexityPenalty,
  } satisfies CandidateUtilityParts
  return {
    score:
      1.0 * accuracyGain -
      0.2 * modelSizePenalty -
      0.2 * latencyPenalty -
      0.3 * variancePenalty -
      0.1 * codeComplexityPenalty,
    parts,
  }
}

function addUtilityScores(input: {
  readonly direction: "minimize" | "maximize"
  readonly summaries: readonly CandidateMetricSummary[]
  readonly champion?: ResearchChampion
}) {
  const reference =
    input.summaries.find((summary) => summary.candidateID === input.champion?.candidateID) ?? input.summaries[0]
  if (reference === undefined) return []
  return input.summaries.map((summary) => {
    const utility = utilityScore({ direction: input.direction, reference, candidate: summary })
    return {
      ...summary,
      utilityScore: utility.score,
      utilityParts: utility.parts,
    } satisfies CandidateMetricSummary
  })
}

function metricDominates(
  direction: "minimize" | "maximize",
  left: CandidateMetricSummary,
  right: CandidateMetricSummary,
) {
  return direction === "minimize"
    ? left.metricMean < right.metricMean
    : left.metricMean > right.metricMean
}

function paretoDominates(input: {
  readonly direction: "minimize" | "maximize"
  readonly costAware: boolean
  readonly left: CandidateMetricSummary
  readonly right: CandidateMetricSummary
}) {
  const { direction, costAware, left, right } = input
  if (!costAware) return metricDominates(direction, left, right)

  const leftCost = left.resourceCostMean ?? Number.POSITIVE_INFINITY
  const rightCost = right.resourceCostMean ?? Number.POSITIVE_INFINITY
  const metricNoWorse = direction === "minimize" ? left.metricMean <= right.metricMean : left.metricMean >= right.metricMean
  const metricBetter = direction === "minimize" ? left.metricMean < right.metricMean : left.metricMean > right.metricMean
  const costNoWorse = leftCost <= rightCost
  const costBetter = leftCost < rightCost
  return metricNoWorse && costNoWorse && (metricBetter || costBetter)
}

function sortMetricSummaries(direction: "minimize" | "maximize", items: readonly CandidateMetricSummary[]) {
  return [...items].sort((left, right) => {
    if (left.metricMean !== right.metricMean) {
      return direction === "minimize" ? left.metricMean - right.metricMean : right.metricMean - left.metricMean
    }
    return (left.resourceCostMean ?? Number.POSITIVE_INFINITY) - (right.resourceCostMean ?? Number.POSITIVE_INFINITY)
  })
}

function analyzeExperimentResults(input: {
  readonly task: ResearchTask
  readonly candidates: readonly ResearchCandidate[]
  readonly runs: readonly ResearchRun[]
  readonly champion?: ResearchChampion
}): ExperimentAnalysis {
  const primaryMetricName = objectiveMetricName(input.task.objective)
  const direction = objectiveDirection(input.task.objective)
  const candidatesByID = new Map(input.candidates.map((candidate) => [candidate.id, candidate]))
  const points = input.runs
    .filter((run): run is ResearchRun & { candidateID: ResearchCandidateID } => run.candidateID !== undefined)
    .flatMap((run): CandidateRunMetricPoint[] => {
      if (run.status !== "succeeded") return []
      const metric = metricValue(run.metrics, primaryMetricName)
      if (metric === undefined) return []
      const candidate = candidatesByID.get(run.candidateID)
      return [
        {
          candidateID: run.candidateID,
          recipeID: candidate === undefined ? undefined : candidateRecipeID(candidate.candidateSpec),
          runID: run.id,
          stage: run.stage,
          metric,
          resourceCost: runResourceCost(run),
          paramsM: runParamsM(run),
          latencyMs: runLatencyMs(run),
          codeDeltaLoc: runCodeDeltaLoc(run),
          seed: runSeed(run),
        },
      ]
    })

  const pointsByCandidate = new Map<ResearchCandidateID, CandidateRunMetricPoint[]>()
  for (const point of points) {
    const existing = pointsByCandidate.get(point.candidateID)
    if (existing) existing.push(point)
    else pointsByCandidate.set(point.candidateID, [point])
  }

  const metricSummaries = sortMetricSummaries(
    direction,
    [...pointsByCandidate.values()].map((candidatePoints) => summarizeCandidateMetrics({ points: candidatePoints, direction })),
  )
  const summaries = addUtilityScores({ direction, summaries: metricSummaries, champion: input.champion })
  const utilityRanking = [...summaries].sort(
    (left, right) => (right.utilityScore ?? Number.NEGATIVE_INFINITY) - (left.utilityScore ?? Number.NEGATIVE_INFINITY),
  )
  const costAware = summaries.some((summary) => summary.resourceCostMean !== undefined)
  const paretoFrontier = summaries.filter(
    (summary) =>
      !summaries.some(
        (other) =>
          other.candidateID !== summary.candidateID &&
          paretoDominates({
            direction,
            costAware,
            left: other,
            right: summary,
          }),
      ),
  )

  return {
    primaryMetricName,
    direction,
    evaluatedRunCount: points.length,
    summaries,
    utilityRanking,
    paretoFrontier: sortMetricSummaries(direction, paretoFrontier),
  }
}

function formatMetricValue(value: unknown) {
  if (typeof value !== "number") return JSON.stringify(value)
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)))
}

function formatUncertaintyValue(value: number) {
  return String(Number(value.toPrecision(3)))
}

function renderExperimentAnalysisMarkdown(analysis: ExperimentAnalysis) {
  if (analysis.evaluatedRunCount === 0) return ""
  const lines = [
    "## Experiment Analysis",
    "",
    `- Primary metric: ${analysis.primaryMetricName}`,
    `- Direction: ${analysis.direction}`,
    `- Evaluated runs: ${analysis.evaluatedRunCount}`,
    "",
    "### Multi-seed Summary",
    "",
  ]
  const multiSeed = analysis.summaries.filter((summary) => summary.runCount > 1)
  if (multiSeed.length === 0) {
    lines.push("- None")
  } else {
    for (const summary of multiSeed) {
      const seeds = summary.seeds.length === 0 ? "" : ` seeds=${summary.seeds.join(",")}`
      const recipeID = summary.recipeID === undefined ? "" : ` recipe=${summary.recipeID}`
      const ci95 =
        summary.metricCI95HalfWidth === undefined ? "" : ` ci95=${formatUncertaintyValue(summary.metricCI95HalfWidth)}`
      lines.push(
        `- ${summary.candidateID}: n=${summary.runCount} ${analysis.primaryMetricName} mean=${formatMetricValue(summary.metricMean)} std=${formatMetricValue(summary.metricStd)}${ci95} best=${formatMetricValue(summary.metricBest)} worst=${formatMetricValue(summary.metricWorst)}${seeds}${recipeID}`,
      )
    }
  }

  lines.push("", "### Utility Ranking", "")
  if (analysis.utilityRanking.length === 0) {
    lines.push("- None")
  } else {
    for (const summary of analysis.utilityRanking) {
      const recipeID = summary.recipeID === undefined ? "" : ` recipe=${summary.recipeID}`
      const parts = summary.utilityParts
      const details =
        parts === undefined
          ? ""
          : ` accuracy_gain=${formatMetricValue(parts.accuracyGain)} size_penalty=${formatMetricValue(parts.modelSizePenalty)} latency_penalty=${formatMetricValue(parts.latencyPenalty)} variance_penalty=${formatMetricValue(parts.variancePenalty)} code_penalty=${formatMetricValue(parts.codeComplexityPenalty)}`
      lines.push(
        `- ${summary.candidateID}: utility=${formatMetricValue(summary.utilityScore)} ${analysis.primaryMetricName}=${formatMetricValue(summary.metricMean)}${details}${recipeID}`,
      )
    }
  }

  lines.push("", "### Pareto Frontier", "")
  if (analysis.paretoFrontier.length === 0) {
    lines.push("- None")
  } else {
    for (const summary of analysis.paretoFrontier) {
      const cost = summary.resourceCostMean === undefined ? "" : ` cost=${formatMetricValue(summary.resourceCostMean)}s`
      const recipeID = summary.recipeID === undefined ? "" : ` recipe=${summary.recipeID}`
      lines.push(
        `- ${summary.candidateID}: ${analysis.primaryMetricName}=${formatMetricValue(summary.metricMean)}${cost} n=${summary.runCount} bestRun=${summary.bestRunID}${recipeID}`,
      )
    }
  }

  return `${lines.join("\n")}\n`
}

function candidateLineageStats(candidates: readonly ResearchCandidate[]) {
  const roots = candidates.filter((candidate) => candidate.parentCandidateID === undefined)
  const edges = candidates.filter((candidate) => candidate.parentCandidateID !== undefined)
  return { rootCount: roots.length, edgeCount: edges.length, roots, edges }
}

function renderCandidateLineageMarkdown(candidates: readonly ResearchCandidate[]) {
  const lineage = candidateLineageStats(candidates)
  if (candidates.length === 0) return ""
  const lines = ["## Candidate Lineage", ""]
  if (lineage.roots.length === 0) {
    lines.push("- Roots: none")
  } else {
    lines.push(`- Roots: ${lineage.roots.map((candidate) => candidate.id).join(", ")}`)
  }
  if (lineage.edges.length === 0) {
    lines.push("- Edges: none")
  } else {
    lines.push("", "### Edges", "")
    for (const candidate of lineage.edges) {
      const recipeID = candidateRecipeID(candidate.candidateSpec)
      lines.push(
        `- ${candidate.parentCandidateID} -> ${candidate.id}${recipeID === undefined ? "" : ` recipe=${recipeID}`}`,
      )
    }
  }
  return `${lines.join("\n")}\n`
}

function filePathFromURI(uri: string) {
  return uri.startsWith("file://") ? uri.slice("file://".length) : undefined
}

function renderResearchReportMarkdown(input: {
  readonly task: ResearchTask
  readonly candidates: ResearchCandidate[]
  readonly runs: ResearchRun[]
  readonly approvals: ResearchApproval[]
  readonly artifacts: ResearchArtifact[]
  readonly memory: ResearchMemory[]
  readonly champion?: ResearchChampion
}) {
  const { task, candidates, runs, approvals, artifacts, memory, champion } = input
  const lines: string[] = [
    `# ${task.title}`,
    "",
    "## Task",
    "",
    `- Task ID: ${task.id}`,
    `- Domain: ${task.domainID}`,
    `- Mode: ${task.mode}`,
    `- Status: ${task.status}`,
    `- Created: ${new Date(task.time.created).toISOString()}`,
    `- Updated: ${new Date(task.time.updated).toISOString()}`,
    "",
    "### Objective",
    "",
    jsonBlock(task.objective),
    "",
    "### Budget",
    "",
    jsonBlock(task.budget),
    "",
    "### Task Spec",
    "",
    jsonBlock(task.taskSpec),
    "",
    "## Champion",
    "",
  ]

  if (champion) {
    const refTestRun = runs.find(
      (r) => r.candidateID === champion.candidateID && r.stage === "ref_test" && r.status === "succeeded",
    )
    lines.push(
      `- Candidate ID: ${champion.candidateID}`,
      `- Run ID: ${champion.runID}`,
      `- Primary metric (val_avg_mse): ${formatMetricValue(champion.primaryMetric)}`,
      `- Utility: ${formatMetricValue(champion.utility)}`,
      `- Accepted at: ${new Date(champion.acceptedAt).toISOString()}`,
    )
    if (refTestRun !== undefined) {
      const m = refTestRun.metrics as Record<string, unknown>
      lines.push("", "### Reference Test Results", "")
      lines.push(`- Run ID: ${refTestRun.id}`)
      for (const key of Object.keys(m).sort()) {
        if (key.startsWith("ref_test_") && typeof m[key] === "number") {
          lines.push(`- ${key}: ${formatMetricValue(m[key] as number)}`)
        }
      }
    }
  } else {
    lines.push("- None")
  }

  lines.push("", "## Candidates", "")
  if (candidates.length === 0) {
    lines.push("- None")
  } else {
    for (const candidate of candidates) {
      lines.push(
        `### ${candidate.id}`,
        "",
        `- Parent candidate ID: ${candidate.parentCandidateID ?? "-"}`,
        `- Approval status: ${candidate.approvalStatus}`,
        `- Risk level: ${candidate.riskLevel}`,
        `- Generated by: ${candidate.generatedBy}`,
        `- Rationale: ${candidate.rationale}`,
        "",
        jsonBlock(candidate.candidateSpec),
        "",
      )
    }
  }

  lines.push("## Runs", "")
  if (runs.length === 0) {
    lines.push("- None")
  } else {
    for (const run of runs) {
      lines.push(
        `### ${run.id}`,
        "",
        `- Candidate ID: ${run.candidateID}`,
        `- Stage: ${run.stage}`,
        `- Status: ${run.status}`,
        `- Metrics: ${
          Object.keys(run.metrics).length === 0
            ? "-"
            : Object.entries(run.metrics)
                .map(([key, value]) => `${key}=${formatMetricValue(value)}`)
                .join(", ")
        }`,
        `- Artifacts: ${run.artifactRefs.length === 0 ? "-" : run.artifactRefs.join(", ")}`,
        "",
      )
    }
  }

  lines.push("## Approvals", "")
  if (approvals.length === 0) {
    lines.push("- None")
  } else {
    for (const approval of approvals) {
      lines.push(
        `- ${approval.id}: ${approval.status} ${approval.kind}${approval.candidateID ? ` for ${approval.candidateID}` : ""} - ${approval.reason}`,
      )
    }
  }

  lines.push("", "## Memory", "")
  if (memory.length === 0) {
    lines.push("- None")
  } else {
    for (const item of memory) {
      lines.push(`- ${item.outcome}: ${item.lesson}`)
    }
  }

  lines.push("", "## Artifacts", "")
  if (artifacts.length === 0) {
    lines.push("- None")
  } else {
    for (const artifact of artifacts) {
      lines.push(`- ${artifact.kind}: ${artifact.uri}`)
    }
  }

  return `${lines.join("\n")}\n`
}

type DatasetAnalysisReport = {
  readonly kind: string
  readonly filename: string
  readonly role: string
  readonly content: string
  readonly metadata: JsonRecord
}

type DatasetAnalysisPlot = {
  readonly kind: "dataset_analysis_plot_png"
  readonly filename: string
  readonly relativePath: string
  readonly role: string
  readonly data: Uint8Array
  readonly metadata: JsonRecord
}

type DatasetSeriesMatrix = {
  readonly columns: readonly string[]
  readonly values: readonly (readonly number[])[]
}

type DatasetStatisticalAnalysis = {
  readonly stationarity: {
    readonly adfStatistic?: number
    readonly adfStationary?: boolean
    readonly kpssStatistic?: number
    readonly kpssStationary?: boolean
  }
  readonly acf: {
    readonly topLag?: number
    readonly topCorrelation?: number
    readonly pacfTopLag?: number
    readonly pacfTopCorrelation?: number
  }
  readonly decomposition: {
    readonly period?: number
    readonly trendVarianceShare?: number
    readonly seasonalVarianceShare?: number
    readonly residualVarianceShare?: number
  }
  readonly frequency: {
    readonly dominantPeriod?: number
    readonly dominantPowerShare?: number
  }
  readonly changepoint: {
    readonly index?: number
    readonly score?: number
    readonly severity?: string
  }
  readonly crossLag: {
    readonly source?: string
    readonly target?: string
    readonly lag?: number
    readonly correlation?: number
  }
}

type DatasetAnalysisContext = {
  readonly statistics: DatasetStatisticalAnalysis
  readonly plotRefs: readonly DatasetAnalysisPlot[]
}

function markdownValue(value: unknown) {
  if (typeof value === "number") return formatMetricValue(value)
  if (typeof value === "string" && value.length > 0) return value
  if (typeof value === "boolean") return value ? "true" : "false"
  return "-"
}

function numericProfileValue(profile: Record<string, unknown>, key: string) {
  const value = profile[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function dataAnalysisSignal(value: number | undefined, threshold: number, active: string, inactive: string) {
  return value !== undefined && value >= threshold ? active : inactive
}

function roundAnalysisValue(value: number | undefined) {
  return value === undefined || !Number.isFinite(value) ? undefined : Number(value.toFixed(6))
}

function csvCells(line: string) {
  const cells: string[] = []
  let current = ""
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"'
        index++
      } else {
        quoted = !quoted
      }
      continue
    }
    if (char === "," && !quoted) {
      cells.push(current)
      current = ""
      continue
    }
    current += char
  }
  cells.push(current)
  return cells
}

function taskDatasetSpec(task: ResearchTask) {
  const taskSpec = recordValue(task.taskSpec)
  return recordValue(taskSpec.dataset)
}

function datasetTargetColumns(task: ResearchTask, header: readonly string[]) {
  const dataset = taskDatasetSpec(task)
  const targetCols = Array.isArray(dataset.targetCols)
    ? dataset.targetCols.filter((item): item is string => typeof item === "string" && header.includes(item))
    : []
  if (targetCols.length > 0) return targetCols
  return header.slice(1)
}

async function loadDatasetSeriesMatrix(task: ResearchTask): Promise<DatasetSeriesMatrix | undefined> {
  const dataset = taskDatasetSpec(task)
  if (typeof dataset.path !== "string" || dataset.path.length === 0) return undefined
  const datasetPath = path.isAbsolute(dataset.path) ? dataset.path : path.join(Instance.directory, dataset.path)
  if (!existsSync(datasetPath)) return undefined
  const text = await readFile(datasetPath, "utf8")
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length < 3) return undefined
  const header = csvCells(lines[0]!)
  const columns = datasetTargetColumns(task, header)
  const columnIndexes = columns.map((column) => header.indexOf(column))
  if (columns.length === 0 || columnIndexes.some((index) => index < 0)) return undefined
  const values = lines.slice(1).map((line) => {
    const row = csvCells(line)
    return columnIndexes.map((columnIndex) => {
      const parsed = Number(row[columnIndex])
      return Number.isFinite(parsed) ? parsed : Number.NaN
    })
  })
  return { columns, values }
}

function finiteSeries(values: readonly number[]) {
  return values.filter((value) => Number.isFinite(value))
}

function finiteMean(values: readonly number[]) {
  const finite = finiteSeries(values)
  if (finite.length === 0) return undefined
  return finite.reduce((sum, value) => sum + value, 0) / finite.length
}

function variance(values: readonly number[]) {
  const finite = finiteSeries(values)
  const avg = finiteMean(finite)
  if (avg === undefined || finite.length < 2) return undefined
  return finite.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (finite.length - 1)
}

function matrixColumn(matrix: DatasetSeriesMatrix, columnIndex: number) {
  return matrix.values.map((row) => row[columnIndex] ?? Number.NaN)
}

function aggregateSeries(matrix: DatasetSeriesMatrix) {
  return matrix.values.map((row) => {
    const finite = finiteSeries(row)
    return finite.length === 0 ? Number.NaN : finite.reduce((sum, value) => sum + value, 0) / finite.length
  })
}

function correlationAtLag(left: readonly number[], right: readonly number[], lag: number) {
  const xs: number[] = []
  const ys: number[] = []
  const start = Math.max(0, -lag)
  const end = Math.min(left.length, right.length - lag)
  for (let index = start; index < end; index++) {
    const x = left[index]
    const y = right[index + lag]
    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) continue
    xs.push(x)
    ys.push(y)
  }
  if (xs.length < 3) return undefined
  const xMean = finiteMean(xs)
  const yMean = finiteMean(ys)
  if (xMean === undefined || yMean === undefined) return undefined
  let numerator = 0
  let xDenom = 0
  let yDenom = 0
  for (let index = 0; index < xs.length; index++) {
    const dx = xs[index]! - xMean
    const dy = ys[index]! - yMean
    numerator += dx * dy
    xDenom += dx * dx
    yDenom += dy * dy
  }
  const denom = Math.sqrt(xDenom * yDenom)
  return denom === 0 ? undefined : numerator / denom
}

function averageAutocorrelation(matrix: DatasetSeriesMatrix, lag: number) {
  const correlations = matrix.columns
    .map((_, index) => correlationAtLag(matrixColumn(matrix, index), matrixColumn(matrix, index), lag))
    .filter((value): value is number => value !== undefined && Number.isFinite(value))
  if (correlations.length === 0) return undefined
  return correlations.reduce((sum, value) => sum + value, 0) / correlations.length
}

function topLag(values: readonly { lag: number; value: number }[]) {
  return values.toSorted((left, right) => Math.abs(right.value) - Math.abs(left.value))[0]
}

function stationarityAnalysis(matrix: DatasetSeriesMatrix, profile: Record<string, unknown>) {
  const series = finiteSeries(aggregateSeries(matrix))
  const avg = finiteMean(series)
  const seriesVariance = variance(series)
  let kpssStatistic: number | undefined
  if (avg !== undefined && seriesVariance !== undefined && seriesVariance > 0 && series.length > 2) {
    let cumulative = 0
    const cumulativeSquares = series.reduce((sum, value) => {
      cumulative += value - avg
      return sum + cumulative * cumulative
    }, 0)
    kpssStatistic = cumulativeSquares / (series.length * series.length * seriesVariance)
  }
  return {
    adfStatistic: roundAnalysisValue(numericProfileValue(profile, "adfStatistic")),
    adfStationary: typeof profile.adfStationary === "boolean" ? profile.adfStationary : undefined,
    kpssStatistic: roundAnalysisValue(kpssStatistic),
    kpssStationary: kpssStatistic === undefined ? undefined : kpssStatistic < 0.463,
  }
}

function acfPacfAnalysis(matrix: DatasetSeriesMatrix, maxLag: number) {
  const acfValues = Array.from({ length: maxLag }, (_, index) => {
    const lag = index + 1
    return { lag, value: averageAutocorrelation(matrix, lag) ?? 0 }
  })
  const pacfValues = acfValues.map((item, index) => ({
    lag: item.lag,
    value: index === 0 ? item.value : item.value - acfValues[index - 1]!.value * acfValues[0]!.value,
  }))
  const acfTop = topLag(acfValues)
  const pacfTop = topLag(pacfValues)
  return {
    topLag: acfTop?.lag,
    topCorrelation: roundAnalysisValue(acfTop?.value),
    pacfTopLag: pacfTop?.lag,
    pacfTopCorrelation: roundAnalysisValue(pacfTop?.value),
  }
}

function frequencyAnalysis(series: readonly number[]) {
  const values = finiteSeries(series)
  const avg = finiteMean(values) ?? 0
  const centered = values.map((value) => value - avg)
  if (centered.length < 4) return {}
  const powers: Array<{ period: number; power: number }> = []
  for (let k = 1; k <= Math.floor(centered.length / 2); k++) {
    let real = 0
    let imag = 0
    for (let index = 0; index < centered.length; index++) {
      const angle = (2 * Math.PI * k * index) / centered.length
      real += centered[index]! * Math.cos(angle)
      imag -= centered[index]! * Math.sin(angle)
    }
    powers.push({ period: centered.length / k, power: real * real + imag * imag })
  }
  const totalPower = powers.reduce((sum, item) => sum + item.power, 0)
  const best = powers.toSorted((left, right) => right.power - left.power)[0]
  return {
    dominantPeriod: roundAnalysisValue(best?.period),
    dominantPowerShare: roundAnalysisValue(best && totalPower > 0 ? best.power / totalPower : undefined),
  }
}

function movingAverage(values: readonly number[], window: number) {
  const radius = Math.max(1, Math.floor(window / 2))
  return values.map((_, index) => {
    const slice = values.slice(Math.max(0, index - radius), Math.min(values.length, index + radius + 1))
    return finiteMean(slice) ?? values[index] ?? 0
  })
}

function decompositionAnalysis(series: readonly number[], period: number | undefined) {
  const values = finiteSeries(series)
  if (values.length < 4) return {}
  const resolvedPeriod = Math.max(2, Math.min(Math.floor(values.length / 2), Math.round(period ?? 12)))
  const trend = movingAverage(values, resolvedPeriod)
  const detrended = values.map((value, index) => value - trend[index]!)
  const seasonalMeans = Array.from({ length: resolvedPeriod }, (_, seasonalIndex) =>
    finiteMean(detrended.filter((_, index) => index % resolvedPeriod === seasonalIndex)) ?? 0,
  )
  const seasonal = detrended.map((_, index) => seasonalMeans[index % resolvedPeriod]!)
  const residual = values.map((value, index) => value - trend[index]! - seasonal[index]!)
  const totalVariance = variance(values) ?? 0
  const share = (part: readonly number[]) => (totalVariance > 0 ? (variance(part) ?? 0) / totalVariance : undefined)
  return {
    period: resolvedPeriod,
    trendVarianceShare: roundAnalysisValue(share(trend)),
    seasonalVarianceShare: roundAnalysisValue(share(seasonal)),
    residualVarianceShare: roundAnalysisValue(share(residual)),
  }
}

function changepointAnalysis(series: readonly number[]) {
  const values = finiteSeries(series)
  const std = Math.sqrt(variance(values) ?? 0)
  const minWindow = Math.max(6, Math.floor(values.length * 0.1))
  if (values.length < minWindow * 2 || std === 0) return {}
  let best: { index: number; score: number } | undefined
  for (let index = minWindow; index <= values.length - minWindow; index++) {
    const left = finiteMean(values.slice(0, index))
    const right = finiteMean(values.slice(index))
    if (left === undefined || right === undefined) continue
    const score = Math.abs(left - right) / std
    if (!best || score > best.score) best = { index, score }
  }
  return {
    index: best?.index,
    score: roundAnalysisValue(best?.score),
    severity: best === undefined ? undefined : best.score >= 1 ? "high" : best.score >= 0.5 ? "medium" : "low",
  }
}

function crossLagAnalysis(matrix: DatasetSeriesMatrix, maxLag: number) {
  let best: DatasetStatisticalAnalysis["crossLag"] = {}
  for (let leftIndex = 0; leftIndex < matrix.columns.length; leftIndex++) {
    for (let rightIndex = 0; rightIndex < matrix.columns.length; rightIndex++) {
      if (leftIndex === rightIndex) continue
      const left = matrixColumn(matrix, leftIndex)
      const right = matrixColumn(matrix, rightIndex)
      for (let lag = -maxLag; lag <= maxLag; lag++) {
        if (lag === 0) continue
        const correlation = correlationAtLag(left, right, lag)
        if (correlation === undefined) continue
        if (best.correlation === undefined || Math.abs(correlation) > Math.abs(best.correlation)) {
          best = {
            source: matrix.columns[leftIndex],
            target: matrix.columns[rightIndex],
            lag,
            correlation: roundAnalysisValue(correlation),
          }
        }
      }
    }
  }
  return best
}

function buildStatisticalAnalysis(matrix: DatasetSeriesMatrix | undefined, fingerprint: JsonRecord): DatasetStatisticalAnalysis {
  const profile = recordValue(recordValue(fingerprint).datasetProfile)
  if (!matrix) {
    return {
      stationarity: {
        adfStatistic: roundAnalysisValue(numericProfileValue(profile, "adfStatistic")),
        adfStationary: typeof profile.adfStationary === "boolean" ? profile.adfStationary : undefined,
      },
      acf: {
        topLag: typeof profile.acfMainPeriod === "number" ? profile.acfMainPeriod : undefined,
        topCorrelation: roundAnalysisValue(numericProfileValue(profile, "acfMainPeriodStrength")),
      },
      decomposition: {},
      frequency: {},
      changepoint: {},
      crossLag: {},
    }
  }
  const maxLag = Math.max(1, Math.min(40, Math.floor(matrix.values.length / 2)))
  const series = aggregateSeries(matrix)
  return {
    stationarity: stationarityAnalysis(matrix, profile),
    acf: acfPacfAnalysis(matrix, maxLag),
    decomposition: decompositionAnalysis(series, numericProfileValue(profile, "acfMainPeriod")),
    frequency: frequencyAnalysis(series),
    changepoint: changepointAnalysis(series),
    crossLag: crossLagAnalysis(matrix, Math.min(24, maxLag)),
  }
}

const pngSignature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])

function crc32(buffer: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array) {
  const typeBytes = Buffer.from(type, "ascii")
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crcInput = Buffer.concat([typeBytes, Buffer.from(data)])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(crcInput), 0)
  return Buffer.concat([length, typeBytes, Buffer.from(data), crc])
}

function simplePng(width: number, height: number, values: readonly number[], accent: [number, number, number]) {
  const pixels = Buffer.alloc((width * 3 + 1) * height, 255)
  const setPixel = (x: number, y: number, color: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const offset = y * (width * 3 + 1) + 1 + x * 3
    pixels[offset] = color[0]
    pixels[offset + 1] = color[1]
    pixels[offset + 2] = color[2]
  }
  for (let x = 28; x < width - 8; x++) setPixel(x, height - 24, [70, 70, 80])
  for (let y = 8; y < height - 24; y++) setPixel(28, y, [70, 70, 80])
  const finite = finiteSeries(values)
  const min = finite.length ? Math.min(...finite) : 0
  const max = finite.length ? Math.max(...finite) : 1
  const span = max - min || 1
  const chartWidth = width - 40
  const chartHeight = height - 36
  const samples = values.length > 0 ? values : [0]
  for (let index = 0; index < samples.length; index++) {
    const value = Number.isFinite(samples[index]!) ? samples[index]! : min
    const x = 30 + Math.floor((index / Math.max(1, samples.length - 1)) * (chartWidth - 1))
    const y = 8 + Math.floor((1 - (value - min) / span) * (chartHeight - 1))
    for (let dy = y; dy < height - 24; dy++) setPixel(x, dy, accent)
    setPixel(x, y, [20, 24, 32])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const compressed = deflateSync(pixels)
  return Buffer.concat([
    Buffer.from(pngSignature),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

function buildDatasetAnalysisPlots(
  matrix: DatasetSeriesMatrix | undefined,
  statistics: DatasetStatisticalAnalysis,
): DatasetAnalysisPlot[] {
  const series = matrix ? aggregateSeries(matrix) : [0]
  const acfValues = matrix
    ? Array.from({ length: Math.max(1, Math.min(24, Math.floor(matrix.values.length / 2))) }, (_, index) =>
        Math.abs(averageAutocorrelation(matrix, index + 1) ?? 0),
      )
    : [0]
  const decompositionValues = [
    statistics.decomposition.trendVarianceShare ?? 0,
    statistics.decomposition.seasonalVarianceShare ?? 0,
    statistics.decomposition.residualVarianceShare ?? 0,
  ]
  const crossLagValue = statistics.crossLag.correlation === undefined ? [0] : [Math.abs(statistics.crossLag.correlation)]
  const baseMetadata = { format: "png", role: "quantitative-data-analyst", phase: "data_analysis" } as JsonRecord
  return [
    {
      kind: "dataset_analysis_plot_png",
      filename: "time-series-overview.png",
      relativePath: "quantitative/plots/time-series-overview.png",
      role: "quantitative-data-analyst",
      data: simplePng(480, 240, series, [80, 140, 240]),
      metadata: { ...baseMetadata, plotType: "time_series_overview", title: "Time series overview" },
    },
    {
      kind: "dataset_analysis_plot_png",
      filename: "acf-pacf.png",
      relativePath: "quantitative/plots/acf-pacf.png",
      role: "quantitative-data-analyst",
      data: simplePng(480, 240, acfValues, [240, 150, 80]),
      metadata: { ...baseMetadata, plotType: "acf_pacf", title: "ACF/PACF diagnostics" },
    },
    {
      kind: "dataset_analysis_plot_png",
      filename: "stl-decomposition.png",
      relativePath: "quantitative/plots/stl-decomposition.png",
      role: "quantitative-data-analyst",
      data: simplePng(480, 240, decompositionValues, [110, 190, 120]),
      metadata: { ...baseMetadata, plotType: "stl_decomposition", title: "STL-style decomposition" },
    },
    {
      kind: "dataset_analysis_plot_png",
      filename: "cross-lag.png",
      relativePath: "quantitative/plots/cross-lag.png",
      role: "quantitative-data-analyst",
      data: simplePng(480, 240, crossLagValue, [190, 110, 220]),
      metadata: { ...baseMetadata, plotType: "cross_lag", title: "Cross-lag correlation" },
    },
  ]
}

async function buildDatasetAnalysisContext(task: ResearchTask, fingerprint: JsonRecord): Promise<DatasetAnalysisContext> {
  const matrix = await loadDatasetSeriesMatrix(task)
  const statistics = buildStatisticalAnalysis(matrix, fingerprint)
  return {
    statistics,
    plotRefs: buildDatasetAnalysisPlots(matrix, statistics),
  }
}

function renderDatasetQuantitativeAnalysis(task: ResearchTask, fingerprint: JsonRecord, context: DatasetAnalysisContext) {
  const profile = recordValue(recordValue(fingerprint).datasetProfile)
  const stats = context.statistics
  const rows = [
    ["Rows", profile.rowCount, "usable observations detected in the CSV profile"],
    ["Targets", profile.targetCount, "forecast target columns used by the task"],
    ["Missing rate", profile.missingRate, "fraction of missing numeric target cells"],
    ["Trend strength", profile.trendStrength, "mean absolute correlation with time index"],
    ["Seasonality strength", profile.seasonalityStrength, "best lag-correlation over common TSF lags"],
    ["Cross-variate correlation", profile.crossVarCorrelation, "mean absolute pairwise target correlation"],
    ["Distribution shift", profile.distributionShift, "normalized first-half vs second-half drift"],
    ["Outlier rate", profile.outlierRate, "IQR-based extreme-value share"],
    ["ACF main period", profile.acfMainPeriod, "dominant lag from average target autocorrelation"],
    ["ACF main period strength", profile.acfMainPeriodStrength, "mean autocorrelation strength at the dominant lag"],
    ["ADF statistic", profile.adfStatistic, "Augmented Dickey-Fuller style stationarity statistic"],
    ["ADF stationarity", profile.adfStationary, "whether the profile suggests stationarity at the default threshold"],
    ["Irregular interval ratio", profile.irregularIntervalRatio, "timestamp cadence instability"],
    ["Duplicate timestamp rate", profile.duplicateTimestampRate, "duplicate timestamp share"],
    ["KPSS statistic", stats.stationarity.kpssStatistic, "level-stationarity diagnostic; lower values support stationary residual behavior"],
    ["KPSS stationarity", stats.stationarity.kpssStationary, "whether the KPSS-style statistic remains below the default level threshold"],
    ["ACF top lag", stats.acf.topLag, "lag with strongest average autocorrelation across target columns"],
    ["ACF top correlation", stats.acf.topCorrelation, "strength of the strongest average autocorrelation lag"],
    ["PACF top lag", stats.acf.pacfTopLag, "lag with strongest approximate partial autocorrelation"],
    ["PACF top correlation", stats.acf.pacfTopCorrelation, "approximate partial autocorrelation strength at the selected lag"],
    ["Dominant frequency period", stats.frequency.dominantPeriod, "DFT-derived period with highest spectral power"],
    ["Dominant frequency power share", stats.frequency.dominantPowerShare, "share of spectral energy explained by the dominant period"],
    ["Change point", stats.changepoint.index, "index with largest normalized mean shift between prefix and suffix windows"],
    ["Change point score", stats.changepoint.score, "normalized change-point severity score"],
    ["Cross-lag", stats.crossLag.lag, "best non-zero lag between target columns"],
    ["Cross-lag correlation", stats.crossLag.correlation, "strongest absolute lead-lag correlation across target pairs"],
  ]
  const lines = [
    "# Quantitative Sub-Agent Data Analysis",
    "",
    "- Agent: quantitative-data-analyst",
    `- Task ID: ${task.id}`,
    `- Primary metric: ${markdownValue(recordValue(task.objective).primaryMetric)}`,
    `- Direction: ${markdownValue(recordValue(task.objective).direction)}`,
    "",
    "## Dataset Metrics",
    "",
    "| Metric | Value | Interpretation |",
    "| --- | ---: | --- |",
    ...rows.map(([label, value, meaning]) => `| ${label} | ${markdownValue(value)} | ${meaning} |`),
    "",
    "## Constraint Signals",
    "",
    `- Context length: ${markdownValue(recordValue(fingerprint).contextLength)}`,
    `- Max prediction length: ${markdownValue(recordValue(fingerprint).maxPredictionLength)}`,
    `- Horizon/context ratio: ${markdownValue(recordValue(fingerprint).horizonContextRatio)}`,
    `- Max params: ${markdownValue(recordValue(fingerprint).maxParams)}`,
    `- Max training seconds: ${markdownValue(recordValue(fingerprint).maxTrainingSeconds)}`,
    "",
    "## Statistical Tests",
    "",
    `- ADF statistic: ${markdownValue(stats.stationarity.adfStatistic)}; stationary=${markdownValue(stats.stationarity.adfStationary)}`,
    `- KPSS statistic: ${markdownValue(stats.stationarity.kpssStatistic)}; stationary=${markdownValue(stats.stationarity.kpssStationary)}`,
    `- PACF top lag: ${markdownValue(stats.acf.pacfTopLag)} (${markdownValue(stats.acf.pacfTopCorrelation)})`,
    "",
    "## STL-style decomposition",
    "",
    `- Period: ${markdownValue(stats.decomposition.period)}`,
    `- Trend variance share: ${markdownValue(stats.decomposition.trendVarianceShare)}`,
    `- Seasonal variance share: ${markdownValue(stats.decomposition.seasonalVarianceShare)}`,
    `- Residual variance share: ${markdownValue(stats.decomposition.residualVarianceShare)}`,
    "",
    "## Frequency and Change Diagnostics",
    "",
    `- Dominant frequency period: ${markdownValue(stats.frequency.dominantPeriod)} with power share ${markdownValue(stats.frequency.dominantPowerShare)}`,
    `- Change point: ${markdownValue(stats.changepoint.index)} score=${markdownValue(stats.changepoint.score)} severity=${markdownValue(stats.changepoint.severity)}`,
    `- Cross-lag: ${markdownValue(stats.crossLag.source)} -> ${markdownValue(stats.crossLag.target)} lag=${markdownValue(stats.crossLag.lag)} corr=${markdownValue(stats.crossLag.correlation)}`,
    "",
    "## Visualizations",
    "",
    ...context.plotRefs.map((plot) => `![${plot.metadata.title}](${plot.relativePath})`),
  ]
  return `${lines.join("\n")}\n`
}

function renderDatasetQualitativeAnalysis(
  task: ResearchTask,
  fingerprint: JsonRecord,
  context: DatasetAnalysisContext,
  llmGenerated?: string,
) {
  const profile = recordValue(recordValue(fingerprint).datasetProfile)
  const dataset = taskDatasetSpec(task)
  const biases = Array.isArray(recordValue(fingerprint).searchBiases)
    ? (recordValue(fingerprint).searchBiases as unknown[]).filter((item): item is string => typeof item === "string")
    : []
  const lines = [
    "# Qualitative Sub-Agent Data Analysis",
    "",
    "- Agent: qualitative-data-analyst",
    `- Task ID: ${task.id}`,
    "",
  ]
  if (llmGenerated && llmGenerated.trim().length > 0) {
    lines.push(llmGenerated.trim(), "")
  } else {
    const seasonality = numericProfileValue(profile, "seasonalityStrength")
    const trend = numericProfileValue(profile, "trendStrength")
    const crossVar = numericProfileValue(profile, "crossVarCorrelation")
    const shift = numericProfileValue(profile, "distributionShift")
    const missing = numericProfileValue(profile, "missingRate")
    lines.push(
      "## Reading",
      "",
      `- ${dataAnalysisSignal(seasonality, 0.4, "Seasonal structure is a strong prior for candidate design.", "Seasonality is not dominant from the profile.")}`,
      `- ${dataAnalysisSignal(trend, 0.2, "Trend is present and should be handled by baseline and residual designs.", "Trend is weak enough for simple baselines to remain useful.")}`,
      `- ${dataAnalysisSignal(crossVar, 0.5, "Cross-variate dependence is material; feature fusion or graph-style candidates are justified.", "Cross-variate dependence is limited; independent temporal candidates are acceptable.")}`,
      `- ${dataAnalysisSignal(shift, 0.5, "Distribution shift is visible; robust loss or reweighting should be considered.", "Distribution shift is not the dominant risk.")}`,
      `- ${missing !== undefined && missing > 0 ? "Missing values are present; candidate recipes should include missing-aware preprocessing." : "Missing values are not a primary concern in the profiled targets."}`,
      "",
      "## 领域解读",
      "",
      `- 字段语义: target=${Array.isArray(dataset.targetCols) ? dataset.targetCols.join(", ") : "-"}; loader=${markdownValue(dataset.loaderID)}.`,
      `- 业务机制: ${dataAnalysisSignal(seasonality, 0.4, "周期信号明显，可能对应生产节律、日历周期或批处理节奏。", "周期信号不强，业务解读应优先关注趋势和局部变化。")}`,
      `- 外部因素: ${dataAnalysisSignal(crossVar, 0.5, "多变量联动较强，外生变量、同步扰动或共享上游驱动值得纳入建模假设。", "变量间联动较弱，外部因素更可能体现在单变量局部事件中。")}`,
      `- 潜在事件: change_point=${markdownValue(context.statistics.changepoint.index)} severity=${markdownValue(context.statistics.changepoint.severity)}，需要人工核对该时间段是否存在口径、设备或环境变化。`,
      `- 风险: ${dataAnalysisSignal(shift, 0.5, "存在分布漂移，离线验证和线上表现可能不一致。", "分布漂移风险较低，但仍需保留 holdout 检查。")}`,
      `- 领域建模建议: ${context.statistics.crossLag.source ? `关注 ${context.statistics.crossLag.source}->${context.statistics.crossLag.target} 的 lag=${context.statistics.crossLag.lag} lead-lag 关系。` : "未发现稳定跨变量滞后关系，先使用简单 temporal baseline。"}`,
      "",
    )
  }
  lines.push("## Search Priors", "", biases.length === 0 ? "- No explicit search bias detected." : `- ${biases.join(", ")}`)
  return `${lines.join("\n")}\n`
}

function renderDatasetMainAnalysisSummary(task: ResearchTask, fingerprint: JsonRecord, context: DatasetAnalysisContext) {
  const profile = recordValue(recordValue(fingerprint).datasetProfile)
  const crossVar = numericProfileValue(profile, "crossVarCorrelation")
  const seasonality = numericProfileValue(profile, "seasonalityStrength")
  const shift = numericProfileValue(profile, "distributionShift")
  const missing = numericProfileValue(profile, "missingRate")
  const recommendation = [
    "Start from the existing linear and patch baselines to establish a low-cost floor.",
    crossVar !== undefined && crossVar >= 0.5
      ? "Prioritize at least one cross-variate candidate because the quantitative and qualitative sub-agents both flag cross-variate structure."
      : "Keep the first pass focused on independent temporal candidates because cross-variate evidence is limited.",
    seasonality !== undefined && seasonality >= 0.4
      ? `Include decomposition or frequency-aware variants; dominant period=${markdownValue(context.statistics.frequency.dominantPeriod)} and STL period=${markdownValue(context.statistics.decomposition.period)}.`
      : "Avoid over-indexing on frequency modules until run evidence supports them.",
    (shift !== undefined && shift >= 0.5) || (missing !== undefined && missing > 0)
      ? "Use robust loss or preprocessing in later candidates if the bridge runner supports it."
      : "Keep preprocessing minimal in the first autonomous pass.",
    context.statistics.changepoint.severity === "high"
      ? "Treat the detected change point as a validation risk and prefer robust losses or split-aware evaluation."
      : "No severe change point dominates the initial analysis.",
  ]
  const lines = [
    "# Main Agent Data Analysis Summary",
    "",
    "- Agent: main-data-analyst",
    `- Task ID: ${task.id}`,
    "",
    "## Inputs Reviewed",
    "",
    "- Quantitative sub-agent: numeric dataset profile, objective, horizon, and resource constraints.",
    "- Quantitative sub-agent: ADF/KPSS stationarity, ACF/PACF, STL-style decomposition, frequency, change-point, cross-lag, and plot artifacts.",
    "- Qualitative sub-agent: field semantics, business mechanisms, external factors, potential events, risk, and domain modeling advice.",
    "",
    "## Synthesis",
    "",
    ...recommendation.map((item) => `- ${item}`),
    "",
    "## Handoff To Model Search",
    "",
    "- Seed small baselines first.",
    "- Let autonomous iteration compare candidate utility against accuracy, resource cost, model size, and stability.",
    "- Stop when the configured target, plateau, crash, time, or run budget condition is reached.",
  ]
  return `${lines.join("\n")}\n`
}

function buildQualitativeSystemPrompt(): string {
  return [
    "You are the NeoResearch qualitative data analyst for time series forecasting.",
    "Language policy: 用中文写领域解读、业务机制、风险分析、建模建议；保留英文的技术术语、指标名和模块名。",
    "Task: Interpret the provided time series dataset statistics from a domain and business perspective.",
    "Output format: Return exactly two markdown sections as plain text (no code blocks, no JSON):",
    "## Reading",
    "(2-4 bullet points: key statistical patterns and their implications for model design)",
    "## 领域解读",
    "(4-6 bullet points: 字段语义、业务机制、外部因素、潜在事件、风险、领域建模建议 — one bullet per aspect)",
    "Do not include any other heading, section, or text outside these two sections.",
  ].join("\n")
}

function buildQualitativeUserPrompt(task: ResearchTask, fingerprint: JsonRecord, context: DatasetAnalysisContext): string {
  const profile = recordValue(recordValue(fingerprint).datasetProfile)
  const dataset = taskDatasetSpec(task)
  const biases = Array.isArray(fingerprint.searchBiases)
    ? (fingerprint.searchBiases as unknown[]).filter((item): item is string => typeof item === "string")
    : []
  return JSON.stringify(
    {
      task: {
        id: task.id,
        title: task.title,
        domainID: task.domainID,
        objective: task.objective,
        dataset: { targetCols: dataset.targetCols, loaderID: dataset.loaderID },
      },
      datasetProfile: {
        rowCount: profile.rowCount,
        targetCount: profile.targetCount,
        missingRate: profile.missingRate,
        trendStrength: profile.trendStrength,
        seasonalityStrength: profile.seasonalityStrength,
        crossVarCorrelation: profile.crossVarCorrelation,
        distributionShift: profile.distributionShift,
        outlierRate: profile.outlierRate,
        acfMainPeriod: profile.acfMainPeriod,
        adfStatistic: profile.adfStatistic,
        adfStationary: profile.adfStationary,
      },
      extendedStatistics: {
        kpssStatistic: context.statistics.stationarity.kpssStatistic,
        kpssStationary: context.statistics.stationarity.kpssStationary,
        acfTopLag: context.statistics.acf.topLag,
        pacfTopLag: context.statistics.acf.pacfTopLag,
        decompositionPeriod: context.statistics.decomposition.period,
        trendVarianceShare: context.statistics.decomposition.trendVarianceShare,
        seasonalVarianceShare: context.statistics.decomposition.seasonalVarianceShare,
        dominantFrequencyPeriod: context.statistics.frequency.dominantPeriod,
        dominantPowerShare: context.statistics.frequency.dominantPowerShare,
        changepointIndex: context.statistics.changepoint.index,
        changepointScore: context.statistics.changepoint.score,
        changepointSeverity: context.statistics.changepoint.severity,
        crossLagSource: context.statistics.crossLag.source,
        crossLagTarget: context.statistics.crossLag.target,
        crossLagLag: context.statistics.crossLag.lag,
        crossLagCorrelation: context.statistics.crossLag.correlation,
      },
      searchBiasesAlreadyDetected: biases,
      instruction:
        "Analyze the dataset characteristics and provide qualitative domain insights for guiding TSF model search.",
    },
    null,
    2,
  )
}

// Known opencode provider → OpenAI-compat base URL mapping for neo-cast LLM bridge.


async function generateLLMQualitativeAnalysis(
  task: ResearchTask,
  fingerprint: JsonRecord,
  context: DatasetAnalysisContext,
  workspaceRoot: string,
  onDelta?: (delta: string) => void,
): Promise<{ text: string; usage: import("./llm-proposal").LLMTokenUsage } | undefined> {
  try {
    const runtime = recordValue(recordValue(task.taskSpec).runtime)
    const neoCastProjectRoot = typeof runtime.neoCastProjectRoot === "string" ? runtime.neoCastProjectRoot : undefined
    const config = await resolveNeoCastLLMConfig({ workspaceRoot, neoCastProjectRoot })
    let apiKey = apiKeyFor(config)
    let effectiveConfig = config
    if (!apiKey) {
      // Fallback: read the key configured via the TUI "Configure API Key" dialog (opencode auth.json).
      const authEntry = await resolveApiKeyFromAuthJson()
      if (!authEntry) return undefined
      apiKey = authEntry.key
      const isAnthropicNative = !authEntry.baseURL
      effectiveConfig = {
        ...config,
        provider: isAnthropicNative ? "anthropic" : "openai-compatible",
        model: isAnthropicNative ? config.model : authEntry.model,
        ...(authEntry.baseURL ? { baseURL: authEntry.baseURL } : {}),
      }
    }
    const system = buildQualitativeSystemPrompt()
    const user = buildQualitativeUserPrompt(task, fingerprint, context)
    const llmPromise = onDelta
      ? requestNeoCastLLMStream({ ...effectiveConfig, maxTokens: 8192 }, apiKey, system, user, onDelta)
      : requestNeoCastLLM({ ...effectiveConfig, maxTokens: 8192 }, apiKey, system, user)
    const timeoutPromise = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 120_000))
    return await Promise.race([llmPromise, timeoutPromise])
  } catch {
    return undefined
  }
}

function buildHypoPlannerSystemPrompt(): string {
  return [
    "You are the NeoResearch HypoPlanner agent for time series forecasting (TSF) model search.",
    "Language policy: 用中文表达 statement、motivation、risk 等自然语言字段；保留 JSON 字段名、backbone 类型名、预处理类型名等技术术语的英文原文。",
    "Task: Given dataset analysis evidence, run history, and reflection memory, produce 3–6 testable research hypotheses to guide the next phase of model search.",
    "Output: exactly one JSON object: { \"hypotheses\": [...] }. No markdown fences. No prose outside JSON.",
    "Each hypothesis object must have these fields:",
    "  id: string (\"H1\", \"H2\", ...)",
    "  statement: string (一句话说明该假设的核心思想)",
    "  motivation: string[] (来自数据特征、历史结果或记忆的支持证据)",
    "  suggestedBackbones: string[] (subset of: linear | mlp | transformer | dlinear | tcn | nbeats | timesnet | rnn | ssm | mixer)",
    "  suggestedPreprocessing: string[] (subset of: none | instance_norm | series_decomposition | seasonal_differencing | missing_mask | sample_reweighting)",
    "  priority: \"high\" | \"medium\" | \"low\"",
    "  risk: string (主要风险或局限)",
    "  testable: true | false",
    "Rules:",
    "- Order hypotheses by priority (high first).",
    "- Each hypothesis must be distinct, concrete, and directly testable.",
    "- Do not repeat backbone/preprocessing combinations already confirmed as failures in memory.",
    "- The draftHypotheses field contains rule-derived starting points; you may refine, replace, or extend them.",
  ].join("\n")
}

function buildHypoPlannerUserPrompt(
  task: ResearchTask,
  dataAnalysis: DataAnalysisAgentResult,
  runs: readonly ResearchRun[],
  memory: readonly ResearchMemory[],
  draftHypotheses: readonly HypothesisObject[],
): string {
  const spec = recordValue(task.taskSpec)
  const profile = {
    ...recordValue(recordValue(recordValue(task.taskSpec).metadata).datasetProfile),
    ...recordValue(spec.datasetProfile),
  }
  const succeeded = runs.filter((r) => r.status === "succeeded")
  const bestMetric = succeeded
    .map((r) => (typeof r.metrics?.val_avg_mse === "number" ? r.metrics.val_avg_mse : undefined))
    .filter((v): v is number => v !== undefined)
    .sort((a, b) => a - b)[0]
  return JSON.stringify(
    {
      task: {
        id: task.id,
        title: task.title,
        objective: task.objective,
        budget: task.budget,
      },
      datasetProfile: profile,
      searchBiases: dataAnalysis.searchBiases,
      runSummary: {
        succeeded: runs.filter((r) => r.status === "succeeded").length,
        failed: runs.filter((r) => r.status === "failed").length,
        rejected: runs.filter((r) => r.status === "rejected").length,
        bestMetric: bestMetric ?? null,
      },
      memoryLessons: memory.slice(-8).map((m) => ({ outcome: m.outcome, lesson: m.lesson })),
      draftHypotheses,
      instruction:
        "Based on the evidence above, return a refined and enriched hypothesis list. Preserve high-quality draft hypotheses but improve specificity and motivation. Add new hypotheses if the evidence suggests unexplored directions.",
    },
    null,
    2,
  )
}

function validateLLMHypothesisItem(raw: unknown): HypothesisObject | undefined {
  const rec = recordValue(raw)
  if (Object.keys(rec).length === 0) return undefined
  const id = typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : undefined
  const statement = typeof rec.statement === "string" && rec.statement.trim() ? rec.statement.trim() : undefined
  const priority = rec.priority === "high" || rec.priority === "medium" || rec.priority === "low" ? rec.priority : undefined
  if (!id || !statement || !priority) return undefined
  const filterStrings = (value: unknown) =>
    Array.isArray(value)
      ? (value as unknown[]).filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : []
  const motivation = filterStrings(rec.motivation)
  const suggestedBackbones = filterStrings(rec.suggestedBackbones)
  const suggestedPreprocessing = filterStrings(rec.suggestedPreprocessing)
  const risk = typeof rec.risk === "string" ? rec.risk : ""
  const testable = typeof rec.testable === "boolean" ? rec.testable : true
  return { id, statement, motivation, suggestedBackbones, suggestedPreprocessing, priority, risk, testable }
}

async function generateLLMHypotheses(
  task: ResearchTask,
  dataAnalysis: DataAnalysisAgentResult,
  runs: readonly ResearchRun[],
  memory: readonly ResearchMemory[],
  draftHypotheses: readonly HypothesisObject[],
  workspaceRoot: string,
  onDelta?: (delta: string) => void,
): Promise<{ hypotheses: readonly HypothesisObject[]; usage: import("./llm-proposal").LLMTokenUsage } | undefined> {
  try {
    const runtime = recordValue(recordValue(task.taskSpec).runtime)
    const neoCastProjectRoot = typeof runtime.neoCastProjectRoot === "string" ? runtime.neoCastProjectRoot : undefined
    const config = await resolveNeoCastLLMConfig({ workspaceRoot, neoCastProjectRoot })
    let apiKey = apiKeyFor(config)
    let effectiveConfig = config
    if (!apiKey) {
      const authEntry = await resolveApiKeyFromAuthJson()
      if (!authEntry) return undefined
      apiKey = authEntry.key
      const isAnthropicNative = !authEntry.baseURL
      effectiveConfig = {
        ...config,
        provider: isAnthropicNative ? "anthropic" : "openai-compatible",
        model: isAnthropicNative ? config.model : authEntry.model,
        ...(authEntry.baseURL ? { baseURL: authEntry.baseURL } : {}),
      }
    }
    const system = buildHypoPlannerSystemPrompt()
    const user = buildHypoPlannerUserPrompt(task, dataAnalysis, runs, memory, draftHypotheses)
    const llmPromise = onDelta
      ? requestNeoCastLLMStream({ ...effectiveConfig, maxTokens: 8192 }, apiKey, system, user, onDelta)
      : requestNeoCastLLM({ ...effectiveConfig, maxTokens: 8192 }, apiKey, system, user)
    const timeoutPromise = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 120_000))
    const result = await Promise.race([llmPromise, timeoutPromise])
    if (!result) return undefined
    const parsed = extractJsonObject(result.text)
    const parsedRec = recordValue(parsed)
    if (!Array.isArray(parsedRec.hypotheses)) return undefined
    const validated = (parsedRec.hypotheses as unknown[])
      .map(validateLLMHypothesisItem)
      .filter((h): h is HypothesisObject => h !== undefined)
      .slice(0, 8)
    return validated.length > 0 ? { hypotheses: validated, usage: result.usage } : undefined
  } catch {
    return undefined
  }
}

function buildReflectionLLMSystemPrompt(): string {
  return [
    "You are the NeoResearch reflection assistant for time series forecasting (TSF) research.",
    "Language policy: write in English; keep technical terms, metric names, and module names in English.",
    "Task: Given a structured analysis of a TSF model-search window, write a concise narrative reflection.",
    "Output format: Return exactly three paragraphs of plain prose (no headings, no bullet points, no code blocks):",
    "Paragraph 1: Plain-language summary of what happened in this search window (runs, outcomes, best metric).",
    "Paragraph 2: What worked and what did not — effective changes, failures, and plateau observations.",
    "Paragraph 3: What the agent recommends next and why, based on the hypotheses and decision.",
    "Keep the total length to 150-250 words. Do not add any text outside the three paragraphs.",
  ].join("\n")
}

function buildReflectionLLMUserPrompt(analysis: ReflectionAnalysis): string {
  return JSON.stringify(
    {
      primaryMetricName: analysis.primaryMetricName,
      direction: analysis.direction,
      bestMetric: analysis.bestMetric ?? null,
      bestRunID: analysis.bestRunID ?? null,
      latestMetric: analysis.latestMetric ?? null,
      latestDelta: analysis.latestDelta ?? null,
      succeededRuns: analysis.succeededRuns,
      failedRuns: analysis.failedRuns,
      rejectedRuns: analysis.rejectedRuns,
      plateauStreak: analysis.plateauStreak,
      effectiveChanges: analysis.effectiveChanges.map((item) => ({
        candidateID: item.candidateID,
        runID: item.runID,
        metricValue: item.metricValue,
        delta: item.delta,
        summary: item.summary,
      })),
      ineffectiveChanges: analysis.ineffectiveChanges.map((item) => ({
        candidateID: item.candidateID,
        runID: item.runID,
        metricValue: item.metricValue,
        delta: item.delta,
        summary: item.summary,
      })),
      failures: analysis.failures.map((item) => ({
        runID: item.runID,
        candidateID: item.candidateID ?? null,
        category: item.category,
        summary: item.summary,
      })),
      nextHypotheses: analysis.nextHypotheses.map((item) => ({
        title: item.title,
        rationale: item.rationale,
        expectedSignal: item.expectedSignal,
      })),
      decision: analysis.decision,
      decisionReason: analysis.decisionReason,
      instruction:
        "Write a narrative reflection summary (3 paragraphs) describing what happened, what worked/failed, and what to do next.",
    },
    null,
    2,
  )
}

async function generateLLMReflectionSynthesis(
  task: ResearchTask,
  result: ReflectionAgentResult,
): Promise<ReflectionAgentResult> {
  const runtime = recordValue(recordValue(task.taskSpec).runtime)
  const neoCastProjectRoot = typeof runtime.neoCastProjectRoot === "string" ? runtime.neoCastProjectRoot : undefined
  let config
  try {
    config = await resolveNeoCastLLMConfig({ workspaceRoot: Instance.directory, neoCastProjectRoot })
  } catch {
    return { ...result, llm: { status: "failed" } }
  }
  let apiKey = apiKeyFor(config)
  let effectiveConfig = config
  if (!apiKey) {
    // Fallback: read the key configured via the TUI "Configure API Key" dialog (opencode auth.json).
    const authEntry = await resolveApiKeyFromAuthJson()
    if (!authEntry) return { ...result, llm: { status: "not_configured" } }
    apiKey = authEntry.key
    const isAnthropicNative = !authEntry.baseURL
    effectiveConfig = {
      ...config,
      provider: isAnthropicNative ? "anthropic" : "openai-compatible",
      model: isAnthropicNative ? config.model : authEntry.model,
      ...(authEntry.baseURL ? { baseURL: authEntry.baseURL } : {}),
    }
  }
  try {
    const system = buildReflectionLLMSystemPrompt()
    const user = buildReflectionLLMUserPrompt(result.analysis)
    // Race against 25-second timeout so a slow/hung LLM provider never blocks the pipeline.
    const llmPromise = requestNeoCastLLM(effectiveConfig, apiKey, system, user)
    const timeoutPromise = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 25_000))
    const llmResult = await Promise.race([llmPromise, timeoutPromise])
    if (llmResult === undefined) return { ...result, llm: { status: "failed" } }
    return { ...result, llm: { status: "used", model: effectiveConfig.model, text: llmResult.text, usage: llmResult.usage } }
  } catch {
    return { ...result, llm: { status: "failed" } }
  }
}

function buildReflectionMemoryLesson(result: ReflectionAgentResult): string {
  const a = result.analysis
  const parts: string[] = [`[reflection] ${a.decision}: ${a.decisionReason}`]
  if (a.bestMetric !== undefined) parts.push(`best ${a.primaryMetricName}=${a.bestMetric}`)
  if (a.nextHypotheses.length > 0) parts.push(`next: ${a.nextHypotheses.map((h) => h.title).join("; ")}`)
  if (result.llm.status === "used" && result.llm.text) parts.push(`llm: ${result.llm.text.slice(0, 300)}`)
  return parts.join(" | ")
}

function buildDatasetAnalysisReports(
  task: ResearchTask,
  fingerprint: JsonRecord,
  context: DatasetAnalysisContext,
  llmQualitative?: string,
): DatasetAnalysisReport[] {
  return [
    {
      kind: "dataset_quantitative_analysis_markdown",
      filename: "quantitative_analysis.md",
      role: "quantitative-data-analyst",
      content: renderDatasetQuantitativeAnalysis(task, fingerprint, context),
      metadata: {
        format: "markdown",
        role: "quantitative-data-analyst",
        phase: "data_analysis",
      } as JsonRecord,
    },
    {
      kind: "dataset_qualitative_analysis_markdown",
      filename: "qualitative_analysis.md",
      role: "qualitative-data-analyst",
      content: renderDatasetQualitativeAnalysis(task, fingerprint, context, llmQualitative),
      metadata: {
        format: "markdown",
        role: "qualitative-data-analyst",
        phase: "data_analysis",
        llmGenerated: llmQualitative !== undefined,
      } as JsonRecord,
    },
    {
      kind: "dataset_main_analysis_markdown",
      filename: "main_agent_summary.md",
      role: "main-data-analyst",
      content: renderDatasetMainAnalysisSummary(task, fingerprint, context),
      metadata: {
        format: "markdown",
        role: "main-data-analyst",
        phase: "data_analysis",
        inputs: ["dataset_quantitative_analysis_markdown", "dataset_qualitative_analysis_markdown"],
      } as JsonRecord,
    },
  ]
}

function buildReleaseIntegrity(kind: string, copiedFiles: Record<string, string>) {
  const required = [
    "reports/final_report.md",
    "artifacts/release_package.md",
    "results/runs.json",
    "results/candidates.json",
    "results/champion.json",
    "results/artifacts.json",
    "manifest.json",
  ]
  if (kind === "model_export_package" || kind === "research_final_bundle") {
    required.push("model/model.py")
  }
  const present = new Set(Object.values(copiedFiles))
  const missing = required.filter((item) => !present.has(item))
  return {
    status: missing.length === 0 ? "complete" : "incomplete",
    required,
    missing,
  }
}

function renderReleasePackageMarkdown(input: {
  readonly task: ResearchTask
  readonly kind: string
  readonly champion: ResearchChampion | undefined
  readonly copiedFiles: Record<string, string>
  readonly integrity: ReturnType<typeof buildReleaseIntegrity>
}) {
  return [
    "# Release Package",
    "",
    `- Task ID: ${input.task.id}`,
    `- Task title: ${input.task.title}`,
    `- Artifact kind: ${input.kind}`,
    `- Champion candidate: ${input.champion?.candidateID ?? "none"}`,
    "",
    "## Reproduce",
    "",
    "- Inspect `manifest.json` for the exact file contract.",
    "- Use `model/training_script.py` when a NAS-generated training entrypoint is present.",
    "- Use `model/model.py` or `model/best_model.py` for local inference scaffolding.",
    "",
    "## Input / Output Contract",
    "",
    "- Inputs: task specification, candidate registry, run metrics, champion metadata, and copied model artifacts.",
    "- Outputs: final report, result JSON snapshots, trace files, model files, and this release package note.",
    "",
    "## Release Integrity",
    "",
    `- Status: ${input.integrity.status}`,
    `- Missing: ${input.integrity.missing.length ? input.integrity.missing.join(", ") : "none"}`,
    "",
    "## File Manifest",
    "",
    ...Object.entries(input.copiedFiles)
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([key, value]) => `- ${key}: ${value}`),
    "",
  ].join("\n")
}

async function ensureRunnerStateInitialized(plan: DomainRunPlan): Promise<void> {
  const cwd = plan.command.cwd ?? process.cwd()
  const stateFile = path.join(cwd, ".neo-cast", "runner_state.json")
  if (existsSync(stateFile)) return

  const scriptArg = plan.command.args[0]
  if (typeof scriptArg !== "string" || scriptArg.length === 0) return
  // Only the runner.py CLI requires `init`; smoke (validate.py) does not.
  if (!scriptArg.endsWith("runner.py")) return

  const runnerScript = path.isAbsolute(scriptArg) ? scriptArg : path.join(cwd, scriptArg)
  if (!existsSync(runnerScript)) {
    throw new Error(
      `Cannot initialize Neo-Cast runner state: runner script not found at ${runnerScript}`,
    )
  }

  const result = await Process.run([plan.command.executable, runnerScript, "init"], {
    cwd,
    env: plan.command.env,
    nothrow: true,
    timeout: 30_000,
  })
  if (result.code !== 0) {
    const stderr = result.stderr.toString().trim()
    const stdout = result.stdout.toString().trim()
    const detail = stderr.length > 0 ? stderr : stdout
    throw new Error(
      `Neo-Cast runner init failed (exit ${result.code}) at ${cwd}${detail ? `: ${detail}` : ""}`,
    )
  }
}

async function executeRunnerPlan(
  plan: DomainRunPlan,
  onProgressLine?: (line: string) => void,
): Promise<RunnerExecution> {
  const cwd = plan.command.cwd ?? process.cwd()
  await ensureRunnerStateInitialized(plan)
  for (const item of plan.writes) {
    const file = runnerPath(cwd, item.path)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify(item.content, null, 2)}\n`, "utf8")
  }

  const abortController = new AbortController()
  let abortReason: string | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let commandTimer: ReturnType<typeof setTimeout> | undefined
  let consecutiveNaNLosses = 0
  const clearRunnerTimers = () => {
    if (idleTimer) clearTimeout(idleTimer)
    if (commandTimer) clearTimeout(commandTimer)
    idleTimer = undefined
    commandTimer = undefined
  }
  const abortRunner = (reason: string) => {
    if (abortReason !== undefined) return
    abortReason = reason
    abortController.abort()
  }
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(
      () => abortRunner(`Runner idle timeout: no stdout/stderr for ${RUNNER_IDLE_TIMEOUT_MS / 1000}s`),
      RUNNER_IDLE_TIMEOUT_MS,
    )
  }
  const handleStdoutLine = (line: string) => {
    resetIdleTimer()
    if (runnerLineHasNaNValidationLoss(line)) {
      consecutiveNaNLosses += 1
      if (consecutiveNaNLosses >= RUNNER_NAN_WATCHDOG_LIMIT) {
        abortRunner(`NaN watchdog: observed ${consecutiveNaNLosses} consecutive val_loss=NaN records`)
      }
    } else if (runnerLineHasFiniteValidationLoss(line)) {
      consecutiveNaNLosses = 0
    }
    onProgressLine?.(line)
  }
  resetIdleTimer()
  if (plan.command.timeoutMs !== undefined) {
    commandTimer = setTimeout(
      () => abortRunner(`Runner command timeout: exceeded ${plan.command.timeoutMs}ms`),
      plan.command.timeoutMs,
    )
  }
  const result = await Process.runStreaming([plan.command.executable, ...plan.command.args], {
    cwd,
    env: plan.command.env,
    abort: abortController.signal,
    kill: "SIGKILL",
    timeout: RUNNER_ABORT_KILL_GRACE_MS,
    nothrow: true,
    onStdoutLine: handleStdoutLine,
    onStderrLine: () => resetIdleTimer(),
  })
  clearRunnerTimers()
  const stdout = result.stdout.toString()
  const stderr = [result.stderr.toString(), abortReason].filter((item) => item && item.length > 0).join("\n")
  return {
    exitCode: abortReason === undefined ? result.code : result.code === 0 ? 1 : result.code,
    stdout,
    stderr,
    records: parseRunnerRecords(stdout),
  }
}

async function sha256File(file: string) {
  try {
    return createHash("sha256").update(await readFile(file)).digest("hex")
  } catch {
    return undefined
  }
}

function firstExistingFile(candidates: readonly string[]) {
  return candidates.find((candidate) => existsSync(candidate))
}

async function gitHead(cwd: string) {
  const result = await Process.run(["git", "rev-parse", "HEAD"], {
    cwd,
    nothrow: true,
    timeout: 5_000,
  })
  const value = result.stdout.toString().trim()
  return result.code === 0 && value.length > 0 ? value : undefined
}

async function buildReproducibilitySeal(
  task: ResearchTask,
  plan: DomainRunPlan,
  workspaceRoot: string,
): Promise<JsonRecord> {
  const taskSpec = recordValue(task.taskSpec)
  const runtime = recordValue(taskSpec.runtime)
  const dataset = recordValue(taskSpec.dataset)
  const neoCastRoot =
    typeof runtime.neoCastProjectRoot === "string" && runtime.neoCastProjectRoot.length > 0
      ? path.resolve(runtime.neoCastProjectRoot)
      : path.resolve(plan.command.cwd ?? workspaceRoot)
  const sourcePath =
    typeof dataset.path === "string" && dataset.path.length > 0
      ? path.resolve(workspaceRoot, dataset.path)
      : undefined
  const lockPath = firstExistingFile([
    path.join(neoCastRoot, "uv.lock"),
    path.join(neoCastRoot, "poetry.lock"),
    path.join(neoCastRoot, "pyproject.toml"),
    path.join(neoCastRoot, "requirements.txt"),
    path.join(workspaceRoot, "bun.lock"),
    path.join(workspaceRoot, "bun.lockb"),
    path.join(workspaceRoot, "package-lock.json"),
  ])
  const preprocessPath = firstExistingFile([
    path.join(neoCastRoot, ".neo-cast", "dataset_spec.json"),
    path.join(neoCastRoot, ".neo-cast", "dataset", "dataset_spec.json"),
    path.join(neoCastRoot, "py", "prepare_tsf.py"),
  ])
  const [workspaceGitSHA, datasetSHA, lockHash, preprocessSHA] = await Promise.all([
    gitHead(workspaceRoot),
    sourcePath === undefined ? undefined : sha256File(sourcePath),
    lockPath === undefined ? undefined : sha256File(lockPath),
    preprocessPath === undefined ? undefined : sha256File(preprocessPath),
  ])
  return {
    generatedAt: new Date().toISOString(),
    workspaceRoot,
    neoCastRoot,
    runnerID: plan.runnerID,
    runnerKind: plan.runnerKind,
    ...(workspaceGitSHA === undefined ? {} : { gitSHA: workspaceGitSHA }),
    ...(sourcePath === undefined ? {} : { datasetPath: sourcePath }),
    ...(datasetSHA === undefined ? {} : { datasetSHA }),
    ...(lockPath === undefined ? {} : { lockPath }),
    ...(lockHash === undefined ? {} : { lockHash }),
    ...(preprocessPath === undefined ? {} : { preprocessPath }),
    ...(preprocessSHA === undefined ? {} : { preprocessSHA }),
  } as JsonRecord
}

function tsfDatasetPreparationConfig(task: ResearchTask) {
  if (task.domainID !== "tsf") return undefined
  const taskSpec = recordValue(task.taskSpec)
  const dataset = recordValue(taskSpec.dataset)
  const runtime = recordValue(taskSpec.runtime)
  const root = typeof runtime.neoCastProjectRoot === "string" ? runtime.neoCastProjectRoot.trim() : ""
  const source = typeof dataset.path === "string" ? dataset.path.trim() : ""
  if (!root || !source) return undefined
  const contextLength = numericPolicyValue(taskSpec.contextLength)
  const predictionLengths = Array.isArray(taskSpec.predictionLengths)
    ? taskSpec.predictionLengths.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
    : []
  const targetCols = Array.isArray(dataset.targetCols)
    ? dataset.targetCols.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []
  const loaderID = typeof dataset.loaderID === "string" && dataset.loaderID.length > 0 ? dataset.loaderID : "local_csv"
  return {
    root: path.resolve(root),
    source: path.resolve(source),
    loaderID,
    contextLength: contextLength === undefined ? undefined : Math.floor(contextLength),
    predictionLengths: predictionLengths.map((item) => Math.floor(item)),
    targetCols,
  }
}

function tsfRunnerScriptPath(task: ResearchTask): string | undefined {
  if (task.domainID !== "tsf") return undefined
  const runtime = recordValue(recordValue(task.taskSpec).runtime)
  const root = typeof runtime.neoCastProjectRoot === "string" ? runtime.neoCastProjectRoot.trim() : ""
  if (!root) return undefined
  return path.join(path.resolve(root), "py", "validate.py")
}

function datasetPresetFromLoader(loaderID: string) {
  if (loaderID.endsWith("_tslib_v1")) return loaderID.replace(/_tslib_v1$/, "")
  if (["etth1", "ettm1", "weather", "traffic"].includes(loaderID)) return loaderID
  return undefined
}

function csvHeaderColumns(csvPath: string): string[] {
  let fd: number | undefined
  try {
    fd = openSync(csvPath, "r")
    const buf = Buffer.alloc(4096)
    const bytesRead = readSync(fd, buf, 0, 4096, 0)
    const chunk = buf.slice(0, bytesRead).toString("utf8")
    const newline = chunk.indexOf("\n")
    const firstLine = (newline < 0 ? chunk : chunk.slice(0, newline)).trim()
    return firstLine.split(",").map((h) => h.trim().replace(/^"|"$/g, ""))
  } catch {
    return []
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function csvDataRowCount(csvPath: string): number | undefined {
  let fd: number | undefined
  try {
    fd = openSync(csvPath, "r")
    const buffer = Buffer.alloc(64 * 1024)
    let position = 0
    let bytesRead = 0
    let newlineCount = 0
    let lastByte = 0
    do {
      bytesRead = readSync(fd, buffer, 0, buffer.length, position)
      for (let index = 0; index < bytesRead; index++) {
        lastByte = buffer[index]!
        if (lastByte === 10) newlineCount += 1
      }
      position += bytesRead
    } while (bytesRead > 0)
    if (position === 0) return 0
    const physicalLines = newlineCount + (lastByte === 10 ? 0 : 1)
    return Math.max(0, physicalLines - 1)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function splitIsFeasible(
  totalRows: number,
  inputLen: number,
  maxHorizon: number,
  splitStrategy: DatasetSplitStrategy,
) {
  if (splitStrategy === "contiguous_60_20_20") {
    const trainEnd = Math.floor(totalRows * 0.6)
    const valEnd = Math.floor(totalRows * 0.8)
    return trainEnd >= inputLen + maxHorizon &&
      valEnd - trainEnd >= maxHorizon &&
      totalRows - valEnd >= maxHorizon
  }
  const trainEnd = Math.floor(totalRows * 0.7)
  const refStart = totalRows - Math.floor(totalRows * 0.2)
  return trainEnd >= inputLen + maxHorizon &&
    refStart - trainEnd >= maxHorizon &&
    totalRows - refStart >= maxHorizon
}

function minimumRowsForSplit(inputLen: number, maxHorizon: number, splitStrategy: DatasetSplitStrategy) {
  const approximate =
    splitStrategy === "contiguous_60_20_20"
      ? Math.max(Math.ceil((inputLen + maxHorizon) / 0.6), Math.ceil(maxHorizon / 0.2))
      : Math.max(Math.ceil((inputLen + maxHorizon) / 0.7), Math.ceil(maxHorizon / 0.1), Math.ceil(maxHorizon / 0.2))
  for (let rows = Math.max(1, approximate - 8); rows <= approximate + 32; rows++) {
    if (splitIsFeasible(rows, inputLen, maxHorizon, splitStrategy)) return rows
  }
  return approximate
}

function validateCustomDatasetShape(input: {
  readonly source: string
  readonly inputLen?: number
  readonly predictionLengths: readonly number[]
  readonly splitStrategy: DatasetSplitStrategy
}) {
  if (input.inputLen === undefined || input.predictionLengths.length === 0) return
  const maxHorizon = Math.max(...input.predictionLengths)
  const rows = csvDataRowCount(input.source)
  if (rows === undefined) return
  const minRows = minimumRowsForSplit(input.inputLen, maxHorizon, input.splitStrategy)
  if (rows >= minRows) return
  throw new Error(
    `Dataset is too short for automatic ${input.splitStrategy} splits: rows=${rows}, minimumRows=${minRows}, ` +
      `input_len=${input.inputLen}, max_horizon=${maxHorizon}. Lower input_len/horizons or provide explicit split rows.`,
  )
}

function datasetSourceKey(dataset: Record<string, unknown>) {
  if (typeof dataset.path === "string" && dataset.path.trim().length > 0) {
    const absolutePath = path.resolve(dataset.path)
    const hash = hashFilePrefix(absolutePath)
    return hash === undefined ? absolutePath : `${absolutePath}#sha256_1mb=${hash}`
  }
  if (typeof dataset.loaderID === "string" && dataset.loaderID.length > 0) return `loader:${dataset.loaderID}`
  return "unknown"
}

function hashFilePrefix(filePath: string) {
  let fd: number | undefined
  try {
    fd = openSync(filePath, "r")
    const buffer = Buffer.alloc(1024 * 1024)
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
    return createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("hex").slice(0, 16)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function buildPrepareDatasetCommand(task: ResearchTask, force: boolean) {
  const config = tsfDatasetPreparationConfig(task)
  if (!config) {
    throw new Error("TSF dataset preparation requires taskSpec.dataset.path and taskSpec.runtime.neoCastProjectRoot")
  }
  const args = ["./bin/neo-cast.js", "prepare-data", "--source", config.source]
  const preset = datasetPresetFromLoader(config.loaderID)
  if (preset) args.push("--dataset-preset", preset)
  else {
    args.push("--task-id", config.loaderID)
    args.push("--split-strategy", DEFAULT_CUSTOM_SPLIT_STRATEGY)
    validateCustomDatasetShape({
      source: config.source,
      inputLen: config.contextLength,
      predictionLengths: config.predictionLengths,
      splitStrategy: DEFAULT_CUSTOM_SPLIT_STRATEGY,
    })
  }
  const warnings: string[] = []
  if (config.targetCols.length > 0) {
    const csvHeaders = csvHeaderColumns(config.source)
    const validCols = csvHeaders.length > 0
      ? config.targetCols.filter((col) => csvHeaders.includes(col))
      : config.targetCols
    if (csvHeaders.length > 0 && validCols.length === 0) {
      throw new Error(
        `None of the requested target columns were found in ${config.source}. ` +
          `Requested: ${config.targetCols.join(", ")}. CSV header: ${csvHeaders.join(", ")}.`,
      )
    }
    if (csvHeaders.length > 0 && validCols.length < config.targetCols.length) {
      const missing = config.targetCols.filter((col) => !csvHeaders.includes(col))
      warnings.push(
        `Only matched ${validCols.length}/${config.targetCols.length} requested target columns from CSV header; missing: ${missing.join(", ")}.`,
      )
    }
    if (validCols.length > 0) args.push("--feature-cols", validCols.join(","))
  }
  if (config.contextLength !== undefined) args.push("--input-len", String(config.contextLength))
  if (config.predictionLengths.length > 0) args.push("--horizons", config.predictionLengths.join(","))
  if (force) args.push("--force")
  return {
    executable: process.execPath,
    args,
    cwd: config.root,
    source: config.source,
    warnings,
  }
}

async function readPreparedDatasetSpec(root: string) {
  const candidates = [
    path.join(root, ".neo-cast", "dataset_spec.json"),
    path.join(root, ".neo-cast", "dataset", "dataset_spec.json"),
  ]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    const payload = JSON.parse(await readFile(file, "utf8"))
    if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload as JsonRecord
  }
  throw new Error(`Neo-Cast dataset spec was not created under ${root}`)
}

const decodeTask = Schema.decodeUnknownSync(ResearchTask)
const decodeApproval = Schema.decodeUnknownSync(ResearchApproval)
const decodeCandidate = Schema.decodeUnknownSync(ResearchCandidate)
const decodeRun = Schema.decodeUnknownSync(ResearchRun)
const decodeArtifact = Schema.decodeUnknownSync(ResearchArtifact)
const decodeMemory = Schema.decodeUnknownSync(ResearchMemory)
const decodeChampion = Schema.decodeUnknownSync(ResearchChampion)

function mapTask(row: ResearchTaskRow) {
  return decodeTask({
    id: row.id,
    projectID: row.project_id,
    sessionID: row.session_id ?? undefined,
    title: row.title,
    domainID: row.domain_id,
    mode: row.mode,
    interactionMode: taskInteractionModeFromFields(row.mode, row.task_spec),
    status: row.status,
    taskSpec: row.task_spec,
    objective: row.objective,
    budget: row.budget,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  })
}

function mapApproval(row: ResearchApprovalRow) {
  return decodeApproval({
    id: row.id,
    taskID: row.task_id,
    candidateID: row.candidate_id ?? undefined,
    kind: row.kind,
    status: row.status,
    reason: row.reason,
    replyMessage: row.reply_message ?? undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
    timeReplied: row.time_replied ?? undefined,
  })
}

function mapCandidate(row: ResearchCandidateRow) {
  return decodeCandidate({
    id: row.id,
    taskID: row.task_id,
    parentCandidateID: row.parent_candidate_id ?? undefined,
    domainID: row.domain_id,
    candidateSpec: row.candidate_spec,
    rationale: row.rationale,
    riskLevel: row.risk_level,
    approvalStatus: row.approval_status,
    generatedBy: row.generated_by,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  })
}

function mapRun(row: ResearchRunRow) {
  return decodeRun({
    id: row.id,
    taskID: row.task_id,
    candidateID: row.candidate_id ?? undefined,
    stage: row.stage,
    status: row.status,
    metrics: row.metrics,
    resourceUsage: row.resource_usage,
    artifactRefs: row.artifact_refs,
    error: row.error ?? undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
    timeStarted: row.time_started ?? undefined,
    timeFinished: row.time_finished ?? undefined,
  })
}

function mapArtifact(row: ResearchArtifactRow) {
  return decodeArtifact({
    id: row.id,
    taskID: row.task_id,
    runID: row.run_id ?? undefined,
    kind: row.kind,
    uri: row.uri,
    metadata: row.metadata,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  })
}

function mapMemory(row: ResearchMemoryRow) {
  return decodeMemory({
    id: row.id,
    taskID: row.task_id,
    domainID: row.domain_id,
    fingerprintSummary: row.fingerprint_summary,
    candidateSummary: row.candidate_summary,
    outcome: row.outcome,
    lesson: row.lesson,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  })
}

function mapChampion(row: ResearchChampionRow) {
  return decodeChampion({
    taskID: row.task_id,
    candidateID: row.candidate_id,
    runID: row.run_id,
    primaryMetric: row.primary_metric,
    utility: row.utility,
    acceptedAt: row.accepted_at,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  })
}

export interface Interface {
  readonly createTask: (input: CreateTaskInput) => Effect.Effect<ResearchTask>
  readonly listTasks: (input?: ListTaskInput) => Effect.Effect<ResearchTask[]>
  readonly getTask: (taskID: ResearchTaskID) => Effect.Effect<ResearchTask>
  readonly updateTaskStatus: (input: UpdateTaskStatusInput) => Effect.Effect<ResearchTask>
  readonly updateTaskSpec: (input: UpdateTaskSpecInput) => Effect.Effect<ResearchTask>
  readonly createCandidate: (input: CreateCandidateInput) => Effect.Effect<ResearchCandidate>
  readonly listCandidates: (taskID: ResearchTaskID) => Effect.Effect<ResearchCandidate[]>
  readonly createRun: (input: CreateRunInput) => Effect.Effect<ResearchRun>
  readonly updateRunStatus: (input: UpdateRunStatusInput) => Effect.Effect<ResearchRun>
  readonly listRuns: (taskID: ResearchTaskID) => Effect.Effect<ResearchRun[]>
  readonly createArtifact: (input: CreateArtifactInput) => Effect.Effect<ResearchArtifact>
  readonly listArtifacts: (taskID: ResearchTaskID) => Effect.Effect<ResearchArtifact[]>
  readonly prepareTaskDataset: (input: PrepareTaskDatasetInput) => Effect.Effect<PrepareTaskDatasetResult>
  readonly profileTask: (input: ProfileTaskInput) => Effect.Effect<ProfileTaskResult>
  readonly exportTaskArtifact: (input: ExportTaskArtifactInput) => Effect.Effect<ExportTaskArtifactResult>
  readonly createMemory: (input: CreateMemoryInput) => Effect.Effect<ResearchMemory>
  readonly listMemory: (taskID: ResearchTaskID) => Effect.Effect<ResearchMemory[]>
  readonly setChampion: (input: SetChampionInput) => Effect.Effect<ResearchChampion>
  readonly getChampion: (taskID: ResearchTaskID) => Effect.Effect<ResearchChampion | undefined>
  readonly createApproval: (input: CreateApprovalInput) => Effect.Effect<ResearchApproval>
  readonly listApprovals: (input: ListApprovalInput) => Effect.Effect<ResearchApproval[]>
  readonly replyApproval: (input: ReplyApprovalInput) => Effect.Effect<ResearchApproval>
  readonly seedBaselines: (input: SeedBaselinesInput) => Effect.Effect<SeedBaselinesResult>
  readonly prepareRun: (input: PrepareRunInput) => Effect.Effect<PreparedRun>
  readonly executeRun: (input: PrepareRunInput) => Effect.Effect<PreparedRun>
  readonly executeSeedSweep: (input: ExecuteSeedSweepInput) => Effect.Effect<SeedSweepResult>
  readonly runAutonomousIteration: (input: AutonomousIterationInput) => Effect.Effect<AutonomousIterationResult>
  readonly runAutonomousLoop: (input: AutonomousLoopInput) => Effect.Effect<AutonomousLoopResult>
  readonly runIntentAgent: (taskID: ResearchTaskID) => Effect.Effect<IntentAgentResult>
  readonly answerIntentQuestion: (input: AnswerIntentInput) => Effect.Effect<IntentAgentResult>
  readonly interpretAndApplySlotModification: (input: { taskID: ResearchTaskID; message: string }) => Effect.Effect<IntentAgentResult>
  readonly runDataAnalysisAgent: (input: ProfileTaskInput) => Effect.Effect<DataAnalysisAgentResult>
  readonly runHypoPlannerAgent: (input: {
    readonly taskID: ResearchTaskID
    readonly dataAnalysis: DataAnalysisAgentResult
    readonly outputDir?: string
  }) => Effect.Effect<HypoPlannerResult>
  readonly runNASAgent: (input: AutonomousLoopInput) => Effect.Effect<NASAgentResult>
  readonly runVerifierAgent: (input: VerifierAgentRunInput) => Effect.Effect<VerifierAgentResult>
  readonly runReflectionAgent: (input: ReflectionAgentInput) => Effect.Effect<ReflectionAgentResult>
  readonly runPublishAgent: (input: ExportTaskArtifactInput) => Effect.Effect<PublishAgentResult>
  readonly runFullPipeline: (input: RunFullPipelineInput) => Effect.Effect<RunFullPipelineResult>
  readonly getResearchLLMStatus: () => Effect.Effect<ResearchLLMStatus>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Research") {}

export const layer: Layer.Layer<Service, never, Bus.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const reconcileStaleRuns = Effect.fn("Research.reconcileStaleRuns")(function* () {
      const cutoff = Date.now() - STALE_RUN_RECONCILE_MS
      const staleRows = yield* db((d) =>
        d
          .select({ run: ResearchRunTable })
          .from(ResearchRunTable)
          .innerJoin(ResearchTaskTable, eq(ResearchRunTable.task_id, ResearchTaskTable.id))
          .where(
            and(
              eq(ResearchTaskTable.project_id, Instance.project.id),
              inArray(ResearchRunTable.status, ["queued", "running"]),
              lt(ResearchRunTable.time_updated, cutoff),
            ),
          )
          .all(),
      )
      for (const item of staleRows) {
        const finishedAt = Date.now()
        const row = yield* db((d) =>
          d
            .update(ResearchRunTable)
            .set({
              status: "failed",
              error: `TUI restart while run was ${item.run.status}`,
              time_updated: finishedAt,
              time_finished: finishedAt,
            })
            .where(eq(ResearchRunTable.id, item.run.id))
            .returning()
            .get(),
        )
        if (row) yield* bus.publish(Event.RunUpdated, { run: mapRun(row) })
      }
    })
    yield* reconcileStaleRuns()

    const getTask = Effect.fn("Research.getTask")(function* (taskID: ResearchTaskID) {
      const projectID = Instance.project.id
      const row = yield* db((d) =>
        d
          .select()
          .from(ResearchTaskTable)
          .where(and(eq(ResearchTaskTable.id, taskID), eq(ResearchTaskTable.project_id, projectID)))
          .get(),
      )
      if (!row) throw missing("Research task", taskID)
      return mapTask(row)
    })

    const getCandidateForTask = Effect.fn("Research.getCandidateForTask")(function* (
      taskID: ResearchTaskID,
      candidateID: ResearchCandidateID,
    ) {
      const row = yield* db((d) =>
        d
          .select()
          .from(ResearchCandidateTable)
          .where(and(eq(ResearchCandidateTable.id, candidateID), eq(ResearchCandidateTable.task_id, taskID)))
          .get(),
      )
      if (!row) throw missing("Research candidate", candidateID)
      return mapCandidate(row)
    })

    const getRunForTask = Effect.fn("Research.getRunForTask")(function* (taskID: ResearchTaskID, runID: ResearchRunID) {
      const row = yield* db((d) =>
        d
          .select()
          .from(ResearchRunTable)
          .where(and(eq(ResearchRunTable.id, runID), eq(ResearchRunTable.task_id, taskID)))
          .get(),
      )
      if (!row) throw missing("Research run", runID)
      return mapRun(row)
    })

    const createTask = Effect.fn("Research.createTask")(function* (input: CreateTaskInput) {
      const time = nowTime()
      const taskSpec = normalizeTaskSpec(input)
      const row = yield* db((d) =>
        d
          .insert(ResearchTaskTable)
          .values({
            id: ResearchTaskID.ascending(),
            project_id: Instance.project.id,
            session_id: input.sessionID,
            title: input.title,
            domain_id: input.domainID,
            mode: input.mode,
            status: "idle",
            task_spec: taskSpec,
            objective: input.objective,
            budget: input.budget,
            time_created: time.created,
            time_updated: time.updated,
          })
          .returning()
          .get(),
      )
      if (!row) throw new Error("Research task insert returned no row")
      const task = mapTask(row)
      yield* bus.publish(Event.TaskCreated, { task })
      return task
    })

    const listTasks = Effect.fn("Research.listTasks")(function* (input?: ListTaskInput) {
      const projectID = Instance.project.id
      const rows = yield* db((d) =>
        d
          .select()
          .from(ResearchTaskTable)
          .where(
            and(
              eq(ResearchTaskTable.project_id, projectID),
              input?.domainID ? eq(ResearchTaskTable.domain_id, input.domainID) : undefined,
              input?.status ? eq(ResearchTaskTable.status, input.status) : undefined,
            ),
          )
          .orderBy(desc(ResearchTaskTable.time_updated))
          .limit(input?.limit ?? 100)
          .all(),
      )
      return rows.map(mapTask)
    })

    const updateTaskStatus = Effect.fn("Research.updateTaskStatus")(function* (input: UpdateTaskStatusInput) {
      const projectID = Instance.project.id
      const row = yield* db((d) =>
        d
          .update(ResearchTaskTable)
          .set({ status: input.status, time_updated: Date.now() })
          .where(and(eq(ResearchTaskTable.id, input.taskID), eq(ResearchTaskTable.project_id, projectID)))
          .returning()
          .get(),
      )
      if (!row) throw missing("Research task", input.taskID)
      const task = mapTask(row)
      yield* bus.publish(Event.TaskUpdated, { task })
      return task
    })

    const updateTaskSpec = Effect.fn("Research.updateTaskSpec")(function* (input: UpdateTaskSpecInput) {
      const existing = yield* getTask(input.taskID)
      const taskSpec = normalizeTaskSpec({
        domainID: existing.domainID,
        mode: existing.mode,
        interactionMode: input.interactionMode ?? existing.interactionMode,
        taskSpec: input.taskSpec,
      })
      const taskSpecMetadata = recordValue(taskSpec.metadata)
      const nextMetadata = { ...taskSpecMetadata }
      if (nextMetadata.workflow !== undefined) delete nextMetadata.workflow
      const projectID = Instance.project.id
      const row = yield* db((d) =>
        d
          .update(ResearchTaskTable)
          .set({ task_spec: { ...taskSpec, metadata: nextMetadata as unknown as JsonRecord }, time_updated: Date.now() })
          .where(and(eq(ResearchTaskTable.id, input.taskID), eq(ResearchTaskTable.project_id, projectID)))
          .returning()
          .get(),
      )
      if (!row) throw missing("Research task", input.taskID)
      const task = mapTask(row)
      yield* bus.publish(Event.TaskUpdated, { task })
      return task
    })

    const updateTaskWorkflow = Effect.fn("Research.updateTaskWorkflow")(function* (input: {
      taskID: ResearchTaskID
      completedPhases?: readonly PipelineWorkflowPhase[]
      lastCheckpoint?: string
    }) {
      const task = yield* getTask(input.taskID)
      const current = workflowMetadataFromTask(task)
      const next: PipelineWorkflowMetadata = normalizeWorkflowMetadata({
        completedPhases: input.completedPhases ?? current.completedPhases,
        ...(input.lastCheckpoint === undefined ? {} : { lastCheckpoint: input.lastCheckpoint }),
      })
      const metadata = recordValue(task.taskSpec.metadata)
      const nextTaskSpec = {
        ...task.taskSpec,
        metadata: { ...metadata, workflow: next } as unknown as JsonRecord,
      }
      const row = yield* db((d) =>
        d
          .update(ResearchTaskTable)
          .set({
            task_spec: nextTaskSpec,
            time_updated: Date.now(),
          })
          .where(and(eq(ResearchTaskTable.id, input.taskID), eq(ResearchTaskTable.project_id, Instance.project.id)))
          .returning()
          .get(),
      )
      if (!row) throw missing("Research task", input.taskID)
      const updated = mapTask(row)
      yield* bus.publish(Event.TaskUpdated, { task: updated })
      return updated
    })

    const updateTaskHypothesisPlan = Effect.fn("Research.updateTaskHypothesisPlan")(function* (input: {
      taskID: ResearchTaskID
      hypothesisPlan: ExperimentPlan
    }) {
      const task = yield* getTask(input.taskID)
      const metadata = recordValue(task.taskSpec.metadata)
      const nextTaskSpec = {
        ...task.taskSpec,
        metadata: {
          ...metadata,
          hypothesisPlan: input.hypothesisPlan,
        } as unknown as JsonRecord,
      }
      const row = yield* db((d) =>
        d
          .update(ResearchTaskTable)
          .set({
            task_spec: nextTaskSpec,
            time_updated: Date.now(),
          })
          .where(and(eq(ResearchTaskTable.id, input.taskID), eq(ResearchTaskTable.project_id, Instance.project.id)))
          .returning()
          .get(),
      )
      if (!row) throw missing("Research task", input.taskID)
      const updated = mapTask(row)
      yield* bus.publish(Event.TaskUpdated, { task: updated })
      return updated
    })

    const createCandidate = Effect.fn("Research.createCandidate")(function* (input: CreateCandidateInput) {
      const task = yield* getTask(input.taskID)
      if (input.parentCandidateID) yield* getCandidateForTask(input.taskID, input.parentCandidateID)
      const candidateSpec = validatedCandidateSpec(task, input)
      const time = nowTime()
      const row = yield* db((d) =>
        d
          .insert(ResearchCandidateTable)
          .values({
            id: ResearchCandidateID.ascending(),
            task_id: input.taskID,
            parent_candidate_id: input.parentCandidateID,
            domain_id: input.domainID,
            candidate_spec: candidateSpec,
            rationale: input.rationale,
            risk_level: input.riskLevel,
            approval_status: input.approvalStatus,
            generated_by: input.generatedBy,
            time_created: time.created,
            time_updated: time.updated,
          })
          .returning()
          .get(),
      )
      const candidate = mapCandidate(row)
      yield* bus.publish(Event.CandidateCreated, { candidate })
      return candidate
    })

    const listCandidates = Effect.fn("Research.listCandidates")(function* (taskID: ResearchTaskID) {
      yield* getTask(taskID)
      const rows = yield* db((d) =>
        d
          .select()
          .from(ResearchCandidateTable)
          .where(eq(ResearchCandidateTable.task_id, taskID))
          .orderBy(desc(ResearchCandidateTable.time_updated))
          .all(),
      )
      return rows.map(mapCandidate)
    })

    const createApproval = Effect.fn("Research.createApproval")(function* (input: CreateApprovalInput) {
      yield* getTask(input.taskID)
      if (input.candidateID) yield* getCandidateForTask(input.taskID, input.candidateID)
      const time = nowTime()
      const row = yield* db((d) =>
        d
          .insert(ResearchApprovalTable)
          .values({
            id: ResearchApprovalID.ascending(),
            task_id: input.taskID,
            candidate_id: input.candidateID,
            kind: input.kind,
            status: "pending",
            reason: input.reason,
            time_created: time.created,
            time_updated: time.updated,
          })
          .returning()
          .get(),
      )
      const approval = mapApproval(row)
      yield* writeGovernanceLogArtifact(approval)
      yield* bus.publish(Event.ApprovalCreated, { approval })
      return approval
    })

    const writeGovernanceLogArtifact = Effect.fn("Research.writeGovernanceLogArtifact")(function* (
      approval: ResearchApproval,
    ) {
      const time = nowTime()
      const dir = path.join(Instance.directory, ".neo-research", "governance", approval.taskID)
      const file = path.join(dir, `${approval.id}-${approval.status}.json`)
      const record = {
        approvalID: approval.id,
        taskID: approval.taskID,
        ...(approval.candidateID === undefined ? {} : { candidateID: approval.candidateID }),
        kind: approval.kind,
        status: approval.status,
        reason: approval.reason,
        ...(approval.replyMessage === undefined ? {} : { replyMessage: approval.replyMessage }),
        ...(approval.timeReplied === undefined ? {} : { timeReplied: approval.timeReplied }),
        time: approval.time,
      }
      yield* Effect.promise(async () => {
        await mkdir(dir, { recursive: true })
        await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8")
      })
      const row = yield* db((d) =>
        d
          .insert(ResearchArtifactTable)
          .values({
            id: ResearchArtifactID.ascending(),
            task_id: approval.taskID,
            kind: "governance_log_json",
            uri: `file://${file}`,
            metadata: {
              approvalID: approval.id,
              kind: approval.kind,
              status: approval.status,
              ...(approval.candidateID === undefined ? {} : { candidateID: approval.candidateID }),
            },
            time_created: time.created,
            time_updated: time.updated,
          })
          .returning()
          .get(),
      )
      const artifact = mapArtifact(row)
      yield* bus.publish(Event.ArtifactCreated, { artifact })
      return artifact
    })

    const listApprovals = Effect.fn("Research.listApprovals")(function* (input: ListApprovalInput) {
      yield* getTask(input.taskID)
      const rows = yield* db((d) =>
        d
          .select()
          .from(ResearchApprovalTable)
          .where(
            and(
              eq(ResearchApprovalTable.task_id, input.taskID),
              input.status ? eq(ResearchApprovalTable.status, input.status) : undefined,
            ),
          )
          .orderBy(desc(ResearchApprovalTable.time_updated))
          .limit(input.limit ?? 100)
          .all(),
      )
      return rows.map(mapApproval)
    })

    const replyApproval = Effect.fn("Research.replyApproval")(function* (input: ReplyApprovalInput) {
      const existingRow = yield* db((d) =>
        d.select().from(ResearchApprovalTable).where(eq(ResearchApprovalTable.id, input.approvalID)).get(),
      )
      if (!existingRow) throw missing("Research approval", input.approvalID)
      yield* getTask(existingRow.task_id)

      const now = Date.now()
      const row = yield* db((d) =>
        d
          .update(ResearchApprovalTable)
          .set({
            status: input.status,
            reply_message: input.replyMessage,
            time_replied: now,
            time_updated: now,
          })
          .where(eq(ResearchApprovalTable.id, input.approvalID))
          .returning()
          .get(),
      )
      if (!row) throw missing("Research approval", input.approvalID)

      if (row.kind === "candidate" && row.candidate_id) {
        const candidateRow = yield* db((d) =>
          d
            .update(ResearchCandidateTable)
            .set({
              approval_status: input.status === "approved" ? "approved" : "rejected",
              time_updated: now,
            })
            .where(
              and(eq(ResearchCandidateTable.id, row.candidate_id!), eq(ResearchCandidateTable.task_id, row.task_id)),
            )
            .returning()
            .get(),
        )
        if (candidateRow) {
          const candidate = mapCandidate(candidateRow)
          yield* bus.publish(Event.CandidateUpdated, { candidate })
        }
      }

      const approval = mapApproval(row)
      yield* writeGovernanceLogArtifact(approval)
      yield* bus.publish(Event.ApprovalUpdated, { approval })

      // When the user rejects an intent checkpoint, reset the task to "idle" and mark it as
      // pending review so the TUI can guide the user through slot modification.
      if (
        input.status === "rejected" &&
        row.kind === "protocol" &&
        row.reason.includes("[checkpoint:intent_confirmed]")
      ) {
        const taskForReset = yield* getTask(row.task_id)
        const existingSpec = taskForReset.taskSpec
        const existingMeta =
          typeof existingSpec.metadata === "object" && existingSpec.metadata !== null && !Array.isArray(existingSpec.metadata)
            ? (existingSpec.metadata as Record<string, unknown>)
            : {}
        yield* updateTaskSpec({
          taskID: row.task_id as ResearchTaskID,
          taskSpec: { ...existingSpec, metadata: { ...existingMeta, intentPendingReview: true } } as JsonRecord,
        })
        yield* updateTaskStatus({ taskID: row.task_id as ResearchTaskID, status: "idle" })
      }

      return approval
    })

    const seedBaselines = Effect.fn("Research.seedBaselines")(function* (input: SeedBaselinesInput) {
      const task = yield* getTask(input.taskID)
      const proposals = DomainRegistry.buildBaselines(task.domainID, task.taskSpec)
      const existingRows = yield* db((d) =>
        d.select().from(ResearchCandidateTable).where(eq(ResearchCandidateTable.task_id, task.id)).all(),
      )
      const existingRecipeIDs = new Set(
        existingRows.map((row) => candidateRecipeID(row.candidate_spec)).filter((id): id is string => id !== undefined),
      )
      const candidates: ResearchCandidate[] = []
      const approvals: ResearchApproval[] = []

      for (const proposal of proposals) {
        const recipeID = candidateRecipeID(proposal.candidateSpec)
        if (recipeID && existingRecipeIDs.has(recipeID)) continue
        const approvalStatus =
          task.mode === "autonomous" ? "auto_approved" : proposal.approvalStatus
        const candidate = yield* createCandidate({
          taskID: task.id,
          domainID: task.domainID,
          candidateSpec: proposal.candidateSpec,
          rationale: proposal.rationale,
          riskLevel: proposal.riskLevel,
          approvalStatus,
          generatedBy: proposal.generatedBy,
        })
        candidates.push(candidate)
        if (recipeID) existingRecipeIDs.add(recipeID)

        if (candidate.approvalStatus === "pending") {
          const approval = yield* createApproval({
            taskID: task.id,
            candidateID: candidate.id,
            kind: "candidate",
            reason: `Review candidate before ${task.mode === "review" ? "manual" : "gated autonomous"} execution.`,
          })
          approvals.push(approval)
        }
      }

      return { candidates, approvals }
    })

    const getRunBudgetExceeded = Effect.fn("Research.getRunBudgetExceeded")(function* (
      task: ResearchTask,
      status: ResearchRun["status"],
    ) {
      const maxRuns = maxRunsLimit(task.budget)
      if (maxRuns !== undefined) {
        const used = yield* db((d) =>
          d
            .select({ id: ResearchRunTable.id })
            .from(ResearchRunTable)
            .where(and(eq(ResearchRunTable.task_id, task.id), notInArray(ResearchRunTable.stage, ["profile", "ref_test", "blind_test"])))
            .all(),
        ).pipe(Effect.map((rows) => rows.length))
        if (used >= maxRuns) {
          return { limit: maxRuns, used }
        }
      }

      const maxParallel = maxParallelLimit(task.budget)
      if (maxParallel !== undefined && (status === "queued" || status === "running")) {
        const used = yield* db((d) =>
          d
            .select({ id: ResearchRunTable.id })
            .from(ResearchRunTable)
            .where(and(eq(ResearchRunTable.task_id, task.id), inArray(ResearchRunTable.status, ["queued", "running"])))
            .all(),
        ).pipe(Effect.map((rows) => rows.length))
        if (used >= maxParallel) {
          return { limit: maxParallel, used }
        }
      }
      return undefined
    })

    const ensurePendingApproval = Effect.fn("Research.ensurePendingApproval")(function* (input: {
      readonly taskID: ResearchTaskID
      readonly candidateID?: ResearchCandidateID
      readonly kind: ResearchApproval["kind"]
      readonly reason: string
    }) {
      const existing = yield* db((d) =>
        d
          .select()
          .from(ResearchApprovalTable)
          .where(
            and(
              eq(ResearchApprovalTable.task_id, input.taskID),
              input.candidateID
                ? eq(ResearchApprovalTable.candidate_id, input.candidateID)
                : isNull(ResearchApprovalTable.candidate_id),
              eq(ResearchApprovalTable.kind, input.kind),
              eq(ResearchApprovalTable.status, "pending"),
            ),
          )
          .get(),
      )
      if (existing) return mapApproval(existing)
      return yield* createApproval(input)
    })

    const ensureHumanCheckpoint = Effect.fn("Research.ensureHumanCheckpoint")(function* (input: {
      readonly taskID: ResearchTaskID
      readonly phase: string
      readonly reason: string
    }) {
      const checkpointTag = `[checkpoint:${input.phase}]`
      const rows = yield* db((d) =>
        d
          .select()
          .from(ResearchApprovalTable)
          .where(
            and(
              eq(ResearchApprovalTable.task_id, input.taskID),
              isNull(ResearchApprovalTable.candidate_id),
              eq(ResearchApprovalTable.kind, "protocol"),
            ),
          )
          .all(),
      )
      const approved = rows.find((row) => row.status === "approved" && row.reason.includes(checkpointTag))
      if (approved) return mapApproval(approved)
      const pending = rows.find((row) => row.status === "pending" && row.reason.includes(checkpointTag))
      if (pending) return mapApproval(pending)
      return yield* createApproval({
        taskID: input.taskID,
        kind: "protocol",
        reason: `${checkpointTag}\n${input.reason}`,
      })
    })

    const ensureIntentCheckpoint = Effect.fn("Research.ensureIntentCheckpoint")(function* (input: {
      readonly task: ResearchTask
      readonly reason: string
    }) {
      const phase = "intent_confirmed"
      const checkpointTag = `[checkpoint:${phase}]`
      const signature = `Intent signature: ${intentCheckpointSignature(input.task)}`
      const checkpointReason = `${checkpointTag}\n${input.reason}`
      const rows = yield* db((d) =>
        d
          .select()
          .from(ResearchApprovalTable)
          .where(
            and(
              eq(ResearchApprovalTable.task_id, input.task.id),
              isNull(ResearchApprovalTable.candidate_id),
              eq(ResearchApprovalTable.kind, "protocol"),
            ),
          )
          .all(),
      )
      const approved = rows.find(
        (row) => row.status === "approved" && row.reason.includes(checkpointTag) && row.reason.includes(signature),
      )
      if (approved) return mapApproval(approved)
      const pending = rows.find(
        (row) => row.status === "pending" && row.reason.includes(checkpointTag) && row.reason.includes(signature),
      )
      if (pending) return mapApproval(pending)
      return yield* createApproval({
        taskID: input.task.id,
        kind: "protocol",
        reason: checkpointReason,
      })
    })

    const ensureRunBudget = Effect.fn("Research.ensureRunBudget")(function* (
      task: ResearchTask,
      status: ResearchRun["status"],
      candidate?: ResearchCandidate,
    ) {
      const exceeded = yield* getRunBudgetExceeded(task, status)
      if (!exceeded) return
      yield* ensureBudgetApproval(task, candidate, exceeded)
      throw new BudgetExceededError({
        taskID: task.id,
        limit: exceeded.limit,
        used: exceeded.used,
      })
    })

    const ensureBudgetApproval = Effect.fn("Research.ensureBudgetApproval")(function* (
      task: ResearchTask,
      candidate: ResearchCandidate | undefined,
      exceeded: { readonly limit: number; readonly used: number },
    ) {
      return yield* ensurePendingApproval({
        taskID: task.id,
        candidateID: candidate?.id,
        kind: "budget",
        reason: `Run budget exhausted: used ${exceeded.used} of max ${exceeded.limit}. Increase budget or stop the task.`,
      })
    })

    const ensureRunApprovalGates = Effect.fn("Research.ensureRunApprovalGates")(function* (
      task: ResearchTask,
      candidate: ResearchCandidate,
      stage: ResearchRun["stage"],
    ) {
      const predecessor = predecessorStage(stage)
      if (predecessor && taskRequiresStagePromotion(task)) {
        const succeededPredecessor = yield* db((d) =>
          d
            .select({ id: ResearchRunTable.id })
            .from(ResearchRunTable)
            .where(
              and(
                eq(ResearchRunTable.task_id, task.id),
                eq(ResearchRunTable.candidate_id, candidate.id),
                eq(ResearchRunTable.stage, predecessor),
                eq(ResearchRunTable.status, "succeeded"),
              ),
            )
            .get(),
        )
        if (!succeededPredecessor) {
          const protocolOverride = yield* db((d) =>
            d
              .select({ id: ResearchApprovalTable.id })
              .from(ResearchApprovalTable)
              .where(
                and(
                  eq(ResearchApprovalTable.task_id, task.id),
                  eq(ResearchApprovalTable.candidate_id, candidate.id),
                  eq(ResearchApprovalTable.kind, "protocol"),
                  eq(ResearchApprovalTable.status, "approved"),
                ),
              )
              .get(),
          )
          if (!protocolOverride) {
            yield* ensurePendingApproval({
              taskID: task.id,
              candidateID: candidate.id,
              kind: "protocol",
              reason: `Stage promotion blocked: ${stage} requires a succeeded ${predecessor} run or protocol override.`,
            })
            throw new ApprovalRequiredError({
              taskID: task.id,
              candidateID: candidate.id,
              kind: "protocol",
            })
          }
        }
      }

      if (stageRequiresDomainActionApproval(stage) && candidateUsesNativeDomainAction(candidate.candidateSpec)) {
        // Autonomous mode: native domain actions are implicitly approved along with the candidate
        const candidateAutoApproved =
          task.mode === "autonomous" &&
          (candidate.approvalStatus === "auto_approved" || candidate.approvalStatus === "approved")
        if (!candidateAutoApproved) {
          const approval = yield* db((d) =>
            d
              .select({ id: ResearchApprovalTable.id })
              .from(ResearchApprovalTable)
              .where(
                and(
                  eq(ResearchApprovalTable.task_id, task.id),
                  eq(ResearchApprovalTable.candidate_id, candidate.id),
                  eq(ResearchApprovalTable.kind, "domain_action"),
                  eq(ResearchApprovalTable.status, "approved"),
                ),
              )
              .get(),
          )
          if (!approval) {
            yield* ensurePendingApproval({
              taskID: task.id,
              candidateID: candidate.id,
              kind: "domain_action",
              reason: `Approve native TimeRecipe actions before ${stage} execution.`,
            })
            throw new ApprovalRequiredError({
              taskID: task.id,
              candidateID: candidate.id,
              kind: "domain_action",
            })
          }
        }
      }

      if (stage !== "ref_test" && stage !== "blind_test") return
      if (stage === "blind_test") {
        const approval = yield* db((d) =>
          d
            .select({ id: ResearchApprovalTable.id })
            .from(ResearchApprovalTable)
            .where(
              and(
                eq(ResearchApprovalTable.task_id, task.id),
                eq(ResearchApprovalTable.candidate_id, candidate.id),
                eq(ResearchApprovalTable.kind, "blind_test"),
                eq(ResearchApprovalTable.status, "approved"),
              ),
            )
            .get(),
        )
        if (!approval) {
          yield* ensurePendingApproval({
            taskID: task.id,
            candidateID: candidate.id,
            kind: "blind_test",
            reason: "Approve external blind test before blind_test execution.",
          })
          throw new ApprovalRequiredError({
            taskID: task.id,
            candidateID: candidate.id,
            kind: "blind_test",
          })
        }
        yield* ensurePromotionQueryLimit(task, candidate, "blind_test")
        return
      }

      if (taskRequiresShadowHoldout(task)) {
        const approval = yield* db((d) =>
          d
            .select({ id: ResearchApprovalTable.id })
            .from(ResearchApprovalTable)
            .where(
              and(
                eq(ResearchApprovalTable.task_id, task.id),
                eq(ResearchApprovalTable.candidate_id, candidate.id),
                eq(ResearchApprovalTable.kind, "shadow_holdout"),
                eq(ResearchApprovalTable.status, "approved"),
              ),
            )
            .get(),
        )
        if (!approval) {
          yield* ensurePendingApproval({
            taskID: task.id,
            candidateID: candidate.id,
            kind: "shadow_holdout",
            reason: "Approve blind/shadow holdout before ref_test execution.",
          })
          throw new ApprovalRequiredError({
            taskID: task.id,
            candidateID: candidate.id,
            kind: "shadow_holdout",
          })
        }
      }

      const approval = yield* db((d) =>
        d
          .select({ id: ResearchApprovalTable.id })
          .from(ResearchApprovalTable)
          .where(
            and(
              eq(ResearchApprovalTable.task_id, task.id),
              eq(ResearchApprovalTable.candidate_id, candidate.id),
              eq(ResearchApprovalTable.kind, "ref_test"),
              eq(ResearchApprovalTable.status, "approved"),
            ),
          )
          .get(),
      )
      if (!approval) {
        yield* ensurePendingApproval({
          taskID: task.id,
          candidateID: candidate.id,
          kind: "ref_test",
          reason: "Approve reference test before ref_test execution.",
        })
        throw new ApprovalRequiredError({
          taskID: task.id,
          candidateID: candidate.id,
          kind: "ref_test",
        })
      }

      yield* ensurePromotionQueryLimit(task, candidate, "ref_test")
    })

    const ensurePromotionQueryLimit = Effect.fn("Research.ensurePromotionQueryLimit")(function* (
      task: ResearchTask,
      candidate: ResearchCandidate,
      stage: Extract<ResearchRun["stage"], "ref_test" | "blind_test">,
    ) {
      const limit = promotionQueryLimit(task, stage)
      if (limit === undefined) return
      const used = yield* db((d) =>
        d
          .select({ id: ResearchRunTable.id })
          .from(ResearchRunTable)
          .where(
            and(
              eq(ResearchRunTable.task_id, task.id),
              eq(ResearchRunTable.stage, stage),
              ne(ResearchRunTable.status, "rejected"),
            ),
          )
          .all(),
      ).pipe(Effect.map((rows) => rows.length))
      if (used < limit) return
      yield* ensureBudgetApproval(task, candidate, { limit, used })
      throw new BudgetExceededError({
        taskID: task.id,
        limit,
        used,
      })
    })

    const createRun = Effect.fn("Research.createRun")(function* (input: CreateRunInput) {
      const task = yield* getTask(input.taskID)
      const candidate = yield* getCandidateForTask(input.taskID, input.candidateID)
      assertCandidateApproved(task.id, candidate)
      const status = input.status ?? "queued"
      if (input.stage !== "ref_test" && input.stage !== "blind_test") {
        yield* ensureRunBudget(task, status, candidate)
      }
      yield* ensureRunApprovalGates(task, candidate, input.stage)
      const time = nowTime()
      const row = yield* db((d) =>
        d
          .insert(ResearchRunTable)
          .values({
            id: ResearchRunID.ascending(),
            task_id: input.taskID,
            candidate_id: input.candidateID,
            stage: input.stage,
            status,
            metrics: input.metrics ?? {},
            resource_usage: input.resourceUsage ?? {},
            artifact_refs: input.artifactRefs ? [...input.artifactRefs] : [],
            time_created: time.created,
            time_updated: time.updated,
            time_started: status === "running" ? time.created : undefined,
          })
          .returning()
          .get(),
      )
      const run = mapRun(row)
      yield* bus.publish(Event.RunCreated, { run })
      if (
        (run.status === "queued" || run.status === "running") &&
        task.status !== "researching" &&
        task.status !== "paused" &&
        task.status !== "completed" &&
        task.status !== "failed"
      ) {
        yield* updateTaskStatus({ taskID: task.id, status: "researching" })
      }
      if (run.status === "succeeded") yield* evaluateSucceededRun(run)
      if (run.status === "failed" || run.status === "rejected") yield* recordFailedRunMemory(run)
      return run
    })

    const prepareRunInternal = Effect.fn("Research.prepareRunInternal")(function* (
      input: PrepareRunInput,
      options: { readonly enqueueRuntimeJob: boolean },
    ) {
      const task = yield* getTask(input.taskID)
      const candidate = yield* getCandidateForTask(input.taskID, input.candidateID)
      assertCandidateApproved(task.id, candidate)

      const stage = input.stage ?? "smoke"
      const candidateSpec = input.seed === undefined ? candidate.candidateSpec : candidateSpecWithSeed(candidate.candidateSpec, input.seed)
      const runPlan = DomainRegistry.createRunPlan(task.domainID, {
        taskSpec: task.taskSpec,
        candidateSpec,
        stage: stage as DomainRunStage,
        description: input.description,
      })
      if (!runPlan.validation.ok) {
        throw new Error(`Research candidate failed domain validation: ${runPlan.validation.issues[0]?.message}`)
      }
      yield* ensureRunApprovalGates(task, candidate, stage)

      const run = yield* createRun({
        taskID: task.id,
        candidateID: candidate.id,
        stage,
        status: "queued",
        resourceUsage: input.seed === undefined ? undefined : ({ seed: input.seed } as ResearchRun["resourceUsage"]),
      })

      const root = runnerPath(Instance.directory, ".neo-research/run-plans")
      const directory = path.join(root, task.id)
      const outputPath = path.join(directory, `${run.id}.json`)
      yield* Effect.promise(async () => {
        await mkdir(directory, { recursive: true })
        await writeFile(
          outputPath,
          `${JSON.stringify(
            {
              taskID: task.id,
              candidateID: candidate.id,
              runID: run.id,
              stage,
              runPlan,
            },
            null,
            2,
          )}\n`,
          "utf8",
        )
      })
      const runPlanArtifact = yield* createArtifact({
        taskID: task.id,
        runID: run.id,
        kind: "runner_plan_json",
        uri: `file://${outputPath}`,
        metadata: {
          runnerID: runPlan.runnerID,
          runnerKind: runPlan.runnerKind,
          stage,
          candidateID: candidate.id,
        },
      })
      const runWithPlanArtifact = yield* updateRunStatus({
        runID: run.id,
        status: "queued",
        artifactRefs: [runPlanArtifact.id],
      })

      if (options.enqueueRuntimeJob) {
        yield* Effect.promise(async () => {
          const runtime = createFileResearchRuntime(runnerPath(Instance.directory, ".neo-research/runtime"))
          await runtime.queue.enqueue(
            researchJobFromRunPlan({
              taskID: task.id,
              runID: runWithPlanArtifact.id,
              runPlan,
              now: runWithPlanArtifact.time.created,
            }),
          )
        })
      }

      return { run: runWithPlanArtifact, runPlan }
    })

    const prepareRun = Effect.fn("Research.prepareRun")(function* (input: PrepareRunInput) {
      return yield* prepareRunInternal(input, { enqueueRuntimeJob: true })
    })

    const loadQueuedPreparedRun = Effect.fn("Research.loadQueuedPreparedRun")(function* (input: PrepareRunInput) {
      const stage = input.stage ?? "smoke"
      const row = yield* db((d) =>
        d
          .select()
          .from(ResearchRunTable)
          .where(
            and(
              eq(ResearchRunTable.task_id, input.taskID),
              eq(ResearchRunTable.candidate_id, input.candidateID),
              eq(ResearchRunTable.stage, stage),
              eq(ResearchRunTable.status, "queued"),
            ),
          )
          .orderBy(desc(ResearchRunTable.time_created))
          .get(),
      )
      if (!row) return undefined
      const run = mapRun(row)

      const artifactRow = yield* db((d) =>
        d
          .select()
          .from(ResearchArtifactTable)
          .where(and(eq(ResearchArtifactTable.run_id, run.id), eq(ResearchArtifactTable.kind, "runner_plan_json")))
          .orderBy(desc(ResearchArtifactTable.time_created))
          .get(),
      )
      if (!artifactRow) return undefined

      const artifact = mapArtifact(artifactRow)
      if (!artifact.uri.startsWith("file://")) return undefined
      const payload = yield* Effect.promise(async () =>
        JSON.parse(await readFile(artifact.uri.slice("file://".length), "utf8")),
      )
      return {
        run,
        runPlan: DomainRunPlanSchema.parse((payload as { runPlan?: unknown }).runPlan),
      } satisfies PreparedRun
    })

    const evaluateSucceededRun = Effect.fn("Research.evaluateSucceededRun")(function* (run: ResearchRun) {
      const task = yield* getTask(run.taskID)
      if (!run.candidateID) return
      const candidate = yield* getCandidateForTask(task.id, run.candidateID)
      const taskFingerprint = DomainRegistry.summarizeTask(task.domainID, task.taskSpec)
      const evaluation =
        DomainRegistry.evaluateRun(task.domainID, { task, candidate, run }) ?? fallbackRunEvaluation(task, run)
      const metricName = evaluation.primaryMetricName
      const primaryMetric = evaluation.primaryMetric
      if (primaryMetric === undefined) return

      const direction = evaluation.direction
      const existingChampion = yield* getChampion(task.id)
      let comparisonMetric = primaryMetric
      let championUpdated =
        !existingChampion || isBetterMetric(direction, comparisonMetric, existingChampion.primaryMetric)
      const seedGate: Record<string, unknown> = {}
      let championStandoff: Record<string, unknown> | undefined

      const requiredSeedCount = taskEvaluationSeeds(task).length
      if (existingChampion && existingChampion.candidateID !== run.candidateID && requiredSeedCount > 1) {
        const runs = yield* listRuns(task.id)
        const challengerSummary = metricSampleSummary(
          metricSamplesForCandidate(runs, run.candidateID, metricName, run.stage),
        )
        const championSummary = metricSampleSummary(
          metricSamplesForCandidate(runs, existingChampion.candidateID, metricName, run.stage),
        )
        seedGate.requiredSeeds = requiredSeedCount
        seedGate.observedSeeds = challengerSummary.count
        if (challengerSummary.mean !== undefined) {
          seedGate.mean = challengerSummary.mean
          seedGate.std = challengerSummary.std
          seedGate.ci95 = challengerSummary.ci95
        }

        if (challengerSummary.count < requiredSeedCount || challengerSummary.mean === undefined) {
          championUpdated = false
          seedGate.status = "awaiting_seed_confirmation"
        } else {
          comparisonMetric = challengerSummary.mean
          const championComparisonMetric = championSummary.mean ?? existingChampion.primaryMetric
          const hasComparableUncertainty = challengerSummary.count > 1 && championSummary.count > 1
          const inconclusive =
            hasComparableUncertainty &&
            intervalsOverlap(
              challengerSummary.mean,
              challengerSummary.ci95,
              championComparisonMetric,
              championSummary.ci95,
            )
          championUpdated =
            !inconclusive && isBetterMetric(direction, comparisonMetric, championComparisonMetric)
          seedGate.status = inconclusive ? "uncertainty_overlap" : "seed_confirmed"
          seedGate.championMean = championSummary.mean
          seedGate.championObservedSeeds = championSummary.count
        }
      }

      if (championUpdated && existingChampion && existingChampion.candidateID !== run.candidateID) {
        const secondaryMetricName = objectiveSecondaryMetricName(task.objective, metricName)
        if (secondaryMetricName !== undefined) {
          const challengerSecondary = metricValue(run.metrics, secondaryMetricName)
          const championRun = yield* getRunForTask(task.id, existingChampion.runID)
          const championSecondary = metricValue(championRun.metrics, secondaryMetricName)
          if (
            challengerSecondary !== undefined &&
            championSecondary !== undefined &&
            isBetterMetric(direction, championSecondary, challengerSecondary)
          ) {
            championUpdated = false
            championStandoff = {
              status: "secondary_metric_regressed",
              primaryMetricName: metricName,
              secondaryMetricName,
              challengerPrimary: comparisonMetric,
              championPrimary: existingChampion.primaryMetric,
              challengerSecondary,
              championSecondary,
              championCandidateID: existingChampion.candidateID,
              championRunID: existingChampion.runID,
            }
          }
        }
      }

      if (championUpdated) {
        yield* setChampion({
          taskID: task.id,
          candidateID: run.candidateID,
          runID: run.id,
          primaryMetric: comparisonMetric,
          utility: direction === "minimize" ? -comparisonMetric : comparisonMetric,
        })
      }

      const evalDataset = recordValue(recordValue(task.taskSpec).dataset)
      const evalSourceCsv = datasetSourceKey(evalDataset)
      yield* createMemory({
        taskID: task.id,
        domainID: task.domainID,
        fingerprintSummary: {
          ...taskFingerprint,
          taskID: task.id,
          domainID: task.domainID,
          primaryMetricName: metricName,
          direction,
          sourceCsv: evalSourceCsv,
        },
        candidateSummary: runCandidateMemorySummary(candidate, run, {
          primaryMetric: comparisonMetric,
          championUpdated,
          ...(Object.keys(seedGate).length === 0 ? {} : { seedGate }),
          ...(championStandoff === undefined ? {} : { championStandoff }),
        }),
        outcome: championUpdated ? "accepted" : "rejected",
        lesson: championUpdated
          ? `[dataset:${evalSourceCsv}] Candidate ${run.candidateID} became champion on ${metricName}=${comparisonMetric}.`
          : championStandoff !== undefined
            ? `[dataset:${evalSourceCsv}] Candidate ${run.candidateID} champion standoff on ${metricName}=${comparisonMetric}; ${championStandoff.secondaryMetricName} regressed versus ${championStandoff.championCandidateID}.`
          : `[dataset:${evalSourceCsv}] Candidate ${run.candidateID} did not improve champion on ${metricName}=${comparisonMetric}.`,
      })
    })

    const recordFailedRunMemory = Effect.fn("Research.recordFailedRunMemory")(function* (run: ResearchRun) {
      const task = yield* getTask(run.taskID)
      const taskFingerprint = DomainRegistry.summarizeTask(task.domainID, task.taskSpec)
      const candidate = run.candidateID === undefined ? undefined : yield* getCandidateForTask(task.id, run.candidateID)
      const failedDataset = recordValue(recordValue(task.taskSpec).dataset)
      const failedSourceCsv = datasetSourceKey(failedDataset)
      yield* createMemory({
        taskID: task.id,
        domainID: task.domainID,
        fingerprintSummary: {
          ...taskFingerprint,
          taskID: task.id,
          domainID: task.domainID,
          status: run.status,
          sourceCsv: failedSourceCsv,
        },
        candidateSummary: runCandidateMemorySummary(candidate, run, {
          status: run.status,
        }),
        outcome: "failed",
        lesson: `[dataset:${failedSourceCsv}] Candidate ${run.candidateID} failed during ${run.stage}: ${run.error ?? run.status}`,
      })
    })

    const executePreparedRun = Effect.fn("Research.executePreparedRun")(function* (
      prepared: PreparedRun,
      options: { readonly completeQueuedRuntimeJob?: boolean } = {},
    ) {
      if (options.completeQueuedRuntimeJob) {
        yield* Effect.promise(async () => {
          const runtime = createFileResearchRuntime(runnerPath(Instance.directory, ".neo-research/runtime"))
          const job = researchJobFromRunPlan({
            taskID: prepared.run.taskID,
            runID: prepared.run.id,
            runPlan: prepared.runPlan,
            now: prepared.run.time.created,
          })
          await runtime.queue.complete(job.id)
        })
      }

      const running = yield* updateRunStatus({ runID: prepared.run.id, status: "running" })
      let progressPublishQueue = Promise.resolve()
      const persistedProgressLines: JsonRecord[] = []
      const publishProgressLine = Instance.bind((line: string) => {
        const parsed = parseProgressLine(line)
        persistedProgressLines.push({
          time: new Date().toISOString(),
          line,
          ...parsed,
        } as JsonRecord)
        progressPublishQueue = progressPublishQueue
          .then(() =>
            Effect.runPromise(
              bus.publish(Event.RunnerProgressLine, {
                taskID: running.taskID,
                runID: running.id,
                line,
                ...parsed,
              }),
            ),
          )
          .catch(() => undefined)
      })
      const execution = yield* Effect.promise(async () => {
        const result = await executeRunnerPlan(prepared.runPlan, publishProgressLine)
        await progressPublishQueue
        return result
      })
      const metrics = metricsFromRecords(execution.records, prepared.runPlan.stage)
      const artifactRefs: ResearchArtifactID[] = [...running.artifactRefs]

      const executionLogRoot = runnerPath(Instance.directory, ".neo-research/runner-executions")
      const executionLogDirectory = path.join(executionLogRoot, running.taskID)
      const executionLogPath = path.join(executionLogDirectory, `${running.id}.json`)
      yield* Effect.promise(async () => {
        await mkdir(executionLogDirectory, { recursive: true })
        await writeFile(
          executionLogPath,
          `${JSON.stringify(
            {
              taskID: running.taskID,
              candidateID: running.candidateID,
              runID: running.id,
              runnerID: prepared.runPlan.runnerID,
              runnerKind: prepared.runPlan.runnerKind,
              stage: prepared.runPlan.stage,
              command: {
                executable: prepared.runPlan.command.executable,
                args: prepared.runPlan.command.args,
                cwd: prepared.runPlan.command.cwd,
              },
              exitCode: execution.exitCode,
              stdout: execution.stdout,
              stderr: execution.stderr,
              records: execution.records,
            },
            null,
            2,
          )}\n`,
          "utf8",
        )
      })
      const executionLogArtifact = yield* createArtifact({
        taskID: running.taskID,
        runID: running.id,
        kind: "runner_execution_log_json",
        uri: `file://${executionLogPath}`,
        metadata: {
          runnerID: prepared.runPlan.runnerID,
          runnerKind: prepared.runPlan.runnerKind,
          stage: prepared.runPlan.stage,
          exitCode: execution.exitCode,
          recordCount: execution.records.length,
        },
      })
      artifactRefs.push(executionLogArtifact.id)

      if (persistedProgressLines.length > 0) {
        const progressRoot = runnerPath(Instance.directory, ".neo-research/runner-progress")
        const progressDirectory = path.join(progressRoot, running.taskID)
        const progressPath = path.join(progressDirectory, `${running.id}.jsonl`)
        yield* Effect.promise(async () => {
          await mkdir(progressDirectory, { recursive: true })
          await writeFile(
            progressPath,
            `${persistedProgressLines.map((item) => JSON.stringify(item)).join("\n")}\n`,
            "utf8",
          )
        })
        const progressArtifact = yield* createArtifact({
          taskID: running.taskID,
          runID: running.id,
          kind: "runner_progress_jsonl",
          uri: `file://${progressPath}`,
          metadata: {
            runnerID: prepared.runPlan.runnerID,
            runnerKind: prepared.runPlan.runnerKind,
            stage: prepared.runPlan.stage,
            lineCount: persistedProgressLines.length,
            previewLines: persistedProgressLines.slice(-30),
          },
        })
        artifactRefs.push(progressArtifact.id)
      }

      for (const artifactDir of artifactDirsFromRecords(execution.records)) {
        const artifact = yield* createArtifact({
          taskID: running.taskID,
          runID: running.id,
          kind: "runner_artifact",
          uri: `file://${artifactDir}`,
          metadata: {
            runnerID: prepared.runPlan.runnerID,
            stage: prepared.runPlan.stage,
          },
        })
        artifactRefs.push(artifact.id)
      }

      const runnerTrainingSucceeded = execution.records.some(
        (r) => r["event"] === "done" && r["status"] === "success",
      )
      const succeeded = execution.exitCode === 0 || runnerTrainingSucceeded
      const task = yield* getTask(running.taskID)
      const reproducibility = succeeded
        ? yield* Effect.promise(() => buildReproducibilitySeal(task, prepared.runPlan, Instance.directory))
        : undefined
      const run = yield* updateRunStatus({
        runID: running.id,
        status: succeeded ? "succeeded" : "failed",
        metrics: metrics as ResearchRun["metrics"],
        resourceUsage: {
          ...running.resourceUsage,
          exitCode: execution.exitCode,
          runnerID: prepared.runPlan.runnerID,
          ...(reproducibility === undefined ? {} : { reproducibility }),
        } as ResearchRun["resourceUsage"],
        artifactRefs,
        error: succeeded ? undefined : execution.stderr || `Runner exited with code ${execution.exitCode}`,
      })

      return { run, runPlan: prepared.runPlan }
    })

    const executeRun = Effect.fn("Research.executeRun")(function* (input: PrepareRunInput) {
      const queued = yield* loadQueuedPreparedRun(input)
      if (queued !== undefined) return yield* executePreparedRun(queued, { completeQueuedRuntimeJob: true })

      const prepared = yield* prepareRunInternal(input, { enqueueRuntimeJob: false })
      return yield* executePreparedRun(prepared)
    })

    const executeSeedSweep = Effect.fn("Research.executeSeedSweep")(function* (input: ExecuteSeedSweepInput) {
      const task = yield* getTask(input.taskID)
      const seeds = taskEvaluationSeeds(task, input.seeds)
      const runs: PreparedRun[] = []
      for (const seed of seeds) {
        const description =
          input.description === undefined ? undefined : `${input.description} (seed ${seed})`
        const prepared = yield* executeRun({
          taskID: input.taskID,
          candidateID: input.candidateID,
          stage: input.stage,
          description,
          seed,
        })
        runs.push(prepared)
      }
      return { seeds, runs }
    })

    const writeCandidateSelectionArtifact = Effect.fn("Research.writeCandidateSelectionArtifact")(function* (input: {
      readonly task: ResearchTask
      readonly candidate: ResearchCandidate
      readonly run: ResearchRun
      readonly taskFingerprint: JsonRecord
      readonly selectionSource: "existing_frontier" | "domain_proposal"
      readonly rankings: DomainCandidateRanking[]
      readonly readyCandidateIDs: ResearchCandidateID[]
      readonly attemptedCandidateIDs: ResearchCandidateID[]
      readonly inconclusiveCandidateIDs: ResearchCandidateID[]
    }) {
      const dir = path.join(Instance.directory, ".neo-research", "candidate-selection", input.task.id)
      const file = path.join(dir, `${input.run.id}.json`)
      const rankings = input.rankings.map(rankingArtifactRecord)
      const rankPredictor = rankPredictorArtifactRecord(input.rankings)
      const selectedRecipeID = candidateRecipeID(input.candidate.candidateSpec)
      const payload = {
        taskID: input.task.id,
        domainID: input.task.domainID,
        runID: input.run.id,
        stage: input.run.stage,
        status: input.run.status,
        selectedCandidateID: input.candidate.id,
        selectedRecipeID,
        selectionSource: input.selectionSource,
        generatedAt: new Date().toISOString(),
        taskFingerprint: input.taskFingerprint,
        readyCandidateIDs: input.readyCandidateIDs,
        attemptedCandidateIDs: input.attemptedCandidateIDs,
        inconclusiveCandidateIDs: input.inconclusiveCandidateIDs,
        rankPredictor,
        rankings,
      }
      yield* Effect.promise(async () => {
        await mkdir(dir, { recursive: true })
        await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
      })
      return yield* createArtifact({
        taskID: input.task.id,
        runID: input.run.id,
        kind: "research_candidate_selection_json",
        uri: `file://${file}`,
        metadata: {
          candidateID: input.candidate.id,
          runID: input.run.id,
          stage: input.run.stage,
          selectionSource: input.selectionSource,
          rankingCount: rankings.length,
          inconclusiveCandidateCount: input.inconclusiveCandidateIDs.length,
          rankPredictorVersion: rankPredictor.version,
          ...(typeof rankPredictor.historyMemoryCount === "number"
            ? { historyMemoryCount: rankPredictor.historyMemoryCount }
            : {}),
          ...(typeof rankPredictor.historyTaskMemoryCount === "number"
            ? { historyTaskMemoryCount: rankPredictor.historyTaskMemoryCount }
            : {}),
          ...(typeof rankPredictor.historyDomainMemoryCount === "number"
            ? { historyDomainMemoryCount: rankPredictor.historyDomainMemoryCount }
            : {}),
          ...(typeof rankPredictor.memoryEvidenceCount === "number"
            ? { memoryEvidenceCount: rankPredictor.memoryEvidenceCount }
            : {}),
          ...(typeof rankPredictor.benchmarkEvidenceCount === "number"
            ? { benchmarkEvidenceCount: rankPredictor.benchmarkEvidenceCount }
            : {}),
          ...(typeof rankPredictor.metricEvidenceCount === "number"
            ? { metricEvidenceCount: rankPredictor.metricEvidenceCount }
            : {}),
          ...(selectedRecipeID === undefined ? {} : { selectedRecipeID }),
          ...(rankings[0] === undefined ? {} : { topScore: rankings[0].score }),
        },
      })
    })

    const writeManagerTraceArtifact = Effect.fn("Research.writeManagerTraceArtifact")(function* (input: {
      readonly task: ResearchTask
      readonly candidate: ResearchCandidate
      readonly run: ResearchRun
      readonly managerTrace: ResearchManagerStep[]
    }) {
      const dir = path.join(Instance.directory, ".neo-research", "manager-trace", input.task.id)
      const file = path.join(dir, `${input.run.id}.json`)
      const payload = {
        taskID: input.task.id,
        candidateID: input.candidate.id,
        selectedCandidateID: input.candidate.id,
        runID: input.run.id,
        stage: input.run.stage,
        status: input.run.status,
        generatedAt: new Date().toISOString(),
        managerTrace: input.managerTrace,
      }
      const designMetadata = input.managerTrace.find((step) => step.role === "design")?.metadata
      const librarianMetadata = input.managerTrace.find((step) => step.role === "librarian")?.metadata
      const designModelDesignerResult =
        designMetadata && typeof designMetadata === "object" && !Array.isArray(designMetadata)
          ? (designMetadata.modelDesignerResult as Record<string, unknown> | undefined)
          : undefined
      yield* Effect.promise(async () => {
        await mkdir(dir, { recursive: true })
        await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
      })
      return yield* createArtifact({
        taskID: input.task.id,
        runID: input.run.id,
        kind: "research_manager_trace_json",
        uri: `file://${file}`,
        metadata: {
          candidateID: input.candidate.id,
          selectedCandidateID: input.candidate.id,
          runID: input.run.id,
          stage: input.run.stage,
          status: input.run.status,
          roleCount: input.managerTrace.length,
          roles: input.managerTrace.map((step) => step.role),
          ...(typeof designMetadata?.rankPredictorVersion === "string"
            ? { rankPredictorVersion: designMetadata.rankPredictorVersion }
            : {}),
          ...(typeof librarianMetadata?.memoryWriteOutcome === "string"
            ? { memoryWriteOutcome: librarianMetadata.memoryWriteOutcome }
            : {}),
          ...(typeof designMetadata?.llmStatus === "string" ? { llmStatus: designMetadata.llmStatus } : {}),
          ...(typeof designMetadata?.llmModel === "string" ? { llmModel: designMetadata.llmModel } : {}),
          ...(typeof designMetadata?.llmProvider === "string" ? { llmProvider: designMetadata.llmProvider } : {}),
          ...(typeof designMetadata?.llmError === "string" ? { llmError: designMetadata.llmError } : {}),
          ...(typeof designModelDesignerResult?.hypothesis === "string" && designModelDesignerResult.hypothesis
            ? { llmHypothesis: designModelDesignerResult.hypothesis }
            : {}),
          ...(typeof designMetadata?.recipeID === "string" && designMetadata.recipeID
            ? { llmRecipeID: designMetadata.recipeID }
            : {}),
        },
      })
    })

    const writeModelCompileArtifact = Effect.fn("Research.writeModelCompileArtifact")(function* (input: {
      readonly task: ResearchTask
      readonly run: ResearchRun
      readonly compilerResult: ModelCompilerResult
    }) {
      const dir = path.join(Instance.directory, ".neo-research", "compile-reports", input.task.id)
      const file = path.join(dir, `${input.run.id}.md`)
      yield* Effect.promise(async () => {
        await mkdir(dir, { recursive: true })
        await writeFile(file, input.compilerResult.compileReportMarkdown, "utf8")
      })
      return yield* createArtifact({
        taskID: input.task.id,
        runID: input.run.id,
        kind: "model_compile_report_md",
        uri: `file://${file}`,
        metadata: {
          agent: input.compilerResult.agent,
          candidateID: input.compilerResult.candidateID,
          runID: input.compilerResult.runID,
          status: input.compilerResult.status,
          smokeMetric: input.compilerResult.smokeMetric ?? null,
          failureReason: input.compilerResult.failureReason ?? null,
        },
      })
    })

    const attachArtifactRefToRun = Effect.fn("Research.attachArtifactRefToRun")(function* (
      run: ResearchRun,
      artifactID: ResearchArtifactID,
    ) {
      const artifactRefs: ResearchArtifactID[] = run.artifactRefs.includes(artifactID)
        ? [...run.artifactRefs]
        : [...run.artifactRefs, artifactID]
      const row = yield* db((d) =>
        d
          .update(ResearchRunTable)
          .set({
            artifact_refs: artifactRefs,
            time_updated: Date.now(),
          })
          .where(eq(ResearchRunTable.id, run.id))
          .returning()
          .get(),
      )
      if (!row) throw missing("Research run", run.id)
      const updated = mapRun(row)
      yield* bus.publish(Event.RunUpdated, { run: updated })
      return updated
    })

    const writeAutonomousLoopArtifact = Effect.fn("Research.writeAutonomousLoopArtifact")(function* (input: {
      readonly task: ResearchTask
      readonly iterations: AutonomousIterationResult[]
      readonly stoppedReason: AutonomousLoopStoppedReason
    }) {
      const artifactPathID = ResearchArtifactID.ascending()
      const dir = path.join(Instance.directory, ".neo-research", "autonomous-loop", input.task.id)
      const file = path.join(dir, `${artifactPathID}.json`)
      const primaryMetricName = objectiveMetricName(input.task.objective)
      const succeededCount = input.iterations.filter((iteration) => iteration.run.status === "succeeded").length
      const failedCount = input.iterations.filter((iteration) => iteration.run.status === "failed").length
      const inconclusiveCount = input.iterations.filter(
        (iteration) =>
          iteration.run.status === "succeeded" && metricValue(iteration.run.metrics, primaryMetricName) === undefined,
      ).length
      const payload = {
        taskID: input.task.id,
        domainID: input.task.domainID,
        stoppedReason: input.stoppedReason,
        iterationCount: input.iterations.length,
        succeededCount,
        failedCount,
        inconclusiveCount,
        generatedAt: new Date().toISOString(),
        iterations: input.iterations.map((iteration, index) => ({
          index: index + 1,
          candidateID: iteration.candidate.id,
          recipeID: candidateRecipeID(iteration.candidate.candidateSpec),
          runID: iteration.run.id,
          stage: iteration.run.stage,
          status: iteration.run.status,
          metrics: iteration.run.metrics,
          artifactRefs: iteration.run.artifactRefs,
          seededCandidateCount: iteration.seededCandidates.length,
          approvalCount: iteration.approvals.length,
          managerTraceRoles: iteration.managerTrace.map((step) => step.role),
        })),
      }
      yield* Effect.promise(async () => {
        await mkdir(dir, { recursive: true })
        await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
      })
      return yield* createArtifact({
        taskID: input.task.id,
        kind: "research_autonomous_loop_json",
        uri: `file://${file}`,
        metadata: {
          stoppedReason: input.stoppedReason,
          iterationCount: input.iterations.length,
          succeededCount,
          failedCount,
          inconclusiveCount,
          runIDs: input.iterations.map((iteration) => iteration.run.id),
          candidateIDs: input.iterations.map((iteration) => iteration.candidate.id),
        },
      })
    })

    const finishAutonomousLoop = Effect.fn("Research.finishAutonomousLoop")(function* (input: {
      readonly task: ResearchTask
      readonly iterations: AutonomousIterationResult[]
      readonly stoppedReason: AutonomousLoopStoppedReason
    }) {
      const artifact = yield* writeAutonomousLoopArtifact(input)

      if (input.iterations.length > 0) {
        const reflection = yield* runReflectionAgent({
          taskID: input.task.id,
          stoppedReason: input.stoppedReason,
        }).pipe(
          Effect.catchCause(() =>
            Effect.succeed({
              agent: "ReflectionAgent" as const,
              taskID: input.task.id,
              reflectionNotesMarkdown: "",
              nextExperimentPlanMarkdown: "",
              failureLogMarkdown: "",
              analysis: {
                primaryMetricName: "val_avg_mse",
                direction: "minimize" as const,
                succeededRuns: 0,
                failedRuns: 0,
                rejectedRuns: 0,
                plateauStreak: 0,
                effectiveChanges: [],
                ineffectiveChanges: [],
                failures: [],
                nextHypotheses: [],
                decision: "continue" as const,
                decisionReason: "Reflection failed",
              },
              llm: { status: "failed" as const },
            }),
          ),
        )

        const hypothesisTitles = reflection.analysis.nextHypotheses.map((h) => h.title)
        if (hypothesisTitles.length > 0) {
          // Read fresh from DB so we preserve workflow state (updateTaskSpec would strip it).
          const freshTask = yield* getTask(input.task.id)
          const freshMeta = recordValue(freshTask.taskSpec.metadata)
          const nextTaskSpec = {
            ...freshTask.taskSpec,
            metadata: { ...freshMeta, reflectionHypotheses: hypothesisTitles } as unknown as JsonRecord,
          }
          const reflRow = yield* db((d) =>
            d
              .update(ResearchTaskTable)
              .set({ task_spec: nextTaskSpec, time_updated: Date.now() })
              .where(and(eq(ResearchTaskTable.id, input.task.id), eq(ResearchTaskTable.project_id, Instance.project.id)))
              .returning()
              .get(),
          )
          if (reflRow) yield* bus.publish(Event.TaskUpdated, { task: mapTask(reflRow) })
        }
      }

      return {
        iterations: input.iterations,
        stoppedReason: input.stoppedReason,
        artifact,
      }
    })

    const runAutonomousIteration = Effect.fn("Research.runAutonomousIteration")(function* (
      input: AutonomousIterationInput,
    ) {
      const task = yield* getTask(input.taskID)
      if (task.mode !== "autonomous") throw new Error(`Research task is not autonomous: ${task.id}`)
      yield* ensureRunBudget(task, "queued")
      const forceExplore = input.forceExplore === true
      const baseFingerprint = DomainRegistry.summarizeTask(task.domainID, task.taskSpec)

      const existingMeta =
        typeof task.taskSpec.metadata === "object" && task.taskSpec.metadata !== null && !Array.isArray(task.taskSpec.metadata)
          ? (task.taskSpec.metadata as Record<string, unknown>)
          : {}
      const reflectionHypotheses = Array.isArray(existingMeta.reflectionHypotheses)
        ? (existingMeta.reflectionHypotheses as string[])
        : []
      const hypothesisPlan = experimentPlanFromMetadata(existingMeta.hypothesisPlan)
      const selectedHypothesis = selectHypothesisForDesign(hypothesisPlan)

      const taskFingerprint = buildModelDesignerTaskFingerprint({
        baseFingerprint,
        hypothesisPlan,
        selectedHypothesis,
        reflectionHypotheses,
      })
      const taskFingerprintWithExploration = forceExplore
        ? ({
            ...taskFingerprint,
            searchBiases: [
              ...new Set([
                ...(Array.isArray(taskFingerprint.searchBiases) ? taskFingerprint.searchBiases : []),
                "explore_untried_backbone",
              ]),
            ],
          } as JsonRecord)
        : taskFingerprint
      const mergedSearchBiases = Array.isArray(taskFingerprintWithExploration.searchBiases)
        ? (taskFingerprintWithExploration.searchBiases as unknown[])
        : []

      const managerTrace: ResearchManagerStep[] = [
        managerStep("diagnostic", "completed", "Built task fingerprint for autonomous planning.", {
          domainID: task.domainID,
          targetCount: (taskFingerprintWithExploration as Record<string, unknown>).targetCount,
          contextLength: (taskFingerprintWithExploration as Record<string, unknown>).contextLength,
          maxPredictionLength: (taskFingerprintWithExploration as Record<string, unknown>).maxPredictionLength,
          bridgeOnly: (taskFingerprintWithExploration as Record<string, unknown>).bridgeOnly,
          searchBiases: mergedSearchBiases,
          explorationMode: forceExplore ? "forced" : "balanced",
          reflectionHypothesesCount: reflectionHypotheses.length,
        }),
      ]

      let seeded: SeedBaselinesResult = { candidates: [], approvals: [] }
      let candidates = yield* listCandidates(task.id)
      if (candidates.length === 0) {
        seeded = yield* seedBaselines({ taskID: task.id }).pipe(
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause)
            return Effect.sync(() => {
              throw new SeedBaselinesError({
                taskID: task.id,
                message: error instanceof Error ? error.message : String(error),
              })
            })
          }),
        )
        candidates = seeded.candidates
      }

      const runs = yield* listRuns(task.id)
      const primaryMetricName = objectiveMetricName(task.objective)
      const designerSelection = selectModelDesignerCandidate({
        candidates,
        runs,
        primaryMetricName,
        maxFailedRetries: maxFailedCandidateRetries(task),
      })
      const readyCandidateIDs = [...designerSelection.readyCandidateIDs]
      const attemptState = {
        attemptedCandidateIDs: new Set(designerSelection.attemptedCandidateIDs),
        inconclusiveCandidateIDs: new Set(designerSelection.inconclusiveCandidateIDs),
      }
      let candidate = forceExplore ? undefined : designerSelection.candidate

      const proposalApprovals: ResearchApproval[] = []
      let proposalCreated = false
      let explorationFallback = false
      let selectionSource: "existing_frontier" | "domain_proposal" = "existing_frontier"
      let rankings: DomainCandidateRanking[] = [...designerSelection.rankings]
      let llmMetadata: JsonRecord = {}
      if (!candidate) {
        const memory = yield* listRelatedMemory(task)
        const champion = yield* getChampion(task.id)
        const proposalContext = {
          taskSpec: task.taskSpec,
          taskFingerprint: taskFingerprintWithExploration,
          candidates: candidates.map((item) => ({
            id: item.id,
            candidateSpec: item.candidateSpec,
            approvalStatus: item.approvalStatus,
            generatedBy: item.generatedBy,
          })),
          runs: runs
            .filter((run): run is ResearchRun & { candidateID: ResearchCandidateID } => run.candidateID !== undefined)
            .map((run) => ({
              candidateID: run.candidateID,
              stage: run.stage,
              status: run.status,
              metrics: run.metrics,
            })),
          memory: memory.map((item) => ({
            scope: item.taskID === task.id ? ("task" as const) : ("domain" as const),
            outcome: item.outcome,
            lesson: item.lesson,
            fingerprintSummary: item.fingerprintSummary,
            candidateSummary: item.candidateSummary,
            time: item.time.updated,
          })),
          champion:
            champion === undefined
              ? undefined
              : {
                  candidateID: champion.candidateID,
                  primaryMetric: champion.primaryMetric,
                  utility: champion.utility,
                },
        }
        const dataAnalysisMarkdown = buildDatasetAnalysisReportMarkdown({
          task,
          fingerprint: taskFingerprintWithExploration,
        })
        const hypoPlanMarkdown = hypothesisPlan !== undefined
          ? buildHypothesesYaml(hypothesisPlan)
          : undefined
        const previousReflectionMarkdown = reflectionHypotheses.length > 0
          ? yield* Effect.gen(function* () {
              const artifacts = yield* listArtifacts(task.id)
              const notesArtifact = artifacts.find((item) => item.kind === "reflection_notes_md")
              if (!notesArtifact) return undefined
              const contentPath = filePathFromURI(notesArtifact.uri)
              if (!contentPath) return undefined
              return yield* Effect.promise(async () => {
                try { return await readFile(contentPath, "utf8") }
                catch { return undefined }
              })
            }).pipe(Effect.orElseSucceed(() => undefined as string | undefined))
          : undefined
        const authJsonKey = yield* Effect.promise(() => resolveApiKeyFromAuthJson())
        const llmResult = yield* Effect.promise(() =>
          proposeLLMCandidate({
            task,
            proposalContext,
            workspaceRoot: Instance.directory,
            dataAnalysisMarkdown,
            ...(hypoPlanMarkdown ? { hypoPlanMarkdown } : {}),
            ...(previousReflectionMarkdown ? { previousReflectionMarkdown } : {}),
            ...(authJsonKey ? { authJsonKey } : {}),
          }),
        )
        llmMetadata = llmResult.metadata
        let proposal: DomainCandidateProposal | undefined
        if (llmResult.proposal) {
          const validation = DomainRegistry.validateCandidate(task.domainID, {
            taskSpec: task.taskSpec,
            candidateSpec: llmResult.proposal.candidateSpec,
          })
          if (validation.ok) {
            proposal = llmResult.proposal
          } else {
            llmMetadata = {
              ...llmMetadata,
              llmStatus: "invalid",
              llmError: validation.issues[0]?.message ?? "LLM candidate failed domain validation",
            }
          }
        }
        rankings = DomainRegistry.rankCandidateProposals(task.domainID, proposalContext)
        if (!proposal) proposal = DomainRegistry.proposeCandidate(task.domainID, proposalContext)

        if (proposal) {
          proposalCreated = true
          selectionSource = "domain_proposal"
          const approvalStatus =
            task.mode === "autonomous" ? "auto_approved" : proposal.approvalStatus
          candidate = yield* createCandidate({
            taskID: task.id,
            domainID: task.domainID,
            candidateSpec: proposal.candidateSpec,
            rationale: proposal.rationale,
            riskLevel: proposal.riskLevel,
            approvalStatus,
            generatedBy: proposal.generatedBy,
          })
          candidates = [candidate, ...candidates]

          if (candidate.approvalStatus === "pending") {
            const approval = yield* createApproval({
              taskID: task.id,
              candidateID: candidate.id,
              kind: "candidate",
              reason: "Review generated autonomous mutation before execution.",
            })
            proposalApprovals.push(approval)
          }
        }
      }
      if (!candidate && forceExplore && designerSelection.candidate) {
        candidate = designerSelection.candidate
        selectionSource = "existing_frontier"
        explorationFallback = true
        rankings = [...designerSelection.rankings]
      }
      if (!candidate) throw new Error(`No approved autonomous candidate is ready for task: ${task.id}`)

      const rankPredictor = rankPredictorArtifactRecord(rankings)
      const topRanking = rankings[0]
      const topRankedRecipeID = topRanking === undefined ? undefined : rankingRecipeID(topRanking)
      const selectedRecipeID = candidateRecipeID(candidate.candidateSpec)
      const designSummary = proposalCreated
        ? "Designed a new candidate from task fingerprint, run history, champion, and memory."
        : "Selected an approved candidate already queued in the frontier."
      const modelDesignerResult = buildModelDesignerResult({
        taskID: task.id,
        candidate,
        selectedHypothesis,
        rationale: designSummary,
        llmStatus: modelDesignerLLMStatusFromMetadata(llmMetadata, candidate.generatedBy, selectionSource),
        selectionSource,
      })
      managerTrace.push(
        managerStep(
          "design",
          "completed",
          designSummary,
          {
            agent: modelDesignerResult.agent,
            modelDesignerResult,
            candidateID: candidate.id,
            selectedCandidateID: candidate.id,
            recipeID: selectedRecipeID,
            selectedRecipeID,
            selectionSource,
            generatedBy: candidate.generatedBy,
            riskLevel: candidate.riskLevel,
            approvalStatus: candidate.approvalStatus,
            seededCandidateCount: seeded.candidates.length,
            readyCandidateCount: readyCandidateIDs.length,
            attemptedCandidateCount: attemptState.attemptedCandidateIDs.size,
            inconclusiveCandidateCount: attemptState.inconclusiveCandidateIDs.size,
            proposalCreated,
            explorationMode: forceExplore ? "forced" : "balanced",
            explorationFallback,
            rankingCount: rankings.length,
            rankPredictorVersion: rankPredictor.version,
            ...(topRankedRecipeID === undefined ? {} : { topRankedRecipeID }),
            ...(typeof rankPredictor.memoryEvidenceCount === "number"
              ? { memoryEvidenceCount: rankPredictor.memoryEvidenceCount }
              : {}),
            ...(typeof rankPredictor.benchmarkEvidenceCount === "number"
              ? { benchmarkEvidenceCount: rankPredictor.benchmarkEvidenceCount }
              : {}),
            ...llmMetadata,
          },
        ),
      )
      yield* bus.publish(Event.ModelDesignerCompleted, {
        taskID: task.id,
        agent: "ModelDesignerAgent",
        stage: "design",
        status: "completed",
        metadata: {
          candidateID: candidate.id,
          candidateSpec: candidate.candidateSpec,
          recipeID: selectedRecipeID ?? null,
          selectionSource,
          generatedBy: candidate.generatedBy,
          riskLevel: candidate.riskLevel,
          ...llmMetadata,
          ...(typeof modelDesignerResult.hypothesis === "string" && modelDesignerResult.hypothesis
            ? { llmHypothesis: modelDesignerResult.hypothesis }
            : {}),
        },
      })
      managerTrace.push(
        managerStep(
          "coder",
          proposalCreated ? "completed" : "skipped",
          proposalCreated
            ? "Materialized the proposed declarative recipe as a persisted research candidate."
            : "No code change was required because an existing candidate was ready.",
          {
            candidateID: candidate.id,
            selectedCandidateID: candidate.id,
            recipeID: selectedRecipeID,
          },
        ),
      )

      const requestedStage = input.stage ?? "smoke"
      if (
        requestedStage !== "smoke" &&
        stageRequiresDomainActionApproval(requestedStage) &&
        candidateUsesNativeDomainAction(candidate.candidateSpec)
      ) {
        yield* ensureRunApprovalGates(task, candidate, requestedStage)
      }

      const memoryBeforeRun = yield* listMemory(task.id)
      let compileRun = yield* executeRun({
        taskID: task.id,
        candidateID: candidate.id,
        stage: "smoke",
        description: input.description,
      })
      const compilerResult = buildModelCompilerResult({
        taskID: task.id,
        candidateID: candidate.id,
        smokeRun: compileRun.run,
      })
      if (compilerResult.status !== "passed" && compileRun.run.status !== "failed") {
        compileRun = {
          ...compileRun,
          run: yield* updateRunStatus({
            runID: compileRun.run.id,
            status: "failed",
            error: compilerResult.failureReason ?? `ModelCompilerAgent marked smoke as ${compilerResult.status}.`,
          }),
        }
      }
      const compileArtifact = yield* writeModelCompileArtifact({
        task,
        run: compileRun.run,
        compilerResult,
      })
      compileRun = {
        ...compileRun,
        run: yield* attachArtifactRefToRun(compileRun.run, compileArtifact.id),
      }

      let executed = compileRun
      if (requestedStage !== "smoke" && compilerResult.status === "passed") {
        executed = yield* executeRun({
          taskID: task.id,
          candidateID: candidate.id,
          stage: requestedStage,
          description: input.description,
        })
      }
      // --- Verifier Agent: run post-execution checks only when primary metric is present ---
      let finalRun = executed.run
      const primaryMetric = metricValue(executed.run.metrics, primaryMetricName)
      let verifierReportForTrainEval: VerifierReport | undefined
      if (executed.run.status === "succeeded" && primaryMetric !== undefined) {
        const prevRuns =
          executed.run.id === compileRun.run.id
            ? runs.filter((r) => r.id !== executed.run.id)
            : [...runs, compileRun.run].filter((r) => r.id !== executed.run.id)
        const currentChampion = yield* getChampion(task.id)
        const verReport = runVerifiers({
          task,
          run: executed.run,
          candidate,
          previousRuns: prevRuns,
          champion: currentChampion,
        })
        verifierReportForTrainEval = verReport
        const evalMarkdown = buildEvaluationResultMarkdown({
          task,
          run: executed.run,
          candidate,
          report: verReport,
        })
        const decisionRecord = buildVerifierDecisionRecord({
          task,
          run: executed.run,
          candidate,
          report: verReport,
        })
        const evalDir = path.join(Instance.directory, ".neo-research", "evaluation-results", task.id)
        const evalPath = path.join(evalDir, `${executed.run.id}.md`)
        const decisionPath = path.join(evalDir, `${executed.run.id}.verifier_decision.json`)
        yield* Effect.promise(async () => {
          await mkdir(evalDir, { recursive: true })
          await writeFile(evalPath, evalMarkdown, "utf8")
          await writeFile(decisionPath, `${JSON.stringify(decisionRecord, null, 2)}\n`, "utf8")
        })
        const evalArtifact = yield* createArtifact({
          taskID: task.id,
          runID: executed.run.id,
          kind: "evaluation_result_md",
          uri: `file://${evalPath}`,
          metadata: {
            accepted: verReport.accepted,
            rejectReason: verReport.rejectReason ?? null,
            verifierCount: verReport.results.length,
            rejectedVerifiers: verReport.results.filter((r) => !r.accepted).map((r) => r.name),
          },
        })
        const decisionArtifact = yield* createArtifact({
          taskID: task.id,
          runID: executed.run.id,
          kind: "verifier_decision_json",
          uri: `file://${decisionPath}`,
          metadata: {
            accepted: decisionRecord.accepted,
            decision: decisionRecord.decision,
            rejectReason: decisionRecord.rejectReason,
            failureCategory: decisionRecord.failure?.category ?? null,
            recoveryAction: decisionRecord.failure?.recoveryAction.type ?? null,
            verifierCount: decisionRecord.checks.length,
          },
        })
        if (!verReport.accepted) {
          finalRun = yield* updateRunStatus({
            runID: executed.run.id,
            status: "rejected",
            error: verReport.rejectReason ?? "Rejected by VerifierAgent",
            artifactRefs: [...executed.run.artifactRefs, evalArtifact.id, decisionArtifact.id],
          })
          yield* bus.publish(Event.RunRejectedByVerifier, {
            taskID: task.id,
            agent: "VerifierAgent",
            stage: "verification",
            status: "completed",
            metadata: {
              runID: executed.run.id,
              accepted: false,
              rejectReason: verReport.rejectReason ?? null,
              verifierCount: verReport.results.length,
            },
          })
        } else {
          finalRun = yield* attachArtifactRefToRun(executed.run, evalArtifact.id)
          finalRun = yield* attachArtifactRefToRun(finalRun, decisionArtifact.id)
          yield* bus.publish(Event.RunVerified, {
            taskID: task.id,
            agent: "VerifierAgent",
            stage: "verification",
            status: "completed",
            metadata: {
              runID: executed.run.id,
              accepted: true,
              verifierCount: verReport.results.length,
            },
          })
        }
        managerTrace.push(
          managerStep(
            "verifier",
            verReport.accepted ? "completed" : "blocked",
            verReport.accepted
              ? "VerifierAgent accepted the run after all checks passed."
              : `VerifierAgent rejected the run: ${verReport.rejectReason}`,
            {
              runID: executed.run.id,
              selectedCandidateID: candidate.id,
              verifierAccepted: verReport.accepted,
              ...(verReport.rejectReason !== undefined ? { rejectReason: verReport.rejectReason } : {}),
              rejectedVerifiers: verReport.results.filter((r) => !r.accepted).map((r) => r.name),
            },
          ),
        )
      }

      const trainEvalResult: TrainEvalResult | undefined =
        requestedStage === "low_fidelity" || requestedStage === "full"
          ? buildTrainEvalResult({
              taskID: task.id,
              run: finalRun,
              candidate,
              stage: requestedStage,
              primaryMetricName,
              ...(verifierReportForTrainEval === undefined ? {} : { verifierReport: verifierReportForTrainEval }),
            })
          : undefined

      const runSucceeded = finalRun.status === "succeeded"
      managerTrace.push(
        managerStep(
          "runner",
          runSucceeded ? "completed" : "blocked",
          runSucceeded
            ? "Prepared and executed the selected candidate run."
            : "Runner execution failed or was rejected for the selected candidate.",
          {
            runID: finalRun.id,
            selectedCandidateID: candidate.id,
            stage: finalRun.stage,
            status: finalRun.status,
            metrics: finalRun.metrics,
            modelCompilerResult: compilerResult,
            ...(trainEvalResult === undefined ? {} : { trainEvalResult }),
            ...(finalRun.error === undefined ? {} : { error: finalRun.error }),
            rankPredictorVersion: rankPredictor.version,
          },
        ),
      )

      const primaryMetricMissing = finalRun.status === "succeeded" && primaryMetric === undefined
      managerTrace.push(
        managerStep(
          "analyst",
          primaryMetricMissing ? "blocked" : primaryMetric === undefined ? "skipped" : "completed",
          primaryMetricMissing
            ? "Run succeeded but did not produce the primary metric; marked the candidate inconclusive."
            : primaryMetric === undefined
              ? "Skipped metric analysis because the run did not produce the primary metric."
              : "Analyzed run metrics against the task objective.",
          {
            runID: finalRun.id,
            selectedCandidateID: candidate.id,
            selectedRecipeID,
            primaryMetricName,
            ...(primaryMetric === undefined ? {} : { primaryMetric }),
            ...(primaryMetricMissing ? { primaryMetricMissing: true } : {}),
            direction: objectiveDirection(task.objective),
            rankPredictorVersion: rankPredictor.version,
          },
        ),
      )

      const memory = yield* listMemory(task.id)
      const memoryWriteOutcome = memory.length > memoryBeforeRun.length ? "recorded" : "skipped"
      managerTrace.push(
        managerStep(
          "librarian",
          memory.length > 0 ? "completed" : "skipped",
          memory.length > 0
            ? "Recorded the latest run lesson in research memory."
            : "No memory entry was recorded for this run.",
          {
            selectedCandidateID: candidate.id,
            runID: executed.run.id,
            memoryCount: memory.length,
            memoryBeforeRunCount: memoryBeforeRun.length,
            memoryWriteOutcome,
            latestMemoryID: memory[0]?.id,
            latestLesson: memory[0]?.lesson,
          },
        ),
      )

      const selectionArtifact = yield* writeCandidateSelectionArtifact({
        task,
        candidate,
        run: finalRun,
        taskFingerprint: taskFingerprintWithExploration,
        selectionSource,
        rankings,
        readyCandidateIDs,
        attemptedCandidateIDs: [...attemptState.attemptedCandidateIDs],
        inconclusiveCandidateIDs: [...attemptState.inconclusiveCandidateIDs],
      })
      const selectedRun = yield* attachArtifactRefToRun(finalRun, selectionArtifact.id)

      const managerTraceArtifact = yield* writeManagerTraceArtifact({
        task,
        candidate,
        run: selectedRun,
        managerTrace,
      })
      const run = yield* attachArtifactRefToRun(selectedRun, managerTraceArtifact.id)

      return {
        ...executed,
        run,
        candidate,
        seededCandidates: seeded.candidates,
        approvals: [...seeded.approvals, ...proposalApprovals],
        managerTrace,
        selectionArtifact,
      }
    })

    const getAutonomousLoopStopReason = Effect.fn("Research.getAutonomousLoopStopReason")(function* (
      task: ResearchTask,
    ) {
      const candidates = yield* listCandidates(task.id)
      if (candidates.length === 0) return undefined

      const runs = yield* listRuns(task.id)
      const attemptState = modelDesignerCandidateAttemptStateFromRuns({
        runs,
        maxFailedRetries: maxFailedCandidateRetries(task),
        primaryMetricName: objectiveMetricName(task.objective),
      })
      const hasReadyCandidate = candidates.some(
        (candidate) =>
          (candidate.approvalStatus === "approved" || candidate.approvalStatus === "auto_approved") &&
          !attemptState.attemptedCandidateIDs.has(candidate.id),
      )
      if (hasReadyCandidate) return undefined

      const hasPendingCandidate = candidates.some((candidate) => candidate.approvalStatus === "pending")
      if (hasPendingCandidate) return "approval_required" as const

      const pendingApprovals = yield* listApprovals({ taskID: task.id, status: "pending" })
      const hasBlockingApproval = pendingApprovals.some((approval) => approval.kind !== "ref_test")
      return hasBlockingApproval ? ("approval_required" as const) : undefined
    })

    const runAutonomousLoop = Effect.fn("Research.runAutonomousLoop")(function* (input: AutonomousLoopInput) {
      const iterations: AutonomousIterationResult[] = []
      const task = yield* getTask(input.taskID)
      if (task.mode !== "autonomous") throw new Error(`Research task is not autonomous: ${task.id}`)
      const maxIterations = autonomousLoopMaxIterations(input.maxIterations, task)
      const direction = objectiveDirection(task.objective)
      const primaryMetricName = objectiveMetricName(task.objective)
      const targetMetricValue = loopPolicyValue(input.targetMetricValue, task, "targetMetricValue", "target")
      const minRelativeImprovement =
        loopPolicyValue(input.minRelativeImprovement, task, "minRelativeImprovement", "minImprovement") ?? 0
      const maxNoImprove = loopPolicyInteger(input.maxNoImprove, task, "maxNoImprove", "maxNoImproveRounds")
      const timeBudgetSeconds = loopPolicyValue(input.timeBudgetSeconds, task, "timeBudgetSeconds", "timeBudgetS")
      const maxCrashStreak = loopPolicyInteger(input.maxCrashStreak, task, "maxCrashStreak")
      const explorationRate = loopPolicyRate(input.explorationRate, task, "explorationRate", "exploration")
      const startedAt = Date.now()
      let bestMetric: number | undefined
      let noImproveStreak = 0
      let crashStreak = 0
      for (let index = 0; index < maxIterations; index++) {
        if (timeBudgetSeconds !== undefined && Date.now() - startedAt >= timeBudgetSeconds * 1000) {
          return yield* finishAutonomousLoop({ task, iterations, stoppedReason: "time_budget_exhausted" })
        }
        const budgetExceeded = yield* getRunBudgetExceeded(task, "queued")
        if (budgetExceeded) {
          yield* ensureBudgetApproval(task, undefined, budgetExceeded)
          return yield* finishAutonomousLoop({ task, iterations, stoppedReason: "budget_exhausted" })
        }
        const blockedReason = yield* getAutonomousLoopStopReason(task)
        if (blockedReason) return yield* finishAutonomousLoop({ task, iterations, stoppedReason: blockedReason })

        const description =
          input.description === undefined ? undefined : `${input.description} (iteration ${index + 1})`
        const iterationResult = yield* runAutonomousIteration({
          taskID: input.taskID,
          stage: input.stage,
          description,
          forceExplore: shouldForceExplorationIteration(index, explorationRate),
        }).pipe(
          Effect.map((iteration) => ({ status: "iteration" as const, iteration })),
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause)
            if (ApprovalRequiredError.isInstance(error)) {
              return finishAutonomousLoop({ task, iterations, stoppedReason: "approval_required" }).pipe(
                Effect.map((result) => ({ status: "stopped" as const, result })),
              )
            }
            if (SeedBaselinesError.isInstance(error)) {
              return finishAutonomousLoop({ task, iterations, stoppedReason: "seed_failed" }).pipe(
                Effect.map((result) => ({ status: "stopped" as const, result })),
              )
            }
            return Effect.failCause(cause)
          }),
        )
        if (iterationResult.status === "stopped") return iterationResult.result
        iterations.push(iterationResult.iteration)
        if (iterationResult.iteration.run.status === "failed") {
          crashStreak += 1
          if (maxCrashStreak !== undefined && crashStreak >= maxCrashStreak) {
            return yield* finishAutonomousLoop({ task, iterations, stoppedReason: "crash_streak_exceeded" })
          }
        } else {
          crashStreak = 0
        }
        const metric = metricValue(iterationResult.iteration.run.metrics, primaryMetricName)
        if (metric !== undefined) {
          const improved =
            bestMetric === undefined ||
            isMeaningfulMetricImprovement(direction, metric, bestMetric, minRelativeImprovement)
          if (improved) {
            bestMetric = metric
            noImproveStreak = 0
          } else {
            noImproveStreak += 1
          }
          const targetReached =
            targetMetricValue !== undefined &&
            (direction === "minimize" ? metric <= targetMetricValue : metric >= targetMetricValue)
          if (targetReached) return yield* finishAutonomousLoop({ task, iterations, stoppedReason: "target_reached" })
          if (maxNoImprove !== undefined && noImproveStreak >= maxNoImprove) {
            return yield* finishAutonomousLoop({ task, iterations, stoppedReason: "plateau" })
          }
        }
        // Per-iteration reflection: run after every TrainEval, LLM-augmented, non-blocking.
        yield* runReflectionAgent({ taskID: input.taskID }).pipe(Effect.catchCause(() => Effect.void))
        if (timeBudgetSeconds !== undefined && Date.now() - startedAt >= timeBudgetSeconds * 1000) {
          return yield* finishAutonomousLoop({ task, iterations, stoppedReason: "time_budget_exhausted" })
        }
      }
      return yield* finishAutonomousLoop({ task, iterations, stoppedReason: "max_iterations" })
    })

    const updateRunStatus = Effect.fn("Research.updateRunStatus")(function* (input: UpdateRunStatusInput) {
      const existingRow = yield* db((d) =>
        d.select().from(ResearchRunTable).where(eq(ResearchRunTable.id, input.runID)).get(),
      )
      if (!existingRow) throw missing("Research run", input.runID)
      yield* getTask(existingRow.task_id)

      const now = Date.now()
      const timeStarted =
        input.status === "running" && existingRow.time_started === null ? now : existingRow.time_started
      const error = input.error ?? (input.status === "failed" || input.status === "rejected" ? existingRow.error : null)
      const row = yield* db((d) =>
        d
          .update(ResearchRunTable)
          .set({
            status: input.status,
            metrics: input.metrics ?? existingRow.metrics,
            resource_usage: input.resourceUsage ?? existingRow.resource_usage,
            artifact_refs: input.artifactRefs ? [...input.artifactRefs] : existingRow.artifact_refs,
            error,
            time_updated: now,
            time_started: timeStarted,
            time_finished: isTerminal(input.status) ? now : null,
          })
          .where(eq(ResearchRunTable.id, input.runID))
          .returning()
          .get(),
      )
      if (!row) throw missing("Research run", input.runID)
      const run = mapRun(row)
      yield* bus.publish(Event.RunUpdated, { run })
      if (input.status === "succeeded" && existingRow.status !== "succeeded") {
        yield* evaluateSucceededRun(run)
      }
      if ((input.status === "failed" || input.status === "rejected") && existingRow.status !== input.status) {
        yield* recordFailedRunMemory(run)
      }
      return run
    })

    const listRuns = Effect.fn("Research.listRuns")(function* (taskID: ResearchTaskID) {
      yield* getTask(taskID)
      const rows = yield* db((d) =>
        d
          .select()
          .from(ResearchRunTable)
          .where(eq(ResearchRunTable.task_id, taskID))
          .orderBy(desc(ResearchRunTable.time_updated))
          .all(),
      )
      return rows.map(mapRun)
    })

    const createArtifact = Effect.fn("Research.createArtifact")(function* (input: CreateArtifactInput) {
      yield* getTask(input.taskID)
      if (input.runID) yield* getRunForTask(input.taskID, input.runID)
      const time = nowTime()
      const row = yield* db((d) =>
        d
          .insert(ResearchArtifactTable)
          .values({
            id: ResearchArtifactID.ascending(),
            task_id: input.taskID,
            run_id: input.runID,
            kind: input.kind,
            uri: input.uri,
            metadata: input.metadata ?? {},
            time_created: time.created,
            time_updated: time.updated,
          })
          .returning()
          .get(),
      )
      const artifact = mapArtifact(row)
      yield* bus.publish(Event.ArtifactCreated, { artifact })
      return artifact
    })

    const listArtifacts = Effect.fn("Research.listArtifacts")(function* (taskID: ResearchTaskID) {
      yield* getTask(taskID)
      const rows = yield* db((d) =>
        d
          .select()
          .from(ResearchArtifactTable)
          .where(eq(ResearchArtifactTable.task_id, taskID))
          .orderBy(desc(ResearchArtifactTable.time_updated))
          .all(),
      )
      return rows.map(mapArtifact)
    })

    const prepareTaskDataset = Effect.fn("Research.prepareTaskDataset")(function* (input: PrepareTaskDatasetInput) {
      const task = yield* getTask(input.taskID)
      const command = buildPrepareDatasetCommand(task, input.force ?? true)
      const execution = yield* Effect.promise(() =>
        Process.run([command.executable, ...command.args], {
          cwd: command.cwd,
          nothrow: true,
          timeout: 300_000,
        }),
      )
      if (execution.code !== 0) {
        const stderr = execution.stderr.toString().trim()
        throw new Error(stderr || `Neo-Cast prepare-data failed with code ${execution.code}`)
      }
      const datasetSpec = yield* Effect.promise(() => readPreparedDatasetSpec(command.cwd))
      const root = runnerPath(Instance.directory, input.outputDir ?? ".neo-research/datasets")
      const directory = path.join(root, task.id)
      const outputPath = path.join(directory, "dataset-preparation.json")
      const payload = {
        taskID: task.id,
        domainID: task.domainID,
        generatedAt: new Date().toISOString(),
        command: {
          executable: command.executable,
          args: command.args,
          cwd: command.cwd,
          exitCode: execution.code,
          warnings: command.warnings,
        },
        stdout: execution.stdout.toString(),
        stderr: execution.stderr.toString(),
        datasetSpec,
      }
      yield* Effect.promise(async () => {
        await mkdir(directory, { recursive: true })
        await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
      })
      const artifact = yield* createArtifact({
        taskID: task.id,
        kind: "dataset_preparation_json",
        uri: `file://${outputPath}`,
        metadata: {
          format: "json",
          taskID: task.id,
          source: command.source,
          runnerRoot: command.cwd,
          inputLen: typeof datasetSpec.input_len === "number" ? datasetSpec.input_len : 0,
          horizons: Array.isArray(datasetSpec.horizons) ? datasetSpec.horizons.join(",") : "",
          featureColumns: Array.isArray(datasetSpec.feature_columns) ? datasetSpec.feature_columns.join(",") : "",
          warnings: command.warnings.join("\n"),
        },
      })
      return {
        artifact,
        path: outputPath,
        datasetSpec,
        command: payload.command as JsonRecord,
      }
    })

    const readTaskExportSnapshot = Effect.fn("Research.readTaskExportSnapshot")(function* (taskID: ResearchTaskID) {
      const projectID = Instance.project.id
      return yield* Effect.try({
        try: () =>
          Database.transaction((d) => {
            const taskRow = d
              .select()
              .from(ResearchTaskTable)
              .where(and(eq(ResearchTaskTable.id, taskID), eq(ResearchTaskTable.project_id, projectID)))
              .get()
            if (!taskRow) throw missing("Research task", taskID)

            const candidateRows = d
              .select()
              .from(ResearchCandidateTable)
              .where(eq(ResearchCandidateTable.task_id, taskID))
              .orderBy(desc(ResearchCandidateTable.time_updated))
              .all()
            const runRows = d
              .select()
              .from(ResearchRunTable)
              .where(eq(ResearchRunTable.task_id, taskID))
              .orderBy(desc(ResearchRunTable.time_updated))
              .all()
            const approvalRows = d
              .select()
              .from(ResearchApprovalTable)
              .where(eq(ResearchApprovalTable.task_id, taskID))
              .orderBy(desc(ResearchApprovalTable.time_updated))
              .all()
            const artifactRows = d
              .select()
              .from(ResearchArtifactTable)
              .where(eq(ResearchArtifactTable.task_id, taskID))
              .orderBy(desc(ResearchArtifactTable.time_updated))
              .all()
            const memoryRows = d
              .select()
              .from(ResearchMemoryTable)
              .where(eq(ResearchMemoryTable.task_id, taskID))
              .orderBy(desc(ResearchMemoryTable.time_updated))
              .all()
            const championRow = d
              .select()
              .from(ResearchChampionTable)
              .where(eq(ResearchChampionTable.task_id, taskID))
              .get()

            return {
              task: mapTask(taskRow),
              candidates: candidateRows.map(mapCandidate),
              runs: runRows.map(mapRun),
              approvals: approvalRows.map(mapApproval),
              artifacts: artifactRows.map(mapArtifact),
              memory: memoryRows.map(mapMemory),
              champion: championRow ? mapChampion(championRow) : undefined,
            }
          }),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error: unknown) =>
          Effect.sync(() => {
            throw error
          }),
        ),
      )
    })

    const exportTaskArtifact = Effect.fn("Research.exportTaskArtifact")(function* (input: ExportTaskArtifactInput) {
      const { task, candidates, runs, approvals, artifacts, memory, champion } = yield* readTaskExportSnapshot(
        input.taskID,
      )
      const kind = input.kind ?? "research_report_markdown"
      const experimentAnalysis = analyzeExperimentResults({ task, candidates, runs, champion })
      const lineage = candidateLineageStats(candidates)
      const domainArtifact = DomainRegistry.renderArtifact(task.domainID, {
        kind,
        task,
        candidates,
        runs,
        approvals,
        artifacts,
        memory,
        champion,
      })
      const content =
        domainArtifact?.content ??
        renderResearchReportMarkdown({
          task,
          candidates,
          runs,
          approvals,
          artifacts,
          memory,
          champion,
        })

      const experimentAnalysisContent = renderExperimentAnalysisMarkdown(experimentAnalysis)
      const lineageContent = renderCandidateLineageMarkdown(candidates)
      const root = runnerPath(Instance.directory, input.outputDir ?? ".neo-research/artifacts")
      const directory = path.join(root, task.id)
      const sections = [content, lineageContent, experimentAnalysisContent]
        .map((section) => section.trim())
        .filter((section) => section.length > 0)
      if (kind === "research_final_bundle" || kind === "model_export_package") {
        const reportDirectory = path.join(directory, "report")
        const reportsDirectory = path.join(directory, "reports")
        const resultsDirectory = path.join(directory, "results")
        const releaseArtifactsDirectory = path.join(directory, "artifacts")
        const configsDirectory = path.join(directory, "configs")
        const experimentsDirectory = path.join(directory, "experiments")
        const modelDirectory = path.join(directory, "model")
        const traceDirectory = path.join(directory, "trace")
        const refTestDirectory = path.join(directory, "ref_test")
        const reportPath = path.join(reportDirectory, "research-report.md")
        const finalReportPath = path.join(reportsDirectory, "final_report.md")
        const releasePackagePath = path.join(releaseArtifactsDirectory, "release_package.md")
        const runsPath = path.join(resultsDirectory, "runs.json")
        const candidatesPath = path.join(resultsDirectory, "candidates.json")
        const championPath = path.join(resultsDirectory, "champion.json")
        const artifactsPath = path.join(resultsDirectory, "artifacts.json")
        const approvalsPath = path.join(resultsDirectory, "approvals.json")
        const memoryPath = path.join(resultsDirectory, "memory.json")
        const manifestPath = path.join(directory, "manifest.json")
        const championRunnerArtifact =
          champion === undefined
            ? undefined
            : artifacts.find((artifact) => artifact.kind === "runner_artifact" && artifact.runID === champion.runID)
        const championRun = champion === undefined ? undefined : runs.find((run) => run.id === champion.runID)
        const championReproducibility =
          championRun === undefined ? {} : recordValue(recordValue(championRun.resourceUsage).reproducibility)
        const championRefTestRun =
          champion === undefined
            ? undefined
            : runs.find(
                (r) => r.candidateID === champion.candidateID && r.stage === "ref_test" && r.status === "succeeded",
              )
        const championRefTestMetrics =
          championRefTestRun === undefined
            ? undefined
            : Object.fromEntries(
                Object.entries(championRefTestRun.metrics as Record<string, unknown>).filter(
                  ([k, v]) => k.startsWith("ref_test_") && typeof v === "number",
                ),
              )
        const championArtifactDir =
          championRunnerArtifact === undefined ? undefined : filePathFromURI(championRunnerArtifact.uri)
        const championRefTestRunnerArtifact =
          championRefTestRun === undefined
            ? undefined
            : artifacts.find((artifact) => artifact.kind === "runner_artifact" && artifact.runID === championRefTestRun.id)
        const championRefTestArtifactDir =
          championRefTestRunnerArtifact === undefined ? undefined : filePathFromURI(championRefTestRunnerArtifact.uri)
        const copiedFiles: Record<string, string> = {
          report: "report/research-report.md",
          finalReport: "reports/final_report.md",
          releasePackage: "artifacts/release_package.md",
          runs: "results/runs.json",
          candidates: "results/candidates.json",
          champion: "results/champion.json",
          artifacts: "results/artifacts.json",
          approvals: "results/approvals.json",
          memory: "results/memory.json",
          manifest: "manifest.json",
        }
        const standardArtifactCopies = [
          ["nas_search_space_yaml", configsDirectory, "search_space.yaml", "searchSpace"],
          ["nas_best_model_config_yaml", configsDirectory, "best_model_config.yaml", "bestModelConfig"],
          ["nas_model_search_plan_md", experimentsDirectory, "model_search_plan.md", "modelSearchPlan"],
          ["nas_experiment_log_md", experimentsDirectory, "experiment_log.md", "experimentLog"],
          ["nas_leaderboard_md", experimentsDirectory, "leaderboard.md", "leaderboard"],
          ["nas_evaluation_result_md", experimentsDirectory, "evaluation_result.md", "evaluationResult"],
          ["nas_reflection_notes_md", experimentsDirectory, "reflection_notes.md", "reflectionNotes"],
          ["reflection_notes_md", experimentsDirectory, "final_reflection.md", "finalReflection"],
          ["next_experiment_plan_md", experimentsDirectory, "next_experiment_plan.md", "nextExperimentPlan"],
          ["failure_log_md", experimentsDirectory, "failure_log.md", "failureLog"],
          ["nas_best_model_py", modelDirectory, "best_model.py", "bestModelPy"],
          ["nas_training_script_py", modelDirectory, "training_script.py", "trainingScript"],
        ] as const
	        const modelCopies = [
	          ["model.pt", "modelWeights"],
	          ["model_impl.py", "modelImpl"],
	          ["inference.py", "inference"],
	          ["metadata.json", "modelMetadata"],
	          ["model_spec.json", "modelSpec"],
	          ["patch_bundle.json", "patchBundle"],
	          ["preprocess.json", "preprocess"],
	          ["tool_schema.json", "toolSchema"],
	          ["mcp_server.py", "mcpServer"],
	          ["requirements.txt", "requirements"],
	          ["README.md", "readme"],
	          ["example.py", "example"],
	          ["eval_report.md", "evalReport"],
	        ] as const

        yield* Effect.promise(async () => {
          await mkdir(reportDirectory, { recursive: true })
          await mkdir(reportsDirectory, { recursive: true })
          await mkdir(resultsDirectory, { recursive: true })
          await mkdir(releaseArtifactsDirectory, { recursive: true })
          await mkdir(configsDirectory, { recursive: true })
          await mkdir(experimentsDirectory, { recursive: true })
          await mkdir(modelDirectory, { recursive: true })
          await mkdir(traceDirectory, { recursive: true })
          await mkdir(refTestDirectory, { recursive: true })
          await writeFile(reportPath, `${sections.join("\n\n")}\n`, "utf8")
          await writeFile(finalReportPath, `${sections.join("\n\n")}\n`, "utf8")
          await writeFile(runsPath, `${JSON.stringify(runs, null, 2)}\n`, "utf8")
          await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`, "utf8")
          await writeFile(championPath, `${JSON.stringify(champion ?? null, null, 2)}\n`, "utf8")
          await writeFile(artifactsPath, `${JSON.stringify(artifacts, null, 2)}\n`, "utf8")
          await writeFile(approvalsPath, `${JSON.stringify(approvals, null, 2)}\n`, "utf8")
          await writeFile(memoryPath, `${JSON.stringify(memory, null, 2)}\n`, "utf8")
          if (championArtifactDir !== undefined) {
            for (const [filename, manifestKey] of modelCopies) {
              const source = path.join(championArtifactDir, filename)
              if (!existsSync(source)) continue
              const target = path.join(modelDirectory, filename)
              await cp(source, target, { force: true })
              copiedFiles[manifestKey] = `model/${filename}`
            }
            const modelImplSource = path.join(championArtifactDir, "model_impl.py")
            if (existsSync(modelImplSource)) {
              await cp(modelImplSource, path.join(modelDirectory, "model.py"), { force: true })
              copiedFiles.modelPy = "model/model.py"
            }
          }
          for (const [artifactKind, targetDirectory, filename, manifestKey] of standardArtifactCopies) {
            const sourceArtifact = artifacts.find((artifact) => artifact.kind === artifactKind)
            const source = sourceArtifact === undefined ? undefined : filePathFromURI(sourceArtifact.uri)
            if (source === undefined || !existsSync(source)) continue
            const target = path.join(targetDirectory, filename)
            await cp(source, target, { force: true })
            copiedFiles[manifestKey] = `${path.basename(targetDirectory)}/${filename}`
          }
          if (championRefTestArtifactDir !== undefined) {
            for (const filename of ["ref_test_metrics.json", "eval_report.md"] as const) {
              const source = path.join(championRefTestArtifactDir, filename)
              if (!existsSync(source)) continue
              await cp(source, path.join(refTestDirectory, filename), { force: true })
              copiedFiles[filename === "ref_test_metrics.json" ? "refTestMetrics" : "refTestEvalReport"] =
                `ref_test/${filename}`
            }
          }
          const loopArtifacts = artifacts.filter((artifact) => artifact.kind === "research_autonomous_loop_json")
          for (const artifact of loopArtifacts) {
            const source = filePathFromURI(artifact.uri)
            if (source === undefined || !existsSync(source)) continue
            await cp(source, path.join(traceDirectory, `${artifact.id}.json`), { force: true })
          }
          const integrity = buildReleaseIntegrity(kind, copiedFiles)
          await writeFile(
            releasePackagePath,
            renderReleasePackageMarkdown({ task, kind, champion, copiedFiles, integrity }),
            "utf8",
          )
          const manifest = {
            schemaVersion:
              kind === "model_export_package"
                ? "neo_research_model_export_package.v1"
                : "neo_research_final_bundle.v1",
            taskID: task.id,
            domainID: task.domainID,
            generatedAt: new Date().toISOString(),
            champion:
              champion === undefined
                ? null
                : {
                    candidateID: champion.candidateID,
                    runID: champion.runID,
                    primaryMetric: champion.primaryMetric,
                    utility: champion.utility,
                    ...(championRefTestMetrics === undefined ? {} : { refTestMetrics: championRefTestMetrics }),
                  },
            counts: {
              candidates: candidates.length,
              runs: runs.length,
              approvals: approvals.length,
              artifacts: artifacts.length,
              memory: memory.length,
            },
            integrity,
            files: copiedFiles,
            reproducibility:
              Object.keys(championReproducibility).length === 0 ? null : championReproducibility,
          }
          await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
        })

        const artifact = yield* createArtifact({
          taskID: task.id,
          kind,
          uri: `file://${directory}`,
          metadata: {
            format: "directory",
            taskID: task.id,
            candidateCount: candidates.length,
            runCount: runs.length,
            artifactCount: artifacts.length,
            primaryMetricName: experimentAnalysis.primaryMetricName,
            copiedFiles: Object.values(copiedFiles),
            releaseIntegrityStatus: buildReleaseIntegrity(kind, copiedFiles).status,
            ...(champion === undefined
              ? {}
              : {
                  championCandidateID: champion.candidateID,
                  primaryMetricValue: champion.primaryMetric,
                }),
          },
        })
        return { artifact, path: directory }
      }

      const outputPath = path.join(directory, domainArtifact?.filename ?? "research-report.md")
      yield* Effect.promise(async () => {
        await mkdir(directory, { recursive: true })
        await writeFile(outputPath, `${sections.join("\n\n")}\n`, "utf8")
      })

      const metadata: Record<string, string | number> = {
        format: "markdown",
        taskID: task.id,
        candidateCount: candidates.length,
        runCount: runs.length,
        approvalCount: approvals.length,
        memoryCount: memory.length,
        artifactCount: artifacts.length,
        lineageRootCount: lineage.rootCount,
        lineageEdgeCount: lineage.edgeCount,
        primaryMetricName: experimentAnalysis.primaryMetricName,
        evaluatedRunCount: experimentAnalysis.evaluatedRunCount,
        multiSeedCandidateCount: experimentAnalysis.summaries.filter((summary) => summary.runCount > 1).length,
        utilityCandidateCount: experimentAnalysis.utilityRanking.length,
        paretoFrontierCount: experimentAnalysis.paretoFrontier.length,
      }
      if (champion) metadata.championCandidateID = champion.candidateID
      Object.assign(metadata, domainArtifact?.metadata ?? {})

      const artifact = yield* createArtifact({
        taskID: task.id,
        kind,
        uri: `file://${outputPath}`,
        metadata,
      })
      return { artifact, path: outputPath }
    })

    const profileTask = Effect.fn("Research.profileTask")(function* (
      input: ProfileTaskInput & { readonly _onDeltaQualitative?: (delta: string) => void },
    ) {
      const task = yield* getTask(input.taskID)
      const fingerprint = DomainRegistry.summarizeTask(task.domainID, task.taskSpec)
      const root = runnerPath(Instance.directory, input.outputDir ?? ".neo-research/profile")
      const directory = path.join(root, task.id)
      const outputPath = path.join(directory, "task-profile.json")
      const payload = {
        taskID: task.id,
        domainID: task.domainID,
        title: task.title,
        fingerprint,
        generatedAt: new Date().toISOString(),
      }
      yield* Effect.promise(async () => {
        await mkdir(directory, { recursive: true })
        await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
      })

      const time = nowTime()
      const profileMetrics = recordValue(fingerprint.datasetProfile)
      const profileWarning = recordValue(fingerprint.datasetProfileWarning)
      const profileWarningCode =
        typeof profileWarning.code === "string" && profileWarning.code.length > 0 ? profileWarning.code : undefined
      const profileWarningMessage =
        typeof profileWarning.message === "string" && profileWarning.message.length > 0
          ? profileWarning.message
          : undefined
      let run = mapRun(
        yield* db((d) =>
          d
            .insert(ResearchRunTable)
            .values({
              id: ResearchRunID.ascending(),
              task_id: task.id,
              stage: "profile",
              status: "succeeded",
              metrics: {
                ...(typeof profileMetrics.missingRate === "number"
                  ? { profile_missing_rate: profileMetrics.missingRate }
                  : {}),
                ...(typeof profileMetrics.trendStrength === "number"
                  ? { profile_trend_strength: profileMetrics.trendStrength }
                  : {}),
                ...(typeof profileMetrics.seasonalityStrength === "number"
                  ? { profile_seasonality_strength: profileMetrics.seasonalityStrength }
                  : {}),
                ...(typeof profileMetrics.crossVarCorrelation === "number"
                  ? { profile_cross_var_correlation: profileMetrics.crossVarCorrelation }
                  : {}),
                ...(typeof profileMetrics.distributionShift === "number"
                  ? { profile_distribution_shift: profileMetrics.distributionShift }
                  : {}),
                ...(typeof profileMetrics.outlierRate === "number" ? { profile_outlier_rate: profileMetrics.outlierRate } : {}),
                ...(typeof profileMetrics.irregularIntervalRatio === "number"
                  ? { profile_irregular_interval_ratio: profileMetrics.irregularIntervalRatio }
                  : {}),
                ...(typeof profileMetrics.duplicateTimestampRate === "number"
                  ? { profile_duplicate_timestamp_rate: profileMetrics.duplicateTimestampRate }
                  : {}),
              },
              resource_usage: {
                profiler: "domain_fingerprint",
                ...(profileWarningCode === undefined
                  ? {}
                  : {
                      profileWarningCode,
                      ...(typeof profileWarning.path === "string" ? { profileWarningPath: profileWarning.path } : {}),
                    }),
              },
              artifact_refs: [],
              time_created: time.created,
              time_updated: time.updated,
              time_started: time.created,
              time_finished: time.created,
            })
            .returning()
            .get(),
        ),
      )
      yield* bus.publish(Event.RunCreated, { run })

      const artifact = yield* createArtifact({
        taskID: task.id,
        runID: run.id,
        kind: "task_profile_json",
        uri: `file://${outputPath}`,
        metadata: {
          format: "json",
          taskID: task.id,
          domainID: task.domainID,
          profileSource: "domain_fingerprint",
          hasDatasetProfile: typeof (fingerprint as Record<string, unknown>).datasetProfile === "object",
          ...(profileWarningCode === undefined ? {} : { profileWarningCode }),
          ...(profileWarningMessage === undefined ? {} : { profileWarningMessage }),
        },
      })
      const analysisDirectory = path.join(Instance.directory, ".neo-research", "sessions", task.id, "analysis")
      const analysisContext = yield* Effect.promise(() => buildDatasetAnalysisContext(task, fingerprint as JsonRecord))
      const llmQualitative = yield* Effect.promise(() =>
        generateLLMQualitativeAnalysis(task, fingerprint as JsonRecord, analysisContext, Instance.directory, input._onDeltaQualitative),
      )
      const analysisFiles = buildDatasetAnalysisReports(task, fingerprint as JsonRecord, analysisContext, llmQualitative?.text)
      const analysisArtifacts: ResearchArtifact[] = []
      for (const item of analysisFiles) {
        const reportPath = path.join(analysisDirectory, item.filename)
        yield* Effect.promise(async () => {
          await mkdir(analysisDirectory, { recursive: true })
          await writeFile(reportPath, item.content, "utf8")
        })
        analysisArtifacts.push(
          yield* createArtifact({
            taskID: task.id,
            runID: run.id,
            kind: item.kind,
            uri: `file://${reportPath}`,
            metadata: {
              ...item.metadata,
              taskID: task.id,
              domainID: task.domainID,
              role: item.role,
              profileArtifactID: artifact.id,
            },
          }),
        )
      }
      const plotArtifacts: ResearchArtifact[] = []
      for (const plot of analysisContext.plotRefs) {
        const plotPath = path.join(analysisDirectory, plot.relativePath)
        yield* Effect.promise(async () => {
          await mkdir(path.dirname(plotPath), { recursive: true })
          await writeFile(plotPath, plot.data)
        })
        plotArtifacts.push(
          yield* createArtifact({
            taskID: task.id,
            runID: run.id,
            kind: plot.kind,
            uri: `file://${plotPath}`,
            metadata: {
              ...plot.metadata,
              taskID: task.id,
              domainID: task.domainID,
              role: plot.role,
              profileArtifactID: artifact.id,
            },
          }),
        )
      }
      analysisArtifacts.push(...plotArtifacts)
      const sourceReports: DatasetAnalysisSourceReport[] = analysisFiles.map((source, index) => {
        const sourceArtifact = analysisArtifacts[index]!
        return {
          id: sourceArtifact.id,
          kind: sourceArtifact.kind,
          role: source.role,
          content: source.content,
        }
      })
      const unifiedReportPath = path.join(analysisDirectory, "data_analysis_summary.md")
      yield* Effect.promise(async () => {
        await mkdir(analysisDirectory, { recursive: true })
        await writeFile(
          unifiedReportPath,
          buildDatasetAnalysisReportMarkdown({
            task,
            fingerprint: fingerprint as JsonRecord,
            sourceArtifactIDs: analysisArtifacts.map((item) => item.id),
            sourceReports,
          }),
          "utf8",
        )
      })
      const dataAnalysisArtifact = yield* createArtifact({
        taskID: task.id,
        runID: run.id,
        kind: "dataset_analysis_report",
        uri: `file://${unifiedReportPath}`,
        metadata: {
          format: "markdown",
          role: "data-analysis-agent",
          phase: "data_analysis",
          taskID: task.id,
          domainID: task.domainID,
          profileArtifactID: artifact.id,
          sourceArtifactIDs: analysisArtifacts.map((item) => item.id),
          plotArtifactIDs: plotArtifacts.map((item) => item.id),
          llmStatus: llmQualitative !== undefined ? "used" : "skipped",
          ...(llmQualitative !== undefined
            ? { llmPreview: llmQualitative.text.split("\n").filter((l) => l.trim().length > 0).slice(0, 5).join("\n") }
            : {}),
          ...(llmQualitative?.usage && llmQualitative.usage.inputTokens > 0 ? usageToMetadata(llmQualitative.usage) : {}),
        },
      })
      analysisArtifacts.push(dataAnalysisArtifact)
      const artifactRefs = [artifact.id, ...analysisArtifacts.map((item) => item.id)]

      run = mapRun(
        yield* db((d) =>
          d
            .update(ResearchRunTable)
            .set({
              artifact_refs: artifactRefs,
              time_updated: Date.now(),
            })
            .where(eq(ResearchRunTable.id, run.id))
            .returning()
            .get(),
        ),
      )
      yield* bus.publish(Event.RunUpdated, { run })
      return { fingerprint, run, artifact, path: outputPath }
    })

	    const writeIntentSpecArtifact = Effect.fn("Research.writeIntentSpecArtifact")(function* (
	      result: IntentAgentResult,
	    ) {
	      const dir = path.join(Instance.directory, ".neo-research", "sessions", result.taskID, "intent")
	      const file = path.join(dir, "intent_spec.md")
	      yield* Effect.promise(async () => {
	        await mkdir(dir, { recursive: true })
	        await writeFile(file, result.intentSpecMarkdown, "utf8")
	      })
	      return yield* createArtifact({
	        taskID: result.taskID,
	        kind: "intent_spec_markdown",
	        uri: `file://${file}`,
	        metadata: {
	          format: "markdown",
	          role: "intent-agent",
	          phase: "intent_gathering",
	          taskID: result.taskID,
	          interactionMode: result.intentSpec.interaction_mode,
	          confidence: result.confidence,
	          confidenceThreshold: result.dialogueStrategy.confidenceThreshold,
	          missingFields: result.missingFields,
	          llmStatus: result.llm.status,
	        },
	      })
	    })

	    const runIntentAgent = Effect.fn("Research.runIntentAgent")(function* (taskID: ResearchTaskID) {
	      yield* updateTaskStatus({ taskID, status: "intent_gathering" })
	      yield* bus.publish(Event.IntentAgentStarted, {
	        taskID,
        agent: "IntentAgent",
	        stage: "intent_gathering",
	        status: "started",
	      })
	      return yield* Effect.gen(function* () {
	        const task = yield* getTask(taskID)
	        const result = yield* Effect.promise(() => analyzeIntentTaskWithLLM({ task, workspaceRoot: Instance.directory }))
	        const artifact = yield* writeIntentSpecArtifact(result)
	        yield* bus.publish(Event.IntentAgentCompleted, {
	          taskID,
	          agent: "IntentAgent",
	          stage: "intent_gathering",
	          status: "completed",
	          metadata: {
	            confidence: result.confidence,
	            missingFields: result.missingFields,
	            clarifyingQuestionCount: result.clarifyingQuestions.length,
	            artifactID: artifact.id,
	            interactionMode: result.intentSpec.interaction_mode,
	            llmStatus: result.llm.status,
	          },
	        })
	        return result
	      }).pipe(
	        Effect.catchCause((cause) =>
	          Effect.gen(function* () {
	            const error = Cause.squash(cause)
	            yield* updateTaskStatus({ taskID, status: "failed" })
	            yield* bus.publish(Event.IntentAgentFailed, {
	              taskID,
	              agent: "IntentAgent",
	              stage: "intent_gathering",
	              status: "failed",
	              metadata: errorMetadata(error),
	            })
	            return yield* Effect.failCause(cause)
	          }),
	        ),
	      )
	    })

	    const answerIntentQuestion = Effect.fn("Research.answerIntentQuestion")(function* (input: AnswerIntentInput) {
	      const task = yield* getTask(input.taskID)
	      const existingMeta =
	        typeof task.taskSpec.metadata === "object" && task.taskSpec.metadata !== null && !Array.isArray(task.taskSpec.metadata)
	          ? (task.taskSpec.metadata as Record<string, unknown>)
	          : {}
	      const existingIntentSlots =
	        typeof existingMeta.intentSlots === "object" && existingMeta.intentSlots !== null && !Array.isArray(existingMeta.intentSlots)
	          ? (existingMeta.intentSlots as Record<string, unknown>)
	          : {}
	      // Parse natural-language slot answers into typed values via a single LLM call when needed.
	      // Falls back to the raw string if no API key is configured or parsing fails.
	      const currentClarifyingQuestions = analyzeIntentTask({ task }).clarifyingQuestions
	      const parsedInputSlots = yield* Effect.promise(() =>
	        parseSlotInputsWithLLM({
	          slots: input.slots as Record<string, unknown>,
	          clarifyingQuestions: currentClarifyingQuestions,
	          workspaceRoot: Instance.directory,
	        }),
	      )
	      const mergedSlots = { ...existingIntentSlots, ...normalizeIntentSlotKeys(parsedInputSlots) }
	      // Propagate resolved intent slots back to canonical taskSpec fields so that downstream
	      // TSF parsing (TSFTaskSpec.parse) and checkpoint display both pick up the right values.
	      const existingDataset =
	        typeof task.taskSpec.dataset === "object" && task.taskSpec.dataset !== null && !Array.isArray(task.taskSpec.dataset)
	          ? (task.taskSpec.dataset as Record<string, unknown>)
	          : {}
	      const datasetOverrides: Record<string, unknown> = {}
	      const canonicalOverrides: Record<string, unknown> = {}
	      const targetCols = (() => {
	        const raw = mergedSlots.target_columns
	        if (Array.isArray(raw) && (raw as unknown[]).length > 0) return raw as string[]
	        if (typeof raw === "string" && raw.trim().length > 0)
	          return raw.trim().split(/\s*,\s*/).filter((s) => s.length > 0)
	        return undefined
	      })()
	      if (targetCols !== undefined) datasetOverrides.targetCols = targetCols
	      const dataSource =
	        typeof mergedSlots.data_source === "string" && mergedSlots.data_source.trim().length > 0
	          ? mergedSlots.data_source.trim()
	          : undefined
	      if (dataSource !== undefined) datasetOverrides.path = dataSource
	      const lookbackWindow = (() => {
	        const raw = mergedSlots.lookback_window
	        if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw
	        if (typeof raw === "string") { const n = Number(raw.trim()); if (Number.isFinite(n) && n > 0) return n }
	        return undefined
	      })()
	      if (lookbackWindow !== undefined) canonicalOverrides.contextLength = lookbackWindow
	      const predictionHorizon = (() => {
	        const raw = mergedSlots.prediction_horizon
	        if (Array.isArray(raw) && (raw as unknown[]).length > 0) return raw as number[]
	        if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return [raw]
	        if (typeof raw === "string" && raw.trim().length > 0) {
	          const parts = raw.trim().split(/\s*,\s*/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0)
	          if (parts.length > 0) return parts
	        }
	        return undefined
	      })()
	      if (predictionHorizon !== undefined) canonicalOverrides.predictionLengths = predictionHorizon
	      const timeGrain =
	        typeof mergedSlots.time_grain === "string" && mergedSlots.time_grain.trim().length > 0
	          ? mergedSlots.time_grain.trim()
	          : undefined
	      if (timeGrain !== undefined) canonicalOverrides.timeGrain = timeGrain
	      const updatedDataset =
	        Object.keys(datasetOverrides).length > 0 ? { ...existingDataset, ...datasetOverrides } : existingDataset
	      // Clear intentPendingReview flag — the user has answered a slot, review cycle continues
	      // via the normal missing-slot flow; flag will be gone once pipeline advances.
	      const { intentPendingReview: _drop, ...cleanedMeta } = existingMeta as Record<string, unknown> & { intentPendingReview?: unknown }
	      const updatedTaskSpec = {
	        ...task.taskSpec,
	        ...canonicalOverrides,
	        dataset: updatedDataset,
	        metadata: { ...cleanedMeta, intentSlots: mergedSlots },
	      }
	      yield* updateTaskSpec({ taskID: input.taskID, taskSpec: updatedTaskSpec as JsonRecord })
	      const result = yield* runIntentAgent(input.taskID)
	      // Use rule-based analysis (not LLM inferences) to decide whether to advance the pipeline.
	      // The LLM in analyzeIntentTaskWithLLM may infer slot values that are not persisted to the DB,
	      // causing result.missingFields to be empty even when the user hasn't answered all questions.
	      const taskAfterSlot = yield* getTask(input.taskID)
	      const ruleBasedCheck = analyzeIntentTask({ task: taskAfterSlot })
	      if (ruleBasedCheck.missingFields.length === 0) {
	        // All slots genuinely satisfied in the DB — advance the pipeline.
	        // PipelineBlockedError means the pipeline paused at a checkpoint, which is expected.
	        yield* runFullPipeline({ taskID: input.taskID }).pipe(
	          Effect.catch((error: unknown) =>
	            error instanceof PipelineBlockedError ? Effect.void : Effect.fail(error as never),
	          ),
	        )
	      } else {
	        // More slots still need user answers; reset status so the cockpit slot-fill path stays active.
	        yield* updateTaskStatus({ taskID: input.taskID, status: "idle" })
	      }
	      return result
	    })

	    const interpretAndApplySlotModification = Effect.fn("Research.interpretAndApplySlotModification")(function* (input: {
	      taskID: ResearchTaskID
	      message: string
	    }) {
	      const task = yield* getTask(input.taskID)
	      // Build currentSlots from the fully-merged intent spec so the LLM sees all slot values,
	      // not just the subset stored in metadata.intentSlots (which may be empty on first reject).
	      const base = analyzeIntentTask({ task })
	      const s = base.intentSpec
	      const currentSlots: Array<{ id: string; label: string; value?: string }> = [
	        { id: "interaction_mode", label: "交互模式", value: s.interaction_mode },
	        { id: "forecast_object", label: "预测对象", value: s.forecast_object },
	        { id: "data_source", label: "数据来源", value: s.data_source },
	        { id: "target_columns", label: "目标列", value: s.target_columns.length > 0 ? s.target_columns.join(", ") : undefined },
	        { id: "lookback_window", label: "lookback window", value: s.lookback_window !== undefined ? String(s.lookback_window) : undefined },
	        { id: "prediction_horizon", label: "预测 horizon", value: s.prediction_horizon.length > 0 ? s.prediction_horizon.join(", ") : undefined },
	        { id: "time_grain", label: "时间粒度", value: s.time_grain },
	        { id: "exogenous_variables", label: "外生变量", value: s.exogenous_variables !== undefined ? s.exogenous_variables.join(", ") : undefined },
	        { id: "business_context", label: "业务背景", value: s.business_context },
	        { id: "primary_metric", label: "主指标", value: s.primary_metric },
	        { id: "secondary_metrics", label: "辅助指标", value: s.secondary_metrics.length > 0 ? s.secondary_metrics.join(", ") : undefined },
	        { id: "error_preferences", label: "误差偏好", value: s.error_preferences },
	        { id: "latency_budget", label: "延迟预算", value: s.latency_budget !== undefined ? String(s.latency_budget) : undefined },
	        { id: "parameter_budget", label: "参数预算", value: s.parameter_budget !== undefined ? String(s.parameter_budget) : undefined },
	        { id: "interpretability", label: "可解释性", value: s.interpretability },
	        { id: "deployment_target", label: "部署目标", value: s.deployment_target },
	      ]
	      const llmResult = yield* Effect.promise(() =>
	        interpretSlotModificationWithLLM({
	          message: input.message,
	          currentSlots,
	          workspaceRoot: Instance.directory,
	        }),
	      )
	      const llmMeta = {
	        status: llmResult.status,
	        provider: llmResult.provider,
	        model: llmResult.model,
	        ...(llmResult.error ? { error: llmResult.error } : {}),
	      }
	      if (llmResult.status !== "used" || Object.keys(llmResult.updates).length === 0) {
	        return { ...analyzeIntentTask({ task }), llm: llmMeta }
	      }
	      const applied = yield* answerIntentQuestion({ taskID: input.taskID, slots: llmResult.updates as JsonRecord })
	      return { ...applied, llm: llmMeta }
	    })

	    const runDataAnalysisAgent = Effect.fn("Research.runDataAnalysisAgent")(function* (input: ProfileTaskInput) {
	      yield* updateTaskStatus({ taskID: input.taskID, status: "data_analysis" })
	      yield* bus.publish(Event.DataAnalysisAgentStarted, {
	        taskID: input.taskID,
	        agent: "DataAnalysisAgent",
	        stage: "data_analysis",
	        status: "started",
	      })
	      return yield* Effect.gen(function* () {
	        const onDelta = (delta: string): void => {
	          void Effect.runPromise(
	            bus.publish(Event.DataAnalysisAgentStreamDelta, {
	              taskID: input.taskID,
	              agent: "DataAnalysisAgent",
	              delta,
	            }),
	          ).catch(() => undefined)
	        }
	        const profile = yield* profileTask({ ...input, _onDeltaQualitative: onDelta })
	        const task = yield* getTask(input.taskID)
	        const artifacts = yield* listArtifacts(input.taskID)
	        const artifact = artifacts.find(
	          (item) => item.runID === profile.run.id && item.kind === "dataset_analysis_report",
	        )
	        if (!artifact) throw new Error(`Dataset analysis report was not created for task: ${input.taskID}`)
	        const sourceArtifacts = artifacts.filter(
	          (item) =>
	            item.runID === profile.run.id &&
	            (item.kind === "dataset_quantitative_analysis_markdown" ||
	              item.kind === "dataset_qualitative_analysis_markdown" ||
	              item.kind === "dataset_main_analysis_markdown"),
	        )
	        const sourceArtifactIDs = sourceArtifacts.map((item) => item.id)
	        const qualitativeArtifact = sourceArtifacts.find((item) => item.kind === "dataset_qualitative_analysis_markdown")
	        const llmUsed = recordValue(qualitativeArtifact?.metadata).llmGenerated === true
	        const qualitativeText = llmUsed && qualitativeArtifact?.uri.startsWith("file://")
	          ? yield* Effect.promise(() => readFile(qualitativeArtifact!.uri.slice(7), "utf8").catch(() => undefined))
	          : undefined
	        const result = summarizeDataAnalysisAgent({
	          task,
	          fingerprint: profile.fingerprint,
	          artifact,
	          sourceArtifactIDs,
	        })
	        yield* bus.publish(Event.DataAnalysisAgentCompleted, {
	          taskID: input.taskID,
	          agent: "DataAnalysisAgent",
	          stage: "data_analysis",
	          status: "completed",
	          metadata: {
	            artifactID: artifact.id,
	            sourceArtifactCount: sourceArtifactIDs.length,
	            warningCount: result.warningCount,
	            searchBiases: [...result.searchBiases],
	            llmStatus: llmUsed ? "used" : "skipped",
	            ...(qualitativeText !== undefined
	              ? { llmContent: qualitativeText }
	              : {}),
	          },
	        })
	        return result
	      }).pipe(
	        Effect.catchCause((cause) =>
	          Effect.gen(function* () {
	            const error = Cause.squash(cause)
	            yield* updateTaskStatus({ taskID: input.taskID, status: "failed" })
	            yield* bus.publish(Event.DataAnalysisAgentFailed, {
	              taskID: input.taskID,
	              agent: "DataAnalysisAgent",
	              stage: "data_analysis",
	              status: "failed",
	              metadata: errorMetadata(error),
	            })
	            return yield* Effect.failCause(cause)
	          }),
	        ),
	      )
	    })

	    const runHypoPlannerAgent = Effect.fn("Research.runHypoPlannerAgent")(function* (input: {
	      readonly taskID: ResearchTaskID
	      readonly dataAnalysis: DataAnalysisAgentResult
	      readonly outputDir?: string
	    }) {
	      yield* updateTaskStatus({ taskID: input.taskID, status: "hypo_planning" })
	      yield* bus.publish(Event.HypoPlannerAgentStarted, {
	        taskID: input.taskID,
	        agent: "HypoPlannerAgent",
	        stage: "hypo_planning",
	        status: "started",
	      })
	      return yield* Effect.gen(function* () {
	        const task = yield* getTask(input.taskID)
	        const runs = yield* listRuns(input.taskID)
	        const memory = yield* listMemory(input.taskID)
	        const draftHypotheses = generateHypotheses({ task, dataAnalysis: input.dataAnalysis, runs, memory })
	        const onDeltaHypo = (delta: string): void => {
	          void Effect.runPromise(
	            bus.publish(Event.HypoPlannerAgentStreamDelta, {
	              taskID: input.taskID,
	              agent: "HypoPlannerAgent",
	              delta,
	            }),
	          ).catch(() => undefined)
	        }
	        const llmHypothesesResult = yield* Effect.promise(() =>
	          generateLLMHypotheses(task, input.dataAnalysis, runs, memory, draftHypotheses, Instance.directory, onDeltaHypo),
	        )
	        const llmHypoUsage = llmHypothesesResult?.usage
	        const result = buildHypoPlannerResult({
	          task,
	          dataAnalysis: input.dataAnalysis,
	          runs,
	          memory,
	          llmHypotheses: llmHypothesesResult?.hypotheses,
	        })
	        const outputDir = path.join(
	          Instance.directory,
	          input.outputDir ?? path.join(".neo-research", "sessions", input.taskID, "hypotheses"),
	        )
	        const planPath = path.join(outputDir, "hypo_plan.md")
	        const yamlPath = path.join(outputDir, "hypotheses.yaml")
	        yield* Effect.promise(async () => {
	          await mkdir(outputDir, { recursive: true })
	          await writeFile(planPath, result.planMarkdown, "utf8")
	          await writeFile(yamlPath, result.hypothesesYaml, "utf8")
	        })
	        const planArtifact = yield* createArtifact({
	          taskID: input.taskID,
	          kind: "hypo_plan_md",
	          uri: `file://${planPath}`,
	          metadata: {
	            format: "markdown",
	            phase: "hypo_planning",
	            agent: "HypoPlannerAgent",
	            hypothesisCount: result.plan.hypotheses.length,
	            baselineStrategy: result.plan.baselineStrategy,
	            llmStatus: result.llm.status,
	            ...(result.llm.status === "used" && result.plan.hypotheses.length > 0
	              ? {
	                  llmPreview: result.plan.hypotheses
	                    .map((h) => `${h.id}: ${h.statement}`)
	                    .join("\n"),
	                }
	              : {}),
	            ...(llmHypoUsage && llmHypoUsage.inputTokens > 0 ? usageToMetadata(llmHypoUsage) : {}),
	          },
	        })
	        const yamlArtifact = yield* createArtifact({
	          taskID: input.taskID,
	          kind: "hypotheses_yaml",
	          uri: `file://${yamlPath}`,
	          metadata: {
	            format: "yaml",
	            phase: "hypo_planning",
	            agent: "HypoPlannerAgent",
	            hypothesisCount: result.plan.hypotheses.length,
	            baselineStrategy: result.plan.baselineStrategy,
	          },
	        })
	        yield* updateTaskHypothesisPlan({
	          taskID: input.taskID,
	          hypothesisPlan: result.plan,
	        })
	        yield* bus.publish(Event.HypoPlannerAgentCompleted, {
	          taskID: input.taskID,
	          agent: "HypoPlannerAgent",
	          stage: "hypo_planning",
	          status: "completed",
	          metadata: {
	            hypothesisCount: result.plan.hypotheses.length,
	            planArtifactID: planArtifact.id,
	            yamlArtifactID: yamlArtifact.id,
	            baselineStrategy: result.plan.baselineStrategy,
	            llmStatus: result.llm.status,
	            ...(result.llm.status === "used" && result.plan.hypotheses.length > 0
	              ? {
	                  llmPreview: result.plan.hypotheses
	                    .map((h) => `${h.id}: ${h.statement}`)
	                    .join("\n"),
	                }
	              : {}),
	          },
	        })
	        return result
	      }).pipe(
	        Effect.catchCause((cause) =>
	          Effect.gen(function* () {
	            const error = Cause.squash(cause)
	            yield* bus.publish(Event.HypoPlannerAgentFailed, {
	              taskID: input.taskID,
	              agent: "HypoPlannerAgent",
	              stage: "hypo_planning",
	              status: "failed",
	              metadata: errorMetadata(error),
	            })
	            return yield* Effect.failCause(cause)
	          }),
	        ),
	      )
	    })

	    const runNASAgent = Effect.fn("Research.runNASAgent")(function* (input: AutonomousLoopInput) {
      yield* updateTaskStatus({ taskID: input.taskID, status: "searching" })
      yield* bus.publish(Event.NASAgentStarted, {
        taskID: input.taskID,
        agent: "NASAgent",
	        stage: "searching",
	        status: "started",
	      })
	      return yield* Effect.gen(function* () {
	        const loop = yield* runAutonomousLoop(input)

	        // Build rich NAS result with per-iteration summaries
	        const task = yield* getTask(input.taskID)
	        const taskFp = DomainRegistry.summarizeTask(task.domainID, task.taskSpec)
	        const primaryMetricName = objectiveMetricName(task.objective)
	        const direction = objectiveDirection(task.objective)
	        const result = buildNASAgentResult({
	          taskID: input.taskID,
	          loop,
	          primaryMetricName,
	          direction,
	          taskFingerprint: taskFp as JsonRecord,
	        })

	        const sessionDir = path.join(Instance.directory, ".neo-research", "sessions", input.taskID)
	        const nasOutputs = [
	          {
	            kind: "nas_model_search_plan_md",
	            relativePath: "experiments/model_search_plan.md",
	            content: result.modelSearchPlanMarkdown,
	            format: "markdown",
	          },
	          {
	            kind: "nas_experiment_log_md",
	            relativePath: "experiments/experiment_log.md",
	            content: result.experimentLogMarkdown,
	            format: "markdown",
	          },
	          {
	            kind: "nas_leaderboard_md",
	            relativePath: "experiments/leaderboard.md",
	            content: result.leaderboardMarkdown,
	            format: "markdown",
	          },
	          {
	            kind: "nas_evaluation_result_md",
	            relativePath: "experiments/evaluation_result.md",
	            content: result.evaluationResultMarkdown,
	            format: "markdown",
	          },
	          {
	            kind: "nas_reflection_notes_md",
	            relativePath: "experiments/reflection_notes.md",
	            content: result.reflectionNotesMarkdown,
	            format: "markdown",
	          },
	          {
	            kind: "nas_search_space_yaml",
	            relativePath: "configs/search_space.yaml",
	            content: result.searchSpaceYaml,
	            format: "yaml",
	          },
	          {
	            kind: "nas_best_model_config_yaml",
	            relativePath: "configs/best_model_config.yaml",
	            content: result.bestModelConfigYaml,
	            format: "yaml",
	          },
	          {
	            kind: "nas_best_model_py",
	            relativePath: "model/best_model.py",
	            content: result.bestModelPython,
	            format: "python",
	          },
	          {
	            kind: "nas_training_script_py",
	            relativePath: "model/training_script.py",
	            content: result.trainingScriptPython,
	            format: "python",
	          },
	        ] as const
	        for (const item of nasOutputs) {
	          const outputPath = path.join(sessionDir, item.relativePath)
	          yield* Effect.promise(async () => {
	            await mkdir(path.dirname(outputPath), { recursive: true })
	            await writeFile(outputPath, item.content, "utf8")
	          })
	          yield* createArtifact({
	            taskID: input.taskID,
	            kind: item.kind,
	            uri: `file://${outputPath}`,
	            metadata: {
	              format: item.format,
	              phase: "searching",
	              relativePath: item.relativePath,
	              iterationCount: result.iterationCount,
	              succeededCount: result.succeededCount,
	              failedCount: result.failedCount,
	              stoppedReason: loop.stoppedReason,
	            },
	          })
	        }

	        for (let index = 0; index < loop.iterations.length; index++) {
          const iteration = loop.iterations[index]!
          yield* bus.publish(Event.NASIterationCompleted, {
            taskID: input.taskID,
            agent: "NASAgent",
            stage: "searching",
            status: "completed",
            metadata: {
              iterationIndex: index + 1,
              candidateID: iteration.candidate.id,
              runID: iteration.run.id,
              runStatus: iteration.run.status,
              metrics: iteration.run.metrics,
            },
          })
        }
        yield* bus.publish(Event.NASAgentCompleted, {
          taskID: input.taskID,
          agent: "NASAgent",
          stage: "searching",
          status: "completed",
          metadata: {
            stoppedReason: loop.stoppedReason,
            iterationCount: result.iterationCount,
            succeededCount: result.succeededCount,
            failedCount: result.failedCount,
            artifactID: loop.artifact.id,
          },
        })
        return result
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const error = Cause.squash(cause)
            yield* updateTaskStatus({ taskID: input.taskID, status: "failed" })
            yield* bus.publish(Event.NASAgentFailed, {
              taskID: input.taskID,
              agent: "NASAgent",
              stage: "searching",
              status: "failed",
              metadata: errorMetadata(error),
            })
            return yield* Effect.failCause(cause)
          }),
        ),
      )
    })
	    const runVerifierAgent = Effect.fn("Research.runVerifierAgent")(function* (input: VerifierAgentRunInput) {
	      const task = yield* getTask(input.taskID)
	      const run = yield* getRunForTask(input.taskID, input.runID)
	      const candidate =
	        run.candidateID !== undefined ? yield* getCandidateForTask(task.id, run.candidateID) : undefined
	      const allRuns = yield* listRuns(task.id)
	      const prevRuns = allRuns.filter((r) => r.id !== run.id)
	      const champion = yield* getChampion(task.id)
	      const result = evaluateRunWithVerifiers({ task, run, candidate, previousRuns: prevRuns, champion })
	      const evalDir = path.join(
	        runnerPath(Instance.directory, input.outputDir ?? ".neo-research/evaluation-results"),
	        task.id,
	      )
	      const evalPath = path.join(evalDir, `${run.id}.md`)
	      const decisionPath = path.join(evalDir, `${run.id}.verifier_decision.json`)
	      yield* Effect.promise(async () => {
	        await mkdir(evalDir, { recursive: true })
	        await writeFile(evalPath, result.evaluationResultMarkdown, "utf8")
	        await writeFile(decisionPath, `${JSON.stringify(result.verifierDecision, null, 2)}\n`, "utf8")
	      })
	      const artifact = yield* createArtifact({
	        taskID: task.id,
	        runID: run.id,
	        kind: "evaluation_result_md",
	        uri: `file://${evalPath}`,
	        metadata: verifierAgentMetadata(result) as Record<string, string | number | boolean | null>,
	      })
	      const decisionArtifact = yield* createArtifact({
	        taskID: task.id,
	        runID: run.id,
	        kind: "verifier_decision_json",
	        uri: `file://${decisionPath}`,
	        metadata: {
	          ...(verifierAgentMetadata(result) as Record<string, string | number | boolean | null>),
	          decision: result.verifierDecision.decision,
	          failureCategory: result.verifierDecision.failure?.category ?? null,
	          recoveryAction: result.verifierDecision.failure?.recoveryAction.type ?? null,
	          format: "json",
	        },
	      })
	      return { ...result, artifact, decisionArtifact }
	    })

	    const runReflectionAgent = Effect.fn("Research.runReflectionAgent")(function* (input: ReflectionAgentInput) {
	      yield* bus.publish(Event.ReflectionAgentStarted, {
	        taskID: input.taskID,
	        agent: "ReflectionAgent",
	        stage: "reflection",
	        status: "started",
	      })
	      return yield* Effect.gen(function* () {
	        const task = yield* getTask(input.taskID)
	        const runs = yield* listRuns(input.taskID)
	        const candidates = yield* listCandidates(input.taskID)
	        const champion = yield* getChampion(input.taskID)
	        const baseResult = summarizeReflectionAgent({
	          task,
	          runs,
	          candidates,
	          champion,
	          stoppedReason: input.stoppedReason,
	        })
	        const result = yield* Effect.promise(() =>
	          generateLLMReflectionSynthesis(task, baseResult).catch(() => ({
	            ...baseResult,
	            llm: { status: 'failed' as const },
	          })),
	        )
	        const directory = path.join(
	          runnerPath(Instance.directory, input.outputDir ?? ".neo-research/reflection"),
	          task.id,
	        )
	        const notesPath = path.join(directory, "reflection_notes.md")
	        const planPath = path.join(directory, "next_experiment_plan.md")
	        const failureLogPath = path.join(directory, "failure_log.md")
	        yield* Effect.promise(async () => {
	          await mkdir(directory, { recursive: true })
	          await writeFile(notesPath, result.reflectionNotesMarkdown, "utf8")
	          await writeFile(planPath, result.nextExperimentPlanMarkdown, "utf8")
	          await writeFile(failureLogPath, result.failureLogMarkdown, "utf8")
	        })
	        const baseMetadata = reflectionAgentMetadata(result)
	        const notesArtifact = yield* createArtifact({
	          taskID: task.id,
	          kind: "reflection_notes_md",
	          uri: `file://${notesPath}`,
	          metadata: { ...baseMetadata, role: "reflection-agent", format: "markdown" },
	        })
	        const planArtifact = yield* createArtifact({
	          taskID: task.id,
	          kind: "next_experiment_plan_md",
	          uri: `file://${planPath}`,
	          metadata: { ...baseMetadata, role: "reflection-agent", format: "markdown" },
	        })
	        const failureLogArtifact = yield* createArtifact({
	          taskID: task.id,
	          kind: "failure_log_md",
	          uri: `file://${failureLogPath}`,
	          metadata: { ...baseMetadata, role: "reflection-agent", format: "markdown" },
	        })
	        yield* bus.publish(Event.ReflectionAgentCompleted, {
	          taskID: input.taskID,
	          agent: "ReflectionAgent",
	          stage: "reflection",
	          status: "completed",
	          metadata: {
	            ...baseMetadata,
	            llmStatus: result.llm.status,
	            ...(result.llm.status === "used" && result.llm.text
	              ? { llmNarrative: result.llm.text.slice(0, 400) }
	              : {}),
	            reflectionNotesArtifactID: notesArtifact.id,
	            nextExperimentPlanArtifactID: planArtifact.id,
	            failureLogArtifactID: failureLogArtifact.id,
	          },
	        })
	        // Persist reflection insights into experience memory so future iterations can learn from them.
	        yield* createMemory({
	          taskID: task.id,
	          domainID: task.domainID,
	          fingerprintSummary: {
	            ...DomainRegistry.summarizeTask(task.domainID, task.taskSpec),
	            taskID: task.id,
	            domainID: task.domainID,
	            primaryMetricName: result.analysis.primaryMetricName,
	            direction: result.analysis.direction,
	          },
	          candidateSummary: {
	            role: "reflection",
	            decision: result.analysis.decision,
	            decisionReason: result.analysis.decisionReason,
	            plateauStreak: result.analysis.plateauStreak,
	            succeededRuns: result.analysis.succeededRuns,
	            failedRuns: result.analysis.failedRuns,
	            bestMetric: result.analysis.bestMetric ?? null,
	            nextHypotheses: result.analysis.nextHypotheses.map((h) => h.title),
	            failureCategories: result.analysis.failures.map((f) => f.category),
	            ...(result.llm.status === "used" && result.llm.text
	              ? { llmNarrative: result.llm.text.slice(0, 400) }
	              : {}),
	          },
	          outcome:
	            result.analysis.effectiveChanges.length > 0
	              ? "accepted"
	              : result.analysis.decision === "request_human"
	                ? "failed"
	                : "rejected",
	          lesson: buildReflectionMemoryLesson(result),
	        }).pipe(Effect.catchCause(() => Effect.void))
	        return result
	      }).pipe(
	        Effect.catchCause((cause) =>
	          Effect.gen(function* () {
	            const error = Cause.squash(cause)
	            yield* bus.publish(Event.ReflectionAgentFailed, {
	              taskID: input.taskID,
	              agent: "ReflectionAgent",
	              stage: "reflection",
	              status: "failed",
	              metadata: errorMetadata(error),
	            })
	            return yield* Effect.failCause(cause)
	          }),
	        ),
	      )
	    })

	    const runPublishAgent = Effect.fn("Research.runPublishAgent")(function* (input: ExportTaskArtifactInput) {
      yield* updateTaskStatus({ taskID: input.taskID, status: "publishing" })
      yield* bus.publish(Event.PublishAgentStarted, {
        taskID: input.taskID,
        agent: "PublishAgent",
	        stage: "publishing",
	        status: "started",
	      })
	      return yield* Effect.gen(function* () {
        // Run ref_test on champion before export so the result lands in the report.
        const publishChampion = yield* getChampion(input.taskID)
        if (publishChampion !== undefined) {
          const existingRuns = yield* listRuns(input.taskID)
          const hasRefTest = existingRuns.some(
            (r) =>
              r.candidateID === publishChampion.candidateID &&
              r.stage === "ref_test" &&
              r.status === "succeeded",
          )
          if (!hasRefTest) {
            yield* Effect.gen(function* () {
              const pendingApprovals = yield* listApprovals({
                taskID: input.taskID,
                status: "pending",
              })
              const existingPending = pendingApprovals.find(
                (a) => a.kind === "ref_test" && a.candidateID === publishChampion.candidateID,
              )
              const approval =
                existingPending !== undefined
                  ? existingPending
                  : yield* createApproval({
                      taskID: input.taskID,
                      candidateID: publishChampion.candidateID,
                      kind: "ref_test",
                      reason: "Auto-approved by PublishAgent for final reference test evaluation.",
                    })
              yield* replyApproval({
                approvalID: approval.id,
                status: "approved",
                replyMessage: "Auto-approved by PublishAgent.",
              })
              yield* executeRun({
                taskID: input.taskID,
                candidateID: publishChampion.candidateID,
                stage: "ref_test",
                description: "Final reference test by PublishAgent.",
              })
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  const error = Cause.squash(cause)
                  yield* bus.publish(Event.PublishAgentFailed, {
                    taskID: input.taskID,
                    agent: "PublishAgent",
                    stage: "publishing",
                    status: "failed",
                    metadata: {
                      ...errorMetadata(error),
                      refTestSkipped: true,
                      reason: "ref_test failed and was skipped; export will proceed without ref_test metrics.",
                    },
                  })
                }),
              ),
            )
          }
        }
	        const exportResult = yield* exportTaskArtifact({
	          ...input,
	          kind: input.kind ?? "model_export_package",
	        })
	        const result = summarizePublishAgent({ taskID: input.taskID, exportResult })
	        yield* updateTaskStatus({ taskID: input.taskID, status: "completed" })
	        const finalChampion = yield* getChampion(input.taskID)
	        const finalChampionCandidate =
	          finalChampion !== undefined
	            ? yield* getCandidateForTask(input.taskID, finalChampion.candidateID).pipe(
	                Effect.orElseSucceed((): ResearchCandidate | undefined => undefined),
	              )
	            : undefined
	        const spec =
	          finalChampionCandidate !== undefined
	            ? (finalChampionCandidate.candidateSpec as Record<string, unknown>)
	            : undefined
	        const backboneType =
	          spec?.backbone && typeof spec.backbone === "object" && !Array.isArray(spec.backbone)
	            ? ((spec.backbone as Record<string, unknown>).type as string | undefined)
	            : undefined
	        const embeddingType =
	          spec?.embedding && typeof spec.embedding === "object" && !Array.isArray(spec.embedding)
	            ? ((spec.embedding as Record<string, unknown>).type as string | undefined)
	            : undefined
	        const recipeIDStr =
	          spec?.recipeID !== undefined && spec.recipeID !== null ? String(spec.recipeID) : undefined
	        const finalRuns = finalChampion !== undefined ? yield* listRuns(input.taskID) : []
	        const finalRefTestRun =
	          finalChampion !== undefined
	            ? finalRuns.find(
	                (r) =>
	                  r.candidateID === finalChampion.candidateID &&
	                  r.stage === "ref_test" &&
	                  r.status === "succeeded",
	              )
	            : undefined
	        const finalRefTestMetrics: Record<string, number> | undefined =
	          finalRefTestRun !== undefined
	            ? Object.fromEntries(
	                Object.entries(finalRefTestRun.metrics as Record<string, unknown>)
	                  .filter(([k, v]) => k.startsWith("ref_test_") && typeof v === "number")
	                  .map(([k, v]) => [k, v as number]),
	              )
	            : undefined
	        yield* bus.publish(Event.PublishAgentCompleted, {
	          taskID: input.taskID,
	          agent: "PublishAgent",
	          stage: "publishing",
	          status: "completed",
	          metadata: {
	            artifactID: result.artifact.id,
	            kind: result.artifact.kind,
	            path: result.path,
	            ...(finalChampion !== undefined
	              ? {
	                  championCandidateID: String(finalChampion.candidateID),
	                  championPrimaryMetric: finalChampion.primaryMetric,
	                  championUtility: finalChampion.utility,
	                }
	              : {}),
	            ...(finalRefTestMetrics !== undefined ? { refTestMetrics: finalRefTestMetrics } : {}),
	            ...(recipeIDStr !== undefined ? { recipeID: recipeIDStr } : {}),
	            ...(embeddingType !== undefined ? { embeddingType } : {}),
	            ...(backboneType !== undefined ? { backboneType } : {}),
	          },
	        })
	        return result
	      }).pipe(
	        Effect.catchCause((cause) =>
	          Effect.gen(function* () {
	            const error = Cause.squash(cause)
	            yield* updateTaskStatus({ taskID: input.taskID, status: "failed" })
	            yield* bus.publish(Event.PublishAgentFailed, {
	              taskID: input.taskID,
	              agent: "PublishAgent",
	              stage: "publishing",
	              status: "failed",
	              metadata: errorMetadata(error),
	            })
	            return yield* Effect.failCause(cause)
	          }),
	        ),
	      )
	    })

    const runFullPipeline = Effect.fn("Research.runFullPipeline")(function* (input: RunFullPipelineInput) {
      const initialTask = yield* getTask(input.taskID)
      const initialInteractionMode = taskInteractionMode(initialTask)
      // Socratic mode requires autonomous task mode (fully autonomous after clarification).
      // Companion mode can run in any task mode (pauses at human checkpoints).
      if (initialTask.mode !== "autonomous" && initialInteractionMode !== "companion") {
        throw new PipelineBlockedError({
          taskID: input.taskID,
          reason: "pipeline_requires_autonomous",
        })
      }

      const markWorkflowPhase = (phase: PipelineWorkflowPhase, checkpoint?: string) =>
        Effect.gen(function* () {
          const task = yield* getTask(input.taskID)
          const workflow = workflowMetadataFromTask(task)
          const nextPhases = normalizeWorkflowMetadata({
            completedPhases: [...workflow.completedPhases, phase],
            ...(checkpoint === undefined ? {} : { lastCheckpoint: checkpoint }),
          })
          yield* updateTaskWorkflow({
            taskID: input.taskID,
            completedPhases: nextPhases.completedPhases,
            ...(checkpoint === undefined ? {} : { lastCheckpoint: checkpoint }),
          })
        })

      const recoverDataAnalysis = (task: ResearchTask) =>
        Effect.gen(function* () {
          const artifacts = yield* listArtifacts(input.taskID)
          const dataAnalysisArtifact = artifacts.find((item) => item.kind === "dataset_analysis_report")
          if (!dataAnalysisArtifact) throw new Error(`Missing dataset analysis artifact for task: ${input.taskID}`)
          const metadata = recordValue(dataAnalysisArtifact.metadata)
          const sourceArtifactIDs = Array.isArray(metadata.sourceArtifactIDs)
            ? metadata.sourceArtifactIDs
                .map((id) => (typeof id === "string" ? (id as ResearchArtifactID) : undefined))
                .filter((id): id is ResearchArtifactID => id !== undefined)
            : []
          const warningCount =
            typeof metadata.warningCount === "number"
              ? metadata.warningCount
              : typeof metadata.warningCount === "string"
                ? Number(metadata.warningCount)
                : 0
          const searchBiases = Array.isArray(metadata.searchBiases)
            ? metadata.searchBiases.filter((item): item is string => typeof item === "string")
            : []
          return {
            agent: "DataAnalysisAgent" as const,
            taskID: task.id,
            artifact: dataAnalysisArtifact,
            sourceArtifactIDs,
            searchBiases,
            warningCount: Number.isFinite(warningCount) ? warningCount : 0,
          } satisfies DataAnalysisAgentResult
        })

      const recoverHypoPlanning = (task: ResearchTask, dataAnalysis: DataAnalysisAgentResult) =>
        Effect.gen(function* () {
          const plan = experimentPlanFromMetadata(recordValue(task.taskSpec.metadata).hypothesisPlan)
          if (plan !== undefined) {
            return recoverHypoPlannerResultFromPlan({ task, dataAnalysis, plan })
          }
          const runs = yield* listRuns(input.taskID)
          const memory = yield* listMemory(input.taskID)
          return buildHypoPlannerResult({ task, dataAnalysis, runs, memory })
        })

      const recoverNAS = (task: ResearchTask) =>
        Effect.gen(function* () {
          const artifacts = yield* listArtifacts(input.taskID)
          const loopArtifact = artifacts.find((item) => item.kind === "research_autonomous_loop_json")
          if (!loopArtifact) throw new Error(`Missing NAS loop artifact for task: ${input.taskID}`)
          const loopPath = filePathFromURI(loopArtifact.uri)
          if (loopPath === undefined) throw new Error(`Invalid NAS loop artifact path for task: ${input.taskID}`)
          const payloadText = yield* Effect.promise(() => readFile(loopPath, "utf8"))
          const payload = recordValue(JSON.parse(payloadText))
          const rawIterations = Array.isArray(payload.iterations) ? payload.iterations : []
          const iterations: AutonomousIterationResult[] = []
          for (const item of rawIterations) {
            const raw = recordValue(item)
            const runID = typeof raw.runID === "string" ? (raw.runID as ResearchRunID) : undefined
            const candidateID = typeof raw.candidateID === "string" ? (raw.candidateID as ResearchCandidateID) : undefined
            if (runID === undefined || candidateID === undefined) continue
            const run = yield* getRunForTask(input.taskID, runID).pipe(
              Effect.orElseSucceed((): ResearchRun | undefined => undefined),
            )
            const candidate = yield* getCandidateForTask(input.taskID, candidateID).pipe(
              Effect.orElseSucceed((): ResearchCandidate | undefined => undefined),
            )
            if (!run || !candidate) continue
            const selectionArtifact =
              artifacts.find((item) => item.runID === run.id && item.kind === "research_candidate_selection_json") ??
              ({
                id: ResearchArtifactID.ascending(),
                taskID: input.taskID,
                kind: "research_candidate_selection_json",
                uri: `file://${path.join(Instance.directory, ".neo-research", "placeholder")}`,
                metadata: {},
                time: { created: 0, updated: 0 },
              } as ResearchArtifact)
            iterations.push({
              run,
              candidate,
              runPlan: {
                domainID: task.domainID,
                runnerID: "restored",
                runnerKind: "subprocess",
                stage: run.stage,
                approvalRequired: false,
                validation: { ok: true, issues: [] },
                writes: [],
                command: {
                  executable: "",
                  path: "",
                  args: [],
                },
                expectedEvents: [],
                expectedMetrics: [],
                expectedArtifacts: [],
              },
              seededCandidates: [],
              approvals: [],
              managerTrace: [],
              selectionArtifact,
            } as AutonomousIterationResult)
          }
          const taskFingerprint = DomainRegistry.summarizeTask(task.domainID, task.taskSpec)
          const loop = {
            iterations,
            stoppedReason:
              typeof payload.stoppedReason === "string" && payload.stoppedReason.length > 0
                ? (payload.stoppedReason as AutonomousLoopStoppedReason)
                : "max_iterations",
            artifact: loopArtifact,
          }
          return buildNASAgentResult({
            taskID: input.taskID,
            loop: loop as unknown as AutonomousLoopResult,
            taskFingerprint,
          })
        })

      const recoverReflection = (task: ResearchTask, stoppedReason: AutonomousLoopStoppedReason) =>
        Effect.gen(function* () {
          const runs = yield* listRuns(input.taskID)
          const candidates = yield* listCandidates(input.taskID)
          const champion = yield* getChampion(input.taskID)
          const result = summarizeReflectionAgent({
            task,
            runs,
            candidates,
            champion,
            stoppedReason,
          })
          const artifacts = yield* listArtifacts(input.taskID)
          const notesArtifact = artifacts.find((item) => item.kind === "reflection_notes_md")
          const planArtifact = artifacts.find((item) => item.kind === "next_experiment_plan_md")
          const failureArtifact = artifacts.find((item) => item.kind === "failure_log_md")
          const readArtifactContent = (artifact?: ResearchArtifact) =>
            Effect.promise(async () => {
              const contentPath = artifact === undefined ? undefined : filePathFromURI(artifact.uri)
              if (!contentPath) return ""
              return (await readFile(contentPath, "utf8")).toString()
            }).pipe(Effect.orElseSucceed(() => ""))
          const reflectionNotesMarkdown = yield* readArtifactContent(notesArtifact)
          const nextExperimentPlanMarkdown = yield* readArtifactContent(planArtifact)
          const failureLogMarkdown = yield* readArtifactContent(failureArtifact)
          return {
            ...result,
            reflectionNotesMarkdown: reflectionNotesMarkdown.length === 0 ? result.reflectionNotesMarkdown : reflectionNotesMarkdown,
            nextExperimentPlanMarkdown:
              nextExperimentPlanMarkdown.length === 0 ? result.nextExperimentPlanMarkdown : nextExperimentPlanMarkdown,
            failureLogMarkdown: failureLogMarkdown.length === 0 ? result.failureLogMarkdown : failureLogMarkdown,
          } satisfies ReflectionAgentResult
        })

      const recoverPublish = (task: ResearchTask) =>
        Effect.gen(function* () {
          const artifacts = yield* listArtifacts(input.taskID)
          const artifact =
            artifacts.find((item) => item.kind === "model_export_package") ??
            artifacts.find((item) => item.kind === "research_final_bundle")
          if (!artifact) throw new Error(`Missing export artifact for task: ${input.taskID}`)
          const publishPath = filePathFromURI(artifact.uri)
          if (publishPath === undefined) throw new Error(`Invalid publish artifact path for task: ${input.taskID}`)
          return summarizePublishAgent({
            taskID: task.id,
            exportResult: {
              artifact,
              path: publishPath,
            },
          })
        })

      const intent = yield* runIntentAgent(input.taskID)
      if (intent.missingFields.length > 0) {
        yield* ensurePendingApproval({
          taskID: input.taskID,
          kind: "protocol",
          reason: [
            "运行自主研究流水线前需要先澄清研究意图。",
            ...intent.clarifyingQuestions.map((question) => `- ${question}`),
          ].join("\n"),
        })
        yield* updateTaskStatus({ taskID: input.taskID, status: "paused" })
        throw new PipelineBlockedError({
          taskID: input.taskID,
          reason: "intent_clarification_required",
          missingFields: intent.missingFields,
          clarifyingQuestions: intent.clarifyingQuestions,
        })
      }

      let task = yield* getTask(input.taskID)
      let workflow = workflowMetadataFromTask(task)
      const intentAlreadyConfirmed =
        workflow.lastCheckpoint === "intent_confirmed" ||
        workflow.lastCheckpoint === "requirements_confirmed" ||
        workflow.completedPhases.some((phase) => phase !== "intent_gathering")
      if (!intentAlreadyConfirmed && !workflow.completedPhases.includes("intent_gathering")) {
        // Both companion and socratic modes pause for human confirmation after intent gathering.
        if (intent.intentSpec.interaction_mode === "companion" || intent.intentSpec.interaction_mode === "socratic") {
          const intentCheckpoint = yield* ensureIntentCheckpoint({
            task,
            reason: buildIntentCheckpointReason(task),
          })
          if (intentCheckpoint.status === "pending") {
            yield* updateTaskStatus({ taskID: input.taskID, status: "paused" })
            throw new PipelineBlockedError({
              taskID: input.taskID,
              reason: "human_checkpoint_required",
              checkpointPhase: "intent_confirmed",
            })
          }
        }
        yield* updateTaskWorkflow({
          taskID: input.taskID,
          lastCheckpoint: "intent_confirmed",
          completedPhases: workflow.completedPhases.includes("intent_gathering")
            ? workflow.completedPhases
            : [...workflow.completedPhases, "intent_gathering"],
        })
        task = yield* getTask(input.taskID)
        workflow = workflowMetadataFromTask(task)
      }
      const datasetPreparation = tsfDatasetPreparationConfig(task)
      if (
        datasetPreparation !== undefined &&
        (input.forceDatasetPreparation === true || existsSync(path.join(datasetPreparation.root, "bin", "neo-cast.js")))
      ) {
        yield* prepareTaskDataset({
          taskID: input.taskID,
          force: input.forceDatasetPreparation ?? true,
        })
      }

      const dataAnalysis = workflow.completedPhases.includes("data_analysis")
        ? yield* recoverDataAnalysis(task)
        : yield* runDataAnalysisAgent({
            taskID: input.taskID,
            outputDir: input.outputDir === undefined ? undefined : path.join(input.outputDir, "profile"),
          }).pipe(
            Effect.tap(() => markWorkflowPhase("data_analysis")),
          )

      const taskAfterDataAnalysis = yield* getTask(input.taskID)
      const workflowAfterDataAnalysis = workflowMetadataFromTask(taskAfterDataAnalysis)
      const hypoPlanning = workflowAfterDataAnalysis.completedPhases.includes("hypo_planning")
        ? yield* recoverHypoPlanning(taskAfterDataAnalysis, dataAnalysis)
        : yield* runHypoPlannerAgent({
            taskID: input.taskID,
            dataAnalysis,
            outputDir: input.outputDir === undefined ? undefined : path.join(input.outputDir, "hypotheses"),
          }).pipe(
            Effect.tap(() => markWorkflowPhase("hypo_planning")),
          )

      const currentTask = yield* getTask(input.taskID)
      const currentWorkflow = workflowMetadataFromTask(currentTask)
      const shouldRunSearchSpaceCheckpoint = (intent.intentSpec.interaction_mode === "companion" || intent.intentSpec.interaction_mode === "socratic") && !currentWorkflow.completedPhases.includes("searching")
      if (shouldRunSearchSpaceCheckpoint) {
        const fingerprint = DomainRegistry.summarizeTask(currentTask.domainID, currentTask.taskSpec)
        const biases = (Array.isArray(fingerprint.searchBiases) ? fingerprint.searchBiases : []).join(", ") || "none"
        const baselines = DomainRegistry.buildBaselines(currentTask.domainID, currentTask.taskSpec)
        const baselineList = baselines
          .map((b) => {
            const spec = b.candidateSpec as Record<string, unknown>
            const recipeID = typeof spec.recipeID === "string" ? spec.recipeID : "candidate"
            const emb =
              spec.embedding && typeof spec.embedding === "object" && !Array.isArray(spec.embedding)
                ? ((spec.embedding as Record<string, unknown>).type as string | undefined)
                : undefined
            const bb =
              spec.backbone && typeof spec.backbone === "object" && !Array.isArray(spec.backbone)
                ? ((spec.backbone as Record<string, unknown>).type as string | undefined)
                : undefined
            const arch = [emb ?? "none", bb].filter(Boolean).join("+")
            const rationale = b.rationale?.slice(0, 90) ?? ""
            return `- ${recipeID} (${arch}): ${rationale}`
          })
          .join("\n")
        const ssCheckpoint = yield* ensureHumanCheckpoint({
          taskID: input.taskID,
          phase: "search_space_confirmed",
          reason: [
            "## 搜索空间已确认，等待确认后开始模型搜索",
            "",
            "**搜索偏置：** " + biases,
            "",
            "**计划 Baseline 方案：**",
            baselineList,
            "",
            "**建议操作：** 确认搜索方向正确后 approve，或 reject 并调整 taskSpec 后重新运行。",
          ].join("\n"),
        })
        if (ssCheckpoint.status === "pending") {
          yield* updateTaskStatus({ taskID: input.taskID, status: "paused" })
          throw new PipelineBlockedError({
            taskID: input.taskID,
            reason: "human_checkpoint_required",
            checkpointPhase: "search_space_confirmed",
          })
        }
        yield* updateTaskWorkflow({
          taskID: input.taskID,
          completedPhases: currentWorkflow.completedPhases.includes("searching")
            ? currentWorkflow.completedPhases
            : [...currentWorkflow.completedPhases, "searching"],
          lastCheckpoint: "search_space_confirmed",
        })
      }

      let nas = currentWorkflow.completedPhases.includes("searching")
        ? yield* recoverNAS(currentTask)
        : yield* Effect.gen(function* () {
            const nasTask = yield* getTask(input.taskID)
            const runnerScript = tsfRunnerScriptPath(nasTask)
            if (runnerScript !== undefined && !existsSync(runnerScript)) {
              yield* updateTaskStatus({ taskID: input.taskID, status: "paused" })
              throw new PipelineBlockedError({
                taskID: input.taskID,
                reason: "runner_not_configured",
              })
            }
            const result = yield* runNASAgent({
              taskID: input.taskID,
              stage: input.stage,
              description: input.description,
              maxIterations: input.maxIterations,
              targetMetricValue: input.targetMetricValue,
              minRelativeImprovement: input.minRelativeImprovement,
              maxNoImprove: input.maxNoImprove,
              timeBudgetSeconds: input.timeBudgetSeconds,
              maxCrashStreak: input.maxCrashStreak ?? 3,
              explorationRate: input.explorationRate,
            })
            yield* markWorkflowPhase("searching")
            return result
          })

      if (intent.intentSpec.interaction_mode === "companion" || intent.intentSpec.interaction_mode === "socratic") {
        const nasAlreadyExtended = currentWorkflow.completedPhases.includes("nas_budget_extended")
        if (!nasAlreadyExtended && nas.loop.stoppedReason === "max_iterations") {
          const budgetCheckpoint = yield* ensureHumanCheckpoint({
            taskID: input.taskID,
            phase: "experiment_budget_extended",
            reason: [
              "## NAS 搜索已达迭代上限",
              "",
              `**完成迭代：** ${nas.iterationCount} 轮`,
              `**成功运行：** ${nas.succeededCount}，**失败：** ${nas.failedCount}`,
              "",
              nas.leaderboardMarkdown.replace(/^# Leaderboard/, "### 当前工作区实验结果"),
              "**建议操作：** approve 继续搜索（将增加 maxIterations），reject 接受当前结果。",
            ].join("\n"),
          })
          yield* updateTaskWorkflow({ taskID: input.taskID, lastCheckpoint: "experiment_budget_extended" })
          if (budgetCheckpoint.status === "pending") {
            yield* updateTaskStatus({ taskID: input.taskID, status: "paused" })
            throw new PipelineBlockedError({
              taskID: input.taskID,
              reason: "human_checkpoint_required",
              checkpointPhase: "experiment_budget_extended",
            })
          }
          if (budgetCheckpoint.status === "approved") {
            nas = yield* runNASAgent({
              taskID: input.taskID,
              stage: input.stage,
              description: input.description,
              maxIterations: (input.maxIterations ?? 10) + 5,
              targetMetricValue: input.targetMetricValue,
              minRelativeImprovement: input.minRelativeImprovement,
              maxNoImprove: input.maxNoImprove,
              timeBudgetSeconds: input.timeBudgetSeconds,
              maxCrashStreak: input.maxCrashStreak ?? 3,
              explorationRate: input.explorationRate,
            })
            yield* markWorkflowPhase("nas_budget_extended")
          }
        }
        const champion = yield* getChampion(input.taskID)
        const finalCheckpoint = yield* ensureHumanCheckpoint({
          taskID: input.taskID,
          phase: "final_model_selection",
          reason: [
            "## 模型搜索完成，请确认最终候选模型",
            "",
            champion
              ? [
                  `**当前 Champion：** ${champion.candidateID}`,
                  `**Primary metric：** ${champion.primaryMetric.toFixed(4)}`,
                  `**Utility score：** ${champion.utility.toFixed(3)}`,
                ].join("\n")
              : "**当前无 Champion**（所有 run 均未成功）",
            "",
            nas.leaderboardMarkdown.replace(/^# Leaderboard/m, "### 验证集排行榜（所有候选模型）"),
            "",
            "**建议操作：** approve 接受此模型并进入反思与发布阶段，reject 中止发布。",
          ].join("\n"),
        })
        yield* updateTaskWorkflow({ taskID: input.taskID, lastCheckpoint: "final_model_selection" })
        if (finalCheckpoint.status === "pending") {
          yield* updateTaskStatus({ taskID: input.taskID, status: "paused" })
          throw new PipelineBlockedError({
            taskID: input.taskID,
            reason: "human_checkpoint_required",
            checkpointPhase: "final_model_selection",
          })
        }
      }

      const reflection = currentWorkflow.completedPhases.includes("reflection")
        ? yield* recoverReflection(currentTask, nas.loop.stoppedReason)
        : yield* runReflectionAgent({
            taskID: input.taskID,
            outputDir: input.outputDir === undefined ? undefined : path.join(input.outputDir, "reflection"),
            stoppedReason: nas.loop.stoppedReason,
          })

      if (reflection.analysis.decision === "request_human" && !currentWorkflow.completedPhases.includes("reflection")) {
        yield* markWorkflowPhase("reflection")
        yield* ensurePendingApproval({
          taskID: input.taskID,
          kind: "protocol",
          reason: ["Reflection Agent 建议人工介入：", reflection.analysis.decisionReason].join("\n"),
        })
        yield* updateTaskStatus({ taskID: input.taskID, status: "paused" })
        throw new PipelineBlockedError({
          taskID: input.taskID,
          reason: "reflection_requested_human_review",
        })
      }
      if (!currentWorkflow.completedPhases.includes("reflection")) {
        yield* markWorkflowPhase("reflection")
      }

      const publish = currentWorkflow.completedPhases.includes("publishing")
        ? yield* recoverPublish(currentTask)
        : yield* runPublishAgent({
            taskID: input.taskID,
            kind: "model_export_package",
            outputDir: input.outputDir,
          }).pipe(
            Effect.tap(() => markWorkflowPhase("publishing")),
          )

      if (intent.intentSpec.interaction_mode === "companion") {
        const releaseCheckpoint = yield* ensureHumanCheckpoint({
          taskID: input.taskID,
          phase: "report_release",
          reason: [
            "## 准备发布模型报告",
            "",
            `**Reflection 决策：** ${reflection.analysis.decision}`,
            `**决策依据：** ${reflection.analysis.decisionReason}`,
            "",
            "**建议操作：** approve 发布最终模型包，reject 放弃本次发布。",
          ].join("\n"),
        })
        if (releaseCheckpoint.status === "pending") {
          yield* updateTaskStatus({ taskID: input.taskID, status: "paused" })
          throw new PipelineBlockedError({
            taskID: input.taskID,
            reason: "human_checkpoint_required",
            checkpointPhase: "report_release",
          })
        }
        yield* updateTaskWorkflow({ taskID: input.taskID, lastCheckpoint: "report_release" })
        yield* updateTaskStatus({ taskID: input.taskID, status: "completed" })
      }

      const completed = yield* getTask(input.taskID)
      return { task: completed, intent, dataAnalysis, hypoPlanning, nas, reflection, publish }
    })

    const createMemory = Effect.fn("Research.createMemory")(function* (input: CreateMemoryInput) {
      yield* getTask(input.taskID)
      const time = nowTime()
      const row = yield* db((d) =>
        d
          .insert(ResearchMemoryTable)
          .values({
            id: ResearchMemoryID.ascending(),
            task_id: input.taskID,
            domain_id: input.domainID,
            fingerprint_summary: input.fingerprintSummary,
            candidate_summary: input.candidateSummary,
            outcome: input.outcome,
            lesson: input.lesson,
            time_created: time.created,
            time_updated: time.updated,
          })
          .returning()
          .get(),
      )
      const memory = mapMemory(row)
      yield* bus.publish(Event.MemoryCreated, { memory })
      return memory
    })

    const listMemory = Effect.fn("Research.listMemory")(function* (taskID: ResearchTaskID) {
      yield* getTask(taskID)
      const rows = yield* db((d) =>
        d
          .select()
          .from(ResearchMemoryTable)
          .where(eq(ResearchMemoryTable.task_id, taskID))
          .orderBy(desc(ResearchMemoryTable.time_updated))
          .all(),
      )
      return rows.map(mapMemory)
    })

    const listRelatedMemory = Effect.fn("Research.listRelatedMemory")(function* (task: ResearchTask) {
      const projectTaskRows = yield* db((d) =>
        d
          .select({ id: ResearchTaskTable.id })
          .from(ResearchTaskTable)
          .where(and(eq(ResearchTaskTable.project_id, Instance.project.id), eq(ResearchTaskTable.domain_id, task.domainID)))
          .all(),
      )
      const taskIDs = projectTaskRows.map((row) => row.id)
      if (taskIDs.length === 0) return []
      const rows = yield* db((d) =>
        d
          .select()
          .from(ResearchMemoryTable)
          .where(and(eq(ResearchMemoryTable.domain_id, task.domainID), inArray(ResearchMemoryTable.task_id, taskIDs)))
          .orderBy(desc(ResearchMemoryTable.time_updated))
          .limit(100)
          .all(),
      )
      return rows.map(mapMemory)
    })

    const setChampion = Effect.fn("Research.setChampion")(function* (input: SetChampionInput) {
      yield* getTask(input.taskID)
      yield* getCandidateForTask(input.taskID, input.candidateID)
      const run = yield* getRunForTask(input.taskID, input.runID)
      if (run.candidateID !== input.candidateID) throw missing("Research run", input.runID)
      const existing = yield* db((d) =>
        d.select().from(ResearchChampionTable).where(eq(ResearchChampionTable.task_id, input.taskID)).get(),
      )
      const time = nowTime()
      const row = yield* db((d) =>
        d
          .insert(ResearchChampionTable)
          .values({
            task_id: input.taskID,
            candidate_id: input.candidateID,
            run_id: input.runID,
            primary_metric: input.primaryMetric,
            utility: input.utility,
            accepted_at: time.created,
            time_created: existing?.time_created ?? time.created,
            time_updated: time.updated,
          })
          .onConflictDoUpdate({
            target: ResearchChampionTable.task_id,
            set: {
              candidate_id: input.candidateID,
              run_id: input.runID,
              primary_metric: input.primaryMetric,
              utility: input.utility,
              accepted_at: time.created,
              time_updated: time.updated,
            },
          })
          .returning()
          .get(),
      )
      const champion = mapChampion(row)
      yield* bus.publish(Event.ChampionUpdated, { champion })
      return champion
    })

    const getChampion = Effect.fn("Research.getChampion")(function* (taskID: ResearchTaskID) {
      yield* getTask(taskID)
      const row = yield* db((d) =>
        d.select().from(ResearchChampionTable).where(eq(ResearchChampionTable.task_id, taskID)).get(),
      )
      return row ? mapChampion(row) : undefined
    })

    return Service.of({
      createTask,
      listTasks,
      getTask,
      updateTaskStatus,
      updateTaskSpec,
      createCandidate,
      listCandidates,
      createApproval,
      listApprovals,
      replyApproval,
      seedBaselines,
      prepareRun,
      executeRun,
      executeSeedSweep,
      runAutonomousIteration,
      runAutonomousLoop,
      runIntentAgent,
      answerIntentQuestion,
      interpretAndApplySlotModification,
      runDataAnalysisAgent,
      runHypoPlannerAgent,
      runNASAgent,
      runVerifierAgent,
      runReflectionAgent,
      runPublishAgent,
      runFullPipeline,
      getResearchLLMStatus: Effect.fn("Research.getResearchLLMStatus")(function* () {
        const config = yield* Effect.promise(() => resolveNeoCastLLMConfig({ workspaceRoot: Instance.directory }))
        const envKey = apiKeyFor(config)
        if (envKey) {
          return {
            status: "ready",
            provider: config.provider,
            model: config.model,
            source: "env_var",
          } satisfies ResearchLLMStatus
        }
        const authEntry = yield* Effect.promise(() => resolveApiKeyFromAuthJson())
        if (authEntry) {
          const isAnthropicNative = !authEntry.baseURL
          return {
            status: "ready",
            provider: isAnthropicNative ? "anthropic" : "openai-compatible",
            model: isAnthropicNative ? config.model : authEntry.model,
            source: "auth_json",
          } satisfies ResearchLLMStatus
        }
        return {
          status: "not_configured",
          provider: config.provider,
          model: config.model,
          source: "unconfigured",
        } satisfies ResearchLLMStatus
      }),
      createRun,
      updateRunStatus,
      listRuns,
      createArtifact,
      listArtifacts,
      prepareTaskDataset,
      profileTask,
      exportTaskArtifact,
      createMemory,
      listMemory,
      setChampion,
      getChampion,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))
