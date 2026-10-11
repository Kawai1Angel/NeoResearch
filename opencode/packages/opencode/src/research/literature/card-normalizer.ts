import { createHash } from "crypto"
import type { CandidateClaim, KnowledgeCard } from "./contract"
import type { EvidenceMatch } from "./evidence-verifier"
import { directnessScore } from "./evidence-verifier"
import type { EvidenceVerification } from "./contract"
import { normalizeClaimPart, type LiteratureTaxonomy } from "./taxonomy"

function digest(value: string, length: number) {
  return createHash("sha256").update(value).digest("hex").slice(0, length)
}

function sourceQuality(publicationStatus: string, verification?: string) {
  if (publicationStatus === "peer_reviewed" && ["official_proceedings", "publisher_metadata"].includes(verification ?? "")) return 0.95
  if (publicationStatus === "peer_reviewed") return 0.82
  if (publicationStatus === "preprint") return 0.65
  return 0.5
}

function transferability(candidate: CandidateClaim) {
  // A conservative ranking prior, not a probability of success on a new task.
  const scope = candidate.scope
  if (candidate.evidenceType === "agent_inference" || scope?.applicability.basis === "agent_inference") return 0.2
  if (!scope || scope.applicability.basis === "unknown") return 0.25
  const constrained = Object.values(scope.applicability).some((value) => Array.isArray(value) && value.length > 0)
  return constrained ? (candidate.mechanism ? 0.6 : 0.5) : 0.25
}

export function normalizeCandidate(input: {
  readonly candidate: CandidateClaim
  readonly evidence: readonly EvidenceMatch[]
  readonly verification: EvidenceVerification
  readonly taxonomy: LiteratureTaxonomy
  readonly documentID: string
  readonly documentSha256: string
  readonly publicationStatus: string
  readonly publicationVerification?: string
  readonly modelIdentifier: string
  readonly candidatePromptVersion: string
  readonly verifierPromptVersion: string
  readonly runID: string
  readonly now: string
}) {
  const candidate = input.candidate
  if (candidate.scope && input.verification.scopeVerdict !== "supported") {
    throw new Error("Cannot normalize unverified knowledge scope")
  }
  const normalizedClaim = {
    subject: normalizeClaimPart(candidate.subject, input.taxonomy),
    predicate: normalizeClaimPart(candidate.predicate, input.taxonomy),
    object: normalizeClaimPart(candidate.object, input.taxonomy),
  }
  const scope = candidate.scope
  const scopeKey = scope ? JSON.stringify({ applicability: scope.applicability,
    experimentalContext: scope.experimentalContext, notApplicableWhen: scope.notApplicableWhen, limitations: scope.limitations }) : ""
  const key = `${candidate.paperID}|${normalizedClaim.subject}|${normalizedClaim.predicate}|${normalizedClaim.object}${scopeKey ? `|${scopeKey}` : ""}`
  const cardID = `kc_${digest(key, 12)}`
  const evidence = input.evidence.map((item) => ({
    evidenceID: `ev_${digest(`${cardID}|${item.chunk.chunkID}|${item.evidenceSpan}`, 12)}`,
    evidenceType: candidate.evidenceType,
    chunkID: item.chunk.chunkID,
    section: item.section,
    pageStart: item.chunk.pageStart,
    pageEnd: item.chunk.pageEnd,
    evidenceSpan: item.evidenceSpan,
    directness: input.verification.evidenceDirectness,
    verification: item.verification,
  }))
  const paperBacked = candidate.evidenceType !== "agent_inference" && evidence.some((item) => item.directness === "direct")
  const knownTerms = new Set([
    ...Object.keys(input.taxonomy.mechanisms), ...Object.keys(input.taxonomy.data_features), ...Object.keys(input.taxonomy.task_types),
  ])
  const terms = [normalizedClaim.subject, normalizedClaim.object]
  const taxonomySuggestions = terms.filter((item) => item && !knownTerms.has(item))
  const card: KnowledgeCard = {
    schemaVersion: "knowledge_card_v1",
    cardID,
    revision: 1,
    paperID: candidate.paperID,
    cardType: candidate.cardType,
    claim: candidate.claim,
    normalizedClaim,
    ...(candidate.problem === undefined ? {} : { problem: candidate.problem }),
    ...(candidate.mechanism === undefined ? {} : { mechanism: candidate.mechanism }),
    applicability: scope ? structuredClone(scope.applicability) : {
      taskTypes: [], dataFeatures: [], domains: [], dataScale: [], horizonProfile: [], computeProfile: [], basis: "unknown",
    },
    ...(scope?.experimentalContext === undefined ? {} : { experimentalContext: structuredClone(scope.experimentalContext) }),
    notApplicableWhen: [...(scope?.notApplicableWhen ?? [])],
    evidence,
    limitations: [...(scope?.limitations ?? [])],
    confidence: {
      sourceQuality: sourceQuality(input.publicationStatus, input.publicationVerification),
      extractionConfidence: candidate.extractorConfidence,
      evidenceDirectness: directnessScore(input.verification),
      transferability: transferability(candidate),
    },
    status: paperBacked ? "paper_backed" : "extracted",
    tags: [...new Set([candidate.cardType, normalizedClaim.subject, normalizedClaim.object].filter(Boolean))],
    provenance: {
      sourceDocumentID: input.documentID,
      sourceDocumentSha256: input.documentSha256,
      sourcePublicationStatus: input.publicationStatus,
      extractorModel: input.modelIdentifier,
      extractorPromptVersion: input.candidatePromptVersion,
      verifierModel: input.modelIdentifier,
      verifierPromptVersion: input.verifierPromptVersion,
      extractionRunID: input.runID,
      createdAt: input.now,
      updatedAt: input.now,
    },
  }
  return { card, taxonomySuggestions }
}
