import { createHash } from "crypto"
import { access, mkdir, readFile, readdir, rename, writeFile } from "fs/promises"
import path from "path"
import { Database } from "bun:sqlite"
import { KnowledgeCardSchema } from "../literature/contract"

export const RETRIEVAL_TOKENIZER_VERSION = "unicode_word_v1"
export const RETRIEVAL_INDEX_SCHEMA_VERSION = "local_retrieval_index_v1"

export type IndexedPaper = {
  readonly paperID: string
  readonly title: string
  readonly year?: number
  readonly venue?: string
  readonly publicationStatus: string
  readonly doi?: string
  readonly arxivID?: string
  readonly localPDF: boolean
  readonly sourceSha256?: string
  readonly fields: {
    readonly title: string
    readonly abstract: string
    readonly introduction: string
    readonly method: string
    readonly results: string
    readonly limitations: string
    readonly knowledgeCard: string
  }
  readonly evidenceLevel: "metadata_only" | "document_available" | "paper_backed"
}

export type LocalRetrievalIndex = {
  readonly indexRoot: string
  readonly databasePath: string
  readonly indexDigest: string
  readonly documents: readonly IndexedPaper[]
  readonly manifest: Record<string, unknown>
}

type MutablePaper = {
  paperID: string
  title: string
  year?: number
  venue?: string
  publicationStatus: string
  doi?: string
  arxivID?: string
  localPDF: boolean
  sourceSha256?: string
  fields: { title: string; abstract: string; introduction: string; method: string; results: string; limitations: string; knowledgeCard: string }
  hasDocument: boolean
  hasPaperBackedCard: boolean
}

const EVIDENCE_RANK: Record<IndexedPaper["evidenceLevel"], number> = {
  metadata_only: 0,
  document_available: 1,
  paper_backed: 2,
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`
  return JSON.stringify(value)
}

function digestText(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

async function exists(file: string) {
  try { await access(file); return true } catch { return false }
}

async function readJsonl(file: string): Promise<unknown[]> {
  if (!(await exists(file))) return []
  return (await readFile(file, "utf8")).split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line))
}

async function filesUnder(root: string, suffix: string): Promise<string[]> {
  if (!(await exists(root))) return []
  const output: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile() && entry.name.endsWith(suffix)) output.push(file)
    }
  }
  await visit(root)
  return output.toSorted()
}

function emptyPaper(paperID: string): MutablePaper {
  return {
    paperID,
    title: paperID,
    publicationStatus: "unknown",
    localPDF: false,
    fields: { title: paperID, abstract: "", introduction: "", method: "", results: "", limitations: "", knowledgeCard: "" },
    hasDocument: false,
    hasPaperBackedCard: false,
  }
}

function appendField(paper: MutablePaper, field: keyof MutablePaper["fields"], text: string) {
  if (!text.trim()) return
  paper.fields[field] = paper.fields[field] ? `${paper.fields[field]}\n${text.trim()}` : text.trim()
}

function catalogPaths(neoCastRoot: string) {
  return [
    path.join(neoCastRoot, ".neo-cast", "literature-source", "catalog", "papers.jsonl"),
    path.join(neoCastRoot, "literature_source", "catalog", "papers.jsonl"),
  ]
}

function catalogPDFCandidates(neoCastRoot: string, catalogPath: string, rawPath: unknown) {
  if (typeof rawPath !== "string" || !rawPath) return []
  if (path.isAbsolute(rawPath)) return [rawPath]
  return [
    path.join(neoCastRoot, rawPath),
    path.join(path.dirname(path.dirname(catalogPath)), rawPath),
    path.join(neoCastRoot, "literature_source", rawPath),
  ]
}

function deduplicateDocuments(documents: readonly IndexedPaper[]) {
  const grouped = new Map<string, IndexedPaper>()
  for (const document of documents) {
    const identity = document.doi
      ? `doi:${document.doi.toLowerCase()}`
      : document.arxivID
        ? `arxiv:${document.arxivID.toLowerCase()}`
        : `paper:${document.paperID}`
    const existing = grouped.get(identity)
    if (!existing) { grouped.set(identity, document); continue }
    const existingPriority = EVIDENCE_RANK[existing.evidenceLevel] * 2 + (existing.localPDF ? 1 : 0)
    const documentPriority = EVIDENCE_RANK[document.evidenceLevel] * 2 + (document.localPDF ? 1 : 0)
    const primary = documentPriority > existingPriority ? document : existing
    const secondary = primary === document ? existing : document
    grouped.set(identity, {
      ...primary,
      localPDF: primary.localPDF || secondary.localPDF,
      fields: Object.fromEntries(Object.keys(primary.fields).map((field) => {
        const key = field as keyof IndexedPaper["fields"]
        const values = [primary.fields[key], secondary.fields[key]].filter(Boolean)
        return [key, [...new Set(values)].join("\n")]
      })) as IndexedPaper["fields"],
      evidenceLevel: EVIDENCE_RANK[primary.evidenceLevel] >= EVIDENCE_RANK[secondary.evidenceLevel]
        ? primary.evidenceLevel
        : secondary.evidenceLevel,
    })
  }
  return [...grouped.values()].toSorted((left, right) => left.paperID.localeCompare(right.paperID))
}

export async function collectIndexedPapers(input: {
  readonly neoCastRoot: string
  readonly knowledgeRoot?: string
  readonly catalogPath?: string
}): Promise<{ documents: IndexedPaper[]; sourceDigests: Record<string, string> }> {
  const neoCastRoot = path.resolve(input.neoCastRoot)
  const knowledgeRoot = path.resolve(input.knowledgeRoot ?? path.join(neoCastRoot, ".neo-cast", "literature-knowledge"))
  const candidateCatalogs = input.catalogPath ? [path.resolve(input.catalogPath)] : catalogPaths(neoCastRoot)
  const catalogPath = await (async () => {
    for (const candidate of candidateCatalogs) if (await exists(candidate)) return candidate
    return candidateCatalogs[0]!
  })()
  const sourceDigests: Record<string, string> = {}
  const papers = new Map<string, MutablePaper>()
  if (await exists(catalogPath)) sourceDigests[path.relative(neoCastRoot, catalogPath)] = digestText(await readFile(catalogPath, "utf8"))
  for (const value of await readJsonl(catalogPath)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const record = value as Record<string, unknown>
    const paperID = typeof record.paper_id === "string" ? record.paper_id : undefined
    if (!paperID) continue
    const paper = emptyPaper(paperID)
    paper.title = typeof record.title === "string" ? record.title : paperID
    paper.fields.title = paper.title
    paper.year = typeof record.year === "number" ? record.year : undefined
    paper.venue = typeof record.venue === "string" ? record.venue : undefined
    paper.publicationStatus = typeof record.publication_status === "string" ? record.publication_status : "unknown"
    const identifiers = record.identifiers && typeof record.identifiers === "object" ? record.identifiers as Record<string, unknown> : {}
    paper.doi = typeof identifiers.doi === "string" ? identifiers.doi : undefined
    paper.arxivID = typeof identifiers.arxiv === "string" ? identifiers.arxiv : undefined
    const download = record.download && typeof record.download === "object" ? record.download as Record<string, unknown> : {}
    let pdfAvailable = false
    for (const candidate of catalogPDFCandidates(neoCastRoot, catalogPath, download.path)) {
      if (await exists(candidate)) { pdfAvailable = true; break }
    }
    paper.localPDF = download.status === "downloaded" && pdfAvailable
    paper.sourceSha256 = typeof download.sha256 === "string" ? download.sha256 : undefined
    papers.set(paperID, paper)
  }

  for (const documentPath of await filesUnder(path.join(knowledgeRoot, "documents"), ".document.json")) {
    const documentText = await readFile(documentPath, "utf8")
    sourceDigests[path.relative(neoCastRoot, documentPath)] = digestText(documentText)
    const raw = JSON.parse(documentText) as Record<string, unknown>
    const paperID = typeof raw.paperID === "string" ? raw.paperID : undefined
    if (!paperID) continue
    const paper = papers.get(paperID) ?? emptyPaper(paperID)
    paper.title = typeof raw.title === "string" ? raw.title : paper.title
    paper.fields.title = paper.title
    paper.sourceSha256 = typeof raw.sourceSha256 === "string" ? raw.sourceSha256 : paper.sourceSha256
    paper.localPDF = paper.localPDF || (typeof raw.sourcePath === "string" && await exists(raw.sourcePath))
    paper.hasDocument = true
    const chunksPath = documentPath.replace(/\.document\.json$/, ".chunks.jsonl")
    if (await exists(chunksPath)) {
      const chunkText = await readFile(chunksPath, "utf8")
      sourceDigests[path.relative(neoCastRoot, chunksPath)] = digestText(chunkText)
      for (const value of chunkText.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>)) {
        const text = typeof value.text === "string" ? value.text : ""
        switch (value.sectionKind) {
          case "abstract": appendField(paper, "abstract", text); break
          case "introduction": appendField(paper, "introduction", text); break
          case "method": case "experiment_setup": case "complexity": appendField(paper, "method", text); break
          case "results": case "ablation": case "conclusion": appendField(paper, "results", text); break
          case "limitations": appendField(paper, "limitations", text); break
          default: break
        }
      }
    }
    papers.set(paperID, paper)
  }

  const cardsPath = path.join(knowledgeRoot, "exports", "knowledge_cards.jsonl")
  if (await exists(cardsPath)) sourceDigests[path.relative(neoCastRoot, cardsPath)] = digestText(await readFile(cardsPath, "utf8"))
  for (const value of await readJsonl(cardsPath)) {
    const card = KnowledgeCardSchema.safeParse(value)
    if (!card.success) continue
    const paper = papers.get(card.data.paperID) ?? emptyPaper(card.data.paperID)
    appendField(paper, "knowledgeCard", [card.data.claim, card.data.mechanism?.principle, ...card.data.applicability.dataFeatures].filter(Boolean).join(" "))
    if (["paper_backed", "corroborated"].includes(card.data.status)) paper.hasPaperBackedCard = true
    papers.set(paper.paperID, paper)
  }

  const documents = deduplicateDocuments([...papers.values()].map((paper): IndexedPaper => ({
    paperID: paper.paperID,
    title: paper.title,
    ...(paper.year === undefined ? {} : { year: paper.year }),
    ...(paper.venue === undefined ? {} : { venue: paper.venue }),
    publicationStatus: paper.publicationStatus,
    ...(paper.doi === undefined ? {} : { doi: paper.doi }),
    ...(paper.arxivID === undefined ? {} : { arxivID: paper.arxivID }),
    localPDF: paper.localPDF,
    ...(paper.sourceSha256 === undefined ? {} : { sourceSha256: paper.sourceSha256 }),
    fields: paper.fields,
    evidenceLevel: paper.hasPaperBackedCard ? "paper_backed" : paper.hasDocument ? "document_available" : "metadata_only",
  })))
  return { documents, sourceDigests }
}

async function atomicWrite(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}`
  await writeFile(temporary, content, "utf8")
  await rename(temporary, file)
}

export async function buildLocalIndex(input: {
  readonly neoCastRoot: string
  readonly retrievalRoot?: string
  readonly knowledgeRoot?: string
  readonly catalogPath?: string
  readonly taxonomyVersion?: string
}): Promise<LocalRetrievalIndex> {
  const retrievalRoot = path.resolve(input.retrievalRoot ?? path.join(input.neoCastRoot, ".neo-cast", "literature-retrieval"))
  const indexRoot = path.join(retrievalRoot, "index")
  await mkdir(indexRoot, { recursive: true })
  const { documents, sourceDigests } = await collectIndexedPapers(input)
  const indexDigest = digestText(stableJson({ documents, sourceDigests, tokenizer: RETRIEVAL_TOKENIZER_VERSION }))
  const databasePath = path.join(indexRoot, "retrieval.db")
  const db = new Database(databasePath, { create: true, strict: true })
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS paper (
        paper_id TEXT PRIMARY KEY, title TEXT NOT NULL, year INTEGER, venue TEXT,
        publication_status TEXT NOT NULL, local_pdf INTEGER NOT NULL, evidence_level TEXT NOT NULL,
        doi TEXT, arxiv_id TEXT, source_sha256 TEXT
      );
      CREATE TABLE IF NOT EXISTS paper_text (
        paper_id TEXT PRIMARY KEY, abstract TEXT NOT NULL, introduction TEXT NOT NULL,
        method TEXT NOT NULL, results TEXT NOT NULL, limitations TEXT NOT NULL, knowledge_card TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS paper_fts USING fts5(
        paper_id UNINDEXED, title, abstract, knowledge_card, method, introduction, results, limitations
      );
      CREATE TABLE IF NOT EXISTS card_projection (paper_id TEXT PRIMARY KEY, projection_text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS index_source (source_path TEXT PRIMARY KEY, source_digest TEXT NOT NULL);
      DELETE FROM paper; DELETE FROM paper_text; DELETE FROM paper_fts; DELETE FROM card_projection; DELETE FROM index_source;
    `)
    const insertPaper = db.query("INSERT INTO paper VALUES(?,?,?,?,?,?,?,?,?,?)")
    const insertText = db.query("INSERT INTO paper_text VALUES(?,?,?,?,?,?,?)")
    const insertFTS = db.query("INSERT INTO paper_fts VALUES(?,?,?,?,?,?,?,?)")
    const insertCardProjection = db.query("INSERT INTO card_projection VALUES(?,?)")
    db.transaction(() => {
      for (const document of documents) {
        insertPaper.run(document.paperID, document.title, document.year ?? null, document.venue ?? null, document.publicationStatus, document.localPDF ? 1 : 0, document.evidenceLevel, document.doi ?? null, document.arxivID ?? null, document.sourceSha256 ?? null)
        insertText.run(document.paperID, document.fields.abstract, document.fields.introduction, document.fields.method, document.fields.results, document.fields.limitations, document.fields.knowledgeCard)
        insertFTS.run(document.paperID, document.fields.title, document.fields.abstract, document.fields.knowledgeCard, document.fields.method, document.fields.introduction, document.fields.results, document.fields.limitations)
        if (document.fields.knowledgeCard) insertCardProjection.run(document.paperID, document.fields.knowledgeCard)
      }
      const insertSource = db.query("INSERT INTO index_source VALUES(?,?)")
      for (const [sourcePath, sourceDigest] of Object.entries(sourceDigests)) insertSource.run(sourcePath, sourceDigest)
    })()
  } finally {
    db.close()
  }
  const manifest = {
    schemaVersion: RETRIEVAL_INDEX_SCHEMA_VERSION,
    indexDigest,
    sourceDigests,
    catalogSha256: Object.entries(sourceDigests).find(([sourcePath]) => sourcePath.endsWith("catalog/papers.jsonl"))?.[1],
    knowledgeCardExportDigest: Object.entries(sourceDigests).find(([sourcePath]) => sourcePath.endsWith("exports/knowledge_cards.jsonl"))?.[1],
    tokenizerVersion: RETRIEVAL_TOKENIZER_VERSION,
    bm25: { k1: 1.2, b: 0.75, fieldWeights: { title: 4, abstract: 3, knowledgeCard: 3, method: 2, introduction: 1.5, results: 1.5, limitations: 1 } },
    taxonomyVersion: input.taxonomyVersion ?? "literature_taxonomy_v1",
    documentCount: documents.length,
    builtAt: new Date().toISOString(),
  }
  await Promise.all([
    atomicWrite(path.join(indexRoot, "index_manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    atomicWrite(path.join(indexRoot, "document_fingerprints.jsonl"), documents.map((document) => JSON.stringify({ paperID: document.paperID, fingerprint: digestText(stableJson(document)) })).join("\n") + (documents.length ? "\n" : "")),
  ])
  return { indexRoot, databasePath, indexDigest, documents, manifest }
}
