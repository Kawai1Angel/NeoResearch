import { afterEach, expect } from "bun:test"
import { Cause, Effect, Layer } from "effect"
import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { CrossSpawnSpawner } from "@neoresearch-ai/core/cross-spawn-spawner"
import { Bus } from "../../src/bus"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Research } from "../../src/research"
import { updateHypothesisInPool } from "../../src/research/hypothesis-store"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

afterEach(resetDatabase)
const it = testEffect(CrossSpawnSpawner.defaultLayer)
const layer = Research.layer.pipe(Layer.provideMerge(Bus.layer), Layer.provideMerge(Session.defaultLayer), Layer.provideMerge(SessionPrompt.defaultLayer))

it.live("pipeline orders literature before planning, recovers without replay, and repairs or blocks corrupt evidence", () =>
  provideTmpdirInstance((directory) => Effect.gen(function* () {
    const svc = yield* Research.Service
    const bus = yield* Bus.Service
    const datasetPath = path.join(directory, "hourly.csv")
    const runtimeRoot = path.join(directory, "neo_cast")
    yield* Effect.promise(() => mkdir(runtimeRoot))
    const lines = ["date,OT", ...Array.from({ length: 192 }, (_, index) =>
      `${new Date(Date.UTC(2024, 0, 1) + index * 3_600_000).toISOString()},${10 + Math.sin(index * Math.PI / 12) + index / 1000}`)]
    yield* Effect.promise(() => writeFile(datasetPath, lines.join("\n")))
    const task = yield* svc.createTask({ title: "Literature pipeline", domainID: "tsf", mode: "autonomous", interactionMode: "companion",
      taskSpec: { contextLength: 96, predictionLengths: [24], dataset: { loaderID: "etth1_tslib_v1", path: datasetPath, targetCols: ["OT"] },
        runtime: { neoCastProjectRoot: runtimeRoot, pythonExecutable: "bash", bridgeOnly: true },
        metadata: { businessContext: "benchmark", interpretability: "none_required", deploymentTarget: "local_research" } },
      objective: { primaryMetric: "val_avg_mse", direction: "minimize", errorPreferences: "balanced" },
      budget: { maxRuns: 2, latencyBudget: "no_constraint", parameterBudget: "no_constraint", loop: { maxIterations: 1, maxNoImprove: 1 } } })
    const events: string[] = []
    const subscriptions = [
      yield* bus.subscribeCallback(Research.Event.DataAnalysisAgentStarted, () => { events.push("data:start") }),
      yield* bus.subscribeCallback(Research.Event.DataAnalysisAgentCompleted, () => { events.push("data:done") }),
      yield* bus.subscribeCallback(Research.Event.RetrieveAgentStarted, () => { events.push("literature:start") }),
      yield* bus.subscribeCallback(Research.Event.RetrieveAgentCompleted, () => { events.push("literature:done") }),
      yield* bus.subscribeCallback(Research.Event.HypoPlannerAgentStarted, () => { events.push("hypo:start") }),
      yield* bus.subscribeCallback(Research.Event.HypoPlannerAgentCompleted, () => { events.push("hypo:done") }),
    ]
    const pipeline = () => svc.runFullPipeline({ taskID: task.id, stage: "smoke", maxIterations: 1 }).pipe(
      Effect.catchCause((cause) => Effect.succeed(Cause.squash(cause))),
    )
    const blockedAt = (value: unknown, checkpoint: string) => expect({ name: (value as Error).name, data: (value as { data: unknown }).data }).toMatchObject({
      name: "ResearchPipelineBlockedError", data: { reason: "human_checkpoint_required", checkpointPhase: checkpoint },
    })
    yield* Effect.gen(function* () {
      blockedAt(yield* pipeline(), "intent_confirmed")
      expect(events).toEqual([])
      const approvals = yield* svc.listApprovals({ taskID: task.id })
      const intent = approvals.find((item) => item.reason.includes("[checkpoint:intent_confirmed]") && item.status === "pending")!
      yield* svc.replyApproval({ approvalID: intent.id, status: "approved", replyMessage: "Confirmed" })
      blockedAt(yield* pipeline(), "search_space_confirmed")
      expect(events).toEqual(["data:start", "data:done", "literature:start", "literature:done", "hypo:start", "hypo:done"])
      const after = yield* svc.getTask(task.id)
      expect((after.taskSpec.metadata as any).workflow.completedPhases).toEqual(["intent_gathering", "data_analysis", "literature", "hypo_planning"])
      const artifacts = yield* svc.listArtifacts(task.id)
      const bundleArtifact = artifacts.find((item) => item.kind === "task_evidence_bundle_json")!
      expect(bundleArtifact.metadata.readiness).toBe("ready_data_only")
      expect(bundleArtifact.metadata.agent).toBe("LiteratureAgent")
      const pool = yield* svc.listHypotheses(task.id)
      yield* Effect.promise(() => updateHypothesisInPool(task.id, pool[0]!.id, {
        applicabilityAssumptions: ["Temporal ordering remains valid"], falsificationCriteria: ["No validation gain"],
      }))
      const expectedPool = yield* svc.listHypotheses(task.id)
      events.length = 0
      blockedAt(yield* pipeline(), "search_space_confirmed")
      expect(events).toEqual([])
      expect(yield* svc.listHypotheses(task.id)).toEqual(expectedPool)
      const handoffArtifacts = (items: typeof artifacts) => items.filter((item) =>
        ["task_evidence_bundle_json", "literature_retrieve_result_json", "hypo_plan_md", "hypotheses_yaml"].includes(item.kind))
        .map((item) => item.id).sort()
      expect(handoffArtifacts(yield* svc.listArtifacts(task.id))).toEqual(handoffArtifacts(artifacts))
      const bundlePath = bundleArtifact.uri.slice(7)
      const validBundle = yield* Effect.promise(() => readFile(bundlePath, "utf8"))
      yield* Effect.promise(() => writeFile(bundlePath, "invalid JSON"))
      const plannerError = yield* svc.runHypoPlannerAgent({ taskID: task.id, taskEvidenceArtifactID: bundleArtifact.id }).pipe(
        Effect.catchCause((cause) => Effect.succeed(Cause.squash(cause))),
      )
      expect(plannerError).toBeInstanceOf(Error)
      expect(yield* svc.listHypotheses(task.id)).toEqual(expectedPool)
      events.length = 0
      blockedAt(yield* pipeline(), "search_space_confirmed")
      expect(events).toEqual(["literature:start", "literature:done", "hypo:start", "hypo:done"])
      expect(yield* Effect.promise(() => readFile(bundlePath, "utf8"))).toBe(validBundle)
      const rebuiltArtifacts = yield* svc.listArtifacts(task.id)
      expect(rebuiltArtifacts.filter((item) => item.kind === "task_evidence_bundle_json")).toHaveLength(1)
      expect(rebuiltArtifacts.filter((item) => item.kind === "literature_retrieve_result_json")).toHaveLength(1)
      // Recovery may rebuild a cached bundle, but a corrupt source contract must
      // stop the pipeline rather than silently entering data-only planning.
      const quantitative = artifacts.find((item) => item.kind === "dataset_quantitative_analysis_json")!
      yield* Effect.promise(() => writeFile(quantitative.uri.slice(7), "{}"))
      yield* Effect.promise(() => writeFile(bundlePath, "{}"))
      events.length = 0
      expect(yield* pipeline()).toBeInstanceOf(Error)
      expect(events).toEqual(["literature:start"])
    }).pipe(Effect.ensuring(Effect.sync(() => { for (const unsubscribe of subscriptions) unsubscribe() })))
  }).pipe(Effect.provide(layer)), { git: true, config: { formatter: false, lsp: false } }),
  60_000,
)
