import { expect, test } from "bun:test"
import { includesPhrase, type BM25SearchResult } from "../../../src/research/retrieve/bm25-search"
import { buildRetrievalCandidates, selectBridgeCandidates } from "../../../src/research/retrieve/candidate-selector"
import { fixture } from "./fixtures"

function result(title: string, rank: number, introduction = ""): BM25SearchResult {
  return { rank, score: 100 - rank, matchedFields: ["title"], matchedTerms: ["structural breaks"],
    paper: { paperID: `paper-${rank}`, title, localPDF: true, publicationStatus: "unknown", evidenceLevel: "metadata_only",
      fields: { title, abstract: "", introduction, method: "", results: "", limitations: "", knowledgeCard: "" } } }
}

test("partial structural match cannot pass the scientific screen", () => {
  expect(includesPhrase("Patch-wise Structural Loss", "structural breaks")).toBe(false)
  const intent = fixture().intents.find((item) => item.intentID.includes("structural_break"))!
  const candidates = buildRetrievalCandidates(intent, [result("Patch-wise Structural Loss", 1)], 5)
  expect(candidates[0]!.decision).toBe("domain_only")
})

test("direct lagged correlation method outranks background mentions before reading quotas", () => {
  const intent = { ...fixture().intents[0]!, intentID: "intent_lead_lag_relationship_fixture", paperLanguageQuery: {
    taskTerms: ["forecasting"], phenomenonTerms: ["lead-lag relationship"], methodTerms: ["lag-aware feature fusion"], domainTerms: [], queryText: "lead lag correlation forecasting",
  } }
  const papers = Array.from({ length: 5 }, (_, i) => result("Forecasting overview", i + 1, "Prior work models lead lag dependencies."))
  const values = buildRetrievalCandidates(intent, [...papers, result("Variable Correlation Transformer with Inherent Lagged Correlation", 10)], 1)
  expect(values.find((item) => item.paperID === "paper-10")!.decision).toBe("send_to_literature_agent")
  expect(selectBridgeCandidates(values, { maxLiteraturePapersTotal: 1 })[0]!.paperID).toBe("paper-10")
})

test("conformal change-point work is auxiliary for point forecasting", () => {
  const intent = fixture().intents.find((item) => item.intentID.includes("structural_break"))!
  const paper = result("Conformal Prediction with Change Points", 1)
  expect(buildRetrievalCandidates(intent, [paper], 5, false)[0]!.decision).toBe("retain_candidate")
  expect(buildRetrievalCandidates(intent, [paper], 5, true)[0]!.decision).toBe("send_to_literature_agent")
})
