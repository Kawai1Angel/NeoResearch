import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { discoverNeoCastRoot } from "../../src/cli/cmd/doctor"

function withNeoCastEnv<T>(env: Record<string, string | undefined>, fn: () => T) {
  const keys = ["NEO_RESEARCH_NEO_CAST_ROOT", "NEO_CAST_ROOT", "NEO_RESEARCH_PACKAGE_ROOT"]
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  try {
    for (const key of keys) delete process.env[key]
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    return fn()
  } finally {
    for (const key of keys) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe("NeoResearch doctor", () => {
  test("discovers the bundled Neo-Cast runner under NEO_RESEARCH_PACKAGE_ROOT", () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), "neo-research-package-root-"))
    const bundledRunner = path.join(packageRoot, "runners", "neo_cast")
    mkdirSync(bundledRunner, { recursive: true })

    const discovered = withNeoCastEnv({ NEO_RESEARCH_PACKAGE_ROOT: packageRoot }, () => discoverNeoCastRoot())

    expect(discovered).toBe(bundledRunner)
  })
})
