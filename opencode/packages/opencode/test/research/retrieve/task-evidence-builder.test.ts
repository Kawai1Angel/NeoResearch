import { expect, test } from "bun:test"
import { fixture, frequencyCard } from "./fixtures"
import type { CardRelation } from "../../../src/research/literature/contract"
import { TaskEvidenceBundleSchema } from "../../../src/research/retrieve/contract"
import { validateHypothesisEvidence, type HypothesisObject } from "../../../src/research/agents/hypo-planner-agent"

test("legacy long horizon labels are equivalent only in horizon applicability", () => {
  const source = frequencyCard()
  const bundle = fixture({ cards: [frequencyCard({ applicability: { ...source.applicability, horizonProfile: ["long"] } })] }).build()
  expect(bundle.entries[0]!.applicability.violatedConditions).not.toContain("horizonProfile:long")
  expect(bundle.entries[0]!.applicability.matchedConditions).toContain("horizonProfile:long_horizon")
})

test("protocol cards cannot satisfy mechanism questions even when scientific terms match", () => {
  const value = fixture({ cards: [frequencyCard({ cardType: "evaluation_protocol" })] })
  for (const intent of value.intents) intent.question = "How does the mechanism address this data phenomenon?"
  expect(value.build().entries).toHaveLength(0)
  for (const intent of value.intents) intent.question = "Which evaluation metrics are appropriate?"
  expect(value.build().entries[0]!.roles).toEqual(["defines_evaluation"])
})

test("eligibility states and direct exact evidence cannot be bypassed", () => {
  for (const status of ["extracted", "inconclusive", "deprecated"] as const) {
    const value = fixture({ cards: [frequencyCard({ status })] }).build()
    expect(value.entries).toHaveLength(0)
    expect(value.excluded[0]!.reasons).toEqual(["status_not_eligible"])
    expect(value.readiness).toBe("ready_data_only")
  }
  const contradicted = fixture({ cards: [frequencyCard({ status: "contradicted" })] }).build()
  expect(contradicted.entries[0]!.roles).toEqual(["contradicts"])
  for (const evidence of [
    [{ ...frequencyCard().evidence[0]!, verification: "normalized_span" as const }],
    [{ ...frequencyCard().evidence[0]!, directness: "indirect" as const }],
    [{ ...frequencyCard().evidence[0]!, evidenceType: "agent_inference" as const }],
  ]) expect(fixture({ cards: [frequencyCard({ evidence })] }).build().excluded[0]!.reasons).toEqual(["no_direct_exact_evidence"])
})

test("all missing or mismatched paper provenance fails; partial corruption is auditable", () => {
  expect(() => fixture({ cards: [], acceptedCardIDs: ["kc_aaaaaaaaaaaa"] }).build()).toThrow("provenance")
  const wrong = frequencyCard({ cardID: "kc_aaaaaaaaaaaa", paperID: "wrong-paper" })
  expect(() => fixture({ cards: [wrong] }).build()).toThrow("provenance")
  const partial = fixture({ cards: [wrong, frequencyCard()] }).build()
  expect(partial.readiness).toBe("partial_evidence")
  expect(partial.excluded[0]!.reasons).toEqual(["paper_mismatch"])
})

test("semantic bindings do not inherit all paper intents and every must-cover gap is explicit", () => {
  const input = fixture()
  const bundle = input.build()
  expect(bundle.entries[0]!.linkage.intentIDs.length).toBeLessThan(input.intents.length)
  for (const intent of input.intents.filter((item) => item.mustCover)) {
    expect(bundle.entries.some((entry) => entry.linkage.intentIDs.includes(intent.intentID)) || bundle.gaps.some((gap) => gap.intentID === intent.intentID)).toBe(true)
  }
  const before = input.build()
  input.intents.reverse()
  input.transformations.reverse()
  input.candidates.reverse()
  input.literatureResults.reverse()
  expect(input.build()).toEqual(before)
})

test("warning claims survive a tight budget in the selected evidence limitations", () => {
  const warning = frequencyCard({ cardID: "kc_aaaaaaaaaaaa", cardType: "limitation", claim: "Frequency-domain models can fail under changing seasonal patterns.",
    confidence: { ...frequencyCard().confidence, transferability: 0.1 } })
  const bundle = fixture({ cards: [frequencyCard(), warning], budgets: { maxTaskEvidenceEntries: 1 } }).build()
  expect(bundle.entries).toHaveLength(1)
  expect(bundle.entries[0]!.limitations.join(" ")).toContain(warning.claim)
  expect(bundle.excluded[0]!.detail.join(" ")).toContain(warning.claim)
})

test("equal-quality evidence favors another paper under a tight budget", () => {
  const primary = frequencyCard({ cardID: "kc_aaaaaaaaaaaa" })
  const redundant = frequencyCard({ cardID: "kc_bbbbbbbbbbbb" })
  const independent = frequencyCard({ cardID: "kc_cccccccccccc", paperID: "paper-independent" })
  const value = fixture({ cards: [primary, redundant, independent], budgets: { maxTaskEvidenceEntries: 2 } })
  const first = value.literatureResults[0]!
  first.acceptedCardIDs = [primary.cardID, redundant.cardID]
  const candidates = value.candidates.map((item, index) => ({ ...item, paperID: independent.paperID, candidateID: `rc_${(index + 100).toString(16).padStart(16, "0")}` }))
  value.candidates.push(...candidates)
  value.literatureResults.push({ ...first, paperID: independent.paperID, acceptedCardIDs: [independent.cardID], candidateIDs: candidates.map((item) => item.candidateID) })
  const bundle = value.build()
  expect(bundle.entries).toHaveLength(2)
  expect(new Set(bundle.entries.map((item) => item.paperID)).size).toBe(2)
})

test("must-cover intents are covered before spending the budget on redundant evidence", () => {
  const alpha = frequencyCard({ cardID: "kc_aaaaaaaaaaaa", claim: "Alpha mechanism", normalizedClaim: { subject: "alpha", predicate: "uses", object: "alpha" }, mechanism: { mechanismID: "alpha", name: "alpha", principle: "Apply alpha to the input sequence", components: ["alpha"] }, tags: ["alpha"] })
  const duplicate = { ...alpha, cardID: "kc_bbbbbbbbbbbb" }
  const beta = { ...alpha, cardID: "kc_cccccccccccc", claim: "Beta mechanism", normalizedClaim: { subject: "beta", predicate: "uses", object: "beta" }, tags: ["beta"] }
  const value = fixture({ cards: [alpha, duplicate, beta], budgets: { maxTaskEvidenceEntries: 2 } })
  const template = value.transformations[0]!
  const transforms = ["alpha", "beta"].map((term) => ({ ...template, transformationID: `transform_${term}`,
    scientificConcepts: [{ ...template.scientificConcepts[0]!, conceptID: term, label: term, paperTerms: [term] }],
    methodConcepts: [], paperLanguage: { taskTerms: ["forecasting"], phenomenonTerms: [term], methodTerms: [], domainTerms: [], queryText: term },
  }))
  value.transformations.splice(0, value.transformations.length, ...transforms)
  const templateIntent = value.intents[0]!
  value.intents.splice(0, value.intents.length, ...transforms.map((item) => ({ ...templateIntent,
    intentID: `intent_${item.transformationID}`, transformationID: item.transformationID, mustCover: true, paperLanguageQuery: item.paperLanguage,
  })))
  const templateCandidate = value.candidates[0]!
  value.candidates.splice(0, value.candidates.length, ...value.intents.map((item, index) => ({ ...templateCandidate,
    candidateID: `rc_${String(index).padStart(16, "0")}`, intentID: item.intentID,
  })))
  value.literatureResults[0]!.intentIDs = value.intents.map((item) => item.intentID)
  value.literatureResults[0]!.candidateIDs = value.candidates.map((item) => item.candidateID)
  const bundle = value.build()
  expect(bundle.entries).toHaveLength(2)
  expect(bundle.gaps).toEqual([])
  expect(bundle.entries.map((item) => item.cardID)).toEqual([alpha.cardID, beta.cardID])
})

test("strict bundle validation rejects inconsistent readiness and card accounting", () => {
  const value = fixture().build()
  expect(TaskEvidenceBundleSchema.safeParse({ ...value, readiness: "ready_data_only" }).success).toBe(false)
  expect(TaskEvidenceBundleSchema.safeParse({ ...value, summary: { ...value.summary, acceptedCardCount: 99 } }).success).toBe(false)
  expect(TaskEvidenceBundleSchema.safeParse({ ...value, entries: [...value.entries, ...value.entries] }).success).toBe(false)
})

test("unknown compute constraints and unsupported negation remain uncertain", () => {
  const value = fixture({ cards: [frequencyCard({ notApplicableWhen: ["low_compute", "not regular_sampling"] })] }).build()
  expect(value.entries[0]!.applicability.status).toBe("partial")
  expect(value.entries[0]!.applicability.uncertainConditions).toEqual([
    "notApplicableWhen:low_compute", "notApplicableWhen:not regular_sampling",
  ])
})

test("hypothesis citations reject unknown cards, stale revisions, wrong paths and missing falsification", () => {
  const bundle = fixture().build()
  const entry = bundle.entries[0]!
  const hypothesis: HypothesisObject = {
    id: "H1", statement: "Frequency decomposition improves forecasting", motivation: [],
    expectedOutcome: "Lower validation MSE", suggestedBackbones: [], suggestedPreprocessing: [],
    priority: "high", risk: "Transfer uncertainty", testable: true,
    datasetEvidencePaths: [...entry.linkage.datasetEvidencePaths],
    literatureEvidence: [{ cardID: entry.cardID, cardRevision: entry.cardRevision, role: entry.roles[0]! }],
    applicabilityAssumptions: ["Seasonality persists"],
    falsificationCriteria: ["Validation MSE does not improve against baseline"], evidenceLevel: "paper_supported",
  }
  expect(() => validateHypothesisEvidence([hypothesis], bundle)).not.toThrow()
  for (const reference of [
    { ...hypothesis.literatureEvidence[0]!, cardID: "missing" },
    { ...hypothesis.literatureEvidence[0]!, cardRevision: entry.cardRevision + 1 },
  ]) {
    expect(() => validateHypothesisEvidence([{ ...hypothesis, literatureEvidence: [reference] }], bundle)).toThrow()
  }
  expect(() => validateHypothesisEvidence([{ ...hypothesis, datasetEvidencePaths: ["invented.path"] }], bundle)).toThrow()
  expect(() => validateHypothesisEvidence([{ ...hypothesis, falsificationCriteria: [] }], bundle)).toThrow()
  expect(() => validateHypothesisEvidence([hypothesis])).toThrow()
  const conflicted = { ...bundle, entries: [{ ...entry, applicability: { ...entry.applicability, status: "conflicted" as const } }] }
  expect(() => validateHypothesisEvidence([hypothesis], conflicted)).toThrow()
})

test("binds an eligible card to semantic intents and expands exact provenance", () => {
  const value = fixture().build()
  const entry = value.entries.find((item) => item.cardID === "kc_123456789abc")
  expect(entry).toBeDefined()
  expect(entry!.linkage.intentIDs.length).toBeGreaterThan(0)
  expect(entry!.linkage.transformationIDs.length).toBeGreaterThan(0)
  expect(entry!.linkage.conceptIDs).toContain("multiple_seasonalities")
  expect(entry!.linkage.datasetEvidencePaths).toContain("$.statistics.frequency.spectralPeaks")
  expect(entry!.evidenceRefs[0]).toMatchObject({ directness: "direct", verification: "exact_span" })
  expect(entry!.relevance.score).toBeLessThanOrEqual(1)
})

test("does not let domain-only or high BM25 matches bypass the evidence gate", () => {
  const domainOnly = frequencyCard({
    cardType: "empirical_finding",
    problem: undefined,
    claim: "Electricity load benchmark results are reported for a utility dataset.",
    normalizedClaim: { subject: "electricity_load", predicate: "reports", object: "benchmark" },
    mechanism: undefined,
    applicability: {
      taskTypes: ["forecasting"], dataFeatures: [], domains: ["electricity_load"], dataScale: [],
      horizonProfile: [], computeProfile: [], basis: "author_experiment",
    },
    tags: ["electricity_load"],
  })
  const value = fixture({ cards: [domainOnly] }).build()
  expect(value.entries).toHaveLength(0)
  expect(value.excluded[0]?.reasons).toContain("no_intent_match")
  expect(value.readiness).toBe("ready_data_only")

  const indirect = frequencyCard({
    evidence: frequencyCard().evidence.map((item) => ({ ...item, directness: "indirect" as const })),
  })
  const ineligible = fixture({ cards: [indirect] }).build()
  expect(ineligible.entries).toHaveLength(0)
  expect(ineligible.excluded[0]?.reasons).toContain("no_direct_exact_evidence")
})

test("records missing accepted cards without silently dropping them when other provenance is valid", () => {
  const good = frequencyCard()
  const value = fixture({ cards: [good], acceptedCardIDs: [good.cardID, "kc_ffffffffffff"] }).build()
  expect(value.entries.map((item) => item.cardID)).toContain(good.cardID)
  expect(value.excluded.find((item) => item.cardID === "kc_ffffffffffff")?.reasons).toContain("card_not_found")
  expect(value.readiness).toBe("partial_evidence")
})

test("marks controlled notApplicableWhen conflicts and keeps unknown predicates uncertain", () => {
  const conflicted = frequencyCard({ notApplicableWhen: ["regular_sampling", "requires proprietary moon phase"] })
  const value = fixture({ cards: [conflicted] }).build()
  const entry = value.entries[0]!
  expect(entry.applicability.status).toBe("conflicted")
  expect(entry.applicability.violatedConditions).toContain("notApplicableWhen:regular_sampling")
  expect(entry.applicability.uncertainConditions).toContain("notApplicableWhen:requires proprietary moon phase")
  expect(entry.roles).toContain("warns_limitation")
  expect(entry.roles).not.toContain("supports_mechanism")
})

test("deduplicates deterministically and preserves high-confidence contradictions", () => {
  const primary = frequencyCard({ cardID: "kc_111111111111", status: "corroborated", revision: 2 })
  const duplicate = frequencyCard({ cardID: "kc_222222222222", revision: 1 })
  const counter = frequencyCard({
    cardID: "kc_333333333333",
    cardType: "limitation",
    status: "contradicted",
    claim: "Frequency-domain modeling does not consistently help multiple seasonalities.",
    normalizedClaim: { subject: "frequency_domain_modeling", predicate: "does_not_help", object: "multiple_seasonalities" },
  })
  const relations: CardRelation[] = [
    {
      relationID: "relation_duplicate",
      sourceCardID: primary.cardID,
      targetCardID: duplicate.cardID,
      relationType: "duplicates",
      rationale: "same mechanism",
      confidence: 0.99,
      createdBy: "deterministic",
      createdAt: "2026-09-21T00:00:00.000Z",
    },
    {
      relationID: "relation_conflict",
      sourceCardID: primary.cardID,
      targetCardID: counter.cardID,
      relationType: "contradicts",
      rationale: "reported outcomes disagree",
      confidence: 0.9,
      createdBy: "human",
      createdAt: "2026-09-21T00:00:00.000Z",
    },
  ]
  const value = fixture({ cards: [duplicate, counter, primary], relations }).build()
  expect(value.entries.map((item) => item.cardID)).toContain(primary.cardID)
  expect(value.entries.map((item) => item.cardID)).not.toContain(duplicate.cardID)
  expect(value.excluded.find((item) => item.cardID === duplicate.cardID)?.reasons).toContain("duplicate_claim")
  expect(value.conflicts).toHaveLength(1)
  expect(value.readiness).toBe("evidence_conflict")
  const limited = fixture({ cards: [counter, primary], relations: relations.filter((item) => item.relationType === "contradicts"),
    budgets: { maxTaskEvidenceEntries: 1 } }).build()
  expect(limited.entries).toHaveLength(1)
  expect(limited.conflicts).toHaveLength(1)
  expect(limited.readiness).toBe("evidence_conflict")
  expect(limited.excluded.some((item) => item.reasons.includes("selection_budget"))).toBe(true)
})

test("keeps support and refinement provenance and prefers the refined card under a tied budget", () => {
  const general = frequencyCard({ cardID: "kc_aaaaaaaaaaaa" })
  const specific = frequencyCard({ cardID: "kc_bbbbbbbbbbbb" })
  const relation: CardRelation = {
    relationID: "rel_refinement", sourceCardID: specific.cardID, targetCardID: general.cardID,
    relationType: "refines", rationale: "Adds a seasonal frequency condition", confidence: 0.9,
    createdBy: "human", createdAt: "2026-09-21T00:00:00.000Z",
  }
  const value = fixture({ cards: [general, specific], relations: [relation], budgets: { maxTaskEvidenceEntries: 1 } }).build()
  expect(value.entries[0]!.cardID).toBe(specific.cardID)
  expect(value.entries[0]!.relevance.reasons.some((reason) => reason.includes("refines:"))).toBe(true)
  const supported = fixture({ cards: [general, specific], relations: [{ ...relation, relationType: "supports" }] }).build()
  expect(supported.entries).toHaveLength(2)
  expect(supported.entries.some((entry) => entry.relevance.reasons.some((reason) => reason.includes("supports:")))).toBe(true)
})

test("legacy mechanism cards require complete fields and current validation", () => {
  const incomplete = fixture({ cards: [frequencyCard({ mechanism: undefined })] }).build()
  expect(incomplete.excluded[0]!.reasons).toContain("mechanism_incomplete")
  const old = frequencyCard()
  old.provenance.verifierPromptVersion = "evidence_verifier_v2"
  expect(fixture({ cards: [old] }).build().excluded[0]!.reasons).toContain("card_validation_required")
})

test("warnings alone do not cover a mechanism question", () => {
  const result = fixture({ cards: [frequencyCard({ cardType: "limitation" })] }).build()
  expect(result.entries.length).toBeGreaterThan(0)
  expect(result.summary.coveredIntentCount).toBe(0)
  expect(result.gaps.length).toBeGreaterThan(0)
})

test("reading under another intent does not hide eligible cards with existing recall provenance", () => {
  const value = fixture()
  const expected = value.build().entries[0]!.linkage.intentIDs
  const other = value.intents.find((intent) => !expected.includes(intent.intentID))!
  value.literatureResults[0]!.intentIDs = [other.intentID]
  const actual = value.build().entries[0]!
  expect(actual.linkage.intentIDs).toEqual(expected)
  expect(actual.linkage.candidateIDs.every((id) => value.candidates.some((candidate) => candidate.candidateID === id))).toBe(true)
})
