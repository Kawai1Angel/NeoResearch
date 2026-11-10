import { expect, test } from "bun:test"
import fixture from "./fixtures/experience-recall.json"
import { experienceFromMemory, validateExperienceEvidence, projectExperience } from "../../src/research/experience"
import { experienceRepresentation } from "../../src/research/experience-representation"
import { rankExperiences } from "../../src/research/experience-search"
import type { ResearchMemory } from "../../src/research/schema"

const entries = (fixture.records as unknown as ResearchMemory[]).map(memory => ({ memory, experience: experienceFromMemory(memory)! }))
const record = (id: string) => entries.find(entry => entry.memory.id === id)!

test("audited real width contrast ranks first, ahead of unchanged-width normalization and head-only capacity", () => {
  const result = rankExperiences(entries, "backbone hidden dimension width capacity sensitivity time series forecasting")
  expect(String(result[0]?.id)).toBe("rmem_1477bacd3001Wtk2lW5pPQdXjj")
  expect(result.map(entry => String(entry.id))).not.toContain("rmem_14438d5dc0013UgmS4dLG0NIZp")
  expect(result.map(entry => String(entry.id))).not.toContain("rmem_14568e0d6001IBiXHTAYSqaA0E")
})

test("real cuDNN failures match only observed error evidence, with no filler when evidence is absent", () => {
  const query = "cudnn RNN backward training mode execution failure rnn"
  const result = rankExperiences(entries, query)
  expect(new Set(result.map(entry => String(entry.id)))).toEqual(new Set(["rmem_147e16eb1001QssM8yWBOidpfT", "rmem_147e2b875001YhKpfibLhHGsep"]))
  expect(rankExperiences(entries.filter(entry => !entry.experience.facts.some(fact => fact.error?.includes("cudnn"))), query)).toEqual([])
  for (const memory of result) {
    const view = experienceRepresentation(experienceFromMemory(memory)!)
    expect(view.executionLesson).toMatchObject({ status: "failure_observed", diagnosis: "unverified", repair: "not_established" })
    expect(view.interventions.every(change => !change.contrast)).toBe(true)
  }
})

test("real frequency execution is discoverable but a planned frequency experiment is not factual evidence", () => {
  const result = rankExperiences(entries, "frequency rFFT FFT embedding tokenization spectral vs time-domain input")
  expect(result.map(entry => String(entry.id))).toContain("rmem_144c74802001CZ4zRnvOfuZT0y")
  expect(result.map(entry => String(entry.id))).not.toContain("rmem_144c379ad0015459VGOpncXOCr")
  const view = experienceRepresentation(record("rmem_144c74802001CZ4zRnvOfuZT0y").experience)
  expect(view.observations.some(observation => observation.recordedStatus === "rejected" && observation.executionStatus === "succeeded" && !observation.error)).toBe(true)
  expect(view.observations.some(observation => observation.historicalEvaluationError)).toBe(true)
})

test("semantic overreach stays provisional while seed-only and tiny metric contrasts remain factual", () => {
  const overreach = experienceRepresentation(record("rmem_144ad40b1001rB92ombIaizSuS").experience)
  expect(overreach.interpretation.status).toBe("unverified_interpretation")
  expect(overreach.interventions.every(change => change.changes.every(item => item.path.endsWith(".seed")))).toBe(true)
  const tiny = experienceRepresentation(record("rmem_144b91bbf001ZSscgTuEuI8dsp").experience)
  const contrast = tiny.interventions.find(change => change.contrast)?.contrast
  expect(contrast?.measuredDirection).toBe("improved")
  expect(contrast?.uncertainty).toContain("not established")
})

test("all selected source records validate and derived representations leave evidence and original prose unchanged", () => {
  const before = JSON.stringify(entries)
  for (const entry of entries) {
    validateExperienceEvidence(entry.experience.draft, entry.experience.facts)
    const projection = projectExperience(entry.experience)
    expect(projection.representation.version).toBe("experience_evidence.v2")
    expect(projection).not.toHaveProperty("mechanismHypothesis")
    expect(projection).not.toHaveProperty("validationPlan")
    expect(projection.representation.evidenceScope.distinctRuns).toBe(new Set(entry.experience.facts.map(fact => fact.runID)).size)
  }
  expect(JSON.stringify(entries)).toBe(before)
  const experience = entries[0]!.experience
  expect(() => validateExperienceEvidence(experience.draft, [...experience.facts, experience.facts[0]!])).toThrow("unique run IDs")
})
