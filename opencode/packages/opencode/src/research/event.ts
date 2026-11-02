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

export class ResearchLLMCallPath extends Schema.Class<ResearchLLMCallPath>("ResearchLLMCallPath")({
  taskID: ResearchTaskID,
  agent: Schema.String,
  path: Schema.Literals(["session", "direct"]),
}) {}

export class ResearchHypothesisChanged extends Schema.Class<ResearchHypothesisChanged>("ResearchHypothesisChanged")({
  taskID: ResearchTaskID,
  action: Schema.Literals(["add", "update", "abandon"]),
  hypoID: Schema.String,
  snapshot: JsonRecord,
}) {}

export class ResearchAgentPartUpdated extends Schema.Class<ResearchAgentPartUpdated>("ResearchAgentPartUpdated")({
  taskID: ResearchTaskID,
  agent: Schema.String,
  partID: Schema.String,
  kind: Schema.Literals(["text", "tool"]),
  text: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  toolInput: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  toolOutput: Schema.optional(Schema.String),
  toolState: Schema.optional(Schema.Literals(["pending", "running", "completed", "error"])),
  toolDurationMs: Schema.optional(Schema.Number),
  toolError: Schema.optional(Schema.String),
}) {}

export class ResearchCheckpointAutoApproved extends Schema.Class<ResearchCheckpointAutoApproved>("ResearchCheckpointAutoApproved")({
  taskID: ResearchTaskID,
  phase: Schema.String,
  reason: Schema.String,
}) {}

export class ResearchIntentAwaitingUser extends Schema.Class<ResearchIntentAwaitingUser>("ResearchIntentAwaitingUser")({
  taskID: ResearchTaskID,
  questions: Schema.Array(Schema.String),
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
  foldIndex: Schema.optional(Schema.Number),
}) {}

export const Event = {
  TaskCreated: BusEvent.define("research.task.created", ResearchTaskChanged),
  TaskUpdated: BusEvent.define("research.task.updated", ResearchTaskChanged),
  CandidateCreated: BusEvent.define("research.candidate.created", ResearchCandidateChanged),
  CandidateUpdated: BusEvent.define("research.candidate.updated", ResearchCandidateChanged),
  ExecutionContractViolation: BusEvent.define("research.execution_contract.violation", ResearchAgentStageChanged),
  ExecutionContractVerified: BusEvent.define("research.execution_contract.verified", ResearchAgentStageChanged),
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
  IntentAgentAwaitingUser: BusEvent.define("research.agent.intent.awaiting_user", ResearchIntentAwaitingUser),
  IntentAgentStreamDelta: BusEvent.define("research.agent.intent.stream.delta", ResearchAgentStreamDelta),
  IntentAgentPartUpdated: BusEvent.define("research.agent.intent.part.updated", ResearchAgentPartUpdated),
  DataAnalysisAgentStarted: BusEvent.define("research.agent.dataAnalysis.started", ResearchAgentStageChanged),
  DataAnalysisAgentStreamDelta: BusEvent.define("research.agent.dataAnalysis.stream.delta", ResearchAgentStreamDelta),
  DataAnalysisAgentPartUpdated: BusEvent.define("research.agent.dataAnalysis.part.updated", ResearchAgentPartUpdated),
  DataAnalysisAgentCompleted: BusEvent.define("research.agent.dataAnalysis.completed", ResearchAgentStageChanged),
  DataAnalysisAgentFailed: BusEvent.define("research.agent.dataAnalysis.failed", ResearchAgentStageChanged),
  LiteratureAgentStarted: BusEvent.define("research.agent.literature.started", ResearchAgentStageChanged),
  LiteratureAgentProgress: BusEvent.define("research.agent.literature.progress", Schema.Struct({
    taskID: ResearchTaskID, agent: Schema.String, runID: Schema.String, sessionID: Schema.optional(Schema.String),
    step: Schema.Literals(["prepare_intents", "search", "select", "parse", "extract", "verify", "assemble_evidence", "recall_architecture", "distill_architecture", "review_architecture"]),
    status: Schema.String, paperID: Schema.optional(Schema.String), cached: Schema.optional(Schema.Boolean),
    counts: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  })),
  LiteratureAgentStreamDelta: BusEvent.define("research.agent.literature.stream.delta", ResearchAgentStreamDelta),
  LiteratureAgentPartUpdated: BusEvent.define("research.agent.literature.part.updated", ResearchAgentPartUpdated),
  LiteratureAgentCompleted: BusEvent.define("research.agent.literature.completed", ResearchAgentStageChanged),
  LiteratureAgentFailed: BusEvent.define("research.agent.literature.failed", ResearchAgentStageChanged),
  RetrieveAgentStarted: BusEvent.define("research.agent.retrieve.started", ResearchAgentStageChanged),
  RetrieveAgentCompleted: BusEvent.define("research.agent.retrieve.completed", ResearchAgentStageChanged),
  RetrieveAgentFailed: BusEvent.define("research.agent.retrieve.failed", ResearchAgentStageChanged),
  HypoPlannerAgentStarted: BusEvent.define("research.agent.hypoPlanner.started", ResearchAgentStageChanged),
  HypoPlannerAgentStreamDelta: BusEvent.define("research.agent.hypoPlanner.stream.delta", ResearchAgentStreamDelta),
  HypoPlannerAgentPartUpdated: BusEvent.define("research.agent.hypoPlanner.part.updated", ResearchAgentPartUpdated),
  HypoPlannerAgentCompleted: BusEvent.define("research.agent.hypoPlanner.completed", ResearchAgentStageChanged),
  HypoPlannerAgentFailed: BusEvent.define("research.agent.hypoPlanner.failed", ResearchAgentStageChanged),
  NASAgentStarted: BusEvent.define("research.agent.nas.started", ResearchAgentStageChanged),
  OptimizerAgentStarted: BusEvent.define("research.agent.optimizer.started", ResearchAgentStageChanged),
  OptimizerAgentCompleted: BusEvent.define("research.agent.optimizer.completed", ResearchAgentStageChanged),
  OptimizerAgentFailed: BusEvent.define("research.agent.optimizer.failed", ResearchAgentStageChanged),
  NASIterationCompleted: BusEvent.define("research.agent.nas.iteration.completed", ResearchAgentStageChanged),
  NASAgentCompleted: BusEvent.define("research.agent.nas.completed", ResearchAgentStageChanged),
  NASAgentFailed: BusEvent.define("research.agent.nas.failed", ResearchAgentStageChanged),
  PublishAgentStarted: BusEvent.define("research.agent.publish.started", ResearchAgentStageChanged),
  PublishAgentCompleted: BusEvent.define("research.agent.publish.completed", ResearchAgentStageChanged),
  PublishAgentFailed: BusEvent.define("research.agent.publish.failed", ResearchAgentStageChanged),
  ReflectionAgentStarted: BusEvent.define("research.agent.reflection.started", ResearchAgentStageChanged),
  ReflectionAgentStreamDelta: BusEvent.define("research.agent.reflection.stream.delta", ResearchAgentStreamDelta),
  ReflectionAgentPartUpdated: BusEvent.define("research.agent.reflection.part.updated", ResearchAgentPartUpdated),
  ReflectionAgentCompleted: BusEvent.define("research.agent.reflection.completed", ResearchAgentStageChanged),
  ReflectionAgentFailed: BusEvent.define("research.agent.reflection.failed", ResearchAgentStageChanged),
  RunVerified: BusEvent.define("research.run.verified", ResearchAgentStageChanged),
  RunRejectedByVerifier: BusEvent.define("research.run.rejected_by_verifier", ResearchAgentStageChanged),
  ModelDesignerCompleted: BusEvent.define("research.agent.modelDesigner.completed", ResearchAgentStageChanged),
  CheckpointAutoApproved: BusEvent.define("research.checkpoint.auto_approved", ResearchCheckpointAutoApproved),
  LLMCallPath: BusEvent.define("research.agent.llm.call_path", ResearchLLMCallPath),
  HypoPlannerAgentHypothesisChanged: BusEvent.define(
    "research.agent.hypoPlanner.hypothesis.changed",
    ResearchHypothesisChanged,
  ),
}
