import type { JsonRecord, ResearchCandidate, ResearchRun, ResearchTaskID } from "../schema"
import type { VerifierReport } from "../verifiers"

export interface TrainEvalResult {
  readonly agent: "TrainEvalAgent"
  readonly taskID: ResearchTaskID
  readonly candidateID: ResearchCandidate["id"]
  readonly runID: ResearchRun["id"]
  readonly stage: "low_fidelity" | "full"
  readonly status: "succeeded" | "failed" | "rejected"
  readonly primaryMetric?: number
  readonly metrics: JsonRecord
  readonly trainingLogSummary: string
  readonly verifierDecision: "accepted" | "rejected" | "skipped" | "inconclusive"
  readonly verifierRejectReason?: string
}

function finiteMetric(metrics: ResearchRun["metrics"], key: string) {
  const value = (metrics as Record<string, unknown>)[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function trainEvalStatus(run: ResearchRun, verifierReport: VerifierReport | undefined): TrainEvalResult["status"] {
  if (run.status === "rejected" || verifierReport?.status === "failed") return "rejected"
  if (run.status === "succeeded") return "succeeded"
  return "failed"
}

function verifierDecision(verifierReport: VerifierReport | undefined): TrainEvalResult["verifierDecision"] {
  if (verifierReport === undefined) return "skipped"
  return verifierReport.status === "insufficient_evidence" ? "inconclusive" : verifierReport.accepted ? "accepted" : "rejected"
}

function buildTrainingLogSummary(input: {
  readonly run: ResearchRun
  readonly primaryMetricName: string
  readonly primaryMetric?: number
  readonly verifierReport?: VerifierReport
}) {
  const metricText =
    input.primaryMetric === undefined ? `${input.primaryMetricName}=n/a` : `${input.primaryMetricName}=${input.primaryMetric}`
  const verifierText =
    input.verifierReport === undefined
      ? "verifier=skipped"
      : input.verifierReport.status === "insufficient_evidence" ? "verifier=inconclusive (missing evidence)" : input.verifierReport.accepted
        ? "verifier=accepted"
        : `verifier=rejected (${input.verifierReport.rejectReason ?? "no reason"})`
  const errorText = input.run.error === undefined ? "" : ` error=${input.run.error}`
  return `Run ${input.run.id} ${input.run.stage}/${input.run.status}: ${metricText}; ${verifierText}.${errorText}`
}

export function buildTrainEvalResult(input: {
  readonly taskID: ResearchTaskID
  readonly run: ResearchRun
  readonly candidate: ResearchCandidate
  readonly stage: "low_fidelity" | "full"
  readonly primaryMetricName?: string
  readonly verifierReport?: VerifierReport
}): TrainEvalResult {
  const primaryMetricName = input.primaryMetricName ?? "val_avg_mse"
  const primaryMetric = finiteMetric(input.run.metrics, primaryMetricName)
  const decision = verifierDecision(input.verifierReport)
  return {
    agent: "TrainEvalAgent",
    taskID: input.taskID,
    candidateID: input.candidate.id,
    runID: input.run.id,
    stage: input.stage,
    status: trainEvalStatus(input.run, input.verifierReport),
    ...(primaryMetric === undefined ? {} : { primaryMetric }),
    metrics: input.run.metrics,
    trainingLogSummary: buildTrainingLogSummary({
      run: input.run,
      primaryMetricName,
      ...(primaryMetric === undefined ? {} : { primaryMetric }),
      ...(input.verifierReport === undefined ? {} : { verifierReport: input.verifierReport }),
    }),
    verifierDecision: decision,
    ...(input.verifierReport?.rejectReason === undefined ? {} : { verifierRejectReason: input.verifierReport.rejectReason }),
  }
}
