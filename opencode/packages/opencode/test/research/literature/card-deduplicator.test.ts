import { expect, test } from "bun:test"
import { deduplicateCard, mergeCardEvidence } from "../../../src/research/literature/card-deduplicator"
import { card } from "./fixtures"

test("same-paper normalized triples merge without losing evidence", () => {
  const existing = card()
  const incoming = card({ evidence: [{ ...existing.evidence[0], evidenceID: "ev_abcdef12", pageStart: 4, pageEnd: 4 }] })
  const decision = deduplicateCard(incoming, [existing])
  expect(decision.action).toBe("merge")
  const merged = mergeCardEvidence(existing, incoming, 2, "2026-09-21T01:00:00.000Z")
  expect(merged.revision).toBe(2)
  expect(merged.evidence).toHaveLength(2)
})

test("same claim from another paper creates support instead of erasing provenance", () => {
  const existing = card()
  const incoming = card({ cardID: "kc_abcdef123456", paperID: "another-paper" })
  const decision = deduplicateCard(incoming, [existing])
  expect(decision.action).toBe("insert")
  if (decision.action === "insert") expect(decision.relations[0].relationType).toBe("supports")
})
