import { digest } from "../../src/research/execution-contract"
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { tmpdir as osTmpdir } from "os"
import path from "path"

import type { DomainRunPlan } from "../../src/research/domain"
import {
  DEFAULT_FAILURE_RECOVERY_POLICY,
  FileArtifactStoreDriver,
  FileMetricsStoreDriver,
  FileResearchQueueDriver,
  InMemoryResearchQueueDriver,
  createFileResearchRuntime,
  createNoopArtifactStoreDriver,
  createNoopMetricsStoreDriver,
  executeSubprocessResearchJob,
  nextRecoveryAction,
  normalizeArtifactURI,
  researchJobKey,
  researchJobFromRunPlan,
  runResearchWorkerOnce,
} from "../../src/research/runtime"

describe("research runtime skeleton", () => {
  test("retries retryable failed runs until the max attempt count is reached", () => {
    expect(
      nextRecoveryAction({
        policy: DEFAULT_FAILURE_RECOVERY_POLICY,
        attempts: 1,
        status: "failed",
        errorKind: "runner_exit",
      }),
    ).toEqual({ action: "retry", delayMs: 1_000 })

    expect(
      nextRecoveryAction({
        policy: DEFAULT_FAILURE_RECOVERY_POLICY,
        attempts: DEFAULT_FAILURE_RECOVERY_POLICY.maxAttempts,
        status: "failed",
        errorKind: "runner_exit",
      }),
    ).toEqual({ action: "dead_letter", reason: "max_attempts_exceeded" })
  })

  test("does not retry rejected or non retryable failures", () => {
    expect(
      nextRecoveryAction({
        policy: DEFAULT_FAILURE_RECOVERY_POLICY,
        attempts: 1,
        status: "rejected",
        errorKind: "runner_exit",
      }),
    ).toEqual({ action: "discard", reason: "terminal_status" })

    expect(
      nextRecoveryAction({
        policy: DEFAULT_FAILURE_RECOVERY_POLICY,
        attempts: 1,
        status: "failed",
        errorKind: "validation",
      }),
    ).toEqual({ action: "dead_letter", reason: "non_retryable_error" })
  })

  test("normalizes artifact URIs without changing remote object store references", () => {
    expect(normalizeArtifactURI("/tmp/neo-cast/artifacts/run_001")).toBe("file:///tmp/neo-cast/artifacts/run_001")
    expect(normalizeArtifactURI("file:///tmp/neo-cast/artifacts/../artifacts/run_001")).toBe(
      "file:///tmp/neo-cast/artifacts/run_001",
    )
    expect(normalizeArtifactURI("s3://bucket/prefix/run_001/")).toBe("s3://bucket/prefix/run_001")
  })

  test("keeps in-memory queue ordering and attempts stable", async () => {
    const queue = new InMemoryResearchQueueDriver()
    const job = {
      id: "job_001",
      taskID: "rtsk_001",
      runID: "rrun_001",
      domainID: "tsf",
      runnerID: "neo-cast-python",
      stage: "smoke",
      attempt: 1,
      priority: 0,
      createdAt: 10,
      availableAt: 10,
      payload: { command: "rendered elsewhere" },
    } as const

    expect(researchJobKey(job)).toBe("rtsk_001/rrun_001/1")
    await queue.enqueue(job)

    const lease = await queue.lease({ workerID: "worker-a", now: 10 })
    expect(lease?.job).toEqual(job)
    expect(lease?.heartbeat.workerID).toBe("worker-a")
    expect(await queue.lease({ workerID: "worker-b", now: 10 })).toBeUndefined()
    expect((await queue.lease({ workerID: "worker-b", now: 40_010 }))?.heartbeat.workerID).toBe("worker-b")

    await queue.complete(job.id)
    expect(await queue.lease({ workerID: "worker-b", now: 10 })).toBeUndefined()
  })

  test("creates deterministic queue jobs from prepared domain run plans", () => {
    const runPlan: DomainRunPlan = {
      domainID: "tsf",
      runnerID: "neo-cast-python",
      runnerKind: "subprocess",
      stage: "smoke",
      approvalRequired: false,
      validation: { ok: true, issues: [] },
      writes: [],
      command: { executable: "python3", args: ["py/validate.py", "smoke"], cwd: "/tmp/neo-cast" },
      expectedEvents: ["smoke_eval_done"],
      expectedMetrics: ["val_avg_mse"],
      expectedArtifacts: ["runner_artifact"],
    }

    const job = researchJobFromRunPlan({
      taskID: "rtsk_001",
      runID: "rrun_001",
      runPlan,
      priority: 5,
      now: 100,
      availableAt: 200,
    })

    expect(job).toMatchObject({
      id: "rtsk_001/rrun_001/1",
      taskID: "rtsk_001",
      runID: "rrun_001",
      domainID: "tsf",
      runnerID: "neo-cast-python",
      stage: "smoke",
      attempt: 1,
      priority: 5,
      createdAt: 100,
      availableAt: 200,
      payload: runPlan,
    })
  })

  test("noop stores expose production-facing contracts without persistence", async () => {
    const artifacts = createNoopArtifactStoreDriver()
    const metrics = createNoopMetricsStoreDriver()

    expect(await artifacts.put({ uri: "/tmp/run_001", kind: "runner_artifact", metadata: {} })).toEqual({
      uri: "file:///tmp/run_001",
    })
    await expect(
      metrics.recordRunMetrics({ runID: "rrun_001", metrics: { val_avg_mse: 0.1 } }),
    ).resolves.toBeUndefined()
  })

  test("file queue persists jobs, leases, retries, and completions", async () => {
    const root = await mkdtemp(path.join(osTmpdir(), "opencode-runtime-queue-"))
    try {
      const job = {
        id: "rtsk_001/rrun_001/1",
        taskID: "rtsk_001",
        runID: "rrun_001",
        domainID: "tsf",
        runnerID: "neo-cast-python",
        stage: "smoke",
        attempt: 1,
        priority: 10,
        createdAt: 10,
        availableAt: 10,
        payload: { command: "persisted" },
      } as const

      const queue = new FileResearchQueueDriver(root)
      await queue.enqueue(job)
      const lease = await queue.lease({ workerID: "worker-a", now: 10, leaseMs: 100 })

      expect(lease?.job).toEqual(job)
      expect(lease?.heartbeat.leaseExpiresAt).toBe(110)

      const reloaded = new FileResearchQueueDriver(root)
      expect(await reloaded.lease({ workerID: "worker-b", now: 50 })).toBeUndefined()

      const expiredLease = await reloaded.lease({ workerID: "worker-b", now: 111 })
      expect(expiredLease?.heartbeat.workerID).toBe("worker-b")
      await reloaded.fail({ jobID: job.id, error: "transient runner failure", retryAt: 200 })

      expect(await reloaded.lease({ workerID: "worker-c", now: 199 })).toBeUndefined()
      const retryLease = await reloaded.lease({ workerID: "worker-c", now: 200 })
      expect(retryLease?.job.attempt).toBe(2)
      expect(retryLease?.job.availableAt).toBe(200)

      await reloaded.complete(job.id)
      expect(await reloaded.lease({ workerID: "worker-d", now: 300 })).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("file artifact and metrics stores append local audit records", async () => {
    const root = await mkdtemp(path.join(osTmpdir(), "opencode-runtime-stores-"))
    try {
      const artifacts = new FileArtifactStoreDriver(path.join(root, "artifacts"))
      const metrics = new FileMetricsStoreDriver(path.join(root, "metrics"))

      expect(
        await artifacts.put({
          uri: "/tmp/neo-cast/artifacts/run_001",
          kind: "runner_artifact",
          metadata: { stage: "smoke" },
        }),
      ).toEqual({ uri: "file:///tmp/neo-cast/artifacts/run_001" })
      expect(await artifacts.resolve("s3://bucket/prefix/run_001/")).toEqual({ uri: "s3://bucket/prefix/run_001" })

      await metrics.recordRunMetrics({
        runID: "rrun_001",
        metrics: { val_avg_mse: 0.1 },
        resourceUsage: { runtimeSec: 2 },
        recordedAt: 123,
      })
      await metrics.recordWorkerHeartbeat({
        workerID: "worker-a",
        jobID: "job-a",
        status: "running",
        seenAt: 124,
      })

      const artifactRecord = JSON.parse(
        (await readFile(path.join(root, "artifacts", "artifacts.jsonl"), "utf8")).trim(),
      )
      expect(artifactRecord).toMatchObject({
        uri: "file:///tmp/neo-cast/artifacts/run_001",
        kind: "runner_artifact",
        metadata: { stage: "smoke" },
      })

      const metricRecord = JSON.parse((await readFile(path.join(root, "metrics", "run-metrics.jsonl"), "utf8")).trim())
      expect(metricRecord).toMatchObject({
        runID: "rrun_001",
        metrics: { val_avg_mse: 0.1 },
        resourceUsage: { runtimeSec: 2 },
        recordedAt: 123,
      })

      const heartbeatRecord = JSON.parse(
        (await readFile(path.join(root, "metrics", "worker-heartbeats.jsonl"), "utf8")).trim(),
      )
      expect(heartbeatRecord).toMatchObject({
        workerID: "worker-a",
        jobID: "job-a",
        status: "running",
        seenAt: 124,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("worker once completes a leased job and records artifacts and metrics", async () => {
    const root = await mkdtemp(path.join(osTmpdir(), "opencode-runtime-worker-"))
    try {
      const queue = new InMemoryResearchQueueDriver()
      const artifacts = new FileArtifactStoreDriver(path.join(root, "artifacts"))
      const metrics = new FileMetricsStoreDriver(path.join(root, "metrics"))
      const job = {
        id: "job-worker-success",
        taskID: "rtsk_worker",
        runID: "rrun_worker",
        domainID: "tsf",
        runnerID: "neo-cast-python",
        stage: "smoke",
        attempt: 1,
        priority: 0,
        createdAt: 10,
        availableAt: 10,
        payload: { command: "worker" },
      } as const
      await queue.enqueue(job)

      const result = await runResearchWorkerOnce({
        queue,
        artifactStore: artifacts,
        metricsStore: metrics,
        workerID: "worker-a",
        now: 20,
        execute: async (leasedJob) => {
          expect(leasedJob.id).toBe(job.id)
          return {
            status: "succeeded",
            metrics: { val_avg_mse: 0.1 },
            resourceUsage: { runtimeSec: 2 },
            artifacts: [{ uri: "/tmp/neo-cast/artifacts/run_worker", kind: "runner_artifact" }],
          }
        },
      })

      expect(result).toMatchObject({
        status: "completed",
        jobID: job.id,
        artifactURIs: ["file:///tmp/neo-cast/artifacts/run_worker"],
      })
      expect(await queue.lease({ workerID: "worker-b", now: 30 })).toBeUndefined()

      const metricRecord = JSON.parse((await readFile(path.join(root, "metrics", "run-metrics.jsonl"), "utf8")).trim())
      expect(metricRecord).toMatchObject({
        runID: "rrun_worker",
        metrics: { val_avg_mse: 0.1 },
        resourceUsage: { runtimeSec: 2 },
      })
      const heartbeatLines = (await readFile(path.join(root, "metrics", "worker-heartbeats.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(heartbeatLines.map((line) => line.status)).toEqual(["running", "idle"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("worker once schedules retryable failures through the queue policy", async () => {
    const queue = new InMemoryResearchQueueDriver()
    const artifacts = createNoopArtifactStoreDriver()
    const metrics = createNoopMetricsStoreDriver()
    const job = {
      id: "job-worker-retry",
      taskID: "rtsk_retry",
      runID: "rrun_retry",
      domainID: "tsf",
      runnerID: "neo-cast-python",
      stage: "smoke",
      attempt: 1,
      priority: 0,
      createdAt: 10,
      availableAt: 10,
      payload: { command: "worker" },
    } as const
    await queue.enqueue(job)

    const result = await runResearchWorkerOnce({
      queue,
      artifactStore: artifacts,
      metricsStore: metrics,
      workerID: "worker-a",
      now: 20,
      execute: async () => ({
        status: "failed",
        error: "runner exited",
        errorKind: "runner_exit",
      }),
    })

    expect(result).toEqual({
      status: "retry_scheduled",
      jobID: job.id,
      retryAt: 1_020,
      error: "runner exited",
    })
    expect(await queue.lease({ workerID: "worker-b", now: 1_019 })).toBeUndefined()
    expect((await queue.lease({ workerID: "worker-b", now: 1_020 }))?.job.attempt).toBe(2)
  })

  test("subprocess executor materializes plan writes and parses runner events", async () => {
    const root = await mkdtemp(path.join(osTmpdir(), "opencode-runtime-subprocess-"))
    try {
      await mkdir(path.join(root, "py"), { recursive: true })
      const contract = {
        schema_version: "research_execution_contract.v1",
        task_id: "rtsk_subprocess",
        candidate_id: "candidate_a",
        hypothesis_id: "H1",
        candidate_spec_sha256: digest({ recipe_id: "candidate_a" }),
        expected: { backbone: "linear" },
      }
      const manifest = {
        event: "executed_model_manifest",
        candidate_id: contract.candidate_id,
        candidate_spec_sha256: contract.candidate_spec_sha256,
        contract_digest: digest(contract),
        actual: contract.expected,
      }
      const verified = {
        event: "execution_contract_verified",
        status: "verified",
        candidate_id: contract.candidate_id,
        candidate_spec_sha256: contract.candidate_spec_sha256,
        contract_digest: digest(contract),
      }
      await writeFile(
        path.join(root, "py", "validate.py"),
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' '${JSON.stringify(manifest)}' '${JSON.stringify(verified)}'
test -f .neo-cast/current_candidate.json
mkdir -p .neo-cast/artifacts/run_subprocess
printf '{"event":"candidate_resolved"}\\n'
printf '{"event":"smoke_eval_done","val_avg_mse":0.123,"val_avg_mae":0.456}\\n'
printf '{"event":"artifact_ready","artifact_dir":"%s"}\\n' "$(pwd)/.neo-cast/artifacts/run_subprocess"
`,
        "utf8",
      )
      const runPlan: DomainRunPlan = {
        domainID: "tsf",
        runnerID: "neo-cast-python",
        runnerKind: "subprocess",
        stage: "smoke",
        approvalRequired: false,
        validation: { ok: true, issues: [] },
        writes: [
          { path: ".neo-cast/current_candidate.json", content: { recipe_id: "candidate_a" } },
          { path: "contract.json", content: contract },
        ],
        command: {
          executable: "bash",
          args: ["py/validate.py"],
          cwd: root,
          env: { NEO_CAST_EXECUTION_CONTRACT: path.join(root, "contract.json") },
        },
        expectedEvents: ["smoke_eval_done"],
        expectedMetrics: ["val_avg_mse"],
        expectedArtifacts: ["runner_artifact"],
      }
      const job = researchJobFromRunPlan({
        taskID: "rtsk_subprocess",
        runID: "rrun_subprocess",
        runPlan,
        now: 10,
      })

      const result = await executeSubprocessResearchJob(job)

      const bypass = await executeSubprocessResearchJob(
        researchJobFromRunPlan({
          taskID: "rtsk_subprocess",
          runID: "rrun_bypass",
          now: 10,
          runPlan: { ...runPlan, stage: "full", command: { executable: "/no-runner-must-start", args: [] } },
        }),
      )
      expect(bypass.status).toBe("invalid")
      expect(bypass.metrics).toEqual({})
      expect(nextRecoveryAction({ status: "invalid", attempts: 1 })).toEqual({
        action: "discard",
        reason: "terminal_status",
      })
      expect(result).toMatchObject({
        status: "succeeded",
        metrics: { val_avg_mse: 0.123, val_avg_mae: 0.456 },
        resourceUsage: { exitCode: 0, runnerID: "neo-cast-python" },
      })
      expect(result.artifacts?.[0]).toMatchObject({
        kind: "runner_artifact",
        metadata: { runnerID: "neo-cast-python", stage: "smoke" },
      })
      expect(result.artifacts?.[0]?.uri).toStartWith("file://")
      const candidatePayload = JSON.parse(
        await readFile(path.join(root, ".neo-cast", "current_candidate.json"), "utf8"),
      )
      expect(candidatePayload.recipe_id).toBe("candidate_a")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("file runtime factory wires conventional queue artifact and metrics roots", async () => {
    const root = await mkdtemp(path.join(osTmpdir(), "opencode-runtime-factory-"))
    try {
      const runtime = createFileResearchRuntime(root)
      const job = {
        id: "job-factory",
        taskID: "rtsk_factory",
        runID: "rrun_factory",
        domainID: "tsf",
        runnerID: "neo-cast-python",
        stage: "smoke",
        attempt: 1,
        priority: 0,
        createdAt: 10,
        availableAt: 10,
        payload: { command: "factory" },
      } as const

      await runtime.queue.enqueue(job)
      expect((await runtime.queue.lease({ workerID: "worker-a", now: 10 }))?.job.id).toBe(job.id)
      await runtime.artifactStore.put({ uri: "/tmp/run_factory", kind: "runner_artifact" })
      await runtime.metricsStore.recordRunMetrics({ runID: "rrun_factory", metrics: { val_avg_mse: 0.1 } })

      expect(await readFile(path.join(root, "artifacts", "artifacts.jsonl"), "utf8")).toContain("runner_artifact")
      expect(await readFile(path.join(root, "metrics", "run-metrics.jsonl"), "utf8")).toContain("val_avg_mse")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
