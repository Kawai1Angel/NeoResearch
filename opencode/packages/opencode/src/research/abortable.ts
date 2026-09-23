import { Effect } from "effect"

// Unlike a bare Effect.promise, interruption waits for the resource to stop.
// This prevents releasing a task's operation lock while Python is still alive.
export function abortable<A>(run: (signal: AbortSignal) => Promise<A>): Effect.Effect<A> {
  return Effect.callback<A>((resume) => {
    const controller = new AbortController()
    const pending = Promise.resolve().then(() => run(controller.signal))
    void pending.then(
      (value) => resume(Effect.succeed(value)),
      (error) => resume(Effect.die(error)),
    )
    return Effect.promise(async () => {
      controller.abort()
      await pending.catch(() => undefined)
    })
  })
}
