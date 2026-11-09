import { expect, test } from "bun:test"
import path from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "../../fixture/fixture"
import { LiteratureAgent } from "../../../src/research/literature/literature-agent"
import { KnowledgeV2Store } from "../../../src/research/literature/knowledge-v2-store"
import { KnowledgeStore } from "../../../src/research/literature/knowledge-store"
import { KnowledgeCandidateSchema } from "../../../src/research/literature/knowledge-v2-contract"
import { RetrieveAgent } from "../../../src/research/retrieve/retrieve-agent"
import { TaskEvidenceBundleSchema } from "../../../src/research/retrieve/contract"
import { projectTaskEvidence, projectCitedTaskEvidence } from "../../../src/research/retrieve/evidence-handoff"
import { buildPrincipleTaskEvidence } from "../../../src/research/retrieve/principle-evidence"
import { fixture, activeFixture, report } from "../retrieve/fixtures"
import { principleFixture } from "./principle-fixtures"
import { fixtureModel as architectureModel } from "../retrieve/architecture-model-fixture"
import { fixtureModel, document } from "./principle-model-fixture"

// This verifies plumbing and evidence integrity with synthetic sources, not scientific accuracy.
test("main LiteratureAgent publishes reviewed v2, caches extraction, and feeds complete cards into a new task", async () => {
  await using tmp = await tmpdir()
  const source = principleFixture()
  const { schemaVersion, knowledgeID, revision, review, provenance, confidence, experimentValidations, ...fields } = source.card
  const candidate = KnowledgeCandidateSchema.parse({ ...fields, schemaVersion: "knowledge_candidate_v2" })
  const { model, requests } = fixtureModel((stage, payload, value) => stage === "synthesize" ? { candidates: [candidate], unformed: [] } : value)
  const documentPath = path.join(tmp.path, "source.document.json"), chunksPath = path.join(tmp.path, "chunks.jsonl")
  await writeFile(documentPath, JSON.stringify({ ...document, sourceSha256: source.context.documentSha256,
    pages: [{ pageNumber: 1, text: source.context.chunks[0].text, blocks: [] }] }))
  await writeFile(chunksPath, source.context.chunks.map((c) => JSON.stringify(c)).join("\n"))
  const knowledgeRoot = path.join(tmp.path, "knowledge")
  const agent = new LiteratureAgent({ neoCastRoot: tmp.path, workspaceRoot: tmp.path, knowledgeRoot, principleModel: model,
    documentParser: async () => ({ status: "parsed", paperID: "paper", documentID: "doc", documentPath, chunksPath,
      chunkCount: 1, warningCount: 0, publicationStatus: "unknown" }) })
  const store = new KnowledgeV2Store(path.join(knowledgeRoot, "knowledge.db"))
  const legacy = new KnowledgeStore(path.join(knowledgeRoot, "knowledge.db"))
  const retrieval = new RetrieveAgent({ neoCastRoot: tmp.path, workspaceRoot: tmp.path, knowledgeRoot, principleModel: architectureModel().model })
  try {
    const input = { sources: [{ kind: "catalog_paper" as const, paperID: "paper" }] }
    const built = await agent.run(input)
    expect(built.processed[0].status).toBe("completed")
    expect(built.processed[0].acceptedCardIDs).toHaveLength(1)
    const id = built.processed[0].acceptedCardIDs[0]
    expect(id).toMatch(/^kn_[a-f0-9]{24}$/)
    expect(legacy.listCards()).toEqual([])
    expect(agent.validate()).toMatchObject({ cardCount: 1, schemaVersion: "knowledge_card_v2" })
    const calls = requests.length
    expect((await agent.run(input)).runIDs).toEqual(built.runIDs)
    expect(requests).toHaveLength(calls)
    const exported = JSON.parse((await readFile(path.join(knowledgeRoot, "exports/knowledge_cards_v2.jsonl"), "utf8")).trim())
    expect(exported).toEqual(store.getCard(id))
    const retrieved = await retrieval.run({ quantitativeReport: report() })
    expect(retrieved.taskEvidence.schemaVersion).toBe("task_evidence_bundle_v2")
    const entry = retrieved.taskEvidence.entries.find((e) => e.cardID === id)!
    expect(entry.knowledge).toEqual(store.getCard(id))
    expect(entry.confidence).toBeUndefined()
    expect((await agent.showRun(built.runIDs[0])).run.schema_versions_json).toContain("knowledge_card_v2")
    const packet = projectCitedTaskEvidence(retrieved.taskEvidence, [{ cardID: id, cardRevision: entry.cardRevision, role: entry.roles[0] }])
    expect(packet.entries[0].knowledge?.falsification).toEqual(candidate.falsification)
    expect(packet.entries[0].knowledge?.support).toEqual(entry.knowledge!.support)
    expect(packet.entries[0].knowledge?.mechanism.attribution).toBe("source_explanation")
    await agent.run({ ...input, options: { force: true } })
    expect(requests.length).toBeGreaterThan(calls)
    expect(store.getCard(id)?.revision).toBe(2)
    expect((await retrieval.run({ quantitativeReport: report() })).retrieveRunID).not.toBe(retrieved.retrieveRunID)
    store.retire(id)
    expect((await agent.run(input)).processed[0].acceptedCardIDs).toEqual([])
    expect(store.listCards()).toEqual([])
  } finally { retrieval.close(); legacy.close(); store.close(); agent.close() }
})

test("v2 store rejects edited reviews, forged identities and quotes; preserves immutable revisions and legacy tables", async () => {
  await using tmp = await tmpdir()
  const store = new KnowledgeV2Store(path.join(tmp.path, "knowledge.db"))
  try {
    const { card, context } = principleFixture()
    store.publish([card], context, true)
    expect(() => store.publish([{ ...card, unknowns: ["unreviewed edit"] }], context, true)).toThrow("stale_review")
    expect(() => store.publish([{ ...card, knowledgeID: `kn_${"0".repeat(24)}` }], context, true)).toThrow("identity")
    expect(() => store.publish([card], { ...context, chunks: [{ ...context.chunks[0], text: "tampered" }] }, true)).toThrow("source_unavailable")
    expect(store.listCards()).toEqual([card])
    store.publish([], context, false)
    expect(store.listCards()).toHaveLength(1)
    store.publish([], context, true)
    expect(store.listCards()).toEqual([])
  } finally { store.close() }
})

test("v2 handoff preserves counterevidence and experimental missingness, and cannot accept fragments or stale seals", () => {
  const data = fixture()
  const source = principleFixture((c) => {
    c.paperID = "paper-frequency"
    c.support.push({ evidenceID: "counter", assertionIDs: ["e"], sourceIDs: ["s"], relation: "refutes", kind: "experiment", experimentID: "exp" })
    c.epistemicStatus = "mixed_evidence"
    const absent = { status: "not_reported" as const, reason: "Synthetic source does not report this field" }
    c.experiments.push({ experimentID: "exp", studyID: "study", intervention: absent, comparator: absent, dataset: absent, split: absent,
      contextLength: absent, predictionLength: absent, metric: absent, metricDirection: "not_reported", repetitions: absent,
      uncertainty: absent, result: absent, control: "unclear", confounds: ["No isolation"], sourceIDs: ["s"] })
  })
  const bundle = buildPrincipleTaskEvidence({ ...data, report: data.quantitative, retrieveRunID: "retrieve_fixture", quantitativeReportArtifactID: "artifact_fixture",
    literatureResults: data.literatureResults.map((p) => ({ ...p, acceptedCardIDs: [source.card.knowledgeID] })),
    knowledgeSource: { getCard: () => source.card }, budgets: { maxIntents: 6, maxCandidatesPerIntent: 12, maxLiteraturePapersPerIntent: 3,
      maxLiteraturePapersTotal: 12, maxTaskEvidenceEntries: 12, maxTaskEvidencePerIntent: 4 } })
  expect(bundle.readiness).toBe("evidence_conflict")
  const knowledge = projectTaskEvidence(bundle).entries[0].knowledge!
  expect(knowledge.support.some((s) => s.relation === "refutes")).toBe(true)
  expect(knowledge.experiments[0].dataset.status).toBe("not_reported")
  expect(knowledge).toEqual(source.card)
  const valid = activeFixture()
  expect(TaskEvidenceBundleSchema.safeParse(valid).success).toBe(true)
  expect(TaskEvidenceBundleSchema.safeParse({ ...valid, entries: valid.entries.map((e) => ({ ...e, knowledge: undefined })) }).success).toBe(false)
  expect(TaskEvidenceBundleSchema.safeParse({ ...valid, entries: valid.entries.map((e) => ({ ...e, knowledge: { ...e.knowledge, unknowns: ["silently edited"] } })) }).success).toBe(false)
})


test("a publication cap defers cards without scientific rejection or retiring prior reviewed knowledge", async () => {
  await using tmp = await tmpdir()
  const source = principleFixture()
  const { schemaVersion, knowledgeID, revision, review, provenance, confidence, experimentValidations, ...fields } = source.card
  const first = KnowledgeCandidateSchema.parse({ ...fields, schemaVersion: "knowledge_candidate_v2" })
  const second = KnowledgeCandidateSchema.parse({ ...first, candidateID: "second", principle: first.principle + " Second synthetic contribution." })
  second.assertions[0].statement = second.principle
  const { model } = fixtureModel((stage, payload, value) => {
    if (stage === "plan") return { plans: [first, second].map((c) => ({ planID: c.candidateID, contributionIndexes: [0], focus: c.principle })), unformed: [] }
    if (stage === "synthesize") return { candidates: [(payload.focus as { planID: string }).planID === "second" ? second : first], unformed: [] }
    return value
  })
  const documentPath = path.join(tmp.path, "document.json"), chunksPath = path.join(tmp.path, "chunks.jsonl")
  await writeFile(documentPath, JSON.stringify({ ...document, sourceSha256: source.context.documentSha256, pages: [{ pageNumber: 1, text: source.context.chunks[0].text, blocks: [] }] }))
  await writeFile(chunksPath, source.context.chunks.map((c) => JSON.stringify(c)).join("\n"))
  const knowledgeRoot = path.join(tmp.path, "knowledge")
  const agent = new LiteratureAgent({ neoCastRoot: tmp.path, workspaceRoot: tmp.path, knowledgeRoot, principleModel: model,
    documentParser: async () => ({ status: "parsed", paperID: "paper", documentID: "doc", documentPath, chunksPath, chunkCount: 1, warningCount: 0, publicationStatus: "unknown" }) })
  const store = new KnowledgeV2Store(path.join(knowledgeRoot, "knowledge.db"))
  try {
    const input = { sources: [{ kind: "catalog_paper" as const, paperID: "paper" }] }
    const initial = await agent.run(input)
    expect(initial.processed[0].acceptedCardIDs).toHaveLength(2)
    const limited = await agent.run({ ...input, options: { force: true, maxCardsPerPaper: 1 } })
    expect(limited.processed[0].acceptedCardIDs).toHaveLength(1)
    const result = JSON.parse(await readFile(path.join(knowledgeRoot, "principle-runs", limited.runIDs[0], "result.json"), "utf8"))
    expect(result.deferred).toMatchObject([{ candidateID: "second", reason: "selection_budget" }])
    expect(result.rejected).toEqual([])
    expect(store.listCards()).toHaveLength(2)
  } finally { store.close(); agent.close() }
})
