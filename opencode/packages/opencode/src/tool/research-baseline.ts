import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import {
  pickReferenceBaseline,
  loadBaselineOptions,
  resolveTaskIDBySessionID,
  InvalidBaselineError,
  TaskNotFoundError,
  BaselineAlreadyPickedError,
} from "@/research/baseline-store"

const NOT_IN_RESEARCH_SESSION =
  "This tool can only be used inside a research task session — could not resolve the current research task."

const PickParameters = Schema.Struct({
  recipeID: Schema.String.annotate({
    description: "Recipe ID of the baseline to pick as this task's reference baseline (see baselineOptions in the input).",
  }),
  rationale: Schema.String.annotate({
    description: "Why this baseline was chosen over the others, referencing specific dataset characteristics.",
  }),
})

type PickArgs = Schema.Schema.Type<typeof PickParameters>

export const BaselinePickTool = Tool.define(
  "pick_baseline",
  Effect.succeed({
    description:
      "Pick exactly one baseline recipe as this research task's reference baseline and first candidate to run. Call this once, after the hypothesis pool has been populated on the first iteration only — later baseline search only considers this recipe. Do not call on any later iteration.",
    parameters: PickParameters,
    execute: (args: PickArgs, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const taskID = yield* Effect.promise(() => resolveTaskIDBySessionID(ctx.sessionID))
        if (!taskID) {
          return {
            title: "pick_baseline",
            metadata: { recipeID: undefined as string | undefined },
            output: NOT_IN_RESEARCH_SESSION,
          }
        }
        const result = yield* Effect.promise(async () => {
          try {
            return { ok: true as const, value: await pickReferenceBaseline(taskID, args.recipeID, args.rationale) }
          } catch (error) {
            return {
              ok: false as const,
              error:
                error instanceof InvalidBaselineError ||
                error instanceof TaskNotFoundError ||
                error instanceof BaselineAlreadyPickedError
                  ? error.message
                  : String(error),
            }
          }
        })
        if (!result.ok) {
          return { title: "pick_baseline", metadata: { recipeID: args.recipeID as string | undefined }, output: result.error }
        }
        return {
          title: "pick_baseline",
          metadata: { recipeID: result.value.referenceBaseline as string | undefined },
          output: `Picked reference baseline: ${result.value.referenceBaseline}`,
        }
      }),
  }),
)

export const BaselineLoadTool = Tool.define(
  "load_baseline",
  Effect.succeed({
    description:
      "Read this task's candidate baseline recipes (recipeID + rationale) and which one, if any, was already picked via pick_baseline. " +
      "Only call this on the first iteration, right before pick_baseline. Do not call on any later iteration — the baseline was already fixed and is not revisited.",
    parameters: Schema.Struct({}),
    execute: (_args: Record<never, never>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const taskID = yield* Effect.promise(() => resolveTaskIDBySessionID(ctx.sessionID))
        if (!taskID) {
          return { title: "load_baseline", metadata: { picked: undefined as string | undefined }, output: NOT_IN_RESEARCH_SESSION }
        }
        const result = yield* Effect.promise(async () => {
          try {
            return { ok: true as const, value: await loadBaselineOptions(taskID) }
          } catch (error) {
            return { ok: false as const, error: error instanceof TaskNotFoundError ? error.message : String(error) }
          }
        })
        if (!result.ok) {
          return { title: "load_baseline", metadata: { picked: undefined as string | undefined }, output: result.error }
        }
        if (result.value.picked) {
          return {
            title: "load_baseline",
            metadata: { picked: result.value.picked as string | undefined },
            output:
              `Reference baseline already picked: "${result.value.picked}". It was fixed on the first ` +
              "iteration and is never revisited — do not call load_baseline or pick_baseline again on later iterations.",
          }
        }
        return {
          title: "load_baseline",
          metadata: { picked: result.value.picked as string | undefined },
          output: JSON.stringify(result.value, null, 2),
        }
      }),
  }),
)
