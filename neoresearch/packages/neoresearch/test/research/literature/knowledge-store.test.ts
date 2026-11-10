import { expect, test } from "bun:test"
import { mkdtemp } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { KnowledgeStore } from "../../../src/research/literature/knowledge-store"
import { card, chunk, document } from "./fixtures"

test("knowledge store preserves revisions and can restore an older revision", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "literature-store-"))
  const store = new KnowledgeStore(path.join(root, "knowledge.db"))
  try {
    store.transaction(() => store.saveDocument({ document: document(), chunks: [chunk()], documentPath: "/tmp/document.json", parseStatus: "parsed" }))
    const first = store.transaction(() => store.saveCard(card()))
    expect(first.revision).toBe(1)
    const edited = store.transaction(() => store.reviseCard(first.cardID, { claim: "A human-narrowed claim supported by the same evidence." }, "reviewer", "narrow scope"))
    expect(edited.revision).toBe(2)
    const restored = store.transaction(() => store.restoreRevision(first.cardID, 1, "reviewer", "restore fixture"))
    expect(restored.revision).toBe(3)
    expect(restored.claim).toBe(first.claim)
  } finally {
    store.close()
  }
})

test("a failed transaction does not persist a partial card", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "literature-store-rollback-"))
  const store = new KnowledgeStore(path.join(root, "knowledge.db"))
  try {
    store.transaction(() => store.saveDocument({ document: document(), chunks: [chunk()], documentPath: "/tmp/document.json", parseStatus: "parsed" }))
    expect(() => store.transaction(() => {
      store.saveCard(card())
      throw new Error("fixture crash")
    })).toThrow("fixture crash")
    expect(store.listCards()).toEqual([])
  } finally {
    store.close()
  }
})
