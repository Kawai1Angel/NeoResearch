import { createHash } from "crypto"
import type { DocumentChunk } from "../../../src/research/literature/contract"
import { KnowledgeCandidateSchema, type KnowledgeCandidateV2 } from "../../../src/research/literature/knowledge-v2-contract"
import { knowledgeCandidateHash } from "../../../src/research/literature/knowledge-v2-validator"

// Synthetic source: contract tests, not scientific validation of any real paper.
export const text = "When the period is stable, group equal-phase observations and share a predictor across periods. This aligns recurring phases and reduces the number of independent weights. The derivation concerns parameter count, not prediction accuracy."
export const digest = createHash("sha256").update(text).digest("hex")
export const chunk: DocumentChunk = {
  schemaVersion: "document_chunk_v1", chunkID: `chunk_${"a".repeat(20)}`, documentID: "doc", paperID: "paper",
  sectionID: "method", sectionKind: "method", pageStart: 1, pageEnd: 1, ordinal: 0, text, textSha256: digest,
}
export const context = { paperID: "paper", documentID: "doc", documentSha256: digest, chunks: [chunk] }
const absent = { status: "not_reported" as const, reason: "No comparison experiment in this source" }
export function candidate(): KnowledgeCandidateV2 {
  const statements = [
    ["p", "principle", "Under a stable period, phase grouping with shared prediction reduces independent weights by reusing a predictor."],
    ["c", "condition", "The period is stable."],
    ["i", "intervention", "Group equal-phase observations and share a predictor across periods."],
    ["m", "mechanism", "Phase alignment permits weight sharing over recurring positions."],
    ["e", "effect", "Sharing reduces independent weights; this does not establish prediction accuracy."],
  ] as const
  return KnowledgeCandidateSchema.parse({
    schemaVersion: "knowledge_candidate_v2", candidateID: "candidate", paperID: "paper", contributionIndexes: [0],
    principle: statements[0][2], transferableInsight: "Weight reuse depends on stable phase alignment, rather than the architecture name.",
    assertions: statements.map(([assertionID, kind, statement]) => ({ assertionID, kind, statement })),
    principleAssertionID: "p", conditions: [{ assertionID: "c", sourceIDs: ["s"] }],
    intervention: { assertionID: "i", operation: statements[2][2], necessaryComponents: ["phase grouping", "shared predictor"] },
    mechanism: { assertionID: "m", input: "Stable periodic sequence", operation: "Group phases and share weights", explanatoryPath: statements[3][2], attribution: "source_explanation" },
    expectedEffect: { assertionID: "e", kind: "computational", comparator: absent },
    support: [{ evidenceID: "ev", assertionIDs: statements.map((x) => x[0]), sourceIDs: ["s"], relation: "supports", kind: "derivation" }],
    experiments: [], observedScope: [], boundaries: { status: "not_reported", note: "No empirical failure boundary reported" },
    unknowns: ["Accuracy and behavior under changing periods are untested"],
    falsification: { origin: "proposed_validation", test: "Count parameters for shared versus independent predictors", failureCriterion: "No reduction at equal predictor width" },
    implementationNotes: [], epistemicStatus: "theoretical_support",
    sources: [{ sourceID: "s", paperID: "paper", documentID: "doc", documentSha256: digest, chunkID: chunk.chunkID, chunkSha256: digest, page: 1, sectionID: "method", quote: text }],
  })
}
export function review(c = candidate()) {
  return {
    candidateID: c.candidateID, candidateHash: knowledgeCandidateHash(c), verdict: "accepted",
    checks: { transferable: true, mechanismComplete: true, sourceEntailment: true, experimentBinding: true, scopeFaithful: true, counterevidenceRetained: true, independentPrinciple: true },
    assertionReviews: c.assertions.map((x) => ({ assertionID: x.assertionID, verdict: "supported", reason: "Synthetic fixture source supports the scoped statement" })),
    reasons: [], explanation: "Synthetic review fixture", reviewedSourceIDs: c.sources.map((s) => s.sourceID),
  }
}
