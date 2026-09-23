import { expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { pathToFileURL, fileURLToPath } from "node:url"
import path from "node:path"
import { appendLog, recordResearchEvent, snapshotPhaseArtifact } from "../../src/research/log-archive"
import { tmpdir } from "../fixture/fixture"

test("phase artifacts retain previous content after the working report is overwritten", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "hypo_plan.md")
  const input = { taskID: "task", kind: "hypo_plan_md", uri: pathToFileURL(source).href }
  await writeFile(source, "first")
  const first = await snapshotPhaseArtifact(tmp.path, input)
  await writeFile(source, "second")
  const second = await snapshotPhaseArtifact(tmp.path, input)
  expect(first!.uri).not.toBe(second!.uri)
  expect(await readFile(fileURLToPath(first!.uri), "utf8")).toBe("first")
  expect(await readFile(fileURLToPath(second!.uri), "utf8")).toBe("second")
  expect(first!.sha256).not.toBe(second!.sha256)
})

test("research events persist immediately and preserve tool failure details", async () => {
  await using tmp = await tmpdir()
  recordResearchEvent(tmp.path, "research.agent.intent.part.updated", {
    taskID: "task", toolState: "error", toolError: "fixture failure",
  })
  const raw = await readFile(path.join(tmp.path, ".neo-research/logs/task/events.jsonl"), "utf8")
  expect(JSON.parse(raw).properties.toolError).toBe("fixture failure")
})

test("runner output survives abrupt process death before completion", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "progress.jsonl")
  const module = path.resolve(import.meta.dir, "../../src/research/log-archive.ts")
  const code = `import { appendLog } from ${JSON.stringify(module)};
    appendLog(${JSON.stringify(file)}, { stream: "stderr", line: "before crash" });
    process.kill(process.pid, "SIGKILL");`
  const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" })
  expect(await child.exited).not.toBe(0)
  expect(JSON.parse(await readFile(file, "utf8")).line).toBe("before crash")
  appendLog(file, { event: "recovered" })
  expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(2)
})
