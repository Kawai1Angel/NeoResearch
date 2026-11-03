import type { LoopProgress, LoopState } from "@/research/loop-state-schema"

export const loopPhaseLabel = (phase: LoopProgress["phase"]) =>
  phase === null
    ? "Between designs"
    : {
        design: "ModelDesigner Agent",
        training: "Training",
        trial_finalization: "Finalize training result",
        training_reflection: "Training Reflection",
        optimization: "OptimizerAgent",
        architecture_reflection: "Architecture Reflection",
        outer_planning: "HypoPlanner Agent",
      }[phase]

export function loopBudgetLines(state: LoopProgress, now: number) {
  const budget = state.budget
  const count = (used: number, limit: number | null) => `${used}/${limit ?? "unbound"}`
  const remaining = budget.deadlineAt === null ? null : Math.max(0, Math.ceil((budget.deadlineAt - now) / 1000))
  const time =
    remaining === null
      ? "no deadline"
      : remaining === 0
        ? "deadline expired"
        : `${Math.floor(remaining / 60)}m ${remaining % 60}s left`
  return [
    `Full training ${count(budget.trainingUsed, budget.trainingLimit)} · Run records ${count(budget.runRecordsUsed, budget.runRecordsLimit)}`,
    `${time} · ${Math.floor(budget.elapsedSeconds)}s elapsed`,
  ]
}

export function loopRecoveryLine(state: LoopState) {
  const recovery = state.recovery
  if (recovery.recoveryState === "needs_reconciliation") return `Reconciliation required: ${recovery.summary}`
  if (["blocked", "waiting_input"].includes(recovery.recoveryState))
    return `${recovery.recoveryState}: ${recovery.summary}`
  const design = state.designs.find((item) => item.id === state.activeDesignID)
  const trial = design?.trials.find((item) => item.id === state.activeTrialID)
  if (state.stoppedReason && !state.activeDesignID) return `Search stopped: ${state.stoppedReason}`
  const position = [
    state.phase ? loopPhaseLabel(state.phase) : null,
    design ? `Design ${design.index}` : null,
    trial ? `Trial ${trial.index}` : null,
  ]
    .filter(Boolean)
    .join(" · ")
  if (recovery.recoveryState === "running") return `Running: ${position || recovery.currentPhase}`
  if (recovery.recoveryState === "completed") return "Research complete · results retained"
  return `Resume at: ${position || recovery.currentPhase}`
}

type WorkflowItem = { label: string; displayLabel?: string; detail?: string; status: "done" | "active" | "todo" }
export function loopWorkflow(items: WorkflowItem[], state: LoopProgress | undefined): WorkflowItem[] {
  if (!state?.designs.length) return items
  const design = state.designs.find((item) => item.active) ?? state.designs.at(-1)!
  const trial = design.trials.find((item) => item.id === design.currentTrialID) ?? design.trials.at(-1)
  const terminal = (status: string | undefined) => status !== undefined && !["queued", "running"].includes(status)
  const statuses: Record<string, boolean> = {
    "HypoPlanner Agent": state.phase !== "outer_planning",
    "ModelDesigner Agent": state.phase !== "design",
    "ModelCompiler Agent": trial?.smoke?.status === "succeeded",
    "TrainEval Agent": terminal(trial?.full?.status),
    "Training Reflection": Boolean(trial && trial.trainingReflection.status !== "pending"),
    OptimizerAgent: Boolean(trial?.optimizerDecision) || design.status !== "optimizing",
    "Architecture Reflection": design.architectureReflection.status !== "pending",
  }
  const active =
    state.phase === "training" || state.phase === "trial_finalization"
      ? trial?.full
        ? "TrainEval Agent"
        : "ModelCompiler Agent"
      : state.phase
        ? loopPhaseLabel(state.phase)
        : undefined
  return items.flatMap((item) => {
    const labels =
      item.label === "Reflection Agent"
        ? ["Training Reflection", "OptimizerAgent", "Architecture Reflection"]
        : [item.label]
    return labels.map((label) => ({
      ...item,
      label,
      displayLabel:
        label === "ModelDesigner Agent"
          ? `ModelDesigner Agent (Design ${state.phase === "design" && !state.activeDesignID ? design.index + 1 : design.index})`
          : label,
      status:
        active === label
          ? ("active" as const)
          : label in statuses
            ? statuses[label]
              ? ("done" as const)
              : ("todo" as const)
            : item.status,
    }))
  })
}

export type LoopAgentView = {
  key: string
  label: string
  taskID: string
  designID: string
  trialID?: string
  cycleID?: string
  status: "started" | "completed" | "failed"
  text: string
  summary: string
  durationMs?: number
  startedAt: number
}
type Payload = { type: string; properties?: Record<string, unknown> }
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {}

/** Scope streams independently; repeated terminal events never append a second result. */
export function updateLoopAgentViews(
  previous: Record<string, LoopAgentView>,
  taskID: string | undefined,
  event: Payload,
) {
  const data = event.properties ?? {},
    meta = { ...data, ...record(data.metadata) }
  if (!taskID || data.taskID !== taskID || typeof meta.designID !== "string") return
  const optimizer = event.type.startsWith("research.agent.optimizer.")
  const scoped =
    event.type.startsWith("research.agent.reflection.") &&
    ["training", "architecture"].includes(String(meta.reflectionScope))
  if (!optimizer && !scoped) return
  const label = optimizer
    ? "OptimizerAgent"
    : meta.reflectionScope === "training"
      ? "Training Reflection"
      : "Architecture Reflection"
  const trialID = typeof meta.trialID === "string" ? meta.trialID : undefined
  const key = `${taskID}:${meta.designID}:${trialID ?? "design"}:${label}`
  const old = previous[key]
  const suffix = event.type.split(".").at(-1)
  if (old?.status === "completed" && suffix === "started") return { views: previous, view: old, terminal: false }
  if (!["started", "completed", "failed", "delta"].includes(suffix ?? "")) return
  if (suffix === "delta" && (!old || old.status !== "started")) return { views: previous, view: old, terminal: false }
  if (old?.status === suffix) return { views: previous, view: old, terminal: false }
  // A late stream fragment cannot reopen a completed stage.
  const status = suffix === "delta" ? "started" : (suffix as LoopAgentView["status"])
  const decision = record(meta.decision)
  const summary =
    status === "completed"
      ? optimizer
        ? `${decision.action ?? "completed"}: ${decision.rationale ?? ""}`
        : String(meta.summary ?? meta.analysisStatus ?? "completed")
      : status === "failed"
        ? String(meta.error ?? meta.message ?? "failed")
        : "reasoning"
  const view: LoopAgentView = {
    key,
    label,
    taskID,
    designID: meta.designID,
    trialID,
    cycleID: typeof meta.cycleID === "string" ? meta.cycleID : undefined,
    startedAt: typeof meta.startedAt === "number" ? meta.startedAt : (old?.startedAt ?? Date.now()),
    status,
    text:
      suffix === "delta" ? (old?.text ?? "") + String(data.delta ?? "") : status === "started" ? "" : (old?.text ?? ""),
    summary,
    durationMs: typeof meta.durationMs === "number" ? meta.durationMs : undefined,
  }
  return { views: { ...previous, [key]: view }, view, terminal: status !== "started" }
}
