import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { Hono } from "hono"
import { Instance } from "../../src/project/instance"
import { Research } from "../../src/research"
import { Database, eq } from "../../src/storage"
import { ResearchTaskTable, ResearchRunTable } from "../../src/research/research.sql"
import { ResearchRoutes } from "../../src/server/routes/instance/research"
import { resumeState, researchHistory } from "../../src/research/recovery"
import { createResearchOperations } from "../../src/research/operation"
import { tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"

const run = <A, E>(effect: Effect.Effect<A, E, Research.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Research.defaultLayer)))
const create = (title: string) =>
  run(
    Research.Service.use((svc) =>
      svc.createTask({
        title,
        domainID: "tsf",
        mode: "autonomous",
        taskSpec: {
          contextLength: 96,
          predictionLengths: [24],
          dataset: { loaderID: "etth1_tslib_v1", targetCols: ["OT"] },
        },
        objective: {},
        budget: { maxRuns: 2 },
      }),
    ),
  )
afterEach(resetDatabase)

test("history paginates past thirty, searches, enforces project scope and reads without execution", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const first = await create("old research")
      for (let i = 0; i < 31; i++) await create(`research ${i}`)
      const page = researchHistory(Instance.project.id, { limit: 30 })
      expect(page.items).toHaveLength(30)
      expect(page.nextCursor).toBeTruthy()
      const second = researchHistory(Instance.project.id, { limit: 30, cursor: page.nextCursor! })
      expect(second.items).toHaveLength(2)
      expect(new Set([...page.items, ...second.items].map((item) => item.id)).size).toBe(32)
      expect(researchHistory(Instance.project.id, { limit: 30, search: "old research" }).items[0].id).toBe(first.id)
      expect(resumeState("other-project", first.id)).toBeUndefined()
      const before = Database.use((db) =>
        db.select().from(ResearchTaskTable).where(eq(ResearchTaskTable.id, first.id)).get(),
      )
      expect(resumeState(Instance.project.id, first.id)?.recoveryState).toBe("resumable")
      const { ResumeStateSchema, HistoryPageSchema } = await import("../../src/research/recovery-schema")
      expect(ResumeStateSchema.safeParse(resumeState(Instance.project.id, first.id)).success).toBe(true)
      expect(HistoryPageSchema.safeParse(page).success).toBe(true)
      expect(
        Database.use((db) => db.select().from(ResearchTaskTable).where(eq(ResearchTaskTable.id, first.id)).get()),
      ).toEqual(before)
      expect(Database.use((db) => db.select().from(ResearchRunTable).all())).toHaveLength(0)
    },
  })
}, 30000)

test("two clients bind one chat and reopening reuses it", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const task = await create("chat")
      const chat = () => run(Research.Service.use((svc) => svc.ensureCockpitChat(task.id)))
      const [a, b] = await Promise.all([chat(), chat()])
      expect(a.id).toBe(b.id)
      expect((await chat()).id).toBe(a.id)
      expect(String(resumeState(Instance.project.id, task.id)?.chatSessionID)).toBe(a.id)
      const { Session } = await import("../../src/session")
      const bound = await run(Research.Service.use((svc) => svc.getTask(task.id)))
      await Effect.runPromise(
        Session.Service.use((svc) => svc.remove(bound.cockpitChatSessionID!)).pipe(
          Effect.provide(Session.defaultLayer),
        ),
      )
      expect(resumeState(Instance.project.id, task.id)?.chatSessionID).toBeNull()
      expect((await chat()).id).not.toBe(a.id)
    },
  })
})

test("durable receipt locks across owners and terminal retries never repeat work", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const task = await create("receipts")
      const a = createResearchOperations(true)
      const b = createResearchOperations(true)
      let finish!: (value: unknown) => void
      let calls = 0
      const work = () => {
        calls++
        return new Promise((resolve) => {
          finish = resolve
        })
      }
      const started = a.start(Instance.project.id, task.id, "pipeline", work, "request", "digest")
      const attached = b.start(Instance.project.id, task.id, "pipeline", work, "request", "digest")
      expect(attached.operation.id).toBe(started.operation.id)
      expect(attached.operation.recoveryRequired).toBe(true)
      expect(b.start(Instance.project.id, task.id, "pipeline", work, "request", "different").conflict).toBe(true)
      expect(b.start(Instance.project.id, task.id, "pipeline", work, "new", "digest").started).toBe(false)
      finish({ report: "saved" })
      await a.wait(Instance.project.id, task.id, started.operation.id)
      const replay = b.start(Instance.project.id, task.id, "pipeline", work, "request", "digest")
      expect(replay.operation.status).toBe("completed")
      expect(replay.operation.result).toEqual({ report: "saved" })
      expect(calls).toBe(1)
    },
  })
})

test("resume refuses stale revisions and completed tasks, and unknown old runs remain blocked", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const task = await create("blocked")
      const app = new Hono().route("/research", ResearchRoutes())
      const post = (expectedRevision: number) =>
        app.request(`/research/tasks/${task.id}/resume`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedRevision, requestKey: crypto.randomUUID() }),
        })
      expect((await post(999)).status).toBe(409)
      await run(Research.Service.use((svc) => svc.updateTaskStatus({ taskID: task.id, status: "completed" })))
      const state = resumeState(Instance.project.id, task.id)!
      expect(state.recoveryState).toBe("completed")
      expect((await post(state.revision)).status).toBe(409)
      expect((await app.request("/research/history?cursor=bad")).status).toBe(400)
      expect((await app.request("/research/history?directory=test&limit=30")).status).toBe(200)
      expect((await app.request(`/research/tasks/${task.id}/events?directory=test&after=0`)).status).toBe(200)
      Database.use((db) =>
        db
          .insert(ResearchRunTable)
          .values({
            id: Research.ResearchRunID.ascending(),
            task_id: task.id,
            stage: "full",
            status: "running",
            metrics: {},
            resource_usage: {},
            artifact_refs: [],
            time_created: 1,
            time_updated: 1,
          })
          .run(),
      )
      expect(resumeState(Instance.project.id, task.id)?.recoveryState).toBe("needs_reconciliation")
      expect((await post(resumeState(Instance.project.id, task.id)!.revision)).status).toBe(409)
    },
  })
})

test("search cycle preserves spent iterations and requires an explicit new budget", async () => {
  const { searchCycle, chargeIteration } = await import("../../src/research/cycle")
  const { createResearchCycle, researchEvents } = await import("../../src/research/recovery")
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const task = await create("budget")
      const first = searchCycle(task, [], { maxIterations: 2, timeBudgetSeconds: 60 })
      chargeIteration(first.id)
      const resumed = searchCycle(task, [], { maxIterations: 100, timeBudgetSeconds: 9999 })
      expect(resumed.policy).toEqual({ maxIterations: 2, timeBudgetSeconds: 60 })
      expect(resumed.iterations).toBe(1)
      Database.use((db) => db.insert(ResearchRunTable).values({ id: Research.ResearchRunID.ascending(), task_id: task.id, stage: "profile", status: "succeeded", metrics: {}, resource_usage: {}, artifact_refs: [] }).run())
      const state = resumeState(Instance.project.id, task.id)!
      const input = { expectedRevision: state.revision, requestKey: "new-cycle", maxRuns: 3, maxIterations: 1 }
      const next = createResearchCycle(Instance.project.id, task.id, input)
      expect(next.status).toBe(200)
      expect((await run(Research.Service.use((svc) => svc.getTask(task.id)))).budget.maxRuns).toBe(200)
      expect(createResearchCycle(Instance.project.id, task.id, input).body).toEqual(next.body)
      expect(createResearchCycle(Instance.project.id, task.id, { ...input, maxRuns: 4 }).status).toBe(409)
      expect(resumeState(Instance.project.id, task.id)?.cycleID).not.toBe(first.id)
      const events = researchEvents(task.id, 0)
      expect(events.length).toBeGreaterThan(0)
      expect(researchEvents(task.id, events.at(-1)!.sequence)).toEqual([])
    },
  })
})

test("session ownership follows ancestors and retains multiple tasks for the same root", async () => {
  const { Session } = await import("../../src/session")
  const { researchTasksForSession } = await import("../../src/research/recovery")
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const first = await create("first")
      const second = await create("second")
      Database.use((db) =>
        db
          .update(ResearchTaskTable)
          .set({ session_id: first.sessionID })
          .where(eq(ResearchTaskTable.id, second.id))
          .run(),
      )
      const child = await Effect.runPromise(
        Session.Service.use((svc) => svc.create({ parentID: first.sessionID })).pipe(
          Effect.provide(Session.defaultLayer),
        ),
      )
      const grandchild = await Effect.runPromise(
        Session.Service.use((svc) => svc.create({ parentID: child.id })).pipe(Effect.provide(Session.defaultLayer)),
      )
      expect(
        researchTasksForSession(Instance.project.id, grandchild.id)
          .map((task) => task.id)
          .sort(),
      ).toEqual([first.id, second.id].sort())
      expect(researchTasksForSession("other-project", grandchild.id)).toEqual([])
    },
  })
})
