import { statSync } from "node:fs"
import path from "node:path"
import { Instance } from "@/project/instance"
import { randomUUID } from "node:crypto"
import { Database, eq, sql } from "@/storage"
import { ResearchCycleTable } from "./research.sql"
import { digest } from "./execution-contract"
import type { ResearchTask, ResearchRun } from "./schema"

export function cycleDigest(task: ResearchTask) {
  // Workflow summaries, intent answers and hypothesis metadata are outputs, not
  // part of the data/evaluation protocol identity.
  const { metadata, ...spec } = task.taskSpec
  const dataset = spec.dataset as { path?: string } | undefined
  let file: { path: string; size?: number; modified?: number; missing?: boolean } | undefined
  if (typeof dataset?.path === "string") {
    let root = process.cwd()
    try {
      root = Instance.directory
    } catch {}
    const filename = path.resolve(root, dataset.path)
    try {
      const stat = statSync(filename)
      file = { path: filename, size: stat.size, modified: stat.mtimeMs }
    } catch {
      file = { path: filename, missing: true }
    }
  }
  return digest({ spec, file, objective: task.objective })
}

export function searchCycle(task: ResearchTask, runs: ResearchRun[], policy: Record<string, number | undefined>) {
  return Database.transaction((db) => {
    const existing = db.select().from(ResearchCycleTable).where(eq(ResearchCycleTable.active_task, task.id)).get()
    if (existing) {
      if (existing.input_digest !== cycleDigest(task))
        throw new Error("Research cycle data or protocol changed; create an explicit new cycle before continuing")
      return existing
    }
    // Legacy history consumes budget. Never restore an old search with a fresh
    // maxIterations/time budget merely because the UI reopened.
    const trials = runs.filter((run) => run.stage === "full")
    if (
      policy.timeBudgetSeconds !== undefined &&
      trials.some((run) => run.timeStarted === undefined || run.timeFinished === undefined)
    ) {
      throw new Error("Historical execution time is unknown; reconcile the previous search budget before continuing")
    }
    return db
      .insert(ResearchCycleTable)
      .values({
        id: randomUUID(),
        task_id: task.id,
        active_task: task.id,
        policy,
        input_digest: cycleDigest(task),
        iterations: trials.length,
        elapsed_ms: trials.reduce(
          (total, run) => total + Math.max(0, (run.timeFinished ?? 0) - (run.timeStarted ?? 0)),
          0,
        ),
      })
      .returning()
      .get()!
  })
}

export function chargeIteration(id: string) {
  Database.use((db) =>
    db
      .update(ResearchCycleTable)
      .set({ iterations: sql`${ResearchCycleTable.iterations} + 1` })
      .where(eq(ResearchCycleTable.id, id))
      .run(),
  )
}
export function saveCrashStreak(id: string, crash_streak: number) {
  Database.use((db) => db.update(ResearchCycleTable).set({ crash_streak }).where(eq(ResearchCycleTable.id, id)).run())
}
export function cycleClock(id: string) {
  let previous = Date.now()
  const tick = () => {
    const now = Date.now()
    Database.use((db) =>
      db
        .update(ResearchCycleTable)
        .set({ elapsed_ms: sql`${ResearchCycleTable.elapsed_ms} + ${Math.max(0, now - previous)}` })
        .where(eq(ResearchCycleTable.id, id))
        .run(),
    )
    previous = now
  }
  const timer = setInterval(tick, 1000)
  timer.unref()
  return () => {
    clearInterval(timer)
    tick()
  }
}

export function extendSearchCycle(taskID: string, maxIterations: number) {
  Database.transaction((db) => {
    const cycle = db.select().from(ResearchCycleTable).where(eq(ResearchCycleTable.active_task, taskID)).get()
    if (!cycle || (cycle.policy.maxIterations ?? 0) >= maxIterations) return
    db.update(ResearchCycleTable)
      .set({ policy: { ...cycle.policy, maxIterations } })
      .where(eq(ResearchCycleTable.id, cycle.id))
      .run()
  })
}
