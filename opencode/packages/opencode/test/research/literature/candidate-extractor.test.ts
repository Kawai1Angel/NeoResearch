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

test("unclassified sections allow experimental protocols instead of forcing mechanism labels", async () => {
  const source = chunk({ sectionKind: "unknown" })
  const value = candidate({ cardType: "evaluation_protocol" })
  const result = await extractCandidates({ model: new FixtureExtractionModel({ [source.chunkID]: [value] }), chunks: [source], paper: {}, includeAgentInference: false })
  expect(result.candidates).toEqual([value])
  expect(result.malformed).toEqual([])
})

test("a malformed item does not discard siblings and repair receives validation feedback", async () => {
  const source = chunk()
  const model = new FixtureExtractionModel({})
  let calls = 0
  const inputs: unknown[] = []
  const custom = { ...model, modelIdentifier: "fixture", candidatePromptVersion: "fixture", verifierPromptVersion: "fixture", available: true,
    verifyEvidence: model.verifyEvidence.bind(model),
    async extractCandidates(input: unknown): Promise<unknown[]> {
      inputs.push(input)
      return calls++ === 0 ? [candidate(), { candidateID: "bad" }] : []
    },
  }
  const result = await extractCandidates({ model: custom, chunks: [source], paper: {}, includeAgentInference: false })
  expect(result.candidates).toHaveLength(1)
  expect(inputs[1]).toHaveProperty("repair.errors")
  expect(result.attempts).toHaveLength(2)
  expect(result.failedChunks).toHaveLength(0)
})

test("empty mechanisms and context-only duplicates cannot become mechanism cards", async () => {
  const source = chunk({ sectionKind: "unknown" })
  const model = new FixtureExtractionModel({ [source.chunkID]: [candidate({ cardType: "model_mechanism" })] })
  const result = await extractCandidates({ model, chunks: [source], paper: {}, includeAgentInference: false })
  expect(result.candidates).toHaveLength(0)
  expect(result.malformed[0]!.error).toContain("mechanism requires")
})
