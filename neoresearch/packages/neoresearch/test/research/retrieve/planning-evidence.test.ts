import { expect, test } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { fixture, report } from "./fixtures"
import { principleFixture } from "../literature/principle-fixtures"
import { fixtureModel } from "./architecture-model-fixture"
import { distillArchitectureKnowledge } from "../../../src/research/retrieve/architecture-distiller"
import { projectTaskEvidence } from "../../../src/research/retrieve/evidence-handoff"
import { projectPlanningTaskEvidence, readTaskEvidencePage, MAX_PLANNING_EVIDENCE_CHARS } from "../../../src/research/retrieve/planning-evidence"

async function admittedBundle(auditRoot: string) {
  const { card } = principleFixture()
  const packet = await distillArchitectureKnowledge({
    corpus: { cards: [card], historicalCardIDs: [], digest: "planning-fixture", warnings: [] },
    model: fixtureModel().model, task: { quantitativeReport: report() },
    datasetEvidencePaths: ["$.profile.trendStrength"], maxDecisions: 12, auditRoot,
  })
  expect(packet.decisions).toHaveLength(1)
  return { ...fixture().build(), architectureKnowledge: packet }
}

test("large source/review histories stay out of planning without losing decisions, condition logic or citation permission", async () => {
  await using tmp = await tmpdir()
  const bundle = await admittedBundle(tmp.path)
  bundle.architectureKnowledge.sourceCards[0]!.sources[0]!.quote = "ARCHIVED_SOURCE_QUOTE".repeat(70_000)
  const before = JSON.stringify(bundle)
  const full = projectTaskEvidence(bundle)
  const summary = projectPlanningTaskEvidence(bundle)
  expect(summary.architectureKnowledge!.decisions).toEqual(full.architectureKnowledge!.decisions)
  const review = bundle.architectureKnowledge.reviews[0]!
  const eligibility = summary.architectureKnowledge!.implementationReviews[0]!.eligibility!
  expect(eligibility.conditionLogic).toEqual(review.eligibility!.conditionLogic)
  expect(eligibility.conditions).toEqual(review.eligibility!.conditions)
  expect(eligibility.familyMappings).toEqual(review.eligibility!.familyMappings)
  expect(summary.entries.map(({ cardID, revision, roles, datasetEvidencePaths }) =>
    ({ cardID, revision, roles, datasetEvidencePaths })))
    .toEqual(full.entries.map(({ cardID, revision, roles, datasetEvidencePaths }) =>
      ({ cardID, revision, roles, datasetEvidencePaths })))
  expect(summary.entries[0]!.decisionIDs).toEqual([full.architectureKnowledge!.decisions[0]!.decisionID])
  expect(JSON.stringify(summary)).not.toContain("ARCHIVED_SOURCE_QUOTE")
  expect(JSON.stringify(summary).length).toBeLessThan(15_000)
  expect(JSON.stringify(bundle)).toBe(before)
})

test("on-demand source pages reconstruct the exact stored section and enforce hard output bounds", async () => {
  await using tmp = await tmpdir()
  const bundle = await admittedBundle(tmp.path)
  const card = bundle.architectureKnowledge.sourceCards[0]!
  const request = { cardID: card.knowledgeID, cardRevision: card.revision, section: "sources" as const, limit: 37 }
  let offset = 0
  let text = ""
  for (;;) {
    const page = readTaskEvidencePage(bundle, { ...request, offset })
    expect(page.text.length).toBeLessThanOrEqual(37)
    text += page.text
    if (page.nextOffset === null) break
    offset = page.nextOffset
  }
  expect(text).toBe(JSON.stringify(card.sources, null, 2))
  expect(readTaskEvidencePage(bundle, { ...request, sourceIDs: [card.sources[0]!.sourceID], limit: 12_000 }).text)
    .toBe(JSON.stringify([card.sources[0]!], null, 2))
  for (const patch of [{ cardID: "other_task_card" }, { cardRevision: 999 }, { offset: -1 }, { offset: text.length + 1 },
    { limit: 12_001 }, { sourceIDs: ["invented"] }, { sourceIDs: [card.sources[0]!.sourceID], section: "review" as const }]) {
    expect(() => readTaskEvidencePage(bundle, { ...request, ...patch })).toThrow()
  }
})

test("withheld architecture packets cannot be read or expanded into raw-card planning guidance", async () => {
  await using tmp = await tmpdir()
  const bundle = await admittedBundle(tmp.path)
  const card = bundle.architectureKnowledge.sourceCards[0]!
  bundle.architectureKnowledge.reviews[0]!.eligibility!.implementation = "unsupported"
  expect(projectPlanningTaskEvidence(bundle).entries).toEqual([])
  expect(projectPlanningTaskEvidence(bundle).architectureKnowledge!.decisions).toEqual([])
  expect(() => readTaskEvidencePage(bundle, { cardID: card.knowledgeID, cardRevision: card.revision, section: "knowledge" })).toThrow("withheld")
})

test("designer summaries resolve exact citations and retain legacy mechanisms without source dumps", () => {
  const bundle = fixture().build()
  const entry = bundle.entries[0]!
  const citation = { cardID: entry.cardID, cardRevision: entry.cardRevision, role: entry.roles[0]! }
  const summary = projectPlanningTaskEvidence(bundle, [citation])
  expect(summary.entries[0]!.mechanism).toEqual(entry.mechanism)
  expect("evidenceRefs" in summary.entries[0]!).toBe(false)
  expect(() => projectPlanningTaskEvidence(bundle, [{ ...citation, cardRevision: 999 }])).toThrow("stale")
  expect(() => projectPlanningTaskEvidence(undefined, [citation])).toThrow("unavailable")
})

test("oversized decision summaries fail before sending instead of truncating scientific conditions", () => {
  const bundle = fixture().build()
  bundle.entries[0]!.claim = "x".repeat(MAX_PLANNING_EVIDENCE_CHARS + 1)
  expect(() => projectPlanningTaskEvidence(bundle)).toThrow("exceeds 120000")
})
