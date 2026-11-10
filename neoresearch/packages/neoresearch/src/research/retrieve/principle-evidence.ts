import { createHash } from "node:crypto"
import { KnowledgeCardV2Schema, KNOWLEDGE_V2_VERSIONS, type KnowledgeCardV2 } from "../literature/knowledge-v2-contract"
import { validateKnowledgeCardSeal } from "../literature/knowledge-v2-validator"
import { bindCardToIntents } from "./card-intent-binder"
import { matchPrincipleApplicability } from "./applicability-matcher"
import { unsupportedCardMechanisms } from "./model-recipe-screen"
import { selectEntries, coversIntent, gapReason, taskContextDigest, type buildLegacyTaskEvidence } from "./task-evidence-builder"
import { TaskEvidenceBundleSchema, TaskEvidenceEntrySchema, type TaskEvidenceEntry, type ExcludedTaskEvidence } from "./contract"

export type PrincipleKnowledgeSource = { getCard(id: string): unknown; listCards?(): unknown[]; listRelations?(): unknown[] }

export function reviewedPrinciple(value: unknown): KnowledgeCardV2 | undefined {
  if (!value || typeof value !== "object" || !("schemaVersion" in value) || value.schemaVersion !== "knowledge_card_v2") return undefined
  const card = KnowledgeCardV2Schema.parse(value)
  if (validateKnowledgeCardSeal(card).length) return undefined
  return card
}

export function principleMechanism(card: KnowledgeCardV2) {
  return { mechanismID: card.knowledgeID, name: card.intervention.operation, principle: card.mechanism.explanatoryPath,
    components: card.intervention.necessaryComponents }
}
export function unsupportedPrinciple(card: KnowledgeCardV2) { return unsupportedCardMechanisms(principleMechanism(card)) }

const unique = (values: readonly string[]) => [...new Set(values)].toSorted()
export function buildPrincipleTaskEvidence(input: Omit<Parameters<typeof buildLegacyTaskEvidence>[0], "knowledgeSource"> & {
  knowledgeSource: PrincipleKnowledgeSource
  compatibilityReviews?: readonly import("./candidate-selector").ModelRecipeCompatibilityReview[]
}) {
  const accepted = new Map<string, string>(), loaded = new Set<string>()
  const excluded: ExcludedTaskEvidence[] = [], eligible: TaskEvidenceEntry[] = []
  const exclude = (id: string, paperID: string, reason: ExcludedTaskEvidence["reasons"][number], detail: string) =>
    excluded.push({ cardID: id, paperID, reasons: [reason], detail: [detail] })
  for (const paper of input.literatureResults.toSorted((a, b) => Number(a.status === "reused_knowledge") - Number(b.status === "reused_knowledge"))) {
    for (const id of paper.acceptedCardIDs) {
      if (accepted.has(id)) {
        if (accepted.get(id) !== paper.paperID) throw new Error(`Accepted card ${id} is referenced by multiple papers`)
        continue
      }
      accepted.set(id, paper.paperID)
      const raw = input.knowledgeSource.getCard(id)
      if (!raw) { exclude(id, paper.paperID, "card_not_found", "Accepted v2 card is unavailable or retired"); continue }
      const card = reviewedPrinciple(raw)
      if (!card) { exclude(id, paper.paperID, "card_validation_required", "Only reviewed knowledge_card_v2 is eligible; re-extract legacy cards from source"); continue }
      if (card.paperID !== paper.paperID || card.knowledgeID !== id) { exclude(id, paper.paperID, "paper_mismatch", "Knowledge identity mismatch"); continue }
      loaded.add(id)
      if (paper.status === "reused_knowledge" && paper.cardRevisions?.[id] !== card.revision) {
        exclude(id, paper.paperID, "card_validation_required", "Recalled revision changed; retrieve again"); continue
      }
      const compatibility = input.compatibilityReviews?.find((r) => r.paperID === card.paperID && r.sourceSha256 === card.provenance.documentSha256)
      if (["exclude", "research_only"].includes(compatibility?.verdict ?? "") ||
        (unsupportedPrinciple(card).length && !["direct", "adaptable"].includes(compatibility?.verdict ?? ""))) {
        exclude(id, paper.paperID, "non_actionable_observation", "Source operation requires an unsupported ModelRecipe action"); continue
      }
      const bindings = bindCardToIntents({ card, intents: input.intents,
        intentIDs: input.candidates.filter((c) => c.paperID === card.paperID && c.decision !== "unsupported_model_recipe").map((c) => c.intentID),
        transformations: input.transformations, taskType: input.taskContext.taskType, domain: input.taskContext.domain })
      if (!bindings.length) { exclude(id, paper.paperID, "no_intent_match", "No relevant eligible retrieval intent"); continue }
      const intentIDs = unique(bindings.map((b) => b.intentID))
      const transformations = input.transformations.filter((t) => input.intents.some((i) => intentIDs.includes(i.intentID) && i.transformationID === t.transformationID))
      const applicability = matchPrincipleApplicability({ card, report: input.report, taskContext: input.taskContext })
      const contrary = card.support.some((s) => s.relation === "refutes")
      const limitations = [...(card.boundaries.status === "reported" ? card.boundaries.items.map((b) => card.assertions.find((a) => a.assertionID === b.assertionID)!.statement) : [card.boundaries.note]), ...card.unknowns]
      eligible.push(TaskEvidenceEntrySchema.parse({
        evidenceEntryID: `te_${createHash("sha256").update(JSON.stringify([id, card.revision, intentIDs, taskContextDigest(input.taskContext)])).digest("hex").slice(0, 16)}`,
        cardID: id, cardRevision: card.revision, paperID: card.paperID, paperTitle: input.paperTitles?.[card.paperID],
        cardType: "transferable_principle", cardStatus: "paper_backed", claim: card.principle, knowledge: card,
        mechanism: principleMechanism(card),
        linkage: { intentIDs, candidateIDs: unique(input.candidates.filter((c) => c.paperID === card.paperID && intentIDs.includes(c.intentID)).map((c) => c.candidateID)),
          transformationIDs: transformations.map((t) => t.transformationID),
          conceptIDs: unique(transformations.flatMap((t) => t.scientificConcepts.map((c) => c.conceptID))),
          methodConceptIDs: unique(transformations.flatMap((t) => t.methodConcepts.map((c) => c.conceptID))),
          datasetEvidencePaths: unique(transformations.flatMap((t) => t.datasetEvidence.map((e) => e.path))) },
        roles: applicability.status === "conflicted" ? ["warns_limitation"] : ["supports_mechanism", ...(contrary ? ["contradicts"] : []), ...(card.boundaries.status === "reported" ? ["warns_limitation"] : [])],
        relevance: { score: Math.max(...bindings.map((b) => b.score)), matchedTerms: unique(bindings.flatMap((b) => [...b.matchedTerms])), reasons: unique([...bindings.flatMap((b) => [...b.reasons]), `Selection includes confidence ${card.confidence} at weight 0.1`]) },
        applicability, limitations,
        evidenceRefs: card.sources.map((s) => ({ evidenceID: s.sourceID, evidenceSpan: s.quote, chunkID: s.chunkID,
          section: s.sectionID, pageStart: s.page, pageEnd: s.pageEnd ?? s.page, directness: "direct", verification: "exact_span" })),
      }))
    }
  }
  if (accepted.size && !loaded.size) throw new Error("All accepted v2 KnowledgeCard provenance is unavailable, legacy or corrupt")
  const selected = selectEntries({ entries: eligible, intents: input.intents, budgets: input.budgets })
  for (const entry of selected.omitted) exclude(entry.cardID, entry.paperID, "selection_budget", "Whole principle omitted by task budget")
  const gaps = input.intents.filter((i) => !selected.entries.some((e) => coversIntent(e, i))).map((intent) => ({
    intentID: intent.intentID, mustCover: intent.mustCover,
    conceptIDs: input.transformations.find((t) => t.transformationID === intent.transformationID)!.scientificConcepts.map((c) => c.conceptID),
    reason: gapReason({ intent, candidates: input.candidates, literatureResults: input.literatureResults, acceptedIDs: new Set(accepted.keys()), eligibleBeforeBudget: eligible, selected: selected.entries }) ?? "no_eligible_card" as const,
  }))
  const conflict = selected.entries.some((e) => e.applicability.status === "conflicted" || e.roles.includes("contradicts"))
  return TaskEvidenceBundleSchema.parse({ schemaVersion: "task_evidence_bundle_v2", retrieveRunID: input.retrieveRunID,
    taskID: input.report.taskID, quantitativeReportArtifactID: input.quantitativeReportArtifactID, taskContextDigest: taskContextDigest(input.taskContext),
    readiness: !selected.entries.length ? "ready_data_only" : conflict ? "evidence_conflict" : gaps.some((g) => g.mustCover) || input.literatureResults.some((p) => ["partial", "failed"].includes(p.status)) ? "partial_evidence" : "ready_with_evidence",
    entries: selected.entries, excluded, conflicts: [], gaps,
    consolidation: { version: KNOWLEDGE_V2_VERSIONS.synthesis, reviewedPapers: unique(selected.entries.map((e) => e.paperID)), failedPapers: [], unavailablePapers: [] },
    summary: { acceptedCardCount: accepted.size, selectedEntryCount: selected.entries.length, excludedCardCount: excluded.length,
      coveredIntentCount: input.intents.length - gaps.length, uncoveredMustCoverIntentCount: gaps.filter((g) => g.mustCover).length, conflictCount: 0 },
  })
}
