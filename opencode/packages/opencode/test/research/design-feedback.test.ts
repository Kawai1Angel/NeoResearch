import { expect, test } from "bun:test"
import { schemaRemovalUnavailable, mechanismRequirementsUnavailable, formatDesignValidationIssue } from "../../src/research/design-feedback"
import { ExperimentConstraints, checkExperimentConstraints } from "../../src/research/experiment-constraints"
import { TSFDomain } from "../../src/research/domains/tsf"

const taskSpec = {
  contextLength: 96,
  predictionLengths: [96],
  dataset: { loaderID: "etth1_tslib_v1", targetCols: ["OT"] },
  runtime: { bridgeOnly: false },
}
const comparison = TSFDomain.validateCandidate({ taskSpec, candidateSpec: {
  ...TSFDomain.buildBaselines(taskSpec)[0]!.candidateSpec,
  embedding: { type: "none" },
  backbone: { type: "dlinear", kernelSize: 25, individual: false, bias: true },
} }).normalizedCandidateSpec!
const changes = [
  { operation: "set", path: "backbone.type", before: "dlinear", after: "linear" },
  { operation: "remove", path: "backbone.kernelSize", before: 25 },
  { operation: "remove", path: "backbone.individual", before: false },
  { operation: "add", path: "backbone.shared", after: true },
]
const validate = (candidateSpec: typeof comparison) => TSFDomain.validateCandidate({ taskSpec, candidateSpec })

test("a control cannot simultaneously require and forbid its treatment mechanism", () => {
  const experimentContract = ExperimentConstraints.parse({ mode: "controlled", comparisonRunID: "anchor", changes,
    forbiddenMechanisms: ["moving_average_decomposition"] })
  const report = mechanismRequirementsUnavailable({ hypothesisID: "H-control", experimentContract,
    requiredMechanisms: ["moving_average_decomposition"] })!
  expect(report.status).toBe("unavailable")
  expect(report.hypothesisID).toBe("H-control")
  expect(report.conflicts[0]?.field).toBe("requiredMechanisms.moving_average_decomposition")
  expect(report.suggestedRevision).toContain("candidate arm")
  expect(mechanismRequirementsUnavailable({ hypothesisID: "H-control", experimentContract, requiredMechanisms: [] })).toBeUndefined()
  expect(mechanismRequirementsUnavailable({ hypothesisID: "H-treatment", requiredMechanisms: ["moving_average_decomposition"] })).toBeUndefined()
})

test("a matched control cannot remove bias restored by the linear schema", () => {
  const original = structuredClone(comparison)
  const contract = ExperimentConstraints.parse({ mode: "controlled", comparisonRunID: "anchor", changes: [
    ...changes, { operation: "remove", path: "backbone.bias", before: true },
  ] })
  const feedback = schemaRemovalUnavailable({ hypothesisID: "H-control", contract, comparison, validate })!
  expect(feedback.status).toBe("unavailable")
  expect(feedback.hypothesisID).toBe("H-control")
  expect(feedback.conflicts).toHaveLength(1)
  expect(feedback.conflicts[0]).toMatchObject({ field: "backbone.bias" })
  expect(feedback.conflicts[0]!.supported).toContain("true")
  expect(comparison).toEqual(original)
})

test("a feasible matched control preserves bias and removes only DLinear fields", () => {
  const contract = ExperimentConstraints.parse({ mode: "controlled", comparisonRunID: "anchor", changes })
  expect(schemaRemovalUnavailable({ hypothesisID: "H-control", contract, comparison, validate })).toBeUndefined()
  const trial = validate({ ...comparison, backbone: { type: "linear", shared: true, bias: true } })
  expect(trial.ok).toBe(true)
  expect(checkExperimentConstraints(contract, trial.normalizedCandidateSpec!, comparison)).toEqual([])
})

test("explicitly disabling bias is feasible when declared as an intervention", () => {
  const contract = ExperimentConstraints.parse({ mode: "controlled", comparisonRunID: "anchor", changes: [
    ...changes, { operation: "set", path: "backbone.bias", before: true, after: false },
  ] })
  expect(schemaRemovalUnavailable({ hypothesisID: "H-control", contract, comparison, validate })).toBeUndefined()
  const trial = validate({ ...comparison, backbone: { type: "linear", shared: true, bias: false } })
  expect(checkExperimentConstraints(contract, trial.normalizedCandidateSpec!, comparison)).toEqual([])
})

test("missing comparisons and stale before values do not prove schema conflicts", () => {
  const contract = ExperimentConstraints.parse({ mode: "controlled", comparisonRunID: "anchor", changes: [
    ...changes, { operation: "remove", path: "backbone.bias", before: false },
  ] })
  expect(schemaRemovalUnavailable({ hypothesisID: "H-control", contract, validate })).toBeUndefined()
  expect(schemaRemovalUnavailable({ hypothesisID: "H-control", contract, comparison, validate })).toBeUndefined()
})

test("validation diagnostics preserve null, false and the normalized actual value", () => {
  expect(formatDesignValidationIssue({ path: "backbone.bias", message: "Contract mismatch", expected: null, actual: true }))
    .toBe("backbone.bias: Contract mismatch (expected=null, actual=true)")
  expect(formatDesignValidationIssue({ path: "backbone.bias", message: "Contract mismatch", expected: false, actual: true }))
    .toContain("expected=false")
  expect(formatDesignValidationIssue({ path: "backbone", message: "Invalid type" })).toBe("backbone: Invalid type")
})
