import type { VerifierContext, VerifierResult } from "./types"
import { metricOf } from "./types"

function objectiveMetricName(task: VerifierContext["task"]): string {
  const o = task.objective as Record<string, unknown>
  if (typeof o.primaryMetric === "string") return o.primaryMetric
  if (typeof o.metric === "string") return o.metric
  return "val_avg_mse"
}

export function runMetricVerifier(ctx: VerifierContext): VerifierResult {
  const name = "metric_verifier" as const
  if (ctx.run.status !== "succeeded") {
    return {
      name,
      accepted: false,
      reason: `Run did not succeed (status=${ctx.run.status}); no metric to verify.`,
      evidence: { runStatus: ctx.run.status },
    }
  }
  const metricName = objectiveMetricName(ctx.task)
  const value = metricOf(ctx.run, metricName)
  if (value === undefined) {
    return {
      name,
      accepted: false,
      reason: `Primary metric "${metricName}" is absent in run results.`,
      evidence: { metricName, metricsKeys: Object.keys(ctx.run.metrics as object) },
    }
  }
  if (value <= 0) {
    return {
      name,
      accepted: false,
      reason: `Primary metric "${metricName}"=${value} is non-positive, which is physically implausible for MSE/MAE.`,
      evidence: { metricName, value },
    }
  }
  if (value > 1e6) {
    return {
      name,
      accepted: false,
      reason: `Primary metric "${metricName}"=${value} exceeds 1e6; likely a training divergence or unit error.`,
      evidence: { metricName, value },
    }
  }
  return {
    name,
    accepted: true,
    reason: `Primary metric "${metricName}"=${Number(value.toFixed(6))} is present and within plausible range.`,
    evidence: { metricName, value },
  }
}
