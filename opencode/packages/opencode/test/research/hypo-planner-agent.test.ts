import { expect, test } from "bun:test"
import {
  buildExperimentPlan,
  buildHypoPlanMarkdown,
  buildHypoPlannerResult,
  buildHypothesesYaml,
  extractEvidenceSummary,
  generateHypotheses,
} from "../../src/research/agents/hypo-planner-agent"
import type { DataAnalysisAgentResult } from "../../src/research/agents/data-analysis-agent"
import type { ResearchArtifact, ResearchMemory, ResearchRun, ResearchTask } from "../../src/research/schema"

function artifact(): ResearchArtifact {
  return {
    id: "rart_data_analysis",
    taskID: "rtsk_hypo",
    kind: "dataset_analysis_report",
    uri: "file:///tmp/data_analysis_summary.md",
    metadata: { format: "markdown" },
    time: { created: 1, updated: 1 },
  } as unknown as ResearchArtifact
}

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

function dataAnalysis(searchBiases: readonly string[] = ["seasonal", "cross_var_correlated"]): DataAnalysisAgentResult {
  return {
    agent: "DataAnalysisAgent",
    taskID: "rtsk_hypo" as ResearchTask["id"],
    artifact: artifact(),
    sourceArtifactIDs: ["rart_quant", "rart_main"] as never,
    searchBiases,
    warningCount: 1,
  }
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

test("extractEvidenceSummary condenses data-analysis handoff signals", () => {
  const summary = extractEvidenceSummary(dataAnalysis(["seasonal", "missing_values"]))
  expect(summary).toContain("DataAnalysisAgent")
  expect(summary).toContain("rart_data_analysis")
  expect(summary).toContain("seasonal")
  expect(summary).toContain("missing_values")
  expect(summary).toContain("1 warning")
  expect(summary).toContain("2 source artifacts")
})

test("generateHypotheses creates prioritized seasonal, trend, and channel hypotheses from task evidence", () => {
  const hypotheses = generateHypotheses({
    task: task(),
    dataAnalysis: dataAnalysis(["seasonal", "cross_var_correlated"]),
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
    dataAnalysis: dataAnalysis(["distribution_shift"]),
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
    dataAnalysis: dataAnalysis([]),
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
    dataAnalysis: dataAnalysis(["seasonal", "trend"]),
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

test("buildHypoPlannerResult emits markdown and yaml artifacts from the same plan", () => {
  const result = buildHypoPlannerResult({
    task: task(),
    dataAnalysis: dataAnalysis(["seasonal", "trend"]),
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
    dataAnalysis: dataAnalysis(["seasonal"]),
    runs: [],
    memory: [],
  })
  const plan = buildExperimentPlan({ hypotheses, task: task() })
  const result = buildHypoPlannerResult({
    task: task(),
    dataAnalysis: dataAnalysis(["seasonal"]),
    runs: [],
    memory: [],
  })

  expect(buildHypothesesYaml(plan)).toContain("id: H1")
  expect(buildHypothesesYaml(plan)).toContain("- dlinear")
  expect(buildHypoPlanMarkdown(result)).toContain("### H1")
  expect(buildHypoPlanMarkdown(result)).toContain("Suggested backbones")
})
