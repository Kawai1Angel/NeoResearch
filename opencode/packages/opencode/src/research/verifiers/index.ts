import type { VerifierContext, VerifierReport, VerifierResult } from "./types"
import { runBaselineComparisonVerifier } from "./baseline-comparison-verifier"
import { runCostPerfVerifier } from "./cost-perf-verifier"
import { runDataLeakageVerifier } from "./data-leakage-verifier"
import { runHorizonVerifier } from "./horizon-verifier"
import { runMetricVerifier } from "./metric-verifier"
import { runOverfittingVerifier } from "./overfitting-verifier"

export type { VerifierContext, VerifierName, VerifierReport, VerifierResult } from "./types"

export type VerifierFailureCategory =
  | "metric_missing"
  | "regression"
  | "resource_budget"
  | "horizon_instability"
  | "overfitting"
  | "data_leakage"
  | "verifier_rejection"

export type VerifierRecoveryActionType =
  | "fix_metric_reporting"
  | "audit_split_boundaries"
  | "try_safer_candidate"
  | "reduce_resource_usage"
  | "stabilize_long_horizon"
  | "audit_data_leakage"
  | "manual_review"

export interface VerifierDecisionRecord {
  readonly schemaVersion: "neo-research.verifier_decision.v1"
  readonly kind: "verifier_decision"
  readonly agent: "VerifierAgent"
  readonly taskID: string
  readonly runID: string
  readonly candidateID: string | null
  readonly accepted: boolean
  readonly decision: "accept" | "reject" | "inconclusive"
  readonly rejectReason: string | null
  readonly failure: {
    readonly category: VerifierFailureCategory
    readonly sourceVerifier: string
    readonly reason: string
    readonly recoveryAction: {
      readonly type: VerifierRecoveryActionType
      readonly summary: string
    }
  } | null
  readonly checks: Array<{
    readonly name: string
    readonly status: VerifierResult["status"]
    readonly accepted: boolean
    readonly reason: string
    readonly evidence: Record<string, unknown>
  }>
}

const VERIFIER_PIPELINE: ReadonlyArray<(ctx: VerifierContext) => VerifierResult> = [
  runMetricVerifier,
  runBaselineComparisonVerifier,
  runCostPerfVerifier,
  runHorizonVerifier,
  runOverfittingVerifier,
  runDataLeakageVerifier,
]

export function runVerifiers(ctx: VerifierContext): VerifierReport {
  const results: VerifierResult[] = []
  let rejectReason: string | undefined

  for (const verifier of VERIFIER_PIPELINE) {
    const result = verifier(ctx)
    results.push(result)
    if (result.status === "failed" && rejectReason === undefined) {
      rejectReason = `[${result.name}] ${result.reason}`
    }
  }

  const status = rejectReason
    ? "failed"
    : results.some((r) => r.status === "insufficient_evidence")
      ? "insufficient_evidence"
      : "passed"
  return {
    status,
    eligibleForRanking: !rejectReason && results.some((r) => r.name === "metric_verifier" && r.status === "passed"),
    accepted: status === "passed",
    results,
    rejectReason,
  }
}

export function buildEvaluationResultMarkdown(input: {
  readonly task: VerifierContext["task"]
  readonly run: VerifierContext["run"]
  readonly candidate: VerifierContext["candidate"]
  readonly report: VerifierReport
}): string {
  const { task, run, candidate, report } = input
  const lines: string[] = [
    "# Evaluation Result",
    "",
    `- Agent: VerifierAgent`,
    `- Task ID: ${task.id}`,
    `- Run ID: ${run.id}`,
    `- Candidate ID: ${candidate?.id ?? "(none)"}`,
    `- Run Status: ${run.status}`,
    `- Verdict: **${report.status.toUpperCase()}**`,
    ...(report.rejectReason ? [`- Reject Reason: ${report.rejectReason}`] : []),
    "",
    "## Verifier Results",
    "",
  ]

  for (const result of report.results) {
    lines.push(`### ${result.name}`, "", `- Verdict: ${result.status}`, `- Reason: ${result.reason}`, "")
    const entries = Object.entries(result.evidence)
    if (entries.length > 0) {
      lines.push("**Evidence:**", "")
      for (const [key, value] of entries) {
        lines.push(`- ${key}: ${JSON.stringify(value)}`)
      }
      lines.push("")
    }
  }

  return `${lines.join("\n")}\n`
}

function verifierFailureCategory(result: VerifierResult | undefined): VerifierFailureCategory {
  if (!result) return "verifier_rejection"
  if (result.name === "metric_verifier") return "metric_missing"
  if (result.name === "baseline_comparison_verifier") return "regression"
  if (result.name === "cost_perf_verifier") return "resource_budget"
  if (result.name === "horizon_verifier") return "horizon_instability"
  if (result.name === "overfitting_verifier") return "overfitting"
  if (result.name === "data_leakage_verifier") return "data_leakage"
  return "verifier_rejection"
}

function verifierRecoveryAction(category: VerifierFailureCategory): {
  readonly type: VerifierRecoveryActionType
  readonly summary: string
} {
  if (category === "metric_missing") {
    return {
      type: "fix_metric_reporting",
      summary: "Confirm that the runner emits the primary metric, complete the eval record/metrics parser, and rerun this candidate.",
    }
  }
  if (category === "regression") {
    return {
      type: "try_safer_candidate",
      summary: "Return to the current champion or a conservative neighboring mutation instead of amplifying a degraded structural direction.",
    }
  }
  if (category === "resource_budget") {
    return {
      type: "reduce_resource_usage",
      summary: "Reduce parameters, batch size, or training budget, then retry the same stage to check for resource constraints.",
    }
  }
  if (category === "horizon_instability") {
    return {
      type: "stabilize_long_horizon",
      summary: "Add long-horizon constraints, decomposition, or horizon weighting; prioritize retesting longer forecasts.",
    }
  }
  if (category === "overfitting") {
    return {
      type: "audit_data_leakage",
      summary: "Check splits, normalization, and leakage risk; strengthen ref/blind gates if needed before accepting this result.",
    }
  }
  if (category === "data_leakage") {
    return {
      type: "audit_split_boundaries",
      summary:
        "Immediately stop promoting this candidate. Check train/val/ref_test boundaries in dataset_spec.json, verify normalization fit_split is train, and ensure validation context windows exclude ref_test rows. Fix and rerun from smoke.",
    }
  }
  return {
    type: "manual_review",
    summary: "Preserve verifier evidence and request human review to determine whether the data, runner, or candidate definition needs correction.",
  }
}

export function buildVerifierDecisionRecord(input: {
  readonly task: VerifierContext["task"]
  readonly run: VerifierContext["run"]
  readonly candidate: VerifierContext["candidate"]
  readonly report: VerifierReport
}): VerifierDecisionRecord {
  const rejected = input.report.results.find((result) => result.status === "failed")
  const category = verifierFailureCategory(rejected)
  return {
    schemaVersion: "neo-research.verifier_decision.v1",
    kind: "verifier_decision",
    agent: "VerifierAgent",
    taskID: input.task.id,
    runID: input.run.id,
    candidateID: input.candidate?.id ?? null,
    accepted: input.report.accepted,
    decision:
      input.report.status === "passed" ? "accept" : input.report.status === "failed" ? "reject" : "inconclusive",
    rejectReason: input.report.rejectReason ?? null,
    failure: rejected
      ? {
          category,
          sourceVerifier: rejected.name,
          reason: rejected.reason,
          recoveryAction: verifierRecoveryAction(category),
        }
      : null,
    checks: input.report.results.map((result) => ({
      name: result.name,
      status: result.status,
      accepted: result.accepted,
      reason: result.reason,
      evidence: result.evidence as Record<string, unknown>,
    })),
  }
}
