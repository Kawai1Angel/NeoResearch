import { expect, test } from "bun:test"
import { ExperimentConstraints, checkExperimentConstraints, declaredExperimentTarget } from "../../src/research/experiment-constraints"
import { frequencyModeUnavailable } from "../../src/research/design-feedback"
import { camelizeKnown } from "../../src/research/llm-proposal"
import { TSFDomain } from "../../src/research/domains/tsf"
import { assessAttribution } from "../../src/research/attribution"

const taskSpec = { contextLength: 96, predictionLengths: [96], dataset: { loaderID: "etth1_tslib_v1", targetCols: ["OT"] }, runtime: { bridgeOnly: false } }
const validate = (candidateSpec: any) => TSFDomain.validateCandidate({ taskSpec, candidateSpec })
const comparison = validate({ ...TSFDomain.buildBaselines(taskSpec)[0]!.candidateSpec,
  embedding: { type: "none" }, backbone: { type: "mlp", hiddenDim: 128, depth: 2, activation: "gelu", dropout: 0.1 },
}).normalizedCandidateSpec!
const legacy = {
  mode: "controlled" as const, comparisonRunID: "anchor",
  changes: [
    { operation: "set" as const, path: "embedding.type", before: "none", after: "frequency" },
    { operation: "add" as const, path: "embedding.n_freq", after: 16 },
    { operation: "add" as const, path: "embedding.d_model", after: 64 },
  ],
  frozenPaths: ["backbone", "training_strategy", "prediction_head"],
  requiredValues: [{ path: "embedding.n_freq", value: 16 }, { path: "embedding.d_model", value: 64 }],
  forbiddenMechanisms: [],
}

test("wire aliases in contract paths normalize to the same fields as candidate JSON", () => {
  const contract = ExperimentConstraints.parse(legacy)
  expect(contract.changes.map((change) => change.path)).toEqual(["embedding.type", "embedding.nFreq", "embedding.dModel"])
  expect(contract.frozenPaths).toEqual(["backbone", "trainingStrategy", "predictionHead"])
  const spec = validate({ ...comparison, embedding: camelizeKnown({ type: "frequency", n_freq: 16, d_model: 64 }) }).normalizedCandidateSpec!
  // Existing captured contracts can be checked without first rewriting them.
  expect(checkExperimentConstraints(legacy, spec, comparison)).toEqual([])
  expect(assessAttribution({ executionVerified: true, proposedModel: spec, hypothesisSnapshot: { experimentContract: legacy } }, { proposedModel: comparison }).status).toBe("eligible")
  expect(legacy.changes[1]!.path).toBe("embedding.n_freq")
  for (const embedding of [{ type: "frequency", nFreq: 8, dModel: 64 }, { type: "frequency", nFreq: 16, dModel: 32 }])
    expect(checkExperimentConstraints(legacy, validate({ ...comparison, embedding }).normalizedCandidateSpec!, comparison).length).toBeGreaterThan(0)
})

test("whole component values and nested indexed values normalize without adding defaults", () => {
  const contract = ExperimentConstraints.parse({ mode: "controlled", comparisonRunID: "anchor", changes: [
    { operation: "set", path: "composition", before: { type: "single" }, after: {
      type: "parallel_two_branch", secondary: { embedding: { type: "frequency", n_freq: 16, complex_mode: "magnitude", d_model: 64 }, representation: { latent_dim: 64 } },
    } },
  ], frozenPaths: ["preprocessing.actions.0.mask_channel"], requiredValues: [
    { path: "training_strategy.budget", value: { max_epochs: 30, time_budget_s: 2400, batch_size: 32 } },
  ] })
  expect(contract.changes[0]).toMatchObject({ after: { secondary: { embedding: { nFreq: 16, complexMode: "magnitude", dModel: 64 }, representation: { latentDim: 64 } } } })
  expect(contract.frozenPaths).toEqual(["preprocessing.actions.0.maskChannel"])
  expect(contract.requiredValues[0]).toEqual({ path: "trainingStrategy.budget", value: { maxEpochs: 30, timeBudgetS: 2400, batchSize: 32 } })
  expect(ExperimentConstraints.parse(legacy).changes[1]).toEqual({ operation: "add", path: "embedding.nFreq", after: 16 })
})

test("alias collisions are rejected before overlap and frozen-field checks can be bypassed", () => {
  expect(ExperimentConstraints.safeParse({ ...legacy, changes: [
    { operation: "add", path: "embedding.n_freq", after: 16 }, { operation: "add", path: "embedding.nFreq", after: 8 },
  ] }).success).toBe(false)
  expect(ExperimentConstraints.safeParse({ ...legacy, frozenPaths: ["embedding.nFreq"] }).success).toBe(false)
  expect(ExperimentConstraints.safeParse({ ...legacy, changes: [
    { operation: "set", path: "embedding", before: { type: "none" }, after: { type: "frequency", n_freq: 16, nFreq: 8, d_model: 64 } },
  ] }).success).toBe(false)
  expect(ExperimentConstraints.safeParse({ ...legacy, requiredValues: [
    { path: "embedding.n_freq", value: 16 }, { path: "embedding.nFreq", value: 8 },
  ] }).success).toBe(false)
})

test("unknown names and string values are not interpreted as recipe aliases", () => {
  const contract = ExperimentConstraints.parse({ mode: "exploratory", requiredValues: [
    { path: "backbone.made_up_field", value: "n_freq" },
  ] })
  expect(contract.requiredValues).toEqual([{ path: "backbone.made_up_field", value: "n_freq" }])
  expect(checkExperimentConstraints(contract, { backbone: { type: "mlp" } }).map((issue) => issue.path)).toEqual(["backbone.made_up_field"])
})

test("a new frequency intervention must choose its spectral mode instead of claiming magnitude from omission", () => {
  const target = declaredExperimentTarget(legacy, comparison)!
  expect(fieldMode(target)).toBeUndefined()
  expect(fieldMode(validate(target).normalizedCandidateSpec!)).toBe("real_imag")
  expect(frequencyModeUnavailable({ hypothesisID: "H-frequency", contract: legacy, comparison }))
    .toMatchObject({ status: "unavailable", hypothesisID: "H-frequency", conflicts: [{ field: "embedding.complexMode" }] })
  const corrected = ExperimentConstraints.parse({ ...legacy, changes: [...legacy.changes,
    { operation: "add", path: "embedding.complex_mode", after: "magnitude" },
  ], requiredValues: [...legacy.requiredValues, { path: "embedding.complex_mode", value: "magnitude" }] })
  expect(frequencyModeUnavailable({ hypothesisID: "H-frequency", contract: corrected, comparison })).toBeUndefined()
  const spec = validate(declaredExperimentTarget(corrected, comparison)).normalizedCandidateSpec!
  expect(fieldMode(spec)).toBe("magnitude")
  expect(checkExperimentConstraints(corrected, spec, comparison)).toEqual([])
  expect(checkExperimentConstraints(corrected, { ...spec, embedding: { ...(spec.embedding as object), complexMode: "real_imag" } }, comparison).length).toBeGreaterThan(0)
})

test("existing frequency modes remain frozen and missing comparisons do not prove a mode conflict", () => {
  expect(frequencyModeUnavailable({ hypothesisID: "H", contract: legacy })).toBeUndefined()
  const anchor = validate({ ...comparison, embedding: { type: "frequency", nFreq: 8, dModel: 64, complexMode: "magnitude" } }).normalizedCandidateSpec!
  const contract = ExperimentConstraints.parse({ mode: "controlled", comparisonRunID: "anchor", changes: [
    { operation: "set", path: "embedding.n_freq", before: 8, after: 16 },
  ] })
  expect(frequencyModeUnavailable({ hypothesisID: "H", contract, comparison: anchor })).toBeUndefined()
  const spec = validate(declaredExperimentTarget(contract, anchor)).normalizedCandidateSpec!
  expect(fieldMode(spec)).toBe("magnitude")
  expect(checkExperimentConstraints(contract, spec, anchor)).toEqual([])
})

function fieldMode(spec: Record<string, unknown>) {
  return (spec.embedding as Record<string, unknown>).complexMode
}
