import { expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import { principleFixture } from "../literature/principle-fixtures"
import { fixtureModel } from "./architecture-model-fixture"
import { report } from "./fixtures"
import type { PrincipleModel } from "../../../src/research/literature/principle-model"
import { distillArchitectureKnowledge } from "../../../src/research/retrieve/architecture-distiller"
import { projectArchitectureSourceCard } from "../../../src/research/retrieve/architecture-knowledge"

function sourceCards() {
  const first = principleFixture((candidate) => {
    candidate.assertions.push({ assertionID: "counter", kind: "boundary", statement: `Contrary findings: ${"the gain does not transfer outside the stated regime; ".repeat(100)}` })
    candidate.boundaries = { status: "reported", items: [{ assertionID: "counter", sourceIDs: ["s"] }] }
    candidate.support.push({ evidenceID: "counter", assertionIDs: ["p"], sourceIDs: ["s"], relation: "refutes", kind: "explanation" })
  }).card
  const second = principleFixture((candidate) => { candidate.candidateID = "second"; candidate.transferableInsight = "Distinct second relationship" }).card
  return [first, second]
}

function allDecisions(payload: Record<string, unknown>) {
  return { selectedDecisionIDs: (payload.decisions as any[]).map((decision) => decision.decisionID), excluded: [] }
}

for (const failure of ["schema", "semantic_check", "source", "duplicate", "missing"] as const) {
  test(`batch review retains valid siblings and retries only the ${failure} entry`, async () => {
    await using tmp = await tmpdir()
    const cards = sourceCards()
    const original = structuredClone(cards)
    const fixture = fixtureModel()
    const requests: Record<string, any>[] = []
    const model: PrincipleModel = { modelIdentifier: `selective-${failure}`, async request(stage, payload) {
      if (stage === "architecture_curate") return { text: JSON.stringify(allDecisions(payload)) }
      const value = JSON.parse((await fixture.model.request(stage, payload)).text)
      if (stage === "architecture_review") {
        requests.push(structuredClone(payload))
        for (const review of value.reviews) review.reason = `Original review for ${review.decisionID}`
        if (value.reviews.length > 1) {
          const bad = value.reviews[1]
          if (failure === "schema") delete bad.checks
          if (failure === "semantic_check") bad.checks.sourceFaithful = false
          if (failure === "source") bad.reviewedSources[0].sourceIDs = ["invented"]
          if (failure === "duplicate") value.reviews.push(structuredClone(bad))
          if (failure === "missing") value.reviews.pop()
        }
      }
      return { text: JSON.stringify(value) }
    } }
    const packet = await distillArchitectureKnowledge({ corpus: { cards, historicalCardIDs: [], digest: failure, warnings: [] }, model,
      task: { quantitativeReport: report() }, datasetEvidencePaths: [], maxDecisions: 12, auditRoot: path.join(tmp.path, "audit") })
    expect(packet.status).toBe("completed")
    expect(packet.decisions).toHaveLength(2)
    expect(requests.map((request) => request.decisions.map((decision: any) => decision.decisionID)))
      .toEqual([["architecture_0_0", "architecture_0_1"], ["architecture_0_1"]])
    expect(requests[1]!.cards).toEqual([projectArchitectureSourceCard(cards[1]!)])
    expect(packet.reviews.find((review) => review.decisionID === "architecture_0_0")!.reason).toBe("Original review for architecture_0_0")
    expect(cards).toEqual(original)
  })
}

test("single recovery retains the related card's complete uncited counterevidence and excludes siblings", async () => {
  await using tmp = await tmpdir()
  const cards = sourceCards()
  const fixture = fixtureModel()
  const singles: Record<string, any>[] = []
  const model: PrincipleModel = { modelIdentifier: "complete-related-evidence", async request(stage, payload) {
    if (stage === "architecture_curate") return { text: JSON.stringify(allDecisions(payload)) }
    const value = JSON.parse((await fixture.model.request(stage, payload)).text)
    if (stage === "architecture_review") {
      if (value.reviews.length > 1) delete value.reviews[0].eligibility
      else singles.push(structuredClone(payload))
    }
    return { text: JSON.stringify(value) }
  } }
  const packet = await distillArchitectureKnowledge({ corpus: { cards, historicalCardIDs: [], digest: "complete", warnings: [] }, model,
    task: { quantitativeReport: report() }, datasetEvidencePaths: [], maxDecisions: 12, auditRoot: path.join(tmp.path, "audit") })
  expect(packet.decisions).toHaveLength(2)
  expect(singles).toHaveLength(1)
  const related = singles[0]!.cards[0]
  expect(singles[0]!.cards).toHaveLength(1)
  expect(related.cardID).toBe(cards[0]!.knowledgeID)
  expect(related.sources).toEqual(cards[0]!.sources)
  expect(related.sources[0].quote.length).toBeGreaterThan(4000)
  expect(related.support).toEqual(cards[0]!.support)
  expect(related.boundaries).toEqual(cards[0]!.boundaries)
  expect(related.assertions).toEqual(cards[0]!.assertions)
  expect(related.experiments).toEqual(cards[0]!.experiments)
  expect(JSON.stringify(singles[0])).not.toContain(cards[1]!.knowledgeID)
})

test("partial reruns reuse qualified reviews and refresh only failed cached entries", async () => {
  await using tmp = await tmpdir()
  const cards = sourceCards()
  const fixture = fixtureModel()
  const requests: string[][] = []
  let repairable = false
  const model: PrincipleModel = { modelIdentifier: "resumable-selective-review", async request(stage, payload) {
    if (stage === "architecture_curate") return { text: JSON.stringify(allDecisions(payload)) }
    const value = JSON.parse((await fixture.model.request(stage, payload)).text)
    if (stage === "architecture_review") {
      requests.push((payload.decisions as any[]).map((decision) => decision.decisionID))
      if (!repairable) for (const review of value.reviews) if (review.decisionID === "architecture_0_1") delete review.checks
    }
    return { text: JSON.stringify(value) }
  } }
  const input = { corpus: { cards, historicalCardIDs: [], digest: "resume", warnings: [] }, model,
    task: { quantitativeReport: report() }, datasetEvidencePaths: [], maxDecisions: 12, auditRoot: path.join(tmp.path, "audit") }
  const partial = await distillArchitectureKnowledge(input)
  expect(partial.status).toBe("partial")
  expect(partial.decisions.map((decision) => decision.decisionID)).toEqual(["architecture_0_0"])
  expect(requests).toEqual([["architecture_0_0", "architecture_0_1"], ["architecture_0_1"], ["architecture_0_1"]])
  repairable = true
  requests.length = 0
  const recovered = await distillArchitectureKnowledge(input)
  expect(recovered.status).toBe("completed")
  expect(recovered.decisions).toHaveLength(2)
  expect(requests).toEqual([["architecture_0_1"]])
  expect(recovered.reviews.find((review) => review.decisionID === "architecture_0_0")).toEqual(partial.reviews[0])
  requests.length = 0
  expect((await distillArchitectureKnowledge(input)).decisions).toHaveLength(2)
  expect(requests).toEqual([])
  // Changed applicability facts invalidate both source review receipts.
  const changed = report()
  changed.dataset.targetColumns = ["another_target"]
  await distillArchitectureKnowledge({ ...input, task: { quantitativeReport: changed } })
  expect(requests).toEqual([["architecture_0_0", "architecture_0_1"]])
})

test("a valid rejection is retained while another entry is repaired", async () => {
  await using tmp = await tmpdir()
  const cards = sourceCards()
  const fixture = fixtureModel()
  const requests: string[][] = []
  const model: PrincipleModel = { modelIdentifier: "retain-rejection", async request(stage, payload) {
    if (stage === "architecture_curate") return { text: JSON.stringify(allDecisions(payload)) }
    const value = JSON.parse((await fixture.model.request(stage, payload)).text)
    if (stage === "architecture_review") {
      requests.push((payload.decisions as any[]).map((decision) => decision.decisionID))
      if (value.reviews.length > 1) {
        value.reviews[0].verdict = "rejected"
        value.reviews[0].reason = "The source does not support this claim."
        delete value.reviews[1].checks
      }
    }
    return { text: JSON.stringify(value) }
  } }
  const packet = await distillArchitectureKnowledge({ corpus: { cards, historicalCardIDs: [], digest: "rejection", warnings: [] }, model,
    task: { quantitativeReport: report() }, datasetEvidencePaths: [], maxDecisions: 12, auditRoot: path.join(tmp.path, "audit") })
  expect(packet.status).toBe("completed")
  expect(requests).toEqual([["architecture_0_0", "architecture_0_1"], ["architecture_0_1"]])
  expect(packet.decisions.map((decision) => decision.decisionID)).toEqual(["architecture_0_1"])
  expect(packet.exclusions).toContainEqual({ id: "architecture_0_0", stage: "source_review", reason: "The source does not support this claim." })
})

test("revision and fresh single review retain all originally related evidence after a citation is removed", async () => {
  await using tmp = await tmpdir()
  const cards = sourceCards()
  const unrelated = principleFixture((candidate) => { candidate.candidateID = "unrelated"; candidate.transferableInsight = "Unrelated source lead" }).card
  const fixture = fixtureModel()
  const contexts: Record<string, any>[] = []
  let reviews = 0
  const model: PrincipleModel = { modelIdentifier: "revision-source-context", async request(stage, payload) {
    if (stage === "architecture_curate") return { text: JSON.stringify(allDecisions(payload)) }
    const value = JSON.parse((await fixture.model.request(stage, payload)).text)
    if (stage === "architecture_extract") {
      value.decisions = [value.decisions[0]]
      value.decisions[0].citations.mechanism.push({ cardID: cards[1]!.knowledgeID, sourceIDs: [cards[1]!.sources[0]!.sourceID] })
      value.unused = [{ cardID: unrelated.knowledgeID, reason: "Unrelated lead" }]
    }
    if (stage === "architecture_revise") {
      contexts.push(structuredClone(payload))
      for (const category of Object.keys(value.decision.citations))
        value.decision.citations[category] = value.decision.citations[category].filter((ref: any) => ref.cardID !== cards[1]!.knowledgeID)
    }
    if (stage === "architecture_review") {
      contexts.push(structuredClone(payload))
      reviews++
      if (reviews === 1) {
        const review = value.reviews[0]
        review.reviewedSources = (payload.cards as any[]).map((card) => ({ cardID: card.cardID, sourceIDs: card.sources.map((source: any) => source.sourceID) }))
        review.verdict = "rejected"
        review.checks.sourceFaithful = false
        review.revisionAdvice = { action: "revise", reason: "Narrow the unsupported additional clause" }
      }
    }
    return { text: JSON.stringify(value) }
  } }
  const packet = await distillArchitectureKnowledge({ corpus: { cards: [...cards, unrelated], historicalCardIDs: [], digest: "revision-context", warnings: [] }, model,
    task: { quantitativeReport: report() }, datasetEvidencePaths: [], maxDecisions: 12, auditRoot: path.join(tmp.path, "audit") })
  expect(packet.decisions).toHaveLength(1)
  expect(reviews).toBe(2)
  expect(contexts).toHaveLength(3)
  for (const context of contexts) {
    expect(context.cards).toEqual(cards.map(projectArchitectureSourceCard))
    expect(JSON.stringify(context)).not.toContain(unrelated.knowledgeID)
  }
  expect(packet.sourceCards.map((card) => card.knowledgeID)).toEqual([cards[0]!.knowledgeID])
})
