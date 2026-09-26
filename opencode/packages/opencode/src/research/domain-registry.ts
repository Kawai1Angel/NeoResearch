import { NotFoundError } from "@/storage"
import {
  type DomainSummaryContext,
  type DomainArtifactContext,
  type DomainCapability,
  type DomainInfo,
  type DomainProposalContext,
  type DomainRunEvaluationContext,
  type DomainRunPlan,
  type DomainRunStage,
  type DomainValidationResult,
  type ResearchDomain,
} from "./domain"
import { TSFDomain } from "./domains/tsf"
import type { JsonRecord } from "./schema"

const BUILTIN_DOMAINS = [TSFDomain] as const satisfies readonly ResearchDomain[]
const BY_ID = new Map<string, ResearchDomain>(BUILTIN_DOMAINS.map((domain) => [domain.info.id, domain]))

function missing(domainID: string) {
  return new NotFoundError({ message: `Research domain not found: ${domainID}` })
}

function defaultCapability(domain: ResearchDomain): DomainCapability {
  return {
    taskSpecKind: domain.info.taskSpecSchemaID,
    candidateSpecKind: domain.info.candidateSpecSchemaID,
    evaluatorKind: domain.evaluateRun ? "domain-run-evaluator" : "none",
    artifactExporterKind: domain.renderArtifact ? "domain-artifact-exporter" : "none",
    supportsAutonomous: true,
    supportsPrivilegedEvaluation: true,
  }
}

function normalizeInfo(domain: ResearchDomain): DomainInfo {
  return {
    ...domain.info,
    capability: domain.info.capability ?? defaultCapability(domain),
  }
}

export function list(): DomainInfo[] {
  return BUILTIN_DOMAINS.map((domain) => normalizeInfo(domain))
}

export function get(domainID: string): ResearchDomain {
  const domain = BY_ID.get(domainID)
  if (!domain) throw missing(domainID)
  return domain
}

export function getInfo(domainID: string): DomainInfo {
  return normalizeInfo(get(domainID))
}

export function createTaskSpec(domainID: string, input: unknown): JsonRecord {
  return get(domainID).createTaskSpec(input)
}

export function summarizeTask(domainID: string, taskSpec: JsonRecord, context?: DomainSummaryContext): JsonRecord {
  return get(domainID).summarizeTask?.(taskSpec, context) ?? {}
}

export function buildBaselines(domainID: string, taskSpec: JsonRecord) {
  return get(domainID).buildBaselines(taskSpec)
}

export function rankCandidateProposals(domainID: string, input: DomainProposalContext) {
  return get(domainID).rankCandidateProposals?.(input) ?? []
}

export function proposeCandidate(domainID: string, input: DomainProposalContext) {
  return get(domainID).proposeCandidate?.(input)
}

export function validateCandidate(
  domainID: string,
  input: { taskSpec: JsonRecord; candidateSpec: JsonRecord },
): DomainValidationResult {
  return get(domainID).validateCandidate(input)
}

export function createRunPlan(
  domainID: string,
  input: {
    taskSpec: JsonRecord
    candidateSpec: JsonRecord
    stage?: DomainRunStage
    description?: string
    runnerRunID?: string
  },
): DomainRunPlan {
  return get(domainID).createRunPlan(input)
}

export function renderArtifact(domainID: string, input: DomainArtifactContext) {
  return get(domainID).renderArtifact?.(input)
}

export function evaluateRun(domainID: string, input: DomainRunEvaluationContext) {
  return get(domainID).evaluateRun?.(input)
}

export * as DomainRegistry from "./domain-registry"
