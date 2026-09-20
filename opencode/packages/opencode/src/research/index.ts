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
export {
  buildExperimentPlan,
  buildHypoPlanMarkdown,
  buildHypoPlannerResult,
  buildHypothesesYaml,
  extractEvidenceSummary,
  generateHypotheses,
  serializeHypothesisPlanMetadata,
} from "./agents/hypo-planner-agent"
export type { ExperimentPlan, HypoPlannerInput, HypoPlannerResult, HypothesisObject } from "./agents/hypo-planner-agent"
export {
  buildExistingFrontierRankings,
  buildModelDesignerResult,
  buildModelDesignerTaskFingerprint,
  candidateAttemptStateFromRuns,
  selectHypothesisForDesign,
  selectModelDesignerCandidate,
} from "./agents/model-designer-agent"
export type {
  CandidateAttemptState,
  ModelDesignerCandidateSelection,
  ModelDesignerLLMStatus,
  ModelDesignerResult,
  ModelDesignerSelectionSource,
} from "./agents/model-designer-agent"
export { buildModelCompilerResult } from "./agents/model-compiler-agent"
export type { ModelCompilerResult, ModelCompilerStatus } from "./agents/model-compiler-agent"
export { buildTrainEvalResult } from "./agents/train-eval-agent"
export type { TrainEvalResult } from "./agents/train-eval-agent"
export type { NASAgentResult, NASIterationSummary } from "./agents/nas-agent"
export { buildNASAgentResult } from "./agents/nas-agent"
export type { VerifierAgentResult } from "./agents/verifier-agent"
export type { VerifierReport, VerifierResult, VerifierName } from "./verifiers"
export type {
  ReflectionAgentResult,
  ReflectionAnalysis,
  ReflectionDecision,
} from "./agents/reflection-agent"
export type { PublishAgentResult } from "./agents/publish-agent"
export * as Research from "."

export { buildExecutionContract, validateCandidateAgainstHypothesis, verifyExecutionRecords } from "./execution-contract"
export type { ExecutionContract, ContractMismatch, ExecutedModelManifest } from "./execution-contract"
