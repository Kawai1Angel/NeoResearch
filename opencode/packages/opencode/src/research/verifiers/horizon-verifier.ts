import type { VerifierContext, VerifierResult } from "./types"
import { finiteNum } from "./types"

const HORIZON_COLLAPSE_RATIO = 8.0
const KNOWN_HORIZONS = [96, 192, 336, 720]

function extractHorizonMetrics(run: VerifierContext["run"]): { horizon: number; mse: number }[] {
  const metrics = run.metrics as Record<string, unknown>
  const result: { horizon: number; mse: number }[] = []
  for (const horizon of KNOWN_HORIZONS) {
    for (const key of [`val_mse_${horizon}`, `mse_${horizon}`, `val_mse_h${horizon}`]) {
      const v = finiteNum(metrics[key])
      if (v !== undefined) {
        result.push({ horizon, mse: v })
        break
      }
    }
  }
  return result.sort((a, b) => a.horizon - b.horizon)
}

export function runHorizonVerifier(ctx: VerifierContext): VerifierResult {
  const name = "horizon_verifier" as const

  if (ctx.run.status !== "succeeded") {
    return {
      name,
      accepted: true,
      reason: "Skipped: run did not succeed.",
      evidence: { skipped: true },
    }
  }

  const horizonMetrics = extractHorizonMetrics(ctx.run)
  if (horizonMetrics.length < 2) {
    return {
      name,
      accepted: true,
      reason: "Fewer than two horizon-specific MSE keys found; skipping horizon collapse check.",
      evidence: { horizonCount: horizonMetrics.length },
    }
  }

  const shortest = horizonMetrics[0]!
  const longest = horizonMetrics[horizonMetrics.length - 1]!

  if (shortest.mse <= 0) {
    return {
      name,
      accepted: true,
      reason: "Shortest horizon MSE is zero or negative; skipping ratio check to avoid division by zero.",
      evidence: { shortestHorizon: shortest.horizon, shortestMse: shortest.mse },
    }
  }

  const ratio = longest.mse / shortest.mse

  if (ratio > HORIZON_COLLAPSE_RATIO) {
    return {
      name,
      accepted: false,
      reason: `Long-horizon collapse detected: val_mse_${longest.horizon}=${Number(longest.mse.toFixed(6))} is ${ratio.toFixed(2)}x val_mse_${shortest.horizon}=${Number(shortest.mse.toFixed(6))} (threshold ${HORIZON_COLLAPSE_RATIO}x).`,
      evidence: {
        shortestHorizon: shortest.horizon,
        shortestMse: shortest.mse,
        longestHorizon: longest.horizon,
        longestMse: longest.mse,
        ratio,
        threshold: HORIZON_COLLAPSE_RATIO,
        allHorizons: horizonMetrics,
      },
    }
  }

  return {
    name,
    accepted: true,
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
