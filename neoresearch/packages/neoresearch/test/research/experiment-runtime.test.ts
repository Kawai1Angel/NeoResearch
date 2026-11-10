import { expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import path from "node:path"
import type { DomainRunPlan } from "../../src/research/domain"
import { ExperimentScheduler, experimentParallelLimit, isolateExperimentPlan } from "../../src/research/experiment-runtime"

function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Scheduler did not make progress")), 3000) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!))
}

test("four independent experiments run across tasks; the fifth waits for a released slot", async () => {
  const scheduler = new ExperimentScheduler()
  const gates = Array.from({ length: 5 }, () => Promise.withResolvers<void>())
  const four = Promise.withResolvers<void>()
  const five = Promise.withResolvers<void>()
  const started: number[] = []
  let active = 0
  let peak = 0
  const runs = gates.map((gate, index) => Effect.runPromise(scheduler.execute(`task-${index}`, 4, `workspace-${index}`, Effect.promise(async () => {
    active++
    peak = Math.max(peak, active)
    started.push(index)
    if (started.length === 4) four.resolve()
    if (started.length === 5) five.resolve()
    try { await gate.promise; return index } finally { active-- }
  }))))
  try {
    await deadline(four.promise)
    expect(started).toEqual([0, 1, 2, 3])
    gates[0]!.resolve()
    await deadline(five.promise)
    expect(active).toBe(4)
    expect(peak).toBe(4)
  } finally {
    gates.forEach((gate) => gate.resolve())
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3, 4])
  }
})

test("lower task limits are honored and failures and interruptions release slots", async () => {
  const scheduler = new ExperimentScheduler()
  await expect(Effect.runPromise(scheduler.execute("task", 1, "workspace", Effect.fail(new Error("fixture failure"))))).rejects.toThrow("fixture failure")
  const started = Promise.withResolvers<void>()
  const fiber = Effect.runFork(scheduler.execute("task", 1, "workspace", Effect.sync(() => started.resolve()).pipe(Effect.andThen(Effect.never))))
  await deadline(started.promise)
  await Effect.runPromise(Fiber.interrupt(fiber))
  expect(await Effect.runPromise(scheduler.execute("task", 1, "workspace", Effect.succeed("released")))).toBe("released")

  const gate = Promise.withResolvers<void>()
  const first = Promise.withResolvers<void>()
  let active = 0
  let peak = 0
  const runs = [0, 1, 2].map((i) => Effect.runPromise(scheduler.execute("limited-task", 1, `limited-${i}`, Effect.promise(async () => {
    active++
    peak = Math.max(peak, active)
    first.resolve()
    try { await gate.promise } finally { active-- }
  }))))
  try {
    await deadline(first.promise)
    expect(active).toBe(1)
  } finally { gate.resolve(); await Promise.all(runs) }
  expect(peak).toBe(1)
})

test("shared workspaces serialize writers without occupying all experiment slots", async () => {
  const scheduler = new ExperimentScheduler()
  const release = Promise.withResolvers<void>()
  const first = Promise.withResolvers<void>()
  const other = Promise.withResolvers<void>()
  const started: string[] = []
  const runs = ["same", "same", "other"].map((workspace, i) => Effect.runPromise(scheduler.execute(`task-${i}`, 4, workspace, Effect.promise(async () => {
    started.push(`${workspace}-${i}`)
    if (i === 0) first.resolve()
    if (i === 2) other.resolve()
    await release.promise
  }))))
  try {
    await deadline(Promise.all([first.promise, other.promise]))
    expect(started).toEqual(["same-0", "other-2"])
  } finally { release.resolve(); await Promise.all(runs) }
  expect(started).toEqual(["same-0", "other-2", "same-1"])
})

const root = "/project/.neo-research/workspaces/task"
const plan = (): DomainRunPlan => ({
  domainID: "tsf", runnerID: "fixture", runnerKind: "subprocess", stage: "full", approvalRequired: false,
  validation: { ok: true, issues: [] },
  writes: [{ path: path.join(root, ".neo-cast/current_candidate.json"), content: {} }, { path: "/project/contracts/proof.json", content: {} }],
  command: { executable: "python3", args: ["/package/runner.py", path.join(root, ".neo-cast/current_candidate.json")], cwd: root,
    env: { NEO_CAST_CONTRACT_CANDIDATE: path.join(root, ".neo-cast/current_candidate.json") } },
  expectedEvents: [], expectedMetrics: [], expectedArtifacts: [], notes: "fixture",
})

test("experiment state is isolated while dataset, deduplication and proof provenance are retained", () => {
  const original = plan()
  const first = isolateExperimentPlan(original, root, "run-a")
  const second = isolateExperimentPlan(original, root, "run-b")
  expect(first.command.cwd).not.toBe(second.command.cwd)
  expect(first.writes[0]!.path).toBe(`${root}/experiments/run-a/.neo-cast/current_candidate.json`)
  expect(first.command.args).toEqual(["/package/runner.py", first.writes[0]!.path])
  expect(first.command.env?.NEO_CAST_CONTRACT_CANDIDATE).toBe(first.writes[0]!.path)
  expect(first.writes[1]!.path).toBe("/project/contracts/proof.json")
  expect(first.command.env?.NEO_TSF_DATA_ROOT).toBe(`${root}/.neo-cast/dataset`)
  expect(first.command.env?.NEO_CAST_EXPERIMENT_STORE).toBe(second.command.env?.NEO_CAST_EXPERIMENT_STORE)
  expect(original.command.cwd).toBe(root)
  const evaluation = isolateExperimentPlan({ ...original, stage: "ref_test" }, root, "ref-a", first.command.cwd)
  expect(evaluation.command.cwd).toBe(first.command.cwd)
  expect(isolateExperimentPlan({ ...original, stage: "ref_test" }, root, "legacy-ref").command.cwd).toBe(root)
  expect(() => isolateExperimentPlan(original, root, "../escape")).toThrow("workspace ID")
  expect(() => isolateExperimentPlan({ ...original, stage: "ref_test" }, root, "ref", "/other-task")).toThrow("inside its task")
})

test("experiment concurrency defaults to four and cannot exceed four", () => {
  expect(experimentParallelLimit({})).toBe(4)
  expect(experimentParallelLimit({ maxParallel: 1 })).toBe(1)
  expect(experimentParallelLimit({ maxParallel: 12 })).toBe(4)
  expect(experimentParallelLimit({ maxParallel: 0 })).toBe(0)
})
