import type { ResearchExperience } from "./experience"
import type { ResearchMemory, JsonRecord } from "./schema"
import { experienceRepresentation } from "./experience-representation"
import { experienceTokens as tokens, parseExperienceQuery, type ExperienceQueryIntent } from "./experience-query"
import { matchExperienceQuery, type ExperienceCondition } from "./experience-match"
import path from "node:path"
import { fieldValue } from "./experiment-constraints"
import { normalizedRecipePath } from "./recipe-naming"

export const EXPERIENCE_SEARCH_METHOD = "intent_grounded_bm25_v3"

type Entry = { memory: ResearchMemory; experience: ResearchExperience }
type SearchOptions = { includeBackground?: boolean; deduplicate?: boolean; intent?: ExperienceQueryIntent }
const componentRoots = ["backbone", "embedding", "fusion", "preprocessing", "representation", "prediction head"]
const encoded = (value: unknown) => JSON.stringify(value) ?? ""
const wordSet = (value: unknown) => new Set(tokens(encoded(value)))
function interventionTerms(changes: { path: string }[]) {
  return { changes, concepts: changes.flatMap(change => {
    if (change.path.startsWith("preprocessing") && /instance[_ ]norm|revin/.test(encoded(change))) return ["normalization"]
    if (/\.(hiddenDim|latentDim|correctionDim|dModel|depth|numLayers|nLayers|nBlocks)$/.test(change.path))
      return /\.(depth|numLayers|nLayers|nBlocks)$/.test(change.path) ? ["capacity", "depth"] : ["capacity"]
    return []
  }) }
}
function matchesNumericField(recipe: unknown, field: string, value: number): boolean {
  if (field.includes(".")) return fieldValue(recipe, field) === value
  if (!recipe || typeof recipe !== "object") return false
  return Object.entries(recipe).some(([key, item]) => key === field && item === value || matchesNumericField(item, field, value))
}

/** Only captured factual fields establish a match. Proposals are explicit opt-in background. */
export function rankExperiences(entries: Entry[], query?: string, options: SearchOptions = {}) {
  if (!query?.trim()) {
    const seen = new Set<string>()
    return entries.flatMap(({ memory }) => {
      const organization = memory.candidateSummary.experienceOrganization as { threadID?: string; conditionalExperience?: { status: string } } | undefined
      const key = options.deduplicate !== false && organization?.conditionalExperience?.status === "explicit_hypothesis"
        ? organization.threadID ?? memory.id : memory.id
      if (seen.has(key)) return []
      seen.add(key)
      return [memory]
    })
  }
  const plan = parseExperienceQuery(query, options.intent)
  const terms = plan.terms
  if (!terms.length && plan.intent !== "execution_error") return []
  const querySet = new Set(terms)
  const axes = plan.axes
  const focalAxes = axes.filter(axis => axis !== "capacity" || axes.length === 1)
  const datasetNames = [...new Set(entries.flatMap(entry => entry.experience.facts.flatMap(fact => {
    const file = fact.dataset.specification.path
    return typeof file === "string" ? [path.basename(file, path.extname(file))] : []
  })))].filter(name => tokens(name).length && tokens(name).every(term => querySet.has(term)))
  const requirements = [...query.matchAll(/([a-z][a-z0-9_.]*)\s*=\s*(-?\d+(?:\.\d+)?)/gi)].map(match => ({
    path: normalizedRecipePath(match[1]!), value: Number(match[2]),
  }))
  const roots = componentRoots.filter(root => root.split(" ").every(term => querySet.has(term)))
  const documents = entries.map(({ memory, experience }) => {
    const view = experienceRepresentation(experience)
    const verified = view.configurations.filter(config => config.status === "execution_verified")
    const changes = view.interventions.filter(change => change.status === "verified_changes")
    const errors = view.observations.flatMap(observation => observation.error ? [{ runID: observation.runID, error: observation.error }] : [])
    const fields = [
      { name: "verified_interventions", value: changes.map(change => interventionTerms(change.changes)), weight: 5 },
      { name: "observed_errors", value: errors, weight: 5 },
      { name: "verified_configuration", value: verified.map(config => ({ recipe: config.recipe, actual: config.actual,
        concepts: /instance[_ ]norm|revin/.test(encoded(config.actual?.preprocessing ?? config.recipe?.preprocessing)) ? ["normalization"] : [],
      })), weight: 1 },
      { name: "observed_scope", value: view.scope.map(item => ({ dataset: item.dataset.specification, evaluation: item.evaluation })), weight: 0.5 },
      { name: "observed_measurements", value: view.observations.map(observation => ({ stage: observation.stage,
        metric: observation.primaryMetric, value: observation.primaryValue })), weight: 0.5 },
    ].map(field => ({ ...field, terms: wordSet(field.value) }))
    const factual = new Set(fields.flatMap(field => [...field.terms]))
    const focal = new Set(fields.slice(0, 2).flatMap(field => [...field.terms]))
    const background = wordSet(view.interpretation)
    const match = matchExperienceQuery(plan, view, experience.facts, (fact, config) => {
      const dataset = fact.dataset.specification.path
      const datasetMatch = !datasetNames.length || typeof dataset === "string" &&
        datasetNames.some(name => path.basename(dataset, path.extname(dataset)) === name)
      const numericMatch = requirements.every(requirement => matchesNumericField(config.recipe, requirement.path, requirement.value))
      const observedFields = wordSet({ recipe: config.recipe, actual: config.actual })
      const matchingChanges = changes.filter(change => change.runID === config.runID && change.contrast)
      const axisMatch = !focalAxes.length || focalAxes.some(axis => wordSet(matchingChanges.map(change => interventionTerms(change.changes))).has(axis))
      const rootMatch = !roots.length || roots.some(root => matchingChanges.some(change => change.changes.some(item =>
        tokens(item.path).join(" ").startsWith(root))))
      const changedFocus = matchingChanges.some(intervention => intervention.changes.some(change => {
        const words = wordSet(interventionTerms([change]))
        if (plan.terms.includes("normalization")) return words.has("normalization")
        if (plan.mechanisms.includes("decomposition")) return words.has("decomposition") || words.has("dlinear")
        if (plan.entities.length) return plan.entities.some(entity => {
          const field = entity.component === "cell" ? "backbone.cell" : entity.component
          return (change.path === field || change.path.endsWith(`.${field}`) || change.path === `${field}.type` || change.path.endsWith(`.${field}.type`) || entity.component === "preprocessing" && change.path.startsWith("preprocessing.")) &&
            tokens(entity.name).every(term => words.has(term))
        })
        return roots.some(root => tokens(change.path).join(" ").startsWith(root))
      }))
      return [
        ...(datasetNames.length ? [{ requirement: `dataset:any(${datasetNames.join(",")})`, status: datasetMatch ? "matched" : "missing", source: "captured_dataset" } as ExperienceCondition] : []),
        ...(requirements.length ? [{ requirement: "numeric_configuration_constraints", status: numericMatch ? "matched" : "missing", source: "verified_configuration" } as ExperienceCondition] : []),
        ...(plan.intent === "configuration" && focalAxes.length ? [{ requirement: `configuration_fields:any(${focalAxes.join(",")})`,
          status: focalAxes.some(axis => observedFields.has(axis)) ? "matched" : "missing", source: "verified_configuration" } as ExperienceCondition] : []),
        ...(plan.intent === "intervention" ? [{ requirement: "queried_intervention_with_matched_full_run_contrast",
          status: matchingChanges.length && axisMatch && rootMatch && (focalAxes.length || changedFocus) ? "matched" : "missing", source: "verified_interventions" } as ExperienceCondition] : []),
      ]
    })
    const matchedFactual = terms.filter(term => factual.has(term))
    const specific = terms.filter(term => !["backbone", "embedding", "capacity", "stability", "fold", "cv"].includes(term))
    const substantive = specific.some(term => factual.has(term)) || plan.entities.length > 0 ||
      plan.mechanisms.length > 0 || plan.intent === "execution_error" || axes.length > 0
    const direct = match.complete && substantive
    const backgroundMatch = options.includeBackground && (matchedFactual.length > 0 || terms.some(term => background.has(term)))
    const relevance = direct ? (plan.intent === "execution_error" ? "observed_error" : plan.intent === "comparison" ? "paired_comparison"
      : plan.intent === "intervention" ? "direct_intervention" : "observed_configuration")
      : backgroundMatch ? (match.factualEntityMatch || plan.intent === "execution_error" && errors.length > 0 && matchedFactual.length > 0 ||
        plan.entities.length === 0 && verified.length > 0 && matchedFactual.length > 0 ||
        axes.some(axis => fields[2]!.terms.has(axis)) || match.complete && matchedFactual.length ? "configuration_background" : "unverified_text_background") : undefined
    const counts = new Map<string, number>()
    for (const field of fields) for (const term of field.terms) counts.set(term, (counts.get(term) ?? 0) + field.weight)
    if (options.includeBackground) for (const term of background) counts.set(term, (counts.get(term) ?? 0) + 0.05)
    return { memory, view, fields, relevance, match, counts, length: [...counts.values()].reduce((sum, count) => sum + count, 0),
      matchedFactual, focalMatches: terms.filter(term => focal.has(term)),
      backgroundMatches: terms.filter(term => background.has(term)) }
  })
  const averageLength = documents.reduce((sum, doc) => sum + doc.length, 0) / (documents.length || 1) || 1
  const frequencies = new Map(terms.map(term => [term, documents.filter(doc => doc.counts.has(term)).length]))
  const ranked = documents.map((doc, index) => {
    const score = terms.reduce((sum, term) => {
      const count = doc.counts.get(term) ?? 0
      if (!count) return sum
      const frequency = frequencies.get(term)!
      const idf = Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))
      return sum + idf * (count * 2.2) / (count + 1.2 * (0.25 + 0.75 * doc.length / averageLength))
    }, 0)
    return { ...doc, score: !terms.length && doc.relevance === "observed_error" ? 1 : score, index }
  }).filter(entry => entry.relevance && entry.score > 0)
    .sort((a, b) => Number(/^(direct|observed|paired)/.test(b.relevance!)) -
      Number(/^(direct|observed|paired)/.test(a.relevance!)) ||
      b.focalMatches.length - a.focalMatches.length || b.score - a.score || a.index - b.index)
  const groups = new Map<string, typeof ranked>()
  for (const entry of ranked) {
    const organization = entry.memory.candidateSummary.experienceOrganization as { threadID?: string; conditionalExperience?: { status: string } } | undefined
    const key = options.deduplicate === false ? entry.memory.id :
      organization?.conditionalExperience?.status === "explicit_hypothesis" ? organization.threadID! : entry.view.evidenceKey
    const group = groups.get(key) ?? []
    group.push(entry)
    groups.set(key, group)
  }
  return [...groups.values()].map(([entry, ...alternatives]) => ({ ...entry!.memory,
    candidateSummary: { ...entry!.memory.candidateSummary, experienceRetrieval: {
      method: EXPERIENCE_SEARCH_METHOD, relevance: entry!.relevance, score: entry!.score,
      matchedFactualTerms: entry!.matchedFactual,
      matchingRunIDs: entry!.match.matchingRunIDs,
      candidateRunIDs: entry!.match.candidateRunIDs,
      queryIntent: plan.intent, entityMode: plan.entityMode,
      matchedRequiredConditions: entry!.match.matchedRequiredConditions,
      missingRequiredConditions: entry!.match.missingRequiredConditions,
      matchedFields: entry!.fields.filter(field => terms.some(term => field.terms.has(term))).map(field => field.name),
      matchedInterpretationTerms: options.includeBackground ? entry!.backgroundMatches : [],
      sameEvidenceExperienceIDs: alternatives.filter(other => other.view.evidenceKey === entry!.view.evidenceKey).map(other => other.memory.id),
      sameThreadExperienceIDs: alternatives.map(other => other.memory.id),
      evidenceKey: entry!.view.evidenceKey,
      applicability: "Source conditions are in representation.scope; verify compatibility with the current task.",
      confidence: "Relevance is not truth confidence, causal validity or statistical significance.",
    } } as unknown as JsonRecord,
  }))
}
