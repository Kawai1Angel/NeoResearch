import z from "zod"
import { CARD_TYPES, MechanismSchema, KnowledgeCardSchema } from "../literature/contract"

const FiniteNumber = z.number().finite()

export const SpectralPeakSchema = z.object({
  period: FiniteNumber.positive(),
  powerShare: FiniteNumber.min(0).max(1),
  significant: z.boolean(),
  stabilityAcrossWindows: FiniteNumber.min(0).max(1).optional(),
}).strict()
export type SpectralPeak = z.infer<typeof SpectralPeakSchema>

export const DatasetQuantitativeAnalysisSchema = z.object({
  schemaVersion: z.literal("dataset_quantitative_analysis_v1"),
  taskID: z.string().min(1),
  domain: z.string().min(1),
  dataset: z.object({
    samplingFrequency: z.string().min(1),
    targetColumns: z.array(z.string()),
    observedPastCovariates: z.array(z.string()),
    knownFutureCovariates: z.array(z.string()),
    staticCovariates: z.array(z.string()),
  }).strict(),
  forecast: z.object({
    contextLength: z.number().int().positive(),
    predictionLengths: z.array(z.number().int().positive()).min(1),
    horizonContextRatio: FiniteNumber.nonnegative(),
  }).strict(),
  profile: z.object({
    rowCount: z.number().int().nonnegative(),
    missingRate: FiniteNumber.min(0).max(1),
    trendStrength: FiniteNumber.nonnegative(),
    seasonalityStrength: FiniteNumber.nonnegative(),
    crossVarCorrelation: FiniteNumber.nonnegative(),
    distributionShift: FiniteNumber.nonnegative(),
    outlierRate: FiniteNumber.min(0).max(1),
    irregularIntervalRatio: FiniteNumber.min(0).max(1),
  }).strict(),
  statistics: z.object({
    stationarity: z.object({
      adfStatistic: FiniteNumber.optional(),
      adfStationary: z.boolean().optional(),
      kpssStatistic: FiniteNumber.optional(),
      kpssStationary: z.boolean().optional(),
    }).strict(),
    acf: z.object({
      topLag: z.number().int().positive().optional(),
      topCorrelation: FiniteNumber.optional(),
      pacfTopLag: z.number().int().positive().optional(),
      pacfTopCorrelation: FiniteNumber.optional(),
    }).strict(),
    decomposition: z.object({
      period: z.number().int().positive().optional(),
      trendVarianceShare: FiniteNumber.nonnegative().optional(),
      seasonalVarianceShare: FiniteNumber.nonnegative().optional(),
      residualVarianceShare: FiniteNumber.nonnegative().optional(),
    }).strict(),
    frequency: z.object({
      dominantPeriod: FiniteNumber.positive().optional(),
      dominantPowerShare: FiniteNumber.min(0).max(1).optional(),
      spectralPeaks: z.array(SpectralPeakSchema),
    }).strict(),
    changepoint: z.object({
      index: z.number().int().nonnegative().optional(),
      score: FiniteNumber.nonnegative().optional(),
      severity: z.enum(["low", "medium", "high"]).optional(),
    }).strict(),
    crossLag: z.object({
      source: z.string().min(1).optional(),
      target: z.string().min(1).optional(),
      lag: z.number().int().optional(),
      correlation: FiniteNumber.optional(),
    }).strict(),
  }).strict(),
  warnings: z.array(z.string()),
  sourceArtifactIDs: z.array(z.string()),
}).strict()
export type DatasetQuantitativeAnalysis = z.infer<typeof DatasetQuantitativeAnalysisSchema>

export const RetrieveTaskContextSchema = z.object({
  taskType: z.string().min(1),
  domain: z.string().min(1),
  objective: z.object({
    primaryMetric: z.string().min(1).optional(),
    probabilistic: z.boolean(),
  }).strict(),
  constraints: z.object({
    computeProfile: z.enum(["low", "medium", "high", "unknown"]),
    latencyBudget: FiniteNumber.positive().optional(),
    parameterBudget: FiniteNumber.positive().optional(),
  }).strict(),
}).strict()
export type RetrieveTaskContext = z.infer<typeof RetrieveTaskContextSchema>

export const DatasetEvidenceSchema = z.object({
  path: z.string().startsWith("$.").min(3),
  metric: z.string().min(1),
  value: z.unknown(),
  interpretation: z.string().min(1),
}).strict()
export type DatasetEvidence = z.infer<typeof DatasetEvidenceSchema>

export const ScientificConceptSchema = z.object({
  conceptID: z.string().min(1),
  label: z.string().min(1),
  paperTerms: z.array(z.string().min(1)).min(1),
  confidence: FiniteNumber.min(0).max(1),
  basis: z.enum(["deterministic_rule", "llm_supported"]),
}).strict()

export const MethodConceptSchema = z.object({
  conceptID: z.string().min(1),
  label: z.string().min(1),
  paperTerms: z.array(z.string().min(1)).min(1),
  rationale: z.string().min(1),
  status: z.literal("retrieval_hypothesis"),
}).strict()
export type MethodConcept = z.infer<typeof MethodConceptSchema>

const PaperLanguageSchema = z.object({
  taskTerms: z.array(z.string()),
  phenomenonTerms: z.array(z.string()),
  methodTerms: z.array(z.string()),
  domainTerms: z.array(z.string()),
  queryText: z.string().min(1),
}).strict()

export const ConceptTransformationSchema = z.object({
  transformationID: z.string().min(1),
  datasetEvidence: z.array(DatasetEvidenceSchema).min(1),
  scientificConcepts: z.array(ScientificConceptSchema).min(1),
  modelingChallenges: z.array(z.string()),
  methodConcepts: z.array(MethodConceptSchema),
  paperLanguage: PaperLanguageSchema,
}).strict()
export type ConceptTransformation = z.infer<typeof ConceptTransformationSchema>

export const RetrievalIntentSchema = z.object({
  intentID: z.string().min(1),
  question: z.string().min(1),
  transformationID: z.string().min(1),
  priority: FiniteNumber.min(0).max(1),
  mustCover: z.boolean(),
  paperLanguageQuery: PaperLanguageSchema,
}).strict()
export type RetrievalIntent = z.infer<typeof RetrievalIntentSchema>

export const RetrievalCandidateSchema = z.object({
  schemaVersion: z.literal("retrieval_candidate_v1"),
  candidateID: z.string().regex(/^rc_[a-f0-9]{16}$/),
  paperID: z.string().min(1),
  intentID: z.string().min(1),
  queryText: z.string().min(1),
  recallRoute: z.enum(["source_catalog", "classic_library"]).optional(),
  bm25: z.object({
    rank: z.number().int().positive(),
    score: FiniteNumber.nonnegative(),
    matchedFields: z.array(z.string()),
    matchedTerms: z.array(z.string()),
  }).strict(),
  evidenceLevel: z.enum(["metadata_only", "document_available", "paper_backed"]),
  localPDF: z.boolean(),
  publicationStatus: z.string(),
  decision: z.enum(["send_to_literature_agent", "retain_candidate", "domain_only", "skipped_pdf_unavailable", "unsupported_model_recipe"]),
  decisionReasons: z.array(z.string()),
}).strict()
export type RetrievalCandidate = z.infer<typeof RetrievalCandidateSchema>

export const RetrieveLiteratureBridgeInputSchema = z.object({
  retrieveRunID: z.string().min(1),
  candidates: z.array(z.object({
    paperID: z.string().min(1),
    intentIDs: z.array(z.string()).min(1),
    candidateIDs: z.array(z.string()).min(1),
    bm25Rank: z.number().int().positive(),
    bm25Score: FiniteNumber.nonnegative(),
  }).strict()),
  literatureOptions: z.object({
    includeAgentInference: z.literal(false),
    requireExactEvidenceSpan: z.literal(true),
    maxCardsPerPaper: z.number().int().positive(),
  }).strict(),
}).strict()
export type RetrieveLiteratureBridgeInput = z.infer<typeof RetrieveLiteratureBridgeInputSchema>

export const RetrieveLiteratureBridgeResultSchema = z.object({
  retrieveRunID: z.string().min(1),
  papers: z.array(z.object({
    paperID: z.string().min(1),
    intentIDs: z.array(z.string()),
    candidateIDs: z.array(z.string()),
    status: z.enum(["completed", "partial", "failed", "skipped_pdf_unavailable"]),
    literatureRunID: z.string().optional(),
    acceptedCardIDs: z.array(z.string()),
    rejectedCandidateCount: z.number().int().nonnegative(),
    warningCount: z.number().int().nonnegative(),
    reviewPath: z.string().optional(),
    error: z.string().optional(),
  }).strict()),
}).strict()
export type RetrieveLiteratureBridgeResult = z.infer<typeof RetrieveLiteratureBridgeResultSchema>

export const TASK_EVIDENCE_ROLES = [
  "supports_mechanism",
  "supports_applicability",
  "suggests_implementation",
  "defines_evaluation",
  "warns_limitation",
  "contradicts",
] as const
export const TaskEvidenceRoleSchema = z.enum(TASK_EVIDENCE_ROLES)
export type TaskEvidenceRole = z.infer<typeof TaskEvidenceRoleSchema>

export const TASK_EVIDENCE_EXCLUSION_REASONS = [
  "mechanism_incomplete", "card_validation_required",
  "card_not_found",
  "paper_mismatch",
  "status_not_eligible",
  "no_direct_exact_evidence",
  "no_intent_match",
  "hard_applicability_conflict",
  "duplicate_claim",
  "selection_budget",
] as const

export const TaskEvidenceEntrySchema = z.object({
  evidenceEntryID: z.string().regex(/^te_[a-f0-9]{16}$/),
  cardID: z.string().regex(/^kc_[a-f0-9]{12}$/),
  cardRevision: z.number().int().positive(),
  paperID: z.string().min(1),
  cardType: z.enum(CARD_TYPES),
  cardStatus: z.enum(["paper_backed", "corroborated", "contradicted"]),
  claim: z.string().min(1),
  paperTitle: z.string().optional(),
  problem: z.string().optional(),
  mechanism: MechanismSchema.optional(),
  mergedSources: z.array(z.object({
    cardID: z.string(), cardRevision: z.number().int().positive(),
    claim: z.string(), problem: z.string().optional(), mechanism: MechanismSchema.optional(),
    rationale: z.string(),
    applicability: KnowledgeCardSchema.shape.applicability.optional(),
    evidenceRefs: z.array(z.object({
      evidenceID: z.string(), chunkID: z.string(), evidenceSpan: z.string(),
      section: z.string(), pageStart: z.number(), pageEnd: z.number(),
    }).strict()),
  }).strict()).optional(),
  linkage: z.object({
    intentIDs: z.array(z.string()).min(1),
    candidateIDs: z.array(z.string()).min(1),
    transformationIDs: z.array(z.string()).min(1),
    conceptIDs: z.array(z.string()).min(1),
    methodConceptIDs: z.array(z.string()),
    datasetEvidencePaths: z.array(z.string().startsWith("$.")).min(1),
  }).strict(),
  roles: z.array(TaskEvidenceRoleSchema).min(1),
  relevance: z.object({
    score: FiniteNumber.min(0).max(1),
    matchedTerms: z.array(z.string()),
    reasons: z.array(z.string()).min(1),
  }).strict(),
  applicability: z.object({
    status: z.enum(["matched", "partial", "conflicted", "unknown"]),
    matchedConditions: z.array(z.string()),
    violatedConditions: z.array(z.string()),
    uncertainConditions: z.array(z.string()),
  }).strict(),
  evidenceRefs: z.array(z.object({
    evidenceID: z.string(),
    evidenceSpan: z.string().optional(),
    chunkID: z.string(),
    section: z.string(),
    pageStart: z.number().int().positive(),
    pageEnd: z.number().int().positive(),
    directness: z.enum(["direct", "indirect", "inferred"]),
    verification: z.enum(["exact_span", "normalized_span", "manual_required"]),
  }).strict()).min(1),
  limitations: z.array(z.string()),
  implementation: z.object({
    recipeConcepts: z.array(z.string()),
    registryMappings: z.array(z.string()),
    estimatedComplexity: z.enum(["low", "medium", "high", "unknown"]),
    notes: z.array(z.string()),
  }).strict().optional(),
  confidence: z.object({
    sourceQuality: FiniteNumber.min(0).max(1),
    extractionConfidence: FiniteNumber.min(0).max(1),
    evidenceDirectness: FiniteNumber.min(0).max(1),
    transferability: FiniteNumber.min(0).max(1),
  }).strict(),
}).strict()
export type TaskEvidenceEntry = z.infer<typeof TaskEvidenceEntrySchema>

export const ExcludedTaskEvidenceSchema = z.object({
  cardID: z.string(),
  paperID: z.string(),
  reasons: z.array(z.enum(TASK_EVIDENCE_EXCLUSION_REASONS)).min(1),
  detail: z.array(z.string()),
}).strict()
export type ExcludedTaskEvidence = z.infer<typeof ExcludedTaskEvidenceSchema>

export const TaskEvidenceBundleSchema = z.object({
  schemaVersion: z.literal("task_evidence_bundle_v1"),
  retrieveRunID: z.string(),
  taskID: z.string(),
  quantitativeReportArtifactID: z.string(),
  taskContextDigest: z.string().regex(/^[a-f0-9]{64}$/),
  readiness: z.enum(["ready_with_evidence", "ready_data_only", "partial_evidence", "evidence_conflict"]),
  mechanismRelations: z.array(z.object({
    parentCardID: z.string(), componentCardID: z.string(), rationale: z.string(),
  }).strict()).optional(),
  consolidation: z.object({
    version: z.string(), reviewedPapers: z.array(z.string()),
    failedPapers: z.array(z.string()), unavailablePapers: z.array(z.string()),
  }).strict().optional(),
  entries: z.array(TaskEvidenceEntrySchema),
  excluded: z.array(ExcludedTaskEvidenceSchema),
  conflicts: z.array(z.object({
    relationID: z.string(),
    sourceCardID: z.string(),
    targetCardID: z.string(),
    rationale: z.string(),
    confidence: FiniteNumber.min(0).max(1),
  }).strict()),
  gaps: z.array(z.object({
    intentID: z.string(),
    conceptIDs: z.array(z.string()),
    mustCover: z.boolean(),
    reason: z.enum(["no_candidate", "no_local_pdf", "literature_failed", "no_accepted_card", "no_eligible_card", "selection_budget"]),
  }).strict()),
  summary: z.object({
    acceptedCardCount: z.number().int().nonnegative(),
    selectedEntryCount: z.number().int().nonnegative(),
    excludedCardCount: z.number().int().nonnegative(),
    coveredIntentCount: z.number().int().nonnegative(),
    uncoveredMustCoverIntentCount: z.number().int().nonnegative(),
    conflictCount: z.number().int().nonnegative(),
  }).strict(),
}).strict().superRefine((bundle, ctx) => {
  const selected = new Set(bundle.entries.map((entry) => entry.cardID))
  const excluded = new Set(bundle.excluded.map((entry) => entry.cardID))
  const accepted = new Set([...selected, ...excluded])
  const issue = (message: string) => ctx.addIssue({ code: "custom", message })
  if (selected.size !== bundle.entries.length || excluded.size !== bundle.excluded.length || [...selected].some((id) => excluded.has(id))) {
    issue("Every accepted card must have exactly one selected or excluded disposition")
  }
  if (bundle.summary.selectedEntryCount !== bundle.entries.length || bundle.summary.excludedCardCount !== bundle.excluded.length ||
      bundle.summary.acceptedCardCount !== accepted.size || bundle.summary.conflictCount !== bundle.conflicts.length ||
      bundle.summary.uncoveredMustCoverIntentCount !== bundle.gaps.filter((gap) => gap.mustCover).length) {
    issue("Task evidence summary does not match its contents")
  }
  if ((bundle.readiness === "ready_data_only") !== (bundle.entries.length === 0)) issue("Task evidence readiness does not match selected entries")
  for (const conflict of bundle.conflicts) {
    if (!accepted.has(conflict.sourceCardID) || !accepted.has(conflict.targetCardID)) issue("Conflict references unknown card provenance")
  }
})
export type TaskEvidenceBundle = z.infer<typeof TaskEvidenceBundleSchema>

const RetrieveResultBaseSchema = z.object({
  retrieveRunID: z.string().min(1),
  taskID: z.string().min(1),
  quantitativeReportArtifactID: z.string().min(1),
  transformations: z.array(ConceptTransformationSchema),
  intents: z.array(RetrievalIntentSchema),
  candidates: z.array(RetrievalCandidateSchema),
  literatureResults: RetrieveLiteratureBridgeResultSchema.shape.papers,
  summary: z.object({
    intentCount: z.number().int().nonnegative(),
    bm25CandidateCount: z.number().int().nonnegative(),
    literaturePaperCount: z.number().int().nonnegative(),
    paperBackedCardCount: z.number().int().nonnegative(),
    missingPDFCount: z.number().int().nonnegative(),
    failedPaperCount: z.number().int().nonnegative(),
  }).strict(),
}).strict()

export const RetrieveResultV1Schema = z.object({
  schemaVersion: z.literal("retrieve_result_v1"),
  ...RetrieveResultBaseSchema.shape,
}).strict()

export const RetrieveResultSchema = z.object({
  schemaVersion: z.literal("retrieve_result_v2"),
  ...RetrieveResultBaseSchema.shape,
  taskEvidence: TaskEvidenceBundleSchema,
}).strict()
export const AnyRetrieveResultSchema = z.discriminatedUnion("schemaVersion", [RetrieveResultV1Schema, RetrieveResultSchema])
export const RetrieveResultV2Schema = RetrieveResultSchema
export type RetrieveResultV1 = z.infer<typeof RetrieveResultV1Schema>
export type RetrieveResult = z.infer<typeof RetrieveResultSchema>

export type RetrievalBudgets = {
  readonly maxIntents: number
  readonly maxCandidatesPerIntent: number
  readonly maxLiteraturePapersPerIntent: number
  readonly maxLiteraturePapersTotal: number
  readonly maxTaskEvidenceEntries: number
  readonly maxTaskEvidencePerIntent: number
}

export const DEFAULT_RETRIEVAL_BUDGETS: RetrievalBudgets = {
  maxIntents: 6,
  maxCandidatesPerIntent: 20,
  maxLiteraturePapersPerIntent: 5,
  maxLiteraturePapersTotal: 12,
  maxTaskEvidenceEntries: 12,
  maxTaskEvidencePerIntent: 3,
}
