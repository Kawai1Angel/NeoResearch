import { expect, test } from "bun:test"
import { Effect } from "effect"
import { createResearchOperations } from "../../src/research/operation"
import { abortable } from "../../src/research/abortable"
import * as Process from "../../src/util/process"
import { deferBusyIntentReply, waitForResearchOperation } from "../../src/cli/cmd/tui/routes/research-operation-client"

test("research operations retain receipts, isolate tasks and reconnect without duplicate execution", async () => {
  const operations = createResearchOperations()
  let finish!: (result: unknown) => void
  let calls = 0
  const run = () => {
    calls++
    return new Promise((resolve) => {
      finish = resolve
    })
  }
  const first = operations.start("workspace", "task", "pipeline", run, "same-input")
  const resumed = operations.start("workspace", "task", "pipeline", run, "same-input")
  expect(first.operation.startedAt).toBeNumber()
  expect(resumed.resumed).toBe(true)
  expect(resumed.operation.id).toBe(first.operation.id)
  expect(resumed.operation.startedAt).toBe(first.operation.startedAt)
  expect(operations.start("workspace", "task", "pipeline", run, "changed-input").resumed).toBe(false)
  expect(calls).toBe(1)
  expect(operations.get("other-workspace", "task", first.operation.id)).toBeUndefined()
  finish({ artifact: "export" })
  expect((await operations.wait("workspace", "task", first.operation.id))?.result).toEqual({ artifact: "export" })
  expect(operations.active("workspace", "task")).toBeUndefined()
})

test("cancellation holds the task lock until resource cleanup has finished", async () => {
  const operations = createResearchOperations()
  let cleanup!: () => void
  let entered!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const started = operations.start("workspace", "task", "pipeline", (signal) =>
    Effect.runPromise(
      abortable(
        (abort) =>
          new Promise((resolve) => {
            abort.addEventListener("abort", () => {
              cleanup = () => resolve(undefined)
            })
            entered()
          }),
      ),
      { signal },
    ),
  )
  await ready
  expect(operations.cancel("workspace", "task", started.operation.id)?.status).toBe("canceling")
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(operations.start("workspace", "task", "pipeline", async () => {}).started).toBe(false)
  cleanup()
  expect((await operations.wait("workspace", "task", started.operation.id))?.status).toBe("canceled")
  expect(operations.start("workspace", "task", "pipeline", async () => {}).started).toBe(true)
})

test("research client waits for background work and preserves checkpoint errors", async () => {
  let polls = 0
  const operation = { id: "op", taskID: "task", action: "pipeline", status: "running" as const }
  const input = {
    operation,
    url: new URL("http://localhost/research/tasks/task/pipeline?directory=workspace"),
    headers: new Headers(),
    pollMs: 1,
    fetch: async (url: URL) => {
      expect(url.searchParams.get("directory")).toBe("workspace")
      return Response.json(
        ++polls < 3 ? operation : { ...operation, status: "completed", result: { artifact: "export" } },
      )
    },
  }
  expect(await waitForResearchOperation<{ artifact: string }>(input)).toEqual({ artifact: "export" })
  expect(polls).toBe(3)
  await expect(
    waitForResearchOperation({
      ...input,
      fetch: async () =>
        Response.json({
          ...operation,
          status: "failed",
          error: {
            name: "ResearchPipelineBlockedError",
            message: "blocked",
            data: { reason: "human_checkpoint_required" },
          },
        }),
    }),
  ).rejects.toThrow("human_checkpoint_required")
})

test("research client cancels server work and waits for cancellation acknowledgement", async () => {
  const controller = new AbortController()
  controller.abort()
  let cancels = 0
  let polls = 0
  const operation = { id: "op", taskID: "task", action: "pipeline", status: "running" as const }
  await expect(
    waitForResearchOperation({
      operation,
      signal: controller.signal,
      url: new URL("http://localhost/research/tasks/task/pipeline"),
      headers: new Headers(),
      pollMs: 1,
      fetch: async (url, init) => {
        expect(init.signal?.aborted).toBe(false)
        if (url.pathname.endsWith("/cancel")) {
          cancels++
          return Response.json({ ...operation, status: "canceling" })
        }
        return Response.json({ ...operation, status: ++polls < 2 ? "canceling" : "canceled" })
      },
    }),
  ).rejects.toThrow("Research operation canceled")
  expect(cancels).toBe(1)
  expect(polls).toBe(2)
})

test.skipIf(process.platform === "win32")(
  "runner cancellation terminates descendants and closes their inherited pipes",
  async () => {
    const controller = new AbortController()
    let childPID = 0
    const result = await Process.runStreaming(
      [
        process.execPath,
        "-e",
        `
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })
    console.log(child.pid)
    setInterval(() => {}, 1000)
  `,
      ],
      {
        abort: controller.signal,
        tree: true,
        nothrow: true,
        onStdoutLine: (line) => {
          childPID = Number(line)
          controller.abort()
        },
      },
    )
    expect(childPID).toBeGreaterThan(0)
    expect(result.code).not.toBe(0)
    // An orphan may briefly remain a zombie until init reaps it, but cannot execute.
    const stat = await Bun.file(`/proc/${childPID}/stat`)
      .text()
      .catch(() => "")
    expect(stat === "" || stat.split(") ")[1]?.startsWith("Z")).toBe(true)
  },
  5000,
)


test("intent clarification is waiting_input and releases the operation lock", async () => {
  const operations = createResearchOperations()
  const started = operations.start("workspace", "task", "pipeline", async () => {
    throw { name: "ResearchPipelineBlockedError", data: { reason: "intent_clarification_required" } }
  })
  expect((await operations.wait("workspace", "task", started.operation.id))?.status).toBe("waiting_input")
  expect(operations.active("workspace", "task")).toBeUndefined()
  expect(operations.start("workspace", "task", "modifyIntent", async () => ({})).started).toBe(true)
})

const priorIntent = { id: "prior", taskID: "task", action: "ResearchRoutes.tasks.pipeline", status: "running" as const }
function busyIntentResponse(operation = priorIntent) {
  return Response.json({ name: "ResearchOperationBusy", operation }, { status: 409 })
}

test("queued Intent answer waits for the previous turn and submits exactly once", async () => {
  let polls = 0
  let retries = 0
  const response = await deferBusyIntentReply({
    response: busyIntentResponse(), url: new URL("http://localhost/research/tasks/task/intent/modify?directory=workspace"),
    headers: new Headers({ "idempotency-key": "answer-key" }), pollMs: 1,
    fetch: async (url, init) => {
      expect(url.pathname).toBe("/research/tasks/task/operations/prior")
      expect(url.searchParams.get("directory")).toBe("workspace")
      expect(init.method).not.toBe("POST")
      return Response.json(++polls < 3 ? priorIntent : { ...priorIntent, status: "waiting_input" })
    },
    retry: async () => { retries++; return Response.json({ id: "answer" }, { status: 202 }) },
  })
  expect(response.status).toBe(202)
  expect(polls).toBe(3)
  expect(retries).toBe(1)
})

test("canceling a queued Intent answer never cancels the prior operation", async () => {
  const controller = new AbortController()
  let retries = 0
  await expect(deferBusyIntentReply({
    response: busyIntentResponse(), url: new URL("http://localhost/research/tasks/task/intent/modify"),
    headers: new Headers(), signal: controller.signal, pollMs: 1,
    fetch: async (url, init) => {
      expect(url.pathname).not.toContain("/cancel")
      expect(init.method).not.toBe("POST")
      controller.abort()
      return Response.json(priorIntent)
    },
    retry: async () => { retries++; return Response.json({}) },
  })).rejects.toThrow("Queued intent reply canceled")
  expect(retries).toBe(0)
})

test("busy operations in another task are not observed or resubmitted", async () => {
  const response = busyIntentResponse({ ...priorIntent, taskID: "other" })
  const fail = async () => { throw new Error("must not be called") }
  expect(await deferBusyIntentReply({
    response, url: new URL("http://localhost/research/tasks/task/intent/modify"), headers: new Headers(), fetch: fail, retry: fail,
  })).toBe(response)
})

test("an actual prior failure is surfaced without submitting the queued answer", async () => {
  let retries = 0
  await expect(deferBusyIntentReply({
    response: busyIntentResponse(), url: new URL("http://localhost/research/tasks/task/intent/modify"), headers: new Headers(),
    fetch: async () => Response.json({ ...priorIntent, status: "failed", error: { name: "Error", message: "provider unavailable" } }),
    retry: async () => { retries++; return Response.json({}) },
  })).rejects.toThrow("provider unavailable")
  expect(retries).toBe(0)
})

test("canceled prior turns never cause an automatic reply even if they carry a checkpoint error", async () => {
  let retries = 0
  await expect(deferBusyIntentReply({
    response: busyIntentResponse(), url: new URL("http://localhost/research/tasks/task/intent/modify"), headers: new Headers(),
    fetch: async () => Response.json({ ...priorIntent, status: "canceled", error: {
      name: "ResearchPipelineBlockedError", message: "canceled while stopping", data: { reason: "intent_clarification_required" },
    } }),
    retry: async () => { retries++; return Response.json({}) },
  })).rejects.toThrow("canceled while stopping")
  expect(retries).toBe(0)
})
