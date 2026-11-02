import z from "zod"
import { isDeepStrictEqual } from "node:util"
import { digest } from "../digest"
import { designDigest, checkTrainingTrial } from "../design-contract"
import { ExperimentConstraints, checkExperimentConstraints } from "../experiment-constraints"
import type { ResearchDesign, TrainingTrial } from "../design-store"
import type { ResearchTask, ResearchRun, ResearchCandidate } from "../schema"
import type { TrainingCurvePoint } from "../runner-evidence"
import { summarizeReflectionAgent, type ReflectionAgentResult, type ReflectionLLMAnalysis } from "./reflection-agent"

// Execution failures belong to optimization observations, not a third memory purpose.
export const ReflectionMemoryPurpose = z.enum(["optimization", "architecture"])
const text = z.string().trim().min(1)
const llm = z
  .object({
    status: z.enum(["pending", "used", "not_configured", "deadline_exhausted"]),
    model: z.string().optional(),
  })
  .strict()
export const TrainingReflectionAnalysis = z
  .object({
    executionAssessment: text,
    trainingHealthAssessment: text,
    nextTrainingQuestions: z.array(text).max(8),
    limitations: z.array(text).max(12),
  })
  .strict()
export const ArchitectureReflectionAnalysis = z
  .object({
    hypothesisAssessment: z
      .object({ status: z.enum(["supported", "not_supported", "inconclusive"]), reason: text })
      .strict(),
    designAssessment: text,
    trainingConfounders: z.array(text).max(12),
    nextArchitectureQuestions: z.array(text).max(8),
    limitations: z.array(text).max(12),
  })
  .strict()
const curveSeries = z
  .object({
    phase: z.enum(["cv", "standard"]),
    foldIndex: z.number().optional(),
    horizon: z.number().optional(),
    pointCount: z.number().int().positive(),
    firstEpoch: z.number(),
    lastEpoch: z.number(),
    firstValLoss: z.number().finite(),
    lastValLoss: z.number().finite(),
    bestValLoss: z.number().finite(),
  })
  .strict()
export const TrainingReflection = z
  .object({
    schemaVersion: z.literal("training_reflection.v1"),
    reflectionScope: z.literal("training"),
    memoryPurpose: z.literal("optimization"),
    taskID: text,
    designID: text,
    trialID: text,
    candidateID: text,
    runID: text,
    inputDigest: text,
    evidenceRunIDs: z.array(text),
    primaryMetric: text,
    direction: z.enum(["minimize", "maximize"]),
    trainingStrategy: z.record(z.string(), z.unknown()),
    trainingContract: ExperimentConstraints.nullable(),
    execution: z
      .object({
        stage: text,
        status: text,
        error: z.string().optional(),
        verified: z.boolean(),
        independent: z.boolean(),
        eligibleForRanking: z.boolean(),
        primaryValue: z.number().finite().optional(),
      })
      .strict(),
    comparison: z
      .object({
        kind: z.enum(["controlled_training", "repair_observation", "none"]),
        runID: text.optional(),
        trainingStrategy: z.record(z.string(), z.unknown()).optional(),
        eligible: z.boolean(),
        reasons: z.array(text),
        changedPaths: z.array(text),
        delta: z.number().finite().optional(),
      })
      .strict(),
    curveSeries: z.array(curveSeries),
    analysis: TrainingReflectionAnalysis,
    analysisStatus: z.enum(["facts_only", "completed"]),
    llm,
  })
  .strict()
export type TrainingReflection = z.infer<typeof TrainingReflection>

const trialSummary = z
  .object({
    trialID: text,
    index: z.number().int(),
    candidateID: text,
    runID: text,
    stage: text,
    status: text,
    trainingStrategy: z.record(z.string(), z.unknown()),
    primaryValue: z.number().finite().optional(),
    eligibleForRanking: z.boolean(),
    trainingReflectionKey: text,
  })
  .strict()
const architectureEvidence = z
  .object({
    status: z.enum(["eligible", "observation_only", "confounded", "insufficient_evidence"]),
    runID: text.optional(),
    comparisonRunID: text.optional(),
    reasons: z.array(text),
    changedPaths: z.array(text),
    delta: z.number().finite().optional(),
  })
  .strict()
export const DesignSummary = z
  .object({
    schemaVersion: z.literal("design_summary.v1"),
    taskID: text,
    cycleID: text,
    designID: text,
    hypothesisID: text.nullable(),
    fixedDesignDigest: text,
    inputDigest: text,
    primaryMetric: text,
    direction: z.enum(["minimize", "maximize"]),
    trials: z.array(trialSummary).min(1),
    bestModel: z
      .object({ trialID: text, candidateID: text, runID: text, metricValue: z.number().finite() })
      .strict()
      .optional(),
    architectureEvidence,
    optimization: z
      .object({
        trialCount: z.number().int(),
        fullAttempts: z.number().int(),
        failedAttempts: z.number().int(),
        noImprove: z.number().int(),
        stopReason: z.string().nullable(),
      })
      .strict(),
  })
  .strict()
export type DesignSummary = z.infer<typeof DesignSummary>

export const ArchitectureReflection = z
  .object({
    schemaVersion: z.literal("architecture_reflection.v1"),
    reflectionScope: z.literal("architecture"),
    memoryPurpose: z.literal("architecture"),
    taskID: text,
    designID: text,
    inputDigest: text,
    evidenceRunIDs: z.array(text),
    designSummary: DesignSummary,
    analysis: ArchitectureReflectionAnalysis,
    analysisStatus: z.enum(["facts_only", "completed"]),
    llm,
  })
  .strict()
export type ArchitectureReflection = z.infer<typeof ArchitectureReflection>

export const trainingReflectionKey = (trialID: string) => `training-reflection:${trialID}:v2`
export const architectureReflectionKey = (designID: string) => `architecture-reflection:${designID}:v2`
export const DESIGN_SUMMARY_KEY = "design-summary:v2"

export interface ReflectionEvidence {
  task: ResearchTask
  design: ResearchDesign
  trials: TrainingTrial[]
  runs: ResearchRun[]
  candidates: ResearchCandidate[]
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
export const reflectionMetric = (task: ResearchTask) =>
  String(task.objective.primaryMetric ?? task.objective.metric ?? "val_avg_mse")
function finiteMetric(run: ResearchRun, metric: string) {
  const value = run.metrics[metric]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
function executionVerified(run: ResearchRun) {
  const contract = record(run.resourceUsage.executionContract)
  return contract.status === "verified" && Object.keys(record(record(contract.manifest).actual)).length > 0
}
export function rankingEligible(run: ResearchRun, metric: string) {
  return (
    run.stage === "full" &&
    run.status === "succeeded" &&
    finiteMetric(run, metric) !== undefined &&
    executionVerified(run) &&
    record(run.resourceUsage.verification).status !== "failed" &&
    record(run.resourceUsage.verification).eligibleForRanking !== false &&
    run.resourceUsage.independentEvidence !== false &&
    run.resourceUsage.duplicateExperiment !== true
  )
}
function protocolMatches(task: ResearchTask, run: ResearchRun) {
  const context = record(run.resourceUsage.experienceContext)
  const expected = {
    ...record(task.taskSpec.evaluation),
    contextLength: task.taskSpec.contextLength,
    predictionLengths: task.taskSpec.predictionLengths,
    split: record(task.taskSpec.dataset).split,
  }
  return (
    run.taskID === task.id &&
    isDeepStrictEqual(JSON.parse(JSON.stringify(expected)), context.evaluation) &&
    isDeepStrictEqual(JSON.parse(JSON.stringify(task.taskSpec.dataset)), record(context.dataset).specification)
  )
}
function completedRun(evidence: ReflectionEvidence, trial: TrainingTrial) {
  const run = evidence.runs.find((run) => run.id === (trial.full_run_id ?? trial.smoke_run_id))
  if (
    evidence.design.task_id !== evidence.task.id ||
    trial.status !== "completed" ||
    !run ||
    run.taskID !== evidence.task.id ||
    ["queued", "running"].includes(run.status) ||
    run.candidateID !== trial.candidate_id
  )
    throw new Error("Scoped reflection requires the trial's completed persisted execution")
  return run
}
function evaluationSeed(run: ResearchRun, candidate: ResearchCandidate) {
  return run.resourceUsage.seed ?? record(record(candidate.candidateSpec.trainingStrategy).budget).seed
}
function sourceCandidate(evidence: ReflectionEvidence, run: ResearchRun) {
  const candidate = evidence.candidates.find(
    (candidate) => candidate.id === run.candidateID && candidate.taskID === evidence.task.id,
  )
  if (!candidate) throw new Error("Scoped reflection candidate is unavailable")
  return candidate
}
function evidenceIdentity(evidence: ReflectionEvidence) {
  return {
    task: { spec: { ...evidence.task.taskSpec, metadata: undefined }, objective: evidence.task.objective },
    design: { id: evidence.design.id, recipe: evidence.design.recipe, outerContract: evidence.design.outer_contract },
    trials: evidence.trials.map((trial) => ({
      id: trial.id,
      index: trial.trial_index,
      candidateID: trial.candidate_id,
      contract: trial.contract,
      repairRunID: trial.repair_run_id,
    })),
    runs: evidence.runs.map((run) => ({
      id: run.id,
      candidateID: run.candidateID,
      stage: run.stage,
      status: run.status,
      metrics: run.metrics,
      error: run.error,
      execution: run.resourceUsage.executionContract,
      hypothesisSnapshot: run.resourceUsage.hypothesisSnapshot,
      verification: run.resourceUsage.verification,
      context: run.resourceUsage.experienceContext,
      independent: run.resourceUsage.independentEvidence,
      duplicate: run.resourceUsage.duplicateExperiment,
    })),
    candidates: evidence.candidates.map((candidate) => ({ id: candidate.id, spec: candidate.candidateSpec })),
  }
}
function curves(points: readonly TrainingCurvePoint[]) {
  const groups = new Map<string, TrainingCurvePoint[]>()
  for (const point of points) {
    const key = `${point.phase}:${point.foldIndex ?? "standard"}:${point.horizon ?? "unknown"}`
    groups.set(key, [...(groups.get(key) ?? []), point])
  }
  return [...groups.values()].map((group) => {
    group.sort((a, b) => a.epoch - b.epoch)
    const first = group[0]!,
      last = group.at(-1)!
    return {
      phase: first.phase,
      foldIndex: first.foldIndex,
      horizon: first.horizon,
      pointCount: group.length,
      firstEpoch: first.epoch,
      lastEpoch: last.epoch,
      firstValLoss: first.valLoss,
      lastValLoss: last.valLoss,
      bestValLoss: Math.min(...group.map((point) => point.valLoss)),
    }
  })
}

export function buildTrainingReflection(
  input: ReflectionEvidence,
  trial: TrainingTrial,
  points: readonly TrainingCurvePoint[],
): TrainingReflection {
  const runIDs = [trial.full_run_id ?? trial.smoke_run_id, trial.contract?.comparisonRunID, trial.repair_run_id]
  const evidence = {
    ...input,
    runs: input.runs.filter((run) => runIDs.includes(run.id)),
    trials: input.trials.filter((item) => item.trial_index <= trial.trial_index),
    candidates: input.candidates.filter((candidate) =>
      input.runs.some((run) => runIDs.includes(run.id) && run.candidateID === candidate.id),
    ),
  }
  if (trial.design_id !== evidence.design.id) throw new Error("Training reflection trial belongs to another design")
  const run = completedRun(evidence, trial)
  const candidate = sourceCandidate(evidence, run)
  if (designDigest(candidate.candidateSpec) !== evidence.design.design_digest)
    throw new Error("Training reflection fixed design changed")
  const metric = reflectionMetric(evidence.task)
  const referenceID = trial.contract?.comparisonRunID ?? trial.repair_run_id ?? undefined
  const comparison = referenceID ? evidence.runs.find((item) => item.id === referenceID) : undefined
  const comparisonCandidate = comparison ? sourceCandidate(evidence, comparison) : undefined
  if (comparisonCandidate && !evidence.trials.some((item) => item.candidate_id === comparisonCandidate.id))
    throw new Error("Training reflection source is outside the fixed design")
  const reasons: string[] = []
  const controlled = trial.contract?.mode === "controlled"
  if (!controlled)
    reasons.push(
      trial.repair_run_id
        ? "A failed repair source is diagnostic evidence, not a performance control."
        : "No same-design training control was declared.",
    )
  if (controlled) {
    if (
      !comparison ||
      !comparisonCandidate ||
      !evidence.trials.some((item) => item.candidate_id === comparisonCandidate.id)
    )
      reasons.push("The declared control is not a trial of this design.")
    if (!rankingEligible(run, metric) || !comparison || !rankingEligible(comparison, metric))
      reasons.push("Both arms must be independent verified full evaluations eligible for ranking.")
    if (!protocolMatches(evidence.task, run) || !comparison || !protocolMatches(evidence.task, comparison))
      reasons.push("The data and evaluation protocols must match.")
    if (
      comparison &&
      comparisonCandidate &&
      evaluationSeed(run, candidate) !== evaluationSeed(comparison, comparisonCandidate)
    )
      reasons.push("The evaluated seeds must match.")
    if (trial.contract)
      reasons.push(
        ...checkTrainingTrial({
          design: evidence.design.recipe,
          candidate: candidate.candidateSpec,
          contract: trial.contract,
          comparison: comparisonCandidate?.candidateSpec,
        }).map((issue) => issue.message),
      )
  }
  const eligible = controlled && !reasons.length
  const series = curves(points)
  return TrainingReflection.parse({
    schemaVersion: "training_reflection.v1",
    reflectionScope: "training",
    memoryPurpose: "optimization",
    taskID: evidence.task.id,
    designID: evidence.design.id,
    trialID: trial.id,
    candidateID: candidate.id,
    runID: run.id,
    inputDigest: digest({ evidence: evidenceIdentity(evidence), trialID: trial.id, points }),
    evidenceRunIDs: [...new Set([run.id, ...(comparison ? [comparison.id] : [])])],
    primaryMetric: metric,
    direction: evidence.task.objective.direction === "maximize" ? "maximize" : "minimize",
    trainingStrategy: record(candidate.candidateSpec.trainingStrategy),
    trainingContract: trial.contract,
    execution: {
      stage: run.stage,
      status: run.status,
      error: run.error,
      verified: executionVerified(run),
      independent: run.resourceUsage.independentEvidence !== false && run.resourceUsage.duplicateExperiment !== true,
      eligibleForRanking: rankingEligible(run, metric) && protocolMatches(evidence.task, run),
      primaryValue: finiteMetric(run, metric),
    },
    comparison: {
      kind: controlled ? "controlled_training" : trial.repair_run_id ? "repair_observation" : "none",
      runID: referenceID,
      trainingStrategy: comparisonCandidate ? record(comparisonCandidate.candidateSpec.trainingStrategy) : undefined,
      eligible,
      reasons,
      changedPaths: trial.contract?.changes.map((change) => change.path) ?? [],
      delta: eligible ? finiteMetric(run, metric)! - finiteMetric(comparison!, metric)! : undefined,
    },
    curveSeries: series,
    analysisStatus: "facts_only",
    llm: { status: "pending" },
    analysis: {
      executionAssessment: `${run.stage}/${run.status}${run.error ? `: ${run.error}` : ""}`,
      trainingHealthAssessment: `${series.length} separate curve series observed; convergence and generalization require interpretation.`,
      nextTrainingQuestions: [],
      limitations: [
        "Training observations do not test the architectural hypothesis.",
        "Validation losses from different folds/horizons are separate series; training loss may differ from the selection metric.",
      ],
    },
  })
}

export function buildDesignSummary(evidence: ReflectionEvidence): DesignSummary {
  if (!evidence.trials.length || evidence.trials.some((trial) => trial.design_id !== evidence.design.id))
    throw new Error("Design summary requires same-design completed trials")
  const metric = reflectionMetric(evidence.task)
  const direction = evidence.task.objective.direction === "maximize" ? "maximize" : "minimize"
  const trials = [...evidence.trials]
    .sort((a, b) => a.trial_index - b.trial_index)
    .map((trial) => {
      const run = completedRun(evidence, trial),
        candidate = sourceCandidate(evidence, run)
      if (designDigest(candidate.candidateSpec) !== evidence.design.design_digest)
        throw new Error("Design summary fixed design changed")
      return {
        trialID: trial.id,
        index: trial.trial_index,
        candidateID: candidate.id,
        runID: run.id,
        stage: run.stage,
        status: run.status,
        trainingStrategy: record(candidate.candidateSpec.trainingStrategy),
        primaryValue: finiteMetric(run, metric),
        eligibleForRanking: rankingEligible(run, metric) && protocolMatches(evidence.task, run),
        trainingReflectionKey: trainingReflectionKey(trial.id),
      }
    })
  const best = trials
    .filter((trial) => trial.eligibleForRanking)
    .reduce<
      (typeof trials)[number] | undefined
    >((best, trial) => (!best || (direction === "minimize" ? trial.primaryValue! < best.primaryValue! : trial.primaryValue! > best.primaryValue!) ? trial : best), undefined)
  const initial = trials.find((trial) => trial.index === 0)!
  if (!initial) throw new Error("Design summary has no initial architecture trial")
  const contract = evidence.design.outer_contract
  const comparison = contract?.comparisonRunID
    ? evidence.runs.find((run) => run.id === contract.comparisonRunID)
    : undefined
  const candidate = evidence.candidates.find((candidate) => candidate.id === initial.candidateID)!
  let status: DesignSummary["architectureEvidence"]["status"] = "insufficient_evidence"
  const reasons: string[] = []
  if (contract?.mode !== "controlled") {
    status = "observation_only"
    reasons.push("The outer contract declares no controlled architecture comparison.")
  } else if (
    !initial.eligibleForRanking ||
    !comparison ||
    !rankingEligible(comparison, metric) ||
    !protocolMatches(evidence.task, comparison)
  ) {
    reasons.push(
      "The original architecture trial and its named control must have complete matched independent full results.",
    )
  } else {
    const control = sourceCandidate(evidence, comparison)
    const issues = checkExperimentConstraints(contract, candidate.candidateSpec, control.candidateSpec)
    if (issues.length) reasons.push(...issues.map((issue) => issue.message))
    else if (
      !isDeepStrictEqual(candidate.candidateSpec.trainingStrategy, control.candidateSpec.trainingStrategy) ||
      evaluationSeed(evidence.runs.find((run) => run.id === initial.runID)!, candidate) !==
        evaluationSeed(comparison, control) ||
      contract.changes.some((change) => change.path.startsWith("trainingStrategy"))
    ) {
      status = "confounded"
      reasons.push(
        "Training settings differ or the outer intervention includes training changes; architecture effects cannot be isolated.",
      )
    } else if (!contract.changes.some((change) => !change.path.startsWith("trainingStrategy"))) {
      status = "observation_only"
      reasons.push("No architecture/preprocessing intervention was declared.")
    } else status = "eligible"
  }
  return DesignSummary.parse({
    schemaVersion: "design_summary.v1",
    taskID: evidence.task.id,
    cycleID: evidence.design.cycle_id,
    designID: evidence.design.id,
    hypothesisID: evidence.design.hypothesis_id,
    fixedDesignDigest: evidence.design.design_digest,
    inputDigest: digest(evidenceIdentity(evidence)),
    primaryMetric: metric,
    direction,
    trials,
    bestModel: best
      ? { trialID: best.trialID, candidateID: best.candidateID, runID: best.runID, metricValue: best.primaryValue }
      : undefined,
    architectureEvidence: {
      status,
      runID: initial.runID,
      comparisonRunID: contract?.comparisonRunID,
      reasons,
      changedPaths: contract?.changes.map((change) => change.path) ?? [],
      delta: status === "eligible" ? initial.primaryValue! - finiteMetric(comparison!, metric)! : undefined,
    },
    optimization: {
      trialCount: trials.length,
      fullAttempts: trials.filter((trial) => trial.stage === "full").length,
      failedAttempts: trials.filter((trial) => ["failed", "invalid", "rejected"].includes(trial.status)).length,
      noImprove: evidence.design.no_improve,
      stopReason: evidence.design.stop_reason,
    },
  })
}

export function buildArchitectureReflection(summary: DesignSummary): ArchitectureReflection {
  return ArchitectureReflection.parse({
    schemaVersion: "architecture_reflection.v1",
    reflectionScope: "architecture",
    memoryPurpose: "architecture",
    taskID: summary.taskID,
    designID: summary.designID,
    inputDigest: summary.inputDigest,
    designSummary: summary,
    evidenceRunIDs: [
      ...new Set([
        ...summary.trials.map((trial) => trial.runID),
        ...(summary.architectureEvidence.comparisonRunID ? [summary.architectureEvidence.comparisonRunID] : []),
      ]),
    ],
    analysisStatus: "facts_only",
    llm: { status: "pending" },
    analysis: {
      hypothesisAssessment: { status: "inconclusive", reason: "No scoped model interpretation has been completed." },
      designAssessment: summary.bestModel
        ? `Best eligible model: ${summary.bestModel.runID}, ${summary.primaryMetric}=${summary.bestModel.metricValue}.`
        : "No eligible complete full evaluation was obtained for this design.",
      trainingConfounders: summary.architectureEvidence.reasons,
      nextArchitectureQuestions: [],
      limitations: ["Best-model selection describes observed search performance, not an isolated architecture effect."],
    },
  })
}

export function applyArchitectureAnalysis(
  facts: ArchitectureReflection,
  value: unknown,
  model?: string,
): ArchitectureReflection {
  const analysis = ArchitectureReflectionAnalysis.parse(value)
  if (facts.designSummary.architectureEvidence.status !== "eligible")
    analysis.hypothesisAssessment = {
      status: "inconclusive",
      reason:
        facts.designSummary.architectureEvidence.reasons.join(" ") ||
        "A matched architecture comparison is unavailable.",
    }
  if (facts.designSummary.architectureEvidence.status === "confounded")
    analysis.trainingConfounders = [
      ...new Set([...facts.designSummary.architectureEvidence.reasons, ...analysis.trainingConfounders]),
    ]
  analysis.limitations = [...new Set([...facts.analysis.limitations, ...analysis.limitations])].slice(0, 12)
  return ArchitectureReflection.parse({
    ...facts,
    analysis,
    analysisStatus: "completed",
    llm: { status: "used", model },
  })
}

/** Compatibility for reports that still consume the original ReflectionAgent result. */
export function projectScopedReflection(
  evidence: ReflectionEvidence,
  reflection: TrainingReflection | ArchitectureReflection,
  maxIterations?: number,
): ReflectionAgentResult {
  const sourceIDs =
    reflection.reflectionScope === "training"
      ? [reflection.runID]
      : reflection.designSummary.trials.map((trial) => trial.runID)
  const base = summarizeReflectionAgent({
    task: evidence.task,
    runs: evidence.runs.filter((run) => sourceIDs.includes(run.id)),
    candidates: evidence.candidates,
    maxIterations,
  })
  const training = reflection.reflectionScope === "training" ? reflection : undefined
  const architecture = reflection.reflectionScope === "architecture" ? reflection : undefined
  const reason = training ? training.analysis.executionAssessment : architecture!.analysis.hypothesisAssessment.reason
  const questions = training?.analysis.nextTrainingQuestions ?? architecture!.analysis.nextArchitectureQuestions
  const analysis: ReflectionLLMAnalysis = {
    trainingHealthAssessment:
      training?.analysis.trainingHealthAssessment ?? "See the persisted same-design training reflections.",
    hypothesisValidation: architecture
      ? `${architecture.analysis.hypothesisAssessment.status}: ${reason}`
      : "Not assessed in training mode; failures and tuning gains do not establish architectural effects.",
    attributionAnalysis: training
      ? training.comparison.reasons.join(" ") || "Matched training-only contrast."
      : architecture!.designSummary.architectureEvidence.reasons.join(" ") ||
        "Original matched architecture contrast; best-model selection is separate.",
    historicalComparison:
      architecture?.analysis.designAssessment ?? "Only this trial and its named same-design source were assessed.",
    modelDesignReflection: architecture?.analysis.designAssessment ?? "The design remains fixed.",
    nextStepRecommendation:
      questions.join("\n") || "The responsible planner decides the next experiment within the shared budget.",
    distillableMemory: "Scoped working reflection saved; no shared experience was written in this stage.",
  }
  const contrast = training?.comparison ?? architecture!.designSummary.architectureEvidence
  const attributable = training
    ? training.comparison.eligible
    : architecture!.designSummary.architectureEvidence.status === "eligible"
  const contrastRunID = training?.runID ?? architecture!.designSummary.architectureEvidence.runID
  const contrastRun = evidence.runs.find((run) => run.id === contrastRunID)
  const metric = contrastRun ? finiteMetric(contrastRun, reflectionMetric(evidence.task)) : undefined
  // Legacy reports must not populate architectural "effective changes" from
  // inner-loop gains or from a comparison with whichever run happened to be best.
  const delta = attributable ? contrast.delta : undefined
  const change =
    contrastRun?.candidateID && metric !== undefined && delta !== undefined
      ? {
          candidateID: contrastRun.candidateID,
          runID: contrastRun.id,
          metricValue: metric,
          delta,
          summary: `${contrast.changedPaths.join(", ")} (named ${training ? "training" : "architecture"} comparison)`,
        }
      : undefined
  const improved = delta !== undefined && (evidence.task.objective.direction === "maximize" ? delta > 0 : delta < 0)
  return {
    ...base,
    analysis: {
      ...base.analysis,
      hypothesisTestedRuns: architecture?.designSummary.architectureEvidence.status === "eligible" ? 1 : 0,
      decision: "continue",
      decisionReason: reason,
      latestDelta: delta,
      effectiveChanges: change && improved ? [change] : [],
      ineffectiveChanges: change && !improved ? [change] : [],
      ...(architecture
        ? {
            bestMetric: architecture.designSummary.bestModel?.metricValue,
            bestRunID: architecture.designSummary.bestModel?.runID,
            bestCandidateID: architecture.designSummary.bestModel?.candidateID,
          }
        : {}),
    },
    trainingReflection: training,
    architectureReflection: architecture,
    designSummary: architecture?.designSummary,
    reflectionNotesMarkdown: `# ${reflection.reflectionScope === "training" ? "Training" : "Architecture"} reflection\n\n${reason}\n\n${analysis.historicalComparison}\n\n${analysis.attributionAnalysis}\n`,
    nextExperimentPlanMarkdown: `# Questions for the ${training ? "OptimizerAgent" : "HypoPlanner"}\n\n${analysis.nextStepRecommendation}\n`,
    llm: {
      status: reflection.llm.status === "used" ? "used" : "not_configured",
      model: reflection.llm.model,
      text: JSON.stringify(analysis),
      structured: analysis,
    },
    experienceWriteResults: [],
    knowledgeValidationResults: [],
  }
}
