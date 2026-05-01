import type { JsonRecord, ResearchArtifact, ResearchArtifactID, ResearchTask } from "../schema"

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
