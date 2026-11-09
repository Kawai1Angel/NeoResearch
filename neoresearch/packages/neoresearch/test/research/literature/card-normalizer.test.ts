import { expect, test } from "bun:test"
import { normalizeCandidate } from "../../../src/research/literature/card-normalizer"
import { KnowledgeCardSchema } from "../../../src/research/literature/contract"
import type { LiteratureTaxonomy } from "../../../src/research/literature/taxonomy"
import { candidate, candidateScope, chunk, evidenceText, scopeText } from "./fixtures"

const taxonomy: LiteratureTaxonomy = {
  schemaVersion: "literature_taxonomy_v1",
  mechanisms: { patch_encoding: ["patch-based encoding"] }, data_features: {}, task_types: { forecasting: ["forecast"] },
}

test("normalizer produces stable IDs and keeps confidence dimensions separate", () => {
  const input = {
    candidate: candidate(), evidence: [{ chunk: chunk(), page: 3, section: "Results", evidenceSpan: evidenceText, verification: "exact_span" as const }],
    verification: { verdict: "supported" as const, supportedScope: "ETTh1", unsupportedParts: [], evidenceDirectness: "direct" as const, confidence: 0.95 },
    taxonomy, documentID: "doc_0123456789abcdef", documentSha256: "a".repeat(64), publicationStatus: "peer_reviewed",
    publicationVerification: "official_proceedings", modelIdentifier: "fixture", candidatePromptVersion: "candidate_extractor_v1",
    verifierPromptVersion: "evidence_verifier_v1", runID: "lerun_fixture", now: "2026-09-21T00:00:00.000Z",
  }
  const first = normalizeCandidate(input).card
  const second = normalizeCandidate(input).card
  expect(first.cardID).toBe(second.cardID)
  expect(first.normalizedClaim.subject).toBe("patch_encoding")
  expect(first.status).toBe("paper_backed")
  expect(first.confidence).toEqual({ sourceQuality: 0.95, extractionConfidence: 0.9, evidenceDirectness: 1, transferability: 0.25 })
  expect(first.applicability.basis).toBe("unknown")
  expect(first.applicability.taskTypes).toEqual([])
})

test("source-reviewed scope populates the existing v1 fields and scopes card identity", () => {
  const value = candidate({ scope: candidateScope() })
  const input = {
    candidate: value, evidence: [{ chunk: chunk({ text: `${evidenceText}\n${scopeText}` }), page: 3,
      section: "Results", evidenceSpan: scopeText, verification: "exact_span" as const }],
    verification: { verdict: "supported" as const, scopeVerdict: "supported" as const, supportedScope: "ETTh1",
      unsupportedParts: [], evidenceDirectness: "direct" as const, confidence: 0.95 },
    taxonomy, documentID: "doc_0123456789abcdef", documentSha256: "a".repeat(64), publicationStatus: "peer_reviewed",
    modelIdentifier: "fixture", candidatePromptVersion: "candidate_extractor_v5", verifierPromptVersion: "evidence_verifier_v6",
    runID: "lerun_scope", now: "2026-10-09T00:00:00.000Z",
  }
  const result = KnowledgeCardSchema.parse(normalizeCandidate(input).card)
  expect(result.schemaVersion).toBe("knowledge_card_v1")
  expect(result).not.toHaveProperty("scope")
  expect(result.applicability).toEqual(value.scope!.applicability)
  expect(result.experimentalContext).toEqual(value.scope!.experimentalContext)
  expect(result.notApplicableWhen).toEqual(["irregular_sampling"])
  expect(result.limitations).toEqual(value.scope!.limitations)
  expect(() => normalizeCandidate({ ...input, verification: { ...input.verification, scopeVerdict: "unsupported" } })).toThrow("unverified")
  const changed = structuredClone(value)
  changed.scope!.applicability.dataFeatures = ["multivariate"]
  expect(normalizeCandidate({ ...input, candidate: changed }).card.cardID).not.toBe(result.cardID)
  const named = normalizeCandidate({ ...input, candidate: { ...value, claim: value.claim + " Electricity Weather Traffic." } }).card
  expect(named.confidence.transferability).toBe(result.confidence.transferability)
})
