import aliases from "./config/tsf-task-evidence.v1.json" with { type: "json" }
import { includesPhrase } from "./bm25-search"
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
  probabilistic = false,
): RetrievalCandidate[] {
  const phenomenon = normalized(intent.paperLanguageQuery.phenomenonTerms)
  const methods = normalized(intent.paperLanguageQuery.methodTerms)
  let selected = 0
  const extra = Object.entries(aliases.aliases).flatMap(([key, values]) =>
    intent.intentID.startsWith(`intent_${key}_`) || [key.replaceAll("_", " "), ...values].some((term) => phenomenon.includes(term) || methods.includes(term)) ? values : [])
  const reviewed = results.map((result) => {
    const scientificTerms = [...phenomenon, ...methods, ...extra]
    const titleMatches = scientificTerms.filter((term) => includesPhrase(result.paper.title, term))
    const source = [result.paper.fields.abstract, result.paper.fields.introduction, result.paper.fields.method].join("\n")
    const sourceMatches = scientificTerms.filter((term) => includesPhrase(source, term))
    const auxiliary = !probabilistic && /conformal|prediction intervals|uncertainty quantification/i.test(result.paper.title)
    return { result, titleMatches, sourceMatches, auxiliary,
      relevance: (titleMatches.length ? 10 : 0) + Math.min(sourceMatches.length, 5) - (auxiliary ? 20 : 0) }
  }).toSorted((a, b) => b.relevance - a.relevance || a.result.rank - b.result.rank)
  return reviewed.map(({ result, titleMatches, sourceMatches, auxiliary }) => {
    const scientificOrMethodMatch = titleMatches.length > 0 || sourceMatches.length > 0
    let decision: RetrievalCandidate["decision"] = "retain_candidate"
    const decisionReasons: string[] = [`BM25 rank ${result.rank} for ${intent.intentID}`]
    decisionReasons.push(`screening_v2: title matches [${titleMatches.join(", ")}]; source matches [${sourceMatches.join(", ")}]`)
    if (result.paper.previewError) decisionReasons.push(`preview unavailable: ${result.paper.previewError}`)
    if (auxiliary) decisionReasons.push("auxiliary: interval/calibration objective differs from point forecasting")
    if (!result.paper.localPDF) {
      decision = "skipped_pdf_unavailable"
      decisionReasons.push("local PDF unavailable")
      if (!scientificOrMethodMatch) decisionReasons.push("no scientific or method phrase matched")
    } else if (!scientificOrMethodMatch) {
      decision = "domain_only"
      decisionReasons.push("no scientific or method phrase matched")
    } else if (auxiliary) {
      decisionReasons.push("retained as auxiliary; not consuming mechanism reading quota")
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
  const ranked = [...grouped.values()]
    .toSorted((left, right) => left.bm25Rank - right.bm25Rank || right.bm25Score - left.bm25Score || left.paperID.localeCompare(right.paperID))
  const selected: typeof ranked = []
  const intentIDs = [...new Set(candidates.filter((item) => item.decision === "send_to_literature_agent").map((item) => item.intentID))]
  while (selected.length < budgets.maxLiteraturePapersTotal) {
    let added = false
    for (const intentID of intentIDs) {
      if (selected.length >= budgets.maxLiteraturePapersTotal) break
      // Preserve the scientific re-ranking from buildRetrievalCandidates.
      const next = candidates.find((item) => item.intentID === intentID && item.decision === "send_to_literature_agent" && !selected.some((paper) => paper.paperID === item.paperID))
      if (!next) continue
      selected.push(grouped.get(next.paperID)!)
      added = true
    }
    if (!added) break
  }
  return selected
}
