import { createHash } from "node:crypto"
import type { DocumentChunk, NormalizedDocument } from "./contract"
import type { KnowledgeCandidateV2 } from "./knowledge-v2-contract"

export type RegisteredSource = KnowledgeCandidateV2["sources"][number]

// Every entry is one contiguous original substring. Multiple entries can support
// the same assertion, without pretending that text separated by a footer is contiguous.
export function buildSourceRegistry(document: Pick<NormalizedDocument, "documentID" | "paperID" | "sourceSha256">, chunks: readonly DocumentChunk[], maxCharacters = 900): RegisteredSource[] {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1) throw new Error("Invalid source span limit")
  const sources: RegisteredSource[] = []
  for (const chunk of chunks) {
    let start = 0
    while (start < chunk.text.length) {
      let end = Math.min(start + maxCharacters, chunk.text.length)
      if (end < chunk.text.length) {
        const boundary = chunk.text.lastIndexOf("\n", end)
        if (boundary > start + maxCharacters / 2) end = boundary + 1
      }
      const raw = chunk.text.slice(start, end)
      const quote = raw.trim()
      if (quote) {
        const spanStart = start + raw.indexOf(quote)
        const spanEnd = spanStart + quote.length
        const identity = [document.sourceSha256, chunk.chunkID, chunk.textSha256, spanStart, spanEnd]
        sources.push({
          sourceID: `src_${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 20)}`,
          paperID: document.paperID, documentID: document.documentID, documentSha256: document.sourceSha256,
          chunkID: chunk.chunkID, chunkSha256: chunk.textSha256, sectionID: chunk.sectionID,
          page: chunk.pageStart, pageEnd: chunk.pageEnd, spanStart, spanEnd, quote,
        })
      }
      start = end
    }
  }
  return sources
}

export function projectSources(sources: readonly RegisteredSource[]) {
  return sources.map(({ sourceID, chunkID, page, pageEnd, sectionID, quote }) => ({ sourceID, chunkID, page, pageEnd, sectionID, text: quote }))
}

// Hydration is a lookup, not a model-provided rewrite of provenance or quotations.
export function hydrateCandidateSources(value: unknown, registry: readonly RegisteredSource[]): unknown {
  if (Array.isArray(value)) return value.map((v) => hydrateCandidateSources(v, registry))
  if (!value || typeof value !== "object") return value
  const entries = new Map(registry.map((source) => [source.sourceID, source]))
  const hydrated = Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key !== "sources") return [key, hydrateCandidateSources(item, registry)]
    if (!Array.isArray(item) || item.some((id) => typeof id !== "string" || !entries.has(id))) throw new Error("Unknown registered source ID")
    return [key, item.map((id) => structuredClone(entries.get(id)!))]
  }))
  if ("schemaVersion" in value && value.schemaVersion === "knowledge_candidate_v2") {
    // The experiment inventory includes its field-level citations. Protocol and
    // result spans may differ; requiring the model to repeat both loses valid edges.
    if (Array.isArray(hydrated.experiments)) for (const experiment of hydrated.experiments) {
      if (!experiment || typeof experiment !== "object" || !Array.isArray(experiment.sourceIDs)) continue
      const fieldIDs = Object.values(experiment).flatMap((field) => {
        if (!field || typeof field !== "object" || !("status" in field) || field.status !== "reported"
          || !("sourceIDs" in field) || !Array.isArray(field.sourceIDs)) return []
        return field.sourceIDs
      })
      experiment.sourceIDs = [...new Set([...experiment.sourceIDs, ...fieldIDs])]
    }
    const explicit = Array.isArray(hydrated.sources) ? hydrated.sources as RegisteredSource[] : []
    const ids = new Set<string>(explicit.map((s) => s.sourceID))
    const collect = (node: unknown) => {
      if (!node || typeof node !== "object") return
      for (const [key, item] of Object.entries(node)) {
        if (key === "sourceIDs" && Array.isArray(item)) {
          for (const id of item) {
            if (typeof id !== "string" || !entries.has(id)) throw new Error(`Unknown registered source ID: ${id}`)
            ids.add(id)
          }
        } else collect(item)
      }
    }
    collect(value)
    hydrated.sources = [...ids].map((id) => structuredClone(entries.get(id)!))
  }
  return hydrated
}
