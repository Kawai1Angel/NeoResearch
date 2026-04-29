import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import path from "path"

const root = path.resolve(import.meta.dir, "..")

function readText(relative: string) {
  return readFileSync(path.join(root, relative), "utf8")
}

function readPackageJson() {
  return JSON.parse(readText("package.json")) as {
    name: string
    version: string
    bin: Record<string, string>
    files: string[]
    scripts?: Record<string, string>
    publishConfig?: Record<string, string>
  }
}

describe("NeoResearch npm package boundary", () => {
  test("publishes a single alpha CLI package with a narrow file allowlist", () => {
    const pkg = readPackageJson()

    expect(pkg.name).toBe("neo-research")
    expect(pkg.version).toBe("0.1.0-alpha.0")
    expect(pkg.bin).toEqual({ "neo-research": "bin/neo-research" })
    expect(pkg.publishConfig).toEqual({ access: "public", tag: "alpha" })
    expect(pkg.files).toEqual(["bin/", "src/", "README.md", "LICENSE", "package.json"])
    expect(pkg.scripts?.postinstall).toBeUndefined()
    expect(pkg.scripts?.["pack:dry-run"]).toBe("npm pack --dry-run")
    expect(pkg.scripts?.["build:all"]).toBe("bun run script/build.ts --all-targets")
  })

  test("registers the expected NeoResearch CLI commands", () => {
    const index = readText("src/index.ts")

    for (const command of [
      "DoctorCommand",
      "InitCommand",
      "ResearchCommand",
      "DashboardCommand",
      "CockpitCommand",
      "ServeCommand",
    ]) {
      expect(index).toContain(command)
      expect(index).toContain(`.command(${command})`)
    }
  })

  test("README is written for NeoResearch installation and TSF runner setup", () => {
    const readme = readText("README.md")

    for (const section of [
      "## What Is NeoResearch?",
      "## Quick Start",
      "## Local Source Install",
      "## npm Install",
      "## TSF Runner Configuration",
      "## Web Dashboard and TUI Cockpit",
      "## Research Task Lifecycle",
      "## Current Alpha Limits",
    ]) {
      expect(readme).toContain(section)
    }

    expect(readme).toContain("neo-research doctor")
    expect(readme).toContain("NEO_CAST_ROOT")
    expect(readme).not.toContain("opencode.ai")
  })

  test("publish script does not bundle Neo-Cast or install Python from postinstall", () => {
    const publish = readText("script/publish.ts")
    const tsfDomain = readText("src/research/domains/tsf.ts")

    expect(publish).not.toContain("runners/")
    expect(publish).not.toContain("postinstall")
    expect(publish).not.toContain("neo_cast")
    expect(tsfDomain).not.toContain('path.join(process.env.NEO_RESEARCH_PACKAGE_ROOT, "runners", "neo_cast")')
  })

  test("build script keeps local builds single-platform unless all targets are explicit", () => {
    const build = readText("script/build.ts")
    const publishWorkflow = readFileSync(path.join(root, "../../.github/workflows/publish.yml"), "utf8")

    expect(build).toContain('process.argv.includes("--all-targets")')
    expect(build).toContain("const allTargetsFlag")
    expect(build).toContain("const buildAllTargets = Script.release || allTargetsFlag")
    expect(build).toContain("if (buildAllTargets && !skipInstall)")
    expect(build).toContain("const targets = buildAllTargets")
    expect(build).not.toContain("const targets = singleFlag")
    expect(publishWorkflow).toContain("./packages/opencode/script/build.ts --all-targets")
  })
})
