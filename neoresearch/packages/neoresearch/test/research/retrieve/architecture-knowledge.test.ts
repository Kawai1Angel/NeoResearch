import { describe, expect, test } from "bun:test"
import type { KnowledgeCardV2 } from "../../../src/research/literature/knowledge-v2-contract"
import {
  ArchitectureDecisionSchema, validateRecallPartition, validateArchitectureExtraction,
  validateArchitectureReview, projectArchitectureSourceCard,
  parseArchitectureJSON,
} from "../../../src/research/retrieve/architecture-knowledge"

// These validators need only source identity, not a fabricated scientific card.
const card = {
  knowledgeID: "kn_a", sources: [{ sourceID: "s1" }, { sourceID: "s2" }],
  review: { verdict: "accepted" }, provenance: {}, falsification: { test: "rerun" },
} as unknown as KnowledgeCardV2
const citation = [{ cardID: "kn_a", sourceIDs: ["s1"] }]
const decision = ArchitectureDecisionSchema.parse({
  decisionID: "d1", dataCondition: "Weak cross-channel relationships", prefer: "Independent temporal paths",
  avoid: "Unconditional mixing", mechanism: "Avoid mixing irrelevant variation", observedEffect: "Scoped paper observation",
  evidenceLevel: "mixed", limitations: ["No correlation threshold reported"], taskFit: "conditional",
  taskReason: "Cross-variable evidence unavailable", citations: {
    condition: citation, choice: citation, mechanism: [{ cardID: "kn_a", sourceIDs: ["s2"] }], effect: citation,
  },
})

describe("architecture knowledge source contracts", () => {
  test("unwraps only a complete JSON fence without guessing truncated content", () => {
    expect(parseArchitectureJSON('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(() => parseArchitectureJSON('```json\n{"a":')).toThrow()
    expect(() => parseArchitectureJSON('Some explanation {"a":1}')).toThrow()
  })
  test("recall accounts for all cards exactly once", () => {
    expect(() => validateRecallPartition({ selected: ["a"], excluded: [{ cardID: "b", reason: "duplicate" }] }, ["a", "b"])).not.toThrow()
    expect(() => validateRecallPartition({ selected: ["a"], excluded: [] }, ["a", "b"])).toThrow("partition")
    expect(() => validateRecallPartition({ selected: ["a"], excluded: [{ cardID: "a", reason: "duplicate" }] }, ["a", "b"])).toThrow("partition")
  })
  test("extraction rejects invented card and source references", () => {
    const changed = structuredClone(decision)
    changed.citations.effect = [{ cardID: "kn_a", sourceIDs: ["invented"] }]
    expect(() => validateArchitectureExtraction({ decisions: [changed], unused: [] }, [card])).toThrow("Unknown source")
    changed.citations.effect = [{ cardID: "invented", sourceIDs: ["s1"] }]
    expect(() => validateArchitectureExtraction({ decisions: [changed], unused: [] }, [card])).toThrow("Unknown card")
  })
  test("a cited card cannot also be discarded", () => {
    expect(() => validateArchitectureExtraction({ decisions: [decision], unused: [] }, [card])).not.toThrow()
    expect(() => validateArchitectureExtraction({ decisions: [decision], unused: [{ cardID: "kn_a", reason: "unused" }] }, [card])).toThrow("partition")
  })
  test("acceptance requires reading every cited source, including the mechanism", () => {
    const review = { decisionID: "d1", verdict: "accepted" as const, reason: "Source faithful", reviewedSources: citation }
    expect(() => validateArchitectureReview({ reviews: [review] }, [decision], [card])).toThrow("omitted")
    review.reviewedSources = [{ cardID: "kn_a", sourceIDs: ["s1", "s2"] }]
    expect(() => validateArchitectureReview({ reviews: [review] }, [decision], [card])).not.toThrow()
  })
  test("missing or duplicated decisions cannot pass review", () => {
    expect(() => validateArchitectureReview({ reviews: [] }, [decision], [card])).toThrow("partition")
    const review = { decisionID: "d1", verdict: "rejected" as const, reason: "No data condition", reviewedSources: citation }
    expect(() => validateArchitectureReview({ reviews: [review, review] }, [decision], [card])).toThrow("partition")
  })
  test("a reviewer may bind additional inspected condition sources on cited cards", () => {
    const reviewed = { decisionID: "d1", verdict: "accepted" as const, reason: "Source faithful",
      reviewedSources: [{ cardID: "kn_a", sourceIDs: ["s1", "s2"] }], eligibility: {
        conditionLogic: [{ alternatives: [0], sourceRationale: "Further original evidence",
          sourceRefs: [{ cardID: "kn_a", sourceIDs: ["s2"] }] }],
      } } as any
    expect(() => validateArchitectureReview({ reviews: [reviewed] }, [decision], [card])).not.toThrow()
    reviewed.reviewedSources = citation
    expect(() => validateArchitectureReview({ reviews: [reviewed] }, [decision], [card])).toThrow("uninspected")
    reviewed.eligibility.conditionLogic[0].sourceRefs[0].sourceIDs = ["invented"]
    expect(() => validateArchitectureReview({ reviews: [reviewed] }, [decision], [card])).toThrow("Unknown source")
  })
  test("original card stays immutable and prior verdicts do not bias the source reader", () => {
    const before = structuredClone(card)
    const projected = projectArchitectureSourceCard(card)
    expect(projected).not.toHaveProperty("review")
    expect(projected).not.toHaveProperty("falsification")
    expect(projected).not.toHaveProperty("candidateID")
    expect(projected.cardID).toBe("kn_a")
    expect(projected.sources).toEqual(card.sources)
    expect(card).toEqual(before)
  })
})
