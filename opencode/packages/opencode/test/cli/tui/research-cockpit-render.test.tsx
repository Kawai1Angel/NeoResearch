/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Global } from "@opencode-ai/core/global"
import { mkdir, writeFile } from "fs/promises"
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

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function mockResearchFetch(input: RequestInfo | URL, _init?: RequestInit) {
  const url = new URL(input.toString())
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

function CommandProbe(props: { onReady: (command: CommandDialog) => void }) {
  props.onReady(useCommandDialog())
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
    initialRoute?: Route
  } = {},
) {
  return (
    <KVProvider>
      <ToastProvider>
        <RouteProvider initialRoute={props.initialRoute ?? { type: "cockpit" }}>
          <TuiConfigProvider config={{ theme: "opencode" }}>
            <SDKProvider
              url="http://mock.local"
              directory="/tmp/neo-cast-research"
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
      expect(frame).toContain("Workflow")
      expect(frame).toContain("Create research task")
      expect(frame).toContain("Profile dataset")
      expect(frame).toContain("Design candidates")
      expect(frame).toContain("Next Action")
      expect(frame).toContain("Create a dataset-backed TSF task")
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

  test("submitting a prompt in an empty cockpit creates a full-recipe autonomous task", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const bodies: unknown[] = []
    const promptFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (url.pathname === "/research/tasks" && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)))
        return Promise.resolve(
          response({
            id: "task_from_prompt",
            title: "Forecast ETTh1 horizon 24",
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
      for (let attempt = 0; attempt < 40 && bodies.length === 0; attempt++) {
        await app.renderOnce()
        await Bun.sleep(25)
      }

      frame = await waitForFrame(app, "created from prompt")
      expect(bodies).toHaveLength(1)
      expect(bodies[0]).toMatchObject({
        title: "Forecast ETTh1 horizon 24",
        mode: "autonomous",
        taskSpec: {
          runtime: {
            bridgeOnly: false,
            neoCastProjectRoot: "/tmp/neo-cast-research",
          },
          metadata: {
            userPrompt: "Forecast ETTh1 horizon 24",
          },
        },
      })
      expect(frame).toContain("created from prompt")
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
      await waitForFrame(app, "phase2_frequency_rnn_quantile")
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
      await waitForFrame(app, "phase2_frequency_rnn_quantile")
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

  test("registers cockpit slash commands for autocomplete", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    let command: CommandDialog | undefined
    const app = await testRender(
      () => <ResearchCockpitHarness onCommand={(value) => (command = value)} />,
      { width: 160, height: 48 },
    )

    try {
      await waitForFrame(app, "phase2_frequency_rnn_quantile")
      const displays = command?.slashes().map((slash) => slash.display.trim()) ?? []

      expect(displays).toEqual(
        expect.arrayContaining(["/seed-baselines", "/profile", "/next", "/agent-loop", "/export", "/ref-gate", "/blind-gate"]),
      )
    } finally {
      app.renderer.destroy()
    }
  })

  test("creates a full-recipe autonomous task from a routed home goal", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const bodies: unknown[] = []
    const routedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (url.pathname === "/research/tasks" && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)))
        return Promise.resolve(
          response({
            id: "task_from_home_goal",
            title: "Forecast ETTh1 horizon 24",
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
      const frame = await waitForFrame(app, "created from home goal")

      expect(bodies).toHaveLength(1)
      expect(bodies[0]).toMatchObject({
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
      })
      expect(frame).toContain("created from home goal")
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders a chat-style research workspace with progress sidebar", async () => {
    await mkdir(Global.Path.state, { recursive: true })
    await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

    const app = await testRender(() => <ResearchCockpitHarness />, { width: 160, height: 48 })

    try {
      const frame = await waitForFrame(app, "phase2_frequency_rnn_quantile")

      expect(frame).toContain("NeoResearch Workspace")
      expect(frame).toContain("Neo-Cast Autonomous TSF")
      expect(frame).toContain("State")
      expect(frame).toContain("Current state:")
      expect(frame).toContain("Next Action")
      expect(frame).toContain("Run autonomous loop")
      expect(frame).toContain("Forecaster")
      expect(frame).toContain("Progress")
      expect(frame).toContain("Planner")
      expect(frame).toContain("Forecaster 1/12 experiments")
      expect(frame).toContain("Critic")
      expect(frame).toContain("Context")
      expect(frame).toContain("Task 1/1")
      expect(frame).toContain("Home")
      expect(frame).toContain("Champion")
      expect(frame).toContain("metric=0.1234")
      expect(frame).toContain("utility=0.88")
      expect(frame).toContain("Research Agent")
      expect(frame).not.toContain("LSPs will activate as files are read")
      expect(frame).not.toContain("esc interrupt")
      expect(frame).not.toContain("tab agents")
      expect(frame).toContain("Smoke Prep")
      expect(frame).toContain("Smoke Exec")
      expect(frame).toContain("Ref Gate")
      expect(frame).toContain("Ref Prep")
      expect(frame).toContain("Ref Exec")
      expect(frame).toContain("Seed Sweep")
      expect(frame).toContain("Blind Gate")
      expect(frame).toContain("Blind Prep")
      expect(frame).toContain("Blind Exec")
      expect(frame).toContain("ranker=tsf_profile_learned_memory_ranker_v1")
      expect(frame).toContain("task_memory=2")
      expect(frame).toContain("domain_memory=5")
      expect(frame).toContain("rows=1024")
      expect(frame).toContain("Memory")
      expect(frame).not.toContain("Round 1:")
      expect(frame).not.toContain("generate_model")
      expect(occurrenceCount(frame, "Workflow")).toBe(1)
      expect(frameLine(frame, "Research Agent")).toBeGreaterThanOrEqual(38)
      expect(frameLine(frame, "ctrl+p commands")).toBeGreaterThan(frameLine(frame, "Research Agent"))
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
      await waitForFrame(app, "phase2_frequency_rnn_quantile")
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
      await waitForFrame(app, "phase2_frequency_rnn_quantile")
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
      await waitForFrame(app, "Run autonomous loop")
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
      await waitForFrame(app, "phase2_frequency_rnn_quantile")
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
      await waitForFrame(app, "phase2_frequency_rnn_quantile")
      command?.trigger("research.seed.baselines")
      const frame = await waitForFrame(app, "Running seed-baselines")

      expect(frame).toContain("Actions are temporarily locked")
      resolveBaselines?.(response({ candidates: [], approvals: [] }))
    } finally {
      app.renderer.destroy()
    }
  })
})
