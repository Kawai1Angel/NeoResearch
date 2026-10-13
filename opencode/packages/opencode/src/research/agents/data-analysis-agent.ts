import { profileSeries, resolveTSFProfileSource, TSFTaskSpec } from "../domains/tsf"
import { decomposeSeasonality } from "../seasonality"
import { taskExecutionRoot } from "../task-isolation"
import { analyzeDatasetProfileForPrompt, renderCorrelationSummary } from "../prompt-context"
import { spectralPowers } from "../spectral-analysis"
import { deflateSync } from "zlib"
import { Instance } from "@/project/instance"
import type { JsonRecord, ResearchArtifact, ResearchArtifactID, ResearchTask } from "../schema"
import {
  DatasetQuantitativeAnalysisSchema,
  type DatasetQuantitativeAnalysis,
  type SpectralPeak,
  type SeriesProfile,
} from "../retrieve/contract"

export type DatasetAnalysisPlot = {
  readonly kind: "dataset_analysis_plot_png"
  readonly filename: string
  readonly relativePath: string
  readonly role: string
  readonly data: Uint8Array
  readonly metadata: JsonRecord
}

export type DatasetStatisticalAnalysis = {
  readonly stationarity: {
    readonly adfStatistic?: number
    readonly adfStationary?: boolean
    readonly kpssStatistic?: number
    readonly kpssStationary?: boolean
  }
  readonly acf: {
    readonly topLag?: number
    readonly topCorrelation?: number
    readonly pacfTopLag?: number
    readonly pacfTopCorrelation?: number
  }
  readonly decomposition: {
    readonly period?: number
    readonly trendVarianceShare?: number
    readonly seasonalVarianceShare?: number
    readonly residualVarianceShare?: number
  }
  readonly frequency: {
    readonly dominantPeriod?: number
    readonly dominantPowerShare?: number
    readonly spectralPeaks: readonly SpectralPeak[]
  }
  readonly changepoint: {
    readonly index?: number
    readonly score?: number
    readonly severity?: string
  }
  readonly crossLag: {
    readonly source?: string
    readonly target?: string
    readonly lag?: number
    readonly correlation?: number
  }
}

export type DatasetAnalysisContext = {
  readonly rowCount?: number
  readonly statistics: DatasetStatisticalAnalysis
  readonly covariates?: readonly { column: string; role: "observed_past"; profile: SeriesProfile; statistics: DatasetStatisticalAnalysis }[]
  readonly plotRefs: readonly DatasetAnalysisPlot[]
}

export interface DataAnalysisQuantitativeResult {
  readonly agent: "DataAnalysisAgent"
  readonly taskID: ResearchTask["id"]
  readonly reportMarkdown: string
  readonly reportJSON: DatasetQuantitativeAnalysis
  readonly llm: {
    readonly status: "disabled"
  }
}

export interface DataAnalysisAgentResult {
  readonly agent: "DataAnalysisAgent"
  readonly taskID: ResearchTask["id"]
  readonly artifact: ResearchArtifact
  readonly sourceArtifactIDs: readonly ResearchArtifactID[]
  readonly searchBiases: readonly string[]
  readonly warningCount: number
}

export interface DatasetAnalysisSourceReport {
  readonly id: ResearchArtifactID
  readonly kind: string
  readonly role: string
  readonly content: string
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.length > 0)
}

function renderCorrelationMatrix(value: unknown) {
  return renderCorrelationSummary(value)
}

function renderDatasetProfileAnalysis(value: unknown) {
  const analysis = analyzeDatasetProfileForPrompt(value)
  const metrics = recordValue(analysis.metrics)
  const labels: Record<string, string> = {
    rowCount: "Rows",
    targetCount: "Target columns",
    missingRate: "Missing rate",
    trendStrength: "Trend strength",
    seasonalityStrength: "Seasonality strength",
    crossVarCorrelation: "Cross-variate correlation",
    distributionShift: "Distribution shift",
    outlierRate: "Outlier rate",
    acfMainPeriod: "ACF main period",
    acfMainPeriodStrength: "ACF main period strength",
    adfStatistic: "ADF statistic",
    duplicateTimestampRate: "Duplicate timestamp rate",
    irregularIntervalRatio: "Irregular interval ratio",
  }
  return [
    "| Metric | Value | Assessment | Modeling implication |",
    "| --- | ---: | --- | --- |",
    ...Object.entries(metrics).map(([key, raw]) => {
      const metric = recordValue(raw)
      return `| ${labels[key] ?? key} | ${String(metric.value ?? "n/a")} | ${String(metric.assessment ?? "n/a")} | ${String(metric.modelingImplication ?? "n/a")} |`
    }),
  ]
}

function renderSourceReport(report: DatasetAnalysisSourceReport) {
  return [
    `### ${report.role}`,
    "",
    `- Artifact: ${report.id}`,
    `- Kind: ${report.kind}`,
    "",
    report.content.trim(),
  ].join("\n")
}

function formatAnalysisMetricValue(value: unknown) {
  if (typeof value !== "number") return JSON.stringify(value)
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)))
}

function renderAnalysisValue(value: unknown) {
  if (typeof value === "number") return formatAnalysisMetricValue(value)
  if (typeof value === "string" && value.length > 0) return value
  if (typeof value === "boolean") return value ? "true" : "false"
  return "-"
}

// ---------------------------------------------------------------------------
// Quantitative analysis pipeline — deterministic, no LLM. This is the same code
// the analyze_dataset tool (src/tool/research-data-analysis.ts) invokes; it lives
// here (not in service.ts) so the tool module never imports the Session-wired
// service.ts and create an import cycle through the tool registry.
// ---------------------------------------------------------------------------

type DatasetSeriesMatrix = {
  readonly columns: readonly string[]
  readonly values: readonly (readonly number[])[]
}

function numericProfileValue(profile: Record<string, unknown>, key: string) {
  const value = profile[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function roundAnalysisValue(value: number | undefined) {
  return value === undefined || !Number.isFinite(value) ? undefined : Number(value.toFixed(6))
}

function taskDatasetSpec(task: ResearchTask) {
  const taskSpec = recordValue(task.taskSpec)
  return recordValue(taskSpec.dataset)
}

function taskSpecJson(task: ResearchTask) {
  return JSON.stringify(task.taskSpec, null, 2)
}

function datasetRoleList(dataset: Record<string, unknown>, key: string) {
  return Array.isArray(dataset[key])
    ? dataset[key]!.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []
}

function csvCells(line: string) {
  const cells: string[] = []
  let current = ""
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"'
        index++
      } else {
        quoted = !quoted
      }
      continue
    }
    if (char === "," && !quoted) {
      cells.push(current)
      current = ""
      continue
    }
    current += char
  }
  cells.push(current)
  return cells
}

function datasetTargetColumns(task: ResearchTask, header: readonly string[]) {
  const dataset = taskDatasetSpec(task)
  const targetCols = Array.isArray(dataset.targetCols)
    ? dataset.targetCols.filter((item): item is string => typeof item === "string" && header.includes(item))
    : []
  if (Array.isArray(dataset.targetCols) && dataset.targetCols.length > 0) {
    return targetCols.length === dataset.targetCols.length ? targetCols : []
  }
  return header.slice(1)
}

async function loadDatasetSeriesMatrix(task: ResearchTask): Promise<{ targets: DatasetSeriesMatrix; covariates: DatasetSeriesMatrix; timestamps?: number[] } | undefined> {
  const spec = TSFTaskSpec.safeParse(task.taskSpec)
  if (!spec.success) return undefined
  const source = resolveTSFProfileSource(spec.data, {
    taskID: task.id, projectRoot: Instance.directory, workspaceRoot: taskExecutionRoot(task, Instance.directory),
  })
  if (source.raw === undefined) return undefined
  const lines = source.raw.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length < 3) return undefined
  const header = csvCells(lines[0]!)
  const targets = datasetTargetColumns(task, header).filter((name) => !spec.data.dataset.observedPastCovariates.includes(name))
  const covariates = spec.data.dataset.observedPastCovariates
  if (!targets.length || covariates.some((name) => !header.includes(name))) return undefined
  // Match the bounded column selection in the fingerprint; each role has its own limit.
  const sample = (columns: readonly string[]) => columns.length <= 20 ? [...columns]
    : Array.from({ length: 20 }, (_, index) => columns[Math.round(index * (columns.length - 1) / 19)]!)
  const targetColumns = sample(targets), covariateColumns = sample(covariates)
  const indexes = [...targetColumns, ...covariateColumns].map((name) => header.indexOf(name))
  const timestampIndex = header.findIndex((name) => ["date", "time", "timestamp", "datetime"].includes(name.toLowerCase()))
  const rows = lines.slice(1, source.usingTrainFile ? undefined : 5001).map(csvCells)
  const values = rows.map((row) => indexes.map((index) => {
    const value = row[index]?.trim()
    return value && Number.isFinite(Number(value)) ? Number(value) : Number.NaN
  }))
  const timestamps = timestampIndex < 0 ? undefined : rows.map((row) => Date.parse(row[timestampIndex] ?? ""))
  return {
    targets: { columns: targetColumns, values: values.map((row) => row.slice(0, targetColumns.length)) },
    covariates: { columns: covariateColumns, values: values.map((row) => row.slice(targetColumns.length)) },
    timestamps,
  }
}

function finiteSeries(values: readonly number[]) {
  return values.filter((value) => Number.isFinite(value))
}

function finiteMean(values: readonly number[]) {
  const finite = finiteSeries(values)
  if (finite.length === 0) return undefined
  return finite.reduce((sum, value) => sum + value, 0) / finite.length
}

function variance(values: readonly number[]) {
  const finite = finiteSeries(values)
  const avg = finiteMean(finite)
  if (avg === undefined || finite.length < 2) return undefined
  return finite.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (finite.length - 1)
}

function matrixColumn(matrix: DatasetSeriesMatrix, columnIndex: number) {
  return matrix.values.map((row) => row[columnIndex] ?? Number.NaN)
}

function aggregateSeries(matrix: DatasetSeriesMatrix) {
  return matrix.values.map((row) => {
    const finite = finiteSeries(row)
    return finite.length === 0 ? Number.NaN : finite.reduce((sum, value) => sum + value, 0) / finite.length
  })
}

function correlationAtLag(left: readonly number[], right: readonly number[], lag: number) {
  const xs: number[] = []
  const ys: number[] = []
  const start = Math.max(0, -lag)
  const end = Math.min(left.length, right.length - lag)
  for (let index = start; index < end; index++) {
    const x = left[index]
    const y = right[index + lag]
    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) continue
    xs.push(x)
    ys.push(y)
  }
  if (xs.length < 3) return undefined
  const xMean = finiteMean(xs)
  const yMean = finiteMean(ys)
  if (xMean === undefined || yMean === undefined) return undefined
  let numerator = 0
  let xDenom = 0
  let yDenom = 0
  for (let index = 0; index < xs.length; index++) {
    const dx = xs[index]! - xMean
    const dy = ys[index]! - yMean
    numerator += dx * dy
    xDenom += dx * dx
    yDenom += dy * dy
  }
  const denom = Math.sqrt(xDenom * yDenom)
  return denom === 0 ? undefined : numerator / denom
}

function averageAutocorrelation(matrix: DatasetSeriesMatrix, lag: number) {
  const correlations = matrix.columns
    .map((_, index) => correlationAtLag(matrixColumn(matrix, index), matrixColumn(matrix, index), lag))
    .filter((value): value is number => value !== undefined && Number.isFinite(value))
  if (correlations.length === 0) return undefined
  return correlations.reduce((sum, value) => sum + value, 0) / correlations.length
}

function topLag(values: readonly { lag: number; value: number }[]) {
  return values.toSorted((left, right) => Math.abs(right.value) - Math.abs(left.value))[0]
}

function stationarityAnalysis(matrix: DatasetSeriesMatrix, profile: Record<string, unknown>) {
  const series = finiteSeries(aggregateSeries(matrix))
  const avg = finiteMean(series)
  const seriesVariance = variance(series)
  let kpssStatistic: number | undefined
  if (avg !== undefined && seriesVariance !== undefined && seriesVariance > 0 && series.length > 2) {
    let cumulative = 0
    const cumulativeSquares = series.reduce((sum, value) => {
      cumulative += value - avg
      return sum + cumulative * cumulative
    }, 0)
    kpssStatistic = cumulativeSquares / (series.length * series.length * seriesVariance)
  }
  return {
    adfStatistic: roundAnalysisValue(numericProfileValue(profile, "adfStatistic")),
    adfStationary: typeof profile.adfStationary === "boolean" ? profile.adfStationary : undefined,
    kpssStatistic: roundAnalysisValue(kpssStatistic),
    kpssStationary: kpssStatistic === undefined ? undefined : kpssStatistic < 0.463,
  }
}

function acfPacfAnalysis(matrix: DatasetSeriesMatrix, maxLag: number) {
  const acfValues = Array.from({ length: maxLag }, (_, index) => {
    const lag = index + 1
    return { lag, value: averageAutocorrelation(matrix, lag) }
  }).filter((item): item is { lag: number; value: number } => item.value !== undefined)
  const pacfValues = acfValues.map((item, index) => ({
    lag: item.lag,
    value: index === 0 ? item.value : item.value - acfValues[index - 1]!.value * acfValues[0]!.value,
  }))
  const acfTop = topLag(acfValues)
  const pacfTop = topLag(pacfValues)
  return {
    topLag: acfTop?.lag,
    topCorrelation: roundAnalysisValue(acfTop?.value),
    pacfTopLag: pacfTop?.lag,
    pacfTopCorrelation: roundAnalysisValue(pacfTop?.value),
  }
}

function frequencyAnalysis(series: readonly number[]) {
  const avg = finiteMean(series) ?? 0
  // Preserve observation positions rather than compressing time across missing cells.
  const centered = series.map((value) => Number.isFinite(value) ? value - avg : 0)
  if (centered.length < 4) return { spectralPeaks: [] }
  const powers = spectralPowers(centered)
  const totalPower = powers.reduce((sum, item) => sum + item.power, 0)
  if (totalPower <= 1e-20) return { spectralPeaks: [] }
  const best = powers.toSorted((left, right) => right.power - left.power)[0]
  const localPeaks = powers.filter((item, index) => {
    const previous = powers[index - 1]?.power ?? Number.NEGATIVE_INFINITY
    const next = powers[index + 1]?.power ?? Number.NEGATIVE_INFINITY
    return item.power >= previous && item.power >= next && item.period >= 2
  })
  const strongestShare = best && totalPower > 0 ? best.power / totalPower : 0
  const significanceThreshold = Math.max(0.02, strongestShare * 0.1)
  const spectralPeaks = localPeaks
    .map((item) => ({
      period: roundAnalysisValue(item.period)!,
      powerShare: roundAnalysisValue(totalPower > 0 ? item.power / totalPower : 0)!,
      significant: totalPower > 0 && item.power / totalPower >= significanceThreshold,
    }))
    .toSorted((left, right) => right.powerShare - left.powerShare)
    .slice(0, 8)
  return {
    dominantPeriod: roundAnalysisValue(best?.period),
    dominantPowerShare: roundAnalysisValue(best && totalPower > 0 ? best.power / totalPower : undefined),
    spectralPeaks,
  }
}

function changepointAnalysis(series: readonly number[]) {
  const std = Math.sqrt(variance(series) ?? 0)
  const minWindow = Math.max(6, Math.floor(series.length * 0.1))
  if (series.length < minWindow * 2 || std === 0) return {}
  const total = finiteSeries(series).reduce((sum, value) => sum + value, 0)
  const count = finiteSeries(series).length
  let prefix = 0, prefixCount = 0
  let best: { index: number; score: number } | undefined
  for (let index = 1; index <= series.length - minWindow; index++) {
    const value = series[index - 1]!
    if (Number.isFinite(value)) { prefix += value; prefixCount++ }
    if (index < minWindow || !prefixCount || count === prefixCount) continue
    const score = Math.abs(prefix / prefixCount - (total - prefix) / (count - prefixCount)) / std
    if (!best || score > best.score) best = { index, score }
  }
  return {
    index: best?.index,
    score: roundAnalysisValue(best?.score),
    severity: best === undefined ? undefined : best.score >= 1 ? "high" : best.score >= 0.5 ? "medium" : "low",
  }
}

function crossLagAnalysis(targets: DatasetSeriesMatrix, maxLag: number, covariates?: DatasetSeriesMatrix) {
  let best: DatasetStatisticalAnalysis["crossLag"] = {}
  const sources = covariates?.columns.length ? covariates : targets
  for (let sourceIndex = 0; sourceIndex < sources.columns.length; sourceIndex++) {
    for (let targetIndex = 0; targetIndex < targets.columns.length; targetIndex++) {
      if (sources.columns[sourceIndex] === targets.columns[targetIndex]) continue
      const left = matrixColumn(sources, sourceIndex), right = matrixColumn(targets, targetIndex)
      // Positive lag means the observed source leads the target. No future covariate values are used.
      for (let lag = 1; lag <= maxLag; lag++) {
        const correlation = correlationAtLag(left, right, lag)
        if (correlation === undefined) continue
        if (best.correlation === undefined || Math.abs(correlation) > Math.abs(best.correlation)) {
          best = { source: sources.columns[sourceIndex], target: targets.columns[targetIndex], lag, correlation: roundAnalysisValue(correlation) }
        }
      }
    }
  }
  return best
}

function buildStatisticalAnalysis(matrix: DatasetSeriesMatrix | undefined, fingerprint: JsonRecord): DatasetStatisticalAnalysis {
  const profile = recordValue(recordValue(fingerprint).datasetProfile)
  if (!matrix) {
    return {
      stationarity: {
        adfStatistic: roundAnalysisValue(numericProfileValue(profile, "adfStatistic")),
        adfStationary: typeof profile.adfStationary === "boolean" ? profile.adfStationary : undefined,
      },
      acf: {
        topLag: typeof profile.acfMainPeriod === "number" ? profile.acfMainPeriod : undefined,
        topCorrelation: roundAnalysisValue(numericProfileValue(profile, "acfMainPeriodStrength")),
      },
      decomposition: {},
      frequency: { spectralPeaks: [] },
      changepoint: {},
      crossLag: {},
    }
  }
  const maxLag = Math.max(1, Math.min(40, Math.floor(matrix.values.length / 2)))
  const series = aggregateSeries(matrix)
  return {
    stationarity: stationarityAnalysis(matrix, profile),
    acf: acfPacfAnalysis(matrix, maxLag),
    decomposition: decomposeSeasonality(matrix.values, numericProfileValue(profile, "acfMainPeriod")),
    frequency: frequencyAnalysis(series),
    changepoint: changepointAnalysis(series),
    crossLag: crossLagAnalysis(matrix, Math.min(24, maxLag)),
  }
}

const pngSignature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])

function crc32(buffer: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array) {
  const typeBytes = Buffer.from(type, "ascii")
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crcInput = Buffer.concat([typeBytes, Buffer.from(data)])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(crcInput), 0)
  return Buffer.concat([length, typeBytes, Buffer.from(data), crc])
}

function simplePng(width: number, height: number, values: readonly number[], accent: [number, number, number]) {
  const pixels = Buffer.alloc((width * 3 + 1) * height, 255)
  const setPixel = (x: number, y: number, color: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const offset = y * (width * 3 + 1) + 1 + x * 3
    pixels[offset] = color[0]
    pixels[offset + 1] = color[1]
    pixels[offset + 2] = color[2]
  }
  for (let x = 28; x < width - 8; x++) setPixel(x, height - 24, [70, 70, 80])
  for (let y = 8; y < height - 24; y++) setPixel(28, y, [70, 70, 80])
  const finite = finiteSeries(values)
  const min = finite.length ? Math.min(...finite) : 0
  const max = finite.length ? Math.max(...finite) : 1
  const span = max - min || 1
  const chartWidth = width - 40
  const chartHeight = height - 36
  const samples = values.length > 0 ? values : [0]
  for (let index = 0; index < samples.length; index++) {
    const value = Number.isFinite(samples[index]!) ? samples[index]! : min
    const x = 30 + Math.floor((index / Math.max(1, samples.length - 1)) * (chartWidth - 1))
    const y = 8 + Math.floor((1 - (value - min) / span) * (chartHeight - 1))
    for (let dy = y; dy < height - 24; dy++) setPixel(x, dy, accent)
    setPixel(x, y, [20, 24, 32])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const compressed = deflateSync(pixels)
  return Buffer.concat([
    Buffer.from(pngSignature),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

function buildDatasetAnalysisPlots(
  matrix: DatasetSeriesMatrix | undefined,
  statistics: DatasetStatisticalAnalysis,
): DatasetAnalysisPlot[] {
  const series = matrix ? aggregateSeries(matrix) : [0]
  const acfValues = matrix
    ? Array.from({ length: Math.max(1, Math.min(24, Math.floor(matrix.values.length / 2))) }, (_, index) =>
        Math.abs(averageAutocorrelation(matrix, index + 1) ?? 0),
      )
    : [0]
  const decompositionValues = [
    statistics.decomposition.trendVarianceShare ?? 0,
    statistics.decomposition.seasonalVarianceShare ?? 0,
    statistics.decomposition.residualVarianceShare ?? 0,
  ]
  const crossLagValue = statistics.crossLag.correlation === undefined ? [0] : [Math.abs(statistics.crossLag.correlation)]
  const baseMetadata = { format: "png", role: "quantitative-data-analyst", phase: "data_analysis" } as JsonRecord
  const plots: DatasetAnalysisPlot[] = [
    {
      kind: "dataset_analysis_plot_png",
      filename: "time-series-overview.png",
      relativePath: "quantitative/plots/time-series-overview.png",
      role: "quantitative-data-analyst",
      data: simplePng(480, 240, series, [80, 140, 240]),
      metadata: { ...baseMetadata, plotType: "time_series_overview", title: "Time series overview" },
    },
    {
      kind: "dataset_analysis_plot_png",
      filename: "acf-pacf.png",
      relativePath: "quantitative/plots/acf-pacf.png",
      role: "quantitative-data-analyst",
      data: simplePng(480, 240, acfValues, [240, 150, 80]),
      metadata: { ...baseMetadata, plotType: "acf_pacf", title: "ACF/PACF diagnostics" },
    },
    {
      kind: "dataset_analysis_plot_png",
      filename: "stl-decomposition.png",
      relativePath: "quantitative/plots/stl-decomposition.png",
      role: "quantitative-data-analyst",
      data: simplePng(480, 240, decompositionValues, [110, 190, 120]),
      metadata: { ...baseMetadata, plotType: "stl_decomposition", title: "Per-channel moving-average seasonal decomposition" },
    },
    {
      kind: "dataset_analysis_plot_png",
      filename: "cross-lag.png",
      relativePath: "quantitative/plots/cross-lag.png",
      role: "quantitative-data-analyst",
      data: simplePng(480, 240, crossLagValue, [190, 110, 220]),
      metadata: { ...baseMetadata, plotType: "cross_lag", title: "Cross-lag correlation" },
    },
  ]
  return plots.filter((plot) => plot.metadata.plotType !== "stl_decomposition" || statistics.decomposition.period !== undefined)
}

export async function buildDatasetAnalysisContext(task: ResearchTask, fingerprint: JsonRecord): Promise<DatasetAnalysisContext> {
  const bundle = await loadDatasetSeriesMatrix(task)
  const matrix = bundle?.targets
  const statistics = { ...buildStatisticalAnalysis(matrix, fingerprint),
    ...(bundle?.covariates.columns.length ? { crossLag: crossLagAnalysis(bundle.targets, 24, bundle.covariates) } : {}),
  }
  const covariates = bundle?.covariates.columns.map((column, index) => {
    const matrix = { columns: [column], values: bundle.covariates.values.map((row) => [row[index]!]) }
    const profile = profileSeries(matrix.values, bundle.timestamps)
    const statistics = { ...buildStatisticalAnalysis(matrix, { datasetProfile: profile } as unknown as JsonRecord),
      crossLag: crossLagAnalysis(bundle.targets, 24, matrix),
    }
    return { column, role: "observed_past" as const, profile, statistics }
  })
  return {
    statistics,
    rowCount: matrix?.values.length,
    ...(covariates?.length ? { covariates } : {}),
    plotRefs: buildDatasetAnalysisPlots(matrix, statistics),
  }
}

function finiteOrZero(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function nonnegativeIntegerOrZero(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0
}

function positiveInteger(value: unknown, fallback = 1) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback
}

export function buildDatasetQuantitativeAnalysis(input: {
  readonly task: ResearchTask
  readonly fingerprint: JsonRecord
  readonly context: DatasetAnalysisContext
  readonly sourceArtifactIDs?: readonly ResearchArtifactID[]
}): DatasetQuantitativeAnalysis {
  const taskSpec = recordValue(input.task.taskSpec)
  const dataset = taskDatasetSpec(input.task)
  const metadata = recordValue(taskSpec.metadata)
  const profile = recordValue(recordValue(input.fingerprint).datasetProfile)
  const warning = recordValue(recordValue(input.fingerprint).datasetProfileWarning)
  const contextLength = positiveInteger(taskSpec.contextLength, positiveInteger(input.fingerprint.contextLength))
  const predictionLengths = Array.isArray(taskSpec.predictionLengths)
    ? taskSpec.predictionLengths.filter((item): item is number => typeof item === "number" && Number.isInteger(item) && item > 0)
    : []
  const safePredictionLengths = predictionLengths.length > 0 ? predictionLengths : [positiveInteger(input.fingerprint.maxPredictionLength)]
  const samplingFrequency = [dataset.samplingFrequency, dataset.frequency, metadata.samplingFrequency, metadata.frequency]
    .find((item): item is string => typeof item === "string" && item.trim().length > 0)?.trim() ?? "unknown"
  return DatasetQuantitativeAnalysisSchema.parse({
    schemaVersion: "dataset_quantitative_analysis_v1",
    taskID: input.task.id,
    domain: input.task.domainID,
    dataset: {
      samplingFrequency,
      targetColumns: datasetRoleList(dataset, "targetCols"),
      observedPastCovariates: datasetRoleList(dataset, "observedPastCovariates"),
      knownFutureCovariates: datasetRoleList(dataset, "knownFutureCovariates"),
      staticCovariates: datasetRoleList(dataset, "staticCovariates"),
    },
    forecast: {
      contextLength,
      predictionLengths: safePredictionLengths,
      horizonContextRatio: finiteOrZero(input.fingerprint.horizonContextRatio) || Math.max(...safePredictionLengths) / contextLength,
    },
    ...(input.context.rowCount === undefined ? {} : { analysisCoverage: {
      profiledRows: nonnegativeIntegerOrZero(profile.profiledRowCount),
      statisticRows: input.context.rowCount,
      targetColumns: stringArray(profile.profiledTargetColumns),
      covariateColumns: stringArray(profile.profiledCovariateColumns),
    } }),
    profile: {
      rowCount: nonnegativeIntegerOrZero(profile.rowCount),
      missingRate: finiteOrZero(profile.missingRate),
      trendStrength: finiteOrZero(profile.trendStrength),
      seasonalityStrength: finiteOrZero(profile.seasonalityStrength),
      crossVarCorrelation: numberValue(profile.crossVarCorrelation),
      ...(profile.correlations ? { correlations: profile.correlations } : {}),
      distributionShift: finiteOrZero(profile.distributionShift),
      outlierRate: finiteOrZero(profile.outlierRate),
      irregularIntervalRatio: finiteOrZero(profile.irregularIntervalRatio),
    },
    statistics: input.context.statistics,
    ...(input.context.covariates ? { covariates: input.context.covariates } : {}),
    warnings: Object.keys(warning).length === 0
      ? []
      : [`${typeof warning.code === "string" ? warning.code : "dataset_profile_warning"}: ${typeof warning.message === "string" ? warning.message : "dataset profile warning"}`],
    sourceArtifactIDs: input.sourceArtifactIDs ?? [],
  })
}

function renderCovariateAnalysis(report: DatasetQuantitativeAnalysis) {
  const lines = ["## Target Correlations", "", ...renderCorrelationSummary(report.profile.correlations), "", "## Observed-past Covariate Analysis", ""]
  if (!report.covariates?.length) return [...lines, "- No covariate diagnostics are available; this does not establish weak or independent covariates.", ""]
  for (const item of report.covariates) {
    const stats = item.statistics
    lines.push(`### ${item.column}`, "", ...renderDatasetProfileAnalysis(item.profile), "",
      `- Stationarity: ${JSON.stringify(stats.stationarity)}`,
      `- ACF/PACF: ${JSON.stringify(stats.acf)}`,
      `- Moving-average seasonal decomposition: ${JSON.stringify(stats.decomposition)}`,
      `- Frequency: ${JSON.stringify(stats.frequency)}`,
      `- Change point: ${JSON.stringify(stats.changepoint)}`,
      `- Lead-lag into targets (positive lag = covariate leads): ${JSON.stringify(stats.crossLag)}`, "")
  }
  return lines
}

export function analyzeDataset(input: {
  readonly task: ResearchTask
  readonly fingerprint: JsonRecord
  readonly context: DatasetAnalysisContext
  readonly sourceArtifactIDs?: readonly ResearchArtifactID[]
}): DataAnalysisQuantitativeResult {
  const { task, fingerprint, context } = input
  const quantitative = buildDatasetQuantitativeAnalysis(input)
  const profile = quantitative.profile
  const rawProfile = recordValue(recordValue(fingerprint).datasetProfile)
  const dataset = quantitative.dataset
  const stats = context.statistics
  const targetCols = dataset.targetColumns
  const observedPastCovariates = dataset.observedPastCovariates
  const knownFutureCovariates = dataset.knownFutureCovariates
  const staticCovariates = dataset.staticCovariates
  const rows: [string, unknown, string][] = [
    ["Rows", profile.rowCount, "usable observations detected in the CSV profile"],
    ["Targets", targetCols.length, "forecast target columns used by the task"],
    ["Missing rate", profile.missingRate, "fraction of missing numeric target cells"],
    ["Trend strength", profile.trendStrength, "mean absolute correlation with time index"],
    ["Seasonality strength", profile.seasonalityStrength, "mean positive detrended ACF peak strength; cadence-aware periods, at least three cycles"],
    ["Cross-variate correlation", profile.crossVarCorrelation, "mean absolute target–covariate correlation when covariates are configured; otherwise target–target correlation; unavailable pairs are omitted"],
    ["Distribution shift", profile.distributionShift, "normalized first-half vs second-half drift"],
    ["Outlier rate", profile.outlierRate, "IQR-based extreme-value share"],
    ["ACF main period", rawProfile.acfMainPeriod, "detected seasonal period in observations; short-lag persistence alone is insufficient"],
    ["ACF main period strength", rawProfile.acfMainPeriodStrength, "mean detrended periodic peak strength at the detected period"],
    ["ADF statistic", rawProfile.adfStatistic, "Augmented Dickey-Fuller style stationarity statistic"],
    ["ADF stationarity", rawProfile.adfStationary, "whether the profile suggests stationarity at the default threshold"],
    ["Irregular interval ratio", profile.irregularIntervalRatio, "timestamp cadence instability"],
    ["Duplicate timestamp rate", rawProfile.duplicateTimestampRate, "duplicate timestamp share"],
    ["KPSS statistic", stats.stationarity.kpssStatistic, "level-stationarity diagnostic; lower values support stationary residual behavior"],
    ["KPSS stationarity", stats.stationarity.kpssStationary, "whether the KPSS-style statistic remains below the default level threshold"],
    ["ACF top lag", stats.acf.topLag, "lag with strongest average autocorrelation across target columns"],
    ["ACF top correlation", stats.acf.topCorrelation, "strength of the strongest average autocorrelation lag"],
    ["PACF top lag", stats.acf.pacfTopLag, "lag with strongest approximate partial autocorrelation"],
    ["PACF top correlation", stats.acf.pacfTopCorrelation, "approximate partial autocorrelation strength at the selected lag"],
    ["Dominant frequency period", stats.frequency.dominantPeriod, "DFT-derived period with highest spectral power"],
    ["Dominant frequency power share", stats.frequency.dominantPowerShare, "share of spectral energy explained by the dominant period"],
    ["Change point", stats.changepoint.index, "index with largest normalized mean shift between prefix and suffix windows"],
    ["Change point score", stats.changepoint.score, "normalized change-point severity score"],
    ["Cross-lag", stats.crossLag.lag, "best positive source-leading lag into forecast targets"],
    ["Cross-lag correlation", stats.crossLag.correlation, "strongest historical covariate-to-target lead-lag correlation; target pairs only when no covariates are configured"],
  ]
  const lines = [
    "# Quantitative Sub-Agent Data Analysis",
    "",
    "- Agent: quantitative-data-analyst",
    `- Task ID: ${task.id}`,
    `- Primary metric: ${renderAnalysisValue(recordValue(task.objective).primaryMetric)}`,
    `- Direction: ${renderAnalysisValue(recordValue(task.objective).direction)}`,
    "",
    "## Task Spec Contract",
    "",
    "- `targetCount` and target diagnostics below describe forecast targets only; they do not imply that exogenous variables are unavailable.",
    `- Target columns: ${targetCols.length > 0 ? targetCols.join(", ") : "n/a"}`,
    `- Observed past covariates: ${observedPastCovariates.length > 0 ? observedPastCovariates.join(", ") : "none"}`,
    `- Known future covariates: ${knownFutureCovariates.length > 0 ? knownFutureCovariates.join(", ") : "none"}`,
    `- Static covariates: ${staticCovariates.length > 0 ? staticCovariates.join(", ") : "none"}`,
    "",
    "```json",
    taskSpecJson(task),
    "```",
    "",
    "## Dataset Metrics",
    "",
    ...(quantitative.analysisCoverage ? [
      `- Target summary and contemporaneous correlations use ${quantitative.analysisCoverage.profiledRows} leading observations; statistical diagnostics and detailed per-covariate profiles use ${quantitative.analysisCoverage.statisticRows} observations. Both use verified training data when available; otherwise both use a bounded source prefix.`,
      `- Sampled targets: ${quantitative.analysisCoverage.targetColumns.join(", ")}; sampled covariates: ${quantitative.analysisCoverage.covariateColumns.join(", ") || "none"}. Each role is bounded to 20 columns.`,
      "",
    ] : []),
    "| Metric | Value | Interpretation |",
    "| --- | ---: | --- |",
    ...rows.map(([label, value, meaning]) => `| ${label} | ${renderAnalysisValue(value)} | ${meaning} |`),
    "",
    "## Constraint Signals",
    "",
    `- Context length: ${renderAnalysisValue(recordValue(fingerprint).contextLength)}`,
    `- Max prediction length: ${renderAnalysisValue(recordValue(fingerprint).maxPredictionLength)}`,
    `- Horizon/context ratio: ${renderAnalysisValue(recordValue(fingerprint).horizonContextRatio)}`,
    `- Max params: ${renderAnalysisValue(recordValue(fingerprint).maxParams)}`,
    `- Max training seconds: ${renderAnalysisValue(recordValue(fingerprint).maxTrainingSeconds)}`,
    "",
    "## Statistical Tests",
    "",
    `- ADF statistic: ${renderAnalysisValue(stats.stationarity.adfStatistic)}; stationary=${renderAnalysisValue(stats.stationarity.adfStationary)}`,
    `- KPSS statistic: ${renderAnalysisValue(stats.stationarity.kpssStatistic)}; stationary=${renderAnalysisValue(stats.stationarity.kpssStationary)}`,
    `- PACF top lag: ${renderAnalysisValue(stats.acf.pacfTopLag)} (${renderAnalysisValue(stats.acf.pacfTopCorrelation)})`,
    "",
    "## Per-channel moving-average seasonal decomposition",
    "",
    `- Period: ${renderAnalysisValue(stats.decomposition.period)}`,
    "- Method: centered moving-average detrending and phase means, averaged per channel; this is not STL. Variance shares need not sum to one. A low global phase share does not rule out changing local seasonality.",
    ...(stats.decomposition.period === undefined ? ["- No supported seasonal period was detected; decomposition shares are unavailable, not zero."] : []),
    `- Trend variance share: ${renderAnalysisValue(stats.decomposition.trendVarianceShare)}`,
    `- Seasonal variance share: ${renderAnalysisValue(stats.decomposition.seasonalVarianceShare)}`,
    `- Residual variance share: ${renderAnalysisValue(stats.decomposition.residualVarianceShare)}`,
    "",
    "## Frequency and Change Diagnostics",
    "",
    `- Dominant frequency period: ${renderAnalysisValue(stats.frequency.dominantPeriod)} with power share ${renderAnalysisValue(stats.frequency.dominantPowerShare)}`,
    `- Spectral peaks: ${stats.frequency.spectralPeaks.length > 0 ? stats.frequency.spectralPeaks.map((peak) => `${renderAnalysisValue(peak.period)} (${renderAnalysisValue(peak.powerShare)}, significant=${peak.significant})`).join("; ") : "n/a"}`,
    `- Change point: ${renderAnalysisValue(stats.changepoint.index)} score=${renderAnalysisValue(stats.changepoint.score)} severity=${renderAnalysisValue(stats.changepoint.severity)}`,
    `- Cross-lag: ${renderAnalysisValue(stats.crossLag.source)} -> ${renderAnalysisValue(stats.crossLag.target)} lag=${renderAnalysisValue(stats.crossLag.lag)} corr=${renderAnalysisValue(stats.crossLag.correlation)}`,
    "",
    ...renderCovariateAnalysis(quantitative),
    "## Visualizations",
    "",
    ...context.plotRefs.map((plot) => `![${plot.metadata.title}](${plot.relativePath})`),
  ]
  return {
    agent: "DataAnalysisAgent",
    taskID: task.id,
    reportMarkdown: `${lines.join("\n")}\n`,
    reportJSON: quantitative,
    llm: { status: "disabled" },
  }
}

export function buildDatasetAnalysisReportMarkdown(input: {
  readonly task: ResearchTask
  readonly fingerprint: JsonRecord
  readonly sourceArtifactIDs?: readonly ResearchArtifactID[]
  readonly sourceReports?: readonly DatasetAnalysisSourceReport[]
}) {
  const profile = recordValue(input.fingerprint.datasetProfile)
  const warning = recordValue(input.fingerprint.datasetProfileWarning)
  const searchBiases = stringArray(input.fingerprint.searchBiases)
  const warningCode = typeof warning.code === "string" ? warning.code : undefined
  const lines = [
    "# Dataset Analysis Report",
    "",
    `- Agent: DataAnalysisAgent`,
    `- Task ID: ${input.task.id}`,
    `- Domain: ${input.task.domainID}`,
    "",
    "## Dataset Profile",
    "",
    ...renderDatasetProfileAnalysis(profile),
    "",
    "## Target Correlations",
    "",
    ...renderCorrelationMatrix(profile.correlations),
    "",
    "## Observed-past Covariate Profiles",
    "",
    ...(Array.isArray(profile.covariateProfiles) ? profile.covariateProfiles.flatMap((item) => [
      `### ${String(recordValue(item).column)}`, ...renderDatasetProfileAnalysis(item), "",
    ]) : ["- No covariate profiles available."]),
    "",
    "## Search Handoff",
    "",
    ...(searchBiases.length === 0 ? ["- No profile-derived search biases."] : searchBiases.map((item) => `- ${item}`)),
    "",
    "## Source Artifacts",
    "",
    ...(input.sourceArtifactIDs?.length
      ? input.sourceArtifactIDs.map((id) => `- ${id}`)
      : ["- No sub-agent artifacts were attached."]),
    "",
    "## Sub-Agent Reports",
    "",
    ...(input.sourceReports?.length
      ? input.sourceReports.flatMap((report) => [renderSourceReport(report), ""])
      : ["- No sub-agent report bodies were attached."]),
  ]
  if (warningCode !== undefined) {
    lines.push(
      "",
      "## Warnings",
      "",
      `- ${warningCode}: ${typeof warning.message === "string" ? warning.message : "dataset profile warning"}`,
    )
  }
  return `${lines.join("\n")}\n`
}

export function summarizeDataAnalysisAgent(input: {
  readonly task: ResearchTask
  readonly fingerprint: JsonRecord
  readonly artifact: ResearchArtifact
  readonly sourceArtifactIDs: readonly ResearchArtifactID[]
}): DataAnalysisAgentResult {
  const warning = recordValue(input.fingerprint.datasetProfileWarning)
  return {
    agent: "DataAnalysisAgent",
    taskID: input.task.id,
    artifact: input.artifact,
    sourceArtifactIDs: input.sourceArtifactIDs,
    searchBiases: stringArray(input.fingerprint.searchBiases),
    warningCount: Object.keys(warning).length > 0 ? 1 : 0,
  }
}
