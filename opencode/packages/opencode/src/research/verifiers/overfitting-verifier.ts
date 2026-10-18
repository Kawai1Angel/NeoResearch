import type { VerifierContext, VerifierResult } from "./types"
import { comparableLoss } from "./types"

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
      status: "skipped",
      reason: "No comparable validation loss for this objective; skipping overfitting check.",
      evidence: { skipped: true },
    }
  }

  if (trainMetric === undefined || trainMetric <= 0) {
    return {
      name,
      accepted: false,
      status: "skipped",
      reason: "No positive training loss with matching units and scope; skipping gap check.",
      evidence: { valMetric, ...(loss ? { scope: loss.scope, loss: loss.loss } : {}) },
    }
  }

  const ratio = valMetric / trainMetric
  return {
    name,
    accepted: true,
    status: "passed",
    reason: `Observed comparable validation/training ${loss!.loss.toUpperCase()} ratio ${ratio}; ReflectionAgent assesses the training curves and generalization without a fixed ratio rejection threshold.`,
    evidence: { advisory: true, valMetric, trainMetric, ratio, scope: loss!.scope, loss: loss!.loss },
  }
}
