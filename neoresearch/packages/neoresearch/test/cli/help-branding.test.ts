import { describe, expect, test } from "bun:test"
import { mkdir } from "fs/promises"
import { tmpdir } from "os"
import path from "path"

async function runCliHelp() {
  const root = path.join(tmpdir(), `neo-research-help-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const data = path.join(root, "data")
  const cache = path.join(root, "cache")
  const config = path.join(root, "config")
  const state = path.join(root, "state")
  await mkdir(path.join(data, "neo-research"), { recursive: true })
  await mkdir(cache, { recursive: true })
  await mkdir(config, { recursive: true })
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(data, "neo-research", "neo-research.db"), "{}\n")

  const proc = Bun.spawn({
    cmd: [process.execPath, "run", "--conditions=browser", "./src/index.ts", "--help"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      XDG_DATA_HOME: data,
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: config,
      XDG_STATE_HOME: state,
      NEORESEARCH_DISABLE_PROJECT_CONFIG: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  return { exitCode, output: stdout + stderr }
}

describe("NeoResearch CLI help branding", () => {
  test("root help uses NeoResearch wording and no NeoResearch product copy", async () => {
    const result = await runCliHelp()

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("NEORESEARCH")
    expect(result.output).toContain("neo-research run [message..]")
    expect(result.output).toContain("run NeoResearch with a message")
    expect(result.output).toContain("start a headless NeoResearch server")
    expect(result.output).toContain("upgrade NeoResearch to the latest or a specific version")
    expect(result.output).toContain("uninstall NeoResearch and remove all related files")
    expect(result.output).not.toContain("NeoResearch")
    expect(result.output).not.toContain("neoresearch")
    expect(result.output).not.toContain("neoresearch.local")
  })
})
