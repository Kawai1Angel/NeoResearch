import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import yargs from "yargs/yargs"
import { Instance } from "../../src/project/instance"
import { Research } from "../../src/research"
import type { DomainRunPlan } from "../../src/research/domain"
import { createFileResearchRuntime, researchJobFromRunPlan } from "../../src/research/runtime"
import {
  ResearchCommand,
  ResearchCreateCommand,
  ResearchIterateCommand,
  ResearchLoopCommand,
  ResearchPipelineCommand,
  ResearchProfileCommand,
  ResearchRunCommand,
  ResearchRequestBlindTestCommand,
  ResearchRequestRefTestCommand,
  ResearchRequestShadowHoldoutCommand,
  ResearchSeedSweepCommand,
  ResearchWorkerLoopCommand,
  ResearchWorkerOnceCommand,
} from "../../src/cli/cmd/research"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

function runResearch<A, E>(fx: Effect.Effect<A, E, Research.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(Research.defaultLayer)))
}

function validTsfTaskSpec(runtime: Research.JsonRecord = {}) {
  return {
    contextLength: 96,
    predictionLengths: [24],
    dataset: {
      loaderID: "etth1_tslib_v1",
      targetCols: ["OT"],
    },
    runtime,
  }
}

function validTsfCandidateSpec() {
  return Research.DomainRegistry.buildBaselines("tsf", validTsfTaskSpec())[0]!.candidateSpec
}

async function writeFakeNeoCastRunner(root: string) {
  await mkdir(path.join(root, "py"), { recursive: true })
  await writeFile(
    path.join(root, "py", "validate.py"),
    `#!/usr/bin/env bash
set -euo pipefail
mkdir -p .neo-cast/artifacts/run_worker_db
printf '{"event":"candidate_resolved"}\\n'
printf '{"event":"smoke_eval_done","val_avg_mse":0.111,"val_avg_mae":0.222}\\n'
printf '{"event":"artifact_ready","run_id":"worker_db","artifact_dir":"%s"}\\n' "$(pwd)/.neo-cast/artifacts/run_worker_db"
printf '{"event":"done","status":"success"}\\n'
`,
    "utf8",
  )
}

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
})

describe("research CLI commands", () => {
  test("autonomous commands default to full training while direct candidate runs default to smoke", async () => {
    const stageDefault = async (command: typeof ResearchRunCommand) => {
      if (typeof command.builder !== "function") throw new Error("research command builder must be callable")
      const configured = await command.builder(yargs([]))
      return (configured as unknown as { getOptions: () => { default: Record<string, unknown> } }).getOptions().default.stage
    }
    for (const command of [ResearchIterateCommand, ResearchLoopCommand, ResearchPipelineCommand]) {
      expect(await stageDefault(command)).toBe("full")
    }
    expect(await stageDefault(ResearchRunCommand)).toBe("smoke")
  })

  test("registers a command for requesting candidate reference-test gates", () => {
    expect(ResearchRequestRefTestCommand.command).toBe("request-ref-test <taskID> <candidateID>")
    expect(ResearchRequestRefTestCommand.describe).toContain("reference-test")
    expect(ResearchRequestBlindTestCommand.command).toBe("request-blind-test <taskID> <candidateID>")
    expect(ResearchRequestBlindTestCommand.describe).toContain("blind-test")
    expect(ResearchRequestShadowHoldoutCommand.command).toBe("request-shadow-holdout <taskID> <candidateID>")
    expect(ResearchRequestShadowHoldoutCommand.describe).toContain("shadow holdout")
    expect(ResearchSeedSweepCommand.command).toBe("seed-sweep <taskID> <candidateID>")
    expect(ResearchSeedSweepCommand.describe).toContain("seed sweep")
    expect(ResearchWorkerOnceCommand.command).toBe("worker-once")
    expect(ResearchWorkerOnceCommand.describe).toContain("worker")
    expect(ResearchWorkerLoopCommand.command).toBe("worker-loop")
    expect(ResearchWorkerLoopCommand.describe).toContain("worker")
    expect(ResearchPipelineCommand.command).toBe("pipeline <taskID>")
    expect(ResearchPipelineCommand.describe).toContain("multi-agent")

    const registered: string[] = []
    const yargs = {
      command(command: { command?: string }) {
        if (command.command) registered.push(command.command)
        return this
      },
      demandCommand() {
        return this
      },
    }
    expect(typeof ResearchCommand.builder).toBe("function")
    if (typeof ResearchCommand.builder !== "function") throw new Error("research command builder must be callable")
    ResearchCommand.builder(yargs as never)

    expect(registered).toContain("request-ref-test <taskID> <candidateID>")
    expect(registered).toContain("request-blind-test <taskID> <candidateID>")
    expect(registered).toContain("request-shadow-holdout <taskID> <candidateID>")
    expect(registered).toContain("seed-sweep <taskID> <candidateID>")
    expect(registered).toContain("profile <taskID>")
    expect(registered).toContain("pipeline <taskID>")
    expect(registered).toContain("worker-once")
    expect(registered).toContain("worker-loop")
  })

  test("create command exposes TSF dataset task options", () => {
    const options: string[] = []
    const yargs = {
      option(name: string) {
        options.push(name)
        return this
      },
    }
    expect(typeof ResearchCreateCommand.builder).toBe("function")
    if (typeof ResearchCreateCommand.builder !== "function") throw new Error("create command builder must be callable")
    ResearchCreateCommand.builder(yargs as never)

    expect(options).toContain("dataset-path")
    expect(options).toContain("dataset-preset")
    expect(options).toContain("target-cols")
    expect(options).toContain("context-length")
    expect(options).toContain("prediction-lengths")
    expect(options).toContain("full-recipe-space")
  })

  test("worker-once command leases and executes one queued file-runtime job", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const runtimeRoot = path.join(tmp.path, ".neo-research", "runtime")
    const runnerRoot = path.join(tmp.path, "runner")
    await mkdir(path.join(runnerRoot, "py"), { recursive: true })
    await writeFile(
      path.join(runnerRoot, "py", "runner.sh"),
      `#!/usr/bin/env bash
set -euo pipefail
test -f .neo-cast/current_candidate.json
mkdir -p .neo-cast/artifacts/worker_cli
printf '{"event":"smoke_eval_done","val_avg_mse":0.321,"val_avg_mae":0.654}\\n'
printf '{"event":"artifact_ready","artifact_dir":"%s"}\\n' "$(pwd)/.neo-cast/artifacts/worker_cli"
`,
      "utf8",
    )

    const plan: DomainRunPlan = {
      domainID: "tsf",
      runnerID: "neo-cast-python",
      runnerKind: "subprocess",
      stage: "smoke",
      approvalRequired: false,
      validation: { ok: true, issues: [] },
      writes: [{ path: ".neo-cast/current_candidate.json", content: { recipe_id: "candidate_worker_once" } }],
      command: { executable: "bash", args: ["py/runner.sh"], cwd: runnerRoot },
      expectedEvents: ["smoke_eval_done"],
      expectedMetrics: ["val_avg_mse"],
      expectedArtifacts: ["runner_artifact"],
    }
    const runtime = createFileResearchRuntime(runtimeRoot)
    const job = researchJobFromRunPlan({
      taskID: "rtsk_cli_worker",
      runID: "rrun_cli_worker",
      runPlan: plan,
      priority: 5,
      now: 100,
    })
    await runtime.queue.enqueue(job)

    const logs: string[] = []
    const originalLog = console.log
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "))
      await ResearchWorkerOnceCommand.handler?.({
        runtimeRoot,
        workerId: "worker-cli",
        now: 200,
        leaseMs: 1_000,
        format: "json",
      } as never)
    } finally {
      console.log = originalLog
    }

    const result = JSON.parse(logs.join("\n"))
    expect(result).toMatchObject({
      status: "completed",
      jobID: job.id,
    })
    expect(result.artifactURIs[0]).toStartWith("file://")
    expect(await runtime.queue.lease({ workerID: "worker-after", now: 300 })).toBeUndefined()
    expect(await readFile(path.join(runtimeRoot, "metrics", "run-metrics.jsonl"), "utf8")).toContain("val_avg_mse")
    expect(await readFile(path.join(runtimeRoot, "artifacts", "artifacts.jsonl"), "utf8")).toContain("runner_artifact")
  })

  test("worker-loop command drains multiple queued file-runtime jobs", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const runtimeRoot = path.join(tmp.path, ".neo-research", "runtime")
    const runnerRoot = path.join(tmp.path, "runner-loop")
    await mkdir(path.join(runnerRoot, "py"), { recursive: true })
    await writeFile(
      path.join(runnerRoot, "py", "runner.sh"),
      `#!/usr/bin/env bash
set -euo pipefail
run_id="$(grep -m1 '"recipe_id"' .neo-cast/current_candidate.json | sed 's/.*"recipe_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/')"
mkdir -p ".neo-cast/artifacts/$run_id"
printf '{"event":"smoke_eval_done","val_avg_mse":0.5}\\n'
printf '{"event":"artifact_ready","artifact_dir":"%s"}\\n' "$(pwd)/.neo-cast/artifacts/$run_id"
`,
      "utf8",
    )
    const runtime = createFileResearchRuntime(runtimeRoot)
    for (const runID of ["rrun_loop_a", "rrun_loop_b"]) {
      const plan: DomainRunPlan = {
        domainID: "tsf",
        runnerID: "neo-cast-python",
        runnerKind: "subprocess",
        stage: "smoke",
        approvalRequired: false,
        validation: { ok: true, issues: [] },
        writes: [{ path: ".neo-cast/current_candidate.json", content: { recipe_id: runID } }],
        command: { executable: "bash", args: ["py/runner.sh"], cwd: runnerRoot },
        expectedEvents: ["smoke_eval_done"],
        expectedMetrics: ["val_avg_mse"],
        expectedArtifacts: ["runner_artifact"],
      }
      await runtime.queue.enqueue(
        researchJobFromRunPlan({
          taskID: "rtsk_cli_worker_loop",
          runID,
          runPlan: plan,
          priority: 5,
          now: 100,
        }),
      )
    }

    const logs: string[] = []
    const originalLog = console.log
    try {
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "))
      await ResearchWorkerLoopCommand.handler?.({
        runtimeRoot,
        workerId: "worker-loop-cli",
        maxJobs: 2,
        now: 200,
        leaseMs: 1_000,
        format: "json",
      } as never)
    } finally {
      console.log = originalLog
    }

    const result = JSON.parse(logs.join("\n"))
    expect(result).toMatchObject({
      status: "max_jobs",
      workerID: "worker-loop-cli",
      iterations: 2,
      completed: 2,
      retryScheduled: 0,
      deadLettered: 0,
    })
    expect(await runtime.queue.lease({ workerID: "worker-after-loop", now: 300 })).toBeUndefined()
  })

  test("worker-once command syncs queued prepared runs back into the research database", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
    await writeFakeNeoCastRunner(fakeNeoCastRoot)

    const setup = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "worker sync task",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec({
                bridgeOnly: true,
                neoCastProjectRoot: fakeNeoCastRoot,
                pythonExecutable: "bash",
              }),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 3 },
            }),
          ),
        )
        const candidate = await runResearch(
          Research.Service.use((svc) =>
            svc.createCandidate({
              taskID: task.id,
              domainID: "tsf",
              candidateSpec: validTsfCandidateSpec(),
              rationale: "worker sync baseline",
              riskLevel: "low",
              approvalStatus: "auto_approved",
              generatedBy: "heuristic",
            }),
          ),
        )
        const prepared = await runResearch(
          Research.Service.use((svc) =>
            svc.prepareRun({
              taskID: task.id,
              candidateID: candidate.id,
              stage: "smoke",
              description: "queued worker sync",
            }),
          ),
        )
        return { candidate, prepared, task }
      },
    })

    const logs: string[] = []
    const originalCwd = process.cwd()
    const originalLog = console.log
    try {
      process.chdir(tmp.path)
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "))
      await ResearchWorkerOnceCommand.handler?.({
        workerId: "worker-db-sync",
        now: Number.MAX_SAFE_INTEGER - 1,
        format: "json",
      } as never)
    } finally {
      console.log = originalLog
      process.chdir(originalCwd)
    }

    const workerResult = JSON.parse(logs.join("\n"))
    expect(workerResult).toMatchObject({
      status: "completed",
      jobID: `${setup.task.id}/${setup.prepared.run.id}/1`,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const runs = await runResearch(Research.Service.use((svc) => svc.listRuns(setup.task.id)))
        const syncedRun = runs.find((run) => run.id === setup.prepared.run.id)
        expect(syncedRun?.status).toBe("succeeded")
        expect(syncedRun?.metrics.val_avg_mse).toBe(0.111)
        expect(syncedRun?.resourceUsage.exitCode).toBe(0)
        expect(syncedRun?.artifactRefs.length).toBeGreaterThanOrEqual(3)

        const artifacts = await runResearch(Research.Service.use((svc) => svc.listArtifacts(setup.task.id)))
        expect(artifacts.some((artifact) => artifact.kind === "runner_artifact" && artifact.runID === syncedRun?.id)).toBe(true)
        const executionLog = artifacts.find(
          (artifact) => artifact.kind === "runner_execution_log_json" && artifact.runID === syncedRun?.id,
        )
        expect(executionLog?.metadata).toMatchObject({
          runnerID: "neo-cast-python",
          stage: "smoke",
          exitCode: 0,
          recordCount: 4,
        })
        expect(syncedRun?.artifactRefs).toContain(executionLog!.id)
        const executionLogRecord = JSON.parse(await readFile(executionLog!.uri.replace("file://", ""), "utf8"))
        expect(executionLogRecord.records.map((record: { event?: string }) => record.event)).toContain("artifact_ready")
        const champion = await runResearch(Research.Service.use((svc) => svc.getChampion(setup.task.id)))
        expect(champion?.candidateID).toBe(setup.candidate.id)
        expect(champion?.primaryMetric).toBe(0.111)
      },
    })
  })

  test("profile command creates a task profile artifact", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const task = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "ETTh1 CLI profile",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 3 },
            }),
          ),
        ),
    })

    const logs: string[] = []
    const originalCwd = process.cwd()
    const originalLog = console.log
    try {
      process.chdir(tmp.path)
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "))
      await ResearchProfileCommand.handler?.({
        taskID: task.id,
        outputDir: ".neo-research/profile",
        format: "table",
      } as never)
    } finally {
      console.log = originalLog
      process.chdir(originalCwd)
    }

    expect(logs.join("\n")).toContain("Profile task_profile_json")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const artifacts = await runResearch(Research.Service.use((svc) => svc.listArtifacts(task.id)))
        expect(artifacts.map((artifact) => artifact.kind)).toContain("task_profile_json")
      },
    })
  })

  test("request-ref-test creates a pending ref_test approval", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const setup = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "ETTh1 CLI approval",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 3 },
            }),
          ),
        )
        const candidate = await runResearch(
          Research.Service.use((svc) =>
            svc.createCandidate({
              taskID: task.id,
              domainID: "tsf",
              candidateSpec: validTsfCandidateSpec(),
              rationale: "baseline modular candidate",
              riskLevel: "low",
              approvalStatus: "auto_approved",
              generatedBy: "heuristic",
            }),
          ),
        )
        return { candidate, task }
      },
    })

    const logs: string[] = []
    const originalCwd = process.cwd()
    const originalLog = console.log
    try {
      process.chdir(tmp.path)
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "))
      await ResearchRequestRefTestCommand.handler?.({
        taskID: setup.task.id,
        candidateID: setup.candidate.id,
        reason: "Need held-out reference split.",
        format: "json",
      } as never)
    } finally {
      console.log = originalLog
      process.chdir(originalCwd)
    }

    const approval = JSON.parse(logs.join("\n")) as Research.ResearchApproval
    expect(approval.taskID).toBe(setup.task.id)
    expect(approval.candidateID).toBe(setup.candidate.id)
    expect(approval.kind).toBe("ref_test")
    expect(approval.status).toBe("pending")
    expect(approval.reason).toBe("Need held-out reference split.")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const approvals = await runResearch(Research.Service.use((svc) => svc.listApprovals({ taskID: setup.task.id })))
        expect(approvals).toHaveLength(1)
        expect(approvals[0]!.id).toBe(approval.id)
      },
    })
  })

  test("request-blind-test creates a pending blind_test approval", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const setup = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "ETTh1 CLI blind approval",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 3, governance: { blindTestQueryLimit: 1 } },
            }),
          ),
        )
        const candidate = await runResearch(
          Research.Service.use((svc) =>
            svc.createCandidate({
              taskID: task.id,
              domainID: "tsf",
              candidateSpec: validTsfCandidateSpec(),
              rationale: "baseline modular candidate",
              riskLevel: "low",
              approvalStatus: "auto_approved",
              generatedBy: "heuristic",
            }),
          ),
        )
        return { candidate, task }
      },
    })

    const logs: string[] = []
    const originalCwd = process.cwd()
    const originalLog = console.log
    try {
      process.chdir(tmp.path)
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "))
      await ResearchRequestBlindTestCommand.handler?.({
        taskID: setup.task.id,
        candidateID: setup.candidate.id,
        reason: "Need private blind test approval.",
        format: "json",
      } as never)
    } finally {
      console.log = originalLog
      process.chdir(originalCwd)
    }

    const approval = JSON.parse(logs.join("\n")) as Research.ResearchApproval
    expect(approval.taskID).toBe(setup.task.id)
    expect(approval.candidateID).toBe(setup.candidate.id)
    expect(approval.kind).toBe("blind_test")
    expect(approval.status).toBe("pending")
    expect(approval.reason).toBe("Need private blind test approval.")
  })

  test("request-shadow-holdout creates a pending shadow_holdout approval", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const setup = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "ETTh1 CLI shadow approval",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 3, governance: { requireShadowHoldout: true } },
            }),
          ),
        )
        const candidate = await runResearch(
          Research.Service.use((svc) =>
            svc.createCandidate({
              taskID: task.id,
              domainID: "tsf",
              candidateSpec: validTsfCandidateSpec(),
              rationale: "baseline modular candidate",
              riskLevel: "low",
              approvalStatus: "auto_approved",
              generatedBy: "heuristic",
            }),
          ),
        )
        return { candidate, task }
      },
    })

    const logs: string[] = []
    const originalCwd = process.cwd()
    const originalLog = console.log
    try {
      process.chdir(tmp.path)
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "))
      await ResearchRequestShadowHoldoutCommand.handler?.({
        taskID: setup.task.id,
        candidateID: setup.candidate.id,
        reason: "Need blind shadow holdout approval.",
        format: "json",
      } as never)
    } finally {
      console.log = originalLog
      process.chdir(originalCwd)
    }

    const approval = JSON.parse(logs.join("\n")) as Research.ResearchApproval
    expect(approval.taskID).toBe(setup.task.id)
    expect(approval.candidateID).toBe(setup.candidate.id)
    expect(approval.kind).toBe("shadow_holdout")
    expect(approval.status).toBe("pending")
    expect(approval.reason).toBe("Need blind shadow holdout approval.")
  })
})
