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

export const PUBLISH_REPORT_SCHEMA_VERSION = "neo_research_publish_report_input.v1" as const
export const PUBLISH_REPORT_PROMPT_VERSION = "publish-report.v1"

export const PUBLISH_REPORT_SECTIONS = [
  "执行摘要",
  "任务背景与目标",
  "数据与切分协议",
  "数据分析与建模启示",
  "模型搜索方法与搜索轨迹",
  "实验设置与评价协议",
  "验证集结果与候选比较",
  "最终 Ref Test 结果",
  "失败案例、无效尝试与经验",
  "最终模型选择理由",
  "局限性与风险",
  "复现步骤",
  "产物与证据索引",
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
    "你是 PublishAgent 的最终报告撰写阶段。只能依据下面的受控 JSON 快照写作。",
    "不得虚构指标、命令、消融或失败原因；缺失信息明确写‘未提供/未执行’。",
    "val 指标用于搜索和模型选择；ref_test 只用于最终泛化评估，绝不能描述为选择 champion 的依据。",
    "关键数字注明 run ID 或 artifact ID。只输出 Markdown 正文。必须按顺序包含以下二级章节：",
    PUBLISH_REPORT_SECTIONS.map((section) => `## ${section}`).join("\n"),
    "\n受控快照：",
    JSON.stringify(snapshot, null, 2),
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
    if (!report.includes(`## ${section}`)) errors.push(`缺少章节：${section}`)
  }
  for (const id of [snapshot.task.id, snapshot.champion.candidateID, snapshot.champion.runID, snapshot.refTestRun.id]) {
    if (!report.includes(id)) errors.push(`缺少标识：${id}`)
  }
  for (const [name, value] of Object.entries(snapshot.refTestMetrics)) {
    if (!report.includes(name) || !report.includes(String(value))) errors.push(`ref_test 指标不一致或缺失：${name}`)
  }
  if (/ref[_ -]?test.{0,80}(选择|筛选|搜索).{0,40}champion/i.test(report)) {
    errors.push("错误地将 ref_test 描述为 champion 搜索或选择依据")
  }
  if (secretPattern.test(report)) errors.push("报告疑似包含密钥或敏感凭据")
  return errors
}

export function renderDeterministicFinalReport(snapshot: PublishReportSnapshot): string {
  const metricRows = Object.entries(snapshot.refTestMetrics).map(([key, value]) => `| ${key} | ${value} |`)
  const validationRuns = snapshot.runs.filter((run) => run.stage !== "ref_test" && run.status === "succeeded")
  const failedRuns = snapshot.runs.filter((run) => run.status === "failed" || run.status === "rejected")
  const commands = snapshot.reproducibility.commands.length
    ? snapshot.reproducibility.commands.map((command) => `- \`${command}\``)
    : ["- 未提供。"]
  const evidence = snapshot.evidence.length
    ? snapshot.evidence.map((item) => `- \`${item.artifactID}\` — ${item.kind} (${item.uri})`)
    : ["- 未提供。"]
  return [
    `# Final Research Report: ${snapshot.task.title}`,
    `## ${PUBLISH_REPORT_SECTIONS[0]}`,
    `任务 \`${snapshot.task.id}\` 的最终模型为候选 \`${snapshot.champion.candidateID}\`（选择 run：\`${snapshot.champion.runID}\`）。最终参考测试 run 为 \`${snapshot.refTestRun.id}\`。`,
    `## ${PUBLISH_REPORT_SECTIONS[1]}`,
    `目标：${JSON.stringify(snapshot.task.objective)}。`,
    `## ${PUBLISH_REPORT_SECTIONS[2]}`,
    Object.keys(snapshot.reproducibility.datasetSpec).length ? `数据协议：\`${JSON.stringify(snapshot.reproducibility.datasetSpec)}\`` : "数据与切分细节未提供。",
    `## ${PUBLISH_REPORT_SECTIONS[3]}`,
    "建模启示以已登记的分析证据为准；未登记的分析不作推断。",
    `## ${PUBLISH_REPORT_SECTIONS[4]}`,
    `共记录 ${snapshot.candidates.length} 个候选和 ${snapshot.runs.length} 次运行。`,
    `## ${PUBLISH_REPORT_SECTIONS[5]}`,
    "验证集指标用于搜索与模型选择；ref_test 仅用于 champion 固化后的最终泛化评估。",
    `## ${PUBLISH_REPORT_SECTIONS[6]}`,
    validationRuns.length ? validationRuns.map((run) => `- \`${run.id}\` / \`${run.candidateID ?? "未提供"}\`: ${JSON.stringify(run.metrics)}`).join("\n") : "未提供成功的验证运行。",
    `## ${PUBLISH_REPORT_SECTIONS[7]}`,
    `Ref Test run：\`${snapshot.refTestRun.id}\`。\n\n| metric | value |\n| --- | ---: |\n${metricRows.join("\n")}`,
    `## ${PUBLISH_REPORT_SECTIONS[8]}`,
    failedRuns.length ? failedRuns.map((run) => `- \`${run.id}\`: ${run.status}`).join("\n") : "未记录失败或拒绝的运行。",
    `## ${PUBLISH_REPORT_SECTIONS[9]}`,
    `Champion \`${snapshot.champion.candidateID}\` 依据验证阶段结果固化；ref_test 未参与选择。`,
    `## ${PUBLISH_REPORT_SECTIONS[10]}`,
    "报告仅覆盖快照中已登记的运行、汇总指标和证据；未提供逐样本 ref_test 数据。",
    `## ${PUBLISH_REPORT_SECTIONS[11]}`,
    commands.join("\n"),
    `随机种子：${snapshot.reproducibility.seeds.length ? snapshot.reproducibility.seeds.join(", ") : "未提供"}。环境：${Object.keys(snapshot.reproducibility.environment ?? {}).length ? JSON.stringify(snapshot.reproducibility.environment) : "未提供"}。`,
    `## ${PUBLISH_REPORT_SECTIONS[12]}`,
    evidence.join("\n"),
  ].join("\n\n") + "\n"
}
