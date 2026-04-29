import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useTextareaKeybindings } from "@tui/component/textarea-keybindings"
import { useEvent } from "@tui/context/event"
import { useRoute } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useToast } from "@tui/ui/toast"
import {
  buildDefaultTsfResearchTask,
  buildResearchCockpitRecommendation,
  buildResearchCockpitStats,
  buildResearchCockpitWorkflow,
  canExecuteResearchCockpitTask,
  canRunResearchCockpitCandidate,
  formatResearchCockpitArtifactMetadata,
  formatResearchCockpitExport,
  formatResearchCockpitFingerprint,
  formatResearchCockpitIteration,
  formatResearchCockpitLoop,
  formatResearchCockpitMemory,
  formatResearchCockpitMemoryFingerprint,
  formatResearchCockpitProfile,
  formatResearchCockpitRunResult,
  formatResearchCockpitSeedSweep,
  hasApprovedResearchCockpitBlindTestGate,
  hasApprovedResearchCockpitRefTestGate,
  parseTsfCsvTaskInput,
  researchCockpitArtifactTarget,
  researchCockpitCandidatePipeline,
  researchCockpitCandidateTitle,
  shouldRefreshResearchCockpitOnEvent,
  sortResearchCockpitTasks,
  type CreateResearchTaskInput,
  type JsonRecord,
  type ResearchCockpitApproval,
  type ResearchCockpitArtifact,
  type ResearchCockpitCandidate,
  type ResearchCockpitChampion,
  type ResearchCockpitExportResult,
  type ResearchCockpitIterationResult,
  type ResearchCockpitLoopResult,
  type ResearchCockpitMemory,
  type ResearchCockpitProfileResult,
  type ResearchCockpitRun,
  type ResearchCockpitSeedSweepResult,
  type ResearchCockpitTask,
  type ResearchCockpitWorkflowStatus,
  type TsfResearchTaskDefaults,
} from "./research-cockpit-data"

type CandidateRunStage = Extract<NonNullable<ResearchCockpitRun["stage"]>, "smoke" | "ref_test" | "blind_test">

async function researchRequest<T>(sdk: ReturnType<typeof useSDK>, path: string, init: RequestInit = {}): Promise<T> {
  const url = new URL(path, sdk.url)
  if (sdk.directory) url.searchParams.set("directory", sdk.directory)

  const headers = new Headers(init.headers)
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }

  const response = await sdk.fetch(url, {
    ...init,
    headers,
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `${response.status} ${response.statusText}`)
  }
  return (await response.json()) as T
}

function shortID(value: string | undefined) {
  if (!value) return "-"
  return value.slice(0, 8)
}

function formatError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 180 ? text.slice(0, 177) + "..." : text
}

function metricText(metrics: JsonRecord) {
  for (const key of ["val_avg_mse", "test_avg_mse", "mse", "loss"]) {
    const value = metrics[key]
    if (typeof value === "number") return `${key} ${value.toPrecision(4)}`
  }
  return "-"
}

function workflowMark(status: ResearchCockpitWorkflowStatus) {
  if (status === "done") return "[x]"
  if (status === "active") return "[o]"
  return "[ ]"
}

const cockpitColors = {
  background: "#11111b",
  panel: "#1e1e2e",
  sidebar: "#1a1b2a",
  border: "#313244",
  text: "#cdd6f4",
  textMuted: "#8f94b8",
  primary: "#f5a97f",
  success: "#a6da95",
  warning: "#eed49f",
  error: "#ed8796",
}

function workflowColor(status: ResearchCockpitWorkflowStatus) {
  if (status === "done") return cockpitColors.text
  if (status === "active") return cockpitColors.primary
  return cockpitColors.textMuted
}

function promptTaskTitle(value: string) {
  return value.length > 72 ? `${value.slice(0, 69)}...` : value
}

export function ResearchCockpit() {
  let promptInput: TextareaRenderable | undefined
  let focusTimer: ReturnType<typeof setTimeout> | undefined
  let promptEventID = 0
  const sdk = useSDK()
  const event = useEvent()
  const route = useRoute()
  const command = useCommandDialog()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const textareaKeybindings = useTextareaKeybindings()
  const [refresh, setRefresh] = createSignal(0)
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [busy, setBusy] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [promptEvents, setPromptEvents] = createSignal<Array<{ id: number; text: string; taskID?: string; detail?: string }>>(
    [],
  )
  let routedGoalHandled: string | undefined

  onMount(() => {
    focusTimer = setTimeout(() => promptInput?.focus(), 0)
  })
  onCleanup(() => {
    if (focusTimer) clearTimeout(focusTimer)
  })

  const [tasks] = createResource(refresh, async () => {
    return researchRequest<ResearchCockpitTask[]>(sdk, "/research/tasks?limit=30")
  })

  const sortedTasks = createMemo(() => sortResearchCockpitTasks(tasks() ?? []))
  const selectedTask = createMemo(() => sortedTasks()[selectedIndex()])
  const selectedTaskSource = createMemo(() => {
    const task = selectedTask()
    if (!task) return undefined
    return {
      taskID: task.id,
      refresh: refresh(),
    }
  })

  createEffect(() => {
    const count = sortedTasks().length
    if (count === 0 && selectedIndex() !== 0) {
      setSelectedIndex(0)
      return
    }
    if (count > 0 && selectedIndex() >= count) {
      setSelectedIndex(count - 1)
    }
  })

  const unsubscribeResearchEvents = event.subscribe((payload) => {
    if (!shouldRefreshResearchCockpitOnEvent(payload)) return
    setRefresh((value) => value + 1)
  })
  onCleanup(unsubscribeResearchEvents)

  createEffect(() => {
    const researchGoal = route.data.type === "cockpit" ? route.data.researchGoal?.trim() : undefined
    if (!researchGoal || routedGoalHandled === researchGoal) return
    routedGoalHandled = researchGoal
    void createTaskFromPrompt(researchGoal, "home")
  })

  const [runs] = createResource(selectedTaskSource, async (source) => {
    return researchRequest<ResearchCockpitRun[]>(sdk, `/research/tasks/${encodeURIComponent(source.taskID)}/runs`)
  })

  const [candidates] = createResource(selectedTaskSource, async (source) => {
    return researchRequest<ResearchCockpitCandidate[]>(
      sdk,
      `/research/tasks/${encodeURIComponent(source.taskID)}/candidates`,
    )
  })

  const [artifacts] = createResource(selectedTaskSource, async (source) => {
    return researchRequest<ResearchCockpitArtifact[]>(
      sdk,
      `/research/tasks/${encodeURIComponent(source.taskID)}/artifacts`,
    )
  })

  const [memory] = createResource(selectedTaskSource, async (source) => {
    return researchRequest<ResearchCockpitMemory[]>(sdk, `/research/tasks/${encodeURIComponent(source.taskID)}/memory`)
  })

  const [taskFingerprint] = createResource(selectedTaskSource, async (source) => {
    return researchRequest<JsonRecord>(sdk, `/research/tasks/${encodeURIComponent(source.taskID)}/fingerprint`)
  })

  const [approvals] = createResource(selectedTaskSource, async (source) => {
    return researchRequest<ResearchCockpitApproval[]>(
      sdk,
      `/research/tasks/${encodeURIComponent(source.taskID)}/approvals?limit=20`,
    )
  })

  const [champion] = createResource(selectedTaskSource, async (source) => {
    return researchRequest<ResearchCockpitChampion | null>(
      sdk,
      `/research/tasks/${encodeURIComponent(source.taskID)}/champion`,
    )
  })

  const stats = createMemo(() =>
    buildResearchCockpitStats({
      tasks: tasks() ?? [],
      candidates: candidates() ?? [],
      artifacts: artifacts() ?? [],
      memory: memory() ?? [],
      runs: runs() ?? [],
      approvals: approvals() ?? [],
    }),
  )

  const pendingApproval = createMemo(() => approvals()?.find((approval) => approval.status === "pending"))
  const runnerReady = createMemo(() => canExecuteResearchCockpitTask(selectedTask()))
  const taskCandidates = createMemo(() => candidates() ?? [])
  const taskRuns = createMemo(() => runs() ?? [])
  const taskArtifacts = createMemo(() => artifacts() ?? [])
  const taskApprovals = createMemo(() => approvals() ?? [])
  const commandCandidate = () => taskCandidates()[0]
  const workflowItems = createMemo(() =>
    buildResearchCockpitWorkflow({
      task: selectedTask(),
      candidates: taskCandidates(),
      runs: taskRuns(),
      artifacts: taskArtifacts(),
      approvals: taskApprovals(),
      champion: champion() ?? null,
      fingerprint: taskFingerprint() ?? {},
      runnerReady: runnerReady(),
    }),
  )
  const recommendation = createMemo(() =>
    buildResearchCockpitRecommendation({
      task: selectedTask(),
      candidates: taskCandidates(),
      runs: taskRuns(),
      artifacts: taskArtifacts(),
      approvals: taskApprovals(),
      champion: champion() ?? null,
      fingerprint: taskFingerprint() ?? {},
      runnerReady: runnerReady(),
    }),
  )
  const statusColor = (status: string) => {
    if (["completed", "succeeded", "approved", "auto_approved", "accepted", "ready"].includes(status))
      return cockpitColors.success
    if (["failed", "rejected"].includes(status)) return cockpitColors.error
    if (["researching", "running", "queued", "baselining", "profiling", "pending"].includes(status))
      return cockpitColors.warning
    return cockpitColors.textMuted
  }

  async function runAction(name: string, fn: () => Promise<string>) {
    if (busy()) return
    setBusy(name)
    setError(undefined)
    try {
      const message = await fn()
      toast.show({ variant: "info", message })
      setRefresh((value) => value + 1)
    } catch (err) {
      const message = formatError(err)
      setError(message)
      toast.show({ variant: "error", message })
    } finally {
      setBusy(undefined)
    }
  }

  async function createTask(mode: ResearchCockpitTask["mode"], defaults: TsfResearchTaskDefaults = {}) {
    await runAction(`create-${mode}`, async () => {
      const payload: CreateResearchTaskInput = buildDefaultTsfResearchTask(mode, sdk.directory ?? process.cwd(), defaults)
      const task = await researchRequest<ResearchCockpitTask>(sdk, "/research/tasks", {
        method: "POST",
        body: JSON.stringify(payload),
      })
      setSelectedIndex(0)
      return `${task.title} created`
    })
  }

  async function createCsvTask(mode: ResearchCockpitTask["mode"], defaults: TsfResearchTaskDefaults = {}) {
    const value = await DialogPrompt.show(dialog, "CSV dataset path", {
      placeholder: "/path/to/ETTh1.csv target=OT horizon=24 context=96 full",
      description: () => <text fg={theme.textMuted}>Options: target=OT,HUFL horizon=24,48 context=96 preset=etth1 full|bridge.</text>,
    })
    const parsed = value ? parseTsfCsvTaskInput(value) : undefined
    if (!parsed?.datasetPath) return
    await createTask(mode, {
      datasetPreset: "etth1_tslib_v1",
      targetCols: ["OT"],
      ...defaults,
      ...parsed,
    })
    dialog.clear()
  }

  async function seedBaselines() {
    const task = selectedTask()
    if (!task) return
    await runAction("seed-baselines", async () => {
      const seeded = await researchRequest<{ candidates: unknown[]; approvals: unknown[] }>(
        sdk,
        `/research/tasks/${encodeURIComponent(task.id)}/baselines`,
        { method: "POST" },
      )
      return `${seeded.candidates.length} candidates seeded`
    })
  }

  async function approvePending() {
    const approval = pendingApproval()
    if (!approval) return
    await runAction("approve-pending", async () => {
      const updated = await researchRequest<ResearchCockpitApproval>(
        sdk,
        `/research/approvals/${encodeURIComponent(approval.id)}/reply`,
        {
          method: "POST",
          body: JSON.stringify({ status: "approved" }),
        },
      )
      return `${shortID(updated.id)} ${updated.status}`
    })
  }

  async function runAutonomousIteration(description = "cockpit autonomous iteration") {
    const task = selectedTask()
    if (!task || task.mode !== "autonomous" || !runnerReady()) return
    await runAction("autonomous-iteration", async () => {
      const result = await researchRequest<ResearchCockpitIterationResult>(
        sdk,
        `/research/tasks/${encodeURIComponent(task.id)}/autonomous/iterate`,
        {
          method: "POST",
          body: JSON.stringify({ stage: "smoke", description }),
        },
      )
      return formatResearchCockpitIteration(result)
    })
  }

  async function runAutonomousLoop() {
    const task = selectedTask()
    if (!task || task.mode !== "autonomous" || !runnerReady()) return
    await runAction("autonomous-loop", async () => {
      const result = await researchRequest<ResearchCockpitLoopResult>(
        sdk,
        `/research/tasks/${encodeURIComponent(task.id)}/autonomous/loop`,
        {
          method: "POST",
          body: JSON.stringify({ stage: "smoke", maxIterations: 3, description: "cockpit autonomous loop" }),
        },
      )
      return formatResearchCockpitLoop(result)
    })
  }

  async function requestRefTestGate(candidate: ResearchCockpitCandidate) {
    const task = selectedTask()
    if (!task || !canRunResearchCockpitCandidate(candidate)) return
    await runAction(`ref-gate-${candidate.id}`, async () => {
      const approval = await researchRequest<ResearchCockpitApproval>(sdk, "/research/approvals", {
        method: "POST",
        body: JSON.stringify({
          taskID: task.id,
          candidateID: candidate.id,
          kind: "ref_test",
          reason: `Approve reference test access for ${researchCockpitCandidateTitle(candidate)}.`,
        }),
      })
      return `${shortID(approval.id)} ref_test requested`
    })
  }

  async function requestBlindTestGate(candidate: ResearchCockpitCandidate) {
    const task = selectedTask()
    if (!task || !canRunResearchCockpitCandidate(candidate)) return
    await runAction(`blind-gate-${candidate.id}`, async () => {
      const approval = await researchRequest<ResearchCockpitApproval>(sdk, "/research/approvals", {
        method: "POST",
        body: JSON.stringify({
          taskID: task.id,
          candidateID: candidate.id,
          kind: "blind_test",
          reason: `Approve blind test sidecar access for ${researchCockpitCandidateTitle(candidate)}.`,
        }),
      })
      return `${shortID(approval.id)} blind_test requested`
    })
  }

  async function prepareCandidate(candidate: ResearchCockpitCandidate, stage: CandidateRunStage = "smoke") {
    const task = selectedTask()
    if (!task || !canRunResearchCockpitCandidate(candidate)) return
    await runAction(`prepare-${stage}-${candidate.id}`, async () => {
      const result = await researchRequest<{ run: ResearchCockpitRun }>(
        sdk,
        `/research/tasks/${encodeURIComponent(task.id)}/candidates/${encodeURIComponent(candidate.id)}/prepare-run`,
        {
          method: "POST",
          body: JSON.stringify({ stage, description: `cockpit ${stage} run` }),
        },
      )
      return formatResearchCockpitRunResult(result)
    })
  }

  async function executeCandidate(candidate: ResearchCockpitCandidate, stage: CandidateRunStage = "smoke") {
    const task = selectedTask()
    if (!task || !runnerReady() || !canRunResearchCockpitCandidate(candidate)) return
    await runAction(`execute-${stage}-${candidate.id}`, async () => {
      const result = await researchRequest<{ run: ResearchCockpitRun }>(
        sdk,
        `/research/tasks/${encodeURIComponent(task.id)}/candidates/${encodeURIComponent(candidate.id)}/execute-run`,
        {
          method: "POST",
          body: JSON.stringify({ stage, description: `cockpit ${stage} run` }),
        },
      )
      return formatResearchCockpitRunResult(result)
    })
  }

  async function executeCandidateSeedSweep(candidate: ResearchCockpitCandidate) {
    const task = selectedTask()
    if (!task || !runnerReady() || !canRunResearchCockpitCandidate(candidate)) return
    await runAction(`seed-sweep-${candidate.id}`, async () => {
      const result = await researchRequest<ResearchCockpitSeedSweepResult>(
        sdk,
        `/research/tasks/${encodeURIComponent(task.id)}/candidates/${encodeURIComponent(candidate.id)}/seed-sweep`,
        {
          method: "POST",
          body: JSON.stringify({ stage: "smoke", description: "cockpit smoke seed sweep" }),
        },
      )
      return formatResearchCockpitSeedSweep(result)
    })
  }

  async function exportTaskArtifact() {
    const task = selectedTask()
    if (!task) return
    await runAction("export-artifact", async () => {
      const result = await researchRequest<ResearchCockpitExportResult>(
        sdk,
        `/research/tasks/${encodeURIComponent(task.id)}/export`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      )
      return formatResearchCockpitExport(result)
    })
  }

  async function profileTask() {
    const task = selectedTask()
    if (!task) return
    await runAction("profile-task", async () => {
      const result = await researchRequest<ResearchCockpitProfileResult>(
        sdk,
        `/research/tasks/${encodeURIComponent(task.id)}/profile`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      )
      return `profile ${shortID(result.artifact.id)}`
    })
  }

  function selectTaskOffset(offset: number) {
    const count = sortedTasks().length
    if (count < 2) return
    setSelectedIndex((value) => (value + offset + count) % count)
  }

  async function runRecommendedAction() {
    const task = selectedTask()
    const next = recommendation().title
    if (!task) {
      promptInput?.focus()
      toast.show({
        variant: "info",
        message: "Describe a forecasting goal to create the next research task.",
        duration: 4000,
      })
      return
    }
    if (pendingApproval()) {
      await approvePending()
      return
    }
    if (next === "Profile dataset") {
      await profileTask()
      return
    }
    if (next === "Seed baseline candidates") {
      await seedBaselines()
      return
    }
    if (task.mode === "autonomous" && runnerReady()) {
      await runAutonomousLoop()
      return
    }
    const candidate = taskCandidates().find(canRunResearchCockpitCandidate)
    if (candidate && runnerReady()) {
      await executeCandidate(candidate)
      return
    }
    if (next === "Export research report") {
      await exportTaskArtifact()
      return
    }
    toast.show({
      variant: "info",
      message: recommendation().detail,
      duration: 4000,
    })
  }

  async function runSlashPrompt(value: string) {
    const name = value.slice(1).trim().split(/\s+/, 1)[0]?.toLowerCase()
    if (name === "home") {
      route.navigate({ type: "home" })
      return
    }
    if (name === "review") {
      await createTask("review")
      return
    }
    if (name === "review-full") {
      await createTask("review", { bridgeOnly: false })
      return
    }
    if (name === "review-csv") {
      await createCsvTask("review")
      return
    }
    if (name === "review-csv-full") {
      await createCsvTask("review", { bridgeOnly: false })
      return
    }
    if (name === "task" || name === "autonomous") {
      await createTask("autonomous")
      return
    }
    if (name === "task-full" || name === "autonomous-full") {
      await createTask("autonomous", { bridgeOnly: false })
      return
    }
    if (name === "csv" || name === "dataset") {
      await createCsvTask("autonomous")
      return
    }
    if (name === "csv-full" || name === "dataset-full") {
      await createCsvTask("autonomous", { bridgeOnly: false })
      return
    }
    if (name === "seed" || name === "seed-baselines" || name === "baselines") {
      await seedBaselines()
      return
    }
    if (name === "profile") {
      await profileTask()
      return
    }
    if (name === "approve") {
      await approvePending()
      return
    }
    if (name === "iterate") {
      await runAutonomousIteration()
      return
    }
    if (name === "next") {
      await runRecommendedAction()
      return
    }
    if (name === "loop" || name === "agent-loop") {
      await runAutonomousLoop()
      return
    }
    if (name === "task-next") {
      selectTaskOffset(1)
      return
    }
    if (name === "task-prev" || name === "task-previous") {
      selectTaskOffset(-1)
      return
    }
    const candidate = commandCandidate()
    if (candidate && (name === "ref-gate" || name === "ref")) {
      await requestRefTestGate(candidate)
      return
    }
    if (candidate && name === "seed-sweep") {
      await executeCandidateSeedSweep(candidate)
      return
    }
    if (candidate && name === "ref-exec") {
      await executeCandidate(candidate, "ref_test")
      return
    }
    if (candidate && (name === "blind-gate" || name === "blind")) {
      await requestBlindTestGate(candidate)
      return
    }
    if (candidate && name === "blind-exec") {
      await executeCandidate(candidate, "blind_test")
      return
    }
    if (name === "export" || name === "report") {
      await exportTaskArtifact()
      return
    }
    const message = `Unknown cockpit command: /${name ?? ""}`
    setError(message)
    toast.show({
      variant: "warning",
      message,
      duration: 3000,
    })
  }

  async function createTaskFromPrompt(value: string, source: "prompt" | "home" = "prompt") {
    await runAction(source === "home" ? "create-from-home-goal" : "create-from-prompt", async () => {
      const payload: CreateResearchTaskInput = buildDefaultTsfResearchTask("autonomous", sdk.directory ?? process.cwd(), {
        bridgeOnly: false,
      })
      const metadata = payload.taskSpec.metadata
      const eventDetail = source === "home" ? "created from home goal" : "created from prompt"
      payload.title = promptTaskTitle(value)
      payload.taskSpec = {
        ...payload.taskSpec,
        metadata: {
          ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as JsonRecord) : {}),
          userPrompt: value,
          ...(source === "home" ? { source: "home" } : {}),
        },
      }
      const task = await researchRequest<ResearchCockpitTask>(sdk, "/research/tasks", {
        method: "POST",
        body: JSON.stringify(payload),
      })
      setSelectedIndex(0)
      setPromptEvents((events) => [
        ...events.slice(-4),
        {
          id: ++promptEventID,
          text: value,
          taskID: task.id,
          detail: eventDetail,
        },
      ])
      return `${task.title} ${eventDetail}`
    })
  }

  async function submitPrompt() {
    const value = promptInput?.plainText.trim()
    if (!value) return
    const task = selectedTask()
    promptInput?.clear()
    if (value.startsWith("/")) {
      await runSlashPrompt(value)
      promptInput?.focus()
      return
    }
    if (!task) {
      await createTaskFromPrompt(value)
      promptInput?.focus()
      return
    }
    if (task.mode === "autonomous" && runnerReady()) {
      await runAutonomousIteration(value)
      promptInput?.focus()
      return
    }
    setPromptEvents((events) => [
      ...events.slice(-4),
      {
        id: ++promptEventID,
        text: value,
        taskID: task?.id,
        detail: "captured as instruction",
      },
    ])
    toast.show({
      variant: "info",
      message: "Research prompt captured. Use Agent Loop or candidate actions to execute it.",
      duration: 4000,
    })
    promptInput?.focus()
  }

  command.register(() => [
    {
      title: "Create TSF review task",
      value: "research.create.review",
      category: "Research",
      slash: { name: "review" },
      onSelect: () => void createTask("review"),
    },
    {
      title: "Create TSF full-recipe review task",
      value: "research.create.review.full",
      category: "Research",
      slash: { name: "review-full" },
      onSelect: () => void createTask("review", { bridgeOnly: false }),
    },
    {
      title: "Create TSF review task from CSV",
      value: "research.create.review.csv",
      category: "Research",
      slash: { name: "review-csv" },
      onSelect: () => void createCsvTask("review"),
    },
    {
      title: "Create TSF full-recipe review task from CSV",
      value: "research.create.review.csv.full",
      category: "Research",
      slash: { name: "review-csv-full" },
      onSelect: () => void createCsvTask("review", { bridgeOnly: false }),
    },
    {
      title: "Create TSF autonomous task",
      value: "research.create.autonomous",
      category: "Research",
      slash: { name: "task", aliases: ["autonomous"] },
      onSelect: () => void createTask("autonomous"),
    },
    {
      title: "Create TSF full-recipe autonomous task",
      value: "research.create.autonomous.full",
      category: "Research",
      slash: { name: "task-full", aliases: ["autonomous-full"] },
      onSelect: () => void createTask("autonomous", { bridgeOnly: false }),
    },
    {
      title: "Create TSF autonomous task from CSV",
      value: "research.create.autonomous.csv",
      category: "Research",
      slash: { name: "csv", aliases: ["dataset"] },
      onSelect: () => void createCsvTask("autonomous"),
    },
    {
      title: "Create TSF full-recipe autonomous task from CSV",
      value: "research.create.autonomous.csv.full",
      category: "Research",
      slash: { name: "csv-full", aliases: ["dataset-full"] },
      onSelect: () => void createCsvTask("autonomous", { bridgeOnly: false }),
    },
    {
      title: "Seed TSF baselines",
      value: "research.seed.baselines",
      category: "Research",
      enabled: !!selectedTask(),
      slash: { name: "seed-baselines", aliases: ["seed", "baselines"] },
      onSelect: () => void seedBaselines(),
    },
    {
      title: "Profile research task",
      value: "research.profile.task",
      category: "Research",
      enabled: !!selectedTask(),
      slash: { name: "profile" },
      onSelect: () => void profileTask(),
    },
    {
      title: "Approve pending research candidate",
      value: "research.approve.pending",
      category: "Research",
      enabled: !!pendingApproval(),
      slash: { name: "approve" },
      onSelect: () => void approvePending(),
    },
    {
      title: "Run autonomous research iteration",
      value: "research.autonomous.iterate",
      category: "Research",
      enabled: selectedTask()?.mode === "autonomous" && runnerReady(),
      slash: { name: "iterate" },
      onSelect: () => void runAutonomousIteration(),
    },
    {
      title: "Run autonomous research loop",
      value: "research.autonomous.loop",
      category: "Research",
      enabled: selectedTask()?.mode === "autonomous" && runnerReady(),
      slash: { name: "agent-loop", aliases: ["loop"] },
      onSelect: () => void runAutonomousLoop(),
    },
    {
      title: "Run recommended research action",
      value: "research.next.run",
      category: "Research",
      enabled: !!selectedTask(),
      slash: { name: "next" },
      onSelect: () => void runRecommendedAction(),
    },
    {
      title: "Select next research task",
      value: "research.task.next",
      category: "Research",
      enabled: sortedTasks().length > 1,
      slash: { name: "task-next" },
      onSelect: () => selectTaskOffset(1),
    },
    {
      title: "Select previous research task",
      value: "research.task.previous",
      category: "Research",
      enabled: sortedTasks().length > 1,
      slash: { name: "task-previous", aliases: ["task-prev"] },
      onSelect: () => selectTaskOffset(-1),
    },
    {
      title: "Request reference test gate for first candidate",
      value: "research.candidate.refGate",
      category: "Research",
      enabled: !!commandCandidate() && canRunResearchCockpitCandidate(commandCandidate()!),
      slash: { name: "ref-gate", aliases: ["ref"] },
      onSelect: () => {
        const candidate = commandCandidate()
        if (!candidate) return
        void requestRefTestGate(candidate)
      },
    },
    {
      title: "Run smoke seed sweep for first candidate",
      value: "research.candidate.seedSweep",
      category: "Research",
      enabled: !!commandCandidate() && runnerReady() && canRunResearchCockpitCandidate(commandCandidate()!),
      slash: { name: "seed-sweep" },
      onSelect: () => {
        const candidate = commandCandidate()
        if (!candidate) return
        void executeCandidateSeedSweep(candidate)
      },
    },
    {
      title: "Execute reference test for first candidate",
      value: "research.candidate.refExec",
      category: "Research",
      enabled: !!commandCandidate() && runnerReady() && canRunResearchCockpitCandidate(commandCandidate()!),
      slash: { name: "ref-exec" },
      onSelect: () => {
        const candidate = commandCandidate()
        if (!candidate) return
        void executeCandidate(candidate, "ref_test")
      },
    },
    {
      title: "Request blind test gate for first candidate",
      value: "research.candidate.blindGate",
      category: "Research",
      enabled: !!commandCandidate() && canRunResearchCockpitCandidate(commandCandidate()!),
      slash: { name: "blind-gate", aliases: ["blind"] },
      onSelect: () => {
        const candidate = commandCandidate()
        if (!candidate) return
        void requestBlindTestGate(candidate)
      },
    },
    {
      title: "Execute blind test for first candidate",
      value: "research.candidate.blindExec",
      category: "Research",
      enabled: !!commandCandidate() && runnerReady() && canRunResearchCockpitCandidate(commandCandidate()!),
      slash: { name: "blind-exec" },
      onSelect: () => {
        const candidate = commandCandidate()
        if (!candidate) return
        void executeCandidate(candidate, "blind_test")
      },
    },
    {
      title: "Export research report",
      value: "research.export.report",
      category: "Research",
      enabled: !!selectedTask(),
      slash: { name: "export", aliases: ["report"] },
      onSelect: () => void exportTaskArtifact(),
    },
  ])

  const maxRuns = createMemo(() => Number(selectedTask()?.budget.maxRuns ?? 0))
  const selectedTaskPosition = createMemo(() => {
    const count = sortedTasks().length
    if (count === 0) return "Task 0/0"
    return `Task ${selectedIndex() + 1}/${count}`
  })
  const succeededRuns = createMemo(
    () => taskRuns().filter((run) => run.status === "succeeded" && run.stage !== "profile").length,
  )
  const remainingRuns = createMemo(() => Math.max(0, maxRuns() - succeededRuns()))
  const taskLabel = createMemo(() => selectedTask()?.title ?? "No research task selected")
  const taskStatus = createMemo(() => selectedTask()?.status ?? "created")
  const taskPath = createMemo(() => sdk.directory ?? process.cwd())
  const firstCandidate = createMemo(() => (candidates() ?? [])[0])
  const firstCandidateTitle = createMemo(() => {
    const candidate = firstCandidate()
    return candidate ? researchCockpitCandidateTitle(candidate) : "No candidate selected"
  })
  const firstCandidatePipeline = createMemo(() => {
    const candidate = firstCandidate()
    if (!candidate) return "Seed baselines or create a CSV task to generate candidate recipes."
    return researchCockpitCandidatePipeline(candidate) || candidate.rationale
  })
  const latestRun = createMemo(() => (runs() ?? [])[0])
  const firstArtifact = createMemo(() => (artifacts() ?? [])[0])
  const firstMemory = createMemo(() => (memory() ?? [])[0])
  const profileSummary = createMemo(() => formatResearchCockpitProfile(taskFingerprint() ?? {}))
  const fingerprintSummary = createMemo(() => formatResearchCockpitFingerprint(taskFingerprint() ?? {}))
  const artifactMetadata = createMemo(() => {
    const artifact = firstArtifact()
    if (!artifact) return "No research artifact yet"
    return formatResearchCockpitArtifactMetadata(artifact) || researchCockpitArtifactTarget(artifact)
  })
  const memorySummary = createMemo(() => {
    const item = firstMemory()
    if (!item) return "No memory captured yet"
    return formatResearchCockpitMemory(item)
  })
  const championSummary = createMemo(() => {
    const item = champion()
    if (!item || typeof item.primaryMetric !== "number" || typeof item.utility !== "number") return "No champion yet"
    return `candidate=${shortID(item.candidateID)} / metric=${item.primaryMetric.toPrecision(4)} / utility=${item.utility.toPrecision(4)}`
  })
  const promptPlaceholder = createMemo(() =>
    selectedTask()
      ? "Ask for the next experiment, approve a gate, or export the report..."
      : "Describe a forecasting goal to create an autonomous TSF task...",
  )

  return (
    <box flexGrow={1} height="100%" flexDirection="row" backgroundColor={cockpitColors.background}>
      <box
        flexGrow={1}
        minWidth={0}
        height="100%"
        paddingLeft={2}
        paddingRight={1}
        paddingTop={1}
        paddingBottom={1}
      >
        <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingBottom={1}>
          <text fg={cockpitColors.text} attributes={TextAttributes.BOLD}>
            NeoResearch Workspace
          </text>
          <box flexDirection="row" gap={2}>
            <text fg={cockpitColors.primary} onMouseUp={() => route.navigate({ type: "home" })}>
              Home
            </text>
            <text fg={sortedTasks().length < 2 ? cockpitColors.textMuted : cockpitColors.primary} onMouseUp={() => selectTaskOffset(-1)}>
              Previous Task
            </text>
            <text fg={sortedTasks().length < 2 ? cockpitColors.textMuted : cockpitColors.primary} onMouseUp={() => selectTaskOffset(1)}>
              Next Task
            </text>
            <text
              fg={busy() ? cockpitColors.textMuted : cockpitColors.primary}
              onMouseUp={() => {
                if (busy()) return
                void createCsvTask("review")
              }}
            >
              New CSV Task
            </text>
            <text
              fg={!selectedTask() || busy() ? cockpitColors.textMuted : cockpitColors.primary}
              onMouseUp={() => {
                if (!selectedTask() || busy()) return
                void seedBaselines()
              }}
            >
              Seed Baselines
            </text>
            <text
              fg={
                selectedTask()?.mode !== "autonomous" || !runnerReady() || busy()
                  ? cockpitColors.textMuted
                  : cockpitColors.primary
              }
              onMouseUp={() => {
                if (selectedTask()?.mode !== "autonomous" || !runnerReady() || busy()) return
                void runAutonomousLoop()
              }}
            >
              Agent Loop
            </text>
            <text
              fg={!selectedTask() || busy() ? cockpitColors.textMuted : cockpitColors.primary}
              onMouseUp={() => {
                if (!selectedTask() || busy()) return
                void exportTaskArtifact()
              }}
            >
              Export Report
            </text>
          </box>
        </box>

        <Show when={error()}>{(message) => <text fg={cockpitColors.error}>{message()}</text>}</Show>
        <Show when={busy()}>
          {(action) => (
            <box
              backgroundColor={cockpitColors.panel}
              border={["left"]}
              borderColor={cockpitColors.warning}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={cockpitColors.warning}>Running {action()} - Actions are temporarily locked</text>
            </box>
          )}
        </Show>

        <box flexGrow={1} minHeight={0} gap={2}>
          <Switch>
            <Match when={selectedTask()}>
              {(task) => (
                <>
                  <text fg={cockpitColors.text} attributes={TextAttributes.BOLD}>
                    Workflow
                  </text>
                  <box backgroundColor={cockpitColors.panel} paddingLeft={1} paddingRight={1}>
                    <For each={workflowItems()}>
                      {(item) => (
                        <text fg={workflowColor(item.status)}>
                          {workflowMark(item.status)} {item.label}
                        </text>
                      )}
                    </For>
                  </box>

                  <box border={["left"]} borderColor={cockpitColors.border} paddingLeft={1} gap={1}>
                    <text fg={cockpitColors.primary} attributes={TextAttributes.BOLD}>
                      State
                    </text>
                    <text fg={cockpitColors.text}>
                      Research state loaded for {task().title}. The cockpit is tracking task setup, dataset profile,
                      candidate design, runner execution, governance gates, and report export.
                    </text>
                    <text fg={cockpitColors.textMuted}>
                      Current state: {task().mode} / {task().status} / {shortID(task().id)}
                    </text>
                    <text fg={cockpitColors.textMuted}>Profile: {profileSummary()}</text>
                    <text fg={cockpitColors.textMuted}>Fingerprint: {fingerprintSummary()}</text>
                  </box>

                  <box border={["left"]} borderColor={cockpitColors.border} paddingLeft={1} gap={1}>
                    <text fg={cockpitColors.primary} attributes={TextAttributes.BOLD}>
                      Next Action
                    </text>
                    <text fg={cockpitColors.text} attributes={TextAttributes.BOLD}>
                      {recommendation().title}
                    </text>
                    <text fg={cockpitColors.textMuted}>
                      {recommendation().detail}
                    </text>
                    <text
                      fg={!selectedTask() || busy() ? cockpitColors.textMuted : cockpitColors.primary}
                      onMouseUp={() => {
                        if (!selectedTask() || busy()) return
                        void runRecommendedAction()
                      }}
                    >
                      Run Next
                    </text>
                    <text fg={cockpitColors.textMuted}>Candidate: {firstCandidateTitle()}</text>
                    <text fg={cockpitColors.textMuted} wrapMode="none">
                      Pipeline: {firstCandidatePipeline()}
                    </text>
                    <Show when={latestRun()} fallback={<text fg={cockpitColors.textMuted}>No runs recorded yet</text>}>
                      {(run) => (
                        <text fg={statusColor(run().status)}>
                          Latest run: {run().status} / {metricText(run().metrics)}
                        </text>
                      )}
                    </Show>
                  </box>

                  <box gap={1}>
                    <text fg={cockpitColors.textMuted}>Forecaster</text>
                    <For
                      each={(candidates() ?? []).slice(0, 3)}
                      fallback={
                        <text fg={cockpitColors.textMuted}>No candidates. Start with Seed Baselines or New CSV Task.</text>
                      }
                    >
                      {(candidate) => {
                        const runnable = createMemo(() => canRunResearchCockpitCandidate(candidate))
                        const refGateRequested = createMemo(() =>
                          (approvals() ?? []).some(
                            (approval) =>
                              approval.candidateID === candidate.id &&
                              approval.kind === "ref_test" &&
                              approval.status !== "rejected",
                          ),
                        )
                        const refGateApproved = createMemo(() =>
                          hasApprovedResearchCockpitRefTestGate(approvals() ?? [], candidate.id),
                        )
                        const blindGateRequested = createMemo(() =>
                          (approvals() ?? []).some(
                            (approval) =>
                              approval.candidateID === candidate.id &&
                              approval.kind === "blind_test" &&
                              approval.status !== "rejected",
                          ),
                        )
                        const blindGateApproved = createMemo(() =>
                          hasApprovedResearchCockpitBlindTestGate(approvals() ?? [], candidate.id),
                        )
                        return (
                          <box backgroundColor={cockpitColors.panel} paddingLeft={1} paddingRight={1}>
                            <box flexDirection="row" gap={1}>
                              <text fg={statusColor(candidate.approvalStatus)}>{candidate.approvalStatus}</text>
                              <text fg={cockpitColors.text} attributes={TextAttributes.BOLD} wrapMode="none">
                                {researchCockpitCandidateTitle(candidate)}
                              </text>
                              <text fg={cockpitColors.textMuted}>{candidate.riskLevel}</text>
                            </box>
                            <text fg={cockpitColors.textMuted} wrapMode="none">
                              {researchCockpitCandidatePipeline(candidate) || candidate.rationale}
                            </text>
                            <box flexDirection="row" gap={1}>
                              <text
                                fg={!runnable() || busy() ? cockpitColors.textMuted : cockpitColors.primary}
                                onMouseUp={() => {
                                  if (!runnable() || busy()) return
                                  void prepareCandidate(candidate)
                                }}
                              >
                                Smoke Prep
                              </text>
                              <text
                                fg={!runnable() || !runnerReady() || busy() ? cockpitColors.textMuted : cockpitColors.primary}
                                onMouseUp={() => {
                                  if (!runnable() || !runnerReady() || busy()) return
                                  void executeCandidate(candidate)
                                }}
                              >
                                Smoke Exec
                              </text>
                              <text
                                fg={!runnable() || refGateRequested() || busy() ? cockpitColors.textMuted : cockpitColors.primary}
                                onMouseUp={() => {
                                  if (!runnable() || refGateRequested() || busy()) return
                                  void requestRefTestGate(candidate)
                                }}
                              >
                                Ref Gate
                              </text>
                              <text
                                fg={!runnable() || !runnerReady() || busy() ? cockpitColors.textMuted : cockpitColors.primary}
                                onMouseUp={() => {
                                  if (!runnable() || !runnerReady() || busy()) return
                                  void executeCandidateSeedSweep(candidate)
                                }}
                              >
                                Seed Sweep
                              </text>
                              <text
                                fg={!runnable() || !refGateApproved() || busy() ? cockpitColors.textMuted : cockpitColors.primary}
                                onMouseUp={() => {
                                  if (!runnable() || !refGateApproved() || busy()) return
                                  void prepareCandidate(candidate, "ref_test")
                                }}
                              >
                                Ref Prep
                              </text>
                              <text
                                fg={
                                  !runnable() || !refGateApproved() || !runnerReady() || busy()
                                    ? cockpitColors.textMuted
                                    : cockpitColors.primary
                                }
                                onMouseUp={() => {
                                  if (!runnable() || !refGateApproved() || !runnerReady() || busy()) return
                                  void executeCandidate(candidate, "ref_test")
                                }}
                              >
                                Ref Exec
                              </text>
                              <text
                                fg={!runnable() || blindGateRequested() || busy() ? cockpitColors.textMuted : cockpitColors.primary}
                                onMouseUp={() => {
                                  if (!runnable() || blindGateRequested() || busy()) return
                                  void requestBlindTestGate(candidate)
                                }}
                              >
                                Blind Gate
                              </text>
                              <text
                                fg={!runnable() || !blindGateApproved() || busy() ? cockpitColors.textMuted : cockpitColors.primary}
                                onMouseUp={() => {
                                  if (!runnable() || !blindGateApproved() || busy()) return
                                  void prepareCandidate(candidate, "blind_test")
                                }}
                              >
                                Blind Prep
                              </text>
                              <text
                                fg={
                                  !runnable() || !blindGateApproved() || !runnerReady() || busy()
                                    ? cockpitColors.textMuted
                                    : cockpitColors.primary
                                }
                                onMouseUp={() => {
                                  if (!runnable() || !blindGateApproved() || !runnerReady() || busy()) return
                                  void executeCandidate(candidate, "blind_test")
                                }}
                              >
                                Blind Exec
                              </text>
                            </box>
                          </box>
                        )
                      }}
                    </For>
                  </box>

                  <box gap={1}>
                    <text fg={cockpitColors.textMuted}>Research Notes</text>
                    <box backgroundColor={cockpitColors.panel} paddingLeft={1} paddingRight={1}>
                      <text fg={cockpitColors.textMuted} wrapMode="none">
                        Champion {championSummary()}
                      </text>
                    </box>
                    <box backgroundColor={cockpitColors.panel} paddingLeft={1} paddingRight={1}>
                      <text fg={cockpitColors.text}>Artifacts</text>
                      <text fg={cockpitColors.textMuted} wrapMode="none">
                        {artifactMetadata()}
                      </text>
                    </box>
                    <box backgroundColor={cockpitColors.panel} paddingLeft={1} paddingRight={1}>
                      <text fg={cockpitColors.text}>Memory</text>
                      <text fg={cockpitColors.textMuted} wrapMode="none">
                        {memorySummary()}
                      </text>
                    </box>
                  </box>
                </>
              )}
            </Match>
            <Match when={true}>
              <box flexGrow={1} gap={2}>
                <text fg={cockpitColors.text} attributes={TextAttributes.BOLD}>
                  Workflow
                </text>
                <box backgroundColor={cockpitColors.panel} paddingLeft={1} paddingRight={1}>
                  <For each={workflowItems()}>
                    {(item) => (
                      <text fg={workflowColor(item.status)}>
                        {workflowMark(item.status)} {item.label}
                      </text>
                    )}
                  </For>
                </box>

                <box border={["left"]} borderColor={cockpitColors.border} paddingLeft={1} gap={1}>
                  <text fg={cockpitColors.primary} attributes={TextAttributes.BOLD}>
                    Next Action
                  </text>
                  <text fg={cockpitColors.text} attributes={TextAttributes.BOLD}>
                    {recommendation().title}
                  </text>
                  <text fg={cockpitColors.textMuted}>
                    {recommendation().detail}
                  </text>
                </box>
              </box>
            </Match>
          </Switch>

          <For each={promptEvents()}>
            {(event) => (
              <box border={["left"]} borderColor={cockpitColors.border} paddingLeft={1} gap={1}>
                <text fg={cockpitColors.primary} attributes={TextAttributes.BOLD}>
                  Prompt captured:
                </text>
                <text fg={cockpitColors.text}>{event.text}</text>
                <text fg={cockpitColors.textMuted}>
                  {event.detail
                    ? event.detail
                    : event.taskID
                      ? "Attached to the active research task. Use Agent Loop or candidate actions to execute."
                      : "Create a CSV task to bind this prompt to a dataset-backed research task."}
                </text>
              </box>
            )}
          </For>
        </box>

        <box
          flexShrink={0}
          height={5}
          backgroundColor={cockpitColors.panel}
          border={["left"]}
          borderColor={cockpitColors.primary}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
        >
          <textarea
            ref={(value: TextareaRenderable) => {
              promptInput = value
              value.traits = { status: "FORECAST" }
              queueMicrotask(() => value.focus())
            }}
            focused
            minHeight={1}
            maxHeight={2}
            keyBindings={textareaKeybindings()}
            onSubmit={() => void submitPrompt()}
            placeholder={promptPlaceholder()}
            placeholderColor={cockpitColors.textMuted}
            textColor={cockpitColors.text}
            focusedTextColor={cockpitColors.text}
            cursorColor={cockpitColors.primary}
          />
          <box flexDirection="row" gap={2}>
            <text fg={cockpitColors.primary}>Planner</text>
            <text fg={cockpitColors.text}>Research Agent</text>
          </box>
        </box>

        <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingTop={1}>
          <text fg={cockpitColors.textMuted}>enter submit</text>
          <box flexDirection="row" gap={2}>
            <text fg={cockpitColors.textMuted}>ctrl+p commands</text>
          </box>
        </box>
      </box>

      <box
        width={42}
        height="100%"
        flexShrink={0}
        backgroundColor={cockpitColors.sidebar}
        paddingLeft={2}
        paddingRight={1}
        paddingTop={1}
        gap={1}
      >
        <text fg={cockpitColors.text} attributes={TextAttributes.BOLD}>
          {taskLabel()}
        </text>
        <text fg={cockpitColors.textMuted}>{selectedTaskPosition()}</text>
        <text fg={statusColor(taskStatus())}>{taskStatus()}</text>

        <box gap={0} paddingTop={1}>
          <text fg={cockpitColors.text} attributes={TextAttributes.BOLD}>
            Progress
          </text>
          <text fg={workflowItems()[0]?.status === "done" ? cockpitColors.success : cockpitColors.primary}>
            Planner
          </text>
          <For each={workflowItems().slice(0, 2)}>
            {(item) => (
              <text fg={workflowColor(item.status)}>
                {workflowMark(item.status)} {item.label}
              </text>
            )}
          </For>
          <text fg={cockpitColors.text}>
            [ ] Forecaster {succeededRuns()}/{maxRuns()} experiments
          </text>
          <text fg={cockpitColors.textMuted}>  {remainingRuns()} remaining</text>
          <For each={workflowItems().slice(2, 4)}>
            {(item) => (
              <text fg={workflowColor(item.status)}>
                {workflowMark(item.status)} {item.label}
              </text>
            )}
          </For>
          <text fg={pendingApproval() ? cockpitColors.warning : cockpitColors.textMuted}>Critic</text>
          <For each={workflowItems().slice(4)}>
            {(item) => (
              <text fg={workflowColor(item.status)}>
                {workflowMark(item.status)} {item.label}
              </text>
            )}
          </For>
        </box>

        <box gap={0} paddingTop={1}>
          <text fg={cockpitColors.text} attributes={TextAttributes.BOLD}>
            Context
          </text>
          <text fg={cockpitColors.textMuted}>Tasks {stats().taskTotal}</text>
          <text fg={cockpitColors.textMuted}>Candidates {stats().candidateCount}</text>
          <text fg={cockpitColors.textMuted}>Artifacts {stats().artifactCount}</text>
          <text fg={cockpitColors.textMuted}>Memory {stats().memoryCount}</text>
          <text fg={cockpitColors.textMuted}>Approvals {stats().pendingApprovals}</text>
        </box>

        <box flexGrow={1} justifyContent="flex-end" paddingBottom={1}>
          <text fg={cockpitColors.textMuted} wrapMode="none">
            {taskPath()}
          </text>
          <text fg={runnerReady() ? cockpitColors.success : cockpitColors.textMuted}>NeoResearch alpha</text>
        </box>
      </box>
    </box>
  )
}
