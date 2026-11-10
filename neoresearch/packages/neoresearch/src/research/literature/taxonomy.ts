import { readFile } from "fs/promises"

export type LiteratureTaxonomy = {
  readonly schemaVersion: "literature_taxonomy_v1"
  readonly mechanisms: Record<string, readonly string[]>
  readonly data_features: Record<string, readonly string[]>
  readonly task_types: Record<string, readonly string[]>
}

function token(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "")
}

export async function loadTaxonomy(path: string): Promise<LiteratureTaxonomy> {
  const value = JSON.parse(await readFile(path, "utf8")) as LiteratureTaxonomy
  if (value.schemaVersion !== "literature_taxonomy_v1") throw new Error("Unsupported literature taxonomy")
  return value
}

export function normalizeTerm(value: string, taxonomy: LiteratureTaxonomy) {
  const needle = token(value)
  for (const group of [taxonomy.mechanisms, taxonomy.data_features, taxonomy.task_types]) {
    for (const [canonical, aliases] of Object.entries(group)) {
      if (token(canonical) === needle || aliases.some((alias) => token(alias) === needle)) return canonical
    }
  }
  return needle
}

export function normalizeClaimPart(value: string, taxonomy: LiteratureTaxonomy) {
  const direct = normalizeTerm(value, taxonomy)
  if (direct && direct !== token(value)) return direct
  let result = token(value)
  for (const group of [taxonomy.mechanisms, taxonomy.data_features, taxonomy.task_types]) {
    for (const [canonical, aliases] of Object.entries(group)) {
      for (const alias of [canonical, ...aliases]) {
        const aliasToken = token(alias)
        if (aliasToken && result.includes(aliasToken)) result = result.replaceAll(aliasToken, canonical)
      }
    }
  }
  return result
}
