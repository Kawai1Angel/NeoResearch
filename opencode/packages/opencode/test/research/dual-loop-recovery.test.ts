import { afterEach, expect, spyOn, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Research } from "../../src/research"
import { Database, eq } from "../../src/storage"
import { ResearchDesignTable } from "../../src/research/research.sql"
import { activeDesign, candidateTrial, currentCycle, designTrials } from "../../src/research/design-store"
import { designDigest } from "../../src/research/design-contract"
import { experimentScheduler } from "../../src/research/experiment-runtime"
import { readDesignHistory } from "../../src/research/design-history"
import { createDualLoopFixture, optimizerFixture } from "../fixture/dual-loop"
import { resetDatabase } from "../fixture/db"
import { provideTmpdirInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Research.defaultLayer, CrossSpawnSpawner.defaultLayer))
afterEach(resetDatabase)

const callsAt = async (directory: string) =>
  (await readFile(path.join(directory, "training-calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))

it.live(
  "a failed first full run is repaired within the fixed design without inventing a performance control",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          const { task, hypothesis } = yield* createDualLoopFixture(directory, { failFullLR: 0.001 })
          const service = yield* Research.Service
          const loop = yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 4 })
          expect(loop.stoppedReason).toBe("planner_stopped")
          expect(loop.iterations.map((item) => item.run.status)).toEqual(["failed", "succeeded", "succeeded"])
          const trial = candidateTrial(loop.iterations[0]!.candidate.id)!
          const trials = designTrials(trial.design_id)
          expect(trials).toHaveLength(3)
          expect(trials[1]!.repair_run_id).toBe(loop.iterations[0]!.run.id)
          expect(trials[1]!.contract?.mode).toBe("exploratory")
          expect(trials[1]!.contract?.comparisonRunID).toBeUndefined()
          expect(trials[2]!.contract?.comparisonRunID).toBe(loop.iterations[1]!.run.id)
          const history = yield* Effect.promise(() => readDesignHistory(task.id, { runID: loop.iterations[1]!.run.id }))
          expect(history.runs[0]!.attribution.status).toBe("observation_only")
          expect(new Set(loop.iterations.map((item) => designDigest(item.candidate.candidateSpec))).size).toBe(1)
          expect((yield* service.listHypotheses(task.id))[0]!.experimentContract).toEqual(hypothesis.experimentContract)
          const design = Database.use(
            (db) => db.select().from(ResearchDesignTable).where(eq(ResearchDesignTable.id, trial.design_id)).get()!,
          )
          expect(design.best_run_id).toBe(loop.iterations[1]!.run.id)
          expect(currentCycle(design.cycle_id).iterations).toBe(3)
          expect(fixture.calls.planner).toBe(1)
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "a later failed smoke can advance to another training trial using the earlier valid full control",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          const { task } = yield* createDualLoopFixture(directory, { failSmokeLR: 0.0005 })
          const service = yield* Research.Service
          const loop = yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 4 })
          expect(loop.stoppedReason).toBe("planner_stopped")
          expect(loop.iterations).toHaveLength(3)
          expect(loop.iterations[1]!.run.stage).toBe("smoke")
          expect(loop.iterations[1]!.run.status).toBe("failed")
          const trials = designTrials(candidateTrial(loop.iterations[0]!.candidate.id)!.design_id)
          expect(trials[1]!.full_run_id).toBeNull()
          expect(trials[2]!.contract?.comparisonRunID).toBe(loop.iterations[0]!.run.id)
          expect(trials[2]!.repair_run_id).toBeNull()
          expect(new Set(trials.map((trial) => trial.design_id)).size).toBe(1)
          expect(
            (yield* Effect.promise(() => callsAt(directory))).filter((call) => call.stage === "full"),
          ).toHaveLength(2)
          expect(fixture.calls.optimizer).toBe(2)
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "a failed initial smoke can be repaired without creating another outer design",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          const { task } = yield* createDualLoopFixture(directory, { failSmokeLR: 0.001 })
          const service = yield* Research.Service
          const loop = yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 4 })
          expect(loop.stoppedReason).toBe("planner_stopped")
          expect(loop.iterations.map((item) => item.run.stage)).toEqual(["smoke", "full", "full"])
          const first = candidateTrial(loop.iterations[0]!.candidate.id)!
          const trials = designTrials(first.design_id)
          expect(trials[1]!.repair_run_id).toBe(first.smoke_run_id)
          expect(trials[1]!.contract?.mode).toBe("exploratory")
          expect(trials.every((trial) => trial.status === "completed")).toBe(true)
          expect(fixture.calls.optimizer).toBe(2)
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "the durable deadline kills a long full training and resume cannot grant another attempt or more time",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          const { task } = yield* createDualLoopFixture(directory, { delayFullMs: 30000 })
          const service = yield* Research.Service
          const started = Date.now()
          const loop = yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 4, timeBudgetSeconds: 3 })
          expect(loop.stoppedReason).toBe("time_budget_exhausted")
          expect(Date.now() - started).toBeLessThan(7000)
          expect(loop.iterations).toHaveLength(1)
          expect(loop.iterations[0]!.run.status).toBe("failed")
          const trial = candidateTrial(loop.iterations[0]!.candidate.id)!
          expect(trial.status).toBe("completed")
          const design = Database.use(
            (db) => db.select().from(ResearchDesignTable).where(eq(ResearchDesignTable.id, trial.design_id)).get()!,
          )
          const state = currentCycle(design.cycle_id)
          expect(state.iterations).toBe(1)
          const before = yield* Effect.promise(() => callsAt(directory))
          expect(before.filter((call) => call.stage === "full")).toHaveLength(1)
          expect(() => process.kill(before.find((call) => call.stage === "full")!.pid, 0)).toThrow()
          const resumed = yield* service.runAutonomousLoop({
            taskID: task.id,
            maxIterations: 99,
            timeBudgetSeconds: 999,
          })
          expect(resumed.stoppedReason).toBe("time_budget_exhausted")
          expect(currentCycle(design.cycle_id).deadline_at).toBe(state.deadline_at)
          expect(currentCycle(design.cycle_id).iterations).toBe(1)
          expect(yield* Effect.promise(() => callsAt(directory))).toEqual(before)
          expect(fixture.calls.optimizer + fixture.calls.planner + fixture.calls.reflection).toBe(0)
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "the shared deadline aborts a stalled optimizer request before it can submit another trial",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          fixture.calls.hangOptimizer = true
          const { task } = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          const loop = yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 4, timeBudgetSeconds: 3 })
          expect(loop.stoppedReason).toBe("time_budget_exhausted")
          expect(loop.iterations).toHaveLength(1)
          expect(fixture.calls.optimizer).toBe(1)
          expect(fixture.calls.aborted).toBe(true)
          expect(fixture.calls.planner + fixture.calls.reflection).toBe(0)
          expect(designTrials(candidateTrial(loop.iterations[0]!.candidate.id)!.design_id)).toHaveLength(1)
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "deadline covers scheduler waiting and an independent resume cannot dispatch its expired queued smoke",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const { task } = yield* createDualLoopFixture(directory)
        const service = yield* Research.Service
        // Occupy all runner slots without launching processes, so the trial waits
        // inside the real scheduler rather than inside a mocked training call.
        const blockers: Fiber.Fiber<never, never>[] = []
        for (let index = 0; index < 4; index++) {
          const ready = yield* Deferred.make<void>()
          blockers.push(
            yield* Effect.forkScoped(
              experimentScheduler(directory).execute(
                `block-${index}`,
                4,
                `workspace-${index}`,
                Effect.gen(function* () {
                  yield* Deferred.succeed(ready, undefined)
                  return yield* Effect.never
                }),
              ),
            ),
          )
          yield* Deferred.await(ready)
        }
        const loop = yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 4, timeBudgetSeconds: 2 })
        expect(loop.stoppedReason).toBe("time_budget_exhausted")
        const design = activeDesign(task.id)!
        expect(currentCycle(design.cycle_id).iterations).toBe(0)
        const runs = yield* service.listRuns(task.id)
        expect(runs).toHaveLength(1)
        expect(runs[0]!.status).toBe("queued")
        expect(designTrials(design.id)[0]!.full_run_id).toBeNull()
        for (const blocker of blockers) yield* Fiber.interrupt(blocker)
        const expired = yield* service.runAutonomousIteration({ taskID: task.id }).pipe(Effect.exit)
        expect(expired._tag).toBe("Failure")
        expect((yield* service.listRuns(task.id)).map((run) => [run.id, run.status])).toEqual(
          runs.map((run) => [run.id, "queued"]),
        )
        expect(currentCycle(design.cycle_id).iterations).toBe(0)
      }),
    ),
  60000,
)

// Throw only AFTER the outermost SQLite commit. This models loss of the
// process/response at the handoff, rather than a transaction rollback.
function interruptAfterReceipt(taskID: Research.ResearchTaskID, key: string) {
  const original = Database.transaction
  let depth = 0
  let fired = false
  const spy = spyOn(Database, "transaction").mockImplementation(((...args: Parameters<typeof Database.transaction>) => {
    depth++
    let result: unknown
    try {
      result = original(...args)
    } finally {
      depth--
    }
    if (!depth && !fired) {
      const design = Database.use((db) =>
        db.select().from(ResearchDesignTable).where(eq(ResearchDesignTable.task_id, taskID)).get(),
      )
      if (design?.phase_receipts[key]) {
        fired = true
        throw new Error(`simulated process loss after ${key} commit`)
      }
    }
    return result
  }) as typeof Database.transaction)
  return { restore: () => spy.mockRestore(), fired: () => fired }
}

for (const key of ["reflection.synthesis", "reflection.result", "hypoplanner.plan", "hypoplanner.result"]) {
  it.live(
    `resume after ${key} commit reuses the saved reasoning and commits the outer decision once`,
    () =>
      provideTmpdirInstance((directory) =>
        Effect.gen(function* () {
          const fixture = optimizerFixture()
          const { task } = yield* createDualLoopFixture(directory)
          const fault = interruptAfterReceipt(task.id, key)
          try {
            const service = yield* Research.Service
            const failed = yield* service
              .runAutonomousLoop({ taskID: task.id, maxIterations: 4, maxTrialsPerDesign: 1 })
              .pipe(Effect.exit)
            expect(failed._tag).toBe("Failure")
            expect(fault.fired()).toBe(true)
            fault.restore()
            const before = yield* Effect.promise(() => callsAt(directory))
            const loop = yield* service.runAutonomousLoop({ taskID: task.id })
            expect(loop.stoppedReason).toBe("planner_stopped")
            expect(fixture.calls.reflection).toBe(1)
            expect(fixture.calls.planner).toBe(1)
            expect(activeDesign(task.id)).toBeUndefined()
            expect(yield* Effect.promise(() => callsAt(directory))).toEqual(before)
            const designs = Database.use((db) =>
              db.select().from(ResearchDesignTable).where(eq(ResearchDesignTable.task_id, task.id)).all(),
            )
            expect(designs).toHaveLength(1)
            expect(designs[0]!.phase_receipts["hypoplanner.result"]).toBeDefined()
            const current = yield* service.getTask(task.id)
            expect((current.taskSpec.metadata as any).nextExperiment.action).toBe("stop")
            const artifacts = yield* service.listArtifacts(task.id)
            for (const kind of [
              "reflection_notes_md",
              "next_experiment_plan_md",
              "failure_log_md",
              "hypo_plan_md",
              "hypotheses_yaml",
            ])
              expect(artifacts.filter((artifact) => artifact.kind === kind)).toHaveLength(1)
          } finally {
            fault.restore()
            fixture.restore()
          }
        }),
      ),
    60000,
  )
}

test("a process killed after the planner commit reopens with the same deadline and never calls either phase again", async () => {
  await using directory = await tmpdir()
  const start = async (mode: string, expectedCode: number) => {
    const child = Bun.spawn(
      [
        process.execPath,
        path.resolve(import.meta.dirname, "../fixture/dual-loop-phase-process.ts"),
        mode,
        directory.path,
      ],
      {
        env: { ...process.env, OPENCODE_DB: path.join(directory.path, "phase-loop.db") },
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
  await start("first", 19)
  const result = JSON.parse((await start("resume", 0)).trim().split("\n").at(-1)!)
  expect(result).toMatchObject({
    stoppedReason: "planner_stopped",
    status: "completed",
    consumed: 1,
    sameDeadline: true,
    firstCalls: { reflection: 1, planner: 1 },
    resumeCalls: { reflection: 0, planner: 0, optimizer: 0 },
  })
  expect((await callsAt(directory.path)).filter((call) => call.stage === "full")).toHaveLength(1)
}, 60000)
