import { expect, test } from "bun:test"
import path from "path"
import { readdir, readFile } from "fs/promises"
import { tmpdir } from "../../fixture/fixture"
import { principleFixture } from "../literature/principle-fixtures"
import { report } from "./fixtures"
import { fixtureModel, eligibilityRecipe } from "./architecture-model-fixture"
import type { PrincipleModel } from "../../../src/research/literature/principle-model"
import { distillArchitectureKnowledge, ARCHITECTURE_LIMITS } from "../../../src/research/retrieve/architecture-distiller"
import { ArchitectureEligibilitySchema, architectureEligibilityIssues, architectureSelectionContext, targetConditionState, matchedTargetEvidenceIssues } from "../../../src/research/retrieve/architecture-eligibility"

test("an OR prerequisite admits a matched smooth sequence without inventing a required cycle", () => {
  const eligibility = ArchitectureEligibilitySchema.parse({
    implementation: "family_supported", implementationReason: "Synthetic affine family",
    familyMappings: [{ family: "affine_temporal", role: "prefer", rationale: "Synthetic source rationale", transferBoundaries: ["Not a paper replica"] }],
    recipe: eligibilityRecipe, requiredMechanisms: [], target: "matched", targetReason: "Smooth alternative matches",
    conditions: [
      { condition: "Smooth", path: "$.quantitativeReport.profile.trendStrength", value: 0.63, status: "matched" },
      { condition: "Periodic", path: "$.quantitativeReport.statistics.frequency.dominantPeriod", value: 24, status: "unknown" },
    ],
    conditionLogic: [{ alternatives: [0, 1], sourceRationale: "Source permits smooth OR periodic",
      sourceRefs: [{ cardID: "fixture", sourceIDs: ["source"] }] }],
    objective: "prediction", predictionReason: "Synthetic error relationship", requiredData: { knownFutureCovariates: false, staticCovariates: false },
  })
  const task = { quantitativeReport: report() }
  expect(architectureEligibilityIssues(eligibility, task)).toEqual([])
  const and = { ...eligibility, conditionLogic: [
    { ...eligibility.conditionLogic![0]!, alternatives: [0] },
    { ...eligibility.conditionLogic![0]!, alternatives: [1] },
  ] }
  expect(targetConditionState(and)).toBe("unknown")
  expect(architectureEligibilityIssues(and, task)).toContain("Necessary data conditions are not all established")
  const bothFalse = { ...eligibility, target: "mismatch" as const,
    conditions: eligibility.conditions.map((c) => ({ ...c, status: "contradicted" as const })) }
  expect(targetConditionState(bothFalse)).toBe("mismatch")
  const missing = { ...eligibility, conditionLogic: [{ ...eligibility.conditionLogic![0]!, alternatives: [0] }] }
  expect(architectureEligibilityIssues(missing, task)).toContain("Condition logic must cover each necessary data clause exactly once")
})

test("input structure counts seven observed inputs separately from one forecast target and preserves missing metadata", () => {
  const task = { quantitativeReport: { ...report(), dataset: { ...report().dataset,
    targetColumns: ["OT"], observedPastCovariates: ["HUFL", "HULL", "MUFL", "MULL", "LUFL", "LULL", "OT"],
  } } }
  expect(architectureSelectionContext(task).inputStructure).toMatchObject({ inputChannelCount: 7, targetChannelCount: 1 })
  expect(architectureSelectionContext({}).inputStructure).toMatchObject({ inputChannelCount: null, targetChannelCount: null })
})

test("missing input counts and absent correlation diagnostics cannot become negative evidence", () => {
  const missingInput = { conditions: [{ scope: "input_channels", path: "$.inputStructure.inputChannelCount", value: null, status: "contradicted" }] } as any
  expect(matchedTargetEvidenceIssues(missingInput, {}).join(" ")).toContain("structure is unavailable")
  const missingCross = { conditions: [{ scope: "general", path: "$.quantitativeReport.profile.crossVarCorrelation", value: 0, status: "contradicted" }] } as any
  expect(matchedTargetEvidenceIssues(missingCross, { quantitativeReport: { profile: { crossVarCorrelation: 0 }, statistics: { crossLag: {} } } }).join(" "))
    .toContain("Cross-channel diagnostics are unavailable")
})

for (const problem of ["operator", "replication", "input_output", "logical_condition"] as const) {
  test(`semantic repair fixes ${problem} only after a fresh independent review`, async () => {
    await using tmp = await tmpdir()
    const { card } = principleFixture()
    const originalCard = structuredClone(card)
    const fixture = fixtureModel()
    const calls: string[] = []
    let revisionPayload: any
    let reviews = 0
    const model: PrincipleModel = { modelIdentifier: `repair-${problem}`, async request(stage, payload) {
      calls.push(stage)
      if (stage === "architecture_revise") {
        revisionPayload = payload
        const previous = payload.previousDecision as any
        return { text: JSON.stringify({ decision: { ...previous,
          prefer: problem === "operator" ? "采用可实现的仿射时间建模家族" : previous.prefer,
          limitations: [...previous.limitations, "Preserve operator differences and source scope; no transferred local gain"],
        }, reason: "Narrow wording or correct applicability using the original sources" }) }
      }
      const value = JSON.parse((await fixture.model.request(stage, payload)).text)
      if (stage === "architecture_extract" && problem === "operator") value.decisions[0].prefer = "Exact unavailable bespoke operator"
      if (stage === "architecture_review" && ++reviews === 1) {
        const r = value.reviews[0]
        r.revisionAdvice = { action: problem === "operator" ? "revise" : "reassess", reason: `Concrete ${problem} feedback` }
        if (problem === "operator") {
          r.verdict = "rejected"
          r.checks.familyAbstraction = false
          r.eligibility.implementation = "unsupported"
        } else {
          r.eligibility.target = "unknown"
          r.eligibility.conditions[0].status = "unknown"
          r.eligibility.targetReason = problem === "replication" ? "Local gain was not reproduced" : "Mistaken data prerequisite"
        }
      }
      return { text: JSON.stringify(value) }
    } }
    const packet = await distillArchitectureKnowledge({ corpus: { cards: [card], historicalCardIDs: [], digest: problem, warnings: [] },
      model, task: { quantitativeReport: report() }, datasetEvidencePaths: [], maxDecisions: 12, auditRoot: path.join(tmp.path, "audit") })
    expect(calls).toEqual(["architecture_recall", "architecture_extract", "architecture_review", "architecture_revise", "architecture_review", "architecture_curate"])
    expect(revisionPayload.independentReview.revisionAdvice.reason).toContain(problem)
    expect(revisionPayload.cards[0].sources).toEqual(card.sources)
    expect(packet.decisions).toHaveLength(1)
    expect(packet.decisions[0]!.decisionID).toBe(revisionPayload.previousDecision.decisionID)
    if (problem === "operator") expect(packet.decisions[0]!.prefer).toBe("采用可实现的仿射时间建模家族")
    expect(card).toEqual(originalCard)
    const files = await readdir(path.join(tmp.path, "audit"))
    expect(files.some((f) => f.startsWith("revise-"))).toBe(true)
    expect(files.some((f) => f.startsWith("review-revision-"))).toBe(true)
  })
}

test("a single-target count cannot serve as negative evidence for a multivariate input prerequisite", async () => {
  await using tmp = await tmpdir()
  const { card } = principleFixture()
  const fixture = fixtureModel()
  let reviews = 0
  const model: PrincipleModel = { modelIdentifier: "input-output-evidence", async request(stage, payload) {
    const value = JSON.parse((await fixture.model.request(stage, payload)).text)
    if (stage === "architecture_review" && ++reviews === 1) {
      const e = value.reviews[0].eligibility
      e.target = "mismatch"
      e.conditions[0].scope = "input_channels"
      e.conditions[0].status = "contradicted"
    }
    if (stage === "architecture_review" && reviews > 1) expect(payload.repairError).toContain("Input-channel prerequisites")
    return { text: JSON.stringify(value) }
  } }
  const packet = await distillArchitectureKnowledge({ corpus: { cards: [card], historicalCardIDs: [], digest: "inputs", warnings: [] }, model,
    task: { quantitativeReport: report() }, datasetEvidencePaths: [], maxDecisions: 12, auditRoot: path.join(tmp.path, "audit") })
  expect(reviews).toBe(2)
  expect(packet.decisions).toHaveLength(1)
})

test("unknown necessary cross-channel diagnostics remain library-only and do not trigger semantic retries", async () => {
  await using tmp = await tmpdir()
  const { card } = principleFixture()
  const fixture = fixtureModel()
  const model: PrincipleModel = { modelIdentifier: "missing-diagnostic", async request(stage, payload) {
    const value = JSON.parse((await fixture.model.request(stage, payload)).text)
    if (stage === "architecture_review") {
      const r = value.reviews[0]
      r.eligibility.target = "unknown"
      r.eligibility.conditions[0] = { condition: "Nonzero cross-lag dependence", path: "$.quantitativeReport.statistics.crossLag",
        value: {}, status: "unknown", scope: "general" }
      r.revisionAdvice = { action: "none", reason: "Actual necessary diagnostics are absent" }
    }
    return { text: JSON.stringify(value) }
  } }
  const packet = await distillArchitectureKnowledge({ corpus: { cards: [card], historicalCardIDs: [], digest: "unknown", warnings: [] }, model,
    task: { quantitativeReport: { ...report(), statistics: { ...report().statistics, crossLag: {} } } },
    datasetEvidencePaths: [], maxDecisions: 12, auditRoot: path.join(tmp.path, "audit") })
  expect(packet.status).toBe("completed")
  expect(packet.decisions).toEqual([])
  expect(packet.exclusions[0]!.stage).toBe("task_admission")
  expect(fixture.calls).not.toContain("architecture_revise")
})

for (const mode of ["withdraw", "exhaust", "fabricated_source", "review_failure"] as const) {
  test(`semantic repair ${mode} cannot authorize unrevised or unreviewed claims`, async () => {
    await using tmp = await tmpdir()
    const { card } = principleFixture()
    const fixture = fixtureModel()
    let revisions = 0
    const model: PrincipleModel = { modelIdentifier: mode, async request(stage, payload) {
      if (stage === "architecture_revise") {
        revisions++
        if (mode === "withdraw") return { text: JSON.stringify({ decision: null, reason: "Original sources cannot support a transferable family" }) }
        const decision = structuredClone(payload.previousDecision as any)
        if (mode === "fabricated_source") decision.citations.effect[0].sourceIDs = ["fabricated"]
        return { text: JSON.stringify({ decision, reason: "Attempted semantic repair" }) }
      }
      if (stage === "architecture_review" && revisions && mode === "review_failure") return { text: "{" }
      const value = JSON.parse((await fixture.model.request(stage, payload)).text)
      if (stage === "architecture_review") {
        value.reviews[0].verdict = "rejected"
        value.reviews[0].checks.sourceFaithful = false
        value.reviews[0].revisionAdvice = { action: "revise", reason: "Narrow an unsupported clause" }
      }
      return { text: JSON.stringify(value) }
    } }
    const packet = await distillArchitectureKnowledge({ corpus: { cards: [card], historicalCardIDs: [], digest: mode, warnings: [] }, model,
      task: { quantitativeReport: report() }, datasetEvidencePaths: [], maxDecisions: 12, auditRoot: path.join(tmp.path, "audit") })
    expect(packet.decisions).toEqual([])
    expect(packet.sourceCards).toEqual([])
    expect(fixture.calls).not.toContain("architecture_curate")
    if (mode === "exhaust") expect(revisions).toBe(ARCHITECTURE_LIMITS.semanticRevisionRounds)
    if (mode === "withdraw") expect(packet.exclusions[0]!.stage).toBe("revision_withdrawn")
    if (["fabricated_source", "review_failure"].includes(mode)) expect(packet.status).toBe("partial")
  })
}

test("inspected sibling cards remain in the full review audit without breaking the final handoff", async () => {
  await using tmp = await tmpdir()
  const first = principleFixture().card
  const sibling = principleFixture((c) => { c.candidateID = "sibling"; c.transferableInsight = "A distinct source lead" }).card
  const fixture = fixtureModel(first.knowledgeID)
  const model: PrincipleModel = { modelIdentifier: "sibling-audit", async request(stage, payload) {
    const value = JSON.parse((await fixture.model.request(stage, payload)).text)
    if (stage === "architecture_review") for (const r of value.reviews) r.reviewedSources = [
      ...r.reviewedSources, { cardID: sibling.knowledgeID, sourceIDs: [sibling.sources[0]!.sourceID] },
    ]
    return { text: JSON.stringify(value) }
  } }
  const auditRoot = path.join(tmp.path, "audit")
  const packet = await distillArchitectureKnowledge({ corpus: { cards: [first, sibling], historicalCardIDs: [], digest: "siblings", warnings: [] }, model,
    task: { quantitativeReport: report() }, datasetEvidencePaths: [], maxDecisions: 12, auditRoot })
  expect(packet.decisions).toHaveLength(1)
  expect(packet.sourceCards.map((c) => c.knowledgeID)).toEqual([first.knowledgeID])
  expect(packet.reviews[0]!.reviewedSources.map((r) => r.cardID)).toEqual([first.knowledgeID])
  const file = (await readdir(auditRoot)).find((f) => f.startsWith("review-"))!
  const full = JSON.parse(await readFile(path.join(auditRoot, file), "utf8"))
  expect(JSON.parse(full.response.text).reviews[0].reviewedSources.some((r: any) => r.cardID === sibling.knowledgeID)).toBe(true)
})

test("a failed semantic revision preserves independently approved sibling decisions", async () => {
  await using tmp = await tmpdir()
  const first = principleFixture().card
  const sibling = principleFixture((c) => { c.candidateID = "good-sibling"; c.transferableInsight = "Another source lead" }).card
  const fixture = fixtureModel(sibling.knowledgeID)
  const model: PrincipleModel = { modelIdentifier: "revision-isolation", async request(stage, payload) {
    if (stage === "architecture_revise") throw new Error("Synthetic provider failure")
    const value = JSON.parse((await fixture.model.request(stage, payload)).text)
    if (stage === "architecture_review") for (const review of value.reviews) {
      const decision = (payload.decisions as any[]).find((d) => d.decisionID === review.decisionID)
      if (decision.citations.condition.some((c: any) => c.cardID === first.knowledgeID)) {
        review.verdict = "rejected"
        review.checks.familyAbstraction = false
        review.revisionAdvice = { action: "revise", reason: "Narrow an exact operator chain" }
      }
    }
    return { text: JSON.stringify(value) }
  } }
  const packet = await distillArchitectureKnowledge({ corpus: { cards: [first, sibling], historicalCardIDs: [], digest: "isolated", warnings: [] }, model,
    task: { quantitativeReport: report() }, datasetEvidencePaths: [], maxDecisions: 12, auditRoot: path.join(tmp.path, "audit") })
  expect(packet.status).toBe("partial")
  expect(packet.decisions).toHaveLength(1)
  expect(packet.sourceCards[0]!.knowledgeID).toBe(sibling.knowledgeID)
  expect(packet.exclusions.some((e) => e.stage === "semantic_revision_failed")).toBe(true)
  expect(packet.warnings.join(" ")).not.toContain("provider failure")
})
