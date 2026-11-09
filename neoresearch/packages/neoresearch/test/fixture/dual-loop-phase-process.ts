// Terminate immediately after SQLite commits a design's outer decision, then
// reopen the same database in a different process.
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@neoresearch-ai/core/cross-spawn-spawner"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Research } from "../../src/research"
import { GlobalBus } from "../../src/bus/global"
import { Event } from "../../src/research/event"
import { Database, eq } from "../../src/storage"
import { ResearchDesignTable } from "../../src/research/research.sql"
import { currentCycle } from "../../src/research/design-store"
import { initProjectors } from "../../src/server/projectors"
import { provideInstance } from "./fixture"
import { createDualLoopFixture, optimizerFixture } from "./dual-loop"

initProjectors()
const directory = process.argv[3]!
const statePath = path.join(directory, "phase-resume.json")
const fixture = optimizerFixture()
const workflow = Effect.gen(function* () {
  const service = yield* Research.Service
  if (process.argv[2] === "first") {
    const { task } = yield* createDualLoopFixture(directory)
    GlobalBus.on("event", (event) => {
      if (event.payload.type !== Event.HypoPlannerAgentCompleted.type) return
      const design = Database.use((db) =>
        db.select().from(ResearchDesignTable).where(eq(ResearchDesignTable.task_id, task.id)).get(),
      )
      if (!design?.phase_receipts["hypoplanner.result"])
        throw new Error("Completion event preceded its durable receipt")
      writeFileSync(
        statePath,
        JSON.stringify({
          taskID: task.id,
          designID: design.id,
          deadline: currentCycle(design.cycle_id).deadline_at,
          calls: fixture.calls,
        }),
      )
      process.exit(19)
    })
    yield* service.runAutonomousLoop({
      taskID: task.id,
      maxIterations: 4,
      maxTrialsPerDesign: 1,
      timeBudgetSeconds: 60,
    })
    yield* Effect.sleep("1 second")
    throw new Error("Expected termination after the phase commit")
  }
  const state = JSON.parse(readFileSync(statePath, "utf8"))
  const loop = yield* service.runAutonomousLoop({ taskID: state.taskID, timeBudgetSeconds: 999 })
  const design = Database.use(
    (db) => db.select().from(ResearchDesignTable).where(eq(ResearchDesignTable.id, state.designID)).get()!,
  )
  console.log(
    JSON.stringify({
      stoppedReason: loop.stoppedReason,
      status: design.status,
      consumed: currentCycle(design.cycle_id).iterations,
      sameDeadline: currentCycle(design.cycle_id).deadline_at === state.deadline,
      firstCalls: state.calls,
      resumeCalls: fixture.calls,
    }),
  )
})

try {
  await Effect.runPromise(
    Effect.scoped(provideInstance(directory)(workflow)).pipe(
      Effect.provide(Layer.mergeAll(Research.defaultLayer, CrossSpawnSpawner.defaultLayer)),
    ),
  )
} finally {
  fixture.restore()
  Database.close()
}
