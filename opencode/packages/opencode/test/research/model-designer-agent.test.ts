import { expect, test } from "bun:test"
import {
  buildExistingFrontierRankings,
  buildModelDesignerComponentLibrary,
  buildModelDesignerProposalFromHypotheses,
  buildModelDesignerResult,
  buildModelDesignerTaskFingerprint,
  candidateAttemptStateFromRuns,
  selectHypothesisForDesign,
  selectHypothesisFromList,
  selectModelDesignerCandidate,
  type ModelDesignerInput,
} from "../../src/research/agents/model-designer-agent"
import type { ExperimentPlan, HypothesisObject } from "../../src/research/agents/hypo-planner-agent"
import type { JsonRecord, ResearchCandidate, ResearchRun, ResearchTask } from "../../src/research/schema"
import { buildUserPrompt } from "../../src/research/llm-proposal"
import { buildReflectionPlanningMarkdown } from "../../src/research/agents/reflection-agent"

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

function run(input: { id: string; candidateID: string; status: ResearchRun["status"]; metric?: number }): ResearchRun {
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
        expectedOutcome: "val_avg_mse should decrease with decomposition-aware backbone.",
        suggestedBackbones: ["dlinear", "patch_transformer"],
        suggestedPreprocessing: ["seasonal_decomposition"],
        priority: "high",
        risk: "period may drift",
        testable: true,
        datasetEvidencePaths: [],
        literatureEvidence: [],
        applicabilityAssumptions: [],
        falsificationCriteria: ["Reject if val_avg_mse does not improve."],
        evidenceLevel: "data_only",
      },
      {
        id: "H2",
        statement: "low priority fallback.",
        motivation: [],
        expectedOutcome: "val_avg_mse should not regress from the current best.",
        suggestedBackbones: ["linear"],
        suggestedPreprocessing: [],
        priority: "low",
        risk: "underfit",
        testable: true,
        datasetEvidencePaths: [],
        literatureEvidence: [],
        applicabilityAssumptions: [],
        falsificationCriteria: ["Reject if val_avg_mse regresses."],
        evidenceLevel: "data_only",
      },
    ],
    nextExperiment: { action: "experiment", hypothesisID: "H1", rationale: "Test decomposition explicitly." },
    baselineStrategy: "planner_selected_experiments",
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

test("multiple eligible candidates do not imply a queue or retry priority", () => {
  const untouched = candidate({ id: "rcnd_untouched" })
  const retry = candidate({ id: "rcnd_retry" })
  const selection = selectModelDesignerCandidate({
    candidates: [untouched, retry],
    runs: [run({ id: "rrun_retry_missing", candidateID: retry.id, status: "succeeded" })],
    primaryMetricName: "val_avg_mse",
    maxFailedRetries: 1,
  })

  expect(selection.candidate).toBeUndefined()
  expect(
    selectModelDesignerCandidate({ candidates: [retry, untouched], runs: [], maxFailedRetries: 1 }).candidate,
  ).toBeUndefined()
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

test("frontier diagnostics assign no preference scores", () => {
  const c1 = candidate({ id: "rcnd_a", recipeID: "recipe_a" })
  const c2 = candidate({ id: "rcnd_b", recipeID: "recipe_b" })
  const rankings = buildExistingFrontierRankings({
    candidates: [c1, c2],
    readyCandidateIDs: [c2.id, c1.id],
  })

  expect(rankings.map((item) => item.rank)).toEqual([1, 1])
  expect(rankings.map((item) => item.score)).toEqual([0, 0])
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
  expect(fingerprint.selectedHypothesis).toEqual({ ...hypothesis })
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

const tsfActionRegistry = {
  backbone: {
    linear: { bridgeSupported: true },
    mlp: { bridgeSupported: true },
    transformer: { bridgeSupported: true },
    dlinear: { bridgeSupported: false },
    mixer: { bridgeSupported: false },
  },
  preprocessing: {
    none: { bridgeSupported: true },
    instance_norm: { bridgeSupported: true },
    series_decomposition: { bridgeSupported: false },
  },
  embedding: {
    none: { bridgeSupported: true },
    patch: { bridgeSupported: true },
  },
  loss: {
    mse: { bridgeSupported: true },
    mae: { bridgeSupported: true },
  },
  optimizer: {
    adam: { bridgeSupported: true },
    adamw: { bridgeSupported: true },
  },
  scheduler: {
    none: { bridgeSupported: true },
    cosine: { bridgeSupported: true },
  },
}

test("buildModelDesignerComponentLibrary returns all available components when bridgeOnly is false", () => {
  const lib = buildModelDesignerComponentLibrary({ actionRegistry: tsfActionRegistry, bridgeOnly: false })
  expect(lib.backbones).toContain("dlinear")
  expect(lib.backbones).toContain("mixer")
  expect(lib.preprocessing).toContain("series_decomposition")
})

test("buildModelDesignerComponentLibrary filters to bridgeSupported components when bridgeOnly is true", () => {
  const lib = buildModelDesignerComponentLibrary({ actionRegistry: tsfActionRegistry, bridgeOnly: true })
  expect(lib.backbones).toContain("linear")
  expect(lib.backbones).not.toContain("dlinear")
  expect(lib.preprocessing).not.toContain("series_decomposition")
  expect(lib.preprocessing).toContain("instance_norm")
})

function hypothesisForDesign(overrides?: Partial<HypothesisObject>): HypothesisObject {
  return {
    id: "H1",
    statement: "seasonal structure needs decomposition.",
    motivation: ["seasonalityStrength=0.7"],
    expectedOutcome: "val_avg_mse should decrease with decomposition-aware backbone.",
    suggestedBackbones: ["dlinear"],
    suggestedPreprocessing: ["series_decomposition"],
    priority: "high",
    risk: "period may drift",
    testable: true,
    datasetEvidencePaths: [],
    literatureEvidence: [],
    applicabilityAssumptions: [],
    falsificationCriteria: ["Reject if val_avg_mse does not improve."],
    evidenceLevel: "data_only",
    ...overrides,
  }
}

function designerInput(
  hypotheses: readonly HypothesisObject[],
  bridgeOnly = false,
  selectedHypothesisID = "H1",
): ModelDesignerInput {
  const lib = buildModelDesignerComponentLibrary({ actionRegistry: tsfActionRegistry, bridgeOnly })
  return {
    task: task(),
    dataAnalysisSummary: "seasonalityStrength=0.7, trendStrength=0.3",
    hypotheses,
    selectedHypothesisID,
    componentLibrary: lib,
  }
}

test("selectHypothesisFromList returns undefined for an empty list", () => {
  expect(selectHypothesisFromList([])).toBeUndefined()
})

test("selection requires an explicit ID and ignores priority and pool order", () => {
  const h1 = hypothesisForDesign({ id: "H1", priority: "low" })
  const h2 = hypothesisForDesign({ id: "H2", priority: "high" })
  const h3 = hypothesisForDesign({ id: "H3", priority: "medium" })
  for (const pool of [
    [h1, h2, h3],
    [h3, h2, h1],
  ]) {
    expect(selectHypothesisFromList(pool)).toBeUndefined()
    expect(selectHypothesisFromList(pool, "H1")?.id).toBe("H1")
    expect(selectHypothesisFromList(pool, "missing")).toBeUndefined()
  }
})

test("selection rejects a non-testable ID without choosing another hypothesis", () => {
  const nonTestable = hypothesisForDesign({ id: "H1", testable: false, priority: "high" })
  const testable = hypothesisForDesign({ id: "H2", testable: true, priority: "low" })
  expect(selectHypothesisFromList([nonTestable, testable], "H1")).toBeUndefined()
  expect(selectHypothesisFromList([nonTestable, testable], "H2")?.id).toBe("H2")
})

test("buildModelDesignerProposalFromHypotheses returns undefined for an empty hypothesis list", () => {
  expect(buildModelDesignerProposalFromHypotheses(designerInput([]))).toBeUndefined()
})

test("proposal uses the explicitly selected hypothesis and matching components", () => {
  const low = hypothesisForDesign({ id: "H_low", priority: "low" })
  const high = hypothesisForDesign({ id: "H_high", priority: "high" })
  const result = buildModelDesignerProposalFromHypotheses(designerInput([low, high], false, "H_low"))
  expect(result).toBeDefined()
  expect(result!.selectedHypothesis.id).toBe("H_low")
  const spec = result!.proposal.candidateSpec as Record<string, unknown>
  expect((spec.backbone as Record<string, unknown>).type).toBe("dlinear")
  expect(((spec.preprocessing as Record<string, unknown>).actions as Array<Record<string, unknown>>)[0]!.type).toBe(
    "series_decomposition",
  )
})

test("proposal does not substitute unsupported suggestions with the first library component", () => {
  expect(buildModelDesignerProposalFromHypotheses(designerInput([hypothesisForDesign()], true))).toBeUndefined()
})

test("ambiguous component suggestions require an explicit model design", () => {
  for (const suggestedBackbones of [
    ["linear", "mlp"],
    ["mlp", "linear"],
  ]) {
    expect(
      buildModelDesignerProposalFromHypotheses(designerInput([hypothesisForDesign({ suggestedBackbones })])),
    ).toBeUndefined()
  }
})

test("buildModelDesignerProposalFromHypotheses embeds hypothesis id and statement in candidateSpec and rationale", () => {
  const hypothesis = hypothesisForDesign()
  const result = buildModelDesignerProposalFromHypotheses(designerInput([hypothesis]))!
  const spec = result.proposal.candidateSpec as Record<string, unknown>
  expect((spec.hypothesis as string).includes("H1")).toBe(true)
  expect(result.proposal.rationale).toContain("H1")
  expect(result.proposal.rationale).toContain(hypothesis.expectedOutcome)
})

test("proposal risk uses explicit risk rather than priority", () => {
  const result = buildModelDesignerProposalFromHypotheses(designerInput([hypothesisForDesign({ priority: "high" })]))!
  expect(result.proposal.riskLevel).toBe("medium")
})

test("proposal with no stated risk is low risk regardless of priority", () => {
  const result = buildModelDesignerProposalFromHypotheses(
    designerInput([hypothesisForDesign({ priority: "high", risk: "" })]),
  )!
  expect(result.proposal.riskLevel).toBe("low")
})

test("design selection ignores closed hypotheses even when they have higher priority", () => {
  for (const status of ["abandoned", "rejected", "confirmed"] as const) {
    const closed = hypothesisForDesign({ id: "closed", status, priority: "high" })
    const pending = hypothesisForDesign({ id: "pending", status: "pending", priority: "medium" })
    expect(selectHypothesisFromList([closed, pending], "pending")?.id).toBe("pending")
    expect(selectHypothesisFromList([closed, pending], "closed")).toBeUndefined()
  }
  expect(selectHypothesisFromList([hypothesisForDesign({ testable: false })], "H1")).toBeUndefined()
})

test("design selection follows explicit planner choice regardless of priority or creation order", () => {
  const old = hypothesisForDesign({ id: "old", status: "pending" })
  const pivot = hypothesisForDesign({ id: "pivot", status: "pending", suggestedBackbones: ["diagonal_ssm"] })
  const selected = selectHypothesisForDesign({
    ...plan(),
    hypotheses: [old, pivot],
    nextExperiment: {
      action: "experiment",
      hypothesisID: "pivot",
      rationale: "Test the unexplored state-space direction.",
    },
  })
  expect(selected).toEqual(pivot)
  const fingerprint = buildModelDesignerTaskFingerprint({ baseFingerprint: {}, selectedHypothesis: selected })
  expect(fingerprint.searchBiases).toContain("hypothesis:pivot")
  expect(fingerprint.searchBiases).toContain("prefer_backbone:diagonal_ssm")
  expect(fingerprint.selectedHypothesis).toEqual({ ...pivot })
})

test("final design prompt carries refined hypothesis criteria and concrete reflection advice", () => {
  const selected = hypothesisForDesign({
    id: "repair_mamba",
    suggestedBackbones: ["mamba"],
    motivation: ["Previous run timed out; lower optimizer.lr from 0.0001 to 0.00002."],
    falsificationCriteria: ["Judge only after complete cv_avg_mse; freeze depth=2."],
  })
  const fingerprint = buildModelDesignerTaskFingerprint({ baseFingerprint: {}, selectedHypothesis: selected })
  const reflection = buildReflectionPlanningMarkdown({
    reflectionNotesMarkdown: "Generic structural notes.",
    llm: { status: "used", text: "Use training_strategy.scheduler.warmup_steps=5; grad_clip=1 already enabled." },
  })
  const prompt = JSON.parse(
    buildUserPrompt({
      task: task(),
      proposalContext: { taskSpec: {}, taskFingerprint: fingerprint, candidates: [], runs: [], memory: [] },
      previousReflectionMarkdown: reflection,
    }),
  )
  expect(prompt.taskFingerprint.selectedHypothesis).toEqual(selected)
  expect(prompt.previousSessionReflection).toContain("warmup_steps=5")
  expect(prompt.previousSessionReflection).toContain("grad_clip=1 already enabled")
  expect(prompt.instruction).toContain("concrete recipe fields")
})

test("explicit planner choice never falls back to another hypothesis", () => {
  const h = hypothesisForDesign()
  expect(selectHypothesisForDesign({ ...plan(), nextExperiment: undefined })).toBeUndefined()
  for (const decision of [
    { action: "stop" as const, rationale: "Evidence exhausted" },
    { action: "experiment" as const, hypothesisID: "missing", rationale: "Invalid selection" },
  ])
    expect(selectHypothesisForDesign({ ...plan(), hypotheses: [h], nextExperiment: decision })).toBeUndefined()
  expect(
    selectHypothesisForDesign({
      ...plan(),
      hypotheses: [hypothesisForDesign({ status: "abandoned" })],
      nextExperiment: { action: "experiment", hypothesisID: h.id, rationale: "Closed choice" },
    }),
  ).toBeUndefined()
})
