const MAX_PROMPT_ARRAY_ITEMS = 128
const MAX_PROMPT_STRING_CHARS = 48_000
const MAX_CORRELATION_PAIRS = 12

type CorrelationPair = {
  readonly left: string
  readonly right: string
  readonly correlation: number
  readonly strength: string
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function compareCorrelationPairs(left: CorrelationPair, right: CorrelationPair) {
  const magnitude = Math.abs(right.correlation) - Math.abs(left.correlation)
  if (magnitude !== 0) return magnitude
  const leftName = left.left.localeCompare(right.left)
  return leftName !== 0 ? leftName : left.right.localeCompare(right.right)
}

function rounded(value: number) {
  return Number(value.toPrecision(6))
}

function quantile(sorted: readonly number[], ratio: number) {
  if (sorted.length === 0) return undefined
  const position = (sorted.length - 1) * ratio
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const lowerValue = sorted[lower]!
  const upperValue = sorted[upper]!
  return rounded(lowerValue + (upperValue - lowerValue) * (position - lower))
}

function dispersionAssessment(mean: number, median: number, standardDeviation: number) {
  const scale = Math.max(Math.abs(mean), Math.abs(median), 1e-12)
  const relativeSpread = standardDeviation / scale
  const dispersion = relativeSpread < 0.1 ? "low" : relativeSpread < 0.5 ? "moderate" : "high"
  const skewOffset = standardDeviation === 0 ? 0 : (mean - median) / standardDeviation
  const shape = Math.abs(skewOffset) < 0.25
    ? "approximately symmetric"
    : skewOffset > 0
      ? "right-skewed"
      : "left-skewed"
  return `${dispersion} relative dispersion; ${shape}`
}

export function summarizeNumericArray(value: readonly unknown[]) {
  const finite = value.filter((item): item is number => typeof item === "number" && Number.isFinite(item)).sort((a, b) => a - b)
  if (finite.length === 0) {
    return {
      kind: "numeric_array_analysis",
      count: value.length,
      finiteCount: 0,
      missingCount: value.length,
      analysis: "No finite numeric observations are available.",
    }
  }
  const mean = finite.reduce((sum, item) => sum + item, 0) / finite.length
  const variance = finite.reduce((sum, item) => sum + (item - mean) ** 2, 0) / finite.length
  const standardDeviation = Math.sqrt(variance)
  const median = quantile(finite, 0.5)!
  return {
    kind: "numeric_array_analysis",
    count: value.length,
    finiteCount: finite.length,
    missingCount: value.length - finite.length,
    min: rounded(finite[0]!),
    p25: quantile(finite, 0.25),
    median,
    p75: quantile(finite, 0.75),
    max: rounded(finite[finite.length - 1]!),
    mean: rounded(mean),
    standardDeviation: rounded(standardDeviation),
    analysis: dispersionAssessment(mean, median, standardDeviation),
  }
}

function correlationStrength(value: number) {
  const magnitude = Math.abs(value)
  if (magnitude >= 0.8) return "very_strong"
  if (magnitude >= 0.6) return "strong"
  if (magnitude >= 0.4) return "moderate"
  if (magnitude >= 0.2) return "weak"
  return "very_weak"
}

function summarizeNumericMatrix(value: readonly unknown[]) {
  const rows = value.filter(Array.isArray) as unknown[][]
  const columnCount = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0)
  const rowMeans = rows.map((row) => {
    const finite = row.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
    return finite.length === 0 ? Number.NaN : finite.reduce((sum, item) => sum + item, 0) / finite.length
  })
  const columnMeans = Array.from({ length: columnCount }, (_, columnIndex) => {
    const finite = rows
      .map((row) => row[columnIndex])
      .filter((item): item is number => typeof item === "number" && Number.isFinite(item))
    return finite.length === 0 ? Number.NaN : finite.reduce((sum, item) => sum + item, 0) / finite.length
  })
  return {
    kind: "numeric_matrix_analysis",
    rows: rows.length,
    columns: columnCount,
    rectangular: rows.every((row) => row.length === columnCount),
    valueDistribution: summarizeNumericArray(rows.flat()),
    rowMeanDistribution: summarizeNumericArray(rowMeans),
    columnMeanDistribution: summarizeNumericArray(columnMeans),
    analysis: "Raw matrix omitted; global values and row/column aggregates describe scale and heterogeneity.",
  }
}

function isNumericMatrix(value: readonly unknown[]) {
  if (value.length === 0 || !value.every(Array.isArray)) return false
  const cells = (value as unknown[][]).flat()
  return cells.some((item) => typeof item === "number" && Number.isFinite(item)) &&
    cells.every((item) => item === null || item === undefined || typeof item === "number")
}

function summarizeTrainingCurve(value: readonly unknown[]) {
  const groups = new Map<string, Array<{ epoch: number; valLoss: number; elapsedS?: number }>>()
  for (const raw of value) {
    const point = record(raw)
    const epoch = point.epoch
    const valLoss = point.valLoss
    if (typeof epoch !== "number" || !Number.isFinite(epoch) || typeof valLoss !== "number" || !Number.isFinite(valLoss)) continue
    const key = `${String(point.phase ?? "unknown")}:fold=${String(point.foldIndex ?? "standard")}:h=${String(point.horizon ?? "unknown")}`
    const group = groups.get(key) ?? []
    group.push({
      epoch,
      valLoss,
      ...(typeof point.elapsedS === "number" && Number.isFinite(point.elapsedS) ? { elapsedS: point.elapsedS } : {}),
    })
    groups.set(key, group)
  }
  const series = [...groups.entries()].map(([key, points]) => {
    points.sort((left, right) => left.epoch - right.epoch)
    const first = points[0]!
    const last = points[points.length - 1]!
    const best = points.reduce((current, point) => point.valLoss < current.valLoss ? point : current, first)
    const change = last.valLoss - first.valLoss
    return {
      series: key,
      pointCount: points.length,
      epochRange: [first.epoch, last.epoch],
      firstValLoss: rounded(first.valLoss),
      lastValLoss: rounded(last.valLoss),
      bestValLoss: rounded(best.valLoss),
      bestEpoch: best.epoch,
      absoluteChange: rounded(change),
      relativeChange: first.valLoss === 0 ? undefined : rounded(change / Math.abs(first.valLoss)),
      ...(last.elapsedS === undefined ? {} : { lastElapsedS: rounded(last.elapsedS) }),
      analysis: change < 0
        ? "validation loss improved over the observed series"
        : change > 0
          ? "validation loss worsened over the observed series"
          : "validation loss was flat over the observed series",
    }
  })
  return {
    kind: "training_curve_analysis",
    rawPointCount: value.length,
    validPointCount: series.reduce((sum, item) => sum + item.pointCount, 0),
    series,
    analysis: "Each fold/horizon is analyzed independently; changes are never computed across series boundaries.",
  }
}

export function summarizeCorrelationMatrix(value: unknown) {
  const matrix = record(value)
  const columns = Array.isArray(matrix.columns)
    ? matrix.columns.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []
  const values = Array.isArray(matrix.values) ? matrix.values : []
  if (columns.length === 0 || values.length === 0) return undefined

  const strongestPairs: CorrelationPair[] = []
  const absoluteCorrelations: number[] = []
  const rowCount = values.length
  const columnCount = columns.length
  const comparableCount = Math.min(rowCount, columnCount)
  for (let left = 0; left < comparableCount; left++) {
    const row = Array.isArray(values[left]) ? values[left] : []
    for (let right = left + 1; right < columnCount; right++) {
      const correlation = row[right]
      if (typeof correlation !== "number" || !Number.isFinite(correlation)) continue
      absoluteCorrelations.push(Math.abs(correlation))
      strongestPairs.push({
        left: columns[left]!,
        right: columns[right]!,
        correlation,
        strength: correlationStrength(correlation),
      })
    }
  }
  strongestPairs.sort(compareCorrelationPairs)

  return {
    kind: "correlation_matrix_summary",
    rows: rowCount,
    columns: columnCount,
    absoluteCorrelationDistribution: summarizeNumericArray(absoluteCorrelations),
    strongestPairs: strongestPairs.slice(0, MAX_CORRELATION_PAIRS),
    omittedPairs: Math.max((comparableCount * (comparableCount - 1)) / 2 - MAX_CORRELATION_PAIRS, 0),
    analysis: absoluteCorrelations.length === 0
      ? "No finite off-diagonal correlations are available."
      : `${correlationStrength(absoluteCorrelations.reduce((sum, item) => sum + item, 0) / absoluteCorrelations.length)} average cross-variable dependence; use strongest pairs as sparse interaction evidence, not as a dense graph by default.`,
  }
}

function numericMetric(value: unknown, assessment: (value: number) => string, implication: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return { value: rounded(value), assessment: assessment(value), modelingImplication: implication }
}

function profileMetricEntries(value: unknown) {
  const profile = record(value)
  const metrics = {
    rowCount: numericMetric(
      profile.rowCount,
      (item) => item < 1_000 ? "small sample" : item < 10_000 ? "moderate sample" : "large sample",
      "Controls how much model capacity and validation complexity the data can support.",
    ),
    targetCount: numericMetric(
      profile.targetCount,
      (item) => item <= 1 ? "univariate" : item <= 16 ? "low-dimensional multivariate" : item <= 128 ? "high-dimensional multivariate" : "very high-dimensional multivariate",
      "Large target counts favor parameter sharing and sparse rather than dense cross-variable interaction.",
    ),
    missingRate: numericMetric(
      profile.missingRate,
      (item) => item === 0 ? "no observed missingness" : item <= 0.01 ? "low missingness" : item <= 0.05 ? "moderate missingness" : "high missingness",
      "Non-zero missingness requires mask-aware preprocessing and robustness checks.",
    ),
    trendStrength: numericMetric(
      profile.trendStrength,
      (item) => item < 0.1 ? "weak trend" : item < 0.3 ? "moderate trend" : "strong trend",
      "Stronger trend supports centering, normalization, decomposition, or residual correction.",
    ),
    seasonalityStrength: numericMetric(
      profile.seasonalityStrength,
      (item) => item < 0.2 ? "weak seasonality" : item < 0.5 ? "moderate seasonality" : "strong seasonality",
      "Positive detrended periodic peaks support seasonal decomposition, frequency features, or period-aligned patches. A low score does not rule out local or changing seasonality.",
    ),
    crossVarCorrelation: numericMetric(
      profile.crossVarCorrelation,
      (item) => correlationStrength(item).replaceAll("_", " "),
      "Describes measured target–covariate dependence when covariates are configured, otherwise target–target dependence. Low contemporaneous linear correlation does not rule out lagged or nonlinear effects; unavailable pairs are not zero evidence.",
    ),
    distributionShift: numericMetric(
      profile.distributionShift,
      (item) => item < 0.1 ? "low shift" : item < 0.3 ? "moderate shift" : "high shift",
      "Greater shift favors robust loss, normalization, recency weighting, and strict time-ordered validation.",
    ),
    outlierRate: numericMetric(
      profile.outlierRate,
      (item) => item < 0.01 ? "low outlier prevalence" : item < 0.05 ? "moderate outlier prevalence" : "high outlier prevalence",
      "Higher outlier prevalence favors robust losses and explicit failure analysis beyond mean error.",
    ),
    acfMainPeriod: numericMetric(
      profile.acfMainPeriod,
      (item) => `detected seasonal period ${rounded(item)} observations`,
      "Use this detrended periodic peak to choose seasonal differences, decomposition kernels, and patch scales; do not infer a seasonal period from short-lag persistence alone.",
    ),
    acfMainPeriodStrength: numericMetric(
      profile.acfMainPeriodStrength,
      (item) => item < 0.2 ? "weak detrended periodic peak" : item < 0.5 ? "moderate detrended periodic peak" : "strong detrended periodic peak",
      "Indicates how strongly the dominant lag should influence architecture priors.",
    ),
    adfStatistic: numericMetric(
      profile.adfStatistic,
      () => profile.adfStationary === true ? "stationary by configured ADF rule" : "non-stationary or inconclusive by configured ADF rule",
      "Non-stationarity supports differencing, centering, decomposition, or normalization.",
    ),
    duplicateTimestampRate: numericMetric(
      profile.duplicateTimestampRate,
      (item) => item === 0 ? "no duplicate timestamps" : item <= 0.01 ? "low duplicate rate" : "material duplicate rate",
      "Duplicate timestamps should be resolved before relying on temporal order.",
    ),
    irregularIntervalRatio: numericMetric(
      profile.irregularIntervalRatio,
      (item) => item === 0 ? "regular cadence" : item <= 0.05 ? "mostly regular cadence" : "irregular cadence",
      "Irregular cadence may require resampling or explicit time-gap handling.",
    ),
  }
  return Object.fromEntries(Object.entries(metrics).filter(([, item]) => item !== undefined))
}

export function analyzeDatasetProfileForPrompt(value: unknown) {
  const profile = record(value)
  return {
    kind: "dataset_profile_analysis",
    source: {
      ...(typeof profile.source === "string" ? { type: profile.source } : {}),
      ...(typeof profile.path === "string" ? { path: compactPromptString(profile.path) } : {}),
    },
    metrics: profileMetricEntries(profile),
    ...(profile.correlations === undefined ? {} : { correlationStructure: profile.correlations }),
    ...(Array.isArray(profile.covariateProfiles) ? {
      covariates: profile.covariateProfiles.map((item) => ({
        column: record(item).column,
        role: record(item).role,
        metrics: profileMetricEntries(item),
      })),
    } : {}),
    ...(profile.correlationMatrix === undefined
      ? {}
      : { correlationStructure: summarizeCorrelationMatrix(profile.correlationMatrix) }),
  }
}

export function renderCorrelationSummary(value: unknown) {
  const summary = record(value)
  if (!Array.isArray(summary.strongestPairs)) return ["- Target correlation diagnostics unavailable; absence is not evidence of independent covariates."]
  return [
    `- Scope: ${String(summary.scope)}; valid pairs: ${String(summary.validPairCount)} / ${String(summary.evaluatedPairCount)}.`,
    `- Mean absolute correlation: ${String(summary.meanAbsCorrelation ?? "unavailable")}; maximum: ${String(summary.maxAbsCorrelation ?? "unavailable")}.`,
    "- Only target-related pairs are evaluated; covariate–covariate pairs and a full matrix are omitted. Positive lead-lag evidence is reported separately.",
    "",
    "| Source | Target | Correlation |",
    "| --- | --- | ---: |",
    ...summary.strongestPairs.map((item) => {
      const pair = record(item)
      return `| ${String(pair.source)} | ${String(pair.target)} | ${String(pair.correlation)} |`
    }),
  ]
}

function compactPromptString(value: string) {
  if (value.length <= MAX_PROMPT_STRING_CHARS) return value
  return `${value.slice(0, MAX_PROMPT_STRING_CHARS)}\n...[truncated ${value.length - MAX_PROMPT_STRING_CHARS} characters for prompt safety]`
}

export function compactPromptContext(value: unknown, contextKey?: string): unknown {
  // This bounded, selected evidence packet has its own schema; summarizing arrays here
  // silently removes mechanisms, provenance and citation permissions.
  if (contextKey === "taskEvidence") return value
  if (typeof value === "string") return compactPromptString(value)
  if (Array.isArray(value)) {
    // Diagnostics already sample at most 20 covariates; retain their named
    // evidence instead of replacing it with a collection-size placeholder.
    if (["covariates", "observedPastCovariateAnalysis"].includes(contextKey ?? "") && value.length <= 20) {
      return value.map((item) => compactPromptContext(item))
    }
    if (contextKey === "trainingCurve") return summarizeTrainingCurve(value)
    if (isNumericMatrix(value)) return summarizeNumericMatrix(value)
    const numericAnalysisKey = /per.?target|(?:loss(?:es)?|errors?|residuals?|predictions?|labels?|values?|samples?|distribution)$/i.test(contextKey ?? "")
    if (numericAnalysisKey && value.every((item) => typeof item === "number" || item === null || item === undefined)) {
      return summarizeNumericArray(value)
    }
    if (value.length <= MAX_PROMPT_ARRAY_ITEMS) return value.map((item) => compactPromptContext(item))
    if (value.every((item) => typeof item === "number" || item === null || item === undefined)) {
      return summarizeNumericArray(value)
    }
    const itemTypes = [...new Set(value.map((item) => Array.isArray(item) ? "array" : item === null ? "null" : typeof item))]
    const uniqueScalarCount = value.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))
      ? new Set(value.map((item) => JSON.stringify(item))).size
      : undefined
    return {
      kind: "collection_analysis",
      count: value.length,
      itemTypes,
      ...(uniqueScalarCount === undefined ? {} : { uniqueCount: uniqueScalarCount }),
      analysis: "Raw collection omitted because its size exceeds the prompt evidence limit.",
    }
  }
  if (!value || typeof value !== "object") return value

  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "datasetProfile" || key === "datasetProfileSummary") {
      result.datasetProfileAnalysis = analyzeDatasetProfileForPrompt(child)
      continue
    }
    if (key === "correlationMatrix") {
      const summary = summarizeCorrelationMatrix(child)
      if (summary !== undefined) result.correlationMatrixSummary = summary
      continue
    }
    result[key] = compactPromptContext(child, key)
  }
  return result
}

function correlationSummaryMarkdown(value: unknown) {
  const summary = summarizeCorrelationMatrix(value)
  if (summary === undefined) return ["- Correlation matrix unavailable."]
  const lines = [
    `- Matrix shape: ${summary.rows} x ${summary.columns}`,
    `- Full matrix omitted from LLM context; showing ${summary.strongestPairs.length} strongest absolute pairs.`,
    `- Overall analysis: ${summary.analysis}`,
    `- Absolute-correlation distribution: mean=${summary.absoluteCorrelationDistribution.mean ?? "n/a"}, median=${summary.absoluteCorrelationDistribution.median ?? "n/a"}, p75=${summary.absoluteCorrelationDistribution.p75 ?? "n/a"}, max=${summary.absoluteCorrelationDistribution.max ?? "n/a"}.`,
  ]
  if (summary.strongestPairs.length === 0) return lines
  return [
    ...lines,
    "",
    "| Target A | Target B | Correlation | Strength |",
    "| --- | --- | ---: | --- |",
    ...summary.strongestPairs.map((pair) => `| ${pair.left} | ${pair.right} | ${pair.correlation} | ${pair.strength} |`),
  ]
}

export function renderCorrelationMatrixSummary(value: unknown) {
  return correlationSummaryMarkdown(value)
}

export function compactMarkdownForPrompt(value: string, correlationMatrix?: unknown) {
  const replacement = ["## Correlation Matrix", "", ...correlationSummaryMarkdown(correlationMatrix)].join("\n")
  const withoutFullMatrix = value.replace(
    /(^|\n)## Correlation Matrix[^\n]*\n[\s\S]*?(?=\n## |$)/g,
    (_, prefix: string) => `${prefix}${replacement}\n`,
  )
  return compactPromptString(withoutFullMatrix)
}
