import { neoCastRuntimePython } from "@/research/runners/runtime-python"
import { taskExecutionRoot } from "@/research/task-isolation"
import {
  NAS_DEFAULT_MAX_ITERATIONS,
  NAS_DEFAULT_MAX_NO_IMPROVE,
  RESEARCH_MAX_RUNS_SAFETY_LIMIT,
  RESEARCH_MAX_PARALLEL_EXPERIMENTS,
} from "@/research/defaults"
import { literatureSummary } from "./research-literature-state"
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
  interactionMode?: ResearchInteractionMode
  status:
    | "idle"
    | "created"
    | "intent_gathering"
    | "profiling"
    | "analyzing"
    | "literature"
    | "data_analysis"
    | "hypo_planning"
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
  status: "queued" | "running" | "succeeded" | "failed" | "rejected" | "invalid"
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
  role: "diagnostic" | "design" | "coder" | "runner" | "verifier" | "analyst" | "librarian"
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
  interactionMode?: ResearchInteractionMode
  taskSpec: JsonRecord
  objective: JsonRecord
  budget: JsonRecord
}

export type ResearchCockpitWorkflowStatus = "done" | "active" | "todo"

export type ResearchCockpitWorkflowItem = {
  label: string
  status: ResearchCockpitWorkflowStatus
  detail?: string
  displayLabel?: string
}

export type ResearchCockpitRecommendation = {
  action:
    | "create_task"
    | "confirm_intent"
    | "approve_gate"
    | "configure_runner"
    | "prepare_dataset"
    | "profile"
    | "run_data_analysis"
    | "run_hypo_planning"
    | "seed_baselines"
    | "run_autonomous_loop"
    | "resume_publish_pipeline"
    | "run_smoke"
    | "run_full"
    | "export_report"
    | "review_state"
  title: string
  detail: string
  candidateID?: string
}

export type ResearchCockpitNbaAction = {
  command: string
  title: string
  detail: string
  action: ResearchCockpitRecommendation["action"]
  candidateID?: string
}

const researchRefreshEventTypes = new Set([
  "research.task.created",
  "research.task.updated",
  "research.candidate.created",
  "research.candidate.updated",
  "research.run.created",
  "research.run.updated",
  "research.runner.progress.line",
  "research.artifact.created",
  "research.memory.created",
  "research.champion.updated",
  "research.approval.created",
  "research.approval.updated",
  "research.agent.hypoPlanner.started",
  "research.agent.hypoPlanner.completed",
  "research.agent.hypoPlanner.failed",
])

export function shouldRefreshResearchCockpitOnEvent(event: { type: string }) {
  if (event.type.endsWith(".stream.delta") || event.type.endsWith(".part.updated")) return false
  return researchRefreshEventTypes.has(event.type) || event.type.startsWith("research.agent.")
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
  runnerRepairAction?: "configure_runner" | "prepare_dataset"
}

export function buildResearchCockpitWorkflow(input: ResearchCockpitWorkflowInput): ResearchCockpitWorkflowItem[] {
  const hasTask = Boolean(input.task)
  const hasProfile = hasCockpitProfileEvidence(input)
  const intentConfirmed = hasIntentConfirmation(input) || hasProfile
  const agentWorkflow = buildResearchCockpitAgentWorkflow(input)
  const hasTrainEval = agentWorkflow.some((item) => item.label === "TrainEval Agent" && item.status === "done")
  const hasPendingApproval = input.approvals.some((approval) => approval.status === "pending")
  const hasBundle = input.artifacts.some(
    (artifact) => artifact.kind === "research_final_bundle" || artifact.kind === "model_export_package",
  )
  const canPublish = Boolean(input.champion) || hasTrainEval

  return [
    {
      label: "Create research task",
      status: hasTask ? "done" : "active",
      detail: hasTask ? input.task?.title : "Bind a goal, dataset, objective, and execution budget.",
    },
    {
      label: "Data Analysis Agent",
      status: hasProfile ? "done" : hasTask && intentConfirmed ? "active" : "todo",
      detail: hasProfile ? "Dataset fingerprint available." : "Inspect horizon, targets, missingness, and seasonality.",
    },
    ...agentWorkflow,
    {
      label: "Review gates",
      status: hasPendingApproval ? "active" : canPublish ? "done" : "todo",
      detail: hasPendingApproval ? "Approval required before promotion." : "Candidate, ref, and blind gates are clear.",
    },
    {
      label: "Export bundle",
      status: hasBundle ? "done" : canPublish ? "active" : "todo",
      detail: hasBundle ? "Final bundle available." : "Package report, results, model code, and weights.",
    },
  ]
}

export function buildResearchCockpitAgentWorkflow(input: ResearchCockpitWorkflowInput): ResearchCockpitWorkflowItem[] {
  const hasProfile = hasCockpitProfileEvidence(input)
  const hasCandidates = input.candidates.length > 0
  const hypothesisCount = researchCockpitHypothesisCount(input)
  // Historical `input.champion` is a long-lived task-level snapshot; it must NOT
  // coalesce upstream stages to "done" because the cockpit would render every
  // stage as ✓ on a fresh task that simply has a champion from a prior session.
  // Stage progress is derived only from per-run / per-artifact / per-candidate
  // evidence collected for the active task.
  const hasHypothesisPlan =
    hypothesisCount !== undefined ||
    input.artifacts.some((artifact) => artifact.kind === "hypo_plan_md" || artifact.kind === "hypotheses_yaml") ||
    (hasProfile && (hasCandidates || hasCompletedCompilerRun(input) || hasTrainEvalEvidence(input)))
  const requirementsConfirmed = hasRequirementsConfirmation(input) || hasHypothesisPlan
  const hasCompilerEvidence =
    input.artifacts.some((artifact) => artifact.kind === "model_compile_report_md") ||
    hasCompletedCompilerRun(input) ||
    hasTrainEvalEvidence(input)
  const hasRunningCompiler = input.runs.some((run) => run.stage === "smoke" && (run.status === "queued" || run.status === "running"))
  const trainEvalDone = hasTrainEvalEvidence(input)
  const hasRunningTrainEval = input.runs.some(
    (run) => isTrainEvalRun(run) && (run.status === "queued" || run.status === "running"),
  )
  const reflectionDone = hasReflectionEvidence(input)
  const reflectionActive = trainEvalDone && !reflectionDone
  const designerIteration = modelDesignerIteration(input)
  const literatureArtifact = input.artifacts.find((artifact) => artifact.kind === "task_evidence_bundle_json")
  const literatureDone = Boolean(literatureArtifact) || (Array.isArray(asRecord(asRecord(asRecord(input.task?.taskSpec).metadata).workflow).completedPhases)
    && (asRecord(asRecord(asRecord(input.task?.taskSpec).metadata).workflow).completedPhases as unknown[]).includes("literature"))
  const planningActive = literatureDone && hasProfile && input.runnerReady && requirementsConfirmed
  const designActive = hasHypothesisPlan && input.runnerReady
  const designerDisplayLabel =
    designerIteration && (hasCompilerEvidence || designActive) ? `ModelDesigner Agent (${designerIteration})` : "ModelDesigner Agent"

  return [
    {
      label: "LiteratureAgent",
      status: literatureDone ? "done" : input.task?.status === "literature" ? "active" : "todo",
      detail: literatureArtifact ? literatureSummary(literatureArtifact.metadata) : "Retrieve local papers and assemble validated task evidence.",
    },
    {
      label: "HypoPlanner Agent",
      displayLabel:
        hypothesisCount === undefined
          ? "HypoPlanner Agent"
          : `HypoPlanner Agent (${hypothesisCount} ${hypothesisCount === 1 ? "hypothesis" : "hypotheses"})`,
      status: hasHypothesisPlan ? "done" : planningActive ? "active" : "todo",
      detail: hasHypothesisPlan
        ? hypothesisCount === undefined
          ? "Hypothesis plan ready."
          : `${hypothesisCount} hypotheses ready.`
        : "Turn the data-analysis handoff into testable architecture hypotheses.",
    },
    {
      label: "ModelDesigner Agent",
      displayLabel: designerDisplayLabel,
      status: hasCompilerEvidence ? "done" : designActive ? "active" : "todo",
      detail: hasCandidates
        ? `${input.candidates.length} candidate recipes available.`
        : "Select or synthesize the next architecture candidate.",
    },
    {
      label: "ModelCompiler Agent",
      status: hasCompilerEvidence ? "done" : hasRunningCompiler ? "active" : "todo",
      detail: hasCompilerEvidence ? "Smoke compile evidence available." : "Run smoke validation before training.",
    },
    {
      label: "TrainEval Agent",
      status: trainEvalDone ? "done" : hasRunningTrainEval || (hasCompilerEvidence && input.runnerReady) ? "active" : "todo",
      detail: trainEvalDone ? "Training/evaluation evidence available." : "Promote compiled candidates to training evaluation.",
    },
    {
      label: "Reflection Agent",
      status: reflectionDone ? "done" : reflectionActive ? "active" : "todo",
      detail: reflectionDone
        ? "Reflection notes available."
        : "Summarize what worked, what failed, and the next hypotheses.",
    },
  ]
}

export function buildResearchCockpitRecommendation(input: ResearchCockpitWorkflowInput): ResearchCockpitRecommendation {
  const nba = selectNextBestAction(input)
  if (nba) {
    return {
      action: nba.action,
      title: nba.title,
      detail: nba.detail,
      candidateID: nba.candidateID,
    }
  }
  if (
    input.task &&
    input.artifacts.some(
      (artifact) => artifact.kind === "research_final_bundle" || artifact.kind === "model_export_package",
    )
  ) {
    return {
      action: "review_state",
      title: "Review final report",
      detail: "Open the final PublishAgent report and exported research artifacts.",
    }
  }
  if (input.runs.some((run) => run.status === "queued" || run.status === "running")) {
    return {
      action: "review_state",
      title: "Run in progress",
      detail: "Follow the live run block; the next best action will return when execution settles.",
    }
  }
  if (input.task && !hasIntentConfirmation(input) && !hasCockpitProfileEvidence(input)) {
    return {
      action: "confirm_intent",
      title: "Confirm requirements",
      detail: "Review the Intent Agent slots and confirm before Data Analysis, baselines, or autonomous loop can start.",
    }
  }
  if (input.task) {
    return {
      action: "review_state",
      title: "Review latest research state",
      detail: "No immediate blocking action is pending.",
    }
  }

  return {
    action: "create_task",
    title: "Create a dataset-backed TSF task",
    detail: "Enter a research goal to create a full-recipe autonomous task, or use /new csv to bind a local CSV.",
  }
}

export function selectNextBestAction(input: ResearchCockpitWorkflowInput): ResearchCockpitNbaAction | null {
  const pendingApproval = input.approvals.find((approval) => approval.status === "pending")
  const hasProfile = hasCockpitProfileEvidence(input)
  const intentConfirmed = hasIntentConfirmation(input) || hasProfile
  const hasCandidates = input.candidates.length > 0
  const hasSucceededRun = input.runs.some((run) => run.status === "succeeded" && run.stage !== "profile")
  const hasBundle = input.artifacts.some(
    (artifact) => artifact.kind === "research_final_bundle" || artifact.kind === "model_export_package",
  )
  const runnableCandidate = input.candidates.find(canRunResearchCockpitCandidate)
  const hasActiveRun = input.runs.some((run) => run.status === "queued" || run.status === "running")

  if (!input.task) {
    return {
      command: "/new csv",
      action: "create_task",
      title: "Create a dataset-backed TSF task",
      detail: "Enter a research goal to create a full-recipe autonomous task, or use /new csv to bind a local CSV.",
    }
  }
  if (hasBundle) return null
  if (hasActiveRun) return null
  if (pendingApproval) {
    return {
      command: "/candidate approve",
      action: "approve_gate",
      title: "Review pending gate",
      detail: `${pendingApproval.kind} approval is waiting before the next promotion step.`,
    }
  }
  if (!input.runnerReady) {
    if (input.runnerRepairAction === "prepare_dataset") {
      return {
        command: "/dataset prepare",
        action: "prepare_dataset",
        title: "Prepare dataset",
        detail: "Regenerate the runner dataset contract so it matches the selected task.",
      }
    }
    return {
      command: "/runner check",
      action: "configure_runner",
      title: "Check runner",
      detail: "Set taskSpec.runtime.neoCastProjectRoot before executing candidate runs.",
    }
  }
  if (!intentConfirmed) {
    return null
  }
  if (!hasProfile) {
    return {
      command: "/dataset profile",
      action: "profile",
      title: "Profile dataset",
      detail: "Generate the dataset fingerprint before comparing architectures.",
    }
  }
  const explicitInteractionMode =
    input.task?.interactionMode === "companion" || input.task?.interactionMode === "socratic"
      ? input.task.interactionMode
      : (() => {
          const v = asRecord(asRecord(input.task?.taskSpec).metadata).interactionMode
          return v === "companion" || v === "socratic" ? v : undefined
        })()
  if (explicitInteractionMode !== undefined) {
    const workflow = asRecord(asRecord(asRecord(input.task?.taskSpec).metadata).workflow)
    const completedPhaseList = Array.isArray(workflow.completedPhases) ? (workflow.completedPhases as string[]) : []
    if (!completedPhaseList.includes("data_analysis")) {
      return {
        command: "/pipeline data-analysis",
        action: "run_data_analysis",
        title: "Run Data Analysis",
        detail: "Inspect dataset patterns, targets, missingness, and seasonality before hypothesis planning.",
      }
    }
    if (!completedPhaseList.includes("literature")) {
      return { command: "/pipeline hypo-planning", action: "run_hypo_planning", title: "Run Literature Retrieval",
        detail: "Retrieve local literature and validate evidence before hypothesis planning." }
    }
    if (!completedPhaseList.includes("hypo_planning")) {
      return {
        command: "/pipeline hypo-planning",
        action: "run_hypo_planning",
        title: "Run Hypothesis Planning",
        detail: "Turn the data-analysis handoff into testable architecture hypotheses.",
      }
    }
  }
  if (!hasCandidates) {
    return {
      command: "/seed",
      action: "seed_baselines",
      title: "Seed baselines",
      detail: "Create initial recipes so the runner has concrete experiments to evaluate.",
    }
  }
  if (input.task.mode === "autonomous" && input.task.status !== "completed") {
    const workflow = asRecord(asRecord(asRecord(input.task?.taskSpec).metadata).workflow)
    if (workflow.lastCheckpoint === "final_model_selection") {
      return {
        command: "/pipeline publish",
        action: "resume_publish_pipeline",
        title: "Resume pipeline: reflection & publish",
        detail: "Model selection approved — resume pipeline to run reflection, ref_test, and export the final bundle.",
      }
    }
    const verifiedSmoke = input.runs
      .filter((run) => run.stage === "smoke" && run.status === "succeeded" && run.candidateID &&
        asRecord(run.resourceUsage?.executionContract).status === "verified")
      .toSorted((a, b) => b.time.created - a.time.created)
      .find((run) =>
        input.candidates.some((candidate) => candidate.id === run.candidateID && canRunResearchCockpitCandidate(candidate)) &&
        !input.runs.some((other) => other.candidateID === run.candidateID && other.stage === "full"),
      )
    if (verifiedSmoke) {
      return {
        command: "/run full",
        action: "run_full",
        title: "Run full training",
        candidateID: verifiedSmoke.candidateID,
        detail: `Smoke verification passed for ${verifiedSmoke.candidateID}. Run full training to produce the primary metric.`,
      }
    }
    return {
      command: "/loop start",
      action: "run_autonomous_loop",
      title: "Run autonomous loop",
      detail: "Let the manager iterate across design, runner, analyst, and memory steps.",
    }
  }
  if (runnableCandidate) {
    return {
      command: "/run smoke",
      action: "run_smoke",
      title: "Run smoke execution",
      detail: `Execute ${runnableCandidate.id} and compare the primary metric.`,
    }
  }
  if (hasSucceededRun && !hasBundle) {
    return {
      command: "/export bundle",
      action: "export_report",
      title: "Export final bundle",
      detail: "Package the latest evidence, model files, and report into a final bundle.",
    }
  }
  return null
}

function hasCockpitDatasetProfile(input: Pick<ResearchCockpitWorkflowInput, "artifacts" | "fingerprint">) {
  if (input.artifacts.some((artifact) => artifact.kind === "task_profile_json")) return true
  const fingerprint = input.fingerprint ?? {}
  return Boolean(fingerprint.datasetProfile || fingerprint.datasetProfileWarning)
}

function hasCockpitProfileEvidence(input: Pick<ResearchCockpitWorkflowInput, "artifacts" | "fingerprint" | "runs">) {
  return hasCockpitDatasetProfile(input) || input.runs.some((run) => run.stage === "profile" && run.status === "succeeded")
}

function researchCockpitHypothesisCount(input: ResearchCockpitWorkflowInput) {
  const metadata = asRecord(asRecord(input.task?.taskSpec).metadata)
  const plan = asRecord(metadata.hypothesisPlan)
  const planHypotheses = plan.hypotheses
  if (Array.isArray(planHypotheses)) return planHypotheses.length
  for (const artifact of input.artifacts) {
    if (artifact.kind !== "hypo_plan_md" && artifact.kind !== "hypotheses_yaml") continue
    const count = artifact.metadata.hypothesisCount
    if (typeof count === "number" && Number.isFinite(count)) return count
  }
  return undefined
}

function hasCompletedCompilerRun(input: Pick<ResearchCockpitWorkflowInput, "runs">) {
  return input.runs.some(
    (run) => run.stage === "smoke" && (run.status === "succeeded" || run.status === "failed" || run.status === "rejected"),
  )
}

function isTrainEvalRun(run: ResearchCockpitRun) {
  return run.stage === "low_fidelity" || run.stage === "full" || run.stage === "ref_test" || run.stage === "blind_test"
}

function hasTrainEvalEvidence(input: Pick<ResearchCockpitWorkflowInput, "runs">) {
  return input.runs.some(
    (run) => isTrainEvalRun(run) && (run.status === "succeeded" || run.status === "failed" || run.status === "rejected"),
  )
}

function hasReflectionEvidence(input: Pick<ResearchCockpitWorkflowInput, "artifacts">) {
  return input.artifacts.some(
    (artifact) =>
      artifact.kind === "reflection_notes_md" ||
      artifact.kind === "nas_reflection_notes_md" ||
      artifact.kind === "next_experiment_plan_md" ||
      artifact.kind === "failure_log_md",
  )
}

export function hasIntentConfirmation(
  input: Pick<ResearchCockpitWorkflowInput, "task" | "approvals" | "artifacts" | "runs"> &
    Partial<Pick<ResearchCockpitWorkflowInput, "candidates" | "champion">>,
) {
  const workflow = asRecord(asRecord(asRecord(input.task?.taskSpec).metadata).workflow)
  const lastCheckpoint = workflow.lastCheckpoint
  if (lastCheckpoint === "intent_confirmed" || lastCheckpoint === "requirements_confirmed") return true
  const completedPhases = workflow.completedPhases
  if (
    Array.isArray(completedPhases) &&
    completedPhases.some(
      (phase) =>
        phase === "intent_gathering" ||
        phase === "data_analysis" ||
        phase === "hypo_planning" ||
        phase === "searching" ||
        phase === "reflection" ||
        phase === "publishing",
    )
  ) {
    return true
  }
  if (
    input.artifacts.some((artifact) => artifact.kind === "dataset_analysis_report" || artifact.kind === "task_profile_json") ||
    input.runs.some((run) => run.stage === "profile") ||
    (input.candidates?.length ?? 0) > 0 ||
    Boolean(input.champion) ||
    input.approvals.some((approval) => approval.kind !== "protocol" || Boolean(approval.candidateID))
  ) {
    return true
  }
  return input.approvals.some(
    (approval) =>
      approval.kind === "protocol" &&
      approval.status === "approved" &&
      (approval.reason.includes("[checkpoint:intent_confirmed]") ||
        approval.reason.includes("[checkpoint:requirements_confirmed]")),
  )
}

function hasRequirementsConfirmation(input: Pick<ResearchCockpitWorkflowInput, "task" | "approvals">) {
  const workflow = asRecord(asRecord(asRecord(input.task?.taskSpec).metadata).workflow)
  const lastCheckpoint = workflow.lastCheckpoint
  if (lastCheckpoint === "requirements_confirmed") return true
  const completedPhases = workflow.completedPhases
  if (Array.isArray(completedPhases) && completedPhases.includes("hypo_planning")) return true
  return input.approvals.some(
    (approval) =>
      approval.kind === "protocol" &&
      approval.status === "approved" &&
      approval.reason.includes("[checkpoint:requirements_confirmed]"),
  )
}

function modelDesignerIteration(input: Pick<ResearchCockpitWorkflowInput, "task" | "runs">) {
  const budget = asRecord(input.task?.budget)
  const loop = asRecord(budget.loop ?? budget.researchLoop ?? budget.autonomousLoop)
  const maxIterations =
    typeof loop.maxIterations === "number" && Number.isFinite(loop.maxIterations)
      ? Math.max(1, Math.floor(loop.maxIterations))
      : NAS_DEFAULT_MAX_ITERATIONS
  const candidateIDs = new Set(
    input.runs
      .filter((run) => run.stage !== "profile" && typeof run.candidateID === "string" && run.candidateID.length > 0)
      .map((run) => run.candidateID as string),
  )
  const fallbackAttemptCount = input.runs.filter((run) => run.stage !== "profile").length
  const completedAttempts = candidateIDs.size > 0 ? candidateIDs.size : fallbackAttemptCount
  const iteration = Math.min(maxIterations, completedAttempts + 1)
  return `iteration ${iteration}/${maxIterations}`
}

export function researchCockpitArtifactTarget(artifact: Pick<ResearchCockpitArtifact, "uri">) {
  if (!artifact.uri.startsWith("file:")) return artifact.uri
  const url = new URL(artifact.uri)
  // Artifact paths belong to the server's OS, which can differ from the TUI's.
  if (/%2f|%5c/i.test(url.pathname)) throw new Error("Artifact URI contains an encoded path separator")
  const pathname = decodeURIComponent(url.pathname)
  if (url.hostname) return `//${url.hostname}${pathname}`
  return /^\/[a-z]:\//i.test(pathname) ? pathname.slice(1) : pathname
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
  } else if (artifact.kind === "hypo_plan_md" || artifact.kind === "hypotheses_yaml") {
    const agent = metadataString(artifact.metadata, "agent")
    const hypothesisCount = compactValue(artifact.metadata.hypothesisCount)
    const baseline = metadataString(artifact.metadata, "baselineStrategy")
    const referenceBaseline = metadataString(artifact.metadata, "referenceBaseline")
    parts = [
      agent ? `agent=${agent}` : undefined,
      hypothesisCount ? `hypotheses=${hypothesisCount}` : undefined,
      baseline ? `baseline=${baseline}` : undefined,
      referenceBaseline ? `reference=${referenceBaseline}` : undefined,
    ]
  } else if (artifact.kind === "model_compile_report_md") {
    const agent = metadataString(artifact.metadata, "agent")
    const candidateID = metadataString(artifact.metadata, "candidateID")
    const status = metadataString(artifact.metadata, "status")
    const smokeMetric = compactValue(artifact.metadata.smokeMetric)
    const failureReason = metadataString(artifact.metadata, "failureReason")
    parts = [
      agent ? `agent=${agent}` : undefined,
      candidateID ? `candidate=${candidateID}` : undefined,
      status ? `status=${status}` : undefined,
      smokeMetric ? `smoke=${smokeMetric}` : undefined,
      failureReason ? `failure=${failureReason}` : undefined,
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
  const metricName = typeof objective.primaryMetric === "string" ? objective.primaryMetric : "cv_avg_mse"
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

function compactIntentValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(compactIntentValue).join(",")
  if (typeof value === "string") return value.trim() || "-"
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return "-"
}

export function researchCockpitIntentCheckpointSignature(task: ResearchCockpitTask) {
  const spec = asRecord(task.taskSpec)
  const dataset = asRecord(spec.dataset)
  const objective = asRecord(task.objective)
  const budget = asRecord(task.budget)
  const loop = asRecord(budget.loop ?? budget.researchLoop ?? budget.autonomousLoop)
  return [
    `mode=${compactIntentValue(interactionModeForTask(task) ?? task.mode)}`,
    `dataset=${compactIntentValue(dataset.path ?? dataset.loaderID)}`,
    `targets=${compactIntentValue(dataset.targetCols)}`,
    `pastCovariates=${compactIntentValue(dataset.observedPastCovariates)}`,
    `futureCovariates=${compactIntentValue(dataset.knownFutureCovariates)}`,
    `covariateSchema=${compactIntentValue(asRecord(asRecord(spec.metadata).resolvedCovariates).schemaFingerprint)}`,
    `context=${compactIntentValue(spec.contextLength)}`,
    `horizons=${compactIntentValue(spec.predictionLengths)}`,
    `metric=${compactIntentValue(objective.primaryMetric)}`,
    `direction=${compactIntentValue(objective.direction)}`,
    `maxIterations=${compactIntentValue(loop.maxIterations ?? NAS_DEFAULT_MAX_ITERATIONS)}`,
    `maxNoImprove=${compactIntentValue(loop.maxNoImprove ?? loop.maxNoImproveRounds ?? NAS_DEFAULT_MAX_NO_IMPROVE)}`,
  ].join("|")
}

export function formatResearchCockpitIntentCheckpointReason(task: ResearchCockpitTask) {
  const spec = asRecord(task.taskSpec)
  const dataset = asRecord(spec.dataset)
  const objective = asRecord(task.objective)
  const budget = asRecord(task.budget)
  const loop = asRecord(budget.loop ?? budget.researchLoop ?? budget.autonomousLoop)
  const metadata = asRecord(spec.metadata)
  return [
    "[checkpoint:intent_confirmed]",
    "## Complete and confirm requirements before finishing Intent Agent",
    "",
    "Confirm that Intent Agent has finished gathering requirements and that the following research intent is ready for Data Analysis, HypoPlanner, and the experiment loop.",
    `Intent signature: ${researchCockpitIntentCheckpointSignature(task)}`,
    `Interaction mode: ${compactIntentValue(interactionModeForTask(task) ?? task.mode)}`,
    `Task: ${task.title}`,
    `Dataset: ${compactIntentValue(dataset.path ?? dataset.loaderID)}`,
    `Targets: ${compactIntentValue(dataset.targetCols)}`,
    `Context length: ${compactIntentValue(spec.contextLength)}`,
    `Prediction lengths: ${compactIntentValue(spec.predictionLengths)}`,
    `Primary metric: ${compactIntentValue(objective.primaryMetric)}`,
    `NAS planned iterations: ${compactIntentValue(loop.maxIterations ?? NAS_DEFAULT_MAX_ITERATIONS)}`,
    `Stop after no improvement: ${compactIntentValue(loop.maxNoImprove ?? loop.maxNoImproveRounds ?? NAS_DEFAULT_MAX_NO_IMPROVE)}`,
    `Business context: ${compactIntentValue(metadata.businessContext ?? metadata.business_context)}`,
    "",
    "**Recommended action:** approve these requirements to finish Intent Agent and enter Data Analysis; to add requirements, reject, update taskSpec/intent slots, and rerun.",
  ].join("\n")
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

function fmt(key: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "boolean") return value ? key : `${key}=false`
  if (typeof value === "number") {
    const s = Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(3)))
    return `${key}=${s}`
  }
  if (typeof value === "string" && value.length > 0) return `${key}=${value}`
  return undefined
}

function formatPreprocessingDetail(actions: unknown[]): string {
  return actions
    .map((action) => {
      const a = asRecord(action)
      const type = typeof a.type === "string" ? a.type : "?"
      if (type === "none") return "none"
      const params: string[] = []
      if (type === "instance_norm") {
        if (a.affine) params.push("affine")
        if (typeof a.eps === "number") params.push(fmt("eps", a.eps) ?? "")
      } else if (type === "series_decomposition") {
        const p = fmt("k", a.kernelSize ?? a.kernel_size)
        if (p) params.push(p)
      } else if (type === "seasonal_differencing") {
        const p = fmt("period", a.period)
        if (p) params.push(p)
        const o = fmt("order", a.order)
        if (o && a.order !== 1) params.push(o)
      } else if (type === "missing_mask") {
        const p = fmt("fill", a.fillPolicy ?? a.fill_policy)
        if (p) params.push(p)
      } else if (type === "sample_reweighting") {
        const p = fmt("scheme", a.scheme)
        if (p) params.push(p)
      }
      return params.length > 0 ? `${type}(${params.filter(Boolean).join(",")})` : type
    })
    .join("+")
}

function formatEmbeddingDetail(emb: Record<string, unknown>): string {
  const type = typeof emb.type === "string" ? emb.type : "?"
  if (type === "none") return "none"
  const params: Array<string | undefined> = []
  if (type === "patch") {
    params.push(fmt("len", emb.patchLen ?? emb.patch_len))
    params.push(fmt("stride", emb.stride))
    params.push(fmt("d", emb.dModel ?? emb.d_model))
  } else if (type === "multiscale_patch") {
    const scales = Array.isArray(emb.scales) ? emb.scales.map((s: unknown) => {
      const sr = asRecord(s)
      return `${sr.patchLen ?? sr.patch_len}x${sr.stride}`
    }).join(",") : ""
    if (scales) params.push(`scales=[${scales}]`)
    params.push(fmt("d", emb.dModel ?? emb.d_model))
  } else if (type === "invert") {
    params.push(fmt("d", emb.dModel ?? emb.d_model))
  } else if (type === "frequency") {
    params.push(fmt("nFreq", emb.nFreq ?? emb.n_freq))
    params.push(fmt("d", emb.dModel ?? emb.d_model))
  } else if (type === "calendar") {
    const fields = Array.isArray(emb.fields) ? emb.fields.join(",") : ""
    if (fields) params.push(`fields=[${fields}]`)
  }
  const p = params.filter(Boolean).join(",")
  return p ? `${type}(${p})` : type
}

function formatEmbeddingExpandedDetail(embedding: Record<string, unknown>): string {
  const type = typeof embedding.type === "string" ? embedding.type : "?"
  if (type === "none") return "none"
  const params: string[] = []
  const patchLen = embedding.patchLen ?? embedding.patch_len
  const stride = embedding.stride
  const nFreq = embedding.nFreq ?? embedding.n_freq
  const dModel = embedding.dModel ?? embedding.d_model
  const complexMode = embedding.complexMode ?? embedding.complex_mode
  if (patchLen !== undefined) params.push(`patch=${patchLen}`)
  if (stride !== undefined) params.push(`stride=${stride}`)
  if (nFreq !== undefined) params.push(`n_freq=${nFreq}`)
  if (dModel !== undefined) params.push(`d_model=${dModel}`)
  if (complexMode !== undefined) params.push(`complex_mode=${complexMode}`)
  return `${type}${params.length ? `(${params.join(", ")})` : ""}`
}

function formatBackboneDetail(bb: Record<string, unknown>): string {
  const type = typeof bb.type === "string" ? bb.type : "?"
  const params: Array<string | undefined> = []
  if (type === "diagonal_ssm") {
    params.push(fmt("d", bb.dModel ?? bb.d_model))
    params.push(fmt("state", bb.stateDim ?? bb.state_dim))
    params.push(fmt("depth", bb.depth))
    params.push(fmt("drop", bb.dropout))
  } else if (type === "timesblock_encoder") {
    params.push(fmt("d", bb.dModel ?? bb.d_model))
    params.push(fmt("ffn", bb.dFf ?? bb.d_ff))
    params.push(fmt("depth", bb.depth))
    params.push(fmt("topK", bb.topK ?? bb.top_k))
    params.push(fmt("kernels", bb.numKernels ?? bb.num_kernels))
    params.push(fmt("drop", bb.dropout))
  } else if (type === "mamba") {
    params.push(fmt("d", bb.dModel ?? bb.d_model))
    params.push(fmt("state", bb.dState ?? bb.d_state))
    params.push(fmt("conv", bb.dConv ?? bb.d_conv))
    params.push(fmt("expand", bb.expand))
    params.push(fmt("depth", bb.depth))
    params.push(fmt("drop", bb.dropout))
    params.push(fmt("backend", bb.backend))
  } else if (type === "linear") {
    params.push(fmt("shared", bb.shared))
    params.push(fmt("bias", bb.bias))
  } else if (type === "mlp") {
    params.push(fmt("depth", bb.depth))
    params.push(fmt("h", bb.hiddenDim ?? bb.hidden_dim))
    params.push(fmt("act", bb.activation))
    params.push(fmt("drop", bb.dropout))
  } else if (type === "transformer") {
    params.push(fmt("d", bb.dModel ?? bb.d_model))
    params.push(fmt("heads", bb.nHeads ?? bb.n_heads))
    params.push(fmt("layers", bb.nLayers ?? bb.n_layers))
    params.push(fmt("drop", bb.dropout))
    params.push(fmt("ffn", bb.ffnMult ?? bb.ffn_mult))
  } else if (type === "rnn") {
    params.push(fmt("cell", bb.cell))
    params.push(fmt("h", bb.hiddenDim ?? bb.hidden_dim))
    params.push(fmt("layers", bb.numLayers ?? bb.num_layers))
    params.push(fmt("drop", bb.dropout))
  } else if (type === "dlinear") {
    params.push(fmt("k", bb.kernelSize ?? bb.kernel_size))
    params.push(fmt("bias", bb.bias))
    params.push(fmt("individual", bb.individual))
  } else if (type === "tcn") {
    params.push(fmt("h", bb.hiddenDim ?? bb.hidden_dim))
    params.push(fmt("layers", bb.nLayers ?? bb.n_layers))
    params.push(fmt("k", bb.kernelSize ?? bb.kernel_size))
    params.push(fmt("act", bb.activation))
    params.push(fmt("drop", bb.dropout))
  } else if (type === "gated_depthwise_conv") {
    params.push(fmt("h", bb.hiddenDim ?? bb.hidden_dim))
    params.push(fmt("depth", bb.depth))
    params.push(fmt("k", bb.kernelSize ?? bb.kernel_size))
    params.push(fmt("drop", bb.dropout))
  } else if (type === "ssm") {
    params.push(fmt("state", bb.stateDim ?? bb.state_dim))
    params.push(fmt("depth", bb.depth))
    params.push(fmt("drop", bb.dropout))
  } else if (type === "mixer") {
    params.push(fmt("h", bb.hiddenDim ?? bb.hidden_dim))
    params.push(fmt("depth", bb.depth))
    params.push(fmt("tmix", bb.temporalMixing ?? bb.temporal_mixing))
    params.push(fmt("cmix", bb.channelMixing ?? bb.channel_mixing))
    params.push(fmt("drop", bb.dropout))
  } else if (type === "nbeats") {
    params.push(fmt("h", bb.hiddenDim ?? bb.hidden_dim))
    params.push(fmt("blocks", bb.nBlocks ?? bb.n_blocks))
    params.push(fmt("layers", bb.nLayers ?? bb.n_layers))
    params.push(fmt("act", bb.activation))
    params.push(fmt("drop", bb.dropout))
  } else if (type === "timesnet" || type === "timesnet_lite") {
    params.push(fmt("h", bb.hiddenDim ?? bb.hidden_dim))
    params.push(fmt("layers", bb.nLayers ?? bb.n_layers))
    params.push(fmt("topK", bb.topK ?? bb.top_k))
    params.push(fmt("k", bb.kernelSize ?? bb.kernel_size))
    params.push(fmt("drop", bb.dropout))
  }
  params.push(fmt("attn", bb.attention))
  const p = params.filter(Boolean).join(",")
  return p ? `${type}(${p})` : type
}

function formatRepresentationDetail(representation: Record<string, unknown>): string {
  const layout = typeof representation.layout === "string" ? representation.layout : "?"
  const params: Array<string | undefined> = []
  params.push(fmt("readout", representation.readout))
  params.push(fmt("latent_dim", representation.latentDim ?? representation.latent_dim))
  const p = params.filter(Boolean).join(",")
  return p ? `${layout}(${p})` : layout
}

function formatCompositionDetail(composition: Record<string, unknown>): string {
  const type = typeof composition.type === "string" ? composition.type : "?"
  const params: Array<string | undefined> = []
  if (type === "parallel_two_branch") params.push(fmt("merge", composition.merge))
  if (type === "decomposition_two_branch") {
    params.push(fmt("kernel_size", composition.kernelSize ?? composition.kernel_size))
    params.push(fmt("merge", composition.merge))
  }
  const p = params.filter(Boolean).join(",")
  return p ? `${type}(${p})` : type
}

function formatFusionDetail(fusion: Record<string, unknown>): string {
  const type = typeof fusion.type === "string" ? fusion.type : "?"
  const params: Array<string | undefined> = []
  if (type === "temporal") {
    params.push(fmt("ch", fusion.channelMode ?? fusion.channel_mode))
  } else if (type === "feature") {
    if (fusion.crossAttention ?? fusion.cross_attention) params.push("xattn")
  } else if (type === "graph") {
    params.push(fmt("adj", fusion.adjacencySource ?? fusion.adjacency_source))
  } else if (type === "gated_hybrid") {
    params.push(fmt("gate", fusion.gateType ?? fusion.gate_type))
  }
  const p = params.filter(Boolean).join(",")
  return p ? `${type}(${p})` : type
}

function formatHeadDetail(head: Record<string, unknown>): string {
  const type = typeof head.type === "string" ? head.type : "?"
  const params: Array<string | undefined> = []
  if (type === "quantile") {
    const q = Array.isArray(head.quantiles) ? `q=[${head.quantiles.join(",")}]` : undefined
    if (q) params.push(q)
  } else if (type === "residual_correction") {
    params.push(fmt("base", head.baseHead ?? head.base_head))
    params.push(fmt("corrDim", head.correctionDim ?? head.correction_dim))
  }
  const p = params.filter(Boolean).join(",")
  return p ? `${type}(${p})` : type
}

function formatOptimizerDetail(opt: Record<string, unknown>): string {
  const type = typeof opt.type === "string" ? opt.type : "?"
  const params: Array<string | undefined> = []
  params.push(fmt("lr", opt.lr))
  if (typeof opt.weightDecay === "number" && opt.weightDecay > 0) params.push(fmt("wd", opt.weightDecay))
  if (typeof opt.weight_decay === "number" && opt.weight_decay > 0) params.push(fmt("wd", opt.weight_decay))
  const p = params.filter(Boolean).join(",")
  return p ? `${type}(${p})` : type
}

function formatSchedulerDetail(sched: Record<string, unknown>): string {
  const type = typeof sched.type === "string" ? sched.type : "?"
  if (type === "none") return "none"
  const params: Array<string | undefined> = []
  if (typeof sched.warmupSteps === "number" && sched.warmupSteps > 0) params.push(fmt("warmup", sched.warmupSteps))
  if (typeof sched.warmup_steps === "number" && sched.warmup_steps > 0) params.push(fmt("warmup", sched.warmup_steps))
  const p = params.filter(Boolean).join(",")
  return p ? `${type}(${p})` : type
}

export type ResearchCockpitCandidateRecipeLines = {
  architecture: string
  training: string
}

export function formatResearchCockpitCandidateRecipeLines(candidate: ResearchCockpitCandidate): ResearchCockpitCandidateRecipeLines {
  const spec = candidate.candidateSpec
  const preprocessingActions = Array.isArray(asRecord(spec.preprocessing).actions) ? (asRecord(spec.preprocessing).actions as unknown[]) : [{ type: "none" }]
  const prep = formatPreprocessingDetail(preprocessingActions)
  const emb = formatEmbeddingDetail(asRecord(spec.embedding))
  const bb = formatBackboneDetail(asRecord(spec.backbone))
  const representation = asRecord(spec.representation)
  const composition = asRecord(spec.composition)
  const secondary = asRecord(composition.secondary)
  const fusion = formatFusionDetail(asRecord(spec.fusion))
  const head = formatHeadDetail(asRecord(spec.predictionHead ?? spec.prediction_head))
  const strategy = asRecord(spec.trainingStrategy ?? spec.training_strategy)
  const lossRec = asRecord(strategy.loss)
  const lossBase = typeof lossRec.base === "string" ? lossRec.base : "?"
  const lossWeight = typeof lossRec.horizonWeighting === "string" && lossRec.horizonWeighting !== "uniform" ? `(${lossRec.horizonWeighting})` : ""
  const loss = `${lossBase}${lossWeight}`
  const opt = formatOptimizerDetail(asRecord(strategy.optimizer))
  const sched = formatSchedulerDetail(asRecord(strategy.scheduler))
  const architectureParts = [
    `prep=${prep}`,
    `emb=${emb}`,
    `backbone=${bb}`,
  ]
  if (Object.keys(representation).length > 0) architectureParts.push(`repr=${formatRepresentationDetail(representation)}`)
  if (Object.keys(composition).length > 0) {
    architectureParts.push(`composition=${formatCompositionDetail(composition)}`)
    if (Object.keys(secondary).length > 0) {
      const secondaryParts = [
        formatEmbeddingDetail(asRecord(secondary.embedding)),
        formatBackboneDetail(asRecord(secondary.backbone)),
      ]
      const secondaryRepresentation = asRecord(secondary.representation)
      if (Object.keys(secondaryRepresentation).length > 0) {
        secondaryParts.push(formatRepresentationDetail(secondaryRepresentation))
      }
      architectureParts.push(`secondary=${secondaryParts.join("->")}`)
    }
  }
  architectureParts.push(`fusion=${fusion}`, `head=${head}`)
  const architecture = architectureParts.join(" / ")
  const training = [
    `loss=${loss}`,
    `opt=${opt}`,
    `sched=${sched}`,
  ].join(" / ")
  return { architecture, training }
}

export function formatResearchCockpitCandidateArchitectureExpandedLines(candidate: { candidateSpec: JsonRecord }): string[] {
  const spec = candidate.candidateSpec
  const lines: string[] = []

  const prepActions = Array.isArray(asRecord(spec.preprocessing).actions)
    ? (asRecord(spec.preprocessing).actions as unknown[])
    : [{ type: "none" }]
  lines.push(`  preprocessing:  ${formatPreprocessingDetail(prepActions)}`)

  const embeddingDetail = formatEmbeddingExpandedDetail(asRecord(spec.embedding))
  const backboneDetail = formatBackboneDetail(asRecord(spec.backbone))
  const representation = asRecord(spec.representation)
  const representationDetail = Object.keys(representation).length > 0
    ? formatRepresentationDetail(representation).replaceAll(",", ", ")
    : undefined
  const composition = asRecord(spec.composition)
  const secondary = asRecord(composition.secondary)

  if (Object.keys(secondary).length > 0) {
    lines.push(`  composition:    ${formatCompositionDetail(composition).replaceAll(",", ", ")}`)
    lines.push("  primary:")
    lines.push(`    embedding:      ${embeddingDetail}`)
    lines.push(`    backbone:       ${backboneDetail}`)
    if (representationDetail) lines.push(`    representation: ${representationDetail}`)
    lines.push("  secondary:")
    lines.push(`    embedding:      ${formatEmbeddingExpandedDetail(asRecord(secondary.embedding))}`)
    lines.push(`    backbone:       ${formatBackboneDetail(asRecord(secondary.backbone)).replaceAll(",", ", ")}`)
    const secondaryRepresentation = asRecord(secondary.representation)
    if (Object.keys(secondaryRepresentation).length > 0) {
      lines.push(`    representation: ${formatRepresentationDetail(secondaryRepresentation).replaceAll(",", ", ")}`)
    }
  } else {
    lines.push(`  embedding:      ${embeddingDetail}`)
    lines.push(`  backbone:       ${backboneDetail}`)
    if (representationDetail) lines.push(`  representation: ${representationDetail}`)
    if (Object.keys(composition).length > 0) {
      lines.push(`  composition:    ${formatCompositionDetail(composition).replaceAll(",", ", ")}`)
    }
  }

  const fusion = asRecord(spec.fusion)
  const fusionType = typeof fusion.type === "string" ? fusion.type : "?"
  const fusionParams: string[] = []
  const channelMode = fusion.channelMode ?? fusion.channel_mode
  if (channelMode !== undefined) fusionParams.push(`channel_mode=${channelMode}`)
  lines.push(`  fusion:         ${fusionType}${fusionParams.length ? `(${fusionParams.join(", ")})` : ""}`)

  const head = asRecord(spec.predictionHead ?? spec.prediction_head)
  const headType = typeof head.type === "string" ? head.type : "?"
  const headParams: string[] = []
  const outputDist = head.outputDistribution ?? head.output_distribution
  if (outputDist !== undefined) headParams.push(`output_dist=${outputDist}`)
  const baseHead = head.baseHead ?? head.base_head
  if (baseHead !== undefined) headParams.push(`base_head=${baseHead}`)
  const correctionDim = head.correctionDim ?? head.correction_dim
  if (correctionDim !== undefined) headParams.push(`correction_dim=${correctionDim}`)
  lines.push(`  prediction_head: ${headType}${headParams.length ? `(${headParams.join(", ")})` : ""}`)

  const strategy = asRecord(spec.trainingStrategy ?? spec.training_strategy)
  const lossRec = asRecord(strategy.loss)
  const lossBase = typeof lossRec.base === "string" ? lossRec.base : "?"
  const lossHW = lossRec.horizonWeighting ?? lossRec.horizon_weighting
  const lossStr = typeof lossHW === "string" && lossHW !== "uniform" ? `${lossBase}(horizon_weighting=${lossHW})` : lossBase
  lines.push(`  loss:           ${lossStr}`)

  const opt = asRecord(strategy.optimizer)
  const optType = typeof opt.type === "string" ? opt.type : "?"
  const optParams: string[] = []
  const lr = opt.lr
  const wd = opt.weightDecay ?? opt.weight_decay
  if (lr !== undefined) optParams.push(`lr=${lr}`)
  if (typeof wd === "number" && wd > 0) optParams.push(`weight_decay=${wd}`)
  lines.push(`  optimizer:      ${optType}${optParams.length ? `(${optParams.join(", ")})` : ""}`)

  const sched = asRecord(strategy.scheduler)
  const schedType = typeof sched.type === "string" ? sched.type : "?"
  const schedParams: string[] = []
  const warmupSteps = sched.warmupSteps ?? sched.warmup_steps
  if (typeof warmupSteps === "number" && warmupSteps > 0) schedParams.push(`warmup_steps=${warmupSteps}`)
  lines.push(`  scheduler:      ${schedType}${schedParams.length ? `(${schedParams.join(", ")})` : ""}`)

  const reg = asRecord(strategy.regularization)
  const regParts: string[] = []
  const regDropout = reg.dropout
  const gradClip = reg.gradClip ?? reg.grad_clip
  if (typeof regDropout === "number") regParts.push(`dropout=${regDropout}`)
  if (typeof gradClip === "number") regParts.push(`grad_clip=${gradClip}`)
  if (regParts.length > 0) lines.push(`  regularization: ${regParts.join(", ")}`)

  return lines
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

// Used during task creation: only looks inside the given directory, never at siblings.
// This prevents false-positive resolution (e.g. resolving /tmp/foo to /tmp/neo-cast).
export function resolveNeoCastSubdirectory(projectRoot: string) {
  const root = projectRoot.trim()
  if (!root) return root
  const resolved = path.resolve(root)
  const subdirs = [path.join(resolved, "neo_cast"), path.join(resolved, "neo-cast")]
  return subdirs.find((candidate) => existsSync(path.join(candidate, "py", "validate.py"))) ?? resolved
}

// Used by the "Use Project Runner" repair command: broader search including sibling directories.
export function resolveResearchCockpitProjectRunnerRoot(projectRoot: string) {
  const root = projectRoot.trim()
  if (!root) return root
  const resolved = path.resolve(root)
  const candidates: string[] = []
  const seen = new Set<string>()
  const addCandidate = (candidate: string) => {
    if (seen.has(candidate)) return
    seen.add(candidate)
    candidates.push(candidate)
  }

  addCandidate(resolved)
  addCandidate(path.join(resolved, "neo_cast"))
  addCandidate(path.join(resolved, "neo-cast"))

  if (resolved.split(path.sep).includes("opencode")) {
    for (let current = path.dirname(resolved); ; current = path.dirname(current)) {
      addCandidate(path.join(current, "neo_cast"))
      addCandidate(path.join(current, "neo-cast"))
      if (current === path.dirname(current)) break
    }
  }

  return candidates.find((candidate) => existsSync(path.join(candidate, "py", "validate.py"))) ?? resolved
}

export function updateResearchCockpitTaskInteractionMode(
  task: ResearchCockpitTask,
  interactionMode: ResearchInteractionMode,
): ResearchCockpitTask {
  const taskSpec = asRecord(task.taskSpec)
  const metadata = asRecord(taskSpec.metadata)
  return {
    ...task,
    interactionMode,
    taskSpec: {
      ...taskSpec,
      metadata: {
        ...metadata,
        interactionMode,
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
  projectRoot?: string
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

function readPreparedDatasetSpecs(root: string) {
  const specPaths = [
    path.join(root, ".neo-cast", "dataset_spec.json"),
    path.join(root, ".neo-cast", "dataset", "dataset_spec.json"),
  ]
  const specs: JsonRecord[] = []
  for (const specPath of specPaths) {
    if (!existsSync(specPath)) continue
    try {
      const parsed = JSON.parse(readFileSync(specPath, "utf8"))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) specs.push(parsed as JsonRecord)
    } catch {
      continue
    }
  }
  return specs
}

function preparedDatasetSpecPayloadMatchesTask(prepared: JsonRecord, task: ResearchCockpitTask) {
  try {
    const taskSpec = asRecord(task.taskSpec)
    const dataset = asRecord(taskSpec.dataset)
    const taskDatasetPath = typeof dataset.path === "string" ? path.resolve(dataset.path) : undefined
    const sourceCsv = typeof prepared.source_csv === "string" ? path.resolve(prepared.source_csv) : undefined
    if (sourceCsv && taskDatasetPath && sourceCsv !== taskDatasetPath) return false

    const inputLen = typeof prepared.input_len === "number" ? prepared.input_len : undefined
    const contextLength = typeof taskSpec.contextLength === "number" ? taskSpec.contextLength : undefined
    if (inputLen !== undefined && contextLength !== undefined && inputLen !== contextLength) return false

    if (!arrayEquals(optionalNumberArray(taskSpec.predictionLengths), optionalNumberArray(prepared.horizons))) return false
    const targets = optionalStringArray(dataset.targetCols)
    const features = optionalStringArray(prepared.feature_columns)
    if (targets && features && targets.length > 0) {
      const featureSet = new Set(features)
      const anyTargetInFeatures = targets.some((target) => featureSet.has(target))
      // When none of the task targets appear in the prepared features, Python auto-inferred
      // the columns (e.g. custom CSV without explicit --feature-cols). Skip the check.
      if (anyTargetInFeatures && targets.some((target) => !featureSet.has(target))) return false
    }
    return true
  } catch {
    return false
  }
}

function preparedDatasetSpecMatchesTask(task: ResearchCockpitTask, root: string) {
  const preparedSpecs = readPreparedDatasetSpecs(root)
  const taskSpec = asRecord(task.taskSpec)
  const dataset = asRecord(taskSpec.dataset)
  const taskDatasetPath = typeof dataset.path === "string" ? path.resolve(dataset.path) : undefined
  if (preparedSpecs.length === 0) return taskDatasetPath === undefined
  return preparedSpecs.some((prepared) => preparedDatasetSpecPayloadMatchesTask(prepared, task))
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
  const projectRoot = path.resolve(options.projectRoot ?? process.env.NEO_CAST_PROJECT_ROOT ?? resolvedRoot)
  if (!preparedDatasetSpecMatchesTask(task, taskExecutionRoot(task, projectRoot))) {
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
  const runCount = compactValue(metadata.runCount)
  const candidateCount = compactValue(metadata.candidateCount)
  const reportPath = metadataString(metadata, "reportPath")
  const manifestPath = metadataString(metadata, "manifestPath")
  const copiedFiles = Array.isArray(metadata.copiedFiles)
    ? metadata.copiedFiles.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []
  const parts = [
    `${result.artifact.kind} exported: ${result.path}`,
    champion ? `champion=${champion}` : undefined,
    metricName && metricValue ? `${metricName}=${metricValue}` : undefined,
    runCount ? `runs=${runCount}` : undefined,
    candidateCount ? `candidates=${candidateCount}` : undefined,
    reportPath ? `report=${reportPath}` : undefined,
    manifestPath ? `manifest=${manifestPath}` : undefined,
    copiedFiles.length > 0 ? `files=${copiedFiles.join(", ")}` : undefined,
  ].filter((item): item is string => Boolean(item))
  return parts.join(" / ")
}

function formatMetric(value: unknown) {
  if (typeof value !== "number") return JSON.stringify(value)
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)))
}

function primaryMetricText(metrics: JsonRecord) {
  for (const key of ["cv_avg_mse", "val_avg_mse", "test_avg_mse", "mse", "loss"]) {
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
  const failed = result.iterations.filter((iteration) => iteration.run.status === "failed").length
  const pendingApprovals = result.iterations.reduce(
    (sum, iteration) => sum + iteration.approvals.filter((approval) => approval.status === "pending").length,
    0,
  )
  const seeded = result.iterations.reduce((sum, iteration) => sum + iteration.seededCandidates.length, 0)
  const bestIteration = result.iterations.find((iteration) => iteration.run.status === "succeeded")
  const selected = bestIteration ? ` / selected ${bestIteration.candidate.id} / ${primaryMetricText(bestIteration.run.metrics)}` : ""
  const selectionArtifact = result.iterations.find((iteration) => iteration.selectionArtifact)?.selectionArtifact
  const selection = selectionArtifact ? ` / selection ${formatResearchCockpitArtifactMetadata(selectionArtifact) ?? selectionArtifact.kind}` : ""
  const pending = pendingApprovals > 0 ? ` / ${pendingApprovals} approval pending` : ""
  const seededText = seeded > 0 ? ` / seeded=${seeded}` : ""
  const artifact = result.artifact ? ` / artifact ${result.artifact.kind}` : ""
  const iterationLabel = result.iterations.length === 1 ? "iteration" : "iterations"
  return `loop stopped: ${formatLoopStopReason(result.stoppedReason)} / ${result.iterations.length} ${iterationLabel} / ${succeeded} succeeded / ${failed} failed${pending}${seededText}${selected}${selection}${artifact}`
}

function formatLoopStopReason(reason: string) {
  if (reason === "max_iterations") return "reached max iterations"
  if (reason === "budget_exhausted") return "budget exhausted"
  if (reason === "no_candidate") return "no runnable candidate"
  if (reason === "approval_required") return "waiting for approval"
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

export type ResearchCockpitRefTestLine = {
  id: string
  text: string
  tone: "success" | "muted"
}

export function formatResearchCockpitRefTestLines(
  champion: ResearchCockpitChampion,
  refTestRun: ResearchCockpitRun,
): ResearchCockpitRefTestLine[] {
  const m = refTestRun.metrics as Record<string, unknown>
  const avgMse = typeof m.ref_test_avg_mse === "number" ? m.ref_test_avg_mse : undefined
  const avgMae = typeof m.ref_test_avg_mae === "number" ? m.ref_test_avg_mae : undefined
  const horizons = [96, 192, 336, 720]
  const horizonParts = horizons
    .map((h) => {
      const v = m[`ref_test_h${h}_mse`]
      return typeof v === "number" ? `h${h}=${formatMetric(v)}` : undefined
    })
    .filter((p): p is string => p !== undefined)

  const summaryParts = [
    avgMse !== undefined ? `ref_test_avg_mse=${formatMetric(avgMse)}` : undefined,
    avgMae !== undefined ? `avg_mae=${formatMetric(avgMae)}` : undefined,
  ].filter((p): p is string => p !== undefined)

  const lines: ResearchCockpitRefTestLine[] = [
    {
      id: `ref-test-summary-${refTestRun.id}`,
      text: `Test Set: champion ${champion.candidateID} / run ${refTestRun.id} / ${summaryParts.join(" / ") || "-"}`,
      tone: "success",
    },
  ]
  if (horizonParts.length > 0) {
    lines.push({
      id: `ref-test-horizons-${refTestRun.id}`,
      text: `  Horizons: ${horizonParts.join(" / ")}`,
      tone: "muted",
    })
  }
  return lines
}

export type ResearchCockpitLLMDesignLine = {
  id: string
  text: string
  tone: "primary" | "success" | "warning" | "error" | "muted"
}

export function formatResearchCockpitLLMDesignLines(
  artifact: ResearchCockpitArtifact | undefined,
): ResearchCockpitLLMDesignLine[] {
  if (!artifact || artifact.kind !== "research_manager_trace_json") return []
  const meta = artifact.metadata
  const llmStatus = typeof meta.llmStatus === "string" ? meta.llmStatus : undefined
  if (!llmStatus) return []
  const llmModel = typeof meta.llmModel === "string" ? meta.llmModel : undefined
  const llmProvider = typeof meta.llmProvider === "string" ? meta.llmProvider : undefined
  const llmError = typeof meta.llmError === "string" ? meta.llmError : undefined
  const llmHypothesis = typeof meta.llmHypothesis === "string" ? meta.llmHypothesis : undefined
  const llmRecipeID = typeof meta.llmRecipeID === "string" ? meta.llmRecipeID : undefined

  const modelLabel = llmModel ?? llmProvider ?? "LLM"
  const lines: ResearchCockpitLLMDesignLine[] = []

  if (llmStatus === "used") {
    const recipePart = llmRecipeID ? ` / ${llmRecipeID}` : ""
    lines.push({
      id: `llm-design-${artifact.id}-status`,
      text: `LLM ${modelLabel} → Generation succeeded${recipePart}`,
      tone: "success",
    })
    if (llmHypothesis) {
      const hypothesis = llmHypothesis.length > 120 ? `${llmHypothesis.slice(0, 117)}...` : llmHypothesis
      lines.push({
        id: `llm-design-${artifact.id}-hypothesis`,
        text: `  Hypothesis: ${hypothesis}`,
        tone: "muted",
      })
    }
  } else if (llmStatus === "failed" || llmStatus === "invalid") {
    const errorPart = llmError ? `: ${llmError.slice(0, 100)}` : ""
    lines.push({
      id: `llm-design-${artifact.id}-status`,
      text: `LLM ${modelLabel} → ${llmStatus}${errorPart}`,
      tone: "error",
    })
  } else if (llmStatus === "not_configured") {
    lines.push({
      id: `llm-design-${artifact.id}-status`,
      text: `LLM not configured — falling back to heuristic candidate`,
      tone: "warning",
    })
  }

  return lines
}

export type ResearchCockpitTaskAgentLLMLine = {
  id: string
  text: string
  tone: "success" | "warning" | "muted"
}

export function formatResearchCockpitTaskAgentLLMLines(
  artifacts: ResearchCockpitArtifact[],
): ResearchCockpitTaskAgentLLMLine[] {
  const lines: ResearchCockpitTaskAgentLLMLine[] = []

  const literatureArtifact = artifacts.find((a) => a.kind === "task_evidence_bundle_json")
  if (literatureArtifact) lines.push({ id: `literature-${literatureArtifact.id}`, text: literatureSummary(literatureArtifact.metadata), tone: "success" })
  const dataAnalysisArtifact = artifacts.find((a) => a.kind === "dataset_analysis_report")
  if (dataAnalysisArtifact) {
    const status = typeof dataAnalysisArtifact.metadata.llmStatus === "string" ? dataAnalysisArtifact.metadata.llmStatus : undefined
    const preview = typeof dataAnalysisArtifact.metadata.llmPreview === "string" ? dataAnalysisArtifact.metadata.llmPreview : undefined
    if (status === "used" && preview) {
      const clipped = preview.length > 160 ? `${preview.slice(0, 157)}...` : preview
      lines.push({ id: `llm-data-${dataAnalysisArtifact.id}-label`, text: `[DataAnalysis]`, tone: "muted" })
      lines.push({ id: `llm-data-${dataAnalysisArtifact.id}-preview`, text: `  ${clipped}`, tone: "muted" })
    }
  }

  // No hypo_plan_md preview here: HypoPlanner's full output is persisted into designLLMLines
  // on completion (research.agent.hypoPlanner.completed), so a preview here would duplicate it.

  return lines
}

export type TsfResearchTaskDefaults = {
  datasetPath?: string
  datasetPreset?: string
  targetCols?: string[]
  contextLength?: number
  predictionLengths?: number[]
  bridgeOnly?: boolean
  maxRuns?: number
  maxIterations?: number
  maxNoImprove?: number
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

function tsfRuntime(neoCastProjectRoot?: string, bridgeOnly = false): JsonRecord {
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
  if (task.interactionMode === "companion" || task.interactionMode === "socratic") return task.interactionMode
  const metadata = task.taskSpec.metadata
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const value = (metadata as JsonRecord).interactionMode
    if (value === "companion" || value === "socratic") return value
  }
  return interactionModeForTaskMode(task.mode)
}

export type SocraticClarificationState = {
  active: boolean
  reviewMode?: boolean
  missingSlots: string[]
  nextQuestion?: string
  questionCount: number
  slots: SocraticIntentSlot[]
}

export type SocraticIntentSlotID =
  | "interaction_mode"
  | "forecast_object"
  | "data_source"
  | "target_columns"
  | "lookback_window"
  | "prediction_horizon"
  | "exogenous_variables"
  | "business_context"
  | "primary_metric"
  | "secondary_metrics"
  | "error_preferences"
  | "latency_budget"
  | "parameter_budget"
  | "max_iterations"
  | "max_no_improve"
  | "interpretability"
  | "deployment_target"

export type SocraticIntentSlot = {
  id: SocraticIntentSlotID
  label: string
  question: string
  required?: boolean
  status: "filled" | "missing" | "review"
  value?: string
}

const socraticIntentSlotDefinitions: Array<Omit<SocraticIntentSlot, "status" | "value">> = [
  {
    id: "interaction_mode",
    label: "Interaction mode",
    question: "Should this task use Socratic mode: clarify requirements thoroughly first, then run autonomously?",
  },
  {
    id: "forecast_object",
    label: "Forecast object",
    question: "What exactly are you forecasting? Describe the business entity and the phenomenon to predict.",
  },
  {
    id: "data_source",
    label: "CSV dataset path",
    question: "Which CSV dataset path should NeoResearch use for profiling and execution?",
  },
  {
    id: "target_columns",
    label: "Target columns",
    question: "Which target columns should be forecast?",
  },
  {
    id: "lookback_window",
    label: "lookback window",
    question: "How long should the model's lookback window be?",
  },
  {
    id: "prediction_horizon",
    label: "Forecast horizons",
    question: "Which forecast horizons should be evaluated?",
  },
  {
    id: "exogenous_variables",
    label: "Exogenous variables",
    question: "Are there exogenous variables such as weather, holidays, prices, or events? If there are none, explicitly answer none.",
  },
  {
    id: "business_context",
    label: "Business context",
    question: "Which business decision or research judgment will this forecast support?",
  },
  {
    id: "primary_metric",
    label: "Primary metric",
    question: "Which validation metric should model search optimize?",
  },
  {
    id: "secondary_metrics",
    label: "Secondary metrics",
    required: false,
    question: "Which secondary metrics or trade-offs across horizons matter alongside the primary metric?",
  },
  {
    id: "error_preferences",
    label: "Error preferences",
    question: "Which errors matter most: short-term, long-term, peak, average error, or stability?",
  },
  {
    id: "latency_budget",
    label: "Latency budget",
    question: "Is there a deployment or inference latency budget, such as per-request latency, a batch window, or no hard constraint?",
  },
  {
    id: "parameter_budget",
    label: "Parameter budget",
    question: "What limits apply to model parameters or resource usage?",
  },
  {
    id: "max_iterations",
    label: "Planned NAS iterations",
    required: false,
    question: "How many NAS iterations are planned? Confirm the default of 25 or provide a new limit. The system safety cap applies independently.",
  },
  {
    id: "max_no_improve",
    label: "Iterations without improvement",
    required: false,
    question: "After how many consecutive NAS iterations without improvement should search stop early? Confirm or change the default of 7.",
  },
  {
    id: "interpretability",
    label: "Interpretability",
    question: "Do you need interpretability, ablation explanations, or a preference for simple models?",
  },
  {
    id: "deployment_target",
    label: "Deployment target",
    question: "Where will the final model be deployed: local CPU, a GPU service, an edge device, offline batch processing, or a research report only?",
  },
]

export function buildSocraticClarificationState(
  task: ResearchCockpitTask | undefined,
  approvals: ResearchCockpitApproval[],
  options: { includeCompanion?: boolean } = {},
): SocraticClarificationState {
  const interactionMode = interactionModeForTask(task)
  const includeSlotOverview = interactionMode === "socratic" || (options.includeCompanion === true && interactionMode === "companion")
  if (!includeSlotOverview) return { active: false, missingSlots: [], questionCount: 0, slots: [] }

  // Intent review mode: user rejected the intent checkpoint and needs to modify slots.
  const taskSpec = asRecord(task?.taskSpec)
  const metadata = asRecord(taskSpec.metadata)
  if (metadata.intentPendingReview === true && task?.status === "idle") {
    const slots = socraticSlotsForTaskReview(task)
    const firstReviewSlot = slots.find((s) => s.status === "review")
    return {
      active: true,
      reviewMode: true,
      missingSlots: slots.map((s) => s.id),
      nextQuestion: firstReviewSlot?.question,
      questionCount: slots.length,
      slots,
    }
  }

  // includeSlotOverview above already restricts us to "socratic" or (companion with
  // includeCompanion) — so look up the pending protocol approval for either mode. Gating
  // this to "socratic" only used to mean companion tasks fell through to the static
  // taskMissingSlots fallback below instead of clarification.active=true, which hid the
  // live IntentAgent stream (tool calls, real LLM questions) behind the bare approval-reason
  // text in the cockpit's render path.
  //
  // ask_user creates a new pending "protocol" approval per question and never resolves the
  // previous one, so several can be pending at once. Only the most-recently-updated pending
  // protocol approval reflects the agent's current state — if we matched ANY pending
  // ask_user approval regardless of recency, a stale one would keep clarification.active=true
  // forever and mask the newer check_taskspec/intent_confirmed checkpoint approval that's
  // supposed to render instead once intent gathering finishes.
  const latestPendingProtocol = approvals
    .filter((item) => item.status === "pending" && item.kind === "protocol")
    .toSorted((a, b) => b.time.updated - a.time.updated)[0]
  const approval =
    latestPendingProtocol &&
    /research intent clarification required|intent clarification required|clarify research intent/i.test(latestPendingProtocol.reason)
      ? latestPendingProtocol
      : undefined
  const questions = approval
    ? approval.reason
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean)
    : []
  const approvalMissingSlots = questions.map(slotFromSocraticQuestion).filter((slot) => slot !== "unknown")
  const slots = socraticSlotsForTask(task, new Set(approvalMissingSlots))
  const taskMissingSlots = slots.filter((slot) => slot.status === "missing").map((slot) => slot.id)
  if (!approval) {
    const firstMissing = slots.find((slot) => slot.status === "missing")
    return {
      active: false,
      missingSlots: taskMissingSlots,
      nextQuestion: firstMissing?.question,
      questionCount: taskMissingSlots.length,
      slots,
    }
  }
  const missingSlots = approvalMissingSlots.length > 0 ? approvalMissingSlots : taskMissingSlots
  const nextQuestion =
    questions[0] ??
    socraticIntentSlotDefinitions.find((slot) => slot.id === missingSlots[0])?.question ??
    slots.find((slot) => slot.status === "missing")?.question
  return {
    active: true,
    missingSlots,
    nextQuestion,
    questionCount: missingSlots.length,
    slots,
  }
}

export function slotFromSocraticQuestion(question: string): string {
  if (/csv.*(?:dataset|path)|dataset path/i.test(question)) return "data_source"
  if (/target.*col/i.test(question)) return "target_columns"
  if (/lookback.*window|lookback/i.test(question)) return "lookback_window"
  if (/horizon|predictionLength/i.test(question)) return "prediction_horizon"
  if (/exogenous/i.test(question)) return "exogenous_variables"
  if (/business.*(?:context|decision)/i.test(question)) return "business_context"
  if (/primary.*metric|optimi[sz].*metric|metric.*optimi[sz]/i.test(question)) return "primary_metric"
  if (/secondary.*metric/i.test(question)) return "secondary_metrics"
  if (/error.*prefer|errors matter/i.test(question)) return "error_preferences"
  if (/latency.*budget/i.test(question)) return "latency_budget"
  if (/parameter.*budget|limits.*parameters/i.test(question)) return "parameter_budget"
  if (/without improvement|no.?improve/i.test(question)) return "max_no_improve"
  if (/NAS.*iterations|planned.*iterations|max.?iterations/i.test(question)) return "max_iterations"
  if (/interpretab/i.test(question)) return "interpretability"
  if (/deployment.*target|model.*deployed/i.test(question)) return "deployment_target"
  if (/interaction.*mode|Socratic mode|Companion mode/i.test(question)) return "interaction_mode"
  if (/forecast.*object|what.*forecasting/i.test(question)) return "forecast_object"
  return "unknown"
}

function socraticSlotsForTask(task: ResearchCockpitTask | undefined, forcedMissing: Set<string>) {
  const taskSpec = asRecord(task?.taskSpec)
  const dataset = asRecord(taskSpec.dataset)
  const objective = asRecord(task?.objective)
  const budget = asRecord(task?.budget)
  const metadata = asRecord(taskSpec.metadata)
  const intentSlots = asRecord(metadata.intentSlots)
  return socraticIntentSlotDefinitions.map((slot) => {
    // intentSlots (from update_taskspec / legacy answerIntentQuestion) override everything
    const answeredValue = intentSlots[slot.id] !== undefined
      ? String(intentSlots[slot.id])
      : undefined
    const value =
      answeredValue ??
      socraticSlotValue(slot.id, dataset, taskSpec, objective, budget, metadata) ??
      (slot.id === "interaction_mode" ? interactionModeForTask(task) : undefined)
    const isRequired = slot.required !== false
    const missing = forcedMissing.has(slot.id) || (value === undefined && isRequired)
    return {
      ...slot,
      status: missing ? ("missing" as const) : ("filled" as const),
      ...(value !== undefined ? { value } : {}),
    }
  })
}

// In review mode (after intent reject), all slots cycle as "review" so the user can
// confirm or override each one. The question carries the current value as a reminder.
function socraticSlotsForTaskReview(task: ResearchCockpitTask): SocraticIntentSlot[] {
  const taskSpec = asRecord(task.taskSpec)
  const dataset = asRecord(taskSpec.dataset)
  const objective = asRecord(task.objective)
  const budget = asRecord(task.budget)
  const metadata = asRecord(taskSpec.metadata)
  const intentSlots = asRecord(metadata.intentSlots)
  return socraticIntentSlotDefinitions.map((slot) => {
    const answeredValue = intentSlots[slot.id] !== undefined ? String(intentSlots[slot.id]) : undefined
    const value =
      answeredValue ??
      socraticSlotValue(slot.id, dataset, taskSpec, objective, budget, metadata) ??
      (slot.id === "interaction_mode" ? interactionModeForTask(task) : undefined)
    const reviewQuestion = value !== undefined
      ? `${slot.question} (current: ${value})`
      : slot.question
    return {
      ...slot,
      question: reviewQuestion,
      status: "review" as const,
      ...(value !== undefined ? { value } : {}),
    }
  })
}

function socraticSlotValue(
  slot: SocraticIntentSlotID,
  dataset: Record<string, unknown>,
  taskSpec: Record<string, unknown>,
  objective: Record<string, unknown>,
  budget: Record<string, unknown>,
  metadata: Record<string, unknown>,
): string | undefined {
  if (slot === "interaction_mode") {
    const value = metadata.interactionMode ?? metadata.interaction_mode
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
  }
  if (slot === "forecast_object") {
    const value = taskSpec.forecastObject ?? taskSpec.predictionObject ?? metadata.forecastObject
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
  }
  if (slot === "data_source") {
    const value = dataset.path
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
  }
  if (slot === "target_columns") {
    const values = optionalStringArray(dataset.targetCols)
    return values && values.length > 0 ? values.join(",") : undefined
  }
  if (slot === "lookback_window") {
    const value = taskSpec.contextLength
    return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined
  }
  if (slot === "prediction_horizon") {
    const values = optionalNumberArray(taskSpec.predictionLengths)
    return values && values.length > 0 ? values.join(",") : undefined
  }
  if (slot === "exogenous_variables") {
    const value = dataset.exogenousCols ?? dataset.exogenousVariables ?? dataset.knownFutureCovariates
    if (Array.isArray(value)) return value.join(",") || "none"
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
  }
  if (slot === "business_context") {
    const value = taskSpec.businessContext ?? taskSpec.business_context ?? objective.businessContext ?? metadata.businessContext ?? metadata.userPrompt
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
  }
  if (slot === "primary_metric") {
    const value = objective.primaryMetric
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
  }
  if (slot === "secondary_metrics") {
    const values = optionalStringArray(objective.secondaryMetrics)
    return values && values.length > 0 ? values.join(",") : undefined
  }
  if (slot === "error_preferences") {
    const value = objective.errorPreferences ?? objective.errorPreference
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
  }
  if (slot === "latency_budget") {
    const value = budget.latencyBudget
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
  }
  if (slot === "parameter_budget") {
    const value = budget.parameterBudget
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
  }
  if (slot === "max_iterations") {
    const loop = asRecord(budget.loop ?? budget.researchLoop ?? budget.autonomousLoop)
    const value = loop.maxIterations
    return typeof value === "number" && Number.isFinite(value) ? String(value) : String(NAS_DEFAULT_MAX_ITERATIONS)
  }
  if (slot === "max_no_improve") {
    const loop = asRecord(budget.loop ?? budget.researchLoop ?? budget.autonomousLoop)
    const value = loop.maxNoImprove ?? loop.maxNoImproveRounds
    return typeof value === "number" && Number.isFinite(value) ? String(value) : String(NAS_DEFAULT_MAX_NO_IMPROVE)
  }
  if (slot === "interpretability") {
    const value = taskSpec.interpretability ?? objective.interpretability ?? metadata.interpretability
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
  }
  if (slot === "deployment_target") {
    const runtime = asRecord(taskSpec.runtime)
    const value = runtime.deploymentTarget ?? taskSpec.deploymentTarget ?? metadata.deploymentTarget
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
  }
  return undefined
}

export function researchInteractionModeLabel(mode: ResearchInteractionMode | undefined) {
  if (mode === "companion") return "Companion"
  if (mode === "socratic") return "Socratic"
  return "Not selected"
}

export function taskModeForInteractionMode(mode: ResearchInteractionMode): ResearchCockpitTask["mode"] {
  // Both Socratic and Companion interaction modes require autonomous task mode.
  // Socratic runs fully autonomous after initial clarification; Companion pauses at checkpoints.
  return "autonomous"
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
  const resolvedMode = defaults.interactionMode === undefined ? mode : taskModeForInteractionMode(interactionMode)
  const userPrompt =
    typeof defaults.metadata?.userPrompt === "string" && defaults.metadata.userPrompt.trim().length > 0
      ? defaults.metadata.userPrompt.trim()
      : undefined
  const metadata: JsonRecord = {
    businessContext: userPrompt ?? "General time-series forecasting model development.",
    interpretability: "prefer simple explainable candidates when metrics are close",
    deploymentTarget: "local research runtime",
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
    mode: resolvedMode,
    interactionMode,
    taskSpec: {
      contextLength: defaults.contextLength ?? 336,
      predictionLengths:
        defaults.predictionLengths && defaults.predictionLengths.length > 0 ? defaults.predictionLengths : [96],
      dataset: {
        loaderID: nonEmpty(defaults.datasetPreset) ?? (datasetPath ? "local_csv" : "etth1_tslib_v1"),
        ...(datasetPath ? { path: datasetPath } : {}),
        targetCols: defaults.targetCols && defaults.targetCols.length > 0 ? defaults.targetCols : (datasetPath ? [] : ["OT"]),
        knownFutureCovariates: [],
        observedPastCovariates: [],
        staticCovariates: [],
      },
      ...(Object.keys(constraints).length === 0 ? {} : { constraints }),
      metadata,
      runtime: tsfRuntime(neoCastProjectRoot, defaults.bridgeOnly ?? false),
    },
    objective: {
      primaryMetric: "cv_avg_mse",
      secondaryMetrics: ["cv_std_mse", "val_avg_mse"],
      errorPreferences: "minimize time-ordered cross-validation error while monitoring temporal stability and final-checkpoint validation",
      direction: "minimize",
    },
    budget: {
      maxRuns: defaults.maxRuns ?? RESEARCH_MAX_RUNS_SAFETY_LIMIT,
      maxParallel: RESEARCH_MAX_PARALLEL_EXPERIMENTS,
      latencyBudget: "offline batch scoring unless the user specifies stricter latency",
      parameterBudget: "prefer lightweight models under 20M parameters when accuracy is close",
      loop: {
        maxIterations: defaults.maxIterations ?? NAS_DEFAULT_MAX_ITERATIONS,
        maxNoImprove: defaults.maxNoImprove ?? NAS_DEFAULT_MAX_NO_IMPROVE,
        ...(defaults.maxTrainingSeconds === undefined ? {} : { timeBudgetSeconds: defaults.maxTrainingSeconds }),
      },
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

export type ResearchLLMTokenTotals = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  callCount: number
}

export function computeResearchLLMTokenTotals(artifacts: ResearchCockpitArtifact[]): ResearchLLMTokenTotals {
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let callCount = 0
  for (const artifact of artifacts) {
    const m = artifact.metadata
    const input = typeof m.llmInputTokens === "number" && Number.isFinite(m.llmInputTokens) ? m.llmInputTokens : 0
    const output = typeof m.llmOutputTokens === "number" && Number.isFinite(m.llmOutputTokens) ? m.llmOutputTokens : 0
    if (input > 0 || output > 0) {
      inputTokens += input
      outputTokens += output
      cacheReadTokens += typeof m.llmCacheReadTokens === "number" && Number.isFinite(m.llmCacheReadTokens) ? m.llmCacheReadTokens : 0
      cacheWriteTokens += typeof m.llmCacheWriteTokens === "number" && Number.isFinite(m.llmCacheWriteTokens) ? m.llmCacheWriteTokens : 0
      callCount++
    }
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, callCount }
}

export function getLatestResearchInputTokens(artifacts: ResearchCockpitArtifact[]): number {
  for (let i = artifacts.length - 1; i >= 0; i--) {
    const m = artifacts[i].metadata
    const input = typeof m.llmInputTokens === "number" && Number.isFinite(m.llmInputTokens) ? m.llmInputTokens : 0
    if (input > 0) return input
  }
  return 0
}
