import { and, desc, eq, Database } from "@/storage"
import { Bus } from "@/bus"
import { SessionTable } from "@/session/session.sql"
import { readFile } from "fs/promises"
import { ResearchArtifactTable, ResearchHypothesisTable, ResearchTaskTable } from "./research.sql"
import { ResearchHypothesisID, type JsonRecord, type ResearchTaskID, type ResearchArtifactID } from "./schema"
import { Event } from "./event"
import type { HypothesisObject, HypothesisStatus } from "./agents/hypo-planner-agent"
import { TaskEvidenceBundleSchema, type TaskEvidenceBundle } from "./retrieve/contract"

const VALID_STATUSES: readonly HypothesisStatus[] = [
  "pending",
  "active",
  "testing",
  "confirmed",
  "rejected",
  "abandoned",
]

export class HypothesisNotFoundError extends Error {
  constructor(hypoID: string) {
    super(`Hypothesis ${hypoID} was not found in this task's pool`)
  }
}

type ResearchHypothesisRow = typeof ResearchHypothesisTable.$inferSelect

function mapRow(row: ResearchHypothesisRow): HypothesisObject {
  const status = VALID_STATUSES.includes(row.status as HypothesisStatus) ? (row.status as HypothesisStatus) : "pending"
  return {
    id: row.hypo_id,
    statement: row.statement,
    motivation: Array.isArray(row.motivation) ? (row.motivation as string[]) : [],
    expectedOutcome: row.expected_outcome,
    suggestedBackbones: Array.isArray(row.suggested_backbones) ? (row.suggested_backbones as string[]) : [],
    suggestedPreprocessing: Array.isArray(row.suggested_preprocessing) ? (row.suggested_preprocessing as string[]) : [],
    priority: row.priority === "high" || row.priority === "medium" || row.priority === "low" ? row.priority : "medium",
    risk: row.risk,
    testable: row.testable,
    datasetEvidencePaths: Array.isArray(row.dataset_evidence_paths) ? row.dataset_evidence_paths : [],
    literatureEvidence: Array.isArray(row.literature_evidence) ? row.literature_evidence : [],
    applicabilityAssumptions: Array.isArray(row.applicability_assumptions) ? row.applicability_assumptions : [],
    falsificationCriteria: Array.isArray(row.falsification_criteria) ? row.falsification_criteria : [],
    evidenceLevel: row.evidence_level === "paper_supported" || row.evidence_level === "conflicted" ? row.evidence_level : "data_only",
    status,
    ...(row.abandon_reason ? { abandonReason: row.abandon_reason } : {}),
  }
}

type HypothesisEvidenceFields = Pick<
  HypothesisObject,
  "datasetEvidencePaths" | "literatureEvidence" | "applicabilityAssumptions" | "falsificationCriteria" | "evidenceLevel"
>

type HypothesisDraft = Omit<
  HypothesisObject,
  "id" | "status" | "abandonReason" | keyof HypothesisEvidenceFields
> & Partial<HypothesisEvidenceFields> & { id?: string }

function normalizedEvidence(hypothesis: Partial<HypothesisEvidenceFields>): HypothesisEvidenceFields {
  return {
    datasetEvidencePaths: hypothesis.datasetEvidencePaths ?? [],
    literatureEvidence: hypothesis.literatureEvidence ?? [],
    applicabilityAssumptions: hypothesis.applicabilityAssumptions ?? [],
    falsificationCriteria: hypothesis.falsificationCriteria ?? [],
    evidenceLevel: hypothesis.evidenceLevel ?? "data_only",
  }
}

function publishChanged(taskID: ResearchTaskID, action: "add" | "update" | "abandon", hypothesis: HypothesisObject) {
  void Bus.publish(Event.HypoPlannerAgentHypothesisChanged, {
    taskID,
    action,
    hypoID: hypothesis.id,
    snapshot: hypothesis as unknown as JsonRecord,
  }).catch(() => undefined)
}

/**
 * Resolves the research taskID that owns a given opencode session. HypoPlanner runs in a
 * fresh child session per turn (see requestViaSession), so the direct research_task.session_id
 * match only covers the root session — falls back to the session's parent.
 */
export async function resolveTaskIDBySessionID(sessionID: string): Promise<ResearchTaskID | undefined> {
  const direct = Database.use((d) =>
    d.select({ id: ResearchTaskTable.id }).from(ResearchTaskTable).where(eq(ResearchTaskTable.session_id, sessionID as any)).get(),
  )
  if (direct) return direct.id

  const session = Database.use((d) =>
    d.select({ parentID: SessionTable.parent_id }).from(SessionTable).where(eq(SessionTable.id, sessionID as any)).get(),
  )
  if (!session?.parentID) return undefined

  const viaParent = Database.use((d) =>
    d
      .select({ id: ResearchTaskTable.id })
      .from(ResearchTaskTable)
      .where(eq(ResearchTaskTable.session_id, session.parentID as any))
      .get(),
  )
  return viaParent?.id
}

export async function listHypothesesInPool(
  taskID: ResearchTaskID,
  opts?: { includeAbandoned?: boolean; status?: readonly HypothesisStatus[] },
): Promise<HypothesisObject[]> {
  const rows = Database.use((d) =>
    d.select().from(ResearchHypothesisTable).where(eq(ResearchHypothesisTable.task_id, taskID)).orderBy(ResearchHypothesisTable.time_created).all(),
  )
  return rows
    .map(mapRow)
    .filter((h) => {
      if (opts?.status && opts.status.length > 0) return opts.status.includes(h.status ?? "pending")
      if (!opts?.includeAbandoned) return h.status !== "abandoned"
      return true
    })
}

export async function addHypothesisToPool(
  taskID: ResearchTaskID,
  hypothesis: HypothesisDraft,
): Promise<HypothesisObject> {
  const now = Date.now()
  const id = ResearchHypothesisID.ascending()
  const hypoID = hypothesis.id?.trim() || id
  const evidence = normalizedEvidence(hypothesis)
  Database.use((d) =>
    d
      .insert(ResearchHypothesisTable)
      .values({
        id,
        task_id: taskID,
        hypo_id: hypoID,
        statement: hypothesis.statement,
        motivation: [...hypothesis.motivation],
        expected_outcome: hypothesis.expectedOutcome,
        suggested_backbones: [...hypothesis.suggestedBackbones],
        suggested_preprocessing: [...hypothesis.suggestedPreprocessing],
        priority: hypothesis.priority,
        risk: hypothesis.risk,
        testable: hypothesis.testable,
        dataset_evidence_paths: [...evidence.datasetEvidencePaths],
        literature_evidence: [...evidence.literatureEvidence],
        applicability_assumptions: [...evidence.applicabilityAssumptions],
        falsification_criteria: [...evidence.falsificationCriteria],
        evidence_level: evidence.evidenceLevel,
        status: "pending",
        time_created: now,
        time_updated: now,
      })
      .run(),
  )
  const created: HypothesisObject = { ...hypothesis, ...evidence, id: hypoID, status: "pending" }
  publishChanged(taskID, "add", created)
  return created
}

export async function updateHypothesisInPool(
  taskID: ResearchTaskID,
  hypoID: string,
  patch: Partial<Omit<HypothesisObject, "id">>,
): Promise<HypothesisObject> {
  const existingRow = Database.use((d) =>
    d
      .select()
      .from(ResearchHypothesisTable)
      .where(and(eq(ResearchHypothesisTable.task_id, taskID), eq(ResearchHypothesisTable.hypo_id, hypoID)))
      .get(),
  )
  if (!existingRow) throw new HypothesisNotFoundError(hypoID)

  const status = patch.status && VALID_STATUSES.includes(patch.status) ? patch.status : undefined
  Database.use((d) =>
    d
      .update(ResearchHypothesisTable)
      .set({
        ...(patch.statement !== undefined ? { statement: patch.statement } : {}),
        ...(patch.motivation !== undefined ? { motivation: [...patch.motivation] } : {}),
        ...(patch.expectedOutcome !== undefined ? { expected_outcome: patch.expectedOutcome } : {}),
        ...(patch.suggestedBackbones !== undefined ? { suggested_backbones: [...patch.suggestedBackbones] } : {}),
        ...(patch.suggestedPreprocessing !== undefined
          ? { suggested_preprocessing: [...patch.suggestedPreprocessing] }
          : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.risk !== undefined ? { risk: patch.risk } : {}),
        ...(patch.testable !== undefined ? { testable: patch.testable } : {}),
        ...(patch.datasetEvidencePaths !== undefined ? { dataset_evidence_paths: [...patch.datasetEvidencePaths] } : {}),
        ...(patch.literatureEvidence !== undefined ? { literature_evidence: [...patch.literatureEvidence] } : {}),
        ...(patch.applicabilityAssumptions !== undefined ? { applicability_assumptions: [...patch.applicabilityAssumptions] } : {}),
        ...(patch.falsificationCriteria !== undefined ? { falsification_criteria: [...patch.falsificationCriteria] } : {}),
        ...(patch.evidenceLevel !== undefined ? { evidence_level: patch.evidenceLevel } : {}),
        ...(status !== undefined ? { status } : {}),
        time_updated: Date.now(),
      })
      .where(and(eq(ResearchHypothesisTable.task_id, taskID), eq(ResearchHypothesisTable.hypo_id, hypoID)))
      .run(),
  )
  const updatedRow = Database.use((d) =>
    d
      .select()
      .from(ResearchHypothesisTable)
      .where(and(eq(ResearchHypothesisTable.task_id, taskID), eq(ResearchHypothesisTable.hypo_id, hypoID)))
      .get(),
  )
  const updated = mapRow(updatedRow!)
  publishChanged(taskID, "update", updated)
  return updated
}

const sessionEvidence = new Map<string, { taskID: ResearchTaskID; artifactID?: ResearchArtifactID }>()

export function bindTaskEvidenceToSession(sessionID: string, taskID: ResearchTaskID, artifactID?: ResearchArtifactID) {
  sessionEvidence.set(sessionID, { taskID, artifactID })
  return () => { sessionEvidence.delete(sessionID) }
}

export async function loadTaskEvidenceForSession(taskID: ResearchTaskID, sessionID: string) {
  const binding = sessionEvidence.get(sessionID)
  if (!binding) return loadTaskEvidenceForTask(taskID)
  if (binding.taskID !== taskID) throw new Error("Task evidence session ownership mismatch")
  if (!binding.artifactID) return undefined
  return loadTaskEvidenceForTask(taskID, binding.artifactID)
}

export async function loadTaskEvidenceForTask(taskID: ResearchTaskID, artifactID?: ResearchArtifactID): Promise<TaskEvidenceBundle | undefined> {
  const artifact = Database.use((d) =>
    d
      .select({ id: ResearchArtifactTable.id, uri: ResearchArtifactTable.uri, metadata: ResearchArtifactTable.metadata })
      .from(ResearchArtifactTable)
      .where(and(
        eq(ResearchArtifactTable.task_id, taskID),
        eq(ResearchArtifactTable.kind, "task_evidence_bundle_json"),
        ...(artifactID ? [eq(ResearchArtifactTable.id, artifactID)] : []),
      ))
      .orderBy(desc(ResearchArtifactTable.time_updated))
      .get(),
  )
  if (!artifact) {
    if (artifactID) throw new Error(`Task evidence artifact was not found: ${artifactID}`)
    return undefined
  }
  if (!artifact.uri.startsWith("file://")) throw new Error(`Task evidence artifact must use a file URI: ${artifact.uri}`)
  const bundle = TaskEvidenceBundleSchema.parse(JSON.parse(await readFile(artifact.uri.slice("file://".length), "utf8")))
  if (bundle.taskID !== taskID || artifact.metadata.retrieveRunID !== bundle.retrieveRunID) {
    throw new Error(`Task evidence provenance mismatch for artifact ${artifact.id}`)
  }
  const quantitative = Database.use((d) => d.select({ id: ResearchArtifactTable.id }).from(ResearchArtifactTable).where(and(
    eq(ResearchArtifactTable.id, bundle.quantitativeReportArtifactID as ResearchArtifactID),
    eq(ResearchArtifactTable.task_id, taskID),
    eq(ResearchArtifactTable.kind, "dataset_quantitative_analysis_json"),
  )).get())
  if (!quantitative) throw new Error(`Task evidence quantitative artifact mismatch for ${artifact.id}`)
  return bundle
}

export async function abandonHypothesisInPool(
  taskID: ResearchTaskID,
  hypoID: string,
  reason: string,
): Promise<HypothesisObject> {
  const existingRow = Database.use((d) =>
    d
      .select()
      .from(ResearchHypothesisTable)
      .where(and(eq(ResearchHypothesisTable.task_id, taskID), eq(ResearchHypothesisTable.hypo_id, hypoID)))
      .get(),
  )
  if (!existingRow) throw new HypothesisNotFoundError(hypoID)

  const now = Date.now()
  Database.use((d) =>
    d
      .update(ResearchHypothesisTable)
      .set({ status: "abandoned", abandon_reason: reason, abandoned_at: now, time_updated: now })
      .where(and(eq(ResearchHypothesisTable.task_id, taskID), eq(ResearchHypothesisTable.hypo_id, hypoID)))
      .run(),
  )
  const abandoned: HypothesisObject = { ...mapRow(existingRow), status: "abandoned", abandonReason: reason }
  publishChanged(taskID, "abandon", abandoned)
  return abandoned
}
