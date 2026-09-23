import z from "zod"

export const OperationReceiptSchema = z
  .object({
    id: z.string(),
    taskID: z.string(),
    action: z.string(),
    status: z.enum(["running", "canceling", "completed", "failed", "canceled", "interrupted", "waiting_input"]),
    startedAt: z.number().int().nonnegative().optional(),
    recoveryRequired: z.boolean().optional(),
    result: z.unknown().optional(),
    error: z.object({ name: z.string(), message: z.string(), data: z.unknown().optional() }).strict().optional(),
  })
  .strict()
export const ResumeStateSchema = z
  .object({
    taskID: z.string(),
    revision: z.number().int().nonnegative(),
    cycleID: z.string().nullable(),
    rootSessionID: z.string().nullable(),
    chatSessionID: z.string().nullable(),
    intentSessionID: z.string().nullable(),
    recoveryState: z.enum(["running", "waiting_input", "resumable", "needs_reconciliation", "blocked", "completed"]),
    currentPhase: z.string(),
    activeOperation: OperationReceiptSchema.nullable(),
    pendingApproval: z
      .object({
        id: z.string(),
        kind: z.string(),
        status: z.string(),
        reason: z.string(),
        candidateID: z.string().nullable(),
      })
      .strict()
      .nullable(),
    summary: z.string(),
    blockers: z.array(z.string()),
    completedRuns: z.number().int().nonnegative(),
    eventCursor: z.number().int().nonnegative(),
    nextAction: z.enum(["continue", "attach", "results", "answer", "inspect"]),
  })
  .strict()
export const HistoryPageSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.string(),
          projectID: z.string(),
          sessionID: z.string().optional(),
          cockpitChatSessionID: z.string().optional(),
          stateRevision: z.number().int().optional(),
          title: z.string(),
          domainID: z.string(),
          mode: z.string(),
          interactionMode: z.enum(["companion", "socratic"]).optional(),
          status: z.string(),
          taskSpec: z.record(z.string(), z.unknown()),
          objective: z.record(z.string(), z.unknown()),
          budget: z.record(z.string(), z.unknown()),
          time: z.object({ created: z.number(), updated: z.number() }).strict(),
          recovery: ResumeStateSchema.optional(),
        })
        .strict(),
    ),
    nextCursor: z.string().nullable(),
  })
  .strict()
export const ResearchEventSchema = z
  .object({
    sequence: z.number().int(),
    task_id: z.string(),
    kind: z.string(),
    summary: z.string(),
    time: z.number().int(),
  })
  .strict()
