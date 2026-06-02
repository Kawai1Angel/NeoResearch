import type { JsonRecord, ResearchTask, ResearchTaskID } from "../schema"
import { apiKeyFor, extractJsonObject, requestNeoCastLLM, resolveNeoCastLLMConfig } from "../llm-proposal"

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
  readonly target_columns: string[]
  readonly lookback_window?: number
  readonly prediction_horizon: number[]
  readonly time_grain?: string
  readonly exogenous_variables?: string[]
  readonly business_context?: string
  readonly primary_metric?: string
  readonly secondary_metrics: string[]
  readonly error_preferences?: string
  readonly latency_budget?: unknown
  readonly parameter_budget?: unknown
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

type SlotID =
  | "interaction_mode"
  | "forecast_object"
  | "data_source"
  | "target_columns"
  | "lookback_window"
  | "prediction_horizon"
  | "exogenous_variables"
  | "business_context"
  | "primary_metric"
  | "secondary_metrics"
  | "error_preferences"
  | "latency_budget"
  | "parameter_budget"
  | "interpretability"
  | "deployment_target"

type IntentSlot = {
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

function interactionModeForTask(task: ResearchTask): IntentInteractionMode {
  const taskSpec = recordValue(task.taskSpec)
  const metadata = recordValue(taskSpec.metadata)
  const raw = metadata.interactionMode ?? metadata.interaction_mode
  if (raw === "companion" || raw === "cognitive_companion") return "companion"
  if (raw === "socratic") return "socratic"
  return task.mode === "review" ? "companion" : "socratic"
}

function dialogueStrategy(mode: IntentInteractionMode): IntentDialogueStrategy {
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

function collectedIntentSlots(task: ResearchTask) {
  const taskSpec = recordValue(task.taskSpec)
  const dataset = recordValue(taskSpec.dataset)
  const objective = recordValue(task.objective)
  const budget = recordValue(task.budget)
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
    dataset.knownFutureCovariates,
    dataset.observedPastCovariates,
    dataset.staticCovariates,
    taskSpec.exogenousVariables,
    taskSpec.exogenous_variables,
  )
  const primaryMetric = firstString(objective.primaryMetric, objective.primary_metric, mergedSlots.primary_metric)

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
    target_columns: targetColumns,
    lookback_window: firstNumber(
      mergedSlots.lookback_window,
      taskSpec.contextLength,
      taskSpec.lookbackWindow,
      taskSpec.lookback,
      taskSpec.inputLength,
    ),
    prediction_horizon: numberArray(firstKnown(taskSpec.predictionLengths, taskSpec.predictionHorizon, mergedSlots.prediction_horizon)),
    time_grain: firstString(mergedSlots.time_grain, taskSpec.timeGrain, taskSpec.frequency, dataset.frequency),
    exogenous_variables: optionalStringArray(exogenousVariables),
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

function slotDefinitions(task: ResearchTask): IntentSlot[] {
  const slots = collectedIntentSlots(task)
  return [
    {
      id: "interaction_mode",
      field: "intent.interaction_mode",
      label: "交互模式",
      required: true,
      socraticQuestion: "这次任务是否按 Socratic 模式执行：前期充分澄清，后续自主运行？",
      companionQuestion: "这次任务是否按 Companion 模式执行，并在关键阶段等待你确认？",
      value: slots.interaction_mode,
    },
    {
      id: "forecast_object",
      field: "intent.forecast_object",
      label: "预测对象",
      required: true,
      socraticQuestion: "这次预测对象具体是什么？请说明业务对象和被预测现象。",
      companionQuestion: "预测对象是什么？用一句话说明业务对象即可。",
      value: slots.forecast_object,
    },
    {
      id: "data_source",
      field: "dataset.path",
      label: "数据来源",
      required: true,
      socraticQuestion: "NeoResearch 应该使用哪个 CSV 数据集路径进行 profiling 和执行？",
      companionQuestion: "CSV 数据集路径是什么？",
      value: slots.data_source,
    },
    {
      id: "target_columns",
      field: "dataset.targetCols",
      label: "目标列",
      required: true,
      emptyArrayIsMissing: true,
      socraticQuestion: "需要预测哪些目标列？",
      companionQuestion: "目标列有哪些？",
      value: slots.target_columns,
    },
    {
      id: "lookback_window",
      field: "contextLength",
      label: "lookback window",
      required: true,
      socraticQuestion: "模型应使用多长的 lookback window 作为输入上下文？",
      companionQuestion: "lookback window 先用多少步？",
      value: slots.lookback_window,
    },
    {
      id: "prediction_horizon",
      field: "predictionLengths",
      label: "预测 horizon",
      required: true,
      emptyArrayIsMissing: true,
      socraticQuestion: "需要评估哪些预测 horizon？",
      companionQuestion: "预测 horizon 列表是什么？",
      value: slots.prediction_horizon,
    },
    {
      id: "exogenous_variables",
      field: "intent.exogenous_variables",
      label: "外生变量",
      required: true,
      socraticQuestion: "是否有天气、节假日、价格、事件等外生变量？如果没有，请明确为 none。",
      companionQuestion: "外生变量有哪些？没有的话回答 none。",
      value: slots.exogenous_variables,
    },
    {
      id: "business_context",
      field: "intent.business_context",
      label: "业务背景",
      required: true,
      socraticQuestion: "这个预测结果最终服务哪个业务决策或研究判断？",
      companionQuestion: "这个预测服务什么业务场景？",
      value: slots.business_context,
    },
    {
      id: "primary_metric",
      field: "objective.primaryMetric",
      label: "主指标",
      required: true,
      socraticQuestion: "模型搜索应该优化哪个验证指标？",
      companionQuestion: "主优化指标是什么？",
      value: slots.primary_metric,
    },
    {
      id: "secondary_metrics",
      field: "objective.secondaryMetrics",
      label: "辅助指标",
      required: false,
      socraticQuestion: "除了主指标，还要同时关注哪些辅助指标或 horizon-wise trade-off？",
      companionQuestion: "还有哪些辅助指标要看？",
      value: slots.secondary_metrics,
    },
    {
      id: "error_preferences",
      field: "objective.error_preferences",
      label: "误差偏好",
      required: true,
      socraticQuestion: "误差偏好是什么：更重视短期、长期、峰值、平均误差，还是稳定性？",
      companionQuestion: "误差偏好更重视短期、长期、峰值还是平均表现？",
      value: slots.error_preferences,
    },
    {
      id: "latency_budget",
      field: "budget.latency_budget",
      label: "延迟预算",
      required: true,
      socraticQuestion: "部署或推理是否有延迟预算？例如单次推理、批处理窗口或无硬约束。",
      companionQuestion: "推理延迟预算是多少？没有硬约束也请说明。",
      value: slots.latency_budget,
    },
    {
      id: "parameter_budget",
      field: "budget.parameter_budget",
      label: "参数预算",
      required: true,
      socraticQuestion: "模型参数量或资源预算有什么限制？",
      companionQuestion: "参数量/资源预算有什么上限？",
      value: slots.parameter_budget,
    },
    {
      id: "interpretability",
      field: "intent.interpretability",
      label: "可解释性",
      required: true,
      socraticQuestion: "是否需要可解释性、消融解释或简单模型优先？",
      companionQuestion: "可解释性要求是什么？",
      value: slots.interpretability,
    },
    {
      id: "deployment_target",
      field: "runtime.deployment_target",
      label: "部署目标",
      required: true,
      socraticQuestion: "最终模型部署目标是什么：本地 CPU、GPU 服务、边缘设备、离线批处理，还是仅研究报告？",
      companionQuestion: "部署目标是什么？",
      value: slots.deployment_target,
    },
  ]
}

function slotIsMissing(slot: IntentSlot) {
  if (!slot.required) return false
  if (slot.value === undefined || slot.value === null) return true
  if (typeof slot.value === "string") return slot.value.trim().length === 0
  if (Array.isArray(slot.value)) return slot.emptyArrayIsMissing === true && slot.value.length === 0
  return false
}

function questionForSlot(slot: IntentSlot, mode: IntentInteractionMode) {
  return mode === "companion" ? slot.companionQuestion : slot.socraticQuestion
}

function confidenceFor(slots: IntentSlot[], strategy: IntentDialogueStrategy) {
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
  const openQuestions = missingSlots.map((slot) => questionForSlot(slot, merged.interaction_mode))
  return {
    interaction_mode: merged.interaction_mode,
    task_title: task.title,
    domain_id: task.domainID,
    ...(merged.forecast_object === undefined ? {} : { forecast_object: merged.forecast_object }),
    ...(merged.data_source === undefined ? {} : { data_source: merged.data_source }),
    target_columns: merged.target_columns,
    ...(merged.lookback_window === undefined ? {} : { lookback_window: merged.lookback_window }),
    prediction_horizon: merged.prediction_horizon,
    ...(merged.time_grain === undefined ? {} : { time_grain: merged.time_grain }),
    ...(merged.exogenous_variables === undefined ? {} : { exogenous_variables: merged.exogenous_variables }),
    ...(merged.business_context === undefined ? {} : { business_context: merged.business_context }),
    ...(merged.primary_metric === undefined ? {} : { primary_metric: merged.primary_metric }),
    secondary_metrics: merged.secondary_metrics,
    ...(merged.error_preferences === undefined ? {} : { error_preferences: merged.error_preferences }),
    ...(merged.latency_budget === undefined ? {} : { latency_budget: merged.latency_budget }),
    ...(merged.parameter_budget === undefined ? {} : { parameter_budget: merged.parameter_budget }),
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
    `- Target columns: ${markdownList(spec.target_columns)}`,
    `- Lookback window: ${markdownValue(spec.lookback_window)}`,
    `- Prediction horizon: ${markdownList(spec.prediction_horizon)}`,
    `- Time grain: ${markdownValue(spec.time_grain)}`,
    `- Exogenous variables: ${markdownValue(spec.exogenous_variables)}`,
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
  const slotValues = Object.keys(normalizedLLMSlots).length === 0 ? slots : slots.map((slot) => {
    if (!(slot.id in normalizedLLMSlots)) return slot
    return { ...slot, value: normalizedLLMSlots[slot.id] }
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
  const result: Partial<Record<SlotID, unknown>> = {
    forecast_object: firstString(value.forecast_object, value.forecastObject),
    data_source: firstString(value.data_source, value.dataSource),
    target_columns: optionalStringArray(firstKnown(value.target_columns, value.targetColumns)),
    lookback_window: firstNumber(value.lookback_window, value.lookbackWindow),
    prediction_horizon: Array.isArray(firstKnown(value.prediction_horizon, value.predictionHorizon))
      ? numberArray(firstKnown(value.prediction_horizon, value.predictionHorizon))
      : undefined,
    exogenous_variables:
      typeof exogenous === "string" && /^none$/i.test(exogenous.trim()) ? [] : optionalStringArray(exogenous),
    business_context: firstString(value.business_context, value.businessContext),
    primary_metric: firstString(value.primary_metric, value.primaryMetric),
    secondary_metrics: optionalStringArray(secondary),
    error_preferences: firstString(value.error_preferences, value.errorPreferences),
    latency_budget: firstKnown(value.latency_budget, value.latencyBudget),
    parameter_budget: firstKnown(value.parameter_budget, value.parameterBudget),
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
        "基于已采集 slots 生成下一轮 Socratic/Companion 澄清问题。返回 JSON：confidence, slots, clarifying_questions。只补充可从上下文合理推断的 slots；不要编造数据路径、目标列或硬预算。",
    },
    null,
    2,
  )
}

function llmSystemPrompt() {
  return [
    "You are the NeoResearch Intent Agent for time-series forecasting.",
    "Your job is to refine a structured intent spec and ask the next best clarification questions.",
    "Language policy: natural-language questions should be Chinese; preserve JSON field names in English.",
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
  const config = await resolveNeoCastLLMConfig({ workspaceRoot: input.workspaceRoot })
  const apiKey = apiKeyFor(config)
  if (!apiKey) {
    return buildResult({
      task: input.task,
      llm: {
        status: "not_configured",
        provider: config.provider,
        model: config.model,
        error:
          config.provider === "anthropic"
            ? "ANTHROPIC_API_KEY is not set"
            : "NEO_CAST_LLM_API_KEY, OPENAI_API_KEY, or AIGCBEST_API_KEY is not set",
      },
    })
  }
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

// Canonical snake_case names for all 16 intent slots.
const SLOT_KEY_ALIASES: Record<string, string> = {
  interactionMode: "interaction_mode",
  forecastObject: "forecast_object",
  dataSource: "data_source",
  targetColumns: "target_columns",
  lookbackWindow: "lookback_window",
  predictionHorizon: "prediction_horizon",
  timeGrain: "time_grain",
  exogenousVariables: "exogenous_variables",
  businessContext: "business_context",
  primaryMetric: "primary_metric",
  secondaryMetrics: "secondary_metrics",
  errorPreferences: "error_preferences",
  latencyBudget: "latency_budget",
  parameterBudget: "parameter_budget",
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
  const config = await resolveNeoCastLLMConfig({ workspaceRoot: input.workspaceRoot })
  const apiKey = apiKeyFor(config)
  if (!apiKey) return coerced
  try {
    const system = [
      "You are a slot-value parser for a time-series forecasting intent system.",
      "Given a map of slot IDs to raw user answers, parse each value into a typed JSON value.",
      "Rules: parse bare numbers as JSON numbers; comma-separated numbers as JSON arrays of numbers;",
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
  const config = await resolveNeoCastLLMConfig({ workspaceRoot: input.workspaceRoot })
  const apiKey = apiKeyFor(config)
  if (!apiKey) return { status: "not_configured", provider: config.provider, model: config.model, updates: {} }
  const system = [
    "You are a slot-update interpreter for a time-series forecasting research system.",
    "The user sent a natural-language message (Chinese or English) expressing intent to modify research parameters.",
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
