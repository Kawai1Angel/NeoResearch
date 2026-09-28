import { createHash } from "crypto"
import type { DocumentChunk } from "./contract"
import {
  KnowledgeCandidateSchema, PrincipleReviewSchema, KnowledgeCardV2Schema, KNOWLEDGE_V2_VERSIONS,
  type KnowledgeCandidateV2, type PrincipleReview,
} from "./knowledge-v2-contract"

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export function knowledgeCandidateHash(candidate: KnowledgeCandidateV2) {
  return createHash("sha256").update(canonical(KnowledgeCandidateSchema.parse(candidate))).digest("hex")
}

export function knowledgeV2CacheKey(input: {
  documentSha256: string
  extractorModel: string
  verifierModel: string
  options: Record<string, unknown>
}) {
  return createHash("sha256").update(canonical({ ...input, versions: KNOWLEDGE_V2_VERSIONS })).digest("hex")
}

export type KnowledgeSourceContext = {
  paperID: string
  documentID: string
  documentSha256: string
  chunks: readonly DocumentChunk[]
}

// Deterministic integrity only. Passing this is never a semantic acceptance verdict.
export function validateKnowledgeCandidate(value: unknown, context: KnowledgeSourceContext): string[] {
  const parsed = KnowledgeCandidateSchema.safeParse(value)
  if (!parsed.success) return parsed.error.issues.map((x) => `schema:${x.path.join(".")}:${x.message}`)
  const c = parsed.data
  const errors: string[] = []
  const unique = (label: string, values: string[]) => {
    if (new Set(values).size !== values.length) errors.push(`duplicate_id:${label}`)
  }
  unique("assertion", c.assertions.map((x) => x.assertionID))
  unique("source", c.sources.map((x) => x.sourceID))
  unique("evidence", c.support.map((x) => x.evidenceID))
  unique("experiment", c.experiments.map((x) => x.experimentID))
  if (c.paperID !== context.paperID) errors.push("source_unavailable:paper_mismatch")
  const assertions = new Map(c.assertions.map((x) => [x.assertionID, x]))
  const sources = new Map(c.sources.map((x) => [x.sourceID, x]))
  const experiments = new Map(c.experiments.map((x) => [x.experimentID, x]))
  const chunks = new Map(context.chunks.map((x) => [x.chunkID, x]))
  const refs = (values: string[]) => {
    for (const id of values) if (!sources.has(id)) errors.push(`source_unavailable:${id}`)
  }
  const assert = (id: string, kind: string) => {
    if (assertions.get(id)?.kind !== kind) errors.push(`assertion_mismatch:${kind}:${id}`)
  }
  assert(c.principleAssertionID, "principle")
  if (assertions.get(c.principleAssertionID)?.statement !== c.principle) errors.push("principle_assertion_mismatch")
  assert(c.intervention.assertionID, "intervention")
  assert(c.mechanism.assertionID, "mechanism")
  assert(c.expectedEffect.assertionID, "effect")
  for (const [kind, items] of [
    ["condition", c.conditions], ["scope", c.observedScope],
    ["boundary", c.boundaries.status === "reported" ? c.boundaries.items : []],
  ] as const) for (const item of items) {
    assert(item.assertionID, kind)
    refs(item.sourceIDs)
  }
  if (c.mechanism.attribution === "extractor_inference") errors.push("mechanism_unexplained:extractor_inference")
  for (const source of c.sources) {
    const chunk = chunks.get(source.chunkID)
    if (!chunk || source.paperID !== context.paperID || source.documentID !== context.documentID
      || source.documentSha256 !== context.documentSha256 || chunk.paperID !== context.paperID
      || chunk.documentID !== context.documentID || chunk.textSha256 !== source.chunkSha256
      || createHash("sha256").update(chunk.text).digest("hex") !== source.chunkSha256
      || chunk.sectionID !== source.sectionID || source.page < chunk.pageStart || source.page > chunk.pageEnd
      || !chunk.text.includes(source.quote)) errors.push(`source_unavailable:${source.sourceID}`)
    if (source.spanStart !== undefined || source.spanEnd !== undefined) {
      if (source.spanStart === undefined || source.spanEnd === undefined || source.spanStart >= source.spanEnd
        || !chunk || source.spanEnd > chunk.text.length || chunk.text.slice(source.spanStart, source.spanEnd) !== source.quote) errors.push(`source_offset_mismatch:${source.sourceID}`)
    }
    if (source.pageEnd !== undefined && (!chunk || source.pageEnd !== chunk.pageEnd || source.pageEnd < source.page)) errors.push(`source_page_range_mismatch:${source.sourceID}`)
  }
  for (const evidence of c.support) {
    refs(evidence.sourceIDs)
    for (const id of evidence.assertionIDs) if (!assertions.has(id)) errors.push(`unknown_assertion:${id}`)
    if (evidence.kind === "experiment") {
      const experiment = evidence.experimentID ? experiments.get(evidence.experimentID) : undefined
      if (!experiment) errors.push(`unbound_experiment:${evidence.evidenceID}`)
      else if (!evidence.sourceIDs.some((id) => experiment.sourceIDs.includes(id))) errors.push(`unbound_experiment:source:${evidence.evidenceID}`)
    } else if (evidence.experimentID) errors.push(`unbound_experiment:kind:${evidence.evidenceID}`)
  }
  for (const a of c.assertions) {
    const directlyBound = [...c.conditions, ...c.observedScope, ...(c.boundaries.status === "reported" ? c.boundaries.items : [])]
      .some((binding) => binding.assertionID === a.assertionID && binding.sourceIDs.length > 0)
    if (!directlyBound && !c.support.some((s) => s.assertionIDs.includes(a.assertionID) && s.relation !== "refutes")) errors.push(`unsupported_assertion:${a.assertionID}`)
  }
  for (const experiment of c.experiments) {
    refs(experiment.sourceIDs)
    if (!c.support.some((s) => s.experimentID === experiment.experimentID)) errors.push(`unbound_experiment:orphan:${experiment.experimentID}`)
    for (const field of Object.values(experiment)) {
      if (typeof field === "object" && field && "status" in field && field.status === "reported" && "sourceIDs" in field) refs(field.sourceIDs)
    }
  }
  for (const note of c.implementationNotes) refs(note.sourceIDs)
  if (c.expectedEffect.comparator.status === "reported") refs(c.expectedEffect.comparator.sourceIDs)
  if (c.expectedEffect.kind === "performance") {
    const bound = c.support.filter((s) => s.kind === "experiment" && s.relation === "supports" && s.assertionIDs.includes(c.expectedEffect.assertionID))
    const adequate = bound.some((s) => {
      const exp = experiments.get(s.experimentID ?? "")
      return exp && [exp.intervention, exp.comparator, exp.dataset, exp.metric, exp.result].every((x) => x.status === "reported")
        && exp.metricDirection !== "not_reported"
    })
    if (!adequate || c.expectedEffect.comparator.status !== "reported") errors.push("unbound_experiment:performance")
  }
  return [...new Set(errors)]
}

// Review is bound to the exact candidate, so narrowing or merging requires re-verification.
export function isSourceSupportedAssertion(review: PrincipleReview["assertionReviews"][number]) {
  return review.verdict === "supported" || (review.verdict === "qualified"
    && review.qualification?.sourceFaithful === true && review.qualification.limitationDisclosed === true)
}

export function validatePrincipleReview(candidate: KnowledgeCandidateV2, value: unknown, availableSourceIDs: readonly string[] = []): string[] {
  const parsed = PrincipleReviewSchema.safeParse(value)
  if (!parsed.success) return ["invalid_review_schema"]
  const review: PrincipleReview = parsed.data
  const errors: string[] = []
  if (review.candidateID !== candidate.candidateID || review.candidateHash !== knowledgeCandidateHash(candidate)) errors.push("stale_review")
  if (review.verdict !== "accepted" || review.reasons.length || Object.values(review.checks).some((x) => !x)) errors.push("semantic_review_failed")
  const expected = new Set(candidate.assertions.map((x) => x.assertionID))
  if (review.assertionReviews.length !== expected.size || new Set(review.assertionReviews.map((x) => x.assertionID)).size !== expected.size
    || review.assertionReviews.some((x) => !expected.has(x.assertionID))) errors.push("assertion_review_incomplete")
  if (review.assertionReviews.some((x) => !isSourceSupportedAssertion(x))) errors.push("assertion_not_supported")
  const sourceIDs = new Set([...candidate.sources.map((x) => x.sourceID), ...availableSourceIDs])
  // Coverage is audit metadata, not an acceptance threshold. An independently
  // supported claim does not require a second review of every attached span.
  if (review.reviewedSourceIDs.some((id) => !sourceIDs.has(id))) errors.push("unknown_review_source")
  return errors
}

// An incomplete or internally contradictory response is a reviewer protocol error,
// not a scientific rejection. The caller may request one bounded output repair.
export function validatePrincipleReviewEnvelope(candidate: KnowledgeCandidateV2, review: PrincipleReview, availableSourceIDs: readonly string[] = []): string[] {
  const errors = validatePrincipleReview(candidate, review, availableSourceIDs).filter((error) =>
    ["invalid_review_schema", "stale_review", "assertion_review_incomplete", "unknown_review_source"].includes(error))
  if (review.verdict !== "accepted" && !review.reasons.length && Object.values(review.checks).every(Boolean)
    && review.assertionReviews.every(isSourceSupportedAssertion)) errors.push("contradictory_review_verdict")
  return errors
}

export function principleSourceCoverage(candidate: Pick<KnowledgeCandidateV2, "sources">, review: Pick<PrincipleReview, "reviewedSourceIDs">) {
  const reviewed = new Set(review.reviewedSourceIDs)
  const reviewedSourceIDs = candidate.sources.filter((s) => reviewed.has(s.sourceID)).map((s) => s.sourceID)
  const unreviewedSourceIDs = candidate.sources.filter((s) => !reviewed.has(s.sourceID)).map((s) => s.sourceID)
  const attached = new Set(candidate.sources.map((s) => s.sourceID))
  const additionalReviewedSourceIDs = [...reviewed].filter((id) => !attached.has(id))
  return { reviewedSourceIDs, unreviewedSourceIDs, additionalReviewedSourceIDs, complete: unreviewedSourceIDs.length === 0 }
}

// Central construction gate for subsequent v2 writers. A schema parse alone is insufficient.
// The caller must obtain review from an independent source-reading model invocation.
export function finalizeKnowledgeCandidate(input: {
  candidate: KnowledgeCandidateV2
  review: unknown
  availableSourceIDs?: readonly string[]
  context: KnowledgeSourceContext
  provenance: import("./knowledge-v2-contract").KnowledgeCardV2["provenance"]
}) {
  const errors = [
    ...validateKnowledgeCandidate(input.candidate, input.context),
    ...validatePrincipleReview(input.candidate, input.review, input.availableSourceIDs),
  ]
  if (input.provenance.documentSha256 !== input.context.documentSha256) errors.push("provenance_document_mismatch")
  if (input.provenance.synthesisVersion !== KNOWLEDGE_V2_VERSIONS.synthesis
    || input.provenance.verifierVersion !== KNOWLEDGE_V2_VERSIONS.verifier) errors.push("provenance_version_mismatch")
  if (errors.length) throw new Error(`Knowledge v2 rejected: ${errors.join(", ")}`)
  // A new semantically changed candidate receives a distinct identity here. Store-level
  // revisions/lineage must be explicit; do not infer equivalence from model names.
  const identity = createHash("sha256").update(canonical({
    documentSha256: input.context.documentSha256,
    candidateHash: knowledgeCandidateHash(input.candidate),
  })).digest("hex").slice(0, 24)
  return KnowledgeCardV2Schema.parse({
    ...input.candidate, schemaVersion: "knowledge_card_v2", knowledgeID: `kn_${identity}`, revision: 1,
    review: input.review, provenance: input.provenance,
  })
}
