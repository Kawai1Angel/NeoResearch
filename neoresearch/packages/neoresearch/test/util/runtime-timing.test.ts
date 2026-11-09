import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, Deferred } from "effect"
import { startTiming, timedAsync, timedEffect } from "../../src/util/runtime-timing"
import { it } from "../lib/effect"

test("timings have correlation IDs and finish once without recording payloads", () => {
  const rows: Record<string, unknown>[] = []
  const finish = startTiming("tool.body", { sessionID: "session", callID: "call" }, (row) => rows.push(row))
  finish("completed")
  finish("failed")
  expect(rows).toHaveLength(2)
  expect(rows[0].status).toBe("started")
  expect(rows[1].status).toBe("completed")
  expect(rows[0].timingID).toBe(rows[1].timingID)
  expect(rows[1].durationMs).toBeGreaterThanOrEqual(0)
  expect(rows[1].sessionID).toBe("session")
})

it.live("effect timing preserves success, failure and cancellation", () => Effect.gen(function* () {
  const rows: Record<string, unknown>[] = []
  const report = (row: Record<string, unknown>) => { rows.push(row) }
  expect(yield* timedEffect("ok", {}, Effect.succeed(42), report)).toBe(42)
  const failure = yield* timedEffect("fail", {}, Effect.fail("original"), report).pipe(Effect.exit)
  expect(Exit.isFailure(failure)).toBe(true)
  const ready = yield* Deferred.make<void>()
  const fiber = yield* timedEffect("cancel", {}, Effect.gen(function* () {
    yield* Deferred.succeed(ready, undefined)
    yield* Effect.never
  }), report).pipe(Effect.forkChild)
  yield* Deferred.await(ready)
  yield* Fiber.interrupt(fiber)
  const canceled = yield* Fiber.await(fiber)
  expect(Exit.isFailure(canceled) && Cause.hasInterruptsOnly(canceled.cause)).toBe(true)
  expect(rows.filter((row) => row.status !== "started").map((row) => row.status)).toEqual(["completed", "failed", "canceled"])
}))

test("promise failures and diagnostic failures cannot change the original result", async () => {
  const rows: Record<string, unknown>[] = []
  const error = new Error("original")
  await expect(timedAsync("read", {}, async () => { throw error }, (row) => { rows.push(row) })).rejects.toBe(error)
  expect(rows.at(-1)?.status).toBe("failed")
  expect(await timedAsync("read", {}, async () => 7, () => { throw new Error("logging") })).toBe(7)
})
