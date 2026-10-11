import taskEvidenceConfig from "./config/tsf-task-evidence.v1.json" with { type: "json" }
import type { KnowledgeCardV2 } from "../literature/knowledge-v2-contract"
import type { KnowledgeCard } from "../literature/contract"
import { normalizeRetrievalTokens } from "./bm25-search"
import type { ConceptTransformation, RetrievalIntent } from "./contract"

export type CardIntentBinding = {
  readonly intentID: string
  readonly score: number
  readonly matchedTerms: readonly string[]
  readonly reasons: readonly string[]
}

function normalized(value: string) {
  return normalizeRetrievalTokens(value).join(" ")
}

function phrases(values: readonly string[]) {
  const output = new Set<string>()
  for (const value of values) {
    const key = normalized(value)
    if (!key) continue
    output.add(key)
    const aliases = taskEvidenceConfig.aliases[key.replaceAll(" ", "_") as keyof typeof taskEvidenceConfig.aliases] ?? []
    for (const alias of aliases) output.add(normalized(alias))
  }
  return [...output]
}

function cardVocabulary(card: KnowledgeCard | KnowledgeCardV2, scope: "semantic" | "task" | "domain") {
  if (card.schemaVersion === "knowledge_card_v2") {
    const statements = card.assertions.map((item) => item.statement)
    return phrases([card.principle, card.transferableInsight, card.intervention.operation,
      ...card.intervention.necessaryComponents, card.mechanism.input, card.mechanism.operation, card.mechanism.explanatoryPath, ...statements])
  }
  const semantic = [
    card.claim,
    card.problem ?? "",
    card.normalizedClaim.subject,
    card.normalizedClaim.predicate,
    card.normalizedClaim.object,
    card.mechanism?.name ?? "",
    card.mechanism?.principle ?? "",
    ...(card.mechanism?.components ?? []),
    ...card.applicability.dataFeatures,
    ...card.applicability.horizonProfile,
    ...card.applicability.computeProfile,
    ...(card.implementation?.recipeConcepts ?? []),
    ...(card.implementation?.registryMappings ?? []),
    ...card.tags,
  ]
  if (scope === "semantic") return phrases(semantic)
  if (scope === "task") return phrases([...semantic, ...card.applicability.taskTypes])
  return phrases([...card.applicability.domains])
}

function matches(vocabulary: readonly string[], terms: readonly string[]) {
  const generic = new Set(taskEvidenceConfig.genericTerms)
  const vocabularyTokens = new Set(vocabulary.flatMap(normalizeRetrievalTokens))
  const matched = phrases(terms).filter((term) => {
    const tokens = normalizeRetrievalTokens(term)
    if (tokens.length === 0) return false
    const distinctive = tokens.filter((token) => !generic.has(token))
    return distinctive.length > 0 && distinctive.every((token) => vocabularyTokens.has(token))
  })
  return [...new Set(matched)]
}

function roleCompatible(card: KnowledgeCard | KnowledgeCardV2, intent: RetrievalIntent) {
  if (card.schemaVersion === "knowledge_card_v2") return true
  const question = intent.question.toLowerCase()
  if (card.cardType === "limitation") return true
  if (card.cardType === "evaluation_protocol") return /evaluat|metric|benchmark/.test(question)
  if (card.cardType === "implementation_hint") return /how|method|model/.test(question)
  return /how|address|mechanism|applicab/.test(question)
}

export function bindCardToIntents(input: {
  readonly card: KnowledgeCard | KnowledgeCardV2
  readonly intentIDs: readonly string[]
  readonly intents: readonly RetrievalIntent[]
  readonly transformations: readonly ConceptTransformation[]
  readonly taskType: string
  readonly domain: string
}): CardIntentBinding[] {
  const semanticVocabulary = cardVocabulary(input.card, "semantic")
  const taskVocabulary = cardVocabulary(input.card, "task")
  const domainVocabulary = cardVocabulary(input.card, "domain")
  const transformations = new Map(input.transformations.map((item) => [item.transformationID, item]))
  const allowed = new Set(input.intentIDs)
  return input.intents
    .filter((intent) => allowed.has(intent.intentID))
    .flatMap((intent): CardIntentBinding[] => {
      const transformation = transformations.get(intent.transformationID)
      if (!transformation) throw new Error(`Retrieval intent references an unknown transformation: ${intent.intentID}`)
      const scientificTerms = transformation.scientificConcepts.flatMap((item) => [item.conceptID, item.label, ...item.paperTerms])
      const methodTerms = transformation.methodConcepts.flatMap((item) => [item.conceptID, item.label, ...item.paperTerms])
      const scientific = matches(semanticVocabulary, [...scientificTerms, ...intent.paperLanguageQuery.phenomenonTerms])
      const method = matches(semanticVocabulary, [...methodTerms, ...intent.paperLanguageQuery.methodTerms])
      const taskType = matches(taskVocabulary, [input.taskType, ...intent.paperLanguageQuery.taskTerms])
      const domain = matches(domainVocabulary, [input.domain, ...intent.paperLanguageQuery.domainTerms])
      const compatible = roleCompatible(input.card, intent)
      if (input.card.schemaVersion === "knowledge_card_v1" && input.card.cardType === "evaluation_protocol" && !compatible) return []
      if (scientific.length === 0 && method.length === 0) return []
      const score =
        (scientific.length > 0 ? taskEvidenceConfig.weights.scientific : 0) +
        (method.length > 0 ? taskEvidenceConfig.weights.method : 0) +
        (taskType.length > 0 ? taskEvidenceConfig.weights.taskType : 0) +
        (domain.length > 0 ? taskEvidenceConfig.weights.domain : 0) +
        (compatible ? taskEvidenceConfig.weights.role : 0)
      if (score < taskEvidenceConfig.bindingThreshold) return []
      const reasons = [
        ...(scientific.length > 0 ? [`scientific/data-feature match: ${scientific.join(", ")}`] : []),
        ...(method.length > 0 ? [`method/mechanism match: ${method.join(", ")}`] : []),
        ...(taskType.length > 0 ? [`task match: ${taskType.join(", ")}`] : []),
        ...(domain.length > 0 ? [`domain match: ${domain.join(", ")}`] : []),
        ...(compatible ? [`card type ${input.card.schemaVersion === "knowledge_card_v2" ? "transferable_principle" : input.card.cardType} is compatible with the intent question`] : []),
      ]
      return [{
        intentID: intent.intentID,
        score: Number(Math.min(1, score).toFixed(3)),
        matchedTerms: [...new Set([...scientific, ...method, ...taskType, ...domain])].toSorted(),
        reasons,
      }]
    })
    .toSorted((left, right) => right.score - left.score || left.intentID.localeCompare(right.intentID))
}

export const TASK_EVIDENCE_MAPPING_VERSION = `${taskEvidenceConfig.schemaVersion}:binding_v7`
