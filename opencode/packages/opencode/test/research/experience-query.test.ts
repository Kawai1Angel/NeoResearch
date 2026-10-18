import { expect, test } from "bun:test"
import fixture from "./fixtures/experience-recall.json"
import { experienceFromMemory, DirectExperienceRequestSchema, type ResearchExperience } from "../../src/research/experience"
import { rankExperiences } from "../../src/research/experience-search"
import { parseExperienceQuery } from "../../src/research/experience-query"
import { ResearchMemoryID, type ResearchMemory, type JsonRecord } from "../../src/research/schema"

const source = (fixture.records as unknown as ResearchMemory[]).map(memory => ({ memory, experience: experienceFromMemory(memory)! }))
function entry(suffix: string, recipe: Record<string, unknown>, actual: Record<string, unknown>, error?: string) {
  const base = source[0]!
  const fact = { ...structuredClone(base.experience.facts[0]!), runID: `run-${suffix}`, proposedModel: recipe,
    executedModel: actual, hypothesisSnapshot: undefined, error,
    stage: error ? "smoke" : "full", status: error ? "failed" : "succeeded", primaryValue: error ? undefined : 1 }
  const experience: ResearchExperience = { schemaVersion: "research_experience.v1", canonicalEvidenceVersion: 1, capturedAt: 1,
    supportDatasetCount: 1, draft: { level: "experiment_fact", polarity: "inconclusive", claimType: "observation",
      statement: "Observed test fixture", intervention: "Observed configuration", observation: "Observed result", conditions: [],
      boundaries: [], unknowns: [], evidence: [{ runID: fact.runID, relation: "supports" }] }, facts: [fact] }
  const memory: ResearchMemory = { ...base.memory, id: ResearchMemoryID.make(`rmem_${suffix}`),
    candidateSummary: { ...base.memory.candidateSummary, experience: experience as unknown as JsonRecord } }
  return { memory, experience }
}
const ids = (entries: ResearchMemory[]) => entries.map(memory => String(memory.id))
const metadata = (memory: ResearchMemory) => memory.candidateSummary.experienceRetrieval as {
  queryIntent: string; relevance: string; matchedRequiredConditions: { requirement: string }[];
  missingRequiredConditions: { requirement: string; status: string }[] }

test("intent distinguishes observed configuration, intervention, matched comparison, discovery and runtime errors", () => {
  for (const [query, intent] of [
    ["hidden_dim=128", "configuration"], ["MLP 隐藏宽度是否有效", "intervention"],
    ["linear vs tcn", "comparison"], ["linear 和 TCN 的对比", "comparison"],
    ["mlp tcn nbeats architectures", "discovery"], ["cudnn RNN backward", "execution_error"],
    ["趋势 linear 残差 tcn 分解", "configuration"],
  ] as const) expect(parseExperienceQuery(query!).intent).toBe(intent!)
  expect(parseExperienceQuery("MLP width", "configuration")).toMatchObject({ intent: "configuration", inferred: false })
  expect(DirectExperienceRequestSchema.parse({ status: "experience_request", request: { query: "MLP width", intent: "configuration" } }).request.intent).toBe("configuration")
})

test("component phrases do not erase a separately named backbone or confuse feature_mlp with an MLP backbone", () => {
  expect(parseExperienceQuery("feature_mlp").entities).toMatchObject([{ component: "fusion", name: "feature_mlp" }])
  expect(parseExperienceQuery("MLP backbone feature_mlp fusion").entities).toEqual(expect.arrayContaining([
    expect.objectContaining({ component: "backbone", name: "mlp" }), expect.objectContaining({ component: "fusion", name: "feature_mlp" }),
  ]))
})

test("width lookup can use an observed configuration; width-effect queries require a real matched contrast", () => {
  const observed = entry("width_observation", { backbone: { type: "mlp", hiddenDim: 128 } }, { backbone: "mlp" })
  expect(ids(rankExperiences([observed], "MLP hidden_dim=128"))).toEqual([String(observed.memory.id)])
  expect(rankExperiences([observed], "MLP 隐藏宽度是否有效")).toEqual([])
  const background = rankExperiences([observed], "MLP 隐藏宽度是否有效", { includeBackground: true })
  expect(metadata(background[0]!)).toMatchObject({ relevance: "configuration_background", queryIntent: "intervention",
    missingRequiredConditions: expect.arrayContaining([expect.objectContaining({ requirement: "queried_intervention_with_matched_full_run_contrast" })]) })
  expect(rankExperiences([observed], "MLP width", { intent: "configuration" })).toHaveLength(1)
})

test("architecture comparison uses named, matched source arms rather than requiring two types in one backbone", () => {
  const full = source.find(entry => entry.memory.id === "rmem_14502938e001iIG6Lzqo1bv9Ys")!
  const result = rankExperiences([full], "linear vs tcn")
  expect(result).toHaveLength(1)
  expect(metadata(result[0]!)).toMatchObject({ queryIntent: "comparison", relevance: "paired_comparison", missingRequiredConditions: [] })
  const unrelated = entry("unpaired", { backbone: { type: "mlp" } }, { backbone: "mlp" })
  unrelated.experience.facts.push({ ...unrelated.experience.facts[0]!, runID: "unpaired-linear", proposedModel: { backbone: { type: "linear" } }, executedModel: { backbone: "linear" } })
  expect(rankExperiences([unrelated], "linear vs mlp")).toEqual([])
})

test("discovery treats multiple architectures as alternatives without inventing a comparison", () => {
  const mlp = entry("mlp_only", { backbone: { type: "mlp" } }, { backbone: "mlp" })
  expect(rankExperiences([mlp], "linear mlp tcn architectures")).toHaveLength(1)
  expect(rankExperiences([mlp], "linear vs mlp")).toEqual([])
})

test("internal TCN residual connections cannot establish trend/residual decomposition", () => {
  const tcn = entry("plain_tcn", { backbone: { type: "tcn" }, preprocessing: { actions: [{ type: "last_value_centering" }] } },
    { backbone: "tcn", preprocessing: ["last_value_centering"], tcn_residual_branch: true, runtime_semantics_revision: 3 })
  const query = "decomposition trend residual branch tcn"
  expect(rankExperiences([tcn], query)).toEqual([])
  const background = rankExperiences([tcn], query, { includeBackground: true })
  expect(metadata(background[0]!)).toMatchObject({ relevance: "configuration_background",
    missingRequiredConditions: expect.arrayContaining([expect.objectContaining({ requirement: "mechanism=decomposition" })]) })
  const decomposed = entry("decomposed_tcn", { backbone: { type: "tcn" }, preprocessing: { actions: [{ type: "series_decomposition" }] } },
    { backbone: "tcn", preprocessing: ["series_decomposition"], runtime_semantics_revision: 3 })
  expect(rankExperiences([decomposed], "series_decomposition preprocessing trend linear residual tcn")).toHaveLength(1)
})

test("trend/residual roles use the native branch routing and do not accept swapped or parallel branches", () => {
  const model = entry("two_branch", { backbone: { type: "linear" }, composition: { type: "decomposition_two_branch", secondary: { backbone: { type: "tcn" } } } },
    { backbone: "linear", composition: { type: "decomposition_two_branch" }, secondary: { backbone: "tcn" }, runtime_semantics_revision: 3 })
  expect(rankExperiences([model], "decomposition trend linear residual tcn")).toHaveLength(1)
  expect(rankExperiences([model], "decomposition trend tcn residual linear")).toEqual([])
  const parallel = entry("parallel", { backbone: { type: "linear" }, composition: { type: "parallel_two_branch", secondary: { backbone: { type: "tcn" } } } },
    { backbone: "linear", composition: { type: "parallel_two_branch" }, secondary: { backbone: "tcn" }, runtime_semantics_revision: 3 })
  expect(rankExperiences([parallel], "decomposition trend linear residual tcn")).toEqual([])
  expect(rankExperiences([parallel], "linear + tcn", { intent: "configuration" })).toHaveLength(1)
})

test("RNN family queries allow both cells but exact GRU/LSTM queries cannot borrow the generic RNN error", () => {
  const error = "cudnn RNN backward can only be called in training mode"
  const gru = entry("gru", { backbone: { type: "rnn", cell: "gru" } }, { backbone: "rnn" }, error)
  const lstm = entry("lstm", { backbone: { type: "rnn", cell: "lstm" } }, { backbone: "rnn" }, error)
  expect(new Set(ids(rankExperiences([gru, lstm], "RNN cudnn backward")))).toEqual(new Set([String(gru.memory.id), String(lstm.memory.id)]))
  expect(ids(rankExperiences([gru, lstm], "GRU cudnn backward"))).toEqual([String(gru.memory.id)])
  expect(ids(rankExperiences([gru, lstm], "LSTM cudnn backward"))).toEqual([String(lstm.memory.id)])
  expect(rankExperiences([gru], "LSTM cudnn backward")).toEqual([])
  expect(metadata(rankExperiences([gru], "LSTM cudnn backward", { includeBackground: true })[0]!)).toMatchObject({ relevance: "configuration_background",
    missingRequiredConditions: expect.arrayContaining([expect.objectContaining({ requirement: "cell=lstm" })]) })
  const unknown = entry("unknown_cell", { backbone: { type: "rnn", cell: "lstm" } }, { backbone: "rnn" }, error)
  unknown.experience.facts[0]!.executionVerified = false
  expect(rankExperiences([unknown], "LSTM cudnn backward")).toEqual([])
})

test("weak channel correlation remains unverified without a defined statistic scope and criterion", () => {
  const model = entry("correlation", { backbone: { type: "linear" }, fusion: { type: "temporal" } }, { backbone: "linear", fusion: "temporal" })
  model.experience.facts[0]!.taskFingerprint = { datasetProfile: { correlations: { scope: "target_covariate", meanAbsCorrelation: 0.01 } } }
  const query = "weakly correlated channel cross-channel fusion channel independent"
  expect(rankExperiences([model], query)).toEqual([])
  const result = rankExperiences([model], query, { includeBackground: true })
  expect(metadata(result[0]!)).toMatchObject({ relevance: "configuration_background", missingRequiredConditions: expect.arrayContaining([
    expect.objectContaining({ requirement: "weak_correlation_requires_explicit_statistic_scope_and_threshold", status: "unknown" }),
  ]) })
})

test("a named mechanism effect requires changing that mechanism, not a learning-rate contrast under the same preprocessing", () => {
  const makePair = (suffix: string, normalization: boolean) => {
    const model = entry(suffix, { backbone: { type: "linear" }, preprocessing: { actions: [{ type: "instance_norm" }] },
      trainingStrategy: { optimizer: { lr: 0.0003 } } }, { backbone: "linear", preprocessing: ["instance_norm"] })
    const trial = model.experience.facts[0]!
    const control = { ...structuredClone(trial), runID: `${trial.runID}-control` }
    const controlPreprocessing = control.proposedModel!.preprocessing as { actions: { type: string }[] }
    if (normalization) {
      controlPreprocessing.actions[0]!.type = "none"
      control.executedModel!.preprocessing = ["none"]
    } else (control.proposedModel!.trainingStrategy as { optimizer: { lr: number } }).optimizer.lr = 0.001
    trial.hypothesisSnapshot = { experimentContract: { mode: "controlled", comparisonRunID: control.runID,
      changes: [{ operation: "set", path: normalization ? "preprocessing.actions.0.type" : "trainingStrategy.optimizer.lr",
        before: normalization ? "none" : 0.001, after: normalization ? "instance_norm" : 0.0003 }] } }
    model.experience.facts.push(control)
    return model
  }
  const targeted = makePair("normalization_change", true)
  const unrelated = makePair("lr_under_normalization", false)
  expect(parseExperienceQuery("归一化是否有效").intent).toBe("intervention")
  expect(ids(rankExperiences([targeted, unrelated], "归一化是否有效"))).toEqual([String(targeted.memory.id)])
  expect(ids(rankExperiences([targeted, unrelated], "instance_norm effect"))).toEqual([String(targeted.memory.id)])
  expect(rankExperiences([targeted, unrelated], "instance_norm", { intent: "configuration" })).toHaveLength(2)
  expect(parseExperienceQuery("instance_norm vs none").entities).toEqual(expect.arrayContaining([
    expect.objectContaining({ component: "preprocessing", name: "none" }),
  ]))
  expect(parseExperienceQuery("preprocessing none embedding none").entities).toEqual(expect.arrayContaining([
    expect.objectContaining({ component: "preprocessing", name: "none" }), expect.objectContaining({ component: "embedding", name: "none" }),
  ]))
})
