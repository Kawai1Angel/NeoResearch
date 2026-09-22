import { expect, test } from "bun:test"
import { extractionPlan, extractCandidates } from "../../../src/research/literature/candidate-extractor"
import { FixtureExtractionModel } from "../../../src/research/literature/extraction-model"
import { candidate, chunk } from "./fixtures"

test("extraction plan only permits section-specific card types", () => {
  const plan = extractionPlan([chunk()])
  expect(plan).toHaveLength(1)
  expect(plan[0].allowedCardTypes).toEqual(["empirical_finding"])
  expect(extractionPlan([chunk({ sectionKind: "references" })])).toEqual([])
})

test("extractor rejects a card type that is not allowed in the source section", async () => {
  const source = chunk()
  const model = new FixtureExtractionModel({ [source.chunkID]: [candidate({ cardType: "model_mechanism" })] })
  const result = await extractCandidates({ model, chunks: [source], paper: {}, includeAgentInference: true })
  expect(result.candidates).toEqual([])
  expect(result.malformed[0].error).toContain("not allowed")
})
