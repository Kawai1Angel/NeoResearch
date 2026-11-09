import { describe, expect, test } from "bun:test"
import { clearTerminalResizeArtifacts, rendererConfig } from "../../../src/cli/cmd/tui/app"

describe("TUI renderer config", () => {
  test("keeps autofocus enabled so startup textareas receive keyboard input", () => {
    const config = rendererConfig({} as never)

    expect(config.autoFocus).toBe(true)
  })

  test("uses a short resize debounce to avoid stale terminal edges while zooming", () => {
    const config = rendererConfig({} as never)

    expect(config.debounceDelay).toBeLessThanOrEqual(16)
  })

  test("clears visible terminal cells on resize before repainting", () => {
    let output = ""
    const stdout = {
      isTTY: true,
      write: (value: string) => {
        output += value
        return true
      },
    } as NodeJS.WriteStream

    clearTerminalResizeArtifacts(stdout)

    expect(output).toContain("\x1b[2J")
    expect(output).toContain("\x1b[H")
  })
})
