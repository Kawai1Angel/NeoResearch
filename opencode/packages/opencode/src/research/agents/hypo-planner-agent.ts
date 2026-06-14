import type { JsonRecord, ResearchMemory, ResearchRun, ResearchTask, ResearchTaskID } from "../schema"

export interface HypothesisObject {
  readonly id: string
  readonly statement: string
  readonly motivation: readonly string[]
  readonly expectedOutcome: string
  readonly suggestedBackbones: readonly string[]
  readonly suggestedPreprocessing: readonly string[]
  readonly priority: "high" | "medium" | "low"
  readonly risk: string
  readonly testable: boolean
}

export interface ExperimentPlan {
  readonly hypotheses: readonly HypothesisObject[]
  readonly baselineStrategy: string
  readonly searchBiases: readonly string[]
  readonly stopConditions: {
    readonly maxTrials: number
    readonly noImprovementRounds: number
    readonly targetMetricValue?: number
  }
  // Recipe ID of the baseline HypoPlanner picked as the comparison anchor and first candidate
  // to run, on its first invocation (runs.length === 0 && memory.length === 0). Only set on
  // that first call; later calls omit it and the previously persisted value is kept.
  readonly referenceBaseline?: string
  // Whether referenceBaseline was chosen by an LLM call or by the deterministic heuristic
  // fallback (e.g. LLM unavailable or returned an invalid recipe ID).
  readonly referenceBaselineSource?: "llm" | "heuristic"
}

export interface HypoPlannerResult {
  readonly agent: "HypoPlannerAgent"
  readonly taskID: ResearchTaskID
  readonly plan: ExperimentPlan
  readonly planMarkdown: string
  readonly hypothesesYaml: string
  readonly evidenceSummary: string
  readonly llm: {
    readonly status: "disabled" | "not_configured" | "used" | "failed" | "skipped"
    readonly model?: string
    readonly error?: string
  }
}

export interface HypoPlannerInput {
  readonly task: ResearchTask
  readonly dataAnalysisSummary: string
  readonly runs: readonly ResearchRun[]
  readonly memory: readonly ResearchMemory[]
  readonly llmHypotheses?: readonly HypothesisObject[]
  // Recipe ID an LLM call selected as the reference baseline / first candidate, when
  // buildHypoPlannerResult is invoked on the first call. Validated against
  // referenceBaselineOptions(task) before use; ignored otherwise.
  readonly llmReferenceBaseline?: string
}

interface HypothesisRule {
  readonly bias: string
  readonly statement: string
  readonly metricKeys: readonly string[]
  readonly suggestedBackbones: readonly string[]
  readonly suggestedPreprocessing: readonly string[]
  readonly expectedOutcome: string
  readonly priority: "high" | "medium" | "low"
  readonly risk: string
}

const hypothesisRules: readonly HypothesisRule[] = [
  {
    bias: "seasonal",
    statement: "seasonal structure will benefit from decomposition-aware or frequency-aware backbones.",
    metricKeys: ["seasonalityStrength", "acfMainPeriodStrength"],
    suggestedBackbones: ["dlinear", "nbeats", "patch_transformer"],
    suggestedPreprocessing: ["seasonal_decomposition", "per_series_normalization"],
    expectedOutcome: "Decomposition-aware backbones should reduce val_avg_mse compared to non-seasonal baselines by better capturing periodic patterns.",
    priority: "high",
    risk: "The detected period may be weak or unstable across the evaluation horizon.",
  },
  {
    bias: "trend",
    statement: "trend structure will benefit from detrending and low-variance linear or mixer backbones.",
    metricKeys: ["trendStrength", "adfStatistic"],
    suggestedBackbones: ["dlinear", "linear", "mixer"],
    suggestedPreprocessing: ["detrend", "standard_scaling"],
    expectedOutcome: "Detrending preprocessing combined with linear or mixer backbones should yield stable val_avg_mse with lower variance across horizon lengths.",
    priority: "high",
    risk: "Aggressive detrending can remove useful low-frequency signal.",
  },
  {
    bias: "cross_var_correlated",
    statement: "cross-variate dependencies will benefit from channel-mixing backbones.",
    metricKeys: ["crossVarCorrelation"],
    suggestedBackbones: ["mixer", "patch_transformer", "tcn"],
    suggestedPreprocessing: ["channel_normalization", "correlation_screening"],
    expectedOutcome: "Channel-mixing backbones should outperform independent-channel baselines by leveraging inter-variate dependencies.",
    priority: "high",
    risk: "Spurious channel correlations can overfit small validation windows.",
  },
  {
    bias: "missing_values",
    statement: "missing-value patterns should be handled before testing higher-capacity backbones.",
    metricKeys: ["missingRate"],
    suggestedBackbones: ["linear", "dlinear", "mixer"],
    suggestedPreprocessing: ["forward_fill", "mask_features", "robust_scaling"],
    expectedOutcome: "Imputation and masking should prevent training divergence, improving val_avg_mse compared to unmasked inputs.",
    priority: "medium",
    risk: "Imputation can leak future information if it is not restricted to causal context.",
  },
  {
    bias: "distribution_shift",
    statement: "distribution shift calls for robust preprocessing and lower-variance candidates first.",
    metricKeys: ["distributionShift", "outlierRate"],
    suggestedBackbones: ["dlinear", "mixer", "linear"],
    suggestedPreprocessing: ["robust_scaling", "rolling_normalization", "time_ordered_validation"],
    expectedOutcome: "Robust-scaling candidates should show smaller degradation between validation and reference-test MSE under distribution shift.",
    priority: "high",
    risk: "A short validation split may not represent the shifted test regime.",
  },
  {
    bias: "probabilistic",
    statement: "probabilistic forecasting should compare calibrated distributional heads against point baselines.",
    metricKeys: [],
    suggestedBackbones: ["mixer", "patch_transformer", "tcn"],
    suggestedPreprocessing: ["quantile_targets", "calibration_check"],
    expectedOutcome: "Distributional heads should achieve better calibration (CRPS/quantile coverage) while not degrading point-MSE by more than 5%.",
    priority: "medium",
    risk: "Distributional losses can improve calibration while worsening the primary point metric.",
  },
  {
    bias: "long_horizon",
    statement: "long-horizon forecasting should prefer stable low-frequency and patch-based candidates.",
    metricKeys: ["horizonContextRatio"],
    suggestedBackbones: ["dlinear", "patch_transformer", "nbeats"],
    suggestedPreprocessing: ["multi_horizon_validation", "context_window_ablation"],
    expectedOutcome: "Patch-based and low-frequency candidates should maintain lower MSE at horizon 336 and 720 compared to step-by-step recurrent alternatives.",
    priority: "medium",
    risk: "Long horizons can hide short-term errors behind averaged metrics.",
  },
  {
    bias: "multivariate",
    statement: "multivariate targets should verify whether channel mixing improves over independent baselines.",
    metricKeys: ["targetCount"],
    suggestedBackbones: ["mixer", "patch_transformer", "linear"],
    suggestedPreprocessing: ["per_channel_scaling", "target_correlation_audit"],
    expectedOutcome: "Channel-mixing variants should improve val_avg_mse over per-channel baselines when cross-channel correlation is confirmed.",
    priority: "medium",
    risk: "Extra channel capacity may add noise when targets are weakly related.",
  },
]

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.length > 0)
}

function unique(items: readonly string[]) {
  return [...new Set(items.filter((item) => item.length > 0))]
}

function taskMetadata(task: ResearchTask) {
  return recordValue(recordValue(task.taskSpec).metadata)
}

function taskProfile(task: ResearchTask): Record<string, unknown> {
  const spec = recordValue(task.taskSpec)
  const metadata = taskMetadata(task)
  return {
    ...recordValue(metadata.datasetProfile),
    ...recordValue(spec.datasetProfile),
  }
}

function taskSearchBiases(task: ResearchTask) {
  const spec = recordValue(task.taskSpec)
  const metadata = taskMetadata(task)
  return unique([...stringList(metadata.searchBiases), ...stringList(spec.searchBiases)])
}

function profileDerivedBiases(task: ResearchTask) {
  const profile = taskProfile(task)
  const biases: string[] = []
  if ((numberValue(profile.seasonalityStrength) ?? 0) >= 0.35) biases.push("seasonal")
  if ((numberValue(profile.trendStrength) ?? 0) >= 0.3) biases.push("trend")
  if ((numberValue(profile.crossVarCorrelation) ?? 0) >= 0.4) biases.push("cross_var_correlated")
  if ((numberValue(profile.missingRate) ?? 0) > 0) biases.push("missing_values")
  if ((numberValue(profile.distributionShift) ?? 0) >= 0.2) biases.push("distribution_shift")
  if ((numberValue(profile.horizonContextRatio) ?? 0) >= 1) biases.push("long_horizon")
  if ((numberValue(profile.targetCount) ?? 0) > 1) biases.push("multivariate")
  return unique(biases)
}

function orderedBiases(task: ResearchTask) {
  const explicit = taskSearchBiases(task)
  const source = explicit.length > 0 ? explicit : profileDerivedBiases(task)
  const known = hypothesisRules.map((rule) => rule.bias)
  return unique([
    ...known.filter((bias) => source.includes(bias)),
    ...source.filter((bias) => !known.includes(bias)),
  ])
}

function formatNumber(value: number) {
  return Number(value.toFixed(6)).toString()
}

function metricMotivations(rule: HypothesisRule, task: ResearchTask) {
  const profile = taskProfile(task)
  return rule.metricKeys.flatMap((key) => {
    const number = numberValue(profile[key])
    return number === undefined ? [] : [`Dataset profile ${key}=${formatNumber(number)}.`]
  })
}

function historyMotivations(runs: readonly ResearchRun[]) {
  if (runs.length === 0) return []
  const succeeded = runs.filter((run) => run.status === "succeeded").length
  const failed = runs.filter((run) => run.status === "failed").length
  const rejected = runs.filter((run) => run.status === "rejected").length
  return [`Run history: ${succeeded} succeeded, ${failed} failed, ${rejected} rejected.`]
}

function memoryMotivations(memory: readonly ResearchMemory[]) {
  return memory.slice(0, 2).map((item) => `Memory: ${item.lesson}`)
}

function fallbackHypothesis(input: HypoPlannerInput): HypothesisObject {
  return {
    id: "H1",
    statement: "baseline controls should establish a reliable metric floor before higher-risk search.",
    motivation: [
      "No strong profile-derived search bias was available.",
      ...historyMotivations(input.runs),
      ...memoryMotivations(input.memory),
    ],
    expectedOutcome: "val_avg_mse should decrease below the naive baseline, providing a reliable reference point for subsequent search.",
    suggestedBackbones: ["linear", "dlinear"],
    suggestedPreprocessing: ["standard_scaling"],
    priority: "medium",
    risk: "A conservative baseline may underfit complex temporal structure.",
    testable: true,
  }
}

export function extractEvidenceSummary(dataAnalysisSummary: string): string {
  const lines = dataAnalysisSummary.split("\n").filter((l) => l.trim().length > 0)
  return lines.slice(0, 30).join("\n")
}

export function generateHypotheses(input: HypoPlannerInput): HypothesisObject[] {
  const biases = orderedBiases(input.task)
  const rules = biases
    .map((bias) => hypothesisRules.find((rule) => rule.bias === bias))
    .filter((rule): rule is HypothesisRule => rule !== undefined)

  if (rules.length === 0) return [fallbackHypothesis(input)]

  return rules.map((rule, index) => ({
    id: `H${index + 1}`,
    statement: rule.statement,
    motivation: unique([
      `Search bias "${rule.bias}" was present in the data-analysis handoff or task metadata.`,
      ...metricMotivations(rule, input.task),
      ...historyMotivations(input.runs),
      ...memoryMotivations(input.memory),
    ]),
    expectedOutcome: rule.expectedOutcome,
    suggestedBackbones: rule.suggestedBackbones,
    suggestedPreprocessing: rule.suggestedPreprocessing,
    priority: rule.priority,
    risk: rule.risk,
    testable: true,
  }))
}

function hypothesisSearchBiases(hypotheses: readonly HypothesisObject[]) {
  const pairs: readonly [string, string][] = [
    ["seasonal", "seasonal"],
    ["trend", "trend"],
    ["cross-variate", "cross_var_correlated"],
    ["missing", "missing_values"],
    ["distribution shift", "distribution_shift"],
    ["probabilistic", "probabilistic"],
    ["long-horizon", "long_horizon"],
    ["multivariate", "multivariate"],
  ]
  return hypotheses.flatMap((hypothesis) =>
    pairs
      .filter(([needle]) => hypothesis.statement.includes(needle))
      .map(([, bias]) => bias),
  )
}

function budgetNumber(task: ResearchTask, ...keys: readonly string[]) {
  const budget = recordValue(task.budget)
  for (const key of keys) {
    const value = numberValue(budget[key])
    if (value !== undefined) return value
  }
  return undefined
}

function objectiveNumber(task: ResearchTask, ...keys: readonly string[]) {
  const objective = recordValue(task.objective)
  for (const key of keys) {
    const value = numberValue(objective[key])
    if (value !== undefined) return value
  }
  return undefined
}

function isBridgeOnly(task: ResearchTask) {
  const spec = recordValue(task.taskSpec)
  const metadata = taskMetadata(task)
  const runtime = {
    ...recordValue(metadata.runtime),
    ...recordValue(spec.runtime),
  }
  return runtime.bridgeOnly === true
}

// Recipe IDs produced by buildTSFBaselines() in domains/tsf.ts. bridgeOnly tasks only ever
// emit the linear baseline; non-bridgeOnly tasks emit exactly the PatchTST/DLinear/iTransformer
// trio composed from ModelRecipe components.
export const TSF_BASELINE_RECIPE_IDS = {
  linear: "tsf_linear_raw_baseline",
  patchtst: "tsf_baseline_patchtst",
  dlinear: "tsf_baseline_dlinear",
  itransformer: "tsf_baseline_itransformer",
} as const

// The set of baseline recipe IDs HypoPlanner may pick as referenceBaseline for a given task —
// mirrors the candidates buildTSFBaselines() will emit for that task.
export function referenceBaselineOptions(task: ResearchTask): readonly string[] {
  return isBridgeOnly(task)
    ? [TSF_BASELINE_RECIPE_IDS.linear]
    : [TSF_BASELINE_RECIPE_IDS.patchtst, TSF_BASELINE_RECIPE_IDS.dlinear, TSF_BASELINE_RECIPE_IDS.itransformer]
}

// Picks one of the three ModelRecipe-composed baselines as the reference/benchmark a new
// hypothesis should be compared against, based on the dataset profile and search biases:
// strong seasonality/trend favors DLinear's decomposition, strong cross-variate correlation
// favors iTransformer's cross-attention, otherwise PatchTST is the general-purpose default.
function selectReferenceBaseline(task: ResearchTask, searchBiases: readonly string[]): string {
  if (isBridgeOnly(task)) return TSF_BASELINE_RECIPE_IDS.linear
  const profile = taskProfile(task)
  if (
    (numberValue(profile.seasonalityStrength) ?? 0) >= 0.4 ||
    searchBiases.includes("seasonal") ||
    searchBiases.includes("trend")
  ) {
    return TSF_BASELINE_RECIPE_IDS.dlinear
  }
  if ((numberValue(profile.crossVarCorrelation) ?? 0) >= 0.5 || searchBiases.includes("cross_var_correlated")) {
    return TSF_BASELINE_RECIPE_IDS.itransformer
  }
  return TSF_BASELINE_RECIPE_IDS.patchtst
}

export function buildExperimentPlan(input: {
  readonly hypotheses: readonly HypothesisObject[]
  readonly task: ResearchTask
  readonly isFirstCall?: boolean
  readonly llmReferenceBaseline?: string
}): ExperimentPlan {
  const searchBiases = unique([
    ...taskSearchBiases(input.task),
    ...hypothesisSearchBiases(input.hypotheses),
  ])
  const maxTrials = Math.max(1, Math.floor(budgetNumber(input.task, "maxTrials", "maxRuns") ?? 50))
  const noImprovementRounds = Math.max(
    1,
    Math.floor(budgetNumber(input.task, "noImprovementRounds", "maxNoImprove") ?? 20),
  )
  const targetMetricValue = objectiveNumber(input.task, "targetMetricValue", "targetMetric")
  const llmReferenceBaselineValid =
    input.llmReferenceBaseline !== undefined &&
    referenceBaselineOptions(input.task).includes(input.llmReferenceBaseline)
  const referenceBaseline = input.isFirstCall
    ? llmReferenceBaselineValid
      ? input.llmReferenceBaseline
      : selectReferenceBaseline(input.task, searchBiases)
    : undefined
  const referenceBaselineSource = input.isFirstCall ? (llmReferenceBaselineValid ? "llm" : "heuristic") : undefined
  return {
    hypotheses: input.hypotheses,
    baselineStrategy: searchBiases.includes("bridge_safe") || isBridgeOnly(input.task)
      ? "bridge_safe_baselines_first"
      : "domain_baselines_first",
    searchBiases,
    stopConditions: {
      maxTrials,
      noImprovementRounds,
      ...(targetMetricValue === undefined ? {} : { targetMetricValue }),
    },
    ...(referenceBaseline === undefined ? {} : { referenceBaseline }),
    ...(referenceBaselineSource === undefined ? {} : { referenceBaselineSource }),
  }
}

function yamlScalar(value: string | number | boolean) {
  if (typeof value === "number") return Number.isFinite(value) ? value.toString() : "null"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (/^[A-Za-z0-9_.-]+$/.test(value)) return value
  return JSON.stringify(value)
}

function yamlList(items: readonly string[], indent: string) {
  return items.length === 0 ? [`${indent}[]`] : items.map((item) => `${indent}- ${yamlScalar(item)}`)
}

export function buildHypothesesYaml(plan: ExperimentPlan): string {
  const lines = [
    `baselineStrategy: ${yamlScalar(plan.baselineStrategy)}`,
    ...(plan.referenceBaseline === undefined ? [] : [`referenceBaseline: ${yamlScalar(plan.referenceBaseline)}`]),
    ...(plan.referenceBaselineSource === undefined
      ? []
      : [`referenceBaselineSource: ${yamlScalar(plan.referenceBaselineSource)}`]),
    "searchBiases:",
    ...yamlList(plan.searchBiases, "  "),
    "stopConditions:",
    `  maxTrials: ${plan.stopConditions.maxTrials}`,
    `  noImprovementRounds: ${plan.stopConditions.noImprovementRounds}`,
  ]
  if (plan.stopConditions.targetMetricValue !== undefined) {
    lines.push(`  targetMetricValue: ${plan.stopConditions.targetMetricValue}`)
  }
  lines.push("hypotheses:")
  for (const hypothesis of plan.hypotheses) {
    lines.push(
      `  - id: ${yamlScalar(hypothesis.id)}`,
      `    statement: ${yamlScalar(hypothesis.statement)}`,
      "    motivation:",
      ...yamlList(hypothesis.motivation, "      "),
      `    expectedOutcome: ${yamlScalar(hypothesis.expectedOutcome)}`,
      "    suggestedBackbones:",
      ...yamlList(hypothesis.suggestedBackbones, "      "),
      "    suggestedPreprocessing:",
      ...yamlList(hypothesis.suggestedPreprocessing, "      "),
      `    priority: ${hypothesis.priority}`,
      `    risk: ${yamlScalar(hypothesis.risk)}`,
      `    testable: ${hypothesis.testable ? "true" : "false"}`,
    )
  }
  return `${lines.join("\n")}\n`
}

export function buildHypoPlanMarkdown(result: HypoPlannerResult): string {
  const { plan } = result
  const lines = [
    "# Hypothesis Plan",
    "",
    `- Agent: ${result.agent}`,
    `- Task ID: ${result.taskID}`,
    `- Baseline strategy: ${plan.baselineStrategy}`,
    ...(plan.referenceBaseline === undefined
      ? []
      : [
          `- Reference baseline: ${plan.referenceBaseline}${
            plan.referenceBaselineSource === undefined ? "" : ` (selected by ${plan.referenceBaselineSource})`
          }`,
        ]),
    `- Search biases: ${plan.searchBiases.length > 0 ? plan.searchBiases.join(", ") : "none"}`,
    `- Stop conditions: maxTrials=${plan.stopConditions.maxTrials}, noImprovementRounds=${plan.stopConditions.noImprovementRounds}${
      plan.stopConditions.targetMetricValue === undefined
        ? ""
        : `, targetMetricValue=${plan.stopConditions.targetMetricValue}`
    }`,
    "",
    "## Evidence Summary",
    "",
    result.evidenceSummary,
    "",
    "## Hypotheses",
    "",
  ]
  for (const hypothesis of plan.hypotheses) {
    lines.push(
      `### ${hypothesis.id}`,
      "",
      hypothesis.statement,
      "",
      `- Priority: ${hypothesis.priority}`,
      `- Testable: ${hypothesis.testable ? "yes" : "no"}`,
      `- Expected outcome: ${hypothesis.expectedOutcome}`,
      `- Suggested backbones: ${hypothesis.suggestedBackbones.join(", ")}`,
      `- Suggested preprocessing: ${hypothesis.suggestedPreprocessing.join(", ")}`,
      `- Risk: ${hypothesis.risk}`,
      "",
      "Motivation:",
      ...hypothesis.motivation.map((item) => `- ${item}`),
      "",
    )
  }
  return `${lines.join("\n")}\n`
}

export function buildHypoPlannerResult(input: HypoPlannerInput): HypoPlannerResult {
  const evidenceSummary = extractEvidenceSummary(input.dataAnalysisSummary)
  const useLLMHypotheses = input.llmHypotheses !== undefined && input.llmHypotheses.length > 0
  const hypotheses = useLLMHypotheses ? [...input.llmHypotheses!] : generateHypotheses(input)
  const isFirstCall = input.runs.length === 0 && input.memory.length === 0
  const plan = buildExperimentPlan({
    hypotheses,
    task: input.task,
    isFirstCall,
    llmReferenceBaseline: input.llmReferenceBaseline,
  })
  const partial = {
    agent: "HypoPlannerAgent" as const,
    taskID: input.task.id,
    plan,
    hypothesesYaml: buildHypothesesYaml(plan),
    evidenceSummary,
    llm: { status: useLLMHypotheses ? ("used" as const) : ("disabled" as const) },
  }
  return {
    ...partial,
    planMarkdown: buildHypoPlanMarkdown({ ...partial, planMarkdown: "" }),
  }
}

export function serializeHypothesisPlanMetadata(plan: ExperimentPlan): JsonRecord {
  return plan as unknown as JsonRecord
}
