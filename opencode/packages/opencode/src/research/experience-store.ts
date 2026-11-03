import { ExperiencePurpose, experiencePurpose, inferExperiencePurpose, validateExperiencePurpose, readerPurpose, type ExperienceReader } from "./experience-purpose"
import { verifyExperienceBinding, type ExperienceWriteBinding } from "./experience-binding"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { Database, and, desc, eq } from "@/storage"
import { Instance } from "@/project/instance"
import { Bus } from "@/bus"
import { Event } from "./event"
import { ExperimentConstraints } from "./experiment-constraints"
import { DomainRegistry } from "./domain-registry"
import { digest } from "./execution-contract"
import { taskExecutionRoot } from "./task-isolation"
import { ExperienceLibrary, experienceLibraryPath, recallableExperience } from "./experience-library"
import { ResearchCandidateTable, ResearchMemoryTable, ResearchRunTable, ResearchTaskTable } from "./research.sql"
import { experienceRepresentation } from "./experience-representation"
import { parseExperienceQuery, type ExperienceQueryIntent } from "./experience-query"
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

/** Adopt existing project experiences without promoting legacy summaries or weakening evidence gates. */
export function migrateProjectExperiences(library?: ExperienceLibrary) {
  const store = library ?? new ExperienceLibrary(experienceLibraryPath(Instance.directory))
  try {
    const rows = Database.use((db) => db.select({ memory: ResearchMemoryTable })
      .from(ResearchMemoryTable).innerJoin(ResearchTaskTable, eq(ResearchMemoryTable.task_id, ResearchTaskTable.id))
      .where(eq(ResearchTaskTable.project_id, Instance.project.id)).all())
    let migrated = 0
    for (const { memory: row } of rows) {
      const memory = mapMemory(row)
      if (!recallableExperience(memory) || typeof memory.candidateSummary.experienceKey !== "string") continue
      if (store.save(memory, { projectID: Instance.project.id, projectRoot: Instance.directory }).created) migrated++
    }
    return { migrated, databasePath: store.databasePath }
  } finally { if (!library) store.close() }
}

const datasetHashes = new Map<string, { signature: string; hash: string }>()

/** Bind future observations to the implementation present at run creation. Old snapshots stay unknown. */
async function runtimeContext() {
  const root = path.join(Instance.directory, "neo_cast", "py")
  const files = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])
  const sources = await Promise.all(files.filter(file => file.isFile() && file.name.endsWith(".py") &&
    !file.parentPath.split(path.sep).some(part => ["tests", "__pycache__", ".venv"].includes(part)))
    .map(async file => {
      const source = path.join(file.parentPath, file.name)
      return { path: path.relative(root, source), sha256: createHash("sha256").update(await readFile(source)).digest("hex") }
    }))
  return sources.length ? { status: "source_snapshot", pythonSourceDigest: digest(sources.sort((a, b) => a.path.localeCompare(b.path))),
    sourceFiles: sources.length, capturedAt: Date.now() } : { status: "runtime_provenance_unavailable" }
}

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
    runtimeContext: await runtimeContext(),
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
      ...(usage.trainingTrial ? { trainingTrial: record(usage.trainingTrial) } : {}),
      ...(hasSnapshot && snapshot.runtimeContext ? { runtimeContext: record(snapshot.runtimeContext) } : {}),
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
export async function prepareExperience(taskID: ResearchTaskID, input: ExperienceDraft, binding?: ExperienceWriteBinding, options?: { libraryPath?: string }) {
  const task = taskInProject(taskID)
  const draft = ExperienceDraftSchema.parse(input)
  const origin = binding ? await verifyExperienceBinding(taskID, binding) : undefined
  const evidence = [...draft.evidence]
  const inheritedFacts = new Map<string, ExperimentFact>()
  const library = new ExperienceLibrary(options?.libraryPath ?? experienceLibraryPath(Instance.directory))
  try {
    migrateProjectExperiences(library)
    for (const parentID of draft.derivedFrom ?? []) {
      const parentMemory = library.list({ experienceID: parentID, domainID: task.domain_id })[0]
      if (!parentMemory) throw new Error(`Unknown parent experience in this domain: ${parentID}`)
      const parent = experienceFromMemory(parentMemory)
      if (!parent)
        throw new Error("Parent must be a structured experience in the same domain")
      for (const fact of parent.facts) {
        const previous = inheritedFacts.get(fact.runID)
        if (previous && digest(previous) !== digest(fact)) throw new Error(`Conflicting inherited experiment fact: ${fact.runID}`)
        inheritedFacts.set(fact.runID, fact)
      }
      // Inherited counterevidence remains visible when a claim is refined or promoted.
      // Structured continuations accumulate prior evidence in the organization view. Do not copy
      // old relations into the new local observation: a refutation can itself be a valid result.
      if (draft.evolution) continue
      for (const ref of parent.draft.evidence) {
        const existing = evidence.find((item) => item.runID === ref.runID)
        if (existing && (existing.relation !== ref.relation || existing.comparisonRunID !== ref.comparisonRunID)) {
          throw new Error("Inherited evidence cannot be relabeled; describe the changed scope in boundaries")
        }
        if (!existing) evidence.push(ref)
      }
    }
    let normalized = ExperienceDraftSchema.parse({ ...draft, evidence })
    const runIDs = [...new Set(evidence.flatMap((ref) => [ref.runID, ...(ref.comparisonRunID ? [ref.comparisonRunID] : [])]))]
    // Foreign facts may only be inherited from a named validated parent, never supplied by an agent.
    const captured = await captureFacts(task, runIDs.filter((id) => !inheritedFacts.has(id) || inheritedFacts.get(id)!.taskID === taskID))
    const byID = new Map([...inheritedFacts, ...captured.map((fact) => [fact.runID, fact] as const)])
    const facts = runIDs.map((id) => byID.get(id)!)
    if (!evidence.some((ref) => captured.some((fact) => fact.runID === ref.runID && fact.taskID === taskID))) {
      throw new Error("Reflection must cite an experiment from its current task")
    }
    if (!captured.some(fact => fact.taskID === taskID && fact.independentEvidence &&
      evidence.some(ref => ref.runID === fact.runID) && (fact.error || fact.executionVerified &&
        (fact.primaryValue !== undefined || fact.stage === "smoke")))) {
      throw new Error("Experience requires a new independent observation; cached/duplicate attempts or metricless full runs cannot add a new lesson")
    }
    const purpose = origin?.purpose ?? inferExperiencePurpose(normalized, facts)
    if (!purpose) throw new Error("Memory purpose is ambiguous; use a committed scoped reflection rather than guessing from prose")
    validateExperiencePurpose(purpose, normalized, facts, origin)
    if (origin && draft.evidence.some(ref => [ref.runID, ...(ref.comparisonRunID ? [ref.comparisonRunID] : [])]
      .some(id => !origin.sourceRunIDs.includes(id) && (!inheritedFacts.has(id) || inheritedFacts.get(id)!.taskID === taskID))))
      throw new Error("Experience cites runs outside the committed reflection evidence")
    for (const id of [...(draft.derivedFrom ?? []), ...(draft.evolution?.parentExperienceID ? [draft.evolution.parentExperienceID] : [])]) {
      const memory = library.list({ experienceID: id, domainID: task.domain_id })[0]
      const parent = memory && experienceFromMemory(memory)
      if (!parent || (experiencePurpose(parent) && experiencePurpose(parent) !== purpose) ||
        !experiencePurpose(parent) && draft.evolution?.parentExperienceID === id) throw new Error("Experience provenance cannot cross memory purposes")
    }
    const supportDatasetCount = validateExperienceEvidence(normalized, facts)
    if (normalized.claimType === "observation") {
      normalized = { ...normalized, polarity: "inconclusive" }
    }
    if (normalized.claimType !== "performance") {
      const representation = experienceRepresentation({ schemaVersion: "research_experience.v1", draft: normalized,
        facts, supportDatasetCount, capturedAt: Date.now() })
      const changes = representation.interventions.filter(change => change.status === "verified_changes")
      const { mechanismHypothesis, ...grounded } = normalized
      normalized = { ...grounded, statement: representation.summary.slice(0, 4000), observation: representation.summary.slice(0, 4000),
        intervention: changes.length ? JSON.stringify(changes.map(change => ({ runID: change.runID, changes: change.changes }))).slice(0, 4000)
          : "Observed configuration or execution attempt; no verified controlled intervention is established." }
    }
    if (normalized.claimType === "performance") {
      const contrasts = normalized.evidence.map((ref) => {
        const trial = facts.find((fact) => fact.runID === ref.runID)!
        const control = facts.find((fact) => fact.runID === ref.comparisonRunID)!
        const changes = ExperimentConstraints.parse(trial.trainingTrial?.contract ?? trial.hypothesisSnapshot?.experimentContract).changes
        return { ref, trial, control, changes, improved: trial.direction === "minimize" ? trial.primaryValue! < control.primaryValue! : trial.primaryValue! > control.primaryValue! }
      })
      const observation = contrasts.map(({ trial, control, changes }) => `${trial.runID} vs ${control.runID}: ${JSON.stringify(changes)}; ${trial.primaryMetric} ${control.primaryValue} -> ${trial.primaryValue} (${trial.direction}).`).join(" ")
      const support = contrasts.filter(({ ref }) => ref.relation === "supports")
      const polarity = support.every(x => x.trial.primaryValue === x.control.primaryValue) ? "inconclusive"
        : support.every((x) => x.improved) ? "positive"
        : support.every((x) => !x.improved && x.trial.primaryValue !== x.control.primaryValue) ? "negative" : "mixed"
      const { mechanismHypothesis, ...grounded } = normalized
      normalized = { ...grounded, statement: observation, observation, polarity,
        intervention: JSON.stringify(contrasts.map(({ trial, changes }) => ({ runID: trial.runID, changes }))) }
    }
    const experienceKey = digest({ purpose, draft: normalized, facts })
    const now = Date.now()
    const experience = ResearchExperienceSchema.parse({
      schemaVersion: "research_experience.v1",
      purpose, origin,
      draft: normalized,
      facts,
      supportDatasetCount,
      capturedAt: now,
      canonicalEvidenceVersion: 1,
      unverifiedInterpretation: draft,
    })
    const outcome = normalized.polarity === "positive" ? "accepted" : normalized.polarity === "inconclusive" ? "failed" : "rejected"
    const memory: ResearchMemory = {
      id: ResearchMemoryID.ascending(), taskID, domainID: task.domain_id,
      fingerprintSummary: facts.find((fact) => fact.taskID === taskID)!.taskFingerprint as JsonRecord,
      candidateSummary: { role: "experience", experienceKey, experienceLegacyKey: digest({ draft: normalized, facts }), experience } as unknown as JsonRecord,
      outcome, lesson: normalized.statement, time: { created: now, updated: now },
    }
    return { memory, source: { projectID: task.project_id, projectRoot: Instance.directory }, libraryPath: library.databasePath }
  } finally { library.close() }
}

export async function writeExperience(taskID: ResearchTaskID, input: ExperienceDraft, binding?: ExperienceWriteBinding) {
  const prepared = await prepareExperience(taskID, input, binding)
  const library = new ExperienceLibrary(prepared.libraryPath)
  try {
    const result = library.save(prepared.memory, prepared.source)
    if (result.created) await Bus.publish(Event.MemoryCreated, { memory: result.memory })
    return result
  } finally { library.close() }
}

export interface ReadExperiencesOptions {
  experienceID?: string
  threadID?: string
  includeArchived?: boolean
  includeOriginal?: boolean
  includeHistory?: boolean
  scope?: "task" | "project" | "shared"
  purpose?: ExperiencePurpose
  includeUnknown?: boolean
  level?: ExperienceDraft["level"]
  polarity?: ExperienceDraft["polarity"]
  query?: string
  includeBackground?: boolean
  intent?: ExperienceQueryIntent
  limit?: number
}

/** Only structured, explicitly saved experiences are transferred between tasks. */
export function readExperiences(taskID: ResearchTaskID, options: ReadExperiencesOptions = {}): ResearchMemory[] {
  const task = taskInProject(taskID)
  const library = new ExperienceLibrary(experienceLibraryPath(Instance.directory))
  try {
    migrateProjectExperiences(library)
    return library.list({ ...options, domainID: task.domain_id,
      projectID: options.scope === "task" || options.scope === "project" ? task.project_id : undefined,
      taskID: options.scope === "task" ? taskID : undefined,
      limit: options.limit ?? 20,
    })
  } finally { library.close() }
}

export function experiencePurposeForReader(reader: ExperienceReader, options: ReadExperiencesOptions = {}) {
  const executionQuestion = options.intent === "execution_error" || options.query && parseExperienceQuery(options.query).intent === "execution_error"
  return executionQuestion && ["model_designer", "hypoplanner"].includes(reader) ? "optimization" as const : readerPurpose(reader)
}

export function readExperiencesForRole(taskID: ResearchTaskID, reader: ExperienceReader, options: ReadExperiencesOptions = {}) {
  return readExperiences(taskID, { ...options, purpose: experiencePurposeForReader(reader, options),
    includeUnknown: Boolean(options.experienceID && options.includeUnknown) })
}

/** Preserve task-memory APIs and exports while new experiences live directly in the shared library. */
export function taskMemories(taskID: ResearchTaskID, legacy?: ResearchMemory[]) {
  const task = taskInProject(taskID)
  const rows = legacy ?? Database.use((db) => db.select().from(ResearchMemoryTable)
    .where(eq(ResearchMemoryTable.task_id, taskID)).orderBy(desc(ResearchMemoryTable.time_updated)).all()).map(mapMemory)
  const library = new ExperienceLibrary(experienceLibraryPath(Instance.directory))
  try {
    migrateProjectExperiences(library)
    const shared = library.list({ projectID: task.project_id, taskID })
    // Structured local copies must not resurrect entries archived by global curation.
    return [...new Map([...rows.filter(memory => !experienceFromMemory(memory)), ...shared].map((memory) => [memory.id, memory])).values()]
      .sort((a, b) => b.time.updated - a.time.updated)
  } finally { library.close() }
}
