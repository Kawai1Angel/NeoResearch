import { describe, expect, test } from "bun:test"
import {
  buildDefaultTsfTaskInput,
  buildResearchDashboardStats,
  canExecuteResearchTask,
  formatResearchArtifactMetadataSummary,
  formatResearchArtifactTarget,
  formatResearchExportNotice,
  formatResearchFingerprint,
  formatResearchLoopNotice,
  formatResearchMemoryFingerprint,
  formatResearchMemorySummary,
  formatResearchProfileSummary,
  formatResearchSeedSweepNotice,
  hasApprovedResearchBlindTestGate,
  hasApprovedResearchRefTestGate,
  shouldRefreshResearchDashboardOnEvent,
  sortResearchTasks,
  type ResearchApproval,
  type ResearchArtifact,
  type ResearchCandidate,
  type ResearchMemory,
  type ResearchRun,
  type ResearchTask,
} from "./research-dashboard-data"

const task = (input: Partial<ResearchTask> & Pick<ResearchTask, "id">): ResearchTask => ({
  id: input.id,
  projectID: input.projectID ?? "project_a",
  title: input.title ?? input.id,
  domainID: input.domainID ?? "tsf",
  mode: input.mode ?? "review",
  status: input.status ?? "created",
  taskSpec: input.taskSpec ?? {},
  objective: input.objective ?? {},
  budget: input.budget ?? {},
  time: input.time ?? { created: 1, updated: 1 },
})

const artifact = (input: Partial<ResearchArtifact> & Pick<ResearchArtifact, "id">): ResearchArtifact => ({
  id: input.id,
  taskID: input.taskID ?? "task_a",
  runID: input.runID,
  kind: input.kind ?? "research_report_markdown",
  uri: input.uri ?? "file:///tmp/research-report.md",
  metadata: input.metadata ?? {},
  time: input.time ?? { created: 1, updated: 1 },
})

const memory = (input: Partial<ResearchMemory> & Pick<ResearchMemory, "id">): ResearchMemory => ({
  id: input.id,
  taskID: input.taskID ?? "task_a",
  domainID: input.domainID ?? "tsf",
  fingerprintSummary: input.fingerprintSummary ?? {},
  candidateSummary: input.candidateSummary ?? {},
  outcome: input.outcome ?? "accepted",
  lesson: input.lesson ?? "RevIN improved the smoke baseline.",
  time: input.time ?? { created: 1, updated: 1 },
})

describe("research dashboard data helpers", () => {
  test("sorts tasks by most recent update without mutating the input", () => {
    const tasks = [
      task({ id: "older", time: { created: 10, updated: 20 } }),
      task({ id: "newer", time: { created: 5, updated: 30 } }),
    ]

    const sorted = sortResearchTasks(tasks)

    expect(sorted.map((item) => item.id)).toEqual(["newer", "older"])
    expect(tasks.map((item) => item.id)).toEqual(["older", "newer"])
  })

  test("summarizes task detail counts for the selected task", () => {
    const tasks = [task({ id: "task_a", status: "researching" }), task({ id: "task_b", status: "completed" })]
    const candidates: ResearchCandidate[] = [
      {
        id: "candidate_a",
        taskID: "task_a",
        domainID: "tsf",
        candidateSpec: {},
        rationale: "baseline",
        riskLevel: "low",
        approvalStatus: "approved",
        generatedBy: "heuristic",
        time: { created: 1, updated: 1 },
      },
    ]
    const runs: ResearchRun[] = [
      {
        id: "run_a",
        taskID: "task_a",
        candidateID: "candidate_a",
        stage: "smoke",
        status: "succeeded",
        metrics: {},
        resourceUsage: {},
        artifactRefs: [],
        time: { created: 1, updated: 1 },
      },
      {
        id: "run_b",
        taskID: "task_a",
        candidateID: "candidate_a",
        stage: "smoke",
        status: "running",
        metrics: {},
        resourceUsage: {},
        artifactRefs: [],
        time: { created: 2, updated: 2 },
      },
    ]
    const approvals: ResearchApproval[] = [
      {
        id: "approval_a",
        taskID: "task_a",
        candidateID: "candidate_a",
        kind: "candidate",
        status: "pending",
        reason: "review required",
        time: { created: 1, updated: 1 },
      },
    ]

    const artifacts = [artifact({ id: "artifact_a" })]
    const stats = buildResearchDashboardStats({ tasks, candidates, runs, approvals, artifacts, memoryCount: 2 })

    expect(stats.totalTasks).toBe(2)
    expect(stats.activeTasks).toBe(1)
    expect(stats.candidateCount).toBe(1)
    expect(stats.pendingApprovals).toBe(1)
    expect(stats.runningRuns).toBe(1)
    expect(stats.succeededRuns).toBe(1)
    expect(stats.artifactCount).toBe(1)
    expect(stats.memoryCount).toBe(2)
  })

  test("detects whether a task can execute Neo-Cast runner plans", () => {
    expect(canExecuteResearchTask(task({ id: "plain", taskSpec: { runtime: { bridgeOnly: true } } }))).toBe(false)
    expect(
      canExecuteResearchTask(
        task({
          id: "runner",
          taskSpec: { runtime: { neoCastProjectRoot: "/tmp/neo-cast", pythonExecutable: "python3" } },
        }),
      ),
    ).toBe(true)
  })

  test("detects approved ref test gates per candidate", () => {
    const approvals: ResearchApproval[] = [
      {
        id: "candidate_gate",
        taskID: "task_a",
        candidateID: "candidate_a",
        kind: "candidate",
        status: "approved",
        reason: "candidate approved",
        time: { created: 1, updated: 1 },
      },
      {
        id: "pending_ref_gate",
        taskID: "task_a",
        candidateID: "candidate_a",
        kind: "ref_test",
        status: "pending",
        reason: "reference test requested",
        time: { created: 1, updated: 1 },
      },
      {
        id: "approved_ref_gate",
        taskID: "task_a",
        candidateID: "candidate_b",
        kind: "ref_test",
        status: "approved",
        reason: "reference test approved",
        time: { created: 1, updated: 1 },
      },
      {
        id: "approved_blind_gate",
        taskID: "task_a",
        candidateID: "candidate_c",
        kind: "blind_test",
        status: "approved",
        reason: "blind test approved",
        time: { created: 1, updated: 1 },
      },
    ]

    expect(hasApprovedResearchRefTestGate(approvals, "candidate_a")).toBe(false)
    expect(hasApprovedResearchRefTestGate(approvals, "candidate_b")).toBe(true)
    expect(hasApprovedResearchBlindTestGate(approvals, "candidate_b")).toBe(false)
    expect(hasApprovedResearchBlindTestGate(approvals, "candidate_c")).toBe(true)
  })

  test("builds default TSF task payloads for both interaction modes", () => {
    const review = buildDefaultTsfTaskInput("review")
    const autonomous = buildDefaultTsfTaskInput("autonomous")

    expect(review).toMatchObject({
      title: "TSF Review Research",
      domainID: "tsf",
      mode: "review",
      objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
    })
    expect(autonomous).toMatchObject({
      title: "TSF Autonomous Research",
      domainID: "tsf",
      mode: "autonomous",
      budget: { maxRuns: 12, maxParallel: 1 },
    })
    expect(review.taskSpec).toMatchObject({
      contextLength: 96,
      predictionLengths: [24],
      dataset: { loaderID: "etth1_tslib_v1", targetCols: ["OT"] },
      runtime: { bridgeOnly: true },
    })
  })

  test("adds the selected project as the Neo-Cast runner root when provided", () => {
    const input = buildDefaultTsfTaskInput("autonomous", "/tmp/neo-cast")

    expect(input.taskSpec).toMatchObject({
      runtime: {
        bridgeOnly: true,
        neoCastProjectRoot: "/tmp/neo-cast",
      },
    })
  })

  test("builds default TSF task payloads with explicit dataset settings", () => {
    const input = buildDefaultTsfTaskInput("review", "/tmp/neo-cast", {
      datasetPath: "/data/ETTh1.csv",
      datasetPreset: "etth1",
      targetCols: ["OT", "HUFL"],
      contextLength: 512,
      predictionLengths: [96, 192],
      bridgeOnly: false,
    })

    expect(input.taskSpec).toMatchObject({
      contextLength: 512,
      predictionLengths: [96, 192],
      dataset: {
        loaderID: "etth1",
        path: "/data/ETTh1.csv",
        targetCols: ["OT", "HUFL"],
      },
      runtime: {
        bridgeOnly: false,
        neoCastProjectRoot: "/tmp/neo-cast",
      },
    })
  })

  test("formats exported research artifact notices", () => {
    expect(
      formatResearchExportNotice({
        artifact: {
          id: "artifact_report",
          taskID: "task_a",
          kind: "research_report_markdown",
          uri: "file:///tmp/research-report.md",
          metadata: {},
          time: { created: 1, updated: 1 },
        },
        path: "/tmp/research-report.md",
      }),
    ).toBe("research_report_markdown exported to /tmp/research-report.md")
  })

  test("formats autonomous loop notices", () => {
    const candidate: ResearchCandidate = {
      id: "candidate_b",
      taskID: "task_a",
      domainID: "tsf",
      candidateSpec: {},
      rationale: "mutation",
      riskLevel: "low",
      approvalStatus: "auto_approved",
      generatedBy: "mutation",
      time: { created: 1, updated: 1 },
    }
    const run: ResearchRun = {
      id: "run_b",
      taskID: "task_a",
      candidateID: "candidate_b",
      stage: "smoke",
      status: "succeeded",
      metrics: { val_avg_mse: 0.1234 },
      resourceUsage: {},
      artifactRefs: [],
      time: { created: 1, updated: 1 },
    }

    expect(
      formatResearchLoopNotice({
        stoppedReason: "max_iterations",
        iterations: [
          { candidate, seededCandidates: [], approvals: [], run: { ...run, id: "run_a", status: "failed" } },
          { candidate, seededCandidates: [], approvals: [], run },
        ],
      }),
    ).toBe("loop max_iterations: 2 iterations, 1 succeeded")

    expect(
      formatResearchLoopNotice({
        stoppedReason: "max_iterations",
        iterations: [{ candidate, seededCandidates: [], approvals: [], run }],
        artifact: artifact({ id: "artifact_loop", kind: "research_autonomous_loop_json" }),
      }),
    ).toBe("loop max_iterations: 1 iterations, 1 succeeded, artifact research_autonomous_loop_json")
  })

  test("formats seed sweep notices", () => {
    const run: ResearchRun = {
      id: "run_seed_a",
      taskID: "task_a",
      candidateID: "candidate_a",
      stage: "smoke",
      status: "succeeded",
      metrics: { val_avg_mse: 0.12 },
      resourceUsage: { seed: 3 },
      artifactRefs: [],
      time: { created: 1, updated: 1 },
    }

    expect(
      formatResearchSeedSweepNotice({
        seeds: [3, 5],
        runs: [{ run }, { run: { ...run, id: "run_seed_b", status: "failed", resourceUsage: { seed: 5 } } }],
      }),
    ).toBe("seed sweep: 2 runs, 1 succeeded, seeds 3, 5")
  })

  test("formats artifact targets for display", () => {
    expect(formatResearchArtifactTarget(artifact({ id: "file", uri: "file:///tmp/report.md" }))).toBe("/tmp/report.md")
    expect(formatResearchArtifactTarget(artifact({ id: "remote", uri: "https://example.com/report.md" }))).toBe(
      "https://example.com/report.md",
    )
  })

  test("formats candidate selection artifact metadata for dashboard display", () => {
    expect(
      formatResearchArtifactMetadataSummary(
        artifact({
          id: "selection",
          kind: "research_candidate_selection_json",
          metadata: {
            rankPredictorVersion: "tsf_profile_heuristic_v1",
            rankingCount: 3,
            topScore: 7.2345,
            selectionSource: "domain_proposal",
            historyDomainMemoryCount: 1,
          },
        }),
      ),
    ).toBe(
      "ranker=tsf_profile_heuristic_v1 / source=domain_proposal / rankings=3 / top=7.2345 / domain_memory=1",
    )
    expect(formatResearchArtifactMetadataSummary(artifact({ id: "report" }))).toBeUndefined()
  })

  test("formats report experiment analysis metadata for dashboard display", () => {
    expect(
      formatResearchArtifactMetadataSummary(
        artifact({
          id: "report",
          kind: "research_report_markdown",
          metadata: {
            primaryMetricName: "val_avg_mse",
            evaluatedRunCount: 4,
            multiSeedCandidateCount: 1,
            utilityCandidateCount: 2,
            paretoFrontierCount: 2,
          },
        }),
      ),
    ).toBe("metric=val_avg_mse / runs=4 / multi_seed=1 / utility=2 / pareto=2")
  })

  test("formats operational artifact metadata for dashboard display", () => {
    expect(
      formatResearchArtifactMetadataSummary(
        artifact({
          id: "trace",
          kind: "research_manager_trace_json",
          metadata: {
            stage: "smoke",
            status: "succeeded",
            roleCount: 6,
            roles: ["diagnostic", "design", "coder", "runner", "analyst", "librarian"],
          },
        }),
      ),
    ).toBe("stage=smoke / status=succeeded / roles=6 diagnostic>design>coder>runner>analyst>librarian")
    expect(
      formatResearchArtifactMetadataSummary(
        artifact({
          id: "runner_plan",
          kind: "runner_plan_json",
          metadata: {
            runnerID: "neo-cast-python",
            runnerKind: "subprocess",
            stage: "smoke",
            candidateID: "candidate_a",
          },
        }),
      ),
    ).toBe("runner=neo-cast-python / kind=subprocess / stage=smoke / candidate=candidate_a")
    expect(
      formatResearchArtifactMetadataSummary(
        artifact({
          id: "runner_log",
          kind: "runner_execution_log_json",
          metadata: {
            runnerID: "neo-cast-python",
            stage: "smoke",
            exitCode: 7,
            recordCount: 2,
          },
        }),
      ),
    ).toBe("runner=neo-cast-python / stage=smoke / exit=7 / records=2")
    expect(
      formatResearchArtifactMetadataSummary(
        artifact({
          id: "profile",
          kind: "task_profile_json",
          metadata: { profileSource: "domain_fingerprint", hasDatasetProfile: true },
        }),
      ),
    ).toBe("source=domain_fingerprint / dataset_profile=yes")
    expect(
      formatResearchArtifactMetadataSummary(
        artifact({
          id: "profile_warning",
          kind: "task_profile_json",
          metadata: {
            profileSource: "domain_fingerprint",
            hasDatasetProfile: false,
            profileWarningCode: "dataset_read_failed",
          },
        }),
      ),
    ).toBe("source=domain_fingerprint / dataset_profile=no / warning=dataset_read_failed")
    expect(
      formatResearchArtifactMetadataSummary(
        artifact({
          id: "governance",
          kind: "governance_log_json",
          metadata: { kind: "domain_action", status: "approved", candidateID: "candidate_a" },
        }),
      ),
    ).toBe("approval=domain_action / status=approved / candidate=candidate_a")
  })

  test("formats memory summaries for display", () => {
    const fingerprint = {
      loaderID: "etth1_tslib_v1",
      targetCount: 7,
      contextLength: 96,
      maxPredictionLength: 48,
      horizonContextRatio: 0.5,
      bridgeOnly: false,
    }

    expect(formatResearchMemorySummary(memory({ id: "memory_a" }))).toBe("accepted: RevIN improved the smoke baseline.")
    expect(formatResearchFingerprint(fingerprint)).toBe(
      "etth1_tslib_v1 / targets=7 / ctx=96 / horizon=48 / h:c=0.5 / full",
    )
    expect(
      formatResearchMemoryFingerprint(
        memory({
          id: "memory_b",
          fingerprintSummary: fingerprint,
        }),
      ),
    ).toBe("etth1_tslib_v1 / targets=7 / ctx=96 / horizon=48 / h:c=0.5 / full")
  })

  test("formats dataset profile summaries for dashboard display", () => {
    expect(
      formatResearchProfileSummary({
        datasetProfile: {
          rowCount: 96,
          targetCount: 3,
          missingRate: 0.003472,
          trendStrength: 0.82,
          seasonalityStrength: 0.91,
          crossVarCorrelation: 0.88,
          distributionShift: 1.12,
        },
      }),
    ).toBe("rows=96 / targets=3 / missing=0.003472 / trend=0.82 / seasonal=0.91 / xcorr=0.88 / shift=1.12")
    expect(
      formatResearchProfileSummary({
        datasetProfileWarning: {
          code: "dataset_read_failed",
          path: "/tmp/missing.csv",
          message: "ENOENT",
        },
      }),
    ).toBe("warning=dataset_read_failed")
    expect(formatResearchProfileSummary({})).toBe("-")
  })

  test("detects research events that should refresh dashboard data", () => {
    expect(shouldRefreshResearchDashboardOnEvent({ type: "research.memory.created" })).toBe(true)
    expect(shouldRefreshResearchDashboardOnEvent({ type: "research.run.updated" })).toBe(true)
    expect(shouldRefreshResearchDashboardOnEvent({ type: "session.updated" })).toBe(false)
  })
})
