import { NamedError } from "@opencode-ai/core/util/error"
import z from "zod"
import { Database, and, eq } from "@/storage"
import { ResearchCycleTable, ResearchDesignTable, ResearchRunTable, ResearchTaskTable } from "./research.sql"
import { activeDesign, cycleTrialResults, designTrials } from "./design-store"
import { ResearchOperations } from "./operation"
import { NAS_DEFAULT_MAX_ITERATIONS, NAS_DEFAULT_MAX_NO_IMPROVE, RESEARCH_MAX_RUNS_SAFETY_LIMIT } from "./defaults"
import {
  SavedLoopControlSchema,
  type LoopControlAction,
  type SavedLoopControl,
  type LoopConfigurationState,
  type UpdateLoopConfigurationSchema,
} from "./loop-control-schema"
import type { ResearchTaskID, JsonRecord } from "./schema"

export const LoopControlError = NamedError.create("ResearchLoopControlError", z.object({ message: z.string() }))
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
export function savedLoopControl(taskSpec: Record<string, unknown>) {
  const parsed = SavedLoopControlSchema.safeParse(record(taskSpec.metadata).loopControl)
  return parsed.success ? parsed.data : undefined
}

export function loopConfiguration(projectID: string, taskID: ResearchTaskID): LoopConfigurationState | undefined {
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
    const budget = record(task.budget)
    const policy = { ...record(budget.loop ?? budget.researchLoop ?? budget.autonomousLoop), ...cycle?.policy }
    const value = (key: string, fallback: number) =>
      typeof policy[key] === "number" ? (policy[key] as number) : fallback
    const optional = (key: string) => (typeof policy[key] === "number" ? (policy[key] as number) : null)
    const active = ResearchOperations.active(projectID, taskID)
    const trained =
      cycle?.policy.dualLoopVersion === 1 ||
      (cycle?.iterations ?? 0) > 0 ||
      Boolean(db.select().from(ResearchDesignTable).where(eq(ResearchDesignTable.active_task, taskID)).get()) ||
      (!cycle &&
        Boolean(
          db
            .select()
            .from(ResearchRunTable)
            .where(and(eq(ResearchRunTable.task_id, taskID), eq(ResearchRunTable.stage, "full")))
            .get(),
        ))
    const lockReason =
      task.domain_id !== "tsf" || task.mode !== "autonomous"
        ? "Dual-loop controls require an autonomous TSF task."
        : active
          ? "An operation is active. Wait for it to finish or use Abort."
          : trained
            ? "This cycle's policy is fixed. Use /append to start an explicitly budgeted new cycle."
            : null
    return {
      taskID,
      revision: task.state_revision,
      cycleID: cycle?.id ?? null,
      locked: lockReason !== null,
      lockReason,
      configuration: {
        maxIterations: value("maxIterations", NAS_DEFAULT_MAX_ITERATIONS),
        maxTrialsPerDesign: value("maxTrialsPerDesign", 3),
        maxNoImprovePerDesign: value("maxNoImprovePerDesign", 2),
        maxNoImprove: value("maxNoImprove", value("maxNoImproveRounds", NAS_DEFAULT_MAX_NO_IMPROVE)),
        maxCrashStreak: value("maxCrashStreak", 3),
        maxRuns:
          typeof budget.maxRuns === "number"
            ? Math.min(RESEARCH_MAX_RUNS_SAFETY_LIMIT, Math.max(0, budget.maxRuns))
            : RESEARCH_MAX_RUNS_SAFETY_LIMIT,
        timeBudgetSeconds: optional("timeBudgetSeconds") ?? optional("timeBudgetS"),
        targetMetricValue: optional("targetMetricValue") ?? optional("target"),
        minRelativeImprovement: value("minRelativeImprovement", 0),
      },
    }
  })
}

export function updateLoopConfiguration(
  projectID: string,
  taskID: ResearchTaskID,
  input: z.infer<typeof UpdateLoopConfigurationSchema>,
) {
  return Database.transaction(
    (db) => {
      const state = loopConfiguration(projectID, taskID)
      if (!state) return { status: 404 as const, body: { message: "Research task not found" } }
      if (state.revision !== input.expectedRevision || state.locked)
        return {
          status: 409 as const,
          body: { message: state.lockReason ?? "Research state changed. Refresh configuration.", state },
        }
      const task = db.select().from(ResearchTaskTable).where(eq(ResearchTaskTable.id, taskID)).get()!
      const { maxRuns, timeBudgetSeconds, targetMetricValue, ...limits } = input.configuration
      const previous = record(task.budget.loop ?? task.budget.researchLoop ?? task.budget.autonomousLoop)
      const policy = JSON.parse(
        JSON.stringify({
          ...previous,
          ...limits,
          timeBudgetSeconds: timeBudgetSeconds ?? undefined,
          targetMetricValue: targetMetricValue ?? undefined,
        }),
      ) as Record<string, JsonRecord[string]>
      // Remove legacy aliases too, otherwise clearing a value can resurrect it.
      for (const key of ["timeBudgetS", "target", "maxNoImproveRounds"]) delete policy[key]
      db.update(ResearchTaskTable)
        .set({ budget: { ...task.budget, maxRuns, loop: policy }, time_updated: Date.now() })
        .where(eq(ResearchTaskTable.id, taskID))
        .run()
      if (state.cycleID)
        db.update(ResearchCycleTable)
          .set({
            policy: Object.fromEntries(
              Object.entries(policy).filter(([, value]) => typeof value === "number"),
            ) as Record<string, number>,
          })
          .where(eq(ResearchCycleTable.id, state.cycleID))
          .run()
      return { status: 200 as const, body: loopConfiguration(projectID, taskID)! }
    },
    { behavior: "immediate" },
  )
}

function writeControl(taskID: ResearchTaskID, control: SavedLoopControl) {
  Database.transaction((db) => {
    const task = db.select().from(ResearchTaskTable).where(eq(ResearchTaskTable.id, taskID)).get()!
    db.update(ResearchTaskTable)
      .set({
        task_spec: { ...task.task_spec, metadata: { ...record(task.task_spec.metadata), loopControl: control } },
        time_updated: Date.now(),
      })
      .where(eq(ResearchTaskTable.id, taskID))
      .run()
  })
  return control
}

export function beginLoopControl(
  taskID: ResearchTaskID,
  cycleID: string,
  action?: LoopControlAction,
  expectedDesignID?: string | null,
) {
  const task = Database.use((db) => db.select().from(ResearchTaskTable).where(eq(ResearchTaskTable.id, taskID)).get()!)
  const design = activeDesign(taskID)
  if (action && expectedDesignID !== undefined && expectedDesignID !== (design?.id ?? null))
    throw new LoopControlError({ message: "The selected design changed. Refresh loop state." })
  const previous = savedLoopControl(task.task_spec)
  if (previous?.status === "active" && previous.cycleID === cycleID) {
    if (action && action !== previous.action)
      throw new LoopControlError({ message: "Resume the saved loop control before starting a different action." })
    return previous
  }
  if (!action) return
  if (action === "design" && !design)
    throw new LoopControlError({ message: "Start a Trial to create a fixed Design first." })
  if (action === "finish-design" && (!design || designTrials(design.id).some((trial) => trial.status !== "completed")))
    throw new LoopControlError({ message: "Finish or recover the current Trial before ending this Design." })
  return writeControl(taskID, {
    action,
    cycleID,
    designID: design?.id ?? null,
    completedTrialsBefore: cycleTrialResults(cycleID).length,
    status: "active",
  })
}

export function bindLoopControl(taskID: ResearchTaskID, control: SavedLoopControl, designID: string) {
  if (control.designID && control.designID !== designID)
    throw new LoopControlError({ message: "Loop control cannot switch to a different fixed design." })
  return control.designID ? control : writeControl(taskID, { ...control, designID })
}
export function endLoopControl(
  taskID: ResearchTaskID,
  control: SavedLoopControl | undefined,
  status: "paused" | "stopped",
) {
  if (control) writeControl(taskID, { ...control, status })
}
