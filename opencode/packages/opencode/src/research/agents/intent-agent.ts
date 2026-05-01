import type { JsonRecord, ResearchTask, ResearchTaskID } from "../schema"

export interface IntentAgentResult {
  readonly agent: "IntentAgent"
  readonly taskID: ResearchTaskID
  readonly confidence: number
  readonly missingFields: string[]
  readonly clarifyingQuestions: string[]
  readonly normalizedGoal: JsonRecord
  readonly taskSpec: JsonRecord
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.length > 0)
}

function numberArray(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
}

function questionForField(field: string) {
  if (field === "dataset.path") return "Which CSV dataset path should NeoResearch use for profiling and execution?"
  if (field === "dataset.targetCols") return "Which target columns should be forecast?"
  if (field === "predictionLengths") return "Which forecast horizons should be evaluated?"
  if (field === "objective.primaryMetric") return "Which validation metric should optimize model search?"
  return `Please confirm ${field}.`
}

export function analyzeIntentTask(input: { readonly task: ResearchTask }): IntentAgentResult {
  const taskSpec = recordValue(input.task.taskSpec)
  const dataset = recordValue(taskSpec.dataset)
  const objective = recordValue(input.task.objective)
  const missingFields = [
    typeof dataset.path === "string" && dataset.path.length > 0 ? undefined : "dataset.path",
    stringArray(dataset.targetCols).length > 0 ? undefined : "dataset.targetCols",
    numberArray(taskSpec.predictionLengths).length > 0 ? undefined : "predictionLengths",
    typeof objective.primaryMetric === "string" && objective.primaryMetric.length > 0
      ? undefined
      : "objective.primaryMetric",
  ].filter((item): item is string => item !== undefined)

  const confidence = Math.max(0.35, Number((1 - missingFields.length * 0.18).toFixed(2)))
  return {
    agent: "IntentAgent",
    taskID: input.task.id,
    confidence,
    missingFields,
    clarifyingQuestions: missingFields.map(questionForField),
    normalizedGoal: {
      title: input.task.title,
      domainID: input.task.domainID,
      mode: input.task.mode,
      targetCols: stringArray(dataset.targetCols),
      predictionLengths: numberArray(taskSpec.predictionLengths),
      primaryMetric: typeof objective.primaryMetric === "string" ? objective.primaryMetric : "val_avg_mse",
    } as JsonRecord,
    taskSpec: input.task.taskSpec,
  }
}
