import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, mkdtemp, readFile, writeFile } from "fs/promises"
import { tmpdir as osTmpdir } from "os"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Research } from "../../src/research"
import { createFileResearchRuntime } from "../../src/research/runtime"
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

async function writeProfileDataset() {
  const root = await mkdtemp(path.join(osTmpdir(), "opencode-research-profile-"))
  const csvPath = path.join(root, "train.csv")
  const lines = ["date,a,b,c"]
  for (let index = 0; index < 96; index++) {
    const seasonal = index % 24
    const trend = index * 0.5
    const a = trend + seasonal
    const b = trend + seasonal * 2
    const c = index < 48 ? a : a + 30
    lines.push(`2024-01-${String((index % 28) + 1).padStart(2, "0")},${a},${index === 10 ? "" : b},${c}`)
  }
  await writeFile(csvPath, `${lines.join("\n")}\n`, "utf8")
  return csvPath
}

function validTsfCandidateSpec() {
  return Research.DomainRegistry.buildBaselines("tsf", validTsfTaskSpec())[0]!.candidateSpec
}

function phaseTwoTsfCandidateSpec() {
  const taskSpec = validTsfTaskSpec({ bridgeOnly: false })
  const proposal = Research.DomainRegistry.proposeCandidate("tsf", {
    taskSpec,
    taskFingerprint: {
      ...Research.DomainRegistry.summarizeTask("tsf", taskSpec),
      searchBiases: ["multivariate", "full_recipe_space", "seasonal", "missing_values", "distribution_shift"],
      datasetProfile: {
        source: "dataset.path",
        path: "/tmp/train.csv",
        rowCount: 512,
        targetCount: 1,
        numericColumnCount: 1,
        missingRate: 0.01,
        trendStrength: 0.25,
        seasonalityStrength: 0.8,
        crossVarCorrelation: 0,
        distributionShift: 0.6,
      },
    },
    candidates: [],
    runs: [],
    memory: [],
  })
  if (!proposal) throw new Error("expected TSF phase-two proposal")
  return proposal.candidateSpec
}

function benchmarkInvertTsfCandidateSpec() {
  return {
    recipeVersion: "recipe_schema_v1",
    recipeID: "benchmark_accepted_invert_rnn",
    hypothesis: "Prior inverted RNN trial improved a related benchmark task.",
    preprocessing: { actions: [{ type: "none" }] },
    embedding: { type: "invert", dModel: 64 },
    backbone: { type: "rnn", cell: "gru", hiddenDim: 96, numLayers: 2, dropout: 0.1 },
    fusion: { type: "feature", variateToken: true, crossAttention: true },
    predictionHead: { type: "direct_multi_horizon", outputDistribution: "point", horizonSpecific: true },
    trainingStrategy: {
      loss: { base: "huber", horizonWeighting: "tail_heavy", delta: 1 },
      optimizer: { type: "adamw", lr: 0.0005, weightDecay: 0.01 },
      scheduler: { type: "one_cycle", warmupSteps: 10 },
      regularization: { dropout: 0.1, gradClip: 1 },
      budget: { maxEpochs: 5, timeBudgetS: 120, batchSize: 16, patience: 2, seed: 7 },
    },
  } as unknown as Research.JsonRecord
}

function createTask(title = "ETTh1 horizon 96") {
  return runResearch(
    Research.Service.use((svc) =>
      svc.createTask({
        title,
        domainID: "tsf",
        mode: "review",
        taskSpec: validTsfTaskSpec(),
        objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
        budget: { maxRuns: 12 },
      }),
    ),
  )
}

function createTSFTask(
  title = "ETTh1 TSF review",
  runtime: Research.JsonRecord = {},
  mode: Research.ResearchMode = "review",
) {
  return runResearch(
    Research.Service.use((svc) =>
      svc.createTask({
        title,
        domainID: "tsf",
        mode,
        taskSpec: validTsfTaskSpec(runtime),
        objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
        budget: { maxRuns: 12 },
      }),
    ),
  )
}

async function writeFakeNeoCastRunner(root: string) {
  await mkdir(path.join(root, "py"), { recursive: true })
  await writeFile(
    path.join(root, "py", "validate.py"),
    `#!/usr/bin/env bash
set -euo pipefail
mkdir -p .neo-cast/artifacts/run_fake
cat > .neo-cast/artifacts/run_fake/val_metrics.json <<'JSON'
{"val_avg_mse":0.123,"val_avg_mae":0.456}
JSON
printf '{"event":"candidate_resolved"}\\n'
printf '{"event":"smoke_eval_done","val_avg_mse":0.123,"val_avg_mae":0.456}\\n'
printf '{"event":"artifact_ready","run_id":"fake","artifact_dir":"%s"}\\n' "$(pwd)/.neo-cast/artifacts/run_fake"
printf '{"event":"done","status":"success"}\\n'
`,
    "utf8",
  )
}

async function writeFailingNeoCastRunner(root: string) {
  await mkdir(path.join(root, "py"), { recursive: true })
  await writeFile(
    path.join(root, "py", "validate.py"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '{"event":"candidate_resolved"}\\n'
printf '{"event":"runner_error","error_kind":"runner_exit"}\\n'
printf 'runner failed before artifact creation\\n' >&2
exit 7
`,
    "utf8",
  )
}

async function writeSeedAwareFakeNeoCastRunner(root: string) {
  await mkdir(path.join(root, "py"), { recursive: true })
  await writeFile(
    path.join(root, "py", "validate.py"),
    `#!/usr/bin/env bash
set -euo pipefail
seed="$(grep -m1 '"seed"' .neo-cast/current_candidate.json | sed 's/[^0-9]//g')"
mkdir -p .neo-cast/artifacts/run_seed_\${seed}
printf '%s\\n' "$seed" >> .neo-cast/seed-log.txt
mse="$(awk "BEGIN { printf \\"%.3f\\", 0.2 + \${seed} / 1000 }")"
cat > .neo-cast/artifacts/run_seed_\${seed}/val_metrics.json <<JSON
{"val_avg_mse":\${mse},"val_avg_mae":0.456}
JSON
printf '{"event":"candidate_resolved","seed":%s}\\n' "$seed"
printf '{"event":"smoke_eval_done","val_avg_mse":%s,"val_avg_mae":0.456,"seed":%s}\\n' "$mse" "$seed"
printf '{"event":"artifact_ready","run_id":"seed_%s","artifact_dir":"%s"}\\n' "$seed" "$(pwd)/.neo-cast/artifacts/run_seed_\${seed}"
printf '{"event":"done","status":"success"}\\n'
`,
    "utf8",
  )
}

function createCandidate(input: {
  taskID: Research.ResearchTaskID
  parentCandidateID?: Research.ResearchCandidateID
  candidateSpec?: Research.JsonRecord
  rationale?: string
}) {
  return runResearch(
    Research.Service.use((svc) =>
      svc.createCandidate({
        taskID: input.taskID,
        parentCandidateID: input.parentCandidateID,
        domainID: "tsf",
        candidateSpec: input.candidateSpec ?? validTsfCandidateSpec(),
        rationale: input.rationale ?? "baseline modular candidate",
        riskLevel: "low",
        approvalStatus: "auto_approved",
        generatedBy: "heuristic",
      }),
    ),
  )
}

function createRun(input: {
  taskID: Research.ResearchTaskID
  candidateID: Research.ResearchCandidateID
  status?: Research.ResearchRunStatus
  stage?: Research.ResearchRunStage
  metrics?: Research.JsonRecord
  resourceUsage?: Research.JsonRecord
}) {
  return runResearch(
    Research.Service.use((svc) =>
      svc.createRun({
        taskID: input.taskID,
        candidateID: input.candidateID,
        stage: input.stage ?? "smoke",
        status: input.status,
        metrics: input.metrics,
        resourceUsage: input.resourceUsage,
      }),
    ),
  )
}

afterEach(async () => {
  await resetDatabase()
})

describe("Research service", () => {
  test("manages research tasks, candidates, runs, artifacts, champions, and memory", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "ETTh1 horizon 96",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12 },
            }),
          ),
        )
        expect(task.id).toStartWith("rtsk_")
        expect(task.status).toBe("created")

        const tasks = await runResearch(Research.Service.use((svc) => svc.listTasks({ domainID: "tsf" })))
        expect(tasks.map((item) => item.id)).toContain(task.id)

        const updated = await runResearch(
          Research.Service.use((svc) => svc.updateTaskStatus({ taskID: task.id, status: "researching" })),
        )
        expect(updated.status).toBe("researching")

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
        expect(candidate.id).toStartWith("rcnd_")

        const run = await runResearch(
          Research.Service.use((svc) =>
            svc.createRun({
              taskID: task.id,
              candidateID: candidate.id,
              stage: "smoke",
              status: "running",
            }),
          ),
        )
        expect(run.status).toBe("running")

        const completed = await runResearch(
          Research.Service.use((svc) =>
            svc.updateRunStatus({
              runID: run.id,
              status: "succeeded",
              metrics: { mse: 0.42, mae: 0.31 },
              resourceUsage: { gpuHours: 0.1 },
            }),
          ),
        )
        expect(completed.metrics.mse).toBe(0.42)

        const artifact = await runResearch(
          Research.Service.use((svc) =>
            svc.createArtifact({
              taskID: task.id,
              runID: run.id,
              kind: "metrics",
              uri: "file://metrics.json",
              metadata: { split: "test" },
            }),
          ),
        )
        expect(artifact.id).toStartWith("rart_")

        const champion = await runResearch(
          Research.Service.use((svc) =>
            svc.setChampion({
              taskID: task.id,
              candidateID: candidate.id,
              runID: run.id,
              primaryMetric: 0.42,
              utility: 0.7,
            }),
          ),
        )
        expect(champion.candidateID).toBe(candidate.id)

        const memory = await runResearch(
          Research.Service.use((svc) =>
            svc.createMemory({
              taskID: task.id,
              domainID: "tsf",
              fingerprintSummary: { dataset: "ETTh1", horizon: 96 },
              candidateSummary: { preprocessing: "RevIN", backbone: "TCN" },
              outcome: "accepted",
              lesson: "RevIN improves the ETTh1 smoke baseline.",
            }),
          ),
        )
        expect(memory.lesson).toContain("RevIN")
      },
    })
  })

  test("profiles a research task and persists a diagnostic artifact", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const datasetPath = await writeProfileDataset()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "Profile ETTh1-like task",
              domainID: "tsf",
              mode: "review",
              taskSpec: {
                ...validTsfTaskSpec(),
                dataset: {
                  loaderID: "local_csv",
                  path: datasetPath,
                  targetCols: ["a", "b", "c"],
                },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12 },
            }),
          ),
        )

        const result = await runResearch(
          Research.Service.use((svc) => svc.profileTask({ taskID: task.id, outputDir: ".neo-research/profile" })),
        )

        expect(result.fingerprint.datasetProfile).toMatchObject({
          rowCount: 96,
          targetCount: 3,
        })
        expect(result.artifact.kind).toBe("task_profile_json")
        expect(result.run.stage).toBe("profile")
        expect(result.run.status).toBe("succeeded")
        expect(result.run.candidateID).toBeUndefined()
        expect(result.artifact.runID).toBe(result.run.id)
        expect(result.run.artifactRefs).toContain(result.artifact.id)
        expect(result.path).toEndWith("task-profile.json")
        const persisted = JSON.parse(await readFile(result.path, "utf8"))
        expect(persisted.fingerprint.datasetProfile.crossVarCorrelation).toBeGreaterThan(0.8)
        const runs = await runResearch(Research.Service.use((svc) => svc.listRuns(task.id)))
        expect(runs.map((run) => run.id)).toContain(result.run.id)
      },
    })
  })

  test("profile runs do not consume candidate experiment budget", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "Profile then run one candidate",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 1 },
            }),
          ),
        )
        const candidate = await createCandidate({ taskID: task.id })

        await runResearch(Research.Service.use((svc) => svc.profileTask({ taskID: task.id })))
        const prepared = await runResearch(
          Research.Service.use((svc) =>
            svc.prepareRun({
              taskID: task.id,
              candidateID: candidate.id,
              stage: "smoke",
            }),
          ),
        )

        expect(prepared.run.stage).toBe("smoke")
        expect(prepared.run.candidateID).toBe(candidate.id)
      },
    })
  })

  test("prepareRun persists the runner plan as a durable artifact", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTSFTask("prepare durable runner plan")
        const candidate = await createCandidate({ taskID: task.id })

        const prepared = await runResearch(
          Research.Service.use((svc) =>
            svc.prepareRun({
              taskID: task.id,
              candidateID: candidate.id,
              stage: "smoke",
              description: "durable handoff",
            }),
          ),
        )

        expect(prepared.run.status).toBe("queued")
        expect(prepared.run.artifactRefs).toHaveLength(1)

        const artifacts = await runResearch(Research.Service.use((svc) => svc.listArtifacts(task.id)))
        const runPlanArtifact = artifacts.find((artifact) => artifact.kind === "runner_plan_json")
        expect(runPlanArtifact?.runID).toBe(prepared.run.id)
        expect(prepared.run.artifactRefs).toContain(runPlanArtifact!.id)
        expect(runPlanArtifact?.metadata).toMatchObject({
          runnerID: prepared.runPlan.runnerID,
          stage: "smoke",
          candidateID: candidate.id,
        })

        const persistedPlan = JSON.parse(await readFile(runPlanArtifact!.uri.replace("file://", ""), "utf8"))
        expect(persistedPlan.runID).toBe(prepared.run.id)
        expect(persistedPlan.runPlan.command.args).toEqual(prepared.runPlan.command.args)
      },
    })
  })

  test("prepareRun enqueues the prepared plan into the local file runtime", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTSFTask("prepare runtime queue")
        const candidate = await createCandidate({ taskID: task.id })

        const prepared = await runResearch(
          Research.Service.use((svc) =>
            svc.prepareRun({
              taskID: task.id,
              candidateID: candidate.id,
              stage: "smoke",
            }),
          ),
        )

        const runtime = createFileResearchRuntime(path.join(tmp.path, ".neo-research", "runtime"))
        const lease = await runtime.queue.lease({ workerID: "worker-a", now: Number.MAX_SAFE_INTEGER })

        expect(lease?.job).toMatchObject({
          taskID: task.id,
          runID: prepared.run.id,
          domainID: "tsf",
          runnerID: prepared.runPlan.runnerID,
          stage: "smoke",
          attempt: 1,
        })
        expect(lease?.job.payload).toMatchObject({
          runnerID: prepared.runPlan.runnerID,
          command: prepared.runPlan.command,
        })
      },
    })
  })

  test("executeRun reuses a queued prepared run instead of tripping the parallel budget", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeFakeNeoCastRunner(fakeNeoCastRoot)

        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "prepare then direct run",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec({
                bridgeOnly: true,
                neoCastProjectRoot: fakeNeoCastRoot,
                pythonExecutable: "bash",
              }),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12, maxParallel: 1 },
            }),
          ),
        )
        const candidate = await createCandidate({ taskID: task.id })

        const prepared = await runResearch(
          Research.Service.use((svc) =>
            svc.prepareRun({
              taskID: task.id,
              candidateID: candidate.id,
              stage: "smoke",
              description: "queued handoff",
            }),
          ),
        )

        const executed = await runResearch(
          Research.Service.use((svc) =>
            svc.executeRun({
              taskID: task.id,
              candidateID: candidate.id,
              stage: "smoke",
              description: "direct execution after prepare",
            }),
          ),
        )

        expect(executed.run.id).toBe(prepared.run.id)
        expect(executed.run.status).toBe("succeeded")
        expect(executed.run.metrics.val_avg_mse).toBe(0.123)

        const runs = await runResearch(Research.Service.use((svc) => svc.listRuns(task.id)))
        expect(runs).toHaveLength(1)
        const approvals = await runResearch(Research.Service.use((svc) => svc.listApprovals({ taskID: task.id })))
        expect(approvals.filter((approval) => approval.kind === "budget")).toHaveLength(0)

        const runtime = createFileResearchRuntime(path.join(tmp.path, ".neo-research", "runtime"))
        expect(
          await runtime.queue.lease({ workerID: "worker-after-direct-run", now: Number.MAX_SAFE_INTEGER }),
        ).toBeUndefined()
      },
    })
  })

  test("records reusable candidate recipes in run memory", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTSFTask("recipe memory task", { bridgeOnly: false })
        const candidate = await runResearch(
          Research.Service.use((svc) =>
            svc.createCandidate({
              taskID: task.id,
              domainID: "tsf",
              candidateSpec: benchmarkInvertTsfCandidateSpec(),
              rationale: "Reusable benchmark recipe",
              riskLevel: "medium",
              approvalStatus: "auto_approved",
              generatedBy: "mutation",
            }),
          ),
        )
        const run = await createRun({
          taskID: task.id,
          candidateID: candidate.id,
          status: "running",
        })

        await runResearch(
          Research.Service.use((svc) =>
            svc.updateRunStatus({
              runID: run.id,
              status: "succeeded",
              metrics: { val_avg_mse: 0.12 },
            }),
          ),
        )

        const memory = await runResearch(Research.Service.use((svc) => svc.listMemory(task.id)))
        expect(memory[0]?.candidateSummary).toMatchObject({
          candidateID: candidate.id,
          recipeID: "benchmark_accepted_invert_rnn",
          candidateSpec: {
            recipeID: "benchmark_accepted_invert_rnn",
            embedding: { type: "invert" },
            backbone: { type: "rnn" },
          },
        })
      },
    })
  })

  test("persists dataset profile warnings without failing profile runs", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const missingDatasetPath = path.join(tmp.path, "missing", "train.csv")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "Profile unavailable local dataset",
              domainID: "tsf",
              mode: "review",
              taskSpec: {
                ...validTsfTaskSpec(),
                dataset: {
                  loaderID: "local_csv",
                  path: missingDatasetPath,
                  targetCols: ["OT"],
                },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12 },
            }),
          ),
        )

        const result = await runResearch(Research.Service.use((svc) => svc.profileTask({ taskID: task.id })))

        expect(result.run.stage).toBe("profile")
        expect(result.run.status).toBe("succeeded")
        expect(result.fingerprint.datasetProfile).toBeUndefined()
        expect(result.fingerprint.datasetProfileWarning).toMatchObject({
          code: "dataset_read_failed",
          path: missingDatasetPath,
        })
        expect(result.artifact.metadata).toMatchObject({
          hasDatasetProfile: false,
          profileWarningCode: "dataset_read_failed",
        })

        const persisted = JSON.parse(await readFile(result.path, "utf8"))
        expect(persisted.fingerprint.datasetProfileWarning.code).toBe("dataset_read_failed")
      },
    })
  })

  test("creates a budget approval request when run budget is exhausted", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "budget gate task",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 0 },
            }),
          ),
        )
        const candidate = await createCandidate({ taskID: task.id })

        for (let attempt = 0; attempt < 2; attempt++) {
          await expect(
            runResearch(
              Research.Service.use((svc) =>
                svc.prepareRun({
                  taskID: task.id,
                  candidateID: candidate.id,
                  stage: "smoke",
                  description: `budget blocked ${attempt}`,
                }),
              ),
            ),
          ).rejects.toThrow("ResearchBudgetExceededError")
        }

        const approvals = await runResearch(Research.Service.use((svc) => svc.listApprovals({ taskID: task.id })))
        const budgetApprovals = approvals.filter((approval) => approval.kind === "budget")
        expect(budgetApprovals).toHaveLength(1)
        expect(budgetApprovals[0]).toMatchObject({
          taskID: task.id,
          candidateID: candidate.id,
          status: "pending",
          reason: "Run budget exhausted: used 0 of max 0. Increase budget or stop the task.",
        })
      },
    })
  })

  test("rejects missing or cross-task parent candidates", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTask("child task")
        const otherTask = await createTask("parent task")
        const otherParent = await createCandidate({ taskID: otherTask.id })

        await expect(
          createCandidate({ taskID: task.id, parentCandidateID: Research.ResearchCandidateID.ascending() }),
        ).rejects.toThrow("NotFoundError")
        await expect(createCandidate({ taskID: task.id, parentCandidateID: otherParent.id })).rejects.toThrow(
          "NotFoundError",
        )
      },
    })
  })

  test("rejects champion when run belongs to another candidate", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTask()
        const candidate = await createCandidate({ taskID: task.id })
        const otherCandidate = await createCandidate({ taskID: task.id })
        const run = await createRun({ taskID: task.id, candidateID: otherCandidate.id, status: "succeeded" })

        await expect(
          runResearch(
            Research.Service.use((svc) =>
              svc.setChampion({
                taskID: task.id,
                candidateID: candidate.id,
                runID: run.id,
                primaryMetric: 0.42,
                utility: 0.7,
              }),
            ),
          ),
        ).rejects.toThrow("NotFoundError")
      },
    })
  })

  test("creates approval requests and applies candidate approval replies", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTask("review mode approval")
        const candidate = await runResearch(
          Research.Service.use((svc) =>
            svc.createCandidate({
              taskID: task.id,
              domainID: "tsf",
              candidateSpec: validTsfCandidateSpec(),
              rationale: "Human should review this baseline before execution.",
              riskLevel: "low",
              approvalStatus: "pending",
              generatedBy: "heuristic",
            }),
          ),
        )

        const approval = await runResearch(
          Research.Service.use((svc) =>
            svc.createApproval({
              taskID: task.id,
              candidateID: candidate.id,
              kind: "candidate",
              reason: "Review Mode requires approval before running this candidate.",
            }),
          ),
        )
        expect(approval.status).toBe("pending")

        const pending = await runResearch(
          Research.Service.use((svc) => svc.listApprovals({ taskID: task.id, status: "pending" })),
        )
        expect(pending.map((item) => item.id)).toContain(approval.id)

        const pendingArtifacts = await runResearch(Research.Service.use((svc) => svc.listArtifacts(task.id)))
        const pendingGovernanceLog = pendingArtifacts.find(
          (artifact) =>
            artifact.kind === "governance_log_json" &&
            artifact.metadata.approvalID === approval.id &&
            artifact.metadata.status === "pending",
        )
        expect(pendingGovernanceLog?.metadata).toMatchObject({
          approvalID: approval.id,
          kind: "candidate",
          status: "pending",
          candidateID: candidate.id,
        })
        const pendingGovernanceRecord = JSON.parse(await readFile(pendingGovernanceLog!.uri.replace("file://", ""), "utf8"))
        expect(pendingGovernanceRecord.status).toBe("pending")

        const replied = await runResearch(
          Research.Service.use((svc) =>
            svc.replyApproval({
              approvalID: approval.id,
              status: "approved",
              replyMessage: "Approved for smoke run.",
            }),
          ),
        )
        expect(replied.status).toBe("approved")
        expect(replied.timeReplied).toBeNumber()

        const candidates = await runResearch(Research.Service.use((svc) => svc.listCandidates(task.id)))
        expect(candidates.find((item) => item.id === candidate.id)?.approvalStatus).toBe("approved")

        const artifacts = await runResearch(Research.Service.use((svc) => svc.listArtifacts(task.id)))
        expect(
          artifacts.filter(
            (artifact) => artifact.kind === "governance_log_json" && artifact.metadata.approvalID === approval.id,
          ),
        ).toHaveLength(2)
      },
    })
  })

  test("requires domain action approval before training phase-two TSF candidates", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTSFTask("governed phase-two task", { bridgeOnly: false })
        const candidate = await runResearch(
          Research.Service.use((svc) =>
            svc.createCandidate({
              taskID: task.id,
              domainID: "tsf",
              candidateSpec: phaseTwoTsfCandidateSpec(),
              rationale: "Profile-ranked phase-two recipe with native TimeRecipe actions.",
              riskLevel: "medium",
              approvalStatus: "auto_approved",
              generatedBy: "mutation",
            }),
          ),
        )

        await expect(
          runResearch(
            Research.Service.use((svc) =>
              svc.prepareRun({
                taskID: task.id,
                candidateID: candidate.id,
                stage: "low_fidelity",
                description: "blocked phase-two run",
              }),
            ),
          ),
        ).rejects.toThrow("ResearchApprovalRequiredError")

        const pendingDomainApprovals = await runResearch(
          Research.Service.use((svc) => svc.listApprovals({ taskID: task.id, status: "pending" })),
        )
        expect(pendingDomainApprovals.filter((approval) => approval.kind === "domain_action")).toHaveLength(1)
        expect(pendingDomainApprovals.find((approval) => approval.kind === "domain_action")).toMatchObject({
          candidateID: candidate.id,
          reason: "Approve native TimeRecipe actions before low_fidelity execution.",
        })

        const gate = await runResearch(
          Research.Service.use((svc) =>
            svc.createApproval({
              taskID: task.id,
              candidateID: candidate.id,
              kind: "domain_action",
              reason: "Approve native TimeRecipe phase-two actions before training.",
            }),
          ),
        )
        await runResearch(
          Research.Service.use((svc) =>
            svc.replyApproval({
              approvalID: gate.id,
              status: "approved",
              replyMessage: "Approved bounded low-fidelity exploration.",
            }),
          ),
        )

        const artifacts = await runResearch(Research.Service.use((svc) => svc.listArtifacts(task.id)))
        const governanceLog = artifacts.find(
          (artifact) => artifact.kind === "governance_log_json" && artifact.metadata.status === "approved",
        )
        expect(governanceLog?.metadata).toMatchObject({
          approvalID: gate.id,
          kind: "domain_action",
          status: "approved",
          candidateID: candidate.id,
        })
        const governancePath = governanceLog!.uri.replace("file://", "")
        const governanceRecord = JSON.parse(await readFile(governancePath, "utf8"))
        expect(governanceRecord.replyMessage).toBe("Approved bounded low-fidelity exploration.")

        const prepared = await runResearch(
          Research.Service.use((svc) =>
            svc.prepareRun({
              taskID: task.id,
              candidateID: candidate.id,
              stage: "low_fidelity",
              description: "approved phase-two run",
            }),
          ),
        )

        expect(prepared.run.status).toBe("queued")
        expect(prepared.runPlan.writes[0]!.content.embedding).toMatchObject({ type: "frequency" })
      },
    })
  })

  test("enforces optional stage promotion policy before higher-fidelity runs", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "strict promotion task",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12, governance: { requireStagePromotion: true } },
            }),
          ),
        )
        const candidate = await createCandidate({ taskID: task.id })

        await expect(
          runResearch(
            Research.Service.use((svc) =>
              svc.prepareRun({
                taskID: task.id,
                candidateID: candidate.id,
                stage: "low_fidelity",
                description: "blocked promotion",
              }),
            ),
          ),
        ).rejects.toThrow("ResearchApprovalRequiredError")

        const pendingProtocolApprovals = await runResearch(
          Research.Service.use((svc) => svc.listApprovals({ taskID: task.id, status: "pending" })),
        )
        expect(pendingProtocolApprovals.filter((approval) => approval.kind === "protocol")).toHaveLength(1)
        expect(pendingProtocolApprovals.find((approval) => approval.kind === "protocol")).toMatchObject({
          candidateID: candidate.id,
          reason: "Stage promotion blocked: low_fidelity requires a succeeded smoke run or protocol override.",
        })

        await runResearch(
          Research.Service.use((svc) =>
            svc.createRun({
              taskID: task.id,
              candidateID: candidate.id,
              stage: "smoke",
              status: "succeeded",
              metrics: { val_avg_mse: 0.2 },
            }),
          ),
        )

        const prepared = await runResearch(
          Research.Service.use((svc) =>
            svc.prepareRun({
              taskID: task.id,
              candidateID: candidate.id,
              stage: "low_fidelity",
              description: "promoted low-fidelity run",
            }),
          ),
        )

        expect(prepared.run.stage).toBe("low_fidelity")
        expect(prepared.run.status).toBe("queued")
      },
    })
  })

  test("enforces optional shadow holdout gate before reference tests", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "shadow holdout governed task",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12, governance: { requireShadowHoldout: true } },
            }),
          ),
        )
        const candidate = await createCandidate({ taskID: task.id })

        await expect(
          runResearch(
            Research.Service.use((svc) =>
              svc.prepareRun({
                taskID: task.id,
                candidateID: candidate.id,
                stage: "ref_test",
                description: "blocked shadow holdout",
              }),
            ),
          ),
        ).rejects.toThrow("ResearchApprovalRequiredError")

        let pendingApprovals = await runResearch(
          Research.Service.use((svc) => svc.listApprovals({ taskID: task.id, status: "pending" })),
        )
        expect(pendingApprovals).toHaveLength(1)
        expect(pendingApprovals[0]).toMatchObject({
          kind: "shadow_holdout",
          candidateID: candidate.id,
          reason: "Approve blind/shadow holdout before ref_test execution.",
        })

        await runResearch(
          Research.Service.use((svc) =>
            svc.replyApproval({
              approvalID: pendingApprovals[0]!.id,
              status: "approved",
              replyMessage: "Shadow holdout protocol accepted.",
            }),
          ),
        )

        await expect(
          runResearch(
            Research.Service.use((svc) =>
              svc.prepareRun({
                taskID: task.id,
                candidateID: candidate.id,
                stage: "ref_test",
                description: "blocked reference test",
              }),
            ),
          ),
        ).rejects.toThrow("ResearchApprovalRequiredError")

        pendingApprovals = await runResearch(
          Research.Service.use((svc) => svc.listApprovals({ taskID: task.id, status: "pending" })),
        )
        expect(pendingApprovals).toHaveLength(1)
        expect(pendingApprovals[0]).toMatchObject({
          kind: "ref_test",
          candidateID: candidate.id,
          reason: "Approve reference test before ref_test execution.",
        })

        await runResearch(
          Research.Service.use((svc) =>
            svc.replyApproval({
              approvalID: pendingApprovals[0]!.id,
              status: "approved",
              replyMessage: "Reference test accepted.",
            }),
          ),
        )

        const prepared = await runResearch(
          Research.Service.use((svc) =>
            svc.prepareRun({
              taskID: task.id,
              candidateID: candidate.id,
              stage: "ref_test",
              description: "approved governed ref test",
            }),
          ),
        )

        expect(prepared.run.stage).toBe("ref_test")
        expect(prepared.run.status).toBe("queued")
      },
    })
  })

  test("enforces reference test query limits as governance budget", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "ref test query limited task",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12, governance: { refTestQueryLimit: 1 } },
            }),
          ),
        )
        const candidate = await createCandidate({ taskID: task.id })
        const approval = await runResearch(
          Research.Service.use((svc) =>
            svc.createApproval({
              taskID: task.id,
              candidateID: candidate.id,
              kind: "ref_test",
              reason: "Approve one reference query.",
            }),
          ),
        )
        await runResearch(
          Research.Service.use((svc) =>
            svc.replyApproval({
              approvalID: approval.id,
              status: "approved",
            }),
          ),
        )

        const first = await createRun({
          taskID: task.id,
          candidateID: candidate.id,
          stage: "ref_test",
          status: "succeeded",
          metrics: { ref_test_avg_mse: 0.2 },
        })
        expect(first.stage).toBe("ref_test")

        await expect(
          runResearch(
            Research.Service.use((svc) =>
              svc.createRun({
                taskID: task.id,
                candidateID: candidate.id,
                stage: "ref_test",
                status: "queued",
              }),
            ),
          ),
        ).rejects.toMatchObject({
          name: "ResearchBudgetExceededError",
          data: { taskID: task.id, limit: 1, used: 1 },
        })

        const approvals = await runResearch(Research.Service.use((svc) => svc.listApprovals({ taskID: task.id })))
        expect(approvals.some((item) => item.kind === "budget" && item.status === "pending")).toBe(true)
      },
    })
  })

  test("requires blind test approval and enforces blind query limits", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "blind test governed task",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12, governance: { blindTestQueryLimit: 1 } },
            }),
          ),
        )
        const candidate = await createCandidate({ taskID: task.id })

        await expect(
          runResearch(
            Research.Service.use((svc) =>
              svc.prepareRun({
                taskID: task.id,
                candidateID: candidate.id,
                stage: "blind_test",
                description: "blocked blind test",
              }),
            ),
          ),
        ).rejects.toThrow("ResearchApprovalRequiredError")

        let approvals = await runResearch(Research.Service.use((svc) => svc.listApprovals({ taskID: task.id })))
        const blindApproval = approvals.find((item) => item.kind === "blind_test")
        expect(blindApproval).toMatchObject({
          candidateID: candidate.id,
          reason: "Approve external blind test before blind_test execution.",
        })

        await runResearch(
          Research.Service.use((svc) =>
            svc.replyApproval({
              approvalID: blindApproval!.id,
              status: "approved",
            }),
          ),
        )

        await runResearch(
          Research.Service.use((svc) =>
            svc.createRun({
              taskID: task.id,
              candidateID: candidate.id,
              stage: "blind_test",
              status: "succeeded",
              metrics: { blind_test_avg_mse: 0.2 },
            }),
          ),
        )

        await expect(
          runResearch(
            Research.Service.use((svc) =>
              svc.createRun({
                taskID: task.id,
                candidateID: candidate.id,
                stage: "blind_test",
                status: "queued",
              }),
            ),
          ),
        ).rejects.toMatchObject({
          name: "ResearchBudgetExceededError",
          data: { taskID: task.id, limit: 1, used: 1 },
        })

        approvals = await runResearch(Research.Service.use((svc) => svc.listApprovals({ taskID: task.id })))
        expect(approvals.some((item) => item.kind === "budget" && item.status === "pending")).toBe(true)
      },
    })
  })

  test("seeds review baselines and prepares an approved candidate run", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTSFTask("review baseline workflow")

        const seeded = await runResearch(Research.Service.use((svc) => svc.seedBaselines({ taskID: task.id })))
        expect(seeded.candidates).toHaveLength(3)
        expect(seeded.approvals).toHaveLength(3)
        expect(seeded.candidates.every((item) => item.approvalStatus === "pending")).toBe(true)

        const approval = seeded.approvals[0]!
        const candidate = seeded.candidates[0]!
        await runResearch(
          Research.Service.use((svc) =>
            svc.replyApproval({
              approvalID: approval.id,
              status: "approved",
              replyMessage: "Approved baseline smoke run.",
            }),
          ),
        )

        const prepared = await runResearch(
          Research.Service.use((svc) =>
            svc.prepareRun({
              taskID: task.id,
              candidateID: candidate.id,
              stage: "smoke",
              description: "approved baseline smoke run",
            }),
          ),
        )

        expect(prepared.run.status).toBe("queued")
        expect(prepared.run.candidateID).toBe(candidate.id)
        expect(prepared.runPlan.validation.ok).toBe(true)
        expect(prepared.runPlan.writes[0]!.content.recipe_version).toBe("recipe_schema_v1")
      },
    })
  })

  test("executes an approved candidate run through a runner plan", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeFakeNeoCastRunner(fakeNeoCastRoot)

        const task = await createTSFTask("execute fake runner", {
          bridgeOnly: true,
          neoCastProjectRoot: fakeNeoCastRoot,
          pythonExecutable: "bash",
        })
        const seeded = await runResearch(Research.Service.use((svc) => svc.seedBaselines({ taskID: task.id })))
        await runResearch(
          Research.Service.use((svc) =>
            svc.replyApproval({
              approvalID: seeded.approvals[0]!.id,
              status: "approved",
            }),
          ),
        )

        const executed = await runResearch(
          Research.Service.use((svc) =>
            svc.executeRun({
              taskID: task.id,
              candidateID: seeded.candidates[0]!.id,
              stage: "smoke",
              description: "fake runner smoke",
            }),
          ),
        )

        expect(executed.run.status).toBe("succeeded")
        expect(executed.run.metrics.val_avg_mse).toBe(0.123)
        expect(executed.run.resourceUsage.exitCode).toBe(0)
        expect(executed.run.artifactRefs).toHaveLength(3)

        const writtenCandidate = JSON.parse(
          await readFile(path.join(fakeNeoCastRoot, ".neo-cast", "current_candidate.json"), "utf8"),
        )
        expect(writtenCandidate.recipe_version).toBe("recipe_schema_v1")

        const artifacts = await runResearch(Research.Service.use((svc) => svc.listArtifacts(task.id)))
        expect(artifacts.some((artifact) => artifact.kind === "runner_plan_json")).toBe(true)
        expect(artifacts.some((artifact) => artifact.kind === "runner_artifact")).toBe(true)
        const executionLog = artifacts.find((artifact) => artifact.kind === "runner_execution_log_json")
        expect(executionLog?.runID).toBe(executed.run.id)
        expect(executionLog?.metadata).toMatchObject({
          runnerID: executed.runPlan.runnerID,
          stage: "smoke",
          exitCode: 0,
          recordCount: 4,
        })
        expect(executed.run.artifactRefs).toContain(executionLog!.id)
        const executionLogRecord = JSON.parse(await readFile(executionLog!.uri.replace("file://", ""), "utf8"))
        expect(executionLogRecord.exitCode).toBe(0)
        expect(executionLogRecord.records.map((record: { event?: string }) => record.event)).toContain("artifact_ready")
        expect(artifacts[0]!.uri).toStartWith("file://")

        const champion = await runResearch(Research.Service.use((svc) => svc.getChampion(task.id)))
        expect(champion?.candidateID).toBe(seeded.candidates[0]!.id)
        expect(champion?.primaryMetric).toBe(0.123)

        const memory = await runResearch(Research.Service.use((svc) => svc.listMemory(task.id)))
        expect(memory[0]!.outcome).toBe("accepted")
        expect(memory[0]!.fingerprintSummary).toMatchObject({
          targetCount: 1,
          contextLength: 96,
          maxPredictionLength: 24,
          horizonContextRatio: 0.25,
          bridgeOnly: true,
        })
        expect(memory[0]!.candidateSummary.primaryMetric).toBe(0.123)
      },
    })
  })

  test("persists runner execution logs for failed runs", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "failing-neo-cast")
        await writeFailingNeoCastRunner(fakeNeoCastRoot)

        const task = await createTSFTask("execute failing runner", {
          bridgeOnly: true,
          neoCastProjectRoot: fakeNeoCastRoot,
          pythonExecutable: "bash",
        })
        const candidate = await createCandidate({ taskID: task.id })

        const executed = await runResearch(
          Research.Service.use((svc) =>
            svc.executeRun({
              taskID: task.id,
              candidateID: candidate.id,
              stage: "smoke",
              description: "failing runner smoke",
            }),
          ),
        )

        expect(executed.run.status).toBe("failed")
        expect(executed.run.resourceUsage.exitCode).toBe(7)
        expect(executed.run.artifactRefs).toHaveLength(2)

        const artifacts = await runResearch(Research.Service.use((svc) => svc.listArtifacts(task.id)))
        const executionLog = artifacts.find((artifact) => artifact.kind === "runner_execution_log_json")
        expect(executionLog?.metadata).toMatchObject({
          runnerID: executed.runPlan.runnerID,
          stage: "smoke",
          exitCode: 7,
          recordCount: 2,
        })
        expect(executed.run.artifactRefs).toContain(executionLog!.id)
        const executionLogRecord = JSON.parse(await readFile(executionLog!.uri.replace("file://", ""), "utf8"))
        expect(executionLogRecord.stderr).toContain("runner failed before artifact creation")
        expect(executionLogRecord.records.map((record: { event?: string }) => record.event)).toContain("runner_error")
      },
    })
  })

  test("executes a candidate seed sweep using task evaluation seeds", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast-seeds")
        await writeSeedAwareFakeNeoCastRunner(fakeNeoCastRoot)

        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "multi-seed execute fake runner",
              domainID: "tsf",
              mode: "review",
              taskSpec: {
                ...validTsfTaskSpec({
                  bridgeOnly: true,
                  neoCastProjectRoot: fakeNeoCastRoot,
                  pythonExecutable: "bash",
                }),
                evaluation: {
                  protocol: "fixed_split",
                  metricPrimary: "val_avg_mse",
                  seeds: [3, 5, 7],
                },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12 },
            }),
          ),
        )
        const seeded = await runResearch(Research.Service.use((svc) => svc.seedBaselines({ taskID: task.id })))
        await runResearch(
          Research.Service.use((svc) =>
            svc.replyApproval({
              approvalID: seeded.approvals[0]!.id,
              status: "approved",
            }),
          ),
        )

        const sweep = await runResearch(
          Research.Service.use((svc) =>
            svc.executeSeedSweep({
              taskID: task.id,
              candidateID: seeded.candidates[0]!.id,
              stage: "smoke",
              description: "fake runner seed sweep",
            }),
          ),
        )

        expect(sweep.runs).toHaveLength(3)
        expect(sweep.runs.map((item) => item.run.status)).toEqual(["succeeded", "succeeded", "succeeded"])
        expect(sweep.runs.map((item) => item.run.resourceUsage.seed)).toEqual([3, 5, 7])
        expect(
          sweep.runs.map(
            (item) =>
              (
                item.runPlan.writes[0]!.content as {
                  training_strategy?: { budget?: { seed?: number } }
                }
              ).training_strategy?.budget?.seed,
          ),
        ).toEqual([3, 5, 7])

        const seedLog = await readFile(path.join(fakeNeoCastRoot, ".neo-cast", "seed-log.txt"), "utf8")
        expect(seedLog.trim().split("\n")).toEqual(["3", "5", "7"])

        const exported = await runResearch(Research.Service.use((svc) => svc.exportTaskArtifact({ taskID: task.id })))
        expect(exported.artifact.metadata.multiSeedCandidateCount).toBe(1)
      },
    })
  })

  test("exports a research task report artifact", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTask("exportable TSF report")
        const candidate = await createCandidate({ taskID: task.id })
        const run = await createRun({
          taskID: task.id,
          candidateID: candidate.id,
          status: "succeeded",
          metrics: { mse: 0.42, mae: 0.31 },
        })
        await runResearch(
          Research.Service.use((svc) =>
            svc.setChampion({
              taskID: task.id,
              candidateID: candidate.id,
              runID: run.id,
              primaryMetric: 0.42,
              utility: -0.42,
            }),
          ),
        )
        await runResearch(
          Research.Service.use((svc) =>
            svc.createMemory({
              taskID: task.id,
              domainID: "tsf",
              fingerprintSummary: { dataset: "ETTh1", horizon: 96 },
              candidateSummary: { candidateID: candidate.id, runID: run.id },
              outcome: "accepted",
              lesson: "TCN with RevIN is the current champion.",
            }),
          ),
        )

        const exported = await runResearch(Research.Service.use((svc) => svc.exportTaskArtifact({ taskID: task.id })))

        expect(exported.path).toEndWith("research-report.md")
        expect(exported.artifact.kind).toBe("research_report_markdown")
        expect(exported.artifact.uri).toBe(`file://${exported.path}`)
        expect(exported.artifact.metadata.taskID).toBe(task.id)
        expect(exported.artifact.metadata.candidateCount).toBe(1)
        expect(exported.artifact.metadata.runCount).toBe(1)
        expect(exported.artifact.metadata.championCandidateID).toBe(candidate.id)

        const report = await readFile(exported.path, "utf8")
        expect(report).toContain("# exportable TSF report")
        expect(report).toContain("## Champion")
        expect(report).toContain(candidate.id)
        expect(report).toContain("mse")
        expect(report).toContain("TCN with RevIN is the current champion.")

        const artifacts = await runResearch(Research.Service.use((svc) => svc.listArtifacts(task.id)))
        expect(artifacts.map((artifact) => artifact.id)).toContain(exported.artifact.id)
      },
    })
  })

  test("exports multi-seed summaries and Pareto frontier for candidate comparison", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTask("multi-seed frontier report")
        const baseSpec = validTsfCandidateSpec()
        const fastCandidate = await createCandidate({
          taskID: task.id,
          candidateSpec: { ...baseSpec, recipeID: "fast_low_cost" } as Research.JsonRecord,
          rationale: "low-cost smoke candidate",
        })
        const accurateCandidate = await createCandidate({
          taskID: task.id,
          candidateSpec: { ...baseSpec, recipeID: "accurate_high_cost" } as Research.JsonRecord,
          rationale: "higher-accuracy candidate",
        })
        const dominatedCandidate = await createCandidate({
          taskID: task.id,
          candidateSpec: { ...baseSpec, recipeID: "dominated_slow_bad" } as Research.JsonRecord,
          rationale: "slower and less accurate candidate",
        })

        await createRun({
          taskID: task.id,
          candidateID: fastCandidate.id,
          status: "succeeded",
          metrics: { val_avg_mse: 0.5 },
          resourceUsage: { seed: 1, wallClockSec: 8 },
        })
        await createRun({
          taskID: task.id,
          candidateID: fastCandidate.id,
          status: "succeeded",
          metrics: { val_avg_mse: 0.52 },
          resourceUsage: { seed: 2, wallClockSec: 9 },
        })
        await createRun({
          taskID: task.id,
          candidateID: accurateCandidate.id,
          status: "succeeded",
          metrics: { val_avg_mse: 0.42 },
          resourceUsage: { seed: 1, wallClockSec: 40 },
        })
        await createRun({
          taskID: task.id,
          candidateID: dominatedCandidate.id,
          status: "succeeded",
          metrics: { val_avg_mse: 0.7 },
          resourceUsage: { seed: 1, wallClockSec: 60 },
        })

        const exported = await runResearch(Research.Service.use((svc) => svc.exportTaskArtifact({ taskID: task.id })))

        expect(exported.artifact.metadata).toMatchObject({
          primaryMetricName: "val_avg_mse",
          evaluatedRunCount: 4,
          multiSeedCandidateCount: 1,
          paretoFrontierCount: 2,
        })

        const report = await readFile(exported.path, "utf8")
        expect(report).toContain("## Experiment Analysis")
        expect(report).toContain("### Multi-seed Summary")
        expect(report).toContain(`- ${fastCandidate.id}: n=2 val_avg_mse mean=0.51`)
        expect(report).toContain("std=0.01")
        expect(report).toContain("ci95=0.0139")
        expect(report).toContain("### Pareto Frontier")

        const paretoSection = report.split("### Pareto Frontier")[1]!.split("\n## ")[0]!
        expect(paretoSection).toContain(fastCandidate.id)
        expect(paretoSection).toContain(accurateCandidate.id)
        expect(paretoSection).not.toContain(dominatedCandidate.id)
      },
    })
  })

  test("exports utility ranking with resource and variance penalties", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTask("utility ranking report")
        const baseSpec = validTsfCandidateSpec()
        const championCandidate = await createCandidate({
          taskID: task.id,
          candidateSpec: { ...baseSpec, recipeID: "current_champion" } as Research.JsonRecord,
          rationale: "current champion",
        })
        const challengerCandidate = await createCandidate({
          taskID: task.id,
          candidateSpec: { ...baseSpec, recipeID: "smaller_stable_challenger" } as Research.JsonRecord,
          rationale: "smaller and more accurate challenger",
        })

        const championRun = await createRun({
          taskID: task.id,
          candidateID: championCandidate.id,
          status: "succeeded",
          metrics: { val_avg_mse: 0.5 },
          resourceUsage: { seed: 1, params_M: 2, latency_ms: 30, delta_loc: 20 },
        })
        await createRun({
          taskID: task.id,
          candidateID: challengerCandidate.id,
          status: "succeeded",
          metrics: { val_avg_mse: 0.46 },
          resourceUsage: { seed: 1, params_M: 1.5, latency_ms: 20, delta_loc: 10 },
        })
        await createRun({
          taskID: task.id,
          candidateID: challengerCandidate.id,
          status: "succeeded",
          metrics: { val_avg_mse: 0.47 },
          resourceUsage: { seed: 2, params_M: 1.5, latency_ms: 20, delta_loc: 10 },
        })
        await runResearch(
          Research.Service.use((svc) =>
            svc.setChampion({
              taskID: task.id,
              candidateID: championCandidate.id,
              runID: championRun.id,
              primaryMetric: 0.5,
              utility: -0.5,
            }),
          ),
        )

        const exported = await runResearch(Research.Service.use((svc) => svc.exportTaskArtifact({ taskID: task.id })))

        expect(exported.artifact.metadata.utilityCandidateCount).toBe(2)
        const report = await readFile(exported.path, "utf8")
        expect(report).toContain("### Utility Ranking")
        const utilitySection = report.split("### Utility Ranking")[1]!.split("\n### Pareto Frontier")[0]!
        expect(utilitySection.indexOf(challengerCandidate.id)).toBeLessThan(utilitySection.indexOf(championCandidate.id))
        expect(utilitySection).toContain("accuracy_gain=")
        expect(utilitySection).toContain("variance_penalty=")
      },
    })
  })

  test("exports candidate lineage metadata and report section", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTask("lineage report")
        const parent = await createCandidate({
          taskID: task.id,
          candidateSpec: { ...validTsfCandidateSpec(), recipeID: "parent_recipe" } as Research.JsonRecord,
        })
        const child = await createCandidate({
          taskID: task.id,
          parentCandidateID: parent.id,
          candidateSpec: { ...validTsfCandidateSpec(), recipeID: "child_recipe" } as Research.JsonRecord,
        })

        const exported = await runResearch(Research.Service.use((svc) => svc.exportTaskArtifact({ taskID: task.id })))

        expect(exported.artifact.metadata.lineageRootCount).toBe(1)
        expect(exported.artifact.metadata.lineageEdgeCount).toBe(1)
        const report = await readFile(exported.path, "utf8")
        expect(report).toContain("## Candidate Lineage")
        expect(report).toContain(`${parent.id} -> ${child.id}`)
        expect(report).toContain("recipe=child_recipe")
      },
    })
  })

  test("runs one autonomous iteration with auto-approved baselines", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeFakeNeoCastRunner(fakeNeoCastRoot)

        const task = await createTSFTask(
          "autonomous fake runner",
          {
            bridgeOnly: true,
            neoCastProjectRoot: fakeNeoCastRoot,
            pythonExecutable: "bash",
          },
          "autonomous",
        )

        const iteration = await runResearch(
          Research.Service.use((svc) =>
            svc.runAutonomousIteration({
              taskID: task.id,
              stage: "smoke",
              description: "autonomous smoke iteration",
            }),
          ),
        )

        expect(iteration.seededCandidates).toHaveLength(3)
        expect(iteration.approvals).toHaveLength(0)
        expect(iteration.candidate.approvalStatus).toBe("auto_approved")
        expect(iteration.run.status).toBe("succeeded")
        expect(iteration.managerTrace.map((step) => step.role)).toEqual([
          "diagnostic",
          "design",
          "coder",
          "runner",
          "analyst",
          "librarian",
        ])
        expect(iteration.managerTrace[0]!.metadata).toMatchObject({ bridgeOnly: true, targetCount: 1 })
        expect(iteration.managerTrace[3]!.metadata).toMatchObject({ stage: "smoke", status: "succeeded" })

        const artifacts = await runResearch(Research.Service.use((svc) => svc.listArtifacts(task.id)))
        const managerTraceArtifact = artifacts.find((artifact) => artifact.kind === "research_manager_trace_json")
        expect(managerTraceArtifact?.runID).toBe(iteration.run.id)
        expect(managerTraceArtifact?.metadata).toMatchObject({
          candidateID: iteration.candidate.id,
          runID: iteration.run.id,
          stage: "smoke",
          roleCount: 6,
        })
        expect(iteration.run.artifactRefs).toContain(managerTraceArtifact!.id)
        const managerTracePath = managerTraceArtifact!.uri.replace("file://", "")
        const managerTraceRecord = JSON.parse(await readFile(managerTracePath, "utf8"))
        expect(managerTraceRecord.managerTrace.map((step: { role: string }) => step.role)).toEqual([
          "diagnostic",
          "design",
          "coder",
          "runner",
          "analyst",
          "librarian",
        ])

        const champion = await runResearch(Research.Service.use((svc) => svc.getChampion(task.id)))
        expect(champion?.candidateID).toBe(iteration.candidate.id)
      },
    })
  })

  test("writes an autonomous loop summary artifact", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeFakeNeoCastRunner(fakeNeoCastRoot)

        const task = await createTSFTask(
          "autonomous loop fake runner",
          {
            bridgeOnly: true,
            neoCastProjectRoot: fakeNeoCastRoot,
            pythonExecutable: "bash",
          },
          "autonomous",
        )

        const loop = await runResearch(
          Research.Service.use((svc) =>
            svc.runAutonomousLoop({
              taskID: task.id,
              stage: "smoke",
              maxIterations: 2,
              description: "autonomous loop audit",
            }),
          ),
        )

        expect(loop.stoppedReason).toBe("max_iterations")
        expect(loop.iterations).toHaveLength(2)
        expect(loop.artifact?.kind).toBe("research_autonomous_loop_json")
        expect(loop.artifact?.metadata).toMatchObject({
          stoppedReason: "max_iterations",
          iterationCount: 2,
          succeededCount: 2,
        })

        const loopRecord = JSON.parse(await readFile(loop.artifact!.uri.replace("file://", ""), "utf8"))
        expect(loopRecord.iterations.map((iteration: { runID: string }) => iteration.runID)).toEqual(
          loop.iterations.map((iteration) => iteration.run.id),
        )
        expect(loopRecord.iterations.map((iteration: { managerTraceRoles: string[] }) => iteration.managerTraceRoles)).toEqual(
          loop.iterations.map((iteration) => iteration.managerTrace.map((step) => step.role)),
        )
      },
    })
  })

  test("creates a task-level budget approval when autonomous loop budget is exhausted", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "autonomous budget audit",
              domainID: "tsf",
              mode: "autonomous",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 0 },
            }),
          ),
        )

        const loop = await runResearch(
          Research.Service.use((svc) =>
            svc.runAutonomousLoop({
              taskID: task.id,
              stage: "smoke",
              maxIterations: 2,
              description: "budget stopped loop",
            }),
          ),
        )

        expect(loop.stoppedReason).toBe("budget_exhausted")
        expect(loop.iterations).toHaveLength(0)

        const approvals = await runResearch(Research.Service.use((svc) => svc.listApprovals({ taskID: task.id })))
        const budgetApprovals = approvals.filter((approval) => approval.kind === "budget")
        expect(budgetApprovals).toHaveLength(1)
        expect(budgetApprovals[0]).toMatchObject({
          taskID: task.id,
          candidateID: undefined,
          status: "pending",
          reason: "Run budget exhausted: used 0 of max 0. Increase budget or stop the task.",
        })
      },
    })
  })

  test("autonomous loop stops with an artifact when run approval gates block execution", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTSFTask("autonomous governed native loop", { bridgeOnly: false }, "autonomous")
        const candidate = await runResearch(
          Research.Service.use((svc) =>
            svc.createCandidate({
              taskID: task.id,
              domainID: "tsf",
              candidateSpec: phaseTwoTsfCandidateSpec(),
              rationale: "Native phase-two candidate should require a domain action approval before low fidelity.",
              riskLevel: "medium",
              approvalStatus: "auto_approved",
              generatedBy: "mutation",
            }),
          ),
        )

        const loop = await runResearch(
          Research.Service.use((svc) =>
            svc.runAutonomousLoop({
              taskID: task.id,
              stage: "low_fidelity",
              maxIterations: 1,
              description: "governed native loop",
            }),
          ),
        )

        expect(loop.iterations).toHaveLength(0)
        expect(loop.stoppedReason).toBe("approval_required")
        expect(loop.artifact.kind).toBe("research_autonomous_loop_json")

        const approvals = await runResearch(Research.Service.use((svc) => svc.listApprovals({ taskID: task.id })))
        expect(approvals.find((approval) => approval.kind === "domain_action")).toMatchObject({
          candidateID: candidate.id,
          status: "pending",
        })
      },
    })
  })

  test("writes a candidate selection rank artifact for autonomous proposals", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const datasetPath = await writeProfileDataset()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeFakeNeoCastRunner(fakeNeoCastRoot)

        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "ranked native proposal audit",
              domainID: "tsf",
              mode: "autonomous",
              taskSpec: {
                contextLength: 96,
                predictionLengths: [24],
                dataset: {
                  loaderID: "local_csv",
                  path: datasetPath,
                  targetCols: ["a", "b", "c"],
                },
                runtime: {
                  bridgeOnly: false,
                  neoCastProjectRoot: fakeNeoCastRoot,
                  pythonExecutable: "bash",
                },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12 },
            }),
          ),
        )

        for (let index = 0; index < 3; index++) {
          await runResearch(
            Research.Service.use((svc) =>
              svc.runAutonomousIteration({
                taskID: task.id,
                stage: "smoke",
                description: `baseline ${index + 1}`,
              }),
            ),
          )
        }

        const iteration = await runResearch(
          Research.Service.use((svc) =>
            svc.runAutonomousIteration({
              taskID: task.id,
              stage: "smoke",
              description: "ranked native proposal",
            }),
          ),
        )

        expect(iteration.candidate.candidateSpec.recipeID).toBe("tsf_ranked_frequency_mixer_profiled")
        expect(iteration.selectionArtifact?.kind).toBe("research_candidate_selection_json")
        expect(iteration.selectionArtifact?.runID).toBe(iteration.run.id)
        expect(iteration.run.artifactRefs).toContain(iteration.selectionArtifact!.id)

        const selectionRecord = JSON.parse(await readFile(iteration.selectionArtifact!.uri.replace("file://", ""), "utf8"))
        expect(selectionRecord.selectionSource).toBe("domain_proposal")
        expect(selectionRecord.selectedCandidateID).toBe(iteration.candidate.id)
        expect(selectionRecord.selectedRecipeID).toBe("tsf_ranked_frequency_mixer_profiled")
        expect(selectionRecord.rankings[0]).toMatchObject({
          recipeID: "tsf_ranked_frequency_mixer_profiled",
          rank: 1,
        })
        expect(selectionRecord.rankings[0].score).toBeGreaterThan(0)
        expect(selectionRecord.rankings[0].reasons).toContain("seasonality favors frequency embedding")
        expect(selectionRecord.rankPredictor).toMatchObject({
          version: "tsf_profile_learned_memory_ranker_v1",
          featureSource: "taskFingerprint.datasetProfile",
          rankingCount: selectionRecord.rankings.length,
          memoryEvidenceCount: 3,
          benchmarkEvidenceCount: 0,
        })
        expect(selectionRecord.rankings[0].predictorVersion).toBe("tsf_profile_learned_memory_ranker_v1")
        expect(selectionRecord.rankings[0].features).toMatchObject({
          contextLength: 96,
          maxPredictionLength: 24,
          targetCount: 3,
          bridgeOnly: false,
          historyRunCount: 3,
          historyMetricRunCount: 3,
          historyMemoryCount: 3,
          learnedRankerTrainingExamples: 4,
          learnedRankerPositiveExamples: 2,
          learnedRankerNegativeExamples: 2,
          hasChampion: true,
          memoryEvidenceCount: 3,
          benchmarkEvidenceCount: 0,
          datasetProfileSignals: {
            source: "dataset.path",
            active: expect.arrayContaining([
              "seasonal",
              "cross_var_correlated",
              "missing_values",
              "distribution_shift",
            ]),
          },
          missingRate: expect.any(Number),
          seasonalityStrength: expect.any(Number),
          crossVarCorrelation: expect.any(Number),
          distributionShift: expect.any(Number),
        })
        expect(selectionRecord.rankings[0].candidateActions).toMatchObject({
          preprocessing: expect.arrayContaining(["missing_mask"]),
          embedding: "frequency",
          backbone: "mixer",
          fusion: "gated_hybrid",
          predictionHead: "direct_multi_horizon",
          outputDistribution: "point",
          loss: "huber",
          optimizer: "adamw",
          scheduler: "one_cycle",
          noveltySummary: {
            novelActionCount: expect.any(Number),
            novelActions: expect.any(Array),
          },
        })

        const managerTraceArtifact = (await runResearch(Research.Service.use((svc) => svc.listArtifacts(task.id)))).find(
          (artifact) => artifact.kind === "research_manager_trace_json" && artifact.runID === iteration.run.id,
        )
        const managerTraceRecord = JSON.parse(await readFile(managerTraceArtifact!.uri.replace("file://", ""), "utf8"))
        expect(
          managerTraceRecord.managerTrace.find((step: { role: string }) => step.role === "design").metadata,
        ).toMatchObject({
          selectedCandidateID: iteration.candidate.id,
          rankPredictorVersion: "tsf_profile_learned_memory_ranker_v1",
          selectionSource: "domain_proposal",
        })
        expect(
          managerTraceRecord.managerTrace.find((step: { role: string }) => step.role === "analyst").metadata,
        ).toMatchObject({
          selectedCandidateID: iteration.candidate.id,
          rankPredictorVersion: "tsf_profile_learned_memory_ranker_v1",
        })
        expect(
          managerTraceRecord.managerTrace.find((step: { role: string }) => step.role === "librarian").metadata,
        ).toMatchObject({
          selectedCandidateID: iteration.candidate.id,
          memoryWriteOutcome: "recorded",
        })
      },
    })
  })

  test("uses same-domain benchmark memory for autonomous proposal ranking", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const datasetPath = await writeProfileDataset()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeFakeNeoCastRunner(fakeNeoCastRoot)

        const sourceTask = await createTSFTask("source benchmark memory", { bridgeOnly: false })
        await runResearch(
          Research.Service.use((svc) =>
            svc.createMemory({
              taskID: sourceTask.id,
              domainID: "tsf",
              fingerprintSummary: {
                taskID: sourceTask.id,
                domainID: "tsf",
                datasetProfile: {
                  source: "dataset.path",
                  path: "/tmp/source.csv",
                  rowCount: 960,
                  targetCount: 3,
                  numericColumnCount: 3,
                  missingRate: 0.01,
                  trendStrength: 0.25,
                  seasonalityStrength: 0.88,
                  crossVarCorrelation: 0.86,
                  distributionShift: 0.55,
                },
              },
              candidateSummary: {
                candidateSpec: benchmarkInvertTsfCandidateSpec(),
                primaryMetric: 0.11,
                championUpdated: true,
              },
              outcome: "accepted",
              lesson: "Invert RNN improved a similar benchmark task.",
            }),
          ),
        )

        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "target benchmark-memory proposal",
              domainID: "tsf",
              mode: "autonomous",
              taskSpec: {
                contextLength: 96,
                predictionLengths: [24],
                dataset: {
                  loaderID: "local_csv",
                  path: datasetPath,
                  targetCols: ["a", "b", "c"],
                },
                runtime: {
                  bridgeOnly: false,
                  neoCastProjectRoot: fakeNeoCastRoot,
                  pythonExecutable: "bash",
                },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12 },
            }),
          ),
        )

        for (let index = 0; index < 3; index++) {
          await runResearch(
            Research.Service.use((svc) =>
              svc.runAutonomousIteration({
                taskID: task.id,
                stage: "smoke",
                description: `baseline ${index + 1}`,
              }),
            ),
          )
        }

        const iteration = await runResearch(
          Research.Service.use((svc) =>
            svc.runAutonomousIteration({
              taskID: task.id,
              stage: "smoke",
              description: "benchmark-memory proposal",
            }),
          ),
        )

        expect(iteration.candidate.candidateSpec.recipeID).toBe("tsf_ranked_invert_rnn_feature_profiled")
        const selectionRecord = JSON.parse(await readFile(iteration.selectionArtifact!.uri.replace("file://", ""), "utf8"))
        expect(selectionRecord.rankPredictor.version).toBe("tsf_profile_learned_memory_ranker_v1")
        expect(iteration.selectionArtifact!.metadata).toMatchObject({
          rankPredictorVersion: "tsf_profile_learned_memory_ranker_v1",
          historyDomainMemoryCount: 1,
          historyTaskMemoryCount: 3,
        })
        expect(selectionRecord.rankings[0].features).toMatchObject({
          historyDomainMemoryCount: 1,
          learnedRankerTrainingExamples: 5,
          learnedRankerPositiveExamples: 3,
          learnedRankerNegativeExamples: 2,
        })
        expect(selectionRecord.rankings[0].reasons.some((reason: string) => reason.includes("benchmark memory"))).toBe(
          true,
        )
        expect(
          selectionRecord.rankings[0].reasons.some((reason: string) => reason.includes("learned memory ranker")),
        ).toBe(true)
      },
    })
  })

  test("does not use same-domain benchmark memory from another project", async () => {
    await using sourceTmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await using targetTmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const datasetPath = await writeProfileDataset()

    await Instance.provide({
      directory: sourceTmp.path,
      fn: async () => {
        const sourceTask = await createTSFTask("foreign benchmark memory", { bridgeOnly: false })
        await runResearch(
          Research.Service.use((svc) =>
            svc.createMemory({
              taskID: sourceTask.id,
              domainID: "tsf",
              fingerprintSummary: {
                taskID: sourceTask.id,
                domainID: "tsf",
                datasetProfile: {
                  source: "dataset.path",
                  path: "/tmp/foreign.csv",
                  rowCount: 960,
                  targetCount: 3,
                  numericColumnCount: 3,
                  missingRate: 0.01,
                  trendStrength: 0.25,
                  seasonalityStrength: 0.88,
                  crossVarCorrelation: 0.86,
                  distributionShift: 0.55,
                },
              },
              candidateSummary: {
                candidateSpec: benchmarkInvertTsfCandidateSpec(),
                primaryMetric: 0.11,
                championUpdated: true,
              },
              outcome: "accepted",
              lesson: "Foreign project benchmark memory should stay isolated.",
            }),
          ),
        )
      },
    })

    await Instance.provide({
      directory: targetTmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(targetTmp.path, "fake-neo-cast")
        await writeFakeNeoCastRunner(fakeNeoCastRoot)
        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "isolated benchmark-memory proposal",
              domainID: "tsf",
              mode: "autonomous",
              taskSpec: {
                contextLength: 96,
                predictionLengths: [24],
                dataset: {
                  loaderID: "local_csv",
                  path: datasetPath,
                  targetCols: ["a", "b", "c"],
                },
                runtime: {
                  bridgeOnly: false,
                  neoCastProjectRoot: fakeNeoCastRoot,
                  pythonExecutable: "bash",
                },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12 },
            }),
          ),
        )

        for (let index = 0; index < 3; index++) {
          await runResearch(
            Research.Service.use((svc) =>
              svc.runAutonomousIteration({
                taskID: task.id,
                stage: "smoke",
                description: `baseline ${index + 1}`,
              }),
            ),
          )
        }

        const iteration = await runResearch(
          Research.Service.use((svc) =>
            svc.runAutonomousIteration({
              taskID: task.id,
              stage: "smoke",
              description: "isolated benchmark-memory proposal",
            }),
          ),
        )

        expect(iteration.candidate.candidateSpec.recipeID).toBe("tsf_ranked_frequency_mixer_profiled")
        const selectionRecord = JSON.parse(await readFile(iteration.selectionArtifact!.uri.replace("file://", ""), "utf8"))
        expect(selectionRecord.rankings[0].features.historyDomainMemoryCount).toBe(0)
      },
    })
  })

  test("updates run lifecycle fields and preserves optional data", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTask()
        const candidate = await createCandidate({ taskID: task.id })
        const run = await createRun({
          taskID: task.id,
          candidateID: candidate.id,
          status: "queued",
          metrics: { mse: 1 },
        })

        expect(run.timeStarted).toBeUndefined()
        expect(run.timeFinished).toBeUndefined()

        const running = await runResearch(
          Research.Service.use((svc) => svc.updateRunStatus({ runID: run.id, status: "running" })),
        )
        expect(running.metrics.mse).toBe(1)
        expect(running.timeStarted).toBeNumber()
        expect(running.timeFinished).toBeUndefined()

        const failed = await runResearch(
          Research.Service.use((svc) =>
            svc.updateRunStatus({
              runID: run.id,
              status: "failed",
              metrics: { mse: 0.9 },
              resourceUsage: { gpuHours: 0.2 },
              error: "training failed",
            }),
          ),
        )
        expect(failed.timeStarted).toBe(running.timeStarted)
        expect(failed.timeFinished).toBeNumber()
        expect(failed.error).toBe("training failed")

        const retried = await runResearch(
          Research.Service.use((svc) => svc.updateRunStatus({ runID: run.id, status: "running" })),
        )
        expect(retried.metrics.mse).toBe(0.9)
        expect(retried.resourceUsage.gpuHours).toBe(0.2)
        expect(retried.timeStarted).toBe(running.timeStarted)
        expect(retried.timeFinished).toBeUndefined()
        expect(retried.error).toBeUndefined()
      },
    })
  })
})
