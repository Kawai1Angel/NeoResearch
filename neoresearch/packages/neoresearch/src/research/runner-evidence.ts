import { assessAttribution } from "./attribution"
import { readFile } from "node:fs/promises"

export interface TrainingCurvePoint {
  readonly epoch: number
  readonly valLoss: number
  readonly horizon?: number
  readonly foldIndex?: number
  readonly phase: "cv" | "standard"
  readonly elapsedS?: number
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** Present execution facts to reflection without the post-training evaluation decision. */
export function reflectionExecutionEvidence<T extends {
  status: string
  error?: string | null
  metrics: Record<string, unknown>
  resourceUsage: Record<string, unknown>
}>(run: T, primaryMetric: string): T {
  const { verification, ...resourceUsage } = run.resourceUsage
  const report = verification as { status?: string } | undefined
  const contract = resourceUsage.executionContract as { status?: string } | undefined
  const evaluated = run.status === "rejected" && report?.status === "failed" &&
    contract?.status === "verified" && finite(run.metrics[primaryMetric]) !== undefined &&
    resourceUsage.independentEvidence !== false && resourceUsage.duplicateExperiment !== true
  return { ...run, resourceUsage, ...(evaluated ? { status: "succeeded", error: undefined } : {}) }
}

export function buildExperimentResultEvidence(input: {
  readonly runID: string
  readonly stage: string
  readonly status: string
  readonly primaryMetric: string
  readonly metrics: Record<string, unknown>
  readonly error?: string | null
  readonly candidateSpec?: Record<string, unknown>
  readonly hypothesisID?: string
  readonly independentEvidence?: boolean
  readonly executionVerified?: boolean
  readonly hypothesisSnapshot?: Record<string, unknown>
  readonly trainingTrial?: Record<string, unknown>
  readonly comparisonSpec?: Record<string, unknown>
  readonly evaluationEvidence?: unknown
}) {
  const value = finite(input.metrics[input.primaryMetric])
  const duplicate = input.independentEvidence === false
  const complete = !duplicate && input.status === "succeeded" && value !== undefined
  const missingMetric = !duplicate && input.status === "succeeded" && input.stage === "full" && value === undefined
  return {
    metricValidity: complete ? "observed" : duplicate ? "duplicate" : "inconclusive",
    attribution: assessAttribution({ executionVerified: input.executionVerified === true, proposedModel: input.candidateSpec, hypothesisSnapshot: input.hypothesisSnapshot, trainingTrial: input.trainingTrial }, input.comparisonSpec ? { proposedModel: input.comparisonSpec } : undefined),
    ...(input.trainingTrial ? { trainingTrial: input.trainingTrial } : {}),
    metrics: complete ? input.metrics : {},
    evaluationEvidence: input.evaluationEvidence,
    runID: input.runID,
    stage: input.stage,
    status: input.status,
    evidence_disposition: duplicate ? "duplicate" : complete ? "complete" : "inconclusive",
    ...(input.hypothesisID ? { hypoID: input.hypothesisID, hypothesisID: input.hypothesisID } : {}),
    ...(complete ? { [input.primaryMetric]: value } : {}),
    ...(missingMetric ? { evaluationIssue: `Missing finite ${input.primaryMetric}; complete evaluation is required before judging the hypothesis.` } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(input.candidateSpec ? {
      modelDesign: Object.fromEntries(Object.entries(input.candidateSpec).filter(([key]) => !["notes", "hypothesis"].includes(key))),
    } : {}),
  }
}

// Keep each fold/horizon independent, including during downsampling. The limit is per series.
export async function extractTrainingCurve(filePath: string, maxPoints = 60): Promise<TrainingCurvePoint[]> {
  const raw = await readFile(filePath, "utf8").catch(() => "")
  const groups = new Map<string, TrainingCurvePoint[]>()
  for (const line of raw.split(/\r?\n/)) {
    try {
      let r = JSON.parse(line)
      if (typeof r.line === "string") r = JSON.parse(r.line)
      if (r.event && r.event !== "epoch_end") continue
      const epoch = finite(r.epoch)
      const valLoss = finite(r.val_loss) ?? finite(r.valLoss)
      if (epoch === undefined || valLoss === undefined) continue
      const foldIndex = finite(r.cv_fold_index) ?? finite(r.foldIndex)
      const horizon = finite(r.horizon)
      const point: TrainingCurvePoint = {
        epoch, valLoss, horizon, foldIndex,
        phase: foldIndex === undefined ? "standard" : "cv",
        elapsedS: finite(r.elapsed_s) ?? finite(r.elapsedS),
      }
      const key = `${point.phase}:${foldIndex ?? "standard"}:${horizon ?? "unknown"}`
      const group = groups.get(key) ?? []
      group.push(point)
      groups.set(key, group)
    } catch { /* Ignore non-JSON output; failure evidence is reported separately. */ }
  }
  const limit = Number.isFinite(maxPoints) ? Math.max(1, Math.floor(maxPoints)) : 60
  return [...groups.values()].flatMap((group) => {
    group.sort((a, b) => a.epoch - b.epoch)
    if (group.length <= limit) return group
    if (limit === 1) return [group[group.length - 1]!]
    return Array.from({ length: limit }, (_, i) => group[Math.round(i * (group.length - 1) / (limit - 1))]!)
  })
}

export function runnerFailureEvidence(execution: {
  records: readonly Record<string, unknown>[]
  stdout: string
  stderr: string
  exitCode: number | null
}): string {
  const errors = execution.records
    .filter((r) => ["error", "runner_error", "execution_contract_violation"].includes(String(r.event)))
    .map((r) => JSON.stringify(r))
  // Some validators print plain errors to stdout before any JSON records exist.
  const plain = execution.stdout.split(/\r?\n/).filter((line) => /^(error:|traceback|\w*(?:error|exception):)/i.test(line.trim()))
  return [
    ...new Set(errors),
    ...plain,
    execution.stderr.trim() ? `stderr:\n${execution.stderr.trim()}` : "",
  ].filter(Boolean).join("\n") || `Runner exited with code ${execution.exitCode}`
}

export async function recoverRunnerFailure(filePath: string, fallback?: string): Promise<string | undefined> {
  try {
    const execution = JSON.parse(await readFile(filePath, "utf8"))
    if (!Array.isArray(execution.records) || typeof execution.stdout !== "string" || typeof execution.stderr !== "string") return fallback
    if (execution.exitCode === 0 && fallback &&
        !execution.records.some((r: Record<string, unknown>) => ["error", "runner_error", "execution_contract_violation"].includes(String(r.event)))) return fallback
    const error = runnerFailureEvidence(execution)
    return error.startsWith("Runner exited with code") ? fallback ?? error : error
  } catch {
    return fallback
  }
}


const FINAL_METRIC_EVENTS = new Set(["eval_done", "smoke_eval_done", "cv_eval_done", "ref_test_done", "ref_test_eval_done"])
export function finalEvaluationRecords(records: readonly Record<string, unknown>[]) {
  return records.filter((r) => FINAL_METRIC_EVENTS.has(String(r.event)))
}
export function finalMetrics(records: readonly Record<string, unknown>[], stage?: string) {
  const metrics: Record<string, number> = {}
  for (const record of finalEvaluationRecords(records)) for (const [key, value] of Object.entries(record)) {
    const allowed = stage === "ref_test" ? key.startsWith("ref_test_") : stage === "smoke" ? key.startsWith("val_") : /^(cv_|val_|train_)/.test(key)
    if (allowed && /_(mse|mae|loss|rmse|mape|smape|r2|crps|coverage|width)$/.test(key) && typeof value === "number" && Number.isFinite(value)) metrics[key] = value
  }
  return metrics
}
