#!/usr/bin/env bun
import path from "path"
import { createHash } from "crypto"
import { mkdir } from "fs/promises"
import { parseArgs } from "util"
import z from "zod"
import { KnowledgeCardV2Schema, type KnowledgeCardV2 } from "../literature/knowledge-v2-contract"
import { validateKnowledgeCardSeal } from "../literature/knowledge-v2-validator"
import { requestNeoCastLLM, resolveEffectiveLLMConfig } from "../llm-proposal"
import {
  ARCHITECTURE_KNOWLEDGE_VERSION, ArchitectureRecallSchema, ArchitectureExtractionSchema,
  ArchitectureReviewSchema, architectureKnowledgePrompt, decisionCardIDs,
  projectArchitectureSourceCard, validateRecallPartition, validateArchitectureExtraction,
  validateArchitectureReview, type ArchitectureDecision,
  parseArchitectureJSON,
} from "./architecture-knowledge"

const sha = (text: string) => createHash("sha256").update(text).digest("hex")

async function files(root: string, pattern: string) {
  return Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root, absolute: true })).catch(() => [] as string[])
}

async function main() {
  const { values } = parseArgs({ options: {
    "workspace-root": { type: "string" }, input: { type: "string" }, output: { type: "string" },
    "include-history": { type: "boolean", default: false }, "inventory-only": { type: "boolean", default: false },
    "selection-file": { type: "string" },
  } })
  if (!values["workspace-root"] || !values.input || !values.output) {
    throw new Error("Required: --workspace-root ROOT --input RETRIEVAL/input.json --output DIR [--include-history] [--inventory-only]")
  }
  const root = path.resolve(values["workspace-root"])
  const runtime = path.join(root, "neo_cast/.neo-cast")
  const output = path.resolve(values.output)
  await mkdir(output, { recursive: true })
  const task = await Bun.file(path.resolve(values.input)).json()
  const roots = [path.join(runtime, "literature-knowledge")]
  if (values["include-history"]) roots.push(path.join(runtime, "literature-reruns"), path.join(root, "docs"))
  const corpus = new Map<string, { card: KnowledgeCardV2; file: string; seal: string[] }>()
  const excluded: { file: string; cardID: string; reason: string }[] = []
  for (const folder of roots) {
    for (const file of (await files(folder, "**/*knowledge_cards_v2.jsonl")).sort()) {
      for (const line of (await Bun.file(file).text()).split(/\r?\n/).filter((x) => x.trim())) {
        const raw = JSON.parse(line)
        const parsed = KnowledgeCardV2Schema.safeParse(raw)
        if (!parsed.success) { excluded.push({ file, cardID: raw.knowledgeID ?? "unknown", reason: "invalid_card_schema" }); continue }
        const card = parsed.data
        const seal = validateKnowledgeCardSeal(card)
        if (seal.some((x) => x !== "provenance_version_mismatch")) {
          excluded.push({ file, cardID: card.knowledgeID, reason: seal.join(",") }); continue
        }
        // Historical versions are leads for a fresh source review, never published as active cards.
        if (!corpus.has(card.knowledgeID)) corpus.set(card.knowledgeID, { card, file, seal })
      }
    }
  }
  const chunks = new Map<string, { text: string; hash: string; documentID: string; paperID: string }>()
  for (const file of await files(runtime, "**/*.chunks.jsonl")) {
    const documentHash = path.basename(file).replace(/\.chunks\.jsonl$/, "")
    for (const line of (await Bun.file(file).text()).split(/\r?\n/).filter((x) => x.trim())) {
      const chunk = JSON.parse(line)
      const hash = sha(chunk.text)
      if (hash === chunk.textSha256) chunks.set(`${documentHash}/${chunk.chunkID}`, {
        text: chunk.text, hash, documentID: chunk.documentID, paperID: chunk.paperID,
      })
    }
  }
  for (const [id, item] of corpus) {
    const bad = item.card.sources.filter((source) => {
      const chunk = chunks.get(`${source.documentSha256}/${source.chunkID}`)
      if (!chunk || chunk.hash !== source.chunkSha256 || chunk.documentID !== source.documentID || chunk.paperID !== source.paperID) return true
      return source.spanStart !== undefined && source.spanEnd !== undefined
        ? chunk.text.slice(source.spanStart, source.spanEnd) !== source.quote
        : !chunk.text.includes(source.quote)
    })
    if (bad.length) {
      excluded.push({ file: item.file, cardID: id, reason: `unmatched_original_sources:${bad.map((s) => s.sourceID).join(",")}` })
      corpus.delete(id)
    }
  }
  const cards = [...corpus.values()].map((x) => x.card)
  const catalog = new Map<string, string>()
  for (const line of (await Bun.file(path.join(runtime, "literature-source/catalog/papers.jsonl")).text()).split(/\r?\n/).filter(Boolean)) {
    const paper = JSON.parse(line)
    catalog.set(paper.paperID, paper.title)
  }
  const inventory = {
    schemaVersion: ARCHITECTURE_KNOWLEDGE_VERSION, createdAt: new Date().toISOString(), task,
    totalCards: cards.length, paperCount: new Set(cards.map((c) => c.paperID)).size,
    cards: [...corpus.values()].map((x) => ({ cardID: x.card.knowledgeID, revision: x.card.revision,
      paperID: x.card.paperID, title: catalog.get(x.card.paperID), file: path.relative(root, x.file),
      seal: x.seal.length ? "historical_version_sources_rechecked" : "current", sourceCount: x.card.sources.length,
    })), excluded,
  }
  await Bun.write(path.join(output, "inventory.json"), JSON.stringify(inventory, null, 2))
  await Bun.write(path.join(output, "source_cards.jsonl"), cards.map((c) => JSON.stringify(c)).join("\n") + "\n")
  console.log(JSON.stringify({ phase: "inventory", cards: cards.length, papers: inventory.paperCount, excluded: excluded.length }))
  if (values["inventory-only"]) return
  if (!cards.length) throw new Error("No cards with verified original spans")
  const resolved = await resolveEffectiveLLMConfig({ workspaceRoot: root, neoCastProjectRoot: path.join(root, "neo_cast") })
  if (!resolved) throw new Error("No configured LLM credentials")
  const config = { ...resolved.config, maxTokens: 16_384 }
  const model = `${config.provider}:${config.model}:max_tokens=${config.maxTokens}`
  console.log(JSON.stringify({ phase: "model", model }))
  async function ask<T>(name: string, stage: "recall" | "extract" | "review", schema: z.ZodType<T>, payload: object, validate: (value: T) => void): Promise<T> {
    const system = architectureKnowledgePrompt(stage)
    let retry: object = {}
    for (let attempt = 1; attempt <= 2; attempt++) {
      const request = { ...payload, ...retry, outputSchema: z.toJSONSchema(schema) }
      const digest = sha(JSON.stringify({ model, system, request }))
      const file = path.join(output, `${name}-${attempt}-${digest.slice(0, 16)}.call.json`)
      const cached = await Bun.file(file).exists() ? await Bun.file(file).json() : undefined
      console.log(JSON.stringify({ phase: name, attempt, cached: !!cached }))
      const response = cached?.response ?? await requestNeoCastLLM(config, resolved!.apiKey, system, JSON.stringify(request))
      await Bun.write(file, JSON.stringify({ model, digest, system, request, response }, null, 2))
      try {
        const parsed = schema.parse(parseArchitectureJSON(response.text))
        validate(parsed)
        return parsed
      } catch (error) {
        if (attempt === 2) throw error
        retry = { previousResponse: response.text, repairError: String(error), repairInstruction: "Fix only the invalid JSON/schema/references. Retain evidence limits; complete the entire output." }
      }
    }
    throw new Error("Unreachable")
  }
  const recall: z.infer<typeof ArchitectureRecallSchema> = values["selection-file"]
    ? ArchitectureRecallSchema.parse(await Bun.file(path.resolve(values["selection-file"])).json())
    : { selected: [], excluded: [] }
  // Small partitions make omissions repairable and prevent a long list from privileging its first papers.
  const ordered = [...cards].sort((a, b) => a.paperID.localeCompare(b.paperID))
  for (let start = 0; !values["selection-file"] && start < ordered.length; start += 20) {
    const batch = ordered.slice(start, start + 20)
    const part = await ask(`recall-batch-${start / 20}`, "recall", ArchitectureRecallSchema, { task,
      instruction: "This is one part of a broad recall, not a quota. Only select data-conditioned architectural choices. Exclude standalone sweeps, ranking, diagnostics, speedups and method descriptions. Read the whole list.",
      cards: batch.map((c) => ({ cardID: c.knowledgeID, paperID: c.paperID, title: catalog.get(c.paperID),
        principle: c.principle, transferableInsight: c.transferableInsight, epistemicStatus: c.epistemicStatus })),
    }, (value) => validateRecallPartition(value, batch.map((c) => c.knowledgeID)))
    recall.selected.push(...part.selected)
    recall.excluded.push(...part.excluded)
  }
  validateRecallPartition(recall, cards.map((c) => c.knowledgeID))
  await Bun.write(path.join(output, "recall.json"), JSON.stringify(recall, null, 2))
  console.log(JSON.stringify({ phase: "recalled", selected: recall.selected.length }))
  const selected = recall.selected.map((id) => corpus.get(id)!.card).sort((a, b) => a.paperID.localeCompare(b.paperID))
  const batches: KnowledgeCardV2[][] = []
  for (const card of selected) {
    const last = batches.at(-1)
    if (!last || last.length >= 4 || JSON.stringify(last).length + JSON.stringify(card).length > 220_000) batches.push([card])
    else last.push(card)
  }
  const results: { decisions: ArchitectureDecision[]; review: z.infer<typeof ArchitectureReviewSchema>; unused: z.infer<typeof ArchitectureExtractionSchema>["unused"] }[] = []
  // Independent batches can run concurrently; extraction and review within a batch stay sequential.
  for (let start = 0; start < batches.length; start += 2) {
    const wave = await Promise.allSettled(batches.slice(start, start + 2).map(async (batch, offset) => {
      const index = start + offset
      const sources = batch.map(projectArchitectureSourceCard)
      const extraction = await ask(`extract-${index}`, "extract", ArchitectureExtractionSchema, { task, cards: sources },
        (value) => validateArchitectureExtraction(value, batch))
      const decisions = extraction.decisions.map((d, i) => ({ ...d, decisionID: `architecture_${index}_${i}` }))
      const review = decisions.length ? await ask(`review-${index}`, "review", ArchitectureReviewSchema, { task, cards: sources, decisions },
        (value) => validateArchitectureReview(value, decisions, batch)) : { reviews: [] }
      const result = { decisions, review, unused: extraction.unused }
      await Bun.write(path.join(output, `batch-${index}.json`), JSON.stringify(result, null, 2))
      return result
    }))
    for (const item of wave) {
      if (item.status === "rejected") throw item.reason
      results.push(item.value)
    }
  }
  const reviews = results.flatMap((r) => r.review.reviews)
  const decisions = results.flatMap((r) => r.decisions)
  const accepted = decisions.filter((d) => reviews.some((r) => r.decisionID === d.decisionID && r.verdict === "accepted"))
  const result = { schemaVersion: ARCHITECTURE_KNOWLEDGE_VERSION, model, createdAt: new Date().toISOString(),
    recallMethod: values["selection-file"] ? "explicit_reviewed_selection" : "llm_batched_recall",
    task, recalledCards: recall.selected.length, accepted, reviews, rejected: decisions.filter((d) => !accepted.includes(d)),
    unused: results.flatMap((r) => r.unused), provenance: inventory,
    integration: "standalone_reviewed_architecture_knowledge; not a sealed card or an automatic update to a running task",
  }
  await Bun.write(path.join(output, "architecture_knowledge.json"), JSON.stringify(result, null, 2))
  const lines = ["# ETTh1 conditional architecture knowledge", "", `Recall pool: ${cards.length} cards / ${inventory.paperCount} papers; ${selected.length} cards reread against sources; ${accepted.length} decisions retained after independent semantic review.`,
    "", "This independent downstream knowledge package preserves original cards and executed tasks. Review assesses source fidelity and decision value; it does not rerun paper experiments.", ""]
  for (const decision of accepted) {
    lines.push(`## ${decision.decisionID}`, "", `**Data conditions:** ${decision.dataCondition}`, "",
      `**Prefer:** ${decision.prefer}`, "", `**Deprioritize / Avoid:** ${decision.avoid}`, "",
      `**Why:** ${decision.mechanism}`, "", `**Literature observations:** ${decision.observedEffect}`, "",
      `**Evidence level:** ${decision.evidenceLevel}`, "", `**ETTh1 applicability:** ${decision.taskFit} — ${decision.taskReason}`, "",
      ...decision.limitations.map((s) => `- ${s}`), "", "Sources:", "",
      ...decisionCardIDs(decision).map((id) => {
        const item = corpus.get(id)!
        return `- ${catalog.get(item.card.paperID) ?? item.card.paperID}: \`${id}\`, revision ${item.card.revision}, [Original card](${path.relative(output, item.file)})`
      }), "")
  }
  lines.push("## Rejected extractions", "", ...reviews.filter((r) => r.verdict === "rejected").map((r) => `- ${r.decisionID}: ${r.reason}`), "")
  await Bun.write(path.join(output, "report.md"), lines.join("\n"))
  console.log(JSON.stringify({ phase: "complete", accepted: accepted.length, rejected: decisions.length - accepted.length, output }))
}

if (import.meta.main) await main()
