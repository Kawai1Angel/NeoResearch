import { readDesignHistory } from "../research/design-history"
import { taskMemories } from "../research/experience-store"
import { readReflectionHistory } from "../research/reflection-context"
import { extractTrainingCurve } from "../research/runner-evidence"
export { extractTrainingCurve } from "../research/runner-evidence"
import { Effect, Schema } from "effect"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import * as Tool from "./tool"
import { resolveTaskIDBySessionID } from "@/research/hypothesis-store"
import { Database, and, desc, eq } from "@/storage"
import {
  ResearchArtifactTable,
  ResearchRunTable,
  ResearchTaskTable,
} from "@/research/research.sql"
import type { ResearchRunID } from "@/research/schema"
import { Instance } from "@/project/instance"

const NOT_IN_RESEARCH_SESSION =
  "This tool can only be used inside a research task session — could not resolve the current research task."

// ---------------------------------------------------------------------------
// read_reflection
// ---------------------------------------------------------------------------

type PersistedReflectionLLM = {
  readonly status?: "disabled" | "not_configured" | "used" | "failed"
  readonly model?: string
  readonly text?: string
  readonly structured?: Record<string, unknown>
  readonly error?: string
}

export const ReadReflectionTool = Tool.define(
  "read_reflection",
  Effect.succeed({
    description:
      "Read the LLM output of the most recent Reflection Agent run for the current research task — " +
      "its status, model, raw text, and structured analysis (trainingHealthAssessment, hypothesisValidation, " +
      "attributionAnalysis, historicalComparison, modelDesignReflection, nextStepRecommendation, distillableMemory). " +
      "Returns { available: false } on the first iteration before any Reflection has run.",
    parameters: Schema.Struct({ full: Schema.optional(Schema.Boolean) }),
    execute: (args: { full?: boolean }, ctx: Tool.Context) =>
      Effect.promise(async () => {
        const taskID = await resolveTaskIDBySessionID(ctx.sessionID)
        if (!taskID) {
          return {
            title: "read_reflection",
            metadata: { available: false as boolean | undefined },
            output: NOT_IN_RESEARCH_SESSION,
          }
        }
        try {
          const sessionsDir = path.join(Instance.directory, ".neo-research", "sessions", taskID)
          const entries = await readdir(sessionsDir, { withFileTypes: true })
          const reflectDirs = entries
            .filter((e) => e.isDirectory() && e.name.startsWith("reflect_"))
            .map((e) => e.name)
            .sort()
            .reverse()
          for (const dirName of reflectDirs) {
            try {
              const raw = await readFile(path.join(sessionsDir, dirName, "reflection_result.json"), "utf8")
              const result = JSON.parse(raw) as { llm?: PersistedReflectionLLM }
              if (!result.llm) continue
              return {
                title: "read_reflection",
                metadata: { available: true },
                output: JSON.stringify(ctx.agent === "research-reflection" && !args.full
                  ? { available: true, status: result.llm.status, structured: result.llm.structured,
                    ...(!result.llm.structured ? { text: result.llm.text?.slice(0, 4000), truncated: (result.llm.text?.length ?? 0) > 4000 } : {}),
                    detailAccess: "Use read_reflection(full=true) only if exact prior wording is needed." }
                  : { available: true, ...result.llm }, null, 2),
              }
            } catch { continue }
          }
        } catch { /* sessionsDir doesn't exist yet */ }
        return {
          title: "read_reflection",
          metadata: { available: false },
          output: JSON.stringify({ available: false }, null, 2),
        }
      }),
  }),
)

// ---------------------------------------------------------------------------
// experiment_results
// ---------------------------------------------------------------------------

const ExperimentResultsParameters = Schema.Struct({
  runID: Schema.optional(Schema.String).annotate({ description: "Read a specific comparison run, scoped to this task." }),
  candidateID: Schema.optional(Schema.String).annotate({ description: "Read runs of a particular candidate." }),
  hypothesisID: Schema.optional(Schema.String).annotate({ description: "Read runs testing a particular hypothesis." }),
  offset: Schema.optional(Schema.Number).annotate({ description: "Pagination offset; use nextOffset from the previous response." }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum number of runs to return (1–20, default: 5).",
  }),
})

type ExperimentResultsArgs = Schema.Schema.Type<typeof ExperimentResultsParameters>

export const ExperimentResultsTool = Tool.define(
  "experiment_results",
  Effect.succeed({
    description:
      "Read recent experiment run results for the current research task. " +
      "Returns finished runs (succeeded or failed) ordered by most recent first, " +
      "including the primary metric value, any error messages, and the `hypoID` of the " +
      "hypothesis that produced each run's candidate (when resolvable) — use this to identify " +
      "which hypothesis was tested by the most recent run. Includes the executed modelDesign " +
      "recipe and evidence_disposition; a missing full-run primary metric is inconclusive.",
    parameters: ExperimentResultsParameters,
    execute: (args: ExperimentResultsArgs, ctx: Tool.Context) =>
      Effect.promise(async () => {
        const taskID = await resolveTaskIDBySessionID(ctx.sessionID)
        if (!taskID) {
          return {
            title: "experiment_results",
            metadata: { runCount: 0 },
            output: NOT_IN_RESEARCH_SESSION,
          }
        }
        const result = ctx.agent === "research-reflection" && !args.runID && !args.candidateID && !args.hypothesisID && !args.offset
          ? await readReflectionHistory(taskID)
          : await readDesignHistory(taskID, args, { forReflection: ctx.agent === "research-reflection" })
        return {
          title: "experiment_results",
          metadata: { runCount: result.runs.length },
          output: JSON.stringify(result, null, 2),
        }
      }),
  }),
)

// ---------------------------------------------------------------------------
// Shared helper: parse + optionally sample a training-curve JSONL file
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// read_training_curve
// ---------------------------------------------------------------------------

const ReadTrainingCurveParameters = Schema.Struct({
  runID: Schema.optional(Schema.String).annotate({
    description: "ID of the run to read. Omit to use the latest run, including failed or invalid attempts.",
  }),
  maxPoints: Schema.optional(Schema.Number).annotate({
    description: "Maximum points per fold/horizon series (1–120, default: 60). One point keeps the last epoch; otherwise preserve both endpoints.",
  }),
})

type ReadTrainingCurveArgs = Schema.Schema.Type<typeof ReadTrainingCurveParameters>

export const ReadTrainingCurveTool = Tool.define(
  "read_training_curve",
  Effect.succeed({
    description:
      "Read the training curve (epoch-by-epoch val loss) for a run in the current research task. " +
      "Returns points grouped by phase, foldIndex and horizon, ordered by epoch within each group, " +
      "sampled to maxPoints per group. Never compare adjacent points across groups. Defaults to the latest run, including failures. Returns { available: false } if no " +
      "progress artifact exists for the requested run.",
    parameters: ReadTrainingCurveParameters,
    execute: (args: ReadTrainingCurveArgs, ctx: Tool.Context) =>
      Effect.promise(async () => {
        const taskID = await resolveTaskIDBySessionID(ctx.sessionID)
        if (!taskID) {
          return {
            title: "read_training_curve",
            metadata: { available: false as boolean },
            output: NOT_IN_RESEARCH_SESSION,
          }
        }

        const maxPoints = Math.min(120, Math.max(1, Math.floor(args.maxPoints ?? 60)))

        let runID: string | undefined = args.runID
        let runStatus: string | undefined

        if (runID) {
          const row = Database.use((d) =>
            d
              .select({ id: ResearchRunTable.id, status: ResearchRunTable.status, task_id: ResearchRunTable.task_id })
              .from(ResearchRunTable)
              .where(and(eq(ResearchRunTable.id, runID! as ResearchRunID), eq(ResearchRunTable.task_id, taskID)))
              .get(),
          )
          if (!row) {
            return {
              title: "read_training_curve",
              metadata: { available: false },
              output: JSON.stringify({ available: false, reason: "run not found or does not belong to this task" }, null, 2),
            }
          }
          runStatus = row.status
        } else {
          const latest = Database.use((d) =>
            d.select({ id: ResearchRunTable.id, status: ResearchRunTable.status })
              .from(ResearchRunTable)
              .where(eq(ResearchRunTable.task_id, taskID))
              .orderBy(desc(ResearchRunTable.time_created))
              .limit(1).get(),
          )
          if (latest) {
            runID = latest.id
            runStatus = latest.status
          }
        }

        if (!runID) {
          return {
            title: "read_training_curve",
            metadata: { available: false },
            output: JSON.stringify({ available: false }, null, 2),
          }
        }

        const artifact = Database.use((d) =>
          d
            .select({ uri: ResearchArtifactTable.uri })
            .from(ResearchArtifactTable)
            .where(
              and(
                eq(ResearchArtifactTable.task_id, taskID),
                eq(ResearchArtifactTable.run_id, runID! as ResearchRunID),
                eq(ResearchArtifactTable.kind, "runner_progress_jsonl"),
              ),
            )
            .get(),
        )

        if (!artifact) {
          return {
            title: "read_training_curve",
            metadata: { available: false },
            output: JSON.stringify({ available: false, runID, runStatus }, null, 2),
          }
        }

        const filePath = artifact.uri.startsWith("file://") ? artifact.uri.slice("file://".length) : artifact.uri
        const curve = await extractTrainingCurve(filePath, maxPoints)

        return {
          title: "read_training_curve",
          metadata: { available: curve.length > 0 },
          output: JSON.stringify(
            {
              available: curve.length > 0,
              grouping: ["phase", "foldIndex", "horizon"],
              runID,
              runStatus,
              pointCount: curve.length,
              curve,
            },
            null,
            2,
          ),
        }
      }),
  }),
)

// ---------------------------------------------------------------------------
// read_memory_lessons
// ---------------------------------------------------------------------------

const ReadMemoryLessonsParameters = Schema.Struct({
  recentLimit: Schema.optional(Schema.Number).annotate({
    description: "Number of most-recent lessons to return (1–10, default: 2).",
  }),
  includeBest: Schema.optional(Schema.Boolean).annotate({
    description: "Whether to include the lesson from the run with the best primary metric (default: true). Deduplicated — excluded if already in recentLessons.",
  }),
})

type ReadMemoryLessonsArgs = Schema.Schema.Type<typeof ReadMemoryLessonsParameters>

export const ReadMemoryLessonsTool = Tool.define(
  "read_memory_lessons",
  Effect.succeed({
    description:
      "Read historical experiment memory for the current research task. Returns the most recent " +
      "lessons and, optionally, the lesson from the run that achieved the best primary metric. " +
      "Use this to avoid repeating known-failing designs and to ground new hypotheses in evidence.",
    parameters: ReadMemoryLessonsParameters,
    execute: (args: ReadMemoryLessonsArgs, ctx: Tool.Context) =>
      Effect.promise(async () => {
        const taskID = await resolveTaskIDBySessionID(ctx.sessionID)
        if (!taskID) {
          return {
            title: "read_memory_lessons",
            metadata: { totalMemories: 0 },
            output: NOT_IN_RESEARCH_SESSION,
          }
        }

        const recentLimit = Math.min(10, Math.max(1, Math.floor(args.recentLimit ?? 2)))
        const includeBest = args.includeBest !== false

        const memories = taskMemories(taskID).sort((a, b) => b.time.created - a.time.created)

        const recentLessons = memories.slice(0, recentLimit).map((m) => m.lesson)

        let bestLesson: string | undefined
        if (includeBest && memories.length > 0) {
          const taskRow = Database.use((d) =>
            d
              .select({ objective: ResearchTaskTable.objective })
              .from(ResearchTaskTable)
              .where(eq(ResearchTaskTable.id, taskID))
              .get(),
          )
          const objective = taskRow?.objective as Record<string, unknown> | null | undefined
          const direction = typeof objective?.direction === "string" ? objective.direction : "minimize"

          const recentSet = new Set(memories.slice(0, recentLimit).map((m) => m.id))
          let bestMetric: number | undefined
          let bestMemoryLesson: string | undefined

          for (const m of memories) {
            const cs = m.candidateSummary as Record<string, unknown> | null | undefined
            const mv = cs && typeof cs.bestMetric === "number" && Number.isFinite(cs.bestMetric) ? cs.bestMetric : undefined
            if (mv === undefined) continue
            if (
              bestMetric === undefined ||
              (direction === "minimize" ? mv < bestMetric : mv > bestMetric)
            ) {
              bestMetric = mv
              if (!recentSet.has(m.id)) bestMemoryLesson = m.lesson
            }
          }
          bestLesson = bestMemoryLesson
        }

        const result: Record<string, unknown> = {
          totalMemories: memories.length,
          recentLessons,
        }
        if (bestLesson !== undefined) result.bestLesson = bestLesson

        return {
          title: "read_memory_lessons",
          metadata: { totalMemories: memories.length },
          output: JSON.stringify(result, null, 2),
        }
      }),
  }),
)
