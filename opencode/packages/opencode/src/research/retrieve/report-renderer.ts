import type { RetrieveResult } from "./contract"

export function renderRetrieveReport(result: RetrieveResult) {
  const lines = [
    "# RetrieveAgent Report",
    "",
    `- Retrieve run: ${result.retrieveRunID}`,
    `- Task: ${result.taskID}`,
    `- Status: ${result.summary.failedPaperCount > 0 || result.summary.missingPDFCount > 0 ? "completed_with_warnings" : "completed"}`,
    "",
    "## Summary",
    "",
    `- Retrieval intents: ${result.summary.intentCount}`,
    `- BM25 candidates: ${result.summary.bm25CandidateCount}`,
    `- Papers sent to LiteratureAgent: ${result.summary.literaturePaperCount}`,
    `- Paper-backed cards: ${result.summary.paperBackedCardCount}`,
    `- Missing PDFs: ${result.summary.missingPDFCount}`,
    `- Failed papers: ${result.summary.failedPaperCount}`,
    `- Task evidence readiness: ${result.taskEvidence.readiness}`,
    `- Selected task evidence: ${result.taskEvidence.summary.selectedEntryCount}`,
    `- Uncovered must-cover intents: ${result.taskEvidence.summary.uncoveredMustCoverIntentCount}`,
    "",
    "## Evidence to query transformations",
    "",
  ]
  for (const transformation of result.transformations) {
    lines.push(
      `### ${transformation.scientificConcepts.map((item) => item.label).join(", ")}`,
      "",
      `- Evidence: ${transformation.datasetEvidence.map((item) => item.path).join(", ")}`,
      `- Retrieval hypotheses: ${transformation.methodConcepts.map((item) => item.label).join(", ") || "none"}`,
      `- Query: ${transformation.paperLanguage.queryText}`,
      "",
    )
  }
  lines.push("## Literature bridge", "")
  if (result.literatureResults.length === 0) lines.push("- No paper was sent to LiteratureAgent.")
  for (const paper of result.literatureResults) {
    lines.push(`- ${paper.paperID}: ${paper.status}; intents=${paper.intentIDs.join(",")}; cards=${paper.acceptedCardIDs.length}`)
  }
  lines.push("", "## Task evidence", "")
  if (result.taskEvidence.entries.length === 0) lines.push("- No eligible literature evidence; HypoPlanner must use data_only mode.")
  for (const entry of result.taskEvidence.entries) {
    lines.push(
      `### ${entry.cardID}@${entry.cardRevision}`,
      "",
      `- Paper: ${entry.paperID}`,
      `- Roles: ${entry.roles.join(", ")}`,
      `- Intents: ${entry.linkage.intentIDs.join(", ")}`,
      `- Dataset evidence: ${entry.linkage.datasetEvidencePaths.join(", ")}`,
      `- Applicability: ${entry.applicability.status}`,
      `- Matched conditions: ${entry.applicability.matchedConditions.join("; ") || "unspecified"}`,
      `- Violated conditions: ${entry.applicability.violatedConditions.join("; ") || "none"}`,
      `- Uncertain conditions: ${entry.applicability.uncertainConditions.join("; ") || "none"}`,
      `- Limitations: ${entry.limitations.join("; ") || "none stated"}`,
      `- Paper locations: ${entry.evidenceRefs.map((item) => `${item.section} p.${item.pageStart}-${item.pageEnd}`).join(", ")}`,
      `- Claim: ${entry.claim}`,
      "",
    )
  }
  lines.push("## Conflicts and exclusions", "")
  for (const conflict of result.taskEvidence.conflicts) {
    lines.push(`- Conflict ${conflict.relationID}: ${conflict.sourceCardID} ↔ ${conflict.targetCardID} (${conflict.confidence}) — ${conflict.rationale}`)
  }
  for (const item of result.taskEvidence.excluded) {
    lines.push(`- Excluded ${item.cardID} (${item.paperID}): ${item.reasons.join(", ")} — ${item.detail.join("; ")}`)
  }
  lines.push("", "## Evidence gaps", "")
  if (result.taskEvidence.gaps.length === 0) lines.push("- None.")
  for (const gap of result.taskEvidence.gaps) {
    lines.push(`- ${gap.intentID}: ${gap.reason}; mustCover=${gap.mustCover}; concepts=${gap.conceptIDs.join(",")}`)
  }
  return `${lines.join("\n")}\n`
}
