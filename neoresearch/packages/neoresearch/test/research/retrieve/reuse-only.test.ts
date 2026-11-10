import { afterEach, expect, test } from "bun:test"
import path from "path"
import { mkdir, writeFile, readFile } from "fs/promises"
import { tmpdir } from "../../fixture/fixture"
import { principleFixture } from "../literature/principle-fixtures"
import { RetrieveAgent } from "../../../src/research/retrieve/retrieve-agent"
import { fixtureModel } from "./architecture-model-fixture"
import { report } from "./fixtures"
import { citableTaskEvidence } from "../../../src/research/retrieve/evidence-handoff"
import { createLiteraturePhase } from "../../../src/research/literature-phase-executor"

const previousPaperMode = process.env.NEO_RESEARCH_LITERATURE_PAPER_MODE
afterEach(() => {
  if (previousPaperMode === undefined) delete process.env.NEO_RESEARCH_LITERATURE_PAPER_MODE
  else process.env.NEO_RESEARCH_LITERATURE_PAPER_MODE = previousPaperMode
})

test("reuse-only skips PDF previews and new paper extraction while preserving architecture review", async () => {
  await using tmp = await tmpdir()
  const neoCastRoot = path.join(tmp.path, "neo_cast")
  const sourceRoot = path.join(neoCastRoot, ".neo-cast/literature-source")
  const documentRoot = path.join(neoCastRoot, ".neo-cast/literature-knowledge/documents")
  await mkdir(path.join(sourceRoot, "catalog"), { recursive: true })
  await mkdir(documentRoot, { recursive: true })
  const pdf = path.join(sourceRoot, "new-paper.pdf")
  await writeFile(pdf, "An unreadable PDF must never be opened in reuse-only mode")
  await writeFile(path.join(documentRoot, "unreadable.document.json"), "invalid document JSON")
  await writeFile(path.join(sourceRoot, "catalog/papers.jsonl"), JSON.stringify({ paper_id: "new-paper", title: "Seasonal time series with distribution shift",
    abstract: "Normalization and temporal prediction", download: { status: "downloaded", path: pdf } }) + "\n")
  const { card } = principleFixture()
  const { model, calls } = fixtureModel()
  let bridgeCalls = 0
  const agent = new RetrieveAgent({ neoCastRoot, workspaceRoot: tmp.path, principleModel: model,
    knowledgeSource: { listCards: () => [card], getCard: (id) => id === card.knowledgeID ? card : undefined },
    literatureAgent: { async run() { bridgeCalls++; throw new Error("New paper extraction is forbidden") } } })
  try {
    const input = { quantitativeReport: report(), paperMode: "reuse_only" as const, force: true }
    const prepared = await agent.prepare(input)
    expect(prepared.selectedCandidates).toEqual([])
    expect(prepared.index.manifest.sourceContentMode).toBe("metadata_and_cards")
    const paper = prepared.index.documents.find((item) => item.paperID === "new-paper")!
    expect(paper.previewError).toBeUndefined()
    expect(paper.fields.introduction).toBe("")
    const result = await agent.run(input, prepared)
    expect(bridgeCalls).toBe(0)
    expect(result.summary.literaturePaperCount).toBe(0)
    expect(calls).toEqual(["architecture_recall", "architecture_extract", "architecture_review", "architecture_curate"])
    expect(result.taskEvidence.architectureKnowledge?.decisions).toHaveLength(1)
    expect(citableTaskEvidence(result.taskEvidence).map((e) => e.cardID)).toEqual([card.knowledgeID])
    const manifest = JSON.parse(await readFile(path.join(neoCastRoot, ".neo-cast/literature-retrieval/runs", result.retrieveRunID, "run_manifest.json"), "utf8"))
    expect(manifest.paperMode).toBe("reuse_only")
    expect(manifest.literatureRunIDs).toEqual([])
  } finally { agent.close() }
})

test("reuse-only and normal extraction never share a retrieval cache", async () => {
  await using tmp = await tmpdir()
  const agent = new RetrieveAgent({ neoCastRoot: tmp.path, workspaceRoot: tmp.path,
    knowledgeSource: { listCards: () => [], getCard: () => undefined },
    literatureAgent: { async run() { throw new Error("No selected papers") } } })
  try {
    const normal = await agent.prepare({ quantitativeReport: report() })
    const reused = await agent.prepare({ quantitativeReport: report(), paperMode: "reuse_only" })
    expect(normal.paperMode).toBe("extract_missing")
    expect(normal.retrieveRunID).not.toBe(reused.retrieveRunID)
    expect(normal.index.indexDigest).not.toBe(reused.index.indexDigest)
    expect(reused.selectedCandidates).toEqual([])
  } finally { agent.close() }
})

test("the pipeline phase binds the selected environment policy without changing global agent defaults", async () => {
  await using tmp = await tmpdir()
  process.env.NEO_RESEARCH_LITERATURE_PAPER_MODE = "reuse_only"
  const phase = await createLiteraturePhase({ neoCastRoot: tmp.path, workspaceRoot: tmp.path,
    taskID: report().taskID, run: { quantitativeReport: report() } })
  expect(phase.snapshot.paperMode).toBe("reuse_only")
  expect(phase.snapshot.selectedCandidates).toEqual([])
  expect(phase.snapshot.index.manifest.sourceContentMode).toBe("metadata_and_cards")
  const direct = new RetrieveAgent({ neoCastRoot: tmp.path, workspaceRoot: tmp.path })
  try {
    const normal = await direct.prepare({ quantitativeReport: report() })
    expect(normal.paperMode).toBe("extract_missing")
  } finally { direct.close() }
})
