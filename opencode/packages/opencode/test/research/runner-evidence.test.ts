import { expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { buildExperimentResultEvidence, extractTrainingCurve, runnerFailureEvidence, recoverRunnerFailure } from "../../src/research/runner-evidence"

test("interleaved folds and horizons retain separate endpoints when sampled", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "progress.jsonl")
  const records = []
  for (const epoch of [3, 1, 2]) {
    for (const cv_fold_index of [0, 1]) {
      for (const horizon of [96, 720]) {
        records.push({ line: JSON.stringify({ event: "epoch_end", epoch, cv_fold_index, horizon, val_loss: 10 + cv_fold_index - epoch }) })
      }
    }
  }
  records.push({ line: JSON.stringify({ event: "epoch_end", epoch: 1, horizon: 96, val_loss: 0.4 }) })
  await writeFile(file, records.map((r) => JSON.stringify(r)).join("\n"))
  const curve = await extractTrainingCurve(file, 2)
  expect(curve).toHaveLength(9)
  for (const foldIndex of [0, 1]) {
    for (const horizon of [96, 720]) {
      expect(curve.filter((p) => p.foldIndex === foldIndex && p.horizon === horizon).map((p) => p.epoch)).toEqual([1, 3])
    }
  }
  expect(curve.at(-1)).toMatchObject({ phase: "standard", valLoss: 0.4 })
  const last = await extractTrainingCurve(file, 1)
  expect(last).toHaveLength(5)
  expect(last.filter((p) => p.phase === "cv").every((p) => p.epoch === 3)).toBe(true)
})

test("failure evidence keeps stdout root cause ahead of generic wrapper and stderr", () => {
  const error = runnerFailureEvidence({
    records: [
      { event: "epoch_end", val_loss: 0.3 },
      { event: "error", kind: "valueerror", message: "recipe_factory requires recipe_schema_v2" },
      { event: "error", kind: "runtimeerror", message: "Standard training failed with exit code 1" },
    ], stdout: "", stderr: "warning: unrelated", exitCode: 1,
  })
  expect(error.split("\n")[0]).toContain("recipe_schema_v2")
  expect(error).toContain("Standard training failed")
  expect(error).toContain("stderr:")
  expect(runnerFailureEvidence({ records: [], stdout: "error: Unknown payload kind\n", stderr: "", exitCode: 2 })).toBe("error: Unknown payload kind")
  expect(runnerFailureEvidence({ records: [], stdout: "", stderr: "", exitCode: 1 })).toBe("Runner exited with code 1")
})


test("historical generic failures recover the exact stdout error from saved execution", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "execution.json")
  await writeFile(file, JSON.stringify({ records: [], stdout: "error: Unknown payload kind\n", stderr: "", exitCode: 2 }))
  expect(await recoverRunnerFailure(file, "Runner exited with code 2")).toBe("error: Unknown payload kind")
  expect(await recoverRunnerFailure(file + ".missing", "original error")).toBe("original error")
  await writeFile(file, JSON.stringify({ records: [{ event: "done", status: "success" }], stdout: "", stderr: "warning", exitCode: 0 }))
  expect(await recoverRunnerFailure(file, "execution contract mismatch")).toBe("execution contract mismatch")
})

test("reflection evidence includes executed optimizer settings and never exposes partial metrics as a comparison", () => {
  const candidateSpec = {
    backbone: { type: "mamba", depth: 2 },
    trainingStrategy: { optimizer: { type: "adam", lr: 0.0001 }, scheduler: { warmupSteps: 0 }, regularization: { gradClip: 1 } },
    notes: "Long narrative", hypothesis: "test Mamba",
  }
  const input = { runID: "partial", stage: "full", status: "succeeded", primaryMetric: "cv_avg_mse",
    metrics: { val_avg_mse: 0.01 }, candidateSpec, hypothesisID: "H1", error: "Runner command timeout" }
  const partial = buildExperimentResultEvidence(input)
  expect(partial.evidence_disposition).toBe("inconclusive")
  expect(partial.evaluationIssue).toContain("cv_avg_mse")
  expect(partial.error).toContain("timeout")
  expect(partial.modelDesign).toEqual({ backbone: candidateSpec.backbone, trainingStrategy: candidateSpec.trainingStrategy })
  expect(partial.hypoID).toBe("H1")
  expect(partial).not.toHaveProperty("cv_avg_mse")
  const complete = buildExperimentResultEvidence({ ...input, metrics: { cv_avg_mse: 0.4 }, error: undefined })
  expect(complete.evidence_disposition).toBe("complete")
  expect(complete).toHaveProperty("cv_avg_mse", 0.4)
  for (const status of ["invalid", "failed", "rejected"]) {
    expect(buildExperimentResultEvidence({ ...input, status, metrics: { cv_avg_mse: 0.001 } })).not.toHaveProperty("cv_avg_mse")
  }
  expect(buildExperimentResultEvidence({ ...input, metrics: { cv_avg_mse: Number.NaN } }).evidence_disposition).toBe("inconclusive")
  const cached = buildExperimentResultEvidence({ ...input, independentEvidence: false })
  expect(cached.evidence_disposition).toBe("duplicate")
  expect(cached.evaluationIssue).toBeUndefined()
})
