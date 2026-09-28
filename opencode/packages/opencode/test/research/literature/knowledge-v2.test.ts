import { expect, test } from "bun:test"
import { KnowledgeCandidateSchema, KnowledgeCardV2Schema, PaperAnalysisSchema } from "../../../src/research/literature/knowledge-v2-contract"
import { finalizeKnowledgeCandidate, knowledgeV2CacheKey, validateKnowledgeCandidate, validatePrincipleReview, principleSourceCoverage } from "../../../src/research/literature/knowledge-v2-validator"

import { candidate, review, chunk, digest, context } from "./principle-fixtures"

test("complete conditional principle passes integrity and separately bound review", () => {
  expect(validateKnowledgeCandidate(candidate(), context)).toEqual([])
  expect(validatePrincipleReview(candidate(), review())).toEqual([])
})
test("protocol fragments and v1 cards cannot masquerade as v2", () => {
  expect(KnowledgeCandidateSchema.safeParse({ cardType: "evaluation_protocol", claim: "Input length is 336" }).success).toBe(false)
  expect(KnowledgeCardV2Schema.safeParse({ ...candidate(), schemaVersion: "knowledge_card_v1", cardID: "kc_123456789012" }).success).toBe(false)
})
test("no invented mechanism even when all references exist", () => {
  const c = candidate()
  c.mechanism.attribution = "extractor_inference"
  expect(validateKnowledgeCandidate(c, context)).toContain("mechanism_unexplained:extractor_inference")
})
test("performance claims require a bound comparison experiment", () => {
  const c = candidate()
  c.expectedEffect.kind = "performance"
  expect(validateKnowledgeCandidate(c, context)).toContain("unbound_experiment:performance")
})
test("dangling experiments and assertion references are rejected", () => {
  const c = candidate()
  c.support[0].kind = "experiment"
  c.support[0].experimentID = "missing"
  c.support[0].assertionIDs.push("missing")
  expect(validateKnowledgeCandidate(c, context)).toContain("unbound_experiment:ev")
  expect(validateKnowledgeCandidate(c, context)).toContain("unknown_assertion:missing")
})
test("untraceable quotes, wrong document, and changed chunks are rejected", () => {
  for (const patch of [{ quote: "invented quote" }, { documentSha256: "b".repeat(64) }, { page: 2 }, { sectionID: "results" }]) {
    const c = candidate()
    Object.assign(c.sources[0], patch)
    expect(validateKnowledgeCandidate(c, context)).toContain("source_unavailable:s")
  }
  expect(validateKnowledgeCandidate(candidate(), { ...context, chunks: [{ ...chunk, text: "tampered" }] })).toContain("source_unavailable:s")
})
test("unbound conditions and duplicate assertion identities cannot pass", () => {
  const c = candidate()
  c.conditions[0].sourceIDs = ["missing"]
  c.assertions.push(c.assertions[0])
  expect(validateKnowledgeCandidate(c, context)).toContain("source_unavailable:missing")
  expect(validateKnowledgeCandidate(c, context)).toContain("duplicate_id:assertion")
})
test("condition source bindings do not require a duplicate support row", () => {
  const c = candidate()
  c.support[0].assertionIDs = c.support[0].assertionIDs.filter((id) => id !== "c")
  expect(validateKnowledgeCandidate(c, context)).toEqual([])
  c.conditions[0].sourceIDs = ["missing"]
  expect(validateKnowledgeCandidate(c, context)).toContain("source_unavailable:missing")
})
test("citation existence does not override semantic rejection for generalization", () => {
  const c = candidate()
  const r = { ...review(c), verdict: "rejected", reasons: ["scope_overgeneralized"] }
  expect(validateKnowledgeCandidate(c, context)).toEqual([])
  expect(validatePrincipleReview(c, r)).toContain("semantic_review_failed")
})
test("narrowing or merging invalidates previous semantic review", () => {
  const c = candidate()
  const r = review(c)
  c.unknowns.push("New qualification")
  expect(validatePrincipleReview(c, r)).toContain("stale_review")
})
test("review must judge all assertions but need not enumerate every source", () => {
  const c = candidate()
  const r = review(c)
  r.assertionReviews.pop()
  r.reviewedSourceIDs = []
  expect(validatePrincipleReview(c, r)).not.toEqual([])
  const partial = review(c)
  partial.assertionReviews[0].verdict = "qualified"
  expect(validatePrincipleReview(c, partial)).toContain("assertion_not_supported")
  expect(validatePrincipleReview(c, partial)).not.toContain("assertion_review_incomplete")
})
test("paper analysis allows no contributions; materials are not candidate cards", () => {
  const analysis = { schemaVersion: "paper_analysis_v1", paperID: "paper", documentID: "doc", documentSha256: digest, problem: "Problem", contributions: [], methodOutline: [], materials: [], sources: [], unresolved: [], coverage: { reviewedChunkIDs: [chunk.chunkID], remainingChunkIDs: [] }, status: "complete" }
  expect(PaperAnalysisSchema.safeParse(analysis).success).toBe(true)
  expect(KnowledgeCandidateSchema.safeParse(analysis).success).toBe(false)
})

test("formal construction requires integrity, semantic review and version provenance", () => {
  const input = {
    candidate: candidate(), review: review(), context,
    provenance: { documentSha256: digest, analysisHash: digest, extractionRunID: "run", extractorModel: "fixture", verifierModel: "fixture", synthesisVersion: "paper_principle_v8", verifierVersion: "principle_verifier_v10", createdAt: "2026-09-28T00:00:00.000Z" },
  }
  const card = finalizeKnowledgeCandidate(input)
  expect(card.knowledgeID).toMatch(/^kn_[a-f0-9]{24}$/)
  expect(finalizeKnowledgeCandidate(input).knowledgeID).toBe(card.knowledgeID)
  expect(() => finalizeKnowledgeCandidate({ ...input, review: { ...input.review, verdict: "rejected" } })).toThrow("semantic_review_failed")
  expect(() => finalizeKnowledgeCandidate({ ...input, provenance: { ...input.provenance, verifierVersion: "old" } })).toThrow("provenance_version_mismatch")
})

test("partial source coverage is audited without overriding scientific judgments", () => {
  const c = candidate()
  c.sources.push({ ...c.sources[0], sourceID: "extra" })
  const r = { ...review(c), reviewedSourceIDs: ["s"] }
  expect(validatePrincipleReview(c, r)).toEqual([])
  expect(principleSourceCoverage(c, r)).toEqual({ reviewedSourceIDs: ["s"], unreviewedSourceIDs: ["extra"], additionalReviewedSourceIDs: [], complete: false })
  expect(validatePrincipleReview(c, { ...r, reviewedSourceIDs: ["invented"] })).toContain("unknown_review_source")
  expect(validatePrincipleReview(c, { ...r, checks: { ...r.checks, counterevidenceRetained: false } })).toContain("semantic_review_failed")
})

test("cache isolates document, models and options while ignoring object key order", () => {
  const input = { documentSha256: digest, extractorModel: "a", verifierModel: "b", options: { x: 1, y: 2 } }
  expect(knowledgeV2CacheKey(input)).toBe(knowledgeV2CacheKey({ ...input, options: { y: 2, x: 1 } }))
  expect(knowledgeV2CacheKey(input)).not.toBe(knowledgeV2CacheKey({ ...input, verifierModel: "c" }))
  expect(knowledgeV2CacheKey(input)).not.toBe(knowledgeV2CacheKey({ ...input, documentSha256: "a".repeat(64) }))
})

test("source-faithful qualified assertions are accepted with explicit evidence limitations", () => {
  const c = candidate()
  const r = review(c)
  const qualified = { ...r, assertionReviews: r.assertionReviews.map((a) => a.assertionID === "m" ? {
    ...a, verdict: "qualified", reason: "Mechanism has source-backed explanatory steps; independent replication is unreported.",
    qualification: { kind: "limited_experiments", sourceFaithful: true, limitationDisclosed: true },
  } : a) }
  expect(validatePrincipleReview(c, qualified)).toEqual([])
  for (const patch of [{ sourceFaithful: false }, { limitationDisclosed: false }]) {
    const bad = structuredClone(qualified)
    const item = bad.assertionReviews.find((a) => a.assertionID === "m")!
    Object.assign((item as any).qualification, patch)
    expect(validatePrincipleReview(c, bad)).toContain("assertion_not_supported")
  }
  expect(validatePrincipleReview(c, { ...qualified, checks: { ...qualified.checks, counterevidenceRetained: false } })).toContain("semantic_review_failed")
  expect(validatePrincipleReview(c, { ...qualified, reasons: ["unsupported_causal_claim"] })).toContain("semantic_review_failed")
})

test("qualification cannot conceal an unsupported claim or approve a historical untyped qualification", () => {
  const c = candidate()
  const r = review(c)
  for (const item of [
    { verdict: "unsupported", qualification: { kind: "author_hypothesis", sourceFaithful: true, limitationDisclosed: true } },
    { verdict: "qualified" },
    { verdict: "qualified", qualification: { kind: "fabricated_result", sourceFaithful: true, limitationDisclosed: true } },
  ]) {
    const patched = { ...r, assertionReviews: r.assertionReviews.map((a, i) => i === 0 ? { ...a, ...item } : a) }
    expect(validatePrincipleReview(c, patched).length).toBeGreaterThan(0)
  }
})


test("review may inspect additional registered paper sources", () => {
  const c = candidate()
  const r = { ...review(c), reviewedSourceIDs: ["s", "paper-counterevidence"] }
  expect(validatePrincipleReview(c, r, ["s", "paper-counterevidence"])).toEqual([])
  expect(validatePrincipleReview(c, r)).toContain("unknown_review_source")
  expect(principleSourceCoverage(c, r).additionalReviewedSourceIDs).toEqual(["paper-counterevidence"])
})
