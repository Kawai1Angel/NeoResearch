import { expect, test } from "bun:test"
import { ExperimentConstraints, checkExperimentConstraints } from "../../src/research/experiment-constraints"
import { assessAttribution } from "../../src/research/attribution"
import { finalMetrics, buildExperimentResultEvidence } from "../../src/research/runner-evidence"
import { runVerifiers } from "../../src/research/verifiers"
import {
  validatePrincipleReview,
  validatePrincipleReviewEnvelope,
} from "../../src/research/literature/knowledge-v2-validator"
import { principleFixture, candidate as fixtureCandidate } from "./literature/principle-fixtures"

const base = {
  backbone: { type: "linear", shared: false },
  representation: { latentDim: 512 },
  composition: { type: "single" },
  preprocessing: { actions: [{ type: "none" }] },
  trainingStrategy: { optimizer: { lr: 0.001 }, budget: { maxEpochs: 10, patience: 3 } },
}
const contract = ExperimentConstraints.parse({
  mode: "controlled",
  comparisonRunID: "baseline",
  changes: [{ operation: "set", path: "backbone.shared", before: false, after: true }],
  requiredValues: [{ path: "backbone.shared", value: true }],
  frozenPaths: ["representation", "composition", "trainingStrategy"],
  forbiddenMechanisms: ["moving_average_decomposition"],
})
const trial = { ...base, backbone: { type: "linear", shared: true } }

test("declared intervention is exact and every unlisted field remains frozen", () => {
  expect(checkExperimentConstraints(contract, trial, base)).toEqual([])
  expect(checkExperimentConstraints(contract, base, base).map((x) => x.path)).toContain("backbone.shared")
  for (const spec of [
    { ...trial, representation: { latentDim: 64 } },
    { ...trial, trainingStrategy: { ...base.trainingStrategy, budget: { maxEpochs: 20, patience: 5 } } },
    { ...trial, composition: { type: "parallel_two_branch" } },
  ])
    expect(checkExperimentConstraints(contract, spec, base).length).toBeGreaterThan(0)
  expect(checkExperimentConstraints(contract, trial)).toMatchObject([{ path: "comparisonRunID" }])
})

test("control removals cannot be repaired by reintroducing the treatment", () => {
  const withDecomp = { ...base, preprocessing: { actions: [{ type: "series_decomposition", kernelSize: 25 }] } }
  const control = ExperimentConstraints.parse({
    mode: "controlled",
    comparisonRunID: "decomp",
    changes: [
      {
        operation: "set",
        path: "preprocessing.actions",
        before: withDecomp.preprocessing.actions,
        after: base.preprocessing.actions,
      },
    ],
    forbiddenMechanisms: ["moving_average_decomposition"],
  })
  expect(checkExperimentConstraints(control, base, withDecomp)).toEqual([])
  expect(checkExperimentConstraints(control, withDecomp, withDecomp).map((x) => x.path)).toContain(
    "forbiddenMechanisms.moving_average_decomposition",
  )
  expect(ExperimentConstraints.safeParse({ ...contract, frozenPaths: ["backbone"] }).success).toBe(false)
  expect(ExperimentConstraints.safeParse({ mode: "controlled" }).success).toBe(false)
})

test("no-op interventions are rejected before reaching ModelDesigner", () => {
  expect(ExperimentConstraints.safeParse({ ...contract,
    changes: [{ operation: "set", path: "backbone.shared", before: false, after: false }],
  }).success).toBe(false)
})

test("finite metrics survive while missing or mismatched scientific contracts remain unattributable", () => {
  const fact = { executionVerified: true, proposedModel: trial, hypothesisSnapshot: { experimentContract: contract } }
  expect(assessAttribution(fact, { proposedModel: base }).status).toBe("eligible")
  expect(assessAttribution({ ...fact, proposedModel: base }, { proposedModel: base }).status).toBe("mismatch")
  expect(assessAttribution({ ...fact, hypothesisSnapshot: undefined }).status).toBe("insufficient_evidence")
  const result = buildExperimentResultEvidence({
    runID: "trial",
    stage: "full",
    status: "succeeded",
    primaryMetric: "cv_avg_mse",
    metrics: { cv_avg_mse: 0.3, cv_std_mse: 0.1, cv_h720_mse: 0.5 },
    candidateSpec: base,
    executionVerified: true,
  })
  expect(result.metrics.cv_h720_mse).toBe(0.5)
  expect(result.metricValidity).toBe("observed")
  expect(result.attribution.status).toBe("insufficient_evidence")
})

test("only final event metrics enter ranking, never epoch losses or fold identifiers", () => {
  expect(
    finalMetrics(
      [
        { event: "epoch_end", val_loss: 9, cv_fold_index: 3 },
        { event: "cv_eval_done", cv_avg_mse: 0.3, cv_std_mse: 0.1, cv_h24_mse: 0.2 },
        { event: "eval_done", val_avg_mse: 0.4 },
      ],
      "full",
    ),
  ).toEqual({ cv_avg_mse: 0.3, cv_std_mse: 0.1, cv_h24_mse: 0.2, val_avg_mse: 0.4 })
})

test("CV horizons use actual runtime keys, arbitrary lengths, and do not mix validation scopes", () => {
  const ctx = {
    task: { budget: {}, taskSpec: { predictionLengths: [24, 48] }, objective: { primaryMetric: "cv_avg_mse" } },
    run: {
      stage: "full",
      status: "succeeded",
      metrics: { cv_avg_mse: 1, cv_h24_mse: 0.1, cv_h48_mse: 10, val_h24_mse: 1, val_h48_mse: 1 },
      resourceUsage: {},
    },
    previousRuns: [],
  } as any
  const report = runVerifiers(ctx)
  expect(report.results.find((x) => x.name === "horizon_verifier")?.status).toBe("failed")
  expect(report.results.find((x) => x.name === "overfitting_verifier")?.status).toBe("insufficient_evidence")
  expect(report.results.find((x) => x.name === "cost_perf_verifier")?.accepted).toBe(false)
})

test("a literature review with supported labels but no read evidence cannot approve assertions", () => {
  const { card } = principleFixture()
  const candidate = fixtureCandidate()
  const blindReview = { ...card.review, reviewedSourceIDs: ["unrelated-source"] }
  expect(validatePrincipleReview(candidate, blindReview, ["unrelated-source"])).toContain(
    "assertion_evidence_unreviewed",
  )
  expect(validatePrincipleReviewEnvelope(candidate, blindReview as any, ["unrelated-source"])).toContain(
    "assertion_evidence_unreviewed",
  )
})
