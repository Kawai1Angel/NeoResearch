import type { DatasetEvidence, DatasetQuantitativeAnalysis } from "./contract"
import { resolveEvidencePath } from "./quantitative-report-reader"

function evidence(
  report: DatasetQuantitativeAnalysis,
  path: string,
  metric: string,
  interpretation: string,
): DatasetEvidence | undefined {
  const value = resolveEvidencePath(report, path, true)
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) return undefined
  return { path, metric, value, interpretation }
}

export function extractDatasetEvidence(report: DatasetQuantitativeAnalysis): DatasetEvidence[] {
  const values = [
    evidence(report, "$.profile.seasonalityStrength", "seasonality_strength", "Strength of recurrent temporal structure."),
    evidence(report, "$.statistics.acf.topLag", "acf_top_lag", "Lag with the strongest measured autocorrelation."),
    evidence(report, "$.statistics.acf.topCorrelation", "acf_top_correlation", "Strength of the dominant autocorrelation."),
    evidence(report, "$.statistics.frequency.spectralPeaks", "spectral_peaks", "Significant periods identified by spectral analysis."),
    evidence(report, "$.profile.trendStrength", "trend_strength", "Strength of systematic evolution over time."),
    evidence(report, "$.statistics.stationarity.adfStationary", "adf_stationary", "ADF-style stationarity decision."),
    evidence(report, "$.statistics.stationarity.kpssStationary", "kpss_stationary", "KPSS-style stationarity decision."),
    evidence(report, "$.profile.distributionShift", "distribution_shift", "Magnitude of temporal distribution drift."),
    evidence(report, "$.statistics.changepoint.score", "change_point_score", "Normalized evidence for a potential regime transition."),
    evidence(report, "$.statistics.changepoint.severity", "change_point_severity", "Severity assigned by the change-point diagnostic."),
    evidence(report, "$.dataset.knownFutureCovariates", "known_future_covariates", "Task-contract variables available over the forecast horizon."),
    evidence(report, "$.profile.crossVarCorrelation", "cross_variate_correlation", "Aggregate dependence across target variables."),
    evidence(report, "$.statistics.crossLag", "cross_lag", "Strongest measured lead-lag relationship."),
    evidence(report, "$.profile.outlierRate", "outlier_rate", "Share of observations flagged as extreme."),
    evidence(report, "$.profile.missingRate", "missing_rate", "Share of missing numeric observations."),
    evidence(report, "$.profile.irregularIntervalRatio", "irregular_interval_ratio", "Share of timestamp intervals that depart from regular cadence."),
    evidence(report, "$.forecast.horizonContextRatio", "horizon_context_ratio", "Forecast horizon relative to the available context."),
  ]
  return values.filter((item): item is DatasetEvidence => item !== undefined)
}

export function evidenceByPath(evidenceValues: readonly DatasetEvidence[]) {
  return new Map(evidenceValues.map((item) => [item.path, item]))
}
