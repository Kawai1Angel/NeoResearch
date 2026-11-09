import { executionOwner, ownerExited } from "./owner"
import { Database, and, eq } from "@/storage"
import { ResearchOperationTable, ResearchTaskTable } from "./research.sql"
import { randomUUID } from "node:crypto"

export type ResearchOperation = {
  id: string
  taskID: string
  action: string
  status: "running" | "canceling" | "completed" | "failed" | "canceled" | "interrupted" | "waiting_input"
  startedAt?: number
  recoveryRequired?: boolean
  result?: unknown
  error?: { name: string; message: string; data?: unknown }
}

type Entry = {
  scope: string
  operation: ResearchOperation
  controller: AbortController
  done: Promise<void>
  requestKey?: string
}

// One foreground research operation per task, shared by synchronous and async
// HTTP callers. A disconnect only detaches the client; explicit cancel stops work.
export function createResearchOperations(persistent = false) {
  const owner = executionOwner(randomUUID())
  const entries = new Map<string, Entry>()
  const active = new Map<string, string>()
  const key = (scope: string, taskID: string) => JSON.stringify([scope, taskID])
  const snapshot = (entry: Entry) => ({ ...entry.operation })
  const find = (scope: string, taskID: string, id: string) => {
    const entry = entries.get(id)
    return entry?.scope === scope && entry.operation.taskID === taskID ? entry : undefined
  }
  const receipt = (row: typeof ResearchOperationTable.$inferSelect) => ({
    ...row.receipt,
    ...(row.active_task && row.owner_id !== owner ? { recoveryRequired: true } : {}),
  })
  const stored = (scope: string, taskID: string, id?: string) =>
    persistent
      ? Database.use((db) =>
          db
            .select()
            .from(ResearchOperationTable)
            .where(
              and(
                eq(ResearchOperationTable.project_id, scope),
                eq(ResearchOperationTable.task_id, taskID),
                id ? eq(ResearchOperationTable.id, id) : eq(ResearchOperationTable.active_task, taskID),
              ),
            )
            .get(),
        )
      : undefined
  return {
    reconcile(scope: string, taskID: string, safe: boolean) {
      const row = stored(scope, taskID)
      if (!row || !safe || !ownerExited(row.owner_id)) return false
      return Database.use(
        (db) =>
          db
            .update(ResearchOperationTable)
            .set({
              active_task: null,
              active_workspace: null,
              receipt: {
                ...row.receipt,
                status: "interrupted",
                error: {
                  name: "ResearchInterrupted",
                  message: "Previous execution owner exited; no unconfirmed runner remains",
                },
              },
            })
            .where(and(eq(ResearchOperationTable.id, row.id), eq(ResearchOperationTable.owner_id, row.owner_id)))
            .returning()
            .all().length > 0,
      )
    },
    request(scope: string, taskID: string, requestKey: string) {
      if (!persistent) return undefined
      return Database.use((db) =>
        db
          .select()
          .from(ResearchOperationTable)
          .where(
            and(
              eq(ResearchOperationTable.project_id, scope),
              eq(ResearchOperationTable.task_id, taskID),
              eq(ResearchOperationTable.request_key, requestKey),
            ),
          )
          .get(),
      )
    },
    start(
      scope: string,
      taskID: string,
      action: string,
      run: (signal: AbortSignal) => Promise<unknown>,
      requestKey?: string,
      requestDigest = action,
      expectedRevision?: number,
    ): { started: boolean; resumed?: boolean; conflict?: boolean; operation: ResearchOperation } {
      if (persistent) {
        const previous = requestKey
          ? Database.use((db) =>
              db
                .select()
                .from(ResearchOperationTable)
                .where(
                  and(
                    eq(ResearchOperationTable.project_id, scope),
                    eq(ResearchOperationTable.task_id, taskID),
                    eq(ResearchOperationTable.request_key, requestKey),
                  ),
                )
                .get(),
            )
          : undefined
        if (previous)
          return {
            started: false,
            resumed: previous.request_digest === requestDigest,
            conflict: previous.request_digest !== requestDigest,
            operation: receipt(previous),
          }
        const occupied = stored(scope, taskID)
        if (occupied) return { started: false, operation: receipt(occupied) }
      }
      const previous = requestKey
        ? [...entries.values()].find(
            (entry) => entry.scope === scope && entry.operation.taskID === taskID && entry.requestKey === requestKey,
          )
        : undefined
      if (previous)
        return { started: false, resumed: previous.operation.action === action, operation: snapshot(previous) }
      const existing = active.get(key(scope, taskID))
      if (existing) {
        const entry = entries.get(existing)!
        return {
          started: false,
          resumed: requestKey !== undefined && entry.requestKey === requestKey && entry.operation.action === action,
          operation: snapshot(entry),
        }
      }
      // Keep terminal receipts for reconnects without retaining every result forever.
      for (const [id, entry] of entries) {
        if (entries.size < 256) break
        if (!active.has(key(entry.scope, entry.operation.taskID))) entries.delete(id)
      }
      const controller = new AbortController()
      const operation: ResearchOperation = { id: randomUUID(), taskID, action, status: "running", startedAt: Date.now() }
      const entry: Entry = { scope, operation, controller, requestKey, done: Promise.resolve() }
      const isolated = persistent && Database.use((db) => {
        const task = db.select().from(ResearchTaskTable)
          .where(eq(ResearchTaskTable.id, taskID as typeof ResearchTaskTable.$inferSelect.id)).get()
        return (task?.task_spec.metadata as Record<string, unknown> | undefined)?.executionIsolation === "task"
      })
      if (persistent) {
        const inserted = Database.transaction(
          (db) => {
            if (expectedRevision !== undefined) {
              const task = db
                .select()
                .from(ResearchTaskTable)
                .where(eq(ResearchTaskTable.id, taskID as typeof ResearchTaskTable.$inferSelect.id))
                .get()
              if (task?.state_revision !== expectedRevision) return null
            }
            return db
              .insert(ResearchOperationTable)
              .values({
                id: operation.id,
                project_id: scope,
                task_id: taskID,
                request_key: requestKey,
                request_digest: requestDigest,
                active_task: taskID,
                active_workspace: isolated ? null : scope,
                owner_id: owner,
                heartbeat_at: Date.now(),
                receipt: operation,
              })
              .onConflictDoNothing()
              .returning()
              .get()
          },
          { behavior: "immediate" },
        )
        if (inserted === null)
          return {
            started: false,
            conflict: true,
            operation: {
              ...operation,
              status: "failed",
              error: { name: "ResearchResumeConflict", message: "Research state changed" },
            },
          }
        if (!inserted) {
          const row =
            stored(scope, taskID) ??
            (isolated ? undefined : Database.use((db) =>
              db.select().from(ResearchOperationTable).where(eq(ResearchOperationTable.active_workspace, scope)).get(),
            ))
          if (row) return { started: false, operation: receipt(row) }
          return this.start(scope, taskID, action, run, requestKey, requestDigest, expectedRevision)
        }
      }
      const save = (finished = false) => {
        if (!persistent) return
        Database.use((db) =>
          db
            .update(ResearchOperationTable)
            .set({
              receipt: { ...operation },
              heartbeat_at: Date.now(),
              ...(finished ? { active_task: null, active_workspace: null } : {}),
            })
            .where(and(eq(ResearchOperationTable.id, operation.id), eq(ResearchOperationTable.owner_id, owner)))
            .run(),
        )
      }
      const heartbeat = persistent ? setInterval(() => save(), 10_000) : undefined
      heartbeat?.unref()
      entries.set(operation.id, entry)
      active.set(key(scope, taskID), operation.id)
      // Invoke immediately so the caller's instance context is captured by its runtime.
      try {
        entry.done = run(controller.signal)
          .then(
            (result) => {
              operation.result = result
              operation.status = controller.signal.aborted ? "canceled" : "completed"
            },
            (error) => {
              operation.status = controller.signal.aborted
                ? "canceled"
                : ["human_checkpoint_required", "intent_incomplete", "intent_clarification_required"].includes(error?.data?.reason)
                  ? "waiting_input"
                  : "failed"
              operation.error = {
                name: error?.name ?? "Error",
                message: error?.message ?? String(error),
                ...(error?.data ? { data: error.data } : {}),
              }
            },
          )
          .finally(() => {
            if (heartbeat) clearInterval(heartbeat)
            save(true)
            active.delete(key(scope, taskID))
          })
      } catch (error) {
        if (heartbeat) clearInterval(heartbeat)
        operation.status = "failed"
        operation.error = { name: "Error", message: String(error) }
        save(true)
        active.delete(key(scope, taskID))
        entries.delete(operation.id)
        throw error
      }
      return { started: true, operation: snapshot(entry) }
    },
    get(scope: string, taskID: string, id: string) {
      const entry = find(scope, taskID, id)
      const row = !entry && stored(scope, taskID, id)
      return entry ? snapshot(entry) : row ? receipt(row) : undefined
    },
    active(scope: string, taskID: string) {
      const id = active.get(key(scope, taskID))
      const row = !id && stored(scope, taskID)
      return id ? snapshot(entries.get(id)!) : row ? receipt(row) : undefined
    },
    async wait(scope: string, taskID: string, id: string) {
      const entry = find(scope, taskID, id)
      if (!entry) {
        const row = stored(scope, taskID, id)
        return row ? receipt(row) : undefined
      }
      await entry.done
      return snapshot(entry)
    },
    cancel(scope: string, taskID: string, id: string) {
      const entry = find(scope, taskID, id)
      if (!entry) return undefined
      if (entry.operation.status === "running") {
        entry.operation.status = "canceling"
        entry.controller.abort()
      }
      return snapshot(entry)
    },
  }
}

export const ResearchOperations = createResearchOperations(true)
