import { expect, test } from "bun:test"
import {
  analyzeReflection,
  buildFailureLogMarkdown,
  buildNextExperimentPlanMarkdown,
  buildReflectionNotesMarkdown,
  summarizeReflectionAgent,
} from "../../src/research/agents/reflection-agent"
import type { ResearchCandidate, ResearchRun, ResearchTask } from "../../src/research/schema"

function task(extraSpec: Record<string, unknown> = {}): ResearchTask {
  return {
    id: "task_reflect",
    projectID: "project_reflect",
    title: "ETTh1 forecast",
    domainID: "tsf",
    mode: "autonomous",
    status: "searching",
    taskSpec: {
      datasetProfile: {
        seasonalityStrength: 0.6,
        trendStrength: 0.2,
        crossVarCorrelation: 0.55,
        distributionShift: 0.1,
      },
      searchBiases: ["prefer_decomposition_for_high_seasonality"],
      ...extraSpec,
    },
    objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
    budget: {},
    time: { created: 1, updated: 1 },
  } as unknown as ResearchTask
}

function candidate(id: string, recipeID: string, backbone: string): ResearchCandidate {
  return {
    id,
    taskID: "task_reflect",
    domainID: "tsf",
    candidateSpec: { recipeID, action: { backbone } },
    rationale: "",
    riskLevel: "low",
    approvalStatus: "auto_approved",
    generatedBy: "heuristic",
    time: { created: 1, updated: 1 },
  } as unknown as ResearchCandidate
}

function run(input: {
  id: string
  candidateID?: string
  status: ResearchRun["status"]
  metric?: number
  error?: string
  created: number
}): ResearchRun {
  return {
    id: input.id,
    taskID: "task_reflect",
    candidateID: input.candidateID,
    stage: "full",
    status: input.status,
    metrics: input.metric === undefined ? {} : { val_avg_mse: input.metric },
    resourceUsage: {},
    artifactRefs: [],
    error: input.error,
    time: { created: input.created, updated: input.created },
  } as unknown as ResearchRun
}

test("analyzeReflection ranks improving runs as effective and regressing runs as ineffective", () => {
  const t = task()
  const c1 = candidate("cand_1", "linear_baseline", "linear")
  const c2 = candidate("cand_2", "patch_mlp_baseline", "mlp")
  const c3 = candidate("cand_3", "patch_transformer_baseline", "transformer")
  const analysis = analyzeReflection({
    task: t,
    runs: [
      run({ id: "run_1", candidateID: c1.id, status: "succeeded", metric: 0.5, created: 1 }),
      run({ id: "run_2", candidateID: c2.id, status: "succeeded", metric: 0.42, created: 2 }),
      run({ id: "run_3", candidateID: c3.id, status: "succeeded", metric: 0.55, created: 3 }),
    ],
    candidates: [c1, c2, c3],
  })
  expect(analysis.bestMetric).toBe(0.42)
  expect(analysis.bestRunID).toBe("run_2")
  expect(analysis.effectiveChanges).toHaveLength(1)
  expect(analysis.effectiveChanges[0]!.runID).toBe("run_2")
  expect(analysis.ineffectiveChanges).toHaveLength(1)
  expect(analysis.ineffectiveChanges[0]!.runID).toBe("run_3")
  expect(analysis.plateauStreak).toBe(1)
  expect(analysis.decision).toBe("continue")
})

test("analyzeReflection produces hypotheses driven by dataset profile and search biases", () => {
  const analysis = analyzeReflection({
    task: task(),
    runs: [run({ id: "run_a", candidateID: "cand_a", status: "succeeded", metric: 0.4, created: 1 })],
    candidates: [candidate("cand_a", "linear_baseline", "linear")],
  })
  const titles = analysis.nextHypotheses.map((item) => item.title)
  expect(titles.some((title) => title.includes("series_decomposition"))).toBe(true)
  expect(titles.some((title) => title.includes("channel-mixing"))).toBe(true)
  expect(titles.some((title) => title.includes("prefer_decomposition_for_high_seasonality"))).toBe(true)
})

test("analyzeReflection requests human review after consecutive failures", () => {
  const c = candidate("cand_x", "patch_mlp_baseline", "mlp")
  const analysis = analyzeReflection({
    task: task(),
    runs: [
      run({ id: "run_1", candidateID: c.id, status: "failed", error: "CUDA out of memory", created: 1 }),
      run({ id: "run_2", candidateID: c.id, status: "failed", error: "CUDA out of memory", created: 2 }),
      run({ id: "run_3", candidateID: c.id, status: "failed", error: "loss became nan", created: 3 }),
    ],
    candidates: [c],
  })
  expect(analysis.failedRuns).toBe(3)
  expect(analysis.failures.map((item) => item.category)).toEqual(["oom", "oom", "nan"])
  expect(analysis.decision).toBe("request_human")
  const titles = analysis.nextHypotheses.map((item) => item.title)
  expect(titles.some((title) => title.includes("batch size"))).toBe(true)
  expect(titles.some((title) => title.includes("Huber"))).toBe(true)
})

test("summarizeReflectionAgent emits both reflection_notes and next_experiment_plan markdown", () => {
  const c = candidate("cand_b", "linear_baseline", "linear")
  const result = summarizeReflectionAgent({
    task: task(),
    runs: [run({ id: "run_1", candidateID: c.id, status: "succeeded", metric: 0.31, created: 1 })],
    candidates: [c],
    stoppedReason: "max_iterations",
  })
  expect(result.agent).toBe("ReflectionAgent")
  expect(result.reflectionNotesMarkdown).toContain("# Reflection Notes")
  expect(result.reflectionNotesMarkdown).toContain("max_iterations")
  expect(result.reflectionNotesMarkdown).toContain("val_avg_mse")
  expect(result.nextExperimentPlanMarkdown).toContain("# Next Experiment Plan")
  expect(result.failureLogMarkdown).toContain("# Failure Log")
  expect(result.llm.status).toBe("disabled")
})

test("buildFailureLogMarkdown emits traceable failure categories and recovery actions", () => {
  const c = candidate("cand_fail", "large_transformer", "transformer")
  const analysis = analyzeReflection({
    task: task(),
    runs: [
      run({
        id: "run_oom",
        candidateID: c.id,
        status: "failed",
        error: "CUDA out of memory while allocating tensor",
        created: 1,
      }),
    ],
    candidates: [c],
    stoppedReason: "crash_streak_exceeded",
  })
  const md = buildFailureLogMarkdown({
    task: task(),
    analysis,
    stoppedReason: "crash_streak_exceeded",
  })

  expect(md).toContain("# Failure Log")
  expect(md).toContain("run_id: run_oom")
  expect(md).toContain("category: oom")
  expect(md).toContain("recovery_action: reduce_resource_pressure")
  expect(md).toContain("Decision")
})

test("buildNextExperimentPlanMarkdown emits a publish recommendation when decision is stop", () => {
  const t = task()
  const c = candidate("cand_y", "linear_baseline", "linear")
  const baseAnalysis = analyzeReflection({
    task: t,
    runs: [run({ id: "run_1", candidateID: c.id, status: "succeeded", metric: 0.1, created: 1 })],
    candidates: [c],
    stoppedReason: "target_reached",
  })
  expect(baseAnalysis.decision).toBe("stop")
  const plan = buildNextExperimentPlanMarkdown({ task: t, analysis: baseAnalysis })
  expect(plan).toContain("Run PublishAgent")
  const notes = buildReflectionNotesMarkdown({ task: t, analysis: baseAnalysis, stoppedReason: "target_reached" })
  expect(notes).toContain("stop")
})
