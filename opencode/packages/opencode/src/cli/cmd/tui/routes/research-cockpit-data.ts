import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"

export type JsonRecord = Record<string, unknown>

export type ResearchCockpitTask = {
  id: string
  title: string
  domainID: string
  mode: "review" | "autonomous"
  status: "created" | "profiling" | "baselining" | "researching" | "paused" | "completed" | "failed"
  taskSpec: JsonRecord
  objective: JsonRecord
  budget: JsonRecord
  time: {
    created: number
    updated: number
  }
}

export type ResearchCockpitRun = {
  id: string
  candidateID?: string
  stage?: "profile" | "baseline" | "smoke" | "low_fidelity" | "full" | "ref_test" | "blind_test"
  status: "queued" | "running" | "succeeded" | "failed" | "rejected"
  metrics: JsonRecord
  error?: string
  resourceUsage?: JsonRecord
  time: {
    created: number
    updated: number
  }
}

export type ResearchCockpitCandidate = {
  id: string
  taskID: string
  domainID: string
  candidateSpec: JsonRecord
  rationale: string
  riskLevel: "low" | "medium" | "high"
  approvalStatus: "pending" | "approved" | "auto_approved" | "rejected"
  generatedBy: "llm" | "heuristic" | "mutation" | "human"
  time: {
    created: number
    updated: number
  }
}

export type ResearchCockpitApproval = {
  id: string
  candidateID?: string
  kind: "candidate" | "ref_test" | "blind_test" | "shadow_holdout" | "budget" | "protocol" | "domain_action"
  status: "pending" | "approved" | "rejected"
  reason: string
  time: {
    created: number
    updated: number
  }
}

export type ResearchCockpitChampion = {
  taskID: string
  candidateID: string
  runID: string
  primaryMetric: number
  utility: number
  acceptedAt: number
  time: {
    created: number
    updated: number
  }
}

export type ResearchCockpitArtifact = {
  id: string
  taskID: string
  runID?: string
  kind: string
  uri: string
  metadata: JsonRecord
  time: {
    created: number
    updated: number
  }
}

export type ResearchCockpitMemory = {
  id: string
  taskID: string
  domainID: string
  fingerprintSummary: JsonRecord
  candidateSummary: JsonRecord
  outcome: "accepted" | "rejected" | "failed"
  lesson: string
  time: {
    created: number
    updated: number
  }
}

export type ResearchCockpitExportResult = {
  artifact: ResearchCockpitArtifact
  path: string
}

export type ResearchCockpitProfileResult = {
  fingerprint: JsonRecord
  run: ResearchCockpitRun
  artifact: ResearchCockpitArtifact
  path: string
}

export type ResearchCockpitManagerStep = {
  role: "diagnostic" | "design" | "coder" | "runner" | "analyst" | "librarian"
  status: "completed" | "skipped" | "blocked"
  summary: string
  metadata: JsonRecord
}

export type ResearchCockpitIterationResult = {
  candidate: ResearchCockpitCandidate
  seededCandidates: ResearchCockpitCandidate[]
  approvals: ResearchCockpitApproval[]
  run: ResearchCockpitRun
  managerTrace?: ResearchCockpitManagerStep[]
  selectionArtifact?: ResearchCockpitArtifact
}

export type ResearchCockpitLoopResult = {
  iterations: ResearchCockpitIterationResult[]
  stoppedReason: string
  artifact?: ResearchCockpitArtifact
}

export type ResearchCockpitSeedSweepResult = {
  seeds: number[]
  runs: Array<{ run: ResearchCockpitRun }>
}

export type CreateResearchTaskInput = {
  title: string
  domainID: string
  mode: ResearchCockpitTask["mode"]
  taskSpec: JsonRecord
  objective: JsonRecord
  budget: JsonRecord
}

export type ResearchCockpitWorkflowStatus = "done" | "active" | "todo"

export type ResearchCockpitWorkflowItem = {
  label: string
  status: ResearchCockpitWorkflowStatus
  detail?: string
}

export type ResearchCockpitRecommendation = {
  action:
    | "create_task"
    | "approve_gate"
    | "configure_runner"
    | "profile"
    | "seed_baselines"
    | "run_autonomous_loop"
    | "run_smoke"
    | "export_report"
    | "review_state"
  title: string
  detail: string
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

export function shouldRefreshResearchCockpitOnEvent(event: { type: string }) {
  return researchRefreshEventTypes.has(event.type)
}

export function sortResearchCockpitTasks(tasks: ResearchCockpitTask[]) {
  return tasks.slice().sort((a, b) => b.time.updated - a.time.updated || b.time.created - a.time.created)
}

export function buildResearchCockpitStats(input: {
  tasks: ResearchCockpitTask[]
  candidates: ResearchCockpitCandidate[]
  artifacts: ResearchCockpitArtifact[]
  memory: ResearchCockpitMemory[]
  runs: ResearchCockpitRun[]
  approvals: ResearchCockpitApproval[]
}) {
  return {
    taskTotal: input.tasks.length,
    activeTasks: input.tasks.filter((task) => !["completed", "failed", "paused"].includes(task.status)).length,
    candidateCount: input.candidates.length,
    artifactCount: input.artifacts.length,
    memoryCount: input.memory.length,
    pendingApprovals: input.approvals.filter((approval) => approval.status === "pending").length,
    queuedOrRunningRuns: input.runs.filter((run) => run.status === "queued" || run.status === "running").length,
    succeededRuns: input.runs.filter((run) => run.status === "succeeded").length,
  }
}

type ResearchCockpitWorkflowInput = {
  task?: ResearchCockpitTask
  candidates: ResearchCockpitCandidate[]
  runs: ResearchCockpitRun[]
  artifacts: ResearchCockpitArtifact[]
  approvals: ResearchCockpitApproval[]
  champion?: ResearchCockpitChampion | null
  fingerprint?: JsonRecord
  runnerReady: boolean
}

export function buildResearchCockpitWorkflow(input: ResearchCockpitWorkflowInput): ResearchCockpitWorkflowItem[] {
  const hasTask = Boolean(input.task)
  const hasProfile = hasCockpitDatasetProfile(input)
  const hasCandidates = input.candidates.length > 0
  const hasSucceededRun = input.runs.some((run) => run.status === "succeeded" && run.stage !== "profile")
  const hasPendingApproval = input.approvals.some((approval) => approval.status === "pending")
  const hasReport = input.artifacts.some((artifact) => artifact.kind === "research_report_markdown")

  return [
    {
      label: "Create research task",
      status: hasTask ? "done" : "active",
      detail: hasTask ? input.task?.title : "Bind a goal, dataset, objective, and execution budget.",
    },
    {
      label: "Profile dataset",
      status: hasProfile ? "done" : hasTask ? "active" : "todo",
      detail: hasProfile ? "Dataset fingerprint available." : "Inspect horizon, targets, missingness, and seasonality.",
    },
    {
      label: "Design candidates",
      status: hasCandidates ? "done" : hasTask ? "active" : "todo",
      detail: hasCandidates ? `${input.candidates.length} candidate recipes` : "Seed baselines or let the agent propose recipes.",
    },
    {
      label: "Run smoke experiments",
      status: hasSucceededRun ? "done" : hasProfile && hasCandidates && input.runnerReady ? "active" : "todo",
      detail: hasSucceededRun ? "At least one non-profile run succeeded." : "Execute approved candidates against the runner.",
    },
    {
      label: "Review gates",
      status: hasPendingApproval ? "active" : hasSucceededRun ? "done" : "todo",
      detail: hasPendingApproval ? "Approval required before promotion." : "Candidate, ref, and blind gates are clear.",
    },
    {
      label: "Export report",
      status: hasReport ? "done" : input.champion || hasSucceededRun ? "active" : "todo",
      detail: hasReport ? "Report artifact available." : "Summarize winner, tradeoffs, and evidence.",
    },
  ]
}

export function buildResearchCockpitRecommendation(input: ResearchCockpitWorkflowInput): ResearchCockpitRecommendation {
  const pendingApproval = input.approvals.find((approval) => approval.status === "pending")
  const hasProfile = hasCockpitDatasetProfile(input)
  const hasCandidates = input.candidates.length > 0
  const hasSucceededRun = input.runs.some((run) => run.status === "succeeded" && run.stage !== "profile")
  const hasReport = input.artifacts.some((artifact) => artifact.kind === "research_report_markdown")
  const runnableCandidate = input.candidates.find(canRunResearchCockpitCandidate)

  if (!input.task) {
    return {
      action: "create_task",
      title: "Create a dataset-backed TSF task",
      detail: "Enter a research goal to create a full-recipe autonomous task, or use New CSV Task to bind a local CSV.",
    }
  }
  if (pendingApproval) {
    return {
      action: "approve_gate",
      title: "Approve pending gate",
      detail: `${pendingApproval.kind} approval is waiting before the next promotion step.`,
    }
  }
  if (!input.runnerReady) {
    return {
      action: "configure_runner",
      title: "Configure Neo-Cast runner",
      detail: "Set taskSpec.runtime.neoCastProjectRoot before executing candidate runs.",
    }
  }
  if (!hasProfile) {
    return {
      action: "profile",
      title: "Profile dataset",
      detail: "Generate the dataset fingerprint before comparing architectures.",
    }
  }
  if (!hasCandidates) {
    return {
      action: "seed_baselines",
      title: "Seed baseline candidates",
      detail: "Create initial recipes so the runner has concrete experiments to evaluate.",
    }
  }
  if (input.task.mode === "autonomous") {
    return {
      action: "run_autonomous_loop",
      title: "Run autonomous loop",
      detail: "Let the manager iterate across design, runner, analyst, and memory steps.",
    }
  }
  if (runnableCandidate) {
    return {
      action: "run_smoke",
      title: "Run smoke execution",
      detail: `Execute ${runnableCandidate.id} and compare the primary metric.`,
    }
  }
  if (hasSucceededRun && !hasReport) {
    return {
      action: "export_report",
      title: "Export research report",
      detail: "Package the latest evidence into a markdown report.",
    }
  }
  return {
    action: "review_state",
    title: "Review latest research state",
    detail: hasReport ? "Inspect the exported report and decide whether to continue." : "No immediate blocking action is pending.",
  }
}

function hasCockpitDatasetProfile(input: Pick<ResearchCockpitWorkflowInput, "artifacts" | "fingerprint">) {
  if (input.artifacts.some((artifact) => artifact.kind === "task_profile_json")) return true
  const fingerprint = input.fingerprint ?? {}
  return Boolean(fingerprint.datasetProfile || fingerprint.datasetProfileWarning)
}

export function researchCockpitArtifactTarget(artifact: ResearchCockpitArtifact) {
  return artifact.uri.startsWith("file://") ? artifact.uri.slice("file://".length) : artifact.uri
}

export function formatResearchCockpitArtifactMetadata(artifact: ResearchCockpitArtifact) {
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

export function formatResearchCockpitMemory(memory: ResearchCockpitMemory) {
  return `${memory.outcome} / ${memory.lesson}`
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

export function formatResearchCockpitFingerprint(fingerprint: JsonRecord) {
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

export function formatResearchCockpitMemoryFingerprint(memory: ResearchCockpitMemory) {
  return formatResearchCockpitFingerprint(memory.fingerprintSummary)
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

export function formatResearchCockpitProfile(fingerprint: JsonRecord) {
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

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

export function researchCockpitCandidateTitle(candidate: ResearchCockpitCandidate) {
  const recipeID = candidate.candidateSpec.recipeID
  return typeof recipeID === "string" && recipeID.length > 0 ? recipeID : candidate.id
}

export function researchCockpitCandidatePipeline(candidate: ResearchCockpitCandidate) {
  const spec = candidate.candidateSpec
  const preprocessing = asRecord(spec.preprocessing).actions
  const preprocessingText = Array.isArray(preprocessing)
    ? preprocessing
        .map((action) => asRecord(action).type)
        .filter((item): item is string => typeof item === "string" && item.length > 0)
        .join("+")
    : undefined
  const embedding = asRecord(spec.embedding).type
  const backbone = asRecord(spec.backbone).type
  const fusion = asRecord(spec.fusion).type
  const head = asRecord(spec.predictionHead).type
  const optimizer = asRecord(asRecord(spec.trainingStrategy).optimizer).type
  return [preprocessingText, embedding, backbone, fusion, head, optimizer]
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .join(" / ")
}

export function canRunResearchCockpitCandidate(candidate: ResearchCockpitCandidate) {
  return candidate.approvalStatus === "approved" || candidate.approvalStatus === "auto_approved"
}

export function updateResearchCockpitTaskRunnerRoot(
  task: ResearchCockpitTask,
  neoCastProjectRoot: string,
): ResearchCockpitTask {
  const root = neoCastProjectRoot.trim()
  const taskSpec = asRecord(task.taskSpec)
  const runtime = asRecord(taskSpec.runtime)
  return {
    ...task,
    taskSpec: {
      ...taskSpec,
      runtime: {
        ...runtime,
        neoCastProjectRoot: root,
      },
    },
  }
}

export type ResearchCockpitRunnerStatus = {
  configured: boolean
  ready: boolean
  root?: string
  pythonExecutable?: string
  reason:
    | "missing_task"
    | "missing_runtime"
    | "missing_root"
    | "missing_root_path"
    | "missing_runner_script"
    | "missing_python"
    | "python_unavailable"
    | "unsupported_python"
    | "ready"
  detail: string
}

type ResearchCockpitRunnerStatusOptions = {
  validateRuntime?: boolean
}

function parsePythonVersion(raw: string) {
  const match = /Python\s+(\d+)\.(\d+)\.(\d+)/.exec(raw)
  if (!match) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw,
  }
}

function isSupportedPythonVersion(raw: string) {
  const version = parsePythonVersion(raw)
  return version !== undefined && (version.major > 3 || (version.major === 3 && version.minor >= 10))
}

function neoCastRuntimePython(root: string) {
  return path.join(root, ".neo-cast", "runtime", ".venv", "bin", "python")
}

export function getResearchCockpitRunnerStatus(
  task: ResearchCockpitTask | undefined,
  options: ResearchCockpitRunnerStatusOptions = {},
): ResearchCockpitRunnerStatus {
  if (!task) {
    return {
      configured: false,
      ready: false,
      reason: "missing_task",
      detail: "No research task is selected.",
    }
  }
  const runtime = task?.taskSpec.runtime
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    return {
      configured: false,
      ready: false,
      reason: "missing_runtime",
      detail: "taskSpec.runtime is not configured.",
    }
  }
  const root = (runtime as Record<string, unknown>).neoCastProjectRoot
  if (typeof root !== "string" || root.trim().length === 0) {
    return {
      configured: false,
      ready: false,
      reason: "missing_root",
      detail: "taskSpec.runtime.neoCastProjectRoot is not configured.",
    }
  }

  const resolvedRoot = path.resolve(root.trim())
  if (options.validateRuntime !== true) {
    return {
      configured: true,
      ready: true,
      root: resolvedRoot,
      reason: "ready",
      detail: "Neo-Cast runner root is configured.",
    }
  }
  if (!existsSync(resolvedRoot)) {
    return {
      configured: true,
      ready: false,
      root: resolvedRoot,
      reason: "missing_root_path",
      detail: `Neo-Cast runner root does not exist: ${resolvedRoot}`,
    }
  }

  const smokeScript = path.join(resolvedRoot, "py", "validate.py")
  if (!existsSync(smokeScript)) {
    return {
      configured: true,
      ready: false,
      root: resolvedRoot,
      reason: "missing_runner_script",
      detail: `Neo-Cast smoke runner is missing: ${smokeScript}`,
    }
  }

  const rawPythonExecutable = (runtime as Record<string, unknown>).pythonExecutable
  const configuredPython =
    typeof rawPythonExecutable === "string" && rawPythonExecutable.trim().length > 0
      ? rawPythonExecutable.trim()
      : undefined
  const pythonExecutable =
    configuredPython && configuredPython !== "python3" ? configuredPython : neoCastRuntimePython(resolvedRoot)
  if (!existsSync(pythonExecutable) && pythonExecutable === neoCastRuntimePython(resolvedRoot)) {
    return {
      configured: true,
      ready: false,
      root: resolvedRoot,
      pythonExecutable,
      reason: "missing_python",
      detail: "Neo-Cast project runtime is not initialized. Run `node ./bin/neo-cast.js init-runtime` in the runner root.",
    }
  }

  const result = spawnSync(pythonExecutable, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  const versionText = `${result.stdout || ""}${result.stderr || ""}`.trim()
  if (result.error || result.status !== 0) {
    return {
      configured: true,
      ready: false,
      root: resolvedRoot,
      pythonExecutable,
      reason: "python_unavailable",
      detail: `Neo-Cast runtime python is not available: ${pythonExecutable}`,
    }
  }
  if (!isSupportedPythonVersion(versionText)) {
    return {
      configured: true,
      ready: false,
      root: resolvedRoot,
      pythonExecutable,
      reason: "unsupported_python",
      detail: `Neo-Cast requires Python >= 3.10; detected ${versionText || "unknown"}.`,
    }
  }
  return {
    configured: true,
    ready: true,
    root: resolvedRoot,
    pythonExecutable,
    reason: "ready",
    detail: `Neo-Cast runtime is ready at ${pythonExecutable}.`,
  }
}

export function canExecuteResearchCockpitTask(
  task: ResearchCockpitTask | undefined,
  options: ResearchCockpitRunnerStatusOptions = {},
) {
  const status = getResearchCockpitRunnerStatus(task, options)
  return options.validateRuntime === true ? status.ready : status.configured
}

export function hasApprovedResearchCockpitRefTestGate(approvals: ResearchCockpitApproval[], candidateID: string) {
  return hasApprovedResearchCockpitApprovalGate(approvals, candidateID, "ref_test")
}

export function hasApprovedResearchCockpitBlindTestGate(approvals: ResearchCockpitApproval[], candidateID: string) {
  return hasApprovedResearchCockpitApprovalGate(approvals, candidateID, "blind_test")
}

export function hasApprovedResearchCockpitApprovalGate(
  approvals: ResearchCockpitApproval[],
  candidateID: string,
  kind: ResearchCockpitApproval["kind"],
) {
  return approvals.some(
    (approval) => approval.candidateID === candidateID && approval.kind === kind && approval.status === "approved",
  )
}

export function formatResearchCockpitExport(result: ResearchCockpitExportResult) {
  return `${result.artifact.kind} exported: ${result.path}`
}

function formatMetric(value: unknown) {
  if (typeof value !== "number") return JSON.stringify(value)
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)))
}

function primaryMetricText(metrics: JsonRecord) {
  for (const key of ["val_avg_mse", "test_avg_mse", "mse", "loss"]) {
    const value = metrics[key]
    if (typeof value === "number") return `${key}=${formatMetric(value)}`
  }
  return "-"
}

export function formatResearchCockpitIteration(result: ResearchCockpitIterationResult) {
  const roles = result.managerTrace?.map((step) => step.role).join(">")
  const selection = result.selectionArtifact ? `selection ${result.selectionArtifact.kind}` : undefined
  return [
    `iteration ${result.run.status}`,
    result.candidate.id,
    primaryMetricText(result.run.metrics),
    selection,
    roles ? `manager ${roles}` : undefined,
  ]
    .filter((item): item is string => Boolean(item))
    .join(" / ")
}

export function formatResearchCockpitLoop(result: ResearchCockpitLoopResult) {
  const succeeded = result.iterations.filter((iteration) => iteration.run.status === "succeeded").length
  const artifact = result.artifact ? ` / artifact ${result.artifact.kind}` : ""
  return `loop ${result.stoppedReason} / ${result.iterations.length} iterations / ${succeeded} succeeded${artifact}`
}

export function formatResearchCockpitSeedSweep(result: ResearchCockpitSeedSweepResult) {
  const succeeded = result.runs.filter((item) => item.run.status === "succeeded").length
  return `seed sweep / ${result.runs.length} runs / ${succeeded} succeeded / seeds ${result.seeds.join(", ")}`
}

export function formatResearchCockpitRunResult(result: { run: ResearchCockpitRun }) {
  return `run ${result.run.status} / ${result.run.id} / ${primaryMetricText(result.run.metrics)}`
}

export type TsfResearchTaskDefaults = {
  datasetPath?: string
  datasetPreset?: string
  targetCols?: string[]
  contextLength?: number
  predictionLengths?: number[]
  bridgeOnly?: boolean
}

export function parseTsfCsvTaskInput(value: string): TsfResearchTaskDefaults | undefined {
  const parts = value.trim().split(/\s+/).filter(Boolean)
  const datasetPath = parts.shift()
  if (!datasetPath) return undefined

  const result: TsfResearchTaskDefaults = { datasetPath }
  for (const part of parts) {
    if (part === "full") {
      result.bridgeOnly = false
      continue
    }
    if (part === "bridge") {
      result.bridgeOnly = true
      continue
    }
    const index = part.indexOf("=")
    if (index === -1) continue
    const key = part.slice(0, index).toLowerCase()
    const raw = part.slice(index + 1)
    if (!raw) continue
    if (key === "target" || key === "targets") {
      const targetCols = splitCsvOption(raw)
      if (targetCols.length > 0) result.targetCols = targetCols
      continue
    }
    if (key === "horizon" || key === "horizons" || key === "prediction" || key === "predictions") {
      const predictionLengths = splitNumberOption(raw)
      if (predictionLengths.length > 0) result.predictionLengths = predictionLengths
      continue
    }
    if (key === "context" || key === "ctx") {
      const contextLength = Number(raw)
      if (Number.isFinite(contextLength) && contextLength > 0) result.contextLength = Math.floor(contextLength)
      continue
    }
    if (key === "preset" || key === "loader") {
      result.datasetPreset = raw
    }
  }
  return result
}

function splitCsvOption(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function splitNumberOption(value: string) {
  return splitCsvOption(value)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => Math.floor(item))
}

function tsfRuntime(neoCastProjectRoot?: string, bridgeOnly = true): JsonRecord {
  const root = neoCastProjectRoot?.trim()
  return {
    bridgeOnly,
    ...(root ? { neoCastProjectRoot: root } : {}),
  }
}

function nonEmpty(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

export function buildDefaultTsfResearchTask(
  mode: ResearchCockpitTask["mode"],
  neoCastProjectRoot?: string,
  defaults: TsfResearchTaskDefaults = {},
): CreateResearchTaskInput {
  const datasetPath = nonEmpty(defaults.datasetPath)
  return {
    title: mode === "review" ? "TSF Review Research" : "TSF Autonomous Research",
    domainID: "tsf",
    mode,
    taskSpec: {
      contextLength: defaults.contextLength ?? 96,
      predictionLengths:
        defaults.predictionLengths && defaults.predictionLengths.length > 0 ? defaults.predictionLengths : [24],
      dataset: {
        loaderID: nonEmpty(defaults.datasetPreset) ?? "etth1_tslib_v1",
        ...(datasetPath ? { path: datasetPath } : {}),
        targetCols: defaults.targetCols && defaults.targetCols.length > 0 ? defaults.targetCols : ["OT"],
      },
      runtime: tsfRuntime(neoCastProjectRoot, defaults.bridgeOnly ?? true),
    },
    objective: {
      primaryMetric: "val_avg_mse",
      direction: "minimize",
    },
    budget: {
      maxRuns: 12,
      maxParallel: 1,
    },
  }
}
