import { TextareaRenderable, TextAttributes, type KeyEvent } from "@opentui/core"
import { Global } from "@opencode-ai/core/global"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { useCommandDialog } from "@tui/component/dialog-command"
import { Spinner } from "@tui/component/spinner"
import { useTextareaKeybindings } from "@tui/component/textarea-keybindings"
import { useEvent } from "@tui/context/event"
import { useLocal } from "@tui/context/local"
import { useRoute } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useToast } from "@tui/ui/toast"
import {
  buildDefaultTsfResearchTask,
  buildDefaultTsfResearchTaskFromGoal,
  buildSocraticClarificationState,
  buildResearchCockpitAgentWorkflow,
  buildResearchCockpitRecommendation,
  canExecuteResearchCockpitTask,
  canRunResearchCockpitCandidate,
  findBestResearchCockpitMetric,
  formatResearchCockpitExport,
  formatResearchCockpitProfile,
  formatResearchCockpitIteration,
  formatResearchCockpitLoop,
  formatResearchCockpitRunResult,
  formatResearchCockpitSeedSweep,
  formatResearchCockpitIntentCheckpointReason,
  getResearchCockpitRunnerStatus,
  hasApprovedResearchCockpitBlindTestGate,
  hasApprovedResearchCockpitRefTestGate,
  hasIntentConfirmation,
  interactionModeForTask,
  parseTsfCsvTaskInput,
  slotFromSocraticQuestion,
  validateTsfCsvTaskInput,
  researchInteractionModeLabel,
  researchCockpitCandidateTitle,
  resolveResearchCockpitProjectRunnerRoot,
  selectNextBestAction,
  shouldRefreshResearchCockpitOnEvent,
  sortResearchCockpitTasks,
  taskModeForInteractionMode,
  updateResearchCockpitTaskInteractionMode,
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
  type ResearchInteractionMode,
  type ResearchCockpitProfileResult,
  type ResearchCockpitRun,
  type ResearchCockpitRunnerStatus,
  type ResearchCockpitSeedSweepResult,
  type ResearchCockpitTask,
  type ResearchCockpitWorkflowItem,
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
import packageJson from "../../../../../package.json"

type CandidateRunStage = Extract<NonNullable<ResearchCockpitRun["stage"]>, "smoke" | "full" | "ref_test" | "blind_test">
type ResearchAgentStageStatus = "done" | "active" | "todo"
type ResearchAgentStage = {
  key: string
  label: string
  displayLabel?: string
  status: ResearchAgentStageStatus
}
type ResearchCockpitDatasetPreparationResult = {
  artifact: ResearchCockpitArtifact
  path: string
  datasetSpec: JsonRecord
  command: JsonRecord
}

const chatRequestTimeoutMs = 90_000
const researchAgentWorkflowOrder = [
  "HypoPlanner Agent",
  "ModelDesigner Agent",
  "ModelCompiler Agent",
  "TrainEval Agent",
  "Reflection Agent",
]

async function researchRequest<T>(
  sdk: ReturnType<typeof useSDK>,
  path: string,
  init: RequestInit = {},
  timeoutMs = 90_000,
): Promise<T> {
  const url = new URL(path, sdk.url)
  if (sdk.directory) url.searchParams.set("directory", sdk.directory)

  const headers = new Headers(init.headers)
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal =
    init.signal && !init.signal.aborted
      ? (AbortSignal as unknown as { any: (signals: AbortSignal[]) => AbortSignal }).any?.([
          init.signal,
          timeoutSignal,
        ]) ?? timeoutSignal
      : timeoutSignal

  let response: Response
  try {
    response = await sdk.fetch(url, { ...init, headers, signal })
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s (${path})`)
    }
    throw err
  }
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `${response.status} ${response.statusText}`)
  }
  return (await response.json()) as T
}

async function researchRequestNoContent(
  sdk: ReturnType<typeof useSDK>,
  path: string,
  init: RequestInit = {},
  timeoutMs = 90_000,
) {
  const url = new URL(path, sdk.url)
  if (sdk.directory) url.searchParams.set("directory", sdk.directory)

  const headers = new Headers(init.headers)
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal =
    init.signal && !init.signal.aborted
      ? (AbortSignal as unknown as { any: (signals: AbortSignal[]) => AbortSignal }).any?.([
          init.signal,
          timeoutSignal,
        ]) ?? timeoutSignal
      : timeoutSignal

  let response: Response
  try {
    response = await sdk.fetch(url, { ...init, headers, signal })
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s (${path})`)
    }
    throw err
  }
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `${response.status} ${response.statusText}`)
  }
}

function shortID(value: string | undefined) {
  if (!value) return "-"
  return value.slice(0, 8)
}

function formatError(error: unknown) {
  const text = normalizeErrorMessage(error instanceof Error ? error.message : String(error))
  return text.length > 180 ? text.slice(0, 177) + "..." : text
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeErrorMessage(value: string) {
  const parsed = parseErrorPayload(value)
  const text = parsed ?? value
  const decoded = text.includes("\\n") && !text.includes("\n") ? text.replace(/\\n/g, "\n") : text
  const lines = decoded
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const tracebackLine = lines.findIndex((line) => line.includes("Traceback (most recent call last)"))
  if (tracebackLine !== -1) {
    const actionable = [...lines]
      .reverse()
      .find(
        (line) =>
          !line.includes("Traceback (most recent call last)") &&
          !line.startsWith("File ") &&
          !line.startsWith("at ") &&
          line !== "main()",
      )
    if (actionable) return actionable.replace(/^Error:\s+/, "").replace(/\s+/g, " ").trim()
  }
  return decoded.replace(/^Error:\s+/, "").replace(/\s+/g, " ").trim()
}

function parseErrorPayload(value: string): string | undefined {
  try {
    const payload = JSON.parse(value) as unknown
    if (!isJsonRecord(payload)) return undefined
    const data = payload.data
    if (isJsonRecord(data) && typeof data.message === "string" && data.message.trim()) return data.message
    if (typeof payload.message === "string" && payload.message.trim()) return payload.message
    if (isJsonRecord(data) && typeof data.error === "string" && data.error.trim()) return data.error
    if (typeof payload.error === "string" && payload.error.trim()) return payload.error
    if (typeof payload.name === "string" && payload.name.trim() && payload.name !== "UnknownError") return payload.name
  } catch {
    return undefined
  }
  return undefined
}

const workingBarFrames = [
  "[>       ]",
  "[=>      ]",
  "[==>     ]",
  "[===>    ]",
  "[ ===>   ]",
  "[  ===>  ]",
  "[   ===> ]",
  "[    ===>]",
]

function formatBusyElapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes === 0) return `${rest}s`
  return `${minutes}:${String(rest).padStart(2, "0")}`
}

function workingActionLabel(action: string) {
  if (action.startsWith("chat:")) return `chat ${action.slice("chat:".length)}`
  return action
}

function workingActionText(action: string, elapsed: string, tick: number) {
  const frame = workingBarFrames[tick % workingBarFrames.length]
  return `Working / ${workingActionLabel(action)} / ${elapsed} ${frame}`
}

function liveResearchStageForAction(action: string | undefined, hasLiveRunnerOutput: boolean) {
  if (!action) return undefined
  if (action === "confirm-intent") return "intent"
  if (action === "profile-task" || action === "prepare-dataset") return "data"
  if (action === "seed-baselines") return "ModelDesigner Agent"
  if (action === "autonomous-loop" || action === "autonomous-iteration") {
    return hasLiveRunnerOutput ? "TrainEval Agent" : "ModelDesigner Agent"
  }
  if (action.startsWith("prepare-")) return "ModelCompiler Agent"
  if (action.startsWith("execute-") || action.startsWith("seed-sweep-")) return "TrainEval Agent"
  if (action === "export-artifact") return "publish"
  return undefined
}

function overlayLiveResearchWorkflow(
  items: ResearchCockpitWorkflowItem[],
  activeLabel: string | undefined,
): ResearchCockpitWorkflowItem[] {
  const activeIndex = activeLabel ? researchAgentWorkflowOrder.indexOf(activeLabel) : -1
  if (activeIndex < 0) return items
  return items.map((item) => {
    const itemIndex = researchAgentWorkflowOrder.indexOf(item.label)
    if (itemIndex < 0) return item
    if (itemIndex === activeIndex) return { ...item, status: "active" }
    if (itemIndex > activeIndex) return { ...item, status: "todo" }
    return item.status === "done" ? item : { ...item, status: "done" }
  })
}

function localResearchChatReply(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[!！.。?？\s]+$/g, "")
  const greetings = new Set(["hi", "hello", "hey", "你好", "您好", "嗨", "哈喽", "在吗"])
  if (!greetings.has(normalized)) return undefined
  return "你好，我在。可以直接告诉我研究目标、CSV 数据路径，或让我解释当前任务状态。"
}

function socraticSlotLine(slot: ReturnType<typeof buildSocraticClarificationState>["slots"][number]) {
  const mark = slot.status === "filled" ? "✓" : "→"
  return `${mark} ${slot.label}${slot.value ? `: ${slot.value}` : ""}`
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

function parseRunnerProgressRecord(line: string) {
  try {
    const parsed = JSON.parse(line)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonRecord) : {}
  } catch {
    return {}
  }
}

function progressRecordString(record: JsonRecord, key: string) {
  const value = record[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function progressRecordNumber(record: JsonRecord, key: string) {
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function formatRunnerProgressLine(data: RunnerProgressLineEvent) {
  if (data.event === "epoch_end") {
    return `epoch ${data.epoch ?? "?"} | h${data.horizon ?? "?"} | val_loss ${data.valLoss?.toFixed(4) ?? "?"}`
  }
  if (data.event === "timeout") {
    return `timeout after ${data.elapsedS === undefined ? "?" : Math.round(data.elapsedS)}s`
  }

  const record = parseRunnerProgressRecord(data.line)
  if (data.event === "stage_start") {
    const stage = progressRecordString(record, "stage") ?? "?"
    const candidate = progressRecordString(record, "candidate_id")
    return candidate ? `stage ${stage} | candidate ${candidate}` : `stage ${stage}`
  }
  if (data.event === "smoke_eval_done") {
    const mse = progressRecordNumber(record, "val_avg_mse")
    return mse === undefined ? "smoke_eval_done" : `smoke_eval_done | val_avg_mse ${mse.toFixed(4)}`
  }
  if (data.event === "artifact_ready") {
    const runID = progressRecordString(record, "run_id")
    return runID ? `artifact_ready | run ${runID}` : "artifact_ready"
  }
  return data.line
}

function isRunRecommendedPrompt(value: string) {
  const normalized = value.trim().toLowerCase()
  const compact = normalized.replace(/\s+/g, "")
  if (
    [
      "开始",
      "开始预测",
      "开始运行",
      "开始实验",
      "继续",
      "执行",
      "执行下一步",
      "运行",
      "下一步",
      "start",
      "run",
      "continue",
      "execute",
      "next",
      "go",
    ].includes(compact)
  ) {
    return true
  }
  return /^(run|start|continue|execute|next)\b/.test(normalized)
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
const runnerOutputBufferSize = 30
const neoResearchVersion = InstallationVersion === "local" ? packageJson.version : InstallationVersion
const researchCockpitOnboardingFile = path.join(Global.Path.data, "onboarded.json")
const researchCockpitOnboardingText = [
  "欢迎来到 NeoResearch。",
  "本系统主要通过对话使用，直接告诉我你想做什么即可。",
  "常用斜杠命令：/new csv、/dataset prepare、/loop start、/help。",
  "核心快捷键：Enter、Esc、Ctrl+J/K、Ctrl+L、Ctrl+C。",
].join("\n")
const interactionModeOptions: Array<{
  key: string
  title: string
  value: ResearchInteractionMode
  description: string
}> = [
  {
    key: "1",
    title: "Companion",
    value: "companion",
    description: "Key checkpoints ask for human confirmation and choice.",
  },
  {
    key: "2",
    title: "Socratic",
    value: "socratic",
    description: "Clarify goals first, then run with minimal interruption.",
  },
]

type StreamLine = {
  id: string
  text: string
  tone?: "text" | "muted" | "primary" | "success" | "warning" | "error"
  spinner?: boolean
}

type RunnerProgressLineEvent = {
  taskID?: string
  runID: string
  line: string
  event?: string
  epoch?: number
  horizon?: number
  valLoss?: number
  elapsedS?: number
}

type StreamingChatTextPart = {
  id: string
  text: string
}

type StreamingChatTurn = {
  id: number
  sessionID: string
  messageID?: string
  partID?: string
  text: string
  parts: StreamingChatTextPart[]
  modelLabel?: string
}

type AgentActionProposal = {
  title: string
  command: string
  reason: string
  reversible: boolean
  requireConfirm: boolean
}

type ChatProviderList = {
  providers: Array<{
    id: string
    name?: string
    models?: Record<string, { id?: string; name?: string; limit?: { context?: number } }>
  }>
  default: Record<string, string>
}

type ChatAgent = {
  name: string
  mode?: string
  hidden?: boolean
}

type ChatModelSelection = {
  providerID: string
  modelID: string
}

type ResolvedChatDefaults = {
  agent: string
  model: ChatModelSelection
  modelLabel: string
  modelLimit?: number
  providerLabel?: string
}

type ChatUsageEntry = {
  messageID: string
  providerID?: string
  modelID?: string
  total: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  time: number
}

function useOptionalLocal() {
  try {
    return useLocal()
  } catch {
    return undefined
  }
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function formatTokenNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(Math.round(value))
}

function formatDollar(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value)
}

function chatUsageEntryFromInfo(info: unknown): ChatUsageEntry | undefined {
  if (!info || typeof info !== "object") return
  const candidate = info as {
    id?: unknown
    role?: unknown
    providerID?: unknown
    modelID?: unknown
    cost?: unknown
    tokens?: {
      total?: unknown
      input?: unknown
      output?: unknown
      reasoning?: unknown
      cache?: { read?: unknown; write?: unknown }
    }
    time?: { completed?: unknown; created?: unknown }
  }
  if (candidate.role !== "assistant" || typeof candidate.id !== "string") return
  const input = finiteNumber(candidate.tokens?.input)
  const output = finiteNumber(candidate.tokens?.output)
  const reasoning = finiteNumber(candidate.tokens?.reasoning)
  const cacheRead = finiteNumber(candidate.tokens?.cache?.read)
  const cacheWrite = finiteNumber(candidate.tokens?.cache?.write)
  const fallbackTotal = input + output + reasoning + cacheRead + cacheWrite
  const total = finiteNumber(candidate.tokens?.total) || fallbackTotal
  if (total <= 0 && fallbackTotal <= 0) return
  return {
    messageID: candidate.id,
    providerID: typeof candidate.providerID === "string" ? candidate.providerID : undefined,
    modelID: typeof candidate.modelID === "string" ? candidate.modelID : undefined,
    total,
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    cost: finiteNumber(candidate.cost),
    time: finiteNumber(candidate.time?.completed) || finiteNumber(candidate.time?.created),
  }
}

export function resolveResearchCockpitChatDefaults(input: {
  providersResult: ChatProviderList
  agentsResult: ChatAgent[]
  selectedModel?: ChatModelSelection
  selectedAgentName?: string
}) {
  const { providersResult, agentsResult, selectedModel, selectedAgentName } = input
  if (!Array.isArray(providersResult.providers)) {
    throw new Error("AI provider list is unavailable.")
  }
  if (!Array.isArray(agentsResult)) {
    throw new Error("AI agent list is unavailable.")
  }

  const agent =
    (selectedAgentName ? agentsResult.find((item) => item.name === selectedAgentName) : undefined) ??
    agentsResult.find((item) => item.mode !== "subagent" && !item.hidden) ??
    agentsResult[0]
  if (!agent) throw new Error("No primary agent is available for chat.")

  if (selectedModel?.providerID && selectedModel.modelID) {
    return {
      agent: agent.name,
      model: {
        providerID: selectedModel.providerID,
        modelID: selectedModel.modelID,
      },
    }
  }

  const provider = providersResult.providers.find((item) => Object.keys(item.models ?? {}).length > 0)
  if (!provider) {
    throw new Error("No AI provider is configured. Run neo-research init or set an API key, then reopen the TUI.")
  }
  const modelID = providersResult.default[provider.id] ?? Object.keys(provider.models ?? {})[0]
  if (!modelID) throw new Error(`No model is available for provider ${provider.id}.`)
  return {
    agent: agent.name,
    model: {
      providerID: provider.id,
      modelID,
    },
  }
}

function streamLineColor(tone: StreamLine["tone"]) {
  if (tone === "primary") return cockpitColors.primary
  if (tone === "success") return cockpitColors.success
  if (tone === "warning") return cockpitColors.warning
  if (tone === "error") return cockpitColors.error
  if (tone === "text") return cockpitColors.text
  return cockpitColors.textMuted
}

function hasMeaningfulFingerprint(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0
}

function isFinalResearchArtifact(artifact: ResearchCockpitArtifact) {
  const kind = artifact.kind.toLowerCase()
  return kind.includes("final") || kind.includes("bundle") || kind.includes("report")
}

function compactStreamTextParts(value: string) {
  const text = value.trim() || "completed"
  return text
    .split(/\r?\n/)
    .map((part) => part.trimEnd())
    .filter((part) => part.trim().length > 0)
}

function streamingChatTextFromParts(parts: StreamingChatTextPart[]) {
  return parts
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
}

function parseAgentActionProposal(text: string | undefined): AgentActionProposal | undefined {
  const trimmed = text?.trim()
  if (!trimmed) return undefined
  const jsonText = trimmed.startsWith("```")
    ? trimmed
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim()
    : trimmed
  try {
    const parsed = JSON.parse(jsonText)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    if (record.kind !== "action_proposal") return undefined
    if (typeof record.title !== "string" || typeof record.command !== "string") return undefined
    const command = record.command.trim()
    if (!command.startsWith("/")) return undefined
    return {
      title: record.title,
      command,
      reason: typeof record.reason === "string" ? record.reason : "",
      reversible: record.reversible !== false,
      requireConfirm: record.requireConfirm !== false,
    }
  } catch {
    return undefined
  }
}

async function hasSeenResearchCockpitOnboarding() {
  try {
    const raw = JSON.parse(await readFile(researchCockpitOnboardingFile, "utf8")) as Record<string, unknown>
    return raw.cockpit === true
  } catch {
    return false
  }
}

async function markResearchCockpitOnboarded() {
  await mkdir(path.dirname(researchCockpitOnboardingFile), { recursive: true })
  await writeFile(
    researchCockpitOnboardingFile,
    `${JSON.stringify({ cockpit: true, version: neoResearchVersion, time: Date.now() }, null, 2)}\n`,
    "utf8",
  )
}

function setStreamingChatPartText(parts: StreamingChatTextPart[], id: string, text: string) {
  const existing = parts.findIndex((part) => part.id === id)
  if (existing === -1) return [...parts, { id, text }]
  return parts.map((part, index) => (index === existing ? { ...part, text } : part))
}

function appendStreamingChatPartText(parts: StreamingChatTextPart[], id: string, delta: string) {
  const existing = parts.findIndex((part) => part.id === id)
  if (existing === -1) return [...parts, { id, text: delta }]
  return parts.map((part, index) => (index === existing ? { ...part, text: part.text + delta } : part))
}

function promptTaskTitle(value: string) {
  return value.length > 72 ? `${value.slice(0, 69)}...` : value
}

function recordValue(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function stringListValue(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : []
}

function numberListValue(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item)) : []
}

function compactPathName(value: string) {
  return value.split(/[\\/]/).filter(Boolean).pop() ?? value
}

function compactTailPath(value: string) {
  const normalized = value.replace(/\\/g, "/")
  if (normalized.length <= 30) return value
  const tail = normalized.split("/").filter(Boolean).pop()
  return tail ? `.../${tail}` : value
}

function splitSlashSummary(prefix: string, summary: string) {
  const parts = summary
    .split(" / ")
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return []
  const lines: string[] = []
  for (let index = 0; index < parts.length; index += 2) {
    const text = parts.slice(index, index + 2).join(" / ")
    lines.push(index === 0 ? `${prefix} ${text}` : text)
  }
  return lines
}

function runnerIssueDetailLines(status: ResearchCockpitRunnerStatus) {
  if (status.ready) return []
  if (status.reason === "missing_runner_script") return ["Missing py/validate.py"]
  if (status.reason === "missing_root" || status.reason === "missing_runtime") return ["Set runner root in taskSpec.runtime."]
  if (status.reason === "missing_root_path") return [`Root not found: ${compactTailPath(status.root ?? "")}`]
  if (status.reason === "missing_python") return ["Initialize Neo-Cast runtime Python."]
  if (status.reason === "python_unavailable") return [`Python unavailable: ${compactTailPath(status.pythonExecutable ?? "")}`]
  if (status.reason === "unsupported_python") return ["Python must be >= 3.10."]
  if (status.reason === "dataset_spec_mismatch") return ["Prepared dataset does not match task.", "Prepare the task dataset again."]
  if (status.reason === "missing_dataset_spec") return ["Prepare Neo-Cast dataset_spec.json."]
  if (status.reason === "missing_task") return ["No task selected."]
  return [status.detail]
}

function isDatasetRepairRunnerStatus(status: ResearchCockpitRunnerStatus) {
  return status.reason === "dataset_spec_mismatch" || status.reason === "missing_dataset_spec"
}

function formatTaskRequirementSummaryLines(task?: ResearchCockpitTask) {
  if (!task) return []

  const taskSpec = recordValue(task.taskSpec)
  const dataset = recordValue(taskSpec.dataset)
  const metadata = recordValue(taskSpec.metadata)
  const objective = recordValue(task.objective)
  const budget = recordValue(task.budget)
  const prompt = typeof metadata.userPrompt === "string" ? metadata.userPrompt.trim() : ""
  const datasetName =
    typeof dataset.path === "string" && dataset.path.length > 0
      ? compactPathName(dataset.path)
      : typeof dataset.loaderID === "string" && dataset.loaderID.length > 0
        ? dataset.loaderID
        : undefined
  const targets = stringListValue(dataset.targetCols)
  const horizons = numberListValue(taskSpec.predictionLengths)
  const contextLength = typeof taskSpec.contextLength === "number" && Number.isFinite(taskSpec.contextLength) ? taskSpec.contextLength : undefined
  const metric = typeof objective.primaryMetric === "string" && objective.primaryMetric.length > 0 ? objective.primaryMetric : undefined
  const maxRuns = typeof budget.maxRuns === "number" && Number.isFinite(budget.maxRuns) ? budget.maxRuns : undefined
  const primaryParts = [
    metric ? `指标=${metric}` : undefined,
    prompt ? `需求=${promptTaskTitle(prompt)}` : undefined,
  ].filter((part): part is string => Boolean(part))
  const detailParts = [
    datasetName ? `数据=${datasetName}` : undefined,
    targets.length > 0 ? `目标=${targets.join(",")}` : undefined,
    horizons.length > 0 ? `预测=${horizons.join(",")}` : undefined,
    contextLength ? `上下文=${contextLength}` : undefined,
    maxRuns ? `预算=${maxRuns} runs` : undefined,
  ].filter((part): part is string => Boolean(part))

  if (primaryParts.length === 0 && detailParts.length === 0) return [`需求摘要 ${promptTaskTitle(task.title)}`]
  return [`需求摘要 ${primaryParts.join(" / ") || promptTaskTitle(task.title)}`, ...(detailParts.length > 0 ? [detailParts.join(" / ")] : [])]
}

function InteractionModeDialog(props: {
  onConfirm: (mode: ResearchInteractionMode) => void
}) {
  const { theme } = useTheme()
  const [selected, setSelected] = createSignal<ResearchInteractionMode>("socratic")

  function move(direction: number) {
    const index = interactionModeOptions.findIndex((option) => option.value === selected())
    const next = (index + direction + interactionModeOptions.length) % interactionModeOptions.length
    setSelected(interactionModeOptions[next]!.value)
  }

  useKeyboard((evt) => {
    if (evt.name === "1") {
      setSelected("companion")
      evt.preventDefault()
      evt.stopPropagation()
    }
    if (evt.name === "2") {
      setSelected("socratic")
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) {
      move(-1)
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) {
      move(1)
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
    if (evt.name === "return") {
      props.onConfirm(selected())
      evt.preventDefault()
      evt.stopPropagation()
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Interaction mode
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <box gap={1}>
        <For each={interactionModeOptions}>
          {(option) => {
            const active = createMemo(() => selected() === option.value)
            return (
              <box gap={1}>
                <box flexDirection="row" gap={1}>
                  <text fg={active() ? theme.primary : theme.textMuted}>{active() ? ">" : " "}</text>
                  <text attributes={TextAttributes.BOLD} fg={active() ? theme.primary : theme.text}>
                    {option.key} {option.title}
                  </text>
                </box>
                <box paddingLeft={4}>
                  <text fg={theme.textMuted}>{option.description}</text>
                </box>
              </box>
            )
          }}
        </For>
      </box>
      <box paddingBottom={1} gap={2} flexDirection="row">
        <text fg={theme.text}>
          enter <span style={{ fg: theme.textMuted }}>submit</span>
        </text>
        <text fg={theme.textMuted}>1/2 choose</text>
        <text fg={theme.textMuted}>up/down move</text>
      </box>
    </box>
  )
}

export function ResearchCockpit() {
  let promptInput: TextareaRenderable | undefined
  let focusTimer: ReturnType<typeof setTimeout> | undefined
  const sdk = useSDK()
  const event = useEvent()
  const route = useRoute()
  const dimensions = useTerminalDimensions()
  const command = useCommandDialog()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const local = useOptionalLocal()
  const textareaKeybindings = useTextareaKeybindings()
  const slashSelection = createResearchSlashSelection()
  let streamEventID = 0
  const [refresh, setRefresh] = createSignal(0)
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [selectedCandidateIndex, setSelectedCandidateIndex] = createSignal(0)
  const [selectedAgentStageIndex, setSelectedAgentStageIndex] = createSignal<number>()
  const [busy, setBusy] = createSignal<string>()
  const [chatBusy, setChatBusy] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [errorEvents, setErrorEvents] = createSignal<Array<{ id: number; action: string; text: string }>>([])
  const [actionEvents, setActionEvents] = createSignal<Array<{ id: number; action: string; text: string }>>([])
  const [runnerOutputLines, setRunnerOutputLines] = createSignal<
    Array<{ id: number; taskID?: string; runID: string; text: string; tone: StreamLine["tone"] }>
  >([])
  const [promptValue, setPromptValue] = createSignal("")
  const [csvInputErrors, setCsvInputErrors] = createSignal<string[]>([])
  const [promptEvents, setPromptEvents] = createSignal<Array<{ id: number; text: string; taskID?: string; detail?: string }>>(
    [],
  )
  const [streamingChat, setStreamingChat] = createSignal<StreamingChatTurn>()
  const [chatSessionID, setChatSessionID] = createSignal<string>()
  const [chatUsageByMessage, setChatUsageByMessage] = createSignal<Record<string, ChatUsageEntry>>({})
  const [interactionModeByTask, setInteractionModeByTask] = createSignal<Record<string, ResearchInteractionMode>>({})
  const routedGoalsHandled = new Set<string>()
  let routedCsvTaskHandled = false
  let actionQueue = Promise.resolve()
  let activeActionAbort: AbortController | undefined
  let activeChatAbort: AbortController | undefined
  const removedShortcutHints = new Set<string>()
  let chatDefaultsKey: string | undefined
  let chatDefaultsPromise: Promise<ResolvedChatDefaults> | undefined
  let activeApiActionKey: string | undefined
  let activeApiTimer: ReturnType<typeof setInterval> | undefined
  const [activeApiStartedAt, setActiveApiStartedAt] = createSignal<number>()
  const [activeApiTick, setActiveApiTick] = createSignal(0)

  function stopActiveApiTimer() {
    if (!activeApiTimer) return
    clearInterval(activeApiTimer)
    activeApiTimer = undefined
  }

  onMount(() => {
    focusTimer = setTimeout(() => promptInput?.focus(), 0)
    void showResearchCockpitOnboarding()
  })
  onCleanup(() => {
    if (focusTimer) clearTimeout(focusTimer)
    stopActiveApiTimer()
    activeActionAbort?.abort()
    activeChatAbort?.abort()
  })

  useKeyboard((evt) => {
    const name = evt.name?.toLowerCase()
    if (evt.ctrl && name === "c") {
      if (abortActiveOperation(false)) {
        evt.preventDefault()
        evt.stopPropagation()
      }
      return
    }
    if (evt.ctrl && name === "l") {
      setPromptEvents([])
      setActionEvents([])
      setErrorEvents([])
      setRunnerOutputLines([])
      setStreamingChat(undefined)
      setError(undefined)
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
    const removedShortcut =
      evt.ctrl && name === "n"
        ? "Ctrl+N 已移除。请使用 /new csv 或直接描述一个 CSV 任务。"
        : evt.ctrl && name === "b"
          ? "Ctrl+B 已移除。请使用 /seed。"
          : evt.ctrl && name === "e"
            ? "Ctrl+E 已移除。请使用 /export bundle。"
            : evt.meta && (name === "left" || name === "right")
              ? "Alt+Left/Right 已移除。请使用 /candidate prev 或 /candidate next。"
              : evt.meta && name === "h"
                ? "Alt+H 已移除。请使用 /home。"
                : undefined
    if (removedShortcut) {
      if (!removedShortcutHints.has(removedShortcut)) {
        removedShortcutHints.add(removedShortcut)
        appendCockpitNotice("shortcut", removedShortcut)
      }
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
    if (name !== "escape" && name !== "esc") return
    if (currentActionProposal()) {
      setStreamingChat(undefined)
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
    if (!abortActiveOperation(false)) return
    evt.preventDefault()
    evt.stopPropagation()
  })

  function handleStreamingChatEvent(payload: { type: string; properties?: any }) {
    const current = streamingChat()
    if (!current) return
    const properties = payload.properties ?? {}
    if (payload.type === "message.updated") {
      const info = properties.info
      if (info?.sessionID !== current.sessionID || info.role !== "assistant") return
      recordChatUsage(info)
      setStreamingChat((draft) => (draft ? { ...draft, messageID: info.id } : draft))
      return
    }
    if (payload.type === "message.part.updated") {
      const part = properties.part
      if (part?.sessionID !== current.sessionID || typeof part.messageID !== "string") return
      if (current.messageID && part.messageID !== current.messageID) return
      if (part.type !== "text") return
      setStreamingChat((draft) =>
        draft
          ? (() => {
              const parts = setStreamingChatPartText(
                draft.parts,
                part.id,
                typeof part.text === "string" ? part.text : "",
              )
              return {
                ...draft,
                messageID: draft.messageID ?? part.messageID,
                partID: part.id,
                parts,
                text: streamingChatTextFromParts(parts),
              }
            })()
          : draft,
      )
      return
    }
    if (payload.type === "message.part.delta") {
      if (properties.sessionID !== current.sessionID || typeof properties.messageID !== "string") return
      if (current.messageID && properties.messageID !== current.messageID) return
      if (properties.field !== "text" || typeof properties.delta !== "string") return
      const partID = typeof properties.partID === "string" && properties.partID.length > 0 ? properties.partID : "text"
      setStreamingChat((draft) =>
        draft
          ? (() => {
              const parts = appendStreamingChatPartText(draft.parts, partID, properties.delta)
              return {
                ...draft,
                messageID: draft.messageID ?? properties.messageID,
                partID,
                parts,
                text: streamingChatTextFromParts(parts),
              }
            })()
          : draft,
      )
    }
  }

  function recordChatUsage(info: unknown) {
    const entry = chatUsageEntryFromInfo(info)
    if (!entry) return
    setChatUsageByMessage((current) => ({
      ...current,
      [entry.messageID]: entry,
    }))
  }

  function persistStreamingChat() {
    const current = streamingChat()
    if (!current?.text) return
    const proposal = parseAgentActionProposal(current.text)
    setActionEvents((events) => [
      ...events.slice(-(promptEventHistoryLimit - 1)),
      {
        id: current.id,
        action: proposal ? "action-proposal" : "chat-stream",
        text: proposal ? `accepted ${proposal.command}: ${proposal.reason || proposal.title}` : current.text,
      },
    ])
    setStreamingChat(undefined)
  }

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
  let selectedAgentStageTaskID: string | undefined

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

  createEffect(() => {
    const taskID = selectedTask()?.id
    if (selectedAgentStageTaskID === taskID) return
    selectedAgentStageTaskID = taskID
    setSelectedAgentStageIndex(undefined)
  })

  const unsubscribeResearchEvents = event.subscribe((payload) => {
    handleStreamingChatEvent(payload)
    const researchPayload = payload as { type: string; properties?: unknown }
    if (researchPayload.type === "research.runner.progress.line") {
      const data = researchPayload.properties as Partial<RunnerProgressLineEvent> | undefined
      if (!data || typeof data.runID !== "string" || typeof data.line !== "string") return
      const runID = data.runID
      const taskID = typeof data.taskID === "string" ? data.taskID : undefined
      const eventName = data.event
      const task = selectedTask()
      if (task && typeof taskID === "string" && taskID !== task.id) return
      const text = formatRunnerProgressLine(data as RunnerProgressLineEvent)
      setRunnerOutputLines((lines) => [
        ...lines.slice(-(runnerOutputBufferSize - 1)),
        {
          id: ++streamEventID,
          taskID,
          runID,
          text,
          tone: eventName === "timeout" ? "warning" : "muted",
        },
      ])
      return
    }
    if (!shouldRefreshResearchCockpitOnEvent(researchPayload)) return
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
      void createCsvTask()
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

  const pendingApproval = createMemo(() => approvals()?.find((approval) => approval.status === "pending"))
  const chatAwaitingFirstToken = createMemo(() => !!chatBusy() || (!!streamingChat() && !streamingChat()?.text))
  const currentActionProposal = createMemo(() => parseAgentActionProposal(streamingChat()?.text))
  const activeApiAction = createMemo(() => {
    return chatBusy() ?? (streamingChat() && !streamingChat()?.text ? `chat:${streamingChat()?.modelLabel ?? "model"}` : busy())
  })
  createEffect(() => {
    const active = activeApiAction()
    if (!active) {
      activeApiActionKey = undefined
      setActiveApiStartedAt(undefined)
      setActiveApiTick(0)
      stopActiveApiTimer()
      return
    }
    if (activeApiActionKey !== active) {
      activeApiActionKey = active
      setActiveApiStartedAt(Date.now())
      setActiveApiTick(0)
    }
    if (!activeApiTimer) {
      activeApiTimer = setInterval(() => setActiveApiTick((value) => value + 1), 250)
    }
  })
  const activeApiElapsed = createMemo(() => {
    const startedAt = activeApiStartedAt()
    if (startedAt === undefined) return undefined
    activeApiTick()
    return formatBusyElapsed(Date.now() - startedAt)
  })
  const workingStatusLine = createMemo(() => {
    const active = activeApiAction()
    const elapsed = activeApiElapsed()
    if (!active || !elapsed) return undefined
    return workingActionText(active, elapsed, activeApiTick())
  })
  const runnerStatus = createMemo(() => getResearchCockpitRunnerStatus(selectedTask(), { validateRuntime: true }))
  const runnerReady = createMemo(() => runnerStatus().ready)
  const taskCandidates = createMemo(() => candidates() ?? [])
  const taskRuns = createMemo(() => runs() ?? [])
  const taskArtifacts = createMemo(() => artifacts() ?? [])
  const taskApprovals = createMemo(() => approvals() ?? [])
  const intentConfirmed = createMemo(() =>
    hasIntentConfirmation({
      task: selectedTask(),
      approvals: taskApprovals(),
      artifacts: taskArtifacts(),
      runs: taskRuns(),
      candidates: taskCandidates(),
    }),
  )
  const canStartAutonomousLoop = createMemo(
    () =>
      selectedTask()?.mode === "autonomous" &&
      intentConfirmed() &&
      (runnerReady() || isDatasetRepairRunnerStatus(runnerStatus())),
  )
  const taskInteractionMode = createMemo(() => {
    const task = selectedTask()
    if (!task) return undefined
    return interactionModeByTask()[task.id] ?? interactionModeForTask(task)
  })
  const socraticClarification = createMemo(() =>
    buildSocraticClarificationState(selectedTask(), taskApprovals(), { includeCompanion: true }),
  )
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
      runnerRepairAction: isDatasetRepairRunnerStatus(runnerStatus()) ? "prepare_dataset" : "configure_runner",
    }),
  )
  const nextBestAction = createMemo(() =>
    selectNextBestAction({
      task: selectedTask(),
      candidates: taskCandidates(),
      runs: taskRuns(),
      artifacts: taskArtifacts(),
      approvals: taskApprovals(),
      champion: validChampion() ?? null,
      fingerprint: taskFingerprint() ?? {},
      runnerReady: runnerReady(),
      runnerRepairAction: isDatasetRepairRunnerStatus(runnerStatus()) ? "prepare_dataset" : "configure_runner",
    }),
  )
  async function runAction(name: string, fn: (signal: AbortSignal) => Promise<string>) {
    const run = async () => {
      const abortController = new AbortController()
      activeActionAbort = abortController
      setBusy(name)
      try {
        const message = await fn(abortController.signal)
        setError(undefined)
        setActionEvents((events) => [
          ...events.slice(-(promptEventHistoryLimit - 1)),
          { id: ++streamEventID, action: name, text: message },
        ])
        toast.show({ variant: "info", message })
        setRefresh((value) => value + 1)
      } catch (err) {
        const message = abortController.signal.aborted
          ? name === "chat"
            ? "Chat request canceled."
            : `${name} canceled.`
          : formatError(err)
        setError(message)
        setErrorEvents((events) => [
          ...events.slice(-(errorEventHistoryLimit - 1)),
          { id: ++streamEventID, action: name, text: message },
        ])
        toast.show({ variant: "error", message })
      } finally {
        if (activeActionAbort === abortController) activeActionAbort = undefined
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

  async function showResearchCockpitOnboarding() {
    if (await hasSeenResearchCockpitOnboarding()) return
    appendCockpitNotice("welcome", researchCockpitOnboardingText, { toast: false })
    await markResearchCockpitOnboarded().catch(() => undefined)
  }

  function appendCockpitNotice(action: string, text: string, options?: { toast?: boolean }) {
    setActionEvents((events) => [
      ...events.slice(-(promptEventHistoryLimit - 1)),
      { id: ++streamEventID, action, text },
    ])
    if (options?.toast === false) return
    toast.show({ variant: "info", message: text, duration: 4000 })
  }

  function abortActiveOperation(notifyIdle = true) {
    if (chatBusy()) {
      activeChatAbort?.abort()
      return true
    }
    const streaming = streamingChat()
    if (streaming) {
      void researchRequest<boolean>(sdk, `/session/${encodeURIComponent(streaming.sessionID)}/abort`, { method: "POST" }).catch(
        () => undefined,
      )
      setStreamingChat(undefined)
      const message = "Chat request canceled."
      setError(message)
      setErrorEvents((events) => [
        ...events.slice(-(errorEventHistoryLimit - 1)),
        { id: ++streamEventID, action: "chat", text: message },
      ])
      toast.show({ variant: "error", message })
      return true
    }
    if (busy()) {
      activeActionAbort?.abort()
      return true
    }
    if (notifyIdle) {
      toast.show({
        variant: "info",
        message: "No active cockpit action to abort.",
        duration: 3000,
      })
    }
    return false
  }

  async function runChatAction(fn: (signal: AbortSignal) => Promise<string>) {
    const abortController = new AbortController()
    activeChatAbort = abortController
    setChatBusy("chat")
    try {
      const message = await fn(abortController.signal)
      setError(undefined)
      if (message) {
        setActionEvents((events) => [
          ...events.slice(-(promptEventHistoryLimit - 1)),
          { id: ++streamEventID, action: message.startsWith("请求已提交给 ") ? "chat-status" : "chat", text: message },
        ])
        toast.show({ variant: "info", message })
      }
      setRefresh((value) => value + 1)
    } catch (err) {
      const message = abortController.signal.aborted ? "Chat request canceled." : formatError(err)
      setError(message)
      setErrorEvents((events) => [
        ...events.slice(-(errorEventHistoryLimit - 1)),
        { id: ++streamEventID, action: "chat", text: message },
      ])
      toast.show({ variant: "error", message })
    } finally {
      if (activeChatAbort === abortController) activeChatAbort = undefined
      if (activeChatAbort === undefined) setChatBusy(undefined)
    }
  }

  async function chooseInteractionMode() {
    return new Promise<ResearchInteractionMode | undefined>((resolve) => {
      let settled = false
      const finish = (value: ResearchInteractionMode | undefined) => {
        if (settled) return
        settled = true
        resolve(value)
        dialog.clear()
      }
      dialog.replace(
        () => (
          <InteractionModeDialog onConfirm={(mode) => finish(mode)} />
        ),
        () => finish(undefined),
      )
    })
  }

  async function createTask(mode?: ResearchCockpitTask["mode"], defaults: TsfResearchTaskDefaults = {}) {
    const interactionMode = defaults.interactionMode ?? (mode === undefined ? await chooseInteractionMode() : undefined)
    const resolvedMode = mode ?? (interactionMode === undefined ? undefined : taskModeForInteractionMode(interactionMode))
    if (!resolvedMode) return
    await runAction(`create-${resolvedMode}`, async () => {
      const payload: CreateResearchTaskInput = buildDefaultTsfResearchTask(
        resolvedMode,
        resolveResearchCockpitProjectRunnerRoot(sdk.directory ?? process.cwd()),
        {
          ...defaults,
          ...(interactionMode === undefined ? {} : { interactionMode }),
        },
      )
      const task = await researchRequest<ResearchCockpitTask>(sdk, "/research/tasks", {
        method: "POST",
        body: JSON.stringify(payload),
      })
      setSelectedIndex(0)
      return `${task.title} created`
    })
  }

  async function createCsvTask(mode?: ResearchCockpitTask["mode"], defaults: TsfResearchTaskDefaults = {}) {
    const interactionMode = defaults.interactionMode ?? (mode === undefined ? await chooseInteractionMode() : undefined)
    const resolvedMode = mode ?? (interactionMode === undefined ? undefined : taskModeForInteractionMode(interactionMode))
    if (!resolvedMode) return
    let parsed: TsfResearchTaskDefaults | undefined
    let inputValue: string | undefined
    while (!parsed?.datasetPath) {
      const value = await DialogPrompt.show(dialog, "CSV dataset path", {
        value: inputValue,
        placeholder: "/path/to/ETTh1.csv target=OT horizon=24 context=96 full",
        onChange: (next) => {
          setCsvInputErrors(next.trim().length === 0 ? [] : validateTsfCsvTaskInput(next))
        },
        description: () => (
          <box gap={1}>
            <text fg={theme.textMuted}>Options: target=OT,HUFL horizon=24,48 context=96 preset=etth1 full|bridge.</text>
            <For each={csvInputErrors()}>
              {(error) => <text fg={cockpitColors.error}>{error}</text>}
            </For>
          </box>
        ),
      })
      inputValue = value ?? undefined
      if (!value) {
        setCsvInputErrors([])
        return
      }
      const errors = validateTsfCsvTaskInput(value)
      if (errors.length > 0) {
        setCsvInputErrors(errors)
        continue
      }
      parsed = parseTsfCsvTaskInput(value)
      if (!parsed?.datasetPath) {
        setCsvInputErrors(["Enter a CSV dataset path."])
      }
    }
    setCsvInputErrors([])
    await createTask(resolvedMode, {
      ...defaults,
      ...parsed,
      ...(interactionMode === undefined ? {} : { interactionMode }),
    })
    dialog.clear()
  }

  async function seedBaselines() {
    const task = selectedTask()
    if (!task) return
    if (!intentConfirmed()) {
      await confirmIntentCheckpoint()
      return
    }
    await runAction("seed-baselines", async () => {
      const seeded = await researchRequest<{ candidates: unknown[]; approvals: unknown[] }>(
        sdk,
        `/research/tasks/${encodeURIComponent(task.id)}/baselines`,
        { method: "POST" },
      )
      return `${seeded.candidates.length} candidates seeded`
    })
  }

  async function replyPendingApproval(status: "approved" | "rejected") {
    const approval = pendingApproval()
    if (!approval) return
    await runAction(`${status === "approved" ? "approve" : "reject"}-pending`, async () => {
      const updated = await researchRequest<ResearchCockpitApproval>(
        sdk,
        `/research/approvals/${encodeURIComponent(approval.id)}/reply`,
        {
          method: "POST",
          body: JSON.stringify({ status }),
        },
      )
      return `${shortID(updated.id)} ${updated.status}`
    })
  }

  async function approvePending() {
    await replyPendingApproval("approved")
  }

  async function confirmIntentCheckpoint() {
    const task = selectedTask()
    if (!task) return
    await runAction("confirm-intent", async () => {
      const approval = await researchRequest<ResearchCockpitApproval>(
        sdk,
        "/research/approvals",
        {
          method: "POST",
          body: JSON.stringify({
            taskID: task.id,
            kind: "protocol",
            reason: formatResearchCockpitIntentCheckpointReason(task),
          }),
        },
      )
      const updated = await researchRequest<ResearchCockpitApproval>(
        sdk,
        `/research/approvals/${encodeURIComponent(approval.id)}/reply`,
        {
          method: "POST",
          body: JSON.stringify({ status: "approved", replyMessage: "Intent requirements confirmed." }),
        },
      )
      return `${shortID(updated.id)} intent confirmed`
    })
  }

  async function rejectPending() {
    await replyPendingApproval("rejected")
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

  function currentChatDefaultsKey() {
    const selectedModel = local?.model.current()
    const selectedAgent = local?.agent.current()?.name
    return JSON.stringify({
      providerID: selectedModel?.providerID,
      modelID: selectedModel?.modelID,
      agent: selectedAgent,
    })
  }

  async function loadChatDefaults(): Promise<ResolvedChatDefaults> {
    const [providersResult, agentsResult] = await Promise.all([
      researchRequest<ChatProviderList>(sdk, "/config/providers"),
      researchRequest<ChatAgent[]>(sdk, "/agent"),
    ])
    const selectedModel = local?.model.current()
    const defaults = resolveResearchCockpitChatDefaults({
      providersResult,
      agentsResult,
      selectedModel,
      selectedAgentName: local?.agent.current()?.name,
    })
    const provider = providersResult.providers.find((item) => item.id === defaults.model.providerID)
    const model = provider?.models?.[defaults.model.modelID]
    return {
      ...defaults,
      modelLabel: selectedModel
        ? local?.model.parsed().model ?? defaults.model.modelID
        : model?.name ?? model?.id ?? defaults.model.modelID,
      modelLimit: model?.limit?.context,
      providerLabel: provider?.name ?? provider?.id,
    }
  }

  async function resolveChatDefaults() {
    const key = currentChatDefaultsKey()
    if (chatDefaultsPromise && chatDefaultsKey === key) return chatDefaultsPromise
    chatDefaultsKey = key
    chatDefaultsPromise = loadChatDefaults().catch((err) => {
      if (chatDefaultsKey === key) {
        chatDefaultsKey = undefined
        chatDefaultsPromise = undefined
      }
      throw err
    })
    return chatDefaultsPromise
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
      "尽量用中文回答用户，并用简洁、可执行的方式帮助用户操作当前研究 workspace。",
      "保留 JSON 字段名、schema 名称、指标名、命令、文件路径、模型族和技术术语的英文原文。",
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
    await runChatAction(async (signal) => {
      const localReply = localResearchChatReply(value)
      if (localReply) return localReply
      const [sessionID, defaults] = await Promise.all([
        ensureChatSession(),
        resolvedDefaults ? Promise.resolve(resolvedDefaults) : resolveChatDefaults(),
      ])
      persistStreamingChat()
      setStreamingChat({ id: ++streamEventID, sessionID, text: "", parts: [], modelLabel: defaults.modelLabel })
      setChatBusy(`chat:${defaults.modelLabel}`)
      try {
        await researchRequestNoContent(
          sdk,
          `/session/${encodeURIComponent(sessionID)}/prompt_async`,
          {
            method: "POST",
            signal,
            body: JSON.stringify({
              ...defaults.model,
              agent: defaults.agent,
              model: defaults.model,
              parts: chatContextForPrompt(value),
            }),
          },
          chatRequestTimeoutMs,
        )
        return `请求已提交给 ${defaults.modelLabel}，正在等待回复流...`
      } catch (err) {
        if (signal.aborted) throw err
        const message = formatError(err)
        if (message.includes("Request timed out")) {
          throw new Error(
            `Chat request to ${defaults.modelLabel} timed out after ${chatRequestTimeoutMs / 1000}s. Check the model API key/network or switch models.`,
          )
        }
        throw new Error(`Chat request to ${defaults.modelLabel} failed: ${message}`)
      }
    })
  }

  async function runAutonomousLoop() {
    const task = selectedTask()
    if (!task || task.mode !== "autonomous") return
    if (!intentConfirmed()) {
      await confirmIntentCheckpoint()
      return
    }
    await runAction("autonomous-loop", async (signal) => {
      let preparedDataset: ResearchCockpitDatasetPreparationResult | undefined
      if (!runnerReady()) {
        const status = runnerStatus()
        if (isDatasetRepairRunnerStatus(status)) {
          preparedDataset = await requestTaskDatasetPreparation(task, signal)
        } else {
          throw new Error(
            `Runner not ready: ${status.detail ?? status.reason}. Configure taskSpec.runtime.neoCastProjectRoot and ensure py/validate.py exists.`,
          )
        }
      }
      const result = await researchRequest<ResearchCockpitLoopResult>(
        sdk,
        `/research/tasks/${encodeURIComponent(task.id)}/autonomous/loop`,
        {
          method: "POST",
          body: JSON.stringify({ stage: "smoke", maxIterations: 3, description: "cockpit autonomous loop" }),
          signal,
        },
      )
      const loopMessage = formatResearchCockpitLoop(result)
      if (preparedDataset) return `dataset prepared ${shortID(preparedDataset.artifact.id)} / ${loopMessage}`
      return loopMessage
    })
  }

  async function requestTaskDatasetPreparation(task: ResearchCockpitTask, signal?: AbortSignal) {
    return await researchRequest<ResearchCockpitDatasetPreparationResult>(
      sdk,
      `/research/tasks/${encodeURIComponent(task.id)}/prepare-dataset`,
      {
        method: "POST",
        body: JSON.stringify({ force: true }),
        signal,
      },
      300_000,
    )
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
            body: JSON.stringify({ kind: "research_final_bundle", outputDir: ".neo-research/final" }),
          },
        )
      return formatResearchCockpitExport(result)
    })
  }

  async function profileTask() {
    const task = selectedTask()
    if (!task) return
    if (!intentConfirmed()) {
      await confirmIntentCheckpoint()
      return
    }
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

  async function prepareTaskDataset() {
    const task = selectedTask()
    if (!task) return
    await runAction("prepare-dataset", async (signal) => {
      const result = await requestTaskDatasetPreparation(task, signal)
      return `dataset prepared ${shortID(result.artifact.id)}`
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
    const root = resolveResearchCockpitProjectRunnerRoot(sdk.directory ?? process.cwd())
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

  async function switchInteractionMode(interactionMode?: ResearchInteractionMode) {
    const task = selectedTask()
    if (!task) {
      toast.show({ variant: "info", message: "Select a research task before switching interaction mode.", duration: 3000 })
      return
    }
    const nextMode = interactionMode ?? (await chooseInteractionMode())
    if (!nextMode) return
    await runAction("switch-interaction-mode", async () => {
      const updated = updateResearchCockpitTaskInteractionMode(task, nextMode)
      const saved = await researchRequest<ResearchCockpitTask>(
        sdk,
        `/research/tasks/${encodeURIComponent(task.id)}/spec`,
        {
          method: "PATCH",
          body: JSON.stringify({ interactionMode: nextMode, taskSpec: updated.taskSpec }),
        },
      )
      setInteractionModeByTask((current) => ({
        ...current,
        [saved.id]: nextMode,
      }))
      return `interaction mode switched to ${researchInteractionModeLabel(interactionModeForTask(saved))}`
    })
  }

  async function runRecommendedAction() {
    const task = selectedTask()
    const next = recommendation().action
    if (!task) {
      promptInput?.focus()
      toast.show({
        variant: "info",
        message: "描述一个预测目标来创建下一个研究任务。",
        duration: 4000,
      })
      return
    }
    if (pendingApproval()) {
      await approvePending()
      return
    }
    if (next === "confirm_intent") {
      await confirmIntentCheckpoint()
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
    if (next === "prepare_dataset") {
      await prepareTaskDataset()
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

  async function confirmCurrentActionProposal() {
    const proposal = currentActionProposal()
    if (!proposal) return false
    persistStreamingChat()
    setStreamingChat(undefined)
    await runSlashPrompt(proposal.command)
    return true
  }

  async function runSlashPrompt(value: string) {
    const tokens = value.slice(1).trim().split(/\s+/).filter(Boolean)
    const name = tokens[0]?.toLowerCase()
    const args = tokens.slice(1)
    const arg = (index: number) => args[index]?.toLowerCase()
    const hasArg = (target: string) => args.some((item) => item.toLowerCase() === target)
    const hasFlag = (target: string) => hasArg(target)
    const optionValue = (target: string) => {
      const index = args.findIndex((item) => item.toLowerCase() === target)
      if (index >= 0) return args[index + 1]?.toLowerCase()
      const inline = args.find((item) => item.toLowerCase().startsWith(`${target}=`))
      return inline?.slice(target.length + 1).toLowerCase()
    }
    const modeArg = () => {
      const value = optionValue("--mode")
      if (value === "review" || value === "autonomous") return value
      if (hasArg("review")) return "review"
      if (hasArg("autonomous")) return "autonomous"
      return undefined
    }
    const fullDefaults = (): TsfResearchTaskDefaults => (hasFlag("--full") || hasArg("full") ? { bridgeOnly: false } : {})

    if (name === "home") {
      route.navigate({ type: "home" })
      return
    }
    if (name === "doctor" || name === "api-key" || name === "provider" || name === "auth") {
      route.navigate({ type: "home" })
      return
    }
    if (name === "abort" || name === "cancel" || name === "stop") {
      abortActiveOperation()
      return
    }
    if (name === "help") {
      appendCockpitNotice(
        "help",
        "Commands: /new, /dataset, /run, /loop, /task, /candidate, /runner, /mode, /seed, /export, /abort, /home",
      )
      return
    }
    if (name === "new") {
      const mode = modeArg()
      const defaults = fullDefaults()
      if (arg(0) === "csv" || arg(0) === "dataset") {
        await createCsvTask(mode, defaults)
        return
      }
      if (arg(0) === "review") {
        await createTask("review", defaults)
        return
      }
      if (arg(0) === "task" || arg(0) === "autonomous" || arg(0) === "preset") {
        await createTask(mode ?? "autonomous", defaults)
        return
      }
      await createCsvTask(mode, defaults)
      return
    }
    if (name === "review" || name === "review-full") {
      await createTask("review", name === "review-full" ? { bridgeOnly: false } : {})
      return
    }
    if (name === "review-csv" || name === "review-csv-full") {
      await createCsvTask("review", name === "review-csv-full" ? { bridgeOnly: false } : {})
      return
    }
    if (name === "csv" || name === "dataset") {
      if (arg(0) === "prepare") {
        await prepareTaskDataset()
        return
      }
      if (arg(0) === "profile") {
        await profileTask()
        return
      }
      if (arg(0) === "status") {
        appendCockpitNotice("dataset-status", runnerStatus().ready ? "Dataset and runner are ready." : runnerStatus().detail ?? runnerStatus().reason)
        return
      }
      await createCsvTask(undefined, fullDefaults())
      return
    }
    if (name === "csv-full" || name === "dataset-full") {
      await createCsvTask(undefined, { bridgeOnly: false })
      return
    }
    if (name === "prepare-dataset" || name === "dataset-prepare") {
      await prepareTaskDataset()
      return
    }
    if (name === "profile") {
      await profileTask()
      return
    }
    if (name === "task") {
      if (arg(0) === "next") {
        selectTaskOffset(1)
        return
      }
      if (arg(0) === "prev" || arg(0) === "previous") {
        selectTaskOffset(-1)
        return
      }
      if (arg(0) === "list") {
        appendCockpitNotice("task-list", sortedTasks().map((task) => task.title).join(" · ") || "No research tasks.")
        return
      }
      if (arg(0) === "select" && args[1]) {
        const query = args[1].toLowerCase()
        const index = sortedTasks().findIndex((task, taskIndex) => task.id.toLowerCase().includes(query) || String(taskIndex + 1) === query)
        if (index >= 0) setSelectedIndex(index)
        else appendCockpitNotice("task-select", `No task matched ${args[1]}.`)
        return
      }
      await createTask("autonomous", fullDefaults())
      return
    }
    if (name === "task-full" || name === "autonomous-full") {
      await createTask("autonomous", { bridgeOnly: false })
      return
    }
    if (name === "autonomous") {
      await createTask("autonomous")
      return
    }
    if (name === "candidate") {
      if (arg(0) === "next") {
        selectCandidateOffset(1)
        return
      }
      if (arg(0) === "prev" || arg(0) === "previous") {
        selectCandidateOffset(-1)
        return
      }
      if (arg(0) === "approve") {
        await approvePending()
        return
      }
      if (arg(0) === "reject") {
        await rejectPending()
        return
      }
      appendCockpitNotice("candidate", `${candidatePosition()} selected.`)
      return
    }
    if (name === "seed" || name === "seed-baselines" || name === "baselines") {
      await seedBaselines()
      return
    }
    if (name === "approve") {
      await approvePending()
      return
    }
    if (name === "reject") {
      await rejectPending()
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
    if (name === "run") {
      const candidate = commandCandidate()
      if (arg(0) === "seed-sweep" && candidate) {
        await executeCandidateSeedSweep(candidate)
        return
      }
      if ((arg(0) === "ref" || arg(0) === "ref-test") && candidate) {
        await executeCandidate(candidate, "ref_test")
        return
      }
      if ((arg(0) === "blind" || arg(0) === "blind-test") && candidate) {
        await executeCandidate(candidate, "blind_test")
        return
      }
      if (arg(0) === "full" && candidate) {
        await executeCandidate(candidate, "full")
        return
      }
      if (arg(0) === "smoke" && candidate) {
        await executeCandidate(candidate, "smoke")
        return
      }
      await runRecommendedAction()
      return
    }
    if (name === "loop" || name === "agent-loop") {
      if (arg(0) === "stop") {
        abortActiveOperation()
        return
      }
      if (arg(0) === "status") {
        appendCockpitNotice("loop-status", workingStatusLine() ?? recommendation().detail)
        return
      }
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
    if (name === "runner") {
      if (arg(0) === "edit-root") {
        await editRunnerRoot()
        return
      }
      if (arg(0) === "use-project") {
        await useProjectRunnerRoot()
        return
      }
      appendCockpitNotice("runner-check", runnerReady() ? "Runner ready." : runnerStatus().detail ?? runnerStatus().reason)
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
    if (name === "mode") {
      if (arg(0) === "socratic") {
        await switchInteractionMode("socratic")
        return
      }
      if (arg(0) === "companion") {
        await switchInteractionMode("companion")
        return
      }
      await switchInteractionMode()
      return
    }
    if (name === "mode-socratic" || name === "socratic") {
      await switchInteractionMode("socratic")
      return
    }
    if (name === "mode-companion" || name === "companion") {
      await switchInteractionMode("companion")
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
    if (name === "export" || name === "report" || name === "bundle") {
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
    const interactionMode = await chooseInteractionMode()
    if (!interactionMode) return
    const mode = taskModeForInteractionMode(interactionMode)
    await runAction(source === "home" ? "create-from-home-goal" : "create-from-prompt", async () => {
      const payload: CreateResearchTaskInput = buildDefaultTsfResearchTaskFromGoal(
        value,
        mode,
        resolveResearchCockpitProjectRunnerRoot(sdk.directory ?? process.cwd()),
        { interactionMode },
      )
      const metadata = payload.taskSpec.metadata
      const eventDetail = source === "home" ? "created from home goal" : "created from prompt"
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
        const result = await researchRequest<{
          nas: { loop: ResearchCockpitLoopResult }
          publish: ResearchCockpitExportResult
        }>(
          sdk,
          `/research/tasks/${encodeURIComponent(executableTask.id)}/pipeline`,
          {
            method: "POST",
            body: JSON.stringify({ stage: "smoke", description: value, maxIterations: 3 }),
          },
        )
        detail = `${eventDetail}; completed multi-agent pipeline`
        actionMessage = `${formatResearchCockpitLoop(result.nas.loop)}; ${formatResearchCockpitExport(result.publish)}`
      }
      setSelectedIndex(0)
      setPromptEvents((events) => [
        ...events.slice(-(promptEventHistoryLimit - 1)),
        {
          id: ++streamEventID,
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
    if (!value) {
      if (await confirmCurrentActionProposal()) {
        promptInput?.focus()
        return
      }
      await runRecommendedAction()
      promptInput?.focus()
      return
    }
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
          id: ++streamEventID,
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
        id: ++streamEventID,
        text: value,
        taskID: task?.id,
      },
    ])
    if (isRunRecommendedPrompt(value)) {
      await runRecommendedAction()
      promptInput?.focus()
      return
    }
    const clarification = socraticClarification()
    if (clarification.active && task.status === "paused" && clarification.nextQuestion) {
      const slotID = slotFromSocraticQuestion(clarification.nextQuestion)
      if (slotID !== "unknown") {
        try {
          await researchRequest(sdk, `/research/tasks/${encodeURIComponent(task.id)}/intent/answer`, {
            method: "POST",
            body: JSON.stringify({ slots: { [slotID]: value } }),
          })
        } catch {
          // fall through to chat
        }
        promptInput?.focus()
        return
      }
    }
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
    const token = value.trim().split(/\s+/, 1)[0]?.toLowerCase()
    if (token && token !== option.display.trim().toLowerCase() && option.aliases?.some((alias) => alias.trim().toLowerCase() === token)) {
      return false
    }
    selectSlashOption(option)
    return true
  }

  function handleSlashKeyDown(evt: KeyEvent) {
    const value = promptInput?.plainText ?? promptValue()
    const options = command.slashes()
    const name = evt.name?.toLowerCase()
    const ctrlOnly = evt.ctrl && !evt.meta && !evt.shift

    if ((name === "return" || name === "enter") && value.trim().length === 0) {
      evt.preventDefault()
      evt.stopPropagation()
      void (async () => {
        if (await confirmCurrentActionProposal()) return
        await runRecommendedAction()
      })()
      return
    }

    if (slashMenuHasOptions(value, options)) {
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
        const token = value.trim().split(/\s+/, 1)[0]?.toLowerCase()
        evt.preventDefault()
        if (token && token !== option.display.trim().toLowerCase() && option.aliases?.some((alias) => alias.trim().toLowerCase() === token)) {
          void runSlashPrompt(value)
          promptInput?.clear()
          setPromptValue("")
          promptInput?.focus()
          return
        }
        selectSlashOption(option)
      }
      return
    }

    if (name === "tab" && cycleAgentStage(evt.shift ? -1 : 1)) {
      evt.preventDefault()
      evt.stopPropagation()
    }
  }

  command.register(() => [
    {
      title: "Create or import research task",
      description: "/new csv --mode autonomous --full",
      value: "research.new",
      category: "Research",
      slash: {
        name: "new",
        aliases: [
          "review",
          "review-full",
          "review-csv",
          "review-csv-full",
          "csv",
          "csv-full",
          "autonomous",
          "task-full",
          "autonomous-full",
        ],
      },
      onSelect: () => void createCsvTask(),
    },
    {
      title: "Dataset actions",
      description: "/dataset prepare|profile|status",
      value: "research.dataset",
      category: "Research",
      enabled: !!selectedTask(),
      slash: { name: "dataset", aliases: ["prepare-dataset", "dataset-prepare", "profile"] },
      onSelect: () => void runSlashPrompt("/dataset prepare"),
    },
    {
      title: "Run selected candidate or recommendation",
      description: "/run smoke|full|ref|blind|seed-sweep",
      value: "research.run",
      category: "Research",
      enabled: !!selectedTask(),
      slash: { name: "run", aliases: ["iterate", "next", "ref-exec", "blind-exec", "seed-sweep"] },
      onSelect: () => void runRecommendedAction(),
    },
    {
      title: "Autonomous loop",
      description: "/loop start|stop|status",
      value: "research.loop",
      category: "Research",
      enabled: !!selectedTask(),
      slash: { name: "loop", aliases: ["agent-loop"] },
      onSelect: () => void runAutonomousLoop(),
    },
    {
      title: "Task navigation",
      description: "/task next|prev|list|select <id>",
      value: "research.task",
      category: "Research",
      keybind: "ctrl+j",
      slash: { name: "task", aliases: ["task-next", "task-previous", "task-prev"] },
      onSelect: () => selectTaskOffset(1),
    },
    {
      title: "Select previous research task",
      value: "research.task.previous",
      category: "Research",
      enabled: sortedTasks().length > 1,
      keybind: "ctrl+k",
      hidden: true,
      onSelect: () => selectTaskOffset(-1),
    },
    {
      title: "Candidate actions",
      description: "/candidate next|prev|approve|reject",
      value: "research.candidate",
      category: "Research",
      enabled: !!selectedTask(),
      slash: {
        name: "candidate",
        aliases: ["candidate-next", "candidate-previous", "candidate-prev", "cand-next", "cand-prev", "approve", "reject"],
      },
      onSelect: () => selectCandidateOffset(1),
    },
    {
      title: "Runner actions",
      description: "/runner check|edit-root|use-project",
      value: "research.runner",
      category: "Research",
      enabled: !!selectedTask(),
      slash: { name: "runner", aliases: ["use-project-runner", "runner-root", "edit-runner-root"] },
      onSelect: () => void runSlashPrompt("/runner check"),
    },
    {
      title: "Switch interaction mode",
      description: "/mode companion|socratic",
      value: "research.interaction.mode",
      category: "Research",
      enabled: !!selectedTask(),
      slash: { name: "mode", aliases: ["mode-companion", "mode-socratic", "companion", "socratic"] },
      onSelect: () => void switchInteractionMode(),
    },
    {
      title: "Seed TSF baselines",
      value: "research.seed.baselines",
      category: "Research",
      enabled: !!selectedTask(),
      slash: { name: "seed", aliases: ["seed-baselines", "baselines"] },
      onSelect: () => void seedBaselines(),
    },
    {
      title: "Export final bundle",
      description: "/export bundle|report",
      value: "research.export.report",
      category: "Research",
      enabled: !!selectedTask(),
      slash: { name: "export", aliases: ["bundle", "report"] },
      onSelect: () => void exportTaskArtifact(),
    },
    {
      title: "Abort active cockpit action",
      value: "research.abort.active",
      category: "Research",
      slash: { name: "abort", aliases: ["cancel", "stop"] },
      onSelect: () => abortActiveOperation(),
    },
    {
      title: "Command help",
      value: "research.help",
      category: "Research",
      slash: { name: "help" },
      onSelect: () => appendCockpitNotice("help", "Use /help, /new, /dataset, /run, /loop, /task, /candidate, /runner, /mode, /seed, /export."),
    },
    {
      title: "Back to NeoResearch home",
      value: "research.home",
      category: "Research",
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
      hidden: true,
      onSelect: () => void createTask("review"),
    },
    {
      title: "Create TSF full-recipe review task",
      value: "research.create.review.full",
      category: "Research",
      hidden: true,
      onSelect: () => void createTask("review", { bridgeOnly: false }),
    },
    {
      title: "Create TSF review task from CSV",
      value: "research.create.review.csv",
      category: "Research",
      hidden: true,
      onSelect: () => void createCsvTask("review"),
    },
    {
      title: "Create TSF full-recipe review task from CSV",
      value: "research.create.review.csv.full",
      category: "Research",
      hidden: true,
      onSelect: () => void createCsvTask("review", { bridgeOnly: false }),
    },
    {
      title: "Create TSF autonomous task",
      value: "research.create.autonomous",
      category: "Research",
      hidden: true,
      onSelect: () => void createTask("autonomous"),
    },
    {
      title: "Create TSF full-recipe autonomous task",
      value: "research.create.autonomous.full",
      category: "Research",
      hidden: true,
      onSelect: () => void createTask("autonomous", { bridgeOnly: false }),
    },
    {
      title: "Create TSF task from CSV",
      value: "research.create.autonomous.csv",
      category: "Research",
      hidden: true,
      onSelect: () => void createCsvTask(),
    },
    {
      title: "Create TSF full-recipe task from CSV",
      value: "research.create.autonomous.csv.full",
      category: "Research",
      hidden: true,
      onSelect: () => void createCsvTask(undefined, { bridgeOnly: false }),
    },
    {
      title: "Profile research task",
      value: "research.profile.task",
      category: "Research",
      enabled: !!selectedTask(),
      hidden: true,
      onSelect: () => void profileTask(),
    },
    {
      title: "Prepare selected task dataset",
      value: "research.dataset.prepare",
      category: "Research",
      enabled: !!selectedTask(),
      hidden: true,
      onSelect: () => void prepareTaskDataset(),
    },
    {
      title: "Approve pending research candidate",
      value: "research.approve.pending",
      category: "Research",
      enabled: !!pendingApproval(),
      hidden: true,
      onSelect: () => void approvePending(),
    },
    {
      title: "Reject pending research candidate",
      value: "research.reject.pending",
      category: "Research",
      enabled: !!pendingApproval(),
      hidden: true,
      onSelect: () => void rejectPending(),
    },
    {
      title: "Run autonomous research iteration",
      value: "research.autonomous.iterate",
      category: "Research",
      enabled: selectedTask()?.mode === "autonomous" && runnerReady(),
      hidden: true,
      onSelect: () => void runAutonomousIteration(),
    },
    {
      title: "Run autonomous research loop",
      value: "research.autonomous.loop",
      category: "Research",
      enabled: canStartAutonomousLoop(),
      hidden: true,
      onSelect: () => void runAutonomousLoop(),
    },
    {
      title: "Run recommended research action",
      value: "research.next.run",
      category: "Research",
      enabled: !!selectedTask(),
      hidden: true,
      onSelect: () => void runRecommendedAction(),
    },
    {
      title: "Select next research task",
      value: "research.task.next",
      category: "Research",
      enabled: sortedTasks().length > 1,
      hidden: true,
      onSelect: () => selectTaskOffset(1),
    },
    {
      title: "Select next research candidate",
      value: "research.candidate.next",
      category: "Research",
      enabled: taskCandidates().length > 1,
      hidden: true,
      onSelect: () => selectCandidateOffset(1),
    },
    {
      title: "Select previous research candidate",
      value: "research.candidate.previous",
      category: "Research",
      enabled: taskCandidates().length > 1,
      hidden: true,
      onSelect: () => selectCandidateOffset(-1),
    },
    {
      title: "Use project as Neo-Cast runner root",
      value: "research.runner.useProject",
      category: "Research",
      enabled: !!selectedTask(),
      hidden: true,
      onSelect: () => void useProjectRunnerRoot(),
    },
    {
      title: "Edit Neo-Cast runner root",
      value: "research.runner.edit",
      category: "Research",
      enabled: !!selectedTask(),
      hidden: true,
      onSelect: () => void editRunnerRoot(),
    },
    {
      title: "Request reference test gate for selected candidate",
      value: "research.candidate.refGate",
      category: "Research",
      enabled: !!commandCandidate() && canRunResearchCockpitCandidate(commandCandidate()!),
      hidden: true,
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
      hidden: true,
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
      hidden: true,
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
      hidden: true,
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
      hidden: true,
      onSelect: () => {
        const candidate = commandCandidate()
        if (!candidate) return
        void executeCandidate(candidate, "blind_test")
      },
    },
  ])

  const succeededRuns = createMemo(
    () => taskRuns().filter((run) => run.status === "succeeded" && run.stage !== "profile").length,
  )
  const latestRun = createMemo(() => (runs() ?? [])[0])
  const streamLines = createMemo<StreamLine[]>(() => {
    const lines: StreamLine[] = []
    const ambientLines: StreamLine[] = []
    const persistentLines: StreamLine[] = []
    const run = latestRun()
    const task = selectedTask()
    if (task) {
      const candidateCount = taskCandidates().length
      const candidatePosition = candidateCount > 0 ? `${selectedCandidateIndex() + 1}/${candidateCount}` : "0/0"
      const runStatus = run ? `latest ${run.stage ?? "run"} ${run.status}` : "no run yet"
      ambientLines.push({
        id: "research-session-context",
        text: `Research Agent: 当前研究 ${task.title} / candidate ${candidatePosition} / ${runStatus}`,
        tone: "primary",
      })
    }
    const liveRunnerLines = runnerOutputLines().filter((item) => {
      if (task && item.taskID && item.taskID !== task.id) return false
      if (run && item.runID !== run.id) return false
      return true
    })
    const progressArtifact = run
      ? taskArtifacts().find((artifact) => artifact.kind === "runner_progress_jsonl" && artifact.runID === run.id)
      : undefined
    const persistedRunnerLines = Array.isArray(progressArtifact?.metadata.previewLines)
      ? progressArtifact.metadata.previewLines
          .map((item, index) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return undefined
            const record = item as JsonRecord
            if (typeof record.line !== "string") return undefined
            return {
              id: `runner-replay-${progressArtifact!.id}-${index}`,
              text: formatRunnerProgressLine({
                taskID: typeof record.taskID === "string" ? record.taskID : task?.id,
                runID: run?.id ?? "",
                line: record.line,
                event: typeof record.event === "string" ? record.event : undefined,
                epoch: typeof record.epoch === "number" ? record.epoch : undefined,
                horizon: typeof record.horizon === "number" ? record.horizon : undefined,
                valLoss: typeof record.valLoss === "number" ? record.valLoss : undefined,
                elapsedS: typeof record.elapsedS === "number" ? record.elapsedS : undefined,
              }),
              tone: record.event === "timeout" ? ("warning" as const) : ("muted" as const),
            }
          })
          .filter((item): item is { id: string; text: string; tone: "muted" | "warning" } => item !== undefined)
      : []
    if (run && (run.status !== "running" || liveRunnerLines.length === 0)) {
      for (const item of persistedRunnerLines) {
        lines.push({ id: item.id, text: item.text, tone: item.tone })
      }
    }
    if (run?.status === "running") {
      for (const item of liveRunnerLines) {
        lines.push({ id: `runner-${item.id}`, text: item.text, tone: item.tone })
      }
    }
    if (run) {
      const tone = run.status === "succeeded" ? "success" : run.status === "failed" ? "error" : "warning"
      ambientLines.push({
        id: `run-${run.id}`,
        text: runSummaryText(run),
        tone,
      })
      const failure = runFailureText(run)
      if (failure) {
        ambientLines.push({
          id: `run-${run.id}-failure`,
          text: `Failure: ${failure}`,
          tone: "error",
        })
      }
    } else {
      const clarification = socraticClarification()
      if (clarification.active) {
        persistentLines.push(
          {
            id: "socratic-clarification",
            text: `Socratic clarification: slots: ${clarification.missingSlots.join(", ") || "unknown"}`,
            tone: "warning",
          },
          {
            id: "socratic-next-question",
            text: `Next question: ${clarification.nextQuestion ?? "请确认缺失的研究意图。"}`,
            tone: "primary",
          },
          ...clarification.slots.map((slot) => ({
            id: `socratic-slot-${slot.id}`,
            text: socraticSlotLine(slot),
            tone: slot.status === "filled" ? ("success" as const) : ("warning" as const),
          })),
        )
      } else {
        const approval = pendingApproval()
        if (approval) {
          persistentLines.push(
            {
              id: "approval-requested",
              text: `Approval requested: ${approval.kind}${approval.candidateID ? ` for ${approval.candidateID}` : ""}. Type /approve to continue or /reject to stop.`,
              tone: "warning",
            },
            {
              id: "approval-reason",
              text: approval.reason,
              tone: "muted",
            },
          )
        } else {
          if (task) {
            const mode = taskInteractionMode()
            if (mode === "socratic" || mode === "companion") {
              const title = mode === "socratic" ? "Socratic" : "Companion"
              persistentLines.push(
                {
                  id: `idle-task-${mode}`,
                  text: `${title} onboarding: 先确认数据集、目标列、horizon 和指标，再开始 autonomous loop。`,
                  tone: "primary",
                },
                ...clarification.slots.map((slot) => ({
                  id: `idle-${mode}-slot-${slot.id}`,
                  text: socraticSlotLine(slot),
                  tone: slot.status === "filled" ? ("success" as const) : ("warning" as const),
                })),
              )
              if (clarification.nextQuestion) {
                persistentLines.push({
                  id: `idle-task-${mode}-next`,
                  text: `Next question: ${clarification.nextQuestion}`,
                  tone: "primary",
                })
              }
            } else {
              persistentLines.push({ id: "idle-task", text: "研究输出会在 agent 运行时显示在这里。", tone: "muted" })
            }
          } else {
            persistentLines.push({ id: "idle-empty", text: "描述一个预测目标，或创建 CSV 任务开始研究。", tone: "muted" })
          }
        }
      }
    }
    const timeline = [
      ...promptEvents().map((event) => ({ id: event.id, kind: "prompt" as const, event })),
      ...(streamingChat()?.text
        ? [{ id: streamingChat()!.id, kind: "streaming-chat" as const, event: streamingChat()! }]
        : []),
      ...(streamingChat() && !streamingChat()?.text
        ? [{ id: streamingChat()!.id, kind: "chat-loading" as const, event: streamingChat()! }]
        : []),
      ...actionEvents().map((event) => ({ id: event.id, kind: "action" as const, event })),
      ...errorEvents()
        .slice(-errorEventHistoryLimit)
        .map((event) => ({ id: event.id, kind: "error" as const, event })),
    ].sort((a, b) => a.id - b.id)
    const timelineLines: StreamLine[] = []
    for (const item of timeline) {
      if (item.kind === "prompt") {
        timelineLines.push({ id: `prompt-${item.event.id}`, text: `You: ${item.event.text}`, tone: "text" })
        if (item.event.detail) {
          timelineLines.push({ id: `prompt-detail-${item.event.id}`, text: item.event.detail, tone: "muted" })
        }
        continue
      }
      if (item.kind === "streaming-chat") {
        const proposal = parseAgentActionProposal(item.event.text)
        if (proposal) {
          timelineLines.push(
            {
              id: `streaming-chat-${item.event.id}-proposal-command`,
              text: `我建议执行：${proposal.command}`,
              tone: "primary",
            },
            {
              id: `streaming-chat-${item.event.id}-proposal-reason`,
              text: `原因：${proposal.reason || proposal.title}`,
              tone: "muted",
            },
            {
              id: `streaming-chat-${item.event.id}-proposal-confirm`,
              text: proposal.requireConfirm ? "[Enter 执行]   [Esc 取消]" : "只读建议可直接执行。",
              tone: "success",
            },
          )
          continue
        }
        const parts = compactStreamTextParts(item.event.text)
        parts.forEach((part, index) => {
          timelineLines.push({
            id: `streaming-chat-${item.event.id}-${index}`,
            text: index === 0 ? `Research Agent: ${part}` : `  ${part}`,
            tone: "primary",
          })
        })
        continue
      }
      if (item.kind === "chat-loading") {
        timelineLines.push({
          id: `chat-loading-${item.event.id}`,
          text: "Research Agent 正在生成回复...",
          tone: "primary",
          spinner: true,
        })
        continue
      }
      if (item.kind === "action") {
        if (item.event.action === "chat-status" && streamingChat()?.text) continue
        const parts = compactStreamTextParts(item.event.text)
        parts.forEach((part, index) => {
          timelineLines.push({
            id: `action-${item.event.id}-${index}`,
            text: index === 0 ? `${item.event.action === "chat-status" ? "Status" : "Research Agent"}: ${part}` : `  ${part}`,
            tone: item.event.action === "chat-status" ? "muted" : "primary",
          })
        })
        continue
      }
      timelineLines.push({ id: `error-${item.event.id}`, text: `${item.event.action}: ${item.event.text}`, tone: "error" })
    }
    lines.push(...(timelineLines.length > 0 ? [...persistentLines, ...timelineLines] : [...ambientLines, ...persistentLines]))
    return lines
  })
  const promptPlaceholder = createMemo(() => {
    if (!selectedTask()) return "询问 Research Agent，或使用 /new csv 创建带数据集的任务..."
    if (socraticClarification().active) return "回答当前 Socratic 问题..."
    if (!intentConfirmed()) return "确认需求后进入 Data Analysis，或继续补充需求..."
    if (taskInteractionMode() === "companion") return "请求建议、批准 checkpoint，或导出 bundle..."
    if (taskInteractionMode() === "socratic") return "回答下一个澄清问题、请求实验或导出..."
    return "请求下一个实验、批准 gate，或导出报告..."
  })
  const [chatMetadata] = createResource(async () => {
    try {
      const defaults = await resolveChatDefaults()
      const modelID = defaults.model.modelID
      return {
        agent: defaults.agent,
        model: defaults.modelLabel,
        modelLimit: defaults.modelLimit,
        provider: defaults.providerLabel,
      }
    } catch {
      return undefined
    }
  })
  const chatUsageEntries = createMemo(() => Object.values(chatUsageByMessage()))
  const latestChatUsage = createMemo(() => chatUsageEntries().toSorted((left, right) => left.time - right.time).at(-1))
  const chatUsageTotals = createMemo(() =>
    chatUsageEntries().reduce(
      (sum, entry) => ({
        total: sum.total + entry.total,
        input: sum.input + entry.input,
        output: sum.output + entry.output,
        reasoning: sum.reasoning + entry.reasoning,
        cacheRead: sum.cacheRead + entry.cacheRead,
        cacheWrite: sum.cacheWrite + entry.cacheWrite,
        cost: sum.cost + entry.cost,
      }),
      { total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    ),
  )
  const contextWindowLine = createMemo(() => {
    const latest = latestChatUsage()
    if (!latest) return
    const limit = chatMetadata()?.modelLimit
    if (!limit || limit <= 0) return formatTokenNumber(latest.total)
    const pct = Math.max(1, Math.round((latest.total / limit) * 100))
    return `${formatTokenNumber(latest.total)} / ${formatTokenNumber(limit)} (${pct}%)`
  })
  const sessionTokenLines = createMemo(() => {
    const totals = chatUsageTotals()
    if (totals.total <= 0) return []
    const cache = totals.cacheRead + totals.cacheWrite
    return [
      `tokens in=${formatTokenNumber(totals.input)} out=${formatTokenNumber(totals.output)}`,
      `reason=${formatTokenNumber(totals.reasoning)} cache=${formatTokenNumber(cache)}`,
      totals.cost > 0 ? `cost ${formatDollar(totals.cost)}` : undefined,
    ].filter((item): item is string => Boolean(item))
  })
  const contextModelLabel = createMemo(() => {
    const selectedModel = local?.model.current()
    if (selectedModel) return local?.model.parsed().model ?? selectedModel.modelID
    return chatMetadata()?.model ?? "-"
  })
  const contextSessionLine = createMemo(() => {
    const sessionID = chatSessionID()
    if (sessionID) return `session ${shortID(sessionID)}`
    const task = selectedTask()
    if (task) return `session ${shortID(task.id)}`
    return "session -"
  })
  const researchContextLines = createMemo(() => {
    const task = selectedTask()
    if (!task) return []
    if (chatUsageTotals().total > 0) {
      const active = busy()
      return active ? [`active ${active}`] : []
    }
    const candidateCount = taskCandidates().length
    const candidatePosition = candidateCount > 0 ? `${selectedCandidateIndex() + 1}/${candidateCount}` : "0/0"
    const lines = [
      `task ${shortID(task.id)} ${task.status}`,
      `research cand=${candidatePosition} runs=${taskRuns().length} ok=${succeededRuns()}`,
    ]
    const active = busy()
    if (active) lines.push(`active ${active}`)
    return lines
  })
  const promptMetadataText = createMemo(() => {
    const selectedModel = local?.model.current()
    if (selectedModel) return local?.model.parsed().model ?? selectedModel.modelID
    const metadata = chatMetadata()
    if (metadata?.model) return metadata.model
    return metadata?.agent ?? "Research Agent"
  })
  const hasResultArtifact = createMemo(() => taskArtifacts().some(isFinalResearchArtifact))
  const taskRequirementSummary = createMemo(() => formatTaskRequirementSummaryLines(selectedTask()))
  const profileSummary = createMemo(() => formatResearchCockpitProfile(taskFingerprint() ?? {}))
  const profileSummaryLines = createMemo(() => splitSlashSummary("Profile", profileSummary()))
  const bestMetricSummary = createMemo(() =>
    findBestResearchCockpitMetric(selectedTask()?.objective ?? {}, taskRuns(), validChampion() ?? null),
  )
  const agentWorkflowProgress = createMemo(() =>
    buildResearchCockpitAgentWorkflow({
      task: selectedTask(),
      candidates: taskCandidates(),
      runs: taskRuns(),
      artifacts: taskArtifacts(),
      approvals: taskApprovals(),
      champion: validChampion() ?? null,
      fingerprint: taskFingerprint() ?? {},
      runnerReady: runnerReady(),
      runnerRepairAction: isDatasetRepairRunnerStatus(runnerStatus()) ? "prepare_dataset" : "configure_runner",
    }),
  )
  const hasLiveRunnerProgress = createMemo(() => {
    const task = selectedTask()
    return runnerOutputLines().some((item) => !task || !item.taskID || item.taskID === task.id)
  })
  const liveResearchStage = createMemo(() => liveResearchStageForAction(busy(), hasLiveRunnerProgress()))
  const displayAgentWorkflowProgress = createMemo(() =>
    overlayLiveResearchWorkflow(agentWorkflowProgress(), liveResearchStage()),
  )
  const activeResearchAgent = createMemo(() => displayAgentWorkflowProgress().find((item) => item.status === "active"))
  const trainEvalDone = createMemo(() =>
    agentWorkflowProgress().some((item) => item.label === "TrainEval Agent" && item.status === "done"),
  )
  const reflectionDone = createMemo(() =>
    agentWorkflowProgress().some((item) => item.label === "Reflection Agent" && item.status === "done"),
  )
  const hasCandidateDesignProgress = createMemo(() => taskCandidates().length > 0)
  const hasSuccessfulExperimentProgress = createMemo(() => succeededRuns() > 0)
  const hasProfileProgress = createMemo(() =>
    taskRuns().some((run) => run.stage === "profile" && run.status === "succeeded") ||
    taskArtifacts().some((artifact) => artifact.kind === "task_profile_json" || artifact.kind === "dataset_analysis_report") ||
    (hasCandidateDesignProgress() && profileSummary() !== "-"),
  )
  const hasExplorationProgress = createMemo(() => hasCandidateDesignProgress() || hasSuccessfulExperimentProgress())
  const hasInputProgress = createMemo(() => hasProfileProgress() || hasExplorationProgress() || hasResultArtifact())
  const automaticPromptAgentLabel = createMemo(() => {
    if (hasResultArtifact()) return "Publish Agent"
    const active = activeResearchAgent()
    if (active) return active.label
    if (validChampion()) return "Publish Agent"
    if (hasExplorationProgress()) return "ModelDesigner Agent"
    if (hasProfileProgress()) return "Data Analysis Agent"
    return "Intent Agent"
  })
  const sidebarRecommendation = createMemo(() => {
    if (validChampion() && !hasResultArtifact()) {
      return {
        title: "Export final bundle",
        detail: "Package the champion, evidence, and report for review.",
      }
    }
    if (hasResultArtifact()) {
      return {
        title: "Review final bundle",
        detail: "Inspect the exported evidence or continue exploration.",
      }
    }
    return recommendation()
  })
  const sidebarVisible = createMemo(() => dimensions().width >= 100)
  const sidebarWidth = createMemo(() => {
    const width = dimensions().width
    if (width >= 170) return 48
    if (width >= 160) return 46
    if (width >= 140) return 42
    return 34
  })
  const taskLabel = createMemo(() => selectedTask()?.title ?? "No research task selected")
  const selectedTaskPosition = createMemo(() => {
    const count = sortedTasks().length
    if (count === 0) return "Task 0/0"
    return `Task ${selectedIndex() + 1}/${count}`
  })
  const candidatePosition = createMemo(() => {
    const count = taskCandidates().length
    if (count === 0) return "Candidate 0/0"
    return `Candidate ${selectedCandidateIndex() + 1}/${count}`
  })
  const taskSummary = createMemo(() => `${selectedTaskPosition()} · ${candidatePosition()}`)
  const progressState = (done: boolean, active: boolean) => (done ? "done" : active ? "active" : "todo")
  const intentProgress = createMemo(() => progressState(intentConfirmed(), Boolean(selectedTask()) && !intentConfirmed()))
  const dataProgress = createMemo(() =>
    progressState(hasProfileProgress(), Boolean(selectedTask()) && intentConfirmed() && !hasProfileProgress()),
  )
  const publishProgress = createMemo(() =>
    progressState(hasResultArtifact(), (Boolean(validChampion()) || reflectionDone()) && !hasResultArtifact()),
  )
  const researchAgentStages = createMemo<ResearchAgentStage[]>(() => [
    { key: "intent", label: "Intent Agent", status: liveResearchStage() === "intent" ? "active" : intentProgress() },
    { key: "data", label: "Data Analysis Agent", status: liveResearchStage() === "data" ? "active" : dataProgress() },
    ...displayAgentWorkflowProgress().map((item) => ({
      key: item.label,
      label: item.label,
      displayLabel: item.displayLabel,
      status: item.status,
    })),
    { key: "publish", label: "Publish Agent", status: liveResearchStage() === "publish" ? "active" : publishProgress() },
  ])
  const automaticAgentStageIndex = createMemo(() => {
    const stages = researchAgentStages()
    if (stages.length === 0) return -1
    const label = automaticPromptAgentLabel()
    const labelIndex = stages.findIndex((item) => item.label === label || item.displayLabel === label)
    if (labelIndex >= 0) return labelIndex
    const activeIndex = stages.findIndex((item) => item.status === "active")
    return activeIndex >= 0 ? activeIndex : 0
  })
  const effectiveAgentStageIndex = createMemo(() => {
    const stages = researchAgentStages()
    if (stages.length === 0) return -1
    const selected = selectedAgentStageIndex()
    if (selected === undefined) return automaticAgentStageIndex()
    return Math.max(0, Math.min(selected, stages.length - 1))
  })
  const selectedAgentStage = createMemo(() => {
    const index = effectiveAgentStageIndex()
    return index < 0 ? undefined : researchAgentStages()[index]
  })
  const promptAgentLabel = createMemo(() => selectedAgentStage()?.label ?? automaticPromptAgentLabel())

  function cycleAgentStage(offset: number) {
    const stages = researchAgentStages()
    if (!selectedTask() || stages.length === 0) return false
    const current = effectiveAgentStageIndex()
    const next = ((current + offset) % stages.length + stages.length) % stages.length
    setSelectedAgentStageIndex(next)
    promptInput?.focus()
    return true
  }

  const taskPath = createMemo(() => sdk.directory ?? process.cwd())
  const compactTaskPath = createMemo(() => compactTailPath(taskPath()))
  const runnerIssueTitle = createMemo(() => {
    const status = runnerStatus()
    if (status.reason === "missing_root" || status.reason === "missing_root_path") return "Runner root missing"
    if (status.reason === "missing_runner_script") return "Runner script missing"
    if (status.reason === "missing_python" || status.reason === "python_unavailable") return "Runner Python missing"
    if (status.reason === "unsupported_python") return "Runner Python unsupported"
    if (status.reason === "missing_runtime") return "Runner runtime missing"
    if (status.reason === "dataset_spec_mismatch") return "Runner dataset mismatch"
    return "Runner not ready"
  })
  const runnerIssueDetails = createMemo(() => runnerIssueDetailLines(runnerStatus()))
  const sidebarRecommendationDetail = createMemo(() => {
    const item = sidebarRecommendation()
    if ("action" in item && item.action === "configure_runner") return "Set runner root before runs."
    return item.detail
  })
  const statusMark = (status: "done" | "active" | "todo") => (status === "done" ? "✓" : status === "active" ? "→" : "•")
  const statusColor = (status: "done" | "active" | "todo") =>
    status === "done" ? cockpitColors.success : status === "active" ? cockpitColors.primary : cockpitColors.textMuted
  const agentStageSelected = (key: string) => selectedAgentStage()?.key === key
  const agentStageColor = (stage: Pick<ResearchAgentStage, "key" | "status">) =>
    agentStageSelected(stage.key) ? cockpitColors.primary : statusColor(stage.status)
  const agentStageText = (stage: ResearchAgentStage) => `${statusMark(stage.status)} ${stage.displayLabel ?? stage.label}`
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
              Home
            </text>
            <text fg={cockpitColors.textMuted}>/new</text>
            <text fg={cockpitColors.textMuted}>/dataset</text>
            <text fg={cockpitColors.textMuted}>/run</text>
            <text fg={cockpitColors.textMuted}>/loop</text>
            <text fg={cockpitColors.textMuted}>/export</text>
            <text fg={cockpitColors.textMuted}>/help</text>
          </box>
        </box>

        <scrollbox
          flexGrow={1}
          stickyScroll={true}
          stickyStart="bottom"
          viewportOptions={{ paddingRight: 1 }}
          verticalScrollbarOptions={{
            paddingLeft: 1,
            visible: true,
            trackOptions: {
              backgroundColor: cockpitColors.background,
              foregroundColor: cockpitColors.border,
            },
          }}
        >
          <box paddingTop={1} paddingRight={1} paddingBottom={2}>
            <For each={streamLines()}>
              {(line) =>
                line.text.startsWith("You: ") ? (
                  <box
                    backgroundColor={cockpitColors.panel}
                    border={["left"]}
                    borderColor={cockpitColors.primary}
                    paddingLeft={2}
                    paddingRight={2}
                    paddingTop={1}
                    paddingBottom={1}
                  >
                    <text fg={cockpitColors.text}>{line.text.slice(5)}</text>
                  </box>
                ) : line.spinner ? (
                  <Spinner>{line.text}</Spinner>
                ) : (
                  <text fg={streamLineColor(line.tone)}>{line.text}</text>
                )
              }
            </For>
          </box>
        </scrollbox>

        <Show when={nextBestAction()}>
          {(action) => (
            <box
              flexShrink={0}
              backgroundColor={cockpitColors.panel}
              border={["left"]}
              borderColor={cockpitColors.success}
              paddingLeft={2}
              paddingRight={2}
              paddingTop={1}
              paddingBottom={1}
              gap={0}
            >
              <text fg={cockpitColors.success} attributes={TextAttributes.BOLD} width="100%" overflow="hidden" wrapMode="none">
                {`▶ Next: ${action().title} (${action().command})`}
              </text>
              <text fg={cockpitColors.textMuted} width="100%" overflow="hidden" wrapMode="none">
                Enter 执行 · 输入其他问题可追问/跳过
              </text>
            </box>
          )}
        </Show>

        <box
          flexShrink={0}
          height={workingStatusLine() ? 6 : 5}
          backgroundColor={cockpitColors.panel}
          border={["left"]}
          borderColor={cockpitColors.primary}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
        >
          <Show when={workingStatusLine()}>
            {(line) => (
              <text
                fg={cockpitColors.warning}
                attributes={TextAttributes.BOLD}
                flexShrink={0}
                overflow="hidden"
                wrapMode="none"
              >
                {line()}
              </text>
            )}
          </Show>
          <box flexGrow={1} minHeight={0}>
            <textarea
              ref={(value: TextareaRenderable) => {
                promptInput = value
                value.traits = { status: "FORECAST" }
                value.focus()
              }}
              minHeight={1}
              maxHeight={3}
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
          </box>
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
          <box flexShrink={0} flexDirection="row" gap={1} paddingTop={1}>
            <Show when={taskInteractionMode()}>
              {(mode) => <text fg={cockpitColors.primary}>{researchInteractionModeLabel(mode())}</text>}
            </Show>
            <text fg={cockpitColors.primary}>{promptAgentLabel()}</text>
            <text fg={cockpitColors.text} flexShrink={1} overflow="hidden" wrapMode="none">
              {promptMetadataText()}
            </text>
          </box>
        </box>

        <box flexShrink={0} flexDirection="row" justifyContent="space-between">
          <text fg={busy() || chatAwaitingFirstToken() ? cockpitColors.primary : cockpitColors.textMuted}>
            esc interrupt
          </text>
          <box flexDirection="row" gap={2}>
            <text fg={cockpitColors.textMuted}>tab agents</text>
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
          paddingBottom={1}
        >
          <scrollbox
            flexGrow={1}
            stickyScroll={true}
            stickyStart="top"
            viewportOptions={{ paddingRight: 3 }}
            verticalScrollbarOptions={{
              paddingLeft: 1,
              visible: true,
              trackOptions: {
                backgroundColor: cockpitColors.sidebar,
                foregroundColor: cockpitColors.border,
              },
            }}
          >
            <box gap={1}>
              <text fg={cockpitColors.text} attributes={TextAttributes.BOLD} width="100%" overflow="hidden" wrapMode="none">
                {taskLabel()}
              </text>

              <box gap={0} paddingTop={1}>
                <text fg={cockpitColors.text} attributes={TextAttributes.BOLD}>
                  任务
                </text>
                <text fg={cockpitColors.textMuted}>{taskSummary()}</text>
              </box>

              <box gap={0} paddingTop={1}>
                <text fg={cockpitColors.text} attributes={TextAttributes.BOLD}>
                  下一步
                </text>
                <text fg={cockpitColors.primary} width="100%" overflow="hidden" wrapMode="none">
                  {sidebarRecommendation().title}
                </text>
                <text fg={cockpitColors.textMuted} width="100%" wrapMode="word">
                  {sidebarRecommendationDetail()}
                </text>
              </box>

              <box gap={0} paddingTop={1}>
                <text fg={cockpitColors.text} attributes={TextAttributes.BOLD}>
                  Runner
                </text>
                <text fg={runnerReady() ? cockpitColors.success : cockpitColors.warning}>
                  {runnerReady() ? "ready" : runnerIssueTitle()}
                </text>
                <Show when={!runnerReady()}>
                  <For each={runnerIssueDetails()}>
                    {(detail) => (
                      <text fg={cockpitColors.textMuted} width="100%" overflow="hidden" wrapMode="none">
                        {detail}
                      </text>
                    )}
                  </For>
                </Show>
                <Show when={!runnerReady() && selectedTask()}>
                  <text
                    fg={busy() ? cockpitColors.textMuted : cockpitColors.primary}
                    onMouseUp={() => {
                      if (busy()) return
                      if (isDatasetRepairRunnerStatus(runnerStatus())) {
                        void prepareTaskDataset()
                        return
                      }
                      void useProjectRunnerRoot()
                    }}
                  >
                    {isDatasetRepairRunnerStatus(runnerStatus()) ? "Prepare Dataset" : "Use Project Runner"}
                  </text>
                </Show>
              </box>

              <box gap={0} paddingTop={1}>
                <text fg={cockpitColors.text} attributes={TextAttributes.BOLD}>
                  ▾ AutoResearch进展
                </text>
                <text fg={agentStageColor(researchAgentStages()[0]!)}>
                  {agentStageText(researchAgentStages()[0]!)}
                </text>
                <For each={taskRequirementSummary()}>
                  {(summary) => (
                    <text fg={cockpitColors.textMuted} width="100%" overflow="hidden" wrapMode="none">
                      {summary}
                    </text>
                  )}
                </For>
                <text fg={agentStageColor(researchAgentStages()[1]!)}>
                  {agentStageText(researchAgentStages()[1]!)}
                </text>
                <For each={profileSummary() === "-" ? [] : profileSummaryLines()}>
                  {(summary) => (
                    <text fg={cockpitColors.textMuted} width="100%" overflow="hidden" wrapMode="none">
                      {summary}
                    </text>
                  )}
                </For>
                <For each={displayAgentWorkflowProgress()}>
                  {(item) => (
                    <text
                      fg={agentStageColor({
                        key: item.label,
                        status: item.status,
                      })}
                      width="100%"
                      overflow="hidden"
                      wrapMode="none"
                    >
                      {agentStageText({
                        key: item.label,
                        label: item.label,
                        displayLabel: item.displayLabel,
                        status: item.status,
                      })}
                    </text>
                  )}
                </For>
                <Show when={bestMetricSummary()}>
                  {(summary) => (
                    <text fg={cockpitColors.success} width="100%" overflow="hidden" wrapMode="none">
                      {summary()}
                    </text>
                  )}
                </Show>
                <text fg={agentStageColor(researchAgentStages().at(-1)!)}>
                  {agentStageText(researchAgentStages().at(-1)!)}
                </text>
              </box>

              <Show when={pendingApproval()}>
                {(approval) => (
                  <box gap={0} paddingTop={1}>
                    <text fg={cockpitColors.text} attributes={TextAttributes.BOLD}>
                      {taskInteractionMode() === "companion" ? "Companion checkpoint" : "Approval gate"}
                    </text>
                    <text fg={cockpitColors.warning}>{approval().kind} pending</text>
                    <text fg={cockpitColors.textMuted} width="100%" overflow="hidden" wrapMode="none">
                      /approve 继续 · /reject 驳回
                    </text>
                  </box>
                )}
              </Show>

              <box gap={0} paddingTop={1}>
                <text fg={cockpitColors.text} attributes={TextAttributes.BOLD}>
                  Context
                </text>
                <text fg={cockpitColors.textMuted} width="100%" overflow="hidden" wrapMode="none">
                  model {contextModelLabel()}
                </text>
                <text fg={cockpitColors.textMuted} width="100%" overflow="hidden" wrapMode="none">
                  {contextSessionLine()}
                </text>
                <For each={researchContextLines()}>
                  {(line) => (
                    <text fg={cockpitColors.textMuted} width="100%" overflow="hidden" wrapMode="none">
                      {line}
                    </text>
                  )}
                </For>
                <Show when={contextWindowLine()}>
                  {(line) => (
                    <text fg={cockpitColors.primary} width="100%" overflow="hidden" wrapMode="none">
                      {line()}
                    </text>
                  )}
                </Show>
                <For each={sessionTokenLines()}>
                  {(line) => (
                    <text fg={cockpitColors.textMuted} width="100%" overflow="hidden" wrapMode="none">
                      {line}
                    </text>
                  )}
                </For>
              </box>

              <Show when={validChampion()}>
                {(item) => (
                  <box gap={0} paddingTop={1}>
                    <text fg={cockpitColors.text} attributes={TextAttributes.BOLD}>
                      Champion
                    </text>
                    <text fg={cockpitColors.textMuted}>candidate {shortID(item().candidateID)}</text>
                    <text fg={cockpitColors.success}>metric={item().primaryMetric.toPrecision(4)}</text>
                    <text fg={cockpitColors.success}>utility={item().utility.toPrecision(4)}</text>
                  </box>
                )}
              </Show>
            </box>
          </scrollbox>

          <box flexShrink={0} paddingTop={1}>
            <text fg={cockpitColors.textMuted} width="100%" overflow="hidden" wrapMode="none">
              {compactTaskPath()}
            </text>
            <text fg={runnerReady() ? cockpitColors.success : cockpitColors.textMuted}>
              NeoResearch v{neoResearchVersion}
            </text>
          </box>
        </box>
      </Show>

    </box>
  )
}
