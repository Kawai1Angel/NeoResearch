import { isDeepStrictEqual } from "node:util"
import {
  ExperimentConstraints,
  checkExperimentConstraints,
  changedFields,
  recipeFields,
} from "./experiment-constraints"
import type { ExperimentFact } from "./experience"

/** Metric validity is independent from eligibility to test or explain a mechanism. */
export function assessAttribution(
  fact: Pick<ExperimentFact, "executionVerified" | "proposedModel" | "hypothesisSnapshot" | "trainingTrial">,
  comparison?: { proposedModel?: Record<string, unknown> },
) {
  const parsed = ExperimentConstraints.safeParse(fact.trainingTrial?.contract ?? fact.hypothesisSnapshot?.experimentContract)
  if (!parsed.success)
    return {
      status: "insufficient_evidence" as const,
      reasons: ["No structured experiment contract was captured before execution."],
      changedPaths: [],
    }
  if (!fact.executionVerified || !fact.proposedModel)
    return {
      status: "insufficient_evidence" as const,
      reasons: ["Actual execution has not been verified."],
      changedPaths: [],
    }
  const contract = parsed.data
  const issues = checkExperimentConstraints(contract, fact.proposedModel, comparison?.proposedModel)
  if (issues.length)
    return {
      status: "mismatch" as const,
      reasons: issues.map((x) => `${x.path}: expected ${JSON.stringify(x.expected)}, got ${JSON.stringify(x.actual)}`),
      changedPaths: [],
    }
  if (contract.mode !== "controlled")
    return {
      status: "observation_only" as const,
      reasons: ["Baseline/exploratory observation; no controlled comparison establishes a mechanism."],
      changedPaths: [],
    }
  return {
    status: "eligible" as const,
    scope: fact.trainingTrial?.contract ? "optimization" as const : "architecture" as const,
    reasons: [],
    comparisonRunID: contract.comparisonRunID,
    changedPaths: changedFields(recipeFields(comparison!.proposedModel!), recipeFields(fact.proposedModel)),
  }
}

export function requireAttributableComparison(fact: ExperimentFact, comparison: ExperimentFact | undefined) {
  if (!comparison) throw new Error("Scientific attribution requires the contract's named comparison run")
  const assessment = assessAttribution(fact, comparison)
  if (assessment.status !== "eligible" || assessment.comparisonRunID !== comparison.runID)
    throw new Error(
      `Hypothesis attribution unavailable: ${assessment.reasons.join("; ") || "comparison does not match the predeclared contract"}`,
    )
  if (!isDeepStrictEqual(fact.evaluation, comparison.evaluation))
    throw new Error("Attribution requires identical evaluation settings")
  return assessment
}
