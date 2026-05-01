import type { ExportTaskArtifactResult, ResearchTaskID } from "../schema"

export interface PublishAgentResult {
  readonly agent: "PublishAgent"
  readonly taskID: ResearchTaskID
  readonly artifact: ExportTaskArtifactResult["artifact"]
  readonly path: string
}

export function summarizePublishAgent(input: {
  readonly taskID: ResearchTaskID
  readonly exportResult: ExportTaskArtifactResult
}): PublishAgentResult {
  return {
    agent: "PublishAgent",
    taskID: input.taskID,
    artifact: input.exportResult.artifact,
    path: input.exportResult.path,
  }
}
