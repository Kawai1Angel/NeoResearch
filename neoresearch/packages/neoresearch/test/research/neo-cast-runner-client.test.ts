import { describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { ensureNpmNeoCastPython, npmNeoCastRuntime } from "@/research/runners/neo-cast-install"
import { resolveNpmNeoCastRoot } from "@/research/runners/neo-cast-package"
import * as Process from "@/util/process"
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

test("finds an npm runner beside the CLI and retries its first Python setup only once", async () => {
  const prefix = await mkdtemp(path.join(tmpdir(), "neo-cast-npm-"))
  const root = path.join(prefix, "node_modules", "neo-cast")
  const app = path.join(prefix, "node_modules", "neo-research")
  const previous = process.env.NEO_RESEARCH_PACKAGE_ROOT
  try {
    await mkdir(path.join(root, "py"), { recursive: true })
    await mkdir(app, { recursive: true })
    await Promise.all([
      writeFile(path.join(root, "package.json"), '{"name":"neo-cast"}'),
      writeFile(path.join(root, "runner-manifest.json"), "{}"),
      writeFile(path.join(root, "py", "runner.py"), ""),
      writeFile(path.join(root, "uv.lock"), "version = 1\n"),
    ])
    expect(resolveNpmNeoCastRoot(prefix)).toBe(root)
    process.env.NEO_RESEARCH_PACKAGE_ROOT = app
    expect(resolveNpmNeoCastRoot(tmpdir())).toBe(root)

    const managed = npmNeoCastRuntime(root)!
    expect(managed.directory.startsWith(root + path.sep)).toBe(false)
    expect(managed.ready).toBe(false)
    const which = spyOn(Bun, "which").mockReturnValue("uv")
    const run = spyOn(Process, "run")
    try {
      run.mockResolvedValueOnce({ code: 1, stdout: Buffer.from(""), stderr: Buffer.from("offline") })
      await expect(ensureNpmNeoCastPython(root)).rejects.toThrow("offline")
      expect(npmNeoCastRuntime(root)?.ready).toBe(false)
      run.mockImplementationOnce(async (args, options) => {
        expect(args).toContain("--frozen")
        expect(options?.env?.UV_PROJECT_ENVIRONMENT).toBe(path.dirname(path.dirname(managed.python)))
        await mkdir(path.dirname(managed.python), { recursive: true })
        await writeFile(managed.python, "")
        return { code: 0, stdout: Buffer.from(""), stderr: Buffer.from("") }
      })
      expect(await Promise.all([ensureNpmNeoCastPython(root), ensureNpmNeoCastPython(root)])).toEqual([
        managed.python, managed.python,
      ])
      expect(await ensureNpmNeoCastPython(root)).toBe(managed.python)
      expect(run).toHaveBeenCalledTimes(2)
    } finally {
      run.mockRestore()
      which.mockRestore()
    }
  } finally {
    if (previous === undefined) delete process.env.NEO_RESEARCH_PACKAGE_ROOT
    else process.env.NEO_RESEARCH_PACKAGE_ROOT = previous
    await rm(prefix, { recursive: true, force: true })
  }
})

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
      cwd: process.cwd(),
      args: [
        path.join(runnerRoot, "py/validate.py"),
        "smoke",
        "--candidate-path",
        ".neo-cast/current_candidate.json",
        "--resolved-path",
        ".neo-cast/resolved_candidate.json",
        "--artifacts-dir",
        ".neo-cast/artifacts",
      ],
      env: {
        NEO_CAST_PROJECT_ROOT: process.cwd(),
        NEO_CAST_PACKAGE_ROOT: runnerRoot,
      },
    })
    expect(run).toEqual({
      executable: "python3",
      cwd: process.cwd(),
      args: [path.join(runnerRoot, "py/runner.py"), "run", "--description", "full training run"],
      timeoutMs: 900000,
      env: {
        NEO_CAST_PROJECT_ROOT: process.cwd(),
        NEO_CAST_PACKAGE_ROOT: runnerRoot,
      },
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

  test("passes explicit Neo-Cast run IDs to privileged evaluation commands", async () => {
    const runnerRoot = await createRunnerRoot()

    const command = createNeoCastRunnerCommand({
      stage: "ref_test",
      runtime,
      description: "reference test",
      runnerRunID: "20260629-063757-hbrp",
      explicitRoot: runnerRoot,
    })

    expect(command.args).toEqual([
      path.join(runnerRoot, "py/runner.py"),
      "ref-test",
      "--run-id",
      "20260629-063757-hbrp",
    ])
  })

  test("keeps explicit shared runner code separate from an environment-selected project state root", async () => {
    const runnerRoot = await createRunnerRoot()
    const projectRoot = await mkdtemp(path.join(tmpdir(), "neo-cast-project-state-"))
    const previousProjectRoot = process.env.NEO_CAST_PROJECT_ROOT
    try {
      process.env.NEO_CAST_PROJECT_ROOT = projectRoot
      const command = createNeoCastRunnerCommand({
        stage: "smoke",
        runtime,
        description: "isolated smoke run",
        explicitRoot: runnerRoot,
      })

      expect(command.cwd).toBe(projectRoot)
      expect(command.args[0]).toBe(path.join(runnerRoot, "py", "validate.py"))
      expect(command.env).toEqual({
        NEO_CAST_PROJECT_ROOT: projectRoot,
        NEO_CAST_PACKAGE_ROOT: runnerRoot,
      })
    } finally {
      if (previousProjectRoot === undefined) delete process.env.NEO_CAST_PROJECT_ROOT
      else process.env.NEO_CAST_PROJECT_ROOT = previousProjectRoot
    }
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
