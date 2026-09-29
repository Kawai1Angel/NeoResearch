import { projectCitedTaskEvidence } from "../retrieve/evidence-handoff"
import type { TaskEvidenceBundle } from "../retrieve/contract"
import type { DomainCandidateProposal, DomainCandidateRanking } from "../domain"
import type {
  JsonRecord,
  ResearchCandidate,
  ResearchCandidateID,
  ResearchRun,
  ResearchTask,
  ResearchTaskID,
} from "../schema"
import type { ExperimentPlan, HypothesisObject } from "./hypo-planner-agent"

export interface ModelDesignerComponentLibrary {
  readonly backbones: readonly string[]
  readonly preprocessing: readonly string[]
  readonly embeddings: readonly string[]
  readonly losses: readonly string[]
  readonly optimizers: readonly string[]
  readonly schedulers: readonly string[]
}

export interface ModelDesignerInput {
  readonly task: ResearchTask
  readonly dataAnalysisSummary: string
  readonly hypotheses: readonly HypothesisObject[]
  readonly componentLibrary: ModelDesignerComponentLibrary
}

export interface ModelDesignerHypothesisProposal {
  readonly selectedHypothesis: HypothesisObject
  readonly proposal: DomainCandidateProposal
}

export function buildModelDesignerComponentLibrary(input: {
  readonly actionRegistry: Record<string, Record<string, { readonly bridgeSupported: boolean }>>
  readonly bridgeOnly?: boolean
}): ModelDesignerComponentLibrary {
  function available(category: string): string[] {
    const actions = input.actionRegistry[category] ?? {}
    return Object.keys(actions).filter((name) => !input.bridgeOnly || (actions[name]?.bridgeSupported ?? false))
  }
  return {
    backbones: available("backbone"),
    preprocessing: available("preprocessing"),
    embeddings: available("embedding"),
    losses: available("loss"),
    optimizers: available("optimizer"),
    schedulers: available("scheduler"),
  }
}

function firstAvailable(suggestions: readonly string[], available: readonly string[]): string | undefined {
  return suggestions.find((s) => available.includes(s)) ?? (available.length > 0 ? available[0] : undefined)
}

function buildRationaleFromHypothesis(
  hypothesis: HypothesisObject,
  chosenBackbone: string,
  chosenPreprocessing: string,
): string {
  const parts = [
    `Hypothesis ${hypothesis.id}: ${hypothesis.statement}`,
    `Selected backbone "${chosenBackbone}" and preprocessing "${chosenPreprocessing}" to test this hypothesis.`,
    `Expected outcome: ${hypothesis.expectedOutcome}`,
  ]
  if (hypothesis.motivation.length > 0) {
    parts.push(`Evidence: ${hypothesis.motivation.slice(0, 2).join(" ")}`)
  }
  if (hypothesis.risk) {
    parts.push(`Risk: ${hypothesis.risk}`)
  }
  return parts.join(" ")
}

export function buildModelDesignerProposalFromHypotheses(
  input: ModelDesignerInput,
): ModelDesignerHypothesisProposal | undefined {
  const { componentLibrary: lib } = input
  const hypothesis = selectHypothesisFromList(input.hypotheses)
  if (!hypothesis) return undefined

  const backbone = firstAvailable(hypothesis.suggestedBackbones, lib.backbones)
  const preprocessing = firstAvailable(hypothesis.suggestedPreprocessing, lib.preprocessing)
  if (!backbone || !preprocessing) return undefined

  const loss = lib.losses.includes("mse") ? "mse" : (lib.losses[0] ?? "mse")
  const optimizer = lib.optimizers.includes("adamw") ? "adamw" : (lib.optimizers[0] ?? "adamw")
  const scheduler = lib.schedulers.includes("cosine") ? "cosine" : (lib.schedulers[0] ?? "none")

  const candidateSpec: JsonRecord = {
    recipeVersion: "recipe_schema_v2",
    hypothesis: `${hypothesis.id}: ${hypothesis.statement}`,
    preprocessing: { actions: [{ type: preprocessing }] },
    backbone: { type: backbone },
    trainingStrategy: {
      loss: { base: loss, horizonWeighting: "uniform" },
      optimizer: { type: optimizer, lr: 0.001, weightDecay: 0 },
      scheduler: { type: scheduler, warmupSteps: 0 },
      regularization: {},
      budget: { maxEpochs: 30, timeBudgetS: 1200, batchSize: 64, patience: 5, seed: 42 },
    },
  } as JsonRecord

  return {
    selectedHypothesis: hypothesis,
    proposal: {
      candidateSpec,
      rationale: buildRationaleFromHypothesis(hypothesis, backbone, preprocessing),
      riskLevel: hypothesis.priority === "high" ? "medium" : "low",
      approvalStatus: "auto_approved",
      generatedBy: "heuristic",
    },
  }
}

export type ModelDesignerSelectionSource = "existing_frontier" | "domain_proposal"
export type ModelDesignerLLMStatus = "used" | "failed" | "disabled" | "invalid"

export interface ModelDesignerResult {
  readonly agent: "ModelDesignerAgent"
  readonly taskID: ResearchTaskID
  readonly candidateID: ResearchCandidateID
  readonly recipeID: string | undefined
  readonly hypothesis: string
  readonly rationale: string
  readonly generatedBy: ResearchCandidate["generatedBy"] | "domain"
  readonly llmStatus: ModelDesignerLLMStatus
  readonly approvalStatus: ResearchCandidate["approvalStatus"]
  readonly selectionSource: ModelDesignerSelectionSource
}

export interface CandidateAttemptState {
  readonly attemptedCandidateIDs: Set<ResearchCandidateID>
  readonly inconclusiveCandidateIDs: Set<ResearchCandidateID>
}

export interface ModelDesignerCandidateSelection {
  readonly candidate: ResearchCandidate | undefined
  readonly selectionSource: ModelDesignerSelectionSource
  readonly readyCandidateIDs: readonly ResearchCandidateID[]
  readonly attemptedCandidateIDs: readonly ResearchCandidateID[]
  readonly inconclusiveCandidateIDs: readonly ResearchCandidateID[]
  readonly rankings: readonly DomainCandidateRanking[]
}

function metricValue(metrics: JsonRecord, name: string | undefined) {
  if (name === undefined) return undefined
  const value = metrics[name]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function isApproved(candidate: ResearchCandidate) {
  return candidate.approvalStatus === "approved" || candidate.approvalStatus === "auto_approved"
}

function unique(items: readonly string[]) {
  return [...new Set(items.filter((item) => item.length > 0))]
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

export function candidateAttemptStateFromRuns(input: {
  readonly runs: readonly ResearchRun[]
  readonly maxFailedRetries: number
  readonly primaryMetricName?: string
}): CandidateAttemptState {
  const retryableCounts = new Map<ResearchCandidateID, number>()
  const attemptedCandidateIDs = new Set<ResearchCandidateID>()
  const inconclusiveCandidateIDs = new Set<ResearchCandidateID>()
  for (const run of input.runs) {
    if (run.candidateID === undefined || run.status === "invalid") continue
    if (run.status === "failed") {
      retryableCounts.set(run.candidateID, (retryableCounts.get(run.candidateID) ?? 0) + 1)
      continue
    }
    if (
      run.status === "succeeded" &&
      input.primaryMetricName !== undefined &&
      metricValue(run.metrics, input.primaryMetricName) === undefined
    ) {
      inconclusiveCandidateIDs.add(run.candidateID)
      retryableCounts.set(run.candidateID, (retryableCounts.get(run.candidateID) ?? 0) + 1)
      continue
    }
    attemptedCandidateIDs.add(run.candidateID)
  }
  for (const [candidateID, count] of retryableCounts) {
    if (count > input.maxFailedRetries) attemptedCandidateIDs.add(candidateID)
  }
  return {
    attemptedCandidateIDs,
    inconclusiveCandidateIDs,
  }
}

export function buildExistingFrontierRankings(input: {
  readonly candidates: readonly ResearchCandidate[]
  readonly readyCandidateIDs: readonly ResearchCandidateID[]
}): DomainCandidateRanking[] {
  const candidatesByID = new Map(input.candidates.map((candidate) => [candidate.id, candidate]))
  return input.readyCandidateIDs.flatMap((candidateID, index) => {
    const candidate = candidatesByID.get(candidateID)
    if (candidate === undefined) return []
    return [
      {
        rank: index + 1,
        score: input.readyCandidateIDs.length - index,
        reasons: ["existing approved frontier candidate"],
        predictorVersion: "existing_frontier_v1",
        candidateSpec: candidate.candidateSpec,
        rationale: candidate.rationale,
        riskLevel: candidate.riskLevel,
        approvalStatus: candidate.approvalStatus,
        generatedBy: candidate.generatedBy,
      },
    ]
  })
}

export function selectModelDesignerCandidate(input: {
  readonly candidates: readonly ResearchCandidate[]
  readonly runs: readonly ResearchRun[]
  readonly primaryMetricName?: string
  readonly maxFailedRetries: number
}): ModelDesignerCandidateSelection {
  const attemptState = candidateAttemptStateFromRuns({
    runs: input.runs,
    maxFailedRetries: input.maxFailedRetries,
    primaryMetricName: input.primaryMetricName,
  })
  const readyCandidateIDs = input.candidates
    .filter((candidate) => isApproved(candidate) && !attemptState.attemptedCandidateIDs.has(candidate.id))
    .map((candidate) => candidate.id)
  const retryCandidate = input.candidates.find(
    (candidate) =>
      isApproved(candidate) &&
      attemptState.inconclusiveCandidateIDs.has(candidate.id) &&
      !attemptState.attemptedCandidateIDs.has(candidate.id),
  )
  const candidate =
    retryCandidate ??
    input.candidates.find(
      (item) => isApproved(item) && !attemptState.attemptedCandidateIDs.has(item.id),
    )
  return {
    candidate,
    selectionSource: "existing_frontier",
    readyCandidateIDs,
    attemptedCandidateIDs: [...attemptState.attemptedCandidateIDs],
    inconclusiveCandidateIDs: [...attemptState.inconclusiveCandidateIDs],
    rankings: buildExistingFrontierRankings({ candidates: input.candidates, readyCandidateIDs }),
  }
}

export function selectHypothesisFromList(hypotheses: readonly HypothesisObject[]): HypothesisObject | undefined {
  // The pool includes historical hypotheses in creation order. Closed directions
  // must not constrain new designs; prefer the latest planner pivot on priority ties.
  const eligible = hypotheses.filter((item) =>
    item.testable && (!item.status || ["pending", "active", "testing"].includes(item.status)),
  )
  const priorityOrder: readonly HypothesisObject["priority"][] = ["high", "medium", "low"]
  for (const priority of priorityOrder) {
    const hypothesis = eligible.findLast((item) => item.priority === priority)
    if (hypothesis !== undefined) return hypothesis
  }
  return undefined
}

export function selectHypothesisForDesign(plan: ExperimentPlan | undefined): HypothesisObject | undefined {
  return plan === undefined ? undefined : selectHypothesisFromList(plan.hypotheses)
}

export function buildModelDesignerTaskFingerprint(input: {
  readonly taskEvidence?: TaskEvidenceBundle
  readonly baseFingerprint: JsonRecord
  readonly hypothesisPlan?: ExperimentPlan
  readonly selectedHypothesis?: HypothesisObject
  readonly reflectionHypotheses?: readonly string[]
}): JsonRecord {
  const base = recordValue(input.baseFingerprint)
  const baseBiases = Array.isArray(base.searchBiases)
    ? base.searchBiases.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []
  const planBiases = input.hypothesisPlan?.searchBiases ?? []
  const hypothesisBiases =
    input.selectedHypothesis === undefined
      ? []
      : [
          `hypothesis:${input.selectedHypothesis.id}`,
          ...input.selectedHypothesis.suggestedBackbones.map((item) => `prefer_backbone:${item}`),
          ...input.selectedHypothesis.suggestedPreprocessing.map((item) => `prefer_preprocessing:${item}`),
        ]
  return {
    ...input.baseFingerprint,
    ...(input.selectedHypothesis?.literatureEvidence?.length ? {
      taskEvidence: projectCitedTaskEvidence(input.taskEvidence, input.selectedHypothesis.literatureEvidence),
    } : {}),
    searchBiases: unique([
      ...baseBiases,
      ...planBiases,
      ...hypothesisBiases,
      ...(input.reflectionHypotheses ?? []),
    ]),
  } as JsonRecord
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function candidateRecipeID(candidateSpec: JsonRecord) {
  return stringValue(recordValue(candidateSpec).recipeID)
}

function candidateHypothesis(candidateSpec: JsonRecord) {
  return stringValue(recordValue(candidateSpec).hypothesis)
}

export function buildModelDesignerResult(input: {
  readonly taskID: ResearchTaskID
  readonly candidate: ResearchCandidate
  readonly selectedHypothesis?: HypothesisObject
  readonly rationale: string
  readonly llmStatus: ModelDesignerLLMStatus
  readonly selectionSource: ModelDesignerSelectionSource
}): ModelDesignerResult {
  return {
    agent: "ModelDesignerAgent",
    taskID: input.taskID,
    candidateID: input.candidate.id,
    recipeID: candidateRecipeID(input.candidate.candidateSpec),
    hypothesis:
      candidateHypothesis(input.candidate.candidateSpec) ??
      input.selectedHypothesis?.id ??
      "Candidate hypothesis not recorded.",
    rationale: input.rationale,
    generatedBy: input.candidate.generatedBy,
    llmStatus: input.llmStatus,
    approvalStatus: input.candidate.approvalStatus,
    selectionSource: input.selectionSource,
  }
}
