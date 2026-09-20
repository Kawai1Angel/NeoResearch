import { expect, test } from "bun:test"
import { buildEvaluationResultMarkdown, buildVerifierDecisionRecord, runVerifiers } from "../../src/research/verifiers"
import type { VerifierContext } from "../../src/research/verifiers"
import type { ResearchCandidate, ResearchRun, ResearchTask } from "../../src/research/schema"

function task(extraObjective: Record<string, unknown> = {}): ResearchTask {
  return {
    id: "task_verify",
    projectID: "project_verify",
    title: "ETTh1 test",
    domainID: "tsf",
    mode: "autonomous",
    status: "searching",
    taskSpec: {},
    objective: { primaryMetric: "val_avg_mse", direction: "minimize", ...extraObjective },
    budget: {},
    time: { created: 1, updated: 1 },
  } as unknown as ResearchTask
}

function run(input: {
  id: string
  status: ResearchRun["status"]
  metrics?: Record<string, unknown>
  resourceUsage?: Record<string, unknown>
  error?: string
}): ResearchRun {
  return {
    id: input.id,
    taskID: "task_verify",
    stage: "full",
    status: input.status,
    metrics: input.metrics ?? {},
    resourceUsage: input.resourceUsage ?? {},
    artifactRefs: [],
    error: input.error,
    time: { created: 1, updated: 1 },
  } as unknown as ResearchRun
}

function candidate(paramsM?: number): ResearchCandidate {
  return {
    id: "cand_v",
    taskID: "task_verify",
    domainID: "tsf",
    candidateSpec: { recipeID: "linear_baseline", action: { backbone: "linear" } },
    rationale: "",
    riskLevel: "low",
    approvalStatus: "auto_approved",
    generatedBy: "heuristic",
    time: { created: 1, updated: 1 },
    metrics: paramsM === undefined ? {} : { params_M: paramsM },
  } as unknown as ResearchCandidate
}

function ctx(input: Partial<VerifierContext> = {}): VerifierContext {
  return {
    task: task(),
    run: run({ id: "run_v", status: "succeeded", metrics: { val_avg_mse: 0.35 } }),
    candidate: candidate(),
    previousRuns: [],
    champion: undefined,
    ...input,
  }
}

// --- metric_verifier ---

test("metric_verifier accepts a valid primary metric", () => {
  const report = runVerifiers(ctx())
  const result = report.results.find((r) => r.name === "metric_verifier")!
  expect(result.accepted).toBe(true)
})

test("metric_verifier rejects when primary metric is absent", () => {
  const report = runVerifiers(ctx({
    run: run({ id: "r", status: "succeeded", metrics: {} }),
  }))
  const result = report.results.find((r) => r.name === "metric_verifier")!
  expect(result.accepted).toBe(false)
  expect(report.accepted).toBe(false)
})

test("metric_verifier rejects when metric value is non-positive", () => {
  const report = runVerifiers(ctx({
    run: run({ id: "r", status: "succeeded", metrics: { val_avg_mse: -0.1 } }),
  }))
  const result = report.results.find((r) => r.name === "metric_verifier")!
  expect(result.accepted).toBe(false)
})

test("metric_verifier rejects diverged training (metric > 1e6)", () => {
  const report = runVerifiers(ctx({
    run: run({ id: "r", status: "succeeded", metrics: { val_avg_mse: 2_000_000 } }),
  }))
  const result = report.results.find((r) => r.name === "metric_verifier")!
  expect(result.accepted).toBe(false)
})

// --- baseline_comparison_verifier ---

test("baseline_comparison_verifier accepts the first run with no history", () => {
  const report = runVerifiers(ctx({ previousRuns: [] }))
  const result = report.results.find((r) => r.name === "baseline_comparison_verifier")!
  expect(result.accepted).toBe(true)
})

test("baseline_comparison_verifier accepts when current is better than previous", () => {
  const prev = run({ id: "prev_1", status: "succeeded", metrics: { val_avg_mse: 0.5 } })
  const report = runVerifiers(ctx({
    run: run({ id: "curr", status: "succeeded", metrics: { val_avg_mse: 0.35 } }),
    previousRuns: [prev],
  }))
  const result = report.results.find((r) => r.name === "baseline_comparison_verifier")!
  expect(result.accepted).toBe(true)
})

test("baseline_comparison_verifier rejects when current is >20% worse than best previous", () => {
  const prev = run({ id: "prev_1", status: "succeeded", metrics: { val_avg_mse: 0.3 } })
  const report = runVerifiers(ctx({
    run: run({ id: "curr", status: "succeeded", metrics: { val_avg_mse: 0.42 } }),
    previousRuns: [prev],
  }))
  const result = report.results.find((r) => r.name === "baseline_comparison_verifier")!
  expect(result.accepted).toBe(false)
  expect(result.reason).toContain("worse than best baseline")
})

// --- horizon_verifier ---

test("horizon_verifier skips when only one horizon is present", () => {
  const report = runVerifiers(ctx({
    run: run({ id: "r", status: "succeeded", metrics: { val_avg_mse: 0.3, val_mse_96: 0.2 } }),
  }))
  const result = report.results.find((r) => r.name === "horizon_verifier")!
  expect(result.accepted).toBe(true)
  expect(result.evidence["skipped"]).toBeUndefined()
})

test("horizon_verifier accepts when ratio is within threshold", () => {
  const report = runVerifiers(ctx({
    run: run({
      id: "r",
      status: "succeeded",
      metrics: { val_avg_mse: 0.3, val_mse_96: 0.2, val_mse_192: 0.4, val_mse_336: 0.6, val_mse_720: 0.9 },
    }),
  }))
  const result = report.results.find((r) => r.name === "horizon_verifier")!
  expect(result.accepted).toBe(true)
  expect(result.evidence["ratio"]).toBeLessThan(8)
})

test("horizon_verifier rejects when long-horizon collapses (ratio > 8)", () => {
  const report = runVerifiers(ctx({
    run: run({
      id: "r",
      status: "succeeded",
      metrics: { val_avg_mse: 0.5, val_mse_96: 0.1, val_mse_720: 1.5 },
    }),
  }))
  const result = report.results.find((r) => r.name === "horizon_verifier")!
  expect(result.accepted).toBe(false)
  expect(result.reason).toContain("Long-horizon collapse")
})

// --- cost_perf_verifier ---

test("cost_perf_verifier rejects when model exceeds param budget", () => {
  const t = {
    ...task(),
    budget: { parameterBudget: "5M" },
  } as unknown as ResearchTask
  const report = runVerifiers({
    ...ctx(),
    task: t,
    run: run({ id: "r", status: "succeeded", metrics: { val_avg_mse: 0.3, params_M: 20 } }),
  })
  const result = report.results.find((r) => r.name === "cost_perf_verifier")!
  expect(result.accepted).toBe(false)
  expect(result.reason).toContain("exceeding user budget")
})

// --- overfitting_verifier ---

test("overfitting_verifier rejects suspiciously small val MSE", () => {
  const report = runVerifiers(ctx({
    run: run({ id: "r", status: "succeeded", metrics: { val_avg_mse: 0.000001 } }),
  }))
  const result = report.results.find((r) => r.name === "overfitting_verifier")!
  expect(result.accepted).toBe(false)
  expect(result.reason).toContain("suspiciously small")
})

test("overfitting_verifier rejects when val/train ratio exceeds 3x", () => {
  const report = runVerifiers(ctx({
    run: run({
      id: "r",
      status: "succeeded",
      metrics: { val_avg_mse: 0.6, train_avg_mse: 0.05 },
    }),
  }))
  const result = report.results.find((r) => r.name === "overfitting_verifier")!
  expect(result.accepted).toBe(false)
  expect(result.reason).toContain("Val/train MSE ratio")
})

// --- full report + markdown ---

test("runVerifiers returns accepted=true when all checks pass", () => {
  const prev = run({ id: "prev", status: "succeeded", metrics: { val_avg_mse: 0.5 } })
  const report = runVerifiers(ctx({
    run: run({ id: "curr", status: "succeeded", metrics: { val_avg_mse: 0.4 } }),
    previousRuns: [prev],
  }))
  expect(report.accepted).toBe(true)
  expect(report.rejectReason).toBeUndefined()
  expect(report.results).toHaveLength(6)
})

test("buildEvaluationResultMarkdown renders verdict and verifier sections", () => {
  const prev = run({ id: "prev", status: "succeeded", metrics: { val_avg_mse: 0.5 } })
  const report = runVerifiers(ctx({
    run: run({ id: "curr", status: "succeeded", metrics: { val_avg_mse: 0.4 } }),
    previousRuns: [prev],
  }))
  const md = buildEvaluationResultMarkdown({
    task: task(),
    run: run({ id: "curr", status: "succeeded", metrics: { val_avg_mse: 0.4 } }),
    candidate: candidate(),
    report,
  })
  expect(md).toContain("# Evaluation Result")
  expect(md).toContain("ACCEPTED")
  expect(md).toContain("metric_verifier")
  expect(md).toContain("horizon_verifier")
})

test("buildVerifierDecisionRecord emits a standardized decision artifact", () => {
  const current = run({ id: "curr", status: "succeeded", metrics: { val_avg_mse: 0.9 } })
  const report = runVerifiers(
    ctx({
      run: current,
      previousRuns: [run({ id: "prev", status: "succeeded", metrics: { val_avg_mse: 0.5 } })],
    }),
  )
  const record = buildVerifierDecisionRecord({
    task: task(),
    run: current,
    candidate: candidate(),
    report,
  })

  expect(record).toMatchObject({
    schemaVersion: "neo-research.verifier_decision.v1",
    kind: "verifier_decision",
    agent: "VerifierAgent",
    taskID: "task_verify",
    runID: "curr",
    candidateID: "cand_v",
    accepted: false,
    decision: "reject",
    failure: {
      category: "regression",
      sourceVerifier: "baseline_comparison_verifier",
      recoveryAction: {
        type: "try_safer_candidate",
      },
    },
  })
  expect(record.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "baseline_comparison_verifier",
        accepted: false,
      }),
    ]),
  )
})

// --- data_leakage_verifier ---

test("data_leakage_verifier passes a clean run", () => {
  const report = runVerifiers(ctx({
    run: run({
      id: "r_clean",
      status: "succeeded",
      metrics: {
        val_avg_mse: 0.35,
        val_h96_mse: 0.28,
        val_h192_mse: 0.33,
        val_h336_mse: 0.38,
        val_h720_mse: 0.44,
        train_avg_mse: 0.22,
      },
      resourceUsage: {},
    }),
    task: task(),
  }))
  const result = report.results.find((r) => r.name === "data_leakage_verifier")!
  expect(result.accepted).toBe(true)
  expect(result.evidence).toMatchObject({ valAvgMse: 0.35 })
})

test("data_leakage_verifier skips non-succeeded runs", () => {
  const report = runVerifiers(ctx({
    run: run({ id: "r_fail", status: "failed", metrics: {} }),
  }))
  const result = report.results.find((r) => r.name === "data_leakage_verifier")!
  expect(result.accepted).toBe(true)
  expect(result.evidence).toMatchObject({ skipped: true })
})

test("data_leakage_verifier rejects non-fixed-split protocol", () => {
  const report = runVerifiers(ctx({
    task: {
      ...task(),
      taskSpec: { evaluation: { protocol: "rolling_window" } },
    } as unknown as typeof task extends () => infer T ? T : never,
  }))
  const result = report.results.find((r) => r.name === "data_leakage_verifier")!
  expect(result.accepted).toBe(false)
  expect(result.reason).toContain("rolling_window")
})

test("data_leakage_verifier accepts ordered expanding-window CV", () => {
  const report = runVerifiers(ctx({
    task: {
      ...task({ primaryMetric: "cv_avg_mse" }),
      taskSpec: { evaluation: { protocol: "expanding_window_ratio" } },
    } as ResearchTask,
    run: run({ id: "r_cv", status: "succeeded", metrics: { cv_avg_mse: 0.4, val_avg_mse: 0.42 } }),
  }))
  const result = report.results.find((r) => r.name === "data_leakage_verifier")!
  expect(result.accepted).toBe(true)
})

test("data_leakage_verifier rejects when max_horizon >= context_length", () => {
  const report = runVerifiers(ctx({
    run: run({ id: "r_ctx", status: "succeeded", metrics: { val_avg_mse: 0.4 } }),
    task: {
      ...task(),
      taskSpec: { contextLength: 96, predictionLengths: [96, 192] },
    } as unknown as typeof task extends () => infer T ? T : never,
  }))
  const result = report.results.find((r) => r.name === "data_leakage_verifier")!
  expect(result.accepted).toBe(false)
  expect(result.reason).toContain("192")
  expect(result.reason).toContain("96")
})

test("data_leakage_verifier rejects suspiciously low val/train ratio", () => {
  const report = runVerifiers(ctx({
    run: run({
      id: "r_ratio",
      status: "succeeded",
      metrics: {
        val_avg_mse: 0.05,
        train_avg_mse: 0.50,
        val_h96_mse: 0.05,
        val_h192_mse: 0.06,
        val_h336_mse: 0.07,
        val_h720_mse: 0.08,
      },
    }),
  }))
  const result = report.results.find((r) => r.name === "data_leakage_verifier")!
  expect(result.accepted).toBe(false)
  expect(result.reason).toContain("Val/train")
})

test("data_leakage_verifier rejects horizon MSE strong inversion", () => {
  const report = runVerifiers(ctx({
    run: run({
      id: "r_inv",
      status: "succeeded",
      metrics: {
        val_avg_mse: 0.35,
        val_h96_mse: 0.80,
        val_h192_mse: 0.60,
        val_h336_mse: 0.20,
        val_h720_mse: 0.10,
      },
    }),
  }))
  const result = report.results.find((r) => r.name === "data_leakage_verifier")!
  expect(result.accepted).toBe(false)
  expect(result.reason).toContain("inversion")
})

test("data_leakage_verifier rejects horizon MSE collapse", () => {
  const val = 0.342_100
  const report = runVerifiers(ctx({
    run: run({
      id: "r_collapse",
      status: "succeeded",
      metrics: {
        val_avg_mse: val,
        val_h96_mse: val,
        val_h192_mse: val,
        val_h336_mse: val,
        val_h720_mse: val,
      },
    }),
  }))
  const result = report.results.find((r) => r.name === "data_leakage_verifier")!
  expect(result.accepted).toBe(false)
  expect(result.reason).toContain("collapse")
})

test("data_leakage_verifier decision record maps to audit_split_boundaries", () => {
  const report = runVerifiers(ctx({
    run: run({
      id: "r_leak",
      status: "succeeded",
      metrics: {
        val_avg_mse: 0.05,
        train_avg_mse: 0.50,
      },
    }),
  }))
  const record = buildVerifierDecisionRecord({
    task: task(),
    run: run({ id: "r_leak", status: "succeeded", metrics: { val_avg_mse: 0.05, train_avg_mse: 0.50 } }),
    candidate: candidate(),
    report,
  })
  expect(record.failure?.category).toBe("data_leakage")
  expect(record.failure?.recoveryAction.type).toBe("audit_split_boundaries")
})
