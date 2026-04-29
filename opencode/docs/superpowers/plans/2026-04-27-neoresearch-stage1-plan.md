# NeoResearch Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the NeoResearch core data model, persistence layer, event contracts, and first server API surface inside the OpenCode fork.

**Architecture:** Add a focused `packages/opencode/src/research/` module that owns research schemas, SQL tables, service methods, and event payloads. Mount `/research/*` Hono routes on the existing instance server so TUI, Web, CLI, and future domain plugins share one persisted ResearchTask API while the old coding session flow remains untouched.

**Tech Stack:** TypeScript, Bun, Effect Schema/Layer, Drizzle SQLite, Hono, hono-openapi, OpenCode BusEvent, OpenCode Instance middleware.

---

## Scope

This plan implements Stage 1 only:

- Research entity schemas and ID prefixes.
- SQLite tables and migration for tasks, candidates, runs, artifacts, memory, approvals, and champions.
- `Research.Service` with create/list/get/update primitives.
- Bus events that appear on the existing `/event` stream.
- Hono routes under `/research/*`.
- Tests for schemas, persistence, service behavior, and routes.

Separate plans cover TSF domain plugin execution, review/autonomous orchestrator loops, TUI Cockpit, and Web Dashboard.

## File Map

- Modify `packages/opencode/src/id/id.ts`: add research ID prefixes.
- Create `packages/opencode/src/research/schema.ts`: canonical Effect schemas and zod adapters.
- Create `packages/opencode/src/research/research.sql.ts`: Drizzle table definitions.
- Create `packages/opencode/src/research/event.ts`: research BusEvent definitions.
- Create `packages/opencode/src/research/service.ts`: persistence service and row mappers.
- Create `packages/opencode/src/research/index.ts`: namespace exports.
- Modify `packages/opencode/src/storage/schema.ts`: export research tables for Drizzle schema discovery.
- Create `packages/opencode/migration/20260427120000_research_core/migration.sql`: SQL migration.
- Modify `packages/opencode/src/effect/app-runtime.ts`: provide `Research.defaultLayer`.
- Create `packages/opencode/src/server/routes/instance/httpapi/research.ts`: stable route path constants.
- Create `packages/opencode/src/server/routes/instance/research.ts`: Hono route handlers.
- Modify `packages/opencode/src/server/routes/instance/index.ts`: mount `ResearchRoutes`.
- Create `packages/opencode/test/research/schema.test.ts`: schema and ID tests.
- Create `packages/opencode/test/research/research-sql.test.ts`: migration/table smoke test.
- Create `packages/opencode/test/research/service.test.ts`: service integration tests.
- Create `packages/opencode/test/server/research-routes.test.ts`: server route tests.

## Local Conventions

- Run package commands from `packages/opencode`, not the repository root. Root `npm test` intentionally fails.
- Route tests should use `InstanceRoutes()` and `x-opencode-directory`, matching `test/server/httpapi-session.test.ts`.
- Persistent state should be scoped to the current `Instance.project`.
- The JSON API should use OpenCode naming style: `taskID`, `candidateID`, `runID`, `domainID`.

### Task 1: Research Schemas And IDs

**Files:**
- Modify: `packages/opencode/src/id/id.ts`
- Create: `packages/opencode/src/research/schema.ts`
- Create: `packages/opencode/src/research/index.ts`
- Test: `packages/opencode/test/research/schema.test.ts`

- [ ] **Step 1: Write the failing schema test**

Create `packages/opencode/test/research/schema.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { Research } from "../../src/research"

describe("Research schemas", () => {
  test("creates branded research ids with stable prefixes", () => {
    expect(Research.ResearchTaskID.ascending()).toStartWith("rtsk_")
    expect(Research.ResearchCandidateID.ascending()).toStartWith("rcnd_")
    expect(Research.ResearchRunID.ascending()).toStartWith("rrun_")
    expect(Research.ResearchArtifactID.ascending()).toStartWith("rart_")
    expect(Research.ResearchMemoryID.ascending()).toStartWith("rmem_")
    expect(Research.ResearchApprovalID.ascending()).toStartWith("rapr_")
  })

  test("decodes a task create input", () => {
    const parsed = Research.CreateTaskInput.zod.parse({
      title: "ETTh1 horizon 96 search",
      domainID: "tsf",
      mode: "review",
      taskSpec: { dataset: "ETTh1", horizon: 96 },
      objective: { primaryMetric: "mse", direction: "minimize" },
      budget: { maxRuns: 20, maxGpuHours: 8 },
    })

    expect(parsed).toMatchObject({
      title: "ETTh1 horizon 96 search",
      domainID: "tsf",
      mode: "review",
    })
  })

  test("rejects an invalid task mode", () => {
    expect(() =>
      Research.CreateTaskInput.zod.parse({
        title: "bad mode",
        domainID: "tsf",
        mode: "manual",
        taskSpec: {},
        objective: {},
        budget: {},
      }),
    ).toThrow()
  })
})
```

- [ ] **Step 2: Run the schema test and confirm it fails**

Run from `packages/opencode`:

```bash
bun test test/research/schema.test.ts
```

Expected: FAIL with a module resolution error for `../../src/research` or missing research ID prefixes.

- [ ] **Step 3: Add research ID prefixes**

Modify `packages/opencode/src/id/id.ts` by extending the `prefixes` object:

```ts
const prefixes = {
  event: "evt",
  session: "ses",
  message: "msg",
  permission: "per",
  question: "que",
  user: "usr",
  part: "prt",
  pty: "pty",
  tool: "tool",
  workspace: "wrk",
  entry: "ent",
  researchTask: "rtsk",
  researchCandidate: "rcnd",
  researchRun: "rrun",
  researchArtifact: "rart",
  researchMemory: "rmem",
  researchApproval: "rapr",
} as const
```

- [ ] **Step 4: Create the research schema module**

Create `packages/opencode/src/research/schema.ts`:

```ts
import { Schema } from "effect"
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

export const JsonRecord = Schema.Record(Schema.String, Schema.Json).annotate({
  identifier: "ResearchJsonRecord",
})
export type JsonRecord = Schema.Schema.Type<typeof JsonRecord>

export const ResearchMode = Schema.Literals(["review", "autonomous"])
  .annotate({ identifier: "ResearchMode" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ResearchMode = Schema.Schema.Type<typeof ResearchMode>

export const ResearchTaskStatus = Schema.Literals([
  "created",
  "profiling",
  "baselining",
  "researching",
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
])
  .annotate({ identifier: "ResearchRunStage" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ResearchRunStage = Schema.Schema.Type<typeof ResearchRunStage>

export const ResearchRunStatus = Schema.Literals(["queued", "running", "succeeded", "failed", "rejected"])
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

export const CandidateGenerator = Schema.Literals(["llm", "heuristic", "mutation", "human"])
  .annotate({ identifier: "ResearchCandidateGenerator" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type CandidateGenerator = Schema.Schema.Type<typeof CandidateGenerator>

export const MemoryOutcome = Schema.Literals(["accepted", "rejected", "failed"])
  .annotate({ identifier: "ResearchMemoryOutcome" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type MemoryOutcome = Schema.Schema.Type<typeof MemoryOutcome>

export const ApprovalKind = Schema.Literals(["candidate", "ref_test", "budget", "protocol", "domain_action"])
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
  title: Schema.String,
  domainID: Schema.String,
  mode: ResearchMode,
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
  candidateID: ResearchCandidateID,
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

export class CreateCandidateInput extends Schema.Class<CreateCandidateInput>("ResearchCreateCandidateInput")({
  taskID: ResearchTaskID,
  parentCandidateID: Schema.optional(ResearchCandidateID),
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
```

- [ ] **Step 5: Create the research namespace export**

Create `packages/opencode/src/research/index.ts`:

```ts
export * from "./schema"
export * as Research from "."
```

- [ ] **Step 6: Run the schema test and confirm it passes**

Run from `packages/opencode`:

```bash
bun test test/research/schema.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/id/id.ts src/research/schema.ts src/research/index.ts test/research/schema.test.ts
git commit -m "feat: add research schema contracts"
```

### Task 2: Research SQL Tables And Migration

**Files:**
- Create: `packages/opencode/src/research/research.sql.ts`
- Modify: `packages/opencode/src/storage/schema.ts`
- Create: `packages/opencode/migration/20260427120000_research_core/migration.sql`
- Test: `packages/opencode/test/research/research-sql.test.ts`

- [ ] **Step 1: Write the failing SQL smoke test**

Create `packages/opencode/test/research/research-sql.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "../../src/storage"
import { ResearchTaskTable } from "../../src/research/research.sql"
import { resetDatabase } from "../fixture/db"

afterEach(async () => {
  await resetDatabase()
})

describe("research sql schema", () => {
  test("research_task table is available after migrations", () => {
    const rows = Database.use((db) => db.select().from(ResearchTaskTable).all())
    expect(rows).toEqual([])
  })
})
```

- [ ] **Step 2: Run the SQL test and confirm it fails**

Run from `packages/opencode`:

```bash
bun test test/research/research-sql.test.ts
```

Expected: FAIL because `src/research/research.sql.ts` does not exist.

- [ ] **Step 3: Add Drizzle table definitions**

Create `packages/opencode/src/research/research.sql.ts`:

```ts
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
    candidate_id: text()
      .$type<ResearchCandidateID>()
      .notNull()
      .references(() => ResearchCandidateTable.id, { onDelete: "cascade" }),
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
  (table) => [index("research_artifact_task_idx").on(table.task_id), index("research_artifact_run_idx").on(table.run_id)],
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
  (table) => [index("research_memory_task_idx").on(table.task_id), index("research_memory_domain_idx").on(table.domain_id)],
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
```

- [ ] **Step 4: Export research tables from the storage schema**

Append this export to `packages/opencode/src/storage/schema.ts`:

```ts
export {
  ResearchTaskTable,
  ResearchCandidateTable,
  ResearchRunTable,
  ResearchArtifactTable,
  ResearchMemoryTable,
  ResearchApprovalTable,
  ResearchChampionTable,
} from "../research/research.sql"
```

- [ ] **Step 5: Add the SQLite migration**

Create `packages/opencode/migration/20260427120000_research_core/migration.sql`:

```sql
CREATE TABLE `research_task` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `project`(`id`) ON DELETE cascade,
  `session_id` text REFERENCES `session`(`id`) ON DELETE set null,
  `title` text NOT NULL,
  `domain_id` text NOT NULL,
  `mode` text NOT NULL,
  `status` text NOT NULL,
  `task_spec` text NOT NULL,
  `objective` text NOT NULL,
  `budget` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL
);
CREATE INDEX `research_task_project_idx` ON `research_task` (`project_id`);
CREATE INDEX `research_task_domain_idx` ON `research_task` (`domain_id`);
CREATE INDEX `research_task_status_idx` ON `research_task` (`status`);

CREATE TABLE `research_candidate` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL REFERENCES `research_task`(`id`) ON DELETE cascade,
  `parent_candidate_id` text,
  `domain_id` text NOT NULL,
  `candidate_spec` text NOT NULL,
  `rationale` text NOT NULL,
  `risk_level` text NOT NULL,
  `approval_status` text NOT NULL,
  `generated_by` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL
);
CREATE INDEX `research_candidate_task_idx` ON `research_candidate` (`task_id`);
CREATE INDEX `research_candidate_parent_idx` ON `research_candidate` (`parent_candidate_id`);
CREATE INDEX `research_candidate_approval_idx` ON `research_candidate` (`approval_status`);

CREATE TABLE `research_run` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL REFERENCES `research_task`(`id`) ON DELETE cascade,
  `candidate_id` text NOT NULL REFERENCES `research_candidate`(`id`) ON DELETE cascade,
  `stage` text NOT NULL,
  `status` text NOT NULL,
  `metrics` text NOT NULL,
  `resource_usage` text NOT NULL,
  `artifact_refs` text NOT NULL,
  `error` text,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `time_started` integer,
  `time_finished` integer
);
CREATE INDEX `research_run_task_idx` ON `research_run` (`task_id`);
CREATE INDEX `research_run_candidate_idx` ON `research_run` (`candidate_id`);
CREATE INDEX `research_run_status_idx` ON `research_run` (`status`);

CREATE TABLE `research_artifact` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL REFERENCES `research_task`(`id`) ON DELETE cascade,
  `run_id` text REFERENCES `research_run`(`id`) ON DELETE set null,
  `kind` text NOT NULL,
  `uri` text NOT NULL,
  `metadata` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL
);
CREATE INDEX `research_artifact_task_idx` ON `research_artifact` (`task_id`);
CREATE INDEX `research_artifact_run_idx` ON `research_artifact` (`run_id`);

CREATE TABLE `research_memory` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL REFERENCES `research_task`(`id`) ON DELETE cascade,
  `domain_id` text NOT NULL,
  `fingerprint_summary` text NOT NULL,
  `candidate_summary` text NOT NULL,
  `outcome` text NOT NULL,
  `lesson` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL
);
CREATE INDEX `research_memory_task_idx` ON `research_memory` (`task_id`);
CREATE INDEX `research_memory_domain_idx` ON `research_memory` (`domain_id`);

CREATE TABLE `research_approval` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL REFERENCES `research_task`(`id`) ON DELETE cascade,
  `candidate_id` text REFERENCES `research_candidate`(`id`) ON DELETE set null,
  `kind` text NOT NULL,
  `status` text NOT NULL,
  `reason` text NOT NULL,
  `reply_message` text,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `time_replied` integer
);
CREATE INDEX `research_approval_task_idx` ON `research_approval` (`task_id`);
CREATE INDEX `research_approval_status_idx` ON `research_approval` (`status`);

CREATE TABLE `research_champion` (
  `task_id` text PRIMARY KEY NOT NULL REFERENCES `research_task`(`id`) ON DELETE cascade,
  `candidate_id` text NOT NULL REFERENCES `research_candidate`(`id`) ON DELETE cascade,
  `run_id` text NOT NULL REFERENCES `research_run`(`id`) ON DELETE cascade,
  `primary_metric` real NOT NULL,
  `utility` real NOT NULL,
  `accepted_at` integer NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL
);
```

- [ ] **Step 6: Run the SQL test and confirm it passes**

Run from `packages/opencode`:

```bash
bun test test/research/research-sql.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/research/research.sql.ts src/storage/schema.ts migration/20260427120000_research_core/migration.sql test/research/research-sql.test.ts
git commit -m "feat: add research persistence schema"
```

### Task 3: Research Events And Service

**Files:**
- Create: `packages/opencode/src/research/event.ts`
- Create: `packages/opencode/src/research/service.ts`
- Modify: `packages/opencode/src/research/index.ts`
- Test: `packages/opencode/test/research/service.test.ts`

- [ ] **Step 1: Write the failing service test**

Create `packages/opencode/test/research/service.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Research } from "../../src/research"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

function runResearch<A, E>(fx: Effect.Effect<A, E, Research.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(Research.defaultLayer)))
}

afterEach(async () => {
  await resetDatabase()
})

describe("Research.Service", () => {
  test("creates task, candidate, run, champion, artifact, and memory", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "ETTh1 horizon 96",
              domainID: "tsf",
              mode: "review",
              taskSpec: { dataset: "ETTh1", horizon: 96 },
              objective: { primaryMetric: "mse", direction: "minimize" },
              budget: { maxRuns: 12 },
            }),
          ),
        )

        expect(task.id).toStartWith("rtsk_")
        expect(task.status).toBe("created")

        const listed = await runResearch(Research.Service.use((svc) => svc.listTasks({ domainID: "tsf" })))
        expect(listed.map((item) => item.id)).toContain(task.id)

        const updated = await runResearch(
          Research.Service.use((svc) => svc.updateTaskStatus({ taskID: task.id, status: "researching" })),
        )
        expect(updated.status).toBe("researching")

        const candidate = await runResearch(
          Research.Service.use((svc) =>
            svc.createCandidate({
              taskID: task.id,
              domainID: "tsf",
              candidateSpec: { preprocessing: "rev_in", backbone: "tcn" },
              rationale: "baseline modular candidate",
              riskLevel: "low",
              approvalStatus: "auto_approved",
              generatedBy: "heuristic",
            }),
          ),
        )
        expect(candidate.id).toStartWith("rcnd_")

        const run = await runResearch(
          Research.Service.use((svc) =>
            svc.createRun({
              taskID: task.id,
              candidateID: candidate.id,
              stage: "smoke",
              status: "running",
            }),
          ),
        )
        expect(run.status).toBe("running")

        const completed = await runResearch(
          Research.Service.use((svc) =>
            svc.updateRunStatus({
              runID: run.id,
              status: "succeeded",
              metrics: { mse: 0.42, mae: 0.31 },
              resourceUsage: { gpuHours: 0.1 },
            }),
          ),
        )
        expect(completed.metrics.mse).toBe(0.42)

        const artifact = await runResearch(
          Research.Service.use((svc) =>
            svc.createArtifact({
              taskID: task.id,
              runID: run.id,
              kind: "metrics",
              uri: "artifact://runs/smoke/metrics.json",
              metadata: { format: "json" },
            }),
          ),
        )
        expect(artifact.id).toStartWith("rart_")

        const champion = await runResearch(
          Research.Service.use((svc) =>
            svc.setChampion({
              taskID: task.id,
              candidateID: candidate.id,
              runID: run.id,
              primaryMetric: 0.42,
              utility: 0.58,
            }),
          ),
        )
        expect(champion.candidateID).toBe(candidate.id)

        const memory = await runResearch(
          Research.Service.use((svc) =>
            svc.createMemory({
              taskID: task.id,
              domainID: "tsf",
              fingerprintSummary: { seasonality: "daily" },
              candidateSummary: { backbone: "tcn" },
              outcome: "accepted",
              lesson: "RevIN improves this dataset family.",
            }),
          ),
        )
        expect(memory.lesson).toContain("RevIN")
      },
    })
  })
})
```

- [ ] **Step 2: Run the service test and confirm it fails**

Run from `packages/opencode`:

```bash
bun test test/research/service.test.ts
```

Expected: FAIL because `Research.Service` and `Research.defaultLayer` are not exported.

- [ ] **Step 3: Add research BusEvent contracts**

Create `packages/opencode/src/research/event.ts`:

```ts
import { Schema } from "effect"
import { BusEvent } from "@/bus/bus-event"
import {
  ResearchArtifact,
  ResearchArtifactID,
  ResearchCandidate,
  ResearchCandidateID,
  ResearchChampion,
  ResearchMemory,
  ResearchMemoryID,
  ResearchRun,
  ResearchRunID,
  ResearchTask,
  ResearchTaskID,
} from "./schema"

class TaskChanged extends Schema.Class<TaskChanged>("ResearchTaskChanged")({
  taskID: ResearchTaskID,
  task: ResearchTask,
}) {}

class CandidateChanged extends Schema.Class<CandidateChanged>("ResearchCandidateChanged")({
  taskID: ResearchTaskID,
  candidateID: ResearchCandidateID,
  candidate: ResearchCandidate,
}) {}

class RunChanged extends Schema.Class<RunChanged>("ResearchRunChanged")({
  taskID: ResearchTaskID,
  runID: ResearchRunID,
  run: ResearchRun,
}) {}

class ArtifactChanged extends Schema.Class<ArtifactChanged>("ResearchArtifactChanged")({
  taskID: ResearchTaskID,
  artifactID: ResearchArtifactID,
  artifact: ResearchArtifact,
}) {}

class MemoryChanged extends Schema.Class<MemoryChanged>("ResearchMemoryChanged")({
  taskID: ResearchTaskID,
  memoryID: ResearchMemoryID,
  memory: ResearchMemory,
}) {}

class ChampionChanged extends Schema.Class<ChampionChanged>("ResearchChampionChanged")({
  taskID: ResearchTaskID,
  champion: ResearchChampion,
}) {}

export const Event = {
  TaskCreated: BusEvent.define("research.task.created", TaskChanged),
  TaskUpdated: BusEvent.define("research.task.updated", TaskChanged),
  CandidateCreated: BusEvent.define("research.candidate.created", CandidateChanged),
  RunCreated: BusEvent.define("research.run.created", RunChanged),
  RunUpdated: BusEvent.define("research.run.updated", RunChanged),
  ArtifactCreated: BusEvent.define("research.artifact.created", ArtifactChanged),
  MemoryCreated: BusEvent.define("research.memory.created", MemoryChanged),
  ChampionUpdated: BusEvent.define("research.champion.updated", ChampionChanged),
}
```

- [ ] **Step 4: Add the service implementation**

Create `packages/opencode/src/research/service.ts`.

The file should expose this interface and these methods:

```ts
import { Context, Effect, Layer, Schema } from "effect"
import { and, desc, eq, Database, NotFoundError } from "@/storage"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import {
  ResearchArtifactTable,
  ResearchCandidateTable,
  ResearchChampionTable,
  ResearchMemoryTable,
  ResearchRunTable,
  ResearchTaskTable,
} from "./research.sql"
import {
  CreateArtifactInput,
  CreateCandidateInput,
  CreateMemoryInput,
  CreateRunInput,
  CreateTaskInput,
  ListTaskInput,
  ResearchArtifact,
  ResearchArtifactID,
  ResearchCandidate,
  ResearchCandidateID,
  ResearchChampion,
  ResearchMemory,
  ResearchMemoryID,
  ResearchRun,
  ResearchRunID,
  ResearchTask,
  ResearchTaskID,
  SetChampionInput,
  UpdateRunStatusInput,
  UpdateTaskStatusInput,
} from "./schema"
import { Event } from "./event"

const db = <T>(fn: (d: Parameters<typeof Database.use>[0] extends (trx: infer D) => any ? D : never) => T) =>
  Effect.sync(() => Database.use(fn))

function nowTime() {
  const now = Date.now()
  return { created: now, updated: now }
}

function missing(kind: string, id: string) {
  return new NotFoundError({ message: `${kind} not found: ${id}` })
}

export interface Interface {
  readonly createTask: (input: CreateTaskInput) => Effect.Effect<ResearchTask>
  readonly listTasks: (input?: ListTaskInput) => Effect.Effect<ResearchTask[]>
  readonly getTask: (taskID: ResearchTaskID) => Effect.Effect<ResearchTask>
  readonly updateTaskStatus: (input: UpdateTaskStatusInput) => Effect.Effect<ResearchTask>
  readonly createCandidate: (input: CreateCandidateInput) => Effect.Effect<ResearchCandidate>
  readonly listCandidates: (taskID: ResearchTaskID) => Effect.Effect<ResearchCandidate[]>
  readonly createRun: (input: CreateRunInput) => Effect.Effect<ResearchRun>
  readonly updateRunStatus: (input: UpdateRunStatusInput) => Effect.Effect<ResearchRun>
  readonly listRuns: (taskID: ResearchTaskID) => Effect.Effect<ResearchRun[]>
  readonly createArtifact: (input: CreateArtifactInput) => Effect.Effect<ResearchArtifact>
  readonly listArtifacts: (taskID: ResearchTaskID) => Effect.Effect<ResearchArtifact[]>
  readonly createMemory: (input: CreateMemoryInput) => Effect.Effect<ResearchMemory>
  readonly listMemory: (taskID: ResearchTaskID) => Effect.Effect<ResearchMemory[]>
  readonly setChampion: (input: SetChampionInput) => Effect.Effect<ResearchChampion>
  readonly getChampion: (taskID: ResearchTaskID) => Effect.Effect<ResearchChampion | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Research") {}

function taskFromRow(row: typeof ResearchTaskTable.$inferSelect): ResearchTask {
  return Schema.decodeUnknownSync(ResearchTask)({
    id: row.id,
    projectID: row.project_id,
    sessionID: row.session_id ?? undefined,
    title: row.title,
    domainID: row.domain_id,
    mode: row.mode,
    status: row.status,
    taskSpec: row.task_spec,
    objective: row.objective,
    budget: row.budget,
    time: { created: row.time_created, updated: row.time_updated },
  })
}

function candidateFromRow(row: typeof ResearchCandidateTable.$inferSelect): ResearchCandidate {
  return Schema.decodeUnknownSync(ResearchCandidate)({
    id: row.id,
    taskID: row.task_id,
    parentCandidateID: row.parent_candidate_id ?? undefined,
    domainID: row.domain_id,
    candidateSpec: row.candidate_spec,
    rationale: row.rationale,
    riskLevel: row.risk_level,
    approvalStatus: row.approval_status,
    generatedBy: row.generated_by,
    time: { created: row.time_created, updated: row.time_updated },
  })
}

function runFromRow(row: typeof ResearchRunTable.$inferSelect): ResearchRun {
  return Schema.decodeUnknownSync(ResearchRun)({
    id: row.id,
    taskID: row.task_id,
    candidateID: row.candidate_id,
    stage: row.stage,
    status: row.status,
    metrics: row.metrics,
    resourceUsage: row.resource_usage,
    artifactRefs: row.artifact_refs,
    error: row.error ?? undefined,
    time: { created: row.time_created, updated: row.time_updated },
    timeStarted: row.time_started ?? undefined,
    timeFinished: row.time_finished ?? undefined,
  })
}

function artifactFromRow(row: typeof ResearchArtifactTable.$inferSelect): ResearchArtifact {
  return Schema.decodeUnknownSync(ResearchArtifact)({
    id: row.id,
    taskID: row.task_id,
    runID: row.run_id ?? undefined,
    kind: row.kind,
    uri: row.uri,
    metadata: row.metadata,
    time: { created: row.time_created, updated: row.time_updated },
  })
}

function memoryFromRow(row: typeof ResearchMemoryTable.$inferSelect): ResearchMemory {
  return Schema.decodeUnknownSync(ResearchMemory)({
    id: row.id,
    taskID: row.task_id,
    domainID: row.domain_id,
    fingerprintSummary: row.fingerprint_summary,
    candidateSummary: row.candidate_summary,
    outcome: row.outcome,
    lesson: row.lesson,
    time: { created: row.time_created, updated: row.time_updated },
  })
}

function championFromRow(row: typeof ResearchChampionTable.$inferSelect): ResearchChampion {
  return Schema.decodeUnknownSync(ResearchChampion)({
    taskID: row.task_id,
    candidateID: row.candidate_id,
    runID: row.run_id,
    primaryMetric: row.primary_metric,
    utility: row.utility,
    acceptedAt: row.accepted_at,
    time: { created: row.time_created, updated: row.time_updated },
  })
}
```

Then add the `layer` in the same file:

```ts
export const layer: Layer.Layer<Service, never, Bus.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const createTask = Effect.fn("Research.createTask")(function* (input: CreateTaskInput) {
      const time = nowTime()
      const task = Schema.decodeUnknownSync(ResearchTask)({
        id: ResearchTaskID.ascending(),
        projectID: Instance.project.id,
        sessionID: input.sessionID,
        title: input.title,
        domainID: input.domainID,
        mode: input.mode,
        status: "created",
        taskSpec: input.taskSpec,
        objective: input.objective,
        budget: input.budget,
        time,
      })

      yield* db((d) =>
        d
          .insert(ResearchTaskTable)
          .values({
            id: task.id,
            project_id: task.projectID,
            session_id: task.sessionID,
            title: task.title,
            domain_id: task.domainID,
            mode: task.mode,
            status: task.status,
            task_spec: task.taskSpec,
            objective: task.objective,
            budget: task.budget,
            time_created: task.time.created,
            time_updated: task.time.updated,
          })
          .run(),
      )
      yield* bus.publish(Event.TaskCreated, { taskID: task.id, task })
      return task
    })

    const listTasks = Effect.fn("Research.listTasks")(function* (input?: ListTaskInput) {
      const conditions = [eq(ResearchTaskTable.project_id, Instance.project.id)]
      if (input?.domainID) conditions.push(eq(ResearchTaskTable.domain_id, input.domainID))
      if (input?.status) conditions.push(eq(ResearchTaskTable.status, input.status))
      const rows = yield* db((d) =>
        d
          .select()
          .from(ResearchTaskTable)
          .where(and(...conditions))
          .orderBy(desc(ResearchTaskTable.time_updated))
          .limit(input?.limit ?? 100)
          .all(),
      )
      return rows.map(taskFromRow)
    })

    const getTask = Effect.fn("Research.getTask")(function* (taskID: ResearchTaskID) {
      const row = yield* db((d) =>
        d
          .select()
          .from(ResearchTaskTable)
          .where(and(eq(ResearchTaskTable.id, taskID), eq(ResearchTaskTable.project_id, Instance.project.id)))
          .get(),
      )
      if (!row) throw missing("Research task", taskID)
      return taskFromRow(row)
    })

    const updateTaskStatus = Effect.fn("Research.updateTaskStatus")(function* (input: UpdateTaskStatusInput) {
      const row = yield* db((d) =>
        d
          .update(ResearchTaskTable)
          .set({ status: input.status, time_updated: Date.now() })
          .where(and(eq(ResearchTaskTable.id, input.taskID), eq(ResearchTaskTable.project_id, Instance.project.id)))
          .returning()
          .get(),
      )
      if (!row) throw missing("Research task", input.taskID)
      const task = taskFromRow(row)
      yield* bus.publish(Event.TaskUpdated, { taskID: task.id, task })
      return task
    })

    const createCandidate = Effect.fn("Research.createCandidate")(function* (input: CreateCandidateInput) {
      yield* getTask(input.taskID)
      const time = nowTime()
      const candidate = Schema.decodeUnknownSync(ResearchCandidate)({ id: ResearchCandidateID.ascending(), ...input, time })
      yield* db((d) =>
        d
          .insert(ResearchCandidateTable)
          .values({
            id: candidate.id,
            task_id: candidate.taskID,
            parent_candidate_id: candidate.parentCandidateID,
            domain_id: candidate.domainID,
            candidate_spec: candidate.candidateSpec,
            rationale: candidate.rationale,
            risk_level: candidate.riskLevel,
            approval_status: candidate.approvalStatus,
            generated_by: candidate.generatedBy,
            time_created: candidate.time.created,
            time_updated: candidate.time.updated,
          })
          .run(),
      )
      yield* bus.publish(Event.CandidateCreated, { taskID: candidate.taskID, candidateID: candidate.id, candidate })
      return candidate
    })

    const listCandidates = Effect.fn("Research.listCandidates")(function* (taskID: ResearchTaskID) {
      yield* getTask(taskID)
      const rows = yield* db((d) =>
        d.select().from(ResearchCandidateTable).where(eq(ResearchCandidateTable.task_id, taskID)).all(),
      )
      return rows.map(candidateFromRow)
    })

    const createRun = Effect.fn("Research.createRun")(function* (input: CreateRunInput) {
      yield* getTask(input.taskID)
      const time = nowTime()
      const status = input.status ?? "queued"
      const run = Schema.decodeUnknownSync(ResearchRun)({
        id: ResearchRunID.ascending(),
        taskID: input.taskID,
        candidateID: input.candidateID,
        stage: input.stage,
        status,
        metrics: input.metrics ?? {},
        resourceUsage: input.resourceUsage ?? {},
        artifactRefs: input.artifactRefs ?? [],
        time,
        timeStarted: status === "running" ? Date.now() : undefined,
      })
      yield* db((d) =>
        d
          .insert(ResearchRunTable)
          .values({
            id: run.id,
            task_id: run.taskID,
            candidate_id: run.candidateID,
            stage: run.stage,
            status: run.status,
            metrics: run.metrics,
            resource_usage: run.resourceUsage,
            artifact_refs: run.artifactRefs,
            error: run.error,
            time_created: run.time.created,
            time_updated: run.time.updated,
            time_started: run.timeStarted,
            time_finished: run.timeFinished,
          })
          .run(),
      )
      yield* bus.publish(Event.RunCreated, { taskID: run.taskID, runID: run.id, run })
      return run
    })

    const updateRunStatus = Effect.fn("Research.updateRunStatus")(function* (input: UpdateRunStatusInput) {
      const finished = input.status === "succeeded" || input.status === "failed" || input.status === "rejected"
      const row = yield* db((d) =>
        d
          .update(ResearchRunTable)
          .set({
            status: input.status,
            metrics: input.metrics ?? {},
            resource_usage: input.resourceUsage ?? {},
            artifact_refs: input.artifactRefs ?? [],
            error: input.error,
            time_updated: Date.now(),
            time_finished: finished ? Date.now() : undefined,
          })
          .where(eq(ResearchRunTable.id, input.runID))
          .returning()
          .get(),
      )
      if (!row) throw missing("Research run", input.runID)
      yield* getTask(row.task_id)
      const run = runFromRow(row)
      yield* bus.publish(Event.RunUpdated, { taskID: run.taskID, runID: run.id, run })
      return run
    })

    const listRuns = Effect.fn("Research.listRuns")(function* (taskID: ResearchTaskID) {
      yield* getTask(taskID)
      const rows = yield* db((d) => d.select().from(ResearchRunTable).where(eq(ResearchRunTable.task_id, taskID)).all())
      return rows.map(runFromRow)
    })

    const createArtifact = Effect.fn("Research.createArtifact")(function* (input: CreateArtifactInput) {
      yield* getTask(input.taskID)
      const time = nowTime()
      const artifact = Schema.decodeUnknownSync(ResearchArtifact)({
        id: ResearchArtifactID.ascending(),
        taskID: input.taskID,
        runID: input.runID,
        kind: input.kind,
        uri: input.uri,
        metadata: input.metadata ?? {},
        time,
      })
      yield* db((d) =>
        d
          .insert(ResearchArtifactTable)
          .values({
            id: artifact.id,
            task_id: artifact.taskID,
            run_id: artifact.runID,
            kind: artifact.kind,
            uri: artifact.uri,
            metadata: artifact.metadata,
            time_created: artifact.time.created,
            time_updated: artifact.time.updated,
          })
          .run(),
      )
      yield* bus.publish(Event.ArtifactCreated, { taskID: artifact.taskID, artifactID: artifact.id, artifact })
      return artifact
    })

    const listArtifacts = Effect.fn("Research.listArtifacts")(function* (taskID: ResearchTaskID) {
      yield* getTask(taskID)
      const rows = yield* db((d) =>
        d.select().from(ResearchArtifactTable).where(eq(ResearchArtifactTable.task_id, taskID)).all(),
      )
      return rows.map(artifactFromRow)
    })

    const createMemory = Effect.fn("Research.createMemory")(function* (input: CreateMemoryInput) {
      yield* getTask(input.taskID)
      const time = nowTime()
      const memory = Schema.decodeUnknownSync(ResearchMemory)({ id: ResearchMemoryID.ascending(), ...input, time })
      yield* db((d) =>
        d
          .insert(ResearchMemoryTable)
          .values({
            id: memory.id,
            task_id: memory.taskID,
            domain_id: memory.domainID,
            fingerprint_summary: memory.fingerprintSummary,
            candidate_summary: memory.candidateSummary,
            outcome: memory.outcome,
            lesson: memory.lesson,
            time_created: memory.time.created,
            time_updated: memory.time.updated,
          })
          .run(),
      )
      yield* bus.publish(Event.MemoryCreated, { taskID: memory.taskID, memoryID: memory.id, memory })
      return memory
    })

    const listMemory = Effect.fn("Research.listMemory")(function* (taskID: ResearchTaskID) {
      yield* getTask(taskID)
      const rows = yield* db((d) =>
        d.select().from(ResearchMemoryTable).where(eq(ResearchMemoryTable.task_id, taskID)).all(),
      )
      return rows.map(memoryFromRow)
    })

    const setChampion = Effect.fn("Research.setChampion")(function* (input: SetChampionInput) {
      yield* getTask(input.taskID)
      const time = nowTime()
      const acceptedAt = Date.now()
      const row = yield* db((d) =>
        d
          .insert(ResearchChampionTable)
          .values({
            task_id: input.taskID,
            candidate_id: input.candidateID,
            run_id: input.runID,
            primary_metric: input.primaryMetric,
            utility: input.utility,
            accepted_at: acceptedAt,
            time_created: time.created,
            time_updated: time.updated,
          })
          .onConflictDoUpdate({
            target: ResearchChampionTable.task_id,
            set: {
              candidate_id: input.candidateID,
              run_id: input.runID,
              primary_metric: input.primaryMetric,
              utility: input.utility,
              accepted_at: acceptedAt,
              time_updated: time.updated,
            },
          })
          .returning()
          .get(),
      )
      const champion = championFromRow(row)
      yield* bus.publish(Event.ChampionUpdated, { taskID: champion.taskID, champion })
      return champion
    })

    const getChampion = Effect.fn("Research.getChampion")(function* (taskID: ResearchTaskID) {
      yield* getTask(taskID)
      const row = yield* db((d) =>
        d.select().from(ResearchChampionTable).where(eq(ResearchChampionTable.task_id, taskID)).get(),
      )
      return row ? championFromRow(row) : undefined
    })

    return Service.of({
      createTask,
      listTasks,
      getTask,
      updateTaskStatus,
      createCandidate,
      listCandidates,
      createRun,
      updateRunStatus,
      listRuns,
      createArtifact,
      listArtifacts,
      createMemory,
      listMemory,
      setChampion,
      getChampion,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))
```

- [ ] **Step 5: Export service and events**

Replace `packages/opencode/src/research/index.ts` with:

```ts
export * from "./schema"
export { Event } from "./event"
export { Service, layer, defaultLayer } from "./service"
export type { Interface } from "./service"
export * as Research from "."
```

- [ ] **Step 6: Run the service test and confirm it passes**

Run from `packages/opencode`:

```bash
bun test test/research/service.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/research/event.ts src/research/service.ts src/research/index.ts test/research/service.test.ts
git commit -m "feat: add research service"
```

### Task 4: Provide Research Service In App Runtime

**Files:**
- Modify: `packages/opencode/src/effect/app-runtime.ts`
- Test: `packages/opencode/test/research/service.test.ts`

- [ ] **Step 1: Confirm service test still passes before runtime wiring**

Run from `packages/opencode`:

```bash
bun test test/research/service.test.ts
```

Expected: PASS. This confirms the service works with explicit `Research.defaultLayer`.

- [ ] **Step 2: Wire Research into `AppLayer`**

Modify `packages/opencode/src/effect/app-runtime.ts`.

Add the import near the existing service imports:

```ts
import { Research } from "@/research"
```

Add `Research.defaultLayer` to `Layer.mergeAll(...)` after `SessionShare.defaultLayer`:

```ts
  SessionShare.defaultLayer,
  Research.defaultLayer,
).pipe(Layer.provideMerge(Observability.layer))
```

- [ ] **Step 3: Run typecheck for the runtime wiring**

Run from `packages/opencode`:

```bash
bun run typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 4: Commit Task 4**

```bash
git add src/effect/app-runtime.ts
git commit -m "feat: provide research runtime layer"
```

### Task 5: Research Server Routes

**Files:**
- Create: `packages/opencode/src/server/routes/instance/httpapi/research.ts`
- Create: `packages/opencode/src/server/routes/instance/research.ts`
- Modify: `packages/opencode/src/server/routes/instance/index.ts`
- Test: `packages/opencode/test/server/research-routes.test.ts`

- [ ] **Step 1: Write the failing route test**

Create `packages/opencode/test/server/research-routes.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test"
import type { UpgradeWebSocket } from "hono/ws"
import { Instance } from "../../src/project/instance"
import { InstanceRoutes } from "../../src/server/routes/instance"
import { ResearchPaths } from "../../src/server/routes/instance/httpapi/research"
import { Research } from "../../src/research"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

const websocket = (() => () => new Response(null, { status: 501 })) as unknown as UpgradeWebSocket

function app() {
  return InstanceRoutes(websocket)
}

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

async function json<T>(response: Response) {
  if (response.status !== 200) throw new Error(await response.text())
  return (await response.json()) as T
}

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
})

describe("research routes", () => {
  test("serves task and experiment entity routes", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    const task = await json<Research.ResearchTask>(
      await app().request(ResearchPaths.tasks, {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: "ETTh1 research task",
          domainID: "tsf",
          mode: "review",
          taskSpec: { dataset: "ETTh1", horizon: 96 },
          objective: { primaryMetric: "mse", direction: "minimize" },
          budget: { maxRuns: 5 },
        }),
      }),
    )
    expect(task.id).toStartWith("rtsk_")

    const listed = await json<Research.ResearchTask[]>(
      await app().request(`${ResearchPaths.tasks}?domainID=tsf`, { headers }),
    )
    expect(listed.map((item) => item.id)).toContain(task.id)

    const updated = await json<Research.ResearchTask>(
      await app().request(pathFor(ResearchPaths.taskStatus, { taskID: task.id }), {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status: "researching" }),
      }),
    )
    expect(updated.status).toBe("researching")

    const candidate = await json<Research.ResearchCandidate>(
      await app().request(ResearchPaths.candidates, {
        method: "POST",
        headers,
        body: JSON.stringify({
          taskID: task.id,
          domainID: "tsf",
          candidateSpec: { preprocessing: "rev_in", backbone: "tcn" },
          rationale: "smoke route candidate",
          riskLevel: "low",
          approvalStatus: "auto_approved",
          generatedBy: "heuristic",
        }),
      }),
    )
    expect(candidate.taskID).toBe(task.id)

    const run = await json<Research.ResearchRun>(
      await app().request(ResearchPaths.runs, {
        method: "POST",
        headers,
        body: JSON.stringify({
          taskID: task.id,
          candidateID: candidate.id,
          stage: "smoke",
          status: "queued",
        }),
      }),
    )
    expect(run.candidateID).toBe(candidate.id)

    const champion = await json<Research.ResearchChampion>(
      await app().request(ResearchPaths.champions, {
        method: "POST",
        headers,
        body: JSON.stringify({
          taskID: task.id,
          candidateID: candidate.id,
          runID: run.id,
          primaryMetric: 0.42,
          utility: 0.58,
        }),
      }),
    )
    expect(champion.taskID).toBe(task.id)
  })
})
```

- [ ] **Step 2: Run the route test and confirm it fails**

Run from `packages/opencode`:

```bash
bun test test/server/research-routes.test.ts
```

Expected: FAIL because `ResearchPaths` and `ResearchRoutes` do not exist.

- [ ] **Step 3: Add route path constants**

Create `packages/opencode/src/server/routes/instance/httpapi/research.ts`:

```ts
const root = "/research"

export const ResearchPaths = {
  tasks: `${root}/tasks`,
  task: `${root}/tasks/:taskID`,
  taskStatus: `${root}/tasks/:taskID/status`,
  taskCandidates: `${root}/tasks/:taskID/candidates`,
  taskRuns: `${root}/tasks/:taskID/runs`,
  taskArtifacts: `${root}/tasks/:taskID/artifacts`,
  taskMemory: `${root}/tasks/:taskID/memory`,
  taskChampion: `${root}/tasks/:taskID/champion`,
  candidates: `${root}/candidates`,
  runs: `${root}/runs`,
  runStatus: `${root}/runs/:runID/status`,
  artifacts: `${root}/artifacts`,
  memory: `${root}/memory`,
  champions: `${root}/champions`,
} as const
```

- [ ] **Step 4: Add Hono route handlers**

Create `packages/opencode/src/server/routes/instance/research.ts`:

```ts
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { Research } from "@/research"
import { jsonRequest } from "./trace"

export const ResearchRoutes = lazy(() =>
  new Hono()
    .get(
      "/tasks",
      describeRoute({
        summary: "List research tasks",
        description: "List persisted NeoResearch tasks for the current project.",
        operationId: "research.task.list",
        responses: {
          200: { description: "Research tasks", content: { "application/json": { schema: resolver(Research.ResearchTask.zod.array()) } } },
          ...errors(400),
        },
      }),
      validator(
        "query",
        z.object({
          domainID: z.string().optional(),
          status: Research.ResearchTaskStatus.zod.optional(),
          limit: z.coerce.number().optional(),
        }),
      ),
      async (c) =>
        jsonRequest("ResearchRoutes.listTasks", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.listTasks(c.req.valid("query"))
        }),
    )
    .post(
      "/tasks",
      describeRoute({
        summary: "Create research task",
        description: "Create a NeoResearch task that becomes the root of runs, candidates, memory, and artifacts.",
        operationId: "research.task.create",
        responses: {
          200: { description: "Created research task", content: { "application/json": { schema: resolver(Research.ResearchTask.zod) } } },
          ...errors(400),
        },
      }),
      validator("json", Research.CreateTaskInput.zod),
      async (c) =>
        jsonRequest("ResearchRoutes.createTask", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.createTask(c.req.valid("json"))
        }),
    )
    .get(
      "/tasks/:taskID",
      describeRoute({
        summary: "Get research task",
        operationId: "research.task.get",
        responses: {
          200: { description: "Research task", content: { "application/json": { schema: resolver(Research.ResearchTask.zod) } } },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ taskID: Research.ResearchTaskID.zod })),
      async (c) =>
        jsonRequest("ResearchRoutes.getTask", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.getTask(c.req.valid("param").taskID)
        }),
    )
    .patch(
      "/tasks/:taskID/status",
      describeRoute({
        summary: "Update research task status",
        operationId: "research.task.status",
        responses: {
          200: { description: "Updated research task", content: { "application/json": { schema: resolver(Research.ResearchTask.zod) } } },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ taskID: Research.ResearchTaskID.zod })),
      validator("json", z.object({ status: Research.ResearchTaskStatus.zod })),
      async (c) =>
        jsonRequest("ResearchRoutes.updateTaskStatus", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.updateTaskStatus({ taskID: c.req.valid("param").taskID, status: c.req.valid("json").status })
        }),
    )
    .post(
      "/candidates",
      describeRoute({
        summary: "Create research candidate",
        operationId: "research.candidate.create",
        responses: {
          200: { description: "Created candidate", content: { "application/json": { schema: resolver(Research.ResearchCandidate.zod) } } },
          ...errors(400, 404),
        },
      }),
      validator("json", Research.CreateCandidateInput.zod),
      async (c) =>
        jsonRequest("ResearchRoutes.createCandidate", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.createCandidate(c.req.valid("json"))
        }),
    )
    .get(
      "/tasks/:taskID/candidates",
      describeRoute({
        summary: "List research candidates",
        operationId: "research.candidate.list",
        responses: {
          200: { description: "Candidates", content: { "application/json": { schema: resolver(Research.ResearchCandidate.zod.array()) } } },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ taskID: Research.ResearchTaskID.zod })),
      async (c) =>
        jsonRequest("ResearchRoutes.listCandidates", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.listCandidates(c.req.valid("param").taskID)
        }),
    )
    .post(
      "/runs",
      describeRoute({
        summary: "Create research run",
        operationId: "research.run.create",
        responses: {
          200: { description: "Created run", content: { "application/json": { schema: resolver(Research.ResearchRun.zod) } } },
          ...errors(400, 404),
        },
      }),
      validator("json", Research.CreateRunInput.zod),
      async (c) =>
        jsonRequest("ResearchRoutes.createRun", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.createRun(c.req.valid("json"))
        }),
    )
    .patch(
      "/runs/:runID/status",
      describeRoute({
        summary: "Update research run status",
        operationId: "research.run.status",
        responses: {
          200: { description: "Updated run", content: { "application/json": { schema: resolver(Research.ResearchRun.zod) } } },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ runID: Research.ResearchRunID.zod })),
      validator(
        "json",
        z.object({
          status: Research.ResearchRunStatus.zod,
          metrics: z.record(z.string(), z.unknown()).optional(),
          resourceUsage: z.record(z.string(), z.unknown()).optional(),
          artifactRefs: z.array(Research.ResearchArtifactID.zod).optional(),
          error: z.string().optional(),
        }),
      ),
      async (c) =>
        jsonRequest("ResearchRoutes.updateRunStatus", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.updateRunStatus({ runID: c.req.valid("param").runID, ...c.req.valid("json") })
        }),
    )
    .get(
      "/tasks/:taskID/runs",
      describeRoute({
        summary: "List research runs",
        operationId: "research.run.list",
        responses: {
          200: { description: "Runs", content: { "application/json": { schema: resolver(Research.ResearchRun.zod.array()) } } },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ taskID: Research.ResearchTaskID.zod })),
      async (c) =>
        jsonRequest("ResearchRoutes.listRuns", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.listRuns(c.req.valid("param").taskID)
        }),
    )
    .post(
      "/artifacts",
      describeRoute({
        summary: "Create research artifact",
        operationId: "research.artifact.create",
        responses: {
          200: { description: "Created artifact", content: { "application/json": { schema: resolver(Research.ResearchArtifact.zod) } } },
          ...errors(400, 404),
        },
      }),
      validator("json", Research.CreateArtifactInput.zod),
      async (c) =>
        jsonRequest("ResearchRoutes.createArtifact", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.createArtifact(c.req.valid("json"))
        }),
    )
    .get(
      "/tasks/:taskID/artifacts",
      describeRoute({
        summary: "List research artifacts",
        operationId: "research.artifact.list",
        responses: {
          200: { description: "Artifacts", content: { "application/json": { schema: resolver(Research.ResearchArtifact.zod.array()) } } },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ taskID: Research.ResearchTaskID.zod })),
      async (c) =>
        jsonRequest("ResearchRoutes.listArtifacts", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.listArtifacts(c.req.valid("param").taskID)
        }),
    )
    .post(
      "/memory",
      describeRoute({
        summary: "Create research memory",
        operationId: "research.memory.create",
        responses: {
          200: { description: "Created memory", content: { "application/json": { schema: resolver(Research.ResearchMemory.zod) } } },
          ...errors(400, 404),
        },
      }),
      validator("json", Research.CreateMemoryInput.zod),
      async (c) =>
        jsonRequest("ResearchRoutes.createMemory", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.createMemory(c.req.valid("json"))
        }),
    )
    .get(
      "/tasks/:taskID/memory",
      describeRoute({
        summary: "List research memory",
        operationId: "research.memory.list",
        responses: {
          200: { description: "Memory", content: { "application/json": { schema: resolver(Research.ResearchMemory.zod.array()) } } },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ taskID: Research.ResearchTaskID.zod })),
      async (c) =>
        jsonRequest("ResearchRoutes.listMemory", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.listMemory(c.req.valid("param").taskID)
        }),
    )
    .post(
      "/champions",
      describeRoute({
        summary: "Set research champion",
        operationId: "research.champion.set",
        responses: {
          200: { description: "Champion", content: { "application/json": { schema: resolver(Research.ResearchChampion.zod) } } },
          ...errors(400, 404),
        },
      }),
      validator("json", Research.SetChampionInput.zod),
      async (c) =>
        jsonRequest("ResearchRoutes.setChampion", c, function* () {
          const svc = yield* Research.Service
          return yield* svc.setChampion(c.req.valid("json"))
        }),
    )
    .get(
      "/tasks/:taskID/champion",
      describeRoute({
        summary: "Get research champion",
        operationId: "research.champion.get",
        responses: {
          200: { description: "Champion or null", content: { "application/json": { schema: resolver(Research.ResearchChampion.zod.nullable()) } } },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ taskID: Research.ResearchTaskID.zod })),
      async (c) =>
        jsonRequest("ResearchRoutes.getChampion", c, function* () {
          const svc = yield* Research.Service
          return (yield* svc.getChampion(c.req.valid("param").taskID)) ?? null
        }),
    ),
)
```

- [ ] **Step 5: Mount the research routes**

Modify `packages/opencode/src/server/routes/instance/index.ts`.

Add the import near the other route imports:

```ts
import { ResearchRoutes } from "./research"
```

Add the route before `.route("/session", SessionRoutes())`:

```ts
    .route("/research", ResearchRoutes())
    .route("/session", SessionRoutes())
```

- [ ] **Step 6: Run the route test and confirm it passes**

Run from `packages/opencode`:

```bash
bun test test/server/research-routes.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 5**

```bash
git add src/server/routes/instance/httpapi/research.ts src/server/routes/instance/research.ts src/server/routes/instance/index.ts test/server/research-routes.test.ts
git commit -m "feat: add research server routes"
```

### Task 6: Verification And Regression Sweep

**Files:**
- Read: `packages/opencode/src/research/*`
- Read: `packages/opencode/src/server/routes/instance/research.ts`
- Read: `packages/opencode/src/effect/app-runtime.ts`

- [ ] **Step 1: Run focused research tests**

Run from `packages/opencode`:

```bash
bun test test/research/schema.test.ts test/research/research-sql.test.ts test/research/service.test.ts test/server/research-routes.test.ts
```

Expected: PASS for all four files.

- [ ] **Step 2: Run adjacent server regression tests**

Run from `packages/opencode`:

```bash
bun test test/server/httpapi-session.test.ts test/server/httpapi-event.test.ts
```

Expected: PASS. These confirm existing session and event routes still work after adding `/research`.

- [ ] **Step 3: Run typecheck**

Run from `packages/opencode`:

```bash
bun run typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 4: Inspect route registration**

Run from repository root:

```bash
rg -n "ResearchRoutes|Research.defaultLayer|research.task.created|research_task" packages/opencode/src packages/opencode/migration
```

Expected output includes:

```text
packages/opencode/src/effect/app-runtime.ts
packages/opencode/src/research/event.ts
packages/opencode/src/research/research.sql.ts
packages/opencode/src/server/routes/instance/index.ts
packages/opencode/migration/20260427120000_research_core/migration.sql
```

- [ ] **Step 5: Confirm the branch is clean after committed tasks**

Run from repository root:

```bash
git status --short
```

Expected: no output. If output appears, inspect it before final handoff because Tasks 1-5 each include their own commit step.

## Self-Review

Spec coverage:

- ResearchTask, Candidate, ResearchRun, Champion, Artifact, and MemoryItem are represented by schemas and SQLite tables.
- Review/Autonomous modes are represented on `ResearchTask.mode`; approval enforcement is intentionally in the orchestrator plan.
- Domain plugin execution is not in this plan; `domainID`, `taskSpec`, `candidateSpec`, and JSON metadata keep the Stage 1 boundary ready for the TSF plugin.
- TUI/Web consume the same API through `/research/*`; UI rendering is intentionally in a UI plan.
- The existing OpenCode session, provider, permission, and tool registry flows are not deleted in Stage 1.

Type consistency:

- API and TypeScript names use `taskID`, `candidateID`, `runID`, and `domainID`.
- Database columns use snake case and map to schema names only through `service.ts`.
- Routes validate through the same schema module that the service returns.

Execution order:

- Task 1 creates schemas before persistence.
- Task 2 creates tables before service writes.
- Task 3 creates service behavior before AppRuntime wiring.
- Task 4 adds runtime access before route handlers.
- Task 5 exposes the API.
- Task 6 validates integration and nearby regressions.
