import { expect, test } from "bun:test"
import { createResearchReads, createResearchRefresh } from "../../../src/cli/cmd/tui/routes/research-refresh"

function clock() {
  let now = 0
  let id = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  return {
    now: () => now,
    schedule(callback: () => void, ms: number) {
      const key = ++id
      timers.set(key, { at: now + ms, callback })
      return key as unknown as ReturnType<typeof setTimeout>
    },
    cancel(key: ReturnType<typeof setTimeout>) { timers.delete(key as unknown as number) },
    advance(ms: number) {
      now += ms
      for (const [key, timer] of timers) {
        if (timer.at > now) continue
        timers.delete(key)
        timer.callback()
      }
    },
  }
}

test("a burst produces one trailing refresh; continuous events do not starve updates", () => {
  const time = clock()
  let count = 0
  const refresh = createResearchRefresh(() => count++, 1000, time)
  for (let i = 0; i < 10000; i++) refresh.request()
  expect(count).toBe(0)
  time.advance(1000)
  expect(count).toBe(1)
  for (let i = 0; i < 20; i++) {
    refresh.request()
    time.advance(100)
  }
  expect(count).toBe(3)
  refresh.request()
  refresh.dispose()
  time.advance(1000)
  refresh.request()
  time.advance(1000)
  expect(count).toBe(3)
})

test("slow reads are shared, fresh reads follow completion, and task keys stay isolated", async () => {
  const reads = createResearchReads()
  let resolve!: (value: number) => void
  let calls = 0
  const load = () => { calls++; return new Promise<number>((done) => { resolve = done }) }
  const first = reads.read("task-a/runs", load)
  const rest = Array.from({ length: 1000 }, () => reads.read("task-a/runs", load))
  await Promise.resolve()
  expect(calls).toBe(1)
  expect(await reads.read("task-b/runs", async () => 2)).toBe(2)
  resolve(1)
  expect(await first).toBe(1)
  expect(await Promise.all(rest)).toEqual(Array(1000).fill(1))
  expect(await reads.read("task-a/runs", async () => 3)).toBe(3)
})

test("only explicit TTL reads are cached; failures can be retried", async () => {
  let now = 0
  const reads = createResearchReads(() => now)
  let calls = 0
  const load = async () => ++calls
  expect(await reads.read("llm", load, 30000)).toBe(1)
  now = 29999
  expect(await reads.read("llm", load, 30000)).toBe(1)
  now = 30000
  expect(await reads.read("llm", load, 30000)).toBe(2)
  await expect(reads.read("failed", async () => { throw new Error("offline") }, 30000)).rejects.toThrow("offline")
  expect(await reads.read("failed", async () => "recovered", 30000)).toBe("recovered")
})

test("background snapshots survive read timeouts, stay task-scoped and recover on the next read", async () => {
  const reads = createResearchReads()
  const offline = async () => { throw new Error("Request timed out after 90s") }
  expect(await reads.snapshot("task-a/champion", async () => ({ runID: "run-a" }))).toEqual({ runID: "run-a" })
  expect(await reads.snapshot<{ runID: string } | null>("task-a/champion", offline)).toEqual({ runID: "run-a" })
  expect(await reads.snapshot<{ runID: string } | null>("task-b/champion", offline)).toBeUndefined()
  expect(await reads.snapshot("task-a/champion", async () => null)).toBeNull()
  expect(await reads.snapshot<{ runID: string } | null>("task-a/champion", offline)).toBeNull()
  await expect(reads.read("task-a/champion", offline)).rejects.toThrow("timed out")
})
