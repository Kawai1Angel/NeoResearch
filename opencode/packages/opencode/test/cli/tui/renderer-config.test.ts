import { describe, expect, test } from "bun:test"
import { rendererConfig } from "../../../src/cli/cmd/tui/app"

describe("TUI renderer config", () => {
  test("keeps autofocus enabled so startup textareas receive keyboard input", () => {
    const config = rendererConfig({} as never)

    expect(config.autoFocus).toBe(true)
  })

  test("uses a short resize debounce to avoid stale terminal edges while zooming", () => {
    const config = rendererConfig({} as never)

    expect(config.debounceDelay).toBeLessThanOrEqual(16)
  })
})
