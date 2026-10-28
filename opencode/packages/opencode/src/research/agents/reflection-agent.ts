import { assessAttribution } from "../attribution"
import { reflectionExecutionEvidence } from "../runner-evidence"
import type { KnowledgeValidationDraft } from "../literature/knowledge-confidence"
import type { LLMTokenUsage } from "../llm-proposal"
import { NAS_DEFAULT_MAX_ITERATIONS } from "../defaults"
import type { ExperienceDraft } from "../experience"
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
  readonly hypothesisTestedRuns: number
  readonly unattributableRuns: number
  readonly inconclusiveRuns: number
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
  /** Optional explicit writes for the direct transport, which has no session tools. */
  readonly experienceWrites?: readonly ExperienceDraft[]
  readonly knowledgeValidations?: readonly KnowledgeValidationDraft[]
}

export function buildInlineReflectionSystemPrompt(sessionPrompt: string): string {
  const outputStart = sessionPrompt.indexOf("## Output format")
  const narrationStart = sessionPrompt.indexOf("## Narration")
  if (outputStart < 0 || narrationStart < 0 || narrationStart >= outputStart) {
    throw new Error("Reflection prompt is missing its evidence/output sections")
  }
  const evidencePrompt = sessionPrompt.slice(0, narrationStart).replace(
    "Use the current-run\ntools below to gather evidence.",
    "Use the supplied inline evidence to assess the experiment.",
  )
  const outputPrompt = sessionPrompt.slice(outputStart).replace(
    "After completing the four tool calls,",
    "Using the supplied inline evidence,",
  ).replace("EXACTLY these 7 keys", "these 7 analysis keys, optionally followed by experienceWrites and knowledgeValidations")
    .replace("Each value is a concise string", "Each analysis value is a concise string")
  return `${evidencePrompt}## Inline evidence\n` +
    "This is a direct API synthesis call. Current/comparison run evidence and compact admitted knowledge summaries are supplied in the user JSON. " +
    "Native tools are unavailable. Only for a specific unresolved source question return {status:evidence_request,request:{cardID,cardRevision,section:knowledge|sources|review,sourceIDs?,offset?,limit?}}; the coordinator supplies bounded exact stored pages (at most three requests). Otherwise produce the final analysis directly. " +
    "experimentResults and experimentDesign contain the run outcome and executed recipe; " +
    "trainingCurve contains observed curves, and historicalExperimentMemory contains prior lessons. " +
    "Treat absent evidence as unavailable and state the limitation. " +
    "To deliberately save useful positive or negative experience, optionally include experienceWrites (at most 3 entries) " +
    "using experienceWriteSchema in the user input. Omit it or return [] when nothing merits saving. " +
    "experiment_fact records an observed run; conditional_experience states conditions, intervention, observation, " +
    "boundaries and a falsifiable validationPlan. Performance experiences need verified independent full runs and " +
    "same-task comparisonRunID evidence. validated_principle needs support from at least two distinct dataset contents. " +
    "Every entry has three parts: experimentFacts, conditionalExperience and validatedRegularity. The level is a legacy maturity label, not a choice of parts. " +
    "For a new hypothesis supply evolution={relation,claim:{statement,dataConditions,operation,interventionPaths,expectedOutcome:{metric,direction,equivalenceMargin?},boundaries,validationPlan}}. " +
    "For an existing explicit hypothesis supply evolution={parentExperienceID,relation:supports|refutes|qualifies|observes} and only the new local run evidence; the parent claim and all earlier counterevidence accumulate automatically. " +
    "Before starting a root, retrieve shared experiences for this conditional proposition and read the exact matching ID. Reuse it when only the dataset, observed result or future validation plan changed; append evidence and update the existing experience. " +
    "For this bounded lookup, return {status:experience_request,request:{scope:shared,query:...,limit:3}} or an exact experienceID with includeFacts:true; the coordinator returns requestedExperiences before final synthesis. An exact experienceID with includeHistory:true returns previous versions. At most three source/experience requests are allowed in total. " +
    "Relation refers to the parent's expected outcome, independently of local positive/negative polarity. An execution failure is inconclusive for a performance hypothesis. " +
    "Legacy records without a structured claim must be reformulated as a new explicit thread with derivedFrom provenance; do not invent cross-dataset validation. Cite only supplied run IDs. " +
    "Inspect literatureKnowledge.entries assertions/conditions/boundaries and sourceRuns current/comparison execution evidence to decide whether the current experiment supports the supplied literature assertions. " +
    "Optionally include knowledgeValidations (at most 3, using knowledgeValidationSchema) only for supported claims. " +
    "Use literatureKnowledge.currentRunID as runID, the supplied cardID/cardRevision, assertionIDs, conditionsAssessment, implementationAssessment, rationale and limitations. " +
    "A successful run or lower metric alone cannot validate a mechanism; assess the actual implementation and preserve qualifications. " +
    "Performance claims require comparable verified full runs; incomplete, smoke, duplicate, unverified or held-out runs cannot raise confidence. " +
    "The coordinator adds 0.01 confidence (cap 1) with factual snapshots for each new card/experiment; retries do not add again. " +
    "Omit knowledgeValidations or return [] when no literature claim is supported. " +
    "The coordinator invokes the same validated writers as write_experience and confirm_knowledge; do not claim a write succeeded yourself.\n\n" + outputPrompt
}

export interface ReflectionAgentResult {
  readonly agent: "ReflectionAgent"
  readonly taskID: ResearchTaskID
  readonly maxIterations: number
  readonly reflectionNotesMarkdown: string
  readonly nextExperimentPlanMarkdown: string
  readonly failureLogMarkdown: string
  readonly analysis: ReflectionAnalysis
  readonly experienceWriteResults?: readonly { saved: boolean; id?: string; error?: string }[]
  readonly knowledgeValidationResults?: readonly { saved: boolean; cardID: string; updated?: boolean; confidence?: number; error?: string }[]
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
  readonly maxIterations?: number
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

function plannedMaxIterations(task: ResearchTask, explicit?: number) {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 1) return Math.floor(explicit)
  const budget = recordValue(task.budget)
  const loop = recordValue(budget.loop ?? budget.researchLoop ?? budget.autonomousLoop)
  const value = loop.maxIterations
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : NAS_DEFAULT_MAX_ITERATIONS
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
  if (category === "rejected") return "inspect_execution_evidence"
  return "inspect_failure_context"
}

function recoverySummaryForFailure(category: ReflectionFailure["category"]) {
  if (category === "oom") return "Reduce batch size, model width, or training parallelism, then retry the same candidate or a conservative neighboring candidate."
  if (category === "nan") return "Lower the learning rate, enable gradient clipping or use a robust loss, and check outlier handling."
  if (category === "not_converge") return "Adjust the optimizer/scheduler, training steps, or patience and verify that the loss decreases."
  if (category === "script_error") return "Fix runner, dependency, recipe serialization, or dataset path issues before resuming NAS search."
  if (category === "rejected") return "Check original execution records, experiment settings, and missing evidence before deciding how to resume."
  return "Preserve context and manually review stderr, runner records, and the candidate definition."
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
  readonly failedStreak: number
  readonly succeededRuns: number
}): { decision: ReflectionDecision; reason: string } {
  const { stoppedReason, failedStreak, succeededRuns } = input
  if (stoppedReason === "target_reached") return { decision: "stop", reason: "The target metric has been reached; reflection recommends stopping iterations and publishing." }
  if (stoppedReason === "budget_exhausted")
    return { decision: "stop", reason: "The budget is exhausted; reflection recommends stopping iterations and collecting artifacts." }
  if (stoppedReason === "approval_required")
    return { decision: "request_human", reason: "Human confirmation is required to continue; entering a Companion checkpoint." }
  if (stoppedReason === "crash_streak_exceeded" || failedStreak >= 3)
    return {
      decision: "request_human",
      reason: "Repeated failures require human review of code, dependencies, or resources.",
    }
  if (succeededRuns === 0)
    return {
      decision: "request_human",
      reason: "No run has succeeded; first check data preparation and the training script.",
    }
  return { decision: "continue", reason: "Continue with the next experiment." }
}

export function analyzeReflection(input: ReflectionInputs): ReflectionAnalysis {
  const primaryMetricName = objectiveMetricName(input.task.objective)
  const direction = objectiveDirection(input.task.objective)
  const candidatesByID = new Map(input.candidates.map((candidate) => [candidate.id, candidate] as const))

  const ordered = input.runs.map((run) => reflectionExecutionEvidence(run, primaryMetricName))
    .sort((a, b) => a.time.created - b.time.created)
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
  let inconclusiveRuns = 0
  let hypothesisTestedRuns = 0
  let unattributableRuns = 0

  for (const run of ordered) {
    if (run.status === "succeeded") {
      if (run.stage !== "full" || run.resourceUsage.independentEvidence === false || run.resourceUsage.duplicateExperiment === true) continue
      const value = metricValue(run.metrics, primaryMetricName)
      if (value === undefined) {
        if (run.stage !== "full" || recordValue(run.resourceUsage).independentEvidence === false) continue
        inconclusiveRuns += 1
        failures.push({
          runID: run.id,
          candidateID: run.candidateID,
          category: "other",
          summary: run.error ?? `Incomplete evaluation: missing finite ${primaryMetricName}; hypothesis outcome is inconclusive.`,
        })
        failedStreak += 1
        continue
      }
      const candidate = run.candidateID ? candidatesByID.get(run.candidateID) : undefined
      const snapshot = recordValue(run.resourceUsage.hypothesisSnapshot)
      const comparisonID = recordValue(snapshot.experimentContract).comparisonRunID
      const comparison = input.runs.find((r) => r.id === comparisonID)
      const comparisonCandidate = comparison?.candidateID ? candidatesByID.get(comparison.candidateID) : undefined
      const assessment = assessAttribution({ executionVerified: recordValue(run.resourceUsage.executionContract).status === "verified", proposedModel: candidate?.candidateSpec, hypothesisSnapshot: snapshot }, comparisonCandidate ? { proposedModel: comparisonCandidate.candidateSpec } : undefined)
      if (assessment.status === "eligible") hypothesisTestedRuns++
      else unattributableRuns++
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
    } else if (run.status === "failed" || run.status === "rejected" || run.status === "invalid") {
      const candidate = run.candidateID ? candidatesByID.get(run.candidateID) : undefined
      failures.push({
        runID: run.id,
        candidateID: candidate?.id,
        category: classifyFailure(run),
        summary: run.error ?? `${run.status} run`,
      })
      if (run.status !== "invalid") failedStreak += 1
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
    inconclusiveRuns,
    hypothesisTestedRuns,
    unattributableRuns,
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
  readonly maxIterations?: number
}) {
  const { task, analysis, stoppedReason } = input
  const lines: string[] = [
    "# Reflection Notes",
    "",
    `- Agent: ReflectionAgent`,
    `- Task ID: ${task.id}`,
    `- Domain: ${task.domainID}`,
    `- Primary metric: ${analysis.primaryMetricName} (${analysis.direction})`,
    `- NAS planned max iterations: ${plannedMaxIterations(task, input.maxIterations)}`,
    stoppedReason ? `- NAS stopped reason: ${stoppedReason}` : `- NAS stopped reason: (none)`,
    "",
    "## Run Summary",
    "",
    `- Succeeded runs: ${analysis.succeededRuns}`,
    `- Inconclusive runs (missing primary metric): ${analysis.inconclusiveRuns}`,
    `- Controlled hypothesis tests: ${analysis.hypothesisTestedRuns}`,
    `- Numerical observations without attributable hypothesis test: ${analysis.unattributableRuns}`,
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
    maxIterations: plannedMaxIterations(input.task, input.maxIterations),
    analysis,
    reflectionNotesMarkdown: buildReflectionNotesMarkdown({
      task: input.task,
      analysis,
      stoppedReason: input.stoppedReason,
      maxIterations: input.maxIterations,
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
    inconclusiveRuns: result.analysis.inconclusiveRuns,
    failedRuns: result.analysis.failedRuns,
    rejectedRuns: result.analysis.rejectedRuns,
    failureCount: result.analysis.failures.length,
    failureCategories: result.analysis.failures.map((failure) => failure.category),
    maxIterations: result.maxIterations,
  }
}

// Persisted structural notes omit the LLM synthesis. Planning must receive both,
// including for historical runs created before this handoff was introduced.
export function buildReflectionPlanningMarkdown(result: {
  readonly reflectionNotesMarkdown?: string
  readonly llm?: ReflectionAgentResult["llm"]
}) {
  const notes = result.reflectionNotesMarkdown ?? ""
  if (result.llm?.status !== "used") return notes
  const synthesis = result.llm.structured
    ? Object.entries(result.llm.structured).map(([key, value]) => `### ${key}\n\n${value}`).join("\n\n")
    : result.llm.text
  return synthesis ? `${notes}\n## LLM Reflection\n\n${synthesis}\n` : notes
}
