import type { JsonRecord } from "./schema"

export function researchVariant(taskSpec: { metadata?: unknown }): "standard" | "zero" {
  const metadata = taskSpec.metadata as Record<string, unknown> | undefined
  const variant = metadata?.researchVariant
  if (variant === undefined || variant === "standard") return "standard"
  if (variant === "zero") return "zero"
  throw new Error("metadata.researchVariant must be standard or zero")
}

export function isZeroResearch(taskSpec: { metadata?: unknown }): boolean {
  return researchVariant(taskSpec) === "zero"
}

export function validateResearchVariant(taskSpec: JsonRecord) {
  if (!isZeroResearch(taskSpec)) return
  const metadata = taskSpec.metadata as Record<string, unknown>
  if (["referenceBaseline", "referenceBaselineSource", "referenceBaselineRationale"].some((key) => metadata[key] != null))
    throw new Error("NeoResearch-zero does not accept reference baseline metadata; create a fresh zero task")
}

export class BaselineDisabledError extends Error {
  constructor() {
    super("NeoResearch-zero disables preset baselines. Select a hypothesis and design its model directly.")
  }
}
