import { randomUUID } from "node:crypto"
import { Database, and, asc, eq, sql } from "@/storage"
import {
  ResearchCycleTable,
  ResearchDesignTable,
  ResearchTrainingTrialTable,
  ResearchRunTable,
  ResearchCandidateTable,
} from "./research.sql"
import {
  designDigest,
  checkTrainingTrial,
  trainingContract,
  optimizedRecipe,
  type TrainingStrategy,
} from "./design-contract"
import { digest } from "./digest"
import type { HypothesisObject } from "./agents/hypo-planner-agent"
import type {
  JsonRecord,
  ResearchCandidate,
  ResearchCandidateID,
  ResearchRun,
  ResearchRunID,
  ResearchTaskID,
} from "./schema"
import { ResearchCandidateID as CandidateID } from "./schema"

export type ResearchDesign = typeof ResearchDesignTable.$inferSelect
export type TrainingTrial = typeof ResearchTrainingTrialTable.$inferSelect

export function activeDesign(taskID: ResearchTaskID) {
  return Database.use((db) =>
    db.select().from(ResearchDesignTable).where(eq(ResearchDesignTable.active_task, taskID)).get(),
  )
}

export function designTrials(designID: string) {
  return Database.use((db) =>
    db
      .select()
      .from(ResearchTrainingTrialTable)
      .where(eq(ResearchTrainingTrialTable.design_id, designID))
      .orderBy(asc(ResearchTrainingTrialTable.trial_index))
      .all(),
  )
}

export function cycleTrialResults(cycleID: string) {
  return Database.use((db) =>
    db
      .select({ result: ResearchTrainingTrialTable.result })
      .from(ResearchTrainingTrialTable)
      .innerJoin(ResearchDesignTable, eq(ResearchTrainingTrialTable.design_id, ResearchDesignTable.id))
      .where(eq(ResearchDesignTable.cycle_id, cycleID))
      .orderBy(asc(ResearchDesignTable.time_created), asc(ResearchTrainingTrialTable.trial_index))
      .all(),
  ).flatMap((row) => (row.result ? [row.result] : []))
}

export function candidateTrial(candidateID: ResearchCandidateID) {
  return Database.use((db) =>
    db.select().from(ResearchTrainingTrialTable).where(eq(ResearchTrainingTrialTable.candidate_id, candidateID)).get(),
  )
}

export function trialDesign(trial: TrainingTrial) {
  const design = Database.use((db) =>
    db.select().from(ResearchDesignTable).where(eq(ResearchDesignTable.id, trial.design_id)).get(),
  )
  if (!design) throw new Error("Training trial has no design")
  return design
}

export function startDesign(cycleID: string, candidate: ResearchCandidate, hypothesis?: HypothesisObject) {
  return Database.transaction(
    (db) => {
      const existing = candidateTrial(candidate.id)
      if (existing) return existing
      if (activeDesign(candidate.taskID))
        throw new Error("Finish or resume the active design before proposing another architecture")
      const cycle = db.select().from(ResearchCycleTable).where(eq(ResearchCycleTable.id, cycleID)).get()
      if (!cycle || cycle.active_task !== candidate.taskID)
        throw new Error("Design must belong to the active research cycle")
      const time = Date.now()
      const design = db
        .insert(ResearchDesignTable)
        .values({
          id: randomUUID(),
          task_id: candidate.taskID,
          active_task: candidate.taskID,
          cycle_id: cycleID,
          hypothesis_id: candidate.hypothesisID,
          design_digest: designDigest(candidate.candidateSpec),
          recipe: candidate.candidateSpec,
          outer_contract: hypothesis?.experimentContract,
          reference: hypothesis?.experimentContract?.mode === "baseline",
          time_created: time,
          time_updated: time,
        })
        .returning()
        .get()!
      return db
        .insert(ResearchTrainingTrialTable)
        .values({
          id: randomUUID(),
          design_id: design.id,
          trial_index: 0,
          candidate_id: candidate.id,
          time_created: time,
          time_updated: time,
        })
        .returning()
        .get()!
    },
    { behavior: "immediate" },
  )
}

/** Immutable trial contract is resolved by candidate ID in both immediate and queued execution. */
export function resolveTrialContract(candidate: ResearchCandidate) {
  const trial = candidateTrial(candidate.id)
  if (!trial) return undefined
  const design = trialDesign(trial)
  if (design.task_id !== candidate.taskID || design.hypothesis_id !== (candidate.hypothesisID ?? null))
    throw new Error("Training trial task/hypothesis identity changed")
  if (design.design_digest !== designDigest(candidate.candidateSpec))
    throw new Error("Training trial fixed design changed")
  if (trial.trial_index === 0 && digest(design.recipe) !== digest(candidate.candidateSpec))
    throw new Error("Initial design recipe changed after it was persisted")
  return { trial, design, contract: trial.contract ?? design.outer_contract }
}

export function trialConstraintIssues(candidate: ResearchCandidate, comparison?: JsonRecord) {
  const resolved = resolveTrialContract(candidate)
  if (!resolved?.trial.contract) return undefined
  return checkTrainingTrial({
    design: resolved.design.recipe,
    candidate: candidate.candidateSpec,
    contract: resolved.trial.contract,
    comparison,
  })
}

export function recordTrialRun(candidateID: ResearchCandidateID, runID: ResearchRunID, stage: string) {
  if (stage !== "smoke" && stage !== "full") return
  Database.transaction((db) => {
    const trial = candidateTrial(candidateID)
    if (!trial) return
    const field = stage === "smoke" ? "smoke_run_id" : "full_run_id"
    if (trial[field] && trial[field] !== runID)
      throw new Error("A trial stage already has an execution; reconcile it before retrying")
    db.update(ResearchTrainingTrialTable)
      .set({ [field]: runID, time_updated: Date.now() })
      .where(eq(ResearchTrainingTrialTable.id, trial.id))
      .run()
  })
}

/** A run is charged once before dispatch, including failures. Recovery never resets the charge. */
export function reserveTrialExecution(candidateID: ResearchCandidateID, runID: ResearchRunID) {
  return Database.transaction(
    (db) => {
      const trial = candidateTrial(candidateID)
      if (!trial) return false
      if (trial.full_run_id !== runID) throw new Error("Training execution does not match the persisted trial")
      if (trial.charged) return true
      const design = trialDesign(trial)
      const cycle = db.select().from(ResearchCycleTable).where(eq(ResearchCycleTable.id, design.cycle_id)).get()!
      if (cycle.active_task !== design.task_id) throw new Error("The training trial's cycle is no longer active")
      if (cycle.iterations >= (cycle.policy.maxIterations ?? 25))
        throw new Error("Shared training iteration budget exhausted")
      if (cycle.policy.timeBudgetSeconds !== undefined && cycle.elapsed_ms >= cycle.policy.timeBudgetSeconds * 1000)
        throw new Error("Shared training time budget exhausted")
      db.update(ResearchCycleTable)
        .set({ iterations: sql`${ResearchCycleTable.iterations} + 1` })
        .where(eq(ResearchCycleTable.id, design.cycle_id))
        .run()
      db.update(ResearchTrainingTrialTable)
        .set({ charged: true, time_updated: Date.now() })
        .where(eq(ResearchTrainingTrialTable.id, trial.id))
        .run()
      return true
    },
    { behavior: "immediate" },
  )
}

export function completeTrial(
  candidateID: ResearchCandidateID,
  result: JsonRecord,
  run: ResearchRun,
  metricName: string,
  direction: string,
) {
  Database.transaction(
    (db) => {
      const trial = candidateTrial(candidateID)
      if (!trial || trial.status === "completed") return
      if (run.candidateID !== candidateID || (run.stage === "full" && run.id !== trial.full_run_id))
        throw new Error("Training result does not belong to the persisted trial execution")
      const design = trialDesign(trial)
      const duplicate =
        run.resourceUsage.duplicateExperiment === true || run.resourceUsage.independentEvidence === false
      if (duplicate && trial.charged) {
        db.update(ResearchCycleTable)
          .set({ iterations: sql`${ResearchCycleTable.iterations} - 1` })
          .where(eq(ResearchCycleTable.id, design.cycle_id))
          .run()
      }
      const verification = run.resourceUsage.verification as
        | { eligibleForRanking?: boolean; status?: string }
        | undefined
      const value = run.metrics[metricName]
      const eligible =
        !duplicate &&
        run.stage === "full" &&
        run.status === "succeeded" &&
        verification?.status !== "failed" &&
        (run.resourceUsage.executionContract as { status?: string } | undefined)?.status === "verified" &&
        verification?.eligibleForRanking !== false &&
        typeof value === "number" &&
        Number.isFinite(value)
      const improved =
        eligible &&
        (design.best_metric === null ||
          (direction === "maximize" ? value > design.best_metric : value < design.best_metric))
      db.update(ResearchDesignTable)
        .set({
          ...(improved ? { best_metric: value as number, best_run_id: run.id } : {}),
          no_improve: eligible && !duplicate ? (improved ? 0 : design.no_improve + 1) : design.no_improve,
          time_updated: Date.now(),
        })
        .where(eq(ResearchDesignTable.id, design.id))
        .run()
      db.update(ResearchTrainingTrialTable)
        .set({ status: "completed", result, charged: duplicate ? false : trial.charged, time_updated: Date.now() })
        .where(eq(ResearchTrainingTrialTable.id, trial.id))
        .run()
    },
    { behavior: "immediate" },
  )
}

/** Candidate + trial are committed together, so a restart cannot orphan a tuning proposal. */
export function appendTrainingTrial(
  designID: string,
  previousTrialID: string,
  strategy: TrainingStrategy,
  rationale: string,
  comparisonRunID?: ResearchRunID,
) {
  return Database.transaction(
    (db) => {
      const previous = db
        .select()
        .from(ResearchTrainingTrialTable)
        .where(eq(ResearchTrainingTrialTable.id, previousTrialID))
        .get()
      if (!previous || previous.design_id !== designID || previous.status !== "completed" || !previous.full_run_id)
        throw new Error("OptimizerAgent requires a completed same-design full trial")
      const existing = db
        .select()
        .from(ResearchTrainingTrialTable)
        .where(
          and(
            eq(ResearchTrainingTrialTable.design_id, designID),
            eq(ResearchTrainingTrialTable.trial_index, previous.trial_index + 1),
          ),
        )
        .get()
      if (existing) return existing
      const design = trialDesign(previous)
      if (!design.active_task) throw new Error("Cannot optimize a finished design")
      const comparison = db
        .select()
        .from(ResearchRunTable)
        .where(eq(ResearchRunTable.id, comparisonRunID ?? previous.full_run_id))
        .get()
      if (
        !comparison?.candidate_id ||
        comparison.task_id !== design.task_id ||
        comparison.status !== "succeeded" ||
        comparison.stage !== "full" ||
        comparison.resource_usage.independentEvidence === false ||
        comparison.resource_usage.duplicateExperiment === true ||
        (comparison.resource_usage.executionContract as { status?: string } | undefined)?.status !== "verified" ||
        candidateTrial(comparison.candidate_id)?.design_id !== designID
      )
        throw new Error("Training comparison must be an independently verified full run of this design")
      const base = db
        .select()
        .from(ResearchCandidateTable)
        .where(eq(ResearchCandidateTable.id, comparison.candidate_id))
        .get()!
      const next = optimizedRecipe(base.candidate_spec, strategy)
      const contract = trainingContract(base.candidate_spec, next, comparison.id)
      const time = Date.now()
      const candidateID = CandidateID.ascending()
      db.insert(ResearchCandidateTable)
        .values({
          ...base,
          id: candidateID,
          candidate_spec: next,
          parent_candidate_id: base.id,
          rationale,
          generated_by: "optimizer",
          time_created: time,
          time_updated: time,
        })
        .run()
      return db
        .insert(ResearchTrainingTrialTable)
        .values({
          id: randomUUID(),
          design_id: designID,
          trial_index: previous.trial_index + 1,
          candidate_id: candidateID,
          contract,
          time_created: time,
          time_updated: time,
        })
        .returning()
        .get()!
    },
    { behavior: "immediate" },
  )
}

export function saveOptimizerDecision(trialID: string, decision: JsonRecord) {
  Database.use((db) =>
    db
      .update(ResearchTrainingTrialTable)
      .set({ optimizer_decision: decision, time_updated: Date.now() })
      .where(eq(ResearchTrainingTrialTable.id, trialID))
      .run(),
  )
}

export function finishDesign(designID: string, reason: string) {
  Database.use((db) =>
    db
      .update(ResearchDesignTable)
      .set({ active_task: null, status: "completed", stop_reason: reason, time_updated: Date.now() })
      .where(eq(ResearchDesignTable.id, designID))
      .run(),
  )
}

export function setDesignPhase(designID: string, status: "reflecting" | "planning", reason?: string) {
  Database.use((db) =>
    db
      .update(ResearchDesignTable)
      .set({ status, ...(reason ? { stop_reason: reason } : {}), time_updated: Date.now() })
      .where(eq(ResearchDesignTable.id, designID))
      .run(),
  )
}

export function currentCycle(cycleID: string) {
  return Database.use((db) => db.select().from(ResearchCycleTable).where(eq(ResearchCycleTable.id, cycleID)).get()!)
}

// Before the first full execution, a failed implementation can return to outer design repair.
// The rejected design and smoke evidence remain immutable; a replacement gets a new design ID.
export function abandonUntrainedDesign(design: ResearchDesign) {
  Database.transaction((db) => {
    const trials = designTrials(design.id)
    if (trials.some((trial) => trial.full_run_id || trial.charged || trial.trial_index > 0))
      throw new Error("A trained fixed design cannot be rewritten by implementation recovery")
    db.update(ResearchTrainingTrialTable)
      .set({ status: "abandoned", time_updated: Date.now() })
      .where(eq(ResearchTrainingTrialTable.design_id, design.id))
      .run()
    finishDesign(design.id, "outer_revision_before_training")
  })
}
