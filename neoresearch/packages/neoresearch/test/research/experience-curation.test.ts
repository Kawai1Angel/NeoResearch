import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import fixture from "./fixtures/experience-recall.json"
import { experienceFromMemory, experienceSummaryForPrompt } from "../../src/research/experience"
import { ExperienceLibrary } from "../../src/research/experience-library"
import { groundedExperienceInterpretation, experienceSourceDigest, type ExperienceCuration } from "../../src/research/experience-curation"
import type { ResearchMemory } from "../../src/research/schema"
import { tmpdir } from "../fixture/fixture"

const source = { projectID: "curation-test", projectRoot: "/curation-test" }
function memory(suffix = "a") {
  const original = fixture.records.find(entry => entry.id === "rmem_1477bacd3001Wtk2lW5pPQdXjj")!
  const result = structuredClone(original) as unknown as ResearchMemory
  const experience = experienceFromMemory(result)!
  experience.draft.statement = "bogusforbiddenfamily is globally unusable forever"
  experience.unverifiedInterpretation = structuredClone(experience.draft)
  return { ...result, id: `rmem_curation_${suffix}`,
    candidateSummary: { ...result.candidateSummary, experienceKey: `curation-${suffix}`, experience } } as unknown as ResearchMemory
}
function review(memory: ResearchMemory, status: ExperienceCuration["status"] = "rewritten"): ExperienceCuration {
  return { schemaVersion: "experience_curation.v1", status, sourceDigest: experienceSourceDigest(JSON.stringify(memory)),
    reviewer: "curation-regression-test", reviewedAt: 1, reasons: ["unsupported_architecture_ban"], notes: [],
    interpretation: groundedExperienceInterpretation(experienceFromMemory(memory)!) }
}

test("curated defaults remove withdrawn prose while immutable source facts and explicit original audit remain", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "experience.db"), library = new ExperienceLibrary(file)
  const original = memory()
  try {
    library.save(original, source)
    const db = new Database(file, { readonly: true })
    const before = db.query("SELECT memory_json FROM research_experience").get()
    library.curate([{ experienceID: original.id, review: review(original) }])
    const current = library.list()[0]!
    expect(experienceFromMemory(current)!.facts).toEqual(experienceFromMemory(original)!.facts)
    expect(JSON.stringify(experienceSummaryForPrompt(current))).not.toContain("bogusforbiddenfamily")
    expect(library.list({ query: "bogusforbiddenfamily", includeBackground: true })).toEqual([])
    expect(experienceSummaryForPrompt(current).organization?.conditionalExperience.status).toBe("explicit_hypothesis")
    expect(experienceSummaryForPrompt(current).curation).toMatchObject({ status: "rewritten", originalRetained: true })
    expect(experienceSummaryForPrompt(library.list({ experienceID: original.id, includeOriginal: true })[0]!).originalForAuditOnly?.unverifiedInterpretation?.statement).toContain("bogusforbiddenfamily")
    expect(db.query("SELECT memory_json FROM research_experience").get()).toEqual(before)
    expect(() => library.list({ includeOriginal: true })).toThrow("exact experienceID")
    db.close()
  } finally { library.close() }
})

test("merged IDs resolve to the canonical record; archive browsing preserves both without inflating support", async () => {
  await using tmp = await tmpdir()
  const library = new ExperienceLibrary(path.join(tmp.path, "experience.db"))
  const a = memory("a"), b = memory("b")
  try {
    library.save(a, source); library.save(b, source)
    library.curate([{ experienceID: a.id, review: review(a, "retained") },
      { experienceID: b.id, review: { ...review(b, "merged"), canonicalExperienceID: a.id } }])
    expect(library.list()).toHaveLength(1)
    expect(library.list({ experienceID: b.id })[0]?.id).toBe(a.id)
    expect(library.list({ includeArchived: true })).toHaveLength(2)
    expect(library.list({ experienceID: b.id, includeOriginal: true })[0]?.id).toBe(b.id)
    const organization = experienceSummaryForPrompt(library.list()[0]!).organization!
    expect(organization.validatedRegularity.supportDatasetContentCount).toBe(1)
    expect(organization.revision).toBe(2)
    expect(organization.experimentFacts.sourceExperienceIDs).toHaveLength(1)
    library.rebuildOrganizations()
    expect(library.list()).toHaveLength(1)
  } finally { library.close() }
})

test("quarantine excludes every default retrieval path and cannot contribute a claim or become a parent", async () => {
  await using tmp = await tmpdir()
  const library = new ExperienceLibrary(path.join(tmp.path, "experience.db"))
  const a = memory()
  try {
    library.save(a, source); library.curate([{ experienceID: a.id, review: review(a, "quarantined") }])
    expect(library.list()).toEqual([])
    expect(library.list({ experienceID: a.id })).toEqual([])
    expect(library.list({ query: "width", includeBackground: true })).toEqual([])
    const archived = library.list({ experienceID: a.id, includeArchived: true })[0]!
    expect(experienceSummaryForPrompt(archived).organization!.validatedRegularity.supportingDatasets).toEqual([])
    const b = memory("b"), experience = experienceFromMemory(b)!
    experience.unverifiedInterpretation!.evolution = { parentExperienceID: a.id, relation: "supports" }
    expect(() => library.save({ ...b, candidateSummary: { ...b.candidateSummary, experience } } as unknown as ResearchMemory, source)).toThrow("active canonical parent")
  } finally { library.close() }
})

test("stale reviews, altered evidence and merges of different observations roll back atomically", async () => {
  await using tmp = await tmpdir()
  const library = new ExperienceLibrary(path.join(tmp.path, "experience.db"))
  const a = memory("a"), b = memory("b")
  const bx = experienceFromMemory(b)!
  bx.facts[0]!.dataset.identity = "other-dataset"
  bx.facts[1]!.dataset.identity = "other-dataset"
  const different = { ...b, candidateSummary: { ...b.candidateSummary, experience: bx } } as unknown as ResearchMemory
  try {
    library.save(a, source); library.save(different, source)
    expect(() => library.curate([{ experienceID: a.id, review: { ...review(a), sourceDigest: "0".repeat(64) } }])).toThrow("stale")
    const altered = review(a); altered.interpretation.evidence[0]!.relation = "refutes"
    expect(() => library.curate([{ experienceID: a.id, review: altered }])).toThrow("relabel")
    expect(() => library.curate([{ experienceID: a.id, review: review(a) },
      { experienceID: different.id, review: { ...review(different, "merged"), canonicalExperienceID: a.id } }])).toThrow("same captured evidence")
    expect(library.list()[0]!.candidateSummary.experienceCuration).toBeUndefined()
    expect(library.list()).toHaveLength(2)
  } finally { library.close() }
})

test("same run IDs with conflicting factual snapshots cannot be merged", async () => {
  await using tmp = await tmpdir()
  const library = new ExperienceLibrary(path.join(tmp.path, "experience.db"))
  const a = memory("a"), b = memory("b"), bx = experienceFromMemory(b)!
  bx.facts[0]!.metrics.conflicting_probe = 1
  const changed = { ...b, candidateSummary: { ...b.candidateSummary, experience: bx } } as unknown as ResearchMemory
  try {
    library.save(a, source); library.save(changed, source)
    expect(() => library.curate([{ experienceID: changed.id,
      review: { ...review(changed, "merged"), canonicalExperienceID: a.id } }])).toThrow("same captured evidence")
    expect(library.list()).toHaveLength(2)
  } finally { library.close() }
})

test("curation updates advance the version and invalidate an already open reader", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "experience.db"), reader = new ExperienceLibrary(file), writer = new ExperienceLibrary(file)
  const a = memory()
  try {
    writer.save(a, source)
    const before = experienceSummaryForPrompt(reader.list()[0]!).organization!
    writer.curate([{ experienceID: a.id, review: review(a) }])
    const after = experienceSummaryForPrompt(reader.list()[0]!).organization!
    expect(after.revision).toBe(before.revision + 1)
    expect(writer.history(a.id).map(version => version.revision)).toEqual([before.revision, after.revision])
    expect(after.conditionalExperience.claim).not.toBe(before.conditionalExperience.claim)
    expect(JSON.stringify(after)).not.toContain("bogusforbiddenfamily")
  } finally { reader.close(); writer.close() }
})
