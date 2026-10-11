import { requireAttributableComparison } from "../attribution"
import z from "zod"
import { completeQualityFact, ExperimentFactSchema, validateExperienceEvidence, type ExperimentFact } from "../experience"
import type { KnowledgeCardV2 } from "./knowledge-v2-contract"

export const INITIAL_KNOWLEDGE_CONFIDENCE = 0.5
export const KNOWLEDGE_CONFIDENCE_INCREMENT = 0.01
export const KNOWLEDGE_SELECTION_VERSION = "knowledge_confidence_weight_v1"
export const KNOWLEDGE_CONFIDENCE_WEIGHT = 0.1
export function knowledgeSelectionScore(relevance: number, confidence: number) {
  return Number(((1 - KNOWLEDGE_CONFIDENCE_WEIGHT) * relevance + KNOWLEDGE_CONFIDENCE_WEIGHT * confidence).toFixed(8))
}

const text = z.string().trim().min(1).max(4000)
/** Reflection supplies judgments and references only; the coordinator attaches actual experiment facts. */
export const KnowledgeValidationDraftSchema = z.object({
  cardID: z.string().regex(/^kn_[a-f0-9]{24}$/), cardRevision: z.number().int().positive(),
  runID: text, comparisonRunID: text.optional(), assertionIDs: z.array(text).min(1).max(20),
  rationale: text, conditionsAssessment: text, implementationAssessment: text, limitations: z.array(text).min(1).max(20),
}).strict()
export type KnowledgeValidationDraft = z.infer<typeof KnowledgeValidationDraftSchema>
export const KnowledgeValidationSchema = KnowledgeValidationDraftSchema.extend({
  validationID: z.string(), taskID: text, actor: z.literal("ReflectionAgent"),
  facts: z.array(ExperimentFactSchema).min(1).max(2), createdAt: z.string().datetime(),
  previousConfidence: z.number().min(0).max(1), confidence: z.number().min(0).max(1),
  increment: z.number().min(0).max(KNOWLEDGE_CONFIDENCE_INCREMENT),
}).strict()
export type KnowledgeValidation = z.infer<typeof KnowledgeValidationSchema>

export function validateKnowledgeExperiment(card: KnowledgeCardV2, draft: KnowledgeValidationDraft, taskID: string, facts: ExperimentFact[]) {
  const trial = facts.find((fact) => fact.runID === draft.runID)
  if (!trial || trial.taskID !== taskID || !completeQualityFact(trial) || !trial.dataset.contentHash) {
    throw new Error("Knowledge validation requires a current-task independent, verified full run with finite metrics and captured dataset identity")
  }
  if (draft.assertionIDs.some((id) => !card.assertions.some((a) => a.assertionID === id))) throw new Error("Unknown knowledge assertion")
  if (!draft.assertionIDs.some((id) => [card.principleAssertionID, card.intervention.assertionID, card.mechanism.assertionID, card.expectedEffect.assertionID].includes(id))) {
    throw new Error("Matching conditions alone does not validate literature knowledge")
  }
  if (facts.length !== (draft.comparisonRunID ? 2 : 1)) throw new Error("Unexpected experiment facts")
  if (draft.comparisonRunID) {
    const comparison = facts.find((fact) => fact.runID === draft.comparisonRunID)
    if (!comparison || !completeQualityFact(comparison) || !comparison.dataset.contentHash) throw new Error("Comparison must be an independent verified full run")
  }
  const comparator = facts.find((fact) => fact.runID === draft.comparisonRunID)
  requireAttributableComparison(trial, comparator)
  if (card.expectedEffect.kind === "performance" && comparator && !(trial.direction === "minimize" ? trial.primaryValue! < comparator.primaryValue! : trial.primaryValue! > comparator.primaryValue!))
    throw new Error("A non-improving comparison cannot increase confidence in a performance benefit")
  validateExperienceEvidence({ level: "conditional_experience", polarity: "positive",
    claimType: card.expectedEffect.kind === "performance" ? "performance" : "observation",
    statement: draft.rationale, conditions: [draft.conditionsAssessment], intervention: draft.implementationAssessment,
    observation: draft.rationale, boundaries: draft.limitations, unknowns: [], validationPlan: card.falsification.test,
    evidence: [{ runID: draft.runID, comparisonRunID: draft.comparisonRunID, relation: "supports" }],
  }, facts)
}
