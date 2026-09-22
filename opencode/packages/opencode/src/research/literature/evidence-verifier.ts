import {
  type CandidateClaim, type DocumentChunk, type EvidenceVerification, type RejectedCandidate,
} from "./contract"
import type { LiteratureExtractionModel } from "./extraction-model"

const PROMPT_INJECTION = /ignore\s+(?:all\s+)?previous\s+instructions|system\s+prompt|you\s+are\s+chatgpt/i

function normalized(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim()
}

function sectionToken(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "")
}

function numbers(value: string) {
  return [...value.matchAll(/(?<![\p{L}\p{N}])[-+]?\d+(?:\.\d+)?%?(?![\p{L}\p{N}])/gu)].map((item) => item[0])
}

export type EvidenceMatch = {
  readonly chunk: DocumentChunk; readonly page: number; readonly section: string
  readonly evidenceSpan: string; readonly verification: "exact_span" | "normalized_span"
}

export type DeterministicEvidenceResult =
  | { readonly ok: true; readonly candidate: CandidateClaim; readonly evidence: readonly EvidenceMatch[] }
  | { readonly ok: false; readonly rejection: RejectedCandidate }

export function validateCandidateEvidence(
  candidate: CandidateClaim,
  chunks: readonly DocumentChunk[],
  options: { readonly requireExactEvidenceSpan: boolean },
): DeterministicEvidenceResult {
  const lookup = new Map(chunks.map((chunk) => [chunk.chunkID, chunk]))
  const supporting = candidate.supportingChunkIDs.map((id) => lookup.get(id))
  if (supporting.some((item) => item === undefined)) {
    return { ok: false, rejection: { candidate, reason: "no_locatable_evidence", detail: "supportingChunkIDs contains an unknown chunk" } }
  }
  const sourceChunks = supporting as DocumentChunk[]
  if (sourceChunks.some((chunk) => chunk.sectionKind === "references")) {
    return { ok: false, rejection: { candidate, reason: "references_only", detail: "references chunks cannot back a knowledge card" } }
  }
  if (sourceChunks.some((chunk) => PROMPT_INJECTION.test(chunk.text))) {
    return { ok: false, rejection: { candidate, reason: "prompt_injection_detected", detail: "source chunk contains an instruction-like prompt injection pattern" } }
  }

  const evidence: EvidenceMatch[] = []
  for (const location of candidate.sourceLocations) {
    const exact = sourceChunks.find((chunk) =>
      location.page >= chunk.pageStart && location.page <= chunk.pageEnd &&
      [chunk.sectionKind, chunk.sectionID].some((section) => sectionToken(location.section).includes(sectionToken(section))) &&
      chunk.text.includes(location.evidenceSpan),
    )
    if (exact) {
      evidence.push({ chunk: exact, page: location.page, section: location.section, evidenceSpan: location.evidenceSpan, verification: "exact_span" })
      continue
    }
    const normalizedSpan = normalized(location.evidenceSpan)
    const normalizedMatch = sourceChunks.find((chunk) =>
      location.page >= chunk.pageStart && location.page <= chunk.pageEnd &&
      [chunk.sectionKind, chunk.sectionID].some((section) => sectionToken(location.section).includes(sectionToken(section))) &&
      normalized(chunk.text).includes(normalizedSpan),
    )
    if (!normalizedMatch || options.requireExactEvidenceSpan) {
      return { ok: false, rejection: { candidate, reason: "no_locatable_evidence", detail: `evidence span is not present on page ${location.page}` } }
    }
    evidence.push({ chunk: normalizedMatch, page: location.page, section: location.section, evidenceSpan: location.evidenceSpan, verification: "normalized_span" })
  }
  if (candidate.evidenceType !== "agent_inference" && evidence.length === 0) {
    return { ok: false, rejection: { candidate, reason: "no_locatable_evidence", detail: "paper-backed candidate has no direct evidence" } }
  }
  if (candidate.cardType === "applicability_rule" && candidate.evidenceType === "author_experiment" && evidence.length === 0) {
    return { ok: false, rejection: { candidate, reason: "evidence_does_not_support_claim", detail: "applicability rule lacks experimental evidence" } }
  }
  const evidenceNumbers = new Set(numbers(sourceChunks.map((item) => item.text).join(" ")))
  const missingNumber = numbers(candidate.claim).find((item) => !evidenceNumbers.has(item))
  if (missingNumber) {
    return { ok: false, rejection: { candidate, reason: "numeric_evidence_missing", detail: `numeric value ${missingNumber} is absent from evidence chunks` } }
  }
  return { ok: true, candidate, evidence }
}

export async function verifyCandidate(input: {
  readonly model: LiteratureExtractionModel
  readonly candidate: CandidateClaim
  readonly chunks: readonly DocumentChunk[]
  readonly requireExactEvidenceSpan: boolean
}) {
  const deterministic = validateCandidateEvidence(input.candidate, input.chunks, input)
  if (!deterministic.ok) return deterministic
  const supportChunks = deterministic.evidence.map((item) => item.chunk)
  const request = { candidate: input.candidate, chunks: supportChunks }
  const verification = await input.model.verifyEvidence(request).catch(() => input.model.verifyEvidence(request))
  if (verification.verdict === "unsupported") {
    return { ok: false as const, rejection: { candidate: input.candidate, reason: "evidence_does_not_support_claim" as const, detail: verification.unsupportedParts.join("; ") || "semantic verifier rejected claim" } }
  }
  let candidate = input.candidate
  if (verification.verdict === "partially_supported" || verification.verdict === "overstated") {
    if (!verification.correctedClaim) {
      return { ok: false as const, rejection: { candidate, reason: "claim_too_broad" as const, detail: "verifier did not supply a supported correctedClaim" } }
    }
    candidate = { ...candidate, claim: verification.correctedClaim }
    const narrowed = validateCandidateEvidence(candidate, input.chunks, input)
    if (!narrowed.ok) return narrowed
    return { ok: true as const, candidate, evidence: narrowed.evidence, verification }
  }
  return { ok: true as const, candidate, evidence: deterministic.evidence, verification }
}

export function directnessScore(verification: EvidenceVerification) {
  return verification.evidenceDirectness === "direct" ? 1 : verification.evidenceDirectness === "indirect" ? 0.75 : 0.5
}
