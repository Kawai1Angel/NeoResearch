import { Schema } from "effect"
import { createHash } from "crypto"
import { readFileSync } from "fs"
import { and, eq, isNull, like, Database } from "@/storage"
import { Bus } from "@/bus"
import { ResearchApprovalTable, ResearchTaskTable } from "./research.sql"
import { mapTask } from "./task-mapper"
import { DomainRegistry } from "./domain-registry"
import { Event } from "./event"
import { NAS_DEFAULT_MAX_ITERATIONS, NAS_DEFAULT_MAX_NO_IMPROVE } from "./defaults"
import { ResearchApproval, ResearchApprovalID, type JsonRecord, type ResearchTask, type ResearchTaskID } from "./schema"
import {
  INTENT_SLOT_IDS,
  confidenceFor,
  dialogueStrategy,
  interactionModeForTask,
  normalizeIntentSlotKeys,
  slotDefinitions,
  slotIsMissing,
  type IntentInteractionMode,
  type SlotID,
} from "./agents/intent-agent"

export { resolveTaskIDBySessionID } from "./hypothesis-store"

// Standalone module (no service.ts dependency) — same rationale as task-mapper.ts:
// service.ts itself calls into this module (intent_gathering session driving), so
// importing service.ts back here would create a cycle.
const decodeApproval = Schema.decodeUnknownSync(ResearchApproval)

type ResearchApprovalRow = typeof ResearchApprovalTable.$inferSelect

function mapApproval(row: ResearchApprovalRow) {
  return decodeApproval({
    id: row.id,
    taskID: row.task_id,
    candidateID: row.candidate_id ?? undefined,
    kind: row.kind,
    status: row.status,
    reason: row.reason,
    replyMessage: row.reply_message ?? undefined,
    time: { created: row.time_created, updated: row.time_updated },
    timeReplied: row.time_replied ?? undefined,
  })
}

export class TaskNotFoundError extends Error {
  constructor(taskID: string) {
    super(`Research task ${taskID} was not found`)
  }
}

export class TaskSpecUpdateError extends Error {
  constructor(message: string) {
    super(message)
  }
}

// Slots whose value is also consumed directly by other agents (data-analysis-agent.ts
// reads taskSpec.dataset.{path,targetCols} as actual profiling config, not just intent
// bookkeeping) — see specs/research/intent-agent-tool-refactor.md §7.3. Writes to these
// slots are mirrored into taskSpec.dataset so existing readers keep working.
const DATASET_MIRROR_FIELD: Partial<Record<SlotID, string>> = {
  data_source: "path",
  target_columns: "targetCols",
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
  if (typeof value === "string" && value.trim().length > 0) return value.split(",").map((item) => item.trim()).filter(Boolean)
  return []
}

function normalizeSplitRatios(value: unknown): [number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((item) => typeof item === "number" && Number.isFinite(item) && item > 0)
  ) {
    throw new TaskSpecUpdateError("data_split_ratios must contain three positive numbers: train, validation, test")
  }
  return [value[0], value[1], value[2]] as [number, number, number]
}

function normalizeRowRange(value: unknown, name: string): [number, number] {
  const raw = typeof value === "string" ? value.split(":").map((item) => Number(item.trim())) : value
  if (
    !Array.isArray(raw) ||
    raw.length !== 2 ||
    !raw.every((item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0) ||
    raw[1] <= raw[0]
  ) {
    throw new TaskSpecUpdateError(`${name} must be a non-empty [start, end) integer range`)
  }
  return [raw[0], raw[1]] as [number, number]
}

function normalizeSplitRowRanges(value: unknown) {
  const ranges = recordValue(value)
  const train = normalizeRowRange(ranges.train ?? ranges.trainRows ?? ranges.train_rows, "data_split_row_ranges.train")
  const validation = normalizeRowRange(
    ranges.validation ?? ranges.val ?? ranges.validationRows ?? ranges.val_rows,
    "data_split_row_ranges.validation",
  )
  const test = normalizeRowRange(
    ranges.test ?? ranges.ref_test ?? ranges.testRows ?? ranges.ref_test_rows,
    "data_split_row_ranges.test",
  )
  if (train[0] !== 0) throw new TaskSpecUpdateError("data_split_row_ranges.train must start at row 0")
  if (train[1] !== validation[0] || validation[1] !== test[0]) {
    throw new TaskSpecUpdateError("data_split_row_ranges must be contiguous and non-overlapping")
  }
  return { train, validation, test }
}

function explicitParameterLimit(value: unknown): number | undefined {
  const match = typeof value === "string" ? value.trim().match(/^([+-]?\d+(?:\.\d+)?)\s*([kmb])?(?:\s*(?:parameters?|params|参数))?$/i) : undefined
  const count = typeof value === "number" ? value : match
    ? Number(match[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[match[2]?.toLowerCase() ?? ""] ?? 1)
    : undefined
  if (count !== undefined && (!Number.isSafeInteger(count) || count <= 0)) {
    throw new TaskSpecUpdateError("parameter_budget must be a positive integer count, an explicit size such as 5M, or a textual preference")
  }
  return count
}

function parseCsvLine(line: string): string[] {
  const values: string[] = []
  let value = ""
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!
    if (char === '"' && quoted && line[index + 1] === '"') { value += '"'; index++; continue }
    if (char === '"') { quoted = !quoted; continue }
    if (char === "," && !quoted) { values.push(value.trim()); value = ""; continue }
    value += char
  }
  values.push(value.trim())
  return values
}

function resolveCovariates(task: ResearchTask, slots: Record<string, unknown>) {
  const raw = stringArray(slots.exogenous_variables).filter((value) => !/^(none|无|没有)$/i.test(value))
  const requestsAll = raw.some((value) => /^(all|全部)$/i.test(value) || value.includes("全部外生"))
  const dataset = recordValue(task.taskSpec.dataset)
  const source = typeof dataset.path === "string" ? dataset.path : typeof slots.data_source === "string" ? slots.data_source : ""
  if (!requestsAll) return { columns: raw, policy: "explicit_columns", source, fingerprint: undefined }
  if (!source) throw new TaskSpecUpdateError("Cannot resolve all exogenous variables before dataset.path is known")
  let content: string
  try {
    content = readFileSync(source, "utf8")
  } catch (error) {
    throw new TaskSpecUpdateError(`Cannot read CSV schema from ${source}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0)
  const headers = parseCsvLine(lines[0] ?? "")
  if (headers.length === 0) throw new TaskSpecUpdateError(`CSV ${source} has no header`)
  const samples = lines.slice(1, 101).map(parseCsvLine)
  const numeric = headers.filter((_, index) => samples.some((row) => row[index]?.trim().length > 0) && samples.every((row) => {
    const cell = row[index]?.trim()
    return !cell || Number.isFinite(Number(cell))
  }))
  const targets = new Set(stringArray(slots.target_columns).length > 0 ? stringArray(slots.target_columns) : stringArray(dataset.targetCols))
  const metadata = recordValue(task.taskSpec.metadata)
  const ignored = new Set(stringArray(metadata.ignoredColumns))
  const timestampCandidates = new Set([
    ...stringArray(dataset.timestampCols),
    ...stringArray(dataset.timestampCol),
    ...stringArray(dataset.timeCol),
    ...stringArray(metadata.timestampColumns),
    ...headers.filter((column) => /^(date|datetime|timestamp|time)$/i.test(column)),
  ])
  const columns = numeric.filter((column) => !targets.has(column) && !ignored.has(column) && !timestampCandidates.has(column))
  if (columns.length === 0) throw new TaskSpecUpdateError("No non-target numeric columns are available for all exogenous variables")
  const fingerprint = createHash("sha256").update(headers.join("\0")).update(content.slice(0, 1024 * 1024)).digest("hex")
  return { columns, policy: "all_non_target_numeric_columns", source, fingerprint }
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

async function loadTask(taskID: ResearchTaskID): Promise<ResearchTask> {
  const row = Database.use((d) => d.select().from(ResearchTaskTable).where(eq(ResearchTaskTable.id, taskID)).get())
  if (!row) throw new TaskNotFoundError(taskID)
  return mapTask(row)
}

export interface TaskspecSlotSnapshot {
  readonly value: unknown
  readonly missing: boolean
  readonly required: boolean
}

export interface TaskspecSlotsSnapshot {
  readonly taskID: ResearchTaskID
  readonly interactionMode: IntentInteractionMode
  readonly slots: Partial<Record<SlotID, TaskspecSlotSnapshot>>
  readonly missingRequiredSlots: SlotID[]
  readonly confidence: number
}

function snapshotFromTask(taskID: ResearchTaskID, task: ResearchTask): TaskspecSlotsSnapshot {
  const strategy = dialogueStrategy(interactionModeForTask(task))
  const defs = slotDefinitions(task)
  const slots: Partial<Record<SlotID, TaskspecSlotSnapshot>> = {}
  for (const def of defs) {
    slots[def.id] = { value: def.value, missing: slotIsMissing(def), required: def.required }
  }
  return {
    taskID,
    interactionMode: strategy.mode,
    slots,
    missingRequiredSlots: defs.filter(slotIsMissing).map((def) => def.id),
    confidence: confidenceFor(defs, strategy),
  }
}

export async function readTaskspecSlots(taskID: ResearchTaskID): Promise<TaskspecSlotsSnapshot> {
  const task = await loadTask(taskID)
  return snapshotFromTask(taskID, task)
}

function normalizeTaskSpecForDomain(task: ResearchTask, taskSpec: JsonRecord): JsonRecord {
  return DomainRegistry.createTaskSpec(task.domainID, taskSpec)
}

export async function applySlotUpdates(
  taskID: ResearchTaskID,
  updates: Record<string, unknown>,
): Promise<TaskspecSlotsSnapshot> {
  const task = await loadTask(taskID)
  const normalizedUpdates = normalizeIntentSlotKeys(updates) as Partial<Record<SlotID, unknown>>
  for (const key of Object.keys(normalizedUpdates)) {
    if (!INTENT_SLOT_IDS.includes(key as SlotID)) throw new TaskSpecUpdateError(`Unknown intent slot: ${key}`)
  }
  for (const slot of ["forecast_object", "data_source", "time_grain", "future_covariate_availability", "business_context", "primary_metric", "error_preferences", "interpretability", "deployment_target"] as const) {
    if (slot in normalizedUpdates && typeof normalizedUpdates[slot] !== "string") throw new TaskSpecUpdateError(`${slot} must be a string`)
  }
  if (
    "data_split_method" in normalizedUpdates &&
    normalizedUpdates.data_split_method !== "ratio" &&
    normalizedUpdates.data_split_method !== "row_ranges"
  ) {
    throw new TaskSpecUpdateError("data_split_method must be ratio or row_ranges")
  }
  if ("data_split_ratios" in normalizedUpdates) {
    normalizedUpdates.data_split_ratios = normalizeSplitRatios(normalizedUpdates.data_split_ratios)
  }
  if ("data_split_row_ranges" in normalizedUpdates) {
    normalizedUpdates.data_split_row_ranges = normalizeSplitRowRanges(normalizedUpdates.data_split_row_ranges)
  }
  if (
    "data_split_ratios" in normalizedUpdates &&
    "data_split_row_ranges" in normalizedUpdates &&
    !("data_split_method" in normalizedUpdates)
  ) {
    throw new TaskSpecUpdateError("data_split_method is required when ratios and row ranges are updated together")
  }
  for (const slot of ["target_columns", "exogenous_variables", "secondary_metrics"] as const) {
    if (!(slot in normalizedUpdates)) continue
    const value = normalizedUpdates[slot]
    if (typeof value !== "string" && !(Array.isArray(value) && value.every((item) => typeof item === "string"))) {
      throw new TaskSpecUpdateError(`${slot} must be a string list or comma-separated text`)
    }
  }
  for (const slot of ["latency_budget", "parameter_budget"] as const) {
    if (!(slot in normalizedUpdates)) continue
    const value = normalizedUpdates[slot]
    if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value) && value > 0)) {
      throw new TaskSpecUpdateError(`${slot} must be a positive number or a textual requirement`)
    }
  }
  for (const slot of ["max_iterations", "max_no_improve"] as const) {
    if (!(slot in normalizedUpdates)) continue
    const value = normalizedUpdates[slot]
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      throw new TaskSpecUpdateError(`${slot} must be a positive integer`)
    }
  }
  if ("interaction_mode" in normalizedUpdates && !["companion", "socratic"].includes(String(normalizedUpdates.interaction_mode))) {
    throw new TaskSpecUpdateError("interaction_mode must be companion or socratic")
  }
  if ("secondary_metrics" in normalizedUpdates) normalizedUpdates.secondary_metrics = stringArray(normalizedUpdates.secondary_metrics)
  if (typeof normalizedUpdates.exogenous_variables === "string") {
    normalizedUpdates.exogenous_variables = /^(none|无|没有)$/i.test(normalizedUpdates.exogenous_variables.trim())
      ? []
      : stringArray(normalizedUpdates.exogenous_variables)
  }
  if (typeof normalizedUpdates.target_columns === "string") {
    normalizedUpdates.target_columns = stringArray(normalizedUpdates.target_columns)
  }

  // Domain taskSpec schemas (e.g. TSFTaskSpec) are z.object({...}).strict() with `metadata`
  // as the only free-form field — a new top-level `intent` key would fail domain validation
  // below. So `metadata.intentSlots` (the same path the legacy code used) stays the one
  // canonical write target, not a new `taskSpec.intent.slots` namespace.
  const existingMetadata = recordValue(task.taskSpec.metadata)
  const existingSlots = recordValue(existingMetadata.intentSlots)
  const nextSlots = { ...existingSlots, ...normalizedUpdates }

  const datasetPatch: Record<string, unknown> = {}
  for (const [slotID, field] of Object.entries(DATASET_MIRROR_FIELD)) {
    if (slotID in normalizedUpdates) datasetPatch[field] = normalizedUpdates[slotID as SlotID]
  }
  const existingDataset = recordValue(task.taskSpec.dataset)
  const splitTouched = ["data_split_method", "data_split_ratios", "data_split_row_ranges"].some(
    (slot) => slot in normalizedUpdates,
  )
  if (splitTouched) {
    const existingSplit = recordValue(existingDataset.split)
    const inferredMethod = "data_split_row_ranges" in normalizedUpdates
      ? "row_ranges"
      : "data_split_ratios" in normalizedUpdates
        ? "ratio"
        : existingSplit.method === "row_ranges"
          ? "row_ranges"
          : "ratio"
    const method = normalizedUpdates.data_split_method ?? inferredMethod
    if (method === "ratio") {
      if ("data_split_row_ranges" in normalizedUpdates) {
        throw new TaskSpecUpdateError("data_split_row_ranges cannot be used with data_split_method=ratio")
      }
      const ratios = normalizeSplitRatios(
        normalizedUpdates.data_split_ratios ?? existingSplit.ratios ?? [7, 1, 2],
      )
      datasetPatch.split = { method: "ratio", ratios }
      nextSlots.data_split_method = "ratio"
      nextSlots.data_split_ratios = ratios
      delete nextSlots.data_split_row_ranges
    } else {
      if ("data_split_ratios" in normalizedUpdates) {
        throw new TaskSpecUpdateError("data_split_ratios cannot be used with data_split_method=row_ranges")
      }
      const existingRanges = existingSplit.method === "row_ranges"
        ? {
            train: existingSplit.trainRows,
            validation: existingSplit.validationRows,
            test: existingSplit.testRows,
          }
        : undefined
      const ranges = normalizeSplitRowRanges(normalizedUpdates.data_split_row_ranges ?? existingRanges)
      datasetPatch.split = {
        method: "row_ranges",
        trainRows: ranges.train,
        validationRows: ranges.validation,
        testRows: ranges.test,
      }
      nextSlots.data_split_method = "row_ranges"
      nextSlots.data_split_row_ranges = ranges
      delete nextSlots.data_split_ratios
    }
  }
  const resolved = resolveCovariates({ ...task, taskSpec: {
    ...task.taskSpec, dataset: { ...existingDataset, ...datasetPatch } as JsonRecord,
  } }, nextSlots)
  const availability = typeof nextSlots.future_covariate_availability === "string"
    ? nextSlots.future_covariate_availability.trim()
    : undefined
  const oracle = availability !== undefined && /oracle|上界|离线真值/i.test(availability)
  const unavailable = availability !== undefined && /not available|unavailable|不可用|不能|无法|否/i.test(availability)
  const availableAtPredictionTime = availability === undefined ? undefined : !oracle && !unavailable
  if (task.domainID === "tsf" && ((availability !== undefined && !unavailable) || (Array.isArray(existingDataset.knownFutureCovariates) && existingDataset.knownFutureCovariates.length > 0))) {
    throw new TaskSpecUpdateError("UNSUPPORTED_COVARIATE: known-future conditioning is unavailable; use observed-past covariates only")
  }
  if ("exogenous_variables" in nextSlots) {
    datasetPatch.observedPastCovariates = resolved.columns
    datasetPatch.knownFutureCovariates = []
  }

  const nextObjective = { ...task.objective }
  const nextBudget = { ...task.budget }
  for (const [slot, field] of Object.entries({ primary_metric: "primaryMetric", secondary_metrics: "secondaryMetrics", error_preferences: "errorPreferences" })) {
    if (slot in normalizedUpdates) nextObjective[field] = normalizedUpdates[slot as SlotID] as JsonRecord[string]
  }
  for (const [slot, field] of Object.entries({ latency_budget: "latencyBudget", parameter_budget: "parameterBudget" })) {
    if (slot in normalizedUpdates) nextBudget[field] = normalizedUpdates[slot as SlotID] as JsonRecord[string]
  }
  if ("max_iterations" in normalizedUpdates || "max_no_improve" in normalizedUpdates) {
    const loop = { ...recordValue(nextBudget.loop ?? nextBudget.researchLoop ?? nextBudget.autonomousLoop) }
    if ("max_iterations" in normalizedUpdates) loop.maxIterations = normalizedUpdates.max_iterations
    if ("max_no_improve" in normalizedUpdates) loop.maxNoImprove = normalizedUpdates.max_no_improve
    nextBudget.loop = loop as JsonRecord
  }
  const metadataPatch: Record<string, JsonRecord[string]> = {}
  for (const [slot, field] of Object.entries({ interaction_mode: "interactionMode", forecast_object: "forecastObject", business_context: "businessContext", interpretability: "interpretability", time_grain: "timeGrain" })) {
    if (slot in normalizedUpdates) metadataPatch[field] = normalizedUpdates[slot as SlotID] as JsonRecord[string]
  }
  const constraints = { ...recordValue(task.taskSpec.constraints) }
  if ("parameter_budget" in normalizedUpdates) {
    const limit = explicitParameterLimit(normalizedUpdates.parameter_budget)
    if (limit === undefined) delete constraints.maxParams
    else constraints.maxParams = limit
    metadataPatch.parameterBudgetEnforcement = limit === undefined ? "preference_only" : "hard_limit"
  }
  const mergedTaskSpec: JsonRecord = {
    ...task.taskSpec,
    ...(task.domainID === "tsf" && "parameter_budget" in normalizedUpdates ? { constraints: constraints as JsonRecord } : {}),
    // TSF readers and runner plans consume these fields, not the intent metadata.
    // Mirror only explicitly supplied updates, so unrelated edits cannot restore stale slots.
    ...(task.domainID === "tsf" && "prediction_horizon" in normalizedUpdates
      ? { predictionLengths: normalizedUpdates.prediction_horizon as JsonRecord[string] } : {}),
    ...(task.domainID === "tsf" && "lookback_window" in normalizedUpdates
      ? { contextLength: normalizedUpdates.lookback_window as JsonRecord[string] } : {}),
    ...(task.domainID === "tsf" && "primary_metric" in normalizedUpdates
      ? { evaluation: { ...recordValue(task.taskSpec.evaluation), metricPrimary: normalizedUpdates.primary_metric } as JsonRecord } : {}),
    ...(task.domainID === "tsf" && "deployment_target" in normalizedUpdates
      ? { runtime: { ...recordValue(task.taskSpec.runtime), deploymentTarget: normalizedUpdates.deployment_target } as JsonRecord } : {}),
    metadata: {
      ...existingMetadata,
      ...metadataPatch,
      intentSlots: nextSlots,
      ...(resolved.columns.length > 0 ? {
        resolvedCovariates: {
          policy: resolved.policy,
          columns: resolved.columns,
          source: resolved.source,
          schemaFingerprint: resolved.fingerprint,
          resolvedAt: new Date().toISOString(),
        },
      } : {}),
      ...(availability === undefined ? {} : {
        futureCovariateAvailability: availability,
        knownFutureAvailability: {
          source: availability,
          availableAtPredictionTime,
          verifiedBy: "user",
          verifiedAt: new Date().toISOString(),
        },
        experimentScope: oracle ? "oracle_covariate_upper_bound" : unavailable ? "past_covariates_only" : "production_candidate",
        productionComparable: !oracle,
      }),
    } as unknown as JsonRecord,
    ...(Object.keys(datasetPatch).length > 0
      ? { dataset: { ...existingDataset, ...datasetPatch } as unknown as JsonRecord }
      : {}),
  }

  let normalizedTaskSpec: JsonRecord
  try {
    normalizedTaskSpec = normalizeTaskSpecForDomain(task, mergedTaskSpec)
  } catch (error) {
    throw new TaskSpecUpdateError(error instanceof Error ? error.message : String(error))
  }

  // updateTaskSpec() in service.ts strips a stale `metadata.workflow` snapshot on every
  // write (workflow progression is only ever mutated via updateTaskWorkflow()); mirror
  // that here so this write path can't accidentally roll workflow state back.
  const nextMetadata = recordValue(normalizedTaskSpec.metadata)
  if (nextMetadata.workflow !== undefined) delete nextMetadata.workflow

  const row = Database.use((d) =>
    d
      .update(ResearchTaskTable)
      .set({
        task_spec: { ...normalizedTaskSpec, metadata: nextMetadata as unknown as JsonRecord },
        objective: nextObjective,
        budget: nextBudget,
        time_updated: Date.now(),
      })
      .where(and(eq(ResearchTaskTable.id, taskID), eq(ResearchTaskTable.project_id, task.projectID)))
      .returning()
      .get(),
  )
  if (!row) throw new TaskNotFoundError(taskID)
  const updated = mapTask(row)
  supersedeIntentCheckpoints(taskID, `Intent signature: ${intentCheckpointSignature(updated)}`)
  void Bus.publish(Event.TaskUpdated, { task: updated }).catch(() => undefined)
  return snapshotFromTask(taskID, updated)
}

export interface TaskspecReadiness {
  readonly ok: boolean
  readonly missingRequiredSlots: SlotID[]
  readonly confidence: number
}

export async function checkTaskspecReadiness(taskID: ResearchTaskID): Promise<TaskspecReadiness> {
  const snapshot = await readTaskspecSlots(taskID)
  return {
    ok: snapshot.missingRequiredSlots.length === 0,
    missingRequiredSlots: snapshot.missingRequiredSlots,
    confidence: snapshot.confidence,
  }
}

export const ASK_USER_CLARIFICATION_MARKER = "需要澄清研究意图："

// ask_user creates a fresh pending approval per question and nothing else ever resolves the
// previous one — left alone, they pile up and the stalest one keeps winning in the cockpit's
// "what's the current clarification state" lookup (research-cockpit-data.ts
// buildSocraticClarificationState), permanently hiding newer approvals like the
// intent_confirmed checkpoint behind a question that's already been superseded. Delete them
// outright (rather than just filtering display-side) once they're no longer the live question.
function deletePendingAskUserApprovals(taskID: ResearchTaskID) {
  Database.use((d) =>
    d
      .delete(ResearchApprovalTable)
      .where(
        and(
          eq(ResearchApprovalTable.task_id, taskID),
          eq(ResearchApprovalTable.kind, "protocol"),
          eq(ResearchApprovalTable.status, "pending"),
          like(ResearchApprovalTable.reason, `${ASK_USER_CLARIFICATION_MARKER}%`),
        ),
      )
      .run(),
  )
}

// Records the questions the IntentAgent session is pausing on. This is the only
// write path the `ask_user` tool performs — it does not touch taskSpec and does not
// drive the pipeline state machine; service.ts's session observer reacts to the
// ResearchIntentAwaitingUser event to mark the session as suspended for this task.
export async function recordAskUserQuestions(taskID: ResearchTaskID, questions: readonly string[]) {
  await loadTask(taskID)
  // The leading line matches the marker the cockpit TUI looks for (research-cockpit-data.ts
  // buildSocraticClarificationState) to recognize this approval as the active intent
  // clarification prompt, rather than some other "protocol" kind approval (e.g. the
  // post-completion intent_confirmed checkpoint).
  const reason = [ASK_USER_CLARIFICATION_MARKER, ...questions.map((q) => `- ${q}`)].join("\n")
  const time = Date.now()
  // Drop any still-pending question from an earlier turn — only the latest one is "live".
  deletePendingAskUserApprovals(taskID)
  const row = Database.use((d) =>
    d
      .insert(ResearchApprovalTable)
      .values({
        id: ResearchApprovalID.ascending(),
        task_id: taskID,
        candidate_id: undefined,
        kind: "protocol",
        status: "pending",
        reason,
        time_created: time,
        time_updated: time,
      })
      .returning()
      .get(),
  )
  const approval = mapApproval(row)
  void Bus.publish(Event.ApprovalCreated, { approval }).catch(() => undefined)
  void Bus.publish(Event.IntentAgentAwaitingUser, { taskID, questions: [...questions] }).catch(() => undefined)
  return approval
}

// ---------------------------------------------------------------------------
// enterIntentCheckpoint — the actual effect of calling check_taskspec
// ---------------------------------------------------------------------------
//
// check_taskspec's job is not to "decide" anything itself: once read_taskspec has shown no
// required slot is missing, calling it opens the human checkpoint directly (creating the
// pending approval right here), instead of just returning a yes/no signal that some later,
// separately-triggered pipeline step might or might not act on. service.ts's own
// ensureIntentCheckpoint() (used by runFullPipeline's deterministic slot-completeness path)
// targets the exact same dedup key (checkpointTag + signature), so whichever of the two paths
// runs first creates the approval and the other safely finds the existing row — no duplicates.
//
// The helpers below mirror service.ts's taskInteractionMode/compactIntentValue/
// intentCheckpointSignature/buildIntentCheckpointReason. They're duplicated, not imported,
// because taskspec-store.ts must not depend on service.ts (see the standalone-module note at
// the top of this file) — keep them in sync by hand if either side changes.

function taskInteractionMode(task: ResearchTask): IntentInteractionMode | undefined {
  if (task.interactionMode === "companion" || task.interactionMode === "socratic") return task.interactionMode
  return interactionModeForTask(task)
}

function compactIntentValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(compactIntentValue).join(",")
  if (typeof value === "string") return value.trim() || "-"
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return "-"
}

function intentCheckpointSignature(task: ResearchTask) {
  const spec = recordValue(task.taskSpec)
  const dataset = recordValue(spec.dataset)
  const objective = recordValue(task.objective)
  const budget = recordValue(task.budget)
  const loop = recordValue(budget.loop ?? budget.researchLoop ?? budget.autonomousLoop)
  return [
    `mode=${compactIntentValue(taskInteractionMode(task) ?? task.mode)}`,
    `dataset=${compactIntentValue(dataset.path ?? dataset.loaderID)}`,
    `split=${JSON.stringify(dataset.split ?? null)}`,
    `targets=${compactIntentValue(dataset.targetCols)}`,
    `pastCovariates=${compactIntentValue(dataset.observedPastCovariates)}`,
    `futureCovariates=${compactIntentValue(dataset.knownFutureCovariates)}`,
    `covariateSchema=${compactIntentValue(recordValue(recordValue(spec.metadata).resolvedCovariates).schemaFingerprint)}`,
    `context=${compactIntentValue(spec.contextLength)}`,
    `horizons=${compactIntentValue(spec.predictionLengths)}`,
    `metric=${compactIntentValue(objective.primaryMetric)}`,
    `direction=${compactIntentValue(objective.direction)}`,
    `maxIterations=${compactIntentValue(loop.maxIterations ?? NAS_DEFAULT_MAX_ITERATIONS)}`,
    `maxNoImprove=${compactIntentValue(loop.maxNoImprove ?? loop.maxNoImproveRounds ?? NAS_DEFAULT_MAX_NO_IMPROVE)}`,
  ].join("|")
}

function buildIntentCheckpointReason(task: ResearchTask) {
  const spec = recordValue(task.taskSpec)
  const dataset = recordValue(spec.dataset)
  const objective = recordValue(task.objective)
  const budget = recordValue(task.budget)
  const loop = recordValue(budget.loop ?? budget.researchLoop ?? budget.autonomousLoop)
  const metadata = recordValue(spec.metadata)
  const intentSlots = recordValue(metadata.intentSlots)
  function slotOr(canonical: unknown, slotKey: string) {
    return canonical !== undefined && canonical !== null ? canonical : intentSlots[slotKey]
  }
  return [
    "## 需求交流确认完成后，才能结束 Intent Agent",
    "",
    "请确认 Intent Agent 已完成需求交流，下面这些研究意图可以作为后续 Data Analysis、HypoPlanner 和实验循环的输入。",
    `Intent signature: ${intentCheckpointSignature(task)}`,
    `Interaction mode: ${compactIntentValue(taskInteractionMode(task) ?? task.mode)}`,
    `Task: ${task.title}`,
    `Dataset: ${compactIntentValue(slotOr(dataset.path ?? dataset.loaderID, "data_source"))}`,
    `Data split: ${JSON.stringify(dataset.split ?? null)}`,
    `Targets: ${compactIntentValue(slotOr(dataset.targetCols, "target_columns"))}`,
    `Forecast object: ${compactIntentValue(intentSlots.forecast_object ?? spec.forecastObject)}`,
    `Context length: ${compactIntentValue(slotOr(spec.contextLength, "lookback_window"))}`,
    `Prediction lengths: ${compactIntentValue(slotOr(spec.predictionLengths, "prediction_horizon"))}`,
    `Time grain: ${compactIntentValue(intentSlots.time_grain ?? spec.timeGrain ?? spec.frequency)}`,
    `Exogenous variables: ${compactIntentValue(intentSlots.exogenous_variables ?? dataset.exogenousCols)}`,
    `Observed past covariates: ${compactIntentValue(dataset.observedPastCovariates)}`,
    `Known future covariates: ${compactIntentValue(dataset.knownFutureCovariates)}`,
    `Covariate count: ${Array.isArray(dataset.knownFutureCovariates) ? dataset.knownFutureCovariates.length : 0}`,
    `Future availability: ${compactIntentValue(metadata.futureCovariateAvailability)}`,
    "Runtime capability: only targets and observed-past covariates are supported; known-future and static conditioning are unavailable.",
    `Primary metric: ${compactIntentValue(slotOr(objective.primaryMetric, "primary_metric"))}`,
    `Error preferences: ${compactIntentValue(intentSlots.error_preferences ?? objective.errorPreferences)}`,
    `Latency budget: ${compactIntentValue(intentSlots.latency_budget ?? budget.latencyBudget)}`,
    `Parameter budget: ${compactIntentValue(intentSlots.parameter_budget ?? budget.parameterBudget)}`,
    `NAS planned iterations: ${compactIntentValue(intentSlots.max_iterations ?? loop.maxIterations ?? NAS_DEFAULT_MAX_ITERATIONS)}`,
    `Stop after no improvement: ${compactIntentValue(intentSlots.max_no_improve ?? loop.maxNoImprove ?? loop.maxNoImproveRounds ?? NAS_DEFAULT_MAX_NO_IMPROVE)}`,
    `Interpretability: ${compactIntentValue(intentSlots.interpretability ?? spec.interpretability)}`,
    `Deployment target: ${compactIntentValue(intentSlots.deployment_target ?? spec.deploymentTarget)}`,
    `Business context: ${compactIntentValue(intentSlots.business_context ?? metadata.businessContext ?? metadata.business_context)}`,
    "",
    "**建议操作：** 确认以上需求后 approve，系统才会结束 Intent Agent 并进入 Data Analysis；如需补充需求，请 reject 并逐一修改 slots 后重新确认。",
  ].join("\n")
}

export interface IntentCheckpointResult {
  readonly status: "pending" | "approved"
  readonly approvalID: string
}

// Preserve old approval snapshots for audit, but never leave a superseded intent pending.
export function supersedeIntentCheckpoints(taskID: ResearchTaskID, signature: string) {
  const rows = Database.use((d) => d.select().from(ResearchApprovalTable).where(and(
    eq(ResearchApprovalTable.task_id, taskID),
    eq(ResearchApprovalTable.kind, "protocol"),
    eq(ResearchApprovalTable.status, "pending"),
    isNull(ResearchApprovalTable.candidate_id),
  )).all())
  for (const row of rows) {
    if (!row.reason.includes("[checkpoint:intent_confirmed]")) continue
    if (row.reason.split(/\r?\n/).includes(signature)) continue
    const updated = Database.use((d) => d.update(ResearchApprovalTable).set({
      status: "rejected", reply_message: "Superseded by updated research intent.",
      time_updated: Date.now(),
    }).where(and(eq(ResearchApprovalTable.id, row.id), eq(ResearchApprovalTable.status, "pending"))).returning().get())
    if (updated) void Bus.publish(Event.ApprovalUpdated, { approval: mapApproval(updated) }).catch(() => undefined)
  }
}

export async function enterIntentCheckpoint(taskID: ResearchTaskID): Promise<IntentCheckpointResult> {
  let task = await loadTask(taskID)
  const intentSlots = recordValue(recordValue(task.taskSpec.metadata).intentSlots)
  if (stringArray(intentSlots.exogenous_variables).some((value) => /^(all|全部)$/i.test(value) || value.includes("全部外生"))) {
    await applySlotUpdates(taskID, {})
    task = await loadTask(taskID)
  }
  const checkpointTag = "[checkpoint:intent_confirmed]"
  const signature = `Intent signature: ${intentCheckpointSignature(task)}`
  supersedeIntentCheckpoints(taskID, signature)
  const rows = Database.use((d) =>
    d
      .select()
      .from(ResearchApprovalTable)
      .where(
        and(
          eq(ResearchApprovalTable.task_id, taskID),
          isNull(ResearchApprovalTable.candidate_id),
          eq(ResearchApprovalTable.kind, "protocol"),
        ),
      )
      .all(),
  )
  const approved = rows.find(
    (row) => row.status === "approved" && row.reason.includes(checkpointTag) && row.reason.includes(signature),
  )
  if (approved) return { status: "approved", approvalID: approved.id }
  const pending = rows.find(
    (row) => row.status === "pending" && row.reason.includes(checkpointTag) && row.reason.includes(signature),
  )
  if (pending) return { status: "pending", approvalID: pending.id }
  // read_taskspec/check_taskspec confirmed no required slot is missing — any leftover pending
  // ask_user question from an earlier turn is now stale, not a live prompt. Delete it so it
  // can't keep masking this new checkpoint approval in the cockpit's clarification-state lookup.
  deletePendingAskUserApprovals(taskID)
  const time = Date.now()
  const row = Database.use((d) =>
    d
      .insert(ResearchApprovalTable)
      .values({
        id: ResearchApprovalID.ascending(),
        task_id: taskID,
        candidate_id: undefined,
        kind: "protocol",
        status: "pending",
        reason: `${checkpointTag}\n${buildIntentCheckpointReason(task)}`,
        time_created: time,
        time_updated: time,
      })
      .returning()
      .get(),
  )
  const approval = mapApproval(row)
  void Bus.publish(Event.ApprovalCreated, { approval }).catch(() => undefined)
  // Mirrors runFullPipeline's behavior when it opens this same checkpoint: pause the task so
  // it doesn't silently keep going while waiting for the human to approve/reject.
  const pausedRow = Database.use((d) =>
    d
      .update(ResearchTaskTable)
      .set({ status: "paused", time_updated: Date.now() })
      .where(and(eq(ResearchTaskTable.id, taskID), eq(ResearchTaskTable.project_id, task.projectID)))
      .returning()
      .get(),
  )
  if (pausedRow) void Bus.publish(Event.TaskUpdated, { task: mapTask(pausedRow) }).catch(() => undefined)
  return { status: "pending", approvalID: approval.id }
}
