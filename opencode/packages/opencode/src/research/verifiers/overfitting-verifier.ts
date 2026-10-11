import type { VerifierContext, VerifierResult } from "./types"
import { comparableLoss } from "./types"

const MAX_VAL_TRAIN_RATIO = 3.0

export function runOverfittingVerifier(ctx: VerifierContext): VerifierResult {
  const name = "overfitting_verifier" as const

  if (ctx.run.status !== "succeeded") {
    return {
      name,
      accepted: false,
      status: "skipped",
      reason: "Skipped: run did not succeed.",
      evidence: { skipped: true },
    }
  }

  const loss = comparableLoss(ctx)
  const valMetric = loss?.validation
  const trainMetric = loss?.train

  if (valMetric === undefined) {
    return {
      name,
      accepted: false,
      status: "insufficient_evidence",
      reason: "No comparable validation loss for this objective; skipping overfitting check.",
      evidence: { skipped: true },
    }
  }

  if (trainMetric === undefined || trainMetric <= 0) {
    return {
      name,
      accepted: false,
      status: "insufficient_evidence",
      reason: "No positive training loss with matching units and scope; skipping gap check.",
      evidence: { valMetric, ...(loss ? { scope: loss.scope, loss: loss.loss } : {}) },
    }
  }

  const ratio = valMetric / trainMetric
  if (ratio > MAX_VAL_TRAIN_RATIO) {
    return {
      name,
      accepted: false,
      status: "failed",
      reason: `Val/train ${loss!.loss.toUpperCase()} ratio ${ratio.toFixed(2)} exceeds ${MAX_VAL_TRAIN_RATIO}x (val=${valMetric.toFixed(6)}, train=${trainMetric.toFixed(6)}); possible overfitting.`,
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
    status: "passed",
    reason: `Val/train ratio ${ratio.toFixed(2)}x is within acceptable range (threshold ${MAX_VAL_TRAIN_RATIO}x).`,
    evidence: { valMetric, trainMetric, ratio },
  }
}
