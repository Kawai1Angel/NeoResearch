import { EOL } from "os"
import { Locale } from "@/util"
import type { Research } from "@/research"
import type { ResearchWorkerOnceResult } from "@/research/runtime"

export type ResearchOutputFormat = "table" | "json"

export type TsfResearchTaskDefaults = {
  datasetPath?: string
  datasetPreset?: string
  targetCols?: string[]
  contextLength?: number
  predictionLengths?: number[]
  bridgeOnly?: boolean
}

function nonEmpty(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

function tsfTaskSpec(input: TsfResearchTaskDefaults & { neoCastProjectRoot?: string }): Research.JsonRecord {
  const root = nonEmpty(input.neoCastProjectRoot)
  const datasetPath = nonEmpty(input.datasetPath)
  return {
    contextLength: input.contextLength ?? 96,
    predictionLengths: input.predictionLengths && input.predictionLengths.length > 0 ? input.predictionLengths : [24],
    dataset: {
      loaderID: nonEmpty(input.datasetPreset) ?? "etth1_tslib_v1",
      ...(datasetPath ? { path: datasetPath } : {}),
      targetCols: input.targetCols && input.targetCols.length > 0 ? input.targetCols : ["OT"],
    },
    runtime: {
      bridgeOnly: input.bridgeOnly ?? true,
      ...(root ? { neoCastProjectRoot: root } : {}),
    },
  }
}

export function buildDefaultTsfResearchTaskInput(input: {
  mode: Research.ResearchMode
  title?: string
  neoCastProjectRoot?: string
} & TsfResearchTaskDefaults): Research.CreateTaskInput {
  return {
    title: input.title ?? (input.mode === "review" ? "TSF Review Research" : "TSF Autonomous Research"),
    domainID: "tsf",
    mode: input.mode,
    taskSpec: tsfTaskSpec(input),
    objective: {
      primaryMetric: "val_avg_mse",
      direction: "minimize",
    },
    budget: {
      maxRuns: 12,
      maxParallel: 1,
    },
  } as Research.CreateTaskInput
}

function pad(value: string, width: number) {
  return value.length >= width ? value : value + " ".repeat(width - value.length)
}

function table(headers: string[], rows: string[][]) {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)))
  const header = headers.map((value, index) => pad(value, widths[index]!)).join("  ")
  const divider = "─".repeat(header.length)
  return [header, divider, ...rows.map((row) => row.map((value, index) => pad(value, widths[index]!)).join("  "))].join(
    EOL,
  )
}

export function formatResearchTasksTable(tasks: Research.ResearchTask[]) {
  if (tasks.length === 0) return "No research tasks"
  return table(
    ["Task ID", "Title", "Domain", "Mode", "Status", "Updated"],
    tasks.map((task) => [
      task.id,
      Locale.truncate(task.title, 42),
      task.domainID,
      task.mode,
      task.status,
      Locale.todayTimeOrDateTime(task.time.updated),
    ]),
  )
}

export function formatResearchApprovalsTable(approvals: Research.ResearchApproval[]) {
  if (approvals.length === 0) return "No research approvals"
  return table(
    ["Approval ID", "Candidate ID", "Kind", "Status", "Updated", "Reason"],
    approvals.map((approval) => [
      approval.id,
      approval.candidateID ?? "-",
      approval.kind,
      approval.status,
      Locale.todayTimeOrDateTime(approval.time.updated),
      Locale.truncate(approval.reason, 48),
    ]),
  )
}

export function formatResearchArtifactsTable(artifacts: Research.ResearchArtifact[]) {
  if (artifacts.length === 0) return "No research artifacts"
  return table(
    ["Artifact ID", "Kind", "Run ID", "Updated", "Summary", "URI"],
    artifacts.map((artifact) => [
      artifact.id,
      artifact.kind,
      artifact.runID ?? "-",
      Locale.todayTimeOrDateTime(artifact.time.updated),
      Locale.truncate(artifactMetadataSummary(artifact) ?? "-", 72),
      Locale.truncate(artifact.uri, 56),
    ]),
  )
}

export function formatResearchMemoryTable(memory: Research.ResearchMemory[]) {
  if (memory.length === 0) return "No research memory"
  return table(
    ["Memory ID", "Outcome", "Updated", "Lesson"],
    memory.map((item) => [
      item.id,
      item.outcome,
      Locale.todayTimeOrDateTime(item.time.updated),
      Locale.truncate(item.lesson, 64),
    ]),
  )
}

export function formatResearchExport(input: Research.ExportTaskArtifactResult) {
  return [
    `Exported ${input.artifact.kind}`,
    `Artifact ID: ${input.artifact.id}`,
    `Task ID: ${input.artifact.taskID}`,
    `Path: ${input.path}`,
  ].join(EOL)
}

function compactValue(value: unknown) {
  if (typeof value !== "number") return undefined
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)))
}

function metadataString(metadata: Research.JsonRecord, key: string) {
  const value = metadata[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function artifactMetadataSummary(artifact: Research.ResearchArtifact) {
  let parts: Array<string | undefined> = []
  if (artifact.kind === "research_report_markdown") {
    const metric = metadataString(artifact.metadata, "primaryMetricName")
    const runs = compactValue(artifact.metadata.evaluatedRunCount)
    const multiSeed = compactValue(artifact.metadata.multiSeedCandidateCount)
    const utility = compactValue(artifact.metadata.utilityCandidateCount)
    const pareto = compactValue(artifact.metadata.paretoFrontierCount)
    parts = [
      metric ? `metric=${metric}` : undefined,
      runs ? `runs=${runs}` : undefined,
      multiSeed ? `multi_seed=${multiSeed}` : undefined,
      utility ? `utility=${utility}` : undefined,
      pareto ? `pareto=${pareto}` : undefined,
    ]
  } else if (artifact.kind === "research_candidate_selection_json") {
    const ranker = metadataString(artifact.metadata, "rankPredictorVersion")
    const source = metadataString(artifact.metadata, "selectionSource")
    const rankingCount = compactValue(artifact.metadata.rankingCount)
    const topScore = compactValue(artifact.metadata.topScore)
    const taskMemory = compactValue(artifact.metadata.historyTaskMemoryCount)
    const domainMemory = compactValue(artifact.metadata.historyDomainMemoryCount)
    parts = [
      ranker ? `ranker=${ranker}` : undefined,
      taskMemory && taskMemory !== "0" ? `task_memory=${taskMemory}` : undefined,
      domainMemory && domainMemory !== "0" ? `domain_memory=${domainMemory}` : undefined,
      source ? `source=${source}` : undefined,
      rankingCount ? `rankings=${rankingCount}` : undefined,
      topScore ? `top=${topScore}` : undefined,
    ]
  } else if (artifact.kind === "runner_plan_json") {
    const runnerID = metadataString(artifact.metadata, "runnerID")
    const runnerKind = metadataString(artifact.metadata, "runnerKind")
    const stage = metadataString(artifact.metadata, "stage")
    const candidateID = metadataString(artifact.metadata, "candidateID")
    parts = [
      runnerID ? `runner=${runnerID}` : undefined,
      candidateID ? `candidate=${candidateID}` : undefined,
      runnerKind ? `kind=${runnerKind}` : undefined,
      stage ? `stage=${stage}` : undefined,
    ]
  } else if (artifact.kind === "runner_execution_log_json") {
    const runnerID = metadataString(artifact.metadata, "runnerID")
    const stage = metadataString(artifact.metadata, "stage")
    const exitCode = compactValue(artifact.metadata.exitCode)
    const recordCount = compactValue(artifact.metadata.recordCount)
    parts = [
      runnerID ? `runner=${runnerID}` : undefined,
      exitCode ? `exit=${exitCode}` : undefined,
      recordCount ? `records=${recordCount}` : undefined,
      stage ? `stage=${stage}` : undefined,
    ]
  } else if (artifact.kind === "task_profile_json") {
    const source = metadataString(artifact.metadata, "profileSource")
    const profileWarning = metadataString(artifact.metadata, "profileWarningCode")
    const hasDatasetProfile =
      typeof artifact.metadata.hasDatasetProfile === "boolean"
        ? `dataset_profile=${artifact.metadata.hasDatasetProfile ? "yes" : "no"}`
        : undefined
    parts = [
      source ? `source=${source}` : undefined,
      hasDatasetProfile,
      profileWarning ? `warning=${profileWarning}` : undefined,
    ]
  } else if (artifact.kind === "governance_log_json") {
    const approvalKind = metadataString(artifact.metadata, "kind")
    const status = metadataString(artifact.metadata, "status")
    const candidateID = metadataString(artifact.metadata, "candidateID")
    parts = [
      approvalKind ? `approval=${approvalKind}` : undefined,
      status ? `status=${status}` : undefined,
      candidateID ? `candidate=${candidateID}` : undefined,
    ]
  }
  parts = parts.filter((item): item is string => Boolean(item))
  return parts.length > 0 ? parts.join(" / ") : undefined
}

function profileSummary(fingerprint: Research.JsonRecord) {
  const value = fingerprint.datasetProfile
  if (!value || typeof value !== "object" || Array.isArray(value)) return "-"
  const profile = value as Research.JsonRecord
  const parts = [
    compactValue(profile.rowCount) ? `rows=${compactValue(profile.rowCount)}` : undefined,
    compactValue(profile.targetCount) ? `targets=${compactValue(profile.targetCount)}` : undefined,
    compactValue(profile.missingRate) ? `missing=${compactValue(profile.missingRate)}` : undefined,
    compactValue(profile.trendStrength) ? `trend=${compactValue(profile.trendStrength)}` : undefined,
    compactValue(profile.seasonalityStrength) ? `seasonal=${compactValue(profile.seasonalityStrength)}` : undefined,
    compactValue(profile.crossVarCorrelation) ? `xcorr=${compactValue(profile.crossVarCorrelation)}` : undefined,
    compactValue(profile.distributionShift) ? `shift=${compactValue(profile.distributionShift)}` : undefined,
  ].filter((item): item is string => Boolean(item))
  return parts.length === 0 ? "-" : parts.join(" / ")
}

export function formatResearchProfile(input: Research.ProfileTaskResult) {
  return [
    `Profile ${input.artifact.kind}`,
    `Run ID: ${input.run.id}`,
    `Artifact ID: ${input.artifact.id}`,
    `Task ID: ${input.artifact.taskID}`,
    `Path: ${input.path}`,
    `Dataset: ${profileSummary(input.fingerprint)}`,
  ].join(EOL)
}

function formatMetricValue(value: unknown) {
  if (typeof value !== "number") return JSON.stringify(value)
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)))
}

function metricsSummary(metrics: Research.JsonRecord) {
  const entries = Object.entries(metrics)
  if (entries.length === 0) return "-"
  return entries.map(([key, value]) => `${key}=${formatMetricValue(value)}`).join(", ")
}

export function formatResearchRunResult(input: { run: Research.ResearchRun }) {
  return [
    `Run ${input.run.id} ${input.run.status}`,
    `Candidate ID: ${input.run.candidateID ?? "-"}`,
    `Stage: ${input.run.stage}`,
    `Metrics: ${metricsSummary(input.run.metrics)}`,
  ].join(EOL)
}

export function formatResearchWorkerOnce(input: ResearchWorkerOnceResult) {
  if (input.status === "idle") return "Research worker idle"
  const lines = [`Research worker ${input.status}`, `Job ID: ${input.jobID}`]
  if (input.status === "completed") {
    lines.push(`Artifacts: ${input.artifactURIs.length === 0 ? "-" : input.artifactURIs.join(", ")}`)
  } else if (input.status === "retry_scheduled") {
    lines.push(`Retry At: ${new Date(input.retryAt).toISOString()}`)
    lines.push(`Error: ${input.error}`)
  } else {
    lines.push(`Reason: ${input.reason}`)
    lines.push(`Error: ${input.error}`)
  }
  return lines.join(EOL)
}

export function formatResearchWorkerLoop(input: {
  readonly status: string
  readonly workerID: string
  readonly iterations: number
  readonly completed: number
  readonly retryScheduled: number
  readonly deadLettered: number
}) {
  return [
    `Research worker loop ${input.status}`,
    `Worker ID: ${input.workerID}`,
    `Iterations: ${input.iterations}`,
    `Completed: ${input.completed}`,
    `Retry scheduled: ${input.retryScheduled}`,
    `Dead lettered: ${input.deadLettered}`,
  ].join(EOL)
}

export function formatResearchSeedSweep(input: {
  seeds: readonly number[]
  runs: ReadonlyArray<{ run: Research.ResearchRun }>
}) {
  const succeeded = input.runs.filter((item) => item.run.status === "succeeded").length
  const failed = input.runs.filter((item) => item.run.status === "failed").length
  const rows = input.runs.map((item) => {
    const seed = item.run.resourceUsage.seed
    return `- ${item.run.id}: ${item.run.status} ${item.run.stage} seed=${typeof seed === "number" ? seed : "-"} ${metricsSummary(item.run.metrics)}`
  })
  return [
    `Seed sweep ${input.runs.length} runs`,
    `Seeds: ${input.seeds.join(", ")}`,
    `Succeeded: ${succeeded}`,
    `Failed: ${failed}`,
    ...rows,
  ].join(EOL)
}

export function formatResearchAutonomousIteration(input: {
  run: Research.ResearchRun
  candidate: Research.ResearchCandidate
  seededCandidates: Research.ResearchCandidate[]
  approvals: Research.ResearchApproval[]
  managerTrace?: Array<{ role: string }>
  selectionArtifact?: Research.ResearchArtifact
}) {
  const managerRoles = input.managerTrace?.map((step) => step.role).join(" > ")
  return [
    `Autonomous iteration ${input.run.status}`,
    `Candidate ID: ${input.candidate.id}`,
    `Run ID: ${input.run.id}`,
    `Metrics: ${metricsSummary(input.run.metrics)}`,
    `Seeded candidates: ${input.seededCandidates.length}`,
    `Approvals: ${input.approvals.length}`,
    input.selectionArtifact ? `Selection artifact: ${input.selectionArtifact.id}` : undefined,
    managerRoles ? `Research manager: ${managerRoles}` : undefined,
  ]
    .filter((item): item is string => Boolean(item))
    .join(EOL)
}

export function formatResearchAutonomousLoop(input: {
  stoppedReason: string
  iterations: Array<{
    run: Research.ResearchRun
    candidate: Research.ResearchCandidate
    seededCandidates: Research.ResearchCandidate[]
    approvals: Research.ResearchApproval[]
  }>
  artifact?: Research.ResearchArtifact
}) {
  const succeeded = input.iterations.filter((iteration) => iteration.run.status === "succeeded").length
  const failed = input.iterations.filter((iteration) => iteration.run.status === "failed").length
  const approvals = input.iterations.reduce((total, iteration) => total + iteration.approvals.length, 0)
  const last = input.iterations.at(-1)
  return [
    `Autonomous loop ${input.stoppedReason}`,
    `Iterations: ${input.iterations.length}`,
    `Succeeded: ${succeeded}`,
    `Failed: ${failed}`,
    `Last candidate: ${last?.candidate.id ?? "-"}`,
    `Last run: ${last?.run.id ?? "-"}`,
    `Approvals: ${approvals}`,
    input.artifact ? `Loop artifact: ${input.artifact.id}` : undefined,
  ]
    .filter((item): item is string => Boolean(item))
    .join(EOL)
}

function metricText(run: Research.ResearchRun | undefined, primaryMetric: unknown) {
  if (!run) return undefined
  const metric = typeof primaryMetric === "string" ? primaryMetric : "val_avg_mse"
  const value = run.metrics[metric]
  if (typeof value === "number") return `${metric}=${Number.isInteger(value) ? value : Number(value.toPrecision(6))}`
  return undefined
}

export function formatResearchStatus(input: {
  task: Research.ResearchTask
  candidates: Research.ResearchCandidate[]
  runs: Research.ResearchRun[]
  approvals: Research.ResearchApproval[]
  artifacts: Research.ResearchArtifact[]
  memory: Research.ResearchMemory[]
  champion?: Research.ResearchChampion | null
}) {
  const pending = input.approvals.filter((approval) => approval.status === "pending").length
  const latestRun = input.runs[0]
  const latestMemory = input.memory[0]
  const primaryMetric = input.task.objective.primaryMetric
  const metric = metricText(latestRun, primaryMetric)
  const lines = [
    `${input.task.title} (${input.task.id})`,
    `Domain: ${input.task.domainID}`,
    `Mode: ${input.task.mode}`,
    `Status: ${input.task.status}`,
    `Candidates: ${input.candidates.length}`,
    `Runs: ${input.runs.length}`,
    `Artifacts: ${input.artifacts.length}`,
    `Memory: ${input.memory.length}`,
    `Pending approvals: ${pending}`,
  ]
  if (latestRun) lines.push(`Latest run: ${latestRun.status}${metric ? ` ${metric}` : ""}`)
  if (latestMemory) lines.push(`Latest memory: ${latestMemory.outcome} ${latestMemory.lesson}`)
  if (input.champion) {
    lines.push(`Champion: ${input.champion.candidateID} metric=${input.champion.primaryMetric}`)
  } else {
    lines.push("Champion: -")
  }
  return lines.join(EOL)
}
