import z from "zod"
import { hasCompleteMechanism, type KnowledgeCard } from "./contract"

export const SEMANTIC_CONSOLIDATION_VERSION = "mechanism_equivalence_v1"
const ReviewSchema = z.object({
  groups: z.array(z.object({ cardIDs: z.array(z.string()).min(2), rationale: z.string().min(1) }).strict()),
  componentRelations: z.array(z.object({
    parentCardID: z.string(), componentCardID: z.string(), rationale: z.string().min(1),
  }).strict()),
}).strict()
export type SemanticReview = z.infer<typeof ReviewSchema>
export type SemanticReviewer = (cards: readonly KnowledgeCard[], repair?: string) => Promise<unknown>

export function validateSemanticReview(raw: unknown, cards: readonly KnowledgeCard[]): SemanticReview {
  const review = ReviewSchema.parse(raw)
  const byID = new Map(cards.map((card) => [card.cardID, card]))
  const assigned = new Set<string>()
  for (const group of review.groups) {
    const members = group.cardIDs.map((id) => {
      const card = byID.get(id)
      if (!card || !hasCompleteMechanism(card) || card.cardType !== "model_mechanism") throw new Error(`Invalid mechanism member: ${id}`)
      if (assigned.has(id)) throw new Error(`Overlapping semantic groups: ${id}`)
      assigned.add(id)
      return card
    })
    if (new Set(members.map((card) => card.paperID)).size !== 1) throw new Error("Cross-paper merging is forbidden")
  }
  for (const relation of review.componentRelations) {
    const parent = byID.get(relation.parentCardID)
    const child = byID.get(relation.componentCardID)
    if (!parent || !child || parent.cardID === child.cardID || parent.paperID !== child.paperID) throw new Error("Invalid component relation")
    if (review.groups.some((group) => group.cardIDs.includes(parent.cardID) && group.cardIDs.includes(child.cardID))) {
      throw new Error(`A component cannot be merged with its parent: ${parent.cardID} -> ${child.cardID}. Keep the component relation and remove the non-equivalent member from the group.`)
    }
  }
  return review
}

export async function consolidateMechanisms(cards: readonly KnowledgeCard[], review?: SemanticReviewer) {
  const papers = [...new Set(cards.map((card) => card.paperID))].toSorted()
  const results: Array<{ paperID: string; status: "reviewed" | "unavailable" | "failed"; review?: SemanticReview; error?: string }> = []
  for (const paperID of papers) {
    const members = cards.filter((card) => card.paperID === paperID && card.cardType === "model_mechanism" && hasCompleteMechanism(card))
    if (members.length < 2) continue
    if (!review) { results.push({ paperID, status: "unavailable" }); continue }
    let error: string | undefined
    let previous: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        previous = await review(members, error ? JSON.stringify({ validationError: error, previousResponse: previous }) : undefined)
        const result = validateSemanticReview(previous, members)
        results.push({ paperID, status: "reviewed", review: result })
        error = undefined
        break
      } catch (cause) { error = String(cause) }
    }
    if (error) results.push({ paperID, status: "failed", error })
  }
  return { version: SEMANTIC_CONSOLIDATION_VERSION, papers: results,
    groups: results.flatMap((result) => result.review?.groups ?? []) }
}
