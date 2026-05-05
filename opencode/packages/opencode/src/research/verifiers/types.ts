import type { JsonRecord, ResearchCandidate, ResearchChampion, ResearchRun, ResearchTask } from "../schema"

export type VerifierName =
  | "metric_verifier"
  | "baseline_comparison_verifier"
  | "cost_perf_verifier"
  | "horizon_verifier"
  | "overfitting_verifier"
  | "data_leakage_verifier"

export interface VerifierResult {
  readonly name: VerifierName
  readonly accepted: boolean
  readonly reason: string
  readonly evidence: JsonRecord
}

export interface VerifierReport {
  readonly accepted: boolean
  readonly results: VerifierResult[]
  readonly rejectReason: string | undefined
}

export interface VerifierContext {
  readonly task: ResearchTask
  readonly run: ResearchRun
  readonly candidate: ResearchCandidate | undefined
  readonly previousRuns: readonly ResearchRun[]
  readonly champion: ResearchChampion | undefined
}

export function finiteNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function metricOf(run: ResearchRun, key: string): number | undefined {
  return finiteNum((run.metrics as Record<string, unknown>)[key])
}

export function paramsM(run: ResearchRun): number | undefined {
  const m = (run.metrics as Record<string, unknown>)
  const u = (run.resourceUsage as Record<string, unknown>)
  for (const src of [m, u]) {
    for (const k of ["params_M", "paramsM", "num_params_M", "numParamsM"]) {
      const v = finiteNum(src[k])
      if (v !== undefined) return v
    }
    for (const k of ["params", "numParams", "parameterCount"]) {
      const v = finiteNum(src[k])
      if (v !== undefined) return v / 1_000_000
    }
  }
  return undefined
}
