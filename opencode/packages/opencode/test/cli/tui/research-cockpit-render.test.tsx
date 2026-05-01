/** @jsxImportSource @opentui/solid */
import { beforeAll, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Global } from "@opencode-ai/core/global"
import { chmod, mkdir, writeFile } from "fs/promises"
import path from "path"
import { CommandProvider, useCommandDialog } from "../../../src/cli/cmd/tui/component/dialog-command"
import { KeybindProvider } from "../../../src/cli/cmd/tui/context/keybind"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { ProjectProvider } from "../../../src/cli/cmd/tui/context/project"
import { RouteProvider, useRoute, type Route } from "../../../src/cli/cmd/tui/context/route"
import { SDKProvider } from "../../../src/cli/cmd/tui/context/sdk"
import { ThemeProvider } from "../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import { ResearchCockpit } from "../../../src/cli/cmd/tui/routes/research-cockpit"
import { DialogProvider } from "../../../src/cli/cmd/tui/ui/dialog"
import { ToastProvider } from "../../../src/cli/cmd/tui/ui/toast"

const now = 1_765_000_000_000
const taskID = "task_neo_cast_01"
const candidateID = "cand_phase2_01"
const runID = "run_smoke_01"

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
          resourceUsage: { wallClockSec: 4 },
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

function ResearchCockpitHarness(
  props: {
    fetch?: typeof fetch
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
              events={{ subscribe: async () => () => {} }}
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
  test("renders a stream-only empty workspace before any task exists", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const emptyFetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(response([]))) as unknown as typeof fetch
    const app = await testRender(() => <ResearchCockpitHarness fetch={emptyFetch} />, { width: 160, height: 48 })

    try {
      const frame = await waitForFrame(app, "Research Agent")

      expect(frame).toContain("NeoResearch Workspace")
      expect(frame).toContain("Create research task")
      expect(frame).toContain("Profile dataset")
      expect(frame).toContain("Design candidates")
      expect(frame).not.toContain("Workflow")
      expect(frame).not.toContain("Next Action")
      expect(frame).not.toContain("Thinking:")
      expect(frame).not.toContain("generate_model")
      expect(frame).not.toContain("# Todos")
      expect(frame).not.toContain("Round 1:")
      expect(frame).not.toContain("Forecaster . glm-5.1")
      expect(frame).not.toContain("Start with New CSV Task")
      expect(frame).not.toContain("Select or create a research task")
      expect(frame).toContain("ctrl+p commands")
      expect(frame).not.toContain("esc interrupt")
      expect(frame).not.toContain("tab agents")
      expect(frameLine(frame, "Research Agent")).toBeGreaterThanOrEqual(38)
      expect(frameLine(frame, "ctrl+p commands")).toBeGreaterThan(frameLine(frame, "Research Agent"))
    } finally {
      app.renderer.destroy()
    }
  })

  test("submitting a prompt in an empty cockpit sends a chat message instead of creating a task", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const posts: Array<{ path: string; body: unknown }> = []
    const promptFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const handled = await mockChatResponse(
        input,
        init,
        posts,
        "我可以先帮你确认数据集、预测长度和 runner 环境；创建实验请使用 New CSV Task。",
      )
      if (handled) return handled
      return Promise.resolve(response([]))
    }) as typeof fetch
    const app = await testRender(() => <ResearchCockpitHarness fetch={promptFetch} />, { width: 160, height: 48 })

    try {
      await waitForFrame(app, "Research Agent")
      await app.mockInput.typeText("Forecast ETTh1 horizon 24")
      await app.renderOnce()

      let frame = app.captureCharFrame()
      expect(frame).toContain("Forecast ETTh1 horizon 24")
      app.mockInput.pressEnter()
      frame = await waitForFrame(app, "Research Agent: 我可以先帮你确认数据集")
      expect(posts.map((post) => post.path)).toEqual(["/session", "/session/session_research_chat/message"])
      expect(posts.map((post) => post.path)).not.toContain("/research/tasks")
      expect(frame).toContain("You: Forecast ETTh1 horizon 24")
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
      await app.mockInput.typeText("hi")
      await app.renderOnce()
      app.mockInput.pressEnter()

      const frame = await waitForFrame(app, "No AI provider is configured")
      expect(frame).toContain("You: hi")
      expect(posts.map((post) => post.path)).not.toContain("/research/tasks")
    } finally {
      app.renderer.destroy()
    }
  })

  test("submitting a prompt on an active autonomous task uses the chat API", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const posts: Array<{ path: string; body: unknown }> = []
    const promptFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const handled = await mockChatResponse(input, init, posts, "建议先处理当前 smoke run 的失败原因，再启动下一轮实验。")
      if (handled) return handled
      return mockResearchFetch(input, init)
    }) as typeof fetch
    const app = await testRender(() => <ResearchCockpitHarness fetch={promptFetch} />, { width: 160, height: 48 })

    try {
      await waitForFrame(app, "run_smoke")
      await app.mockInput.typeText("请给出下一步实验建议")
      await app.renderOnce()
      app.mockInput.pressEnter()

      const frame = await waitForFrame(app, "Research Agent: 建议先处理当前 smoke run")

      expect(posts.map((post) => post.path)).toContain("/session/session_research_chat/message")
      expect(posts.map((post) => post.path)).not.toContain(`/research/tasks/${taskID}/autonomous/iterate`)
      expect(frame).toContain("You: 请给出下一步实验建议")
    } finally {
      app.renderer.destroy()
    }
  })

  test("submitting a normal prompt sends it through the chat session API and renders the assistant reply", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const posts: Array<{ path: string; body: unknown }> = []
    const chatFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const handled = await mockChatResponse(
        input,
        init,
        posts,
        "当前任务还在 smoke 阶段，下一步应先修复 runner 路径再继续实验。",
      )
      if (handled) return handled
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={chatFetch} />, { width: 170, height: 48 })

    try {
      await waitForFrame(app, "run_smoke")
      await app.mockInput.typeText("请解释当前状态")
      await app.renderOnce()
      app.mockInput.pressEnter()

      const frame = await waitForFrame(app, "Research Agent: 当前任务还在 smoke 阶段")
      expect(posts.map((post) => post.path)).toContain("/session")
      expect(posts.map((post) => post.path)).toContain("/session/session_research_chat/message")
      expect(posts.map((post) => post.path)).not.toContain(`/research/tasks/${taskID}/autonomous/iterate`)
      expect(frame).toContain("You: 请解释当前状态")
      expect(posts.find((post) => post.path === "/session/session_research_chat/message")?.body).toMatchObject({
        agent: "Research Agent",
        model: { providerID: "openai", modelID: "gpt-test" },
        parts: expect.arrayContaining([
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
      await waitForFrame(app, "run_smoke")
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
      await waitForFrame(app, "run_smoke")
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
      await waitForFrame(app, "run_smoke")
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

    const posts: Array<{ path: string; body: unknown }> = []
    const actionFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const handled = await mockChatResponse(input, init, posts, "可以尝试 mixer，但先确认当前 PatchTST 基线是否稳定。")
      if (handled) return handled
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={actionFetch} />, { width: 160, height: 48 })

    try {
      await waitForFrame(app, "run_smoke")
      await app.mockInput.typeText("try mixer next")
      await app.renderOnce()
      app.mockInput.pressEnter()

      const frame = await waitForFrame(app, "Research Agent: 可以尝试 mixer")
      expect(posts.map((post) => post.path)).toContain("/session/session_research_chat/message")
      expect(posts.map((post) => post.path)).not.toContain(`/research/tasks/${taskID}/autonomous/iterate`)
      expect(frame).toContain("You: try mixer next")
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
      await waitForFrame(app, "run_smoke")
      const displays = command?.slashes().map((slash) => slash.display.trim()) ?? []

      expect(displays).toEqual(
        expect.arrayContaining(["/seed-baselines", "/profile", "/next", "/agent-loop", "/export", "/ref-gate", "/blind-gate"]),
      )
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
      const frame = await waitForFrame(app, "Home alt+h")
      expect(frame).not.toContain("Home ^H")

      app.mockInput.pressKey("h", { ctrl: true })
      await app.renderOnce()
      expect(route?.data.type).toBe("cockpit")

      app.mockInput.pressKey("h", { meta: true })
      for (let attempt = 0; attempt < 20 && route?.data.type !== "home"; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }
      expect(route?.data.type).toBe("home")
    } finally {
      app.renderer.destroy()
    }
  })

  test("typing slash opens the cockpit command popup", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const app = await testRender(() => <ResearchCockpitHarness />, { width: 160, height: 48 })

    try {
      await waitForFrame(app, "run_smoke")
      await app.mockInput.typeText("/")
      const frame = await waitForFrame(app, "Selected /seed-baselines")

      expect(frame).toContain("Selected /seed-baselines")
      expect(frame).toContain("/agent-loop")
      expect(frame).toContain("/ref-gate")
      expect(frame).toContain("/blind-gate")
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
      }
      return mockResearchFetch(input, init)
    }) as typeof fetch

    const app = await testRender(() => <ResearchCockpitHarness fetch={actionFetch} />, { width: 160, height: 48 })

    try {
      await waitForFrame(app, "run_smoke")
      await app.mockInput.typeText("/")
      await app.renderOnce()
      app.mockInput.pressEnter()

      for (let attempt = 0; attempt < 40 && posts.length === 0; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      expect(posts.map((post) => post.path)).toContain(`/research/tasks/${taskID}/baselines`)
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
      await waitForFrame(app, "run_smoke")
      await app.mockInput.typeText("/exi")
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("/exit")

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
      await waitForFrame(app, "run_smoke")
      await app.mockInput.typeText("/")
      await app.renderOnce()
      app.mockInput.pressKey("ARROW_DOWN")
      app.mockInput.pressEnter()

      for (let attempt = 0; attempt < 40 && posts.length === 0; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      expect(posts).toContainEqual({
        path: `/research/tasks/${taskID}/autonomous/loop`,
        body: { stage: "smoke", maxIterations: 3, description: "cockpit autonomous loop" },
      })
      expect(posts.map((post) => post.path)).not.toContain(`/research/tasks/${taskID}/baselines`)
    } finally {
      app.renderer.destroy()
    }
  })

  test("creates a full-recipe autonomous task from a routed home goal", async () => {
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
      if (url.pathname === "/research/tasks/task_from_home_goal/autonomous/iterate" && init?.method === "POST") {
        return Promise.resolve(response(iterationAnswerFixture(candidateFixture(9), { id: "run_home_answer", status: "succeeded" })))
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
      const frame = await waitForFrame(app, "iteration succeeded / cand_phase2_09 / val_avg_mse=0.081")

      expect(posts).toHaveLength(2)
      expect(posts[0]).toMatchObject({
        path: "/research/tasks",
        body: {
          title: "Forecast ETTh1 horizon 24",
          mode: "autonomous",
          taskSpec: {
            runtime: {
              bridgeOnly: false,
              neoCastProjectRoot: "/tmp/neo-cast-research",
            },
            metadata: {
              userPrompt: "Forecast ETTh1 horizon 24",
              source: "home",
            },
          },
        }
      })
      expect(posts[1]).toEqual({
        path: "/research/tasks/task_from_home_goal/autonomous/iterate",
        body: {
          stage: "smoke",
          description: "Forecast ETTh1 horizon 24",
        }
      })
      expect(frame).toContain("You: Forecast ETTh1 horizon 24")
      expect(frame).toContain("manager diagnostic>runner")
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
      const frame = await waitForFrame(app, "Forecast missing runner created from home goal")

      expect(posts.map((post) => post.path)).toEqual(["/research/tasks"])
      expect(frame).toContain("You: Forecast missing runner")
      expect(frame).not.toContain("submitted to research agent")
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders a chat-style research workspace with progress sidebar", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const app = await testRender(() => <ResearchCockpitHarness />, { width: 160, height: 48 })

    try {
      const frame = await waitForFrame(app, "run_smoke")

      expect(frame).toContain("NeoResearch Workspace")
      expect(frame).toContain("Neo-Cast Autonomous TSF")
      expect(frame).toContain("Progress")
      expect(frame).toContain("Planner")
      expect(frame).toContain("[o] Forecaster 1/12 experiments")
      expect(frame).toContain("Critic")
      expect(frame).toContain("Context")
      expect(frame).toContain("Task 1/1")
      expect(frame).toContain("Home")
      expect(frame).toContain("Champion")
      expect(frame).toContain("metric=0.1234")
      expect(frame).toContain("utility=0.88")
      expect(frame).toContain("Research Agent")
      expect(frame).toContain("run_smoke")
      expect(frame).toContain("smoke succeeded")
      expect(frame).toContain("Candidate Table")
      expect(frame).toContain("phase2_frequency_rnn_quantile")
      expect(frame).toContain("frequency_filter+instance_norm")
      expect(frame).toContain("Smoke Prep")
      expect(frame).toContain("Smoke Exec")
      expect(frame).toContain("Ref Gate")
      expect(frame).toContain("Seed Sweep")
      expect(frame).toContain("Run History")
      expect(frame).toContain("Artifacts")
      expect(frame).toContain("ranker=tsf_profile_learned_memory_ranker_v1")
      expect(frame).toContain("Memory")
      expect(frame).toContain("Frequency preprocessing helped the smoke objective.")
      expect(frame).not.toContain("LSPs will activate as files are read")
      expect(frame).not.toContain("esc interrupt")
      expect(frame).not.toContain("tab agents")
      expect(frame).not.toContain("State")
      expect(frame).not.toContain("Current state:")
      expect(frame).not.toContain("Next Action")
      expect(frame).not.toContain("Round 1:")
      expect(frame).not.toContain("generate_model")
      expect(occurrenceCount(frame, "Workflow")).toBe(0)
      expect(frameLine(frame, "Research Agent")).toBeGreaterThanOrEqual(38)
      expect(frameLine(frame, "ctrl+p commands")).toBeGreaterThan(frameLine(frame, "Research Agent"))
    } finally {
      app.renderer.destroy()
    }
  })

  test("clips long workspace rows before the right sidebar in narrow terminals", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const app = await testRender(() => <ResearchCockpitHarness />, { width: 160, height: 48 })

    try {
      await waitForFrame(app, "phase2_frequency_rnn_quantile")
      app.resize(96, 48)
      const frame = await waitForFrame(app, "phase2_frequency_rnn_quantile")
      const titleLine = frameTextLine(frame, "Neo-Cast Autonomous TSF")
      expect(titleLine).toBeDefined()
      const sidebarColumn = titleLine!.indexOf("Neo-Cast Autonomous TSF")
      expect(sidebarColumn).toBeGreaterThan(0)

      const candidateLine = frameTextLine(frame, "phase2_frequency_rnn_quantile")
      expect(candidateLine).toBeDefined()
      expect(candidateLine!.slice(sidebarColumn)).not.toContain("approved")
      expect(candidateLine!.slice(sidebarColumn)).not.toContain("smoke")
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps the prompt composer compact for a single-line prompt", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const app = await testRender(() => <ResearchCockpitHarness />, { width: 160, height: 48 })

    try {
      const frame = await waitForFrame(app, "run_smoke")
      const promptLine = frameLine(frame, "Ask for the next experiment")
      const footerLine = frameLine(frame, "enter submit")

      expect(footerLine - promptLine).toBeLessThanOrEqual(3)
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

      expect(frame).toContain("Latest Failure")
      expect(frame).toContain("run_failed_smoke smoke failed")
      expect(frame).toContain("ModuleNotFoundError: No module named 'torch'")
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
      await waitForFrame(app, "run_smoke")
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

  test("CSV task command opens a prompt dialog that accepts input", async () => {
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
      await waitForFrame(app, "Neo-Cast Autonomous TSF")
      command?.trigger("research.create.autonomous.csv")
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

  test("cockpit route can open the CSV task dialog immediately", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const app = await testRender(
      () => <ResearchCockpitHarness initialRoute={{ type: "cockpit", newCsvTask: true } as Route} />,
      { width: 160, height: 48 },
    )

    try {
      const frame = await waitForFrame(app, "CSV dataset path")

      expect(frame).toContain("/path/to/ETTh1.csv target=OT horizon=24 context=96 full")
    } finally {
      app.renderer.destroy()
    }
  })

  test("ctrl-n opens the CSV task dialog from the cockpit", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const app = await testRender(() => <ResearchCockpitHarness />, { width: 160, height: 48 })

    try {
      await waitForFrame(app, "New CSV Task ^N")
      app.mockInput.pressKey("n", { ctrl: true })

      const frame = await waitForFrame(app, "CSV dataset path")
      expect(frame).toContain("/path/to/ETTh1.csv target=OT horizon=24 context=96 full")
    } finally {
      app.renderer.destroy()
    }
  })

  test("clicking the cockpit New CSV Task action opens the CSV dialog", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const app = await testRender(() => <ResearchCockpitHarness />, { width: 160, height: 48 })

    try {
      const frame = await waitForFrame(app, "New CSV Task ^N")
      const lines = frame.split("\n")
      const y = lines.findIndex((line) => line.includes("New CSV Task ^N"))
      const x = lines[y].indexOf("New CSV Task ^N") + 2

      await app.mockMouse.click(x, y)
      const nextFrame = await waitForFrame(app, "CSV dataset path")

      expect(nextFrame).toContain("/path/to/ETTh1.csv target=OT horizon=24 context=96 full")
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
      await waitForFrame(app, "Recent TSF Task")
      command?.trigger("research.task.next")
      const frame = await waitForFrame(app, "Older TSF Task")

      expect(frame).toContain("Task 2/2")
      expect(frame).toContain("Previous Task")
      expect(frame).toContain("Next Task")
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
      await waitForFrame(app, "run_smoke")
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
      await waitForFrame(app, "run_smoke")
      command?.trigger("research.next.run")
      for (let attempt = 0; attempt < 40 && posts.length === 0; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      expect(posts).toContainEqual({
        path: `/research/tasks/${taskID}/autonomous/loop`,
        body: { stage: "smoke", maxIterations: 3, description: "cockpit autonomous loop" },
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
      await waitForFrame(app, "run_smoke")
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
      let frame = await waitForFrame(app, "Candidate 1/5")

      expect(frame).toContain("Candidate 1/5")
      expect(frame).toContain("Candidate Table")
      expect(frame).toContain("phase2_candidate_01")
      expect(frame).toContain("Smoke Prep")
      expect(frame).toContain("Smoke Exec")
      expect(frame).toContain("Ref Gate")
      expect(frame).toContain("Seed Sweep")

      command?.trigger("research.candidate.next")
      command?.trigger("research.candidate.next")
      command?.trigger("research.candidate.next")
      frame = await waitForFrame(app, "Candidate 4/5")

      expect(frame).toContain("Candidate 4/5")
      expect(frame).toContain("phase2_candidate_04")
      expect(frame).toContain("Smoke Exec")

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
      const frame = await waitForFrame(app, "Missing Runner Task")
      expect(frame).toContain("Use Project Runner")

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
      await waitForFrame(app, "run_smoke")
      command?.trigger("research.seed.baselines")
      await waitForFrame(app, "seed failed for review")

      command?.trigger("research.profile.task")
      await waitForFrame(app, "profile failed for review")

      command?.trigger("research.export.report")
      const frame = await waitForFrame(app, "export failed for review")

      expect(frame).toContain("Error Log")
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
      await waitForFrame(app, "Review Task")
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
      await waitForFrame(app, "run_smoke")
      command?.trigger("research.seed.baselines")
      const frame = await waitForFrame(app, "Running seed-baselines")

      expect(frame).toContain("Active Action")
      expect(frame).toContain("Running seed-baselines")
      resolveBaselines?.(response({ candidates: [], approvals: [] }))
    } finally {
      app.renderer.destroy()
    }
  })
})
