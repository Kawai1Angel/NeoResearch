import type { Argv } from "yargs"
import { Effect } from "effect"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { AppRuntime } from "@/effect/app-runtime"
import { Instance } from "@/project/instance"
import { Research } from "@/research"
import {
  createFileResearchRuntime,
  executeSubprocessResearchJob,
  runResearchWorkerOnce,
  type ResearchJob,
  type ResearchWorkerExecutionResult,
  type ResearchWorkerOnceResult,
} from "@/research/runtime"
import { cmd } from "./cmd"
import {
  buildDefaultTsfResearchTaskInput,
  buildDefaultTsfResearchTaskInputFromGoal,
  formatResearchApprovalsTable,
  formatResearchArtifactsTable,
  formatResearchAutonomousIteration,
  formatResearchAutonomousLoop,
  formatResearchExport,
  formatResearchMemoryTable,
  formatResearchProfile,
  formatResearchRunResult,
  formatResearchSeedSweep,
  formatResearchStatus,
  formatResearchTasksTable,
  formatResearchWorkerLoop,
  formatResearchWorkerOnce,
  researchModeForInteractionMode,
  type ResearchOutputFormat,
  type ResearchInteractionMode,
} from "./research-data"

type FormatArg = {
  format?: ResearchOutputFormat
}

async function runResearch<T>(fn: (svc: Research.Interface) => Effect.Effect<T>) {
  return Instance.provide({
    directory: process.cwd(),
    async fn() {
      return AppRuntime.runPromise(Research.Service.use(fn))
    },
  })
}

function print(value: unknown, format: ResearchOutputFormat | undefined, table: () => string) {
  if (format === "json") {
    console.log(JSON.stringify(value, null, 2))
    return
  }
  console.log(table())
}

async function findResearchRunForWorkerJob(job: ResearchJob) {
  try {
    const taskID = Research.ResearchTaskID.make(String(job.taskID))
    const runID = Research.ResearchRunID.make(String(job.runID))
    const runs = await runResearch((svc) => svc.listRuns(taskID))
    return runs.find((run) => run.id === runID)
  } catch {
    return undefined
  }
}

async function syncResearchWorkerRunStarted(job: ResearchJob) {
  const run = await findResearchRunForWorkerJob(job)
  if (!run) return undefined
  if (run.status === "running") return run
  return runResearch((svc) =>
    svc.updateRunStatus({
      runID: Research.ResearchRunID.make(String(job.runID)),
      status: "running",
    }),
  )
}

async function syncResearchWorkerRunFinished(input: {
  job: ResearchJob
  run?: Research.ResearchRun
  result: ResearchWorkerOnceResult
  execution?: ResearchWorkerExecutionResult
  artifactURIs: readonly string[]
}) {
  const run = input.run ?? (await findResearchRunForWorkerJob(input.job))
  const execution = input.execution
  if (!run || !execution || input.result.status === "idle") return

  const taskID = Research.ResearchTaskID.make(String(input.job.taskID))
  const runID = Research.ResearchRunID.make(String(input.job.runID))
  const artifactRefs: Research.ResearchArtifactID[] = [...run.artifactRefs]
  const payload = input.job.payload && typeof input.job.payload === "object" && !Array.isArray(input.job.payload)
    ? (input.job.payload as Record<string, unknown>)
    : {}
  const runnerKind = typeof payload.runnerKind === "string" ? payload.runnerKind : "subprocess"
  const stage = typeof payload.stage === "string" ? payload.stage : String(input.job.stage)
  const command = payload.command && typeof payload.command === "object" && !Array.isArray(payload.command)
    ? payload.command
    : undefined
  const executionLog = execution.executionLog
  if (executionLog !== undefined) {
    const exitCode = typeof execution.resourceUsage?.exitCode === "number" ? execution.resourceUsage.exitCode : undefined
    const executionLogDirectory = path.resolve(".neo-research", "runner-executions", String(input.job.taskID))
    const executionLogPath = path.join(executionLogDirectory, `${input.job.runID}.json`)
    await mkdir(executionLogDirectory, { recursive: true })
    await writeFile(
      executionLogPath,
      `${JSON.stringify(
        {
          taskID: input.job.taskID,
          candidateID: run.candidateID,
          runID: input.job.runID,
          runnerID: input.job.runnerID,
          runnerKind,
          stage,
          command,
          exitCode,
          stdout: executionLog.stdout,
          stderr: executionLog.stderr,
          records: executionLog.records,
        },
        null,
        2,
      )}\n`,
      "utf8",
    )
    const stored = await runResearch((svc) =>
      svc.createArtifact({
        taskID,
        runID,
        kind: "runner_execution_log_json",
        uri: `file://${executionLogPath}`,
        metadata: {
          runnerID: input.job.runnerID,
          runnerKind,
          stage,
          ...(exitCode === undefined ? {} : { exitCode }),
          recordCount: executionLog.records.length,
        },
      }),
    )
    artifactRefs.push(stored.id)
  }
  for (const [index, artifact] of (execution.artifacts ?? []).entries()) {
    const stored = await runResearch((svc) =>
      svc.createArtifact({
        taskID,
        runID,
        kind: artifact.kind,
        uri: input.artifactURIs[index] ?? artifact.uri,
        metadata: artifact.metadata,
      }),
    )
    artifactRefs.push(stored.id)
  }

  const status =
    input.result.status === "completed"
      ? execution.status === "rejected"
        ? "rejected"
        : "succeeded"
      : input.result.status === "dead_lettered"
        ? "failed"
        : "queued"
  const resultError =
    input.result.status === "retry_scheduled" || input.result.status === "dead_lettered"
      ? input.result.error
      : undefined

  await runResearch((svc) =>
    svc.updateRunStatus({
      runID,
      status,
      metrics: execution.metrics,
      resourceUsage: {
        ...run.resourceUsage,
        ...(execution.resourceUsage ?? {}),
      },
      artifactRefs,
      error: status === "failed" || status === "rejected" ? execution.error ?? resultError : undefined,
    }),
  )
}

type ResearchWorkerCommandArgs = FormatArg & {
  readonly runtimeRoot?: string
  readonly workerId?: string
  readonly now?: number
  readonly leaseMs?: number
  readonly syncResearchDb?: boolean
}

async function runResearchWorkerOnceCommand(args: ResearchWorkerCommandArgs) {
  const runtime = createFileResearchRuntime(path.resolve(args.runtimeRoot ?? ".neo-research/runtime"))
  let leasedJob: ResearchJob | undefined
  let syncedRun: Research.ResearchRun | undefined
  let execution: ResearchWorkerExecutionResult | undefined
  const result = await runResearchWorkerOnce({
    queue: runtime.queue,
    artifactStore: runtime.artifactStore,
    metricsStore: runtime.metricsStore,
    workerID: args.workerId ?? `research-worker-${process.pid}`,
    now: args.now ?? Date.now(),
    leaseMs: args.leaseMs,
    execute: async (job) => {
      leasedJob = job
      if (args.syncResearchDb !== false) syncedRun = await syncResearchWorkerRunStarted(job)
      execution = await executeSubprocessResearchJob(job)
      return execution
    },
  })
  if (args.syncResearchDb !== false && leasedJob !== undefined) {
    await syncResearchWorkerRunFinished({
      job: leasedJob,
      run: syncedRun,
      result,
      execution,
      artifactURIs: result.status === "completed" ? result.artifactURIs : [],
    })
  }
  return result
}

function outputFormat(yargs: Argv) {
  return yargs.option("format", {
    describe: "output format",
    type: "string",
    choices: ["table", "json"] as const,
    default: "table" as const,
  })
}

function runOptions(yargs: Argv) {
  return yargs
    .option("stage", {
      describe: "research run stage",
      type: "string",
      choices: ["baseline", "smoke", "low_fidelity", "full", "ref_test", "blind_test"] as const,
      default: "smoke" as const,
    })
    .option("description", {
      describe: "run description",
      type: "string",
    })
    .option("seed", {
      describe: "single run seed override",
      type: "number",
    })
}

function parseSeedList(value: string | undefined) {
  if (!value) return undefined
  const seeds = value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item >= 0)
    .map((item) => Math.floor(item))
  return seeds.length > 0 ? seeds : undefined
}

function parseStringList(value: string | undefined) {
  if (!value) return undefined
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return items.length > 0 ? items : undefined
}

function parsePositiveInt(value: number | undefined, label: string) {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`)
  return value
}

function parsePositiveIntList(value: string | undefined, label: string) {
  const items = parseStringList(value)
  if (!items) return undefined
  const parsed = items.map((item) => Number(item))
  for (const item of parsed) {
    if (!Number.isInteger(item) || item <= 0) throw new Error(`${label} must contain positive integers`)
  }
  return parsed
}

export const ResearchCommand = cmd({
  command: "research",
  describe: "manage research tasks and experiments",
  builder: (yargs: Argv) =>
    yargs
      .command(ResearchListCommand)
      .command(ResearchCreateCommand)
      .command(ResearchStatusCommand)
      .command(ResearchPrepareCommand)
      .command(ResearchRunCommand)
      .command(ResearchSeedSweepCommand)
      .command(ResearchWorkerOnceCommand)
      .command(ResearchWorkerLoopCommand)
      .command(ResearchIterateCommand)
      .command(ResearchLoopCommand)
      .command(ResearchPipelineCommand)
      .command(ResearchVibeCommand)
      .command(ResearchPrepareDatasetCommand)
      .command(ResearchProfileCommand)
      .command(ResearchExportCommand)
      .command(ResearchArtifactsCommand)
      .command(ResearchMemoryCommand)
      .command(ResearchSeedCommand)
      .command(ResearchApprovalsCommand)
      .command(ResearchRequestRefTestCommand)
      .command(ResearchRequestBlindTestCommand)
      .command(ResearchRequestShadowHoldoutCommand)
      .command(ResearchApproveCommand)
      .command(ResearchRejectCommand)
      .demandCommand(),
  async handler() {},
})

export const ResearchListCommand = cmd({
  command: "list",
  describe: "list research tasks",
  builder: (yargs: Argv) =>
    outputFormat(yargs)
      .option("limit", {
        alias: "n",
        describe: "limit to N most recent research tasks",
        type: "number",
        default: 20,
      })
      .option("domain", {
        describe: "filter by research domain",
        type: "string",
      })
      .option("status", {
        describe: "filter by task status",
        type: "string",
        choices: [
          "idle",
          "created",
          "intent_gathering",
          "profiling",
          "analyzing",
          "data_analysis",
          "baselining",
          "searching",
          "researching",
          "publishing",
          "paused",
          "completed",
          "failed",
        ] as const,
      }),
  handler: async (args: FormatArg & { limit?: number; domain?: string; status?: Research.ResearchTaskStatus }) => {
    const tasks = await runResearch((svc) =>
      svc.listTasks({
        limit: args.limit,
        domainID: args.domain,
        status: args.status,
      }),
    )
    print(tasks, args.format, () => formatResearchTasksTable(tasks))
  },
})

export const ResearchCreateCommand = cmd({
  command: "create",
  describe: "create a TSF research task",
  builder: (yargs: Argv) =>
    outputFormat(yargs)
      .option("mode", {
        describe: "research interaction mode",
        type: "string",
        choices: ["review", "autonomous"] as const,
        default: "review" as const,
      })
      .option("interaction-mode", {
        describe: "user-facing interaction mode",
        type: "string",
        choices: ["companion", "socratic"] as const,
      })
      .option("title", {
        describe: "task title",
        type: "string",
      })
      .option("neo-cast-root", {
        describe: "Neo-Cast project root used by runner execution",
        type: "string",
      })
      .option("dataset-path", {
        describe: "CSV dataset path to store in the TSF task spec",
        type: "string",
      })
      .option("dataset-preset", {
        describe: "TSF dataset preset/loader id",
        type: "string",
        default: "etth1_tslib_v1",
      })
      .option("target-cols", {
        describe: "comma-separated target columns",
        type: "string",
        default: "OT",
      })
      .option("context-length", {
        describe: "TSF lookback context length",
        type: "number",
        default: 96,
      })
      .option("prediction-lengths", {
        describe: "comma-separated prediction horizons",
        type: "string",
        default: "24",
      })
      .option("full-recipe-space", {
        describe: "disable bridge-only mode and allow phase-two/full recipe candidates",
        type: "boolean",
        default: false,
      }),
  handler: async (
    args: FormatArg & {
      mode: Research.ResearchMode
      interactionMode?: ResearchInteractionMode
      title?: string
      neoCastRoot?: string
      datasetPath?: string
      datasetPreset?: string
      targetCols?: string
      contextLength?: number
      predictionLengths?: string
      fullRecipeSpace?: boolean
    },
  ) => {
    const input = buildDefaultTsfResearchTaskInput({
      mode: args.interactionMode ? researchModeForInteractionMode(args.interactionMode) : args.mode,
      interactionMode: args.interactionMode,
      title: args.title,
      neoCastProjectRoot: args.neoCastRoot,
      datasetPath: args.datasetPath,
      datasetPreset: args.datasetPreset,
      targetCols: parseStringList(args.targetCols),
      contextLength: parsePositiveInt(args.contextLength, "--context-length"),
      predictionLengths: parsePositiveIntList(args.predictionLengths, "--prediction-lengths"),
      bridgeOnly: args.fullRecipeSpace ? false : true,
    })
    const task = await runResearch((svc) => svc.createTask(input))
    print(task, args.format, () => formatResearchTasksTable([task]))
  },
})

export const ResearchStatusCommand = cmd({
  command: "status <taskID>",
  describe: "show research task status",
  builder: (yargs: Argv) =>
    outputFormat(
      yargs.positional("taskID", {
        describe: "research task ID",
        type: "string",
        demandOption: true,
      }),
    ),
  handler: async (args: FormatArg & { taskID?: string }) => {
    if (!args.taskID) return
    const taskID = Research.ResearchTaskID.make(args.taskID)
    const result = await runResearch((svc) =>
      Effect.all({
        task: svc.getTask(taskID),
        candidates: svc.listCandidates(taskID),
        runs: svc.listRuns(taskID),
        approvals: svc.listApprovals({ taskID }),
        artifacts: svc.listArtifacts(taskID),
        memory: svc.listMemory(taskID),
        champion: svc.getChampion(taskID),
      }),
    )
    print(result, args.format, () => formatResearchStatus(result))
  },
})

export const ResearchPrepareCommand = cmd({
  command: "prepare <taskID> <candidateID>",
  describe: "prepare a research candidate run without executing it",
  builder: (yargs: Argv) =>
    outputFormat(
      runOptions(
        yargs
          .positional("taskID", {
            describe: "research task ID",
            type: "string",
            demandOption: true,
          })
          .positional("candidateID", {
            describe: "research candidate ID",
            type: "string",
            demandOption: true,
          }),
      ),
    ),
  handler: async (
    args: FormatArg & {
      taskID?: string
      candidateID?: string
      stage?: Research.ExecutableRunStage
      description?: string
      seed?: number
    },
  ) => {
    if (!args.taskID || !args.candidateID) return
    const taskID = Research.ResearchTaskID.make(args.taskID)
    const candidateID = Research.ResearchCandidateID.make(args.candidateID)
    const prepared = await runResearch((svc) =>
      svc.prepareRun({
        taskID,
        candidateID,
        stage: args.stage,
        description: args.description,
        seed: args.seed,
      }),
    )
    print(prepared, args.format, () => formatResearchRunResult(prepared))
  },
})

export const ResearchRunCommand = cmd({
  command: "run <taskID> <candidateID>",
  describe: "execute a research candidate run",
  builder: (yargs: Argv) =>
    outputFormat(
      runOptions(
        yargs
          .positional("taskID", {
            describe: "research task ID",
            type: "string",
            demandOption: true,
          })
          .positional("candidateID", {
            describe: "research candidate ID",
            type: "string",
            demandOption: true,
          }),
      ),
    ),
  handler: async (
    args: FormatArg & {
      taskID?: string
      candidateID?: string
      stage?: Research.ExecutableRunStage
      description?: string
      seed?: number
    },
  ) => {
    if (!args.taskID || !args.candidateID) return
    const taskID = Research.ResearchTaskID.make(args.taskID)
    const candidateID = Research.ResearchCandidateID.make(args.candidateID)
    const executed = await runResearch((svc) =>
      svc.executeRun({
        taskID,
        candidateID,
        stage: args.stage,
        description: args.description,
        seed: args.seed,
      }),
    )
    print(executed, args.format, () => formatResearchRunResult(executed))
  },
})

export const ResearchSeedSweepCommand = cmd({
  command: "seed-sweep <taskID> <candidateID>",
  describe: "execute a research candidate seed sweep",
  builder: (yargs: Argv) =>
    outputFormat(
      runOptions(
        yargs
          .positional("taskID", {
            describe: "research task ID",
            type: "string",
            demandOption: true,
          })
          .positional("candidateID", {
            describe: "research candidate ID",
            type: "string",
            demandOption: true,
          })
          .option("seeds", {
            describe: "comma-separated seed list; defaults to task evaluation seeds",
            type: "string",
          }),
      ),
    ),
  handler: async (
    args: FormatArg & {
      taskID?: string
      candidateID?: string
      stage?: Research.ExecutableRunStage
      description?: string
      seeds?: string
    },
  ) => {
    if (!args.taskID || !args.candidateID) return
    const taskID = Research.ResearchTaskID.make(args.taskID)
    const candidateID = Research.ResearchCandidateID.make(args.candidateID)
    const sweep = await runResearch((svc) =>
      svc.executeSeedSweep({
        taskID,
        candidateID,
        stage: args.stage,
        description: args.description,
        seeds: parseSeedList(args.seeds),
      }),
    )
    print(sweep, args.format, () => formatResearchSeedSweep(sweep))
  },
})

export const ResearchWorkerOnceCommand = cmd({
  command: "worker-once",
  describe: "run one queued research worker job from the local file runtime",
  builder: (yargs: Argv) =>
    outputFormat(
      yargs
        .option("runtime-root", {
          describe: "local research file-runtime root",
          type: "string",
          default: ".neo-research/runtime",
        })
        .option("worker-id", {
          describe: "worker identity used for queue leases and heartbeats",
          type: "string",
          default: `research-worker-${process.pid}`,
        })
        .option("now", {
          describe: "worker clock override in epoch milliseconds",
          type: "number",
        })
        .option("lease-ms", {
          describe: "queue lease duration in milliseconds",
          type: "number",
          default: 30_000,
        })
        .option("sync-research-db", {
          describe: "sync worker outcomes into the local Research task database when matching run rows exist",
          type: "boolean",
          default: true,
        }),
    ),
  handler: async (
    args: ResearchWorkerCommandArgs,
  ) => {
    const result = await runResearchWorkerOnceCommand(args)
    print(result, args.format, () => formatResearchWorkerOnce(result))
  },
})

export const ResearchWorkerLoopCommand = cmd({
  command: "worker-loop",
  describe: "run a bounded local research worker loop",
  builder: (yargs: Argv) =>
    outputFormat(
      yargs
        .option("runtime-root", {
          describe: "local research file-runtime root",
          type: "string",
          default: ".neo-research/runtime",
        })
        .option("worker-id", {
          describe: "worker identity used for queue leases and heartbeats",
          type: "string",
          default: `research-worker-${process.pid}`,
        })
        .option("max-jobs", {
          describe: "maximum jobs to run before exiting",
          type: "number",
          default: 10,
        })
        .option("now", {
          describe: "worker clock override in epoch milliseconds",
          type: "number",
        })
        .option("lease-ms", {
          describe: "queue lease duration in milliseconds",
          type: "number",
          default: 30_000,
        })
        .option("sync-research-db", {
          describe: "sync worker outcomes into the local Research task database when matching run rows exist",
          type: "boolean",
          default: true,
        }),
    ),
  handler: async (
    args: ResearchWorkerCommandArgs & {
      maxJobs?: number
    },
  ) => {
    const workerID = args.workerId ?? `research-worker-${process.pid}`
    const maxJobs = Math.max(1, Math.floor(args.maxJobs ?? 10))
    const baseNow = args.now ?? Date.now()
    const results: ResearchWorkerOnceResult[] = []

    for (let index = 0; index < maxJobs; index++) {
      const result = await runResearchWorkerOnceCommand({
        ...args,
        workerId: workerID,
        now: baseNow + index,
      })
      if (result.status === "idle") {
        const summary = {
          status: results.length === 0 ? "idle" : "drained",
          workerID,
          iterations: results.length,
          completed: results.filter((item) => item.status === "completed").length,
          retryScheduled: results.filter((item) => item.status === "retry_scheduled").length,
          deadLettered: results.filter((item) => item.status === "dead_lettered").length,
          results,
        }
        print(summary, args.format, () => formatResearchWorkerLoop(summary))
        return
      }
      results.push(result)
    }

    const summary = {
      status: "max_jobs",
      workerID,
      iterations: results.length,
      completed: results.filter((item) => item.status === "completed").length,
      retryScheduled: results.filter((item) => item.status === "retry_scheduled").length,
      deadLettered: results.filter((item) => item.status === "dead_lettered").length,
      results,
    }
    print(summary, args.format, () => formatResearchWorkerLoop(summary))
  },
})

export const ResearchIterateCommand = cmd({
  command: "iterate <taskID>",
  describe: "run one autonomous research iteration",
  builder: (yargs: Argv) =>
    outputFormat(
      runOptions(
        yargs.positional("taskID", {
          describe: "research task ID",
          type: "string",
          demandOption: true,
        }),
      ).option("force-explore", {
        describe: "force this iteration to create an exploratory candidate",
        type: "boolean",
      }),
    ),
  handler: async (
    args: FormatArg & {
      taskID?: string
      stage?: Research.ExecutableRunStage
      description?: string
      forceExplore?: boolean
    },
  ) => {
    if (!args.taskID) return
    const taskID = Research.ResearchTaskID.make(args.taskID)
    const iteration = await runResearch((svc) =>
      svc.runAutonomousIteration({
        taskID,
        stage: args.stage,
        description: args.description,
        forceExplore: args.forceExplore,
      }),
    )
    print(iteration, args.format, () => formatResearchAutonomousIteration(iteration))
  },
})

export const ResearchLoopCommand = cmd({
  command: "loop <taskID>",
  describe: "run multiple autonomous research iterations",
  builder: (yargs: Argv) =>
    outputFormat(
      runOptions(
        yargs
          .positional("taskID", {
            describe: "research task ID",
            type: "string",
            demandOption: true,
          })
          .option("max-iterations", {
            describe: "maximum autonomous iterations to run",
            type: "number",
            default: 50,
          })
          .option("exploration", {
            describe: "forced exploration rate from 0 to 1",
            type: "number",
          }),
      ),
    ),
  handler: async (
    args: FormatArg & {
      taskID?: string
      stage?: Research.ExecutableRunStage
      description?: string
      maxIterations?: number
      exploration?: number
    },
  ) => {
    if (!args.taskID) return
    const taskID = Research.ResearchTaskID.make(args.taskID)
    const loop = await runResearch((svc) =>
      svc.runAutonomousLoop({
        taskID,
        stage: args.stage,
        description: args.description,
        maxIterations: args.maxIterations,
        explorationRate: args.exploration,
      }),
    )
    print(loop, args.format, () => formatResearchAutonomousLoop(loop))
  },
})

export const ResearchPrepareDatasetCommand = cmd({
  command: "prepare-dataset <taskID>",
  describe: "prepare a task dataset in the configured Neo-Cast runner",
  builder: (yargs: Argv) =>
    outputFormat(
      yargs
        .positional("taskID", {
          describe: "research task ID",
          type: "string",
          demandOption: true,
        })
        .option("output-dir", {
          describe: "directory for dataset preparation artifacts",
          type: "string",
        })
        .option("force", {
          describe: "overwrite prepared Neo-Cast dataset files",
          type: "boolean",
          default: true,
        }),
    ),
  handler: async (args: FormatArg & { taskID?: string; outputDir?: string; force?: boolean }) => {
    if (!args.taskID) return
    const taskID = Research.ResearchTaskID.make(args.taskID)
    const prepared = await runResearch((svc) =>
      svc.prepareTaskDataset({
        taskID,
        outputDir: args.outputDir,
        force: args.force,
      }),
    )
    print(prepared, args.format, () => formatResearchExport(prepared))
  },
})

export const ResearchPipelineCommand = cmd({
  command: "pipeline <taskID>",
  describe: "run the multi-agent NeoResearch pipeline for a task",
  builder: (yargs: Argv) =>
    outputFormat(
      yargs
        .positional("taskID", {
          describe: "research task ID",
          type: "string",
          demandOption: true,
        })
        .option("max-iterations", {
          describe: "maximum autonomous iterations to run",
          type: "number",
          default: 50,
        })
        .option("exploration", {
          describe: "forced exploration rate from 0 to 1",
          type: "number",
        })
        .option("stage", {
          describe: "execution stage for model search",
          choices: ["baseline", "smoke", "low_fidelity", "full", "ref_test", "blind_test"] as const,
          default: "smoke" as const,
        })
        .option("description", {
          describe: "pipeline run description",
          type: "string",
        })
        .option("output-dir", {
          describe: "directory for pipeline artifacts",
          type: "string",
          default: ".neo-research/pipeline",
        }),
    ),
  handler: async (
    args: FormatArg & {
      taskID?: string
      maxIterations?: number
      stage?: Research.ExecutableRunStage
      description?: string
      outputDir?: string
      exploration?: number
    },
  ) => {
    if (!args.taskID) return
    const taskID = Research.ResearchTaskID.make(args.taskID)
    const result = await runResearch((svc) =>
      svc.runFullPipeline({
        taskID,
        stage: args.stage,
        description: args.description,
        maxIterations: args.maxIterations,
        explorationRate: args.exploration,
        outputDir: args.outputDir,
      }),
    )
    print(result, args.format, () => formatResearchExport(result.publish))
  },
})

export const ResearchVibeCommand = cmd({
  command: "vibe <goal..>",
  describe: "run the Vibe Data Science TSF pipeline from a research goal",
  builder: (yargs: Argv) =>
    outputFormat(
      yargs
        .positional("goal", {
          describe: "forecasting goal, optionally including /path/to/data.csv and target/horizon/context options",
          type: "string",
          array: true,
          demandOption: true,
        })
        .option("max-iterations", {
          describe: "maximum autonomous iterations to run",
          type: "number",
          default: 50,
        })
        .option("exploration", {
          describe: "forced exploration rate from 0 to 1",
          type: "number",
        })
        .option("runner-root", {
          describe: "Neo-Cast runner root",
          type: "string",
        })
        .option("interaction-mode", {
          describe: "user-facing interaction mode",
          type: "string",
          choices: ["companion", "socratic"] as const,
          default: "socratic" as const,
        }),
    ),
  handler: async (
    args: FormatArg & {
      goal?: string[]
      maxIterations?: number
      exploration?: number
      runnerRoot?: string
      interactionMode?: ResearchInteractionMode
    },
  ) => {
    const goal = args.goal?.join(" ").trim()
    if (!goal) return
    const output = await runResearch((svc) =>
      Effect.gen(function* () {
        const task = yield* svc.createTask(
          buildDefaultTsfResearchTaskInputFromGoal({
            goal,
            mode: researchModeForInteractionMode(args.interactionMode ?? "socratic"),
            interactionMode: args.interactionMode ?? "socratic",
            neoCastProjectRoot: args.runnerRoot ?? process.cwd(),
          }),
        )
        const pipeline = yield* svc.runFullPipeline({
          taskID: task.id,
          stage: "smoke",
          description: goal,
          maxIterations: args.maxIterations,
          explorationRate: args.exploration,
          outputDir: ".neo-research/final",
        })
        return pipeline.publish
      }),
    )
    print(output, args.format, () => formatResearchExport(output))
  },
})

export const ResearchExportCommand = cmd({
  command: "export <taskID>",
  describe: "export a research task artifact",
  builder: (yargs: Argv) =>
    outputFormat(
      yargs
        .positional("taskID", {
          describe: "research task ID",
          type: "string",
          demandOption: true,
        })
        .option("output-dir", {
          describe: "directory for exported research artifacts",
          type: "string",
        })
        .option("kind", {
          describe: "artifact kind to export",
          choices: [
            "research_report_markdown",
            "dataset_analysis_report",
            "research_final_bundle",
            "model_export_package",
          ] as const,
          default: "research_report_markdown",
        }),
    ),
  handler: async (
    args: FormatArg & {
      taskID?: string
      outputDir?: string
      kind?: Research.ExportArtifactKind
    },
  ) => {
    if (!args.taskID) return
    const taskID = Research.ResearchTaskID.make(args.taskID)
    const exported = await runResearch((svc) =>
      svc.exportTaskArtifact({
        taskID,
        outputDir: args.outputDir,
        kind: args.kind,
      }),
    )
    print(exported, args.format, () => formatResearchExport(exported))
  },
})

export const ResearchProfileCommand = cmd({
  command: "profile <taskID>",
  describe: "profile a research task and persist a diagnostic artifact",
  builder: (yargs: Argv) =>
    outputFormat(
      yargs
        .positional("taskID", {
          describe: "research task ID",
          type: "string",
          demandOption: true,
        })
        .option("output-dir", {
          describe: "directory for task profile artifacts",
          type: "string",
        }),
    ),
  handler: async (args: FormatArg & { taskID?: string; outputDir?: string }) => {
    if (!args.taskID) return
    const taskID = Research.ResearchTaskID.make(args.taskID)
    const profile = await runResearch((svc) =>
      svc.profileTask({
        taskID,
        outputDir: args.outputDir,
      }),
    )
    print(profile, args.format, () => formatResearchProfile(profile))
  },
})

export const ResearchArtifactsCommand = cmd({
  command: "artifacts <taskID>",
  describe: "list research artifacts for a task",
  builder: (yargs: Argv) =>
    outputFormat(
      yargs.positional("taskID", {
        describe: "research task ID",
        type: "string",
        demandOption: true,
      }),
    ),
  handler: async (args: FormatArg & { taskID?: string }) => {
    if (!args.taskID) return
    const taskID = Research.ResearchTaskID.make(args.taskID)
    const artifacts = await runResearch((svc) => svc.listArtifacts(taskID))
    print(artifacts, args.format, () => formatResearchArtifactsTable(artifacts))
  },
})

export const ResearchMemoryCommand = cmd({
  command: "memory <taskID>",
  describe: "list research memory for a task",
  builder: (yargs: Argv) =>
    outputFormat(
      yargs.positional("taskID", {
        describe: "research task ID",
        type: "string",
        demandOption: true,
      }),
    ),
  handler: async (args: FormatArg & { taskID?: string }) => {
    if (!args.taskID) return
    const taskID = Research.ResearchTaskID.make(args.taskID)
    const memory = await runResearch((svc) => svc.listMemory(taskID))
    print(memory, args.format, () => formatResearchMemoryTable(memory))
  },
})

export const ResearchSeedCommand = cmd({
  command: "seed <taskID>",
  describe: "seed domain baseline candidates for a research task",
  builder: (yargs: Argv) =>
    outputFormat(
      yargs.positional("taskID", {
        describe: "research task ID",
        type: "string",
        demandOption: true,
      }),
    ),
  handler: async (args: FormatArg & { taskID?: string }) => {
    if (!args.taskID) return
    const taskID = Research.ResearchTaskID.make(args.taskID)
    const seeded = await runResearch((svc) => svc.seedBaselines({ taskID }))
    print(
      seeded,
      args.format,
      () => `Seeded ${seeded.candidates.length} candidates and ${seeded.approvals.length} approvals for ${taskID}`,
    )
  },
})

export const ResearchApprovalsCommand = cmd({
  command: "approvals <taskID>",
  describe: "list research approvals for a task",
  builder: (yargs: Argv) =>
    outputFormat(
      yargs
        .positional("taskID", {
          describe: "research task ID",
          type: "string",
          demandOption: true,
        })
        .option("status", {
          describe: "filter by approval status",
          type: "string",
          choices: ["pending", "approved", "rejected"] as const,
        })
        .option("limit", {
          alias: "n",
          describe: "limit to N approvals",
          type: "number",
        }),
    ),
  handler: async (args: FormatArg & { taskID?: string; status?: Research.ApprovalStatus; limit?: number }) => {
    if (!args.taskID) return
    const taskID = Research.ResearchTaskID.make(args.taskID)
    const approvals = await runResearch((svc) =>
      svc.listApprovals({
        taskID,
        status: args.status,
        limit: args.limit,
      }),
    )
    print(approvals, args.format, () => formatResearchApprovalsTable(approvals))
  },
})

export const ResearchRequestRefTestCommand = cmd({
  command: "request-ref-test <taskID> <candidateID>",
  describe: "request reference-test approval for a research candidate",
  builder: (yargs: Argv) =>
    outputFormat(
      yargs
        .positional("taskID", {
          describe: "research task ID",
          type: "string",
          demandOption: true,
        })
        .positional("candidateID", {
          describe: "research candidate ID",
          type: "string",
          demandOption: true,
        })
        .option("reason", {
          describe: "approval request reason",
          type: "string",
        }),
    ),
  handler: async (args: FormatArg & { taskID?: string; candidateID?: string; reason?: string }) => {
    if (!args.taskID || !args.candidateID) return
    const taskID = Research.ResearchTaskID.make(args.taskID)
    const candidateID = Research.ResearchCandidateID.make(args.candidateID)
    const approval = await runResearch((svc) =>
      svc.createApproval({
        taskID,
        candidateID,
        kind: "ref_test",
        reason: args.reason ?? `Approve reference-test access for ${candidateID}.`,
      }),
    )
    print(approval, args.format, () => formatResearchApprovalsTable([approval]))
  },
})

export const ResearchRequestBlindTestCommand = cmd({
  command: "request-blind-test <taskID> <candidateID>",
  describe: "request blind-test sidecar approval for a research candidate",
  builder: (yargs: Argv) =>
    outputFormat(
      yargs
        .positional("taskID", {
          describe: "research task ID",
          type: "string",
          demandOption: true,
        })
        .positional("candidateID", {
          describe: "research candidate ID",
          type: "string",
          demandOption: true,
        })
        .option("reason", {
          describe: "approval request reason",
          type: "string",
        }),
    ),
  handler: async (args: FormatArg & { taskID?: string; candidateID?: string; reason?: string }) => {
    if (!args.taskID || !args.candidateID) return
    const taskID = Research.ResearchTaskID.make(args.taskID)
    const candidateID = Research.ResearchCandidateID.make(args.candidateID)
    const approval = await runResearch((svc) =>
      svc.createApproval({
        taskID,
        candidateID,
        kind: "blind_test",
        reason: args.reason ?? `Approve blind-test sidecar access for ${candidateID}.`,
      }),
    )
    print(approval, args.format, () => formatResearchApprovalsTable([approval]))
  },
})

export const ResearchRequestShadowHoldoutCommand = cmd({
  command: "request-shadow-holdout <taskID> <candidateID>",
  describe: "request shadow holdout approval for a research candidate",
  builder: (yargs: Argv) =>
    outputFormat(
      yargs
        .positional("taskID", {
          describe: "research task ID",
          type: "string",
          demandOption: true,
        })
        .positional("candidateID", {
          describe: "research candidate ID",
          type: "string",
          demandOption: true,
        })
        .option("reason", {
          describe: "approval request reason",
          type: "string",
        }),
    ),
  handler: async (args: FormatArg & { taskID?: string; candidateID?: string; reason?: string }) => {
    if (!args.taskID || !args.candidateID) return
    const taskID = Research.ResearchTaskID.make(args.taskID)
    const candidateID = Research.ResearchCandidateID.make(args.candidateID)
    const approval = await runResearch((svc) =>
      svc.createApproval({
        taskID,
        candidateID,
        kind: "shadow_holdout",
        reason: args.reason ?? `Approve blind/shadow holdout access for ${candidateID}.`,
      }),
    )
    print(approval, args.format, () => formatResearchApprovalsTable([approval]))
  },
})

export const ResearchApproveCommand = cmd({
  command: "approve <approvalID>",
  describe: "approve a research approval request",
  builder: (yargs: Argv) =>
    outputFormat(
      yargs
        .positional("approvalID", {
          describe: "research approval ID",
          type: "string",
          demandOption: true,
        })
        .option("message", {
          describe: "approval reply message",
          type: "string",
        }),
    ),
  handler: async (args: FormatArg & { approvalID?: string; message?: string }) => {
    if (!args.approvalID) return
    const approvalID = Research.ResearchApprovalID.make(args.approvalID)
    const approval = await runResearch((svc) =>
      svc.replyApproval({
        approvalID,
        status: "approved",
        replyMessage: args.message,
      }),
    )
    print(approval, args.format, () => formatResearchApprovalsTable([approval]))
  },
})

export const ResearchRejectCommand = cmd({
  command: "reject <approvalID>",
  describe: "reject a research approval request",
  builder: (yargs: Argv) =>
    outputFormat(
      yargs
        .positional("approvalID", {
          describe: "research approval ID",
          type: "string",
          demandOption: true,
        })
        .option("message", {
          describe: "rejection reply message",
          type: "string",
        }),
    ),
  handler: async (args: FormatArg & { approvalID?: string; message?: string }) => {
    if (!args.approvalID) return
    const approvalID = Research.ResearchApprovalID.make(args.approvalID)
    const approval = await runResearch((svc) =>
      svc.replyApproval({
        approvalID,
        status: "rejected",
        replyMessage: args.message,
      }),
    )
    print(approval, args.format, () => formatResearchApprovalsTable([approval]))
  },
})
