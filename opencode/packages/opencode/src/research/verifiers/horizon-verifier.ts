import type { VerifierContext, VerifierResult } from "./types"
import { horizonMetrics } from "./types"

const HORIZON_COLLAPSE_RATIO = 8.0
export function runHorizonVerifier(ctx: VerifierContext): VerifierResult {
  const name = "horizon_verifier" as const

  if (ctx.run.status !== "succeeded") {
    return {
      name,
      accepted: false,
      status: "skipped",
      reason: "Skipped: run did not succeed.",
      evidence: { skipped: true },
    }
  }

  const extracted = horizonMetrics(ctx)
  const values = extracted.values
  const declared = ctx.task.taskSpec.predictionLengths
  const missing = Array.isArray(declared)
    ? declared.filter((h) => typeof h === "number" && !values.some((v) => v.horizon === h))
    : []
  if (missing.length)
    return {
      name,
      accepted: false,
      status: "insufficient_evidence",
      reason: "Declared horizon metrics are missing.",
      evidence: { scope: extracted.scope, missingHorizons: missing },
    }
  if (values.some((v) => v.mse < 0))
    return {
      name,
      accepted: false,
      status: "failed",
      reason: "MSE cannot be negative.",
      evidence: { scope: extracted.scope, allHorizons: values },
    }
  if (Array.isArray(declared) && declared.length === 1 && values.length === 1)
    return {
      name,
      accepted: true,
      status: "passed",
      reason: "The single declared horizon has a valid MSE; a cross-horizon comparison does not apply.",
      evidence: { scope: extracted.scope, allHorizons: values },
    }
  if (values.length < 2) {
    return {
      name,
      accepted: false,
      status: "insufficient_evidence",
      reason: "Fewer than two horizon-specific MSE keys found; skipping horizon collapse check.",
      evidence: { scope: extracted.scope, horizonCount: values.length },
    }
  }

  const shortest = values[0]!
  const longest = values[values.length - 1]!

  if (shortest.mse <= 0) {
    return {
      name,
      accepted: false,
      status: "insufficient_evidence",
      reason: "Shortest horizon MSE is zero or negative; skipping ratio check to avoid division by zero.",
      evidence: { shortestHorizon: shortest.horizon, shortestMse: shortest.mse },
    }
  }

  const ratio = longest.mse / shortest.mse

  if (ratio > HORIZON_COLLAPSE_RATIO) {
    return {
      name,
      accepted: false,
      status: "failed",
      reason: `Long-horizon collapse detected: val_mse_${longest.horizon}=${Number(longest.mse.toFixed(6))} is ${ratio.toFixed(2)}x val_mse_${shortest.horizon}=${Number(shortest.mse.toFixed(6))} (threshold ${HORIZON_COLLAPSE_RATIO}x).`,
      evidence: {
        shortestHorizon: shortest.horizon,
        shortestMse: shortest.mse,
        longestHorizon: longest.horizon,
        longestMse: longest.mse,
        ratio,
        threshold: HORIZON_COLLAPSE_RATIO,
        allHorizons: values,
      },
    }
  }

  return {
    name,
    accepted: true,
    status: "passed",
    reason: `Horizon-wise MSE ratio ${ratio.toFixed(2)}x (h${shortest.horizon}→h${longest.horizon}) is within the ${HORIZON_COLLAPSE_RATIO}x threshold.`,
    evidence: {
      shortestHorizon: shortest.horizon,
      shortestMse: shortest.mse,
      longestHorizon: longest.horizon,
      longestMse: longest.mse,
      ratio,
    },
  }
}
