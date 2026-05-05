import type { ResearchCandidateID, ResearchRun, ResearchRunID, ResearchTaskID } from "../schema"

export type ModelCompilerStatus = "passed" | "failed" | "timeout"

export interface ModelCompilerResult {
  readonly agent: "ModelCompilerAgent"
  readonly taskID: ResearchTaskID
  readonly candidateID: ResearchCandidateID
  readonly runID: ResearchRunID
  readonly status: ModelCompilerStatus
  readonly smokeMetric?: number
  readonly failureReason?: string
  readonly compileReportMarkdown: string
}

function finiteMetric(metrics: ResearchRun["metrics"], key: string) {
  const value = (metrics as Record<string, unknown>)[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function hasNonFiniteMetric(metrics: ResearchRun["metrics"], key: string) {
  const value = (metrics as Record<string, unknown>)[key]
  return typeof value === "number" && !Number.isFinite(value)
}

function isTimeout(run: ResearchRun) {
  const error = run.error?.toLowerCase() ?? ""
  const usage = run.resourceUsage as Record<string, unknown>
  return error.includes("timeout") || usage.timeout === true || usage.timedOut === true
}

function compilerDecision(run: ResearchRun): {
  readonly status: ModelCompilerStatus
  readonly smokeMetric?: number
  readonly failureReason?: string
} {
  if (isTimeout(run)) {
    return { status: "timeout", failureReason: run.error ?? "Smoke run timeout." }
  }
  if (run.status !== "succeeded") {
    return { status: "failed", failureReason: run.error ?? `Smoke run status was ${run.status}.` }
  }
  if (hasNonFiniteMetric(run.metrics, "val_avg_mse")) {
    return { status: "failed", failureReason: "Smoke metric val_avg_mse was non-finite." }
  }
  const smokeMetric = finiteMetric(run.metrics, "val_avg_mse")
  if (smokeMetric !== undefined && smokeMetric >= 1_000_000) {
    return {
      status: "failed",
      smokeMetric,
      failureReason: `Smoke metric exploded: val_avg_mse=${smokeMetric}.`,
    }
  }
  return { status: "passed", ...(smokeMetric === undefined ? {} : { smokeMetric }) }
}

function buildCompileReportMarkdown(input: {
  readonly taskID: ResearchTaskID
  readonly candidateID: ResearchCandidateID
  readonly run: ResearchRun
  readonly status: ModelCompilerStatus
  readonly smokeMetric?: number
  readonly failureReason?: string
}) {
  const verdict = input.status === "passed" ? "PASSED" : input.status === "timeout" ? "TIMEOUT" : "FAILED"
  return [
    "# Model Compile Report",
    "",
    `- Agent: ModelCompilerAgent`,
    `- Task ID: ${input.taskID}`,
    `- Candidate ID: ${input.candidateID}`,
    `- Smoke Run ID: ${input.run.id}`,
    `- Verdict: ${verdict}`,
    `- Metric: ${input.smokeMetric === undefined ? "n/a" : input.smokeMetric}`,
    ...(input.failureReason === undefined ? [] : [`- Failure reason: ${input.failureReason}`]),
    "",
  ].join("\n")
}

export function buildModelCompilerResult(input: {
  readonly taskID: ResearchTaskID
  readonly candidateID: ResearchCandidateID
  readonly smokeRun: ResearchRun
}): ModelCompilerResult {
  const decision = compilerDecision(input.smokeRun)
  return {
    agent: "ModelCompilerAgent",
    taskID: input.taskID,
    candidateID: input.candidateID,
    runID: input.smokeRun.id,
    ...decision,
    compileReportMarkdown: buildCompileReportMarkdown({
      taskID: input.taskID,
      candidateID: input.candidateID,
      run: input.smokeRun,
      ...decision,
    }),
  }
}
