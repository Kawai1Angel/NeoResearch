import { NamedError } from "@opencode-ai/core/util/error"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import z from "zod"
import { and, desc, eq, inArray, isNull, ne, Database, NotFoundError } from "@/storage"
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
  ProfileTaskInput,
  ProfileTaskResult,
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
  SeedBaselinesInput,
  ResearchTask,
  ResearchTaskID,
  SetChampionInput,
  UpdateRunStatusInput,
  UpdateTaskStatusInput,
} from "./schema"
import { Event } from "./event"
import {
  issue,
  type DomainCandidateRanking,
  type DomainRunEvaluation,
  type DomainRunPlan,
  type DomainRunStage,
  type DomainValidationIssue,
} from "./domain"
import { DomainRegistry } from "./domain-registry"
import { createFileResearchRuntime, researchJobFromRunPlan } from "./runtime"

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

export type ResearchManagerRole = "diagnostic" | "design" | "coder" | "runner" | "analyst" | "librarian"

export interface ResearchManagerStep {
  readonly role: ResearchManagerRole
  readonly status: "completed" | "skipped" | "blocked"
  readonly summary: string
  readonly metadata: JsonRecord
}

export type ResearchManagerTraceStep = ResearchManagerStep

export type AutonomousLoopStoppedReason = "max_iterations" | "budget_exhausted" | "approval_required"

export interface AutonomousLoopResult {
  readonly iterations: AutonomousIterationResult[]
  readonly stoppedReason: AutonomousLoopStoppedReason
  readonly artifact: ResearchArtifact
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

interface RunnerExecution {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly records: Record<string, unknown>[]
}

interface RunBudgetExceeded {
  readonly limit: number
  readonly used: number
}

const db = <T>(fn: (d: DbClient) => T) => Effect.sync(() => Database.use(fn))

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

function metricsFromRecords(records: Record<string, unknown>[]) {
  const metrics: Record<string, number> = {}
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if ((key.startsWith("val_") || key.startsWith("ref_test_")) && typeof value === "number") {
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

function normalizeTaskSpec(input: CreateTaskInput) {
  try {
    return DomainRegistry.createTaskSpec(input.domainID, input.taskSpec)
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
    ? left.metricMean <= right.metricMean && left.metricMean < right.metricMean
    : left.metricMean >= right.metricMean && left.metricMean > right.metricMean
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
    lines.push(
      `- Candidate ID: ${champion.candidateID}`,
      `- Run ID: ${champion.runID}`,
      `- Primary metric: ${formatMetricValue(champion.primaryMetric)}`,
      `- Utility: ${formatMetricValue(champion.utility)}`,
      `- Accepted at: ${new Date(champion.acceptedAt).toISOString()}`,
    )
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

async function executeRunnerPlan(plan: DomainRunPlan): Promise<RunnerExecution> {
  const cwd = plan.command.cwd ?? process.cwd()
  for (const item of plan.writes) {
    const file = runnerPath(cwd, item.path)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify(item.content, null, 2)}\n`, "utf8")
  }

  const result = await Process.run([plan.command.executable, ...plan.command.args], {
    cwd,
    env: plan.command.env,
    nothrow: true,
  })
  const stdout = result.stdout.toString()
  return {
    exitCode: result.code,
    stdout,
    stderr: result.stderr.toString(),
    records: parseRunnerRecords(stdout),
  }
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
  readonly createCandidate: (input: CreateCandidateInput) => Effect.Effect<ResearchCandidate>
  readonly listCandidates: (taskID: ResearchTaskID) => Effect.Effect<ResearchCandidate[]>
  readonly createRun: (input: CreateRunInput) => Effect.Effect<ResearchRun>
  readonly updateRunStatus: (input: UpdateRunStatusInput) => Effect.Effect<ResearchRun>
  readonly listRuns: (taskID: ResearchTaskID) => Effect.Effect<ResearchRun[]>
  readonly createArtifact: (input: CreateArtifactInput) => Effect.Effect<ResearchArtifact>
  readonly listArtifacts: (taskID: ResearchTaskID) => Effect.Effect<ResearchArtifact[]>
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
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Research") {}

export const layer: Layer.Layer<Service, never, Bus.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

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
            status: "created",
            task_spec: taskSpec,
            objective: input.objective,
            budget: input.budget,
            time_created: time.created,
            time_updated: time.updated,
          })
          .returning()
          .get(),
      )
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
          task.mode === "autonomous" && proposal.riskLevel === "low" ? "auto_approved" : proposal.approvalStatus
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
            .where(and(eq(ResearchRunTable.task_id, task.id), ne(ResearchRunTable.stage, "profile")))
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
      yield* ensureRunBudget(task, status, candidate)
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
      if (runPlan.approvalRequired) {
        yield* ensureRunApprovalGates(task, candidate, stage)
      }

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
      const championUpdated =
        !existingChampion || isBetterMetric(direction, primaryMetric, existingChampion.primaryMetric)

      if (championUpdated) {
        yield* setChampion({
          taskID: task.id,
          candidateID: run.candidateID,
          runID: run.id,
          primaryMetric,
          utility: evaluation.utility ?? (direction === "minimize" ? -primaryMetric : primaryMetric),
        })
      }

      yield* createMemory({
        taskID: task.id,
        domainID: task.domainID,
        fingerprintSummary: {
          ...taskFingerprint,
          taskID: task.id,
          domainID: task.domainID,
          primaryMetricName: metricName,
          direction,
        },
        candidateSummary: runCandidateMemorySummary(candidate, run, {
          primaryMetric,
          championUpdated,
        }),
        outcome: championUpdated ? "accepted" : "rejected",
        lesson: championUpdated
          ? `Candidate ${run.candidateID} became champion on ${metricName}=${primaryMetric}.`
          : `Candidate ${run.candidateID} did not improve champion on ${metricName}=${primaryMetric}.`,
      })
    })

    const recordFailedRunMemory = Effect.fn("Research.recordFailedRunMemory")(function* (run: ResearchRun) {
      const task = yield* getTask(run.taskID)
      const taskFingerprint = DomainRegistry.summarizeTask(task.domainID, task.taskSpec)
      const candidate = run.candidateID === undefined ? undefined : yield* getCandidateForTask(task.id, run.candidateID)
      yield* createMemory({
        taskID: task.id,
        domainID: task.domainID,
        fingerprintSummary: {
          ...taskFingerprint,
          taskID: task.id,
          domainID: task.domainID,
          status: run.status,
        },
        candidateSummary: runCandidateMemorySummary(candidate, run, {
          status: run.status,
        }),
        outcome: "failed",
        lesson: `Candidate ${run.candidateID} failed during ${run.stage}: ${run.error ?? run.status}`,
      })
    })

    const executeRun = Effect.fn("Research.executeRun")(function* (input: PrepareRunInput) {
      const prepared = yield* prepareRunInternal(input, { enqueueRuntimeJob: false })
      const running = yield* updateRunStatus({ runID: prepared.run.id, status: "running" })
      const execution = yield* Effect.promise(() => executeRunnerPlan(prepared.runPlan))
      const metrics = metricsFromRecords(execution.records)
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

      const succeeded = execution.exitCode === 0
      const run = yield* updateRunStatus({
        runID: running.id,
        status: succeeded ? "succeeded" : "failed",
        metrics: metrics as ResearchRun["metrics"],
        resourceUsage: {
          ...running.resourceUsage,
          exitCode: execution.exitCode,
          runnerID: prepared.runPlan.runnerID,
        } as ResearchRun["resourceUsage"],
        artifactRefs,
        error: succeeded ? undefined : execution.stderr || `Runner exited with code ${execution.exitCode}`,
      })

      return { run, runPlan: prepared.runPlan }
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
      const succeededCount = input.iterations.filter((iteration) => iteration.run.status === "succeeded").length
      const failedCount = input.iterations.filter((iteration) => iteration.run.status === "failed").length
      const payload = {
        taskID: input.task.id,
        domainID: input.task.domainID,
        stoppedReason: input.stoppedReason,
        iterationCount: input.iterations.length,
        succeededCount,
        failedCount,
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
      const taskFingerprint = DomainRegistry.summarizeTask(task.domainID, task.taskSpec)
      const managerTrace: ResearchManagerStep[] = [
        managerStep("diagnostic", "completed", "Built task fingerprint for autonomous planning.", {
          domainID: task.domainID,
          targetCount: taskFingerprint.targetCount,
          contextLength: taskFingerprint.contextLength,
          maxPredictionLength: taskFingerprint.maxPredictionLength,
          bridgeOnly: taskFingerprint.bridgeOnly,
          searchBiases: taskFingerprint.searchBiases,
        }),
      ]

      let seeded: SeedBaselinesResult = { candidates: [], approvals: [] }
      let candidates = yield* listCandidates(task.id)
      if (candidates.length === 0) {
        seeded = yield* seedBaselines({ taskID: task.id })
        candidates = seeded.candidates
      }

      const runs = yield* listRuns(task.id)
      const attemptedCandidateIDs = new Set(
        runs.map((run) => run.candidateID).filter((id): id is ResearchCandidateID => id !== undefined),
      )
      const readyCandidateIDs = candidates
        .filter(
          (item) =>
            (item.approvalStatus === "approved" || item.approvalStatus === "auto_approved") &&
            !attemptedCandidateIDs.has(item.id),
        )
        .map((item) => item.id)
      let candidate = candidates.find(
        (item) =>
          (item.approvalStatus === "approved" || item.approvalStatus === "auto_approved") &&
          !attemptedCandidateIDs.has(item.id),
      )

      const proposalApprovals: ResearchApproval[] = []
      let proposalCreated = false
      let selectionSource: "existing_frontier" | "domain_proposal" = "existing_frontier"
      let rankings: DomainCandidateRanking[] = []
      if (!candidate) {
        const memory = yield* listRelatedMemory(task)
        const champion = yield* getChampion(task.id)
        const proposalContext = {
          taskSpec: task.taskSpec,
          taskFingerprint,
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
        rankings = DomainRegistry.rankCandidateProposals(task.domainID, proposalContext)
        const proposal = DomainRegistry.proposeCandidate(task.domainID, proposalContext)

        if (proposal) {
          proposalCreated = true
          selectionSource = "domain_proposal"
          const approvalStatus =
            task.mode === "autonomous" && proposal.riskLevel === "low" ? "auto_approved" : proposal.approvalStatus
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
      if (!candidate) throw new Error(`No approved autonomous candidate is ready for task: ${task.id}`)

      const rankPredictor = rankPredictorArtifactRecord(rankings)
      const topRanking = rankings[0]
      const topRankedRecipeID = topRanking === undefined ? undefined : rankingRecipeID(topRanking)
      const selectedRecipeID = candidateRecipeID(candidate.candidateSpec)
      managerTrace.push(
        managerStep(
          "design",
          "completed",
          proposalCreated
            ? "Designed a new candidate from task fingerprint, run history, champion, and memory."
            : "Selected an approved candidate already queued in the frontier.",
          {
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
            attemptedCandidateCount: attemptedCandidateIDs.size,
            proposalCreated,
            rankingCount: rankings.length,
            rankPredictorVersion: rankPredictor.version,
            ...(topRankedRecipeID === undefined ? {} : { topRankedRecipeID }),
            ...(typeof rankPredictor.memoryEvidenceCount === "number"
              ? { memoryEvidenceCount: rankPredictor.memoryEvidenceCount }
              : {}),
            ...(typeof rankPredictor.benchmarkEvidenceCount === "number"
              ? { benchmarkEvidenceCount: rankPredictor.benchmarkEvidenceCount }
              : {}),
          },
        ),
      )
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

      const memoryBeforeRun = yield* listMemory(task.id)
      const executed = yield* executeRun({
        taskID: task.id,
        candidateID: candidate.id,
        stage: input.stage,
        description: input.description,
      })
      managerTrace.push(
        managerStep("runner", "completed", "Prepared and executed the selected candidate run.", {
          runID: executed.run.id,
          selectedCandidateID: candidate.id,
          stage: executed.run.stage,
          status: executed.run.status,
          metrics: executed.run.metrics,
          rankPredictorVersion: rankPredictor.version,
        }),
      )

      const primaryMetricName = objectiveMetricName(task.objective)
      const primaryMetric = metricValue(executed.run.metrics, primaryMetricName)
      managerTrace.push(
        managerStep("analyst", "completed", "Analyzed run metrics against the task objective.", {
          runID: executed.run.id,
          selectedCandidateID: candidate.id,
          selectedRecipeID,
          primaryMetricName,
          ...(primaryMetric === undefined ? {} : { primaryMetric }),
          direction: objectiveDirection(task.objective),
          rankPredictorVersion: rankPredictor.version,
        }),
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
        run: executed.run,
        taskFingerprint,
        selectionSource,
        rankings,
        readyCandidateIDs,
        attemptedCandidateIDs: [...attemptedCandidateIDs],
      })
      const selectedRun = yield* attachArtifactRefToRun(executed.run, selectionArtifact.id)

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
      const attemptedCandidateIDs = new Set(
        runs.map((run) => run.candidateID).filter((id): id is ResearchCandidateID => id !== undefined),
      )
      const hasReadyCandidate = candidates.some(
        (candidate) =>
          (candidate.approvalStatus === "approved" || candidate.approvalStatus === "auto_approved") &&
          !attemptedCandidateIDs.has(candidate.id),
      )
      if (hasReadyCandidate) return undefined

      const hasPendingCandidate = candidates.some((candidate) => candidate.approvalStatus === "pending")
      if (hasPendingCandidate) return "approval_required" as const

      const pendingApprovals = yield* listApprovals({ taskID: task.id, status: "pending" })
      const hasBlockingApproval = pendingApprovals.some((approval) => approval.kind !== "ref_test")
      return hasBlockingApproval ? ("approval_required" as const) : undefined
    })

    const runAutonomousLoop = Effect.fn("Research.runAutonomousLoop")(function* (input: AutonomousLoopInput) {
      const maxIterations = Math.max(1, Math.min(Math.floor(input.maxIterations ?? 1), 50))
      const iterations: AutonomousIterationResult[] = []
      const task = yield* getTask(input.taskID)
      if (task.mode !== "autonomous") throw new Error(`Research task is not autonomous: ${task.id}`)
      for (let index = 0; index < maxIterations; index++) {
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
        }).pipe(
          Effect.map((iteration) => ({ status: "iteration" as const, iteration })),
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause)
            if (ApprovalRequiredError.isInstance(error)) {
              return finishAutonomousLoop({ task, iterations, stoppedReason: "approval_required" }).pipe(
                Effect.map((result) => ({ status: "stopped" as const, result })),
              )
            }
            return Effect.failCause(cause)
          }),
        )
        if (iterationResult.status === "stopped") return iterationResult.result
        iterations.push(iterationResult.iteration)
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

    const exportTaskArtifact = Effect.fn("Research.exportTaskArtifact")(function* (input: ExportTaskArtifactInput) {
      const task = yield* getTask(input.taskID)
      const candidates = yield* listCandidates(task.id)
      const runs = yield* listRuns(task.id)
      const approvals = yield* listApprovals({ taskID: task.id })
      const artifacts = yield* listArtifacts(task.id)
      const memory = yield* listMemory(task.id)
      const champion = yield* getChampion(task.id)
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
      const outputPath = path.join(directory, domainArtifact?.filename ?? "research-report.md")
      yield* Effect.promise(async () => {
        await mkdir(directory, { recursive: true })
        const sections = [content, lineageContent, experimentAnalysisContent]
          .map((section) => section.trim())
          .filter((section) => section.length > 0)
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

    const profileTask = Effect.fn("Research.profileTask")(function* (input: ProfileTaskInput) {
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

      run = mapRun(
        yield* db((d) =>
          d
            .update(ResearchRunTable)
            .set({
              artifact_refs: [artifact.id],
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
      createRun,
      updateRunStatus,
      listRuns,
      createArtifact,
      listArtifacts,
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
