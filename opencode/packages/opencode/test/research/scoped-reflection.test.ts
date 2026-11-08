import { afterEach, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Research } from "../../src/research"
import { Database, eq } from "../../src/storage"
import { ResearchDesignTable } from "../../src/research/research.sql"
import {
  activeDesign,
  candidateTrial,
  currentCycle,
  designTrials,
  designPhaseReceipt,
  saveDesignPhaseReceipt,
} from "../../src/research/design-store"
import {
  designDigest,
  optimizedRecipe,
  trainingContract,
  trainingRepairContract,
} from "../../src/research/design-contract"
import { TSFCandidateRecipe, buildTSFBaselines } from "../../src/research/domains/tsf"
import {
  ReflectionMemoryPurpose,
  TrainingReflection,
  TrainingReflectionAnalysis,
  ArchitectureReflection,
  buildTrainingReflection,
  buildDesignSummary,
  buildArchitectureReflection,
  applyArchitectureAnalysis,
  projectScopedReflection,
  trainingReflectionKey,
  architectureReflectionKey,
  DESIGN_SUMMARY_KEY,
  type ReflectionEvidence,
} from "../../src/research/agents/scoped-reflection"
import { createDualLoopFixture, optimizerFixture } from "../fixture/dual-loop"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
import type { DeepMutable } from "../../src/util/schema"
import { resumeState } from "../../src/research/recovery"

const it = testEffect(Layer.mergeAll(Research.defaultLayer, CrossSpawnSpawner.defaultLayer))
afterEach(resetDatabase)

function evidenceFixture(): DeepMutable<ReflectionEvidence> {
  const taskSpec = {
    contextLength: 12,
    predictionLengths: [8],
    dataset: { loaderID: "local_csv", targetCols: ["OT"] },
    evaluation: { protocol: "fixed_split", metricPrimary: "val_avg_mse", seeds: [42] },
  }
  const control = TSFCandidateRecipe.parse(buildTSFBaselines(taskSpec)[0]!.candidateSpec)
  const initial = TSFCandidateRecipe.parse({
    ...control,
    preprocessing: { actions: [{ type: "last_value_centering" }] },
  })
  const strategy = structuredClone(initial.trainingStrategy)
  strategy.optimizer.lr /= 2
  const tuned = optimizedRecipe(initial as Research.JsonRecord, strategy)
  const candidates = [control, initial, tuned].map((recipe, index) => ({
    id: `candidate-${index}`,
    taskID: "task",
    candidateSpec: recipe,
  }))
  const runs = candidates.map((candidate, index) => ({
    id: `run-${index}`,
    taskID: "task",
    candidateID: candidate.id,
    stage: "full",
    status: "succeeded",
    metrics: { val_avg_mse: [0.5, 0.4, 0.2][index] },
    artifactRefs: [],
    resourceUsage: {
      executionContract: { status: "verified", manifest: { actual: { backbone: control.backbone.type } } },
      verification: { status: "passed", eligibleForRanking: true },
      experienceContext: {
        dataset: { specification: taskSpec.dataset },
        evaluation: { ...taskSpec.evaluation, contextLength: 12, predictionLengths: [8] },
      },
    },
    time: { created: index + 1, updated: index + 1 },
  }))
  const contract = {
    mode: "controlled",
    comparisonRunID: "run-0",
    changes: [{ operation: "set", path: "preprocessing", before: control.preprocessing, after: initial.preprocessing }],
    frozenPaths: [],
    requiredValues: [],
    forbiddenMechanisms: [],
  }
  return {
    task: { id: "task", taskSpec, objective: { primaryMetric: "val_avg_mse", direction: "minimize" } },
    design: {
      id: "design",
      task_id: "task",
      cycle_id: "cycle",
      hypothesis_id: "hypothesis",
      recipe: initial,
      design_digest: designDigest(initial as Research.JsonRecord),
      outer_contract: contract,
      no_improve: 0,
      stop_reason: "Inner-loop stopping limit reached",
      phase_receipts: {},
    },
    trials: [1, 2].map((index) => ({
      id: `trial-${index}`,
      design_id: "design",
      trial_index: index - 1,
      candidate_id: `candidate-${index}`,
      full_run_id: `run-${index}`,
      smoke_run_id: null,
      status: "completed",
      repair_run_id: null,
      contract: index === 1 ? null : trainingContract(initial as Research.JsonRecord, tuned, "run-1"),
    })),
    candidates,
    runs,
  } as unknown as DeepMutable<ReflectionEvidence>
}
const architecturalClaim = {
  hypothesisAssessment: { status: "supported", reason: "The matched change improved the observed validation metric." },
  designAssessment: "The best tuned model has a different training configuration from the architecture trial.",
  trainingConfounders: [],
  nextArchitectureQuestions: [],
  limitations: ["One matched comparison is not a universal principle."],
}

test("reflection memory purposes contain only optimization and architecture", () => {
  expect(ReflectionMemoryPurpose.options).toEqual(["optimization", "architecture"])
  expect(ReflectionMemoryPurpose.safeParse("execution").success).toBe(false)
  expect(
    TrainingReflectionAnalysis.safeParse({
      executionAssessment: "OOM observed",
      trainingHealthAssessment: "Unavailable",
      nextTrainingQuestions: [],
      limitations: [],
      hypothesisAssessment: "refuted",
    }).success,
  ).toBe(false)
})

test("best tuned model and the original architecture contrast remain separate", () => {
  const evidence = evidenceFixture()
  const summary = buildDesignSummary(evidence)
  expect(summary.bestModel).toMatchObject({ runID: "run-2", metricValue: 0.2 })
  expect(summary.architectureEvidence).toMatchObject({ status: "eligible", runID: "run-1", comparisonRunID: "run-0" })
  expect(summary.architectureEvidence.delta).toBeCloseTo(-0.1)
  const reflection = applyArchitectureAnalysis(buildArchitectureReflection(summary), architecturalClaim)
  expect(reflection.analysis.hypothesisAssessment.status).toBe("supported")
  const report = projectScopedReflection(evidence, reflection)
  expect(report.analysis.bestRunID).toBe("run-2")
  expect(report.analysis.effectiveChanges[0]!.runID).toBe("run-1")
  expect(report.analysis.effectiveChanges[0]!.delta).toBeCloseTo(-0.1)
})

test("a joint architecture/training intervention cannot become architecture evidence", () => {
  const evidence = evidenceFixture()
  const spec = structuredClone(evidence.candidates[1]!.candidateSpec)
  const strategy = structuredClone(TSFCandidateRecipe.parse(spec).trainingStrategy)
  strategy.optimizer.lr *= 2
  spec.trainingStrategy = strategy
  evidence.candidates[1]!.candidateSpec = spec
  evidence.design.recipe = spec
  evidence.design.outer_contract!.changes.push({
    operation: "set",
    path: "trainingStrategy",
    before: evidence.candidates[0]!.candidateSpec.trainingStrategy as any,
    after: strategy,
  })
  const summary = buildDesignSummary(evidence)
  expect(summary.architectureEvidence.status).toBe("confounded")
  expect(summary.bestModel?.runID).toBe("run-2")
  expect(
    applyArchitectureAnalysis(buildArchitectureReflection(summary), architecturalClaim).analysis.hypothesisAssessment
      .status,
  ).toBe("inconclusive")
})

test("training reflection uses its named training control and keeps fold/horizon series separate", () => {
  const evidence = evidenceFixture()
  const reflection = buildTrainingReflection(evidence, evidence.trials[1]!, [
    { phase: "cv", foldIndex: 1, horizon: 8, epoch: 1, valLoss: 1.0 },
    { phase: "cv", foldIndex: 0, horizon: 8, epoch: 2, valLoss: 0.3 },
    { phase: "standard", horizon: 8, epoch: 1, valLoss: 0.4 },
    { phase: "cv", foldIndex: 0, horizon: 8, epoch: 1, valLoss: 0.5 },
    { phase: "standard", horizon: 16, epoch: 1, valLoss: 0.8 },
  ])
  expect(reflection.evidenceRunIDs).toEqual(["run-2", "run-1"])
  expect(reflection.comparison).toMatchObject({ kind: "controlled_training", eligible: true, runID: "run-1" })
  expect(reflection.comparison.delta).toBeCloseTo(-0.2)
  expect(reflection.trainingStrategy).toEqual(TSFCandidateRecipe.parse(evidence.candidates[2]!.candidateSpec).trainingStrategy)
  expect(reflection.comparison.trainingStrategy).toEqual(TSFCandidateRecipe.parse(evidence.candidates[1]!.candidateSpec).trainingStrategy)
  expect(reflection.trainingContract?.comparisonRunID).toBe("run-1")
  expect(reflection.direction).toBe("minimize")
  expect(reflection.curveSeries).toHaveLength(4)
  expect(reflection.curveSeries.find((series) => series.foldIndex === 0)).toMatchObject({
    firstValLoss: 0.5,
    lastValLoss: 0.3,
    pointCount: 2,
  })
  // Future trials must not invalidate an already completed trial's reflection.
  evidence.trials.push({ ...evidence.trials[1]!, id: "future", trial_index: 2, status: "pending" })
  expect(buildTrainingReflection(evidence, evidence.trials[1]!, []).inputDigest).toBe(
    buildTrainingReflection({ ...evidence, trials: evidence.trials.slice(0, 2) }, evidence.trials[1]!, []).inputDigest,
  )
})

test("failure repair can select a valid model while leaving the architectural hypothesis inconclusive", () => {
  const evidence = evidenceFixture()
  evidence.runs[1]!.status = "failed"
  evidence.runs[1]!.error = "CUDA out of memory"
  evidence.runs[1]!.metrics = {}
  evidence.trials[1]!.contract = trainingRepairContract(
    evidence.candidates[1]!.candidateSpec,
    evidence.candidates[2]!.candidateSpec,
  )
  evidence.trials[1]!.repair_run_id = evidence.runs[1]!.id
  const training = buildTrainingReflection(evidence, evidence.trials[1]!, [])
  expect(training.memoryPurpose).toBe("optimization")
  expect(training.comparison).toMatchObject({ kind: "repair_observation", eligible: false })
  const summary = buildDesignSummary(evidence)
  expect(summary.bestModel?.runID).toBe("run-2")
  expect(summary.architectureEvidence.status).toBe("insufficient_evidence")
  expect(
    applyArchitectureAnalysis(buildArchitectureReflection(summary), architecturalClaim).analysis.hypothesisAssessment
      .status,
  ).toBe("inconclusive")
})

test("duplicates and evaluation-rejected trials cannot become the selected best model", () => {
  for (const kind of ["duplicate", "rejected"]) {
    const evidence = evidenceFixture()
    if (kind === "duplicate") evidence.runs[2]!.resourceUsage.duplicateExperiment = true
    else {
      evidence.runs[2]!.status = "rejected"
      ;(evidence.runs[2]!.resourceUsage.verification as any).eligibleForRanking = false
    }
    const summary = buildDesignSummary(evidence)
    expect(summary.bestModel?.runID).toBe("run-1")
    expect(buildTrainingReflection(evidence, evidence.trials[1]!, []).comparison.eligible).toBe(false)
  }
})

test("changed protocols or actual evaluation seeds disqualify otherwise successful comparisons", () => {
  const seedEvidence = evidenceFixture()
  seedEvidence.runs[1]!.resourceUsage.seed = 7
  expect(buildDesignSummary(seedEvidence).architectureEvidence.status).toBe("confounded")
  expect(buildTrainingReflection(seedEvidence, seedEvidence.trials[1]!, []).comparison.eligible).toBe(false)
  const protocolEvidence = evidenceFixture()
  ;(protocolEvidence.runs[0]!.resourceUsage.experienceContext as any).evaluation.protocol = "different"
  expect(buildDesignSummary(protocolEvidence).architectureEvidence.status).toBe("insufficient_evidence")
})

test("scoped summaries refuse pending trials and cross-task executions", () => {
  const pending = evidenceFixture()
  pending.trials[1]!.status = "pending"
  expect(() => buildDesignSummary(pending)).toThrow("completed persisted execution")
  const foreign = evidenceFixture()
  foreign.runs[2]!.taskID = "other-task" as Research.ResearchTaskID
  expect(() => buildTrainingReflection(foreign, foreign.trials[1]!, [])).toThrow("completed persisted execution")
})

it.live(
  "the dual loop hands scoped training diagnoses to OptimizerAgent and one design assessment to HypoPlanner",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          const { task } = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          const loop = yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 4 })
          expect(fixture.order).toEqual([
            "training",
            "optimizer",
            "training",
            "optimizer",
            "training",
            "architecture",
            "planner",
          ])
          expect(fixture.calls.trainingReflection).toBe(3)
          expect(fixture.calls.reflection).toBe(1)
          const trial = candidateTrial(loop.iterations[0]!.candidate.id)!
          const trials = designTrials(trial.design_id)
          for (let index = 0; index < 2; index++)
            expect(fixture.inputs.optimizer[index]!.trainingReflection.trialID).toBe(trials[index]!.id)
          const scoped = ArchitectureReflection.parse(
            designPhaseReceipt(trial.design_id, `${architectureReflectionKey(trial.design_id)}.result`),
          )
          expect(scoped.designSummary.bestModel?.runID).toBe(loop.iterations[1]!.run.id)
          expect(scoped.analysis.hypothesisAssessment.status).toBe("inconclusive")
          expect(fixture.inputs.architecture[0]!.trainingReflections).toHaveLength(3)
          expect(fixture.inputs.architecture[0]!.hypothesisSnapshot.id).toBe("H-fixed")
          expect(fixture.inputs.training[1]!.facts.trainingStrategy.optimizer.lr).toBe(0.0005)
          expect(fixture.inputs.training[1]!.facts.comparison.trainingStrategy.optimizer.lr).toBe(0.001)
          expect(fixture.inputs.planner[0]!.searchProgress.completedDesign).toEqual(scoped.designSummary)
          expect(fixture.inputs.planner[0]!.searchProgress.architectureReflection).toEqual(scoped.analysis)
          const artifacts = yield* service.listArtifacts(task.id)
          expect(artifacts.filter((artifact) => artifact.kind === "training_reflection_json")).toHaveLength(3)
          expect(artifacts.filter((artifact) => artifact.kind === "architecture_reflection_json")).toHaveLength(1)
          expect(artifacts.filter((artifact) => artifact.kind === "design_summary_json")).toHaveLength(1)
          // Read an earlier trial after later trials were added: reuse its own receipt.
          const replay = yield* service.runReflectionAgent({
            taskID: task.id,
            designID: trial.design_id,
            trialID: trial.id,
            reflectionScope: "training",
          })
          expect(replay.trainingReflection?.trialID).toBe(trial.id)
          expect(replay.analysis.hypothesisTestedRuns).toBe(0)
          expect(replay.experienceWriteResults).toEqual([])
          expect(fixture.calls.trainingReflection).toBe(3)
          const summary = yield* service.getDesignSummary({ taskID: task.id, designID: trial.design_id })
          expect(summary.inputDigest).toBe(scoped.inputDigest)
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "an interrupted training reflection resumes before optimization without retraining the completed trial",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          fixture.calls.interruptTrainingReflection = true
          const { task } = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          expect(
            (yield* service
              .runAutonomousLoop({ taskID: task.id, maxIterations: 4, maxTrialsPerDesign: 1 })
              .pipe(Effect.exit))._tag,
          ).toBe("Failure")
          const design = activeDesign(task.id)!,
            trial = designTrials(design.id)[0]!
          expect(trial.status).toBe("completed")
          expect(resumeState(task.projectID, task.id)?.loopPhase).toBe("training_reflection")
          expect(designPhaseReceipt(design.id, `${trainingReflectionKey(trial.id)}.facts`)).toBeDefined()
          expect(fixture.calls.optimizer + fixture.calls.planner).toBe(0)
          fixture.calls.interruptTrainingReflection = false
          const loop = yield* service.runAutonomousLoop({ taskID: task.id })
          expect(loop.iterations).toHaveLength(1)
          expect(currentCycle(design.cycle_id).iterations).toBe(1)
          expect(fixture.calls.trainingReflection).toBe(1)
          expect(fixture.calls.reflection).toBe(1)
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "scoped reflection ignores another task's newer run and rejects a cross-task design reference",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          const first = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          const run = yield* service.runAutonomousIteration({ taskID: first.task.id })
          const design = activeDesign(first.task.id)!,
            trial = designTrials(design.id)[0]!
          const other = yield* createDualLoopFixture(directory)
          const newer = yield* service.runAutonomousIteration({ taskID: other.task.id })
          const reflection = yield* service.runTrainingReflection({
            taskID: first.task.id,
            designID: design.id,
            trialID: trial.id,
          })
          expect(reflection.evidenceRunIDs).toEqual([run.run.id])
          expect(reflection.evidenceRunIDs).not.toContain(newer.run.id)
          const foreign = yield* service
            .runTrainingReflection({ taskID: other.task.id, designID: design.id, trialID: trial.id })
            .pipe(Effect.exit)
          expect(foreign._tag).toBe("Failure")
          expect(fixture.calls.trainingReflection).toBe(1)
          expect(fixture.inputs.training[0]!.facts.taskID).toBe(first.task.id)
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "a completed scoped reflection refuses silently changed evidence without another model call",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          const { task } = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          const result = yield* service.runAutonomousIteration({ taskID: task.id })
          const design = activeDesign(task.id)!,
            trial = designTrials(design.id)[0]!
          const first = yield* service.runTrainingReflection({
            taskID: task.id,
            designID: design.id,
            trialID: trial.id,
          })
          yield* service.updateRunStatus({ runID: result.run.id, status: "succeeded", metrics: { val_avg_mse: 0.1 } })
          const replay = yield* service
            .runTrainingReflection({ taskID: task.id, designID: design.id, trialID: trial.id })
            .pipe(Effect.exit)
          expect(replay._tag).toBe("Failure")
          expect(fixture.calls.trainingReflection).toBe(1)
          expect(
            TrainingReflection.parse(designPhaseReceipt(design.id, `${trainingReflectionKey(trial.id)}.result`)),
          ).toEqual(first)
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "training output cannot inject architecture verdicts or advance the outer planner",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          fixture.calls.invalidTrainingReflection = true
          const { task } = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          expect(
            (yield* service.runAutonomousLoop({ taskID: task.id, maxTrialsPerDesign: 1 }).pipe(Effect.exit))._tag,
          ).toBe("Failure")
          const design = activeDesign(task.id)!,
            trial = designTrials(design.id)[0]!
          expect(designPhaseReceipt(design.id, `${trainingReflectionKey(trial.id)}.result`)).toBeUndefined()
          expect(fixture.calls.planner + fixture.calls.optimizer + fixture.calls.reflection).toBe(0)
          fixture.calls.invalidTrainingReflection = false
          const loop = yield* service.runAutonomousLoop({ taskID: task.id })
          expect(loop.iterations).toHaveLength(1)
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "the deadline preserves factual training and design records when training reasoning is canceled",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          fixture.calls.hangTrainingReflection = true
          const { task } = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          const loop = yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 4, timeBudgetSeconds: 3 })
          expect(loop.stoppedReason).toBe("time_budget_exhausted")
          expect(fixture.calls.aborted).toBe(true)
          expect(fixture.calls.optimizer + fixture.calls.reflection + fixture.calls.planner).toBe(0)
          const trial = candidateTrial(loop.iterations[0]!.candidate.id)!
          const training = TrainingReflection.parse(
            designPhaseReceipt(trial.design_id, `${trainingReflectionKey(trial.id)}.result`),
          )
          expect(training.analysisStatus).toBe("facts_only")
          expect(training.llm.status).toBe("deadline_exhausted")
          const architecture = ArchitectureReflection.parse(
            designPhaseReceipt(trial.design_id, `${architectureReflectionKey(trial.design_id)}.result`),
          )
          expect(architecture.analysisStatus).toBe("facts_only")
          expect(architecture.analysis.hypothesisAssessment.status).toBe("inconclusive")
          expect(designPhaseReceipt(trial.design_id, DESIGN_SUMMARY_KEY)).toBeDefined()
          const design = Database.use(
            (db) => db.select().from(ResearchDesignTable).where(eq(ResearchDesignTable.id, trial.design_id)).get()!,
          )
          expect(currentCycle(design.cycle_id).iterations).toBe(1)
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)

it.live(
  "legacy task reflection receipts cannot satisfy a new scoped architecture assessment",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const fixture = optimizerFixture()
        try {
          const { task } = yield* createDualLoopFixture(directory)
          const service = yield* Research.Service
          yield* service.runAutonomousIteration({ taskID: task.id })
          const design = activeDesign(task.id)!
          saveDesignPhaseReceipt(design.id, "reflection.result", {
            hypothesisValidation: "unsupported legacy conclusion",
          })
          fixture.calls.forceArchitectureSupport = true
          yield* service.runAutonomousLoop({ taskID: task.id, maxIterations: 4, maxTrialsPerDesign: 1 })
          const scoped = ArchitectureReflection.parse(
            designPhaseReceipt(design.id, `${architectureReflectionKey(design.id)}.result`),
          )
          expect(fixture.calls.reflection).toBe(1)
          expect(scoped.analysis.hypothesisAssessment.status).toBe("inconclusive")
          expect(designPhaseReceipt<Record<string, unknown>>(design.id, "reflection.result")).toEqual({
            hypothesisValidation: "unsupported legacy conclusion",
          })
        } finally {
          fixture.restore()
        }
      }),
    ),
  60000,
)
