import type { VerifierContext, VerifierResult } from "./types"
import { finiteNum } from "./types"

// Val MSE this much better than train loss is suspicious (possible leakage).
const LEAKAGE_VAL_TRAIN_RATIO = 0.4

// Longest-horizon MSE this much below shortest-horizon MSE is suspicious.
// Normally MSE should increase (or stay flat) as horizon grows.
const HORIZON_INVERSION_RATIO = 0.5

// All per-horizon MSEs within this relative spread → collapse (suspicious uniformity).
const HORIZON_COLLAPSE_CV = 0.005

// If max prediction length ≥ this fraction of context length, val windows likely
// share most context with training windows, raising leakage risk.
const CONTEXT_HORIZON_RATIO_WARN = 1.0

const KNOWN_HORIZONS = [96, 192, 336, 720]

function extractHorizonMSEs(metrics: Record<string, unknown>): { horizon: number; mse: number }[] {
  const results: { horizon: number; mse: number }[] = []
  for (const h of KNOWN_HORIZONS) {
    for (const key of [`val_h${h}_mse`, `val_mse_${h}`, `val_mse_h${h}`, `mse_${h}`]) {
      const v = finiteNum(metrics[key])
      if (v !== undefined) {
        results.push({ horizon: h, mse: v })
        break
      }
    }
  }
  return results.sort((a, b) => a.horizon - b.horizon)
}

function extractTrainMetric(metrics: Record<string, unknown>): number | undefined {
  for (const key of ["train_avg_mse", "train_mse", "train_loss", "final_train_loss"]) {
    const v = finiteNum(metrics[key])
    if (v !== undefined && v > 0) return v
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
      accepted: true,
      reason: "Skipped: run did not succeed.",
      evidence: { skipped: true },
    }
  }

  const metrics = ctx.run.metrics as Record<string, unknown>
  const valAvgMse = finiteNum(metrics["val_avg_mse"])
  const horizonMSEs = extractHorizonMSEs(metrics)
  const trainMetric = extractTrainMetric(metrics)
  const contextLength = taskContextLength(ctx.task)
  const predictionLengths = taskPredictionLengths(ctx.task)
  const protocol = evaluationProtocol(ctx.task)
  const maxHorizon = predictionLengths.length > 0 ? Math.max(...predictionLengths) : undefined

  // Check 1: Evaluation protocol must be fixed_split.
  // Rolling-window or other protocols shift split boundaries per-run, risking leakage.
  if (protocol !== undefined && protocol !== "fixed_split") {
    return {
      name,
      accepted: false,
      reason: `Evaluation protocol '${protocol}' is not 'fixed_split'. Non-fixed protocols may shift split boundaries and leak future data into training.`,
      evidence: { protocol, expected: "fixed_split" },
    }
  }

  // Check 2: Context-window boundary feasibility.
  // If max horizon ≥ context length, val windows overlap heavily with training context windows,
  // making it nearly impossible to prevent leakage at the boundary.
  if (contextLength !== undefined && maxHorizon !== undefined) {
    if (maxHorizon >= contextLength * CONTEXT_HORIZON_RATIO_WARN) {
      return {
        name,
        accepted: false,
        reason: `Max prediction length ${maxHorizon} ≥ context length ${contextLength}. Val/test windows overlap extensively with training context windows, creating structural leakage risk.`,
        evidence: { contextLength, maxHorizon, ratio: maxHorizon / contextLength, threshold: CONTEXT_HORIZON_RATIO_WARN },
      }
    }
  }

  // Check 3: Val MSE suspiciously better than train loss.
  // A model that generalises much better on val than train usually indicates
  // val targets or context bled into the training objective.
  if (valAvgMse !== undefined && trainMetric !== undefined) {
    const ratio = valAvgMse / trainMetric
    if (ratio < LEAKAGE_VAL_TRAIN_RATIO) {
      return {
        name,
        accepted: false,
        reason: `Val/train MSE ratio ${ratio.toFixed(3)} is below ${LEAKAGE_VAL_TRAIN_RATIO} (val_avg_mse=${valAvgMse.toFixed(6)}, train=${trainMetric.toFixed(6)}). Val is suspiciously better than training, suggesting data leakage.`,
        evidence: {
          valAvgMse,
          trainMetric,
          ratio,
          threshold: LEAKAGE_VAL_TRAIN_RATIO,
        },
      }
    }
  }

  // Check 4: Per-horizon MSE monotonicity.
  // Longer horizons should generally be harder (higher MSE). A strong inversion —
  // where the longest horizon is much better than the shortest — is a leakage signal.
  if (horizonMSEs.length >= 2) {
    const shortest = horizonMSEs[0]!
    const longest = horizonMSEs[horizonMSEs.length - 1]!

    if (shortest.mse > 0) {
      const inversionRatio = longest.mse / shortest.mse
      if (inversionRatio < HORIZON_INVERSION_RATIO) {
        return {
          name,
          accepted: false,
          reason: `Horizon-MSE inversion: val_h${longest.horizon}_mse=${longest.mse.toFixed(6)} is only ${inversionRatio.toFixed(3)}x of val_h${shortest.horizon}_mse=${shortest.mse.toFixed(6)} (threshold ${HORIZON_INVERSION_RATIO}x). Long horizons performing far better than short horizons suggests future-context leakage.`,
          evidence: {
            shortestHorizon: shortest.horizon,
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

    // Check 5: Horizon MSE collapse (all horizons nearly identical).
    // Indicates the model ignores horizon length, typically due to target leakage
    // (val targets visible during context construction).
    const mseValues = horizonMSEs.map((h) => h.mse)
    const mean = mseValues.reduce((a, b) => a + b, 0) / mseValues.length
    if (mean > 0) {
      const variance = mseValues.reduce((acc, v) => acc + (v - mean) ** 2, 0) / mseValues.length
      const cv = Math.sqrt(variance) / mean
      if (cv < HORIZON_COLLAPSE_CV) {
        return {
          name,
          accepted: false,
          reason: `Per-horizon MSE collapse detected: CV=${cv.toExponential(2)} across ${horizonMSEs.length} horizons (threshold ${HORIZON_COLLAPSE_CV}). Horizon-invariant MSE suggests the model sees future target values during evaluation.`,
          evidence: {
            allHorizons: horizonMSEs,
            mean,
            cv,
            threshold: HORIZON_COLLAPSE_CV,
          },
        }
      }
    }
  }

  return {
    name,
    accepted: true,
    reason: "No data leakage signals detected (protocol, context boundary, val/train ratio, horizon monotonicity all pass).",
    evidence: {
      ...(protocol !== undefined ? { protocol } : {}),
      ...(valAvgMse !== undefined ? { valAvgMse } : {}),
      ...(trainMetric !== undefined ? { trainMetric, valTrainRatio: +(valAvgMse! / trainMetric).toFixed(4) } : {}),
      ...(horizonMSEs.length > 0 ? { horizonMSEs } : {}),
      ...(contextLength !== undefined ? { contextLength } : {}),
      ...(maxHorizon !== undefined ? { maxHorizon } : {}),
    },
  }
}
