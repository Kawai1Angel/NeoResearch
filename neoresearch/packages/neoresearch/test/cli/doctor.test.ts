import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { discoverNeoCastRoot, DoctorCommand, runDoctor } from "../../src/cli/cmd/doctor"
import { tmpdir as fixture } from "../fixture/fixture"

function withNeoCastEnv<T>(env: Record<string, string | undefined>, fn: () => T) {
  const keys = ["NEO_RESEARCH_NEO_CAST_ROOT", "NEO_CAST_ROOT", "NEO_RESEARCH_PACKAGE_ROOT", "PYTHON"]
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

  test.skipIf(process.platform === "win32")("checks the project Python runtime and preserves explicit overrides", async () => {
    await using tmp = await fixture()
    const runtime = path.join(tmp.path, ".neo-cast", "runtime", ".venv", "bin")
    mkdirSync(runtime, { recursive: true })
    mkdirSync(path.join(tmp.path, "py"))
    writeFileSync(path.join(tmp.path, "py", "runner.py"), "")
    writeFileSync(path.join(tmp.path, "py", "validate.py"), "")
    writeFileSync(path.join(runtime, "python"), "#!/bin/sh\nprintf 'project Python runtime\\n'\n")
    chmodSync(path.join(runtime, "python"), 0o755)

    withNeoCastEnv({ NEO_CAST_ROOT: tmp.path }, () => {
      const checks = runDoctor()
      expect(checks.every((check) => check.status === "ok")).toBe(true)
      expect(checks.find((check) => check.name === "python")?.detail).toBe("project Python runtime")
      expect(checks.find((check) => check.name === "python-imports")?.detail).toBe("project Python runtime")
      expect(runDoctor({ python: path.join(tmp.path, "missing-python") }).find((check) => check.name === "python")?.status).toBe("fail")
    })

    withNeoCastEnv({ NEO_CAST_ROOT: tmp.path, PYTHON: path.join(tmp.path, "missing-python") }, () => {
      expect(runDoctor().find((check) => check.name === "python")?.status).toBe("fail")
    })
  })

  test("JSON diagnostics set a failure exit code when Python cannot run", () => {
    const originalLog = console.log
    const originalExitCode = process.exitCode
    const logs: string[] = []
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "))
      DoctorCommand.handler?.({ python: "/missing/neo-research-python", format: "json" } as never)
      expect(JSON.parse(logs.join("\n")).ok).toBe(false)
      expect(process.exitCode).toBe(1)
    } finally {
      console.log = originalLog
      process.exitCode = originalExitCode ?? 0
    }
  })
})
