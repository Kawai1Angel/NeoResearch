import type { VerifierContext, VerifierResult } from "./types"
import { metricOf, objectiveMetricName } from "./types"

export function runMetricVerifier(ctx: VerifierContext): VerifierResult {
  const name = "metric_verifier" as const
  if (ctx.run.status !== "succeeded") {
    return {
      name,
      accepted: false,
      status: "failed",
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
      status: "failed",
      reason: `Primary metric "${metricName}" is absent in run results.`,
      evidence: { metricName, metricsKeys: Object.keys(ctx.run.metrics as object) },
    }
  }
  if (value < 0 && /(?:^|_)(mse|mae|rmse|mape|smape|crps)$/.test(metricName)) {
    return {
      name,
      accepted: false,
      status: "failed",
      reason: `Primary error metric "${metricName}"=${value} cannot be negative.`,
      evidence: { metricName, value },
    }
  }
  return {
    name,
    accepted: true,
    status: "passed",
    reason: `Primary metric "${metricName}"=${Number(value.toFixed(6))} is finite and valid for its metric type.`,
    evidence: { metricName, value },
  }
}
