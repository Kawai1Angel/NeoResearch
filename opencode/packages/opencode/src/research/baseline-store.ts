import { and, eq, Database } from "@/storage"
import { Bus } from "@/bus"
import { ResearchTaskTable } from "./research.sql"
import { mapTask } from "./task-mapper"
import { Event } from "./event"
import { referenceBaselineOptions } from "./agents/hypo-planner-agent"
import { DomainRegistry } from "./domain-registry"
import type { JsonRecord, ResearchTaskID } from "./schema"

// Standalone module (no service.ts dependency) — same rationale as task-mapper.ts /
// taskspec-store.ts: service.ts calls into this module, so importing service.ts back
// here would create a cycle.
export { resolveTaskIDBySessionID } from "./hypothesis-store"

export class TaskNotFoundError extends Error {
  constructor(taskID: string) {
    super(`Research task ${taskID} was not found`)
  }
}

export class InvalidBaselineError extends Error {
  constructor(recipeID: string, options: readonly string[]) {
    super(`"${recipeID}" is not a valid baseline for this task. Valid options: ${options.join(", ")}`)
  }
}

export class BaselineAlreadyPickedError extends Error {
  constructor(existingRecipeID: string) {
    super(
      `This task's reference baseline was already picked: "${existingRecipeID}". pick_baseline may only be called once per task — do not call it again.`,
    )
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

/**
 * Records the baseline the HypoPlanner agent picked (via the pick_baseline tool) as this
 * task's reference baseline. Later baseline seeding only considers this recipe — see
 * seedBaselines() in service.ts.
 */
export async function pickReferenceBaseline(
  taskID: ResearchTaskID,
  recipeID: string,
  rationale?: string,
  source: "tool" | "llm" = "tool",
): Promise<{ readonly referenceBaseline: string }> {
  const row = Database.use((d) => d.select().from(ResearchTaskTable).where(eq(ResearchTaskTable.id, taskID)).get())
  if (!row) throw new TaskNotFoundError(taskID)
  const task = mapTask(row)
  const options = referenceBaselineOptions(task)
  if (!options.includes(recipeID)) throw new InvalidBaselineError(recipeID, options)

  const metadata = recordValue(task.taskSpec.metadata)
  if (typeof metadata.referenceBaseline === "string") {
    throw new BaselineAlreadyPickedError(metadata.referenceBaseline)
  }
  const nextTaskSpec: JsonRecord = {
    ...task.taskSpec,
    metadata: {
      ...metadata,
      referenceBaseline: recipeID,
      referenceBaselineSource: source,
      ...(rationale ? { referenceBaselineRationale: rationale } : {}),
    } as unknown as JsonRecord,
  }
  const updatedRow = Database.use((d) =>
    d
      .update(ResearchTaskTable)
      .set({ task_spec: nextTaskSpec, time_updated: Date.now() })
      .where(and(eq(ResearchTaskTable.id, taskID), eq(ResearchTaskTable.project_id, task.projectID)))
      .returning()
      .get(),
  )
  if (!updatedRow) throw new TaskNotFoundError(taskID)
  void Bus.publish(Event.TaskUpdated, { task: mapTask(updatedRow) }).catch(() => undefined)
  return { referenceBaseline: recipeID }
}

export type BaselineOption = { readonly recipeID: string; readonly description: string }

function candidateRecipeID(candidateSpec: unknown): string | undefined {
  if (!candidateSpec || typeof candidateSpec !== "object" || Array.isArray(candidateSpec)) return undefined
  const value = (candidateSpec as Record<string, unknown>).recipeID
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Reads the candidate baseline recipes for a task (recipeID + rationale) plus which one, if
 * any, was already picked via pick_baseline — unlike the one-time `baselineOptions` input
 * section (only injected on HypoPlanner's first call), this is available on every call so the
 * agent can re-check the options or confirm what was picked.
 */
export async function loadBaselineOptions(taskID: ResearchTaskID): Promise<{
  readonly options: readonly BaselineOption[]
  readonly picked?: string
  readonly pickedSource?: "tool" | "llm" | "heuristic"
}> {
  const row = Database.use((d) => d.select().from(ResearchTaskTable).where(eq(ResearchTaskTable.id, taskID)).get())
  if (!row) throw new TaskNotFoundError(taskID)
  const task = mapTask(row)
  const validRecipeIDs = new Set(referenceBaselineOptions(task))
  const options = DomainRegistry.buildBaselines(task.domainID, task.taskSpec)
    .map((proposal) => {
      const recipeID = candidateRecipeID(proposal.candidateSpec)
      return recipeID && validRecipeIDs.has(recipeID) ? { recipeID, description: proposal.rationale } : undefined
    })
    .filter((option): option is BaselineOption => option !== undefined)

  const metadata = recordValue(task.taskSpec.metadata)
  const picked = typeof metadata.referenceBaseline === "string" ? metadata.referenceBaseline : undefined
  const pickedSource = metadata.referenceBaselineSource === "tool" || metadata.referenceBaselineSource === "llm" || metadata.referenceBaselineSource === "heuristic"
    ? metadata.referenceBaselineSource
    : undefined
  return { options, ...(picked ? { picked, pickedSource } : {}) }
}
