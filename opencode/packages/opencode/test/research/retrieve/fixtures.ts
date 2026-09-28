import { card } from "../literature/fixtures"
import type { CardRelation, KnowledgeCard } from "../../../src/research/literature/contract"
import {
  DEFAULT_RETRIEVAL_BUDGETS,
  DatasetQuantitativeAnalysisSchema,
  buildConceptTransformations,
  buildRetrievalIntents,
  buildTaskEvidence,
  extractDatasetEvidence,
  mapScientificConcepts,
  normalizeRetrieveTaskContext,
  type DatasetQuantitativeAnalysis,
  type RetrievalCandidate,
  type RetrieveLiteratureBridgeResult,
} from "../../../src/research/retrieve"

export function report(): DatasetQuantitativeAnalysis {
  return DatasetQuantitativeAnalysisSchema.parse({
    schemaVersion: "dataset_quantitative_analysis_v1",
    taskID: "researchTask_evidence",
    domain: "electricity_load",
    dataset: {
      samplingFrequency: "hourly",
      targetColumns: ["load"],
      observedPastCovariates: ["temperature"],
      knownFutureCovariates: ["holiday"],
      staticCovariates: [],
    },
    forecast: { contextLength: 168, predictionLengths: [24, 168], horizonContextRatio: 1 },
    profile: {
      rowCount: 20_000,
      missingRate: 0,
      trendStrength: 0.63,
      seasonalityStrength: 0.91,
      crossVarCorrelation: 0.52,
      distributionShift: 0.44,
      outlierRate: 0.02,
      irregularIntervalRatio: 0,
    },
    statistics: {
      stationarity: { adfStationary: false, kpssStationary: false },
      acf: { topLag: 24, topCorrelation: 0.88 },
      decomposition: { period: 24 },
      frequency: {
        dominantPeriod: 24,
        dominantPowerShare: 0.49,
        spectralPeaks: [
          { period: 24, powerShare: 0.49, significant: true },
          { period: 168, powerShare: 0.21, significant: true },
        ],
      },
      changepoint: { index: 12_600, score: 0.68, severity: "medium" },
      crossLag: { source: "temperature", target: "load", lag: 2, correlation: 0.58 },
    },
    warnings: [],
    sourceArtifactIDs: ["researchArtifact_quantitative"],
  })
}

export function frequencyCard(overrides: Partial<KnowledgeCard> = {}) {
  return card({
    paperID: "paper-frequency",
    cardType: "model_mechanism",
    claim: "Frequency-domain modeling captures multiple seasonalities in time series forecasting.",
    normalizedClaim: { subject: "multiple_seasonalities", predicate: "uses", object: "frequency_domain_modeling" },
    problem: "Multiple seasonal periods coexist in the input series.",
    provenance: { ...card().provenance, verifierPromptVersion: "evidence_verifier_v3" },
    mechanism: {
      mechanismID: "mechanism_frequency",
      name: "frequency multi-scale modeling",
      principle: "Represent spectral peaks at several periods.",
      components: ["frequency decomposition", "multi-scale aggregation"],
    },
    applicability: {
      taskTypes: ["forecasting"],
      dataFeatures: ["multiple_seasonalities"],
      domains: [],
      dataScale: [],
      horizonProfile: ["long_horizon"],
      computeProfile: [],
      basis: "author_experiment",
    },
    tags: ["multiple_seasonalities", "frequency_multiscale"],
    ...overrides,
  })
}

export function fixture(input?: {
  semanticGroups?: { cardIDs: string[]; rationale: string }[]
  cards?: KnowledgeCard[]
  acceptedCardIDs?: string[]
  relations?: CardRelation[]
  candidates?: RetrievalCandidate[]
  budgets?: Partial<typeof DEFAULT_RETRIEVAL_BUDGETS>
}) {
  const quantitative = report()
  const transformations = buildConceptTransformations(
    quantitative,
    mapScientificConcepts(quantitative, extractDatasetEvidence(quantitative)),
  )
  const intents = buildRetrievalIntents(transformations, 6)
  const cards = input?.cards ?? [frequencyCard()]
  const candidateValues = input?.candidates ?? intents.map((intent, index): RetrievalCandidate => ({
    schemaVersion: "retrieval_candidate_v1",
    candidateID: `rc_${(index + 1).toString(16).padStart(16, "0")}`,
    paperID: "paper-frequency",
    intentID: intent.intentID,
    queryText: intent.paperLanguageQuery.queryText,
    bm25: { rank: index + 1, score: 999 - index, matchedFields: ["title"], matchedTerms: [] },
    evidenceLevel: "document_available",
    localPDF: true,
    publicationStatus: "peer_reviewed",
    decision: "send_to_literature_agent",
    decisionReasons: [],
  }))
  const literatureResults: RetrieveLiteratureBridgeResult["papers"] = [{
    paperID: "paper-frequency",
    intentIDs: intents.map((intent) => intent.intentID),
    candidateIDs: candidateValues.map((candidate) => candidate.candidateID),
    status: "completed",
    literatureRunID: "lerun_fixture",
    acceptedCardIDs: input?.acceptedCardIDs ?? cards.map((value) => value.cardID),
    rejectedCandidateCount: 0,
    warningCount: 0,
  }]
  const byID = new Map(cards.map((value) => [value.cardID, value]))
  const taskContext = normalizeRetrieveTaskContext(quantitative).context
  return {
    quantitative,
    transformations,
    intents,
    candidates: candidateValues,
    literatureResults,
    taskContext,
    build: () => buildTaskEvidence({
      semanticGroups: input?.semanticGroups,
      paperTitles: { "paper-frequency": "Frequency Study" },
      retrieveRunID: "retrieve_fixture",
      quantitativeReportArtifactID: "researchArtifact_quantitative",
      report: quantitative,
      taskContext,
      transformations,
      intents,
      candidates: candidateValues,
      literatureResults,
      knowledgeSource: {
        getCard: (cardID) => byID.get(cardID),
        listRelations: () => input?.relations ?? [],
      },
      budgets: { ...DEFAULT_RETRIEVAL_BUDGETS, ...input?.budgets },
    }),
  }
}
