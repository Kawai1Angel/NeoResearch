/** @jsxImportSource @opentui/solid */
import { beforeAll, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Global } from "@opencode-ai/core/global"
import { chmod, mkdir, readFile, rm, writeFile } from "fs/promises"
import path from "path"
import { CommandProvider, useCommandDialog } from "../../../src/cli/cmd/tui/component/dialog-command"
import { KeybindProvider } from "../../../src/cli/cmd/tui/context/keybind"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { ProjectProvider } from "../../../src/cli/cmd/tui/context/project"
import { RouteProvider, useRoute, type Route } from "../../../src/cli/cmd/tui/context/route"
import { SDKProvider } from "../../../src/cli/cmd/tui/context/sdk"
import { ThemeProvider } from "../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import {
  ResearchCockpit,
  resolveResearchCockpitChatDefaults,
} from "../../../src/cli/cmd/tui/routes/research-cockpit"
import { DialogProvider } from "../../../src/cli/cmd/tui/ui/dialog"
import { ToastProvider } from "../../../src/cli/cmd/tui/ui/toast"

const now = 1_765_000_000_000
const taskID = "task_neo_cast_01"
const candidateID = "cand_phase2_01"
const runID = "run_smoke_01"
const onboardingPath = path.join(Global.Path.data, "onboarded.json")

async function prepareNeoCastRunnerRoot(root: string) {
  await mkdir(path.join(root, "py"), { recursive: true })
  await writeFile(path.join(root, "py", "validate.py"), "# smoke runner placeholder\n", "utf8")
  await mkdir(path.join(root, ".neo-cast", "runtime", ".venv", "bin"), { recursive: true })
  const pythonPath = path.join(root, ".neo-cast", "runtime", ".venv", "bin", "python")
  await writeFile(pythonPath, "#!/bin/sh\necho Python 3.12.0\n", "utf8")
  await chmod(pythonPath, 0o755)
}

beforeAll(async () => {
  await Promise.all([prepareNeoCastRunnerRoot("/tmp/neo-cast"), prepareNeoCastRunnerRoot("/tmp/neo-cast-research")])
  await writeFile("/tmp/ETTh1.csv", "date,OT,HUFL\n2024-01-01,1,2\n", "utf8")
  await mkdir(Global.Path.data, { recursive: true })
  await writeFile(onboardingPath, `${JSON.stringify({ cockpit: true })}\n`, "utf8")
})

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function requestURL(input: RequestInfo | URL) {
  return new URL(input instanceof Request ? input.url : input.toString())
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit) {
  return init?.method ?? (input instanceof Request ? input.method : undefined)
}

async function requestJson(input: RequestInfo | URL, init?: RequestInit) {
  const raw = init?.body ? String(init.body) : input instanceof Request ? await input.clone().text() : ""
  return raw ? JSON.parse(raw) : undefined
}

function mockResearchFetch(input: RequestInfo | URL, _init?: RequestInit) {
  const url = requestURL(input)
  const path = url.pathname

  if (path === "/research/tasks") {
    return Promise.resolve(
      response([
        {
          id: taskID,
          projectID: "project_neo_cast",
          title: "Neo-Cast Autonomous TSF",
          domainID: "tsf",
          mode: "autonomous",
          status: "researching",
          taskSpec: {
            contextLength: 96,
            predictionLengths: [24],
            runtime: { bridgeOnly: false, neoCastProjectRoot: "/tmp/neo-cast" },
          },
          objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
          budget: { maxRuns: 12, maxParallel: 1 },
          time: { created: now - 60_000, updated: now },
        },
      ]),
    )
  }

  if (path === `/research/tasks/${taskID}/candidates`) {
    return Promise.resolve(
      response([
        {
          id: candidateID,
          taskID,
          domainID: "tsf",
          candidateSpec: {
            recipeID: "phase2_frequency_rnn_quantile",
            preprocessing: { actions: [{ type: "frequency_filter" }, { type: "instance_norm" }] },
            embedding: { type: "patch" },
            backbone: { type: "rnn" },
            fusion: { type: "feature_fusion" },
            predictionHead: { type: "quantile" },
            trainingStrategy: { optimizer: { type: "adamw" } },
          },
          rationale: "Exercise phase-two modular candidate rendering.",
          riskLevel: "medium",
          approvalStatus: "approved",
          generatedBy: "heuristic",
          time: { created: now - 30_000, updated: now - 20_000 },
        },
      ]),
    )
  }

  if (path === `/research/tasks/${taskID}/runs`) {
    return Promise.resolve(
      response([
        {
          id: runID,
          taskID,
          candidateID,
          stage: "smoke",
          status: "succeeded",
          metrics: { val_avg_mse: 0.1234 },
          resourceUsage: {
            wallClockSec: 4,
            reproducibility: {
              gitSHA: "5bd5c6e89abc",
              datasetSHA: "a3f1d9ee0022",
              preprocessSHA: "7b21a0ff3344",
              lockHash: "9d88cafe1122",
            },
          },
          artifactRefs: [],
          time: { created: now - 12_000, updated: now - 8_000 },
        },
      ]),
    )
  }

  if (path === `/research/tasks/${taskID}/artifacts`) {
    return Promise.resolve(
      response([
        {
          id: "artifact_selection_01",
          taskID,
          kind: "research_candidate_selection_json",
          uri: "file:///tmp/selection.json",
          metadata: {
            rankPredictorVersion: "tsf_profile_learned_memory_ranker_v1",
            rankingCount: 4,
            topScore: 0.91,
            historyTaskMemoryCount: 2,
            historyDomainMemoryCount: 5,
          },
          time: { created: now - 7_000, updated: now - 7_000 },
        },
      ]),
    )
  }

  if (path === `/research/tasks/${taskID}/memory`) {
    return Promise.resolve(
      response([
        {
          id: "mem_01",
          taskID,
          domainID: "tsf",
          fingerprintSummary: { horizon: "24", targetCount: 1 },
          candidateSummary: { backbone: "rnn", head: "quantile" },
          outcome: "accepted",
          lesson: "Frequency preprocessing helped the smoke objective.",
          time: { created: now - 5_000, updated: now - 5_000 },
        },
      ]),
    )
  }

  if (path === `/research/tasks/${taskID}/fingerprint`) {
    return Promise.resolve(
      response({
        contextLength: 96,
        horizon: "24",
        targetCount: 1,
        bridgeOnly: false,
        datasetProfile: {
          rowCount: 1024,
          targetCount: 1,
          missingRate: 0.01,
          trendStrength: 0.42,
          seasonalityStrength: 0.77,
          crossVarCorrelation: 0.34,
          distributionShift: 0.08,
        },
      }),
    )
  }

  if (path === `/research/tasks/${taskID}/approvals`) {
    return Promise.resolve(
      response([
        {
          id: "approval_ref_01",
          taskID,
          candidateID,
          kind: "ref_test",
          status: "approved",
          reason: "Allow ref-test promotion for the champion candidate.",
          time: { created: now - 20_000, updated: now - 19_000 },
          timeReplied: now - 19_000,
        },
      ]),
    )
  }

  if (path === `/research/tasks/${taskID}/champion`) {
    return Promise.resolve(
      response({
        taskID,
        candidateID,
        runID,
        primaryMetric: 0.1234,
        utility: 0.88,
        acceptedAt: now - 6_000,
        time: { created: now - 6_000, updated: now - 6_000 },
      }),
    )
  }

  return Promise.resolve(response([]))
}

const researchFetch = mockResearchFetch as typeof fetch

type CommandDialog = ReturnType<typeof useCommandDialog>

function candidateFixture(index: number) {
  const id = `cand_phase2_${String(index).padStart(2, "0")}`
  return {
    id,
    taskID,
    domainID: "tsf",
    candidateSpec: {
      recipeID: `phase2_candidate_${String(index).padStart(2, "0")}`,
      preprocessing: { actions: [{ type: "instance_norm" }] },
      embedding: { type: index % 2 === 0 ? "frequency" : "patch" },
      backbone: { type: index % 2 === 0 ? "mixer" : "rnn" },
      fusion: { type: "feature_fusion" },
      predictionHead: { type: "quantile" },
      trainingStrategy: { optimizer: { type: "adamw" } },
    },
    rationale: `Candidate ${index} rationale`,
    riskLevel: "medium",
    approvalStatus: "approved",
    generatedBy: "heuristic",
    time: { created: now - index * 1_000, updated: now - index * 1_000 },
  }
}

function iterationAnswerFixture(candidate = candidateFixture(1), run = { id: "run_answer_01", status: "succeeded" as const }) {
  return {
    candidate,
    seededCandidates: [],
    approvals: [],
    run: {
      id: run.id,
      taskID: candidate.taskID,
      candidateID: candidate.id,
      stage: "smoke",
      status: run.status,
      metrics: { val_avg_mse: 0.081 },
      time: { created: now, updated: now },
    },
    managerTrace: [
      {
        role: "diagnostic",
        status: "completed",
        summary: "Answered from autonomous research iteration.",
        metadata: {},
      },
      {
        role: "runner",
        status: "completed",
        summary: "Executed the selected candidate.",
        metadata: {},
      },
    ],
  }
}

function providerFixture() {
  return {
    id: "openai",
    name: "OpenAI",
    source: "env",
    env: ["OPENAI_API_KEY"],
    options: {},
    models: {
      "gpt-test": {
        id: "gpt-test",
        providerID: "openai",
        name: "GPT Test",
        api: { id: "gpt-test", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
        capabilities: {
          toolcall: true,
          attachment: false,
          reasoning: false,
          temperature: true,
          interleaved: false,
          input: { text: true, image: false, audio: false, video: false, pdf: false },
          output: { text: true, image: false, audio: false, video: false, pdf: false },
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 128000, output: 8192 },
        status: "active",
        options: {},
        headers: {},
        release_date: "2026-01-01",
      },
      "gpt-switched": {
        id: "gpt-switched",
        providerID: "openai",
        name: "GPT Switched",
        api: { id: "gpt-switched", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
        capabilities: {
          toolcall: true,
          attachment: false,
          reasoning: false,
          temperature: true,
          interleaved: false,
          input: { text: true, image: false, audio: false, video: false, pdf: false },
          output: { text: true, image: false, audio: false, video: false, pdf: false },
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 128000, output: 8192 },
        status: "active",
        options: {},
        headers: {},
        release_date: "2026-01-01",
      },
    },
  }
}

function agentFixture() {
  return {
    name: "Research Agent",
    mode: "primary",
    permission: {},
    options: {},
  }
}

async function mockChatResponse(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  posts: Array<{ path: string; body: unknown }>,
  text: string,
  events?: ReturnType<typeof createCockpitEventSource>,
) {
  const url = requestURL(input)
  const method = requestMethod(input, init)
  if (url.pathname === "/config/providers") {
    return response({ providers: [providerFixture()], default: { openai: "gpt-test" } })
  }
  if (url.pathname === "/agent") return response([agentFixture()])
  if (method !== "POST") return undefined
  posts.push({ path: url.pathname, body: await requestJson(input, init) })
  if (url.pathname === "/session") {
    return response({
      id: "session_research_chat",
      title: "NeoResearch Cockpit",
      version: "0.0.0",
      time: { created: now, updated: now },
    })
  }
  if (url.pathname === "/session/session_research_chat/message") {
    return response({
      info: {
        id: "msg_assistant_reply",
        sessionID: "session_research_chat",
        role: "assistant",
        mode: "build",
        agent: "Research Agent",
        time: { created: now, completed: now + 100 },
      },
      parts: [
        {
          id: "part_reply",
          sessionID: "session_research_chat",
          messageID: "msg_assistant_reply",
          type: "text",
          text,
        },
      ],
    })
  }
  if (url.pathname === "/session/session_research_chat/prompt_async") {
    if (events) setTimeout(() => emitAssistantText(events, text), 0)
    return new Response(null, { status: 204 })
  }
  return undefined
}

function CommandProbe(props: { onReady: (command: CommandDialog) => void }) {
  props.onReady(useCommandDialog())
  return null
}

function SlashCommandProbe(props: { onSelect: () => void }) {
  const command = useCommandDialog()
  command.register(() => [
    {
      title: "Exit the app",
      value: "test.exit",
      category: "System",
      slash: {
        name: "exit",
        aliases: ["quit", "q"],
      },
      onSelect: props.onSelect,
    },
  ])
  return null
}

function RouteProbe(props: { onReady: (route: ReturnType<typeof useRoute>) => void }) {
  props.onReady(useRoute())
  return null
}

function createCockpitEventSource(directory = "/tmp/neo-cast-research") {
  let handlers: Array<(event: any) => void> = []
  return {
    source: {
      subscribe: async (handler: (event: any) => void) => {
        handlers.push(handler)
        return () => {
          handlers = handlers.filter((item) => item !== handler)
        }
      },
    },
    emit(payload: any) {
      for (const handler of handlers) {
        handler({ directory, payload })
      }
    },
  }
}

function emitAssistantText(
  events: ReturnType<typeof createCockpitEventSource>,
  text: string,
  input: {
    messageID?: string
    partID?: string
    sessionID?: string
    usage?: Record<string, unknown>
  } = {},
) {
  const sessionID = input.sessionID ?? "session_research_chat"
  const messageID = input.messageID ?? "msg_assistant_reply"
  const partID = input.partID ?? "part_reply"
  events.emit({
    type: "message.updated",
    properties: {
      info: {
        id: messageID,
        sessionID,
        role: "assistant",
        mode: "build",
        agent: "Research Agent",
        time: { created: now, completed: now + 100 },
        ...input.usage,
      },
    },
  })
  events.emit({
    type: "message.part.updated",
    properties: {
      sessionID,
      part: {
        id: partID,
        sessionID,
        messageID,
        type: "text",
        text,
        time: { start: now },
      },
      time: now,
    },
  })
}

function ResearchCockpitHarness(
  props: {
    fetch?: typeof fetch
    events?: { subscribe: (handler: (event: any) => void) => Promise<() => void> }
    onCommand?: (command: CommandDialog) => void
    onRoute?: (route: ReturnType<typeof useRoute>) => void
    onExitSlash?: () => void
    initialRoute?: Route
    directory?: string
  } = {},
) {
  return (
    <KVProvider>
      <ToastProvider>
        <RouteProvider initialRoute={props.initialRoute ?? { type: "cockpit" }}>
          <TuiConfigProvider config={{ theme: "opencode" }}>
            <SDKProvider
              url="http://mock.local"
              directory={props.directory ?? "/tmp/neo-cast-research"}
              fetch={props.fetch ?? researchFetch}
              events={props.events ?? { subscribe: async () => () => {} }}
            >
              <ProjectProvider>
                <ThemeProvider mode="dark">
                  <KeybindProvider>
                    <DialogProvider>
                      <CommandProvider>
                        <ResearchCockpit />
                        {props.onCommand ? <CommandProbe onReady={props.onCommand} /> : null}
                        {props.onRoute ? <RouteProbe onReady={props.onRoute} /> : null}
                        {props.onExitSlash ? <SlashCommandProbe onSelect={props.onExitSlash} /> : null}
                      </CommandProvider>
                    </DialogProvider>
                  </KeybindProvider>
                </ThemeProvider>
              </ProjectProvider>
            </SDKProvider>
          </TuiConfigProvider>
        </RouteProvider>
      </ToastProvider>
    </KVProvider>
  )
}

async function waitForFrame(app: Awaited<ReturnType<typeof testRender>>, text: string) {
  let lastFrame = ""
  for (let attempt = 0; attempt < 80; attempt++) {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    lastFrame = frame
    if (frame.includes(text)) return frame
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for frame to include ${text}\n\n${lastFrame}`)
}

function frameLine(frame: string, text: string) {
  const line = frame.split("\n").findIndex((value) => value.includes(text))
  if (line === -1) throw new Error(`frame did not include ${text}\n\n${frame}`)
  return line
}

function frameTextLine(frame: string, text: string) {
  return frame.split("\n").find((value) => value.includes(text))
}

function occurrenceCount(frame: string, text: string) {
  return frame.split(text).length - 1
}

describe("ResearchCockpit render", () => {
  test("chat defaults prefer the user-selected TUI model over the provider default", () => {
    const result = resolveResearchCockpitChatDefaults({
      providersResult: { providers: [providerFixture()], default: { openai: "gpt-test" } },
      agentsResult: [agentFixture()],
      selectedModel: { providerID: "openai", modelID: "gpt-switched" },
      selectedAgentName: "Research Agent",
    })

    expect(result).toEqual({
      agent: "Research Agent",
      model: { providerID: "openai", modelID: "gpt-switched" },
    })
  })

  test("chat defaults keep a user-selected model even when the provider list is stale", () => {
    const result = resolveResearchCockpitChatDefaults({
      providersResult: { providers: [providerFixture()], default: { openai: "gpt-test" } },
      agentsResult: [agentFixture()],
      selectedModel: { providerID: "zhipuai-coding-plan", modelID: "glm-5.1" },
      selectedAgentName: "Research Agent",
    })

    expect(result).toEqual({
      agent: "Research Agent",
      model: { providerID: "zhipuai-coding-plan", modelID: "glm-5.1" },
    })
  })

  test("marks onboarding seen once without rendering a status bubble for it", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")
    await rm(onboardingPath, { force: true })

    const emptyFetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(response([]))) as unknown as typeof fetch
    const app = await testRender(() => <ResearchCockpitHarness fetch={emptyFetch} />, { width: 160, height: 48 })

    try {
      // Onboarding used to render as a "Research Agent: 欢迎来到 NeoResearch..." status line —
      // that's gone now (operation-result/notice noise, not an AskUser dialogue), but the
      // "mark as seen" side effect (writing onboardingPath) must still happen exactly once.
      let persisted: Record<string, unknown> = {}
      for (let attempt = 0; attempt < 40; attempt++) {
        await app.renderOnce()
        try {
          persisted = JSON.parse(await readFile(onboardingPath, "utf8")) as Record<string, unknown>
          break
        } catch {
          await Bun.sleep(25)
        }
      }
      const frame = app.captureCharFrame()

      expect(frame).not.toContain("欢迎来到 NeoResearch")
      expect(persisted.cockpit).toBe(true)
    } finally {
      app.renderer.destroy()
      await mkdir(Global.Path.data, { recursive: true })
      await writeFile(onboardingPath, `${JSON.stringify({ cockpit: true })}\n`, "utf8")
    }
  })

  test("renders a stream-only empty workspace before any task exists", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const emptyFetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(response([]))) as unknown as typeof fetch
    const app = await testRender(() => <ResearchCockpitHarness fetch={emptyFetch} />, { width: 160, height: 48 })

    try {
      const frame = await waitForFrame(app, "Research Agent")

      expect(frame).toContain("NeoResearch Workspace")
      expect(frame).toContain("描述一个预测目标，或创建 CSV 任务开始研究。")
      expect(frame).toContain("/new")
      expect(frame).not.toContain("New CSV Task")
      expect(frame).not.toContain("阶段")
      expect(frame).toContain("Intent Agent")
      expect(frame).toContain("下一步")
      expect(frame).not.toContain("Quick Start")
      expect(frame).not.toContain("Next Action")
      expect(frame).not.toContain("Create research task")
      expect(frame).not.toContain("Workflow")
      expect(frame).not.toContain("Thinking:")
      expect(frame).not.toContain("generate_model")
      expect(frame).not.toContain("# Todos")
      expect(frame).not.toContain("Round 1:")
      expect(frame).not.toContain("Forecaster . glm-5.1")
      expect(frame).not.toContain("Select or create a research task")
      expect(frame).toContain("ctrl+p commands")
      expect(frame).toContain("esc interrupt")
      expect(frame).toContain("tab agents")
      expect(frameLine(frame, "Research Agent")).toBeGreaterThanOrEqual(38)
      expect(frameLine(frame, "esc interrupt")).toBe(frameLine(frame, "tab agents"))
      expect(frameLine(frame, "ctrl+p commands")).toBeGreaterThan(frameLine(frame, "Research Agent"))
    } finally {
      app.renderer.destroy()
    }
  })

  test("submitting a prompt in an empty cockpit sends a chat message instead of creating a task", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const events = createCockpitEventSource()
    const posts: Array<{ path: string; body: unknown }> = []
    const promptFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const handled = await mockChatResponse(
        input,
        init,
        posts,
        "我可以先帮你确认数据集、预测长度和 runner 环境；创建实验请使用 New CSV Task。",
        events,
      )
      if (handled) return handled
      return Promise.resolve(response([]))
    }) as typeof fetch
    const app = await testRender(() => <ResearchCockpitHarness fetch={promptFetch} events={events.source} />, {
      width: 160,
      height: 48,
    })

    try {
      await waitForFrame(app, "Research Agent")
      await app.mockInput.typeText("Forecast ETTh1 horizon 24")
      await app.renderOnce()

      let frame = app.captureCharFrame()
      expect(frame).toContain("Forecast ETTh1 horizon 24")
      app.mockInput.pressEnter()
      frame = await waitForFrame(app, "Research Agent: 我可以先帮你确认数据集")
      expect(posts.map((post) => post.path)).toEqual(["/session", "/session/session_research_chat/prompt_async"])
      expect(posts.map((post) => post.path)).not.toContain("/research/tasks")
      expect(frame).toContain("Forecast ETTh1 horizon 24")
    } finally {
      app.renderer.destroy()
    }
  })

  test("short greeting prompts are answered locally without waiting for the model API", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const posts: Array<{ path: string; body: unknown }> = []
    const greetingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const handled = await mockChatResponse(input, init, posts, "model response should not be used")
      if (handled) return handled
      return Promise.resolve(response([]))
    }) as typeof fetch
    const app = await testRender(() => <ResearchCockpitHarness fetch={greetingFetch} />, { width: 160, height: 48 })

    try {
      await waitForFrame(app, "Research Agent")
      await app.mockInput.typeText("你好")
      await app.renderOnce()
      app.mockInput.pressEnter()

      const frame = await waitForFrame(app, "Research Agent: 你好，我在。")
      expect(posts.map((post) => post.path)).not.toContain("/session")
      expect(posts.map((post) => post.path)).not.toContain("/session/session_research_chat/message")
      expect(posts.map((post) => post.path)).not.toContain("/session/session_research_chat/prompt_async")
      expect(frame).not.toContain("Waiting for")
    } finally {
      app.renderer.destroy()
    }
  })

  test("submitting a prompt without a configured provider shows an api key error instead of creating a task", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const posts: Array<{ path: string; body: unknown }> = []
    const noProviderFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestURL(input)
      if (url.pathname === "/config/providers") return response({ providers: [], default: {} })
      if (url.pathname === "/agent") return response([agentFixture()])
      if (requestMethod(input, init) === "POST") {
        posts.push({ path: url.pathname, body: await requestJson(input, init) })
      }
      return response([])
    }) as typeof fetch
    const app = await testRender(() => <ResearchCockpitHarness fetch={noProviderFetch} />, { width: 160, height: 48 })

    try {
      await waitForFrame(app, "Research Agent")
      await app.mockInput.typeText("Forecast ETTh1 horizon 24")
      await app.renderOnce()
      app.mockInput.pressEnter()

      const frame = await waitForFrame(app, "No AI provider is configured")
      expect(frame).toContain("Forecast ETTh1 horizon 24")
      expect(posts.map((post) => post.path)).not.toContain("/research/tasks")
    } finally {
      app.renderer.destroy()
    }
  })

  test("submitting a prompt on an active autonomous task uses the chat API", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const events = createCockpitEventSource()
    const posts: Array<{ path: string; body: unknown }> = []
    const promptFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const handled = await mockChatResponse(
        input,
        init,
        posts,
        "建议先处理当前 smoke run 的失败原因，再启动下一轮实验。",
        events,
      )
      if (handled) return handled
      return mockResearchFetch(input, init)
    }) as typeof fetch
    const app = await testRender(() => <ResearchCockpitHarness fetch={promptFetch} events={events.source} />, {
      width: 160,
      height: 48,
    })

    try {
      await waitForFrame(app, "smoke succeeded")
      await app.mockInput.typeText("请给出下一步实验建议")
      await app.renderOnce()
      app.mockInput.pressEnter()

      const frame = await waitForFrame(app, "Research Agent: 建议先处理当前 smoke run")

      expect(posts.map((post) => post.path)).toContain("/session/session_research_chat/prompt_async")
      expect(posts.map((post) => post.path)).not.toContain(`/research/tasks/${taskID}/autonomous/iterate`)
      expect(frame).toContain("请给出下一步实验建议")
    } finally {
      app.renderer.destroy()
    }
  })

  test("chat action proposals wait for enter before executing the proposed command", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const events = createCockpitEventSource()
    const posts: Array<{ path: string; body: unknown }> = []
    const proposal = JSON.stringify({
      kind: "action_proposal",
      title: "为当前任务准备数据集",
      command: "/dataset prepare",
      reason: "数据集指纹不匹配",
      reversible: true,
      requireConfirm: true,
    })
    const proposalFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const handled = await mockChatResponse(input, init, posts, proposal, events)
      if (handled) return handled
      const url = requestURL(input)
      if (init?.method === "POST") {
        posts.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined })
        if (url.pathname === `/research/tasks/${taskID}/prepare-dataset`) {
          return response({
            artifact: {
              id: "artifact_dataset_prepared",
              taskID,
              kind: "dataset_preparation_json",
              uri: "file:///tmp/dataset-preparation.json",
              metadata: {},
              time: { created: now, updated: now },
            },
            path: "/tmp/dataset-preparation.json",
            datasetSpec: {},
            command: {},
          })
        }
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={proposalFetch} events={events.source} />, {
      width: 160,
      height: 48,
    })

    try {
      await waitForFrame(app, "smoke succeeded")
      await app.mockInput.typeText("数据集需要处理吗")
      await app.renderOnce()
      app.mockInput.pressEnter()

      let frame = await waitForFrame(app, "我建议执行：/dataset prepare")
      expect(frame).toContain("原因：数据集指纹不匹配")
      expect(frame).toContain("[Enter 执行]   [Esc 取消]")
      expect(frame).not.toContain("/why")
      expect(posts.map((post) => post.path)).not.toContain(`/research/tasks/${taskID}/prepare-dataset`)

      app.mockInput.pressEnter()
      for (let attempt = 0; attempt < 40 && !posts.some((post) => post.path === `/research/tasks/${taskID}/prepare-dataset`); attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      expect(posts).toContainEqual({
        path: `/research/tasks/${taskID}/prepare-dataset`,
        body: { force: true },
      })
    } finally {
      app.renderer.destroy()
    }
  })

  test("submitting a chat prompt is not blocked behind a long-running cockpit action", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const events = createCockpitEventSource()
    const posts: Array<{ path: string; body: unknown }> = []
    const promptFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestURL(input)
      const method = requestMethod(input, init)
      if (method === "POST" && url.pathname.endsWith("/autonomous/loop")) {
        posts.push({ path: url.pathname, body: await requestJson(input, init) })
        return new Promise<Response>(() => {})
      }
      const handled = await mockChatResponse(input, init, posts, "排队中的研究动作不会阻塞聊天提交。", events)
      if (handled) return handled
      return mockResearchFetch(input, init)
    }) as typeof fetch
    const app = await testRender(() => <ResearchCockpitHarness fetch={promptFetch} events={events.source} />, {
      width: 160,
      height: 48,
    })

    try {
      await waitForFrame(app, "smoke succeeded")
      await app.mockInput.typeText("/agent-loop")
      await app.renderOnce()
      app.mockInput.pressEnter()

      for (let attempt = 0; attempt < 40 && !posts.some((post) => post.path.endsWith("/autonomous/loop")); attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }
      expect(posts.map((post) => post.path)).toContain(`/research/tasks/${taskID}/autonomous/loop`)

      await app.mockInput.typeText("请解释当前状态")
      await app.renderOnce()
      app.mockInput.pressEnter()

      for (
        let attempt = 0;
        attempt < 40 && !posts.some((post) => post.path === "/session/session_research_chat/prompt_async");
        attempt++
      ) {
        await app.renderOnce()
        await Bun.sleep(25)
      }
      expect(posts.map((post) => post.path)).toContain("/session/session_research_chat/prompt_async")
    } finally {
      app.renderer.destroy()
    }
  })

  test("reuses resolved chat defaults instead of refetching providers on every prompt", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const events = createCockpitEventSource()
    let providerRequests = 0
    let agentRequests = 0
    const posts: Array<{ path: string; body: unknown }> = []
    const chatFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestURL(input)
      if (url.pathname === "/config/providers") {
        providerRequests++
        return response({ providers: [providerFixture()], default: { openai: "gpt-test" } })
      }
      if (url.pathname === "/agent") {
        agentRequests++
        return response([agentFixture()])
      }
      const handled = await mockChatResponse(input, init, posts, "cached defaults", events)
      if (handled) return handled
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={chatFetch} events={events.source} />, {
      width: 160,
      height: 48,
    })

    try {
      await waitForFrame(app, "chat GPT Test")
      await app.mockInput.typeText("first question")
      await app.renderOnce()
      app.mockInput.pressEnter()
      await waitForFrame(app, "Research Agent: cached defaults")

      await app.mockInput.typeText("second question")
      await app.renderOnce()
      app.mockInput.pressEnter()

      for (
        let attempt = 0;
        attempt < 40 && posts.filter((post) => post.path === "/session/session_research_chat/prompt_async").length < 2;
        attempt++
      ) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      expect(posts.filter((post) => post.path === "/session/session_research_chat/prompt_async")).toHaveLength(2)
      expect(providerRequests).toBe(1)
      expect(agentRequests).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("submitting a normal prompt sends it through the chat session API and renders the assistant reply", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const events = createCockpitEventSource()
    const posts: Array<{ path: string; body: unknown }> = []
    const chatFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const handled = await mockChatResponse(
        input,
        init,
        posts,
        "当前任务还在 smoke 阶段，下一步应先修复 runner 路径再继续实验。",
        events,
      )
      if (handled) return handled
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={chatFetch} events={events.source} />, {
      width: 170,
      height: 48,
    })

    try {
      await waitForFrame(app, "smoke succeeded")
      await app.mockInput.typeText("请解释当前状态")
      await app.renderOnce()
      app.mockInput.pressEnter()

      const frame = await waitForFrame(app, "Research Agent: 当前任务还在 smoke 阶段")
      expect(posts.map((post) => post.path)).toContain("/session")
      expect(posts.map((post) => post.path)).toContain("/session/session_research_chat/prompt_async")
      expect(posts.map((post) => post.path)).not.toContain(`/research/tasks/${taskID}/autonomous/iterate`)
      expect(frame).toContain("请解释当前状态")
      expect(posts.find((post) => post.path === "/session/session_research_chat/prompt_async")?.body).toMatchObject({
        agent: "Research Agent",
        model: { providerID: "openai", modelID: "gpt-test" },
        parts: expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            synthetic: true,
            text: expect.stringContaining("尽量用中文回答"),
          }),
          expect.objectContaining({
            type: "text",
            text: "请解释当前状态",
          }),
        ]),
      })
    } finally {
      app.renderer.destroy()
    }
  })

  test("streams chat text deltas before the final chat response completes", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const events = createCockpitEventSource()
    const chatFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestURL(input)
      if (url.pathname !== "/session/session_research_chat/prompt_async") {
        const handled = await mockChatResponse(input, init, [], "unused")
        if (handled) return handled
      }
      if (url.pathname === "/session/session_research_chat/prompt_async") {
        setTimeout(() => {
          events.emit({
            type: "message.updated",
            properties: {
              info: {
                id: "msg_stream_reply",
                sessionID: "session_research_chat",
                role: "assistant",
                mode: "build",
                agent: "Research Agent",
                time: { created: now },
              },
            },
          })
          events.emit({
            type: "message.part.updated",
            properties: {
              sessionID: "session_research_chat",
              part: {
                id: "part_stream_reply",
                sessionID: "session_research_chat",
                messageID: "msg_stream_reply",
                type: "text",
                text: "当前",
                time: { start: now },
              },
              time: now,
            },
          })
          events.emit({
            type: "message.part.delta",
            properties: {
              sessionID: "session_research_chat",
              messageID: "msg_stream_reply",
              partID: "part_stream_reply",
              field: "text",
              delta: "任务",
            },
          })
        }, 0)
        return new Response(null, { status: 204 })
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={chatFetch} events={events.source} />, {
      width: 170,
      height: 48,
    })

    try {
      await waitForFrame(app, "smoke succeeded")
      await app.mockInput.typeText("请解释当前状态")
      await app.renderOnce()
      app.mockInput.pressEnter()

      const streamingFrame = await waitForFrame(app, "Research Agent: 当前任务")
      expect(streamingFrame).not.toContain("Waiting for GPT Test response")

      emitAssistantText(events, "当前任务已完成。", {
        messageID: "msg_stream_reply",
        partID: "part_stream_reply",
      })

      await waitForFrame(app, "Research Agent: 当前任务已完成。")
    } finally {
      app.renderer.destroy()
    }
  })

  test("stitches multiple assistant text parts into one visible chat turn", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const events = createCockpitEventSource()
    const chatFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestURL(input)
      if (url.pathname !== "/session/session_research_chat/prompt_async") {
        const handled = await mockChatResponse(input, init, [], "unused")
        if (handled) return handled
      }
      if (url.pathname === "/session/session_research_chat/prompt_async") {
        setTimeout(() => {
          events.emit({
            type: "message.updated",
            properties: {
              info: {
                id: "msg_multi_part_reply",
                sessionID: "session_research_chat",
                role: "assistant",
                mode: "build",
                agent: "Research Agent",
                time: { created: now },
              },
            },
          })
          events.emit({
            type: "message.part.updated",
            properties: {
              sessionID: "session_research_chat",
              part: {
                id: "part_intro",
                sessionID: "session_research_chat",
                messageID: "msg_multi_part_reply",
                type: "text",
                text: "第一段",
              },
            },
          })
          events.emit({
            type: "message.part.delta",
            properties: {
              sessionID: "session_research_chat",
              messageID: "msg_multi_part_reply",
              partID: "part_body",
              field: "text",
              delta: "第二段",
            },
          })
        }, 0)
        return new Response(null, { status: 204 })
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={chatFetch} events={events.source} />, {
      width: 170,
      height: 48,
    })

    try {
      await waitForFrame(app, "smoke succeeded")
      await app.mockInput.typeText("请拼接多段回复")
      await app.renderOnce()
      app.mockInput.pressEnter()

      const frame = await waitForFrame(app, "第二段")
      expect(frame).toContain("Research Agent: 第一段")
      expect(frame).toContain("  第二段")
    } finally {
      app.renderer.destroy()
    }
  })

  test("submitting a prompt starts the chat asynchronously and renders streamed events without waiting for final JSON", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const events = createCockpitEventSource()
    const posts: Array<{ path: string; body: unknown }> = []
    const chatFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestURL(input)
      const handled = await mockChatResponse(input, init, posts, "unused")
      if (handled && url.pathname !== "/session/session_research_chat/prompt_async") return handled
      if (url.pathname === "/session/session_research_chat/prompt_async") {
        posts.push({ path: url.pathname, body: await requestJson(input, init) })
        setTimeout(() => {
          events.emit({
            type: "message.updated",
            properties: {
              info: {
                id: "msg_async_reply",
                sessionID: "session_research_chat",
                role: "assistant",
                mode: "build",
                agent: "Research Agent",
                time: { created: now },
              },
            },
          })
          events.emit({
            type: "message.part.updated",
            properties: {
              sessionID: "session_research_chat",
              part: {
                id: "part_async_reply",
                sessionID: "session_research_chat",
                messageID: "msg_async_reply",
                type: "text",
                text: "异步回复已开始",
                time: { start: now },
              },
              time: now,
            },
          })
        }, 0)
        return new Response(null, { status: 204 })
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={chatFetch} events={events.source} />, {
      width: 170,
      height: 48,
    })

    try {
      await waitForFrame(app, "smoke succeeded")
      await app.mockInput.typeText("请解释当前状态")
      await app.renderOnce()
      app.mockInput.pressEnter()

      const frame = await waitForFrame(app, "Research Agent: 异步回复已开始")
      expect(posts.map((post) => post.path)).toContain("/session/session_research_chat/prompt_async")
      expect(posts.map((post) => post.path)).not.toContain("/session/session_research_chat/message")
      expect(frame).not.toContain("Waiting for GPT Test response")
    } finally {
      app.renderer.destroy()
    }
  })

  test("accepted async chat requests render as status while waiting for the first stream event", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const chatFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestURL(input)
      const handled = await mockChatResponse(input, init, [], "unused")
      if (handled && url.pathname !== "/session/session_research_chat/prompt_async") return handled
      if (url.pathname === "/session/session_research_chat/prompt_async") return new Response(null, { status: 204 })
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={chatFetch} />, { width: 170, height: 48 })

    try {
      await waitForFrame(app, "smoke succeeded")
      await app.mockInput.typeText("请解释当前状态")
      await app.renderOnce()
      app.mockInput.pressEnter()

      const frame = await waitForFrame(app, "Status: 请求已提交给 GPT Test，正在等待回复流")
      expect(frame).toContain("Research Agent 正在生成回复")
      expect(frame).not.toContain("Research Agent: Chat request accepted")
    } finally {
      app.renderer.destroy()
    }
  })

  test("shows current chat session context and token usage in the right sidebar", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const events = createCockpitEventSource()
    const chatFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestURL(input)
      const method = requestMethod(input, init)
      if (url.pathname === "/config/providers") {
        return response({ providers: [providerFixture()], default: { openai: "gpt-test" } })
      }
      if (url.pathname === "/agent") return response([agentFixture()])
      if (method === "POST" && url.pathname === "/session") {
        return response({
          id: "session_research_chat",
          title: "NeoResearch Cockpit",
          version: "0.0.0",
          time: { created: now, updated: now },
        })
      }
      if (method === "POST" && url.pathname === "/session/session_research_chat/prompt_async") {
        setTimeout(
          () =>
            emitAssistantText(events, "Token usage recorded.", {
              messageID: "msg_usage_reply",
              partID: "part_usage_reply",
              usage: {
                parentID: "msg_user_usage",
                providerID: "openai",
                modelID: "gpt-test",
                path: { cwd: "/tmp/neo-cast-research", root: "/tmp/neo-cast-research" },
                cost: 0.0123,
                tokens: {
                  total: 1512,
                  input: 1000,
                  output: 400,
                  reasoning: 80,
                  cache: { read: 20, write: 12 },
                },
              },
            }),
          0,
        )
        return new Response(null, { status: 204 })
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={chatFetch} events={events.source} />, {
      width: 170,
      height: 52,
    })

    try {
      await waitForFrame(app, "smoke succeeded")
      await app.mockInput.typeText("解释当前状态")
      await app.renderOnce()
      app.mockInput.pressEnter()

      await waitForFrame(app, "Token usage recorded.")
      const frame = await waitForFrame(app, "Context")
      expect(frame).toContain("Context")
      expect(frame).toContain("chat GPT Test")
      expect(frame).toContain("session session_")
      expect(frame).toContain("1,512 / 128,000 (1%)")
      expect(frame).toContain("tokens in=1,000 out=400")
      expect(frame).toContain("reason=80 cache=32")
      expect(frame).toContain("cost $0.01")
      expect(frame).toContain("research cand=1/1 runs=1 ok=1")
    } finally {
      app.renderer.destroy()
    }
  })

  test("shows the champion run reproducibility seal in the cockpit context", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await mkdir(Global.Path.data, { recursive: true })
    const app = await testRender(() => <ResearchCockpitHarness fetch={researchFetch} />, {
      width: 170,
      height: 52,
    })

    try {
      const frame = await waitForFrame(app, "repro g@5bd5c6e d@a3f1 c@7b21")
      expect(frame).toContain("Champion")
      expect(frame).toContain("repro g@5bd5c6e d@a3f1 c@7b21")
    } finally {
      app.renderer.destroy()
    }
  })

  test("shows estimated research context tokens before chat usage is available", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const contextFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestURL(input).pathname
      if (path === "/config/providers") {
        const provider = providerFixture()
        return Promise.resolve(
          response({
            providers: [
              {
                ...provider,
                models: {
                  ...provider.models,
                  "gpt-test": {
                    ...provider.models["gpt-test"],
                    cost: { input: 2, output: 8, cache: { read: 0.5, write: 2 } },
                  },
                },
              },
            ],
            default: { openai: "gpt-test" },
          }),
        )
      }
      if (path === "/agent") return Promise.resolve(response([agentFixture()]))
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={contextFetch} />, {
      width: 170,
      height: 48,
    })

    try {
      const frame = await waitForFrame(app, "research cand=1/1 runs=1 ok=1")
      expect(frame).toMatch(/~[0-9,]+ \/ 128,000 \(research est\. \$0\.\d{4}\)/)
      expect(frame).not.toContain("chat-only")
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps the selected task stable when refresh reorders tasks", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const events = createCockpitEventSource()
    const taskA = {
      id: "task_stable_a",
      projectID: "project_neo_cast",
      title: "Stable Task A",
      domainID: "tsf",
      mode: "autonomous",
      status: "researching",
      taskSpec: {
        contextLength: 96,
        predictionLengths: [24],
        runtime: { bridgeOnly: false, neoCastProjectRoot: "/tmp/neo-cast" },
      },
      objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
      budget: { maxRuns: 12, maxParallel: 1 },
      time: { created: now - 60_000, updated: now - 1_000 },
    }
    const taskB = {
      ...taskA,
      id: "task_stable_b",
      title: "Stable Task B",
      time: { created: now - 50_000, updated: now - 2_000 },
    }
    let taskBUpdatedToTop = false
    let taskFetchesAfterReorder = 0
    const stableFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestURL(input).pathname
      if (path === "/config/providers") return Promise.resolve(response({ providers: [providerFixture()], default: { openai: "gpt-test" } }))
      if (path === "/agent") return Promise.resolve(response([agentFixture()]))
      if (path === "/research/tasks") {
        if (taskBUpdatedToTop) taskFetchesAfterReorder++
        return Promise.resolve(
          response([
            taskA,
            {
              ...taskB,
              time: {
                ...taskB.time,
                updated: taskBUpdatedToTop ? now + 1_000 : taskB.time.updated,
              },
            },
          ]),
        )
      }
      if (path.match(/^\/research\/tasks\/task_stable_[ab]\/(candidates|runs|artifacts|approvals)$/)) return Promise.resolve(response([]))
      if (path.match(/^\/research\/tasks\/task_stable_[ab]\/champion$/)) return Promise.resolve(response(null))
      if (path.match(/^\/research\/tasks\/task_stable_[ab]\/fingerprint$/)) return Promise.resolve(response({}))
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={stableFetch} events={events.source} />, {
      width: 160,
      height: 48,
    })

    try {
      await waitForFrame(app, "Stable Task A")
      await app.mockInput.typeText("/task next")
      await app.renderOnce()
      app.mockInput.pressEnter()
      await waitForFrame(app, "Stable Task B")

      taskBUpdatedToTop = true
      events.emit({ type: "research.task.updated", properties: { task: { ...taskB, time: { ...taskB.time, updated: now + 1_000 } } } })

      const frame = await waitForFrame(app, "Task 1/2")
      expect(taskFetchesAfterReorder).toBeGreaterThan(0)
      expect(frame).toContain("Stable Task B")
      expect(frame).not.toContain("Stable Task A")
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps the selected candidate stable when refresh reorders candidates", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const events = createCockpitEventSource()
    const first = candidateFixture(1)
    const second = candidateFixture(2)
    let reverseCandidates = false
    let candidateFetchesAfterReverse = 0
    const stableFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestURL(input).pathname
      if (path === "/config/providers") return Promise.resolve(response({ providers: [providerFixture()], default: { openai: "gpt-test" } }))
      if (path === "/agent") return Promise.resolve(response([agentFixture()]))
      if (path === `/research/tasks/${taskID}/candidates`) {
        if (reverseCandidates) candidateFetchesAfterReverse++
        return Promise.resolve(response(reverseCandidates ? [second, first] : [first, second]))
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={stableFetch} events={events.source} />, {
      width: 160,
      height: 48,
    })

    try {
      await waitForFrame(app, "candidate 1/2")
      await app.mockInput.typeText("/candidate next")
      await app.renderOnce()
      app.mockInput.pressEnter()
      await waitForFrame(app, "candidate 2/2")

      reverseCandidates = true
      events.emit({ type: "research.candidate.updated", properties: { candidate: second } })

      const frame = await waitForFrame(app, "candidate 1/2")
      expect(candidateFetchesAfterReverse).toBeGreaterThan(0)
      expect(frame).toContain("candidate 1/2")
    } finally {
      app.renderer.destroy()
    }
  })

  test("does not leak one task chat token usage into another task context", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const events = createCockpitEventSource()
    const taskA = {
      id: "task_usage_a",
      projectID: "project_neo_cast",
      title: "Usage Task A",
      domainID: "tsf",
      mode: "autonomous",
      status: "researching",
      taskSpec: {
        contextLength: 96,
        predictionLengths: [24],
        runtime: { bridgeOnly: false, neoCastProjectRoot: "/tmp/neo-cast" },
      },
      objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
      budget: { maxRuns: 12, maxParallel: 1 },
      time: { created: now - 60_000, updated: now - 1_000 },
    }
    const taskB = {
      ...taskA,
      id: "task_usage_b",
      title: "Usage Task B",
      time: { created: now - 50_000, updated: now - 2_000 },
    }
    const chatFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestURL(input)
      const method = requestMethod(input, init)
      if (url.pathname === "/config/providers") return response({ providers: [providerFixture()], default: { openai: "gpt-test" } })
      if (url.pathname === "/agent") return response([agentFixture()])
      if (url.pathname === "/research/tasks") return response([taskA, taskB])
      if (url.pathname.match(/^\/research\/tasks\/task_usage_[ab]\/(candidates|runs|artifacts|approvals)$/)) return response([])
      if (url.pathname.match(/^\/research\/tasks\/task_usage_[ab]\/champion$/)) return response(null)
      if (url.pathname.match(/^\/research\/tasks\/task_usage_[ab]\/fingerprint$/)) return response({})
      if (method === "POST" && url.pathname === "/session") {
        return response({
          id: "session_usage_a",
          title: "NeoResearch Cockpit",
          version: "0.0.0",
          time: { created: now, updated: now },
        })
      }
      if (method === "POST" && url.pathname === "/session/session_usage_a/prompt_async") {
        setTimeout(
          () =>
            emitAssistantText(events, "Usage recorded on task A.", {
              sessionID: "session_usage_a",
              messageID: "msg_usage_task_a",
              partID: "part_usage_task_a",
              usage: {
                cost: 0.0123,
                tokens: {
                  total: 1512,
                  input: 1000,
                  output: 400,
                  reasoning: 80,
                  cache: { read: 20, write: 12 },
                },
              },
            }),
          0,
        )
        return new Response(null, { status: 204 })
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={chatFetch} events={events.source} />, {
      width: 170,
      height: 48,
    })

    try {
      await waitForFrame(app, "Usage Task A")
      await app.mockInput.typeText("解释 A")
      await app.renderOnce()
      app.mockInput.pressEnter()
      await waitForFrame(app, "Usage recorded on task A.")
      await waitForFrame(app, "tokens in=1,000 out=400")

      await app.mockInput.typeText("/task next")
      await app.renderOnce()
      app.mockInput.pressEnter()

      const frame = await waitForFrame(app, "Usage Task B")
      expect(frame).toContain("session task_usa")
      expect(frame).not.toContain("tokens in=1,000 out=400")
      expect(frame).not.toContain("cost $0.01")
    } finally {
      app.renderer.destroy()
    }
  })

  test("shows a model-specific waiting state while chat is pending and cancels it with escape", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    let aborted = false
    const chatFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestURL(input)
      if (url.pathname !== "/session/session_research_chat/prompt_async") {
        const handled = await mockChatResponse(input, init, [], "unused")
        if (handled) return handled
      }
      if (url.pathname === "/session/session_research_chat/prompt_async") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true
            reject(new DOMException("Aborted", "AbortError"))
          })
        })
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={chatFetch} />, { width: 170, height: 48 })

    try {
      await waitForFrame(app, "smoke succeeded")
      await app.mockInput.typeText("请解释当前状态")
      await app.renderOnce()
      app.mockInput.pressEnter()

      const waitingFrame = await waitForFrame(app, "Working / chat GPT Test")
      expect(waitingFrame).toContain("Research Agent 正在生成回复")
      expect(waitingFrame).toMatch(/Working \/ chat GPT Test \/ 0s \[[=> ]+\]/)
      expect(waitingFrame).not.toContain("Waiting for GPT Test response")
      expect(waitingFrame).not.toContain("0s esc interrupt")
      expect(waitingFrame).toContain("esc interrupt")
      app.mockInput.pressKey("ESCAPE")
      const frame = await waitForFrame(app, "chat: Chat request canceled.")

      expect(aborted).toBe(true)
      expect(frame).not.toContain("Running chat")
    } finally {
      app.renderer.destroy()
    }
  })

  test("abort slash command cancels a pending chat request", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    let aborted = false
    const chatFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestURL(input)
      if (url.pathname !== "/session/session_research_chat/prompt_async") {
        const handled = await mockChatResponse(input, init, [], "unused")
        if (handled) return handled
      }
      if (url.pathname === "/session/session_research_chat/prompt_async") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true
            reject(new DOMException("Aborted", "AbortError"))
          })
        })
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={chatFetch} />, { width: 170, height: 48 })

    try {
      await waitForFrame(app, "smoke succeeded")
      await app.mockInput.typeText("请解释当前状态")
      await app.renderOnce()
      app.mockInput.pressEnter()
      await waitForFrame(app, "Research Agent 正在生成回复")

      await app.mockInput.typeText("/abort")
      await app.renderOnce()
      app.mockInput.pressEnter()

      const frame = await waitForFrame(app, "chat: Chat request canceled.")
      expect(aborted).toBe(true)
      expect(frame).not.toContain("Unknown cockpit command: /abort")
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders an explicit chat timeout error instead of leaving the cockpit looking stuck", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const chatFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestURL(input)
      if (url.pathname !== "/session/session_research_chat/prompt_async") {
        const handled = await mockChatResponse(input, init, [], "unused")
        if (handled) return handled
      }
      if (url.pathname === "/session/session_research_chat/prompt_async") {
        const timeout = new Error("timeout")
        timeout.name = "TimeoutError"
        throw timeout
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={chatFetch} />, { width: 170, height: 48 })

    try {
      await waitForFrame(app, "smoke succeeded")
      await app.mockInput.typeText("请解释当前状态")
      await app.renderOnce()
      app.mockInput.pressEnter()

      const frame = await waitForFrame(app, "chat: Chat request to GPT Test timed out after 90s")
      expect(frame).not.toContain("Running chat")
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders user and agent chat turns in chronological order", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const events = createCockpitEventSource()
    const chatFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestURL(input)
      const method = requestMethod(input, init)
      if (url.pathname === "/config/providers") {
        return response({ providers: [providerFixture()], default: { openai: "gpt-test" } })
      }
      if (url.pathname === "/agent") return response([agentFixture()])
      if (method !== "POST") return mockResearchFetch(input, init)
      if (url.pathname === "/session") {
        return response({
          id: "session_research_chat",
          title: "NeoResearch Cockpit",
          version: "0.0.0",
          time: { created: now, updated: now },
        })
      }
      if (url.pathname === "/session/session_research_chat/prompt_async") {
        const body = (await requestJson(input, init)) as { parts?: Array<{ text?: string; synthetic?: boolean }> }
        const prompt = body.parts?.findLast((part) => !part.synthetic && typeof part.text === "string")?.text ?? "unknown"
        const suffix = prompt.replace(/\W+/g, "_")
        setTimeout(
          () =>
            emitAssistantText(events, `answer after ${prompt}`, {
              messageID: `msg_${suffix}`,
              partID: `part_${suffix}`,
            }),
          0,
        )
        return new Response(null, { status: 204 })
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={chatFetch} events={events.source} />, {
      width: 170,
      height: 48,
    })

    try {
      await waitForFrame(app, "smoke succeeded")
      await app.mockInput.typeText("first user turn")
      await app.renderOnce()
      app.mockInput.pressEnter()
      await waitForFrame(app, "Research Agent: answer after first user turn")

      await app.mockInput.typeText("second user turn")
      await app.renderOnce()
      app.mockInput.pressEnter()
      const frame = await waitForFrame(app, "Research Agent: answer after second user turn")

      expect(frameLine(frame, "first user turn")).toBeLessThan(frameLine(frame, "Research Agent: answer after first user turn"))
      expect(frameLine(frame, "Research Agent: answer after first user turn")).toBeLessThan(frameLine(frame, "second user turn"))
      expect(frameLine(frame, "second user turn")).toBeLessThan(frameLine(frame, "Research Agent: answer after second user turn"))
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders dense agent text with breathing room above the prompt panel", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const reply = [
      "**实验管理**",
      "",
      "- 生成候选模型/配方",
      "",
      "",
      "- 执行评估实验",
      "",
      ...Array.from({ length: 24 }, (_, index) => `dense layout line ${String(index + 1).padStart(2, "0")}`),
    ].join("\n")
    const events = createCockpitEventSource()
    const posts: Array<{ path: string; body: unknown }> = []
    const chatFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const handled = await mockChatResponse(input, init, posts, reply, events)
      if (handled) return handled
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={chatFetch} events={events.source} />, {
      width: 170,
      height: 48,
    })

    try {
      await waitForFrame(app, "smoke succeeded")
      await app.mockInput.typeText("整理当前可做的事情")
      await app.renderOnce()
      app.mockInput.pressEnter()

      const frame = await waitForFrame(app, "dense layout line 24")
      const headingLine = frameLine(frame, "Research Agent: **实验管理**")
      const firstBulletLine = frameLine(frame, "- 生成候选模型/配方")
      const secondBulletLine = frameLine(frame, "- 执行评估实验")
      const finalReplyLine = frameLine(frame, "dense layout line 24")
      const promptLine = frameLine(frame, "回答下一个澄清问题")

      expect(firstBulletLine - headingLine).toBe(1)
      expect(secondBulletLine - firstBulletLine).toBe(1)
      expect(promptLine - finalReplyLine).toBeGreaterThanOrEqual(3)
    } finally {
      app.renderer.destroy()
    }
  })

  test("submitting a slash seed command runs seed baselines instead of treating it as a prompt", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const posts: Array<{ path: string; body: unknown }> = []
    const actionFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (init?.method === "POST") {
        posts.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined })
        if (url.pathname === `/research/tasks/${taskID}/baselines`) {
          return Promise.resolve(response({ candidates: [], approvals: [] }))
        }
        if (url.pathname.endsWith("/autonomous/iterate")) {
          return Promise.resolve(response({ iteration: null }))
        }
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={actionFetch} />, { width: 160, height: 48 })

    try {
      await waitForFrame(app, "smoke succeeded")
      await app.mockInput.typeText("/seed-baselines")
      await app.renderOnce()
      app.mockInput.pressEnter()

      for (let attempt = 0; attempt < 40 && posts.length === 0; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      expect(posts.map((post) => post.path)).toContain(`/research/tasks/${taskID}/baselines`)
      expect(posts.map((post) => post.path)).not.toContain(`/research/tasks/${taskID}/autonomous/iterate`)
    } finally {
      app.renderer.destroy()
    }
  })

  test("submitting a candidate slash gate requests reference approval", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const posts: Array<{ path: string; body: unknown }> = []
    const actionFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (init?.method === "POST") {
        posts.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined })
        if (url.pathname === "/research/approvals") {
          return Promise.resolve(
            response({
              id: "approval_created",
              candidateID,
              kind: JSON.parse(String(init.body)).kind,
              status: "pending",
              reason: "requested",
              time: { created: now, updated: now },
            }),
          )
        }
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={actionFetch} />, { width: 160, height: 48 })

    try {
      await waitForFrame(app, "smoke succeeded")
      await app.mockInput.typeText("/ref-gate")
      await app.renderOnce()
      app.mockInput.pressEnter()

      for (let attempt = 0; attempt < 40 && posts.length === 0; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      expect(posts).toContainEqual({
        path: "/research/approvals",
        body: {
          taskID,
          candidateID,
          kind: "ref_test",
          reason: "Approve reference test access for phase2_frequency_rnn_quantile.",
        },
      })
    } finally {
      app.renderer.destroy()
    }
  })

  test("cockpit doctor and api-key slash commands route back to home", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    let route: ReturnType<typeof useRoute> | undefined
    const app = await testRender(
      () => <ResearchCockpitHarness onRoute={(value) => (route = value)} />,
      { width: 160, height: 48 },
    )

    try {
      await waitForFrame(app, "smoke succeeded")
      await app.mockInput.typeText("/doctor")
      app.mockInput.pressEnter()
      for (let attempt = 0; attempt < 20 && route?.data.type !== "home"; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }
      expect(route?.data.type).toBe("home")

      route?.navigate({ type: "cockpit" })
      await app.renderOnce()
      await app.mockInput.typeText("/api-key")
      app.mockInput.pressEnter()
      for (let attempt = 0; attempt < 20 && route?.data.type !== "home"; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }
      expect(route?.data.type).toBe("home")
    } finally {
      app.renderer.destroy()
    }
  })

  test("submitting a prompt on an active autonomous task renders the chat reply", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const events = createCockpitEventSource()
    const posts: Array<{ path: string; body: unknown }> = []
    const actionFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const handled = await mockChatResponse(
        input,
        init,
        posts,
        "可以尝试 mixer，但先确认当前 PatchTST 基线是否稳定。",
        events,
      )
      if (handled) return handled
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={actionFetch} events={events.source} />, {
      width: 160,
      height: 48,
    })

    try {
      await waitForFrame(app, "smoke succeeded")
      await app.mockInput.typeText("try mixer next")
      await app.renderOnce()
      app.mockInput.pressEnter()

      const frame = await waitForFrame(app, "Research Agent: 可以尝试 mixer")
      expect(posts.map((post) => post.path)).toContain("/session/session_research_chat/prompt_async")
      expect(posts.map((post) => post.path)).not.toContain(`/research/tasks/${taskID}/autonomous/iterate`)
      expect(frame).toContain("try mixer next")
    } finally {
      app.renderer.destroy()
    }
  })

  test("registers cockpit slash commands for autocomplete", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    let command: CommandDialog | undefined
    const app = await testRender(
      () => <ResearchCockpitHarness onCommand={(value) => (command = value)} />,
      { width: 160, height: 48 },
    )

    try {
      await waitForFrame(app, "smoke succeeded")
      const displays = command?.slashes().map((slash) => slash.display.trim()) ?? []

      expect(displays).toEqual(
        expect.arrayContaining([
          "/abort",
          "/candidate",
          "/dataset",
          "/help",
          "/loop",
          "/mode",
          "/new",
          "/run",
          "/runner",
          "/seed",
          "/task",
          "/export",
        ]),
      )
      expect(displays).not.toEqual(expect.arrayContaining(["/review", "/review-full", "/agent-loop", "/ref-gate"]))
    } finally {
      app.renderer.destroy()
    }
  })

  test("uses terminal-safe cockpit navigation keybinds", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    let route: ReturnType<typeof useRoute> | undefined
    const app = await testRender(
      () => <ResearchCockpitHarness onRoute={(value) => (route = value)} />,
      { width: 160, height: 48 },
    )

    try {
      const frame = await waitForFrame(app, "Home")
      expect(frame).not.toContain("Home alt+h")
      expect(frame).not.toContain("Home ^H")

      app.mockInput.pressKey("h", { ctrl: true })
      await app.renderOnce()
      expect(route?.data.type).toBe("cockpit")

      app.mockInput.pressKey("h", { meta: true })
      const hintFrame = await waitForFrame(app, "Alt+H 已移除")
      expect(hintFrame).toContain("请使用 /home")
      expect(route?.data.type).toBe("cockpit")
    } finally {
      app.renderer.destroy()
    }
  })

  test("typing slash opens the cockpit command popup", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const app = await testRender(() => <ResearchCockpitHarness />, { width: 160, height: 48 })

    try {
      await waitForFrame(app, "smoke succeeded")
      await app.mockInput.typeText("/")
      const frame = await waitForFrame(app, "Selected /new")

      expect(frame).toContain("Selected /new")
      expect(frame).toContain("/dataset")
      expect(frame).toContain("/run")
      expect(frame).toContain("/loop")
    } finally {
      app.renderer.destroy()
    }
  })

  test("pressing enter on the cockpit slash popup runs the selected command", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const posts: Array<{ path: string; body: unknown }> = []
    const actionFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (init?.method === "POST") {
        posts.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined })
        if (url.pathname === `/research/tasks/${taskID}/baselines`) {
          return Promise.resolve(response({ candidates: [], approvals: [] }))
        }
        if (url.pathname.endsWith("/autonomous/loop")) {
          return Promise.resolve(response({ iterations: [], stoppedReason: "max_iterations" }))
        }
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={actionFetch} />, { width: 160, height: 48 })

    try {
      await waitForFrame(app, "smoke succeeded")
      await app.mockInput.typeText("/loo")
      await app.renderOnce()
      app.mockInput.pressEnter()

      for (let attempt = 0; attempt < 40 && posts.length === 0; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      expect(posts.map((post) => post.path)).toContain(`/research/tasks/${taskID}/autonomous/loop`)
    } finally {
      app.renderer.destroy()
    }
  })

  test("cockpit slash popup executes command option handlers", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    let exitSelected = 0
    const app = await testRender(() => <ResearchCockpitHarness onExitSlash={() => exitSelected++} />, {
      width: 160,
      height: 48,
    })

    try {
      await waitForFrame(app, "smoke succeeded")
      await app.mockInput.typeText("/exit")
      await app.renderOnce()

      app.mockInput.pressEnter()
      await app.renderOnce()
      await Bun.sleep(25)

      expect(exitSelected).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("arrow keys choose a cockpit slash command before enter", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const posts: Array<{ path: string; body: unknown }> = []
    const actionFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (init?.method === "POST") {
        posts.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined })
        if (url.pathname === `/research/tasks/${taskID}/baselines`) {
          return Promise.resolve(response({ candidates: [], approvals: [] }))
        }
        if (url.pathname.endsWith("/autonomous/loop")) {
          return Promise.resolve(response({ iterations: [], stoppedReason: "max_iterations" }))
        }
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={actionFetch} />, { width: 160, height: 48 })

    try {
      await waitForFrame(app, "smoke succeeded")
      await app.mockInput.typeText("/")
      await app.renderOnce()
      app.mockInput.pressKey("ARROW_DOWN")
      app.mockInput.pressEnter()

      for (let attempt = 0; attempt < 40 && posts.length === 0; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      expect(posts).toContainEqual({
        path: `/research/tasks/${taskID}/prepare-dataset`,
        body: { force: true },
      })
    } finally {
      app.renderer.destroy()
    }
  })

  test("asks interaction mode before creating a task from a routed home goal", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const posts: Array<{ path: string; body: unknown }> = []
    const routedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (init?.method === "POST") {
        posts.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined })
      }
      if (url.pathname === "/research/tasks" && init?.method === "POST") {
        return Promise.resolve(
          response({
            id: "task_from_home_goal",
            title: "Forecast ETTh1 horizon 24",
            domainID: "tsf",
            mode: "autonomous",
            status: "created",
            taskSpec: {
              runtime: {
                bridgeOnly: false,
                neoCastProjectRoot: "/tmp/neo-cast-research",
              },
            },
            objective: {},
            budget: {},
            time: { created: now, updated: now },
          }),
        )
      }
      if (url.pathname === "/research/tasks/task_from_home_goal/pipeline" && init?.method === "POST") {
        return Promise.resolve(
          response({
            nas: {
              loop: {
                stoppedReason: "max_iterations",
                iterations: [iterationAnswerFixture(candidateFixture(9), { id: "run_home_answer", status: "succeeded" })],
              },
            },
            publish: {
              artifact: { id: "artifact_model_export", kind: "model_export_package" },
              path: "/tmp/neo-research/export/task_from_home_goal",
            },
          }),
        )
      }
      return Promise.resolve(response([]))
    }) as typeof fetch
    const app = await testRender(
      () => (
        <ResearchCockpitHarness
          fetch={routedFetch}
          initialRoute={{ type: "cockpit", researchGoal: "Forecast ETTh1 horizon 24" } as Route}
        />
      ),
      { width: 160, height: 48 },
    )

    try {
      await waitForFrame(app, "Interaction mode")
      app.mockInput.pressKey("1")
      app.mockInput.pressEnter()
      for (let attempt = 0; attempt < 80 && posts.length < 2; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      expect(posts).toHaveLength(2)
      expect(posts[0]).toMatchObject({
        path: "/research/tasks",
        body: {
          mode: "autonomous",
          interactionMode: "companion",
          taskSpec: {
            runtime: {
              neoCastProjectRoot: "/tmp/neo-cast-research",
            },
            metadata: {
              interactionMode: "companion",
              userPrompt: "Forecast ETTh1 horizon 24",
              source: "home",
            },
          },
        }
      })
      expect(posts[1]).toEqual({
        path: "/research/tasks/task_from_home_goal/pipeline",
        body: {
          stage: "smoke",
          description: "Forecast ETTh1 horizon 24",
          maxIterations: 50,
        }
      })
    } finally {
      app.renderer.destroy()
    }
  })

  test("creating a task from a nested opencode package resolves the sibling Neo-Cast runner", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const workspace = path.join("/tmp", `neo-research-create-runner-${Date.now()}`)
    const packageRoot = path.join(workspace, "opencode", "packages", "opencode")
    const runnerRoot = path.join(workspace, "neo_cast")
    await mkdir(packageRoot, { recursive: true })
    await prepareNeoCastRunnerRoot(runnerRoot)

    const posts: Array<{ path: string; body: unknown }> = []
    const routedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (init?.method === "POST") {
        posts.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined })
      }
      if (url.pathname === "/research/tasks" && init?.method === "POST") {
        const body = JSON.parse(String(init.body))
        return Promise.resolve(
          response({
            id: "task_nested_package_runner",
            title: "Forecast nested package runner",
            domainID: "tsf",
            mode: "autonomous",
            status: "created",
            taskSpec: body.taskSpec,
            objective: {},
            budget: {},
            time: { created: now, updated: now },
          }),
        )
      }
      if (url.pathname === "/research/tasks/task_nested_package_runner/pipeline" && init?.method === "POST") {
        return Promise.resolve(
          response({
            nas: { loop: { stoppedReason: "max_iterations", iterations: [] } },
            publish: {
              artifact: { id: "artifact_nested_package_export", kind: "model_export_package" },
              path: "/tmp/neo-research/export/task_nested_package_runner",
            },
          }),
        )
      }
      return Promise.resolve(response([]))
    }) as typeof fetch

    const app = await testRender(
      () => (
        <ResearchCockpitHarness
          fetch={routedFetch}
          directory={packageRoot}
          initialRoute={{ type: "cockpit", researchGoal: "Forecast nested package runner" } as Route}
        />
      ),
      { width: 160, height: 48 },
    )

    try {
      await waitForFrame(app, "Interaction mode")
      app.mockInput.pressKey("2")
      app.mockInput.pressEnter()
      for (let attempt = 0; attempt < 80 && posts.length < 2; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      expect(posts[0]).toMatchObject({
        path: "/research/tasks",
        body: {
          taskSpec: {
            runtime: {
              neoCastProjectRoot: runnerRoot,
            },
          },
        },
      })
    } finally {
      app.renderer.destroy()
    }
  })

  test("does not auto-iterate a routed home goal until the runner is ready", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const missingRunnerRoot = `/tmp/neo-cast-missing-${Date.now()}`
    const posts: Array<{ path: string; body: unknown }> = []
    const routedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (init?.method === "POST") {
        posts.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined })
      }
      if (url.pathname === "/research/tasks" && init?.method === "POST") {
        return Promise.resolve(
          response({
            id: "task_missing_runner",
            title: "Forecast missing runner",
            domainID: "tsf",
            mode: "autonomous",
            status: "created",
            taskSpec: {
              runtime: {
                bridgeOnly: false,
                neoCastProjectRoot: missingRunnerRoot,
              },
            },
            objective: {},
            budget: {},
            time: { created: now, updated: now },
          }),
        )
      }
      if (url.pathname === "/research/tasks/task_missing_runner/autonomous/iterate" && init?.method === "POST") {
        return Promise.resolve(response(iterationAnswerFixture()))
      }
      return Promise.resolve(response([]))
    }) as typeof fetch
    const app = await testRender(
      () => (
        <ResearchCockpitHarness
          fetch={routedFetch}
          directory={missingRunnerRoot}
          initialRoute={{ type: "cockpit", researchGoal: "Forecast missing runner" } as Route}
        />
      ),
      { width: 160, height: 48 },
    )

    try {
      await waitForFrame(app, "Interaction mode")
      app.mockInput.pressKey("2")
      app.mockInput.pressEnter()
      for (let attempt = 0; attempt < 80 && posts.length === 0; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }
      const frame = app.captureCharFrame()

      expect(posts.map((post) => post.path)).toEqual(["/research/tasks"])
      expect(frame).toContain("Forecast missing runner")
      expect(frame).not.toContain("submitted to research agent")
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders a chat-only workspace with a CastClaw-style status sidebar", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const app = await testRender(() => <ResearchCockpitHarness />, { width: 160, height: 52 })

    try {
      const frame = await waitForFrame(app, "smoke succeeded")

      expect(frame).toContain("NeoResearch Workspace")
      expect(frame).toContain("Publish Agent")
      expect(frame).toContain("Home")
      expect(frame).toContain("Research Agent")
      expect(frame).toContain("smoke succeeded")
      expect(frame).toContain("Neo-Cast Autonomous TSF")
      expect(frame).toContain("苏格拉底")
      expect(frame).not.toContain("交互模式")
      // After B-3 fix: with a smoke-succeeded run + champion but no train run,
      // the active stage is TrainEval Agent (not Reflection — historical
      // champion no longer drives Reflection active).
      expect(
        frame
          .split("\n")
          .some((line) => line.includes("苏格拉底") && line.includes("TrainEval Agent") && line.includes("Research Agent")),
      ).toBe(true)
      expect(frame).toContain("AutoResearch进展")
      expect(frame).toContain("Intent Agent")
      expect(frame).toContain("Data Analysis Agent")
      expect(frame).toContain("HypoPlanner Agent")
      expect(frame).toContain("ModelDesigner Agent")
      expect(frame).toContain("ModelCompiler Agent")
      expect(frame).toContain("TrainEval Agent")
      expect(frame).toContain("Reflection Agent")
      expect(frame).not.toContain("NAS Agent")
      expect(frame).toContain("Publish Agent")
      expect(frame).toContain("需求摘要")
      expect(frame).toContain("预测=24")
      expect(frame).toContain("上下文=96")
      expect(frame).toContain("指标=val_avg_mse")
      expect(frame).toContain("Profile rows=1024")
      expect(frame).not.toContain("用户需求输入")
      expect(frame).not.toContain("Data Profile")
      expect(frame).not.toContain("自主探索")
      expect(frame).not.toContain("结果整理")
      expect(frame).toContain("best val_avg_mse=0.1234")
      expect(frame).toContain("任务")
      expect(frame).toContain("下一步")
      expect(frame).toContain("Export final bundle")
      expect(frame).toContain("Champion")
      expect(frame).toContain("NeoResearch v0.1.0-alpha.0")
      expect(frame).not.toContain("NeoResearch alpha")
      expect(frame).toContain("Context")
      expect(frame).toContain("chat -")
      expect(frame).toContain("session task_neo")
      expect(frame).toMatch(/~[0-9,]+ \(research est\.\)/)
      expect(frame).toContain("research cand=1/1 runs=1 ok=1")
      expect(frame).toContain("Research Agent: 当前研究 Neo-Cast Autonomous TSF")
      expect(frame).toContain("candidate 1/1")
      expect(frame).toContain("latest smoke succeeded")
      expect(frame).not.toContain("Forecaster")
      expect(frame).not.toContain("Critic waiting")
      expect(frame).not.toContain("Artifacts ")
      expect(frame).not.toContain("Approvals ")
      expect(frame).not.toContain("No champion selected")
      expect(frame).not.toContain("Next Action")
      expect(frame).toContain("▶ Next: Run autonomous loop")
      expect(frame).toContain("Enter 执行 · 输入其他问题可追问/跳过")
      expect(frame).not.toContain("/skip")
      expect(frame).not.toContain("/why")
      expect(frame).not.toContain("Run Next /next")
      expect(frame).not.toContain("Candidate Table")
      expect(frame).not.toContain("Smoke Prep")
      expect(frame).not.toContain("Run History")
      expect(frame).not.toContain("LSPs will activate as files are read")
      expect(frame).toContain("esc interrupt")
      expect(frame).not.toContain("State")
      expect(frame).not.toContain("Current state:")
      expect(frame).not.toContain("Round 1:")
      expect(frame).not.toContain("generate_model")
      expect(frame).toContain("tab agents")
      expect(frameLine(frame, "NeoResearch v0.1.0-alpha.0")).toBeGreaterThanOrEqual(48)
      expect(occurrenceCount(frame, "Workflow")).toBe(0)
      const promptFooterLine = frameLine(frame, "苏格拉底 TrainEval Agent Research Agent")
      expect(promptFooterLine).toBeGreaterThanOrEqual(42)
      expect(frameLine(frame, "esc interrupt")).toBe(frameLine(frame, "tab agents"))
      expect(frameLine(frame, "ctrl+p commands")).toBeGreaterThan(promptFooterLine)
    } finally {
      app.renderer.destroy()
    }
  })

  test("onboards a newly created Socratic task and uses a Socratic prompt", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const onboardingFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestURL(input).pathname
      if (path === "/config/providers") {
        return Promise.resolve(response({ providers: [providerFixture()], default: { openai: "gpt-test" } }))
      }
      if (path === "/agent") return Promise.resolve(response([agentFixture()]))
      if (path === "/research/tasks" && !init?.method) {
        return Promise.resolve(
          response([
            {
              id: "task_new_socratic",
              title: "Forecast new dataset",
              domainID: "tsf",
              mode: "autonomous",
              status: "idle",
              taskSpec: { metadata: { interactionMode: "socratic" }, runtime: { neoCastProjectRoot: "/tmp/neo-cast" } },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 8 },
              time: { created: now, updated: now },
            },
          ]),
        )
      }
      if (path.startsWith("/research/tasks/task_new_socratic/")) return Promise.resolve(response([]))
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={onboardingFetch} />, { width: 160, height: 48 })

    try {
      const frame = await waitForFrame(app, "Socratic onboarding")

      expect(frame).toContain("Socratic onboarding")
      expect(frame).toContain("Confirm requirements")
      expect(frame).toContain("确认需求后进入 Data Analysis")
      expect(frame).toContain("→ Intent Agent")
      expect(frame).toContain("• Data Analysis Agent")
      expect(frame).not.toContain("研究输出会在 agent 运行时显示在这里。")
    } finally {
      app.renderer.destroy()
    }
  })

  test("onboards a newly created Companion task with the same slot overview", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const onboardingFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestURL(input).pathname
      if (path === "/config/providers") {
        return Promise.resolve(response({ providers: [providerFixture()], default: { openai: "gpt-test" } }))
      }
      if (path === "/agent") return Promise.resolve(response([agentFixture()]))
      if (path === "/research/tasks" && !init?.method) {
        return Promise.resolve(
          response([
            {
              id: "task_new_companion",
              title: "Review new dataset",
              domainID: "tsf",
              mode: "review",
              status: "idle",
              taskSpec: { metadata: { interactionMode: "companion" }, runtime: { neoCastProjectRoot: "/tmp/neo-cast" } },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 8 },
              time: { created: now, updated: now },
            },
          ]),
        )
      }
      if (path.startsWith("/research/tasks/task_new_companion/")) return Promise.resolve(response([]))
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={onboardingFetch} />, { width: 160, height: 48 })

    try {
      const frame = await waitForFrame(app, "Companion onboarding")

      // No fetch in this test ever creates the task through the cockpit, so the live
      // IntentAgent session was never kicked off — the static 15-slot checklist is gone
      // (per specs/research/intent-agent-tui-streaming.md §3.5), replaced by a "waiting for
      // the session to start" placeholder instead.
      expect(frame).toContain("Companion onboarding")
      expect(frame).toContain("等待 IntentAgent 启动")
      expect(frame).not.toContain("交互模式: companion")
      expect(frame).not.toContain("→ 预测对象")
      expect(frame).toContain("→ Intent Agent")
      expect(frame).toContain("• Data Analysis Agent")
      expect(frame).toContain("Confirm requirements")
      expect(frame).toContain("确认需求后进入 Data Analysis")
      expect(frame).not.toContain("Companion checkpoint: review the proposed next step")
    } finally {
      app.renderer.destroy()
    }
  })

  test("routes Socratic chat input to slot-fill (intent/answer) instead of chat model", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const intentAnswerPosts: Array<{ path: string; body: unknown }> = []
    const onboardingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const reqPath = requestURL(input).pathname
      if (reqPath === "/research/tasks/task_new_socratic/intent/answer" && init?.method === "POST") {
        intentAnswerPosts.push({ path: reqPath, body: JSON.parse(init.body as string) })
        return Promise.resolve(response({}))
      }
      if (reqPath === "/research/tasks" && !init?.method) {
        return Promise.resolve(
          response([
            {
              id: "task_new_socratic",
              title: "Forecast new dataset",
              domainID: "tsf",
              mode: "autonomous",
              status: "idle",
              taskSpec: { metadata: { interactionMode: "socratic" }, runtime: { neoCastProjectRoot: "/tmp/neo-cast" } },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 8 },
              time: { created: now, updated: now },
            },
          ]),
        )
      }
      if (reqPath.startsWith("/research/tasks/task_new_socratic/")) return Promise.resolve(response([]))
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={onboardingFetch} />, {
      width: 160,
      height: 48,
    })

    try {
      await waitForFrame(app, "Socratic onboarding")
      await app.mockInput.typeText("预测对象是 ETTh2 的 OT")
      await app.renderOnce()
      app.mockInput.pressEnter()

      // Give the async POST time to complete then verify routing
      for (let i = 0; i < 10; i++) {
        await app.renderOnce()
        if (intentAnswerPosts.length > 0) break
        await Bun.sleep(20)
      }

      // Input must have been routed to slot fill, not chat model
      expect(intentAnswerPosts.length).toBeGreaterThan(0)
      const post = intentAnswerPosts[0]!
      expect(post.path).toBe("/research/tasks/task_new_socratic/intent/answer")

      // Socratic onboarding context must still be visible
      const frame = app.captureCharFrame()
      expect(frame).toContain("Socratic onboarding")
    } finally {
      app.renderer.destroy()
    }
  })

  test("uses a Companion prompt and approval copy for review tasks", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const companionFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestURL(input).pathname
      if (path === "/research/tasks" && !init?.method) {
        return Promise.resolve(
          response([
            {
              id: "task_companion",
              title: "Review dataset",
              domainID: "tsf",
              mode: "review",
              status: "idle",
              taskSpec: { metadata: { interactionMode: "companion" }, runtime: { neoCastProjectRoot: "/tmp/neo-cast" } },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 8 },
              time: { created: now, updated: now },
            },
          ]),
        )
      }
      if (path === "/research/tasks/task_companion/approvals") {
        return Promise.resolve(
          response([
            {
              id: "approval_candidate",
              taskID: "task_companion",
              candidateID: "candidate_waiting",
              kind: "candidate",
              status: "pending",
              reason: "Review generated autonomous mutation before execution.",
              time: { created: now, updated: now },
            },
          ]),
        )
      }
      if (path.startsWith("/research/tasks/task_companion/")) return Promise.resolve(response([]))
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={companionFetch} />, { width: 160, height: 48 })

    try {
      const frame = await waitForFrame(app, "Approval requested")

      expect(frame).toContain("Approval requested")
      expect(frame).toContain("/approve")
      expect(frame).toContain("/reject")
      expect(frame).toContain("请求建议、批准 checkpoint")
      expect(frame).toContain("Companion checkpoint")
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders Socratic clarification slots and next question for paused tasks", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const clarificationFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestURL(input).pathname
      if (path === "/research/tasks" && !init?.method) {
        return Promise.resolve(
          response([
            {
              id: "task_clarify",
              title: "Clarify goal",
              domainID: "tsf",
              mode: "autonomous",
              status: "paused",
              taskSpec: { metadata: { interactionMode: "socratic" }, runtime: { neoCastProjectRoot: "/tmp/neo-cast" } },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 8 },
              time: { created: now, updated: now },
            },
          ]),
        )
      }
      if (path === "/research/tasks/task_clarify/approvals") {
        return Promise.resolve(
          response([
            {
              id: "approval_protocol",
              taskID: "task_clarify",
              kind: "protocol",
              status: "pending",
              reason: [
                "运行自主研究流水线前需要先澄清研究意图。",
                "- NeoResearch 应该使用哪个 CSV 数据集路径进行 profiling 和执行？",
              ].join("\n"),
              time: { created: now, updated: now },
            },
          ]),
        )
      }
      if (path.startsWith("/research/tasks/task_clarify/")) return Promise.resolve(response([]))
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={clarificationFetch} />, { width: 160, height: 48 })

    try {
      const frame = await waitForFrame(app, "Question: NeoResearch 应该使用哪个 CSV 数据集路径进行 profiling 和执行？")

      // Per specs/research/intent-agent-tui-streaming.md §3.5, the "slots: ..." summary line
      // and slot checklist are gone — only the "Question: ..." line (sourced from the real
      // ask_user/approval text) and the live IntentAgent log remain.
      expect(frame).not.toContain("Socratic clarification: slots:")
      expect(frame).toContain("Question: NeoResearch 应该使用哪个 CSV 数据集路径进行 profiling 和执行？")
      expect(frame).toContain("回答当前 Socratic 问题")
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders the live IntentAgent part stream and keeps it after the user answers", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const clarificationFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestURL(input).pathname
      if (path === "/research/tasks" && !init?.method) {
        return Promise.resolve(
          response([
            {
              id: "task_clarify",
              title: "Clarify goal",
              domainID: "tsf",
              mode: "autonomous",
              status: "paused",
              taskSpec: { metadata: { interactionMode: "socratic" }, runtime: { neoCastProjectRoot: "/tmp/neo-cast" } },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 8 },
              time: { created: now, updated: now },
            },
          ]),
        )
      }
      if (path === "/research/tasks/task_clarify/approvals") {
        return Promise.resolve(
          response([
            {
              id: "approval_protocol",
              taskID: "task_clarify",
              kind: "protocol",
              status: "pending",
              reason: ["运行自主研究流水线前需要先澄清研究意图。", "- 数据集在哪里？"].join("\n"),
              time: { created: now, updated: now },
            },
          ]),
        )
      }
      if (path === "/research/tasks/task_clarify/intent/answer") return Promise.resolve(response({}))
      if (path.startsWith("/research/tasks/task_clarify/")) return Promise.resolve(response([]))
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const events = createCockpitEventSource()
    const app = await testRender(
      () => <ResearchCockpitHarness fetch={clarificationFetch} events={events.source} />,
      { width: 160, height: 48 },
    )

    try {
      await waitForFrame(app, "Question: 数据集在哪里？")

      events.emit({ type: "research.agent.intent.started", properties: { taskID: "task_clarify" } })
      await waitForFrame(app, "[IntentAgent]")
      events.emit({
        type: "research.agent.intent.part.updated",
        properties: { taskID: "task_clarify", partID: "part_q1", kind: "text", text: "数据集在哪里？" },
      })
      // "数据集在哪里？" already matches once via the standalone "Question: ..." fallback line
      // (still showing because no live ask_user tool part has landed yet) — the SDK's event
      // source also debounces bursts within a 16ms window (sdk.tsx handleEvent), so a single
      // frame.includes() check can resolve before the part is applied. Wait for a second,
      // distinct occurrence (the part rendered inside [IntentAgent]) instead.
      let frame = ""
      for (let attempt = 0; attempt < 80; attempt++) {
        await app.renderOnce()
        frame = app.captureCharFrame()
        if (occurrenceCount(frame, "数据集在哪里？") >= 2) break
        await Bun.sleep(25)
      }
      expect(occurrenceCount(frame, "数据集在哪里？")).toBeGreaterThanOrEqual(2)
      expect(frameLine(frame, "[IntentAgent]")).toBeLessThan(frameLine(frame, "数据集在哪里？"))

      await app.mockInput.typeText("数据在 /tmp/etth1.csv")
      await app.renderOnce()
      app.mockInput.pressEnter()
      await app.renderOnce()

      events.emit({
        type: "research.agent.intent.part.updated",
        properties: { taskID: "task_clarify", partID: "part_q2", kind: "text", text: "目标列是什么？" },
      })
      frame = await waitForFrame(app, "目标列是什么？")

      // The original question, the user's echoed answer, and the agent's next question must
      // all still be visible, in that causal order — not just the latest LLM turn replacing
      // the conversation, and not the answer trailing behind in an unrelated bottom timeline.
      expect(frame).toContain("数据集在哪里？")
      expect(frame).toContain("You: 数据在 /tmp/etth1.csv")
      expect(frameLine(frame, "数据集在哪里？")).toBeLessThan(frameLine(frame, "You: 数据在 /tmp/etth1.csv"))
      expect(frameLine(frame, "You: 数据在 /tmp/etth1.csv")).toBeLessThan(frameLine(frame, "目标列是什么？"))
    } finally {
      app.renderer.destroy()
    }
  })

  test("hides the status sidebar in narrow terminals", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const app = await testRender(() => <ResearchCockpitHarness />, { width: 160, height: 48 })

    try {
      await waitForFrame(app, "smoke succeeded")
      app.resize(88, 48)
      const frame = await waitForFrame(app, "smoke succeeded")

      expect(frame).not.toContain("Candidate Table")
      expect(frame).not.toContain("AutoResearch进展")
      expect(frame).not.toContain("Champion")
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders a roomy prompt panel with metadata pinned above the footer", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const metadataFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestURL(input).pathname
      if (path === "/config/providers") {
        return Promise.resolve(response({ providers: [providerFixture()], default: { openai: "gpt-test" } }))
      }
      if (path === "/agent") return Promise.resolve(response([agentFixture()]))
      return mockResearchFetch(input, init)
    }) as typeof fetch
    const app = await testRender(() => <ResearchCockpitHarness fetch={metadataFetch} />, { width: 160, height: 48 })

    try {
      const frame = await waitForFrame(app, "GPT Test")
      const lines = frame.split("\n")
      // Agent-agnostic search: with the B-3 fix, the prompt agent label depends
      // on actual workflow evidence (champion alone no longer drives Reflection
      // Agent active). The default fixture lands on TrainEval Agent. This test
      // is about layout (role line directly above the footer), not the specific
      // agent — match any cockpit agent label.
      const roleLine = lines.findIndex(
        (line) =>
          line.includes("苏格拉底") &&
          /\bAgent\b/.test(line) &&
          (line.includes("GPT Test") || line.includes("Research Agent")),
      )
      const footerLine = frameLine(frame, "tab agents")

      expect(roleLine).toBeGreaterThanOrEqual(0)
      expect(footerLine - roleLine).toBe(1)
      expect(lines[roleLine]).not.toContain("OpenAI")
      expect(lines[footerLine]).toContain("ctrl+p commands")
      expect(frame).not.toContain("enter submit")
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders the prompt agent label from research progress", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const task = {
      id: taskID,
      projectID: "project_neo_cast",
      title: "Phase Task",
      domainID: "tsf",
      mode: "autonomous",
      status: "researching",
      taskSpec: { runtime: { bridgeOnly: false, neoCastProjectRoot: "/tmp/neo-cast" } },
      objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
      budget: { maxRuns: 12, maxParallel: 1 },
      time: { created: now - 60_000, updated: now },
    }
    const fingerprint = {
      contextLength: 96,
      horizon: "24",
      datasetProfile: { rowCount: 1024, targetCount: 1 },
    }
    const champion = {
      taskID,
      candidateID,
      runID,
      primaryMetric: 0.1234,
      utility: 0.88,
      acceptedAt: now - 6_000,
      time: { created: now - 6_000, updated: now - 6_000 },
    }
    const candidate = candidateFixture(1)
    const profileRun = {
      id: "run_profile_01",
      taskID,
      stage: "profile",
      status: "succeeded",
      metrics: { profile_missing_rate: 0 },
      artifactRefs: [],
      time: { created: now - 12_000, updated: now - 8_000 },
    }
    const requirementsApproval = {
      id: "approval_requirements_01",
      kind: "protocol",
      status: "approved",
      reason: "[checkpoint:requirements_confirmed]\nRequirements confirmed.",
      time: { created: now - 7_000, updated: now - 7_000 },
    }
    const phaseFetch = (phase: "empty" | "created" | "profile" | "profile_confirmed" | "explore" | "results") =>
      ((input: RequestInfo | URL, _init?: RequestInit) => {
        const path = requestURL(input).pathname
        if (path === "/config/providers") {
          return Promise.resolve(response({ providers: [providerFixture()], default: { openai: "gpt-test" } }))
        }
        if (path === "/agent") return Promise.resolve(response([agentFixture()]))
        if (path === "/research/tasks") return Promise.resolve(response(phase === "empty" ? [] : [task]))
        if (path === `/research/tasks/${taskID}/fingerprint`) {
          return Promise.resolve(response(phase === "empty" || phase === "created" ? {} : fingerprint))
        }
        if (path === `/research/tasks/${taskID}/champion`) {
          return Promise.resolve(response(phase === "results" ? champion : []))
        }
        if (path === `/research/tasks/${taskID}/artifacts`) return Promise.resolve(response([]))
        if (path === `/research/tasks/${taskID}/candidates`) return Promise.resolve(response(phase === "explore" ? [candidate] : []))
        if (path === `/research/tasks/${taskID}/runs`) {
          return Promise.resolve(response(phase === "profile" || phase === "profile_confirmed" ? [profileRun] : []))
        }
        if (path === `/research/tasks/${taskID}/approvals`) {
          return Promise.resolve(response(phase === "profile_confirmed" ? [requirementsApproval] : []))
        }
        return Promise.resolve(response([]))
      }) as typeof fetch

    const cases = [
      ["empty", undefined, "Intent Agent"],
      ["created", "苏格拉底", "Intent Agent"],
      ["profile", "苏格拉底", "Data Analysis Agent"],
      ["profile_confirmed", "苏格拉底", "HypoPlanner Agent"],
      ["explore", "苏格拉底", "ModelDesigner Agent"],
      // After the B-3 fix, a task with a champion but no successful train run
      // lands on Publish Agent (champion alone no longer activates Reflection
      // Agent in the absence of train evidence). This matches the intent
      // captured by the `validChampion()` shortcut in automaticPromptAgentLabel.
      ["results", "苏格拉底", "Publish Agent"],
    ] as const

    for (const [phase, modeLabel, agentLabel] of cases) {
      const app = await testRender(() => <ResearchCockpitHarness fetch={phaseFetch(phase)} />, { width: 160, height: 48 })
      try {
        let frame = ""
        let agentModelLine = ""
        for (let attempt = 0; attempt < 80; attempt++) {
          await app.renderOnce()
          frame = app.captureCharFrame()
          agentModelLine =
            frame
              .split("\n")
              .find(
                (line) =>
                  (modeLabel ? line.includes(modeLabel) : true) &&
                  line.includes(agentLabel) &&
                  (line.includes("GPT Test") || line.includes("Research Agent")),
              ) ?? ""
          if (agentModelLine) break
          await Bun.sleep(25)
        }
        expect(frame).toContain(agentLabel)
        expect(agentModelLine).toContain(agentLabel)
        expect(agentModelLine.includes("GPT Test") || agentModelLine.includes("Research Agent")).toBe(true)
        expect(agentModelLine).not.toContain("OpenAI")
      } finally {
        app.renderer.destroy()
      }
    }
  })

  test("tab cycles the selected research stage agent in the cockpit footer", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const task = {
      id: taskID,
      projectID: "project_neo_cast",
      title: "Tab Agent Task",
      domainID: "tsf",
      mode: "autonomous",
      status: "researching",
      taskSpec: { runtime: { bridgeOnly: false, neoCastProjectRoot: "/tmp/neo-cast" } },
      objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
      budget: { maxRuns: 12, maxParallel: 1 },
      time: { created: now - 60_000, updated: now },
    }
    const profileRun = {
      id: "run_profile_01",
      taskID,
      stage: "profile",
      status: "succeeded",
      metrics: { profile_missing_rate: 0 },
      artifactRefs: [],
      time: { created: now - 12_000, updated: now - 8_000 },
    }
    const intentApproval = {
      id: "approval_intent_01",
      kind: "protocol",
      status: "approved",
      reason: "[checkpoint:intent_confirmed]\nIntent requirements confirmed.",
      time: { created: now - 7_000, updated: now - 7_000 },
    }
    const tabFetch = ((input: RequestInfo | URL, _init?: RequestInit) => {
      const path = requestURL(input).pathname
      if (path === "/config/providers") {
        return Promise.resolve(response({ providers: [providerFixture()], default: { openai: "gpt-test" } }))
      }
      if (path === "/agent") return Promise.resolve(response([agentFixture()]))
      if (path === "/research/tasks") return Promise.resolve(response([task]))
      if (path === `/research/tasks/${taskID}/fingerprint`) {
        return Promise.resolve(response({ datasetProfile: { rowCount: 1024, targetCount: 1 } }))
      }
      if (path === `/research/tasks/${taskID}/runs`) return Promise.resolve(response([profileRun]))
      if (path === `/research/tasks/${taskID}/approvals`) return Promise.resolve(response([intentApproval]))
      if (path === `/research/tasks/${taskID}/champion`) return Promise.resolve(response([]))
      return Promise.resolve(response([]))
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={tabFetch} />, { width: 160, height: 48 })

    try {
      let frame = await waitForFrame(app, "Data Analysis Agent")
      expect(frame.split("\n").some((line) => line.includes("苏格拉底") && line.includes("Data Analysis Agent"))).toBe(true)

      app.mockInput.pressKey("TAB")
      for (let attempt = 0; attempt < 20; attempt++) {
        await app.renderOnce()
        frame = app.captureCharFrame()
        if (frame.split("\n").some((line) => line.includes("苏格拉底") && line.includes("HypoPlanner Agent"))) break
        await Bun.sleep(25)
      }
      expect(frame.split("\n").some((line) => line.includes("苏格拉底") && line.includes("HypoPlanner Agent"))).toBe(true)

      app.mockInput.pressKey("TAB", { shift: true })
      for (let attempt = 0; attempt < 20; attempt++) {
        await app.renderOnce()
        frame = app.captureCharFrame()
        if (frame.split("\n").some((line) => line.includes("苏格拉底") && line.includes("Data Analysis Agent"))) break
        await Bun.sleep(25)
      }
      expect(frame.split("\n").some((line) => line.includes("苏格拉底") && line.includes("Data Analysis Agent"))).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders one active AutoResearch progress marker with profile and metric summaries", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const runnerRoot = "/tmp/neo-cast-progress-profile"
    await prepareNeoCastRunnerRoot(runnerRoot)
    await writeFile(
      path.join(runnerRoot, ".neo-cast", "dataset_spec.json"),
      JSON.stringify({
        source_csv: "/tmp/ETTh1.csv",
        input_len: 96,
        horizons: [24],
        feature_columns: ["OT"],
      }),
      "utf8",
    )

    const task = {
      id: "task_progress_profile",
      title: "Profiled TSF Task",
      domainID: "tsf",
      mode: "autonomous",
      status: "researching",
      taskSpec: {
        dataset: { path: "/tmp/ETTh1.csv", targetCols: ["OT"] },
        contextLength: 96,
        predictionLengths: [24],
        runtime: { bridgeOnly: false, neoCastProjectRoot: runnerRoot },
        metadata: {
          hypothesisPlan: {
            hypotheses: [{ id: "H1" }, { id: "H2" }, { id: "H3" }],
            baselineStrategy: "domain_baselines_first",
            searchBiases: ["seasonal"],
            stopConditions: { maxTrials: 12, noImprovementRounds: 3 },
          },
        },
      },
      objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
      budget: { maxRuns: 12 },
      time: { created: now - 60_000, updated: now },
    }
    const progressFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestURL(input).pathname
      if (path === "/config/providers") {
        return Promise.resolve(response({ providers: [providerFixture()], default: { openai: "gpt-test" } }))
      }
      if (path === "/agent") return Promise.resolve(response([agentFixture()]))
      if (path === "/research/tasks") return Promise.resolve(response([task]))
      if (path === "/research/tasks/task_progress_profile/fingerprint") {
        return Promise.resolve(
          response({
            datasetProfile: {
              rowCount: 1024,
              targetCount: 1,
              missingRate: 0.01,
              trendStrength: 0.42,
            },
          }),
        )
      }
      if (path === "/research/tasks/task_progress_profile/runs") {
        return Promise.resolve(
          response([
            {
              id: "run_profile",
              taskID: "task_progress_profile",
              stage: "profile",
              status: "succeeded",
              metrics: {},
              time: { created: now - 20_000, updated: now - 15_000 },
            },
            {
              id: "run_smoke",
              taskID: "task_progress_profile",
              stage: "smoke",
              status: "succeeded",
              metrics: { val_avg_mse: 0.222 },
              time: { created: now - 10_000, updated: now - 8_000 },
            },
          ]),
        )
      }
      if (path === "/research/tasks/task_progress_profile/candidates") return Promise.resolve(response([candidateFixture(1)]))
      if (path === "/research/tasks/task_progress_profile/artifacts") return Promise.resolve(response([]))
      if (path === "/research/tasks/task_progress_profile/approvals") return Promise.resolve(response([]))
      if (path === "/research/tasks/task_progress_profile/champion") return Promise.resolve(response(null))
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={progressFetch} />, { width: 160, height: 48 })

    try {
      const frame = await waitForFrame(app, "best val_avg_mse=0.222")

      expect(frame).toContain("✓ Intent Agent")
      expect(frame).toContain("✓ Data Analysis Agent")
      expect(frame).toContain("✓ HypoPlanner Agent (3 hypotheses)")
      expect(frame).toContain("✓ ModelDesigner Agent (iteration 2/12)")
      expect(frame).toContain("✓ ModelCompiler Agent")
      expect(frame).toContain("→ TrainEval Agent")
      expect(frame).toContain("• Reflection Agent")
      expect(frame).toContain("• Publish Agent")
      expect(frame).toContain("Profile rows=1024")
      expect(frame).toContain("missing=0.01")
    } finally {
      app.renderer.destroy()
    }
  })

  test("marks NAS active while seeded candidates wait for the first run", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const runnerRoot = "/tmp/neo-cast-progress-seeded"
    await prepareNeoCastRunnerRoot(runnerRoot)
    await writeFile(
      path.join(runnerRoot, ".neo-cast", "dataset_spec.json"),
      JSON.stringify({
        source_csv: "/tmp/ETTh1.csv",
        input_len: 96,
        horizons: [24],
        feature_columns: ["OT"],
      }),
      "utf8",
    )

    const seededTaskID = "task_progress_seeded"
    const task = {
      id: seededTaskID,
      title: "Seeded TSF Task",
      domainID: "tsf",
      mode: "autonomous",
      status: "researching",
      taskSpec: {
        dataset: { path: "/tmp/ETTh1.csv", targetCols: ["OT"] },
        contextLength: 96,
        predictionLengths: [24],
        runtime: { bridgeOnly: false, neoCastProjectRoot: runnerRoot },
        metadata: {
          hypothesisPlan: {
            hypotheses: [{ id: "H1" }, { id: "H2" }, { id: "H3" }],
            baselineStrategy: "domain_baselines_first",
            searchBiases: ["seasonal"],
            stopConditions: { maxTrials: 12, noImprovementRounds: 3 },
          },
        },
      },
      objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
      budget: { maxRuns: 12 },
      time: { created: now - 60_000, updated: now },
    }
    const candidates = [1, 2, 3].map((index) => ({
      ...candidateFixture(index),
      taskID: seededTaskID,
    }))
    const progressFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestURL(input).pathname
      if (path === "/config/providers") {
        return Promise.resolve(response({ providers: [providerFixture()], default: { openai: "gpt-test" } }))
      }
      if (path === "/agent") return Promise.resolve(response([agentFixture()]))
      if (path === "/research/tasks") return Promise.resolve(response([task]))
      if (path === `/research/tasks/${seededTaskID}/fingerprint`) {
        return Promise.resolve(
          response({
            datasetProfile: {
              rowCount: 17420,
              targetCount: 1,
              missingRate: 0,
              trendStrength: 0.623583,
              seasonalityStrength: 0.154844,
              crossVarCorrelation: 0,
              distributionShift: 1.08905,
            },
          }),
        )
      }
      if (path === `/research/tasks/${seededTaskID}/candidates`) return Promise.resolve(response(candidates))
      if (path === `/research/tasks/${seededTaskID}/runs`) return Promise.resolve(response([]))
      if (path === `/research/tasks/${seededTaskID}/artifacts`) return Promise.resolve(response([]))
      if (path === `/research/tasks/${seededTaskID}/approvals`) return Promise.resolve(response([]))
      if (path === `/research/tasks/${seededTaskID}/champion`) return Promise.resolve(response(null))
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={progressFetch} />, { width: 160, height: 48 })

    try {
      const frame = await waitForFrame(app, "Run autonomous loop")

      expect(frame).toContain("Candidate 1/3")
      expect(frame).toContain("Runner")
      expect(frame).toContain("ready")
      expect(frame).toContain("✓ Intent Agent")
      expect(frame).toContain("✓ Data Analysis Agent")
      expect(frame).toContain("✓ HypoPlanner Agent (3 hypotheses)")
      expect(frame).toContain("→ ModelDesigner Agent (iteration 1/12)")
      expect(frame).toContain("• ModelCompiler Agent")
      expect(frame).toContain("• TrainEval Agent")
      expect(frame).toContain("• Reflection Agent")
      expect(frame).not.toContain("NAS Agent")
      expect(frame).toContain("• Publish Agent")
    } finally {
      app.renderer.destroy()
    }
  })

  test("failed runs show the stored failure reason in the main workspace", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const failedRunFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (url.pathname === `/research/tasks/${taskID}/runs`) {
        return Promise.resolve(
          response([
            {
              id: "run_failed_smoke",
              taskID,
              candidateID,
              stage: "smoke",
              status: "failed",
              metrics: {},
              error: "ModuleNotFoundError: No module named 'torch'",
              resourceUsage: { wallClockSec: 3 },
              artifactRefs: [],
              time: { created: now - 12_000, updated: now - 8_000 },
            },
          ]),
        )
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={failedRunFetch} />, { width: 170, height: 56 })

    try {
      const frame = await waitForFrame(app, "ModuleNotFoundError")

      expect(frame).toContain("smoke failed")
      expect(frame).toContain("ModuleNotFoundError: No module named 'torch'")
      expect(frame).not.toContain("Latest Failure")
    } finally {
      app.renderer.destroy()
    }
  })

  test("command palette can create full-recipe TSF tasks", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const bodies: unknown[] = []
    const fetchWithCreate = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (url.pathname === "/research/tasks" && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)))
        return Promise.resolve(
          response({
            id: "task_full_recipe",
            title: "TSF Autonomous Research",
            domainID: "tsf",
            mode: "autonomous",
            status: "created",
            taskSpec: {},
            objective: {},
            budget: {},
            time: { created: now, updated: now },
          }),
        )
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    let command: CommandDialog | undefined
    const app = await testRender(
      () => <ResearchCockpitHarness fetch={fetchWithCreate} onCommand={(value) => (command = value)} />,
      { width: 160, height: 48 },
    )

    try {
      await waitForFrame(app, "smoke succeeded")
      command?.trigger("research.create.autonomous.full")

      for (let attempt = 0; attempt < 40 && bodies.length === 0; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      expect(bodies).toHaveLength(1)
      expect(bodies[0]).toMatchObject({
        mode: "autonomous",
        taskSpec: {
          runtime: {
            bridgeOnly: false,
            neoCastProjectRoot: "/tmp/neo-cast-research",
          },
        },
      })
    } finally {
      app.renderer.destroy()
    }
  })

  test("CSV task command asks for interaction mode before accepting dataset input", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const bodies: unknown[] = []
    const fetchWithCreate = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (url.pathname === "/research/tasks" && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)))
        return Promise.resolve(
          response({
            id: "task_csv_prompt",
            title: "TSF CSV Research",
            domainID: "tsf",
            mode: "autonomous",
            status: "created",
            taskSpec: {},
            objective: {},
            budget: {},
            time: { created: now, updated: now },
          }),
        )
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    let command: CommandDialog | undefined
    const app = await testRender(
      () => <ResearchCockpitHarness fetch={fetchWithCreate} onCommand={(value) => (command = value)} />,
      { width: 160, height: 48 },
    )

    try {
      await waitForFrame(app, "smoke succeeded")
      command?.trigger("research.create.autonomous.csv")
      await waitForFrame(app, "Interaction mode")
      await app.mockInput.typeText("2")
      await app.renderOnce()
      app.mockInput.pressEnter()
      await waitForFrame(app, "CSV dataset path")

      await app.mockInput.typeText("/tmp/ETTh1.csv target=OT horizon=24 context=96 full")
      await app.renderOnce()
      app.mockInput.pressEnter()

      for (let attempt = 0; attempt < 40 && bodies.length === 0; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      expect(bodies).toHaveLength(1)
      expect(bodies[0]).toMatchObject({
        mode: "autonomous",
        taskSpec: {
          dataset: {
            path: "/tmp/ETTh1.csv",
            targetCols: ["OT"],
          },
          contextLength: 96,
          predictionLengths: [24],
          metadata: {
            interactionMode: "socratic",
          },
          runtime: {
            bridgeOnly: false,
            neoCastProjectRoot: "/tmp/neo-cast-research",
          },
        },
      })
    } finally {
      app.renderer.destroy()
    }
  })

  test("CSV task dialog validates dataset path and parameters before posting", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const posts: unknown[] = []
    const fetchWithCreate = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (url.pathname === "/research/tasks" && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)))
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    let command: CommandDialog | undefined
    const app = await testRender(
      () => <ResearchCockpitHarness fetch={fetchWithCreate} onCommand={(value) => (command = value)} />,
      { width: 160, height: 48 },
    )

    try {
      await waitForFrame(app, "smoke succeeded")
      command?.trigger("research.create.autonomous.csv")
      await waitForFrame(app, "Interaction mode")
      await app.mockInput.typeText("2")
      await app.renderOnce()
      app.mockInput.pressEnter()
      await waitForFrame(app, "CSV dataset path")

      await app.mockInput.typeText("/tmp/missing.csv horizon=abc context=0")
      await app.renderOnce()
      app.mockInput.pressEnter()

      const frame = await waitForFrame(app, "Dataset file does not exist")

      expect(frame).toContain("horizon must be a positive integer list.")
      expect(frame).toContain("context must be a positive integer.")
      expect(posts).toHaveLength(0)
    } finally {
      app.renderer.destroy()
    }
  })

  test("CSV task dialog validates input while the user is typing", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const posts: unknown[] = []
    const fetchWithCreate = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (url.pathname === "/research/tasks" && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)))
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    let command: CommandDialog | undefined
    const app = await testRender(
      () => <ResearchCockpitHarness fetch={fetchWithCreate} onCommand={(value) => (command = value)} />,
      { width: 160, height: 48 },
    )

    try {
      await waitForFrame(app, "smoke succeeded")
      command?.trigger("research.create.autonomous.csv")
      await waitForFrame(app, "Interaction mode")
      await app.mockInput.typeText("2")
      await app.renderOnce()
      app.mockInput.pressEnter()
      await waitForFrame(app, "CSV dataset path")

      await app.mockInput.typeText("/tmp/missing.csv horizon=abc context=0")
      const frame = await waitForFrame(app, "Dataset file does not exist")

      expect(frame).toContain("horizon must be a positive integer list.")
      expect(frame).toContain("context must be a positive integer.")
      expect(posts).toHaveLength(0)
    } finally {
      app.renderer.destroy()
    }
  })

  test("full CSV task command asks for interaction mode before accepting dataset input", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const bodies: unknown[] = []
    const fetchWithCreate = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (url.pathname === "/research/tasks" && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)))
        return Promise.resolve(
          response({
            id: "task_csv_full_prompt",
            title: "TSF CSV Research",
            domainID: "tsf",
            mode: "review",
            status: "created",
            taskSpec: {},
            objective: {},
            budget: {},
            time: { created: now, updated: now },
          }),
        )
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    let command: CommandDialog | undefined
    const app = await testRender(
      () => <ResearchCockpitHarness fetch={fetchWithCreate} onCommand={(value) => (command = value)} />,
      { width: 160, height: 48 },
    )

    try {
      await waitForFrame(app, "smoke succeeded")
      command?.trigger("research.create.autonomous.csv.full")
      await waitForFrame(app, "Interaction mode")
      await app.mockInput.typeText("1")
      await app.renderOnce()
      app.mockInput.pressEnter()
      await waitForFrame(app, "CSV dataset path")

      await app.mockInput.typeText("/tmp/ETTh1.csv target=OT horizon=24 context=96")
      await app.renderOnce()
      app.mockInput.pressEnter()

      for (let attempt = 0; attempt < 40 && bodies.length === 0; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      expect(bodies).toHaveLength(1)
      expect(bodies[0]).toMatchObject({
        mode: "autonomous",
        interactionMode: "companion",
        taskSpec: {
          metadata: {
            interactionMode: "companion",
          },
          runtime: {
            bridgeOnly: false,
            neoCastProjectRoot: "/tmp/neo-cast-research",
          },
        },
      })
    } finally {
      app.renderer.destroy()
    }
  })

  test("cockpit route asks for interaction mode before opening the CSV task dialog", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const app = await testRender(
      () => <ResearchCockpitHarness initialRoute={{ type: "cockpit", newCsvTask: true } as Route} />,
      { width: 160, height: 48 },
    )

    try {
      const frame = await waitForFrame(app, "Interaction mode")

      expect(frame).toContain("1 Companion")
      expect(frame).toContain("2 Socratic")
    } finally {
      app.renderer.destroy()
    }
  })

  test("ctrl-n shows the migration hint instead of opening the CSV task dialog", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const app = await testRender(() => <ResearchCockpitHarness />, { width: 160, height: 48 })

    try {
      await waitForFrame(app, "/new")
      app.mockInput.pressKey("n", { ctrl: true })

      const frame = await waitForFrame(app, "Ctrl+N 已移除")
      expect(frame).toContain("/new csv")
      expect(frame).not.toContain("Interaction mode")
    } finally {
      app.renderer.destroy()
    }
  })

  test("new csv slash command asks for interaction mode first", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const app = await testRender(() => <ResearchCockpitHarness />, { width: 160, height: 48 })

    try {
      await waitForFrame(app, "/new")
      await app.mockInput.typeText("/new csv")
      await app.renderOnce()
      app.mockInput.pressEnter()
      const nextFrame = await waitForFrame(app, "Interaction mode")

      expect(nextFrame).toContain("1 Companion")
      expect(nextFrame).toContain("2 Socratic")
    } finally {
      app.renderer.destroy()
    }
  })

  test("mode slash command switches the selected task interaction mode", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const patches: unknown[] = []
    const modeFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestURL(input)
      if (url.pathname === `/research/tasks/${taskID}/spec` && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body))
        patches.push(body)
        return Promise.resolve(
          response({
            id: taskID,
            projectID: "project_neo_cast",
            title: "Neo-Cast Autonomous TSF",
            domainID: "tsf",
            mode: "autonomous",
            interactionMode: body.interactionMode,
            status: "researching",
            taskSpec: body.taskSpec,
            objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
            budget: { maxRuns: 12, maxParallel: 1 },
            time: { created: now - 60_000, updated: now },
          }),
        )
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={modeFetch} />, { width: 160, height: 48 })

    try {
      await waitForFrame(app, "smoke succeeded")
      await app.mockInput.typeText("/mode-companion")
      await app.renderOnce()
      app.mockInput.pressEnter()

      for (let attempt = 0; attempt < 80 && patches.length === 0; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }
      expect(patches).toEqual([
        expect.objectContaining({
          interactionMode: "companion",
          taskSpec: expect.objectContaining({
            metadata: expect.objectContaining({ interactionMode: "companion" }),
          }),
        }),
      ])
    } finally {
      app.renderer.destroy()
    }
  })

  test("command palette can switch between research tasks", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const taskFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (url.pathname === "/research/tasks" && !init?.method) {
        return Promise.resolve(
          response([
            {
              id: "task_recent",
              title: "Recent TSF Task",
              domainID: "tsf",
              mode: "review",
              status: "researching",
              taskSpec: { runtime: { neoCastProjectRoot: "/tmp/neo-cast" } },
              objective: {},
              budget: { maxRuns: 4 },
              time: { created: now - 1_000, updated: now },
            },
            {
              id: "task_older",
              title: "Older TSF Task",
              domainID: "tsf",
              mode: "review",
              status: "created",
              taskSpec: { runtime: { neoCastProjectRoot: "/tmp/neo-cast" } },
              objective: {},
              budget: { maxRuns: 4 },
              time: { created: now - 10_000, updated: now - 5_000 },
            },
          ]),
        )
      }
      return Promise.resolve(response([]))
    }) as typeof fetch

    let command: CommandDialog | undefined
    const app = await testRender(
      () => <ResearchCockpitHarness fetch={taskFetch} onCommand={(value) => (command = value)} />,
      { width: 160, height: 48 },
    )

    try {
      await waitForFrame(app, "Companion onboarding")
      command?.trigger("research.task.next")
      await app.renderOnce()
      const frame = app.captureCharFrame()

      expect(frame).toContain("Task 2/2")
    } finally {
      app.renderer.destroy()
    }
  })

  test("command palette can navigate back to the home launcher", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    let command: CommandDialog | undefined
    let route: ReturnType<typeof useRoute> | undefined
    const app = await testRender(
      () => (
        <ResearchCockpitHarness
          onCommand={(value) => (command = value)}
          onRoute={(value) => (route = value)}
        />
      ),
      { width: 160, height: 48 },
    )

    try {
      await waitForFrame(app, "smoke succeeded")
      command?.trigger("research.home")
      await app.renderOnce()

      expect(route?.data.type).toBe("home")
    } finally {
      app.renderer.destroy()
    }
  })

  test("next action command executes the recommended autonomous loop", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const posts: Array<{ path: string; body: unknown }> = []
    const actionFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (url.pathname === `/research/tasks/${taskID}/approvals` && !init?.method) {
        return Promise.resolve(
          response([
            {
              id: "approval_ref_01",
              taskID,
              candidateID,
              kind: "ref_test",
              status: "approved",
              reason: "Allow ref-test promotion for the champion candidate.",
              time: { created: now - 20_000, updated: now - 19_000 },
            },
            {
              id: "approval_blind_01",
              taskID,
              candidateID,
              kind: "blind_test",
              status: "approved",
              reason: "Allow blind-test promotion for the champion candidate.",
              time: { created: now - 18_000, updated: now - 17_000 },
            },
          ]),
        )
      }
      if (init?.method === "POST") {
        posts.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined })
        if (url.pathname.endsWith("/autonomous/loop")) {
          return Promise.resolve(response({ iterations: [], stoppedReason: "max_iterations" }))
        }
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    let command: CommandDialog | undefined
    const app = await testRender(
      () => <ResearchCockpitHarness fetch={actionFetch} onCommand={(value) => (command = value)} />,
      { width: 160, height: 48 },
    )

    try {
      await waitForFrame(app, "smoke succeeded")
      command?.trigger("research.next.run")
      for (let attempt = 0; attempt < 40 && posts.length === 0; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      expect(posts).toContainEqual({
        path: `/research/tasks/${taskID}/autonomous/loop`,
        body: { stage: "full", maxIterations: 50, description: "cockpit autonomous loop" },
      })
    } finally {
      app.renderer.destroy()
    }
  })

  test("active autonomous loop shows live workflow instead of historical completion", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const posts: Array<{ path: string; body: unknown }> = []
    let resolveLoop: ((value: Response) => void) | undefined
    const actionFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (init?.method === "POST") {
        posts.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined })
        if (url.pathname.endsWith("/autonomous/loop")) {
          return new Promise<Response>((resolve) => {
            resolveLoop = resolve
          })
        }
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={actionFetch} />, { width: 160, height: 48 })

    try {
      await waitForFrame(app, "smoke succeeded")
      await app.mockInput.typeText("/loop start")
      await app.renderOnce()
      app.mockInput.pressEnter()

      for (let attempt = 0; attempt < 40 && posts.length === 0; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      expect(posts.map((post) => post.path)).toContain(`/research/tasks/${taskID}/autonomous/loop`)
      const frame = await waitForFrame(app, "→ ModelDesigner Agent")
      expect(frame).not.toContain("✓ ModelDesigner Agent")
      expect(frame).toContain("✓ ModelCompiler Agent")
      expect(frame).toContain("• TrainEval Agent")
    } finally {
      resolveLoop?.(response({ iterations: [], stoppedReason: "max_iterations" }))
      app.renderer.destroy()
    }
  })

  test("live intent confirmation keeps a single active AutoResearch progress marker", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const events = createCockpitEventSource()
    let intentConfirmed = false
    let approvalsFetchesAfterConfirm = 0
    let resolveReply: ((value: Response) => void) | undefined
    const task = {
      id: "task_confirm_intent_live",
      projectID: "project_neo_cast",
      title: "Confirm Intent Live Task",
      domainID: "tsf",
      mode: "autonomous",
      status: "researching",
      taskSpec: {
        contextLength: 96,
        predictionLengths: [24],
        runtime: { bridgeOnly: false, neoCastProjectRoot: "/tmp/neo-cast" },
      },
      objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
      budget: { maxRuns: 12, maxParallel: 1 },
      time: { created: now - 60_000, updated: now },
    }
    const approval = {
      id: "approval_intent_live",
      taskID: task.id,
      kind: "protocol",
      status: "approved",
      reason: "[checkpoint:intent_confirmed]\nIntent requirements confirmed.",
      time: { created: now - 5_000, updated: now - 4_000 },
      timeReplied: now - 4_000,
    }
    const confirmFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestURL(input).pathname
      const method = requestMethod(input, init)
      if (path === "/config/providers") {
        return Promise.resolve(response({ providers: [providerFixture()], default: { openai: "gpt-test" } }))
      }
      if (path === "/agent") return Promise.resolve(response([agentFixture()]))
      if (path === "/research/tasks") return Promise.resolve(response([task]))
      if (path === `/research/tasks/${task.id}/fingerprint`) {
        return Promise.resolve(response({ datasetProfile: { rowCount: 1024, targetCount: 1 } }))
      }
      if (path === `/research/tasks/${task.id}/candidates`) return Promise.resolve(response([]))
      if (path === `/research/tasks/${task.id}/runs`) return Promise.resolve(response([]))
      if (path === `/research/tasks/${task.id}/artifacts`) return Promise.resolve(response([]))
      if (path === `/research/tasks/${task.id}/champion`) return Promise.resolve(response(null))
      if (path === `/research/tasks/${task.id}/approvals`) {
        if (intentConfirmed) approvalsFetchesAfterConfirm++
        return Promise.resolve(response(intentConfirmed ? [approval] : []))
      }
      if (method === "POST" && path === "/research/approvals") {
        return Promise.resolve(response({ ...approval, status: "pending", timeReplied: undefined }))
      }
      if (method === "POST" && path === `/research/approvals/${approval.id}/reply`) {
        intentConfirmed = true
        setTimeout(
          () =>
            events.emit({
              type: "research.approval.updated",
              properties: { approval },
            }),
          0,
        )
        return new Promise<Response>((resolve) => {
          resolveReply = resolve
        })
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={confirmFetch} events={events.source} />, {
      width: 160,
      height: 48,
    })

    try {
      await waitForFrame(app, "Seed baselines")
      await app.mockInput.typeText("开始预测")
      await app.renderOnce()
      app.mockInput.pressEnter()

      let frame = ""
      for (let attempt = 0; attempt < 80; attempt++) {
        await app.renderOnce()
        frame = app.captureCharFrame()
        if (approvalsFetchesAfterConfirm > 0 && frame.includes("→ Intent Agent")) break
        await Bun.sleep(25)
      }
      expect(approvalsFetchesAfterConfirm).toBeGreaterThan(0)
      const activeAgentLines = frame
        .split("\n")
        .filter((line) => /│\s+→ .*Agent/.test(line))
      expect(activeAgentLines).toHaveLength(1)
      expect(activeAgentLines[0]).toContain("Intent Agent")
      expect(frame).not.toContain("→ Data Analysis Agent")
    } finally {
      resolveReply?.(response(approval))
      app.renderer.destroy()
    }
  })

  test("pressing enter on an empty prompt executes the next best action", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const posts: Array<{ path: string; body: unknown }> = []
    const actionFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (url.pathname === `/research/tasks/${taskID}/approvals` && !init?.method) {
        return Promise.resolve(response([]))
      }
      if (init?.method === "POST") {
        posts.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined })
        if (url.pathname.endsWith("/autonomous/loop")) {
          return Promise.resolve(response({ iterations: [], stoppedReason: "max_iterations" }))
        }
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={actionFetch} />, { width: 160, height: 48 })

    try {
      await waitForFrame(app, "smoke succeeded")
      app.mockInput.pressEnter()
      for (let attempt = 0; attempt < 40 && posts.length === 0; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      expect(posts).toContainEqual({
        path: `/research/tasks/${taskID}/autonomous/loop`,
        body: { stage: "full", maxIterations: 50, description: "cockpit autonomous loop" },
      })
    } finally {
      app.renderer.destroy()
    }
  })

  test("candidate command palette actions cover gates, seed sweep, and promoted executions", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const posts: Array<{ path: string; body: unknown }> = []
    const actionFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (init?.method === "POST") {
        posts.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined })
        if (url.pathname === "/research/approvals") {
          return Promise.resolve(
            response({
              id: "approval_created",
              candidateID,
              kind: JSON.parse(String(init.body)).kind,
              status: "pending",
              reason: "requested",
              time: { created: now, updated: now },
            }),
          )
        }
        if (url.pathname.endsWith("/seed-sweep")) {
          return Promise.resolve(response({ seeds: [3, 5], runs: [] }))
        }
        if (url.pathname.endsWith("/execute-run")) {
          return Promise.resolve(
            response({
              run: { id: "run_exec", status: "queued", metrics: {}, time: { created: now, updated: now } },
            }),
          )
        }
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    let command: CommandDialog | undefined
    const app = await testRender(
      () => <ResearchCockpitHarness fetch={actionFetch} onCommand={(value) => (command = value)} />,
      { width: 160, height: 48 },
    )

    try {
      await waitForFrame(app, "smoke succeeded")
      command?.trigger("research.candidate.refGate")
      for (let attempt = 0; attempt < 40 && posts.length < 1; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }
      await Bun.sleep(25)
      command?.trigger("research.candidate.seedSweep")
      for (let attempt = 0; attempt < 40 && posts.length < 2; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }
      await Bun.sleep(25)
      command?.trigger("research.candidate.refExec")
      for (let attempt = 0; attempt < 40 && posts.length < 3; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }
      await Bun.sleep(25)
      command?.trigger("research.candidate.blindGate")
      for (let attempt = 0; attempt < 40 && posts.length < 4; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }
      await Bun.sleep(25)
      command?.trigger("research.candidate.blindExec")

      for (let attempt = 0; attempt < 40 && posts.length < 5; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      expect(posts).toEqual(
        expect.arrayContaining([
          {
            path: "/research/approvals",
            body: {
              taskID,
              candidateID,
              kind: "ref_test",
              reason: "Approve reference test access for phase2_frequency_rnn_quantile.",
            },
          },
          {
            path: `/research/tasks/${taskID}/candidates/${candidateID}/seed-sweep`,
            body: { stage: "smoke", description: "cockpit smoke seed sweep" },
          },
          {
            path: `/research/tasks/${taskID}/candidates/${candidateID}/execute-run`,
            body: { stage: "ref_test", description: "cockpit ref_test run" },
          },
          {
            path: "/research/approvals",
            body: {
              taskID,
              candidateID,
              kind: "blind_test",
              reason: "Approve blind test sidecar access for phase2_frequency_rnn_quantile.",
            },
          },
          {
            path: `/research/tasks/${taskID}/candidates/${candidateID}/execute-run`,
            body: { stage: "blind_test", description: "cockpit blind_test run" },
          },
        ]),
      )
    } finally {
      app.renderer.destroy()
    }
  })

  test("candidate list can page and palette actions target the selected candidate", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const posts: Array<{ path: string; body: unknown }> = []
    const manyCandidateFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (url.pathname === `/research/tasks/${taskID}/candidates`) {
        return Promise.resolve(response([1, 2, 3, 4, 5].map(candidateFixture)))
      }
      if (url.pathname === `/research/tasks/${taskID}/approvals` && !init?.method) {
        return Promise.resolve(response([]))
      }
      if (init?.method === "POST") {
        posts.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined })
        if (url.pathname === "/research/approvals") {
          return Promise.resolve(
            response({
              id: "approval_created",
              candidateID: JSON.parse(String(init.body)).candidateID,
              kind: JSON.parse(String(init.body)).kind,
              status: "pending",
              reason: "requested",
              time: { created: now, updated: now },
            }),
          )
        }
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    let command: CommandDialog | undefined
    const app = await testRender(
      () => <ResearchCockpitHarness fetch={manyCandidateFetch} onCommand={(value) => (command = value)} />,
      { width: 170, height: 56 },
    )

    try {
      const frame = await waitForFrame(app, "smoke succeeded")

      expect(frame).not.toContain("Candidate Table")
      expect(frame).not.toContain("Smoke Prep")
      expect(frame).not.toContain("Ref Gate")

      command?.trigger("research.candidate.next")
      command?.trigger("research.candidate.next")
      command?.trigger("research.candidate.next")
      await app.renderOnce()

      command?.trigger("research.candidate.refGate")
      for (let attempt = 0; attempt < 40 && posts.length === 0; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      expect(posts).toContainEqual({
        path: "/research/approvals",
        body: {
          taskID,
          candidateID: "cand_phase2_04",
          kind: "ref_test",
          reason: "Approve reference test access for phase2_candidate_04.",
        },
      })
    } finally {
      app.renderer.destroy()
    }
  })

  test("runner root can be repaired from the cockpit when missing", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const patches: unknown[] = []
    const missingRunnerFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (url.pathname === "/research/tasks" && !init?.method) {
        return Promise.resolve(
          response([
            {
              id: taskID,
              projectID: "project_neo_cast",
              title: "Missing Runner Task",
              domainID: "tsf",
              mode: "autonomous",
              status: "researching",
              taskSpec: {
                contextLength: 96,
                predictionLengths: [24],
                runtime: { bridgeOnly: false },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12, maxParallel: 1 },
              time: { created: now - 60_000, updated: now },
            },
          ]),
        )
      }
      if (url.pathname === `/research/tasks/${taskID}/spec` && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body))
        patches.push(body)
        return Promise.resolve(
          response({
            id: taskID,
            title: "Missing Runner Task",
            domainID: "tsf",
            mode: "autonomous",
            status: "researching",
            taskSpec: body.taskSpec,
            objective: {},
            budget: { maxRuns: 12 },
            time: { created: now, updated: now },
          }),
        )
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    let command: CommandDialog | undefined
    const app = await testRender(
      () => <ResearchCockpitHarness fetch={missingRunnerFetch} onCommand={(value) => (command = value)} />,
      { width: 170, height: 56 },
    )

    try {
      const frame = await waitForFrame(app, "smoke succeeded")
      expect(frame).not.toContain("Next Action")
      expect(frame).not.toContain("Configure Neo-Cast runner")
      expect(frame).toContain("Runner root missing")
      expect(frame).toContain("Use Project Runner")
      expect(frame).toContain("Set runner root in taskSpec.runtime.")
      expect(frame).not.toContain("Edit Runner Root")

      command?.trigger("research.runner.useProject")
      for (let attempt = 0; attempt < 40 && patches.length === 0; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      expect(patches).toEqual([
        {
          taskSpec: {
            contextLength: 96,
            predictionLengths: [24],
            runtime: { bridgeOnly: false, neoCastProjectRoot: "/tmp/neo-cast-research" },
          },
        },
      ])
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders live runner progress events for a running run", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const events = createCockpitEventSource()
    const runningRunID = "run_live_progress"
    const runningFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestURL(input).pathname
      if (path === `/research/tasks/${taskID}/runs`) {
        return Promise.resolve(
          response([
            {
              id: runningRunID,
              taskID,
              candidateID,
              stage: "smoke",
              status: "running",
              metrics: {},
              resourceUsage: {},
              artifactRefs: [],
              time: { created: now - 1_000, updated: now - 500 },
            },
          ]),
        )
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={runningFetch} events={events.source} />, {
      width: 170,
      height: 56,
    })

    try {
      await waitForFrame(app, `smoke running`)
      events.emit({
        type: "research.runner.progress.line",
        properties: {
          taskID,
          runID: runningRunID,
          line: '{"event":"epoch_end","horizon":24,"epoch":2,"val_loss":0.12345}',
          event: "epoch_end",
          epoch: 2,
          horizon: 24,
          valLoss: 0.12345,
        },
      })

      const frame = await waitForFrame(app, "epoch 2 | h24 | val_loss 0.1235")
      expect(frame).toContain(`smoke running`)
    } finally {
      app.renderer.destroy()
    }
  })

  test("formats structured runner json progress instead of printing raw records", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const events = createCockpitEventSource()
    const runningRunID = "run_json_progress"
    const runningFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestURL(input).pathname
      if (path === `/research/tasks/${taskID}/runs`) {
        return Promise.resolve(
          response([
            {
              id: runningRunID,
              taskID,
              candidateID,
              stage: "smoke",
              status: "running",
              metrics: {},
              resourceUsage: {},
              artifactRefs: [],
              time: { created: now - 1_000, updated: now - 500 },
            },
          ]),
        )
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={runningFetch} events={events.source} />, {
      width: 170,
      height: 56,
    })

    try {
      await waitForFrame(app, `smoke running`)
      events.emit({
        type: "research.runner.progress.line",
        properties: {
          taskID,
          runID: runningRunID,
          line: '{"event":"candidate_resolved","candidate_id":"tsf_linear_raw_baseline","resolved_candidate_path":"/tmp/very/long/path/resolved_candidate.json"}',
          event: "candidate_resolved",
        },
      })

      const frame = await waitForFrame(app, "candidate resolved | tsf_linear_raw_baseline")
      expect(frame).not.toContain('{"event":"candidate_resolved"')
      expect(frame).toContain(".../resolved_candidate.json")
    } finally {
      app.renderer.destroy()
    }
  })

  test("does not refetch structured state for high-frequency epoch runner progress", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const events = createCockpitEventSource()
    const runningRunID = "run_epoch_progress"
    let runsFetches = 0
    const runningFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestURL(input).pathname
      if (path === `/research/tasks/${taskID}/runs`) {
        runsFetches++
        return Promise.resolve(
          response([
            {
              id: runningRunID,
              taskID,
              candidateID,
              stage: "smoke",
              status: "running",
              metrics: {},
              resourceUsage: {},
              artifactRefs: [],
              time: { created: now - 1_000, updated: now - 500 },
            },
          ]),
        )
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={runningFetch} events={events.source} />, {
      width: 170,
      height: 56,
    })

    try {
      await waitForFrame(app, `smoke running`)
      const fetchesBeforeProgress = runsFetches
      for (let epoch = 1; epoch <= 3; epoch++) {
        events.emit({
          type: "research.runner.progress.line",
          properties: {
            taskID,
            runID: runningRunID,
            line: `{"event":"epoch_end","horizon":24,"epoch":${epoch},"val_loss":0.12345}`,
            event: "epoch_end",
            epoch,
            horizon: 24,
            valLoss: 0.12345,
          },
        })
      }
      await waitForFrame(app, "epoch 3 | h24 | val_loss 0.1235")
      await Bun.sleep(75)
      await app.renderOnce()

      expect(runsFetches).toBe(fetchesBeforeProgress)
    } finally {
      app.renderer.destroy()
    }
  })

  test("runner progress events refresh structured run state", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const events = createCockpitEventSource()
    const changingRunID = "run_refresh_progress"
    let runStatus: "running" | "succeeded" = "running"
    const progressFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestURL(input).pathname
      if (path === `/research/tasks/${taskID}/runs`) {
        return Promise.resolve(
          response([
            {
              id: changingRunID,
              taskID,
              candidateID,
              stage: "smoke",
              status: runStatus,
              metrics: runStatus === "succeeded" ? { val_avg_mse: 0.101 } : {},
              resourceUsage: {},
              artifactRefs: [],
              time: { created: now - 1_000, updated: now - 500 },
            },
          ]),
        )
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={progressFetch} events={events.source} />, {
      width: 170,
      height: 56,
    })

    try {
      await waitForFrame(app, `smoke running`)
      runStatus = "succeeded"
      events.emit({
        type: "research.runner.progress.line",
        properties: {
          taskID,
          runID: changingRunID,
          line: '{"event":"smoke_eval_done","val_avg_mse":0.101}',
          event: "smoke_eval_done",
        },
      })

      const frame = await waitForFrame(app, `smoke succeeded`)
      expect(frame).toContain("val_avg_mse 0.101")
    } finally {
      app.renderer.destroy()
    }
  })

  test("dataset mismatch can be repaired from the cockpit by preparing the task dataset", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const runnerRoot = path.join("/tmp", `neo-cast-dataset-mismatch-${Date.now()}`)
    await prepareNeoCastRunnerRoot(runnerRoot)
    await mkdir(path.join(runnerRoot, ".neo-cast"), { recursive: true })
    await writeFile(
      path.join(runnerRoot, ".neo-cast", "dataset_spec.json"),
      `${JSON.stringify(
        {
          schema_version: "dataset.v1",
          source_csv: "/tmp/other.csv",
          task_id: "etth1",
          timestamp_col: "date",
          feature_columns: ["OT"],
          input_len: 96,
          horizons: [48],
          splits: { train: [0, 100], val: [100, 140], ref_test: [140, 180] },
          normalization: { type: "standard", fit_split: "train" },
          missing: { strategy: "forward_fill", limit: null },
          time: { frequency: "auto", allow_irregular: true, irregular_ratio_warn: 0.01 },
        },
        null,
        2,
      )}\n`,
      "utf8",
    )

    const posts: unknown[] = []
    const mismatchFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (url.pathname === "/research/tasks" && !init?.method) {
        return Promise.resolve(
          response([
            {
              id: taskID,
              projectID: "project_neo_cast",
              title: "Dataset Mismatch Task",
              domainID: "tsf",
              mode: "autonomous",
              status: "researching",
              taskSpec: {
                contextLength: 96,
                predictionLengths: [24],
                dataset: { loaderID: "etth1", path: "/tmp/ETTh1.csv", targetCols: ["OT"] },
                runtime: { bridgeOnly: false, neoCastProjectRoot: runnerRoot },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12, maxParallel: 1 },
              time: { created: now - 60_000, updated: now },
            },
          ]),
        )
      }
      if (url.pathname === `/research/tasks/${taskID}/prepare-dataset` && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)))
        return Promise.resolve(
          response({
            artifact: {
              id: "artifact_dataset_prepared",
              taskID,
              kind: "dataset_preparation_json",
              uri: "file:///tmp/dataset-preparation.json",
              metadata: {},
              time: { created: now, updated: now },
            },
            path: "/tmp/dataset-preparation.json",
            datasetSpec: {},
            command: {},
          }),
        )
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    let command: CommandDialog | undefined
    const app = await testRender(
      () => <ResearchCockpitHarness fetch={mismatchFetch} onCommand={(value) => (command = value)} />,
      { width: 170, height: 56 },
    )

    try {
      const frame = await waitForFrame(app, "Runner dataset mismatch")
      expect(frame).toContain("Prepared dataset does not match task")
      expect(frame).toContain("Prepare Dataset")
      expect(frame).not.toContain("Use Project Runner")

      command?.trigger("research.dataset.prepare")
      for (let attempt = 0; attempt < 40 && posts.length === 0; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      expect(posts).toEqual([{ force: true }])
    } finally {
      app.renderer.destroy()
    }
  })

  test("prepare dataset failures render a concise error instead of raw server JSON", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const runnerRoot = path.join("/tmp", `neo-cast-prepare-error-${Date.now()}`)
    await prepareNeoCastRunnerRoot(runnerRoot)
    await mkdir(path.join(runnerRoot, ".neo-cast"), { recursive: true })
    await writeFile(
      path.join(runnerRoot, ".neo-cast", "dataset_spec.json"),
      `${JSON.stringify(
        {
          schema_version: "dataset.v1",
          source_csv: "/tmp/old.csv",
          feature_columns: ["OT"],
          input_len: 512,
          horizons: [96],
        },
        null,
        2,
      )}\n`,
      "utf8",
    )

    const traceback = [
      "Error: Traceback (most recent call last):",
      '  File "/Users/chengmingyue/project/neo_cast/py/prepare_tsf_dataset.py", line 44, in <module>',
      "    main()",
      "ValueError: target column OT not found in exchange_rate.csv",
    ].join("\n")
    const failureFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestURL(input)
      if (url.pathname === "/research/tasks" && !init?.method) {
        return Promise.resolve(
          response([
            {
              id: taskID,
              projectID: "project_neo_cast",
              title: "Dataset Prepare Failure",
              domainID: "tsf",
              mode: "autonomous",
              status: "researching",
              taskSpec: {
                contextLength: 96,
                predictionLengths: [24],
                dataset: { loaderID: "exchange_rate", path: "/tmp/exchange_rate.csv", targetCols: ["OT"] },
                runtime: { bridgeOnly: false, neoCastProjectRoot: runnerRoot },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12, maxParallel: 1 },
              time: { created: now - 60_000, updated: now },
            },
          ]),
        )
      }
      if (url.pathname === `/research/tasks/${taskID}/prepare-dataset` && init?.method === "POST") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              name: "UnknownError",
              data: {
                message: traceback,
              },
            }),
            { status: 500, headers: { "content-type": "application/json" } },
          ),
        )
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    let command: CommandDialog | undefined
    const app = await testRender(
      () => <ResearchCockpitHarness fetch={failureFetch} onCommand={(value) => (command = value)} />,
      { width: 170, height: 56 },
    )

    try {
      await waitForFrame(app, "Runner dataset mismatch")
      command?.trigger("research.dataset.prepare")
      const frame = await waitForFrame(app, "prepare-dataset: ValueError: target column OT not found in exchange_rate.csv")

      expect(frame).not.toContain('{"name":"UnknownError"')
      expect(frame).not.toContain("Traceback (most recent call last)")
      expect(frame).not.toContain("prepare_tsf_dataset.py")
    } finally {
      app.renderer.destroy()
    }
  })

  test("start forecast prompt runs the recommended dataset preparation", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const runnerRoot = path.join("/tmp", `neo-cast-start-prepare-${Date.now()}`)
    await prepareNeoCastRunnerRoot(runnerRoot)
    await mkdir(path.join(runnerRoot, ".neo-cast"), { recursive: true })
    await writeFile(
      path.join(runnerRoot, ".neo-cast", "dataset_spec.json"),
      `${JSON.stringify(
        {
          schema_version: "dataset.v1",
          source_csv: "/tmp/old.csv",
          feature_columns: ["OT"],
          input_len: 512,
          horizons: [96, 192, 336, 720],
        },
        null,
        2,
      )}\n`,
      "utf8",
    )

    const posts: Array<{ path: string; body: unknown }> = []
    const mismatchFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (init?.method === "POST") {
        posts.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined })
      }
      if (url.pathname === "/research/tasks" && !init?.method) {
        return Promise.resolve(
          response([
            {
              id: taskID,
              projectID: "project_neo_cast",
              title: "Dataset Mismatch Task",
              domainID: "tsf",
              mode: "autonomous",
              status: "researching",
              taskSpec: {
                contextLength: 96,
                predictionLengths: [24],
                dataset: { loaderID: "etth1", path: "/tmp/ETTh1.csv", targetCols: ["OT"] },
                runtime: { bridgeOnly: false, neoCastProjectRoot: runnerRoot },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12, maxParallel: 1 },
              time: { created: now - 60_000, updated: now },
            },
          ]),
        )
      }
      if (url.pathname === `/research/tasks/${taskID}/prepare-dataset` && init?.method === "POST") {
        return Promise.resolve(
          response({
            artifact: {
              id: "artifact_dataset_prepared",
              taskID,
              kind: "dataset_preparation_json",
              uri: "file:///tmp/dataset-preparation.json",
              metadata: {},
              time: { created: now, updated: now },
            },
            path: "/tmp/dataset-preparation.json",
            datasetSpec: {},
            command: {},
          }),
        )
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={mismatchFetch} />, {
      width: 170,
      height: 56,
    })

    try {
      await waitForFrame(app, "Runner dataset mismatch")
      await app.mockInput.typeText("开始预测")
      app.mockInput.pressEnter()
      for (let attempt = 0; attempt < 40 && posts.length === 0; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      expect(posts).toEqual([{ path: `/research/tasks/${taskID}/prepare-dataset`, body: { force: true } }])
    } finally {
      app.renderer.destroy()
    }
  })

  test("agent loop repairs a dataset mismatch before starting autonomous loop", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const runnerRoot = path.join("/tmp", `neo-cast-agent-loop-dataset-mismatch-${Date.now()}`)
    await prepareNeoCastRunnerRoot(runnerRoot)
    await mkdir(path.join(runnerRoot, ".neo-cast"), { recursive: true })
    await writeFile(
      path.join(runnerRoot, ".neo-cast", "dataset_spec.json"),
      `${JSON.stringify(
        {
          schema_version: "dataset.v1",
          source_csv: "/tmp/other.csv",
          task_id: "etth1",
          timestamp_col: "date",
          feature_columns: ["OT"],
          input_len: 96,
          horizons: [48],
          splits: { train: [0, 100], val: [100, 140], ref_test: [140, 180] },
          normalization: { type: "standard", fit_split: "train" },
          missing: { strategy: "forward_fill", limit: null },
          time: { frequency: "auto", allow_irregular: true, irregular_ratio_warn: 0.01 },
        },
        null,
        2,
      )}\n`,
      "utf8",
    )

    const posts: Array<{ path: string; body: unknown }> = []
    const mismatchFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (url.pathname === "/research/tasks" && !init?.method) {
        return Promise.resolve(
          response([
            {
              id: taskID,
              projectID: "project_neo_cast",
              title: "Dataset Mismatch Task",
              domainID: "tsf",
              mode: "autonomous",
              status: "researching",
              taskSpec: {
                contextLength: 96,
                predictionLengths: [24],
                dataset: { loaderID: "etth1", path: "/tmp/ETTh1.csv", targetCols: ["OT"] },
                runtime: { bridgeOnly: false, neoCastProjectRoot: runnerRoot },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12, maxParallel: 1 },
              time: { created: now - 60_000, updated: now },
            },
          ]),
        )
      }
      if (url.pathname === `/research/tasks/${taskID}/prepare-dataset` && init?.method === "POST") {
        posts.push({ path: url.pathname, body: JSON.parse(String(init.body)) })
        return Promise.resolve(
          response({
            artifact: {
              id: "artifact_dataset_prepared",
              taskID,
              kind: "dataset_preparation_json",
              uri: "file:///tmp/dataset-preparation.json",
              metadata: {},
              time: { created: now, updated: now },
            },
            path: "/tmp/dataset-preparation.json",
            datasetSpec: {},
            command: {},
          }),
        )
      }
      if (url.pathname === `/research/tasks/${taskID}/autonomous/loop` && init?.method === "POST") {
        posts.push({ path: url.pathname, body: JSON.parse(String(init.body)) })
        return Promise.resolve(response({ iterations: [], stoppedReason: "max_iterations" }))
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    let command: CommandDialog | undefined
    const app = await testRender(
      () => <ResearchCockpitHarness fetch={mismatchFetch} onCommand={(value) => (command = value)} />,
      { width: 170, height: 56 },
    )

    try {
      await waitForFrame(app, "Runner dataset mismatch")
      command?.trigger("research.autonomous.loop")
      for (let attempt = 0; attempt < 40 && posts.length < 2; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      expect(posts).toEqual([
        { path: `/research/tasks/${taskID}/prepare-dataset`, body: { force: true } },
        {
          path: `/research/tasks/${taskID}/autonomous/loop`,
          body: { stage: "full", maxIterations: 50, description: "cockpit autonomous loop" },
        },
      ])
    } finally {
      app.renderer.destroy()
    }
  })

  test("project runner repair prefers a nested neo_cast runner when the workspace contains one", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const workspace = path.join("/tmp", `neo-research-workspace-${Date.now()}`)
    const opencodeRoot = path.join(workspace, "opencode")
    const runnerRoot = path.join(workspace, "neo_cast")
    await mkdir(opencodeRoot, { recursive: true })
    await prepareNeoCastRunnerRoot(runnerRoot)

    const patches: unknown[] = []
    const missingRunnerFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (url.pathname === "/research/tasks" && !init?.method) {
        return Promise.resolve(
          response([
            {
              id: taskID,
              projectID: "project_neo_cast",
              title: "Nested Runner Task",
              domainID: "tsf",
              mode: "autonomous",
              status: "researching",
              taskSpec: {
                contextLength: 96,
                predictionLengths: [24],
                runtime: { bridgeOnly: false },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12, maxParallel: 1 },
              time: { created: now - 60_000, updated: now },
            },
          ]),
        )
      }
      if (url.pathname === `/research/tasks/${taskID}/spec` && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body))
        patches.push(body)
        return Promise.resolve(
          response({
            id: taskID,
            title: "Nested Runner Task",
            domainID: "tsf",
            mode: "autonomous",
            status: "researching",
            taskSpec: body.taskSpec,
            objective: {},
            budget: { maxRuns: 12 },
            time: { created: now, updated: now },
          }),
        )
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    let command: CommandDialog | undefined
    const app = await testRender(
      () => (
        <ResearchCockpitHarness
          fetch={missingRunnerFetch}
          directory={opencodeRoot}
          onCommand={(value) => (command = value)}
        />
      ),
      { width: 170, height: 56 },
    )

    try {
      await waitForFrame(app, "Runner root missing")
      command?.trigger("research.runner.useProject")
      for (let attempt = 0; attempt < 40 && patches.length === 0; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      expect(patches).toEqual([
        {
          taskSpec: {
            contextLength: 96,
            predictionLengths: [24],
            runtime: { bridgeOnly: false, neoCastProjectRoot: runnerRoot },
          },
        },
      ])
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps right sidebar diagnostics readable when runner script is missing", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")
    const missingScriptRoot = "/tmp/neo-cast-no-script"
    await mkdir(missingScriptRoot, { recursive: true })

    const missingScriptFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (url.pathname === "/research/tasks" && !init?.method) {
        return Promise.resolve(
          response([
            {
              id: taskID,
              projectID: "project_neo_cast",
              title: "Missing Runner Script Task",
              domainID: "tsf",
              mode: "autonomous",
              status: "researching",
              taskSpec: {
                contextLength: 96,
                predictionLengths: [24],
                runtime: { bridgeOnly: false, neoCastProjectRoot: missingScriptRoot },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12, maxParallel: 1 },
              time: { created: now - 60_000, updated: now },
            },
          ]),
        )
      }
      if (url.pathname === `/research/tasks/${taskID}/candidates`) return Promise.resolve(response([]))
      if (url.pathname === `/research/tasks/${taskID}/runs`) return Promise.resolve(response([]))
      if (url.pathname === `/research/tasks/${taskID}/champion`) return Promise.resolve(response([]))
      if (url.pathname === `/research/tasks/${taskID}/artifacts`) return Promise.resolve(response([]))
      if (url.pathname === `/research/tasks/${taskID}/approvals`) return Promise.resolve(response([]))
      if (url.pathname === `/research/tasks/${taskID}/fingerprint`) return Promise.resolve(response({}))
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(
      () => <ResearchCockpitHarness fetch={missingScriptFetch} directory="/Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf" />,
      { width: 140, height: 48 },
    )

    try {
      const frame = await waitForFrame(app, "Runner script missing")

      expect(frame).toContain("Set runner root before runs.")
      expect(frame).toContain("Missing py/validate.py")
      expect(frame).toContain(".../neo_research_for_tsf")
      expect(frame).not.toContain("Neo-Cast smoke runner is missing:")
      expect(frame).not.toContain("Set taskSpec.runtime.neoCastProjectRoot")
    } finally {
      app.renderer.destroy()
    }
  })

  test("error log keeps more than the sidebar tail visible", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const failingActionsFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (url.pathname === `/research/tasks/${taskID}/baselines` && init?.method === "POST") {
        return Promise.resolve(new Response("seed failed for review", { status: 500 }))
      }
      if (url.pathname === `/research/tasks/${taskID}/profile` && init?.method === "POST") {
        return Promise.resolve(new Response("profile failed for review", { status: 500 }))
      }
      if (url.pathname === `/research/tasks/${taskID}/export` && init?.method === "POST") {
        return Promise.resolve(new Response("export failed for review", { status: 500 }))
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    let command: CommandDialog | undefined
    const app = await testRender(
      () => <ResearchCockpitHarness fetch={failingActionsFetch} onCommand={(value) => (command = value)} />,
      { width: 170, height: 56 },
    )

    try {
      await waitForFrame(app, "smoke succeeded")
      command?.trigger("research.seed.baselines")
      await waitForFrame(app, "seed failed for review")

      command?.trigger("research.profile.task")
      await waitForFrame(app, "profile failed for review")

      command?.trigger("research.export.report")
      const frame = await waitForFrame(app, "export failed for review")

      expect(frame).not.toContain("Error Log")
      expect(frame).toContain("seed-baselines")
      expect(frame).toContain("seed failed for review")
      expect(frame).toContain("profile-task")
      expect(frame).toContain("profile failed for review")
      expect(frame).toContain("export-artifact")
      expect(frame).toContain("export failed for review")
    } finally {
      app.renderer.destroy()
    }
  })

  test("prompt event history keeps more than the last five entries", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const reviewTaskFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (url.pathname === "/research/tasks" && !init?.method) {
        return Promise.resolve(
          response([
            {
              id: taskID,
              projectID: "project_neo_cast",
              title: "Review Task",
              domainID: "tsf",
              mode: "review",
              status: "researching",
              taskSpec: { runtime: { bridgeOnly: false, neoCastProjectRoot: "/tmp/neo-cast" } },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12, maxParallel: 1 },
              time: { created: now - 60_000, updated: now },
            },
          ]),
        )
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={reviewTaskFetch} />, { width: 170, height: 72 })

    try {
      await waitForFrame(app, "smoke succeeded")
      for (const index of [1, 2, 3, 4, 5, 6]) {
        await app.mockInput.typeText(`note ${index}`)
        await app.renderOnce()
        app.mockInput.pressEnter()
        await app.renderOnce()
        await Bun.sleep(25)
      }

      const frame = await waitForFrame(app, "note 6")
      expect(frame).not.toContain("Prompt History")
      expect(frame).toContain("note 1")
      expect(frame).toContain("note 6")
    } finally {
      app.renderer.destroy()
    }
  })

  test("long running actions show an explicit busy state", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    let resolveBaselines: ((value: Response) => void) | undefined
    const slowFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (url.pathname === `/research/tasks/${taskID}/baselines` && init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          resolveBaselines = resolve
        })
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    let command: CommandDialog | undefined
    const app = await testRender(
      () => <ResearchCockpitHarness fetch={slowFetch} onCommand={(value) => (command = value)} />,
      { width: 160, height: 48 },
    )

    try {
      await waitForFrame(app, "smoke succeeded")
      command?.trigger("research.seed.baselines")
      const frame = await waitForFrame(app, "Working / seed-baselines")

      expect(frame).not.toContain("Active Action")
      expect(frame).not.toContain("Running seed-baselines")
      expect(frame).toMatch(/Working \/ seed-baselines \/ 0s \[[=> ]+\]/)
      expect(frameLine(frame, "Working / seed-baselines")).toBeLessThan(frameLine(frame, "esc interrupt"))
      resolveBaselines?.(response({ candidates: [], approvals: [] }))
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders DataAnalysis and HypoPlanner agent completed events in stream lines", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const events = createCockpitEventSource()
    const app = await testRender(
      () => <ResearchCockpitHarness fetch={researchFetch} events={events.source} />,
      { width: 160, height: 48 },
    )

    try {
      await waitForFrame(app, "smoke succeeded")

      // DataAnalysis: LLM not configured → "skipped". No completion summary/placeholder is
      // synthesized — without a prior "started" event there's no live stream to show, so no
      // [DataAnalysis] block appears at all.
      events.emit({
        type: "research.agent.dataAnalysis.completed",
        properties: {
          taskID,
          agent: "DataAnalysisAgent",
          stage: "data_analysis",
          status: "completed",
          metadata: { llmStatus: "skipped", warningCount: 0, searchBiases: [] },
        },
      })
      await app.renderOnce()
      expect(app.captureCharFrame()).not.toContain("heuristic — LLM not configured")

      // HypoPlanner: LLM not configured → "skipped". The [HypoPlanner] header still appears
      // (it labels the completed step) but no fallback summary/placeholder body is appended.
      events.emit({
        type: "research.agent.hypoPlanner.completed",
        properties: {
          taskID,
          agent: "HypoPlannerAgent",
          stage: "hypo_planning",
          status: "completed",
          metadata: { llmStatus: "skipped", hypothesisCount: 3 },
        },
      })
      const frameAfterHP = await waitForFrame(app, "[HypoPlanner]")
      expect(frameAfterHP).toContain("[HypoPlanner]")
      expect(frameAfterHP).not.toContain("heuristic — LLM not configured")

      // HypoPlanner: LLM used with a preview — the preview text is no longer rendered.
      events.emit({
        type: "research.agent.hypoPlanner.completed",
        properties: {
          taskID,
          agent: "HypoPlannerAgent",
          stage: "hypo_planning",
          status: "completed",
          metadata: {
            llmStatus: "used",
            hypothesisCount: 2,
            llmPreview: "h1: RevIN normalisation | h2: Patch-based context window",
          },
        },
      })
      await app.renderOnce()
      expect(app.captureCharFrame()).not.toContain("h1: RevIN")
    } finally {
      app.renderer.destroy()
    }
  })

  test("DataAnalysis stream renders below a pending intent checkpoint", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")
    const intentApproval = {
      id: "approval_intent_01",
      kind: "protocol",
      status: "pending",
      reason: "[checkpoint:intent_confirmed]\nIntent requirements confirmed.",
      time: { created: now - 7_000, updated: now - 7_000 },
    }
    const intentFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const p = requestURL(input).pathname
      if (p === `/research/tasks/${taskID}/approvals`) return Promise.resolve(response([intentApproval]))
      return mockResearchFetch(input, init)
    }) as typeof fetch
    const events = createCockpitEventSource()
    const app = await testRender(
      () => <ResearchCockpitHarness fetch={intentFetch} events={events.source} />,
      { width: 160, height: 48 },
    )
    try {
      await waitForFrame(app, "Approval requested")
      events.emit({ type: "research.agent.dataAnalysis.started", properties: { taskID } })
      const frame = await waitForFrame(app, "[DataAnalysis]")
      expect(frameLine(frame, "Approval requested")).toBeLessThan(frameLine(frame, "[DataAnalysis]"))
    } finally {
      app.renderer.destroy()
    }
  })

  test("confirmed intent_confirmed banner stays above DataAnalysis and HypoPlanner after /approve", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")
    const intentApproval = {
      id: "approval_intent_01",
      taskID,
      kind: "protocol",
      status: "pending",
      reason: "[checkpoint:intent_confirmed]\nIntent requirements confirmed.",
      time: { created: now - 7_000, updated: now - 7_000 },
    }
    let approvalStatus: "pending" | "approved" = "pending"
    const intentFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestURL(input)
      const method = requestMethod(input, init)
      if (url.pathname === `/research/tasks/${taskID}/approvals`) {
        return response([{ ...intentApproval, status: approvalStatus }])
      }
      if (method === "POST" && url.pathname === `/research/approvals/${intentApproval.id}/reply`) {
        approvalStatus = "approved"
        return response({ ...intentApproval, status: "approved" })
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch
    const events = createCockpitEventSource()
    const app = await testRender(
      () => <ResearchCockpitHarness fetch={intentFetch} events={events.source} />,
      { width: 160, height: 48 },
    )
    try {
      await waitForFrame(app, "Approval requested")
      await app.mockInput.typeText("/approve")
      await app.renderOnce()
      app.mockInput.pressEnter()

      await waitForFrame(app, "[intent_confirmed] approved")

      events.emit({ type: "research.agent.dataAnalysis.started", properties: { taskID } })
      let frame = await waitForFrame(app, "[DataAnalysis]")
      expect(frameLine(frame, "[intent_confirmed] approved")).toBeLessThan(frameLine(frame, "[DataAnalysis]"))

      events.emit({ type: "research.agent.hypoPlanner.started", properties: { taskID } })
      frame = await waitForFrame(app, "[HypoPlanner]")
      expect(frameLine(frame, "[intent_confirmed] approved")).toBeLessThan(frameLine(frame, "[HypoPlanner]"))
    } finally {
      app.renderer.destroy()
    }
  })
})
