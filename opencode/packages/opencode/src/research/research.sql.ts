import { index, uniqueIndex, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "@/project/project.sql"
import { SessionTable } from "@/session/session.sql"
import { Timestamps } from "@/storage/schema.sql"
import type {
  JsonRecord,
  ResearchApprovalID,
  ResearchArtifactID,
  ResearchCandidateID,
  ResearchHypothesisID,
  ResearchMemoryID,
  ResearchMemory,
  ResearchRunID,
  ResearchTaskID,
} from "./schema"
import type { ProjectID } from "@/project/schema"
import type { SessionID } from "@/session/schema"
import type { TaskEvidenceRole } from "./retrieve/contract"

export const ResearchTaskTable = sqliteTable(
  "research_task",
  {
    id: text().$type<ResearchTaskID>().primaryKey(),
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    session_id: text()
      .$type<SessionID>()
      .references(() => SessionTable.id, { onDelete: "set null" }),
    cockpit_chat_session_id: text()
      .$type<SessionID>()
      .references(() => SessionTable.id, { onDelete: "set null" }),
    state_revision: integer().notNull().default(0),
    title: text().notNull(),
    domain_id: text().notNull(),
    mode: text().notNull(),
    status: text().notNull(),
    task_spec: text({ mode: "json" }).notNull().$type<JsonRecord>(),
    objective: text({ mode: "json" }).notNull().$type<JsonRecord>(),
    budget: text({ mode: "json" }).notNull().$type<JsonRecord>(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("research_task_chat_idx").on(table.cockpit_chat_session_id),
    index("research_task_project_idx").on(table.project_id),
    index("research_task_domain_idx").on(table.domain_id),
    index("research_task_status_idx").on(table.status),
  ],
)

export const ResearchCandidateTable = sqliteTable(
  "research_candidate",
  {
    id: text().$type<ResearchCandidateID>().primaryKey(),
    task_id: text()
      .$type<ResearchTaskID>()
      .notNull()
      .references(() => ResearchTaskTable.id, { onDelete: "cascade" }),
    hypothesis_id: text(),
    parent_candidate_id: text().$type<ResearchCandidateID>(),
    domain_id: text().notNull(),
    candidate_spec: text({ mode: "json" }).notNull().$type<JsonRecord>(),
    rationale: text().notNull(),
    risk_level: text().notNull(),
    approval_status: text().notNull(),
    generated_by: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("research_candidate_task_idx").on(table.task_id),
    index("research_candidate_parent_idx").on(table.parent_candidate_id),
    index("research_candidate_approval_idx").on(table.approval_status),
  ],
)

export const ResearchRunTable = sqliteTable(
  "research_run",
  {
    id: text().$type<ResearchRunID>().primaryKey(),
    task_id: text()
      .$type<ResearchTaskID>()
      .notNull()
      .references(() => ResearchTaskTable.id, { onDelete: "cascade" }),
    candidate_id: text()
      .$type<ResearchCandidateID>()
      .references(() => ResearchCandidateTable.id, {
        onDelete: "cascade",
      }),
    stage: text().notNull(),
    status: text().notNull(),
    metrics: text({ mode: "json" }).notNull().$type<JsonRecord>(),
    resource_usage: text({ mode: "json" }).notNull().$type<JsonRecord>(),
    artifact_refs: text({ mode: "json" }).notNull().$type<ResearchArtifactID[]>(),
    error: text(),
    ...Timestamps,
    time_started: integer(),
    time_finished: integer(),
  },
  (table) => [
    index("research_run_task_idx").on(table.task_id),
    index("research_run_candidate_idx").on(table.candidate_id),
    index("research_run_status_idx").on(table.status),
  ],
)

export const ResearchArtifactTable = sqliteTable(
  "research_artifact",
  {
    id: text().$type<ResearchArtifactID>().primaryKey(),
    task_id: text()
      .$type<ResearchTaskID>()
      .notNull()
      .references(() => ResearchTaskTable.id, { onDelete: "cascade" }),
    run_id: text()
      .$type<ResearchRunID>()
      .references(() => ResearchRunTable.id, { onDelete: "set null" }),
    kind: text().notNull(),
    uri: text().notNull(),
    metadata: text({ mode: "json" }).notNull().$type<JsonRecord>(),
    ...Timestamps,
  },
  (table) => [
    index("research_artifact_task_idx").on(table.task_id),
    index("research_artifact_run_idx").on(table.run_id),
  ],
)

export const ResearchMemoryTable = sqliteTable(
  "research_memory",
  {
    id: text().$type<ResearchMemoryID>().primaryKey(),
    task_id: text()
      .$type<ResearchTaskID>()
      .notNull()
      .references(() => ResearchTaskTable.id, { onDelete: "cascade" }),
    domain_id: text().notNull(),
    fingerprint_summary: text({ mode: "json" }).notNull().$type<JsonRecord>(),
    candidate_summary: text({ mode: "json" }).notNull().$type<JsonRecord>(),
    outcome: text().notNull(),
    lesson: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("research_memory_task_idx").on(table.task_id),
    index("research_memory_domain_idx").on(table.domain_id),
  ],
)

export const ResearchApprovalTable = sqliteTable(
  "research_approval",
  {
    id: text().$type<ResearchApprovalID>().primaryKey(),
    task_id: text()
      .$type<ResearchTaskID>()
      .notNull()
      .references(() => ResearchTaskTable.id, { onDelete: "cascade" }),
    candidate_id: text()
      .$type<ResearchCandidateID>()
      .references(() => ResearchCandidateTable.id, { onDelete: "set null" }),
    kind: text().notNull(),
    status: text().notNull(),
    reason: text().notNull(),
    reply_message: text(),
    ...Timestamps,
    time_replied: integer(),
  },
  (table) => [
    index("research_approval_task_idx").on(table.task_id),
    index("research_approval_status_idx").on(table.status),
  ],
)

export const ResearchHypothesisTable = sqliteTable(
  "research_hypothesis",
  {
    id: text().$type<ResearchHypothesisID>().primaryKey(),
    task_id: text()
      .$type<ResearchTaskID>()
      .notNull()
      .references(() => ResearchTaskTable.id, { onDelete: "cascade" }),
    hypo_id: text().notNull(),
    statement: text().notNull(),
    motivation: text({ mode: "json" }).notNull().$type<string[]>(),
    expected_outcome: text().notNull(),
    suggested_backbones: text({ mode: "json" }).notNull().$type<string[]>(),
    suggested_preprocessing: text({ mode: "json" }).notNull().$type<string[]>(),
    priority: text().notNull(),
    risk: text().notNull(),
    testable: integer({ mode: "boolean" }).notNull(),
    dataset_evidence_paths: text({ mode: "json" }).notNull().default([]).$type<string[]>(),
    literature_evidence: text({ mode: "json" }).notNull().default([]).$type<
      Array<{
        cardID: string
        cardRevision: number
        role: TaskEvidenceRole
      }>
    >(),
    applicability_assumptions: text({ mode: "json" }).notNull().default([]).$type<string[]>(),
    falsification_criteria: text({ mode: "json" }).notNull().default([]).$type<string[]>(),
    experiment_contract: text({ mode: "json" }).$type<import("./experiment-constraints").ExperimentConstraints>(),
    required_mechanisms: text({ mode: "json" }).notNull().default([]).$type<import("./model-capabilities").ModelMechanism[]>(),
    evidence_level: text().notNull().default("data_only"),
    // pending | active | testing | confirmed | rejected | abandoned
    status: text().notNull().default("pending"),
    abandon_reason: text(),
    abandoned_at: integer(),
    ...Timestamps,
  },
  (table) => [
    index("research_hypothesis_task_idx").on(table.task_id),
    index("research_hypothesis_status_idx").on(table.status),
  ],
)

export const ResearchChampionTable = sqliteTable("research_champion", {
  task_id: text()
    .$type<ResearchTaskID>()
    .primaryKey()
    .references(() => ResearchTaskTable.id, { onDelete: "cascade" }),
  candidate_id: text()
    .$type<ResearchCandidateID>()
    .notNull()
    .references(() => ResearchCandidateTable.id, { onDelete: "cascade" }),
  run_id: text()
    .$type<ResearchRunID>()
    .notNull()
    .references(() => ResearchRunTable.id, { onDelete: "cascade" }),
  primary_metric: real().notNull(),
  utility: real().notNull(),
  accepted_at: integer().notNull(),
  ...Timestamps,
})

// Durable receipts survive HTTP disconnects and service restarts. Active receipts
// remain locked until the owner finishes; an expired heartbeat is not proof that
// its external runner has exited.
export const ResearchOperationTable = sqliteTable(
  "research_operation",
  {
    id: text().primaryKey(),
    project_id: text().notNull(),
    task_id: text()
      .notNull()
      .references(() => ResearchTaskTable.id, { onDelete: "cascade" }),
    request_key: text(),
    request_digest: text().notNull(),
    active_task: text().unique(),
    active_workspace: text().unique(),
    owner_id: text().notNull(),
    heartbeat_at: integer().notNull(),
    receipt: text({ mode: "json" }).notNull().$type<import("./operation").ResearchOperation>(),
  },
  (table) => [uniqueIndex("research_operation_request_idx").on(table.task_id, table.request_key)],
)

export const ResearchCycleTable = sqliteTable("research_cycle", {
  id: text().primaryKey(),
  request_key: text().unique(),
  request_digest: text(),
  task_id: text()
    .notNull()
    .references(() => ResearchTaskTable.id, { onDelete: "cascade" }),
  active_task: text().unique(),
  policy: text({ mode: "json" }).notNull().$type<Record<string, number | undefined>>(),
  iterations: integer().notNull().default(0),
  crash_streak: integer().notNull().default(0),
  elapsed_ms: integer().notNull().default(0),
  deadline_at: integer(),
  input_digest: text().notNull(),
})

export const ResearchEventTable = sqliteTable("research_event", {
  sequence: integer().primaryKey({ autoIncrement: true }),
  task_id: text()
    .notNull()
    .references(() => ResearchTaskTable.id, { onDelete: "cascade" }),
  kind: text().notNull(),
  summary: text().notNull(),
  time: integer().notNull(),
})

export const ResearchPhaseExecutionTable = sqliteTable("research_phase_execution", {
  id: text().primaryKey(),
  task_id: text()
    .notNull()
    .references(() => ResearchTaskTable.id, { onDelete: "cascade" }),
  cycle_id: text(),
  phase: text().notNull(),
  step_key: text().notNull(),
  input_digest: text().notNull(),
  implementation_version: text().notNull(),
  output_artifact_ids: text({ mode: "json" }).notNull().$type<string[]>(),
  status: text().notNull(),
  time_finished: integer().notNull(),
})

export const ResearchRunnerLockTable = sqliteTable("research_runner_lock", {
  workspace: text().primaryKey(),
  run_id: text()
    .notNull()
    .references(() => ResearchRunTable.id, { onDelete: "cascade" }),
})

export const ResearchDesignTable = sqliteTable("research_design", {
  id: text().primaryKey(),
  task_id: text().$type<ResearchTaskID>().notNull().references(() => ResearchTaskTable.id, { onDelete: "cascade" }),
  cycle_id: text().notNull().references(() => ResearchCycleTable.id, { onDelete: "cascade" }),
  hypothesis_id: text(),
  active_task: text().unique(),
  design_digest: text().notNull(),
  recipe: text({ mode: "json" }).notNull().$type<JsonRecord>(),
  outer_contract: text({ mode: "json" }).$type<import("./experiment-constraints").ExperimentConstraints>(),
  reference: integer({ mode: "boolean" }).notNull().default(false),
  status: text().notNull().default("optimizing"),
  stop_reason: text(),
  best_run_id: text().$type<ResearchRunID>(),
  best_metric: real(),
  no_improve: integer().notNull().default(0),
  phase_receipts: text({ mode: "json" }).notNull().default({}).$type<Record<string, JsonRecord>>(),
  ...Timestamps,
}, (table) => [index("research_design_cycle_idx").on(table.cycle_id)])

export const ResearchTrainingTrialTable = sqliteTable("research_training_trial", {
  id: text().primaryKey(),
  design_id: text().notNull().references(() => ResearchDesignTable.id, { onDelete: "cascade" }),
  trial_index: integer().notNull(),
  candidate_id: text().$type<ResearchCandidateID>().notNull().unique().references(() => ResearchCandidateTable.id, { onDelete: "cascade" }),
  contract: text({ mode: "json" }).$type<import("./experiment-constraints").ExperimentConstraints>(),
  repair_run_id: text().$type<ResearchRunID>(),
  smoke_run_id: text().$type<ResearchRunID>(),
  full_run_id: text().$type<ResearchRunID>(),
  charged: integer({ mode: "boolean" }).notNull().default(false),
  status: text().notNull().default("pending"),
  result: text({ mode: "json" }).$type<JsonRecord>(),
  optimizer_decision: text({ mode: "json" }).$type<JsonRecord>(),
  ...Timestamps,
}, (table) => [uniqueIndex("research_training_trial_position_idx").on(table.design_id, table.trial_index)])

export const ResearchMemoryWriteTable = sqliteTable("research_memory_write", {
  id: text().primaryKey(),
  task_id: text().$type<ResearchTaskID>().notNull().references(() => ResearchTaskTable.id, { onDelete: "cascade" }),
  binding: text({ mode: "json" }).notNull().$type<import("./experience-binding").ExperienceWriteBinding>(),
  draft: text({ mode: "json" }).notNull().$type<import("./experience").ExperienceDraft>(),
  request_digest: text().notNull(),
  library_path: text().notNull(),
  payload: text({ mode: "json" }).$type<{ memory: ResearchMemory; source: { projectID: string; projectRoot: string } }>(),
  status: text().notNull().default("pending"),
  result: text({ mode: "json" }).$type<{ sourceEntryID: string; canonicalExperienceID: string; revision: number }>(),
  error: text(),
  ...Timestamps,
}, (table) => [index("research_memory_write_task_idx").on(table.task_id, table.status)])
