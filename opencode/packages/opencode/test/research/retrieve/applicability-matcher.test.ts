import { expect, test } from "bun:test"
import { matchApplicability } from "../../../src/research/retrieve/applicability-matcher"
import { normalizeRetrieveTaskContext } from "../../../src/research/retrieve/task-evidence-builder"
import { frequencyCard, report } from "./fixtures"

test("same source card is re-evaluated against each task's available inputs", () => {
  const card = frequencyCard()
  card.applicability = { ...card.applicability, dataFeatures: ["known_future_covariates"], basis: "author_statement" }
  const first = report()
  const second = report()
  second.taskID = "another-task"
  second.dataset.knownFutureCovariates = []
  const before = structuredClone(card)
  const match = (value: typeof first) => matchApplicability({ card, report: value,
    taskContext: normalizeRetrieveTaskContext(value).context, conceptIDs: [] })
  expect(match(first).status).toBe("matched")
  expect(match(second).status).toBe("conflicted")
  expect(match(second).violatedConditions).toContain("dataFeature:known_future_covariates")
  expect(card).toEqual(before)
})

test("missing diagnoses and arbitrary retrieval concepts do not establish conditions", () => {
  const card = frequencyCard()
  card.applicability.dataFeatures = ["multiple_seasonalities"]
  const value = report()
  value.statistics.frequency.spectralPeaks = []
  const result = matchApplicability({ card, report: value, taskContext: normalizeRetrieveTaskContext(value).context,
    conceptIDs: ["multiple_seasonalities"] })
  expect(result.status).toBe("partial")
  expect(result.uncertainConditions).toContain("dataFeature:multiple_seasonalities")
  expect(result.violatedConditions).toEqual([])
})

test("complete diagnosis is used even when the bound intent omits a condition", () => {
  const card = frequencyCard()
  const value = report()
  expect(matchApplicability({ card, report: value, taskContext: normalizeRetrieveTaskContext(value).context,
    conceptIDs: [] }).status).toBe("matched")
  card.applicability.basis = "unknown"
  const unreviewed = matchApplicability({ card, report: value, taskContext: normalizeRetrieveTaskContext(value).context,
    conceptIDs: ["multiple_seasonalities"] })
  expect(unreviewed.status).toBe("partial")
  expect(unreviewed.matchedConditions).toEqual([])
})

test("empty scope remains unknown and point/interval objectives are checked explicitly", () => {
  const card = frequencyCard()
  const value = report()
  const taskContext = normalizeRetrieveTaskContext(value).context
  card.applicability = { taskTypes: [], dataFeatures: [], domains: [], dataScale: [], horizonProfile: [], computeProfile: [], basis: "unknown" }
  expect(matchApplicability({ card, report: value, taskContext, conceptIDs: [] }).status).toBe("unknown")
  card.applicability = { ...card.applicability, taskTypes: ["probabilistic_forecasting"], basis: "author_statement" }
  expect(matchApplicability({ card, report: value, taskContext, conceptIDs: [] }).status).toBe("conflicted")
  taskContext.objective.probabilistic = true
  expect(matchApplicability({ card, report: value, taskContext, conceptIDs: [] }).status).toBe("matched")
})
