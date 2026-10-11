import path from "node:path"
import { existsSync } from "node:fs"
import { Database, and, desc, eq } from "@/storage"
import { Instance } from "@/project/instance"
import { ResearchTaskTable, ResearchRunTable } from "../research.sql"
import type { ResearchTaskID } from "../schema"
import { loadTaskEvidenceForTask } from "../hypothesis-store"
import { captureExperimentFacts } from "../experience-store"
import { KnowledgeV2Store } from "./knowledge-v2-store"
import { KnowledgeValidationDraftSchema, type KnowledgeValidationDraft } from "./knowledge-confidence"

const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}
function taskContext(taskID: ResearchTaskID) {
  const task = Database.use((db) => db.select().from(ResearchTaskTable)
    .where(and(eq(ResearchTaskTable.id, taskID), eq(ResearchTaskTable.project_id, Instance.project.id))).get())
  if (!task) throw new Error("Knowledge feedback task does not belong to this project")
  const runtime = record(task.task_spec.runtime)
  const root = typeof runtime.neoCastProjectRoot === "string" && runtime.neoCastProjectRoot.trim()
    ? path.resolve(runtime.neoCastProjectRoot)
    : [path.resolve(Instance.directory), path.resolve(Instance.directory, "neo_cast")]
      .find((candidate) => existsSync(path.join(candidate, "literature_knowledge"))) ?? path.resolve(Instance.directory, "neo_cast")
  return { task, databasePath: path.join(root, ".neo-cast", "literature-knowledge", "knowledge.db") }
}

/** Frozen source cards plus live feedback. Historical task artifacts are never rewritten. */
export async function readReflectionKnowledge(taskID: ResearchTaskID) {
  const { databasePath } = taskContext(taskID)
  const bundle = await loadTaskEvidenceForTask(taskID)
  if (!bundle || !existsSync(databasePath)) return { available: false, entries: [] }
  const runs = Database.use((db) => db.select().from(ResearchRunTable).where(eq(ResearchRunTable.task_id, taskID))
    .orderBy(desc(ResearchRunTable.time_created), desc(ResearchRunTable.id)).limit(20).all())
  const experimentFacts = (await Promise.all(runs.map(async (run) => {
    try { return await captureExperimentFacts(taskID, [run.id]) } catch { return [] }
  }))).flat()
  const store = new KnowledgeV2Store(databasePath)
  try {
    const entries = bundle.entries.flatMap((entry) => {
      const current = store.getCard(entry.cardID)
      if (!current || !entry.knowledge || current.review.candidateHash !== entry.knowledge.review.candidateHash) return []
      return [{ cardID: entry.cardID, cardRevision: entry.cardRevision, currentRevision: current.revision,
        confidence: current.confidence, applicability: entry.applicability, roles: entry.roles, knowledge: current }]
    })
    return { available: entries.length > 0, currentRunID: runs[0]?.id, entries, experimentFacts }
  } finally { store.close() }
}

/** Called only by Reflection's tool or direct-response coordinator. Agent-supplied metrics are not accepted. */
export async function confirmKnowledgeExperiment(taskID: ResearchTaskID, input: KnowledgeValidationDraft) {
  const draft = KnowledgeValidationDraftSchema.parse(input)
  const { databasePath } = taskContext(taskID)
  const bundle = await loadTaskEvidenceForTask(taskID)
  const entry = bundle?.entries.find((item) => item.cardID === draft.cardID && item.cardRevision === draft.cardRevision)
  if (!entry?.knowledge) throw new Error("Reflection can validate only a revision supplied in current task evidence")
  if (entry.applicability.status === "conflicted") throw new Error("Conflicted task conditions cannot increase knowledge confidence")
  const latest = Database.use((db) => db.select().from(ResearchRunTable).where(eq(ResearchRunTable.task_id, taskID))
    .orderBy(desc(ResearchRunTable.time_created), desc(ResearchRunTable.id)).get())
  if (!latest || latest.id !== draft.runID) throw new Error("Knowledge feedback must refer to the current/latest experiment")
  const facts = await captureExperimentFacts(taskID, [draft.runID, ...(draft.comparisonRunID ? [draft.comparisonRunID] : [])])
  if (!existsSync(databasePath)) throw new Error("Knowledge store is unavailable")
  const store = new KnowledgeV2Store(databasePath)
  try {
    const result = store.confirmExperiment(taskID, draft, facts)
    await store.exportCards()
    return { updated: result.updated, cardID: result.card.knowledgeID, revision: result.card.revision,
      confidence: result.card.confidence, validation: result.validation }
  } finally { store.close() }
}
