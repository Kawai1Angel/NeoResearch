import { z } from "zod"
import { checkExperimentConstraints, conflictingMechanismRequirements, declaredExperimentTarget, normalizeExperimentConstraints, fieldValue, type ExperimentConstraints } from "./experiment-constraints"
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

// Apply only the declared intervention to factual history. A candidate must not
// be invented to fill gaps in an incomplete or contradictory contract.
export function experimentContractUnavailable(input: {
  hypothesisID: string
  contract: ExperimentConstraints
  comparison?: JsonRecord
  validate: (spec: JsonRecord) => DomainValidationResult
}): DesignUnavailable | undefined {
  if (input.contract.mode !== "controlled") return undefined
  const contract = normalizeExperimentConstraints(input.contract)
  const report = (reason: string, conflicts: DesignUnavailable["conflicts"], suggestedRevision: string): DesignUnavailable => ({
    status: "unavailable", hypothesisID: input.hypothesisID, reason, conflicts: conflicts.slice(0, 20), suggestedRevision,
  })
  if (!input.comparison) return report("The controlled experiment has no verified comparable full run in this task.",
    [{ field: "comparisonRunID", requested: contract.comparisonRunID!, supported: "A completed independent full run under the same task and evaluation protocol." }],
    "Retrieve a valid comparison run and declare its exact configuration. Do not substitute a different task's run or relabel the controlled question exploratory.")
  const target = declaredExperimentTarget(contract, input.comparison)
  if (!target) return report("The declared intervention cannot be applied to the comparison recipe.",
    contract.changes.map(change => ({ field: change.path, requested: JSON.stringify(change),
      supported: `Comparison value: ${JSON.stringify(fieldValue(input.comparison, change.path)) ?? "absent"}. Parent paths must exist and before values must match exactly.` })),
    "Read the comparison recipe and correct the change paths and before values. Preserve the scientific question.")
  const validation = input.validate(target)
  if (!validation.ok || !validation.normalizedCandidateSpec) return report(
    "Applying the declared changes leaves a schema-invalid target recipe; the experiment contract is incomplete or incompatible.",
    validation.issues.length ? validation.issues.map(issue => ({ field: issue.path, requested: "Keep all undeclared comparison fields and apply only changes.", supported: issue.message }))
      : [{ field: "experimentContract", requested: "A normalized target recipe", supported: "Target recipe validation did not return a normalized configuration." }],
    "For a component type switch, explicitly remove obsolete old-component fields with their exact before values, or declare replacement of the complete component. For example temporal→feature_mlp requires removing fusion.channelMode; instance_norm→none requires removing affine/eps. Do not add forbidden fields to the new component or remove requiredValues that are not present. Preserve supported shared fields and all other frozen settings.")
  const issues = checkExperimentConstraints(contract, validation.normalizedCandidateSpec, input.comparison)
  if (!issues.length) return undefined
  return report("The normalized declared target contradicts its experiment contract.",
    issues.map(issue => ({ field: issue.path, requested: `${issue.rule}: expected=${JSON.stringify(issue.expected)}`,
      supported: `actual=${JSON.stringify(issue.actual)}. ${issue.message}` })),
    issues.map(issue => issue.repairHint ?? "Resolve the named contract requirement against the normalized comparison and target; do not change the scientific question.").filter((hint, index, all) => all.indexOf(hint) === index).join(" "))
}

export function designConstraintFeedback(issue: {
  path: string; expected: unknown; actual: unknown; source?: string; rule?: string; message?: string; repairHint?: string
}) {
  return { ...issue, message: issue.message ?? "Candidate does not satisfy the selected hypothesis" }
}

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
  rule?: string
  repairHint?: string
}) {
  const values = Object.hasOwn(issue, "expected") || Object.hasOwn(issue, "actual")
    ? ` (expected=${JSON.stringify(issue.expected ?? null)}, actual=${JSON.stringify(issue.actual ?? null)})`
    : ""
  return `${issue.path}: ${issue.message}${values}${issue.rule ? ` [${issue.rule}]` : ""}${issue.repairHint ? ` ${issue.repairHint}` : ""}`
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
