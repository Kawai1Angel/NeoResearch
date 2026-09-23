import { appendFileSync } from "node:fs"
import { Database } from "../../src/storage"
import { ProjectTable } from "../../src/project/project.sql"
import { ProjectID } from "../../src/project/schema"
import { ResearchTaskTable } from "../../src/research/research.sql"
import { ResearchTaskID } from "../../src/research/schema"
import { createResearchOperations } from "../../src/research/operation"

const project = "restart-test" as ProjectID
const task = "rtsk_restart" as ResearchTaskID
Database.use((db) => {
  db.insert(ProjectTable).values({ id: project, worktree: process.cwd(), sandboxes: [] }).onConflictDoNothing().run()
  db.insert(ResearchTaskTable)
    .values({
      id: task,
      project_id: project,
      title: "restart",
      domain_id: "tsf",
      mode: "autonomous",
      status: "paused",
      task_spec: {},
      objective: {},
      budget: {},
    })
    .onConflictDoNothing()
    .run()
})
const operations = createResearchOperations(true)
const mode = process.argv[2]
const operation = operations.start(
  project,
  task,
  "pipeline",
  async () => {
    appendFileSync(process.env.RESEARCH_CALLS!, "called\n")
    if (mode === "running") await new Promise(() => {})
    return { report: "saved" }
  },
  "stable-request",
  "request-content",
)
if (mode === "completed") await operations.wait(project, task, operation.operation.id)
console.log(
  JSON.stringify({
    ...operations.get(project, task, operation.operation.id),
    reconciled: mode === "reconcile" ? operations.reconcile(project, task, true) : false,
  }),
)
if (mode === "running") setInterval(() => {}, 1000)
else Database.close()
