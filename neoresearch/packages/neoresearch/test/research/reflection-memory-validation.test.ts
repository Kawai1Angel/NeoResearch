import { afterEach, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@neoresearch-ai/core/cross-spawn-spawner"
import { Research } from "../../src/research"
import { TrainingReflectionAnalysis, trainingReflectionKey, architectureReflectionKey } from "../../src/research/agents/scoped-reflection"
import { candidateTrial, designPhaseReceipt } from "../../src/research/design-store"
import { listExperienceWrites } from "../../src/research/experience-outbox"
import type { ExperienceDraft } from "../../src/research/experience"
import { rejectInvalidReflectionDrafts } from "../../src/research/reflection-memory-validation"
import { createDualLoopFixture, optimizerFixture } from "../fixture/dual-loop"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const core = {
  executionAssessment: "The named run succeeded.",
  trainingHealthAssessment: "The supplied curves do not establish convergence.",
  nextTrainingQuestions: ["Which training-only intervention is justified?"],
  limitations: ["Single seed."],
}
const draft: ExperienceDraft = {
  level: "experiment_fact", polarity: "inconclusive", claimType: "observation",
  statement: "The named run provides an observed configuration measurement.",
  conditions: ["Current dataset and seed"], intervention: "Declared training configuration",
  observation: "Use the recorded metric", boundaries: ["Current protocol"], unknowns: ["Transfer"],
  evidence: [{ runID: "run-1", relation: "supports" }],
}

test("invalid optional memory proposals are rejected independently while the core and valid proposals are preserved", () => {
  const invalid = { ...draft, level: "conditional_experience" }
  const result = rejectInvalidReflectionDrafts(TrainingReflectionAnalysis, { ...core, experienceDrafts: [draft, invalid] })
  expect(result.analysis).toEqual({ ...core, experienceDrafts: [draft] })
  expect(result.rejectedDrafts).toHaveLength(1)
  expect(result.rejectedDrafts[0]!.index).toBe(1)
  expect(result.rejectedDrafts[0]!.draftDigest).toHaveLength(64)
  expect(result.rejectedDrafts[0]!.issues[0]!.path).toEqual(["validationPlan"])
})

test("optional memory recovery cannot bypass invalid core diagnosis, scope boundaries or proposal count limits", () => {
  const invalid = { ...draft, level: "conditional_experience" }
  expect(() => rejectInvalidReflectionDrafts(TrainingReflectionAnalysis, {
    ...core, executionAssessment: "", experienceDrafts: [invalid],
  })).toThrow()
  expect(() => rejectInvalidReflectionDrafts(TrainingReflectionAnalysis, {
    ...core, hypothesisAssessment: { status: "supported" }, experienceDrafts: [invalid],
  })).toThrow()
  expect(() => rejectInvalidReflectionDrafts(TrainingReflectionAnalysis, {
    ...core, experienceDrafts: [draft, draft, draft, draft],
  })).toThrow()
})

const it = testEffect(Layer.mergeAll(Research.defaultLayer, CrossSpawnSpawner.defaultLayer))
afterEach(resetDatabase)

it.live(
  "two invalid optional training memory proposals preserve a durable diagnosis and do not enter the outbox or retrain on replay",
  () => provideTmpdirInstance((directory) => Effect.gen(function* () {
    const fixture = optimizerFixture()
    try {
      fixture.calls.invalidOptionalTrainingMemory = true
      const { task } = yield* createDualLoopFixture(directory)
      const service = yield* Research.Service
      const result = yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 2 })
      expect(result.iterations).toHaveLength(2)
      expect(fixture.calls.trainingReflection).toBe(4)
      expect(fixture.inputs.training[1].validationFeedback.error).toContain("validationPlan")
      const trial = candidateTrial(result.iterations[0]!.candidate.id)!
      const reasoning = designPhaseReceipt<any>(trial.design_id, `${trainingReflectionKey(trial.id)}.reasoning`)!
      expect(reasoning.analysis.experienceDrafts).toEqual([])
      expect(reasoning.rejectedExperienceDrafts.responseDigest).toHaveLength(64)
      expect(reasoning.rejectedExperienceDrafts.items).toHaveLength(1)
      expect(listExperienceWrites(task.id)).toEqual([])
      yield* service.runTrainingReflection({ taskID: task.id, designID: trial.design_id, trialID: trial.id })
      expect(fixture.calls.trainingReflection).toBe(4)
      expect((yield* service.listRuns(task.id)).filter((run) => run.stage === "full")).toHaveLength(2)
      expect(listExperienceWrites(task.id)).toEqual([])
    } finally { fixture.restore() }
  })),
  60000,
)

it.live(
  "an invalid optional architecture memory claim cannot block the architecture assessment or create a memory entry",
  () => provideTmpdirInstance((directory) => Effect.gen(function* () {
    const fixture = optimizerFixture()
    try {
      fixture.calls.invalidOptionalArchitectureMemory = true
      const { task } = yield* createDualLoopFixture(directory)
      const service = yield* Research.Service
      const result = yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 1 })
      expect(result.stoppedReason).toBe("max_iterations")
      expect(fixture.calls.reflection).toBe(2)
      const trial = candidateTrial(result.iterations[0]!.candidate.id)!
      const reasoning = designPhaseReceipt<any>(trial.design_id, `${architectureReflectionKey(trial.design_id)}.reasoning`)!
      expect(reasoning.analysis.hypothesisAssessment.status).toBe("inconclusive")
      expect(reasoning.analysis.experienceDrafts).toEqual([])
      expect(reasoning.rejectedExperienceDrafts.items[0].issues[0].path).toEqual(["evolution", "claim"])
      expect(listExperienceWrites(task.id)).toEqual([])
    } finally { fixture.restore() }
  })),
  60000,
)
