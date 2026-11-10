import type {
  JsonRecord,
  ResearchArtifact,
  ResearchCandidate,
  ResearchChampion,
  ResearchRun,
  ResearchTask,
  ResearchTaskID,
} from "../schema"
import type { VerifierReport } from "../verifiers"
import { buildEvaluationResultMarkdown, buildVerifierDecisionRecord, runVerifiers } from "../verifiers"

export interface VerifierAgentResult {
  readonly agent: "VerifierAgent"
  readonly taskID: ResearchTaskID
  readonly runID: string
  readonly report: VerifierReport
  readonly evaluationResultMarkdown: string
  readonly verifierDecision: ReturnType<typeof buildVerifierDecisionRecord>
  readonly artifact: ResearchArtifact | undefined
  readonly decisionArtifact: ResearchArtifact | undefined
}

export interface VerifierAgentInput {
  readonly task: ResearchTask
  readonly run: ResearchRun
  readonly candidate: ResearchCandidate | undefined
  readonly previousRuns: readonly ResearchRun[]
  readonly champion: ResearchChampion | undefined
}

export function evaluateRun(input: VerifierAgentInput): VerifierAgentResult {
  const report = runVerifiers({
    task: input.task,
    run: input.run,
    candidate: input.candidate,
    previousRuns: input.previousRuns,
    champion: input.champion,
  })
  const evaluationResultMarkdown = buildEvaluationResultMarkdown({
    task: input.task,
    run: input.run,
    candidate: input.candidate,
    report,
  })
  const verifierDecision = buildVerifierDecisionRecord({
    task: input.task,
    run: input.run,
    candidate: input.candidate,
    report,
  })
  return {
    agent: "VerifierAgent",
    taskID: input.task.id,
    runID: input.run.id,
    report,
    evaluationResultMarkdown,
    verifierDecision,
    artifact: undefined,
    decisionArtifact: undefined,
  }
}

export function verifierAgentMetadata(result: VerifierAgentResult): JsonRecord {
  return {
    accepted: result.report.accepted,
    status: result.report.status,
    rejectReason: result.report.rejectReason ?? null,
    verifierCount: result.report.results.length,
    rejectedVerifiers: result.report.results
      .filter((r) => r.status === "failed")
      .map((r) => r.name),
    failureCategory: result.verifierDecision.failure?.category ?? null,
    recoveryAction: result.verifierDecision.failure?.recoveryAction.type ?? null,
  }
}
