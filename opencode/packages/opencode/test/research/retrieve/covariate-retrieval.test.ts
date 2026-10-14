import { expect, test } from "bun:test"
import { matchApplicability } from "../../../src/research/retrieve/applicability-matcher"
import { extractDatasetEvidence } from "../../../src/research/retrieve/dataset-evidence"
import { buildConceptTransformations, buildRetrievalIntents } from "../../../src/research/retrieve/retrieval-intent"
import { mapScientificConcepts } from "../../../src/research/retrieve/scientific-concept-mapper"
import { normalizeRetrieveTaskContext } from "../../../src/research/retrieve/task-evidence-builder"
import { frequencyCard, report } from "./fixtures"

test("past-only covariates produce historical queries throughout the retrieval handoff", () => {
  const value = report()
  value.dataset.knownFutureCovariates = []
  const mappings = mapScientificConcepts(value, extractDatasetEvidence(value))
  const mapping = mappings.find((item) => item.conceptID === "covariate_conditioning")!
  expect(mapping.paperTerms).toContain("historical exogenous variables")
  expect(mapping.evidence.some((item) => item.path === "$.dataset.observedPastCovariates")).toBe(true)
  const transformations = buildConceptTransformations(value, mappings)
  const intents = buildRetrievalIntents(transformations, transformations.length)
  expect(intents.some((item) => item.paperLanguageQuery.queryText.includes("past-observed covariates"))).toBe(true)
  expect(JSON.stringify({ mappings, transformations, intents })).not.toMatch(/known[ _-]future[ _-]covariates?/i)

  value.dataset.observedPastCovariates = []
  expect(mapScientificConcepts(value, extractDatasetEvidence(value)).some((item) => item.conceptID === "covariate_conditioning")).toBe(false)
})

test("generic covariate query terms do not assert future availability", () => {
  const value = report()
  const mappings = mapScientificConcepts(value, extractDatasetEvidence(value))
  const mapping = mappings.find((item) => item.conceptID === "covariate_conditioning")!
  expect(mapping.paperTerms).toContain("exogenous variables")
  const transformations = buildConceptTransformations(value, mappings)
  expect(transformations.map((item) => item.paperLanguage.queryText).join(" ")).not.toMatch(/known[ _-]future[ _-]covariates?/i)
})

test("future-covariate requirements cannot match historical conditioning through aliases", () => {
  for (const feature of ["known_future_covariates", "known future covariates", "known future covariate"]) {
    const card = frequencyCard()
    card.applicability = { ...card.applicability, dataFeatures: [feature], basis: "author_statement" }
    const value = report()
    const match = () => matchApplicability({ card, report: value,
      taskContext: normalizeRetrieveTaskContext(value).context, conceptIDs: ["covariate_conditioning"] })
    expect(match().status).toBe("matched")
    value.dataset.knownFutureCovariates = []
    expect(match().status).toBe("conflicted")
    expect(match().violatedConditions).toContain(`dataFeature:${feature}`)
  }
})
