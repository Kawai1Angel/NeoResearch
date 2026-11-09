import { expect, test } from "bun:test"
import { taskExecutionRoot, validateTaskRuntimePaths } from "../../src/research/task-isolation"

test("isolated runtime paths cannot escape into another task workspace", () => {
  const root = taskExecutionRoot({ id: "task-a", taskSpec: { metadata: { executionIsolation: "task" } } }, "/project")
  expect(root).toBe("/project/.neo-research/workspaces/task-a")
  expect(() => validateTaskRuntimePaths({ taskSpec: { runtime: { artifactsDir: "../task-b/artifacts" } } }, root)).toThrow("execution workspace")
  expect(() => validateTaskRuntimePaths({ taskSpec: { runtime: { currentCandidatePath: "/project/current.json" } } }, root)).toThrow("execution workspace")
  expect(() => validateTaskRuntimePaths({ taskSpec: { runtime: { artifactsDir: ".neo-cast/artifacts" } } }, root)).not.toThrow()
})

test("all sessions use distinct workspaces even without isolation metadata", () => {
  expect(taskExecutionRoot({ id: "old-task", taskSpec: {} }, "/project")).toBe("/project/.neo-research/workspaces/old-task")
  expect(taskExecutionRoot({ id: "other-task", taskSpec: { metadata: { executionIsolation: "legacy" } } }, "/project")).toBe("/project/.neo-research/workspaces/other-task")
  expect(() => taskExecutionRoot({ id: "../escape", taskSpec: {} }, "/project")).toThrow("workspace ID")
})
