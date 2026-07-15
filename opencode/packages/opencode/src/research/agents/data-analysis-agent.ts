import { existsSync } from "fs"
import { readFile } from "fs/promises"
import path from "path"
import { deflateSync } from "zlib"
import { Instance } from "@/project/instance"
import type { JsonRecord, ResearchArtifact, ResearchArtifactID, ResearchTask } from "../schema"

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
  readonly statistics: DatasetStatisticalAnalysis
  readonly plotRefs: readonly DatasetAnalysisPlot[]
}

export interface DataAnalysisQuantitativeResult {
  readonly agent: "DataAnalysisAgent"
  readonly taskID: ResearchTask["id"]
  readonly reportMarkdown: string
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

function metricLine(label: string, value: unknown) {
  const number = numberValue(value)
  return `- ${label}: ${number === undefined ? "n/a" : Number(number.toFixed(6))}`
}

function markdownValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return Number(value.toFixed(6))
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "string" && value.length > 0) return value
  return "n/a"
}

function renderCorrelationMatrix(value: unknown) {
  const matrix = recordValue(value)
  const columns = Array.isArray(matrix.columns)
    ? matrix.columns.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []
  const values = Array.isArray(matrix.values) ? matrix.values : []
  if (columns.length === 0 || values.length === 0) return ["- Correlation matrix unavailable."]
  return [
    `| Target | ${columns.join(" | ")} |`,
    `| --- | ${columns.map(() => "---:").join(" | ")} |`,
    ...columns.map((column, index) => {
      const row = Array.isArray(values[index]) ? values[index]! : []
      return `| ${column} | ${columns
        .map((_, columnIndex) => markdownValue(row[columnIndex]))
        .join(" | ")} |`
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

function taskTrainDataPath(task: ResearchTask): string | undefined {
  const taskSpec = recordValue(task.taskSpec)
  const runtime = recordValue(taskSpec.runtime)
  const dataset = recordValue(taskSpec.dataset)
  const root = typeof runtime.neoCastProjectRoot === "string" ? runtime.neoCastProjectRoot.trim() : ""
  const loaderID = typeof dataset.loaderID === "string" ? dataset.loaderID.trim() : ""
  if (!root || !loaderID) return undefined
  const safeID = loaderID.replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 64)
  return path.join(root, ".neo-cast", "dataset", `${safeID}_train.csv`)
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
  if (targetCols.length > 0) return targetCols
  return header.slice(1)
}

async function loadDatasetSeriesMatrix(task: ResearchTask): Promise<DatasetSeriesMatrix | undefined> {
  const dataset = taskDatasetSpec(task)
  const trainPath = taskTrainDataPath(task)
  const resolvedTrainPath = trainPath && existsSync(trainPath) ? trainPath : undefined
  const rawPath = typeof dataset.path === "string" && dataset.path.length > 0
    ? (path.isAbsolute(dataset.path) ? dataset.path : path.join(Instance.directory, dataset.path))
    : undefined
  const datasetPath = resolvedTrainPath ?? rawPath
  if (!datasetPath || !existsSync(datasetPath)) return undefined
  const text = await readFile(datasetPath, "utf8")
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length < 3) return undefined
  const header = csvCells(lines[0]!)
  const columns = datasetTargetColumns(task, header)
  const columnIndexes = columns.map((column) => header.indexOf(column))
  if (columns.length === 0 || columnIndexes.some((index) => index < 0)) return undefined
  const values = lines.slice(1).map((line) => {
    const row = csvCells(line)
    return columnIndexes.map((columnIndex) => {
      const parsed = Number(row[columnIndex])
      return Number.isFinite(parsed) ? parsed : Number.NaN
    })
  })
  return { columns, values }
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
    return { lag, value: averageAutocorrelation(matrix, lag) ?? 0 }
  })
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
  const values = finiteSeries(series)
  const avg = finiteMean(values) ?? 0
  const centered = values.map((value) => value - avg)
  if (centered.length < 4) return {}
  const powers: Array<{ period: number; power: number }> = []
  for (let k = 1; k <= Math.floor(centered.length / 2); k++) {
    let real = 0
    let imag = 0
    for (let index = 0; index < centered.length; index++) {
      const angle = (2 * Math.PI * k * index) / centered.length
      real += centered[index]! * Math.cos(angle)
      imag -= centered[index]! * Math.sin(angle)
    }
    powers.push({ period: centered.length / k, power: real * real + imag * imag })
  }
  const totalPower = powers.reduce((sum, item) => sum + item.power, 0)
  const best = powers.toSorted((left, right) => right.power - left.power)[0]
  return {
    dominantPeriod: roundAnalysisValue(best?.period),
    dominantPowerShare: roundAnalysisValue(best && totalPower > 0 ? best.power / totalPower : undefined),
  }
}

function movingAverage(values: readonly number[], window: number) {
  const radius = Math.max(1, Math.floor(window / 2))
  return values.map((_, index) => {
    const slice = values.slice(Math.max(0, index - radius), Math.min(values.length, index + radius + 1))
    return finiteMean(slice) ?? values[index] ?? 0
  })
}

function decompositionAnalysis(series: readonly number[], period: number | undefined) {
  const values = finiteSeries(series)
  if (values.length < 4) return {}
  const resolvedPeriod = Math.max(2, Math.min(Math.floor(values.length / 2), Math.round(period ?? 12)))
  const trend = movingAverage(values, resolvedPeriod)
  const detrended = values.map((value, index) => value - trend[index]!)
  const seasonalMeans = Array.from({ length: resolvedPeriod }, (_, seasonalIndex) =>
    finiteMean(detrended.filter((_, index) => index % resolvedPeriod === seasonalIndex)) ?? 0,
  )
  const seasonal = detrended.map((_, index) => seasonalMeans[index % resolvedPeriod]!)
  const residual = values.map((value, index) => value - trend[index]! - seasonal[index]!)
  const totalVariance = variance(values) ?? 0
  const share = (part: readonly number[]) => (totalVariance > 0 ? (variance(part) ?? 0) / totalVariance : undefined)
  return {
    period: resolvedPeriod,
    trendVarianceShare: roundAnalysisValue(share(trend)),
    seasonalVarianceShare: roundAnalysisValue(share(seasonal)),
    residualVarianceShare: roundAnalysisValue(share(residual)),
  }
}

function changepointAnalysis(series: readonly number[]) {
  const values = finiteSeries(series)
  const std = Math.sqrt(variance(values) ?? 0)
  const minWindow = Math.max(6, Math.floor(values.length * 0.1))
  if (values.length < minWindow * 2 || std === 0) return {}
  let best: { index: number; score: number } | undefined
  for (let index = minWindow; index <= values.length - minWindow; index++) {
    const left = finiteMean(values.slice(0, index))
    const right = finiteMean(values.slice(index))
    if (left === undefined || right === undefined) continue
    const score = Math.abs(left - right) / std
    if (!best || score > best.score) best = { index, score }
  }
  return {
    index: best?.index,
    score: roundAnalysisValue(best?.score),
    severity: best === undefined ? undefined : best.score >= 1 ? "high" : best.score >= 0.5 ? "medium" : "low",
  }
}

function crossLagAnalysis(matrix: DatasetSeriesMatrix, maxLag: number) {
  let best: DatasetStatisticalAnalysis["crossLag"] = {}
  for (let leftIndex = 0; leftIndex < matrix.columns.length; leftIndex++) {
    for (let rightIndex = 0; rightIndex < matrix.columns.length; rightIndex++) {
      if (leftIndex === rightIndex) continue
      const left = matrixColumn(matrix, leftIndex)
      const right = matrixColumn(matrix, rightIndex)
      for (let lag = -maxLag; lag <= maxLag; lag++) {
        if (lag === 0) continue
        const correlation = correlationAtLag(left, right, lag)
        if (correlation === undefined) continue
        if (best.correlation === undefined || Math.abs(correlation) > Math.abs(best.correlation)) {
          best = {
            source: matrix.columns[leftIndex],
            target: matrix.columns[rightIndex],
            lag,
            correlation: roundAnalysisValue(correlation),
          }
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
      frequency: {},
      changepoint: {},
      crossLag: {},
    }
  }
  const maxLag = Math.max(1, Math.min(40, Math.floor(matrix.values.length / 2)))
  const series = aggregateSeries(matrix)
  return {
    stationarity: stationarityAnalysis(matrix, profile),
    acf: acfPacfAnalysis(matrix, maxLag),
    decomposition: decompositionAnalysis(series, numericProfileValue(profile, "acfMainPeriod")),
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
  return [
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
      metadata: { ...baseMetadata, plotType: "stl_decomposition", title: "STL-style decomposition" },
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
}

export async function buildDatasetAnalysisContext(task: ResearchTask, fingerprint: JsonRecord): Promise<DatasetAnalysisContext> {
  const matrix = await loadDatasetSeriesMatrix(task)
  const statistics = buildStatisticalAnalysis(matrix, fingerprint)
  return {
    statistics,
    plotRefs: buildDatasetAnalysisPlots(matrix, statistics),
  }
}

export function analyzeDataset(input: {
  readonly task: ResearchTask
  readonly fingerprint: JsonRecord
  readonly context: DatasetAnalysisContext
}): DataAnalysisQuantitativeResult {
  const { task, fingerprint, context } = input
  const profile = recordValue(recordValue(fingerprint).datasetProfile)
  const dataset = taskDatasetSpec(task)
  const stats = context.statistics
  const targetCols = datasetRoleList(dataset, "targetCols")
  const observedPastCovariates = datasetRoleList(dataset, "observedPastCovariates")
  const knownFutureCovariates = datasetRoleList(dataset, "knownFutureCovariates")
  const staticCovariates = datasetRoleList(dataset, "staticCovariates")
  const rows: [string, unknown, string][] = [
    ["Rows", profile.rowCount, "usable observations detected in the CSV profile"],
    ["Targets", profile.targetCount, "forecast target columns used by the task"],
    ["Missing rate", profile.missingRate, "fraction of missing numeric target cells"],
    ["Trend strength", profile.trendStrength, "mean absolute correlation with time index"],
    ["Seasonality strength", profile.seasonalityStrength, "best lag-correlation over common TSF lags"],
    ["Cross-variate correlation", profile.crossVarCorrelation, "mean absolute pairwise target correlation"],
    ["Distribution shift", profile.distributionShift, "normalized first-half vs second-half drift"],
    ["Outlier rate", profile.outlierRate, "IQR-based extreme-value share"],
    ["ACF main period", profile.acfMainPeriod, "dominant lag from average target autocorrelation"],
    ["ACF main period strength", profile.acfMainPeriodStrength, "mean autocorrelation strength at the dominant lag"],
    ["ADF statistic", profile.adfStatistic, "Augmented Dickey-Fuller style stationarity statistic"],
    ["ADF stationarity", profile.adfStationary, "whether the profile suggests stationarity at the default threshold"],
    ["Irregular interval ratio", profile.irregularIntervalRatio, "timestamp cadence instability"],
    ["Duplicate timestamp rate", profile.duplicateTimestampRate, "duplicate timestamp share"],
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
    ["Cross-lag", stats.crossLag.lag, "best non-zero lag between target columns"],
    ["Cross-lag correlation", stats.crossLag.correlation, "strongest absolute lead-lag correlation across target pairs"],
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
    "## STL-style decomposition",
    "",
    `- Period: ${renderAnalysisValue(stats.decomposition.period)}`,
    `- Trend variance share: ${renderAnalysisValue(stats.decomposition.trendVarianceShare)}`,
    `- Seasonal variance share: ${renderAnalysisValue(stats.decomposition.seasonalVarianceShare)}`,
    `- Residual variance share: ${renderAnalysisValue(stats.decomposition.residualVarianceShare)}`,
    "",
    "## Frequency and Change Diagnostics",
    "",
    `- Dominant frequency period: ${renderAnalysisValue(stats.frequency.dominantPeriod)} with power share ${renderAnalysisValue(stats.frequency.dominantPowerShare)}`,
    `- Change point: ${renderAnalysisValue(stats.changepoint.index)} score=${renderAnalysisValue(stats.changepoint.score)} severity=${renderAnalysisValue(stats.changepoint.severity)}`,
    `- Cross-lag: ${renderAnalysisValue(stats.crossLag.source)} -> ${renderAnalysisValue(stats.crossLag.target)} lag=${renderAnalysisValue(stats.crossLag.lag)} corr=${renderAnalysisValue(stats.crossLag.correlation)}`,
    "",
    "## Visualizations",
    "",
    ...context.plotRefs.map((plot) => `![${plot.metadata.title}](${plot.relativePath})`),
  ]
  return {
    agent: "DataAnalysisAgent",
    taskID: task.id,
    reportMarkdown: `${lines.join("\n")}\n`,
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
    metricLine("Rows", profile.rowCount),
    metricLine("Target columns", profile.targetCount),
    metricLine("Missing rate", profile.missingRate),
    metricLine("Trend strength", profile.trendStrength),
    metricLine("Seasonality strength", profile.seasonalityStrength),
    metricLine("Cross-variate correlation", profile.crossVarCorrelation),
    metricLine("Distribution shift", profile.distributionShift),
    metricLine("Outlier rate", profile.outlierRate),
    metricLine("ACF main period", profile.acfMainPeriod),
    metricLine("ACF main period strength", profile.acfMainPeriodStrength),
    metricLine("ADF statistic", profile.adfStatistic),
    `- ADF stationarity: ${markdownValue(profile.adfStationary)}`,
    "",
    "## Correlation Matrix",
    "",
    ...renderCorrelationMatrix(profile.correlationMatrix),
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
