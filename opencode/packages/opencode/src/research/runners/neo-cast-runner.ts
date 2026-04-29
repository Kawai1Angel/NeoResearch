import { existsSync, readFileSync } from "fs"
import path from "path"
import z from "zod"

import type { DomainRunStage, DomainRunnerCommand } from "../domain"

const RunnerCommandManifest = z
  .object({
    script: z.string().min(1),
    args: z.array(z.string()).default([]),
  })
  .strict()

const NeoCastRunnerManifest = z
  .object({
    protocolVersion: z.literal("runner.v1"),
    runnerID: z.string().min(1),
    runnerKind: z.literal("subprocess"),
    displayName: z.string().optional(),
    domains: z.array(z.string().min(1)).min(1),
    commands: z
      .object({
        smoke: RunnerCommandManifest,
        run: RunnerCommandManifest,
        ref_test: RunnerCommandManifest,
        blind_test: RunnerCommandManifest,
      })
      .strict(),
  })
  .strict()

export type NeoCastRunnerManifest = z.infer<typeof NeoCastRunnerManifest>

type NeoCastRuntime = {
  readonly pythonExecutable: string
  readonly currentCandidatePath: string
  readonly resolvedCandidatePath: string
  readonly artifactsDir: string
}

const DEFAULT_NEO_CAST_MANIFEST: NeoCastRunnerManifest = {
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
    },
    ref_test: {
      script: "py/runner.py",
      args: ["ref-test"],
    },
    blind_test: {
      script: "py/runner.py",
      args: ["blind-test"],
    },
  },
}

function existingDirectory(candidate: string | undefined) {
  if (!candidate) return undefined
  const resolved = path.resolve(candidate)
  return existsSync(resolved) ? resolved : undefined
}

export function resolveNeoCastRunnerRoot(explicitRoot?: string) {
  if (explicitRoot !== undefined) return path.resolve(explicitRoot)
  return (
    existingDirectory(process.env.NEO_RESEARCH_NEO_CAST_ROOT) ??
    existingDirectory(process.env.NEO_CAST_ROOT) ??
    existingDirectory(
      process.env.NEO_RESEARCH_PACKAGE_ROOT === undefined
        ? undefined
        : path.join(process.env.NEO_RESEARCH_PACKAGE_ROOT, "runners", "neo_cast"),
    ) ??
    existingDirectory(path.resolve(import.meta.dirname, "../../../../../../neo_cast"))
  )
}

export function loadNeoCastRunnerManifest(runnerRoot: string | undefined): NeoCastRunnerManifest {
  if (runnerRoot === undefined) return DEFAULT_NEO_CAST_MANIFEST
  const manifestPath = path.join(runnerRoot, "runner-manifest.json")
  if (!existsSync(manifestPath)) return DEFAULT_NEO_CAST_MANIFEST
  return NeoCastRunnerManifest.parse(JSON.parse(readFileSync(manifestPath, "utf8")))
}

function commandKeyForStage(stage: DomainRunStage) {
  if (stage === "smoke") return "smoke"
  if (stage === "ref_test") return "ref_test"
  if (stage === "blind_test") return "blind_test"
  return "run"
}

function renderTemplate(value: string, variables: Record<string, string>) {
  return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => {
    const replacement = variables[key]
    if (replacement === undefined) throw new Error(`Unknown Neo-Cast runner manifest placeholder: ${match}`)
    return replacement
  })
}

function commandEnvironment(runnerRoot: string | undefined) {
  if (runnerRoot === undefined) return undefined
  return {
    NEO_CAST_PROJECT_ROOT: process.cwd(),
    NEO_CAST_PACKAGE_ROOT: runnerRoot,
  }
}

export function createNeoCastRunnerCommand(input: {
  readonly stage: DomainRunStage
  readonly runtime: NeoCastRuntime
  readonly description: string
  readonly explicitRoot?: string
}): DomainRunnerCommand {
  const runnerRoot = resolveNeoCastRunnerRoot(input.explicitRoot)
  const manifest = loadNeoCastRunnerManifest(runnerRoot)
  const command = manifest.commands[commandKeyForStage(input.stage)]
  const variables = {
    currentCandidatePath: input.runtime.currentCandidatePath,
    resolvedCandidatePath: input.runtime.resolvedCandidatePath,
    artifactsDir: input.runtime.artifactsDir,
    description: input.description,
  }
  const script =
    input.explicitRoot === undefined && runnerRoot !== undefined
      ? path.join(runnerRoot, renderTemplate(command.script, variables))
      : renderTemplate(command.script, variables)
  const cwd =
    input.explicitRoot === undefined && runnerRoot !== undefined
      ? { cwd: process.cwd() }
      : input.explicitRoot === undefined
        ? {}
        : { cwd: path.resolve(input.explicitRoot) }
  const env = input.explicitRoot === undefined ? commandEnvironment(runnerRoot) : undefined

  return {
    executable: input.runtime.pythonExecutable,
    args: [script, ...command.args.map((arg) => renderTemplate(arg, variables))],
    ...cwd,
    ...(env === undefined ? {} : { env }),
  }
}

export function getNeoCastRunnerManifestForTask(explicitRoot?: string) {
  return loadNeoCastRunnerManifest(resolveNeoCastRunnerRoot(explicitRoot))
}
