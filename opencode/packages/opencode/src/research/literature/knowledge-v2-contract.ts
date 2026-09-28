import z from "zod"

// V1 remains an audit format. Never coerce a fragment into this contract.
export const KNOWLEDGE_V2_VERSIONS = {
  schema: "knowledge_card_v2", analysis: "paper_analysis_v1",
  synthesis: "paper_principle_v8", verifier: "principle_verifier_v10",
  sourceRecovery: "registered_spans_v1",
} as const

const text = z.string().trim().min(1)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const ids = z.array(text).min(1)
const sourced = z.object({ statement: text, sourceIDs: ids }).strict()

export const KnowledgeSourceSchema = z.object({
  sourceID: text, paperID: text, documentID: text, documentSha256: hash,
  chunkID: text, chunkSha256: hash, page: z.number().int().positive(),
  sectionID: text, quote: text, tableOrFigure: text.optional(),
  spanStart: z.number().int().nonnegative().optional(), spanEnd: z.number().int().positive().optional(),
  pageEnd: z.number().int().positive().optional(),
}).strict()

// Missing experimental fields are explicit; absence must not be filled from another row.
const reported = z.discriminatedUnion("status", [
  z.object({ status: z.literal("reported"), value: text, sourceIDs: ids }).strict(),
  z.object({ status: z.literal("not_reported"), reason: text }).strict(),
])

export const KnowledgeExperimentSchema = z.object({
  experimentID: text, studyID: text, intervention: reported, comparator: reported,
  dataset: reported, split: reported, contextLength: reported, predictionLength: reported,
  metric: reported, metricDirection: z.enum(["lower", "higher", "not_reported"]),
  repetitions: reported, uncertainty: reported, result: reported,
  control: z.enum(["single_factor", "multiple_factors", "unclear"]),
  confounds: z.array(text), sourceIDs: ids,
}).strict()

export const PaperAnalysisSchema = z.object({
  schemaVersion: z.literal("paper_analysis_v1"), paperID: text,
  documentID: text, documentSha256: hash, problem: text,
  contributions: z.array(sourced), methodOutline: z.array(sourced),
  materials: z.array(z.object({
    materialID: text,
    kind: z.enum(["mechanism", "experiment", "protocol", "boundary", "counterevidence", "theory"]),
    statement: text, sourceIDs: ids,
    attribution: z.enum(["author_claim", "author_explanation", "observation", "derivation", "extractor_inference"]),
    contributionIndexes: z.array(z.number().int().nonnegative()),
  }).strict()),
  sources: z.array(KnowledgeSourceSchema), unresolved: z.array(text),
  materialGaps: z.array(z.object({
    gapID: text, stage: z.enum(["outline", "collect"]), reason: text,
    contributionIndexes: z.array(z.number().int().nonnegative()),
    affectsAllContributions: z.boolean(), chunkIDs: z.array(text),
  }).strict()).optional(),
  coverage: z.object({ reviewedChunkIDs: z.array(text), remainingChunkIDs: z.array(text) }).strict(),
  status: z.enum(["complete", "partial"]),
}).strict()
export type PaperAnalysis = z.infer<typeof PaperAnalysisSchema>

const assertion = z.object({
  assertionID: text, statement: text,
  kind: z.enum(["principle", "condition", "intervention", "mechanism", "effect", "scope", "boundary"]),
}).strict()

export const KnowledgeCandidateSchema = z.object({
  schemaVersion: z.literal("knowledge_candidate_v2"), candidateID: text, paperID: text,
  contributionIndexes: z.array(z.number().int().nonnegative()).min(1).optional(),
  principle: text, transferableInsight: text,
  assertions: z.array(assertion).min(1),
  principleAssertionID: text,
  conditions: z.array(z.object({ assertionID: text, sourceIDs: ids }).strict()).min(1),
  intervention: z.object({ assertionID: text, operation: text, necessaryComponents: ids }).strict(),
  mechanism: z.object({
    assertionID: text, input: text, operation: text, explanatoryPath: text,
    attribution: z.enum(["source_explanation", "theoretical_derivation", "author_hypothesis", "extractor_inference"]),
  }).strict(),
  expectedEffect: z.object({
    assertionID: text, kind: z.enum(["representation", "computational", "performance", "hypothesis"]),
    comparator: reported,
  }).strict(),
  support: z.array(z.object({
    evidenceID: text, assertionIDs: ids, sourceIDs: ids,
    relation: z.enum(["supports", "refutes", "qualifies"]),
    kind: z.enum(["explanation", "derivation", "experiment"]),
    experimentID: text.optional(),
  }).strict()).min(1),
  experiments: z.array(KnowledgeExperimentSchema),
  observedScope: z.array(z.object({ assertionID: text, sourceIDs: ids }).strict()),
  boundaries: z.discriminatedUnion("status", [
    z.object({ status: z.literal("reported"), items: z.array(z.object({ assertionID: text, sourceIDs: ids }).strict()).min(1) }).strict(),
    z.object({ status: z.literal("not_reported"), note: text }).strict(),
  ]),
  unknowns: z.array(text),
  falsification: z.object({ origin: z.literal("proposed_validation"), test: text, failureCriterion: text }).strict(),
  implementationNotes: z.array(sourced),
  epistemicStatus: z.enum(["theoretical_support", "limited_empirical_support", "author_argument", "mixed_evidence"]),
  sources: z.array(KnowledgeSourceSchema).min(1),
}).strict()
export type KnowledgeCandidateV2 = z.infer<typeof KnowledgeCandidateSchema>

export const KNOWLEDGE_REJECTION_REASONS = [
  "fragment_only", "no_transferable_principle", "mechanism_unexplained", "unbound_experiment",
  "scope_overgeneralized", "unsupported_causal_claim", "missing_counterevidence",
  "component_only", "duplicate_principle", "source_unavailable",
] as const

export const PrincipleReviewSchema = z.object({
  candidateID: text, candidateHash: hash,
  verdict: z.enum(["accepted", "needs_revision", "rejected"]),
  checks: z.object({
    transferable: z.boolean(), mechanismComplete: z.boolean(), sourceEntailment: z.boolean(),
    experimentBinding: z.boolean(), scopeFaithful: z.boolean(), counterevidenceRetained: z.boolean(),
    independentPrinciple: z.boolean(),
  }).strict(),
  assertionReviews: z.array(z.object({
    assertionID: text, verdict: z.enum(["supported", "qualified", "unsupported"]), reason: text,
    qualification: z.object({
      kind: z.enum(["author_hypothesis", "limited_experiments", "unisolated_component", "missing_uncertainty", "shared_protocol", "limited_scope"]),
      sourceFaithful: z.boolean(), limitationDisclosed: z.boolean(),
    }).strict().optional(),
  }).strict()).min(1),
  reasons: z.array(z.enum(KNOWLEDGE_REJECTION_REASONS)), explanation: text,
  reviewedSourceIDs: ids,
}).strict()
export type PrincipleReview = z.infer<typeof PrincipleReviewSchema>

export const KnowledgeCardV2Schema = KnowledgeCandidateSchema.omit({ schemaVersion: true }).extend({
  schemaVersion: z.literal("knowledge_card_v2"),
  knowledgeID: z.string().regex(/^kn_[a-f0-9]{24}$/), revision: z.number().int().positive(),
  review: PrincipleReviewSchema,
  provenance: z.object({
    documentSha256: hash, analysisHash: hash, extractionRunID: text,
    extractorModel: text, verifierModel: text, synthesisVersion: text, verifierVersion: text,
    createdAt: z.string().datetime(),
  }).strict(),
}).strict()
export type KnowledgeCardV2 = z.infer<typeof KnowledgeCardV2Schema>
