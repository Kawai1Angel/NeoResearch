import { expect, test } from "bun:test"
import path from "node:path"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "../../fixture/fixture"
import type { NormalizedDocument } from "../../../src/research/literature/contract"
import type { KnowledgeCandidateV2 } from "../../../src/research/literature/knowledge-v2-contract"
import { extractPaperPrinciples, projectRelatedPrinciple } from "../../../src/research/literature/paper-principle-extractor"
import { LiteratureAgent } from "../../../src/research/literature/literature-agent"
import { principlePrompt, type PrincipleModel, type PrincipleStage } from "../../../src/research/literature/principle-model"
import { candidate, review, chunk, digest } from "./principle-fixtures"

const document: NormalizedDocument = {
  schemaVersion: "normalized_document_v1", paperID: "paper", documentID: "doc", sourcePath: "/fixture.pdf",
  sourceSha256: digest, parser: { name: "fixture", version: "1" }, language: "en",
  pages: [{ pageNumber: 1, text: chunk.text, blocks: [] }], sections: [], parseWarnings: [],
}
function fixtureModel(override?: (stage: PrincipleStage, payload: Record<string, unknown>, value: unknown) => unknown) {
  const requests: Array<{ stage: PrincipleStage; payload: Record<string, unknown> }> = []
  const model: PrincipleModel = {
    modelIdentifier: "fixture",
    async request(stage, payload) {
      requests.push({ stage, payload })
      const c = candidate()
      const value = stage === "outline" ? {
        problem: "Efficient prediction of recurring phases", contributions: [{ statement: c.principle, sourceIDs: ["s"] }],
        methodOutline: [{ statement: c.intervention.operation, sourceIDs: ["s"] }], unresolved: [],
      } : stage === "collect" ? {
        materials: [{ kind: "counterevidence", statement: "No accuracy evidence", sourceIDs: ["s"], attribution: "author_claim", contributionIndexes: [0] }],
        unresolved: ["No performance experiment"],
      } : stage === "repair_materials" ? { repairs: (payload.invalidItems as any[]).map((item) => ({ itemIndex: item.itemIndex, material: null, reason: "Cannot recover fixture source" })) }
        : stage === "repair_bindings" ? { links: [], scopeReplacements: [], unresolved: ["No fixture patch"] }
        : stage === "plan" ? { plans: [{ planID: "candidate", contributionIndexes: [0], focus: "Complete phase-sharing principle" }], unformed: [] }
        : stage === "synthesize" ? { candidates: [c], unformed: [] }
        : stage === "revise" ? { candidate: payload.candidate, reason: "Fixture revision" }
        : stage === "merge" ? { candidate: (payload.originals as any[])[0], reason: "Fixture merge" }
        : stage === "consolidate" ? { groups: (payload.candidates as any[]).map((c) => ({ candidateIDs: [c.candidateID], action: "retain", rationale: "Complete principle" })) }
          : { ...review(), candidateID: (payload.candidate as any).candidateID, candidateHash: payload.candidateHash,
            assertionReviews: (payload.candidate as any).assertions.map((a: any) => ({ assertionID: a.assertionID, verdict: "supported", reason: "Fixture support" })),
            reviewedSourceIDs: (payload.candidate as any).sources }
      const raw = override ? override(stage, payload, value) : value
      const catalog = (payload.sourceCatalog ?? (payload.analysis as any)?.sources ?? []) as Array<{ sourceID: string }>
      const sourceID = catalog[0]?.sourceID ?? "s"
      const adapt = (item: any): any => {
        if (item === "s") return sourceID
        if (Array.isArray(item)) return item.map(adapt)
        if (!item || typeof item !== "object") return item
        return Object.fromEntries(Object.entries(item).filter(([key]) => !(item.schemaVersion === "knowledge_candidate_v2" && key === "principle")).map(([key, v]) => [key,
          key === "sources" && Array.isArray(v) ? v.map((s) => adapt(typeof s === "string" ? s : s.sourceID)) : adapt(v)]))
      }
      return { text: JSON.stringify(adapt(raw)) }
    },
  }
  return { model, requests }
}
const run = (model: PrincipleModel, options?: Parameters<typeof extractPaperPrinciples>[0]["options"]) =>
  extractPaperPrinciples({ document, chunks: [chunk], model, runID: "run", options })

test("whole-paper synthesis and consolidation precede independent source verification", async () => {
  const { model, requests } = fixtureModel()
  const result = await run(model)
  expect(result.errors).toEqual([])
  expect(result.status).toBe("completed")
  expect(result.cards).toHaveLength(1)
  expect(requests.map((r) => r.stage)).toEqual(["outline", "collect", "plan", "synthesize", "verify", "consolidate", "verify"])
  const verification = requests.at(-1)!.payload
  expect(verification.originalChunks).toEqual([chunk])
  expect((requests.find((r) => r.stage === "collect")!.payload.outline as any).contributions[0].contributionIndex).toBe(0)
  expect((verification.analysis as any).contributions[0].contributionIndex).toBe(0)
  expect(JSON.stringify(verification.analysis)).toContain("counterevidence")
  expect(result.analysis?.coverage.remainingChunkIDs).toEqual([])
  expect(result.calls.every((c) => c.inputHash && c.outputHash && c.response && c.elapsedMs >= 0)).toBe(true)
})
test("zero knowledge is completed and does not generate filler cards", async () => {
  const { model, requests } = fixtureModel((stage, _, value) => stage === "synthesize" ? { candidates: [], unformed: ["No complete source-backed principle"] } : value)
  const result = await run(model)
  expect(result.status).toBe("completed")
  expect(result.cards).toEqual([])
  expect(result.unformed).toHaveLength(1)
  expect(requests.some((r) => r.stage === "verify")).toBe(false)
})
test("binding repair can link existing evidence but still requires independent review", async () => {
  const { model, requests } = fixtureModel((stage, _, value) => {
    if (stage === "synthesize") {
      const c = candidate()
      c.support[0].assertionIDs = c.support[0].assertionIDs.filter((id) => id !== "p")
      return { candidates: [c], unformed: [] }
    }
    if (stage === "repair_bindings") return { links: [{ evidenceID: "ev", assertionIDs: ["p"] }], scopeReplacements: [], unresolved: [] }
    return value
  })
  const result = await run(model)
  expect(result.errors).toEqual([])
  expect(result.cards).toHaveLength(1)
  expect(result.cards[0].support[0].assertionIDs).toContain("p")
  expect(requests.filter((r) => r.stage === "verify")).toHaveLength(2)
  expect(result.cards[0].assertions).toEqual(candidate().assertions)
})
test("binding repair cannot invent evidence or approve an unsupported assertion", async () => {
  const { model } = fixtureModel((stage, _, value) => {
    if (stage === "synthesize") {
      const c = candidate()
      c.support[0].assertionIDs = c.support[0].assertionIDs.filter((id) => id !== "p")
      return { candidates: [c], unformed: [] }
    }
    if (stage === "repair_bindings") return { links: [{ evidenceID: "invented", assertionIDs: ["p"] }], scopeReplacements: [], unresolved: [] }
    return value
  })
  const result = await run(model)
  expect(result.cards).toEqual([])
  expect(result.rejected[0].reasons.join(" ")).toContain("unknown evidence/assertion")
  expect(result.reviews).toHaveLength(0)
})
test("scope repair adds a source-bound scope without retyping or rewriting effects", async () => {
  const { model } = fixtureModel((stage, _, value) => {
    if (stage === "synthesize") {
      const c = candidate()
      c.observedScope = [{ assertionID: "e", sourceIDs: ["s"] }]
      return { candidates: [c], unformed: [] }
    }
    if (stage === "repair_bindings") return { links: [], scopeReplacements: [{ assertionID: "scope", statement: "Stable periodic sequences", sourceIDs: ["s"] }], unresolved: [] }
    return value
  })
  const result = await run(model)
  expect(result.errors).toEqual([])
  expect(result.cards[0].assertions.find((a) => a.assertionID === "e")).toEqual(candidate().assertions.find((a) => a.assertionID === "e"))
  expect(result.cards[0].observedScope[0].assertionID).toMatch(/^scope_/)
})
test("redundant outline position metadata cannot erase valid contributions", async () => {
  const { model } = fixtureModel((stage, _, value) => stage === "outline" ? {
    ...(value as object), contributions: (value as any).contributions.map((c: any, contributionIndex: number) => ({ ...c, contributionIndex })),
  } : value)
  const result = await run(model)
  expect(result.errors).toEqual([])
  expect(result.analysis?.contributions).toHaveLength(1)
  expect(result.cards).toHaveLength(1)
  const card = result.cards[0]
  expect(card.principle).toBe(card.assertions.find((a) => a.assertionID === card.principleAssertionID)!.statement)
})
test("budget exhaustion retains analysis but never publishes intermediate fragments", async () => {
  const { model } = fixtureModel()
  const result = await run(model, { maxCalls: 2 })
  expect(result.status).toBe("partial")
  expect(result.errors.join(" ")).toContain("call_budget_exhausted")
  expect(result.analysis?.materials).toHaveLength(1)
  expect(result.cards).toEqual([])
})
test("invalid material is staged without discarding siblings, and blocks affected knowledge", async () => {
  const { model, requests } = fixtureModel((stage, _, value) => stage === "collect" ? {
    ...(value as object), materials: [...(value as any).materials, { kind: "boundary", statement: "Missing source", sourceIDs: ["missing"], attribution: "author_claim", contributionIndexes: [0] }],
  } : value)
  const result = await run(model)
  expect(result.status).toBe("partial")
  expect(result.analysis?.materials).toHaveLength(1)
  expect(result.stagedMaterials).toHaveLength(1)
  expect(result.cards).toEqual([])
  expect(result.rejected[0].reasons).toContain("material_evidence_gap")
  expect(requests.filter((r) => r.stage === "collect")).toHaveLength(1)
  expect(requests.some((r) => r.stage === "synthesize")).toBe(true)
})
test("semantic rejection remains rejection and is not treated as a JSON repair", async () => {
  const { model, requests } = fixtureModel((stage, _, value) => stage === "verify" ? { ...(value as object), verdict: "rejected", reasons: ["missing_counterevidence"] } : value)
  const result = await run(model)
  expect(result.status).toBe("completed")
  expect(result.cards).toEqual([])
  expect(result.rejected[0].reasons).toContain("missing_counterevidence")
  expect(requests.filter((r) => r.stage === "verify")).toHaveLength(1)
})
test("material repair targets only invalid items and preserves valid siblings", async () => {
  const { model, requests } = fixtureModel((stage, payload, value) => {
    if (stage === "collect") return { ...(value as object), materials: [
      ...(value as any).materials, { kind: "boundary", statement: "Scoped boundary", sourceIDs: ["missing"], attribution: "author_claim", contributionIndexes: [0] },
    ] }
    if (stage === "repair_materials") {
      expect((payload.invalidItems as any[])).toHaveLength(1)
      return { repairs: [{ itemIndex: 1, material: { kind: "boundary", statement: "Scoped boundary", sourceIDs: ["s"], attribution: "author_claim", contributionIndexes: [0] }, reason: "Use registered source" }] }
    }
    return value
  })
  const result = await run(model)
  expect(result.errors).toEqual([])
  expect(result.stagedMaterials).toEqual([])
  expect(result.analysis?.materials).toHaveLength(2)
  expect(result.cards).toHaveLength(1)
  expect(requests.filter((r) => r.stage === "repair_materials")).toHaveLength(1)
})
test("failed item repair is staged instead of losing valid analysis", async () => {
  const { model } = fixtureModel((stage, _, value) => {
    if (stage === "collect") return { ...(value as object), materials: [
      ...(value as any).materials, { kind: "counterevidence", statement: "Unavailable evidence", sourceIDs: ["missing"], attribution: "author_claim", contributionIndexes: [0] },
    ] }
    if (stage === "repair_materials") throw new Error("Repair provider unavailable")
    return value
  })
  const result = await run(model)
  expect(result.errors).toEqual([])
  expect(result.analysis?.materials).toHaveLength(1)
  expect(result.stagedMaterials[0].reason).toContain("Repair provider unavailable")
  expect(result.cards).toEqual([])
  expect(result.candidates).toHaveLength(1)
})
test("a scoped material gap does not suppress an independent contribution", async () => {
  const second = candidate()
  second.candidateID = "independent"
  second.contributionIndexes = [1]
  const { model } = fixtureModel((stage, _, value) => {
    if (stage === "outline") return { ...(value as object), contributions: [
      { statement: "First contribution", sourceIDs: ["s"] }, { statement: "Independent contribution", sourceIDs: ["s"] },
    ] }
    if (stage === "collect") return { ...(value as object), materials: [
      ...(value as any).materials,
      { kind: "boundary", statement: "First contribution has unavailable evidence", sourceIDs: ["missing"], attribution: "author_claim", contributionIndexes: [0] },
    ] }
    if (stage === "plan") return { plans: [{ planID: "independent", contributionIndexes: [1], focus: "Independent contribution" }], unformed: [] }
    if (stage === "synthesize") return { candidates: [second], unformed: ["First contribution unresolved"] }
    if (stage === "consolidate") return { groups: [{ candidateIDs: ["independent"], action: "retain", rationale: "Independent contribution" }] }
    return value
  })
  const result = await run(model)
  expect(result.errors).toEqual([])
  expect(result.status).toBe("partial")
  expect(result.cards).toHaveLength(1)
  expect(result.cards[0].contributionIndexes).toEqual([1])
  expect(result.stagedMaterials).toHaveLength(1)
})
test("an unscoped missing counterexample blocks every candidate", async () => {
  const { model } = fixtureModel((stage, _, value) => stage === "collect" ? { ...(value as object), materials: [
    ...(value as any).materials, { kind: "counterevidence", statement: "Unknown scope", sourceIDs: ["missing"], attribution: "author_claim", contributionIndexes: [] },
  ] } : value)
  const result = await run(model)
  expect(result.analysis?.materialGaps?.[0].affectsAllContributions).toBe(true)
  expect(result.cards).toEqual([])
  expect(result.rejected[0].reasons).toContain("material_evidence_gap")
})
test("consolidation must account for every candidate and cannot introduce untraceable principles", async () => {
  const { model } = fixtureModel((stage, _, value) => stage === "consolidate" ? { groups: [] } : value)
  const result = await run(model)
  expect(result.status).toBe("partial")
  expect(result.cards).toEqual([])
  expect(result.errors.join(" ")).toContain("disposition")
})
test("merged candidate is verified after changes, with a fresh hash", async () => {
  const { model, requests } = fixtureModel((stage, _, value) => {
    if (stage === "consolidate") return { groups: [{ candidateIDs: ["candidate"], action: "merge", rationale: "Recheck normalized knowledge" }] }
    if (stage !== "merge") return value
    const c = candidate()
    c.unknowns.push("Additional scope qualification")
    return { candidate: c, reason: "Preserve scope qualification" }
  })
  const result = await run(model)
  expect(result.cards).toHaveLength(1)
  expect(result.cards[0].unknowns).toContain("Additional scope qualification")
  expect(requests.at(-1)?.payload.candidateHash).not.toBe(review().candidateHash)
})
test("merge may omit an unused original source while final assertions remain source-bound and reviewed", async () => {
  const longText = `${chunk.text}\n${"Unrelated appendix context. ".repeat(55)}`
  const longDigest = createHash("sha256").update(longText).digest("hex")
  const longChunk = { ...chunk, text: longText, textSha256: longDigest }
  const longDocument = { ...document, sourceSha256: longDigest, pages: [{ pageNumber: 1, text: longText, blocks: [] }] }
  let unusedSourceID = ""
  const { model, requests } = fixtureModel((stage, payload, value) => {
    if (stage === "synthesize") {
      unusedSourceID = ((payload.analysis as any).sources as Array<{ sourceID: string }>)[1]!.sourceID
      const c = candidate()
      c.sources.push({ ...c.sources[0]!, sourceID: unusedSourceID })
      return { candidates: [c], unformed: [] }
    }
    if (stage === "consolidate") return { groups: [{ candidateIDs: ["candidate"], action: "merge", rationale: "Remove unused source inventory" }] }
    if (stage === "merge") {
      const c = structuredClone((payload.originals as any[])[0])
      c.sources = c.sources.filter((id: string) => id !== unusedSourceID)
      return { candidate: c, reason: "The omitted span is not cited by the final principle" }
    }
    return value
  })
  const result = await extractPaperPrinciples({ document: longDocument, chunks: [longChunk], model, runID: "run" })
  expect(result.errors).toEqual([])
  expect(result.cards).toHaveLength(1)
  expect(result.cards[0]!.sources.some((source) => source.sourceID === unusedSourceID)).toBe(false)
  expect(requests.filter((request) => request.stage === "verify")).toHaveLength(2)
})
test("semantic revision is bounded and reviewed again after consolidation", async () => {
  const { model, requests } = fixtureModel((stage, payload, value) => {
    if (stage === "verify" && payload.phase === "initial") return { ...(value as object), verdict: "needs_revision", reasons: ["scope_overgeneralized"] }
    if (stage === "revise") {
      const c = candidate()
      c.unknowns.push("Transfer beyond stable periods is untested")
      return { candidate: c, reason: "Make transfer uncertainty explicit" }
    }
    return value
  })
  const result = await run(model)
  expect(result.errors).toEqual([])
  expect(result.cards[0].unknowns).toContain("Transfer beyond stable periods is untested")
  expect(requests.filter((r) => r.stage === "revise")).toHaveLength(1)
  expect(requests.filter((r) => r.stage === "verify")).toHaveLength(2)
})
test("final semantic failure cannot reuse an accepted initial review", async () => {
  const { model } = fixtureModel((stage, payload, value) => stage === "verify" && payload.phase === "final"
    ? { ...(value as object), verdict: "rejected", reasons: ["component_only"] } : value)
  const result = await run(model)
  expect(result.cards).toEqual([])
  expect(result.reviews).toHaveLength(2)
  expect(result.rejected[0].reasons).toContain("component_only")
})
test("context overflow and corrupt chunk hashes stop before model invocation", async () => {
  const { model, requests } = fixtureModel()
  expect((await run(model, { batchCharacters: 1 })).status).toBe("partial")
  const result = await extractPaperPrinciples({ document, chunks: [{ ...chunk, text: "tampered" }], model, runID: "bad" })
  expect(result.status).toBe("partial")
  expect(requests).toHaveLength(0)
})
test("verifier receives uncited limitation chunks, not only collector summaries", async () => {
  const { model, requests } = fixtureModel()
  const text = "The procedure fails if the period changes."
  const adverse = { ...chunk, chunkID: `chunk_${"b".repeat(20)}`, sectionID: "limitations", sectionKind: "limitations" as const,
    ordinal: 1, text, textSha256: createHash("sha256").update(text).digest("hex") }
  const result = await extractPaperPrinciples({ document, chunks: [chunk, adverse], model, runID: "counterexample" })
  expect(result.errors).toEqual([])
  for (const request of requests.filter((r) => r.stage === "verify")) expect(request.payload.originalChunks).toContainEqual(adverse)
})
test("a later verification failure removes previously accepted cards from partial output", async () => {
  const first = candidate()
  const second = candidate()
  second.candidateID = "second"
  second.principle += " This is a second synthetic fixture."
  second.assertions[0].statement = second.principle
  const { model } = fixtureModel((stage, payload, value) => {
    if (stage === "plan") return { plans: [first, second].map((c) => ({ planID: c.candidateID, contributionIndexes: [0], focus: c.principle })), unformed: [] }
    if (stage === "synthesize") return { candidates: [(payload.focus as any).planID === "second" ? second : first], unformed: [] }
    if (stage === "consolidate") return { groups: [first, second].map((c) => ({ candidateIDs: [c.candidateID], action: "retain", rationale: "Fixture" })) }
    if (stage === "verify" && payload.phase === "final" && (payload.candidate as KnowledgeCandidateV2).candidateID === "second") throw new Error("provider failure")
    return value
  })
  const result = await run(model)
  expect(result.status).toBe("partial")
  expect(result.cards).toEqual([])
  expect(result.reviews).toHaveLength(3)
  expect(result.errors.join(" ")).toContain("provider failure")
  expect(result.calls.filter((c) => c.stage === "synthesize")).toHaveLength(2)
})
test("an invalid drafted principle does not erase an independent valid principle", async () => {
  const c = candidate()
  c.candidateID = "valid"
  const { model } = fixtureModel((stage, payload, value) => {
    if (stage === "plan") return { plans: ["invalid", "valid"].map((planID) => ({ planID, contributionIndexes: [0], focus: planID })), unformed: [] }
    if (stage === "synthesize" && (payload.focus as any).planID === "invalid") return { candidates: [{ ...c, conditions: [{ assertionID: "c", sourceIDs: ["missing"] }] }], unformed: [] }
    if (stage === "synthesize") return { candidates: [c], unformed: [] }
    return value
  })
  const result = await run(model)
  expect(result.status).toBe("partial")
  expect(result.cards).toHaveLength(1)
  expect(result.cards[0].candidateID).toBe("valid")
  expect(result.rejected[0].reasons).toContain("candidate_generation_failed")
})
test("cancellation stops without retries or a completion result", async () => {
  const { model, requests } = fixtureModel()
  const controller = new AbortController()
  controller.abort()
  await expect(extractPaperPrinciples({ document, chunks: [chunk], model, runID: "cancel", signal: controller.signal })).rejects.toThrow()
  expect(requests).toHaveLength(0)
})
test("explicit agent entry writes v2 audit artifacts without adding legacy cards", async () => {
  await using tmp = await tmpdir()
  const documentPath = path.join(tmp.path, "document.json")
  const chunksPath = path.join(tmp.path, "chunks.jsonl")
  await Bun.write(documentPath, JSON.stringify(document))
  await Bun.write(chunksPath, JSON.stringify(chunk))
  const agent = new LiteratureAgent({ neoCastRoot: tmp.path, workspaceRoot: tmp.path, knowledgeRoot: path.join(tmp.path, "knowledge"),
    documentParser: async () => ({ status: "parsed", paperID: "paper", documentID: "doc", documentPath, chunksPath, chunkCount: 1, warningCount: 0, publicationStatus: "unknown" }) })
  try {
    const result = await agent.runPrinciples({ source: { kind: "catalog_paper", paperID: "paper" }, model: fixtureModel().model })
    expect(result.cards).toHaveLength(1)
    expect(JSON.parse(await readFile(path.join(result.runPath, "manifest.json"), "utf8")).publication).toBe("audit_only")
    expect(await readFile(path.join(result.runPath, "knowledge_cards_v2.jsonl"), "utf8")).toContain("knowledge_card_v2")
    expect(await readFile(path.join(result.runPath, "review.md"), "utf8")).toContain("Evidence bindings:")
    expect(agent.validate().cardCount).toBe(0)
  } finally { agent.close() }
})
test("stage prompts define material-only collection and source-reading verification", () => {
  expect(principlePrompt("collect")).toContain("no authority to become knowledge cards")
  expect(principlePrompt("verify")).toContain("Do not accept the extractor's summary as proof")
  expect(principlePrompt("synthesize")).toContain("Do not split existence and efficacy")
})

test("review shares original text and retains distinct revised candidate versions", async () => {
  const { model, requests } = fixtureModel((stage, payload, value) => {
    if (stage === "verify" && payload.phase === "initial") return { ...(value as object), verdict: "needs_revision", reasons: ["scope_overgeneralized"] }
    if (stage === "revise") {
      const c = candidate()
      c.unknowns.push("Revised scope")
      return { candidate: c, reason: "Narrow scope" }
    }
    return value
  })
  const result = await run(model)
  expect(result.cards).toHaveLength(1)
  for (const { payload } of requests.filter((r) => ["verify", "revise"].includes(r.stage))) {
    expect(payload.originalChunks).toEqual([chunk])
    for (const source of (payload.analysis as any).sources) {
      expect(source.text).toBeUndefined()
      expect(chunk.text.slice(source.spanStart, source.spanEnd)).toBe(result.analysis!.sources.find((s) => s.sourceID === source.sourceID)!.quote)
    }
  }
  const initial = requests.find((r) => r.stage === "verify")!.payload
  expect(initial.relatedCandidates).toEqual([])
  expect(initial.originalCandidateHashes).toEqual([initial.candidateHash])
  const final = requests.at(-1)!.payload
  expect(final.relatedCandidates).toHaveLength(1)
  expect((final.relatedCandidates as any[])[0].candidateHash).toBe(initial.candidateHash)
  expect(final.candidateHash).not.toBe(initial.candidateHash)
  expect(result.calls.every((c) => c.inputCharacters > 0)).toBe(true)
})

function experimentCandidate() {
  const c = candidate()
  const absent = { status: "not_reported" as const, reason: "Synthetic fixture" }
  c.experiments = [{ experimentID: "exp", studyID: "paper", intervention: absent, comparator: absent,
    dataset: absent, split: absent, contextLength: absent, predictionLength: absent, metric: absent,
    metricDirection: "not_reported", repetitions: absent, uncertainty: absent, result: absent,
    control: "unclear", confounds: [], sourceIDs: ["s"] }]
  c.support.push({ evidenceID: "exp_ev", assertionIDs: ["e"], sourceIDs: ["s"], relation: "qualifies", kind: "experiment", experimentID: "typo" })
  return c
}

test("experiment binding repair preserves experimental fields and requires review", async () => {
  const { model, requests } = fixtureModel((stage, _, value) => {
    if (stage === "synthesize") return { candidates: [experimentCandidate()], unformed: [] }
    if (stage === "repair_bindings") return { links: [], scopeReplacements: [], experimentBindings: [{ evidenceID: "exp_ev", experimentID: "exp", sourceIDs: ["s"] }], unresolved: [] }
    return value
  })
  const result = await run(model)
  expect(result.errors).toEqual([])
  expect(result.cards).toHaveLength(1)
  expect(result.cards[0].support.find((e) => e.evidenceID === "exp_ev")?.experimentID).toBe("exp")
  expect(result.cards[0].experiments[0]).toEqual({ ...experimentCandidate().experiments[0], sourceIDs: result.cards[0].experiments[0].sourceIDs })
  expect(requests.filter((r) => r.stage === "verify")).toHaveLength(2)
})

test("experiment repair cannot invent experiments, sources or evidence kinds", async () => {
  for (const binding of [
    { evidenceID: "exp_ev", experimentID: "invented", sourceIDs: ["s"] },
    { evidenceID: "exp_ev", experimentID: "exp", sourceIDs: ["invented"] },
    { evidenceID: "ev", experimentID: "exp", sourceIDs: ["s"] },
  ]) {
    const { model } = fixtureModel((stage, _, value) => {
      if (stage === "synthesize") return { candidates: [experimentCandidate()], unformed: [] }
      if (stage === "repair_bindings") return { links: [], scopeReplacements: [], experimentBindings: [binding], unresolved: [] }
      return value
    })
    const result = await run(model)
    expect(result.cards).toEqual([])
    expect(result.rejected[0].reasons.join(" ")).toContain("Experiment patch")
    expect(result.reviews).toEqual([])
  }
})

test("new citation edges can use registered text without inventing observations", async () => {
  const { model, requests } = fixtureModel((stage, _, value) => {
    if (stage === "synthesize") {
      const c = candidate()
      c.support[0].assertionIDs = c.support[0].assertionIDs.filter((id) => id !== "i")
      return { candidates: [c], unformed: [] }
    }
    if (stage === "repair_bindings") return { links: [], scopeReplacements: [], sourceBindings: [{ assertionIDs: ["i"], sourceIDs: ["s"], relation: "supports", kind: "explanation" }], unresolved: [] }
    return value
  })
  const result = await run(model)
  expect(result.errors).toEqual([])
  expect(result.cards).toHaveLength(1)
  expect(result.cards[0].support.at(-1)?.evidenceID).toMatch(/^binding_/)
  expect(result.cards[0].assertions).toEqual(candidate().assertions)
  expect(result.cards[0].experiments).toEqual([])
  expect(requests.filter((r) => r.stage === "verify")).toHaveLength(2)
})

test("new citation edges cannot fabricate sources, experiments or assertions", async () => {
  for (const binding of [
    { assertionIDs: ["p"], sourceIDs: ["invented"], relation: "supports", kind: "explanation" },
    { assertionIDs: ["p"], sourceIDs: ["s"], relation: "supports", kind: "experiment", experimentID: "invented" },
    { assertionIDs: ["invented"], sourceIDs: ["s"], relation: "supports", kind: "explanation" },
  ]) {
    const { model } = fixtureModel((stage, _, value) => {
      if (stage === "synthesize") {
        const c = candidate()
        c.support[0].assertionIDs = c.support[0].assertionIDs.filter((id) => id !== "p")
        return { candidates: [c], unformed: [] }
      }
      if (stage === "repair_bindings") return { links: [], scopeReplacements: [], sourceBindings: [binding], unresolved: [] }
      return value
    })
    const result = await run(model)
    expect(result.cards).toEqual([])
    expect(result.rejected).toHaveLength(1)
    expect(result.reviews).toEqual([])
  }
})

test("one malformed semantic revision does not discard independent candidates", async () => {
  const { model } = fixtureModel((stage, payload, value) => {
    if (stage === "plan") return { plans: ["candidate", "second"].map((planID) => ({ planID, contributionIndexes: [0], focus: planID })), unformed: [] }
    if (stage === "synthesize" && (payload.focus as any).planID === "second") {
      const c = candidate()
      c.assertions[0].statement += " Second fixture condition."
      return { candidates: [c], unformed: [] }
    }
    if (stage === "verify" && payload.phase === "initial" && (payload.candidate as any).candidateID === "second") return { ...(value as object), verdict: "needs_revision", reasons: ["scope_overgeneralized"] }
    if (stage === "revise") return { candidate: {}, reason: "Malformed revision" }
    return value
  })
  const result = await run(model)
  expect(result.status).toBe("partial")
  expect(result.errors).toEqual([])
  expect(result.cards).toHaveLength(1)
  expect(result.cards[0].candidateID).toBe("candidate")
  expect(result.rejected[0].reasons).toContain("candidate_revision_failed")
})

test("incomplete or contradictory review output gets one repair, never implicit acceptance", async () => {
  let initial = 0
  const { model, requests } = fixtureModel((stage, payload, value) => {
    if (stage === "verify" && payload.phase === "initial" && initial++ === 0) return { ...(value as object), verdict: "needs_revision", reviewedSourceIDs: ["invented"] }
    return value
  })
  const result = await run(model)
  expect(result.cards).toHaveLength(1)
  expect(requests.filter((r) => r.stage === "verify")).toHaveLength(3)
  expect(result.calls.find((c) => c.error)?.error).toContain("contradictory_review_verdict")
  expect(requests.some((r) => r.stage === "revise")).toBe(false)
})

test("fabricated reviewer source IDs never publish a card", async () => {
  const { model, requests } = fixtureModel((stage, _, value) => stage === "verify" ? { ...(value as object), reviewedSourceIDs: ["invented"] } : value)
  const result = await run(model)
  expect(result.status).toBe("partial")
  expect(result.cards).toEqual([])
  expect(requests.filter((r) => r.stage === "verify")).toHaveLength(2)
  expect(result.errors.join(" ")).toContain("unknown_review_source")
})

test("partial source review preserves cards without coverage repair calls", async () => {
  const { model, requests } = fixtureModel((stage, payload, value) => {
    if (stage === "synthesize") {
      const c = candidate()
      const second = (payload.analysis as any).sources.find((s: any) => s.chunkID === "second-chunk").sourceID
      c.sources.push({ ...c.sources[0], sourceID: second })
      c.support[0].sourceIDs.push(second)
      return { candidates: [c], unformed: [] }
    }
    if (stage === "verify") return { ...(value as object), reviewedSourceIDs: ["s"] }
    return value
  })
  const result = await extractPaperPrinciples({ document, chunks: [chunk, { ...chunk, chunkID: "second-chunk" }], model, runID: "partial-review" })
  expect(result.errors).toEqual([])
  expect(result.cards).toHaveLength(1)
  expect(result.cards[0].sources.length).toBeGreaterThan(result.cards[0].review.reviewedSourceIDs.length)
  expect(result.cards[0].review.reviewedSourceIDs).toHaveLength(1)
  expect(requests.filter((r) => r.stage === "verify")).toHaveLength(2)
})

test("comparison projections retain all claims and adverse results without repeating protocols", () => {
  const c = experimentCandidate()
  c.experiments[0].split = { status: "reported", value: "Protocol detail ".repeat(1000), sourceIDs: ["s"] }
  c.experiments[0].result = { status: "reported", value: "Adverse observation", sourceIDs: ["s"] }
  c.experiments[0].confounds = ["Multiple changed factors"]
  const projected = projectRelatedPrinciple(c)
  expect(projected.assertions).toEqual(c.assertions)
  expect(projected.boundaries).toEqual(c.boundaries)
  expect(projected.unknowns).toEqual(c.unknowns)
  expect(projected.experimentResults[0].result).toEqual(c.experiments[0].result)
  expect(projected.experimentResults[0].confounds).toEqual(c.experiments[0].confounds)
  expect(JSON.stringify(projected).length).toBeLessThan(JSON.stringify(c).length - 10000)
  expect(c.experiments[0].split.status).toBe("reported")
})

test("bounded evidence strength survives finalization as a qualified review, not a rejected card", async () => {
  const { model, requests } = fixtureModel((stage, _, value) => {
    if (stage !== "verify") return value
    const r = value as any
    return { ...r, assertionReviews: r.assertionReviews.map((a: any) => a.assertionID === "m" ? {
      ...a, verdict: "qualified", reason: "Scoped explanatory claim; replication is unreported.",
      qualification: { kind: "limited_experiments", sourceFaithful: true, limitationDisclosed: true },
    } : a) }
  })
  const result = await run(model)
  expect(result.errors).toEqual([])
  expect(result.cards).toHaveLength(1)
  expect(result.cards[0].review.assertionReviews.find((a) => a.assertionID === "m")?.qualification?.kind).toBe("limited_experiments")
  expect(requests.some((r) => r.stage === "revise")).toBe(false)
})

test("semantic revision targets unsupported claims without reworking faithful evidence qualifications", async () => {
  const { model, requests } = fixtureModel((stage, payload, value) => {
    if (stage !== "verify" || payload.phase !== "initial") return value
    const r = value as any
    return { ...r, verdict: "needs_revision", reasons: ["unsupported_causal_claim"], assertionReviews: r.assertionReviews.map((a: any) =>
      a.assertionID === "m" ? { ...a, verdict: "qualified", qualification: { kind: "limited_experiments", sourceFaithful: true, limitationDisclosed: true } }
        : a.assertionID === "e" ? { ...a, verdict: "unsupported" } : a) }
  })
  const result = await run(model)
  expect(result.cards).toHaveLength(1)
  expect((requests.find((r) => r.stage === "revise")!.payload.revisionTargets as any[]).map((a) => a.assertionID)).toEqual(["e"])
})


test("review of additional registered originals survives finalization", async () => {
  const { model } = fixtureModel((stage, payload, value) => stage === "verify" ? {
    ...(value as object), reviewedSourceIDs: (payload.analysis as any).sources.map((s: any) => s.sourceID),
  } : value)
  const result = await extractPaperPrinciples({ document, chunks: [chunk, { ...chunk, chunkID: "second-chunk" }], model, runID: "additional-review" })
  expect(result.errors).toEqual([])
  expect(result.cards).toHaveLength(1)
  expect(result.cards[0].review.reviewedSourceIDs.length).toBeGreaterThan(result.cards[0].sources.length)
})
