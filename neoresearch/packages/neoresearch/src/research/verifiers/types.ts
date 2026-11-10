import type { JsonRecord, ResearchCandidate, ResearchChampion, ResearchRun, ResearchTask } from "../schema"
import { isDeepStrictEqual } from "node:util"

export type VerifierName =
  | "metric_verifier"
  | "baseline_comparison_verifier"
  | "cost_perf_verifier"
  | "horizon_verifier"
  | "overfitting_verifier"
  | "data_leakage_verifier"

export type VerificationStatus = "passed" | "failed" | "skipped" | "insufficient_evidence"

export interface VerifierResult {
  readonly status: VerificationStatus
  readonly name: VerifierName
  readonly accepted: boolean
  readonly reason: string
  readonly evidence: JsonRecord
}

export interface VerifierReport {
  readonly status: "passed" | "failed" | "insufficient_evidence"
  readonly eligibleForRanking: boolean
  readonly accepted: boolean
  readonly results: VerifierResult[]
  readonly rejectReason: string | undefined
}

export interface VerifierContext {
  readonly task: ResearchTask
  readonly run: ResearchRun
  readonly candidate: ResearchCandidate | undefined
  readonly previousRuns: readonly ResearchRun[]
  readonly champion: ResearchChampion | undefined
}

export function finiteNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function metricOf(run: ResearchRun, key: string): number | undefined {
  return finiteNum((run.metrics as Record<string, unknown>)[key])
}

export function objectiveMetricName(task: ResearchTask): string {
  const objective = task.objective
  if (typeof objective.primaryMetric === "string") return objective.primaryMetric
  if (typeof objective.metric === "string") return objective.metric
  return "val_avg_mse"
}

/** Loss gaps require identical loss units, aggregation and evaluation scope. */
export function comparableLoss(ctx: VerifierContext) {
  const primary = objectiveMetricName(ctx.task)
  const match = primary.match(/^(val|cv)_avg_(mse|mae|rmse)$/)
  if (!match) return undefined
  const scope = match[1]!
  const loss = match[2]!
  const trainKeys = scope === "cv" ? [`cv_train_avg_${loss}`] : [`train_avg_${loss}`, `train_${loss}`]
  const train = trainKeys.map((key) => metricOf(ctx.run, key)).find((value) => value !== undefined)
  const validation = metricOf(ctx.run, primary)
  return { scope, loss, validation, train }
}

/** Do not judge full training against smoke, duplicate or different-protocol evidence. */
export function comparablePreviousRuns(ctx: VerifierContext) {
  const current = ctx.run.resourceUsage.experienceContext as Record<string, unknown> | undefined
  return ctx.previousRuns.filter((run) => {
    if (run.id === ctx.run.id || run.taskID !== ctx.run.taskID || run.stage !== ctx.run.stage || run.status !== "succeeded")
      return false
    const usage = run.resourceUsage
    if (usage.independentEvidence === false || usage.duplicateExperiment === true) return false
    if ((usage.verification as Record<string, unknown> | undefined)?.status === "failed") return false
    const execution = usage.executionContract as Record<string, unknown> | undefined
    if (execution && execution.status !== "verified") return false
    const previous = usage.experienceContext as Record<string, unknown> | undefined
    if (!current && !previous) return true // Legacy fixtures have no protocol snapshot.
    return !!current && !!previous && isDeepStrictEqual(current.evaluation, previous.evaluation) &&
      isDeepStrictEqual((current.dataset as Record<string, unknown> | undefined)?.specification,
        (previous.dataset as Record<string, unknown> | undefined)?.specification)
  })
}

export function paramsM(run: ResearchRun): number | undefined {
  const m = run.metrics as Record<string, unknown>
  const u = run.resourceUsage as Record<string, unknown>
  for (const src of [m, u, (u.modelResources ?? {}) as Record<string, unknown>]) {
    for (const k of ["params_M", "paramsM", "num_params_M", "numParamsM"]) {
      const v = finiteNum(src[k])
      if (v !== undefined && v >= 0) return v
    }
    for (const k of ["params", "numParams", "parameterCount"]) {
      const v = finiteNum(src[k])
      if (v !== undefined && v >= 0) return v / 1_000_000
    }
  }
  return undefined
}

/** Select one metric scope; never combine CV and fixed-split horizons. */
export function horizonMetrics(ctx: VerifierContext): { scope: string; values: { horizon: number; mse: number }[] } {
  const metrics = ctx.run.metrics as Record<string, unknown>
  const scope = objectiveMetricName(ctx.task).startsWith("cv_") ? "cv" : "val"
  const declared = ctx.task.taskSpec.predictionLengths
  const values = new Map<number, number>()
  for (const [key, value] of Object.entries(metrics)) {
    const match =
      key.match(new RegExp(`^${scope}_h(\\d+)_mse$`)) ??
      (scope === "val" ? key.match(/^(?:val_mse_h?|mse_)(\d+)$/) : null)
    const mse = finiteNum(value)
    if (match && mse !== undefined && (!Array.isArray(declared) || !declared.length || declared.includes(Number(match[1]))))
      values.set(Number(match[1]), mse)
  }
  return {
    scope,
    values: [...values].map(([horizon, mse]) => ({ horizon, mse })).sort((a, b) => a.horizon - b.horizon),
  }
}
