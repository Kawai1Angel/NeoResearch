# Research Domain Plugin Contract

Research OS domains adapt the generic research loop to a concrete problem family. A domain owns task normalization, candidate generation and validation, run planning, optional run evaluation, and optional artifact rendering. The registry exposes every domain through `ResearchDomain.info` plus normalized capability metadata so callers can discover what a domain can do without hard-coding TSF-specific assumptions.

## DomainInfo and Capability

Each domain exports a `ResearchDomain` with an `info` object:

```ts
const ExampleDomain: ResearchDomain = {
  info: {
    id: "example",
    displayName: "Example Domain",
    version: "0.1.0",
    taskSpecSchemaID: "example.task_spec.v1",
    candidateSpecSchemaID: "example.candidate_spec.v1",
    capability: {
      taskSpecKind: "example.task_spec.v1",
      candidateSpecKind: "example.candidate_spec.v1",
      evaluatorKind: "domain-run-evaluator",
      artifactExporterKind: "domain-artifact-exporter",
      supportsAutonomous: true,
      supportsPrivilegedEvaluation: false,
    },
    actionRegistry: {},
  },
  // ...
}
```

`capability` is optional for backward compatibility. `DomainRegistry.list()` and `DomainRegistry.getInfo()` fill defaults when a domain omits it:

- `taskSpecKind`: defaults to `taskSpecSchemaID`.
- `candidateSpecKind`: defaults to `candidateSpecSchemaID`.
- `evaluatorKind`: defaults to `domain-run-evaluator` when `evaluateRun` exists, otherwise `none`.
- `artifactExporterKind`: defaults to `domain-artifact-exporter` when `renderArtifact` exists, otherwise `none`.
- `supportsAutonomous`: defaults to `true` because `ResearchDomain` requires `createRunPlan`.
- `supportsPrivilegedEvaluation`: defaults to `true` for existing built-in domains. New plugins should declare this explicitly.

## TaskSpec

`createTaskSpec(input)` validates and normalizes user input into a JSON record stored on `ResearchTask.taskSpec`. Keep the shape domain-owned and version it with `taskSpecSchemaID`.

`summarizeTask(taskSpec)` is optional. Use it to produce stable fingerprints for proposal ranking and memory lookup. The output must be a JSON record and should avoid volatile values.

## CandidateSpec

`buildBaselines(taskSpec)` returns the initial candidate proposals. A proposal contains:

- `candidateSpec`: the domain-owned candidate recipe.
- `rationale`: why the candidate should be tried.
- `riskLevel`: `low`, `medium`, or `high`.
- `approvalStatus`: usually `pending`, `approved`, or `auto_approved`.
- `generatedBy`: `llm`, `heuristic`, `mutation`, or `human`.

`validateCandidate({ taskSpec, candidateSpec })` is required and returns `DomainValidationResult`. It should reject invalid candidates and may return `normalizedCandidateSpec` when it can canonicalize a valid candidate.

`rankCandidateProposals(input)` and `proposeCandidate(input)` are optional hooks for autonomous search. They receive task fingerprints, prior candidates, run summaries, domain memory, and the current champion.

## Evaluator

`evaluateRun(input)` is optional. It maps raw run metrics into a domain-level primary metric and utility:

```ts
{
  primaryMetricName: "validation_loss",
  primaryMetric: 0.123,
  direction: "minimize",
  utility: 0.87,
}
```

If omitted, the research service falls back to generic run evaluation. Domains that provide this hook should set or accept the default `evaluatorKind` capability.

## Runner Plan

`createRunPlan(input)` is required. It validates the candidate for a requested stage and returns a `DomainRunPlan`:

- `runnerKind`: currently `subprocess`.
- `approvalRequired`: whether the service must require approval before execution.
- `writes`: JSON files the runner needs before execution.
- `command`: executable, args, optional cwd, and optional env.
- `expectedEvents`, `expectedMetrics`, `expectedArtifacts`: observability contract for the runner.

Domains must keep run plans deterministic for the same task, candidate, and stage.

## Artifact Exporter

`renderArtifact(input)` is optional. It receives the task, candidates, runs, approvals, artifacts, memory, and optional champion. Return a filename, content string, and optional metadata. Domains that provide this hook should set or accept the default `artifactExporterKind` capability.

## Registry Integration

Register domains in `domain-registry.ts` by adding them to the built-in domain list. Registry callers should use `DomainRegistry.list()` or `DomainRegistry.getInfo(domainID)` for discovery because these methods return normalized capability metadata. Use `DomainRegistry.get(domainID)` only when invoking the domain implementation directly.
