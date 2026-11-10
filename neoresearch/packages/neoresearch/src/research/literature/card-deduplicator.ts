import { createHash } from "crypto"
import type { CardRelation, KnowledgeCard } from "./contract"

function normalizedText(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
}

function claimKey(card: KnowledgeCard) {
  const claim = card.normalizedClaim
  return `${claim.subject}|${claim.predicate}|${claim.object}`
}

function tokenSimilarity(left: string, right: string) {
  const a = new Set(normalizedText(left).split(" ").filter(Boolean))
  const b = new Set(normalizedText(right).split(" ").filter(Boolean))
  const intersection = [...a].filter((item) => b.has(item)).length
  const union = new Set([...a, ...b]).size
  return union === 0 ? 0 : intersection / union
}

const OPPOSITE_PREDICATES: Readonly<Record<string, readonly string[]>> = {
  improves: ["degrades", "worsens", "does_not_improve"],
  supports: ["contradicts", "rejects"],
  increases: ["decreases", "reduces"],
  requires: ["avoids", "removes"],
  effective_for: ["ineffective_for", "fails_for"],
}

function opposite(left: string, right: string) {
  return OPPOSITE_PREDICATES[left]?.includes(right) || OPPOSITE_PREDICATES[right]?.includes(left) || false
}

function relation(source: KnowledgeCard, target: KnowledgeCard, type: CardRelation["relationType"], rationale: string, confidence: number): CardRelation {
  const seed = `${source.cardID}|${target.cardID}|${type}`
  return {
    relationID: `rel_${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`,
    sourceCardID: source.cardID, targetCardID: target.cardID, relationType: type, rationale, confidence,
    createdBy: "deterministic", createdAt: source.provenance.updatedAt,
  }
}

export type DeduplicationDecision =
  | { readonly action: "insert"; readonly card: KnowledgeCard; readonly relations: readonly CardRelation[] }
  | { readonly action: "merge"; readonly card: KnowledgeCard; readonly duplicateOf: KnowledgeCard; readonly relations: readonly CardRelation[] }

export function deduplicateCard(card: KnowledgeCard, existing: readonly KnowledgeCard[]): DeduplicationDecision {
  const relations: CardRelation[] = []
  for (const item of existing) {
    const samePaper = item.paperID === card.paperID
    const scope = (value: KnowledgeCard) => JSON.stringify([value.applicability, value.notApplicableWhen,
      value.experimentalContext, value.limitations])
    const sameScope = scope(item) === scope(card)
    const sameTriple = claimKey(item) === claimKey(card)
    const sameClaim = normalizedText(item.claim) === normalizedText(card.claim)
    const sharedEvidence = item.evidence.some((a) => card.evidence.some((b) => a.chunkID === b.chunkID))
    const sameMechanism = item.mechanism && card.mechanism &&
      normalizedText(item.mechanism.principle) === normalizedText(card.mechanism.principle) &&
      item.mechanism.components.map(normalizedText).sort().join("|") === card.mechanism.components.map(normalizedText).sort().join("|")
    if (samePaper && sameScope && item.cardType === card.cardType && (sameMechanism || sameTriple || sameClaim || (sharedEvidence && tokenSimilarity(item.claim, card.claim) >= 0.9))) {
      return { action: "merge", card, duplicateOf: item, relations: [relation(card, item, "duplicates", "deterministic normalized claim/evidence match", 1)] }
    }
    if (!samePaper && sameScope && sameClaim) {
      relations.push(relation(card, item, "supports", "independent papers express the same normalized claim", 0.9))
      continue
    }
    if (
      item.normalizedClaim.subject === card.normalizedClaim.subject &&
      item.normalizedClaim.object === card.normalizedClaim.object &&
      opposite(item.normalizedClaim.predicate, card.normalizedClaim.predicate)
    ) {
      relations.push(relation(card, item, "contradicts", "same normalized subject/object with opposing predicates; requires confirmation", 0.7))
    } else if (tokenSimilarity(item.claim, card.claim) >= 0.72 && card.claim.length > item.claim.length * 1.15) {
      relations.push(relation(card, item, "refines", "new claim is a more specific lexical match", 0.65))
    }
  }
  return { action: "insert", card, relations }
}

export function mergeCardEvidence(existing: KnowledgeCard, incoming: KnowledgeCard, revision: number, now: string): KnowledgeCard {
  const evidence = [...existing.evidence]
  const known = new Set(evidence.map((item) => item.evidenceID))
  for (const item of incoming.evidence) if (!known.has(item.evidenceID)) evidence.push(item)
  return {
    ...incoming,
    cardID: existing.cardID,
    revision,
    evidence,
    confidence: {
      sourceQuality: Math.max(existing.confidence.sourceQuality, incoming.confidence.sourceQuality),
      extractionConfidence: Math.max(existing.confidence.extractionConfidence, incoming.confidence.extractionConfidence),
      evidenceDirectness: Math.max(existing.confidence.evidenceDirectness, incoming.confidence.evidenceDirectness),
      transferability: incoming.confidence.transferability,
    },
    provenance: { ...incoming.provenance, createdAt: existing.provenance.createdAt, updatedAt: now, extractionRunID: incoming.provenance.extractionRunID },
  }
}
