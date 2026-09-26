import { NAS_DEFAULT_MAX_NO_IMPROVE } from "../../src/research/defaults"
import { existsSync } from "node:fs"
import { afterEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Layer } from "effect"
import { mkdir, mkdtemp, readFile, writeFile } from "fs/promises"
import { tmpdir as osTmpdir } from "os"
import { Bus } from "../../src/bus"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Research } from "../../src/research"
import { ResearchRunTable } from "../../src/research/research.sql"
import { createFileResearchRuntime } from "../../src/research/runtime"
import { Database, eq } from "../../src/storage"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"
import { addHypothesisToPool } from "../../src/research/hypothesis-store"
import { validateCandidateAgainstHypothesis } from "../../src/research/execution-contract"

function runResearch<A, E>(fx: Effect.Effect<A, E, Research.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(Research.defaultLayer)))
}

function runResearchWithBus<A, E>(fx: Effect.Effect<A, E, Research.Service | Bus.Service>) {
  return Effect.runPromise(
    fx.pipe(
      Effect.provide(
        Research.layer.pipe(
          Layer.provideMerge(Bus.layer),
          Layer.provideMerge(Session.defaultLayer),
          Layer.provideMerge(SessionPrompt.defaultLayer),
        ),
      ),
    ),
  )
}

function validTsfTaskSpec(runtime: Research.JsonRecord = {}) {
  const datasetPath = typeof runtime.datasetPath === "string" ? runtime.datasetPath : undefined
  const { datasetPath: _datasetPath, ...runnerRuntime } = runtime
  return {
    contextLength: 96,
    predictionLengths: [24],
    dataset: {
      loaderID: "etth1_tslib_v1",
      ...(datasetPath === undefined ? {} : { path: datasetPath }),
      targetCols: ["OT"],
    },
    runtime: runnerRuntime,
    metadata: {
      businessContext: "TSF benchmark experiment",
      interpretability: "none_required",
      deploymentTarget: "local_research",
    },
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
    recipeVersion: "recipe_schema_v2",
    recipeID: "benchmark_accepted_invert_rnn",
    hypothesis: "Prior inverted RNN trial improved a related benchmark task.",
    preprocessing: { actions: [{ type: "none" }] },
    embedding: { type: "invert", dModel: 64 },
    backbone: { type: "rnn", cell: "gru", hiddenDim: 96, numLayers: 2, dropout: 0.1 },
    fusion: { type: "variate_attention" },
    predictionHead: { type: "direct_multi_horizon", outputDistribution: "point" },
    trainingStrategy: {
      loss: { base: "huber", horizonWeighting: "tail_heavy", delta: 1 },
      optimizer: { type: "adamw", lr: 0.0005, weightDecay: 0.01 },
      scheduler: { type: "one_cycle", warmupSteps: 2 },
      regularization: { gradClip: 1 },
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
  interactionMode?: Research.ResearchInteractionMode,
) {
  return runResearch(
    Research.Service.use((svc) =>
      svc.createTask({
        title,
        domainID: "tsf",
        mode,
        interactionMode,
        taskSpec: validTsfTaskSpec(runtime),
        objective: { primaryMetric: "val_avg_mse", direction: "minimize", errorPreferences: "balanced" },
        budget: {
          maxRuns: 12,
          latencyBudget: "no_constraint",
          parameterBudget: "no_constraint",
          loop: { maxIterations: 1, maxNoImprove: 1 },
        },
      }),
    ),
  )
}

// Mock runners explicitly implement the execution protocol before emitting training metrics.
const fakeContractEvents = `
${process.execPath} -e '
const fs = require("fs"), crypto = require("crypto")
const filename = process.env.NEO_CAST_EXECUTION_CONTRACT
if (!filename || !fs.existsSync(filename)) process.exit(0)
const c = JSON.parse(fs.readFileSync(filename))
const canonical = v => Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}" : JSON.stringify(v)
const d = crypto.createHash("sha256").update(canonical(c)).digest("hex")
const manifest = {event:"executed_model_manifest", candidate_id:c.candidate_id, candidate_spec_sha256:c.candidate_spec_sha256, contract_digest:d, actual:c.expected}
console.log(JSON.stringify(manifest))
console.log(JSON.stringify({event:"execution_contract_verified", status:"verified", candidate_id:c.candidate_id, candidate_spec_sha256:c.candidate_spec_sha256, contract_digest:d, manifest}))
'
`

async function writeFakeNeoCastRunner(root: string) {
  await mkdir(path.join(root, "py"), { recursive: true })
  await writeFile(
    path.join(root, "py", "validate.py"),
    `#!/usr/bin/env bash
set -euo pipefail
${fakeContractEvents}
mkdir -p .neo-cast/artifacts/run_fake
cat > .neo-cast/artifacts/run_fake/val_metrics.json <<'JSON'
{"val_avg_mse":0.123,"val_avg_mae":0.456}
JSON
cat > .neo-cast/artifacts/run_fake/model_impl.py <<'PY'
class Model:
    pass
PY
cat > .neo-cast/artifacts/run_fake/inference.py <<'PY'
def predict(rows):
    return rows
PY
printf '{"event":"candidate_resolved"}\\n'
printf '{"event":"smoke_eval_done","val_avg_mse":0.123,"val_avg_mae":0.456}\\n'
printf '{"event":"artifact_ready","run_id":"fake","artifact_dir":"%s"}\\n' "$(pwd)/.neo-cast/artifacts/run_fake"
printf '{"event":"done","status":"success"}\\n'
`,
    "utf8",
  )
}

async function writeTrainingFakeNeoCastRunner(root: string) {
  await mkdir(path.join(root, "py"), { recursive: true })
  await writeFakeNeoCastRunner(root)
  await writeFile(
    path.join(root, "py", "runner.py"),
    `#!/usr/bin/env bash
set -euo pipefail
${fakeContractEvents}
mkdir -p .neo-cast/artifacts/run_train
cp .neo-cast/artifacts/run_fake/model_impl.py .neo-cast/artifacts/run_train/model_impl.py
cp .neo-cast/artifacts/run_fake/inference.py .neo-cast/artifacts/run_train/inference.py
cat > .neo-cast/artifacts/run_train/val_metrics.json <<'JSON'
{"val_avg_mse":0.101,"val_avg_mae":0.303}
JSON
cat > .neo-cast/artifacts/run_train/cv_metrics.json <<'JSON'
{"cv_avg_mse":0.202,"cv_std_mse":0.012,"schema_version":"cv_metrics.v1"}
JSON
printf '{"event":"candidate_resolved"}\\n'
printf '{"event":"eval_done","val_avg_mse":0.101,"val_avg_mae":0.303}\\n'
printf '{"event":"cv_eval_done","cv_avg_mse":0.202,"cv_std_mse":0.012,"val_avg_mse":0.101,"val_avg_mae":0.303}\\n'
printf '{"event":"artifact_ready","run_id":"train","artifact_dir":"%s"}\\n' "$(pwd)/.neo-cast/artifacts/run_train"
printf '{"event":"done","status":"success"}\\n'
`,
    "utf8",
  )
}

async function writeStreamingFakeNeoCastRunner(root: string) {
  await mkdir(path.join(root, "py"), { recursive: true })
  await writeFile(
    path.join(root, "py", "validate.py"),
    `#!/usr/bin/env bash
set -euo pipefail
${fakeContractEvents}
mkdir -p .neo-cast/artifacts/run_streaming
cat > .neo-cast/artifacts/run_streaming/val_metrics.json <<'JSON'
{"val_avg_mse":0.321,"val_avg_mae":0.654}
JSON
printf '{"event":"stage_start","stage":"smoke","candidate_id":"recipe_progress"}\\n'
printf '{"event":"batch_progress","horizon":24,"epoch":1,"batch":50,"elapsed_s":3.2,"cv_fold_index":2}\\n'
printf '{"event":"epoch_end","horizon":24,"epoch":1,"val_loss":0.719233,"cv_fold_index":2}\\n'
printf '{"event":"timeout","elapsed_s":61.4,"budget_s":60}\\n'
printf '{"event":"smoke_eval_done","val_avg_mse":0.321,"val_avg_mae":0.654}\\n'
printf '{"event":"artifact_ready","run_id":"streaming","artifact_dir":"%s"}\\n' "$(pwd)/.neo-cast/artifacts/run_streaming"
printf '{"event":"done","status":"success"}\\n'
`,
    "utf8",
  )
}

async function writeDiscardFakeNeoCastRunner(root: string) {
  await mkdir(path.join(root, "py"), { recursive: true })
  await writeFile(
    path.join(root, "py", "runner.py"),
    `#!/usr/bin/env bash
set -euo pipefail
${fakeContractEvents}
if [[ "\${1:-}" == "init" ]]; then
  mkdir -p .neo-cast
  echo '{"session_id":"test","candidate_counter":0,"crash_streak":0,"no_improve_streak":0,"keep_count":0}' > .neo-cast/runner_state.json
  exit 0
fi
mkdir -p .neo-cast/artifacts/run_discard
cat > .neo-cast/artifacts/run_discard/val_metrics.json <<'JSON'
{"val_avg_mse":0.999,"val_avg_mae":0.888}
JSON
printf '{"event":"candidate_resolved"}\\n'
printf '{"event":"eval_done","val_avg_mse":0.999,"val_avg_mae":0.888}\\n'
printf '{"event":"cv_eval_done","cv_avg_mse":0.777,"cv_std_mse":0.055,"val_avg_mse":0.999,"val_avg_mae":0.888}\\n'
printf '{"event":"artifact_ready","run_id":"discard","artifact_dir":"%s"}\\n' "$(pwd)/.neo-cast/artifacts/run_discard"
printf '{"event":"done","status":"success"}\\n'
exit 1
`,
    "utf8",
  )
}

async function writeCrashAfterSuccessFakeNeoCastRunner(root: string) {
  await mkdir(path.join(root, "py"), { recursive: true })
  await writeFile(
    path.join(root, "py", "runner.py"),
    `#!/usr/bin/env bash
set -euo pipefail
${fakeContractEvents}
if [[ "\${1:-}" == "init" ]]; then
  mkdir -p .neo-cast
  echo '{"session_id":"test","candidate_counter":0,"crash_streak":0,"no_improve_streak":0,"keep_count":0}' > .neo-cast/runner_state.json
  exit 0
fi
printf '{"event":"candidate_resolved"}\\n'
printf '{"event":"done","status":"success"}\\n'
printf '{"event":"stage_start","stage":"full"}\\n'
printf '{"event":"done","status":"crash"}\\n'
exit 1
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
${fakeContractEvents}
printf '{"event":"candidate_resolved"}\\n'
printf '{"event":"runner_error","error_kind":"runner_exit"}\\n'
printf 'runner failed before artifact creation\\n' >&2
exit 7
`,
    "utf8",
  )
}

async function writeMetriclessNeoCastRunner(root: string) {
  await mkdir(path.join(root, "py"), { recursive: true })
  await writeFile(
    path.join(root, "py", "validate.py"),
    `#!/usr/bin/env bash
set -euo pipefail
${fakeContractEvents}
mkdir -p .neo-cast/artifacts/run_metricless
printf '{"event":"candidate_resolved"}\\n'
printf '{"event":"smoke_eval_done"}\\n'
printf '{"event":"artifact_ready","run_id":"metricless","artifact_dir":"%s"}\\n' "$(pwd)/.neo-cast/artifacts/run_metricless"
printf '{"event":"done","status":"success"}\\n'
`,
    "utf8",
  )
}

async function writeNaNNeoCastRunner(root: string) {
  await mkdir(path.join(root, "py"), { recursive: true })
  await writeFile(
    path.join(root, "py", "validate.py"),
    `#!/usr/bin/env bash
set -euo pipefail
${fakeContractEvents}
printf '{"event":"candidate_resolved"}\\n'
printf '{"event":"epoch_end","horizon":24,"epoch":1,"val_loss":NaN}\\n'
printf '{"event":"epoch_end","horizon":24,"epoch":2,"val_loss":NaN}\\n'
printf '{"event":"epoch_end","horizon":24,"epoch":3,"val_loss":NaN}\\n'
`,
    "utf8",
  )
}

async function writePrepareDataNeoCastRunner(root: string) {
  await mkdir(path.join(root, "bin"), { recursive: true })
  await writeFile(
    path.join(root, "bin", "neo-cast.js"),
    `const fs = require("fs")
const path = require("path")
const args = process.argv.slice(2)
if (args[0] !== "prepare-data") process.exit(9)
function value(flag) {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}
const source = value("--source")
const inputLen = Number(value("--input-len") || 96)
const horizons = String(value("--horizons") || "24").split(",").map((item) => Number(item))
const targetColumns = String(value("--target-cols") || value("--feature-cols") || "OT").split(",").filter(Boolean)
const observedPastCovariates = String(value("--observed-past-covariates") || "").split(",").filter(Boolean)
const knownFutureCovariates = String(value("--known-future-covariates") || "").split(",").filter(Boolean)
fs.mkdirSync(".neo-cast/dataset", { recursive: true })
const spec = {
  schema_version: value("--target-cols") ? "dataset.v2" : "dataset.v1",
  source_csv: path.resolve(source),
  task_id: value("--task-id") || "local_csv",
  timestamp_col: "date",
  ...(value("--target-cols") ? {
    target_columns: targetColumns,
    observed_past_covariates: observedPastCovariates,
    known_future_covariates: knownFutureCovariates,
    static_covariates: [],
  } : { feature_columns: targetColumns }),
  input_len: inputLen,
  horizons,
  splits: { train: [0, 100], val: [100, 140], ref_test: [140, 180] },
  normalization: { type: "standard", fit_split: "train" },
  missing: { strategy: "forward_fill", limit: null },
  time: { frequency: "auto", allow_irregular: true, irregular_ratio_warn: 0.01 }
}
fs.writeFileSync(".neo-cast/dataset_spec.json", JSON.stringify(spec, null, 2) + "\\n")
fs.writeFileSync(".neo-cast/dataset/dataset_spec.json", JSON.stringify(spec, null, 2) + "\\n")
console.log(JSON.stringify({ event: "dataset_prepared", source_csv: spec.source_csv, input_len: inputLen, horizons }))
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
${fakeContractEvents}
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

async function createSearchHypothesis(taskID: Research.ResearchTaskID) {
  // Ranking/loop tests deliberately explore multiple architectures. Contract-gate
  // tests use narrow hypotheses instead of this search-policy fixture.
  return addHypothesisToPool(taskID, {
    statement: "Compare the declared architecture families under a shared evaluation protocol.",
    motivation: ["Exercise search ranking and stopping policy."],
    expectedOutcome: "Select the best verified full-run result.",
    suggestedBackbones: ["linear", "mlp", "transformer", "rnn", "dlinear", "tcn", "gated_depthwise_conv", "mixer", "nbeats", "timesnet_lite"],
    suggestedPreprocessing: [],
    priority: "high",
    risk: "Architecture ranking is dataset-dependent.",
    testable: true,
  })
}

async function createCandidate(input: {
  taskID: Research.ResearchTaskID
  parentCandidateID?: Research.ResearchCandidateID
  candidateSpec?: Research.JsonRecord
  rationale?: string
}) {
  const spec = input.candidateSpec ?? validTsfCandidateSpec()
  const hypothesis = await addHypothesisToPool(input.taskID, {
    statement: input.rationale ?? "Test the declared candidate architecture.",
    motivation: ["Service regression fixture"],
    expectedOutcome: "Complete evaluation under the declared protocol.",
    suggestedBackbones: [String((spec.backbone as Record<string, unknown>).type)],
    suggestedPreprocessing: [],
    priority: "medium",
    risk: "Fixture",
    testable: true,
  })
  return runResearch(
    Research.Service.use((svc) =>
      svc.createCandidate({
        taskID: input.taskID,
        hypothesisID: hypothesis.id,
        parentCandidateID: input.parentCandidateID,
        domainID: "tsf",
        candidateSpec: spec,
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
        stage: input.stage ?? (input.status === "succeeded" ? "full" : "smoke"),
        status: input.status,
        metrics: input.metrics,
        resourceUsage: {
          ...(input.status === "succeeded" ? { executionContract: { status: "verified" } } : {}),
          ...input.resourceUsage,
        },
      }),
    ),
  )
}

async function executeFixtureSmoke(taskID: Research.ResearchTaskID, candidateID: Research.ResearchCandidateID) {
  const task = await runResearch(Research.Service.use((svc) => svc.getTask(taskID)))
  const runtime = task.taskSpec.runtime as Record<string, unknown>
  if (typeof runtime.neoCastProjectRoot !== "string") {
    const root = path.join(Instance.directory, "fixture-neo-cast")
    await writeTrainingFakeNeoCastRunner(root)
    await runResearch(Research.Service.use((svc) => svc.updateTaskSpec({
      taskID,
      taskSpec: { ...task.taskSpec, runtime: { ...runtime, neoCastProjectRoot: root, pythonExecutable: "bash" } },
    })))
  } else {
    await writeFakeNeoCastRunner(runtime.neoCastProjectRoot)
  }
  const result = await runResearch(Research.Service.use((svc) => svc.executeRun({ taskID, candidateID, stage: "smoke" })))
  expect(result.run.status).toBe("succeeded")
  expect(result.run.resourceUsage.executionContract).toMatchObject({ status: "verified" })
  return result
}

async function approveIntentCheckpoint(taskID: Research.ResearchTaskID, replyMessage = "Intent requirements confirmed.") {
  const approvals = await runResearch(Research.Service.use((svc) => svc.listApprovals({ taskID })))
  const approval = approvals.find(
    (item) =>
      item.kind === "protocol" &&
      item.status === "pending" &&
      item.reason.includes("[checkpoint:intent_confirmed]"),
  )
  expect(approval).toBeDefined()
  if (!approval) throw new Error(`Missing intent confirmation approval for task: ${taskID}`)
  await runResearch(
    Research.Service.use((svc) =>
      svc.replyApproval({
        approvalID: approval.id,
        status: "approved",
        replyMessage,
      }),
    ),
  )
}

async function runFullPipelineAfterIntentConfirmation(input: {
  taskID: Research.ResearchTaskID
  stage?: Research.ExecutableRunStage
  description?: string
  maxIterations?: number
  targetMetricValue?: number
  outputDir?: string
}) {
  try {
    return await runResearch(Research.Service.use((svc) => svc.runFullPipeline(input)))
  } catch (error) {
    expect(error).toMatchObject({
      name: "ResearchPipelineBlockedError",
      data: {
        taskID: input.taskID,
        reason: "human_checkpoint_required",
        checkpointPhase: "intent_confirmed",
      },
    })
    await approveIntentCheckpoint(input.taskID)
    return await runResearch(Research.Service.use((svc) => svc.runFullPipeline(input)))
  }
}

afterEach(async () => {
  await resetDatabase()
})

describe("Research service", () => {
  test("exposes multi-agent task statuses and export artifact kinds", () => {
    for (const status of ["idle", "intent_gathering", "analyzing", "data_analysis", "hypo_planning", "searching", "publishing"]) {
      expect(Research.ResearchTaskStatus.zod.safeParse(status).success).toBe(true)
    }
    expect(Research.ExportArtifactKind.zod.safeParse("dataset_analysis_report").success).toBe(true)
    expect(Research.ExportArtifactKind.zod.safeParse("model_export_package").success).toBe(true)
  })

  test("stores interaction mode as a first-class task setting", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "Companion TSF session",
              domainID: "tsf",
              mode: "autonomous",
              interactionMode: "companion",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12 },
            }),
          ),
        )

        expect(task.interactionMode).toBe("companion")
        expect(task.mode).toBe("autonomous")
        expect(task.taskSpec).toMatchObject({
          metadata: { interactionMode: "companion" },
        })

        const [listed] = await runResearch(Research.Service.use((svc) => svc.listTasks({ domainID: "tsf" })))
        expect(listed).toMatchObject({
          id: task.id,
          interactionMode: "companion",
          mode: "autonomous",
        })
      },
    })
  })

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
        expect(task.status).toBe("idle")

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

        await expect(runResearch(Research.Service.use((svc) => svc.setChampion({
          taskID: task.id, candidateID: candidate.id, runID: run.id, primaryMetric: 0.42, utility: 0.7,
        })))).rejects.toThrow("full")
        const fullRun = await createRun({
          taskID: task.id, candidateID: candidate.id, status: "succeeded",
          metrics: { val_avg_mse: 0.42 },
        })
        const champion = await runResearch(
          Research.Service.use((svc) =>
            svc.setChampion({
              taskID: task.id,
              candidateID: candidate.id,
              runID: fullRun.id,
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
        const artifacts = await runResearch(Research.Service.use((svc) => svc.listArtifacts(task.id)))
        const analysisArtifacts = artifacts.filter((artifact) => artifact.runID === result.run.id)
        expect(analysisArtifacts.map((artifact) => artifact.kind).sort()).toEqual([
          "dataset_analysis_plot_png",
          "dataset_analysis_plot_png",
          "dataset_analysis_plot_png",
          "dataset_analysis_plot_png",
          "dataset_analysis_report",
          "dataset_main_analysis_markdown",
          "dataset_qualitative_analysis_markdown",
          "dataset_quantitative_analysis_json",
          "dataset_quantitative_analysis_markdown",
          "task_profile_json",
        ])
        expect(result.run.artifactRefs).toEqual(expect.arrayContaining(analysisArtifacts.map((artifact) => artifact.id)))
        const mainSummary = analysisArtifacts.find((artifact) => artifact.kind === "dataset_main_analysis_markdown")
        expect(mainSummary).toBeDefined()
        const summaryPath = mainSummary!.uri.replace(/^file:\/\//, "")
        expect(summaryPath).toContain(path.join(".neo-research", "artifact-versions", task.id))
        expect(String(mainSummary!.metadata.sourceURI)).toEndWith("/analysis/main_agent_summary.md")
        const summary = await readFile(summaryPath, "utf8")
        expect(summary).toContain("# Main Agent Data Analysis Summary")
        expect(summary).toContain("Quantitative sub-agent")
        expect(summary).toContain("Qualitative sub-agent")
        expect(summary).toContain("cross-variate")
        const quantitative = analysisArtifacts.find((artifact) => artifact.kind === "dataset_quantitative_analysis_markdown")
        const quantitativeJSON = analysisArtifacts.find((artifact) => artifact.kind === "dataset_quantitative_analysis_json")
        const qualitative = analysisArtifacts.find((artifact) => artifact.kind === "dataset_qualitative_analysis_markdown")
        expect(String(quantitative?.metadata.sourceURI)).toEndWith(
          path.join(".neo-research", "sessions", task.id, "analysis", "quantitative_analysis.md"),
        )
        expect(String(quantitativeJSON?.metadata.sourceURI)).toEndWith(
          path.join(".neo-research", "sessions", task.id, "analysis", "quantitative_analysis.json"),
        )
        const quantitativeValue = JSON.parse(await readFile(quantitativeJSON!.uri.replace(/^file:\/\//, ""), "utf8"))
        expect(quantitativeValue.schemaVersion).toBe("dataset_quantitative_analysis_v1")
        expect(quantitativeValue.statistics.frequency.spectralPeaks).toBeArray()
        expect(String(qualitative?.metadata.sourceURI)).toEndWith(
          path.join(".neo-research", "sessions", task.id, "analysis", "qualitative_analysis.md"),
        )
        const unifiedReport = analysisArtifacts.find((artifact) => artifact.kind === "dataset_analysis_report")
        expect(unifiedReport).toBeDefined()
        expect(String(unifiedReport!.metadata.sourceURI)).toEndWith(
          path.join(".neo-research", "sessions", task.id, "analysis", "data_analysis_summary.md"),
        )
        const unified = await readFile(unifiedReport!.uri.replace(/^file:\/\//, ""), "utf8")
        expect(unified).toContain("# Dataset Analysis Report")
        expect(unified).toContain("## Search Handoff")
        expect(unified).toContain("# Quantitative Sub-Agent Data Analysis")
        expect(unified).toContain("# Qualitative Sub-Agent Data Analysis")
        expect(unified).toContain("# Main Agent Data Analysis Summary")
        expect(unified).toContain("ACF main period")
        expect(unified).toContain("KPSS statistic")
        expect(unified).toContain("PACF top lag")
        expect(unified).toContain("STL-style decomposition")
        expect(unified).toContain("Dominant frequency period")
        expect(unified).toContain("Change point")
        expect(unified).toContain("Cross-lag")
        expect(unified).toContain("领域解读")
        expect(unified).toContain("![Time series overview](quantitative/plots/time-series-overview.png)")
        expect(unified).toContain("ADF stationarity")
        expect(unified).toContain("## Correlation Matrix")
        const plotArtifacts = analysisArtifacts.filter((artifact) => artifact.kind === "dataset_analysis_plot_png")
        expect(plotArtifacts.map((artifact) => artifact.metadata.plotType).sort()).toEqual([
          "acf_pacf",
          "cross_lag",
          "stl_decomposition",
          "time_series_overview",
        ])
        expect(plotArtifacts.map((artifact) => artifact.metadata.sourceURI).join("\n")).toContain(
          path.join(".neo-research", "sessions", task.id, "analysis", "quantitative", "plots"),
        )
        const firstPlotBytes = await readFile(plotArtifacts[0]!.uri.replace(/^file:\/\//, ""))
        expect([...firstPlotBytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
      },
    })
  })

  test("runs the service-level multi-agent pipeline and publishes an export package", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const datasetPath = await writeProfileDataset()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeTrainingFakeNeoCastRunner(fakeNeoCastRoot)
        const task = await createTSFTask(
          "pipeline autonomous task",
          {
            bridgeOnly: true,
            neoCastProjectRoot: fakeNeoCastRoot,
            pythonExecutable: "bash",
            datasetPath,
          },
          "autonomous",
        )

        const result = await runFullPipelineAfterIntentConfirmation({
          taskID: task.id,
          stage: "full",
          description: "pipeline smoke",
          maxIterations: 1,
          targetMetricValue: 0.2,
          outputDir: ".neo-research/pipeline",
        })

        expect(result.intent.taskID).toBe(task.id)
        expect(result.intent.missingFields).toEqual([])
        expect(result.dataAnalysis.artifact.kind).toBe("dataset_analysis_report")
        expect(result.hypoPlanning.agent).toBe("HypoPlannerAgent")
        expect(result.hypoPlanning.plan.hypotheses.length).toBeGreaterThan(0)
        expect(result.nas.loop.stoppedReason).toBe("target_reached")
        expect(result.nas.loop.iterations).toHaveLength(1)
        expect(result.publish.artifact.kind).toBe("model_export_package")
        const manifest = JSON.parse(await readFile(path.join(result.publish.path, "manifest.json"), "utf8"))
        expect(manifest.schemaVersion).toBe("neo_research_model_export_package.v1")
        expect(manifest.files.modelPy).toBe("model/model.py")
        expect(manifest.files.finalReport).toBe("reports/final_report.md")
        expect(manifest.files.releasePackage).toBe("artifacts/release_package.md")
        expect(manifest.files.searchSpace).toBe("configs/search_space.yaml")
        expect(manifest.files.leaderboard).toBe("experiments/leaderboard.md")
        const events = await readFile(path.join(result.publish.path, "trace", "logs", "events.jsonl"), "utf8")
        expect(events).toContain("research.phase.started")
        expect(events).toContain("research.phase.completed")
        expect(existsSync(path.join(result.publish.path, "trace", "artifact-versions"))).toBe(true)
        expect(manifest.integrity.status).toBe("complete")
        expect(await readFile(path.join(result.publish.path, "reports", "final_report.md"), "utf8")).toContain(
          "# Final Research Report: pipeline autonomous task",
        )
        expect(await readFile(path.join(result.publish.path, "artifacts", "release_package.md"), "utf8")).toContain(
          "## Release Integrity",
        )

        const finalTask = await runResearch(Research.Service.use((svc) => svc.getTask(task.id)))
        expect(finalTask.status).toBe("completed")
        const artifacts = await runResearch(Research.Service.use((svc) => svc.listArtifacts(task.id)))
        expect(artifacts.map((artifact) => artifact.kind)).toEqual(
          expect.arrayContaining([
            "dataset_analysis_report",
            "hypo_plan_md",
            "hypotheses_yaml",
            "research_autonomous_loop_json",
            "model_export_package",
          ]),
        )
        expect((finalTask.taskSpec.metadata as Record<string, unknown>).baselineStrategy).toBeDefined()
      },
    })
  })

  test("reruns a completed pipeline from persisted workflow without recomputing completed stages", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const datasetPath = await writeProfileDataset()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeTrainingFakeNeoCastRunner(fakeNeoCastRoot)
        const task = await createTSFTask(
          "pipeline resume autonomous task",
          {
            bridgeOnly: true,
            neoCastProjectRoot: fakeNeoCastRoot,
            pythonExecutable: "bash",
            datasetPath,
          },
          "autonomous",
        )

        const firstRun = await runFullPipelineAfterIntentConfirmation({
          taskID: task.id,
          stage: "full",
          description: "pipeline smoke",
          maxIterations: 1,
          targetMetricValue: 0.2,
          outputDir: ".neo-research/pipeline",
        })

        const firstArtifacts = await runResearch(Research.Service.use((svc) => svc.listArtifacts(task.id)))
        const firstDataReport = firstArtifacts.find((artifact) => artifact.kind === "dataset_analysis_report")
        const firstHypoPlan = firstArtifacts.find((artifact) => artifact.kind === "hypo_plan_md")
        expect(firstDataReport).toBeDefined()
        expect(firstHypoPlan).toBeDefined()
        if (firstDataReport === undefined || firstHypoPlan === undefined) {
          return
        }
        const firstPublishedPath = firstRun.publish.artifact.uri
        const runsBeforeReplay = await runResearch(Research.Service.use((svc) => svc.listRuns(task.id)))

        const secondRun = await runResearchWithBus(
          Effect.gen(function* () {
            const bus = yield* Bus.Service
            const svc = yield* Research.Service
            const events = {
              dataAnalysisStarted: 0,
              hypoPlannerStarted: 0,
              nasStarted: 0,
              reflectionStarted: 0,
              publishStarted: 0,
            }
            const unsubscribeData = yield* bus.subscribeCallback(Research.Event.DataAnalysisAgentStarted, (event) => {
              if (event.properties.taskID === task.id) events.dataAnalysisStarted += 1
            })
            const unsubscribeHypo = yield* bus.subscribeCallback(Research.Event.HypoPlannerAgentStarted, (event) => {
              if (event.properties.taskID === task.id) events.hypoPlannerStarted += 1
            })
            const unsubscribeNAS = yield* bus.subscribeCallback(Research.Event.NASAgentStarted, (event) => {
              if (event.properties.taskID === task.id) events.nasStarted += 1
            })
            const unsubscribeReflection = yield* bus.subscribeCallback(Research.Event.ReflectionAgentStarted, (event) => {
              if (event.properties.taskID === task.id) events.reflectionStarted += 1
            })
            const unsubscribePublish = yield* bus.subscribeCallback(Research.Event.PublishAgentStarted, (event) => {
              if (event.properties.taskID === task.id) events.publishStarted += 1
            })

            const result = yield* svc.runFullPipeline({
              taskID: task.id,
              stage: "full",
              description: "pipeline smoke",
              maxIterations: 1,
          targetMetricValue: 0.2,
              outputDir: ".neo-research/pipeline",
            })

            unsubscribeData()
            unsubscribeHypo()
            unsubscribeNAS()
            unsubscribeReflection()
            unsubscribePublish()
            return { result, events }
          }),
        )

        expect(secondRun.events.dataAnalysisStarted).toBe(0)
        expect(secondRun.events.hypoPlannerStarted).toBe(0)
        expect(secondRun.events.nasStarted).toBe(0)
        expect(secondRun.events.reflectionStarted).toBe(0)
        expect(secondRun.events.publishStarted).toBe(0)
        expect(secondRun.result.dataAnalysis.artifact.id).toBe(firstDataReport.id)
        expect(secondRun.result.hypoPlanning.planMarkdown).toContain("# Hypothesis Plan")
        expect(secondRun.result.publish.artifact.uri).toBe(firstPublishedPath)
        const runsAfterReplay = await runResearch(Research.Service.use((svc) => svc.listRuns(task.id)))
        expect(runsAfterReplay.length).toBe(runsBeforeReplay.length)
      },
    })
  })

  test("re-running after spec update clears workflow progress and requires an explicit new cycle", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const datasetPath = await writeProfileDataset()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeTrainingFakeNeoCastRunner(fakeNeoCastRoot)
        const task = await createTSFTask(
          "pipeline spec change task",
          {
            bridgeOnly: true,
            neoCastProjectRoot: fakeNeoCastRoot,
            pythonExecutable: "bash",
            datasetPath,
          },
          "autonomous",
        )

        await runFullPipelineAfterIntentConfirmation({
          taskID: task.id,
          stage: "full",
          description: "pipeline smoke",
          maxIterations: 1,
          targetMetricValue: 0.2,
          outputDir: ".neo-research/pipeline",
        })

        await runResearch(
          Research.Service.use((svc) =>
            svc.updateTaskSpec({
              taskID: task.id,
              taskSpec: {
                ...validTsfTaskSpec({
                  bridgeOnly: true,
                  neoCastProjectRoot: fakeNeoCastRoot,
                  pythonExecutable: "bash",
                  datasetPath,
                }),
                predictionLengths: [48],
                metadata: {
                  ...(validTsfTaskSpec({
                    bridgeOnly: true,
                    neoCastProjectRoot: fakeNeoCastRoot,
                    pythonExecutable: "bash",
                    datasetPath,
                  }).metadata as Record<string, unknown>),
                  workflowNote: "rerun",
                },
              },
            }),
          ),
        )

        const clearedTask = await runResearch(Research.Service.use((svc) => svc.getTask(task.id)))
        const clearedTaskMetadata = clearedTask.taskSpec.metadata as Record<string, unknown>
        expect(clearedTaskMetadata.workflow).toBeUndefined()

        const runsBeforeUpdate = await runResearch(Research.Service.use((svc) => svc.listRuns(task.id)))

        const blockedReplay = await runResearchWithBus(
          Effect.gen(function* () {
            const bus = yield* Bus.Service
            const svc = yield* Research.Service
            let dataAnalysisStarted = 0
            let nasStarted = 0
            let reflectionStarted = 0
            let publishStarted = 0
            const unsubscribeData = yield* bus.subscribeCallback(Research.Event.DataAnalysisAgentStarted, () => dataAnalysisStarted += 1)
            const unsubscribeNAS = yield* bus.subscribeCallback(Research.Event.NASAgentStarted, () => nasStarted += 1)
            const unsubscribeReflection = yield* bus.subscribeCallback(Research.Event.ReflectionAgentStarted, () => reflectionStarted += 1)
            const unsubscribePublish = yield* bus.subscribeCallback(Research.Event.PublishAgentStarted, () => publishStarted += 1)
            const error = yield* svc
              .runFullPipeline({
                taskID: task.id,
                stage: "full",
                description: "pipeline smoke",
                maxIterations: 1,
          targetMetricValue: 0.2,
                outputDir: ".neo-research/pipeline",
              })
              .pipe(
                Effect.as(undefined),
                Effect.catchCause((cause) => Effect.succeed(Cause.squash(cause))),
              )
            unsubscribeData()
            unsubscribeNAS()
            unsubscribeReflection()
            unsubscribePublish()
            return {
              error,
              events: { dataAnalysisStarted, nasStarted, reflectionStarted, publishStarted },
            }
          }),
        )

        // A changed task contract requires renewed intent confirmation.
        expect(blockedReplay.error).toMatchObject({
          name: "ResearchPipelineBlockedError",
          data: { reason: "human_checkpoint_required", checkpointPhase: "intent_confirmed" },
        })
        expect(Object.values(blockedReplay.events)).toEqual([0, 0, 0, 0])
        await approveIntentCheckpoint(task.id)
        const { createResearchCycle, resumeState } = await import("../../src/research/recovery")
        const state = resumeState(Instance.project.id, task.id)!
        expect(createResearchCycle(Instance.project.id, task.id, {
          expectedRevision: state.revision, requestKey: "updated-spec-cycle", maxIterations: 1, maxRuns: 5,
        }).status).toBe(200)
        await runFullPipelineAfterIntentConfirmation({
          taskID: task.id, stage: "full", maxIterations: 1, targetMetricValue: 0.2,
          outputDir: ".neo-research/pipeline",
        })
        const runsAfterUpdate = await runResearch(Research.Service.use((svc) => svc.listRuns(task.id)))
        expect(runsAfterUpdate.length).toBeGreaterThan(runsBeforeUpdate.length)
      },
    })
  })

  test("pauses the pipeline when intent clarification is required", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeTrainingFakeNeoCastRunner(fakeNeoCastRoot)
        const task = await createTSFTask(
          "pipeline missing intent task",
          {
            bridgeOnly: true,
            neoCastProjectRoot: fakeNeoCastRoot,
            pythonExecutable: "bash",
          },
          "autonomous",
        )

        await expect(
          runResearch(
            Research.Service.use((svc) =>
              svc.runFullPipeline({
                taskID: task.id,
                stage: "smoke",
                maxIterations: 1,
              }),
            ),
          ),
        ).rejects.toMatchObject({
          name: "ResearchPipelineBlockedError",
          data: {
            taskID: task.id,
            reason: "intent_clarification_required",
            missingFields: ["dataset.path"],
          },
        })

        const blocked = await runResearch(Research.Service.use((svc) => svc.getTask(task.id)))
        expect(blocked.status).toBe("paused")
        const approvals = await runResearch(Research.Service.use((svc) => svc.listApprovals({ taskID: task.id })))
        expect(approvals.find((approval) => approval.kind === "protocol")).toMatchObject({
          status: "pending",
          reason: expect.stringContaining("CSV 数据集路径"),
        })
        expect(await runResearch(Research.Service.use((svc) => svc.listRuns(task.id)))).toHaveLength(0)
      },
    })
  })

  test("pauses the pipeline before Data Analysis until the intent checkpoint is confirmed", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const datasetPath = await writeProfileDataset()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeFakeNeoCastRunner(fakeNeoCastRoot)
        const task = await createTSFTask(
          "intent confirmation gate task",
          {
            bridgeOnly: true,
            neoCastProjectRoot: fakeNeoCastRoot,
            pythonExecutable: "bash",
            datasetPath,
          },
          "autonomous",
          "companion",
        )

        const blocked = await runResearchWithBus(
          Effect.gen(function* () {
            const bus = yield* Bus.Service
            const svc = yield* Research.Service
            let dataAnalysisStarted = 0
            let hypoPlannerStarted = 0
            const unsubscribeData = yield* bus.subscribeCallback(Research.Event.DataAnalysisAgentStarted, (event) => {
              if (event.properties.taskID === task.id) dataAnalysisStarted += 1
            })
            const unsubscribeHypo = yield* bus.subscribeCallback(Research.Event.HypoPlannerAgentStarted, (event) => {
              if (event.properties.taskID === task.id) hypoPlannerStarted += 1
            })
            const error = yield* svc
              .runFullPipeline({
                taskID: task.id,
                stage: "smoke",
                maxIterations: 1,
                outputDir: ".neo-research/pipeline",
              })
              .pipe(
                Effect.as(undefined),
                Effect.catchCause((cause) => Effect.succeed(Cause.squash(cause))),
              )
            unsubscribeData()
            unsubscribeHypo()
            return { error, dataAnalysisStarted, hypoPlannerStarted }
          }),
        )

        expect(blocked.error).toMatchObject({
          name: "ResearchPipelineBlockedError",
          data: {
            taskID: task.id,
            reason: "human_checkpoint_required",
            checkpointPhase: "intent_confirmed",
          },
        })
        expect(blocked.dataAnalysisStarted).toBe(0)
        expect(blocked.hypoPlannerStarted).toBe(0)

        const artifactsBeforeApproval = await runResearch(Research.Service.use((svc) => svc.listArtifacts(task.id)))
        expect(artifactsBeforeApproval.find((artifact) => artifact.kind === "dataset_analysis_report")).toBeUndefined()
        expect(artifactsBeforeApproval.find((artifact) => artifact.kind === "hypo_plan_md")).toBeUndefined()

        const approvals = await runResearch(Research.Service.use((svc) => svc.listApprovals({ taskID: task.id })))
        expect(approvals.find((approval) => approval.kind === "protocol")).toMatchObject({
          status: "pending",
          reason: expect.stringContaining("[checkpoint:intent_confirmed]"),
        })
      },
    })
  })

  test("Socratic pipeline pauses at intent checkpoint before DataAnalysis (mirrors Companion behaviour)", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const datasetPath = await writeProfileDataset()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeTrainingFakeNeoCastRunner(fakeNeoCastRoot)
        const task = await createTSFTask(
          "socratic autonomous pipeline task",
          {
            bridgeOnly: true,
            neoCastProjectRoot: fakeNeoCastRoot,
            pythonExecutable: "bash",
            datasetPath,
          },
          "autonomous",
        )

        const run = await runResearchWithBus(
          Effect.gen(function* () {
            const bus = yield* Bus.Service
            const svc = yield* Research.Service
            let dataAnalysisStarted = 0
            let hypoPlannerStarted = 0
            const unsubscribeData = yield* bus.subscribeCallback(Research.Event.DataAnalysisAgentStarted, (event) => {
              if (event.properties.taskID === task.id) dataAnalysisStarted += 1
            })
            const unsubscribeHypo = yield* bus.subscribeCallback(Research.Event.HypoPlannerAgentStarted, (event) => {
              if (event.properties.taskID === task.id) hypoPlannerStarted += 1
            })
            const error = yield* svc
              .runFullPipeline({
                taskID: task.id,
                stage: "full",
                maxIterations: 1,
                targetMetricValue: 0.2,
                outputDir: ".neo-research/pipeline",
              })
              .pipe(
                Effect.as(undefined),
                Effect.catchCause((cause) => Effect.succeed(Cause.squash(cause))),
              )
            unsubscribeData()
            unsubscribeHypo()
            return { error, dataAnalysisStarted, hypoPlannerStarted }
          }),
        )

        // Socratic mode now blocks at intent_confirmed (same as Companion) — pipeline must not proceed.
        expect(run.error).toMatchObject({ name: "ResearchPipelineBlockedError" })
        expect(run.dataAnalysisStarted).toBe(0)
        expect(run.hypoPlannerStarted).toBe(0)

        // A pending intent_confirmed approval must exist for Socratic mode.
        const approvals = await runResearch(Research.Service.use((svc) => svc.listApprovals({ taskID: task.id })))
        expect(approvals.find((a) => a.reason.includes("[checkpoint:intent_confirmed]") && a.status === "pending")).toBeDefined()

        // Socratic mode auto-confirms the search-space and final-model checkpoints.
        await approveIntentCheckpoint(task.id)
        const result = await runResearch(Research.Service.use((svc) => svc.runFullPipeline({
          taskID: task.id, stage: "full",
          outputDir: ".neo-research/pipeline",
        })))
        expect(result.nas.loop.stoppedReason).toBe("max_iterations")
        expect(result.nas.iterationCount).toBe(1)
        expect(result.publish.artifact.kind).toBe("model_export_package")
        const artifacts = await runResearch(Research.Service.use((svc) => svc.listArtifacts(task.id)))
        expect(artifacts.find((artifact) => artifact.kind === "hypo_plan_md")).toBeDefined()
        const approvalsAfter = await runResearch(Research.Service.use((svc) => svc.listApprovals({ taskID: task.id })))
        expect(approvalsAfter.filter((a) => a.status === "pending")).toHaveLength(0)
      },
    })
  }, 60_000)

  test("pauses companion pipeline in Intent until requirements are confirmed", async () => {
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
              title: "companion requirements gate task",
              domainID: "tsf",
              mode: "review",
              interactionMode: "companion",
              taskSpec: validTsfTaskSpec({
                bridgeOnly: true,
                neoCastProjectRoot: fakeNeoCastRoot,
                pythonExecutable: "bash",
                datasetPath,
              }),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize", errorPreferences: "balanced" },
              budget: { maxRuns: 12, latencyBudget: "no_constraint", parameterBudget: "no_constraint", loop: { maxIterations: 1, maxNoImprove: 1 } },
            }),
          ),
        )

        await expect(
          runResearch(
            Research.Service.use((svc) =>
              svc.runFullPipeline({
                taskID: task.id,
                stage: "smoke",
                maxIterations: 1,
                outputDir: ".neo-research/pipeline",
              }),
            ),
          ),
        ).rejects.toMatchObject({
          name: "ResearchPipelineBlockedError",
          data: {
            taskID: task.id,
            reason: "human_checkpoint_required",
            checkpointPhase: "intent_confirmed",
          },
        })

        const artifactsBeforeApproval = await runResearch(Research.Service.use((svc) => svc.listArtifacts(task.id)))
        expect(artifactsBeforeApproval.find((artifact) => artifact.kind === "dataset_analysis_report")).toBeUndefined()
        expect(artifactsBeforeApproval.find((artifact) => artifact.kind === "hypo_plan_md")).toBeUndefined()

        const approvals = await runResearch(Research.Service.use((svc) => svc.listApprovals({ taskID: task.id })))
        const intentApproval = approvals.find((approval) =>
          approval.kind === "protocol" && approval.reason.includes("[checkpoint:intent_confirmed]"),
        )
        expect(intentApproval?.status).toBe("pending")
        if (!intentApproval) return

        await runResearch(
          Research.Service.use((svc) =>
            svc.replyApproval({
              approvalID: intentApproval.id,
              status: "approved",
              replyMessage: "Companion requirements confirmed.",
            }),
          ),
        )

        await expect(
          runResearch(
            Research.Service.use((svc) =>
              svc.runFullPipeline({
                taskID: task.id,
                stage: "smoke",
                maxIterations: 1,
                outputDir: ".neo-research/pipeline",
              }),
            ),
          ),
        ).rejects.toMatchObject({
          name: "ResearchPipelineBlockedError",
          data: {
            taskID: task.id,
            reason: "human_checkpoint_required",
            checkpointPhase: "search_space_confirmed",
          },
        })

        const artifactsAfterApproval = await runResearch(Research.Service.use((svc) => svc.listArtifacts(task.id)))
        expect(artifactsAfterApproval.find((artifact) => artifact.kind === "hypo_plan_md")).toBeDefined()
        const beforeReject = await runResearch(Research.Service.use((svc) => svc.listApprovals({ taskID: task.id })))
        const searchApproval = beforeReject.find((a) => a.status === "pending" && a.reason.includes("[checkpoint:search_space_confirmed]"))!
        await runResearch(Research.Service.use((svc) => svc.replyApproval({ approvalID: searchApproval.id, status: "rejected" })))
        await expect(runResearch(Research.Service.use((svc) => svc.runFullPipeline({ taskID: task.id, stage: "smoke", maxIterations: 1 })))).rejects.toMatchObject({
          data: { reason: "human_checkpoint_rejected", checkpointPhase: "search_space_confirmed" },
        })
        const afterReject = await runResearch(Research.Service.use((svc) => svc.listApprovals({ taskID: task.id })))
        expect(afterReject.filter((a) => a.status === "pending" && a.reason.includes("[checkpoint:search_space_confirmed]"))).toHaveLength(0)
        expect(afterReject.filter((a) => a.reason.includes("[checkpoint:search_space_confirmed]"))).toHaveLength(1)
      },
    })
  })

  test("companion rejected budget accepts existing results and rejected final/release checkpoints never publish", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const datasetPath = await writeProfileDataset()
    await Instance.provide({ directory: tmp.path, fn: async () => {
      const root = path.join(tmp.path, "runner")
      await writeTrainingFakeNeoCastRunner(root)
      const task = await runResearch(Research.Service.use((svc) => svc.createTask({
        title: "Companion rejection lifecycle", domainID: "tsf", mode: "autonomous", interactionMode: "companion",
        taskSpec: validTsfTaskSpec({ bridgeOnly: true, neoCastProjectRoot: root, pythonExecutable: "bash", datasetPath }),
        objective: { primaryMetric: "val_avg_mse", direction: "minimize", errorPreferences: "balanced" },
        budget: { maxRuns: 12, latencyBudget: "no_constraint", parameterBudget: "no_constraint", loop: { maxIterations: 1, maxNoImprove: 1 } },
      })))
      const advance = () => runResearch(Research.Service.use((svc) => svc.runFullPipeline({ taskID: task.id, stage: "full", maxIterations: 1 })))
      const checkpoint = async (phase: string, status: "approved" | "rejected") => {
        const approvals = await runResearch(Research.Service.use((svc) => svc.listApprovals({ taskID: task.id })))
        const approval = approvals.find((item) => item.reason.includes(`[checkpoint:${phase}]`))
        expect(approval).toBeDefined()
        await runResearch(Research.Service.use((svc) => svc.replyApproval({ approvalID: approval!.id, status })))
        return approval!.id
      }
      const blocked = (phase: string, rejected = false) => expect(advance()).rejects.toMatchObject({
        data: { checkpointPhase: phase, reason: rejected ? "human_checkpoint_rejected" : "human_checkpoint_required" },
      })
      await blocked("intent_confirmed")
      await checkpoint("intent_confirmed", "approved")
      await blocked("search_space_confirmed")
      await checkpoint("search_space_confirmed", "approved")
      await blocked("experiment_budget_extended")
      const runsBefore = await runResearch(Research.Service.use((svc) => svc.listRuns(task.id)))
      await checkpoint("experiment_budget_extended", "rejected")
      await blocked("final_model_selection")
      await checkpoint("final_model_selection", "rejected")
      await blocked("final_model_selection", true)
      expect(await runResearch(Research.Service.use((svc) => svc.listRuns(task.id)))).toHaveLength(runsBefore.length)
      await checkpoint("final_model_selection", "approved")
      // Some outcomes legitimately request an additional reflection review.
      const next = await advance().catch((error) => error)
      if (next.data?.checkpointPhase === "reflection_review") {
        await checkpoint("reflection_review", "approved")
        await blocked("report_release")
      } else expect(next.data?.checkpointPhase).toBe("report_release")
      await checkpoint("report_release", "rejected")
      await blocked("report_release", true)
      const artifacts = await runResearch(Research.Service.use((svc) => svc.listArtifacts(task.id)))
      expect(artifacts.some((item) => item.kind === "model_export_package")).toBe(false)
      await checkpoint("report_release", "approved")
      const completed = await advance()
      expect(completed.task.status).toBe("completed")
      expect(completed.publish.artifact.kind).toBe("model_export_package")
    } })
  }, 30000)

  test("blocks full pipeline execution for review companion tasks before agent work starts", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const datasetPath = await writeProfileDataset()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeFakeNeoCastRunner(fakeNeoCastRoot)
        const task = await createTSFTask(
          "pipeline review task",
          {
            bridgeOnly: true,
            neoCastProjectRoot: fakeNeoCastRoot,
            pythonExecutable: "bash",
            datasetPath,
          },
          "review",
        )

        await expect(
          runResearch(
            Research.Service.use((svc) =>
              svc.runFullPipeline({
                taskID: task.id,
                stage: "smoke",
                maxIterations: 1,
              }),
            ),
          ),
        ).rejects.toMatchObject({
          name: "ResearchPipelineBlockedError",
          data: {
            taskID: task.id,
            reason: "pipeline_requires_autonomous",
          },
        })

        const blocked = await runResearch(Research.Service.use((svc) => svc.getTask(task.id)))
        expect(blocked.status).toBe("idle")
        expect(await runResearch(Research.Service.use((svc) => svc.listRuns(task.id)))).toHaveLength(0)
      },
    })
  })

  test("marks agent failures and publishes a failed stage event", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTSFTask("failed NAS agent review task")
        const events = await runResearchWithBus(
          Effect.gen(function* () {
            const bus = yield* Bus.Service
            const svc = yield* Research.Service
            const received: Array<{ readonly status: string; readonly metadata?: Research.JsonRecord }> = []
            const unsubscribe = yield* bus.subscribeCallback(Research.Event.NASAgentFailed, (event) => {
              if (event.properties.taskID === task.id) {
                received.push({ status: event.properties.status, metadata: event.properties.metadata })
              }
            })
            const error = yield* svc
              .runNASAgent({
                taskID: task.id,
                stage: "smoke",
                maxIterations: 1,
              })
              .pipe(
                Effect.as(undefined),
                Effect.catchCause((cause) => Effect.succeed(Cause.squash(cause))),
              )
            yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)))
            unsubscribe()
            expect(error).toBeInstanceOf(Error)
            expect(error instanceof Error ? error.message : String(error)).toContain("Research task is not autonomous")
            return received
          }),
        )

        const failed = await runResearch(Research.Service.use((svc) => svc.getTask(task.id)))
        expect(failed.status).toBe("failed")
        expect(events).toEqual([
          {
            status: "failed",
            metadata: expect.objectContaining({
              error: expect.stringContaining("Research task is not autonomous"),
            }),
          },
        ])
      },
    })
  })

  test("task bindings survive spec replacement and reject reusing another task's root session", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await Instance.provide({ directory: tmp.path, fn: async () => {
      const create = (modelID: string) => runResearch(Research.Service.use((svc) => svc.createTask({
        title: modelID, domainID: "tsf", mode: "review",
        taskSpec: { ...validTsfTaskSpec(), metadata: { sessionModel: { providerID: "deepseek", modelID } } },
        objective: {}, budget: {},
      })))
      const first = await create("model-a")
      const second = await create("model-b")
      const updated = await runResearch(Research.Service.use((svc) => svc.updateTaskSpec({
        taskID: first.id, taskSpec: validTsfTaskSpec(),
      })))
      expect(updated.taskSpec.metadata).toMatchObject({
        executionIsolation: "task", sessionModel: { modelID: "model-a" },
      })
      expect(second.taskSpec.metadata).toMatchObject({ sessionModel: { modelID: "model-b" } })
      await expect(runResearch(Research.Service.use((svc) => svc.createTask({
        title: "Duplicate root", sessionID: first.sessionID, domainID: "tsf", mode: "review",
        taskSpec: validTsfTaskSpec(), objective: {}, budget: {},
      })))).rejects.toThrow("already belongs")
      const candidate = await createCandidate({ taskID: first.id })
      const prepared = await runResearch(Research.Service.use((svc) => svc.prepareRun({
        taskID: first.id, candidateID: candidate.id, stage: "smoke",
      })))
      expect(prepared.runPlan.command.cwd).toBe(path.join(tmp.path, ".neo-research", "workspaces", first.id))
      expect(prepared.runPlan.command.env?.NEO_CAST_PROJECT_ROOT).toBe(prepared.runPlan.command.cwd)
    } })
  })

  test("prepares the Neo-Cast dataset for a task and persists the dataset contract artifact", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const datasetPath = await writeProfileDataset()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writePrepareDataNeoCastRunner(fakeNeoCastRoot)
        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "Prepare dataset contract",
              domainID: "tsf",
              mode: "autonomous",
              taskSpec: {
                ...validTsfTaskSpec({
                  bridgeOnly: true,
                  neoCastProjectRoot: fakeNeoCastRoot,
                }),
                contextLength: 12,
                predictionLengths: [8],
                dataset: {
                  loaderID: "local_csv",
                  path: datasetPath,
                  targetCols: ["a", "b"],
                },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12 },
            }),
          ),
        )

        const prepared = await runResearch(Research.Service.use((svc) => svc.prepareTaskDataset({ taskID: task.id })))

        expect(prepared.artifact.kind).toBe("dataset_preparation_json")
        expect(prepared.datasetSpec).toMatchObject({
          source_csv: path.resolve(datasetPath),
          input_len: 12,
          horizons: [8],
          schema_version: "dataset.v2",
          target_columns: ["a", "b"],
        })
        const payload = JSON.parse(await readFile(prepared.path, "utf8"))
        expect(payload.command.args).toContain("--source")
        expect(payload.command.args.slice(payload.command.args.indexOf("--train-rows"), payload.command.args.indexOf("--train-rows") + 2)).toEqual(["--train-rows", "0:67"])
        expect(payload.command.args.slice(payload.command.args.indexOf("--val-rows"), payload.command.args.indexOf("--val-rows") + 2)).toEqual(["--val-rows", "67:76"])
        expect(payload.command.args.slice(payload.command.args.indexOf("--ref-test-rows"), payload.command.args.indexOf("--ref-test-rows") + 2)).toEqual(["--ref-test-rows", "76:96"])
        expect(payload.datasetSpec.source_csv).toBe(path.resolve(datasetPath))
        const other = await runResearch(Research.Service.use((svc) => svc.createTask({
          title: "Different horizons", domainID: "tsf", mode: "autonomous",
          taskSpec: { ...task.taskSpec, predictionLengths: [4] }, objective: {}, budget: {},
        })))
        await runResearch(Research.Service.use((svc) => svc.prepareTaskDataset({ taskID: other.id })))
        const root = path.join(tmp.path, ".neo-research", "workspaces")
        const firstSpec = JSON.parse(await readFile(path.join(root, task.id, ".neo-cast", "dataset_spec.json"), "utf8"))
        const secondSpec = JSON.parse(await readFile(path.join(root, other.id, ".neo-cast", "dataset_spec.json"), "utf8"))
        expect(firstSpec.horizons).toEqual([8])
        expect(secondSpec.horizons).toEqual([4])

        const explicit = await runResearch(Research.Service.use((svc) => svc.createTask({
          title: "Explicit row ranges", domainID: "tsf", mode: "autonomous",
          taskSpec: {
            ...task.taskSpec,
            dataset: {
              ...((task.taskSpec.dataset ?? {}) as Research.JsonRecord),
              split: {
                method: "row_ranges",
                trainRows: [0, 60],
                validationRows: [60, 76],
                testRows: [76, 96],
              },
            },
          },
          objective: {}, budget: {},
        })))
        const explicitPrepared = await runResearch(
          Research.Service.use((svc) => svc.prepareTaskDataset({ taskID: explicit.id })),
        )
        const explicitPayload = JSON.parse(await readFile(explicitPrepared.path, "utf8"))
        expect(explicitPayload.command.args).toContain("0:60")
        expect(explicitPayload.command.args).toContain("60:76")
        expect(explicitPayload.command.args).toContain("76:96")

      },
    })
  })

  test("prepare dataset reports missing target columns instead of silently dropping them", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const datasetPath = await writeProfileDataset()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writePrepareDataNeoCastRunner(fakeNeoCastRoot)
        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "Prepare dataset with missing columns",
              domainID: "tsf",
              mode: "autonomous",
              taskSpec: {
                ...validTsfTaskSpec({
                  bridgeOnly: true,
                  neoCastProjectRoot: fakeNeoCastRoot,
                }),
                contextLength: 12,
                predictionLengths: [8],
                dataset: {
                  loaderID: "local_csv",
                  path: datasetPath,
                  targetCols: ["a", "missing_target"],
                },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12 },
            }),
          ),
        )

        await expect(
          runResearch(Research.Service.use((svc) => svc.prepareTaskDataset({ taskID: task.id }))),
        ).rejects.toThrow(/Dataset role columns were not found.*missing_target/)

        const invalidTask = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "Prepare dataset with no matching columns",
              domainID: "tsf",
              mode: "autonomous",
              taskSpec: {
                ...validTsfTaskSpec({
                  bridgeOnly: true,
                  neoCastProjectRoot: fakeNeoCastRoot,
                }),
                contextLength: 12,
                predictionLengths: [8],
                dataset: {
                  loaderID: "local_csv",
                  path: datasetPath,
                  targetCols: ["missing_a", "missing_b"],
                },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12 },
            }),
          ),
        )

        await expect(
          runResearch(Research.Service.use((svc) => svc.prepareTaskDataset({ taskID: invalidTask.id }))),
        ).rejects.toThrow(/Dataset role columns were not found/)
      },
    })
  })

  test("prepare dataset fails early with a friendly message when a custom CSV is too short", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
    await writePrepareDataNeoCastRunner(fakeNeoCastRoot)
    const datasetPath = path.join(tmp.path, "short.csv")
    await writeFile(datasetPath, "date,OT\n2024-01-01,1\n2024-01-02,2\n2024-01-03,3\n", "utf8")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "Short custom CSV",
              domainID: "tsf",
              mode: "autonomous",
              taskSpec: {
                ...validTsfTaskSpec({
                  bridgeOnly: true,
                  neoCastProjectRoot: fakeNeoCastRoot,
                }),
                contextLength: 96,
                predictionLengths: [24],
                dataset: {
                  loaderID: "local_csv",
                  path: datasetPath,
                  targetCols: ["OT"],
                },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12 },
            }),
          ),
        )

        await expect(
          runResearch(Research.Service.use((svc) => svc.prepareTaskDataset({ taskID: task.id }))),
        ).rejects.toThrow(/Dataset is too short for ratio split 7:1:2/)
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

  test("stale queued and running runs remain untouched until execution can be reconciled", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTSFTask("Reconcile stale runs")
        const candidate = await createCandidate({ taskID: task.id })
        const running = await createRun({ taskID: task.id, candidateID: candidate.id, status: "running" })
        const staleTime = Date.now() - 10 * 60 * 1000
        Database.use((db) =>
          db
            .update(ResearchRunTable)
            .set({ time_updated: staleTime, time_started: staleTime })
            .where(eq(ResearchRunTable.id, running.id))
            .run(),
        )

        const runs = await runResearch(Research.Service.use((svc) => svc.listRuns(task.id)))
        expect(runs[0]).toMatchObject({
          id: running.id,
          status: "running",
        })
        expect(runs[0]?.timeFinished).toBeUndefined()
      },
    })
  })

  test("runner execution aborts after repeated NaN validation losses", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeNaNNeoCastRunner(fakeNeoCastRoot)
        const task = await createTSFTask(
          "NaN watchdog",
          { neoCastProjectRoot: fakeNeoCastRoot, pythonExecutable: "bash" },
          "autonomous",
        )
        const candidate = await createCandidate({ taskID: task.id })

        const executed = await runResearch(
          Research.Service.use((svc) =>
            svc.executeRun({
              taskID: task.id,
              candidateID: candidate.id,
              stage: "smoke",
            }),
          ),
        )

        expect(executed.run.status).toBe("failed")
        expect(executed.run.error).toContain("NaN watchdog")
      },
    })
  })

  test("research memory keys distinguish same-basename datasets by path and file hash", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const dirA = path.join(tmp.path, "projA")
        const dirB = path.join(tmp.path, "projB")
        await mkdir(dirA, { recursive: true })
        await mkdir(dirB, { recursive: true })
        const pathA = path.join(dirA, "ETTh1.csv")
        const pathB = path.join(dirB, "ETTh1.csv")
        await writeFile(pathA, "date,OT\n2024-01-01,1\n", "utf8")
        await writeFile(pathB, "date,OT\n2024-01-01,2\n", "utf8")

        const taskA = await createTSFTask("Dataset A", { datasetPath: pathA })
        const candidateA = await createCandidate({ taskID: taskA.id })
        await createRun({ taskID: taskA.id, candidateID: candidateA.id, status: "succeeded", metrics: { val_avg_mse: 1 } })

        const taskB = await createTSFTask("Dataset B", { datasetPath: pathB })
        const candidateB = await createCandidate({ taskID: taskB.id })
        await createRun({ taskID: taskB.id, candidateID: candidateB.id, status: "succeeded", metrics: { val_avg_mse: 1 } })

        const [memoryA] = await runResearch(Research.Service.use((svc) => svc.listMemory(taskA.id)))
        const [memoryB] = await runResearch(Research.Service.use((svc) => svc.listMemory(taskB.id)))
        expect(memoryA?.fingerprintSummary.sourceCsv).not.toBe(memoryB?.fingerprintSummary.sourceCsv)
        expect(String(memoryA?.fingerprintSummary.sourceCsv)).toContain(path.resolve(pathA))
        expect(String(memoryB?.fingerprintSummary.sourceCsv)).toContain(path.resolve(pathB))
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
        await writeTrainingFakeNeoCastRunner(fakeNeoCastRoot)

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
        const task = await createTSFTask("recipe memory task", { bridgeOnly: false }, "autonomous")
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
        await createRun({
          taskID: task.id, candidateID: candidate.id, status: "succeeded",
          metrics: { val_avg_mse: 0.12 },
        })

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

  test("requires configured seed coverage before replacing an existing champion", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "seed-confirmed champion task",
              domainID: "tsf",
              mode: "autonomous",
              taskSpec: {
                ...validTsfTaskSpec(),
                evaluation: { protocol: "fixed_split", metricPrimary: "val_avg_mse", seeds: [1, 2, 3] },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12 },
            }),
          ),
        )
        const championCandidate = await createCandidate({
          taskID: task.id,
          candidateSpec: { ...validTsfCandidateSpec(), recipeID: "stable_champion" } as Research.JsonRecord,
        })
        const challenger = await createCandidate({
          taskID: task.id,
          candidateSpec: { ...validTsfCandidateSpec(), recipeID: "seeded_challenger" } as Research.JsonRecord,
        })
        const championRun = await createRun({
          taskID: task.id,
          candidateID: championCandidate.id,
          status: "succeeded",
          metrics: { val_avg_mse: 0.5 },
          resourceUsage: { seed: 1 },
        })

        expect((await runResearch(Research.Service.use((svc) => svc.getChampion(task.id))))?.runID).toBe(championRun.id)

        await createRun({
          taskID: task.id,
          candidateID: challenger.id,
          status: "succeeded",
          metrics: { val_avg_mse: 0.48 },
          resourceUsage: { seed: 1 },
        })
        expect((await runResearch(Research.Service.use((svc) => svc.getChampion(task.id))))?.candidateID).toBe(
          championCandidate.id,
        )

        await createRun({
          taskID: task.id,
          candidateID: challenger.id,
          status: "succeeded",
          metrics: { val_avg_mse: 0.47 },
          resourceUsage: { seed: 2 },
        })
        await createRun({
          taskID: task.id,
          candidateID: challenger.id,
          status: "succeeded",
          metrics: { val_avg_mse: 0.46 },
          resourceUsage: { seed: 3 },
        })

        const champion = await runResearch(Research.Service.use((svc) => svc.getChampion(task.id)))
        expect(champion?.candidateID).toBe(challenger.id)
        expect(champion?.primaryMetric).toBeCloseTo(0.47)
      },
    })
  })

  test("champion selection records a standoff when long-horizon metric regresses", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTSFTask("champion tie-breaker standoff")
        const current = await createCandidate({ taskID: task.id, rationale: "current long-horizon stable champion" })
        const challenger = await createCandidate({
          taskID: task.id,
          candidateSpec: {
            ...validTsfCandidateSpec(),
            recipeID: "tsf_patch_mlp_lower_avg_worse_h720",
            hypothesis: "Improves average MSE but regresses horizon 720.",
          },
          rationale: "primary metric improves but tail horizon regresses",
        })

        const championRun = await createRun({
          taskID: task.id,
          candidateID: current.id,
          status: "succeeded",
          metrics: { val_avg_mse: 0.2, val_h720_mse: 0.31 },
        })
        const challengerRun = await createRun({
          taskID: task.id,
          candidateID: challenger.id,
          status: "succeeded",
          metrics: { val_avg_mse: 0.19, val_h720_mse: 0.92 },
        })

        const champion = await runResearch(Research.Service.use((svc) => svc.getChampion(task.id)))
        expect(champion).toMatchObject({
          candidateID: current.id,
          runID: championRun.id,
          primaryMetric: 0.2,
        })

        const memory = await runResearch(Research.Service.use((svc) => svc.listMemory(task.id)))
        expect(memory[0]).toMatchObject({
          outcome: "rejected",
          candidateSummary: {
            runID: challengerRun.id,
            primaryMetric: 0.19,
            championUpdated: false,
            championStandoff: {
              status: "secondary_metric_regressed",
              primaryMetricName: "val_avg_mse",
              secondaryMetricName: "val_h720_mse",
              challengerPrimary: 0.19,
              championPrimary: 0.2,
              challengerSecondary: 0.92,
              championSecondary: 0.31,
            },
          },
        })
        expect(memory[0]?.lesson).toContain("champion standoff")
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
        const candidate = await createCandidate({ taskID: task.id, candidateSpec: phaseTwoTsfCandidateSpec() })

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

        await executeFixtureSmoke(task.id, candidate.id)
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

        await executeFixtureSmoke(task.id, candidate.id)

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

        await executeFixtureSmoke(task.id, candidate.id)
        await runResearch(Research.Service.use((svc) => svc.executeRun({
          taskID: task.id, candidateID: candidate.id, stage: "full",
        })))
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
        expect(seeded.candidates).toHaveLength(1)
        expect(seeded.approvals).toHaveLength(1)
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
        expect(prepared.runPlan.writes[0]!.content.recipe_version).toBe("recipe_schema_v3")
      },
    })
  })

  test("binds baseline controls independently and validates existing candidates against their own hypothesis", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await Instance.provide({ directory: tmp.path, fn: async () => {
      const root = path.join(tmp.path, "runner")
      await writeFakeNeoCastRunner(root)
      const task = await createTSFTask("control binding", { neoCastProjectRoot: root, pythonExecutable: "bash" }, "autonomous")
      const intervention = await addHypothesisToPool(task.id, {
        id: "H1", statement: "Test temporal attention, independently of the linear control.",
        motivation: ["Test attention"], expectedOutcome: "Improve validation error",
        suggestedBackbones: ["transformer"], suggestedPreprocessing: [], priority: "high", risk: "Overfit", testable: true,
      })
      const seeded = await runResearch(Research.Service.use((svc) => svc.seedBaselines({ taskID: task.id })))
      const baseline = seeded.candidates[0]!
      expect(baseline.hypothesisID).not.toBe(intervention.id)
      const hypotheses = await runResearch(Research.Service.use((svc) => svc.listHypotheses(task.id)))
      const control = hypotheses.find((h) => h.id === baseline.hypothesisID)!
      expect(validateCandidateAgainstHypothesis(control, baseline)).toEqual([])
      expect(validateCandidateAgainstHypothesis(intervention, baseline).length).toBeGreaterThan(0)
      const duplicate = await runResearch(Research.Service.use((svc) => svc.seedBaselines({ taskID: task.id })))
      expect(duplicate.candidates).toHaveLength(0)
      expect(await runResearch(Research.Service.use((svc) => svc.listHypotheses(task.id)))).toHaveLength(2)
      const iteration = await runResearch(Research.Service.use((svc) => svc.runAutonomousIteration({ taskID: task.id, stage: "smoke" })))
      expect(iteration.candidate.id).toBe(baseline.id)
      expect(iteration.run.status).toBe("succeeded")

      const exploration = await runResearch(Research.Service.use((svc) => svc.runAutonomousIteration({ taskID: task.id, stage: "smoke", forceExplore: true })))
      expect(exploration.candidate.hypothesisID).toBe(intervention.id)
      expect(exploration.candidate.candidateSpec.backbone).toMatchObject({ type: "transformer" })
      expect(validateCandidateAgainstHypothesis(intervention, exploration.candidate)).toEqual([])
      expect(exploration.run.status).toBe("succeeded")
    } })
  })

  test("preserves bound hypothesis snapshots and versions reused planner labels consistently", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await Instance.provide({ directory: tmp.path, fn: async () => {
      const root = path.join(tmp.path, "runner")
      await writeFakeNeoCastRunner(root)
      const task = await createTSFTask("refresh bindings", { neoCastProjectRoot: root, pythonExecutable: "bash" }, "autonomous")
      const original = await addHypothesisToPool(task.id, {
        id: "H1", statement: "An immutable historical linear-control hypothesis.",
        motivation: ["Historical control"], expectedOutcome: "Establish a floor",
        suggestedBackbones: ["linear"], suggestedPreprocessing: [], priority: "low", risk: "Underfit", testable: true,
      })
      const candidate = await runResearch(Research.Service.use((svc) => svc.createCandidate({
        taskID: task.id, domainID: "tsf", hypothesisID: original.id,
        candidateSpec: validTsfCandidateSpec(), rationale: "Historical control",
        generatedBy: "heuristic", riskLevel: "low", approvalStatus: "auto_approved",
      })))
      const result = await runResearch(Research.Service.use((svc) => svc.runHypoPlannerAgent({ taskID: task.id })))
      const pool = await runResearch(Research.Service.use((svc) => svc.listHypotheses(task.id)))
      expect(pool.find((h) => h.id === original.id)).toEqual(original)
      const version = result.plan.hypotheses.find((h) => h.id.startsWith("H1_"))!
      expect(version).toBeDefined()
      expect(pool.find((h) => h.id === version.id)?.statement).toBe(version.statement)
      expect(result.hypothesesYaml).toContain(version.id)
      expect(result.planMarkdown).toContain(version.id)
      const iteration = await runResearch(Research.Service.use((svc) => svc.runAutonomousIteration({ taskID: task.id, stage: "smoke" })))
      expect(iteration.candidate.id).toBe(candidate.id)
      expect(iteration.candidate.hypothesisID).toBe(original.id)
      expect(iteration.run.status).toBe("succeeded")
    } })
  })

  test("seeds data-profiled TSF baselines for full recipe autonomous search", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const datasetPath = await writeProfileDataset()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "profiled autonomous baseline workflow",
              domainID: "tsf",
              mode: "autonomous",
              taskSpec: {
                ...validTsfTaskSpec({ bridgeOnly: false }),
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

        const seeded = await runResearch(Research.Service.use((svc) => svc.seedBaselines({ taskID: task.id })))
        const recipeIDs = seeded.candidates.map((candidate) => candidate.candidateSpec.recipeID)

        expect(recipeIDs).toEqual(["tsf_baseline_patchtst", "tsf_baseline_dlinear", "tsf_baseline_itransformer"])
        expect(seeded.candidates.every((item) => item.approvalStatus === "auto_approved")).toBe(true)
      },
    })
  })

  test("executes an approved candidate run through a runner plan", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeTrainingFakeNeoCastRunner(fakeNeoCastRoot)
        await writeFile(path.join(fakeNeoCastRoot, "pyproject.toml"), "[project]\nname = \"fake-neo-cast\"\n", "utf8")
        await writeFile(path.join(fakeNeoCastRoot, "py", "prepare_tsf.py"), "PREPROCESS_VERSION = 1\n", "utf8")
        const datasetPath = path.join(tmp.path, "train.csv")
        await writeFile(datasetPath, "date,OT\n2024-01-01,1\n2024-01-02,2\n", "utf8")

        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "execute fake runner",
              domainID: "tsf",
              mode: "review",
              taskSpec: {
                ...validTsfTaskSpec({
                  bridgeOnly: true,
                  neoCastProjectRoot: fakeNeoCastRoot,
                  pythonExecutable: "bash",
                }),
                dataset: { loaderID: "local_csv", path: datasetPath, targetCols: ["OT"] },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize", errorPreferences: "balanced" },
              budget: { maxRuns: 12, latencyBudget: "no_constraint", parameterBudget: "no_constraint", loop: { maxIterations: 1, maxNoImprove: 1 } },
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

        await executeFixtureSmoke(task.id, seeded.candidates[0]!.id)
        const executed = await runResearch(
          Research.Service.use((svc) =>
            svc.executeRun({
              taskID: task.id,
              candidateID: seeded.candidates[0]!.id,
              stage: "full",
              description: "fake runner smoke",
            }),
          ),
        )

        expect(executed.run.status).toBe("succeeded")
        expect(executed.run.metrics.val_avg_mse).toBe(0.101)
        expect(executed.run.resourceUsage.exitCode).toBe(0)
        expect(executed.run.resourceUsage.reproducibility).toMatchObject({
          datasetSHA: expect.any(String),
          lockHash: expect.any(String),
          preprocessSHA: expect.any(String),
        })
        expect(executed.run.artifactRefs).toHaveLength(5)

        const writtenCandidate = JSON.parse(
          await readFile(path.join(tmp.path, ".neo-research", "workspaces", task.id, ".neo-cast", "current_candidate.json"), "utf8"),
        )
        expect(writtenCandidate.recipe_version).toBe("recipe_schema_v3")

        const artifacts = await runResearch(Research.Service.use((svc) => svc.listArtifacts(task.id)))
        expect(artifacts.some((artifact) => artifact.kind === "runner_plan_json")).toBe(true)
        expect(artifacts.some((artifact) => artifact.kind === "runner_artifact")).toBe(true)
        expect(artifacts.some((artifact) => artifact.kind === "runner_progress_jsonl")).toBe(true)
        const executionLog = artifacts.find((artifact) => artifact.kind === "runner_execution_log_json" && artifact.runID === executed.run.id)
        expect(executionLog?.runID).toBe(executed.run.id)
        expect(executionLog?.metadata).toMatchObject({
          runnerID: executed.runPlan.runnerID,
          stage: "full",
          exitCode: 0,
          recordCount: 7,
        })
        expect(executed.run.artifactRefs).toContain(executionLog!.id)
        const executionLogRecord = JSON.parse(await readFile(executionLog!.uri.replace("file://", ""), "utf8"))
        expect(executionLogRecord.exitCode).toBe(0)
        expect(executionLogRecord.records.map((record: { event?: string }) => record.event)).toContain("artifact_ready")
        expect(artifacts[0]!.uri).toStartWith("file://")

        const champion = await runResearch(Research.Service.use((svc) => svc.getChampion(task.id)))
        expect(champion?.candidateID).toBe(seeded.candidates[0]!.id)
        expect(champion?.primaryMetric).toBe(0.101)

        const memory = await runResearch(Research.Service.use((svc) => svc.listMemory(task.id)))
        expect(memory[0]!.outcome).toBe("accepted")
        expect(memory[0]!.fingerprintSummary).toMatchObject({
          targetCount: 1,
          contextLength: 96,
          maxPredictionLength: 24,
          horizonContextRatio: 0.25,
          bridgeOnly: true,
        })
        expect(memory[0]!.candidateSummary.primaryMetric).toBe(0.101)
      },
    })
  })

  test("cached experiments do not add independent metric evidence", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = path.join(tmp.path, "cached-runner")
        await writeTrainingFakeNeoCastRunner(root)
        const runner = path.join(root, "py", "runner.py")
        const script = await readFile(runner, "utf8")
        await writeFile(runner, script.replace('{"event":"done","status":"success"}', '{"event":"done","status":"success","reused":true}'))
        const task = await createTSFTask("cached experiment", { bridgeOnly: true, neoCastProjectRoot: root, pythonExecutable: "bash" })
        const candidate = await createCandidate({ taskID: task.id })
        await executeFixtureSmoke(task.id, candidate.id)
        const result = await runResearch(Research.Service.use((svc) => svc.executeRun({ taskID: task.id, candidateID: candidate.id, stage: "full" })))
        expect(result.run.status).toBe("succeeded")
        expect(result.run.metrics).toEqual({})
        expect(result.run.resourceUsage.independentEvidence).toBe(false)
        expect(result.run.resourceUsage.duplicateExperiment).toBe(true)
        expect(await runResearch(Research.Service.use((svc) => svc.getChampion(task.id)))).toBeUndefined()
      },
    })
  })

  test("treats exit code 1 as succeeded when runner emits done:success (discard case)", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "discard-neo-cast")
        await writeDiscardFakeNeoCastRunner(fakeNeoCastRoot)

        const task = await createTSFTask("execute discard runner", {
          bridgeOnly: true,
          neoCastProjectRoot: fakeNeoCastRoot,
          pythonExecutable: "bash",
        })
        const candidate = await createCandidate({ taskID: task.id })

        await executeFixtureSmoke(task.id, candidate.id)
        const executed = await runResearch(
          Research.Service.use((svc) =>
            svc.executeRun({
              taskID: task.id,
              candidateID: candidate.id,
              stage: "full",
              description: "discard runner full",
            }),
          ),
        )

        expect(executed.run.status).toBe("succeeded")
        expect(executed.run.resourceUsage.exitCode).toBe(1)
        expect(executed.run.metrics.cv_avg_mse).toBe(0.777)
        expect(executed.run.metrics.cv_std_mse).toBe(0.055)
        expect(executed.run.metrics.val_avg_mse).toBe(0.999)
        expect(executed.run.error).toBeUndefined()
      },
    })
  })

  test("uses the final runner done status when an earlier stage succeeded", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "crash-after-success-neo-cast")
        await writeCrashAfterSuccessFakeNeoCastRunner(fakeNeoCastRoot)

        const task = await createTSFTask("execute crash after success runner", {
          bridgeOnly: true,
          neoCastProjectRoot: fakeNeoCastRoot,
          pythonExecutable: "bash",
        })
        const candidate = await createCandidate({ taskID: task.id })
        await executeFixtureSmoke(task.id, candidate.id)
        const executed = await runResearch(
          Research.Service.use((svc) =>
            svc.executeRun({ taskID: task.id, candidateID: candidate.id, stage: "full" }),
          ),
        )

        expect(executed.run.status).toBe("failed")
        expect(executed.run.resourceUsage.exitCode).toBe(1)
      },
    })
  })

  test("publishes parsed runner progress events while executing a run", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "streaming-neo-cast")
        await writeStreamingFakeNeoCastRunner(fakeNeoCastRoot)

        const task = await createTSFTask("execute streaming runner", {
          bridgeOnly: true,
          neoCastProjectRoot: fakeNeoCastRoot,
          pythonExecutable: "bash",
        })
        const candidate = await createCandidate({ taskID: task.id })

        const progress = await runResearchWithBus(
          Effect.gen(function* () {
            const bus = yield* Bus.Service
            const svc = yield* Research.Service
            const received: Array<{
              readonly taskID: Research.ResearchTaskID
              readonly runID: string
              readonly line: string
              readonly event?: string
              readonly epoch?: number
              readonly horizon?: number
              readonly valLoss?: number
              readonly elapsedS?: number
              readonly foldIndex?: number
            }> = []
            const unsubscribe = yield* bus.subscribeCallback(Research.Event.RunnerProgressLine, (event) => {
              if (event.properties.taskID === task.id) received.push(event.properties)
            })
            const executed = yield* svc.executeRun({
              taskID: task.id,
              candidateID: candidate.id,
              stage: "smoke",
              description: "streaming runner smoke",
            })
            yield* Effect.promise(() => Bun.sleep(50))
            unsubscribe()
            expect(executed.run.status).toBe("succeeded")
            return received
          }),
        )

        expect(progress.map((item) => item.event)).toEqual([
          "executed_model_manifest",
          "execution_contract_verified",
          "stage_start",
          "batch_progress",
          "epoch_end",
          "timeout",
          "smoke_eval_done",
          "artifact_ready",
          "done",
        ])
        expect(progress.every((item) => item.runID.length > 0)).toBe(true)
        expect(progress.find((item) => item.event === "epoch_end")).toMatchObject({
          taskID: task.id,
          epoch: 1,
          horizon: 24,
          valLoss: 0.719233,
          foldIndex: 2,
        })
        expect(progress.find((item) => item.event === "timeout")).toMatchObject({
          elapsedS: 61.4,
        })
        const artifacts = await runResearch(Research.Service.use((svc) => svc.listArtifacts(task.id)))
        const progressArtifact = artifacts.find((artifact) => artifact.kind === "runner_progress_jsonl")
        expect(progressArtifact?.runID).toBeDefined()
        expect(progressArtifact?.metadata.previewLines).toEqual(expect.arrayContaining([
          expect.objectContaining({ event: "epoch_end", foldIndex: 2 }),
        ]))
        expect(progressArtifact?.metadata.previewLines).not.toEqual(expect.arrayContaining([
          expect.objectContaining({ event: "batch_progress" }),
        ]))
        const progressLog = await readFile(progressArtifact!.uri.replace("file://", ""), "utf8")
        expect(progressLog).toContain('"event":"stage_start"')
        expect(progressLog).toContain('"event":"epoch_end"')
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
        expect(executed.run.artifactRefs).toHaveLength(3)

        const artifacts = await runResearch(Research.Service.use((svc) => svc.listArtifacts(task.id)))
        const executionLog = artifacts.find((artifact) => artifact.kind === "runner_execution_log_json")
        const progressLog = artifacts.find((artifact) => artifact.kind === "runner_progress_jsonl")
        expect(executionLog?.metadata).toMatchObject({
          runnerID: executed.runPlan.runnerID,
          stage: "smoke",
          exitCode: 7,
          recordCount: 4,
        })
        expect(executed.run.artifactRefs).toContain(executionLog!.id)
        expect(executed.run.artifactRefs).toContain(progressLog!.id)
        const executionLogRecord = JSON.parse(await readFile(executionLog!.uri.replace("file://", ""), "utf8"))
        expect(executionLogRecord.stderr).toContain("runner failed before artifact creation")
        expect(executionLogRecord.records.map((record: { event?: string }) => record.event)).toContain("runner_error")
      },
    })
  })

  test("writes verifier decision and failure log artifacts for the review loop", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTSFTask("verification reflection artifacts")
        const candidate = await createCandidate({ taskID: task.id })
        const run = await createRun({
          taskID: task.id,
          candidateID: candidate.id,
          status: "succeeded",
          metrics: { val_avg_mse: 0.42 },
        })

        const verified = await runResearch(
          Research.Service.use((svc) =>
            svc.runVerifierAgent({
              taskID: task.id,
              runID: run.id,
              outputDir: ".neo-research/test-evaluation",
            }),
          ),
        )

        expect(verified.artifact?.kind).toBe("evaluation_result_md")
        expect(verified.decisionArtifact?.kind).toBe("verifier_decision_json")
        const decision = JSON.parse(await readFile(verified.decisionArtifact!.uri.replace("file://", ""), "utf8"))
        expect(decision).toMatchObject({
          schemaVersion: "neo-research.verifier_decision.v1",
          runID: run.id,
          accepted: true,
          decision: "accept",
        })

        const failedRun = await createRun({
          taskID: task.id,
          candidateID: candidate.id,
          status: "queued",
        })
        await runResearch(
          Research.Service.use((svc) =>
            svc.updateRunStatus({
              runID: failedRun.id,
              status: "failed",
              error: "CUDA out of memory while training",
            }),
          ),
        )

        const reflection = await runResearch(
          Research.Service.use((svc) =>
            svc.runReflectionAgent({
              taskID: task.id,
              outputDir: ".neo-research/test-reflection",
              stoppedReason: "crash_streak_exceeded",
            }),
          ),
        )

        expect(reflection.maxIterations).toBe(1)
        expect(reflection.reflectionNotesMarkdown).toContain("NAS planned max iterations: 1")
        expect(reflection.failureLogMarkdown).toContain("category: oom")
        expect(reflection.failureLogMarkdown).toContain("recovery_action: reduce_resource_pressure")
        const artifacts = await runResearch(Research.Service.use((svc) => svc.listArtifacts(task.id)))
        expect(artifacts.some((artifact) => artifact.kind === "verifier_decision_json" && artifact.runID === run.id)).toBe(
          true,
        )
        const failureLog = artifacts.find((artifact) => artifact.kind === "failure_log_md")
        expect(failureLog).toBeDefined()
        expect(failureLog?.metadata.maxIterations).toBe(1)
        expect(await readFile(failureLog!.uri.replace("file://", ""), "utf8")).toContain("run_id: " + failedRun.id)
      },
    })
  })

  test("autonomous iteration retries a transient failed candidate once and marks failed trace steps accurately", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "failing-neo-cast")
        await writeFailingNeoCastRunner(fakeNeoCastRoot)
        const task = await createTSFTask(
          "retry failed autonomous candidate",
          {
            bridgeOnly: true,
            neoCastProjectRoot: fakeNeoCastRoot,
            pythonExecutable: "bash",
          },
          "autonomous",
        )
        const candidate = await createCandidate({ taskID: task.id })

        const first = await runResearch(
          Research.Service.use((svc) =>
            svc.runAutonomousIteration({
              taskID: task.id,
              stage: "smoke",
              description: "first failure",
            }),
          ),
        )
        const second = await runResearch(
          Research.Service.use((svc) =>
            svc.runAutonomousIteration({
              taskID: task.id,
              stage: "smoke",
              description: "retry failure",
            }),
          ),
        )

        expect(first.run.status).toBe("failed")
        expect(second.run.status).toBe("failed")
        expect(first.candidate.id).toBe(candidate.id)
        expect(second.candidate.id).toBe(candidate.id)
        expect(first.managerTrace.find((step) => step.role === "runner")?.status).toBe("blocked")
        expect(first.managerTrace.find((step) => step.role === "analyst")?.status).toBe("skipped")
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

        const seedLog = await readFile(path.join(tmp.path, ".neo-research", "workspaces", task.id, ".neo-cast", "seed-log.txt"), "utf8")
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

  test("exports data analysis agent artifacts in the TSF report", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const datasetPath = await writeProfileDataset()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "TSF data analysis report",
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
        await runResearch(Research.Service.use((svc) => svc.profileTask({ taskID: task.id })))

        const exported = await runResearch(Research.Service.use((svc) => svc.exportTaskArtifact({ taskID: task.id })))
        const report = await readFile(exported.path, "utf8")

        expect(report).toContain("## Data Analysis Agents")
        expect(report).toContain("dataset_quantitative_analysis_markdown")
        expect(report).toContain("dataset_quantitative_analysis_json")
        expect(report).toContain("dataset_qualitative_analysis_markdown")
        expect(report).toContain("dataset_main_analysis_markdown")
        expect(report).toContain("dataset_analysis_plot_png")
        expect(report).toContain("KPSS statistic")
        expect(report).toContain("Dominant frequency period")
        expect(report).toContain("Cross-lag")
        expect(report).toContain("main-data-analyst")
      },
    })
  })

  test("exports a final bundle with report, results, champion metadata, and model artifacts", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTask("bundle-ready TSF report")
        const candidate = await createCandidate({ taskID: task.id })
        const run = await createRun({
          taskID: task.id,
          candidateID: candidate.id,
          status: "succeeded",
          metrics: { val_avg_mse: 0.42, val_avg_mae: 0.31 },
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
        const runnerArtifactDir = path.join(tmp.path, ".neo-cast", "artifacts", "run_bundle")
        await mkdir(runnerArtifactDir, { recursive: true })
        await writeFile(path.join(runnerArtifactDir, "model.pt"), "weights", "utf8")
        await writeFile(path.join(runnerArtifactDir, "model_impl.py"), "# model\n", "utf8")
        await writeFile(path.join(runnerArtifactDir, "inference.py"), "# inference\n", "utf8")
        await writeFile(path.join(runnerArtifactDir, "metadata.json"), '{"model_family":"recipe_factory"}\n', "utf8")
        await writeFile(path.join(runnerArtifactDir, "model_spec.json"), '{"recipe_id":"bundle"}\n', "utf8")
        await writeFile(path.join(runnerArtifactDir, "patch_bundle.json"), '{"schema_version":"patch_bundle.v1"}\n', "utf8")
        await writeFile(path.join(runnerArtifactDir, "preprocess.json"), '{"input_len":96}\n', "utf8")
        await writeFile(path.join(runnerArtifactDir, "tool_schema.json"), '{"name":"forecast"}\n', "utf8")
        await writeFile(path.join(runnerArtifactDir, "mcp_server.py"), "# mcp\n", "utf8")
        await writeFile(path.join(runnerArtifactDir, "example.py"), "# example\n", "utf8")
        await writeFile(path.join(runnerArtifactDir, "requirements.txt"), "torch\nnumpy\nmcp>=1.0\n", "utf8")
        await writeFile(path.join(runnerArtifactDir, "README.md"), "# Exported model\n", "utf8")
        await writeFile(path.join(runnerArtifactDir, "eval_report.md"), "# Evaluation\n", "utf8")
        await runResearch(
          Research.Service.use((svc) =>
            svc.createArtifact({
              taskID: task.id,
              runID: run.id,
              kind: "runner_artifact",
              uri: `file://${runnerArtifactDir}`,
              metadata: { stage: "smoke" },
            }),
          ),
        )

        const exported = await runResearch(
          Research.Service.use((svc) =>
            svc.exportTaskArtifact({
              taskID: task.id,
              kind: "research_final_bundle",
              outputDir: ".neo-research/final",
            }),
          ),
        )

        expect(exported.artifact.kind).toBe("research_final_bundle")
        expect(exported.artifact.metadata).toMatchObject({
          championCandidateID: candidate.id,
          primaryMetricName: "val_avg_mse",
          primaryMetricValue: 0.42,
        })
        expect(exported.artifact.metadata.copiedFiles).toEqual(
          expect.arrayContaining([
            "report/research-report.md",
            "reports/final_report.md",
            "artifacts/release_package.md",
            "model/model.pt",
            "model/inference.py",
          ]),
        )
        const manifest = JSON.parse(await readFile(path.join(exported.path, "manifest.json"), "utf8"))
        expect(manifest).toMatchObject({
          taskID: task.id,
          champion: {
            candidateID: candidate.id,
            runID: run.id,
          },
          files: {
            finalReport: "reports/final_report.md",
            releasePackage: "artifacts/release_package.md",
            report: "report/research-report.md",
            runs: "results/runs.json",
            champion: "results/champion.json",
            modelWeights: "model/model.pt",
            modelImpl: "model/model_impl.py",
            inference: "model/inference.py",
          },
        })
        expect(manifest.integrity.status).toBe("complete")
        expect(await readFile(path.join(exported.path, "model", "model.pt"), "utf8")).toBe("weights")
        expect(await readFile(path.join(exported.path, "report", "research-report.md"), "utf8")).toContain(
          "# bundle-ready TSF report",
        )
        expect(await readFile(path.join(exported.path, "reports", "final_report.md"), "utf8")).toContain(
          "# bundle-ready TSF report",
        )
        expect(await readFile(path.join(exported.path, "artifacts", "release_package.md"), "utf8")).toContain(
          "## File Manifest",
        )

        const modelExport = await runResearch(
          Research.Service.use((svc) =>
            svc.exportTaskArtifact({
              taskID: task.id,
              kind: "model_export_package",
              outputDir: ".neo-research/model-export",
            }),
          ),
        )
        expect(modelExport.artifact.metadata).toMatchObject({
          championCandidateID: candidate.id,
          primaryMetricName: "val_avg_mse",
          primaryMetricValue: 0.42,
        })
        expect(modelExport.artifact.metadata.copiedFiles).toEqual(
          expect.arrayContaining([
            "reports/final_report.md",
            "artifacts/release_package.md",
            "model/requirements.txt",
            "model/README.md",
            "model/mcp_server.py",
          ]),
        )
        const modelManifest = JSON.parse(await readFile(path.join(modelExport.path, "manifest.json"), "utf8"))
        expect(modelManifest.files).toMatchObject({
          finalReport: "reports/final_report.md",
          releasePackage: "artifacts/release_package.md",
          modelPy: "model/model.py",
          requirements: "model/requirements.txt",
          readme: "model/README.md",
          example: "model/example.py",
          mcpServer: "model/mcp_server.py",
          toolSchema: "model/tool_schema.json",
          evalReport: "model/eval_report.md",
          patchBundle: "model/patch_bundle.json",
        })
        expect(await readFile(path.join(modelExport.path, "model", "requirements.txt"), "utf8")).toContain("mcp>=1.0")
        expect(await readFile(path.join(modelExport.path, "model", "mcp_server.py"), "utf8")).toContain("# mcp")
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
        await writeTrainingFakeNeoCastRunner(fakeNeoCastRoot)

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

        expect(iteration.seededCandidates).toHaveLength(1)
        expect(iteration.approvals).toHaveLength(0)
        expect(iteration.candidate.approvalStatus).toBe("auto_approved")
        expect(iteration.run.status).toBe("succeeded")
        expect(iteration.managerTrace.map((step) => step.role)).toEqual([
          "diagnostic",
          "design",
          "coder",
          "verifier",
          "runner",
          "analyst",
          "librarian",
        ])
        expect(iteration.managerTrace[0]!.metadata).toMatchObject({ bridgeOnly: true, targetCount: 1 })
        expect(iteration.managerTrace.find((step) => step.role === "design")?.metadata).toMatchObject({
          agent: "ModelDesignerAgent",
          modelDesignerResult: {
            agent: "ModelDesignerAgent",
            candidateID: iteration.candidate.id,
            llmStatus: "disabled",
            selectionSource: "existing_frontier",
          },
        })
        expect(iteration.managerTrace.find((step) => step.role === "runner")?.metadata).toMatchObject({
          modelCompilerResult: {
            agent: "ModelCompilerAgent",
            candidateID: iteration.candidate.id,
            runID: iteration.run.id,
            status: "passed",
          },
        })
        expect(iteration.managerTrace[4]!.metadata).toMatchObject({ stage: "smoke", status: "succeeded" })

        const artifacts = await runResearch(Research.Service.use((svc) => svc.listArtifacts(task.id)))
        const managerTraceArtifact = artifacts.find((artifact) => artifact.kind === "research_manager_trace_json")
        expect(managerTraceArtifact?.runID).toBe(iteration.run.id)
        expect(managerTraceArtifact?.metadata).toMatchObject({
          candidateID: iteration.candidate.id,
          runID: iteration.run.id,
          stage: "smoke",
          roleCount: 7,
        })
        expect(iteration.run.artifactRefs).toContain(managerTraceArtifact!.id)
        const managerTracePath = managerTraceArtifact!.uri.replace("file://", "")
        const managerTraceRecord = JSON.parse(await readFile(managerTracePath, "utf8"))
        expect(managerTraceRecord.managerTrace.map((step: { role: string }) => step.role)).toEqual([
          "diagnostic",
          "design",
          "coder",
          "verifier",
          "runner",
          "analyst",
          "librarian",
        ])

        const champion = await runResearch(Research.Service.use((svc) => svc.getChampion(task.id)))
        expect(champion).toBeUndefined()
      },
    })
  })

  test("autonomous low-fidelity iteration compiles with smoke before TrainEval", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast-train")
        await writeTrainingFakeNeoCastRunner(fakeNeoCastRoot)
        const task = await createTSFTask(
          "autonomous compile then train",
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
              stage: "low_fidelity",
              description: "compile then low fidelity",
            }),
          ),
        )

        expect(iteration.run.stage).toBe("low_fidelity")
        expect(iteration.run.status).toBe("succeeded")
        const runs = await runResearch(Research.Service.use((svc) => svc.listRuns(task.id)))
        expect(runs.map((run) => run.stage).sort()).toEqual(["low_fidelity", "smoke"])
        expect(iteration.managerTrace.find((step) => step.role === "runner")?.metadata).toMatchObject({
          modelCompilerResult: {
            agent: "ModelCompilerAgent",
            status: "passed",
          },
          trainEvalResult: {
            agent: "TrainEvalAgent",
            runID: iteration.run.id,
            stage: "low_fidelity",
            status: "succeeded",
            verifierDecision: "accepted",
          },
        })
      },
    })
  })

  test("default autonomous iteration compiles with smoke before full TrainEval", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast-full")
        await writeTrainingFakeNeoCastRunner(fakeNeoCastRoot)
        const task = await createTSFTask(
          "autonomous default full training",
          { bridgeOnly: true, neoCastProjectRoot: fakeNeoCastRoot, pythonExecutable: "bash" },
          "autonomous",
        )

        const iteration = await runResearch(
          Research.Service.use((svc) => svc.runAutonomousIteration({ taskID: task.id })),
        )

        expect(iteration.run).toMatchObject({ stage: "full", status: "succeeded" })
        const runs = await runResearch(Research.Service.use((svc) => svc.listRuns(task.id)))
        expect(runs.map((run) => run.stage).sort()).toEqual(["full", "smoke"])
        expect(iteration.managerTrace.find((step) => step.role === "runner")?.metadata).toMatchObject({
          modelCompilerResult: { agent: "ModelCompilerAgent", status: "passed" },
          trainEvalResult: { agent: "TrainEvalAgent", stage: "full", runID: iteration.run.id },
        })
      },
    })
  })

  test("writes a candidate selection ranking artifact for existing ready frontier candidates", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeTrainingFakeNeoCastRunner(fakeNeoCastRoot)
        const task = await createTSFTask(
          "existing frontier ranking",
          {
            bridgeOnly: true,
            neoCastProjectRoot: fakeNeoCastRoot,
            pythonExecutable: "bash",
          },
          "autonomous",
        )
        const existing = await createCandidate({ taskID: task.id })

        const iteration = await runResearch(
          Research.Service.use((svc) =>
            svc.runAutonomousIteration({
              taskID: task.id,
              stage: "full",
              description: "existing frontier",
            }),
          ),
        )

        expect(iteration.candidate.id).toBe(existing.id)
        expect(iteration.selectionArtifact.metadata).toMatchObject({
          selectionSource: "existing_frontier",
          rankingCount: 1,
        })
        const selectionRecord = JSON.parse(await readFile(iteration.selectionArtifact.uri.replace("file://", ""), "utf8"))
        expect(selectionRecord.rankings[0]).toMatchObject({
          rank: 1,
          recipeID: existing.candidateSpec.recipeID,
          reasons: expect.arrayContaining(["existing approved frontier candidate"]),
        })
      },
    })
  })

  test("writes an autonomous loop summary artifact", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeTrainingFakeNeoCastRunner(fakeNeoCastRoot)

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
        const artifacts = await runResearch(Research.Service.use((svc) => svc.listArtifacts(task.id)))
        const reflections = artifacts.filter((artifact) => artifact.kind === "reflection_notes_md")
        expect(reflections.length).toBeGreaterThan(0)
        expect(reflections.every((artifact) => artifact.metadata.maxIterations === 2)).toBe(true)
      },
    })
  })

  test("autonomous loop forced exploration creates a new domain proposal instead of exploiting ready frontier", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeFakeNeoCastRunner(fakeNeoCastRoot)

        const task = await createTSFTask(
          "autonomous forced exploration",
          {
            bridgeOnly: true,
            neoCastProjectRoot: fakeNeoCastRoot,
            pythonExecutable: "bash",
          },
          "autonomous",
        )

        const loopInput = {
          taskID: task.id,
          stage: "smoke" as const,
          maxIterations: 1,
          explorationRate: 1,
          description: "forced explore",
        }
        const loop = await runResearch(Research.Service.use((svc) => svc.runAutonomousLoop(loopInput)))

        expect(loop.iterations).toHaveLength(1)
        expect(loop.iterations[0]?.candidate.generatedBy).toBe("mutation")
        expect(loop.iterations[0]?.candidate.candidateSpec.recipeID).toBe("tsf_bridge_patch_mlp_wide_adamw")
        expect(loop.iterations[0]?.managerTrace.find((step) => step.role === "design")?.metadata).toMatchObject({
          explorationMode: "forced",
          selectionSource: "domain_proposal",
          proposalCreated: true,
        })

        const candidates = await runResearch(Research.Service.use((svc) => svc.listCandidates(task.id)))
        expect(candidates).toHaveLength(2)
      },
    })
  })

  test("autonomous loop defaults beyond one iteration when no maxIterations is provided", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeFakeNeoCastRunner(fakeNeoCastRoot)

        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "autonomous loop default iteration budget",
              domainID: "tsf",
              mode: "autonomous",
              taskSpec: validTsfTaskSpec({
                bridgeOnly: true,
                neoCastProjectRoot: fakeNeoCastRoot,
                pythonExecutable: "bash",
              }),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 2 },
            }),
          ),
        )

        const loop = await runResearch(
          Research.Service.use((svc) =>
            svc.runAutonomousLoop({
              taskID: task.id,
              stage: "smoke",
              description: "default iteration budget",
            }),
          ),
        )

        expect(loop.iterations).toHaveLength(2)
      },
    })
  })

  test("autonomous loop retries metricless smoke runs as compiler failures", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeMetriclessNeoCastRunner(fakeNeoCastRoot)
        const task = await createTSFTask(
          "autonomous metricless retry",
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
              description: "metricless retry loop",
            }),
          ),
        )

        expect(loop.iterations).toHaveLength(2)
        expect(loop.iterations[1]!.candidate.id).toBe(loop.iterations[0]!.candidate.id)

        const designStep = loop.iterations[1]!.managerTrace.find((step) => step.role === "design")
        expect(designStep?.metadata).toMatchObject({
          inconclusiveCandidateCount: 0,
        })

        const selectionRecord = JSON.parse(
          await readFile(loop.iterations[1]!.selectionArtifact.uri.replace("file://", ""), "utf8"),
        )
        expect(selectionRecord.inconclusiveCandidateIDs).toEqual([])
        expect(loop.iterations.map((item) => item.run.status)).toEqual(["failed", "failed"])
        expect(loop.iterations[0]!.run.error).toContain("val_avg_mse is missing")
      },
    })
  })

  test("autonomous loop stops when the target metric is reached", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeTrainingFakeNeoCastRunner(fakeNeoCastRoot)
        const task = await createTSFTask(
          "autonomous loop target",
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
              stage: "full",
              maxIterations: 5,
              targetMetricValue: 0.2,
              description: "target stopped loop",
            }),
          ),
        )

        expect(loop.stoppedReason).toBe("target_reached")
        expect(loop.iterations).toHaveLength(1)
      },
    })
  })

  test("autonomous loop stops on a no-improvement plateau", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeTrainingFakeNeoCastRunner(fakeNeoCastRoot)
        const task = await createTSFTask(
          "autonomous loop plateau",
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
              stage: "full",
              maxIterations: 5,
              maxNoImprove: 1,
              description: "plateau stopped loop",
            }),
          ),
        )

        expect(loop.stoppedReason).toBe("plateau")
        expect(loop.iterations).toHaveLength(2)
      },
    })
  })

  test("autonomous loop uses the default plateau threshold against the current task best", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeTrainingFakeNeoCastRunner(fakeNeoCastRoot)
        const task = await createTSFTask(
          "autonomous loop current session plateau",
          {
            bridgeOnly: true,
            neoCastProjectRoot: fakeNeoCastRoot,
            pythonExecutable: "bash",
          },
          "autonomous",
        )
        await runResearch(Research.Service.use((svc) => svc.updateTaskBudget({
          taskID: task.id, budget: { maxRuns: 60 },
        })))
        const sessionBestCandidate = await createCandidate({
          taskID: task.id,
          rationale: "current task/session best",
        })
        await createRun({
          taskID: task.id,
          candidateID: sessionBestCandidate.id,
          status: "succeeded",
          stage: "full",
          metrics: { val_avg_mse: 0.05, val_avg_mae: 0.2 },
        })

        await createSearchHypothesis(task.id)
        const loop = await runResearch(
          Research.Service.use((svc) =>
            svc.runAutonomousLoop({
              taskID: task.id,
              stage: "full",
              maxIterations: 30,
              description: "default plateau against current best",
            }),
          ),
        )

        expect(loop.stoppedReason).toBe("plateau")
        expect(loop.iterations).toHaveLength(NAS_DEFAULT_MAX_NO_IMPROVE)
        expect(loop.iterations.every((iteration) => iteration.run.metrics.val_avg_mse === 0.101)).toBe(true)
      },
    })
  }, 60_000)

  test("autonomous loop does not use smoke metrics for no-improvement stopping", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeFakeNeoCastRunner(fakeNeoCastRoot)
        const task = await createTSFTask(
          "autonomous loop smoke gate",
          {
            bridgeOnly: true,
            neoCastProjectRoot: fakeNeoCastRoot,
            pythonExecutable: "bash",
          },
          "autonomous",
        )
        const smokeBestCandidate = await createCandidate({
          taskID: task.id,
          rationale: "smoke-only best must not drive plateau",
        })
        await createRun({
          taskID: task.id,
          candidateID: smokeBestCandidate.id,
          stage: "smoke",
          status: "succeeded",
          metrics: { val_avg_mse: 0.01, val_avg_mae: 0.02 },
        })

        await createSearchHypothesis(task.id)
        const loop = await runResearch(
          Research.Service.use((svc) =>
            svc.runAutonomousLoop({
              taskID: task.id,
              stage: "smoke",
              maxIterations: 2,
              maxNoImprove: 1,
              description: "smoke metrics ignored for plateau",
            }),
          ),
        )

        expect(loop.stoppedReason).toBe("max_iterations")
        expect(loop.iterations).toHaveLength(2)
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

  test("autonomous loop stops with an artifact when only a pending candidate exists", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTSFTask("autonomous governed pending loop", { bridgeOnly: false }, "autonomous")
        // A pending candidate (not auto_approved) blocks the loop because no approved candidate is ready.
        const candidate = await runResearch(
          Research.Service.use((svc) =>
            svc.createCandidate({
              taskID: task.id,
              domainID: "tsf",
              candidateSpec: phaseTwoTsfCandidateSpec(),
              rationale: "Pending candidate should block the autonomous loop until approved.",
              riskLevel: "medium",
              approvalStatus: "pending",
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
              description: "governed pending loop",
            }),
          ),
        )

        expect(loop.iterations).toHaveLength(0)
        expect(loop.stoppedReason).toBe("approval_required")
        expect(loop.artifact.kind).toBe("research_autonomous_loop_json")
        expect(candidate.approvalStatus).toBe("pending")
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
        await writeTrainingFakeNeoCastRunner(fakeNeoCastRoot)

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

        await createSearchHypothesis(task.id)
        for (let index = 0; index < 3; index++) {
          await runResearch(
            Research.Service.use((svc) =>
              svc.runAutonomousIteration({
                taskID: task.id,
                stage: "full",
                description: `baseline ${index + 1}`,
              }),
            ),
          )
        }

        const iteration = await runResearch(
          Research.Service.use((svc) =>
            svc.runAutonomousIteration({
              taskID: task.id,
              stage: "full",
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
	          historyRunCount: 6,
	          historyMetricRunCount: 6,
	          historyMemoryCount: 3,
	          learnedRankerTrainingExamples: 10,
	          learnedRankerPositiveExamples: 5,
	          learnedRankerNegativeExamples: 5,
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

  test("uses a configured LLM provider for autonomous proposals after local frontier candidates are exhausted", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    const previousFetch = globalThis.fetch
    const previousProvider = process.env.NEO_CAST_LLM_PROVIDER
    const previousBaseURL = process.env.NEO_CAST_LLM_BASE_URL
    const previousModel = process.env.NEO_CAST_LLM_MODEL
    const previousKey = process.env.NEO_CAST_LLM_API_KEY
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: input.toString(), init })
      const notes = fetchCalls.length === 1 ? "x".repeat(16001) : "schema-valid retry"
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    recipe_version: "recipe_schema_v2",
                    recipe_id: "recipe_llm_patch_mlp_candidate",
                    hypothesis: "LLM proposes a compact patch MLP after baselines are exhausted.",
                    preprocessing: { actions: [{ type: "none" }] },
                    embedding: { type: "patch", patch_len: 16, stride: 8, d_model: 64 },
                    backbone: { type: "mlp", depth: 2, hidden_dim: 128, activation: "gelu", dropout: 0.1 },
                    fusion: { type: "temporal", channel_mode: "independent" },
                    prediction_head: { type: "linear", output_distribution: "point" },
                    training_strategy: {
                      loss: { base: "mse", horizon_weighting: "uniform" },
                      optimizer: { type: "adamw", lr: 0.001, weight_decay: 0.01 },
                      scheduler: { type: "none", warmup_steps: 0 },
                      regularization: { grad_clip: 1 },
                      budget: { max_epochs: 5, time_budget_s: 120, batch_size: 16, patience: 2, seed: 42 },
                    },
                    notes,
                  }),
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    }) as typeof fetch
    process.env.NEO_CAST_LLM_PROVIDER = "openai-compatible"
    process.env.NEO_CAST_LLM_BASE_URL = "http://llm.test/v1"
    process.env.NEO_CAST_LLM_MODEL = "test-model"
    process.env.NEO_CAST_LLM_API_KEY = "test-key"

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast-llm")
          await writeFakeNeoCastRunner(fakeNeoCastRoot)
          await mkdir(path.join(fakeNeoCastRoot, ".neo-cast"), { recursive: true })
          await writeFile(
            path.join(fakeNeoCastRoot, ".neo-cast", "config.json"),
            `${JSON.stringify(
              {
                llm: {
                  provider: "openai-compatible",
                  base_url: "http://llm.test/v1",
                  model: "test-model",
                  max_tokens: 1024,
                  temperature: 0.2,
                },
              },
              null,
              2,
            )}\n`,
            "utf8",
          )

          const task = await createTSFTask(
            "autonomous llm proposal fake runner",
            {
              bridgeOnly: true,
              neoCastProjectRoot: fakeNeoCastRoot,
              pythonExecutable: "bash",
            },
            "autonomous",
          )

          await createSearchHypothesis(task.id)
          for (let index = 0; index < 1; index++) {
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
                description: "llm proposal",
              }),
            ),
          )

          expect(fetchCalls).toHaveLength(2)
          expect(fetchCalls[0]!.url).toBe("http://llm.test/v1/chat/completions")
          expect((fetchCalls[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer test-key")
          expect(JSON.parse(String(fetchCalls[0]!.init?.body))).toMatchObject({ model: "test-model" })
          const retryBody = JSON.parse(String(fetchCalls[1]!.init?.body))
          const retryPrompt = JSON.parse(retryBody.messages[1].content)
          expect(retryPrompt.candidateValidationFeedback).toMatchObject({
            attempt: 1,
            issues: [{ path: "notes" }],
          })
          expect(iteration.candidate.generatedBy).toBe("llm")
          expect(iteration.candidate.candidateSpec.recipeID).toBe("recipe_llm_patch_mlp_candidate")
          expect(iteration.managerTrace.find((step) => step.role === "design")?.metadata).toMatchObject({
            generatedBy: "llm",
            llmProvider: "openai-compatible",
            llmStatus: "used",
          })
        },
      })
    } finally {
      globalThis.fetch = previousFetch
      if (previousProvider === undefined) delete process.env.NEO_CAST_LLM_PROVIDER
      else process.env.NEO_CAST_LLM_PROVIDER = previousProvider
      if (previousBaseURL === undefined) delete process.env.NEO_CAST_LLM_BASE_URL
      else process.env.NEO_CAST_LLM_BASE_URL = previousBaseURL
      if (previousModel === undefined) delete process.env.NEO_CAST_LLM_MODEL
      else process.env.NEO_CAST_LLM_MODEL = previousModel
      if (previousKey === undefined) delete process.env.NEO_CAST_LLM_API_KEY
      else process.env.NEO_CAST_LLM_API_KEY = previousKey
    }
  })

  test("uses same-domain benchmark memory for autonomous proposal ranking", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const datasetPath = await writeProfileDataset()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeTrainingFakeNeoCastRunner(fakeNeoCastRoot)

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

        await createSearchHypothesis(task.id)
        for (let index = 0; index < 3; index++) {
          await runResearch(
            Research.Service.use((svc) =>
              svc.runAutonomousIteration({
                taskID: task.id,
                stage: "full",
                description: `baseline ${index + 1}`,
              }),
            ),
          )
        }

        const iteration = await runResearch(
          Research.Service.use((svc) =>
            svc.runAutonomousIteration({
              taskID: task.id,
              stage: "full",
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
	          learnedRankerTrainingExamples: 11,
	          learnedRankerPositiveExamples: 6,
	          learnedRankerNegativeExamples: 5,
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
        await writeTrainingFakeNeoCastRunner(fakeNeoCastRoot)
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

        await createSearchHypothesis(task.id)
        for (let index = 0; index < 3; index++) {
          await runResearch(
            Research.Service.use((svc) =>
              svc.runAutonomousIteration({
                taskID: task.id,
                stage: "full",
                description: `baseline ${index + 1}`,
              }),
            ),
          )
        }

        const iteration = await runResearch(
          Research.Service.use((svc) =>
            svc.runAutonomousIteration({
              taskID: task.id,
              stage: "full",
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

  test("runNASAgent produces nas_experiment_log_md artifact and iterationSummaries with hypothesis", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const datasetPath = await writeProfileDataset()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast-nas-log")
        await writeFakeNeoCastRunner(fakeNeoCastRoot)

        const task = await createTSFTask(
          "NAS agent experiment log task",
          {
            bridgeOnly: true,
            neoCastProjectRoot: fakeNeoCastRoot,
            pythonExecutable: "bash",
            datasetPath,
          },
          "autonomous",
        )

        const result = await runResearch(
          Research.Service.use((svc) =>
            svc.runNASAgent({
              taskID: task.id,
              stage: "smoke",
              maxIterations: 1,
            }),
          ),
        )

        expect(result.iterationCount).toBe(1)
        expect(result.iterationSummaries).toHaveLength(1)
        const summary = result.iterationSummaries[0]!
        expect(summary.iterationIndex).toBe(1)
        expect(summary.candidateID).toBeTruthy()
        expect(typeof summary.hypothesis).toBe("string")
        expect(summary.hypothesis.length).toBeGreaterThan(0)
        expect(typeof summary.runStatus).toBe("string")
        expect(result.experimentLogMarkdown).toContain("# Experiment Log")
        expect(result.experimentLogMarkdown).toContain(task.id)
        expect(result.experimentLogMarkdown).toContain("## Hypotheses")

        const artifacts = await runResearch(Research.Service.use((svc) => svc.listArtifacts(task.id)))
        const logArtifact = artifacts.find((artifact) => artifact.kind === "nas_experiment_log_md")
        expect(logArtifact).toBeDefined()
        expect(logArtifact?.uri).toMatch(/^file:\/\//)
        const logContent = await readFile(logArtifact!.uri.replace("file://", ""), "utf8")
        expect(logContent).toContain("# Experiment Log")
        expect(logArtifact!.uri.replace("file://", "")).toEndWith(
          path.join(".neo-research", "sessions", task.id, "experiments", "experiment_log.md"),
        )
        expect(artifacts.map((artifact) => artifact.kind)).toEqual(
          expect.arrayContaining([
            "nas_model_search_plan_md",
            "nas_leaderboard_md",
            "nas_search_space_yaml",
            "nas_best_model_config_yaml",
            "nas_best_model_py",
            "nas_training_script_py",
            "nas_evaluation_result_md",
            "nas_reflection_notes_md",
          ]),
        )
        const searchPlan = artifacts.find((artifact) => artifact.kind === "nas_model_search_plan_md")!
        const leaderboard = artifacts.find((artifact) => artifact.kind === "nas_leaderboard_md")!
        const searchSpace = artifacts.find((artifact) => artifact.kind === "nas_search_space_yaml")!
        const bestModel = artifacts.find((artifact) => artifact.kind === "nas_best_model_py")!
        const trainingScript = artifacts.find((artifact) => artifact.kind === "nas_training_script_py")!
        expect(searchPlan.uri.replace("file://", "")).toEndWith(
          path.join(".neo-research", "sessions", task.id, "experiments", "model_search_plan.md"),
        )
        expect(leaderboard.uri.replace("file://", "")).toEndWith(
          path.join(".neo-research", "sessions", task.id, "experiments", "leaderboard.md"),
        )
        expect(searchSpace.uri.replace("file://", "")).toEndWith(
          path.join(".neo-research", "sessions", task.id, "configs", "search_space.yaml"),
        )
        expect(bestModel.uri.replace("file://", "")).toEndWith(
          path.join(".neo-research", "sessions", task.id, "model", "best_model.py"),
        )
        expect(trainingScript.uri.replace("file://", "")).toEndWith(
          path.join(".neo-research", "sessions", task.id, "model", "training_script.py"),
        )
        expect(await readFile(leaderboard.uri.replace("file://", ""), "utf8")).toContain("| Rank |")
        expect(await readFile(searchSpace.uri.replace("file://", ""), "utf8")).toContain("schema_version: neo_research_search_space.v1")
        expect(await readFile(bestModel.uri.replace("file://", ""), "utf8")).toContain("class BestModel")
        expect(await readFile(trainingScript.uri.replace("file://", ""), "utf8")).toContain("def train")
      },
    })
  })

  test("NASAgentResult iterationSummaries extract hypothesis from candidateSpec", () => {
    const { buildNASAgentResult } = Research
    const fakeLoop: Research.AutonomousLoopResult = {
      stoppedReason: "max_iterations",
      artifact: {
        id: "art_1" as Research.ResearchArtifactID,
        taskID: "task_1" as Research.ResearchTaskID,
        runID: undefined,
        kind: "research_autonomous_loop_json",
        uri: "file:///tmp/loop.json",
        metadata: {},
        time: { created: Date.now(), updated: Date.now() },
      },
      iterations: [
        {
          candidate: {
            id: "cand_1" as Research.ResearchCandidateID,
            taskID: "task_1" as Research.ResearchTaskID,
            parentCandidateID: undefined,
            domainID: "tsf",
            candidateSpec: {
              recipeVersion: "recipe_schema_v2",
              recipeID: "tsf_linear_raw_baseline",
              hypothesis: "A raw linear temporal baseline should establish the simplest forecasting floor.",
              notes: "Seeded baseline candidate",
            } as Research.JsonRecord,
            rationale: "baseline",
            riskLevel: "low",
            approvalStatus: "auto_approved",
            generatedBy: "heuristic",
            time: { created: Date.now(), updated: Date.now() },
          },
          seededCandidates: [],
          approvals: [],
          managerTrace: [],
          run: {
            id: "run_1" as Research.ResearchRunID,
            taskID: "task_1" as Research.ResearchTaskID,
            candidateID: "cand_1" as Research.ResearchCandidateID,
            status: "succeeded",
            stage: "smoke",
            metrics: { val_avg_mse: 0.15 } as Research.JsonRecord,
            resourceUsage: {} as Research.JsonRecord,
            artifactRefs: [],
            error: undefined,
            timeStarted: undefined,
            timeFinished: undefined,
            time: { created: Date.now(), updated: Date.now() },
          },
          runPlan: {} as Research.DomainRunPlan,
          selectionArtifact: {
            id: "art_sel_1" as Research.ResearchArtifactID,
            taskID: "task_1" as Research.ResearchTaskID,
            runID: undefined,
            kind: "research_candidate_selection_json",
            uri: "file:///tmp/sel.json",
            metadata: { selectionSource: "domain_proposal" } as Research.JsonRecord,
            time: { created: Date.now(), updated: Date.now() },
          },
        },
      ],
    }

    const result = buildNASAgentResult({
      taskID: "task_1" as Research.ResearchTaskID,
      loop: fakeLoop,
      primaryMetricName: "val_avg_mse",
      direction: "minimize",
    })

    expect(result.agent).toBe("NASAgent")
    expect(result.iterationCount).toBe(1)
    expect(result.succeededCount).toBe(1)
    expect(result.failedCount).toBe(0)
    expect(result.iterationSummaries).toHaveLength(1)
    const summary = result.iterationSummaries[0]!
    expect(summary.hypothesis).toBe("A raw linear temporal baseline should establish the simplest forecasting floor.")
    expect(summary.mutationRationale).toBe("Seeded baseline candidate")
    expect(summary.recipeID).toBe("tsf_linear_raw_baseline")
    expect(summary.generatedBy).toBe("heuristic")
    expect(summary.selectionSource).toBe("domain_proposal")
    expect(summary.primaryMetric).toBe(0.15)
    expect(summary.deltaVsChampion).toBeUndefined()
    expect(summary.deltaVsPrevious).toBeUndefined()
    expect(result.experimentLogMarkdown).toContain("# Experiment Log")
    expect(result.experimentLogMarkdown).toContain("tsf_linear_raw_baseline")
    expect(result.experimentLogMarkdown).toContain("A raw linear temporal baseline")
  })
})
