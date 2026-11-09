import { Schema } from "effect"
import { existsSync } from "node:fs"
import path from "node:path"
import { ResearchTask, type JsonRecord } from "./schema"
import { ResearchTaskTable } from "./research.sql"
import { resolveNpmNeoCastRoot } from "./runners/neo-cast-package"

// Standalone module (no Session/service.ts dependency) so the analyze_dataset tool
// (src/tool/research-data-analysis.ts) can map a task row without importing the
// Session-wired service.ts and creating an import cycle through the tool registry.

type ResearchTaskRow = typeof ResearchTaskTable.$inferSelect

const decodeTask = Schema.decodeUnknownSync(ResearchTask)

function taskInteractionModeFromFields(mode: string, taskSpec: JsonRecord) {
  const metadata =
    taskSpec.metadata && typeof taskSpec.metadata === "object" && !Array.isArray(taskSpec.metadata)
      ? (taskSpec.metadata as Record<string, unknown>)
      : {}
  const raw = metadata.interactionMode ?? metadata.interaction_mode
  if (raw === "companion" || raw === "cognitive_companion") return "companion"
  if (raw === "socratic") return "socratic"
  return mode === "autonomous" ? "socratic" : undefined
}

export function mapTask(row: ResearchTaskRow, workspaceRoot = process.cwd()) {
  let taskSpec = row.task_spec
  if (row.domain_id === "tsf") {
    const runtime = taskSpec.runtime as JsonRecord | undefined
    const configured = runtime?.neoCastProjectRoot
    // Older Web tasks recorded the workspace as their runner even when it had no runner scripts.
    const workspacePlaceholder = configured === workspaceRoot && !existsSync(path.join(workspaceRoot, "py", "runner.py"))
    if (!configured || workspacePlaceholder) {
      const installed = resolveNpmNeoCastRoot(workspaceRoot)
      if (installed) {
        const root = [process.env.NEO_RESEARCH_NEO_CAST_ROOT, process.env.NEO_CAST_ROOT]
          .find((candidate) => candidate && existsSync(candidate)) ?? installed
        taskSpec = { ...taskSpec, runtime: { ...runtime, neoCastProjectRoot: path.resolve(root) } }
      }
    }
  }
  return decodeTask({
    id: row.id,
    projectID: row.project_id,
    sessionID: row.session_id ?? undefined,
    cockpitChatSessionID: row.cockpit_chat_session_id ?? undefined,
    stateRevision: row.state_revision,
    title: row.title,
    domainID: row.domain_id,
    mode: row.mode,
    interactionMode: taskInteractionModeFromFields(row.mode, row.task_spec),
    status: row.status,
    taskSpec,
    objective: row.objective,
    budget: row.budget,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  })
}
