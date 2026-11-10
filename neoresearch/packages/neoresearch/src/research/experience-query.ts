import capabilities from "./model-capabilities.json"
// Retrieval aliases broaden discovery only; they do not establish scientific equivalence.
const aliases = [
  ["width", "hidden dimension", "hidden dimensions", "hidden dim", "hidden_dim", "hiddendim", "hidden layer dimension"],
  ["capacity"], ["depth", "layer count"],
  ["normalization", "normalisation"],
  ["learningrate", "learning rate", "learning rates", "lr"],
  ["warmup", "warm up"],
  ["gradclip", "grad clip", "gradient clipping"],
  ["exogenous", "covariate", "covariates", "exogenous variables"],
  ["trend"], ["seasonality", "seasonal", "periodicity"],
  ["instability", "unstable", "oscillation"],
  ["decomposition", "decompose"], ["fusion"],
  ["variance"], ["replication", "replicate", "repeat experiment"],
  ["seed", "random seed"],
  ["frequency", "fft", "rfft", "spectral", "frequency domain", "spectrum"],
  ["rnn", "recurrent network"], ["backbone"],
  ["embedding"], ["residual"], ["branch"],
  ["calendar"], ["kernel", "kernel size", "kernelsize"],
] as const
const stopwords = new Set(("a an the and or of in on for to with without vs versus under between from by at " +
  "is are was were be been this that these those it its as into than then using use used does not no " +
  "model models run runs experiment experiments time series forecast forecasting prediction predictor null true false training execution failure error mode called can only intervention sensitivity test testing try verify validation result results evidence").split(" "))

export function normalizeExperienceText(value: string) {
  return value.normalize("NFKC").replace(/([a-z\d])([A-Z])/g, "$1 $2").toLowerCase()
    .replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim()
}

const replacements = aliases.flatMap(([canonical, ...variants]) => [canonical, ...variants]
  .map(variant => ({ canonical, variant: normalizeExperienceText(variant) })))
  .sort((a, b) => b.variant.length - a.variant.length)
const replacementMap = new Map(replacements.map(item => [item.variant, item.canonical]))
const aliasPattern = new RegExp(replacements.map(({ variant }) =>
  /\p{Script=Han}/u.test(variant) ? variant : `(?<![a-z0-9])${variant}(?![a-z0-9])`).join("|"), "gu")

export function experienceTokens(text: string, preserveStopwords = false) {
  const normalized = normalizeExperienceText(text).replace(aliasPattern, match => ` ${replacementMap.get(match)!} `)
  const words = normalized.match(/[a-z][a-z0-9]*|\p{Script=Han}+/gu) ?? []
  return words.flatMap(word => {
    if (!preserveStopwords && stopwords.has(word)) return []
    // Character bigrams support unsegmented text without a tokenizer service.
    if (/\p{Script=Han}/u.test(word)) {
      const chars = [...word]
      return chars.slice(1).flatMap((char, index) => /\p{Script=Han}/u.test(char) && /\p{Script=Han}/u.test(chars[index]!)
        ? [chars[index]! + char] : [])
    }
    return [word]
  })
}

export const EXPERIENCE_QUERY_INTENTS = ["auto", "execution_error", "configuration", "intervention", "comparison", "discovery"] as const
export type ExperienceQueryIntent = typeof EXPERIENCE_QUERY_INTENTS[number]
export type ExperienceEntity = { component: "backbone" | "embedding" | "fusion" | "preprocessing" | "cell"; name: string; terms: string[] }
const components = ["backbone", "embedding", "fusion", "preprocessing"] as const
const names: ExperienceEntity[] = [...components.flatMap(component => Object.keys(capabilities.component_semantics[component])
  .map(name => ({ component, name, terms: experienceTokens(name, true) })))
  , ...["gru", "lstm"].map(name => ({ component: "cell" as const, name, terms: [name] }))]
export const experienceAxisTerms = new Set(["width", "depth", "capacity", "learningrate", "warmup", "gradclip", "kernel", "seed"])
const comparisonCue = /\b(compare|comparison|versus|vs|against)\b/iu
const compositionCue = /decompos|series[_ ]decomposition|trend.*residual|residual.*trend|two[_ ]branch/iu
const failureCue = /\b(cudnn|backward|exception|traceback|oom|failure|failed)\b|out of memory|(?:runtime|execution|training)[_ ]?error/iu
const effectCue = /\b(effects?|effective|effectiveness|improve[ds]?|improvements?|sensitivity|intervention|impact|benefit)\b/iu

export function parseExperienceQuery(query: string, override: ExperienceQueryIntent = "auto") {
  const terms = [...new Set(experienceTokens(query))].slice(0, 128)
  const querySet = new Set(terms)
  // "none" remains an explicit entity value even though it is not a search keyword.
  const normalized = normalizeExperienceText(query)
  const sequence = experienceTokens(query, true)
  const candidates = names.map(entity => ({ ...entity, positions: sequence.flatMap((_, index) =>
    entity.terms.length && entity.terms.every((term, offset) => sequence[index + offset] === term) ? [index] : []) }))
    .filter(entity => entity.positions.length)
  const noneComponent = (position: number) => {
    const explicit = components.map(component => ({ component, position: sequence.lastIndexOf(component, position) }))
      .filter(item => item.position >= 0).sort((a, b) => b.position - a.position)[0]
    if (explicit) return explicit.component
    const inferred = [...new Set(candidates.filter(entity => entity.name !== "none" &&
      components.some(component => component === entity.component && "none" in capabilities.component_semantics[component]))
      .map(entity => entity.component))]
    return inferred.length === 1 ? inferred[0] : "embedding"
  }
  const entities: ExperienceEntity[] = candidates.filter(entity => entity.positions.some(position => !candidates.some(other =>
    other.terms.length > entity.terms.length && other.positions.some(start => start <= position && start + other.terms.length >= position + entity.terms.length))))
    .filter(entity => entity.name !== "none" || entity.positions.some(position => noneComponent(position) === entity.component))
    .map(({ positions, ...entity }) => entity)
  const architectureCount = entities.filter(entity => ["backbone", "cell"].includes(entity.component)).length
  const axes = experienceTokens(query.replace(/[a-z][a-z0-9_.]*\s*=\s*-?\d+(?:\.\d+)?/gi, ""))
    .filter(term => experienceAxisTerms.has(term))
  const compound = compositionCue.test(query)
  const isError = failureCue.test(query) || /\berror\b/.test(normalized) && !/\b(prediction|forecast|mse|mae)\b/.test(normalized)
  const inferred = isError ? "execution_error" : comparisonCue.test(query) ? "comparison"
    : /[a-z][a-z0-9_.]*\s*=\s*\d/i.test(query) ? "configuration"
    : effectCue.test(query) || axes.length && !compound ? "intervention"
    : architectureCount > 1 && !compound && !/\band\b|\+/iu.test(query) ? "discovery"
    : "configuration"
  const intent = override === "auto" ? inferred : override
  const mechanisms = [...new Set([
    ...(/\bseries[_ ]decomposition\b/i.test(query) ? ["series_decomposition"] : []),
    ...(/\bdecomposition[_ ]two[_ ]branch\b/i.test(query) ? ["decomposition_two_branch"] : []),
    ...(querySet.has("decomposition") ? ["decomposition"] : []),
    ...(compound && querySet.has("trend") ? ["trend_branch"] : []),
    ...(compound && querySet.has("residual") ? ["residual_branch"] : []),
    ...(/\b(two[_ ]branch|parallel[_ ]two[_ ]branch)\b/iu.test(query) ? ["two_branch"] : []),
  ])]
  const branchRoles = (["trend", "residual"] as const).flatMap(role => {
    const marker = role
    return entities.filter(entity => entity.component === "backbone" || entity.component === "cell")
      .filter(entity => new RegExp(`${marker}(?:[ _-]*branch)?[\\s:=：-]*(?:(?:uses?|using|is)[\\s:=：-]*)?${entity.name}\\b`, "iu").test(query))
      .map(entity => ({ role, entity }))
  })
  const dataConditions = /weak(?:ly)?[_ ]correlat|low[_ ]correlat/iu.test(query)
    ? ["weak_correlation_requires_explicit_statistic_scope_and_threshold"] : []
  const groups = components.flatMap(component => {
    const values = entities.filter(entity => entity.component === component).map(entity => entity.name)
    return values.length > 1 ? [{ component, alternatives: values }] : []
  })
  return { intent, inferred: override === "auto", terms, axes, entities, mechanisms, branchRoles, dataConditions,
    entityMode: intent === "discovery" ? "alternatives" : intent === "comparison" ? "paired_arms" : "same_run",
    alternativeGroups: groups, parser: "structured_query.v1" as const }
}
export type ExperienceQueryPlan = ReturnType<typeof parseExperienceQuery>
