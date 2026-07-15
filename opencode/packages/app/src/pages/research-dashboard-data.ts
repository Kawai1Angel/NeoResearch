export type JsonRecord = Record<string, unknown>

export type ResearchMode = "review" | "autonomous"
export type ResearchTaskStatus =
  | "created"
  | "profiling"
  | "baselining"
  | "researching"
  | "paused"
  | "completed"
  | "failed"
export type ResearchRunStage = "profile" | "baseline" | "smoke" | "low_fidelity" | "full" | "ref_test" | "blind_test"
export type ResearchRunStatus = "queued" | "running" | "succeeded" | "failed" | "rejected"
export type CandidateRiskLevel = "low" | "medium" | "high"
export type CandidateApprovalStatus = "pending" | "approved" | "auto_approved" | "rejected"
export type CandidateGenerator = "llm" | "heuristic" | "mutation" | "human"
export type ApprovalKind =
  | "candidate"
  | "ref_test"
  | "blind_test"
  | "shadow_holdout"
  | "budget"
  | "protocol"
  | "domain_action"
export type ApprovalStatus = "pending" | "approved" | "rejected"

export type ResearchTime = {
  created: number
  updated: number
}

export type ResearchTask = {
  id: string
  projectID: string
  sessionID?: string
  title: string
  domainID: string
  mode: ResearchMode
  status: ResearchTaskStatus
  taskSpec: JsonRecord
  objective: JsonRecord
  budget: JsonRecord
  time: ResearchTime
}

export type ResearchCandidate = {
  id: string
  taskID: string
  parentCandidateID?: string
  domainID: string
  candidateSpec: JsonRecord
  rationale: string
  riskLevel: CandidateRiskLevel
  approvalStatus: CandidateApprovalStatus
  generatedBy: CandidateGenerator
  time: ResearchTime
}

export type ResearchRun = {
  id: string
  taskID: string
  candidateID?: string
  stage: ResearchRunStage
  status: ResearchRunStatus
  metrics: JsonRecord
  resourceUsage: JsonRecord
  artifactRefs: string[]
  error?: string
  time: ResearchTime
  timeStarted?: number
  timeFinished?: number
}

export type ResearchApproval = {
  id: string
  taskID: string
  candidateID?: string
  kind: ApprovalKind
  status: ApprovalStatus
  reason: string
  replyMessage?: string
  time: ResearchTime
  timeReplied?: number
}

export type ResearchChampion = {
  taskID: string
  candidateID: string
  runID: string
  primaryMetric: number
  utility: number
  acceptedAt: number
  time: ResearchTime
}

export type ResearchMemory = {
  id: string
  taskID: string
  domainID: string
  fingerprintSummary: JsonRecord
  candidateSummary: JsonRecord
  outcome: "accepted" | "rejected" | "failed"
  lesson: string
  time: ResearchTime
}

export type ResearchArtifact = {
  id: string
  taskID: string
  runID?: string
  kind: string
  uri: string
  metadata: JsonRecord
  time: ResearchTime
}

export type ResearchExportArtifactResult = {
  artifact: ResearchArtifact
  path: string
}

export type ResearchProfileResult = {
  fingerprint: JsonRecord
  run: ResearchRun
  artifact: ResearchArtifact
  path: string
}

export type ResearchManagerStep = {
  role: "diagnostic" | "design" | "coder" | "runner" | "analyst" | "librarian"
  status: "completed" | "skipped" | "blocked"
  summary: string
  metadata: JsonRecord
}

export type ResearchLoopResult = {
  stoppedReason: string
  iterations: Array<{
    candidate: ResearchCandidate
    seededCandidates: ResearchCandidate[]
    approvals: ResearchApproval[]
    run: ResearchRun
    managerTrace?: ResearchManagerStep[]
    selectionArtifact?: ResearchArtifact
  }>
  artifact?: ResearchArtifact
}

export type ResearchSeedSweepResult = {
  seeds: number[]
  runs: Array<{ run: ResearchRun }>
}

const researchRefreshEventTypes = new Set([
  "research.task.created",
  "research.task.updated",
  "research.candidate.created",
  "research.candidate.updated",
  "research.run.created",
  "research.run.updated",
  "research.artifact.created",
  "research.memory.created",
  "research.champion.updated",
  "research.approval.created",
  "research.approval.updated",
])

export function shouldRefreshResearchDashboardOnEvent(event: { type: string }) {
  return researchRefreshEventTypes.has(event.type)
}

export type CreateResearchTaskInput = {
  title: string
  domainID: string
  mode: ResearchMode
  taskSpec: JsonRecord
  objective: JsonRecord
  budget: JsonRecord
}

export type TsfTaskInputOptions = {
  datasetPath?: string
  datasetPreset?: string
  targetCols?: string[]
  contextLength?: number
  predictionLengths?: number[]
  bridgeOnly?: boolean
}

export type ResearchDashboardStatsInput = {
  tasks: ResearchTask[]
  candidates: ResearchCandidate[]
  runs: ResearchRun[]
  approvals: ResearchApproval[]
  artifacts: ResearchArtifact[]
  memoryCount: number
}

export type ResearchDashboardStats = {
  totalTasks: number
  activeTasks: number
  candidateCount: number
  pendingApprovals: number
  runningRuns: number
  succeededRuns: number
  artifactCount: number
  memoryCount: number
}

export function sortResearchTasks(tasks: ResearchTask[]) {
  return tasks.slice().sort((a, b) => b.time.updated - a.time.updated || b.time.created - a.time.created)
}

export function buildResearchDashboardStats(input: ResearchDashboardStatsInput): ResearchDashboardStats {
  return {
    totalTasks: input.tasks.length,
    activeTasks: input.tasks.filter((task) => !["completed", "failed", "paused"].includes(task.status)).length,
    candidateCount: input.candidates.length,
    pendingApprovals: input.approvals.filter((approval) => approval.status === "pending").length,
    runningRuns: input.runs.filter((run) => run.status === "running" || run.status === "queued").length,
    succeededRuns: input.runs.filter((run) => run.status === "succeeded").length,
    artifactCount: input.artifacts.length,
    memoryCount: input.memoryCount,
  }
}

export function formatResearchArtifactTarget(artifact: ResearchArtifact) {
  return artifact.uri.startsWith("file://") ? artifact.uri.slice("file://".length) : artifact.uri
}

export function formatResearchArtifactMetadataSummary(artifact: ResearchArtifact) {
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
      source ? `source=${source}` : undefined,
      rankingCount ? `rankings=${rankingCount}` : undefined,
      topScore ? `top=${topScore}` : undefined,
      taskMemory && taskMemory !== "0" ? `task_memory=${taskMemory}` : undefined,
      domainMemory && domainMemory !== "0" ? `domain_memory=${domainMemory}` : undefined,
    ]
  } else if (artifact.kind === "research_manager_trace_json") {
    const stage = metadataString(artifact.metadata, "stage")
    const status = metadataString(artifact.metadata, "status")
    parts = [
      stage ? `stage=${stage}` : undefined,
      status ? `status=${status}` : undefined,
      managerRolesSummary(artifact.metadata),
    ]
  } else if (artifact.kind === "runner_plan_json") {
    const runnerID = metadataString(artifact.metadata, "runnerID")
    const runnerKind = metadataString(artifact.metadata, "runnerKind")
    const stage = metadataString(artifact.metadata, "stage")
    const candidateID = metadataString(artifact.metadata, "candidateID")
    parts = [
      runnerID ? `runner=${runnerID}` : undefined,
      runnerKind ? `kind=${runnerKind}` : undefined,
      stage ? `stage=${stage}` : undefined,
      candidateID ? `candidate=${candidateID}` : undefined,
    ]
  } else if (artifact.kind === "runner_execution_log_json") {
    const runnerID = metadataString(artifact.metadata, "runnerID")
    const stage = metadataString(artifact.metadata, "stage")
    const exitCode = compactValue(artifact.metadata.exitCode)
    const recordCount = compactValue(artifact.metadata.recordCount)
    parts = [
      runnerID ? `runner=${runnerID}` : undefined,
      stage ? `stage=${stage}` : undefined,
      exitCode ? `exit=${exitCode}` : undefined,
      recordCount ? `records=${recordCount}` : undefined,
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
  } else {
    return undefined
  }
  parts = parts.filter((item): item is string => Boolean(item))
  return parts.length > 0 ? parts.join(" / ") : undefined
}

export function formatResearchMemorySummary(memory: ResearchMemory) {
  return `${memory.outcome}: ${memory.lesson}`
}

function compactValue(value: unknown) {
  if (typeof value !== "number") return undefined
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)))
}

function metadataString(metadata: JsonRecord, key: string) {
  const value = metadata[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function managerRolesSummary(metadata: JsonRecord) {
  const roleCount = compactValue(metadata.roleCount)
  const roles = Array.isArray(metadata.roles)
    ? metadata.roles.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []
  if (roleCount && roles.length > 0) return `roles=${roleCount} ${roles.join(">")}`
  if (roleCount) return `roles=${roleCount}`
  if (roles.length > 0) return `roles=${roles.join(">")}`
  return undefined
}

export function formatResearchFingerprint(fingerprint: JsonRecord) {
  const loaderID = typeof fingerprint.loaderID === "string" ? fingerprint.loaderID : undefined
  const targetCount = compactValue(fingerprint.targetCount)
  const contextLength = compactValue(fingerprint.contextLength)
  const maxPredictionLength = compactValue(fingerprint.maxPredictionLength)
  const horizonContextRatio = compactValue(fingerprint.horizonContextRatio)
  const runtime = typeof fingerprint.bridgeOnly === "boolean" ? (fingerprint.bridgeOnly ? "bridge" : "full") : undefined
  const parts = [
    loaderID,
    targetCount ? `targets=${targetCount}` : undefined,
    contextLength ? `ctx=${contextLength}` : undefined,
    maxPredictionLength ? `horizon=${maxPredictionLength}` : undefined,
    horizonContextRatio ? `h:c=${horizonContextRatio}` : undefined,
    runtime,
  ].filter((item): item is string => Boolean(item))
  return parts.length === 0 ? "-" : parts.join(" / ")
}

export function formatResearchMemoryFingerprint(memory: ResearchMemory) {
  return formatResearchFingerprint(memory.fingerprintSummary)
}

function profileRecord(fingerprint: JsonRecord) {
  const value = fingerprint.datasetProfile
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as JsonRecord
}

function profileWarningRecord(fingerprint: JsonRecord) {
  const value = fingerprint.datasetProfileWarning
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as JsonRecord
}

export function formatResearchProfileSummary(fingerprint: JsonRecord) {
  const profile = profileRecord(fingerprint)
  if (!profile) {
    const warning = metadataString(profileWarningRecord(fingerprint) ?? {}, "code")
    return warning ? `warning=${warning}` : "-"
  }
  const rowCount = compactValue(profile.rowCount)
  const targetCount = compactValue(profile.targetCount)
  const missingRate = compactValue(profile.missingRate)
  const trendStrength = compactValue(profile.trendStrength)
  const seasonalityStrength = compactValue(profile.seasonalityStrength)
  const crossVarCorrelation = compactValue(profile.crossVarCorrelation)
  const distributionShift = compactValue(profile.distributionShift)
  const parts = [
    rowCount ? `rows=${rowCount}` : undefined,
    targetCount ? `targets=${targetCount}` : undefined,
    missingRate ? `missing=${missingRate}` : undefined,
    trendStrength ? `trend=${trendStrength}` : undefined,
    seasonalityStrength ? `seasonal=${seasonalityStrength}` : undefined,
    crossVarCorrelation ? `xcorr=${crossVarCorrelation}` : undefined,
    distributionShift ? `shift=${distributionShift}` : undefined,
  ].filter((item): item is string => Boolean(item))
  return parts.length === 0 ? "-" : parts.join(" / ")
}

export function canExecuteResearchTask(task: ResearchTask | undefined) {
  const runtime = task?.taskSpec.runtime
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return false
  const root = (runtime as Record<string, unknown>).neoCastProjectRoot
  return typeof root === "string" && root.trim().length > 0
}

export function hasApprovedResearchRefTestGate(approvals: ResearchApproval[], candidateID: string) {
  return hasApprovedResearchApprovalGate(approvals, candidateID, "ref_test")
}

export function hasApprovedResearchBlindTestGate(approvals: ResearchApproval[], candidateID: string) {
  return hasApprovedResearchApprovalGate(approvals, candidateID, "blind_test")
}

export function hasApprovedResearchApprovalGate(
  approvals: ResearchApproval[],
  candidateID: string,
  kind: ResearchApproval["kind"],
) {
  return approvals.some(
    (approval) => approval.candidateID === candidateID && approval.kind === kind && approval.status === "approved",
  )
}

export function formatResearchExportNotice(result: ResearchExportArtifactResult) {
  return `${result.artifact.kind} exported to ${result.path}`
}

export function formatResearchLoopNotice(result: ResearchLoopResult) {
  const succeeded = result.iterations.filter((iteration) => iteration.run.status === "succeeded").length
  const artifact = result.artifact ? `, artifact ${result.artifact.kind}` : ""
  return `loop ${result.stoppedReason}: ${result.iterations.length} iterations, ${succeeded} succeeded${artifact}`
}

export function formatResearchSeedSweepNotice(result: ResearchSeedSweepResult) {
  const succeeded = result.runs.filter((item) => item.run.status === "succeeded").length
  return `seed sweep: ${result.runs.length} runs, ${succeeded} succeeded, seeds ${result.seeds.join(", ")}`
}

function nonEmpty(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

function tsfRuntime(neoCastProjectRoot: string | undefined, options: TsfTaskInputOptions): JsonRecord {
  const root = neoCastProjectRoot?.trim()
  return {
    bridgeOnly: options.bridgeOnly ?? true,
    ...(root ? { neoCastProjectRoot: root } : {}),
  }
}

export function buildDefaultTsfTaskInput(
  mode: ResearchMode,
  neoCastProjectRoot?: string,
  options: TsfTaskInputOptions = {},
): CreateResearchTaskInput {
  const title = mode === "review" ? "TSF Review Research" : "TSF Autonomous Research"
  const datasetPath = nonEmpty(options.datasetPath)
  return {
    title,
    domainID: "tsf",
    mode,
    taskSpec: {
      contextLength: options.contextLength ?? 96,
      predictionLengths:
        options.predictionLengths && options.predictionLengths.length > 0 ? options.predictionLengths : [24],
      dataset: {
        loaderID: nonEmpty(options.datasetPreset) ?? "etth1_tslib_v1",
        ...(datasetPath ? { path: datasetPath } : {}),
        targetCols: options.targetCols && options.targetCols.length > 0 ? options.targetCols : ["OT"],
      },
      runtime: tsfRuntime(neoCastProjectRoot, options),
    },
    objective: {
      primaryMetric: "val_avg_mse",
      direction: "minimize",
    },
    budget: {
      maxRuns: 100,
      maxParallel: 1,
      parameterBudget: "prefer lightweight models under 20M parameters when accuracy is close",
    },
  }
}
