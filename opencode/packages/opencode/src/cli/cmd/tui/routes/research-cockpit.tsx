import { TextareaRenderable, TextAttributes, type KeyEvent } from "@opentui/core"
import { Global } from "@opencode-ai/core/global"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { appendFile, mkdir, readFile, writeFile } from "fs/promises"
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
  formatResearchCockpitCandidateRecipeLines,
  formatResearchCockpitCandidateArchitectureExpandedLines,
  formatResearchCockpitExport,
  formatResearchCockpitProfile,
  formatResearchCockpitIteration,
  formatResearchCockpitLLMDesignLines,
  formatResearchCockpitTaskAgentLLMLines,
  formatResearchCockpitLoop,
  formatResearchCockpitRefTestLines,
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
  computeResearchLLMTokenTotals,
  getLatestResearchInputTokens,
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
const researchAgentFullStageOrder = ["intent", "data", ...researchAgentWorkflowOrder, "publish"]

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

function parseBlockedErrorPayload(err: unknown): { name: string; reason: string; checkpointPhase?: string } | undefined {
  if (!(err instanceof Error)) return undefined
  try {
    const payload = JSON.parse(err.message) as unknown
    if (!isJsonRecord(payload)) return undefined
    if (payload.name !== "ResearchPipelineBlockedError") return undefined
    const data = payload.data
    if (!isJsonRecord(data) || typeof data.reason !== "string") return undefined
    return {
      name: String(payload.name),
      reason: data.reason,
      checkpointPhase: typeof data.checkpointPhase === "string" ? data.checkpointPhase : undefined,
    }
  } catch {
    return undefined
  }
}

function isHumanCheckpointRequired(err: unknown): boolean {
  const payload = parseBlockedErrorPayload(err)
  if (!payload) return false
  return (
    payload.reason === "human_checkpoint_required" || payload.reason === "reflection_requested_human_review"
  )
}

function formatCheckpointMessage(err: unknown): string {
  const blocked = parseBlockedErrorPayload(err)
  if (!blocked) return "等待 checkpoint 确认"
  if (blocked.reason === "reflection_requested_human_review") return "Reflection Agent 建议人工介入 — /approve 确认后继续发布"
  return blocked.checkpointPhase ? `等待 ${blocked.checkpointPhase} checkpoint 确认` : "等待 checkpoint 确认"
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
    if (typeof payload.name === "string" && payload.name.trim() && payload.name !== "UnknownError") {
      if (payload.name === "ResearchPipelineBlockedError" && isJsonRecord(data)) {
        const parts: string[] = [payload.name]
        if (typeof data.reason === "string") parts.push(data.reason)
        if (typeof data.checkpointPhase === "string") parts.push(`(${data.checkpointPhase})`)
        if (Array.isArray(data.missingFields) && data.missingFields.length > 0)
          parts.push(`[${data.missingFields.join(", ")}]`)
        return parts.join(": ")
      }
      return payload.name
    }
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

function shouldRefreshForRunnerProgressEvent(event: string | undefined) {
  return event === "smoke_eval_done" || event === "artifact_ready" || event === "done" || event === "timeout"
}

function overlayLiveResearchWorkflow(
  items: ResearchCockpitWorkflowItem[],
  activeLabel: string | undefined,
): ResearchCockpitWorkflowItem[] {
  return items.map((item) => {
    const status = overlayLiveResearchStageStatus(item.label, item.status, activeLabel)
    return status === item.status ? item : { ...item, status }
  })
}

function overlayLiveResearchStageStatus(
  key: string,
  fallback: ResearchAgentStageStatus,
  activeLabel: string | undefined,
): ResearchAgentStageStatus {
  const activeIndex = activeLabel ? researchAgentFullStageOrder.indexOf(activeLabel) : -1
  const stageIndex = researchAgentFullStageOrder.indexOf(key)
  if (activeIndex < 0 || stageIndex < 0) return fallback
  if (stageIndex === activeIndex) return "active"
  // Never downgrade a historically completed stage; only promote pending stages to "done".
  if (stageIndex > activeIndex) return fallback === "done" ? "done" : "todo"
  return "done"
}

function localResearchChatReply(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[!！.。?？\s]+$/g, "")
  const greetings = new Set(["hi", "hello", "hey", "你好", "您好", "嗨", "哈喽", "在吗"])
  if (!greetings.has(normalized)) return undefined
  return "你好，我在。可以直接告诉我研究目标、CSV 数据路径，或让我解释当前任务状态。"
}

function socraticSlotLine(slot: ReturnType<typeof buildSocraticClarificationState>["slots"][number]) {
  const mark = slot.status === "filled" ? "✓" : slot.status === "review" ? "◎" : "→"
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
  // baseline_comparison_verifier rejects are a soft regression signal, not a hard
  // failure worth surfacing in the cockpit — the run already shows as "rejected".
  if (value.startsWith("[baseline_comparison_verifier]")) return undefined
  return formatError(value)
}

function runDurationText(run: ResearchCockpitRun) {
  const wallClockSec = run.resourceUsage?.wallClockSec
  return typeof wallClockSec === "number" ? ` / ${wallClockSec.toPrecision(3)}s` : ""
}

function runSummaryText(run: ResearchCockpitRun) {
  return `${run.stage ?? "run"} ${run.status} / ${metricText(run.metrics)}${runDurationText(run)}`
}

function shortSeal(value: unknown, length: number) {
  return typeof value === "string" && value.length > 0 ? value.slice(0, length) : undefined
}

function reproducibilitySealText(run: ResearchCockpitRun | undefined) {
  const repro = recordValue(run?.resourceUsage?.reproducibility)
  const git = shortSeal(repro.gitSHA, 7)
  const dataset = shortSeal(repro.datasetSHA, 4)
  const code = shortSeal(repro.preprocessSHA ?? repro.codeSHA ?? repro.lockHash, 4)
  const parts = [
    git === undefined ? undefined : `g@${git}`,
    dataset === undefined ? undefined : `d@${dataset}`,
    code === undefined ? undefined : `c@${code}`,
  ].filter((item): item is string => item !== undefined)
  return parts.length === 0 ? undefined : `repro ${parts.join(" ")}`
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

function formatRunnerProgressLine(data: RunnerProgressLineEvent): string | null {
  if (data.event === "batch_progress") return null
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
  if (data.event === "candidate_resolved") {
    const candidate = progressRecordString(record, "candidate_id")
    const resolvedPath = progressRecordString(record, "resolved_candidate_path")
    return [
      "candidate resolved",
      candidate,
      resolvedPath ? compactTailPath(resolvedPath) : undefined,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" | ")
  }
  if (data.event === "resolved_candidate_ready") {
    const resolvedPath = progressRecordString(record, "resolved_candidate_path")
    return resolvedPath ? `resolved candidate ready | ${compactTailPath(resolvedPath)}` : "resolved candidate ready"
  }
  if (data.event === "horizon_done") {
    const horizon = progressRecordNumber(record, "horizon")
    const best = progressRecordNumber(record, "best_val_loss")
    const reason = progressRecordString(record, "reason")
    return [
      horizon === undefined ? "horizon done" : `horizon ${horizon} done`,
      best === undefined ? undefined : `best_val_loss ${best.toFixed(4)}`,
      reason,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" | ")
  }
  if (data.event === "artifact_ready") {
    const runID = progressRecordString(record, "run_id")
    return runID ? `artifact_ready | run ${runID}` : "artifact_ready"
  }
  if (data.event === "done") {
    const status = progressRecordString(record, "status")
    return status ? `runner done | ${status}` : "runner done"
  }
  const event = progressRecordString(record, "event")
  if (event) return event.replace(/_/g, " ")
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
// "full"-stage runs can emit far more than 30 epoch_end lines (up to 100 epochs x 4 horizons),
// so a small ring buffer evicts the early training history before Reflection/HypoPlanner even run.
const runnerOutputBufferSize = 500
// Reflection/HypoPlanner/ModelDesigner events append ~15-25 lines per autonomous-loop iteration
// with no other eviction; without a cap this grows unbounded over a long-running session and the
// streamLines() memo (which re-sorts/re-renders the whole array on every refresh) eventually
// freezes the TUI's render loop. Lines evicted from this buffer are still persisted to
// .neo-research/sessions/<taskID>/stream.log via persistResearchSessionStreamLines().
const designLLMLineBufferSize = 100
// streamLines() can still assemble 600+ rows from the design/runner buffers alone (before
// ambient/persistent/timeline lines are appended). Rendering that many rows in the scrollbox
// every refresh is what eventually freezes the TUI on long-running sessions, so cap the final
// rendered list to the most recent rows — older lines remain in stream.log for inspection.
const streamLineDisplayLimit = 100
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
  contextKey: string
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
    models?: Record<
      string,
      {
        id?: string
        name?: string
        limit?: { context?: number }
        cost?: {
          input?: number
          output?: number
          cache?: { read?: number; write?: number }
          experimentalOver200K?: {
            input?: number
            output?: number
            cache?: { read?: number; write?: number }
          }
        }
      }
    >
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
  inputCostPerMillion?: number
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

type ResearchContextEstimateInput = {
  task: ResearchCockpitTask | undefined
  candidates: ResearchCockpitCandidate[]
  runs: ResearchCockpitRun[]
  artifacts: ResearchCockpitArtifact[]
  approvals: ResearchCockpitApproval[]
  champion: ResearchCockpitChampion | null | undefined
  fingerprint: JsonRecord
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

function estimateTokenCountFromText(value: string) {
  const text = value.trim()
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

function safeJsonForTokenEstimate(value: unknown) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function estimateResearchContextTokens(input: ResearchContextEstimateInput) {
  const task = input.task
  if (!task) return 0
  const payload = {
    instructions:
      "NeoResearch TSF cockpit context: task, fingerprint, candidates, runs, artifacts, approvals, and champion.",
    task: {
      id: task.id,
      title: task.title,
      domainID: task.domainID,
      mode: task.mode,
      status: task.status,
      objective: task.objective,
      budget: task.budget,
      taskSpec: task.taskSpec,
    },
    fingerprint: input.fingerprint,
    candidates: input.candidates.slice(0, 5).map((candidate) => ({
      id: candidate.id,
      approvalStatus: candidate.approvalStatus,
      generatedBy: candidate.generatedBy,
      riskLevel: candidate.riskLevel,
      rationale: candidate.rationale,
      candidateSpec: candidate.candidateSpec,
    })),
    runs: input.runs.slice(-8).map((run) => ({
      id: run.id,
      candidateID: run.candidateID,
      stage: run.stage,
      status: run.status,
      metrics: run.metrics,
      error: run.error,
      resourceUsage: run.resourceUsage,
    })),
    artifacts: input.artifacts.slice(-8).map((artifact) => ({
      kind: artifact.kind,
      uri: artifact.uri,
      metadata: artifact.metadata,
    })),
    approvals: input.approvals.slice(-8).map((approval) => ({
      kind: approval.kind,
      status: approval.status,
      reason: approval.reason,
    })),
    champion: input.champion,
  }
  return Math.max(1, estimateTokenCountFromText(safeJsonForTokenEstimate(payload)))
}

function formatDollar(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value)
}

function formatEstimatedDollar(value: number) {
  if (value > 0 && value < 0.0001) return "<$0.0001"
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`
  return formatDollar(value)
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
  return kind.includes("final") || kind.includes("bundle")
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
  const [selectedTaskID, setSelectedTaskID] = createSignal<string>()
  const [selectedCandidateIndex, setSelectedCandidateIndex] = createSignal(0)
  const [selectedCandidateID, setSelectedCandidateID] = createSignal<string>()
  const [selectedAgentStageIndex, setSelectedAgentStageIndex] = createSignal<number>()
  const [busy, setBusy] = createSignal<string>()
  const [chatBusy, setChatBusy] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [errorEvents, setErrorEvents] = createSignal<Array<{ id: number; action: string; text: string }>>([])
  const [actionEvents, setActionEvents] = createSignal<Array<{ id: number; action: string; text: string }>>([])
  const [runnerOutputLines, setRunnerOutputLines] = createSignal<
    Array<{ id: number; taskID?: string; runID: string; text: string; tone: StreamLine["tone"] }>
  >([])
  const [designLLMLines, setDesignLLMLines] = createSignal<
    Array<{ id: number; taskID?: string; text: string; tone: StreamLine["tone"] }>
  >([])
  const [promptValue, setPromptValue] = createSignal("")
  const [csvInputErrors, setCsvInputErrors] = createSignal<string[]>([])
  // intentTurn marks an echo as belonging to the IntentAgent dialogue (a Socratic/companion
  // answer) — the [IntentAgent] block renders these inline, ordered against the agent's own
  // streamed parts via the shared streamEventID counter, instead of the bottom timeline, which
  // is what used to make the LLM's reply look disconnected from the answer that triggered it.
  const [promptEvents, setPromptEvents] = createSignal<
    Array<{ id: number; text: string; taskID?: string; detail?: string; intentTurn?: boolean }>
  >([])
  const [streamingChat, setStreamingChat] = createSignal<StreamingChatTurn>()
  const [chatSessionByContext, setChatSessionByContext] = createSignal<Record<string, string>>({})
  const [chatUsageByContext, setChatUsageByContext] = createSignal<Record<string, Record<string, ChatUsageEntry>>>({})
  const [interactionModeByTask, setInteractionModeByTask] = createSignal<Record<string, ResearchInteractionMode>>({})
  const [liveAgentEventStage, setLiveAgentEventStage] = createSignal<string | undefined>(undefined)
  const [dataAnalysisStream, setDataAnalysisStream] = createSignal<{
    id: number
    taskID?: string
    text: string
    done: boolean
  } | undefined>()
  type DaPartEntry =
    | { partID: string; kind: "text"; text: string }
    | { partID: string; kind: "tool"; toolName: string; toolInput?: Record<string, unknown>; toolOutput?: string; toolState: "pending" | "running" | "completed" | "error"; toolDurationMs?: number; toolError?: string }
  const [daPartMap, setDaPartMap] = createSignal<Map<string, DaPartEntry>>(new Map())
  const [daPartOrder, setDaPartOrder] = createSignal<string[]>([])
  let currentDaTextPartID: string | undefined
  const [hypoPlannerStream, setHypoPlannerStream] = createSignal<{
    id: number
    taskID?: string
    text: string
    done: boolean
  } | undefined>()
  type HypoPartEntry =
    | { partID: string; kind: "text"; text: string }
    | { partID: string; kind: "tool"; toolName: string; toolInput?: Record<string, unknown>; toolOutput?: string; toolState: "pending" | "running" | "completed" | "error"; toolDurationMs?: number; toolError?: string }
  const [hypoPartMap, setHypoPartMap] = createSignal<Map<string, HypoPartEntry>>(new Map())
  const [hypoPartOrder, setHypoPartOrder] = createSignal<string[]>([])
  let currentHypoTextPartID: string | undefined
  const [reflectionStream, setReflectionStream] = createSignal<{
    id: number
    taskID?: string
    text: string
    done: boolean
  } | undefined>()
  type ReflPartEntry =
    | { partID: string; kind: "text"; text: string }
    | { partID: string; kind: "tool"; toolName: string; toolInput?: Record<string, unknown>; toolOutput?: string; toolState: "pending" | "running" | "completed" | "error"; toolDurationMs?: number; toolError?: string }
  const [reflPartMap, setReflPartMap] = createSignal<Map<string, ReflPartEntry>>(new Map())
  const [reflPartOrder, setReflPartOrder] = createSignal<string[]>([])
  let currentReflTextPartID: string | undefined
  const [intentStream, setIntentStream] = createSignal<{
    id: number
    taskID?: string
    done: boolean
  } | undefined>()
  // seq stamps each part with the streamEventID counter value at first sight, so the
  // [IntentAgent] render block can interleave it against promptEvents echoes (which use the
  // same counter) in true chronological order, instead of always rendering parts before echoes.
  type IntentPartEntry =
    | { partID: string; kind: "text"; text: string; seq: number }
    | { partID: string; kind: "tool"; toolName: string; toolInput?: Record<string, unknown>; toolOutput?: string; toolState: "pending" | "running" | "completed" | "error"; toolDurationMs?: number; toolError?: string; seq: number }
  const [intentPartMap, setIntentPartMap] = createSignal<Map<string, IntentPartEntry>>(new Map())
  const [intentPartOrder, setIntentPartOrder] = createSignal<string[]>([])
  let currentIntentTextPartID: string | undefined
  // Standing "intent_confirmed approved" banner: rendered in the same slot as the pending
  // checkpoint (above DataAnalysis), not via appendDesignLLMLines — that buffer renders below
  // the DataAnalysis/HypoPlanner blocks, which would make the confirmation appear to trail
  // behind DataAnalysis instead of gating it.
  const [intentConfirmedBanner, setIntentConfirmedBanner] = createSignal<{
    id: number
    taskID?: string
    lines: string[]
  } | undefined>()
  const routedGoalsHandled = new Set<string>()
  const reportedRunIDs = new Set<string>()
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
  const sessionStreamLogQueues = new Map<string, Promise<void>>()
  // streamLines() rebuilds its array (with brand-new object literals) on every dependency
  // change, which can fire many times per second while runner epochs / LLM stream deltas
  // are flowing. solid-js's <For> reconciles by item identity, so without this cache every
  // recompute disposes and recreates the renderable for every visible line — opentui's
  // terminal renderer falls behind under that churn until the TUI freezes. Interning lines
  // by id (and pruning ids that drop out) keeps unchanged rows referentially stable so <For>
  // can skip them.
  const streamLineCache = new Map<string, StreamLine>()
  function internStreamLines(lines: StreamLine[]): StreamLine[] {
    const liveIds = new Set<string>()
    const interned = lines.map((line) => {
      liveIds.add(line.id)
      const cached = streamLineCache.get(line.id)
      if (cached && cached.text === line.text && cached.tone === line.tone && cached.spinner === line.spinner) {
        return cached
      }
      streamLineCache.set(line.id, line)
      return line
    })
    for (const id of streamLineCache.keys()) {
      if (!liveIds.has(id)) streamLineCache.delete(id)
    }
    return interned
  }

  function stopActiveApiTimer() {
    if (!activeApiTimer) return
    clearInterval(activeApiTimer)
    activeApiTimer = undefined
  }

  // Persist stream lines to .neo-research/sessions/<taskID>/stream.log so that lines evicted
  // from the in-memory ring buffers (designLLMLines/runnerOutputLines) remain available for
  // later inspection. Writes are serialized per task via a queue to avoid interleaved appends.
  function persistResearchSessionStreamLines(taskID: string | undefined, lines: Array<{ text: string }>) {
    const id = taskID ?? selectedTask()?.id
    if (!id || lines.length === 0) return
    const root = sdk.directory ?? process.cwd()
    const dir = path.join(root, ".neo-research", "sessions", id)
    const file = path.join(dir, "stream.log")
    const timestamp = new Date().toISOString()
    const content = lines.map((line) => `[${timestamp}] ${line.text}`).join("\n") + "\n"
    const prev = sessionStreamLogQueues.get(id) ?? Promise.resolve()
    const next = prev
      .then(() => mkdir(dir, { recursive: true }))
      .then(() => appendFile(file, content, "utf8"))
      .catch(() => undefined)
    sessionStreamLogQueues.set(id, next)
  }

  function appendDesignLLMLines(items: Array<{ id: number; taskID?: string; text: string; tone: StreamLine["tone"] }>) {
    if (items.length === 0) return
    persistResearchSessionStreamLines(items[0]?.taskID, items)
    setDesignLLMLines((prev) => [...prev, ...items].slice(-designLLMLineBufferSize))
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
      setDesignLLMLines([])
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
      recordChatUsage(current.contextKey, info)
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

  function recordChatUsage(contextKey: string, info: unknown) {
    const entry = chatUsageEntryFromInfo(info)
    if (!entry) return
    setChatUsageByContext((current) => ({
      ...current,
      [contextKey]: {
        ...(current[contextKey] ?? {}),
        [entry.messageID]: entry,
      },
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

  const [tasks, { mutate: mutateTasks }] = createResource(refresh, async () => {
    return researchRequest<ResearchCockpitTask[]>(sdk, "/research/tasks?limit=30")
  })

  // Makes a just-created task visible in the local list immediately, instead of waiting for
  // the next /research/tasks refetch round-trip. Without this, setSelectedTaskID(task.id) right
  // after creation races the selectedTaskID-pruning effect below (which clears selection back to
  // undefined because the new task isn't in sortedTasks() yet) — so selectedTask() resolves to
  // the wrong/stale task for the first second or two, and every live agent-stream event for the
  // new task gets dropped by the `taskID !== task.id` guards in the SSE handlers below. IntentAgent
  // is hit hardest since it kicks off immediately on creation and finishes its turn in ~1-2s.
  function registerNewTask(task: ResearchCockpitTask) {
    mutateTasks((prev) => [task, ...(prev ?? []).filter((t) => t.id !== task.id)])
  }

  const [researchLLMStatus] = createResource(refresh, async () => {
    try {
      return await researchRequest<{ status: string; provider: string; model: string; source: string }>(sdk, "/research/llm")
    } catch {
      return undefined
    }
  })

  const sortedTasks = createMemo(() => sortResearchCockpitTasks(tasks() ?? []))
  const selectedTaskIndex = createMemo(() => {
    const tasks = sortedTasks()
    if (tasks.length === 0) return 0
    const id = selectedTaskID()
    if (id) {
      const index = tasks.findIndex((task) => task.id === id)
      if (index >= 0) return index
    }
    return Math.max(0, Math.min(selectedIndex(), tasks.length - 1))
  })
  const selectedTask = createMemo(() => sortedTasks()[selectedTaskIndex()])
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
    const id = selectedTaskID()
    if (count === 0) {
      if (selectedIndex() !== 0) setSelectedIndex(0)
      setSelectedTaskID(undefined)
      return
    }
    if (id && !sortedTasks().some((task) => task.id === id)) {
      setSelectedTaskID(undefined)
    }
    const index = selectedTaskIndex()
    if (selectedIndex() !== index) {
      setSelectedIndex(index)
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
      if (text === null) return
      persistResearchSessionStreamLines(taskID, [{ text }])
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
      if (shouldRefreshForRunnerProgressEvent(eventName) && shouldRefreshResearchCockpitOnEvent(researchPayload)) {
        setRefresh((value) => value + 1)
      }
      return
    }
    if (researchPayload.type === "research.agent.llm.call_path") {
      return
    }
    if (researchPayload.type === "research.agent.dataAnalysis.started") {
      const data = researchPayload.properties as { taskID?: string } | undefined
      const taskID = data?.taskID
      const task = selectedTask()
      if (task && taskID && taskID !== task.id) return
      setLiveAgentEventStage("DataAnalysis Agent")
      setDataAnalysisStream({ id: ++streamEventID, taskID, text: "", done: false })
      setDaPartMap(new Map())
      setDaPartOrder([])
      currentDaTextPartID = undefined
      return
    }
    if (researchPayload.type === "research.agent.dataAnalysis.stream.delta") {
      const data = researchPayload.properties as { taskID?: string; delta?: string } | undefined
      const taskID = data?.taskID
      const task = selectedTask()
      if (task && taskID && taskID !== task.id) return
      const delta = data?.delta
      if (delta) {
        setDataAnalysisStream((prev) => prev ? { ...prev, text: prev.text + delta } : prev)
        if (currentDaTextPartID) {
          const pid = currentDaTextPartID
          setDaPartMap((prev) => {
            const entry = prev.get(pid)
            if (!entry || entry.kind !== "text") return prev
            const next = new Map(prev)
            next.set(pid, { ...entry, text: entry.text + delta })
            return next
          })
        }
        setRefresh((value) => value + 1)
      }
      return
    }
    if (researchPayload.type === "research.agent.dataAnalysis.part.updated") {
      const data = researchPayload.properties as {
        taskID?: string; partID?: string; kind?: string
        text?: string
        toolName?: string; toolInput?: Record<string, unknown>; toolOutput?: string
        toolState?: string; toolDurationMs?: number; toolError?: string
      } | undefined
      const taskID = data?.taskID
      const task = selectedTask()
      if (task && taskID && taskID !== task.id) return
      const partID = data?.partID
      if (!partID || !data?.kind) return
      if (data.kind === "text") {
        currentDaTextPartID = partID
        setDaPartMap((prev) => {
          const next = new Map(prev)
          const existing = prev.get(partID)
          next.set(partID, { partID, kind: "text", text: data.text ?? (existing?.kind === "text" ? existing.text : "") })
          return next
        })
        setDaPartOrder((prev) => prev.includes(partID) ? prev : [...prev, partID])
      } else if (data.kind === "tool") {
        setDaPartMap((prev) => {
          const next = new Map(prev)
          next.set(partID, {
            partID,
            kind: "tool",
            toolName: data.toolName ?? "",
            toolInput: data.toolInput,
            toolOutput: data.toolOutput,
            toolState: (data.toolState ?? "pending") as "pending" | "running" | "completed" | "error",
            toolDurationMs: data.toolDurationMs,
            toolError: data.toolError,
          })
          return next
        })
        setDaPartOrder((prev) => prev.includes(partID) ? prev : [...prev, partID])
      }
      setRefresh((value) => value + 1)
      return
    }
    if (researchPayload.type === "research.agent.hypoPlanner.started") {
      const data = researchPayload.properties as { taskID?: string } | undefined
      const taskID = data?.taskID
      const task = selectedTask()
      if (task && taskID && taskID !== task.id) return
      setLiveAgentEventStage("HypoPlanner Agent")
      setHypoPlannerStream({ id: ++streamEventID, taskID, text: "", done: false })
      setHypoPartMap(new Map())
      setHypoPartOrder([])
      currentHypoTextPartID = undefined
      return
    }
    if (researchPayload.type === "research.agent.hypoPlanner.stream.delta") {
      const data = researchPayload.properties as { taskID?: string; delta?: string } | undefined
      const taskID = data?.taskID
      const task = selectedTask()
      if (task && taskID && taskID !== task.id) return
      const delta = data?.delta
      if (delta) {
        setHypoPlannerStream((prev) => prev ? { ...prev, text: prev.text + delta } : prev)
        if (currentHypoTextPartID) {
          const pid = currentHypoTextPartID
          setHypoPartMap((prev) => {
            const entry = prev.get(pid)
            if (!entry || entry.kind !== "text") return prev
            const next = new Map(prev)
            next.set(pid, { ...entry, text: entry.text + delta })
            return next
          })
        }
        setRefresh((value) => value + 1)
      }
      return
    }
    if (researchPayload.type === "research.agent.hypoPlanner.part.updated") {
      const data = researchPayload.properties as {
        taskID?: string; partID?: string; kind?: string
        text?: string
        toolName?: string; toolInput?: Record<string, unknown>; toolOutput?: string
        toolState?: string; toolDurationMs?: number; toolError?: string
      } | undefined
      const taskID = data?.taskID
      const task = selectedTask()
      if (task && taskID && taskID !== task.id) return
      const partID = data?.partID
      if (!partID || !data?.kind) return
      if (data.kind === "text") {
        currentHypoTextPartID = partID
        setHypoPartMap((prev) => {
          const next = new Map(prev)
          const existing = prev.get(partID)
          next.set(partID, { partID, kind: "text", text: data.text ?? (existing?.kind === "text" ? existing.text : "") })
          return next
        })
        setHypoPartOrder((prev) => prev.includes(partID) ? prev : [...prev, partID])
      } else if (data.kind === "tool") {
        setHypoPartMap((prev) => {
          const next = new Map(prev)
          next.set(partID, {
            partID,
            kind: "tool",
            toolName: data.toolName ?? "",
            toolInput: data.toolInput,
            toolOutput: data.toolOutput,
            toolState: (data.toolState ?? "pending") as "pending" | "running" | "completed" | "error",
            toolDurationMs: data.toolDurationMs,
            toolError: data.toolError,
          })
          return next
        })
        setHypoPartOrder((prev) => prev.includes(partID) ? prev : [...prev, partID])
      }
      setRefresh((value) => value + 1)
      return
    }
    if (researchPayload.type === "research.agent.reflection.started") {
      const data = researchPayload.properties as { taskID?: string } | undefined
      const taskID = data?.taskID
      const task = selectedTask()
      if (task && taskID && taskID !== task.id) return
      setLiveAgentEventStage("Reflection Agent")
      setReflectionStream({ id: ++streamEventID, taskID, text: "", done: false })
      setReflPartMap(new Map())
      setReflPartOrder([])
      currentReflTextPartID = undefined
      return
    }
    if (researchPayload.type === "research.agent.reflection.stream.delta") {
      const data = researchPayload.properties as { taskID?: string; delta?: string } | undefined
      const taskID = data?.taskID
      const task = selectedTask()
      if (task && taskID && taskID !== task.id) return
      const delta = data?.delta
      if (delta) {
        setReflectionStream((prev) => prev ? { ...prev, text: prev.text + delta } : prev)
        if (currentReflTextPartID) {
          const pid = currentReflTextPartID
          setReflPartMap((prev) => {
            const entry = prev.get(pid)
            if (!entry || entry.kind !== "text") return prev
            const next = new Map(prev)
            next.set(pid, { ...entry, text: entry.text + delta })
            return next
          })
        }
        setRefresh((value) => value + 1)
      }
      return
    }
    if (researchPayload.type === "research.agent.reflection.part.updated") {
      const data = researchPayload.properties as {
        taskID?: string; partID?: string; kind?: string
        text?: string
        toolName?: string; toolInput?: Record<string, unknown>; toolOutput?: string
        toolState?: string; toolDurationMs?: number; toolError?: string
      } | undefined
      const taskID = data?.taskID
      const task = selectedTask()
      if (task && taskID && taskID !== task.id) return
      const partID = data?.partID
      if (!partID || !data?.kind) return
      if (data.kind === "text") {
        currentReflTextPartID = partID
        setReflPartMap((prev) => {
          const next = new Map(prev)
          const existing = prev.get(partID)
          next.set(partID, { partID, kind: "text", text: data.text ?? (existing?.kind === "text" ? existing.text : "") })
          return next
        })
        setReflPartOrder((prev) => prev.includes(partID) ? prev : [...prev, partID])
      } else if (data.kind === "tool") {
        setReflPartMap((prev) => {
          const next = new Map(prev)
          next.set(partID, {
            partID,
            kind: "tool",
            toolName: data.toolName ?? "",
            toolInput: data.toolInput,
            toolOutput: data.toolOutput,
            toolState: (data.toolState ?? "pending") as "pending" | "running" | "completed" | "error",
            toolDurationMs: data.toolDurationMs,
            toolError: data.toolError,
          })
          return next
        })
        setReflPartOrder((prev) => prev.includes(partID) ? prev : [...prev, partID])
      }
      setRefresh((value) => value + 1)
      return
    }
    if (researchPayload.type === "research.agent.intent.started") {
      const data = researchPayload.properties as { taskID?: string } | undefined
      const taskID = data?.taskID
      const task = selectedTask()
      if (task && taskID && taskID !== task.id) return
      setLiveAgentEventStage("Intent Agent")
      // IntentAgent is multi-turn: a new "started" event fires for every session turn (kickoff,
      // then once per user reply). Only wipe the accumulated tool-call log when this is genuinely
      // a different task — otherwise keep appending, so earlier turns in the same intent-gathering
      // conversation stay visible instead of flashing back to "等待 IntentAgent 启动..." each turn.
      const isNewTask = intentStream()?.taskID !== taskID
      setIntentStream({ id: ++streamEventID, taskID, done: false })
      if (isNewTask) {
        setIntentPartMap(new Map())
        setIntentPartOrder([])
        currentIntentTextPartID = undefined
      }
      return
    }
    if (researchPayload.type === "research.agent.intent.stream.delta") {
      const data = researchPayload.properties as { taskID?: string; delta?: string } | undefined
      const taskID = data?.taskID
      const task = selectedTask()
      if (task && taskID && taskID !== task.id) return
      const delta = data?.delta
      if (delta && currentIntentTextPartID) {
        const pid = currentIntentTextPartID
        setIntentPartMap((prev) => {
          const entry = prev.get(pid)
          if (!entry || entry.kind !== "text") return prev
          const next = new Map(prev)
          next.set(pid, { ...entry, text: entry.text + delta })
          return next
        })
        setRefresh((value) => value + 1)
      }
      return
    }
    if (researchPayload.type === "research.agent.intent.part.updated") {
      const data = researchPayload.properties as {
        taskID?: string; partID?: string; kind?: string
        text?: string
        toolName?: string; toolInput?: Record<string, unknown>; toolOutput?: string
        toolState?: string; toolDurationMs?: number; toolError?: string
      } | undefined
      const taskID = data?.taskID
      const task = selectedTask()
      if (task && taskID && taskID !== task.id) return
      const partID = data?.partID
      if (!partID || !data?.kind) return
      if (data.kind === "text") {
        currentIntentTextPartID = partID
        setIntentPartMap((prev) => {
          const next = new Map(prev)
          const existing = prev.get(partID)
          next.set(partID, {
            partID,
            kind: "text",
            text: data.text ?? (existing?.kind === "text" ? existing.text : ""),
            seq: existing?.seq ?? ++streamEventID,
          })
          return next
        })
        setIntentPartOrder((prev) => prev.includes(partID) ? prev : [...prev, partID])
      } else if (data.kind === "tool") {
        setIntentPartMap((prev) => {
          const next = new Map(prev)
          const existing = prev.get(partID)
          next.set(partID, {
            partID,
            kind: "tool",
            toolName: data.toolName ?? "",
            toolInput: data.toolInput,
            toolOutput: data.toolOutput,
            toolState: (data.toolState ?? "pending") as "pending" | "running" | "completed" | "error",
            toolDurationMs: data.toolDurationMs,
            toolError: data.toolError,
            seq: existing?.seq ?? ++streamEventID,
          })
          return next
        })
        setIntentPartOrder((prev) => prev.includes(partID) ? prev : [...prev, partID])
      }
      setRefresh((value) => value + 1)
      return
    }
    if (
      researchPayload.type === "research.agent.intent.completed" ||
      researchPayload.type === "research.agent.intent.failed"
    ) {
      const data = researchPayload.properties as { taskID?: string; metadata?: Record<string, unknown> } | undefined
      const taskID = data?.taskID
      const task = selectedTask()
      if (task && taskID && taskID !== task.id) return
      if (researchPayload.type === "research.agent.intent.failed") {
        // The session never produced any text/tool parts (no sessionID/model, or the prompt
        // call itself errored) — without this, the [IntentAgent] block just sits on its loading
        // spinner forever while a deterministic fallback question appears below it, with no clue
        // why the live turn never happened. See runIntentAgentTurn's IntentAgentFailed publishes.
        const reason = typeof data?.metadata?.reason === "string" ? data.metadata.reason : undefined
        const error = typeof data?.metadata?.error === "string" ? data.metadata.error : undefined
        const partID = `intent-failed-${++streamEventID}`
        setIntentPartMap((prev) => {
          const next = new Map(prev)
          next.set(partID, { partID, kind: "text", text: `⚠ IntentAgent 未能启动：${reason ?? error ?? "未知错误"}`, seq: ++streamEventID })
          return next
        })
        setIntentPartOrder((prev) => [...prev, partID])
      }
      setIntentStream((prev) => (prev ? { ...prev, done: true } : prev))
      setLiveAgentEventStage(undefined)
      setRefresh((value) => value + 1)
      return
    }
    if (
      researchPayload.type === "research.agent.reflection.completed" ||
      researchPayload.type === "research.agent.reflection.failed"
    ) {
      const data = researchPayload.properties as { taskID?: string; metadata?: Record<string, unknown> } | undefined
      const taskID = data?.taskID
      const task = selectedTask()
      if (task && taskID && taskID !== task.id) return
      const meta = data?.metadata ?? {}
      const newLines: Array<{ id: number; taskID?: string; text: string; tone: StreamLine["tone"] }> = []
      if (researchPayload.type === "research.agent.reflection.completed") {
        const decision = typeof meta.decision === "string" ? meta.decision : undefined
        const decisionReason = typeof meta.decisionReason === "string" ? meta.decisionReason : undefined
        const bestMetric = typeof meta.bestMetric === "number" ? meta.bestMetric : undefined
        const primaryMetricName = typeof meta.primaryMetricName === "string" ? meta.primaryMetricName : "metric"
        const plateauStreak = typeof meta.plateauStreak === "number" ? meta.plateauStreak : 0
        const hypothesisCount = typeof meta.hypothesisCount === "number" ? meta.hypothesisCount : 0
        const llmStatus = typeof meta.llmStatus === "string" ? meta.llmStatus : undefined
        const llmNarrative = typeof meta.llmNarrative === "string" ? meta.llmNarrative : undefined
        const tone: StreamLine["tone"] =
          decision === "stop" ? "success" : decision === "request_human" ? "warning" : "muted"
        const metricPart = bestMetric !== undefined ? ` best ${primaryMetricName}=${bestMetric.toFixed(4)}` : ""
        const plateauPart = plateauStreak > 0 ? ` plateau=${plateauStreak}` : ""
        newLines.push({ id: ++streamEventID, taskID, text: `[Reflection] ${decision ?? "completed"}${metricPart}${plateauPart}`, tone })
        if (decisionReason) newLines.push({ id: ++streamEventID, taskID, text: `  ${decisionReason}`, tone: "muted" })
        if (hypothesisCount > 0)
          newLines.push({
            id: ++streamEventID,
            taskID,
            text: `  ${hypothesisCount} hypothesis${hypothesisCount > 1 ? "es" : ""} for next round`,
            tone: "muted",
          })
        if (llmStatus === "used" && llmNarrative) {
          for (const part of llmNarrative.split("\n\n")) {
            const trimmed = part.trim()
            if (trimmed)
              newLines.push({ id: ++streamEventID, taskID, text: `  ${trimmed}`, tone: "muted" })
          }
        }
      } else {
        newLines.push({ id: ++streamEventID, taskID, text: "[Reflection] failed", tone: "error" })
      }
      // Flush any buffered part lines into the persistent designLLMLines
      const reflPartOrderSnap = reflPartOrder()
      const reflPartMapSnap = reflPartMap()
      if (reflPartOrderSnap.length > 0) {
        const toolStateIcon = (state: string) =>
          state === "completed" ? "✓" : state === "error" ? "✗" : state === "running" ? "●" : "○"
        for (const partID of reflPartOrderSnap) {
          const part = reflPartMapSnap.get(partID)
          if (!part) continue
          if (part.kind === "text") {
            for (const line of (part.text ?? "").split("\n").map((l: string) => l.trimEnd()).filter((l: string) => l.trim().length > 0)) {
              newLines.push({ id: ++streamEventID, taskID, text: `  ${line}`, tone: "muted" })
            }
          } else {
            const icon = toolStateIcon(part.toolState ?? "completed")
            const durationPart = part.toolDurationMs !== undefined ? ` ${part.toolDurationMs}ms` : ""
            newLines.push({ id: ++streamEventID, taskID, text: `  [${icon}] ${part.toolName}${durationPart}`, tone: "muted" })
          }
        }
      }
      setReflectionStream(undefined)
      appendDesignLLMLines(newLines)
      setLiveAgentEventStage(undefined)
      setRefresh((value) => value + 1)
      return
    }
    if (
      researchPayload.type === "research.agent.modelDesigner.completed" ||
      researchPayload.type === "research.agent.dataAnalysis.completed" ||
      researchPayload.type === "research.agent.hypoPlanner.completed"
    ) {
      const data = researchPayload.properties as { taskID?: string; metadata?: Record<string, unknown> } | undefined
      const taskID = data?.taskID
      const task = selectedTask()
      if (task && taskID && taskID !== task.id) return
      const meta = data?.metadata ?? {}
      const llmStatus = typeof meta.llmStatus === "string" ? meta.llmStatus : undefined
      const newLines: Array<{ id: number; taskID?: string; text: string; tone: StreamLine["tone"] }> = []
      if (researchPayload.type === "research.agent.modelDesigner.completed") {
        const llmModel = typeof meta.llmModel === "string" ? meta.llmModel : undefined
        const llmProvider = typeof meta.llmProvider === "string" ? meta.llmProvider : undefined
        const llmError = typeof meta.llmError === "string" ? meta.llmError : undefined
        const llmHypothesis = typeof meta.llmHypothesis === "string" ? meta.llmHypothesis : undefined
        const recipeID = typeof meta.recipeID === "string" ? meta.recipeID : undefined
        const candidateID = typeof meta.candidateID === "string" ? meta.candidateID : undefined
        const generatedBy = typeof meta.generatedBy === "string" ? meta.generatedBy : undefined
        const riskLevel = typeof meta.riskLevel === "string" ? meta.riskLevel : undefined
        const isBaseline = generatedBy === "heuristic" || (recipeID !== undefined && recipeID.includes("baseline"))
        const modelLabel = llmModel ?? llmProvider ?? "LLM"
        if (llmStatus === "used") {
          const recipePart = recipeID ? ` / ${recipeID}` : ""
          newLines.push({ id: ++streamEventID, taskID, text: `[ModelDesigner] LLM ${modelLabel} → 生成成功${recipePart}`, tone: "success" })
          if (llmHypothesis) {
            const h = llmHypothesis.length > 120 ? `${llmHypothesis.slice(0, 117)}...` : llmHypothesis
            newLines.push({ id: ++streamEventID, taskID, text: `  ${h}`, tone: "muted" })
          }
        } else if (llmStatus === "failed" || llmStatus === "invalid") {
          const errPart = llmError ? `: ${llmError.slice(0, 100)}` : ""
          newLines.push({ id: ++streamEventID, taskID, text: `[ModelDesigner] LLM ${modelLabel} → ${llmStatus}${errPart}`, tone: "error" })
        } else if (llmStatus === "not_configured") {
          newLines.push({ id: ++streamEventID, taskID, text: `[ModelDesigner] LLM not configured — heuristic candidate`, tone: "warning" })
        } else {
          const idPart = candidateID ? ` ${candidateID}` : ""
          const recipePart = recipeID ? ` / ${recipeID}` : ""
          const riskPart = riskLevel && riskLevel !== "low" ? ` [${riskLevel}]` : ""
          const baselinePart = isBaseline ? " [baseline]" : ""
          newLines.push({ id: ++streamEventID, taskID, text: `[ModelDesigner] 复用候选${idPart}${recipePart}${baselinePart}${riskPart}`, tone: "muted" })
        }
        const eventCandidateSpec =
          meta.candidateSpec !== null && typeof meta.candidateSpec === "object" && !Array.isArray(meta.candidateSpec)
            ? (meta.candidateSpec as Record<string, unknown>)
            : undefined
        const specForArch =
          eventCandidateSpec ??
          (candidateID ? taskCandidates().find((c) => c.id === candidateID)?.candidateSpec : undefined)
        if (specForArch) {
          for (const line of formatResearchCockpitCandidateArchitectureExpandedLines({ candidateSpec: specForArch })) {
            newLines.push({ id: ++streamEventID, taskID, text: line, tone: "muted" })
          }
        }
      } else if (researchPayload.type === "research.agent.dataAnalysis.completed") {
        setDataAnalysisStream((prev) => prev ? { ...prev, done: true } : prev)
        setLiveAgentEventStage(undefined)
        setRefresh((value) => value + 1)
        return
      } else if (researchPayload.type === "research.agent.hypoPlanner.completed") {
        // Push HypoPlanner result into the chronological designLLMLines so it appears
        // after Reflection output at the bottom — not above it in the fixed stream block.
        const hypoNewLines: Array<{ id: number; taskID?: string; text: string; tone: StreamLine["tone"] }> = []
        hypoNewLines.push({ id: ++streamEventID, taskID, text: "[HypoPlanner] 假设已更新", tone: "muted" })
        const partOrderSnap = hypoPartOrder()
        const partMapSnap = hypoPartMap()
        if (partOrderSnap.length > 0) {
          // Retain all LLM-generated Part content — no summary collapse
          const toolStateIcon = (state: string) =>
            state === "completed" ? "✓" : state === "error" ? "✗" : state === "running" ? "●" : "○"
          for (const partID of partOrderSnap) {
            const part = partMapSnap.get(partID)
            if (!part) continue
            if (part.kind === "text") {
              for (const line of part.text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0)) {
                hypoNewLines.push({ id: ++streamEventID, taskID, text: `  ${line}`, tone: "muted" })
              }
            } else {
              const icon = toolStateIcon(part.toolState ?? "completed")
              const durationPart = part.toolDurationMs !== undefined ? ` ${part.toolDurationMs}ms` : ""
              hypoNewLines.push({ id: ++streamEventID, taskID, text: `  [${icon}] ${part.toolName}${durationPart}`, tone: "muted" })
              if (part.toolInput && Object.keys(part.toolInput).length > 0) {
                hypoNewLines.push({ id: ++streamEventID, taskID, text: `      → ${JSON.stringify(part.toolInput).slice(0, 120)}`, tone: "muted" })
              }
              if (part.toolOutput) {
                hypoNewLines.push({ id: ++streamEventID, taskID, text: `      ← ${part.toolOutput.slice(0, 120)}`, tone: part.toolState === "error" ? "error" : "muted" })
              }
            }
          }
        }
        appendDesignLLMLines(hypoNewLines)
        setHypoPlannerStream(undefined)
        setLiveAgentEventStage(undefined)
        setRefresh((value) => value + 1)
        return
      }
      appendDesignLLMLines(newLines)
      setRefresh((value) => value + 1)
      return
    }
    if (researchPayload.type === "research.agent.publish.started") {
      const data = researchPayload.properties as { taskID?: string } | undefined
      const taskID = data?.taskID
      const task = selectedTask()
      if (task && taskID && taskID !== task.id) return
      setLiveAgentEventStage("publish")
      appendDesignLLMLines([{ id: ++streamEventID, taskID, text: "[Publish] 开始发布 — 运行冠军 ref_test 并打包模型...", tone: "muted" as const }])
      return
    }
    if (researchPayload.type === "research.agent.publish.completed") {
      const data = researchPayload.properties as { taskID?: string; metadata?: Record<string, unknown> } | undefined
      const taskID = data?.taskID
      const task = selectedTask()
      if (task && taskID && taskID !== task.id) return
      const meta = data?.metadata ?? {}
      const artifactPath = typeof meta.path === "string" ? meta.path : undefined
      const kind = typeof meta.kind === "string" ? meta.kind : undefined
      const championCandidateID = typeof meta.championCandidateID === "string" ? meta.championCandidateID : undefined
      const championPrimaryMetric = typeof meta.championPrimaryMetric === "number" ? meta.championPrimaryMetric : undefined
      const championUtility = typeof meta.championUtility === "number" ? meta.championUtility : undefined
      const recipeID = typeof meta.recipeID === "string" ? meta.recipeID : undefined
      const embeddingType = typeof meta.embeddingType === "string" ? meta.embeddingType : undefined
      const backboneType = typeof meta.backboneType === "string" ? meta.backboneType : undefined
      const refTestMetrics =
        meta.refTestMetrics !== null && typeof meta.refTestMetrics === "object" && !Array.isArray(meta.refTestMetrics)
          ? (meta.refTestMetrics as Record<string, unknown>)
          : undefined
      const newLines: Array<{ id: number; taskID?: string; text: string; tone: StreamLine["tone"] }> = []
      const metricPart = championPrimaryMetric !== undefined ? ` / val_avg_mse=${championPrimaryMetric.toFixed(4)}` : ""
      const utilityPart = championUtility !== undefined ? ` / utility=${championUtility.toFixed(3)}` : ""
      newLines.push({ id: ++streamEventID, taskID, text: `[Publish] 发布完成 / ${kind ?? "model_export_package"}${metricPart}${utilityPart}`, tone: "success" })
      if (championCandidateID) {
        const recipePart = recipeID ? ` / ${recipeID}` : ""
        newLines.push({ id: ++streamEventID, taskID, text: `  Champion: ${championCandidateID}${recipePart}`, tone: "muted" })
        const championCandidate = taskCandidates().find((c) => c.id === championCandidateID)
        if (championCandidate) {
          for (const line of formatResearchCockpitCandidateArchitectureExpandedLines(championCandidate)) {
            newLines.push({ id: ++streamEventID, taskID, text: line, tone: "muted" })
          }
        } else {
          const archParts = [embeddingType, backboneType].filter(Boolean).join("+")
          if (archParts) newLines.push({ id: ++streamEventID, taskID, text: `  Architecture: ${archParts}`, tone: "muted" })
        }
      }
      if (refTestMetrics !== undefined) {
        const avgMse = typeof refTestMetrics.ref_test_avg_mse === "number" ? refTestMetrics.ref_test_avg_mse : undefined
        const avgMae = typeof refTestMetrics.ref_test_avg_mae === "number" ? refTestMetrics.ref_test_avg_mae : undefined
        const parts = [
          avgMse !== undefined ? `ref_test_avg_mse=${avgMse.toFixed(4)}` : undefined,
          avgMae !== undefined ? `avg_mae=${avgMae.toFixed(4)}` : undefined,
        ].filter((p): p is string => p !== undefined)
        if (parts.length > 0) {
          newLines.push({ id: ++streamEventID, taskID, text: `  Test Set: ${parts.join(" / ")}`, tone: "success" })
        }
        const horizons = [96, 192, 336, 720]
        const hParts = horizons
          .map((h) => {
            const v = refTestMetrics[`ref_test_h${h}_mse`]
            return typeof v === "number" ? `h${h}=${v.toFixed(4)}` : undefined
          })
          .filter((p): p is string => p !== undefined)
        if (hParts.length > 0) {
          newLines.push({ id: ++streamEventID, taskID, text: `    Horizons: ${hParts.join(" / ")}`, tone: "muted" })
        }
      }
      if (artifactPath) newLines.push({ id: ++streamEventID, taskID, text: `  ${artifactPath}`, tone: "muted" })
      appendDesignLLMLines(newLines)
      setLiveAgentEventStage(undefined)
      setRefresh((value) => value + 1)
      return
    }
    if (researchPayload.type === "research.agent.publish.failed") {
      const data = researchPayload.properties as { taskID?: string; metadata?: Record<string, unknown> } | undefined
      const taskID = data?.taskID
      const task = selectedTask()
      if (task && taskID && taskID !== task.id) return
      const meta = data?.metadata ?? {}
      const errMsg = typeof meta.message === "string" ? meta.message : typeof meta.error === "string" ? meta.error : "unknown error"
      const refTestSkipped = meta.refTestSkipped === true
      const tone: StreamLine["tone"] = refTestSkipped ? "warning" : "error"
      const label = refTestSkipped ? "[Publish] ref_test 跳过" : "[Publish] 发布失败"
      appendDesignLLMLines([{ id: ++streamEventID, taskID, text: `${label}: ${errMsg.slice(0, 120)}`, tone }])
      setLiveAgentEventStage(undefined)
      setRefresh((value) => value + 1)
      return
    }
    if (researchPayload.type === "research.run.updated") {
      const data = researchPayload.properties as {
        run?: {
          id?: string
          taskID?: string
          stage?: string
          status?: string
          error?: string
          metrics?: Record<string, unknown>
          resourceUsage?: Record<string, unknown>
        }
      } | undefined
      const run = data?.run
      const task = selectedTask()
      if (run && task && run.taskID === task.id && run.status === "succeeded" && run.stage !== "smoke" && run.stage !== "profile") {
        const runKey = run.id ? `succeeded:${run.id}` : undefined
        if (!runKey || !reportedRunIDs.has(runKey)) {
          if (runKey) reportedRunIDs.add(runKey)
          const metrics = run.metrics ?? {}
          const valAvgMse = typeof metrics.val_avg_mse === "number" ? metrics.val_avg_mse : undefined
          const mseStr = valAvgMse !== undefined ? ` / val_avg_mse=${valAvgMse.toFixed(4)}` : ""
          const wallClock = run.resourceUsage?.wallClockSec
          const timePart = typeof wallClock === "number" ? ` / ${wallClock.toFixed(1)}s` : ""
          appendDesignLLMLines([
            { id: ++streamEventID, taskID: task.id, text: `[TrainEval ${run.stage ?? "run"}] succeeded${mseStr}${timePart}`, tone: "success" as const },
          ])
        }
      }
      if (
        run &&
        task &&
        run.taskID === task.id &&
        run.status === "failed" &&
        run.stage !== "smoke" &&
        run.stage !== "profile"
      ) {
        const runKey = run.id ? `failed:${run.id}` : undefined
        if (!runKey || !reportedRunIDs.has(runKey)) {
          if (runKey) reportedRunIDs.add(runKey)
          const errorPreview = run.error?.trim() ? formatError(run.error.trim()) : "unknown error"
          appendDesignLLMLines([
            { id: ++streamEventID, taskID: task.id, text: `[TrainEval ${run.stage}] failed: ${errorPreview}`, tone: "error" as const },
          ])
        }
      }
    }
    if (researchPayload.type === "research.checkpoint.auto_approved") {
      const data = researchPayload.properties as { taskID?: string; phase?: string; reason?: string } | undefined
      const taskID = data?.taskID
      const task = selectedTask()
      if (task && taskID && taskID !== task.id) return
      const phase = data?.phase ?? "checkpoint"
      const reasonLines = (data?.reason ?? "")
        .split("\n")
        .filter((l) => l.trim().length > 0 && !/^\[checkpoint:[^\]]+\]$/.test(l.trim()))
      appendDesignLLMLines([
        { id: ++streamEventID, taskID, text: `[Checkpoint:${phase}] ✓ auto-approved`, tone: "muted" as const },
        ...reasonLines.map((l) => ({ id: ++streamEventID, taskID, text: `  ${l}`, tone: "muted" as const })),
      ])
      setRefresh((value) => value + 1)
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
  const championRun = createMemo(() => {
    const item = validChampion()
    if (!item) return undefined
    return taskRuns().find((run) => run.id === item.runID)
  })
  const championRefTestRun = createMemo(() => {
    const item = validChampion()
    if (!item) return undefined
    return taskRuns().find(
      (r) => r.candidateID === item.candidateID && r.stage === "ref_test" && r.status === "succeeded",
    )
  })
  const reproducibilityContextLine = createMemo(() => reproducibilitySealText(championRun()))
  const selectedCandidateEffectiveIndex = createMemo(() => {
    const candidates = taskCandidates()
    if (candidates.length === 0) return 0
    const id = selectedCandidateID()
    if (id) {
      const index = candidates.findIndex((candidate) => candidate.id === id)
      if (index >= 0) return index
    }
    return Math.max(0, Math.min(selectedCandidateIndex(), candidates.length - 1))
  })
  const selectedCandidate = createMemo(() => taskCandidates()[selectedCandidateEffectiveIndex()])
  const commandCandidate = () => selectedCandidate()
  let selectedCandidateTaskID: string | undefined
  createEffect(() => {
    const taskID = selectedTask()?.id
    if (selectedCandidateTaskID !== taskID) {
      selectedCandidateTaskID = taskID
      setSelectedCandidateID(undefined)
      setSelectedCandidateIndex(0)
      return
    }
    const count = taskCandidates().length
    const id = selectedCandidateID()
    if (count === 0 && selectedCandidateIndex() !== 0) {
      setSelectedCandidateIndex(0)
      setSelectedCandidateID(undefined)
      return
    }
    if (id && !taskCandidates().some((candidate) => candidate.id === id)) {
      setSelectedCandidateID(undefined)
    }
    const index = selectedCandidateEffectiveIndex()
    if (selectedCandidateIndex() !== index) {
      setSelectedCandidateIndex(index)
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
        if (!abortController.signal.aborted && isHumanCheckpointRequired(err)) {
          const message = formatCheckpointMessage(err)
          setActionEvents((events) => [
            ...events.slice(-(promptEventHistoryLimit - 1)),
            { id: ++streamEventID, action: name, text: message },
          ])
          toast.show({ variant: "info", message })
          setRefresh((value) => value + 1)
        } else {
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
        }
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
      registerNewTask(task)
      setSelectedIndex(0)
      setSelectedTaskID(task.id)
      kickOffIntentAgent(task.id)
      return `${task.title} created`
    })
  }

  // runFullPipeline() runs the IntentAgent session first, before anything else — for a
  // brand-new task with unfilled slots it always pauses there (PipelineBlockedError,
  // "intent_clarification_required"), which is expected and not surfaced to the user; the
  // point of this call is purely the side effect of starting the session so the cockpit's
  // [IntentAgent] stream (read_taskspec / ask_user / ...) begins immediately instead of
  // waiting for some other trigger. Fire-and-forget: nothing here should block task creation.
  function kickOffIntentAgent(taskID: string) {
    // Bound maxIterations so the rare "all slots already filled" case (e.g. a fully
    // specified CSV input) can't silently run a long autonomous loop as a side effect of
    // task creation — it should still stop and let the user drive iteration from there.
    void researchRequest(sdk, `/research/tasks/${encodeURIComponent(taskID)}/pipeline`, {
      method: "POST",
      body: JSON.stringify({ stage: "smoke", maxIterations: 1 }),
    }).catch(() => undefined)
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
      // Once approved, this approval drops out of pendingApproval() and its reason stops
      // rendering via the streamLines "approval" branch — append a standing record here so
      // the checkpoint content stays visible instead of vanishing. Matches any checkpoint
      // phase (not just search_space_confirmed/final_model_selection), including
      // intent_confirmed from check_taskspec.
      const phaseMatch = approval.reason.match(/\[checkpoint:([^\]]+)\]/)
      if (status === "approved" && phaseMatch) {
        const phase = phaseMatch[1] ?? "checkpoint"
        const reasonLines = approval.reason
          .split(/\r?\n/)
          .filter((l) => l.trim().length > 0 && !/^\[checkpoint:[^\]]+\]$/.test(l.trim()))
        const taskID = selectedTask()?.id
        if (phase === "intent_confirmed") {
          // intent_confirmed gates DataAnalysis/HypoPlanner — keep its banner pinned in the
          // dedicated checkpoint slot (above those streams) instead of the designLLMLines
          // buffer, which renders below them and would make this banner appear to drift.
          setIntentConfirmedBanner({
            id: ++streamEventID,
            taskID,
            lines: [`[${phase}] approved ✓`, ...reasonLines.map((line) => `  ${line}`)],
          })
        } else {
          appendDesignLLMLines([
            { id: ++streamEventID, taskID, text: `[${phase}] approved ✓`, tone: "success" as const },
            ...reasonLines.map((line) => ({ id: ++streamEventID, taskID, text: `  ${line}`, tone: "muted" as const })),
          ])
        }
      }
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
      const reason = formatResearchCockpitIntentCheckpointReason(task)
      const approval = await researchRequest<ResearchCockpitApproval>(
        sdk,
        "/research/approvals",
        {
          method: "POST",
          body: JSON.stringify({
            taskID: task.id,
            kind: "protocol",
            reason,
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
      const reasonLines = reason
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0 && !/^\[checkpoint:[^\]]+\]$/.test(l.trim()))
      setIntentConfirmedBanner({
        id: ++streamEventID,
        taskID: task.id,
        lines: ["[intent_confirmed] approved ✓", ...reasonLines.map((line) => `  ${line}`)],
      })
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

  function currentChatContextKey() {
    return selectedTask()?.id ?? "__workspace__"
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
      inputCostPerMillion: finiteNumber(model?.cost?.input) || undefined,
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
    const contextKey = currentChatContextKey()
    const existing = chatSessionByContext()[contextKey]
    if (existing) return existing
    const session = await researchRequest<{ id: string }>(sdk, "/session", {
      method: "POST",
      body: JSON.stringify({ title: "NeoResearch Cockpit" }),
    })
    setChatSessionByContext((current) => ({
      ...current,
      [contextKey]: session.id,
    }))
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
      const contextKey = currentChatContextKey()
      const [sessionID, defaults] = await Promise.all([
        ensureChatSession(),
        resolvedDefaults ? Promise.resolve(resolvedDefaults) : resolveChatDefaults(),
      ])
      persistStreamingChat()
      setStreamingChat({ id: ++streamEventID, sessionID, contextKey, text: "", parts: [], modelLabel: defaults.modelLabel })
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

  async function runDataAnalysis() {
    const task = selectedTask()
    if (!task) return
    await runAction("data-analysis", async (signal) => {
      const result = await researchRequest<{
        nas?: { loop: ResearchCockpitLoopResult }
        publish?: ResearchCockpitExportResult
      }>(
        sdk,
        `/research/tasks/${encodeURIComponent(task.id)}/pipeline`,
        {
          method: "POST",
          body: JSON.stringify({ stage: "smoke", description: "data analysis + hypo planning", maxIterations: 3 }),
          signal,
        },
        600_000,
      )
      if (result.nas?.loop) return formatResearchCockpitLoop(result.nas.loop)
      return "data analysis pipeline completed"
    })
  }

  async function runHypoPlanning() {
    const task = selectedTask()
    if (!task) return
    await runAction("hypo-planning", async (signal) => {
      const result = await researchRequest<{
        nas?: { loop: ResearchCockpitLoopResult }
        publish?: ResearchCockpitExportResult
      }>(
        sdk,
        `/research/tasks/${encodeURIComponent(task.id)}/pipeline`,
        {
          method: "POST",
          body: JSON.stringify({ stage: "smoke", description: "hypothesis planning", maxIterations: 3 }),
          signal,
        },
        600_000,
      )
      if (result.nas?.loop) return formatResearchCockpitLoop(result.nas.loop)
      return "hypothesis planning pipeline completed"
    })
  }

  async function runPublishPipeline() {
    const task = selectedTask()
    if (!task) return
    await runAction("publish-pipeline", async (signal) => {
      const result = await researchRequest<{
        nas?: { loop: ResearchCockpitLoopResult }
        publish?: ResearchCockpitExportResult
      }>(
        sdk,
        `/research/tasks/${encodeURIComponent(task.id)}/pipeline`,
        {
          method: "POST",
          body: JSON.stringify({ stage: "full", maxIterations: 50, description: "resume pipeline: reflection & publish" }),
          signal,
        },
        600_000,
      )
      if (result.publish) return `publish completed`
      if (result.nas?.loop) return formatResearchCockpitLoop(result.nas.loop)
      return "publish pipeline completed"
    })
  }

  async function runAutonomousLoop() {
    const task = selectedTask()
    if (!task || task.mode !== "autonomous") return
    if (!intentConfirmed()) {
      await confirmIntentCheckpoint()
      return
    }
    const explicitMode =
      task.interactionMode === "companion" || task.interactionMode === "socratic"
        ? task.interactionMode
        : (() => {
            const v = (task.taskSpec as Record<string, unknown> | undefined)?.metadata
            const meta = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
            return meta.interactionMode === "companion" || meta.interactionMode === "socratic"
              ? meta.interactionMode
              : interactionModeByTask()[task.id]
          })()
    const usesPipeline = explicitMode === "companion" || explicitMode === "socratic"
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
      if (usesPipeline) {
        const result = await researchRequest<{
          nas?: { loop: ResearchCockpitLoopResult }
          publish?: ResearchCockpitExportResult
        }>(
          sdk,
          `/research/tasks/${encodeURIComponent(task.id)}/pipeline`,
          {
            method: "POST",
            body: JSON.stringify({ stage: "full", maxIterations: 50, description: "cockpit companion pipeline" }),
            signal,
          },
          600_000,
        )
        const loopMessage = result.nas?.loop ? formatResearchCockpitLoop(result.nas.loop) : "pipeline completed"
        if (preparedDataset) return `dataset prepared ${shortID(preparedDataset.artifact.id)} / ${loopMessage}`
        return loopMessage
      }
      const result = await researchRequest<ResearchCockpitLoopResult>(
        sdk,
        `/research/tasks/${encodeURIComponent(task.id)}/autonomous/loop`,
        {
          method: "POST",
          body: JSON.stringify({ stage: "full", maxIterations: 50, description: "cockpit autonomous loop" }),
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
    const tasks = sortedTasks()
    const count = tasks.length
    if (count < 2) return
    const next = (selectedTaskIndex() + offset + count) % count
    setSelectedIndex(next)
    setSelectedTaskID(tasks[next]?.id)
  }

  function selectCandidateOffset(offset: number) {
    const candidates = taskCandidates()
    const count = candidates.length
    if (count < 2) return
    const next = (selectedCandidateEffectiveIndex() + offset + count) % count
    setSelectedCandidateIndex(next)
    setSelectedCandidateID(candidates[next]?.id)
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
    if (next === "run_data_analysis") {
      await runDataAnalysis()
      return
    }
    if (next === "run_hypo_planning") {
      await runHypoPlanning()
      return
    }
    if (next === "resume_publish_pipeline") {
      await runPublishPipeline()
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
        if (index >= 0) {
          setSelectedIndex(index)
          setSelectedTaskID(sortedTasks()[index]?.id)
        } else appendCockpitNotice("task-select", `No task matched ${args[1]}.`)
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
      registerNewTask(task)
      setSelectedTaskID(task.id)
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
            body: JSON.stringify({ stage: "smoke", description: value, maxIterations: 50 }),
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
    const promptID = ++streamEventID
    // markIntentTurn flips this echo's intentTurn flag after the fact, once we know which
    // branch below actually handled it — the [IntentAgent] render block uses intentTurn to pull
    // this echo into the agent's own stream (ordered by the shared streamEventID counter)
    // instead of leaving it in the generic bottom timeline, decoupled from the question it answers.
    const markIntentTurn = () => setPromptEvents((events) => events.map((e) => (e.id === promptID ? { ...e, intentTurn: true } : e)))
    setPromptEvents((events) => [
      ...events.slice(-(promptEventHistoryLimit - 1)),
      {
        id: promptID,
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
    // Companion and socratic mode: allow slot fill when idle (task just created, pipeline not yet started).
    // Review mode: allow slot fill when idle after intent reject (intentPendingReview flag set).
    const isCompanion = interactionModeForTask(task) === "companion"
    const isSocratic = interactionModeForTask(task) === "socratic"
    const isReviewMode = clarification.reviewMode === true && task.status === "idle"
    if (isReviewMode) {
      markIntentTurn()
      // Snapshot before-state so we can diff after the LLM call
      const slotsBefore = new Map<string, string | undefined>(clarification.slots.map((s) => [s.id as string, s.value]))
      await runAction("intent-modify", async () => {
        type ModifyResult = {
          llm?: { status: string; provider?: string; model?: string; error?: string }
          intentSpec?: Record<string, unknown>
        }
        const result = await researchRequest<ModifyResult>(
          sdk,
          `/research/tasks/${encodeURIComponent(task.id)}/intent/modify`,
          { method: "POST", body: JSON.stringify({ message: value }) },
        )
        const llm: { status?: string; provider?: string; model?: string; error?: string } = result.llm ?? {}
        if (llm.status === "not_configured") return "LLM 未配置，无法解析修改意图"
        if (llm.status === "failed") return `LLM 调用失败：${llm.error ?? "未知错误"}`
        if (llm.status !== "used") return "LLM 未启用 (需设置 API key 或 NEO_RESEARCH_INTENT_LLM=1)"
        const llmTag = `[${llm.provider ?? "?"}/${llm.model ?? "?"}]`
        const spec = (result.intentSpec ?? {}) as Record<string, unknown>
        const slotLabels: Record<string, string> = {
          forecast_object: "预测对象", data_source: "数据来源", target_columns: "目标列",
          lookback_window: "lookback window", prediction_horizon: "预测 horizon",
          time_grain: "时间粒度", exogenous_variables: "外生变量", business_context: "业务背景",
          primary_metric: "主指标", secondary_metrics: "辅助指标", error_preferences: "误差偏好",
          latency_budget: "延迟预算", parameter_budget: "参数预算",
          interpretability: "可解释性", deployment_target: "部署目标",
        }
        const changes: string[] = []
        for (const [slotID, label] of Object.entries(slotLabels)) {
          const raw = spec[slotID]
          if (raw === undefined || raw === null) continue
          const after = Array.isArray(raw) ? raw.join(", ") : String(raw)
          // skip empty values (e.g. exogenous_variables=[]) — no real change to report
          if (after.trim() === "") continue
          const before = slotsBefore.get(slotID) ?? ""
          if (after !== before) changes.push(`${label} → ${after}`)
        }
        if (changes.length === 0) return `LLM ${llmTag} 调用成功，未识别到需修改的字段`
        return `LLM ${llmTag} 已更新 ${changes.length} 个字段：${changes.join(" · ")}`
      })
      promptInput?.focus()
      return
    }
    // Both companion and socratic modes: fill slots from chat input whenever idle, paused, or intent_gathering.
    // "intent_gathering" is also valid: after the first answer runIntentAgent sets this status while the
    // LLM runs; the second answer must still route to the slot-fill path, not fall through to chat.
    if (task.status === "paused" || task.status === "idle" || task.status === "intent_gathering") {
      if (clarification.active) {
        // A live IntentAgent session turn is mid-conversation (it called ask_user) — forward the
        // user's free-text reply straight into that same session so the LLM interprets it itself
        // (via update_taskspec/read_taskspec/check_taskspec) instead of guessing a single slot id
        // from the LLM's own free-form question text, which the regex-based slotFromSocraticQuestion
        // match can't reliably do. Without this, replies never reach the session, the LLM never gets
        // a chance to call check_taskspec, and the intent checkpoint never opens.
        markIntentTurn()
        try {
          await researchRequest(sdk, `/research/tasks/${encodeURIComponent(task.id)}/intent/modify`, {
            method: "POST",
            body: JSON.stringify({ message: value }),
          })
        } catch {
          // DB changes (task update, pending approval) propagate via SSE events
        }
        promptInput?.focus()
        return
      }
      if ((isCompanion || isSocratic) && clarification.nextQuestion) {
        const slotID = slotFromSocraticQuestion(clarification.nextQuestion)
        if (slotID !== "unknown") {
          markIntentTurn()
          try {
            await researchRequest(sdk, `/research/tasks/${encodeURIComponent(task.id)}/intent/answer`, {
              method: "POST",
              body: JSON.stringify({ slots: { [slotID]: value } }),
            })
          } catch {
            // DB changes (task update, pending approval) propagate via SSE events
          }
          promptInput?.focus()
          return
        }
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

  function insertSlashPrefix(prefix: string) {
    const text = prefix.trimEnd()
    promptInput?.setText(text)
    setPromptValue(text)
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

  function pushHypoPartLines(
    lines: StreamLine[],
    order: string[],
    map: Map<string, { partID: string; kind: "text" | "tool"; text?: string; toolName?: string; toolInput?: Record<string, unknown>; toolOutput?: string; toolState?: "pending" | "running" | "completed" | "error"; toolDurationMs?: number; toolError?: string }>,
    streamID: number,
    done: boolean,
  ) {
    const toolStateIcon = (state: string) =>
      state === "completed" ? "✓" : state === "error" ? "✗" : state === "running" ? "●" : "○"
    let idx = 0
    for (const partID of order) {
      const part = map.get(partID)
      if (!part) continue
      if (part.kind === "text") {
        const textLines = compactStreamTextParts(part.text ?? "")
        for (let i = 0; i < textLines.length; i++) {
          lines.push({ id: `hypo-part-${streamID}-${partID}-t${i}`, text: `  ${textLines[i]}`, tone: "muted" })
        }
        if (!done && idx === order.length - 1 && (part.text ?? "").length === 0) {
          lines.push({ id: `hypo-part-${streamID}-${partID}-loading`, text: "  ...", tone: "muted", spinner: true })
        }
      } else {
        const icon = toolStateIcon(part.toolState ?? "pending")
        const durationPart = part.toolDurationMs !== undefined ? ` ${part.toolDurationMs}ms` : ""
        lines.push({ id: `hypo-part-${streamID}-${partID}-name`, text: `  [${icon}] ${part.toolName}${durationPart}`, tone: "muted" })
        // ask_user's questions render like the "You:" reply line right below it, instead of the
        // generic JSON dump — it's the actual question the user is being asked, not tool plumbing.
        const askUserQuestions = part.toolName === "ask_user" ? part.toolInput?.questions : undefined
        if (Array.isArray(askUserQuestions) && askUserQuestions.length > 0) {
          askUserQuestions.forEach((question, qi) => {
            if (typeof question !== "string" || question.trim().length === 0) return
            lines.push({ id: `hypo-part-${streamID}-${partID}-question-${qi}`, text: `  Question: ${question}`, tone: "text" })
          })
        } else if (part.toolInput && Object.keys(part.toolInput).length > 0) {
          const inputStr = JSON.stringify(part.toolInput).slice(0, 120)
          lines.push({ id: `hypo-part-${streamID}-${partID}-input`, text: `      → ${inputStr}`, tone: "muted" })
        }
        if (part.toolOutput) {
          const outputStr = part.toolOutput.slice(0, 120)
          lines.push({ id: `hypo-part-${streamID}-${partID}-output`, text: `      ← ${outputStr}`, tone: part.toolState === "error" ? "error" : "muted" })
        }
        if (!done && part.toolState === "running") {
          lines.push({ id: `hypo-part-${streamID}-${partID}-spinner`, text: `      ...`, tone: "muted", spinner: true })
        }
      }
      idx++
    }
    if (!done && order.length === 0) {
      lines.push({ id: `hypo-part-${streamID}-loading`, text: "  ...", tone: "muted", spinner: true })
    }
  }

  // Interleaves the IntentAgent's streamed parts with the user's own answer echoes, ordered by
  // the shared streamEventID counter (part.seq / echo.id), so a question → answer → next-LLM-turn
  // exchange renders as one continuous conversation instead of the answer always trailing behind
  // in the unrelated bottom timeline. Echoes run through pushHypoPartLines in same-seq batches
  // (done=true for every batch but the last) so tool/text formatting stays identical to the other
  // agent streams.
  function pushIntentAgentLines(
    lines: StreamLine[],
    order: string[],
    map: Map<string, IntentPartEntry>,
    echoes: Array<{ id: number; text: string }>,
    streamID: number,
    done: boolean,
  ) {
    const merged = [
      ...order.map((partID) => ({ seq: map.get(partID)?.seq ?? 0, kind: "part" as const, partID })),
      ...echoes.map((echo) => ({ seq: echo.id, kind: "echo" as const, echo })),
    ].sort((a, b) => a.seq - b.seq)
    let batch: string[] = []
    for (const item of merged) {
      if (item.kind === "part") {
        batch.push(item.partID)
        continue
      }
      pushHypoPartLines(lines, batch, map, streamID, true)
      batch = []
      lines.push({ id: `intent-echo-${item.echo.id}`, text: `  You: ${item.echo.text}`, tone: "text" })
    }
    pushHypoPartLines(lines, batch, map, streamID, done)
  }

  const streamLines = createMemo<StreamLine[]>(() => {
    const lines: StreamLine[] = []
    const ambientLines: StreamLine[] = []
    const persistentLines: StreamLine[] = []
    const run = latestRun()
    const task = selectedTask()
    if (task) {
      // The live DataAnalysis stream below renders the full agent output for this task and is
      // never cleared (only marked done) — once that artifact exists, its truncated
      // "[DataAnalysis]" preview here would just duplicate it, so skip the preview while that
      // live stream is present.
      const daStreamForDedupe = dataAnalysisStream()
      const hasLiveDaStream = !!daStreamForDedupe && (!task || !daStreamForDedupe.taskID || daStreamForDedupe.taskID === task.id)
      for (const item of formatResearchCockpitTaskAgentLLMLines(taskArtifacts())) {
        if (hasLiveDaStream && item.id.startsWith("llm-data-")) continue
        ambientLines.push({ id: item.id, text: item.text, tone: item.tone })
      }
      const champ = validChampion()
      const refTestRun = championRefTestRun()
      if (champ && refTestRun) {
        for (const item of formatResearchCockpitRefTestLines(champ, refTestRun)) {
          ambientLines.push({ id: item.id, text: item.text, tone: item.tone })
        }
      }
    }
    // Keep all task-scoped runner lines (not filtered to latest run ID) so that epoch output
    // from a just-completed run doesn't vanish the moment the next iteration starts.
    // The merge-by-id logic places them correctly since runner IDs are lower than the next
    // iteration's ModelDesigner ID (both use the same streamEventID counter).
    const liveRunnerLines = runnerOutputLines().filter((item) => {
      if (task && item.taskID && item.taskID !== task.id) return false
      return true
    })
    const liveDesignLines = designLLMLines().filter((item) => !task || !item.taskID || item.taskID === task.id)
    // IntentAgent stream: rendered unconditionally (like DataAnalysis/HypoPlanner/Reflection
    // below) so its tool-call log stays on screen after the agent finishes, instead of vanishing
    // once clarification.active flips to false or a run starts.
    // Intent checkpoint (clarification question, review-mode rejection, or the
    // intent_confirmed approval gate) renders immediately below the IntentAgent log and above
    // DataAnalysis — it gates DataAnalysis, so it must never appear to trail behind it.
    const clarification = socraticClarification()
    const approval = pendingApproval()
    const isIntentCheckpointPending = !!approval && /\[checkpoint:intent_confirmed\]/.test(approval.reason)
    const istreamPersistent = intentStream()
    const istreamForTask = istreamPersistent && (!task || !istreamPersistent.taskID || istreamPersistent.taskID === task.id)
    const intentPartMapSnap = intentPartMap()
    const intentPartOrderSnap = intentPartOrder()
    const hasLiveAskUserPart =
      !!istreamForTask &&
      intentPartOrderSnap.some((partID) => {
        const part = intentPartMapSnap.get(partID)
        return part?.kind === "tool" && part.toolName === "ask_user"
      })
    if (istreamForTask) {
      lines.push({ id: `intent-stream-${istreamPersistent.id}-header`, text: "[IntentAgent]", tone: "muted" })
      const intentEchoes = promptEvents()
        .filter((event) => event.intentTurn && (!event.taskID || event.taskID === istreamPersistent.taskID))
        .map((event) => ({ id: event.id, text: event.text }))
      // The live IntentAgent session log (read_taskspec / ask_user / update_taskspec calls) is
      // rendered unconditionally here — it replaces the old static 15-slot dump. See
      // specs/research/intent-agent-tui-streaming.md §3.5. The ask_user tool call's own
      // "Question: ..." lines (rendered inside pushHypoPartLines) cover the clarification
      // question, right below the tool call and above the user's "You: ..." reply.
      pushIntentAgentLines(lines, intentPartOrderSnap, intentPartMapSnap, intentEchoes, istreamPersistent.id, istreamPersistent.done)
    }
    if (clarification.active) {
      if (clarification.reviewMode) {
        lines.push(
          {
            id: "intent-review-header",
            text: "Intent 已驳回 — 请描述你想修改的内容，LLM 会识别并更新对应字段；确认无误后输入 /confirm 继续",
            tone: "warning",
          },
          ...clarification.slots.map((slot) => ({
            id: `review-slot-${slot.id}`,
            text: socraticSlotLine(slot),
            tone: slot.status === "filled" ? ("success" as const) : ("muted" as const),
          })),
        )
      } else if (!hasLiveAskUserPart) {
        // No live ask_user tool call to anchor the question to yet (e.g. a paused task restored
        // from the approval/poll state instead of a live SSE turn, or the IntentAgent is still
        // mid-turn before calling ask_user) — render it standalone until the real tool call lands.
        lines.push({
          id: "socratic-next-question",
          text: `Question: ${clarification.nextQuestion ?? "请确认缺失的研究意图。"}`,
          tone: "text",
        })
      }
    } else if (isIntentCheckpointPending) {
      const intentReasonLines = approval.reason
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0 && !/^\[checkpoint:[^\]]+\]$/.test(l.trim()))
      lines.push(
        {
          id: "approval-requested",
          text: `Approval requested: ${approval.kind}${approval.candidateID ? ` for ${approval.candidateID}` : ""}. Type /approve to continue or /reject to stop.`,
          tone: "warning",
        },
        ...intentReasonLines.map((line, i) => ({
          id: `approval-reason-${i}`,
          text: line,
          tone: "muted" as const,
        })),
      )
    } else {
      // Once the checkpoint is confirmed, isIntentCheckpointPending flips false — render the
      // standing "approved" banner in this same slot so it never drifts relative to
      // DataAnalysis/HypoPlanner below (see intentConfirmedBanner setters in
      // confirmIntentCheckpoint/replyPendingApproval).
      const confirmedBanner = intentConfirmedBanner()
      if (confirmedBanner && (!task || !confirmedBanner.taskID || confirmedBanner.taskID === task.id)) {
        confirmedBanner.lines.forEach((line, i) => {
          lines.push({
            id: `intent-confirmed-banner-${confirmedBanner.id}-${i}`,
            text: line,
            tone: i === 0 ? "success" : "muted",
          })
        })
      }
    }
    const daStream = dataAnalysisStream()
    const daPartOrderSnap = daPartOrder()
    const daPartMapSnap = daPartMap()
    if (daStream && (!task || !daStream.taskID || daStream.taskID === task.id)) {
      lines.push({ id: `da-stream-${daStream.id}-header`, text: `[DataAnalysis]`, tone: "muted" })
      if (daPartOrderSnap.length > 0) {
        pushHypoPartLines(lines, daPartOrderSnap, daPartMapSnap, daStream.id, daStream.done)
      } else {
        const daLines = compactStreamTextParts(daStream.text)
        for (let i = 0; i < daLines.length; i++) {
          lines.push({ id: `da-stream-${daStream.id}-${i}`, text: `  ${daLines[i]}`, tone: "muted" })
        }
        if (!daStream.done) {
          lines.push({ id: `da-stream-${daStream.id}-loading`, text: "  ...", tone: "muted", spinner: true })
        }
      }
    }
    // Initial-phase HypoPlanner (before any training): render alongside DA stream, before design lines.
    const hypoStream = hypoPlannerStream()
    const hypoPartOrderSnap = hypoPartOrder()
    const hypoPartMapSnap = hypoPartMap()
    const hasCompletedTrainingRuns = taskRuns().some(
      (r) =>
        (r.stage === "low_fidelity" || r.stage === "full" || r.stage === "ref_test" || r.stage === "blind_test") &&
        (r.status === "succeeded" || r.status === "failed"),
    )
    if (hypoStream && !hasCompletedTrainingRuns && (!task || !hypoStream.taskID || hypoStream.taskID === task.id)) {
      lines.push({ id: `hypo-stream-${hypoStream.id}-header`, text: `[HypoPlanner]`, tone: "muted" })
      if (hypoPartOrderSnap.length > 0) {
        pushHypoPartLines(lines, hypoPartOrderSnap, hypoPartMapSnap, hypoStream.id, hypoStream.done)
      } else {
        const hypoLines = compactStreamTextParts(hypoStream.text)
        for (let i = 0; i < hypoLines.length; i++) {
          lines.push({ id: `hypo-stream-${hypoStream.id}-${i}`, text: `  ${hypoLines[i]}`, tone: "muted" })
        }
        if (!hypoStream.done) {
          lines.push({ id: `hypo-stream-${hypoStream.id}-loading`, text: "  ...", tone: "muted", spinner: true })
        }
      }
    }
    const traceArtifact = run
      ? taskArtifacts().find((artifact) => artifact.kind === "research_manager_trace_json" && artifact.runID === run.id)
      : undefined
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
          .filter((item): item is { id: string; text: string; tone: "muted" | "warning" } => item !== undefined && item.text !== null)
      : []
    const isFinalModelSelectionPending =
      !!approval && /\[checkpoint:final_model_selection\]/.test(approval.reason)
    // Merge design events and live runner epochs into one chronological stream.
    // Both designLLMLines and runnerOutputLines share the same streamEventID counter,
    // so sorting by numeric id faithfully interleaves ModelDesigner → epochs → Reflection → HypoPlanner.
    const hasLiveRunnerData = liveRunnerLines.length > 0 && !isFinalModelSelectionPending
    if (hasLiveRunnerData) {
      const merged = [
        ...liveDesignLines.map((item) => ({ sortId: item.id, id: `design-${item.id}`, text: item.text, tone: item.tone })),
        ...liveRunnerLines.map((item) => ({ sortId: item.id, id: `runner-${item.id}`, text: item.text, tone: item.tone })),
      ].sort((a, b) => a.sortId - b.sortId)
      for (const item of merged) {
        lines.push({ id: item.id, text: item.text, tone: item.tone })
      }
    } else {
      // No live runner data: design lines in order, then persisted runner lines as epoch fallback
      for (const item of liveDesignLines) {
        lines.push({ id: `design-${item.id}`, text: item.text, tone: item.tone })
      }
      if (liveDesignLines.length === 0) {
        for (const item of formatResearchCockpitLLMDesignLines(traceArtifact)) {
          lines.push({ id: item.id, text: item.text, tone: item.tone })
        }
      }
      if (run && !isFinalModelSelectionPending) {
        for (const item of persistedRunnerLines) {
          lines.push({ id: item.id, text: item.text, tone: item.tone })
        }
      }
    }
    // Reflection stream (fires after runner epochs, before HypoPlanner): tool-call progress display.
    const reflStream = reflectionStream()
    const reflPartOrderSnap = reflPartOrder()
    const reflPartMapSnap = reflPartMap()
    if (reflStream && (!task || !reflStream.taskID || reflStream.taskID === task.id)) {
      lines.push({ id: `refl-stream-${reflStream.id}-header`, text: `[Reflection]`, tone: "muted" })
      if (reflPartOrderSnap.length > 0) {
        pushHypoPartLines(lines, reflPartOrderSnap, reflPartMapSnap, reflStream.id, reflStream.done)
      } else {
        const reflLines = compactStreamTextParts(reflStream.text)
        for (let i = 0; i < reflLines.length; i++) {
          lines.push({ id: `refl-stream-${reflStream.id}-${i}`, text: `  ${reflLines[i]}`, tone: "muted" })
        }
        if (!reflStream.done) {
          lines.push({ id: `refl-stream-${reflStream.id}-loading`, text: "  ...", tone: "muted", spinner: true })
        }
      }
    }
    // Active HypoPlanner stream (fires after Reflection, between iterations): appears at the bottom
    if (hypoStream && hasCompletedTrainingRuns && (!task || !hypoStream.taskID || hypoStream.taskID === task.id)) {
      lines.push({ id: `hypo-stream-${hypoStream.id}-header`, text: `[HypoPlanner]`, tone: "muted" })
      if (hypoPartOrderSnap.length > 0) {
        pushHypoPartLines(lines, hypoPartOrderSnap, hypoPartMapSnap, hypoStream.id, hypoStream.done)
      } else {
        const hypoLines = compactStreamTextParts(hypoStream.text)
        for (let i = 0; i < hypoLines.length; i++) {
          lines.push({ id: `hypo-stream-${hypoStream.id}-${i}`, text: `  ${hypoLines[i]}`, tone: "muted" })
        }
        if (!hypoStream.done) {
          lines.push({ id: `hypo-stream-${hypoStream.id}-loading`, text: "  ...", tone: "muted", spinner: true })
        }
      }
    }
    // The "profile" stage is the dataset-profiling run that backs DataAnalysis, not a model
    // candidate run — every other run-count/summary helper already excludes it (see
    // succeededRuns(), hasSucceededRun, etc.), so showing "profile succeeded" here would just be
    // noise alongside the DataAnalysis stream above.
    if (run && run.stage !== "profile") {
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
    }
    // The intent checkpoint (clarification.active, or the intent_confirmed approval) is already
    // rendered right after the IntentAgent stream, above DataAnalysis — see isIntentCheckpointPending.
    if (!clarification.active && approval && !isIntentCheckpointPending) {
      // Show checkpoint/approval reason regardless of run state — checkpoints like
      // final_model_selection fire after NAS runs exist, so the old !run gate hid them.
      const reasonLines = approval.reason
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0 && !/^\[checkpoint:[^\]]+\]$/.test(l.trim()))
      persistentLines.push(
        {
          id: "approval-requested",
          text: `Approval requested: ${approval.kind}${approval.candidateID ? ` for ${approval.candidateID}` : ""}. Type /approve to continue or /reject to stop.`,
          tone: "warning",
        },
        ...reasonLines.map((line, i) => ({
          id: `approval-reason-${i}`,
          text: line,
          tone: "muted" as const,
        })),
      )
    } else if (!clarification.active && !isIntentCheckpointPending && !run) {
      if (task) {
        const mode = taskInteractionMode()
        if (mode === "socratic" || mode === "companion") {
          // The live IntentAgent log (same as the clarification.active branch) is rendered
          // unconditionally above, in the istreamPersistent block — the task may already be
          // running its first intent-gathering turn (reading the dataset, reading the taskspec)
          // before any ask_user checkpoint exists, so clarification.active is still false here.
          if (!istreamPersistent) {
            persistentLines.push({ id: `idle-task-${mode}-waiting`, text: "等待 IntentAgent 启动...", tone: "muted", spinner: true })
          }
        } else {
          persistentLines.push(
            { id: "idle-task", text: "研究输出会在 agent 运行时显示在这里。", tone: "muted" },
            {
              id: "idle-task-hint",
              text: "提示：点击顶栏 /loop 启动自主搜索，或 /run baseline 跑一个手动候选。",
              tone: "muted",
            },
          )
        }
      } else {
        persistentLines.push(
          { id: "idle-empty", text: "描述一个预测目标，或创建 CSV 任务开始研究。", tone: "muted" },
          { id: "idle-empty-hint", text: "提示：点击顶栏 /new 创建任务，或输入 /help 查看所有命令。", tone: "muted" },
        )
      }
    }
    const timeline = [
      // intentTurn echoes already render inline inside the [IntentAgent] block above
      // (pushIntentAgentLines) — keeping them here too would show the answer twice.
      ...promptEvents()
        .filter((event) => !event.intentTurn)
        .map((event) => ({ id: event.id, kind: "prompt" as const, event })),
      ...(streamingChat()?.text
        ? [{ id: streamingChat()!.id, kind: "streaming-chat" as const, event: streamingChat()! }]
        : []),
      ...(streamingChat() && !streamingChat()?.text
        ? [{ id: streamingChat()!.id, kind: "chat-loading" as const, event: streamingChat()! }]
        : []),
      // Most actionEvents (task created / pipeline ran / export done / seed-baselines / etc.)
      // are one-off operation confirmations already surfaced via toast.show() in runAction —
      // echoing them again here as "Research Agent: X created" was just feed noise alongside
      // the actual AskUser/clarification dialogue. Two kinds are kept: chat-flavored actions
      // ("chat"/"chat-status" are runChatAction's own success messages including local replies
      // that never touch streamingChat, "chat-stream"/"action-proposal" are persistStreamingChat's
      // archive of a just-finished streamingChat turn — without these the conversation itself,
      // not just a status ping, would disappear once the next turn starts) and "shortcut" (direct
      // feedback for a removed keybind the user just pressed, not an agent status update).
      ...actionEvents()
        .filter((event) =>
          event.action === "chat" ||
          event.action === "chat-status" ||
          event.action === "chat-stream" ||
          event.action === "action-proposal" ||
          event.action === "shortcut",
        )
        .map((event) => ({ id: event.id, kind: "action" as const, event })),
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
    return internStreamLines(lines.slice(-streamLineDisplayLimit))
  })
  const promptPlaceholder = createMemo(() => {
    if (!selectedTask()) return "询问 Research Agent，或使用 /new csv 创建带数据集的任务..."
    if (socraticClarification().reviewMode) return "描述你想修改的内容（LLM 自动识别字段），或输入 /confirm 确认..."
    if (socraticClarification().active) return "回答当前 Socratic 问题..."
    if (!intentConfirmed()) return "确认需求后进入 Data Analysis，或继续补充需求..."
    if (taskInteractionMode() === "companion") return "请求建议、批准 checkpoint，或导出 bundle..."
    if (taskInteractionMode() === "socratic") return "回答下一个澄清问题、请求实验或导出..."
    return "请求下一个实验、批准 gate，或导出报告..."
  })
  const chatMetadataSource = createMemo(() => currentChatDefaultsKey())
  const [chatMetadata] = createResource(chatMetadataSource, async () => {
    try {
      const defaults = await resolveChatDefaults()
      const modelID = defaults.model.modelID
      return {
        agent: defaults.agent,
        model: defaults.modelLabel,
        modelLimit: defaults.modelLimit,
        inputCostPerMillion: defaults.inputCostPerMillion,
        provider: defaults.providerLabel,
      }
    } catch {
      return undefined
    }
  })
  const chatUsageEntries = createMemo(() => Object.values(chatUsageByContext()[currentChatContextKey()] ?? {}))
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
  const estimatedResearchContextTokenCount = createMemo(() =>
    estimateResearchContextTokens({
      task: selectedTask(),
      candidates: taskCandidates(),
      runs: taskRuns(),
      artifacts: taskArtifacts(),
      approvals: taskApprovals(),
      champion: validChampion() ?? null,
      fingerprint: taskFingerprint() ?? {},
    }),
  )
  const latestResearchInputTokens = createMemo(() => getLatestResearchInputTokens(taskArtifacts()))
  const estimatedResearchContextCost = createMemo(() => {
    const tokens = estimatedResearchContextTokenCount()
    const inputCostPerMillion = chatMetadata()?.inputCostPerMillion
    if (tokens <= 0 || !inputCostPerMillion || inputCostPerMillion <= 0) return undefined
    return (tokens * inputCostPerMillion) / 1_000_000
  })
  const estimatedContextSuffix = createMemo(() => {
    const cost = estimatedResearchContextCost()
    return cost && cost > 0 ? `(research est. ${formatEstimatedDollar(cost)})` : "(research est.)"
  })
  const contextWindowLine = createMemo(() => {
    const latest = latestChatUsage()
    const limit = chatMetadata()?.modelLimit
    if (!latest) {
      const realTokens = latestResearchInputTokens()
      if (realTokens > 0) {
        if (!limit || limit <= 0) return formatTokenNumber(realTokens)
        const pct = Math.max(1, Math.round((realTokens / limit) * 100))
        return `${formatTokenNumber(realTokens)} / ${formatTokenNumber(limit)} (${pct}%)`
      }
      const estimated = estimatedResearchContextTokenCount()
      if (estimated > 0) {
        if (!limit || limit <= 0) return `~${formatTokenNumber(estimated)} ${estimatedContextSuffix()}`
        return `~${formatTokenNumber(estimated)} / ${formatTokenNumber(limit)} ${estimatedContextSuffix()}`
      }
      if (!limit || limit <= 0) return undefined
      return `0 / ${formatTokenNumber(limit)}`
    }
    if (!limit || limit <= 0) return formatTokenNumber(latest.total)
    const pct = Math.max(1, Math.round((latest.total / limit) * 100))
    return `${formatTokenNumber(latest.total)} / ${formatTokenNumber(limit)} (${pct}%)`
  })
  const sessionTokenLines = createMemo(() => {
    const chat = chatUsageTotals()
    const research = computeResearchLLMTokenTotals(taskArtifacts())
    const lines: string[] = []
    if (chat.total > 0) {
      const cache = chat.cacheRead + chat.cacheWrite
      lines.push(`tokens in=${formatTokenNumber(chat.input)} out=${formatTokenNumber(chat.output)}`)
      lines.push(`reason=${formatTokenNumber(chat.reasoning)} cache=${formatTokenNumber(cache)}`)
      if (chat.cost > 0) lines.push(`cost ${formatDollar(chat.cost)}`)
    }
    if (research.inputTokens > 0 || research.outputTokens > 0) {
      const cache = research.cacheReadTokens + research.cacheWriteTokens
      lines.push(`research in=${formatTokenNumber(research.inputTokens)} out=${formatTokenNumber(research.outputTokens)}${cache > 0 ? ` cache=${formatTokenNumber(cache)}` : ""}`)
    }
    return lines
  })
  const contextModelLabel = createMemo(() => {
    const selectedModel = local?.model.current()
    if (selectedModel) return local?.model.parsed().model ?? selectedModel.modelID
    return chatMetadata()?.model ?? "-"
  })
  const contextSessionLine = createMemo(() => {
    const sessionID = chatSessionByContext()[currentChatContextKey()]
    if (sessionID) return `session ${shortID(sessionID)}`
    const task = selectedTask()
    if (task) return `session ${shortID(task.id)}`
    return "session -"
  })
  const researchContextLines = createMemo(() => {
    const task = selectedTask()
    if (!task) return []
    const candidateCount = taskCandidates().length
    const candidatePosition = candidateCount > 0 ? `${selectedCandidateEffectiveIndex() + 1}/${candidateCount}` : "0/0"
    const researchLine = `research cand=${candidatePosition} runs=${taskRuns().length} ok=${succeededRuns()}`
    const active = busy()
    if (chatUsageTotals().total > 0 || estimatedResearchContextTokenCount() > 0) {
      return active ? [researchLine, `active ${active}`] : [researchLine]
    }
    const lines = [
      `task ${shortID(task.id)} ${task.status}`,
      researchLine,
    ]
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
  const liveResearchStage = createMemo(() => {
    const action = busy()
    if (!action) return undefined
    // Reflection stage is tracked precisely via SSE events
    const eventStage = liveAgentEventStage()
    if (eventStage) return eventStage
    // For autonomous loop: derive from actual run state to avoid stale hasLiveRunnerProgress.
    if (action === "autonomous-loop" || action === "autonomous-iteration") {
      const runs = taskRuns()
      if (
        runs.some(
          (r) =>
            (r.stage === "low_fidelity" || r.stage === "full" || r.stage === "ref_test" || r.stage === "blind_test") &&
            (r.status === "queued" || r.status === "running"),
        )
      )
        return "TrainEval Agent"
      if (runs.some((r) => r.stage === "smoke" && (r.status === "queued" || r.status === "running")))
        return "ModelCompiler Agent"
      // Between iterations: only force ModelDesigner "active" before any training has run.
      // Once training runs exist, return undefined so the overlay doesn't downgrade "done" stages.
      const hasCompletedTraining = runs.some(
        (r) =>
          (r.stage === "low_fidelity" || r.stage === "full" || r.stage === "ref_test" || r.stage === "blind_test") &&
          (r.status === "succeeded" || r.status === "failed" || r.status === "rejected"),
      )
      return hasCompletedTraining ? undefined : "ModelDesigner Agent"
    }
    return liveResearchStageForAction(action, hasLiveRunnerProgress())
  })
  createEffect(() => {
    if (!busy()) setLiveAgentEventStage(undefined)
  })
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
    return `Task ${selectedTaskIndex() + 1}/${count}`
  })
  const candidatePosition = createMemo(() => {
    const count = taskCandidates().length
    if (count === 0) return "Candidate 0/0"
    return `Candidate ${selectedCandidateEffectiveIndex() + 1}/${count}`
  })
  const taskSummary = createMemo(() => `${selectedTaskPosition()} · ${candidatePosition()}`)
  const progressState = (done: boolean, active: boolean) => (done ? "done" : active ? "active" : "todo")
  const intentProgress = createMemo(() => progressState(intentConfirmed(), Boolean(selectedTask()) && !intentConfirmed()))
  const dataProgress = createMemo(() =>
    progressState(hasProfileProgress(), Boolean(selectedTask()) && intentConfirmed() && !hasProfileProgress()),
  )
  const hasActiveRun = createMemo(() => taskRuns().some((run) => run.status === "queued" || run.status === "running"))
  const publishProgress = createMemo(() =>
    progressState(
      hasResultArtifact(),
      false, // only active via live overlay when export-artifact action runs
    ),
  )
  const researchAgentStages = createMemo<ResearchAgentStage[]>(() => {
    const live = liveResearchStage()
    return [
      {
        key: "intent",
        label: "Intent Agent",
        status: overlayLiveResearchStageStatus("intent", intentProgress(), live),
      },
      {
        key: "data",
        label: "Data Analysis Agent",
        status: overlayLiveResearchStageStatus("data", dataProgress(), live),
      },
      ...displayAgentWorkflowProgress().map((item) => ({
        key: item.label,
        label: item.label,
        displayLabel: item.displayLabel,
        status: item.status,
      })),
      {
        key: "publish",
        label: "Publish Agent",
        status: overlayLiveResearchStageStatus("publish", publishProgress(), live),
      },
    ]
  })
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
            <text fg={cockpitColors.primary} onMouseUp={() => insertSlashPrefix("/new")}>
              /new
            </text>
            <text fg={cockpitColors.primary} onMouseUp={() => insertSlashPrefix("/dataset")}>
              /dataset
            </text>
            <text fg={cockpitColors.primary} onMouseUp={() => insertSlashPrefix("/run")}>
              /run
            </text>
            <text fg={cockpitColors.primary} onMouseUp={() => insertSlashPrefix("/loop")}>
              /loop
            </text>
            <text fg={cockpitColors.primary} onMouseUp={() => insertSlashPrefix("/export")}>
              /export
            </text>
            <text fg={cockpitColors.primary} onMouseUp={() => insertSlashPrefix("/help")}>
              /help
            </text>
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
                  <text fg={streamLineColor(line.tone)} width="100%" wrapMode="word">{line.text}</text>
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
                  chat {contextModelLabel()}
                  {reproducibilityContextLine() ? ` / ${reproducibilityContextLine()}` : ""}
                </text>
                <text
                  fg={
                    researchLLMStatus()?.status === "ready"
                      ? cockpitColors.success
                      : researchLLMStatus()?.status === "not_configured"
                        ? cockpitColors.warning
                        : cockpitColors.textMuted
                  }
                  width="100%"
                  overflow="hidden"
                  wrapMode="none"
                >
                  {researchLLMStatus()?.status === "ready"
                    ? `research ${researchLLMStatus()!.model}${researchLLMStatus()!.source === "auth_json" ? " (key)" : " (env)"}`
                    : researchLLMStatus()?.status === "not_configured"
                      ? "research LLM: not configured"
                      : "research LLM: ..."}
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
