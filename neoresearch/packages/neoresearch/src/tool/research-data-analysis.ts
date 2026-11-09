import { Instance } from "@/project/instance"
import { summarizeTask } from "@/research/domain-registry"
import { taskExecutionRoot } from "@/research/task-isolation"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { resolveTaskIDBySessionID } from "@/research/hypothesis-store"
import { Database, and, desc, eq } from "@/storage"
import { ResearchArtifactTable, ResearchTaskTable } from "@/research/research.sql"
import { mapTask } from "@/research/task-mapper"
import { analyzeDataset, buildDatasetAnalysisContext } from "@/research/agents/data-analysis-agent"

const NOT_IN_RESEARCH_SESSION =
  "This tool can only be used inside a research task session — could not resolve the current research task."

// ---------------------------------------------------------------------------
// analyze_dataset
// ---------------------------------------------------------------------------

export const AnalyzeDatasetTool = Tool.define(
  "analyze_dataset",
  Effect.succeed({
    description:
      "Run the deterministic quantitative analysis pipeline for the current research task's dataset: " +
      "stationarity tests (ADF/KPSS), ACF/PACF, STL-style trend/seasonal/residual decomposition, " +
      "dominant-frequency and change-point diagnostics, and the cross-variate correlation matrix. " +
      "Call this tool first to obtain authoritative numbers, then ground your qualitative reading and " +
      "Search Preferences in its output. Returns a markdown report with a metrics table and statistical " +
      "test results. Returns { available: false } if the dataset profile has not been built yet.",
    parameters: Schema.Struct({}),
    execute: (_args: Record<never, never>, ctx: Tool.Context) =>
      Effect.promise(async () => {
        const taskID = await resolveTaskIDBySessionID(ctx.sessionID)
        if (!taskID) {
          return {
            title: "analyze_dataset",
            metadata: { available: false as boolean },
            output: NOT_IN_RESEARCH_SESSION,
          }
        }

        const taskRow = Database.use((d) =>
          d.select().from(ResearchTaskTable).where(eq(ResearchTaskTable.id, taskID)).get(),
        )
        if (!taskRow) {
          return {
            title: "analyze_dataset",
            metadata: { available: false },
            output: JSON.stringify({ available: false, reason: "research task not found" }, null, 2),
          }
        }

        const profileArtifact = Database.use((d) =>
          d
            .select()
            .from(ResearchArtifactTable)
            .where(and(eq(ResearchArtifactTable.task_id, taskID), eq(ResearchArtifactTable.kind, "task_profile_json")))
            .orderBy(desc(ResearchArtifactTable.time_created))
            .limit(1)
            .get(),
        )
        if (!profileArtifact) {
          return {
            title: "analyze_dataset",
            metadata: { available: false },
            output: JSON.stringify({ available: false, reason: "dataset profile has not been built yet" }, null, 2),
          }
        }

        try {
          const task = mapTask(taskRow, Instance.directory)
          // Revalidate the data source rather than trusting a historical cached profile.
          const fingerprint = summarizeTask(task.domainID, task.taskSpec, {
            taskID: task.id, projectRoot: Instance.directory, workspaceRoot: taskExecutionRoot(task, Instance.directory),
          })
          const context = await buildDatasetAnalysisContext(task, fingerprint)
          const result = analyzeDataset({ task, fingerprint, context })

          return {
            title: "analyze_dataset",
            metadata: { available: true as boolean },
            output: result.reportMarkdown,
          }
        } catch (error) {
          return {
            title: "analyze_dataset",
            metadata: { available: false },
            output: JSON.stringify(
              { available: false, reason: error instanceof Error ? error.message : String(error) },
              null,
              2,
            ),
          }
        }
      }),
  }),
)
