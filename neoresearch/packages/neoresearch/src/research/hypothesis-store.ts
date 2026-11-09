import { ExperimentConstraints, conflictingMechanismRequirements } from "./experiment-constraints"
import { timedAsync, startTiming } from "@/util/runtime-timing"
import { and, desc, eq, Database } from "@/storage"
import { Bus } from "@/bus"
import { SessionTable } from "@/session/session.sql"
import { readFile } from "fs/promises"
import { isDeepStrictEqual } from "node:util"
import { ResearchArtifactTable, ResearchCandidateTable, ResearchHypothesisTable, ResearchRunTable, ResearchTaskTable } from "./research.sql"
import { ResearchHypothesisID, type JsonRecord, type ResearchTaskID, type ResearchArtifactID } from "./schema"
import { Event } from "./event"
import { isOpenHypothesis, type NextExperimentDecision } from "./agents/hypo-planner-agent"
import { validMechanisms, unsupportedMechanisms } from "./model-capabilities"
import type { HypothesisObject, HypothesisStatus } from "./agents/hypo-planner-agent"
import { TaskEvidenceBundleSchema, type TaskEvidenceBundle } from "./retrieve/contract"
import { isZeroResearch } from "./research-variant"
import { comparisonRecipe } from "./comparison-run"
import { experimentContractUnavailable, frequencyModeUnavailable } from "./design-feedback"
import { TSFDomain } from "./domains/tsf"
import type { ResearchTask } from "./schema"

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
    ...(row.experiment_contract ? { experimentContract: ExperimentConstraints.parse(row.experiment_contract) } : {}),
    requiredMechanisms: validMechanisms(row.required_mechanisms) ? row.required_mechanisms : [],
    risk: row.risk,
    testable: row.testable,
    datasetEvidencePaths: Array.isArray(row.dataset_evidence_paths) ? row.dataset_evidence_paths : [],
    literatureEvidence: Array.isArray(row.literature_evidence) ? row.literature_evidence : [],
    applicabilityAssumptions: Array.isArray(row.applicability_assumptions) ? row.applicability_assumptions : [],
    falsificationCriteria: Array.isArray(row.falsification_criteria) ? row.falsification_criteria : [],
    evidenceLevel:
      row.evidence_level === "paper_supported" || row.evidence_level === "conflicted"
        ? row.evidence_level
        : "data_only",
    status,
    ...(row.abandon_reason ? { abandonReason: row.abandon_reason } : {}),
  }
}

type HypothesisEvidenceFields = Pick<
  HypothesisObject,
  "datasetEvidencePaths" | "literatureEvidence" | "applicabilityAssumptions" | "falsificationCriteria" | "evidenceLevel"
>

type HypothesisDraft = Omit<HypothesisObject, "id" | "status" | "abandonReason" | keyof HypothesisEvidenceFields> &
  Partial<HypothesisEvidenceFields> & { id?: string }

function normalizedEvidence(hypothesis: Partial<HypothesisEvidenceFields>): HypothesisEvidenceFields {
  return {
    datasetEvidencePaths: hypothesis.datasetEvidencePaths ?? [],
    literatureEvidence: hypothesis.literatureEvidence ?? [],
    applicabilityAssumptions: hypothesis.applicabilityAssumptions ?? [],
    falsificationCriteria: hypothesis.falsificationCriteria ?? [],
    evidenceLevel: hypothesis.evidenceLevel ?? "data_only",
  }
}

function assertConsistentMechanisms(hypothesis: Pick<HypothesisObject, "requiredMechanisms" | "experimentContract">) {
  const conflicts = conflictingMechanismRequirements(hypothesis)
  if (conflicts.length) throw new Error(
    `The candidate arm cannot both require and forbid mechanisms: ${conflicts.join(", ")}. requiredMechanisms describes the generated arm, not the treatment in its comparison.`,
  )
}

function assertVariantContract(taskID: ResearchTaskID, hypothesis: Pick<HypothesisObject, "experimentContract">) {
  const row = Database.use((d) => d.select({ taskSpec: ResearchTaskTable.task_spec })
    .from(ResearchTaskTable).where(eq(ResearchTaskTable.id, taskID)).get())
  if (row && isZeroResearch(row.taskSpec) && (!hypothesis.experimentContract || hypothesis.experimentContract.mode === "baseline"))
    throw new Error("NeoResearch-zero hypotheses require exploratory or controlled experiment contracts")
}

const executionFields = ["experimentContract", "requiredMechanisms", "suggestedBackbones", "suggestedPreprocessing"] as const

function executionDefinition(hypothesis: Partial<HypothesisObject>) {
  return {
    experimentContract: hypothesis.experimentContract ? ExperimentConstraints.parse(hypothesis.experimentContract) : null,
    requiredMechanisms: hypothesis.requiredMechanisms ?? [],
    suggestedBackbones: hypothesis.suggestedBackbones ?? [],
    suggestedPreprocessing: hypothesis.suggestedPreprocessing ?? [],
  }
}

function assertPreservesVerifiedExperiment(taskID: ResearchTaskID, hypoID: string, hypothesis: HypothesisObject) {
  const runs = Database.use((d) => d
    .select({ id: ResearchRunTable.id, usage: ResearchRunTable.resource_usage })
    .from(ResearchRunTable)
    .innerJoin(ResearchCandidateTable, eq(ResearchRunTable.candidate_id, ResearchCandidateTable.id))
    .where(and(
      eq(ResearchRunTable.task_id, taskID),
      eq(ResearchCandidateTable.task_id, taskID),
      eq(ResearchCandidateTable.hypothesis_id, hypoID),
      eq(ResearchRunTable.stage, "full"),
      eq(ResearchRunTable.status, "succeeded"),
    )).all())
  for (const run of runs) {
    const proof = run.usage.executionContract as { status?: string } | undefined
    const snapshot = run.usage.hypothesisSnapshot as unknown as HypothesisObject | undefined
    if (proof?.status !== "verified" || snapshot?.id !== hypoID) continue
    if (isDeepStrictEqual(executionDefinition(hypothesis), executionDefinition(snapshot))) continue
    throw new Error(`Hypothesis ${hypoID} has a verified full run (${run.id}); preserve its execution definition and add a new hypothesis for the next experiment.`)
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
 * Resolves the research taskID that owns a given neoresearch session. HypoPlanner runs in a
 * fresh child session per turn (see requestViaSession), so the direct research_task.session_id
 * match only covers the root session — falls back to the session's parent.
 */
export async function resolveTaskIDBySessionID(sessionID: string): Promise<ResearchTaskID | undefined> {
  const direct = Database.use((d) =>
    d
      .select({ id: ResearchTaskTable.id })
      .from(ResearchTaskTable)
      .where(eq(ResearchTaskTable.session_id, sessionID as any))
      .get(),
  )
  if (direct) return direct.id

  const session = Database.use((d) =>
    d
      .select({ parentID: SessionTable.parent_id })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID as any))
      .get(),
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
    d
      .select()
      .from(ResearchHypothesisTable)
      .where(eq(ResearchHypothesisTable.task_id, taskID))
      .orderBy(ResearchHypothesisTable.time_created)
      .all(),
  )
  return rows.map(mapRow).filter((h) => {
    if (opts?.status && opts.status.length > 0) return opts.status.includes(h.status ?? "pending")
    if (!opts?.includeAbandoned) return h.status !== "abandoned"
    return true
  })
}

export async function addHypothesisToPool(
  taskID: ResearchTaskID,
  hypothesis: HypothesisDraft,
): Promise<HypothesisObject> {
  const experimentContract = hypothesis.experimentContract ? ExperimentConstraints.parse(hypothesis.experimentContract) : undefined
  assertVariantContract(taskID, hypothesis)
  assertConsistentMechanisms(hypothesis)
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
        priority: "medium",
        experiment_contract: experimentContract ?? null,
        required_mechanisms: [...(hypothesis.requiredMechanisms ?? [])],
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
  const { priority, ...definition } = hypothesis
  const created: HypothesisObject = {
    ...definition,
    ...(experimentContract ? { experimentContract } : {}),
    ...evidence,
    requiredMechanisms: [...(hypothesis.requiredMechanisms ?? [])],
    id: hypoID,
    status: "pending",
  }
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
  assertVariantContract(taskID, { ...mapRow(existingRow), ...patch })

  // Compare with executed evidence, not the mutable row, so legacy corruption can be restored.
  if (executionFields.some((field) => patch[field] !== undefined))
    assertPreservesVerifiedExperiment(taskID, hypoID, { ...mapRow(existingRow), ...patch })
  if (patch.requiredMechanisms !== undefined || patch.experimentContract !== undefined)
    assertConsistentMechanisms({ ...mapRow(existingRow), ...patch })
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
        ...(patch.experimentContract !== undefined ? { experiment_contract: ExperimentConstraints.parse(patch.experimentContract) } : {}),
        ...(patch.requiredMechanisms !== undefined ? { required_mechanisms: [...patch.requiredMechanisms] } : {}),
        ...(patch.risk !== undefined ? { risk: patch.risk } : {}),
        ...(patch.testable !== undefined ? { testable: patch.testable } : {}),
        ...(patch.datasetEvidencePaths !== undefined
          ? { dataset_evidence_paths: [...patch.datasetEvidencePaths] }
          : {}),
        ...(patch.literatureEvidence !== undefined ? { literature_evidence: [...patch.literatureEvidence] } : {}),
        ...(patch.applicabilityAssumptions !== undefined
          ? { applicability_assumptions: [...patch.applicabilityAssumptions] }
          : {}),
        ...(patch.falsificationCriteria !== undefined
          ? { falsification_criteria: [...patch.falsificationCriteria] }
          : {}),
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
  return () => {
    sessionEvidence.delete(sessionID)
  }
}

export async function loadTaskEvidenceForSession(taskID: ResearchTaskID, sessionID: string) {
  const binding = sessionEvidence.get(sessionID)
  if (!binding) return loadTaskEvidenceForTask(taskID)
  if (binding.taskID !== taskID) throw new Error("Task evidence session ownership mismatch")
  if (!binding.artifactID) return undefined
  return loadTaskEvidenceForTask(taskID, binding.artifactID)
}

export async function loadTaskEvidenceForTask(
  taskID: ResearchTaskID,
  artifactID?: ResearchArtifactID,
): Promise<TaskEvidenceBundle | undefined> {
  const artifact = Database.use((d) =>
    d
      .select({
        id: ResearchArtifactTable.id,
        uri: ResearchArtifactTable.uri,
        metadata: ResearchArtifactTable.metadata,
      })
      .from(ResearchArtifactTable)
      .where(
        and(
          eq(ResearchArtifactTable.task_id, taskID),
          eq(ResearchArtifactTable.kind, "task_evidence_bundle_json"),
          ...(artifactID ? [eq(ResearchArtifactTable.id, artifactID)] : []),
        ),
      )
      .orderBy(desc(ResearchArtifactTable.time_updated))
      .get(),
  )
  if (!artifact) {
    if (artifactID) throw new Error(`Task evidence artifact was not found: ${artifactID}`)
    return undefined
  }
  if (!artifact.uri.startsWith("file://"))
    throw new Error(`Task evidence artifact must use a file URI: ${artifact.uri}`)
  const content = await timedAsync("hypothesis.evidence.read", { taskID, artifactID: artifact.id }, () =>
    readFile(artifact.uri.slice("file://".length), "utf8"),
  )
  const finish = startTiming("hypothesis.evidence.parse", { taskID, artifactID: artifact.id })
  const bundle = (() => {
    try {
      const value = TaskEvidenceBundleSchema.parse(JSON.parse(content))
      if (value.schemaVersion !== "task_evidence_bundle_v2") throw new Error("Legacy task evidence requires source-based v2 retrieval before planning")
      finish("completed")
      return value
    } catch (error) {
      finish("failed")
      throw error
    }
  })()
  if (bundle.taskID !== taskID || artifact.metadata.retrieveRunID !== bundle.retrieveRunID) {
    throw new Error(`Task evidence provenance mismatch for artifact ${artifact.id}`)
  }
  const quantitative = Database.use((d) =>
    d
      .select({ id: ResearchArtifactTable.id })
      .from(ResearchArtifactTable)
      .where(
        and(
          eq(ResearchArtifactTable.id, bundle.quantitativeReportArtifactID as ResearchArtifactID),
          eq(ResearchArtifactTable.task_id, taskID),
          eq(ResearchArtifactTable.kind, "dataset_quantitative_analysis_json"),
        ),
      )
      .get(),
  )
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

// Validate a declared controlled target before committing a planner decision.
export function assertHypothesisExperimentFeasible(
  task: Pick<ResearchTask, "id" | "domainID" | "taskSpec">,
  hypothesis: Pick<HypothesisObject, "id" | "experimentContract">,
) {
  if (task.domainID !== "tsf" || hypothesis.experimentContract?.mode !== "controlled") return
  const input = { hypothesisID: hypothesis.id, contract: hypothesis.experimentContract,
    comparison: comparisonRecipe(task.id, hypothesis.experimentContract.comparisonRunID) }
  const conflict = frequencyModeUnavailable(input) ?? experimentContractUnavailable({ ...input,
    validate: candidateSpec => TSFDomain.validateCandidate({ taskSpec: task.taskSpec, candidateSpec }),
  })
  if (conflict) throw new Error(JSON.stringify({ code: "experiment_contract_preflight", ...conflict }))
}

// Selection is task metadata so it survives service restarts and is visible in
// task artifacts. No hypothesis is promoted implicitly by add/update operations.
export async function selectNextExperimentInPool(taskID: ResearchTaskID, decision: NextExperimentDecision) {
  if (decision.action === "experiment") {
    const hypothesis = (await listHypothesesInPool(taskID)).find((h) => h.id === decision.hypothesisID)
    if (!hypothesis || !isOpenHypothesis(hypothesis))
      throw new Error(`Hypothesis ${decision.hypothesisID} is not open and testable`)
    assertVariantContract(taskID, hypothesis)
    assertConsistentMechanisms(hypothesis)
    const unsupported = unsupportedMechanisms(hypothesis.requiredMechanisms ?? [])
    if (unsupported.length)
      throw new Error(
        `Unsupported mechanisms remain untested: ${unsupported.join(", ")}. Select an executable hypothesis.`,
      )
    const task = Database.use(d => d.select({ id: ResearchTaskTable.id, domainID: ResearchTaskTable.domain_id, taskSpec: ResearchTaskTable.task_spec })
      .from(ResearchTaskTable).where(eq(ResearchTaskTable.id, taskID)).get())
    if (!task) throw new Error(`Research task ${taskID} was not found`)
    assertHypothesisExperimentFeasible(task, hypothesis)
  }
  Database.use((d) =>
    d.transaction((tx) => {
      const task = tx.select().from(ResearchTaskTable).where(eq(ResearchTaskTable.id, taskID)).get()
      if (!task) throw new Error(`Research task ${taskID} was not found`)
      const metadata = task.task_spec.metadata as JsonRecord | undefined
      tx.update(ResearchTaskTable)
        .set({
          task_spec: {
            ...task.task_spec,
            metadata: { ...metadata, nextExperiment: decision as unknown as JsonRecord },
          },
          time_updated: Date.now(),
        })
        .where(eq(ResearchTaskTable.id, taskID))
        .run()
    }),
  )
  return decision
}
