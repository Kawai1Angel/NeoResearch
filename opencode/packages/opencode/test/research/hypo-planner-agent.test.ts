import { expect, test } from "bun:test"
import {
  buildExperimentPlan,
  buildHypoPlanMarkdown,
  buildHypoPlannerResult,
  buildHypothesesYaml,
  extractEvidenceSummary,
  generateHypotheses,
} from "../../src/research/agents/hypo-planner-agent"
import type { ResearchMemory, ResearchRun, ResearchTask } from "../../src/research/schema"

function task(extraSpec: Record<string, unknown> = {}, extraBudget: Record<string, unknown> = {}): ResearchTask {
  return {
    id: "rtsk_hypo",
    projectID: "proj_hypo",
    title: "ETTh1 horizon 96",
    domainID: "tsf",
    mode: "autonomous",
    status: "data_analysis",
    taskSpec: {
      datasetProfile: {
        seasonalityStrength: 0.72,
        trendStrength: 0.41,
        crossVarCorrelation: 0.66,
        missingRate: 0.03,
        distributionShift: 0.11,
      },
      searchBiases: ["seasonal", "trend", "cross_var_correlated", "missing_values"],
      ...extraSpec,
    },
    objective: { primaryMetric: "val_avg_mse", direction: "minimize", targetMetricValue: 0.2 },
    budget: { maxRuns: 9, maxNoImprove: 2, ...extraBudget },
    time: { created: 1, updated: 1 },
  } as unknown as ResearchTask
}

function dataAnalysisSummary(biases: readonly string[] = ["seasonal", "cross_var_correlated"]): string {
  return [
    "# Dataset Analysis Summary",
    "",
    `Search biases detected: ${biases.join(", ") || "none"}`,
    "1 warning",
    "2 source artifacts",
  ].join("\n")
}

function run(input: { id: string; status: ResearchRun["status"]; metric?: number; error?: string }): ResearchRun {
  return {
    id: input.id,
    taskID: "rtsk_hypo",
    candidateID: "rcnd_candidate",
    stage: "full",
    status: input.status,
    metrics: input.metric === undefined ? {} : { val_avg_mse: input.metric },
    resourceUsage: {},
    artifactRefs: [],
    error: input.error,
    time: { created: 1, updated: 1 },
  } as unknown as ResearchRun
}

function memory(lesson: string): ResearchMemory {
  return {
    id: "rmem_hypo",
    taskID: "rtsk_hypo",
    domainID: "tsf",
    fingerprintSummary: {},
    candidateSummary: {},
    outcome: "accepted",
    lesson,
    time: { created: 1, updated: 1 },
  } as unknown as ResearchMemory
}

test("extractEvidenceSummary truncates and returns the data analysis markdown", () => {
  const input = dataAnalysisSummary(["seasonal", "missing_values"])
  const summary = extractEvidenceSummary(input)
  expect(summary).toContain("seasonal")
  expect(summary).toContain("missing_values")
  expect(summary).toContain("1 warning")
  expect(summary).toContain("2 source artifacts")
})

test("generateHypotheses creates prioritized seasonal, trend, and channel hypotheses from task evidence", () => {
  const hypotheses = generateHypotheses({
    task: task(),
    dataAnalysisSummary: dataAnalysisSummary(["seasonal", "cross_var_correlated"]),
    runs: [],
    memory: [],
  })

  expect(hypotheses.map((item) => item.id)).toEqual(["H1", "H2", "H3", "H4"])
  expect(hypotheses[0]).toMatchObject({
    priority: "high",
    testable: true,
  })
  expect(hypotheses[0]!.statement).toContain("seasonal")
  expect(hypotheses[0]!.suggestedBackbones).toContain("dlinear")
  expect(hypotheses[1]!.statement).toContain("trend")
  expect(hypotheses[2]!.statement).toContain("cross-variate")
  expect(hypotheses[3]!.statement).toContain("missing")
})

test("generateHypotheses includes history and memory evidence in motivations", () => {
  const hypotheses = generateHypotheses({
    task: task({ searchBiases: ["distribution_shift"] }),
    dataAnalysisSummary: dataAnalysisSummary(["distribution_shift"]),
    runs: [
      run({ id: "rrun_ok", status: "succeeded", metric: 0.42 }),
      run({ id: "rrun_nan", status: "failed", error: "loss became nan" }),
    ],
    memory: [memory("Robust scaling helped a related high-shift dataset.")],
  })

  expect(hypotheses[0]!.statement).toContain("distribution shift")
  expect(hypotheses[0]!.motivation.join("\n")).toContain("1 succeeded")
  expect(hypotheses[0]!.motivation.join("\n")).toContain("1 failed")
  expect(hypotheses[0]!.motivation.join("\n")).toContain("Robust scaling")
  expect(hypotheses[0]!.suggestedPreprocessing).toContain("robust_scaling")
})

test("generateHypotheses falls back to a baseline-control hypothesis without profile signals", () => {
  const hypotheses = generateHypotheses({
    task: task({ datasetProfile: {}, searchBiases: [] }, { maxRuns: 1 }),
    dataAnalysisSummary: dataAnalysisSummary([]),
    runs: [],
    memory: [],
  })

  expect(hypotheses).toHaveLength(1)
  expect(hypotheses[0]).toMatchObject({
    id: "H1",
    priority: "medium",
    suggestedBackbones: ["linear", "dlinear"],
    testable: true,
  })
})

test("buildExperimentPlan derives stop conditions and deduplicated search biases", () => {
  const hypotheses = generateHypotheses({
    task: task(),
    dataAnalysisSummary: dataAnalysisSummary(["seasonal", "trend"]),
    runs: [],
    memory: [],
  })
  const plan = buildExperimentPlan({ hypotheses, task: task() })

  expect(plan.baselineStrategy).toBe("domain_baselines_first")
  expect(plan.searchBiases).toContain("seasonal")
  expect(plan.searchBiases).toContain("trend")
  expect(plan.searchBiases.filter((item) => item === "seasonal")).toHaveLength(1)
  expect(plan.stopConditions).toEqual({
    maxTrials: 9,
    noImprovementRounds: 2,
    targetMetricValue: 0.2,
  })
})

test("buildExperimentPlan only sets referenceBaseline on the first call", () => {
  const hypotheses = generateHypotheses({
    task: task(),
    dataAnalysisSummary: dataAnalysisSummary(["seasonal", "trend"]),
    runs: [],
    memory: [],
  })

  const firstCall = buildExperimentPlan({ hypotheses, task: task(), isFirstCall: true })
  expect(firstCall.referenceBaseline).toBe("tsf_baseline_dlinear")

  const laterCall = buildExperimentPlan({ hypotheses, task: task(), isFirstCall: false })
  expect(laterCall.referenceBaseline).toBeUndefined()

  const defaultCall = buildExperimentPlan({ hypotheses, task: task() })
  expect(defaultCall.referenceBaseline).toBeUndefined()
})

test("selectReferenceBaseline picks DLinear for seasonal/trend-heavy datasets", () => {
  const seasonalTask = task({
    datasetProfile: { seasonalityStrength: 0.72, trendStrength: 0.41, crossVarCorrelation: 0.1 },
    searchBiases: ["seasonal", "trend"],
  })
  const hypotheses = generateHypotheses({
    task: seasonalTask,
    dataAnalysisSummary: dataAnalysisSummary(["seasonal", "trend"]),
    runs: [],
    memory: [],
  })
  const plan = buildExperimentPlan({
    hypotheses,
    task: seasonalTask,
    isFirstCall: true,
  })

  expect(plan.referenceBaseline).toBe("tsf_baseline_dlinear")
})

test("selectReferenceBaseline picks iTransformer for cross-variate-correlated datasets", () => {
  const crossVarTask = task({
    datasetProfile: { seasonalityStrength: 0.1, trendStrength: 0.1, crossVarCorrelation: 0.66 },
    searchBiases: ["cross_var_correlated"],
  })
  const hypotheses = generateHypotheses({
    task: crossVarTask,
    dataAnalysisSummary: dataAnalysisSummary(["cross_var_correlated"]),
    runs: [],
    memory: [],
  })
  const plan = buildExperimentPlan({
    hypotheses,
    task: crossVarTask,
    isFirstCall: true,
  })

  expect(plan.referenceBaseline).toBe("tsf_baseline_itransformer")
})

test("selectReferenceBaseline falls back to PatchTST when no profile signal dominates", () => {
  const hypotheses = generateHypotheses({
    task: task({ datasetProfile: {}, searchBiases: [] }, { maxRuns: 1 }),
    dataAnalysisSummary: dataAnalysisSummary([]),
    runs: [],
    memory: [],
  })
  const plan = buildExperimentPlan({
    hypotheses,
    task: task({ datasetProfile: {}, searchBiases: [] }),
    isFirstCall: true,
  })

  expect(plan.referenceBaseline).toBe("tsf_baseline_patchtst")
})

test("selectReferenceBaseline picks the linear baseline for bridge-only tasks", () => {
  const hypotheses = generateHypotheses({
    task: task(),
    dataAnalysisSummary: dataAnalysisSummary(["seasonal", "trend"]),
    runs: [],
    memory: [],
  })
  const plan = buildExperimentPlan({
    hypotheses,
    task: task({ runtime: { bridgeOnly: true } }),
    isFirstCall: true,
  })

  expect(plan.referenceBaseline).toBe("tsf_linear_raw_baseline")
})

test("buildHypothesesYaml and buildHypoPlanMarkdown surface referenceBaseline when present", () => {
  const hypotheses = generateHypotheses({
    task: task(),
    dataAnalysisSummary: dataAnalysisSummary(["seasonal", "trend"]),
    runs: [],
    memory: [],
  })
  const result = buildHypoPlannerResult({
    task: task(),
    dataAnalysisSummary: dataAnalysisSummary(["seasonal", "trend"]),
    runs: [],
    memory: [],
  })

  expect(result.plan.referenceBaseline).toBe("tsf_baseline_dlinear")
  expect(result.hypothesesYaml).toContain("referenceBaseline: tsf_baseline_dlinear")
  expect(result.planMarkdown).toContain("Reference baseline: tsf_baseline_dlinear")

  const laterPlan = buildExperimentPlan({ hypotheses, task: task(), isFirstCall: false })
  expect(buildHypothesesYaml(laterPlan)).not.toContain("referenceBaseline:")
})

test("buildHypoPlannerResult emits markdown and yaml artifacts from the same plan", () => {
  const result = buildHypoPlannerResult({
    task: task(),
    dataAnalysisSummary: dataAnalysisSummary(["seasonal", "trend"]),
    runs: [],
    memory: [],
  })

  expect(result.agent).toBe("HypoPlannerAgent")
  expect(String(result.taskID)).toBe("rtsk_hypo")
  expect(result.plan.hypotheses.length).toBeGreaterThan(0)
  expect(result.planMarkdown).toContain("# Hypothesis Plan")
  expect(result.planMarkdown).toContain("## Hypotheses")
  expect(result.hypothesesYaml).toContain("hypotheses:")
  expect(result.hypothesesYaml).toContain("baselineStrategy: domain_baselines_first")
  expect(result.evidenceSummary).toContain("seasonal")
})

test("markdown and yaml builders render stable hypothesis IDs and suggested backbones", () => {
  const hypotheses = generateHypotheses({
    task: task(),
    dataAnalysisSummary: dataAnalysisSummary(["seasonal"]),
    runs: [],
    memory: [],
  })
  const plan = buildExperimentPlan({ hypotheses, task: task() })
  const result = buildHypoPlannerResult({
    task: task(),
    dataAnalysisSummary: dataAnalysisSummary(["seasonal"]),
    runs: [],
    memory: [],
  })

  expect(buildHypothesesYaml(plan)).toContain("id: H1")
  expect(buildHypothesesYaml(plan)).toContain("- dlinear")
  expect(buildHypoPlanMarkdown(result)).toContain("### H1")
  expect(buildHypoPlanMarkdown(result)).toContain("Suggested backbones")
})
