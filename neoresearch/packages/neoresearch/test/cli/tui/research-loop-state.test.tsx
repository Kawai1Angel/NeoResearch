/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ResearchLoopPanel } from "../../../src/cli/cmd/tui/component/research-loop-panel"
import {
  loopBudgetLines,
  loopControlAvailability,
  loopRecoveryLine,
  loopWorkflow,
  updateLoopAgentViews,
} from "../../../src/cli/cmd/tui/routes/research-loop-state"
import { loopStateFixture } from "../../fixture/loop-state"

const colors = { text: "#eeeeee", textMuted: "#999999", primary: "#ff9900", success: "#00ff00", warning: "#ffff00" }

test("a requirements checkpoint keeps its recovery header to one bounded line", () => {
  const state = loopStateFixture()
  state.recovery.recoveryState = "waiting_input"
  state.recovery.summary = "[checkpoint:intent_confirmed]\n## Complete and confirm requirements\n\n" + "Dataset, metric and training budget details.\n".repeat(40)
  expect(loopRecoveryLine(state)).toBe("waiting_input: Complete and confirm requirements")
  state.recovery.recoveryState = "blocked"
  state.recovery.summary = "A long recovery reason ".repeat(50)
  expect(loopRecoveryLine(state).length).toBeLessThanOrEqual(200)
  expect(loopRecoveryLine(state)).not.toContain("\n")
})

test("loop controls respect ownership, recovery, deadlines and per-action training requirements", () => {
  const state = loopStateFixture()
  state.budget.deadlineAt = Date.now() + 60000
  expect(loopControlAvailability(state, "trial", false, true).enabled).toBe(true)
  expect(loopControlAvailability(state, "design", false, true).enabled).toBe(true)
  expect(loopControlAvailability(state, "finish-design", false, false).enabled).toBe(true)
  expect(loopControlAvailability(state, "trial", true, true).enabled).toBe(false)
  expect(loopControlAvailability(state, "trial", false, false).enabled).toBe(false)
  state.recovery.recoveryState = "needs_reconciliation"
  expect(loopControlAvailability(state, "finish-design", false, true).enabled).toBe(false)
  state.recovery.recoveryState = "resumable"
  state.designs[0]!.trials[1]!.status = "pending"
  expect(loopControlAvailability(state, "finish-design", false, true).enabled).toBe(false)
  state.budget.deadlineAt = Date.now() - 1
  expect(loopControlAvailability(state, "trial", false, true).reason).toContain("expired")
  state.budget.deadlineAt = null
  state.budget.trainingUsed = state.budget.trainingLimit!
  expect(loopControlAvailability(state, "design", false, true).reason).toContain("exhausted")
})

test("reopening a bounded operation shows its saved scope and cannot switch to a different control", () => {
  const state = loopStateFixture()
  state.budget.deadlineAt = null
  state.control = { action: "trial", cycleID: state.cycleID!, designID: state.activeDesignID, completedTrialsBefore: 1, status: "active" }
  expect(loopControlAvailability(state, "design", false, true).reason).toContain("saved loop control")
  expect(loopControlAvailability(state, "trial", false, true).enabled).toBe(true)
  state.control.status = "paused"
  expect(loopRecoveryLine(state)).toContain("Paused after Trial")
})

test("budget labels separate reserved full attempts, task run records and an absolute deadline", () => {
  const state = loopStateFixture()
  expect(loopBudgetLines(state, 100_000)).toEqual([
    "Full training 2/25 · Run records 4/100",
    "1m 0s left · 20s elapsed",
  ])
  expect(loopBudgetLines(state, 200_000)[1]).toContain("deadline expired")
  state.budget.deadlineAt = null
  state.budget.trainingLimit = null
  expect(loopBudgetLines(state, 200_000)[0]).toContain("2/unbound")
  expect(loopBudgetLines(state, 200_000)[1]).toContain("no deadline")
})

test("a completed Design target is displayed separately from the shared full-training budget", () => {
  const state = loopStateFixture()
  state.budget.designsCompleted = 10
  state.budget.designLimit = 25
  expect(loopBudgetLines(state, 100_000).slice(0, 2)).toEqual([
    "Completed Designs 10/25",
    "Full training 2/25 · Run records 4/100",
  ])
})

test("recovery identifies a completed trial awaiting reflection and preserves reconciliation blockers", () => {
  const state = loopStateFixture()
  expect(loopRecoveryLine(state)).toBe("Resume at: Training Reflection · Design 1 · Trial 2")
  state.recovery.recoveryState = "needs_reconciliation"
  state.recovery.summary = "Original runner is unconfirmed"
  expect(loopRecoveryLine(state)).toBe("Reconciliation required: Original runner is unconfirmed")
})

test("historical artifacts cannot complete the active design's reflection or optimizer stage", () => {
  const state = loopStateFixture()
  const base = [
    "HypoPlanner Agent",
    "ModelDesigner Agent",
    "ModelCompiler Agent",
    "TrainEval Agent",
    "Reflection Agent",
  ].map((label) => ({ label, status: "done" as const }))
  const stages = loopWorkflow(base, state)
  expect(stages.find((item) => item.label === "Training Reflection")!.status).toBe("active")
  expect(stages.find((item) => item.label === "Architecture Reflection")!.status).toBe("todo")
  expect(stages.find((item) => item.label === "OptimizerAgent")!.status).toBe("todo")
  expect(stages.find((item) => item.label === "ModelDesigner Agent")!.displayLabel).toContain("Design 1")
  state.phase = "optimization"
  expect(loopWorkflow(base, state).find((item) => item.label === "OptimizerAgent")!.status).toBe("active")
})

test("scoped reflection streams remain isolated and repeated or late terminal events do not reopen them", () => {
  const props = { taskID: "task-loop", cycleID: "cycle-1", designID: "design-1" }
  const training = { ...props, trialID: "trial-2", reflectionScope: "training" }
  const architecture = { ...props, reflectionScope: "architecture" }
  const event = (suffix: string, properties: Record<string, unknown>) => ({
    type: `research.agent.reflection.${suffix}`,
    properties,
  })
  let views = updateLoopAgentViews(
    {},
    "task-loop",
    event("started", { taskID: "task-loop", metadata: training }),
  )!.views
  views = updateLoopAgentViews(
    views,
    "task-loop",
    event("started", { taskID: "task-loop", metadata: architecture }),
  )!.views
  views = updateLoopAgentViews(
    views,
    "task-loop",
    event("stream.delta", { ...training, delta: "training diagnosis" }),
  )!.views
  views = updateLoopAgentViews(
    views,
    "task-loop",
    event("stream.delta", { ...architecture, delta: "architecture assessment" }),
  )!.views
  expect(
    Object.values(views)
      .map((view) => view.text)
      .sort(),
  ).toEqual(["architecture assessment", "training diagnosis"])
  const completed = event("completed", { taskID: "task-loop", metadata: { ...training, summary: "diagnosed" } })
  const result = updateLoopAgentViews(views, "task-loop", completed)!
  expect(result.terminal).toBe(true)
  views = result.views
  expect(updateLoopAgentViews(views, "task-loop", completed)!.views).toBe(views)
  expect(
    updateLoopAgentViews(views, "task-loop", event("started", { taskID: "task-loop", metadata: training }))!.views,
  ).toBe(views)
  expect(updateLoopAgentViews(views, "task-loop", event("stream.delta", { ...training, delta: "late" }))!.views).toBe(
    views,
  )
  expect(updateLoopAgentViews(views, "other-task", completed)).toBeUndefined()
})

test("OptimizerAgent completion shows the validated action, rationale and measured duration", () => {
  const result = updateLoopAgentViews({}, "task-loop", {
    type: "research.agent.optimizer.completed",
    properties: {
      taskID: "task-loop",
      metadata: {
        designID: "design-1",
        trialID: "trial-2",
        durationMs: 1250,
        decision: { action: "finish_design", rationale: "No further training changes are justified" },
      },
    },
  })!
  expect(result.view!.summary).toBe("finish_design: No further training changes are justified")
  expect(result.view!.durationMs).toBe(1250)
})

test("the narrow terminal panel shows the failed trial, earlier best and correct budget independently", async () => {
  const state = loopStateFixture()
  const app = await testRender(() => <ResearchLoopPanel state={state} now={100_000} colors={colors} compact />, {
    width: 70,
    height: 28,
  })
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Full training 2/25")
    expect(frame).toContain("Run records 4/100")
    expect(frame).toContain("Resume at: Training Reflection")
    expect(frame).toContain("Trial 1")
    expect(frame).toContain("Trial 2")
    expect(frame).toContain("full failed")
    expect(frame).toContain("[design best]")
    expect(frame).not.toContain("succeeded runs")
  } finally {
    app.renderer.destroy()
  }
})

test("expanded design history keeps memory delivery and architecture evidence separate from tuned best", async () => {
  const state = loopStateFixture()
  state.designs[0]!.architectureEvidence = { status: "confounded" }
  state.designs[0]!.architectureReflection.memoryWrites = [
    { id: "memory-1", purpose: "architecture", status: "rejected", error: "Training-only evidence" },
  ]
  const app = await testRender(() => <ResearchLoopPanel state={state} now={100_000} colors={colors} />, {
    width: 90,
    height: 40,
  })
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("trainingStrategy.optimizer.lr")
    expect(frame).toContain("CUDA out of memory")
    expect(frame).toContain("architecture evidence: confounded")
    expect(frame).toContain("Memory architecture: rejected")
    expect(frame).toContain("Design best: val_avg_mse=0.2")
  } finally {
    app.renderer.destroy()
  }
})
