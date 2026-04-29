# Research Runtime Skeleton

This document describes the production runtime boundary for OpenCode research runs. The local implementation supports two execution paths: `Research.Service.executeRun` still executes immediately in the OpenCode process for deterministic development tests, while `Research.Service.prepareRun` now also enqueues a file-runtime job that can be consumed by `research worker-once`.

The `src/research/runtime.ts` module provides the contract and local filesystem driver implementations. The file runtime is wired as the first local worker backend; production queue, artifact, and metrics stores can replace the file drivers behind the same interfaces.

## Current Boundary

- `DomainRegistry.createRunPlan(...)` renders a domain-owned runner plan.
- TSF plans target `runnerID: neo-cast-python` and `runnerKind: subprocess`.
- `Research.Service.prepareRun(...)` creates a queued `ResearchRun`, writes `.neo-research/run-plans/<task>/<run>.json`, records it as a `runner_plan_json` artifact, enqueues a `ResearchJob` under `.neo-research/runtime/queue`, and returns the plan.
- `Research.Service.executeRun(...)` immediately executes that plan in the OpenCode process.
- `research worker-once` leases one queued job from `.neo-research/runtime`, executes the same `DomainRunPlan` through `executeSubprocessResearchJob(...)`, records file-runtime artifact and metrics logs, writes a `runner_execution_log_json` artifact, and syncs matching `ResearchRun` rows back to the Research DB.
- `research worker-loop --max-jobs <N>` runs the same worker path repeatedly until it reaches the bounded job count or the queue becomes idle.
- Each execution writes `.neo-research/runner-executions/<task>/<run>.json` and records it as a `runner_execution_log_json` artifact containing exit code, stdout, stderr, and parsed JSONL records.
- Runner output artifacts are stored as `ResearchArtifact` rows with file URIs, usually from runner `artifact_ready` events.
- Metrics are stored on `ResearchRun.metrics` and `ResearchRun.resourceUsage`.

The immediate path remains useful for local development and deterministic integration tests. The worker path separates scheduling, execution, worker heartbeats, retry/dead-letter handling, and DB synchronization enough to exercise the Research OS loop on one machine.

## Runtime Contracts

`runtime.ts` defines production-facing interfaces that can be implemented later without changing domain planning:

- `ResearchJob`: durable queue payload for one prepared run attempt.
- `researchJobFromRunPlan(...)`: deterministic adapter from a prepared `DomainRunPlan` and run identity into a queue job.
- `ResearchQueueDriver`: enqueue, lease, heartbeat, complete, and fail operations. `FileResearchQueueDriver` persists jobs, leases, worker heartbeats, and failure records as JSON files under a local root.
- `ArtifactStoreDriver`: stores or resolves artifact URIs while preserving object-store references. `FileArtifactStoreDriver` appends normalized artifact records to `artifacts.jsonl`.
- `MetricsStoreDriver`: records run metrics and worker heartbeats in an external metrics store. `FileMetricsStoreDriver` appends `run-metrics.jsonl` and `worker-heartbeats.jsonl`.
- `createFileResearchRuntime(root)`: factory for a conventional local runtime layout: `queue/`, `artifacts/`, and `metrics/`.
- `RunnerWorkerHeartbeat`: worker liveness and lease metadata.
- `FailureRecoveryPolicy`: retry/dead-letter decision inputs.
- `runResearchWorkerOnce(...)`: single-lease worker loop helper. It leases one job, records a running heartbeat, invokes an injected executor, records artifacts/metrics, completes successful jobs, and schedules retry/dead-letter handling for failures.
- `executeSubprocessResearchJob(...)`: default executor for `DomainRunPlan` payloads. It materializes plan writes, invokes the configured subprocess command, parses JSONL runner records, returns metrics, and converts `artifact_ready` records into artifact-store inputs.

`InMemoryResearchQueueDriver`, noop artifact store, and noop metrics store are for tests and interface examples only. The file drivers are useful for local worker prototypes and single-host demos; they are not a substitute for a production queue, object store, or metrics database.

## Migration Path

1. Keep `DomainRunPlan` and the persisted `runner_plan_json` artifact as the handoff between research service and runtime.
2. Use `researchJobFromRunPlan(...)` to convert a prepared run into `ResearchJob`.
3. Use `ResearchQueueDriver.enqueue(...)` from `prepareRun(...)`; keep immediate `executeRun(...)` for development parity until worker mode is fully promoted.
4. Run `research worker-once --runtime-root .neo-research/runtime` to consume one local job, or `research worker-loop --runtime-root .neo-research/runtime --max-jobs 10` to drain a bounded batch. The commands use `executeSubprocessResearchJob(...)` as the default executor and sync matching run status, metrics, resource usage, execution logs, and runner artifacts back into the Research DB.
5. Keep worker and immediate execution-log artifacts schema-compatible as production queue/object-store backends replace the local file drivers.
6. Keep governance approval checks in OpenCode before enqueue; workers should treat jobs as already authorized but still record audit metadata.

## Failure Semantics

`DEFAULT_FAILURE_RECOVERY_POLICY` retries transient runner or worker failures up to three attempts with exponential delay. Rejected runs and validation failures are terminal. The local worker keeps retryable runs queued and maps dead-letter jobs back to `ResearchRun.status = "failed"` when a matching DB row exists. Worker attempts preserve stdout, stderr, and parsed JSONL records through `runner_execution_log_json` artifacts.

## Production Gaps

- Production durable queue backend and lease expiry recovery beyond the local file driver.
- Long-running worker supervisor and drain protocol beyond bounded `worker-loop`.
- Production object store implementation for runner artifacts.
- Production metrics database schema and retention policy.
- Cross-service audit correlation IDs for approvals, worker attempts, artifact writes, and privileged evaluations.
- Secret management for runner-side private services.
