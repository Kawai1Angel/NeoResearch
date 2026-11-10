import path from "node:path"
import { neoCastStateDirectory } from "../runners/neo-cast-install"
import { existsSync } from "node:fs"
import { Database, and, desc, eq } from "@/storage"
import { Instance } from "@/project/instance"
import { ResearchTaskTable, ResearchRunTable } from "../research.sql"
import { mapTask } from "../task-mapper"
import type { ResearchTaskID } from "../schema"
import { loadTaskEvidenceForTask, loadTaskEvidenceForSession } from "../hypothesis-store"
import { citableTaskEvidence } from "../retrieve/evidence-handoff"
import { projectPlanningTaskEvidence } from "../retrieve/planning-evidence"
import { reflectionRunSelection } from "../reflection-context"
import { captureExperimentFacts } from "../experience-store"
import { KnowledgeV2Store } from "./knowledge-v2-store"
import { KnowledgeValidationDraftSchema, type KnowledgeValidationDraft } from "./knowledge-confidence"

const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}
function taskContext(taskID: ResearchTaskID) {
  const task = Database.use((db) => db.select().from(ResearchTaskTable)
    .where(and(eq(ResearchTaskTable.id, taskID), eq(ResearchTaskTable.project_id, Instance.project.id))).get())
  if (!task) throw new Error("Knowledge feedback task does not belong to this project")
  const runtime = record(mapTask(task, Instance.directory).taskSpec.runtime)
  const root = typeof runtime.neoCastProjectRoot === "string" && runtime.neoCastProjectRoot.trim()
    ? path.resolve(runtime.neoCastProjectRoot)
    : [path.resolve(Instance.directory), path.resolve(Instance.directory, "neo_cast")]
      .find((candidate) => existsSync(path.join(candidate, "literature_knowledge"))) ?? path.resolve(Instance.directory, "neo_cast")
  return { task, databasePath: path.join(neoCastStateDirectory(root), "literature-knowledge", "knowledge.db") }
}

/** Frozen source cards plus live feedback. Historical task artifacts are never rewritten. */
export async function readReflectionKnowledge(taskID: ResearchTaskID, sessionID?: string) {
  const { databasePath } = taskContext(taskID)
  const bundle = sessionID ? await loadTaskEvidenceForSession(taskID, sessionID) : await loadTaskEvidenceForTask(taskID)
  const selection = reflectionRunSelection(taskID)
  if (!bundle) return { available: false, entries: [], currentRunID: selection.currentRunID, experimentFacts: [] }
  const experimentFacts = (await Promise.all(selection.runIDs.map(async (runID) => {
    try { return await captureExperimentFacts(taskID, [runID]) } catch { return [] }
  }))).flat()
  const store = existsSync(databasePath) ? new KnowledgeV2Store(databasePath) : undefined
  try {
    const entries = citableTaskEvidence(bundle).flatMap((entry) => {
      if (!entry.knowledge) return []
      const live = store?.getCard(entry.cardID)
      const current = live && live.review.candidateHash === entry.knowledge.review.candidateHash ? live : entry.knowledge
      return [{ cardID: entry.cardID, cardRevision: entry.cardRevision, currentRevision: current.revision,
        confidence: current.confidence, feedbackAvailable: current === live,
        applicability: entry.applicability, roles: entry.roles, knowledge: current }]
    })
    const summary = projectPlanningTaskEvidence(bundle, bundle.architectureKnowledge ? selection.citations : undefined)
    return { available: entries.length > 0, currentRunID: selection.currentRunID, entries, experimentFacts, summary }
  } finally { store?.close() }
}

/** Only referenced admitted summaries reach the model; full cards stay internal. */
export function reflectionKnowledgeForPrompt(value: Awaited<ReturnType<typeof readReflectionKnowledge>>,
  cardID?: string, cardRevision?: number) {
  const selected = cardID ? value.entries.filter((entry) => entry.cardID === cardID && entry.cardRevision === cardRevision)
    : value.entries.filter((entry) => value.summary?.entries.some((item) => item.cardID === entry.cardID))
  if (cardID && !selected.length) throw new Error("Reflection card is unavailable, withheld or has a stale revision")
  const result = {
    available: selected.length > 0, currentRunID: value.currentRunID,
    architectureKnowledge: value.summary?.architectureKnowledge,
    entries: selected.map((entry) => ({ cardID: entry.cardID, cardRevision: entry.cardRevision, currentRevision: entry.currentRevision,
      confidence: entry.confidence, feedbackAvailable: entry.feedbackAvailable,
      roles: entry.roles, applicability: entry.applicability,
      assertions: entry.knowledge.assertions, conditions: entry.knowledge.conditions,
      boundaries: entry.knowledge.boundaries, epistemicStatus: entry.knowledge.epistemicStatus })),
    detailAccess: value.summary?.detailAccess,
    interpretation: "Only currently admitted cards are available. Defaults are sources referenced by the current hypothesis and complementary sources of its admitted decisions. Full quotes, review histories and historical experiments are read on demand; current/comparison run evidence comes from experiment_results. Confidence is not proof of a local gain.",
  }
  if (JSON.stringify(result, null, 2).length > 120_000) throw new Error("Reflection knowledge summary exceeds 120000 characters; read a specific admitted card")
  return result
}

/** Called only by Reflection's tool or direct-response coordinator. Agent-supplied metrics are not accepted. */
export async function confirmKnowledgeExperiment(taskID: ResearchTaskID, input: KnowledgeValidationDraft, sessionID?: string) {
  const draft = KnowledgeValidationDraftSchema.parse(input)
  const { databasePath } = taskContext(taskID)
  const bundle = sessionID ? await loadTaskEvidenceForSession(taskID, sessionID) : await loadTaskEvidenceForTask(taskID)
  const entry = bundle && citableTaskEvidence(bundle).find((item) => item.cardID === draft.cardID && item.cardRevision === draft.cardRevision)
  if (!entry?.knowledge) throw new Error("Reflection can validate only a revision supplied in current task evidence")
  if (entry.applicability.status === "conflicted") throw new Error("Conflicted task conditions cannot increase knowledge confidence")
  const latest = Database.use((db) => db.select().from(ResearchRunTable).where(eq(ResearchRunTable.task_id, taskID))
    .orderBy(desc(ResearchRunTable.time_created), desc(ResearchRunTable.id)).get())
  if (!latest || latest.id !== draft.runID) throw new Error("Knowledge feedback must refer to the current/latest experiment")
  const facts = await captureExperimentFacts(taskID, [draft.runID, ...(draft.comparisonRunID ? [draft.comparisonRunID] : [])])
  if (!existsSync(databasePath)) throw new Error("Knowledge store is unavailable")
  const store = new KnowledgeV2Store(databasePath)
  try {
    const current = store.getCard(entry.cardID)
    if (!current || current.review.candidateHash !== entry.knowledge.review.candidateHash)
      throw new Error("Knowledge store does not contain the admitted source revision")
    const result = store.confirmExperiment(taskID, draft, facts)
    await store.exportCards()
    return { updated: result.updated, cardID: result.card.knowledgeID, revision: result.card.revision,
      confidence: result.card.confidence, validation: result.validation }
  } finally { store.close() }
}
