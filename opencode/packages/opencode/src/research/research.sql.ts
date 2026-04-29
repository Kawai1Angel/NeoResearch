import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "@/project/project.sql"
import { SessionTable } from "@/session/session.sql"
import { Timestamps } from "@/storage/schema.sql"
import type {
  JsonRecord,
  ResearchApprovalID,
  ResearchArtifactID,
  ResearchCandidateID,
  ResearchMemoryID,
  ResearchRunID,
  ResearchTaskID,
} from "./schema"
import type { ProjectID } from "@/project/schema"
import type { SessionID } from "@/session/schema"

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
    candidate_id: text().$type<ResearchCandidateID>().references(() => ResearchCandidateTable.id, {
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
