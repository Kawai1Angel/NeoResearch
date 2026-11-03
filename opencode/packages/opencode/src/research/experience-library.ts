import { ExperiencePurpose, experiencePurpose, validateExperiencePurpose } from "./experience-purpose"
import path from "node:path"
import { existsSync, mkdirSync } from "node:fs"
import { isDeepStrictEqual } from "node:util"
import { Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { init } from "#db"
import { ResearchMemory, type JsonRecord } from "./schema"
import { experienceFromMemory, validateExperienceEvidence, type ExperienceDraft } from "./experience"
import { rankExperiences } from "./experience-search"
import type { ExperienceQueryIntent } from "./experience-query"
import { evolutionOf, experienceClaimKey, experienceRevisionSummary, experienceThreadRoot, organizeExperienceThread,
  type ExperienceEntry, type ExperienceOrganization } from "./experience-evolution"
import { ExperienceCurationSchema, applyExperienceCuration, experienceSourceDigest, type ExperienceCuration } from "./experience-curation"
import { experienceRepresentation } from "./experience-representation"

/** Explicit override, nearest project library/export, then the user-level shared library. */
export function experienceLibraryPath(directory = process.cwd()) {
  const configured = process.env.NEO_RESEARCH_EXPERIENCE_DB
  if (configured !== undefined) {
    if (!configured.trim() || !path.isAbsolute(configured))
      throw new Error("NEO_RESEARCH_EXPERIENCE_DB must be an absolute SQLite file path")
    return configured
  }
  let root = path.resolve(directory)
  while (true) {
    for (const relative of ["experience.db", "experience-export/experience.db"]) {
      const file = path.join(root, ".neo-research", relative)
      if (existsSync(file)) return file
    }
    const parent = path.dirname(root)
    if (parent === root || existsSync(path.join(root, ".git"))) break
    root = parent
  }
  return path.join(Global.Path.home, ".neo-research", "experience.db")
}

export type ExperienceSource = { projectID: string; projectRoot: string; writeKey?: string; writeDigest?: string }
export type ExperienceLibraryQuery = {
  experienceID?: string
  threadID?: string
  includeArchived?: boolean
  includeOriginal?: boolean
  includeHistory?: boolean
  projectID?: string
  taskID?: string
  domainID?: string
  purpose?: ExperiencePurpose
  includeUnknown?: boolean
  level?: ExperienceDraft["level"]
  polarity?: ExperienceDraft["polarity"]
  query?: string
  includeBackground?: boolean
  intent?: ExperienceQueryIntent
  limit?: number
}

export function recallableExperience(memory: ResearchMemory) {
  const experience = experienceFromMemory(memory)
  if (!experience || (experience.draft.claimType === "performance" && experience.canonicalEvidenceVersion !== 1)) return
  if (experience.facts.some((fact) => ["ref_test", "blind_test"].includes(fact.stage))) return
  try { validateExperienceEvidence(experience.draft, experience.facts) } catch { return }
  return experience
}

/** A directly queryable library of complete research_experience.v1 snapshots. No task/run foreign keys. */
export class ExperienceLibrary {
  readonly databasePath: string
  private readonly db: ReturnType<typeof init>["$client"]
  private readonly organizations = new Map<string, unknown>()

  constructor(databasePath = experienceLibraryPath()) {
    this.databasePath = databasePath
    mkdirSync(path.dirname(databasePath), { recursive: true })
    this.db = init(databasePath).$client
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS research_experience (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, project_root TEXT NOT NULL,
        task_id TEXT NOT NULL, domain_id TEXT NOT NULL, level TEXT NOT NULL, polarity TEXT NOT NULL,
        experience_key TEXT NOT NULL, memory_json TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
        UNIQUE(project_id, task_id, experience_key)
      );
      CREATE INDEX IF NOT EXISTS research_experience_domain_idx ON research_experience(domain_id, time_updated);
      CREATE INDEX IF NOT EXISTS research_experience_task_idx ON research_experience(project_id, task_id);
      CREATE TABLE IF NOT EXISTS research_experience_organization (
        experience_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, domain_id TEXT NOT NULL,
        revision INTEGER NOT NULL, organization_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS research_experience_thread (
        thread_id TEXT PRIMARY KEY, domain_id TEXT NOT NULL, revision INTEGER NOT NULL,
        organization_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS research_experience_thread_version (
        thread_id TEXT NOT NULL, revision INTEGER NOT NULL, summary_json TEXT NOT NULL,
        PRIMARY KEY(thread_id, revision)
      );
      CREATE TABLE IF NOT EXISTS research_experience_curation (
        experience_id TEXT PRIMARY KEY, status TEXT NOT NULL, canonical_experience_id TEXT,
        source_digest TEXT NOT NULL, review_json TEXT NOT NULL, time_reviewed INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS research_experience_thread_idx ON research_experience_organization(thread_id);`)
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const columns = this.db.prepare("PRAGMA table_info(research_experience)").all() as { name: string }[]
      if (!columns.some((column) => column.name === "purpose"))
        this.db.exec("ALTER TABLE research_experience ADD COLUMN purpose TEXT")
      if (!columns.some((column) => column.name === "classification_version"))
        this.db.exec("ALTER TABLE research_experience ADD COLUMN classification_version INTEGER NOT NULL DEFAULT 0")
      this.db
        .exec(`CREATE INDEX IF NOT EXISTS research_experience_purpose_idx ON research_experience(domain_id,purpose);
      CREATE TABLE IF NOT EXISTS research_experience_write_receipt (
        write_key TEXT PRIMARY KEY, request_digest TEXT NOT NULL, project_id TEXT NOT NULL,
        task_id TEXT NOT NULL, source_entry_id TEXT NOT NULL, time_created INTEGER NOT NULL
      );`)
      const pending = this.db
        .prepare("SELECT id,memory_json FROM research_experience WHERE classification_version=0")
        .all() as { id: string; memory_json: string }[]
      if (pending.length) {
        for (const row of pending) {
          let purpose: ExperiencePurpose | undefined
          try {
            const experience = experienceFromMemory(JSON.parse(row.memory_json))
            purpose = experience ? experiencePurpose(experience) : undefined
          } catch {}
          this.db
            .prepare("UPDATE research_experience SET purpose=?,classification_version=1 WHERE id=?")
            .run(purpose ?? null, row.id)
        }
        // Preserve existing canonical identities while separating purpose-aware memberships.
        // Rebuild only derived views; source JSON and historical revisions stay immutable.
        this.rebuildOrganizations()
      }
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      this.db.close()
      throw error
    }
  }

  close() { this.db.close() }

  private review(id: string) {
    const row = this.db.prepare("SELECT review_json FROM research_experience_curation WHERE experience_id=?").get(id) as { review_json: string } | null
    return row ? ExperienceCurationSchema.parse(JSON.parse(row.review_json)) : undefined
  }

  private decode(row: { memory_json: string; project_id: string; project_root: string }, includeOriginal = false) {
    const original = Schema.decodeUnknownSync(ResearchMemory)(JSON.parse(row.memory_json))
    const review = this.review(original.id)
    const memory = review ? applyExperienceCuration(original, review, row.memory_json, includeOriginal) : original
    const organization = this.db.prepare("SELECT t.thread_id,t.revision,t.organization_json FROM research_experience_organization o JOIN research_experience_thread t ON t.thread_id=o.thread_id WHERE o.experience_id=?").get(memory.id) as { thread_id: string; revision: number; organization_json: string } | null
    const key = organization ? `${organization.thread_id}:${organization.revision}:${experienceSourceDigest(organization.organization_json)}` : ""
    if (organization && !this.organizations.has(key)) this.organizations.set(key, JSON.parse(organization.organization_json))
    const experience = experienceFromMemory(memory)
    const purpose = experience ? experiencePurpose(experience) : undefined
    return { ...memory, candidateSummary: { ...memory.candidateSummary,
      experiencePurpose: purpose ?? null,
      experiencePurposeClassification: purpose ? "classified" : "unknown_from_legacy_evidence",
      experienceSource: { projectID: row.project_id, projectRoot: row.project_root },
      ...(organization ? { experienceOrganization: this.organizations.get(key) } : {}),
    } as JsonRecord }
  }

  /** A disposable materialized view: immutable source memories and their IDs are never rewritten. */
  rebuildOrganizations() {
    const rows = this.db.prepare("SELECT memory_json FROM research_experience ORDER BY time_created,id").all() as { memory_json: string }[]
    const entries = rows.flatMap(row => {
      try {
        const original = Schema.decodeUnknownSync(ResearchMemory)(JSON.parse(row.memory_json))
        const review = this.review(original.id)
        const memory = review ? applyExperienceCuration(original, review, row.memory_json) : original
        const experience = recallableExperience(memory)
        return experience ? [{ id: memory.id as string, domainID: memory.domainID, time: memory.time, experience, review, curationStatus: review?.status }] : []
      } catch { return [] }
    })
    const byID = new Map(entries.map(entry => [entry.id, entry]))
    const previous = new Map((this.db.prepare("SELECT thread_id,organization_json FROM research_experience_thread").all() as
      { thread_id: string; organization_json: string }[]).map(row => [row.thread_id, JSON.parse(row.organization_json) as ExperienceOrganization]))
    const groups = new Map<string, ExperienceEntry[]>()
    const exactClaims = new Map<string, ExperienceEntry>()
    // Preserve the existing canonical identity when an older history is imported later.
    for (const id of previous.keys()) {
      const entry = byID.get(id)
      const claim = entry && evolutionOf(entry)?.claim
      if (entry && claim && !["merged", "quarantined"].includes(entry.review?.status ?? "")) {
        const key = JSON.stringify([experiencePurpose(entry.experience) ?? null, experienceClaimKey(entry.domainID, claim)])
        if (!exactClaims.has(key)) exactClaims.set(key, entry)
      }
    }
    for (const entry of entries) {
      if (entry.review?.status === "merged") continue
      if (entry.review?.status === "quarantined") {
        groups.set(entry.id, [entry])
        continue
      }
      // Imported histories with missing parents remain complete, provisional singleton records.
      let root: ExperienceEntry = entry
      try { root = experienceThreadRoot(entry, byID) } catch { /* provenance is visible in evolution events */ }
      const claim = evolutionOf(root)?.claim
      if (claim) {
        // Only exact structured hypotheses may merge automatically; prose similarity is not identity.
        const key = JSON.stringify([experiencePurpose(root.experience) ?? null, experienceClaimKey(root.domainID, claim)])
        const existing = exactClaims.get(key)
        if (existing) root = existing
        else exactClaims.set(key, root)
      }
      groups.set(root.id, [...(groups.get(root.id) ?? []), entry])
    }
    this.db.exec("SAVEPOINT experience_organization_rebuild")
    try {
      this.db.exec("DELETE FROM research_experience_organization")
      this.db.exec("DELETE FROM research_experience_thread")
      const insert = this.db.prepare("INSERT INTO research_experience_organization VALUES(?,?,?,?,?)")
      const insertThread = this.db.prepare("INSERT INTO research_experience_thread VALUES(?,?,?,?)")
      const insertVersion = this.db.prepare("INSERT OR IGNORE INTO research_experience_thread_version VALUES(?,?,?)")
      for (const [rootID, members] of groups) {
        const root = byID.get(rootID)!
        const organization = organizeExperienceThread(root, members)
        const before = previous.get(rootID)
        if (before) {
          insertVersion.run(rootID, before.revision, JSON.stringify(experienceRevisionSummary(before)))
          const unchanged = JSON.stringify({ ...before, revision: 0 }) === JSON.stringify({ ...organization, revision: 0 })
          organization.revision = unchanged ? before.revision : Math.max(before.revision + 1, organization.revision)
        }
        const value = JSON.stringify(organization)
        insertThread.run(rootID, root.domainID, organization.revision, value)
        insertVersion.run(rootID, organization.revision, JSON.stringify(experienceRevisionSummary(organization)))
        // Store the shared evidence once; memberships retain every source experience ID.
        for (const member of members) insert.run(member.id, rootID, root.domainID, organization.revision, "{}")
      }
      for (const entry of entries.filter(entry => entry.review?.status === "merged")) {
        const target = this.db.prepare("SELECT thread_id,revision FROM research_experience_organization WHERE experience_id=?").get(entry.review!.canonicalExperienceID!) as { thread_id: string; revision: number } | null
        if (!target) throw new Error(`Merged experience has no organized canonical target: ${entry.id}`)
        insert.run(entry.id, target.thread_id, entry.domainID, target.revision, "{}")
      }
      this.db.exec("RELEASE SAVEPOINT experience_organization_rebuild")
      this.organizations.clear()
      return { entries: entries.length, threads: groups.size }
    } catch (error) {
      this.db.exec("ROLLBACK TO SAVEPOINT experience_organization_rebuild")
      this.db.exec("RELEASE SAVEPOINT experience_organization_rebuild")
      throw error
    }
  }

  /** Atomic, source-bound maintenance. No fact, metric, run reference or raw source row is overwritten. */
  curate(reviews: { experienceID: string; review: ExperienceCuration }[]) {
    const updates = new Map(reviews.map(item => [item.experienceID, ExperienceCurationSchema.parse(item.review)]))
    if (updates.size !== reviews.length) throw new Error("Duplicate experience IDs in curation batch")
    this.db.exec("BEGIN IMMEDIATE")
    try {
      for (const [id, review] of updates) {
        const row = this.db.prepare("SELECT memory_json,domain_id FROM research_experience WHERE id=?").get(id) as { memory_json: string; domain_id: string } | null
        if (!row) throw new Error(`Unknown experience to curate: ${id}`)
        const source = Schema.decodeUnknownSync(ResearchMemory)(JSON.parse(row.memory_json))
        const effective = applyExperienceCuration(source, review, row.memory_json)
        const experience = experienceFromMemory(effective)!
        validateExperienceEvidence(experience.draft, experience.facts)
        if (review.status === "merged") {
          const target = this.db.prepare("SELECT memory_json,domain_id FROM research_experience WHERE id=?").get(review.canonicalExperienceID!) as typeof row
          if (!target || review.canonicalExperienceID === id || target.domain_id !== row.domain_id)
            throw new Error("Merge target must be a different experience in the same domain")
          const targetReview = updates.get(review.canonicalExperienceID!) ?? this.review(review.canonicalExperienceID!)
          if (targetReview && ["merged", "quarantined"].includes(targetReview.status)) throw new Error("Merge target must remain active")
          const other = experienceFromMemory(Schema.decodeUnknownSync(ResearchMemory)(JSON.parse(target.memory_json)))!
          if (experiencePurpose(experience) !== experiencePurpose(other)) throw new Error("Experience merges must preserve memory purpose")
          const sortedFacts = (facts: typeof experience.facts) => [...facts].sort((a, b) => a.runID.localeCompare(b.runID))
          if (experienceRepresentation(other).evidenceKey !== experienceRepresentation(experience).evidenceKey ||
            !isDeepStrictEqual(sortedFacts(other.facts), sortedFacts(experience.facts)))
            throw new Error("Merge requires the same captured evidence set; similar prose is not sufficient")
        }
        this.db.prepare("INSERT OR REPLACE INTO research_experience_curation VALUES(?,?,?,?,?,?)").run(
          id, review.status, review.canonicalExperienceID ?? null, review.sourceDigest, JSON.stringify(review), review.reviewedAt)
      }
      this.rebuildOrganizations()
      this.db.exec("COMMIT")
      return { reviewed: updates.size }
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  private ensureOrganizations() {
    const missing = this.db.prepare("SELECT e.id FROM research_experience e LEFT JOIN research_experience_organization o ON o.experience_id=e.id LEFT JOIN research_experience_thread t ON t.thread_id=o.thread_id WHERE t.thread_id IS NULL LIMIT 1").get()
    if (missing) this.rebuildOrganizations()
  }

  /** Historical conclusions keep source-entry/run IDs for the immutable detailed evidence. */
  history(experienceID: string) {
    this.ensureOrganizations()
    const membership = this.db.prepare("SELECT thread_id FROM research_experience_organization WHERE experience_id=?").get(experienceID) as { thread_id: string } | null
    const rows = this.db.prepare("SELECT summary_json FROM research_experience_thread_version WHERE thread_id=? ORDER BY revision")
      .all(membership?.thread_id ?? experienceID) as { summary_json: string }[]
    if (rows.length) return rows.map(row => JSON.parse(row.summary_json) as ReturnType<typeof experienceRevisionSummary>)
    const current = this.db.prepare("SELECT organization_json FROM research_experience_thread WHERE thread_id=?")
      .get(membership?.thread_id ?? experienceID) as { organization_json: string } | null
    return current ? [experienceRevisionSummary(JSON.parse(current.organization_json))] : []
  }

  private writeResult(memory: ResearchMemory, created: boolean, previousRevision = 0) {
    const organization = memory.candidateSummary.experienceOrganization as unknown as ExperienceOrganization
    return { memory, created, canonicalExperienceID: organization.threadID, revision: organization.revision,
      sourceEntryID: memory.id, experienceCreated: created && previousRevision === 0, appended: created && previousRevision > 0 }
  }

  private replayWrite(memory: ResearchMemory, source: ExperienceSource) {
    if (!source.writeKey) return
    const receipt = this.db.prepare("SELECT * FROM research_experience_write_receipt WHERE write_key=?").get(source.writeKey) as
      { request_digest: string; project_id: string; task_id: string; source_entry_id: string } | null
    if (!receipt) return
    if (receipt.request_digest !== source.writeDigest || receipt.project_id !== source.projectID || receipt.task_id !== memory.taskID)
      throw new Error("Memory write idempotency key was reused with different input")
    const row = this.db.prepare("SELECT * FROM research_experience WHERE id=?").get(receipt.source_entry_id) as Parameters<ExperienceLibrary["decode"]>[0] | null
    if (!row) throw new Error("Memory write receipt lost its source entry")
    return this.writeResult(this.decode(row), false)
  }

  private recordWrite(memory: ResearchMemory, source: ExperienceSource) {
    if (source.writeKey) this.db.prepare("INSERT INTO research_experience_write_receipt VALUES(?,?,?,?,?,?)")
      .run(source.writeKey, source.writeDigest!, source.projectID, memory.taskID, memory.id, Date.now())
  }

  save(memory: ResearchMemory, source: ExperienceSource) {
    const experience = recallableExperience(memory)
    const key = memory.candidateSummary.experienceKey
    if (!experience || typeof key !== "string") throw new Error("Only validated structured experience can enter the experience library")
    const purpose = experiencePurpose(experience)
    if (experience.purpose) validateExperiencePurpose(experience.purpose, experience.draft, experience.facts, experience.origin)
    if (source.writeKey && !source.writeDigest) throw new Error("Idempotent memory writes require a request digest")
    const replay = this.replayWrite(memory, source)
    if (replay) return replay
    const parentID = evolutionOf({ id: memory.id, domainID: memory.domainID, time: memory.time, experience })?.parentExperienceID
    if (parentID) {
      if (["merged", "quarantined"].includes(this.review(parentID)?.status ?? ""))
        throw new Error("Experience continuation must use an active canonical parent")
      const row = this.db.prepare("SELECT domain_id,memory_json FROM research_experience WHERE id=?").get(parentID) as { domain_id: string; memory_json: string } | null
      if (!row || row.domain_id !== memory.domainID || parentID === memory.id || !recallableExperience(JSON.parse(row.memory_json)))
        throw new Error("Experience continuation requires an existing parent in the same domain")
      const parent = experienceFromMemory(JSON.parse(row.memory_json))!
      if (experiencePurpose(parent) !== purpose) throw new Error("Experience continuation must preserve memory purpose")
      this.ensureOrganizations()
      const organization = this.db.prepare("SELECT t.organization_json FROM research_experience_organization o JOIN research_experience_thread t ON t.thread_id=o.thread_id WHERE o.experience_id=?").get(parentID) as { organization_json: string } | null
      if (!organization || JSON.parse(organization.organization_json).conditionalExperience.status !== "explicit_hypothesis")
        throw new Error("Legacy experience needs an explicit claim in a new thread; retain its ID in derivedFrom")
    }
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const replay = this.replayWrite(memory, source)
      if (replay) { this.db.exec("COMMIT"); return replay }
      if (parentID) {
        const parentRow = this.db.prepare("SELECT memory_json FROM research_experience WHERE id=?").get(parentID) as { memory_json: string } | null
        const parent = parentRow && experienceFromMemory(JSON.parse(parentRow.memory_json))
        if (!parent || experiencePurpose(parent) !== purpose || ["merged", "quarantined"].includes(this.review(parentID)?.status ?? ""))
          throw new Error("Experience parent purpose or active state changed before commit")
      }
      let duplicate = this.db.prepare("SELECT * FROM research_experience WHERE project_id=? AND task_id=? AND experience_key=?")
        .get(source.projectID, memory.taskID, key) as Parameters<ExperienceLibrary["decode"]>[0] | null
      const legacyKey = memory.candidateSummary.experienceLegacyKey
      if (!duplicate && typeof legacyKey === "string") {
        const legacy = this.db.prepare("SELECT * FROM research_experience WHERE project_id=? AND task_id=? AND experience_key=?")
          .get(source.projectID, memory.taskID, legacyKey) as typeof duplicate
        const previous = legacy && experienceFromMemory(this.decode(legacy))
        if (legacy && previous && experiencePurpose(previous) === purpose) duplicate = legacy
      }
      if (duplicate) {
        const memory = this.decode(duplicate)
        const previous = experienceFromMemory(memory)
        if (!previous || experiencePurpose(previous) !== purpose) throw new Error("Experience key already belongs to another memory purpose")
        this.recordWrite(memory, source)
        this.db.exec("COMMIT")
        return this.writeResult(memory, false)
      }
      // IDs are globally generated; conflicting copied histories must never overwrite one another.
      const existing = this.db.prepare("SELECT id FROM research_experience WHERE id=?").get(memory.id)
      if (existing) throw new Error(`Conflicting experience ID in shared library: ${memory.id}`)
      this.db.prepare(`INSERT INTO research_experience
        (id,project_id,project_root,task_id,domain_id,level,polarity,experience_key,memory_json,time_created,time_updated,purpose,classification_version)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(memory.id, source.projectID, source.projectRoot, memory.taskID,
          memory.domainID, experience.draft.level, experience.draft.polarity, key, JSON.stringify(memory),
          memory.time.created, memory.time.updated, purpose ?? null)
      this.rebuildOrganizations()
      const result = this.decode({ memory_json: JSON.stringify(memory), project_id: source.projectID, project_root: source.projectRoot })
      const threadID = (result.candidateSummary.experienceOrganization as unknown as ExperienceOrganization).threadID
      const revisions = this.db.prepare("SELECT revision FROM research_experience_thread_version WHERE thread_id=? ORDER BY revision DESC LIMIT 2")
        .all(threadID) as { revision: number }[]
      this.recordWrite(result, source)
      this.db.exec("COMMIT")
      return this.writeResult(result, true, revisions[1]?.revision ?? 0)
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  list(options: ExperienceLibraryQuery = {}): ResearchMemory[] {
    this.ensureOrganizations()
    if (options.includeOriginal && !options.experienceID) throw new Error("Original interpretation audit requires an exact experienceID")
    if (options.includeHistory && !options.experienceID) throw new Error("Version history requires an exact experienceID")
    const includeArchived = options.includeArchived || options.includeOriginal
    if (options.experienceID && !includeArchived) {
      const review = this.review(options.experienceID)
      if (review?.status === "merged") return this.list({ ...options, experienceID: review.canonicalExperienceID })
    }
    const filters: string[] = []
    const values: string[] = []
    for (const [column, value] of [
      ["id", options.experienceID], ["project_id", options.projectID], ["task_id", options.taskID],
      ["domain_id", options.domainID],
    ]) {
      if (value === undefined) continue
      filters.push(`${column}=?`)
      values.push(value)
    }
    if (!includeArchived) filters.push("id NOT IN (SELECT experience_id FROM research_experience_curation WHERE status IN ('merged','quarantined'))")
    if (options.threadID) {
      filters.push("id IN (SELECT experience_id FROM research_experience_organization WHERE thread_id=COALESCE((SELECT thread_id FROM research_experience_organization WHERE experience_id=?),?))")
      values.push(options.threadID, options.threadID)
    }
    const rows = this.db.prepare(`SELECT * FROM research_experience${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY time_updated DESC, id DESC`).all(...values) as Parameters<ExperienceLibrary["decode"]>[0][]
    const entries = rows.flatMap((row) => {
      try {
        const decoded = this.decode(row, options.includeOriginal)
        const memory = options.includeHistory ? { ...decoded, candidateSummary: { ...decoded.candidateSummary,
          experienceHistory: this.history(decoded.id) } as unknown as JsonRecord } : decoded
        const experience = recallableExperience(memory)
        const purpose = experience ? experiencePurpose(experience) : undefined
        if (options.purpose && purpose !== options.purpose && !(options.includeUnknown && !purpose)) return []
        if (options.level && experience?.draft.level !== options.level || options.polarity && experience?.draft.polarity !== options.polarity) return []
        return experience ? [{ memory, experience }] : []
      } catch { return [] }
    })
    const memories = rankExperiences(entries, options.query, { includeBackground: options.includeBackground,
      intent: options.intent,
      deduplicate: !options.experienceID && !options.threadID && !includeArchived })
    return options.limit === undefined ? memories : memories.slice(0, Math.max(1, Math.min(100, options.limit)))
  }
}
