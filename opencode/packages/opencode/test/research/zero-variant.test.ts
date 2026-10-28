import { expect, test } from "bun:test"
import { DomainRegistry } from "../../src/research/domain-registry"
import { buildTSFBaselines, proposeTSFCandidate, rankTSFCandidateProposals } from "../../src/research/domains/tsf"
import { buildDefaultTsfResearchTaskInput, buildDefaultTsfResearchTaskInputFromGoal } from "../../src/cli/cmd/research-data"
import { buildHypoPlannerResult, referenceBaselineOptions, type HypothesisObject } from "../../src/research/agents/hypo-planner-agent"
import type { ResearchTask } from "../../src/research/schema"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { Effect } from "effect"
import { provideInstance, tmpdir } from "../fixture/fixture"

function input(bridgeOnly = false) {
  return buildDefaultTsfResearchTaskInput({ mode: "autonomous", researchVariant: "zero", bridgeOnly })
}

const hypothesis: HypothesisObject = {
  id: "H_zero", statement: "Design a model autonomously from the dataset's seasonal structure.", motivation: ["An observed period is 24."],
  expectedOutcome: "Reduce cv_avg_mse", suggestedBackbones: ["mlp"], suggestedPreprocessing: [],
  experimentContract: { mode: "exploratory", changes: [], frozenPaths: [], requiredValues: [], forbiddenMechanisms: [] },
  requiredMechanisms: [], risk: "May overfit", testable: true, datasetEvidencePaths: [], literatureEvidence: [],
  applicabilityAssumptions: [], falsificationCriteria: ["An invalid primary metric in full validation cannot support this approach."], evidenceLevel: "data_only",
}

for (const bridgeOnly of [true, false]) {
  test(`zero has no preset or heuristic candidate paths (bridgeOnly=${bridgeOnly})`, () => {
    const taskSpec = DomainRegistry.createTaskSpec("tsf", input(bridgeOnly).taskSpec)
    const context = { taskSpec, candidates: [], runs: [], memory: [] }
    expect(DomainRegistry.buildBaselines("tsf", taskSpec)).toEqual([])
    expect(buildTSFBaselines(taskSpec)).toEqual([])
    expect(DomainRegistry.rankCandidateProposals("tsf", context)).toEqual([])
    expect(rankTSFCandidateProposals(context)).toEqual([])
    expect(DomainRegistry.proposeCandidate("tsf", context)).toBeUndefined()
    expect(proposeTSFCandidate(context)).toBeUndefined()
    expect(referenceBaselineOptions({ taskSpec } as ResearchTask)).toEqual([])
  })
}

test("zero validates its configuration and goal builder preserves the explicit variant", () => {
  expect(buildDefaultTsfResearchTaskInputFromGoal({ goal: "Forecast OT horizon=24", mode: "autonomous", researchVariant: "zero" }).taskSpec.metadata)
    .toMatchObject({ researchVariant: "zero" })
  for (const metadata of [{ researchVariant: "typo" }, { researchVariant: "zero", referenceBaseline: "tsf_baseline_dlinear" }]) {
    expect(() => DomainRegistry.createTaskSpec("tsf", { ...input().taskSpec, metadata })).toThrow()
  }
  expect(DomainRegistry.buildBaselines("tsf", buildDefaultTsfResearchTaskInput({ mode: "autonomous" }).taskSpec).length).toBeGreaterThan(0)
  const candidateSpec = DomainRegistry.buildBaselines("tsf", buildDefaultTsfResearchTaskInput({ mode: "autonomous" }).taskSpec)[0]!.candidateSpec
  expect(() => DomainRegistry.createRunPlan("tsf", { taskSpec: input().taskSpec, candidateSpec, stage: "baseline" }))
    .toThrow("disables preset baselines")
})

test("zero requires autonomous hypotheses and explicit selection, and permits an explicit stop", () => {
  const task = { ...input(), id: "rtsk_zero" } as ResearchTask
  const base = { task, dataAnalysisSummary: "The period is 24", runs: [], memory: [] }
  expect(() => buildHypoPlannerResult(base)).toThrow("deterministic hypothesis fallback is disabled")
  const nextExperiment = { action: "experiment" as const, hypothesisID: hypothesis.id, rationale: "Test the selected hypothesis directly" }
  const result = buildHypoPlannerResult({ ...base, llmHypotheses: [hypothesis], nextExperiment })
  expect(result.plan.baselineStrategy).toBe("autonomous_from_scratch")
  expect(result.plan.referenceBaseline).toBeUndefined()
  expect(result.plan.nextExperiment).toEqual(nextExperiment)
  expect(() => buildHypoPlannerResult({ ...base, llmHypotheses: [hypothesis], nextExperiment, toolReferenceBaseline: "tsf_baseline_dlinear" })).toThrow()
  expect(() => buildHypoPlannerResult({ ...base, llmHypotheses: [{ ...hypothesis, experimentContract: { ...hypothesis.experimentContract!, mode: "baseline" } }], nextExperiment })).toThrow("exploratory or controlled")
  expect(() => buildHypoPlannerResult({ ...base, llmHypotheses: [hypothesis], nextExperiment: { ...nextExperiment, hypothesisID: "missing" } })).toThrow("open hypothesis")
  expect(() => buildHypoPlannerResult({ ...base, llmHypotheses: [{ ...hypothesis, evidenceLevel: "paper_supported", literatureEvidence: [{ cardID: "invented", cardRevision: 1, role: "supports_mechanism" }] }], nextExperiment })).toThrow()
  const stop = buildHypoPlannerResult({ ...base, llmHypotheses: [], nextExperiment: { action: "stop", rationale: "No feasible experiment" } })
  expect(stop.plan.hypotheses).toEqual([])
  expect(stop.plan.nextExperiment?.action).toBe("stop")
})

test("zero session planner uses an autonomous prompt and denies baseline tools", async () => {
  await using tmp = await tmpdir()
  const agent = await Effect.runPromise(provideInstance(tmp.path)(Agent.Service.use((svc) => svc.get("research-hypo-planner-zero")))
    .pipe(Effect.provide(Agent.defaultLayer)))
  expect(agent.prompt).toContain("NeoResearch-zero")
  expect(agent.prompt).toContain("Then select one for immediate model design")
  expect(agent.prompt).not.toContain("must explicitly call `pick_baseline")
  expect(Permission.evaluate("pick_baseline", "*", agent.permission).action).toBe("deny")
  expect(Permission.evaluate("load_baseline", "*", agent.permission).action).toBe("deny")
  expect(Permission.evaluate("hypothesis_select", "*", agent.permission).action).toBe("allow")
})
