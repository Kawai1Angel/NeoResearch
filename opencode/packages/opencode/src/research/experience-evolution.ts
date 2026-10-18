import { createHash } from "node:crypto"
import z from "zod"
import type { ResearchExperience } from "./experience"
import { experienceRepresentation } from "./experience-representation"
import { normalizedRecipePath } from "./recipe-naming"

const text = z.string().trim().min(1).max(4000)
export const ExperienceClaimSchema = z.object({
  statement: text,
  dataConditions: z.array(text).min(1).max(20),
  operation: text,
  interventionPaths: z.array(text).max(20),
  expectedOutcome: z.object({
    metric: text,
    direction: z.enum(["lower", "higher", "equivalent", "execution_success", "execution_failure"]),
    equivalenceMargin: z.number().finite().nonnegative().optional(),
  }).strict(),
  boundaries: z.array(text).min(1).max(20),
  validationPlan: text,
}).strict().superRefine((claim, ctx) => {
  if (claim.expectedOutcome.direction === "equivalent" && claim.expectedOutcome.equivalenceMargin === undefined)
    ctx.addIssue({ code: "custom", path: ["expectedOutcome", "equivalenceMargin"], message: "Equivalence requires an explicit predeclared absolute metric margin" })
  if (!["execution_success", "execution_failure"].includes(claim.expectedOutcome.direction) && !claim.interventionPaths.length)
    ctx.addIssue({ code: "custom", path: ["interventionPaths"], message: "Specify the recipe paths whose intervention tests this claim" })
})

/** The relation is to a stable hypothesis, not to whether the new run improved its local control. */
export const ExperienceEvolutionSchema = z.object({
  parentExperienceID: text.optional(),
  relation: z.enum(["supports", "refutes", "qualifies", "observes"]),
  claim: ExperienceClaimSchema.optional(),
  scopeReview: z.object({
    evidenceRunIDs: z.array(text).min(1).max(200),
    conditionsAssessment: text,
    implementationAssessment: text,
    rationale: text,
    applicabilityBoundaries: z.array(text).min(1).max(20),
    limitations: z.array(text).min(1).max(20),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.parentExperienceID && !value.claim)
    ctx.addIssue({ code: "custom", path: ["claim"], message: "A new experience thread requires a falsifiable conditional claim" })
  if (value.parentExperienceID && value.claim)
    ctx.addIssue({ code: "custom", path: ["claim"], message: "A continuation inherits the parent's claim; start a new thread to change its meaning" })
})
export type ExperienceEvolution = z.infer<typeof ExperienceEvolutionSchema>
export type ExperienceEntry = { id: string; domainID: string; time: { created: number; updated?: number }; experience: ResearchExperience; curationStatus?: string }
const unique = <T>(items: T[]) => [...new Set(items)]
export const evolutionOf = (entry: ExperienceEntry) => entry.experience.unverifiedInterpretation?.evolution ?? entry.experience.draft.evolution

/** Only formatting, set order and recipe path aliases are equivalent automatically.
 * Rephrased or scientifically different claims require an explicit parent decision.
 * A validation plan describes future work; it does not identify the proposition.
 */
export function experienceClaimKey(domainID: string, claim: z.infer<typeof ExperienceClaimSchema>) {
  const clean = (value: string) => value.normalize("NFC").trim().replace(/\s+/g, " ")
  const terms = (values: string[]) => unique(values.map(clean)).sort()
  return JSON.stringify({ domainID, statement: clean(claim.statement), dataConditions: terms(claim.dataConditions),
    operation: clean(claim.operation), interventionPaths: unique(claim.interventionPaths.map(normalizedRecipePath)).sort(),
    expectedOutcome: { metric: clean(claim.expectedOutcome.metric), direction: claim.expectedOutcome.direction,
      equivalenceMargin: claim.expectedOutcome.equivalenceMargin ?? null }, boundaries: terms(claim.boundaries) })
}

export function experienceThreadRoot(entry: ExperienceEntry, entries: Map<string, ExperienceEntry>) {
  const visited = new Set<string>()
  let current = entry
  while (true) {
    if (visited.has(current.id)) throw new Error("Experience evolution contains a cycle")
    visited.add(current.id)
    // Old derivedFrom links retain provenance, but cannot silently assert the same scientific claim.
    const parentID = evolutionOf(current)?.parentExperienceID
    if (!parentID) return current
    const parent = entries.get(parentID)
    if (!parent || parent.domainID !== entry.domainID) throw new Error("Experience continuation requires an existing parent in the same domain")
    current = parent
  }
}

function assess(entry: ExperienceEntry, claim: z.infer<typeof ExperienceClaimSchema> | undefined, view: ReturnType<typeof experienceRepresentation>) {
  const refs = entry.experience.draft.evidence
  // Inherited references are context, not new replications or new votes.
  return refs.map(ref => {
    const fact = entry.experience.facts.find(fact => fact.runID === ref.runID)!
    const contrast = view.interventions.find(item => item.runID === ref.runID && item.status === "verified_changes" && item.contrast)
    const observation = view.observations.find(item => item.runID === ref.runID)!
    const expected = claim?.expectedOutcome
    const paths = claim?.interventionPaths.map(normalizedRecipePath) ?? []
    const requested = evolutionOf(entry)?.relation ?? "observes"
    const pathCovered = contrast && paths.length && paths.every(path =>
      contrast.changedPaths.some(changed => changed === path || changed.startsWith(path + ".")))
    const isolated = pathCovered && contrast!.changedPaths.every(changed => paths.some(path =>
      changed === path || changed.startsWith(path + ".")))
    const executionObserved = fact.independentEvidence && (Boolean(observation.error) || fact.executionVerified && observation.executionStatus === "succeeded")
    const numeric = expected && expected.metric === fact.primaryMetric && isolated && contrast?.contrast
    const consistent = numeric ? expected.direction === "equivalent" ? Math.abs(numeric.delta) <= expected.equivalenceMargin!
      : expected.direction === "lower" ? numeric.delta < 0 : expected.direction === "higher" ? numeric.delta > 0 : undefined
      : expected?.direction.startsWith("execution_") && executionObserved
        ? expected.direction === "execution_success" ? !observation.error : Boolean(observation.error) : undefined
    // Semantic applicability is still a hypothesis. Numerical consistency cannot certify a mechanism.
    const grounded = consistent !== undefined
    const relation = !grounded || requested === "observes" ? "observes"
      : requested === "qualifies" ? "qualifies"
      : consistent ? "supports" : "refutes"
    return { experienceID: entry.id, runID: ref.runID, comparisonRunID: ref.comparisonRunID,
      dataset: fact.dataset, requestedRelation: requested, relation,
      assessment: grounded ? "observed_outcome_checked" : "unassessed",
      relationMismatch: grounded && ["supports", "refutes"].includes(requested) && requested !== relation,
      reasons: grounded ? [] : [!claim ? "No structured conditional claim was captured."
        : expected?.direction.startsWith("execution_") ? "The requested execution outcome was not independently observed."
          : "No matched full-run contrast isolates the claim's declared paths and metric."],
      ...(numeric ? { contrast: numeric } : {}),
    }
  })
}

/** All three parts exist at every maturity. Append-only source entries evolve one shared hypothesis. */
export function organizeExperienceThread(root: ExperienceEntry, members: ExperienceEntry[]) {
  const ordered = [...new Map(members.map(member => [member.id, member])).values()].sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))
  const original = root.experience.unverifiedInterpretation ?? root.experience.draft
  const claim = evolutionOf(root)?.claim
  const views = new Map(ordered.map(entry => [entry.id, experienceRepresentation(entry.experience)]))
  const factKey = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  const facts = [...new Map(ordered.flatMap(entry => entry.experience.facts).map(fact => [factKey(fact), fact])).values()]
  const conflictingRunIDs = unique(facts.map(fact => fact.runID)).filter(id => facts.filter(fact => fact.runID === id).length > 1)
  const evidence = ordered.flatMap(entry => assess(entry, claim, views.get(entry.id)!))
  const observedRelationships = ordered.flatMap(entry => {
    const view = views.get(entry.id)!
    return entry.experience.draft.evidence.map(ref => {
      const fact = entry.experience.facts.find(fact => fact.runID === ref.runID)!
      const item = view.interventions.find(item => item.runID === ref.runID && item.contrast)
      const observation = view.observations.find(item => item.runID === ref.runID)!
      return { experienceID: entry.id, runID: ref.runID, comparisonRunID: item?.comparisonRunID ?? null,
        kind: item ? "matched_intervention" : observation.error ? "execution_observation" : "configuration_observation",
        conditions: { dataset: fact.dataset, evaluation: fact.evaluation,
          dataCharacteristics: fact.taskFingerprint.datasetProfile ?? null,
          configurationRunIDs: [ref.runID, ...(item ? [item.comparisonRunID] : [])] },
        operation: { changes: item?.changes ?? [], attributionScope: item?.attributionScope ?? "no_controlled_intervention",
          configurationStatus: fact.executionVerified && fact.executedModel ? "execution_verified" : "proposed_only" },
        observedEffect: item?.contrast ?? { primaryMetric: observation.primaryMetric, primaryValue: observation.primaryValue,
          stage: observation.stage, executionStatus: observation.executionStatus, error: observation.error },
        limitation: item ? "This is the observed contrast under captured source conditions; transfer and mechanistic explanations require further tests."
          : "A configuration measurement or observed execution failure does not establish a controlled performance effect or verify a diagnosis." }
    })
  })
  const priority = (relation: string) => ["observes", "qualifies", "supports", "refutes"].indexOf(relation)
  const assessments = [...new Map(evidence.sort((a, b) => priority(a.relation) - priority(b.relation)).map(item =>
    [`${item.runID}:${item.comparisonRunID ?? ""}`, item])).values()]
  const datasets = (relation: string) => {
    const selected = assessments.filter(item => item.relation === relation)
    return unique(selected.map(item => item.dataset.contentHash ?? item.dataset.identity)).map(identity => {
      const evidence = selected.filter(item => (item.dataset.contentHash ?? item.dataset.identity) === identity)
      return { identity, contentHash: evidence[0]!.dataset.contentHash,
        paths: unique(evidence.flatMap(item => typeof item.dataset.specification.path === "string" ? [item.dataset.specification.path] : [])),
        runIDs: unique(evidence.map(item => item.runID)), experienceIDs: unique(evidence.map(item => item.experienceID)) }
    })
  }
  const supportingDatasets = datasets("supports")
  const counterexampleDatasets = datasets("refutes")
  const hashCount = supportingDatasets.filter(item => item.contentHash).length
  const reviewed = ordered.toReversed().find(entry => evolutionOf(entry)?.scopeReview)
  const review = reviewed ? evolutionOf(reviewed)!.scopeReview! : undefined
  const reviewCoversEvidence = Boolean(review && assessments.every(item => review.evidenceRunIDs.includes(item.runID)))
  const reviewEligible = reviewCoversEvidence && hashCount >= 2 && !counterexampleDatasets.length && !conflictingRunIDs.length &&
    assessments.every(item => item.relation === "supports")
  const status = counterexampleDatasets.length ? "contested" : reviewEligible ? "validated_in_scope"
    : hashCount >= 2 ? "corroborated_pending_review" : "not_validated"
  const revision = ordered.length
  const boundaries = unique([...(claim?.boundaries ?? original.boundaries), ...ordered.flatMap(entry =>
    (entry.experience.unverifiedInterpretation ?? entry.experience.draft).boundaries), ...(review?.applicabilityBoundaries ?? [])])
  const runs = (relation: string) => unique(assessments.filter(item => item.relation === relation).map(item => item.runID))
  return {
    schemaVersion: "experience_organization.v1" as const,
    threadID: root.id, revision, memberExperienceIDs: ordered.map(entry => entry.id),
    updatedAt: Math.max(...ordered.map(entry => entry.time.updated ?? entry.time.created)),
    experimentFacts: { status: "captured_evidence", facts, conflictingRunIDs,
      sourceExperienceIDs: ordered.map(entry => entry.id),
      note: "Actual models, training recipes, named controls, metrics, failures and artifacts are authoritative snapshots; diagnoses are not automatically verified." },
    conditionalExperience: {
      status: claim ? "explicit_hypothesis" : root.curationStatus ? "reviewed_observations" : "legacy_needs_formulation",
      claim: claim?.statement ?? "No explicit transferable hypothesis was captured; inspect observedRelationships before formulating one.",
      provisionalInterpretation: { statement: original.statement, status: "unverified_interpretation" },
      dataConditions: claim?.dataConditions ?? original.conditions,
      operation: claim?.operation ?? original.intervention,
      interventionPaths: claim?.interventionPaths ?? [], expectedOutcome: claim?.expectedOutcome ?? null,
      observedRelationships, observedEffects: assessments,
      currentConclusion: { status, supportingRunIDs: runs("supports"), counterexampleRunIDs: runs("refutes"),
        qualifyingRunIDs: runs("qualifies"), unassessedRunIDs: runs("observes"),
        interpretationStatus: "Accumulated evidence about the unchanged conditional claim; numerical agreement alone does not establish causality or transferability." },
      boundaries: unique([...(claim?.boundaries ?? []), ...ordered.flatMap(entry =>
        (entry.experience.unverifiedInterpretation ?? entry.experience.draft).boundaries)]),
      validationPlan: claim?.validationPlan ?? original.validationPlan ?? null,
      missing: claim ? [] : ["structured_conditional_claim", ...(!original.validationPlan ? ["falsifiable_validation_plan"] : [])],
      interpretationStatus: "Provisional hypothesis; observed outcome agreement does not establish causality or transferability.",
    },
    validatedRegularity: { status, supportingDatasets, counterexampleDatasets,
      qualifyingDatasets: datasets("qualifies"), unassessedDatasets: datasets("observes"),
      supportDatasetContentCount: hashCount,
      applicabilityBoundaries: boundaries,
      unknowns: unique(ordered.flatMap(entry => (entry.experience.unverifiedInterpretation ?? entry.experience.draft).unknowns)),
      missing: unique([...(claim ? [] : ["structured_conditional_claim"]), ...(hashCount < 2 ? ["independent_support_on_multiple_dataset_contents"] : []),
        ...(counterexampleDatasets.length ? ["unresolved_counterevidence"] : []),
        ...(conflictingRunIDs.length ? ["conflicting_source_snapshots"] : []),
        ...(assessments.some(item => item.relation !== "supports") ? ["unresolved_or_qualified_observations"] : []),
        ...(reviewEligible ? [] : ["scientific_scope_review"])]),
      scopeReview: review ? { ...review, experienceID: reviewed!.id, coversCurrentEvidence: reviewCoversEvidence, eligible: reviewEligible } : null,
      interpretationStatus: "Scope review is model-authored and evidence-gated; this does not establish universal validity, causality or statistical significance.",
    },
    evolution: { events: ordered.map(entry => ({ experienceID: entry.id, time: entry.time.created,
      parentExperienceID: evolutionOf(entry)?.parentExperienceID ?? null,
      relation: evolutionOf(entry)?.relation ?? "observes",
      relatedExperienceIDs: entry.experience.draft.derivedFrom ?? [],
      sourceRunIDs: entry.experience.draft.evidence.map(ref => ref.runID) })),
      evidenceDigest: createHash("sha256").update(JSON.stringify(ordered.map(entry => [entry.id, entry.experience]))).digest("hex") },
  }
}
export type ExperienceOrganization = ReturnType<typeof organizeExperienceThread>

/** Version history records conclusions and evidence references, not repeated model snapshots. */
export function experienceRevisionSummary(value: ExperienceOrganization) {
  return { threadID: value.threadID, revision: value.revision, updatedAt: value.updatedAt,
    evidenceDigest: value.evolution.evidenceDigest, memberExperienceIDs: value.memberExperienceIDs,
    sourceRunIDs: unique(value.experimentFacts.facts.map(fact => fact.runID)),
    conditionalExperience: { claim: value.conditionalExperience.claim,
      dataConditions: value.conditionalExperience.dataConditions, operation: value.conditionalExperience.operation,
      currentConclusion: value.conditionalExperience.currentConclusion, boundaries: value.conditionalExperience.boundaries },
    validatedRegularity: value.validatedRegularity }
}

/** Keep all three parts visible; full source snapshots remain available by exact experience ID. */
export function compactExperienceOrganization(value: ExperienceOrganization) {
  return { ...value,
    conditionalExperience: { ...value.conditionalExperience,
      observedRelationships: value.conditionalExperience.observedRelationships.map(item => ({ ...item,
        conditions: { ...item.conditions, dataCharacteristics: item.conditions.dataCharacteristics ? { status: "captured", sourceRunID: item.runID,
          detailPath: "organization.experimentFacts.facts[].taskFingerprint.datasetProfile" } : null } })) },
    experimentFacts: { ...value.experimentFacts,
    facts: value.experimentFacts.facts.map(fact => ({ runID: fact.runID, taskID: fact.taskID,
      dataset: { identity: fact.dataset.identity, contentHash: fact.dataset.contentHash, path: fact.dataset.specification.path },
      actualBackbone: fact.executedModel?.backbone, stage: fact.stage, status: fact.status,
      primaryMetric: fact.primaryMetric, primaryValue: fact.primaryValue, error: fact.error,
      executionVerified: fact.executionVerified, independentEvidence: fact.independentEvidence,
      detailAccess: { tool: "read_experiences", experienceID: value.memberExperienceIDs.find(id =>
        value.evolution.events.find(event => event.experienceID === id)?.sourceRunIDs.includes(fact.runID)) ?? value.threadID, includeFacts: true },
    })) } }
}

export function experienceOrganizationOutline(value: ExperienceOrganization) {
  return { threadID: value.threadID, revision: value.revision,
    experimentFacts: { sourceRunCount: value.experimentFacts.facts.length, detailsOmitted: true },
    conditionalExperience: { status: value.conditionalExperience.status, claim: value.conditionalExperience.claim.slice(0, 500), detailsOmitted: true },
    validatedRegularity: { status: value.validatedRegularity.status,
      supportDatasetContentCount: value.validatedRegularity.supportDatasetContentCount,
      counterexampleDatasetCount: value.validatedRegularity.counterexampleDatasets.length, detailsOmitted: true },
    detailAccess: { tool: "read_experiences", experienceID: value.threadID, includeFacts: true } }
}
