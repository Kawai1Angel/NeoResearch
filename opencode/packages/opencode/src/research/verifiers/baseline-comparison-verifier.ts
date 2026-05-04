import type { VerifierContext, VerifierResult } from "./types"
import { metricOf } from "./types"

const REGRESSION_THRESHOLD = 0.20

function objectiveMetricName(task: VerifierContext["task"]): string {
  const o = task.objective as Record<string, unknown>
  if (typeof o.primaryMetric === "string") return o.primaryMetric
  if (typeof o.metric === "string") return o.metric
  return "val_avg_mse"
}

function objectiveDirection(task: VerifierContext["task"]): "minimize" | "maximize" {
  return (task.objective as Record<string, unknown>).direction === "maximize" ? "maximize" : "minimize"
}

export function runBaselineComparisonVerifier(ctx: VerifierContext): VerifierResult {
  const name = "baseline_comparison_verifier" as const
  const metricName = objectiveMetricName(ctx.task)
  const direction = objectiveDirection(ctx.task)
  const currentMetric = metricOf(ctx.run, metricName)

  if (currentMetric === undefined || ctx.run.status !== "succeeded") {
    return {
      name,
      accepted: true,
      reason: "Skipped: run did not succeed or metric is absent; leaving judgment to metric_verifier.",
      evidence: { skipped: true },
    }
  }

  const baselineMetrics = ctx.previousRuns
    .filter((r) => r.status === "succeeded")
    .map((r) => metricOf(r, metricName))
    .filter((v): v is number => v !== undefined)

  if (baselineMetrics.length === 0) {
    return {
      name,
      accepted: true,
      reason: "No previous succeeded runs to compare against; first run is accepted as the implicit baseline.",
      evidence: { baselineCount: 0 },
    }
  }

  const bestBaseline =
    direction === "minimize" ? Math.min(...baselineMetrics) : Math.max(...baselineMetrics)

  const regressed =
    direction === "minimize"
      ? currentMetric > bestBaseline * (1 + REGRESSION_THRESHOLD)
      : currentMetric < bestBaseline * (1 - REGRESSION_THRESHOLD)

  if (regressed) {
    const pct = (Math.abs(currentMetric - bestBaseline) / Math.max(Math.abs(bestBaseline), 1e-12)) * 100
    return {
      name,
      accepted: false,
      reason: `Current ${metricName}=${Number(currentMetric.toFixed(6))} is ${pct.toFixed(1)}% worse than best baseline ${Number(bestBaseline.toFixed(6))} (threshold ${REGRESSION_THRESHOLD * 100}%).`,
      evidence: { currentMetric, bestBaseline, regressionPct: pct, threshold: REGRESSION_THRESHOLD * 100 },
    }
  }

  return {
    name,
    accepted: true,
    reason: `Current ${metricName}=${Number(currentMetric.toFixed(6))} is within acceptable range of best baseline ${Number(bestBaseline.toFixed(6))}.`,
    evidence: { currentMetric, bestBaseline },
  }
}
