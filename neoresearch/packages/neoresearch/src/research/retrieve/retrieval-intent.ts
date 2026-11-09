import { createHash } from "crypto"
import {
  ConceptTransformationSchema,
  RetrievalIntentSchema,
  type ConceptTransformation,
  type DatasetQuantitativeAnalysis,
  type RetrievalIntent,
} from "./contract"
import { mapMethodConcepts } from "./method-concept-mapper"
import { translateToPaperLanguage } from "./paper-language-translator"
import type { ScientificConceptMapping } from "./scientific-concept-mapper"

function shortDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12)
}
export function buildConceptTransformations(
  report: DatasetQuantitativeAnalysis,
  mappings: readonly ScientificConceptMapping[],
): ConceptTransformation[] {
  return mappings.map((mapping) => {
    const methodConcepts = mapMethodConcepts(mapping)
    const paperLanguage = translateToPaperLanguage({ report, scientific: mapping, methods: methodConcepts })
    return ConceptTransformationSchema.parse({
      transformationID: `transform_${mapping.conceptID}_${shortDigest(mapping.evidence.map((item) => [item.path, item.value]))}`,
      datasetEvidence: mapping.evidence,
      scientificConcepts: [{
        conceptID: mapping.conceptID,
        label: mapping.label,
        paperTerms: mapping.paperTerms,
        confidence: mapping.confidence,
        basis: "deterministic_rule",
      }],
      modelingChallenges: [mapping.modelingChallenge],
      methodConcepts,
      paperLanguage,
    })
  })
}

function questionFor(transformation: ConceptTransformation) {
  const concept = transformation.scientificConcepts[0]!
  return `How can forecasting models address ${concept.label}?`
}

export function buildRetrievalIntents(
  transformations: readonly ConceptTransformation[],
  maxIntents = 6,
): RetrievalIntent[] {
  return transformations
    .toSorted((left, right) => right.scientificConcepts[0]!.confidence - left.scientificConcepts[0]!.confidence)
    .slice(0, maxIntents)
    .map((transformation, index) => {
      const concept = transformation.scientificConcepts[0]!
      return RetrievalIntentSchema.parse({
        intentID: `intent_${concept.conceptID}_${shortDigest(transformation.transformationID)}`,
        question: questionFor(transformation),
        transformationID: transformation.transformationID,
        priority: concept.confidence,
        mustCover: index === 0 || concept.confidence >= 0.8,
        paperLanguageQuery: transformation.paperLanguage,
      })
    })
}
