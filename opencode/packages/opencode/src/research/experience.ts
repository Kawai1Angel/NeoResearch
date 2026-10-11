import { requireAttributableComparison, assessAttribution } from "./attribution"
import { reflectionExecutionEvidence } from "./runner-evidence"
import z from "zod"
import { isDeepStrictEqual } from "node:util"
import type { ResearchMemory } from "./schema"

const text = z.string().trim().min(1).max(4000)
const json = z.record(z.string(), z.unknown())
export const ExperienceLevel = z.enum(["experiment_fact", "conditional_experience", "validated_principle"])
export const ExperiencePolarity = z.enum(["positive", "negative", "mixed", "inconclusive"])
export const ExperienceEvidenceReference = z
  .object({
    runID: text,
    comparisonRunID: text.optional(),
    relation: z.enum(["supports", "refutes", "qualifies"]),
  })
  .strict()

/** The model supplies interpretations and references. Factual snapshots are attached by the store. */
export const ExperienceDraftSchema = z
  .object({
    level: ExperienceLevel,
    polarity: ExperiencePolarity,
    claimType: z.enum(["performance", "execution", "observation"]),
    statement: text,
    conditions: z.array(text).max(20),
    intervention: text,
    observation: text,
    mechanismHypothesis: text.optional(),
    boundaries: z.array(text).max(20),
    unknowns: z.array(text).max(20),
    validationPlan: text.optional(),
    evidence: z.array(ExperienceEvidenceReference).min(1).max(20),
    derivedFrom: z.array(text).max(20).optional(),
  })
  .strict()
  .superRefine((draft, ctx) => {
    if (draft.level === "experiment_fact") return
    for (const key of ["conditions", "boundaries"] as const) {
      if (!draft[key].length)
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} must describe the scope of a transferable experience`,
        })
    }
    if (!draft.validationPlan)
      ctx.addIssue({
        code: "custom",
        path: ["validationPlan"],
        message: "Describe a falsifiable validation experiment",
      })
  })
export type ExperienceDraft = z.infer<typeof ExperienceDraftSchema>

export const ExperimentFactSchema = z
  .object({
    taskID: text,
    runID: text,
    candidateID: text.optional(),
    stage: text,
    status: text,
    dataset: z.object({ identity: text, contentHash: text.optional(), specification: json }).strict(),
    taskFingerprint: json,
    evaluation: json,
    proposedModel: json.optional(),
    hypothesisSnapshot: json.optional(),
    executedModel: json.optional(),
    executionVerified: z.boolean(),
    independentEvidence: z.boolean(),
    metrics: json,
    evaluationDecision: json.optional(),
    primaryMetric: text,
    primaryValue: z.number().finite().optional(),
    direction: z.enum(["minimize", "maximize"]),
    error: z.string().optional(),
    artifactIDs: z.array(z.string()),
    timeFinished: z.number().optional(),
  })
  .strict()
export type ExperimentFact = z.infer<typeof ExperimentFactSchema>

export const ResearchExperienceSchema = z
  .object({
    schemaVersion: z.literal("research_experience.v1"),
    draft: ExperienceDraftSchema,
    facts: z.array(ExperimentFactSchema).min(1),
    supportDatasetCount: z.number().int().nonnegative(),
    capturedAt: z.number(),
    canonicalEvidenceVersion: z.literal(1).optional(),
    unverifiedInterpretation: ExperienceDraftSchema.optional(),
  })
  .strict()
export type ResearchExperience = z.infer<typeof ResearchExperienceSchema>

export function experienceFromMemory(memory: Pick<ResearchMemory, "candidateSummary">): ResearchExperience | undefined {
  const parsed = ResearchExperienceSchema.safeParse(memory.candidateSummary.experience)
  return parsed.success ? parsed.data : undefined
}

export function completeQualityFact(fact: ExperimentFact) {
  return (
    fact.stage === "full" &&
    fact.status === "succeeded" &&
    fact.primaryValue !== undefined &&
    fact.independentEvidence &&
    fact.executionVerified &&
    fact.evaluationDecision?.verificationStatus !== "failed"
  )
}

export function validateExperienceEvidence(draft: ExperienceDraft, facts: ExperimentFact[]) {
  const byID = new Map(facts.map((fact) => [fact.runID, fact]))
  const supports = draft.evidence.filter((ref) => ref.relation === "supports")
  if (!supports.length)
    throw new Error("Experience requires at least one supporting run; negative results can support a negative claim")
  const supportedDatasets = new Set<string>()
  for (const ref of draft.evidence) {
    const fact = byID.get(ref.runID)
    if (!fact) throw new Error(`Missing experiment fact: ${ref.runID}`)
    const comparison = ref.comparisonRunID ? byID.get(ref.comparisonRunID) : undefined
    if (ref.comparisonRunID && !comparison) throw new Error(`Missing comparison run: ${ref.comparisonRunID}`)
    if (
      comparison &&
      (comparison.runID === fact.runID ||
        comparison.taskID !== fact.taskID ||
        comparison.primaryMetric !== fact.primaryMetric ||
        comparison.direction !== fact.direction)
    ) {
      throw new Error("Comparison must be a different run in the same task and evaluation protocol")
    }
    if (
      comparison &&
      (comparison.dataset.identity !== fact.dataset.identity ||
        !isDeepStrictEqual(comparison.evaluation, fact.evaluation) ||
        !isDeepStrictEqual(
          { ...comparison.dataset.specification, path: undefined },
          { ...fact.dataset.specification, path: undefined },
        ))
    ) {
      throw new Error("Comparison dataset and evaluation settings must match the source run")
    }
    if (
      draft.level !== "experiment_fact" &&
      draft.claimType === "performance" &&
      (!completeQualityFact(fact) || !comparison || !completeQualityFact(comparison))
    ) {
      throw new Error(
        "Performance experience requires independent, verified full runs with finite metrics and a completed same-task comparison",
      )
    }
    if (draft.claimType === "performance" || draft.mechanismHypothesis || (draft.level !== "experiment_fact" && draft.claimType !== "execution"))
      requireAttributableComparison(fact, comparison)
    if (draft.level === "validated_principle" && ref.relation === "supports") {
      const valid =
        draft.claimType === "execution"
          ? completeQualityFact(fact) ||
            (fact.independentEvidence && ["failed", "rejected", "invalid"].includes(fact.status) && Boolean(fact.error))
          : completeQualityFact(fact)
      if (!valid || !fact.dataset.contentHash)
        throw new Error("Validated principles require independently verifiable evidence and dataset content hashes")
      supportedDatasets.add(fact.dataset.contentHash)
    } else if (ref.relation === "supports") supportedDatasets.add(fact.dataset.identity)
  }
  if (draft.level === "validated_principle" && supportedDatasets.size < 2) {
    throw new Error(
      "A validated principle requires supporting evidence from at least two distinct datasets; repeated runs or copied files count once",
    )
  }
  return supportedDatasets.size
}

export function experiencePromptRecord(memory: ResearchMemory) {
  const experience = experienceFromMemory(memory)
  if (!experience)
    return {
      id: memory.id,
      sourceTaskID: memory.taskID,
      level: "legacy_record",
      lesson: memory.lesson,
      limitation: "Legacy summary without structured evidence; inspect the source runs before reuse.",
    }
  return {
    id: memory.id,
    sourceTaskID: memory.taskID,
    ...projectExperience(experience),
  }
}

export function experienceFactForPrompt(fact: ExperimentFact) {
  const { evaluationDecision, ...snapshot } = fact
  const evidence = reflectionExecutionEvidence({
    status: fact.status, error: fact.error, metrics: fact.metrics,
    resourceUsage: {
      executionContract: { status: fact.executionVerified ? "verified" : "unverified" },
      independentEvidence: fact.independentEvidence,
      verification: { status: evaluationDecision?.verificationStatus },
    },
  }, fact.primaryMetric)
  return { ...snapshot, status: evidence.status, error: evidence.error }
}

export function projectExperience(experience: ResearchExperience) {
  return {
    ...experience.draft,
    interpretationStatus: "Only recorded interventions and metric contrasts are factual; mechanism explanations and transferability remain hypotheses.",
    supportDatasetCount: experience.supportDatasetCount,
    facts: experience.facts.map(experienceFactForPrompt).map((fact) => ({
      attribution: assessAttribution(fact, experience.facts.find((x) => x.runID === (fact.hypothesisSnapshot?.experimentContract as { comparisonRunID?: string } | undefined)?.comparisonRunID)),
      taskID: fact.taskID,
      runID: fact.runID,
      candidateID: fact.candidateID,
      datasetIdentity: fact.dataset.identity,
      taskFingerprint: fact.taskFingerprint,
      stage: fact.stage,
      status: fact.status,
      primaryMetric: fact.primaryMetric,
      primaryValue: fact.primaryValue,
      direction: fact.direction,
      executionVerified: fact.executionVerified,
      independentEvidence: fact.independentEvidence,
      error: fact.error,
      artifactIDs: fact.artifactIDs,
    })),
  }
}
