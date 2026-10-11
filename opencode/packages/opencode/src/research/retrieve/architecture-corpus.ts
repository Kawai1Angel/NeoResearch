import path from "path"
import { createHash } from "crypto"
import { readFile } from "fs/promises"
import { KnowledgeCardV2Schema, type KnowledgeCardV2 } from "../literature/knowledge-v2-contract"
import { validateKnowledgeCardSeal } from "../literature/knowledge-v2-validator"

export type ArchitectureCorpus = { cards: KnowledgeCardV2[]; historicalCardIDs: string[]; digest: string; warnings: string[] }
const hash = (s: string) => createHash("sha256").update(s).digest("hex")

export function diverseCards(cards: KnowledgeCardV2[], limit: number) {
  const papers = new Map<string, KnowledgeCardV2[]>()
  for (const card of cards) papers.set(card.paperID, [...(papers.get(card.paperID) ?? []), card])
  const selected: KnowledgeCardV2[] = []
  for (let i = 0; selected.length < limit; i++) {
    const next = [...papers.values()].flatMap((items) => items[i] ? [items[i]!] : [])
    if (!next.length) break
    selected.push(...next.slice(0, limit - selected.length))
  }
  return selected
}

/** Archives are discovery sources, never republished or substituted for active revisions. */
export async function loadArchitectureCorpus(input: { activeCards: unknown[]; neoCastRoot: string; knowledgeRoot?: string }) : Promise<ArchitectureCorpus> {
  const cards = new Map<string, KnowledgeCardV2>()
  const historicalCardIDs: string[] = [], warnings: string[] = []
  for (const raw of input.activeCards) {
    const parsed = KnowledgeCardV2Schema.safeParse(raw)
    if (parsed.success && !validateKnowledgeCardSeal(parsed.data).length) cards.set(parsed.data.knowledgeID, parsed.data)
  }
  const runtime = path.join(input.neoCastRoot, ".neo-cast")
  const archive = path.join(runtime, "literature-reruns")
  const files = await Array.fromAsync(new Bun.Glob("**/*knowledge_cards_v2.jsonl").scan({ cwd: archive, absolute: true })).catch(() => [] as string[])
  const chunkFiles = (await Promise.all([input.knowledgeRoot ?? path.join(runtime, "literature-knowledge"), archive].map((cwd) =>
    Array.fromAsync(new Bun.Glob("**/*.chunks.jsonl").scan({ cwd, absolute: true })).catch(() => [] as string[])))).flat()
  const chunks = new Map<string, { paperID: string; documentID: string; text: string; textSha256: string }>()
  for (const file of chunkFiles.sort()) {
    try {
      const documentHash = path.basename(file).replace(/\.chunks\.jsonl$/, "")
      for (const line of (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean)) {
        const chunk = JSON.parse(line)
        if (typeof chunk.text === "string" && hash(chunk.text) === chunk.textSha256) chunks.set(`${documentHash}/${chunk.chunkID}`, chunk)
      }
    } catch { warnings.push(`Unreadable archived chunks: ${file}`) }
  }
  for (const file of files.sort()) {
    try {
      for (const line of (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean)) {
        const parsed = KnowledgeCardV2Schema.safeParse(JSON.parse(line))
        if (!parsed.success || cards.has(parsed.data.knowledgeID)) continue
        const card = parsed.data
        if (validateKnowledgeCardSeal(card).some((error) => error !== "provenance_version_mismatch")) continue
        const verified = card.sources.every((source) => {
          const chunk = chunks.get(`${source.documentSha256}/${source.chunkID}`)
          return chunk?.paperID === card.paperID && chunk.documentID === source.documentID && chunk.textSha256 === source.chunkSha256 &&
            (source.spanStart !== undefined && source.spanEnd !== undefined
              ? chunk.text.slice(source.spanStart, source.spanEnd) === source.quote : chunk.text.includes(source.quote))
        })
        if (!verified) { warnings.push(`Archived source spans unavailable: ${card.knowledgeID}`); continue }
        cards.set(card.knowledgeID, card)
        historicalCardIDs.push(card.knowledgeID)
      }
    } catch { warnings.push(`Unreadable archive cards: ${file}`) }
  }
  const ordered = [...cards.values()].sort((a, b) => a.knowledgeID.localeCompare(b.knowledgeID))
  return { cards: ordered, historicalCardIDs, warnings,
    digest: hash(JSON.stringify({ cards: ordered, historicalCardIDs: historicalCardIDs.sort() })) }
}
