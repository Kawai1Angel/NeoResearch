import type { VerifierContext, VerifierResult } from "./types"
import { comparablePreviousRuns, metricOf, objectiveMetricName } from "./types"
import { isZeroResearch } from "../research-variant"

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
  const referenceLabel = isZeroResearch(ctx.task.taskSpec) ? "previous comparable run" : "baseline"

  const degradation = direction === "minimize" ? currentMetric - bestBaseline : bestBaseline - currentMetric
  const regressionPct = bestBaseline === 0 ? null : degradation / Math.abs(bestBaseline) * 100
  return {
    name,
    accepted: true,
    status: "passed",
    reason: `Observed ${metricName}=${currentMetric} against best ${referenceLabel} ${bestBaseline}; ReflectionAgent assesses this comparison without a fixed regression rejection threshold.`,
    evidence: { advisory: true, currentMetric, bestBaseline, degradation, regressionPct, direction },
  }
}
