import { and, eq, Database } from "@/storage"
import { Bus } from "@/bus"
import { SessionTable } from "@/session/session.sql"
import { ResearchHypothesisTable, ResearchTaskTable } from "./research.sql"
import { ResearchHypothesisID, type JsonRecord, type ResearchTaskID } from "./schema"
import { Event } from "./event"
import type { HypothesisObject, HypothesisStatus } from "./agents/hypo-planner-agent"

const VALID_STATUSES: readonly HypothesisStatus[] = [
  "pending",
  "active",
  "testing",
  "confirmed",
  "rejected",
  "abandoned",
]

export class HypothesisNotFoundError extends Error {
  constructor(hypoID: string) {
    super(`Hypothesis ${hypoID} was not found in this task's pool`)
  }
}

type ResearchHypothesisRow = typeof ResearchHypothesisTable.$inferSelect

function mapRow(row: ResearchHypothesisRow): HypothesisObject {
  const status = VALID_STATUSES.includes(row.status as HypothesisStatus) ? (row.status as HypothesisStatus) : "pending"
  return {
    id: row.hypo_id,
    statement: row.statement,
    motivation: Array.isArray(row.motivation) ? (row.motivation as string[]) : [],
    expectedOutcome: row.expected_outcome,
    suggestedBackbones: Array.isArray(row.suggested_backbones) ? (row.suggested_backbones as string[]) : [],
    suggestedPreprocessing: Array.isArray(row.suggested_preprocessing) ? (row.suggested_preprocessing as string[]) : [],
    priority: row.priority === "high" || row.priority === "medium" || row.priority === "low" ? row.priority : "medium",
    risk: row.risk,
    testable: row.testable,
    status,
    ...(row.abandon_reason ? { abandonReason: row.abandon_reason } : {}),
  }
}

function publishChanged(taskID: ResearchTaskID, action: "add" | "update" | "abandon", hypothesis: HypothesisObject) {
  void Bus.publish(Event.HypoPlannerAgentHypothesisChanged, {
    taskID,
    action,
    hypoID: hypothesis.id,
    snapshot: hypothesis as unknown as JsonRecord,
  }).catch(() => undefined)
}

/**
 * Resolves the research taskID that owns a given opencode session. HypoPlanner runs in a
 * fresh child session per turn (see requestViaSession), so the direct research_task.session_id
 * match only covers the root session — falls back to the session's parent.
 */
export async function resolveTaskIDBySessionID(sessionID: string): Promise<ResearchTaskID | undefined> {
  const direct = Database.use((d) =>
    d.select({ id: ResearchTaskTable.id }).from(ResearchTaskTable).where(eq(ResearchTaskTable.session_id, sessionID as any)).get(),
  )
  if (direct) return direct.id

  const session = Database.use((d) =>
    d.select({ parentID: SessionTable.parent_id }).from(SessionTable).where(eq(SessionTable.id, sessionID as any)).get(),
  )
  if (!session?.parentID) return undefined

  const viaParent = Database.use((d) =>
    d
      .select({ id: ResearchTaskTable.id })
      .from(ResearchTaskTable)
      .where(eq(ResearchTaskTable.session_id, session.parentID as any))
      .get(),
  )
  return viaParent?.id
}

export async function listHypothesesInPool(
  taskID: ResearchTaskID,
  opts?: { includeAbandoned?: boolean; status?: readonly HypothesisStatus[] },
): Promise<HypothesisObject[]> {
  const rows = Database.use((d) =>
    d.select().from(ResearchHypothesisTable).where(eq(ResearchHypothesisTable.task_id, taskID)).orderBy(ResearchHypothesisTable.time_created).all(),
  )
  return rows
    .map(mapRow)
    .filter((h) => {
      if (opts?.status && opts.status.length > 0) return opts.status.includes(h.status ?? "pending")
      if (!opts?.includeAbandoned) return h.status !== "abandoned"
      return true
    })
}

export async function addHypothesisToPool(
  taskID: ResearchTaskID,
  hypothesis: Omit<HypothesisObject, "id" | "status" | "abandonReason"> & { id?: string },
): Promise<HypothesisObject> {
  const now = Date.now()
  const id = ResearchHypothesisID.ascending()
  const hypoID = hypothesis.id?.trim() || id
  Database.use((d) =>
    d
      .insert(ResearchHypothesisTable)
      .values({
        id,
        task_id: taskID,
        hypo_id: hypoID,
        statement: hypothesis.statement,
        motivation: [...hypothesis.motivation],
        expected_outcome: hypothesis.expectedOutcome,
        suggested_backbones: [...hypothesis.suggestedBackbones],
        suggested_preprocessing: [...hypothesis.suggestedPreprocessing],
        priority: hypothesis.priority,
        risk: hypothesis.risk,
        testable: hypothesis.testable,
        status: "pending",
        time_created: now,
        time_updated: now,
      })
      .run(),
  )
  const created: HypothesisObject = { ...hypothesis, id: hypoID, status: "pending" }
  publishChanged(taskID, "add", created)
  return created
}

export async function updateHypothesisInPool(
  taskID: ResearchTaskID,
  hypoID: string,
  patch: Partial<Omit<HypothesisObject, "id">>,
): Promise<HypothesisObject> {
  const existingRow = Database.use((d) =>
    d
      .select()
      .from(ResearchHypothesisTable)
      .where(and(eq(ResearchHypothesisTable.task_id, taskID), eq(ResearchHypothesisTable.hypo_id, hypoID)))
      .get(),
  )
  if (!existingRow) throw new HypothesisNotFoundError(hypoID)

  const status = patch.status && VALID_STATUSES.includes(patch.status) ? patch.status : undefined
  Database.use((d) =>
    d
      .update(ResearchHypothesisTable)
      .set({
        ...(patch.statement !== undefined ? { statement: patch.statement } : {}),
        ...(patch.motivation !== undefined ? { motivation: [...patch.motivation] } : {}),
        ...(patch.expectedOutcome !== undefined ? { expected_outcome: patch.expectedOutcome } : {}),
        ...(patch.suggestedBackbones !== undefined ? { suggested_backbones: [...patch.suggestedBackbones] } : {}),
        ...(patch.suggestedPreprocessing !== undefined
          ? { suggested_preprocessing: [...patch.suggestedPreprocessing] }
          : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.risk !== undefined ? { risk: patch.risk } : {}),
        ...(patch.testable !== undefined ? { testable: patch.testable } : {}),
        ...(status !== undefined ? { status } : {}),
        time_updated: Date.now(),
      })
      .where(and(eq(ResearchHypothesisTable.task_id, taskID), eq(ResearchHypothesisTable.hypo_id, hypoID)))
      .run(),
  )
  const updatedRow = Database.use((d) =>
    d
      .select()
      .from(ResearchHypothesisTable)
      .where(and(eq(ResearchHypothesisTable.task_id, taskID), eq(ResearchHypothesisTable.hypo_id, hypoID)))
      .get(),
  )
  const updated = mapRow(updatedRow!)
  publishChanged(taskID, "update", updated)
  return updated
}

export async function abandonHypothesisInPool(
  taskID: ResearchTaskID,
  hypoID: string,
  reason: string,
): Promise<HypothesisObject> {
  const existingRow = Database.use((d) =>
    d
      .select()
      .from(ResearchHypothesisTable)
      .where(and(eq(ResearchHypothesisTable.task_id, taskID), eq(ResearchHypothesisTable.hypo_id, hypoID)))
      .get(),
  )
  if (!existingRow) throw new HypothesisNotFoundError(hypoID)

  const now = Date.now()
  Database.use((d) =>
    d
      .update(ResearchHypothesisTable)
      .set({ status: "abandoned", abandon_reason: reason, abandoned_at: now, time_updated: now })
      .where(and(eq(ResearchHypothesisTable.task_id, taskID), eq(ResearchHypothesisTable.hypo_id, hypoID)))
      .run(),
  )
  const abandoned: HypothesisObject = { ...mapRow(existingRow), status: "abandoned", abandonReason: reason }
  publishChanged(taskID, "abandon", abandoned)
  return abandoned
}
