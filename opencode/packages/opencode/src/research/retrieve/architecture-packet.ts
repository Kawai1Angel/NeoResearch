import z from "zod"
import { KnowledgeCardV2Schema } from "../literature/knowledge-v2-contract"
import { validateKnowledgeCardSeal } from "../literature/knowledge-v2-validator"
import { ArchitectureDecisionSchema, ArchitectureReviewSchema, decisionCardIDs, validateArchitectureReview } from "./architecture-knowledge"
import { ARCHITECTURE_SELECTION_POLICY, architectureEligibilityIssues } from "./architecture-eligibility"

export const ArchitecturePacketSchema = z.object({
  version: z.enum(["architecture_knowledge_v2_mainline", "architecture_knowledge_v3_matched_prediction", "architecture_knowledge_v4_mechanism_family"]),
  selectionPolicy: z.enum(["executable_matched_prediction_v1", ARCHITECTURE_SELECTION_POLICY]).optional(),
  status: z.enum(["completed", "partial", "unavailable"]),
  model: z.string(), corpusDigest: z.string(),
  consideredCardCount: z.number().int().nonnegative(), readCardCount: z.number().int().nonnegative(),
  decisions: z.array(ArchitectureDecisionSchema),
  sourceCards: z.array(KnowledgeCardV2Schema), historicalCardIDs: z.array(z.string()),
  datasetEvidencePaths: z.array(z.string().startsWith("$.")),
  reviews: ArchitectureReviewSchema.shape.reviews,
  exclusions: z.array(z.object({ id: z.string(), stage: z.string(), reason: z.string() }).strict()),
  warnings: z.array(z.string()),
}).strict().superRefine((packet, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message })
  const ids = packet.sourceCards.map((c) => c.knowledgeID)
  if (new Set(ids).size !== ids.length) issue("Duplicate architecture source cards")
  if (new Set(packet.decisions.map((d) => d.decisionID)).size !== packet.decisions.length) issue("Duplicate architecture decisions")
  if (packet.status === "unavailable" && packet.decisions.length) issue("Unavailable architecture review cannot authorize decisions")
  for (const card of packet.sourceCards) {
    const historical = packet.historicalCardIDs.includes(card.knowledgeID)
    if (validateKnowledgeCardSeal(card).some((error) => !historical || error !== "provenance_version_mismatch")) issue("Invalid architecture source identity")
  }
  if (packet.historicalCardIDs.some((id) => !ids.includes(id))) issue("Unknown historical source card")
  for (const d of packet.decisions) {
    if (d.taskFit === "not_applicable") issue("Inapplicable architectural choice cannot authorize task citations")
    if (!packet.reviews.some((r) => r.decisionID === d.decisionID && r.verdict === "accepted")) issue("Architecture decision lacks source review")
    if (packet.version === "architecture_knowledge_v4_mechanism_family") {
      if (packet.selectionPolicy !== ARCHITECTURE_SELECTION_POLICY) issue("Missing task admission policy")
      if (d.taskFit !== "supported") issue("Unknown task conditions cannot enter prediction handoff")
      for (const error of architectureEligibilityIssues(packet.reviews.find((r) => r.decisionID === d.decisionID)?.eligibility)) issue(error)
    }
  }
  const used = new Set(packet.decisions.flatMap(decisionCardIDs))
  if (ids.some((id) => !used.has(id))) issue("Unused source card in architecture handoff")
  try { validateArchitectureReview({ reviews: packet.reviews }, packet.decisions, packet.sourceCards) }
  catch (error) { issue(String(error)) }
})
export type ArchitecturePacket = z.infer<typeof ArchitecturePacketSchema>
