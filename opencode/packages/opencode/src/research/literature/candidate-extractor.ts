import {
  CARD_TYPES, CandidateClaimSchema, type CandidateClaim, type DocumentChunk,
} from "./contract"
import type { LiteratureExtractionModel } from "./extraction-model"

const SECTION_CARD_TYPES: Readonly<Record<DocumentChunk["sectionKind"], readonly CandidateClaim["cardType"][]>> = {
  abstract: ["model_mechanism", "domain_prior"],
  introduction: ["model_mechanism", "domain_prior"],
  related_work: [],
  method: ["model_mechanism", "implementation_hint"],
  experiment_setup: ["evaluation_protocol"],
  results: ["empirical_finding"],
  ablation: ["empirical_finding", "applicability_rule"],
  complexity: ["implementation_hint"],
  limitations: ["limitation", "applicability_rule"],
  conclusion: ["limitation", "applicability_rule", "model_mechanism"],
  references: [],
  unknown: ["model_mechanism", "limitation"],
}

export function extractionPlan(
  chunks: readonly DocumentChunk[],
  requested: readonly CandidateClaim["cardType"][] = CARD_TYPES,
) {
  const requestedSet = new Set(requested)
  return chunks.map((chunk, index) => ({
    chunk,
    previousChunk: index > 0 && chunks[index - 1].sectionID === chunk.sectionID ? chunks[index - 1] : undefined,
    nextChunk: index + 1 < chunks.length && chunks[index + 1].sectionID === chunk.sectionID ? chunks[index + 1] : undefined,
    allowedCardTypes: SECTION_CARD_TYPES[chunk.sectionKind].filter((item) => requestedSet.has(item)),
  })).filter((item) => item.allowedCardTypes.length > 0)
}

export async function extractCandidates(input: {
  readonly model: LiteratureExtractionModel
  readonly chunks: readonly DocumentChunk[]
  readonly paper: Record<string, unknown>
  readonly cardTypes?: readonly CandidateClaim["cardType"][]
  readonly includeAgentInference: boolean
}) {
  const accepted: CandidateClaim[] = []
  const malformed: Array<{ value: unknown; error: string }> = []
  const failedChunks: Array<{ chunkID: string; error: string }> = []
  for (const item of extractionPlan(input.chunks, input.cardTypes)) {
    try {
      const request = { ...item, paper: input.paper }
      const values = await input.model.extractCandidates(request).catch(() => input.model.extractCandidates(request))
      for (const value of values) {
        const parsed = CandidateClaimSchema.safeParse(value)
        if (!parsed.success) {
          malformed.push({ value, error: parsed.error.message })
          continue
        }
        if (!item.allowedCardTypes.includes(parsed.data.cardType)) {
          malformed.push({ value, error: `cardType ${parsed.data.cardType} is not allowed in ${item.chunk.sectionKind}` })
          continue
        }
        if (parsed.data.paperID !== item.chunk.paperID) {
          malformed.push({ value, error: `paperID ${parsed.data.paperID} does not match source ${item.chunk.paperID}` })
          continue
        }
        if (!input.includeAgentInference && parsed.data.evidenceType === "agent_inference") continue
        accepted.push(parsed.data)
      }
    } catch (error) {
      failedChunks.push({ chunkID: item.chunk.chunkID, error: String(error) })
    }
  }
  return { candidates: accepted, malformed, failedChunks }
}
