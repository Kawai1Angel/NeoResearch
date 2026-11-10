/** Offline integration check against the actual readers and retrieval index. */
import path from "node:path"
import { Database } from "bun:sqlite"
import { ExperienceLibrary, experienceLibraryPath } from "../neoresearch/packages/neoresearch/src/research/experience-library"
import { KnowledgeV2Store } from "../neoresearch/packages/neoresearch/src/research/literature/knowledge-v2-store"
import { buildLocalIndex } from "../neoresearch/packages/neoresearch/src/research/retrieve/local-index-builder"
import { validateKnowledgeCardSeal } from "../neoresearch/packages/neoresearch/src/research/literature/knowledge-v2-validator"

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dir, ".."))
const expected = await Bun.file(path.join(root, "exports/manifest.json")).json()
// Intentionally test project discovery with no global-library override.
delete process.env.NEO_RESEARCH_EXPERIENCE_DB
const experiencePath = experienceLibraryPath(root)
if (experiencePath !== path.join(root, ".neo-research/experience.db")) throw new Error("Experience path escaped bundle")
const library = new ExperienceLibrary(experiencePath)
const raw = new Database(experiencePath, { readonly: true })
const rawCount = (raw.query("SELECT count(*) AS n FROM research_experience").get() as { n: number }).n
const recalled = library.list({ domainID: "tsf" })
const searches = Object.fromEntries(["patch", "nbeats", "moving average decomposition"].map((query) =>
  [query, library.list({ domainID: "tsf", query, limit: 5 }).map((memory) => memory.id)]))
raw.close()
library.close()
const knowledge = new KnowledgeV2Store(path.join(root, "neo_cast/.neo-cast/literature-knowledge/knowledge.db"))
const cards = knowledge.listCards()
knowledge.close()
const invalid = cards.flatMap((card) => validateKnowledgeCardSeal(card).map((error) => ({ id: card.knowledgeID, error })))
if (rawCount !== expected.experience.rawCount || !recalled.length) throw new Error("Experience snapshot failed validation")
if (cards.length !== expected.knowledge.activeCards || invalid.length) throw new Error("Knowledge seals failed validation")
const index = await buildLocalIndex({ neoCastRoot: path.join(root, "neo_cast") })
if (!index.documents.some((document) => document.evidenceLevel === "paper_backed")) throw new Error("Knowledge is not indexed")
console.log(JSON.stringify({ root, experiencePath, rawExperiences: rawCount, recallableEntries: recalled.length,
  searches, knowledgeCards: cards.length, invalidKnowledgeSeals: invalid.length,
  indexedPapers: index.documents.length, paperBackedPapers: index.documents.filter((d) => d.evidenceLevel === "paper_backed").length,
  localPDFs: index.documents.filter((d) => d.localPDF).length }, null, 2))
