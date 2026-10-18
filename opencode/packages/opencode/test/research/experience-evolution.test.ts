import { expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import path from "node:path"
import fixture from "./fixtures/experience-recall.json"
import { experienceFromMemory, experienceSummaryForPrompt } from "../../src/research/experience"
import { ExperienceClaimSchema, ExperienceEvolutionSchema, experienceClaimKey, organizeExperienceThread, type ExperienceEntry } from "../../src/research/experience-evolution"
import { ExperienceLibrary } from "../../src/research/experience-library"
import { ResearchMemoryID, ResearchTaskID, type ResearchMemory } from "../../src/research/schema"
import { tmpdir } from "../fixture/fixture"

const source = { projectID: "evolution-test", projectRoot: "/evolution-test" }
const claim = {
  statement: "Under the recorded source conditions, widening the MLP backbone reduces CV MSE.",
  dataConditions: ["Source dataset profiles and evaluation scope must be checked before transfer."],
  operation: "Increase backbone hidden dimension", interventionPaths: ["backbone.hiddenDim"],
  expectedOutcome: { metric: "cv_avg_mse", direction: "lower" as const },
  boundaries: ["Single-field controlled contrasts only; source recipe scope applies."],
  validationPlan: "Repeat this isolated width contrast on another dataset content and seed; retain any opposite outcome.",
}

function memory(suffix: string, hash: string, delta: number, parent?: string): ResearchMemory {
  const original = fixture.records.find(record => record.id === "rmem_1477bacd3001Wtk2lW5pPQdXjj")!
  const cloned = structuredClone(original) as unknown as ResearchMemory
  const value = { ...cloned, candidateSummary: { ...cloned.candidateSummary } }
  value.id = ResearchMemoryID.make(`rmem_evolution_${suffix}`)
  value.taskID = ResearchTaskID.make(`rtsk_evolution_${suffix}`)
  value.candidateSummary.experienceKey = `evolution-${suffix}`
  const experience = experienceFromMemory(value)!
  const ids = new Map(experience.facts.map(fact => [fact.runID, `${fact.runID}-${suffix}`]))
  for (const fact of experience.facts) {
    fact.taskID = value.taskID
    fact.runID = ids.get(fact.runID)!
    fact.dataset = { ...fact.dataset, identity: `sha256:${hash}`, contentHash: hash,
      specification: { ...fact.dataset.specification, path: `${hash}.csv` } }
    const contract = fact.hypothesisSnapshot?.experimentContract as { comparisonRunID?: string } | undefined
    if (contract?.comparisonRunID) contract.comparisonRunID = ids.get(contract.comparisonRunID) ?? contract.comparisonRunID
  }
  const trial = experience.facts[0]!
  const control = experience.facts[1]!
  trial.primaryValue = control.primaryValue! + delta
  trial.metrics[trial.primaryMetric] = trial.primaryValue
  experience.draft.evidence = [{ runID: trial.runID, comparisonRunID: control.runID, relation: "supports" }]
  // A negative local observation still cites its own result as supporting factual evidence.
  experience.draft.evolution = parent ? { parentExperienceID: parent, relation: delta < 0 ? "supports" : "refutes" }
    : { relation: delta < 0 ? "supports" : "refutes", claim }
  experience.unverifiedInterpretation = structuredClone(experience.draft)
  value.candidateSummary.experience = experience as unknown as ResearchMemory["candidateSummary"]
  value.time = { created: suffix.charCodeAt(0), updated: suffix.charCodeAt(0) }
  return value
}
const entry = (memory: ResearchMemory): ExperienceEntry => ({ id: memory.id, domainID: memory.domainID, time: memory.time, experience: experienceFromMemory(memory)! })

test("every historical entry gets all three parts without inventing conditional validation or rewriting evidence", () => {
  const before = JSON.stringify(fixture.records)
  for (const memory of fixture.records as unknown as ResearchMemory[]) {
    const e = entry(memory)
    const result = organizeExperienceThread(e, [e])
    expect(result.experimentFacts.facts).toEqual(e.experience.facts)
    expect(result.conditionalExperience.status).toBe("legacy_needs_formulation")
    expect(result.conditionalExperience.observedRelationships.length).toBeGreaterThan(0)
    expect(result.validatedRegularity.status).toBe("not_validated")
    expect(result.validatedRegularity.supportingDatasets).toEqual([])
    expect(result.validatedRegularity.unassessedDatasets.length).toBeGreaterThan(0)
  }
  expect(JSON.stringify(fixture.records)).toBe(before)
})

test("multi-dataset support, a counterexample and original facts accumulate under one stable claim", async () => {
  await using tmp = await tmpdir()
  const library = new ExperienceLibrary(path.join(tmp.path, "experiences.db"))
  const a = memory("a", "dataset-a", -.01)
  const b = memory("b", "dataset-b", -.02, a.id)
  const c = memory("c", "dataset-c", .03, b.id)
  try {
    library.save(a, source)
    library.save(b, source)
    const supported = experienceSummaryForPrompt(library.list({ experienceID: a.id })[0]!).organization!
    expect(supported.validatedRegularity.status).toBe("corroborated_pending_review")
    expect(supported.validatedRegularity.supportDatasetContentCount).toBe(2)
    library.save(c, source)
    for (const id of [a.id, b.id, c.id]) {
      const current = library.list({ experienceID: id })[0]!
      const organization = experienceSummaryForPrompt(current).organization!
      expect(organization.threadID).toBe(a.id)
      expect(organization.revision).toBe(3)
      expect(organization.conditionalExperience.claim).toBe(claim.statement)
      expect(organization.validatedRegularity.status).toBe("contested")
      expect(organization.validatedRegularity.supportingDatasets).toHaveLength(2)
      expect(organization.validatedRegularity.counterexampleDatasets[0]?.contentHash).toBe("dataset-c")
      expect(organization.validatedRegularity.missing).toContain("unresolved_counterevidence")
      expect(organization.experimentFacts.facts).toHaveLength(6)
    }
    expect(library.list({ threadID: a.id })).toHaveLength(3)
    expect(library.list({ query: "MLP width", intent: "intervention" })).toHaveLength(1)
    expect(library.list({ experienceID: a.id })[0]!.candidateSummary.experience).toEqual(a.candidateSummary.experience)
    expect(library.save(c, source).created).toBe(false)
  } finally { library.close() }
})

test("copies of one dataset and repeated citations cannot establish cross-dataset support", () => {
  const a = entry(memory("a", "same-content", -.01))
  const b = entry(memory("b", "same-content", -.02, a.id))
  const result = organizeExperienceThread(a, [a, b, b])
  expect(result.validatedRegularity.supportDatasetContentCount).toBe(1)
  expect(result.validatedRegularity.supportingDatasets).toHaveLength(1)
  expect(result.validatedRegularity.status).toBe("not_validated")
})

test("scoped validation requires a review covering every observed outcome, and a later counterexample downgrades it", () => {
  const a = entry(memory("a", "a", -.01))
  const b = entry(memory("b", "b", -.02, a.id))
  const review = { evidenceRunIDs: [a.experience.facts[0]!.runID, b.experience.facts[0]!.runID],
    conditionsAssessment: "Both recorded source dataset profiles fall inside the stated scope.",
    implementationAssessment: "Both controls differ only in backbone.hiddenDim.",
    rationale: "Two independent dataset contents agree in numerical direction; significance is not established.",
    applicabilityBoundaries: ["Only the recorded MLP recipes and source evaluation contexts."],
    limitations: ["Single seed in each task; no universal capacity law."] }
  b.experience.unverifiedInterpretation!.evolution!.scopeReview = review
  expect(organizeExperienceThread(a, [a, b]).validatedRegularity.status).toBe("validated_in_scope")
  b.experience.unverifiedInterpretation!.evolution!.scopeReview = { ...review, evidenceRunIDs: [b.experience.facts[0]!.runID] }
  expect(organizeExperienceThread(a, [a, b]).validatedRegularity.status).toBe("corroborated_pending_review")
  b.experience.unverifiedInterpretation!.evolution!.scopeReview = review
  const c = entry(memory("c", "c", .03, b.id))
  const contested = organizeExperienceThread(a, [a, b, c])
  expect(contested.validatedRegularity.status).toBe("contested")
  expect(contested.validatedRegularity.scopeReview?.eligible).toBe(false)
})

test("conflicting snapshots of one run remain visible and cannot establish a validated law", () => {
  const a = entry(memory("a", "a", -.01))
  const b = entry(memory("b", "b", -.02, a.id))
  b.experience.facts.push({ ...a.experience.facts[0]!, primaryValue: 100 })
  const result = organizeExperienceThread(a, [a, b])
  expect(result.experimentFacts.conflictingRunIDs).toContain(a.experience.facts[0]!.runID)
  expect(result.experimentFacts.facts).toHaveLength(5)
  expect(result.validatedRegularity.missing).toContain("conflicting_source_snapshots")
})

test("an opposite measured outcome is retained as counterevidence even if the agent declares support", () => {
  const a = entry(memory("a", "a", -.01))
  const b = entry(memory("b", "b", .04, a.id))
  b.experience.unverifiedInterpretation!.evolution!.relation = "supports"
  const result = organizeExperienceThread(a, [a, b])
  const opposing = result.conditionalExperience.observedEffects.find(item => item.experienceID === b.id)!
  expect(opposing.requestedRelation).toBe("supports")
  expect(opposing.relation).toBe("refutes")
  expect(opposing.relationMismatch).toBe(true)
  expect(result.validatedRegularity.status).toBe("contested")
})

test("an execution failure cannot refute a performance claim; extra recipe changes cannot isolate width", () => {
  const a = entry(memory("a", "a", -.01))
  const failure = entry(memory("f", "f", .01, a.id))
  const fact = failure.experience.facts[0]!
  fact.stage = "smoke"; fact.status = "failed"; fact.error = "CUDA out of memory"; fact.primaryValue = undefined; fact.metrics = {}
  const joint = entry(memory("j", "j", -.02, a.id))
  const contract = joint.experience.facts[0]!.hypothesisSnapshot!.experimentContract as { changes: unknown[] }
  contract.changes.push({ operation: "set", path: "trainingStrategy.optimizer.lr", before: .0003, after: .0001 })
  ;(joint.experience.facts[0]!.proposedModel!.trainingStrategy as { optimizer: { lr: number } }).optimizer.lr = .0001
  const result = organizeExperienceThread(a, [a, failure, joint])
  expect(result.validatedRegularity.counterexampleDatasets).toEqual([])
  expect(result.validatedRegularity.supportDatasetContentCount).toBe(1)
  expect(result.validatedRegularity.unassessedDatasets).toHaveLength(2)
})

test("source entries and materialized three-part organizations survive reopen and rebuilding", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "experiences.db")
  const a = memory("a", "a", -.01)
  let library = new ExperienceLibrary(file)
  library.save(a, source); library.close()
  const db = new SQLite(file)
  const before = db.query("SELECT memory_json FROM research_experience").get()
  db.exec("DELETE FROM research_experience_organization"); db.close()
  library = new ExperienceLibrary(file)
  try {
    const result = experienceSummaryForPrompt(library.list()[0]!).organization!
    expect(result.experimentFacts.facts).toHaveLength(2)
    expect(result.conditionalExperience.status).toBe("explicit_hypothesis")
    const db = new SQLite(file, { readonly: true })
    expect(db.query("SELECT memory_json FROM research_experience").get()).toEqual(before)
    db.close()
  } finally { library.close() }
})

test("identical structured root claims join one thread while different meanings and domains stay separate", async () => {
  await using tmp = await tmpdir()
  const library = new ExperienceLibrary(path.join(tmp.path, "experiences.db"))
  try {
    const a = memory("a", "a", -.01); const b = memory("b", "b", -.02)
    library.save(a, source); library.save(b, source)
    const organization = experienceSummaryForPrompt(library.list({ experienceID: b.id })[0]!).organization!
    expect(organization.threadID).toBe(a.id)
    expect(organization.validatedRegularity.supportDatasetContentCount).toBe(2)
    expect(library.list({ threadID: b.id })).toHaveLength(2)
    const c = memory("c", "c", -.03)
    const experience = experienceFromMemory(c)!
    experience.unverifiedInterpretation!.evolution!.claim!.expectedOutcome.direction = "higher"
    const changed = { ...c, candidateSummary: { ...c.candidateSummary, experience: experience as unknown as ResearchMemory["candidateSummary"] } }
    library.save(changed, source)
    expect(experienceSummaryForPrompt(library.list({ experienceID: c.id })[0]!).organization!.threadID).toBe(c.id)
  } finally { library.close() }
})

test("another process's continuation is visible to an already open reader", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "experiences.db")
  const reader = new ExperienceLibrary(file); const writer = new ExperienceLibrary(file)
  try {
    const a = memory("a", "a", -.01); writer.save(a, source)
    expect(experienceSummaryForPrompt(reader.list()[0]!).organization!.revision).toBe(1)
    writer.save(memory("b", "b", .02, a.id), source)
    const updated = experienceSummaryForPrompt(reader.list({ experienceID: a.id })[0]!).organization!
    expect(updated.revision).toBe(2)
    expect(updated.validatedRegularity.status).toBe("contested")
  } finally { reader.close(); writer.close() }
})

test("unknown/cross-domain parents and silent changes to the claim are rejected", async () => {
  expect(ExperienceEvolutionSchema.safeParse({ parentExperienceID: "existing", relation: "supports", claim }).success).toBe(false)
  expect(ExperienceClaimSchema.safeParse({ ...claim, expectedOutcome: { metric: "cv_avg_mse", direction: "equivalent" } }).success).toBe(false)
  await using tmp = await tmpdir()
  const library = new ExperienceLibrary(path.join(tmp.path, "experiences.db"))
  try {
    expect(() => library.save(memory("b", "b", -.01, "missing"), source)).toThrow("existing parent")
    const a = memory("a", "a", -.01); library.save(a, source)
    const b = { ...memory("b", "b", -.01, a.id), domainID: "other-domain" }
    expect(() => library.save(b, source)).toThrow("same domain")
  } finally { library.close() }
})

test("appending keeps one canonical experience and preserves versioned conclusions and boundaries", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "experiences.db")
  let library = new ExperienceLibrary(file)
  const a = memory("a", "dataset-a", -.01)
  const b = memory("b", "dataset-b", -.02, a.id)
  let c = memory("c", "dataset-c", .03, a.id)
  const boundary = "The opposite result applies to dataset-c's captured configuration; transfer remains provisional."
  const opposing = experienceFromMemory(c)!
  opposing.unverifiedInterpretation!.boundaries.push(boundary)
  c = { ...c, candidateSummary: { ...c.candidateSummary, experience: opposing as unknown as ResearchMemory["candidateSummary"] } }
  try {
    const initial = library.save(a, source)
    expect(initial.experienceCreated).toBe(true)
    expect(initial.appended).toBe(false)
    expect(initial.canonicalExperienceID).toBe(a.id)
    expect(initial.revision).toBe(1)
    const original = structuredClone(library.history(a.id))
    const appended = library.save(b, source)
    expect(appended.experienceCreated).toBe(false)
    expect(appended.appended).toBe(true)
    expect(appended.canonicalExperienceID).toBe(a.id)
    expect(appended.sourceEntryID).toBe(b.id)
    expect(appended.revision).toBe(2)
    expect(library.save(c, source).revision).toBe(3)
    expect(library.list()).toHaveLength(1)
    expect(library.list({ threadID: a.id })).toHaveLength(3)
    const record = library.list({ experienceID: a.id, includeHistory: true })[0]!
    const organization = experienceSummaryForPrompt(record).organization!
    expect(organization.conditionalExperience.claim).toBe(claim.statement)
    expect(organization.conditionalExperience.currentConclusion.status).toBe("contested")
    expect(organization.conditionalExperience.currentConclusion.supportingRunIDs).toHaveLength(2)
    expect(organization.conditionalExperience.currentConclusion.counterexampleRunIDs).toEqual([
      experienceFromMemory(c)!.facts[0]!.runID,
    ])
    expect(organization.validatedRegularity.applicabilityBoundaries).toContain(boundary)
    expect(organization.experimentFacts.facts).toHaveLength(6)
    expect(JSON.stringify(experienceSummaryForPrompt(record).history)).toBe(JSON.stringify(library.history(a.id)))
    expect(library.history(a.id)[0]).toEqual(original[0])
    expect(library.history(b.id).map(version => version.revision)).toEqual([1, 2, 3])
    expect(library.history(a.id)[1]!.validatedRegularity.status).toBe("corroborated_pending_review")
    expect(library.history(a.id)[2]!.validatedRegularity.status).toBe("contested")
    expect(library.history(a.id)[0]).not.toHaveProperty("experimentFacts")
    const retry = library.save(c, source)
    expect(retry.created).toBe(false)
    expect(retry.appended).toBe(false)
    expect(retry.revision).toBe(3)
    library.rebuildOrganizations()
    expect(library.history(a.id)).toHaveLength(3)
    const db = new SQLite(file, { readonly: true })
    const raw = db.query("SELECT memory_json FROM research_experience WHERE id=?").get(a.id) as { memory_json: string }
    expect(JSON.parse(raw.memory_json)).toEqual(a)
    db.close()
    library.close()
    library = new ExperienceLibrary(file)
    expect(library.history(a.id)).toHaveLength(3)
    expect(library.history(a.id)[0]).toEqual(original[0])
    expect(() => library.list({ includeHistory: true })).toThrow("exact experienceID")
  } finally { library.close() }
})

test("equivalent claim formatting and a new validation plan append without merging different scientific scope", async () => {
  await using tmp = await tmpdir()
  const library = new ExperienceLibrary(path.join(tmp.path, "experiences.db"))
  try {
    const a = memory("a", "a", -.01)
    let b = memory("b", "b", -.02)
    const next = experienceFromMemory(b)!
    const hypothesis = next.unverifiedInterpretation!.evolution!.claim!
    hypothesis.statement = `  ${hypothesis.statement.replaceAll(" ", "  ")}  `
    hypothesis.interventionPaths = ["backbone.hidden_dim"]
    hypothesis.validationPlan = "Repeat with independent seeds while keeping the same conditional proposition."
    b = { ...b, candidateSummary: { ...b.candidateSummary, experience: next as unknown as ResearchMemory["candidateSummary"] } }
    expect(experienceClaimKey(a.domainID, claim)).toBe(experienceClaimKey(b.domainID, hypothesis))
    library.save(a, source)
    const appended = library.save(b, source)
    expect(appended.canonicalExperienceID).toBe(a.id)
    expect(appended.appended).toBe(true)
    const original = memory("c", "c", -.01)
    const scoped = experienceFromMemory(original)!
    scoped.unverifiedInterpretation!.evolution!.claim!.dataConditions = ["A different substantive data condition."]
    const different = { ...original, candidateSummary: { ...original.candidateSummary,
      experience: scoped as unknown as ResearchMemory["candidateSummary"] } }
    const created = library.save(different, source)
    expect(created.experienceCreated).toBe(true)
    expect(created.canonicalExperienceID).toBe(different.id)
    expect(library.list()).toHaveLength(2)
  } finally { library.close() }
})

test("importing an older observation preserves the existing canonical experience ID", async () => {
  await using tmp = await tmpdir()
  const library = new ExperienceLibrary(path.join(tmp.path, "experiences.db"))
  try {
    const a = memory("a", "a", -.01)
    library.save(a, source)
    const imported = { ...memory("z", "z", -.02), time: { created: 0, updated: 0 } }
    const result = library.save(imported, { projectID: "imported-project", projectRoot: "/imported" })
    expect(result.appended).toBe(true)
    expect(result.canonicalExperienceID).toBe(a.id)
    expect(library.list()).toHaveLength(1)
    expect(library.history(a.id).map(version => version.revision)).toEqual([1, 2])
    expect(experienceSummaryForPrompt(result.memory).organization!.experimentFacts.facts).toHaveLength(4)
  } finally { library.close() }
})

test("an existing library gains revision history on append without rewriting its source records", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "experiences.db")
  const a = memory("a", "a", -.01)
  let library = new ExperienceLibrary(file)
  library.save(a, source)
  library.close()
  const db = new SQLite(file)
  const previous = db.query("SELECT organization_json FROM research_experience_thread WHERE thread_id=?").get(a.id) as { organization_json: string }
  const oldView = JSON.parse(previous.organization_json)
  delete oldView.updatedAt
  delete oldView.conditionalExperience.currentConclusion
  db.query("UPDATE research_experience_thread SET organization_json=? WHERE thread_id=?").run(JSON.stringify(oldView), a.id)
  db.exec("DROP TABLE research_experience_thread_version")
  const raw = db.query("SELECT memory_json FROM research_experience WHERE id=?").get(a.id)
  db.close()
  library = new ExperienceLibrary(file)
  try {
    const result = library.save(memory("b", "b", .02, a.id), source)
    expect(result.appended).toBe(true)
    expect(result.revision).toBe(2)
    expect(library.history(a.id).map(version => version.revision)).toEqual([1, 2])
    expect(library.history(a.id)[1]!.validatedRegularity.status).toBe("contested")
    const db = new SQLite(file, { readonly: true })
    expect(db.query("SELECT memory_json FROM research_experience WHERE id=?").get(a.id)).toEqual(raw)
    db.close()
  } finally { library.close() }
})
