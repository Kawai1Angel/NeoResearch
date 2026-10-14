import { Database, and, desc, eq } from "@/storage"
import { Instance } from "@/project/instance"
import { ResearchCandidateTable, ResearchChampionTable, ResearchHypothesisTable, ResearchRunTable, ResearchTaskTable } from "./research.sql"
import type { ResearchTaskID } from "./schema"
import { readDesignHistory } from "./design-history"

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Current attempt and its predeclared comparison; champion is only a fallback observation. */
export function reflectionRunSelection(taskID: ResearchTaskID) {
  const task = Database.use((db) => db.select({ id: ResearchTaskTable.id }).from(ResearchTaskTable)
    .where(and(eq(ResearchTaskTable.id, taskID), eq(ResearchTaskTable.project_id, Instance.project.id))).get())
  if (!task) throw new Error("Reflection context task does not belong to this project")
  const current = Database.use((db) => db.select().from(ResearchRunTable).where(eq(ResearchRunTable.task_id, taskID))
    .orderBy(desc(ResearchRunTable.time_created), desc(ResearchRunTable.id)).get())
  let hypothesis = record(record(current?.resource_usage).hypothesisSnapshot)
  if (!Object.keys(hypothesis).length && current?.candidate_id) {
    const candidate = Database.use((db) => db.select().from(ResearchCandidateTable)
      .where(and(eq(ResearchCandidateTable.id, current.candidate_id!), eq(ResearchCandidateTable.task_id, taskID))).get())
    if (candidate?.hypothesis_id) {
      const row = Database.use((db) => db.select().from(ResearchHypothesisTable)
        .where(and(eq(ResearchHypothesisTable.task_id, taskID), eq(ResearchHypothesisTable.hypo_id, candidate.hypothesis_id!))).get())
      hypothesis = { experimentContract: row?.experiment_contract, literatureEvidence: row?.literature_evidence }
    }
  }
  const named = record(hypothesis.experimentContract).comparisonRunID
  const champion = Database.use((db) => db.select().from(ResearchChampionTable).where(eq(ResearchChampionTable.task_id, taskID)).get())
  const comparisonRunID = typeof named === "string" ? named : champion?.run_id
  const runIDs = [...new Set([current?.id, comparisonRunID].filter((id): id is string => typeof id === "string"))]
  return { currentRunID: current?.id, comparisonRunID, runIDs,
    citations: Array.isArray(hypothesis.literatureEvidence) ? hypothesis.literatureEvidence as { cardID: string; cardRevision: number; role: string }[] : [] }
}

export async function readReflectionHistory(taskID: ResearchTaskID) {
  const selection = reflectionRunSelection(taskID)
  const pages = await Promise.all(selection.runIDs.map((runID) => readDesignHistory(taskID, { runID, limit: 1 }, { forReflection: true })))
  return { primaryMetric: pages[0]?.primaryMetric, currentRunID: selection.currentRunID,
    comparisonRunID: selection.comparisonRunID, runs: pages.flatMap((page) => page.runs), nextOffset: null,
    historyAccess: "Additional exact runs remain available through experiment_results(runID=...,limit=1). The champion fallback is an observation, not a matched causal comparison." }
}
