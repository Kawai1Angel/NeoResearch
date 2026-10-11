import taskEvidenceConfig from "./config/tsf-task-evidence.v1.json" with { type: "json" }
import type { KnowledgeCardV2 } from "../literature/knowledge-v2-contract"
import type { KnowledgeCard } from "../literature/contract"
import { normalizeRetrievalTokens } from "./bm25-search"
import { extractDatasetEvidence } from "./dataset-evidence"
import { mapScientificConcepts } from "./scientific-concept-mapper"
import type { DatasetQuantitativeAnalysis, RetrieveTaskContext, TaskEvidenceEntry } from "./contract"

export type ApplicabilityResult = TaskEvidenceEntry["applicability"]

function normalized(value: string) {
  return normalizeRetrievalTokens(value).join("_")
}

function equivalent(left: string, right: string) {
  const a = normalized(left)
  const b = normalized(right)
  if (a === b) return true
  const aliases = taskEvidenceConfig.aliases
  const leftAliases = aliases[a as keyof typeof aliases] ?? []
  const rightAliases = aliases[b as keyof typeof aliases] ?? []
  return leftAliases.some((item) => normalized(item) === b) || rightAliases.some((item) => normalized(item) === a)
}

function scale(rowCount: number) {
  if (rowCount <= taskEvidenceConfig.dataScale.smallMaxRows) return "small"
  if (rowCount <= taskEvidenceConfig.dataScale.mediumMaxRows) return "medium"
  return "large"
}

function condition(input: { label: string; values: readonly string[]; actual: readonly string[]; known: boolean }) {
  if (input.values.length === 0) return { matched: [] as string[], violated: [] as string[], uncertain: [] as string[] }
  if (!input.known) return { matched: [], violated: [], uncertain: input.values.map((item) => `${input.label}:${item}`) }
  const matched = input.values.filter((expected) => input.actual.some((actual) => equivalent(expected, actual)))
  return matched.length > 0
    ? { matched: matched.map((item) => `${input.label}:${item}`), violated: [], uncertain: [] }
    : { matched: [], violated: input.values.map((item) => `${input.label}:${item}`), uncertain: [] }
}

function taskFacts(report: DatasetQuantitativeAnalysis, context: RetrieveTaskContext) {
  const dataScale = scale(report.profile.rowCount)
  const temporalColumns = new Set([
    ...report.dataset.targetColumns, ...report.dataset.observedPastCovariates,
    ...report.dataset.knownFutureCovariates,
  ].map((value) => value.trim()).filter(Boolean))
  return {
    taskTypes: [context.taskType, context.objective.probabilistic ? "probabilistic_forecasting" : "point_forecasting"],
    domains: [context.domain, report.domain],
    dataFeatures: [
      // Recompute from the complete diagnosis, never from a retrieved paper or the bound intent.
      ...mapScientificConcepts(report, extractDatasetEvidence(report)).map((item) => item.conceptID),
      ...(report.dataset.knownFutureCovariates.length > 0 ? ["known_future_covariates"] : []),
      context.objective.probabilistic ? "probabilistic_forecasting" : "point_forecasting",
      ...(temporalColumns.size > 1 ? ["multivariate"] : temporalColumns.size === 1 ? ["univariate"] : []),
      report.profile.irregularIntervalRatio < 0.05 ? "regular_sampling" : "irregular_sampling",
      report.forecast.horizonContextRatio >= 1 ? "long_horizon" : "short_horizon",
    ],
    dimensionalityKnown: temporalColumns.size > 0,
    dataScale: [dataScale, `${dataScale}_data`],
    horizonProfile: [report.forecast.horizonContextRatio >= 1 ? "long_horizon" : "short_horizon"],
    computeProfile: context.constraints.computeProfile === "unknown"
      ? []
      : [context.constraints.computeProfile, `${context.constraints.computeProfile}_compute`],
  }
}

function featureKnown(feature: string, facts: ReturnType<typeof taskFacts>) {
  if (facts.dataFeatures.some((actual) => equivalent(feature, actual))) return true
  if (["multivariate", "univariate"].some((value) => equivalent(feature, value))) return facts.dimensionalityKnown
  // These predicates have explicit measurements. Absence of a scientific detection
  // (e.g. a spectral peak) alone does not establish that a phenomenon is absent.
  return ["regular_sampling", "irregular_sampling", "long_horizon", "short_horizon",
    "known_future_covariates", "covariate_conditioning", "point_forecasting", "probabilistic_forecasting"]
    .some((value) => equivalent(feature, value))
}

export function matchApplicability(input: {
  readonly card: KnowledgeCard
  readonly report: DatasetQuantitativeAnalysis
  readonly taskContext: RetrieveTaskContext
  readonly conceptIDs: readonly string[]
}): ApplicabilityResult {
  const facts = taskFacts(input.report, input.taskContext)
  const sourced = ["author_statement", "author_experiment"].includes(input.card.applicability.basis)
  const checks = [
    condition({ label: "taskType", values: input.card.applicability.taskTypes, actual: facts.taskTypes, known: sourced }),
    condition({ label: "domain", values: input.card.applicability.domains, actual: facts.domains, known: sourced }),
    ...input.card.applicability.dataFeatures.map((feature) => condition({
      label: "dataFeature", values: [feature], actual: facts.dataFeatures,
      known: sourced && featureKnown(feature, facts),
    })),
    condition({ label: "dataScale", values: input.card.applicability.dataScale, actual: facts.dataScale, known: sourced && input.report.profile.rowCount > 0 }),
    condition({ label: "horizonProfile", values: input.card.applicability.horizonProfile.map((value) => value === "long" ? "long_horizon" : value === "short" ? "short_horizon" : value), actual: facts.horizonProfile, known: sourced }),
    condition({
      label: "computeProfile",
      values: input.card.applicability.computeProfile,
      actual: facts.computeProfile,
      known: sourced && input.taskContext.constraints.computeProfile !== "unknown",
    }),
  ]
  const matchedConditions = checks.flatMap((item) => item.matched)
  const violatedConditions = checks.flatMap((item) => item.violated)
  const uncertainConditions = checks.flatMap((item) => item.uncertain)
  const controlled = new Set(taskEvidenceConfig.controlledPredicates)
  const taskPredicates = new Set([
    ...facts.dataFeatures,
    ...facts.dataScale,
    ...facts.horizonProfile,
    ...facts.computeProfile,
  ].map(normalized))
  let conflicted = violatedConditions.length > 0
  for (const raw of input.card.notApplicableWhen) {
    const predicate = normalized(raw)
    if (!controlled.has(predicate as (typeof taskEvidenceConfig.controlledPredicates)[number]) && !featureKnown(raw, facts)) {
      uncertainConditions.push(`notApplicableWhen:${raw}`)
      continue
    }
    if (predicate.endsWith("_compute") && facts.computeProfile.length === 0) {
      uncertainConditions.push(`notApplicableWhen:${raw}`)
      continue
    }
    if ([...taskPredicates].some((actual) => equivalent(raw, actual))) {
      violatedConditions.push(`notApplicableWhen:${raw}`)
      conflicted = true
    }
  }
  const declared = Object.values(input.card.applicability)
    .filter(Array.isArray)
    .some((values) => values.length > 0) || input.card.notApplicableWhen.length > 0
  return {
    status: conflicted
      ? "conflicted"
      : !declared
        ? "unknown"
        : violatedConditions.length > 0 || uncertainConditions.length > 0
          ? "partial"
          : "matched",
    matchedConditions: [...new Set(matchedConditions)].toSorted(),
    violatedConditions: [...new Set(violatedConditions)].toSorted(),
    uncertainConditions: [...new Set(uncertainConditions)].toSorted(),
  }
}

export const APPLICABILITY_MATCHER_VERSION = "task_applicability_v2"

export function matchPrincipleApplicability(input: {
  card: KnowledgeCardV2; report: DatasetQuantitativeAnalysis; taskContext: RetrieveTaskContext
}): ApplicabilityResult {
  const facts = taskFacts(input.report, input.taskContext)
  const matchedConditions: string[] = [], violatedConditions: string[] = [], uncertainConditions: string[] = []
  for (const condition of input.card.conditions) {
    const statement = input.card.assertions.find((item) => item.assertionID === condition.assertionID)!.statement
    const actual = [...facts.taskTypes, ...facts.dataFeatures, ...facts.domains, ...facts.dataScale, ...facts.horizonProfile, ...facts.computeProfile]
    if (actual.some((value) => equivalent(statement, value))) matchedConditions.push(statement)
    else if (featureKnown(statement, facts)) violatedConditions.push(statement)
    else uncertainConditions.push(statement)
  }
  // Boundaries are source statements, not automatically executable exclusion predicates.
  if (input.card.boundaries.status === "reported") {
    for (const boundary of input.card.boundaries.items) uncertainConditions.push(`Boundary requires assessment: ${input.card.assertions.find((a) => a.assertionID === boundary.assertionID)!.statement}`)
  }
  return { status: violatedConditions.length ? "conflicted" : uncertainConditions.length ?
    (matchedConditions.length ? "partial" : "unknown") : "matched", matchedConditions, violatedConditions, uncertainConditions }
}
