import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import {
  abandonHypothesisInPool,
  addHypothesisToPool,
  listHypothesesInPool,
  resolveTaskIDBySessionID,
  updateHypothesisInPool,
  HypothesisNotFoundError,
} from "@/research/hypothesis-store"

type SafeResult<T> = { ok: true; value: T } | { ok: false; error: string }

async function safe<T>(fn: () => Promise<T>): Promise<SafeResult<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, error: error instanceof HypothesisNotFoundError ? error.message : String(error) }
  }
}

const Priority = Schema.Literals(["high", "medium", "low"])
const StringArray = Schema.optional(Schema.Array(Schema.String))

const NOT_IN_RESEARCH_SESSION =
  "This tool can only be used inside a research task session — could not resolve the current research task."

const AddParameters = Schema.Struct({
  statement: Schema.String.annotate({ description: "The hypothesis statement, stated as a testable claim." }),
  motivation: StringArray.annotate({ description: "Evidence/observations motivating this hypothesis." }),
  expectedOutcome: Schema.optional(Schema.String).annotate({
    description: "Concrete, metric-referenced prediction if the hypothesis holds.",
  }),
  suggestedBackbones: StringArray.annotate({ description: "Candidate model backbones/architectures to try." }),
  suggestedPreprocessing: StringArray.annotate({ description: "Candidate preprocessing steps to try." }),
  priority: Priority.annotate({ description: "Relative priority of this hypothesis." }),
  risk: Schema.optional(Schema.String).annotate({ description: "Key risk or failure mode for this hypothesis." }),
  testable: Schema.optional(Schema.Boolean).annotate({
    description: "Whether this hypothesis can be tested with an experiment run. Defaults to true.",
  }),
})

type AddArgs = Schema.Schema.Type<typeof AddParameters>

export const HypothesisAddTool = Tool.define(
  "hypothesis_add",
  Effect.succeed({
    description:
      "Add a new hypothesis to the current research task's hypothesis pool. Use this to record a new model-design direction to explore.",
    parameters: AddParameters,
    execute: (args: AddArgs, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const taskID = yield* Effect.promise(() => resolveTaskIDBySessionID(ctx.sessionID))
        if (!taskID) {
          return { title: "hypothesis_add", metadata: { hypoID: undefined as string | undefined }, output: NOT_IN_RESEARCH_SESSION }
        }
        const created = yield* Effect.promise(() =>
          addHypothesisToPool(taskID, {
            statement: args.statement,
            motivation: args.motivation ?? [],
            expectedOutcome: args.expectedOutcome ?? "",
            suggestedBackbones: args.suggestedBackbones ?? [],
            suggestedPreprocessing: args.suggestedPreprocessing ?? [],
            priority: args.priority,
            risk: args.risk ?? "",
            testable: args.testable ?? true,
          }),
        )
        return {
          title: "hypothesis_add",
          metadata: { hypoID: created.id as string | undefined },
          output: `Added hypothesis ${created.id}: ${created.statement}`,
        }
      }),
  }),
)

const UpdateParameters = Schema.Struct({
  hypoID: Schema.String.annotate({ description: "ID of the hypothesis to update (see hypothesis_list)." }),
  statement: Schema.optional(Schema.String),
  motivation: StringArray,
  expectedOutcome: Schema.optional(Schema.String),
  suggestedBackbones: StringArray,
  suggestedPreprocessing: StringArray,
  priority: Schema.optional(Priority),
  risk: Schema.optional(Schema.String),
  testable: Schema.optional(Schema.Boolean),
})

type UpdateArgs = Schema.Schema.Type<typeof UpdateParameters>

export const HypothesisUpdateTool = Tool.define(
  "hypothesis_update",
  Effect.succeed({
    description:
      "Update fields (and/or status) of an existing hypothesis in the current research task's hypothesis pool.",
    parameters: UpdateParameters,
    execute: (args: UpdateArgs, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const taskID = yield* Effect.promise(() => resolveTaskIDBySessionID(ctx.sessionID))
        if (!taskID) {
          return { title: "hypothesis_update", metadata: { hypoID: undefined as string | undefined }, output: NOT_IN_RESEARCH_SESSION }
        }
        const { hypoID, ...rest } = args
        const result = yield* Effect.promise(() => safe(() => updateHypothesisInPool(taskID, hypoID, rest)))
        if (!result.ok) {
          return { title: "hypothesis_update", metadata: { hypoID: hypoID as string | undefined }, output: result.error }
        }
        return {
          title: "hypothesis_update",
          metadata: { hypoID: result.value.id as string | undefined },
          output: `Updated hypothesis ${result.value.id} (status: ${result.value.status ?? "pending"})`,
        }
      }),
  }),
)

const AbandonParameters = Schema.Struct({
  hypoID: Schema.String.annotate({ description: "ID of the hypothesis to abandon (see hypothesis_list)." }),
  reason: Schema.String.annotate({ description: "Why this hypothesis is being abandoned." }),
})

type AbandonArgs = Schema.Schema.Type<typeof AbandonParameters>

export const HypothesisAbandonTool = Tool.define(
  "hypothesis_abandon",
  Effect.succeed({
    description:
      "Mark a hypothesis as abandoned (soft delete). It is kept in history with the given reason and excluded from hypothesis_list by default.",
    parameters: AbandonParameters,
    execute: (args: AbandonArgs, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const taskID = yield* Effect.promise(() => resolveTaskIDBySessionID(ctx.sessionID))
        if (!taskID) {
          return { title: "hypothesis_abandon", metadata: { hypoID: undefined as string | undefined }, output: NOT_IN_RESEARCH_SESSION }
        }
        const result = yield* Effect.promise(() => safe(() => abandonHypothesisInPool(taskID, args.hypoID, args.reason)))
        if (!result.ok) {
          return { title: "hypothesis_abandon", metadata: { hypoID: args.hypoID as string | undefined }, output: result.error }
        }
        return {
          title: "hypothesis_abandon",
          metadata: { hypoID: result.value.id as string | undefined },
          output: `Abandoned hypothesis ${result.value.id}: ${args.reason}`,
        }
      }),
  }),
)

const ListParameters = Schema.Struct({
  includeAbandoned: Schema.optional(Schema.Boolean).annotate({
    description: "Include abandoned hypotheses (default false).",
  }),
})

type ListArgs = Schema.Schema.Type<typeof ListParameters>

export const HypothesisListTool = Tool.define(
  "hypothesis_list",
  Effect.succeed({
    description:
      "List hypotheses currently in the research task's hypothesis pool. Use this before hypothesis_add/update/abandon to see existing IDs and avoid duplicates.",
    parameters: ListParameters,
    execute: (args: ListArgs, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const taskID = yield* Effect.promise(() => resolveTaskIDBySessionID(ctx.sessionID))
        if (!taskID) {
          return { title: "hypothesis_list", metadata: { count: undefined as number | undefined }, output: NOT_IN_RESEARCH_SESSION }
        }
        const hypotheses = yield* Effect.promise(() =>
          listHypothesesInPool(taskID, { includeAbandoned: args.includeAbandoned }),
        )
        return {
          title: "hypothesis_list",
          metadata: { count: hypotheses.length as number | undefined },
          output: JSON.stringify(hypotheses, null, 2),
        }
      }),
  }),
)
