import { randomUUID } from "node:crypto"
import { Database, eq } from "@/storage"
import { ResearchArtifactTable, ResearchCycleTable, ResearchPhaseExecutionTable } from "./research.sql"
import { cycleDigest } from "./cycle"
import type { ResearchTask } from "./schema"

// Called in the same transaction as the workflow compatibility projection.
// Old workflow-only records remain old records, not invented executions.
export function recordCompletedPhases(task: ResearchTask, phases: readonly string[]) {
  Database.use((db) => {
    const cycle = db.select().from(ResearchCycleTable).where(eq(ResearchCycleTable.active_task, task.id)).get()
    const input = cycleDigest(task)
    const artifacts = db
      .select({ id: ResearchArtifactTable.id })
      .from(ResearchArtifactTable)
      .where(eq(ResearchArtifactTable.task_id, task.id))
      .all()
    const previous = db
      .select()
      .from(ResearchPhaseExecutionTable)
      .where(eq(ResearchPhaseExecutionTable.task_id, task.id))
      .all()
    for (const entry of previous) {
      if (entry.status === "completed" && (!phases.includes(entry.phase) || entry.input_digest !== input))
        db.update(ResearchPhaseExecutionTable)
          .set({ status: "invalidated" })
          .where(eq(ResearchPhaseExecutionTable.id, entry.id))
          .run()
    }
    for (const phase of phases) {
      const step = `${cycle?.id ?? "initial"}:${phase}`
      if (
        previous.some(
          (entry) => entry.step_key === step && entry.input_digest === input && entry.status === "completed",
        )
      )
        continue
      db.insert(ResearchPhaseExecutionTable)
        .values({
          id: randomUUID(),
          task_id: task.id,
          cycle_id: cycle?.id,
          phase,
          step_key: step,
          input_digest: input,
          implementation_version: "research-recovery-v1",
          output_artifact_ids: artifacts.map((artifact) => artifact.id),
          status: "completed",
          time_finished: Date.now(),
        })
        .run()
    }
  })
}
