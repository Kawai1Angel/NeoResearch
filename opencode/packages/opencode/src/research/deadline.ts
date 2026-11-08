import { Context, Effect } from "effect"

export const ResearchDeadline = Context.Reference<number | undefined>("research/Deadline", {
  defaultValue: () => undefined,
})

export class ResearchDeadlineExceeded extends Error {
  constructor() {
    super("Shared research deadline exhausted")
  }
}

export function withinResearchDeadline<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const deadline = yield* ResearchDeadline
    if (deadline === undefined) return yield* effect
    const remaining = deadline - Date.now()
    if (remaining <= 0) return yield* Effect.die(new ResearchDeadlineExceeded())
    return yield* effect.pipe(
      Effect.timeoutOrElse({ duration: remaining, orElse: () => Effect.die(new ResearchDeadlineExceeded()) }),
    )
  })
}
