export * from "./schema"
export * from "./domain"
export { Event } from "./event"
export { DomainRegistry } from "./domain-registry"
export { Service, layer, defaultLayer } from "./service"
export type {
  AutonomousIterationResult,
  AutonomousLoopResult,
  Interface,
  ResearchManagerRole,
  ResearchManagerStep,
  ResearchManagerTraceStep,
  RunFullPipelineResult,
  SeedSweepResult,
} from "./service"
export type { IntentAgentResult } from "./agents/intent-agent"
export type { DataAnalysisAgentResult } from "./agents/data-analysis-agent"
export type { NASAgentResult, NASIterationSummary } from "./agents/nas-agent"
export { buildNASAgentResult } from "./agents/nas-agent"
export type { VerifierAgentResult } from "./agents/verifier-agent"
export type { VerifierReport, VerifierResult, VerifierName } from "./verifiers"
export type {
  ReflectionAgentResult,
  ReflectionAnalysis,
  ReflectionDecision,
  ReflectionHypothesis,
} from "./agents/reflection-agent"
export type { PublishAgentResult } from "./agents/publish-agent"
export * as Research from "."
