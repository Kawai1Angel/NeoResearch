import type { VerifierContext, VerifierResult } from "./types"
import { finiteNum, horizonMetrics } from "./types"

// Val MSE this much better than comparable train MSE is suspicious (possible leakage).
const LEAKAGE_VAL_TRAIN_RATIO = 0.4

// Longest-horizon MSE this much below shortest-horizon MSE is suspicious.
// This is a diagnostic heuristic, not a necessary property of leak-free forecasts.
const HORIZON_INVERSION_RATIO = 0.5

// All per-horizon MSEs within this relative spread → collapse (suspicious uniformity).
const HORIZON_COLLAPSE_CV = 0.005

function extractTrainMetric(metrics: Record<string, unknown>, scope: string): number | undefined {
  for (const key of scope === "cv" ? ["cv_train_avg_mse"] : ["train_avg_mse", "train_mse"]) {
    const value = finiteNum(metrics[key])
    if (value !== undefined && value > 0) return value
  }
  return undefined
}

function taskContextLength(task: VerifierContext["task"]): number | undefined {
  const spec = task.taskSpec as Record<string, unknown>
  const v = finiteNum(spec["contextLength"])
  return v !== undefined && v > 0 ? v : undefined
}

function taskPredictionLengths(task: VerifierContext["task"]): number[] {
  const spec = task.taskSpec as Record<string, unknown>
  const arr = spec["predictionLengths"]
  if (!Array.isArray(arr)) return []
  return arr.filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x > 0)
}

function evaluationProtocol(task: VerifierContext["task"]): string | undefined {
  const spec = task.taskSpec as Record<string, unknown>
  const evaluation = spec["evaluation"]
  if (!evaluation || typeof evaluation !== "object" || Array.isArray(evaluation)) return undefined
  const proto = (evaluation as Record<string, unknown>)["protocol"]
  return typeof proto === "string" ? proto : undefined
}

export function runDataLeakageVerifier(ctx: VerifierContext): VerifierResult {
  const name = "data_leakage_verifier" as const

  if (ctx.run.status !== "succeeded") {
    return {
      name,
      accepted: false,
      status: "skipped",
      reason: "Skipped: run did not succeed.",
      evidence: { skipped: true },
    }
  }

  const metrics = ctx.run.metrics as Record<string, unknown>
  const { scope, values: horizonMSEs } = horizonMetrics(ctx)
  const valAvgMse = finiteNum(metrics[`${scope}_avg_mse`])
  const trainMetric = extractTrainMetric(metrics, scope)
  const contextLength = taskContextLength(ctx.task)
  const predictionLengths = taskPredictionLengths(ctx.task)
  const protocol = evaluationProtocol(ctx.task)
  const maxHorizon = predictionLengths.length > 0 ? Math.max(...predictionLengths) : undefined

  // Both fixed split and ordered expanding-window CV are leak-safe protocols.
  if (protocol !== undefined && protocol !== "fixed_split" && protocol !== "expanding_window_ratio") {
    return {
      name,
      accepted: false,
      status: "failed",
      reason: `Evaluation protocol '${protocol}' is not a supported leak-safe time-ordered protocol.`,
      evidence: { protocol, expected: ["fixed_split", "expanding_window_ratio"] },
    }
  }

  // Check 2: Val MSE suspiciously better than comparable train MSE.
  // Easier validation data or training regularization can also explain this gap.
  if (valAvgMse !== undefined && trainMetric !== undefined) {
    const ratio = valAvgMse / trainMetric
    if (ratio < LEAKAGE_VAL_TRAIN_RATIO) {
      return {
        name,
        accepted: false,
        status: "insufficient_evidence",
        reason: `Val/train MSE ratio ${ratio.toFixed(3)} is below ${LEAKAGE_VAL_TRAIN_RATIO} (${scope}_avg_mse=${valAvgMse.toFixed(6)}, train=${trainMetric.toFixed(6)}). Audit split boundaries; a metric gap alone does not establish leakage.`,
        evidence: {
          valAvgMse,
          scope,
          trainMetric,
          ratio,
          threshold: LEAKAGE_VAL_TRAIN_RATIO,
        },
      }
    }
  }

  // Check 3: Per-horizon MSE monotonicity.
  // Horizon inversion may reflect different horizon models or predictable periods.
  if (horizonMSEs.length >= 2) {
    const shortest = horizonMSEs[0]!
    const longest = horizonMSEs[horizonMSEs.length - 1]!

    if (shortest.mse > 0) {
      const inversionRatio = longest.mse / shortest.mse
      if (inversionRatio < HORIZON_INVERSION_RATIO) {
        return {
          name,
          accepted: false,
          status: "insufficient_evidence",
          reason: `Horizon-MSE inversion: ${scope}_h${longest.horizon}_mse=${longest.mse.toFixed(6)} is only ${inversionRatio.toFixed(3)}x of ${scope}_h${shortest.horizon}_mse=${shortest.mse.toFixed(6)} (threshold ${HORIZON_INVERSION_RATIO}x). Audit evaluation boundaries; inversion alone does not establish leakage.`,
          evidence: {
            shortestHorizon: shortest.horizon,
            scope,
            shortestMse: shortest.mse,
            longestHorizon: longest.horizon,
            longestMse: longest.mse,
            inversionRatio,
            threshold: HORIZON_INVERSION_RATIO,
            allHorizons: horizonMSEs,
          },
        }
      }
    }

    // Check 4: Horizon MSE collapse (all horizons nearly identical).
    // A constant/noise-dominated process can have legitimate horizon-invariant error.
    const mseValues = horizonMSEs.map((h) => h.mse)
    const mean = mseValues.reduce((a, b) => a + b, 0) / mseValues.length
    if (mean > 0) {
      const variance = mseValues.reduce((acc, v) => acc + (v - mean) ** 2, 0) / mseValues.length
      const cv = Math.sqrt(variance) / mean
      if (cv < HORIZON_COLLAPSE_CV) {
        return {
          name,
          accepted: false,
          status: "insufficient_evidence",
          reason: `Per-horizon MSE collapse diagnostic: CV=${cv.toExponential(2)} across ${horizonMSEs.length} horizons (threshold ${HORIZON_COLLAPSE_CV}). Audit evaluation boundaries; uniform errors alone do not establish leakage.`,
          evidence: {
            allHorizons: horizonMSEs,
            scope,
            mean,
            cv,
            threshold: HORIZON_COLLAPSE_CV,
          },
        }
      }
    }
  }

  const missing = [
    ...(protocol === undefined ? ["evaluation protocol"] : []),
    ...(valAvgMse === undefined || trainMetric === undefined ? ["comparable train/validation MSE"] : []),
    ...(predictionLengths.some((h) => !horizonMSEs.some((metric) => metric.horizon === h)) ? ["per-horizon MSE"] : []),
  ]
  return {
    name,
    accepted: missing.length === 0,
    status: missing.length ? "insufficient_evidence" : "passed",
    reason: missing.length
      ? `No signal in available checks; not evaluated: ${missing.join(", ")}.`
      : "Available protocol and metric diagnostics passed; this is not proof of absence of leakage.",
    evidence: {
      scope,
      ...(protocol !== undefined ? { protocol } : {}),
      ...(valAvgMse !== undefined ? { valAvgMse } : {}),
      ...(trainMetric !== undefined && valAvgMse !== undefined
        ? { trainMetric, valTrainRatio: +(valAvgMse! / trainMetric).toFixed(4) }
        : {}),
      ...(horizonMSEs.length > 0 ? { horizonMSEs } : {}),
      ...(contextLength !== undefined ? { contextLength } : {}),
      ...(maxHorizon !== undefined ? { maxHorizon } : {}),
    },
  }
}
