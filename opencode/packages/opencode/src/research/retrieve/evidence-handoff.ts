import { createHash } from "crypto"
import type { TaskEvidenceBundle, TaskEvidenceEntry } from "./contract"
import { decisionCardIDs } from "./architecture-knowledge"
import { ARCHITECTURE_SELECTION_POLICY, architectureEligibilityIssues } from "./architecture-eligibility"

/** In the mainline, only sources of reviewed architectural choices authorize citations.
 * These are derived citation views, not rewritten or republished sealed cards.
 */
export function citableTaskEvidence(bundle: TaskEvidenceBundle): TaskEvidenceEntry[] {
  const packet = bundle.architectureKnowledge
  if (!packet) return bundle.entries // Older saved runs retain their original citation contract.
  if (packet.selectionPolicy !== ARCHITECTURE_SELECTION_POLICY) return []
  if (packet.decisions.some((d) => d.taskFit !== "supported" || architectureEligibilityIssues(
    packet.reviews.find((r) => r.decisionID === d.decisionID && r.verdict === "accepted")?.eligibility,
  ).length)) return []
  return packet.sourceCards.map((card) => {
    const decisions = packet.decisions.filter((d) => decisionCardIDs(d).includes(card.knowledgeID))
    return {
      evidenceEntryID: `te_${createHash("sha256").update(`${packet.corpusDigest}:${card.knowledgeID}:${card.revision}`).digest("hex").slice(0, 16)}`,
      cardID: card.knowledgeID, cardRevision: card.revision, paperID: card.paperID,
      paperTitle: bundle.entries.find((e) => e.paperID === card.paperID)?.paperTitle,
      cardType: "transferable_principle", cardStatus: "paper_backed", knowledge: card,
      claim: decisions.map((d) => `${d.dataCondition} → ${d.prefer}`).join("\n"),
      mechanism: { mechanismID: card.knowledgeID, name: decisions.map((d) => d.prefer).join("; "),
        principle: decisions.map((d) => d.mechanism).join("\n"), components: [] },
      linkage: { intentIDs: [], candidateIDs: [], transformationIDs: [], conceptIDs: [], methodConceptIDs: [],
        datasetEvidencePaths: packet.datasetEvidencePaths },
      roles: ["supports_mechanism", "warns_limitation"],
      relevance: { score: 1, matchedTerms: [], reasons: ["Selected by independent source review and architectural usefulness audit"] },
      applicability: { status: decisions.every((d) => d.taskFit === "supported") ? "matched" : "partial",
        matchedConditions: decisions.filter((d) => d.taskFit === "supported").map((d) => d.dataCondition),
        violatedConditions: [], uncertainConditions: decisions.filter((d) => d.taskFit === "conditional").map((d) => d.taskReason) },
      limitations: [...new Set(decisions.flatMap((d) => d.limitations))],
      evidenceRefs: card.sources.map((s) => ({ evidenceID: s.sourceID, evidenceSpan: s.quote,
        chunkID: s.chunkID, section: s.sectionID, pageStart: s.page, pageEnd: s.pageEnd ?? s.page,
        directness: "direct", verification: "exact_span" })),
    }
  })
}

/** Exact source text and structured mechanisms must survive generic prompt compaction. */
export function projectTaskEvidence(bundle: TaskEvidenceBundle) {
  const entries = citableTaskEvidence(bundle)
  const permitted = new Set(entries.map((e) => e.cardID))
  const decisions = bundle.architectureKnowledge?.decisions.filter((d) => decisionCardIDs(d).every((id) => permitted.has(id)))
  return {
    readiness: bundle.architectureKnowledge && !entries.length ? "ready_data_only" : bundle.readiness,
    architectureKnowledge: bundle.architectureKnowledge ? {
      version: bundle.architectureKnowledge.version, status: bundle.architectureKnowledge.status,
      selectionPolicy: bundle.architectureKnowledge.selectionPolicy,
      decisions: decisions ?? [],
      implementationReviews: bundle.architectureKnowledge.reviews.filter((r) => decisions?.some((d) => d.decisionID === r.decisionID)),
      historicalCardIDs: bundle.architectureKnowledge.historicalCardIDs,
      warnings: [...bundle.architectureKnowledge.warnings, ...(bundle.architectureKnowledge.selectionPolicy !== ARCHITECTURE_SELECTION_POLICY
        ? ["Saved architecture knowledge lacks current task admission; rerun retrieval before using it."] : [])],
    } : undefined,
    consolidation: bundle.consolidation,
    mechanismRelations: bundle.mechanismRelations ?? [],
    entries: entries.map((entry) => ({
      knowledge: entry.knowledge,
      knowledgeConfidence: entry.knowledge?.confidence,
      cardID: entry.cardID, revision: entry.cardRevision,
      paperID: entry.paperID, paperTitle: entry.paperTitle,
      claim: entry.claim, problem: entry.problem, mechanism: entry.mechanism,
      experimentalContext: entry.experimentalContext,
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
    interpretation: bundle.architectureKnowledge ? "Only decisions admitted under implementable_family_prediction_v1 guide this task: source-supported general modeling families expressible by ModelRecipe, established necessary target data conditions, and prediction-quality relevance. Consult implementationReviews.familyMappings for available prefer/avoid choices and transfer boundaries; the recipe is an expressibility witness, not an exact paper replica or a mandated experiment configuration. Operator, architecture or window differences alone do not invalidate a general family principle. Do not claim the runtime implements an unsupported bespoke source operator or inherits its measured gains. Unknown-condition, task-mismatched and efficiency-only rules are withheld. Source cards provide immutable provenance, not extra authorized decisions. Use published experience directly without reproducing author experiments. Cite supplied entries with exact cardID/revision/role. Empty decisions means data-only planning; no discarded raw-card fallback. No universal gain or causal superiority is implied." : "knowledge.confidence is an initial ranking prior (0.5) plus small ReflectionAgent-confirmed experiment increments, not a calibrated success probability or universal validation. experimentValidations are local experimental facts and judgments, separate from paper sources. knowledge is the complete source-reviewed v2 principle, including conditions, operation, mechanism attribution, expected effect, experiments, support/refutations, observed scope, boundaries, unknowns, falsification and assertion reviews. Preserve qualifications and contrary evidence. Falsification is proposed validation, never an observed result. Epistemic status is not proof of cross-task effectiveness. Cite only entry.cardID/revision with a supplied role. Parent/component relations describe nested operations, not independent corroboration. Equivalent sources document consolidation, not additional independent mechanisms or separately permitted citations. Mechanism describes the paper's operation; applicability unknown/partial is not verified task suitability. Applicability matched means declared conditions are met, not that effectiveness on this task is validated. experimentalContext records source experiments, never current-task results. Define a current-task comparison and falsification criterion for transferred claims. Empty registryMappings means implementation mapping is unresolved, not that an operator exists. Do not infer efficacy from a mechanism description.",
  }
}

export function projectCitedTaskEvidence(bundle: TaskEvidenceBundle | undefined,
  citations: readonly { cardID: string; cardRevision: number; role: string }[]) {
  if (!bundle) throw new Error("Selected hypothesis literature evidence bundle is unavailable")
  for (const citation of citations) {
    if (!citableTaskEvidence(bundle).some((entry) => entry.cardID === citation.cardID && entry.cardRevision === citation.cardRevision &&
      entry.roles.some((role) => role === citation.role))) {
      throw new Error(`Selected hypothesis has stale or unavailable evidence: ${citation.cardID}@${citation.cardRevision}`)
    }
  }
  const packet = projectTaskEvidence(bundle)
  const decisions = packet.architectureKnowledge?.decisions.filter((d) => decisionCardIDs(d).some((id) => citations.some((c) => c.cardID === id)))
  const requiredSources = new Set([...(decisions ?? []).flatMap(decisionCardIDs), ...citations.map((c) => c.cardID)])
  return { ...packet, architectureKnowledge: packet.architectureKnowledge ? { ...packet.architectureKnowledge, decisions: decisions ?? [],
      implementationReviews: packet.architectureKnowledge.implementationReviews.filter((r) => decisions?.some((d) => d.decisionID === r.decisionID)) } : undefined,
    entries: packet.entries.filter((entry) => requiredSources.has(entry.cardID)) }
}
