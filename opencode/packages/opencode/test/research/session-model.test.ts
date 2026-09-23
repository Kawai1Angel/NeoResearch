import { expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { Provider } from "../../src/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { resolveSessionModel } from "../../src/research/session-model"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

const selected = { providerID: ProviderID.make("deepseek"), modelID: ModelID.make("deepseek-v4-flash") }
const model = ProviderTest.model({ providerID: selected.providerID, id: selected.modelID })
const fake = ProviderTest.fake({
  model,
  getModel: (providerID, modelID) => {
    if (modelID === "broken") return Effect.die(new Error("registry unavailable"))
    if (providerID === selected.providerID && modelID === selected.modelID) return Effect.succeed(model)
    return Effect.die(new Provider.ModelNotFoundError({ providerID, modelID, suggestions: [] }))
  },
  defaultModel: () => Effect.succeed(selected),
})
const it = testEffect(fake.layer)

it.effect("stale auth default resolves to the current registered model", () => Effect.gen(function* () {
  expect(yield* resolveSessionModel({ providerID: "deepseek", modelID: "deepseek-chat" })).toEqual(selected)
}))
it.effect("valid explicit model is preserved", () => Effect.gen(function* () {
  expect(yield* resolveSessionModel(selected)).toEqual(selected)
}))
it.effect("unmapped custom transport can use the application model", () => Effect.gen(function* () {
  expect(yield* resolveSessionModel(undefined)).toEqual(selected)
}))
it.effect("unrelated provider failures are not hidden by model fallback", () => Effect.gen(function* () {
  const result = yield* resolveSessionModel({ providerID: "deepseek", modelID: "broken" }).pipe(Effect.exit)
  expect(Exit.isFailure(result)).toBe(true)
  if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("registry unavailable")
}))

it.effect("TUI selection overrides even a still-valid research default", () => Effect.gen(function* () {
  const permissive = ProviderTest.fake({
    getModel: (providerID, modelID) => Effect.succeed(ProviderTest.model({ providerID, id: modelID })),
  })
  const actual = yield* resolveSessionModel({ providerID: "deepseek", modelID: "deepseek-chat" }, selected)
    .pipe(Effect.provide(permissive.layer))
  expect(actual).toEqual(selected)
}))
it.effect("an invalid explicit TUI selection is surfaced instead of silently substituted", () => Effect.gen(function* () {
  const result = yield* resolveSessionModel(selected, { providerID: "deepseek", modelID: "removed" }).pipe(Effect.exit)
  expect(Exit.isFailure(result)).toBe(true)
  if (Exit.isFailure(result)) expect(Provider.ModelNotFoundError.isInstance(Cause.squash(result.cause))).toBe(true)
}))
it.effect("implicit fallback does not switch providers", () => Effect.gen(function* () {
  const result = yield* resolveSessionModel({ providerID: "anthropic", modelID: "missing" }).pipe(Effect.exit)
  expect(Exit.isFailure(result)).toBe(true)
}))
