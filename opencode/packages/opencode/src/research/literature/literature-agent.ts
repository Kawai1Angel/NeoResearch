import type { LiteratureProgress } from "../literature-phase-executor"
import { createHash } from "crypto"
import { access, mkdir, readFile, rename, writeFile } from "fs/promises"
import path from "path"
import {
  CandidateClaimSchema, DocumentChunkSchema, KnowledgeCardSchema, NormalizedDocumentSchema,
  type CandidateClaim, type CardRelation, type DocumentChunk, type KnowledgeCard, type LiteratureAgentInput,
  type LiteratureAgentResult, type RejectedCandidate,
} from "./contract"
import { extractCandidates } from "./candidate-extractor"
import { verifyCandidate } from "./evidence-verifier"
import { normalizeCandidate } from "./card-normalizer"
import { deduplicateCard, mergeCardEvidence } from "./card-deduplicator"
import type { LiteratureExtractionModel } from "./extraction-model"
import { DisabledExtractionModel } from "./extraction-model"
import { KnowledgeStore } from "./knowledge-store"
import { loadTaxonomy } from "./taxonomy"
import { renderCardExport, renderReview } from "./report-renderer"

const DEFAULT_CARD_TYPES: CandidateClaim["cardType"][] = [
  "model_mechanism", "empirical_finding", "applicability_rule", "limitation", "evaluation_protocol", "implementation_hint",
]

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`
  return JSON.stringify(value)
}

function digest(value: unknown) { return createHash("sha256").update(stableJson(value)).digest("hex") }

async function exists(file: string) {
  try { await access(file); return true } catch { return false }
}

async function atomicWrite(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}`
  await writeFile(temporary, content, "utf8")
  await rename(temporary, file)
}

async function writeJson(file: string, value: unknown) {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function writeJsonl(file: string, values: readonly unknown[]) {
  await atomicWrite(file, values.map((item) => JSON.stringify(item)).join("\n") + (values.length ? "\n" : ""))
}

function parseJsonl<T>(text: string, parser: { parse(value: unknown): T }) {
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => parser.parse(JSON.parse(line)))
}

export type ParserSummary = {
  status: "parsed" | "ocr_required"; paperID: string; documentID: string
  documentPath: string; chunksPath: string; chunkCount: number; warningCount: number; publicationStatus: string
}

export class LiteratureAgent {
  private readonly knowledgeRoot: string
  private readonly store: KnowledgeStore

  constructor(private readonly config: {
    readonly onProgress?: (progress: LiteratureProgress) => Promise<void>
    readonly neoCastRoot: string
    readonly workspaceRoot: string
    readonly model?: LiteratureExtractionModel
    readonly knowledgeRoot?: string
    readonly pythonExecutable?: string
    readonly documentParser?: (source: LiteratureAgentInput["sources"][number]) => Promise<ParserSummary>
  }) {
    this.knowledgeRoot = path.resolve(config.knowledgeRoot ?? path.join(config.neoCastRoot, ".neo-cast", "literature-knowledge"))
    this.store = new KnowledgeStore(path.join(this.knowledgeRoot, "knowledge.db"))
  }

  close() { this.store.close() }

  async parseOnly(source: LiteratureAgentInput["sources"][number]) {
    return this.config.documentParser?.(source) ?? this.parseSource(source)
  }

  async run(input: LiteratureAgentInput): Promise<LiteratureAgentResult> {
    const model = this.config.model ?? new DisabledExtractionModel()
    const options = {
      force: input.options?.force ?? false,
      cardTypes: input.options?.cardTypes ?? DEFAULT_CARD_TYPES,
      maxCardsPerPaper: input.options?.maxCardsPerPaper ?? 30,
      includeAgentInference: input.options?.includeAgentInference ?? true,
      requireExactEvidenceSpan: input.options?.requireExactEvidenceSpan ?? true,
    }
    if (!Number.isInteger(options.maxCardsPerPaper) || options.maxCardsPerPaper < 1 || options.maxCardsPerPaper > 1000) {
      throw new Error("maxCardsPerPaper must be an integer between 1 and 1000")
    }
    const result: LiteratureAgentResult = {
      agent: "LiteratureAgent", runIDs: [], processed: [],
      summary: { paperCount: input.sources.length, acceptedCardCount: 0, paperBackedCount: 0, agentInferenceCount: 0, duplicateCount: 0, failedCount: 0 },
    }
    for (const source of input.sources) {
      try {
        const processed = await this.processSource(source, options, model)
        result.processed.push(processed.output)
        if (processed.runID) result.runIDs.push(processed.runID)
        result.summary.acceptedCardCount += processed.cards.length
        result.summary.paperBackedCount += processed.cards.filter((card) => card.status === "paper_backed").length
        result.summary.agentInferenceCount += processed.cards.filter((card) => card.evidence.every((item) => item.evidenceType === "agent_inference")).length
        result.summary.duplicateCount += processed.duplicateCount
      } catch (error) {
        // Corrupt contracts, cached JSON and SQLite state must never become paper gaps.
        if (error instanceof SyntaxError || (error instanceof Error &&
          (["ZodError", "SQLiteError", "AbortError", "TimeoutError"].includes(error.name)))) throw error
        await this.config.onProgress?.({ step: "parse", paperID: source.kind === "catalog_paper" ? source.paperID : undefined, status: "failed" })
        result.summary.failedCount += 1
        result.processed.push({
          paperID: source.kind === "catalog_paper" ? source.paperID : "unresolved-local-pdf",
          documentID: "", status: "failed", acceptedCardIDs: [], rejectedCandidateCount: 0,
          warningCount: 0, reviewPath: "", error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return result
  }

  private async processSource(
    source: LiteratureAgentInput["sources"][number],
    options: {
      force: boolean; cardTypes: readonly CandidateClaim["cardType"][]; maxCardsPerPaper: number
      includeAgentInference: boolean; requireExactEvidenceSpan: boolean
    },
    model: LiteratureExtractionModel,
  ) {
    await this.config.onProgress?.({ step: "parse", paperID: source.kind === "catalog_paper" ? source.paperID : undefined, status: "running" })
    const parsed = await (this.config.documentParser?.(source) ?? this.parseSource(source))
    const document = NormalizedDocumentSchema.parse(JSON.parse(await readFile(parsed.documentPath, "utf8")))
    const chunks = parseJsonl(await readFile(parsed.chunksPath, "utf8"), DocumentChunkSchema)
    const paperMetadataPath = parsed.documentPath.replace(/\.document\.json$/, ".paper.json")
    const paper = JSON.parse(await readFile(paperMetadataPath, "utf8")) as Record<string, unknown>
    const taxonomyPath = path.join(this.config.neoCastRoot, "literature_knowledge", "taxonomy.v1.json")
    const taxonomy = await loadTaxonomy(taxonomyPath)
    const versions = {
      parser: document.parser.version, chunker: "paragraph_chunker_v1", taxonomy: taxonomy.schemaVersion,
      candidatePrompt: model.candidatePromptVersion, verifierPrompt: model.verifierPromptVersion,
      model: model.modelIdentifier, knowledgeCardSchema: "knowledge_card_v1",
    }
    const inputDigest = digest({
      paperID: document.paperID, pdfSha256: document.sourceSha256, ...versions,
      extractionOptions: {
        cardTypes: [...options.cardTypes].sort(), maxCardsPerPaper: options.maxCardsPerPaper,
        includeAgentInference: options.includeAgentInference,
        requireExactEvidenceSpan: options.requireExactEvidenceSpan,
      },
    })
    const existingRun = options.force ? undefined : this.store.findCompletedRun(inputDigest)
    if (existingRun) {
      const runID = String(existingRun.run_id)
      const acceptedCardsPath = path.join(this.knowledgeRoot, "runs", runID, "accepted_cards.jsonl")
      const cards = await exists(acceptedCardsPath)
        ? parseJsonl(await readFile(acceptedCardsPath, "utf8"), KnowledgeCardSchema)
        : this.store.listCards({ paperID: document.paperID }).filter((card) =>
            options.includeAgentInference || card.evidence.some((item) => item.evidenceType !== "agent_inference"),
          )
      return {
        runID, cards, duplicateCount: Number(JSON.parse(String(existingRun.counters_json)).duplicateCount ?? 0),
        output: {
          paperID: document.paperID, documentID: document.documentID, status: "completed" as const,
          acceptedCardIDs: cards.map((card) => card.cardID),
          rejectedCandidateCount: Number(JSON.parse(String(existingRun.counters_json)).rejectedCount ?? 0),
          warningCount: document.parseWarnings.length, reviewPath: path.join(this.knowledgeRoot, "runs", runID, "review.md"),
        },
      }
    }

    const runID = `lerun_${Date.now()}_${inputDigest.slice(0, 8)}`
    const runDir = path.join(this.knowledgeRoot, "runs", runID)
    const reviewPath = path.join(runDir, "review.md")
    await mkdir(runDir, { recursive: true })
    await writeJson(path.join(runDir, "input.json"), { source, options, inputDigest })
    this.store.transaction(() => {
      this.store.saveDocument({ document, chunks, documentPath: parsed.documentPath, parseStatus: parsed.status })
      this.store.createRun({
        runID, paperID: document.paperID, documentID: document.documentID, status: "running",
        extractorModel: model.modelIdentifier,
        promptVersions: { candidate: model.candidatePromptVersion, verifier: model.verifierPromptVersion },
        schemaVersions: { document: "normalized_document_v1", chunk: "document_chunk_v1", card: "knowledge_card_v1" },
        inputDigest, counters: { candidateCount: 0, acceptedCount: 0, rejectedCount: 0, duplicateCount: 0, warningCount: document.parseWarnings.length },
        startedAt: Date.now(),
      })
    })

    if (parsed.status === "ocr_required" || !model.available) {
      const counters = { candidateCount: 0, acceptedCount: 0, rejectedCount: 0, duplicateCount: 0, warningCount: document.parseWarnings.length }
      this.store.finishRun(runID, "partial", counters, parsed.status === "ocr_required" ? { code: "ocr_required" } : { code: "llm_not_configured" })
      await this.writeRunArtifacts({ runDir, runID, document, versions, inputDigest, status: "partial", candidates: [], verifications: [], cards: [], rejected: [], taxonomySuggestions: [], counters, reviewPath })
      return {
        runID, cards: [], duplicateCount: 0,
        output: { paperID: document.paperID, documentID: document.documentID, status: "partial" as const, acceptedCardIDs: [], rejectedCandidateCount: 0, warningCount: document.parseWarnings.length, reviewPath },
      }
    }

    await this.config.onProgress?.({ step: "extract", paperID: document.paperID, status: "running" })
    const extracted = await extractCandidates({
      model, chunks, paper, cardTypes: options.cardTypes, includeAgentInference: options.includeAgentInference,
    })
    const candidates = extracted.candidates.slice(0, options.maxCardsPerPaper)
    const rejected: RejectedCandidate[] = extracted.malformed.map((item) => ({ candidate: item.value, reason: "schema_invalid", detail: item.error }))
    const normalizedCards: KnowledgeCard[] = []
    const verifications: unknown[] = []
    const taxonomySuggestions: string[] = []
    for (const candidate of candidates) {
      await this.config.onProgress?.({ step: "verify", paperID: document.paperID, status: "running" })
      const verified = await verifyCandidate({ model, candidate, chunks, requireExactEvidenceSpan: options.requireExactEvidenceSpan })
        .catch((error) => ({ ok: false as const, rejection: { candidate, reason: "evidence_does_not_support_claim" as const, detail: `verifier error: ${String(error)}` } }))
      if (!verified.ok) { rejected.push(verified.rejection); continue }
      verifications.push({ candidateID: candidate.candidateID, ...verified.verification })
      const normalized = normalizeCandidate({
        candidate: verified.candidate, evidence: verified.evidence, verification: verified.verification,
        taxonomy, documentID: document.documentID, documentSha256: document.sourceSha256,
        publicationStatus: parsed.publicationStatus,
        publicationVerification: typeof paper.publication_verification === "string" ? paper.publication_verification : undefined,
        modelIdentifier: model.modelIdentifier, candidatePromptVersion: model.candidatePromptVersion,
        verifierPromptVersion: model.verifierPromptVersion, runID, now: new Date().toISOString(),
      })
      normalizedCards.push(KnowledgeCardSchema.parse(normalized.card))
      taxonomySuggestions.push(...normalized.taxonomySuggestions)
    }

    const working = this.store.listCards()
    const cardsToSave: KnowledgeCard[] = []
    const relations: CardRelation[] = []
    let duplicateCount = 0
    for (const card of normalizedCards) {
      const decision = deduplicateCard(card, working)
      if (decision.action === "merge") {
        duplicateCount += 1
        rejected.push({ candidate: card, reason: "duplicate", detail: `merged evidence into ${decision.duplicateOf.cardID}` })
        const rebased = { ...card, cardID: decision.duplicateOf.cardID }
        cardsToSave.push(rebased)
        const merged = mergeCardEvidence(decision.duplicateOf, rebased, decision.duplicateOf.revision + 1, rebased.provenance.updatedAt)
        working.splice(working.indexOf(decision.duplicateOf), 1, merged)
      } else {
        cardsToSave.push(card)
        working.push(card)
        relations.push(...decision.relations)
      }
    }

    const savedCards: KnowledgeCard[] = []
    const counters = {
      candidateCount: candidates.length + extracted.malformed.length,
      acceptedCount: cardsToSave.length, rejectedCount: rejected.length,
      duplicateCount, warningCount: document.parseWarnings.length + extracted.failedChunks.length,
    }
    const status = extracted.failedChunks.length ? "partial" as const : "completed" as const
    this.store.transaction(() => {
      for (const item of rejected) this.store.saveRejected(runID, item)
      for (const card of cardsToSave) savedCards.push(this.store.saveCard(card))
      for (const relation of relations) this.store.saveRelation(relation)
      this.store.finishRun(runID, status, counters, extracted.failedChunks.length ? { failedChunks: extracted.failedChunks } : undefined)
    })
    await this.writeRunArtifacts({
      runDir, runID, document, versions, inputDigest, status, candidates, verifications,
      cards: savedCards, rejected, taxonomySuggestions: [...new Set(taxonomySuggestions)], counters, reviewPath,
      callRecords: model.drainCallRecords?.() ?? [], failedChunks: extracted.failedChunks,
    })
    await this.exportCurrentCards()
    return {
      runID, cards: savedCards, duplicateCount,
      output: {
        paperID: document.paperID, documentID: document.documentID, status,
        acceptedCardIDs: savedCards.map((card) => card.cardID), rejectedCandidateCount: rejected.length,
        warningCount: counters.warningCount, reviewPath,
      },
    }
  }

  private async parseSource(source: LiteratureAgentInput["sources"][number]): Promise<ParserSummary> {
    const runtimePython = path.join(this.config.neoCastRoot, ".neo-cast", "runtime", ".venv", "bin", "python")
    const python = this.config.pythonExecutable ?? process.env.NEO_CAST_PYTHON ?? (await exists(runtimePython) ? runtimePython : "python3")
    const args = ["-m", "literature_knowledge.cli", "parse", "--neo-cast-root", this.config.neoCastRoot]
    if (source.kind === "catalog_paper") args.push("--paper-id", source.paperID)
    else {
      args.push("--pdf", path.resolve(source.path), "--title", source.metadata.title, "--publication-status", source.metadata.publicationStatus ?? "unknown")
      if (source.metadata.year !== undefined) args.push("--year", String(source.metadata.year))
      if (source.metadata.venue) args.push("--venue", source.metadata.venue)
      if (source.metadata.doi) args.push("--doi", source.metadata.doi)
    }
    const child = Bun.spawn([python, ...args], {
      cwd: this.config.neoCastRoot,
      env: { ...process.env, PYTHONPATH: path.join(this.config.neoCastRoot, "py") },
      stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const lastLine = stdout.trim().split(/\r?\n/).at(-1)
    if (exitCode !== 0 || !lastLine) throw new Error(`Document parser failed: ${stderr || stdout}`)
    const summary = JSON.parse(lastLine) as ParserSummary & { error?: { message?: string } }
    if ((summary as unknown as { status: string }).status === "failed") throw new Error(summary.error?.message ?? "Document parser failed")
    return summary
  }

  private async writeRunArtifacts(input: {
    runDir: string; runID: string; document: { paperID: string; documentID: string; parseWarnings: string[] }
    versions: Record<string, string>; inputDigest: string; status: "completed" | "partial"
    candidates: readonly unknown[]; verifications: readonly unknown[]; cards: readonly KnowledgeCard[]
    rejected: readonly RejectedCandidate[]; taxonomySuggestions: readonly string[]; counters: Record<string, number>
    reviewPath: string; callRecords?: readonly unknown[]; failedChunks?: readonly unknown[]
  }) {
    await Promise.all([
      writeJsonl(path.join(input.runDir, "candidate_claims.jsonl"), input.candidates),
      writeJsonl(path.join(input.runDir, "verification_results.jsonl"), input.verifications),
      writeJsonl(path.join(input.runDir, "accepted_cards.jsonl"), input.cards),
      writeJsonl(path.join(input.runDir, "rejected_candidates.jsonl"), input.rejected),
      writeJsonl(path.join(input.runDir, "taxonomy_suggestions.jsonl"), input.taxonomySuggestions.map((term) => ({ term }))),
      writeJsonl(path.join(input.runDir, "model_calls.jsonl"), input.callRecords ?? []),
      atomicWrite(input.reviewPath, renderReview({ paperID: input.document.paperID, runID: input.runID, cards: input.cards, rejected: input.rejected, warnings: input.document.parseWarnings })),
      writeJson(path.join(input.runDir, "run_manifest.json"), {
        schemaVersion: "extraction_manifest_v1", runID: input.runID, paperID: input.document.paperID,
        documentID: input.document.documentID, inputDigest: input.inputDigest, status: input.status,
        versions: input.versions, counters: input.counters,
        ...(input.failedChunks?.length ? { error: { failedChunks: input.failedChunks } } : {}),
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      }),
    ])
  }

  private async exportCurrentCards(status?: string) {
    const exportDir = path.join(this.knowledgeRoot, "exports")
    const cards = this.store.listCards(status ? { status } : {})
    const relations = this.store.listRelations()
    await Promise.all([
      atomicWrite(path.join(exportDir, "knowledge_cards.jsonl"), renderCardExport(cards)),
      writeJsonl(path.join(exportDir, "card_relations.jsonl"), relations),
    ])
  }

  async export(status?: string) {
    await this.exportCurrentCards(status)
    return { status: "completed", cardCount: this.store.listCards(status ? { status } : {}).length, exportRoot: path.join(this.knowledgeRoot, "exports") }
  }

  validate() {
    const cards = this.store.listCards().map((item) => KnowledgeCardSchema.parse(item))
    return { status: "valid", cardCount: cards.length, relationCount: this.store.listRelations().length }
  }

  showRun(runID: string) {
    const run = this.store.getRun(runID)
    if (!run) throw new Error(`Extraction run not found: ${runID}`)
    return { run, rejected: this.store.listRejected(runID) }
  }
}
