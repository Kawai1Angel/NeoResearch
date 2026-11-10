import type { JsonRecord, ResearchTask, ResearchTaskID } from "../schema"
import { extractJsonObject, requestNeoCastLLM, resolveEffectiveLLMConfig } from "../llm-proposal"
import { NAS_DEFAULT_MAX_ITERATIONS, NAS_DEFAULT_MAX_NO_IMPROVE } from "../defaults"

export type IntentInteractionMode = "socratic" | "companion"

export type IntentLLMStatus = "disabled" | "not_configured" | "used" | "failed"

export interface IntentDialogueStrategy {
  readonly mode: IntentInteractionMode
  readonly confidenceThreshold: number
  readonly maxQuestionsPerTurn: number
  readonly questionDepth: "front_loaded_deep" | "compact_checkpointed"
  readonly humanCheckpointPhases: string[]
}

export interface IntentSpec {
  readonly interaction_mode: IntentInteractionMode
  readonly task_title: string
  readonly domain_id: string
  readonly forecast_object?: string
  readonly data_source?: string
  readonly data_split_method: "ratio" | "row_ranges"
  readonly data_split_ratios?: number[]
  readonly data_split_row_ranges?: {
    readonly train: number[]
    readonly validation: number[]
    readonly test: number[]
  }
  readonly target_columns: string[]
  readonly lookback_window?: number
  readonly prediction_horizon: number[]
  readonly time_grain?: string
  readonly exogenous_variables?: string[]
  readonly future_covariate_availability?: string
  readonly business_context?: string
  readonly primary_metric?: string
  readonly secondary_metrics: string[]
  readonly error_preferences?: string
  readonly latency_budget?: unknown
  readonly parameter_budget?: unknown
  readonly max_iterations?: number
  readonly max_no_improve?: number
  readonly interpretability?: string
  readonly deployment_target?: string
  readonly open_questions: string[]
}

export interface IntentAgentResult {
  readonly agent: "IntentAgent"
  readonly taskID: ResearchTaskID
  readonly confidence: number
  readonly missingFields: string[]
  readonly clarifyingQuestions: string[]
  readonly normalizedGoal: JsonRecord
  readonly taskSpec: JsonRecord
  readonly intentSpec: IntentSpec
  readonly intentSpecMarkdown: string
  readonly dialogueStrategy: IntentDialogueStrategy
  readonly llm: {
    readonly status: IntentLLMStatus
    readonly provider?: string
    readonly model?: string
    readonly error?: string
  }
}

export const INTENT_SLOT_IDS = [
  "interaction_mode", "forecast_object", "data_source", "data_split_method", "data_split_ratios",
  "data_split_row_ranges", "target_columns", "lookback_window",
  "prediction_horizon", "time_grain", "exogenous_variables", "future_covariate_availability",
  "business_context", "primary_metric", "secondary_metrics", "error_preferences", "latency_budget",
  "parameter_budget", "max_iterations", "max_no_improve", "interpretability", "deployment_target",
] as const
export type SlotID = typeof INTENT_SLOT_IDS[number]

export type IntentSlot = {
  readonly id: SlotID
  readonly field: string
  readonly label: string
  readonly required: boolean
  readonly emptyArrayIsMissing?: boolean
  readonly socraticQuestion: string
  readonly companionQuestion: string
  readonly value: unknown
}

const companionCheckpointPhases = [
  "data_analysis_done",
  "search_space_confirmed",
  "experiment_budget_extended",
  "final_model_selection",
  "report_release",
]

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function stringValue(value: unknown) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

function optionalStringArray(value: unknown) {
  return Array.isArray(value) ? stringArray(value) : undefined
}

function numberArray(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
}

function splitRatios(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined
  const ratios = value.filter((item): item is number => typeof item === "number" && Number.isFinite(item) && item > 0)
  return ratios.length === 3 ? ratios : undefined
}

function splitRowRanges(value: unknown) {
  const ranges = recordValue(value)
  const train = numberArray(firstKnown(ranges.train, ranges.trainRows, ranges.train_rows))
  const validation = numberArray(firstKnown(ranges.validation, ranges.val, ranges.validationRows, ranges.val_rows))
  const test = numberArray(firstKnown(ranges.test, ranges.ref_test, ranges.testRows, ranges.ref_test_rows))
  if (train.length !== 2 || validation.length !== 2 || test.length !== 2) return undefined
  return { train, validation, test }
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    const known = stringValue(value)
    if (known !== undefined) return known
  }
  return undefined
}

function firstNumber(...values: unknown[]) {
  for (const value of values) {
    const known = numberValue(value)
    if (known !== undefined) return known
  }
  return undefined
}

function firstKnown(...values: unknown[]) {
  for (const value of values) {
    if (value !== undefined && value !== null && !(typeof value === "string" && value.trim().length === 0)) return value
  }
  return undefined
}

export function interactionModeForTask(task: ResearchTask): IntentInteractionMode {
  const taskSpec = recordValue(task.taskSpec)
  const metadata = recordValue(taskSpec.metadata)
  const raw = metadata.interactionMode ?? metadata.interaction_mode
  if (raw === "companion" || raw === "cognitive_companion") return "companion"
  if (raw === "socratic") return "socratic"
  return task.mode === "review" ? "companion" : "socratic"
}

export function dialogueStrategy(mode: IntentInteractionMode): IntentDialogueStrategy {
  if (mode === "companion") {
    return {
      mode,
      confidenceThreshold: 0.78,
      maxQuestionsPerTurn: 3,
      questionDepth: "compact_checkpointed",
      humanCheckpointPhases: companionCheckpointPhases,
    }
  }
  return {
    mode,
    confidenceThreshold: 0.86,
    maxQuestionsPerTurn: 1,
    questionDepth: "front_loaded_deep",
    humanCheckpointPhases: [],
  }
}

export function collectedIntentSlots(task: ResearchTask) {
  const taskSpec = recordValue(task.taskSpec)
  const dataset = recordValue(taskSpec.dataset)
  const datasetSplit = recordValue(dataset.split)
  const objective = recordValue(task.objective)
  const budget = recordValue(task.budget)
  const loopBudget = recordValue(budget.loop ?? budget.researchLoop ?? budget.autonomousLoop)
  const runtime = recordValue(taskSpec.runtime)
  const metadata = recordValue(taskSpec.metadata)
  const constraints = recordValue(taskSpec.constraints)
  const intent = recordValue(taskSpec.intent)
  const intentSlots = recordValue(intent.slots)
  const metaIntentSlots = recordValue(metadata.intentSlots)
  const mergedSlots = { ...intentSlots, ...metaIntentSlots }
  const interactionMode = interactionModeForTask(task)
  const targetColumns = (() => {
    const raw = firstKnown(dataset.targetCols, mergedSlots.target_columns)
    if (Array.isArray(raw)) return stringArray(raw)
    if (typeof raw === "string" && raw.trim().length > 0)
      return raw.trim().split(/\s*,\s*/).filter((s) => s.length > 0)
    return []
  })()
  const exogenousVariables = firstKnown(
    mergedSlots.exogenous_variables,
    dataset.exogenousCols,
    dataset.exogenousVariables,
    dataset.observedPastCovariates,
    dataset.knownFutureCovariates,
    dataset.staticCovariates,
    taskSpec.exogenousVariables,
    taskSpec.exogenous_variables,
  )
  const primaryMetric = firstString(objective.primaryMetric, objective.primary_metric, mergedSlots.primary_metric)
  const splitMethodRaw = firstString(datasetSplit.method, mergedSlots.data_split_method)
  const splitMethod = splitMethodRaw === "row_ranges" ? "row_ranges" : "ratio"

  return {
    interaction_mode: interactionMode,
    forecast_object: firstString(
      mergedSlots.forecast_object,
      taskSpec.forecastObject,
      taskSpec.predictionObject,
      metadata.forecastObject,
      targetColumns.length > 0 ? `${targetColumns.join(", ")} time series` : undefined,
    ),
    data_source: firstString(mergedSlots.data_source, dataset.path, dataset.source),
    data_split_method: splitMethod,
    data_split_ratios:
      splitRatios(firstKnown(datasetSplit.ratios, mergedSlots.data_split_ratios)) ?? [7, 1, 2],
    data_split_row_ranges: splitRowRanges(
      firstKnown(
        datasetSplit.method === "row_ranges"
          ? {
              train: datasetSplit.trainRows,
              validation: datasetSplit.validationRows,
              test: datasetSplit.testRows,
            }
          : undefined,
        mergedSlots.data_split_row_ranges,
      ),
    ),
    target_columns: targetColumns,
    lookback_window: firstNumber(
      mergedSlots.lookback_window,
      taskSpec.contextLength,
      taskSpec.lookbackWindow,
      taskSpec.lookback,
      taskSpec.inputLength,
    ),
    prediction_horizon: numberArray(firstKnown(taskSpec.predictionLengths, taskSpec.predictionHorizon, mergedSlots.prediction_horizon)),
    time_grain: firstString(mergedSlots.time_grain, taskSpec.timeGrain, taskSpec.frequency, metadata.timeGrain, dataset.frequency),
    exogenous_variables: optionalStringArray(exogenousVariables),
    future_covariate_availability: firstString(
      mergedSlots.future_covariate_availability,
      metadata.futureCovariateAvailability,
    ),
    business_context: firstString(
      mergedSlots.business_context,
      taskSpec.businessContext,
      taskSpec.business_context,
      objective.businessContext,
      metadata.businessContext,
      metadata.userPrompt,
    ),
    primary_metric: primaryMetric,
    secondary_metrics: stringArray(firstKnown(objective.secondaryMetrics, objective.secondary_metrics, mergedSlots.secondary_metrics)),
    error_preferences: firstString(
      mergedSlots.error_preferences,
      objective.errorPreferences,
      objective.errorPreference,
      objective.lossPreference,
    ),
    latency_budget: firstKnown(
      mergedSlots.latency_budget,
      budget.latencyBudget,
      budget.maxLatencyMs,
      budget.latencyMs,
      constraints.latencyBudget,
      constraints.maxLatencyMs,
    ),
    parameter_budget: firstKnown(
      mergedSlots.parameter_budget,
      budget.parameterBudget,
      budget.maxParameters,
      budget.maxParams,
      constraints.parameterBudget,
      constraints.maxParameters,
      constraints.maxParams,
    ),
    max_iterations:
      firstNumber(mergedSlots.max_iterations, loopBudget.maxIterations) ?? NAS_DEFAULT_MAX_ITERATIONS,
    max_no_improve:
      firstNumber(mergedSlots.max_no_improve, loopBudget.maxNoImprove, loopBudget.maxNoImproveRounds) ??
      NAS_DEFAULT_MAX_NO_IMPROVE,
    interpretability: firstString(
      mergedSlots.interpretability,
      taskSpec.interpretability,
      objective.interpretability,
      metadata.interpretability,
    ),
    deployment_target: firstString(
      mergedSlots.deployment_target,
      taskSpec.deploymentTarget,
      runtime.deploymentTarget,
      budget.deploymentTarget,
      metadata.deploymentTarget,
    ),
  }
}

export function slotDefinitions(task: ResearchTask): IntentSlot[] {
  const slots = collectedIntentSlots(task)
  return [
    {
      id: "interaction_mode",
      field: "intent.interaction_mode",
      label: "Interaction mode",
      required: true,
      socraticQuestion: "Should this task use Socratic mode: clarify requirements thoroughly first, then run autonomously?",
      companionQuestion: "Should this task use Companion mode and wait for your confirmation at key stages?",
      value: slots.interaction_mode,
    },
    {
      id: "forecast_object",
      field: "intent.forecast_object",
      label: "Forecast object",
      required: true,
      socraticQuestion: "What exactly are you forecasting? Describe the business entity and the phenomenon to predict.",
      companionQuestion: "What are you forecasting? Describe the business entity in one sentence.",
      value: slots.forecast_object,
    },
    {
      id: "data_source",
      field: "dataset.path",
      label: "Data source",
      required: true,
      socraticQuestion: "Which CSV dataset path should NeoResearch use for profiling and execution?",
      companionQuestion: "What is the CSV dataset path?",
      value: slots.data_source,
    },
    {
      id: "data_split_method",
      field: "dataset.split.method",
      label: "Dataset split method",
      required: true,
      socraticQuestion: "Should the dataset use split ratios or explicit row ranges? The default train/validation/test ratio is 7:1:2.",
      companionQuestion: "Use split ratios or explicit row ranges? The default is 7:1:2.",
      value: slots.data_split_method,
    },
    {
      id: "data_split_ratios",
      field: "dataset.split.ratios",
      label: "Train/validation/test ratio",
      required: slots.data_split_method === "ratio",
      emptyArrayIsMissing: true,
      socraticQuestion: "What train/validation/test ratio should be used? Provide three positive numbers, such as 7:1:2.",
      companionQuestion: "What is the train/validation/test ratio? For example, 7:1:2.",
      value: slots.data_split_ratios,
    },
    {
      id: "data_split_row_ranges",
      field: "dataset.split.rowRanges",
      label: "Train/validation/test row ranges",
      required: slots.data_split_method === "row_ranges",
      socraticQuestion: "Provide contiguous half-open row ranges for training, validation, and testing, for example train=[0,7000), validation=[7000,8000), test=[8000,10000).",
      companionQuestion: "What are the contiguous train/validation/test row ranges? For example, 0:7000, 7000:8000, 8000:10000.",
      value: slots.data_split_row_ranges,
    },
    {
      id: "target_columns",
      field: "dataset.targetCols",
      label: "Target columns",
      required: true,
      emptyArrayIsMissing: true,
      socraticQuestion: "Which target columns should be forecast?",
      companionQuestion: "What are the target columns?",
      value: slots.target_columns,
    },
    {
      id: "lookback_window",
      field: "contextLength",
      label: "lookback window",
      required: true,
      socraticQuestion: "How long should the model's lookback window be?",
      companionQuestion: "How many steps should the initial lookback window use?",
      value: slots.lookback_window,
    },
    {
      id: "prediction_horizon",
      field: "predictionLengths",
      label: "Forecast horizons",
      required: true,
      emptyArrayIsMissing: true,
      socraticQuestion: "Which forecast horizons should be evaluated?",
      companionQuestion: "What is the list of forecast horizons?",
      value: slots.prediction_horizon,
    },
    {
      id: "time_grain",
      field: "metadata.timeGrain",
      label: "Sampling interval",
      required: false,
      socraticQuestion: "What is the dataset's sampling interval?",
      companionQuestion: "What is the sampling interval?",
      value: slots.time_grain,
    },
    {
      id: "exogenous_variables",
      field: "intent.exogenous_variables",
      label: "Exogenous variables",
      required: true,
      socraticQuestion: "Are there exogenous variables such as weather, holidays, prices, or events? If there are none, explicitly answer none.",
      companionQuestion: "What are the exogenous variables? Answer none if there are none.",
      value: slots.exogenous_variables,
    },
    {
      id: "future_covariate_availability",
      field: "metadata.futureCovariateAvailability",
      label: "Future exogenous availability",
      required: task.domainID !== "tsf" && (slots.exogenous_variables ?? []).length > 0,
      socraticQuestion: "Will future values of these exogenous variables be available at prediction time? Specify their source; label offline ground truth as oracle upper-bound.",
      companionQuestion: "Will future exogenous values be available at prediction time? Specify their source or label them oracle upper-bound.",
      value: slots.future_covariate_availability,
    },
    {
      id: "business_context",
      field: "intent.business_context",
      label: "Business context",
      required: true,
      socraticQuestion: "Which business decision or research judgment will this forecast support?",
      companionQuestion: "What business scenario does this forecast support?",
      value: slots.business_context,
    },
    {
      id: "primary_metric",
      field: "objective.primaryMetric",
      label: "Primary metric",
      required: true,
      socraticQuestion: "Which validation metric should model search optimize?",
      companionQuestion: "What is the primary optimization metric?",
      value: slots.primary_metric,
    },
    {
      id: "secondary_metrics",
      field: "objective.secondaryMetrics",
      label: "Secondary metrics",
      required: false,
      socraticQuestion: "Which secondary metrics or trade-offs across horizons matter alongside the primary metric?",
      companionQuestion: "Which secondary metrics should be monitored?",
      value: slots.secondary_metrics,
    },
    {
      id: "error_preferences",
      field: "objective.error_preferences",
      label: "Error preferences",
      required: true,
      socraticQuestion: "Which errors matter most: short-term, long-term, peak, average error, or stability?",
      companionQuestion: "Do error preferences prioritize short-term, long-term, peak, or average performance?",
      value: slots.error_preferences,
    },
    {
      id: "latency_budget",
      field: "budget.latency_budget",
      label: "Latency budget",
      required: true,
      socraticQuestion: "Is there a deployment or inference latency budget, such as per-request latency, a batch window, or no hard constraint?",
      companionQuestion: "What is the inference latency budget? State explicitly if there is no hard constraint.",
      value: slots.latency_budget,
    },
    {
      id: "parameter_budget",
      field: "budget.parameter_budget",
      label: "Parameter budget",
      required: true,
      socraticQuestion: "What limits apply to model parameters or resource usage?",
      companionQuestion: "What are the parameter or resource budget limits?",
      value: slots.parameter_budget,
    },
    {
      id: "max_iterations",
      field: "budget.loop.maxIterations",
      label: "Planned NAS iterations",
      required: false,
      socraticQuestion: "How many NAS iterations are planned? Confirm the default of 25 or provide a new limit. The system safety cap applies independently.",
      companionQuestion: "How many NAS iterations are planned? Confirm or change the default of 25.",
      value: slots.max_iterations,
    },
    {
      id: "max_no_improve",
      field: "budget.loop.maxNoImprove",
      label: "Iterations without improvement",
      required: false,
      socraticQuestion: "After how many consecutive NAS iterations without improvement should search stop early? Confirm or change the default of 7.",
      companionQuestion: "After how many consecutive iterations without improvement should search stop? Confirm or change the default of 7.",
      value: slots.max_no_improve,
    },
    {
      id: "interpretability",
      field: "intent.interpretability",
      label: "Interpretability",
      required: true,
      socraticQuestion: "Do you need interpretability, ablation explanations, or a preference for simple models?",
      companionQuestion: "What are the interpretability requirements?",
      value: slots.interpretability,
    },
    {
      id: "deployment_target",
      field: "runtime.deployment_target",
      label: "Deployment target",
      required: true,
      socraticQuestion: "Where will the final model be deployed: local CPU, a GPU service, an edge device, offline batch processing, or a research report only?",
      companionQuestion: "What is the deployment target?",
      value: slots.deployment_target,
    },
  ]
}

export function slotIsMissing(slot: IntentSlot) {
  if (!slot.required) return false
  if (slot.value === undefined || slot.value === null) return true
  if (typeof slot.value === "string") return slot.value.trim().length === 0
  if (Array.isArray(slot.value)) return slot.emptyArrayIsMissing === true && slot.value.length === 0
  return false
}

function questionForSlot(slot: IntentSlot, mode: IntentInteractionMode) {
  return mode === "companion" ? slot.companionQuestion : slot.socraticQuestion
}

export function confidenceFor(slots: IntentSlot[], strategy: IntentDialogueStrategy) {
  const required = slots.filter((slot) => slot.required)
  const filled = required.filter((slot) => !slotIsMissing(slot)).length
  const coverage = required.length === 0 ? 1 : filled / required.length
  const optional = slots.filter((slot) => !slot.required)
  const optionalFilled = optional.filter((slot) => {
    if (slot.value === undefined || slot.value === null) return false
    if (Array.isArray(slot.value)) return slot.value.length > 0
    if (typeof slot.value === "string") return slot.value.trim().length > 0
    return true
  }).length
  const optionalBonus = optional.length === 0 ? 0 : (optionalFilled / optional.length) * 0.04
  const depthBonus = strategy.mode === "socratic" ? 0.02 : 0
  return Number(Math.max(0.25, Math.min(0.97, 0.2 + coverage * 0.72 + optionalBonus + depthBonus)).toFixed(2))
}

function intentSpecFrom(task: ResearchTask, missingSlots: IntentSlot[], llmSlots: Record<string, unknown> = {}): IntentSpec {
  const slots = collectedIntentSlots(task)
  const merged = {
    ...slots,
    ...normalizeLLMSlots(llmSlots),
  }
  const dataSplitMethod = merged.data_split_method === "row_ranges" ? "row_ranges" : "ratio"
  const openQuestions = missingSlots.map((slot) => questionForSlot(slot, merged.interaction_mode))
  return {
    interaction_mode: merged.interaction_mode,
    task_title: task.title,
    domain_id: task.domainID,
    ...(merged.forecast_object === undefined ? {} : { forecast_object: merged.forecast_object }),
    ...(merged.data_source === undefined ? {} : { data_source: merged.data_source }),
    data_split_method: dataSplitMethod,
    ...(dataSplitMethod !== "ratio" || merged.data_split_ratios === undefined
      ? {}
      : { data_split_ratios: merged.data_split_ratios }),
    ...(dataSplitMethod !== "row_ranges" || merged.data_split_row_ranges === undefined
      ? {}
      : { data_split_row_ranges: merged.data_split_row_ranges }),
    target_columns: merged.target_columns,
    ...(merged.lookback_window === undefined ? {} : { lookback_window: merged.lookback_window }),
    prediction_horizon: merged.prediction_horizon,
    ...(merged.time_grain === undefined ? {} : { time_grain: merged.time_grain }),
    ...(merged.exogenous_variables === undefined ? {} : { exogenous_variables: merged.exogenous_variables }),
    ...(merged.future_covariate_availability === undefined
      ? {}
      : { future_covariate_availability: merged.future_covariate_availability }),
    ...(merged.business_context === undefined ? {} : { business_context: merged.business_context }),
    ...(merged.primary_metric === undefined ? {} : { primary_metric: merged.primary_metric }),
    secondary_metrics: merged.secondary_metrics,
    ...(merged.error_preferences === undefined ? {} : { error_preferences: merged.error_preferences }),
    ...(merged.latency_budget === undefined ? {} : { latency_budget: merged.latency_budget }),
    ...(merged.parameter_budget === undefined ? {} : { parameter_budget: merged.parameter_budget }),
    ...(merged.max_iterations === undefined ? {} : { max_iterations: merged.max_iterations }),
    ...(merged.max_no_improve === undefined ? {} : { max_no_improve: merged.max_no_improve }),
    ...(merged.interpretability === undefined ? {} : { interpretability: merged.interpretability }),
    ...(merged.deployment_target === undefined ? {} : { deployment_target: merged.deployment_target }),
    open_questions: openQuestions,
  }
}

function markdownList(values: readonly unknown[]) {
  return values.length === 0 ? "none" : values.map((value) => String(value)).join(", ")
}

function markdownValue(value: unknown) {
  if (Array.isArray(value)) return markdownList(value)
  if (value === undefined || value === null) return "unspecified"
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

function renderIntentSpecMarkdown(input: {
  readonly spec: IntentSpec
  readonly confidence: number
  readonly strategy: IntentDialogueStrategy
  readonly missingFields: readonly string[]
}) {
  const { spec, confidence, strategy, missingFields } = input
  const lines = [
    "# Intent Spec",
    "",
    "## Task",
    "",
    `- Title: ${spec.task_title}`,
    `- Domain: ${spec.domain_id}`,
    `- Interaction mode: ${spec.interaction_mode}`,
    `- Confidence: ${confidence}`,
    "",
    "## Forecast Definition",
    "",
    `- Forecast object: ${markdownValue(spec.forecast_object)}`,
    `- Data split method: ${spec.data_split_method}`,
    `- Data split ratios (train/validation/test): ${markdownValue(spec.data_split_ratios)}`,
    `- Data split row ranges: ${markdownValue(spec.data_split_row_ranges)}`,
    `- Target columns: ${markdownList(spec.target_columns)}`,
    `- Lookback window: ${markdownValue(spec.lookback_window)}`,
    `- Prediction horizon: ${markdownList(spec.prediction_horizon)}`,
    `- Time grain: ${markdownValue(spec.time_grain)}`,
    `- Exogenous variables: ${markdownValue(spec.exogenous_variables)}`,
    `- Future covariate availability: ${markdownValue(spec.future_covariate_availability)}`,
    "",
    "## Business Context",
    "",
    markdownValue(spec.business_context),
    "",
    "## Evaluation",
    "",
    `- Primary metric: ${markdownValue(spec.primary_metric)}`,
    `- Secondary metrics: ${markdownList(spec.secondary_metrics)}`,
    `- Error preferences: ${markdownValue(spec.error_preferences)}`,
    "",
    "## Constraints",
    "",
    `- Latency budget: ${markdownValue(spec.latency_budget)}`,
    `- Parameter budget: ${markdownValue(spec.parameter_budget)}`,
    `- NAS planned iterations: ${markdownValue(spec.max_iterations)}`,
    `- Stop after no improvement: ${markdownValue(spec.max_no_improve)}`,
    `- Interpretability: ${markdownValue(spec.interpretability)}`,
    `- Deployment target: ${markdownValue(spec.deployment_target)}`,
    "",
    "## Dialogue Strategy",
    "",
    `- Confidence threshold: ${strategy.confidenceThreshold}`,
    `- Questions per turn: ${strategy.maxQuestionsPerTurn}`,
    `- Question depth: ${strategy.questionDepth}`,
    `- Human checkpoints: ${strategy.humanCheckpointPhases.length === 0 ? "none" : strategy.humanCheckpointPhases.join(", ")}`,
    "",
    "## Open Questions",
    "",
  ]
  if (spec.open_questions.length === 0 && missingFields.length === 0) {
    lines.push("- None")
  } else {
    for (const question of spec.open_questions) lines.push(`- ${question}`)
  }
  return `${lines.join("\n")}\n`
}

function buildResult(input: {
  readonly task: ResearchTask
  readonly llm?: IntentAgentResult["llm"]
  readonly llmSlots?: Record<string, unknown>
  readonly llmQuestions?: string[]
  readonly llmConfidence?: number
}): IntentAgentResult {
  const mode = interactionModeForTask(input.task)
  const strategy = dialogueStrategy(mode)
  const slots = slotDefinitions(input.task)
  const normalizedLLMSlots = normalizeLLMSlots(input.llmSlots ?? {})
  const effectiveSplitMethod = normalizedLLMSlots.data_split_method === "row_ranges"
    ? "row_ranges"
    : normalizedLLMSlots.data_split_method === "ratio"
      ? "ratio"
      : collectedIntentSlots(input.task).data_split_method
  const slotValues = Object.keys(normalizedLLMSlots).length === 0 ? slots : slots.map((slot) => {
    const required = slot.id === "data_split_ratios"
      ? effectiveSplitMethod === "ratio"
      : slot.id === "data_split_row_ranges"
        ? effectiveSplitMethod === "row_ranges"
        : slot.required
    if (!(slot.id in normalizedLLMSlots)) return { ...slot, required }
    return { ...slot, required, value: normalizedLLMSlots[slot.id] }
  })
  const missingSlots = slotValues.filter(slotIsMissing)
  const missingFields = missingSlots.map((slot) => slot.field)
  const fallbackQuestions = missingSlots.map((slot) => questionForSlot(slot, mode))
  const llmQuestions = (input.llmQuestions ?? []).filter((question) => question.trim().length > 0)
  const clarifyingQuestions = (llmQuestions.length > 0 ? llmQuestions : fallbackQuestions).slice(
    0,
    strategy.maxQuestionsPerTurn,
  )
  const confidence = Number(
    Math.max(
      0,
      Math.min(0.99, typeof input.llmConfidence === "number" ? input.llmConfidence : confidenceFor(slotValues, strategy)),
    ).toFixed(2),
  )
  const intentSpec = intentSpecFrom(input.task, missingSlots, normalizedLLMSlots)
  const intentSpecMarkdown = renderIntentSpecMarkdown({
    spec: intentSpec,
    confidence,
    strategy,
    missingFields,
  })
  return {
    agent: "IntentAgent",
    taskID: input.task.id,
    confidence,
    missingFields,
    clarifyingQuestions,
    normalizedGoal: intentSpec as unknown as JsonRecord,
    taskSpec: input.task.taskSpec,
    intentSpec,
    intentSpecMarkdown,
    dialogueStrategy: strategy,
    llm: input.llm ?? { status: "disabled" },
  }
}

function normalizeLLMSlots(value: Record<string, unknown>) {
  const exogenous = firstKnown(value.exogenous_variables, value.exogenousVariables)
  const secondary = firstKnown(value.secondary_metrics, value.secondaryMetrics)
  const splitMethod = firstString(value.data_split_method, value.dataSplitMethod)
  const result: Partial<Record<SlotID, unknown>> = {
    forecast_object: firstString(value.forecast_object, value.forecastObject),
    data_source: firstString(value.data_source, value.dataSource),
    data_split_method: splitMethod === "ratio" || splitMethod === "row_ranges" ? splitMethod : undefined,
    data_split_ratios: splitRatios(firstKnown(value.data_split_ratios, value.dataSplitRatios)),
    data_split_row_ranges: splitRowRanges(firstKnown(value.data_split_row_ranges, value.dataSplitRowRanges)),
    target_columns: optionalStringArray(firstKnown(value.target_columns, value.targetColumns)),
    lookback_window: firstNumber(value.lookback_window, value.lookbackWindow),
    prediction_horizon: Array.isArray(firstKnown(value.prediction_horizon, value.predictionHorizon))
      ? numberArray(firstKnown(value.prediction_horizon, value.predictionHorizon))
      : undefined,
    exogenous_variables:
      typeof exogenous === "string" && /^none$/i.test(exogenous.trim()) ? [] : optionalStringArray(exogenous),
    future_covariate_availability: firstString(
      value.future_covariate_availability,
      value.futureCovariateAvailability,
    ),
    business_context: firstString(value.business_context, value.businessContext),
    primary_metric: firstString(value.primary_metric, value.primaryMetric),
    secondary_metrics: optionalStringArray(secondary),
    error_preferences: firstString(value.error_preferences, value.errorPreferences),
    latency_budget: firstKnown(value.latency_budget, value.latencyBudget),
    parameter_budget: firstKnown(value.parameter_budget, value.parameterBudget),
    max_iterations: firstNumber(value.max_iterations, value.maxIterations),
    max_no_improve: firstNumber(value.max_no_improve, value.maxNoImprove),
    interpretability: firstString(value.interpretability),
    deployment_target: firstString(value.deployment_target, value.deploymentTarget),
  }
  return Object.fromEntries(Object.entries(result).filter(([, item]) => item !== undefined)) as Record<string, unknown>
}

function shouldUseLLM(task: ResearchTask) {
  const taskSpec = recordValue(task.taskSpec)
  const intent = recordValue(taskSpec.intent)
  if (intent.llmEnabled === true || intent.llm_enabled === true) return true
  return process.env.NEO_RESEARCH_INTENT_LLM === "1"
}

function llmPrompt(input: { readonly task: ResearchTask; readonly base: IntentAgentResult }) {
  return JSON.stringify(
    {
      task: {
        id: input.task.id,
        title: input.task.title,
        domainID: input.task.domainID,
        mode: input.task.mode,
        taskSpec: input.task.taskSpec,
        objective: input.task.objective,
        budget: input.task.budget,
      },
      extractedIntentSpec: input.base.intentSpec,
      missingFields: input.base.missingFields,
      dialogueStrategy: input.base.dialogueStrategy,
      instruction:
        "Generate the next Socratic/Companion clarification questions from collected slots. Return JSON: confidence, slots, clarifying_questions. Fill only slots reasonably inferred from context; do not invent dataset paths, target columns, or hard budgets.",
    },
    null,
    2,
  )
}

function llmSystemPrompt() {
  return [
    "You are the NeoResearch Intent Agent for time-series forecasting.",
    "Your job is to refine a structured intent spec and ask the next best clarification questions.",
    "Language policy: natural-language questions should be English; preserve JSON field names in English.",
    "Return exactly one JSON object and no markdown.",
    "JSON shape: {\"confidence\": number, \"slots\": object, \"clarifying_questions\": string[]}.",
  ].join("\n")
}

function readLLMQuestions(payload: unknown) {
  const record = recordValue(payload)
  const questions = firstKnown(record.clarifying_questions, record.clarifyingQuestions, record.next_questions, record.nextQuestions)
  return stringArray(questions)
}

function readLLMConfidence(payload: unknown) {
  const record = recordValue(payload)
  return numberValue(record.confidence)
}

function readLLMSlots(payload: unknown) {
  const record = recordValue(payload)
  return recordValue(firstKnown(record.slots, record.intent_spec, record.intentSpec))
}

export function analyzeIntentTask(input: { readonly task: ResearchTask }): IntentAgentResult {
  return buildResult({ task: input.task, llm: { status: "disabled" } })
}

export async function analyzeIntentTaskWithLLM(input: {
  readonly task: ResearchTask
  readonly workspaceRoot: string
}): Promise<IntentAgentResult> {
  const base = analyzeIntentTask({ task: input.task })
  if (!shouldUseLLM(input.task)) return base
  const resolved = await resolveEffectiveLLMConfig({ workspaceRoot: input.workspaceRoot })
  if (!resolved) {
    return buildResult({
      task: input.task,
      llm: { status: "not_configured" },
    })
  }
  const { apiKey, config } = resolved
  try {
    const { text } = await requestNeoCastLLM(config, apiKey, llmSystemPrompt(), llmPrompt({ task: input.task, base }))
    const payload = extractJsonObject(text)
    return buildResult({
      task: input.task,
      llm: {
        status: "used",
        provider: config.provider,
        model: config.model,
      },
      llmSlots: readLLMSlots(payload),
      llmQuestions: readLLMQuestions(payload),
      llmConfidence: readLLMConfidence(payload),
    })
  } catch (error) {
    return buildResult({
      task: input.task,
      llm: {
        status: "failed",
        provider: config.provider,
        model: config.model,
        error: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
      },
    })
  }
}

// Canonical snake_case aliases for supported intent slots.
const SLOT_KEY_ALIASES: Record<string, string> = {
  interactionMode: "interaction_mode",
  forecastObject: "forecast_object",
  dataSource: "data_source",
  dataSplitMethod: "data_split_method",
  dataSplitRatios: "data_split_ratios",
  dataSplitRowRanges: "data_split_row_ranges",
  targetColumns: "target_columns",
  lookbackWindow: "lookback_window",
  predictionHorizon: "prediction_horizon",
  timeGrain: "time_grain",
  exogenousVariables: "exogenous_variables",
  futureCovariateAvailability: "future_covariate_availability",
  businessContext: "business_context",
  primaryMetric: "primary_metric",
  secondaryMetrics: "secondary_metrics",
  errorPreferences: "error_preferences",
  latencyBudget: "latency_budget",
  parameterBudget: "parameter_budget",
  maxIterations: "max_iterations",
  maxNoImprove: "max_no_improve",
  deploymentTarget: "deployment_target",
}

export function normalizeIntentSlotKeys(slots: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(slots)) {
    const canonical = SLOT_KEY_ALIASES[key] ?? key
    result[canonical] = value
  }
  return result
}

function coerceSlotValue(value: unknown): unknown {
  if (typeof value !== "string") return value
  const trimmed = value.trim()
  if (trimmed.length === 0) return trimmed
  const num = Number(trimmed)
  if (Number.isFinite(num)) return num
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.parse(trimmed)
    } catch {
      // Keep the original text so an available LLM can still interpret it.
    }
  }
  if (/^\d+(?:\.\d+)?\s*[:/]\s*\d+(?:\.\d+)?\s*[:/]\s*\d+(?:\.\d+)?$/.test(trimmed)) {
    return trimmed.split(/[:/]/).map((item) => Number(item.trim()))
  }
  // comma-separated numbers → number array
  if (/^\d[\d\s,]*\d$/.test(trimmed)) {
    const parts = trimmed.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
    if (parts.length > 1) return parts
  }
  return trimmed
}

export async function parseSlotInputsWithLLM(input: {
  readonly slots: Record<string, unknown>
  readonly clarifyingQuestions: readonly string[]
  readonly workspaceRoot: string
}): Promise<Record<string, unknown>> {
  // Lightweight coercion (no LLM needed for simple numeric / array values)
  const coerced: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input.slots)) {
    coerced[key] = coerceSlotValue(value)
  }
  const resolved = await resolveEffectiveLLMConfig({ workspaceRoot: input.workspaceRoot })
  if (!resolved) return coerced
  const { apiKey, config } = resolved
  try {
    const system = [
      "You are a slot-value parser for a time-series forecasting intent system.",
      "Given a map of slot IDs to raw user answers, parse each value into a typed JSON value.",
      "Rules: parse bare numbers as JSON numbers; comma-separated numbers as JSON arrays of numbers;",
      "       parse data_split_ratios such as 7:1:2 as [7,1,2];",
      "       parse data_split_row_ranges as {train:[start,end],validation:[start,end],test:[start,end]};",
      "       lists / bracket notation as JSON arrays; everything else as a string.",
      "Return exactly one JSON object mapping slot IDs to parsed values.",
      "Only include slots that have non-empty, meaningful values.",
    ].join("\n")
    const user = JSON.stringify(
      { slots: input.slots, clarifyingQuestions: input.clarifyingQuestions },
      null,
      2,
    )
    const { text } = await requestNeoCastLLM(config, apiKey, system, user)
    const parsed = extractJsonObject(text)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...coerced, ...recordValue(parsed) }
    }
  } catch {
    // fall through to coerced result
  }
  return coerced
}

export async function interpretSlotModificationWithLLM(input: {
  readonly message: string
  readonly currentSlots: readonly { id: string; label: string; value?: string }[]
  readonly workspaceRoot: string
}): Promise<{
  readonly status: "disabled" | "not_configured" | "used" | "failed"
  readonly provider?: string
  readonly model?: string
  readonly error?: string
  readonly updates: Record<string, unknown>
}> {
  const resolved = await resolveEffectiveLLMConfig({ workspaceRoot: input.workspaceRoot })
  if (!resolved) return { status: "not_configured", updates: {} }
  const { apiKey, config } = resolved
  const system = [
    "You are a slot-update interpreter for a time-series forecasting research system.",
    "The user sent a natural-language message in English expressing intent to modify research parameters.",
    "Given the current slot values and the message, determine which slots should be updated.",
    "Return exactly one JSON object: { \"updates\": { \"slot_id\": new_value, ... } }.",
    "Only include slots the user clearly wants to change. Values must be typed (numbers, arrays, or strings).",
    "Do not invent values not implied by the message.",
  ].join("\n")
  const user = JSON.stringify(
    {
      message: input.message,
      currentSlots: input.currentSlots.map((s) => ({ id: s.id, label: s.label, currentValue: s.value ?? null })),
    },
    null,
    2,
  )
  try {
    const { text } = await requestNeoCastLLM(config, apiKey, system, user)
    const parsed = extractJsonObject(text)
    const record = recordValue(parsed)
    const updates = recordValue(firstKnown(record.updates, record.slots, record.changes))
    return { status: "used", provider: config.provider, model: config.model, updates }
  } catch (error) {
    return {
      status: "failed",
      provider: config.provider,
      model: config.model,
      error: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
      updates: {},
    }
  }
}
