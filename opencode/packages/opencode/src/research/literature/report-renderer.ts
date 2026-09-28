import type { KnowledgeCard, RejectedCandidate } from "./contract"

function short(value: string, limit = 280) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

export function renderReview(input: {
  readonly paperID: string; readonly runID: string; readonly cards: readonly KnowledgeCard[]
  readonly rejected: readonly RejectedCandidate[]; readonly warnings: readonly string[]
}) {
  const lines = [
    `# Literature review: ${input.paperID}`,
    "",
    `- Run: \`${input.runID}\``,
    `- Accepted cards: ${input.cards.length}`,
    `- Quality-rejected candidates: ${input.rejected.filter((item) => item.reason !== "duplicate" && item.reason !== "verification_error" && item.reason !== "selection_budget").length}`,
    `- Verification errors: ${input.rejected.filter((item) => item.reason === "verification_error").length}`,
    `- Budget-omitted verified cards: ${input.rejected.filter((item) => item.reason === "selection_budget").length}`,
    `- Duplicate merges: ${input.rejected.filter((item) => item.reason === "duplicate").length}`,
    `- Warnings: ${input.warnings.length}`,
    "",
  ]
  if (input.warnings.length) {
    lines.push("## Parse and safety warnings", "", ...input.warnings.map((item) => `- ${item}`), "")
  }
  const groups = Map.groupBy(input.cards, (card) => card.cardType)
  for (const [type, cards] of groups) {
    lines.push(`## ${type}`, "")
    for (const card of cards) {
      lines.push(
        `### ${card.cardID} · revision ${card.revision}`,
        "",
        card.claim,
        "",
        `Status: \`${card.status}\`; confidence: source ${card.confidence.sourceQuality.toFixed(2)}, extraction ${card.confidence.extractionConfidence.toFixed(2)}, evidence ${card.confidence.evidenceDirectness.toFixed(2)}, transfer ${card.confidence.transferability.toFixed(2)}.`,
        "",
      )
      for (const evidence of card.evidence) {
        lines.push(`- p.${evidence.pageStart}${evidence.pageEnd === evidence.pageStart ? "" : `–${evidence.pageEnd}`} · ${evidence.section} · \`${evidence.chunkID}\`: “${short(evidence.evidenceSpan)}”`)
      }
      if (card.limitations.length) lines.push("", ...card.limitations.map((item) => `- Limitation: ${item}`))
      lines.push("")
    }
  }
  const reasons = new Map<string, number>()
  for (const item of input.rejected) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1)
  lines.push("## Rejections", "")
  if (reasons.size === 0) lines.push("No rejected candidates.", "")
  else lines.push(...[...reasons].sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => `- ${reason}: ${count}`), "")
  return `${lines.join("\n")}\n`
}

export function renderCardExport(cards: readonly KnowledgeCard[]) {
  return cards.map((card) => JSON.stringify(card)).join("\n") + (cards.length ? "\n" : "")
}
