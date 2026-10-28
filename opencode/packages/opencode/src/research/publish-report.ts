import { createHash } from "crypto"
import type {
  JsonRecord,
  ResearchApproval,
  ResearchArtifact,
  ResearchCandidate,
  ResearchChampion,
  ResearchMemory,
  ResearchRun,
  ResearchTask,
} from "./schema"
import { compactPromptContext } from "./prompt-context"

export const PUBLISH_REPORT_SCHEMA_VERSION = "neo_research_publish_report_input.v1" as const
export const PUBLISH_REPORT_PROMPT_VERSION = "publish-report.v1"

export const PUBLISH_REPORT_SECTIONS = [
  "Executive summary",
  "Task background and objectives",
  "Data and split protocol",
  "Data analysis and modeling insights",
  "Model search method and trajectory",
  "Experimental setup and evaluation protocol",
  "Validation results and candidate comparison",
  "Final Ref Test results",
  "Failures, unsuccessful attempts, and lessons",
  "Rationale for final model selection",
  "Limitations and risks",
  "Reproduction steps",
  "Artifact and evidence index",
] as const

export interface PublishReportSnapshot {
  readonly schemaVersion: typeof PUBLISH_REPORT_SCHEMA_VERSION
  readonly generatedAt: string
  readonly task: ResearchTask
  readonly champion: ResearchChampion
  readonly championCandidate: ResearchCandidate
  readonly refTestRun: ResearchRun
  readonly refTestMetrics: Record<string, number>
  readonly candidates: ResearchCandidate[]
  readonly runs: ResearchRun[]
  readonly approvals: ResearchApproval[]
  readonly memories: ResearchMemory[]
  readonly evidence: Array<{
    artifactID: string
    kind: string
    uri: string
    runID?: string
    digest?: string
  }>
  readonly reproducibility: {
    datasetSpec: JsonRecord
    bestModelConfig?: JsonRecord
    commands: string[]
    codeVersion?: string
    seeds: number[]
    environment?: JsonRecord
  }
  readonly digest: string
}

const secretPattern = /(api[_-]?key|access[_-]?token|authorization|password|secret)/i
const privateEvidencePattern = /(raw|label|prediction|blind[_-]?test)/i

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function safeEvidence(artifact: ResearchArtifact): boolean {
  if (privateEvidencePattern.test(artifact.kind)) return false
  if (secretPattern.test(artifact.kind) || secretPattern.test(artifact.uri)) return false
  return artifact.uri.startsWith("file://")
}

function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redactSecrets) as T
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      secretPattern.test(key) ? "[REDACTED]" : redactSecrets(child),
    ]),
  ) as T
}

export function buildPublishReportSnapshot(input: {
  task: ResearchTask
  champion: ResearchChampion
  championCandidate: ResearchCandidate
  refTestRun: ResearchRun
  candidates: ResearchCandidate[]
  runs: ResearchRun[]
  approvals: ResearchApproval[]
  artifacts: ResearchArtifact[]
  memories: ResearchMemory[]
  generatedAt?: string
}): PublishReportSnapshot {
  const refTestMetrics = Object.fromEntries(
    Object.entries(input.refTestRun.metrics as Record<string, unknown>).filter(
      ([key, value]) => key.startsWith("ref_test_") && typeof value === "number" && Number.isFinite(value),
    ),
  ) as Record<string, number>
  const evidence = input.artifacts.filter(safeEvidence).map((artifact) => ({
    artifactID: artifact.id,
    kind: artifact.kind,
    uri: artifact.uri,
    ...(artifact.runID ? { runID: artifact.runID } : {}),
    ...(typeof artifact.metadata.digest === "string" ? { digest: artifact.metadata.digest } : {}),
  }))
  const championUsage = record(input.runs.find((run) => run.id === input.champion.runID)?.resourceUsage)
  const reproducibility = record(championUsage.reproducibility)
  const taskSpec = record(input.task.taskSpec)
  const digestPayload = JSON.stringify({
    taskID: input.task.id,
    championRunID: input.champion.runID,
    refTestRunID: input.refTestRun.id,
    evidence: evidence.map((item) => [item.artifactID, item.digest ?? item.uri]),
    promptVersion: PUBLISH_REPORT_PROMPT_VERSION,
  })
  const digest = createHash("sha256").update(digestPayload).digest("hex")
  return {
    schemaVersion: PUBLISH_REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    task: redactSecrets(input.task),
    champion: redactSecrets(input.champion),
    championCandidate: redactSecrets(input.championCandidate),
    refTestRun: redactSecrets(input.refTestRun),
    refTestMetrics,
    candidates: redactSecrets(input.candidates),
    runs: redactSecrets(input.runs),
    approvals: redactSecrets(input.approvals),
    memories: redactSecrets(input.memories),
    evidence,
    reproducibility: {
      datasetSpec: redactSecrets(record(taskSpec.dataset)),
      bestModelConfig: redactSecrets(record(input.championCandidate.candidateSpec)),
      commands: Array.isArray(reproducibility.commands)
        ? reproducibility.commands.filter((value): value is string => typeof value === "string")
        : [],
      ...(typeof reproducibility.codeVersion === "string" ? { codeVersion: reproducibility.codeVersion } : {}),
      seeds: input.runs
        .map((run) => record(run.resourceUsage).seed)
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value)),
      environment: redactSecrets(record(reproducibility.environment)),
    },
    digest,
  }
}

export function buildPublishReportPrompt(snapshot: PublishReportSnapshot): string {
  return [
    "You are writing PublishAgent's final report. Use only the controlled JSON snapshot below. Write in English.",
    "Do not invent metrics, commands, ablations, or failure causes; mark missing information as 'not provided/not executed'.",
    "Validation metrics guide search and model selection; ref_test is only for final generalization evaluation and must never be described as a basis for champion selection.",
    "Cite a run ID or artifact ID for key numbers. Output only Markdown content. Include the following level-two sections in order:",
    PUBLISH_REPORT_SECTIONS.map((section) => `## ${section}`).join("\n"),
    "\nControlled snapshot:",
    JSON.stringify(compactPromptContext(snapshot), null, 2),
  ].join("\n")
}

export function stripMarkdownFence(value: string): string {
  const trimmed = value.trim()
  const match = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i)
  return (match?.[1] ?? trimmed).trim()
}

export function validateFinalReport(report: string, snapshot: PublishReportSnapshot): string[] {
  const errors: string[] = []
  for (const section of PUBLISH_REPORT_SECTIONS) {
    if (!report.includes(`## ${section}`)) errors.push(`Missing section: ${section}`)
  }
  for (const id of [snapshot.task.id, snapshot.champion.candidateID, snapshot.champion.runID, snapshot.refTestRun.id]) {
    if (!report.includes(id)) errors.push(`Missing identifier: ${id}`)
  }
  for (const [name, value] of Object.entries(snapshot.refTestMetrics)) {
    if (!report.includes(name) || !report.includes(String(value))) errors.push(`Inconsistent or missing ref_test metric: ${name}`)
  }
  if (/ref[_ -]?test.{0,80}(select(?:ion|ing|s|ed)?|filter(?:ing|s|ed)?|search(?:ing|es|ed)?).{0,40}champion/i.test(report)) {
    errors.push("ref_test was incorrectly described as a basis for champion search or selection")
  }
  if (secretPattern.test(report)) errors.push("The report may contain a secret or sensitive credential")
  return errors
}

export function renderDeterministicFinalReport(snapshot: PublishReportSnapshot): string {
  const metricRows = Object.entries(snapshot.refTestMetrics).map(([key, value]) => `| ${key} | ${value} |`)
  const validationRuns = snapshot.runs.filter((run) => run.stage !== "ref_test" && run.status === "succeeded")
  const failedRuns = snapshot.runs.filter((run) => run.status === "failed" || run.status === "rejected")
  const commands = snapshot.reproducibility.commands.length
    ? snapshot.reproducibility.commands.map((command) => `- \`${command}\``)
    : ["- Not provided."]
  const evidence = snapshot.evidence.length
    ? snapshot.evidence.map((item) => `- \`${item.artifactID}\` — ${item.kind} (${item.uri})`)
    : ["- Not provided."]
  return [
    `# Final Research Report: ${snapshot.task.title}`,
    `## ${PUBLISH_REPORT_SECTIONS[0]}`,
    `Task \`${snapshot.task.id}\` uses final candidate \`${snapshot.champion.candidateID}\` (selection run: \`${snapshot.champion.runID}\`). The final reference test run is \`${snapshot.refTestRun.id}\`.`,
    `## ${PUBLISH_REPORT_SECTIONS[1]}`,
    `Objective: ${JSON.stringify(snapshot.task.objective)}.`,
    `## ${PUBLISH_REPORT_SECTIONS[2]}`,
    Object.keys(snapshot.reproducibility.datasetSpec).length ? `Dataset protocol: \`${JSON.stringify(snapshot.reproducibility.datasetSpec)}\`` : "Dataset and split details were not provided.",
    `## ${PUBLISH_REPORT_SECTIONS[3]}`,
    "Modeling insights follow recorded analysis evidence; unrecorded analyses are not inferred.",
    `## ${PUBLISH_REPORT_SECTIONS[4]}`,
    `Recorded ${snapshot.candidates.length} candidates and ${snapshot.runs.length} runs.`,
    `## ${PUBLISH_REPORT_SECTIONS[5]}`,
    "Validation metrics guide search and model selection; ref_test is only for final generalization evaluation after the champion is fixed.",
    `## ${PUBLISH_REPORT_SECTIONS[6]}`,
    validationRuns.length ? validationRuns.map((run) => `- \`${run.id}\` / \`${run.candidateID ?? "Not provided"}\`: ${JSON.stringify(run.metrics)}`).join("\n") : "No successful validation runs were provided.",
    `## ${PUBLISH_REPORT_SECTIONS[7]}`,
    `Ref Test run: \`${snapshot.refTestRun.id}\`.\n\n| metric | value |\n| --- | ---: |\n${metricRows.join("\n")}`,
    `## ${PUBLISH_REPORT_SECTIONS[8]}`,
    failedRuns.length ? failedRuns.map((run) => `- \`${run.id}\`: ${run.status}`).join("\n") : "No failed or rejected runs were recorded.",
    `## ${PUBLISH_REPORT_SECTIONS[9]}`,
    `Champion \`${snapshot.champion.candidateID}\` was fixed using validation results; ref_test did not influence selection.`,
    `## ${PUBLISH_REPORT_SECTIONS[10]}`,
    "This report covers only the snapshot's recorded runs, aggregate metrics, and evidence; per-sample ref_test data was not provided.",
    `## ${PUBLISH_REPORT_SECTIONS[11]}`,
    commands.join("\n"),
    `Random seeds: ${snapshot.reproducibility.seeds.length ? snapshot.reproducibility.seeds.join(", ") : "Not provided"}. Environment: ${Object.keys(snapshot.reproducibility.environment ?? {}).length ? JSON.stringify(snapshot.reproducibility.environment) : "Not provided"}.`,
    `## ${PUBLISH_REPORT_SECTIONS[12]}`,
    evidence.join("\n"),
  ].join("\n\n") + "\n"
}
