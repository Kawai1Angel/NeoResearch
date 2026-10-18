import { createHash } from "node:crypto"
import z from "zod"
import { ExperienceDraftSchema, experienceFromMemory } from "./experience"
import type { ResearchMemory, JsonRecord } from "./schema"
import type { ResearchExperience, ExperienceDraft } from "./experience"
import { experienceRepresentation } from "./experience-representation"
import path from "node:path"

export const ExperienceCurationSchema = z.object({
  schemaVersion: z.literal("experience_curation.v1"),
  status: z.enum(["retained", "rewritten", "merged", "quarantined"]),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  reviewer: z.string().min(1),
  reviewedAt: z.number(),
  reasons: z.array(z.string().min(1)).min(1),
  notes: z.array(z.string()).max(30),
  canonicalExperienceID: z.string().optional(),
  interpretation: ExperienceDraftSchema,
}).strict().superRefine((value, ctx) => {
  if (value.status === "merged" && !value.canonicalExperienceID)
    ctx.addIssue({ code: "custom", path: ["canonicalExperienceID"], message: "Merged experience requires a canonical target" })
})
export type ExperienceCuration = z.infer<typeof ExperienceCurationSchema>
export const experienceSourceDigest = (json: string) => createHash("sha256").update(json).digest("hex")

const bounded = (value: string) => value.length <= 4000 ? value : value.slice(0, 3900) + " [Summary shortened; inspect the complete observedRelationships and source facts.]"

/** Recover scoped conditional observations from evidence, never from an unsupported prose diagnosis. */
export function groundedExperienceInterpretation(experience: ResearchExperience, notes: string[] = []): ExperienceDraft {
  const view = experienceRepresentation(experience)
  const references = experience.draft.evidence
  const selected = references.map(ref => ({ ref, fact: experience.facts.find(fact => fact.runID === ref.runID)!,
    observation: view.observations.find(item => item.runID === ref.runID)!,
    intervention: view.interventions.find(item => item.runID === ref.runID && item.contrast &&
      (!ref.comparisonRunID || item.comparisonRunID === ref.comparisonRunID)),
  }))
  const contrasts = selected.flatMap(item => item.intervention?.contrast ? [{ ...item, intervention: item.intervention }] : [])
  const conditions = [...new Set(selected.flatMap(({ fact }) => {
    const profile = fact.taskFingerprint.datasetProfile as Record<string, unknown> | undefined
    const measurements = profile ? Object.fromEntries(["profileFingerprint", "profiledRowCount", "profiledTargetColumns",
      "missingRate", "trendStrength", "seasonalityStrength", "acfMainPeriod", "distributionShift", "observedPastCovariateCount"]
      .filter(key => profile[key] !== undefined).map(key => [key, profile[key]])) : null
    return [bounded(`Source dataset ${path.basename(String(fact.dataset.specification.path ?? "unknown"))}; identity=${fact.dataset.identity}; ` +
      `target/covariate roles=${JSON.stringify({ targetCols: fact.dataset.specification.targetCols, observedPastCovariates: fact.dataset.specification.observedPastCovariates,
        knownFutureCovariates: fact.dataset.specification.knownFutureCovariates })}.`),
      bounded(`Captured target profile measurements=${JSON.stringify(measurements)}. These are source observations, not inferred transfer thresholds.`),
      bounded(`Evaluation=${JSON.stringify(fact.evaluation)}; metric=${fact.primaryMetric}; direction=${fact.direction}.`)]
  }))].slice(0, 20)
  const descriptions = selected.map(({ fact, observation, intervention }) => intervention?.contrast
    ? `${fact.runID} vs ${intervention.comparisonRunID}: actual changed paths ${JSON.stringify(intervention.changedPaths)}; ` +
      `${fact.primaryMetric} ${intervention.contrast.control} -> ${intervention.contrast.trial}; delta=${intervention.contrast.delta}; ` +
      `${intervention.contrast.measuredDirection}; scope=${intervention.attributionScope}.`
    : `${fact.runID}: ${observation.stage}/${observation.executionStatus}; ` +
      `actual backbone=${String(fact.executedModel?.backbone ?? "unverified")}; ${fact.primaryMetric}=${fact.primaryValue ?? "unavailable"}; ` +
      (observation.error ? `observed error=${observation.error}; no prediction-quality contrast.` : "configuration observation; no eligible matched full-run contrast."))
  const hasError = selected.some(item => item.observation.error)
  const claimType = experience.draft.claimType === "execution" && !hasError ? "observation" : experience.draft.claimType
  const directions = contrasts.map(item => item.intervention.contrast!.measuredDirection)
  const polarity = claimType === "observation" || !directions.length ? "inconclusive"
    : directions.every(item => item === "improved") ? "positive" : directions.every(item => item === "worsened") ? "negative"
      : directions.every(item => item === "unchanged") ? "inconclusive" : "mixed"
  const validationPlan = "Repeat the exact local contrast with the same evaluation and independent seeds; define paired uncertainty or an equivalence margin prospectively. " +
    "Test compatible measured data conditions on different dataset contents. Isolate joint recipe changes before attributing a mechanism; retain opposing results."
  const boundaries = [
    "Applies to the captured dataset contents, measured profile scope, actual models, training recipes and evaluation protocol only.",
    "Cross-fold standard deviation is not seed uncertainty, a paired-effect confidence interval or an equivalence test. Numerical direction does not establish significance.",
    contrasts.some(item => item.intervention.changedPaths.length > 1)
      ? "Several recipe fields change together; the observed contrast is a joint configuration effect and cannot identify one internal mechanism."
      : "The recorded intervention is local to these source runs; it does not establish a universal mechanism or an architecture-family exclusion.",
    "Training and validation curves, checkpoint restoration and execution failures are distinct; loss rebound or a different CV/validation value alone does not prove an execution defect.",
    "No automatic cross-dataset principle is established. A data-derived hypothesis needs prospective tests and an explicit scope review.",
    ...notes,
  ].slice(0, 20)
  const single = references.length === 1 && contrasts.length === 1 ? contrasts[0] : undefined
  const existing = experience.unverifiedInterpretation?.evolution ?? experience.draft.evolution
  const failure = selected.length === 1 && selected[0]!.fact.independentEvidence && selected[0]!.observation.error ? selected[0] : undefined
  const evolution = existing ?? (single && single.intervention.changedPaths.length && single.intervention.contrast!.delta !== 0 ? {
    relation: "supports" as const,
    claim: { statement: bounded(`Under the recorded source conditions, repeat the joint/local intervention ${JSON.stringify(single.intervention.changedPaths)} ` +
      `and test whether ${single.fact.primaryMetric} is ${single.intervention.contrast!.delta < 0 ? "lower" : "higher"} than its matched control. ` +
      "This hypothesis was formulated from an observed source contrast, not a prospective confirmation."),
      dataConditions: conditions, operation: bounded(JSON.stringify(single.intervention.changes)),
      interventionPaths: single.intervention.changedPaths,
      expectedOutcome: { metric: single.fact.primaryMetric, direction: single.intervention.contrast!.delta < 0 ? "lower" as const : "higher" as const },
      boundaries, validationPlan,
    },
  } : failure ? { relation: "supports" as const, claim: {
    statement: bounded(`Executing the recorded configuration in its captured runtime/data scope produces the observed error: ${failure.observation.error}. ` +
      "Test the same scoped attempt or a documented repair; this is not a prediction-quality or architecture-availability claim."),
    dataConditions: conditions, operation: "Execute the captured recipe in the recorded runtime and inspect the literal error.",
    interventionPaths: [], expectedOutcome: { metric: failure.fact.primaryMetric, direction: "execution_failure" as const },
    boundaries, validationPlan: "Repeat the scoped execution or test one documented repair, recording runtime provenance and exact recipe differences. A successful attempt is counterevidence to the failure claim in the compatible scope.",
  } } : undefined)
  const { mechanismHypothesis, ...draft } = experience.draft
  return ExperienceDraftSchema.parse({ ...draft,
    level: claimType !== experience.draft.claimType ? "experiment_fact" : draft.level === "validated_principle" ? "conditional_experience" : draft.level,
    claimType, polarity,
    statement: bounded(descriptions.join("\n")), conditions,
    intervention: bounded(JSON.stringify(contrasts.map(item => ({ runID: item.fact.runID, comparisonRunID: item.intervention.comparisonRunID,
      changes: item.intervention.changes })))),
    observation: bounded(descriptions.join("\n")), boundaries,
    unknowns: ["Transfer to other measured data conditions and dataset contents.", "Seed-level and paired-effect uncertainty.",
      ...(contrasts.some(item => item.intervention.changedPaths.length > 1) ? ["Separate causal contributions of the jointly changed recipe fields."] : []),
      ...(hasError ? ["Diagnosis and successful repair of the observed error; neither follows from the error string alone."] : [])],
    validationPlan, evolution,
  })
}

/** Only the read projection changes. Original source JSON, facts and evidence relations stay immutable. */
export function applyExperienceCuration(memory: ResearchMemory, review: ExperienceCuration, sourceJSON: string, includeOriginal = false): ResearchMemory {
  const source = experienceFromMemory(memory)
  if (!source) throw new Error("Curation requires a structured source experience")
  if (review.sourceDigest !== experienceSourceDigest(sourceJSON)) throw new Error("Experience curation is stale for its source snapshot")
  if (JSON.stringify(review.interpretation.evidence) !== JSON.stringify(source.draft.evidence))
    throw new Error("Curation cannot add, remove or relabel source evidence")
  const { evolution, ...withoutEvolution } = review.interpretation
  const interpretation = review.status === "quarantined" ? { ...withoutEvolution, level: "experiment_fact" as const, claimType: "observation" as const, polarity: "inconclusive" as const } : review.interpretation
  const experience = { ...source, draft: interpretation, unverifiedInterpretation: interpretation }
  return { ...memory, lesson: review.interpretation.statement,
    candidateSummary: { ...memory.candidateSummary, experience,
      experienceCuration: { status: review.status, reviewer: review.reviewer, reviewedAt: review.reviewedAt,
        reasons: review.reasons, notes: review.notes, canonicalExperienceID: review.canonicalExperienceID,
        sourceDigest: review.sourceDigest, originalRetained: true },
      ...(includeOriginal ? { experienceOriginal: source } : {}),
    } as unknown as JsonRecord }
}
