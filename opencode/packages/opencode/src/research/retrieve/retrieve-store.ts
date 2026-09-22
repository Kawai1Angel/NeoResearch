import { access, mkdir, readFile, rename, writeFile } from "fs/promises"
import path from "path"
import { RetrieveResultSchema, type RetrieveResult } from "./contract"
import { renderRetrieveReport } from "./report-renderer"

async function exists(file: string) {
  try { await access(file); return true } catch { return false }
}

async function atomicWrite(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}`
  await writeFile(temporary, content, "utf8")
  await rename(temporary, file)
}

function json(value: unknown) { return `${JSON.stringify(value, null, 2)}\n` }
function jsonl(values: readonly unknown[]) { return values.map((item) => JSON.stringify(item)).join("\n") + (values.length ? "\n" : "") }

export class RetrieveStore {
  readonly retrievalRoot: string

  constructor(retrievalRoot: string) {
    this.retrievalRoot = path.resolve(retrievalRoot)
  }

  runRoot(runID: string) { return path.join(this.retrievalRoot, "runs", runID) }

  async loadResult(runID: string): Promise<RetrieveResult | undefined> {
    const file = path.join(this.runRoot(runID), "retrieve_result.json")
    if (!(await exists(file))) return undefined
    return RetrieveResultSchema.parse(JSON.parse(await readFile(file, "utf8")))
  }

  async save(input: {
    readonly result: RetrieveResult
    readonly runInput: unknown
    readonly datasetEvidence: readonly unknown[]
    readonly selectedCandidates: readonly unknown[]
    readonly manifest: unknown
  }) {
    const runRoot = this.runRoot(input.result.retrieveRunID)
    await Promise.all([
      atomicWrite(path.join(runRoot, "input.json"), json(input.runInput)),
      atomicWrite(path.join(runRoot, "dataset_evidence.json"), json(input.datasetEvidence)),
      atomicWrite(path.join(runRoot, "concept_transformations.json"), json(input.result.transformations)),
      atomicWrite(path.join(runRoot, "retrieval_intents.json"), json(input.result.intents)),
      atomicWrite(path.join(runRoot, "bm25_results.jsonl"), jsonl(input.result.candidates)),
      atomicWrite(path.join(runRoot, "selected_candidates.jsonl"), jsonl(input.selectedCandidates)),
      atomicWrite(path.join(runRoot, "literature_bridge_results.json"), json({ retrieveRunID: input.result.retrieveRunID, papers: input.result.literatureResults })),
      atomicWrite(path.join(runRoot, "task_evidence_bundle.json"), json(input.result.taskEvidence)),
      atomicWrite(path.join(runRoot, "task_evidence_excluded.jsonl"), jsonl(input.result.taskEvidence.excluded)),
      atomicWrite(path.join(runRoot, "retrieve_result.json"), json(input.result)),
      atomicWrite(path.join(runRoot, "report.md"), renderRetrieveReport(input.result)),
      atomicWrite(path.join(runRoot, "run_manifest.json"), json(input.manifest)),
    ])
    return runRoot
  }
}
