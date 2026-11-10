import { Database, eq } from "@/storage"
import { ResearchDesignTable, ResearchTrainingTrialTable } from "./research.sql"
import { architectureReflectionKey, trainingReflectionKey } from "./agents/scoped-reflection"
import type { ResearchDesign, TrainingTrial } from "./design-store"

/** Count durable completed work, including a reflected Design awaiting outer planning. */
export function isCompletedDesign(design: ResearchDesign, trials: TrainingTrial[]) {
  return (
    trials.length > 0 &&
    trials.some((trial) => trial.charged && trial.full_run_id) &&
    trials.every(
      (trial) => trial.status === "completed" && Boolean(design.phase_receipts[`${trainingReflectionKey(trial.id)}.result`]),
    ) &&
    Boolean(design.phase_receipts[`${architectureReflectionKey(design.id)}.result`])
  )
}

export function completedDesignCount(cycleID: string) {
  return Database.use((db) => {
    const designs = db.select().from(ResearchDesignTable).where(eq(ResearchDesignTable.cycle_id, cycleID)).all()
    const trials = db
      .select({ trial: ResearchTrainingTrialTable })
      .from(ResearchTrainingTrialTable)
      .innerJoin(ResearchDesignTable, eq(ResearchTrainingTrialTable.design_id, ResearchDesignTable.id))
      .where(eq(ResearchDesignTable.cycle_id, cycleID))
      .all()
      .map((row) => row.trial)
    return designs.filter((design) => isCompletedDesign(design, trials.filter((trial) => trial.design_id === design.id)))
      .length
  })
}
