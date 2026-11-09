import { expect, test } from "bun:test"
import { fixture, frequencyCard, report } from "./fixtures"
import { matchApplicability } from "../../../src/research/retrieve/applicability-matcher"
import { projectTaskEvidence } from "../../../src/research/retrieve/evidence-handoff"
import { compactPromptContext } from "../../../src/research/prompt-context"
import { consolidateMechanisms, validateSemanticReview } from "../../../src/research/literature/semantic-consolidator"

const a = frequencyCard({ cardID: "kc_000000000001" })
const b = frequencyCard({ cardID: "kc_000000000002", claim: "Seasonal frequencies are aggregated at multiple scales." })
const group = { cardIDs: [a.cardID, b.cardID], rationale: "Same decomposition and aggregation operation." }

test("seven target ETTh1 columns satisfy multivariate; static columns and duplicates do not count", () => {
  const data = report()
  const card = frequencyCard({ applicability: { ...a.applicability, dataFeatures: ["multivariate"] } })
  const match = () => matchApplicability({ card, report: data, taskContext: fixture().taskContext, conceptIDs: [] })
  data.dataset.targetColumns = ["HUFL", "HULL", "MUFL", "MULL", "LUFL", "LULL", "OT"]
  data.dataset.observedPastCovariates = []; data.dataset.knownFutureCovariates = []
  expect(match().matchedConditions).toContain("dataFeature:multivariate")
  data.dataset.targetColumns = ["OT", "OT"]; data.dataset.staticCovariates = ["site"]
  expect(match().violatedConditions).toContain("dataFeature:multivariate")
  data.dataset.observedPastCovariates = ["HUFL"]
  expect(match().matchedConditions).toContain("dataFeature:multivariate")
  data.dataset.targetColumns = []; data.dataset.observedPastCovariates = []
  expect(match().uncertainConditions).toContain("dataFeature:multivariate")
})

test("equivalent mechanisms consume one quota slot and preserve source provenance through prompt compaction", () => {
  const bundle = fixture({ cards: [a, b], semanticGroups: [group] }).build()
  expect(bundle.entries).toHaveLength(1)
  const entry = bundle.entries[0]!
  expect(entry.mergedSources).toHaveLength(1)
  expect(entry.paperTitle).toBe("Frequency Study")
  expect(entry.mechanism).toEqual(a.mechanism)
  expect(entry.evidenceRefs[0]!.evidenceSpan).toBe(a.evidence[0]!.evidenceSpan)
  expect(bundle.excluded.some((card) => card.reasons.includes("duplicate_claim"))).toBe(true)
  const packet = projectTaskEvidence(bundle)
  // More than the generic compactor's array threshold still retains exact evidence.
  packet.entries[0]!.evidenceRefs = Array.from({ length: 100 }, () => entry.evidenceRefs[0]!)
  expect(compactPromptContext({ taskEvidence: packet })).toEqual({ taskEvidence: packet })
})

test("different scopes and distinct components survive quota assembly", () => {
  const scoped = { ...b, notApplicableWhen: ["low_compute"] }
  expect(fixture({ cards: [a, scoped], semanticGroups: [group] }).build().entries).toHaveLength(2)
  const result = validateSemanticReview({ groups: [], componentRelations: [{ parentCardID: a.cardID, componentCardID: b.cardID, rationale: "component" }] }, [a, b])
  expect(fixture({ cards: [a, b], semanticGroups: result.groups }).build().entries).toHaveLength(2)
})

test("semantic review rejects invented IDs, cross-paper groups, overlaps and parent/component merging", () => {
  const parse = (groups: unknown[], componentRelations: unknown[] = [], cards = [a, b]) => validateSemanticReview({ groups, componentRelations }, cards)
  expect(() => parse([{ ...group, cardIDs: [a.cardID, "invented"] }])).toThrow()
  expect(() => parse([group], [], [a, { ...b, paperID: "other" }])).toThrow()
  expect(() => parse([group, group])).toThrow()
  expect(() => parse([group], [{ parentCardID: a.cardID, componentCardID: b.cardID, rationale: "component" }])).toThrow()
})

test("failed semantic review retries once then retains all cards without invented merges", async () => {
  let calls = 0
  const audit = await consolidateMechanisms([a, b], async () => { calls++; return { groups: [group] } })
  expect(calls).toBe(2)
  expect(audit.groups).toEqual([])
  expect(audit.papers[0]!.status).toBe("failed")
  expect((await consolidateMechanisms([a, b])).papers[0]!.status).toBe("unavailable")
})

test("designer resolves exact cited revisions and refuses silently missing source mechanisms", async () => {
  const { projectCitedTaskEvidence } = await import("../../../src/research/retrieve/evidence-handoff")
  const { buildModelDesignerTaskFingerprint } = await import("../../../src/research/agents/model-designer-agent")
  const bundle = fixture({ cards: [a, b], semanticGroups: [group] }).build()
  const entry = bundle.entries[0]!
  const citation = { cardID: entry.cardID, cardRevision: entry.cardRevision, role: entry.roles[0]! }
  expect(projectCitedTaskEvidence(bundle, [citation]).entries[0]!.mechanism).toEqual(a.mechanism)
  expect(() => projectCitedTaskEvidence(undefined, [citation])).toThrow("unavailable")
  expect(() => projectCitedTaskEvidence(bundle, [{ ...citation, cardRevision: 999 }])).toThrow("stale")
  expect(() => projectCitedTaskEvidence(bundle, [{ ...citation, cardID: entry.mergedSources![0]!.cardID }])).toThrow()
  const hypothesis = { id: "H1", statement: "Test mechanism", motivation: [], expectedOutcome: "MSE decreases",
    suggestedBackbones: [], suggestedPreprocessing: [], priority: "high" as const, risk: "transfer", testable: true,
    datasetEvidencePaths: [], literatureEvidence: [citation], applicabilityAssumptions: [],
    falsificationCriteria: ["no MSE improvement"], evidenceLevel: "paper_supported" as const }
  const fingerprint = buildModelDesignerTaskFingerprint({ baseFingerprint: {}, selectedHypothesis: hypothesis, taskEvidence: bundle })
  expect((fingerprint.taskEvidence as any).entries[0].mechanism).toEqual(a.mechanism)
})


test("duplicate relation chains keep one representative with every original source", () => {
  const c = frequencyCard({ cardID: "kc_000000000003" })
  const groups = [group, { cardIDs: [b.cardID, c.cardID], rationale: "same operation" }]
  const bundle = fixture({ cards: [a, b, c], semanticGroups: groups }).build()
  expect(bundle.entries).toHaveLength(1)
  expect(bundle.entries[0]!.mergedSources).toHaveLength(2)
})

test("unknown versus satisfied multivariate scope can share a mechanism without losing source conditions", () => {
  const multi = frequencyCard({ ...b, applicability: { ...a.applicability, dataFeatures: ["multivariate"] } })
  const bundle = fixture({ cards: [a, multi], semanticGroups: [group] }).build()
  expect(bundle.entries).toHaveLength(1)
  expect(bundle.entries[0]!.mergedSources![0]!.applicability).toEqual(multi.applicability)
})
