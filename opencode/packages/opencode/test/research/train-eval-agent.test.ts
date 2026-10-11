import { expect, test } from "bun:test"
import { buildTrainEvalResult } from "../../src/research/agents/train-eval-agent"
import type { ResearchCandidate, ResearchRun } from "../../src/research/schema"
import type { VerifierReport } from "../../src/research/verifiers"

function candidate(): ResearchCandidate {
  return {
    id: "rcnd_train",
    taskID: "rtsk_train",
    domainID: "tsf",
    candidateSpec: { recipeID: "recipe_train" },
    rationale: "train candidate",
    riskLevel: "low",
    approvalStatus: "auto_approved",
    generatedBy: "heuristic",
    time: { created: 1, updated: 1 },
  } as unknown as ResearchCandidate
}

function run(input: {
  status: ResearchRun["status"]
  stage?: "low_fidelity" | "full"
  metrics?: Record<string, unknown>
  error?: string
}): ResearchRun {
  return {
    id: "rrun_train",
    taskID: "rtsk_train",
    candidateID: "rcnd_train",
    stage: input.stage ?? "low_fidelity",
    status: input.status,
    metrics: input.metrics ?? {},
    resourceUsage: {},
    artifactRefs: [],
    error: input.error,
    time: { created: 1, updated: 1 },
  } as unknown as ResearchRun
}

function report(accepted: boolean): VerifierReport {
  return {
    status: accepted ? "passed" : "failed",
    eligibleForRanking: accepted,
    accepted,
    rejectReason: accepted ? undefined : "[metric_verifier] regression",
    results: [
      {
        name: "metric_verifier",
        status: accepted ? "passed" : "failed",
        accepted,
        reason: accepted ? "metric present" : "regression",
        evidence: {},
      },
    ],
  }
}

test("buildTrainEvalResult succeeds accepted training runs with primary metric", () => {
  const result = buildTrainEvalResult({
    taskID: "rtsk_train" as never,
    run: run({ status: "succeeded", metrics: { val_avg_mse: 0.23, val_avg_mae: 0.4 } }),
    candidate: candidate(),
    stage: "low_fidelity",
    primaryMetricName: "val_avg_mse",
    verifierReport: report(true),
  })

  expect(result).toMatchObject({
    agent: "TrainEvalAgent",
    taskID: "rtsk_train",
    candidateID: "rcnd_train",
    runID: "rrun_train",
    stage: "low_fidelity",
    status: "succeeded",
    primaryMetric: 0.23,
    verifierDecision: "accepted",
  })
  expect(result.trainingLogSummary).toContain("val_avg_mse=0.23")
})

test("buildTrainEvalResult marks verifier rejections as rejected", () => {
  const result = buildTrainEvalResult({
    taskID: "rtsk_train" as never,
    run: run({ status: "rejected", metrics: { val_avg_mse: 0.5 } }),
    candidate: candidate(),
    stage: "full",
    primaryMetricName: "val_avg_mse",
    verifierReport: report(false),
  })

  expect(result.status).toBe("rejected")
  expect(result.verifierDecision).toBe("rejected")
  expect(result.verifierRejectReason).toContain("regression")
})

test("buildTrainEvalResult marks failed training runs and skips verifier when no report exists", () => {
  const result = buildTrainEvalResult({
    taskID: "rtsk_train" as never,
    run: run({ status: "failed", error: "runner exited" }),
    candidate: candidate(),
    stage: "low_fidelity",
    primaryMetricName: "val_avg_mse",
  })

  expect(result.status).toBe("failed")
  expect(result.primaryMetric).toBeUndefined()
  expect(result.verifierDecision).toBe("skipped")
  expect(result.trainingLogSummary).toContain("runner exited")
})

test("buildTrainEvalResult succeeds full-stage runs when verifier is skipped", () => {
  const result = buildTrainEvalResult({
    taskID: "rtsk_train" as never,
    run: run({ status: "succeeded", stage: "full", metrics: { val_avg_mse: 0.19 } }),
    candidate: candidate(),
    stage: "full",
    primaryMetricName: "val_avg_mse",
  })

  expect(result.stage).toBe("full")
  expect(result.status).toBe("succeeded")
  expect(result.verifierDecision).toBe("skipped")
  expect(result.trainingLogSummary).toContain("full/succeeded")
})

test("buildTrainEvalResult reads custom primary metrics", () => {
  const result = buildTrainEvalResult({
    taskID: "rtsk_train" as never,
    run: run({ status: "succeeded", metrics: { val_avg_mae: 0.31, val_avg_mse: 0.6 } }),
    candidate: candidate(),
    stage: "low_fidelity",
    primaryMetricName: "val_avg_mae",
    verifierReport: report(true),
  })

  expect(result.primaryMetric).toBe(0.31)
  expect(result.trainingLogSummary).toContain("val_avg_mae=0.31")
})

test("buildTrainEvalResult omits non-finite primary metrics", () => {
  const result = buildTrainEvalResult({
    taskID: "rtsk_train" as never,
    run: run({ status: "succeeded", metrics: { val_avg_mse: Number.NaN } }),
    candidate: candidate(),
    stage: "low_fidelity",
    primaryMetricName: "val_avg_mse",
  })

  expect(result.status).toBe("succeeded")
  expect(result.primaryMetric).toBeUndefined()
  expect(result.trainingLogSummary).toContain("val_avg_mse=n/a")
})
