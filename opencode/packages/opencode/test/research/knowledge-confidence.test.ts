import { afterEach, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "node:path"
import { writeFile, readFile } from "node:fs/promises"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Research } from "../../src/research"
import { Database, eq } from "../../src/storage"
import { ResearchTaskTable } from "../../src/research/research.sql"
import { Agent } from "../../src/agent/agent"
import * as Truncate from "../../src/tool/truncate"
import { KnowledgeV2Store } from "../../src/research/literature/knowledge-v2-store"
import { KnowledgeCardV2Schema } from "../../src/research/literature/knowledge-v2-contract"
import { validateKnowledgeCardSeal } from "../../src/research/literature/knowledge-v2-validator"
import { KnowledgeValidationDraftSchema, knowledgeSelectionScore, validateKnowledgeExperiment, type KnowledgeValidationDraft } from "../../src/research/literature/knowledge-confidence"
import { confirmKnowledgeExperiment } from "../../src/research/literature/knowledge-feedback"
import { ConfirmKnowledgeTool, ReadKnowledgeCardsTool } from "../../src/tool/research-knowledge"
import { SessionID, MessageID } from "../../src/session/schema"
import type { ExperimentFact } from "../../src/research/experience"
import { recallKnowledge } from "../../src/research/retrieve/knowledge-recall"
import { buildPrincipleTaskEvidence } from "../../src/research/retrieve/principle-evidence"
import { DEFAULT_RETRIEVAL_BUDGETS } from "../../src/research/retrieve/contract"
import { RetrieveAgent } from "../../src/research/retrieve/retrieve-agent"
import { principleFixture } from "./literature/principle-fixtures"
import { fixture, activeFixture, report } from "./retrieve/fixtures"
import { tmpdir, provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

afterEach(resetDatabase)
const it = testEffect(CrossSpawnSpawner.defaultLayer)
const layer = Layer.mergeAll(Research.defaultLayer, Agent.defaultLayer, Truncate.defaultLayer)
const source = () => principleFixture((c) => { c.paperID = "paper-frequency" })
const draft = (cardID: string, runID = "run_trial"): KnowledgeValidationDraft => ({
  cardID, cardRevision: 1, runID, comparisonRunID: "baseline", assertionIDs: ["m", "e"],
  rationale: "The measured operation supports the scoped synthetic claim.",
  conditionsAssessment: "The measured data satisfy the stated prerequisites.",
  implementationAssessment: "The execution manifest includes the operation being tested.",
  limitations: ["Only this dataset and evaluation protocol have been observed."],
})
const fact = (runID = "run_trial"): ExperimentFact => ({
  taskID: "task", runID, stage: "full", status: "succeeded", dataset: { identity: "sha256:data", contentHash: "a".repeat(64), specification: {} },
  taskFingerprint: {}, evaluation: { contextLength: 96 }, proposedModel: { backbone: { type: "linear", shared: runID !== "baseline" } },
  hypothesisSnapshot: { experimentContract: { mode: "controlled", comparisonRunID: "baseline", changes: [{ operation: "set", path: "backbone.shared", before: false, after: true }] } },
  executedModel: { backbone: "actual", trainingStrategy: { optimizer: { lr: 0.001 } } },
  executionVerified: true, independentEvidence: true, metrics: { mse: 0.2, parameters: 100 },
  primaryMetric: "mse", primaryValue: 0.2, direction: "minimize", artifactIDs: ["artifact_actual"],
})

test("old v2 cards receive a neutral initial confidence without changing their source review seal", () => {
  const { confidence, experimentValidations, ...old } = source().card
  const restored = KnowledgeCardV2Schema.parse(old)
  expect(restored.confidence).toBe(0.5)
  expect(restored.experimentValidations).toEqual([])
  expect(validateKnowledgeCardSeal(restored)).toEqual([])
  expect(KnowledgeCardV2Schema.safeParse({ ...old, confidence: 1.1 }).success).toBe(false)
  expect(KnowledgeValidationDraftSchema.safeParse({ ...draft(old.knowledgeID), confidence: 1, facts: [fact(), fact("baseline")] }).success).toBe(false)
})

test("confirmed experiment adds 0.01 once, preserves source review and re-extraction history, and caps at one", async () => {
  await using tmp = await tmpdir()
  const database = path.join(tmp.path, "knowledge.db")
  const store = new KnowledgeV2Store(database)
  const { card, context } = source()
  try {
    store.publish([card], context, true)
    const d = draft(card.knowledgeID)
    const first = store.confirmExperiment("task", d, [fact(), fact("baseline")])
    expect(first.card.confidence).toBe(0.51)
    expect(first.card.revision).toBe(2)
    expect(first.card.review).toEqual(card.review)
    expect(validateKnowledgeCardSeal(first.card)).toEqual([])
    expect(first.validation.facts).toEqual([fact(), fact("baseline")])
    const again = store.confirmExperiment("task", { ...d, rationale: "Reworded validation", assertionIDs: ["p"] }, [fact(), fact("baseline")])
    expect(again.updated).toBe(false)
    expect(again.card.revision).toBe(2)
    expect(again.card.experimentValidations).toHaveLength(1)
    store.publish([card], context, true)
    expect(store.getCard(card.knowledgeID)?.confidence).toBe(0.51)
    expect(store.getCard(card.knowledgeID)?.experimentValidations).toHaveLength(1)
    for (let i = 0; i < 51; i++) store.confirmExperiment("task", draft(card.knowledgeID, `repeat_${i}`), [fact(`repeat_${i}`), fact("baseline")])
    expect(store.getCard(card.knowledgeID)?.confidence).toBe(1)
    expect(store.getCard(card.knowledgeID)?.experimentValidations.at(-1)?.increment).toBe(0)
    await store.exportCards()
    expect(JSON.parse((await readFile(path.join(tmp.path, "exports/knowledge_cards_v2.jsonl"), "utf8")).trim()).confidence).toBe(1)
    const reopened = new KnowledgeV2Store(database)
    try { expect(reopened.getCard(card.knowledgeID)?.experimentValidations).toHaveLength(52) } finally { reopened.close() }
    store.retire(card.knowledgeID)
    expect(() => store.confirmExperiment("task", d, [fact(), fact("baseline")])).toThrow("retired")
  } finally { store.close() }
})

test("success alone, incomplete/duplicate runs, invented assertions and unfair performance comparisons cannot add confidence", () => {
  const { card } = source()
  const d = draft(card.knowledgeID)
  for (const patch of [{ status: "failed" }, { stage: "smoke" }, { stage: "ref_test" }, { primaryValue: undefined },
    { independentEvidence: false }, { executionVerified: false }, { dataset: { identity: "unverified", specification: {} } }]) {
    expect(() => validateKnowledgeExperiment(card, d, "task", [{ ...fact(), ...patch }])).toThrow("verified full run")
  }
  expect(() => validateKnowledgeExperiment(card, { ...d, assertionIDs: ["missing"] }, "task", [fact(), fact("baseline")])).toThrow("Unknown")
  expect(() => validateKnowledgeExperiment(card, { ...d, assertionIDs: ["c"] }, "task", [fact(), fact("baseline")])).toThrow("conditions alone")
  const performance = { ...card, expectedEffect: { ...card.expectedEffect, kind: "performance" as const } }
  expect(() => validateKnowledgeExperiment(performance, d, "task", [fact(), fact("baseline")])).toThrow("comparison")
  const comparison = { ...fact("baseline"), primaryValue: 0.3, metrics: { mse: 0.3 } }
  const paired = { ...d, comparisonRunID: "baseline" }
  expect(() => validateKnowledgeExperiment(performance, paired, "task", [fact(), comparison])).not.toThrow()
  expect(() => validateKnowledgeExperiment(performance, paired, "task", [fact(), { ...comparison, evaluation: { contextLength: 24 } }])).toThrow("identical evaluation settings")
})

test("confidence affects recall and final quota selection while revisions invalidate retrieval caches", async () => {
  await using tmp = await tmpdir()
  const knowledgeRoot = path.join(tmp.path, "knowledge")
  const store = new KnowledgeV2Store(path.join(knowledgeRoot, "knowledge.db"))
  const retrieval = new RetrieveAgent({ neoCastRoot: tmp.path, workspaceRoot: tmp.path, knowledgeRoot })
  try {
    const { card, context } = source()
    store.publish([card], context, true)
    const before = await retrieval.run({ quantitativeReport: report() })
    store.confirmExperiment("task", draft(card.knowledgeID), [fact(), fact("baseline")])
    const after = await retrieval.run({ quantitativeReport: report() })
    expect(after.retrieveRunID).not.toBe(before.retrieveRunID)
    expect(after.taskEvidence.entries[0].knowledge?.confidence).toBe(0.51)
    expect(before.taskEvidence.entries[0].knowledge?.confidence).toBe(0.5)
    const b = principleFixture((c) => { c.paperID = "paper-frequency"; c.candidateID = "other" }).card
    const high = { ...b, confidence: 0.8 }
    const data = fixture()
    const recall = recallKnowledge({ cards: [card, high], report: data.quantitative, taskContext: data.taskContext,
      transformations: data.transformations, intents: data.intents, budgets: { ...DEFAULT_RETRIEVAL_BUDGETS, maxCandidatesPerIntent: 1 } })
    expect(recall.papers[0].acceptedCardIDs).toEqual([high.knowledgeID])
    const bundle = buildPrincipleTaskEvidence({ ...data, report: data.quantitative, retrieveRunID: "retrieve_fixture", quantitativeReportArtifactID: "artifact",
      literatureResults: data.literatureResults.map((p) => ({ ...p, acceptedCardIDs: [card.knowledgeID, high.knowledgeID] })),
      knowledgeSource: { getCard: (id) => id === card.knowledgeID ? card : high }, budgets: { ...DEFAULT_RETRIEVAL_BUDGETS, maxTaskEvidenceEntries: 1 } })
    expect(bundle.entries[0].cardID).toBe(high.knowledgeID)
    expect(knowledgeSelectionScore(0.8, 0.51)).toBe(0.771)
  } finally { retrieval.close(); store.close() }
})

it.live("Reflection tool binds current-task cards to authoritative facts and prevents unauthorized, stale and duplicate credit", () =>
  provideTmpdirInstance((directory) => Effect.gen(function* () {
    const svc = yield* Research.Service
    const datasetPath = path.join(directory, "data.csv")
    yield* Effect.promise(() => writeFile(datasetPath, "date,OT\n2024-01-01,1\n2024-01-02,2\n2024-01-03,3"))
    const task = yield* svc.createTask({ title: "Knowledge confidence", domainID: "tsf", mode: "review",
      taskSpec: { contextLength: 96, predictionLengths: [24], dataset: { loaderID: "local_csv", path: datasetPath, targetCols: ["OT"] },
        metadata: { businessContext: "benchmark", interpretability: "none_required", deploymentTarget: "local_research" } },
      objective: { primaryMetric: "val_avg_mse", direction: "minimize" }, budget: { maxRuns: 5 } })
    const candidate = yield* svc.createCandidate({ taskID: task.id, domainID: "tsf", candidateSpec: Research.DomainRegistry.buildBaselines("tsf", task.taskSpec)[0]!.candidateSpec,
      rationale: "Synthetic mechanism trial", riskLevel: "low", approvalStatus: "auto_approved", generatedBy: "human" })
    const usage = { executionContract: { status: "verified", manifest: { actual: { operation: "frequency projection", training: { lr: 0.001 } } } } }
    const baseline = yield* svc.createRun({ taskID: task.id, candidateID: candidate.id, stage: "full", status: "succeeded", metrics: { val_avg_mse: 0.4 }, resourceUsage: usage })
    const beforeLR = (candidate.candidateSpec.trainingStrategy as any).optimizer.lr
    const trial = yield* svc.createCandidate({ taskID: task.id, domainID: "tsf", candidateSpec: { ...candidate.candidateSpec, trainingStrategy: { ...(candidate.candidateSpec.trainingStrategy as any), optimizer: { ...(candidate.candidateSpec.trainingStrategy as any).optimizer, lr: beforeLR / 2 } } }, rationale: "Matched LR trial", riskLevel: "low", approvalStatus: "auto_approved", generatedBy: "human" })
    const trialUsage = { ...usage, hypothesisSnapshot: { experimentContract: { mode: "controlled", comparisonRunID: baseline.id, changes: [{ operation: "set", path: "trainingStrategy.optimizer.lr", before: beforeLR, after: beforeLR / 2 }] } } }
    const run = yield* svc.createRun({ taskID: task.id, candidateID: trial.id, stage: "full", status: "succeeded", metrics: { val_avg_mse: 0.3 }, resourceUsage: trialUsage })
    const { card, context: sourceContext } = source()
    const store = new KnowledgeV2Store(path.join(directory, "neo_cast/.neo-cast/literature-knowledge/knowledge.db"))
    try {
      store.publish([card], sourceContext, true)
      const qpath = path.join(directory, "quantitative.json")
      yield* Effect.promise(() => writeFile(qpath, "{}"))
      const q = yield* svc.createArtifact({ taskID: task.id, kind: "dataset_quantitative_analysis_json", uri: `file://${qpath}`, metadata: {} })
      const bundle = { ...activeFixture(), taskID: task.id, quantitativeReportArtifactID: q.id }
      const bpath = path.join(directory, "bundle.json")
      yield* Effect.promise(() => writeFile(bpath, JSON.stringify(bundle)))
      yield* svc.createArtifact({ taskID: task.id, kind: "task_evidence_bundle_json", uri: `file://${bpath}`, metadata: { retrieveRunID: bundle.retrieveRunID } })
      const writer = yield* (yield* ConfirmKnowledgeTool).init(), reader = yield* (yield* ReadKnowledgeCardsTool).init()
      const ctx = { sessionID: SessionID.make(task.sessionID!), messageID: MessageID.make("msg_knowledge"), agent: "research-reflection",
        abort: AbortSignal.any([]), messages: [], metadata: () => Effect.void, ask: () => Effect.void }
      const request = { ...draft(card.knowledgeID, run.id), comparisonRunID: baseline.id }
      expect((yield* writer.execute(request, { ...ctx, agent: "research-hypo-planner" })).metadata.saved).toBe(false)
      const first = JSON.parse((yield* writer.execute(request, ctx)).output)
      expect(first.saved).toBe(true)
      expect(first.confidence).toBe(0.51)
      expect(first.validation.facts[0].metrics.val_avg_mse).toBe(0.3)
      expect(first.validation.facts[0].executedModel).toEqual(usage.executionContract.manifest.actual)
      expect(first.validation.facts[0].dataset.contentHash).toHaveLength(64)
      expect(first.validation.facts[1].runID).toBe(baseline.id)
      expect(JSON.parse((yield* reader.execute({}, ctx)).output).entries[0].confidence).toBe(0.51)
      const repeated = yield* Effect.promise(() => confirmKnowledgeExperiment(task.id, request))
      expect(repeated.updated).toBe(false)
      expect(repeated.confidence).toBe(0.51)
      expect((yield* writer.execute({ ...request, runID: baseline.id, comparisonRunID: run.id }, ctx)).metadata.saved).toBe(false)
      expect((yield* writer.execute({ ...request, cardRevision: 999 }, ctx)).metadata.saved).toBe(false)
      expect(JSON.parse(yield* Effect.promise(() => readFile(bpath, "utf8"))).entries[0].knowledge.confidence).toBe(0.5)
      const next = yield* svc.createRun({ taskID: task.id, candidateID: trial.id, stage: "full", status: "succeeded", metrics: { val_avg_mse: 0.25 }, resourceUsage: trialUsage })
      Database.use((db) => db.update(ResearchTaskTable).set({ session_id: null }).where(eq(ResearchTaskTable.id, task.id)).run())
      const keys = ["NEO_CAST_LLM_PROVIDER", "NEO_CAST_LLM_BASE_URL", "NEO_CAST_LLM_MODEL", "NEO_CAST_LLM_API_KEY"] as const
      const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
      const fetch = globalThis.fetch
      let writes: KnowledgeValidationDraft[] | undefined
      try {
        process.env.NEO_CAST_LLM_PROVIDER = "openai-compatible"
        process.env.NEO_CAST_LLM_BASE_URL = "http://knowledge.fixture/v1"
        process.env.NEO_CAST_LLM_MODEL = "fixture-model"
        process.env.NEO_CAST_LLM_API_KEY = "fixture-key"
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body))
          const input = JSON.parse(body.messages[1].content)
          expect(input.literatureKnowledge.currentRunID).toBe(next.id)
          expect(input.literatureKnowledge.entries[0].knowledge.assertions).toEqual(card.assertions)
          expect(input.literatureKnowledge.experimentFacts.find((f: ExperimentFact) => f.runID === next.id).executedModel).toEqual(usage.executionContract.manifest.actual)
          expect(input.knowledgeValidationSchema.properties.assertionIDs).toBeDefined()
          const content = JSON.stringify({
            trainingHealthAssessment: "Full metrics available.", hypothesisValidation: "Supports the scoped claim.",
            attributionAnalysis: "Only the recorded operation was tested.", historicalComparison: "Paired full runs.",
            modelDesignReflection: "Check transfer conditions.", nextStepRecommendation: "Validate another dataset.",
            distillableMemory: "A report alone does not update knowledge confidence.",
            ...(writes === undefined ? {} : { knowledgeValidations: writes }),
          })
          return body.stream
            ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
            : new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { "content-type": "application/json" } })
        }) as typeof globalThis.fetch
        const skipped = yield* svc.runReflectionAgent({ taskID: task.id, stoppedReason: "max_iterations" })
        expect(skipped.llm.status).toBe("used")
        expect(skipped.knowledgeValidationResults).toEqual([])
        expect(store.getCard(card.knowledgeID)?.confidence).toBe(0.51)
        writes = [{ ...request, runID: next.id }]
        const saved = yield* svc.runReflectionAgent({ taskID: task.id, stoppedReason: "max_iterations" })
        expect(saved.knowledgeValidationResults).toEqual([{ saved: true, cardID: card.knowledgeID, updated: true, confidence: 0.52 }])
        expect(store.getCard(card.knowledgeID)?.experimentValidations.at(-1)?.facts[0].primaryValue).toBe(0.25)
        const duplicate = yield* svc.runReflectionAgent({ taskID: task.id, stoppedReason: "max_iterations" })
        expect(duplicate.knowledgeValidationResults?.[0]).toMatchObject({ saved: true, updated: false, confidence: 0.52 })
      } finally {
        globalThis.fetch = fetch
        for (const key of keys) {
          if (prior[key] === undefined) delete process.env[key]
          else process.env[key] = prior[key]
        }
      }
    } finally { store.close() }
  }).pipe(Effect.provide(layer)), { git: true, config: { formatter: false, lsp: false } }), 30_000)
