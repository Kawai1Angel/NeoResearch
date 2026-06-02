import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  buildDefaultTsfResearchTaskFromGoal,
  buildDefaultTsfResearchTask,
  buildResearchCockpitAgentWorkflow,
  buildSocraticClarificationState,
  buildResearchCockpitRecommendation,
  buildResearchCockpitStats,
  buildResearchCockpitWorkflow,
  canExecuteResearchCockpitTask,
  canRunResearchCockpitCandidate,
  findBestResearchCockpitMetric,
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
  getResearchCockpitRunnerStatus,
  hasApprovedResearchCockpitBlindTestGate,
  hasApprovedResearchCockpitRefTestGate,
  interactionModeForTask,
  parseTsfCsvTaskInput,
  validateTsfCsvTaskInput,
  researchInteractionModeLabel,
  researchCockpitArtifactTarget,
  researchCockpitCandidatePipeline,
  researchCockpitCandidateTitle,
  resolveResearchCockpitProjectRunnerRoot,
  selectNextBestAction,
  shouldRefreshResearchCockpitOnEvent,
  sortResearchCockpitTasks,
  updateResearchCockpitTaskInteractionMode,
  updateResearchCockpitTaskRunnerRoot,
  type ResearchCockpitApproval,
  type ResearchCockpitArtifact,
  type ResearchCockpitCandidate,
  type ResearchCockpitMemory,
  type ResearchCockpitRun,
  type ResearchCockpitTask,
} from "../../../src/cli/cmd/tui/routes/research-cockpit-data"

async function createNeoCastRunnerRoot(version = "Python 3.12.0") {
  const root = await mkdtemp(path.join(tmpdir(), "research-cockpit-runner-"))
  await mkdir(path.join(root, "py"), { recursive: true })
  await mkdir(path.join(root, ".neo-cast", "runtime", ".venv", "bin"), { recursive: true })
  await writeFile(path.join(root, "py", "validate.py"), "# smoke runner placeholder\n", "utf8")
  const pythonPath = path.join(root, ".neo-cast", "runtime", ".venv", "bin", "python")
  await writeFile(pythonPath, `#!/bin/sh\necho '${version}'\n`, "utf8")
  await chmod(pythonPath, 0o755)
  return root
}

async function createPreparedNeoCastRunnerRoot(spec: Record<string, unknown>, version = "Python 3.12.0") {
  const root = await createNeoCastRunnerRoot(version)
  await mkdir(path.join(root, ".neo-cast"), { recursive: true })
  await writeFile(path.join(root, ".neo-cast", "dataset_spec.json"), `${JSON.stringify(spec, null, 2)}\n`, "utf8")
  return root
}

const task = (input: Partial<ResearchCockpitTask> & Pick<ResearchCockpitTask, "id">): ResearchCockpitTask => ({
  id: input.id,
  title: input.title ?? input.id,
  domainID: input.domainID ?? "tsf",
  mode: input.mode ?? "review",
  interactionMode: input.interactionMode,
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

  test("labels research interaction mode from task metadata or task mode", () => {
    expect(
      researchInteractionModeLabel(
        interactionModeForTask(
          task({
            id: "review_companion",
            mode: "review",
            taskSpec: { metadata: { interactionMode: "companion" } },
          }),
        ),
      ),
    ).toBe("认知伴随")

    expect(researchInteractionModeLabel(interactionModeForTask(task({ id: "auto_default", mode: "autonomous" })))).toBe(
      "苏格拉底",
    )

    expect(
      researchInteractionModeLabel(
        interactionModeForTask(task({ id: "top_level_companion", mode: "autonomous", interactionMode: "companion" })),
      ),
    ).toBe("认知伴随")
  })

  test("updates research interaction mode without changing execution mode", () => {
    const updated = updateResearchCockpitTaskInteractionMode(
      task({
        id: "switch_mode",
        mode: "autonomous",
        interactionMode: "socratic",
        taskSpec: {
          metadata: { interactionMode: "socratic", source: "test" },
          runtime: { bridgeOnly: true },
        },
      }),
      "companion",
    )

    expect(updated.mode).toBe("autonomous")
    expect(updated.interactionMode).toBe("companion")
    expect(updated.taskSpec).toEqual({
      metadata: { interactionMode: "companion", source: "test" },
      runtime: { bridgeOnly: true },
    })
  })

  test("builds an actionable empty cockpit workflow", () => {
    const workflow = buildResearchCockpitWorkflow({
      candidates: [],
      runs: [],
      artifacts: [],
      approvals: [],
      champion: null,
      fingerprint: {},
      runnerReady: false,
    })

    expect(workflow.map((item) => `${item.status}:${item.label}`)).toEqual([
      "active:Create research task",
      "todo:Data Analysis Agent",
      "todo:HypoPlanner Agent",
      "todo:ModelDesigner Agent",
      "todo:ModelCompiler Agent",
      "todo:TrainEval Agent",
      "todo:Reflection Agent",
      "todo:Review gates",
      "todo:Export bundle",
    ])
    expect(
      buildResearchCockpitRecommendation({
        candidates: [],
        runs: [],
        artifacts: [],
        approvals: [],
        champion: null,
        fingerprint: {},
        runnerReady: false,
      }),
    ).toMatchObject({
      action: "create_task",
      title: "Create a dataset-backed TSF task",
    })
  })

  test("builds cockpit workflow from real task state", () => {
    const currentTask = task({
      id: "task_a",
      mode: "autonomous",
      taskSpec: {
        runtime: { neoCastProjectRoot: "/tmp/neo-cast" },
        metadata: {
          hypothesisPlan: {
            hypotheses: [{ id: "H1" }, { id: "H2" }, { id: "H3" }],
            baselineStrategy: "domain_baselines_first",
            searchBiases: ["seasonal"],
            stopConditions: { maxTrials: 12, noImprovementRounds: 3 },
          },
        },
      },
      budget: { maxRuns: 12 },
    })
    const workflow = buildResearchCockpitWorkflow({
      task: currentTask,
      candidates: [candidate({ id: "candidate_a" })],
      runs: [
        {
          id: "profile_run",
          stage: "profile",
          status: "succeeded",
          metrics: {},
          time: { created: 1, updated: 1 },
        },
        {
          id: "smoke_run",
          stage: "smoke",
          status: "succeeded",
          metrics: { val_avg_mse: 0.12 },
          time: { created: 1, updated: 2 },
        },
        {
          id: "train_run",
          stage: "low_fidelity",
          status: "succeeded",
          metrics: { val_avg_mse: 0.1 },
          time: { created: 1, updated: 3 },
        },
      ],
      artifacts: [
        artifact({ id: "profile_artifact", kind: "task_profile_json" }),
        artifact({ id: "compile_artifact", kind: "model_compile_report_md" }),
      ],
      approvals: [],
      champion: null,
      fingerprint: { datasetProfile: { rowCount: 100 } },
      runnerReady: true,
    })

    expect(workflow.map((item) => `${item.status}:${item.label}`)).toEqual([
      "done:Create research task",
      "done:Data Analysis Agent",
      "done:HypoPlanner Agent",
      "done:ModelDesigner Agent",
      "done:ModelCompiler Agent",
      "done:TrainEval Agent",
      "active:Reflection Agent",
      "done:Review gates",
      "active:Export bundle",
    ])
    expect(
      buildResearchCockpitRecommendation({
        task: currentTask,
        candidates: [candidate({ id: "candidate_a" })],
        runs: [{ id: "smoke_run", stage: "smoke", status: "succeeded", metrics: {}, time: { created: 1, updated: 1 } }],
        artifacts: [artifact({ id: "profile_artifact", kind: "task_profile_json" })],
        approvals: [],
        champion: null,
        fingerprint: { datasetProfile: { rowCount: 100 } },
        runnerReady: true,
      }),
    ).toMatchObject({
      action: "run_autonomous_loop",
      title: "Run autonomous loop",
    })
  })

  test("keeps smoke experiments pending until the dataset profile exists", () => {
    const currentTask = task({
      id: "task_without_profile",
      mode: "autonomous",
      taskSpec: { runtime: { neoCastProjectRoot: "/tmp/neo-cast" } },
      budget: { maxRuns: 12 },
    })
    const workflow = buildResearchCockpitWorkflow({
      task: currentTask,
      candidates: [candidate({ id: "candidate_a" })],
      runs: [],
      artifacts: [],
      approvals: [],
      champion: null,
      fingerprint: {},
      runnerReady: true,
    })

    expect(workflow.map((item) => `${item.status}:${item.label}`)).toEqual([
      "done:Create research task",
      "active:Data Analysis Agent",
      "todo:HypoPlanner Agent",
      "todo:ModelDesigner Agent",
      "todo:ModelCompiler Agent",
      "todo:TrainEval Agent",
      "todo:Reflection Agent",
      "todo:Review gates",
      "todo:Export bundle",
    ])
  })

  test("keeps Data Analysis pending until the intent checkpoint is approved", () => {
    const currentTask = task({
      id: "task_intent_pending",
      mode: "autonomous",
      interactionMode: "companion",
      taskSpec: {
        dataset: { path: "/tmp/electricity.csv", targetCols: ["OT"] },
        contextLength: 96,
        predictionLengths: [24],
        metadata: { interactionMode: "companion" },
        runtime: { neoCastProjectRoot: "/tmp/neo-cast" },
      },
      objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
      budget: { maxRuns: 12 },
    })
    const input = {
      task: currentTask,
      candidates: [],
      runs: [],
      artifacts: [],
      approvals: [],
      champion: null,
      fingerprint: {},
      runnerReady: true,
    }

    expect(buildResearchCockpitWorkflow(input).map((item) => `${item.status}:${item.label}`)).toEqual([
      "done:Create research task",
      "todo:Data Analysis Agent",
      "todo:HypoPlanner Agent",
      "todo:ModelDesigner Agent",
      "todo:ModelCompiler Agent",
      "todo:TrainEval Agent",
      "todo:Reflection Agent",
      "todo:Review gates",
      "todo:Export bundle",
    ])
    expect(buildResearchCockpitRecommendation(input)).toMatchObject({
      action: "confirm_intent",
      title: "Confirm requirements",
    })
  })

  test("activates Data Analysis after the intent checkpoint is approved", () => {
    const currentTask = task({
      id: "task_intent_approved",
      mode: "autonomous",
      interactionMode: "companion",
      taskSpec: {
        dataset: { path: "/tmp/electricity.csv", targetCols: ["OT"] },
        contextLength: 96,
        predictionLengths: [24],
        metadata: { interactionMode: "companion" },
        runtime: { neoCastProjectRoot: "/tmp/neo-cast" },
      },
      objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
      budget: { maxRuns: 12 },
    })
    const input = {
      task: currentTask,
      candidates: [],
      runs: [],
      artifacts: [],
      approvals: [
        {
          id: "approval_intent",
          kind: "protocol" as const,
          status: "approved" as const,
          reason: "[checkpoint:intent_confirmed]\n需求交流已确认。",
          time: { created: 1, updated: 1 },
        },
      ],
      champion: null,
      fingerprint: {},
      runnerReady: true,
    }

    expect(buildResearchCockpitWorkflow(input).map((item) => `${item.status}:${item.label}`)).toContain(
      "active:Data Analysis Agent",
    )
    expect(buildResearchCockpitRecommendation(input)).toMatchObject({
      action: "profile",
      title: "Profile dataset",
    })
  })

  test("selects one next best action from cockpit state priority", () => {
    const currentTask = task({
      id: "task_nba",
      mode: "autonomous",
      taskSpec: {
        runtime: { neoCastProjectRoot: "/tmp/neo-cast" },
        dataset: { path: "/tmp/electricity.csv", targetCols: ["OT"] },
        contextLength: 96,
        predictionLengths: [24],
      },
      budget: { maxRuns: 12 },
    })

    expect(
      selectNextBestAction({
        task: currentTask,
        candidates: [],
        runs: [],
        artifacts: [],
        approvals: [],
        champion: null,
        fingerprint: {},
        runnerReady: false,
        runnerRepairAction: "prepare_dataset",
      }),
    ).toMatchObject({
      command: "/dataset prepare",
      title: "Prepare dataset",
    })

    expect(
      selectNextBestAction({
        task: currentTask,
        candidates: [],
        runs: [],
        artifacts: [],
        approvals: [],
        champion: null,
        fingerprint: {},
        runnerReady: false,
        runnerRepairAction: "configure_runner",
      }),
    ).toMatchObject({
      command: "/runner check",
      title: "Check runner",
    })

    expect(
      selectNextBestAction({
        task: currentTask,
        candidates: [],
        runs: [{ id: "profile_run", stage: "profile", status: "succeeded", metrics: {}, time: { created: 1, updated: 1 } }],
        artifacts: [artifact({ id: "profile_artifact", kind: "task_profile_json" })],
        approvals: [
          {
            id: "approval_intent",
            kind: "protocol",
            status: "approved",
            reason: "[checkpoint:intent_confirmed]\n需求交流已确认。",
            time: { created: 1, updated: 1 },
          },
        ],
        champion: null,
        fingerprint: { datasetProfile: { rowCount: 100 } },
        runnerReady: true,
      }),
    ).toMatchObject({
      command: "/seed",
      title: "Seed baselines",
    })
  })

  test("hides next best action while a run is queued or running", () => {
    expect(
      selectNextBestAction({
        task: task({ id: "task_running", mode: "autonomous" }),
        candidates: [candidate({ id: "candidate_running" })],
        runs: [{ id: "run_running", stage: "smoke", status: "running", metrics: {}, time: { created: 1, updated: 1 } }],
        artifacts: [artifact({ id: "profile_artifact", kind: "task_profile_json" })],
        approvals: [],
        champion: null,
        fingerprint: { datasetProfile: { rowCount: 100 } },
        runnerReady: true,
      }),
    ).toBeNull()
  })

  test("keeps planning and design agents pending while the runner dataset needs repair", () => {
    const currentTask = task({
      id: "task_dataset_repair",
      mode: "autonomous",
      taskSpec: { runtime: { neoCastProjectRoot: "/tmp/neo-cast" } },
      budget: { maxRuns: 12 },
    })

    const workflow = buildResearchCockpitAgentWorkflow({
      task: currentTask,
      candidates: [],
      runs: [],
      artifacts: [],
      approvals: [],
      champion: null,
      fingerprint: { datasetProfile: { rowCount: 69680, targetCount: 1 } },
      runnerReady: false,
      runnerRepairAction: "prepare_dataset",
    })

    expect(workflow.map((item) => `${item.status}:${item.displayLabel ?? item.label}`)).toEqual([
      "todo:HypoPlanner Agent",
      "todo:ModelDesigner Agent",
      "todo:ModelCompiler Agent",
      "todo:TrainEval Agent",
      "todo:Reflection Agent",
    ])
  })

  test("keeps HypoPlanner pending while requirements confirmation is pending", () => {
    const workflow = buildResearchCockpitAgentWorkflow({
      task: task({
        id: "task_requirements_pending",
        mode: "autonomous",
        taskSpec: { runtime: { neoCastProjectRoot: "/tmp/neo-cast" } },
        budget: { maxRuns: 12 },
      }),
      candidates: [],
      runs: [{ id: "profile_run", stage: "profile", status: "succeeded", metrics: {}, time: { created: 1, updated: 1 } }],
      artifacts: [artifact({ id: "profile_artifact", kind: "task_profile_json" })],
      approvals: [
        {
          id: "approval_requirements",
          kind: "protocol",
          status: "pending",
          reason: "[checkpoint:requirements_confirmed]\n确认需求后再进入 HypoPlanner。",
          time: { created: 1, updated: 1 },
        },
      ],
      champion: null,
      fingerprint: { datasetProfile: { rowCount: 100 } },
      runnerReady: true,
    })

    expect(workflow.map((item) => `${item.status}:${item.label}`)).toContain("todo:HypoPlanner Agent")
  })

  test("activates HypoPlanner after requirements confirmation is approved", () => {
    const workflow = buildResearchCockpitAgentWorkflow({
      task: task({
        id: "task_requirements_approved",
        mode: "autonomous",
        taskSpec: { runtime: { neoCastProjectRoot: "/tmp/neo-cast" } },
        budget: { maxRuns: 12 },
      }),
      candidates: [],
      runs: [{ id: "profile_run", stage: "profile", status: "succeeded", metrics: {}, time: { created: 1, updated: 1 } }],
      artifacts: [artifact({ id: "profile_artifact", kind: "task_profile_json" })],
      approvals: [
        {
          id: "approval_requirements",
          kind: "protocol",
          status: "approved",
          reason: "[checkpoint:requirements_confirmed]\n确认需求后再进入 HypoPlanner。",
          time: { created: 1, updated: 1 },
        },
      ],
      champion: null,
      fingerprint: { datasetProfile: { rowCount: 100 } },
      runnerReady: true,
    })

    expect(workflow.map((item) => `${item.status}:${item.label}`)).toContain("active:HypoPlanner Agent")
  })

  test("marks Reflection Agent done when reflection notes are available", () => {
    const workflow = buildResearchCockpitAgentWorkflow({
      task: task({
        id: "task_reflection_done",
        mode: "autonomous",
        taskSpec: { runtime: { neoCastProjectRoot: "/tmp/neo-cast" } },
        budget: { maxRuns: 12 },
      }),
      candidates: [candidate({ id: "candidate_a" })],
      runs: [
        { id: "profile_run", stage: "profile", status: "succeeded", metrics: {}, time: { created: 1, updated: 1 } },
        {
          id: "train_run",
          stage: "low_fidelity",
          status: "succeeded",
          metrics: { val_avg_mse: 0.1 },
          time: { created: 1, updated: 2 },
        },
      ],
      artifacts: [
        artifact({ id: "profile_artifact", kind: "task_profile_json" }),
        artifact({ id: "reflection_artifact", kind: "reflection_notes_md" }),
      ],
      approvals: [],
      champion: null,
      fingerprint: { datasetProfile: { rowCount: 100 } },
      runnerReady: true,
    })

    expect(workflow.map((item) => `${item.status}:${item.label}`)).toContain("done:Reflection Agent")
  })


  test("creates default TSF task payloads for review and autonomous modes", () => {
    const reviewTask = buildDefaultTsfResearchTask("review")
    const autonomousTask = buildDefaultTsfResearchTask("autonomous")
    const companionTask = buildDefaultTsfResearchTask("review", undefined, { interactionMode: "companion" })

    expect(reviewTask).toMatchObject({
      title: "TSF Review Research",
      domainID: "tsf",
      mode: "review",
      taskSpec: {
        contextLength: 96,
        predictionLengths: [24],
        dataset: {
          loaderID: "etth1_tslib_v1",
          targetCols: ["OT"],
        },
        runtime: {
          bridgeOnly: true,
        },
        metadata: { interactionMode: "companion" },
      },
      objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
    })
    expect(autonomousTask).toMatchObject({
      title: "TSF Autonomous Research",
      domainID: "tsf",
      mode: "autonomous",
      interactionMode: "socratic",
      taskSpec: {
        contextLength: 96,
        predictionLengths: [24],
        dataset: {
          loaderID: "etth1_tslib_v1",
          targetCols: ["OT"],
        },
        runtime: {
          bridgeOnly: true,
        },
        metadata: { interactionMode: "socratic" },
      },
      budget: { maxRuns: 12, maxParallel: 1 },
    })
    expect(companionTask).toMatchObject({
      mode: "autonomous",
      interactionMode: "companion",
      taskSpec: {
        metadata: { interactionMode: "companion" },
      },
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

  test("resolves a nested neo_cast project runner root before the workspace root", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "neo-research-workspace-"))
    await mkdir(path.join(workspace, "neo_cast", "py"), { recursive: true })
    await writeFile(path.join(workspace, "neo_cast", "py", "validate.py"), "# runner\n", "utf8")

    expect(resolveResearchCockpitProjectRunnerRoot(workspace)).toBe(path.join(workspace, "neo_cast"))
  })

  test("resolves a sibling neo_cast runner when the selected project is opencode", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "neo-research-workspace-"))
    const opencodeRoot = path.join(workspace, "opencode")
    await mkdir(opencodeRoot, { recursive: true })
    await mkdir(path.join(workspace, "neo_cast", "py"), { recursive: true })
    await writeFile(path.join(workspace, "neo_cast", "py", "validate.py"), "# runner\n", "utf8")

    expect(resolveResearchCockpitProjectRunnerRoot(opencodeRoot)).toBe(path.join(workspace, "neo_cast"))
  })

  test("resolves an ancestor neo_cast runner when the selected project is a nested package", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "neo-research-workspace-"))
    const packageRoot = path.join(workspace, "opencode", "packages", "opencode")
    await mkdir(packageRoot, { recursive: true })
    await mkdir(path.join(workspace, "neo_cast", "py"), { recursive: true })
    await writeFile(path.join(workspace, "neo_cast", "py", "validate.py"), "# runner\n", "utf8")

    expect(resolveResearchCockpitProjectRunnerRoot(packageRoot)).toBe(path.join(workspace, "neo_cast"))
  })

  test("saves or updates the Cockpit Neo-Cast runner root on task runtime", () => {
    const repaired = updateResearchCockpitTaskRunnerRoot(
      task({
        id: "missing_runner",
        taskSpec: {
          dataset: { loaderID: "etth1", targetCols: ["OT"] },
          runtime: { bridgeOnly: true },
        },
      }),
      "  /tmp/neo-cast  ",
    )

    expect(repaired.taskSpec).toEqual({
      dataset: { loaderID: "etth1", targetCols: ["OT"] },
      runtime: { bridgeOnly: true, neoCastProjectRoot: "/tmp/neo-cast" },
    })
    expect(canExecuteResearchCockpitTask(repaired)).toBe(true)

    const updated = updateResearchCockpitTaskRunnerRoot(
      task({
        id: "old_runner",
        taskSpec: {
          runtime: {
            bridgeOnly: false,
            neoCastProjectRoot: "/tmp/old-neo-cast",
          },
        },
      }),
      "/tmp/new-neo-cast",
    )

    expect(updated.taskSpec.runtime).toEqual({
      bridgeOnly: false,
      neoCastProjectRoot: "/tmp/new-neo-cast",
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

  test("creates Cockpit TSF task payloads by extracting structured fields from a research goal", () => {
    const payload = buildDefaultTsfResearchTaskFromGoal(
      "Forecast /data/ETTh1.csv target=OT,HUFL horizon=96,192 context=512 preset=etth1 full max-runs=5 time=120",
      "autonomous",
      "/tmp/neo-cast",
    )

    expect(payload.title).toBe("Forecast ETTh1 horizon 96,192")
    expect(payload.taskSpec).toMatchObject({
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
      constraints: {
        maxTrainingSeconds: 120,
        maxTrials: 5,
      },
      metadata: {
        interactionMode: "socratic",
        userPrompt:
          "Forecast /data/ETTh1.csv target=OT,HUFL horizon=96,192 context=512 preset=etth1 full max-runs=5 time=120",
      },
    })
    expect(payload.budget).toMatchObject({
      maxRuns: 5,
      maxParallel: 1,
      loop: {
        timeBudgetSeconds: 120,
      },
    })
  })

  test("requires the prepared Neo-Cast dataset spec to match the selected task before execution", async () => {
    const root = await createPreparedNeoCastRunnerRoot({
      schema_version: "dataset.v1",
      source_csv: "/data/other.csv",
      task_id: "etth1",
      timestamp_col: "date",
      feature_columns: ["OT"],
      input_len: 96,
      horizons: [48],
      splits: { train: [0, 100], val: [100, 140], ref_test: [140, 180] },
      normalization: { type: "standard", fit_split: "train" },
      missing: { strategy: "forward_fill", limit: null },
      time: { frequency: "auto", allow_irregular: true, irregular_ratio_warn: 0.01 },
    })

    const status = canExecuteResearchCockpitTask(
      task({
        id: "dataset_mismatch",
        taskSpec: {
          contextLength: 96,
          predictionLengths: [24],
          dataset: { path: "/data/ETTh1.csv", targetCols: ["OT"] },
          runtime: { neoCastProjectRoot: root },
        },
      }),
      { validateRuntime: true },
    )

    expect(status).toBe(false)
  })

  test("accepts a matching dataset cache spec when the project root spec is stale", async () => {
    const root = await createPreparedNeoCastRunnerRoot({
      schema_version: "dataset.v1",
      source_csv: "/data/old.csv",
      task_id: "etth1",
      timestamp_col: "date",
      feature_columns: ["OT"],
      input_len: 512,
      horizons: [96, 192, 336, 720],
      splits: { train: [0, 1000], val: [1000, 1200], ref_test: [1200, 1400] },
      normalization: { type: "standard", fit_split: "train" },
      missing: { strategy: "forward_fill", limit: null },
      time: { frequency: "auto", allow_irregular: true, irregular_ratio_warn: 0.01 },
    })
    await mkdir(path.join(root, ".neo-cast", "dataset"), { recursive: true })
    await writeFile(
      path.join(root, ".neo-cast", "dataset", "dataset_spec.json"),
      `${JSON.stringify(
        {
          schema_version: "dataset.v1",
          source_csv: "/data/ETTh1.csv",
          task_id: "etth1",
          timestamp_col: "date",
          feature_columns: ["OT"],
          input_len: 96,
          horizons: [24],
          splits: { train: [0, 1000], val: [1000, 1200], ref_test: [1200, 1400] },
          normalization: { type: "standard", fit_split: "train" },
          missing: { strategy: "forward_fill", limit: null },
          time: { frequency: "auto", allow_irregular: true, irregular_ratio_warn: 0.01 },
        },
        null,
        2,
      )}\n`,
      "utf8",
    )

    const status = getResearchCockpitRunnerStatus(
      task({
        id: "dataset_cache_matches",
        taskSpec: {
          contextLength: 96,
          predictionLengths: [24],
          dataset: { path: "/data/ETTh1.csv", targetCols: ["OT"] },
          runtime: { neoCastProjectRoot: root },
        },
      }),
      { validateRuntime: true },
    )

    expect(status.reason).toBe("ready")
  })

  test("parses CSV task dialog input with forecasting options", () => {
    expect(parseTsfCsvTaskInput("/data/ETTh1.csv target=OT,HUFL horizon=24,48 context=192 preset=etth1 full")).toEqual({
      datasetPath: "/data/ETTh1.csv",
      targetCols: ["OT", "HUFL"],
      predictionLengths: [24, 48],
      contextLength: 192,
      datasetPreset: "etth1",
      bridgeOnly: false,
    })
    expect(parseTsfCsvTaskInput("   ")).toBeUndefined()
  })

  test("validates CSV task input before creating tasks", () => {
    expect(validateTsfCsvTaskInput("")).toEqual(["Enter a CSV dataset path."])
    expect(validateTsfCsvTaskInput("/tmp/missing.txt")).toContain("Dataset path must point to a .csv file.")
    expect(validateTsfCsvTaskInput("/tmp/missing.csv horizon=abc context=0 time=bad")).toEqual([
      "Dataset file does not exist: /tmp/missing.csv",
      "horizon must be a positive integer list.",
      "context must be a positive integer.",
      "time must be a positive duration like 30s, 5m, or 1h.",
    ])
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
    expect(
      formatResearchCockpitExport({
        artifact: artifact({
          id: "artifact_export",
          kind: "model_export_package",
          metadata: {
            championCandidateID: "candidate_best",
            primaryMetricName: "val_avg_mse",
            primaryMetricValue: 0.123456,
            copiedFiles: ["README.md", "requirements.txt", "mcp_server.py"],
          },
        }),
        path: "/tmp/pkg",
      }),
    ).toBe(
      "model_export_package exported: /tmp/pkg / champion=candidate_best / val_avg_mse=0.123456 / files=README.md, requirements.txt, mcp_server.py",
    )
    expect(
      formatResearchCockpitExport({
        artifact: artifact({
          id: "artifact_bundle",
          kind: "research_final_bundle",
          metadata: {
            championCandidateID: "candidate_best",
            primaryMetricName: "val_avg_mse",
            primaryMetricValue: 0.08123,
            runCount: 7,
            candidateCount: 5,
            reportPath: "/tmp/final/report.md",
            manifestPath: "/tmp/final/manifest.json",
          },
        }),
        path: "/tmp/final",
      }),
    ).toBe(
      "research_final_bundle exported: /tmp/final / champion=candidate_best / val_avg_mse=0.08123 / runs=7 / candidates=5 / report=/tmp/final/report.md / manifest=/tmp/final/manifest.json",
    )
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
    ).toBe(
      "loop stopped: reached max iterations / 2 iterations / 1 succeeded / 1 failed / selected candidate_a / val_avg_mse=0.1234 / artifact research_autonomous_loop_json",
    )
    expect(
      formatResearchCockpitLoop({
        stoppedReason: "approval_required",
        iterations: [
          {
            candidate: candidate({ id: "candidate_pending" }),
            seededCandidates: [candidate({ id: "candidate_seeded" })],
            approvals: [
              {
                id: "approval_candidate",
                kind: "candidate",
                status: "pending",
                reason: "Review candidate before execution.",
                time: { created: 1, updated: 1 },
              },
            ],
            run: { id: "run_pending", status: "queued", metrics: {}, time: { created: 1, updated: 1 } },
            selectionArtifact: artifact({
              id: "artifact_selection",
              kind: "research_candidate_selection_json",
              metadata: {
                rankPredictorVersion: "tsf_profile_heuristic_v1",
                selectionSource: "domain_proposal",
                rankingCount: 2,
                topScore: 0.73,
              },
            }),
          },
        ],
      }),
    ).toBe(
      "loop stopped: waiting for approval / 1 iteration / 0 succeeded / 0 failed / 1 approval pending / seeded=1 / selection ranker=tsf_profile_heuristic_v1 / source=domain_proposal / rankings=2 / top=0.73",
    )
  })

  test("finds the best displayed metric across champion and succeeded runs", () => {
    const runs: ResearchCockpitRun[] = [
      { id: "run_bad", status: "succeeded", metrics: { val_avg_mse: 0.5 }, time: { created: 1, updated: 1 } },
      { id: "run_best", status: "succeeded", metrics: { val_avg_mse: 0.2 }, time: { created: 1, updated: 1 } },
    ]

    expect(findBestResearchCockpitMetric({ primaryMetric: "val_avg_mse", direction: "minimize" }, runs)).toBe(
      "best val_avg_mse=0.2",
    )
    expect(
      findBestResearchCockpitMetric({ primaryMetric: "val_avg_mse", direction: "minimize" }, runs, {
        taskID: "task_a",
        candidateID: "candidate_a",
        runID: "run_champion",
        primaryMetric: 0.1,
        utility: 0.9,
        acceptedAt: 1,
        time: { created: 1, updated: 1 },
      }),
    ).toBe("best val_avg_mse=0.1")
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

  test("validates Neo-Cast runtime readiness before enabling execution", async () => {
    expect(
      canExecuteResearchCockpitTask(
        task({ id: "missing", taskSpec: { runtime: { neoCastProjectRoot: "/tmp/missing-neo-cast-runner" } } }),
        { validateRuntime: true },
      ),
    ).toBe(false)

    const unsupportedRoot = await createNeoCastRunnerRoot("Python 3.9.6")
    expect(
      canExecuteResearchCockpitTask(
        task({ id: "unsupported", taskSpec: { runtime: { neoCastProjectRoot: unsupportedRoot } } }),
        { validateRuntime: true },
      ),
    ).toBe(false)

    const readyRoot = await createNeoCastRunnerRoot()
    expect(
      canExecuteResearchCockpitTask(
        task({ id: "ready", taskSpec: { runtime: { neoCastProjectRoot: readyRoot } } }),
        { validateRuntime: true },
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
          id: "hypo_plan",
          kind: "hypo_plan_md",
          metadata: { agent: "HypoPlannerAgent", hypothesisCount: 3, baselineStrategy: "domain_baselines_first" },
        }),
      ),
    ).toBe("agent=HypoPlannerAgent / hypotheses=3 / baseline=domain_baselines_first")
    expect(
      formatResearchCockpitArtifactMetadata(
        artifact({
          id: "hypotheses",
          kind: "hypotheses_yaml",
          metadata: { agent: "HypoPlannerAgent", hypothesisCount: 3, baselineStrategy: "domain_baselines_first" },
        }),
      ),
    ).toBe("agent=HypoPlannerAgent / hypotheses=3 / baseline=domain_baselines_first")
    expect(
      formatResearchCockpitArtifactMetadata(
        artifact({
          id: "compile",
          kind: "model_compile_report_md",
          metadata: {
            agent: "ModelCompilerAgent",
            candidateID: "candidate_a",
            status: "passed",
            smokeMetric: 0.1234,
          },
        }),
      ),
    ).toBe("agent=ModelCompilerAgent / candidate=candidate_a / status=passed / smoke=0.1234")
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

  test("builds Socratic clarification state from pending protocol approvals", () => {
    const result = buildSocraticClarificationState(
      task({
        id: "task_socratic",
        mode: "autonomous",
        status: "paused",
        taskSpec: { metadata: { interactionMode: "socratic" } },
      }),
      [
        {
          id: "approval_protocol",
          kind: "protocol",
          status: "pending",
          reason: [
            "运行自主研究流水线前需要先澄清研究意图。",
            "- NeoResearch 应该使用哪个 CSV 数据集路径进行 profiling 和执行？",
            "- 需要预测哪些目标列？",
          ].join("\n"),
          time: { created: 1, updated: 1 },
        },
      ],
    )
    expect(result.active).toBe(true)
    expect(result.missingSlots).toEqual(["data_source", "target_columns"])
    expect(result.nextQuestion).toBe("NeoResearch 应该使用哪个 CSV 数据集路径进行 profiling 和执行？")
    expect(result.questionCount).toBe(2)
    expect(result.slots).toHaveLength(15)
    expect(result.slots.find((s) => s.id === "data_source")).toMatchObject({
      id: "data_source",
      label: "CSV 数据集路径",
      question: "NeoResearch 应该使用哪个 CSV 数据集路径进行 profiling 和执行？",
      status: "missing",
    })
    expect(result.slots.find((s) => s.id === "target_columns")).toMatchObject({
      id: "target_columns",
      label: "目标列",
      question: "需要预测哪些目标列？",
      status: "missing",
    })
    expect(result.slots.find((s) => s.id === "interaction_mode")).toMatchObject({
      id: "interaction_mode",
      status: "filled",
      value: "socratic",
    })
    expect(result.slots.find((s) => s.id === "secondary_metrics")).toMatchObject({
      id: "secondary_metrics",
      required: false,
      status: "filled",
    })
  })

  test("builds Socratic slot state and next question from incomplete task specs", () => {
    const result = buildSocraticClarificationState(
      task({
        id: "task_socratic_partial",
        mode: "autonomous",
        taskSpec: {
          metadata: { interactionMode: "socratic" },
          dataset: { path: "/tmp/ETTh1.csv", targetCols: ["OT"] },
          predictionLengths: [24],
        },
        objective: {},
      }),
      [],
    )
    expect(result.active).toBe(false)
    expect(result.slots).toHaveLength(15)
    expect(result.missingSlots).toContain("primary_metric")
    expect(result.missingSlots).not.toContain("data_source")
    expect(result.missingSlots).not.toContain("target_columns")
    expect(result.missingSlots).not.toContain("prediction_horizon")
    expect(result.missingSlots).not.toContain("interaction_mode")
    expect(result.slots.find((s) => s.id === "data_source")).toMatchObject({
      status: "filled",
      value: "/tmp/ETTh1.csv",
    })
    expect(result.slots.find((s) => s.id === "target_columns")).toMatchObject({
      status: "filled",
      value: "OT",
    })
    expect(result.slots.find((s) => s.id === "prediction_horizon")).toMatchObject({
      status: "filled",
      value: "24",
    })
    expect(result.slots.find((s) => s.id === "primary_metric")).toMatchObject({
      label: "主指标",
      question: "模型搜索应该优化哪个验证指标？",
      status: "missing",
    })
  })

  test("detects research events that should refresh cockpit data", () => {
    expect(shouldRefreshResearchCockpitOnEvent({ type: "research.artifact.created" })).toBe(true)
    expect(shouldRefreshResearchCockpitOnEvent({ type: "research.runner.progress.line" })).toBe(true)
    expect(shouldRefreshResearchCockpitOnEvent({ type: "research.approval.updated" })).toBe(true)
    expect(shouldRefreshResearchCockpitOnEvent({ type: "research.agent.hypoPlanner.completed" })).toBe(true)
    expect(shouldRefreshResearchCockpitOnEvent({ type: "research.runner.progress.line" })).toBe(true)
    expect(shouldRefreshResearchCockpitOnEvent({ type: "message.part.updated" })).toBe(false)
  })
})
