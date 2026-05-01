import type { AutonomousLoopResult } from "../service"
import type { ResearchTaskID } from "../schema"

export interface NASAgentResult {
  readonly agent: "NASAgent"
  readonly taskID: ResearchTaskID
  readonly loop: AutonomousLoopResult
  readonly iterationCount: number
  readonly succeededCount: number
  readonly failedCount: number
}

export function summarizeNASAgentLoop(input: {
  readonly taskID: ResearchTaskID
  readonly loop: AutonomousLoopResult
}): NASAgentResult {
  return {
    agent: "NASAgent",
    taskID: input.taskID,
    loop: input.loop,
    iterationCount: input.loop.iterations.length,
    succeededCount: input.loop.iterations.filter((iteration) => iteration.run.status === "succeeded").length,
    failedCount: input.loop.iterations.filter((iteration) => iteration.run.status === "failed").length,
  }
}
