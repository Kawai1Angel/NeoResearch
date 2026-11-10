import { randomUUID } from "node:crypto"
import { Cause, Effect, Exit } from "effect"
import { Instance } from "@/project/instance"
import { recordResearchEvent } from "./log-archive"

export function logPhaseMethod<Args extends unknown[], A, E, R>(
  phase: string,
  method: (...args: Args) => Effect.Effect<A, E, R>,
): (...args: Args) => Effect.Effect<A, E, R> {
  return (...args) => Effect.suspend(() => {
    const input = args[0] as { taskID?: string; task?: { id: string }; run?: { taskID: string } }
    const taskID = typeof args[0] === "string" ? args[0] : input?.taskID ?? input?.task?.id ?? input?.run?.taskID
    const root = Instance.directory
    const attemptID = randomUUID()
    const started = Date.now()
    recordResearchEvent(root, "research.phase.started", { taskID, phase, attemptID, startedAt: started })
    return method(...args).pipe(Effect.onExit((exit) => Effect.sync(() => {
      recordResearchEvent(root, Exit.isSuccess(exit) ? "research.phase.completed" : Cause.hasInterruptsOnly(exit.cause) ? "research.phase.canceled" : "research.phase.failed", {
        taskID, phase, attemptID, startedAt: started, finishedAt: Date.now(), durationMs: Date.now() - started,
        ...(Exit.isFailure(exit) ? { error: Cause.pretty(exit.cause) } : {}),
      })
    })))
  })
}
