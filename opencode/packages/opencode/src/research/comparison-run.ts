import { isDeepStrictEqual } from "node:util"
import { Database, and, eq } from "@/storage"
import { ResearchCandidateTable, ResearchRunTable, ResearchTaskTable, ResearchHypothesisTable } from "./research.sql"
import type { ResearchTaskID, ResearchRunID } from "./schema"

/** A comparison is a completed, independent, same-task full run, never a similarly named recipe. */
export function comparisonRecipe(taskID: ResearchTaskID | undefined, runID: string | undefined) {
  if (!taskID || !runID) return undefined
  const run = Database.use((d) =>
    d
      .select()
      .from(ResearchRunTable)
      .where(and(eq(ResearchRunTable.task_id, taskID), eq(ResearchRunTable.id, runID as ResearchRunID)))
      .get(),
  )
  if (
    !run?.candidate_id ||
    run.stage !== "full" ||
    run.status !== "succeeded" ||
    run.resource_usage.independentEvidence === false ||
    run.resource_usage.duplicateExperiment === true
  )
    return undefined
  const execution = run.resource_usage.executionContract as { status?: string; manifest?: { actual?: object } } | undefined
  const verification = run.resource_usage.verification as { status?: string } | undefined
  if (execution?.status !== "verified" || !execution.manifest?.actual || verification?.status === "failed") return undefined
  const task = Database.use((d) => d.select().from(ResearchTaskTable).where(eq(ResearchTaskTable.id, taskID)).get())
  if (!task) return undefined
  const metric = String(task.objective.primaryMetric ?? "val_avg_mse")
  if (typeof run.metrics[metric] !== "number" || !Number.isFinite(run.metrics[metric])) return undefined
  const context = run.resource_usage.experienceContext as
    | { evaluation?: unknown; dataset?: { specification?: unknown } }
    | undefined
  const current = {
    ...((task.task_spec.evaluation as object) ?? {}),
    contextLength: task.task_spec.contextLength,
    predictionLengths: task.task_spec.predictionLengths,
    split: (task.task_spec.dataset as any)?.split,
  }
  if (!context?.evaluation || !isDeepStrictEqual(JSON.parse(JSON.stringify(current)), context.evaluation))
    return undefined
  if (
    !context.dataset?.specification ||
    !isDeepStrictEqual(context.dataset.specification, JSON.parse(JSON.stringify(task.task_spec.dataset)))
  )
    return undefined
  const candidate = Database.use((d) =>
    d
      .select()
      .from(ResearchCandidateTable)
      .where(and(eq(ResearchCandidateTable.task_id, taskID), eq(ResearchCandidateTable.id, run.candidate_id!)))
      .get(),
  )
  return candidate?.candidate_spec
}

export function hypothesisConstraints(taskID: ResearchTaskID, hypothesisID: string | undefined) {
  if (!hypothesisID) return null
  return (
    Database.use((d) =>
      d
        .select({ contract: ResearchHypothesisTable.experiment_contract })
        .from(ResearchHypothesisTable)
        .where(and(eq(ResearchHypothesisTable.task_id, taskID), eq(ResearchHypothesisTable.hypo_id, hypothesisID)))
        .get(),
    )?.contract ?? null
  )
}
