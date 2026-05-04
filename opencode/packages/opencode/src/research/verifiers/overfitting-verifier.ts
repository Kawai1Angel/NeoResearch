import type { VerifierContext, VerifierResult } from "./types"
import { finiteNum } from "./types"

const MAX_VAL_TRAIN_RATIO = 3.0
const MAX_SUSPICIOUS_GOOD_MSE = 1e-4

function objectiveMetricName(task: VerifierContext["task"]): string {
  const o = task.objective as Record<string, unknown>
  if (typeof o.primaryMetric === "string") return o.primaryMetric
  if (typeof o.metric === "string") return o.metric
  return "val_avg_mse"
}

export function runOverfittingVerifier(ctx: VerifierContext): VerifierResult {
  const name = "overfitting_verifier" as const

  if (ctx.run.status !== "succeeded") {
    return {
      name,
      accepted: true,
      reason: "Skipped: run did not succeed.",
      evidence: { skipped: true },
    }
  }

  const metrics = ctx.run.metrics as Record<string, unknown>
  const primaryMetricName = objectiveMetricName(ctx.task)
  const valMetric = finiteNum(metrics[primaryMetricName])

  if (valMetric === undefined) {
    return {
      name,
      accepted: true,
      reason: "Primary metric absent; skipping overfitting check.",
      evidence: { skipped: true },
    }
  }

  if (valMetric < MAX_SUSPICIOUS_GOOD_MSE && primaryMetricName.includes("mse")) {
    return {
      name,
      accepted: false,
      reason: `Val MSE=${valMetric.toExponential(3)} is suspiciously small (< ${MAX_SUSPICIOUS_GOOD_MSE}); possible data leakage or unit mismatch.`,
      evidence: { valMetric, threshold: MAX_SUSPICIOUS_GOOD_MSE, primaryMetricName },
    }
  }

  const trainMetricKeys = ["train_avg_mse", "train_mse", "train_loss", "final_train_loss"]
  let trainMetric: number | undefined
  for (const key of trainMetricKeys) {
    const v = finiteNum(metrics[key])
    if (v !== undefined) {
      trainMetric = v
      break
    }
  }

  if (trainMetric === undefined || trainMetric <= 0) {
    return {
      name,
      accepted: true,
      reason: "No training metric available to compute train/val gap; skipping gap check.",
      evidence: { valMetric },
    }
  }

  const ratio = valMetric / trainMetric
  if (ratio > MAX_VAL_TRAIN_RATIO) {
    return {
      name,
      accepted: false,
      reason: `Val/train MSE ratio ${ratio.toFixed(2)} exceeds ${MAX_VAL_TRAIN_RATIO}x (val=${valMetric.toFixed(6)}, train=${trainMetric.toFixed(6)}); possible overfitting.`,
      evidence: {
        valMetric,
        trainMetric,
        ratio,
        threshold: MAX_VAL_TRAIN_RATIO,
      },
    }
  }

  return {
    name,
    accepted: true,
    reason: `Val/train ratio ${ratio.toFixed(2)}x is within acceptable range (threshold ${MAX_VAL_TRAIN_RATIO}x).`,
    evidence: { valMetric, trainMetric, ratio },
  }
}
