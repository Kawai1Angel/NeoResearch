import { checkExperimentConstraints } from "./experiment-constraints"
import { comparisonRecipe, hypothesisConstraints } from "./comparison-run"
import { candidateMechanisms } from "./model-capabilities"
import { createHash } from "crypto"
import type { HypothesisObject } from "./agents/hypo-planner-agent"
import type { ResearchCandidate, ResearchTask, JsonRecord } from "./schema"

export interface ContractMismatch {
  path: string
  expected: unknown
  actual: unknown
  source?: string
}

// Sorted object keys, preserved array order, UTF-8, ECMAScript JSON number encoding.
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(obj[key])}`)
      .join(",")}}`
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Non-finite contract number")
  return JSON.stringify(value)
}
export function digest(value: unknown) {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex")
}
export interface ExecutedModelManifest {
  event: "executed_model_manifest"
  schema_version: "executed_model_manifest.v1"
  candidate_id: string
  candidate_spec_sha256: string
  contract_digest: string
  actual: Record<string, unknown>
}

export interface ExecutionContract {
  schema_version: "research_execution_contract.v1"
  task_id: string
  hypothesis_id: string | null
  candidate_id: string
  candidate_spec_sha256: string
  experiment_constraints_sha256?: string
  expected: Record<string, unknown>
}

export function buildExecutionContract(
  task: ResearchTask,
  candidate: ResearchCandidate,
  payload: JsonRecord,
): ExecutionContract {
  const spec = candidate.candidateSpec as any
  const dataset = task.taskSpec.dataset as any
  const targets = dataset?.targetCols?.length ?? 1
  return {
    schema_version: "research_execution_contract.v1",
    task_id: task.id,
    hypothesis_id: candidate.hypothesisID ?? null,
    candidate_id: candidate.id,
    candidate_spec_sha256: digest(payload),
    experiment_constraints_sha256: digest(hypothesisConstraints(task.id, candidate.hypothesisID)),
    expected: {
      input_length: task.taskSpec.contextLength,
      head_input_width: spec.representation?.latentDim ?? Math.min(Number(task.taskSpec.contextLength), 64),
      head_channel_shared: true,
      mechanisms: candidateMechanisms(spec),
      runtime_semantics_revision: spec.recipeVersion === "recipe_schema_v3" ? 3 : 2,
      recipe_version: spec.recipeVersion,
      preprocessing: spec.preprocessing.actions.map((action: any) => action.type),
      embedding: spec.embedding.type,
      backbone: spec.backbone.type,
      ...(spec.backbone.type === "linear" ? { linear_shared: spec.backbone.shared ?? false } : {}),
      fusion: spec.fusion.type,
      ...(spec.fusion.type === "gated_hybrid" ? { fusion_gate_type: spec.fusion.gateType ?? "channel" } : {}),
      ...(["temporal_then_feature", "feature_then_temporal"].includes(spec.fusion.type)
        ? { fusion_gate: spec.fusion.gate ?? false, fusion_residual: spec.fusion.residual ?? false }
        : {}),
      channel_mode: spec.fusion.channelMode ?? "independent",
      prediction_head: spec.predictionHead.type,
      target_channels: targets,
      past_exogenous_channels: dataset?.observedPastCovariates?.length ?? 0,
      future_exogenous_channels: dataset?.knownFutureCovariates?.length ?? 0,
      output_channels: targets,
    },
  }
}

export function validateCandidateAgainstHypothesis(
  hypothesis: HypothesisObject,
  candidate: ResearchCandidate,
  selectedRecipe?: JsonRecord,
  taskSpec?: JsonRecord,
): ContractMismatch[] {
  const spec = candidate.candidateSpec as any
  const mismatches: ContractMismatch[] = []
  const add = (path: string, expected: unknown, actual: unknown) =>
    mismatches.push({ path, expected, actual: actual ?? null, source: "hypothesis_candidate_gate" })
  if (hypothesis.experimentContract) mismatches.push(...checkExperimentConstraints(hypothesis.experimentContract, spec, comparisonRecipe(candidate.taskID, hypothesis.experimentContract.comparisonRunID)))
  const mechanisms = candidateMechanisms(spec)
  for (const required of hypothesis.requiredMechanisms ?? [])
    if (!mechanisms.includes(required)) add(`requiredMechanisms.${required}`, true, false)
  if (candidate.hypothesisID !== hypothesis.id) add("hypothesis_id", hypothesis.id, candidate.hypothesisID)
  const aliases: Record<string, string> = {
    patch_transformer: "transformer",
    itransformer: "transformer",
    nlinear: "linear",
  }
  const allowed = [...new Set(hypothesis.suggestedBackbones.map((name) => aliases[name] ?? name))]
  if (allowed.length && !allowed.includes(spec.backbone?.type)) add("backbone", allowed, spec.backbone?.type)
  const requiredEmbeddings: Record<string, string> = {
    patch_transformer: "patch",
    itransformer: "invert",
    nlinear: "none",
  }
  const matching = hypothesis.suggestedBackbones.filter((name) => (aliases[name] ?? name) === spec.backbone?.type)
  if (
    matching.length &&
    matching.every((name) => requiredEmbeddings[name] && requiredEmbeddings[name] !== spec.embedding?.type)
  )
    add(
      "embedding",
      matching.map((name) => requiredEmbeddings[name]),
      spec.embedding?.type,
    )
  if (selectedRecipe) {
    const selected = selectedRecipe as any
    if (selected.backbone?.type && selected.backbone.type !== spec.backbone?.type)
      add("selected_backbone", selected.backbone.type, spec.backbone?.type)
    const preprocessing = selected.preprocessing?.actions?.map((action: any) => action.type)
    const actual = spec.preprocessing?.actions?.map((action: any) => action.type)
    if (preprocessing && canonicalize(preprocessing) !== canonicalize(actual ?? null))
      add("preprocessing", preprocessing, actual)
  }
  if (taskSpec)
    for (const role of ["observedPastCovariates", "knownFutureCovariates"] as const) {
      const declared = spec.input?.[role] ?? spec[role]
      const available = (taskSpec.dataset as any)?.[role] ?? []
      if (Array.isArray(declared) && declared.some((column: unknown) => !available.includes(column)))
        add(role, available, declared)
    }
  return mismatches
}

export function verifyExecutionRecords(
  contract: ExecutionContract,
  records: readonly Record<string, unknown>[],
): ContractMismatch[] {
  const manifest = records.findLast((record) => record?.event === "executed_model_manifest")
  const verified = records.findLast((record) => record?.event === "execution_contract_verified")
  const violation = records.findLast((record) => record?.event === "execution_contract_violation")
  if (violation)
    return (
      (Array.isArray(violation.mismatches) && violation.mismatches.length
        ? (violation.mismatches as ContractMismatch[])
        : undefined) ?? [{ path: "violation", expected: null, actual: violation }]
    )
  const mismatches: ContractMismatch[] = []
  for (const [name, record] of [
    ["manifest", manifest],
    ["verification", verified],
  ] as const) {
    if (!record) {
      mismatches.push({ path: name, expected: "present", actual: null })
      continue
    }
    for (const [field, expected] of Object.entries({
      candidate_id: contract.candidate_id,
      candidate_spec_sha256: contract.candidate_spec_sha256,
      contract_digest: digest(contract),
    })) {
      if (record[field] !== expected)
        mismatches.push({ path: `${name}.${field}`, expected, actual: record[field] ?? null })
    }
  }
  for (const current of records.filter((record) => record?.event === "executed_model_manifest")) {
    for (const [field, expected] of Object.entries({
      candidate_id: contract.candidate_id,
      candidate_spec_sha256: contract.candidate_spec_sha256,
      contract_digest: digest(contract),
    }))
      if (current[field] !== expected)
        mismatches.push({ path: `manifest.${field}`, expected, actual: current[field] ?? null })
    for (const [path, expected] of Object.entries(contract.expected)) {
      const actual = (current.actual as Record<string, unknown> | undefined)?.[path]
      if (canonicalize(actual ?? null) !== canonicalize(expected))
        mismatches.push({ path, expected, actual: actual ?? null })
    }
  }
  // CV folds can interleave their output. A proof from one fold cannot cover
  // another fold, and a later valid proof cannot hide an earlier invalid one.
  const scopes = new Map<string, { manifest: number; proof: number }>()
  for (const [index, record] of records.entries()) {
    if (record?.event !== "executed_model_manifest" && record?.event !== "execution_contract_verified") continue
    const scope = record.cv_fold_index === undefined ? "standard" : `fold:${record.cv_fold_index}`
    const state = scopes.get(scope) ?? { manifest: -1, proof: -1 }
    if (record.event === "executed_model_manifest") state.manifest = index
    else {
      state.proof = index
      for (const [field, expected] of Object.entries({
        candidate_id: contract.candidate_id,
        candidate_spec_sha256: contract.candidate_spec_sha256,
        contract_digest: digest(contract),
        status: "verified",
      }))
        if (record[field] !== expected)
          mismatches.push({ path: `verification.${field}`, expected, actual: record[field] ?? null })
      if (state.manifest < 0)
        mismatches.push({ path: `verification.${scope}`, expected: "preceding manifest in the same scope", actual: null })
    }
    scopes.set(scope, state)
  }
  for (const [scope, state] of scopes)
    if (state.manifest >= 0 && state.proof < state.manifest)
      mismatches.push({ path: `verification.${scope}`, expected: "proof after the final manifest in this scope", actual: null })
  return mismatches
}
