import { knowledgeSelectionScore, KNOWLEDGE_SELECTION_VERSION } from "../literature/knowledge-confidence"
import { createHash } from "crypto"
import type { KnowledgeCardV2 } from "../literature/knowledge-v2-contract"
import { reviewedPrinciple, unsupportedPrinciple } from "./principle-evidence"
import { matchPrincipleApplicability } from "./applicability-matcher"
import { bindCardToIntents } from "./card-intent-binder"
import type { ModelRecipeCompatibilityReview } from "./candidate-selector"
import type {
  ConceptTransformation, DatasetQuantitativeAnalysis, RetrievalBudgets, RetrievalCandidate,
  RetrievalIntent, RetrieveLiteratureBridgeResult, RetrieveTaskContext,
} from "./contract"

export const KNOWLEDGE_RECALL_VERSION = `knowledge_recall_v3:${KNOWLEDGE_SELECTION_VERSION}`

/** Recall persisted source evidence independently of PDF availability or this task's paper selection. */
export function recallKnowledge(input: {
  cards: readonly unknown[]
  report: DatasetQuantitativeAnalysis
  taskContext: RetrieveTaskContext
  transformations: readonly ConceptTransformation[]
  intents: readonly RetrievalIntent[]
  budgets: RetrievalBudgets
  compatibilityReviews?: readonly ModelRecipeCompatibilityReview[]
}) {
  const eligible = input.cards.map(reviewedPrinciple).filter((card): card is KnowledgeCardV2 => !!card)
  const matches = eligible.flatMap((card) => {
    const applicability = matchPrincipleApplicability({ card, report: input.report, taskContext: input.taskContext })
    const review = input.compatibilityReviews?.find((item) => item.paperID === card.paperID &&
      item.sourceSha256 === card.provenance.documentSha256)
    const unsupported = unsupportedPrinciple(card)
    const blocked = review?.verdict === "exclude" || review?.verdict === "research_only" ||
      (unsupported.length > 0 && review?.verdict !== "direct" && review?.verdict !== "adaptable")
    return bindCardToIntents({ card, intents: input.intents, intentIDs: input.intents.map((item) => item.intentID),
      transformations: input.transformations, taskType: input.taskContext.taskType, domain: input.taskContext.domain })
      .map((binding) => ({ card, binding, applicability, unsupported, review, blocked }))
  })
  const candidates: RetrievalCandidate[] = []
  const papers = new Map<string, RetrieveLiteratureBridgeResult["papers"][number]>()
  const coveredPaperIntents = new Set<string>()
  for (const intent of input.intents) {
    const ranked = matches.filter((item) => item.binding.intentID === intent.intentID).toSorted((a, b) =>
      Number(a.blocked) - Number(b.blocked) ||
      Number(a.applicability.status === "conflicted") - Number(b.applicability.status === "conflicted") ||
      knowledgeSelectionScore(b.binding.score, b.card.confidence) - knowledgeSelectionScore(a.binding.score, a.card.confidence) || a.card.knowledgeID.localeCompare(b.card.knowledgeID),
    ).slice(0, input.budgets.maxCandidatesPerIntent)
    for (const { card, binding, applicability, unsupported, review, blocked } of ranked) {
      const candidateID = `rc_${createHash("sha256").update(`${KNOWLEDGE_RECALL_VERSION}|${card.knowledgeID}|${card.revision}|${intent.intentID}`).digest("hex").slice(0, 16)}`
      candidates.push({
        schemaVersion: "retrieval_candidate_v1", candidateID, paperID: card.paperID, intentID: intent.intentID,
        queryText: intent.paperLanguageQuery.queryText, recallRoute: "knowledge_store", recallScore: knowledgeSelectionScore(binding.score, card.confidence),
        // This route uses card/intent matching. No BM25 measurement or local PDF is claimed.
        bm25: { rank: candidates.length + 1, score: 0, matchedFields: ["knowledgeCard"], matchedTerms: [...binding.matchedTerms] },
        evidenceLevel: "paper_backed", localPDF: false, publicationStatus: "unknown",
        decision: blocked ? "unsupported_model_recipe" : "reuse_knowledge", decisionReasons: [
          `Stored card ${card.knowledgeID}@${card.revision}; source extraction ${card.provenance.extractionRunID}`,
          ...binding.reasons, `Selection: 0.9 * relevance ${binding.score} + 0.1 * confidence ${card.confidence}`, `Current-task applicability: ${applicability.status}`,
          ...unsupported.map((item) => `ModelRecipe has no ${item.missingAction} action for ${item.mechanism}`),
          ...(review ? [`source-hash-bound compatibility review ${review.verdict}: ${review.reason}`] : []),
        ],
      })
      if (blocked) continue
      const paper = papers.get(card.paperID) ?? {
        paperID: card.paperID, intentIDs: [], candidateIDs: [], status: "reused_knowledge" as const,
        acceptedCardIDs: [], cardRevisions: {}, rejectedCandidateCount: 0, warningCount: 0,
      }
      if (!paper.intentIDs.includes(intent.intentID)) paper.intentIDs.push(intent.intentID)
      paper.candidateIDs.push(candidateID)
      if (!paper.acceptedCardIDs.includes(card.knowledgeID)) paper.acceptedCardIDs.push(card.knowledgeID)
      paper.cardRevisions![card.knowledgeID] = card.revision
      papers.set(card.paperID, paper)
      if (applicability.status !== "conflicted" && !card.support.some((item) => item.relation === "refutes")) {
        coveredPaperIntents.add(`${card.paperID}\0${intent.intentID}`)
      }
    }
  }
  return { candidates, papers: [...papers.values()], coveredPaperIntents }
}
