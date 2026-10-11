import { Effect, Schema } from "effect"
import { ZodOverride } from "@/util/effect-zod"
import * as Tool from "./tool"
import { resolveTaskIDBySessionID } from "@/research/hypothesis-store"
import { confirmKnowledgeExperiment, readReflectionKnowledge } from "@/research/literature/knowledge-feedback"
import { KnowledgeValidationDraftSchema, type KnowledgeValidationDraft } from "@/research/literature/knowledge-confidence"

export const ReadKnowledgeCardsTool = Tool.define("read_knowledge_cards", Effect.succeed({
  description: "Read this task's complete reviewed literature cards, cited revisions, current confidence and prior experiment facts before deciding whether the current experiment validates any claim.",
  parameters: Schema.Struct({}),
  execute: (_, ctx: Tool.Context) => Effect.promise(async () => {
    const taskID = await resolveTaskIDBySessionID(ctx.sessionID)
    if (!taskID) throw new Error("Knowledge reading requires a research task session")
    return { title: "read_knowledge_cards", metadata: {}, output: JSON.stringify(await readReflectionKnowledge(taskID)) }
  }),
}))

const Parameters = Schema.declare<KnowledgeValidationDraft>((value): value is KnowledgeValidationDraft =>
  KnowledgeValidationDraftSchema.safeParse(value).success).annotate({ [ZodOverride]: KnowledgeValidationDraftSchema })
export const ConfirmKnowledgeTool = Tool.define("confirm_knowledge", Effect.succeed({
  description: "ReflectionAgent only: confirm that the current experiment supports specified literature assertions. Supply cited card/revision, run and optional comparison IDs, condition/actual-implementation assessment, rationale and limitations. Facts are attached from authoritative run records. A validated new experiment adds 0.01 confidence (cap 1); retries never add again. Do not call for mere run success, missing/failed evidence or unimplemented mechanisms.",
  parameters: Parameters,
  execute: (args: KnowledgeValidationDraft, ctx: Tool.Context) => Effect.promise(async () => {
    try {
      if (ctx.agent !== "research-reflection") throw new Error("Only ReflectionAgent can confirm literature knowledge")
      const taskID = await resolveTaskIDBySessionID(ctx.sessionID)
      if (!taskID) throw new Error("Knowledge confirmation requires a research task session")
      const result = await confirmKnowledgeExperiment(taskID, args)
      return { title: "confirm_knowledge", metadata: { saved: true }, output: JSON.stringify({ saved: true, ...result }) }
    } catch (error) {
      return { title: "confirm_knowledge", metadata: { saved: false }, output: JSON.stringify({ saved: false, error: error instanceof Error ? error.message : String(error) }) }
    }
  }),
}))
