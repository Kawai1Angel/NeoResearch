import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import path from "node:path"
import { readFile } from "node:fs/promises"
import { Research } from "../../src/research"
import { Database } from "../../src/storage"
import { ExperienceLibrary } from "../../src/research/experience-library"
import { ExperiencePurpose, experiencePurpose } from "../../src/research/experience-purpose"
import { experienceFromMemory, type ResearchExperience } from "../../src/research/experience"
import { readExperiences, readExperiencesForRole } from "../../src/research/experience-store"
import { ResearchMemoryWriteTable } from "../../src/research/research.sql"
import { ResearchMemoryID, ResearchTaskID, type ResearchMemory } from "../../src/research/schema"
import { createDualLoopFixture, optimizerFixture } from "../fixture/dual-loop"
import { provideTmpdirInstance, tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Research.defaultLayer, CrossSpawnSpawner.defaultLayer))
const previousPath = process.env.NEO_RESEARCH_EXPERIENCE_DB
let isolated: Awaited<ReturnType<typeof tmpdir>>
beforeEach(async () => {
  isolated = await tmpdir()
  process.env.NEO_RESEARCH_EXPERIENCE_DB = path.join(isolated.path, "experience.db")
})
afterEach(async () => {
  await resetDatabase()
  if (previousPath === undefined) delete process.env.NEO_RESEARCH_EXPERIENCE_DB
  else process.env.NEO_RESEARCH_EXPERIENCE_DB = previousPath
  await isolated[Symbol.asyncDispose]()
})

function memory(
  id: string,
  purpose?: "optimization" | "architecture",
  field = "trainingStrategy.optimizer.lr",
): ResearchMemory {
  const model = (value: number) =>
    field.startsWith("trainingStrategy")
      ? { backbone: { type: "linear", shared: true }, trainingStrategy: { optimizer: { lr: value } } }
      : { backbone: { type: "linear", shared: value === 1 }, trainingStrategy: { optimizer: { lr: 0.001 } } }
  const contract = {
    mode: "controlled",
    comparisonRunID: `control-${id}`,
    changes: [{ operation: "set", path: field, before: 1, after: 2 }],
    frozenPaths: [],
    requiredValues: [],
    forbiddenMechanisms: [],
  }
  if (field === "backbone.shared")
    contract.changes[0] = { operation: "set", path: field, before: true as any, after: false as any }
  const fact = {
    taskID: `task-${id}`,
    runID: `run-${id}`,
    stage: "full",
    status: "succeeded",
    dataset: { identity: "dataset", contentHash: "content", specification: {} },
    taskFingerprint: {},
    evaluation: {},
    proposedModel: model(2),
    hypothesisSnapshot: { experimentContract: contract },
    executedModel: { backbone: "linear" },
    executionVerified: true,
    independentEvidence: true,
    metrics: { mse: 0.3 },
    primaryMetric: "mse",
    primaryValue: 0.3,
    direction: "minimize",
    artifactIDs: [],
  }
  const experience = {
    schemaVersion: "research_experience.v1",
    purpose,
    canonicalEvidenceVersion: 1,
    capturedAt: 1,
    supportDatasetCount: 1,
    draft: {
      level: "experiment_fact",
      polarity: "positive",
      claimType: "performance",
      statement: "A measured contrast",
      conditions: ["Recorded conditions"],
      intervention: field,
      observation: "0.5 to 0.3",
      boundaries: ["One dataset"],
      unknowns: [],
      evidence: [{ runID: fact.runID, comparisonRunID: `control-${id}`, relation: "supports" }],
    },
    facts: [
      fact,
      {
        ...fact,
        runID: `control-${id}`,
        proposedModel: model(1),
        primaryValue: 0.5,
        metrics: { mse: 0.5 },
        hypothesisSnapshot: undefined,
      },
    ],
  }
  return {
    id: ResearchMemoryID.make(`rmem_${id}`),
    taskID: ResearchTaskID.make(`task-${id}`),
    domainID: "tsf",
    fingerprintSummary: {},
    candidateSummary: { role: "experience", experienceKey: `key-${id}`, experience: experience as any },
    outcome: "accepted",
    lesson: "A measured contrast",
    time: { created: 1, updated: 1 },
  }
}

test("legacy purpose migration preserves raw source JSON and exposes unknown only through audit filters", () => {
  const file = path.join(isolated.path, "legacy.db")
  const training = memory("legacy-training"),
    unknown = memory("legacy-unknown")
  const old = unknown.candidateSummary.experience as unknown as ResearchExperience
  old.draft.claimType = "observation"
  old.draft.evidence = [{ runID: old.facts[0]!.runID, relation: "supports" }]
  old.facts = [{ ...old.facts[0]!, hypothesisSnapshot: undefined }]
  const db = new SQLite(file)
  db.exec(`CREATE TABLE research_experience(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,project_root TEXT NOT NULL,
    task_id TEXT NOT NULL,domain_id TEXT NOT NULL,level TEXT NOT NULL,polarity TEXT NOT NULL,experience_key TEXT NOT NULL,
    memory_json TEXT NOT NULL,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL,UNIQUE(project_id,task_id,experience_key))`)
  for (const entry of [training, unknown])
    db.query("INSERT INTO research_experience VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
      entry.id,
      "source",
      "/source",
      entry.taskID,
      "tsf",
      "experiment_fact",
      "positive",
      String(entry.candidateSummary.experienceKey),
      JSON.stringify(entry),
      1,
      1,
    )
  const raw = db.query("SELECT memory_json FROM research_experience ORDER BY id").all()
  db.close()
  const library = new ExperienceLibrary(file)
  try {
    expect(library.list({ purpose: "optimization" }).map((item) => item.id)).toEqual([training.id])
    expect(library.list({ purpose: "architecture" })).toEqual([])
    expect(library.list({ purpose: "optimization", includeUnknown: true })).toHaveLength(2)
    expect(library.list({ experienceID: unknown.id })[0]!.candidateSummary.experiencePurpose).toBeNull()
    const sqlite = new SQLite(file, { readonly: true })
    expect(sqlite.query("SELECT memory_json FROM research_experience ORDER BY id").all()).toEqual(raw)
    expect(
      sqlite.query("SELECT purpose,classification_version FROM research_experience WHERE id=?").get(training.id),
    ).toEqual({ purpose: "optimization", classification_version: 1 })
    sqlite.close()
  } finally {
    library.close()
  }
})

test("classification refuses a training-to-architecture promotion and keeps mixed interventions unknown", () => {
  expect(ExperiencePurpose.safeParse("execution").success).toBe(false)
  const library = new ExperienceLibrary()
  try {
    expect(() =>
      library.save(memory("mislabel", "architecture"), { projectID: "source", projectRoot: "/source" }),
    ).toThrow("purpose")
    const mixed = memory("mixed")
    const experience = mixed.candidateSummary.experience as unknown as ResearchExperience
    experience.facts[0]!.proposedModel = {
      ...experience.facts[0]!.proposedModel!,
      backbone: { type: "linear", shared: false },
    }
    ;(experience.facts[0]!.hypothesisSnapshot!.experimentContract as any).changes.push({
      operation: "set",
      path: "backbone.shared",
      before: true,
      after: false,
    })
    // Historical observation remains auditable; it is not classified as either isolated effect.
    experience.draft.claimType = "observation"
    expect(experiencePurpose(experience)).toBeUndefined()
    library.save(mixed, { projectID: "source", projectRoot: "/source" })
    expect(library.list({ purpose: "optimization" })).toEqual([])
    expect(library.list({ experienceID: mixed.id })).toHaveLength(1)
  } finally {
    library.close()
  }
})

test("shared-library write receipts survive reopen and reject a changed request under the same key", () => {
  const entry = memory("receipt", "optimization")
  const source = { projectID: "source", projectRoot: "/source", writeKey: "stable-write", writeDigest: "same-input" }
  const first = new ExperienceLibrary()
  const saved = first.save(entry, source)
  first.close()
  const second = new ExperienceLibrary()
  try {
    const replay = second.save({ ...entry, id: ResearchMemoryID.make("rmem_retry") }, source)
    expect(replay.created).toBe(false)
    expect(replay.sourceEntryID).toBe(saved.sourceEntryID)
    expect(second.list()).toHaveLength(1)
    expect(() => second.save(entry, { ...source, writeDigest: "changed" })).toThrow("different input")
  } finally {
    second.close()
  }
})

test("a purpose-aware write reuses the same-purpose legacy key without rewriting or duplicating its source", () => {
  const old = memory("old-key")
  const library = new ExperienceLibrary()
  const source = { projectID: "source", projectRoot: "/source" }
  try {
    library.save(old, source)
    const next: ResearchMemory = {
      ...structuredClone(old),
      id: ResearchMemoryID.make("rmem_new-key"),
      candidateSummary: {
        ...structuredClone(old.candidateSummary),
        experienceKey: "purpose-aware-key",
        experienceLegacyKey: old.candidateSummary.experienceKey,
      },
    }
    ;(next.candidateSummary.experience as unknown as ResearchExperience).purpose = "optimization"
    const result = library.save(next, source)
    expect(result.created).toBe(false)
    expect(result.sourceEntryID).toBe(old.id)
    expect(library.list()).toHaveLength(1)
    expect(result.memory.candidateSummary.experience).toEqual(old.candidateSummary.experience)
  } finally {
    library.close()
  }
})

test("classification backfill preserves a canonical thread when an older equivalent source was imported", () => {
  const library = new ExperienceLibrary()
  const root = memory("canonical", "optimization")
  const older = { ...memory("older", "optimization"), time: { created: 0, updated: 0 } }
  const claim = {
    statement: "A bounded learning rate contrast",
    dataConditions: ["Recorded source conditions"],
    operation: "Change learning rate",
    interventionPaths: ["trainingStrategy.optimizer.lr"],
    expectedOutcome: { metric: "mse", direction: "lower" as const },
    boundaries: ["This matched protocol"],
    validationPlan: "Repeat the matched contrast",
  }
  for (const entry of [root, older]) {
    ;(entry.candidateSummary.experience as unknown as ResearchExperience).draft.evolution = {
      relation: "supports",
      claim,
    }
    library.save(entry, { projectID: "source", projectRoot: "/source" })
  }
  expect(library.list({ experienceID: older.id })[0]!.candidateSummary.experienceOrganization).toMatchObject({
    threadID: root.id,
  })
  const file = library.databasePath
  library.close()
  const db = new SQLite(file)
  db.exec("UPDATE research_experience SET classification_version=0")
  db.close()
  const reopened = new ExperienceLibrary(file)
  try {
    expect(reopened.list({ experienceID: older.id })[0]!.candidateSummary.experienceOrganization).toMatchObject({
      threadID: root.id,
    })
  } finally {
    reopened.close()
  }
})

test("query deduplication does not collapse the two purposes of the same configuration observation", () => {
  const base = memory("same-observation", "optimization")
  const observation = base.candidateSummary.experience as unknown as ResearchExperience
  observation.draft.claimType = "observation"
  observation.draft.evidence = [{ runID: observation.facts[0]!.runID, relation: "supports" }]
  observation.facts = [{ ...observation.facts[0]!, hypothesisSnapshot: undefined }]
  const second: ResearchMemory = {
    ...structuredClone(base),
    id: ResearchMemoryID.make("rmem_other-purpose"),
    candidateSummary: { ...structuredClone(base.candidateSummary), experienceKey: "other-purpose" },
  }
  ;(second.candidateSummary.experience as unknown as ResearchExperience).purpose = "architecture"
  const library = new ExperienceLibrary()
  try {
    library.save(base, { projectID: "source", projectRoot: "/source" })
    library.save(second, { projectID: "source", projectRoot: "/source" })
    const found = library.list({ query: "linear" })
    expect(found).toHaveLength(2)
    expect(new Set(found.map((item) => item.candidateSummary.experiencePurpose))).toEqual(
      new Set(["optimization", "architecture"]),
    )
  } finally {
    library.close()
  }
})

test("continuations cannot cross memory purpose even when they cite a valid parent", () => {
  const library = new ExperienceLibrary()
  const parent = memory("parent", "architecture", "backbone.shared")
  const child = memory("child", "optimization")
  const original = parent.candidateSummary.experience as unknown as ResearchExperience
  original.draft.evolution = {
    relation: "supports",
    claim: {
      statement: "A controlled sharing intervention",
      dataConditions: ["Recorded source"],
      operation: "Change sharing",
      interventionPaths: ["backbone.shared"],
      expectedOutcome: { metric: "mse", direction: "lower" },
      boundaries: ["Recorded conditions"],
      validationPlan: "Repeat the matched comparison",
    },
  }
  ;(child.candidateSummary.experience as unknown as ResearchExperience).draft.evolution = {
    parentExperienceID: parent.id,
    relation: "supports",
  }
  try {
    library.save(parent, { projectID: "source", projectRoot: "/source" })
    expect(() => library.save(child, { projectID: "source", projectRoot: "/source" })).toThrow("purpose")
    expect(library.list()).toHaveLength(1)
  } finally {
    library.close()
  }
})

it.live(
  "role filters apply before limits and cannot be bypassed by a different requested purpose or exact ID",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const { task } = yield* createDualLoopFixture(directory)
        const training = memory("filter-training", "optimization"),
          architecture = memory("filter-architecture", "architecture", "backbone.shared")
        const unknown = memory("filter-unknown")
        const legacy = unknown.candidateSummary.experience as unknown as ResearchExperience
        legacy.draft.claimType = "observation"
        legacy.draft.evidence = [{ runID: legacy.facts[0]!.runID, relation: "supports" }]
        legacy.facts = [{ ...legacy.facts[0]!, hypothesisSnapshot: undefined }]
        const library = new ExperienceLibrary()
        try {
          for (const entry of [training, architecture, unknown])
            library.save(entry, { projectID: "source", projectRoot: "/source" })
        } finally {
          library.close()
        }
        expect(
          readExperiencesForRole(task.id, "optimizer", { purpose: "architecture", limit: 1 }).map((item) => item.id),
        ).toEqual([training.id])
        expect(readExperiencesForRole(task.id, "hypoplanner", { limit: 1 }).map((item) => item.id)).toEqual([
          architecture.id,
        ])
        expect(readExperiencesForRole(task.id, "optimizer", { experienceID: architecture.id })).toEqual([])
        expect(readExperiencesForRole(task.id, "optimizer", { experienceID: unknown.id })).toEqual([])
        expect(
          readExperiencesForRole(task.id, "optimizer", { experienceID: unknown.id, includeUnknown: true })[0]!
            .candidateSummary.experiencePurpose,
        ).toBeNull()
      }),
    ),
  60000,
)

it.live(
  "bounded reflection lookups preserve the role purpose even for a named cross-purpose memory",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          const architecture = memory("lookup-architecture", "architecture", "backbone.shared")
          const library = new ExperienceLibrary()
          try {
            library.save(architecture, { projectID: "source", projectRoot: "/source" })
          } finally {
            library.close()
          }
          fixture.calls.requestTrainingExperienceID = architecture.id
          const { task } = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          const loop = yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 4, maxTrialsPerDesign: 1 })
          expect(loop.iterations).toHaveLength(1)
          expect(fixture.calls.trainingReflection).toBe(2)
          expect(fixture.inputs.training[1]!.requestedExperiences[0].experiences).toEqual([])
          expect(fixture.calls.planner).toBe(1)
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "both scoped reflection modes write validated proposals and consumers retrieve their own purpose",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          fixture.calls.proposeOptimizationMemory = true
          fixture.calls.proposeArchitectureMemory = true
          const { task } = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 4 })
          const receipts = yield* service.listExperienceWrites(task.id)
          expect(receipts).toHaveLength(4)
          expect(
            receipts.every((receipt) => receipt.status === "applied"),
            JSON.stringify(receipts),
          ).toBe(true)
          const training = readExperiencesForRole(task.id, "optimizer", { scope: "task" })
          const architecture = readExperiencesForRole(task.id, "hypoplanner", { scope: "task" })
          expect(training).toHaveLength(3)
          expect(architecture).toHaveLength(1)
          const replay = yield* service.runReflectionAgent({ taskID: task.id, designID: receipts[0]!.binding.designID })
          expect(replay.experienceWriteResults).toHaveLength(1)
          expect(replay.experienceWriteResults![0]!.saved).toBe(true)
          expect(training.every((entry) => experienceFromMemory(entry)!.purpose === "optimization")).toBe(true)
          expect(architecture.every((entry) => experienceFromMemory(entry)!.purpose === "architecture")).toBe(true)
          expect(fixture.inputs.optimizer[1]!.experiences.length).toBeGreaterThan(0)
          expect(fixture.inputs.optimizer[1]!.experiences.every((entry: any) => entry.purpose === "optimization")).toBe(
            true,
          )
          const before = fixture.calls.trainingReflection + fixture.calls.reflection + fixture.calls.optimizer
          yield* service.runAutonomousLoop({ taskID: task.id })
          expect(readExperiences(task.id, { scope: "task" })).toHaveLength(4)
          expect(fixture.calls.trainingReflection + fixture.calls.reflection + fixture.calls.optimizer).toBe(before)
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

test("process loss between the two database commits resumes one shared memory and no repeated training reflection", async () => {
  const run = async (mode: string, expectedCode: number) => {
    const child = Bun.spawn(
      [
        process.execPath,
        path.resolve(import.meta.dirname, "../fixture/experience-outbox-process.ts"),
        mode,
        isolated.path,
      ],
      {
        env: { ...process.env, OPENCODE_DB: path.join(isolated.path, "main.db") },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, stderr).toBe(expectedCode)
    return stdout
  }
  await run("first", 19)
  const result = JSON.parse((await run("resume", 0)).trim().split("\n").at(-1)!)
  expect(result).toMatchObject({
    stoppedReason: "planner_stopped",
    firstStatus: "prepared",
    sameMemory: true,
    firstCalls: { trainingReflection: 1 },
    resumeCalls: { trainingReflection: 0, reflection: 1, planner: 1 },
  })
  expect(result.receipts).toHaveLength(1)
  expect(result.receipts[0].status).toBe("applied")
  expect(result.memoryIDs).toHaveLength(1)
  const calls = (await readFile(path.join(isolated.path, "training-calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  expect(calls.filter((call) => call.stage === "full")).toHaveLength(1)
}, 60000)

it.live(
  "an architecture proposal citing only tuning gains is rejected without blocking the design decision",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          fixture.calls.proposeArchitectureMemory = true
          fixture.calls.crossScopeArchitectureMemory = true
          const { task } = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          const loop = yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 4 })
          expect(loop.stoppedReason).toBe("planner_stopped")
          const receipts = yield* service.listExperienceWrites(task.id)
          expect(receipts).toHaveLength(1)
          expect(receipts[0]!.status).toBe("rejected")
          expect(receipts[0]!.error).toContain("purpose")
          expect(readExperiences(task.id, { scope: "task" })).toEqual([])
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "loss after the library commit replays one write receipt without rerunning reasoning or training",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        const original = ExperienceLibrary.prototype.save
        let once = true
        const fault = spyOn(ExperienceLibrary.prototype, "save").mockImplementation(function (
          this: ExperienceLibrary,
          entry,
          source,
        ) {
          const saved = original.call(this, entry, source)
          if (once && source.writeKey) {
            once = false
            throw new Error("simulated loss after shared-library commit")
          }
          return saved
        })
        try {
          fixture.calls.proposeOptimizationMemory = true
          const { task } = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          // Stop after the training reflection returns: subsequent automatic flushes
          // are also faulted until the test explicitly reconnects the library.
          fixture.calls.interruptArchitectureReflection = true
          yield* service.runAutonomousLoop({ taskID: task.id, maxTrialsPerDesign: 1 }).pipe(Effect.exit)
          fault.mockRestore()
          yield* service.flushExperienceWrites(task.id)
          const receipts = yield* service.listExperienceWrites(task.id)
          expect(receipts).toHaveLength(1)
          expect(receipts[0]!.status).toBe("applied")
          expect(readExperiences(task.id, { scope: "task" })).toHaveLength(1)
          fixture.calls.interruptArchitectureReflection = false
          const loop = yield* service.runAutonomousLoop({ taskID: task.id })
          expect(loop.iterations).toHaveLength(1)
          expect(fixture.calls.trainingReflection).toBe(1)
          expect(readExperiences(task.id, { scope: "task" })).toHaveLength(1)
        } finally {
          fault.mockRestore()
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "prepared writes retain frozen factual snapshots while a disconnected library is retried",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        const original = ExperienceLibrary.prototype.save
        const fault = spyOn(ExperienceLibrary.prototype, "save").mockImplementation(function (
          this: ExperienceLibrary,
          entry,
          source,
        ) {
          if (source.writeKey) throw new Error("simulated disconnected library")
          return original.call(this, entry, source)
        })
        try {
          fixture.calls.proposeOptimizationMemory = true
          fixture.calls.interruptArchitectureReflection = true
          const { task } = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          yield* service.runAutonomousLoop({ taskID: task.id, maxTrialsPerDesign: 1 }).pipe(Effect.exit)
          const queued = Database.use((db) => db.select().from(ResearchMemoryWriteTable).all())
          expect(queued[0]!.status).toBe("prepared")
          const run = (yield* service.listRuns(task.id)).find((run) => run.stage === "full")!
          yield* service.updateRunStatus({ runID: run.id, status: "succeeded", metrics: { val_avg_mse: 0.1 } })
          fault.mockRestore()
          yield* service.flushExperienceWrites(task.id)
          const [saved] = readExperiences(task.id, { scope: "task" })
          expect(experienceFromMemory(saved!)!.facts[0]!.primaryValue).toBe(0.3)
          expect((yield* service.listExperienceWrites(task.id))[0]!.status).toBe("applied")
        } finally {
          fault.mockRestore()
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "unprepared proposals refuse changed evidence rather than distilling it under an old reflection",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        const original = Database.transaction
        let depth = 0,
          once = true
        const fault = spyOn(Database, "transaction").mockImplementation(((
          ...args: Parameters<typeof Database.transaction>
        ) => {
          depth++
          let value: unknown
          try {
            value = original(...args)
          } finally {
            depth--
          }
          if (
            !depth &&
            once &&
            Database.use((db) => db.select().from(ResearchMemoryWriteTable).all()).some(
              (entry) => entry.status === "pending",
            )
          ) {
            once = false
            throw new Error("simulated loss after outbox commit")
          }
          return value
        }) as typeof Database.transaction)
        try {
          fixture.calls.proposeOptimizationMemory = true
          const { task } = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          expect(
            (yield* service.runAutonomousLoop({ taskID: task.id, maxTrialsPerDesign: 1 }).pipe(Effect.exit))._tag,
          ).toBe("Failure")
          fault.mockRestore()
          const run = (yield* service.listRuns(task.id)).find((run) => run.stage === "full")!
          yield* service.updateRunStatus({ runID: run.id, status: "succeeded", metrics: { val_avg_mse: 0.1 } })
          yield* service.flushExperienceWrites(task.id)
          const [receipt] = yield* service.listExperienceWrites(task.id)
          expect(receipt!.status).toBe("rejected")
          expect(receipt!.error).toContain("changed")
          expect(readExperiences(task.id, { scope: "task" })).toEqual([])
          expect(fixture.calls.trainingReflection).toBe(1)
        } finally {
          fault.mockRestore()
          fixture.restore()
        }
      }),
    ),
  60000,
)
