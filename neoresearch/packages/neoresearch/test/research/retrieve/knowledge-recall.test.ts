import { expect, test } from "bun:test"
import path from "path"
import { readFile } from "node:fs/promises"
import { tmpdir } from "../../fixture/fixture"
import { KnowledgeV2Store } from "../../../src/research/literature/knowledge-v2-store"
import { principleFixture } from "../literature/principle-fixtures"
import { CURRENT_EVIDENCE_VERIFIER_VERSION } from "../../../src/research/literature/validation-versions"
import { RetrieveAgent } from "../../../src/research/retrieve/retrieve-agent"
import { projectTaskEvidence } from "../../../src/research/retrieve/evidence-handoff"
import { recallKnowledge } from "../../../src/research/retrieve/knowledge-recall"
import { DEFAULT_RETRIEVAL_BUDGETS } from "../../../src/research/retrieve/contract"
import { document, chunk } from "../literature/fixtures"
import { fixture, frequencyCard, report } from "./fixtures"

test("historical recall keeps execution compatibility gates and source-bound reviews", () => {
  const data = fixture()
  const { card: unsupported } = principleFixture((c) => { c.intervention.operation = "wavelet decomposition"; c.intervention.necessaryComponents.push("wavelet decomposition") })
  const input = { cards: [unsupported], report: data.quantitative, taskContext: data.taskContext,
    transformations: data.transformations, intents: data.intents, budgets: DEFAULT_RETRIEVAL_BUDGETS }
  const blocked = recallKnowledge(input)
  expect(blocked.candidates.length).toBeGreaterThan(0)
  expect(blocked.candidates.every((item) => item.decision === "unsupported_model_recipe")).toBe(true)
  expect(blocked.papers).toEqual([])
  const review = { paperID: unsupported.paperID, sourceSha256: unsupported.provenance.documentSha256,
    verdict: "adaptable" as const, reason: "Explicit adaptation reviewed" }
  expect(recallKnowledge({ ...input, compatibilityReviews: [review] }).papers).toHaveLength(1)
  expect(recallKnowledge({ ...input, compatibilityReviews: [{ ...review, sourceSha256: "b".repeat(64) }] }).papers).toEqual([])
  expect(recallKnowledge({ ...input, cards: [unsupported], compatibilityReviews: [{ ...review, verdict: "exclude" }] }).papers).toEqual([])
})

test("shared v2 knowledge works across tasks without PDFs, export files or re-extraction", async () => {
  await using tmp = await tmpdir()
  const knowledgeRoot = path.join(tmp.path, "shared-knowledge")
  const knowledge = new KnowledgeV2Store(path.join(knowledgeRoot, "knowledge.db"))
  const { card: original, context } = principleFixture()
  const source = context.chunks[0]
  knowledge.publish([original], context, true)
  let calls = 0
  const agent = new RetrieveAgent({ neoCastRoot: path.join(tmp.path, "neo_cast"), workspaceRoot: tmp.path, knowledgeRoot,
    literatureAgent: { async run() { calls++; throw new Error("Stored evidence should be reused") } } })
  try {
    const taskA = report()
    const first = await agent.run({ quantitativeReport: taskA })
    expect(calls).toBe(0)
    expect(first.summary.literaturePaperCount).toBe(0)
    expect(first.summary.bm25CandidateCount).toBe(0)
    expect(first.summary.paperBackedCardCount).toBe(1)
    expect(first.candidates.every((item) => item.recallRoute === "knowledge_store")).toBe(true)
    expect(first.literatureResults[0]).toMatchObject({ status: "reused_knowledge", cardRevisions: { [original.knowledgeID]: 1 } })
    const a = first.taskEvidence.entries.find((item) => item.cardID === original.knowledgeID)!
    expect(a.applicability.status).toBe("matched")
    expect(a.evidenceRefs[0]!.evidenceSpan).toBe(source.text)
    expect(a.knowledge).toEqual(original)
    // Reuse preserves source audit; a configured architecture reviewer must authorize downstream use.
    expect(projectTaskEvidence(first.taskEvidence).entries).toEqual([])
    expect(first.taskEvidence.architectureKnowledge?.status).toBe("unavailable")
    const repeated = await agent.run({ quantitativeReport: taskA })
    expect(repeated).toEqual(first)

    const taskB = report()
    taskB.taskID = "researchTask_unseen"
    taskB.domain = "wind_power"
    taskB.dataset.knownFutureCovariates = []
    const second = await agent.run({ quantitativeReport: taskB })
    const b = second.taskEvidence.entries.find((item) => item.cardID === original.knowledgeID)!
    expect(second.retrieveRunID).not.toBe(first.retrieveRunID)
    expect(b.applicability.status).toBe("conflicted")
    expect(b.roles).toEqual(["warns_limitation"])
    expect(second.taskEvidence.summary.coveredIntentCount).toBe(0)
    expect(second.taskEvidence.gaps.every((item) => item.reason !== "no_local_pdf")).toBe(true)
    expect(knowledge.getCard(original.knowledgeID)).toEqual(original)

    knowledge.publish([original], context, true)
    const revised = await agent.run({ quantitativeReport: taskA })
    expect(revised.retrieveRunID).not.toBe(first.retrieveRunID)
    expect(revised.taskEvidence.entries[0]!.cardRevision).toBe(2)
    const archived = JSON.parse(await readFile(path.join(tmp.path, "neo_cast", ".neo-cast", "literature-retrieval",
      "runs", first.retrieveRunID, "task_evidence_bundle.json"), "utf8"))
    expect(archived.entries[0].cardRevision).toBe(1)
    knowledge.retire(original.knowledgeID)
    const withdrawn = await agent.run({ quantitativeReport: taskA })
    expect(withdrawn.retrieveRunID).not.toBe(revised.retrieveRunID)
    expect(withdrawn.taskEvidence.entries).toEqual([])
    expect(calls).toBe(0)
  } finally {
    agent.close()
    knowledge.close()
  }
})

test("a recalled revision cannot silently change between preparation and handoff", async () => {
  await using tmp = await tmpdir()
  let stored = principleFixture().card
  const agent = new RetrieveAgent({ neoCastRoot: path.join(tmp.path, "neo_cast"), workspaceRoot: tmp.path,
    knowledgeSource: { getCard: () => stored, listCards: () => [stored], listRelations: () => [] },
    literatureAgent: { async run() { throw new Error("Unexpected extraction") } } })
  try {
    const input = { quantitativeReport: report() }
    await agent.run(input)
    const prepared = await agent.prepare(input)
    stored = { ...stored, revision: stored.revision + 1 }
    await expect(agent.run(input, prepared)).rejects.toThrow("Knowledge snapshot changed")
  } finally {
    agent.close()
  }
})

test("v1 history cannot be recalled or silently upgraded", () => {
  const data = fixture()
  const recalled = recallKnowledge({ cards: [frequencyCard()], report: data.quantitative, taskContext: data.taskContext,
    transformations: data.transformations, intents: data.intents, budgets: DEFAULT_RETRIEVAL_BUDGETS })
  expect(recalled.candidates).toEqual([])
})
