import { agentExperienceReader, ExperiencePurpose } from "@/research/experience-purpose"
import { Effect, Schema } from "effect"
import { ZodOverride } from "@/util/effect-zod"
import * as Tool from "./tool"
import { resolveTaskIDBySessionID } from "@/research/hypothesis-store"
import {
  ExperienceDraftSchema,
  experienceFromMemory,
  experienceFactForPrompt,
  experiencePromptRecord,
  experienceSummaryForPrompt,
  type ExperienceDraft,
} from "@/research/experience"
import { readExperiences, readExperiencesForRole, experiencePurposeForReader, writeExperience } from "@/research/experience-store"
import { Instance } from "@/project/instance"
import { EXPERIENCE_SEARCH_METHOD } from "@/research/experience-search"
import { EXPERIENCE_QUERY_INTENTS, parseExperienceQuery } from "@/research/experience-query"
import { experienceOrganizationOutline, type ExperienceOrganization } from "@/research/experience-evolution"

const WriteParameters = Schema.declare<ExperienceDraft>(
  (value): value is ExperienceDraft => ExperienceDraftSchema.safeParse(value).success,
).annotate({ [ZodOverride]: ExperienceDraftSchema })

export const WriteExperienceTool = Tool.define(
  "write_experience",
  Effect.succeed({
    description:
      "Optionally save a useful positive, negative, mixed or inconclusive research experience directly to the shared experience library. " +
      "Choose experiment_fact, conditional_experience, or validated_principle. Supply a conditional claim and real run IDs; " +
      "the tool attaches dataset, executed model, training recipe, metrics and errors from authoritative records. " +
      "Every experience has experimentFacts, conditionalExperience and validatedRegularity. Supply evolution.claim for a new falsifiable conditional claim; " +
      "to test an existing claim, use evolution.parentExperienceID and relation=supports/refutes/qualifies/observes. " +
      "Before creating a new claim, search shared experience for that proposition and read a matching exact ID. " +
      "Append to that canonical ID when the meaning is unchanged. The result distinguishes experienceCreated from appended and returns its current revision. " +
      "The relation is to the parent's claim, not the local metric direction. A negative outcome can refute a positive claim. " +
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
          const organization = experienceSummaryForPrompt(result.memory).organization
          return {
            title: "write_experience",
            metadata: { saved: true, experienceID: result.canonicalExperienceID as string | undefined },
            output: JSON.stringify(
              { saved: true, created: result.experienceCreated, appended: result.appended,
                sourceEntryCreated: result.created, experience: {
                id: result.canonicalExperienceID, sourceEntryID: result.sourceEntryID, revision: result.revision,
                sourceTaskID: result.memory.taskID,
                level: experienceFromMemory(result.memory)?.draft.level,
                polarity: experienceFromMemory(result.memory)?.draft.polarity,
                supportDatasetCount: experienceFromMemory(result.memory)?.supportDatasetCount,
                evidence: experienceFromMemory(result.memory)?.draft.evidence,
                facts: experienceSummaryForPrompt(result.memory).sourceRuns,
                organization: organization ? experienceOrganizationOutline(organization as unknown as ExperienceOrganization) : undefined,
                detailAccess: { tool: "read_experiences", experienceID: result.canonicalExperienceID, includeFacts: true },
              } },
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
  experienceID: Schema.optional(Schema.String).annotate({ description: "Read one saved experience by exact ID; use includeFacts=true for its detailed authoritative snapshots." }),
  threadID: Schema.optional(Schema.String).annotate({ description: "Read entries testing the same conditional claim. Every result includes the thread's accumulated supporting datasets, counterexamples, boundaries and verification state." }),
  includeArchived: Schema.optional(Schema.Boolean).annotate({ description: "Include merged/quarantined records for audit (default false). Default exact reads of merged IDs resolve to the canonical experience." }),
  includeOriginal: Schema.optional(Schema.Boolean).annotate({ description: "With an exact experienceID, explicitly load original withdrawn prose for audit. It is not usable scientific guidance; defaults to false." }),
  includeHistory: Schema.optional(Schema.Boolean).annotate({ description: "With an exact experienceID, include persisted version summaries of the same claim, evidence IDs, conclusions, supports, counterexamples and boundaries. Defaults to false." }),
  scope: Schema.optional(Schema.Literals(["task", "project", "shared"])).annotate({
    description: "shared (default) reads the same domain across projects; project restricts to this project; task restricts to this task.",
  }),
  purpose: Schema.optional(Schema.Literals(ExperiencePurpose.options)).annotate({ description: "optimization or architecture. Agent defaults are enforced by its research role." }),
  includeUnknown: Schema.optional(Schema.Boolean).annotate({ description: "With an exact experienceID, opt in to legacy records whose purpose cannot be inferred. These are audit evidence, not automatic guidance." }),
  level: Schema.optional(Schema.Literals(["experiment_fact", "conditional_experience", "validated_principle"])),
  polarity: Schema.optional(Schema.Literals(["positive", "negative", "mixed", "inconclusive"])),
  query: Schema.optional(Schema.String).annotate({
    description: "Optional concrete mechanism, changed recipe field or error question. Ranks verified changes, observed errors and executed configurations. Untested interpretation/plan text cannot establish a default match. Supports English aliases and recipe field names. Does not pad results with unrelated entries.",
  }),
  includeBackground: Schema.optional(Schema.Boolean).annotate({
    description: "Opt in to explicitly labeled configuration or unverified-text background (default false). These matches are suggestions for investigation, not direct evidence for the queried intervention.",
  }),
  intent: Schema.optional(Schema.Literals(EXPERIENCE_QUERY_INTENTS)).annotate({
    description: "auto (default), execution_error, configuration, intervention, comparison, or discovery. Configuration binds required mechanisms to one run; comparison requires a matched full-run pair; intervention requires the queried changed axis and a full-run contrast. GRU/LSTM are exact cell constraints. Use discovery for alternative architectures. Missing conditions are reported on opt-in background results.",
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
      "Read explicitly saved research experience from the shared library across projects in the same domain. Returns source project/task, evidence IDs, " +
      "a deterministic evidence representation with observed conditions, verified interventions, metric contrasts, errors, and separately labeled unverified interpretations/plans. " +
      "Compare applicability with the current data before using a claim. A negative result in another task does not rule out " +
      "the current hypothesis. Query results explain matched factual fields, preserve same-evidence alternatives and abstain when specific entities lack factual support. Empty results mean no direct evidence matched these filters, not that the library is empty; use includeBackground=true for labeled leads, vary the query, or omit query to browse.",
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
        const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(50, Math.floor(args.limit!)))
          : ctx.agent === "research-reflection" ? 3 : 12
        const scope = args.scope ?? (ctx.agent === "research-reflection" && !args.experienceID ? "task" : "shared")
        const reader = agentExperienceReader(ctx.agent)
        const memories = reader ? readExperiencesForRole(taskID, reader, { ...args, scope, limit }) : readExperiences(taskID, { ...args, scope, limit })
        const records: Record<string, unknown>[] = memories.map((memory) => ({
          ...(!args.includeFacts ? experienceSummaryForPrompt(memory) : experiencePromptRecord(memory)),
          relationship: memory.taskID === taskID ? "same_task"
            : (memory.candidateSummary.experienceSource as { projectID?: string } | undefined)?.projectID === Instance.project.id
              ? "same_domain" : "cross_project",
          ...(args.includeFacts ? { facts: experienceFromMemory(memory)!.facts.map(experienceFactForPrompt) } : {}),
        }))
        if (args.includeFacts) for (const record of records) {
          const organization = record.organization as ExperienceOrganization | undefined
          if (organization) record.organization = { ...organization,
            experimentFacts: { ...organization.experimentFacts, facts: undefined,
              sourceRunIDs: organization.experimentFacts.facts.map(fact => fact.runID),
              detailPath: "facts (current entry); read other memberExperienceIDs for the rest of the thread" } }
        }
        // Leave room for the envelope below the generic tool's 50 KiB limit.
        // Drop whole summaries rather than truncating conditions or returning broken JSON.
        const experiences: typeof records = args.includeFacts ? records : []
        let bytes = 0
        for (const record of args.includeFacts ? [] : records) {
          const size = Buffer.byteLength(JSON.stringify(record), "utf8")
          if (bytes + size > 40_000 && experiences.length) break
          if (size > 40_000) {
            // An unusually large entry is discoverable without presenting partial claims as complete.
            const memory = memories[0]!
            const experience = experienceFromMemory(memory)!
            experiences.push({ id: memory.id, sourceTaskID: memory.taskID,
              source: memory.candidateSummary.experienceSource, relationship: record.relationship,
              level: experience.draft.level, statement: typeof record.statement === "string" ? record.statement.slice(0, 2000) : undefined,
              retrievalMatch: record.retrievalMatch, interpretationStatus: record.interpretationStatus,
              organization: record.organization ? experienceOrganizationOutline(record.organization as ExperienceOrganization) : undefined,
              summaryOmitted: true, detailAccess: { tool: "read_experiences", experienceID: memory.id, includeFacts: true } })
            break
          }
          experiences.push(record)
          bytes += size
        }
        return {
          title: "read_experiences",
          metadata: { count: experiences.length },
          output: JSON.stringify({
            available: true,
            experiences,
            retrieval: { method: args.query?.trim() ? EXPERIENCE_SEARCH_METHOD : "recent", scope,
              purpose: reader ? experiencePurposeForReader(reader, args) : args.purpose ?? null,
              query: args.query ?? null, returnedCount: experiences.length,
              queryPlan: args.query?.trim() ? parseExperienceQuery(args.query, args.intent) : undefined,
              includeBackground: args.includeBackground ?? false,
              contextLimited: experiences.length < records.length || experiences.some(record => "summaryOmitted" in record),
              matchedRecordsInBatch: records.length },
            guidance:
              "Facts describe observed runs; conditional experiences generate hypotheses; validated principles remain limited to their documented scope. Verify transfer on the current task.",
          }),
        }
      }),
  }),
)
