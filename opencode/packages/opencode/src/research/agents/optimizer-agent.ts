import z from "zod"
import { isDeepStrictEqual } from "node:util"
import { TrainingStrategy, optimizedRecipe } from "../design-contract"
import type { JsonRecord } from "../schema"

export const OptimizerDecision = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("tune"), rationale: z.string().trim().min(1), trainingStrategy: TrainingStrategy })
    .strict(),
  z.object({ action: z.literal("finish_design"), rationale: z.string().trim().min(1) }).strict(),
  z.object({ action: z.literal("return_to_outer"), rationale: z.string().trim().min(1) }).strict(),
])
export type OptimizerDecision = z.infer<typeof OptimizerDecision>

export function validateOptimizerDecision(value: unknown, recipe: JsonRecord, constraints: JsonRecord = {}) {
  const decision = OptimizerDecision.parse(value)
  if (decision.action !== "tune") return decision
  const next = optimizedRecipe(recipe, decision.trainingStrategy)
  if (isDeepStrictEqual(TrainingStrategy.parse(recipe.trainingStrategy), next.trainingStrategy))
    throw new Error("OptimizerAgent proposed an unchanged training configuration")
  const budget = decision.trainingStrategy.budget
  if (typeof constraints.maxTrainingSeconds === "number" && budget.timeBudgetS > constraints.maxTrainingSeconds)
    throw new Error("OptimizerAgent exceeded the task training-time limit")
  return decision
}
