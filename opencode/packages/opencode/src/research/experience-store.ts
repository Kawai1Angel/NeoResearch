import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { Database, and, desc, eq, inArray, sql } from "@/storage"
import { Instance } from "@/project/instance"
import { Bus } from "@/bus"
import { Event } from "./event"
import { ExperimentConstraints } from "./experiment-constraints"
import { DomainRegistry } from "./domain-registry"
import { digest } from "./execution-contract"
import { taskExecutionRoot } from "./task-isolation"
import { ResearchCandidateTable, ResearchMemoryTable, ResearchRunTable, ResearchTaskTable } from "./research.sql"
import {
  ResearchMemory,
  ResearchMemoryID,
  type ResearchRunID,
  type ResearchTaskID,
  type JsonRecord,
  type ResearchTask,
} from "./schema"
import {
  ExperienceDraftSchema,
  ResearchExperienceSchema,
  experienceFromMemory,
  validateExperienceEvidence,
  type ExperienceDraft,
  type ExperimentFact,
} from "./experience"

type TaskRow = typeof ResearchTaskTable.$inferSelect
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

function taskInProject(taskID: ResearchTaskID) {
  const task = Database.use((db) =>
    db
      .select()
      .from(ResearchTaskTable)
      .where(and(eq(ResearchTaskTable.id, taskID), eq(ResearchTaskTable.project_id, Instance.project.id)))
      .get(),
  )
  if (!task) throw new Error("Research task does not belong to the current project")
  return task
}

function mapMemory(row: typeof ResearchMemoryTable.$inferSelect): ResearchMemory {
  return Schema.decodeUnknownSync(ResearchMemory)({
    id: row.id,
    taskID: row.task_id,
    domainID: row.domain_id,
    fingerprintSummary: row.fingerprint_summary,
    candidateSummary: row.candidate_summary,
    outcome: row.outcome,
    lesson: row.lesson,
    time: { created: row.time_created, updated: row.time_updated },
  })
}

const datasetHashes = new Map<string, { signature: string; hash: string }>()

async function datasetSnapshot(specification: Record<string, unknown>): Promise<ExperimentFact["dataset"]> {
  if (typeof specification.path === "string") {
    const source = path.resolve(Instance.directory, specification.path)
    try {
      const before = await stat(source)
      const signature = `${before.size}:${before.mtimeMs}:${before.ctimeMs}`
      const cached = datasetHashes.get(source)
      if (cached?.signature === signature)
        return { identity: `sha256:${cached.hash}`, contentHash: cached.hash, specification }
      const hash = createHash("sha256")
      for await (const chunk of createReadStream(source)) hash.update(chunk)
      const after = await stat(source)
      if (`${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== signature)
        throw new Error("Dataset changed while hashing")
      const contentHash = hash.digest("hex")
      if (datasetHashes.size >= 128) datasetHashes.clear()
      datasetHashes.set(source, { signature, hash: contentHash })
      return { identity: `sha256:${contentHash}`, contentHash, specification }
    } catch {
      return { identity: `unverified_path:${source}`, specification }
    }
  }
  return { identity: `unverified_dataset:${digest(specification)}`, specification }
}

/** Capture the data and evaluation identity when the run is created, before later task/file edits. */
export async function captureExperienceContext(task: Pick<ResearchTask, "id" | "domainID" | "taskSpec" | "objective">) {
  const primaryMetric = typeof task.objective.primaryMetric === "string" ? task.objective.primaryMetric : "val_avg_mse"
  return {
    schemaVersion: "experiment_context.v1",
    dataset: await datasetSnapshot(record(task.taskSpec.dataset)),
    taskFingerprint: DomainRegistry.summarizeTask(task.domainID, task.taskSpec, {
      taskID: task.id,
      projectRoot: Instance.directory,
      workspaceRoot: taskExecutionRoot(task, Instance.directory),
    }),
    evaluation: {
      ...record(task.taskSpec.evaluation),
      contextLength: task.taskSpec.contextLength,
      predictionLengths: task.taskSpec.predictionLengths,
      split: record(task.taskSpec.dataset).split,
    },
    primaryMetric,
    direction: task.objective.direction === "maximize" ? "maximize" : "minimize",
    capturedAt: Date.now(),
  }
}

async function captureFacts(task: TaskRow, runIDs: readonly string[]) {
  const fingerprints = new Map<string, JsonRecord>()
  const facts: ExperimentFact[] = []
  for (const id of [...new Set(runIDs)]) {
    const run = Database.use((db) =>
      db
        .select()
        .from(ResearchRunTable)
        .where(eq(ResearchRunTable.id, id as ResearchRunID))
        .get(),
    )
    if (!run) throw new Error(`Unknown experiment run: ${id}`)
    const owner = taskInProject(run.task_id)
    if (owner.domain_id !== task.domain_id)
      throw new Error("Experience evidence must belong to the same research domain")
    if (!["succeeded", "failed", "rejected", "invalid"].includes(run.status))
      throw new Error(`Run is not finished: ${id}`)
    if (["ref_test", "blind_test"].includes(run.stage))
      throw new Error("Held-out test results cannot enter search experience")
    const candidate = run.candidate_id
      ? Database.use((db) =>
          db
            .select()
            .from(ResearchCandidateTable)
            .where(and(eq(ResearchCandidateTable.id, run.candidate_id!), eq(ResearchCandidateTable.task_id, owner.id)))
            .get(),
        )
      : undefined
    const usage = record(run.resource_usage)
    const snapshot = record(usage.experienceContext)
    const hasSnapshot = snapshot.schemaVersion === "experiment_context.v1"
    if (!hasSnapshot && !fingerprints.has(owner.id))
      fingerprints.set(
        owner.id,
        DomainRegistry.summarizeTask(owner.domain_id, owner.task_spec, {
          taskID: owner.id,
          projectRoot: Instance.directory,
          workspaceRoot: taskExecutionRoot({ id: owner.id, taskSpec: owner.task_spec }, Instance.directory),
        }),
      )
    const execution = record(usage.executionContract)
    const actual = record(record(execution.manifest).actual)
    const primaryMetric =
      hasSnapshot && typeof snapshot.primaryMetric === "string"
        ? snapshot.primaryMetric
        : typeof owner.objective.primaryMetric === "string"
          ? owner.objective.primaryMetric
          : "val_avg_mse"
    const value = run.metrics[primaryMetric]
    facts.push({
      taskID: owner.id,
      runID: run.id,
      ...(run.candidate_id ? { candidateID: run.candidate_id } : {}),
      stage: run.stage,
      status: run.status,
      dataset: hasSnapshot
        ? (snapshot.dataset as ExperimentFact["dataset"])
        : {
            identity: `unverified_legacy:${digest(record(owner.task_spec.dataset))}`,
            specification: record(owner.task_spec.dataset),
          },
      taskFingerprint: hasSnapshot ? record(snapshot.taskFingerprint) : fingerprints.get(owner.id)!,
      evaluation: hasSnapshot
        ? record(snapshot.evaluation)
        : {
            ...record(owner.task_spec.evaluation),
            contextLength: owner.task_spec.contextLength,
            predictionLengths: owner.task_spec.predictionLengths,
            split: record(owner.task_spec.dataset).split,
          },
      ...(candidate ? { proposedModel: candidate.candidate_spec } : {}),
      ...(usage.hypothesisSnapshot ? { hypothesisSnapshot: record(usage.hypothesisSnapshot) } : {}),
      ...(Object.keys(actual).length ? { executedModel: actual } : {}),
      executionVerified: execution.status === "verified" && Object.keys(actual).length > 0,
      independentEvidence: usage.duplicateExperiment !== true && usage.independentEvidence !== false,
      metrics: run.metrics,
      primaryMetric,
      ...((usage.evaluationDecision || usage.verification) ? { evaluationDecision: { ...record(usage.evaluationDecision), verificationStatus: record(usage.verification).status ?? "insufficient_evidence" } } : {}),
      ...(typeof value === "number" && Number.isFinite(value) ? { primaryValue: value } : {}),
      direction:
        (hasSnapshot ? snapshot.direction : owner.objective.direction) === "maximize" ? "maximize" : "minimize",
      ...(run.error ? { error: run.error } : {}),
      artifactIDs: run.artifact_refs,
      ...(run.time_finished == null ? {} : { timeFinished: run.time_finished }),
    })
  }
  return facts
}

/** Read-only authoritative snapshots shared with literature validation; never accept metrics from an agent. */
export async function captureExperimentFacts(taskID: ResearchTaskID, runIDs: readonly string[]) {
  return captureFacts(taskInProject(taskID), runIDs)
}

/** Explicit, optional write shared by the Reflection tool and direct-transport fallback. */
export async function writeExperience(taskID: ResearchTaskID, input: ExperienceDraft) {
  const task = taskInProject(taskID)
  const draft = ExperienceDraftSchema.parse(input)
  const evidence = [...draft.evidence]
  for (const parentID of draft.derivedFrom ?? []) {
    const parentRow = Database.use((db) =>
      db
        .select()
        .from(ResearchMemoryTable)
        .where(eq(ResearchMemoryTable.id, parentID as ResearchMemoryID))
        .get(),
    )
    if (!parentRow) throw new Error(`Unknown parent experience: ${parentID}`)
    const owner = taskInProject(parentRow.task_id)
    const parent = experienceFromMemory(mapMemory(parentRow))
    if (owner.domain_id !== task.domain_id || !parent)
      throw new Error("Parent must be a structured experience in the same domain")
    // Inherited counterevidence remains visible when a claim is refined or promoted.
    for (const ref of parent.draft.evidence) {
      const existing = evidence.find((item) => item.runID === ref.runID)
      if (existing && (existing.relation !== ref.relation || existing.comparisonRunID !== ref.comparisonRunID)) {
        throw new Error("Inherited evidence cannot be relabeled; describe the changed scope in boundaries")
      }
      if (!existing) evidence.push(ref)
    }
  }
  let normalized = ExperienceDraftSchema.parse({ ...draft, evidence })
  const facts = await captureFacts(
    task,
    evidence.flatMap((ref) => [ref.runID, ...(ref.comparisonRunID ? [ref.comparisonRunID] : [])]),
  )
  if (!evidence.some((ref) => facts.some((fact) => fact.runID === ref.runID && fact.taskID === taskID))) {
    throw new Error("Reflection must cite an experiment from its current task")
  }
  const supportDatasetCount = validateExperienceEvidence(normalized, facts)
  if (normalized.level === "experiment_fact" && normalized.claimType === "observation") {
    const observations = facts.map((fact) => `${fact.runID}: ${fact.stage}/${fact.status}; ${fact.primaryMetric}=${fact.primaryValue ?? "unavailable"}; executionVerified=${fact.executionVerified}; independentEvidence=${fact.independentEvidence}`).join("; ")
    normalized = { ...normalized, statement: observations, observation: observations, intervention: "See captured proposedModel and executedModel; no causal effect is established by an observation alone.", polarity: "inconclusive" }
  }
  if (normalized.claimType === "performance") {
    const contrasts = normalized.evidence.map((ref) => {
      const trial = facts.find((fact) => fact.runID === ref.runID)!
      const control = facts.find((fact) => fact.runID === ref.comparisonRunID)!
      const changes = ExperimentConstraints.parse(trial.hypothesisSnapshot!.experimentContract).changes
      return { ref, trial, control, changes, improved: trial.direction === "minimize" ? trial.primaryValue! < control.primaryValue! : trial.primaryValue! > control.primaryValue! }
    })
    const observation = contrasts.map(({ trial, control, changes }) => `${trial.runID} vs ${control.runID}: ${JSON.stringify(changes)}; ${trial.primaryMetric} ${control.primaryValue} -> ${trial.primaryValue} (${trial.direction}).`).join(" ")
    const support = contrasts.filter(({ ref }) => ref.relation === "supports")
    const polarity = support.every((x) => x.improved) ? "positive" : support.every((x) => !x.improved) ? "negative" : "mixed"
    const { mechanismHypothesis, ...grounded } = normalized
    normalized = { ...grounded, statement: observation, observation, polarity,
      intervention: JSON.stringify(contrasts.map(({ trial, changes }) => ({ runID: trial.runID, changes }))) }
  }
  const experienceKey = digest({ draft: normalized, facts })
  const now = Date.now()
  const experience = ResearchExperienceSchema.parse({
    schemaVersion: "research_experience.v1",
    draft: normalized,
    facts,
    supportDatasetCount,
    capturedAt: now,
    canonicalEvidenceVersion: 1,
    unverifiedInterpretation: draft,
  })
  const outcome = normalized.polarity === "positive" ? "accepted" : normalized.polarity === "inconclusive" ? "failed" : "rejected"
  const result = Database.transaction((db) => {
    const existing = db
      .select()
      .from(ResearchMemoryTable)
      .where(
        and(
          eq(ResearchMemoryTable.task_id, taskID),
          sql`json_extract(${ResearchMemoryTable.candidate_summary}, '$.experienceKey') = ${experienceKey}`,
        ),
      )
      .get()
    if (existing) return { memory: mapMemory(existing), created: false }
    const row = db
      .insert(ResearchMemoryTable)
      .values({
        id: ResearchMemoryID.ascending(),
        task_id: taskID,
        domain_id: task.domain_id,
        fingerprint_summary: facts.find((fact) => fact.taskID === taskID)!.taskFingerprint as JsonRecord,
        candidate_summary: { role: "experience", experienceKey, experience } as unknown as JsonRecord,
        outcome,
        lesson: normalized.statement,
        time_created: now,
        time_updated: now,
      })
      .returning()
      .get()
    return { memory: mapMemory(row), created: true }
  })
  if (result.created) await Bus.publish(Event.MemoryCreated, { memory: result.memory })
  return result
}

export interface ReadExperiencesOptions {
  scope?: "task" | "project"
  level?: ExperienceDraft["level"]
  polarity?: ExperienceDraft["polarity"]
  query?: string
  limit?: number
}

/** Only structured, explicitly saved experiences are transferred between tasks. */
export function readExperiences(taskID: ResearchTaskID, options: ReadExperiencesOptions = {}): ResearchMemory[] {
  const task = taskInProject(taskID)
  const tasks = Database.use((db) =>
    db
      .select({ id: ResearchTaskTable.id })
      .from(ResearchTaskTable)
      .where(and(eq(ResearchTaskTable.project_id, task.project_id), eq(ResearchTaskTable.domain_id, task.domain_id)))
      .all(),
  )
  const taskIDs = options.scope === "task" ? [taskID] : tasks.map((row) => row.id)
  const rows = Database.use((db) =>
    db
      .select()
      .from(ResearchMemoryTable)
      .where(
        and(
          inArray(ResearchMemoryTable.task_id, taskIDs),
          eq(ResearchMemoryTable.domain_id, task.domain_id),
          sql`json_extract(${ResearchMemoryTable.candidate_summary}, '$.experience.schemaVersion') = 'research_experience.v1'`,
        ),
      )
      .orderBy(desc(ResearchMemoryTable.time_updated))
      .all(),
  )
  const query = options.query?.trim().toLowerCase()
  return rows
    .map(mapMemory)
    .filter((memory) => {
      const experience = experienceFromMemory(memory)
      if (experience) {
        if (experience.draft.claimType === "performance" && experience.canonicalEvidenceVersion !== 1) return false
        try { validateExperienceEvidence(experience.draft, experience.facts) } catch { return false }
      }
      return (
        experience &&
        (!options.level || experience.draft.level === options.level) &&
        (!options.polarity || experience.draft.polarity === options.polarity) &&
        (!query || JSON.stringify(experience.draft).toLowerCase().includes(query))
      )
    })
    .slice(0, Math.max(1, Math.min(100, options.limit ?? 20)))
}
