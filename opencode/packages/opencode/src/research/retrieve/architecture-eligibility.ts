import z from "zod"
import { isDeepStrictEqual } from "node:util"
import { TSFCandidateRecipe } from "../domains/tsf"
import { MODEL_CAPABILITIES, candidateMechanisms, validMechanisms, unsupportedMechanisms } from "../model-capabilities"

export const ARCHITECTURE_SELECTION_POLICY = "implementable_family_prediction_v1"

export const MechanismFamilySchema = z.enum([
  "affine_temporal", "nonlinear_temporal", "trend_residual_decomposition", "local_patches",
  "multiscale_temporal", "spectral_representation", "temporal_convolution", "temporal_attention",
  "variate_tokens", "channel_independent", "cross_channel_mixing", "instance_level_normalization",
  "adaptive_branch_fusion", "residual_backcast", "state_space", "recurrent_temporal",
])
export type MechanismFamily = z.infer<typeof MechanismFamilySchema>

export const ArchitectureEligibilitySchema = z.object({
  // "exact" is retained only for reading saved reviews from the old policy.
  implementation: z.enum(["family_supported", "exact", "unsupported", "unknown"]),
  implementationReason: z.string().min(1),
  familyMappings: z.array(z.object({
    family: MechanismFamilySchema,
    role: z.enum(["prefer", "avoid"]),
    rationale: z.string().min(1),
    transferBoundaries: z.array(z.string().min(1)).min(1),
  }).strict()).optional(),
  recipe: z.record(z.string(), z.unknown()).nullable(),
  requiredMechanisms: z.array(z.string()),
  target: z.enum(["matched", "mismatch", "unknown"]),
  targetReason: z.string().min(1),
  conditions: z.array(z.object({
    condition: z.string().min(1),
    path: z.string().startsWith("$."),
    value: z.unknown(),
    status: z.enum(["matched", "contradicted", "unknown"]),
    scope: z.enum(["input_channels", "forecast_targets", "general"]).optional(),
  }).strict()),
  // AND across groups, OR within each group. Optional only for saved legacy reviews.
  conditionLogic: z.array(z.object({
    alternatives: z.array(z.number().int().nonnegative()).min(1),
    sourceRationale: z.string().min(1),
    sourceRefs: z.array(z.object({ cardID: z.string().min(1), sourceIDs: z.array(z.string().min(1)).min(1) }).strict()).min(1),
  }).strict()).min(1).optional(),
  objective: z.enum(["prediction", "efficiency_only", "other"]),
  predictionReason: z.string().min(1),
  requiredData: z.object({ knownFutureCovariates: z.boolean(), staticCovariates: z.boolean() }).strict(),
}).strict()
export type ArchitectureEligibility = z.infer<typeof ArchitectureEligibilitySchema>

/** A witness proves an available family choice, never paper/operator equivalence. */
export function recipeMechanismFamilies(recipe: TSFCandidateRecipe): MechanismFamily[] {
  const branches = [recipe, ...(recipe.composition && "secondary" in recipe.composition ? [recipe.composition.secondary] : [])]
  const backbone = (types: string[]) => branches.some((branch) => types.includes(branch.backbone.type))
  const embedding = (types: string[]) => branches.some((branch) => types.includes(branch.embedding.type))
  const families: MechanismFamily[] = []
  const add = (family: MechanismFamily, present: boolean) => { if (present) families.push(family) }
  add("affine_temporal", backbone(["linear", "dlinear"]))
  add("nonlinear_temporal", backbone(["mlp", "nbeats", "tcn", "gated_depthwise_conv", "mixer", "timesblock_encoder", "timesnet_lite"]))
  add("trend_residual_decomposition", backbone(["dlinear"]) || recipe.preprocessing.actions.some((a) => a.type === "series_decomposition") || recipe.composition?.type === "decomposition_two_branch")
  add("local_patches", embedding(["patch", "multiscale_patch"]))
  add("multiscale_temporal", embedding(["multiscale_patch"]))
  add("spectral_representation", embedding(["frequency"]))
  add("temporal_convolution", backbone(["tcn", "gated_depthwise_conv", "timesblock_encoder", "timesnet_lite"]))
  add("temporal_attention", branches.some((b) => b.backbone.type === "transformer" && b.embedding.type !== "invert"))
  add("variate_tokens", embedding(["invert"]))
  add("channel_independent", recipe.fusion.type === "temporal" && recipe.fusion.channelMode === "independent" &&
    branches.every((b) => b.embedding.type !== "invert" && ["channel_latent", "channel_sequence"].includes(b.representation?.layout ?? "")))
  add("cross_channel_mixing", branches.some((b) => b.embedding.type === "invert" && b.backbone.type === "transformer") ||
    ["feature_mlp", "variate_attention", "temporal_then_feature", "feature_then_temporal", "graph", "gated_hybrid"].includes(recipe.fusion.type))
  add("instance_level_normalization", recipe.preprocessing.actions.some((a) => ["instance_norm", "last_value_centering"].includes(a.type)))
  add("adaptive_branch_fusion", recipe.composition?.type === "parallel_two_branch")
  add("residual_backcast", backbone(["nbeats"]))
  add("state_space", backbone(["diagonal_ssm", "mamba"]))
  add("recurrent_temporal", backbone(["rnn"]))
  return families
}

function at(value: unknown, path: string): unknown {
  return path.replace(/^\$\./, "").split(".").reduce<unknown>((item, key) =>
    item && typeof item === "object" && Object.hasOwn(item, key) ? (item as Record<string, unknown>)[key] : undefined, value)
}

export function matchedTargetEvidenceIssues(value: ArchitectureEligibility, task: Record<string, unknown>) {
  const context = architectureSelectionContext(task)
  return value.conditions.flatMap((condition) => {
    if (condition.scope === "input_channels" && condition.path === "$.quantitativeReport.dataset.targetColumns")
      return ["Input-channel prerequisites cannot be assessed from forecast targetColumns; use inputStructure.inputColumns/inputChannelCount"]
    if (condition.scope === "forecast_targets" && condition.path.startsWith("$.inputStructure.input"))
      return ["Forecast-target prerequisites cannot be assessed from input channels"]
    if (condition.status === "unknown") return []
    const actual = at(context, condition.path)
    if (condition.path.startsWith("$.inputStructure.") && actual === null)
      return [`Input/output structure is unavailable at ${condition.path}; classify its prerequisite as unknown`]
    const crossLag = at(task, "$.quantitativeReport.statistics.crossLag")
    const missingCrossLag = !crossLag || typeof crossLag !== "object" || !Object.keys(crossLag).length
    const measuredPairs = at(task, "$.quantitativeReport.profile.correlations.validPairCount")
    if (missingCrossLag && (condition.path === "$.quantitativeReport.statistics.crossLag" ||
      condition.path === "$.quantitativeReport.profile.crossVarCorrelation" && actual === 0 && !(typeof measuredPairs === "number" && measuredPairs > 0)))
      return [`Cross-channel diagnostics are unavailable at ${condition.path}; absence of a report is neither matched nor contradicted data-dependence evidence`]
    return actual === undefined || !isDeepStrictEqual(actual, condition.value) ? [`Target evidence does not match ${condition.path}`] : []
  })
}

/** Three-valued evaluation; an unknown alternative does not block a matched OR. */
export function targetConditionState(value: ArchitectureEligibility): ArchitectureEligibility["target"] {
  const groups = value.conditionLogic?.map((g) => g.alternatives) ?? value.conditions.map((_, i) => [i])
  if (!groups.length) return "unknown"
  const states = groups.map((group) => {
    const statuses = group.map((i) => value.conditions[i]?.status)
    if (statuses.includes("matched")) return "matched"
    if (statuses.every((s) => s === "contradicted")) return "mismatch"
    return "unknown"
  })
  return states.includes("mismatch") ? "mismatch" : states.every((s) => s === "matched") ? "matched" : "unknown"
}

export function conditionLogicIssues(value: ArchitectureEligibility) {
  if (!value.conditionLogic) return [] // Legacy reviews used an implicit conjunction.
  const indexes = value.conditionLogic.flatMap((g) => g.alternatives)
  const issues: string[] = []
  if (indexes.length !== value.conditions.length || new Set(indexes).size !== indexes.length ||
    indexes.some((i) => i >= value.conditions.length)) issues.push("Condition logic must cover each necessary data clause exactly once")
  if (value.target !== targetConditionState(value)) issues.push("Target assessment contradicts the AND/OR data-condition evidence; untested local gains are not a data prerequisite")
  return issues
}

export function familyWitnessIssues(value: ArchitectureEligibility) {
  const issues: string[] = []
  if (!value.familyMappings?.length) issues.push("Missing source-backed mechanism-family mapping and transfer boundaries")
  const recipe = TSFCandidateRecipe.safeParse(value.recipe)
  if (!recipe.success) issues.push("Implementation witness is not a valid ModelRecipe")
  else {
    if (recipe.data.recipeVersion !== "recipe_schema_v3" || !recipe.data.representation || !recipe.data.composition) issues.push("Family witness requires v3 with explicit representation and composition")
    const available = recipeMechanismFamilies(recipe.data)
    // A decision can prefer decomposition and deprioritize attention, or offer
    // several alternatives. One illustrative witness must express a cited
    // choice; it need not combine mutually exclusive prefer/avoid families.
    if (value.familyMappings?.length && !value.familyMappings.some((mapping) => available.includes(mapping.family)))
      issues.push(`Recipe does not express mechanism family: ${value.familyMappings[0]!.family}`)
  }
  if (!validMechanisms(value.requiredMechanisms)) issues.push("Unknown required mechanism")
  else {
    if (unsupportedMechanisms(value.requiredMechanisms).length) issues.push("Required mechanism is unsupported")
    if (recipe.success && value.requiredMechanisms.some((m) => !candidateMechanisms(recipe.data).includes(m))) issues.push("Recipe does not implement the required mechanism")
  }
  return issues
}

/** Runtime-owned adapter declarations for a non-executed family illustration.
 * This never changes scientific claims, operators, widths or experiment contracts.
 */
export function normalizeFamilyWitness(value: ArchitectureEligibility): ArchitectureEligibility {
  if (value.implementation !== "family_supported" || value.recipe?.recipeVersion !== "recipe_schema_v3") return value
  const recipe = structuredClone(value.recipe)
  const backbone = recipe.backbone as { type?: string } | undefined
  const legacy = backbone?.type && ["linear", "dlinear", "mlp", "transformer", "rnn", "tcn", "gated_depthwise_conv", "mixer", "nbeats", "timesnet_lite"].includes(backbone.type)
  if (legacy) {
    const repr = recipe.representation as Record<string, unknown> | undefined
    // Those encoders return channel latents even if internally they use tokens.
    if (repr) recipe.representation = { ...repr, layout: "channel_latent", readout: "none" }
  }
  if (!recipe.composition) recipe.composition = { type: "single" }
  const parsed = TSFCandidateRecipe.safeParse(recipe)
  // These describe the illustration's actual registry operations, not the
  // paper's original operator inventory or a selected experiment's contract.
  return { ...value, recipe, requiredMechanisms: parsed.success ? candidateMechanisms(parsed.data) : value.requiredMechanisms }
}

/** Admission is stricter than source validity. Unknown facts remain library knowledge. */
export function architectureEligibilityIssues(value: ArchitectureEligibility | undefined, task?: Record<string, unknown>) {
  if (!value) return ["Missing implementable-family, task-matched prediction review"]
  const issues: string[] = []
  if (value.implementation !== "family_supported") issues.push(`Mechanism family implementation is ${value.implementation}: ${value.implementationReason}`)
  if (value.target !== "matched") issues.push(`Target conditions are ${value.target}: ${value.targetReason}`)
  if (value.objective !== "prediction") issues.push(`Not a prediction-quality choice: ${value.predictionReason}`)
  if (value.requiredData.knownFutureCovariates || value.requiredData.staticCovariates) issues.push("ModelRecipe cannot consume known-future or static covariates")
  if (targetConditionState(value) !== "matched") issues.push("Necessary data conditions are not all established")
  issues.push(...conditionLogicIssues(value))
  if (task) issues.push(...matchedTargetEvidenceIssues(value, task))
  if (task) for (const key of ["knownFutureCovariates", "staticCovariates"] as const) {
    if (value.requiredData[key] && !(at(task, `$.quantitativeReport.dataset.${key}`) as unknown[] | undefined)?.length) issues.push(`Required ${key} are absent from this task`)
  }
  issues.push(...familyWitnessIssues(value))
  return issues
}

export function architectureSelectionContext(task: Record<string, unknown>) {
  const columns = (key: string) => {
    const value = at(task, `$.quantitativeReport.dataset.${key}`)
    return Array.isArray(value) ? value.filter((c): c is string => typeof c === "string") : undefined
  }
  const targets = columns("targetColumns")
  const past = columns("observedPastCovariates")
  const inputs = targets && past ? [...new Set([...targets, ...past])] : undefined
  return {
    ...task,
    inputStructure: {
      inputColumns: inputs ?? null, inputChannelCount: inputs?.length ?? null,
      targetColumns: targets ?? null, targetChannelCount: targets?.length ?? null,
      note: "Observed input channels include historical targets and observed-past covariates. A single forecast target does not mean a single input channel. null means unavailable, not zero.",
    },
    selectionPolicy: ARCHITECTURE_SELECTION_POLICY,
    modelCapabilities: MODEL_CAPABILITIES,
    recipeSchema: z.toJSONSchema(TSFCandidateRecipe),
    mechanismFamilies: MechanismFamilySchema.options,
    selectionInstruction: "Select source-backed MECHANISM-FAMILY choices for prediction quality that ModelRecipe can express. Exact reproduction of the paper operator, architecture, dataset, window or measured gain is NOT required. A valid recipe is only an expressibility witness for a prefer/avoid family. Record implementation differences as transfer boundaries. Keep necessary data prerequisites matched; exclude known mismatches and efficiency-only advice. No local replication prerequisite.",
  }
}

export const ARCHITECTURE_ELIGIBILITY_INSTRUCTION = `For every review supply eligibility independently of source acceptance. A faithful source can still be ineligible for THIS task.
implementation=family_supported means ModelRecipe can express the SOURCE-SUPPORTED MECHANISM FAMILY behind the choice, not reproduce the paper's exact operator. Supply familyMappings (registered mechanism family, role=prefer/avoid, source-backed rationale, explicit transferBoundaries) and a complete valid camelCase recipe_schema_v3 witness with explicit representation/latentDim and composition. The witness illustrates AT LEAST ONE available structural preference or exclusion, not all mutually exclusive alternatives in one model; its training settings do not override the task protocol. Unsupported/unknown reviews may use recipe=null and omit familyMappings or use an empty array. Use supplied modelCapabilities, mechanismFamilies and recipeSchema. requiredMechanisms refers ONLY to registry operations actually needed by this representative recipe, not every operator in the paper.
Generalize only to the level justified by original sources: the data property -> mechanism-family rationale -> structural preference must remain supported. An unsupported bespoke paper operator does not disqualify supported family knowledge from that paper. It can also support a source-backed negative rule about an available family. Never erase a necessary source data condition, invent a broader cause, or claim that two different operators are identical merely because they share a family.
DLinear/LTSF-Linear can guide affine temporal modeling, trend/residual separation and instance-level centering. Runtime encoders are latent-to-head implementations; this is a transfer boundary, NOT a veto on those families. PatchTST can guide contiguous local-patch representations and channel-wise modeling where their respective source data conditions hold. Source L=336 versus task L=96 is not an automatic veto. Decomposition need not use the identical smoother, nor must multi-resolution representations reproduce one particular pool-and-mix block, if the source supports the general family principle.
Frequency embedding supports spectral representation but is not complex FreMLP/IFFT or learned frequency masking. Retain this difference; source support for compact spectral representation may qualify, while an exact complex-operator claim cannot. Raw MLP already reads the entire context, so global receptive field alone cannot justify ranking frequency above raw MLP. Generic nbeats is residual backcast, not a fixed polynomial/Fourier basis. EMA, SparseTSF resampling, Koopman, lag-correlation attention and custom distillation must not be claimed implemented; inspect whether their sources separately justify an available broader family or an exclusion. Known-future/static-covariate requirements cannot be abstracted away.
target=matched requires every necessary DATA condition to be established by supplied task facts, with conditions listing the exact $.quantitativeReport... / $.taskContext... paths and their supplied values. requiredData must explicitly state whether knownFutureCovariates or staticCovariates are necessary. Missing diagnostics -> unknown; an empty knownFutureCovariates/staticCovariates array -> mismatch for rules needing them; a small known channel count -> mismatch for large-N rules. Every necessary clause in dataCondition must be accounted for in conditions; matching a nearby statistic while ignoring another necessary clause is not target=matched. A general distributionShift statistic does not establish a level-only shift, a last-value/mean threshold, or an unchanged future pattern. Do not invent those as prerequisites from a source that only says distribution shift. No fabricated properties, thresholds, or treating model choice itself as a data condition. ACF lag1 alone is not long-range dependence; a full-training-length spectral peak is not a verified stable period; crossVarCorrelation=0 plus empty crossLag does not establish weak/independent channels. H=96 is multistep even when H/L=1. An imposed decomposition period=24 is NOT an observed stable principal period.
conditions contains ONLY necessary source-backed data clauses, not implementation differences, local gain measurements or optional contextual observations. Set scope=input_channels for input-count/availability conditions, forecast_targets for output-count conditions, general otherwise. Assess input channels using $.inputStructure.inputColumns or $.inputStructure.inputChannelCount, NOT dataset.targetColumns. Output count uses $.inputStructure.targetChannelCount; seven inputs and one forecast target is a multivariate-input task.
Supply conditionLogic as AND across groups and OR within each group's alternatives (zero-based indexes into conditions). Every condition index occurs exactly once. Each group has sourceRationale explaining WHY this prerequisite/logic is necessary and sourceRefs with supplied original cardID/sourceIDs. Preserve 'smooth OR periodic', do not strengthen it to AND. A matched alternative satisfies its OR group even if another is unknown. target is mismatch if any group has all alternatives contradicted; matched if every group has at least one matched alternative; unknown otherwise. No stable-cycle prerequisite follows merely from energy concentration or from smoothness. No measured local improvement prerequisite is allowed. Important optional scientific context belongs in limitations, not conditions.
supported taskFit and matched target mean the DATA prerequisites hold, NOT that gains have already been measured on this task. Do not downgrade solely because source experiments used another dataset, L=336 instead of L=96, lack isolated ablations, or have not been reproduced locally. Keep those evidence/transfer limitations explicit. If window length is a genuinely necessary source condition, explain the exact original evidence for that prerequisite, rather than treating every source hyperparameter as mandatory. Do not call fixed positional embedding unsupported just because future covariates are absent: transformer already has additive positional embeddings; calendar fields and fixed positions are different operations.
objective=prediction requires source-backed reasoning about forecasting error/generalization or avoiding accuracy degradation under that data condition. Efficiency-only, interpretability-only, benchmark-ranking-only, protocol/evaluation-only, window/tuning, and training recipes are excluded. For mixed benefits retain only a source-supported accuracy structural rule; do not invent accuracy benefits from parameter/MAC reductions. Theory or attributed explanation can qualify; no new reproduction, significance test or isolated causal ablation is required.
The independent eligibility target assessment owns the final taskFit; taskFitCorrect checks THIS assessment against the report. Correct an extractor's overly cautious applicability label when its only uncertainty is untested local gains, but never promote unknown DATA prerequisites. Only verdict=accepted AND all semantic checks true AND implementation=family_supported AND target=matched AND objective=prediction can enter the task. Preserve other valid relationships in the library; classify them honestly instead of filling the handoff quota.`
