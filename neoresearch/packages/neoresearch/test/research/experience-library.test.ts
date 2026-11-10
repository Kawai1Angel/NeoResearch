import { afterEach, expect, spyOn, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Global } from "@neoresearch-ai/core/global"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@neoresearch-ai/core/cross-spawn-spawner"
import { ExperienceLibrary, experienceLibraryPath } from "../../src/research/experience-library"
import { readExperiences } from "../../src/research/experience-store"
import { Research } from "../../src/research"
import { ResearchMemoryID, ResearchTaskID, type ResearchMemory } from "../../src/research/schema"
import { ResearchExperiencesCommand } from "../../src/cli/cmd/research"
import { resetDatabase } from "../fixture/db"
import { provideTmpdirInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import type { ResearchExperience } from "../../src/research/experience"

const originalPath = process.env.NEO_RESEARCH_EXPERIENCE_DB
const it = testEffect(CrossSpawnSpawner.defaultLayer)
afterEach(async () => {
  if (originalPath === undefined) delete process.env.NEO_RESEARCH_EXPERIENCE_DB
  else process.env.NEO_RESEARCH_EXPERIENCE_DB = originalPath
  await resetDatabase()
})

function memory(suffix: string, domainID = "tsf"): ResearchMemory {
  return {
    id: ResearchMemoryID.make(`rmem_shared_${suffix}`), taskID: ResearchTaskID.make(`rtsk_source_${suffix}`), domainID,
    fingerprintSummary: { series: "synthetic" }, outcome: "failed", lesson: "An observed seasonal comparison needs further validation.",
    candidateSummary: { role: "experience", experienceKey: `key-${suffix}`, experience: {
      schemaVersion: "research_experience.v1", canonicalEvidenceVersion: 1, supportDatasetCount: 1, capturedAt: 1,
      draft: { level: "experiment_fact", polarity: "inconclusive", claimType: "observation",
        statement: "Synthetic seasonal observation", conditions: [], intervention: "Shared predictor",
        observation: "A recorded validation measurement", boundaries: [], unknowns: [],
        evidence: [{ runID: `run-${suffix}`, relation: "supports" }] },
      facts: [{ taskID: `rtsk_source_${suffix}`, runID: `run-${suffix}`, stage: "full", status: "succeeded",
        dataset: { identity: "synthetic", specification: {} }, taskFingerprint: {}, evaluation: {},
        executedModel: { preprocessing: ["seasonal_differencing"] }, executionVerified: true, independentEvidence: true, metrics: { mse: 1 }, primaryMetric: "mse", primaryValue: 1,
        direction: "minimize", artifactIDs: [] }],
    } },
    time: { created: 1, updated: 1 },
  }
}

function searchMemory(suffix: string, statement: string, updated = 1, model?: Record<string, unknown>) {
  const entry = memory(suffix)
  const experience = entry.candidateSummary.experience as unknown as ResearchExperience
  experience.draft.statement = statement
  experience.facts[0]!.executedModel = model
  return { ...entry, time: { ...entry.time, updated } }
}

function controlledMemory(suffix: string, field: string, before: number, after: number) {
  const entry = memory(suffix)
  const experience = entry.candidateSummary.experience as unknown as ResearchExperience
  const nested = (value: number) => field.split(".").reduceRight<unknown>((value, key) => ({ [key]: value }), value) as Record<string, unknown>
  const trial = experience.facts[0]!
  trial.proposedModel = nested(after)
  trial.hypothesisSnapshot = { experimentContract: { mode: "controlled", comparisonRunID: `control-${suffix}`,
    changes: [{ operation: "set", path: field, before, after }] } }
  experience.facts.push({ ...trial, runID: `control-${suffix}`, proposedModel: nested(before), hypothesisSnapshot: undefined })
  experience.draft.evidence[0]!.comparisonRunID = `control-${suffix}`
  return entry
}

test("long research queries rank noncontiguous relevant terms before newer generic observations", async () => {
  await using tmp = await tmpdir()
  const library = new ExperienceLibrary(path.join(tmp.path, "shared.db"))
  const source = { projectID: "source", projectRoot: "/source" }
  try {
    library.save(controlledMemory("width", "backbone.hiddenDim", 64, 128), source)
    library.save(searchMemory("generic", "Time series forecasting models completed another experiment.", 100), source)
    library.save(searchMemory("depth", "Backbone depth affected convergence.", 200), source)
    const query = "backbone hidden dimension width capacity sensitivity time series forecasting"
    expect(library.list({ query, limit: 1 }).map(entry => entry.id)).toEqual([ResearchMemoryID.make("rmem_shared_width")])
    expect(library.list().map(entry => entry.id)).toEqual([
      ResearchMemoryID.make("rmem_shared_depth"), ResearchMemoryID.make("rmem_shared_generic"), ResearchMemoryID.make("rmem_shared_width"),
    ])
    expect(library.list({ query: "quasar archaeology" })).toEqual([])
    expect(library.list({ query: "time series forecasting models" })).toEqual([])
  } finally { library.close() }
})

test("search handles bilingual terms, code identifiers and executed model facts without substring architecture collisions", async () => {
  await using tmp = await tmpdir()
  const library = new ExperienceLibrary(path.join(tmp.path, "shared.db"))
  const source = { projectID: "source", projectRoot: "/source" }
  const feature = searchMemory("feature", "Increasing model capacity did not help.", 1,
    { fusion: { type: "feature_mlp" }, backbone: { hiddenDim: 128 }, trainingStrategy: { optimizer: { lr: 0.001 } } })
  try {
    library.save(feature, source)
    library.save(searchMemory("dlinear", "DLinear decomposition was observed.", 2, { backbone: "dlinear" }), source)
    library.save(searchMemory("linear", "Linear projection was observed.", 3, { backbone: "linear" }), source)
    for (const query of ["FEATURE-MLP hidden dimension", "model width capacity learning rate", "featureMlp hidden_dim"]) {
      expect(library.list({ query, includeBackground: true, limit: 1 })[0]?.id).toBe(feature.id)
    }
    expect(library.list({ query: "linear" }).map(entry => entry.id)).toEqual([ResearchMemoryID.make("rmem_shared_linear")])
    expect(library.list({ query: "DLinear" }).map(entry => entry.id)).toEqual([ResearchMemoryID.make("rmem_shared_dlinear")])
    expect(library.list({ experienceID: feature.id })[0]?.candidateSummary.experience).toEqual(feature.candidateSummary.experience)
  } finally { library.close() }
})

test("relevance ranking preserves explicit scope and evidence filters and applies limits after ranking", async () => {
  await using tmp = await tmpdir()
  const library = new ExperienceLibrary(path.join(tmp.path, "shared.db"))
  const local = controlledMemory("local", "trainingStrategy.scheduler.warmupSteps", 0, 5)
  const foreign = controlledMemory("foreign", "trainingStrategy.regularization.gradClip", 1, 0.5)
  const otherDomain = { ...controlledMemory("domain", "trainingStrategy.regularization.gradClip", 1, 0.5), domainID: "other-domain" }
  try {
    library.save(local, { projectID: "local", projectRoot: "/local" })
    library.save(foreign, { projectID: "foreign", projectRoot: "/foreign" })
    library.save(otherDomain, { projectID: "other", projectRoot: "/other" })
    const query = "gradient clipping warm up stability"
    expect(library.list({ query, domainID: "tsf", limit: 1 })[0]?.id).toBe(foreign.id)
    expect(library.list({ query, projectID: "local" }).map(entry => entry.id)).toEqual([local.id])
    expect(library.list({ query, taskID: local.taskID }).map(entry => entry.id)).toEqual([local.id])
    expect(library.list({ query, level: "validated_principle" })).toEqual([])
    expect(library.list({ query, polarity: "positive" })).toEqual([])
    expect(library.list({ query, experienceID: foreign.id }).map(entry => entry.id)).toEqual([foreign.id])
    expect(library.list({ query, domainID: "tsf" }).map(entry => entry.id))
      .toEqual(library.list({ query, domainID: "tsf" }).map(entry => entry.id))
  } finally { library.close() }
})

test("explicit paths override project exports and relative or empty overrides are rejected", async () => {
  await using tmp = await tmpdir()
  const explicit = path.join(tmp.path, "shared.db")
  process.env.NEO_RESEARCH_EXPERIENCE_DB = explicit
  expect(experienceLibraryPath(tmp.path)).toBe(explicit)
  for (const invalid of ["", "   ", "./.neo-research/experience.db"]) {
    process.env.NEO_RESEARCH_EXPERIENCE_DB = invalid
    expect(() => experienceLibraryPath(tmp.path)).toThrow("absolute SQLite file path")
  }
})

test.each(["experience.db", "experience-export/experience.db"])("project-local %s is discovered from nested package directories", async (relative) => {
  await using tmp = await tmpdir()
  delete process.env.NEO_RESEARCH_EXPERIENCE_DB
  const file = path.join(tmp.path, ".neo-research", relative)
  const source = new ExperienceLibrary(file)
  try { source.save(memory("portable"), { projectID: "source-project", projectRoot: "/source/project" }) }
  finally { source.close() }
  const nested = path.join(tmp.path, "neoresearch", "packages", "neoresearch")
  await mkdir(nested, { recursive: true })
  expect(experienceLibraryPath(nested)).toBe(file)
  const reader = new ExperienceLibrary(experienceLibraryPath(nested))
  try {
    const [entry] = reader.list()
    expect(entry?.id).toBe(ResearchMemoryID.make("rmem_shared_portable"))
    expect(entry?.candidateSummary.experienceSource).toEqual({ projectID: "source-project", projectRoot: "/source/project" })
    expect(entry?.candidateSummary.experience).toEqual(memory("portable").candidateSummary.experience)
  } finally { reader.close() }
})

test("project boundaries prevent selecting another repository's library and absence falls back to the shared home", async () => {
  await using tmp = await tmpdir()
  delete process.env.NEO_RESEARCH_EXPERIENCE_DB
  const parent = new ExperienceLibrary(path.join(tmp.path, ".neo-research", "experience.db"))
  parent.close()
  const child = path.join(tmp.path, "independent-project")
  await mkdir(path.join(child, ".git"), { recursive: true })
  expect(experienceLibraryPath(child)).toBe(path.join(Global.Path.home, ".neo-research", "experience.db"))
})

test("portable snapshots support filtering and idempotent writes without source tasks or runs", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "shared.db")
  const library = new ExperienceLibrary(file)
  const a = memory("a")
  const source = { projectID: "source", projectRoot: "/source" }
  try {
    expect(library.save(a, source).created).toBe(true)
    expect(library.save({ ...a, id: ResearchMemoryID.make("rmem_duplicate") }, source).created).toBe(false)
    library.save(memory("other", "other-domain"), { projectID: "other", projectRoot: "/other" })
    expect(library.list({ domainID: "tsf", projectID: "source", taskID: a.taskID, level: "experiment_fact",
      polarity: "inconclusive", query: "SEASONAL", limit: 1 }).map((x) => x.id)).toEqual([a.id])
    expect(library.list({ experienceID: a.id })[0]?.candidateSummary.experienceSource).toEqual(source)
    expect(library.list({ domainID: "unknown" })).toEqual([])
    expect(library.list({ query: "unrelated mechanism" })).toEqual([])
    expect(() => library.save(a, { projectID: "conflicting-project", projectRoot: "/conflict" })).toThrow("Conflicting experience ID")
    expect(library.list()).toHaveLength(2)
  } finally { library.close() }
})

test("malformed, ungrounded and held-out rows cannot hide valid shared experiences or enter search", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "shared.db")
  const library = new ExperienceLibrary(file)
  const source = { projectID: "source", projectRoot: "/source" }
  try {
    for (const suffix of ["valid", "broken", "held-out", "ungrounded"]) library.save(memory(suffix), source)
    const db = new SQLite(file)
    try {
      db.query("UPDATE research_experience SET memory_json=? WHERE id=?").run("{broken", "rmem_shared_broken")
      const heldOut = memory("held-out")
      const heldOutExperience = heldOut.candidateSummary.experience as { facts: Array<{ stage: string }> }
      heldOutExperience.facts[0].stage = "ref_test"
      db.query("UPDATE research_experience SET memory_json=? WHERE id=?").run(JSON.stringify(heldOut), heldOut.id)
      const unsupported = memory("ungrounded")
      const unsupportedExperience = unsupported.candidateSummary.experience as { draft: { evidence: Array<{ runID: string }> } }
      unsupportedExperience.draft.evidence[0].runID = "missing-run"
      db.query("UPDATE research_experience SET memory_json=? WHERE id=?").run(JSON.stringify(unsupported), unsupported.id)
      expect(() => library.save(heldOut, source)).toThrow("validated structured experience")
    } finally { db.close() }
    expect(library.list().map((entry) => entry.id)).toEqual([ResearchMemoryID.make("rmem_shared_valid")])
    expect(library.list({ query: "seasonal validation" }).map((entry) => entry.id)).toEqual([ResearchMemoryID.make("rmem_shared_valid")])
  } finally { library.close() }
})

test("the experiences CLI reads a portable library without creating a source task or a research session", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, ".neo-research", "experience-export", "experience.db")
  const library = new ExperienceLibrary(file)
  try { library.save(memory("cli"), { projectID: "original-project", projectRoot: "/original/project" }) }
  finally { library.close() }
  process.env.NEO_RESEARCH_EXPERIENCE_DB = file
  const messages: string[] = []
  const output = spyOn(console, "log").mockImplementation((value) => { messages.push(String(value)) })
  try {
    await ResearchExperiencesCommand.handler({ path: true } as never)
    expect(messages.pop()).toBe(file)
    await ResearchExperiencesCommand.handler({ domain: "tsf", limit: 100 } as never)
    expect(JSON.parse(messages.pop()!)).toMatchObject({ databasePath: file, experiences: [{
      id: "rmem_shared_cli", candidateSummary: { experienceSource: { projectID: "original-project" } },
    }] })
  } finally { output.mockRestore() }
})

it.live("task reads discover the library in the active project rather than the process working directory", () =>
  provideTmpdirInstance((directory) => Effect.gen(function* () {
    const svc = yield* Research.Service
    const task = yield* svc.createTask({ title: "Portable shared library", domainID: "tsf", mode: "review",
      taskSpec: { contextLength: 96, predictionLengths: [24], dataset: { loaderID: "etth1_tslib_v1", targetCols: ["OT"] } },
      objective: { primaryMetric: "val_avg_mse", direction: "minimize" }, budget: { maxRuns: 1 } })
    const file = path.join(directory, ".neo-research", "experience-export", "experience.db")
    const library = new ExperienceLibrary(file)
    try { library.save(memory("project-local"), { projectID: "foreign-project", projectRoot: "/foreign" }) }
    finally { library.close() }
    delete process.env.NEO_RESEARCH_EXPERIENCE_DB
    expect(readExperiences(task.id).map((entry) => entry.id)).toEqual([ResearchMemoryID.make("rmem_shared_project-local")])
    expect(readExperiences(task.id, { scope: "project" })).toEqual([])
    expect(readExperiences(task.id, { scope: "task" })).toEqual([])
  }).pipe(Effect.provide(Research.defaultLayer)), { config: { formatter: false, lsp: false } }), 30_000)

test("future plans cannot establish factual recall, and explicitly requested background stays labeled", async () => {
  await using tmp = await tmpdir()
  const library = new ExperienceLibrary(path.join(tmp.path, "shared.db"))
  const entry = memory("future")
  const experience = entry.candidateSummary.experience as unknown as ResearchExperience
  experience.draft.unknowns = ["Could frequency rFFT spectral embedding improve the next experiment?"]
  try {
    library.save(entry, { projectID: "source", projectRoot: "/source" })
    expect(library.list({ query: "frequency rFFT spectral embedding" })).toEqual([])
    expect(library.list({ query: "frequency rFFT spectral embedding", includeBackground: true })[0]?.candidateSummary.experienceRetrieval)
      .toMatchObject({ relevance: "unverified_text_background", matchedFactualTerms: [] })
  } finally { library.close() }
})

test("a width intervention outranks prose and unchanged width does not count as a width experiment", async () => {
  await using tmp = await tmpdir()
  const library = new ExperienceLibrary(path.join(tmp.path, "shared.db"))
  const direct = controlledMemory("controlled-width", "backbone.hiddenDim", 64, 128)
  const background = searchMemory("constant-width", "Width capacity hidden dimension width", 100,
    { backbone: { type: "mlp", hiddenDim: 64 } })
  try {
    for (const entry of [direct, background]) library.save(entry, { projectID: "source", projectRoot: "/source" })
    expect(library.list({ query: "backbone hidden dimension width capacity" }).map(memory => memory.id)).toEqual([direct.id])
    const expanded = library.list({ query: "backbone hidden dimension width capacity", includeBackground: true })
    expect(expanded.map(memory => memory.id)).toEqual([direct.id, background.id])
    expect(expanded[0]?.candidateSummary.experienceRetrieval).toMatchObject({ relevance: "direct_intervention", matchedFields: expect.arrayContaining(["verified_interventions"]) })
    expect(expanded[1]?.candidateSummary.experienceRetrieval).toMatchObject({ relevance: "configuration_background" })
  } finally { library.close() }
})

test("error queries abstain without the error and never pad two real failures with unrelated training records", async () => {
  await using tmp = await tmpdir()
  const library = new ExperienceLibrary(path.join(tmp.path, "shared.db"))
  const source = { projectID: "source", projectRoot: "/source" }
  const query = "cudnn RNN backward training mode execution failure rnn"
  try {
    library.save(searchMemory("normal", "Training failed to improve a model", 100, { backbone: "mlp" }), source)
    expect(library.list({ query, limit: 5 })).toEqual([])
    for (const suffix of ["failure-one", "failure-two"]) {
      const entry = memory(suffix)
      const fact = (entry.candidateSummary.experience as unknown as ResearchExperience).facts[0]!
      fact.status = "failed"
      fact.stage = "smoke"
      fact.executionVerified = false
      fact.primaryValue = undefined
      fact.error = "cudnn RNN backward can only be called in training mode"
      library.save(entry, source)
    }
    const result = library.list({ query, limit: 5 })
    expect(result).toHaveLength(2)
    expect(result.every(entry => (entry.candidateSummary.experienceRetrieval as { relevance: string }).relevance === "observed_error")).toBe(true)
  } finally { library.close() }
})

test("same-evidence interpretations share one search slot while exact IDs and history preserve both records", async () => {
  await using tmp = await tmpdir()
  const library = new ExperienceLibrary(path.join(tmp.path, "shared.db"))
  const first = memory("evidence")
  const second: ResearchMemory = { ...structuredClone(first), id: ResearchMemoryID.make("rmem_shared_evidence_alternative"),
    candidateSummary: { ...structuredClone(first.candidateSummary), experienceKey: "alternative-claim" } }
  const secondExperience = second.candidateSummary.experience as unknown as ResearchExperience
  secondExperience.draft.statement = "A separate interpretation of the same evidence"
  try {
    for (const entry of [first, second]) library.save(entry, { projectID: "source", projectRoot: "/source" })
    expect(library.list()).toHaveLength(2)
    const result = library.list({ query: "seasonal" })
    expect(result).toHaveLength(1)
    const alternatives = (result[0]!.candidateSummary.experienceRetrieval as { sameEvidenceExperienceIDs: string[] }).sameEvidenceExperienceIDs
    expect(new Set([result[0]!.id, ...alternatives])).toEqual(new Set([first.id, second.id]))
    expect(library.list({ experienceID: second.id })[0]?.id).toBe(second.id)
  } finally { library.close() }
})

test("dataset, architecture and numeric conditions bind to the same observed run", async () => {
  await using tmp = await tmpdir()
  const library = new ExperienceLibrary(path.join(tmp.path, "shared.db"))
  const entry = memory("conjunction")
  const experience = entry.candidateSummary.experience as unknown as ResearchExperience
  const first = experience.facts[0]!
  first.dataset.specification = { path: "/data/ETTh1.csv" }
  first.proposedModel = { backbone: { type: "mlp", hiddenDim: 64 } }
  first.executedModel = { backbone: "mlp" }
  experience.facts.push({ ...structuredClone(first), runID: "other-run", dataset: { identity: "other-data", specification: { path: "/data/NP.csv" } },
    proposedModel: { backbone: { type: "transformer", hiddenDim: 128 } }, executedModel: { backbone: "transformer" } })
  try {
    library.save(entry, { projectID: "source", projectRoot: "/source" })
    expect(library.list({ query: "ETTh1 transformer" })).toEqual([])
    expect(library.list({ query: "NP transformer hidden_dim=64", includeBackground: false })).toEqual([])
    expect(library.list({ query: "NP transformer backbone.hiddenDim=128" })).toHaveLength(1)
    expect(library.list({ query: "ETTh1 mlp" })).toHaveLength(1)
  } finally { library.close() }
})
