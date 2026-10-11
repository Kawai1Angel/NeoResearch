import { createHash } from "node:crypto"
import { mkdir, writeFile, rename } from "node:fs/promises"
import { INITIAL_KNOWLEDGE_CONFIDENCE, KnowledgeValidationDraftSchema, KnowledgeValidationSchema, KNOWLEDGE_CONFIDENCE_INCREMENT, validateKnowledgeExperiment, type KnowledgeValidationDraft } from "./knowledge-confidence"
import type { ExperimentFact } from "../experience"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { Database } from "bun:sqlite"
import { KnowledgeCandidateSchema, KnowledgeCardV2Schema, type KnowledgeCardV2 } from "./knowledge-v2-contract"
import { finalizeKnowledgeCandidate, type KnowledgeSourceContext } from "./knowledge-v2-validator"

/** Separate tables preserve legacy audit records without admitting v1 fragments. */
export class KnowledgeV2Store {
  private readonly db: Database
  constructor(private readonly databasePath: string) {
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true })
    this.db = new Database(databasePath, { create: true, strict: true })
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS kb_principle (
        knowledge_id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, active INTEGER NOT NULL,
        card_json TEXT NOT NULL, context_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kb_principle_validation (
        knowledge_id TEXT NOT NULL, task_id TEXT NOT NULL, run_id TEXT NOT NULL, validation_json TEXT NOT NULL,
        PRIMARY KEY(knowledge_id, task_id, run_id)
      );
      CREATE TABLE IF NOT EXISTS kb_principle_revision (
        knowledge_id TEXT NOT NULL, revision INTEGER NOT NULL, card_json TEXT NOT NULL,
        reason TEXT NOT NULL, PRIMARY KEY(knowledge_id, revision)
      );`)
  }
  close() { this.db.close() }
  private checked(card: unknown, context: KnowledgeSourceContext) {
    const parsed = KnowledgeCardV2Schema.parse(card)
    const { knowledgeID, revision, review, provenance, schemaVersion, confidence, experimentValidations, ...fields } = parsed
    const validated = finalizeKnowledgeCandidate({ candidate: KnowledgeCandidateSchema.parse({ ...fields, schemaVersion: "knowledge_candidate_v2" }),
      review, context, provenance, availableSourceIDs: review.reviewedSourceIDs })
    if (validated.knowledgeID !== knowledgeID) throw new Error("Knowledge v2 identity mismatch")
    return parsed
  }
  listCards(): KnowledgeCardV2[] {
    return (this.db.query("SELECT card_json,context_json FROM kb_principle WHERE active=1 ORDER BY knowledge_id").all() as
      Array<{ card_json: string; context_json: string }>).map((row) => this.checked(JSON.parse(row.card_json), JSON.parse(row.context_json)))
  }
  getCard(id: string): KnowledgeCardV2 | undefined {
    const row = this.db.query("SELECT card_json,context_json FROM kb_principle WHERE knowledge_id=? AND active=1").get(id) as
      { card_json: string; context_json: string } | null
    return row ? this.checked(JSON.parse(row.card_json), JSON.parse(row.context_json)) : undefined
  }
  /** A complete re-extraction replaces a paper's active set; partial runs only add verified principles. */
  publish(cards: readonly KnowledgeCardV2[], context: KnowledgeSourceContext, complete: boolean) {
    const checked = cards.map((card) => this.checked(card, context))
    if (new Set(checked.map((card) => card.knowledgeID)).size !== checked.length) throw new Error("Duplicate knowledge identity")
    this.db.exec("BEGIN IMMEDIATE")
    try {
      if (complete) this.db.query("UPDATE kb_principle SET active=0 WHERE paper_id=?").run(context.paperID)
      const saved = checked.map((card) => {
        const row = this.db.query("SELECT card_json FROM kb_principle WHERE knowledge_id=?").get(card.knowledgeID) as { card_json: string } | null
        const previous = row ? KnowledgeCardV2Schema.parse(JSON.parse(row.card_json)) : undefined
        const next = { ...card, confidence: previous?.confidence ?? INITIAL_KNOWLEDGE_CONFIDENCE,
          experimentValidations: previous?.experimentValidations ?? [], revision: previous ? previous.revision + 1 : 1 }
        this.db.query(`INSERT INTO kb_principle VALUES(?,?,1,?,?) ON CONFLICT(knowledge_id) DO UPDATE SET
          active=1,card_json=excluded.card_json,context_json=excluded.context_json`)
          .run(card.knowledgeID, card.paperID, JSON.stringify(next), JSON.stringify(context))
        this.db.query("INSERT INTO kb_principle_revision VALUES(?,?,?,?)")
          .run(card.knowledgeID, next.revision, JSON.stringify(next), "source-reviewed extraction")
        return next
      })
      this.db.exec("COMMIT")
      return saved
    } catch (error) { this.db.exec("ROLLBACK"); throw error }
  }
  /** One source card + one actual experiment can raise confidence only once, across retries and revised wording. */
  confirmExperiment(taskID: string, input: KnowledgeValidationDraft, facts: ExperimentFact[]) {
    const draft = KnowledgeValidationDraftSchema.parse(input)
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const card = this.getCard(draft.cardID)
      if (!card) throw new Error("Knowledge card is unavailable or retired")
      const cited = this.db.query("SELECT card_json FROM kb_principle_revision WHERE knowledge_id=? AND revision=?")
        .get(draft.cardID, draft.cardRevision) as { card_json: string } | null
      if (!cited || KnowledgeCardV2Schema.parse(JSON.parse(cited.card_json)).review.candidateHash !== card.review.candidateHash) throw new Error("Unknown or incompatible cited revision")
      validateKnowledgeExperiment(card, draft, taskID, facts)
      const existing = this.db.query("SELECT validation_json FROM kb_principle_validation WHERE knowledge_id=? AND task_id=? AND run_id=?")
        .get(card.knowledgeID, taskID, draft.runID) as { validation_json: string } | null
      if (existing) {
        this.db.exec("COMMIT")
        return { updated: false, card, validation: KnowledgeValidationSchema.parse(JSON.parse(existing.validation_json)) }
      }
      const confidence = Math.min(1, Number((card.confidence + KNOWLEDGE_CONFIDENCE_INCREMENT).toFixed(8)))
      const validation = KnowledgeValidationSchema.parse({ ...draft, taskID, actor: "ReflectionAgent", facts,
        validationID: `kv_${createHash("sha256").update(JSON.stringify([card.knowledgeID, taskID, draft.runID])).digest("hex").slice(0, 24)}`,
        createdAt: new Date().toISOString(), previousConfidence: card.confidence, confidence,
        increment: Number((confidence - card.confidence).toFixed(8)) })
      const next = KnowledgeCardV2Schema.parse({ ...card, confidence, revision: card.revision + 1,
        experimentValidations: [...card.experimentValidations, validation] })
      this.db.query("INSERT INTO kb_principle_validation VALUES(?,?,?,?)").run(card.knowledgeID, taskID, draft.runID, JSON.stringify(validation))
      this.db.query("UPDATE kb_principle SET card_json=? WHERE knowledge_id=?").run(JSON.stringify(next), card.knowledgeID)
      this.db.query("INSERT INTO kb_principle_revision VALUES(?,?,?,?)").run(card.knowledgeID, next.revision, JSON.stringify(next), `ReflectionAgent: ${validation.validationID}`)
      this.db.exec("COMMIT")
      return { updated: true, card: next, validation }
    } catch (error) { this.db.exec("ROLLBACK"); throw error }
  }

  async exportCards() {
    const file = path.join(path.dirname(this.databasePath), "exports", "knowledge_cards_v2.jsonl")
    await mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${crypto.randomUUID()}.tmp`
    await writeFile(temporary, this.listCards().map((card) => JSON.stringify(card)).join("\n") + "\n")
    await rename(temporary, file)
  }

  retire(id: string) { this.db.query("UPDATE kb_principle SET active=0 WHERE knowledge_id=?").run(id) }
}
