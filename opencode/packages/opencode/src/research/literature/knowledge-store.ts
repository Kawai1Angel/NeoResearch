import { createHash } from "crypto"
import { mkdirSync } from "fs"
import path from "path"
import { Database } from "bun:sqlite"
import {
  CardRelationSchema, KnowledgeCardSchema,
  type CardRelation, type DocumentChunk, type KnowledgeCard, type NormalizedDocument, type RejectedCandidate,
} from "./contract"
import { mergeCardEvidence } from "./card-deduplicator"

function json(value: unknown) { return JSON.stringify(value) }
function hashJson(value: unknown) { return createHash("sha256").update(json(value)).digest("hex") }
function displayConfidence(card: KnowledgeCard) {
  return (card.confidence.sourceQuality + card.confidence.extractionConfidence + card.confidence.evidenceDirectness + card.confidence.transferability) / 4
}

export type ExtractionRunRecord = {
  readonly runID: string; readonly paperID: string; readonly documentID: string
  readonly status: "running" | "completed" | "partial" | "failed"
  readonly extractorModel: string; readonly promptVersions: Record<string, string>
  readonly schemaVersions: Record<string, string>; readonly inputDigest: string
  readonly counters: Record<string, number>; readonly error?: unknown
  readonly startedAt: number; readonly finishedAt?: number
}

export class KnowledgeStore {
  readonly databasePath: string
  private readonly db: Database

  constructor(databasePath: string) {
    this.databasePath = path.resolve(databasePath)
    mkdirSync(path.dirname(this.databasePath), { recursive: true })
    this.db = new Database(this.databasePath, { create: true, strict: true })
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")
    this.migrate()
  }

  close() { this.db.close() }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kb_document (
        document_id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, source_path TEXT NOT NULL,
        source_sha256 TEXT NOT NULL UNIQUE, parser_name TEXT NOT NULL, parser_version TEXT NOT NULL,
        normalized_json_path TEXT NOT NULL, parse_status TEXT NOT NULL,
        warnings_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS kb_document_paper_idx ON kb_document(paper_id);
      CREATE TABLE IF NOT EXISTS kb_chunk (
        chunk_id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES kb_document(document_id) ON DELETE CASCADE,
        paper_id TEXT NOT NULL, section_kind TEXT NOT NULL, page_start INTEGER NOT NULL, page_end INTEGER NOT NULL,
        ordinal INTEGER NOT NULL, text TEXT NOT NULL, text_sha256 TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS kb_chunk_paper_idx ON kb_chunk(paper_id);
      CREATE INDEX IF NOT EXISTS kb_chunk_document_idx ON kb_chunk(document_id);
      CREATE INDEX IF NOT EXISTS kb_chunk_section_idx ON kb_chunk(section_kind);
      CREATE TABLE IF NOT EXISTS kb_extraction_run (
        run_id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, document_id TEXT NOT NULL,
        status TEXT NOT NULL, extractor_model TEXT NOT NULL, prompt_versions_json TEXT NOT NULL,
        schema_versions_json TEXT NOT NULL, input_digest TEXT NOT NULL,
        counters_json TEXT NOT NULL, error_json TEXT, started_at INTEGER NOT NULL, finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS kb_run_digest_idx ON kb_extraction_run(input_digest, status);
      CREATE TABLE IF NOT EXISTS kb_card (
        card_id TEXT PRIMARY KEY, current_revision INTEGER NOT NULL, paper_id TEXT NOT NULL, card_type TEXT NOT NULL,
        normalized_subject TEXT NOT NULL, normalized_predicate TEXT NOT NULL, normalized_object TEXT NOT NULL,
        claim TEXT NOT NULL, status TEXT NOT NULL, confidence REAL NOT NULL,
        card_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS kb_card_paper_idx ON kb_card(paper_id);
      CREATE INDEX IF NOT EXISTS kb_card_spo_idx ON kb_card(normalized_subject, normalized_predicate, normalized_object);
      CREATE TABLE IF NOT EXISTS kb_card_revision (
        card_id TEXT NOT NULL REFERENCES kb_card(card_id) ON DELETE CASCADE, revision INTEGER NOT NULL,
        card_json TEXT NOT NULL, card_hash TEXT NOT NULL, previous_hash TEXT,
        actor TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(card_id, revision)
      );
      CREATE TABLE IF NOT EXISTS kb_card_evidence (
        evidence_id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES kb_card(card_id) ON DELETE CASCADE,
        chunk_id TEXT NOT NULL REFERENCES kb_chunk(chunk_id), section TEXT NOT NULL,
        page_start INTEGER NOT NULL, page_end INTEGER NOT NULL, evidence_span TEXT NOT NULL,
        evidence_type TEXT NOT NULL, directness TEXT NOT NULL, verification TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kb_card_relation (
        relation_id TEXT PRIMARY KEY, source_card_id TEXT NOT NULL REFERENCES kb_card(card_id) ON DELETE CASCADE,
        target_card_id TEXT NOT NULL REFERENCES kb_card(card_id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL, rationale TEXT NOT NULL, confidence REAL NOT NULL,
        created_by TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kb_rejected_candidate (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES kb_extraction_run(run_id) ON DELETE CASCADE,
        candidate_json TEXT NOT NULL, reason TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `)
  }

  transaction<T>(callback: () => T): T {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const result = callback()
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  saveDocument(input: {
    document: NormalizedDocument; chunks: readonly DocumentChunk[]; documentPath: string; parseStatus: string; createdAt?: number
  }) {
    const now = input.createdAt ?? Date.now()
    const document = input.document
    this.db.query(`
      INSERT INTO kb_document(document_id,paper_id,source_path,source_sha256,parser_name,parser_version,normalized_json_path,parse_status,warnings_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(document_id) DO UPDATE SET normalized_json_path=excluded.normalized_json_path,parse_status=excluded.parse_status,warnings_json=excluded.warnings_json
    `).run(document.documentID, document.paperID, document.sourcePath, document.sourceSha256, document.parser.name, document.parser.version, input.documentPath, input.parseStatus, json(document.parseWarnings), now)
    const statement = this.db.query(`
      INSERT INTO kb_chunk(chunk_id,document_id,paper_id,section_kind,page_start,page_end,ordinal,text,text_sha256)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(chunk_id) DO UPDATE SET text=excluded.text,text_sha256=excluded.text_sha256
    `)
    for (const chunk of input.chunks) {
      statement.run(chunk.chunkID, chunk.documentID, chunk.paperID, chunk.sectionKind, chunk.pageStart, chunk.pageEnd, chunk.ordinal, chunk.text, chunk.textSha256)
    }
  }

  findCompletedRun(inputDigest: string) {
    return this.db.query("SELECT * FROM kb_extraction_run WHERE input_digest=? AND status='completed' ORDER BY finished_at DESC LIMIT 1").get(inputDigest) as Record<string, unknown> | null
  }

  createRun(run: ExtractionRunRecord) {
    this.db.query(`
      INSERT INTO kb_extraction_run(run_id,paper_id,document_id,status,extractor_model,prompt_versions_json,schema_versions_json,input_digest,counters_json,error_json,started_at,finished_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(run.runID, run.paperID, run.documentID, run.status, run.extractorModel, json(run.promptVersions), json(run.schemaVersions), run.inputDigest, json(run.counters), run.error === undefined ? null : json(run.error), run.startedAt, run.finishedAt ?? null)
  }

  finishRun(runID: string, status: ExtractionRunRecord["status"], counters: Record<string, number>, error?: unknown) {
    this.db.query("UPDATE kb_extraction_run SET status=?,counters_json=?,error_json=?,finished_at=? WHERE run_id=?")
      .run(status, json(counters), error === undefined ? null : json(error), Date.now(), runID)
  }

  getRun(runID: string) {
    return this.db.query("SELECT * FROM kb_extraction_run WHERE run_id=?").get(runID) as Record<string, unknown> | null
  }

  listCards(filter: { paperID?: string; status?: string } = {}): KnowledgeCard[] {
    const clauses: string[] = []
    const values: string[] = []
    if (filter.paperID) { clauses.push("paper_id=?"); values.push(filter.paperID) }
    if (filter.status) { clauses.push("status=?"); values.push(filter.status) }
    const sql = `SELECT card_json FROM kb_card${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY paper_id,card_id`
    return (this.db.query(sql).all(...values) as Array<{ card_json: string }>).map((row) => KnowledgeCardSchema.parse(JSON.parse(row.card_json)))
  }

  getCard(cardID: string): KnowledgeCard | undefined {
    const row = this.db.query("SELECT card_json FROM kb_card WHERE card_id=?").get(cardID) as { card_json: string } | null
    return row ? KnowledgeCardSchema.parse(JSON.parse(row.card_json)) : undefined
  }

  saveCard(value: KnowledgeCard, actor = "literature-agent", reason = "extraction"): KnowledgeCard {
    const card = KnowledgeCardSchema.parse(value)
    const existing = this.getCard(card.cardID)
    const now = Date.now()
    const next = existing ? mergeCardEvidence(existing, card, existing.revision + 1, card.provenance.updatedAt) : card
    if (existing) {
      this.db.query(`UPDATE kb_card SET current_revision=?,claim=?,status=?,confidence=?,card_json=?,updated_at=? WHERE card_id=?`)
        .run(next.revision, next.claim, next.status, displayConfidence(next), json(next), now, next.cardID)
    } else {
      this.db.query(`
        INSERT INTO kb_card(card_id,current_revision,paper_id,card_type,normalized_subject,normalized_predicate,normalized_object,claim,status,confidence,card_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(next.cardID, next.revision, next.paperID, next.cardType, next.normalizedClaim.subject, next.normalizedClaim.predicate, next.normalizedClaim.object, next.claim, next.status, displayConfidence(next), json(next), now, now)
    }
    const previous = existing
      ? this.db.query("SELECT card_hash FROM kb_card_revision WHERE card_id=? ORDER BY revision DESC LIMIT 1").get(next.cardID) as { card_hash: string } | null
      : null
    this.db.query(`INSERT INTO kb_card_revision(card_id,revision,card_json,card_hash,previous_hash,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(next.cardID, next.revision, json(next), hashJson(next), previous?.card_hash ?? null, actor, reason, now)
    const evidenceStatement = this.db.query(`
      INSERT INTO kb_card_evidence(evidence_id,card_id,chunk_id,section,page_start,page_end,evidence_span,evidence_type,directness,verification)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(evidence_id) DO NOTHING
    `)
    for (const evidence of next.evidence) {
      evidenceStatement.run(evidence.evidenceID, next.cardID, evidence.chunkID, evidence.section, evidence.pageStart, evidence.pageEnd, evidence.evidenceSpan, evidence.evidenceType, evidence.directness, evidence.verification)
    }
    return next
  }

  saveRelation(value: CardRelation) {
    const relation = CardRelationSchema.parse(value)
    this.db.query(`
      INSERT INTO kb_card_relation(relation_id,source_card_id,target_card_id,relation_type,rationale,confidence,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(relation_id) DO UPDATE SET rationale=excluded.rationale,confidence=excluded.confidence
    `).run(relation.relationID, relation.sourceCardID, relation.targetCardID, relation.relationType, relation.rationale, relation.confidence, relation.createdBy, relation.createdAt)
  }

  listRelations(): CardRelation[] {
    return (this.db.query("SELECT * FROM kb_card_relation ORDER BY relation_id").all() as Array<Record<string, unknown>>).map((row) => CardRelationSchema.parse({
      relationID: row.relation_id, sourceCardID: row.source_card_id, targetCardID: row.target_card_id,
      relationType: row.relation_type, rationale: row.rationale, confidence: row.confidence,
      createdBy: row.created_by, createdAt: row.created_at,
    }))
  }

  saveRejected(runID: string, rejection: RejectedCandidate) {
    this.db.query("INSERT INTO kb_rejected_candidate(run_id,candidate_json,reason,detail,created_at) VALUES(?,?,?,?,?)")
      .run(runID, json(rejection.candidate), rejection.reason, rejection.detail, Date.now())
  }

  listRejected(runID: string) {
    return this.db.query("SELECT candidate_json,reason,detail FROM kb_rejected_candidate WHERE run_id=? ORDER BY id").all(runID) as Array<{ candidate_json: string; reason: string; detail: string }>
  }

  reviseCard(cardID: string, patch: Partial<Pick<KnowledgeCard, "claim" | "status" | "limitations" | "tags">>, actor: string, reason: string) {
    const existing = this.getCard(cardID)
    if (!existing) throw new Error(`Knowledge card not found: ${cardID}`)
    const next = KnowledgeCardSchema.parse({
      ...existing, ...patch, revision: existing.revision + 1,
      provenance: { ...existing.provenance, updatedAt: new Date().toISOString() },
    })
    return this.saveCardRevisionDirect(next, actor, reason)
  }

  approveCard(cardID: string, actor: string, reason: string) {
    const card = this.getCard(cardID)
    if (!card) throw new Error(`Knowledge card not found: ${cardID}`)
    const hasDirectPaperEvidence = card.evidence.some((item) => item.directness === "direct" && item.evidenceType !== "agent_inference")
    return this.reviseCard(cardID, { status: hasDirectPaperEvidence ? "paper_backed" : "inconclusive" }, actor, reason)
  }

  rejectCard(cardID: string, actor: string, reason: string) {
    return this.reviseCard(cardID, { status: "deprecated" }, actor, reason)
  }

  splitCard(cardID: string, replacements: readonly KnowledgeCard[], actor: string, reason: string) {
    const original = this.getCard(cardID)
    if (!original) throw new Error(`Knowledge card not found: ${cardID}`)
    if (replacements.length < 2) throw new Error("Splitting a card requires at least two replacement cards")
    if (replacements.some((item) => item.paperID !== original.paperID || item.cardID === original.cardID)) {
      throw new Error("Split cards must retain paper provenance and use new card IDs")
    }
    const created = replacements.map((item) => this.saveCard(item, actor, `split from ${cardID}: ${reason}`))
    this.rejectCard(cardID, actor, `split into ${created.map((item) => item.cardID).join(", ")}: ${reason}`)
    return created
  }

  mergeCards(targetCardID: string, sourceCardID: string, actor: string, reason: string) {
    const target = this.getCard(targetCardID)
    const source = this.getCard(sourceCardID)
    if (!target || !source) throw new Error("Both knowledge cards must exist before merging")
    if (target.paperID !== source.paperID) throw new Error("Cross-paper cards must be related, not merged")
    const evidence = [...target.evidence]
    const known = new Set(evidence.map((item) => item.evidenceID))
    for (const item of source.evidence) if (!known.has(item.evidenceID)) evidence.push(item)
    const merged = KnowledgeCardSchema.parse({
      ...target, evidence, revision: target.revision + 1,
      provenance: { ...target.provenance, updatedAt: new Date().toISOString() },
    })
    const result = this.saveCardRevisionDirect(merged, actor, `merge ${sourceCardID}: ${reason}`)
    this.rejectCard(sourceCardID, actor, `merged into ${targetCardID}: ${reason}`)
    return result
  }

  restoreRevision(cardID: string, revision: number, actor: string, reason: string) {
    const row = this.db.query("SELECT card_json FROM kb_card_revision WHERE card_id=? AND revision=?").get(cardID, revision) as { card_json: string } | null
    const current = this.getCard(cardID)
    if (!row || !current) throw new Error(`Knowledge card revision not found: ${cardID}@${revision}`)
    const restored = KnowledgeCardSchema.parse({
      ...JSON.parse(row.card_json), revision: current.revision + 1,
      provenance: { ...JSON.parse(row.card_json).provenance, updatedAt: new Date().toISOString() },
    })
    return this.saveCardRevisionDirect(restored, actor, reason)
  }

  private saveCardRevisionDirect(card: KnowledgeCard, actor: string, reason: string) {
    const now = Date.now()
    const previous = this.db.query("SELECT card_hash FROM kb_card_revision WHERE card_id=? ORDER BY revision DESC LIMIT 1").get(card.cardID) as { card_hash: string } | null
    this.db.query("UPDATE kb_card SET current_revision=?,claim=?,status=?,confidence=?,card_json=?,updated_at=? WHERE card_id=?")
      .run(card.revision, card.claim, card.status, displayConfidence(card), json(card), now, card.cardID)
    this.db.query("INSERT INTO kb_card_revision(card_id,revision,card_json,card_hash,previous_hash,actor,reason,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(card.cardID, card.revision, json(card), hashJson(card), previous?.card_hash ?? null, actor, reason, now)
    return card
  }
}
