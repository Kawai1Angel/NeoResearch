import taskEvidenceConfig from "./config/tsf-task-evidence.v1.json" with { type: "json" }
import type { KnowledgeCard } from "../literature/contract"
import { normalizeRetrievalTokens } from "./bm25-search"
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

function taskFacts(report: DatasetQuantitativeAnalysis, context: RetrieveTaskContext, conceptIDs: readonly string[]) {
  const dataScale = scale(report.profile.rowCount)
  const temporalColumns = new Set([
    ...report.dataset.targetColumns, ...report.dataset.observedPastCovariates,
    ...report.dataset.knownFutureCovariates,
  ].map((value) => value.trim()).filter(Boolean))
  return {
    taskTypes: [context.taskType],
    domains: [context.domain, report.domain],
    dataFeatures: [
      ...conceptIDs,
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

export function matchApplicability(input: {
  readonly card: KnowledgeCard
  readonly report: DatasetQuantitativeAnalysis
  readonly taskContext: RetrieveTaskContext
  readonly conceptIDs: readonly string[]
}): ApplicabilityResult {
  const facts = taskFacts(input.report, input.taskContext, input.conceptIDs)
  const checks = [
    condition({ label: "taskType", values: input.card.applicability.taskTypes, actual: facts.taskTypes, known: true }),
    condition({ label: "domain", values: input.card.applicability.domains, actual: facts.domains, known: true }),
    ...input.card.applicability.dataFeatures.map((feature) => condition({
      label: "dataFeature", values: [feature], actual: facts.dataFeatures,
      known: /^(multi|uni)variate$/.test(normalized(feature)) ? facts.dimensionalityKnown : true,
    })),
    condition({ label: "dataScale", values: input.card.applicability.dataScale, actual: facts.dataScale, known: true }),
    condition({ label: "horizonProfile", values: input.card.applicability.horizonProfile.map((value) => value === "long" ? "long_horizon" : value === "short" ? "short_horizon" : value), actual: facts.horizonProfile, known: true }),
    condition({
      label: "computeProfile",
      values: input.card.applicability.computeProfile,
      actual: facts.computeProfile,
      known: input.taskContext.constraints.computeProfile !== "unknown",
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
  let conflicted = false
  for (const raw of input.card.notApplicableWhen) {
    const predicate = normalized(raw)
    if (!controlled.has(predicate as (typeof taskEvidenceConfig.controlledPredicates)[number])) {
      uncertainConditions.push(`notApplicableWhen:${raw}`)
      continue
    }
    if (predicate.endsWith("_compute") && facts.computeProfile.length === 0) {
      uncertainConditions.push(`notApplicableWhen:${raw}`)
      continue
    }
    if (taskPredicates.has(predicate)) {
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
