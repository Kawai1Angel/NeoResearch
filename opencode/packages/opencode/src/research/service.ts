import { finalMetrics, finalEvaluationRecords } from "./runner-evidence"
import { ExperimentConstraints, conflictingMechanismRequirements } from "./experiment-constraints"
import { DesignUnavailable, DesignHistoryRequest, designTaskSpec, schemaRemovalUnavailable, frequencyModeUnavailable, mechanismRequirementsUnavailable, formatDesignValidationIssue } from "./design-feedback"
import { comparisonRecipe } from "./comparison-run"
import { readDesignHistory } from "./design-history"
import { KnowledgeValidationDraftSchema } from "./literature/knowledge-confidence"
import { confirmKnowledgeExperiment, readReflectionKnowledge } from "./literature/knowledge-feedback"
import { ExperienceDraftSchema, experienceFromMemory, experiencePromptRecord } from "./experience"
import { captureExperienceContext, readExperiences, writeExperience } from "./experience-store"
import { projectTaskEvidence, citableTaskEvidence } from "./retrieve/evidence-handoff"
import { timedEffect } from "@/util/runtime-timing"
import { extractTrainingCurve, runnerFailureEvidence, recoverRunnerFailure, reflectionExecutionEvidence, type TrainingCurvePoint } from "./runner-evidence"
import { supersedeIntentCheckpoints } from "./taskspec-store"
import { taskExecutionRoot, taskSessionModel, validateTaskRuntimePaths } from "./task-isolation"
import { readSelectedSessionModel, resolveSessionModel } from "./session-model"
import { Provider } from "@/provider"
import { appendLog, recordResearchEvent, snapshotPhaseArtifact } from "./log-archive"
import { logPhaseMethod } from "./phase-log"
import { executionOwner, runnerGroupExited } from "./owner"
import { recordCompletedPhases } from "./phase-store"
import { searchCycle, chargeIteration, saveCrashStreak, cycleClock, extendSearchCycle } from "./cycle"
import {
  NAS_DEFAULT_MAX_ITERATIONS,
  NAS_DEFAULT_MAX_NO_IMPROVE,
  RESEARCH_MAX_RUNS_SAFETY_LIMIT,
} from "./defaults"
import { abortable } from "./abortable"
import { EffectBridge } from "@/effect"
import { recoverLiteratureReceipt } from "./literature-session-receipt"
import { createLiteraturePhase, bindLiteratureSession, type LiteraturePhase } from "./literature-phase-executor"
import { KnowledgeV2Store } from "./literature/knowledge-v2-store"
import { buildExecutionContract, digest, validateCandidateAgainstHypothesis, verifyExecutionRecords, type ExecutionContract, type ContractMismatch } from "./execution-contract"
import { NamedError } from "@opencode-ai/core/util/error"
import { Cause, Context, Effect, Layer, Schema, Stream, Semaphore } from "effect"
import { cp, mkdir, readdir, readFile, writeFile, rename } from "fs/promises"
import { existsSync, openSync, readSync, closeSync, realpathSync } from "fs"
import { createHash } from "crypto"
import os from "os"
import path from "path"
import { deflateSync } from "zlib"
import z from "zod"
import { and, desc, eq, inArray, notInArray, isNull, lt, ne, Database, NotFoundError } from "@/storage"
import { Bus } from "@/bus"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { SessionTable } from "@/session/session.sql"
import { Instance } from "@/project/instance"
import { mapTask } from "./task-mapper"
import { Log } from "@/util"
import PROMPT_RESEARCH_DATA_ANALYSIS from "../agent/prompt/research-data-analysis.txt"
import PROMPT_RESEARCH_HYPO_PLANNER from "../agent/prompt/research-hypo-planner.txt"
import PROMPT_RESEARCH_REFLECTION from "../agent/prompt/research-reflection.txt"
import * as Process from "@/util/process"
import {
  ResearchApprovalTable,
  ResearchArtifactTable,
  ResearchCandidateTable,
  ResearchChampionTable,
  ResearchHypothesisTable,
  ResearchMemoryTable,
  ResearchRunTable,
  ResearchCycleTable,
  ResearchRunnerLockTable,
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
  ResearchHypothesisID,
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
  UpdateTaskBudgetInput,
  UpdateRunStatusInput,
  UpdateTaskStatusInput,
} from "./schema"
import { MODEL_CAPABILITIES, validMechanisms, unsupportedMechanisms } from "./model-capabilities"
import { Event } from "./event"
import { addHypothesisToPool, updateHypothesisInPool, bindTaskEvidenceToSession, loadTaskEvidenceForTask } from "./hypothesis-store"
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
import { apiKeyFor, llmProposalValidationIssues, buildLLMProposalFromText, buildUserPrompt, extractJsonObject, mapToModelRef, proposeLLMCandidate, requestNeoCastLLM, requestNeoCastLLMStream, resolveNeoCastLLMConfig, resolveApiKeyFromAuthJson, resolveEffectiveLLMConfig, usageToMetadata, ZERO_USAGE, camelizeKnown, pruneCandidateSpec, candidateGovernance, llmMetadata as buildLLMMetadata, type AuthJsonKeyResult, type LLMTokenUsage, type OpencodeModelRef } from "./llm-proposal"
import { analyzeDatasetProfileForPrompt, compactPromptContext } from "./prompt-context"
import { createFileResearchRuntime, researchJobFromRunPlan } from "./runtime"
import { analyzeIntentTask, type IntentAgentResult } from "./agents/intent-agent"
import {
  analyzeDataset,
  buildDatasetAnalysisContext,
  buildDatasetAnalysisReportMarkdown,
  type DataAnalysisAgentResult,
  type DatasetAnalysisContext,
  type DatasetAnalysisPlot,
  type DatasetAnalysisSourceReport,
  type DatasetStatisticalAnalysis,
  summarizeDataAnalysisAgent,
} from "./agents/data-analysis-agent"
import {
  RetrieveResultSchema,
  TASK_EVIDENCE_ROLES,
  taskContextDigest,
  type RetrievalBudgets,
  type RetrieveResult,
  type TaskEvidenceBundle,
  type TaskEvidenceRole,
  type RetrieveTaskContext,
} from "./retrieve"
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
  validateHypothesisEvidence,
  referenceBaselineOptions,
  parseNextExperiment,
  isOpenHypothesis,
  type NextExperimentDecision,
  type ExperimentPlan,
  type HypoPlannerInput,
  type HypoPlannerResult,
  type HypothesisObject,
  type HypothesisStatus,
} from "./agents/hypo-planner-agent"
import { buildNASAgentResult, summarizeNASAgentLoop, type NASAgentResult } from "./agents/nas-agent"
import { summarizePublishAgent, type PublishAgentResult } from "./agents/publish-agent"
import {
  buildPublishReportPrompt,
  buildPublishReportSnapshot,
  renderDeterministicFinalReport,
  stripMarkdownFence,
  validateFinalReport,
} from "./publish-report"
import { buildTrainEvalResult, type TrainEvalResult } from "./agents/train-eval-agent"
import {
  analyzeReflection,
  buildInlineReflectionSystemPrompt,
  buildReflectionPlanningMarkdown,
  reflectionAgentMetadata,
  summarizeReflectionAgent,
  type ReflectionAgentResult,
  type ReflectionAnalysis,
  type ReflectionLLMAnalysis,
} from "./agents/reflection-agent"
import {
  evaluateRun as evaluateRunWithVerifiers,
  verifierAgentMetadata,
  type VerifierAgentResult,
} from "./agents/verifier-agent"
import { buildEvaluationResultMarkdown, buildVerifierDecisionRecord, runVerifiers, type VerifierReport } from "./verifiers"

type DbClient = Parameters<typeof Database.use>[0] extends (trx: infer D) => unknown ? D : never
type ResearchApprovalRow = typeof ResearchApprovalTable.$inferSelect
type ResearchCandidateRow = typeof ResearchCandidateTable.$inferSelect
type ResearchRunRow = typeof ResearchRunTable.$inferSelect
type ResearchArtifactRow = typeof ResearchArtifactTable.$inferSelect
type ResearchMemoryRow = typeof ResearchMemoryTable.$inferSelect
type ResearchChampionRow = typeof ResearchChampionTable.$inferSelect
type ResearchHypothesisRow = typeof ResearchHypothesisTable.$inferSelect

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
  | "no_new_candidate"
  | "planner_stopped"

export interface AutonomousLoopResult {
  readonly iterations: AutonomousIterationResult[]
  readonly stoppedReason: AutonomousLoopStoppedReason
  readonly artifact: ResearchArtifact
}

export interface RunFullPipelineResult {
  readonly task: ResearchTask
  readonly intent: IntentAgentResult
  readonly dataAnalysis: DataAnalysisAgentResult
  readonly literature: RetrieveResult
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
  "literature",
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

const DesignUnavailableError = NamedError.create("ResearchDesignUnavailable", z.object({ report: DesignUnavailable }))
const DesignPlanningStopped = NamedError.create("ResearchDesignPlanningStopped", z.object({ reason: z.string() }))

export const PipelineBlockedError = NamedError.create(
  "ResearchPipelineBlockedError",
  z.object({
    taskID: z.string(),
    reason: z.enum([
      "pipeline_requires_autonomous",
      "intent_clarification_required",
      "human_checkpoint_required",
      "human_checkpoint_rejected",
      "reflection_requested_human_review",
      "runner_not_configured",
      "execution_contract_violation",
    ]),
    missingFields: z.array(z.string()).optional(),
    clarifyingQuestions: z.array(z.string()).optional(),
    checkpointPhase: z.string().optional(),
    blockerArtifactID: z.string().optional(),
    candidateID: z.string().optional(),
    hypothesisID: z.string().optional(),
    invalidRunID: z.string().optional(),
    mismatches: z.array(z.object({ path: z.string(), expected: z.unknown(), actual: z.unknown() })).optional(),
  }),
)

type ContractRecoveryState = {
  readonly taskID: ResearchTaskID
  readonly attempt: number
  readonly maxAttempts: number
  readonly hypothesisID?: string
  readonly feedback?: Parameters<typeof buildUserPrompt>[0]["validationFeedback"]
}

// Fiber-local state keeps concurrent tasks and explicit/manual runs independent.
const ContractRecovery = Context.Reference<ContractRecoveryState | undefined>("research/ContractRecovery", {
  defaultValue: () => undefined,
})

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

type DatasetSplitRows = {
  readonly train: readonly [number, number]
  readonly validation: readonly [number, number]
  readonly test: readonly [number, number]
}

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
  return status === "succeeded" || status === "failed" || status === "rejected" || status === "invalid"
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
  const loop = recordValue(budget.loop ?? budget.researchLoop ?? budget.autonomousLoop)
  return [
    `mode=${compactIntentValue(taskInteractionMode(task) ?? (task.mode === "review" ? "companion" : "socratic"))}`,
    `dataset=${compactIntentValue(dataset.path ?? dataset.loaderID)}`,
    `split=${JSON.stringify(dataset.split ?? null)}`,
    `targets=${compactIntentValue(dataset.targetCols)}`,
    `pastCovariates=${compactIntentValue(dataset.observedPastCovariates)}`,
    `futureCovariates=${compactIntentValue(dataset.knownFutureCovariates)}`,
    `covariateSchema=${compactIntentValue(recordValue(recordValue(spec.metadata).resolvedCovariates).schemaFingerprint)}`,
    `context=${compactIntentValue(spec.contextLength)}`,
    `horizons=${compactIntentValue(spec.predictionLengths)}`,
    `metric=${compactIntentValue(objective.primaryMetric)}`,
    `direction=${compactIntentValue(objective.direction)}`,
    `maxIterations=${compactIntentValue(loop.maxIterations ?? NAS_DEFAULT_MAX_ITERATIONS)}`,
    `maxNoImprove=${compactIntentValue(loop.maxNoImprove ?? loop.maxNoImproveRounds ?? NAS_DEFAULT_MAX_NO_IMPROVE)}`,
  ].join("|")
}

function buildIntentCheckpointReason(task: ResearchTask) {
  const spec = recordValue(task.taskSpec)
  const dataset = recordValue(spec.dataset)
  const objective = recordValue(task.objective)
  const budget = recordValue(task.budget)
  const loop = recordValue(budget.loop ?? budget.researchLoop ?? budget.autonomousLoop)
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
    `Data split: ${JSON.stringify(dataset.split ?? null)}`,
    `Targets: ${compactIntentValue(slotOr(dataset.targetCols, "target_columns"))}`,
    `Forecast object: ${compactIntentValue(intentSlots.forecast_object ?? spec.forecastObject)}`,
    `Context length: ${compactIntentValue(slotOr(spec.contextLength, "lookback_window"))}`,
    `Prediction lengths: ${compactIntentValue(slotOr(spec.predictionLengths, "prediction_horizon"))}`,
    `Time grain: ${compactIntentValue(intentSlots.time_grain ?? spec.timeGrain ?? spec.frequency)}`,
    `Exogenous variables: ${compactIntentValue(intentSlots.exogenous_variables ?? dataset.exogenousCols)}`,
    `Observed past covariates: ${compactIntentValue(dataset.observedPastCovariates)}`,
    `Known future covariates: ${compactIntentValue(dataset.knownFutureCovariates)}`,
    `Covariate count: ${Array.isArray(dataset.knownFutureCovariates) ? dataset.knownFutureCovariates.length : 0}`,
    `Future availability: ${compactIntentValue(metadata.futureCovariateAvailability)}`,
    "Risk notice: known-future values may only be used when they are available at prediction time; offline realized values make this an oracle upper-bound experiment.",
    `Primary metric: ${compactIntentValue(slotOr(objective.primaryMetric, "primary_metric"))}`,
    `Error preferences: ${compactIntentValue(intentSlots.error_preferences ?? objective.errorPreferences)}`,
    `Latency budget: ${compactIntentValue(intentSlots.latency_budget ?? budget.latencyBudget)}`,
    `Parameter budget: ${compactIntentValue(intentSlots.parameter_budget ?? budget.parameterBudget)}`,
    `NAS planned iterations: ${compactIntentValue(intentSlots.max_iterations ?? loop.maxIterations ?? NAS_DEFAULT_MAX_ITERATIONS)}`,
    `Stop after no improvement: ${compactIntentValue(intentSlots.max_no_improve ?? loop.maxNoImprove ?? loop.maxNoImproveRounds ?? NAS_DEFAULT_MAX_NO_IMPROVE)}`,
    `Interpretability: ${compactIntentValue(intentSlots.interpretability ?? spec.interpretability)}`,
    `Deployment target: ${compactIntentValue(intentSlots.deployment_target ?? spec.deploymentTarget)}`,
    `Business context: ${compactIntentValue(intentSlots.business_context ?? metadata.businessContext ?? metadata.business_context)}`,
    "",
    "**建议操作：** 确认以上需求后 approve，系统才会结束 Intent Agent 并进入 Data Analysis；如需补充需求，请 reject 并逐一修改 slots 后重新确认。",
  ].join("\n")
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
  readonly foldIndex?: number
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
    const foldIndex = finiteNumber(record.cv_fold_index) ?? finiteNumber(record.foldIndex)
    return {
      ...(event === undefined ? {} : { event }),
      ...(epoch === undefined ? {} : { epoch }),
      ...(horizon === undefined ? {} : { horizon }),
      ...(valLoss === undefined ? {} : { valLoss }),
      ...(elapsedS === undefined ? {} : { elapsedS }),
      ...(foldIndex === undefined ? {} : { foldIndex }),
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
  return finalMetrics(records, stage)
}

function objectiveMetricName(objective: ResearchTask["objective"]) {
  const record = objective as Record<string, unknown>
  if (typeof record.primaryMetric === "string") return record.primaryMetric
  if (typeof record.metric === "string") return record.metric
  return "cv_avg_mse"
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
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return RESEARCH_MAX_RUNS_SAFETY_LIMIT
  return Math.min(Math.floor(value), RESEARCH_MAX_RUNS_SAFETY_LIMIT)
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

const MAX_ABANDONED_HYPOTHESES = 30

function abandonedHypothesesFromMetadata(metadata: Record<string, unknown>): readonly { statement: string }[] {
  if (!Array.isArray(metadata.abandonedHypotheses)) return []
  return (metadata.abandonedHypotheses as unknown[])
    .map((item) => recordValue(item).statement)
    .filter((statement): statement is string => typeof statement === "string" && statement.trim().length > 0)
    .map((statement) => ({ statement }))
}

function mapHypothesisRow(row: ResearchHypothesisRow): HypothesisObject {
  const status = row.status
  const validStatus: HypothesisStatus =
    status === "pending" ||
    status === "active" ||
    status === "testing" ||
    status === "confirmed" ||
    status === "rejected" ||
    status === "abandoned"
      ? status
      : "pending"
  return {
    id: row.hypo_id,
    statement: row.statement,
    motivation: Array.isArray(row.motivation) ? (row.motivation as string[]) : [],
    expectedOutcome: row.expected_outcome,
    suggestedBackbones: Array.isArray(row.suggested_backbones) ? (row.suggested_backbones as string[]) : [],
    suggestedPreprocessing: Array.isArray(row.suggested_preprocessing) ? (row.suggested_preprocessing as string[]) : [],
    ...(row.experiment_contract ? { experimentContract: ExperimentConstraints.parse(row.experiment_contract) } : {}),
    requiredMechanisms: validMechanisms(row.required_mechanisms) ? row.required_mechanisms : [],
    risk: row.risk,
    testable: row.testable,
    datasetEvidencePaths: Array.isArray(row.dataset_evidence_paths) ? row.dataset_evidence_paths : [],
    literatureEvidence: Array.isArray(row.literature_evidence) ? row.literature_evidence : [],
    applicabilityAssumptions: Array.isArray(row.applicability_assumptions) ? row.applicability_assumptions : [],
    falsificationCriteria: Array.isArray(row.falsification_criteria) ? row.falsification_criteria : [],
    evidenceLevel: row.evidence_level === "paper_supported" || row.evidence_level === "conflicted" ? row.evidence_level : "data_only",
    status: validStatus,
    ...(row.abandon_reason ? { abandonReason: row.abandon_reason } : {}),
  }
}

function experimentPlanFromDB(task: ResearchTask, hypotheses: readonly HypothesisObject[]): ExperimentPlan | undefined {
  if (hypotheses.length === 0) return undefined
  const metadata = recordValue(task.taskSpec.metadata)
  const baselineStrategy =
    typeof metadata.baselineStrategy === "string" ? metadata.baselineStrategy : "planner_selected_experiments"
  const referenceBaseline =
    typeof metadata.referenceBaseline === "string" ? metadata.referenceBaseline : undefined
  const searchBiases = Array.isArray(metadata.searchBiases)
    ? (metadata.searchBiases as unknown[]).filter((x): x is string => typeof x === "string")
    : []
  const stopCond = recordValue(metadata.stopConditions)
  const maxTrials = typeof stopCond.maxTrials === "number" ? Math.max(1, stopCond.maxTrials) : 50
  const noImprovementRounds =
    typeof stopCond.noImprovementRounds === "number" ? Math.max(1, stopCond.noImprovementRounds) : 20
  const targetMetricValue =
    typeof stopCond.targetMetricValue === "number" ? stopCond.targetMetricValue : undefined
  return {
    hypotheses,
    baselineStrategy,
    searchBiases,
    stopConditions: {
      maxTrials,
      noImprovementRounds,
      ...(targetMetricValue !== undefined ? { targetMetricValue } : {}),
    },
    ...(referenceBaseline !== undefined ? { referenceBaseline } : {}),
    ...(parseNextExperiment(metadata.nextExperiment) ? { nextExperiment: parseNextExperiment(metadata.nextExperiment) } : {}),
  }
}

function hypothesisDefinitionDigest(hypothesis: HypothesisObject) {
  const { id, status, abandonReason, priority, ...definition } = hypothesis
  return digest({ ...definition, requiredMechanisms: hypothesis.requiredMechanisms ?? [] })
}

function recoverHypoPlannerResultFromPlan(input: {
  readonly task: ResearchTask
  readonly dataAnalysisSummary: string
  readonly plan: ExperimentPlan
  readonly taskEvidence?: TaskEvidenceBundle
}): HypoPlannerResult {
  const evidenceSummary = [
    extractEvidenceSummary(input.dataAnalysisSummary),
    input.taskEvidence
      ? `Literature readiness: ${input.taskEvidence.readiness}; selected=${input.taskEvidence.summary.selectedEntryCount}; gaps=${input.taskEvidence.gaps.length}; conflicts=${input.taskEvidence.conflicts.length}.`
      : "Literature readiness: ready_data_only; no task evidence bundle was supplied.",
  ].filter(Boolean).join("\n")
  const partial = {
    agent: "HypoPlannerAgent" as const,
    taskID: input.task.id,
    plan: input.plan,
    hypothesesYaml: buildHypothesesYaml(input.plan, input.taskEvidence?.readiness),
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
  if (Provider.ModelNotFoundError.isInstance(error)) {
    return {
      error: `Model not found: ${error.data.providerID}/${error.data.modelID}`,
      errorName: error.name,
      providerID: error.data.providerID,
      modelID: error.data.modelID,
      suggestions: error.data.suggestions ?? [],
    }
  }
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

function sessionLocalMetricState(input: {
  readonly runs: readonly ResearchRun[]
  readonly stage: ResearchRun["stage"]
  readonly primaryMetricName: string
  readonly direction: "minimize" | "maximize"
  readonly minRelativeImprovement: number
}) {
  let bestMetric: number | undefined
  let noImproveStreak = 0
  const runs = input.runs
    .filter((run) => run.stage === input.stage && run.status === "succeeded" && run.resourceUsage.independentEvidence !== false && run.resourceUsage.duplicateExperiment !== true)
    .toSorted((left, right) =>
      (left.timeFinished ?? left.time.updated ?? left.time.created) -
      (right.timeFinished ?? right.time.updated ?? right.time.created),
    )
  for (const run of runs) {
    const metric = metricValue(run.metrics, input.primaryMetricName)
    if (metric === undefined) continue
    const improved =
      bestMetric === undefined ||
      isMeaningfulMetricImprovement(input.direction, metric, bestMetric, input.minRelativeImprovement)
    if (improved) {
      bestMetric = metric
      noImproveStreak = 0
    } else {
      noImproveStreak += 1
    }
  }
  return { bestMetric, noImproveStreak }
}

function autonomousLoopMaxIterations(inputValue: unknown, task: ResearchTask) {
  const requested = loopPolicyInteger(inputValue, task, "maxIterations") ?? NAS_DEFAULT_MAX_ITERATIONS
  return Math.max(1, Math.min(requested, 200))
}

function artifactDirsFromRecords(records: Record<string, unknown>[]) {
  return records
    .filter((record) => record.ephemeral !== true)
    .map((record) => record.artifact_dir)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
}

function neoCastRunIDFromArtifactURI(uri: string) {
  const withoutScheme = uri.startsWith("file://") ? uri.slice("file://".length) : uri
  const basename = path.basename(withoutScheme)
  return basename.startsWith("run_") ? basename.slice("run_".length) : undefined
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
      `- Primary metric (${objectiveMetricName(task.objective)}): ${formatMetricValue(champion.primaryMetric)}`,
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

// Quantitative analysis pipeline (stats, plots, buildDatasetAnalysisContext) lives in
// ./agents/data-analysis-agent — it's also invoked directly by the analyze_dataset tool
// (src/tool/research-data-analysis.ts), which cannot import this Session-wired module.

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

function taskDatasetSpec(task: ResearchTask) {
  const taskSpec = recordValue(task.taskSpec)
  return recordValue(taskSpec.dataset)
}

function datasetCovariateContext(task: ResearchTask) {
  const taskSpec = recordValue(task.taskSpec)
  const dataset = recordValue(taskSpec.dataset)
  const metadata = recordValue(taskSpec.metadata)
  const availability = recordValue(metadata.knownFutureAvailability)
  const observedPastCovariates = Array.isArray(dataset.observedPastCovariates)
    ? dataset.observedPastCovariates.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []
  const knownFutureCovariates = Array.isArray(dataset.knownFutureCovariates)
    ? dataset.knownFutureCovariates.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []
  const staticCovariates = Array.isArray(dataset.staticCovariates)
    ? dataset.staticCovariates.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []
  return {
    observedPastCovariates,
    knownFutureCovariates,
    staticCovariates,
    covariateCount: new Set([...observedPastCovariates, ...knownFutureCovariates, ...staticCovariates]).size,
    knownFutureAvailability: {
      availableAtPredictionTime:
        typeof availability.availableAtPredictionTime === "boolean" ? availability.availableAtPredictionTime : undefined,
      source: typeof availability.source === "string" ? availability.source : undefined,
    },
    experimentScope: typeof metadata.experimentScope === "string" ? metadata.experimentScope : undefined,
    productionComparable: typeof metadata.productionComparable === "boolean" ? metadata.productionComparable : undefined,
  }
}

function renderDatasetQualitativeAnalysis(
  task: ResearchTask,
  fingerprint: JsonRecord,
  context: DatasetAnalysisContext,
  llmGenerated?: string,
) {
  const profile = recordValue(recordValue(fingerprint).datasetProfile)
  const dataset = taskDatasetSpec(task)
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
  return PROMPT_RESEARCH_DATA_ANALYSIS
}

function parseSearchPreferencesFromQualitative(text: string): string[] {
  const sectionMatch = text.match(/##\s*Search Preferences\s*\n([\s\S]*?)(?:\n##|$)/)
  if (!sectionMatch) return []
  return sectionMatch[1]!
    .split("\n")
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter((line) => line.length > 10)
    .slice(0, 8)
}

function buildExtendedStatisticsAnalysis(context: DatasetAnalysisContext) {
  const statistics = context.statistics
  const decompositionShares = {
    trend: statistics.decomposition.trendVarianceShare,
    seasonal: statistics.decomposition.seasonalVarianceShare,
    residual: statistics.decomposition.residualVarianceShare,
  }
  const dominantComponent = Object.entries(decompositionShares)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
    .sort((left, right) => right[1] - left[1])[0]?.[0] ?? "unknown"
  const crossLagMagnitude = Math.abs(statistics.crossLag.correlation ?? 0)
  return {
    stationarity: {
      kpssStatistic: statistics.stationarity.kpssStatistic,
      kpssStationary: statistics.stationarity.kpssStationary,
      analysis: statistics.stationarity.kpssStationary
        ? "KPSS supports level stationarity under the configured rule."
        : "KPSS suggests non-stationarity or an inconclusive result; favor normalization, differencing, or decomposition.",
    },
    autocorrelation: {
      acfTopLag: statistics.acf.topLag,
      acfTopCorrelation: statistics.acf.topCorrelation,
      pacfTopLag: statistics.acf.pacfTopLag,
      pacfTopCorrelation: statistics.acf.pacfTopCorrelation,
      analysis: "Use the strongest ACF/PACF lags as evidence for seasonal periods, receptive fields, and patch scales.",
    },
    decomposition: {
      period: statistics.decomposition.period,
      ...decompositionShares,
      dominantComponent,
      analysis: `The ${dominantComponent} component explains the largest reported variance share; prioritize models that represent it explicitly.`,
    },
    frequency: {
      dominantPeriod: statistics.frequency.dominantPeriod,
      dominantPowerShare: statistics.frequency.dominantPowerShare,
      spectralPeakCount: statistics.frequency.spectralPeaks.length,
      significantPeakCount: statistics.frequency.spectralPeaks.filter((peak) => peak.significant).length,
      analysis: "Frequency features are better supported when dominant power is concentrated and multiple peaks are statistically significant.",
    },
    changepoint: {
      index: statistics.changepoint.index,
      score: statistics.changepoint.score,
      severity: statistics.changepoint.severity,
      analysis: statistics.changepoint.severity === "high"
        ? "A severe change point is a validation risk; use robust losses and split-aware evaluation."
        : "No severe change point dominates the current deterministic analysis.",
    },
    crossLag: {
      source: statistics.crossLag.source,
      target: statistics.crossLag.target,
      lag: statistics.crossLag.lag,
      correlation: statistics.crossLag.correlation,
      assessment: crossLagMagnitude >= 0.6 ? "strong" : crossLagMagnitude >= 0.4 ? "moderate" : crossLagMagnitude >= 0.2 ? "weak" : "very weak",
      analysis: crossLagMagnitude >= 0.4
        ? "The lead-lag signal can justify sparse directional cross-variable modeling."
        : "The lead-lag signal alone does not justify complex cross-variable modeling.",
    },
  }
}

function buildQualitativeUserPrompt(task: ResearchTask, fingerprint: JsonRecord, context: DatasetAnalysisContext): string {
  const profile = recordValue(recordValue(fingerprint).datasetProfile)
  const dataset = taskDatasetSpec(task)
  const covariates = datasetCovariateContext(task)
  return JSON.stringify(
    compactPromptContext({
      task: {
        id: task.id,
        title: task.title,
        domainID: task.domainID,
        objective: task.objective,
        dataset: {
          targetCols: dataset.targetCols,
          loaderID: dataset.loaderID,
          observedPastCovariates: covariates.observedPastCovariates,
          knownFutureCovariates: covariates.knownFutureCovariates,
          staticCovariates: covariates.staticCovariates,
          knownFutureAvailability: covariates.knownFutureAvailability,
          experimentScope: covariates.experimentScope,
          productionComparable: covariates.productionComparable,
        },
      },
      taskSpec: task.taskSpec,
      datasetProfileAnalysis: analyzeDatasetProfileForPrompt(profile),
      extendedStatisticsAnalysis: buildExtendedStatisticsAnalysis(context),
      instruction:
        "Call the analyze_dataset tool first to get authoritative statistics, then analyze the dataset " +
        "characteristics and provide qualitative domain insights for guiding TSF model search. " +
        "Important: targetCount describes forecast targets only. Do not conclude the task is exogenous-free " +
        "or production-infeasible when observedPastCovariates/knownFutureCovariates are listed above. " +
        "When knownFutureCovariates are present, discuss their availability and whether the scope is a production candidate " +
        "or an oracle upper-bound. The analyzed profile/statistics below are provided only as a fallback in case the tool is unavailable.",
    }),
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
): Promise<{ text: string; usage: import("./llm-proposal").LLMTokenUsage; searchPreferences: string[] } | undefined> {
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
    const result = await Promise.race([llmPromise, timeoutPromise])
    if (!result) {
      recordResearchEvent(workspaceRoot, "research.llm.fallback", { taskID: task.id, stage: "generateLLMQualitativeAnalysis", reason: "timeout" })
      return undefined
    }
    return { ...result, searchPreferences: parseSearchPreferencesFromQualitative(result.text) }
  } catch (error) {
    recordResearchEvent(workspaceRoot, "research.llm.fallback", { taskID: task.id, stage: "generateLLMQualitativeAnalysis", error: String(error) })
    return undefined
  }
}

function buildHypoPlannerSystemPrompt(): string {
  return PROMPT_RESEARCH_HYPO_PLANNER
}


function buildTaskDefinition(task: ResearchTask): Record<string, unknown> {
  const spec = recordValue(task.taskSpec)
  const dataset = recordValue(spec.dataset)
  const objective = recordValue(task.objective)
  const budget = recordValue(task.budget)
  const metadata = recordValue(spec.metadata)
  const intentSlots = recordValue(metadata.intentSlots)
  function slotOr(canonical: unknown, slotKey: string) {
    return canonical !== undefined && canonical !== null ? canonical : intentSlots[slotKey]
  }
  return {
    id: task.id,
    title: task.title,
    taskSpec: task.taskSpec,
    forecastObject: intentSlots.forecast_object ?? spec.forecastObject,
    dataset: {
      source: slotOr(dataset.path ?? dataset.loaderID, "data_source"),
      targetCols: slotOr(dataset.targetCols, "target_columns"),
      exogenousCols: intentSlots.exogenous_variables ?? dataset.exogenousCols,
      observedPastCovariates: dataset.observedPastCovariates,
      knownFutureCovariates: dataset.knownFutureCovariates,
      staticCovariates: dataset.staticCovariates,
      split: dataset.split,
    },
    contextLength: slotOr(spec.contextLength, "lookback_window"),
    predictionLengths: slotOr(spec.predictionLengths, "prediction_horizon"),
    timeGrain: intentSlots.time_grain ?? spec.timeGrain ?? spec.frequency,
    objective: {
      primaryMetric: slotOr(objective.primaryMetric, "primary_metric"),
      direction: objective.direction,
      errorPreferences: intentSlots.error_preferences ?? objective.errorPreferences,
    },
    budget: {
      maxRuns: budget.maxRuns,
      latencyBudget: intentSlots.latency_budget ?? budget.latencyBudget,
      parameterBudget: intentSlots.parameter_budget ?? budget.parameterBudget,
    },
    interpretability: intentSlots.interpretability ?? spec.interpretability,
    deploymentTarget: intentSlots.deployment_target ?? spec.deploymentTarget,
    businessContext: intentSlots.business_context ?? metadata.businessContext ?? metadata.business_context,
  }
}

function buildRetrieveTaskContext(task: ResearchTask): RetrieveTaskContext {
  const spec = recordValue(task.taskSpec)
  const metadata = recordValue(spec.metadata)
  const objective = recordValue(task.objective)
  const budget = recordValue(task.budget)
  const runtime = { ...recordValue(metadata.runtime), ...recordValue(spec.runtime) }
  const positiveNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
  const rawCompute = budget.computeProfile ?? runtime.computeProfile
  const computeProfile = rawCompute === "low" || rawCompute === "medium" || rawCompute === "high" ? rawCompute : "unknown"
  const primaryMetric = typeof objective.primaryMetric === "string" && objective.primaryMetric.trim()
    ? objective.primaryMetric.trim()
    : undefined
  return {
    taskType: typeof spec.taskType === "string" && spec.taskType.trim() ? spec.taskType.trim() : "forecasting",
    domain: typeof metadata.domain === "string" && metadata.domain.trim() ? metadata.domain.trim() : task.domainID,
    objective: {
      ...(primaryMetric === undefined ? {} : { primaryMetric }),
      probabilistic: spec.probabilistic === true || objective.probabilistic === true,
    },
    constraints: {
      computeProfile,
      ...(positiveNumber(budget.latencyBudget) === undefined ? {} : { latencyBudget: positiveNumber(budget.latencyBudget) }),
      ...(positiveNumber(budget.parameterBudget) === undefined ? {} : { parameterBudget: positiveNumber(budget.parameterBudget) }),
    },
  }
}

function buildHypoPlannerUserPrompt(
  task: ResearchTask,
  dataAnalysisSummary: string,
  existingHypotheses: readonly { id?: string; statement: string; status: string }[],
  abandonedHypotheses?: readonly { statement: string }[],
  taskEvidence?: TaskEvidenceBundle,
  opts?: {
    sessionMode?: boolean
    baselineOptions?: readonly { recipeID: string; description: string }[]
    requestedHistory?: readonly unknown[]
  },
): string {
  return JSON.stringify(
    {
      taskSpec: designTaskSpec(task.taskSpec),
      taskDefinition: buildTaskDefinition(task),
      designFeedback: recordValue(task.taskSpec.metadata).designFeedback ?? null,
      modelCapabilities: MODEL_CAPABILITIES,
      ...(opts?.requestedHistory?.length ? { requestedHistory: opts.requestedHistory } : {}),
      historyAccess: { tool: "experiment_results", filters: ["runID", "candidateID", "hypothesisID", "limit", "offset"], directMode: "Return {status:history_request,request:{runID:...}} to retrieve a comparison before planning." },
      searchProgress: recordValue(task.taskSpec.metadata).searchProgress ?? null,
      dataAnalysis: dataAnalysisSummary,
      existingHypotheses: existingHypotheses.length > 0
        ? existingHypotheses.map((h) => ({ id: h.id, statement: h.statement, status: h.status }))
        : null,
      abandonedHypotheses: abandonedHypotheses && abandonedHypotheses.length > 0
        ? abandonedHypotheses.map((h) => ({ statement: h.statement }))
        : null,
      taskEvidence: taskEvidence
        ? projectTaskEvidence(taskEvidence)
        : { readiness: "ready_data_only", entries: [], conflicts: [], gaps: [] },
      ...(opts?.baselineOptions && opts.baselineOptions.length > 0
        ? { baselineOptions: opts.baselineOptions }
        : {}),
      instruction:
        "If designFeedback is present, handle it before ordinary reflection maintenance: the named hypothesis was NOT tested. Inspect the exact conflicts and regenerate a feasible hypothesis (or explicitly revise the original), then select it. Do not repeat an unchanged unavailable hypothesis or mark its mechanism refuted. A control need not contain the treatment mechanism. If no useful feasible experiment remains, select stop. " +
        "If existingHypotheses is empty and designFeedback is absent (first iteration), generate a fresh list of exactly 2-3 hypotheses grounded in dataAnalysis — do not add more. " +
        "When designFeedback is absent and hypotheses exist, identify the single existingHypothesis most recently tested (identify it from requested experiment history/reflection) and act on that one only: " +
        "refine its statement/expectedOutcome if reflection provides new evidence, or drop it if reflection confirms it is exhausted or refuted. " +
        "If you drop it (it is now abandoned), add exactly one new replacement hypothesis exploring a different idea/direction so the active hypothesis count does not shrink. " +
        "Leave every other existingHypothesis unchanged — they have not been tested yet and there is no new evidence about them. " +
        "abandonedHypotheses lists ideas already abandoned in earlier rounds — do not regenerate hypotheses that restate or closely resemble these. " +
        "Ground each hypothesis's motivation in specific values from dataAnalysis or outcomes from previousReflection. " +
        "Set expectedOutcome to a concrete, metric-referenced prediction. " +
        "Choose the next experiment yourself from the entire open pool, considering exploration, local plateau and completed results; no priority field controls scheduling. " +
        (opts?.sessionMode ? "Finish by calling hypothesis_select exactly once, with an open hypoID and an evidence-based rationale, or action=stop if no useful experiment remains. " : "Return hypotheses plus nextExperiment={action:experiment,hypothesisID,rationale} or {action:stop,rationale} in one JSON object. ") +
        "Include requiredMechanisms only for the candidate arm being generated, not all mechanisms discussed in the scientific hypothesis. A control that omits the treatment mechanism must not require it; requiredMechanisms and forbiddenMechanisms must not overlap. Use modelCapabilities actual implementations; unsupported mechanisms cannot be inferred from backbone names. " +
        "Only cite cardID/revision/role combinations supplied in taskEvidence; relevance is not truth confidence. " +
        "Use evidenceLevel=data_only with empty literatureEvidence when no eligible entry exists. " +
        "Treat expectedOutcome as a prediction, surface contradictions in risk/applicabilityAssumptions, and provide at least one falsificationCriteria item per non-baseline hypothesis." +
        (opts?.baselineOptions && opts.baselineOptions.length > 0
          ? " After the hypothesis pool is updated, call pick_baseline exactly once to choose the single reference baseline from baselineOptions, citing specific dataAnalysis evidence."
          : ""),
    },
    null,
    2,
  )
}

function validateLLMHypothesisItem(raw: unknown): HypothesisObject | undefined {
  const rec = recordValue(raw)
  if (Object.keys(rec).length === 0) return undefined
  const experimentContract = rec.experimentContract === undefined ? undefined : ExperimentConstraints.safeParse(rec.experimentContract)
  if (!experimentContract?.success) return undefined
  const id = typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : undefined
  const statement = typeof rec.statement === "string" && rec.statement.trim() ? rec.statement.trim() : undefined
  if (!id || !statement) return undefined
  if (rec.requiredMechanisms !== undefined && !validMechanisms(rec.requiredMechanisms)) return undefined
  if (conflictingMechanismRequirements({
    requiredMechanisms: validMechanisms(rec.requiredMechanisms) ? rec.requiredMechanisms : [],
    experimentContract: experimentContract.data,
  }).length) return undefined
  const filterStrings = (value: unknown) =>
    Array.isArray(value)
      ? (value as unknown[]).filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : []
  const motivation = filterStrings(rec.motivation)
  const expectedOutcome = typeof rec.expectedOutcome === "string" ? rec.expectedOutcome : ""
  const suggestedBackbones = filterStrings(rec.suggestedBackbones)
  const suggestedPreprocessing = filterStrings(rec.suggestedPreprocessing)
  const risk = typeof rec.risk === "string" ? rec.risk : ""
  const testable = typeof rec.testable === "boolean" ? rec.testable : true
  const datasetEvidencePaths = filterStrings(rec.datasetEvidencePaths)
  const applicabilityAssumptions = filterStrings(rec.applicabilityAssumptions)
  const falsificationCriteria = filterStrings(rec.falsificationCriteria)
  const evidenceLevel = rec.evidenceLevel === "data_only" || rec.evidenceLevel === "paper_supported" || rec.evidenceLevel === "conflicted"
    ? rec.evidenceLevel
    : undefined
  if (!Array.isArray(rec.datasetEvidencePaths) || !Array.isArray(rec.literatureEvidence) ||
      !Array.isArray(rec.applicabilityAssumptions) || !Array.isArray(rec.falsificationCriteria) || !evidenceLevel) return undefined
  const roles = new Set<string>(TASK_EVIDENCE_ROLES)
  const literatureEvidence = (rec.literatureEvidence as unknown[]).map((item) => {
    const reference = recordValue(item)
    if (typeof reference.cardID !== "string" || !Number.isInteger(reference.cardRevision) ||
        typeof reference.role !== "string" || !roles.has(reference.role)) return undefined
    return {
      cardID: reference.cardID,
      cardRevision: reference.cardRevision as number,
      role: reference.role as TaskEvidenceRole,
    }
  })
  if (literatureEvidence.some((item) => item === undefined)) return undefined
  if (rec.requiredMechanisms !== undefined && !validMechanisms(rec.requiredMechanisms)) return undefined
  return {
    id,
    statement,
    motivation,
    expectedOutcome,
    suggestedBackbones,
    suggestedPreprocessing,
    ...(experimentContract?.success ? { experimentContract: experimentContract.data } : {}),
    requiredMechanisms: validMechanisms(rec.requiredMechanisms) ? rec.requiredMechanisms : [],
    risk,
    testable,
    datasetEvidencePaths,
    literatureEvidence: literatureEvidence as Array<{ cardID: string; cardRevision: number; role: TaskEvidenceRole }>,
    applicabilityAssumptions,
    falsificationCriteria,
    evidenceLevel,
  }
}

type LatestReflectionSummary = {
  reflectionNotesMarkdown: string
  decision: string
  decisionReason: string
  llm?: ReflectionAgentResult["llm"]
} | null

async function loadLLMSearchPreferences(workspaceRoot: string, taskID: string): Promise<string[] | undefined> {
  try {
    const prefPath = path.join(workspaceRoot, ".neo-research", "sessions", taskID, "analysis", "search_preferences.json")
    const raw = await readFile(prefPath, "utf8")
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as unknown[]).filter((s): s is string => typeof s === "string") : undefined
  } catch { return undefined }
}

/**
 * Parses an LLM-generated hypothesis list from raw response text. Returns undefined when the
 * text doesn't contain a valid hypotheses array — callers should treat this as a failed attempt.
 */
function parseLLMHypothesesResult(
  text: string,
  usage: import("./llm-proposal").LLMTokenUsage,
): { hypotheses: readonly HypothesisObject[]; nextExperiment: NextExperimentDecision; usage: import("./llm-proposal").LLMTokenUsage } | undefined {
  try {
    const parsed = extractJsonObject(text)
    const parsedRec = recordValue(parsed)
    if (!Array.isArray(parsedRec.hypotheses)) return undefined
    const rawHypotheses = (parsedRec.hypotheses as unknown[]).slice(0, 8)
    const validated = rawHypotheses.map(validateLLMHypothesisItem)
    if (validated.some((item) => item === undefined)) return undefined
    const nextExperiment = parseNextExperiment(parsedRec.nextExperiment)
    if (!nextExperiment || (nextExperiment.action === "experiment" && !validated.some((h) => h?.id === nextExperiment.hypothesisID && isOpenHypothesis(h) && !unsupportedMechanisms(h.requiredMechanisms ?? []).length))) return undefined
    return validated.length > 0 || nextExperiment.action === "stop" ? { hypotheses: validated as HypothesisObject[], nextExperiment, usage } : undefined
  } catch {
    return undefined
  }
}

async function generateLLMHypotheses(
  task: ResearchTask,
  dataAnalysisSummary: string,
  workspaceRoot: string,
  onDelta?: (delta: string) => void,
  existingHypotheses?: readonly { id?: string; statement: string; status: string }[],
  abandonedHypotheses?: readonly { statement: string }[],
  taskEvidence?: TaskEvidenceBundle,
): Promise<{ hypotheses: readonly HypothesisObject[]; nextExperiment: NextExperimentDecision; usage: import("./llm-proposal").LLMTokenUsage } | undefined> {
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
    const system = buildHypoPlannerSystemPrompt() + "\nDirect mode: no native tool calls. To read historical facts return {status:history_request,request:{runID:...}} first; the coordinator returns the requested history. Otherwise return exactly one JSON object with hypotheses and nextExperiment (action=experiment with hypothesisID/rationale, or action=stop with rationale). Omit priority; include requiredMechanisms."
    const requestedHistory: unknown[] = []
    let validationFeedback: string | undefined
    let repairAttempts = 0
    for (let historyRound = 0; historyRound <= 5; historyRound++) {
      const user = JSON.stringify({ ...JSON.parse(buildHypoPlannerUserPrompt(task, dataAnalysisSummary, existingHypotheses ?? [], abandonedHypotheses ?? [], taskEvidence, { requestedHistory })), ...(validationFeedback ? { validationFeedback } : {}) })
      const llmPromise = onDelta
        ? requestNeoCastLLMStream({ ...effectiveConfig, maxTokens: 8192 }, apiKey, system, user, onDelta)
        : requestNeoCastLLM({ ...effectiveConfig, maxTokens: 8192 }, apiKey, system, user)
      let timer: ReturnType<typeof setTimeout> | undefined
      const result = await Promise.race([llmPromise, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 120_000) })]).finally(() => clearTimeout(timer))
      if (!result) return undefined
      const request = DesignHistoryRequest.safeParse(extractJsonObject(result.text))
      if (request.success) {
        if (historyRound === 5) return undefined
        requestedHistory.push({ request: request.data.request, result: await readDesignHistory(task.id, request.data.request) })
        continue
      }
      const parsed = parseLLMHypothesesResult(result.text, result.usage)
      if (parsed) return parsed
      if (++repairAttempts > 1) return undefined
      validationFeedback = "Previous response was invalid. Return hypotheses with a valid predeclared experimentContract for EACH hypothesis, requiredMechanisms for its candidate arm, id and statement, plus nextExperiment selecting one of these IDs or explicitly stopping. Never require and forbid the same mechanism; a control removing decomposition must not require decomposition. Do not silently change a controlled hypothesis into exploration. Retrieve the comparison run if needed."
    }
    return undefined
  } catch (error) {
    recordResearchEvent(workspaceRoot, "research.llm.fallback", { taskID: task.id, stage: "generateLLMHypotheses", error: String(error) })
    return undefined
  }
}

interface ReflectionLLMContext {
  /** Full canonical task contract, including dataset role columns and metadata. */
  readonly taskSpec: JsonRecord
  /** Objective statement derived from the task (metric name + direction + target). */
  readonly taskObjective: string
  /** User-confirmed NAS iteration plan used to judge remaining search capacity. */
  readonly maxIterations: number
  /** Rationale of the most recent candidate — encodes the hypothesis being tested. */
  readonly currentHypothesis?: string
  /** candidateSpec JSON of the most recent candidate (architecture + training recipe). */
  readonly experimentDesign?: unknown
  readonly executedModel?: unknown
  /** Training curve: ordered array of { epoch, valLoss, horizon?, elapsedS? } data points. */
  readonly trainingCurve: readonly TrainingCurvePoint[]
  /** Lessons from the two most recent distinct memory entries. */
  readonly recentMemories: readonly string[]
  /** Lesson from the memory entry that recorded the all-time best metric. */
  readonly bestMemoryLesson?: string
  readonly sourceRuns?: readonly unknown[]
  readonly experiences?: readonly unknown[]
  readonly literatureKnowledge?: Awaited<ReturnType<typeof readReflectionKnowledge>>
}

function buildReflectionLLMSystemPrompt(): string {
  return buildInlineReflectionSystemPrompt(PROMPT_RESEARCH_REFLECTION)
}

function buildReflectionSessionUserPrompt(
  task: ResearchTask,
  analysis: ReflectionAnalysis,
  currentHypothesis?: string,
  maxIterations = autonomousLoopMaxIterations(undefined, task),
): string {
  const objectiveRecord = recordValue(task.objective)
  const direction = analysis.direction
  const taskObjective = [
    `${direction === "minimize" ? "Minimize" : "Maximize"} ${analysis.primaryMetricName}`,
    typeof objectiveRecord.targetMetricValue === "number"
      ? `target ≤ ${objectiveRecord.targetMetricValue}`
      : null,
    typeof objectiveRecord.description === "string" ? objectiveRecord.description : null,
  ].filter(Boolean).join(". ")
  return JSON.stringify(
    compactPromptContext({
      taskSpec: task.taskSpec,
      taskObjective,
      maxIterations,
      modelCapabilities: MODEL_CAPABILITIES,
      currentHypothesis: currentHypothesis ?? null,
      structuralAnalysis: {
        decision: analysis.decision,
        decisionReason: analysis.decisionReason,
        primaryMetricName: analysis.primaryMetricName,
        direction: analysis.direction,
        bestMetric: analysis.bestMetric ?? null,
        latestMetric: analysis.latestMetric ?? null,
        latestDelta: analysis.latestDelta ?? null,
        succeededRuns: analysis.succeededRuns,
        inconclusiveRuns: analysis.inconclusiveRuns,
        hypothesisTestedRuns: analysis.hypothesisTestedRuns,
        unattributableRuns: analysis.unattributableRuns,
        failedRuns: analysis.failedRuns,
        rejectedRuns: analysis.rejectedRuns,
        plateauStreak: analysis.plateauStreak,
      },
      instruction:
        "Follow the 4-step tool workflow in the system prompt (experiment_results → read_reflection → " +
        "read_training_curve → read_memory_lessons). Read structured experience with read_experiences when helpful. " +
        "Optionally call write_experience for useful findings. Read literature using read_knowledge_cards and confirm_knowledge only when current experiment facts validate a supplied claim; then output the 7-key JSON analysis object.",
    }),
    null,
    2,
  )
}

function buildReflectionLLMUserPrompt(analysis: ReflectionAnalysis, context: ReflectionLLMContext): string {
  return JSON.stringify(
    { ...recordValue(compactPromptContext({
      taskSpec: context.taskSpec,
      taskObjective: context.taskObjective,
      maxIterations: context.maxIterations,
      originalHypothesis: context.currentHypothesis ?? null,
      experimentDesign: context.experimentDesign ?? null,
      modelCapabilities: MODEL_CAPABILITIES,
      executedModel: context.executedModel ?? null,
      experimentResults: {
        primaryMetricName: analysis.primaryMetricName,
        direction: analysis.direction,
        bestMetric: analysis.bestMetric ?? null,
        bestRunID: analysis.bestRunID ?? null,
        latestMetric: analysis.latestMetric ?? null,
        latestDelta: analysis.latestDelta ?? null,
        succeededRuns: analysis.succeededRuns,
        inconclusiveRuns: analysis.inconclusiveRuns,
        hypothesisTestedRuns: analysis.hypothesisTestedRuns,
        unattributableRuns: analysis.unattributableRuns,
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
      },
      trainingCurve: context.trainingCurve.length > 0 ? context.trainingCurve : null,
      historicalExperimentMemory: {
        recentLessons: context.recentMemories,
        bestResultLesson: context.bestMemoryLesson ?? null,
      },
      sourceRuns: context.sourceRuns ?? [],
      experiences: context.experiences ?? [],
      experienceWriteSchema: z.toJSONSchema(ExperienceDraftSchema),
      knowledgeValidationSchema: z.toJSONSchema(KnowledgeValidationDraftSchema),
      decision: analysis.decision,
      decisionReason: analysis.decisionReason,
    })), literatureKnowledge: context.literatureKnowledge },
    null,
    2,
  )
}

function parseReflectionLLMStructured(text: string): ReflectionLLMAnalysis | undefined {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return undefined
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
    const str = (key: string) => (typeof parsed[key] === "string" && parsed[key] ? parsed[key] as string : undefined)
    const trainingHealthAssessment = str("trainingHealthAssessment")
    const hypothesisValidation = str("hypothesisValidation")
    const attributionAnalysis = str("attributionAnalysis")
    const historicalComparison = str("historicalComparison")
    const modelDesignReflection = str("modelDesignReflection")
    const nextStepRecommendation = str("nextStepRecommendation")
    const distillableMemory = str("distillableMemory")
    if (
      !trainingHealthAssessment || !hypothesisValidation || !attributionAnalysis ||
      !historicalComparison || !modelDesignReflection || !nextStepRecommendation || !distillableMemory
    ) return undefined
    return {
      trainingHealthAssessment,
      hypothesisValidation,
      attributionAnalysis,
      historicalComparison,
      modelDesignReflection,
      nextStepRecommendation,
      distillableMemory,
      ...(parsed.knowledgeValidations === undefined ? {} : {
        knowledgeValidations: z.array(KnowledgeValidationDraftSchema).max(3).parse(parsed.knowledgeValidations),
      }),
      ...(parsed.experienceWrites === undefined ? {} : {
        experienceWrites: z.array(ExperienceDraftSchema).max(3).parse(parsed.experienceWrites),
      }),
    }
  } catch {
    return undefined
  }
}

function buildReflectionResultFromText(
  baseResult: ReflectionAgentResult,
  model: string,
  text: string,
  usage: import("./llm-proposal").LLMTokenUsage,
): ReflectionAgentResult {
  return {
    ...baseResult,
    llm: {
      status: "used",
      model,
      text,
      structured: parseReflectionLLMStructured(text),
      usage,
    },
  }
}

async function generateLLMReflectionSynthesis(
  task: ResearchTask,
  result: ReflectionAgentResult,
  context: ReflectionLLMContext,
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
    const user = buildReflectionLLMUserPrompt(result.analysis, context)
    // Race against 25-second timeout so a slow/hung LLM provider never blocks the pipeline.
    const llmPromise = requestNeoCastLLM(effectiveConfig, apiKey, system, user)
    const timeoutPromise = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 25_000))
    const llmResult = await Promise.race([llmPromise, timeoutPromise])
    if (llmResult === undefined) return { ...result, llm: { status: "failed" } }
    const structured = parseReflectionLLMStructured(llmResult.text)
    if (!structured) {
      return { ...result, llm: {
        status: "failed", model: effectiveConfig.model,
        error: "Reflection response must contain the seven required analysis fields.",
        usage: llmResult.usage,
      } }
    }
    return {
      ...result,
      llm: {
        status: "used",
        model: effectiveConfig.model,
        text: llmResult.text,
        structured,
        usage: llmResult.usage,
      },
    }
  } catch {
    return { ...result, llm: { status: "failed" } }
  }
}

function buildDatasetAnalysisReports(
  task: ResearchTask,
  fingerprint: JsonRecord,
  context: DatasetAnalysisContext,
  llmQualitative?: string,
  sourceArtifactIDs: readonly ResearchArtifactID[] = [],
): DatasetAnalysisReport[] {
  const quantitative = analyzeDataset({ task, fingerprint, context, sourceArtifactIDs })
  return [
    {
      kind: "dataset_quantitative_analysis_markdown",
      filename: "quantitative_analysis.md",
      role: "quantitative-data-analyst",
      content: quantitative.reportMarkdown,
      metadata: {
        format: "markdown",
        role: "quantitative-data-analyst",
        phase: "data_analysis",
      } as JsonRecord,
    },
    {
      kind: "dataset_quantitative_analysis_json",
      filename: "quantitative_analysis.json",
      role: "quantitative-data-analyst",
      content: `${JSON.stringify(quantitative.reportJSON, null, 2)}\n`,
      metadata: {
        format: "json",
        schemaVersion: "dataset_quantitative_analysis_v1",
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
        inputs: ["dataset_quantitative_analysis_json", "dataset_quantitative_analysis_markdown", "dataset_qualitative_analysis_markdown"],
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

async function ensureRunnerStateInitialized(plan: DomainRunPlan, signal?: AbortSignal): Promise<void> {
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
    abort: signal,
    tree: true,
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
  signal?: AbortSignal,
  onSpawn?: (pid: number) => void,
  onStderrLine?: (line: string) => void,
): Promise<RunnerExecution> {
  const cwd = plan.command.cwd ?? process.cwd()
  signal?.throwIfAborted()
  await ensureRunnerStateInitialized(plan, signal)
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
    abort: signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal,
    tree: true,
    kill: "SIGKILL",
    timeout: RUNNER_ABORT_KILL_GRACE_MS,
    nothrow: true,
    onSpawn,
    onStdoutLine: handleStdoutLine,
    onStderrLine: (line) => { resetIdleTimer(); onStderrLine?.(line) },
  }).finally(clearRunnerTimers)
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
    path.join(plan.command.cwd ?? workspaceRoot, ".neo-cast", "dataset_spec.json"),
    path.join(plan.command.cwd ?? workspaceRoot, ".neo-cast", "dataset", "dataset_spec.json"),
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
  const metadata = recordValue(taskSpec.metadata)
  const availability = recordValue(metadata.knownFutureAvailability)
  const split = recordValue(dataset.split)
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
  const observedPastCovariates = Array.isArray(dataset.observedPastCovariates)
    ? dataset.observedPastCovariates.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []
  const knownFutureCovariates = Array.isArray(dataset.knownFutureCovariates)
    ? dataset.knownFutureCovariates.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []
  const staticCovariates = Array.isArray(dataset.staticCovariates)
    ? dataset.staticCovariates.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []
  const loaderID = typeof dataset.loaderID === "string" && dataset.loaderID.length > 0 ? dataset.loaderID : "local_csv"
  const ratios = Array.isArray(split.ratios) && split.ratios.length === 3
    ? split.ratios.map((item) => Number(item))
    : [7, 1, 2]
  const rowRange = (value: unknown): [number, number] | undefined =>
    Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === "number")
      ? [value[0], value[1]]
      : undefined
  return {
    root: path.resolve(root),
    source: path.resolve(source),
    loaderID,
    splitMethod: split.method === "row_ranges" ? "row_ranges" as const : "ratio" as const,
    splitRatios: ratios as [number, number, number],
    splitRows: split.method === "row_ranges"
      ? {
          train: rowRange(split.trainRows),
          validation: rowRange(split.validationRows),
          test: rowRange(split.testRows),
        }
      : undefined,
    contextLength: contextLength === undefined ? undefined : Math.floor(contextLength),
    predictionLengths: predictionLengths.map((item) => Math.floor(item)),
    targetCols,
    observedPastCovariates,
    knownFutureCovariates,
    staticCovariates,
    knownFutureSource: typeof availability.source === "string" ? availability.source : undefined,
    knownFutureAvailable: typeof availability.availableAtPredictionTime === "boolean"
      ? availability.availableAtPredictionTime
      : undefined,
    experimentScope: typeof metadata.experimentScope === "string" ? metadata.experimentScope : undefined,
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

function validateDatasetSplitRows(input: {
  readonly totalRows: number
  readonly inputLen?: number
  readonly predictionLengths: readonly number[]
  readonly splitRows: DatasetSplitRows
  readonly label: string
}) {
  const { train, validation, test } = input.splitRows
  if (
    train[0] !== 0 ||
    train[1] !== validation[0] ||
    validation[1] !== test[0] ||
    train[1] <= train[0] ||
    validation[1] <= validation[0] ||
    test[1] <= test[0]
  ) {
    throw new Error(
      `Dataset is too short for ${input.label}: computed ranges must be contiguous and non-empty ` +
        `(train=${train.join(":")}, validation=${validation.join(":")}, test=${test.join(":")}).`,
    )
  }
  if (test[1] > input.totalRows) {
    throw new Error(`${input.label} ends at row ${test[1]}, but the dataset only has ${input.totalRows} rows`)
  }
  if (input.inputLen === undefined || input.predictionLengths.length === 0) return
  const maxHorizon = Math.max(...input.predictionLengths)
  if (
    train[1] - train[0] < input.inputLen + maxHorizon ||
    validation[1] - validation[0] < maxHorizon ||
    test[1] - test[0] < maxHorizon
  ) {
    throw new Error(
      `Dataset is too short for ${input.label}: rows=${input.totalRows}, input_len=${input.inputLen}, ` +
        `max_horizon=${maxHorizon}, train=${train.join(":")}, validation=${validation.join(":")}, ` +
        `test=${test.join(":")}. Lower input_len/horizons or provide larger split ranges.`,
    )
  }
}

function resolveDatasetSplitRows(config: NonNullable<ReturnType<typeof tsfDatasetPreparationConfig>>): DatasetSplitRows {
  const totalRows = csvDataRowCount(config.source)
  if (totalRows === undefined) throw new Error(`Cannot count CSV rows in ${config.source}`)
  let splitRows: DatasetSplitRows
  let label: string
  if (config.splitMethod === "row_ranges") {
    const train = config.splitRows?.train
    const validation = config.splitRows?.validation
    const test = config.splitRows?.test
    if (!train || !validation || !test) throw new Error("Explicit data split requires train, validation, and test row ranges")
    splitRows = { train, validation, test }
    label = "explicit row-range split"
  } else {
    const [trainRatio, validationRatio, testRatio] = config.splitRatios
    const totalRatio = trainRatio + validationRatio + testRatio
    if (![trainRatio, validationRatio, testRatio, totalRatio].every((item) => Number.isFinite(item) && item > 0)) {
      throw new Error("Data split ratios must contain three positive numbers")
    }
    const trainEnd = Math.floor(totalRows * trainRatio / totalRatio)
    const validationEnd = Math.floor(totalRows * (trainRatio + validationRatio) / totalRatio)
    splitRows = {
      train: [0, trainEnd],
      validation: [trainEnd, validationEnd],
      test: [validationEnd, totalRows],
    }
    label = `ratio split ${trainRatio}:${validationRatio}:${testRatio}`
  }
  validateDatasetSplitRows({
    totalRows,
    inputLen: config.contextLength,
    predictionLengths: config.predictionLengths,
    splitRows,
    label,
  })
  return splitRows
}

function buildPrepareDatasetCommand(task: ResearchTask, force: boolean, projectRoot: string) {
  const config = tsfDatasetPreparationConfig(task)
  if (!config) {
    throw new Error("TSF dataset preparation requires taskSpec.dataset.path and taskSpec.runtime.neoCastProjectRoot")
  }
  config.source = path.resolve(projectRoot, String(recordValue(task.taskSpec.dataset).path))
  const executionRoot = taskExecutionRoot(task, projectRoot)
  const args = [path.join(config.root, "bin", "neo-cast.js"), "prepare-data", "--source", config.source]
  const preset = datasetPresetFromLoader(config.loaderID)
  if (preset) args.push("--dataset-preset", preset)
  else args.push("--task-id", config.loaderID)
  const splitRows = resolveDatasetSplitRows(config)
  args.push("--train-rows", splitRows.train.join(":"))
  args.push("--val-rows", splitRows.validation.join(":"))
  args.push("--ref-test-rows", splitRows.test.join(":"))
  const warnings: string[] = []
  if (config.targetCols.length > 0) {
    const csvHeaders = csvHeaderColumns(config.source)
    const roleColumns = [...new Set([
      ...config.targetCols,
      ...config.observedPastCovariates,
      ...config.knownFutureCovariates,
      ...config.staticCovariates,
    ])]
    const missing = csvHeaders.length > 0 ? roleColumns.filter((col) => !csvHeaders.includes(col)) : []
    if (missing.length > 0) {
      throw new Error(
        `Dataset role columns were not found in ${config.source}: ${missing.join(", ")}. ` +
          `CSV header: ${csvHeaders.join(", ")}.`,
      )
    }
    args.push("--target-cols", config.targetCols.join(","))
    if (config.observedPastCovariates.length > 0)
      args.push("--observed-past-covariates", config.observedPastCovariates.join(","))
    // Availability metadata can describe the absence of future covariates.
    // Only pass it to the runner when there are actual future columns.
    if (config.knownFutureCovariates.length > 0) {
      args.push("--known-future-covariates", config.knownFutureCovariates.join(","))
      if (config.knownFutureSource) args.push("--known-future-source", config.knownFutureSource)
      if (config.knownFutureAvailable !== undefined)
        args.push("--known-future-available", String(config.knownFutureAvailable))
    }
    if (config.staticCovariates.length > 0) args.push("--static-covariates", config.staticCovariates.join(","))
    if (config.experimentScope) args.push("--experiment-scope", config.experimentScope)
  }
  if (config.contextLength !== undefined) args.push("--input-len", String(config.contextLength))
  if (config.predictionLengths.length > 0) args.push("--horizons", config.predictionLengths.join(","))
  if (force) args.push("--force")
  const sharedVenv = path.join(config.root, ".neo-cast", "runtime", ".venv")
  const sharedPython = path.join(sharedVenv, "bin", "python")
  const sharedPythonBin = path.dirname(sharedPython)
  return {
    executable: process.env.NEO_CAST_NODE ?? "node",
    args,
    cwd: path.resolve(executionRoot),
    env: {
      NEO_CAST_PROJECT_ROOT: path.resolve(executionRoot),
      NEO_CAST_PACKAGE_ROOT: config.root,
      ...(existsSync(sharedPython)
        ? {
            PATH: `${sharedPythonBin}${path.delimiter}${process.env.PATH ?? ""}`,
            VIRTUAL_ENV: sharedVenv,
          }
        : {}),
    },
    runnerRoot: config.root,
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

const decodeApproval = Schema.decodeUnknownSync(ResearchApproval)
const decodeCandidate = Schema.decodeUnknownSync(ResearchCandidate)
const decodeRun = Schema.decodeUnknownSync(ResearchRun)
const decodeArtifact = Schema.decodeUnknownSync(ResearchArtifact)
const decodeMemory = Schema.decodeUnknownSync(ResearchMemory)
const decodeChampion = Schema.decodeUnknownSync(ResearchChampion)

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
    hypothesisID: row.hypothesis_id ?? undefined,
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
  readonly reconcileInterruptedRuns: (taskID: ResearchTaskID) => Effect.Effect<void>
  readonly ensureCockpitChat: (taskID: ResearchTaskID) => Effect.Effect<{ id: string }>
  readonly createTask: (input: CreateTaskInput) => Effect.Effect<ResearchTask>
  readonly listTasks: (input?: ListTaskInput) => Effect.Effect<ResearchTask[]>
  readonly getTask: (taskID: ResearchTaskID) => Effect.Effect<ResearchTask>
  readonly updateTaskStatus: (input: UpdateTaskStatusInput) => Effect.Effect<ResearchTask>
  readonly updateTaskSpec: (input: UpdateTaskSpecInput) => Effect.Effect<ResearchTask>
  readonly updateTaskBudget: (input: UpdateTaskBudgetInput) => Effect.Effect<ResearchTask>
  readonly createCandidate: (input: CreateCandidateInput) => Effect.Effect<ResearchCandidate>
  readonly listCandidates: (taskID: ResearchTaskID) => Effect.Effect<ResearchCandidate[]>
  readonly createRun: (input: CreateRunInput) => Effect.Effect<ResearchRun>
  readonly updateRunStatus: (input: UpdateRunStatusInput) => Effect.Effect<ResearchRun>
  readonly listRuns: (taskID: ResearchTaskID) => Effect.Effect<ResearchRun[]>
  readonly createArtifact: (input: CreateArtifactInput) => Effect.Effect<ResearchArtifact>
  readonly listArtifacts: (taskID: ResearchTaskID) => Effect.Effect<ResearchArtifact[]>
  readonly listHypotheses: (taskID: ResearchTaskID) => Effect.Effect<HypothesisObject[]>
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
  readonly executePreparedRun: (input: PreparedRun) => Effect.Effect<PreparedRun>
  readonly executeRun: (input: PrepareRunInput) => Effect.Effect<PreparedRun>
  readonly executeSeedSweep: (input: ExecuteSeedSweepInput) => Effect.Effect<SeedSweepResult>
  readonly resumeExecutionContractCheckpoint: (taskID: ResearchTaskID) => Effect.Effect<PreparedRun | undefined>
  readonly runAutonomousIteration: (input: AutonomousIterationInput) => Effect.Effect<AutonomousIterationResult>
  readonly runAutonomousLoop: (input: AutonomousLoopInput) => Effect.Effect<AutonomousLoopResult>
  readonly runIntentAgent: (taskID: ResearchTaskID) => Effect.Effect<IntentAgentResult>
  readonly answerIntentQuestion: (input: AnswerIntentInput) => Effect.Effect<IntentAgentResult>
  readonly interpretAndApplySlotModification: (input: { taskID: ResearchTaskID; message: string }) => Effect.Effect<IntentAgentResult>
  readonly runDataAnalysisAgent: (input: ProfileTaskInput) => Effect.Effect<DataAnalysisAgentResult>
  readonly runRetrieveAgent: (input: RunRetrieveAgentInput) => Effect.Effect<RetrieveResult>
  readonly runHypoPlannerAgent: (input: {
    readonly taskID: ResearchTaskID
    readonly outputDir?: string
    readonly taskEvidenceArtifactID?: ResearchArtifactID
  }) => Effect.Effect<HypoPlannerResult>
  readonly runNASAgent: (input: AutonomousLoopInput) => Effect.Effect<NASAgentResult>
  readonly runVerifierAgent: (input: VerifierAgentRunInput) => Effect.Effect<VerifierAgentResult>
  readonly runReflectionAgent: (input: ReflectionAgentInput) => Effect.Effect<ReflectionAgentResult>
  readonly runPublishAgent: (input: ExportTaskArtifactInput) => Effect.Effect<PublishAgentResult>
  readonly runFullPipeline: (input: RunFullPipelineInput) => Effect.Effect<RunFullPipelineResult>
  readonly getResearchLLMStatus: () => Effect.Effect<ResearchLLMStatus>
}

export type RunRetrieveAgentInput = {
  readonly taskID: ResearchTaskID
  readonly force?: boolean
  readonly budgets?: Partial<RetrievalBudgets>
  readonly maxCardsPerPaper?: number
  readonly catalogPath?: string
}

const llmCallLog = Log.create({ service: "research.llm" })

/** Logs which transport an agent-stage LLM call used — opencode session vs. direct API. */
function logLLMCallPath(stage: string, taskID: string, path: "session" | "direct"): void {
  llmCallLog.info(`${stage} LLM call via ${path}`, { stage, taskID, path })
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Research") {}

export const layer: Layer.Layer<Service, never, Bus.Service | Session.Service | SessionPrompt.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const session = yield* Session.Service
    const sessionPrompt = yield* SessionPrompt.Service
    const selectSessionModel = (taskID: string, requested: OpencodeModelRef | undefined) =>
      Effect.gen(function* () {
        const task = yield* getTask(taskID as ResearchTaskID)
        const pinned = taskSessionModel(task.taskSpec)
        const selected = yield* resolveSessionModel(requested, pinned ?? (yield* Effect.promise(readSelectedSessionModel))).pipe(
          Effect.provide(Provider.defaultLayer),
        )
        if (!pinned) yield* Effect.sync(() => Database.transaction((d) => {
          const current = d.select().from(ResearchTaskTable).where(eq(ResearchTaskTable.id, task.id)).get()!
          const spec = current.task_spec as JsonRecord
          if (!taskSessionModel(spec)) d.update(ResearchTaskTable).set({
            task_spec: { ...spec, metadata: { ...recordValue(spec.metadata), sessionModel: selected } },
          }).where(eq(ResearchTaskTable.id, task.id)).run()
        }))
        recordResearchEvent(Instance.directory, "research.model.selected", {
          taskID, requested: requested ?? null, selected,
          fallback: requested?.providerID !== selected.providerID || requested?.modelID !== selected.modelID,
        })
        return selected
      })

    /**
     * Routes a research-loop stage's user prompt through opencode's SessionPrompt machinery,
     * in a fresh child session scoped to the task's root session. Returns undefined when the
     * task has no root session, neither a TUI selection nor a mapped research model exists,
     * or the session-based call throws — callers can fall back to the direct LLM transport.
     */
    const requestViaSession = (input: {
      readonly rootSessionID: string | undefined
      readonly agent: string
      readonly stageLabel: string
      readonly taskID: string
      readonly user: string
      readonly evidenceBinding?: { taskID: ResearchTaskID; artifactID?: ResearchArtifactID }
      readonly modelRef: OpencodeModelRef | undefined
      readonly onDelta?: (delta: string) => Effect.Effect<void>
      readonly onPartUpdated?: (part: MessageV2.Part) => Effect.Effect<void>
    }) =>
      Effect.gen(function* () {
        if (!input.rootSessionID || (!input.modelRef && !taskSessionModel((yield* getTask(input.taskID as ResearchTaskID)).taskSpec) && !(yield* Effect.promise(readSelectedSessionModel)))) return undefined
        const child = yield* session.create({
          parentID: input.rootSessionID as Session.Info["id"],
          title: `${input.stageLabel} · ${input.taskID}`,
        })
        const onDelta = input.onDelta
        const onPartUpdated = input.onPartUpdated
        const releaseEvidence = input.evidenceBinding
          ? bindTaskEvidenceToSession(child.id, input.evidenceBinding.taskID, input.evidenceBinding.artifactID)
          : () => {}
        const promptEffect = timedEffect("research.session", { taskID: input.taskID, sessionID: child.id, agent: input.agent }, sessionPrompt.prompt({
          sessionID: child.id,
          agent: input.agent,
          model: yield* selectSessionModel(input.taskID, input.modelRef),
          parts: [{ type: "text", text: input.user }],
        })).pipe(Effect.onInterrupt(() => sessionPrompt.cancel(child.id)), Effect.ensuring(Effect.sync(releaseEvidence)))
        const result = (onDelta || onPartUpdated)
          ? yield* Effect.scoped(
              Effect.gen(function* () {
                if (onDelta) {
                  yield* Effect.forkScoped(
                    bus.subscribe(MessageV2.Event.PartDelta).pipe(
                      Stream.filter((event) => event.properties.sessionID === child.id && event.properties.field === "text"),
                      Stream.runForEach((event) => onDelta(event.properties.delta)),
                    ),
                  )
                }
                if (onPartUpdated) {
                  yield* Effect.forkScoped(
                    bus.subscribe(MessageV2.Event.PartUpdated).pipe(
                      Stream.filter((event) => event.properties.sessionID === child.id),
                      Stream.runForEach((event) => onPartUpdated(event.properties.part as MessageV2.Part)),
                    ),
                  )
                }
                return yield* promptEffect
              }),
            )
          : yield* promptEffect
        const text = result.parts
          .filter((part) => part.type === "text")
          .map((part) => (part as { text: string }).text)
          .join("\n")
        const tokens = result.info.role === "assistant" ? result.info.tokens : undefined
        const usage: LLMTokenUsage = tokens
          ? {
              inputTokens: tokens.input,
              outputTokens: tokens.output,
              cacheReadTokens: tokens.cache.read,
              cacheWriteTokens: tokens.cache.write,
            }
          : ZERO_USAGE
        if (!text.trim()) return undefined
        return { text, usage }
      }).pipe(Effect.catchCause((cause) => Effect.sync(() => {
        recordResearchEvent(Instance.directory, "research.llm.fallback", {
          taskID: input.taskID, stage: input.stageLabel, transport: "session", error: Cause.pretty(cause),
        })
        return undefined
      })))

    // Never infer runner termination from age. Recovery exposes unowned queued/
    // running runs as needing reconciliation, without mutating them on read.

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
      const normalized = normalizeTaskSpec(input)
      const selected = taskSessionModel(normalized) ?? (yield* Effect.promise(readSelectedSessionModel))
      const taskSpec = { ...normalized, metadata: { ...recordValue(normalized.metadata), executionIsolation: "task",
        ...(selected ? { sessionModel: selected } : {}) } }
      const sessionID = input.sessionID ?? (yield* session.create({ title: `Research: ${input.title}` })).id
      const row = yield* Effect.sync(() => Database.transaction((d) => {
        const owner = d.select().from(ResearchTaskTable).where(eq(ResearchTaskTable.session_id, sessionID)).get()
        if (owner) throw new Error("This session already belongs to a research task; create a new session for an independent task")
        return d
          .insert(ResearchTaskTable)
          .values({
            id: ResearchTaskID.ascending(),
            project_id: Instance.project.id,
            session_id: sessionID,
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
          .get()
      }, { behavior: "immediate" }))
      if (!row) throw new Error("Research task insert returned no row")
      const task = mapTask(row)
      yield* bus.publish(Event.TaskCreated, { task })
      return task
    })

    const ensureCockpitChat = Effect.fn("Research.ensureCockpitChat")(function* (taskID: ResearchTaskID) {
      const task = yield* getTask(taskID)
      if (task.cockpitChatSessionID) return { id: task.cockpitChatSessionID }
      const chat = yield* session.create({ title: `Research chat: ${task.title}`, parentID: task.sessionID })
      const row = yield* db((d) => d.update(ResearchTaskTable)
        .set({ cockpit_chat_session_id: chat.id })
        .where(and(eq(ResearchTaskTable.id, taskID), isNull(ResearchTaskTable.cockpit_chat_session_id)))
        .returning().get())
      if (row) return { id: chat.id }
      // Another client won the binding CAS. Discard our unused session.
      yield* session.remove(chat.id)
      return { id: (yield* getTask(taskID)).cockpitChatSessionID! }
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
      const managed = recordValue(existing.taskSpec.metadata)
      const nextMetadata: Record<string, unknown> = { ...taskSpecMetadata,
        executionIsolation: "task",
        ...(managed.sessionModel ? { sessionModel: managed.sessionModel } : {}),
      }
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

    const updateTaskBudget = Effect.fn("Research.updateTaskBudget")(function* (input: UpdateTaskBudgetInput) {
      const projectID = Instance.project.id
      const row = yield* db((d) =>
        d
          .update(ResearchTaskTable)
          .set({ budget: input.budget, time_updated: Date.now() })
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
      const row = yield* Effect.sync(() => Database.transaction((d) => {
        recordCompletedPhases(task, next.completedPhases)
        return d
          .update(ResearchTaskTable)
          .set({
            task_spec: nextTaskSpec,
            time_updated: Date.now(),
          })
          .where(and(eq(ResearchTaskTable.id, input.taskID), eq(ResearchTaskTable.project_id, Instance.project.id)))
          .returning()
          .get()
      }))
      if (!row) throw missing("Research task", input.taskID)
      const updated = mapTask(row)
      yield* bus.publish(Event.TaskUpdated, { task: updated })
      return updated
    })

    const updateTaskHypothesisPlan = Effect.fn("Research.updateTaskHypothesisPlan")(function* (input: {
      taskID: ResearchTaskID
      hypothesisPlan: ExperimentPlan
      abandonedHypotheses?: readonly { statement: string }[]
    }) {
      const task = yield* getTask(input.taskID)
      const metadata = recordValue(task.taskSpec.metadata)
      const nextTaskSpec = {
        ...task.taskSpec,
        metadata: {
          ...metadata,
          baselineStrategy: input.hypothesisPlan.baselineStrategy,
          searchBiases: input.hypothesisPlan.searchBiases,
          stopConditions: input.hypothesisPlan.stopConditions,
          nextExperiment: input.hypothesisPlan.nextExperiment as unknown as JsonRecord ?? null,
          ...(input.hypothesisPlan.referenceBaseline === undefined
            ? {}
            : { referenceBaseline: input.hypothesisPlan.referenceBaseline }),
          ...(input.abandonedHypotheses === undefined
            ? {}
            : { abandonedHypotheses: input.abandonedHypotheses.map((h) => ({ statement: h.statement })) }),
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
      // A candidate's hypothesis is part of its execution contract. Refreshing the
      // search plan must not delete or reinterpret that historical binding.
      const candidates = yield* listCandidates(input.taskID)
      const boundIDs = candidates.flatMap((candidate) => candidate.hypothesisID ? [candidate.hypothesisID] : [])
      const hypotheses = input.hypothesisPlan.hypotheses.filter((h) => !boundIDs.includes(h.id))
      yield* db((d) =>
        d.delete(ResearchHypothesisTable).where(and(
          eq(ResearchHypothesisTable.task_id, input.taskID),
          ...(boundIDs.length ? [notInArray(ResearchHypothesisTable.hypo_id, boundIDs)] : []),
        )).run(),
      )
      if (hypotheses.length > 0) {
        const time = nowTime()
        yield* db((d) =>
          d
            .insert(ResearchHypothesisTable)
            .values(
              hypotheses.map((h) => ({
                id: ResearchHypothesisID.ascending(),
                task_id: input.taskID,
                hypo_id: h.id,
                statement: h.statement,
                motivation: [...h.motivation],
                expected_outcome: h.expectedOutcome,
                suggested_backbones: [...h.suggestedBackbones],
                suggested_preprocessing: [...h.suggestedPreprocessing],
                priority: "medium",
                experiment_contract: h.experimentContract ?? null,
                required_mechanisms: [...(h.requiredMechanisms ?? [])],
                risk: h.risk,
                testable: h.testable,
                dataset_evidence_paths: [...h.datasetEvidencePaths],
                literature_evidence: [...h.literatureEvidence],
                applicability_assumptions: [...h.applicabilityAssumptions],
                falsification_criteria: [...h.falsificationCriteria],
                evidence_level: h.evidenceLevel,
                status: h.status ?? "pending",
                time_created: time.created,
                time_updated: time.updated,
              })),
            )
            .run(),
        )
      }
      const updated = mapTask(row)
      yield* bus.publish(Event.TaskUpdated, { task: updated })
      return updated
    })

    const createCandidate = Effect.fn("Research.createCandidate")(function* (input: CreateCandidateInput) {
      const task = yield* getTask(input.taskID)
      if (input.parentCandidateID) yield* getCandidateForTask(input.taskID, input.parentCandidateID)
      const candidateSpec = validatedCandidateSpec(task, input)
      const currentHypotheses = yield* listHypotheses(task.id)
      const hypothesisID = input.hypothesisID ?? selectHypothesisForDesign(experimentPlanFromDB(task, currentHypotheses))?.id
      const time = nowTime()
      const row = yield* db((d) =>
        d
          .insert(ResearchCandidateTable)
          .values({
            id: ResearchCandidateID.ascending(),
            task_id: input.taskID,
            parent_candidate_id: input.parentCandidateID,
            hypothesis_id: hypothesisID,
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

    const listHypotheses = Effect.fn("Research.listHypotheses")(function* (taskID: ResearchTaskID) {
      const rows = yield* db((d) =>
        d
          .select()
          .from(ResearchHypothesisTable)
          .where(eq(ResearchHypothesisTable.task_id, taskID))
          .orderBy(ResearchHypothesisTable.time_created)
          .all(),
      )
      return rows.map(mapHypothesisRow)
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
      const approvalTask = yield* getTask(existingRow.task_id)
      if (input.status === "approved" && existingRow.reason.includes("[checkpoint:intent_confirmed]")) {
        const signature = existingRow.reason.split(/\r?\n/).find((line) => line.startsWith("Intent signature: "))
        if (signature && signature !== `Intent signature: ${intentCheckpointSignature(approvalTask)}`) {
          throw new Error("This intent checkpoint is outdated. Refresh and confirm the latest research intent.")
        }
        if (existingRow.reply_message === "Superseded by updated research intent.") {
          throw new Error("This intent checkpoint is outdated. Refresh and confirm the latest research intent.")
        }
      }

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
      const allProposals = DomainRegistry.buildBaselines(task.domainID, task.taskSpec)
      // An explicitly selected reference baseline narrows the comparison controls.
      // Seeding queues candidates; nextExperiment determines what runs next.
      const referenceBaseline = recordValue(recordValue(task.taskSpec).metadata).referenceBaseline
      const referenceProposals = typeof referenceBaseline === "string"
        ? allProposals.filter((proposal) => candidateRecipeID(proposal.candidateSpec) === referenceBaseline)
        : []
      const proposals = referenceProposals.length > 0 ? referenceProposals : allProposals
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
        // A control establishes the comparison floor; it does not test the current
        // intervention hypothesis, which may require a different architecture.
        const baselineHypothesis = task.domainID === "tsf"
          ? yield* Effect.promise(() => addHypothesisToPool(task.id, {
              statement: proposal.rationale,
              experimentContract: ExperimentConstraints.parse({ mode: "baseline", requiredValues: Object.entries(proposal.candidateSpec).filter(([key]) => ["preprocessing", "embedding", "backbone", "representation", "composition", "fusion", "predictionHead", "trainingStrategy"].includes(key)).map(([path, value]) => ({ path, value })) }),
              motivation: ["Establish a reference baseline under the task evaluation protocol."],
              expectedOutcome: "Produce a reproducible metric floor for subsequent hypothesis tests.",
              suggestedBackbones: [String(recordValue(proposal.candidateSpec.backbone).type)],
              suggestedPreprocessing: [],
              risk: "The reference baseline may underfit the dataset.",
              testable: true,
              falsificationCriteria: ["Reject this control if it cannot complete the configured evaluation protocol."],
            }))
          : undefined
        const approvalStatus =
          task.mode === "autonomous" ? "auto_approved" : proposal.approvalStatus
        const candidate = yield* createCandidate({
          taskID: task.id,
          hypothesisID: baselineHypothesis?.id,
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
            .where(and(eq(ResearchRunTable.task_id, task.id), notInArray(ResearchRunTable.stage, ["profile", "ref_test", "blind_test"]), ne(ResearchRunTable.status, "invalid")))
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
      const task = yield* getTask(input.taskID)
      const signature = `Checkpoint signature: ${intentCheckpointSignature(task)}`
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
      // Rejections are decisions too. Reuse the latest decision instead of silently
      // replacing a rejection with a fresh pending approval on every resume.
      const latest = rows.filter((row) => row.reason.includes(checkpointTag) &&
        (!row.reason.includes("Checkpoint signature:") || row.reason.includes(signature)))
        .sort((a, b) => b.time_created - a.time_created)[0]
      if (latest) return mapApproval(latest)
      return yield* createApproval({
        taskID: input.taskID,
        kind: "protocol",
        reason: `${checkpointTag}\n${signature}\n${input.reason}`,
      })
    })

    const ensureIntentCheckpoint = Effect.fn("Research.ensureIntentCheckpoint")(function* (input: {
      readonly task: ResearchTask
      readonly reason: string
    }) {
      const phase = "intent_confirmed"
      const checkpointTag = `[checkpoint:${phase}]`
      const signature = `Intent signature: ${intentCheckpointSignature(input.task)}`
      supersedeIntentCheckpoints(input.task.id, signature)
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
              notInArray(ResearchRunTable.status, ["rejected", "invalid"]),
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
      if (task.domainID === "tsf" && ["baseline", "low_fidelity", "full"].includes(input.stage) && (status === "queued" || status === "running")) {
        yield* assertExecutionCheckpoint(task.id, candidate.id, input.stage)
        const spec = typeof input.resourceUsage?.seed === "number" ? candidateSpecWithSeed(candidate.candidateSpec, input.resourceUsage.seed) : candidate.candidateSpec
        const plan = DomainRegistry.createRunPlan(task.domainID, { taskSpec: task.taskSpec, candidateSpec: spec, stage: input.stage as DomainRunStage })
        yield* requireVerifiedSmoke(task, candidate, buildExecutionContract(task, candidate, plan.writes[0].content))
      }
      if (status !== "invalid" && input.stage !== "ref_test" && input.stage !== "blind_test") {
        yield* ensureRunBudget(task, status, candidate)
      }
      yield* ensureRunApprovalGates(task, candidate, input.stage)
      const time = nowTime()
      const activeCycle = yield* db((d) => d.select().from(ResearchCycleTable).where(eq(ResearchCycleTable.active_task, input.taskID)).get())
      const experienceContext = yield* Effect.promise(() => captureExperienceContext(task))
      const row = yield* db((d) =>
        d
          .insert(ResearchRunTable)
          .values({
            id: ResearchRunID.ascending(),
            task_id: input.taskID,
            candidate_id: input.candidateID,
            stage: input.stage,
            status,
            metrics: status === "invalid" ? {} : input.metrics ?? {},
            resource_usage: { ...input.resourceUsage, experienceContext, ...(activeCycle ? { cycleID: activeCycle.id } : {}) } as JsonRecord,
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
      return run
    })

    const latestExecutionBlocker = Effect.fn("Research.latestExecutionBlocker")(function* (taskID: ResearchTaskID) {
      const rows = yield* db((d) =>
        d
          .select()
          .from(ResearchArtifactTable)
          .where(
            and(
              eq(ResearchArtifactTable.task_id, taskID),
              eq(ResearchArtifactTable.kind, "execution_contract_violation_json"),
            ),
          )
          .orderBy(desc(ResearchArtifactTable.time_created))
          .limit(1)
          .all(),
      )
      if (!rows[0] || rows[0].metadata.status !== "open") return undefined
      return mapArtifact(rows[0])
    })

    const assertExecutionCheckpoint = Effect.fn("Research.assertExecutionCheckpoint")(function* (
      taskID: ResearchTaskID,
      candidateID?: ResearchCandidateID,
      stage?: string,
    ) {
      const blocker = yield* latestExecutionBlocker(taskID)
      if (!blocker) return undefined
      const approvals = yield* listApprovals({ taskID, limit: 10000 })
      const approval = approvals.find((item) => item.id === blocker.metadata.approvalID)
      if (
        approval?.status !== "approved" ||
        (candidateID && candidateID !== blocker.metadata.candidateID) ||
        (stage && stage !== "smoke")
      ) {
        throw new PipelineBlockedError({
          taskID,
          reason: "execution_contract_violation",
          blockerArtifactID: blocker.id,
          candidateID: String(blocker.metadata.candidateID),
          hypothesisID: typeof blocker.metadata.hypothesisID === "string" ? blocker.metadata.hypothesisID : undefined,
          invalidRunID: blocker.runID,
        })
      }
      return blocker
    })

    const blockExecutionContract = Effect.fn("Research.blockExecutionContract")(function* (
      task: ResearchTask,
      candidate: ResearchCandidate,
      contract: ExecutionContract,
      mismatches: ContractMismatch[],
      invalidRun?: ResearchRun,
    ) {
      const recovery = yield* ContractRecovery
      const autoRepair = recovery?.taskID === task.id && recovery.attempt < recovery.maxAttempts
      const previous = yield* db((d) =>
        d
          .select({ id: ResearchArtifactTable.id })
          .from(ResearchArtifactTable)
          .where(
            and(
              eq(ResearchArtifactTable.task_id, task.id),
              eq(ResearchArtifactTable.kind, "execution_contract_violation_json"),
            ),
          )
          .all(),
      )
      const contractDigest = digest(contract)
      const blockerID = `ecb_${invalidRun?.id ?? candidate.id}_${previous.length + 1}`
      const file = path.join(Instance.directory, ".neo-research", "execution-contracts", task.id, `${blockerID}.json`)
      const payload = {
        schema_version: "execution_contract_violation.v1",
        blocker_id: blockerID,
        type: "execution_contract_violation",
        status: "open",
        task_id: task.id,
        hypothesis_id: candidate.hypothesisID ?? null,
        candidate_id: candidate.id,
        invalid_run_id: invalidRun?.id ?? null,
        stage: invalidRun?.stage ?? "smoke",
        contract_digest: contractDigest,
        expected: contract.expected,
        actual: Object.fromEntries(mismatches.map((item) => [item.path, item.actual])),
        mismatches,
        evidence_disposition: "inconclusive",
        recommended_owner: autoRepair ? "ModelDesignerAgent" : "pipeline_maintainer",
        automatic_recovery: recovery ? { attempt: recovery.attempt, max_attempts: recovery.maxAttempts, status: autoRepair ? "pending" : "exhausted" } : null,
        runner_error: invalidRun?.error ?? null,
        resume_requirement: {
          same_hypothesis: true,
          same_candidate: true,
          required_stage: "smoke",
          required_event: "execution_contract_verified",
        },
      }
      yield* Effect.promise(async () => {
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, JSON.stringify(payload, null, 2) + "\n")
      })
      const artifact = yield* createArtifact({
        taskID: task.id,
        runID: invalidRun?.id,
        kind: "execution_contract_violation_json",
        uri: `file://${file}`,
        metadata: {
          status: "open",
          candidateID: candidate.id,
          hypothesisID: candidate.hypothesisID ?? null,
          contractDigest,
          blockerID,
          attempt: previous.length + 1,
          seed: typeof invalidRun?.resourceUsage.seed === "number" ? invalidRun.resourceUsage.seed : null,
          ...(recovery ? { autoRecoveryAttempt: recovery.attempt, autoRecoveryMaxAttempts: recovery.maxAttempts } : {}),
        },
      })
      if (!autoRepair) {
        yield* updateTaskStatus({ taskID: task.id, status: "paused" })
        const approval = yield* createApproval({
          taskID: task.id,
          candidateID: candidate.id,
          kind: "protocol",
          reason: `[checkpoint:execution_contract_violation:${contractDigest}:attempt-${previous.length + 1}]\n${recovery ? `Agent 已尝试 ${recovery.attempt} 次自动修复，仍未通过验证。` : ""}实验执行契约不一致，任务已暂停。\n${mismatches.map((item) => `${item.path}: expected=${JSON.stringify(item.expected)} actual=${JSON.stringify(item.actual)}`).join("\n")}\nCandidate: ${candidate.id}\nHypothesis: ${candidate.hypothesisID ?? "unknown"}\nBlocker artifact: ${artifact.id}\nRecommended owner: pipeline_maintainer\n实现已修复时 approve，以重新验证原 candidate；candidate 设计本身错误时 reject，以废弃该 candidate 并重新运行 ModelDesigner。`,
        })
        yield* db((d) =>
          d
            .update(ResearchArtifactTable)
            .set({ metadata: { ...artifact.metadata, approvalID: approval.id } })
            .where(eq(ResearchArtifactTable.id, artifact.id))
            .run(),
        )
      }
      yield* bus.publish(Event.ExecutionContractViolation, {
        taskID: task.id,
        agent: "ContractChecker",
        stage: invalidRun?.stage ?? "smoke",
        status: "failed",
        metadata: {
          blockerArtifactID: artifact.id,
          candidateID: candidate.id,
          automaticRecovery: autoRepair,
          recoveryAttempt: recovery?.attempt ?? null,
          runnerError: invalidRun?.error ?? null,
          mismatches: mismatches as unknown as JsonRecord["mismatches"],
        },
      })
      throw new PipelineBlockedError({
        taskID: task.id,
        reason: "execution_contract_violation",
        blockerArtifactID: artifact.id,
        candidateID: candidate.id,
        hypothesisID: candidate.hypothesisID,
        invalidRunID: invalidRun?.id,
        mismatches,
      })
    })

    const supersedeExecutionContractCheckpoint = Effect.fn("Research.supersedeExecutionContractCheckpoint")(function* (
      blocker: ResearchArtifact,
    ) {
      const task = yield* getTask(blocker.taskID)
      const candidateID = String(blocker.metadata.candidateID) as ResearchCandidateID
      const now = Date.now()
      const candidateRow = yield* db((d) =>
        d
          .update(ResearchCandidateTable)
          .set({ approval_status: "rejected", time_updated: now })
          .where(and(eq(ResearchCandidateTable.id, candidateID), eq(ResearchCandidateTable.task_id, task.id)))
          .returning()
          .get(),
      )
      if (candidateRow) yield* bus.publish(Event.CandidateUpdated, { candidate: mapCandidate(candidateRow) })

      const incidents = yield* db((d) =>
        d
          .select()
          .from(ResearchArtifactTable)
          .where(
            and(
              eq(ResearchArtifactTable.task_id, task.id),
              eq(ResearchArtifactTable.kind, "execution_contract_violation_json"),
            ),
          )
          .all(),
      )
      for (const incident of incidents.filter(
        (item) => item.metadata.candidateID === candidateID && item.metadata.status === "open",
      )) {
        if (incident.uri.startsWith("file://")) {
          yield* Effect.promise(async () => {
            try {
              const file = incident.uri.slice(7)
              const payload = JSON.parse(await readFile(file, "utf8"))
              await writeFile(
                file,
                `${JSON.stringify({
                  ...payload,
                  status: "superseded",
                  evidence_disposition: "inconclusive",
                  superseded_reason: "candidate_rejected_for_redesign",
                  superseded_timestamp: new Date(now).toISOString(),
                }, null, 2)}\n`,
                "utf8",
              )
            } catch {
              // The database remains authoritative when an old local artifact is unavailable.
            }
          })
        }
        yield* db((d) =>
          d
            .update(ResearchArtifactTable)
            .set({
              metadata: {
                ...incident.metadata,
                status: "superseded",
                supersededReason: "candidate_rejected_for_redesign",
              },
              time_updated: now,
            })
            .where(eq(ResearchArtifactTable.id, incident.id))
            .run(),
        )
      }
      yield* updateTaskStatus({ taskID: task.id, status: "searching" })
    })

    const requireVerifiedSmoke = Effect.fn("Research.requireVerifiedSmoke")(function* (
      task: ResearchTask,
      candidate: ResearchCandidate,
      contract: ExecutionContract,
    ) {
      const contractDigest = digest(contract)
      const proofs = yield* db((d) =>
        d
          .select()
          .from(ResearchArtifactTable)
          .where(
            and(
              eq(ResearchArtifactTable.task_id, task.id),
              eq(ResearchArtifactTable.kind, "execution_contract_verified_json"),
            ),
          )
          .all(),
      )
      for (const proof of proofs) {
        if (
          proof.metadata.contractDigest !== contractDigest ||
          proof.metadata.candidateID !== candidate.id ||
          !proof.run_id
        )
          continue
        const smoke = yield* getRunForTask(task.id, proof.run_id)
        if (smoke.status !== "succeeded" || smoke.stage !== "smoke" || smoke.candidateID !== candidate.id || buildModelCompilerResult({ taskID: task.id, candidateID: candidate.id, smokeRun: smoke }).status !== "passed") continue
        const payload = yield* Effect.promise(async () => {
          try {
            return JSON.parse(await readFile(proof.uri.slice(7), "utf8")) as Record<string, unknown>
          } catch {
            return undefined
          }
        })
        if (
          payload &&
          verifyExecutionRecords(contract, [payload.manifest as Record<string, unknown>, payload]).length === 0
        )
          return payload
      }
      throw new Error(`No verified smoke contract for candidate ${candidate.id} and contract digest ${contractDigest}.`)
    })

    const prepareRunInternal = Effect.fn("Research.prepareRunInternal")(function* (
      input: PrepareRunInput,
      options: { readonly enqueueRuntimeJob: boolean },
    ) {
      const task = yield* getTask(input.taskID)
      const candidate = yield* getCandidateForTask(input.taskID, input.candidateID)
      assertCandidateApproved(task.id, candidate)

      const stage = input.stage ?? "smoke"
      yield* ensureRunApprovalGates(task, candidate, stage)
      const candidateSpec = input.seed === undefined ? candidate.candidateSpec : candidateSpecWithSeed(candidate.candidateSpec, input.seed)
      let runnerRunID = input.runnerRunID
      if ((stage === "ref_test" || stage === "blind_test") && runnerRunID === undefined) {
        const prerequisiteStage = stage === "ref_test" ? "full" : "ref_test"
        const prerequisiteRuns = yield* db((d) =>
          d
            .select()
            .from(ResearchRunTable)
            .where(
              and(
                eq(ResearchRunTable.task_id, task.id),
                eq(ResearchRunTable.candidate_id, candidate.id),
                eq(ResearchRunTable.stage, prerequisiteStage),
                eq(ResearchRunTable.status, "succeeded"),
              ),
            )
            .orderBy(desc(ResearchRunTable.time_created))
            .limit(1)
            .all(),
        )
        const prerequisiteRun = prerequisiteRuns[0]
        if (prerequisiteRun !== undefined) {
          const artifacts = yield* db((d) =>
            d
              .select()
              .from(ResearchArtifactTable)
              .where(
                and(
                  eq(ResearchArtifactTable.task_id, task.id),
                  eq(ResearchArtifactTable.run_id, prerequisiteRun.id),
                  eq(ResearchArtifactTable.kind, "runner_artifact"),
                ),
              )
              .all(),
          )
          runnerRunID = artifacts.map((artifact) => neoCastRunIDFromArtifactURI(artifact.uri)).find(Boolean)
        }
        if (runnerRunID === undefined) {
          throw new Error(
            `Cannot prepare ${stage}: no Neo-Cast runner artifact was found for candidate ${candidate.id} ${prerequisiteStage} run.`,
          )
        }
      }
      const runPlan = DomainRegistry.createRunPlan(task.domainID, {
        taskSpec: task.taskSpec,
        candidateSpec,
        stage: stage as DomainRunStage,
        description: input.description,
        runnerRunID,
      })
      if (!runPlan.validation.ok) {
        throw new Error(`Research candidate failed domain validation: ${runPlan.validation.issues[0]?.message}`)
      }
      const executionRoot = taskExecutionRoot(task, Instance.directory)
      if (executionRoot !== Instance.directory) {
        validateTaskRuntimePaths(task, executionRoot)
        yield* Effect.promise(() => mkdir(executionRoot, { recursive: true }))
        runPlan.command.cwd = executionRoot
        runPlan.command.env = { ...runPlan.command.env, NEO_CAST_PROJECT_ROOT: executionRoot }
      }
      if (task.domainID === "tsf" && stage !== "ref_test" && stage !== "blind_test") {
        runPlan.command.cwd = executionRoot
        runPlan.command.env = { ...runPlan.command.env, NEO_CAST_PROJECT_ROOT: executionRoot }
        const blocker = yield* assertExecutionCheckpoint(task.id, candidate.id, stage)
        if (blocker && (candidate.hypothesisID ?? null) !== blocker.metadata.hypothesisID) throw new Error("Recovery must retain the original hypothesis identity.")
        const contract = buildExecutionContract(task, candidate, runPlan.writes[0].content)
        const hypotheses = yield* listHypotheses(task.id)
        const hypothesis = hypotheses.find((item) => item.id === candidate.hypothesisID)
        const gateA = hypothesis ? validateCandidateAgainstHypothesis(hypothesis, candidate, undefined, task.taskSpec) : [{ path: "hypothesis_id", expected: "existing structured hypothesis", actual: candidate.hypothesisID ?? null, source: "hypothesis_candidate_gate" }]
        if (gateA.length) yield* blockExecutionContract(task, candidate, contract, gateA)
        const contractDigest = digest(contract)
        const contractPath = path.join(Instance.directory, ".neo-research", "execution-contracts", task.id, `${candidate.id}-${contractDigest}.json`)
        const proofPath = `${contractPath}.verified.json`
        if (stage !== "smoke") {
          const proof = yield* requireVerifiedSmoke(task, candidate, contract)
          runPlan.writes.push({ path: proofPath, content: proof as JsonRecord })
        }
        runPlan.writes.push({ path: contractPath, content: contract as unknown as JsonRecord })
        runPlan.command.env = { ...runPlan.command.env, NEO_CAST_EXECUTION_CONTRACT: contractPath, NEO_CAST_CONTRACT_CANDIDATE: runnerPath(executionRoot, runPlan.writes[0].path), NEO_CAST_CONTRACT_VERIFICATION: proofPath }
        if (stage === "smoke") runPlan.command.args.push("--execution-contract", contractPath, "--contract-verification", proofPath)
      }
      const interrupted = (yield* listRuns(task.id)).find((run) => run.candidateID === candidate.id && run.stage === stage && run.status === "failed" && run.error?.startsWith("Research attempt interrupted"))
      const run = yield* createRun({
        taskID: task.id,
        candidateID: candidate.id,
        stage,
        status: "queued",
        resourceUsage: { ...(input.seed === undefined ? {} : { seed: input.seed }), ...(interrupted ? { retry_of: interrupted.id } : {}),
          hypothesisSnapshot: JSON.parse(JSON.stringify((yield* listHypotheses(task.id)).find((h) => h.id === candidate.hypothesisID) ?? null)),
        },
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
      if (task.domainID === "tsf" && (!((run.resourceUsage as any).executionContract?.status === "verified") || run.stage !== "full")) return
      const candidate = yield* getCandidateForTask(task.id, run.candidateID)
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

      // Preserve the evaluation decision as a run fact, independently of optional experience curation.
      const evaluated = yield* db((d) => d.update(ResearchRunTable).set({
        resource_usage: { ...run.resourceUsage, evaluationDecision: {
          primaryMetricName: metricName, primaryMetric: comparisonMetric, championUpdated,
          ...(Object.keys(seedGate).length ? { seedGate } : {}),
          ...(championStandoff ? { championStandoff } : {}),
        } } as JsonRecord,
      }).where(eq(ResearchRunTable.id, run.id)).returning().get())
      if (evaluated) yield* bus.publish(Event.RunUpdated, { run: mapRun(evaluated) })
    })

    const executePreparedRun = logPhaseMethod("executePreparedRun", Effect.fn("Research.executePreparedRun")(function* (
      prepared: PreparedRun,
      options: { readonly completeQueuedRuntimeJob?: boolean; readonly recoveredExecution?: RunnerExecution } = {},
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

      let recoveryBlocker: ResearchArtifact | undefined
      const executionTask = yield* getTask(prepared.run.taskID)
      if (executionTask.domainID === "tsf" && prepared.run.stage !== "ref_test" && prepared.run.stage !== "blind_test") {
        recoveryBlocker = yield* assertExecutionCheckpoint(executionTask.id, prepared.run.candidateID, prepared.run.stage)
        const candidate = yield* getCandidateForTask(executionTask.id, prepared.run.candidateID!)
        const spec = typeof prepared.run.resourceUsage.seed === "number" ? candidateSpecWithSeed(candidate.candidateSpec, prepared.run.resourceUsage.seed) : candidate.candidateSpec
        const currentPlan = DomainRegistry.createRunPlan(executionTask.domainID, { taskSpec: executionTask.taskSpec, candidateSpec: spec, stage: prepared.run.stage as DomainRunStage })
        const currentContract = buildExecutionContract(executionTask, candidate, currentPlan.writes[0].content)
        const contractWrite = prepared.runPlan.writes.find((write) => write.content.schema_version === "research_execution_contract.v1")
        const mismatches: ContractMismatch[] = []
        if (!prepared.runPlan.command.env?.NEO_CAST_EXECUTION_CONTRACT || !contractWrite || digest(contractWrite.content) !== digest(currentContract)) mismatches.push({ path: "prepared_contract", expected: digest(currentContract), actual: contractWrite ? digest(contractWrite.content) : null })
        const hypotheses = yield* listHypotheses(executionTask.id)
        const hypothesis = hypotheses.find((item) => item.id === candidate.hypothesisID)
        mismatches.push(...(hypothesis ? validateCandidateAgainstHypothesis(hypothesis, candidate) : [{ path: "hypothesis_id", expected: "existing structured hypothesis", actual: candidate.hypothesisID ?? null }]))
        if (prepared.run.stage !== "smoke") {
          const proofError = yield* requireVerifiedSmoke(executionTask, candidate, currentContract).pipe(Effect.map(() => undefined), Effect.catchCause((cause) => Effect.succeed(String(Cause.squash(cause)))))
          if (proofError) mismatches.push({ path: "smoke_verification", expected: digest(currentContract), actual: proofError })
        }
        if (mismatches.length) {
          const invalidRun = yield* updateRunStatus({ runID: prepared.run.id, status: "invalid", metrics: {} })
          yield* blockExecutionContract(executionTask, candidate, currentContract, mismatches, invalidRun)
        }
      }
      const running = yield* updateRunStatus({ runID: prepared.run.id, status: "running" })
      const liveProgressPath = path.join(Instance.directory, ".neo-research", "runner-progress", running.taskID, `${running.id}.jsonl`)
      appendLog(liveProgressPath, { event: "runner_started", runID: running.id, taskID: running.taskID, stage: running.stage })
      const liveProgressArtifact = yield* createArtifact({ taskID: running.taskID, runID: running.id,
        kind: "runner_progress_jsonl", uri: `file://${liveProgressPath}`, metadata: { stage: running.stage, live: true } })
      let progressPublishQueue = Promise.resolve()
      const persistedProgressLines: JsonRecord[] = []
      const displayProgressLines: JsonRecord[] = []
      const publishProgressLine = Instance.bind((line: string) => {
        const parsed = parseProgressLine(line)
        appendLog(liveProgressPath, { stream: "stdout", line, ...parsed })
        const progressRecord = {
          time: new Date().toISOString(),
          line,
          ...parsed,
        } as JsonRecord
        persistedProgressLines.push(progressRecord)
        if (parsed.event !== "batch_progress") {
          displayProgressLines.push(progressRecord)
          if (displayProgressLines.length > 500) displayProgressLines.splice(0, displayProgressLines.length - 500)
          Database.use((d) => d.update(ResearchArtifactTable).set({
            metadata: {
              runnerID: prepared.runPlan.runnerID,
              runnerKind: prepared.runPlan.runnerKind,
              stage: prepared.runPlan.stage,
              live: true,
              lineCount: persistedProgressLines.length,
              previewLines: [...displayProgressLines],
            },
            time_updated: Date.now(),
          }).where(eq(ResearchArtifactTable.id, liveProgressArtifact.id)).run())
        }
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
      const execution = options.recoveredExecution ?? (yield* abortable(async (signal) => {
        const cwd = prepared.runPlan.command.cwd ?? Instance.directory
        const workspace = existsSync(cwd) ? realpathSync(cwd) : path.resolve(cwd)
        const acquired = Database.use((db) => db.insert(ResearchRunnerLockTable).values({ workspace, run_id: running.id }).onConflictDoNothing().returning().get())
        if (!acquired) throw new Error(`Runner workspace is still owned by another attempt: ${workspace}`)
        const result = await executeRunnerPlan(prepared.runPlan, publishProgressLine, signal, (pid) => {
          Database.use((db) => db.update(ResearchRunTable).set({ resource_usage: {
            ...running.resourceUsage,
            execution: { worker: executionOwner(running.id, pid), attemptID: running.id, planDigest: digest(prepared.runPlan), workspace: prepared.runPlan.command.cwd ?? Instance.directory },
          } }).where(eq(ResearchRunTable.id, running.id)).run())
        }, (line) => appendLog(liveProgressPath, { stream: "stderr", line })).catch((error) => {
          appendLog(liveProgressPath, { event: signal.aborted ? "runner_canceled" : "runner_failed", error: String(error), runID: running.id })
          throw error
        }).finally(() => Database.use((db) => db.delete(ResearchRunnerLockTable).where(eq(ResearchRunnerLockTable.run_id, running.id)).run()))
        appendLog(liveProgressPath, { event: signal.aborted ? "runner_canceled" : "runner_exited", exitCode: result.exitCode, runID: running.id })
        await progressPublishQueue
        return result
      }))
      appendLog(liveProgressPath, { event: "runner_finished", exitCode: execution.exitCode, runID: running.id })
      const metrics = metricsFromRecords(execution.records, prepared.runPlan.stage)
      const artifactRefs: ResearchArtifactID[] = [...running.artifactRefs, liveProgressArtifact.id]

      const executionLogRoot = runnerPath(Instance.directory, ".neo-research/runner-executions")
      const executionLogDirectory = path.join(executionLogRoot, running.taskID)
      const executionLogPath = path.join(executionLogDirectory, `${running.id}.json`)
      yield* Effect.promise(async () => {
        await mkdir(executionLogDirectory, { recursive: true })
        await writeFile(
          `${executionLogPath}.tmp`,
          `${JSON.stringify(
            {
              planDigest: digest(prepared.runPlan),
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
      yield* Effect.promise(() => rename(`${executionLogPath}.tmp`, executionLogPath))
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

      yield* db((d) => d.update(ResearchArtifactTable).set({
        metadata: {
          runnerID: prepared.runPlan.runnerID,
          runnerKind: prepared.runPlan.runnerKind,
          stage: prepared.runPlan.stage,
          live: false,
          lineCount: persistedProgressLines.length,
          previewLines: displayProgressLines.slice(-500),
        },
        time_updated: Date.now(),
      }).where(eq(ResearchArtifactTable.id, liveProgressArtifact.id)).run())

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

      const runnerDone = execution.records.findLast((r) => r["event"] === "done")
      const reused = runnerDone?.reused === true
      const duplicateRunning = runnerDone?.status === "duplicate_running"
      const runnerTrainingSucceeded = runnerDone?.["status"] === "success"
      const contractWrite = prepared.runPlan.writes.find((write) => write.content.schema_version === "research_execution_contract.v1")
      const contract = contractWrite?.content as unknown as ExecutionContract | undefined
      const contractMismatches = contract && !duplicateRunning ? verifyExecutionRecords(contract, execution.records) : []
      const contractInvalid = contractMismatches.length > 0
      const task = yield* getTask(running.taskID)
      const missingPrimaryMetric = running.stage === "full" && !reused && !duplicateRunning &&
        metricValue(metrics as ResearchRun["metrics"], objectiveMetricName(task.objective)) === undefined
      const succeeded = !contractInvalid && !missingPrimaryMetric && (execution.exitCode === 0 || runnerTrainingSucceeded)
      const reproducibility = succeeded
        ? yield* Effect.promise(() => buildReproducibilitySeal(task, prepared.runPlan, Instance.directory))
        : undefined
      const cvEvidence = yield* Effect.promise(async () => {
        for (const directory of artifactDirsFromRecords(execution.records)) {
          try {
            const value = JSON.parse(await readFile(path.join(directory, "cv_metrics.json"), "utf8"))
            if (value?.schema_version === "cv_metrics.v1") return value as JsonRecord
          } catch { /* Absent for fixed-split evaluation; never invent fold evidence. */ }
        }
        return null
      })
      const run = yield* updateRunStatus({
        runID: running.id,
        status: contractInvalid ? "invalid" : duplicateRunning ? "rejected" : succeeded ? "succeeded" : "failed",
        metrics: (contractInvalid || reused || duplicateRunning ? {} : metrics) as ResearchRun["metrics"],
        resourceUsage: {
          ...running.resourceUsage,
          independentEvidence: !reused && !duplicateRunning,
          duplicateExperiment: reused || duplicateRunning,
          reusedExperiment: execution.records.findLast((record) => record.event === "experiment_reused"),
          exitCode: execution.exitCode,
          executionContract: contract ? { status: duplicateRunning ? "not_executed" : contractInvalid ? "invalid" : "verified", contractDigest: digest(contract), candidateID: contract.candidate_id, manifest: execution.records.findLast((record) => record.event === "executed_model_manifest"), verified: execution.records.findLast((record) => record.event === "execution_contract_verified") } : undefined,
          runnerID: prepared.runPlan.runnerID,
          modelResources: execution.records.findLast((record) => record.event === "resource_summary"),
          evaluationEvidence: { finalEvents: finalEvaluationRecords(execution.records), protocol: task.taskSpec.evaluation ?? null, cv: cvEvidence },
          ...(reproducibility === undefined ? {} : { reproducibility }),
        } as ResearchRun["resourceUsage"],
        artifactRefs,
        error: succeeded ? undefined : missingPrimaryMetric
          ? `Incomplete full evaluation: missing finite ${objectiveMetricName(task.objective)}; hypothesis outcome is inconclusive.\n${runnerFailureEvidence(execution)}`
          : runnerFailureEvidence(execution),
      })

      if (contractInvalid && contract && running.candidateID) {
        const candidate = yield* getCandidateForTask(task.id, running.candidateID)
        yield* blockExecutionContract(task, candidate, contract, contractMismatches, run)
      }
      if (succeeded && contract) {
        const latestBlocker = yield* latestExecutionBlocker(task.id)
        const blocker = recoveryBlocker && latestBlocker?.id === recoveryBlocker.id ? latestBlocker : undefined
        const verification = execution.records.findLast((record) => record.event === "execution_contract_verified")!
        const file = path.join(executionLogDirectory, `${run.id}.contract-verified.json`)
        const payload = { ...verification, blocker_id: blocker?.metadata.blockerID ?? null, verification_smoke_run_id: run.stage === "smoke" ? run.id : null, smoke_metric: run.stage === "smoke" ? run.metrics.val_avg_mse : null, expected: contract.expected, verified_timestamp: new Date().toISOString() }
        yield* Effect.promise(() => writeFile(file, JSON.stringify(payload, null, 2) + "\n"))
        const proof = yield* createArtifact({ taskID: task.id, runID: run.id, kind: "execution_contract_verified_json", uri: `file://${file}`, metadata: { candidateID: contract.candidate_id, contractDigest: digest(contract), blockerID: blocker?.id ?? null } })
        if (blocker && run.stage === "smoke" && buildModelCompilerResult({ taskID: task.id, candidateID: run.candidateID!, smokeRun: run }).status === "passed") {
          const incidents = yield* db((d) => d.select().from(ResearchArtifactTable).where(and(eq(ResearchArtifactTable.task_id, task.id), eq(ResearchArtifactTable.kind, "execution_contract_violation_json"))).all())
          for (const incident of incidents.filter((item) => item.metadata.candidateID === run.candidateID && item.metadata.status === "open")) {
            const payload = yield* Effect.promise(async () => JSON.parse(await readFile(incident.uri.slice(7), "utf8")))
            yield* Effect.promise(() => writeFile(incident.uri.slice(7), JSON.stringify({ ...payload, status: "resolved", verification_smoke_run_id: run.id, resolved_timestamp: new Date().toISOString() }, null, 2) + "\n"))
            yield* db((d) => d.update(ResearchArtifactTable).set({ metadata: { ...incident.metadata, status: "resolved", verificationRunID: run.id }, time_updated: Date.now() }).where(eq(ResearchArtifactTable.id, incident.id)).run())
          }
          yield* updateTaskStatus({ taskID: task.id, status: "searching" })
        }
        yield* bus.publish(Event.ExecutionContractVerified, { taskID: task.id, agent: "ContractChecker", stage: run.stage, status: "completed", metadata: { candidateID: contract.candidate_id, contractDigest: digest(contract), artifactID: proof.id } })
        return { run: yield* attachArtifactRefToRun(run, proof.id), runPlan: prepared.runPlan }
      }
      return { run, runPlan: prepared.runPlan }
    }))

    const reconcileInterruptedRuns = Effect.fn("Research.reconcileInterruptedRuns")(function* (taskID: ResearchTaskID) {
      yield* getTask(taskID)
      const runs = yield* listRuns(taskID)
      for (const run of runs.filter((run) => run.status === "running" || run.status === "queued")) {
        const recovered = yield* Effect.promise(async () => {
          try {
            const plan = JSON.parse(await readFile(path.join(Instance.directory, ".neo-research/run-plans", taskID, `${run.id}.json`), "utf8"))
            const result = JSON.parse(await readFile(path.join(Instance.directory, ".neo-research/runner-executions", taskID, `${run.id}.json`), "utf8"))
            if (plan.taskID !== taskID || plan.runID !== run.id || result.taskID !== taskID || result.runID !== run.id || result.candidateID !== run.candidateID || result.planDigest !== digest(plan.runPlan) || !Array.isArray(result.records) || typeof result.exitCode !== "number") return undefined
            return { runPlan: plan.runPlan as DomainRunPlan, execution: result as RunnerExecution }
          } catch { return undefined }
        })
        if (!recovered) {
          const execution = recordValue(run.resourceUsage.execution)
          if (run.stage !== "ref_test" && run.stage !== "blind_test" && execution.attemptID === run.id && typeof execution.worker === "string" && runnerGroupExited(execution.worker)) {
            yield* updateRunStatus({ runID: run.id, status: "failed", error: "Research attempt interrupted; original runner process group confirmed exited" })
            yield* db((d) => d.delete(ResearchRunnerLockTable).where(eq(ResearchRunnerLockTable.run_id, run.id)).run())
          }
          continue
        }
        yield* executePreparedRun({ run, runPlan: recovered.runPlan }, { recoveredExecution: recovered.execution })
        yield* db((d) => d.delete(ResearchRunnerLockTable).where(eq(ResearchRunnerLockTable.run_id, run.id)).run())
      }
    })

    const executeRun = logPhaseMethod("executeRun", Effect.fn("Research.executeRun")(function* (input: PrepareRunInput) {
      const queued = yield* loadQueuedPreparedRun(input)
      if (queued !== undefined) return yield* executePreparedRun(queued, { completeQueuedRuntimeJob: true })

      const prepared = yield* prepareRunInternal(input, { enqueueRuntimeJob: false })
      return yield* executePreparedRun(prepared)
    }))

    const resumeExecutionContractCheckpoint = Effect.fn("Research.resumeExecutionContractCheckpoint")(function* (taskID: ResearchTaskID) {
      const current = yield* latestExecutionBlocker(taskID)
      if (!current) return undefined
      const approvals = yield* listApprovals({ taskID, limit: 10000 })
      const approval = approvals.find((item) => item.id === current.metadata.approvalID)
      if (approval?.status === "rejected") {
        yield* supersedeExecutionContractCheckpoint(current)
        return undefined
      }
      const blocker = yield* assertExecutionCheckpoint(taskID)
      if (!blocker) return undefined
      const candidateID = String(blocker.metadata.candidateID) as ResearchCandidateID
      const seed = typeof blocker.metadata.seed === "number" ? blocker.metadata.seed : undefined
      const smoke = yield* executeRun({ taskID, candidateID, stage: "smoke", seed })
      if (smoke.run.status !== "succeeded") throw new Error("Original candidate smoke verification failed; task remains paused.")
      const full = yield* executeRun({ taskID, candidateID, stage: "full", seed })
      yield* updateTaskStatus({ taskID, status: "searching" })
      return full
    })

    const executeSeedSweep = Effect.fn("Research.executeSeedSweep")(function* (input: ExecuteSeedSweepInput) {
      const task = yield* getTask(input.taskID)
      const seeds = taskEvaluationSeeds(task, input.seeds)
      const runs: PreparedRun[] = []
      for (const seed of seeds) {
        const description =
          input.description === undefined ? undefined : `${input.description} (seed ${seed})`
        if (task.domainID === "tsf" && input.stage !== "smoke" && input.stage !== "ref_test" && input.stage !== "blind_test") {
          const smoke = yield* executeRun({ taskID: task.id, candidateID: input.candidateID, stage: "smoke", description, seed })
          if (buildModelCompilerResult({ taskID: task.id, candidateID: input.candidateID, smokeRun: smoke.run }).status !== "passed") throw new Error(`Seed ${seed} has no successful smoke contract verification.`)
        }
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
      /** Set only when this iteration actually invoked ModelDesignerAgent (vs. reusing an existing candidate). */
      readonly designerLLM?: {
        readonly callPath?: "session" | "direct"
        readonly text?: string
        readonly metadata: JsonRecord
      }
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
        // Full design structure (architecture/recipe + training config) and rationale for the
        // candidate this run actually executed.
        candidateSpec: input.candidate.candidateSpec,
        rationale: input.candidate.rationale,
        riskLevel: input.candidate.riskLevel,
        approvalStatus: input.candidate.approvalStatus,
        generatedBy: input.candidate.generatedBy,
        ...(input.designerLLM
          ? {
              designerLLM: {
                callPath: input.designerLLM.callPath ?? null,
                text: input.designerLLM.text ?? null,
                ...input.designerLLM.metadata,
              },
            }
          : {}),
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
      readonly maxIterations: number
    }) {
      const artifact = yield* writeAutonomousLoopArtifact(input)

      // Run ReflectionAgent exactly once per loop completion — it persists its result (artifacts +
      // reflection_result.json, including the LLM output) to disk. The outer pipeline re-reads that
      // persisted result instead of calling ReflectionAgent again or threading it through memory.
      if (input.iterations.length > 0) {
        yield* runReflectionAgent({
          taskID: input.task.id,
          stoppedReason: input.stoppedReason,
          maxIterations: input.maxIterations,
        }).pipe(Effect.catchCause(() => Effect.void))
      }

      return {
        iterations: input.iterations,
        stoppedReason: input.stoppedReason,
        artifact,
      }
    })

    const runAutonomousIterationAttempt = Effect.fn("Research.runAutonomousIterationAttempt")(function* (
      input: AutonomousIterationInput,
    ) {
      const task = yield* getTask(input.taskID)
      const recovery = yield* ContractRecovery
      if (task.mode !== "autonomous") throw new Error(`Research task is not autonomous: ${task.id}`)
      const resumeBlocker = yield* assertExecutionCheckpoint(task.id)
      const resumeCandidate = resumeBlocker ? yield* getCandidateForTask(task.id, String(resumeBlocker.metadata.candidateID) as ResearchCandidateID) : undefined
      const resumeSeed = typeof resumeBlocker?.metadata.seed === "number" ? resumeBlocker.metadata.seed : undefined
      yield* ensureRunBudget(task, "queued")
      const plannerDecision = parseNextExperiment(recordValue(task.taskSpec.metadata).nextExperiment)
      if (plannerDecision?.action === "stop" && !resumeCandidate && !recovery?.feedback && !recovery?.hypothesisID) throw new Error(`HypoPlanner stopped search: ${plannerDecision.rationale}`)
      const forceExplore = input.forceExplore === true && !plannerDecision
      const baseFingerprint = DomainRegistry.summarizeTask(task.domainID, task.taskSpec, { taskID: task.id, projectRoot: Instance.directory, workspaceRoot: taskExecutionRoot(task, Instance.directory) })

      const latestReflection = yield* Effect.promise(async () => {
        try {
          const sessionsDir = path.join(Instance.directory, ".neo-research", "sessions", input.taskID)
          const entries = await readdir(sessionsDir, { withFileTypes: true })
          const reflectDirs = entries
            .filter((e) => e.isDirectory() && e.name.startsWith("reflect_"))
            .map((e) => e.name)
            .sort()
            .reverse()
          for (const dirName of reflectDirs) {
            const jsonPath = path.join(sessionsDir, dirName, "reflection_result.json")
            try {
              const raw = await readFile(jsonPath, "utf8")
              return JSON.parse(raw) as Pick<ReflectionAgentResult, "reflectionNotesMarkdown" | "llm">
            } catch {
              continue
            }
          }
        } catch {
          // sessions dir doesn't exist yet — first iteration
        }
        return null
      })
      const previousReflectionNotesMarkdown = latestReflection ? buildReflectionPlanningMarkdown(latestReflection) : undefined
      const hypotheses = yield* listHypotheses(input.taskID)
      const hypothesisPlan = experimentPlanFromDB(task, hypotheses)
      const selectedHypothesis = recovery?.hypothesisID
        ? hypotheses.find((item) => item.id === recovery.hypothesisID)
        : resumeCandidate ? hypotheses.find((item) => item.id === resumeCandidate.hypothesisID) : selectHypothesisForDesign(hypothesisPlan)

      if (!plannerDecision && hypotheses.length > 0 && !resumeCandidate && !recovery?.hypothesisID)
        throw new Error("HypoPlanner must explicitly select the next experiment; no order-based fallback is permitted")
      if (plannerDecision?.action === "experiment" && !selectedHypothesis) throw new Error(`HypoPlanner selected an unavailable hypothesis: ${plannerDecision.hypothesisID}`)
      const designTaskEvidence = selectedHypothesis?.literatureEvidence?.length
        ? yield* loadTaskEvidenceBundle(input.taskID)
        : undefined
      const taskFingerprint = buildModelDesignerTaskFingerprint({
        taskEvidence: designTaskEvidence,
        baseFingerprint,
        hypothesisPlan,
        selectedHypothesis,
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
        candidates: plannerDecision?.action === "experiment" && !resumeCandidate
          ? candidates.filter((item) => item.hypothesisID === selectedHypothesis?.id)
          : candidates,
        runs,
        primaryMetricName,
        maxFailedRetries: maxFailedCandidateRetries(task),
      })
      if (!plannerDecision && !resumeCandidate && !recovery?.hypothesisID && designerSelection.readyCandidateIDs.length > 1)
        throw new Error("HypoPlanner must explicitly select among the queued experiments; no baseline order is permitted")
      const readyCandidateIDs = [...designerSelection.readyCandidateIDs]
      const attemptState = {
        attemptedCandidateIDs: new Set(designerSelection.attemptedCandidateIDs),
        inconclusiveCandidateIDs: new Set(designerSelection.inconclusiveCandidateIDs),
      }
      let candidate = recovery?.feedback ? undefined : resumeCandidate ?? (forceExplore ? undefined : designerSelection.candidate)

      const proposalApprovals: ResearchApproval[] = []
      let proposalCreated = false
      let explorationFallback = false
      let selectionSource: "existing_frontier" | "domain_proposal" = "existing_frontier"
      let rankings: DomainCandidateRanking[] = [...designerSelection.rankings]
      let llmMetadata: JsonRecord = {}
      let modelDesignerRawText: string | undefined
      let modelDesignerCallPath: "session" | "direct" | undefined
      if (!candidate) {
        if (selectedHypothesis?.experimentContract && task.domainID === "tsf") {
          const conflict = mechanismRequirementsUnavailable({
            hypothesisID: selectedHypothesis.id,
            requiredMechanisms: selectedHypothesis.requiredMechanisms,
            experimentContract: selectedHypothesis.experimentContract,
          })
          if (conflict) throw new DesignUnavailableError({ report: conflict })
          const comparison = comparisonRecipe(task.id, selectedHypothesis.experimentContract.comparisonRunID)
          const frequencyConflict = frequencyModeUnavailable({
            hypothesisID: selectedHypothesis.id,
            contract: selectedHypothesis.experimentContract,
            comparison,
          })
          if (frequencyConflict) throw new DesignUnavailableError({ report: frequencyConflict })
          const unavailable = schemaRemovalUnavailable({
            hypothesisID: selectedHypothesis.id,
            contract: selectedHypothesis.experimentContract,
            comparison,
            validate: (candidateSpec) => DomainRegistry.validateCandidate(task.domainID, { taskSpec: task.taskSpec, candidateSpec }),
          })
          if (unavailable) throw new DesignUnavailableError({ report: unavailable })
        }
        const memory: ResearchMemory[] = []
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
            id: item.id,
            taskID: item.taskID,
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
        const authJsonKey = yield* Effect.promise(() => resolveApiKeyFromAuthJson())
        const modelDesignerRuntime = recordValue(recordValue(task.taskSpec).runtime)
        const modelDesignerNeoCastRoot =
          typeof modelDesignerRuntime.neoCastProjectRoot === "string" ? modelDesignerRuntime.neoCastProjectRoot : undefined
        const modelDesignerLLMContext = yield* Effect.promise(() =>
          resolveEffectiveLLMConfig({ workspaceRoot: Instance.directory, neoCastProjectRoot: modelDesignerNeoCastRoot }),
        )
        const modelDesignerConfig = modelDesignerLLMContext?.config ?? (yield* Effect.promise(() =>
          resolveNeoCastLLMConfig({ workspaceRoot: Instance.directory, neoCastProjectRoot: modelDesignerNeoCastRoot }),
        ))
        let proposal: DomainCandidateProposal | undefined
        let validationFeedback = recovery?.feedback
        const requestedHistory: unknown[] = []
        let historyRequests = 0
        const maxModelDesignerAttempts = 3
        for (let attempt = 1; attempt <= maxModelDesignerAttempts; attempt++) {
          const promptInput = {
            task,
            proposalContext,
            requestedHistory,
            ...(validationFeedback ? { validationFeedback } : {}),
          }
          const modelDesignerSessionAttempt = yield* requestViaSession({
            rootSessionID: task.sessionID,
            agent: "research-model-designer",
            stageLabel: attempt === 1 ? "ModelDesigner" : `ModelDesigner retry ${attempt}`,
            taskID: task.id,
            user: buildUserPrompt(promptInput),
            modelRef: mapToModelRef(modelDesignerConfig),
          })
          modelDesignerCallPath = modelDesignerSessionAttempt ? "session" : "direct"
          logLLMCallPath("ModelDesigner", task.id, modelDesignerCallPath)
          yield* bus.publish(Event.LLMCallPath, { taskID: task.id, agent: "ModelDesigner", path: modelDesignerCallPath })

          // Raw LLM text is only available via the session path — direct transport
          // returns a parsed candidate plus metadata.
          if (modelDesignerSessionAttempt) modelDesignerRawText = modelDesignerSessionAttempt.text
          const modelDesignerSessionResult = modelDesignerSessionAttempt
            ? buildLLMProposalFromText(modelDesignerSessionAttempt.text, modelDesignerSessionAttempt.usage, modelDesignerConfig)
            : undefined
          const llmResult = modelDesignerSessionAttempt
            ? modelDesignerSessionResult ?? {
                proposal: undefined,
                metadata: buildLLMMetadata(modelDesignerConfig, "invalid", {
                  llmError: "ModelDesigner response did not contain a valid candidate JSON object",
                }),
              }
            : yield* Effect.promise(() =>
                proposeLLMCandidate({
                  ...promptInput,
                  workspaceRoot: Instance.directory,
                  ...(authJsonKey ? { authJsonKey } : {}),
                }),
              )
          llmMetadata = { ...llmResult.metadata, llmAttempt: attempt }
          if (llmResult.historyRequest) {
            if (++historyRequests > 5) throw new DesignPlanningStopped({ reason: "ModelDesigner exceeded the bounded history-request budget without proposing an experiment." })
            const result = yield* Effect.promise(() => readDesignHistory(task.id, llmResult.historyRequest!))
            requestedHistory.push({ request: llmResult.historyRequest, result })
            attempt -= 1
            continue
          }
          if (llmResult.unavailable) {
            if (!selectedHypothesis || llmResult.unavailable.hypothesisID !== selectedHypothesis.id) {
              validationFeedback = { attempt, issues: [{ path: "hypothesisID", message: "Unavailable report must name the selected hypothesis ID." }] }
              continue
            }
            throw new DesignUnavailableError({ report: llmResult.unavailable })
          }

          if (!llmResult.proposal) {
            validationFeedback = {
              attempt,
              issues: llmProposalValidationIssues(llmResult.metadata),
            }
            if (modelDesignerSessionAttempt && attempt < maxModelDesignerAttempts) {
              continue
            }
            break
          }

          const validation = DomainRegistry.validateCandidate(task.domainID, {
            taskSpec: task.taskSpec,
            candidateSpec: llmResult.proposal.candidateSpec,
          })
          const hypothesisMismatches = selectedHypothesis && task.domainID === "tsf"
            ? validateCandidateAgainstHypothesis(
                selectedHypothesis,
                {
                  taskID: task.id,
                  hypothesisID: selectedHypothesis.id,
                  candidateSpec: llmResult.proposal.candidateSpec,
                } as ResearchCandidate,
                undefined,
                task.taskSpec,
              )
            : []
          if (validation.ok && hypothesisMismatches.length === 0) {
            proposal = llmResult.proposal
            break
          }

          const issues = [
            ...validation.issues.map((item) => ({ path: item.path, message: item.message })),
            ...hypothesisMismatches.map((item) => ({
              path: item.path,
              message: "Candidate does not satisfy the selected hypothesis",
              expected: item.expected,
              actual: item.actual,
            })),
          ]
          validationFeedback = {
            attempt,
            issues,
            rejectedCandidate: llmResult.proposal.candidateSpec,
          }
          llmMetadata = {
            ...llmMetadata,
            llmStatus: "invalid",
            llmError: issues.map(formatDesignValidationIssue).join("; ").slice(0, 1000),
            llmValidationIssues: issues,
          }
        }
        rankings = DomainRegistry.rankCandidateProposals(task.domainID, proposalContext)
        if (!proposal) {
          // Heuristic proposals may be used only when they satisfy the selected
          // hypothesis. Never attach a generic fallback to an incompatible plan.
          proposal = selectedHypothesis && task.domainID === "tsf"
            ? rankings.find((ranking) => DomainRegistry.validateCandidate(task.domainID, { taskSpec: task.taskSpec, candidateSpec: ranking.candidateSpec }).ok && validateCandidateAgainstHypothesis(
                selectedHypothesis,
                { taskID: task.id, hypothesisID: selectedHypothesis.id, candidateSpec: ranking.candidateSpec } as ResearchCandidate,
                ranking.candidateSpec,
                task.taskSpec,
              ).length === 0)
            : undefined
          if (!proposal) {
            const fallback = DomainRegistry.proposeCandidate(task.domainID, proposalContext)
            const fallbackMismatches = fallback && selectedHypothesis && task.domainID === "tsf"
              ? validateCandidateAgainstHypothesis(
                  selectedHypothesis,
                  { taskID: task.id, hypothesisID: selectedHypothesis.id, candidateSpec: fallback.candidateSpec } as ResearchCandidate,
                  undefined,
                  task.taskSpec,
                )
              : []
            if (fallback && fallbackMismatches.length === 0 && DomainRegistry.validateCandidate(task.domainID, { taskSpec: task.taskSpec, candidateSpec: fallback.candidateSpec }).ok) proposal = fallback
          }
        }
        if (!proposal) {
          const issueText = validationFeedback?.issues.length
            ? validationFeedback.issues
                .map(formatDesignValidationIssue)
                .join("\n")
            : "No candidate compatible with the selected hypothesis was available."
          yield* ensurePendingApproval({
            taskID: task.id,
            kind: "protocol",
            reason: `[checkpoint:model_design_validation]\nModelDesigner could not produce a valid candidate after ${maxModelDesignerAttempts} attempts.\n${issueText}\n修正模型设计或配置后 approve 以重新运行 ModelDesigner。`,
          })
          yield* updateTaskStatus({ taskID: task.id, status: "paused" })
          throw new PipelineBlockedError({
            taskID: task.id,
            reason: "human_checkpoint_required",
            checkpointPhase: "model_design_validation",
          })
        }

        if (proposal) {
          proposalCreated = true
          selectionSource = "domain_proposal"
          const approvalStatus =
            task.mode === "autonomous" ? "auto_approved" : proposal.approvalStatus
          const proposalHypothesis = selectedHypothesis ?? (task.domainID === "tsf"
            ? yield* Effect.promise(() => addHypothesisToPool(task.id, {
                statement: proposal!.rationale,
                motivation: ["Domain proposal generated before an experiment plan was available."],
                expectedOutcome: "Evaluate the proposed architecture under the task protocol.",
                suggestedBackbones: [String(recordValue(proposal!.candidateSpec.backbone).type)],
                suggestedPreprocessing: [],
                risk: "Heuristic proposal requires empirical verification.",
                testable: true,
              }))
            : undefined)
          candidate = yield* createCandidate({
            hypothesisID: proposalHypothesis?.id,
            taskID: task.id,
            domainID: task.domainID,
            candidateSpec: proposal.candidateSpec,
            rationale: proposal.rationale,
            riskLevel: proposal.riskLevel,
            approvalStatus,
            generatedBy: proposal.generatedBy,
          })
          if (selectedHypothesis && task.domainID === "tsf") {
            const mismatches = validateCandidateAgainstHypothesis(selectedHypothesis, candidate, proposal.candidateSpec, task.taskSpec)
            if (mismatches.length) {
              const plan = DomainRegistry.createRunPlan(task.domainID, { taskSpec: task.taskSpec, candidateSpec: candidate.candidateSpec, stage: "smoke" })
              yield* blockExecutionContract(task, candidate, buildExecutionContract(task, candidate, plan.writes[0].content), mismatches)
            }
          }
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
      if (!candidate && forceExplore && !recovery?.feedback && designerSelection.candidate) {
        candidate = designerSelection.candidate
        selectionSource = "existing_frontier"
        explorationFallback = true
        rankings = [...designerSelection.rankings]
      }
      if (!candidate) throw new Error(`No approved autonomous candidate is ready for task: ${task.id}`)

      const validation = DomainRegistry.validateCandidate(task.domainID, { taskSpec: task.taskSpec, candidateSpec: candidate.candidateSpec })
      if (!validation.ok && task.domainID === "tsf") {
        const plan = DomainRegistry.createRunPlan(task.domainID, { taskSpec: task.taskSpec, candidateSpec: candidate.candidateSpec, stage: "smoke" })
        yield* blockExecutionContract(task, candidate, buildExecutionContract(task, candidate, plan.writes[0].content),
          validation.issues.map((item) => ({ path: item.path, expected: "valid candidate configuration", actual: item.message })))
      }

      const candidateHypothesis = (yield* listHypotheses(task.id)).find((item) => item.id === candidate.hypothesisID)
      if (candidateHypothesis && !resumeCandidate) {
        const contract = buildExecutionContract(task, candidate, DomainRegistry.createRunPlan(task.domainID, { taskSpec: task.taskSpec, candidateSpec: candidate.candidateSpec, stage: "smoke" }).writes[0].content)
        const mismatches = validateCandidateAgainstHypothesis(candidateHypothesis, candidate)
        if (mismatches.length) yield* blockExecutionContract(task, candidate, contract, mismatches)
      }
      const rankPredictor = rankPredictorArtifactRecord(rankings)
      const topRanking = rankings[0]
      const topRankedRecipeID = topRanking === undefined ? undefined : rankingRecipeID(topRanking)
      const selectedRecipeID = candidateRecipeID(candidate.candidateSpec)
      const designSummary = proposalCreated
        ? "Designed a new candidate from the selected hypothesis, task evidence, capabilities, and requested history."
        : "Selected an approved candidate already queued in the frontier."
      if (recordValue(task.taskSpec.metadata).designFeedback) {
        const current = yield* getTask(task.id)
        yield* db((d) => d.update(ResearchTaskTable).set({
          task_spec: { ...current.taskSpec, metadata: { ...recordValue(current.taskSpec.metadata), designFeedback: null } },
          time_updated: Date.now(),
        }).where(eq(ResearchTaskTable.id, task.id)).run())
      }
      const modelDesignerResult = buildModelDesignerResult({
        taskID: task.id,
        candidate,
        selectedHypothesis: candidateHypothesis,
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

      const requestedStage = input.stage ?? "full"
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
        seed: resumeSeed,
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
          seed: resumeSeed,
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
        yield* db((d) => d.update(ResearchRunTable).set({ resource_usage: { ...executed.run.resourceUsage, verification: { status: verReport.status, checks: JSON.parse(JSON.stringify(verReport.results)), eligibleForRanking: verReport.eligibleForRanking } } as JsonRecord }).where(eq(ResearchRunTable.id, executed.run.id)).run())
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
            rejectedVerifiers: verReport.results.filter((r) => r.status === "failed").map((r) => r.name),
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
        if (verReport.status === "failed") {
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
              accepted: verReport.accepted,
              verificationStatus: verReport.status,
              verifierCount: verReport.results.length,
            },
          })
        }
        managerTrace.push(
          managerStep(
            "verifier",
            verReport.status === "failed" ? "blocked" : "completed",
            verReport.status === "insufficient_evidence" ? "VerifierAgent retained the observation with incomplete verification; missing checks did not pass." : verReport.accepted
              ? "VerifierAgent accepted the run after all checks passed."
              : `VerifierAgent rejected the run: ${verReport.rejectReason}`,
            {
              runID: executed.run.id,
              selectedCandidateID: candidate.id,
              verifierAccepted: verReport.accepted,
              ...(verReport.rejectReason !== undefined ? { rejectReason: verReport.rejectReason } : {}),
              rejectedVerifiers: verReport.results.filter((r) => r.status === "failed").map((r) => r.name),
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
          memoryWriteOutcome === "recorded" ? "completed" : "skipped",
          memoryWriteOutcome === "recorded"
            ? "Recorded explicitly selected research experience."
            : "Run facts are preserved; ReflectionAgent decides whether to save a reusable experience.",
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
        ...(proposalCreated
          ? { designerLLM: { callPath: modelDesignerCallPath, text: modelDesignerRawText, metadata: llmMetadata } }
          : {}),
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

    const runAutonomousIteration = logPhaseMethod("runAutonomousIteration", Effect.fn("Research.runAutonomousIteration")(function* (
      input: AutonomousIterationInput,
    ) {
      const maxAttempts = 2
      let designReplans = 0
      let feedback: ContractRecoveryState["feedback"]
      let hypothesisID: string | undefined
      const recoveryArtifacts: ResearchArtifact[] = []
      const finishRecovery = (status: "recovered" | "failed", result?: AutonomousIterationResult) => Effect.gen(function* () {
        for (const artifact of recoveryArtifacts) {
          const resolution = { status, replacementCandidateID: result?.candidate.id ?? null, verificationRunID: result?.run.id ?? null }
          yield* Effect.promise(async () => {
            const file = artifact.uri.slice(7)
            const payload = JSON.parse(await readFile(file, "utf8"))
            await writeFile(file, JSON.stringify({ ...payload, automatic_recovery: { ...payload.automatic_recovery, ...resolution } }, null, 2) + "\n")
          })
          yield* db((d) => d.update(ResearchArtifactTable).set({
            metadata: { ...artifact.metadata, autoRecoveryStatus: status, replacementCandidateID: resolution.replacementCandidateID, verificationRunID: resolution.verificationRunID },
            time_updated: Date.now(),
          }).where(eq(ResearchArtifactTable.id, artifact.id)).run())
        }
      })
      for (let attempt = 0; attempt <= maxAttempts;) {
        const outcome = yield* runAutonomousIterationAttempt(input).pipe(
          Effect.provideService(ContractRecovery, { taskID: input.taskID, attempt, maxAttempts, feedback, hypothesisID }),
          Effect.map((result) => ({ result, cause: undefined })),
          Effect.catchCause((cause) => Effect.succeed({ result: undefined, cause })),
        )
        if (outcome.result) {
          yield* finishRecovery(outcome.result.run.status === "succeeded" ? "recovered" : "failed", outcome.result)
          return outcome.result
        }
        const cause = outcome.cause!
        const error = Cause.squash(cause)
        if (DesignUnavailableError.isInstance(error)) {
          const current = yield* getTask(input.taskID)
          const unavailable = error.data.report
          const hypothesis = (yield* listHypotheses(input.taskID)).find((h) => h.id === unavailable.hypothesisID)
          const designFeedback = { ...unavailable, hypothesisSnapshot: JSON.parse(JSON.stringify(hypothesis ?? null)), replanAttempt: ++designReplans }
          yield* Effect.promise(() => updateHypothesisInPool(input.taskID, unavailable.hypothesisID, { testable: false }))
          const dir = path.join(Instance.directory, ".neo-research", "sessions", input.taskID, "design-feedback")
          const file = path.join(dir, `${Date.now()}-${designReplans}.json`)
          yield* Effect.promise(async () => { await mkdir(dir, { recursive: true }); await writeFile(file, JSON.stringify(designFeedback, null, 2) + "\n") })
          yield* createArtifact({ taskID: input.taskID, kind: "model_design_unavailable_json", uri: `file://${file}`, metadata: { hypothesisID: unavailable.hypothesisID } })
          yield* db((d) => d.update(ResearchTaskTable).set({
            task_spec: { ...current.taskSpec, metadata: { ...recordValue(current.taskSpec.metadata), designFeedback, nextExperiment: null } },
            time_updated: Date.now(),
          }).where(eq(ResearchTaskTable.id, input.taskID)).run())
          recordResearchEvent(Instance.directory, "research.design.unavailable", { taskID: input.taskID, ...designFeedback })
          yield* finishRecovery("failed")
          recoveryArtifacts.length = 0
          feedback = undefined
          hypothesisID = undefined
          if (designReplans > 3) throw new DesignPlanningStopped({ reason: "Three hypothesis regenerations still produced unavailable designs; no proxy experiment was submitted." })
          const replanned = yield* runHypoPlannerAgent({ taskID: input.taskID })
          if (replanned.llm.status !== "used" || replanned.plan.nextExperiment?.action !== "experiment")
            throw new DesignPlanningStopped({ reason: "HypoPlanner could not select a feasible replacement after ModelDesigner feedback." })
          yield* updateTaskStatus({ taskID: input.taskID, status: "searching" })
          continue
        }
        if (!PipelineBlockedError.isInstance(error) || error.data.reason !== "execution_contract_violation" || attempt >= maxAttempts) {
          yield* finishRecovery("failed")
          return yield* Effect.failCause(cause)
        }
        const blocker = yield* latestExecutionBlocker(input.taskID)
        // An existing human checkpoint must still be explicitly resolved by its owner.
        if (!blocker || blocker.metadata.approvalID) return yield* Effect.failCause(cause)
        const candidate = yield* getCandidateForTask(input.taskID, String(blocker.metadata.candidateID) as ResearchCandidateID)
        const payload = yield* Effect.promise(() => readFile(blocker.uri.slice(7), "utf8").then(JSON.parse))
        hypothesisID = candidate.hypothesisID
        feedback = {
          attempt: attempt + 1,
          rejectedCandidate: candidate.candidateSpec,
          issues: [
            ...((payload.mismatches ?? []) as ContractMismatch[]).map((item) => ({
              ...item, message: "Execution contract verification failed. Repair the candidate without weakening the contract or changing its hypothesis.",
            })),
            ...(payload.runner_error ? [{ path: "runner", message: String(payload.runner_error) }] : []),
          ],
        }
        // Preserve invalid evidence, reject only the incompatible candidate and let
        // ModelDesigner generate a replacement tied to the original hypothesis.
        yield* supersedeExecutionContractCheckpoint(blocker)
        recoveryArtifacts.push({ ...blocker, metadata: { ...blocker.metadata, status: "superseded", supersededReason: "candidate_rejected_for_redesign" } })
        recordResearchEvent(Instance.directory, "research.execution_contract.repair", {
          taskID: input.taskID, agent: "ModelDesignerAgent", candidateID: candidate.id,
          blockerArtifactID: blocker.id, attempt: attempt + 1, maxAttempts, feedback,
        })
        attempt += 1
      }
      throw new Error("Execution contract recovery exhausted")
    }))

    const getAutonomousLoopStopReason = Effect.fn("Research.getAutonomousLoopStopReason")(function* (
      task: ResearchTask,
    ) {
      const currentTask = yield* getTask(task.id)
      const decision = parseNextExperiment(recordValue(currentTask.taskSpec.metadata).nextExperiment)
      const pool = yield* listCandidates(task.id)
      const candidates = decision?.action === "experiment"
        ? pool.filter((candidate) => candidate.hypothesisID === decision.hypothesisID)
        : pool
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
      const selectedCandidateIDs = new Set(candidates.map((candidate) => candidate.id))
      const hasBlockingApproval = pendingApprovals.some((approval) => approval.kind !== "ref_test" &&
        (approval.kind !== "candidate" || !approval.candidateID || selectedCandidateIDs.has(approval.candidateID)))
      return hasBlockingApproval ? ("approval_required" as const) : undefined
    })

    const runAutonomousLoop = logPhaseMethod("runAutonomousLoop", Effect.fn("Research.runAutonomousLoop")(function* (input: AutonomousLoopInput) {
      const iterations: AutonomousIterationResult[] = []
      yield* assertExecutionCheckpoint(input.taskID)
      const task = yield* getTask(input.taskID)
      if (task.mode !== "autonomous") throw new Error(`Research task is not autonomous: ${task.id}`)
      const requestedIterations = autonomousLoopMaxIterations(input.maxIterations, task)
      const direction = objectiveDirection(task.objective)
      const primaryMetricName = objectiveMetricName(task.objective)
      const requestedTargetMetricValue = loopPolicyValue(input.targetMetricValue, task, "targetMetricValue", "target")
      const requestedMinRelativeImprovement =
        loopPolicyValue(input.minRelativeImprovement, task, "minRelativeImprovement", "minImprovement") ?? 0
      const requestedMaxNoImprove =
        loopPolicyInteger(input.maxNoImprove, task, "maxNoImprove", "maxNoImproveRounds") ?? NAS_DEFAULT_MAX_NO_IMPROVE
      const requestedTimeBudget = loopPolicyValue(input.timeBudgetSeconds, task, "timeBudgetSeconds", "timeBudgetS")
      const requestedMaxCrashStreak = loopPolicyInteger(input.maxCrashStreak, task, "maxCrashStreak")
      const requestedExplorationRate = loopPolicyRate(input.explorationRate, task, "explorationRate", "exploration")
      const startedAt = Date.now()
      const stage = input.stage ?? "full"
      const existingRuns = yield* listRuns(task.id)
      const cycle = searchCycle(task, existingRuns, { maxIterations: requestedIterations, timeBudgetSeconds: requestedTimeBudget,
        targetMetricValue: requestedTargetMetricValue, minRelativeImprovement: requestedMinRelativeImprovement,
        maxNoImprove: requestedMaxNoImprove, maxCrashStreak: requestedMaxCrashStreak, explorationRate: requestedExplorationRate })
      const targetMetricValue = cycle.policy.targetMetricValue
      const minRelativeImprovement = cycle.policy.minRelativeImprovement ?? 0
      const maxNoImprove = cycle.policy.maxNoImprove ?? NAS_DEFAULT_MAX_NO_IMPROVE
      const maxCrashStreak = cycle.policy.maxCrashStreak
      const explorationRate = cycle.policy.explorationRate
      const maxIterations = cycle.policy.maxIterations ?? requestedIterations
      const timeBudgetSeconds = cycle.policy.timeBudgetSeconds
      const initialMetricState =
        stage === "smoke"
          ? { bestMetric: undefined, noImproveStreak: 0 }
          : sessionLocalMetricState({
              runs: existingRuns.filter((run) => !cycle.request_key || run.resourceUsage.cycleID === cycle.id),
              stage,
              primaryMetricName,
              direction,
              minRelativeImprovement,
            })
      let bestMetric = initialMetricState.bestMetric
      let noImproveStreak = initialMetricState.noImproveStreak
      let crashStreak = cycle.crash_streak
      let completedIterations = cycle.iterations
      let duplicateStreak = 0
      const stopClock = cycleClock(cycle.id)
      return yield* Effect.gen(function* () {
      if (maxCrashStreak !== undefined && crashStreak >= maxCrashStreak) return yield* finishAutonomousLoop({ task, iterations, maxIterations, stoppedReason: "crash_streak_exceeded" })
      const refreshPlanner = Effect.fn("Research.planNextExperiment")(function* () {
        const current = yield* getTask(task.id)
        yield* db((d) => d.update(ResearchTaskTable).set({
          task_spec: { ...current.taskSpec, metadata: { ...recordValue(current.taskSpec.metadata), searchProgress: {
            noImproveStreak, plateauThreshold: maxNoImprove, globalPlateauObserved: noImproveStreak >= maxNoImprove,
            bestMetric: bestMetric ?? null, remainingIterations: maxIterations - completedIterations,
            instruction: "Decide the next experiment from completed independent results. A local plateau is a signal to reconsider the direction, not an automatic global stop. Hard iteration/time/resource limits still apply.",
          } } },
          time_updated: Date.now(),
        }).where(eq(ResearchTaskTable.id, task.id)).run())
        return yield* runHypoPlannerAgent({ taskID: task.id })
      })
      if (timeBudgetSeconds !== undefined && cycle.elapsed_ms + Date.now() - startedAt >= timeBudgetSeconds * 1000) return yield* finishAutonomousLoop({ task, iterations, maxIterations, stoppedReason: "time_budget_exhausted" })
      if (cycle.iterations < maxIterations && parseNextExperiment(recordValue(task.taskSpec.metadata).nextExperiment)?.action === "stop") return yield* finishAutonomousLoop({ task, iterations, maxIterations, stoppedReason: "planner_stopped" })
      if (cycle.iterations > 0 && noImproveStreak >= maxNoImprove && cycle.iterations < maxIterations) {
        const planned = yield* refreshPlanner()
        if (planned.llm.status !== "used") return yield* finishAutonomousLoop({ task, iterations, maxIterations, stoppedReason: "plateau" })
      }
      for (let index = cycle.iterations; index < maxIterations; index++) {
        if (timeBudgetSeconds !== undefined && cycle.elapsed_ms + Date.now() - startedAt >= timeBudgetSeconds * 1000) {
          return yield* finishAutonomousLoop({ task, iterations, maxIterations, stoppedReason: "time_budget_exhausted" })
        }
        const budgetExceeded = yield* getRunBudgetExceeded(task, "queued")
        if (budgetExceeded) {
          yield* ensureBudgetApproval(task, undefined, budgetExceeded)
          return yield* finishAutonomousLoop({ task, iterations, maxIterations, stoppedReason: "budget_exhausted" })
        }
        const blockedReason = yield* getAutonomousLoopStopReason(task)
        if (blockedReason) return yield* finishAutonomousLoop({ task, iterations, maxIterations, stoppedReason: blockedReason })

        const nextDecision = parseNextExperiment(recordValue((yield* getTask(task.id)).taskSpec.metadata).nextExperiment)
        if (nextDecision?.action === "stop") return yield* finishAutonomousLoop({ task, iterations, maxIterations, stoppedReason: "planner_stopped" })
        const description =
          input.description === undefined ? undefined : `${input.description} (iteration ${index + 1})`
        const iterationResult = yield* runAutonomousIteration({
          taskID: input.taskID,
          stage,
          description,
          forceExplore: shouldForceExplorationIteration(index, explorationRate),
        }).pipe(
          Effect.map((iteration) => ({ status: "iteration" as const, iteration })),
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause)
            if (DesignPlanningStopped.isInstance(error)) {
              recordResearchEvent(Instance.directory, "research.design.planning_stopped", { taskID: task.id, reason: error.data.reason })
              return finishAutonomousLoop({ task, iterations, maxIterations, stoppedReason: "planner_stopped" }).pipe(
                Effect.map((result) => ({ status: "stopped" as const, result })),
              )
            }
            if (ApprovalRequiredError.isInstance(error)) {
              return finishAutonomousLoop({ task, iterations, maxIterations, stoppedReason: "approval_required" }).pipe(
                Effect.map((result) => ({ status: "stopped" as const, result })),
              )
            }
            if (SeedBaselinesError.isInstance(error)) {
              return finishAutonomousLoop({ task, iterations, maxIterations, stoppedReason: "seed_failed" }).pipe(
                Effect.map((result) => ({ status: "stopped" as const, result })),
              )
            }
            return Effect.failCause(cause)
          }),
        )
        if (iterationResult.status === "stopped") return iterationResult.result
        chargeIteration(cycle.id)
        completedIterations += 1
        iterations.push(iterationResult.iteration)
        if (iterationResult.iteration.run.resourceUsage.duplicateExperiment === true) {
          duplicateStreak += 1
          if (duplicateStreak >= 3) return yield* finishAutonomousLoop({ task, iterations, maxIterations, stoppedReason: "no_new_candidate" })
          if (index === maxIterations - 1) continue
          if (timeBudgetSeconds !== undefined && cycle.elapsed_ms + Date.now() - startedAt >= timeBudgetSeconds * 1000) return yield* finishAutonomousLoop({ task, iterations, maxIterations, stoppedReason: "time_budget_exhausted" })
          yield* refreshPlanner()
          yield* updateTaskStatus({ taskID: input.taskID, status: "searching" })
          continue
        }
        duplicateStreak = 0
        if (iterationResult.iteration.run.status === "failed") {
          crashStreak += 1
          saveCrashStreak(cycle.id, crashStreak)
          if (maxCrashStreak !== undefined && crashStreak >= maxCrashStreak) {
            return yield* finishAutonomousLoop({ task, iterations, maxIterations, stoppedReason: "crash_streak_exceeded" })
          }
        } else {
          crashStreak = 0
          saveCrashStreak(cycle.id, crashStreak)
        }
        const metric =
          stage === "smoke" || !["succeeded", "rejected"].includes(iterationResult.iteration.run.status) || iterationResult.iteration.run.resourceUsage.independentEvidence === false
            ? undefined : metricValue(iterationResult.iteration.run.metrics, primaryMetricName)
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
          if (targetReached) return yield* finishAutonomousLoop({ task, iterations, maxIterations, stoppedReason: "target_reached" })

        }
        // Per-iteration reflection: run after every TrainEval, LLM-augmented, non-blocking.
        yield* runReflectionAgent({ taskID: input.taskID, maxIterations }).pipe(Effect.catchCause(() => Effect.void))
        // Check loop-end conditions after reflection. If any stop condition is already met,
        // there is no next iteration — skip HypoPlanner and finish immediately.
        if (timeBudgetSeconds !== undefined && cycle.elapsed_ms + Date.now() - startedAt >= timeBudgetSeconds * 1000) {
          return yield* finishAutonomousLoop({ task, iterations, maxIterations, stoppedReason: "time_budget_exhausted" })
        }
        const isLastIteration = index === maxIterations - 1
        if (!isLastIteration) {
          const nextIterBlockedReason = yield* getAutonomousLoopStopReason(task)
          if (nextIterBlockedReason) {
            return yield* finishAutonomousLoop({ task, iterations, maxIterations, stoppedReason: nextIterBlockedReason })
          }
          // Next iteration will run: refresh hypotheses, then restore searching status.
          const planned = yield* refreshPlanner()
          if (planned.plan.nextExperiment?.action === "stop") return yield* finishAutonomousLoop({ task, iterations, maxIterations, stoppedReason: "planner_stopped" })
          if (noImproveStreak >= maxNoImprove && planned.llm.status !== "used") return yield* finishAutonomousLoop({ task, iterations, maxIterations, stoppedReason: "plateau" })
          yield* updateTaskStatus({ taskID: input.taskID, status: "searching" })
        }
      }
      return yield* finishAutonomousLoop({ task, iterations, maxIterations, stoppedReason: "max_iterations" })
      }).pipe(Effect.ensuring(Effect.sync(stopClock)))
    }))

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
            metrics: input.status === "invalid" ? {} : input.metrics ?? existingRow.metrics,
            resource_usage: input.resourceUsage ? { ...input.resourceUsage,
              ...(existingRow.resource_usage.experienceContext ? { experienceContext: existingRow.resource_usage.experienceContext } : {}),
            } : existingRow.resource_usage,
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
      if (input.runID) {
        const existing = yield* db((d) => d.select().from(ResearchArtifactTable).where(and(eq(ResearchArtifactTable.task_id, input.taskID), eq(ResearchArtifactTable.run_id, input.runID!), eq(ResearchArtifactTable.kind, input.kind), eq(ResearchArtifactTable.uri, input.uri))).get())
        if (existing) return mapArtifact(existing)
      }
      const snapshot = yield* Effect.promise(() => snapshotPhaseArtifact(Instance.directory, input))
      const time = nowTime()
      const row = yield* db((d) =>
        d
          .insert(ResearchArtifactTable)
          .values({
            id: ResearchArtifactID.ascending(),
            task_id: input.taskID,
            run_id: input.runID,
            kind: input.kind,
            uri: snapshot?.uri ?? input.uri,
            metadata: { ...input.metadata, ...(snapshot ? { sourceURI: snapshot.sourceURI, sha256: snapshot.sha256 } : {}) },
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

    const prepareTaskDataset = logPhaseMethod("prepareTaskDataset", Effect.fn("Research.prepareTaskDataset")(function* (input: PrepareTaskDatasetInput) {
      const task = yield* getTask(input.taskID)
      const command = buildPrepareDatasetCommand(task, input.force ?? true, Instance.directory)
      yield* Effect.promise(() => mkdir(command.cwd, { recursive: true }))
      const preparationLog = path.join(Instance.directory, ".neo-research", "logs", task.id, `prepare-${crypto.randomUUID()}.jsonl`)
      appendLog(preparationLog, { event: "process_started", command: command.executable, args: command.args })
      const execution = yield* abortable((signal) =>
        Process.runStreaming([command.executable, ...command.args], {
          abort: signal,
          tree: true,
          cwd: command.cwd,
          env: command.env,
          onStdoutLine: (line) => appendLog(preparationLog, { stream: "stdout", line }),
          onStderrLine: (line) => appendLog(preparationLog, { stream: "stderr", line }),
          nothrow: true,
          timeout: 300_000,
        }).then((result) => {
          appendLog(preparationLog, { event: signal.aborted ? "process_canceled" : "process_exited", exitCode: result.code })
          return result
        }).catch((error) => {
          appendLog(preparationLog, { event: signal.aborted ? "process_canceled" : "process_failed", error: String(error) })
          throw error
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
        requestedRoleConfig: tsfDatasetPreparationConfig(task),
        effectiveRoleConfig: {
          targetCols: datasetSpec.target_columns ?? datasetSpec.feature_columns ?? [],
          observedPastCovariates: datasetSpec.observed_past_covariates ?? [],
          knownFutureCovariates: datasetSpec.known_future_covariates ?? [],
          staticCovariates: datasetSpec.static_covariates ?? [],
        },
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
          runnerRoot: command.runnerRoot,
          inputLen: typeof datasetSpec.input_len === "number" ? datasetSpec.input_len : 0,
          horizons: Array.isArray(datasetSpec.horizons) ? datasetSpec.horizons.join(",") : "",
          featureColumns: Array.isArray(datasetSpec.feature_columns) ? datasetSpec.feature_columns.join(",") : "",
          targetColumns: Array.isArray(datasetSpec.target_columns) ? datasetSpec.target_columns.join(",") : "",
          observedPastCovariates: Array.isArray(datasetSpec.observed_past_covariates) ? datasetSpec.observed_past_covariates.join(",") : "",
          knownFutureCovariates: Array.isArray(datasetSpec.known_future_covariates) ? datasetSpec.known_future_covariates.join(",") : "",
          warnings: command.warnings.join("\n"),
        },
      })
      return {
        artifact,
        path: outputPath,
        datasetSpec,
        command: payload.command as JsonRecord,
      }
    }))

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
        const publishFinalReportArtifact =
          champion === undefined || championRefTestRun === undefined
            ? undefined
            : artifacts.find(
                (artifact) =>
                  artifact.kind === "final_report_md" &&
                  artifact.metadata.championRunID === champion.runID &&
                  artifact.metadata.refTestRunID === championRefTestRun.id,
              )
        const publishFinalReportSource =
          publishFinalReportArtifact === undefined ? undefined : filePathFromURI(publishFinalReportArtifact.uri)
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
          if (publishFinalReportSource !== undefined && existsSync(publishFinalReportSource)) {
            await cp(publishFinalReportSource, finalReportPath, { force: true })
          } else {
            await writeFile(finalReportPath, `${sections.join("\n\n")}\n`, "utf8")
          }
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
          for (const name of ["logs", "runner-progress", "runner-executions", "artifact-versions"]) {
            const source = path.join(Instance.directory, ".neo-research", name, task.id)
            if (!existsSync(source)) continue
            await cp(source, path.join(traceDirectory, name), { recursive: true, force: true })
            copiedFiles[`trace/${name}`] = `trace/${name}`
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
            publishReport:
              publishFinalReportArtifact === undefined
                ? null
                : {
                    artifactID: publishFinalReportArtifact.id,
                    inputSnapshotArtifactID: publishFinalReportArtifact.metadata.inputSnapshotArtifactID,
                    validationStatus: publishFinalReportArtifact.metadata.validationStatus,
                    callPath: publishFinalReportArtifact.metadata.callPath,
                  },
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

    const profileTask = logPhaseMethod("profileTask", Effect.fn("Research.profileTask")(function* (
      input: ProfileTaskInput & { readonly _onDeltaQualitative?: (delta: string) => void },
    ) {
      const task = yield* getTask(input.taskID)
      const fingerprint = DomainRegistry.summarizeTask(task.domainID, task.taskSpec, { taskID: task.id, projectRoot: Instance.directory, workspaceRoot: taskExecutionRoot(task, Instance.directory) })
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
      const dataAnalysisRuntime = recordValue(recordValue(task.taskSpec).runtime)
      const dataAnalysisNeoCastRoot =
        typeof dataAnalysisRuntime.neoCastProjectRoot === "string" ? dataAnalysisRuntime.neoCastProjectRoot : undefined
      const dataAnalysisLLMContext = yield* Effect.promise(() =>
        resolveEffectiveLLMConfig({ workspaceRoot: Instance.directory, neoCastProjectRoot: dataAnalysisNeoCastRoot }),
      )
      const dataAnalysisConfig = dataAnalysisLLMContext?.config ?? (yield* Effect.promise(() =>
        resolveNeoCastLLMConfig({ workspaceRoot: Instance.directory, neoCastProjectRoot: dataAnalysisNeoCastRoot }),
      ))
      const dataAnalysisSessionAttempt = yield* requestViaSession({
        rootSessionID: task.sessionID,
        agent: "research-data-analysis",
        stageLabel: "DataAnalysis",
        taskID: task.id,
        user: buildQualitativeUserPrompt(task, fingerprint as JsonRecord, analysisContext),
        modelRef: mapToModelRef(dataAnalysisConfig),
        onDelta: (delta) => bus.publish(Event.DataAnalysisAgentStreamDelta, { taskID: task.id, agent: "DataAnalysisAgent", delta }),
        onPartUpdated: (part) => {
          if (part.type === "text") {
            return bus.publish(Event.DataAnalysisAgentPartUpdated, {
              taskID: task.id,
              agent: "DataAnalysisAgent",
              partID: part.id,
              kind: "text",
              text: part.text,
            })
          }
          if (part.type === "tool") {
            const s = part.state
            return bus.publish(Event.DataAnalysisAgentPartUpdated, {
              taskID: task.id,
              agent: "DataAnalysisAgent",
              partID: part.id,
              kind: "tool",
              toolName: part.tool,
              toolInput: s.status !== "pending" ? s.input : undefined,
              toolOutput: s.status === "completed" ? s.output : undefined,
              toolState: s.status === "error" ? "error" : s.status === "completed" ? "completed" : s.status === "running" ? "running" : "pending",
              toolDurationMs: s.status === "completed" ? s.time.end - s.time.start : undefined,
              toolError: s.status === "error" ? s.error : undefined,
            })
          }
          return Effect.void
        },
      })
      const dataAnalysisCallPath: "session" | "direct" = dataAnalysisSessionAttempt ? "session" : "direct"
      logLLMCallPath("DataAnalysis", task.id, dataAnalysisCallPath)
      yield* bus.publish(Event.LLMCallPath, { taskID: task.id, agent: "DataAnalysis", path: dataAnalysisCallPath })
      const llmQualitative = dataAnalysisSessionAttempt
        ? {
            text: dataAnalysisSessionAttempt.text,
            usage: dataAnalysisSessionAttempt.usage,
            searchPreferences: parseSearchPreferencesFromQualitative(dataAnalysisSessionAttempt.text),
          }
        : yield* Effect.promise(() =>
            generateLLMQualitativeAnalysis(task, fingerprint as JsonRecord, analysisContext, Instance.directory, input._onDeltaQualitative),
          )
      const analysisFiles = buildDatasetAnalysisReports(task, fingerprint as JsonRecord, analysisContext, llmQualitative?.text, [artifact.id])
      if (llmQualitative?.searchPreferences && llmQualitative.searchPreferences.length > 0) {
        yield* Effect.promise(async () => {
          await mkdir(analysisDirectory, { recursive: true })
          await writeFile(
            path.join(analysisDirectory, "search_preferences.json"),
            JSON.stringify(llmQualitative.searchPreferences),
            "utf8",
          )
        })
      }
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
      const sourceReports: DatasetAnalysisSourceReport[] = analysisFiles.flatMap((source, index) => {
        if (source.metadata.format !== "markdown") return []
        const sourceArtifact = analysisArtifacts[index]!
        return [{
          id: sourceArtifact.id,
          kind: sourceArtifact.kind,
          role: source.role,
          content: source.content,
        }]
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
    }))

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

	    // Mirrors taskspec-store.ts's ASK_USER_CLARIFICATION_MARKER — service.ts doesn't import that
    // module (see taskspec-store.ts's standalone-module note), so keep this string in sync by hand.
    const INTENT_ASK_USER_MARKER = "需要澄清研究意图："

    const intentSessionTitle = (taskID: ResearchTaskID) => `IntentAgent · ${taskID}`

	    const findIntentAgentSessionID = Effect.fn("Research.findIntentAgentSessionID")(function* (task: ResearchTask) {
	      if (!task.sessionID) return undefined
	      const rows = yield* db((d) =>
	        d
	          .select({ id: SessionTable.id, created: SessionTable.time_created })
	          .from(SessionTable)
	          .where(and(eq(SessionTable.parent_id, task.sessionID as any), eq(SessionTable.title, intentSessionTitle(task.id))))
	          .all(),
	      )
	      if (rows.length === 0) return undefined
	      return rows.toSorted((a, b) => b.created - a.created)[0]!.id
	    })

	    const latestPendingIntentApproval = Effect.fn("Research.latestPendingIntentApproval")(function* (taskID: ResearchTaskID) {
	      const row = yield* db((d) =>
	        d
	          .select()
	          .from(ResearchApprovalTable)
	          .where(
	            and(
	              eq(ResearchApprovalTable.task_id, taskID),
	              eq(ResearchApprovalTable.kind, "protocol"),
	              eq(ResearchApprovalTable.status, "pending"),
	            ),
	          )
	          .orderBy(desc(ResearchApprovalTable.time_created))
	          .limit(1)
	          .get(),
	      )
	      return row?.reason
	    })

	    const onIntentAgentPartUpdated = (taskID: ResearchTaskID) => (part: MessageV2.Part) => {
      if (part.type === "text") {
        return bus.publish(Event.IntentAgentPartUpdated, {
          taskID,
          agent: "IntentAgent",
          partID: part.id,
          kind: "text",
          text: part.text,
        })
      }
      if (part.type === "tool") {
        const s = part.state
        return bus.publish(Event.IntentAgentPartUpdated, {
          taskID,
          agent: "IntentAgent",
          partID: part.id,
          kind: "tool",
          toolName: part.tool,
          toolInput: s.status !== "pending" ? s.input : undefined,
          toolOutput: s.status === "completed" ? s.output : undefined,
          toolState: s.status === "error" ? "error" : s.status === "completed" ? "completed" : s.status === "running" ? "running" : "pending",
          toolDurationMs: s.status === "completed" ? s.time.end - s.time.start : undefined,
          toolError: s.status === "error" ? s.error : undefined,
        })
      }
      return Effect.void
    }

    function buildIntentAgentKickoffPrompt(task: ResearchTask) {
	      return [
	        `Begin intent gathering for research task "${task.title}" (domain: ${task.domainID}, id: ${task.id}).`,
	        "Follow your workflow: analyze the dataset if available, read the taskspec, then ask about whatever required slots are still missing.",
	      ].join("\n")
	    }

	    // Drives one turn of the research-intent-agent session: creates (or resumes) the
	    // session, prompts it, and reports whether check_taskspec succeeded this turn.
	    // See specs/research/intent-agent-tool-refactor.md §5.2-5.3 for the design.
	    const runIntentAgentTurn = Effect.fn("Research.runIntentAgentTurn")(function* (input: {
	      readonly task: ResearchTask
	      readonly userMessage: string
          readonly syntheticPrompt?: boolean
	      readonly modelRef: OpencodeModelRef | undefined
	      readonly onPartUpdated?: (part: MessageV2.Part) => Effect.Effect<void>
	      readonly onDelta?: (delta: string) => Effect.Effect<void>
	    }) {
	      // Both branches below used to fail silently — runFullPipeline would then fall through
	      // to the deterministic analyzeIntentTask() approval with no indication the session
	      // never ran, which from the TUI looked like the [IntentAgent] stream got skipped
	      // straight to a canned "Next question". Publish IntentAgentFailed so the cause is
	      // visible instead of an empty spinner forever.
	      if (!input.task.sessionID || (!input.modelRef && !taskSessionModel(input.task.taskSpec) && !(yield* Effect.promise(readSelectedSessionModel)))) {
	        yield* bus.publish(Event.IntentAgentFailed, {
	          taskID: input.task.id,
	          agent: "IntentAgent",
	          stage: "intent_gathering",
	          status: "failed",
	          metadata: {
	            reason: !input.task.sessionID ? "task has no session" : "no LLM model configured for IntentAgent",
	          },
	        })
	        return undefined
	      }
	      const existingSessionID = yield* findIntentAgentSessionID(input.task)
	      const sessionID =
	        existingSessionID ??
	        (yield* session.create({
	          parentID: input.task.sessionID as Session.Info["id"],
	          title: intentSessionTitle(input.task.id),
	        })).id
	      const onPartUpdated = input.onPartUpdated
	      const onDelta = input.onDelta
	      const promptEffect = selectSessionModel(input.task.id, input.modelRef).pipe(
            Effect.flatMap((model) => sessionPrompt.prompt({
              sessionID,
              agent: "research-intent-agent",
              model,
              parts: [{ type: "text", text: input.userMessage, synthetic: input.syntheticPrompt ?? false }],
            })),
            Effect.onInterrupt(() => sessionPrompt.cancel(sessionID)),
          )
	      const result = yield* (onPartUpdated || onDelta
	        ? Effect.scoped(
	            Effect.gen(function* () {
	              if (onPartUpdated) {
	                yield* Effect.forkScoped(
	                  bus.subscribe(MessageV2.Event.PartUpdated).pipe(
	                    Stream.filter((event) => event.properties.sessionID === sessionID),
	                    Stream.runForEach((event) => onPartUpdated(event.properties.part as MessageV2.Part)),
	                  ),
	                )
	              }
	              if (onDelta) {
	                yield* Effect.forkScoped(
	                  bus.subscribe(MessageV2.Event.PartDelta).pipe(
	                    Stream.filter((event) => event.properties.sessionID === sessionID && event.properties.field === "text"),
	                    Stream.runForEach((event) => onDelta(event.properties.delta)),
	                  ),
	                )
	              }
	              return yield* promptEffect
	            }),
	          )
	        : promptEffect
	      ).pipe(
	        Effect.catchCause((cause) =>
	          bus
	            .publish(Event.IntentAgentFailed, {
	              taskID: input.task.id,
	              agent: "IntentAgent",
	              stage: "intent_gathering",
	              status: "failed",
	              metadata: errorMetadata(Cause.squash(cause)),
	            })
	            .pipe(Effect.andThen(Effect.succeed(undefined))),
	        ),
	      )
	      if (!result) return undefined
	      const checkOk = result.parts.some((part) => {
	        if (part.type !== "tool" || part.tool !== "check_taskspec") return false
	        const s = part.state
	        if (s.status !== "completed") return false
	        try {
	          return (JSON.parse(s.output) as { ok?: boolean }).ok === true
	        } catch {
	          return false
	        }
	      })
	      return { sessionID, checkOk }
	    })

	    // Runs runFullPipeline() after a successful check_taskspec, exactly like the legacy
	    // rule-based path did — PipelineBlockedError just means it paused at the (existing,
	    // unchanged) intent checkpoint, which is expected.
	    const advanceFromIntentTurn: (input: {
	      readonly taskID: ResearchTaskID
	      readonly checkOk: boolean
	    }) => Effect.Effect<void> = Effect.fn("Research.advanceFromIntentTurn")(function* (input: {
	      readonly taskID: ResearchTaskID
	      readonly checkOk: boolean
	    }) {
	      if (input.checkOk) {
	        yield* runFullPipeline({ taskID: input.taskID }).pipe(
	          Effect.catch((error: unknown) => (error instanceof PipelineBlockedError ? Effect.void : Effect.fail(error as never))),
	        )
	      } else {
	        yield* updateTaskStatus({ taskID: input.taskID, status: "idle" })
	      }
	    })

	    // Builds the legacy IntentAgentResult shape (REST/TUI contract) from the task's
	    // current state, so existing callers (REST routes, research-cockpit-data.ts) don't
	    // need to change in this step. analyzeIntentTask() is deterministic and already reads
	    // taskSpec.intent.slots.* as its highest-priority source, so it picks up whatever
	    // update_taskspec just wrote. clarifyingQuestions is overridden with whatever ask_user
	    // most recently recorded, since that — not the old per-slot templates — is now the
	    // actual question the user is being shown.
	    const intentResultFromTask = Effect.fn("Research.intentResultFromTask")(function* (taskID: ResearchTaskID) {
	      const task = yield* getTask(taskID)
	      const base = analyzeIntentTask({ task })
	      const pendingReason = yield* latestPendingIntentApproval(taskID)
	      if (pendingReason === undefined) return base
	      const questions = pendingReason
	        .split("\n")
	        .map((line) => line.trim())
	        .filter((line) => line.startsWith("- "))
	        .map((line) => line.slice(2).trim())
	        .filter((line) => line.length > 0)
	      if (questions.length === 0) return base
	      return { ...base, clarifyingQuestions: questions }
	    })

	    const runIntentAgent: (taskID: ResearchTaskID) => Effect.Effect<IntentAgentResult> = logPhaseMethod("runIntentAgent", Effect.fn(
	      "Research.runIntentAgent",
	    )(function* (taskID: ResearchTaskID) {
	      yield* updateTaskStatus({ taskID, status: "intent_gathering" })
	      yield* bus.publish(Event.IntentAgentStarted, {
	        taskID,
	        agent: "IntentAgent",
	        stage: "intent_gathering",
	        status: "started",
	      })
	      return yield* Effect.gen(function* () {
	        const task = yield* getTask(taskID)
	        // runFullPipeline() calls runIntentAgent() unconditionally on every invocation
	        // (every resume, every checkpoint-driven continuation) — once intent is already
	        // satisfied, skip spinning up another LLM session turn; just report current state.
	        const alreadySatisfied = analyzeIntentTask({ task }).missingFields.length === 0
	        // Do NOT call advanceFromIntentTurn()/runFullPipeline() from here: runIntentAgent()
	        // is itself invoked from inside runFullPipeline() (see below), so doing so would
	        // recurse. runFullPipeline()'s own existing logic (right after this call) already
	        // decides whether to block on missing fields / the intent checkpoint, or continue.
	        if (!alreadySatisfied) {
	          const intentLLMContext = yield* Effect.promise(() => resolveEffectiveLLMConfig({ workspaceRoot: Instance.directory }))
	          const intentConfig =
	            intentLLMContext?.config ?? (yield* Effect.promise(() => resolveNeoCastLLMConfig({ workspaceRoot: Instance.directory })))
	          yield* runIntentAgentTurn({
	            task,
	            userMessage: buildIntentAgentKickoffPrompt(task),
            syntheticPrompt: true,
	            modelRef: mapToModelRef(intentConfig),
	            onPartUpdated: onIntentAgentPartUpdated(taskID),
	            onDelta: (delta) => bus.publish(Event.IntentAgentStreamDelta, { taskID, agent: "IntentAgent", delta }),
	          })
	        }
	        const result = yield* intentResultFromTask(taskID)
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
	            sessionStarted: !alreadySatisfied,
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
	    }))

	    // Continues the IntentAgent session with a new user message — replaces the old
	    // "rerun a stateless analyzeIntentTask() pass" behavior. Both answerIntentQuestion
	    // (structured slot answers) and interpretAndApplySlotModification (free-text) now
	    // funnel into this: the LLM in the session does the interpretation itself, so there's
	    // no separate parseSlotInputsWithLLM/interpretSlotModificationWithLLM call anymore.
	    const continueIntentAgentSession = logPhaseMethod("continueIntentAgentSession", Effect.fn("Research.continueIntentAgentSession")(function* (input: {
	      readonly taskID: ResearchTaskID
	      readonly message: string
	    }) {
	      const task = yield* getTask(input.taskID)
	      const intentLLMContext = yield* Effect.promise(() => resolveEffectiveLLMConfig({ workspaceRoot: Instance.directory }))
	      const intentConfig =
	        intentLLMContext?.config ?? (yield* Effect.promise(() => resolveNeoCastLLMConfig({ workspaceRoot: Instance.directory })))
	      yield* bus.publish(Event.IntentAgentStarted, {
        taskID: input.taskID, agent: "IntentAgent", stage: "intent_gathering", status: "started",
      })
      const turn = yield* runIntentAgentTurn({
        task,
        userMessage: input.message,
        modelRef: mapToModelRef(intentConfig),
        onPartUpdated: onIntentAgentPartUpdated(input.taskID),
        onDelta: (delta) => bus.publish(Event.IntentAgentStreamDelta, { taskID: input.taskID, agent: "IntentAgent", delta }),
      })
	      if (turn) yield* bus.publish(Event.IntentAgentCompleted, {
        taskID: input.taskID, agent: "IntentAgent", stage: "intent_gathering", status: "completed",
        metadata: { sessionID: turn.sessionID, checkOk: turn.checkOk },
      })
      yield* advanceFromIntentTurn({ taskID: input.taskID, checkOk: turn?.checkOk ?? false })
	      return yield* intentResultFromTask(input.taskID)
	    }))

	    const answerIntentQuestion = Effect.fn("Research.answerIntentQuestion")(function* (input: AnswerIntentInput) {
	      const message = `用户回答（结构化字段）：\n${JSON.stringify(input.slots, null, 2)}`
	      return yield* continueIntentAgentSession({ taskID: input.taskID, message })
	    })

	    const interpretAndApplySlotModification = Effect.fn("Research.interpretAndApplySlotModification")(function* (input: {
	      taskID: ResearchTaskID
	      message: string
	    }) {
	      return yield* continueIntentAgentSession({ taskID: input.taskID, message: input.message })
	    })


	    const runDataAnalysisAgent = logPhaseMethod("runDataAnalysisAgent", Effect.fn("Research.runDataAnalysisAgent")(function* (input: ProfileTaskInput) {
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
	              item.kind === "dataset_quantitative_analysis_json" ||
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
	    }))

    // Completed tool parts are authoritative receipts even without final prose.
    const runLiteratureSession = (task: ResearchTask, phase: LiteraturePhase, modelRef: OpencodeModelRef) =>
      Effect.gen(function* () {
        const child = yield* session.create({ parentID: task.sessionID as Session.Info["id"], title: `Literature · ${task.id}` }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        if (!child) return undefined
        yield* bus.publish(Event.LiteratureAgentProgress, { taskID: task.id, agent: "LiteratureAgent",
          runID: phase.snapshot.retrieveRunID, step: "prepare_intents", status: "completed", sessionID: child.id,
          counts: { intents: phase.snapshot.intents.length } })
        const release = bindLiteratureSession(child.id, phase)
        const assistantMessages = new Set<string>()
        const isAssistant = (messageID: MessageV2.Part["messageID"]) => {
          if (assistantMessages.has(messageID)) return true
          const info = MessageV2.get({ sessionID: child.id, messageID }).info
          if (info.role !== "assistant" || info.agent !== "research-literature") return false
          assistantMessages.add(messageID)
          return true
        }
        const forward = (part: MessageV2.Part) => {
          if (!isAssistant(part.messageID)) return Effect.void
          if (part.type === "text") return bus.publish(Event.LiteratureAgentPartUpdated, {
            taskID: task.id, agent: "LiteratureAgent", partID: part.id, kind: "text", text: part.text.slice(-8000),
          })
          if (part.type !== "tool") return Effect.void
          const state = part.state
          return bus.publish(Event.LiteratureAgentPartUpdated, {
            taskID: task.id, agent: "LiteratureAgent", partID: part.id, kind: "tool",
            toolName: part.tool, toolState: state.status,
            toolInput: state.status !== "pending" ? state.input : undefined,
            toolOutput: state.status === "completed" ? state.output : undefined,
            toolDurationMs: state.status === "completed" ? state.time.end - state.time.start : undefined,
            toolError: state.status === "error" ? state.error : undefined,
          })
        }
        return yield* Effect.gen(function* () {
          yield* Effect.scoped(Effect.gen(function* () {
            yield* Effect.forkScoped(bus.subscribe(MessageV2.Event.PartUpdated).pipe(
              Stream.filter((event) => event.properties.sessionID === child.id),
              Stream.runForEach((event) => forward(event.properties.part as MessageV2.Part)),
            ))
            yield* Effect.forkScoped(bus.subscribe(MessageV2.Event.PartDelta).pipe(
              Stream.filter((event) => event.properties.sessionID === child.id && event.properties.field === "text" && isAssistant(event.properties.messageID)),
              Stream.runForEach((event) => bus.publish(Event.LiteratureAgentStreamDelta, {
                taskID: task.id, agent: "LiteratureAgent", delta: event.properties.delta,
              })),
            ))
            yield* sessionPrompt.prompt({ sessionID: child.id, agent: "research-literature",
              model: yield* selectSessionModel(task.id, modelRef),
              parts: [{ type: "text", text: "Inspect the bound retrieval intents, then call literature_run to complete the Literature phase. Summarize the validated results briefly." }],
            }).pipe(Effect.onInterrupt(() => sessionPrompt.cancel(child.id)), Effect.catchCause(() => Effect.void))
          }))
          const messages = yield* session.messages({ sessionID: child.id })
          const receipt = yield* Effect.promise(() => recoverLiteratureReceipt(phase, messages.filter((message) => message.info.role === "assistant").flatMap((message) => message.parts)))
          return receipt ? { receipt, sessionID: child.id } : undefined
        }).pipe(Effect.ensuring(Effect.sync(release)))
      })

    const literatureLocks = new Map<ResearchTaskID, Semaphore.Semaphore>()
    const runRetrieveAgentUnlocked = logPhaseMethod("runRetrieveAgentUnlocked", Effect.fn("Research.runRetrieveAgent")(function* (input: RunRetrieveAgentInput) {
      yield* updateTaskStatus({ taskID: input.taskID, status: "literature" })
      yield* bus.publish(Event.LiteratureAgentStarted, { taskID: input.taskID, agent: "LiteratureAgent", stage: "literature", status: "started" })
      yield* bus.publish(Event.RetrieveAgentStarted, {
        taskID: input.taskID,
        agent: "RetrieveAgent",
        stage: "literature_retrieval",
        status: "started",
      })
      return yield* Effect.gen(function* () {
        const task = yield* getTask(input.taskID)
        const artifacts = yield* listArtifacts(input.taskID)
        const quantitativeArtifact = artifacts
          .find((item) => item.kind === "dataset_quantitative_analysis_json" && item.uri.startsWith("file://"))
        if (!quantitativeArtifact) {
          throw new Error(`Structured quantitative analysis was not created for task: ${input.taskID}`)
        }
        const runtime = recordValue(recordValue(task.taskSpec).runtime)
        const configuredNeoCastRoot = typeof runtime.neoCastProjectRoot === "string" && runtime.neoCastProjectRoot.trim()
          ? path.resolve(runtime.neoCastProjectRoot)
          : undefined
        const neoCastRoot = configuredNeoCastRoot ?? [
          path.resolve(Instance.directory),
          path.resolve(Instance.directory, "neo_cast"),
        ].find((candidate) => existsSync(path.join(candidate, "literature_knowledge"))) ?? path.resolve(Instance.directory, "neo_cast")
        if (configuredNeoCastRoot && !existsSync(neoCastRoot)) throw new Error(`Neo-Cast project root is unavailable: ${neoCastRoot}`)
        if (!existsSync(neoCastRoot)) yield* Effect.promise(() => mkdir(neoCastRoot, { recursive: true }))
        const progressBridge = yield* EffectBridge.make()
        const phase: LiteraturePhase = yield* Effect.promise(() => createLiteraturePhase({
          neoCastRoot, workspaceRoot: Instance.directory, taskID: task.id,
          run: { quantitativeReport: quantitativeArtifact.uri.slice(7), quantitativeReportArtifactID: quantitativeArtifact.id,
            taskContext: buildRetrieveTaskContext(task), force: input.force, budgets: input.budgets,
            maxCardsPerPaper: input.maxCardsPerPaper, catalogPath: input.catalogPath },
          onProgress: (progress) => progressBridge.promise(bus.publish(Event.LiteratureAgentProgress, {
            taskID: task.id, agent: "LiteratureAgent", runID: phase.snapshot.retrieveRunID, ...progress,
          })),
        }))
        const config = runtime.literatureSessionTools === true
          ? yield* Effect.promise(async () => (await resolveEffectiveLLMConfig({ workspaceRoot: Instance.directory, neoCastProjectRoot: neoCastRoot }))?.config)
          : undefined
        const modelRef = config ? mapToModelRef(config) : undefined
        const attempt = task.sessionID && modelRef
          ? yield* runLiteratureSession(task, phase, modelRef)
          : undefined
        const callPath = attempt ? "session_tool" : "direct"
        const directReason = attempt ? null : runtime.literatureSessionTools !== true ? "session_tools_disabled"
          : !config ? "llm_not_configured" : !modelRef ? "model_not_mapped" : "tool_not_started"
        const receipt = attempt?.receipt ?? (yield* abortable((signal) => phase.execute(signal)))
        const result = yield* Effect.promise(() => phase.validate(receipt))
        if (result.taskID !== task.id) throw new Error(`Quantitative report task mismatch: expected ${task.id}, received ${result.taskID}`)
        const paperTitles = new Map(phase.snapshot.index.documents.map((paper) => [paper.paperID, paper.title]))
        const sourceEntries = citableTaskEvidence(result.taskEvidence)
        const selectedCards = new Map(sourceEntries.map((entry) => [entry.cardID, entry]))
        const acceptedCardIDs = [...new Set([...result.literatureResults.flatMap((paper) => paper.acceptedCardIDs), ...sourceEntries.map((e) => e.cardID)])]
        const cardSummaries = (() => {
          if (acceptedCardIDs.length === 0) return sourceEntries.map((entry) => ({ cardID: entry.cardID,
            paperID: entry.paperID, cardType: entry.cardType, claim: entry.claim, confidence: entry.knowledge?.confidence ?? null, selected: true }))
          try {
            const knowledge = new KnowledgeV2Store(path.join(neoCastRoot, ".neo-cast", "literature-knowledge", "knowledge.db"))
            try {
              return acceptedCardIDs.map((cardID) => {
                const card = knowledge.getCard(cardID)
                const selected = selectedCards.get(cardID)
                return selected ? { cardID, paperID: selected.paperID, cardType: selected.cardType,
                  claim: selected.claim, confidence: selected.knowledge?.confidence ?? null, selected: true } : card ? { cardID, paperID: card.paperID,
                  cardType: "transferable_principle", claim: card.principle, confidence: card.confidence, selected: false } : undefined
              }).filter((card) => card !== undefined)
            } finally {
              knowledge.close()
            }
          } catch {
            return sourceEntries.map((entry) => ({ cardID: entry.cardID,
              paperID: entry.paperID, cardType: entry.cardType, claim: entry.claim, confidence: entry.knowledge?.confidence ?? null, selected: true }))
          }
        })()
        const displayMetadata = {
          paperSummaries: result.literatureResults
            .filter((paper) => paper.status !== "skipped_pdf_unavailable")
            .map((paper) => ({ paperID: paper.paperID, title: paperTitles.get(paper.paperID) ?? paper.paperID,
              status: paper.status, acceptedCardCount: paper.acceptedCardIDs.length })),
          cardSummaries,
        }
        const existingResultArtifact = artifacts.find((item) =>
          item.kind === "literature_retrieve_result_json" && recordValue(item.metadata).retrieveRunID === result.retrieveRunID,
        )
        const resultArtifact = existingResultArtifact ?? (yield* createArtifact({
          taskID: task.id,
          kind: "literature_retrieve_result_json",
          uri: `file://${path.join(neoCastRoot, ".neo-cast", "literature-retrieval", "runs", result.retrieveRunID, "retrieve_result.json")}`,
          metadata: {
            format: "json",
            schemaVersion: "retrieve_result_v2",
            retrieveRunID: result.retrieveRunID,
            quantitativeReportArtifactID: quantitativeArtifact.id,
          },
        }))
        const existingTaskEvidenceArtifact = artifacts.find((item) =>
          item.kind === "task_evidence_bundle_json" && recordValue(item.metadata).retrieveRunID === result.retrieveRunID,
        )
        const taskEvidenceArtifact = existingTaskEvidenceArtifact ?? (yield* createArtifact({
          taskID: task.id,
          kind: "task_evidence_bundle_json",
          uri: `file://${path.join(neoCastRoot, ".neo-cast", "literature-retrieval", "runs", result.retrieveRunID, "task_evidence_bundle.json")}`,
          metadata: {
            format: "json",
            schemaVersion: result.taskEvidence.schemaVersion,
            retrieveRunID: result.retrieveRunID,
            readiness: result.taskEvidence.readiness,
            selectedEntryCount: sourceEntries.length,
            uncoveredMustCoverIntentCount: result.taskEvidence.summary.uncoveredMustCoverIntentCount,
          },
        }))
        // Force/recovery may revise card selection without changing retrieveRunID.
        // Refresh the existing registration rather than leaving stale readiness/counts.
        yield* db((d) => d.update(ResearchArtifactTable).set({ time_updated: Date.now() })
          .where(eq(ResearchArtifactTable.id, resultArtifact.id)).run())
        yield* db((d) => d.update(ResearchArtifactTable).set({
          metadata: { ...taskEvidenceArtifact.metadata, phase: "literature", agent: "LiteratureAgent",
            callPath, sessionID: attempt?.sessionID ?? null, summary: result.summary, gapCount: result.taskEvidence.gaps.length,
            reason: directReason,
            ...displayMetadata,
            readiness: result.taskEvidence.readiness, selectedEntryCount: sourceEntries.length,
            uncoveredMustCoverIntentCount: result.taskEvidence.summary.uncoveredMustCoverIntentCount },
          time_updated: Date.now(),
        }).where(eq(ResearchArtifactTable.id, taskEvidenceArtifact.id)).run())
        yield* bus.publish(Event.RetrieveAgentCompleted, {
          taskID: task.id,
          agent: "RetrieveAgent",
          stage: "literature_retrieval",
          status: "completed",
          metadata: {
            retrieveRunID: result.retrieveRunID,
            artifactID: resultArtifact.id,
            taskEvidenceArtifactID: taskEvidenceArtifact.id,
            readiness: result.taskEvidence.readiness,
            ...result.summary,
          },
        })
        yield* bus.publish(Event.LiteratureAgentCompleted, {
          taskID: task.id, agent: "LiteratureAgent", stage: "literature", status: "completed",
          metadata: { retrieveRunID: result.retrieveRunID, resultArtifactID: resultArtifact.id,
            taskEvidenceArtifactID: taskEvidenceArtifact.id, readiness: result.taskEvidence.readiness,
            callPath, reason: directReason, sessionID: attempt?.sessionID ?? null, ...result.summary,
            ...displayMetadata,
            selectedEntryCount: sourceEntries.length, gapCount: result.taskEvidence.gaps.length },
        })
        return result
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* bus.publish(Event.LiteratureAgentFailed, {
              taskID: input.taskID, agent: "LiteratureAgent", stage: "literature", status: "failed",
              metadata: { code: "literature_phase_failed", message: "Literature execution or provenance validation failed", recoverable: false },
            })
            yield* bus.publish(Event.RetrieveAgentFailed, {
              taskID: input.taskID,
              agent: "RetrieveAgent",
              stage: "literature_retrieval",
              status: "failed",
              metadata: errorMetadata(Cause.squash(cause)),
            })
            return yield* Effect.failCause(cause)
          }),
        ),
      )
    }))

    const runRetrieveAgent = (input: RunRetrieveAgentInput) => Effect.suspend(() => {
      const lock = literatureLocks.get(input.taskID) ?? Semaphore.makeUnsafe(1)
      literatureLocks.set(input.taskID, lock)
      return lock.withPermits(1)(runRetrieveAgentUnlocked(input))
    })

    const loadDataAnalysisSummary = (taskID: ResearchTaskID) =>
      Effect.gen(function* () {
        const artifacts = yield* listArtifacts(taskID)
        const artifact = artifacts.find((a) => a.kind === "dataset_analysis_report")
        if (!artifact) return ""
        const filePath = artifact.uri.startsWith("file://") ? artifact.uri.slice(7) : undefined
        if (!filePath) return ""
        return yield* Effect.promise(() => readFile(filePath, "utf8").catch(() => ""))
      })

    const loadPlanningDataFacts = (taskID: ResearchTaskID) => Effect.gen(function* () {
      const artifact = (yield* listArtifacts(taskID)).find((a) => a.kind === "dataset_quantitative_analysis_json")
      if (!artifact?.uri.startsWith("file://")) return "No quantitative data artifact available; inspect the dataset analysis files if needed."
      return yield* Effect.promise(() => readFile(artifact.uri.slice(7), "utf8"))
    })

    const loadTaskEvidenceBundle = (taskID: ResearchTaskID, artifactID?: ResearchArtifactID) =>
      Effect.promise(() => loadTaskEvidenceForTask(taskID, artifactID))

	    const runHypoPlannerAgent = logPhaseMethod("runHypoPlannerAgent", Effect.fn("Research.runHypoPlannerAgent")(function* (input: {
	      readonly taskID: ResearchTaskID
	      readonly outputDir?: string
	      readonly taskEvidenceArtifactID?: ResearchArtifactID
	    }) {
      yield* assertExecutionCheckpoint(input.taskID, undefined, "hypoplanner")
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
	        const memory: ResearchMemory[] = []
        const existingHypothesesRaw = yield* db((d) =>
	          d.select().from(ResearchHypothesisTable).where(eq(ResearchHypothesisTable.task_id, input.taskID)).all(),
	        )
	        const existingHypotheses = existingHypothesesRaw.map((r) => ({ id: r.hypo_id, statement: r.statement, status: r.status }))
        const abandonedHypotheses = abandonedHypothesesFromMetadata(recordValue(task.taskSpec.metadata))
	        const dataAnalysisSummary = yield* loadPlanningDataFacts(input.taskID)
	        const taskEvidence = yield* loadTaskEvidenceBundle(input.taskID, input.taskEvidenceArtifactID)
	        const onDeltaHypo = (delta: string): void => {
	          void Effect.runPromise(
	            bus.publish(Event.HypoPlannerAgentStreamDelta, {
	              taskID: input.taskID,
	              agent: "HypoPlannerAgent",
	              delta,
	            }),
	          ).catch(() => undefined)
	        }
	        const hypoRuntime = recordValue(recordValue(task.taskSpec).runtime)
	        const hypoNeoCastRoot = typeof hypoRuntime.neoCastProjectRoot === "string" ? hypoRuntime.neoCastProjectRoot : undefined
	        const hypoLLMContext = yield* Effect.promise(() =>
	          resolveEffectiveLLMConfig({ workspaceRoot: Instance.directory, neoCastProjectRoot: hypoNeoCastRoot }),
	        )
	        const hypoConfig = hypoLLMContext?.config ?? (yield* Effect.promise(() =>
	          resolveNeoCastLLMConfig({ workspaceRoot: Instance.directory, neoCastProjectRoot: hypoNeoCastRoot }),
	        ))
	        const isFirstHypoPlannerCall = runs.length === 0 && existingHypotheses.length === 0
	        // referenceBaseline is only ever picked on the first call (see comment on
	        // ExperimentPlan.referenceBaseline) — only compute/offer options then.
	        const baselineOptions = isFirstHypoPlannerCall
	          ? DomainRegistry.buildBaselines(task.domainID, task.taskSpec)
	              .map((proposal) => {
	                const recipeID = candidateRecipeID(proposal.candidateSpec)
	                return recipeID === undefined ? undefined : { recipeID, description: proposal.rationale }
	              })
	              .filter((option): option is { recipeID: string; description: string } => option !== undefined)
	          : []
	        const evidenceArtifactID = input.taskEvidenceArtifactID ?? (yield* listArtifacts(task.id))
            .find((item) => item.kind === "task_evidence_bundle_json" && recordValue(item.metadata).retrieveRunID === taskEvidence?.retrieveRunID)?.id
	        yield* db((d) => d.update(ResearchTaskTable).set({
          task_spec: { ...task.taskSpec, metadata: { ...recordValue(task.taskSpec.metadata), nextExperiment: null } },
          time_updated: Date.now(),
        }).where(eq(ResearchTaskTable.id, task.id)).run())
        const hypoSessionAttempt = yield* requestViaSession({
	          evidenceBinding: { taskID: task.id, artifactID: evidenceArtifactID },
	          rootSessionID: task.sessionID,
	          agent: "research-hypo-planner",
	          stageLabel: "HypoPlanner",
	          taskID: task.id,
	          user: buildHypoPlannerUserPrompt(task, dataAnalysisSummary, existingHypotheses, abandonedHypotheses, taskEvidence, { sessionMode: true, baselineOptions }),
	          modelRef: mapToModelRef(hypoConfig),
	          onDelta: (delta) => bus.publish(Event.HypoPlannerAgentStreamDelta, { taskID: task.id, agent: "HypoPlannerAgent", delta }),
          onPartUpdated: (part) => {
            if (part.type === "text") {
              return bus.publish(Event.HypoPlannerAgentPartUpdated, {
                taskID: task.id,
                agent: "HypoPlannerAgent",
                partID: part.id,
                kind: "text",
                text: part.text,
              })
            }
            if (part.type === "tool") {
              const s = part.state
              return bus.publish(Event.HypoPlannerAgentPartUpdated, {
                taskID: task.id,
                agent: "HypoPlannerAgent",
                partID: part.id,
                kind: "tool",
                toolName: part.tool,
                toolInput: s.status !== "pending" ? s.input : undefined,
                toolOutput: s.status === "completed" ? s.output : undefined,
                toolState: s.status === "error" ? "error" : s.status === "completed" ? "completed" : s.status === "running" ? "running" : "pending",
                toolDurationMs: s.status === "completed" ? s.time.end - s.time.start : undefined,
                toolError: s.status === "error" ? s.error : undefined,
              })
            }
            return Effect.void
          },
	        })
	        const hypoCallPath: "session" | "direct" = hypoSessionAttempt ? "session" : "direct"
	        logLLMCallPath("HypoPlanner", task.id, hypoCallPath)
	        yield* bus.publish(Event.LLMCallPath, { taskID: task.id, agent: "HypoPlanner", path: hypoCallPath })
	        const llmHypothesesResult = hypoSessionAttempt
	          ? undefined
	          : yield* Effect.promise(() =>
	              generateLLMHypotheses(task, dataAnalysisSummary, Instance.directory, onDeltaHypo, existingHypotheses, abandonedHypotheses, taskEvidence),
	            )
	        const llmHypoUsage = hypoSessionAttempt ? hypoSessionAttempt.usage : llmHypothesesResult?.usage
	        // Session mode: agent used hypothesis_* tools to write to DB; read current pool state.
	        const sessionPoolHypotheses = hypoSessionAttempt
	          ? (yield* listHypotheses(input.taskID)).filter((h) => h.status !== "abandoned")
	          : undefined
	        // The pick_baseline tool (if called during the session) wrote referenceBaseline/
	        // referenceBaselineSource/referenceBaselineRationale straight to task_spec.metadata —
	        // re-fetch to pick that up. No baseline is inferred when the tool was not called.
	        const refreshedTask = hypoSessionAttempt ? yield* getTask(input.taskID) : task
	        const refreshedMetadata = recordValue(refreshedTask.taskSpec.metadata)
	        const toolReferenceBaseline =
	          typeof refreshedMetadata.referenceBaseline === "string" ? refreshedMetadata.referenceBaseline : undefined
	        const toolReferenceBaselineRationale =
	          typeof refreshedMetadata.referenceBaselineRationale === "string"
	            ? refreshedMetadata.referenceBaselineRationale
	            : undefined
	        const nextExperiment = hypoSessionAttempt
          ? parseNextExperiment(refreshedMetadata.nextExperiment)
          : llmHypothesesResult?.nextExperiment
        if (hypoSessionAttempt && !nextExperiment) throw new Error("HypoPlanner must explicitly call hypothesis_select before the next experiment")
        if (nextExperiment?.action === "experiment" && !sessionPoolHypotheses?.some((h) => h.id === nextExperiment.hypothesisID && isOpenHypothesis(h)) && hypoSessionAttempt)
          throw new Error(`HypoPlanner selection is no longer open: ${nextExperiment.hypothesisID}`)
        let result = buildHypoPlannerResult({
	          task,
	          dataAnalysisSummary,
	          runs,
	          memory,
	          taskEvidence,
	          llmHypotheses: sessionPoolHypotheses ?? llmHypothesesResult?.hypotheses,
	          toolReferenceBaseline,
              nextExperiment,
	        })

        if (!(hypoSessionAttempt && result.llm.status === "used")) {
          // Direct planners reuse labels such as H1 across rounds. Version changed
          // definitions before writing artifacts so YAML, events and DB agree.
          const boundIDs = new Set((yield* listCandidates(task.id)).map((candidate) => candidate.hypothesisID))
          const pool = yield* listHypotheses(task.id)
          const bound = new Map(pool.filter((h) => boundIDs.has(h.id)).map((h) => [h.id, h]))
          const hypotheses = result.plan.hypotheses.map((h) => {
            const previous = bound.get(h.id)
            return previous && hypothesisDefinitionDigest(previous) !== hypothesisDefinitionDigest(h)
              ? { ...h, id: `${h.id}_${ResearchHypothesisID.ascending()}` }
              : h
          })
          const decision = result.plan.nextExperiment
          const chosenIndex = decision?.action === "experiment" ? result.plan.hypotheses.findIndex((h) => h.id === decision.hypothesisID) : -1
          const plan = { ...result.plan, hypotheses, ...(chosenIndex >= 0 ? { nextExperiment: { ...decision!, action: "experiment" as const, hypothesisID: hypotheses[chosenIndex]!.id } } : {}) }
          result = { ...result, plan, hypothesesYaml: buildHypothesesYaml(plan, taskEvidence?.readiness) }
          result = { ...result, planMarkdown: buildHypoPlanMarkdown(result) }
        }
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
	            ...(evidenceArtifactID === undefined ? {} : { taskEvidenceArtifactID: evidenceArtifactID }),
	            literatureReadiness: taskEvidence?.readiness ?? "ready_data_only",
	            hypothesisCount: result.plan.hypotheses.length,
	            baselineStrategy: result.plan.baselineStrategy,
	            ...(result.plan.referenceBaseline === undefined ? {} : { referenceBaseline: result.plan.referenceBaseline }),
	            ...(result.plan.referenceBaselineSource === undefined ? {} : { referenceBaselineSource: result.plan.referenceBaselineSource }),
	            ...(toolReferenceBaselineRationale ? { referenceBaselineRationale: toolReferenceBaselineRationale } : {}),
	            llmStatus: result.llm.status,
	            ...(result.llm.status === "used" && result.plan.hypotheses.length > 0
	              ? {
	                  llmPreview: result.plan.hypotheses
	                    .map((h) => h.statement)
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
	            ...(evidenceArtifactID === undefined ? {} : { taskEvidenceArtifactID: evidenceArtifactID }),
	            literatureReadiness: taskEvidence?.readiness ?? "ready_data_only",
	            hypothesisCount: result.plan.hypotheses.length,
	            baselineStrategy: result.plan.baselineStrategy,
	            ...(result.plan.referenceBaseline === undefined ? {} : { referenceBaseline: result.plan.referenceBaseline }),
	            ...(result.plan.referenceBaselineSource === undefined ? {} : { referenceBaselineSource: result.plan.referenceBaselineSource }),
	            ...(toolReferenceBaselineRationale ? { referenceBaselineRationale: toolReferenceBaselineRationale } : {}),
	          },
	        })
	        if (hypoSessionAttempt && result.llm.status === "used") {
	          // Session mode: hypothesis rows managed by tools — update task metadata only.
	          const t = yield* getTask(input.taskID)
	          const meta = recordValue(t.taskSpec.metadata)
	          const nextTaskSpec = {
	            ...t.taskSpec,
	            metadata: {
	              ...meta,
	              baselineStrategy: result.plan.baselineStrategy,
	              searchBiases: result.plan.searchBiases,
	              stopConditions: result.plan.stopConditions,
              nextExperiment: result.plan.nextExperiment as unknown as JsonRecord ?? null,
	              ...(result.plan.referenceBaseline === undefined
	                ? {}
	                : { referenceBaseline: result.plan.referenceBaseline }),
	              ...(result.plan.referenceBaselineSource === undefined
	                ? {}
	                : { referenceBaselineSource: result.plan.referenceBaselineSource }),
	            } as unknown as JsonRecord,
	          }
	          const taskRow = yield* db((d) =>
	            d
	              .update(ResearchTaskTable)
	              .set({ task_spec: nextTaskSpec, time_updated: Date.now() })
	              .where(and(eq(ResearchTaskTable.id, input.taskID), eq(ResearchTaskTable.project_id, Instance.project.id)))
	              .returning()
	              .get(),
	          )
	          if (taskRow) yield* bus.publish(Event.TaskUpdated, { task: mapTask(taskRow) })
	        } else {
	          // Direct mode: replace unbound proposals, retaining candidate-bound snapshots.
	          const nextHypothesisStatements = new Set(result.plan.hypotheses.map((h) => h.statement))
	          const newlyAbandoned = existingHypotheses
	            .filter((h) => !nextHypothesisStatements.has(h.statement) && h.id !== recordValue(recordValue(task.taskSpec.metadata).designFeedback).hypothesisID)
	            .map((h) => ({ statement: h.statement }))
	          const mergedAbandoned = [...abandonedHypotheses, ...newlyAbandoned]
	            .filter((h, index, all) => all.findIndex((other) => other.statement === h.statement) === index)
	            .slice(-MAX_ABANDONED_HYPOTHESES)
	          yield* updateTaskHypothesisPlan({
	            taskID: input.taskID,
	            hypothesisPlan: result.plan,
	            abandonedHypotheses: mergedAbandoned,
	          })
	        }
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
	            ...(result.plan.referenceBaseline === undefined ? {} : { referenceBaseline: result.plan.referenceBaseline }),
	            ...(result.plan.referenceBaselineSource === undefined ? {} : { referenceBaselineSource: result.plan.referenceBaselineSource }),
	            ...(toolReferenceBaselineRationale ? { referenceBaselineRationale: toolReferenceBaselineRationale } : {}),
	            llmStatus: result.llm.status,
	            ...(result.llm.status === "used" && result.plan.hypotheses.length > 0
	              ? {
	                  llmPreview: result.plan.hypotheses
	                    .map((h) => h.statement)
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
	    }))

	    const runNASAgent = logPhaseMethod("runNASAgent", Effect.fn("Research.runNASAgent")(function* (input: AutonomousLoopInput) {
      yield* assertExecutionCheckpoint(input.taskID)
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
	        const taskFp = DomainRegistry.summarizeTask(task.domainID, task.taskSpec, { taskID: task.id, projectRoot: Instance.directory, workspaceRoot: taskExecutionRoot(task, Instance.directory) })
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
            if (PipelineBlockedError.isInstance(error)) return yield* Effect.failCause(cause)
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
    }))
	    const runVerifierAgent = logPhaseMethod("runVerifierAgent", Effect.fn("Research.runVerifierAgent")(function* (input: VerifierAgentRunInput) {
      yield* assertExecutionCheckpoint(input.taskID, undefined, "verifier")
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
	    }))

	    const runReflectionAgent = logPhaseMethod("runReflectionAgent", Effect.fn("Research.runReflectionAgent")(function* (input: ReflectionAgentInput) {
      yield* assertExecutionCheckpoint(input.taskID, undefined, "reflection")
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
	        const artifacts = yield* listArtifacts(input.taskID)
	        const memories = yield* listMemory(input.taskID)
	        const evidenceRuns = yield* Effect.promise(() => Promise.all(runs.map(async (storedRun) => {
	          const run = reflectionExecutionEvidence(storedRun, objectiveMetricName(task.objective))
	          if (run.status === "succeeded") return run
	          const artifact = artifacts.find((a) => a.runID === run.id && a.kind === "runner_execution_log_json")
	          if (!artifact) return run
	          const error = await recoverRunnerFailure(artifact.uri.replace(/^file:\/\//, ""), run.error)
	          return { ...run, error }
	        })))
	        const baseResult = summarizeReflectionAgent({
	          task,
	          runs: evidenceRuns,
	          candidates,
	          champion,
	          stoppedReason: input.stoppedReason,
	          maxIterations: input.maxIterations,
	        })

	        // Minimal context: find latest candidate for current hypothesis (pure in-memory, no I/O).
	        const orderedRuns = [...evidenceRuns].sort((a, b) => a.time.created - b.time.created)
	        const latestRun = orderedRuns[orderedRuns.length - 1]
	        const latestRunForContext = latestRun
	        const latestCandidate = latestRunForContext?.candidateID
	          ? candidates.find((c) => c.id === latestRunForContext.candidateID)
	          : undefined

	        const reflectionRuntime = recordValue(recordValue(task.taskSpec).runtime)
	        const reflectionNeoCastRoot =
	          typeof reflectionRuntime.neoCastProjectRoot === "string" ? reflectionRuntime.neoCastProjectRoot : undefined
	        const reflectionLLMContext = yield* Effect.promise(() =>
	          resolveEffectiveLLMConfig({ workspaceRoot: Instance.directory, neoCastProjectRoot: reflectionNeoCastRoot }),
	        )
	        const reflectionConfig = reflectionLLMContext?.config ?? (yield* Effect.promise(() =>
	          resolveNeoCastLLMConfig({ workspaceRoot: Instance.directory, neoCastProjectRoot: reflectionNeoCastRoot }),
	        ))
            const reflectionKnowledge = yield* Effect.promise(() => readReflectionKnowledge(task.id))
	        const reflectionSessionAttempt = yield* requestViaSession({
	          rootSessionID: task.sessionID,
	          agent: "research-reflection",
	          stageLabel: "Reflection",
	          taskID: task.id,
	          user: buildReflectionSessionUserPrompt(task, baseResult.analysis, latestCandidate?.rationale || undefined, baseResult.maxIterations),
	          modelRef: mapToModelRef(reflectionConfig),
	          onDelta: (delta) => bus.publish(Event.ReflectionAgentStreamDelta, { taskID: task.id, agent: "ReflectionAgent", delta }),
	          onPartUpdated: (part) => {
	            if (part.type === "text") {
	              return bus.publish(Event.ReflectionAgentPartUpdated, {
	                taskID: task.id, agent: "ReflectionAgent", partID: part.id, kind: "text", text: part.text,
	              })
	            }
	            if (part.type === "tool") {
	              const s = part.state
	              return bus.publish(Event.ReflectionAgentPartUpdated, {
	                taskID: task.id, agent: "ReflectionAgent", partID: part.id, kind: "tool",
	                toolName: part.tool,
	                toolInput: s.status !== "pending" ? s.input : undefined,
	                toolOutput: s.status === "completed" ? s.output : undefined,
	                toolState: s.status === "error" ? "error" : s.status === "completed" ? "completed" : s.status === "running" ? "running" : "pending",
	                toolDurationMs: s.status === "completed" ? s.time.end - s.time.start : undefined,
	                toolError: s.status === "error" ? s.error : undefined,
	              })
	            }
	            return Effect.void
	          },
	        })
	        const reflectionCallPath: "session" | "direct" = reflectionSessionAttempt ? "session" : "direct"
	        logLLMCallPath("Reflection", task.id, reflectionCallPath)
	        yield* bus.publish(Event.LLMCallPath, { taskID: task.id, agent: "Reflection", path: reflectionCallPath })
	        // Direct-path fallback: lazily build full LLM context (training curve + memories) for
	        // the non-session code path that calls the LLM API directly without tool access.
	        const synthesis = reflectionSessionAttempt
	          ? buildReflectionResultFromText(baseResult, reflectionConfig.model, reflectionSessionAttempt.text, reflectionSessionAttempt.usage)
	          : yield* Effect.promise(async () => {
	              const progressArtifact = latestRunForContext
	                ? artifacts.find((a) => a.kind === "runner_progress_jsonl" && a.runID === latestRunForContext.id)
	                : undefined
	              const trainingCurve = await (async () => {
	                if (!progressArtifact) return []
	                const filePath = progressArtifact.uri.startsWith("file://")
	                  ? progressArtifact.uri.slice("file://".length)
	                  : progressArtifact.uri
	                return extractTrainingCurve(filePath)
	              })()
	              const sortedMemories = [...memories].sort((a, b) => b.time.created - a.time.created)
	              const recentLessons = sortedMemories.slice(0, 2).map((m) => m.lesson)
	              const reflDir = baseResult.analysis.direction
	              let bestMemory: (typeof sortedMemories)[0] | undefined
	              let bestMemoryMetric: number | undefined
	              for (const m of sortedMemories) {
	                const ms = recordValue(m.candidateSummary).bestMetric
	                const mv = typeof ms === "number" && Number.isFinite(ms) ? ms : undefined
	                if (mv === undefined) continue
	                if (bestMemoryMetric === undefined || (reflDir === "minimize" ? mv < bestMemoryMetric : mv > bestMemoryMetric)) {
	                  bestMemoryMetric = mv
	                  bestMemory = m
	                }
	              }
	              const objectiveRecord = recordValue(task.objective)
	              const taskObjective = [
	                `${reflDir === "minimize" ? "Minimize" : "Maximize"} ${baseResult.analysis.primaryMetricName}`,
	                typeof objectiveRecord.targetMetricValue === "number" ? `target ≤ ${objectiveRecord.targetMetricValue}` : null,
	                typeof objectiveRecord.description === "string" ? objectiveRecord.description : null,
	              ].filter(Boolean).join(". ")
	              const llmContext: ReflectionLLMContext = {
	                taskSpec: task.taskSpec,
	                taskObjective,
	                maxIterations: baseResult.maxIterations,
	                currentHypothesis: latestCandidate?.rationale || undefined,
	                experimentDesign: latestCandidate?.candidateSpec,
                executedModel: recordValue(recordValue(latestRunForContext?.resourceUsage.executionContract).manifest).actual,
	                trainingCurve,
	                recentMemories: recentLessons,
	                bestMemoryLesson: bestMemory && bestMemory.id !== sortedMemories[0]?.id && bestMemory.id !== sortedMemories[1]?.id
	                  ? bestMemory.lesson : undefined,
                  sourceRuns: (await readDesignHistory(task.id, { limit: 20 }, { forReflection: true })).runs,
                  experiences: readExperiences(task.id, { limit: 12 }).map(experiencePromptRecord),
                  literatureKnowledge: reflectionKnowledge,
	              }
	              return generateLLMReflectionSynthesis(task, baseResult, llmContext).catch(() => ({
	                ...baseResult, llm: { status: 'failed' as const },
	              }))
	            })
            const experienceWriteResults: { saved: boolean; id?: string; error?: string }[] = []
            if (reflectionSessionAttempt) {
              const previousIDs = new Set(memories.map((memory) => memory.id))
              for (const memory of readExperiences(task.id, { scope: "task", limit: 100 })) {
                if (!previousIDs.has(memory.id)) experienceWriteResults.push({ saved: true, id: memory.id })
              }
            }
            if (!reflectionSessionAttempt && synthesis.llm.status === "used") {
              for (const draft of synthesis.llm.structured?.experienceWrites ?? []) {
                const written = yield* Effect.promise(async () => {
                  try {
                    const result = await writeExperience(task.id, draft)
                    return { saved: true, id: result.memory.id }
                  } catch (error) {
                    return { saved: false, error: error instanceof Error ? error.message : String(error) }
                  }
                })
                experienceWriteResults.push(written)
              }
            }
            const knowledgeValidationResults: NonNullable<ReflectionAgentResult["knowledgeValidationResults"]>[number][] = []
            if (!reflectionSessionAttempt && synthesis.llm.status === "used") {
              for (const draft of synthesis.llm.structured?.knowledgeValidations ?? []) {
                knowledgeValidationResults.push(yield* Effect.promise(async () => {
                  try {
                    const confirmed = await confirmKnowledgeExperiment(task.id, draft)
                    return { saved: true, cardID: draft.cardID, updated: confirmed.updated, confidence: confirmed.confidence }
                  } catch (error) {
                    return { saved: false, cardID: draft.cardID, error: error instanceof Error ? error.message : String(error) }
                  }
                }))
              }
            } else if (reflectionSessionAttempt) {
              const previous = new Set(reflectionKnowledge.entries.flatMap((e) => e.knowledge.experimentValidations.map((v) => v.validationID)))
              const current = yield* Effect.promise(() => readReflectionKnowledge(task.id))
              for (const entry of current.entries) {
                if (entry.knowledge.experimentValidations.some((v) => v.taskID === task.id && v.runID === latestRun?.id && !previous.has(v.validationID))) {
                  knowledgeValidationResults.push({ saved: true, cardID: entry.cardID, updated: true, confidence: entry.confidence })
                }
              }
            }
            const result: ReflectionAgentResult = { ...synthesis, experienceWriteResults, knowledgeValidationResults }
	        const reflectRunId = `reflect_${Date.now()}`
	        const directory = input.outputDir
	          ? path.join(runnerPath(Instance.directory, input.outputDir), task.id, reflectRunId)
	          : path.join(Instance.directory, ".neo-research", "sessions", task.id, reflectRunId)
	        const notesPath = path.join(directory, "reflection_notes.md")
	        const planPath = path.join(directory, "next_experiment_plan.md")
	        const failureLogPath = path.join(directory, "failure_log.md")
	        const resultJsonPath = path.join(directory, "reflection_result.json")
	        yield* Effect.promise(async () => {
	          await mkdir(directory, { recursive: true })
	          await writeFile(notesPath, result.reflectionNotesMarkdown, "utf8")
	          await writeFile(planPath, result.nextExperimentPlanMarkdown, "utf8")
	          await writeFile(failureLogPath, result.failureLogMarkdown, "utf8")
	          await writeFile(
	            resultJsonPath,
	            JSON.stringify({
	              reflectRunId,
	              taskID: task.id,
	              decision: result.analysis.decision,
	              decisionReason: result.analysis.decisionReason,
	              plateauStreak: result.analysis.plateauStreak,
	              succeededRuns: result.analysis.succeededRuns,
	              inconclusiveRuns: result.analysis.inconclusiveRuns,
	              failedRuns: result.analysis.failedRuns,
	              bestMetric: result.analysis.bestMetric ?? null,
	              reflectionNotesMarkdown: result.reflectionNotesMarkdown,
	              nextExperimentPlanMarkdown: result.nextExperimentPlanMarkdown,
	              failureLogMarkdown: result.failureLogMarkdown,
	              maxIterations: result.maxIterations,
	              llm: result.llm,
                  experienceWriteResults: result.experienceWriteResults,
                  knowledgeValidationResults: result.knowledgeValidationResults,
	            }, null, 2),
	            "utf8",
	          )
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
	              ? { llmNarrative: result.llm.text }
	              : {}),
	            reflectionNotesArtifactID: notesArtifact.id,
	            nextExperimentPlanArtifactID: planArtifact.id,
	            failureLogArtifactID: failureLogArtifact.id,
	          },
	        })
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
	    }))

	    const runPublishAgent = logPhaseMethod("runPublishAgent", Effect.fn("Research.runPublishAgent")(function* (input: ExportTaskArtifactInput) {
      yield* assertExecutionCheckpoint(input.taskID, undefined, "publish")
      yield* updateTaskStatus({ taskID: input.taskID, status: "publishing" })
      yield* bus.publish(Event.PublishAgentStarted, {
        taskID: input.taskID,
        agent: "PublishAgent",
	        stage: "publishing",
	        status: "started",
	      })
	      return yield* Effect.gen(function* () {
	        // A formal publish is only valid after the frozen champion has a successful ref_test.
	        const publishChampion = yield* getChampion(input.taskID)
	        if (publishChampion === undefined) throw new Error("PublishAgent requires a champion")
	        let publishRuns = yield* listRuns(input.taskID)
	        let publishRefTestRun = publishRuns.find(
	          (run) =>
	            run.candidateID === publishChampion.candidateID &&
	            run.stage === "ref_test" &&
	            run.status === "succeeded",
	        )
	        if (publishRefTestRun === undefined) {
          const task = yield* getTask(input.taskID)
          const approvals = yield* listApprovals({ taskID: input.taskID })
          const existing = approvals.find((approval) => approval.kind === "ref_test" && approval.candidateID === publishChampion.candidateID)
          if (existing?.status === "rejected") throw new PipelineBlockedError({ taskID: input.taskID, reason: "human_checkpoint_rejected" })
          const approval = existing ?? (yield* createApproval({ taskID: input.taskID, candidateID: publishChampion.candidateID, kind: "ref_test", reason: "Reference test required for final publication." }))
          if (approval.status !== "approved") {
            yield* replyApproval({ approvalID: approval.id, status: "approved", replyMessage: "Approved by the existing autonomous publication policy." })
          }
	          const currentArtifacts = yield* listArtifacts(input.taskID)
	          const championRunnerArtifact = currentArtifacts.find(
	            (artifact) => artifact.kind === "runner_artifact" && artifact.runID === publishChampion.runID,
	          )
	          yield* executeRun({
	            taskID: input.taskID,
	            candidateID: publishChampion.candidateID,
	            stage: "ref_test",
	            description: "Final reference test by PublishAgent.",
	            runnerRunID:
	              championRunnerArtifact === undefined
	                ? undefined
	                : neoCastRunIDFromArtifactURI(championRunnerArtifact.uri),
	          })
	          publishRuns = yield* listRuns(input.taskID)
	          publishRefTestRun = publishRuns.find(
	            (run) =>
	              run.candidateID === publishChampion.candidateID &&
	              run.stage === "ref_test" &&
	              run.status === "succeeded",
	          )
	        }
	        if (publishRefTestRun === undefined) throw new Error("Champion ref_test did not succeed; formal publish aborted")

	        const publishTask = yield* getTask(input.taskID)
	        const publishCandidates = yield* listCandidates(input.taskID)
	        const publishCandidate = publishCandidates.find((candidate) => candidate.id === publishChampion.candidateID)
	        if (publishCandidate === undefined) throw new Error("PublishAgent champion candidate is missing")
	        const publishApprovals = yield* listApprovals({ taskID: input.taskID })
	        const publishArtifacts = yield* listArtifacts(input.taskID)
	        const publishMemories = yield* listMemory(input.taskID)
	        const reportSnapshot = buildPublishReportSnapshot({
	          task: publishTask,
	          champion: publishChampion,
	          championCandidate: publishCandidate,
	          refTestRun: publishRefTestRun,
	          candidates: publishCandidates,
	          runs: publishRuns,
	          approvals: publishApprovals,
	          artifacts: publishArtifacts,
	          memories: publishMemories,
	        })
	        const publishDirectory = path.join(Instance.directory, ".neo-research", "sessions", publishTask.id, "publish")
	        const reportInputPath = path.join(publishDirectory, "report_input.json")
	        const finalReportPath = path.join(publishDirectory, "final_report.md")
	        const validationPath = path.join(publishDirectory, "report_validation.json")
	        const publishTracePath = path.join(publishDirectory, "publish_trace.json")
	        const existingFinalReport = publishArtifacts.find(
	          (artifact) =>
	            artifact.kind === "final_report_md" &&
	            artifact.metadata.inputDigest === reportSnapshot.digest &&
	            artifact.metadata.validationStatus === "passed" &&
	            filePathFromURI(artifact.uri) !== undefined &&
	            existsSync(filePathFromURI(artifact.uri)!),
	        )
	        let finalReportArtifact = existingFinalReport
	        let reportCallPath = String(existingFinalReport?.metadata.callPath ?? "reused")
	        let validationStatus = String(existingFinalReport?.metadata.validationStatus ?? "passed")
	        let inputSnapshotArtifactID = String(existingFinalReport?.metadata.inputSnapshotArtifactID ?? "")
	        if (finalReportArtifact === undefined) {
	          yield* Effect.promise(async () => {
	            await mkdir(publishDirectory, { recursive: true })
	            await writeFile(reportInputPath, `${JSON.stringify(reportSnapshot, null, 2)}\n`, "utf8")
	          })
	          const inputArtifact = yield* createArtifact({
	            taskID: publishTask.id,
	            runID: publishRefTestRun.id,
	            kind: "publish_report_input_snapshot_json",
	            uri: `file://${reportInputPath}`,
	            metadata: { format: "json", inputDigest: reportSnapshot.digest, championRunID: publishChampion.runID, refTestRunID: publishRefTestRun.id },
	          })
	          inputSnapshotArtifactID = inputArtifact.id
	          const publishRuntime = recordValue(recordValue(publishTask.taskSpec).runtime)
	          const publishNeoCastRoot =
	            typeof publishRuntime.neoCastProjectRoot === "string" ? publishRuntime.neoCastProjectRoot : undefined
	          const publishLLMContext = yield* Effect.promise(() =>
	            resolveEffectiveLLMConfig({ workspaceRoot: Instance.directory, neoCastProjectRoot: publishNeoCastRoot }),
	          )
	          const publishConfig = publishLLMContext?.config ?? (yield* Effect.promise(() =>
	            resolveNeoCastLLMConfig({ workspaceRoot: Instance.directory, neoCastProjectRoot: publishNeoCastRoot }),
	          ))
	          const sessionReport = yield* requestViaSession({
	            rootSessionID: publishTask.sessionID,
	            agent: "research-publish",
	            stageLabel: "PublishReport",
	            taskID: publishTask.id,
	            user: buildPublishReportPrompt(reportSnapshot),
	            modelRef: mapToModelRef(publishConfig),
	          })
	          let report = sessionReport ? stripMarkdownFence(sessionReport.text) : renderDeterministicFinalReport(reportSnapshot)
	          let validationErrors = validateFinalReport(report, reportSnapshot)
	          reportCallPath = sessionReport ? "session" : "deterministic"
	          if (validationErrors.length > 0) {
	            report = renderDeterministicFinalReport(reportSnapshot)
	            validationErrors = validateFinalReport(report, reportSnapshot)
	            reportCallPath = "deterministic"
	            validationStatus = "degraded"
	          } else {
	            validationStatus = "passed"
	          }
	          yield* Effect.promise(async () => {
	            await writeFile(finalReportPath, report, "utf8")
	            await writeFile(validationPath, `${JSON.stringify({ status: validationStatus, errors: validationErrors }, null, 2)}\n`, "utf8")
	            await writeFile(publishTracePath, `${JSON.stringify({
	              schemaVersion: "neo_research_publish_agent_trace.v1",
	              taskID: publishTask.id,
	              championRunID: publishChampion.runID,
	              refTestRunID: publishRefTestRun.id,
	              inputDigest: reportSnapshot.digest,
	              callPath: reportCallPath,
	              validationStatus,
	            }, null, 2)}\n`, "utf8")
	          })
	          yield* createArtifact({
	            taskID: publishTask.id,
	            runID: publishRefTestRun.id,
	            kind: "report_validation_json",
	            uri: `file://${validationPath}`,
	            metadata: { format: "json", status: validationStatus, inputSnapshotArtifactID },
	          })
	          finalReportArtifact = yield* createArtifact({
	            taskID: publishTask.id,
	            runID: publishRefTestRun.id,
	            kind: "final_report_md",
	            uri: `file://${finalReportPath}`,
	            metadata: {
	              format: "markdown",
	              generator: "publish-agent",
	              callPath: reportCallPath,
	              inputDigest: reportSnapshot.digest,
	              inputSnapshotArtifactID,
	              validationStatus,
	              championRunID: publishChampion.runID,
	              refTestRunID: publishRefTestRun.id,
	            },
	          })
	          yield* createArtifact({
	            taskID: publishTask.id,
	            runID: publishRefTestRun.id,
	            kind: "publish_agent_trace_json",
	            uri: `file://${publishTracePath}`,
	            metadata: { format: "json", inputSnapshotArtifactID, finalReportArtifactID: finalReportArtifact.id },
	          })
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
	            refTestRunID: publishRefTestRun.id,
	            finalReportArtifactID: finalReportArtifact.id,
	            inputSnapshotArtifactID,
	            callPath: reportCallPath,
	            validationStatus,
	            reportPath: finalReportArtifact.uri,
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
	    }))

    const runFullPipeline: (input: RunFullPipelineInput) => Effect.Effect<RunFullPipelineResult> = logPhaseMethod("runFullPipeline", Effect.fn(
      "Research.runFullPipeline",
    )(function* (input: RunFullPipelineInput) {
      const initialTask = yield* getTask(input.taskID)
      yield* resumeExecutionContractCheckpoint(input.taskID)
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

      const recoverRetrieveResult = (task: ResearchTask) =>
        Effect.gen(function* () {
          const artifacts = yield* listArtifacts(task.id)
          const resultArtifact = artifacts.find((item) =>
            item.kind === "literature_retrieve_result_json" && recordValue(item.metadata).schemaVersion === "retrieve_result_v2",
          )
          if (!resultArtifact) throw new Error(`Missing retrieve_result_v2 artifact for task: ${task.id}`)
          const resultPath = filePathFromURI(resultArtifact.uri)
          if (!resultPath) throw new Error(`Invalid retrieve result artifact URI for task: ${task.id}`)
          const result = yield* Effect.promise(() =>
            readFile(resultPath, "utf8").then((text) => RetrieveResultSchema.parse(JSON.parse(text))),
          )
          if (result.taskID !== task.id) throw new Error(`Retrieve result task mismatch: expected ${task.id}, received ${result.taskID}`)
          const quantitativeArtifact = artifacts.find((item) => item.kind === "dataset_quantitative_analysis_json")
          if (!quantitativeArtifact || quantitativeArtifact.id !== result.quantitativeReportArtifactID) {
            throw new Error(`Retrieve result quantitative artifact mismatch for task: ${task.id}`)
          }
          const taskEvidenceArtifact = artifacts.find((item) =>
            item.kind === "task_evidence_bundle_json" && recordValue(item.metadata).retrieveRunID === result.retrieveRunID,
          )
          if (!taskEvidenceArtifact) throw new Error(`Missing task evidence artifact for retrieve run: ${result.retrieveRunID}`)
          const taskEvidence = yield* loadTaskEvidenceBundle(task.id, taskEvidenceArtifact.id)
          if (!taskEvidence || taskEvidence.retrieveRunID !== result.retrieveRunID ||
              taskEvidence.quantitativeReportArtifactID !== result.quantitativeReportArtifactID ||
              taskEvidence.taskContextDigest !== taskContextDigest(buildRetrieveTaskContext(task)) ||
              JSON.stringify(taskEvidence) !== JSON.stringify(result.taskEvidence)) {
            throw new Error(`Task evidence provenance mismatch for retrieve run: ${result.retrieveRunID}`)
          }
          return result
        })

      const recoverHypoPlanning = (task: ResearchTask, taskEvidenceArtifactID: ResearchArtifactID) =>
        Effect.gen(function* () {
          const dataAnalysisSummary = yield* loadDataAnalysisSummary(task.id)
          const taskEvidence = yield* loadTaskEvidenceBundle(task.id, taskEvidenceArtifactID)
          const hypotheses = yield* listHypotheses(task.id)
          const plan = experimentPlanFromDB(task, hypotheses)
          if (plan !== undefined) {
            validateHypothesisEvidence(hypotheses, taskEvidence)
            return recoverHypoPlannerResultFromPlan({ task, dataAnalysisSummary, plan, taskEvidence })
          }
          const runs = yield* listRuns(input.taskID)
          const memory: ResearchMemory[] = []
          return buildHypoPlannerResult({ task, dataAnalysisSummary, runs, memory, taskEvidence })
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
          const taskFingerprint = DomainRegistry.summarizeTask(task.domainID, task.taskSpec, { taskID: task.id, projectRoot: Instance.directory, workspaceRoot: taskExecutionRoot(task, Instance.directory) })
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
          // The markdown artifacts above don't carry the LLM output — read it from the persisted
          // reflection_result.json of the most recent reflect_* run instead of recomputing it.
          const persistedLLM = yield* Effect.promise(async (): Promise<ReflectionAgentResult["llm"] | undefined> => {
            try {
              const sessionsDir = path.join(Instance.directory, ".neo-research", "sessions", task.id)
              const entries = await readdir(sessionsDir, { withFileTypes: true })
              const reflectDirs = entries
                .filter((e) => e.isDirectory() && e.name.startsWith("reflect_"))
                .map((e) => e.name)
                .sort()
                .reverse()
              for (const dirName of reflectDirs) {
                try {
                  const raw = await readFile(path.join(sessionsDir, dirName, "reflection_result.json"), "utf8")
                  const parsed = JSON.parse(raw) as { llm?: ReflectionAgentResult["llm"] }
                  if (parsed.llm) return parsed.llm
                } catch { continue }
              }
            } catch { /* sessions dir doesn't exist yet */ }
            return undefined
          })
          return {
            ...result,
            reflectionNotesMarkdown: reflectionNotesMarkdown.length === 0 ? result.reflectionNotesMarkdown : reflectionNotesMarkdown,
            nextExperimentPlanMarkdown:
              nextExperimentPlanMarkdown.length === 0 ? result.nextExperimentPlanMarkdown : nextExperimentPlanMarkdown,
            failureLogMarkdown: failureLogMarkdown.length === 0 ? result.failureLogMarkdown : failureLogMarkdown,
            llm: persistedLLM ?? result.llm,
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
        // runIntentAgent() already drove the session-based ask_user tool when a session/model
        // was available — that path creates its own pending "protocol" approval
        // (taskspec-store.ts recordAskUserQuestions, marker "需要澄清研究意图：") carrying the
        // LLM's actual live question. Only fall back to this deterministic
        // analyzeIntentTask()-derived approval when no live one exists yet (e.g. the LLM/session
        // genuinely couldn't run) — otherwise this used to fire unconditionally on every pipeline
        // call and race the live approval on "most recently updated" lookups.
        const livePendingReason = yield* latestPendingIntentApproval(input.taskID)
        if (livePendingReason === undefined || !livePendingReason.startsWith(INTENT_ASK_USER_MARKER)) {
          yield* ensurePendingApproval({
            taskID: input.taskID,
            kind: "protocol",
            reason: [
              "运行自主研究流水线前需要先澄清研究意图。",
              ...intent.clarifyingQuestions.map((question) => `- ${question}`),
            ].join("\n"),
          })
        }
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
      const literature = workflowAfterDataAnalysis.completedPhases.includes("literature")
        ? yield* recoverRetrieveResult(taskAfterDataAnalysis).pipe(
            Effect.catchCause(() => Effect.gen(function* () {
              const rebuilt = yield* runRetrieveAgent({ taskID: input.taskID, force: true })
              yield* updateTaskWorkflow({ taskID: input.taskID,
                completedPhases: workflowAfterDataAnalysis.completedPhases.filter((phase) =>
                  PipelineWorkflowPhases.indexOf(phase) <= PipelineWorkflowPhases.indexOf("literature")),
                lastCheckpoint: "intent_confirmed",
              })
              return rebuilt
            })),
          )
        : yield* runRetrieveAgent({ taskID: input.taskID }).pipe(
            Effect.tap(() => updateTaskWorkflow({ taskID: input.taskID,
              completedPhases: [...workflowAfterDataAnalysis.completedPhases.filter((phase) =>
                PipelineWorkflowPhases.indexOf(phase) < PipelineWorkflowPhases.indexOf("literature")), "literature"],
              lastCheckpoint: "intent_confirmed",
            })),
          )

      const taskAfterLiterature = yield* getTask(input.taskID)
      const workflowAfterLiterature = workflowMetadataFromTask(taskAfterLiterature)
      const literatureArtifacts = yield* listArtifacts(input.taskID)
      const taskEvidenceArtifact = literatureArtifacts.find((item) =>
        item.kind === "task_evidence_bundle_json" && recordValue(item.metadata).retrieveRunID === literature.retrieveRunID,
      )
      if (!taskEvidenceArtifact) throw new Error(`Missing task evidence artifact for retrieve run: ${literature.retrieveRunID}`)
      const hypoPlanning = workflowAfterLiterature.completedPhases.includes("hypo_planning")
        ? yield* recoverHypoPlanning(taskAfterLiterature, taskEvidenceArtifact.id)
        : yield* runHypoPlannerAgent({
            taskID: input.taskID,
            outputDir: input.outputDir === undefined ? undefined : path.join(input.outputDir, "hypotheses"),
            taskEvidenceArtifactID: taskEvidenceArtifact.id,
          }).pipe(
            Effect.tap(() => markWorkflowPhase("hypo_planning")),
          )

      const currentTask = yield* getTask(input.taskID)
      const currentWorkflow = workflowMetadataFromTask(currentTask)
      const isSocratic = intent.intentSpec.interaction_mode === "socratic"
      const shouldRunSearchSpaceCheckpoint = intent.intentSpec.interaction_mode === "companion" && !currentWorkflow.completedPhases.includes("searching")
      const shouldEmitSocraticSearchSpace = isSocratic && !currentWorkflow.completedPhases.includes("searching")
      if (shouldRunSearchSpaceCheckpoint || shouldEmitSocraticSearchSpace) {
        const allBaselines = DomainRegistry.buildBaselines(currentTask.domainID, currentTask.taskSpec)
        const checkpointReferenceBaseline = recordValue(recordValue(currentTask.taskSpec).metadata).referenceBaseline
        const referenceBaselines =
          typeof checkpointReferenceBaseline === "string"
            ? allBaselines.filter((proposal) => candidateRecipeID(proposal.candidateSpec) === checkpointReferenceBaseline)
            : []
        // Show the explicitly selected comparison anchor when present; otherwise
        // show all options without assigning a default.
        const baselines = referenceBaselines.length > 0 ? referenceBaselines : allBaselines
        const ssSearchPreferences = yield* Effect.promise(() => loadLLMSearchPreferences(Instance.directory, currentTask.id))
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
        const ssPreferencesSection =
          ssSearchPreferences && ssSearchPreferences.length > 0
            ? ["**搜索偏好：**", ...ssSearchPreferences.map((p) => `- ${p}`), ""]
            : []
        const ssReason = [
          "## 搜索空间已确认，等待确认后开始模型搜索",
          "",
          ...ssPreferencesSection,
          "**计划 Baseline 方案：**",
          baselineList,
          "",
          "**建议操作：** 确认搜索方向正确后 approve，或 reject 并调整 taskSpec 后重新运行。",
        ].join("\n")
        if (shouldRunSearchSpaceCheckpoint) {
          const ssCheckpoint = yield* ensureHumanCheckpoint({
            taskID: input.taskID,
            phase: "search_space_confirmed",
            reason: ssReason,
          })
          if (ssCheckpoint.status !== "approved") {
            yield* updateTaskStatus({ taskID: input.taskID, status: "paused" })
            throw new PipelineBlockedError({
              taskID: input.taskID,
              reason: ssCheckpoint.status === "rejected" ? "human_checkpoint_rejected" : "human_checkpoint_required",
              checkpointPhase: "search_space_confirmed",
            })
          }
          yield* updateTaskWorkflow({
            taskID: input.taskID,
            lastCheckpoint: "search_space_confirmed",
          })
        } else {
          yield* bus.publish(Event.CheckpointAutoApproved, {
            taskID: input.taskID,
            phase: "search_space_confirmed",
            reason: ssReason,
          })
        }
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
              maxCrashStreak: input.maxCrashStreak ?? 5,
              explorationRate: input.explorationRate,
            })
            yield* markWorkflowPhase("searching")
            return result
          })

      if (intent.intentSpec.interaction_mode === "companion") {
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
            const extendedMaxIterations = autonomousLoopMaxIterations(input.maxIterations, currentTask) + 5
            extendSearchCycle(input.taskID, extendedMaxIterations)
            nas = yield* runNASAgent({
              taskID: input.taskID,
              stage: input.stage,
              description: input.description,
              maxIterations: extendedMaxIterations,
              targetMetricValue: input.targetMetricValue,
              minRelativeImprovement: input.minRelativeImprovement,
              maxNoImprove: input.maxNoImprove,
              timeBudgetSeconds: input.timeBudgetSeconds,
              maxCrashStreak: input.maxCrashStreak ?? 5,
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
        if (finalCheckpoint.status !== "approved") {
          yield* updateTaskStatus({ taskID: input.taskID, status: "paused" })
          throw new PipelineBlockedError({
            taskID: input.taskID,
            reason: finalCheckpoint.status === "rejected" ? "human_checkpoint_rejected" : "human_checkpoint_required",
            checkpointPhase: "final_model_selection",
          })
        }
      }
      if (intent.intentSpec.interaction_mode === "socratic") {
        const champion = yield* getChampion(input.taskID)
        yield* bus.publish(Event.CheckpointAutoApproved, {
          taskID: input.taskID,
          phase: "final_model_selection",
          reason: [
            "## 模型搜索完成（Socratic 模式自动确认）",
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
          ].join("\n"),
        })
        yield* updateTaskWorkflow({ taskID: input.taskID, lastCheckpoint: "final_model_selection" })
      }

      // ReflectionAgent already ran once as part of finishing the autonomous loop and persisted its
      // result to disk (artifacts + reflection_result.json) — read that back instead of calling it again.
      const reflection = yield* recoverReflection(currentTask, nas.loop.stoppedReason)

      if (reflection.analysis.decision === "request_human" && !currentWorkflow.completedPhases.includes("reflection")) {
        const review = yield* ensureHumanCheckpoint({
          taskID: input.taskID,
          phase: "reflection_review",
          reason: ["Reflection Agent 建议人工介入：", reflection.analysis.decisionReason].join("\n"),
        })
        if (review.status !== "approved") {
          yield* updateTaskStatus({ taskID: input.taskID, status: "paused" })
          throw new PipelineBlockedError({
            taskID: input.taskID,
            reason: review.status === "rejected" ? "human_checkpoint_rejected" : "reflection_requested_human_review",
            checkpointPhase: "reflection_review",
          })
        }
      }
      if (!currentWorkflow.completedPhases.includes("reflection")) {
        yield* markWorkflowPhase("reflection")
      }

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
        if (releaseCheckpoint.status !== "approved") {
          yield* updateTaskStatus({ taskID: input.taskID, status: "paused" })
          throw new PipelineBlockedError({
            taskID: input.taskID,
            reason: releaseCheckpoint.status === "rejected" ? "human_checkpoint_rejected" : "human_checkpoint_required",
            checkpointPhase: "report_release",
          })
        }
        yield* updateTaskWorkflow({ taskID: input.taskID, lastCheckpoint: "report_release" })
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

      yield* updateTaskStatus({ taskID: input.taskID, status: "completed" })
      const completed = yield* getTask(input.taskID)
      return { task: completed, intent, dataAnalysis, literature, hypoPlanning, nas, reflection, publish }
    }))

    const createMemory = Effect.fn("Research.createMemory")(function* (input: CreateMemoryInput) {
      yield* getTask(input.taskID)
      if (input.candidateSummary.experience !== undefined) throw new Error("Structured experience must use write_experience so its evidence is validated")
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
      // Only deliberately saved, evidence-backed experiences transfer between tasks.
      return yield* Effect.sync(() => readExperiences(task.id, { limit: 100 }))
    })

    const setChampion = Effect.fn("Research.setChampion")(function* (input: SetChampionInput) {
      yield* getTask(input.taskID)
      yield* getCandidateForTask(input.taskID, input.candidateID)
      const run = yield* getRunForTask(input.taskID, input.runID)
      if (run.candidateID !== input.candidateID) throw missing("Research run", input.runID)
      if (run.status !== "succeeded" || (run.resourceUsage as any).executionContract?.status !== "verified" || run.stage !== "full") throw new Error("Champion requires a succeeded, contract-verified full run.")
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
      if (row) {
        const run = yield* getRunForTask(taskID, row.run_id)
        if (run.status === "invalid") return undefined
      }
      return row ? mapChampion(row) : undefined
    })

    return Service.of({
      createTask,
      ensureCockpitChat,
      reconcileInterruptedRuns,
      listTasks,
      getTask,
      updateTaskStatus,
      updateTaskSpec,
      updateTaskBudget,
      createCandidate,
      listCandidates,
      createApproval,
      listApprovals,
      replyApproval,
      seedBaselines,
      prepareRun,
      executePreparedRun,
      executeRun,
      executeSeedSweep,
      resumeExecutionContractCheckpoint,
      runAutonomousIteration,
      runAutonomousLoop,
      runIntentAgent,
      answerIntentQuestion,
      interpretAndApplySlotModification,
      runDataAnalysisAgent,
      runRetrieveAgent,
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
      listHypotheses,
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

export const defaultLayer = layer.pipe(
  Layer.provide(Bus.layer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(SessionPrompt.defaultLayer),
)
