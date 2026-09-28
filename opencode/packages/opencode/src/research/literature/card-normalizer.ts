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
  if (candidate.evidenceType === "agent_inference") return 0.35
  const datasetSignals = candidate.claim.match(/\b(?:ETT\w*|Electricity|Traffic|Weather|Exchange|ILI|PEMS\w*|dataset)s?\b/gi) ?? []
  return datasetSignals.length >= 3 ? 0.8 : datasetSignals.length >= 1 ? 0.55 : 0.4
}

function applicabilityBasis(candidate: CandidateClaim): KnowledgeCard["applicability"]["basis"] {
  if (candidate.evidenceType === "agent_inference") return "agent_inference"
  if (["author_experiment", "ablation_result"].includes(candidate.evidenceType)) return "author_experiment"
  if (["author_definition", "author_argument", "limitation_statement"].includes(candidate.evidenceType)) return "author_statement"
  return "unknown"
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
  const normalizedClaim = {
    subject: normalizeClaimPart(candidate.subject, input.taxonomy),
    predicate: normalizeClaimPart(candidate.predicate, input.taxonomy),
    object: normalizeClaimPart(candidate.object, input.taxonomy),
  }
  const key = `${candidate.paperID}|${normalizedClaim.subject}|${normalizedClaim.predicate}|${normalizedClaim.object}`
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
    applicability: {
      taskTypes: candidate.claim.toLowerCase().includes("forecast") ? ["forecasting"] : [],
      dataFeatures: Object.keys(input.taxonomy.data_features).filter((term) => candidate.claim.toLowerCase().includes(term.replaceAll("_", " "))),
      domains: [], dataScale: [],
      horizonProfile: /\blong[- ](?:term|range|horizon)\b/i.test(candidate.claim) ? ["long_horizon"] : [],
      computeProfile: [], basis: applicabilityBasis(candidate),
    },
    notApplicableWhen: [],
    evidence,
    limitations: [],
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
