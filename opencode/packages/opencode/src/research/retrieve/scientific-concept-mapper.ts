import scientificConfig from "./config/tsf-scientific-concepts.v1.json" with { type: "json" }
import type { DatasetEvidence, DatasetQuantitativeAnalysis } from "./contract"
import { evidenceByPath } from "./dataset-evidence"

type ConfigConceptID = keyof typeof scientificConfig.concepts

export type ScientificConceptMapping = {
  readonly conceptID: ConfigConceptID
  readonly label: string
  readonly paperTerms: readonly string[]
  readonly confidence: number
  readonly evidence: readonly DatasetEvidence[]
  readonly modelingChallenge: string
}

function concept(
  conceptID: ConfigConceptID,
  confidence: number,
  evidence: readonly (DatasetEvidence | undefined)[],
  modelingChallenge: string,
): ScientificConceptMapping {
  const configured = scientificConfig.concepts[conceptID]
  return {
    conceptID,
    label: configured.label,
    paperTerms: configured.paperTerms,
    confidence: Math.max(0, Math.min(1, Number(confidence.toFixed(3)))),
    evidence: evidence.filter((item): item is DatasetEvidence => item !== undefined),
    modelingChallenge,
  }
}

export function mapScientificConcepts(
  report: DatasetQuantitativeAnalysis,
  evidenceValues: readonly DatasetEvidence[],
): ScientificConceptMapping[] {
  const byPath = evidenceByPath(evidenceValues)
  const result: ScientificConceptMapping[] = []
  const peakEvidence = byPath.get("$.statistics.frequency.spectralPeaks")
  const significantPeaks = report.statistics.frequency.spectralPeaks.filter((item) => item.significant)
  const hasPeriodicSupport = Math.abs(report.statistics.acf.topCorrelation ?? 0) >= 0.3 || significantPeaks.length > 0
  const detectedPeriod = report.statistics.decomposition.period
  const hasDetectedPeriod = detectedPeriod !== undefined && detectedPeriod >= 3 && report.profile.seasonalityStrength >= 0.2
  if ((report.profile.seasonalityStrength >= 0.4 && hasPeriodicSupport) || hasDetectedPeriod) {
    result.push(concept("seasonality", Math.max(report.profile.seasonalityStrength, 0.6), [
      byPath.get("$.profile.seasonalityStrength"),
      byPath.get("$.statistics.decomposition.period"),
      byPath.get("$.statistics.acf.topCorrelation"),
      peakEvidence,
    ], "Represent recurrent temporal patterns."))
  }
  if (significantPeaks.length >= 2) {
    result.push(concept("multiple_seasonalities", significantPeaks.slice(0, 2).reduce((sum, item) => sum + item.powerShare, 0), [peakEvidence], "Represent multiple periodic structures."))
  }
  if (report.profile.trendStrength >= 0.2) {
    result.push(concept("trend_dynamics", report.profile.trendStrength, [byPath.get("$.profile.trendStrength")], "Separate evolving trend from shorter-range variation."))
  }
  if (
    report.statistics.stationarity.adfStationary === false &&
    report.statistics.stationarity.kpssStationary === false &&
    report.profile.distributionShift >= 0.3
  ) {
    result.push(concept("non_stationarity", Math.max(0.65, report.profile.distributionShift), [
      byPath.get("$.statistics.stationarity.adfStationary"),
      byPath.get("$.statistics.stationarity.kpssStationary"),
      byPath.get("$.profile.distributionShift"),
    ], "Adapt to temporal distribution changes without assuming stationarity."))
  }
  if ((report.statistics.changepoint.score ?? 0) >= 0.5) {
    result.push(concept("potential_structural_break", Math.min(0.9, report.statistics.changepoint.score ?? 0.5), [
      byPath.get("$.statistics.changepoint.score"),
      byPath.get("$.statistics.changepoint.severity"),
    ], "Remain robust to a potential regime transition."))
  }
  if (report.dataset.knownFutureCovariates.length > 0) {
    result.push(concept("covariate_conditioning", 0.95, [byPath.get("$.dataset.knownFutureCovariates")], "Use information known over the forecast horizon."))
  }
  if (report.dataset.observedPastCovariates.length > 0 && report.dataset.knownFutureCovariates.length === 0) {
    result.push({
      ...concept("covariate_conditioning", 0.9, [byPath.get("$.dataset.observedPastCovariates"), byPath.get("$.covariates")], "Evaluate conditioning on historical exogenous inputs using their own diagnostics."),
      paperTerms: scientificConfig.concepts.covariate_conditioning.observedPastPaperTerms,
    })
  }
  if ((report.profile.crossVarCorrelation ?? 0) >= 0.5) {
    result.push(concept("cross_series_dependency", report.profile.crossVarCorrelation!, [byPath.get("$.profile.crossVarCorrelation")], "Capture dependencies between variables."))
  }
  if (Math.abs(report.statistics.crossLag.correlation ?? 0) >= 0.4 && report.statistics.crossLag.lag !== undefined) {
    result.push(concept("lead_lag_relationship", Math.abs(report.statistics.crossLag.correlation ?? 0), [byPath.get("$.statistics.crossLag")], "Capture delayed effects across variables."))
  }
  if (report.profile.outlierRate >= 0.03) {
    result.push(concept("contaminated_observations", Math.min(0.9, 0.5 + report.profile.outlierRate), [byPath.get("$.profile.outlierRate")], "Limit sensitivity to contaminated observations."))
  }
  if (report.profile.missingRate > 0) {
    result.push(concept("incomplete_observations", Math.min(0.95, 0.6 + report.profile.missingRate), [byPath.get("$.profile.missingRate")], "Model incomplete observations without fabricating evidence."))
  }
  if (report.profile.irregularIntervalRatio >= 0.05) {
    result.push(concept("irregular_sampling", Math.min(0.95, 0.6 + report.profile.irregularIntervalRatio), [byPath.get("$.profile.irregularIntervalRatio")], "Account for non-uniform observation intervals."))
  }
  if (report.forecast.horizonContextRatio >= 1) {
    result.push(concept("long_horizon_dependency", Math.min(0.95, 0.65 + report.forecast.horizonContextRatio / 10), [byPath.get("$.forecast.horizonContextRatio")], "Preserve useful context over a long forecast horizon."))
  }
  return result.filter((item) => item.evidence.length > 0)
}

export const SCIENTIFIC_CONCEPT_MAPPING_VERSION = `${scientificConfig.schemaVersion}:covariate_terms_v2`
