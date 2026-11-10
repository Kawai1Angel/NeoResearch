import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { summarizeTSFTask } from "../../src/research/domains/tsf"

const hash = (text: string) => createHash("sha256").update(text).digest("hex")

test("profile ignores shared CSV and validates workspace source and prepared fingerprints", async () => {
  await using tmp = await tmpdir()
  const workspaceRoot = path.join(tmp.path, "session-a")
  const root = path.join(workspaceRoot, ".neo-cast/dataset")
  const shared = path.join(tmp.path, "runner/.neo-cast/dataset")
  await mkdir(root, { recursive: true })
  await mkdir(shared, { recursive: true })
  const source = "date,OT\n2020-01-01,1\n2020-01-02,2\n2020-01-03,3\n"
  const train = "date,OT\n2020-01-01,1\n2020-01-02,2\n"
  await writeFile(path.join(tmp.path, "source.csv"), source)
  await writeFile(path.join(shared, "local_csv_train.csv"), "date,real_power\n2020-01-01,99\n")
  const task = { contextLength: 2, predictionLengths: [1], dataset: { loaderID: "local_csv", path: "source.csv", targetCols: ["OT"] }, runtime: { neoCastProjectRoot: path.join(tmp.path, "runner") } }
  const context = { taskID: "session-a", projectRoot: tmp.path, workspaceRoot }
  const initial = summarizeTSFTask(task, context).datasetProfile as any
  expect(initial.path).toBe(path.join(tmp.path, "source.csv"))
  expect(initial.sourceFingerprint).toBe(hash(source))
  expect(initial.taskID).toBe("session-a")
  const spec = JSON.stringify({ source_csv: path.join(tmp.path, "source.csv"), target_columns: ["OT"] })
  await writeFile(path.join(root, "dataset_spec.json"), spec)
  await writeFile(path.join(root, "local_csv_train.csv"), train)
  await writeFile(path.join(root, "profile_provenance.json"), JSON.stringify({ source_sha256: hash(source), train_sha256: hash(train), spec_sha256: hash(spec) }))
  const prepared = summarizeTSFTask(task, context).datasetProfile as any
  expect(prepared.path).toBe(path.join(root, "local_csv_train.csv"))
  expect(prepared.sourceFingerprint).toBe(initial.sourceFingerprint)
  expect(prepared.profileFingerprint).not.toBe(initial.profileFingerprint)
  const other = summarizeTSFTask(task, { ...context, taskID: "session-b", workspaceRoot: path.join(tmp.path, "session-b") }).datasetProfile as any
  expect(other.path).toBe(path.join(tmp.path, "source.csv"))
  await writeFile(path.join(root, "local_csv_train.csv"), train.replace(",2", ",99"))
  expect(summarizeTSFTask(task, context).datasetProfileWarning).toMatchObject({ code: "unverified_training_data" })
  await writeFile(path.join(root, "local_csv_train.csv"), train)
  await writeFile(path.join(tmp.path, "source.csv"), source.replace(",3", ",99"))
  const changed = summarizeTSFTask(task, context)
  expect(changed.datasetProfileWarning).toMatchObject({ code: "unverified_training_data" })
  expect((changed.datasetProfile as any).sourceFingerprint).not.toBe(initial.sourceFingerprint)
})

test("missing targets cannot fall back to unrelated numeric columns or stale metadata", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "source.csv")
  await writeFile(source, "date,real_power\n2020-01-01,99\n")
  const result = summarizeTSFTask({ contextLength: 2, predictionLengths: [1], dataset: { loaderID: "local_csv", path: source, targetCols: ["OT"] }, metadata: { datasetProfile: { path: "/stale.csv", targetCount: 7 } } })
  expect(result.datasetProfile).toBeUndefined()
  expect(result.datasetProfileWarning).toMatchObject({ code: "missing_target_columns" })
})
