import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, mkdtemp, readFile, writeFile } from "fs/promises"
import { tmpdir as osTmpdir } from "os"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Research } from "../../src/research"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

function runResearch<A, E>(fx: Effect.Effect<A, E, Research.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(Research.defaultLayer)))
}

function validTsfTaskSpec(runtime: Research.JsonRecord = {}) {
  const datasetPath = typeof runtime.datasetPath === "string" ? runtime.datasetPath : undefined
  const { datasetPath: _datasetPath, ...runnerRuntime } = runtime
  return {
    contextLength: 12,
    predictionLengths: [8],
    dataset: {
      loaderID: "local_csv",
      ...(datasetPath === undefined ? {} : { path: datasetPath }),
      targetCols: ["a", "b"],
    },
    runtime: runnerRuntime,
    metadata: {
      businessContext: "TSF alpha e2e smoke",
      interpretability: "none_required",
      deploymentTarget: "local_research",
    },
  }
}

async function writeProfileDataset() {
  const root = await mkdtemp(path.join(osTmpdir(), "opencode-research-e2e-"))
  const csvPath = path.join(root, "train.csv")
  const lines = ["date,a,b,c"]
  for (let index = 0; index < 96; index++) {
    const seasonal = index % 24
    const trend = index * 0.25
    lines.push(`2024-01-${String((index % 28) + 1).padStart(2, "0")},${trend + seasonal},${trend + seasonal * 2},${trend}`)
  }
  await writeFile(csvPath, `${lines.join("\n")}\n`, "utf8")
  return csvPath
}

async function writeMockNeoCastRunner(root: string) {
  await mkdir(path.join(root, "bin"), { recursive: true })
  await mkdir(path.join(root, "py"), { recursive: true })
  await writeFile(path.join(root, "pyproject.toml"), "[project]\nname = \"fake-neo-cast\"\n", "utf8")
  await writeFile(path.join(root, "py", "prepare_tsf.py"), "PREPROCESS_VERSION = 1\n", "utf8")
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
const inputLen = Number(value("--input-len") || 12)
const horizons = String(value("--horizons") || "8").split(",").map((item) => Number(item))
const featureColumns = String(value("--feature-cols") || "a,b").split(",").filter(Boolean)
fs.mkdirSync(".neo-cast/dataset", { recursive: true })
const spec = {
  schema_version: "dataset.v1",
  source_csv: path.resolve(source),
  task_id: value("--task-id") || "local_csv",
  timestamp_col: "date",
  feature_columns: featureColumns,
  input_len: inputLen,
  horizons,
  splits: { train: [0, 58], val: [58, 77], ref_test: [77, 96] },
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
  await writeFile(
    path.join(root, "py", "validate.py"),
    `#!/usr/bin/env bash
set -euo pipefail
candidate_id="mock_candidate"
run_suffix="$(printf '%s' "$candidate_id" | tr -cd '[:alnum:]_-' | cut -c1-32)"
if [[ -z "$run_suffix" ]]; then run_suffix="mock"; fi
artifact_dir="$(pwd)/.neo-cast/artifacts/run_$run_suffix"
mkdir -p "$artifact_dir"
cat > "$artifact_dir/val_metrics.json" <<'JSON'
{"val_avg_mse":0.123,"val_avg_mae":0.456}
JSON
printf 'weights\\n' > "$artifact_dir/model.pt"
printf '# model\\n' > "$artifact_dir/model_impl.py"
printf '# inference\\n' > "$artifact_dir/inference.py"
printf '{"model_family":"mock"}\\n' > "$artifact_dir/metadata.json"
printf '{"recipe_id":"%s"}\\n' "$candidate_id" > "$artifact_dir/model_spec.json"
printf '{"schema_version":"patch_bundle.v1"}\\n' > "$artifact_dir/patch_bundle.json"
printf '{"input_len":12}\\n' > "$artifact_dir/preprocess.json"
printf '{"name":"forecast"}\\n' > "$artifact_dir/tool_schema.json"
printf 'torch\\nnumpy\\n' > "$artifact_dir/requirements.txt"
printf '# Exported model\\n' > "$artifact_dir/README.md"
printf '# Example\\n' > "$artifact_dir/example.py"
printf '# Eval\\n' > "$artifact_dir/eval_report.md"
printf '{"event":"candidate_resolved","candidate_id":"%s"}\\n' "$candidate_id"
printf '{"event":"smoke_eval_done","val_avg_mse":0.123,"val_avg_mae":0.456}\\n'
printf '{"event":"artifact_ready","run_id":"%s","artifact_dir":"%s"}\\n' "$run_suffix" "$artifact_dir"
printf '{"event":"done","status":"success"}\\n'
`,
    "utf8",
  )
}

afterEach(async () => {
  await resetDatabase()
})

describe("AutoResearch alpha e2e smoke", () => {
  test("prepares data, completes two mock loop iterations, selects champion, and exports a reproducible bundle", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const datasetPath = await writeProfileDataset()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeMockNeoCastRunner(fakeNeoCastRoot)

        const task = await runResearch(
          Research.Service.use((svc) =>
            svc.createTask({
              title: "ETTh1 mock alpha e2e",
              domainID: "tsf",
              mode: "autonomous",
              taskSpec: validTsfTaskSpec({
                bridgeOnly: true,
                datasetPath,
                neoCastProjectRoot: fakeNeoCastRoot,
                pythonExecutable: "bash",
              }),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 5 },
            }),
          ),
        )

        const prepared = await runResearch(Research.Service.use((svc) => svc.prepareTaskDataset({ taskID: task.id })))
        expect(prepared.datasetSpec).toMatchObject({
          source_csv: path.resolve(datasetPath),
          input_len: 12,
          horizons: [8],
          feature_columns: ["a", "b"],
        })

        const loop = await runResearch(
          Research.Service.use((svc) =>
            svc.runAutonomousLoop({
              taskID: task.id,
              stage: "smoke",
              maxIterations: 2,
              maxNoImprove: 5,
              description: "alpha e2e mock loop",
            }),
          ),
        )

        expect(loop.stoppedReason).toBe("max_iterations")
        expect(loop.iterations).toHaveLength(2)
        expect(loop.iterations.every((iteration) => iteration.run.status === "succeeded")).toBe(true)

        const champion = await runResearch(Research.Service.use((svc) => svc.getChampion(task.id)))
        expect(champion).toBeDefined()
        expect(champion?.primaryMetric).toBeGreaterThan(0)

        const exported = await runResearch(
          Research.Service.use((svc) =>
            svc.exportTaskArtifact({
              taskID: task.id,
              kind: "research_final_bundle",
              outputDir: ".neo-research/final",
            }),
          ),
        )
        const manifest = JSON.parse(await readFile(path.join(exported.path, "manifest.json"), "utf8"))
        expect(manifest.champion.candidateID).toBe(champion?.candidateID)
        expect(manifest.files).toMatchObject({
          manifest: "manifest.json",
          champion: "results/champion.json",
          runs: "results/runs.json",
          modelWeights: "model/model.pt",
        })
        expect(manifest.reproducibility).toMatchObject({
          gitSHA: expect.any(String),
          datasetSHA: expect.any(String),
          lockHash: expect.any(String),
          preprocessSHA: expect.any(String),
        })
      },
    })
  })
})
