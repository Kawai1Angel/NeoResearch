import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { LiteratureAgent, type ParserSummary } from "../../../src/research/literature/literature-agent"
import { FixtureExtractionModel } from "../../../src/research/literature/extraction-model"
import { candidate, chunk, document } from "./fixtures"

test("fixture model produces deterministic auditable run artifacts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "literature-agent-"))
  const neoCastRoot = path.join(root, "neo_cast")
  const knowledgeRoot = path.join(root, "knowledge")
  const documentDir = path.join(knowledgeRoot, "documents", document().paperID)
  await mkdir(path.join(neoCastRoot, "literature_knowledge"), { recursive: true })
  await mkdir(documentDir, { recursive: true })
  await writeFile(path.join(neoCastRoot, "literature_knowledge", "taxonomy.v1.json"), JSON.stringify({
    schemaVersion: "literature_taxonomy_v1", mechanisms: { patch_encoding: ["patch-based encoding"] }, data_features: {}, task_types: { forecasting: ["forecast"] },
  }))
  const documentPath = path.join(documentDir, `${document().sourceSha256}.document.json`)
  const chunksPath = path.join(documentDir, `${document().sourceSha256}.chunks.jsonl`)
  const paperPath = path.join(documentDir, `${document().sourceSha256}.paper.json`)
  await writeFile(documentPath, JSON.stringify(document()))
  await writeFile(chunksPath, `${JSON.stringify(chunk())}\n`)
  await writeFile(paperPath, JSON.stringify({ publication_status: "peer_reviewed", publication_verification: "official_proceedings" }))
  const parserSummary: ParserSummary = {
    status: "parsed", paperID: document().paperID, documentID: document().documentID,
    documentPath, chunksPath, chunkCount: 1, warningCount: 0, publicationStatus: "peer_reviewed",
  }
  const sourceChunk = chunk()
  const model = new FixtureExtractionModel({ [sourceChunk.chunkID]: [candidate()] })
  const agent = new LiteratureAgent({
    neoCastRoot, workspaceRoot: root, knowledgeRoot, model,
    documentParser: async () => parserSummary,
  })
  try {
    const result = await agent.run({ sources: [{ kind: "catalog_paper", paperID: document().paperID }] })
    expect(result.summary).toMatchObject({ paperCount: 1, acceptedCardCount: 1, paperBackedCount: 1, failedCount: 0 })
    expect(result.processed[0].status).toBe("completed")
    const runRoot = path.join(knowledgeRoot, "runs", result.runIDs[0])
    expect(await readFile(path.join(runRoot, "accepted_cards.jsonl"), "utf8")).toContain("paper_backed")
    expect(await readFile(path.join(runRoot, "review.md"), "utf8")).toContain("p.3")
    expect(await readFile(path.join(knowledgeRoot, "exports", "knowledge_cards.jsonl"), "utf8")).toContain("knowledge_card_v1")
    const repeated = await agent.run({ sources: [{ kind: "catalog_paper", paperID: document().paperID }] })
    expect(repeated.runIDs).toEqual(result.runIDs)
    expect(agent.validate().cardCount).toBe(1)
  } finally {
    agent.close()
  }
})

test("one source failure does not roll back another source", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "literature-agent-batch-"))
  const neoCastRoot = path.join(root, "neo_cast")
  await mkdir(path.join(neoCastRoot, "literature_knowledge"), { recursive: true })
  await writeFile(path.join(neoCastRoot, "literature_knowledge", "taxonomy.v1.json"), JSON.stringify({ schemaVersion: "literature_taxonomy_v1", mechanisms: {}, data_features: {}, task_types: {} }))
  let calls = 0
  const agent = new LiteratureAgent({
    neoCastRoot, workspaceRoot: root, knowledgeRoot: path.join(root, "knowledge"), model: new FixtureExtractionModel({}),
    documentParser: async () => { calls += 1; throw new Error(`fixture failure ${calls}`) },
  })
  try {
    const result = await agent.run({ sources: [{ kind: "catalog_paper", paperID: "one" }, { kind: "catalog_paper", paperID: "two" }] })
    expect(result.processed).toHaveLength(2)
    expect(result.summary.failedCount).toBe(2)
    expect(result.processed[0]!.error).toContain("fixture failure")
  } finally {
    agent.close()
  }
})
