import { afterEach, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import path from "node:path"
import { readFile } from "node:fs/promises"
import { Research } from "../../src/research"
import { Database, eq } from "../../src/storage"
import {
  ResearchDesignTable,
  ResearchTrainingTrialTable,
  ResearchCandidateTable,
  ResearchCycleTable,
  ResearchTaskTable,
} from "../../src/research/research.sql"
import {
  activeDesign,
  designTrials,
  candidateTrial,
  currentCycle,
  reserveTrialExecution,
  resolveTrialContract,
  completeTrial,
} from "../../src/research/design-store"
import { designDigest, optimizedRecipe, trainingContract } from "../../src/research/design-contract"
import { buildTSFBaselines, TSFCandidateRecipe } from "../../src/research/domains/tsf"
import { validateOptimizerDecision } from "../../src/research/agents/optimizer-agent"
import { validateCandidateAgainstHypothesis } from "../../src/research/execution-contract"
import { readDesignHistory } from "../../src/research/design-history"
import { resumeState } from "../../src/research/recovery"
import { createDualLoopFixture, optimizerFixture } from "../fixture/dual-loop"
import { resetDatabase } from "../fixture/db"
import { provideTmpdirInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Research.defaultLayer, CrossSpawnSpawner.defaultLayer))
afterEach(resetDatabase)

test("training configuration changes preserve design identity, while preprocessing and structural dimensions do not", () => {
  const spec = buildTSFBaselines({
    contextLength: 96,
    predictionLengths: [24],
    dataset: { loaderID: "local_csv", targetCols: ["OT"] },
  })[0]!.candidateSpec
  const recipe = TSFCandidateRecipe.parse(spec)
  const strategy = structuredClone(recipe.trainingStrategy)
  strategy.optimizer.lr /= 2
  strategy.optimizer.weightDecay = 0.01
  strategy.loss = { base: "mae", horizonWeighting: "uniform" }
  const next = optimizedRecipe(spec, strategy)
  expect(designDigest(next)).toBe(designDigest(spec))
  expect(trainingContract(spec, next, "full-reference").changes.map((change) => change.path)).toContain(
    "trainingStrategy.loss",
  )
  expect(() => optimizedRecipe(spec, { ...strategy, budget: { ...strategy.budget, seed: 7 } })).toThrow("seed")
  expect(() => trainingContract(spec, spec, "full-reference")).toThrow("unchanged")
  expect(() =>
    trainingContract(
      spec,
      { ...next, preprocessing: { actions: [{ type: "last_value_centering" }] } },
      "full-reference",
    ),
  ).toThrow("fixed design")
  expect(() =>
    validateOptimizerDecision(
      { action: "tune", rationale: "change architecture", trainingStrategy: strategy, backbone: { type: "linear" } },
      spec,
    ),
  ).toThrow()
})

it.live(
  "three training trials share one fixed design and return its earlier best model before outer replanning",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          const { task, hypothesis } = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          const loop = yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 4, maxTrialsPerDesign: 3 })
          expect(loop.stoppedReason).toBe("planner_stopped")
          expect(loop.iterations).toHaveLength(3)
          expect(fixture.calls.optimizer).toBe(2)
          expect(fixture.calls.planner).toBe(1)
          const designs = Database.use((db) =>
            db.select().from(ResearchDesignTable).where(eq(ResearchDesignTable.task_id, task.id)).all(),
          )
          expect(designs).toHaveLength(1)
          const design = designs[0]!
          expect(design.best_metric).toBe(0.2)
          expect(design.best_run_id).toBe(loop.iterations[1]!.run.id)
          expect(design.status).toBe("completed")
          expect(currentCycle(design.cycle_id).iterations).toBe(3)
          expect(loop.iterations.every((item) => item.candidate.hypothesisID === hypothesis.id)).toBe(true)
          const trials = designTrials(design.id)
          expect(trials[0]!.contract).toBeNull()
          expect(trials[1]!.contract!.comparisonRunID).toBe(loop.iterations[0]!.run.id)
          const tuningHistory = yield* Effect.promise(() =>
            readDesignHistory(task.id, { runID: loop.iterations[1]!.run.id }),
          )
          expect(tuningHistory.runs[0]!.attribution).toMatchObject({ status: "eligible", scope: "optimization" })
          for (const trial of trials)
            expect(designDigest((trial.result as any).candidate.candidateSpec)).toBe(design.design_digest)
          const champion = yield* service.getChampion(task.id)
          expect(champion?.runID).toBe(design.best_run_id ?? undefined)
          const calls = (yield* Effect.promise(() => readFile(path.join(directory, "training-calls.jsonl"), "utf8")))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
          expect(calls.filter((call) => call.stage === "full")).toHaveLength(3)
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "a shared budget of two stops both loops after two real training attempts",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          const { task } = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          const loop = yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 2, maxTrialsPerDesign: 10 })
          expect(loop.stoppedReason).toBe("max_iterations")
          expect(loop.iterations).toHaveLength(2)
          expect(fixture.calls.planner).toBe(0)
          const trial = candidateTrial(loop.iterations[0]!.candidate.id)!
          const cycle = Database.use(
            (db) => db.select().from(ResearchDesignTable).where(eq(ResearchDesignTable.id, trial.design_id)).get()!,
          )
          expect(currentCycle(cycle.cycle_id).iterations).toBe(2)
          expect(reserveTrialExecution(loop.iterations[1]!.candidate.id, loop.iterations[1]!.run.id)).toBe(true)
          expect(currentCycle(cycle.cycle_id).iterations).toBe(2)
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "an interrupted optimization resumes the same design without rerunning the initial full training",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          const { task } = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          fixture.calls.interrupt = true
          const failed = yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 4 }).pipe(Effect.exit)
          expect(failed._tag).toBe("Failure")
          const design = activeDesign(task.id)!
          expect(designTrials(design.id)).toHaveLength(1)
          expect(currentCycle(design.cycle_id).iterations).toBe(1)
          const state = resumeState(task.projectID, task.id)!
          expect(state.activeDesignID).toBe(design.id)
          expect(state.loopPhase).toBe("optimization")
          fixture.calls.interrupt = false
          const loop = yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 99 })
          expect(loop.stoppedReason).toBe("planner_stopped")
          expect(currentCycle(design.cycle_id).policy.maxIterations).toBe(4)
          expect(currentCycle(design.cycle_id).iterations).toBe(3)
          expect(designTrials(design.id)).toHaveLength(3)
          const calls = (yield* Effect.promise(() => readFile(path.join(directory, "training-calls.jsonl"), "utf8")))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
          expect(calls.filter((call) => call.stage === "full")).toHaveLength(3)
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "a crash after training but before trial completion replays the persisted run and keeps its budget charge",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const { task } = yield* createDualLoopFixture(directory)
        const service = yield* Research.Service
        const first = yield* service.runAutonomousIteration({ taskID: task.id })
        const trial = candidateTrial(first.candidate.id)!
        const design = activeDesign(task.id)!
        Database.transaction((db) => {
          db.update(ResearchTrainingTrialTable)
            .set({ status: "pending", result: null })
            .where(eq(ResearchTrainingTrialTable.id, trial.id))
            .run()
          db.update(ResearchDesignTable)
            .set({ best_metric: null, best_run_id: null, no_improve: 0 })
            .where(eq(ResearchDesignTable.id, design.id))
            .run()
        })
        const before = yield* Effect.promise(() => readFile(path.join(directory, "training-calls.jsonl"), "utf8"))
        const resumed = yield* service.runAutonomousIteration({ taskID: task.id })
        expect(resumed.run.id).toBe(first.run.id)
        expect(currentCycle(design.cycle_id).iterations).toBe(1)
        expect(yield* Effect.promise(() => readFile(path.join(directory, "training-calls.jsonl"), "utf8"))).toBe(before)
        expect(candidateTrial(first.candidate.id)?.status).toBe("completed")
      }),
    ),
  60000,
)

it.live(
  "persisted training contracts reject architecture tampering and preserve the original hypothesis",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          const { task, hypothesis } = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 2 })
          const candidates = yield* service.listCandidates(task.id)
          const tuned = candidates.find((candidate) => candidate.generatedBy === "optimizer")!
          expect(validateCandidateAgainstHypothesis(hypothesis, tuned)).toEqual([])
          const original = (yield* service.listHypotheses(task.id))[0]!
          expect(original.experimentContract).toEqual(hypothesis.experimentContract)
          const spec = { ...tuned.candidateSpec, preprocessing: { actions: [{ type: "last_value_centering" }] } }
          Database.use((db) =>
            db
              .update(ResearchCandidateTable)
              .set({ candidate_spec: spec })
              .where(eq(ResearchCandidateTable.id, tuned.id))
              .run(),
          )
          expect(() => resolveTrialContract({ ...tuned, candidateSpec: spec })).toThrow("fixed design")
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "one trial per design disables OptimizerAgent and returns directly to the outer planner",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          const { task } = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          const result = yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 4, maxTrialsPerDesign: 1 })
          expect(result.iterations).toHaveLength(1)
          expect(fixture.calls.optimizer).toBe(0)
          expect(fixture.calls.planner).toBe(1)
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "a persisted optimizer decision survives interruption before candidate creation",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          const { task } = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          yield* service.runAutonomousIteration({ taskID: task.id })
          const design = activeDesign(task.id)!
          Database.use((db) =>
            db
              .update(ResearchCycleTable)
              .set({ policy: { maxIterations: 2 } })
              .where(eq(ResearchCycleTable.id, design.cycle_id))
              .run(),
          )
          yield* service.runOptimizerAgent({ taskID: task.id, designID: design.id })
          expect(fixture.calls.optimizer).toBe(1)
          fixture.calls.interrupt = true
          const result = yield* service.runAutonomousLoop({ taskID: task.id })
          expect(result.stoppedReason).toBe("max_iterations")
          expect(fixture.calls.optimizer).toBe(1)
          expect(currentCycle(design.cycle_id).iterations).toBe(2)
          expect(designTrials(design.id)).toHaveLength(2)
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "duplicate result refunds are idempotent and cannot become best-model or plateau evidence",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const { task } = yield* createDualLoopFixture(directory)
        const service = yield* Research.Service
        const result = yield* service.runAutonomousIteration({ taskID: task.id })
        const design = activeDesign(task.id)!
        const trial = candidateTrial(result.candidate.id)!
        Database.transaction((db) => {
          db.update(ResearchTrainingTrialTable)
            .set({ status: "pending", result: null })
            .where(eq(ResearchTrainingTrialTable.id, trial.id))
            .run()
          db.update(ResearchDesignTable)
            .set({ best_metric: null, best_run_id: null, no_improve: 0 })
            .where(eq(ResearchDesignTable.id, design.id))
            .run()
        })
        const cached = {
          ...result.run,
          resourceUsage: { ...result.run.resourceUsage, duplicateExperiment: true, independentEvidence: false },
        }
        completeTrial(result.candidate.id, {}, cached, "val_avg_mse", "minimize")
        completeTrial(result.candidate.id, {}, cached, "val_avg_mse", "minimize")
        expect(currentCycle(design.cycle_id).iterations).toBe(0)
        expect(activeDesign(task.id)?.best_run_id).toBeNull()
        expect(activeDesign(task.id)?.no_improve).toBe(0)
      }),
    ),
  60000,
)

it.live(
  "an unconfirmed running trial blocks duplicate execution without consuming more budget",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const { task } = yield* createDualLoopFixture(directory)
        const service = yield* Research.Service
        const first = yield* service.runAutonomousIteration({ taskID: task.id })
        const trial = candidateTrial(first.candidate.id)!
        const design = activeDesign(task.id)!
        Database.use((db) =>
          db
            .update(ResearchTrainingTrialTable)
            .set({ status: "pending", result: null })
            .where(eq(ResearchTrainingTrialTable.id, trial.id))
            .run(),
        )
        yield* service.updateRunStatus({ runID: first.run.id, status: "running" })
        const before = yield* Effect.promise(() => readFile(path.join(directory, "training-calls.jsonl"), "utf8"))
        const result = yield* service.runAutonomousIteration({ taskID: task.id }).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
        expect(currentCycle(design.cycle_id).iterations).toBe(1)
        expect(yield* Effect.promise(() => readFile(path.join(directory, "training-calls.jsonl"), "utf8"))).toBe(before)
      }),
    ),
  60000,
)

it.live(
  "resuming a fixed design rejects changed evaluation settings before replay or execution",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const { task } = yield* createDualLoopFixture(directory)
        const service = yield* Research.Service
        const result = yield* service.runAutonomousIteration({ taskID: task.id })
        const trial = candidateTrial(result.candidate.id)!
        const design = activeDesign(task.id)!
        Database.transaction((db) => {
          db.update(ResearchTrainingTrialTable)
            .set({ status: "pending", result: null })
            .where(eq(ResearchTrainingTrialTable.id, trial.id))
            .run()
          db.update(ResearchTaskTable)
            .set({
              task_spec: {
                ...task.taskSpec,
                evaluation: {
                  ...(task.taskSpec.evaluation as Research.JsonRecord),
                  seeds: [123],
                },
              },
            })
            .where(eq(ResearchTaskTable.id, task.id))
            .run()
        })
        const before = yield* Effect.promise(() => readFile(path.join(directory, "training-calls.jsonl"), "utf8"))
        const resumed = yield* service.runAutonomousIteration({ taskID: task.id }).pipe(Effect.exit)
        expect(resumed._tag).toBe("Failure")
        expect(currentCycle(design.cycle_id).iterations).toBe(1)
        expect(yield* Effect.promise(() => readFile(path.join(directory, "training-calls.jsonl"), "utf8"))).toBe(before)
      }),
    ),
  60000,
)

it.live(
  "a rejected tuning result cannot remain champion or block a later valid trial",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          const { task } = yield* createDualLoopFixture(directory, { rejectTuned: true })
          const service = yield* Research.Service
          const result = yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 3 })
          expect(result.iterations[1]!.run.status).toBe("rejected")
          const champion = yield* service.getChampion(task.id)
          expect(champion?.primaryMetric).toBe(0.25)
          expect(champion?.runID).toBe(result.iterations[2]!.run.id)
          const trial = candidateTrial(result.iterations[2]!.candidate.id)!
          const design = Database.use(
            (db) => db.select().from(ResearchDesignTable).where(eq(ResearchDesignTable.id, trial.design_id)).get()!,
          )
          expect(design.best_run_id).toBe(champion?.runID ?? null)
          expect(currentCycle(design.cycle_id).iterations).toBe(3)
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

test("fixed-design identity, completed execution and consumed budget survive a real process/database reopen", async () => {
  await using tmp = await tmpdir()
  const start = async (mode: string) => {
    const child = Bun.spawn(
      [process.execPath, path.resolve(import.meta.dirname, "../fixture/dual-loop-process.ts"), mode, tmp.path],
      {
        env: { ...process.env, OPENCODE_DB: path.join(tmp.path, "dual-loop.db") },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, stderr).toBe(0)
    return JSON.parse(stdout.trim().split("\n").at(-1)!)
  }
  const first = await start("first")
  const second = await start("resume")
  expect(second).toMatchObject(first)
  expect(second.trialStatus).toBe("completed")
  expect(second.consumed).toBe(1)
  const calls = (await readFile(path.join(tmp.path, "training-calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  expect(calls.filter((call) => call.stage === "full")).toHaveLength(1)
}, 60000)
