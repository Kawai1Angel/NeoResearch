import { describe, expect, test } from "bun:test"
import {
  buildDefaultTsfResearchTaskInput,
  buildDefaultTsfResearchTaskInputFromGoal,
  formatResearchApprovalsTable,
  formatResearchArtifactsTable,
  formatResearchExport,
  formatResearchAutonomousIteration,
  formatResearchAutonomousLoop,
  formatResearchProfile,
  formatResearchMemoryTable,
  formatResearchRunResult,
  formatResearchSeedSweep,
  formatResearchStatus,
  formatResearchTasksTable,
  pipelineStageForInteractionMode,
} from "../../src/cli/cmd/research-data"
import { Research } from "../../src/research"

const time = { created: 1_700_000_000_000, updated: 1_700_000_060_000 }

const task = (input: Omit<Partial<Research.ResearchTask>, "id"> & { id: string }): Research.ResearchTask =>
  ({
    id: Research.ResearchTaskID.make(input.id),
    projectID: input.projectID ?? ("project_a" as Research.ResearchTask["projectID"]),
    title: input.title ?? input.id,
    domainID: input.domainID ?? "tsf",
    mode: input.mode ?? "review",
    interactionMode: input.interactionMode,
    status: input.status ?? "created",
    taskSpec: input.taskSpec ?? {},
    objective: input.objective ?? {},
    budget: input.budget ?? {},
    time: input.time ?? time,
  }) as Research.ResearchTask

const approval = (
  input: Omit<Partial<Research.ResearchApproval>, "id" | "candidateID"> & { id: string; candidateID?: string },
): Research.ResearchApproval =>
  ({
    id: Research.ResearchApprovalID.make(input.id),
    taskID: input.taskID ?? Research.ResearchTaskID.make("researchTask_a"),
    candidateID: input.candidateID ? Research.ResearchCandidateID.make(input.candidateID) : undefined,
    kind: input.kind ?? "candidate",
    status: input.status ?? "pending",
    reason: input.reason ?? "candidate review",
    time: input.time ?? time,
  }) as Research.ResearchApproval

const artifact = (input: Omit<Partial<Research.ResearchArtifact>, "id"> & { id: string }): Research.ResearchArtifact =>
  ({
    id: Research.ResearchArtifactID.make(input.id),
    taskID: input.taskID ?? Research.ResearchTaskID.make("researchTask_a"),
    runID: input.runID,
    kind: input.kind ?? "research_report_markdown",
    uri: input.uri ?? "file:///tmp/research-report.md",
    metadata: input.metadata ?? {},
    time: input.time ?? time,
  }) as Research.ResearchArtifact

const memory = (input: Omit<Partial<Research.ResearchMemory>, "id"> & { id: string }): Research.ResearchMemory =>
  ({
    id: Research.ResearchMemoryID.make(input.id),
    taskID: input.taskID ?? Research.ResearchTaskID.make("researchTask_a"),
    domainID: input.domainID ?? "tsf",
    fingerprintSummary: input.fingerprintSummary ?? {},
    candidateSummary: input.candidateSummary ?? {},
    outcome: input.outcome ?? "accepted",
    lesson: input.lesson ?? "RevIN improved smoke baseline.",
    time: input.time ?? time,
  }) as Research.ResearchMemory

const candidate = (
  input: Omit<Partial<Research.ResearchCandidate>, "id"> & { id: string },
): Research.ResearchCandidate =>
  ({
    id: Research.ResearchCandidateID.make(input.id),
    taskID: input.taskID ?? Research.ResearchTaskID.make("researchTask_a"),
    domainID: input.domainID ?? "tsf",
    candidateSpec: input.candidateSpec ?? {},
    rationale: input.rationale ?? "baseline",
    riskLevel: input.riskLevel ?? "low",
    approvalStatus: input.approvalStatus ?? "approved",
    generatedBy: input.generatedBy ?? "heuristic",
    time: input.time ?? time,
  }) as Research.ResearchCandidate

const run = (input: Omit<Partial<Research.ResearchRun>, "id"> & { id: string }): Research.ResearchRun =>
  ({
    id: Research.ResearchRunID.make(input.id),
    taskID: input.taskID ?? Research.ResearchTaskID.make("researchTask_a"),
    candidateID:
      "candidateID" in input ? input.candidateID : Research.ResearchCandidateID.make("researchCandidate_a"),
    stage: input.stage ?? "smoke",
    status: input.status ?? "succeeded",
    metrics: input.metrics ?? { val_avg_mse: 0.1234 },
    resourceUsage: input.resourceUsage ?? {},
    artifactRefs: input.artifactRefs ?? [],
    time: input.time ?? time,
  }) as Research.ResearchRun

describe("research CLI data helpers", () => {
  test("builds default TSF create payloads", () => {
    expect(buildDefaultTsfResearchTaskInput({ mode: "review" })).toMatchObject({
      title: "TSF Review Research",
      domainID: "tsf",
      mode: "review",
      objective: {
        primaryMetric: "cv_avg_mse",
        secondaryMetrics: ["cv_std_mse", "val_avg_mse"],
        direction: "minimize",
      },
      budget: { maxRuns: 200, maxParallel: 4, loop: { maxIterations: 25, maxNoImprove: 7 } },
    })
    expect(buildDefaultTsfResearchTaskInput({ mode: "review", interactionMode: "companion" })).toMatchObject({
      mode: "autonomous",
      interactionMode: "companion",
      taskSpec: {
        metadata: { interactionMode: "companion" },
      },
    })
    expect(buildDefaultTsfResearchTaskInput({ mode: "autonomous", title: "Long horizon search" })).toMatchObject({
      title: "Long horizon search",
      mode: "autonomous",
      interactionMode: "socratic",
      taskSpec: {
        contextLength: 336,
        predictionLengths: [96],
        dataset: { loaderID: "etth1_tslib_v1", targetCols: ["OT"] },
        runtime: { bridgeOnly: false },
      },
    })
    expect(buildDefaultTsfResearchTaskInput({
      mode: "autonomous",
      maxIterations: 30,
      maxNoImprove: 6,
    })).toMatchObject({
      budget: { loop: { maxIterations: 30, maxNoImprove: 6 } },
    })
  })

  test("builds TSF create payloads with an explicit Neo-Cast runner root", () => {
    expect(buildDefaultTsfResearchTaskInput({ mode: "autonomous", neoCastProjectRoot: "/tmp/neo-cast" })).toMatchObject(
      {
        taskSpec: {
          runtime: {
            bridgeOnly: false,
            neoCastProjectRoot: "/tmp/neo-cast",
          },
        },
      },
    )
  })

  test("uses the full recipe space and full-run stage for Socratic research", () => {
    expect(
      buildDefaultTsfResearchTaskInputFromGoal({
        goal: "forecast ETTh1 target=OT",
        mode: "autonomous",
        interactionMode: "socratic",
      }),
    ).toMatchObject({
      mode: "autonomous",
      interactionMode: "socratic",
      taskSpec: {
        runtime: { bridgeOnly: false },
        metadata: { interactionMode: "socratic" },
      },
    })
    expect(pipelineStageForInteractionMode("socratic")).toBe("full")
  })

  test("preserves an explicitly requested bridge-only goal", () => {
    expect(
      buildDefaultTsfResearchTaskInputFromGoal({
        goal: "forecast ETTh1 bridge",
        mode: "autonomous",
        interactionMode: "socratic",
      }),
    ).toMatchObject({ taskSpec: { runtime: { bridgeOnly: true } } })
  })

  test("builds TSF create payloads with explicit dataset settings", () => {
    expect(
      buildDefaultTsfResearchTaskInput({
        mode: "review",
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
        },
      },
    })
  })

  test("formats research task rows for CLI tables", () => {
    const output = formatResearchTasksTable([
      task({ id: "researchTask_newer", title: "Newer", mode: "autonomous", status: "researching" }),
      task({ id: "researchTask_older", title: "Older", status: "completed" }),
    ])

    expect(output).toContain("Task ID")
    expect(output).toContain("researchTask_newer")
    expect(output).toContain("autonomous")
    expect(output).toContain("researching")
    expect(output).toContain("Older")
  })

  test("formats approvals for CLI tables", () => {
    const output = formatResearchApprovalsTable([
      approval({ id: "researchApproval_a", candidateID: "researchCandidate_a", status: "pending" }),
    ])

    expect(output).toContain("Approval ID")
    expect(output).toContain("researchApproval_a")
    expect(output).toContain("researchCandidate_a")
    expect(output).toContain("pending")
  })

  test("formats artifacts for CLI tables", () => {
    const output = formatResearchArtifactsTable([
      artifact({
        id: "researchArtifact_report",
        runID: Research.ResearchRunID.make("researchRun_a"),
        metadata: {
          primaryMetricName: "val_avg_mse",
          evaluatedRunCount: 4,
          multiSeedCandidateCount: 1,
          utilityCandidateCount: 2,
          paretoFrontierCount: 2,
        },
      }),
      artifact({
        id: "researchArtifact_selection",
        kind: "research_candidate_selection_json",
        runID: Research.ResearchRunID.make("researchRun_b"),
        metadata: {
          rankPredictorVersion: "tsf_profile_benchmark_memory_ranker_v1",
          selectionSource: "domain_proposal",
          rankingCount: 3,
          historyDomainMemoryCount: 1,
        },
      }),
      artifact({
        id: "researchArtifact_runner_plan",
        kind: "runner_plan_json",
        runID: Research.ResearchRunID.make("researchRun_c"),
        metadata: {
          runnerID: "neo-cast-python",
          runnerKind: "subprocess",
          stage: "smoke",
          candidateID: "cand_a",
        },
      }),
      artifact({
        id: "researchArtifact_runner_log",
        kind: "runner_execution_log_json",
        runID: Research.ResearchRunID.make("researchRun_d"),
        metadata: {
          runnerID: "neo-cast-python",
          stage: "smoke",
          exitCode: 7,
          recordCount: 2,
        },
      }),
    ])

    expect(output).toContain("Artifact ID")
    expect(output).toContain("researchArtifact_report")
    expect(output).toContain("research_report_markdown")
    expect(output).toContain("researchRun_a")
    expect(output).toContain("file:///tmp/research-report.md")
    expect(output).toContain("utility=2")
    expect(output).toContain("ranker=tsf_profile_benchmark_memory_ranker_v1")
    expect(output).toContain("domain_memory=1")
    expect(output).toContain("runner=neo-cast-python")
    expect(output).toContain("candidate=cand_a")
    expect(output).toContain("exit=7")
    expect(output).toContain("records=2")
  })

  test("formats memory for CLI tables", () => {
    const output = formatResearchMemoryTable([memory({ id: "researchMemory_a" })])

    expect(output).toContain("Memory ID")
    expect(output).toContain("researchMemory_a")
    expect(output).toContain("accepted")
    expect(output).toContain("RevIN improved smoke baseline.")
  })

  test("formats task status summary with counts and champion", () => {
    const output = formatResearchStatus({
      task: task({
        id: "researchTask_a",
        title: "TSF experiment",
        status: "researching",
        objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
      }),
      candidates: [
        {
          id: Research.ResearchCandidateID.make("researchCandidate_a"),
          taskID: Research.ResearchTaskID.make("researchTask_a"),
          domainID: "tsf",
          candidateSpec: {},
          rationale: "baseline",
          riskLevel: "low",
          approvalStatus: "approved",
          generatedBy: "heuristic",
          time,
        } as unknown as Research.ResearchCandidate,
      ],
      runs: [
        {
          id: Research.ResearchRunID.make("researchRun_a"),
          taskID: Research.ResearchTaskID.make("researchTask_a"),
          candidateID: Research.ResearchCandidateID.make("researchCandidate_a"),
          stage: "smoke",
          status: "succeeded",
          metrics: { val_avg_mse: 0.1234 },
          resourceUsage: {},
          artifactRefs: [],
          time,
        } as unknown as Research.ResearchRun,
      ],
      approvals: [approval({ id: "researchApproval_a", status: "pending" })],
      artifacts: [artifact({ id: "researchArtifact_report" })],
      memory: [memory({ id: "researchMemory_a" })],
      champion: {
        taskID: Research.ResearchTaskID.make("researchTask_a"),
        candidateID: Research.ResearchCandidateID.make("researchCandidate_a"),
        runID: Research.ResearchRunID.make("researchRun_a"),
        primaryMetric: 0.1234,
        utility: -0.1234,
        acceptedAt: time.updated,
        time,
      } as unknown as Research.ResearchChampion,
    })

    expect(output).toContain("TSF experiment")
    expect(output).toContain("Candidates: 1")
    expect(output).toContain("Runs: 1")
    expect(output).toContain("Artifacts: 1")
    expect(output).toContain("Memory: 1")
    expect(output).toContain("Pending approvals: 1")
    expect(output).toContain("Latest memory: accepted RevIN improved smoke baseline.")
    expect(output).toContain("Champion: researchCandidate_a")
    expect(output).toContain("val_avg_mse=0.1234")
  })

  test("formats exported artifact summary", () => {
    const output = formatResearchExport({
      artifact: artifact({ id: "researchArtifact_report" }),
      path: "/tmp/research-report.md",
    })

    expect(output).toContain("Exported research_report_markdown")
    expect(output).toContain("researchArtifact_report")
    expect(output).toContain("/tmp/research-report.md")
  })

  test("formats task profile artifact summary", () => {
    const output = formatResearchProfile({
      fingerprint: {
        datasetProfile: {
          rowCount: 96,
          targetCount: 3,
          missingRate: 0.003472,
          trendStrength: 0.82,
          seasonalityStrength: 0.91,
          crossVarCorrelation: 0.88,
          distributionShift: 1.12,
        },
      },
      run: run({ id: "researchRun_profile", stage: "profile", status: "succeeded", candidateID: undefined }),
      artifact: artifact({ id: "researchArtifact_profile", kind: "task_profile_json" }),
      path: "/tmp/task-profile.json",
    } as unknown as Research.ProfileTaskResult)

    expect(output).toContain("Profile task_profile_json")
    expect(output).toContain("Run ID: researchRun_profile")
    expect(output).toContain("Artifact ID: researchArtifact_profile")
    expect(output).toContain("Path: /tmp/task-profile.json")
    expect(output).toContain("rows=96")
    expect(output).toContain("xcorr=0.88")
  })

  test("formats run execution summaries", () => {
    const output = formatResearchRunResult({
      run: run({ id: "researchRun_a", status: "succeeded" }),
    })

    expect(output).toContain("Run researchRun_a succeeded")
    expect(output).toContain("Stage: smoke")
    expect(output).toContain("val_avg_mse=0.1234")
  })

  test("formats seed sweep summaries", () => {
    const output = formatResearchSeedSweep({
      seeds: [3, 5],
      runs: [
        { run: run({ id: "researchRun_seed3", status: "succeeded", resourceUsage: { seed: 3 } }) },
        { run: run({ id: "researchRun_seed5", status: "failed", metrics: {}, resourceUsage: { seed: 5 } }) },
      ],
    } as unknown as Research.SeedSweepResult)

    expect(output).toContain("Seed sweep 2 runs")
    expect(output).toContain("Seeds: 3, 5")
    expect(output).toContain("Succeeded: 1")
    expect(output).toContain("Failed: 1")
    expect(output).toContain("researchRun_seed3")
    expect(output).toContain("seed=3")
  })

  test("formats autonomous iteration summaries", () => {
    const output = formatResearchAutonomousIteration({
      run: run({ id: "researchRun_a", status: "succeeded" }),
      candidate: candidate({ id: "researchCandidate_a" }),
      seededCandidates: [candidate({ id: "researchCandidate_seeded" })],
      approvals: [approval({ id: "researchApproval_a", status: "pending" })],
      selectionArtifact: artifact({ id: "researchArtifact_selection", kind: "research_candidate_selection_json" }),
    })

    expect(output).toContain("Autonomous iteration succeeded")
    expect(output).toContain("Candidate ID: researchCandidate_a")
    expect(output).toContain("Seeded candidates: 1")
    expect(output).toContain("Approvals: 1")
    expect(output).toContain("Selection artifact: researchArtifact_selection")
  })

  test("formats autonomous loop summaries", () => {
    const output = formatResearchAutonomousLoop({
      stoppedReason: "max_iterations",
      iterations: [
        {
          run: run({ id: "researchRun_a", status: "succeeded" }),
          candidate: candidate({ id: "researchCandidate_a" }),
          seededCandidates: [],
          approvals: [],
        },
        {
          run: run({ id: "researchRun_b", status: "failed", metrics: {} }),
          candidate: candidate({ id: "researchCandidate_b" }),
          seededCandidates: [],
          approvals: [approval({ id: "researchApproval_b", status: "pending" })],
        },
      ],
      artifact: artifact({ id: "researchArtifact_loop", kind: "research_autonomous_loop_json" }),
    })

    expect(output).toContain("Autonomous loop max_iterations")
    expect(output).toContain("Iterations: 2")
    expect(output).toContain("Succeeded: 1")
    expect(output).toContain("Failed: 1")
    expect(output).toContain("Last candidate: researchCandidate_b")
    expect(output).toContain("Approvals: 1")
    expect(output).toContain("Loop artifact: researchArtifact_loop")
  })
})
