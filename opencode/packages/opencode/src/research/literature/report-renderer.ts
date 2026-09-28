import type { KnowledgeCard, RejectedCandidate } from "./contract"
import type { PrincipleExtraction } from "./paper-principle-extractor"
import { principleSourceCoverage } from "./knowledge-v2-validator"

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

export function renderPrincipleReview(run: PrincipleExtraction) {
  const lines = [
    `# Paper principles: ${run.paperID}`, "",
    `Run: ${run.runID}; status: ${run.status}; publication: audit_only.`, "",
    `Candidates: ${run.candidates.length}; final candidates: ${run.finalCandidates.length}; verified principles: ${run.cards.length}; model calls: ${run.calls.length}.`, "",
    "These records have not been handed to downstream agents or validated by task experiments.", "",
  ]
  for (const card of run.cards) {
    const assertions = new Map(card.assertions.map((a) => [a.assertionID, a.statement]))
    const coverage = principleSourceCoverage(card, card.review)
    lines.push(`## ${card.knowledgeID}`, "", card.principle, "", `Transferable insight: ${card.transferableInsight}`, "",
      `Conditions: ${card.conditions.map((c) => assertions.get(c.assertionID)).join("; ")}`,
      `Intervention: ${card.intervention.operation}`,
      `Required components: ${card.intervention.necessaryComponents.join("; ")}`,
      `Mechanism (${card.mechanism.attribution}): ${card.mechanism.explanatoryPath}`,
      `Evidence status: ${card.epistemicStatus}; use for hypothesis generation and validation, not guaranteed task performance.`,
      `Source review coverage: ${coverage.reviewedSourceIDs.length}/${card.sources.length}; ${coverage.complete ? "complete" : "partial (non-blocking)"}. Unreviewed sources: ${coverage.unreviewedSourceIDs.join(", ") || "none"}. Additional registered sources reviewed: ${coverage.additionalReviewedSourceIDs.join(", ") || "none"}.`,
      `Evidence limitations: ${card.review.assertionReviews.filter((a) => a.verdict === "qualified").map((a) => `${a.assertionID} [${a.qualification?.kind ?? "untyped"}]: ${a.reason}`).join("; ") || "None additionally qualified by the reviewer"}`,
      `Effect (${card.expectedEffect.kind}): ${assertions.get(card.expectedEffect.assertionID)}`,
      `Observed scope: ${card.observedScope.map((s) => assertions.get(s.assertionID)).join("; ") || "Not reported"}`,
      `Boundaries: ${card.boundaries.status === "reported" ? card.boundaries.items.map((b) => assertions.get(b.assertionID)).join("; ") : card.boundaries.note}`,
      `Unknowns: ${card.unknowns.join("; ") || "None recorded"}`,
      `Proposed validation: ${card.falsification.test}; failure criterion: ${card.falsification.failureCriterion}`, "",
      "Evidence bindings:", "",
      ...card.support.map((s) => `- ${s.evidenceID}: ${s.relation} [${s.assertionIDs.join(", ")}]; sources [${s.sourceIDs.join(", ")}]; experiment ${s.experimentID ?? "none"}`), "",
      "Sources:", "", ...card.sources.map((s) => `- ${s.sourceID}: ${s.paperID}, p.${s.page}, ${s.sectionID}, ${s.chunkID}: ${s.quote}`), "")
    if (card.experiments.length) lines.push("Bound experiments (including missing fields):", "", "```json", JSON.stringify(card.experiments, null, 2), "```", "")
  }
  lines.push("## Dispositions and gaps", "", ...run.dispositions.map((d) => `- ${d.originalCandidateID}: ${d.action} → ${d.finalCandidateIDs.join(", ") || "none"}; ${d.rationale}`),
    ...run.stagedMaterials.map((m) => `- Staged material ${m.gapID}: ${m.reason}`),
    ...run.rejected.map((r) => `- ${r.candidateID}: ${r.reasons.join(", ")}`),
    ...run.unformed.map((r) => `- Unformed: ${r}`), ...run.errors.map((e) => `- Incomplete: ${e}`), "")
  return `${lines.join("\n")}\n`
}
