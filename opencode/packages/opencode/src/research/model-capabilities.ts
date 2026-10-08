import registry from "./model-capabilities.json"

// This packaged snapshot mirrors the Python registry. A synchronization test keeps
// both agents and runtime releases on the same implementation contract.
export const MODEL_CAPABILITIES = registry
export type ModelMechanism = keyof typeof registry.mechanisms

export function unsupportedMechanisms(required: readonly ModelMechanism[]) {
  return required.filter((m) => registry.unsupported_mechanisms.includes(m))
}

export function validMechanisms(value: unknown): value is ModelMechanism[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string" && Object.hasOwn(registry.mechanisms, item))
  )
}

export function candidateMechanisms(spec: any): ModelMechanism[] {
  const backbones = registry.backbones as Record<string, { mechanisms: ModelMechanism[] }>
  const preprocessing = registry.preprocessing as Record<string, ModelMechanism[]>
  const embeddings = registry.embeddings as Record<string, ModelMechanism[]>
  const branch = (item: any) => [
    ...(backbones[item?.backbone?.type]?.mechanisms ?? []),
    ...(embeddings[item?.embedding?.type]?.filter(() => (item.embedding.scales?.length ?? 0) > 1) ?? []),
  ]
  return [
    ...new Set([
      ...branch(spec),
      ...branch(spec?.composition?.secondary),
      ...(spec?.composition?.type === "decomposition_two_branch" ? ["moving_average_decomposition" as const] : []),
      ...(spec?.preprocessing?.actions ?? []).flatMap((action: any) => preprocessing[action.type] ?? []),
    ]),
  ].sort()
}
