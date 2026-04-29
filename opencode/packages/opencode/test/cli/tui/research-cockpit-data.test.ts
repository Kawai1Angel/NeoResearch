import { describe, expect, test } from "bun:test"
import {
  buildDefaultTsfResearchTask,
  buildResearchCockpitStats,
  canExecuteResearchCockpitTask,
  canRunResearchCockpitCandidate,
  formatResearchCockpitArtifactMetadata,
  formatResearchCockpitExport,
  formatResearchCockpitFingerprint,
  formatResearchCockpitIteration,
  formatResearchCockpitLoop,
  formatResearchCockpitMemory,
  formatResearchCockpitMemoryFingerprint,
  formatResearchCockpitProfile,
  formatResearchCockpitRunResult,
  formatResearchCockpitSeedSweep,
  hasApprovedResearchCockpitBlindTestGate,
  hasApprovedResearchCockpitRefTestGate,
  researchCockpitArtifactTarget,
  researchCockpitCandidatePipeline,
  researchCockpitCandidateTitle,
  shouldRefreshResearchCockpitOnEvent,
  sortResearchCockpitTasks,
  type ResearchCockpitApproval,
  type ResearchCockpitArtifact,
  type ResearchCockpitCandidate,
  type ResearchCockpitMemory,
  type ResearchCockpitRun,
  type ResearchCockpitTask,
} from "../../../src/cli/cmd/tui/routes/research-cockpit-data"

const task = (input: Partial<ResearchCockpitTask> & Pick<ResearchCockpitTask, "id">): ResearchCockpitTask => ({
  id: input.id,
  title: input.title ?? input.id,
  domainID: input.domainID ?? "tsf",
  mode: input.mode ?? "review",
  status: input.status ?? "created",
  taskSpec: input.taskSpec ?? {},
  objective: input.objective ?? {},
  budget: input.budget ?? {},
  time: input.time ?? { created: 1, updated: 1 },
})

const candidate = (
  input: Partial<ResearchCockpitCandidate> & Pick<ResearchCockpitCandidate, "id">,
): ResearchCockpitCandidate => ({
  id: input.id,
  taskID: input.taskID ?? "task_a",
  domainID: input.domainID ?? "tsf",
  candidateSpec: input.candidateSpec ?? {},
  rationale: input.rationale ?? "baseline",
  riskLevel: input.riskLevel ?? "low",
  approvalStatus: input.approvalStatus ?? "approved",
  generatedBy: input.generatedBy ?? "heuristic",
  time: input.time ?? { created: 1, updated: 1 },
})

const artifact = (
  input: Partial<ResearchCockpitArtifact> & Pick<ResearchCockpitArtifact, "id">,
): ResearchCockpitArtifact => ({
  id: input.id,
  taskID: input.taskID ?? "task_a",
  runID: input.runID,
  kind: input.kind ?? "research_report_markdown",
  uri: input.uri ?? "file:///tmp/research-report.md",
  metadata: input.metadata ?? {},
  time: input.time ?? { created: 1, updated: 1 },
})

const memory = (input: Partial<ResearchCockpitMemory> & Pick<ResearchCockpitMemory, "id">): ResearchCockpitMemory => ({
  id: input.id,
  taskID: input.taskID ?? "task_a",
  domainID: input.domainID ?? "tsf",
  fingerprintSummary: input.fingerprintSummary ?? {},
  candidateSummary: input.candidateSummary ?? {},
  outcome: input.outcome ?? "accepted",
  lesson: input.lesson ?? "RevIN improved the smoke baseline.",
  time: input.time ?? { created: 1, updated: 1 },
})

describe("research cockpit data helpers", () => {
  test("sorts research tasks by updated time descending", () => {
    const input = [
      task({ id: "task_a", time: { created: 1, updated: 10 } }),
      task({ id: "task_b", time: { created: 1, updated: 20 } }),
    ]

    expect(sortResearchCockpitTasks(input).map((item) => item.id)).toEqual(["task_b", "task_a"])
    expect(input.map((item) => item.id)).toEqual(["task_a", "task_b"])
  })

  test("builds compact cockpit stats", () => {
    const runs: ResearchCockpitRun[] = [
      { id: "run_a", status: "queued", metrics: {}, time: { created: 1, updated: 1 } },
      { id: "run_b", status: "succeeded", metrics: { val_avg_mse: 0.12 }, time: { created: 1, updated: 2 } },
    ]
    const approvals: ResearchCockpitApproval[] = [
      { id: "approval_a", status: "pending", kind: "candidate", reason: "review", time: { created: 1, updated: 1 } },
    ]

    expect(
      buildResearchCockpitStats({
        tasks: [task({ id: "active", status: "researching" }), task({ id: "done", status: "completed" })],
        candidates: [candidate({ id: "candidate_a" })],
        artifacts: [artifact({ id: "artifact_a" })],
        memory: [memory({ id: "memory_a" })],
        runs,
        approvals,
      }),
    ).toEqual({
      taskTotal: 2,
      activeTasks: 1,
      candidateCount: 1,
      artifactCount: 1,
      memoryCount: 1,
      pendingApprovals: 1,
      queuedOrRunningRuns: 1,
      succeededRuns: 1,
    })
  })

  test("creates default TSF task payloads for review and autonomous modes", () => {
    expect(buildDefaultTsfResearchTask("review")).toMatchObject({
      title: "TSF Review Research",
      domainID: "tsf",
      mode: "review",
      objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
    })
    expect(buildDefaultTsfResearchTask("autonomous")).toMatchObject({
      title: "TSF Autonomous Research",
      domainID: "tsf",
      mode: "autonomous",
      budget: { maxRuns: 12, maxParallel: 1 },
    })
  })

  test("uses the selected project as the default Cockpit Neo-Cast runner root", () => {
    expect(buildDefaultTsfResearchTask("autonomous", "/tmp/neo-cast")).toMatchObject({
      taskSpec: {
        runtime: {
          bridgeOnly: true,
          neoCastProjectRoot: "/tmp/neo-cast",
        },
      },
    })
  })

  test("creates Cockpit TSF task payloads with explicit dataset settings", () => {
    expect(
      buildDefaultTsfResearchTask("review", "/tmp/neo-cast", {
        datasetPath: "/data/ETTh1.csv",
        datasetPreset: "etth1",
        targetCols: ["OT", "HUFL"],
        contextLength: 512,
        predictionLengths: [96, 192],
        bridgeOnly: false,
      }),
    ).toMatchObject({
      taskSpec: {
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
      },
    })
  })

  test("formats exported research artifact messages", () => {
    expect(
      formatResearchCockpitExport({
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
    ).toBe("research_report_markdown exported: /tmp/research-report.md")
  })

  test("formats autonomous iteration messages", () => {
    expect(
      formatResearchCockpitIteration({
        candidate: {
          id: "candidate_a",
          taskID: "task_a",
          domainID: "tsf",
          candidateSpec: {},
          rationale: "baseline",
          riskLevel: "low",
          approvalStatus: "auto_approved",
          generatedBy: "heuristic",
          time: { created: 1, updated: 1 },
        },
        seededCandidates: [],
        approvals: [],
        run: { id: "run_a", status: "succeeded", metrics: { val_avg_mse: 0.1234 }, time: { created: 1, updated: 1 } },
        selectionArtifact: artifact({ id: "artifact_selection", kind: "research_candidate_selection_json" }),
      }),
    ).toBe("iteration succeeded / candidate_a / val_avg_mse=0.1234 / selection research_candidate_selection_json")
  })

  test("formats autonomous loop messages", () => {
    expect(
      formatResearchCockpitLoop({
        stoppedReason: "max_iterations",
        iterations: [
          {
            candidate: candidate({ id: "candidate_a" }),
            seededCandidates: [],
            approvals: [],
            run: {
              id: "run_a",
              status: "succeeded",
              metrics: { val_avg_mse: 0.1234 },
              time: { created: 1, updated: 1 },
            },
          },
          {
            candidate: candidate({ id: "candidate_b" }),
            seededCandidates: [],
            approvals: [],
            run: { id: "run_b", status: "failed", metrics: {}, time: { created: 1, updated: 1 } },
          },
        ],
        artifact: artifact({ id: "artifact_loop", kind: "research_autonomous_loop_json" }),
      }),
    ).toBe("loop max_iterations / 2 iterations / 1 succeeded / artifact research_autonomous_loop_json")
  })

  test("summarizes modular candidate recipes for cockpit display", () => {
    const item = candidate({
      id: "candidate_a",
      candidateSpec: {
        recipeID: "recipe_a",
        preprocessing: { actions: [{ type: "normalize" }, { type: "rev_in" }] },
        embedding: { type: "patch" },
        backbone: { type: "tcn" },
        fusion: { type: "concat" },
        predictionHead: { type: "quantile" },
        trainingStrategy: { optimizer: { type: "adamw" } },
      },
    })

    expect(researchCockpitCandidateTitle(item)).toBe("recipe_a")
    expect(researchCockpitCandidatePipeline(item)).toBe("normalize+rev_in / patch / tcn / concat / quantile / adamw")
  })

  test("checks candidate and runner readiness for per-candidate actions", () => {
    expect(canRunResearchCockpitCandidate(candidate({ id: "approved", approvalStatus: "approved" }))).toBe(true)
    expect(canRunResearchCockpitCandidate(candidate({ id: "auto", approvalStatus: "auto_approved" }))).toBe(true)
    expect(canRunResearchCockpitCandidate(candidate({ id: "pending", approvalStatus: "pending" }))).toBe(false)
    expect(canRunResearchCockpitCandidate(candidate({ id: "rejected", approvalStatus: "rejected" }))).toBe(false)
    expect(canExecuteResearchCockpitTask(task({ id: "plain", taskSpec: { runtime: { bridgeOnly: true } } }))).toBe(
      false,
    )
    expect(
      canExecuteResearchCockpitTask(
        task({ id: "runner", taskSpec: { runtime: { neoCastProjectRoot: "/tmp/neo-cast" } } }),
      ),
    ).toBe(true)
  })

  test("detects approved ref test gates per cockpit candidate", () => {
    const approvals: ResearchCockpitApproval[] = [
      {
        id: "candidate_gate",
        candidateID: "candidate_a",
        kind: "candidate",
        status: "approved",
        reason: "candidate approved",
        time: { created: 1, updated: 1 },
      },
      {
        id: "pending_ref_gate",
        candidateID: "candidate_a",
        kind: "ref_test",
        status: "pending",
        reason: "reference test requested",
        time: { created: 1, updated: 1 },
      },
      {
        id: "approved_ref_gate",
        candidateID: "candidate_b",
        kind: "ref_test",
        status: "approved",
        reason: "reference test approved",
        time: { created: 1, updated: 1 },
      },
      {
        id: "approved_blind_gate",
        candidateID: "candidate_c",
        kind: "blind_test",
        status: "approved",
        reason: "blind test approved",
        time: { created: 1, updated: 1 },
      },
    ]

    expect(hasApprovedResearchCockpitRefTestGate(approvals, "candidate_a")).toBe(false)
    expect(hasApprovedResearchCockpitRefTestGate(approvals, "candidate_b")).toBe(true)
    expect(hasApprovedResearchCockpitBlindTestGate(approvals, "candidate_b")).toBe(false)
    expect(hasApprovedResearchCockpitBlindTestGate(approvals, "candidate_c")).toBe(true)
  })

  test("formats prepare and execute result messages", () => {
    expect(
      formatResearchCockpitRunResult({
        run: { id: "run_a", status: "queued", metrics: {}, time: { created: 1, updated: 1 } },
      }),
    ).toBe("run queued / run_a / -")
    expect(
      formatResearchCockpitRunResult({
        run: { id: "run_b", status: "succeeded", metrics: { val_avg_mse: 0.1234 }, time: { created: 1, updated: 1 } },
      }),
    ).toBe("run succeeded / run_b / val_avg_mse=0.1234")
  })

  test("formats cockpit seed sweep results", () => {
    expect(
      formatResearchCockpitSeedSweep({
        seeds: [3, 5],
        runs: [
          {
            run: {
              id: "run_seed_a",
              status: "succeeded",
              stage: "smoke",
              metrics: { val_avg_mse: 0.12 },
              resourceUsage: { seed: 3 },
              time: { created: 1, updated: 1 },
            },
          },
          {
            run: {
              id: "run_seed_b",
              status: "failed",
              stage: "smoke",
              metrics: {},
              resourceUsage: { seed: 5 },
              time: { created: 1, updated: 1 },
            },
          },
        ],
      }),
    ).toBe("seed sweep / 2 runs / 1 succeeded / seeds 3, 5")
  })

  test("formats artifact targets for cockpit display", () => {
    expect(researchCockpitArtifactTarget(artifact({ id: "file", uri: "file:///tmp/report.md" }))).toBe("/tmp/report.md")
    expect(researchCockpitArtifactTarget(artifact({ id: "remote", uri: "https://example.com/report.md" }))).toBe(
      "https://example.com/report.md",
    )
  })

  test("formats candidate selection artifact metadata for cockpit display", () => {
    expect(
      formatResearchCockpitArtifactMetadata(
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
    expect(formatResearchCockpitArtifactMetadata(artifact({ id: "report" }))).toBeUndefined()
  })

  test("formats report experiment analysis metadata for cockpit display", () => {
    expect(
      formatResearchCockpitArtifactMetadata(
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

  test("formats operational artifact metadata for cockpit display", () => {
    expect(
      formatResearchCockpitArtifactMetadata(
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
      formatResearchCockpitArtifactMetadata(
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
      formatResearchCockpitArtifactMetadata(
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
      formatResearchCockpitArtifactMetadata(
        artifact({
          id: "profile",
          kind: "task_profile_json",
          metadata: { profileSource: "domain_fingerprint", hasDatasetProfile: true },
        }),
      ),
    ).toBe("source=domain_fingerprint / dataset_profile=yes")
    expect(
      formatResearchCockpitArtifactMetadata(
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
      formatResearchCockpitArtifactMetadata(
        artifact({
          id: "governance",
          kind: "governance_log_json",
          metadata: { kind: "domain_action", status: "approved", candidateID: "candidate_a" },
        }),
      ),
    ).toBe("approval=domain_action / status=approved / candidate=candidate_a")
  })

  test("formats memory rows for cockpit display", () => {
    const fingerprint = {
      loaderID: "etth1_tslib_v1",
      targetCount: 7,
      contextLength: 96,
      maxPredictionLength: 48,
      horizonContextRatio: 0.5,
      bridgeOnly: true,
    }

    expect(formatResearchCockpitMemory(memory({ id: "memory_a" }))).toBe(
      "accepted / RevIN improved the smoke baseline.",
    )
    expect(formatResearchCockpitFingerprint(fingerprint)).toBe(
      "etth1_tslib_v1 / targets=7 / ctx=96 / horizon=48 / h:c=0.5 / bridge",
    )
    expect(
      formatResearchCockpitMemoryFingerprint(
        memory({
          id: "memory_b",
          fingerprintSummary: fingerprint,
        }),
      ),
    ).toBe("etth1_tslib_v1 / targets=7 / ctx=96 / horizon=48 / h:c=0.5 / bridge")
  })

  test("formats dataset profile rows for cockpit display", () => {
    expect(
      formatResearchCockpitProfile({
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
      formatResearchCockpitProfile({
        datasetProfileWarning: {
          code: "dataset_read_failed",
          path: "/tmp/missing.csv",
          message: "ENOENT",
        },
      }),
    ).toBe("warning=dataset_read_failed")
    expect(formatResearchCockpitProfile({})).toBe("-")
  })

  test("detects research events that should refresh cockpit data", () => {
    expect(shouldRefreshResearchCockpitOnEvent({ type: "research.artifact.created" })).toBe(true)
    expect(shouldRefreshResearchCockpitOnEvent({ type: "research.approval.updated" })).toBe(true)
    expect(shouldRefreshResearchCockpitOnEvent({ type: "message.part.updated" })).toBe(false)
  })
})
