import { isDeepStrictEqual } from "node:util"
import { savedLoopControl } from "./loop-control"
import { Database, and, asc, eq } from "@/storage"
import {
  ResearchTaskTable,
  ResearchCycleTable,
  ResearchDesignTable,
  ResearchTrainingTrialTable,
  ResearchRunTable,
  ResearchCandidateTable,
  ResearchArtifactTable,
  ResearchMemoryWriteTable,
} from "./research.sql"
import { trainingReflectionKey, architectureReflectionKey, DESIGN_SUMMARY_KEY } from "./agents/scoped-reflection"
import type { ResearchDesign, TrainingTrial } from "./design-store"
import type { ResearchTaskID } from "./schema"
import type { LoopProgress, LoopDesign } from "./loop-state-schema"

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null)

/** The same persisted phase projection is used by recovery and the cockpit. */
type RunPosition = { id: string; status: string }
export function designLoopPhase(design: ResearchDesign | undefined, trials: TrainingTrial[], runs: RunPosition[] = []) {
  if (!design || !design.active_task) return null
  const pending = trials.find((trial) => trial.status === "pending")
  if (pending) {
    const run = runs.find((run) => run.id === (pending.full_run_id ?? pending.smoke_run_id))
    if (run && !["running", "queued"].includes(run.status) && (pending.full_run_id || run.status !== "succeeded"))
      return "trial_finalization" as const
    return "training" as const
  }
  if (
    trials.some(
      (trial) => trial.status === "completed" && !design.phase_receipts[`${trainingReflectionKey(trial.id)}.result`],
    )
  )
    return "training_reflection" as const
  if (design.status === "optimizing") return "optimization" as const
  if (design.status === "reflecting") return "architecture_reflection" as const
  if (design.status === "planning") return "outer_planning" as const
  return null
}

export function designLoopTrialID(
  design: ResearchDesign | undefined,
  trials: TrainingTrial[],
  runs: RunPosition[] = [],
) {
  const phase = designLoopPhase(design, trials, runs)
  if (phase === "training" || phase === "trial_finalization")
    return trials.find((trial) => trial.status === "pending")?.id ?? null
  if (phase === "training_reflection")
    return (
      trials.find(
        (trial) => trial.status === "completed" && !design!.phase_receipts[`${trainingReflectionKey(trial.id)}.result`],
      )?.id ?? null
    )
  return phase === "optimization" ? (trials.at(-1)?.id ?? null) : null
}

export function loopStopReason(
  cycle: { id: string; policy: Record<string, number | undefined> } | undefined,
  artifacts: Array<{ kind: string; metadata: Record<string, unknown>; time_created: number }>,
) {
  if (!cycle) return null
  const stop = artifacts
    .filter((artifact) => artifact.kind === "research_autonomous_loop_json" && artifact.metadata.cycleID === cycle.id)
    .sort((left, right) => right.time_created - left.time_created)[0]?.metadata
  if (
    stop?.stoppedReason === "max_iterations" &&
    typeof stop.maxIterations === "number" &&
    (cycle.policy.maxIterations ?? 0) > stop.maxIterations
  )
    return null
  return typeof stop?.stoppedReason === "string" ? stop.stoppedReason : null
}

export function taskLoopPhase(
  task: { status: string; task_spec: Record<string, unknown> },
  cycle: { policy: Record<string, number | undefined>; iterations: number; deadline_at: number | null } | undefined,
  design: ResearchDesign | undefined,
  trials: TrainingTrial[],
  runs: RunPosition[] = [],
  stoppedReason: string | null = null,
) {
  const phase = designLoopPhase(design, trials, runs)
  if (phase || !cycle) return phase
  if (
    stoppedReason &&
    [
      "max_iterations",
      "plateau",
      "target_reached",
      "planner_stopped",
      "time_budget_exhausted",
      "crash_streak_exceeded",
      "no_new_candidate",
    ].includes(stoppedReason)
  )
    return null
  if (
    cycle.iterations >= (cycle.policy.maxIterations ?? Infinity) ||
    (cycle.deadline_at !== null && Date.now() >= cycle.deadline_at)
  )
    return null
  const decision = record(record(task.task_spec.metadata).nextExperiment)
  if (decision.action === "stop") return null
  if (["searching", "hypo_planning"].includes(task.status) && decision.action === "experiment") return "design" as const
  return task.status === "hypo_planning" && !decision.action ? ("outer_planning" as const) : null
}

function changes(before: unknown, after: unknown, path = "trainingStrategy"): LoopDesign["trials"][number]["changes"] {
  if (isDeepStrictEqual(before, after)) return []
  const left = record(before),
    right = record(after)
  if (Object.keys(left).length || Object.keys(right).length)
    return [...new Set([...Object.keys(left), ...Object.keys(right)])]
      .sort()
      .flatMap((key) => changes(left[key], right[key], `${path}.${key}`))
  return [{ path, before: before ?? null, after: after ?? null }]
}

/** Read-only: no clocks, reservations, cache migration, or reflection/model calls. */
export function readLoopProgress(projectID: string, taskID: ResearchTaskID): LoopProgress | undefined {
  return Database.transaction((db) => {
    const task = db
      .select()
      .from(ResearchTaskTable)
      .where(
        and(
          eq(ResearchTaskTable.id, taskID),
          eq(ResearchTaskTable.project_id, projectID as typeof ResearchTaskTable.$inferSelect.project_id),
        ),
      )
      .get()
    if (!task) return
    const cycle = db.select().from(ResearchCycleTable).where(eq(ResearchCycleTable.active_task, taskID)).get()
    const designs = cycle
      ? db
          .select()
          .from(ResearchDesignTable)
          .where(eq(ResearchDesignTable.cycle_id, cycle.id))
          .orderBy(asc(ResearchDesignTable.time_created), asc(ResearchDesignTable.id))
          .all()
      : []
    const trials = db
      .select({ trial: ResearchTrainingTrialTable })
      .from(ResearchTrainingTrialTable)
      .innerJoin(ResearchDesignTable, eq(ResearchTrainingTrialTable.design_id, ResearchDesignTable.id))
      .where(eq(ResearchDesignTable.task_id, taskID))
      .orderBy(asc(ResearchTrainingTrialTable.trial_index))
      .all()
      .map((row) => row.trial)
    const runs = db.select().from(ResearchRunTable).where(eq(ResearchRunTable.task_id, taskID)).all()
    const candidates = db.select().from(ResearchCandidateTable).where(eq(ResearchCandidateTable.task_id, taskID)).all()
    const artifacts = db.select().from(ResearchArtifactTable).where(eq(ResearchArtifactTable.task_id, taskID)).all()
    const writes = db.select().from(ResearchMemoryWriteTable).where(eq(ResearchMemoryWriteTable.task_id, taskID)).all()
    const metric = typeof task.objective.primaryMetric === "string" ? task.objective.primaryMetric : "val_avg_mse"
    const direction = task.objective.direction === "maximize" ? ("maximize" as const) : ("minimize" as const)
    const eligible = (run: (typeof runs)[number]) => {
      const usage = run.resource_usage,
        execution = record(usage.executionContract),
        verification = record(usage.verification)
      const trial = trials.find((trial) => trial.full_run_id === run.id)
      const context = record(usage.experienceContext)
      const expected = JSON.parse(
        JSON.stringify({
          ...record(task.task_spec.evaluation),
          contextLength: task.task_spec.contextLength,
          predictionLengths: task.task_spec.predictionLengths,
          split: record(task.task_spec.dataset).split,
        }),
      )
      return (
        context.primaryMetric === metric &&
        context.direction === direction &&
        isDeepStrictEqual(context.evaluation, expected) &&
        isDeepStrictEqual(record(context.dataset).specification, task.task_spec.dataset) &&
        (!trial || trial.status === "completed") &&
        run.stage === "full" &&
        run.status === "succeeded" &&
        finite(run.metrics[metric]) !== null &&
        usage.duplicateExperiment !== true &&
        usage.independentEvidence !== false &&
        execution.status === "verified" &&
        Object.keys(record(record(execution.manifest).actual)).length > 0 &&
        verification.status !== "failed" &&
        verification.eligibleForRanking !== false
      )
    }
    const best = (selected: typeof runs) => {
      const run = selected
        .filter(eligible)
        .reduce<
          (typeof runs)[number] | undefined
        >((best, run) => (!best || (direction === "minimize" ? Number(run.metrics[metric]) < Number(best.metrics[metric]) : Number(run.metrics[metric]) > Number(best.metrics[metric])) ? run : best), undefined)
      return run?.candidate_id
        ? { runID: run.id, candidateID: run.candidate_id, metric, value: Number(run.metrics[metric]) }
        : null
    }
    const reflection = (
      design: ResearchDesign,
      key: string,
      purpose: "optimization" | "architecture",
      trialID?: string,
    ) => {
      const result = record(design.phase_receipts[`${key}.result`]),
        analysis = record(result.analysis)
      const artifact = artifacts.find(
        (item) =>
          item.metadata.designID === design.id &&
          item.kind === (trialID ? "training_reflection_json" : "architecture_reflection_json") &&
          (!trialID || item.metadata.trialID === trialID),
      )
      return {
        status:
          result.analysisStatus === "completed"
            ? ("completed" as const)
            : result.analysisStatus === "facts_only"
              ? ("facts_only" as const)
              : ("pending" as const),
        llmStatus: typeof record(result.llm).status === "string" ? String(record(result.llm).status) : null,
        summary:
          typeof analysis.executionAssessment === "string"
            ? analysis.executionAssessment
            : typeof analysis.designAssessment === "string"
              ? analysis.designAssessment
              : null,
        artifactURI: artifact?.uri ?? null,
        memoryWrites: writes
          .filter((write) => write.binding.reflectionKey === `${key}.result` && write.binding.designID === design.id)
          .map((write) => ({ id: write.id, purpose, status: write.status, error: write.error })),
      }
    }
    const items: LoopDesign[] = designs.map((design, index) => {
      const own = trials.filter((trial) => trial.design_id === design.id)
      const pending = own.find((trial) => trial.status === "pending")
      const waiting = own.find(
        (trial) => trial.status === "completed" && !design.phase_receipts[`${trainingReflectionKey(trial.id)}.result`],
      )
      const summary = record(design.phase_receipts[DESIGN_SUMMARY_KEY])
      return {
        id: design.id,
        index: index + 1,
        hypothesisID: design.hypothesis_id,
        reference: design.reference,
        status: design.status,
        active: design.active_task === taskID,
        fixedDesignDigest: design.design_digest,
        fixedRecipe: design.recipe,
        phase: designLoopPhase(design, own, runs),
        currentTrialID: pending?.id ?? waiting?.id ?? own.at(-1)?.id ?? null,
        noImprove: design.no_improve,
        stopReason: design.stop_reason,
        bestModel: best(runs.filter((run) => own.some((trial) => trial.full_run_id === run.id))),
        architectureEvidence: Object.keys(record(summary.architectureEvidence)).length
          ? record(summary.architectureEvidence)
          : null,
        architectureReflection: reflection(design, architectureReflectionKey(design.id), "architecture"),
        trials: own.map((trial) => {
          const smoke = runs.find((run) => run.id === trial.smoke_run_id),
            full = runs.find((run) => run.id === trial.full_run_id)
          const run = full ?? smoke,
            candidate = candidates.find((item) => item.id === trial.candidate_id)
          const strategy = record(candidate?.candidate_spec.trainingStrategy)
          const source = runs.find((item) => item.id === (trial.contract?.comparisonRunID ?? trial.repair_run_id))
          const control = candidates.find((item) => item.id === source?.candidate_id)
          const runView = (run: (typeof runs)[number] | undefined) =>
            run ? { id: run.id, status: run.status, error: run.error } : null
          return {
            id: trial.id,
            index: trial.trial_index + 1,
            candidateID: trial.candidate_id,
            status: trial.status,
            charged: trial.charged,
            smoke: runView(smoke),
            full: runView(full),
            metricValue: full ? finite(full.metrics[metric]) : null,
            eligibleForRanking: full ? eligible(full) : false,
            duplicate:
              run?.resource_usage.duplicateExperiment === true || run?.resource_usage.independentEvidence === false,
            trainingStrategy: strategy,
            changes: trial.trial_index && control ? changes(control.candidate_spec.trainingStrategy, strategy) : [],
            comparisonRunID: trial.contract?.comparisonRunID ?? null,
            repairRunID: trial.repair_run_id,
            optimizerDecision: trial.optimizer_decision,
            trainingReflection: reflection(design, trainingReflectionKey(trial.id), "optimization", trial.id),
          }
        }),
      }
    })
    const active = items.find((design) => design.active),
      now = Date.now()
    const deadline = cycle?.deadline_at ?? null
    const stoppedReason = active ? null : loopStopReason(cycle, artifacts)
    return {
      taskID,
      observedAt: now,
      stoppedReason,
      control: savedLoopControl(task.task_spec)?.cycleID === cycle?.id ? savedLoopControl(task.task_spec)! : null,
      cycleID: cycle?.id ?? null,
      phase: taskLoopPhase(
        task,
        cycle,
        designs.find((design) => design.active_task === taskID),
        trials.filter((trial) => trial.design_id === active?.id),
        runs,
        stoppedReason,
      ),
      activeDesignID: active?.id ?? null,
      activeTrialID: active
        ? designLoopTrialID(
            designs.find((design) => design.id === active.id),
            trials.filter((trial) => trial.design_id === active.id),
            runs,
          )
        : null,
      primaryMetric: metric,
      direction,
      policy: cycle?.policy ?? null,
      budget: {
        trainingUsed: cycle?.iterations ?? 0,
        trainingLimit: finite(cycle?.policy.maxIterations),
        runRecordsUsed: runs.filter(
          (run) => !["profile", "ref_test", "blind_test"].includes(run.stage) && run.status !== "invalid",
        ).length,
        runRecordsLimit: finite(task.budget.maxRuns),
        elapsedSeconds: (cycle?.elapsed_ms ?? 0) / 1000,
        deadlineAt: deadline,
        remainingSeconds: deadline === null ? null : Math.max(0, (deadline - now) / 1000),
      },
      bestModel: best(runs.filter((run) => cycle && run.resource_usage.cycleID === cycle.id)),
      designs: items,
    }
  })
}
