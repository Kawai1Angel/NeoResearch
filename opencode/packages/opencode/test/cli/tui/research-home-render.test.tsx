/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Global } from "@opencode-ai/core/global"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { Match, Switch } from "solid-js"
import { CommandProvider, useCommandDialog } from "../../../src/cli/cmd/tui/component/dialog-command"
import { KeybindProvider } from "../../../src/cli/cmd/tui/context/keybind"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { RouteProvider, useRoute } from "../../../src/cli/cmd/tui/context/route"
import { ThemeProvider } from "../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import { Home } from "../../../src/cli/cmd/tui/routes/home"
import { DialogProvider } from "../../../src/cli/cmd/tui/ui/dialog"
import { ToastProvider } from "../../../src/cli/cmd/tui/ui/toast"

type CommandDialog = ReturnType<typeof useCommandDialog>

const API_KEY_ENV_KEYS = [
  "ZHIPU_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "DASHSCOPE_API_KEY",
]

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
  process.env.ZHIPU_API_KEY = "test-key"
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

function HomeHarness(props: { onCommand?: (command: CommandDialog) => void; onRoute?: (route: ReturnType<typeof useRoute>) => void } = {}) {
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

async function setupKv() {
  await mkdir(Global.Path.state, { recursive: true })
  await writeFile(path.join(Global.Path.state, "kv.json"), "{}")
}

describe("NeoResearch home launcher", () => {
  test("prompts for API key setup on first entry when no model key is configured", async () => {
    await withClearedApiKeyEnv(async () => {
      await setupKv()

      const app = await testRender(() => <HomeHarness />, { width: 140, height: 36 })

      try {
        const frame = await waitForFrame(app, "NEORESEARCH")

        expect(frame).toContain("Configure API Key")
        expect(frame).toContain("Connect Provider")
        expect(frame).toContain("Set ZHIPU_API_KEY")
      } finally {
        app.renderer.destroy()
      }
    })
  })

  test("renders a branded research launcher instead of the dense cockpit", async () => {
    await setupKv()

    const app = await testRender(() => <HomeHarness />, { width: 140, height: 36 })

    try {
      const frame = await waitForFrame(app, "NEORESEARCH")

      expect(frame).toContain('Ask research goal... "Forecast ETTh1 horizon=24"')
      expect(frame).toContain("Planner  Research Agent")
      expect(frame).toContain("New CSV Task")
      expect(frame).toContain("Open Cockpit")
      expect(frame).toContain("Run Doctor")
      expect(frame).toContain("enter submit")
      expect(frame).toContain("ctrl+p api-key / cockpit / csv / doctor")
      expect(frame).toContain("doctor env")
      expect(frame).not.toContain("Research Tasks")
      expect(frame).not.toContain("[ ] Auto Mode")
      expect(frame).not.toContain("Resume Last Task")
      expect(frame).not.toContain("Export Report")
    } finally {
      app.renderer.destroy()
    }
  })

  test("hides API key setup actions after a model key is configured", async () => {
    await withApiKeyEnv(async () => {
      await setupKv()

      const app = await testRender(() => <HomeHarness />, { width: 140, height: 36 })

      try {
        const frame = await waitForFrame(app, "NEORESEARCH")

        expect(frame).not.toContain("Configure API Key")
        expect(frame).not.toContain("Connect Provider")
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
      await waitForFrame(app, "NEORESEARCH")
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
      await waitForFrame(app, "NEORESEARCH")
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
    const app = await testRender(() => <HomeHarness onRoute={(value) => (route = value)} />, { width: 140, height: 36 })

    try {
      await waitForFrame(app, "NEORESEARCH")
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

  test("open cockpit command moves from launcher into the cockpit route", async () => {
    await setupKv()

    let command: CommandDialog | undefined
    let route: ReturnType<typeof useRoute> | undefined
    const app = await testRender(
      () => <HomeHarness onCommand={(value) => (command = value)} onRoute={(value) => (route = value)} />,
      { width: 140, height: 36 },
    )

    try {
      await waitForFrame(app, "NEORESEARCH")
      command?.trigger("research.cockpit.open")
      const frame = await waitForFrame(app, "NeoResearch Cockpit")

      expect(route?.data.type).toBe("cockpit")
      expect(frame).toContain("NeoResearch Cockpit")
    } finally {
      app.renderer.destroy()
    }
  })
})
