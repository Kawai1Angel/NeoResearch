import { isDeepStrictEqual } from "node:util"
import { digest } from "./digest"
import { TSFCandidateRecipe } from "./domains/tsf"
import { checkExperimentConstraints, type ExperimentConstraints } from "./experiment-constraints"
import type { JsonRecord } from "./schema"

export const TrainingStrategy = TSFCandidateRecipe.shape.trainingStrategy
export type TrainingStrategy = ReturnType<typeof TrainingStrategy.parse>

// This is the coordinator's immutable design contract, not the Python cache identity.
// Parse first so aliases/default omissions cannot authorize structural changes.
export function fixedDesign(recipe: JsonRecord) {
  const { trainingStrategy, recipeID, hypothesis, notes, ...design } = TSFCandidateRecipe.parse(recipe)
  return design
}

export function designDigest(recipe: JsonRecord) {
  return digest(fixedDesign(recipe))
}

export function optimizedRecipe(base: JsonRecord, strategy: TrainingStrategy): JsonRecord {
  const original = TSFCandidateRecipe.parse(base)
  const training = TrainingStrategy.parse(strategy)
  if (training.budget.seed !== original.trainingStrategy.budget.seed)
    throw new Error("OptimizerAgent must preserve the design's seed")
  const candidate = TSFCandidateRecipe.parse({ ...original, trainingStrategy: training })
  if (designDigest(candidate as unknown as JsonRecord) !== designDigest(base))
    throw new Error("OptimizerAgent changed the fixed design")
  return candidate as unknown as JsonRecord
}

function trainingChanges(base: JsonRecord, next: JsonRecord): ExperimentConstraints["changes"] {
  if (designDigest(base) !== designDigest(next)) throw new Error("Training trials must preserve the fixed design")
  const before = TSFCandidateRecipe.parse(base).trainingStrategy
  const after = TSFCandidateRecipe.parse(next).trainingStrategy
  if (before.budget.seed !== after.budget.seed) throw new Error("Training trials cannot tune the seed")
  const changes: ExperimentConstraints["changes"] = []
  for (const key of ["loss", "optimizer", "scheduler", "regularization", "budget"] as const) {
    if (isDeepStrictEqual(before[key], after[key])) continue
    changes.push({ operation: "set", path: `trainingStrategy.${key}`, before: before[key], after: after[key] })
  }
  if (!changes.length) throw new Error("OptimizerAgent proposed an unchanged training configuration")
  return changes
}

export function trainingContract(base: JsonRecord, next: JsonRecord, comparisonRunID: string): ExperimentConstraints {
  return {
    mode: "controlled",
    comparisonRunID,
    changes: trainingChanges(base, next),
    frozenPaths: [],
    requiredValues: [],
    forbiddenMechanisms: [],
  }
}

// Failed attempts are diagnostic evidence, never performance controls. Pin the
// complete training strategy so repair trials retain an executable contract.
export function trainingRepairContract(base: JsonRecord, next: JsonRecord): ExperimentConstraints {
  trainingChanges(base, next)
  return {
    mode: "exploratory",
    changes: [],
    frozenPaths: [],
    forbiddenMechanisms: [],
    requiredValues: [{ path: "trainingStrategy", value: TSFCandidateRecipe.parse(next).trainingStrategy }],
  }
}

export function checkTrainingTrial(input: {
  design: JsonRecord
  candidate: JsonRecord
  contract: ExperimentConstraints
  comparison?: JsonRecord
}) {
  const issues = checkExperimentConstraints(input.contract, input.candidate, input.comparison)
  if (designDigest(input.design) !== designDigest(input.candidate))
    issues.push({
      path: "designDigest",
      expected: designDigest(input.design),
      actual: designDigest(input.candidate),
      source: "training_trial",
      rule: "implicit_freeze",
      message: "Training optimization cannot change preprocessing or architecture",
      repairHint: "Return to the outer loop for a design revision",
    })
  const seed = TSFCandidateRecipe.parse(input.design).trainingStrategy.budget.seed
  if (TSFCandidateRecipe.parse(input.candidate).trainingStrategy.budget.seed !== seed)
    issues.push({
      path: "trainingStrategy.budget.seed",
      expected: seed,
      actual: TSFCandidateRecipe.parse(input.candidate).trainingStrategy.budget.seed,
      source: "training_trial",
      rule: "implicit_freeze",
      message: "The evaluation seed is fixed",
      repairHint: "Preserve the design seed",
    })
  if (input.contract.changes.some((change) => !change.path.startsWith("trainingStrategy.")))
    throw new Error("A training contract may only declare trainingStrategy changes")
  return issues
}
