import type { RetrieveResult } from "./contract"
import { citableTaskEvidence } from "./evidence-handoff"

export function renderRetrieveReport(result: RetrieveResult) {
  const entries = citableTaskEvidence(result.taskEvidence)
  const architecture = result.taskEvidence.architectureKnowledge
  const lines = [
    "# RetrieveAgent Report",
    "",
    `- Retrieve run: ${result.retrieveRunID}`,
    `- Task: ${result.taskID}`,
    `- Status: ${result.summary.failedPaperCount > 0 || result.summary.missingPDFCount > 0 || (architecture && architecture.status !== "completed") ? "completed_with_warnings" : "completed"}`,
    "",
    "## Summary",
    "",
    `- Retrieval intents: ${result.summary.intentCount}`,
    `- BM25 candidates: ${result.summary.bm25CandidateCount}`,
    `- Source catalog candidates: ${result.candidates.filter((candidate) => (candidate.recallRoute ?? "source_catalog") === "source_catalog").length}`,
    `- Classic library candidates: ${result.candidates.filter((candidate) => candidate.recallRoute === "classic_library").length}`,
    `- Shared knowledge candidates: ${result.candidates.filter((candidate) => candidate.recallRoute === "knowledge_store").length}`,
    `- ModelRecipe-incompatible papers screened out: ${new Set(result.candidates.filter((candidate) => candidate.decision === "unsupported_model_recipe").map((candidate) => candidate.paperID)).size}`,
    `- Domain-specific papers deferred in fine screening: ${new Set(result.candidates.filter((candidate) => candidate.decision === "domain_specific").map((candidate) => candidate.paperID)).size}`,
    `- Papers sent to LiteratureAgent: ${result.summary.literaturePaperCount}`,
    `- Paper-backed cards: ${result.summary.paperBackedCardCount}`,
    `- Missing PDFs: ${result.summary.missingPDFCount}`,
    `- Failed papers: ${result.summary.failedPaperCount}`,
    `- Task evidence readiness: ${result.taskEvidence.readiness}`,
    `- Citable task evidence sources: ${entries.length}`,
    `- Reviewed architectural decisions: ${architecture?.decisions.length ?? "legacy run"}`,
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
  lines.push("## Fine screening", "")
  const screened = result.candidates.filter((candidate) => candidate.decision === "unsupported_model_recipe")
  if (screened.length === 0) lines.push("- No candidate was excluded for a known unsupported ModelRecipe mechanism.")
  for (const candidate of screened) lines.push(`- ${candidate.paperID} (${candidate.recallRoute ?? "source_catalog"}): ${candidate.decisionReasons.filter((reason) => reason.startsWith("ModelRecipe has no")).join("; ")}`)
  for (const candidate of result.candidates.filter((item) => item.decision === "domain_specific")) {
    lines.push(`- ${candidate.paperID} (${candidate.recallRoute ?? "source_catalog"}): ${candidate.decisionReasons.at(-1)}`)
  }
  lines.push("## Literature bridge", "")
  if (result.summary.literaturePaperCount === 0) lines.push("- No paper was sent to LiteratureAgent.")
  for (const paper of result.literatureResults) {
    lines.push(`- ${paper.paperID}: ${paper.status}; intents=${paper.intentIDs.join(",")}; cards=${paper.acceptedCardIDs.length}`)
  }
  lines.push("", "## Task evidence", "")
  if (architecture) {
    lines.push(`- Architecture review: ${architecture.status}; recalled=${architecture.consideredCardCount}; source-read=${architecture.readCardCount}`, "")
    for (const d of architecture.decisions) lines.push(`### ${d.decisionID}`, "", `- Data condition: ${d.dataCondition}`,
      `- Prefer: ${d.prefer}`, `- Deprioritize: ${d.avoid}`, `- Why: ${d.mechanism}`, `- Source observation: ${d.observedEffect}`,
      `- Task fit: ${d.taskFit}: ${d.taskReason}`, ...d.limitations.map((s) => `- Boundary: ${s}`), "")
    for (const warning of architecture.warnings) lines.push(`- Warning: ${warning}`)
  }
  if (entries.length === 0) lines.push("- No eligible literature evidence; HypoPlanner must use data_only mode.")
  for (const entry of entries) {
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
      ...(entry.experimentalContext ? [`- Source experiment scope: ${JSON.stringify(entry.experimentalContext)}`] : []),
      `- Paper locations: ${entry.evidenceRefs.map((item) => `${item.section} p.${item.pageStart}-${item.pageEnd}`).join(", ")}`,
      `- Claim: ${entry.claim}`,
      ...(entry.knowledge ? [
        `- Knowledge schema: ${entry.knowledge.schemaVersion}; epistemic status: ${entry.knowledge.epistemicStatus}; confidence: ${entry.knowledge.confidence}; experiment validations: ${entry.knowledge.experimentValidations.length}`,
        `- Intervention: ${entry.knowledge.intervention.operation}`,
        `- Mechanism (${entry.knowledge.mechanism.attribution}): ${entry.knowledge.mechanism.explanatoryPath}`,
        `- Source experiments: ${JSON.stringify(entry.knowledge.experiments)}`,
        `- Evidence relations (including refutations): ${JSON.stringify(entry.knowledge.support)}`,
        `- Proposed validation: ${entry.knowledge.falsification.test}; failure: ${entry.knowledge.falsification.failureCriterion}`,
      ] : []),
      "",
    )
  }
  if (architecture) {
    lines.push("## Architecture exclusions", "")
    for (const item of architecture.exclusions) lines.push(`- ${item.id} (${item.stage}): ${item.reason}`)
    lines.push("", "## Original intent-selection audit", "", "These source records do not independently authorize downstream architectural claims.", "")
    for (const entry of result.taskEvidence.entries) lines.push(`- ${entry.cardID}@${entry.cardRevision} (${entry.paperID})`)
  }
  lines.push(architecture ? "## Original intent conflicts and exclusions" : "## Conflicts and exclusions", "")
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
