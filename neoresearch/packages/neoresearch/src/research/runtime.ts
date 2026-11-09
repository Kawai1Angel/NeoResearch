import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "fs/promises"
import path from "path"
import { digest, verifyExecutionRecords, type ExecutionContract } from "./execution-contract"

import * as Process from "@/util/process"
import { ensureRunnerPython } from "./runners/neo-cast-install"
import { DomainRunPlan as DomainRunPlanSchema, type DomainRunPlan } from "./domain"
import type {
  JsonRecord,
  ResearchRunID,
  ResearchRunStage,
  ResearchRunStatus,
  ResearchTaskID,
} from "./schema"

export type ResearchJobID = string
export type ResearchWorkerID = string

export type ResearchJob = {
  readonly id: ResearchJobID
  readonly taskID: ResearchTaskID | string
  readonly runID: ResearchRunID | string
  readonly domainID: string
  readonly runnerID: string
  readonly stage: ResearchRunStage | string
  readonly attempt: number
  readonly priority: number
  readonly createdAt: number
  readonly availableAt: number
  readonly payload: DomainRunPlan | JsonRecord
}

export type RunnerWorkerHeartbeat = {
  readonly workerID: ResearchWorkerID
  readonly jobID?: ResearchJobID
  readonly status: "idle" | "leased" | "running" | "draining" | "offline"
  readonly seenAt: number
  readonly leaseExpiresAt?: number
  readonly metadata?: JsonRecord
}

export type ResearchJobLease = {
  readonly job: ResearchJob
  readonly heartbeat: RunnerWorkerHeartbeat
}

export interface ResearchQueueDriver {
  readonly enqueue: (job: ResearchJob) => Promise<void>
  readonly lease: (input: {
    readonly workerID: ResearchWorkerID
    readonly now: number
    readonly leaseMs?: number
  }) => Promise<ResearchJobLease | undefined>
  readonly heartbeat: (heartbeat: RunnerWorkerHeartbeat) => Promise<void>
  readonly complete: (jobID: ResearchJobID) => Promise<void>
  readonly fail: (input: {
    readonly jobID: ResearchJobID
    readonly error: string
    readonly retryAt?: number
  }) => Promise<void>
}

export type ArtifactStorePutInput = {
  readonly uri: string
  readonly kind: string
  readonly metadata?: JsonRecord
}

export interface ArtifactStoreDriver {
  readonly put: (input: ArtifactStorePutInput) => Promise<{ readonly uri: string }>
  readonly resolve: (uri: string) => Promise<{ readonly uri: string }>
}

export type MetricsRunRecord = {
  readonly runID: ResearchRunID | string
  readonly metrics: JsonRecord
  readonly resourceUsage?: JsonRecord
  readonly recordedAt?: number
}

export interface MetricsStoreDriver {
  readonly recordRunMetrics: (record: MetricsRunRecord) => Promise<void>
  readonly recordWorkerHeartbeat: (heartbeat: RunnerWorkerHeartbeat) => Promise<void>
}

export type FileResearchRuntime = {
  readonly queue: FileResearchQueueDriver
  readonly artifactStore: FileArtifactStoreDriver
  readonly metricsStore: FileMetricsStoreDriver
}

export type FailureRecoveryPolicy = {
  readonly maxAttempts: number
  readonly retryableErrorKinds: readonly string[]
  readonly baseDelayMs: number
  readonly maxDelayMs: number
}

export type RecoveryDecision =
  | { readonly action: "retry"; readonly delayMs: number }
  | { readonly action: "dead_letter"; readonly reason: "max_attempts_exceeded" | "non_retryable_error" }
  | { readonly action: "discard"; readonly reason: "terminal_status" }

export type ResearchWorkerExecutionResult = {
  readonly status: "succeeded" | "failed" | "rejected" | "invalid"
  readonly metrics?: JsonRecord
  readonly resourceUsage?: JsonRecord
  readonly artifacts?: readonly ArtifactStorePutInput[]
  readonly executionLog?: {
    readonly stdout: string
    readonly stderr: string
    readonly records: readonly Record<string, unknown>[]
  }
  readonly error?: string
  readonly errorKind?: string
}

export type ResearchWorkerOnceResult =
  | { readonly status: "idle" }
  | {
      readonly status: "completed"
      readonly jobID: ResearchJobID
      readonly artifactURIs: readonly string[]
    }
  | {
      readonly status: "retry_scheduled"
      readonly jobID: ResearchJobID
      readonly retryAt: number
      readonly error: string
    }
  | {
      readonly status: "dead_lettered"
      readonly jobID: ResearchJobID
      readonly reason: "max_attempts_exceeded" | "non_retryable_error"
      readonly error: string
    }

export const DEFAULT_FAILURE_RECOVERY_POLICY = {
  maxAttempts: 3,
  retryableErrorKinds: ["runner_exit", "worker_lost", "timeout", "transient_io"],
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
} as const satisfies FailureRecoveryPolicy

export function researchJobKey(job: Pick<ResearchJob, "taskID" | "runID" | "attempt">) {
  return `${job.taskID}/${job.runID}/${job.attempt}`
}

export function researchJobFromRunPlan(input: {
  readonly taskID: ResearchTaskID | string
  readonly runID: ResearchRunID | string
  readonly runPlan: DomainRunPlan
  readonly priority?: number
  readonly attempt?: number
  readonly now?: number
  readonly availableAt?: number
}): ResearchJob {
  const attempt = input.attempt ?? 1
  const createdAt = input.now ?? Date.now()
  const availableAt = input.availableAt ?? createdAt
  return {
    id: researchJobKey({ taskID: input.taskID, runID: input.runID, attempt }),
    taskID: input.taskID,
    runID: input.runID,
    domainID: input.runPlan.domainID,
    runnerID: input.runPlan.runnerID,
    stage: input.runPlan.stage,
    attempt,
    priority: input.priority ?? 0,
    createdAt,
    availableAt,
    payload: input.runPlan,
  }
}

export function normalizeArtifactURI(uri: string) {
  const trimmed = uri.trim()
  if (trimmed.length === 0) throw new Error("Artifact URI cannot be empty")

  const scheme = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase()
  if (scheme === undefined) return `file://${path.resolve(trimmed)}`
  if (scheme !== "file") return trimmed.replace(/\/+$/, "")

  const filePath = trimmed.slice("file://".length)
  return `file://${path.resolve(filePath)}`
}

function runnerPath(cwd: string, target: string) {
  return path.isAbsolute(target) ? target : path.join(cwd, target)
}

function fileNameForID(id: string) {
  return `${encodeURIComponent(id)}.json`
}

export function parseResearchRunnerRecords(stdout: string) {
  const records: Record<string, unknown>[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) records.push(parsed)
    } catch {
      // Runners may emit human-readable status lines next to JSONL records.
    }
  }
  return records
}

function metricsFromRunnerRecords(records: readonly Record<string, unknown>[]) {
  const metrics: Record<string, number> = {}
  const prefixes = ["val_", "test_", "ref_test_", "blind_test_"]
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (prefixes.some((prefix) => key.startsWith(prefix)) && typeof value === "number") metrics[key] = value
    }
  }
  return metrics
}

function artifactsFromRunnerRecords(records: readonly Record<string, unknown>[], plan: DomainRunPlan) {
  const artifacts: ArtifactStorePutInput[] = []
  for (const record of records) {
    if (typeof record.artifact_dir !== "string" || record.artifact_dir.length === 0) continue
    artifacts.push({
      uri: normalizeArtifactURI(record.artifact_dir),
      kind: "runner_artifact",
      metadata: {
        runnerID: plan.runnerID,
        stage: plan.stage,
        event: typeof record.event === "string" ? record.event : "artifact_ready",
      },
    })
  }
  return artifacts
}

function isMissingFile(error: unknown) {
  return (error as { readonly code?: unknown }).code === "ENOENT"
}

async function readJSONFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
}

async function writeJSONFile(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function listJSONFiles<T>(directory: string): Promise<T[]> {
  let files: string[]
  try {
    files = await readdir(directory)
  } catch (error) {
    if (isMissingFile(error)) return []
    throw error
  }

  const values: T[] = []
  for (const file of files) {
    if (!file.endsWith(".json")) continue
    const value = await readJSONFile<T>(path.join(directory, file))
    if (value !== undefined) values.push(value)
  }
  return values
}

export function nextRecoveryAction(input: {
  readonly policy?: FailureRecoveryPolicy
  readonly attempts: number
  readonly status: ResearchRunStatus | "lost" | string
  readonly errorKind?: string
}): RecoveryDecision {
  const policy = input.policy ?? DEFAULT_FAILURE_RECOVERY_POLICY
  if (input.status === "succeeded" || input.status === "rejected" || input.status === "invalid") {
    return { action: "discard", reason: "terminal_status" }
  }

  if (input.errorKind !== undefined && !policy.retryableErrorKinds.includes(input.errorKind)) {
    return { action: "dead_letter", reason: "non_retryable_error" }
  }

  if (input.attempts >= policy.maxAttempts) {
    return { action: "dead_letter", reason: "max_attempts_exceeded" }
  }

  const delayMs = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, input.attempts - 1))
  return { action: "retry", delayMs }
}

export async function runResearchWorkerOnce(input: {
  readonly queue: ResearchQueueDriver
  readonly artifactStore: ArtifactStoreDriver
  readonly metricsStore: MetricsStoreDriver
  readonly workerID: ResearchWorkerID
  readonly now: number
  readonly leaseMs?: number
  readonly policy?: FailureRecoveryPolicy
  readonly execute: (job: ResearchJob) => Promise<ResearchWorkerExecutionResult>
}): Promise<ResearchWorkerOnceResult> {
  const lease = await input.queue.lease({
    workerID: input.workerID,
    now: input.now,
    leaseMs: input.leaseMs,
  })
  if (lease === undefined) {
    await input.metricsStore.recordWorkerHeartbeat({
      workerID: input.workerID,
      status: "idle",
      seenAt: input.now,
    })
    return { status: "idle" }
  }

  const runningHeartbeat = {
    ...lease.heartbeat,
    status: "running",
    seenAt: input.now,
  } satisfies RunnerWorkerHeartbeat
  await input.queue.heartbeat(runningHeartbeat)
  await input.metricsStore.recordWorkerHeartbeat(runningHeartbeat)

  let execution: ResearchWorkerExecutionResult
  try {
    execution = await input.execute(lease.job)
  } catch (error) {
    execution = {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      errorKind: "runner_exit",
    }
  }

  const artifactURIs: string[] = []
  for (const artifact of execution.artifacts ?? []) {
    artifactURIs.push((await input.artifactStore.put(artifact)).uri)
  }

  if (execution.metrics !== undefined || execution.resourceUsage !== undefined) {
    await input.metricsStore.recordRunMetrics({
      runID: lease.job.runID,
      metrics: execution.metrics ?? {},
      resourceUsage: execution.resourceUsage,
      recordedAt: input.now,
    })
  }

  const idleHeartbeat = {
    workerID: input.workerID,
    status: "idle",
    seenAt: input.now,
    metadata: {
      lastJobID: lease.job.id,
      lastStatus: execution.status,
    },
  } satisfies RunnerWorkerHeartbeat

  if (execution.status === "succeeded") {
    await input.queue.complete(lease.job.id)
    await input.queue.heartbeat(idleHeartbeat)
    await input.metricsStore.recordWorkerHeartbeat(idleHeartbeat)
    return { status: "completed", jobID: lease.job.id, artifactURIs }
  }

  const error = execution.error ?? execution.status
  const decision = nextRecoveryAction({
    policy: input.policy,
    attempts: lease.job.attempt,
    status: execution.status,
    errorKind: execution.errorKind,
  })
  if (decision.action === "retry") {
    const retryAt = input.now + decision.delayMs
    await input.queue.fail({ jobID: lease.job.id, error, retryAt })
    await input.queue.heartbeat(idleHeartbeat)
    await input.metricsStore.recordWorkerHeartbeat(idleHeartbeat)
    return { status: "retry_scheduled", jobID: lease.job.id, retryAt, error }
  }
  if (decision.action === "discard") {
    await input.queue.complete(lease.job.id)
    await input.queue.heartbeat(idleHeartbeat)
    await input.metricsStore.recordWorkerHeartbeat(idleHeartbeat)
    return { status: "completed", jobID: lease.job.id, artifactURIs }
  }

  await input.queue.fail({ jobID: lease.job.id, error })
  await input.queue.heartbeat(idleHeartbeat)
  await input.metricsStore.recordWorkerHeartbeat(idleHeartbeat)
  return {
    status: "dead_lettered",
    jobID: lease.job.id,
    reason: decision.reason,
    error,
  }
}

export async function executeSubprocessResearchJob(job: ResearchJob): Promise<ResearchWorkerExecutionResult> {
  const parsed = DomainRunPlanSchema.safeParse(job.payload)
  if (!parsed.success) {
    return {
      status: "failed",
      error: "Research job payload is not a valid DomainRunPlan",
      errorKind: "validation",
      resourceUsage: { runnerID: job.runnerID },
    }
  }

  const plan = parsed.data
  const cwd = plan.command.cwd ?? process.cwd()
  const contract = plan.writes.find((write) => write.content.schema_version === "research_execution_contract.v1")?.content as unknown as ExecutionContract | undefined
  if (plan.domainID === "tsf" && plan.stage !== "ref_test" && plan.stage !== "blind_test") {
    const proof = plan.writes.find((write) => write.content.event === "execution_contract_verified")?.content
    if (!contract || !contract.hypothesis_id || !plan.command.env?.NEO_CAST_EXECUTION_CONTRACT || (plan.stage !== "smoke" && (!proof || verifyExecutionRecords(contract, [proof.manifest as Record<string, unknown>, proof]).length || !proof.verification_smoke_run_id || typeof proof.smoke_metric !== "number" || !Number.isFinite(proof.smoke_metric)))) {
      return { status: "invalid", metrics: {}, error: "Missing execution contract or matching verified smoke proof", errorKind: "execution_contract_violation" }
    }
  }
  await ensureRunnerPython(plan.command)
  for (const item of plan.writes) {
    await writeJSONFile(runnerPath(cwd, item.path), item.content)
  }

  const result = await Process.run([plan.command.executable, ...plan.command.args], {
    cwd,
    env: plan.command.env,
    timeout: plan.command.timeoutMs,
    nothrow: true,
  })
  const stdout = result.stdout.toString()
  const stderr = result.stderr.toString()
  const records = parseResearchRunnerRecords(stdout)
  const metrics = metricsFromRunnerRecords(records)
  const artifacts = artifactsFromRunnerRecords(records, plan)
  const resourceUsage = {
    exitCode: result.code,
    runnerID: plan.runnerID,
  }

  if (contract && verifyExecutionRecords(contract, records).length) return { status: "invalid", metrics: {}, resourceUsage, artifacts, executionLog: { stdout, stderr, records }, error: "Execution contract violation", errorKind: "execution_contract_violation" }
  if (result.code === 0) {
    return {
      status: "succeeded",
      metrics,
      resourceUsage,
      artifacts,
      executionLog: {
        stdout,
        stderr,
        records,
      },
    }
  }

  return {
    status: "failed",
    metrics,
    resourceUsage,
    artifacts,
    executionLog: {
      stdout,
      stderr,
      records,
    },
    error: stderr || `Runner exited with code ${result.code}`,
    errorKind: "runner_exit",
  }
}

export class InMemoryResearchQueueDriver implements ResearchQueueDriver {
  private readonly jobs = new Map<ResearchJobID, ResearchJob>()
  private readonly leases = new Map<ResearchJobID, RunnerWorkerHeartbeat>()
  private readonly failures = new Map<ResearchJobID, string>()

  async enqueue(job: ResearchJob) {
    this.jobs.set(job.id, job)
    this.failures.delete(job.id)
  }

  async lease(input: { readonly workerID: ResearchWorkerID; readonly now: number; readonly leaseMs?: number }) {
    const candidates = [...this.jobs.values()]
      .filter((job) => {
        const lease = this.leases.get(job.id)
        return job.availableAt <= input.now && (lease === undefined || (lease.leaseExpiresAt ?? 0) <= input.now)
      })
      .sort(
        (left, right) =>
          right.priority - left.priority || left.availableAt - right.availableAt || left.createdAt - right.createdAt,
      )

    const job = candidates[0]
    if (job === undefined) return undefined

    const heartbeat = {
      workerID: input.workerID,
      jobID: job.id,
      status: "leased",
      seenAt: input.now,
      leaseExpiresAt: input.now + (input.leaseMs ?? 30_000),
    } satisfies RunnerWorkerHeartbeat
    this.leases.set(job.id, heartbeat)
    return { job, heartbeat }
  }

  async heartbeat(heartbeat: RunnerWorkerHeartbeat) {
    if (heartbeat.jobID !== undefined) this.leases.set(heartbeat.jobID, heartbeat)
  }

  async complete(jobID: ResearchJobID) {
    this.jobs.delete(jobID)
    this.leases.delete(jobID)
    this.failures.delete(jobID)
  }

  async fail(input: { readonly jobID: ResearchJobID; readonly error: string; readonly retryAt?: number }) {
    const existing = this.jobs.get(input.jobID)
    if (existing !== undefined && input.retryAt !== undefined) {
      this.jobs.set(input.jobID, { ...existing, availableAt: input.retryAt, attempt: existing.attempt + 1 })
    }
    this.leases.delete(input.jobID)
    this.failures.set(input.jobID, input.error)
  }
}

export class FileResearchQueueDriver implements ResearchQueueDriver {
  private readonly jobsDir: string
  private readonly leasesDir: string
  private readonly failuresDir: string
  private readonly workersDir: string

  constructor(private readonly root: string) {
    this.jobsDir = path.join(root, "jobs")
    this.leasesDir = path.join(root, "leases")
    this.failuresDir = path.join(root, "failures")
    this.workersDir = path.join(root, "workers")
  }

  private jobPath(jobID: ResearchJobID) {
    return path.join(this.jobsDir, fileNameForID(jobID))
  }

  private leasePath(jobID: ResearchJobID) {
    return path.join(this.leasesDir, fileNameForID(jobID))
  }

  private failurePath(jobID: ResearchJobID) {
    return path.join(this.failuresDir, fileNameForID(jobID))
  }

  async enqueue(job: ResearchJob) {
    await writeJSONFile(this.jobPath(job.id), job)
    await rm(this.failurePath(job.id), { force: true })
  }

  async lease(input: { readonly workerID: ResearchWorkerID; readonly now: number; readonly leaseMs?: number }) {
    const jobs = await listJSONFiles<ResearchJob>(this.jobsDir)
    const candidates: Array<{ readonly job: ResearchJob; readonly lease?: RunnerWorkerHeartbeat }> = []
    for (const job of jobs) {
      const lease = await readJSONFile<RunnerWorkerHeartbeat>(this.leasePath(job.id))
      if (job.availableAt <= input.now && (lease === undefined || (lease.leaseExpiresAt ?? 0) <= input.now)) {
        candidates.push({ job, lease })
      }
    }

    candidates.sort(
      (left, right) =>
        right.job.priority - left.job.priority ||
        left.job.availableAt - right.job.availableAt ||
        left.job.createdAt - right.job.createdAt,
    )

    const selected = candidates[0]?.job
    if (selected === undefined) return undefined

    const heartbeat = {
      workerID: input.workerID,
      jobID: selected.id,
      status: "leased",
      seenAt: input.now,
      leaseExpiresAt: input.now + (input.leaseMs ?? 30_000),
    } satisfies RunnerWorkerHeartbeat
    await this.heartbeat(heartbeat)
    return { job: selected, heartbeat }
  }

  async heartbeat(heartbeat: RunnerWorkerHeartbeat) {
    if (heartbeat.jobID !== undefined) {
      await writeJSONFile(this.leasePath(heartbeat.jobID), heartbeat)
    }
    await writeJSONFile(path.join(this.workersDir, fileNameForID(heartbeat.workerID)), heartbeat)
  }

  async complete(jobID: ResearchJobID) {
    await rm(this.jobPath(jobID), { force: true })
    await rm(this.leasePath(jobID), { force: true })
    await rm(this.failurePath(jobID), { force: true })
  }

  async fail(input: { readonly jobID: ResearchJobID; readonly error: string; readonly retryAt?: number }) {
    const existing = await readJSONFile<ResearchJob>(this.jobPath(input.jobID))
    if (existing !== undefined && input.retryAt !== undefined) {
      await writeJSONFile(this.jobPath(input.jobID), {
        ...existing,
        availableAt: input.retryAt,
        attempt: existing.attempt + 1,
      })
    }
    await rm(this.leasePath(input.jobID), { force: true })
    await writeJSONFile(this.failurePath(input.jobID), {
      jobID: input.jobID,
      error: input.error,
      retryAt: input.retryAt,
      failedAt: Date.now(),
    })
  }
}

export function createNoopArtifactStoreDriver(): ArtifactStoreDriver {
  return {
    async put(input) {
      return { uri: normalizeArtifactURI(input.uri) }
    },
    async resolve(uri) {
      return { uri: normalizeArtifactURI(uri) }
    },
  }
}

export class FileArtifactStoreDriver implements ArtifactStoreDriver {
  private readonly logPath: string

  constructor(private readonly root: string) {
    this.logPath = path.join(root, "artifacts.jsonl")
  }

  async put(input: ArtifactStorePutInput) {
    const uri = normalizeArtifactURI(input.uri)
    await mkdir(this.root, { recursive: true })
    await appendFile(
      this.logPath,
      `${JSON.stringify({
        uri,
        kind: input.kind,
        metadata: input.metadata ?? {},
        recordedAt: Date.now(),
      })}\n`,
      "utf8",
    )
    return { uri }
  }

  async resolve(uri: string) {
    return { uri: normalizeArtifactURI(uri) }
  }
}

export function createNoopMetricsStoreDriver(): MetricsStoreDriver {
  return {
    async recordRunMetrics() {},
    async recordWorkerHeartbeat() {},
  }
}

export class FileMetricsStoreDriver implements MetricsStoreDriver {
  private readonly runMetricsPath: string
  private readonly workerHeartbeatsPath: string

  constructor(private readonly root: string) {
    this.runMetricsPath = path.join(root, "run-metrics.jsonl")
    this.workerHeartbeatsPath = path.join(root, "worker-heartbeats.jsonl")
  }

  async recordRunMetrics(record: MetricsRunRecord) {
    await mkdir(this.root, { recursive: true })
    await appendFile(
      this.runMetricsPath,
      `${JSON.stringify({
        ...record,
        recordedAt: record.recordedAt ?? Date.now(),
      })}\n`,
      "utf8",
    )
  }

  async recordWorkerHeartbeat(heartbeat: RunnerWorkerHeartbeat) {
    await mkdir(this.root, { recursive: true })
    await appendFile(this.workerHeartbeatsPath, `${JSON.stringify(heartbeat)}\n`, "utf8")
  }
}

export function createFileResearchRuntime(root: string): FileResearchRuntime {
  return {
    queue: new FileResearchQueueDriver(path.join(root, "queue")),
    artifactStore: new FileArtifactStoreDriver(path.join(root, "artifacts")),
    metricsStore: new FileMetricsStoreDriver(path.join(root, "metrics")),
  }
}
