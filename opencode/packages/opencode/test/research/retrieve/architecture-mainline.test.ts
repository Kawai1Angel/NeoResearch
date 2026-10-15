import { expect, test } from "bun:test"
import path from "path"
import { mkdir, writeFile, readFile } from "fs/promises"
import { tmpdir } from "../../fixture/fixture"
import { principleFixture } from "../literature/principle-fixtures"
import type { PrincipleModel } from "../../../src/research/literature/principle-model"
import { RetrieveAgent } from "../../../src/research/retrieve/retrieve-agent"
import { report } from "./fixtures"
import { citableTaskEvidence, projectTaskEvidence, projectCitedTaskEvidence } from "../../../src/research/retrieve/evidence-handoff"
import { validateHypothesisEvidence } from "../../../src/research/agents/hypo-planner-agent"
import { loadArchitectureCorpus } from "../../../src/research/retrieve/architecture-corpus"
import { distillArchitectureKnowledge } from "../../../src/research/retrieve/architecture-distiller"
import { ArchitecturePacketSchema } from "../../../src/research/retrieve/architecture-packet"
import { fixtureModel } from "./architecture-model-fixture"
import { compactPromptContext } from "../../../src/research/prompt-context"


test("normal RetrieveAgent automatically distills broad cards, persists decisions, and restricts planner/designer citations", async () => {
  await using tmp = await tmpdir()
  const a = principleFixture().card
  const b = principleFixture((c) => { c.candidateID = "other"; c.transferableInsight = "Another complete source relationship" }).card
  const cards = [a, b]
  const { model, calls } = fixtureModel(b.knowledgeID)
  const events: any[] = []
  const agent = new RetrieveAgent({ neoCastRoot: path.join(tmp.path, "neo_cast"), workspaceRoot: tmp.path, principleModel: model,
    knowledgeSource: { listCards: () => cards, getCard: (id) => cards.find((c) => c.knowledgeID === id) },
    literatureAgent: { async run() { throw new Error("No new paper extraction needed") } },
    onProgress: async (e) => { events.push(e) } })
  try {
    const result = await agent.run({ quantitativeReport: report() })
    expect(calls).toEqual(["architecture_recall", "architecture_extract", "architecture_review", "architecture_curate"])
    const knowledge = result.taskEvidence.architectureKnowledge!
    expect(knowledge.consideredCardCount).toBe(2)
    expect(knowledge.decisions).toHaveLength(1)
    expect(knowledge.sourceCards.map((c) => c.knowledgeID)).toEqual([b.knowledgeID])
    expect(result.summary.architectureDecisionCount).toBe(1)
    expect(events.find((e) => e.step === "select").counts).toMatchObject({ new_papers: 0, reused_papers: 1, reused_cards: 2 })
    expect(events.some((e) => e.step === "review_architecture" && e.counts?.decisions === 1)).toBe(true)
    const packet = projectTaskEvidence(result.taskEvidence)
    expect(packet.entries.map((e) => e.cardID)).toEqual([b.knowledgeID])
    expect(compactPromptContext({ taskEvidence: packet })).toEqual({ taskEvidence: packet })
    const citation = { cardID: b.knowledgeID, cardRevision: b.revision, role: "supports_mechanism" as const }
    expect(projectCitedTaskEvidence(result.taskEvidence, [citation]).architectureKnowledge?.decisions).toHaveLength(1)
    expect(() => projectCitedTaskEvidence(result.taskEvidence, [{ ...citation, cardID: a.knowledgeID }])).toThrow("stale")
    expect(() => projectCitedTaskEvidence(result.taskEvidence, [{ ...citation, cardRevision: 999 }])).toThrow("stale")
    const h = { id: "H1", status: "pending" as const, statement: "Use a shared phase predictor", motivation: [], expectedOutcome: "fewer parameters",
      suggestedBackbones: [], suggestedPreprocessing: [], risk: "conditional", testable: true, evidenceLevel: "paper_supported" as const,
      datasetEvidencePaths: knowledge.datasetEvidencePaths.slice(0, 1), literatureEvidence: [citation], applicabilityAssumptions: ["Only if phase is stable"], falsificationCriteria: ["No improvement in the current architecture"] }
    expect(() => validateHypothesisEvidence([h], result.taskEvidence)).not.toThrow()
    expect(() => validateHypothesisEvidence([{ ...h, literatureEvidence: [{ ...citation, cardID: a.knowledgeID }] }], result.taskEvidence)).toThrow("unknown")
    const saved = JSON.parse(await readFile(path.join(tmp.path, "neo_cast/.neo-cast/literature-retrieval/runs", result.retrieveRunID, "architecture_knowledge.json"), "utf8"))
    expect(saved).toEqual(knowledge)
    await agent.run({ quantitativeReport: report() })
    expect(calls).toHaveLength(4)
    expect(cards).toEqual([a, b])
  } finally { agent.close() }
})

test("an unavailable or failed architecture review never falls back to raw accepted cards", async () => {
  await using tmp = await tmpdir()
  const { card } = principleFixture()
  const agent = new RetrieveAgent({ neoCastRoot: tmp.path, workspaceRoot: tmp.path,
    knowledgeSource: { getCard: () => card, listCards: () => [card] },
    literatureAgent: { async run() { throw new Error("No new papers") } } })
  try {
    const result = await agent.run({ quantitativeReport: report() })
    expect(result.taskEvidence.entries.length).toBeGreaterThan(0) // Source audit retained.
    expect(result.taskEvidence.readiness).toBe("ready_data_only")
    expect(result.taskEvidence.architectureKnowledge?.status).toBe("unavailable")
    expect(citableTaskEvidence(result.taskEvidence)).toEqual([])
  } finally { agent.close() }
  const bad: PrincipleModel = { modelIdentifier: "invalid", async request() { return { text: '{"selected":["invented"],"excluded":[]}' } } }
  const packet = await distillArchitectureKnowledge({ corpus: { cards: [card], historicalCardIDs: [], digest: "fixture", warnings: [] },
    model: bad, task: {}, datasetEvidencePaths: [], maxDecisions: 12, auditRoot: path.join(tmp.path, "bad") })
  expect(packet.status).toBe("partial")
  expect(packet.decisions).toEqual([])
  expect(packet.sourceCards).toEqual([])
})

test("historical cards are source-checked, freshly reviewed, and do not overwrite current publications", async () => {
  await using tmp = await tmpdir()
  const { card, context } = principleFixture()
  const historical = { ...card, provenance: { ...card.provenance, verifierVersion: "old-review" } }
  const archive = path.join(tmp.path, ".neo-cast/literature-reruns/history")
  await mkdir(archive, { recursive: true })
  await writeFile(path.join(archive, "knowledge_cards_v2.jsonl"), JSON.stringify(historical) + "\n")
  const chunks = path.join(archive, `${card.provenance.documentSha256}.chunks.jsonl`)
  await writeFile(chunks, context.chunks.map((c) => JSON.stringify(c)).join("\n"))
  const corpus = await loadArchitectureCorpus({ activeCards: [], neoCastRoot: tmp.path })
  expect(corpus.historicalCardIDs).toEqual([card.knowledgeID])
  const { model } = fixtureModel()
  const packet = await distillArchitectureKnowledge({ corpus, model, task: { quantitativeReport: report() }, datasetEvidencePaths: [], maxDecisions: 12, auditRoot: path.join(tmp.path, "audit") })
    expect(packet.decisions).toHaveLength(1)
  expect(ArchitecturePacketSchema.parse(packet).sourceCards[0]).toEqual(historical)
  const changed = structuredClone(packet)
  changed.decisions[0]!.citations.condition[0]!.sourceIDs = ["invented"]
  expect(() => ArchitecturePacketSchema.parse(changed)).toThrow()
  await writeFile(chunks, context.chunks.map((c) => JSON.stringify({ ...c, text: "changed original text" })).join("\n"))
  expect((await loadArchitectureCorpus({ activeCards: [], neoCastRoot: tmp.path })).cards).toEqual([])
  expect((await loadArchitectureCorpus({ activeCards: [card], neoCastRoot: tmp.path })).cards).toEqual([card])
})

test("failed semantic checks or an incomplete final curation cannot authorize source citations", async () => {
  await using tmp = await tmpdir()
  const { card } = principleFixture()
  for (const stage of ["architecture_review", "architecture_curate"] as const) {
    const fixture = fixtureModel()
    const model: PrincipleModel = { modelIdentifier: `invalid-${stage}`, async request(current, payload) {
      const response = await fixture.model.request(current, payload)
      if (current !== stage) return response
      const value = JSON.parse(response.text)
      if (stage === "architecture_review") value.reviews[0].checks.sourceFaithful = false
      else value.selectedDecisionIDs = [] // Missing exclusion breaks the final complete partition.
      return { text: JSON.stringify(value) }
    } }
    const packet = await distillArchitectureKnowledge({ corpus: { cards: [card], historicalCardIDs: [], digest: "fixture", warnings: [] },
      model, task: { quantitativeReport: report() }, datasetEvidencePaths: [], maxDecisions: 12, auditRoot: path.join(tmp.path, stage) })
    expect(packet.status).toBe("partial")
    expect(packet.decisions).toEqual([])
    expect(packet.sourceCards).toEqual([])
    expect(fixture.calls.filter((s) => s === stage)).toHaveLength(2)
  }
})

test("the global source shortlist can retain useful family evidence after the round-robin reading cutoff", async () => {
  await using tmp = await tmpdir()
  const cards = Array.from({ length: 41 }, (_, i) => principleFixture((c) => {
    c.candidateID = `candidate-${i}`
    c.paperID = `paper-${i}`
    c.transferableInsight = `Synthetic distinct discovery lead ${i}`
  }).card)
  const strongest = cards.at(-1)!
  const fixture = fixtureModel()
  let recallCalls = 0
  const model: PrincipleModel = { modelIdentifier: "global-family-shortlist", async request(stage, payload) {
    if (stage === "architecture_recall" && ++recallCalls === 4) {
      const supplied = payload.cards as { cardID: string }[]
      expect(supplied).toHaveLength(41)
      return { text: JSON.stringify({ selected: [strongest.knowledgeID],
        excluded: supplied.filter((c) => c.cardID !== strongest.knowledgeID).map((c) => ({ cardID: c.cardID, reason: "Less useful synthetic family evidence" })) }) }
    }
    return fixture.model.request(stage, payload)
  } }
  const packet = await distillArchitectureKnowledge({ corpus: { cards, historicalCardIDs: [], digest: "shortlist", warnings: [] },
    model, task: { quantitativeReport: report() }, datasetEvidencePaths: [], maxDecisions: 12, auditRoot: path.join(tmp.path, "audit") })
  expect(recallCalls).toBe(4)
  expect(packet.status).toBe("completed")
  expect(packet.readCardCount).toBe(1)
  expect(packet.sourceCards.map((c) => c.knowledgeID)).toEqual([strongest.knowledgeID])
  expect(packet.exclusions.filter((e) => e.stage === "reading_shortlist")).toHaveLength(40)
})

test("invalid global shortlisting cannot silently fall back to card-order selection", async () => {
  await using tmp = await tmpdir()
  const cards = Array.from({ length: 41 }, (_, i) => principleFixture((c) => {
    c.candidateID = `candidate-${i}`
    c.paperID = `paper-${i}`
    c.transferableInsight = `Synthetic distinct lead ${i}`
  }).card)
  const fixture = fixtureModel()
  const model: PrincipleModel = { modelIdentifier: "bad-global-shortlist", async request(stage, payload) {
    if (stage === "architecture_recall" && (payload.cards as unknown[]).length > 16) return { text: JSON.stringify({ selected: [], excluded: [] }) }
    return fixture.model.request(stage, payload)
  } }
  const packet = await distillArchitectureKnowledge({ corpus: { cards, historicalCardIDs: [], digest: "bad-shortlist", warnings: [] },
    model, task: { quantitativeReport: report() }, datasetEvidencePaths: [], maxDecisions: 12, auditRoot: path.join(tmp.path, "audit") })
  expect(packet.status).toBe("partial")
  expect(packet.readCardCount).toBe(0)
  expect(packet.decisions).toEqual([])
  expect(fixture.calls).not.toContain("architecture_extract")
})

test("a malformed sibling review does not discard an independently reviewed family decision", async () => {
  await using tmp = await tmpdir()
  const bad = principleFixture().card
  const good = principleFixture((c) => { c.candidateID = "good"; c.transferableInsight = "A separate synthetic family rule" }).card
  const fixture = fixtureModel()
  const model: PrincipleModel = { modelIdentifier: "isolated-source-recovery", async request(stage, payload) {
    const response = await fixture.model.request(stage, payload)
    if (stage !== "architecture_review") return response
    const value = JSON.parse(response.text)
    for (const r of value.reviews) if (r.reviewedSources.some((s: any) => s.cardID === bad.knowledgeID)) r.checks.sourceFaithful = false
    return { text: JSON.stringify(value) }
  } }
  const packet = await distillArchitectureKnowledge({ corpus: { cards: [bad, good], historicalCardIDs: [], digest: "isolated", warnings: [] },
    model, task: { quantitativeReport: report() }, datasetEvidencePaths: [], maxDecisions: 12, auditRoot: path.join(tmp.path, "audit") })
  expect(packet.status).toBe("partial")
  expect(packet.decisions).toHaveLength(1)
  expect(packet.sourceCards.map((c) => c.knowledgeID)).toEqual([good.knowledgeID])
  expect(packet.exclusions.some((e) => e.stage === "source_review_failed")).toBe(true)
  expect(fixture.calls.filter((stage) => stage === "architecture_review")).toHaveLength(3)
  expect(citableTaskEvidence({ entries: [], architectureKnowledge: packet } as any).map((e) => e.cardID)).toEqual([good.knowledgeID])
})
