// A real file-backed database reopen, independent of bun:test's in-memory preload.
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@neoresearch-ai/core/cross-spawn-spawner"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Research } from "../../src/research"
import { Database, eq } from "../../src/storage"
import { ResearchDesignTable, ResearchTrainingTrialTable } from "../../src/research/research.sql"
import { activeDesign, candidateTrial, currentCycle } from "../../src/research/design-store"
import { provideInstance } from "./fixture"
import { createDualLoopFixture } from "./dual-loop"
import { initProjectors } from "../../src/server/projectors"

initProjectors()

const mode = process.argv[2]!
const directory = process.argv[3]!
const workflow = Effect.gen(function* () {
  const service = yield* Research.Service
  if (mode === "first") {
    const { task } = yield* createDualLoopFixture(directory)
    const result = yield* service.runAutonomousIteration({ taskID: task.id })
    const design = activeDesign(task.id)!
    const trial = candidateTrial(result.candidate.id)!
    // Emulate termination after the runner committed its result, before the trial receipt transaction.
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
    const state = { taskID: task.id, designID: design.id, trialID: trial.id, runID: result.run.id }
    yield* Effect.promise(() => writeFile(path.join(directory, "resume-state.json"), JSON.stringify(state)))
    console.log(JSON.stringify({ ...state, consumed: currentCycle(design.cycle_id).iterations }))
  } else {
    const state = JSON.parse(yield* Effect.promise(() => readFile(path.join(directory, "resume-state.json"), "utf8")))
    const result = yield* service.runAutonomousIteration({ taskID: state.taskID })
    const design = activeDesign(result.run.taskID)!
    console.log(
      JSON.stringify({
        taskID: result.run.taskID,
        designID: design.id,
        trialID: candidateTrial(result.candidate.id)!.id,
        runID: result.run.id,
        consumed: currentCycle(design.cycle_id).iterations,
        trialStatus: candidateTrial(result.candidate.id)!.status,
      }),
    )
  }
})

await Effect.runPromise(
  Effect.scoped(provideInstance(directory)(workflow)).pipe(
    Effect.provide(Layer.mergeAll(Research.defaultLayer, CrossSpawnSpawner.defaultLayer)),
  ),
)
Database.close()
