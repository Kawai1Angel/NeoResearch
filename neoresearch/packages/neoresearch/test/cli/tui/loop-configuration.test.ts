import { expect, test } from "bun:test"
import { parseLoopConfigurationField } from "../../../src/cli/cmd/tui/component/dialog-loop-configuration"
import { isResearchOperation } from "../../../src/cli/cmd/tui/routes/research-operation-client"
import type { LoopConfiguration } from "../../../src/research/loop-control-schema"

const draft: LoopConfiguration = {
  maxIterations: 25,
  maxTrialsPerDesign: 3,
  maxNoImprovePerDesign: 2,
  maxNoImprove: 7,
  maxCrashStreak: 3,
  maxRuns: 200,
  timeBudgetSeconds: 600,
  targetMetricValue: 0.2,
  minRelativeImprovement: 0,
}
test("configuration fields validate counts, finite metrics and optional deadlines without mutating the draft", () => {
  expect(parseLoopConfigurationField(draft, "maxTrialsPerDesign", "0").success).toBe(false)
  expect(parseLoopConfigurationField(draft, "maxTrialsPerDesign", "1.5").success).toBe(false)
  expect(parseLoopConfigurationField(draft, "maxRuns", "201").success).toBe(false)
  expect(parseLoopConfigurationField(draft, "maxIterations", "").success).toBe(false)
  expect(parseLoopConfigurationField(draft, "targetMetricValue", "Infinity").success).toBe(false)
  const disabled = parseLoopConfigurationField(draft, "timeBudgetSeconds", "none")
  expect(disabled.success && disabled.data.timeBudgetSeconds).toBeNull()
  const changed = parseLoopConfigurationField(draft, "maxTrialsPerDesign", "4")
  expect(changed.success && changed.data.maxTrialsPerDesign).toBe(4)
  expect(draft.maxTrialsPerDesign).toBe(3)
})

test("the optional completed Design limit accepts positive integers and can be disabled", () => {
  expect(parseLoopConfigurationField(draft, "maxDesigns", "0").success).toBe(false)
  expect(parseLoopConfigurationField(draft, "maxDesigns", "2.5").success).toBe(false)
  const changed = parseLoopConfigurationField(draft, "maxDesigns", "25")
  expect(changed.success && changed.data.maxDesigns).toBe(25)
  const disabled = parseLoopConfigurationField({ ...draft, maxDesigns: 25 }, "maxDesigns", "none")
  expect(disabled.success && disabled.data.maxDesigns).toBeNull()
})
test("bounded controls use the durable operation client while configuration reads and writes stay immediate", () => {
  expect(isResearchOperation("/research/tasks/task-1/loop-control", "POST")).toBe(true)
  expect(isResearchOperation("/research/tasks/task-1/loop-config", "PATCH")).toBe(false)
  expect(isResearchOperation("/research/tasks/task-1/loop-config", "GET")).toBe(false)
})
