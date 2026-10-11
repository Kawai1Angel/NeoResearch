import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { RetrieveAgent, type RetrieveAgentInput } from "./retrieve/retrieve-agent"
import { RetrieveResultSchema, TaskEvidenceBundleSchema } from "./retrieve/contract"
import { ConfiguredPrincipleModel } from "./literature/principle-model"
import { LiteratureAgent } from "./literature/literature-agent"
import { DocumentChunkSchema } from "./literature/contract"
import { citableTaskEvidence } from "./retrieve/evidence-handoff"

export function literatureDigest(value: unknown): string {
  // Receipts describe JSON artifacts. Normalize first so optional undefined
  // fields hash the same before and after the artifact is written to disk.
  const serialized = JSON.parse(JSON.stringify(value))
  const stable = (v: unknown): string => Array.isArray(v) ? `[${v.map(stable).join(",")}]`
    : v && typeof v === "object" ? `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(",")}}`
    : JSON.stringify(v)
  return createHash("sha256").update(stable(serialized)).digest("hex")
}

export const LiteratureReceiptSchema = z.object({
  schemaVersion: z.literal("literature_tool_receipt_v1"), taskID: z.string(),
  quantitativeReportArtifactID: z.string(), retrieveRunID: z.string().regex(/^retrieve_[a-f0-9]{16}$/),
  resultDigest: z.string().regex(/^[a-f0-9]{64}$/),
  readiness: z.enum(["ready_with_evidence", "ready_data_only", "partial_evidence", "evidence_conflict"]),
  cached: z.boolean(),
  summary: RetrieveResultSchema.shape.summary,
  selectedEntryCount: z.number().int().nonnegative(), gapCount: z.number().int().nonnegative(),
}).strict()
export type LiteratureReceipt = z.infer<typeof LiteratureReceiptSchema>
export type LiteratureProgress = { step: "prepare_intents" | "search" | "select" | "parse" | "extract" | "verify" | "assemble_evidence" | "recall_architecture" | "distill_architecture" | "review_architecture"; paperID?: string; status: string; cached?: boolean; counts?: Record<string, number> }

// Serialize writers sharing a KnowledgeStore, including different tasks/runs.
const writers = new Map<string, Promise<unknown>>()
async function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = writers.get(key) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(fn)
  writers.set(key, current)
  try { return await current } finally { if (writers.get(key) === current) writers.delete(key) }
}

export async function createLiteraturePhase(input: {
  neoCastRoot: string; workspaceRoot: string; taskID: string; run: RetrieveAgentInput
  onProgress?: (progress: LiteratureProgress) => Promise<void>
}) {
  const config = { neoCastRoot: input.neoCastRoot, workspaceRoot: input.workspaceRoot }
  const principleModel = await ConfiguredPrincipleModel.create(config)
  let snapshot = await serialize(path.resolve(input.neoCastRoot), async () => {
    const agent = new RetrieveAgent({ ...config, principleModel })
    return agent.prepare(input.run).finally(() => agent.close())
  })
  if (snapshot.report.taskID !== input.taskID) throw new Error("Quantitative report task mismatch")
  const runRoot = () => path.join(input.neoCastRoot, ".neo-cast", "literature-retrieval", "runs", snapshot.retrieveRunID)
  let execution: Promise<LiteratureReceipt> | undefined
  let started = false
  const parsedPapers = new Map<string, Promise<Awaited<ReturnType<LiteratureAgent["parseOnly"]>>>>()
  const refreshSnapshot = async () => {
    if (execution) return
    await serialize(path.resolve(input.neoCastRoot), async () => {
      if (execution) return
      const reader = new RetrieveAgent({ ...config, principleModel })
      snapshot = await reader.prepare({ ...input.run, quantitativeReport: snapshot.report }).finally(() => reader.close())
    })
  }
  const validate = async (raw: unknown) => {
    const receipt = LiteratureReceiptSchema.parse(raw)
    const result = RetrieveResultSchema.parse(JSON.parse(await readFile(path.join(runRoot(), "retrieve_result.json"), "utf8")))
    const bundle = TaskEvidenceBundleSchema.parse(JSON.parse(await readFile(path.join(runRoot(), "task_evidence_bundle.json"), "utf8")))
    const manifest = JSON.parse(await readFile(path.join(runRoot(), "run_manifest.json"), "utf8"))
    if (bundle.schemaVersion !== "task_evidence_bundle_v2") throw new Error("Legacy evidence requires v2 retrieval")
    if (receipt.taskID !== input.taskID || receipt.quantitativeReportArtifactID !== snapshot.quantitativeReportArtifactID
      || receipt.retrieveRunID !== snapshot.retrieveRunID || result.taskID !== input.taskID
      || result.quantitativeReportArtifactID !== snapshot.quantitativeReportArtifactID
      || bundle.taskID !== input.taskID || bundle.quantitativeReportArtifactID !== snapshot.quantitativeReportArtifactID
      || bundle.retrieveRunID !== snapshot.retrieveRunID
      || result.retrieveRunID !== snapshot.retrieveRunID || bundle.taskContextDigest !== snapshot.contextDigest
      || manifest.runDigest !== snapshot.runDigest || manifest.reportDigest !== snapshot.reportDigest
      || manifest.taskContextDigest !== snapshot.contextDigest || manifest.indexDigest !== snapshot.index.indexDigest
      || receipt.readiness !== bundle.readiness || receipt.gapCount !== bundle.gaps.length
      || receipt.selectedEntryCount !== citableTaskEvidence(bundle).length || literatureDigest(receipt.summary) !== literatureDigest(result.summary)
      || literatureDigest(result.taskEvidence) !== literatureDigest(bundle) || literatureDigest(result) !== receipt.resultDigest) {
      throw new Error("Literature receipt/bundle provenance mismatch")
    }
    return result
  }
  const execute = (signal?: AbortSignal) => execution ??= serialize(path.resolve(input.neoCastRoot), async () => {
    signal?.throwIfAborted()
    started = true
    let cached = false
    const runner = new RetrieveAgent({ ...config, principleModel, signal, onProgress: async (progress) => {
      signal?.throwIfAborted()
      if (progress.cached) cached = true
      await input.onProgress?.(progress)
      signal?.throwIfAborted()
    } })
    const result = await (async () => {
      snapshot = await runner.prepare({ ...input.run, quantitativeReport: snapshot.report })
      signal?.throwIfAborted()
      return runner.run({ ...input.run, quantitativeReport: snapshot.report }, snapshot)
    })().finally(() => runner.close())
    signal?.throwIfAborted()
    const receipt = LiteratureReceiptSchema.parse({ schemaVersion: "literature_tool_receipt_v1", taskID: input.taskID,
      quantitativeReportArtifactID: snapshot.quantitativeReportArtifactID, retrieveRunID: result.retrieveRunID,
      resultDigest: literatureDigest(result), cached, summary: result.summary, readiness: result.taskEvidence.readiness,
      selectedEntryCount: citableTaskEvidence(result.taskEvidence).length, gapCount: result.taskEvidence.gaps.length })
    await validate(receipt)
    signal?.throwIfAborted()
    return receipt
  })
  return {
    taskID: input.taskID, get snapshot() { return snapshot }, execute, validate, refreshSnapshot,
    get started() { return started || execution !== undefined },
    // Reconcile the same operation after a provider failure; never launch a second writer.
    reconcile: () => execution,
    async readPaper(paperID: string, offset: number, limit: number) {
      await refreshSnapshot()
      if (!snapshot.selectedCandidates.some((paper) => paper.paperID === paperID)) throw new Error("Paper is not an approved candidate")
      const key = `${snapshot.index.indexDigest}:${paperID}`
      const pending = parsedPapers.get(key) ?? serialize(path.resolve(input.neoCastRoot), async () => {
        const parser = new LiteratureAgent(config)
        return parser.parseOnly({ kind: "catalog_paper", paperID }).finally(() => parser.close())
      })
      parsedPapers.set(key, pending)
      const parsed = await pending
      const chunks = (await readFile(parsed.chunksPath, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => DocumentChunkSchema.parse(JSON.parse(line)))
      return { paperID, untrustedDocument: true, warningCount: parsed.warningCount, total: chunks.length,
        chunks: chunks.slice(offset, offset + limit).map(({ chunkID, pageStart, pageEnd, sectionKind, text }) =>
          ({ chunkID, pageStart, pageEnd, sectionKind, text: text.slice(0, 1500) })),
        nextOffset: offset + limit < chunks.length ? offset + limit : null }
    },
  }
}
export type LiteraturePhase = Awaited<ReturnType<typeof createLiteraturePhase>>
const bindings = new Map<string, LiteraturePhase>()
export function bindLiteratureSession(sessionID: string, phase: LiteraturePhase) {
  if (bindings.has(sessionID)) throw new Error("Literature session already bound")
  bindings.set(sessionID, phase)
  return () => { bindings.delete(sessionID) }
}
export function literatureSession(sessionID: string, agent: string) {
  const phase = bindings.get(sessionID)
  if (agent !== "research-literature" || !phase) throw new Error("Literature tool requires an active bound Literature child session")
  return phase
}
