# Neo-Cast Runtime Deployment Notes

Neo-Cast can be invoked by NeoResearch in two local modes. Immediate mode calls `Research.Service.executeRun(...)`, renders a domain run plan, writes the candidate payload into the configured runtime path, and calls `py/validate.py` or `py/runner.py` in the NeoResearch process. Queue mode calls `Research.Service.prepareRun(...)`, persists the same plan, enqueues a file-runtime job, and lets `research worker-once` lease and execute that job.

This document records the deployment boundary for moving that flow into queue-backed workers. It does not change the Neo-Cast runner CLI.

## Current Local Mode

- NeoResearch owns task, candidate, run, approval, memory, and artifact records.
- NeoResearch persists each prepared `DomainRunPlan` as a `runner_plan_json` artifact before execution, so immediate subprocess and worker execution share the same handoff record.
- NeoResearch enqueues prepared runs into `.neo-research/runtime/queue` for local worker mode.
- NeoResearch persists each runner attempt as a `runner_execution_log_json` artifact with exit code, stdout, stderr, and parsed JSONL records. This gives local subprocess mode and future worker mode the same failure-audit surface.
- Neo-Cast owns candidate resolution, training/evaluation execution, JSONL runner events, and artifact file layout.
- NeoResearch parses runner events such as `candidate_resolved`, `smoke_eval_done`, `artifact_ready`, `ref_test_done`, and `blind_test_done`.
- Artifact references are passed back as local paths and recorded by NeoResearch as `file://` URIs.
- Blind-test scoring remains behind the sidecar protocol described in `blind_test_sidecar.md`.

## Cross-validation Concurrency

Set `NEO_CAST_CV_MAX_PARALLEL_FOLDS=4` in the worker environment to train all four folds concurrently. The runner preserves this setting. Direct `cv_train.py --max-parallel-folds N` takes precedence over the environment; without either setting, concurrency defaults to 1 on CUDA and 4 on CPU. Values must be positive integers.

Each fold uses an independent training process, split overrides, scaler and artifact directory. JSONL output carries `cv_fold_index`, and metrics are aggregated in fold order. The standard fit starts after all folds complete. The `cv_parallelism` event records the selected concurrency.

## Future Worker Mode

The production worker should consume a prepared NeoResearch research job and run the same Neo-Cast commands. The command contract should remain compatible with the current `DomainRunPlan` fields:

- `runnerID`: `neo-cast-python`
- `runnerKind`: currently `subprocess`
- `writes`: files to materialize before invoking Neo-Cast
- `command`: executable, args, cwd, and env
- `expectedEvents`, `expectedMetrics`, `expectedArtifacts`: worker-side validation hints

The worker should not create new research tasks or candidates. It should only execute authorized jobs and report status, metrics, resource usage, artifacts, and logs.

For local worker prototypes, NeoResearch now exposes filesystem runtime drivers:

- `FileResearchQueueDriver`: JSON-file jobs, leases, worker heartbeats, and failure records.
- `FileArtifactStoreDriver`: local `artifacts.jsonl` audit/index for artifact URI records.
- `FileMetricsStoreDriver`: local JSONL metrics and worker heartbeat streams.
- `createFileResearchRuntime(root)`: conventional local runtime layout with `queue/`, `artifacts/`, and `metrics/`.
- `runResearchWorkerOnce(...)`: one-job worker loop helper that leases, executes, records artifacts/metrics, and applies retry/dead-letter policy.
- `executeSubprocessResearchJob(...)`: default `DomainRunPlan` executor for current subprocess-based Neo-Cast commands.
- `research worker-once`: CLI command that runs one local queue job and, when the queued task/run exists in the current NeoResearch project, syncs status, metrics, resource usage, runner execution logs, runner artifacts, champion, and memory back into the Research DB.
- `research worker-loop`: bounded local worker loop for draining multiple file-runtime jobs without an external supervisor.

These drivers make queue-mode experiments possible on one machine without cloud services. They are not the final production backend.

## Deployment Skeleton

1. NeoResearch prepares a run and enqueues a durable job.
2. Worker leases the job and starts heartbeat updates.
3. Worker materializes `writes` into its Neo-Cast workspace.
4. Worker invokes the configured Python command.
5. Worker streams stdout JSONL into metrics/event handling.
6. Worker uploads artifact directories or files into the artifact store.
7. Worker writes the execution-log artifact, records metrics/resource usage, runner artifact URIs, and marks the job complete.
8. On failure, worker preserves stderr/log artifacts and returns the error kind for recovery policy.

## Runtime Resources Needed

- Production durable queue with visibility timeout, dead-letter queue, and idempotent job keys.
- Shared production artifact store reachable by NeoResearch and workers.
- Production metrics database for per-attempt metrics, resource usage, worker heartbeats, and lease timing.
- Worker image or environment with the expected Python runtime and Neo-Cast dependencies.
- Secret injection for blind-test sidecar tokens and private dataset paths.
- Network policy restricting privileged sidecars to authorized worker hosts.
- Log retention for stdout, stderr, resolved candidate payloads, and runner summaries.

## Compatibility Rule

Keep the local subprocess path available until queue mode has parity for smoke, low-fidelity/full, reference test, and blind test stages. The first production migration should wrap the existing commands rather than redesigning Neo-Cast runner arguments.
