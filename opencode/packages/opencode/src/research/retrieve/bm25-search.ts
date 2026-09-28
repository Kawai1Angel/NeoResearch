import type { RetrievalIntent } from "./contract"
import type { IndexedPaper, LocalRetrievalIndex } from "./local-index-builder"

const FIELD_WEIGHTS = {
  title: 4,
  abstract: 3,
  knowledgeCard: 3,
  method: 2,
  introduction: 1.5,
  results: 1.5,
  limitations: 1,
} as const

type IndexedField = keyof typeof FIELD_WEIGHTS

export type BM25SearchResult = {
  readonly paper: IndexedPaper
  readonly recallRoute?: "source_catalog" | "classic_library"
  readonly rank: number
  readonly score: number
  readonly matchedFields: readonly IndexedField[]
  readonly matchedTerms: readonly string[]
}

export function normalizeRetrievalTokens(value: string): string[] {
  return [...(value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
}

function frequencies(tokens: readonly string[]) {
  const result = new Map<string, number>()
  for (const token of tokens) result.set(token, (result.get(token) ?? 0) + 1)
  return result
}

function queryPhrases(intent: RetrievalIntent) {
  const language = intent.paperLanguageQuery
  return [...new Set([...language.taskTerms, ...language.phenomenonTerms, ...language.methodTerms, ...language.domainTerms].map((item) => item.toLowerCase()))]
}

export function includesPhrase(field: string, phrase: string) {
  const singular = (value: string) => ["points", "breaks", "shifts", "correlations"].includes(value) ? value.slice(0, -1) : value
  const text = ` ${normalizeRetrievalTokens(field).map(singular).join(" ")} `
  const words = normalizeRetrievalTokens(phrase).map(singular)
  return words.length > 0 && text.includes(` ${words.join(" ")} `)
}

export function searchBM25(
  index: Pick<LocalRetrievalIndex, "documents">,
  intent: RetrievalIntent,
  topK = 20,
): BM25SearchResult[] {
  if (!Number.isInteger(topK) || topK < 1) throw new Error("topK must be a positive integer")
  const queryTokens = [...new Set(normalizeRetrievalTokens(intent.paperLanguageQuery.queryText))]
  const fields = Object.keys(FIELD_WEIGHTS) as IndexedField[]
  const tokenized = index.documents.map((document) => ({
    document,
    fields: Object.fromEntries(fields.map((field) => [field, normalizeRetrievalTokens(document.fields[field])])) as unknown as Record<IndexedField, string[]>,
  }))
  const documentCount = Math.max(1, tokenized.length)
  const documentFrequency = new Map(queryTokens.map((term) => [term, tokenized.filter((document) => fields.some((field) => document.fields[field].includes(term))).length]))
  const averageLengths = Object.fromEntries(fields.map((field) => [field, tokenized.length === 0 ? 1 : tokenized.reduce((sum, document) => sum + document.fields[field].length, 0) / tokenized.length || 1])) as Record<IndexedField, number>
  const k1 = 1.2
  const b = 0.75
  const phrases = queryPhrases(intent)
  const scored = tokenized.map(({ document, fields: documentFields }) => {
    let score = 0
    const matchedFields = new Set<IndexedField>()
    for (const field of fields) {
      const fieldFrequencies = frequencies(documentFields[field])
      const length = documentFields[field].length
      for (const term of queryTokens) {
        const tf = fieldFrequencies.get(term) ?? 0
        if (tf === 0) continue
        matchedFields.add(field)
        const df = documentFrequency.get(term) ?? 0
        const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5))
        const normalizedTF = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * length / averageLengths[field]))
        score += FIELD_WEIGHTS[field] * idf * normalizedTF
      }
    }
    const matchedTerms = phrases.filter((phrase) => fields.some((field) => includesPhrase(document.fields[field], phrase)))
    return { document, score, matchedFields: [...matchedFields], matchedTerms }
  })
  return scored
    .filter((item) => item.score > 0)
    .toSorted((left, right) => right.score - left.score || left.document.paperID.localeCompare(right.document.paperID))
    .slice(0, topK)
    .map((item, indexValue) => ({
      paper: item.document,
      rank: indexValue + 1,
      score: Number(item.score.toFixed(6)),
      matchedFields: item.matchedFields,
      matchedTerms: item.matchedTerms,
    }))
}
