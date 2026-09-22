import { createHash } from "crypto"
import type { CandidateClaim, DocumentChunk, KnowledgeCard, NormalizedDocument } from "../../../src/research/literature/contract"

export const evidenceText = "On ETTh1, the proposed patch encoder reduces MSE by 12% compared with DLinear."

export function chunk(overrides: Partial<DocumentChunk> = {}): DocumentChunk {
  const text = overrides.text ?? evidenceText
  return {
    schemaVersion: "document_chunk_v1", chunkID: "chunk_aaaaaaaaaaaaaaaaaaaa",
    documentID: "doc_0123456789abcdef", paperID: "paper-2026-test", sectionID: "section_method",
    sectionKind: "results", pageStart: 3, pageEnd: 3, ordinal: 0, text,
    textSha256: createHash("sha256").update(text).digest("hex"), ...overrides,
  }
}

export function candidate(overrides: Partial<CandidateClaim> = {}): CandidateClaim {
  return {
    candidateID: "candidate-1", paperID: "paper-2026-test", cardType: "empirical_finding",
    claim: "The proposed patch encoder reduces MSE by 12% on ETTh1 compared with DLinear.",
    subject: "patch-based encoding", predicate: "improves", object: "forecast accuracy",
    evidenceType: "author_experiment", supportingChunkIDs: [chunk().chunkID],
    sourceLocations: [{ page: 3, section: "Results", evidenceSpan: evidenceText }],
    extractorConfidence: 0.9, ...overrides,
  }
}

export function document(): NormalizedDocument {
  return {
    schemaVersion: "normalized_document_v1", documentID: "doc_0123456789abcdef", paperID: "paper-2026-test",
    sourcePath: "/tmp/paper.pdf", sourceSha256: "a".repeat(64), parser: { name: "fixture", version: "fixture_v1" },
    language: "en", title: "Fixture paper",
    pages: [{ pageNumber: 3, text: evidenceText, blocks: [{ blockID: "block_0003_0001", text: evidenceText }] }],
    sections: [{ sectionID: "section_method", heading: "Results", normalizedKind: "results", startPage: 3, endPage: 3, blockIDs: ["block_0003_0001"] }],
    parseWarnings: [],
  }
}

export function card(overrides: Partial<KnowledgeCard> = {}): KnowledgeCard {
  return {
    schemaVersion: "knowledge_card_v1", cardID: "kc_123456789abc", revision: 1,
    paperID: "paper-2026-test", cardType: "empirical_finding",
    claim: candidate().claim, normalizedClaim: { subject: "patch_encoding", predicate: "improves", object: "forecast_accuracy" },
    applicability: { taskTypes: ["forecasting"], dataFeatures: [], domains: [], dataScale: [], horizonProfile: [], computeProfile: [], basis: "author_experiment" },
    notApplicableWhen: [],
    evidence: [{ evidenceID: "ev_12345678", evidenceType: "author_experiment", chunkID: chunk().chunkID, section: "Results", pageStart: 3, pageEnd: 3, evidenceSpan: evidenceText, directness: "direct", verification: "exact_span" }],
    limitations: [],
    confidence: { sourceQuality: 0.9, extractionConfidence: 0.9, evidenceDirectness: 1, transferability: 0.5 },
    status: "paper_backed", tags: ["patch_encoding"],
    provenance: {
      sourceDocumentID: document().documentID, sourceDocumentSha256: document().sourceSha256,
      sourcePublicationStatus: "peer_reviewed", extractorModel: "fixture", extractorPromptVersion: "candidate_extractor_v1",
      verifierModel: "fixture", verifierPromptVersion: "evidence_verifier_v1", extractionRunID: "lerun_fixture",
      createdAt: "2026-09-21T00:00:00.000Z", updatedAt: "2026-09-21T00:00:00.000Z",
    },
    ...overrides,
  }
}
