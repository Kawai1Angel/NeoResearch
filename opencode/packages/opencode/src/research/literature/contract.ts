import z from "zod"

// Explicit names keep v1 audit consumers separate from the new principle contract.
export {
  KnowledgeCandidateSchema, KnowledgeCardV2Schema, PaperAnalysisSchema, PrincipleReviewSchema,
  KNOWLEDGE_V2_VERSIONS, KNOWLEDGE_REJECTION_REASONS,
  type KnowledgeCandidateV2, type KnowledgeCardV2, type PaperAnalysis, type PrincipleReview,
} from "./knowledge-v2-contract"

export const CARD_TYPES = [
  "model_mechanism", "empirical_finding", "applicability_rule", "limitation",
  "evaluation_protocol", "domain_prior", "implementation_hint",
] as const
export const EVIDENCE_TYPES = [
  "author_definition", "author_argument", "author_experiment", "ablation_result",
  "complexity_analysis", "limitation_statement", "agent_inference",
] as const
export const SECTION_KINDS = [
  "abstract", "introduction", "related_work", "method", "experiment_setup", "results",
  "ablation", "complexity", "limitations", "conclusion", "references", "unknown",
] as const

export const DocumentChunkSchema = z.object({
  schemaVersion: z.literal("document_chunk_v1"),
  chunkID: z.string().regex(/^chunk_[a-f0-9]{20}$/),
  documentID: z.string(),
  paperID: z.string(),
  sectionID: z.string(),
  sectionKind: z.enum(SECTION_KINDS),
  pageStart: z.number().int().positive(),
  pageEnd: z.number().int().positive(),
  ordinal: z.number().int().nonnegative(),
  text: z.string().min(1),
  textSha256: z.string().regex(/^[a-f0-9]{64}$/),
  previousChunkID: z.string().optional(),
  nextChunkID: z.string().optional(),
}).strict()
export type DocumentChunk = z.infer<typeof DocumentChunkSchema>

export const NormalizedDocumentSchema = z.object({
  schemaVersion: z.literal("normalized_document_v1"),
  documentID: z.string(), paperID: z.string(), sourcePath: z.string(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  parser: z.object({ name: z.string(), version: z.string() }).strict(),
  language: z.string(), title: z.string().optional(),
  pages: z.array(z.object({
    pageNumber: z.number().int().positive(), text: z.string(),
    blocks: z.array(z.object({
      blockID: z.string(), text: z.string(),
      bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    }).strict()),
  }).strict()).min(1),
  sections: z.array(z.object({
    sectionID: z.string(), heading: z.string(), normalizedKind: z.enum(SECTION_KINDS),
    startPage: z.number().int().positive(), endPage: z.number().int().positive(), blockIDs: z.array(z.string()),
  }).strict()),
  parseWarnings: z.array(z.string()),
}).strict()
export type NormalizedDocument = z.infer<typeof NormalizedDocumentSchema>

export const SourceLocationSchema = z.object({
  page: z.number().int().positive(), section: z.string().min(1), evidenceSpan: z.string().min(1).max(1500),
}).strict()

export const MechanismSchema = z.object({
  mechanismID: z.string().trim().min(1), name: z.string().trim().min(1),
  principle: z.string().trim().min(12), components: z.array(z.string().trim().min(1)).min(1),
}).strict()

export function hasCompleteMechanism(value: { problem?: string; mechanism?: unknown }) {
  return !!value.problem?.trim() && MechanismSchema.safeParse(value.mechanism).success
}

export const CandidateClaimSchema = z.object({
  candidateID: z.string().min(1), paperID: z.string().min(1), cardType: z.enum(CARD_TYPES),
  claim: z.string().min(8).max(2000), subject: z.string().min(1), predicate: z.string().min(1), object: z.string().min(1),
  problem: z.string().trim().min(1).optional(), mechanism: MechanismSchema.optional(),
  evidenceType: z.enum(EVIDENCE_TYPES), supportingChunkIDs: z.array(z.string()).min(1),
  sourceLocations: z.array(SourceLocationSchema).min(1), extractorConfidence: z.number().min(0).max(1),
}).strict()
export type CandidateClaim = z.infer<typeof CandidateClaimSchema>

export const EvidenceVerificationSchema = z.object({
  verdict: z.enum(["supported", "partially_supported", "unsupported", "overstated"]),
  actionabilityVerdict: z.enum(["testable_intervention", "observation_only", "not_applicable"]).optional(),
  cardTypeVerdict: z.enum(["correct", "mismatch", "uncertain"]).optional(),
  mechanismVerdict: z.enum(["supported", "incomplete", "unsupported", "not_applicable"]).optional(),
  contributionVerdict: z.enum(["own_method", "background", "uncertain", "not_applicable"]).optional(),
  qualityReasons: z.array(z.string()).optional(),
  supportedScope: z.string(), unsupportedParts: z.array(z.string()), correctedClaim: z.string().optional(),
  evidenceDirectness: z.enum(["direct", "indirect", "inferred"]), confidence: z.number().min(0).max(1),
}).strict()
export type EvidenceVerification = z.infer<typeof EvidenceVerificationSchema>

const ApplicabilitySchema = z.object({
  taskTypes: z.array(z.string()), dataFeatures: z.array(z.string()), domains: z.array(z.string()),
  dataScale: z.array(z.string()), horizonProfile: z.array(z.string()), computeProfile: z.array(z.string()),
  basis: z.enum(["author_statement", "author_experiment", "agent_inference", "unknown"]),
}).strict()

const EvidenceSchema = z.object({
  evidenceID: z.string().regex(/^ev_[a-f0-9]{8,16}$/), evidenceType: z.enum(EVIDENCE_TYPES), chunkID: z.string(), section: z.string(),
  pageStart: z.number().int().positive(), pageEnd: z.number().int().positive(), evidenceSpan: z.string().min(1).max(1500),
  tableOrFigure: z.string().optional(), directness: z.enum(["direct", "indirect", "inferred"]),
  verification: z.enum(["exact_span", "normalized_span", "manual_required"]),
}).strict()

export const KnowledgeCardSchema = z.object({
  schemaVersion: z.literal("knowledge_card_v1"), cardID: z.string().regex(/^kc_[a-f0-9]{12}$/),
  revision: z.number().int().positive(), paperID: z.string(), cardType: z.enum(CARD_TYPES), claim: z.string().min(8).max(2000),
  normalizedClaim: z.object({ subject: z.string().min(1), predicate: z.string().min(1), object: z.string().min(1) }).strict(),
  problem: z.string().optional(),
  mechanism: z.object({ mechanismID: z.string(), name: z.string(), principle: z.string(), components: z.array(z.string()) }).strict().optional(),
  applicability: ApplicabilitySchema, notApplicableWhen: z.array(z.string()),
  experimentalContext: z.object({
    datasets: z.array(z.string()), baselines: z.array(z.string()), metrics: z.array(z.string()),
    contextLengths: z.array(z.number().int().positive()), predictionLengths: z.array(z.number().int().positive()),
    reportedEffect: z.object({
      direction: z.enum(["improved", "degraded", "mixed", "no_significant_change", "unknown"]),
      value: z.number().optional(), unit: z.string().optional(), comparedWith: z.string().optional(),
    }).strict().optional(),
  }).strict().optional(),
  evidence: z.array(EvidenceSchema).min(1), limitations: z.array(z.string()),
  implementation: z.object({
    recipeConcepts: z.array(z.string()), registryMappings: z.array(z.string()),
    estimatedComplexity: z.enum(["low", "medium", "high", "unknown"]), notes: z.array(z.string()),
  }).strict().optional(),
  confidence: z.object({
    sourceQuality: z.number().min(0).max(1), extractionConfidence: z.number().min(0).max(1),
    evidenceDirectness: z.number().min(0).max(1), transferability: z.number().min(0).max(1),
  }).strict(),
  status: z.enum(["extracted", "paper_backed", "corroborated", "contradicted", "inconclusive", "deprecated"]),
  tags: z.array(z.string()),
  provenance: z.object({
    sourceDocumentID: z.string(), sourceDocumentSha256: z.string().regex(/^[a-f0-9]{64}$/), sourcePublicationStatus: z.string(),
    extractorModel: z.string(), extractorPromptVersion: z.string(), verifierModel: z.string().optional(),
    verifierPromptVersion: z.string().optional(), extractionRunID: z.string(),
    createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  }).strict(),
}).strict()
export type KnowledgeCard = z.infer<typeof KnowledgeCardSchema>

export const CardRelationSchema = z.object({
  relationID: z.string(), sourceCardID: z.string(), targetCardID: z.string(),
  relationType: z.enum(["supports", "contradicts", "refines", "duplicates"]), rationale: z.string(),
  confidence: z.number().min(0).max(1), createdBy: z.enum(["deterministic", "llm", "human"]), createdAt: z.string().datetime(),
}).strict()
export type CardRelation = z.infer<typeof CardRelationSchema>

export type RejectionReason =
  | "mechanism_incomplete" | "card_quality_failed" | "selection_budget"
  | "verification_error" | "no_locatable_evidence" | "claim_too_broad" | "duplicate" | "references_only" | "schema_invalid"
  | "evidence_does_not_support_claim" | "prompt_injection_detected" | "numeric_evidence_missing"

export type RejectedCandidate = { readonly candidate: unknown; readonly reason: RejectionReason; readonly detail: string }

export type LiteratureAgentInput = {
  readonly sources: readonly (
    | { readonly kind: "catalog_paper"; readonly paperID: string }
    | { readonly kind: "local_pdf"; readonly path: string; readonly metadata: {
      readonly title: string; readonly year?: number; readonly venue?: string
      readonly publicationStatus?: "peer_reviewed" | "preprint" | "unknown"; readonly doi?: string
    } }
  )[]
  readonly options?: {
    readonly force?: boolean; readonly cardTypes?: readonly (typeof CARD_TYPES)[number][]
    readonly maxCardsPerPaper?: number; readonly includeAgentInference?: boolean; readonly requireExactEvidenceSpan?: boolean
  }
}

export type LiteratureAgentResult = {
  readonly agent: "LiteratureAgent"; readonly runIDs: string[]
  readonly processed: Array<{
    paperID: string; documentID: string; status: "completed" | "partial" | "failed"
    acceptedCardIDs: string[]; rejectedCandidateCount: number; warningCount: number; reviewPath: string
    error?: string
  }>
  readonly summary: {
    paperCount: number; acceptedCardCount: number; paperBackedCount: number; agentInferenceCount: number
    duplicateCount: number; failedCount: number
  }
}
