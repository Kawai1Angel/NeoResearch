import { expect, test } from "bun:test"
import { buildSourceRegistry, hydrateCandidateSources } from "../../../src/research/literature/source-registry"
import { validateKnowledgeCandidate } from "../../../src/research/literature/knowledge-v2-validator"
import { candidate, chunk, context, digest } from "./principle-fixtures"
import type { NormalizedDocument } from "../../../src/research/literature/contract"
import { DocumentChunkSchema } from "../../../src/research/literature/contract"
import regressions from "./fixtures/source-regressions.json"

const document = { paperID: "paper", documentID: "doc", sourceSha256: digest } as NormalizedDocument
test("registry owns provenance and preserves separate raw spans around interleaved text", () => {
  const text = "We pro-\npose a predictor.\nCopyright and unrelated column text.\nThe predictor shares weights."
  const sources = buildSourceRegistry(document, [{ ...chunk, text }], 30)
  expect(sources.length).toBeGreaterThan(1)
  expect(sources.map((s) => s.sourceID)).toEqual(buildSourceRegistry(document, [{ ...chunk, text }], 30).map((s) => s.sourceID))
  for (const s of sources) {
    expect(text.slice(s.spanStart, s.spanEnd)).toBe(s.quote)
    expect(s.documentSha256).toBe(digest)
  }
  const input = { sources: [sources[0].sourceID, sources.at(-1)!.sourceID] }
  expect(hydrateCandidateSources(input, sources)).toEqual({ sources: [sources[0], sources.at(-1)!] })
  expect(() => hydrateCandidateSources({ sources: ["invented"] }, sources)).toThrow("Unknown registered")
  expect(() => hydrateCandidateSources({ sources: [{ ...sources[0], quote: "invented" }] }, sources)).toThrow()
})
test("stored span offsets are independently checked, not trusted merely because quote exists", () => {
  const c = candidate()
  c.sources[0].spanStart = 1
  c.sources[0].spanEnd = chunk.text.length
  expect(validateKnowledgeCandidate(c, context)).toContain("source_offset_mismatch:s")
})
test("span boundaries do not silently merge separated quoted text", () => {
  const sources = buildSourceRegistry(document, [chunk], 60)
  expect(sources.every((s) => s.quote.length <= 60)).toBe(true)
  expect(sources.every((s) => s.spanEnd! > s.spanStart!)).toBe(true)
})
test("referenced source inventory is derived instead of manually duplicated", () => {
  const sources = buildSourceRegistry(document, [chunk], 80)
  const wire = { schemaVersion: "knowledge_candidate_v2", conditions: [{ sourceIDs: [sources[0].sourceID] }], support: [{ sourceIDs: [sources[1].sourceID] }] }
  expect((hydrateCandidateSources(wire, sources) as any).sources).toEqual(sources.slice(0, 2))
  expect(() => hydrateCandidateSources({ ...wire, support: [{ sourceIDs: ["missing"] }] }, sources)).toThrow("Unknown registered")
})

for (const fixture of regressions) test(`frozen PDF regression: ${fixture.case}`, () => {
  const c = DocumentChunkSchema.parse(fixture.chunk)
  const sources = buildSourceRegistry(fixture.document, [c])
  expect(sources.length).toBeGreaterThan(1)
  let end = 0
  for (const source of sources) {
    expect(c.text.slice(source.spanStart, source.spanEnd)).toBe(source.quote)
    expect(c.text.slice(end, source.spanStart).trim()).toBe("")
    expect(source.chunkSha256).toBe(c.textSha256)
    expect(source.paperID).toBe(fixture.document.paperID)
    end = source.spanEnd!
  }
  expect(c.text.slice(end).trim()).toBe("")
  const restored = hydrateCandidateSources({ sources: sources.map((s) => s.sourceID) }, sources)
  expect(restored).toEqual({ sources })
})

test("experiment inventory includes field citations without changing observations or mixing experiments", () => {
  const sources = buildSourceRegistry(document, [chunk], 60)
  const wire = { schemaVersion: "knowledge_candidate_v2", experiments: [
    { experimentID: "one", sourceIDs: [sources[0].sourceID], result: { status: "reported", value: "unchanged result", sourceIDs: [sources[1].sourceID] } },
    { experimentID: "two", sourceIDs: [sources[2].sourceID], result: { status: "not_reported", reason: "Unknown" } },
  ] }
  const out = hydrateCandidateSources(wire, sources) as any
  expect(out.experiments[0].sourceIDs).toEqual([sources[0].sourceID, sources[1].sourceID])
  expect(out.experiments[0].result).toEqual(wire.experiments[0].result)
  expect(out.experiments[1]).toEqual(wire.experiments[1])
  expect(wire.experiments[0].sourceIDs).toEqual([sources[0].sourceID])
  expect(() => hydrateCandidateSources({ ...wire, experiments: [{ ...wire.experiments[0], result: { status: "reported", value: "unchanged result", sourceIDs: ["invented"] } }] }, sources)).toThrow("Unknown registered")
})
