import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { writeFile } from "fs/promises"
import path from "path"
import { Research } from "../../src/research"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@neoresearch-ai/core/cross-spawn-spawner"
import * as Truncate from "../../src/tool/truncate"
import { HypothesisAddTool, HypothesisUpdateTool, HypothesisListTool } from "../../src/tool/research-hypothesis"
import { ReadTaskEvidenceTool } from "../../src/tool/research-knowledge"
import { SessionID, MessageID } from "../../src/session/schema"
import { bindTaskEvidenceToSession } from "../../src/research/hypothesis-store"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
import { activeFixture } from "./retrieve/fixtures"

afterEach(resetDatabase)
const it = testEffect(CrossSpawnSpawner.defaultLayer)
const layer = Layer.mergeAll(Research.defaultLayer, Agent.defaultLayer, Truncate.defaultLayer)

it.live("session tools preserve evidence through add/update/list and reject invalid or switched bundle citations", () =>
  provideTmpdirInstance((directory) => Effect.gen(function* () {
    const svc = yield* Research.Service
    const task = yield* svc.createTask({ title: "Evidence tools", domainID: "tsf", mode: "review",
      taskSpec: { contextLength: 96, predictionLengths: [24], dataset: { loaderID: "etth1_tslib_v1", targetCols: ["OT"] },
        metadata: { businessContext: "benchmark", interpretability: "none_required", deploymentTarget: "local_research" } },
      objective: { primaryMetric: "val_avg_mse", direction: "minimize" }, budget: { maxRuns: 2 } })
    yield* Effect.promise(() => writeFile(path.join(directory, "quantitative.json"), "{}"))
    const q = yield* svc.createArtifact({ taskID: task.id, kind: "dataset_quantitative_analysis_json", uri: `file://${directory}/quantitative.json`, metadata: {} })
    const bundle = { ...activeFixture(), taskID: task.id, quantitativeReportArtifactID: q.id }
    const bundlePath = path.join(directory, "evidence.json")
    yield* Effect.promise(() => writeFile(bundlePath, JSON.stringify(bundle)))
    const artifact = yield* svc.createArtifact({ taskID: task.id, kind: "task_evidence_bundle_json", uri: `file://${bundlePath}`, metadata: { retrieveRunID: bundle.retrieveRunID } })
    const entry = bundle.entries[0]!
    const draft = { statement: "Seasonal decomposition improves validation MSE", motivation: [entry.claim], expectedOutcome: "Lower MSE",
      suggestedBackbones: ["dlinear"], suggestedPreprocessing: [], requiredMechanisms: ["moving_average_decomposition"], risk: "Transfer uncertainty", testable: true,
      datasetEvidencePaths: entry.linkage.datasetEvidencePaths,
      literatureEvidence: [{ cardID: entry.cardID, cardRevision: entry.cardRevision, role: entry.roles[0]! }],
      experimentContract: { mode: "exploratory", changes: [], frozenPaths: [], requiredValues: [], forbiddenMechanisms: [] },
      applicabilityAssumptions: ["Stable seasonal structure"], falsificationCriteria: ["MSE fails to improve"], evidenceLevel: "paper_supported" as const }
    const ctx = { sessionID: SessionID.make(task.sessionID!), messageID: MessageID.make("msg_evidence"),
      agent: "build", abort: AbortSignal.any([]), messages: [], metadata: () => Effect.void, ask: () => Effect.void }
    const add = yield* (yield* HypothesisAddTool).init()
    const update = yield* (yield* HypothesisUpdateTool).init()
    const list = yield* (yield* HypothesisListTool).init()
    const read = yield* (yield* ReadTaskEvidenceTool).init()
    const readRequest = { cardID: entry.cardID, cardRevision: entry.cardRevision, section: "sources" as const, limit: 50 }
    const page = JSON.parse((yield* read.execute(readRequest, ctx)).output)
    expect(page.cardID).toBe(entry.cardID)
    expect(page.text.length).toBeLessThanOrEqual(50)
    expect((yield* Effect.exit(read.execute({ ...readRequest, cardRevision: 999 }, ctx)))._tag).toBe("Failure")
    expect((yield* Effect.exit(read.execute(readRequest, { ...ctx, abort: AbortSignal.abort() })))._tag).toBe("Failure")
    const added = yield* add.execute(draft, ctx)
    expect(added.metadata.hypoID).toBeDefined()
    const hypoID = added.metadata.hypoID!
    const changed = yield* update.execute({ hypoID, applicabilityAssumptions: ["Stable hourly seasonal structure"] }, ctx)
    expect(changed.output).toContain("Updated hypothesis")
    const rows = JSON.parse((yield* list.execute({}, ctx)).output)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ...draft, id: hypoID, applicabilityAssumptions: ["Stable hourly seasonal structure"] })
    expect(yield* svc.listHypotheses(task.id)).toEqual(rows)
    for (const patch of [
      { literatureEvidence: [{ ...draft.literatureEvidence[0]!, cardID: "kc_000000000000" }] },
      { literatureEvidence: [{ ...draft.literatureEvidence[0]!, cardRevision: 999 }] },
      { literatureEvidence: [{ ...draft.literatureEvidence[0]!, role: "defines_evaluation" as const }] },
      { datasetEvidencePaths: ["$.invented"] }, { falsificationCriteria: [] }, { applicabilityAssumptions: [] },
    ]) {
      expect((yield* add.execute({ ...draft, ...patch }, ctx)).output).toContain("Invalid hypothesis evidence")
      expect((yield* update.execute({ hypoID, ...patch }, ctx)).output).toContain("Invalid hypothesis evidence")
    }
    expect(JSON.parse((yield* list.execute({}, ctx)).output)).toEqual(rows)
    yield* Effect.promise(() => writeFile(bundlePath, JSON.stringify({ ...bundle, schemaVersion: "task_evidence_bundle_v1" })))
    expect((yield* update.execute({ hypoID, risk: "Legacy evidence must not be reused" }, ctx)).output).toContain("Legacy task evidence requires")
    yield* Effect.promise(() => writeFile(bundlePath, JSON.stringify(bundle)))
    const release = bindTaskEvidenceToSession(ctx.sessionID, task.id, artifact.id)
    yield* Effect.gen(function* () {
      const nextPath = path.join(directory, "next.json")
      const next = { ...activeFixture(true), taskID: task.id, quantitativeReportArtifactID: q.id, retrieveRunID: "retrieve_new" }
      yield* Effect.promise(() => writeFile(nextPath, JSON.stringify(next)))
      yield* svc.createArtifact({ taskID: task.id, kind: "task_evidence_bundle_json", uri: `file://${nextPath}`, metadata: { retrieveRunID: next.retrieveRunID } })
      expect((yield* update.execute({ hypoID, risk: "Pinned evidence remains available" }, ctx)).output).toContain("Updated hypothesis")
      expect(JSON.parse((yield* read.execute(readRequest, ctx)).output)).toEqual(page)
      yield* Effect.promise(() => writeFile(bundlePath, JSON.stringify({ ...bundle, taskID: "wrong_task" })))
      expect((yield* update.execute({ hypoID, risk: "must fail" }, ctx)).output).toContain("provenance mismatch")
    }).pipe(Effect.ensuring(Effect.sync(release)))
    expect((yield* update.execute({ hypoID, risk: "Unpinned session must use latest evidence" }, ctx)).output).toContain("unknown task-evidence card")
    expect((yield* Effect.exit(read.execute(readRequest, ctx)))._tag).toBe("Failure")
  }).pipe(Effect.provide(layer)), { git: true, config: { formatter: false, lsp: false } }),
  30_000,
)
