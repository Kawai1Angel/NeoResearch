import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { Effect, Layer } from "effect"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Research } from "../../src/research"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import * as Truncate from "../../src/tool/truncate"
import { ReadExperiencesTool, WriteExperienceTool } from "../../src/tool/research-experience"
import { ReadMemoryLessonsTool } from "../../src/tool/research-context"
import {
  ExperienceDraftSchema,
  experienceFromMemory,
  experienceFactForPrompt,
  validateExperienceEvidence,
  type ExperienceDraft,
  type ExperimentFact,
} from "../../src/research/experience"
import { migrateProjectExperiences, readExperiences, writeExperience } from "../../src/research/experience-store"
import { ExperienceLibrary, experienceLibraryPath } from "../../src/research/experience-library"
import { groundedExperienceInterpretation, experienceSourceDigest } from "../../src/research/experience-curation"
import { SessionID, MessageID } from "../../src/session/schema"
import { provideTmpdirInstance, tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
import { Database, eq } from "../../src/storage"
import { ResearchMemoryTable, ResearchTaskTable } from "../../src/research/research.sql"

const originalExperiencePath = process.env.NEO_RESEARCH_EXPERIENCE_DB
let isolatedLibrary: Awaited<ReturnType<typeof tmpdir>> | undefined
beforeEach(async () => {
  isolatedLibrary = await tmpdir()
  process.env.NEO_RESEARCH_EXPERIENCE_DB = path.join(isolatedLibrary.path, "experience.db")
})
afterEach(async () => {
  await resetDatabase()
  if (originalExperiencePath === undefined) delete process.env.NEO_RESEARCH_EXPERIENCE_DB
  else process.env.NEO_RESEARCH_EXPERIENCE_DB = originalExperiencePath
  await isolatedLibrary?.[Symbol.asyncDispose]()
})
const it = testEffect(CrossSpawnSpawner.defaultLayer)
const layer = Layer.mergeAll(Research.defaultLayer, Agent.defaultLayer, Truncate.defaultLayer)

const draft = (runID: string, comparisonRunID?: string): ExperienceDraft => ({
  level: comparisonRunID ? "conditional_experience" : "experiment_fact",
  polarity: "negative",
  claimType: comparisonRunID ? "performance" : "observation",
  statement: "The intervention did not improve MSE under the tested seasonal conditions.",
  conditions: ["Hourly data with a stable daily component"],
  intervention: "Add a seasonal component",
  observation: "Validation MSE was higher than the controlled baseline.",
  boundaries: ["Only this evaluation protocol has been observed"],
  unknowns: ["Seed sensitivity"],
  validationPlan: "Compare against the same baseline and budget on a new dataset; reject the claim if MSE improves.",
  evidence: [{ runID, ...(comparisonRunID ? { comparisonRunID } : {}), relation: "supports" }],
})

function fact(runID: string, dataset = "data-a"): ExperimentFact {
  return {
    taskID: dataset,
    runID,
    stage: "full",
    status: "succeeded",
    dataset: { identity: dataset, contentHash: dataset, specification: {} },
    taskFingerprint: {},
    evaluation: {},
    proposedModel: { backbone: { type: "linear", shared: !runID.startsWith("baseline") } },
    hypothesisSnapshot: { experimentContract: { mode: "controlled", comparisonRunID: runID.endsWith("-b") ? "baseline-b" : "baseline", changes: [{ operation: "set", path: "backbone.shared", before: false, after: true }] } },
    executedModel: { backbone: "linear" },
    executionVerified: true,
    independentEvidence: true,
    metrics: { mse: 1 },
    primaryMetric: "mse",
    primaryValue: 1,
    direction: "minimize",
    artifactIDs: [],
  }
}

test("experience snapshots retain raw measurements without feeding evaluation decisions back into reflection", () => {
  const original: ExperimentFact = { ...fact("trial"), status: "rejected", error: "Overfit ratio exceeds 3",
    evaluationDecision: { verificationStatus: "failed", accepted: false } }
  const projected = experienceFactForPrompt(original)
  expect(projected).not.toHaveProperty("evaluationDecision")
  expect(projected.status).toBe("succeeded")
  expect(projected.error).toBeUndefined()
  expect(projected.metrics).toEqual(original.metrics)
  expect(projected.executedModel).toEqual(original.executedModel)
  expect(original.status).toBe("rejected")
  const invalid = experienceFactForPrompt({ ...original, executionVerified: false })
  expect(invalid.status).toBe("rejected")
  expect(invalid.error).toBe(original.error)
})

test("transferable experience requires conditions, boundaries, validation and real comparisons", () => {
  const input = draft("trial", "baseline")
  expect(ExperienceDraftSchema.safeParse({ ...input, conditions: [] }).success).toBe(false)
  expect(ExperienceDraftSchema.safeParse({ ...input, facts: [{ metrics: { mse: 0 } }] }).success).toBe(false)
  expect(() => validateExperienceEvidence(input, [fact("trial"), fact("baseline")])).not.toThrow()
  for (const patch of [
    { primaryValue: undefined },
    { executionVerified: false },
    { independentEvidence: false },
    { stage: "smoke" },
  ]) {
    expect(() => validateExperienceEvidence(input, [{ ...fact("trial"), ...patch }, fact("baseline")])).toThrow(
      "independent, verified full runs",
    )
  }
  expect(() => validateExperienceEvidence(input, [fact("trial"), fact("baseline", "foreign-task")])).toThrow(
    "same task",
  )
  const baseline = fact("baseline")
  baseline.dataset.specification = { targetCols: ["different-target"] }
  expect(() => validateExperienceEvidence(input, [fact("trial"), baseline])).toThrow("evaluation settings must match")
  expect(() =>
    validateExperienceEvidence(input, [
      { ...fact("trial"), evaluation: { context: 96, horizon: 24 } },
      { ...fact("baseline"), evaluation: { horizon: 24, context: 96 } },
    ]),
  ).not.toThrow()
})

test("validated principles count dataset contents and preserve the distinction from repeated runs", () => {
  const input = { ...draft("trial", "baseline"), level: "validated_principle" as const }
  expect(() => validateExperienceEvidence(input, [fact("trial"), fact("baseline")])).toThrow(
    "at least two distinct datasets",
  )
  const second = { runID: "trial-b", comparisonRunID: "baseline-b", relation: "supports" as const }
  expect(
    validateExperienceEvidence({ ...input, evidence: [...input.evidence, second] }, [
      fact("trial"),
      fact("baseline"),
      fact("trial-b", "data-b"),
      fact("baseline-b", "data-b"),
    ]),
  ).toBe(2)
  expect(() =>
    validateExperienceEvidence({ ...input, evidence: [...input.evidence, second] }, [
      fact("trial"),
      fact("baseline"),
      fact("trial-b"),
      fact("baseline-b"),
    ]),
  ).toThrow("at least two distinct datasets")
  const execution = {
    ...input,
    claimType: "execution" as const,
    evidence: [
      { runID: "trial", relation: "supports" as const },
      { runID: "trial-b", relation: "supports" as const },
    ],
  }
  expect(validateExperienceEvidence(execution, [fact("trial"), fact("trial-b", "data-b")])).toBe(2)
  expect(
    validateExperienceEvidence(execution, [
      { ...fact("trial"), status: "failed", executionVerified: false, error: "out of memory" },
      { ...fact("trial-b", "data-b"), status: "invalid", executionVerified: false, error: "execution mismatch" },
    ]),
  ).toBe(2)
})

const seed = (directory: string, name: string, values: string) =>
  Effect.gen(function* () {
    const svc = yield* Research.Service
    const file = path.join(directory, `${name}.csv`)
    yield* Effect.promise(() => writeFile(file, `date,OT\n${values}\n`))
    const task = yield* svc.createTask({
      title: name,
      domainID: "tsf",
      mode: "review",
      taskSpec: {
        contextLength: 96,
        predictionLengths: [24],
        dataset: { loaderID: "local_csv", path: file, targetCols: ["OT"] },
        metadata: {
          businessContext: "benchmark",
          interpretability: "none_required",
          deploymentTarget: "local_research",
        },
      },
      objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
      budget: { maxRuns: 20 },
    })
    const candidate = yield* svc.createCandidate({
      taskID: task.id,
      domainID: "tsf",
      candidateSpec: Research.DomainRegistry.buildBaselines("tsf", task.taskSpec)[0]!.candidateSpec,
      rationale: "Controlled trial",
      riskLevel: "low",
      approvalStatus: "auto_approved",
      generatedBy: "human",
    })
    const usage = {
      executionContract: { status: "verified", manifest: { actual: { backbone: "linear", optimizer: "adam" } } },
    }
    const comparison = yield* svc.createRun({
      taskID: task.id,
      candidateID: candidate.id,
      stage: "full",
      status: "succeeded",
      metrics: { val_avg_mse: 0.5 },
      resourceUsage: usage,
    })
    const beforeLR = (candidate.candidateSpec.trainingStrategy as any).optimizer.lr
    const trial = yield* svc.createCandidate({ taskID: task.id, domainID: "tsf", candidateSpec: { ...candidate.candidateSpec, trainingStrategy: { ...(candidate.candidateSpec.trainingStrategy as any), optimizer: { ...(candidate.candidateSpec.trainingStrategy as any).optimizer, lr: beforeLR / 2 } } }, rationale: "Matched LR intervention", riskLevel: "low", approvalStatus: "auto_approved", generatedBy: "human" })
    const run = yield* svc.createRun({
      taskID: task.id,
      candidateID: trial.id,
      stage: "full",
      status: "succeeded",
      metrics: { val_avg_mse: 0.7 },
      resourceUsage: { ...usage, hypothesisSnapshot: { experimentContract: { mode: "controlled", comparisonRunID: comparison.id, changes: [{ operation: "set", path: "trainingStrategy.optimizer.lr", before: beforeLR, after: beforeLR / 2 }] } } },
    })
    return { task, candidate: trial, run, comparison }
  })

it.live("duplicate attempts cannot write new experience and local copies cannot resurrect quarantined global records", () =>
  provideTmpdirInstance(directory => Effect.gen(function* () {
    const svc = yield* Research.Service
    const a = yield* seed(directory, "curation-local", "2024-01-01,1\n2024-01-02,2\n2024-01-03,3")
    for (const resourceUsage of [{ ...a.run.resourceUsage, duplicateExperiment: true }, a.run.resourceUsage]) {
      const duplicate = yield* svc.createRun({ taskID: a.task.id, candidateID: a.candidate.id, stage: "full",
        status: "rejected", metrics: {}, resourceUsage })
      yield* Effect.promise(async () => {
        await expect(writeExperience(a.task.id, {
          ...draft(duplicate.id), level: "experiment_fact", claimType: "observation",
        })).rejects.toThrow("new independent observation")
      })
    }
    const written = yield* Effect.promise(() => writeExperience(a.task.id, draft(a.run.id, a.comparison.id)))
    const memory = written.memory
    Database.use(db => db.insert(ResearchMemoryTable).values({
      id: memory.id, task_id: memory.taskID, domain_id: memory.domainID,
      fingerprint_summary: memory.fingerprintSummary, candidate_summary: memory.candidateSummary,
      outcome: memory.outcome, lesson: memory.lesson, time_created: memory.time.created, time_updated: memory.time.updated,
    }).run())
    const library = new ExperienceLibrary(experienceLibraryPath(directory))
    try {
      const sqlite = new SQLite(library.databasePath, { readonly: true })
      const raw = (sqlite.query("SELECT memory_json FROM research_experience WHERE id=?").get(memory.id) as { memory_json: string }).memory_json
      sqlite.close()
      library.curate([{ experienceID: memory.id, review: {
        schemaVersion: "experience_curation.v1", status: "quarantined", sourceDigest: experienceSourceDigest(raw),
        reviewer: "regression-test", reviewedAt: Date.now(), reasons: ["test-quarantine"], notes: [],
        interpretation: groundedExperienceInterpretation(experienceFromMemory(JSON.parse(raw))!),
      } }])
      expect(readExperiences(a.task.id)).toEqual([])
      expect(yield* svc.listMemory(a.task.id)).toEqual([])
      expect(library.list({ experienceID: memory.id, includeOriginal: true })).toHaveLength(1)
    } finally { library.close() }
  }).pipe(Effect.provide(layer)), { git: true, config: { formatter: false, lsp: false } }), 30_000)

it.live("explicit claims evolve through the real writer across datasets without copying or relabeling parent evidence", () =>
  provideTmpdirInstance(directory => Effect.gen(function* () {
    const svc = yield* Research.Service
    const a = yield* seed(directory, "evolution-a", "2024-01-01,1\n2024-01-02,2\n2024-01-03,3")
    const b = yield* seed(directory, "evolution-b", "2024-01-01,4\n2024-01-02,7\n2024-01-03,10")
    const c = yield* seed(directory, "evolution-c", "2024-01-01,3\n2024-01-02,9\n2024-01-03,12")
    const root = yield* Effect.promise(() => writeExperience(a.task.id, { ...draft(a.run.id, a.comparison.id),
      evolution: { relation: "supports", claim: {
        statement: "Under the captured source recipe, halving the learning rate increases validation MSE.",
        dataConditions: ["Local univariate CSV tasks with context 96 and horizon 24; inspect source profiles."],
        operation: "Halve Adam learning rate", interventionPaths: ["training_strategy.optimizer.lr"],
        expectedOutcome: { metric: "val_avg_mse", direction: "higher" },
        boundaries: ["Applies only to the recorded recipe and evaluation settings."],
        validationPlan: "Repeat the local paired contrast on different dataset contents; retain opposite outcomes.",
      } } }))
    yield* Effect.promise(() => writeExperience(b.task.id, { ...draft(b.run.id, b.comparison.id),
      evolution: { parentExperienceID: root.memory.id, relation: "supports" } }))
    const counter = yield* svc.createRun({ taskID: c.task.id, candidateID: c.candidate.id, stage: "full", status: "succeeded",
      metrics: { val_avg_mse: .3 }, resourceUsage: c.run.resourceUsage })
    const written = yield* Effect.promise(() => writeExperience(c.task.id, { ...draft(counter.id, c.comparison.id),
      derivedFrom: [root.memory.id], evolution: { parentExperienceID: root.memory.id, relation: "refutes" } }))
    expect(experienceFromMemory(written.memory)!.facts).toHaveLength(2)
    const updated = readExperiences(a.task.id, { experienceID: root.memory.id })[0]!
    const organization = updated.candidateSummary.experienceOrganization as any
    expect(organization.revision).toBe(3)
    expect(organization.validatedRegularity.status).toBe("contested")
    expect(organization.validatedRegularity.supportDatasetContentCount).toBe(2)
    expect(organization.validatedRegularity.counterexampleDatasets).toHaveLength(1)
    expect(organization.experimentFacts.facts).toHaveLength(6)
    expect(experienceFromMemory(updated)).toEqual(experienceFromMemory(root.memory))
  }).pipe(Effect.provide(layer)), { git: true, config: { formatter: false, lsp: false } }), 30_000)

it.live(
  "Reflection writes are optional, grounded, idempotent and available to OptimizerAgent across tasks",
  () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const svc = yield* Research.Service
          const a = yield* seed(directory, "source", "2024-01-01,1\n2024-01-02,2\n2024-01-03,3")
          const b = yield* seed(directory, "target", "2024-01-01,4\n2024-01-02,6\n2024-01-03,8")
          expect(yield* svc.listMemory(a.task.id)).toEqual([])
          const writer = yield* (yield* WriteExperienceTool).init()
          const reader = yield* (yield* ReadExperiencesTool).init()
          const context = (task: typeof a.task, agent: string) => ({
            sessionID: SessionID.make(task.sessionID!),
            messageID: MessageID.make("msg_experience"),
            agent,
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          })
          const entry = draft(a.run.id, a.comparison.id)
          const counter = yield* svc.createRun({ taskID: a.task.id, candidateID: a.candidate.id, stage: "full", status: "succeeded", metrics: { val_avg_mse: 0.4 }, resourceUsage: a.run.resourceUsage })
          // A later file edit must not reattribute the already completed source experiment to dataset B.
          yield* Effect.promise(() =>
            writeFile(path.join(directory, "source.csv"), "date,OT\n2024-01-01,4\n2024-01-02,6\n2024-01-03,8\n"),
          )
          entry.evidence.push({ runID: counter.id, comparisonRunID: a.comparison.id, relation: "refutes" })
          const first = yield* writer.execute(entry, context(a.task, "research-reflection"))
          expect(first.metadata.saved, first.output).toBe(true)
          const saved = JSON.parse(first.output)
          expect(saved.experience).toMatchObject({
            level: "conditional_experience",
            polarity: "negative",
            sourceTaskID: a.task.id,
          })
          const again = JSON.parse((yield* writer.execute(entry, context(a.task, "research-reflection"))).output)
          expect(again.created).toBe(false)
          expect(again.experience.id).toBe(saved.experience.id)
          expect(again.experience.facts[0].taskFingerprint).toBeUndefined()
          const compact = JSON.parse((yield* reader.execute({}, context(a.task, "research-reflection"))).output)
          expect(compact.experiences).toHaveLength(1)
          expect(compact.experiences[0].facts).toBeUndefined()
          expect(compact.experiences[0].sourceRuns[0].runID).toBe(a.run.id)
          const detailed = JSON.parse((yield* reader.execute({ experienceID: saved.experience.id, includeFacts: true }, context(a.task, "research-reflection"))).output)
          expect(detailed.experiences).toHaveLength(1)
          expect(detailed.experiences[0].facts[0].proposedModel).toEqual(a.candidate.candidateSpec)
          const [memory] = yield* svc.listMemory(a.task.id)
          const experience = experienceFromMemory(memory!)!
          expect(memory!.lesson).toContain("trainingStrategy.optimizer.lr")
          expect(memory!.lesson).not.toContain("seasonal")
          expect(experience.unverifiedInterpretation?.intervention).toBe("Add a seasonal component")
          expect(experience.facts[0]).toMatchObject({
            runID: a.run.id,
            primaryValue: 0.7,
    executedModel: { backbone: "linear" },
            executionVerified: true,
          })
          expect(experience.facts[0]!.dataset.contentHash).toHaveLength(64)
          expect((a.run.resourceUsage.experienceContext as Record<string, unknown>).dataset).toEqual(
            experience.facts[0]!.dataset,
          )
          expect(experience.facts[0]!.proposedModel).toEqual(a.candidate.candidateSpec)
          const planning = JSON.parse((yield* reader.execute({}, context(b.task, "research-hypo-planner"))).output)
          expect(planning.experiences).toEqual([])
          const found = JSON.parse((yield* reader.execute({}, context(b.task, "research-optimizer"))).output)
          expect(found.experiences).toHaveLength(1)
          expect(found.experiences[0].purpose).toBe("optimization")
          expect(found.experiences[0]).toMatchObject({
            id: saved.experience.id,
            relationship: "same_domain",
            polarity: "negative",
          })
          const searched = JSON.parse((yield* reader.execute({ scope: "shared", query: "learning rate intervention", limit: 1 }, context(b.task, "research-optimizer"))).output)
          expect(searched.experiences[0].id).toBe(saved.experience.id)
          expect(searched.experiences[0].facts).toBeUndefined()
          expect(searched.experiences[0].sourceRuns[0].runID).toBe(a.run.id)
          expect(searched.experiences[0].detailAccess).toMatchObject({ experienceID: saved.experience.id, includeFacts: true })
          expect(searched.retrieval).toMatchObject({ method: "intent_grounded_bm25_v3", scope: "shared", returnedCount: 1 })
          const unmatched = JSON.parse((yield* reader.execute({ scope: "shared", query: "quasar archaeology" }, context(b.task, "research-hypo-planner"))).output)
          expect(unmatched.available).toBe(true)
          expect(unmatched.retrieval.returnedCount).toBe(0)
          expect(reader.description).not.toContain("no structured experience has been saved yet")
          expect(
            JSON.parse((yield* reader.execute({ scope: "task" }, context(b.task, "research-hypo-planner"))).output)
              .experiences,
          ).toEqual([])
          expect(
            (yield* writer.execute(draft(b.run.id), context(b.task, "research-hypo-planner"))).metadata.saved,
          ).toBe(false)
          expect(
            (yield* writer.execute(draft("rrun_missing"), context(a.task, "research-reflection"))).metadata.saved,
          ).toBe(false)
          expect((yield* writer.execute(draft(b.run.id), context(a.task, "research-reflection"))).metadata.saved).toBe(
            false,
          )
          const promoted = yield* writer.execute(
            { ...draft(b.run.id, b.comparison.id), level: "validated_principle", derivedFrom: [saved.experience.id] },
            context(b.task, "research-reflection"),
          )
          expect(promoted.metadata.saved).toBe(true)
          expect(JSON.parse(promoted.output).experience.supportDatasetCount).toBe(2)
          expect(JSON.parse(promoted.output).experience.evidence).toContainEqual(entry.evidence[1])
          const relabeled = yield* writer.execute(
            {
              ...draft(b.run.id, b.comparison.id),
              derivedFrom: [saved.experience.id],
              evidence: [
                ...draft(b.run.id, b.comparison.id).evidence,
                { runID: counter.id, comparisonRunID: a.comparison.id, relation: "supports" },
              ],
            },
            context(b.task, "research-reflection"),
          )
          expect(relabeled.metadata.saved).toBe(false)
          expect(JSON.parse(relabeled.output).error).toContain("cannot be relabeled")
          const failedRun = yield* svc.createRun({
            taskID: b.task.id,
            candidateID: b.candidate.id,
            stage: "full",
            status: "failed",
          })
          yield* svc.updateRunStatus({ runID: failedRun.id, status: "failed", error: "CUDA out of memory" })
          const failureWrite = yield* writer.execute(
            {
              ...draft(failedRun.id),
              claimType: "execution",
              polarity: "negative",
              statement: "This configuration exceeded the observed memory budget.",
            },
            context(b.task, "research-reflection"),
          )
          expect(failureWrite.metadata.saved).toBe(true)
          expect(JSON.parse(failureWrite.output).experience.facts[0].error).toBe("CUDA out of memory")
          const agents = yield* Agent.Service
          const planner = (yield* agents.list()).find((agent) => agent.name === "research-hypo-planner")!
          const reflection = (yield* agents.list()).find((agent) => agent.name === "research-reflection")!
          expect(Permission.evaluate("read_experiences", "*", planner.permission).action).toBe("allow")
          expect(Permission.evaluate("write_experience", "*", planner.permission).action).toBe("deny")
          expect(Permission.evaluate("write_experience", "*", reflection.permission).action).toBe("allow")
          const large = JSON.parse((yield* writer.execute({ ...draft(a.run.id),
            conditions: Array.from({ length: 20 }, (_, index) => `Oversized scope ${index}: ` + "q".repeat(3900)),
          }, context(a.task, "research-reflection"))).output)
          expect(large.saved, JSON.stringify(large)).toBe(true)
          const largeRead = yield* reader.execute({ experienceID: large.experience.id }, context(b.task, "research-optimizer"))
          const largeResult = JSON.parse(largeRead.output)
          expect(largeRead.metadata).toMatchObject({ truncated: false })
          expect(largeResult.experiences[0]).toMatchObject({ id: large.experience.id, summaryOmitted: true,
            detailAccess: { experienceID: large.experience.id, includeFacts: true } })
          expect(largeResult.retrieval.contextLimited).toBe(true)
          for (const suffix of ["a", "b", "c"]) {
            expect((yield* writer.execute({ ...draft(a.run.id),
              conditions: Array.from({ length: 8 }, (_, index) => `budgetprobe ${suffix} ${index}: ` + "q".repeat(2800)),
            }, context(a.task, "research-reflection"))).metadata.saved).toBe(true)
          }
          const batch = yield* reader.execute({ scope: "shared", limit: 50 }, context(b.task, "research-optimizer"))
          const batchResult = JSON.parse(batch.output)
          expect(batch.metadata).toMatchObject({ truncated: false })
          expect(Buffer.byteLength(batch.output, "utf8")).toBeLessThan(45_000)
          expect(batchResult.retrieval.contextLimited).toBe(true)
          expect(batchResult.retrieval.matchedRecordsInBatch).toBeGreaterThan(batchResult.experiences.length)
          expect(batchResult.experiences).toHaveLength(batchResult.retrieval.returnedCount)
        }).pipe(Effect.provide(layer)),
      { git: true, config: { formatter: false, lsp: false } },
    ),
  30_000,
)

it.live(
  "copied datasets cannot promote a principle",
  () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const a = yield* seed(directory, "one", "2024-01-01,1\n2024-01-02,2\n2024-01-03,3")
          const b = yield* seed(directory, "copy", "2024-01-01,1\n2024-01-02,2\n2024-01-03,3")
          const stored = yield* Effect.promise(() => writeExperience(a.task.id, draft(a.run.id, a.comparison.id)))
          const failed = yield* Effect.promise(() =>
            writeExperience(b.task.id, {
              ...draft(b.run.id, b.comparison.id),
              level: "validated_principle",
              derivedFrom: [stored.memory.id],
            }).then(
              () => "unexpected",
              (error: Error) => error.message,
            ),
          )
          expect(failed).toContain("at least two distinct datasets")
          expect(readExperiences(a.task.id).map((memory) => memory.id)).toEqual([stored.memory.id])
        }).pipe(Effect.provide(layer)),
      { git: true, config: { formatter: false, lsp: false } },
    ),
  30_000,
)

it.live("experience is directly readable and refinable across projects with independent task databases", () =>
  Effect.gen(function* () {
    const source = yield* provideTmpdirInstance((directory) => Effect.gen(function* () {
      const svc = yield* Research.Service
      const seeded = yield* seed(directory, "source-project", "2024-01-01,1\n2024-01-02,2\n2024-01-03,3")
      const counter = yield* svc.createRun({ taskID: seeded.task.id, candidateID: seeded.candidate.id,
        stage: "full", status: "succeeded", metrics: { val_avg_mse: 0.4 }, resourceUsage: seeded.run.resourceUsage })
      const entry = draft(seeded.run.id, seeded.comparison.id)
      entry.evidence.push({ runID: counter.id, comparisonRunID: seeded.comparison.id, relation: "refutes" })
      const saved = yield* Effect.promise(() => writeExperience(seeded.task.id, entry))
      // New experiences go directly to the library, with no task-table foreign key or duplicate memory write.
      expect(Database.use((db) => db.select().from(ResearchMemoryTable).all())).toEqual([])
      return { ...seeded, memory: saved.memory, counter }
    }), { config: { formatter: false, lsp: false } })

    Database.close() // The next project has a fresh in-memory main database; the library remains intact.
    const standalone = new ExperienceLibrary()
    try {
      expect(standalone.list({ experienceID: source.memory.id })[0]?.taskID).toBe(source.task.id)
    } finally { standalone.close() }

    yield* provideTmpdirInstance((directory) => Effect.gen(function* () {
      const svc = yield* Research.Service
      const target = yield* seed(directory, "target-project", "2024-01-01,8\n2024-01-02,5\n2024-01-03,1")
      expect(target.task.projectID).not.toBe(source.task.projectID)
      const recalled = readExperiences(target.task.id)
      expect(recalled.map((memory) => memory.id)).toEqual([source.memory.id])
      expect(recalled[0]!.candidateSummary.experienceSource).toMatchObject({ projectID: source.task.projectID })
      expect(readExperiences(target.task.id, { scope: "project" })).toEqual([])
      expect(readExperiences(target.task.id, { scope: "task" })).toEqual([])
      expect(readExperiences(target.task.id, { query: "does not exist" })).toEqual([])
      expect(readExperiences(target.task.id, { polarity: "positive" })).toEqual([])

      const reader = yield* (yield* ReadExperiencesTool).init()
      const context = { sessionID: SessionID.make(target.task.sessionID!), messageID: MessageID.make("msg_shared_experience"),
        agent: "research-optimizer", abort: AbortSignal.any([]), messages: [], metadata: () => Effect.void, ask: () => Effect.void }
      const output = JSON.parse((yield* reader.execute({ includeFacts: true }, context)).output)
      expect(output.experiences[0]).toMatchObject({ id: source.memory.id, relationship: "cross_project",
        source: { projectID: source.task.projectID } })
      expect(output.experiences[0].facts).toEqual(experienceFromMemory(source.memory)!.facts.map(experienceFactForPrompt))
      yield* Effect.promise(async () => { await expect(writeExperience(target.task.id, draft(source.run.id, source.comparison.id)))
        .rejects.toThrow("Unknown experiment run") })
      yield* Effect.promise(async () => { await expect(writeExperience(target.task.id, { ...draft(target.run.id, target.comparison.id),
        derivedFrom: [source.memory.id], evidence: [...draft(target.run.id, target.comparison.id).evidence,
          { runID: source.counter.id, comparisonRunID: source.comparison.id, relation: "supports" }] }))
        .rejects.toThrow("cannot be relabeled") })
      const promoted = yield* Effect.promise(() => writeExperience(target.task.id, {
        ...draft(target.run.id, target.comparison.id), level: "validated_principle", derivedFrom: [source.memory.id],
      }))
      const experience = experienceFromMemory(promoted.memory)!
      expect(experience.supportDatasetCount).toBe(2)
      expect(experience.draft.evidence).toContainEqual({ runID: source.counter.id, comparisonRunID: source.comparison.id, relation: "refutes" })
      expect(experience.facts.filter((fact) => fact.taskID === source.task.id)).toEqual(experienceFromMemory(source.memory)!.facts)
      expect((yield* svc.listMemory(target.task.id)).map((memory) => memory.id)).toEqual([promoted.memory.id])
      const lessons = yield* (yield* ReadMemoryLessonsTool).init()
      const lessonResult = JSON.parse((yield* lessons.execute({}, context)).output)
      expect(lessonResult.recentLessons).toEqual([promoted.memory.lesson])
      const exported = yield* svc.exportTaskArtifact({ taskID: target.task.id, kind: "research_final_bundle", outputDir: path.join(directory, "export") })
      const memories = yield* Effect.promise(() => readFile(path.join(exported.path, "results", "memory.json"), "utf8").then(JSON.parse))
      expect(memories.map((memory: { id: string }) => memory.id)).toEqual([promoted.memory.id])
      Database.use((db) => db.update(ResearchTaskTable).set({ domain_id: "another-domain" })
        .where(eq(ResearchTaskTable.id, target.task.id)).run())
      expect(readExperiences(target.task.id)).toEqual([])
    }), { git: true, config: { formatter: false, lsp: false } })
  }).pipe(Effect.provide(layer)), 30_000)

it.live("existing structured memory migrates idempotently while legacy summaries stay local", () =>
  provideTmpdirInstance((directory) => Effect.gen(function* () {
    const svc = yield* Research.Service
    const source = yield* seed(directory, "legacy-project", "2024-01-01,1\n2024-01-02,3\n2024-01-03,7")
    const { memory } = yield* Effect.promise(() => writeExperience(source.task.id, draft(source.run.id, source.comparison.id)))
    Database.use((db) => db.insert(ResearchMemoryTable).values({
      id: memory.id, task_id: memory.taskID, domain_id: memory.domainID, fingerprint_summary: memory.fingerprintSummary,
      candidate_summary: memory.candidateSummary, outcome: memory.outcome, lesson: memory.lesson,
      time_created: memory.time.created, time_updated: memory.time.updated,
    }).run())
    yield* svc.createMemory({ taskID: source.task.id, domainID: "tsf", fingerprintSummary: {},
      candidateSummary: {}, outcome: "accepted", lesson: "Unstructured legacy summary" })
    const library = new ExperienceLibrary(path.join(directory, "migrated.db"))
    try {
      expect(migrateProjectExperiences(library).migrated).toBe(1)
      expect(migrateProjectExperiences(library).migrated).toBe(0)
      expect(library.list().map((entry) => entry.id)).toEqual([memory.id])
      expect(experienceFromMemory(library.list()[0]!)!.facts).toEqual(experienceFromMemory(memory)!.facts)
    } finally { library.close() }
  }).pipe(Effect.provide(layer)), { git: true, config: { formatter: false, lsp: false } }), 30_000)

it.live(
  "direct Reflection saves requested optimization experience while direct HypoPlanner filters it by purpose",
  () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const svc = yield* Research.Service
          const source = yield* seed(directory, "direct", "2024-01-01,1\n2024-01-02,3\n2024-01-03,5")
          const target = yield* svc.createTask({
            title: "Fresh planning task",
            domainID: "tsf",
            mode: "autonomous",
            taskSpec: source.task.taskSpec,
            objective: source.task.objective,
            budget: { maxRuns: 10 },
          })
          Database.use((db) => {
            for (const task of [source.task, target])
              db.update(ResearchTaskTable).set({ session_id: null }).where(eq(ResearchTaskTable.id, task.id)).run()
          })
          const keys = [
            "NEO_CAST_LLM_PROVIDER",
            "NEO_CAST_LLM_BASE_URL",
            "NEO_CAST_LLM_MODEL",
            "NEO_CAST_LLM_API_KEY",
          ] as const
          const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
          const fetch = globalThis.fetch
          let writes: ExperienceDraft[] | undefined
          let plannerInput: Record<string, any> | undefined
          let plannerReads = 0
          const analysis = {
            trainingHealthAssessment: "Full metrics are available.",
            hypothesisValidation: "Limited support.",
            attributionAnalysis: "Only the recorded configuration was observed.",
            historicalComparison: "Compare the paired full runs.",
            modelDesignReflection: "Check transfer conditions.",
            nextStepRecommendation: "Validate on another dataset.",
            distillableMemory: "This report summary alone must not become a saved experience.",
          }
          try {
            process.env.NEO_CAST_LLM_PROVIDER = "openai-compatible"
            process.env.NEO_CAST_LLM_BASE_URL = "http://experience.fixture/v1"
            process.env.NEO_CAST_LLM_MODEL = "fixture-model"
            process.env.NEO_CAST_LLM_API_KEY = "fixture-key"
            globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
              const body = JSON.parse(String(init?.body))
              const input = JSON.parse(body.messages[1].content)
              const planning = String(body.messages[0].content).startsWith("You are the NeoResearch HypoPlanner")
              if (planning) plannerInput = input
              else {
                expect(input.experienceWriteSchema.properties.level).toBeDefined()
                expect(input.sourceRuns.some((run: { runID: string }) => run.runID === source.run.id)).toBe(true)
              }
              const content = JSON.stringify(
                planning && plannerReads++ === 0
                  ? { status: "experience_request", request: { scope: "shared", limit: 3, includeFacts: true } }
                  : planning
                  ? {
                      hypotheses: [],
                      nextExperiment: {
                        action: "stop",
                        rationale: "Fixture validates the incoming experience packet.",
                      },
                    }
                  : { ...analysis, ...(writes === undefined ? {} : { experienceWrites: writes }) },
              )
              return body.stream
                ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`, {
                    headers: { "content-type": "text/event-stream" },
                  })
                : new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
                    headers: { "content-type": "application/json" },
                  })
            }) as typeof globalThis.fetch
            const skipped = yield* svc.runReflectionAgent({ taskID: source.task.id, stoppedReason: "max_iterations" })
            expect(skipped.llm.status).toBe("used")
            expect(skipped.experienceWriteResults).toEqual([])
            expect(yield* svc.listMemory(source.task.id)).toEqual([])
            writes = [draft(source.run.id, source.comparison.id)]
            const saved = yield* svc.runReflectionAgent({ taskID: source.task.id, stoppedReason: "max_iterations" })
            expect(saved.experienceWriteResults).toHaveLength(1)
            expect(saved.experienceWriteResults![0]!.saved).toBe(true)
            const planned = yield* svc.runHypoPlannerAgent({ taskID: target.id })
            expect(planned.llm.status).toBe("used")
            expect(plannerInput!.experiences).toBeUndefined()
            expect(plannerInput!.historyAccess.tool).toBe("experiment_results")
            expect(plannerReads).toBe(2)
            expect(plannerInput!.requestedHistory[0].result.experiences).toEqual([])
            expect(experienceFromMemory((yield* svc.listMemory(source.task.id))[0]!)!.purpose).toBe("optimization")
            writes = [draft("rrun_unknown")]
            const rejected = yield* svc.runReflectionAgent({ taskID: source.task.id, stoppedReason: "max_iterations" })
            expect(rejected.llm.status).toBe("used")
            expect(rejected.experienceWriteResults![0]).toMatchObject({ saved: false })
            expect(yield* svc.listMemory(source.task.id)).toHaveLength(1)
          } finally {
            globalThis.fetch = fetch
            for (const key of keys) {
              if (prior[key] === undefined) delete process.env[key]
              else process.env[key] = prior[key]
            }
          }
        }).pipe(Effect.provide(layer)),
      { git: true, config: { formatter: false, lsp: false } },
    ),
  30_000,
)
