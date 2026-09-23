import { INTENT_SLOT_IDS } from "@/research/agents/intent-agent"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import {
  applySlotUpdates,
  checkTaskspecReadiness,
  enterIntentCheckpoint,
  readTaskspecSlots,
  recordAskUserQuestions,
  resolveTaskIDBySessionID,
  TaskSpecUpdateError,
} from "@/research/taskspec-store"

const NOT_IN_RESEARCH_SESSION =
  "This tool can only be used inside a research task session — could not resolve the current research task."


// ---------------------------------------------------------------------------
// read_taskspec
// ---------------------------------------------------------------------------

export const ReadTaskspecTool = Tool.define(
  "read_taskspec",
  Effect.succeed({
    description:
      "Read the current research task's intent slots: their values, whether each is still " +
      `missing, and whether it is required. Known slot ids: ${INTENT_SLOT_IDS.join(", ")}. ` +
      "Call this before asking the user anything and before deciding whether intent gathering " +
      "is complete — never rely on your own memory of previous values, as they may have " +
      "changed through other channels.",
    parameters: Schema.Struct({}),
    execute: (_args: Record<never, never>, ctx: Tool.Context) =>
      Effect.promise(async () => {
        const taskID = await resolveTaskIDBySessionID(ctx.sessionID)
        if (!taskID) {
          return { title: "read_taskspec", metadata: { missingCount: 0 }, output: NOT_IN_RESEARCH_SESSION }
        }
        const snapshot = await readTaskspecSlots(taskID)
        return {
          title: "read_taskspec",
          metadata: { missingCount: snapshot.missingRequiredSlots.length },
          output: JSON.stringify(snapshot, null, 2),
        }
      }),
  }),
)

// ---------------------------------------------------------------------------
// update_taskspec
// ---------------------------------------------------------------------------

const UpdateTaskspecParameters = Schema.Struct({
  updates: Schema.Record(Schema.String, Schema.Unknown).annotate({
    description:
      `Map of slot_id -> new value, after you have understood the user's answer. Valid slot ids: ${INTENT_SLOT_IDS.join(", ")}. ` +
      "Only include slots the user's message actually resolves — never invent values for slots not addressed. " +
      "parameter_budget: use an absolute integer count or an explicit size such as 5M for a hard limit; descriptive text is a preference. " +
      "latency_budget records an inference requirement, not a training timeout. " +
      "max_iterations and max_no_improve must be positive integers when supplied; their defaults are 25 and 7 respectively.",
  }),
})

type UpdateTaskspecArgs = Schema.Schema.Type<typeof UpdateTaskspecParameters>

export const UpdateTaskspecTool = Tool.define(
  "update_taskspec",
  Effect.succeed({
    description:
      "Write structured slot values to the research task's intent spec, after interpreting the " +
      "user's natural-language answer yourself. Returns the updated slot snapshot. Call " +
      "read_taskspec afterwards to independently confirm the write took effect.",
    parameters: UpdateTaskspecParameters,
    execute: (args: UpdateTaskspecArgs, ctx: Tool.Context) =>
      Effect.promise(async () => {
        const taskID = await resolveTaskIDBySessionID(ctx.sessionID)
        if (!taskID) {
          return { title: "update_taskspec", metadata: { missingCount: 0 }, output: NOT_IN_RESEARCH_SESSION }
        }
        try {
          const snapshot = await applySlotUpdates(taskID, args.updates as Record<string, unknown>)
          return {
            title: "update_taskspec",
            metadata: { missingCount: snapshot.missingRequiredSlots.length },
            output: JSON.stringify(snapshot, null, 2),
          }
        } catch (error) {
          const message = error instanceof TaskSpecUpdateError ? error.message : String(error)
          return {
            title: "update_taskspec",
            metadata: { missingCount: undefined as number | undefined },
            output: `Update rejected: ${message}`,
          }
        }
      }),
  }),
)

// ---------------------------------------------------------------------------
// check_taskspec
// ---------------------------------------------------------------------------

const CheckTaskspecParameters = Schema.Struct({
  confidence: Schema.Number.annotate({
    description: "Your own confidence (0-1) that the collected intent is sufficient to proceed.",
  }),
  rationale: Schema.String.annotate({
    description: "Brief rationale for why the intent spec is (or isn't) ready, for audit/display.",
  }),
})

type CheckTaskspecArgs = Schema.Schema.Type<typeof CheckTaskspecParameters>

export const CheckTaskspecTool = Tool.define(
  "check_taskspec",
  Effect.succeed({
    description:
      "Once read_taskspec confirms missingRequiredSlots is empty, call this to open the human " +
      "checkpoint — that is this tool's entire job, it does not perform any check itself. The " +
      "server independently re-validates that no required slot is missing before opening the " +
      "checkpoint; your confidence/rationale are recorded for audit but do not override that " +
      "validation. Only call this after read_taskspec confirms missingRequiredSlots is empty.",
    parameters: CheckTaskspecParameters,
    execute: (args: CheckTaskspecArgs, ctx: Tool.Context) =>
      Effect.promise(async () => {
        const taskID = await resolveTaskIDBySessionID(ctx.sessionID)
        if (!taskID) {
          return {
            title: "check_taskspec",
            metadata: { ok: false, checkpointStatus: undefined as "pending" | "approved" | undefined },
            output: NOT_IN_RESEARCH_SESSION,
          }
        }
        const readiness = await checkTaskspecReadiness(taskID)
        if (!readiness.ok) {
          return {
            title: "check_taskspec",
            metadata: { ok: false, checkpointStatus: undefined as "pending" | "approved" | undefined },
            output: JSON.stringify(
              {
                ok: false,
                missingRequiredSlots: readiness.missingRequiredSlots,
                serverConfidence: readiness.confidence,
                selfReportedConfidence: args.confidence,
                rationale: args.rationale,
                hint: "Call read_taskspec, then ask_user for the remaining missing slots before retrying.",
              },
              null,
              2,
            ),
          }
        }
        const checkpoint = await enterIntentCheckpoint(taskID)
        return {
          title: "check_taskspec",
          metadata: { ok: true, checkpointStatus: checkpoint.status },
          output: JSON.stringify(
            {
              ok: true,
              missingRequiredSlots: readiness.missingRequiredSlots,
              serverConfidence: readiness.confidence,
              selfReportedConfidence: args.confidence,
              rationale: args.rationale,
              checkpointStatus: checkpoint.status,
              checkpointID: checkpoint.approvalID,
              hint:
                checkpoint.status === "pending"
                  ? "Checkpoint opened — waiting for the user to approve or reject. Stop here, do not call any other tool."
                  : "Checkpoint already approved previously — intent gathering is done.",
            },
            null,
            2,
          ),
        }
      }),
  }),
)

// ---------------------------------------------------------------------------
// ask_user
// ---------------------------------------------------------------------------

const AskUserParameters = Schema.Struct({
  questions: Schema.Array(Schema.String).annotate({
    description:
      "One or more clarifying questions to show the user now. This is the ONLY way to pause and " +
      "wait for the user's answer — text you write outside this tool call will not be shown as a " +
      "question and the session will simply keep going.",
  }),
})

type AskUserArgs = Schema.Schema.Type<typeof AskUserParameters>

export const AskUserTool = Tool.define(
  "ask_user",
  Effect.succeed({
    description:
      "Pause the conversation and present one or more clarifying questions to the user. Call this " +
      "after read_taskspec shows missing required slots. Do not call any other tool in the same " +
      "turn after this one — wait for the user's reply.",
    parameters: AskUserParameters,
    execute: (args: AskUserArgs, ctx: Tool.Context) =>
      Effect.promise(async () => {
        const taskID = await resolveTaskIDBySessionID(ctx.sessionID)
        if (!taskID) {
          return { title: "ask_user", metadata: { questionCount: 0 }, output: NOT_IN_RESEARCH_SESSION }
        }
        const questions = args.questions.map((q) => q.trim()).filter((q) => q.length > 0)
        if (questions.length === 0) {
          return { title: "ask_user", metadata: { questionCount: 0 }, output: "No non-empty questions provided." }
        }
        await recordAskUserQuestions(taskID, questions)
        return {
          title: "ask_user",
          metadata: { questionCount: questions.length },
          output: `Recorded ${questions.length} question(s) for the user. Waiting for their reply.`,
        }
      }),
  }),
)
