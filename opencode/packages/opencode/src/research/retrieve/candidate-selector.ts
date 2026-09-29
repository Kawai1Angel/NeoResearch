import aliases from "./config/tsf-task-evidence.v1.json" with { type: "json" }
import { includesPhrase } from "./bm25-search"
import { createHash } from "crypto"
import { RetrievalCandidateSchema, type RetrievalBudgets, type RetrievalCandidate, type RetrievalIntent } from "./contract"
import type { BM25SearchResult } from "./bm25-search"
import { CLASSIC_PAPERS, classicPaperName } from "./classic-library"
import { unsupportedModelRecipeMechanisms } from "./model-recipe-screen"

export const CLASSIC_COMPONENT_MAPPING_VERSION = "classic_component_mapping_v1"
export const PDF_IDENTITY_SCREEN_VERSION = "pdf_title_identity_screen_v1"
export const COMPATIBILITY_REVIEW_VERSION = "model_recipe_compatibility_review_v1"
export const PAPER_SCOPE_SCREEN_VERSION = "paper_scope_screen_v1"

const DOMAIN_TITLE_PATTERNS = [
  /\b(?:stock|equity|portfolio|financial market|stock returns?)\b/i,
  /\b(?:traffic|road network|transportation network|telecommunication|wireless network)\b/i,
  /\b(?:job skill|employment demand|labor market)\b/i,
  /\b(?:weather|climate|solar|wind power|electricity load|power demand)\b/i,
  /\b(?:medical|healthcare|disease|epidemic)\b/i,
] as const

export function paperScope(title: string): "general" | "domain_specific" {
  return DOMAIN_TITLE_PATTERNS.some((pattern) => pattern.test(title)) ? "domain_specific" : "general"
}

export type ModelRecipeCompatibilityReview = {
  readonly paperID: string
  readonly sourceSha256: string
  readonly verdict: "direct" | "adaptable" | "research_only" | "exclude"
  readonly reason: string
}

function pdfTitleMismatch(paper: BM25SearchResult["paper"]) {
  if (!paper.localPDF || paper.fields.introduction.length < 500) return false
  const stop = new Set(["with", "from", "time", "series", "forecasting", "model", "models", "learning", "based", "long", "term", "deep", "using"])
  const tokens = (text: string) => new Set((text.toLowerCase().replaceAll(/[‐–—]/g, "-").match(/[a-z0-9]+/g) ?? [])
    .filter((word) => word.length >= 4 && !stop.has(word)))
  const title = tokens(paper.title)
  if (title.size < 4) return false
  const preview = tokens(paper.fields.introduction.slice(0, 3000))
  return [...title].filter((word) => preview.has(word)).length / title.size < 0.2
}

const CLASSIC_INTENT_COMPONENTS: Record<string, readonly string[]> = {
  lead_lag_relationship: ["fusion.variate_attention"],
  potential_structural_break: ["preprocessing.instance_norm"],
  long_horizon_dependency: ["embedding.patch", "backbone.dlinear", "backbone.mlp", "backbone.nbeats", "backbone.mixer"],
  multiple_seasonalities: ["backbone.timesblock_encoder", "backbone.timesnet_lite", "embedding.frequency", "backbone.nbeats"],
  trend_dynamics: ["preprocessing.series_decomposition", "backbone.dlinear", "backbone.nbeats"],
}

function classicComponentMatches(intent: RetrievalIntent, result: BM25SearchResult) {
  if (result.recallRoute !== "classic_library") return []
  const name = classicPaperName(result.paper)
  const paper = CLASSIC_PAPERS.find((item) => item.name === name)
  const intentKey = Object.keys(CLASSIC_INTENT_COMPONENTS).find((key) => intent.intentID.startsWith(`intent_${key}_`))
  if (!paper || !intentKey) return []
  const expected = CLASSIC_INTENT_COMPONENTS[intentKey]!
  return paper.recipeComponents.filter((component) => expected.includes(component))
}

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
  compatibilityReviews: readonly ModelRecipeCompatibilityReview[] = [],
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
    const componentMatches = classicComponentMatches(intent, result)
    const auxiliary = !probabilistic && /conformal|prediction intervals|uncertainty quantification/i.test(result.paper.title)
    const compatibility = compatibilityReviews.find((review) => review.paperID === result.paper.paperID &&
      review.sourceSha256 === result.paper.sourceSha256)
    const transferable = compatibility?.verdict === "direct" || compatibility?.verdict === "adaptable"
    const rejectedByReview = compatibility?.verdict === "research_only" || compatibility?.verdict === "exclude"
    return { result, titleMatches, sourceMatches, componentMatches, auxiliary,
      scope: paperScope(result.paper.title),
      identityMismatch: pdfTitleMismatch(result.paper),
      unsupported: unsupportedModelRecipeMechanisms(result.paper),
      compatibility, transferable, rejectedByReview,
      relevance: (titleMatches.length ? 10 : 0) + Math.min(sourceMatches.length, 5) +
        (componentMatches.length ? 5 : 0) - (auxiliary ? 20 : 0) }
  }).toSorted((a, b) => Number(a.scope === "domain_specific") - Number(b.scope === "domain_specific") ||
    b.relevance - a.relevance || a.result.rank - b.result.rank)
  const eligibleBasic = (item: typeof reviewed[number]) => item.result.paper.localPDF &&
    (item.titleMatches.length > 0 || item.sourceMatches.length > 0 || item.componentMatches.length > 0) &&
    !item.auxiliary && !item.identityMismatch && !item.rejectedByReview &&
    (item.unsupported.length === 0 || item.transferable)
  const generalAvailable = reviewed.some((item) => item.scope === "general" && eligibleBasic(item))
  const eligible = (item: typeof reviewed[number]) => eligibleBasic(item) &&
    (item.scope === "general" || !generalAvailable)
  const sourceAvailable = reviewed.some((item) => eligible(item) && item.result.recallRoute !== "classic_library")
  const classicAvailable = reviewed.some((item) => eligible(item) && item.result.recallRoute === "classic_library")
  let selectedSource = 0
  let selectedClassic = 0
  return reviewed.map(({ result, titleMatches, sourceMatches, componentMatches, auxiliary, scope, identityMismatch, unsupported, compatibility, transferable, rejectedByReview }) => {
    const scientificOrMethodMatch = titleMatches.length > 0 || sourceMatches.length > 0 || componentMatches.length > 0
    const classic = result.recallRoute === "classic_library"
    let decision: RetrievalCandidate["decision"] = "retain_candidate"
    const decisionReasons: string[] = [`${classic ? "classic library" : "source catalog"} BM25 rank ${result.rank} for ${intent.intentID}`]
    decisionReasons.push(`screening_v2: title matches [${titleMatches.join(", ")}]; source matches [${sourceMatches.join(", ")}]`)
    if (componentMatches.length) decisionReasons.push(`ModelRecipe component matches [${componentMatches.join(", ")}]`)
    if (compatibility) decisionReasons.push(`source-hash-bound compatibility review ${compatibility.verdict}: ${compatibility.reason}`)
    if (unsupported.length && transferable) decisionReasons.push(...unsupported.map((item) =>
      `exact ${item.mechanism} remains unavailable in ModelRecipe; retained for transferable knowledge`))
    if (result.paper.previewError) decisionReasons.push(`preview unavailable: ${result.paper.previewError}`)
    if (auxiliary) decisionReasons.push("auxiliary: interval/calibration objective differs from point forecasting")
    if (identityMismatch) {
      decision = "skipped_pdf_unavailable"
      decisionReasons.push("local PDF identity mismatch: its first-page text does not match the catalog title")
    } else if (rejectedByReview) {
      decision = "unsupported_model_recipe"
      decisionReasons.push("compatibility review found no transferable ModelRecipe mechanism or task evaluation lesson")
      decisionReasons.push(...unsupported.map((item) => `ModelRecipe has no equivalent ${item.missingAction} action for ${item.mechanism}`))
    } else if (unsupported.length && !transferable) {
      decision = "unsupported_model_recipe"
      decisionReasons.push(...unsupported.map((item) => `ModelRecipe has no equivalent ${item.missingAction} action for ${item.mechanism}`))
    } else if (!result.paper.localPDF) {
      decision = "skipped_pdf_unavailable"
      decisionReasons.push("local PDF unavailable")
      if (!scientificOrMethodMatch) decisionReasons.push("no scientific or method phrase matched")
    } else if (!scientificOrMethodMatch) {
      decision = "domain_only"
      decisionReasons.push("no scientific or method phrase matched")
    } else if (auxiliary) {
      decisionReasons.push("retained as auxiliary; not consuming mechanism reading quota")
    } else if (scope === "domain_specific" && generalAvailable) {
      decision = "domain_specific"
      decisionReasons.push("domain-specific paper deferred because an eligible general forecasting paper covers this intent")
    } else if (selected < maxLiteraturePapersPerIntent &&
      (maxLiteraturePapersPerIntent === 1 || (classic
        ? selectedClassic < maxLiteraturePapersPerIntent - (sourceAvailable ? 1 : 0)
        : selectedSource < maxLiteraturePapersPerIntent - (classicAvailable ? 1 : 0)))) {
      selected += 1
      if (classic) selectedClassic += 1
      else selectedSource += 1
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
      recallRoute: result.recallRoute ?? "source_catalog",
      paperScope: scope,
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
  const selected: Array<NonNullable<ReturnType<typeof grouped.get>>> = []
  for (const scope of ["general", "domain_specific"] as const) {
    const scoped = candidates.filter((item) => item.decision === "send_to_literature_agent" &&
      (item.paperScope ?? "general") === scope)
    const intentIDs = [...new Set(scoped.map((item) => item.intentID))]
    if (selected.length + 2 <= budgets.maxLiteraturePapersTotal) {
      // Preserve both recall routes within each scope when there is room.
      for (const route of ["source_catalog", "classic_library"] as const) {
        const candidate = scoped.find((item) => (item.recallRoute ?? "source_catalog") === route &&
          !selected.some((paper) => paper.paperID === item.paperID))
        if (candidate) selected.push(grouped.get(candidate.paperID)!)
      }
    }
    while (selected.length < budgets.maxLiteraturePapersTotal) {
      let added = false
      for (const intentID of intentIDs) {
        if (selected.length >= budgets.maxLiteraturePapersTotal) break
        const next = scoped.find((item) => item.intentID === intentID &&
          !selected.some((paper) => paper.paperID === item.paperID))
        if (!next) continue
        selected.push(grouped.get(next.paperID)!)
        added = true
      }
      if (!added) break
    }
  }
  return selected
}
