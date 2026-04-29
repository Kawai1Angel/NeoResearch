import { TextAttributes } from "@opentui/core"
import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useEvent } from "@tui/context/event"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useToast } from "@tui/ui/toast"
import { Locale } from "@/util"
import {
  buildDefaultTsfResearchTask,
  buildResearchCockpitStats,
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

export function ResearchCockpit() {
  const sdk = useSDK()
  const event = useEvent()
  const command = useCommandDialog()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const [refresh, setRefresh] = createSignal(0)
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [busy, setBusy] = createSignal<string>()
  const [error, setError] = createSignal<string>()

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
  const statusColor = (status: string) => {
    if (["completed", "succeeded", "approved", "auto_approved", "accepted", "ready"].includes(status))
      return theme.success
    if (["failed", "rejected"].includes(status)) return theme.error
    if (["researching", "running", "queued", "baselining", "profiling", "pending"].includes(status))
      return theme.warning
    return theme.textMuted
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

  async function createCsvTask(mode: ResearchCockpitTask["mode"]) {
    const value = await DialogPrompt.show(dialog, "CSV dataset path", {
      placeholder: "/path/to/ETTh1.csv",
      description: () => <text fg={theme.textMuted}>Preset etth1_tslib_v1, target OT, horizon 24.</text>,
    })
    const datasetPath = value?.trim()
    if (!datasetPath) return
    await createTask(mode, { datasetPath, datasetPreset: "etth1_tslib_v1", targetCols: ["OT"] })
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

  async function runAutonomousIteration() {
    const task = selectedTask()
    if (!task || task.mode !== "autonomous" || !runnerReady()) return
    await runAction("autonomous-iteration", async () => {
      const result = await researchRequest<ResearchCockpitIterationResult>(
        sdk,
        `/research/tasks/${encodeURIComponent(task.id)}/autonomous/iterate`,
        {
          method: "POST",
          body: JSON.stringify({ stage: "smoke", description: "cockpit autonomous iteration" }),
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

  command.register(() => [
    {
      title: "Create TSF review task",
      value: "research.create.review",
      category: "Research",
      onSelect: () => void createTask("review"),
    },
    {
      title: "Create TSF review task from CSV",
      value: "research.create.review.csv",
      category: "Research",
      onSelect: () => void createCsvTask("review"),
    },
    {
      title: "Create TSF autonomous task",
      value: "research.create.autonomous",
      category: "Research",
      onSelect: () => void createTask("autonomous"),
    },
    {
      title: "Create TSF autonomous task from CSV",
      value: "research.create.autonomous.csv",
      category: "Research",
      onSelect: () => void createCsvTask("autonomous"),
    },
    {
      title: "Seed TSF baselines",
      value: "research.seed.baselines",
      category: "Research",
      enabled: !!selectedTask(),
      onSelect: () => void seedBaselines(),
    },
    {
      title: "Profile research task",
      value: "research.profile.task",
      category: "Research",
      enabled: !!selectedTask(),
      onSelect: () => void profileTask(),
    },
    {
      title: "Approve pending research candidate",
      value: "research.approve.pending",
      category: "Research",
      enabled: !!pendingApproval(),
      onSelect: () => void approvePending(),
    },
    {
      title: "Run autonomous research iteration",
      value: "research.autonomous.iterate",
      category: "Research",
      enabled: selectedTask()?.mode === "autonomous" && runnerReady(),
      onSelect: () => void runAutonomousIteration(),
    },
    {
      title: "Run autonomous research loop",
      value: "research.autonomous.loop",
      category: "Research",
      enabled: selectedTask()?.mode === "autonomous" && runnerReady(),
      onSelect: () => void runAutonomousLoop(),
    },
    {
      title: "Export research report",
      value: "research.export.report",
      category: "Research",
      enabled: !!selectedTask(),
      onSelect: () => void exportTaskArtifact(),
    },
  ])

  return (
    <box flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <box>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            NeoResearch Cockpit
          </text>
          <text fg={theme.textMuted}>{sdk.directory ?? process.cwd()}</text>
        </box>
        <box flexDirection="row" gap={2}>
          <text fg={busy() ? theme.textMuted : theme.primary} onMouseUp={() => void createTask("review")}>
            New Review Task
          </text>
          <text fg={busy() ? theme.textMuted : theme.primary} onMouseUp={() => void createTask("autonomous")}>
            New Autonomous Task
          </text>
          <text fg={busy() ? theme.textMuted : theme.primary} onMouseUp={() => void createCsvTask("review")}>
            New CSV Task
          </text>
        </box>
      </box>

      <box
        flexDirection="row"
        gap={2}
        border={["top", "bottom"]}
        borderColor={theme.border}
        paddingTop={1}
        paddingBottom={1}
      >
        <text fg={theme.text}>Tasks {stats().taskTotal}</text>
        <text fg={theme.text}>Active {stats().activeTasks}</text>
        <text fg={theme.text}>Candidates {stats().candidateCount}</text>
        <text fg={theme.text}>Artifacts {stats().artifactCount}</text>
        <text fg={theme.text}>Memory {stats().memoryCount}</text>
        <text fg={theme.text}>Approvals {stats().pendingApprovals}</text>
        <text fg={theme.text}>Running {stats().queuedOrRunningRuns}</text>
        <text fg={theme.text}>Succeeded {stats().succeededRuns}</text>
      </box>

      <Show when={error()}>{(message) => <text fg={theme.error}>{message()}</text>}</Show>

      <box flexDirection="row" gap={2} flexGrow={1} minHeight={0}>
        <box width={46} flexShrink={0} border={["right"]} borderColor={theme.border} paddingRight={1} gap={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.textMuted}>Research Tasks</text>
            <Show when={tasks.loading}>
              <text fg={theme.textMuted}>Loading</text>
            </Show>
          </box>
          <Switch>
            <Match when={sortedTasks().length > 0}>
              <For each={sortedTasks().slice(0, 14)}>
                {(task, index) => {
                  const selected = createMemo(() => index() === selectedIndex())
                  return (
                    <box
                      paddingLeft={1}
                      paddingRight={1}
                      paddingTop={0}
                      paddingBottom={0}
                      backgroundColor={selected() ? theme.backgroundPanel : undefined}
                      onMouseUp={() => setSelectedIndex(index())}
                    >
                      <box flexDirection="row" justifyContent="space-between">
                        <text
                          fg={selected() ? theme.text : theme.text}
                          attributes={selected() ? TextAttributes.BOLD : undefined}
                        >
                          {task.title}
                        </text>
                        <text fg={statusColor(task.status)}>{task.status}</text>
                      </box>
                      <text fg={theme.textMuted}>
                        {task.domainID} / {task.mode} / {Locale.todayTimeOrDateTime(task.time.updated)}
                      </text>
                    </box>
                  )
                }}
              </For>
            </Match>
            <Match when={true}>
              <box paddingTop={2}>
                <text fg={theme.textMuted}>No research tasks</text>
              </box>
            </Match>
          </Switch>
        </box>

        <box flexGrow={1} minWidth={0} gap={1}>
          <Switch>
            <Match when={selectedTask()}>
              {(task) => (
                <>
                  <box flexDirection="row" justifyContent="space-between">
                    <box>
                      <text fg={theme.text} attributes={TextAttributes.BOLD}>
                        {task().title}
                      </text>
                      <text fg={theme.textMuted}>
                        {task().mode} / {task().status} / {shortID(task().id)}
                      </text>
                    </box>
                    <box flexDirection="row" gap={2}>
                      <text fg={busy() ? theme.textMuted : theme.primary} onMouseUp={() => void seedBaselines()}>
                        Seed Baselines
                      </text>
                      <text
                        fg={
                          selectedTask()?.mode !== "autonomous" || !runnerReady() || busy()
                            ? theme.textMuted
                            : theme.primary
                        }
                        onMouseUp={() => void runAutonomousIteration()}
                      >
                        Agent Iteration
                      </text>
                      <text
                        fg={
                          selectedTask()?.mode !== "autonomous" || !runnerReady() || busy()
                            ? theme.textMuted
                            : theme.primary
                        }
                        onMouseUp={() => void runAutonomousLoop()}
                      >
                        Agent Loop
                      </text>
                      <text
                        fg={!pendingApproval() || busy() ? theme.textMuted : theme.primary}
                        onMouseUp={() => void approvePending()}
                      >
                        Approve Pending
                      </text>
                      <text
                        fg={!selectedTask() || busy() ? theme.textMuted : theme.primary}
                        onMouseUp={() => void profileTask()}
                      >
                        Profile Task
                      </text>
                      <text
                        fg={!selectedTask() || busy() ? theme.textMuted : theme.primary}
                        onMouseUp={() => void exportTaskArtifact()}
                      >
                        Export Report
                      </text>
                    </box>
                  </box>

                  <box flexDirection="row" gap={2}>
                    <box flexGrow={1} backgroundColor={theme.backgroundPanel} paddingLeft={1} paddingRight={1}>
                      <text fg={theme.textMuted}>Champion</text>
                      <Show when={champion()} fallback={<text fg={theme.textMuted}>No champion</text>}>
                        {(value) => (
                          <text fg={theme.text}>
                            {value().primaryMetric.toPrecision(4)} / {shortID(value().candidateID)}
                          </text>
                        )}
                      </Show>
                    </box>
                    <box flexGrow={1} backgroundColor={theme.backgroundPanel} paddingLeft={1} paddingRight={1}>
                      <text fg={theme.textMuted}>Latest Run</text>
                      <Show when={(runs() ?? [])[0]} fallback={<text fg={theme.textMuted}>No runs</text>}>
                        {(run) => (
                          <text fg={statusColor(run().status)}>
                            {run().status} / {metricText(run().metrics)}
                          </text>
                        )}
                      </Show>
                    </box>
                    <box flexGrow={1} backgroundColor={theme.backgroundPanel} paddingLeft={1} paddingRight={1}>
                      <text fg={theme.textMuted}>Runner</text>
                      <text fg={runnerReady() ? theme.success : theme.textMuted}>
                        {runnerReady() ? "ready" : "bridge_only"}
                      </text>
                    </box>
                    <box flexGrow={1} backgroundColor={theme.backgroundPanel} paddingLeft={1} paddingRight={1}>
                      <text fg={theme.textMuted}>Fingerprint</text>
                      <text fg={theme.text} wrapMode="none">
                        {formatResearchCockpitFingerprint(taskFingerprint() ?? {})}
                      </text>
                    </box>
                  </box>

                  <box backgroundColor={theme.backgroundPanel} paddingLeft={1} paddingRight={1}>
                    <text fg={theme.textMuted}>Profile</text>
                    <text fg={theme.text}>
                      {formatResearchCockpitProfile(taskFingerprint() ?? {})}
                    </text>
                  </box>

                  <box gap={1}>
                    <text fg={theme.textMuted}>Candidates</text>
                    <For
                      each={(candidates() ?? []).slice(0, 8)}
                      fallback={<text fg={theme.textMuted}>No candidates</text>}
                    >
                      {(candidate) => {
                        const runnable = createMemo(() => canRunResearchCockpitCandidate(candidate))
                        const refGateApproved = createMemo(() =>
                          hasApprovedResearchCockpitRefTestGate(approvals() ?? [], candidate.id),
                        )
                        const blindGateApproved = createMemo(() =>
                          hasApprovedResearchCockpitBlindTestGate(approvals() ?? [], candidate.id),
                        )
                        const refGateRequested = createMemo(() =>
                          (approvals() ?? []).some(
                            (approval) =>
                              approval.candidateID === candidate.id &&
                              approval.kind === "ref_test" &&
                              approval.status !== "rejected",
                          ),
                        )
                        const blindGateRequested = createMemo(() =>
                          (approvals() ?? []).some(
                            (approval) =>
                              approval.candidateID === candidate.id &&
                              approval.kind === "blind_test" &&
                              approval.status !== "rejected",
                          ),
                        )
                        const pipeline = createMemo(
                          () => researchCockpitCandidatePipeline(candidate) || candidate.rationale,
                        )
                        return (
                          <box backgroundColor={theme.backgroundPanel} paddingLeft={1} paddingRight={1}>
                            <box gap={0} minWidth={0}>
                              <box flexDirection="row" gap={1} minWidth={0}>
                                <text fg={statusColor(candidate.approvalStatus)} wrapMode="none">
                                  {candidate.approvalStatus}
                                </text>
                                <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
                                  {researchCockpitCandidateTitle(candidate)}
                                </text>
                                <text fg={theme.textMuted} wrapMode="none">
                                  {candidate.riskLevel}
                                </text>
                              </box>
                              <text fg={theme.textMuted} wrapMode="none">
                                {pipeline()}
                              </text>
                              <box flexDirection="row" gap={1} minWidth={0}>
                                <text
                                  fg={!runnable() || busy() ? theme.textMuted : theme.primary}
                                  wrapMode="none"
                                  onMouseUp={() => {
                                    if (!runnable() || busy()) return
                                    void prepareCandidate(candidate)
                                  }}
                                >
                                  Smoke Prep
                                </text>
                                <text
                                  fg={!runnable() || !runnerReady() || busy() ? theme.textMuted : theme.primary}
                                  wrapMode="none"
                                  onMouseUp={() => {
                                    if (!runnable() || !runnerReady() || busy()) return
                                    void executeCandidate(candidate)
                                  }}
                                >
                                  Smoke Exec
                                </text>
                                <text
                                  fg={!runnable() || refGateRequested() || busy() ? theme.textMuted : theme.primary}
                                  wrapMode="none"
                                  onMouseUp={() => {
                                    if (!runnable() || refGateRequested() || busy()) return
                                    void requestRefTestGate(candidate)
                                  }}
                                >
                                  Ref Gate
                                </text>
                                <text
                                  fg={!runnable() || !runnerReady() || busy() ? theme.textMuted : theme.primary}
                                  wrapMode="none"
                                  onMouseUp={() => {
                                    if (!runnable() || !runnerReady() || busy()) return
                                    void executeCandidateSeedSweep(candidate)
                                  }}
                                >
                                  Seed Sweep
                                </text>
                              </box>
                              <box flexDirection="row" gap={1} minWidth={0}>
                                <text
                                  fg={!runnable() || !refGateApproved() || busy() ? theme.textMuted : theme.primary}
                                  wrapMode="none"
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
                                      ? theme.textMuted
                                      : theme.primary
                                  }
                                  wrapMode="none"
                                  onMouseUp={() => {
                                    if (!runnable() || !refGateApproved() || !runnerReady() || busy()) return
                                    void executeCandidate(candidate, "ref_test")
                                  }}
                                >
                                  Ref Exec
                                </text>
                              </box>
                              <box flexDirection="row" gap={1} minWidth={0}>
                                <text
                                  fg={!runnable() || blindGateRequested() || busy() ? theme.textMuted : theme.primary}
                                  wrapMode="none"
                                  onMouseUp={() => {
                                    if (!runnable() || blindGateRequested() || busy()) return
                                    void requestBlindTestGate(candidate)
                                  }}
                                >
                                  Blind Gate
                                </text>
                                <text
                                  fg={!runnable() || !blindGateApproved() || busy() ? theme.textMuted : theme.primary}
                                  wrapMode="none"
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
                                      ? theme.textMuted
                                      : theme.primary
                                  }
                                  wrapMode="none"
                                  onMouseUp={() => {
                                    if (!runnable() || !blindGateApproved() || !runnerReady() || busy()) return
                                    void executeCandidate(candidate, "blind_test")
                                  }}
                                >
                                  Blind Exec
                                </text>
                              </box>
                            </box>
                          </box>
                        )
                      }}
                    </For>
                  </box>

                  <box gap={1}>
                    <text fg={theme.textMuted}>Artifacts</text>
                    <For
                      each={(artifacts() ?? []).slice(0, 6)}
                      fallback={<text fg={theme.textMuted}>No artifacts</text>}
                    >
                      {(artifact) => (
                        <box backgroundColor={theme.backgroundPanel} paddingLeft={1} paddingRight={1}>
                          <box flexDirection="row" gap={1}>
                            <text fg={theme.text} attributes={TextAttributes.BOLD}>
                              {artifact.kind}
                            </text>
                            <text fg={theme.textMuted}>{shortID(artifact.id)}</text>
                            <Show when={artifact.runID}>
                              {(runID) => <text fg={theme.textMuted}>{shortID(runID())}</text>}
                            </Show>
                          </box>
                          <text fg={theme.textMuted} wrapMode="none">
                            {researchCockpitArtifactTarget(artifact)}
                          </text>
                          <Show when={formatResearchCockpitArtifactMetadata(artifact)}>
                            {(summary) => (
                              <text fg={theme.textMuted} wrapMode="none">
                                {summary()}
                              </text>
                            )}
                          </Show>
                        </box>
                      )}
                    </For>
                  </box>

                  <box gap={1}>
                    <text fg={theme.textMuted}>Memory</text>
                    <For each={(memory() ?? []).slice(0, 6)} fallback={<text fg={theme.textMuted}>No memory</text>}>
                      {(item) => (
                        <box backgroundColor={theme.backgroundPanel} paddingLeft={1} paddingRight={1}>
                          <box flexDirection="row" gap={1}>
                            <text fg={statusColor(item.outcome)}>{item.outcome}</text>
                            <text fg={theme.textMuted}>{shortID(item.id)}</text>
                            <text fg={theme.textMuted}>{item.domainID}</text>
                          </box>
                          <text fg={theme.text} wrapMode="none">
                            {formatResearchCockpitMemory(item)}
                          </text>
                          <text fg={theme.textMuted} wrapMode="none">
                            {formatResearchCockpitMemoryFingerprint(item)}
                          </text>
                        </box>
                      )}
                    </For>
                  </box>

                  <box flexDirection="row" gap={2} minHeight={0} flexGrow={1}>
                    <box flexGrow={1} gap={1} minWidth={0}>
                      <text fg={theme.textMuted}>Approvals</text>
                      <For
                        each={(approvals() ?? []).slice(0, 8)}
                        fallback={<text fg={theme.textMuted}>No approvals</text>}
                      >
                        {(approval) => (
                          <box>
                            <box flexDirection="row" gap={1}>
                              <text fg={statusColor(approval.status)}>{approval.status}</text>
                              <text fg={theme.textMuted}>{approval.kind}</text>
                              <text fg={theme.textMuted}>{shortID(approval.candidateID)}</text>
                            </box>
                            <text fg={theme.text} wrapMode="none">
                              {approval.reason}
                            </text>
                          </box>
                        )}
                      </For>
                    </box>

                    <box flexGrow={1} gap={1} minWidth={0}>
                      <text fg={theme.textMuted}>Runs</text>
                      <For each={(runs() ?? []).slice(0, 8)} fallback={<text fg={theme.textMuted}>No runs</text>}>
                        {(run) => (
                          <box>
                            <box flexDirection="row" gap={1}>
                              <text fg={statusColor(run.status)}>{run.status}</text>
                              <text fg={theme.textMuted}>{shortID(run.id)}</text>
                            </box>
                            <text fg={theme.text} wrapMode="none">
                              {metricText(run.metrics)} / {Locale.todayTimeOrDateTime(run.time.updated)}
                            </text>
                          </box>
                        )}
                      </For>
                    </box>
                  </box>
                </>
              )}
            </Match>
            <Match when={true}>
              <box flexGrow={1} alignItems="center" justifyContent="center">
                <text fg={theme.textMuted}>Select or create a research task</text>
              </box>
            </Match>
          </Switch>
        </box>
      </box>
    </box>
  )
}
