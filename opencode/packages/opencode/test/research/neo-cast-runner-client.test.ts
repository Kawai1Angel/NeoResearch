import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import {
  createNeoCastRunnerCommand,
  loadNeoCastRunnerManifest,
  resolveNeoCastRunnerRoot,
} from "@/research/runners/neo-cast-runner"

const runtime = {
  currentCandidatePath: ".neo-cast/current_candidate.json",
  resolvedCandidatePath: ".neo-cast/resolved_candidate.json",
  artifactsDir: ".neo-cast/artifacts",
  pythonExecutable: "python3",
}

async function createRunnerRoot() {
  const runnerRoot = await mkdtemp(path.join(tmpdir(), "neo-cast-runner-client-"))
  await mkdir(path.join(runnerRoot, "py"), { recursive: true })
  await writeFile(
    path.join(runnerRoot, "runner-manifest.json"),
    `${JSON.stringify(
      {
        protocolVersion: "runner.v1",
        runnerID: "neo-cast-python",
        runnerKind: "subprocess",
        displayName: "Neo-Cast TSF Runner",
        domains: ["tsf"],
        commands: {
          smoke: {
            script: "py/validate.py",
            args: [
              "smoke",
              "--candidate-path",
              "{currentCandidatePath}",
              "--resolved-path",
              "{resolvedCandidatePath}",
              "--artifacts-dir",
              "{artifactsDir}",
            ],
          },
          run: {
            script: "py/runner.py",
            args: ["run", "--description", "{description}"],
            timeout_ms: 900000,
          },
          ref_test: {
            script: "py/runner.py",
            args: ["ref-test"],
            timeout_ms: 300000,
          },
          blind_test: {
            script: "py/runner.py",
            args: ["blind-test"],
            timeout_ms: 300000,
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
  return runnerRoot
}

describe("Neo-Cast runner client", () => {
  test("loads the explicit runner manifest and renders command placeholders", async () => {
    const runnerRoot = await createRunnerRoot()

    const manifest = loadNeoCastRunnerManifest(runnerRoot)
    const smoke = createNeoCastRunnerCommand({
      stage: "smoke",
      runtime,
      description: "smoke run",
      explicitRoot: runnerRoot,
    })
    const run = createNeoCastRunnerCommand({
      stage: "full",
      runtime,
      description: "full training run",
      explicitRoot: runnerRoot,
    })

    expect(manifest).toMatchObject({
      protocolVersion: "runner.v1",
      runnerID: "neo-cast-python",
      runnerKind: "subprocess",
      domains: ["tsf"],
    })
    expect(smoke).toEqual({
      executable: "python3",
      cwd: runnerRoot,
      args: [
        "py/validate.py",
        "smoke",
        "--candidate-path",
        ".neo-cast/current_candidate.json",
        "--resolved-path",
        ".neo-cast/resolved_candidate.json",
        "--artifacts-dir",
        ".neo-cast/artifacts",
      ],
    })
    expect(run).toEqual({
      executable: "python3",
      cwd: runnerRoot,
      args: ["py/runner.py", "run", "--description", "full training run"],
      timeoutMs: 900000,
    })
  })

  test("uses the project-local Neo-Cast runtime python when the task did not override pythonExecutable", async () => {
    const runnerRoot = await createRunnerRoot()
    const binDir = path.join(runnerRoot, ".neo-cast", "runtime", ".venv", "bin")
    await mkdir(binDir, { recursive: true })
    const pythonPath = path.join(binDir, "python")
    await writeFile(pythonPath, "#!/bin/sh\necho Python 3.12.0\n", "utf8")

    const command = createNeoCastRunnerCommand({
      stage: "smoke",
      runtime,
      description: "smoke run",
      explicitRoot: runnerRoot,
    })

    expect(command.executable).toBe(pythonPath)
  })

  test("discovers a package-bundled runner and keeps project state in the caller cwd", async () => {
    const packageRoot = await mkdtemp(path.join(tmpdir(), "neo-research-runner-client-package-"))
    const runnerRoot = path.join(packageRoot, "runners", "neo_cast")
    await mkdir(path.join(runnerRoot, "py"), { recursive: true })
    await writeFile(
      path.join(runnerRoot, "runner-manifest.json"),
      JSON.stringify({
        protocolVersion: "runner.v1",
        runnerID: "neo-cast-python",
        runnerKind: "subprocess",
        domains: ["tsf"],
        commands: {
          smoke: { script: "py/validate.py", args: ["smoke"] },
          run: { script: "py/runner.py", args: ["run", "--description", "{description}"] },
          ref_test: { script: "py/runner.py", args: ["ref-test"] },
          blind_test: { script: "py/runner.py", args: ["blind-test"] },
        },
      }),
      "utf8",
    )

    const previousPackageRoot = process.env.NEO_RESEARCH_PACKAGE_ROOT
    const previousNeoCastRoot = process.env.NEO_CAST_ROOT
    const previousNeoResearchNeoCastRoot = process.env.NEO_RESEARCH_NEO_CAST_ROOT
    try {
      process.env.NEO_RESEARCH_PACKAGE_ROOT = packageRoot
      delete process.env.NEO_CAST_ROOT
      delete process.env.NEO_RESEARCH_NEO_CAST_ROOT

      const resolved = resolveNeoCastRunnerRoot()
      const command = createNeoCastRunnerCommand({
        stage: "ref_test",
        runtime,
        description: "reference test",
      })

      expect(resolved).toBe(runnerRoot)
      expect(command.cwd).toBe(process.cwd())
      expect(command.args).toEqual([path.join(runnerRoot, "py/runner.py"), "ref-test"])
      expect(command.env).toMatchObject({
        NEO_CAST_PROJECT_ROOT: process.cwd(),
        NEO_CAST_PACKAGE_ROOT: runnerRoot,
      })
    } finally {
      if (previousPackageRoot === undefined) delete process.env.NEO_RESEARCH_PACKAGE_ROOT
      else process.env.NEO_RESEARCH_PACKAGE_ROOT = previousPackageRoot
      if (previousNeoCastRoot === undefined) delete process.env.NEO_CAST_ROOT
      else process.env.NEO_CAST_ROOT = previousNeoCastRoot
      if (previousNeoResearchNeoCastRoot === undefined) delete process.env.NEO_RESEARCH_NEO_CAST_ROOT
      else process.env.NEO_RESEARCH_NEO_CAST_ROOT = previousNeoResearchNeoCastRoot
    }
  })
})
