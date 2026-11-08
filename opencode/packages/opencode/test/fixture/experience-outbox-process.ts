import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Research } from "../../src/research"
import { ExperienceLibrary } from "../../src/research/experience-library"
import { readExperiences } from "../../src/research/experience-store"
import { Database } from "../../src/storage"
import { initProjectors } from "../../src/server/projectors"
import { createDualLoopFixture, optimizerFixture } from "./dual-loop"
import { provideInstance } from "./fixture"

initProjectors()
const directory = process.argv[3]!
const stateFile = path.join(directory, "memory-state.json")
const fixture = optimizerFixture()
const program = Effect.gen(function* () {
  const service = yield* Research.Service
  if (process.argv[2] === "first") {
    fixture.calls.proposeOptimizationMemory = true
    const { task } = yield* createDualLoopFixture(directory)
    const original = ExperienceLibrary.prototype.save
    ExperienceLibrary.prototype.save = function (memory, source) {
      const result = original.call(this, memory, source)
      if (source.writeKey) {
        writeFileSync(
          stateFile,
          JSON.stringify({ taskID: task.id, memoryID: result.sourceEntryID, calls: fixture.calls }),
        )
        process.exit(19)
      }
      return result
    }
    yield* service.runAutonomousLoop({
      taskID: task.id,
      maxIterations: 4,
      maxTrialsPerDesign: 1,
      timeBudgetSeconds: 60,
    })
    throw new Error("Expected termination after the shared-library commit")
  }
  const state = JSON.parse(readFileSync(stateFile, "utf8"))
  const before = yield* service.listExperienceWrites(state.taskID)
  const loop = yield* service.runAutonomousLoop({ taskID: state.taskID })
  const saved = readExperiences(state.taskID, { scope: "task" })
  console.log(
    JSON.stringify({
      stoppedReason: loop.stoppedReason,
      firstStatus: before[0]?.status,
      receipts: yield* service.listExperienceWrites(state.taskID),
      memoryIDs: saved.map((memory) => memory.id),
      sameMemory: saved[0]?.id === state.memoryID,
      firstCalls: state.calls,
      resumeCalls: fixture.calls,
    }),
  )
})
try {
  await Effect.runPromise(
    Effect.scoped(provideInstance(directory)(program)).pipe(
      Effect.provide(Layer.mergeAll(Research.defaultLayer, CrossSpawnSpawner.defaultLayer)),
    ),
  )
} finally {
  fixture.restore()
  Database.close()
}
