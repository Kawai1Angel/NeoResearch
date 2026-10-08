import { afterEach, expect } from "bun:test"
import { Cause, Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Research } from "../../src/research"
import { Agent } from "../../src/agent/agent"
import * as Truncate from "../../src/tool/truncate"
import { HypothesisSelectTool } from "../../src/tool/research-hypothesis"
import { addHypothesisToPool, abandonHypothesisInPool } from "../../src/research/hypothesis-store"
import { SessionID, MessageID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

afterEach(resetDatabase)
const it = testEffect(CrossSpawnSpawner.defaultLayer)
const layer = Layer.mergeAll(Research.defaultLayer, Agent.defaultLayer, Truncate.defaultLayer)

it.live("planner selection persists, controls candidate binding, and rejects invalid directions", () =>
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        const svc = yield* Research.Service
        const task = yield* svc.createTask({
          title: "Planner selection",
          domainID: "tsf",
          mode: "autonomous",
          taskSpec: {
            contextLength: 96,
            predictionLengths: [24],
            dataset: { loaderID: "etth1_tslib_v1", targetCols: ["OT"] },
          },
          objective: { primaryMetric: "cv_avg_mse", direction: "minimize" },
          budget: { maxRuns: 4 },
        })
        const draft = {
          statement: "Linear temporal control",
          motivation: ["Test the linear floor"],
          expectedOutcome: "Lower cv_avg_mse",
          suggestedBackbones: ["linear"],
          suggestedPreprocessing: [],
          risk: "Underfit",
          testable: true,
        }
        const high = yield* Effect.promise(() => addHypothesisToPool(task.id, { ...draft, priority: "high" }))
        const low = yield* Effect.promise(() => addHypothesisToPool(task.id, { ...draft, priority: "low" }))
        const missingChoice = yield* svc.runAutonomousIteration({ taskID: task.id, stage: "smoke" }).pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) => Effect.succeed(Cause.squash(cause))),
        )
        expect(String(missingChoice)).toContain("explicitly select the next experiment")
        expect(yield* svc.listRuns(task.id)).toEqual([])
        const ctx = {
          sessionID: SessionID.make(task.sessionID!),
          messageID: MessageID.make("msg_selection"),
          agent: "research-hypo-planner",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        }
        const select = yield* (yield* HypothesisSelectTool).init()
        const selected = yield* select.execute(
          { action: "experiment", hypoID: low.id, rationale: "Test this unexplored direction" },
          ctx,
        )
        expect(JSON.parse(selected.output)).toMatchObject({ hypothesisID: low.id, action: "experiment" })
        expect((yield* svc.getTask(task.id)).taskSpec.metadata).toMatchObject({
          nextExperiment: {
            action: "experiment",
            hypothesisID: low.id,
            rationale: "Test this unexplored direction",
          },
        })
        const candidate = yield* svc.createCandidate({
          taskID: task.id,
          domainID: "tsf",
          candidateSpec: Research.DomainRegistry.buildBaselines("tsf", task.taskSpec)[0]!.candidateSpec,
          generatedBy: "heuristic",
          rationale: "Selected experiment",
          riskLevel: "low",
          approvalStatus: "auto_approved",
        })
        expect(candidate.hypothesisID).toBe(low.id)
        expect(yield* svc.listHypotheses(task.id)).toEqual([high, low])
        expect((yield* svc.listHypotheses(task.id)).every((h) => h.priority === undefined)).toBe(true)
        expect(
          (yield* select.execute({ action: "experiment", hypoID: "missing", rationale: "Invalid" }, ctx)).output,
        ).toContain("not open")
        yield* Effect.promise(() => abandonHypothesisInPool(task.id, high.id, "Ruled out"))
        expect(
          (yield* select.execute({ action: "experiment", hypoID: high.id, rationale: "Closed" }, ctx)).output,
        ).toContain("not open")
        const unavailable = yield* Effect.promise(() =>
          addHypothesisToPool(task.id, {
            ...draft,
            suggestedBackbones: ["nbeats"],
            requiredMechanisms: ["fixed_trend_basis", "multirate_sampling"],
          }),
        )
        expect(
          (yield* select.execute({ action: "experiment", hypoID: unavailable.id, rationale: "Unavailable" }, ctx))
            .output,
        ).toContain("Unsupported mechanisms remain untested")
        expect((yield* svc.getTask(task.id)).taskSpec.metadata).toMatchObject({
          nextExperiment: { hypothesisID: low.id },
        })
        yield* select.execute({ action: "stop", rationale: "No useful experiment remains within the budget" }, ctx)
        expect((yield* svc.getTask(task.id)).taskSpec.metadata).toMatchObject({ nextExperiment: { action: "stop" } })
        const loop = yield* svc.runAutonomousLoop({ taskID: task.id, maxIterations: 3 })
        expect(loop.stoppedReason).toBe("planner_stopped")
        expect(loop.iterations).toEqual([])
        expect(yield* svc.listRuns(task.id)).toEqual([])
      }).pipe(Effect.provide(layer)),
    { git: true, config: { formatter: false, lsp: false } },
  ),
)
