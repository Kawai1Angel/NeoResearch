import type { VerifierContext, VerifierResult } from "./types"
import { comparablePreviousRuns, metricOf, objectiveMetricName, paramsM } from "./types"

function objectiveDirection(task: VerifierContext["task"]): "minimize" | "maximize" {
  return (task.objective as Record<string, unknown>).direction === "maximize" ? "maximize" : "minimize"
}

function paramBudgetM(task: VerifierContext["task"]): number | undefined {
  const spec = task.taskSpec as Record<string, unknown>
  const constraints = spec.constraints as Record<string, unknown> | undefined
  const metadata = spec.metadata as Record<string, unknown> | undefined
  // New slot writes normalize explicit limits to an absolute parameter count.
  // Free-text preferences do not constitute a hard constraint.
  if (metadata?.parameterBudgetEnforcement === "preference_only") return undefined
  if (typeof constraints?.maxParams === "number") return constraints.maxParams / 1_000_000
  const budget = task.budget as Record<string, unknown>
  const raw = budget.parameterBudget ?? budget.maxParams
  if (typeof raw === "number" && Number.isFinite(raw)) return raw / 1_000_000
  if (typeof raw === "string") {
    const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*([MmKk])?$/)
    if (match) return Number(match[1]) * (match[2]?.toLowerCase() === "m" ? 1 : match[2]?.toLowerCase() === "k" ? 0.001 : 0.000001)
  }
  if (typeof budget.maxParamsM === "number" && Number.isFinite(budget.maxParamsM)) return budget.maxParamsM
  return undefined
}

export function runCostPerfVerifier(ctx: VerifierContext): VerifierResult {
  const name = "cost_perf_verifier" as const
  const metricName = objectiveMetricName(ctx.task)
  const direction = objectiveDirection(ctx.task)
  const currentMetric = metricOf(ctx.run, metricName)
  const currentParams = paramsM(ctx.run)

  if (currentMetric === undefined || ctx.run.status !== "succeeded") {
    return {
      name,
      accepted: false,
      status: "skipped",
      reason: "Skipped: run did not succeed or metric is absent.",
      evidence: { skipped: true },
    }
  }

  const budgetM = paramBudgetM(ctx.task)
  if (currentParams !== undefined && budgetM !== undefined && currentParams > budgetM) {
    return {
      name,
      accepted: false,
      status: "failed",
      reason: `Model has ${currentParams.toFixed(2)}M parameters, exceeding user budget of ${budgetM}M.`,
      evidence: { currentParamsM: currentParams, budgetM },
    }
  }

  if (ctx.previousRuns.length === 0 || currentParams === undefined) {
    return {
      name,
      accepted: false,
      status: "skipped",
      reason: "No previous runs or param count unavailable; skipping cost-perf ratio check.",
      evidence: { skipped: true },
    }
  }

  const bestPreviousRun = comparablePreviousRuns(ctx)
    .reduce<{ metric: number; params: number | undefined } | undefined>((best, r) => {
      const m = metricOf(r, metricName)
      if (m === undefined) return best
      if (best === undefined) return { metric: m, params: paramsM(r) }
      const isBetter = direction === "minimize" ? m < best.metric : m > best.metric
      return isBetter ? { metric: m, params: paramsM(r) } : best
    }, undefined)

  if (bestPreviousRun === undefined || bestPreviousRun.params === undefined) {
    return {
      name,
      accepted: false,
      status: "skipped",
      reason: "Insufficient data to compute cost-perf ratio; comparison not evaluated.",
      evidence: { skipped: true },
    }
  }

  const metricGain =
    direction === "minimize" ? bestPreviousRun.metric - currentMetric : currentMetric - bestPreviousRun.metric
  const extraParams = currentParams - bestPreviousRun.params

  return {
    name,
    accepted: true,
    status: "passed",
    reason: `Observed ${currentParams}M parameters and ${metricName}=${currentMetric}; ReflectionAgent assesses the resource/performance tradeoff without a fixed gain-per-parameter rejection threshold.`,
    evidence: { advisory: true, currentParamsM: currentParams, previousParamsM: bestPreviousRun.params,
      extraParamsM: extraParams, metricGain, gainPerParamM: extraParams > 0 ? metricGain / extraParams : null },
  }
}
