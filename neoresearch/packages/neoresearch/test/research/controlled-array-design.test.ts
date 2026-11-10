import { expect, test } from "bun:test"
import { ExperimentConstraints, checkExperimentConstraints, changedFields } from "../../src/research/experiment-constraints"
import { TSFDomain } from "../../src/research/domains/tsf"
import { assessAttribution } from "../../src/research/attribution"

test("indexed array interventions preserve sibling and array-structure constraints", () => {
  const before = { preprocessing: { actions: [{ type: "instance_norm", affine: false, eps: 1e-5 }, { type: "none" }] } }
  const target = { preprocessing: { actions: [{ type: "instance_norm", affine: true, eps: 1e-5 }, { type: "none" }] } }
  const indexed = ExperimentConstraints.parse({ mode: "controlled", comparisonRunID: "anchor",
    changes: [{ operation: "set", path: "preprocessing.actions.0.affine", before: false, after: true }] })
  expect(changedFields(before, target)).toEqual(["preprocessing.actions.0.affine"])
  expect(checkExperimentConstraints(indexed, target, before)).toEqual([])
  const otherParameter = structuredClone(target)
  otherParameter.preprocessing.actions[0]!.eps = 0.01
  expect(checkExperimentConstraints(indexed, otherParameter, before).map((i) => i.path)).toContain("preprocessing.actions.0.eps")
  const reordered = { preprocessing: { actions: target.preprocessing.actions.toReversed() } }
  expect(checkExperimentConstraints(indexed, reordered, before).length).toBeGreaterThan(0)
  const added = { preprocessing: { actions: [...target.preprocessing.actions, { type: "none" }] } }
  expect(checkExperimentConstraints(indexed, added, before).map((i) => i.path)).toContain("preprocessing.actions.2")
  const removed = { preprocessing: { actions: target.preprocessing.actions.slice(0, 1) } }
  expect(checkExperimentConstraints(indexed, removed, before).map((i) => i.path)).toContain("preprocessing.actions.1")
  const whole = ExperimentConstraints.parse({ ...indexed, changes: [{ operation: "set", path: "preprocessing.actions", before: before.preprocessing.actions, after: target.preprocessing.actions }] })
  expect(checkExperimentConstraints(whole, target, before)).toEqual([])
})

test("none to instance_norm admits only schema-implied defaults and preserves attribution", () => {
  const taskSpec = { contextLength: 96, predictionLengths: [96], dataset: { loaderID: "etth1_tslib_v1", targetCols: ["OT"] }, runtime: { bridgeOnly: false } }
  const validate = (candidateSpec: any) => TSFDomain.validateCandidate({ taskSpec, candidateSpec })
  const anchor = validate({ ...TSFDomain.buildBaselines(taskSpec)[0]!.candidateSpec,
    preprocessing: { actions: [{ type: "none" }] } }).normalizedCandidateSpec!
  const contract = ExperimentConstraints.parse({ mode: "controlled", comparisonRunID: "anchor",
    changes: [{ operation: "set", path: "preprocessing.actions.0.type", before: "none", after: "instance_norm" }],
    requiredValues: [{ path: "preprocessing.actions.0.type", value: "instance_norm" }],
    frozenPaths: ["backbone", "trainingStrategy"] })
  const treatment = validate({ ...anchor, preprocessing: { actions: [{ type: "instance_norm" }] } }).normalizedCandidateSpec!
  expect(treatment.preprocessing).toEqual({ actions: [{ type: "instance_norm", affine: false, eps: 1e-5 }] })
  expect(checkExperimentConstraints(contract, treatment, anchor)).toEqual([])
  expect(assessAttribution({ executionVerified: true, proposedModel: treatment, hypothesisSnapshot: { experimentContract: contract } }, { proposedModel: anchor }))
    .toMatchObject({ status: "eligible", changedPaths: ["preprocessing.actions.0.type", "preprocessing.actions.0.affine", "preprocessing.actions.0.eps"] })
  for (const extra of [{ affine: true }, { eps: 0.01 }]) {
    const altered = validate({ ...anchor, preprocessing: { actions: [{ type: "instance_norm", ...extra }] } }).normalizedCandidateSpec!
    expect(checkExperimentConstraints(contract, altered, anchor).length).toBeGreaterThan(0)
  }
  expect(checkExperimentConstraints({ ...contract, frozenPaths: ["preprocessing.actions.0.affine"] }, treatment, anchor).length).toBeGreaterThan(0)
  expect(checkExperimentConstraints(contract, { ...treatment, representation: { latentDim: 999 } }, anchor).length).toBeGreaterThan(0)
  const whole = ExperimentConstraints.parse({ ...contract, changes: [{ operation: "set", path: "preprocessing.actions",
    before: [{ type: "none" }], after: [{ type: "instance_norm" }] }] })
  expect(checkExperimentConstraints(whole, treatment, anchor)).toEqual([])
  expect(checkExperimentConstraints({ ...contract, changes: [{ operation: "set", path: "preprocessing.actions.0.type", before: "wrong", after: "instance_norm" }] }, treatment, anchor).length).toBeGreaterThan(0)
})
