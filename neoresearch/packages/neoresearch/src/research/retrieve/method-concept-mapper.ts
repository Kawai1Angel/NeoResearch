import methodConfig from "./config/tsf-method-concepts.v1.json" with { type: "json" }
import type { MethodConcept } from "./contract"
import type { ScientificConceptMapping } from "./scientific-concept-mapper"

export function mapMethodConcepts(mapping: ScientificConceptMapping): MethodConcept[] {
  const configured = methodConfig.concepts[mapping.conceptID] ?? []
  return configured.map((item) => ({
    ...item,
    rationale: `Retrieval hypothesis for the evidence-backed concept: ${mapping.label}.`,
    status: "retrieval_hypothesis" as const,
  }))
}

export const METHOD_CONCEPT_MAPPING_VERSION = methodConfig.schemaVersion
