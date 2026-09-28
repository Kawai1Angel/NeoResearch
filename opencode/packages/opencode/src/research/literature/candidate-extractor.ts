import {
  CARD_TYPES, hasCompleteMechanism, CandidateClaimSchema, type CandidateClaim, type DocumentChunk,
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
  unknown: CARD_TYPES,
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
  const attempts: Array<{ chunkID: string; attempt: number; values?: unknown[]; error?: string }> = []
  const malformed: Array<{ value: unknown; error: string }> = []
  const failedChunks: Array<{ chunkID: string; error: string }> = []
  for (const item of extractionPlan(input.chunks, input.cardTypes)) {
    try {
      const request = { ...item, paper: input.paper }
      let pending: Array<{ value: unknown; error: string }> = []
      for (let attempt = 0; attempt < 2; attempt++) {
        let values: unknown[]
        try {
          values = await input.model.extractCandidates({ ...request,
            ...(attempt ? { repair: { rejected: pending.map((item) => item.value), errors: pending.map((item) => item.error) } } : {}),
          })
          attempts.push({ chunkID: item.chunk.chunkID, attempt, values })
        } catch (error) {
          attempts.push({ chunkID: item.chunk.chunkID, attempt, error: String(error) })
          if (attempt === 1) { malformed.push(...pending); throw error }
          pending = [{ value: null, error: String(error) }]
          continue
        }
        if (attempt && values.length === 0) malformed.push(...pending)
        pending = []
        for (const value of values) {
          const parsed = CandidateClaimSchema.safeParse(value)
          const error = !parsed.success ? parsed.error.message
            : !item.allowedCardTypes.includes(parsed.data.cardType) ? `cardType ${parsed.data.cardType} is not allowed in ${item.chunk.sectionKind}`
            : parsed.data.paperID !== item.chunk.paperID ? "paperID does not match source"
            : !parsed.data.supportingChunkIDs.includes(item.chunk.chunkID) ||
              !parsed.data.sourceLocations.some((location) => item.chunk.text.replace(/\s+/g, " ").includes(location.evidenceSpan.replace(/\s+/g, " "))) ? "current chunk must supply a quoted span, not just context"
            : parsed.data.cardType === "model_mechanism" && !hasCompleteMechanism(parsed.data) ? "mechanism requires problem, principle and components"
            : undefined
          if (error || !parsed.success) {
            pending.push({ value, error: error! })
            continue
          }
          if (!input.includeAgentInference && parsed.data.evidenceType === "agent_inference") continue
          accepted.push(parsed.data)
        }
        if (!pending.length) break
      }
      malformed.push(...pending)

    } catch (error) {
      failedChunks.push({ chunkID: item.chunk.chunkID, error: String(error) })
    }
  }
  return { candidates: accepted, malformed, failedChunks, attempts }
}
