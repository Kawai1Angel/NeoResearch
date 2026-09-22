import { expect, test } from "bun:test"
import { runLiteratureBridge } from "../../../src/research/retrieve/literature-bridge"
import type { LiteratureAgentResult } from "../../../src/research/literature/contract"
import { fixture } from "./fixtures"

function input() {
  const value = fixture()
  return { retrieveRunID: "retrieve_bridge", candidates: [{ paperID: "paper-frequency", intentIDs: value.intents.map((item) => item.intentID),
    candidateIDs: value.candidates.map((item) => item.candidateID), bm25Rank: 1, bm25Score: 10 }],
    literatureOptions: { includeAgentInference: false as const, requireExactEvidenceSpan: true as const, maxCardsPerPaper: 3 } }
}

test("per-paper failures become gaps while bridge exceptions and malformed results fail closed", async () => {
  const failed: LiteratureAgentResult = { agent: "LiteratureAgent", runIDs: [],
    processed: [{ paperID: "paper-frequency", documentID: "doc_fixture", status: "failed", acceptedCardIDs: [],
      rejectedCandidateCount: 0, warningCount: 0, reviewPath: "", error: "fixture PDF unreadable" }],
    summary: { paperCount: 1, acceptedCardCount: 0, paperBackedCount: 0, agentInferenceCount: 0, duplicateCount: 0, failedCount: 1 } }
  const result = await runLiteratureBridge({ run: async () => failed }, input())
  expect(result.papers[0]!.status).toBe("failed")
  expect(result.papers[0]!.error).toContain("unreadable")
  await expect(runLiteratureBridge({ run: async () => { throw new Error("KnowledgeStore corrupt") } }, input())).rejects.toThrow("KnowledgeStore corrupt")
  await expect(runLiteratureBridge({ run: async () => ({ ...failed, processed: [{ ...failed.processed[0]!, acceptedCardIDs: [42] }] }) as unknown as LiteratureAgentResult }, input())).rejects.toThrow()
})

test("partial literature retains accepted evidence and exposes partial readiness", () => {
  const value = fixture()
  value.literatureResults[0]!.status = "partial"
  const result = value.build()
  expect(result.entries.length).toBeGreaterThan(0)
  expect(result.readiness).toBe("partial_evidence")
})
