import { appendFileSync, mkdirSync } from "node:fs"
import { readFile, mkdir, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

// Append before returning to callers: a service crash must not discard buffered events.
// No fsync per token; this guarantees process-crash recovery, not power-loss durability.
export function appendLog(file: string, record: Record<string, unknown>) {
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...record }) + "\n", "utf8")
}

export function recordResearchEvent(root: string, kind: string, properties: unknown) {
  if (!kind.startsWith("research.")) return
  if (!properties || typeof properties !== "object") return
  const p = properties as {
    taskID?: string; task?: { id?: string }; run?: { taskID?: string }; candidate?: { taskID?: string }
    artifact?: { taskID?: string }; approval?: { taskID?: string }; memory?: { taskID?: string }; champion?: { taskID?: string }
  }
  const taskID = p.taskID ?? p.task?.id ?? p.run?.taskID ?? p.candidate?.taskID ?? p.artifact?.taskID ?? p.approval?.taskID ?? p.memory?.taskID ?? p.champion?.taskID
  if (typeof taskID !== "string" || !/^[\w-]+$/.test(taskID)) return
  appendLog(path.join(root, ".neo-research", "logs", taskID, "events.jsonl"), { kind, taskID, properties })
}

const versionedKinds = new Set([
  "intent_spec_markdown", "dataset_preparation_json", "task_profile_json",
  "dataset_quantitative_analysis_json", "dataset_quantitative_analysis_markdown",
  "dataset_qualitative_analysis_markdown", "dataset_main_analysis_markdown",
  "dataset_analysis_report", "dataset_analysis_plot_png", "hypo_plan_md", "hypotheses_yaml",
  "final_report_md", "publish_report_input_snapshot_json", "publish_agent_trace_json", "report_validation_json",
])

export async function snapshotPhaseArtifact(root: string, input: { taskID: string; kind: string; uri: string }) {
  if (!versionedKinds.has(input.kind) || !input.uri.startsWith("file://")) return undefined
  const source = fileURLToPath(input.uri)
  const content = await readFile(source)
  const directory = path.join(root, ".neo-research", "artifact-versions", input.taskID, randomUUID())
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, path.basename(source))
  await writeFile(file, content, { flag: "wx" })
  return { uri: pathToFileURL(file).href, sourceURI: input.uri, sha256: createHash("sha256").update(content).digest("hex") }
}
