import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Hono } from "hono"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Research } from "../../src/research"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { Database, eq } from "../../src/storage"
import {
  ResearchCycleTable,
  ResearchRunTable,
  ResearchDesignTable,
  ResearchTaskTable,
  ResearchTrainingTrialTable,
} from "../../src/research/research.sql"
import { loopState, resumeState } from "../../src/research/recovery"
import { LoopStateSchema } from "../../src/research/loop-state-schema"
import { ResearchRoutes } from "../../src/server/routes/instance/research"
import { activeDesign } from "../../src/research/design-store"
import { createDualLoopFixture, optimizerFixture } from "../fixture/dual-loop"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Research.defaultLayer, CrossSpawnSpawner.defaultLayer, Bus.defaultLayer))
afterEach(resetDatabase)

it.live("loop-state HTTP reads are scoped, schema-valid and do not initialize a search", () =>
  provideTmpdirInstance((directory) =>
    Effect.gen(function* () {
      const { task } = yield* createDualLoopFixture(directory)
      const app = new Hono().route("/research", ResearchRoutes())
      const response = yield* Effect.promise(async () => app.request(`/research/tasks/${task.id}/loop-state`))
      expect(response.status).toBe(200)
      const state = LoopStateSchema.parse(yield* Effect.promise(() => response.json()))
      expect(state.cycleID).toBeNull()
      expect(state.policy).toBeNull()
      expect(state.budget.trainingLimit).toBeNull()
      expect(state.designs).toEqual([])
      expect(Database.use((db) => db.select().from(ResearchCycleTable).all())).toHaveLength(0)
      expect(loopState("another-project", task.id)).toBeUndefined()
      expect(
        (yield* Effect.promise(async () =>
          app.request(`/research/tasks/${Research.ResearchTaskID.ascending()}/loop-state`),
        )).status,
      ).toBe(404)
    }),
  ),
)

it.live("completed training recovers at its uncommitted diagnosis and read snapshots never consume budget", () =>
  provideTmpdirInstance((directory) =>
    Effect.gen(function* () {
      const fixture = optimizerFixture()
      try {
        const { task } = yield* createDualLoopFixture(directory)
        const service = yield* Research.Service
        yield* service.runAutonomousIteration({ taskID: task.id, stage: "full" })
        const design = activeDesign(task.id)!
        const before = Database.use((db) => db.select().from(ResearchCycleTable).get())!
        const state = LoopStateSchema.parse(loopState(Instance.project.id, task.id))
        expect(state.phase).toBe("training_reflection")
        expect(state.recovery.loopPhase).toBe(state.phase)
        expect(state.recovery.activeTrialID).toBe(state.activeTrialID)
        expect(state.activeTrialID).toBe(state.designs[0]!.trials[0]!.id)
        expect(state.budget.trainingUsed).toBe(1)
        expect(state.budget.runRecordsUsed).toBe(2)
        Database.use((db) =>
          db
            .update(ResearchTrainingTrialTable)
            .set({ status: "pending" })
            .where(eq(ResearchTrainingTrialTable.id, state.activeTrialID!))
            .run(),
        )
        const finalizing = loopState(Instance.project.id, task.id)!
        expect(finalizing.phase).toBe("trial_finalization")
        expect(finalizing.recovery.loopPhase).toBe(finalizing.phase)
        expect(finalizing.bestModel).toBeNull()
        expect(finalizing.budget.trainingUsed).toBe(1)
        Database.use((db) =>
          db
            .update(ResearchTrainingTrialTable)
            .set({ status: "completed" })
            .where(eq(ResearchTrainingTrialTable.id, state.activeTrialID!))
            .run(),
        )
        for (let index = 0; index < 3; index++) loopState(Instance.project.id, task.id)
        expect(Database.use((db) => db.select().from(ResearchCycleTable).get())).toEqual(before)
        expect(fixture.calls.trainingReflection).toBe(0)
        yield* service.runTrainingReflection({ taskID: task.id, designID: design.id, trialID: state.activeTrialID! })
        yield* service.updateTaskStatus({ taskID: task.id, status: "paused" })
        const recovered = loopState(Instance.project.id, task.id)!
        expect(recovered.phase).toBe("optimization")
        expect(recovered.recovery.loopPhase).toBe("optimization")
        expect(recovered.budget.trainingUsed).toBe(1)
        expect(recovered.designs[0]!.trials[0]!.trainingReflection.status).toBe("completed")
      } finally {
        fixture.restore()
      }
    }),
  ),
)

it.live("one design groups three trials, its earlier best, leaf training changes and scoped reflection receipts", () =>
  provideTmpdirInstance((directory) =>
    Effect.gen(function* () {
      const fixture = optimizerFixture()
      try {
        const { task } = yield* createDualLoopFixture(directory)
        const service = yield* Research.Service
        const events: Array<{ type: string; properties: { metadata?: Record<string, unknown> } }> = []
        const bus = yield* Bus.Service
        const unsubscribe = yield* bus.subscribeAllCallback((event) => {
          events.push(event)
        })
        const result = yield* service
          .runAutonomousLoop({ taskID: task.id, maxIterations: 4, maxTrialsPerDesign: 3 })
          .pipe(Effect.ensuring(Effect.sync(unsubscribe)))
        const state = LoopStateSchema.parse(loopState(Instance.project.id, task.id))
        expect(state.budget.trainingUsed).toBe(3)
        expect(state.budget.runRecordsUsed).toBe(6)
        expect(state.policy!.maxTrialsPerDesign).toBe(3)
        const optimizerEvents = events.filter((event) => event.type === "research.agent.optimizer.completed")
        expect(optimizerEvents).toHaveLength(2)
        expect(
          optimizerEvents.every(
            (event) => event.properties.metadata?.cycleID === state.cycleID && event.properties.metadata?.trialID,
          ),
        ).toBe(true)
        const reflections = events.filter((event) => event.type === "research.agent.reflection.completed")
        expect(reflections.filter((event) => event.properties.metadata?.reflectionScope === "training")).toHaveLength(3)
        expect(
          reflections.filter((event) => event.properties.metadata?.reflectionScope === "architecture"),
        ).toHaveLength(1)
        expect(
          reflections.every(
            (event) => event.properties.metadata?.cycleID === state.cycleID && event.properties.metadata?.designID,
          ),
        ).toBe(true)
        expect(state.designs).toHaveLength(1)
        const design = state.designs[0]!
        expect(design.trials.map((trial) => trial.index)).toEqual([1, 2, 3])
        expect(design.bestModel!.runID).toBe(result.iterations[1]!.run.id)
        expect(state.bestModel!.value).toBe(0.2)
        expect(design.trials[1]!.changes).toContainEqual({
          path: "trainingStrategy.optimizer.lr",
          before: 0.001,
          after: 0.0005,
        })
        expect(design.trials.every((trial) => trial.trainingReflection.status === "completed")).toBe(true)
        expect(design.architectureReflection.status).toBe("completed")
        expect(design.architectureEvidence!.status).toBe("observation_only")
        expect(state.activeDesignID).toBeNull()
        expect(state.activeTrialID).toBeNull()
        expect(state.phase).toBeNull() // A committed planner stop is not active planning.
        expect(state.stoppedReason).toBe("planner_stopped")
        const run = result.iterations[1]!.run
        Database.use((db) =>
          db
            .update(ResearchRunTable)
            .set({ resource_usage: { ...run.resourceUsage, independentEvidence: false } })
            .where(eq(ResearchRunTable.id, run.id))
            .run(),
        )
        const revised = loopState(Instance.project.id, task.id)!
        expect(revised.designs[0]!.trials[1]!.eligibleForRanking).toBe(false)
        expect(revised.designs[0]!.bestModel!.value).toBe(0.25)
        // The training counter is read from reservations; the UI cannot invent a refund.
        expect(revised.budget.trainingUsed).toBe(3)
        Database.use((db) =>
          db
            .update(ResearchTaskTable)
            .set({ objective: { ...task.objective, primaryMetric: "val_avg_mae" } })
            .where(eq(ResearchTaskTable.id, task.id))
            .run(),
        )
        expect(loopState(Instance.project.id, task.id)!.bestModel).toBeNull()
      } finally {
        fixture.restore()
      }
    }),
  ),
)

it.live("failed smoke is a trial but not a charged full training, and deadlines remain expired on reads", () =>
  provideTmpdirInstance((directory) =>
    Effect.gen(function* () {
      const fixture = optimizerFixture()
      try {
        const { task } = yield* createDualLoopFixture(directory, { failSmokeLR: 0.001 })
        const service = yield* Research.Service
        yield* service.runAutonomousIteration({ taskID: task.id, stage: "full" })
        const design = activeDesign(task.id)!
        Database.use((db) =>
          db
            .update(ResearchCycleTable)
            .set({ deadline_at: Date.now() - 1000 })
            .where(eq(ResearchCycleTable.id, design.cycle_id))
            .run(),
        )
        const state = loopState(Instance.project.id, task.id)!
        expect(state.budget.trainingUsed).toBe(0)
        expect(state.designs[0]!.trials).toHaveLength(1)
        expect(state.designs[0]!.trials[0]!.charged).toBe(false)
        expect(state.designs[0]!.trials[0]!.full).toBeNull()
        expect(state.budget.remainingSeconds).toBe(0)
        expect(state.budget.deadlineAt).toBe(loopState(Instance.project.id, task.id)!.budget.deadlineAt)
        expect(state.bestModel).toBeNull()
      } finally {
        fixture.restore()
      }
    }),
  ),
)

it.live("a fresh current cycle excludes old designs while retaining the task run-record budget", () =>
  provideTmpdirInstance((directory) =>
    Effect.gen(function* () {
      const fixture = optimizerFixture()
      try {
        const { task } = yield* createDualLoopFixture(directory)
        const service = yield* Research.Service
        yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 1 })
        expect(loopState(Instance.project.id, task.id)!.stoppedReason).toBe("max_iterations")
        Database.transaction((db) => {
          db.update(ResearchCycleTable)
            .set({ active_task: null })
            .where(eq(ResearchCycleTable.active_task, task.id))
            .run()
          db.insert(ResearchCycleTable)
            .values({
              id: "next-cycle",
              task_id: task.id,
              active_task: task.id,
              policy: { maxIterations: 9 },
              input_digest: "explicit test cycle",
            })
            .run()
        })
        const state = loopState(Instance.project.id, task.id)!
        expect(state.cycleID).toBe("next-cycle")
        expect(state.stoppedReason).toBeNull()
        expect(state.designs).toEqual([])
        expect(state.budget.trainingUsed).toBe(0)
        expect(state.budget.trainingLimit).toBe(9)
        expect(state.budget.runRecordsUsed).toBe(2)
        expect(state.bestModel).toBeNull()
        expect(
          Database.use((db) =>
            db.select().from(ResearchDesignTable).where(eq(ResearchDesignTable.task_id, task.id)).all(),
          ),
        ).toHaveLength(1)
        expect(resumeState(Instance.project.id, task.id)!.activeDesignID).toBeNull()
      } finally {
        fixture.restore()
      }
    }),
  ),
)
