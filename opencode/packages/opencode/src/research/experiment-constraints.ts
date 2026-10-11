import { z } from "zod"
import { isDeepStrictEqual } from "node:util"
import { candidateMechanisms, validMechanisms } from "./model-capabilities"
import { TSFCandidateRecipe } from "./domains/tsf"
import { normalizedRecipeKey, normalizedRecipePath } from "./recipe-naming"

function normalizedRecipeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedRecipeValue)
  if (!value || typeof value !== "object") return value
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const normalized = normalizedRecipeKey(key)
    const next = normalizedRecipeValue(item)
    if (Object.hasOwn(result, normalized) && !isDeepStrictEqual(result[normalized], next))
      throw new Error(`Conflicting recipe aliases for ${normalized}`)
    Object.defineProperty(result, normalized, { value: next, enumerable: true, writable: true, configurable: true })
  }
  return result
}
const recipeValue = z.json().transform((value, ctx) => {
  try {
    return normalizedRecipeValue(value) as typeof value
  } catch (error) {
    ctx.addIssue({ code: "custom", message: String(error) })
    return z.NEVER
  }
})

// Paths address normalized recipe fields, never rationale, IDs or evaluation metadata.
const field = z
  .string()
  .transform(normalizedRecipePath)
  .pipe(z.string().regex(
    /^(preprocessing|embedding|backbone|representation|composition|fusion|predictionHead|trainingStrategy)(\.[A-Za-z0-9_]+)*$/,
  ))
const change = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("set"), path: field, before: recipeValue, after: recipeValue }).strict(),
  z.object({ operation: z.literal("add"), path: field, after: recipeValue }).strict(),
  z.object({ operation: z.literal("remove"), path: field, before: recipeValue }).strict(),
])
export const ExperimentConstraints = z
  .object({
    mode: z.enum(["baseline", "exploratory", "controlled"]),
    comparisonRunID: z.string().min(1).optional(),
    changes: z.array(change).max(30).default([]),
    frozenPaths: z.array(field).max(60).default([]),
    requiredValues: z
      .array(z.object({ path: field, value: recipeValue }).strict())
      .max(60)
      .default([]),
    forbiddenMechanisms: z.array(z.string().min(1)).max(30).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === "controlled" && (!value.comparisonRunID || !value.changes.length))
      ctx.addIssue({
        code: "custom",
        message: "Controlled experiments require a named comparison run and explicit changes",
      })
    if (value.mode !== "controlled" && (value.comparisonRunID || value.changes.length))
      ctx.addIssue({ code: "custom", message: "Comparisons and changes require controlled mode" })
    if (!validMechanisms(value.forbiddenMechanisms))
      ctx.addIssue({ code: "custom", message: "Unknown forbidden mechanism" })
    if (value.changes.some((change) => change.operation === "set" && isDeepStrictEqual(change.before, change.after)))
      ctx.addIssue({ code: "custom", message: "Set interventions must change the declared value" })
    const paths = value.changes.map((x) => x.path)
    if (paths.some((p, i) => paths.some((q, j) => i !== j && (p === q || p.startsWith(`${q}.`)))))
      ctx.addIssue({ code: "custom", message: "Changed paths must not overlap" })
    if (paths.some((p) => value.frozenPaths.some((q) => p === q || p.startsWith(`${q}.`) || q.startsWith(`${p}.`))))
      ctx.addIssue({ code: "custom", message: "A field cannot be both changed and frozen" })
    if (value.requiredValues.some((item, index) => value.requiredValues.some((other, otherIndex) =>
      index !== otherIndex && item.path === other.path && !isDeepStrictEqual(item.value, other.value))))
      ctx.addIssue({ code: "custom", message: "Required values for the same normalized path must agree" })
  })
export type ExperimentConstraints = z.infer<typeof ExperimentConstraints>
export type ConstraintIssue = { path: string; expected: unknown; actual: unknown; source: string }

// Also normalize captured/legacy contracts used directly by validation and attribution.
// This changes field spelling only: it does not add defaults or change scalar values.
export function normalizeExperimentConstraints(contract: ExperimentConstraints): ExperimentConstraints {
  return {
    ...contract,
    changes: contract.changes.map((change) => ({ ...change, path: normalizedRecipePath(change.path),
      ...(change.operation !== "add" ? { before: normalizedRecipeValue(change.before) } : {}),
      ...(change.operation !== "remove" ? { after: normalizedRecipeValue(change.after) } : {}),
    })) as ExperimentConstraints["changes"],
    frozenPaths: contract.frozenPaths.map(normalizedRecipePath),
    requiredValues: contract.requiredValues.map((item) => ({ path: normalizedRecipePath(item.path), value: normalizedRecipeValue(item.value) })) as ExperimentConstraints["requiredValues"],
  }
}

export function conflictingMechanismRequirements(input: {
  requiredMechanisms?: readonly string[]
  experimentContract?: ExperimentConstraints
}): string[] {
  const forbidden = new Set(input.experimentContract?.forbiddenMechanisms ?? [])
  return (input.requiredMechanisms ?? []).filter((mechanism) => forbidden.has(mechanism))
}

export function fieldValue(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (v, key) =>
        v && typeof v === "object" && Object.hasOwn(v, key) ? (v as Record<string, unknown>)[key] : undefined,
      value,
    )
}
export function recipeFields(spec: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(spec).filter(([key]) => !["notes", "hypothesis", "recipeID"].includes(key)))
}
export function changedFields(before: unknown, after: unknown, prefix = ""): string[] {
  if (isDeepStrictEqual(before, after)) return []
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object" &&
    Array.isArray(before) === Array.isArray(after)
  )
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
      changedFields((before as any)[key], (after as any)[key], prefix ? `${prefix}.${key}` : key),
    )
  return [prefix]
}

// A component switch can introduce schema defaults (none -> instance_norm
// adds affine=false and eps=1e-5). Derive them from the declared intervention,
// never from the proposed candidate, so unrelated changes remain forbidden.
export function declaredExperimentTarget<T extends Record<string, unknown>>(contract: ExperimentConstraints, comparison: T) {
  const normalized = normalizeExperimentConstraints(contract)
  const target = structuredClone(comparison)
  for (const change of normalized.changes) {
    if (!isDeepStrictEqual(fieldValue(comparison, change.path), change.operation === "add" ? undefined : change.before)) return undefined
    const keys = change.path.split(".")
    const key = keys.pop()!
    const parent = keys.length ? fieldValue(target, keys.join(".")) : target
    if (!parent || typeof parent !== "object" || ["__proto__", "prototype", "constructor"].includes(key)) return undefined
    if (change.operation === "remove") delete (parent as any)[key]
    else Object.defineProperty(parent, key, { value: structuredClone(change.after), enumerable: true, writable: true, configurable: true })
  }
  return target
}

function interventionDefaults(contract: ExperimentConstraints, comparison: Record<string, unknown>) {
  const target = declaredExperimentTarget(contract, comparison)
  if (!target) return undefined
  const normalized = TSFCandidateRecipe.safeParse(target)
  if (!normalized.success) return undefined
  const defaults = changedFields(target, normalized.data).filter((path) =>
    fieldValue(target, path) === undefined && contract.changes.some((change) => change.operation !== "remove" &&
      (path.startsWith(`${change.path}.`) ||
        (change.path.endsWith(".type") && path.startsWith(`${change.path.slice(0, -5)}.`)))),
  )
  // Build only the permitted additions; never accept schema coercions, removals,
  // or defaults outside the changed component.
  const expected = structuredClone(target)
  for (const path of defaults) {
    const keys = path.split(".")
    const key = keys.pop()!
    const parent = fieldValue(expected, keys.join(".")) as Record<string, unknown> | undefined
    if (parent) Object.defineProperty(parent, key, { value: structuredClone(fieldValue(normalized.data, path)), enumerable: true, configurable: true, writable: true })
  }
  return { expected, defaults }
}
export function checkExperimentConstraints(
  contract: ExperimentConstraints,
  spec: Record<string, unknown>,
  comparison?: Record<string, unknown>,
): ConstraintIssue[] {
  return checkNormalizedExperimentConstraints(normalizeExperimentConstraints(contract), spec, comparison)
}

function checkNormalizedExperimentConstraints(
  contract: ExperimentConstraints,
  spec: Record<string, unknown>,
  comparison?: Record<string, unknown>,
): ConstraintIssue[] {
  const issues: ConstraintIssue[] = []
  const add = (path: string, expected: unknown, actual: unknown) =>
    issues.push({ path, expected: expected ?? null, actual: actual ?? null, source: "experiment_constraints" })
  for (const requirement of contract.requiredValues) {
    const actual = fieldValue(spec, requirement.path)
    if (!isDeepStrictEqual(actual, requirement.value)) add(requirement.path, requirement.value, actual)
  }
  const mechanisms = candidateMechanisms(spec)
  for (const mechanism of contract.forbiddenMechanisms)
    if (mechanisms.includes(mechanism as any)) add(`forbiddenMechanisms.${mechanism}`, false, true)
  if (contract.mode !== "controlled") return issues
  if (!comparison) {
    add("comparisonRunID", contract.comparisonRunID, "comparison unavailable")
    return issues
  }
  const diffs = changedFields(recipeFields(comparison), recipeFields(spec))
  const implied = interventionDefaults(contract, comparison)
  for (const change of contract.changes) {
    const before = fieldValue(comparison, change.path)
    const after = fieldValue(spec, change.path)
    const expectedBefore = change.operation === "add" ? undefined : change.before
    if (!isDeepStrictEqual(before, expectedBefore)) add(`${change.path}.before`, expectedBefore, before)
    const expected = change.operation === "remove" ? undefined : implied ? fieldValue(implied.expected, change.path) : change.after
    if (!isDeepStrictEqual(after, expected)) add(change.path, expected, after)
    if (isDeepStrictEqual(before, after)) add(change.path, "an actual intervention", "unchanged")
  }
  for (const path of diffs)
    if (!contract.changes.some((x) => path === x.path || path.startsWith(`${x.path}.`)) &&
      !(implied?.defaults.includes(path) && isDeepStrictEqual(fieldValue(spec, path), fieldValue(implied.expected, path))))
      add(path, fieldValue(comparison, path), fieldValue(spec, path))
  for (const path of contract.frozenPaths)
    if (!isDeepStrictEqual(fieldValue(comparison, path), fieldValue(spec, path)))
      add(path, fieldValue(comparison, path), fieldValue(spec, path))
  return issues
}
