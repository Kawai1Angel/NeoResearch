import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { spawnSync } from "child_process"
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
    expect(pkg.scripts?.prepublishOnly).toBe("bun run script/prepublish-only.ts")
    expect(pkg.scripts?.["pack:dry-run"]).toBe("bun run build && NEO_RESEARCH_PUBLISH_DRY_RUN=1 bun run script/publish.ts")
    expect(pkg.scripts?.["build:all"]).toBe("bun run script/build.ts --all-targets")
    expect(pkg.scripts?.["prepublish:check"]).toBe("bun run script/prepublish-check.ts")
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

  test("bin wrapper executes under the package module type", () => {
    const result = spawnSync("node", [path.join(root, "bin/neo-research"), "--version"], {
      cwd: root,
      env: {
        ...process.env,
        NEO_RESEARCH_BIN_PATH: process.execPath,
      },
      encoding: "utf8",
      timeout: 10_000,
    })

    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain("require is not defined")
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
    expect(publish).toContain('await Bun.file(`./dist/${pkg.name}/LICENSE`).write(await Bun.file("./LICENSE").text())')
    expect(publish).toContain("optionalDependencies: binaries")
    expect(publish).toContain("[pkg.name]: `bin/${pkg.name}`")
    expect(publish).not.toContain("[pkg.name]: `./bin/${pkg.name}`")
    expect(publish).not.toContain("dependencies: pkg.dependencies")
    expect(publish).not.toContain("devDependencies: pkg.devDependencies")
    expect(publish).toContain("publishConfig")
    expect(publish).toContain("type: pkg.type")
    expect(publish).toContain("NEO_RESEARCH_PUBLISH_DRY_RUN")
    expect(publish).toContain(".artifacts/npm-cache")
    expect(tsfDomain).not.toContain('path.join(process.env.NEO_RESEARCH_PACKAGE_ROOT, "runners", "neo_cast")')
  })

  test("prepublish check captures the alpha release gate commands", () => {
    const check = readText("script/prepublish-check.ts")

    for (const command of [
      "bun test test/release-boundary.test.ts",
      "bun test test/research/service.test.ts --timeout 30000",
      "bun run typecheck",
      "bun run build",
      "NEO_RESEARCH_PUBLISH_DRY_RUN=1 bun run script/publish.ts",
      "packageJson.version",
      "packageJson.publishConfig?.tag",
    ]) {
      expect(check).toContain(command)
    }
  })

  test("source package publish is blocked in favor of dist publisher", () => {
    const guard = readText("script/prepublish-only.ts")

    expect(guard).toContain("NEO_RESEARCH_ALLOW_SOURCE_PUBLISH")
    expect(guard).toContain("packages/opencode/script/publish.ts")
    expect(guard).toContain("process.exit(1)")
  })

  test("model snapshot generation can fall back to the checked-in snapshot", () => {
    const generate = readText("script/generate.ts")

    expect(generate).toContain("MODELS_DEV_API_JSON")
    expect(generate).toContain("Using existing models-snapshot.js")
    expect(generate).toContain("readExistingModelsSnapshot")
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
    expect(build).toContain('await Bun.file(`dist/${name}/LICENSE`).write(await Bun.file("./LICENSE").text())')
    expect(build).toContain('files: ["bin/", "README.md", "LICENSE", "package.json"]')
    expect(publishWorkflow).toContain("./packages/opencode/script/build.ts --all-targets")
  })

  test("GitHub publish workflow is NeoResearch npm-only", () => {
    const publishWorkflow = readFileSync(path.join(root, "../../.github/workflows/publish.yml"), "utf8")

    for (const required of [
      "name: publish-npm",
      "NEO_RESEARCH_VERSION",
      "NEO_RESEARCH_CHANNEL: alpha",
      "./packages/opencode/script/build.ts --all-targets",
      "./packages/opencode/script/publish.ts",
      "NODE_AUTH_TOKEN",
    ]) {
      expect(publishWorkflow).toContain(required)
    }

    for (const forbidden of [
      "anomalyco/opencode",
      "opencode-cli",
      "opencode-ai",
      "build-tauri",
      "build-electron",
      "desktop-electron",
      "packages/sdk",
      "packages/plugin",
      "AUR_KEY",
    ]) {
      expect(publishWorkflow).not.toContain(forbidden)
    }
  })

  test("root publish entry delegates only to the NeoResearch CLI package publisher", () => {
    const rootPublish = readFileSync(path.join(root, "../../script/publish.ts"), "utf8")

    expect(rootPublish).toContain("packages/opencode/script/publish.ts")
    expect(rootPublish).toContain("NeoResearch npm package")
    expect(rootPublish).not.toContain("packages/sdk")
    expect(rootPublish).not.toContain("packages/plugin")
    expect(rootPublish).not.toContain("packages/desktop")
  })
})
