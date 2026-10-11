import { expect, test } from "bun:test"
import { runVerifiers } from "../../src/research/verifiers"
import { digest, verifyExecutionRecords, type ExecutionContract } from "../../src/research/execution-contract"

function context(metric = "val_avg_mse", metrics: Record<string, number> = { [metric]: 0.4 }) {
  return {
    task: { id: "task", budget: {}, objective: { primaryMetric: metric }, taskSpec: { evaluation: { protocol: "fixed_split" } } },
    run: { id: "current", taskID: "task", stage: "full", status: "succeeded", metrics, resourceUsage: {} },
    previousRuns: [] as any[],
  } as any
}
function check(ctx: any, name: string) {
  return runVerifiers(ctx).results.find((r) => r.name === name)!
}
function previous(ctx: any, overrides: Record<string, unknown> = {}) {
  return { ...ctx.run, id: "previous", metrics: { val_avg_mse: 0.01, params_M: 1 }, ...overrides }
}

test("metric validity follows metric semantics and has no universal unit threshold", () => {
  for (const [metric, value] of [["val_avg_mse", 0], ["val_avg_mae", 2_000_000], ["val_avg_r2", -0.5]] as const)
    expect(check(context(metric, { [metric]: value }), "metric_verifier").status).toBe("passed")
  expect(check(context("val_avg_mse", { val_avg_mse: -1 }), "metric_verifier").status).toBe("failed")
})

test("small error with a comparable train error is not rejected on absolute magnitude", () => {
  const result = check(context("val_avg_mse", { val_avg_mse: 1e-6, train_avg_mse: 1e-6 }), "overfitting_verifier")
  expect(result.status).toBe("passed")
})

test("overfitting compares the same loss in the same evaluation scope", () => {
  const mixed = context("val_avg_mae", { val_avg_mae: 0.2, train_avg_mse: 0.01 })
  expect(check(mixed, "overfitting_verifier").status).toBe("insufficient_evidence")
  mixed.run.metrics.train_avg_mae = 0.15
  expect(check(mixed, "overfitting_verifier").status).toBe("passed")
  const cv = context("cv_avg_mae", { cv_avg_mae: 0.2, train_avg_mae: 0.01, cv_train_avg_mae: 0.15 })
  expect(check(cv, "overfitting_verifier").status).toBe("passed")
})

test("leakage diagnostics use CV train and CV validation rather than fixed-split metrics", () => {
  const ctx = context("cv_avg_mse", { cv_avg_mse: 0.4, cv_train_avg_mse: 0.3, val_avg_mse: 0.01, train_avg_mse: 1 })
  expect(check(ctx, "data_leakage_verifier").status).toBe("passed")
  ctx.run.metrics.cv_avg_mse = 0.01
  expect(check(ctx, "data_leakage_verifier").status).toBe("insufficient_evidence")
})

test("horizon uniformity and inversion are diagnostic signals rather than proof of leakage", () => {
  for (const longest of [0.4, 0.1]) {
    const ctx = context("val_avg_mse", { val_avg_mse: 0.4, train_avg_mse: 0.4, val_h96_mse: 0.4, val_h720_mse: longest })
    expect(check(ctx, "data_leakage_verifier").status).toBe("insufficient_evidence")
    expect(runVerifiers(ctx).eligibleForRanking).toBe(true)
  }
})

test("one declared horizon is evaluated without requiring an undeclared second horizon", () => {
  const ctx = context("cv_avg_mse", { cv_avg_mse: 0.4, cv_h96_mse: 0.4, cv_h720_mse: 10 })
  ctx.task.taskSpec.predictionLengths = [96]
  expect(check(ctx, "horizon_verifier").status).toBe("passed")
  ctx.run.metrics.cv_h96_mse = NaN
  expect(check(ctx, "horizon_verifier").status).toBe("insufficient_evidence")
})

test("baseline and cost comparisons exclude other stages, tasks, duplicates and failed verification", () => {
  const ctx = context("val_avg_mse", { val_avg_mse: 0.4, params_M: 100 })
  for (const overrides of [{ stage: "smoke" }, { taskID: "another" }, { resourceUsage: { independentEvidence: false } }, { resourceUsage: { verification: { status: "failed" } } }]) {
    ctx.previousRuns = [previous(ctx, overrides)]
    expect(check(ctx, "baseline_comparison_verifier").status).toBe("skipped")
    expect(check(ctx, "cost_perf_verifier").status).toBe("insufficient_evidence")
  }
  const experience = { evaluation: { contextLength: 96 }, dataset: { specification: { source: "A" } } }
  ctx.run.resourceUsage.experienceContext = experience
  ctx.previousRuns = [previous(ctx, { resourceUsage: { experienceContext: { ...experience, evaluation: { contextLength: 192 } } } })]
  expect(check(ctx, "baseline_comparison_verifier").status).toBe("skipped")
  ctx.previousRuns = [previous(ctx, { resourceUsage: { experienceContext: experience } })]
  expect(check(ctx, "baseline_comparison_verifier").status).toBe("failed")
})

test("relative regression handles signed maximization objectives", () => {
  const ctx = context("val_avg_r2", { val_avg_r2: -0.9 })
  ctx.task.objective.direction = "maximize"
  ctx.previousRuns = [previous(ctx, { metrics: { val_avg_r2: -1 } })]
  expect(check(ctx, "baseline_comparison_verifier").status).toBe("passed")
  ctx.run.metrics.val_avg_r2 = -1.3
  expect(check(ctx, "baseline_comparison_verifier").status).toBe("failed")
})

test("resource checks read actual backend num_params_M and absolute numeric limits", () => {
  const ctx = context()
  ctx.task.budget.parameterBudget = 5_000_000
  ctx.run.resourceUsage.modelResources = { num_params_M: 20 }
  expect(check(ctx, "cost_perf_verifier")).toMatchObject({ status: "failed", evidence: { currentParamsM: 20, budgetM: 5 } })
  delete ctx.task.budget.parameterBudget
  ctx.task.budget.maxParamsM = 5
  expect(check(ctx, "cost_perf_verifier").status).toBe("failed")
})

test("execution verification checks every proof and each CV fold's manifest coverage", () => {
  const contract = { schema_version: "research_execution_contract.v1", task_id: "task", candidate_id: "candidate", hypothesis_id: "H", candidate_spec_sha256: "sha", expected: { backbone: "linear" } } as ExecutionContract
  const identity = { candidate_id: "candidate", candidate_spec_sha256: "sha", contract_digest: digest(contract) }
  const manifest = { ...identity, event: "executed_model_manifest", actual: { backbone: "linear" } }
  const proof = { ...identity, event: "execution_contract_verified", status: "verified" }
  expect(verifyExecutionRecords(contract, [manifest, proof])).toEqual([])
  expect(verifyExecutionRecords(contract, [manifest, { ...proof, candidate_id: "stale" }, manifest, proof]).length).toBeGreaterThan(0)
  expect(verifyExecutionRecords(contract, [proof, manifest]).length).toBeGreaterThan(0)
  expect(verifyExecutionRecords(contract, [{ ...manifest, cv_fold_index: 1 }, manifest, proof]).length).toBeGreaterThan(0)
  expect(verifyExecutionRecords(contract, [{ ...manifest, cv_fold_index: 1 }, manifest, proof, { ...proof, cv_fold_index: 1 }])).toEqual([])
})
