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

test("identical structured operations merge despite paraphrased claims but distinct operations survive", () => {
  const mechanism = { mechanismID: "gru", name: "GRU encoder", principle: "Encode stock histories into hidden feature vectors using a GRU", components: ["GRU", "hidden features"] }
  const original = card({ cardType: "model_mechanism", mechanism })
  const paraphrase = card({ cardID: "kc_aaaaaaaaaaaa", cardType: "model_mechanism", mechanism, claim: "A recurrent unit maps each stock history to hidden features.", normalizedClaim: { subject: "GRU", predicate: "encodes", object: "history" } })
  expect(deduplicateCard(paraphrase, [original]).action).toBe("merge")
  const different = { ...paraphrase, mechanism: { ...mechanism, principle: "Decode hidden features into the future stock prices" } }
  expect(deduplicateCard(different, [original]).action).toBe("insert")
})
