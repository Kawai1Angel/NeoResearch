import { expect, test } from "bun:test"
import { normalizeCandidate } from "../../../src/research/literature/card-normalizer"
import type { LiteratureTaxonomy } from "../../../src/research/literature/taxonomy"
import { candidate, chunk, evidenceText } from "./fixtures"

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
  expect(first.confidence).toEqual({ sourceQuality: 0.95, extractionConfidence: 0.9, evidenceDirectness: 1, transferability: 0.55 })
})
