import path from "node:path"
import type { JsonRecord } from "./schema"
import type { OpencodeModelRef } from "./llm-proposal"

export function taskExecutionRoot(task: { id: string; taskSpec: Readonly<Record<string, unknown>> }, root: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(task.id)) throw new Error("Invalid research task workspace ID")
  return path.join(root, ".neo-research", "workspaces", task.id)
}

export function taskSessionModel(spec: JsonRecord): OpencodeModelRef | undefined {
  const metadata = spec.metadata as Record<string, unknown> | undefined
  const model = metadata?.sessionModel as Record<string, unknown> | undefined
  if (typeof model?.providerID === "string" && typeof model.modelID === "string") {
    return { providerID: model.providerID, modelID: model.modelID }
  }
}

export function validateTaskRuntimePaths(task: { taskSpec: JsonRecord }, root: string) {
  const runtime = task.taskSpec.runtime as Record<string, unknown> | undefined
  for (const name of ["currentCandidatePath", "resolvedCandidatePath", "artifactsDir"]) {
    const value = runtime?.[name]
    if (typeof value !== "string") continue
    const relative = path.relative(root, path.resolve(root, value))
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`runtime.${name} must stay inside this task's execution workspace`)
    }
  }
}
