import { Schema } from "effect"
import z from "zod"

import { Identifier } from "@/id/id"
import { ProjectID } from "@/project/schema"
import { SessionID } from "@/session/schema"
import { zod, ZodOverride } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

export const ResearchTaskID = Schema.String.annotate({ [ZodOverride]: Identifier.schema("researchTask") }).pipe(
  Schema.brand("ResearchTaskID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("researchTask", id)),
    zod: zod(s),
  })),
)
export type ResearchTaskID = Schema.Schema.Type<typeof ResearchTaskID>

export const ResearchCandidateID = Schema.String.annotate({
  [ZodOverride]: Identifier.schema("researchCandidate"),
}).pipe(
  Schema.brand("ResearchCandidateID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("researchCandidate", id)),
    zod: zod(s),
  })),
)
export type ResearchCandidateID = Schema.Schema.Type<typeof ResearchCandidateID>

export const ResearchRunID = Schema.String.annotate({ [ZodOverride]: Identifier.schema("researchRun") }).pipe(
  Schema.brand("ResearchRunID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("researchRun", id)),
    zod: zod(s),
  })),
)
export type ResearchRunID = Schema.Schema.Type<typeof ResearchRunID>

export const ResearchArtifactID = Schema.String.annotate({ [ZodOverride]: Identifier.schema("researchArtifact") }).pipe(
  Schema.brand("ResearchArtifactID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("researchArtifact", id)),
    zod: zod(s),
  })),
)
export type ResearchArtifactID = Schema.Schema.Type<typeof ResearchArtifactID>

export const ResearchMemoryID = Schema.String.annotate({ [ZodOverride]: Identifier.schema("researchMemory") }).pipe(
  Schema.brand("ResearchMemoryID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("researchMemory", id)),
    zod: zod(s),
  })),
)
export type ResearchMemoryID = Schema.Schema.Type<typeof ResearchMemoryID>

export const ResearchApprovalID = Schema.String.annotate({ [ZodOverride]: Identifier.schema("researchApproval") }).pipe(
  Schema.brand("ResearchApprovalID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("researchApproval", id)),
    zod: zod(s),
  })),
)
export type ResearchApprovalID = Schema.Schema.Type<typeof ResearchApprovalID>

export const ResearchHypothesisID = Schema.String.annotate({
  [ZodOverride]: Identifier.schema("researchHypothesis"),
}).pipe(
  Schema.brand("ResearchHypothesisID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("researchHypothesis", id)),
    zod: zod(s),
  })),
)
export type ResearchHypothesisID = Schema.Schema.Type<typeof ResearchHypothesisID>

export const JsonRecord = Schema.Record(Schema.String, Schema.Json)
  .annotate({
    [ZodOverride]: z.record(z.string(), z.unknown()) as z.ZodType<
      Record<string, Schema.Schema.Type<typeof Schema.Json>>
    >,
    identifier: "ResearchJsonRecord",
  })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type JsonRecord = Schema.Schema.Type<typeof JsonRecord>

export const ResearchMode = Schema.Literals(["review", "autonomous"])
  .annotate({ identifier: "ResearchMode" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ResearchMode = Schema.Schema.Type<typeof ResearchMode>

export const ResearchInteractionMode = Schema.Literals(["socratic", "companion"])
  .annotate({ identifier: "ResearchInteractionMode" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ResearchInteractionMode = Schema.Schema.Type<typeof ResearchInteractionMode>

export const ResearchTaskStatus = Schema.Literals([
  "idle",
  "created",
  "intent_gathering",
  "profiling",
  "analyzing",
  "data_analysis",
  "literature",
  "hypo_planning",
  "baselining",
  "searching",
  "researching",
  "publishing",
  "paused",
  "completed",
  "failed",
])
  .annotate({ identifier: "ResearchTaskStatus" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ResearchTaskStatus = Schema.Schema.Type<typeof ResearchTaskStatus>

export const ResearchRunStage = Schema.Literals([
  "profile",
  "baseline",
  "smoke",
  "low_fidelity",
  "full",
  "ref_test",
  "blind_test",
])
  .annotate({ identifier: "ResearchRunStage" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ResearchRunStage = Schema.Schema.Type<typeof ResearchRunStage>

export const ResearchRunStatus = Schema.Literals(["queued", "running", "succeeded", "failed", "rejected", "invalid"])
  .annotate({ identifier: "ResearchRunStatus" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ResearchRunStatus = Schema.Schema.Type<typeof ResearchRunStatus>

export const CandidateRiskLevel = Schema.Literals(["low", "medium", "high"])
  .annotate({ identifier: "ResearchCandidateRiskLevel" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type CandidateRiskLevel = Schema.Schema.Type<typeof CandidateRiskLevel>

export const CandidateApprovalStatus = Schema.Literals(["pending", "approved", "auto_approved", "rejected"])
  .annotate({ identifier: "ResearchCandidateApprovalStatus" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type CandidateApprovalStatus = Schema.Schema.Type<typeof CandidateApprovalStatus>

export const CandidateGenerator = Schema.Literals(["llm", "heuristic", "mutation", "human", "optimizer"])
  .annotate({ identifier: "ResearchCandidateGenerator" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type CandidateGenerator = Schema.Schema.Type<typeof CandidateGenerator>

export const MemoryOutcome = Schema.Literals(["accepted", "rejected", "failed"])
  .annotate({ identifier: "ResearchMemoryOutcome" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type MemoryOutcome = Schema.Schema.Type<typeof MemoryOutcome>

export const ApprovalKind = Schema.Literals([
  "candidate",
  "ref_test",
  "blind_test",
  "shadow_holdout",
  "budget",
  "protocol",
  "domain_action",
])
  .annotate({ identifier: "ResearchApprovalKind" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ApprovalKind = Schema.Schema.Type<typeof ApprovalKind>

export const ApprovalStatus = Schema.Literals(["pending", "approved", "rejected"])
  .annotate({ identifier: "ResearchApprovalStatus" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ApprovalStatus = Schema.Schema.Type<typeof ApprovalStatus>

export class ResearchTime extends Schema.Class<ResearchTime>("ResearchTime")({
  created: Schema.Number,
  updated: Schema.Number,
}) {
  static readonly zod = zod(this)
}

export class ResearchTask extends Schema.Class<ResearchTask>("ResearchTask")({
  id: ResearchTaskID,
  projectID: ProjectID,
  sessionID: Schema.optional(SessionID),
  cockpitChatSessionID: Schema.optional(SessionID),
  stateRevision: Schema.optional(Schema.Number),
  title: Schema.String,
  domainID: Schema.String,
  mode: ResearchMode,
  interactionMode: Schema.optional(ResearchInteractionMode),
  status: ResearchTaskStatus,
  taskSpec: JsonRecord,
  objective: JsonRecord,
  budget: JsonRecord,
  time: ResearchTime,
}) {
  static readonly zod = zod(this)
}

export class ResearchCandidate extends Schema.Class<ResearchCandidate>("ResearchCandidate")({
  id: ResearchCandidateID,
  taskID: ResearchTaskID,
  parentCandidateID: Schema.optional(ResearchCandidateID),
  hypothesisID: Schema.optional(Schema.String),
  domainID: Schema.String,
  candidateSpec: JsonRecord,
  rationale: Schema.String,
  riskLevel: CandidateRiskLevel,
  approvalStatus: CandidateApprovalStatus,
  generatedBy: CandidateGenerator,
  time: ResearchTime,
}) {
  static readonly zod = zod(this)
}

export class ResearchRun extends Schema.Class<ResearchRun>("ResearchRun")({
  id: ResearchRunID,
  taskID: ResearchTaskID,
  candidateID: Schema.optional(ResearchCandidateID),
  stage: ResearchRunStage,
  status: ResearchRunStatus,
  metrics: JsonRecord,
  resourceUsage: JsonRecord,
  artifactRefs: Schema.Array(ResearchArtifactID),
  error: Schema.optional(Schema.String),
  time: ResearchTime,
  timeStarted: Schema.optional(Schema.Number),
  timeFinished: Schema.optional(Schema.Number),
}) {
  static readonly zod = zod(this)
}

export class ResearchArtifact extends Schema.Class<ResearchArtifact>("ResearchArtifact")({
  id: ResearchArtifactID,
  taskID: ResearchTaskID,
  runID: Schema.optional(ResearchRunID),
  kind: Schema.String,
  uri: Schema.String,
  metadata: JsonRecord,
  time: ResearchTime,
}) {
  static readonly zod = zod(this)
}

export class ResearchMemory extends Schema.Class<ResearchMemory>("ResearchMemory")({
  id: ResearchMemoryID,
  taskID: ResearchTaskID,
  domainID: Schema.String,
  fingerprintSummary: JsonRecord,
  candidateSummary: JsonRecord,
  outcome: MemoryOutcome,
  lesson: Schema.String,
  time: ResearchTime,
}) {
  static readonly zod = zod(this)
}

export class ResearchChampion extends Schema.Class<ResearchChampion>("ResearchChampion")({
  taskID: ResearchTaskID,
  candidateID: ResearchCandidateID,
  runID: ResearchRunID,
  primaryMetric: Schema.Number,
  utility: Schema.Number,
  acceptedAt: Schema.Number,
  time: ResearchTime,
}) {
  static readonly zod = zod(this)
}

export class ResearchApproval extends Schema.Class<ResearchApproval>("ResearchApproval")({
  id: ResearchApprovalID,
  taskID: ResearchTaskID,
  candidateID: Schema.optional(ResearchCandidateID),
  kind: ApprovalKind,
  status: ApprovalStatus,
  reason: Schema.String,
  replyMessage: Schema.optional(Schema.String),
  time: ResearchTime,
  timeReplied: Schema.optional(Schema.Number),
}) {
  static readonly zod = zod(this)
}

export class CreateTaskInput extends Schema.Class<CreateTaskInput>("ResearchCreateTaskInput")({
  title: Schema.String,
  domainID: Schema.String,
  mode: ResearchMode,
  interactionMode: Schema.optional(ResearchInteractionMode),
  taskSpec: JsonRecord,
  objective: JsonRecord,
  budget: JsonRecord,
  sessionID: Schema.optional(SessionID),
}) {
  static readonly zod = zod(this)
}

export class ListTaskInput extends Schema.Class<ListTaskInput>("ResearchListTaskInput")({
  domainID: Schema.optional(Schema.String),
  status: Schema.optional(ResearchTaskStatus),
  limit: Schema.optional(Schema.Number),
}) {
  static readonly zod = zod(this)
}

export class UpdateTaskStatusInput extends Schema.Class<UpdateTaskStatusInput>("ResearchUpdateTaskStatusInput")({
  taskID: ResearchTaskID,
  status: ResearchTaskStatus,
}) {
  static readonly zod = zod(this)
}

export class UpdateTaskSpecInput extends Schema.Class<UpdateTaskSpecInput>("ResearchUpdateTaskSpecInput")({
  taskID: ResearchTaskID,
  interactionMode: Schema.optional(ResearchInteractionMode),
  taskSpec: JsonRecord,
}) {
  static readonly zod = zod(this)
}

export class UpdateTaskBudgetInput extends Schema.Class<UpdateTaskBudgetInput>("ResearchUpdateTaskBudgetInput")({
  taskID: ResearchTaskID,
  budget: JsonRecord,
}) {
  static readonly zod = zod(this)
}

export class AnswerIntentInput extends Schema.Class<AnswerIntentInput>("ResearchAnswerIntentInput")({
  taskID: ResearchTaskID,
  slots: JsonRecord,
}) {
  static readonly zod = zod(this)
}

export class CreateCandidateInput extends Schema.Class<CreateCandidateInput>("ResearchCreateCandidateInput")({
  taskID: ResearchTaskID,
  parentCandidateID: Schema.optional(ResearchCandidateID),
  hypothesisID: Schema.optional(Schema.String),
  domainID: Schema.String,
  candidateSpec: JsonRecord,
  rationale: Schema.String,
  riskLevel: CandidateRiskLevel,
  approvalStatus: CandidateApprovalStatus,
  generatedBy: CandidateGenerator,
}) {
  static readonly zod = zod(this)
}

export class CreateRunInput extends Schema.Class<CreateRunInput>("ResearchCreateRunInput")({
  taskID: ResearchTaskID,
  candidateID: ResearchCandidateID,
  stage: ResearchRunStage,
  status: Schema.optional(ResearchRunStatus),
  metrics: Schema.optional(JsonRecord),
  resourceUsage: Schema.optional(JsonRecord),
  artifactRefs: Schema.optional(Schema.Array(ResearchArtifactID)),
}) {
  static readonly zod = zod(this)
}

export class UpdateRunStatusInput extends Schema.Class<UpdateRunStatusInput>("ResearchUpdateRunStatusInput")({
  runID: ResearchRunID,
  status: ResearchRunStatus,
  metrics: Schema.optional(JsonRecord),
  resourceUsage: Schema.optional(JsonRecord),
  artifactRefs: Schema.optional(Schema.Array(ResearchArtifactID)),
  error: Schema.optional(Schema.String),
}) {
  static readonly zod = zod(this)
}

export class CreateArtifactInput extends Schema.Class<CreateArtifactInput>("ResearchCreateArtifactInput")({
  taskID: ResearchTaskID,
  runID: Schema.optional(ResearchRunID),
  kind: Schema.String,
  uri: Schema.String,
  metadata: Schema.optional(JsonRecord),
}) {
  static readonly zod = zod(this)
}

export const ExportArtifactKind = Schema.Literals([
  "research_report_markdown",
  "dataset_analysis_report",
  "research_final_bundle",
  "model_export_package",
])
  .annotate({ identifier: "ResearchExportArtifactKind" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ExportArtifactKind = Schema.Schema.Type<typeof ExportArtifactKind>

export class ExportTaskArtifactInput extends Schema.Class<ExportTaskArtifactInput>("ResearchExportTaskArtifactInput")({
  taskID: ResearchTaskID,
  kind: Schema.optional(ExportArtifactKind),
  outputDir: Schema.optional(Schema.String),
}) {
  static readonly zod = zod(this)
}

export class ExportTaskArtifactResult extends Schema.Class<ExportTaskArtifactResult>(
  "ResearchExportTaskArtifactResult",
)({
  artifact: ResearchArtifact,
  path: Schema.String,
}) {
  static readonly zod = zod(this)
}

export class ProfileTaskInput extends Schema.Class<ProfileTaskInput>("ResearchProfileTaskInput")({
  taskID: ResearchTaskID,
  outputDir: Schema.optional(Schema.String),
}) {
  static readonly zod = zod(this)
}

export class ProfileTaskResult extends Schema.Class<ProfileTaskResult>("ResearchProfileTaskResult")({
  fingerprint: JsonRecord,
  run: ResearchRun,
  artifact: ResearchArtifact,
  path: Schema.String,
}) {
  static readonly zod = zod(this)
}

export class PrepareTaskDatasetInput extends Schema.Class<PrepareTaskDatasetInput>("ResearchPrepareTaskDatasetInput")({
  taskID: ResearchTaskID,
  force: Schema.optional(Schema.Boolean),
  outputDir: Schema.optional(Schema.String),
}) {
  static readonly zod = zod(this)
}

export class PrepareTaskDatasetResult extends Schema.Class<PrepareTaskDatasetResult>("ResearchPrepareTaskDatasetResult")({
  artifact: ResearchArtifact,
  path: Schema.String,
  datasetSpec: JsonRecord,
  command: JsonRecord,
}) {
  static readonly zod = zod(this)
}

export class CreateMemoryInput extends Schema.Class<CreateMemoryInput>("ResearchCreateMemoryInput")({
  taskID: ResearchTaskID,
  domainID: Schema.String,
  fingerprintSummary: JsonRecord,
  candidateSummary: JsonRecord,
  outcome: MemoryOutcome,
  lesson: Schema.String,
}) {
  static readonly zod = zod(this)
}

export class SetChampionInput extends Schema.Class<SetChampionInput>("ResearchSetChampionInput")({
  taskID: ResearchTaskID,
  candidateID: ResearchCandidateID,
  runID: ResearchRunID,
  primaryMetric: Schema.Number,
  utility: Schema.Number,
}) {
  static readonly zod = zod(this)
}

export class CreateApprovalInput extends Schema.Class<CreateApprovalInput>("ResearchCreateApprovalInput")({
  taskID: ResearchTaskID,
  candidateID: Schema.optional(ResearchCandidateID),
  kind: ApprovalKind,
  reason: Schema.String,
}) {
  static readonly zod = zod(this)
}

export class ListApprovalInput extends Schema.Class<ListApprovalInput>("ResearchListApprovalInput")({
  taskID: ResearchTaskID,
  status: Schema.optional(ApprovalStatus),
  limit: Schema.optional(Schema.Number),
}) {
  static readonly zod = zod(this)
}

export const ApprovalReplyStatus = Schema.Literals(["approved", "rejected"])
  .annotate({ identifier: "ResearchApprovalReplyStatus" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ApprovalReplyStatus = Schema.Schema.Type<typeof ApprovalReplyStatus>

export class ReplyApprovalInput extends Schema.Class<ReplyApprovalInput>("ResearchReplyApprovalInput")({
  approvalID: ResearchApprovalID,
  status: ApprovalReplyStatus,
  replyMessage: Schema.optional(Schema.String),
}) {
  static readonly zod = zod(this)
}

export const ExecutableRunStage = Schema.Literals(["baseline", "smoke", "low_fidelity", "full", "ref_test", "blind_test"])
  .annotate({ identifier: "ResearchExecutableRunStage" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ExecutableRunStage = Schema.Schema.Type<typeof ExecutableRunStage>

export class SeedBaselinesInput extends Schema.Class<SeedBaselinesInput>("ResearchSeedBaselinesInput")({
  taskID: ResearchTaskID,
}) {
  static readonly zod = zod(this)
}

export class PrepareRunInput extends Schema.Class<PrepareRunInput>("ResearchPrepareRunInput")({
  taskID: ResearchTaskID,
  candidateID: ResearchCandidateID,
  stage: Schema.optional(ExecutableRunStage),
  description: Schema.optional(Schema.String),
  seed: Schema.optional(Schema.Number),
  runnerRunID: Schema.optional(Schema.String),
}) {
  static readonly zod = zod(this)
}

export class ExecuteSeedSweepInput extends Schema.Class<ExecuteSeedSweepInput>("ResearchExecuteSeedSweepInput")({
  taskID: ResearchTaskID,
  candidateID: ResearchCandidateID,
  stage: Schema.optional(ExecutableRunStage),
  description: Schema.optional(Schema.String),
  seeds: Schema.optional(Schema.Array(Schema.Number)),
}) {
  static readonly zod = zod(this)
}

export class AutonomousIterationInput extends Schema.Class<AutonomousIterationInput>(
  "ResearchAutonomousIterationInput",
)({
  taskID: ResearchTaskID,
  stage: Schema.optional(ExecutableRunStage),
  description: Schema.optional(Schema.String),
  forceExplore: Schema.optional(Schema.Boolean),
}) {
  static readonly zod = zod(this)
}

export class AutonomousLoopInput extends Schema.Class<AutonomousLoopInput>("ResearchAutonomousLoopInput")({
  taskID: ResearchTaskID,
  executionScope: Schema.optional(Schema.Literals(["trial", "design", "finish-design"])),
  expectedDesignID: Schema.optional(Schema.NullOr(Schema.String)),
  stage: Schema.optional(ExecutableRunStage),
  description: Schema.optional(Schema.String),
  maxIterations: Schema.optional(Schema.Number),
  maxDesigns: Schema.optional(Schema.Number),
  targetMetricValue: Schema.optional(Schema.Number),
  minRelativeImprovement: Schema.optional(Schema.Number),
  maxNoImprove: Schema.optional(Schema.Number),
  timeBudgetSeconds: Schema.optional(Schema.Number),
  maxCrashStreak: Schema.optional(Schema.Number),
  explorationRate: Schema.optional(Schema.Number),
  maxTrialsPerDesign: Schema.optional(Schema.Number),
  maxNoImprovePerDesign: Schema.optional(Schema.Number),
}) {
  static readonly zod = zod(this)
}

export class VerifierAgentRunInput extends Schema.Class<VerifierAgentRunInput>("ResearchVerifierAgentRunInput")({
  taskID: ResearchTaskID,
  runID: ResearchRunID,
  outputDir: Schema.optional(Schema.String),
}) {
  static readonly zod = zod(this)
}

export class ReflectionAgentInput extends Schema.Class<ReflectionAgentInput>("ResearchReflectionAgentInput")({
  taskID: ResearchTaskID,
  designID: Schema.optional(Schema.String),
  reflectionScope: Schema.optional(Schema.Literals(["training", "architecture"])),
  trialID: Schema.optional(Schema.String),
  outputDir: Schema.optional(Schema.String),
  stoppedReason: Schema.optional(Schema.String),
  maxIterations: Schema.optional(Schema.Number),
}) {
  static readonly zod = zod(this)
}

export class RunFullPipelineInput extends Schema.Class<RunFullPipelineInput>("ResearchRunFullPipelineInput")({
  taskID: ResearchTaskID,
  stage: Schema.optional(ExecutableRunStage),
  description: Schema.optional(Schema.String),
  maxIterations: Schema.optional(Schema.Number),
  maxDesigns: Schema.optional(Schema.Number),
  targetMetricValue: Schema.optional(Schema.Number),
  minRelativeImprovement: Schema.optional(Schema.Number),
  maxNoImprove: Schema.optional(Schema.Number),
  timeBudgetSeconds: Schema.optional(Schema.Number),
  maxCrashStreak: Schema.optional(Schema.Number),
  explorationRate: Schema.optional(Schema.Number),
  maxTrialsPerDesign: Schema.optional(Schema.Number),
  maxNoImprovePerDesign: Schema.optional(Schema.Number),
  outputDir: Schema.optional(Schema.String),
  forceDatasetPreparation: Schema.optional(Schema.Boolean),
}) {
  static readonly zod = zod(this)
}
