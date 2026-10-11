import { z } from "zod"
import { conflictingMechanismRequirements, declaredExperimentTarget, normalizeExperimentConstraints, fieldValue, type ExperimentConstraints } from "./experiment-constraints"
import type { DomainValidationResult } from "./domain"
import type { JsonRecord } from "./schema"

export const DesignUnavailable = z
  .object({
    status: z.literal("unavailable"),
    hypothesisID: z.string().min(1),
    reason: z.string().min(1).max(4000),
    conflicts: z
      .array(
        z
          .object({
            field: z.string().min(1),
            requested: z.string().min(1),
            supported: z.string().min(1),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    suggestedRevision: z.string().min(1).max(4000),
  })
  .strict()
export type DesignUnavailable = z.infer<typeof DesignUnavailable>

export function mechanismRequirementsUnavailable(input: {
  hypothesisID: string
  requiredMechanisms?: readonly string[]
  experimentContract?: ExperimentConstraints
}): DesignUnavailable | undefined {
  const conflicts = conflictingMechanismRequirements(input)
  if (!conflicts.length) return undefined
  return {
    status: "unavailable",
    hypothesisID: input.hypothesisID,
    reason: `The selected candidate arm both requires and forbids: ${conflicts.join(", ")}.`,
    conflicts: conflicts.map((mechanism) => ({
      field: `requiredMechanisms.${mechanism}`,
      requested: "The candidate arm must implement this mechanism.",
      supported: "The same arm's experimentContract.forbiddenMechanisms forbids it.",
    })),
    suggestedRevision: "Declare requiredMechanisms for the candidate arm being generated. A control that removes the treatment mechanism must not require it; keep the treatment mechanism in the scientific hypothesis and the comparison arm. Preserve the question and frozen experimental conditions.",
  }
}

// A remove operation addresses the normalized recipe, not the raw LLM JSON.
// Prove default restoration against the declared target before requesting a design.
export function schemaRemovalUnavailable(input: {
  hypothesisID: string
  contract: ExperimentConstraints
  comparison?: JsonRecord
  validate: (spec: JsonRecord) => DomainValidationResult
}): DesignUnavailable | undefined {
  if (input.contract.mode !== "controlled" || !input.comparison) return undefined
  const contract = normalizeExperimentConstraints(input.contract)
  const target = declaredExperimentTarget(contract, input.comparison)
  if (!target) return undefined
  const validation = input.validate(target)
  if (!validation.ok || !validation.normalizedCandidateSpec) return undefined
  const conflicts = contract.changes.flatMap((change) => {
    if (change.operation !== "remove") return []
    const restored = fieldValue(validation.normalizedCandidateSpec, change.path)
    if (restored === undefined) return []
    return [{
      field: change.path,
      requested: "Remove this field from the normalized recipe.",
      supported: `The selected component's schema restores the omitted field to ${JSON.stringify(restored)}. Omission does not remove or disable it.`,
    }]
  })
  if (!conflicts.length) return undefined
  return {
    status: "unavailable",
    hypothesisID: input.hypothesisID,
    reason: "The experiment contract removes fields that the target component schema restores during normalization.",
    conflicts: conflicts.slice(0, 20),
    suggestedRevision: "Revise the contract using normalized component fields. Preserve shared supported fields at their comparison values unless changing them is the intended intervention; disabling a boolean requires an explicit set to false, not remove. Do not change the scientific question or frozen settings.",
  }
}

export function frequencyModeUnavailable(input: {
  hypothesisID: string
  contract: ExperimentConstraints
  comparison?: JsonRecord
}): DesignUnavailable | undefined {
  if (input.contract.mode !== "controlled" || !input.comparison) return undefined
  const target = declaredExperimentTarget(input.contract, input.comparison)
  if (!target) return undefined
  const conflicts = ["embedding", "composition.secondary.embedding"].flatMap((path) => {
    if (fieldValue(input.comparison, `${path}.type`) === "frequency" || fieldValue(target, `${path}.type`) !== "frequency" ||
      fieldValue(target, `${path}.complexMode`) !== undefined) return []
    return [{
      field: `${path}.complexMode`,
      requested: "Introduce frequency features without declaring whether to retain real/imaginary parts or magnitude.",
      supported: "The normalized recipe schema defaults complexMode to real_imag, not magnitude. These retain different spectral information; the controlled experiment must explicitly choose one.",
    }]
  })
  if (!conflicts.length) return undefined
  return {
    status: "unavailable",
    hypothesisID: input.hypothesisID,
    reason: "The frequency intervention leaves its spectral feature mode unspecified.",
    conflicts,
    suggestedRevision: "Declare embedding.complexMode (or the secondary branch equivalent) as an explicit add change and requiredValue matching the scientific hypothesis: magnitude for amplitude-only features, real_imag for separate real and imaginary features. Preserve nFreq, dModel, the comparison and frozen settings.",
  }
}

export function formatDesignValidationIssue(issue: {
  path: string
  message: string
  expected?: unknown
  actual?: unknown
}) {
  const values = Object.hasOwn(issue, "expected") || Object.hasOwn(issue, "actual")
    ? ` (expected=${JSON.stringify(issue.expected ?? null)}, actual=${JSON.stringify(issue.actual ?? null)})`
    : ""
  return `${issue.path}: ${issue.message}${values}`
}

export const HistoryRequest = z
  .object({
    runID: z.string().optional(),
    candidateID: z.string().optional(),
    hypothesisID: z.string().optional(),
    limit: z.number().int().min(1).max(20).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict()
export type HistoryRequest = z.infer<typeof HistoryRequest>

export const DesignHistoryRequest = z
  .object({
    status: z.literal("history_request"),
    request: HistoryRequest,
  })
  .strict()

// Keep code/data facts; narrative and search recommendations are retrieved only
// when the agent asks for them. Do not recursively strip fields from recipes.
export function designTaskSpec(spec: Record<string, unknown>) {
  const { metadata, ...contract } = spec
  return contract
}

export function recipeConfiguration(spec: Record<string, unknown>) {
  const { notes, hypothesis, ...configuration } = spec
  return configuration
}
