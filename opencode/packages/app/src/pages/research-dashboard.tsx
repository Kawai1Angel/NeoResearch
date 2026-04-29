import { Button } from "@opencode-ai/ui/button"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useNavigate } from "@solidjs/router"
import { DateTime } from "luxon"
import { createEffect, createMemo, createResource, For, Match, onCleanup, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { DialogSelectDirectory } from "@/components/dialog-select-directory"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import {
  buildDefaultTsfTaskInput,
  buildResearchDashboardStats,
  canExecuteResearchTask,
  formatResearchArtifactMetadataSummary,
  formatResearchArtifactTarget,
  formatResearchExportNotice,
  formatResearchFingerprint,
  formatResearchLoopNotice,
  formatResearchMemoryFingerprint,
  formatResearchMemorySummary,
  formatResearchProfileSummary,
  formatResearchSeedSweepNotice,
  hasApprovedResearchBlindTestGate,
  hasApprovedResearchRefTestGate,
  shouldRefreshResearchDashboardOnEvent,
  sortResearchTasks,
  type JsonRecord,
  type ResearchApproval,
  type ResearchArtifact,
  type ResearchCandidate,
  type ResearchChampion,
  type ResearchExportArtifactResult,
  type ResearchLoopResult,
  type ResearchMemory,
  type ResearchProfileResult,
  type ResearchRun,
  type ResearchSeedSweepResult,
  type ResearchTask,
  type TsfTaskInputOptions,
} from "./research-dashboard-data"

type ResearchSource = {
  directory: string
  refresh: number
}

type CandidateRunStage = Extract<ResearchRun["stage"], "smoke" | "ref_test" | "blind_test">

type ResearchTaskSource = ResearchSource & {
  taskID: string
}

async function researchRequest<T>(
  fetcher: typeof fetch,
  baseURL: string,
  directory: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = new URL(path, baseURL)
  url.searchParams.set("directory", directory)

  const headers = new Headers(init.headers)
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }

  const response = await fetcher(url, {
    ...init,
    headers,
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `${response.status} ${response.statusText}`)
  }
  return (await response.json()) as T
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function formatError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 420 ? message.slice(0, 417) + "..." : message
}

function compactPath(path: string, home: string) {
  if (!home) return path
  return path.startsWith(home) ? "~" + path.slice(home.length) : path
}

function relativeTime(value: number | undefined) {
  if (!value) return "-"
  return DateTime.fromMillis(value).toRelative() ?? "-"
}

function shortID(value: string) {
  return value.slice(0, 8)
}

function statusClass(status: string) {
  if (
    status === "succeeded" ||
    status === "completed" ||
    status === "approved" ||
    status === "auto_approved" ||
    status === "accepted"
  ) {
    return "text-text-on-success-weak bg-surface-success-weak border-border-success-base"
  }
  if (status === "failed" || status === "rejected") {
    return "text-text-on-critical-weak bg-surface-critical-weak border-border-critical-base"
  }
  if (status === "running" || status === "researching" || status === "baselining" || status === "profiling") {
    return "text-text-on-warning-weak bg-surface-warning-weak border-border-warning-base"
  }
  return "text-text-base bg-surface-base border-border-weak-base"
}

function metricValue(metrics: JsonRecord) {
  const candidates = ["val_avg_mse", "test_avg_mse", "mse", "loss"]
  for (const key of candidates) {
    const value = metrics[key]
    if (typeof value === "number") return `${key}: ${value.toPrecision(4)}`
  }
  return "-"
}

function recipeName(candidate: ResearchCandidate) {
  const recipeID = candidate.candidateSpec.recipeID
  if (typeof recipeID === "string") return recipeID
  return shortID(candidate.id)
}

function recipePipeline(candidate: ResearchCandidate) {
  const spec = candidate.candidateSpec
  const preprocessing = asRecord(spec.preprocessing).actions
  const preprocessingText = Array.isArray(preprocessing)
    ? preprocessing
        .map((action) => asRecord(action).type)
        .filter((item): item is string => typeof item === "string")
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

function projectName(worktree: string) {
  const parts = worktree.split("/").filter(Boolean)
  return parts.at(-1) ?? worktree
}

function splitList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function parsePositiveInt(value: string) {
  const parsed = Number(value.trim())
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function parsePositiveIntList(value: string) {
  const parsed = splitList(value).map((item) => Number(item))
  return parsed.length > 0 && parsed.every((item) => Number.isInteger(item) && item > 0) ? parsed : undefined
}

function EmptyState(props: { icon?: IconProps["name"]; title: string; action?: () => void; actionLabel?: string }) {
  return (
    <div class="min-h-48 flex flex-col items-center justify-center gap-3 border border-dashed border-border-weak-base bg-surface-base p-6 text-center">
      <Show when={props.icon}>
        <Icon name={props.icon!} size="large" />
      </Show>
      <div class="text-14-medium text-text-strong">{props.title}</div>
      <Show when={props.action && props.actionLabel}>
        <Button class="px-3" onClick={props.action}>
          {props.actionLabel}
        </Button>
      </Show>
    </div>
  )
}

function StatusPill(props: { value: string }) {
  return (
    <span class={`inline-flex h-6 items-center border px-2 text-12-medium ${statusClass(props.value)}`}>
      {props.value}
    </span>
  )
}

function Stat(props: { label: string; value: string | number }) {
  return (
    <div class="border border-border-weak-base bg-surface-base px-3 py-2">
      <div class="text-12-regular text-text-weak">{props.label}</div>
      <div class="mt-1 text-18-medium text-text-strong">{props.value}</div>
    </div>
  )
}

export function ResearchDashboard() {
  const sync = useGlobalSync()
  const layout = useLayout()
  const platform = usePlatform()
  const dialog = useDialog()
  const navigate = useNavigate()
  const server = useServer()
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const homedir = createMemo(() => sync.data.path.home)
  const fetcher = createMemo(() => platform.fetch ?? fetch)
  const [state, setState] = createStore({
    selectedDirectory: "",
    selectedTaskID: "",
    refresh: 0,
    busy: undefined as string | undefined,
    notice: "",
    error: "",
    datasetPath: "",
    datasetPreset: "etth1_tslib_v1",
    targetCols: "OT",
    contextLength: "96",
    predictionLengths: "24",
    fullRecipeSpace: false,
  })

  const recent = createMemo(() => {
    return sync.data.project
      .slice()
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .slice(0, 8)
  })

  const serverDotClass = createMemo(() => {
    const healthy = server.healthy()
    if (healthy === true) return "bg-icon-success-base"
    if (healthy === false) return "bg-icon-critical-base"
    return "bg-border-weak-base"
  })

  createEffect(() => {
    if (state.selectedDirectory) return
    const first = recent()[0]
    if (!first) return
    setState("selectedDirectory", first.worktree)
  })

  createEffect(() => {
    const directory = state.selectedDirectory
    if (!directory) return
    const unsubscribe = globalSDK.event.listen((event) => {
      if (event.name !== directory) return
      if (!shouldRefreshResearchDashboardOnEvent(event.details)) return
      setState("refresh", (value) => value + 1)
    })
    onCleanup(unsubscribe)
  })

  function selectProject(directory: string) {
    layout.projects.open(directory)
    server.projects.touch(directory)
    setState("selectedDirectory", directory)
    setState("selectedTaskID", "")
    setState("refresh", (value) => value + 1)
  }

  function openWorkspace(directory: string) {
    selectProject(directory)
    navigate(`/${base64Encode(directory)}`)
  }

  async function chooseProject() {
    function resolve(result: string | string[] | null) {
      if (Array.isArray(result)) {
        for (const directory of result) layout.projects.open(directory)
        const first = result[0]
        if (first) selectProject(first)
      } else if (result) {
        selectProject(result)
      }
    }

    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform.openDirectoryPickerDialog?.({
        title: language.t("command.project.open"),
        multiple: true,
      })
      resolve(result)
    } else {
      dialog.show(
        () => <DialogSelectDirectory multiple={true} onSelect={resolve} />,
        () => resolve(null),
      )
    }
  }

  async function request<T>(directory: string, path: string, init?: RequestInit) {
    return researchRequest<T>(fetcher(), globalSDK.url, directory, path, init)
  }

  const taskSource = createMemo<ResearchSource | undefined>(() => {
    if (!state.selectedDirectory) return undefined
    return { directory: state.selectedDirectory, refresh: state.refresh }
  })

  const [tasks] = createResource(taskSource, async (source) => {
    return request<ResearchTask[]>(source.directory, "/research/tasks?limit=50")
  })

  const sortedTasks = createMemo(() => sortResearchTasks(tasks() ?? []))

  createEffect(() => {
    const list = sortedTasks()
    if (list.length === 0) {
      if (state.selectedTaskID) setState("selectedTaskID", "")
      return
    }
    if (list.some((task) => task.id === state.selectedTaskID)) return
    setState("selectedTaskID", list[0]!.id)
  })

  const selectedTask = createMemo(() => sortedTasks().find((task) => task.id === state.selectedTaskID))
  const selectedTaskSource = createMemo<ResearchTaskSource | undefined>(() => {
    const task = selectedTask()
    if (!task || !state.selectedDirectory) return undefined
    return { directory: state.selectedDirectory, taskID: task.id, refresh: state.refresh }
  })

  const [candidates] = createResource(selectedTaskSource, async (source) => {
    return request<ResearchCandidate[]>(
      source.directory,
      `/research/tasks/${encodeURIComponent(source.taskID)}/candidates`,
    )
  })

  const [runs] = createResource(selectedTaskSource, async (source) => {
    return request<ResearchRun[]>(source.directory, `/research/tasks/${encodeURIComponent(source.taskID)}/runs`)
  })

  const [artifacts] = createResource(selectedTaskSource, async (source) => {
    return request<ResearchArtifact[]>(
      source.directory,
      `/research/tasks/${encodeURIComponent(source.taskID)}/artifacts`,
    )
  })

  const [approvals] = createResource(selectedTaskSource, async (source) => {
    return request<ResearchApproval[]>(
      source.directory,
      `/research/tasks/${encodeURIComponent(source.taskID)}/approvals?limit=20`,
    )
  })

  const [champion] = createResource(selectedTaskSource, async (source) => {
    return request<ResearchChampion | null>(
      source.directory,
      `/research/tasks/${encodeURIComponent(source.taskID)}/champion`,
    )
  })

  const [memory] = createResource(selectedTaskSource, async (source) => {
    return request<ResearchMemory[]>(source.directory, `/research/tasks/${encodeURIComponent(source.taskID)}/memory`)
  })

  const [taskFingerprint] = createResource(selectedTaskSource, async (source) => {
    return request<JsonRecord>(source.directory, `/research/tasks/${encodeURIComponent(source.taskID)}/fingerprint`)
  })

  const stats = createMemo(() =>
    buildResearchDashboardStats({
      tasks: tasks() ?? [],
      candidates: candidates() ?? [],
      runs: runs() ?? [],
      approvals: approvals() ?? [],
      artifacts: artifacts() ?? [],
      memoryCount: memory()?.length ?? 0,
    }),
  )

  const runnerReady = createMemo(() => canExecuteResearchTask(selectedTask()))

  async function runAction(key: string, fn: () => Promise<string>) {
    setState("busy", key)
    setState("notice", "")
    setState("error", "")
    try {
      const notice = await fn()
      setState("notice", notice)
      setState("refresh", (value) => value + 1)
    } catch (error) {
      setState("error", formatError(error))
    } finally {
      setState("busy", undefined)
    }
  }

  async function createResearchTask(mode: "review" | "autonomous") {
    const directory = state.selectedDirectory
    if (!directory) return
    const contextLength = parsePositiveInt(state.contextLength)
    const predictionLengths = parsePositiveIntList(state.predictionLengths)
    if (!contextLength) {
      setState("error", "Context length must be a positive integer.")
      return
    }
    if (!predictionLengths) {
      setState("error", "Prediction lengths must be comma-separated positive integers.")
      return
    }
    const taskOptions: TsfTaskInputOptions = {
      datasetPath: state.datasetPath,
      datasetPreset: state.datasetPreset,
      targetCols: splitList(state.targetCols),
      contextLength,
      predictionLengths,
      bridgeOnly: !state.fullRecipeSpace,
    }
    await runAction(`create:${mode}`, async () => {
      const task = await request<ResearchTask>(directory, "/research/tasks", {
        method: "POST",
        body: JSON.stringify(buildDefaultTsfTaskInput(mode, directory, taskOptions)),
      })
      setState("selectedTaskID", task.id)
      return `${task.title} created`
    })
  }

  async function seedBaselines() {
    const task = selectedTask()
    const directory = state.selectedDirectory
    if (!task || !directory) return
    await runAction("seed-baselines", async () => {
      const seeded = await request<{ candidates: ResearchCandidate[]; approvals: ResearchApproval[] }>(
        directory,
        `/research/tasks/${encodeURIComponent(task.id)}/baselines`,
        { method: "POST" },
      )
      return `${seeded.candidates.length} candidates seeded`
    })
  }

  async function runAutonomousIteration() {
    const task = selectedTask()
    const directory = state.selectedDirectory
    if (!task || !directory || !runnerReady()) return
    await runAction("autonomous-iterate", async () => {
      const result = await request<{ run: ResearchRun; candidate: ResearchCandidate; selectionArtifact?: ResearchArtifact }>(
        directory,
        `/research/tasks/${encodeURIComponent(task.id)}/autonomous/iterate`,
        {
          method: "POST",
          body: JSON.stringify({ stage: "smoke", description: "dashboard autonomous iteration" }),
        },
      )
      return `${recipeName(result.candidate)} ${result.run.status}${
        result.selectionArtifact ? ` / ${result.selectionArtifact.kind}` : ""
      }`
    })
  }

  async function runAutonomousLoop() {
    const task = selectedTask()
    const directory = state.selectedDirectory
    if (!task || !directory || task.mode !== "autonomous" || !runnerReady()) return
    await runAction("autonomous-loop", async () => {
      const result = await request<ResearchLoopResult>(
        directory,
        `/research/tasks/${encodeURIComponent(task.id)}/autonomous/loop`,
        {
          method: "POST",
          body: JSON.stringify({ stage: "smoke", maxIterations: 3, description: "dashboard autonomous loop" }),
        },
      )
      return formatResearchLoopNotice(result)
    })
  }

  async function replyApproval(approval: ResearchApproval, status: "approved" | "rejected") {
    const directory = state.selectedDirectory
    if (!directory) return
    await runAction(`approval:${approval.id}:${status}`, async () => {
      const updated = await request<ResearchApproval>(
        directory,
        `/research/approvals/${encodeURIComponent(approval.id)}/reply`,
        {
          method: "POST",
          body: JSON.stringify({ status }),
        },
      )
      return `${shortID(updated.id)} ${updated.status}`
    })
  }

  async function requestRefTestGate(candidate: ResearchCandidate) {
    const task = selectedTask()
    const directory = state.selectedDirectory
    if (!task || !directory) return
    await runAction(`ref-gate:${candidate.id}`, async () => {
      const approval = await request<ResearchApproval>(directory, "/research/approvals", {
        method: "POST",
        body: JSON.stringify({
          taskID: task.id,
          candidateID: candidate.id,
          kind: "ref_test",
          reason: `Approve reference test access for ${recipeName(candidate)}.`,
        }),
      })
      return `${shortID(approval.id)} ref_test requested`
    })
  }

  async function requestBlindTestGate(candidate: ResearchCandidate) {
    const task = selectedTask()
    const directory = state.selectedDirectory
    if (!task || !directory) return
    await runAction(`blind-gate:${candidate.id}`, async () => {
      const approval = await request<ResearchApproval>(directory, "/research/approvals", {
        method: "POST",
        body: JSON.stringify({
          taskID: task.id,
          candidateID: candidate.id,
          kind: "blind_test",
          reason: `Approve blind test sidecar access for ${recipeName(candidate)}.`,
        }),
      })
      return `${shortID(approval.id)} blind_test requested`
    })
  }

  async function prepareRun(candidate: ResearchCandidate, stage: CandidateRunStage = "smoke") {
    const task = selectedTask()
    const directory = state.selectedDirectory
    if (!task || !directory) return
    await runAction(`prepare:${stage}:${candidate.id}`, async () => {
      const result = await request<{ run: ResearchRun }>(
        directory,
        `/research/tasks/${encodeURIComponent(task.id)}/candidates/${encodeURIComponent(candidate.id)}/prepare-run`,
        {
          method: "POST",
          body: JSON.stringify({ stage, description: `dashboard ${stage} run` }),
        },
      )
      return `${shortID(result.run.id)} ${stage} queued`
    })
  }

  async function executeRun(candidate: ResearchCandidate, stage: CandidateRunStage = "smoke") {
    const task = selectedTask()
    const directory = state.selectedDirectory
    if (!task || !directory || !runnerReady()) return
    await runAction(`execute:${stage}:${candidate.id}`, async () => {
      const result = await request<{ run: ResearchRun }>(
        directory,
        `/research/tasks/${encodeURIComponent(task.id)}/candidates/${encodeURIComponent(candidate.id)}/execute-run`,
        {
          method: "POST",
          body: JSON.stringify({ stage, description: `dashboard ${stage} run` }),
        },
      )
      return `${shortID(result.run.id)} ${stage} ${result.run.status}`
    })
  }

  async function executeSeedSweep(candidate: ResearchCandidate) {
    const task = selectedTask()
    const directory = state.selectedDirectory
    if (!task || !directory || !runnerReady()) return
    await runAction(`seed-sweep:${candidate.id}`, async () => {
      const result = await request<ResearchSeedSweepResult>(
        directory,
        `/research/tasks/${encodeURIComponent(task.id)}/candidates/${encodeURIComponent(candidate.id)}/seed-sweep`,
        {
          method: "POST",
          body: JSON.stringify({ stage: "smoke", description: "dashboard smoke seed sweep" }),
        },
      )
      return formatResearchSeedSweepNotice(result)
    })
  }

  async function exportTaskArtifact() {
    const task = selectedTask()
    const directory = state.selectedDirectory
    if (!task || !directory) return
    await runAction("export-artifact", async () => {
      const result = await request<ResearchExportArtifactResult>(
        directory,
        `/research/tasks/${encodeURIComponent(task.id)}/export`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      )
      return formatResearchExportNotice(result)
    })
  }

  async function profileTask() {
    const task = selectedTask()
    const directory = state.selectedDirectory
    if (!task || !directory) return
    await runAction("profile-task", async () => {
      const result = await request<ResearchProfileResult>(
        directory,
        `/research/tasks/${encodeURIComponent(task.id)}/profile`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      )
      return `profile ${shortID(result.artifact.id)}`
    })
  }

  const detailLoading = createMemo(
    () =>
      candidates.loading ||
      runs.loading ||
      approvals.loading ||
      artifacts.loading ||
      champion.loading ||
      memory.loading ||
      taskFingerprint.loading,
  )

  return (
    <div class="min-h-screen bg-background-base text-text-base">
      <header class="border-b border-border-weak-base bg-surface-base">
        <div class="mx-auto flex max-w-[1500px] items-center justify-between gap-4 px-4 py-3">
          <div class="min-w-0">
            <div class="text-18-medium text-text-strong">NeoResearch</div>
            <div class="text-12-regular text-text-weak">Dashboard</div>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              class="text-14-regular text-text-weak"
              onClick={() => dialog.show(() => <DialogSelectServer />)}
            >
              <div
                classList={{
                  "size-2 rounded-full": true,
                  [serverDotClass()]: true,
                }}
              />
              {server.name}
            </Button>
            <Button icon="folder-add-left" class="pl-2 pr-3" onClick={chooseProject}>
              {language.t("command.project.open")}
            </Button>
          </div>
        </div>
      </header>

      <div class="mx-auto grid max-w-[1500px] gap-4 px-4 py-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside class="min-w-0 border border-border-weak-base bg-background-base">
          <div class="border-b border-border-weak-base px-3 py-2 text-12-medium text-text-weak">Projects</div>
          <div class="flex max-h-[calc(100vh-142px)] flex-col overflow-auto">
            <Switch>
              <Match when={sync.data.project.length > 0}>
                <For each={recent()}>
                  {(project) => (
                    <button
                      type="button"
                      class="flex min-h-14 w-full flex-col items-start justify-center gap-1 border-b border-border-weak-base px-3 text-left hover:bg-surface-base"
                      classList={{
                        "bg-surface-base": state.selectedDirectory === project.worktree,
                      }}
                      onClick={() => selectProject(project.worktree)}
                    >
                      <span class="w-full truncate text-14-medium text-text-strong">
                        {projectName(project.worktree)}
                      </span>
                      <span class="w-full truncate text-12-regular text-text-weak">
                        {compactPath(project.worktree, homedir())}
                      </span>
                    </button>
                  )}
                </For>
              </Match>
              <Match when={!sync.ready}>
                <div class="p-3 text-12-regular text-text-weak">{language.t("common.loading")}</div>
              </Match>
              <Match when={true}>
                <div class="p-3">
                  <EmptyState
                    icon="folder-add-left"
                    title="No project selected"
                    action={chooseProject}
                    actionLabel={language.t("command.project.open")}
                  />
                </div>
              </Match>
            </Switch>
          </div>
        </aside>

        <main class="min-w-0">
          <Switch>
            <Match when={!state.selectedDirectory}>
              <EmptyState
                icon="folder-add-left"
                title="No project selected"
                action={chooseProject}
                actionLabel={language.t("command.project.open")}
              />
            </Match>
            <Match when={true}>
              <div class="flex flex-col gap-4">
                <section class="flex flex-col gap-3 border-b border-border-weak-base pb-4 md:flex-row md:items-end md:justify-between">
                  <div class="min-w-0">
                    <div class="text-12-medium text-text-weak">Current Project</div>
                    <div class="mt-1 truncate text-18-medium text-text-strong">
                      {compactPath(state.selectedDirectory, homedir())}
                    </div>
                  </div>
                  <div class="flex max-w-5xl flex-col gap-2">
                    <div class="grid gap-2 md:grid-cols-[minmax(220px,2fr)_minmax(130px,1fr)_minmax(120px,1fr)_90px_120px]">
                      <input
                        class="h-8 border border-border-weak-base bg-surface-base px-2 text-12-regular text-text-base"
                        value={state.datasetPath}
                        placeholder="CSV dataset path"
                        onInput={(event) => setState("datasetPath", event.currentTarget.value)}
                      />
                      <input
                        class="h-8 border border-border-weak-base bg-surface-base px-2 text-12-regular text-text-base"
                        value={state.datasetPreset}
                        placeholder="dataset preset"
                        onInput={(event) => setState("datasetPreset", event.currentTarget.value)}
                      />
                      <input
                        class="h-8 border border-border-weak-base bg-surface-base px-2 text-12-regular text-text-base"
                        value={state.targetCols}
                        placeholder="targets"
                        onInput={(event) => setState("targetCols", event.currentTarget.value)}
                      />
                      <input
                        class="h-8 border border-border-weak-base bg-surface-base px-2 text-12-regular text-text-base"
                        value={state.contextLength}
                        placeholder="context"
                        onInput={(event) => setState("contextLength", event.currentTarget.value)}
                      />
                      <input
                        class="h-8 border border-border-weak-base bg-surface-base px-2 text-12-regular text-text-base"
                        value={state.predictionLengths}
                        placeholder="horizons"
                        onInput={(event) => setState("predictionLengths", event.currentTarget.value)}
                      />
                    </div>
                    <div class="flex flex-wrap items-center justify-end gap-2">
                      <label class="flex h-8 items-center gap-2 text-12-regular text-text-weak">
                        <input
                          type="checkbox"
                          checked={state.fullRecipeSpace}
                          onChange={(event) => setState("fullRecipeSpace", event.currentTarget.checked)}
                        />
                        full recipe space
                      </label>
                    <Button
                      class="px-3"
                      onClick={() => createResearchTask("review")}
                      disabled={!!state.busy || !state.selectedDirectory}
                    >
                      New Review Task
                    </Button>
                    <Button
                      class="px-3"
                      onClick={() => createResearchTask("autonomous")}
                      disabled={!!state.busy || !state.selectedDirectory}
                    >
                      New Autonomous Task
                    </Button>
                    <Button
                      variant="ghost"
                      class="px-3"
                      onClick={() => openWorkspace(state.selectedDirectory)}
                      disabled={!state.selectedDirectory}
                    >
                      Open Workspace
                    </Button>
                    </div>
                  </div>
                </section>

                <Show when={state.error}>
                  <div class="border border-border-critical-base bg-surface-critical-weak px-3 py-2 text-12-regular text-text-on-critical-weak">
                    {state.error}
                  </div>
                </Show>
                <Show when={state.notice}>
                  <div class="border border-border-success-base bg-surface-success-weak px-3 py-2 text-12-regular text-text-on-success-weak">
                    {state.notice}
                  </div>
                </Show>

                <section class="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
                  <Stat label="Tasks" value={stats().totalTasks} />
                  <Stat label="Active" value={stats().activeTasks} />
                  <Stat label="Candidates" value={stats().candidateCount} />
                  <Stat label="Approvals" value={stats().pendingApprovals} />
                  <Stat label="Running" value={stats().runningRuns} />
                  <Stat label="Succeeded" value={stats().succeededRuns} />
                  <Stat label="Artifacts" value={stats().artifactCount} />
                  <Stat label="Memory" value={stats().memoryCount} />
                </section>

                <section class="grid gap-4 xl:grid-cols-[minmax(320px,0.92fr)_minmax(0,1.5fr)]">
                  <div class="min-w-0 border border-border-weak-base">
                    <div class="flex items-center justify-between border-b border-border-weak-base px-3 py-2">
                      <div class="text-12-medium text-text-weak">Research Tasks</div>
                      <Show when={tasks.loading}>
                        <div class="text-12-regular text-text-weak">{language.t("common.loading")}</div>
                      </Show>
                    </div>
                    <Switch>
                      <Match when={sortedTasks().length > 0}>
                        <div class="max-h-[520px] overflow-auto">
                          <For each={sortedTasks()}>
                            {(task) => (
                              <button
                                type="button"
                                class="flex w-full flex-col gap-2 border-b border-border-weak-base px-3 py-3 text-left hover:bg-surface-base"
                                classList={{
                                  "bg-surface-base": task.id === state.selectedTaskID,
                                }}
                                onClick={() => setState("selectedTaskID", task.id)}
                              >
                                <div class="flex w-full items-start justify-between gap-2">
                                  <div class="min-w-0">
                                    <div class="truncate text-14-medium text-text-strong">{task.title}</div>
                                    <div class="mt-1 text-12-regular text-text-weak">
                                      {task.domainID} / {task.mode} / {shortID(task.id)}
                                    </div>
                                  </div>
                                  <StatusPill value={task.status} />
                                </div>
                                <div class="text-12-regular text-text-weak">{relativeTime(task.time.updated)}</div>
                              </button>
                            )}
                          </For>
                        </div>
                      </Match>
                      <Match when={true}>
                        <div class="p-3">
                          <EmptyState title="No research tasks" />
                        </div>
                      </Match>
                    </Switch>
                  </div>

                  <div class="min-w-0 border border-border-weak-base">
                    <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border-weak-base px-3 py-2">
                      <div class="min-w-0">
                        <div class="truncate text-14-medium text-text-strong">
                          {selectedTask()?.title ?? "Task Detail"}
                        </div>
                        <div class="text-12-regular text-text-weak">
                          <Show when={selectedTask()} fallback="Select a task">
                            {(task) => (
                              <>
                                {task().mode} / {task().status} / {relativeTime(task().time.updated)}
                              </>
                            )}
                          </Show>
                        </div>
                      </div>
                      <div class="flex flex-wrap gap-2">
                        <Button class="px-3" onClick={seedBaselines} disabled={!!state.busy || !selectedTask()}>
                          Seed Baselines
                        </Button>
                        <Button class="px-3" onClick={profileTask} disabled={!!state.busy || !selectedTask()}>
                          Profile Task
                        </Button>
                        <Button
                          class="px-3"
                          onClick={runAutonomousIteration}
                          disabled={
                            !!state.busy || !selectedTask() || selectedTask()?.mode !== "autonomous" || !runnerReady()
                          }
                        >
                          Agent Iteration
                        </Button>
                        <Button
                          class="px-3"
                          onClick={runAutonomousLoop}
                          disabled={
                            !!state.busy || !selectedTask() || selectedTask()?.mode !== "autonomous" || !runnerReady()
                          }
                        >
                          Agent Loop
                        </Button>
                        <Button
                          icon="download"
                          variant="ghost"
                          class="px-3"
                          onClick={exportTaskArtifact}
                          disabled={!!state.busy || !selectedTask()}
                        >
                          Export Report
                        </Button>
                      </div>
                    </div>

                    <Switch>
                      <Match when={!selectedTask()}>
                        <div class="p-3">
                          <EmptyState title="Select a research task" />
                        </div>
                      </Match>
                      <Match when={true}>
                        <div class="flex flex-col gap-4 p-3">
                          <Show when={detailLoading()}>
                            <div class="text-12-regular text-text-weak">{language.t("common.loading")}</div>
                          </Show>

                          <section class="grid gap-2 md:grid-cols-3">
                            <div class="border border-border-weak-base bg-surface-base px-3 py-2">
                              <div class="text-12-medium text-text-weak">Champion</div>
                              <Show
                                when={champion()}
                                fallback={<div class="mt-2 text-14-regular text-text-weak">No champion</div>}
                              >
                                {(value) => (
                                  <div class="mt-2 flex flex-wrap items-center gap-2 text-14-regular">
                                    <span class="text-text-strong">{value().primaryMetric.toPrecision(4)}</span>
                                    <span class="text-text-weak">{shortID(value().candidateID)}</span>
                                    <span class="text-text-weak">{relativeTime(value().acceptedAt)}</span>
                                  </div>
                                )}
                              </Show>
                            </div>
                            <div class="border border-border-weak-base bg-surface-base px-3 py-2">
                              <div class="text-12-medium text-text-weak">Runner</div>
                              <div class="mt-2 flex items-center gap-2">
                                <StatusPill value={runnerReady() ? "ready" : "bridge_only"} />
                                <span class="text-12-regular text-text-weak">
                                  {runnerReady() ? "Neo-Cast execution enabled" : "Plan and review only"}
                                </span>
                              </div>
                            </div>
                            <div class="border border-border-weak-base bg-surface-base px-3 py-2">
                              <div class="text-12-medium text-text-weak">Fingerprint</div>
                              <div class="mt-2 truncate text-12-regular text-text-base">
                                {formatResearchFingerprint(taskFingerprint() ?? {})}
                              </div>
                            </div>
                          </section>

                          <section class="border border-border-weak-base bg-surface-base px-3 py-2">
                            <div class="text-12-medium text-text-weak">Profile</div>
                            <div class="mt-2 text-12-regular text-text-base">
                              {formatResearchProfileSummary(taskFingerprint() ?? {})}
                            </div>
                          </section>

                          <section class="min-w-0">
                            <div class="mb-2 text-12-medium text-text-weak">Candidates</div>
                            <div class="overflow-auto border border-border-weak-base">
                              <table class="w-full min-w-[980px] border-collapse text-left">
                                <thead class="bg-surface-base text-12-medium text-text-weak">
                                  <tr>
                                    <th class="border-b border-border-weak-base px-3 py-2">Recipe</th>
                                    <th class="border-b border-border-weak-base px-3 py-2">Pipeline</th>
                                    <th class="border-b border-border-weak-base px-3 py-2">Approval</th>
                                    <th class="border-b border-border-weak-base px-3 py-2">Risk</th>
                                    <th class="border-b border-border-weak-base px-3 py-2 text-right">Actions</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  <For
                                    each={candidates() ?? []}
                                    fallback={
                                      <tr>
                                        <td colspan="5" class="px-3 py-6 text-center text-12-regular text-text-weak">
                                          No candidates
                                        </td>
                                      </tr>
                                    }
                                  >
                                    {(candidate) => {
                                      const approved = () =>
                                        candidate.approvalStatus === "approved" ||
                                        candidate.approvalStatus === "auto_approved"
                                      const refGateApproved = () =>
                                        hasApprovedResearchRefTestGate(approvals() ?? [], candidate.id)
                                      const blindGateApproved = () =>
                                        hasApprovedResearchBlindTestGate(approvals() ?? [], candidate.id)
                                      const refGateRequested = () =>
                                        (approvals() ?? []).some(
                                          (approval) =>
                                            approval.candidateID === candidate.id &&
                                            approval.kind === "ref_test" &&
                                            approval.status !== "rejected",
                                        )
                                      const blindGateRequested = () =>
                                        (approvals() ?? []).some(
                                          (approval) =>
                                            approval.candidateID === candidate.id &&
                                            approval.kind === "blind_test" &&
                                            approval.status !== "rejected",
                                        )
                                      return (
                                        <tr>
                                          <td class="border-b border-border-weak-base px-3 py-2 align-top">
                                            <div class="text-14-medium text-text-strong">{recipeName(candidate)}</div>
                                            <div class="text-12-regular text-text-weak">{candidate.generatedBy}</div>
                                          </td>
                                          <td class="border-b border-border-weak-base px-3 py-2 align-top text-12-regular text-text-base">
                                            {recipePipeline(candidate) || "-"}
                                          </td>
                                          <td class="border-b border-border-weak-base px-3 py-2 align-top">
                                            <StatusPill value={candidate.approvalStatus} />
                                          </td>
                                          <td class="border-b border-border-weak-base px-3 py-2 align-top text-12-regular text-text-base">
                                            {candidate.riskLevel}
                                          </td>
                                          <td class="border-b border-border-weak-base px-3 py-2 align-top">
                                            <div class="flex flex-wrap justify-end gap-2">
                                              <Button
                                                size="small"
                                                class="px-2"
                                                onClick={() => prepareRun(candidate)}
                                                disabled={!!state.busy || !approved()}
                                              >
                                                Smoke Prep
                                              </Button>
                                              <Button
                                                size="small"
                                                class="px-2"
                                                onClick={() => executeRun(candidate)}
                                                disabled={!!state.busy || !approved() || !runnerReady()}
                                              >
                                                Smoke Exec
                                              </Button>
                                              <Button
                                                size="small"
                                                class="px-2"
                                                onClick={() => executeSeedSweep(candidate)}
                                                disabled={!!state.busy || !approved() || !runnerReady()}
                                              >
                                                Seed Sweep
                                              </Button>
                                              <Button
                                                size="small"
                                                variant="ghost"
                                                class="px-2"
                                                onClick={() => requestRefTestGate(candidate)}
                                                disabled={!!state.busy || !approved() || refGateRequested()}
                                              >
                                                Ref Gate
                                              </Button>
                                              <Button
                                                size="small"
                                                variant="ghost"
                                                class="px-2"
                                                onClick={() => prepareRun(candidate, "ref_test")}
                                                disabled={!!state.busy || !approved() || !refGateApproved()}
                                              >
                                                Ref Prep
                                              </Button>
                                              <Button
                                                size="small"
                                                variant="ghost"
                                                class="px-2"
                                                onClick={() => executeRun(candidate, "ref_test")}
                                                disabled={
                                                  !!state.busy || !approved() || !runnerReady() || !refGateApproved()
                                                }
                                              >
                                                Ref Exec
                                              </Button>
                                              <Button
                                                size="small"
                                                variant="ghost"
                                                class="px-2"
                                                onClick={() => requestBlindTestGate(candidate)}
                                                disabled={!!state.busy || !approved() || blindGateRequested()}
                                              >
                                                Blind Gate
                                              </Button>
                                              <Button
                                                size="small"
                                                variant="ghost"
                                                class="px-2"
                                                onClick={() => prepareRun(candidate, "blind_test")}
                                                disabled={!!state.busy || !approved() || !blindGateApproved()}
                                              >
                                                Blind Prep
                                              </Button>
                                              <Button
                                                size="small"
                                                variant="ghost"
                                                class="px-2"
                                                onClick={() => executeRun(candidate, "blind_test")}
                                                disabled={
                                                  !!state.busy || !approved() || !runnerReady() || !blindGateApproved()
                                                }
                                              >
                                                Blind Exec
                                              </Button>
                                            </div>
                                          </td>
                                        </tr>
                                      )
                                    }}
                                  </For>
                                </tbody>
                              </table>
                            </div>
                          </section>

                          <section class="grid gap-4 xl:grid-cols-3">
                            <div class="min-w-0">
                              <div class="mb-2 text-12-medium text-text-weak">Approvals</div>
                              <div class="flex flex-col border border-border-weak-base">
                                <For
                                  each={approvals() ?? []}
                                  fallback={
                                    <div class="px-3 py-6 text-center text-12-regular text-text-weak">No approvals</div>
                                  }
                                >
                                  {(approval) => (
                                    <div class="flex items-start justify-between gap-3 border-b border-border-weak-base px-3 py-2">
                                      <div class="min-w-0">
                                        <div class="flex flex-wrap items-center gap-2">
                                          <StatusPill value={approval.status} />
                                          <span class="text-12-regular text-text-weak">{approval.kind}</span>
                                          <span class="text-12-regular text-text-weak">{shortID(approval.id)}</span>
                                        </div>
                                        <div class="mt-2 line-clamp-2 text-12-regular text-text-base">
                                          {approval.reason}
                                        </div>
                                      </div>
                                      <Show when={approval.status === "pending"}>
                                        <div class="flex shrink-0 gap-2">
                                          <Button
                                            size="small"
                                            class="px-2"
                                            onClick={() => replyApproval(approval, "approved")}
                                            disabled={!!state.busy}
                                          >
                                            Approve
                                          </Button>
                                          <Button
                                            size="small"
                                            variant="ghost"
                                            class="px-2"
                                            onClick={() => replyApproval(approval, "rejected")}
                                            disabled={!!state.busy}
                                          >
                                            Reject
                                          </Button>
                                        </div>
                                      </Show>
                                    </div>
                                  )}
                                </For>
                              </div>
                            </div>

                            <div class="min-w-0">
                              <div class="mb-2 text-12-medium text-text-weak">Runs</div>
                              <div class="flex flex-col border border-border-weak-base">
                                <For
                                  each={runs() ?? []}
                                  fallback={
                                    <div class="px-3 py-6 text-center text-12-regular text-text-weak">No runs</div>
                                  }
                                >
                                  {(run) => (
                                    <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-border-weak-base px-3 py-2">
                                      <div class="min-w-0">
                                        <div class="flex flex-wrap items-center gap-2">
                                          <StatusPill value={run.status} />
                                          <span class="text-12-regular text-text-weak">{run.stage}</span>
                                          <span class="text-12-regular text-text-weak">{shortID(run.id)}</span>
                                        </div>
                                        <div class="mt-2 truncate text-12-regular text-text-base">
                                          {metricValue(run.metrics)}
                                        </div>
                                        <Show when={run.error}>
                                          <div class="mt-1 line-clamp-2 text-12-regular text-icon-critical-base">
                                            {run.error}
                                          </div>
                                        </Show>
                                      </div>
                                      <div class="text-right text-12-regular text-text-weak">
                                        {relativeTime(run.time.updated)}
                                      </div>
                                    </div>
                                  )}
                                </For>
                              </div>
                            </div>

                            <div class="min-w-0">
                              <div class="mb-2 text-12-medium text-text-weak">Artifacts</div>
                              <div class="flex flex-col border border-border-weak-base">
                                <For
                                  each={artifacts() ?? []}
                                  fallback={
                                    <div class="px-3 py-6 text-center text-12-regular text-text-weak">No artifacts</div>
                                  }
                                >
                                  {(artifact) => (
                                    <div class="border-b border-border-weak-base px-3 py-2">
                                      <div class="flex flex-wrap items-center gap-2">
                                        <span class="text-12-medium text-text-strong">{artifact.kind}</span>
                                        <span class="text-12-regular text-text-weak">{shortID(artifact.id)}</span>
                                        <Show when={artifact.runID}>
                                          {(runID) => (
                                            <span class="text-12-regular text-text-weak">{shortID(runID())}</span>
                                          )}
                                        </Show>
                                      </div>
                                      <div class="mt-2 truncate text-12-regular text-text-base">
                                        {formatResearchArtifactTarget(artifact)}
                                      </div>
                                      <Show when={formatResearchArtifactMetadataSummary(artifact)}>
                                        {(summary) => (
                                          <div class="mt-1 truncate text-12-regular text-text-weak">{summary()}</div>
                                        )}
                                      </Show>
                                    </div>
                                  )}
                                </For>
                              </div>
                            </div>
                          </section>

                          <section class="min-w-0">
                            <div class="mb-2 text-12-medium text-text-weak">Memory</div>
                            <div class="flex flex-col border border-border-weak-base">
                              <For
                                each={memory() ?? []}
                                fallback={
                                  <div class="px-3 py-6 text-center text-12-regular text-text-weak">No memory</div>
                                }
                              >
                                {(item) => (
                                  <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-border-weak-base px-3 py-2">
                                    <div class="min-w-0">
                                      <div class="flex flex-wrap items-center gap-2">
                                        <StatusPill value={item.outcome} />
                                        <span class="text-12-regular text-text-weak">{shortID(item.id)}</span>
                                        <span class="text-12-regular text-text-weak">{item.domainID}</span>
                                      </div>
                                      <div class="mt-2 line-clamp-2 text-12-regular text-text-base">
                                        {formatResearchMemorySummary(item)}
                                      </div>
                                      <div class="mt-1 truncate text-12-regular text-text-weak">
                                        {formatResearchMemoryFingerprint(item)}
                                      </div>
                                    </div>
                                    <div class="text-right text-12-regular text-text-weak">
                                      {relativeTime(item.time.updated)}
                                    </div>
                                  </div>
                                )}
                              </For>
                            </div>
                          </section>
                        </div>
                      </Match>
                    </Switch>
                  </div>
                </section>
              </div>
            </Match>
          </Switch>
        </main>
      </div>
    </div>
  )
}
