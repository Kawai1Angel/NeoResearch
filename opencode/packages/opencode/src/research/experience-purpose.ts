import z from "zod"
import { isDeepStrictEqual } from "node:util"
import { ExperimentConstraints, changedFields, recipeFields } from "./experiment-constraints"
import { normalizedRecipePath } from "./recipe-naming"
import { assessAttribution } from "./attribution"
import type { ExperienceDraft, ExperimentFact, ResearchExperience } from "./experience"

export const ExperiencePurpose = z.enum(["optimization", "architecture"])
export type ExperiencePurpose = z.infer<typeof ExperiencePurpose>
export const ExperienceOrigin = z
  .object({
    reflectionKey: z.string().min(1),
    designID: z.string().min(1),
    trialID: z.string().optional(),
    inputDigest: z.string().min(1),
    purpose: ExperiencePurpose,
    sourceRunIDs: z.array(z.string()).min(1),
  })
  .strict()
export type ExperienceOrigin = z.infer<typeof ExperienceOrigin>
export type ExperienceReader =
  | "optimizer"
  | "hypoplanner"
  | "model_designer"
  | "training_reflection"
  | "architecture_reflection"
export const readerPurpose = (reader: ExperienceReader): ExperiencePurpose =>
  reader === "optimizer" || reader === "training_reflection" ? "optimization" : "architecture"
export function agentExperienceReader(agent: string): ExperienceReader | undefined {
  if (agent === "research-optimizer") return "optimizer"
  if (agent.startsWith("research-hypo-planner")) return "hypoplanner"
  if (agent === "research-model-designer") return "model_designer"
  if (agent === "research-reflection-training") return "training_reflection"
  if (agent === "research-reflection-architecture") return "architecture_reflection"
}

/** Classify factual interventions, never the model's prose or a maturity label. */
export function inferExperiencePurpose(draft: ExperienceDraft, facts: ExperimentFact[]): ExperiencePurpose | undefined {
  if (draft.claimType === "execution") return "optimization"
  const purposes = new Set<ExperiencePurpose>()
  for (const ref of draft.evidence) {
    const fact = facts.find((item) => item.runID === ref.runID)
    if (!fact) return
    if (draft.claimType !== "performance" && fact.error && ["failed", "invalid"].includes(fact.status)) {
      purposes.add("optimization")
      continue
    }
    const contract = ExperimentConstraints.safeParse(
      fact.trainingTrial?.contract ?? fact.hypothesisSnapshot?.experimentContract,
    )
    if (contract.success && contract.data.mode === "controlled") {
      const control = facts.find((item) => item.runID === contract.data.comparisonRunID)
      if (!control && draft.claimType !== "performance" && fact.executionVerified) {
        // A captured contract identifies the purpose of a configuration observation;
        // it does not supply the missing control or validate its effect.
        const declared = contract.data.changes.map((change) => change.path)
        if (declared.length && declared.every((path) => path.startsWith("trainingStrategy")))
          purposes.add("optimization")
        else if (declared.length && declared.every((path) => !path.startsWith("trainingStrategy")))
          purposes.add("architecture")
        else return
        continue
      }
      if (!control?.proposedModel || !fact.proposedModel || assessAttribution(fact, control).status !== "eligible")
        return
      const paths = changedFields(recipeFields(control.proposedModel), recipeFields(fact.proposedModel))
      if (!paths.length) return
      if (paths.every((path) => path === "trainingStrategy" || path.startsWith("trainingStrategy.")))
        purposes.add("optimization")
      else if (
        paths.every((path) => path !== "trainingStrategy" && !path.startsWith("trainingStrategy.")) &&
        isDeepStrictEqual(fact.proposedModel.trainingStrategy, control.proposedModel.trainingStrategy)
      )
        purposes.add("architecture")
      else return
    } else if (fact.trainingTrial?.contract) purposes.add("optimization")
    else if (contract.success && ["baseline", "exploratory"].includes(contract.data.mode)) purposes.add("architecture")
    else return
  }
  return purposes.size === 1 ? [...purposes][0] : undefined
}

export function validateExperiencePurpose(
  purpose: ExperiencePurpose,
  draft: ExperienceDraft,
  facts: ExperimentFact[],
  origin?: ExperienceOrigin,
) {
  ExperiencePurpose.parse(purpose)
  if (draft.claimType === "execution" && purpose !== "optimization")
    throw new Error("Execution observations belong to optimization memory")
  const inferred = inferExperiencePurpose(draft, facts)
  if (draft.claimType === "performance" && inferred !== purpose)
    throw new Error(
      "Memory purpose must match an isolated factual training or architecture contrast; joint interventions cannot establish either",
    )
  if (purpose === "architecture" && inferred === "optimization")
    throw new Error("Training-only evidence cannot be promoted to architecture memory")
  if (origin && origin.purpose !== purpose)
    throw new Error("Memory purpose differs from its committed reflection scope")
  const claimPaths = (draft.evolution?.claim?.interventionPaths ?? []).map(normalizedRecipePath)
  if (
    purpose === "optimization" &&
    draft.claimType !== "execution" &&
    claimPaths.some((path) => !path.startsWith("trainingStrategy"))
  )
    throw new Error("Optimization memory cannot introduce an architectural intervention claim")
  if (purpose === "architecture" && claimPaths.some((path) => path.startsWith("trainingStrategy")))
    throw new Error("Architecture memory cannot introduce a training intervention claim")
  if (purpose === "architecture" && draft.evolution?.claim?.expectedOutcome.direction.startsWith("execution_"))
    throw new Error("Execution outcomes cannot establish an architecture experience claim")
}

/** Legacy unknown is a classification state, not a third memory purpose. */
export function experiencePurpose(experience: ResearchExperience): ExperiencePurpose | undefined {
  const inferred = inferExperiencePurpose(experience.draft, experience.facts)
  if (!experience.purpose) return inferred
  validateExperiencePurpose(experience.purpose, experience.draft, experience.facts, experience.origin)
  return experience.purpose
}
