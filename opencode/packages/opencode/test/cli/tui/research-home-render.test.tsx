/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Global } from "@opencode-ai/core/global"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { Match, Switch } from "solid-js"
import { CommandProvider, useCommandDialog } from "../../../src/cli/cmd/tui/component/dialog-command"
import { ArgsProvider } from "../../../src/cli/cmd/tui/context/args"
import { ExitProvider } from "../../../src/cli/cmd/tui/context/exit"
import { KeybindProvider } from "../../../src/cli/cmd/tui/context/keybind"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { ProjectProvider } from "../../../src/cli/cmd/tui/context/project"
import { RouteProvider, useRoute } from "../../../src/cli/cmd/tui/context/route"
import { SDKProvider } from "../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider } from "../../../src/cli/cmd/tui/context/sync"
import { ThemeProvider } from "../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import { Home, hasNeoResearchApiKey } from "../../../src/cli/cmd/tui/routes/home"
import { DialogProvider } from "../../../src/cli/cmd/tui/ui/dialog"
import { ToastProvider, useToast } from "../../../src/cli/cmd/tui/ui/toast"

type CommandDialog = ReturnType<typeof useCommandDialog>
type Toast = ReturnType<typeof useToast>

const API_KEY_ENV_KEYS = [
  "NEO_CAST_LLM_API_KEY",
  "OPENAI_API_KEY",
  "AIGCBEST_API_KEY",
  "ANTHROPIC_API_KEY",
]
const HOME_READY_TEXT = "Make Small Model Creation Simple"

async function withClearedApiKeyEnv<T>(fn: () => Promise<T>) {
  const previous = new Map(API_KEY_ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of API_KEY_ENV_KEYS) delete process.env[key]
  try {
    return await fn()
  } finally {
    for (const key of API_KEY_ENV_KEYS) {
      const value = previous.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function withApiKeyEnv<T>(fn: () => Promise<T>) {
  const previous = new Map(API_KEY_ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of API_KEY_ENV_KEYS) delete process.env[key]
  process.env.NEO_CAST_LLM_API_KEY = "test-key"
  try {
    return await fn()
  } finally {
    for (const key of API_KEY_ENV_KEYS) {
      const value = previous.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function CommandProbe(props: { onReady: (command: CommandDialog) => void }) {
  props.onReady(useCommandDialog())
  return null
}

function RouteProbe(props: { onReady: (route: ReturnType<typeof useRoute>) => void }) {
  props.onReady(useRoute())
  return null
}

function ToastProbe(props: { onReady: (toast: Toast) => void }) {
  props.onReady(useToast())
  return null
}

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function mockHomeSyncFetch(input: RequestInfo | URL, _init?: RequestInit) {
  const url = new URL(input instanceof Request ? input.url : input.toString())
  const path = url.pathname

  if (path === "/path") {
    return Promise.resolve(
      response({
        home: "",
        state: "",
        config: "",
        worktree: "",
        directory: "/tmp/neo-cast-research",
      }),
    )
  }
  if (path === "/project/current") return Promise.resolve(response({ id: "project_neo_cast" }))
  if (path === "/config/providers") return Promise.resolve(response({ providers: [], default: {} }))
  if (path === "/provider") {
    return Promise.resolve(
      response({
        all: [{ id: "openai", name: "OpenAI" }],
        default: {},
        connected: [],
      }),
    )
  }
  if (path === "/experimental/console") {
    return Promise.resolve(response({ consoleManagedProviders: [], switchableOrgCount: 0 }))
  }
  if (path === "/agent") return Promise.resolve(response([]))
  if (path === "/config") return Promise.resolve(response({}))
  if (path === "/session") return Promise.resolve(response([]))
  if (path === "/command") return Promise.resolve(response([]))
  if (path === "/lsp") return Promise.resolve(response([]))
  if (path === "/mcp") return Promise.resolve(response({}))
  if (path === "/experimental/resource") return Promise.resolve(response({}))
  if (path === "/formatter") return Promise.resolve(response([]))
  if (path === "/session/status") return Promise.resolve(response({}))
  if (path === "/provider/auth") return Promise.resolve(response({ openai: [{ type: "api", label: "API key" }] }))
  if (path === "/vcs") return Promise.resolve(response(null))
  if (path === "/experimental/workspace") return Promise.resolve(response([]))
  if (path === "/experimental/workspace/status") return Promise.resolve(response([]))

  return Promise.resolve(response({}))
}

function HomeHarness(
  props: {
    onCommand?: (command: CommandDialog) => void
    onRoute?: (route: ReturnType<typeof useRoute>) => void
    onToast?: (toast: Toast) => void
  } = {},
) {
  return (
    <KVProvider>
      <ToastProvider>
        <RouteProvider>
          <TuiConfigProvider config={{ theme: "opencode" }}>
            <ThemeProvider mode="dark">
              <KeybindProvider>
                <DialogProvider>
                  <CommandProvider>
                    <Switch>
                      <Match when={useRoute().data.type === "home"}>
                        <Home />
                      </Match>
                      <Match when={useRoute().data.type === "cockpit"}>
                        <text>NeoResearch Cockpit</text>
                      </Match>
                    </Switch>
                    {props.onCommand ? <CommandProbe onReady={props.onCommand} /> : null}
                    {props.onRoute ? <RouteProbe onReady={props.onRoute} /> : null}
                    {props.onToast ? <ToastProbe onReady={props.onToast} /> : null}
                  </CommandProvider>
                </DialogProvider>
              </KeybindProvider>
            </ThemeProvider>
          </TuiConfigProvider>
        </RouteProvider>
      </ToastProvider>
    </KVProvider>
  )
}

function SyncedHomeHarness(props: { onCommand?: (command: CommandDialog) => void } = {}) {
  return (
    <ArgsProvider>
      <ExitProvider>
        <KVProvider>
          <ToastProvider>
            <RouteProvider>
              <TuiConfigProvider config={{ theme: "opencode" }}>
                <SDKProvider
                  url="http://mock.local"
                  directory="/tmp/neo-cast-research"
                  fetch={mockHomeSyncFetch as typeof fetch}
                  events={{ subscribe: async () => () => {} }}
                >
                  <ProjectProvider>
                    <SyncProvider>
                      <ThemeProvider mode="dark">
                        <KeybindProvider>
                          <DialogProvider>
                            <CommandProvider>
                              <Home />
                              {props.onCommand ? <CommandProbe onReady={props.onCommand} /> : null}
                            </CommandProvider>
                          </DialogProvider>
                        </KeybindProvider>
                      </ThemeProvider>
                    </SyncProvider>
                  </ProjectProvider>
                </SDKProvider>
              </TuiConfigProvider>
            </RouteProvider>
          </ToastProvider>
        </KVProvider>
      </ExitProvider>
    </ArgsProvider>
  )
}

async function waitForFrame(app: Awaited<ReturnType<typeof testRender>>, text: string) {
  let lastFrame = ""
  for (let attempt = 0; attempt < 40; attempt++) {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    lastFrame = frame
    if (frame.includes(text)) return frame
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for frame to include ${text}\n\n${lastFrame}`)
}

function frameLine(frame: string, predicate: (line: string) => boolean) {
  const line = frame.split("\n").findIndex(predicate)
  if (line === -1) throw new Error(`frame did not include expected line\n\n${frame}`)
  return line
}

async function setupKv() {
  await mkdir(Global.Path.state, { recursive: true })
  await writeFile(path.join(Global.Path.state, "kv.json"), "{}")
}

describe("NeoResearch home launcher", () => {
  test("detects only Neo-Cast-compatible LLM API key environment variables", () => {
    expect(hasNeoResearchApiKey({ ZHIPU_API_KEY: "zhipu-key" })).toBe(false)
    expect(hasNeoResearchApiKey({ NEO_CAST_LLM_API_KEY: "relay-key" })).toBe(true)
    expect(hasNeoResearchApiKey({ AIGCBEST_API_KEY: "relay-key" })).toBe(true)
    expect(hasNeoResearchApiKey({ ANTHROPIC_API_KEY: "anthropic-key" })).toBe(true)
  })

  test("opens the API key setup dialog on first entry when no model key is configured", async () => {
    await withClearedApiKeyEnv(async () => {
      await setupKv()

      const app = await testRender(() => <SyncedHomeHarness />, { width: 140, height: 36 })

      try {
        const frame = await waitForFrame(app, "Connect a provider")

        expect(frame).toContain("OpenAI")
        expect(frame).toContain("API key")
      } finally {
        app.renderer.destroy()
      }
    })
  })

  test("prompts for API key setup on first entry when no model key is configured", async () => {
    await withClearedApiKeyEnv(async () => {
      await setupKv()

      const app = await testRender(() => <HomeHarness />, { width: 140, height: 36 })

      try {
        const frame = await waitForFrame(app, HOME_READY_TEXT)

        expect(frame).toContain("Configure API Key")
        expect(frame).toContain("Show Setup Hint")
        expect(frame).toContain("Set NEO_CAST_LLM_API_KEY")
      } finally {
        app.renderer.destroy()
      }
    })
  })

  test("configure API key command opens the provider dialog when sync data is available", async () => {
    await withClearedApiKeyEnv(async () => {
      await setupKv()

      let command: CommandDialog | undefined
      const app = await testRender(() => <SyncedHomeHarness onCommand={(value) => (command = value)} />, {
        width: 140,
        height: 36,
      })

      try {
        await waitForFrame(app, "Connect a provider")
        command?.trigger("research.provider.configure")
        const frame = await waitForFrame(app, "Connect a provider")

        expect(frame).toContain("OpenAI")
      } finally {
        app.renderer.destroy()
      }
    })
  })

  test("renders a branded research launcher instead of the dense cockpit", async () => {
    await setupKv()

    const app = await testRender(() => <HomeHarness />, { width: 140, height: 36 })

    try {
      const frame = await waitForFrame(app, HOME_READY_TEXT)

      expect(frame).toContain(" _   _            ____")
      expect(frame).toContain("Ask for a recommendation, approve a checkpoint, or export the bundle...")
      expect(frame).toContain("认知伴随 Intent Agent Research Agent")
      expect(frame).not.toContain("NeoResearch: Making Time-series Model Creation Simple")
      expect(frame).not.toContain("Planner  Research Agent")
      expect(frame).toContain("New CSV Task")
      expect(frame).toContain("Open Cockpit")
      expect(frame).toContain("Run Doctor")
      expect(frame).toContain("Configure API Key")
      expect(frame).not.toContain("Quick Start")
      expect(frame).not.toContain("1 New CSV Task")
      expect(frame).not.toContain("3 run /next in Cockpit")
      expect(frame).not.toContain("Designed for Research OS")
      expect(frame).not.toContain("enter submit")
      expect(frame).not.toContain("ctrl+p api-key / cockpit / csv / doctor")
      expect(frame).not.toContain("doctor env")
      expect(frame).not.toContain("Research Tasks")
      expect(frame).not.toContain("[ ] Auto Mode")
      expect(frame).not.toContain("Resume Last Task")
      expect(frame).not.toContain("Export Report")
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders the launcher without the legacy NeoCast ASCII banner", async () => {
    await setupKv()

    const app = await testRender(() => <HomeHarness />, { width: 160, height: 40 })

    try {
      const frame = await waitForFrame(app, HOME_READY_TEXT)

      expect(frame).toContain(HOME_READY_TEXT)
      expect(frame).not.toContain("N   N EEEE  OOO   CCC   A   SSS  TTTTT")
      expect(frame).not.toContain("N N N EEE  O   O C    AAAAA SSS    T")
      expect(frame).not.toContain("N   N EEEE  OOO  RRR  EEEE  SSS  EEEE  A   RRR   CCC H  H")
      expect(frame).not.toContain("N N N EEE  O   O RRR  EEE   SSS  EEE  AAA  RRR  C    HHHH")
      expect(frame).not.toContain("\n                                      NEORESEARCH")
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps the API key entry after a model key is configured without showing the setup panel", async () => {
    await withApiKeyEnv(async () => {
      await setupKv()

      const app = await testRender(() => <HomeHarness />, { width: 140, height: 36 })

      try {
        const frame = await waitForFrame(app, HOME_READY_TEXT)

        expect(frame).toContain("Configure API Key")
        expect(frame).not.toContain("Show Setup Hint")
        expect(frame).toContain("New CSV Task")
      } finally {
        app.renderer.destroy()
      }
    })
  })

  test("accepts typed research goals immediately after the launcher renders", async () => {
    await setupKv()

    const app = await testRender(() => <HomeHarness />, { width: 140, height: 36 })

    try {
      await waitForFrame(app, HOME_READY_TEXT)
      await app.mockInput.typeText("Forecast ETTh1 horizon 24")
      await app.renderOnce()

      expect(app.captureCharFrame()).toContain("Forecast ETTh1 horizon 24")
    } finally {
      app.renderer.destroy()
    }
  })

  test("submitting a research goal carries it into the cockpit route", async () => {
    await setupKv()

    let route: ReturnType<typeof useRoute> | undefined
    const app = await testRender(() => <HomeHarness onRoute={(value) => (route = value)} />, { width: 140, height: 36 })

    try {
      await waitForFrame(app, HOME_READY_TEXT)
      await app.mockInput.typeText("Forecast ETTh1 horizon 24")
      await app.renderOnce()
      app.mockInput.pressEnter()
      await waitForFrame(app, "NeoResearch Cockpit")

      expect(route?.data.type).toBe("cockpit")
      expect((route?.data as { researchGoal?: string }).researchGoal).toBe("Forecast ETTh1 horizon 24")
    } finally {
      app.renderer.destroy()
    }
  })

  test("submitting a slash cockpit command opens cockpit without treating it as a research goal", async () => {
    await setupKv()

    let route: ReturnType<typeof useRoute> | undefined
    let toast: Toast | undefined
    const app = await testRender(() => <HomeHarness onRoute={(value) => (route = value)} onToast={(value) => (toast = value)} />, {
      width: 140,
      height: 36,
    })

    try {
      await waitForFrame(app, HOME_READY_TEXT)
      await app.mockInput.typeText("/cockpit")
      await app.renderOnce()
      app.mockInput.pressEnter()
      await waitForFrame(app, "NeoResearch Cockpit")

      expect(route?.data.type).toBe("cockpit")
      expect((route?.data as { researchGoal?: string }).researchGoal).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })

  test("typing slash opens the launcher command popup", async () => {
    await setupKv()

    const app = await testRender(() => <HomeHarness />, { width: 140, height: 36 })

    try {
      await waitForFrame(app, HOME_READY_TEXT)
      await app.mockInput.typeText("/")
      await app.renderOnce()
      const frame = app.captureCharFrame()

      expect(frame).toContain("Commands")
      expect(frame).toContain("/cockpit")
      expect(frame).toContain("/csv")
      expect(frame).toContain("/doctor")
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps the launcher slash popup rows aligned", async () => {
    await setupKv()

    const app = await testRender(() => <HomeHarness />, { width: 160, height: 48 })

    try {
      await waitForFrame(app, HOME_READY_TEXT)
      await app.mockInput.typeText("/")
      await app.renderOnce()
      const frame = app.captureCharFrame()
      const commandLine = frameLine(frame, (line) => line.includes("Commands"))
      const lines = frame.split("\n")
      const optionLine = frameLine(frame, (line) => line.includes("/cockpit") && !line.includes("Selected"))

      expect(lines[optionLine]!.indexOf("/cockpit")).toBe(lines[commandLine]!.indexOf("Commands"))
    } finally {
      app.renderer.destroy()
    }
  })

  test("pressing enter on the launcher slash popup runs the selected command", async () => {
    await setupKv()

    let route: ReturnType<typeof useRoute> | undefined
    const app = await testRender(() => <HomeHarness onRoute={(value) => (route = value)} />, { width: 140, height: 36 })

    try {
      await waitForFrame(app, HOME_READY_TEXT)
      await app.mockInput.typeText("/")
      await app.renderOnce()
      app.mockInput.pressEnter()
      await waitForFrame(app, "NeoResearch Cockpit")

      expect(route?.data.type).toBe("cockpit")
    } finally {
      app.renderer.destroy()
    }
  })

  test("arrow keys choose a launcher slash command before enter", async () => {
    await setupKv()

    let route: ReturnType<typeof useRoute> | undefined
    let toast: Toast | undefined
    const app = await testRender(() => <HomeHarness onRoute={(value) => (route = value)} onToast={(value) => (toast = value)} />, {
      width: 140,
      height: 36,
    })

    try {
      await waitForFrame(app, HOME_READY_TEXT)
      await app.mockInput.typeText("/")
      await app.renderOnce()
      app.mockInput.pressKey("ARROW_DOWN")
      app.mockInput.pressKey("ARROW_DOWN")
      app.mockInput.pressEnter()
      await app.renderOnce()

      expect(route?.data.type).toBe("home")
      expect(toast?.currentToast?.message).toContain("doctor")
    } finally {
      app.renderer.destroy()
    }
  })

  test("open cockpit command moves from launcher into the cockpit route", async () => {
    await setupKv()

    let command: CommandDialog | undefined
    let route: ReturnType<typeof useRoute> | undefined
    const app = await testRender(
      () => <HomeHarness onCommand={(value) => (command = value)} onRoute={(value) => (route = value)} />,
      { width: 140, height: 36 },
    )

    try {
      await waitForFrame(app, HOME_READY_TEXT)
      command?.trigger("research.cockpit.open")
      const frame = await waitForFrame(app, "NeoResearch Cockpit")

      expect(route?.data.type).toBe("cockpit")
      expect(frame).toContain("NeoResearch Cockpit")
    } finally {
      app.renderer.destroy()
    }
  })

  test("new CSV command opens cockpit with the CSV task intent", async () => {
    await setupKv()

    let command: CommandDialog | undefined
    let route: ReturnType<typeof useRoute> | undefined
    const app = await testRender(
      () => <HomeHarness onCommand={(value) => (command = value)} onRoute={(value) => (route = value)} />,
      { width: 140, height: 36 },
    )

    try {
      await waitForFrame(app, HOME_READY_TEXT)
      command?.trigger("research.csv.new")
      await waitForFrame(app, "NeoResearch Cockpit")

      expect(route?.data.type).toBe("cockpit")
      expect((route?.data as { newCsvTask?: boolean }).newCsvTask).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })
})
