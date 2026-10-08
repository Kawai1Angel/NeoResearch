import type { JsonRecord, ResearchMemory, ResearchRun, ResearchTask, ResearchTaskID } from "../schema"
import type { TaskEvidenceBundle, TaskEvidenceEntry, TaskEvidenceRole } from "../retrieve/contract"
import type { ModelMechanism } from "../model-capabilities"
import { NAS_DEFAULT_MAX_ITERATIONS, NAS_DEFAULT_MAX_NO_IMPROVE } from "../defaults"

export type HypothesisStatus = "pending" | "active" | "testing" | "confirmed" | "rejected" | "abandoned"

export interface HypothesisObject {
  readonly id: string
  readonly statement: string
  readonly motivation: readonly string[]
  readonly expectedOutcome: string
  readonly suggestedBackbones: readonly string[]
  readonly suggestedPreprocessing: readonly string[]
  /** Legacy metadata only; never controls experiment selection. */
  readonly priority?: "high" | "medium" | "low"
  readonly requiredMechanisms?: readonly ModelMechanism[]
  readonly risk: string
  readonly testable: boolean
  readonly datasetEvidencePaths: readonly string[]
  readonly literatureEvidence: readonly {
    readonly cardID: string
    readonly cardRevision: number
    readonly role: TaskEvidenceRole
  }[]
  readonly applicabilityAssumptions: readonly string[]
  readonly falsificationCriteria: readonly string[]
  readonly evidenceLevel: "data_only" | "paper_supported" | "conflicted"
  readonly status?: HypothesisStatus
  readonly abandonReason?: string
}

export type NextExperimentDecision =
  | { readonly action: "experiment"; readonly hypothesisID: string; readonly rationale: string }
  | { readonly action: "stop"; readonly rationale: string }

export function parseNextExperiment(value: unknown): NextExperimentDecision | undefined {
  if (!value || typeof value !== "object") return undefined
  const item = value as Record<string, unknown>
  if (typeof item.rationale !== "string" || !item.rationale.trim()) return undefined
  if (item.action === "stop") return { action: "stop", rationale: item.rationale.trim() }
  if (item.action === "experiment" && typeof item.hypothesisID === "string" && item.hypothesisID.trim())
    return { action: "experiment", hypothesisID: item.hypothesisID.trim(), rationale: item.rationale.trim() }
  return undefined
}

export function isOpenHypothesis(h: HypothesisObject) {
  return h.testable && (!h.status || ["pending", "active", "testing"].includes(h.status))
}

export interface ExperimentPlan {
  readonly nextExperiment?: NextExperimentDecision
  readonly hypotheses: readonly HypothesisObject[]
  readonly baselineStrategy: string
  readonly searchBiases: readonly string[]
  readonly stopConditions: {
    readonly maxTrials: number
    readonly noImprovementRounds: number
    readonly targetMetricValue?: number
  }
  // Explicitly picked comparison baseline. It must complete a verified full
  // evaluation before nextExperiment schedules subsequent hypotheses. Only set on
  // that first call; later calls omit it and the previously persisted value is kept.
  readonly referenceBaseline?: string
  // No reference baseline is inferred from profile thresholds or pool order.
  readonly referenceBaselineSource?: "tool" | "llm"
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
  readonly nextExperiment?: NextExperimentDecision
  // Recipe ID picked via the pick_baseline tool as the reference baseline / first candidate,
  // when buildHypoPlannerResult is invoked on the first call. Validated against
  // referenceBaselineOptions(task) before use; ignored otherwise.
  readonly toolReferenceBaseline?: string
  readonly referenceBaselineSource?: "tool" | "llm"
  readonly taskEvidence?: TaskEvidenceBundle
}

interface HypothesisRule {
  readonly bias: string
  readonly statement: string
  readonly metricKeys: readonly string[]
  readonly suggestedBackbones: readonly string[]
  readonly suggestedPreprocessing: readonly string[]
  readonly expectedOutcome: string
  readonly risk: string
  readonly evidenceConcepts: readonly string[]
}

const hypothesisRules: readonly HypothesisRule[] = [
  {
    bias: "seasonal",
    statement: "seasonal structure will benefit from decomposition-aware or frequency-aware backbones.",
    metricKeys: ["seasonalityStrength", "acfMainPeriodStrength"],
    suggestedBackbones: ["dlinear", "nbeats", "patch_transformer"],
    suggestedPreprocessing: ["seasonal_decomposition", "per_series_normalization"],
    expectedOutcome:
      "Decomposition-aware backbones should reduce cv_avg_mse compared to non-seasonal baselines by better capturing periodic patterns.",

    risk: "The detected period may be weak or unstable across the evaluation horizon.",
    evidenceConcepts: ["seasonality", "multiple_seasonalities", "seasonal_decomposition", "frequency_multiscale"],
  },
  {
    bias: "trend",
    statement: "trend structure will benefit from detrending and low-variance linear or mixer backbones.",
    metricKeys: ["trendStrength", "adfStatistic"],
    suggestedBackbones: ["dlinear", "linear", "mixer"],
    suggestedPreprocessing: ["detrend", "standard_scaling"],
    expectedOutcome:
      "Detrending preprocessing combined with linear or mixer backbones should yield stable cv_avg_mse and cv_std_mse across time folds.",

    risk: "Aggressive detrending can remove useful low-frequency signal.",
    evidenceConcepts: ["trend_dynamics", "non_stationarity", "trend_decomposition", "adaptive_normalization"],
  },
  {
    bias: "cross_var_correlated",
    statement: "cross-variate dependencies will benefit from channel-mixing backbones.",
    metricKeys: ["crossVarCorrelation"],
    suggestedBackbones: ["mixer", "patch_transformer", "tcn"],
    suggestedPreprocessing: ["channel_normalization", "correlation_screening"],
    expectedOutcome:
      "Channel-mixing backbones should outperform independent-channel baselines by leveraging inter-variate dependencies.",

    risk: "Spurious channel correlations can overfit small validation windows.",
    evidenceConcepts: [
      "cross_series_dependency",
      "lead_lag_relationship",
      "cross_variable_modeling",
      "lag_aware_fusion",
    ],
  },
  {
    bias: "missing_values",
    statement: "missing-value patterns should be handled before testing higher-capacity backbones.",
    metricKeys: ["missingRate"],
    suggestedBackbones: ["linear", "dlinear", "mixer"],
    suggestedPreprocessing: ["forward_fill", "mask_features", "robust_scaling"],
    expectedOutcome:
      "Imputation and masking should prevent training divergence, improving cv_avg_mse compared to unmasked inputs.",

    risk: "Imputation can leak future information if it is not restricted to causal context.",
    evidenceConcepts: ["incomplete_observations", "missingness_aware"],
  },
  {
    bias: "distribution_shift",
    statement: "distribution shift calls for robust preprocessing and lower-variance candidates first.",
    metricKeys: ["distributionShift", "outlierRate"],
    suggestedBackbones: ["dlinear", "mixer", "linear"],
    suggestedPreprocessing: ["robust_scaling", "rolling_normalization", "time_ordered_validation"],
    expectedOutcome:
      "Robust-scaling candidates should show smaller degradation between validation and reference-test MSE under distribution shift.",

    risk: "A short validation split may not represent the shifted test regime.",
    evidenceConcepts: [
      "non_stationarity",
      "potential_structural_break",
      "contaminated_observations",
      "robust_forecasting",
    ],
  },
  {
    bias: "probabilistic",
    statement: "probabilistic forecasting should compare calibrated distributional heads against point baselines.",
    metricKeys: [],
    suggestedBackbones: ["mixer", "patch_transformer", "tcn"],
    suggestedPreprocessing: ["quantile_targets", "calibration_check"],
    expectedOutcome:
      "Distributional heads should achieve better calibration (CRPS/quantile coverage) while not degrading point-MSE by more than 5%.",

    risk: "Distributional losses can improve calibration while worsening the primary point metric.",
    evidenceConcepts: ["probabilistic", "evaluation_protocol"],
  },
  {
    bias: "long_horizon",
    statement: "long-horizon forecasting should prefer stable low-frequency and patch-based candidates.",
    metricKeys: ["horizonContextRatio"],
    suggestedBackbones: ["dlinear", "patch_transformer", "nbeats"],
    suggestedPreprocessing: ["multi_horizon_validation", "context_window_ablation"],
    expectedOutcome:
      "Patch-based and low-frequency candidates should maintain lower MSE at horizon 336 and 720 compared to step-by-step recurrent alternatives.",

    risk: "Long horizons can hide short-term errors behind averaged metrics.",
    evidenceConcepts: ["long_horizon_dependency", "efficient_long_range"],
  },
  {
    bias: "multivariate",
    statement: "multivariate targets should verify whether channel mixing improves over independent baselines.",
    metricKeys: ["targetCount"],
    suggestedBackbones: ["mixer", "patch_transformer", "linear"],
    suggestedPreprocessing: ["per_channel_scaling", "target_correlation_audit"],
    expectedOutcome:
      "Channel-mixing variants should improve cv_avg_mse over per-channel baselines when cross-channel correlation is confirmed.",

    risk: "Extra channel capacity may add noise when targets are weakly related.",
    evidenceConcepts: [
      "cross_series_dependency",
      "cross_variable_modeling",
      "covariate_conditioning",
      "covariate_fusion",
    ],
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
  if (
    (numberValue(profile.seasonalityStrength) ?? 0) >= 0.35 ||
    ((numberValue(profile.acfMainPeriod) ?? 0) >= 3 && (numberValue(profile.seasonalityStrength) ?? 0) >= 0.2)
  )
    biases.push("seasonal")
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
  return unique([...known.filter((bias) => source.includes(bias)), ...source.filter((bias) => !known.includes(bias))])
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
    expectedOutcome:
      "cv_avg_mse should decrease below the naive baseline, providing a reliable reference point for subsequent search.",
    suggestedBackbones: ["linear", "dlinear"],
    suggestedPreprocessing: ["standard_scaling"],

    risk: "A conservative baseline may underfit complex temporal structure.",
    testable: true,
    datasetEvidencePaths: [],
    literatureEvidence: [],
    applicabilityAssumptions: [],
    falsificationCriteria: [
      "Reject the baseline-control hypothesis if it cannot complete the configured time-ordered evaluation protocol.",
    ],
    evidenceLevel: "data_only",
  }
}

function entrySupportsRule(entry: TaskEvidenceEntry, rule: HypothesisRule) {
  const concepts = new Set([...entry.linkage.conceptIDs, ...entry.linkage.methodConceptIDs])
  return rule.evidenceConcepts.some((concept) => concepts.has(concept))
}

function evidenceForRule(rule: HypothesisRule, taskEvidence?: TaskEvidenceBundle) {
  if (!taskEvidence) return []
  return taskEvidence.entries
    .filter((entry) => entrySupportsRule(entry, rule))
    .toSorted((left, right) => right.relevance.score - left.relevance.score || left.cardID.localeCompare(right.cardID))
}

function literatureReference(entry: TaskEvidenceEntry) {
  const role = entry.roles.includes("contradicts")
    ? "contradicts"
    : entry.roles.includes("warns_limitation")
      ? "warns_limitation"
      : entry.roles[0]!
  return { cardID: entry.cardID, cardRevision: entry.cardRevision, role }
}

function applicabilityAssumptions(entries: readonly TaskEvidenceEntry[]) {
  return unique(
    entries.flatMap((entry) => [
      ...(entry.applicability.status === "unknown"
        ? [`${entry.cardID} has unspecified applicability; transfer to this dataset must be validated.`]
        : []),
      ...entry.applicability.matchedConditions.map((condition) => `${entry.cardID} applies when ${condition}.`),
      ...entry.applicability.uncertainConditions.map(
        (condition) => `${entry.cardID} requires validation because ${condition} is uncertain.`,
      ),
      ...entry.applicability.violatedConditions.map(
        (condition) => `${entry.cardID} may not transfer because ${condition}.`,
      ),
    ]),
  )
}

function ruleFalsificationCriteria(rule: HypothesisRule) {
  return [
    `Reject this hypothesis if the proposed intervention does not improve the task primary metric over its stated baseline under time-ordered validation (${rule.bias}).`,
  ]
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

  return rules.map((rule, index) => {
    const entries = evidenceForRule(rule, input.taskEvidence)
    const conflicted = entries.some(
      (entry) => entry.applicability.status === "conflicted" || entry.roles.includes("contradicts"),
    )
    const limitations = unique(entries.flatMap((entry) => entry.limitations))
    return {
      id: `H${index + 1}`,
      statement: rule.statement,
      motivation: unique([
        `Search bias "${rule.bias}" was present in the data-analysis handoff or task metadata.`,
        ...metricMotivations(rule, input.task),
        ...entries.map((entry) => `Literature evidence ${entry.cardID}@${entry.cardRevision}: ${entry.claim}`),
        ...historyMotivations(input.runs),
        ...memoryMotivations(input.memory),
      ]),
      expectedOutcome: rule.expectedOutcome,
      suggestedBackbones: rule.suggestedBackbones,
      suggestedPreprocessing: rule.suggestedPreprocessing,
      risk: [
        rule.risk,
        ...limitations,
        ...(conflicted ? ["The task evidence bundle contains applicability or literature conflicts."] : []),
      ].join(" "),
      testable: true,
      datasetEvidencePaths: unique(entries.flatMap((entry) => entry.linkage.datasetEvidencePaths)),
      literatureEvidence: entries.map(literatureReference),
      applicabilityAssumptions: applicabilityAssumptions(entries),
      falsificationCriteria: ruleFalsificationCriteria(rule),
      evidenceLevel:
        entries.length === 0
          ? ("data_only" as const)
          : conflicted
            ? ("conflicted" as const)
            : ("paper_supported" as const),
    }
  })
}

export function validateHypothesisEvidence(
  hypotheses: readonly HypothesisObject[],
  taskEvidence?: TaskEvidenceBundle,
): void {
  const entries = new Map((taskEvidence?.entries ?? []).map((entry) => [entry.cardID, entry]))
  const errors: string[] = []
  for (const hypothesis of hypotheses) {
    if (
      !hypothesis.falsificationCriteria.some((item) => item.trim().length > 0) &&
      !/baseline[ -]?control/i.test(hypothesis.statement)
    ) {
      errors.push(`${hypothesis.id}: at least one falsification criterion is required`)
    }
    if (hypothesis.evidenceLevel === "data_only" && hypothesis.literatureEvidence.length > 0) {
      errors.push(`${hypothesis.id}: data_only hypotheses cannot cite literature evidence`)
    }
    if (hypothesis.evidenceLevel === "paper_supported" && hypothesis.literatureEvidence.length === 0) {
      errors.push(`${hypothesis.id}: paper_supported hypotheses must cite task evidence`)
    }
    if (
      hypothesis.literatureEvidence.length > 0 &&
      (hypothesis.applicabilityAssumptions.every((item) => item.trim().length === 0) ||
        hypothesis.datasetEvidencePaths.length === 0)
    ) {
      errors.push(`${hypothesis.id}: literature evidence requires dataset paths and applicability assumptions`)
    }
    if (hypothesis.evidenceLevel === "conflicted" && hypothesis.literatureEvidence.length === 0) {
      errors.push(`${hypothesis.id}: conflicted hypotheses must cite the relevant evidence`)
    }
    const linkedPaths = new Set<string>()
    let citesConflict = false
    for (const reference of hypothesis.literatureEvidence) {
      const entry = entries.get(reference.cardID)
      if (!entry) {
        errors.push(`${hypothesis.id}: unknown task-evidence card ${reference.cardID}`)
        continue
      }
      if (entry.cardRevision !== reference.cardRevision) {
        errors.push(`${hypothesis.id}: revision mismatch for ${reference.cardID}`)
      }
      if (!entry.roles.includes(reference.role)) {
        errors.push(`${hypothesis.id}: role ${reference.role} is not allowed for ${reference.cardID}`)
      }
      if (
        (entry.applicability.status === "conflicted" ||
          entry.cardStatus === "contradicted" ||
          entry.roles.includes("contradicts")) &&
        reference.role !== "warns_limitation" &&
        reference.role !== "contradicts"
      ) {
        errors.push(
          `${hypothesis.id}: conflicted card ${reference.cardID} cannot be used as unconditional positive evidence`,
        )
      }
      if (entry.roles.includes("contradicts") || entry.applicability.status === "conflicted") citesConflict = true
      for (const evidencePath of entry.linkage.datasetEvidencePaths) linkedPaths.add(evidencePath)
    }
    if (hypothesis.literatureEvidence.length > 0) {
      for (const evidencePath of hypothesis.datasetEvidencePaths) {
        if (!linkedPaths.has(evidencePath))
          errors.push(`${hypothesis.id}: dataset evidence path is outside cited entries: ${evidencePath}`)
      }
    }
    if (hypothesis.evidenceLevel === "conflicted" && !citesConflict) {
      errors.push(`${hypothesis.id}: conflicted evidenceLevel does not cite a conflicted entry`)
    }
    if (hypothesis.evidenceLevel === "paper_supported" && citesConflict) {
      errors.push(`${hypothesis.id}: conflicted evidence cannot be labeled paper_supported`)
    }
  }
  if (errors.length > 0) throw new Error(`Invalid hypothesis evidence:\n${errors.join("\n")}`)
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
    pairs.filter(([needle]) => hypothesis.statement.includes(needle)).map(([, bias]) => bias),
  )
}

function loopBudgetNumber(task: ResearchTask, ...keys: readonly string[]) {
  const budget = recordValue(task.budget)
  const loop = recordValue(budget.loop ?? budget.researchLoop ?? budget.autonomousLoop)
  for (const key of keys) {
    const value = numberValue(loop[key] ?? budget[key])
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

export function buildExperimentPlan(input: {
  readonly hypotheses: readonly HypothesisObject[]
  readonly task: ResearchTask
  readonly isFirstCall?: boolean
  readonly toolReferenceBaseline?: string
  readonly referenceBaselineSource?: "tool" | "llm"
  readonly nextExperiment?: NextExperimentDecision
}): ExperimentPlan {
  const searchBiases = unique([...taskSearchBiases(input.task), ...hypothesisSearchBiases(input.hypotheses)])
  const maxTrials = Math.max(
    1,
    Math.floor(loopBudgetNumber(input.task, "maxIterations", "maxTrials") ?? NAS_DEFAULT_MAX_ITERATIONS),
  )
  const noImprovementRounds = Math.max(
    1,
    Math.floor(
      loopBudgetNumber(input.task, "maxNoImprove", "maxNoImproveRounds", "noImprovementRounds") ??
        NAS_DEFAULT_MAX_NO_IMPROVE,
    ),
  )
  const targetMetricValue = objectiveNumber(input.task, "targetMetricValue", "targetMetric")
  const toolReferenceBaselineValid =
    input.toolReferenceBaseline !== undefined &&
    referenceBaselineOptions(input.task).includes(input.toolReferenceBaseline)
  const referenceBaseline = input.isFirstCall && toolReferenceBaselineValid ? input.toolReferenceBaseline : undefined
  const referenceBaselineSource = referenceBaseline === undefined ? undefined : (input.referenceBaselineSource ?? "tool")
  return {
    hypotheses: input.hypotheses,
    ...(input.nextExperiment ? { nextExperiment: input.nextExperiment } : {}),
    baselineStrategy: "planner_selected_experiments",
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

export function buildHypothesesYaml(
  plan: ExperimentPlan,
  readiness: TaskEvidenceBundle["readiness"] = "ready_data_only",
): string {
  const lines = [
    `literatureReadiness: ${readiness}`,
    `baselineStrategy: ${yamlScalar(plan.baselineStrategy)}`,
    ...(plan.referenceBaseline === undefined ? [] : [`referenceBaseline: ${yamlScalar(plan.referenceBaseline)}`]),
    ...(plan.referenceBaselineSource === undefined
      ? []
      : [`referenceBaselineSource: ${yamlScalar(plan.referenceBaselineSource)}`]),
    "searchBiases:",
    ...yamlList(plan.searchBiases, "  "),
    ...(plan.nextExperiment
      ? [
          "nextExperiment:",
          `  action: ${plan.nextExperiment.action}`,
          ...(plan.nextExperiment.action === "experiment"
            ? [`  hypothesisID: ${yamlScalar(plan.nextExperiment.hypothesisID)}`]
            : []),
          `  rationale: ${yamlScalar(plan.nextExperiment.rationale)}`,
        ]
      : []),
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
      "    requiredMechanisms:",
      ...yamlList(hypothesis.requiredMechanisms ?? [], "      "),
      `    risk: ${yamlScalar(hypothesis.risk)}`,
      `    testable: ${hypothesis.testable ? "true" : "false"}`,
      `    evidenceLevel: ${hypothesis.evidenceLevel}`,
      "    datasetEvidencePaths:",
      ...yamlList(hypothesis.datasetEvidencePaths, "      "),
      "    literatureEvidence:",
      ...(hypothesis.literatureEvidence.length === 0
        ? ["      []"]
        : hypothesis.literatureEvidence.flatMap((reference) => [
            `      - cardID: ${yamlScalar(reference.cardID)}`,
            `        cardRevision: ${reference.cardRevision}`,
            `        role: ${reference.role}`,
          ])),
      "    applicabilityAssumptions:",
      ...yamlList(hypothesis.applicabilityAssumptions, "      "),
      "    falsificationCriteria:",
      ...yamlList(hypothesis.falsificationCriteria, "      "),
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
    ...(plan.nextExperiment ? [`- Next experiment decision: ${JSON.stringify(plan.nextExperiment)}`] : []),
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
      `- Required mechanisms: ${(hypothesis.requiredMechanisms ?? []).join(", ") || "none"}`,
      `- Testable: ${hypothesis.testable ? "yes" : "no"}`,
      `- Expected outcome: ${hypothesis.expectedOutcome}`,
      `- Suggested backbones: ${hypothesis.suggestedBackbones.join(", ")}`,
      `- Suggested preprocessing: ${hypothesis.suggestedPreprocessing.join(", ")}`,
      `- Risk: ${hypothesis.risk}`,
      `- Evidence level: ${hypothesis.evidenceLevel}`,
      `- Dataset evidence: ${hypothesis.datasetEvidencePaths.join(", ") || "none"}`,
      `- Literature evidence: ${hypothesis.literatureEvidence.map((item) => `${item.cardID}@${item.cardRevision} (${item.role})`).join(", ") || "none"}`,
      "",
      "Motivation:",
      ...hypothesis.motivation.map((item) => `- ${item}`),
      "",
      "Applicability assumptions:",
      ...(hypothesis.applicabilityAssumptions.length === 0
        ? ["- none"]
        : hypothesis.applicabilityAssumptions.map((item) => `- ${item}`)),
      "",
      "Falsification criteria:",
      ...hypothesis.falsificationCriteria.map((item) => `- ${item}`),
      "",
    )
  }
  return `${lines.join("\n")}\n`
}

export function buildHypoPlannerResult(input: HypoPlannerInput): HypoPlannerResult {
  const evidenceSummary = [
    extractEvidenceSummary(input.dataAnalysisSummary),
    input.taskEvidence
      ? `Literature readiness: ${input.taskEvidence.readiness}; selected=${input.taskEvidence.summary.selectedEntryCount}; gaps=${input.taskEvidence.gaps.length}; conflicts=${input.taskEvidence.conflicts.length}.`
      : "Literature readiness: ready_data_only; no task evidence bundle was supplied.",
  ]
    .filter(Boolean)
    .join("\n")
  let useLLMHypotheses =
    input.llmHypotheses !== undefined && (input.llmHypotheses.length > 0 || input.nextExperiment?.action === "stop")
  let hypotheses = useLLMHypotheses ? [...input.llmHypotheses!] : generateHypotheses(input)
  if (useLLMHypotheses) {
    try {
      validateHypothesisEvidence(hypotheses, input.taskEvidence)
    } catch {
      useLLMHypotheses = false
      hypotheses = generateHypotheses(input)
    }
  }
  validateHypothesisEvidence(hypotheses, input.taskEvidence)
  const isFirstCall = !input.runs.some((run) => run.candidateID)
  const plan = buildExperimentPlan({
    hypotheses,
    task: input.task,
    isFirstCall,
    toolReferenceBaseline: input.toolReferenceBaseline,
    referenceBaselineSource: input.referenceBaselineSource,
    nextExperiment: input.nextExperiment,
  })
  const partial = {
    agent: "HypoPlannerAgent" as const,
    taskID: input.task.id,
    plan,
    hypothesesYaml: buildHypothesesYaml(plan, input.taskEvidence?.readiness),
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
