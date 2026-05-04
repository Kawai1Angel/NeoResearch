import type { VerifierContext, VerifierResult } from "./types"
import { metricOf, paramsM } from "./types"

const MAX_PARAMS_M_WITHOUT_GAIN = 50
const MIN_GAIN_PER_EXTRA_PARAM_M = 0.001

function objectiveMetricName(task: VerifierContext["task"]): string {
  const o = task.objective as Record<string, unknown>
  if (typeof o.primaryMetric === "string") return o.primaryMetric
  if (typeof o.metric === "string") return o.metric
  return "val_avg_mse"
}

function objectiveDirection(task: VerifierContext["task"]): "minimize" | "maximize" {
  return (task.objective as Record<string, unknown>).direction === "maximize" ? "maximize" : "minimize"
}

function paramBudgetM(task: VerifierContext["task"]): number | undefined {
  const budget = task.budget as Record<string, unknown>
  const raw = budget.parameterBudget ?? budget.maxParams ?? budget.maxParamsM
  if (typeof raw === "number" && Number.isFinite(raw)) return raw
  if (typeof raw === "string") {
    const match = raw.match(/(\d+(?:\.\d+)?)\s*[Mm]/)
    if (match) return Number(match[1])
  }
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
      accepted: true,
      reason: "Skipped: run did not succeed or metric is absent.",
      evidence: { skipped: true },
    }
  }

  const budgetM = paramBudgetM(ctx.task)
  if (currentParams !== undefined && budgetM !== undefined && currentParams > budgetM) {
    return {
      name,
      accepted: false,
      reason: `Model has ${currentParams.toFixed(2)}M parameters, exceeding user budget of ${budgetM}M.`,
      evidence: { currentParamsM: currentParams, budgetM },
    }
  }

  if (ctx.previousRuns.length === 0 || currentParams === undefined) {
    return {
      name,
      accepted: true,
      reason: "No previous runs or param count unavailable; skipping cost-perf ratio check.",
      evidence: { skipped: true },
    }
  }

  const bestPreviousRun = ctx.previousRuns
    .filter((r) => r.status === "succeeded")
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
      accepted: true,
      reason: "Insufficient data to compute cost-perf ratio; accepting by default.",
      evidence: { skipped: true },
    }
  }

  const metricGain =
    direction === "minimize"
      ? bestPreviousRun.metric - currentMetric
      : currentMetric - bestPreviousRun.metric
  const extraParams = currentParams - bestPreviousRun.params

  if (extraParams > MAX_PARAMS_M_WITHOUT_GAIN && metricGain <= 0) {
    return {
      name,
      accepted: false,
      reason: `Model added ${extraParams.toFixed(2)}M extra params (${bestPreviousRun.params.toFixed(2)}M → ${currentParams.toFixed(2)}M) with no metric improvement (delta=${metricGain.toFixed(6)}).`,
      evidence: {
        currentParamsM: currentParams,
        previousParamsM: bestPreviousRun.params,
        extraParamsM: extraParams,
        metricGain,
        threshold: MAX_PARAMS_M_WITHOUT_GAIN,
      },
    }
  }

  if (extraParams > 0 && metricGain > 0) {
    const gainPerParam = metricGain / extraParams
    if (gainPerParam < MIN_GAIN_PER_EXTRA_PARAM_M && currentParams > 20) {
      return {
        name,
        accepted: false,
        reason: `Metric gain (${metricGain.toFixed(6)}) per extra param-M (${extraParams.toFixed(2)}M) = ${gainPerParam.toFixed(6)} is below minimum threshold ${MIN_GAIN_PER_EXTRA_PARAM_M}.`,
        evidence: {
          currentParamsM: currentParams,
          previousParamsM: bestPreviousRun.params,
          extraParamsM: extraParams,
          metricGain,
          gainPerParamM: gainPerParam,
          minGainPerParamM: MIN_GAIN_PER_EXTRA_PARAM_M,
        },
      }
    }
  }

  return {
    name,
    accepted: true,
    reason:
      currentParams !== undefined
        ? `Cost-perf acceptable: ${currentParams.toFixed(2)}M params, metric=${Number(currentMetric.toFixed(6))}.`
        : `Cost-perf check passed (no param count available to penalize).`,
    evidence: { currentParamsM: currentParams, currentMetric },
  }
}
