import { readFile } from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Cause, Effect, Exit } from "effect"
import { Provider } from "@/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import type { OpencodeModelRef } from "./llm-proposal"

// The TUI persists explicit model selections as the first recent entry in this file.
export async function readSelectedSessionModel(): Promise<OpencodeModelRef | undefined> {
  try {
    const state = JSON.parse(await readFile(path.join(Global.Path.state, "model.json"), "utf8"))
    const selected = state?.recent?.[0]
    if (typeof selected?.providerID === "string" && typeof selected?.modelID === "string") {
      return { providerID: selected.providerID, modelID: selected.modelID }
    }
  } catch {
    // No persisted selection: resolve the research config against the provider registry.
  }
  return undefined
}

// Auth transport defaults can lag behind the models registered in the application.
// Resolve against the registry before creating a session message or sending a request.
export const resolveSessionModel = Effect.fn("Research.resolveSessionModel")(function* (
  requested: OpencodeModelRef | undefined,
  preferred?: OpencodeModelRef,
) {
  const provider = yield* Provider.Service
  if (preferred) {
    const selected = { providerID: ProviderID.make(preferred.providerID), modelID: ModelID.make(preferred.modelID) }
    yield* provider.getModel(selected.providerID, selected.modelID)
    return selected
  }
  let missing: Cause.Cause<never> | undefined
  if (requested) {
    const model = { providerID: ProviderID.make(requested.providerID), modelID: ModelID.make(requested.modelID) }
    const result = yield* provider.getModel(model.providerID, model.modelID).pipe(Effect.exit)
    if (Exit.isSuccess(result)) return model
    if (!Provider.ModelNotFoundError.isInstance(Cause.squash(result.cause))) return yield* Effect.failCause(result.cause)
    missing = result.cause
  }
  const selected = yield* provider.defaultModel()
  // A stale model name must not silently switch an authenticated workflow to another provider.
  if (requested && selected.providerID !== requested.providerID && missing) return yield* Effect.failCause(missing)
  yield* provider.getModel(selected.providerID, selected.modelID)
  return selected
})
