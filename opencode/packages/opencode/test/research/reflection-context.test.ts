import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "node:path"
import { writeFile } from "node:fs/promises"
import { Research } from "../../src/research"
import { Agent } from "../../src/agent/agent"
import * as Truncate from "../../src/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { reflectionRunSelection, readReflectionHistory } from "../../src/research/reflection-context"
import { readReflectionKnowledge, reflectionKnowledgeForPrompt, confirmKnowledgeExperiment } from "../../src/research/literature/knowledge-feedback"
import { ReadKnowledgeCardsTool, ReadTaskEvidenceTool } from "../../src/tool/research-knowledge"
import { ExperimentResultsTool, ReadReflectionTool } from "../../src/tool/research-context"
import { SessionID, MessageID } from "../../src/session/schema"
import { distillArchitectureKnowledge } from "../../src/research/retrieve/architecture-distiller"
import { activeFixture, report } from "./retrieve/fixtures"
import { principleFixture } from "./literature/principle-fixtures"
import { fixtureModel } from "./retrieve/architecture-model-fixture"
import { resetDatabase } from "../fixture/db"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(resetDatabase)
const it = testEffect(CrossSpawnSpawner.defaultLayer)
const layer = Layer.mergeAll(Research.defaultLayer, Agent.defaultLayer, Truncate.defaultLayer)

it.live("reflection reads admitted cited cards and the failed current attempt/comparison without raw retrieval or all-run histories", () =>
  provideTmpdirInstance((directory) => Effect.gen(function* () {
    const svc = yield* Research.Service
    const task = yield* svc.createTask({ title: "Reflection compact context", domainID: "tsf", mode: "review",
      taskSpec: { contextLength: 96, predictionLengths: [24], dataset: { loaderID: "etth1_tslib_v1", targetCols: ["OT"] } },
      objective: { primaryMetric: "val_avg_mse", direction: "minimize" }, budget: { maxRuns: 20 } })
    const candidate = yield* svc.createCandidate({ taskID: task.id, domainID: "tsf", candidateSpec: Research.DomainRegistry.buildBaselines("tsf", task.taskSpec)[0]!.candidateSpec,
      rationale: "Synthetic controlled trial", riskLevel: "low", approvalStatus: "auto_approved", generatedBy: "human" })
    const comparison = yield* svc.createRun({ taskID: task.id, candidateID: candidate.id, stage: "full", status: "succeeded", metrics: { val_avg_mse: 0.4 } })
    for (let index = 0; index < 3; index++) yield* svc.createRun({ taskID: task.id, candidateID: candidate.id, stage: "smoke", status: "succeeded" })
    const { card } = principleFixture((draft) => { draft.paperID = "admitted-reflection-source" })
    const packet = yield* Effect.promise(() => distillArchitectureKnowledge({
      corpus: { cards: [card], historicalCardIDs: [], digest: "reflection-admission", warnings: [] },
      model: fixtureModel().model, task: { quantitativeReport: report() }, datasetEvidencePaths: [],
      maxDecisions: 12, auditRoot: path.join(directory, "audit"),
    }))
    const citation = { cardID: card.knowledgeID, cardRevision: card.revision, role: "supports_mechanism" }
    const current = yield* svc.createRun({ taskID: task.id, candidateID: candidate.id, stage: "full", status: "failed",
      resourceUsage: { hypothesisSnapshot: { literatureEvidence: [citation], experimentContract: { mode: "controlled", comparisonRunID: comparison.id } } } })
    yield* svc.updateRunStatus({ runID: current.id, status: "failed", error: "Exact synthetic execution failure" })
    const qpath = path.join(directory, "quantitative.json")
    yield* Effect.promise(() => writeFile(qpath, "{}"))
    const q = yield* svc.createArtifact({ taskID: task.id, kind: "dataset_quantitative_analysis_json", uri: `file://${qpath}`, metadata: {} })
    const bundle = { ...activeFixture(), taskID: task.id, quantitativeReportArtifactID: q.id, architectureKnowledge: packet }
    const bpath = path.join(directory, "bundle.json")
    yield* Effect.promise(() => writeFile(bpath, JSON.stringify(bundle)))
    yield* svc.createArtifact({ taskID: task.id, kind: "task_evidence_bundle_json", uri: `file://${bpath}`, metadata: { retrieveRunID: bundle.retrieveRunID } })
    expect(reflectionRunSelection(task.id).runIDs).toEqual([current.id, comparison.id])
    const history = yield* Effect.promise(() => readReflectionHistory(task.id))
    expect(history.runs.map((run) => run.runID)).toEqual([current.id, comparison.id])
    expect(history.runs[0]!.error).toContain("Exact synthetic execution failure")
    const knowledge = yield* Effect.promise(() => readReflectionKnowledge(task.id))
    expect(knowledge.entries.map((entry) => entry.cardID)).toEqual([card.knowledgeID])
    const summary = reflectionKnowledgeForPrompt(knowledge)
    expect(summary.entries.map((entry) => entry.cardID)).toEqual([card.knowledgeID])
    expect(summary.entries[0]!.assertions).toEqual(card.assertions)
    expect(JSON.stringify(summary)).not.toContain(card.sources[0]!.quote)
    expect(JSON.stringify(summary).length).toBeLessThan(15_000)
    expect(() => reflectionKnowledgeForPrompt(knowledge, bundle.entries[0]!.cardID, 1)).toThrow("withheld")
    const invalid = yield* Effect.exit(Effect.promise(() => confirmKnowledgeExperiment(task.id, {
      cardID: bundle.entries[0]!.cardID, cardRevision: 1, runID: current.id, assertionIDs: ["m"],
      rationale: "Cannot validate raw selection", conditionsAssessment: "Synthetic", implementationAssessment: "Synthetic", limitations: ["Synthetic"],
    })))
    expect(invalid._tag).toBe("Failure")
    const ctx = { sessionID: SessionID.make(task.sessionID!), messageID: MessageID.make("msg_reflection_summary"), agent: "research-reflection",
      abort: AbortSignal.any([]), messages: [], metadata: () => Effect.void, ask: () => Effect.void }
    const reader = yield* (yield* ReadKnowledgeCardsTool).init()
    expect(JSON.parse((yield* reader.execute({}, ctx)).output)).toEqual(summary)
    const evidence = yield* (yield* ReadTaskEvidenceTool).init()
    const page = JSON.parse((yield* evidence.execute({ cardID: citation.cardID, cardRevision: citation.cardRevision, section: "sources", limit: 40 }, ctx)).output)
    expect(page.text.length).toBeLessThanOrEqual(40)
    const results = yield* (yield* ExperimentResultsTool).init()
    expect(JSON.parse((yield* results.execute({ limit: 20 }, ctx)).output).runs).toHaveLength(2)
    expect(JSON.parse((yield* results.execute({ runID: comparison.id }, ctx)).output).runs[0].runID).toBe(comparison.id)
    const prevDir = path.join(directory, ".neo-research/sessions", task.id, "reflect_001")
    yield* Effect.promise(() => Bun.write(path.join(prevDir, "reflection_result.json"), JSON.stringify({ llm: {
      status: "used", text: "DUPLICATED_RAW_TEXT", structured: { attributionAnalysis: "Scope preserved", nextStepRecommendation: "Repair execution" },
    } })))
    const reflection = yield* (yield* ReadReflectionTool).init()
    const previous = JSON.parse((yield* reflection.execute({}, ctx)).output)
    expect(previous.structured.attributionAnalysis).toBe("Scope preserved")
    expect(previous.text).toBeUndefined()
    expect(JSON.parse((yield* reflection.execute({ full: true }, ctx)).output).text).toBe("DUPLICATED_RAW_TEXT")
  }).pipe(Effect.provide(layer)), { git: true, config: { formatter: false, lsp: false } }),
  30_000,
)
