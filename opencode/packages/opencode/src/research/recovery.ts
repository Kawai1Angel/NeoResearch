import { randomUUID } from "node:crypto"
import { SessionTable } from "@/session/session.sql"
import { cycleDigest } from "./cycle"
import { RESEARCH_MAX_RUNS_SAFETY_LIMIT } from "./defaults"
import z from "zod"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Database, and, or, eq, desc, lt, gt, like } from "@/storage"
import {
  ResearchTaskTable,
  ResearchRunTable,
  ResearchApprovalTable,
  ResearchArtifactTable,
  ResearchCycleTable,
  ResearchEventTable,
  ResearchChampionTable,
} from "./research.sql"
import { ResearchTaskID } from "./schema"
import { mapTask } from "./task-mapper"
import { ResearchOperations } from "./operation"

export const HistoryQuery = z
  .object({
    directory: z.string().optional(),
    search: z.string().max(500).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict()
const Cursor = z.object({ updated: z.number().int(), id: z.string() }).strict()
export const ResumeInput = z
  .object({ expectedRevision: z.number().int().nonnegative(), requestKey: z.string().min(1).max(200) })
  .strict()

function localArtifactPath(uri: string) {
  if (uri.startsWith("file:")) {
    try { return fileURLToPath(uri) } catch { return undefined }
  }
  return uri.startsWith("/") ? uri : undefined
}

export function researchHistory(projectID: string, input: z.infer<typeof HistoryQuery>) {
  const cursor = input.cursor ? Cursor.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString())) : undefined
  return Database.transaction(() => {
    const rows = Database.use((db) =>
      db
        .select()
        .from(ResearchTaskTable)
        .where(
          and(
            eq(ResearchTaskTable.project_id, projectID as typeof ResearchTaskTable.$inferSelect.project_id),
            input.search
              ? or(like(ResearchTaskTable.title, `%${input.search}%`), like(ResearchTaskTable.id, `%${input.search}%`))
              : undefined,
            cursor
              ? or(
                  lt(ResearchTaskTable.time_updated, cursor.updated),
                  and(
                    eq(ResearchTaskTable.time_updated, cursor.updated),
                    lt(ResearchTaskTable.id, cursor.id as ResearchTaskID),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(ResearchTaskTable.time_updated), desc(ResearchTaskTable.id))
        .limit(input.limit + 1)
        .all(),
    )
    const page = rows.slice(0, input.limit)
    const last = page.at(-1)
    return {
      items: page.map((row) => ({ ...mapTask(row), recovery: resumeState(projectID, row.id) })),
      nextCursor:
        rows.length > input.limit && last
          ? Buffer.from(JSON.stringify({ updated: last.time_updated, id: last.id })).toString("base64url")
          : null,
    }
  })
}

// This view has no execution side effects. In particular old runs with no owner
// identity remain unknown, even after a long timeout.
export function resumeState(projectID: string, taskID: ResearchTaskID) {
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
    if (!task) return undefined
    const intentSession = task.session_id
      ? db
          .select()
          .from(SessionTable)
          .where(and(eq(SessionTable.parent_id, task.session_id), eq(SessionTable.title, `IntentAgent · ${taskID}`)))
          .orderBy(desc(SessionTable.time_updated))
          .get()
      : undefined
    const runs = db.select().from(ResearchRunTable).where(eq(ResearchRunTable.task_id, taskID)).all()
    const approvals = db.select().from(ResearchApprovalTable).where(eq(ResearchApprovalTable.task_id, taskID)).all()
    const cycle = db.select().from(ResearchCycleTable).where(eq(ResearchCycleTable.active_task, taskID)).get()
    const eventCursor =
      db
        .select()
        .from(ResearchEventTable)
        .where(eq(ResearchEventTable.task_id, taskID))
        .orderBy(desc(ResearchEventTable.sequence))
        .get()?.sequence ?? 0
    const pendingApproval = approvals.find((item) => item.status === "pending") ?? null
    const activeOperation = ResearchOperations.active(projectID, taskID) ?? null
    const blockers: string[] = []
    if (cycle && cycle.input_digest !== cycleDigest(mapTask(task)))
      blockers.push("Input data or the evaluation protocol changed; explicitly create a new research cycle")
    const artifacts = db.select().from(ResearchArtifactTable).where(eq(ResearchArtifactTable.task_id, taskID)).all()
    for (const artifact of artifacts) {
      const local = localArtifactPath(artifact.uri)
      // Older runners registered temporary CV checkpoints as permanent artifacts.
      // Their durable metrics and progress remain available after temp cleanup.
      const transientCV = artifact.kind === "runner_artifact" && local && /(?:^|\/)neo-cast-cv-[^/]+\/fold_\d+\//.test(local)
      // Neo-Cast keeps only the latest 30 smoke directories. A collected smoke
      // checkpoint is optional only when its finished, verified run still has
      // durable progress, execution and contract receipts. Full/test artifacts
      // and missing durable evidence remain blockers.
      const run = runs.find((item) => item.id === artifact.run_id)
      const contract = run?.resource_usage.executionContract
      const retainedSmoke = artifact.kind === "runner_artifact" && artifact.metadata.stage === "smoke" &&
        local && /\/\.neo-cast\/artifacts\/smoke\/run_[^/]+\/?$/.test(local) &&
        run?.stage === "smoke" && run.status === "succeeded" && run.artifact_refs.includes(artifact.id) &&
        contract && typeof contract === "object" && "status" in contract && contract.status === "verified" &&
        ["runner_progress_jsonl", "runner_execution_log_json", "execution_contract_verified_json"].every((kind) =>
          artifacts.some((receipt) => {
            const file = localArtifactPath(receipt.uri)
            return receipt.run_id === run.id && receipt.kind === kind && run.artifact_refs.includes(receipt.id) && file && existsSync(file)
          }),
        )
      if (local && !transientCV && !retainedSmoke && !existsSync(local)) blockers.push(`Missing artifact:${local}`)
    }
    if (!task.session_id) blockers.push("The original research conversation was deleted; research results are retained")
    const unknown =
      activeOperation?.recoveryRequired ||
      (!activeOperation && runs.some((run) => ["queued", "running"].includes(run.status)))
    if (unknown) blockers.push("The previous execution's final state is unconfirmed; duplicate execution is blocked. Check the original service, runner, and existing artifacts.")
    const recoveryState = unknown
      ? "needs_reconciliation"
      : activeOperation
        ? "running"
        : pendingApproval || task.status === "intent_gathering"
          ? "waiting_input"
          : blockers.length
            ? "blocked"
            : task.status === "completed"
              ? "completed"
              : "resumable"
    const summary =
      recoveryState === "running"
        ? "Research is still running; view the original operation"
        : recoveryState === "waiting_input"
          ? (pendingApproval?.reason ?? "Please answer the original intent question")
          : recoveryState === "completed"
            ? "Research is complete; view results"
            : blockers.join("; ") || "Research can resume from the saved stage"
    return {
      taskID,
      intentSessionID: intentSession?.id ?? null,
      eventCursor,
      cycleID: cycle?.id ?? null,
      revision: task.state_revision,
      rootSessionID: task.session_id,
      chatSessionID: task.cockpit_chat_session_id,
      recoveryState,
      currentPhase: task.status,
      activeOperation,
      pendingApproval: pendingApproval
        ? {
            id: pendingApproval.id,
            kind: pendingApproval.kind,
            status: pendingApproval.status,
            reason: pendingApproval.reason,
            candidateID: pendingApproval.candidate_id,
          }
        : null,
      summary,
      blockers,
      completedRuns: runs.filter((run) => run.status === "succeeded").length,
      nextAction:
        recoveryState === "resumable"
          ? "continue"
          : recoveryState === "running"
            ? "attach"
            : recoveryState === "completed"
              ? "results"
              : recoveryState === "waiting_input"
                ? "answer"
                : "inspect",
    }
  })
}
export type ResumeState = NonNullable<ReturnType<typeof resumeState>>

export function researchEvents(taskID: ResearchTaskID, after: number) {
  return Database.use((db) =>
    db
      .select()
      .from(ResearchEventTable)
      .where(and(eq(ResearchEventTable.task_id, taskID), gt(ResearchEventTable.sequence, after)))
      .orderBy(ResearchEventTable.sequence)
      .limit(200)
      .all(),
  )
}

export function researchTasksForSession(projectID: string, sessionID: string) {
  const visited = new Set<string>()
  return Database.use((db) => {
    let id: string | null = sessionID
    while (id && !visited.has(id)) {
      visited.add(id)
      const current = db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, id as typeof SessionTable.$inferSelect.id))
        .get()
      if (!current || current.project_id !== projectID) return []
      const tasks = db
        .select()
        .from(ResearchTaskTable)
        .where(
          and(
            eq(ResearchTaskTable.project_id, current.project_id),
            or(eq(ResearchTaskTable.session_id, current.id), eq(ResearchTaskTable.cockpit_chat_session_id, current.id)),
          ),
        )
        .all()
      if (tasks.length) return tasks.map(mapTask)
      id = current.parent_id
    }
    return []
  })
}

export const CycleInput = ResumeInput.extend({
  maxIterations: z.number().int().min(1).max(1000),
  maxRuns: z.number().int().min(1).max(RESEARCH_MAX_RUNS_SAFETY_LIMIT),
}).strict()
export function createResearchCycle(projectID: string, taskID: ResearchTaskID, input: z.infer<typeof CycleInput>) {
  return Database.transaction(
    (db) => {
      const state = resumeState(projectID, taskID)
      if (!state) return { status: 404 as const, body: { message: "Research task not found" } }
      const requestKey = JSON.stringify([taskID, input.requestKey])
      const previous = db.select().from(ResearchCycleTable).where(eq(ResearchCycleTable.request_key, requestKey)).get()
      if (previous)
        return previous.request_digest === JSON.stringify(input)
          ? { status: 200 as const, body: previous }
          : { status: 409 as const, body: { message: "Request key already used with different input", state } }
      if (
        state.revision !== input.expectedRevision ||
        state.activeOperation ||
        state.pendingApproval ||
        state.recoveryState === "needs_reconciliation"
      )
        return { status: 409 as const, body: { message: "Research state changed or requires attention", state } }
      const task = db.select().from(ResearchTaskTable).where(eq(ResearchTaskTable.id, taskID)).get()!
      const current = db.select().from(ResearchCycleTable).where(eq(ResearchCycleTable.active_task, taskID)).get()
      db.update(ResearchCycleTable).set({ active_task: null }).where(eq(ResearchCycleTable.active_task, taskID)).run()
      const inputDigest = cycleDigest(mapTask(task))
      const compatible = current?.input_digest === inputDigest
      if (!compatible) db.delete(ResearchChampionTable).where(eq(ResearchChampionTable.task_id, taskID)).run()
      const cycle = db
        .insert(ResearchCycleTable)
        .values({
          id: randomUUID(),
          task_id: taskID,
          active_task: taskID,
          request_key: requestKey,
          request_digest: JSON.stringify(input),
          input_digest: inputDigest,
          policy: { maxIterations: input.maxIterations },
        })
        .returning()
        .get()!
      const metadata = task.task_spec.metadata as Record<string, unknown> | undefined
      const workflow = metadata?.workflow as { completedPhases?: string[] } | undefined
      const phases = compatible
        ? (workflow?.completedPhases ?? []).filter((phase) =>
            ["intent_gathering", "data_analysis", "literature", "hypo_planning"].includes(phase),
          )
        : []
      db.update(ResearchTaskTable)
        .set({
          status: "paused",
          budget: { ...task.budget, maxRuns: RESEARCH_MAX_RUNS_SAFETY_LIMIT },
          task_spec: { ...task.task_spec, metadata: { ...metadata, workflow: { completedPhases: phases } } },
          time_updated: Date.now(),
        })
        .where(eq(ResearchTaskTable.id, taskID))
        .run()
      return { status: 200 as const, body: cycle }
    },
    { behavior: "immediate" },
  )
}
