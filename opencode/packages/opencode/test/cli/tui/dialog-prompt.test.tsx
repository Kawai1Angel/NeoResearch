/** @jsxImportSource @opentui/solid */
import { beforeEach, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Global } from "@opencode-ai/core/global"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { KVProvider, useKV } from "../../../src/cli/cmd/tui/context/kv"
import { createSignal, Show, type JSX } from "solid-js"
import { KeybindProvider } from "../../../src/cli/cmd/tui/context/keybind"
import { ThemeProvider } from "../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import { DialogProvider, useDialog, type DialogContext } from "../../../src/cli/cmd/tui/ui/dialog"
import { DialogPrompt } from "../../../src/cli/cmd/tui/ui/dialog-prompt"
import { DialogSelect } from "../../../src/cli/cmd/tui/ui/dialog-select"
import { ToastProvider } from "../../../src/cli/cmd/tui/ui/toast"

let flush: (() => Promise<void>) | undefined
function Preferences() {
  const kv = useKV()
  flush = () => kv.flush()
  return null
}
beforeEach(async () => {
  await flush?.()
  await mkdir(Global.Path.state, { recursive: true })
  await writeFile(path.join(Global.Path.state, "kv.json"), "{}")
})

function Harness(props: { confirm?: (value: string) => void; children?: JSX.Element }) {
  const [value, setValue] = createSignal("")
  return (
    <KVProvider>
      <Preferences />
      <ToastProvider>
        <TuiConfigProvider config={{ theme: "opencode" }}>
          <ThemeProvider mode="dark">
            <KeybindProvider>
              <DialogProvider>
                {props.children ?? (
                  <DialogPrompt
                    title="Validate input"
                    onChange={setValue}
                    onConfirm={props.confirm}
                    description={() => (
                      <Show when={value()}>
                        <text>Validation: {value()}</text>
                      </Show>
                    )}
                  />
                )}
              </DialogProvider>
            </KeybindProvider>
          </ThemeProvider>
        </TuiConfigProvider>
      </ToastProvider>
    </KVProvider>
  )
}

async function waitFor(app: Awaited<ReturnType<typeof testRender>>, text: string) {
  for (let index = 0; index < 100; index++) {
    await app.renderOnce()
    if (app.captureCharFrame().includes(text)) return
    await Bun.sleep(10)
  }
  throw new Error(`Prompt did not render ${text}`)
}

test("live validation can update layout while typing and Enter confirms only once", async () => {
  const submitted: string[] = []
  const app = await testRender(() => <Harness confirm={(value) => submitted.push(value)} />, { width: 80, height: 20 })
  try {
    await waitFor(app, "Validate input")
    await Bun.sleep(10)
    await app.mockInput.typeText("/tmp/missing.csv context=0")
    await waitFor(app, "Validation: /tmp/missing.csv context=0")
    expect(app.captureCharFrame()).toContain("Validation: /tmp/missing.csv context=0")
    app.mockInput.pressEnter()
    await Bun.sleep(10)
    expect(submitted).toEqual(["/tmp/missing.csv context=0"])
  } finally {
    app.renderer.destroy()
  }
})

test("destroying a prompt cancels its deferred submit and focus callbacks", async () => {
  const submitted: string[] = []
  const app = await testRender(() => <Harness confirm={(value) => submitted.push(value)} />, { width: 80, height: 20 })
  await waitFor(app, "Validate input")
  await Bun.sleep(10)
  await app.mockInput.typeText("pending")
  app.mockInput.pressEnter()
  app.renderer.destroy()
  await Bun.sleep(20)
  expect(submitted).toEqual([])
})

test("replacing a select dialog before shutdown does not blur a freed native renderer", async () => {
  let dialog!: DialogContext
  function Probe() {
    dialog = useDialog()
    return <text>Dialog ready</text>
  }
  const app = await testRender(
    () => (
      <Harness>
        <Probe />
      </Harness>
    ),
    { width: 80, height: 20 },
  )
  let destroyed = false
  let lateCursorUpdates = 0
  const setCursorPosition = app.renderer.setCursorPosition.bind(app.renderer)
  app.renderer.setCursorPosition = (...args) => {
    // Turn a regression into an assertion failure instead of calling a freed
    // native pointer and crashing the entire test process.
    if (destroyed) {
      lateCursorUpdates++
      return
    }
    setCursorPosition(...args)
  }
  try {
    await waitFor(app, "Dialog ready")
    dialog.replace(() => <DialogSelect title="First choice" options={[{ title: "One", value: 1 }]} />)
    await waitFor(app, "First choice")
    dialog.replace(() => <DialogSelect title="Second choice" options={[{ title: "Two", value: 2 }]} />)
    app.renderer.destroy()
    destroyed = true
    await Bun.sleep(20)
    expect(lateCursorUpdates).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})
