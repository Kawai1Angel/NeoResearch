import { Effect, Schema } from "effect"
import { ZodOverride } from "@/util/effect-zod"
import * as Tool from "./tool"
import { resolveTaskIDBySessionID } from "@/research/hypothesis-store"
import {
  ExperienceDraftSchema,
  experienceFromMemory,
  experienceFactForPrompt,
  experiencePromptRecord,
  type ExperienceDraft,
} from "@/research/experience"
import { readExperiences, writeExperience } from "@/research/experience-store"

const WriteParameters = Schema.declare<ExperienceDraft>(
  (value): value is ExperienceDraft => ExperienceDraftSchema.safeParse(value).success,
).annotate({ [ZodOverride]: ExperienceDraftSchema })

export const WriteExperienceTool = Tool.define(
  "write_experience",
  Effect.succeed({
    description:
      "Optionally save a useful positive, negative, mixed or inconclusive research experience. " +
      "Choose experiment_fact, conditional_experience, or validated_principle. Supply a conditional claim and real run IDs; " +
      "the tool attaches dataset, executed model, training recipe, metrics and errors from authoritative records. " +
      "Performance experiences need completed same-task comparison runs. Validated principles require evidence from " +
      "at least two different dataset contents. Use derivedFrom to refine prior experiences while retaining counterevidence. " +
      "Do not call when the result adds no useful evidence. Only ReflectionAgent may write.",
    parameters: WriteParameters,
    execute: (args: ExperienceDraft, ctx: Tool.Context) =>
      Effect.promise(async () => {
        try {
          if (ctx.agent !== "research-reflection") throw new Error("Only ReflectionAgent can save research experiences")
          const taskID = await resolveTaskIDBySessionID(ctx.sessionID)
          if (!taskID) throw new Error("Experience writes require a research task session")
          const result = await writeExperience(taskID, args)
          return {
            title: "write_experience",
            metadata: { saved: true, experienceID: result.memory.id as string | undefined },
            output: JSON.stringify(
              { saved: true, created: result.created, experience: experiencePromptRecord(result.memory) },
              null,
              2,
            ),
          }
        } catch (error) {
          return {
            title: "write_experience",
            metadata: { saved: false, experienceID: undefined as string | undefined },
            output: JSON.stringify({ saved: false, error: error instanceof Error ? error.message : String(error) }),
          }
        }
      }),
  }),
)

const ReadParameters = Schema.Struct({
  scope: Schema.optional(Schema.Literals(["task", "project"])).annotate({
    description: "task for current-task experience; project (default) includes other tasks in the same domain.",
  }),
  level: Schema.optional(Schema.Literals(["experiment_fact", "conditional_experience", "validated_principle"])),
  polarity: Schema.optional(Schema.Literals(["positive", "negative", "mixed", "inconclusive"])),
  query: Schema.optional(Schema.String).annotate({
    description: "Optional text filter on claims, interventions, conditions and boundaries.",
  }),
  limit: Schema.optional(Schema.Number).annotate({ description: "Maximum returned records (1–50, default 12)." }),
  includeFacts: Schema.optional(Schema.Boolean).annotate({
    description: "Include full factual snapshots with models and metrics (default false).",
  }),
})

export const ReadExperiencesTool = Tool.define(
  "read_experiences",
  Effect.succeed({
    description:
      "Read explicitly saved research experience across tasks in this project and domain. Returns evidence IDs, " +
      "conditions, interventions, observations, limitations and validation plans, with each record's experience level. " +
      "Compare applicability with the current data before using a claim. A negative result in another task does not rule out " +
      "the current hypothesis. Empty results mean no structured experience has been saved yet.",
    parameters: ReadParameters,
    execute: (args: Schema.Schema.Type<typeof ReadParameters>, ctx: Tool.Context) =>
      Effect.promise(async () => {
        const taskID = await resolveTaskIDBySessionID(ctx.sessionID)
        if (!taskID)
          return {
            title: "read_experiences",
            metadata: { count: 0 },
            output: JSON.stringify({ available: false, error: "Research task session required" }),
          }
        const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(50, Math.floor(args.limit!))) : 12
        const memories = readExperiences(taskID, { ...args, limit })
        const experiences = memories.map((memory) => ({
          ...experiencePromptRecord(memory),
          relationship: memory.taskID === taskID ? "same_task" : "same_domain",
          ...(args.includeFacts ? { facts: experienceFromMemory(memory)!.facts.map(experienceFactForPrompt) } : {}),
        }))
        return {
          title: "read_experiences",
          metadata: { count: experiences.length },
          output: JSON.stringify(
            {
              available: true,
              experiences,
              guidance:
                "Facts describe observed runs; conditional experiences generate hypotheses; validated principles remain limited to their documented scope. Verify transfer on the current task.",
            },
            null,
            2,
          ),
        }
      }),
  }),
)
