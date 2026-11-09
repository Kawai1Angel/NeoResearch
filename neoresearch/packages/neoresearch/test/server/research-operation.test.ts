import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { Hono } from "hono"
import { Instance } from "../../src/project/instance"
import { Research } from "../../src/research"
import { ResearchRoutes } from "../../src/server/routes/instance/research"
import { jsonRequest } from "../../src/server/routes/instance/trace"
import { ErrorMiddleware } from "../../src/server/middleware"
import { tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
})

test("async research routes return receipts, reconnect, reject conflicting work, cancel and persist paused state", async () => {
  await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const task = await Effect.runPromise(
        Research.Service.use((svc) =>
          svc.createTask({
            title: "Async cancellation",
            domainID: "tsf",
            mode: "autonomous",
            taskSpec: {
              contextLength: 96,
              predictionLengths: [24],
              dataset: { loaderID: "etth1_tslib_v1", targetCols: ["OT"] },
            },
            objective: {},
            budget: {},
          }),
        ).pipe(Effect.provide(Research.defaultLayer)),
      )
      const otherTask = await Effect.runPromise(Research.Service.use((svc) => svc.createTask({
        title: "Independent task", domainID: "tsf", mode: "autonomous",
        taskSpec: task.taskSpec, objective: {}, budget: {},
      })).pipe(Effect.provide(Research.defaultLayer)))
      expect(otherTask.sessionID).not.toBe(task.sessionID)
      let entered = 0
      let stopped = false
      const app = new Hono()
        .post("/research/tasks/:taskID/pipeline", (c) =>
          jsonRequest("ResearchRoutes.tasks.pipeline", c, function* () {
            entered++
            yield* Effect.never.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  stopped = true
                }),
              ),
            )
            return { unexpected: true }
          }),
        )
        .route("/research", ResearchRoutes())
        .onError(ErrorMiddleware)
      const url = `/research/tasks/${task.id}/pipeline`
      const options = {
        method: "POST",
        headers: { "content-type": "application/json", prefer: "respond-async", "idempotency-key": "test-request" },
        body: JSON.stringify({ maxIterations: 1 }),
      }
      const first = await app.request(url, options)
      expect(first.status).toBe(202)
      const operation = await first.json()
      const second = await app.request(url, options)
      expect(second.status).toBe(202)
      expect((await second.json()).id).toBe(operation.id)
      expect((await app.request(url, { ...options, body: JSON.stringify({ maxIterations: 2 }) })).status).toBe(409)
      expect(entered).toBe(1)
      const other = await app.request(`/research/tasks/${otherTask.id}/pipeline`, options)
      expect(other.status).toBe(202)
      const otherOperation = await other.json()
      expect(otherOperation.id).not.toBe(operation.id)
      const otherURL = `/research/tasks/${otherTask.id}/operations/${otherOperation.id}`
      const statusURL = `/research/tasks/${task.id}/operations/${operation.id}`
      expect((await (await app.request(statusURL)).json()).status).toBe("running")
      expect((await app.request(`${statusURL}/cancel`, { method: "POST" })).status).toBe(200)
      let status = "canceling"
      for (let i = 0; i < 100 && status === "canceling"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        status = (await (await app.request(statusURL)).json()).status
      }
      expect(status).toBe("canceled")
      expect(stopped).toBe(true)
      expect((await (await app.request(otherURL)).json()).status).toBe("running")
      await app.request(`${otherURL}/cancel`, { method: "POST" })
      for (let i = 0; i < 100; i++) {
        if ((await (await app.request(otherURL)).json()).status === "canceled") break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect((await (await app.request(`/research/tasks/${task.id}`)).json()).status).toBe("paused")
      expect(await (await app.request(`/research/tasks/${task.id}/operations/active`)).json()).toBeNull()
    },
  })
}, 30000)
