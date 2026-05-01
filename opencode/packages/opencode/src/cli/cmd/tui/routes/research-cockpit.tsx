import { TextareaRenderable, TextAttributes, type KeyEvent } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
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
  formatResearchCockpitMemory,
  formatResearchCockpitProfile,
  formatResearchCockpitIteration,
  formatResearchCockpitLoop,
  formatResearchCockpitRunResult,
  formatResearchCockpitSeedSweep,
  getResearchCockpitRunnerStatus,
  hasApprovedResearchCockpitBlindTestGate,
  hasApprovedResearchCockpitRefTestGate,
  parseTsfCsvTaskInput,
  researchCockpitArtifactTarget,
  researchCockpitCandidatePipeline,
  researchCockpitCandidateTitle,
  shouldRefreshResearchCockpitOnEvent,
  sortResearchCockpitTasks,
  updateResearchCockpitTaskRunnerRoot,
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
import {
  createResearchSlashSelection,
  ResearchSlashMenu,
  moveSlashSelection,
  resolveSlashOption,
  slashMenuHasOptions,
  type SlashOption,
} from "./research-slash-menu"

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

function runFailureText(run: ResearchCockpitRun | undefined) {
  const value = run?.error?.trim()
  if (!value) return undefined
  return formatError(value)
}

function runDurationText(run: ResearchCockpitRun) {
  const wallClockSec = run.resourceUsage?.wallClockSec
  return typeof wallClockSec === "number" ? ` / ${wallClockSec.toPrecision(3)}s` : ""
}

function runSummaryText(run: ResearchCockpitRun) {
  return `${run.id} ${run.stage ?? "run"} ${run.status} / ${metricText(run.metrics)}${runDurationText(run)}`
}

function assistantTextFromResponse(result: unknown) {
  const parts = Array.isArray((result as { parts?: unknown[] })?.parts) ? (result as { parts: unknown[] }).parts : []
  const text = parts
    .map((part) => {
      if (!part || typeof part !== "object") return ""
      const candidate = part as { type?: unknown; text?: unknown; synthetic?: unknown; ignored?: unknown }
      if (candidate.type !== "text" || candidate.synthetic || candidate.ignored) return ""
      return typeof candidate.text === "string" ? candidate.text.trim() : ""
    })
    .filter(Boolean)
    .join("\n")
    .trim()
  return text || "Research Agent completed without a text response."
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

const promptEventHistoryLimit = 20
const errorEventHistoryLimit = 10

type StreamLine = {
  id: string
  text: string
  tone?: "text" | "muted" | "primary" | "success" | "warning" | "error"
}

type ChatProviderList = {
  providers: Array<{
    id: string
    models?: Record<string, { id?: string }>
  }>
  default: Record<string, string>
}

type ChatAgent = {
  name: string
  mode?: string
  hidden?: boolean
}

function workflowColor(status: ResearchCockpitWorkflowStatus) {
  if (status === "done") return cockpitColors.text
  if (status === "active") return cockpitColors.primary
  return cockpitColors.textMuted
}

function streamLineColor(tone: StreamLine["tone"]) {
  if (tone === "primary") return cockpitColors.primary
  if (tone === "success") return cockpitColors.success
  if (tone === "warning") return cockpitColors.warning
  if (tone === "error") return cockpitColors.error
  if (tone === "text") return cockpitColors.text
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
  const dimensions = useTerminalDimensions()
  const command = useCommandDialog()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const textareaKeybindings = useTextareaKeybindings()
  const slashSelection = createResearchSlashSelection()
  const [refresh, setRefresh] = createSignal(0)
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [selectedCandidateIndex, setSelectedCandidateIndex] = createSignal(0)
  const [busy, setBusy] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [errorEvents, setErrorEvents] = createSignal<Array<{ id: number; action: string; text: string }>>([])
  const [actionEvents, setActionEvents] = createSignal<Array<{ id: number; action: string; text: string }>>([])
  const [promptValue, setPromptValue] = createSignal("")
  const [promptEvents, setPromptEvents] = createSignal<Array<{ id: number; text: string; taskID?: string; detail?: string }>>(
    [],
  )
  const [chatSessionID, setChatSessionID] = createSignal<string>()
  let errorEventID = 0
  let actionEventID = 0
  const routedGoalsHandled = new Set<string>()
  let routedCsvTaskHandled = false
  let actionQueue = Promise.resolve()

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
    if (!researchGoal || routedGoalsHandled.has(researchGoal)) return
    routedGoalsHandled.add(researchGoal)
    void createTaskFromPrompt(researchGoal, "home")
  })

  createEffect(() => {
    const shouldOpenCsvTask = route.data.type === "cockpit" && route.data.newCsvTask
    if (!shouldOpenCsvTask || routedCsvTaskHandled) return
    routedCsvTaskHandled = true
    setTimeout(() => {
      void createCsvTask("autonomous")
    }, 0)
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
  const runnerStatus = createMemo(() => getResearchCockpitRunnerStatus(selectedTask(), { validateRuntime: true }))
  const runnerReady = createMemo(() => runnerStatus().ready)
  const taskCandidates = createMemo(() => candidates() ?? [])
  const taskRuns = createMemo(() => runs() ?? [])
  const taskArtifacts = createMemo(() => artifacts() ?? [])
  const taskApprovals = createMemo(() => approvals() ?? [])
  const validChampion = createMemo(() => {
    const item = champion()
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof item.candidateID !== "string" ||
      typeof item.primaryMetric !== "number" ||
      typeof item.utility !== "number"
    ) {
      return undefined
    }
    return item
  })
  const selectedCandidate = createMemo(() => taskCandidates()[selectedCandidateIndex()])
  const commandCandidate = () => selectedCandidate()
  const candidatePosition = createMemo(() => {
    const count = taskCandidates().length
    if (count === 0) return "Candidate 0/0"
    return `Candidate ${selectedCandidateIndex() + 1}/${count}`
  })
  createEffect(() => {
    const count = taskCandidates().length
    if (count === 0 && selectedCandidateIndex() !== 0) {
      setSelectedCandidateIndex(0)
      return
    }
    if (count > 0 && selectedCandidateIndex() >= count) {
      setSelectedCandidateIndex(count - 1)
    }
  })
  const workflowItems = createMemo(() =>
    buildResearchCockpitWorkflow({
      task: selectedTask(),
      candidates: taskCandidates(),
      runs: taskRuns(),
      artifacts: taskArtifacts(),
      approvals: taskApprovals(),
      champion: validChampion() ?? null,
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
      champion: validChampion() ?? null,
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
    const run = async () => {
      setBusy(name)
      try {
        const message = await fn()
        setError(undefined)
        setActionEvents((events) => [
          ...events.slice(-(promptEventHistoryLimit - 1)),
          { id: ++actionEventID, action: name, text: message },
        ])
        toast.show({ variant: "info", message })
        setRefresh((value) => value + 1)
      } catch (err) {
        const message = formatError(err)
        setError(message)
        setErrorEvents((events) => [
          ...events.slice(-(errorEventHistoryLimit - 1)),
          { id: ++errorEventID, action: name, text: message },
        ])
        toast.show({ variant: "error", message })
      } finally {
        setBusy(undefined)
      }
    }
    const queued = actionQueue.then(run, run)
    actionQueue = queued.then(
      () => undefined,
      () => undefined,
    )
    await queued
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

  async function resolveChatDefaults() {
    const [providersResult, agentsResult] = await Promise.all([
      researchRequest<ChatProviderList>(sdk, "/config/providers"),
      researchRequest<ChatAgent[]>(sdk, "/agent"),
    ])
    if (!Array.isArray(providersResult.providers)) {
      throw new Error("AI provider list is unavailable.")
    }
    if (!Array.isArray(agentsResult)) {
      throw new Error("AI agent list is unavailable.")
    }
    const provider = providersResult.providers.find((item) => Object.keys(item.models ?? {}).length > 0)
    if (!provider) {
      throw new Error("No AI provider is configured. Run neo-research init or set an API key, then reopen the TUI.")
    }
    const modelID = providersResult.default[provider.id] ?? Object.keys(provider.models ?? {})[0]
    if (!modelID) throw new Error(`No model is available for provider ${provider.id}.`)
    const agent = agentsResult.find((item) => item.mode !== "subagent" && !item.hidden) ?? agentsResult[0]
    if (!agent) throw new Error("No primary agent is available for chat.")
    return {
      agent: agent.name,
      model: {
        providerID: provider.id,
        modelID,
      },
    }
  }

  async function ensureChatSession() {
    const existing = chatSessionID()
    if (existing) return existing
    const session = await researchRequest<{ id: string }>(sdk, "/session", {
      method: "POST",
      body: JSON.stringify({ title: "NeoResearch Cockpit" }),
    })
    setChatSessionID(session.id)
    return session.id
  }

  function chatContextForPrompt(value: string) {
    const task = selectedTask()
    const candidate = selectedCandidate()
    const run = latestRun()
    const context = [
      "You are NeoResearch's Research Agent inside a time-series forecasting cockpit.",
      "Answer conversationally and help the user operate the current research workspace.",
      "Do not claim that an experiment ran unless the Research OS task state or run history says so.",
      task ? `Task: ${task.title} / ${task.mode} / ${task.status}` : "Task: none selected",
      task ? `Objective: ${task.objective.primaryMetric ?? "unknown"} ${task.objective.direction ?? ""}`.trim() : "",
      task ? `Budget: ${succeededRuns()}/${Number(task.budget.maxRuns ?? 0)} succeeded runs` : "",
      candidate ? `Selected candidate: ${candidate.id} / ${researchCockpitCandidateTitle(candidate)}` : "",
      run ? `Latest run: ${run.id} / ${run.stage ?? "run"} / ${run.status} / ${metricText(run.metrics)}` : "",
    ]
      .filter(Boolean)
      .join("\n")
    return [
      {
        type: "text" as const,
        text: context,
        synthetic: true,
      },
      {
        type: "text" as const,
        text: value,
      },
    ]
  }

  async function sendChatPrompt(value: string, resolvedDefaults?: Awaited<ReturnType<typeof resolveChatDefaults>>) {
    await runAction("chat", async () => {
      const [sessionID, defaults] = await Promise.all([
        ensureChatSession(),
        resolvedDefaults ? Promise.resolve(resolvedDefaults) : resolveChatDefaults(),
      ])
      const message = await researchRequest<unknown>(sdk, `/session/${encodeURIComponent(sessionID)}/message`, {
        method: "POST",
        body: JSON.stringify({
          ...defaults.model,
          agent: defaults.agent,
          model: defaults.model,
          parts: chatContextForPrompt(value),
        }),
      })
      return assistantTextFromResponse(message)
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

  function selectCandidateOffset(offset: number) {
    const count = taskCandidates().length
    if (count < 2) return
    setSelectedCandidateIndex((value) => (value + offset + count) % count)
  }

  async function useProjectRunnerRoot() {
    const root = sdk.directory ?? process.cwd()
    const task = selectedTask()
    if (!task || !root.trim()) return
    await runAction("configure-runner-root", async () => {
      const updated = updateResearchCockpitTaskRunnerRoot(task, root)
      const saved = await researchRequest<ResearchCockpitTask>(
        sdk,
        `/research/tasks/${encodeURIComponent(task.id)}/spec`,
        {
          method: "PATCH",
          body: JSON.stringify({ taskSpec: updated.taskSpec }),
        },
      )
      return `runner root set for ${saved.title}`
    })
  }

  async function editRunnerRoot() {
    const task = selectedTask()
    if (!task) return
    const value = await DialogPrompt.show(dialog, "Neo-Cast runner root", {
      placeholder: sdk.directory ?? "/path/to/neo_cast",
      description: () => <text fg={theme.textMuted}>Path containing the Neo-Cast project runtime.</text>,
    })
    const root = value?.trim()
    if (!root) return
    await runAction("configure-runner-root", async () => {
      const updated = updateResearchCockpitTaskRunnerRoot(task, root)
      const saved = await researchRequest<ResearchCockpitTask>(
        sdk,
        `/research/tasks/${encodeURIComponent(task.id)}/spec`,
        {
          method: "PATCH",
          body: JSON.stringify({ taskSpec: updated.taskSpec }),
        },
      )
      return `runner root set for ${saved.title}`
    })
    dialog.clear()
  }

  async function runRecommendedAction() {
    const task = selectedTask()
    const next = recommendation().action
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
    if (next === "profile") {
      await profileTask()
      return
    }
    if (next === "seed_baselines") {
      await seedBaselines()
      return
    }
    if (next === "run_autonomous_loop") {
      await runAutonomousLoop()
      return
    }
    if (next === "configure_runner") {
      await useProjectRunnerRoot()
      return
    }
    const candidate = taskCandidates().find(canRunResearchCockpitCandidate)
    if (next === "run_smoke" && candidate && runnerReady()) {
      await executeCandidate(candidate)
      return
    }
    if (next === "export_report") {
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
    if (name === "doctor" || name === "api-key" || name === "provider" || name === "auth") {
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
    if (name === "candidate-next" || name === "cand-next") {
      selectCandidateOffset(1)
      return
    }
    if (name === "candidate-prev" || name === "candidate-previous" || name === "cand-prev") {
      selectCandidateOffset(-1)
      return
    }
    if (name === "runner-root" || name === "use-project-runner") {
      await useProjectRunnerRoot()
      return
    }
    if (name === "edit-runner-root") {
      await editRunnerRoot()
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
      const runnerOptions = { validateRuntime: true }
      const executableTask = canExecuteResearchCockpitTask(task, runnerOptions) ? task : { ...task, taskSpec: payload.taskSpec }
      let detail = eventDetail
      let actionMessage = `${task.title} ${detail}`
      if (executableTask.mode === "autonomous" && canExecuteResearchCockpitTask(executableTask, runnerOptions)) {
        const result = await researchRequest<ResearchCockpitIterationResult>(
          sdk,
          `/research/tasks/${encodeURIComponent(executableTask.id)}/autonomous/iterate`,
          {
            method: "POST",
            body: JSON.stringify({ stage: "smoke", description: value }),
          },
        )
        detail = `${eventDetail}; submitted to research agent`
        actionMessage = formatResearchCockpitIteration(result)
      }
      setSelectedIndex(0)
      setPromptEvents((events) => [
        ...events.slice(-(promptEventHistoryLimit - 1)),
        {
          id: ++promptEventID,
          text: value,
          taskID: task.id,
          detail,
        },
      ])
      return actionMessage
    })
  }

  async function submitPrompt() {
    const value = promptInput?.plainText.trim()
    if (!value) return
    const task = selectedTask()
    promptInput?.clear()
    setPromptValue("")
    if (value.startsWith("/")) {
      if (!(await runVisibleSlashPrompt(value))) await runSlashPrompt(value)
      promptInput?.focus()
      return
    }
    if (!task) {
      setPromptEvents((events) => [
        ...events.slice(-(promptEventHistoryLimit - 1)),
        {
          id: ++promptEventID,
          text: value,
        },
      ])
      await sendChatPrompt(value)
      promptInput?.focus()
      return
    }
    setPromptEvents((events) => [
      ...events.slice(-(promptEventHistoryLimit - 1)),
      {
        id: ++promptEventID,
        text: value,
        taskID: task?.id,
      },
    ])
    if (task.mode === "autonomous" && runnerReady()) {
      await sendChatPrompt(value)
      promptInput?.focus()
      return
    }
    await sendChatPrompt(value)
    promptInput?.focus()
  }

  function selectSlashOption(option: SlashOption) {
    if (option.onSelect) {
      option.onSelect()
    } else {
      void runSlashPrompt(option.display)
    }
    promptInput?.clear()
    setPromptValue("")
    promptInput?.focus()
  }

  async function runVisibleSlashPrompt(value: string) {
    const option = resolveSlashOption(value, command.slashes(), slashSelection)
    if (!option) return false
    selectSlashOption(option)
    return true
  }

  function handleSlashKeyDown(evt: KeyEvent) {
    const value = promptInput?.plainText ?? promptValue()
    const options = command.slashes()
    if (!slashMenuHasOptions(value, options)) return
    const name = evt.name?.toLowerCase()
    const ctrlOnly = evt.ctrl && !evt.meta && !evt.shift
    if (name === "down" || (ctrlOnly && name === "n")) {
      evt.preventDefault()
      moveSlashSelection(value, options, 1, slashSelection)
      return
    }
    if (name === "up" || (ctrlOnly && name === "p")) {
      evt.preventDefault()
      moveSlashSelection(value, options, -1, slashSelection)
      return
    }
    if (name === "return" || name === "tab") {
      const option = resolveSlashOption(value, options, slashSelection)
      if (!option) return
      evt.preventDefault()
      selectSlashOption(option)
    }
  }

  command.register(() => [
    {
      title: "Back to NeoResearch home",
      value: "research.home",
      category: "Research",
      keybind: "alt+h",
      slash: { name: "home" },
      onSelect: () => route.navigate({ type: "home" }),
    },
    {
      title: "Configure API key from NeoResearch home",
      value: "research.provider.configure.home",
      category: "Research",
      slash: { name: "api-key", aliases: ["provider", "auth"] },
      onSelect: () => route.navigate({ type: "home" }),
    },
    {
      title: "Run environment doctor from NeoResearch home",
      value: "research.doctor.home",
      category: "Research",
      slash: { name: "doctor" },
      onSelect: () => route.navigate({ type: "home" }),
    },
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
      keybind: "ctrl+n",
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
      keybind: "ctrl+b",
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
      keybind: "ctrl+l",
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
      keybind: "ctrl+j",
      slash: { name: "task-next" },
      onSelect: () => selectTaskOffset(1),
    },
    {
      title: "Select previous research task",
      value: "research.task.previous",
      category: "Research",
      enabled: sortedTasks().length > 1,
      keybind: "ctrl+k",
      slash: { name: "task-previous", aliases: ["task-prev"] },
      onSelect: () => selectTaskOffset(-1),
    },
    {
      title: "Select next research candidate",
      value: "research.candidate.next",
      category: "Research",
      enabled: taskCandidates().length > 1,
      keybind: "alt+right",
      slash: { name: "candidate-next", aliases: ["cand-next"] },
      onSelect: () => selectCandidateOffset(1),
    },
    {
      title: "Select previous research candidate",
      value: "research.candidate.previous",
      category: "Research",
      enabled: taskCandidates().length > 1,
      keybind: "alt+left",
      slash: { name: "candidate-previous", aliases: ["candidate-prev", "cand-prev"] },
      onSelect: () => selectCandidateOffset(-1),
    },
    {
      title: "Use project as Neo-Cast runner root",
      value: "research.runner.useProject",
      category: "Research",
      enabled: !!selectedTask(),
      slash: { name: "use-project-runner", aliases: ["runner-root"] },
      onSelect: () => void useProjectRunnerRoot(),
    },
    {
      title: "Edit Neo-Cast runner root",
      value: "research.runner.edit",
      category: "Research",
      enabled: !!selectedTask(),
      slash: { name: "edit-runner-root" },
      onSelect: () => void editRunnerRoot(),
    },
    {
      title: "Request reference test gate for selected candidate",
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
      title: "Run smoke seed sweep for selected candidate",
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
      title: "Execute reference test for selected candidate",
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
      title: "Request blind test gate for selected candidate",
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
      title: "Execute blind test for selected candidate",
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
      keybind: "ctrl+e",
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
  const latestRun = createMemo(() => (runs() ?? [])[0])
  const forecasterStatus = createMemo<ResearchCockpitWorkflowStatus>(() => {
    if (maxRuns() > 0 && succeededRuns() >= maxRuns()) return "done"
    if (succeededRuns() > 0) return "active"
    const items = workflowItems()
    if (items[5]?.status === "done") return "done"
    if (items[2]?.status !== "todo" || items[3]?.status !== "todo") return "active"
    return "todo"
  })
  const latestFailedRun = createMemo(() => taskRuns().find((run) => run.status === "failed" && runFailureText(run)))
  const visibleCandidates = createMemo(() => {
    const items = taskCandidates()
    if (items.length <= 4) return items
    const index = selectedCandidateIndex()
    const start = Math.max(0, Math.min(index - 1, items.length - 4))
    return items.slice(start, start + 4)
  })
  const profileSummary = createMemo(() => formatResearchCockpitProfile(taskFingerprint() ?? {}))
  const candidateRunCount = (candidate: ResearchCockpitCandidate) =>
    taskRuns().filter((run) => run.candidateID === candidate.id).length
  const candidateStageRun = (candidate: ResearchCockpitCandidate, stage: CandidateRunStage) =>
    taskRuns().find((run) => run.candidateID === candidate.id && run.stage === stage)
  const candidateStageSummary = (candidate: ResearchCockpitCandidate, stage: CandidateRunStage) => {
    const run = candidateStageRun(candidate, stage)
    if (!run) return "-"
    return `${run.status} ${metricText(run.metrics)}`
  }
  const actionColor = (enabled: boolean) => (enabled && !busy() ? cockpitColors.primary : cockpitColors.textMuted)
  const approvedGateColor = (enabled: boolean, approved: boolean) => {
    if (approved) return cockpitColors.success
    return actionColor(enabled)
  }
  const streamLines = createMemo<StreamLine[]>(() => {
    const lines: StreamLine[] = []
    const hasConversation = promptEvents().length > 0 || actionEvents().length > 0 || errorEvents().length > 0 || !!busy()
    const run = latestRun()
    if (!hasConversation && run) {
      const tone = run.status === "succeeded" ? "success" : run.status === "failed" ? "error" : "warning"
      lines.push({
        id: `run-${run.id}`,
        text: runSummaryText(run),
        tone,
      })
      const failure = runFailureText(run)
      if (failure) {
        lines.push({
          id: `run-${run.id}-failure`,
          text: `Failure: ${failure}`,
          tone: "error",
        })
      }
    }
    for (const event of promptEvents()) {
      lines.push({ id: `prompt-${event.id}`, text: `You: ${event.text}`, tone: "text" })
      if (event.detail) lines.push({ id: `prompt-detail-${event.id}`, text: event.detail, tone: "muted" })
    }
    for (const event of actionEvents()) {
      const text = event.text.trim() || "completed"
      const parts = text.split(/\r?\n/)
      parts.forEach((part, index) => {
        lines.push({
          id: `action-${event.id}-${index}`,
          text: index === 0 ? `Research Agent: ${part}` : `  ${part}`,
          tone: "primary",
        })
      })
    }
    for (const item of errorEvents().slice(-errorEventHistoryLimit)) {
      lines.push({ id: `error-${item.id}`, text: `${item.action}: ${item.text}`, tone: "error" })
    }
    const active = busy()
    if (active) lines.push({ id: "busy", text: `Running ${active}...`, tone: "warning" })
    if (lines.length > 0) return lines
    if (selectedTask()) {
      return [{ id: "idle-task", text: "Research output will appear here as the agent runs.", tone: "muted" }]
    }
    return [{ id: "idle-empty", text: "Describe a forecasting goal or create a CSV task to begin.", tone: "muted" }]
  })
  const promptPlaceholder = createMemo(() =>
    selectedTask()
      ? "Ask for the next experiment, approve a gate, or export the report..."
      : "Ask Research Agent, or use New CSV Task to create a dataset-backed task...",
  )
  const sidebarVisible = createMemo(() => dimensions().width >= 92)
  const sidebarWidth = createMemo(() => {
    const width = dimensions().width
    if (width >= 140) return 42
    if (width >= 110) return 36
    return 32
  })

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
        <box flexShrink={0} paddingBottom={1} gap={1}>
          <text fg={cockpitColors.text} attributes={TextAttributes.BOLD}>
            NeoResearch Workspace
          </text>
          <box flexDirection="row" gap={2}>
            <text fg={cockpitColors.primary} onMouseUp={() => route.navigate({ type: "home" })}>
              Home alt+h
            </text>
            <text fg={sortedTasks().length < 2 ? cockpitColors.textMuted : cockpitColors.primary} onMouseUp={() => selectTaskOffset(-1)}>
              Previous Task ^K
            </text>
            <text fg={sortedTasks().length < 2 ? cockpitColors.textMuted : cockpitColors.primary} onMouseUp={() => selectTaskOffset(1)}>
              Next Task ^J
            </text>
            <text
              fg={busy() ? cockpitColors.textMuted : cockpitColors.primary}
              onMouseUp={() => {
                if (busy()) return
                void createCsvTask("autonomous")
              }}
            >
              New CSV Task ^N
            </text>
            <text
              fg={!selectedTask() || busy() ? cockpitColors.textMuted : cockpitColors.primary}
              onMouseUp={() => {
                if (!selectedTask() || busy()) return
                void seedBaselines()
              }}
            >
              Seed Baselines ^B
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
              Agent Loop ^L
            </text>
            <text
              fg={!selectedTask() || busy() ? cockpitColors.textMuted : cockpitColors.primary}
              onMouseUp={() => {
                if (!selectedTask() || busy()) return
                void exportTaskArtifact()
              }}
            >
              Export Report ^E
            </text>
          </box>
        </box>

        <box flexGrow={1} minHeight={0} gap={1} paddingTop={1}>
          <Show when={busy()}>
            <box backgroundColor={cockpitColors.panel} border={["left"]} borderColor={cockpitColors.warning} paddingLeft={1}>
              <text fg={cockpitColors.warning} attributes={TextAttributes.BOLD}>
                Active Action
              </text>
              <text fg={cockpitColors.warning}>Running {busy()}...</text>
            </box>
          </Show>

          <Show when={latestFailedRun()}>
            {(run) => (
              <box backgroundColor={cockpitColors.panel} border={["left"]} borderColor={cockpitColors.error} paddingLeft={1}>
                <text fg={cockpitColors.error} attributes={TextAttributes.BOLD}>
                  Latest Failure
                </text>
                <text fg={cockpitColors.error} width="100%" overflow="hidden" wrapMode="none">
                  {run().id} {run().stage ?? "run"} {run().status}
                </text>
                <text fg={cockpitColors.error} width="100%" overflow="hidden" wrapMode="none">
                  {runFailureText(run())}
                </text>
              </box>
            )}
          </Show>

          <Show when={selectedTask()}>
            <box gap={0}>
              <text fg={cockpitColors.text} attributes={TextAttributes.BOLD}>
                Candidate Table
              </text>
              <Show
                when={taskCandidates().length > 0}
                fallback={<text fg={cockpitColors.textMuted}>No candidates yet</text>}
              >
                <For each={visibleCandidates()}>
                  {(candidate) => (
                    <box gap={0}>
                      <text
                        fg={candidate.id === selectedCandidate()?.id ? cockpitColors.primary : cockpitColors.text}
                        width="100%"
                        overflow="hidden"
                        wrapMode="none"
                      >
                        {candidate.id === selectedCandidate()?.id ? "> " : "  "}
                        {researchCockpitCandidateTitle(candidate)} / {shortID(candidate.id)} / {candidate.approvalStatus} / smoke{" "}
                        {candidateStageSummary(candidate, "smoke")} / runs {candidateRunCount(candidate)}
                      </text>
                      <text fg={cockpitColors.textMuted} width="100%" overflow="hidden" wrapMode="none">
                        {"  "}
                        {researchCockpitCandidatePipeline(candidate) || candidate.rationale || candidate.id}
                      </text>
                      <Show when={candidate.id === selectedCandidate()?.id}>
                        <box flexDirection="row" gap={2}>
                          <text
                            fg={actionColor(canRunResearchCockpitCandidate(candidate))}
                            onMouseUp={() => {
                              if (!canRunResearchCockpitCandidate(candidate) || busy()) return
                              void prepareCandidate(candidate)
                            }}
                          >
                            Smoke Prep
                          </text>
                          <text
                            fg={actionColor(runnerReady() && canRunResearchCockpitCandidate(candidate))}
                            onMouseUp={() => {
                              if (!runnerReady() || !canRunResearchCockpitCandidate(candidate) || busy()) return
                              void executeCandidate(candidate)
                            }}
                          >
                            Smoke Exec
                          </text>
                          <text
                            fg={actionColor(runnerReady() && canRunResearchCockpitCandidate(candidate))}
                            onMouseUp={() => {
                              if (!runnerReady() || !canRunResearchCockpitCandidate(candidate) || busy()) return
                              void executeCandidateSeedSweep(candidate)
                            }}
                          >
                            Seed Sweep
                          </text>
                        </box>
                        <box flexDirection="row" gap={2}>
                          <text
                            fg={approvedGateColor(
                              canRunResearchCockpitCandidate(candidate),
                              hasApprovedResearchCockpitRefTestGate(taskApprovals(), candidate.id),
                            )}
                            onMouseUp={() => {
                              if (!canRunResearchCockpitCandidate(candidate) || busy()) return
                              void requestRefTestGate(candidate)
                            }}
                          >
                            Ref Gate
                          </text>
                          <text
                            fg={actionColor(canRunResearchCockpitCandidate(candidate))}
                            onMouseUp={() => {
                              if (!canRunResearchCockpitCandidate(candidate) || busy()) return
                              void prepareCandidate(candidate, "ref_test")
                            }}
                          >
                            Ref Prep
                          </text>
                          <text
                            fg={actionColor(runnerReady() && canRunResearchCockpitCandidate(candidate))}
                            onMouseUp={() => {
                              if (!runnerReady() || !canRunResearchCockpitCandidate(candidate) || busy()) return
                              void executeCandidate(candidate, "ref_test")
                            }}
                          >
                            Ref Exec
                          </text>
                        </box>
                        <box flexDirection="row" gap={2}>
                          <text
                            fg={approvedGateColor(
                              canRunResearchCockpitCandidate(candidate),
                              hasApprovedResearchCockpitBlindTestGate(taskApprovals(), candidate.id),
                            )}
                            onMouseUp={() => {
                              if (!canRunResearchCockpitCandidate(candidate) || busy()) return
                              void requestBlindTestGate(candidate)
                            }}
                          >
                            Blind Gate
                          </text>
                          <text
                            fg={actionColor(canRunResearchCockpitCandidate(candidate))}
                            onMouseUp={() => {
                              if (!canRunResearchCockpitCandidate(candidate) || busy()) return
                              void prepareCandidate(candidate, "blind_test")
                            }}
                          >
                            Blind Prep
                          </text>
                          <text
                            fg={actionColor(runnerReady() && canRunResearchCockpitCandidate(candidate))}
                            onMouseUp={() => {
                              if (!runnerReady() || !canRunResearchCockpitCandidate(candidate) || busy()) return
                              void executeCandidate(candidate, "blind_test")
                            }}
                          >
                            Blind Exec
                          </text>
                        </box>
                      </Show>
                    </box>
                  )}
                </For>
              </Show>
            </box>

            <box gap={0}>
              <text fg={cockpitColors.text} attributes={TextAttributes.BOLD}>
                Run History
              </text>
              <Show when={taskRuns().length > 0} fallback={<text fg={cockpitColors.textMuted}>No runs yet</text>}>
                <For each={taskRuns().slice(0, 5)}>
                  {(run) => (
                    <>
                      <text fg={statusColor(run.status)} width="100%" overflow="hidden" wrapMode="none">
                        {runSummaryText(run)}
                      </text>
                      <Show when={runFailureText(run)}>
                        {(failure) => (
                          <text fg={cockpitColors.error} width="100%" overflow="hidden" wrapMode="none">
                            {"  "}
                            {failure()}
                          </text>
                        )}
                      </Show>
                    </>
                  )}
                </For>
              </Show>
            </box>

            <box gap={0}>
              <text fg={cockpitColors.text} attributes={TextAttributes.BOLD}>
                Dataset Profile
              </text>
              <text
                fg={profileSummary() === "-" ? cockpitColors.textMuted : cockpitColors.text}
                width="100%"
                overflow="hidden"
                wrapMode="none"
              >
                {profileSummary()}
              </text>
            </box>

            <Show when={taskArtifacts().length > 0}>
              <box gap={0}>
                <text fg={cockpitColors.text} attributes={TextAttributes.BOLD}>
                  Artifacts
                </text>
                <For each={taskArtifacts().slice(0, 3)}>
                  {(artifact) => (
                    <text fg={cockpitColors.textMuted} width="100%" overflow="hidden" wrapMode="none">
                      {artifact.kind} / {formatResearchCockpitArtifactMetadata(artifact) ?? researchCockpitArtifactTarget(artifact)}
                    </text>
                  )}
                </For>
              </box>
            </Show>

            <Show when={memory()?.length}>
              <box gap={0}>
                <text fg={cockpitColors.text} attributes={TextAttributes.BOLD}>
                  Memory
                </text>
                <For each={(memory() ?? []).slice(0, 3)}>
                  {(item) => (
                    <text fg={cockpitColors.textMuted} width="100%" overflow="hidden" wrapMode="none">
                      {formatResearchCockpitMemory(item)}
                    </text>
                  )}
                </For>
              </box>
            </Show>
          </Show>

          <Show when={errorEvents().length > 0}>
            <box gap={0}>
              <text fg={cockpitColors.error} attributes={TextAttributes.BOLD}>
                Error Log
              </text>
              <For each={errorEvents().slice(-errorEventHistoryLimit)}>
                {(item) => (
                  <text fg={cockpitColors.error} width="100%" overflow="hidden" wrapMode="none">
                    {item.action}: {item.text}
                  </text>
                )}
              </For>
            </box>
          </Show>

          <box gap={0}>
            <text fg={cockpitColors.text} attributes={TextAttributes.BOLD}>
              Research Stream
            </text>
            <For each={streamLines()}>
              {(line) => (
                <text fg={streamLineColor(line.tone)} width="100%" overflow="hidden" wrapMode="none">
                  {line.text}
                </text>
              )}
            </For>
          </box>
        </box>

        <box
          flexShrink={0}
          height={3}
          backgroundColor={cockpitColors.panel}
          border={["left"]}
          borderColor={cockpitColors.primary}
          paddingLeft={1}
          paddingRight={1}
        >
          <textarea
            ref={(value: TextareaRenderable) => {
              promptInput = value
              value.traits = { status: "FORECAST" }
              value.focus()
            }}
            minHeight={1}
            maxHeight={1}
            keyBindings={textareaKeybindings()}
            onKeyDown={handleSlashKeyDown}
            onContentChange={() => setPromptValue(promptInput?.plainText ?? "")}
            onSubmit={() => void submitPrompt()}
            placeholder={promptPlaceholder()}
            placeholderColor={cockpitColors.textMuted}
            textColor={cockpitColors.text}
            focusedTextColor={cockpitColors.text}
            cursorColor={cockpitColors.primary}
          />
          <ResearchSlashMenu
            value={promptValue()}
            options={() => command.slashes()}
            anchor={() => promptInput}
            placement="above"
            colors={{
              panel: cockpitColors.panel,
              border: cockpitColors.border,
              text: cockpitColors.text,
              textMuted: cockpitColors.textMuted,
              primary: cockpitColors.primary,
            }}
            onSelect={selectSlashOption}
            selection={slashSelection}
          />
          <box flexDirection="row" gap={2}>
            <text fg={cockpitColors.primary}>Planner</text>
            <text fg={cockpitColors.text}>Research Agent</text>
          </box>
        </box>

        <box flexShrink={0} flexDirection="row" justifyContent="space-between">
          <text fg={cockpitColors.textMuted}>enter submit</text>
          <box flexDirection="row" gap={2}>
            <text fg={cockpitColors.textMuted}>ctrl+p commands</text>
          </box>
        </box>
      </box>

      <Show when={sidebarVisible()}>
        <box
          width={sidebarWidth()}
          height="100%"
          flexShrink={0}
          backgroundColor={cockpitColors.sidebar}
          border={["left"]}
          borderColor={cockpitColors.border}
          paddingLeft={2}
          paddingRight={1}
          paddingTop={1}
          gap={1}
        >
        <text fg={cockpitColors.text} attributes={TextAttributes.BOLD} width="100%" overflow="hidden" wrapMode="none">
          {taskLabel()}
        </text>
        <text fg={cockpitColors.textMuted}>{selectedTaskPosition()}</text>
        <text fg={cockpitColors.textMuted}>{candidatePosition()}</text>
        <text fg={statusColor(taskStatus())}>{taskStatus()}</text>
        <Show when={selectedTask() && !runnerReady()}>
          <text fg={cockpitColors.textMuted}>
            {runnerStatus().reason === "missing_python" || runnerStatus().reason === "unsupported_python"
              ? "Runner runtime not ready"
              : "Runner not ready"}
          </text>
          <text
            fg={busy() ? cockpitColors.textMuted : cockpitColors.primary}
            onMouseUp={() => {
              if (busy()) return
              void useProjectRunnerRoot()
            }}
          >
            Use Project Runner
          </text>
        </Show>

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
          <text fg={workflowColor(forecasterStatus())}>
            {workflowMark(forecasterStatus())} Forecaster {succeededRuns()}/{maxRuns()} experiments
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

        <Show when={errorEvents().length > 0}>
          <box gap={0} paddingTop={1}>
            <text fg={cockpitColors.error} attributes={TextAttributes.BOLD}>
              Recent Errors
            </text>
            <For each={errorEvents().slice(-2)}>
              {(item) => (
                <>
                  <text fg={cockpitColors.textMuted} width="100%" overflow="hidden" wrapMode="none">
                    {item.action}
                  </text>
                  <text fg={cockpitColors.error} width="100%" overflow="hidden" wrapMode="none">
                    {item.text}
                  </text>
                </>
              )}
            </For>
          </box>
        </Show>

        <box gap={0} paddingTop={1}>
          <text fg={cockpitColors.text} attributes={TextAttributes.BOLD}>
            Champion
          </text>
          <Show
            when={validChampion()}
            fallback={<text fg={cockpitColors.textMuted}>No champion selected</text>}
          >
            {(item) => (
              <>
                <text fg={cockpitColors.textMuted}>candidate {shortID(item().candidateID)}</text>
                <text fg={cockpitColors.success}>metric={item().primaryMetric.toPrecision(4)}</text>
                <text fg={cockpitColors.success}>utility={item().utility.toPrecision(4)}</text>
              </>
            )}
          </Show>
        </box>

        <box flexGrow={1} justifyContent="flex-end" paddingBottom={1}>
          <text fg={cockpitColors.textMuted} width="100%" overflow="hidden" wrapMode="none">
            {taskPath()}
          </text>
          <text fg={runnerReady() ? cockpitColors.success : cockpitColors.textMuted}>NeoResearch alpha</text>
        </box>
        </box>
      </Show>
    </box>
  )
}
