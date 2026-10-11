import type { VerifierContext, VerifierResult } from "./types"
import { comparablePreviousRuns, metricOf, objectiveMetricName } from "./types"

const REGRESSION_THRESHOLD = 0.2

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
      accepted: false,
      status: "skipped",
      reason: "Skipped: run did not succeed or metric is absent; leaving judgment to metric_verifier.",
      evidence: { skipped: true },
    }
  }

  const baselineMetrics = comparablePreviousRuns(ctx)
    .map((r) => metricOf(r, metricName))
    .filter((v): v is number => v !== undefined)

  if (baselineMetrics.length === 0) {
    return {
      name,
      accepted: false,
      status: "skipped",
      reason: "No comparable previous succeeded runs; no comparison has been evaluated.",
      evidence: { baselineCount: 0 },
    }
  }

  const bestBaseline = direction === "minimize" ? Math.min(...baselineMetrics) : Math.max(...baselineMetrics)

  const degradation = direction === "minimize" ? currentMetric - bestBaseline : bestBaseline - currentMetric
  const regressed = degradation > Math.abs(bestBaseline) * REGRESSION_THRESHOLD

  if (regressed) {
    const pct = (Math.abs(currentMetric - bestBaseline) / Math.max(Math.abs(bestBaseline), 1e-12)) * 100
    return {
      name,
      accepted: false,
      status: "failed",
      reason: `Current ${metricName}=${Number(currentMetric.toFixed(6))} is ${pct.toFixed(1)}% worse than best baseline ${Number(bestBaseline.toFixed(6))} (threshold ${REGRESSION_THRESHOLD * 100}%).`,
      evidence: { currentMetric, bestBaseline, regressionPct: pct, threshold: REGRESSION_THRESHOLD * 100 },
    }
  }

  return {
    name,
    accepted: true,
    status: "passed",
    reason: `Current ${metricName}=${Number(currentMetric.toFixed(6))} is within acceptable range of best baseline ${Number(bestBaseline.toFixed(6))}.`,
    evidence: { currentMetric, bestBaseline },
  }
}
