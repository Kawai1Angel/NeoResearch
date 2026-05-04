import type { AutonomousLoopResult } from "../service"
import type { JsonRecord, ResearchTaskID } from "../schema"

export interface NASIterationSummary {
  readonly iterationIndex: number
  readonly candidateID: string
  readonly recipeID: string | undefined
  readonly generatedBy: string
  readonly selectionSource: string
  readonly runStatus: string
  readonly primaryMetric: number | undefined
  readonly deltaVsChampion: number | undefined
  readonly deltaVsPrevious: number | undefined
  readonly hypothesis: string
  readonly mutationRationale: string
  readonly searchBiasesApplied: string[]
}

export interface NASAgentResult {
  readonly agent: "NASAgent"
  readonly taskID: ResearchTaskID
  readonly loop: AutonomousLoopResult
  readonly iterationCount: number
  readonly succeededCount: number
  readonly failedCount: number
  readonly iterationSummaries: NASIterationSummary[]
  readonly modelSearchPlanMarkdown: string
  readonly experimentLogMarkdown: string
  readonly leaderboardMarkdown: string
  readonly searchSpaceYaml: string
  readonly bestModelConfigYaml: string
  readonly bestModelPython: string
  readonly trainingScriptPython: string
  readonly evaluationResultMarkdown: string
  readonly reflectionNotesMarkdown: string
}

function extractString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function extractNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

export function buildNASAgentResult(input: {
  readonly taskID: ResearchTaskID
  readonly loop: AutonomousLoopResult
  readonly primaryMetricName?: string
  readonly direction?: "minimize" | "maximize"
  readonly taskFingerprint?: JsonRecord
}): NASAgentResult {
  const { loop, taskID } = input
  const primaryMetricName = input.primaryMetricName ?? "val_avg_mse"
  const direction = input.direction ?? "minimize"

  const searchBiasesApplied: string[] = (() => {
    if (!input.taskFingerprint) return []
    const biases = input.taskFingerprint.searchBiases
    if (!Array.isArray(biases)) return []
    return biases.filter((b): b is string => typeof b === "string")
  })()

  let bestSoFar: number | undefined = undefined
  let previousMetric: number | undefined = undefined

  const iterationSummaries: NASIterationSummary[] = loop.iterations.map((iteration, index) => {
    const candidateSpec = asRecord(iteration.candidate.candidateSpec)
    const selectionMeta = asRecord(iteration.selectionArtifact.metadata)

    const hypothesis =
      extractString(candidateSpec.hypothesis) ?? "Candidate hypothesis not recorded."
    const mutationRationale =
      extractString(candidateSpec.notes) ??
      `${iteration.candidate.generatedBy} candidate`
    const recipeID = extractString(candidateSpec.recipeID)
    const selectionSource = extractString(selectionMeta.selectionSource) ?? "unknown"

    const runMetrics = asRecord(iteration.run.metrics)
    const primaryMetric = extractNumber(runMetrics[primaryMetricName])

    // Compute deltas: positive = improvement
    let deltaVsChampion: number | undefined = undefined
    let deltaVsPrevious: number | undefined = undefined

    if (primaryMetric !== undefined) {
      if (bestSoFar !== undefined) {
        deltaVsChampion =
          direction === "minimize"
            ? bestSoFar - primaryMetric
            : primaryMetric - bestSoFar
      } else {
        // First iteration with a metric — it is the baseline
        deltaVsChampion = undefined
      }

      if (previousMetric !== undefined) {
        deltaVsPrevious =
          direction === "minimize"
            ? previousMetric - primaryMetric
            : primaryMetric - previousMetric
      }

      // Update bestSoFar after computing delta
      if (
        bestSoFar === undefined ||
        (direction === "minimize" ? primaryMetric < bestSoFar : primaryMetric > bestSoFar)
      ) {
        bestSoFar = primaryMetric
      }
      previousMetric = primaryMetric
    }

    return {
      iterationIndex: index + 1,
      candidateID: iteration.candidate.id,
      recipeID,
      generatedBy: iteration.candidate.generatedBy,
      selectionSource,
      runStatus: iteration.run.status,
      primaryMetric,
      deltaVsChampion,
      deltaVsPrevious,
      hypothesis,
      mutationRationale,
      searchBiasesApplied,
    }
  })

  const iterationCount = loop.iterations.length
  const succeededCount = loop.iterations.filter((it) => it.run.status === "succeeded").length
  const failedCount = loop.iterations.filter((it) => it.run.status === "failed").length

  const experimentLogMarkdown = buildExperimentLogMarkdown({
    taskID,
    iterationCount,
    succeededCount,
    failedCount,
    searchBiasesApplied,
    summaries: iterationSummaries,
    primaryMetricName,
  })
  const best = bestIteration(iterationSummaries, direction)
  const modelSearchPlanMarkdown = buildModelSearchPlanMarkdown({
    taskID,
    primaryMetricName,
    direction,
    searchBiasesApplied,
    summaries: iterationSummaries,
  })
  const leaderboardMarkdown = buildLeaderboardMarkdown({ summaries: iterationSummaries, primaryMetricName, direction })
  const searchSpaceYaml = buildSearchSpaceYaml({
    taskID,
    primaryMetricName,
    direction,
    searchBiasesApplied,
    fingerprint: input.taskFingerprint,
  })
  const bestModelConfigYaml = buildBestModelConfigYaml({ taskID, primaryMetricName, direction, best })
  const bestModelPython = buildBestModelPython({ taskID, best })
  const trainingScriptPython = buildTrainingScriptPython({ taskID, primaryMetricName })
  const evaluationResultMarkdown = buildEvaluationResultMarkdown({ taskID, primaryMetricName, direction, best, summaries: iterationSummaries })
  const reflectionNotesMarkdown = buildReflectionNotesMarkdown({ taskID, best, summaries: iterationSummaries, failedCount })

  return {
    agent: "NASAgent",
    taskID,
    loop,
    iterationCount,
    succeededCount,
    failedCount,
    iterationSummaries,
    modelSearchPlanMarkdown,
    experimentLogMarkdown,
    leaderboardMarkdown,
    searchSpaceYaml,
    bestModelConfigYaml,
    bestModelPython,
    trainingScriptPython,
    evaluationResultMarkdown,
    reflectionNotesMarkdown,
  }
}

function fmtMetric(value: number | undefined): string {
  if (value === undefined) return "-"
  return Number(value.toPrecision(6)).toString()
}

function fmtDelta(value: number | undefined, isFirst: boolean): string {
  if (isFirst) return "+baseline"
  if (value === undefined) return "-"
  const sign = value >= 0 ? "+" : ""
  return `${sign}${Number(value.toPrecision(4))}`
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen - 3)}...`
}

function buildExperimentLogMarkdown(input: {
  taskID: ResearchTaskID
  iterationCount: number
  succeededCount: number
  failedCount: number
  searchBiasesApplied: string[]
  summaries: NASIterationSummary[]
  primaryMetricName: string
}): string {
  const {
    taskID,
    iterationCount,
    succeededCount,
    failedCount,
    searchBiasesApplied,
    summaries,
    primaryMetricName,
  } = input

  const biasLine =
    searchBiasesApplied.length > 0 ? searchBiasesApplied.join(", ") : "none"

  const tableHeader = [
    `| # | Recipe | Generated By | Status | ${primaryMetricName} | Δ vs Champion | Δ vs Prev | Hypothesis |`,
    `|---|--------|-------------|--------|${"-".repeat(primaryMetricName.length + 2)}|--------------|-----------|------------|`,
  ]

  const tableRows = summaries.map((s) => {
    const recipe = s.recipeID ?? s.candidateID.slice(0, 20)
    const hyp = truncate(s.hypothesis, 60)
    const isFirst = s.iterationIndex === 1
    return `| ${s.iterationIndex} | ${recipe} | ${s.generatedBy} | ${s.runStatus} | ${fmtMetric(s.primaryMetric)} | ${fmtDelta(s.deltaVsChampion, isFirst)} | ${fmtDelta(s.deltaVsPrevious, false)} | ${hyp} |`
  })

  const hypothesisBlocks = summaries
    .map((s) => {
      const label = s.recipeID ?? s.candidateID
      return [
        `### Iteration ${s.iterationIndex}: ${label}`,
        `**Hypothesis:** ${s.hypothesis}`,
        `**Mutation Rationale:** ${s.mutationRationale}`,
      ].join("\n")
    })
    .join("\n\n")

  return [
    "# Experiment Log",
    "",
    `Task: ${taskID}`,
    `Total iterations: ${iterationCount} | Succeeded: ${succeededCount} | Failed: ${failedCount}`,
    `Search biases: ${biasLine}`,
    "",
    "## Iteration Summary",
    "",
    ...tableHeader,
    ...tableRows,
    "",
    "## Hypotheses",
    "",
    hypothesisBlocks,
  ].join("\n")
}

function bestIteration(summaries: NASIterationSummary[], direction: "minimize" | "maximize") {
  const completed = summaries.filter((item) => item.primaryMetric !== undefined && item.runStatus === "succeeded")
  return completed.sort((a, b) =>
    direction === "minimize" ? a.primaryMetric! - b.primaryMetric! : b.primaryMetric! - a.primaryMetric!,
  )[0]
}

function yamlString(value: string | undefined) {
  if (!value) return "null"
  return JSON.stringify(value)
}

function buildModelSearchPlanMarkdown(input: {
  taskID: ResearchTaskID
  primaryMetricName: string
  direction: "minimize" | "maximize"
  searchBiasesApplied: string[]
  summaries: NASIterationSummary[]
}) {
  return [
    "# Model Search Plan",
    "",
    `- Task ID: ${input.taskID}`,
    `- Objective: ${input.direction} ${input.primaryMetricName}`,
    `- Search biases: ${input.searchBiasesApplied.length ? input.searchBiasesApplied.join(", ") : "none"}`,
    "",
    "## Strategy",
    "",
    "- Start from lightweight approved candidates.",
    "- Compare each run against the current champion and previous run.",
    "- Preserve every hypothesis and mutation rationale in the experiment log.",
    "",
    "## Planned / Executed Candidates",
    "",
    ...(input.summaries.length
      ? input.summaries.map((item) => `- ${item.recipeID ?? item.candidateID}: ${item.hypothesis}`)
      : ["- No search iterations have run yet."]),
    "",
  ].join("\n")
}

function buildLeaderboardMarkdown(input: {
  summaries: NASIterationSummary[]
  primaryMetricName: string
  direction: "minimize" | "maximize"
}) {
  const ranked = [...input.summaries]
    .filter((item) => item.primaryMetric !== undefined)
    .sort((a, b) =>
      input.direction === "minimize" ? a.primaryMetric! - b.primaryMetric! : b.primaryMetric! - a.primaryMetric!,
    )
  return [
    "# Leaderboard",
    "",
    `Objective: ${input.direction} ${input.primaryMetricName}`,
    "",
    `| Rank | Candidate | Recipe | Status | ${input.primaryMetricName} | Delta vs Champion |`,
    `| ---: | --- | --- | --- | ---: | ---: |`,
    ...(ranked.length
      ? ranked.map(
          (item, index) =>
            `| ${index + 1} | ${item.candidateID} | ${item.recipeID ?? "-"} | ${item.runStatus} | ${fmtMetric(item.primaryMetric)} | ${fmtDelta(item.deltaVsChampion, item.iterationIndex === 1)} |`,
        )
      : ["| - | - | - | - | - | - |"]),
    "",
  ].join("\n")
}

function buildSearchSpaceYaml(input: {
  taskID: ResearchTaskID
  primaryMetricName: string
  direction: "minimize" | "maximize"
  searchBiasesApplied: string[]
  fingerprint?: JsonRecord
}) {
  const fp = input.fingerprint ?? {}
  return [
    "schema_version: neo_research_search_space.v1",
    `task_id: ${yamlString(input.taskID)}`,
    "objective:",
    `  metric: ${yamlString(input.primaryMetricName)}`,
    `  direction: ${yamlString(input.direction)}`,
    "fingerprint:",
    `  context_length: ${fp.contextLength ?? "null"}`,
    `  max_prediction_length: ${fp.maxPredictionLength ?? "null"}`,
    "search_biases:",
    ...(input.searchBiasesApplied.length ? input.searchBiasesApplied.map((item) => `  - ${yamlString(item)}`) : ["  []"]),
    "candidate_families:",
    "  - linear",
    "  - patch",
    "  - frequency",
    "  - mixer",
    "",
  ].join("\n")
}

function buildBestModelConfigYaml(input: {
  taskID: ResearchTaskID
  primaryMetricName: string
  direction: "minimize" | "maximize"
  best: NASIterationSummary | undefined
}) {
  return [
    "schema_version: neo_research_best_model_config.v1",
    `task_id: ${yamlString(input.taskID)}`,
    `candidate_id: ${yamlString(input.best?.candidateID)}`,
    `recipe_id: ${yamlString(input.best?.recipeID)}`,
    `primary_metric_name: ${yamlString(input.primaryMetricName)}`,
    `primary_metric_value: ${input.best?.primaryMetric ?? "null"}`,
    `direction: ${yamlString(input.direction)}`,
    `selection_reason: ${yamlString(input.best ? "best observed primary metric among succeeded NAS iterations" : "no succeeded NAS iteration")}`,
    "",
  ].join("\n")
}

function buildBestModelPython(input: { taskID: ResearchTaskID; best: NASIterationSummary | undefined }) {
  return [
    '"""NeoResearch best-model placeholder exported from the NAS trace."""',
    "",
    "class BestModel:",
    "    def __init__(self):",
    `        self.task_id = ${JSON.stringify(input.taskID)}`,
    `        self.candidate_id = ${JSON.stringify(input.best?.candidateID ?? null)}`,
    `        self.recipe_id = ${JSON.stringify(input.best?.recipeID ?? null)}`,
    "",
    "    def predict(self, rows):",
    "        return rows",
    "",
  ].join("\n")
}

function buildTrainingScriptPython(input: { taskID: ResearchTaskID; primaryMetricName: string }) {
  return [
    '"""Reproducible training entrypoint stub for the selected NeoResearch model."""',
    "",
    "def train(config=None):",
    "    config = config or {}",
    "    return {",
    `        "task_id": ${JSON.stringify(input.taskID)},`,
    `        "primary_metric": ${JSON.stringify(input.primaryMetricName)},`,
    '        "status": "ready_for_runner_integration",',
    "        \"config\": config,",
    "    }",
    "",
    "",
    'if __name__ == "__main__":',
    "    print(train())",
    "",
  ].join("\n")
}

function buildEvaluationResultMarkdown(input: {
  taskID: ResearchTaskID
  primaryMetricName: string
  direction: "minimize" | "maximize"
  best: NASIterationSummary | undefined
  summaries: NASIterationSummary[]
}) {
  return [
    "# Evaluation Result",
    "",
    `- Task ID: ${input.taskID}`,
    `- Objective: ${input.direction} ${input.primaryMetricName}`,
    `- Evaluated iterations: ${input.summaries.length}`,
    `- Selected candidate: ${input.best?.candidateID ?? "none"}`,
    `- Selected metric: ${fmtMetric(input.best?.primaryMetric)}`,
    "",
  ].join("\n")
}

function buildReflectionNotesMarkdown(input: {
  taskID: ResearchTaskID
  best: NASIterationSummary | undefined
  summaries: NASIterationSummary[]
  failedCount: number
}) {
  return [
    "# Reflection Notes",
    "",
    `- Task ID: ${input.taskID}`,
    `- Best candidate: ${input.best?.candidateID ?? "none"}`,
    `- Failed runs: ${input.failedCount}`,
    `- Effective change: ${input.best?.mutationRationale ?? "No succeeded mutation recorded."}`,
    `- Next hypothesis: ${input.best?.hypothesis ?? "Collect at least one successful run before continuing."}`,
    "",
  ].join("\n")
}

export function summarizeNASAgentLoop(input: {
  readonly taskID: ResearchTaskID
  readonly loop: AutonomousLoopResult
}): NASAgentResult {
  return buildNASAgentResult(input)
}
