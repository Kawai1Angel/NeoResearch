import type { NormalizedDocument } from "../../../src/research/literature/contract"
import type { PrincipleModel, PrincipleStage } from "../../../src/research/literature/principle-model"
import { candidate, review, chunk, digest } from "./principle-fixtures"
export const document: NormalizedDocument = {
  schemaVersion: "normalized_document_v1", paperID: "paper", documentID: "doc", sourcePath: "/fixture.pdf",
  sourceSha256: digest, parser: { name: "fixture", version: "1" }, language: "en",
  pages: [{ pageNumber: 1, text: chunk.text, blocks: [] }], sections: [], parseWarnings: [],
}
export function fixtureModel(override?: (stage: PrincipleStage, payload: Record<string, unknown>, value: unknown) => unknown) {
  const requests: Array<{ stage: PrincipleStage; payload: Record<string, unknown> }> = []
  const model: PrincipleModel = {
    modelIdentifier: "fixture",
    async request(stage, payload) {
      requests.push({ stage, payload })
      const c = candidate()
      const value = stage === "outline" ? {
        problem: "Efficient prediction of recurring phases", contributions: [{ statement: c.principle, sourceIDs: ["s"] }],
        methodOutline: [{ statement: c.intervention.operation, sourceIDs: ["s"] }], unresolved: [],
      } : stage === "collect" ? {
        materials: [{ kind: "counterevidence", statement: "No accuracy evidence", sourceIDs: ["s"], attribution: "author_claim", contributionIndexes: [0] }],
        unresolved: ["No performance experiment"],
      } : stage === "repair_materials" ? { repairs: (payload.invalidItems as any[]).map((item) => ({ itemIndex: item.itemIndex, material: null, reason: "Cannot recover fixture source" })) }
        : stage === "repair_bindings" ? { links: [], scopeReplacements: [], unresolved: ["No fixture patch"] }
        : stage === "plan" ? { plans: [{ planID: "candidate", contributionIndexes: [0], focus: "Complete phase-sharing principle" }], unformed: [] }
        : stage === "synthesize" ? { candidates: [c], unformed: [] }
        : stage === "revise" ? { candidate: payload.candidate, reason: "Fixture revision" }
        : stage === "merge" ? { candidate: (payload.originals as any[])[0], reason: "Fixture merge" }
        : stage === "consolidate" ? { groups: (payload.candidates as any[]).map((c) => ({ candidateIDs: [c.candidateID], action: "retain", rationale: "Complete principle" })) }
          : { ...review(), candidateID: (payload.candidate as any).candidateID, candidateHash: payload.candidateHash,
            assertionReviews: (payload.candidate as any).assertions.map((a: any) => ({ assertionID: a.assertionID, verdict: "supported", reason: "Fixture support" })),
            reviewedSourceIDs: (payload.candidate as any).sources }
      const raw = override ? override(stage, payload, value) : value
      const catalog = (payload.sourceCatalog ?? (payload.analysis as any)?.sources ?? []) as Array<{ sourceID: string }>
      const sourceID = catalog[0]?.sourceID ?? "s"
      const adapt = (item: any): any => {
        if (item === "s") return sourceID
        if (Array.isArray(item)) return item.map(adapt)
        if (!item || typeof item !== "object") return item
        return Object.fromEntries(Object.entries(item).filter(([key]) => !(item.schemaVersion === "knowledge_candidate_v2" && key === "principle")).map(([key, v]) => [key,
          key === "sources" && Array.isArray(v) ? v.map((s) => adapt(typeof s === "string" ? s : s.sourceID)) : adapt(v)]))
      }
      return { text: JSON.stringify(adapt(raw)) }
    },
  }
  return { model, requests }
}
