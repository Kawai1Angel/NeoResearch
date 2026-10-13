import { expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import { architectureEligibilityIssues, ArchitectureEligibilitySchema, recipeMechanismFamilies } from "../../../src/research/retrieve/architecture-eligibility"
import { TSFCandidateRecipe } from "../../../src/research/domains/tsf"
import { distillArchitectureKnowledge } from "../../../src/research/retrieve/architecture-distiller"
import { citableTaskEvidence, projectTaskEvidence } from "../../../src/research/retrieve/evidence-handoff"
import { principleFixture } from "../literature/principle-fixtures"
import { eligibilityRecipe, fixtureModel } from "./architecture-model-fixture"
import { report } from "./fixtures"
import type { PrincipleModel } from "../../../src/research/literature/principle-model"

const task = { quantitativeReport: report() }
const admitted = ArchitectureEligibilitySchema.parse({
  implementation: "family_supported", implementationReason: "Linear consumes the ordered context", familyMappings: [{ family: "affine_temporal", role: "prefer", rationale: "Linear temporal model family", transferBoundaries: ["Illustrative latent-to-head recipe"] }], recipe: eligibilityRecipe,
  requiredMechanisms: [], target: "matched", targetReason: "The target is a numerical series",
  conditions: [{ condition: "Numerical target", path: "$.quantitativeReport.dataset.targetColumns", value: ["load"], status: "matched" }],
  objective: "prediction", predictionReason: "Scoped accuracy evidence", requiredData: { knownFutureCovariates: false, staticCovariates: false },
})

test("admission requires an implementable mechanism family, established facts, and a prediction effect", () => {
  expect(architectureEligibilityIssues(admitted, task)).toEqual([])
  expect(architectureEligibilityIssues({ ...admitted, implementation: "unsupported" }, task)).not.toEqual([])
  expect(architectureEligibilityIssues({ ...admitted, implementation: "exact" }, task)).not.toEqual([])
  expect(architectureEligibilityIssues({ ...admitted, familyMappings: undefined }, task)).not.toEqual([])
  expect(architectureEligibilityIssues({ ...admitted, familyMappings: [{ ...admitted.familyMappings![0]!, family: "spectral_representation" }] }, task))
    .toContain("Recipe does not express mechanism family: spectral_representation")
  expect(architectureEligibilityIssues({ ...admitted, familyMappings: [...admitted.familyMappings!, {
    family: "temporal_attention", role: "avoid", rationale: "Synthetic source-backed alternative exclusion",
    transferBoundaries: ["An avoided family need not be instantiated in the preferred-family witness"],
  }] }, task)).toEqual([])
  expect(architectureEligibilityIssues({ ...admitted, requiredMechanisms: ["fixed_trend_basis"] }, task)).toContain("Required mechanism is unsupported")
  expect(architectureEligibilityIssues({ ...admitted, requiredMechanisms: ["moving_average_decomposition"] }, task)).toContain("Recipe does not implement the required mechanism")
  expect(architectureEligibilityIssues({ ...admitted, recipe: { ...eligibilityRecipe, embedding: { type: "patch" }, backbone: { type: "dlinear" } } }, task)).toContain("Implementation witness is not a valid ModelRecipe")
  expect(architectureEligibilityIssues({ ...admitted, target: "unknown" }, task)).not.toEqual([])
  expect(architectureEligibilityIssues({ ...admitted, conditions: [{ ...admitted.conditions[0]!, value: ["invented"] }] }, task)).toContain("Target evidence does not match $.quantitativeReport.dataset.targetColumns")
  expect(architectureEligibilityIssues({ ...admitted, objective: "efficiency_only" }, task)).not.toEqual([])
  expect(architectureEligibilityIssues({ ...admitted, recipe: { ...eligibilityRecipe, recipeVersion: "recipe_schema_v2", representation: undefined, composition: undefined } }, task)).not.toEqual([])
  expect(architectureEligibilityIssues({ ...admitted, requiredData: { knownFutureCovariates: true, staticCovariates: false } }, {
    quantitativeReport: { ...report(), dataset: { ...report().dataset, knownFutureCovariates: [] } },
  })).toContain("Required knownFutureCovariates are absent from this task")
})

test("DLinear family guidance does not require a single context-to-horizon paper layer", () => {
  const recipe = { ...eligibilityRecipe, backbone: { type: "dlinear", kernelSize: 25, individual: false, bias: true } }
  const families = recipeMechanismFamilies(TSFCandidateRecipe.parse(recipe))
  expect(families).toContain("affine_temporal")
  expect(families).toContain("trend_residual_decomposition")
  expect(architectureEligibilityIssues({ ...admitted, recipe, requiredMechanisms: ["moving_average_decomposition"],
    familyMappings: [{ family: "trend_residual_decomposition", role: "prefer", rationale: "Separate low-frequency trend from residual dynamics",
      transferBoundaries: ["Runtime uses latent projections and a separate head; published gains are not current-task gains"] }],
  }, task)).toEqual([])
})

test("missing channel diagnostics cannot be renamed a matched weak-dependence condition", () => {
  const missing = { quantitativeReport: { ...report(), profile: { ...report().profile, crossVarCorrelation: 0 }, statistics: { ...report().statistics, crossLag: {} } } }
  const review = { ...admitted, conditions: [{ condition: "Cross-channel dependence is unknown or unreliable",
    path: "$.quantitativeReport.profile.crossVarCorrelation", value: 0, status: "matched" as const }] }
  expect(architectureEligibilityIssues(review, missing).some((issue) => issue.includes("Cross-channel diagnostics are unavailable"))).toBe(true)
  expect(architectureEligibilityIssues({ ...review, conditions: [{ ...review.conditions[0]!, path: "$.quantitativeReport.statistics.crossLag", value: {} }] }, missing)
    .some((issue) => issue.includes("Cross-channel diagnostics are unavailable"))).toBe(true)
  const computed = { quantitativeReport: { ...missing.quantitativeReport, statistics: { ...report().statistics, crossLag: { source: "temp", target: "load", lag: 0, correlation: 0 } } } }
  expect(architectureEligibilityIssues(review, computed)).toEqual([])
  const measured = { quantitativeReport: { ...missing.quantitativeReport, profile: { ...missing.quantitativeReport.profile,
    correlations: { scope: "target_covariate", evaluatedPairCount: 1, validPairCount: 1, meanAbsCorrelation: 0, maxAbsCorrelation: 0, strongestPairs: [] },
  } } }
  expect(architectureEligibilityIssues(review, measured)).toEqual([])
})

test("PatchTST local-patch knowledge maps to patch tokenization without reproducing its full pipeline", () => {
  const recipe = { ...eligibilityRecipe, embedding: { type: "patch", patchLen: 16, stride: 8, dModel: 64 },
    representation: eligibilityRecipe.representation,
    backbone: { type: "transformer", dModel: 64, nHeads: 4, nLayers: 2, ffnMult: 2, dropout: 0.1 } }
  expect(architectureEligibilityIssues({ ...admitted, recipe, familyMappings: [{ family: "local_patches", role: "prefer",
    rationale: "Represent local time-dependent patterns with contiguous subseries", transferBoundaries: ["Different window and head; local representation principle only"] }],
  }, task)).toEqual([])
})

test("available normalization and exclusions are family choices independent of source bespoke alternatives", () => {
  const recipe = { ...eligibilityRecipe, preprocessing: { actions: [{ type: "last_value_centering" }] } }
  expect(architectureEligibilityIssues({ ...admitted, recipe, familyMappings: [{ family: "instance_level_normalization", role: "prefer",
    rationale: "Remove instance-level offsets before learning temporal dynamics", transferBoundaries: ["Last-value centering does not normalize scale"] }],
  }, task)).toEqual([])
  expect(architectureEligibilityIssues({ ...admitted, familyMappings: [{ ...admitted.familyMappings![0]!, role: "avoid" }] }, task)).toEqual([])
})

test("variable-token attention is cross-channel modeling even with independent downstream fusion", () => {
  const recipe = TSFCandidateRecipe.parse({ ...eligibilityRecipe, embedding: { type: "invert", dModel: 64 },
    backbone: { type: "transformer", dModel: 64, nHeads: 4, nLayers: 2, ffnMult: 2, dropout: 0.1 } })
  expect(recipeMechanismFamilies(recipe)).toContain("variate_tokens")
  expect(recipeMechanismFamilies(recipe)).toContain("cross_channel_mixing")
  expect(recipeMechanismFamilies(recipe)).not.toContain("channel_independent")
})

test("runtime-owned adapter declarations do not invalidate family knowledge or change its scientific decision", async () => {
  await using tmp = await tmpdir()
  const { card } = principleFixture()
  const fixture = fixtureModel()
  let reviews = 0
  const model: PrincipleModel = { modelIdentifier: "repair-family-witness", async request(stage, payload) {
    const response = await fixture.model.request(stage, payload)
    if (stage !== "architecture_review" || ++reviews > 1) return response
    const value = JSON.parse(response.text)
    value.reviews[0].eligibility.requiredMechanisms = ["multiscale_patches"]
    value.reviews[0].eligibility.recipe.representation = { layout: "channel_sequence", readout: "mean", latentDim: 64 }
    return { text: JSON.stringify(value) }
  } }
  const packet = await distillArchitectureKnowledge({ corpus: { cards: [card], historicalCardIDs: [], digest: "repair-witness", warnings: [] },
    model, task, datasetEvidencePaths: [], maxDecisions: 12, auditRoot: path.join(tmp.path, "audit") })
  expect(reviews).toBe(1)
  expect(packet.reviews[0]!.eligibility!.recipe!.representation).toEqual(eligibilityRecipe.representation)
  expect(packet.reviews[0]!.eligibility!.requiredMechanisms).toEqual([])
  expect(packet.status).toBe("completed")
  expect(packet.decisions).toHaveLength(1)
  expect(packet.decisions[0]!.prefer).toBe("Use an ordered temporal encoder")
})

test("a supported spectral family is retained when the mechanism explains a different paper operator", async () => {
  await using tmp = await tmpdir()
  const { card } = principleFixture()
  const fixture = fixtureModel()
  const model: PrincipleModel = { modelIdentifier: "family-transfer-boundary", async request(stage, payload) {
    const value = JSON.parse((await fixture.model.request(stage, payload)).text)
    if (stage === "architecture_extract") {
      value.decisions[0].prefer = "采用频谱表示这一建模类别"
      value.decisions[0].mechanism = "原文 FreMLP 使用复权重并逆变换回时域；该理论解释仅支持所述频谱表示原则，当前实现不复现该算子"
    }
    if (stage === "architecture_review") {
      value.reviews[0].eligibility.recipe = { ...eligibilityRecipe, embedding: { type: "frequency", nFreq: 16, complexMode: "real_imag", dModel: 64 } }
      value.reviews[0].eligibility.familyMappings = [{ family: "spectral_representation", role: "prefer", rationale: "Synthetic source-backed representation principle",
        transferBoundaries: ["Real projection of FFT features does not implement complex FreMLP/IFFT; no transfer of operator-specific gains"] }]
    }
    return { text: JSON.stringify(value) }
  } }
  const packet = await distillArchitectureKnowledge({ corpus: { cards: [card], historicalCardIDs: [], digest: "family-boundary", warnings: [] },
    model, task, datasetEvidencePaths: [], maxDecisions: 12, auditRoot: path.join(tmp.path, "audit") })
  expect(packet.status).toBe("completed")
  expect(packet.decisions).toHaveLength(1)
  expect(packet.reviews[0]!.eligibility!.familyMappings![0]!.transferBoundaries).toHaveLength(1)
  expect(citableTaskEvidence({ entries: [], architectureKnowledge: packet } as any)).toHaveLength(1)
  expect(projectTaskEvidence({ entries: [], architectureKnowledge: packet } as any).architectureKnowledge!.implementationReviews[0]!.eligibility!.familyMappings)
    .toEqual(packet.reviews[0]!.eligibility!.familyMappings)
})

for (const failure of ["unsupported", "mismatch", "efficiency", "missing_fact", "frequency_proxy"] as const) {
  test(`source acceptance cannot bypass ${failure} task admission or fall back to raw cards`, async () => {
    await using tmp = await tmpdir()
    const { card } = principleFixture()
    const fixture = fixtureModel()
    const model: PrincipleModel = { modelIdentifier: failure, async request(stage, payload) {
      const response = await fixture.model.request(stage, payload)
      const value = JSON.parse(response.text)
      if (stage === "architecture_extract" && failure === "frequency_proxy") {
        value.decisions[0].prefer = "在频域上施加复权重 MLP，再逆变换回时域"
        return { text: JSON.stringify(value) }
      }
      if (stage !== "architecture_review") return response
      const review = value.reviews[0].eligibility
      if (failure === "unsupported") review.implementation = "unsupported"
      if (failure === "mismatch") {
        review.target = "mismatch"
        review.conditions[0].status = "contradicted"
      }
      if (failure === "efficiency") review.objective = "efficiency_only"
      if (failure === "frequency_proxy") review.familyMappings[0].family = "spectral_representation"
      if (failure === "missing_fact") review.conditions[0].path = "$.quantitativeReport.statistics.crossLag.correlation"
      return { text: JSON.stringify(value) }
    } }
    const packet = await distillArchitectureKnowledge({ corpus: { cards: [card], historicalCardIDs: [], digest: failure, warnings: [] },
      model, task, datasetEvidencePaths: [], maxDecisions: 12, auditRoot: path.join(tmp.path, "audit") })
    expect(packet.status).toBe(["missing_fact", "frequency_proxy"].includes(failure) ? "partial" : "completed")
    expect(packet.decisions).toEqual([])
    expect(packet.sourceCards).toEqual([])
    expect(packet.exclusions.some((e) => e.stage === (["missing_fact", "frequency_proxy"].includes(failure) ? "source_review_failed" : "task_admission"))).toBe(true)
    expect(fixture.calls).not.toContain("architecture_curate")
  })
}

test("an incorrect target evidence path is repaired before deciding whether knowledge qualifies", async () => {
  await using tmp = await tmpdir()
  const { card } = principleFixture()
  const fixture = fixtureModel()
  let reviews = 0
  const model: PrincipleModel = { modelIdentifier: "repair-target-path", async request(stage, payload) {
    const response = await fixture.model.request(stage, payload)
    if (stage !== "architecture_review" || ++reviews > 1) return response
    const value = JSON.parse(response.text)
    value.reviews[0].eligibility.conditions[0].path = "$.quantitativeReport.targetColumns"
    return { text: JSON.stringify(value) }
  } }
  const packet = await distillArchitectureKnowledge({ corpus: { cards: [card], historicalCardIDs: [], digest: "repair", warnings: [] },
    model, task, datasetEvidencePaths: [], maxDecisions: 12, auditRoot: path.join(tmp.path, "audit") })
  expect(reviews).toBe(2)
  expect(packet.status).toBe("completed")
  expect(packet.decisions).toHaveLength(1)
})

test("old architecture packets are readable but cannot authorize unreviewed task guidance", () => {
  const bundle = { readiness: "partial_evidence", entries: [], architectureKnowledge: {
    version: "architecture_knowledge_v2_mainline", status: "completed", decisions: [{ citations: {
      condition: [{ cardID: "old", sourceIDs: ["s"] }], choice: [], mechanism: [], effect: [],
    } }], sourceCards: [{ knowledgeID: "old" }], warnings: [], reviews: [],
  } } as any
  expect(citableTaskEvidence(bundle)).toEqual([])
  expect(projectTaskEvidence(bundle).architectureKnowledge?.decisions).toEqual([])
  expect(projectTaskEvidence(bundle).readiness).toBe("ready_data_only")
})
