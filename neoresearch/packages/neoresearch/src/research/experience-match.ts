import type { ExperimentFact } from "./experience"
import type { experienceRepresentation } from "./experience-representation"
import { experienceTokens, type ExperienceEntity, type ExperienceQueryPlan } from "./experience-query"

type View = ReturnType<typeof experienceRepresentation>
type Configuration = View["configurations"][number]
export type ExperienceCondition = { requirement: string; status: "matched" | "missing" | "unknown"; source?: string; value?: unknown }
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const name = (value: unknown) => typeof value === "string" ? value : typeof object(value).type === "string" ? object(value).type as string : undefined
const matches = (left: ExperienceEntity, right: ExperienceEntity) => left.component === right.component && left.name === right.name

/** Operator/branch witnesses come from verified structure; internal skip connections are not decomposition. */
export function configurationWitnesses(config: Configuration) {
  const entities: ExperienceEntity[] = []
  const mechanisms = new Set<string>()
  const roles: { role: "trend" | "residual"; entities: ExperienceEntity[] }[] = []
  if (config.status !== "execution_verified") return { entities, mechanisms: [], roles }
  const recipe = config.recipe ?? {}
  const actual = config.actual ?? {}
  const componentEntities = (recipe: Record<string, unknown>, actual: Record<string, unknown>): ExperienceEntity[] => {
    const values = (["backbone", "embedding", "fusion"] as const).flatMap(component => {
      const value = name(actual[component]) ?? name(recipe[component])
      return value ? [{ component, name: value, terms: experienceTokens(value) }] : []
    }) as ExperienceEntity[]
    const cell = actual.rnn_cell ?? object(actual.backbone).cell ?? object(recipe.backbone).cell
    if (name(actual.backbone) === "rnn" || name(recipe.backbone) === "rnn") {
      if (cell === "gru" || cell === "lstm") values.push({ component: "cell", name: cell, terms: [cell] })
    }
    return values
  }
  const primary = componentEntities(recipe, actual)
  entities.push(...primary)
  const composition = object(actual.composition ?? recipe.composition)
  const secondaryRecipe = object(object(recipe.composition).secondary ?? composition.secondary)
  const secondary = componentEntities(secondaryRecipe, object(actual.secondary))
  const compositionType = name(composition)
  if (["parallel_two_branch", "decomposition_two_branch"].includes(compositionType ?? "")) {
    entities.push(...secondary)
    mechanisms.add("two_branch")
  }
  const preprocessing = actual.preprocessing ?? object(recipe.preprocessing).actions
  const actions = Array.isArray(preprocessing) ? preprocessing.map(name) : []
  for (const action of actions) if (action) entities.push({ component: "preprocessing", name: action, terms: experienceTokens(action) })
  const seriesDecomposition = actions.includes("series_decomposition")
  const dlinear = primary.some(entity => entity.component === "backbone" && entity.name === "dlinear")
  if (seriesDecomposition) mechanisms.add("series_decomposition")
  if (compositionType === "decomposition_two_branch") mechanisms.add("decomposition_two_branch")
  if (seriesDecomposition || dlinear || compositionType === "decomposition_two_branch") mechanisms.add("decomposition")
  // Only the known native runtime semantics establishes which input reaches each branch.
  if (actual.runtime_semantics_revision === 3) {
    const linear: ExperienceEntity = { component: "backbone", name: "linear", terms: ["linear"] }
    if (compositionType === "decomposition_two_branch") roles.push({ role: "trend", entities: primary }, { role: "residual", entities: secondary })
    else if (seriesDecomposition) roles.push({ role: "trend", entities: [linear] }, { role: "residual", entities: primary })
    else if (dlinear) roles.push({ role: "trend", entities: [linear] }, { role: "residual", entities: [linear] })
  }
  for (const role of roles) mechanisms.add(`${role.role}_branch`)
  return { entities, mechanisms: [...mechanisms], roles }
}

type Run = { config: Configuration; fact: ExperimentFact; error?: string; witnesses: ReturnType<typeof configurationWitnesses> }
function entityCondition(entity: ExperienceEntity, run: Run, plan: ExperienceQueryPlan): ExperienceCondition {
  const roleWitnesses = plan.branchRoles.flatMap(role => run.witnesses.roles.filter(witness => witness.role === role.role).flatMap(witness => witness.entities))
  const present = [...run.witnesses.entities, ...roleWitnesses].some(witness => matches(witness, entity))
  // A generic RNN exception establishes the parent family only, never the GRU/LSTM cell.
  const errorWitness = plan.intent === "execution_error" && run.error &&
    (entity.component === "backbone" && entity.name === "rnn" && /\bRNN\b/i.test(run.error) ||
      entity.component === "embedding" && entity.name === "calendar" && /calendar[_ ](?:embedding|features)/i.test(run.error))
  return { requirement: `${entity.component}=${entity.name}`, status: present || errorWitness ? "matched" : "missing",
    ...(present ? { source: "verified_configuration" } : errorWitness ? { source: "observed_error" } : {}) }
}
function entityConditions(plan: ExperienceQueryPlan, runs: Run[]): ExperienceCondition[] {
  const grouped = new Map<string, ExperienceEntity[]>()
  for (const entity of plan.entities) {
    const component = ["backbone", "cell"].includes(entity.component) ? "architecture" : entity.component
    const key = plan.intent === "discovery" ? component : entity.component
    grouped.set(key, [...(grouped.get(key) ?? []), entity])
  }
  return [...grouped.entries()].flatMap(([component, entities]) => {
    if (plan.intent === "discovery" && entities.length > 1) {
      const witnesses = entities.flatMap(entity => runs.map(run => entityCondition(entity, run, plan))).filter(condition => condition.status === "matched")
      return [{ requirement: `${component}:any(${entities.map(entity => entity.name).join(",")})`,
        status: witnesses.length ? "matched" : "missing", source: witnesses.length ? "verified_configuration" : undefined }]
    }
    if (plan.intent === "comparison" && entities.length > 2) {
      const covered = entities.filter(entity => runs.some(run => entityCondition(entity, run, plan).status === "matched"))
      return [{ requirement: `${component}:paired_alternatives(${entities.map(entity => entity.name).join(",")})`,
        status: covered.length >= 2 ? "matched" : "missing", source: "paired_configurations" }]
    }
    return entities.map(entity => {
      const witnesses = runs.map(run => entityCondition(entity, run, plan))
      return witnesses.find(condition => condition.status === "matched") ?? witnesses[0]!
    })
  })
}
function structuralConditions(plan: ExperienceQueryPlan, runs: Run[]): ExperienceCondition[] {
  return [
    ...plan.mechanisms.map(mechanism => ({ requirement: `mechanism=${mechanism}`,
      status: runs.some(run => run.witnesses.mechanisms.includes(mechanism)) ? "matched" : "missing", source: "verified_operator_structure" } as ExperienceCondition)),
    ...plan.branchRoles.map(role => ({ requirement: `${role.role}.${role.entity.component}=${role.entity.name}`,
      status: runs.some(run => run.witnesses.roles.some(witness => witness.role === role.role && witness.entities.some(entity => matches(entity, role.entity))))
        ? "matched" : "missing", source: "native_runtime_branch_routing" } as ExperienceCondition)),
    ...plan.dataConditions.map(condition => ({ requirement: condition, status: "unknown" as const,
      source: "captured_dataset_profile", value: runs.map(run => ({ runID: run.fact.runID,
        correlations: object(object(run.fact.taskFingerprint).datasetProfile).correlations })) })),
  ]
}
function errorConditions(plan: ExperienceQueryPlan, run: Run): ExperienceCondition[] {
  if (plan.intent !== "execution_error") return []
  const errorTerms = new Set(experienceTokens(run.error ?? ""))
  const anchors = plan.terms.filter(term => ["cudnn", "backward", "calendar", "memory", "oom"].includes(term))
  return [{ requirement: "observed_runtime_error", status: run.error ? "matched" : "missing", source: "observed_error" },
    ...anchors.map(term => ({ requirement: `error_contains=${term}`, status: errorTerms.has(term) ? "matched" : "missing", source: "observed_error" } as ExperienceCondition))]
}

export function matchExperienceQuery(plan: ExperienceQueryPlan, view: View, facts: ExperimentFact[],
  context: (fact: ExperimentFact, config: Configuration) => ExperienceCondition[]) {
  const runs: Run[] = view.configurations.map(config => ({ config, fact: facts.find(fact => fact.runID === config.runID)!,
    error: view.observations.find(observation => observation.runID === config.runID)?.error,
    witnesses: configurationWitnesses(config) }))
  const evaluated = runs.map(run => ({ runs: [run], conditions: [
    { requirement: "observed_configuration_or_error", status: run.config.status === "execution_verified" || run.error ? "matched" : "missing" } as ExperienceCondition,
    ...context(run.fact, run.config), ...entityConditions(plan, [run]), ...structuralConditions(plan, [run]), ...errorConditions(plan, run),
  ] }))
  const candidates = plan.intent === "comparison" ? view.interventions.filter(intervention => intervention.contrast).flatMap(intervention => {
    const pair = runs.filter(run => run.config.runID === intervention.runID || run.config.runID === intervention.comparisonRunID)
    if (pair.length !== 2) return []
    const changedEntity = plan.entities.length < 2 || plan.entities.some(entity =>
      entityCondition(entity, pair[0]!, plan).status !== entityCondition(entity, pair[1]!, plan).status)
    return [{ runs: pair, conditions: [
      { requirement: "verified_matched_full_run_comparison", status: "matched", source: `${intervention.runID} vs ${intervention.comparisonRunID}` } as ExperienceCondition,
      { requirement: "queried_entity_contrast", status: changedEntity ? "matched" : "missing" } as ExperienceCondition,
      ...pair.flatMap(run => context(run.fact, run.config)), ...entityConditions(plan, pair), ...structuralConditions(plan, pair),
    ] }]
  }) : evaluated
  const empty = { runs: [] as Run[], conditions: [{ requirement: "verified_matched_full_run_comparison", status: "missing" } as ExperienceCondition,
    ...entityConditions(plan, runs), ...structuralConditions(plan, runs)] }
  const ranked = (candidates.length ? candidates : [empty]).map(candidate => ({ ...candidate,
    complete: candidate.conditions.every(condition => condition.status === "matched"),
    matched: candidate.conditions.filter(condition => condition.status === "matched").length,
  })).sort((a, b) => Number(b.complete) - Number(a.complete) || b.matched - a.matched)
  const complete = ranked.filter(candidate => candidate.complete)
  const best = ranked[0]!
  return { complete: complete.length > 0,
    matchingRunIDs: [...new Set(complete.flatMap(candidate => candidate.runs.map(run => run.config.runID)))],
    conditions: best.conditions,
    matchedRequiredConditions: best.conditions.filter(condition => condition.status === "matched"),
    missingRequiredConditions: best.conditions.filter(condition => condition.status !== "matched"),
    candidateRunIDs: best.runs.map(run => run.config.runID),
    factualEntityMatch: evaluated.some(candidate => candidate.conditions.some(condition =>
      /^(backbone|embedding|fusion|preprocessing|cell)=/.test(condition.requirement) && condition.status === "matched")),
  }
}
