import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@neoresearch-ai/core/cross-spawn-spawner"
import { Research } from "../../src/research"
import { Instance } from "../../src/project/instance"
import { activeDesign, candidateTrial, currentCycle } from "../../src/research/design-store"
import { completedDesignCount } from "../../src/research/design-budget"
import { loopState } from "../../src/research/recovery"
import { createDualLoopFixture, optimizerFixture } from "../fixture/dual-loop"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Research.defaultLayer, CrossSpawnSpawner.defaultLayer))
afterEach(resetDatabase)

it.live(
  "a Design limit completes the inner loop and both reflections before stopping without another planner call",
  () => provideTmpdirInstance((directory) => Effect.gen(function* () {
    const fixture = optimizerFixture()
    try {
      const { task } = yield* createDualLoopFixture(directory)
      const service = yield* Research.Service
      const result = yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 10, maxDesigns: 1 })
      expect(result.stoppedReason).toBe("max_designs")
      expect(result.iterations).toHaveLength(3)
      expect(fixture.calls).toMatchObject({ optimizer: 2, trainingReflection: 3, reflection: 1, planner: 0 })
      const state = loopState(Instance.project.id, task.id)!
      expect(state.budget).toMatchObject({ designsCompleted: 1, designLimit: 1, trainingUsed: 3, trainingLimit: 10 })
      expect(state.activeDesignID).toBeNull()
      expect(state.phase).toBeNull()
      expect(state.designs[0]!.architectureReflection.status).toBe("completed")
      // A subsequent invocation cannot expand the frozen policy or repeat training/reflection.
      const resumed = yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 100, maxDesigns: 25 })
      expect(resumed.stoppedReason).toBe("max_designs")
      expect(resumed.iterations).toHaveLength(3)
      expect(fixture.calls).toMatchObject({ optimizer: 2, trainingReflection: 3, reflection: 1, planner: 0 })
      expect(completedDesignCount(state.cycleID!)).toBe(1)
    } finally { fixture.restore() }
  })),
  60000,
)

it.live(
  "an interrupted final architecture reflection resumes the same Design and charges its limit once",
  () => provideTmpdirInstance((directory) => Effect.gen(function* () {
    const fixture = optimizerFixture()
    try {
      const { task } = yield* createDualLoopFixture(directory)
      const service = yield* Research.Service
      fixture.calls.interruptArchitectureReflection = true
      const first = yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 10, maxDesigns: 1 }).pipe(Effect.exit)
      expect(first._tag).toBe("Failure")
      const design = activeDesign(task.id)!
      expect(completedDesignCount(design.cycle_id)).toBe(0)
      expect(currentCycle(design.cycle_id).iterations).toBe(3)
      fixture.calls.interruptArchitectureReflection = false
      const resumed = yield* service.runAutonomousLoop({ taskID: task.id, maxDesigns: 25 })
      expect(resumed.stoppedReason).toBe("max_designs")
      expect(resumed.iterations).toHaveLength(3)
      expect(candidateTrial(resumed.iterations[0]!.candidate.id)?.design_id).toBe(design.id)
      expect(currentCycle(design.cycle_id).policy.maxDesigns).toBe(1)
      expect(completedDesignCount(design.cycle_id)).toBe(1)
      expect(fixture.calls).toMatchObject({ trainingReflection: 3, reflection: 1, planner: 0 })
    } finally { fixture.restore() }
  })),
  60000,
)
