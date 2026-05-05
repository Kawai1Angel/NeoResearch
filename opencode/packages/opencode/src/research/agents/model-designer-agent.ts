import type { DomainCandidateRanking } from "../domain"
import type {
  JsonRecord,
  ResearchCandidate,
  ResearchCandidateID,
  ResearchRun,
  ResearchTaskID,
} from "../schema"
import type { ExperimentPlan, HypothesisObject } from "./hypo-planner-agent"

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
    if (run.candidateID === undefined) continue
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

export function selectHypothesisForDesign(plan: ExperimentPlan | undefined): HypothesisObject | undefined {
  if (plan === undefined || plan.hypotheses.length === 0) return undefined
  const priorityOrder: readonly HypothesisObject["priority"][] = ["high", "medium", "low"]
  for (const priority of priorityOrder) {
    const hypothesis = plan.hypotheses.find((item) => item.testable && item.priority === priority)
    if (hypothesis !== undefined) return hypothesis
  }
  return plan.hypotheses.find((item) => item.testable) ?? plan.hypotheses[0]
}

export function buildModelDesignerTaskFingerprint(input: {
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
