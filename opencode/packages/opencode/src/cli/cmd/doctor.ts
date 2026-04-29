import { existsSync } from "fs"
import path from "path"
import { spawnSync } from "child_process"
import { cmd } from "./cmd"

type Status = "ok" | "warn" | "fail"

type Check = {
  name: string
  status: Status
  detail: string
}

function existingDirectory(candidate: string | undefined) {
  if (!candidate) return undefined
  const resolved = path.resolve(candidate)
  return existsSync(resolved) ? resolved : undefined
}

export function discoverNeoCastRoot() {
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

function run(command: string, args: string[]) {
  return spawnSync(command, args, {
    encoding: "utf8",
    timeout: 15_000,
  })
}

function commandOutput(result: ReturnType<typeof spawnSync>) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
}

function checkPython(python: string): Check {
  const result = run(python, ["--version"])
  if (result.error) {
    return {
      name: "python",
      status: "fail",
      detail: `${python} is not executable: ${result.error.message}`,
    }
  }
  if (result.status !== 0) {
    return {
      name: "python",
      status: "fail",
      detail: `${python} --version exited ${result.status}: ${commandOutput(result)}`,
    }
  }
  return {
    name: "python",
    status: "ok",
    detail: commandOutput(result) || python,
  }
}

function checkPythonImports(python: string): Check {
  const result = run(python, ["-c", "import numpy; import torch; print('numpy+torch import ok')"])
  if (result.error) {
    return {
      name: "python-imports",
      status: "fail",
      detail: result.error.message,
    }
  }
  if (result.status !== 0) {
    return {
      name: "python-imports",
      status: "fail",
      detail: commandOutput(result) || "numpy or torch import failed",
    }
  }
  return {
    name: "python-imports",
    status: "ok",
    detail: commandOutput(result),
  }
}

function checkNeoCastRoot(root: string | undefined): Check {
  if (!root) {
    return {
      name: "NEO_CAST_ROOT",
      status: "warn",
      detail:
        "not found; set NEO_CAST_ROOT or NEO_RESEARCH_NEO_CAST_ROOT to a local neo_cast checkout, or install a package with runners/neo_cast",
    }
  }

  const runner = path.join(root, "py", "runner.py")
  const validate = path.join(root, "py", "validate.py")
  if (!existsSync(runner) || !existsSync(validate)) {
    return {
      name: "NEO_CAST_ROOT",
      status: "fail",
      detail: `${root} exists but py/runner.py or py/validate.py is missing`,
    }
  }

  return {
    name: "NEO_CAST_ROOT",
    status: "ok",
    detail: root,
  }
}

function checkSmokeRunner(root: string | undefined, python: string): Check {
  if (!root) {
    return {
      name: "smoke-runner",
      status: "warn",
      detail: "skipped because Neo-Cast root was not found",
    }
  }

  const runner = path.join(root, "py", "runner.py")
  const result = spawnSync(python, [runner, "--help"], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      NEO_CAST_PROJECT_ROOT: root,
      NEO_CAST_PACKAGE_ROOT: root,
    },
  })
  if (result.error) {
    return {
      name: "smoke-runner",
      status: "fail",
      detail: result.error.message,
    }
  }
  if (result.status !== 0) {
    return {
      name: "smoke-runner",
      status: "fail",
      detail: commandOutput(result) || `runner.py --help exited ${result.status}`,
    }
  }
  return {
    name: "smoke-runner",
    status: "ok",
    detail: "neo_cast runner.py is executable",
  }
}

function formatChecks(checks: Check[]) {
  const width = Math.max(...checks.map((check) => check.name.length), "check".length)
  return [
    `${"check".padEnd(width)}  status  detail`,
    `${"-".repeat(width)}  ------  ------`,
    ...checks.map((check) => `${check.name.padEnd(width)}  ${check.status.padEnd(6)}  ${check.detail}`),
  ].join("\n")
}

export function runDoctor(input: { python?: string } = {}) {
  const python = input.python ?? process.env.PYTHON ?? "python3"
  const neoCastRoot = discoverNeoCastRoot()
  return [
    checkNeoCastRoot(neoCastRoot),
    checkPython(python),
    checkPythonImports(python),
    checkSmokeRunner(neoCastRoot, python),
  ]
}

export const DoctorCommand = cmd({
  command: "doctor",
  describe: "check local NeoResearch and Neo-Cast runner environment",
  builder: (yargs) =>
    yargs
      .option("python", {
        describe: "Python executable to check",
        type: "string",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"] as const,
        default: "table" as const,
      }),
  handler: (args) => {
    const checks = runDoctor({ python: args.python })
    if (args.format === "json") {
      console.log(JSON.stringify({ ok: checks.every((check) => check.status !== "fail"), checks }, null, 2))
      return
    }
    console.log(formatChecks(checks))
    if (checks.some((check) => check.status === "fail")) process.exitCode = 1
  },
})
