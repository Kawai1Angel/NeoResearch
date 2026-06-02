import { Schema } from "effect"
import { BusEvent } from "@/bus/bus-event"
import {
  ResearchArtifact,
  ResearchApproval,
  ResearchCandidate,
  ResearchChampion,
  JsonRecord,
  ResearchMemory,
  ResearchRun,
  ResearchTaskID,
  ResearchTask,
} from "./schema"

export class ResearchTaskChanged extends Schema.Class<ResearchTaskChanged>("ResearchTaskChanged")({
  task: ResearchTask,
}) {}

export class ResearchCandidateChanged extends Schema.Class<ResearchCandidateChanged>("ResearchCandidateChanged")({
  candidate: ResearchCandidate,
}) {}

export class ResearchRunChanged extends Schema.Class<ResearchRunChanged>("ResearchRunChanged")({
  run: ResearchRun,
}) {}

export class ResearchArtifactChanged extends Schema.Class<ResearchArtifactChanged>("ResearchArtifactChanged")({
  artifact: ResearchArtifact,
}) {}

export class ResearchMemoryChanged extends Schema.Class<ResearchMemoryChanged>("ResearchMemoryChanged")({
  memory: ResearchMemory,
}) {}

export class ResearchChampionChanged extends Schema.Class<ResearchChampionChanged>("ResearchChampionChanged")({
  champion: ResearchChampion,
}) {}

export class ResearchApprovalChanged extends Schema.Class<ResearchApprovalChanged>("ResearchApprovalChanged")({
  approval: ResearchApproval,
}) {}

export class ResearchAgentStageChanged extends Schema.Class<ResearchAgentStageChanged>("ResearchAgentStageChanged")({
  taskID: ResearchTaskID,
  agent: Schema.String,
  stage: Schema.String,
  status: Schema.Literals(["started", "completed", "failed"]),
  metadata: Schema.optional(JsonRecord),
}) {}

export class ResearchAgentStreamDelta extends Schema.Class<ResearchAgentStreamDelta>("ResearchAgentStreamDelta")({
  taskID: ResearchTaskID,
  agent: Schema.String,
  delta: Schema.String,
}) {}

export class ResearchRunnerProgressLine extends Schema.Class<ResearchRunnerProgressLine>("ResearchRunnerProgressLine")({
  taskID: ResearchTaskID,
  runID: Schema.String,
  line: Schema.String,
  event: Schema.optional(Schema.String),
  epoch: Schema.optional(Schema.Number),
  horizon: Schema.optional(Schema.Number),
  valLoss: Schema.optional(Schema.Number),
  elapsedS: Schema.optional(Schema.Number),
}) {}

export const Event = {
  TaskCreated: BusEvent.define("research.task.created", ResearchTaskChanged),
  TaskUpdated: BusEvent.define("research.task.updated", ResearchTaskChanged),
  CandidateCreated: BusEvent.define("research.candidate.created", ResearchCandidateChanged),
  CandidateUpdated: BusEvent.define("research.candidate.updated", ResearchCandidateChanged),
  RunCreated: BusEvent.define("research.run.created", ResearchRunChanged),
  RunUpdated: BusEvent.define("research.run.updated", ResearchRunChanged),
  ArtifactCreated: BusEvent.define("research.artifact.created", ResearchArtifactChanged),
  MemoryCreated: BusEvent.define("research.memory.created", ResearchMemoryChanged),
  ChampionUpdated: BusEvent.define("research.champion.updated", ResearchChampionChanged),
  ApprovalCreated: BusEvent.define("research.approval.created", ResearchApprovalChanged),
  ApprovalUpdated: BusEvent.define("research.approval.updated", ResearchApprovalChanged),
  RunnerProgressLine: BusEvent.define("research.runner.progress.line", ResearchRunnerProgressLine),
  IntentAgentStarted: BusEvent.define("research.agent.intent.started", ResearchAgentStageChanged),
  IntentAgentCompleted: BusEvent.define("research.agent.intent.completed", ResearchAgentStageChanged),
  IntentAgentFailed: BusEvent.define("research.agent.intent.failed", ResearchAgentStageChanged),
  DataAnalysisAgentStarted: BusEvent.define("research.agent.dataAnalysis.started", ResearchAgentStageChanged),
  DataAnalysisAgentStreamDelta: BusEvent.define("research.agent.dataAnalysis.stream.delta", ResearchAgentStreamDelta),
  DataAnalysisAgentCompleted: BusEvent.define("research.agent.dataAnalysis.completed", ResearchAgentStageChanged),
  DataAnalysisAgentFailed: BusEvent.define("research.agent.dataAnalysis.failed", ResearchAgentStageChanged),
  HypoPlannerAgentStarted: BusEvent.define("research.agent.hypoPlanner.started", ResearchAgentStageChanged),
  HypoPlannerAgentStreamDelta: BusEvent.define("research.agent.hypoPlanner.stream.delta", ResearchAgentStreamDelta),
  HypoPlannerAgentCompleted: BusEvent.define("research.agent.hypoPlanner.completed", ResearchAgentStageChanged),
  HypoPlannerAgentFailed: BusEvent.define("research.agent.hypoPlanner.failed", ResearchAgentStageChanged),
  NASAgentStarted: BusEvent.define("research.agent.nas.started", ResearchAgentStageChanged),
  NASIterationCompleted: BusEvent.define("research.agent.nas.iteration.completed", ResearchAgentStageChanged),
  NASAgentCompleted: BusEvent.define("research.agent.nas.completed", ResearchAgentStageChanged),
  NASAgentFailed: BusEvent.define("research.agent.nas.failed", ResearchAgentStageChanged),
  PublishAgentStarted: BusEvent.define("research.agent.publish.started", ResearchAgentStageChanged),
  PublishAgentCompleted: BusEvent.define("research.agent.publish.completed", ResearchAgentStageChanged),
  PublishAgentFailed: BusEvent.define("research.agent.publish.failed", ResearchAgentStageChanged),
  ReflectionAgentStarted: BusEvent.define("research.agent.reflection.started", ResearchAgentStageChanged),
  ReflectionAgentCompleted: BusEvent.define("research.agent.reflection.completed", ResearchAgentStageChanged),
  ReflectionAgentFailed: BusEvent.define("research.agent.reflection.failed", ResearchAgentStageChanged),
  RunVerified: BusEvent.define("research.run.verified", ResearchAgentStageChanged),
  RunRejectedByVerifier: BusEvent.define("research.run.rejected_by_verifier", ResearchAgentStageChanged),
  ModelDesignerCompleted: BusEvent.define("research.agent.modelDesigner.completed", ResearchAgentStageChanged),
}
