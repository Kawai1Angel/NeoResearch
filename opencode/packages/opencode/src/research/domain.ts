import z from "zod"

import type {
  ExportArtifactKind,
  JsonRecord,
  ResearchApproval,
  ResearchArtifact,
  ResearchCandidate,
  ResearchChampion,
  ResearchMemory,
  ResearchRun,
  ResearchTask,
} from "./schema"

const OpenApiJsonRecord = z.record(z.string(), z.unknown()) as z.ZodType<JsonRecord>

export const DomainActionMeta = z
  .object({
    phaseMin: z.string(),
    bridgeSupported: z.boolean(),
  })
  .strict()
export type DomainActionMeta = z.infer<typeof DomainActionMeta>

export const DomainCapability = z
  .object({
    taskSpecKind: z.string(),
    candidateSpecKind: z.string(),
    evaluatorKind: z.string(),
    artifactExporterKind: z.string(),
    supportsAutonomous: z.boolean(),
    supportsPrivilegedEvaluation: z.boolean(),
  })
  .strict()
export type DomainCapability = z.infer<typeof DomainCapability>

export const DomainInfo = z
  .object({
    id: z.string(),
    displayName: z.string(),
    version: z.string(),
    taskSpecSchemaID: z.string(),
    candidateSpecSchemaID: z.string(),
    capability: DomainCapability.optional(),
    actionRegistry: z.record(z.string(), z.record(z.string(), DomainActionMeta)),
  })
  .strict()
export type DomainInfo = z.infer<typeof DomainInfo>

export const DomainValidationIssue = z
  .object({
    path: z.string(),
    message: z.string(),
    severity: z.enum(["error", "warning"]),
  })
  .strict()
export type DomainValidationIssue = z.infer<typeof DomainValidationIssue>

export const DomainValidationResult = z
  .object({
    ok: z.boolean(),
    issues: z.array(DomainValidationIssue),
    normalizedCandidateSpec: OpenApiJsonRecord.optional(),
  })
  .strict()
export type DomainValidationResult = z.infer<typeof DomainValidationResult>

export const DomainCandidateProposal = z
  .object({
    candidateSpec: OpenApiJsonRecord,
    rationale: z.string(),
    riskLevel: z.enum(["low", "medium", "high"]),
    approvalStatus: z.enum(["pending", "approved", "auto_approved", "rejected"]),
    generatedBy: z.enum(["llm", "heuristic", "mutation", "human"]),
  })
  .strict()
export type DomainCandidateProposal = z.infer<typeof DomainCandidateProposal>

export type DomainCandidateRanking = {
  readonly rank: number
  readonly score: number
  readonly reasons: readonly string[]
  readonly predictorVersion?: string
  readonly features?: JsonRecord
  readonly candidateActions?: JsonRecord
  readonly candidateSpec: JsonRecord
  readonly rationale: string
  readonly riskLevel: DomainCandidateProposal["riskLevel"]
  readonly approvalStatus: DomainCandidateProposal["approvalStatus"]
  readonly generatedBy: DomainCandidateProposal["generatedBy"]
}

export const DomainRunStage = z.enum(["baseline", "smoke", "low_fidelity", "full", "ref_test", "blind_test"])
export type DomainRunStage = z.infer<typeof DomainRunStage>

export type DomainProposalContext = {
  readonly taskSpec: JsonRecord
  readonly taskFingerprint?: JsonRecord
  readonly candidates: readonly {
    readonly id: string
    readonly candidateSpec: JsonRecord
    readonly approvalStatus: string
    readonly generatedBy: string
  }[]
  readonly runs: readonly {
    readonly candidateID: string
    readonly stage: string
    readonly status: string
    readonly metrics: JsonRecord
  }[]
  readonly memory: readonly {
    readonly scope?: "task" | "domain"
    readonly outcome: string
    readonly lesson: string
    readonly fingerprintSummary?: JsonRecord
    readonly candidateSummary: JsonRecord
    readonly time?: number
  }[]
  readonly champion?: {
    readonly candidateID: string
    readonly primaryMetric: number
    readonly utility: number
  }
}

export type DomainArtifactContext = {
  readonly kind: ExportArtifactKind
  readonly task: ResearchTask
  readonly candidates: readonly ResearchCandidate[]
  readonly runs: readonly ResearchRun[]
  readonly approvals: readonly ResearchApproval[]
  readonly artifacts: readonly ResearchArtifact[]
  readonly memory: readonly ResearchMemory[]
  readonly champion?: ResearchChampion
}

export type DomainArtifactRender = {
  readonly filename: string
  readonly content: string
  readonly metadata?: JsonRecord
}

export type DomainRunEvaluationContext = {
  readonly task: ResearchTask
  readonly candidate: ResearchCandidate
  readonly run: ResearchRun
}

export type DomainRunEvaluation = {
  readonly primaryMetricName: string
  readonly primaryMetric?: number
  readonly direction: "minimize" | "maximize"
  readonly utility?: number
}

export const DomainRunnerCommand = z
  .object({
    executable: z.string(),
    args: z.array(z.string()),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict()
export type DomainRunnerCommand = z.infer<typeof DomainRunnerCommand>

export const DomainRunnerWrite = z
  .object({
    path: z.string(),
    content: OpenApiJsonRecord,
  })
  .strict()
export type DomainRunnerWrite = z.infer<typeof DomainRunnerWrite>

export const DomainRunPlan = z
  .object({
    domainID: z.string(),
    runnerID: z.string(),
    runnerKind: z.enum(["subprocess"]),
    stage: DomainRunStage,
    approvalRequired: z.boolean(),
    validation: DomainValidationResult,
    writes: z.array(DomainRunnerWrite),
    command: DomainRunnerCommand,
    expectedEvents: z.array(z.string()),
    expectedMetrics: z.array(z.string()),
    expectedArtifacts: z.array(z.string()),
    notes: z.string().optional(),
  })
  .strict()
export type DomainRunPlan = z.infer<typeof DomainRunPlan>

export interface ResearchDomain {
  readonly info: DomainInfo
  readonly createTaskSpec: (input: unknown) => JsonRecord
  readonly summarizeTask?: (taskSpec: JsonRecord) => JsonRecord
  readonly buildBaselines: (taskSpec: JsonRecord) => DomainCandidateProposal[]
  readonly rankCandidateProposals?: (input: DomainProposalContext) => DomainCandidateRanking[]
  readonly proposeCandidate?: (input: DomainProposalContext) => DomainCandidateProposal | undefined
  readonly validateCandidate: (input: { taskSpec: JsonRecord; candidateSpec: JsonRecord }) => DomainValidationResult
  readonly evaluateRun?: (input: DomainRunEvaluationContext) => DomainRunEvaluation | undefined
  readonly renderArtifact?: (input: DomainArtifactContext) => DomainArtifactRender | undefined
  readonly createRunPlan: (input: {
    taskSpec: JsonRecord
    candidateSpec: JsonRecord
    stage?: DomainRunStage
    description?: string
  }) => DomainRunPlan
}

export function issue(path: string, message: string, severity: DomainValidationIssue["severity"] = "error") {
  return { path, message, severity }
}
