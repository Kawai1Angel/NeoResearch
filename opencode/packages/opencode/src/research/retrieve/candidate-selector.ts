import { createHash } from "crypto"
import { RetrievalCandidateSchema, type RetrievalBudgets, type RetrievalCandidate, type RetrievalIntent } from "./contract"
import type { BM25SearchResult } from "./bm25-search"

function candidateID(intentID: string, paperID: string) {
  return `rc_${createHash("sha256").update(`${intentID}\0${paperID}`).digest("hex").slice(0, 16)}`
}

function normalized(values: readonly string[]) {
  return values.map((item) => item.toLowerCase())
}

export function buildRetrievalCandidates(
  intent: RetrievalIntent,
  results: readonly BM25SearchResult[],
  maxLiteraturePapersPerIntent: number,
): RetrievalCandidate[] {
  const phenomenon = normalized(intent.paperLanguageQuery.phenomenonTerms)
  const methods = normalized(intent.paperLanguageQuery.methodTerms)
  let selected = 0
  return results.map((result) => {
    const matched = normalized(result.matchedTerms)
    const scientificOrMethodMatch = matched.some((term) => phenomenon.includes(term) || methods.includes(term))
    let decision: RetrievalCandidate["decision"] = "retain_candidate"
    const decisionReasons: string[] = [`BM25 rank ${result.rank} for ${intent.intentID}`]
    if (!result.paper.localPDF) {
      decision = "skipped_pdf_unavailable"
      decisionReasons.push("local PDF unavailable")
      if (!scientificOrMethodMatch) decisionReasons.push("no scientific or method phrase matched")
    } else if (!scientificOrMethodMatch) {
      decision = "domain_only"
      decisionReasons.push("no scientific or method phrase matched")
    } else if (selected < maxLiteraturePapersPerIntent) {
      selected += 1
      decision = "send_to_literature_agent"
      decisionReasons.push("local PDF is available within the per-intent budget")
    } else {
      decisionReasons.push("retained outside the per-intent LiteratureAgent budget")
    }
    return RetrievalCandidateSchema.parse({
      schemaVersion: "retrieval_candidate_v1",
      candidateID: candidateID(intent.intentID, result.paper.paperID),
      paperID: result.paper.paperID,
      intentID: intent.intentID,
      queryText: intent.paperLanguageQuery.queryText,
      bm25: { rank: result.rank, score: result.score, matchedFields: result.matchedFields, matchedTerms: result.matchedTerms },
      evidenceLevel: result.paper.evidenceLevel,
      localPDF: result.paper.localPDF,
      publicationStatus: result.paper.publicationStatus,
      decision,
      decisionReasons,
    })
  })
}

export function selectBridgeCandidates(
  candidates: readonly RetrievalCandidate[],
  budgets: Pick<RetrievalBudgets, "maxLiteraturePapersTotal">,
) {
  const grouped = new Map<string, {
    paperID: string
    intentIDs: string[]
    candidateIDs: string[]
    bm25Rank: number
    bm25Score: number
  }>()
  for (const candidate of candidates.filter((item) => item.decision === "send_to_literature_agent")) {
    const existing = grouped.get(candidate.paperID)
    if (existing) {
      if (!existing.intentIDs.includes(candidate.intentID)) existing.intentIDs.push(candidate.intentID)
      if (!existing.candidateIDs.includes(candidate.candidateID)) existing.candidateIDs.push(candidate.candidateID)
      existing.bm25Rank = Math.min(existing.bm25Rank, candidate.bm25.rank)
      existing.bm25Score = Math.max(existing.bm25Score, candidate.bm25.score)
    } else {
      grouped.set(candidate.paperID, {
        paperID: candidate.paperID,
        intentIDs: [candidate.intentID],
        candidateIDs: [candidate.candidateID],
        bm25Rank: candidate.bm25.rank,
        bm25Score: candidate.bm25.score,
      })
    }
  }
  return [...grouped.values()]
    .toSorted((left, right) => left.bm25Rank - right.bm25Rank || right.bm25Score - left.bm25Score || left.paperID.localeCompare(right.paperID))
    .slice(0, budgets.maxLiteraturePapersTotal)
}
