import { afterEach, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Hono } from "hono"
import { CrossSpawnSpawner } from "@neoresearch-ai/core/cross-spawn-spawner"
import { Research } from "../../src/research"
import { Instance } from "../../src/project/instance"
import { Database, eq } from "../../src/storage"
import { ResearchCycleTable } from "../../src/research/research.sql"
import { activeDesign, designTrials, currentCycle, startDesign } from "../../src/research/design-store"
import { configureDualLoopCycle } from "../../src/research/cycle"
import { loopConfiguration, updateLoopConfiguration, savedLoopControl } from "../../src/research/loop-control"
import { loopState, createResearchCycle } from "../../src/research/recovery"
import { ResearchOperations } from "../../src/research/operation"
import { ResearchRoutes } from "../../src/server/routes/instance/research"
import { ErrorMiddleware } from "../../src/server/middleware"
import { createDualLoopFixture, optimizerFixture } from "../fixture/dual-loop"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Research.defaultLayer, CrossSpawnSpawner.defaultLayer))
afterEach(resetDatabase)

it.live(
  "loop configuration is project-scoped, validates edits, preserves other budgets and does not initialize a cycle",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const { task } = yield* createDualLoopFixture(directory)
        const service = yield* Research.Service
        yield* service.updateTaskBudget({
          taskID: task.id,
          budget: { ...task.budget, maxParallel: 2, loop: { maxRetriesPerCandidate: 4 } },
        })
        const app = new Hono().route("/research", ResearchRoutes()).onError(ErrorMiddleware)
        const url = `/research/tasks/${task.id}/loop-config`
        const state = loopConfiguration(Instance.project.id, task.id)!
        expect(state.locked).toBe(false)
        expect(loopConfiguration("another-project", task.id)).toBeUndefined()
        const invalid = yield* Effect.promise(async () =>
          app.request(url, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              expectedRevision: state.revision,
              configuration: { ...state.configuration, maxTrialsPerDesign: 0 },
            }),
          }),
        )
        expect(invalid.status).toBe(400)
        const input = {
          expectedRevision: state.revision,
          configuration: {
            ...state.configuration,
            maxIterations: 8,
            maxDesigns: 2,
            maxTrialsPerDesign: 4,
            timeBudgetSeconds: 600,
            targetMetricValue: 0.1,
          },
        }
        const saved = updateLoopConfiguration(Instance.project.id, task.id, input)
        expect(saved.status).toBe(200)
        const updated = yield* service.getTask(task.id)
        expect(updated.budget).toMatchObject({
          maxParallel: 2,
          loop: {
            maxRetriesPerCandidate: 4,
            maxIterations: 8,
            maxDesigns: 2,
            maxTrialsPerDesign: 4,
            timeBudgetSeconds: 600,
            targetMetricValue: 0.1,
          },
        })
        expect(Database.use((db) => db.select().from(ResearchCycleTable).all())).toHaveLength(0)
        expect(updateLoopConfiguration(Instance.project.id, task.id, input).status).toBe(409)
      }),
    ),
)

it.live(
  "single-Trial controls share the cycle, diagnose training once, and finish a Design without starting outer planning",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          const { task } = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          const first = yield* service.runAutonomousLoop({
            taskID: task.id,
            executionScope: "trial",
            maxIterations: 6,
            timeBudgetSeconds: 600,
          })
          expect(first.stoppedReason).toBe("trial_completed")
          expect(first.iterations).toHaveLength(1)
          const design = activeDesign(task.id)!
          const deadline = currentCycle(design.cycle_id).deadline_at
          expect(fixture.calls).toMatchObject({ optimizer: 0, trainingReflection: 1, reflection: 0, planner: 0 })
          const second = yield* service.runAutonomousLoop({
            taskID: task.id,
            executionScope: "trial",
            expectedDesignID: design.id,
            maxIterations: 100,
          })
          expect(second.stoppedReason).toBe("trial_completed")
          expect(second.iterations).toHaveLength(2)
          expect(currentCycle(design.cycle_id)).toMatchObject({
            iterations: 2,
            deadline_at: deadline,
            policy: { maxIterations: 6 },
          })
          const finished = yield* service.runAutonomousLoop({
            taskID: task.id,
            executionScope: "finish-design",
            expectedDesignID: design.id,
          })
          expect(finished.stoppedReason).toBe("design_completed")
          expect(designTrials(design.id)).toHaveLength(2)
          expect(activeDesign(task.id)).toMatchObject({ id: design.id, status: "planning", best_metric: 0.2 })
          expect(fixture.calls).toMatchObject({ optimizer: 1, trainingReflection: 2, reflection: 1, planner: 0 })
          expect(loopState(Instance.project.id, task.id)?.control).toMatchObject({
            action: "finish-design",
            status: "paused",
          })
          const resumed = yield* service.runAutonomousLoop({ taskID: task.id })
          expect(resumed.stoppedReason).toBe("planner_stopped")
          expect(fixture.calls.planner).toBe(1)
          expect(fixture.calls.reflection).toBe(1)
          expect(currentCycle(design.cycle_id).iterations).toBe(2)
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "Design-only optimization keeps its fixed design and best earlier Trial, then pauses before HypoPlanner",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          const { task } = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          yield* service.runAutonomousLoop({
            taskID: task.id,
            executionScope: "trial",
            maxIterations: 6,
            maxTrialsPerDesign: 3,
          })
          const design = activeDesign(task.id)!
          const result = yield* service.runAutonomousLoop({
            taskID: task.id,
            executionScope: "design",
            expectedDesignID: design.id,
          })
          expect(result.stoppedReason).toBe("design_completed")
          expect(result.iterations).toHaveLength(3)
          expect(activeDesign(task.id)).toMatchObject({ id: design.id, status: "planning", best_metric: 0.2 })
          expect(fixture.calls).toMatchObject({ optimizer: 2, trainingReflection: 3, reflection: 1, planner: 0 })
          expect(currentCycle(design.cycle_id).iterations).toBe(3)
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "an interrupted bounded control resumes its original one-Trial boundary without repeating completed training",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          const { task } = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          yield* service.runAutonomousLoop({ taskID: task.id, executionScope: "trial", maxIterations: 6 })
          fixture.calls.interrupt = true
          const interrupted = yield* service
            .runAutonomousLoop({ taskID: task.id, executionScope: "trial" })
            .pipe(Effect.exit)
          expect(Exit.isFailure(interrupted)).toBe(true)
          expect(savedLoopControl((yield* service.getTask(task.id)).taskSpec)).toMatchObject({
            action: "trial",
            status: "active",
            completedTrialsBefore: 1,
          })
          fixture.calls.interrupt = false
          const app = new Hono().route("/research", ResearchRoutes()).onError(ErrorMiddleware)
          const state = loopState(Instance.project.id, task.id)!
          const resumed = yield* Effect.promise(async () =>
            app.request(`/research/tasks/${task.id}/resume`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ expectedRevision: state.recovery.revision, requestKey: "resume-bounded-trial" }),
            }),
          )
          expect(resumed.status).toBe(202)
          const receipt = yield* Effect.promise(() => resumed.json())
          const completed = yield* Effect.promise(() =>
            ResearchOperations.wait(Instance.project.id, task.id, receipt.id),
          )
          expect(completed?.status).toBe("completed")
          const recovered = completed?.result as Research.AutonomousLoopResult
          expect(recovered.stoppedReason).toBe("trial_completed")
          expect(recovered.iterations).toHaveLength(2)
          expect(fixture.calls).toMatchObject({ optimizer: 1, trainingReflection: 2, reflection: 0, planner: 0 })
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live("finish-Design refuses an unfinished Trial without executing or charging training", () =>
  provideTmpdirInstance((directory) =>
    Effect.gen(function* () {
      const { task, candidate } = yield* createDualLoopFixture(directory)
      const cycle = configureDualLoopCycle(task, [], { maxIterations: 6, maxTrialsPerDesign: 3 })
      startDesign(cycle.id, candidate)
      const service = yield* Research.Service
      const result = yield* service
        .runAutonomousLoop({
          taskID: task.id,
          executionScope: "finish-design",
          expectedDesignID: activeDesign(task.id)!.id,
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* service.listRuns(task.id)).toHaveLength(0)
      expect(currentCycle(cycle.id).iterations).toBe(0)
      expect(savedLoopControl((yield* service.getTask(task.id)).taskSpec)).toBeUndefined()
    }),
  ),
)

it.live(
  "an expired global deadline stops a bounded control without starting another Trial",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          const { task } = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          yield* service.runAutonomousLoop({
            taskID: task.id,
            executionScope: "trial",
            maxIterations: 6,
            timeBudgetSeconds: 600,
          })
          const design = activeDesign(task.id)!
          Database.use((db) =>
            db
              .update(ResearchCycleTable)
              .set({ deadline_at: Date.now() - 1 })
              .where(eq(ResearchCycleTable.id, design.cycle_id))
              .run(),
          )
          const result = yield* service.runAutonomousLoop({
            taskID: task.id,
            executionScope: "design",
            timeBudgetSeconds: 3600,
          })
          expect(result.stoppedReason).toBe("time_budget_exhausted")
          expect(currentCycle(design.cycle_id).iterations).toBe(1)
          expect(designTrials(design.id)).toHaveLength(1)
          expect(fixture.calls.optimizer).toBe(0)
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "an explicit new cycle unlocks configuration and does not inherit an old bounded-control marker",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          const { task } = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          yield* service.runAutonomousLoop({ taskID: task.id, executionScope: "trial", maxIterations: 6 })
          const previous = loopState(Instance.project.id, task.id)!
          const created = createResearchCycle(Instance.project.id, task.id, {
            expectedRevision: previous.recovery.revision,
            requestKey: "new-configured-cycle",
            maxIterations: 8,
            maxRuns: 40,
          })
          expect(created.status).toBe(200)
          const state = loopState(Instance.project.id, task.id)!
          expect(state.cycleID).not.toBe(previous.cycleID)
          expect(state.control).toBeNull()
          expect(state.budget.trainingUsed).toBe(0)
          const configuration = loopConfiguration(Instance.project.id, task.id)!
          expect(configuration.locked).toBe(false)
          expect(
            updateLoopConfiguration(Instance.project.id, task.id, {
              expectedRevision: configuration.revision,
              configuration: { ...configuration.configuration, maxTrialsPerDesign: 4 },
            }).status,
          ).toBe(200)
          expect(currentCycle(state.cycleID!).policy).toMatchObject({ maxIterations: 8, maxTrialsPerDesign: 4 })
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "configuration locks after cycle start and bounded controls cannot enlarge the shared budget or reset its deadline",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          const { task } = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          yield* service.runAutonomousLoop({
            taskID: task.id,
            executionScope: "trial",
            maxIterations: 2,
            timeBudgetSeconds: 600,
          })
          const state = loopConfiguration(Instance.project.id, task.id)!
          const cycle = Database.use((db) =>
            db.select().from(ResearchCycleTable).where(eq(ResearchCycleTable.task_id, task.id)).get(),
          )!
          expect(state.locked).toBe(true)
          expect(
            updateLoopConfiguration(Instance.project.id, task.id, {
              expectedRevision: state.revision,
              configuration: { ...state.configuration, maxIterations: 100, timeBudgetSeconds: 3600 },
            }).status,
          ).toBe(409)
          const result = yield* service.runAutonomousLoop({
            taskID: task.id,
            executionScope: "design",
            maxIterations: 100,
            timeBudgetSeconds: 3600,
          })
          expect(result.stoppedReason).toBe("max_iterations")
          expect(currentCycle(cycle.id)).toMatchObject({
            iterations: 2,
            deadline_at: cycle.deadline_at,
            policy: { maxIterations: 2, timeBudgetSeconds: 600 },
          })
          expect(savedLoopControl((yield* service.getTask(task.id)).taskSpec)?.status).toBe("stopped")
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "loop-control HTTP rejects stale Design selection and replays an idempotent request without training again",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          const { task } = yield* createDualLoopFixture(directory)
          const app = new Hono().route("/research", ResearchRoutes()).onError(ErrorMiddleware)
          const state = loopState(Instance.project.id, task.id)!
          const url = `/research/tasks/${task.id}/loop-control`
          const options = {
            method: "POST",
            headers: {
              "content-type": "application/json",
              prefer: "respond-async",
              "idempotency-key": "bounded-trial",
            },
            body: JSON.stringify({
              action: "trial",
              expectedRevision: state.recovery.revision,
              expectedDesignID: null,
            }),
          }
          const stale = yield* Effect.promise(async () =>
            app.request(url, {
              ...options,
              body: JSON.stringify({
                action: "trial",
                expectedRevision: state.recovery.revision,
                expectedDesignID: "another-design",
              }),
            }),
          )
          expect(stale.status).toBe(409)
          const started = yield* Effect.promise(async () => app.request(url, options))
          expect(started.status).toBe(202)
          const receipt = yield* Effect.promise(() => started.json())
          const terminal = yield* Effect.promise(() =>
            ResearchOperations.wait(Instance.project.id, task.id, receipt.id),
          )
          expect(terminal?.status).toBe("completed")
          expect((terminal?.result as Research.AutonomousLoopResult).stoppedReason).toBe("trial_completed")
          const replay = yield* Effect.promise(async () => app.request(url, options))
          expect(replay.status).toBe(202)
          expect((yield* Effect.promise(() => replay.json())).id).toBe(receipt.id)
          expect(loopState(Instance.project.id, task.id)?.budget.trainingUsed).toBe(1)
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)
