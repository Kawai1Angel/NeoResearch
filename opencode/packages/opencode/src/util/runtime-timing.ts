import { Cause, Effect, Exit } from "effect"
import { Log } from "@/util"

const log = Log.create({ service: "runtime.timing" })
type Fields = Record<string, string | number | undefined>
type Status = "completed" | "failed" | "canceled"

/** No arguments, prompts, tool output or provider credentials are recorded. */
export function startTiming(phase: string, fields: Fields, report = (data: Fields) => log.info("phase", data)) {
  const startedAt = Date.now()
  const started = performance.now()
  const timingID = crypto.randomUUID()
  const emit = (data: Fields) => {
    try { report({ ...fields, phase, timingID, startedAt, ...data }) } catch { /* Diagnostics must not fail work. */ }
  }
  emit({ status: "started" })
  let finished = false
  return (status: Status) => {
    if (finished) return
    finished = true
    emit({ status, finishedAt: Date.now(), durationMs: Math.round((performance.now() - started) * 1000) / 1000 })
  }
}

export function timedEffect<A, E, R>(phase: string, fields: Fields, effect: Effect.Effect<A, E, R>, report?: (data: Fields) => void): Effect.Effect<A, E, R> {
  return Effect.suspend(() => {
    const finish = startTiming(phase, fields, report)
    return effect.pipe(Effect.onExit((exit) => Effect.sync(() => finish(
      Exit.isSuccess(exit) ? "completed" : Cause.hasInterruptsOnly(exit.cause) ? "canceled" : "failed",
    ))))
  })
}

export async function timedAsync<T>(phase: string, fields: Fields, run: () => Promise<T>, report?: (data: Fields) => void): Promise<T> {
  const finish = startTiming(phase, fields, report)
  try {
    const value = await run()
    finish("completed")
    return value
  } catch (error) {
    finish("failed")
    throw error
  }
}
