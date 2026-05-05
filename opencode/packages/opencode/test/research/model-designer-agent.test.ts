import { expect, test } from "bun:test"
import {
  buildExistingFrontierRankings,
  buildModelDesignerResult,
  buildModelDesignerTaskFingerprint,
  candidateAttemptStateFromRuns,
  selectHypothesisForDesign,
  selectModelDesignerCandidate,
} from "../../src/research/agents/model-designer-agent"
import type { ExperimentPlan } from "../../src/research/agents/hypo-planner-agent"
import type { JsonRecord, ResearchCandidate, ResearchRun, ResearchTask } from "../../src/research/schema"

function candidate(input: {
  id: string
  recipeID?: string
  hypothesis?: string
  approvalStatus?: ResearchCandidate["approvalStatus"]
  generatedBy?: ResearchCandidate["generatedBy"]
}): ResearchCandidate {
  return {
    id: input.id,
    taskID: "rtsk_designer",
    domainID: "tsf",
    candidateSpec: {
      recipeID: input.recipeID,
      hypothesis: input.hypothesis,
    },
    rationale: `Rationale for ${input.id}`,
    riskLevel: "low",
    approvalStatus: input.approvalStatus ?? "auto_approved",
    generatedBy: input.generatedBy ?? "heuristic",
    time: { created: 1, updated: 1 },
  } as unknown as ResearchCandidate
}

function run(input: {
  id: string
  candidateID: string
  status: ResearchRun["status"]
  metric?: number
}): ResearchRun {
  return {
    id: input.id,
    taskID: "rtsk_designer",
    candidateID: input.candidateID,
    stage: "full",
    status: input.status,
    metrics: input.metric === undefined ? {} : { val_avg_mse: input.metric },
    resourceUsage: {},
    artifactRefs: [],
    time: { created: 1, updated: 1 },
  } as unknown as ResearchRun
}

function task(): ResearchTask {
  return {
    id: "rtsk_designer",
    projectID: "proj_designer",
    title: "Designer task",
    domainID: "tsf",
    mode: "autonomous",
    status: "searching",
    taskSpec: {},
    objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
    budget: {},
    time: { created: 1, updated: 1 },
  } as unknown as ResearchTask
}

function plan(): ExperimentPlan {
  return {
    hypotheses: [
      {
        id: "H1",
        statement: "seasonal structure needs decomposition.",
        motivation: ["seasonalityStrength=0.7"],
        suggestedBackbones: ["dlinear", "patch_transformer"],
        suggestedPreprocessing: ["seasonal_decomposition"],
        priority: "high",
        risk: "period may drift",
        testable: true,
      },
      {
        id: "H2",
        statement: "low priority fallback.",
        motivation: [],
        suggestedBackbones: ["linear"],
        suggestedPreprocessing: [],
        priority: "low",
        risk: "underfit",
        testable: true,
      },
    ],
    baselineStrategy: "domain_baselines_first",
    searchBiases: ["seasonal", "trend"],
    stopConditions: { maxTrials: 8, noImprovementRounds: 2 },
  }
}

test("candidateAttemptStateFromRuns leaves retryable failures available until retry budget is exceeded", () => {
  const failedOnce = candidate({ id: "rcnd_failed_once" })
  const failedTwice = candidate({ id: "rcnd_failed_twice" })
  const state = candidateAttemptStateFromRuns({
    runs: [
      run({ id: "rrun_failed_1", candidateID: failedOnce.id, status: "failed" }),
      run({ id: "rrun_failed_2a", candidateID: failedTwice.id, status: "failed" }),
      run({ id: "rrun_failed_2b", candidateID: failedTwice.id, status: "failed" }),
    ],
    maxFailedRetries: 1,
    primaryMetricName: "val_avg_mse",
  })

  expect(state.attemptedCandidateIDs.has(failedOnce.id)).toBe(false)
  expect(state.attemptedCandidateIDs.has(failedTwice.id)).toBe(true)
  expect(state.inconclusiveCandidateIDs.size).toBe(0)
})

test("candidateAttemptStateFromRuns treats successful runs without the primary metric as inconclusive", () => {
  const noMetric = candidate({ id: "rcnd_no_metric" })
  const withMetric = candidate({ id: "rcnd_with_metric" })
  const state = candidateAttemptStateFromRuns({
    runs: [
      run({ id: "rrun_missing", candidateID: noMetric.id, status: "succeeded" }),
      run({ id: "rrun_metric", candidateID: withMetric.id, status: "succeeded", metric: 0.42 }),
    ],
    maxFailedRetries: 1,
    primaryMetricName: "val_avg_mse",
  })

  expect(state.inconclusiveCandidateIDs.has(noMetric.id)).toBe(true)
  expect(state.attemptedCandidateIDs.has(noMetric.id)).toBe(false)
  expect(state.attemptedCandidateIDs.has(withMetric.id)).toBe(true)
})

test("selectModelDesignerCandidate prefers an inconclusive approved candidate before untouched frontier candidates", () => {
  const untouched = candidate({ id: "rcnd_untouched" })
  const retry = candidate({ id: "rcnd_retry" })
  const selection = selectModelDesignerCandidate({
    candidates: [untouched, retry],
    runs: [run({ id: "rrun_retry_missing", candidateID: retry.id, status: "succeeded" })],
    primaryMetricName: "val_avg_mse",
    maxFailedRetries: 1,
  })

  expect(selection.candidate?.id).toBe(retry.id)
  expect(selection.readyCandidateIDs).toEqual([untouched.id, retry.id])
  expect(selection.inconclusiveCandidateIDs).toEqual([retry.id])
  expect(selection.selectionSource).toBe("existing_frontier")
})

test("selectModelDesignerCandidate skips attempted and pending candidates", () => {
  const attempted = candidate({ id: "rcnd_attempted" })
  const pending = candidate({ id: "rcnd_pending", approvalStatus: "pending" })
  const next = candidate({ id: "rcnd_next" })
  const selection = selectModelDesignerCandidate({
    candidates: [attempted, pending, next],
    runs: [run({ id: "rrun_attempted", candidateID: attempted.id, status: "succeeded", metric: 0.3 })],
    primaryMetricName: "val_avg_mse",
    maxFailedRetries: 1,
  })

  expect(selection.candidate?.id).toBe(next.id)
  expect(selection.readyCandidateIDs).toEqual([next.id])
  expect(selection.attemptedCandidateIDs).toEqual([attempted.id])
})

test("buildExistingFrontierRankings mirrors ready candidate order with stable scores", () => {
  const c1 = candidate({ id: "rcnd_a", recipeID: "recipe_a" })
  const c2 = candidate({ id: "rcnd_b", recipeID: "recipe_b" })
  const rankings = buildExistingFrontierRankings({
    candidates: [c1, c2],
    readyCandidateIDs: [c2.id, c1.id],
  })

  expect(rankings.map((item) => item.rank)).toEqual([1, 2])
  expect(rankings.map((item) => item.score)).toEqual([2, 1])
  expect(rankings[0]!.candidateSpec.recipeID).toBe("recipe_b")
  expect(rankings[0]!.reasons).toContain("existing approved frontier candidate")
})

test("buildModelDesignerTaskFingerprint merges plan biases and the selected hypothesis design hints", () => {
  const hypothesis = selectHypothesisForDesign(plan())
  const fingerprint = buildModelDesignerTaskFingerprint({
    baseFingerprint: { searchBiases: ["seasonal", "bridge_safe"], targetCount: 2 } as JsonRecord,
    hypothesisPlan: plan(),
    selectedHypothesis: hypothesis,
    reflectionHypotheses: ["try_small_batch"],
  })

  expect(fingerprint.searchBiases).toEqual([
    "seasonal",
    "bridge_safe",
    "trend",
    "hypothesis:H1",
    "prefer_backbone:dlinear",
    "prefer_backbone:patch_transformer",
    "prefer_preprocessing:seasonal_decomposition",
    "try_small_batch",
  ])
  expect(fingerprint.targetCount).toBe(2)
})

test("buildModelDesignerResult records candidate identity, recipe, hypothesis, and selection source", () => {
  const selected = candidate({
    id: "rcnd_selected",
    recipeID: "recipe_selected",
    hypothesis: "Candidate-specific hypothesis.",
    generatedBy: "mutation",
  })
  const result = buildModelDesignerResult({
    taskID: task().id,
    candidate: selected,
    selectedHypothesis: selectHypothesisForDesign(plan()),
    rationale: "Selected an existing frontier candidate.",
    llmStatus: "disabled",
    selectionSource: "existing_frontier",
  })

  expect(result).toMatchObject({
    agent: "ModelDesignerAgent",
    taskID: "rtsk_designer",
    candidateID: "rcnd_selected",
    recipeID: "recipe_selected",
    hypothesis: "Candidate-specific hypothesis.",
    rationale: "Selected an existing frontier candidate.",
    generatedBy: "mutation",
    llmStatus: "disabled",
    approvalStatus: "auto_approved",
    selectionSource: "existing_frontier",
  })
})
