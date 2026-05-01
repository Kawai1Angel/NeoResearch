import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

export type JsonRecord = Record<string, unknown>
export type ResearchInteractionMode = "companion" | "socratic"

export type ResearchCockpitTask = {
  id: string
  title: string
  domainID: string
  mode: "review" | "autonomous"
  status:
    | "idle"
    | "created"
    | "intent_gathering"
    | "profiling"
    | "analyzing"
    | "data_analysis"
    | "baselining"
    | "searching"
    | "researching"
    | "publishing"
    | "paused"
    | "completed"
    | "failed"
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
  const hasBundle = input.artifacts.some((artifact) => artifact.kind === "research_final_bundle")

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
      label: "Export bundle",
      status: hasBundle ? "done" : input.champion || hasSucceededRun ? "active" : "todo",
      detail: hasBundle ? "Final bundle available." : "Package report, results, model code, and weights.",
    },
  ]
}

export function buildResearchCockpitRecommendation(input: ResearchCockpitWorkflowInput): ResearchCockpitRecommendation {
  const pendingApproval = input.approvals.find((approval) => approval.status === "pending")
  const hasProfile = hasCockpitDatasetProfile(input)
  const hasCandidates = input.candidates.length > 0
  const hasSucceededRun = input.runs.some((run) => run.status === "succeeded" && run.stage !== "profile")
  const hasBundle = input.artifacts.some((artifact) => artifact.kind === "research_final_bundle")
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
  if (hasSucceededRun && !hasBundle) {
    return {
      action: "export_report",
      title: "Export final bundle",
      detail: "Package the latest evidence, model files, and report into a final bundle.",
    }
  }
  return {
    action: "review_state",
    title: "Review latest research state",
    detail: hasBundle ? "Inspect the exported bundle and decide whether to continue." : "No immediate blocking action is pending.",
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
  if (artifact.kind === "research_final_bundle") {
    const champion = metadataString(artifact.metadata, "championCandidateID")
    const runs = compactValue(artifact.metadata.runCount)
    const candidates = compactValue(artifact.metadata.candidateCount)
    parts = [
      champion ? `champion=${champion}` : undefined,
      runs ? `runs=${runs}` : undefined,
      candidates ? `candidates=${candidates}` : undefined,
    ]
  } else if (artifact.kind === "research_report_markdown") {
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
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined
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

export function findBestResearchCockpitMetric(
  objective: JsonRecord,
  runs: ResearchCockpitRun[],
  champion?: ResearchCockpitChampion | null,
) {
  const metricName = typeof objective.primaryMetric === "string" ? objective.primaryMetric : "val_avg_mse"
  if (champion && typeof champion.primaryMetric === "number") {
    return `best ${metricName}=${formatMetric(champion.primaryMetric)}`
  }
  const direction = objective.direction === "maximize" ? "maximize" : "minimize"
  let best: number | undefined
  for (const run of runs) {
    if (run.status !== "succeeded") continue
    const value = run.metrics[metricName]
    if (typeof value !== "number" || !Number.isFinite(value)) continue
    if (best === undefined || (direction === "maximize" ? value > best : value < best)) best = value
  }
  return best === undefined ? undefined : `best ${metricName}=${formatMetric(best)}`
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
    | "missing_dataset_spec"
    | "dataset_spec_mismatch"
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

function optionalNumberArray(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const numbers = value.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
  return numbers.length === value.length ? numbers : undefined
}

function optionalStringArray(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === "string" && item.length > 0)
  return strings.length === value.length ? strings : undefined
}

function arrayEquals<T>(left: T[] | undefined, right: T[] | undefined) {
  if (!left || !right) return true
  return left.length === right.length && left.every((item, index) => item === right[index])
}

function readPreparedDatasetSpec(root: string) {
  const specPaths = [
    path.join(root, ".neo-cast", "dataset_spec.json"),
    path.join(root, ".neo-cast", "dataset", "dataset_spec.json"),
  ]
  const specPath = specPaths.find((item) => existsSync(item))
  if (!specPath) return undefined
  try {
    const parsed = JSON.parse(readFileSync(specPath, "utf8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonRecord) : undefined
  } catch {
    return undefined
  }
}

function preparedDatasetSpecMatchesTask(task: ResearchCockpitTask, root: string) {
  const prepared = readPreparedDatasetSpec(root)
  const taskSpec = asRecord(task.taskSpec)
  const dataset = asRecord(taskSpec.dataset)
  const taskDatasetPath = typeof dataset.path === "string" ? path.resolve(dataset.path) : undefined
  if (!prepared) return taskDatasetPath === undefined
  const sourceCsv = typeof prepared.source_csv === "string" ? path.resolve(prepared.source_csv) : undefined
  if (sourceCsv && taskDatasetPath && sourceCsv !== taskDatasetPath) return false

  const inputLen = typeof prepared.input_len === "number" ? prepared.input_len : undefined
  const contextLength = typeof taskSpec.contextLength === "number" ? taskSpec.contextLength : undefined
  if (inputLen !== undefined && contextLength !== undefined && inputLen !== contextLength) return false

  if (!arrayEquals(optionalNumberArray(taskSpec.predictionLengths), optionalNumberArray(prepared.horizons))) return false
  const targets = optionalStringArray(dataset.targetCols)
  const features = optionalStringArray(prepared.feature_columns)
  if (targets && features) {
    const featureSet = new Set(features)
    if (targets.some((target) => !featureSet.has(target))) return false
  }
  return true
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
  if (!preparedDatasetSpecMatchesTask(task, resolvedRoot)) {
    return {
      configured: true,
      ready: false,
      root: resolvedRoot,
      pythonExecutable,
      reason: "dataset_spec_mismatch",
      detail: "Neo-Cast prepared dataset_spec.json does not match the selected task.",
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
  const metadata = asRecord(result.artifact.metadata)
  const champion = metadataString(metadata, "championCandidateID")
  const metricName = metadataString(metadata, "primaryMetricName")
  const metricValue = compactValue(metadata.primaryMetricValue)
  const copiedFiles = Array.isArray(metadata.copiedFiles)
    ? metadata.copiedFiles.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []
  const parts = [
    `${result.artifact.kind} exported: ${result.path}`,
    champion ? `champion=${champion}` : undefined,
    metricName && metricValue ? `${metricName}=${metricValue}` : undefined,
    copiedFiles.length > 0 ? `files=${copiedFiles.join(", ")}` : undefined,
  ].filter((item): item is string => Boolean(item))
  return parts.join(" / ")
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
  const bestIteration = result.iterations.find((iteration) => iteration.run.status === "succeeded")
  const selected = bestIteration ? ` / selected ${bestIteration.candidate.id} / ${primaryMetricText(bestIteration.run.metrics)}` : ""
  const artifact = result.artifact ? ` / artifact ${result.artifact.kind}` : ""
  const iterationLabel = result.iterations.length === 1 ? "iteration" : "iterations"
  return `loop stopped: ${formatLoopStopReason(result.stoppedReason)} / ${result.iterations.length} ${iterationLabel} / ${succeeded} succeeded${selected}${artifact}`
}

function formatLoopStopReason(reason: string) {
  if (reason === "max_iterations") return "reached max iterations"
  if (reason === "budget_exhausted") return "budget exhausted"
  if (reason === "no_candidate") return "no runnable candidate"
  if (reason === "completed") return "completed"
  return reason.replace(/_/g, " ")
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
  maxRuns?: number
  maxTrainingSeconds?: number
  interactionMode?: ResearchInteractionMode
  metadata?: JsonRecord
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
      continue
    }
    if (key === "max-runs" || key === "runs" || key === "trials" || key === "max-trials") {
      const maxRuns = Number(raw)
      if (Number.isFinite(maxRuns) && maxRuns > 0) result.maxRuns = Math.floor(maxRuns)
      continue
    }
    if (key === "time" || key === "time-budget" || key === "seconds" || key === "max-training-seconds") {
      const seconds = parseDurationSeconds(raw)
      if (seconds !== undefined) result.maxTrainingSeconds = seconds
    }
  }
  return result
}

export function validateTsfCsvTaskInput(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean)
  const datasetPath = parts[0]
  const errors: string[] = []
  if (!datasetPath) return ["Enter a CSV dataset path."]
  if (!/\.csv$/i.test(datasetPath)) {
    errors.push("Dataset path must point to a .csv file.")
  } else if (!existsSync(path.resolve(datasetPath))) {
    errors.push(`Dataset file does not exist: ${path.resolve(datasetPath)}`)
  }
  for (const part of parts.slice(1)) {
    const index = part.indexOf("=")
    if (index === -1) continue
    const key = part.slice(0, index).toLowerCase()
    const raw = part.slice(index + 1)
    if (key === "horizon" || key === "horizons" || key === "prediction" || key === "predictions") {
      if (splitNumberOption(raw).length === 0) errors.push("horizon must be a positive integer list.")
      continue
    }
    if (key === "context" || key === "ctx") {
      const contextLength = Number(raw)
      if (!Number.isFinite(contextLength) || contextLength <= 0) errors.push("context must be a positive integer.")
      continue
    }
    if (key === "target" || key === "targets") {
      if (splitCsvOption(raw).length === 0) errors.push("target must include at least one column.")
      continue
    }
    if (key === "max-runs" || key === "runs" || key === "trials" || key === "max-trials") {
      const maxRuns = Number(raw)
      if (!Number.isFinite(maxRuns) || maxRuns <= 0) errors.push("runs must be a positive integer.")
      continue
    }
    if (key === "time" || key === "time-budget" || key === "seconds" || key === "max-training-seconds") {
      if (parseDurationSeconds(raw) === undefined) errors.push("time must be a positive duration like 30s, 5m, or 1h.")
    }
  }
  return errors
}

function parseDurationSeconds(value: string) {
  const match = /^(\d+(?:\.\d+)?)(s|sec|m|min|h)?$/i.exec(value.trim())
  if (!match) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  const unit = (match[2] ?? "s").toLowerCase()
  const seconds = unit === "h" ? amount * 3600 : unit === "m" || unit === "min" ? amount * 60 : amount
  return Math.floor(seconds)
}

function cleanGoalToken(value: string) {
  return value.replace(/^["'`]+|["'`,.;:]+$/g, "")
}

function datasetPathFromGoal(value: string) {
  return value
    .split(/\s+/)
    .map(cleanGoalToken)
    .find((part) => /\.csv$/i.test(part) || /[/\\][^/\\]+\.csv$/i.test(part))
}

function goalTitle(value: string, defaults: TsfResearchTaskDefaults) {
  const datasetName =
    defaults.datasetPath === undefined
      ? "TSF"
      : path.basename(defaults.datasetPath).replace(/\.[^.]+$/, "") || "TSF"
  const horizons = defaults.predictionLengths?.length ? ` horizon ${defaults.predictionLengths.join(",")}` : ""
  const action = /\bforecast\b/i.test(value) ? "Forecast" : "TSF Research"
  return `${action} ${datasetName}${horizons}`
}

export function parseTsfResearchGoalInput(value: string): TsfResearchTaskDefaults {
  const datasetPath = datasetPathFromGoal(value)
  const csvLike = datasetPath === undefined ? undefined : parseTsfCsvTaskInput([datasetPath, ...value.split(/\s+/)].join(" "))
  const defaults: TsfResearchTaskDefaults = {
    ...(csvLike ?? {}),
    ...(datasetPath === undefined ? {} : { datasetPath }),
    metadata: { userPrompt: value },
  }
  return defaults
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

export function interactionModeForTaskMode(mode: ResearchCockpitTask["mode"]): ResearchInteractionMode {
  return mode === "review" ? "companion" : "socratic"
}

export function interactionModeForTask(task: ResearchCockpitTask | undefined): ResearchInteractionMode | undefined {
  if (!task) return undefined
  const metadata = task.taskSpec.metadata
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const value = (metadata as JsonRecord).interactionMode
    if (value === "companion" || value === "socratic") return value
  }
  return interactionModeForTaskMode(task.mode)
}

export type SocraticClarificationState = {
  active: boolean
  missingSlots: string[]
  nextQuestion?: string
  questionCount: number
}

export function buildSocraticClarificationState(
  task: ResearchCockpitTask | undefined,
  approvals: ResearchCockpitApproval[],
): SocraticClarificationState {
  if (interactionModeForTask(task) !== "socratic") return { active: false, missingSlots: [], questionCount: 0 }
  const approval = approvals.find(
    (item) =>
      item.status === "pending" &&
      item.kind === "protocol" &&
      /Intent clarification required/i.test(item.reason),
  )
  if (!approval) return { active: false, missingSlots: [], questionCount: 0 }
  const questions = approval.reason
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean)
  return {
    active: true,
    missingSlots: questions.map(slotFromSocraticQuestion),
    nextQuestion: questions[0],
    questionCount: questions.length,
  }
}

function slotFromSocraticQuestion(question: string) {
  if (/dataset path|csv dataset/i.test(question)) return "dataset.path"
  if (/target columns|target/i.test(question)) return "dataset.targetCols"
  if (/horizon|prediction/i.test(question)) return "predictionLengths"
  if (/metric|objective/i.test(question)) return "objective.primaryMetric"
  return "unknown"
}

export function researchInteractionModeLabel(mode: ResearchInteractionMode | undefined) {
  if (mode === "companion") return "认知伴随"
  if (mode === "socratic") return "苏格拉底"
  return "未选择"
}

export function taskModeForInteractionMode(mode: ResearchInteractionMode): ResearchCockpitTask["mode"] {
  return mode === "companion" ? "review" : "autonomous"
}

export function parseResearchInteractionModeInput(value: string | undefined): ResearchInteractionMode | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  if (["1", "c", "companion", "cognitive"].includes(normalized)) return "companion"
  if (["2", "s", "socratic", "socrates"].includes(normalized)) return "socratic"
  return undefined
}

export function buildDefaultTsfResearchTask(
  mode: ResearchCockpitTask["mode"],
  neoCastProjectRoot?: string,
  defaults: TsfResearchTaskDefaults = {},
): CreateResearchTaskInput {
  const datasetPath = nonEmpty(defaults.datasetPath)
  const interactionMode = defaults.interactionMode ?? interactionModeForTaskMode(mode)
  const metadata: JsonRecord = {
    ...(defaults.metadata ?? {}),
    interactionMode,
  }
  const constraints: JsonRecord = {
    ...(defaults.maxTrainingSeconds === undefined ? {} : { maxTrainingSeconds: defaults.maxTrainingSeconds }),
    ...(defaults.maxRuns === undefined ? {} : { maxTrials: defaults.maxRuns }),
  }
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
      ...(Object.keys(constraints).length === 0 ? {} : { constraints }),
      metadata,
      runtime: tsfRuntime(neoCastProjectRoot, defaults.bridgeOnly ?? true),
    },
    objective: {
      primaryMetric: "val_avg_mse",
      direction: "minimize",
    },
    budget: {
      maxRuns: defaults.maxRuns ?? 12,
      maxParallel: 1,
      ...(defaults.maxTrainingSeconds === undefined
        ? {}
        : { loop: { timeBudgetSeconds: defaults.maxTrainingSeconds } }),
    },
  }
}

export function buildDefaultTsfResearchTaskFromGoal(
  goal: string,
  mode: ResearchCockpitTask["mode"],
  neoCastProjectRoot?: string,
  overrides: TsfResearchTaskDefaults = {},
) {
  const parsed = parseTsfResearchGoalInput(goal)
  const defaults: TsfResearchTaskDefaults = {
    ...parsed,
    ...overrides,
    metadata: {
      ...(parsed.metadata ?? {}),
      ...(overrides.metadata ?? {}),
    },
  }
  return {
    ...buildDefaultTsfResearchTask(mode, neoCastProjectRoot, defaults),
    title: goalTitle(goal, defaults),
  }
}
