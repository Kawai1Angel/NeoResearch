import type { KnowledgeCard } from "./contract"

// Quotas apply to verified unique cards, never to the first N extracted sentences.
export function selectCardBudget(cards: readonly KnowledgeCard[], limit: number) {
  const remaining = [...cards]
  const selected: KnowledgeCard[] = []
  const types = new Set<string>()
  const pages = new Set<number>()
  while (remaining.length && selected.length < limit) {
    remaining.sort((a, b) => {
      const rank = (card: KnowledgeCard) =>
        Number(card.cardType === "model_mechanism" && selected.filter((item) => item.cardType === "model_mechanism").length < Math.ceil(limit * 0.6)) * 4 +
        Number(!types.has(card.cardType)) * 2 +
        Number(card.evidence.some((item) => !pages.has(item.pageStart))) + card.confidence.extractionConfidence
      return rank(b) - rank(a) || a.cardID.localeCompare(b.cardID)
    })
    const card = remaining.shift()!
    selected.push(card)
    types.add(card.cardType)
    for (const evidence of card.evidence) pages.add(evidence.pageStart)
  }
  return { selected, omitted: remaining }
}
