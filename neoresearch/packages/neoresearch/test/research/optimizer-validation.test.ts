import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@neoresearch-ai/core/cross-spawn-spawner"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Research } from "../../src/research"
import { activeDesign, candidateTrial, currentCycle, designTrials } from "../../src/research/design-store"
import { createDualLoopFixture, optimizerFixture } from "../fixture/dual-loop"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Research.defaultLayer, CrossSpawnSpawner.defaultLayer))
afterEach(resetDatabase)

it.live(
  "invalid optimizer warmup receives validation feedback before any Trial or budget reservation",
  () => provideTmpdirInstance((directory) => Effect.gen(function* () {
    const fixture = optimizerFixture()
    try {
      fixture.calls.invalidWarmupResponses = 1
      const { task } = yield* createDualLoopFixture(directory)
      const service = yield* Research.Service
      const result = yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 2 })
      expect(result.stoppedReason).toBe("max_iterations")
      expect(result.iterations).toHaveLength(2)
      expect(fixture.calls.optimizer).toBe(2)
      expect(fixture.inputs.optimizer[0].validationFeedback).toBeUndefined()
      expect(fixture.inputs.optimizer[1].validationFeedback.error).toContain("warmupSteps must be less than")
      expect(JSON.parse(fixture.inputs.optimizer[1].validationFeedback.previousResponse).trainingStrategy.scheduler.warmupSteps)
        .toBe(fixture.inputs.optimizer[0].recipe.trainingStrategy.budget.maxEpochs)
      const calls = (yield* Effect.promise(() => readFile(path.join(directory, "training-calls.jsonl"), "utf8")))
        .trim().split("\n").map((line) => JSON.parse(line))
      expect(calls.filter((call) => call.stage === "full").map((call) => call.lr)).toEqual([0.001, 0.0001])
      const trial = candidateTrial(result.iterations[0]!.candidate.id)!
      expect(designTrials(trial.design_id)).toHaveLength(2)
    } finally { fixture.restore() }
  })),
  60000,
)

it.live(
  "two invalid optimizer proposals stop with no saved decision, and resume reuses the completed full run",
  () => provideTmpdirInstance((directory) => Effect.gen(function* () {
    const fixture = optimizerFixture()
    try {
      fixture.calls.invalidWarmupResponses = 2
      const { task } = yield* createDualLoopFixture(directory)
      const service = yield* Research.Service
      const failed = yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 2 }).pipe(Effect.exit)
      expect(failed._tag).toBe("Failure")
      expect(fixture.calls.optimizer).toBe(2)
      const design = activeDesign(task.id)!
      const trials = designTrials(design.id)
      expect(trials).toHaveLength(1)
      expect(trials[0]!.optimizer_decision).toBeNull()
      expect(currentCycle(design.cycle_id).iterations).toBe(1)
      const runID = trials[0]!.full_run_id!
      const resumed = yield* service.runAutonomousLoop({ taskID: task.id })
      expect(resumed.stoppedReason).toBe("max_iterations")
      expect(resumed.iterations).toHaveLength(2)
      expect(resumed.iterations[0]!.run.id).toBe(runID)
      expect(fixture.calls.optimizer).toBe(3)
      expect(currentCycle(design.cycle_id).iterations).toBe(2)
    } finally { fixture.restore() }
  })),
  60000,
)

it.live(
  "an optimizer validation retry remains inside the original shared deadline",
  () => provideTmpdirInstance((directory) => Effect.gen(function* () {
    const fixture = optimizerFixture()
    try {
      fixture.calls.invalidWarmupResponses = 1
      fixture.calls.hangOptimizerRepair = true
      const { task } = yield* createDualLoopFixture(directory)
      const service = yield* Research.Service
      const result = yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 2, timeBudgetSeconds: 5 })
      expect(result.stoppedReason).toBe("time_budget_exhausted")
      expect(result.iterations).toHaveLength(1)
      expect(fixture.calls.optimizer).toBe(2)
      expect(fixture.calls.aborted).toBe(true)
      const trial = candidateTrial(result.iterations[0]!.candidate.id)!
      expect(designTrials(trial.design_id)).toHaveLength(1)
      expect(designTrials(trial.design_id)[0]!.optimizer_decision).toBeNull()
      expect(currentCycle(String(result.iterations[0]!.run.resourceUsage.cycleID)).iterations).toBe(1)
    } finally { fixture.restore() }
  })),
  60000,
)
