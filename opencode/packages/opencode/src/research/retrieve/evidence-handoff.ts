import type { TaskEvidenceBundle } from "./contract"

/** Exact source text and structured mechanisms must survive generic prompt compaction. */
export function projectTaskEvidence(bundle: TaskEvidenceBundle) {
  return {
    readiness: bundle.readiness,
    consolidation: bundle.consolidation,
    mechanismRelations: bundle.mechanismRelations ?? [],
    entries: bundle.entries.map((entry) => ({
      cardID: entry.cardID, revision: entry.cardRevision,
      paperID: entry.paperID, paperTitle: entry.paperTitle,
      claim: entry.claim, problem: entry.problem, mechanism: entry.mechanism,
      roles: entry.roles, intentIDs: entry.linkage.intentIDs,
      conceptIDs: entry.linkage.conceptIDs, methodConceptIDs: entry.linkage.methodConceptIDs,
      datasetEvidencePaths: entry.linkage.datasetEvidencePaths,
      applicability: entry.applicability, limitations: entry.limitations,
      evidenceRefs: entry.evidenceRefs, equivalentSources: entry.mergedSources ?? [],
      implementation: entry.implementation,
      registryMappings: entry.implementation?.registryMappings ?? [],
      confidence: entry.confidence,
    })),
    conflicts: bundle.conflicts, gaps: bundle.gaps,
    interpretation: "Cite only entry.cardID/revision with a supplied role. Parent/component relations describe nested operations, not independent corroboration. Equivalent sources document consolidation, not additional independent mechanisms or separately permitted citations. Mechanism describes the paper's operation; applicability unknown/partial is not verified task suitability. Empty registryMappings means implementation mapping is unresolved, not that an operator exists. Do not infer efficacy from a mechanism description.",
  }
}

export function projectCitedTaskEvidence(bundle: TaskEvidenceBundle | undefined,
  citations: readonly { cardID: string; cardRevision: number; role: string }[]) {
  if (!bundle) throw new Error("Selected hypothesis literature evidence bundle is unavailable")
  for (const citation of citations) {
    if (!bundle.entries.some((entry) => entry.cardID === citation.cardID && entry.cardRevision === citation.cardRevision &&
      entry.roles.some((role) => role === citation.role))) {
      throw new Error(`Selected hypothesis has stale or unavailable evidence: ${citation.cardID}@${citation.cardRevision}`)
    }
  }
  const packet = projectTaskEvidence(bundle)
  return { ...packet, entries: packet.entries.filter((entry) => citations.some((citation) => citation.cardID === entry.cardID)) }
}
