import { hasCompleteMechanism } from "./contract"
import {
  type CandidateClaim, type DocumentChunk, type EvidenceVerification, type RejectedCandidate, type NormalizedDocument,
} from "./contract"
import type { LiteratureExtractionModel } from "./extraction-model"

const PROMPT_INJECTION = /ignore\s+(?:all\s+)?previous\s+instructions|system\s+prompt|you\s+are\s+chatgpt/i

function normalized(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim()
}

function sectionToken(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "")
}

// Resolve human headings through parser metadata, never through substring matches.
function sectionMatches(value: string, chunk: DocumentChunk, sections: NormalizedDocument["sections"]) {
  const key = sectionToken(value)
  const section = sections.find((item) => item.sectionID === chunk.sectionID)
  if ([chunk.sectionKind, chunk.sectionID, ...(section ? [section.heading] : [])]
    .some((item) => sectionToken(item) === key)) return true
  // PDF parsers may miss a subsection or mix columns. Require an actual
  // numbered heading at a line boundary in this supporting chunk.
  if (!/^(?:\d+(?:\.\d+)*|[A-Z])\.?\s+\p{L}/u.test(value.trim())) return false
  const heading = value.trim().replace(/^([A-Z])\.\s+/, "$1 ").split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")
  return new RegExp(`(?:^|\\n)\\s*${heading}(?=\\r?\\n|$|[.:]\\s)`, "i").test(chunk.text)
}

// Recover a literal source substring when the extractor only changed whitespace.
// No punctuation, word, number, or case changes are permitted by this repair.
function recoverWhitespaceSpan(text: string, quote: string) {
  const words = quote.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return undefined
  const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")
  return text.match(new RegExp(pattern))?.[0]
}

export const EVIDENCE_VALIDATION_VERSION = "evidence_validation_v3"

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
  options: { readonly requireExactEvidenceSpan: boolean; readonly sections?: NormalizedDocument["sections"] },
): DeterministicEvidenceResult {
  const lookup = new Map(chunks.map((chunk) => [chunk.chunkID, chunk]))
  const supporting = candidate.supportingChunkIDs.map((id) => lookup.get(id))
  if (supporting.some((item) => item === undefined)) {
    return { ok: false, rejection: { candidate, reason: "no_locatable_evidence", detail: "supportingChunkIDs contains an unknown chunk" } }
  }
  const sourceChunks = supporting as DocumentChunk[]
  if (sourceChunks.some((chunk) => chunk.paperID !== candidate.paperID)) {
    return { ok: false, rejection: { candidate, reason: "no_locatable_evidence", detail: "supporting chunk belongs to a different paper" } }
  }
  if (sourceChunks.some((chunk) => chunk.sectionKind === "references")) {
    return { ok: false, rejection: { candidate, reason: "references_only", detail: "references chunks cannot back a knowledge card" } }
  }
  if (sourceChunks.some((chunk) => PROMPT_INJECTION.test(chunk.text))) {
    return { ok: false, rejection: { candidate, reason: "prompt_injection_detected", detail: "source chunk contains an instruction-like prompt injection pattern" } }
  }

  const evidence: EvidenceMatch[] = []
  const locations: CandidateClaim["sourceLocations"] = []
  for (const location of candidate.sourceLocations) {
    const located = sourceChunks.filter((chunk) =>
      location.page >= chunk.pageStart && location.page <= chunk.pageEnd &&
      sectionMatches(location.section, chunk, options.sections ?? []),
    )
    if (!located.length) {
      return { ok: false, rejection: { candidate, reason: "no_locatable_evidence", detail: `page/section does not resolve to a supporting chunk: page ${location.page}, section ${location.section}` } }
    }
    const exact = location.evidenceSpan.trim() ? located.find((chunk) => chunk.text.includes(location.evidenceSpan)) : undefined
    const recovered = exact ? undefined : located.map((chunk) => ({ chunk, span: recoverWhitespaceSpan(chunk.text, location.evidenceSpan) })).find((item) => item.span && item.span.length <= 1500)
    if (exact || recovered?.span) {
      const chunk = exact ?? recovered!.chunk
      const evidenceSpan = exact ? location.evidenceSpan : recovered!.span!
      // The canonical quote is copied from the source and is checked literally.
      evidence.push({ chunk, page: location.page, section: chunk.sectionID, evidenceSpan, verification: "exact_span" })
      locations.push({ ...location, section: chunk.sectionID, evidenceSpan })
      continue
    }
    const normalizedSpan = normalized(location.evidenceSpan)
    const normalizedMatch = normalizedSpan ? located.find((chunk) => normalized(chunk.text).includes(normalizedSpan)) : undefined
    if (!normalizedMatch || options.requireExactEvidenceSpan) {
      return { ok: false, rejection: { candidate, reason: "no_locatable_evidence", detail: `evidence span is absent from the located supporting chunks on page ${location.page}` } }
    }
    evidence.push({ chunk: normalizedMatch, page: location.page, section: normalizedMatch.sectionID, evidenceSpan: location.evidenceSpan, verification: "normalized_span" })
    locations.push({ ...location, section: normalizedMatch.sectionID })
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
  return { ok: true, candidate: { ...candidate, sourceLocations: locations }, evidence }
}

export async function verifyCandidate(input: {
  readonly model: LiteratureExtractionModel
  readonly candidate: CandidateClaim
  readonly chunks: readonly DocumentChunk[]
  readonly requireExactEvidenceSpan: boolean
  readonly sections?: NormalizedDocument["sections"]
}) {
  const deterministic = validateCandidateEvidence(input.candidate, input.chunks, input)
  if (!deterministic.ok) return deterministic
  const supportChunks = deterministic.evidence.map((item) => item.chunk)
  const request = { candidate: deterministic.candidate, chunks: supportChunks }
  if (input.candidate.cardType === "model_mechanism" && !hasCompleteMechanism(input.candidate)) {
    return { ok: false as const, rejection: { candidate: input.candidate, reason: "mechanism_incomplete" as const, detail: "A mechanism requires problem, operation principle and nonempty components." } }
  }
  const verification = await input.model.verifyEvidence(request)
  if (verification.cardTypeVerdict === "mismatch" || verification.cardTypeVerdict === "uncertain" ||
      ((input.candidate.cardType === "empirical_finding" || input.candidate.cardType === "domain_prior") &&
       verification.actionabilityVerdict !== "testable_intervention") ||
      (input.candidate.cardType === "model_mechanism" &&
       (verification.cardTypeVerdict !== "correct" || verification.mechanismVerdict !== "supported" || verification.contributionVerdict !== "own_method"))) {
    return { ok: false as const, rejection: { candidate: input.candidate, reason: "card_quality_failed" as const,
      detail: JSON.stringify({ rule: EVIDENCE_VALIDATION_VERSION, ...verification }) } }
  }
  if (verification.verdict === "unsupported") {
    return { ok: false as const, rejection: { candidate: input.candidate, reason: "evidence_does_not_support_claim" as const, detail: verification.unsupportedParts.join("; ") || "semantic verifier rejected claim" } }
  }
  let candidate = deterministic.candidate
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
