import paperLanguageConfig from "./config/tsf-paper-language.v1.json" with { type: "json" }
import type { DatasetQuantitativeAnalysis, MethodConcept } from "./contract"
import type { ScientificConceptMapping } from "./scientific-concept-mapper"

function unique(values: readonly string[]) {
  return [...new Set(values.map((item) => item.trim().toLowerCase()).filter(Boolean))]
}

function assertPaperLanguage(queryText: string) {
  const forbidden = [
    /(?:strength|score|ratio|statistic|correlation)\s*=/i,
    /\b(?:seasonalityStrength|distributionShift|spectralPeaks|knownFutureCovariates|crossVarCorrelation)\b/i,
    /\b0\.\d+\b/,
  ]
  if (forbidden.some((pattern) => pattern.test(queryText))) throw new Error("Query contains internal metric language")
}

export function translateToPaperLanguage(input: {
  readonly report: DatasetQuantitativeAnalysis
  readonly scientific: ScientificConceptMapping
  readonly methods: readonly MethodConcept[]
}) {
  const taskTerms = [...paperLanguageConfig.taskTerms]
  const phenomenonTerms = unique(input.scientific.paperTerms)
  const methodTerms = unique(input.methods.flatMap((item) => item.paperTerms)).slice(0, 4)
  const normalizedDomain = input.report.domain.replace(/[_-]+/g, " ").trim().toLowerCase()
  const domainTerms = normalizedDomain && !["tsf", "time series forecasting", "unknown"].includes(normalizedDomain)
    ? [normalizedDomain]
    : []
  const queryText = unique([...taskTerms, ...phenomenonTerms, ...methodTerms, ...domainTerms]).join(" ")
  assertPaperLanguage(queryText)
  return { taskTerms, phenomenonTerms, methodTerms, domainTerms, queryText }
}

export const PAPER_LANGUAGE_MAPPING_VERSION = paperLanguageConfig.schemaVersion
