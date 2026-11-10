import { CrossSpawnSpawner } from "@neoresearch-ai/core/cross-spawn-spawner"
import { expect } from "bun:test"
import { Effect } from "effect"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { logPhaseMethod } from "../../src/research/phase-log"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(CrossSpawnSpawner.defaultLayer)

it.live("phase journal records successful, failed and interrupted attempts with timing", () =>
  provideTmpdirInstance((dir) => Effect.gen(function* () {
    const success = logPhaseMethod("success", (_taskID: string) => Effect.succeed("ok"))
    const failure = logPhaseMethod("failure", (_taskID: string) => Effect.fail("fixture failure"))
    const canceled = logPhaseMethod("cancel", (_taskID: string) => Effect.interrupt)
    expect(yield* success("task")).toBe("ok")
    yield* Effect.exit(failure("task"))
    yield* Effect.exit(canceled("task"))
    const text = yield* Effect.promise(() => readFile(path.join(dir, ".neo-research/logs/task/events.jsonl"), "utf8"))
    const events = text.trim().split("\n").map((line) => JSON.parse(line))
    expect(events.map((event) => event.kind)).toEqual([
      "research.phase.started", "research.phase.completed",
      "research.phase.started", "research.phase.failed",
      "research.phase.started", "research.phase.canceled",
    ])
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i].properties.attemptID).toBe(events[i + 1].properties.attemptID)
      expect(events[i + 1].properties.durationMs).toBeGreaterThanOrEqual(0)
    }
    expect(events[3].properties.error).toContain("fixture failure")
  })),
)
