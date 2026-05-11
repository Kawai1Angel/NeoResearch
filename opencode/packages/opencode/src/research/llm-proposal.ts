import { readFile } from "fs/promises"
import { createHash } from "crypto"
import os from "os"
import path from "path"
import type { DomainCandidateProposal, DomainProposalContext } from "./domain"
import type { JsonRecord, ResearchTask } from "./schema"

type LLMProvider = "anthropic" | "openai-compatible"

export type NeoCastLLMConfig = {
  readonly provider: LLMProvider
  readonly model: string
  readonly baseURL?: string
  readonly maxTokens: number
  readonly temperature: number
}

export type LLMProposalResult = {
  readonly proposal?: DomainCandidateProposal
  readonly metadata: JsonRecord
}

const DEFAULT_CONFIG: NeoCastLLMConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  maxTokens: 4000,
  temperature: 0.2,
}

const keyMap: Record<string, string> = {
  recipe_version: "recipeVersion",
  recipe_id: "recipeID",
  d_model: "dModel",
  patch_len: "patchLen",
  n_freq: "nFreq",
  complex_mode: "complexMode",
  embed_dim: "embedDim",
  hidden_dim: "hiddenDim",
  n_heads: "nHeads",
  n_layers: "nLayers",
  ffn_mult: "ffnMult",
  num_layers: "numLayers",
  kernel_size: "kernelSize",
  state_dim: "stateDim",
  temporal_mixing: "temporalMixing",
  channel_mixing: "channelMixing",
  n_blocks: "nBlocks",
  top_k: "topK",
  channel_mode: "channelMode",
  variate_token: "variateToken",
  cross_attention: "crossAttention",
  adjacency_source: "adjacencySource",
  gate_type: "gateType",
  prediction_head: "predictionHead",
  output_distribution: "outputDistribution",
  horizon_specific: "horizonSpecific",
  variance_floor: "varianceFloor",
  base_head: "baseHead",
  correction_dim: "correctionDim",
  training_strategy: "trainingStrategy",
  horizon_weighting: "horizonWeighting",
  weight_decay: "weightDecay",
  warmup_steps: "warmupSteps",
  grad_clip: "gradClip",
  max_epochs: "maxEpochs",
  time_budget_s: "timeBudgetS",
  batch_size: "batchSize",
  supervised_weight: "supervisedWeight",
  teacher_weight: "teacherWeight",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isRecord(base) || !isRecord(override)) return (override === undefined ? base : override) as T
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    const current = result[key]
    result[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value
  }
  return result as T
}

async function readJsonConfig(file: string | undefined) {
  if (!file) return {}
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch {
    return {}
  }
}

function configFromEnv(env: NodeJS.ProcessEnv) {
  const llm: Record<string, unknown> = {}
  if (env.NEO_CAST_LLM_PROVIDER) llm.provider = env.NEO_CAST_LLM_PROVIDER
  if (env.NEO_CAST_LLM_MODEL) llm.model = env.NEO_CAST_LLM_MODEL
  if (env.NEO_CAST_LLM_BASE_URL) llm.base_url = env.NEO_CAST_LLM_BASE_URL
  if (env.ANTHROPIC_BASE_URL) llm.base_url = env.ANTHROPIC_BASE_URL
  if (env.OPENAI_BASE_URL) llm.base_url = env.OPENAI_BASE_URL
  if (env.NEO_CAST_LLM_MAX_TOKENS) llm.max_tokens = Number(env.NEO_CAST_LLM_MAX_TOKENS)
  if (env.NEO_CAST_LLM_TEMPERATURE) llm.temperature = Number(env.NEO_CAST_LLM_TEMPERATURE)
  return Object.keys(llm).length === 0 ? {} : { llm }
}

function normalizeConfig(raw: unknown): NeoCastLLMConfig {
  const llm = isRecord(raw) && isRecord(raw.llm) ? raw.llm : {}
  const provider = llm.provider === "openai-compatible" ? "openai-compatible" : "anthropic"
  return {
    provider,
    model: typeof llm.model === "string" && llm.model.trim() ? llm.model : DEFAULT_CONFIG.model,
    ...(typeof llm.base_url === "string" && llm.base_url.trim() ? { baseURL: llm.base_url } : {}),
    maxTokens:
      typeof llm.max_tokens === "number" && Number.isFinite(llm.max_tokens) && llm.max_tokens > 0
        ? llm.max_tokens
        : DEFAULT_CONFIG.maxTokens,
    temperature:
      typeof llm.temperature === "number" && Number.isFinite(llm.temperature)
        ? Math.max(0, Math.min(1, llm.temperature))
        : DEFAULT_CONFIG.temperature,
  }
}

export async function resolveNeoCastLLMConfig(input: { readonly workspaceRoot: string; readonly neoCastProjectRoot?: string }) {
  const userConfig = path.join(os.homedir(), ".config", "neo-cast", "config.json")
  const workspaceConfig = path.join(input.workspaceRoot, ".neo-cast", "config.json")
  const runnerConfig =
    input.neoCastProjectRoot === undefined ? undefined : path.join(input.neoCastProjectRoot, ".neo-cast", "config.json")
  const merged = deepMerge(
    deepMerge(
      deepMerge(
        deepMerge({ llm: { ...DEFAULT_CONFIG, base_url: undefined } }, configFromEnv(process.env)),
        await readJsonConfig(userConfig),
      ),
      await readJsonConfig(workspaceConfig),
    ),
    await readJsonConfig(runnerConfig),
  )
  return normalizeConfig(merged)
}

export function apiKeyFor(config: NeoCastLLMConfig) {
  if (config.provider === "anthropic") return process.env.ANTHROPIC_API_KEY
  return process.env.NEO_CAST_LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.AIGCBEST_API_KEY
}

export function extractJsonObject(text: string) {
  const stripped = text.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim()
  const start = stripped.indexOf("{")
  const end = stripped.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`No JSON object found in LLM response. Got: ${text.slice(0, 200)}`)
  }
  return JSON.parse(stripped.slice(start, end + 1))
}

function camelizeKnown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeKnown)
  if (!isRecord(value)) return value
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    result[keyMap[key] ?? key] = camelizeKnown(item)
  }
  return result
}

function pruneCandidateSpec(value: unknown): JsonRecord {
  const spec = isRecord(value) ? { ...value } : {}
  delete spec.constraints
  delete spec.postProcessing

  const preprocessing = spec.preprocessing
  if (isRecord(preprocessing) && Array.isArray(preprocessing.actions)) {
    preprocessing.actions = preprocessing.actions.map((action) => {
      if (!isRecord(action)) return action
      const next = { ...action }
      if (next.type === "series_decomposition") delete next.method
      return next
    })
  }

  const predictionHead = spec.predictionHead
  if (isRecord(predictionHead) && predictionHead.type === "linear") {
    delete predictionHead.shareAcrossHorizons
  }

  const fusion = spec.fusion
  if (isRecord(fusion) && fusion.type === "gated_hybrid") {
    delete fusion.residual
  }

  const backbone = spec.backbone
  if (isRecord(backbone) && backbone.type === "ssm") {
    delete backbone.kernelSize
  }

  return spec as JsonRecord
}

const EXAMPLE_CANDIDATE = {
  recipe_version: "recipe_schema_v1",
  recipe_id: "recipe_dlinear_decomp_example",
  hypothesis: "DLinear 通过趋势-残差分解直接预测，参数量少，适合具有明显趋势的序列。",
  preprocessing: { actions: [{ type: "series_decomposition", kernel_size: 25 }] },
  embedding: { type: "none" },
  backbone: { type: "dlinear", individual: false },
  fusion: { type: "temporal", channel_mode: "independent" },
  prediction_head: { type: "linear", output_distribution: "point", share_across_horizons: false },
  post_processing: { type: "auto" },
  training_strategy: {
    loss: { base: "mse", horizon_weighting: "uniform" },
    optimizer: { type: "adam", lr: 0.001, weight_decay: 0.0 },
    scheduler: { type: "none", warmup_steps: 0 },
    regularization: { dropout: 0.0, grad_clip: 1.0 },
    budget: { max_epochs: 5, time_budget_s: 600, batch_size: 32, patience: 3, seed: 42 },
  },
  constraints: { max_params: 500000, max_latency_ms: 30 },
  notes: "轻量基线，用于趋势主导场景。",
}

function buildSystemPrompt() {
  return [
    "You are the NeoResearch TSF model-design planner.",
    "Language policy: 尽量用中文表达 hypothesis、rationale、notes 等自然语言内容；保留 JSON 字段名、schema 名称、模块名、指标名、命令和文件路径的英文原文。",
    "Return exactly one JSON object using Neo-Cast recipe_schema_v1 snake_case field names.",
    "Each field must have a single concrete value — NOT a list of alternatives.",
    "Do not return markdown fences or any prose outside JSON.",
    "Available module options (choose one value per field):",
    "  preprocessing.actions[].type: none | instance_norm | series_decomposition | seasonal_differencing | missing_mask | sample_reweighting",
    "  embedding.type: none | patch | multiscale_patch | invert | frequency | calendar",
    "  backbone.type: linear | mlp | transformer | dlinear | tcn | nbeats | timesnet | rnn | ssm | mixer",
    "  fusion.type: temporal | feature | temporal_then_feature | feature_then_temporal | graph | gated_hybrid",
    "  prediction_head.type: linear | direct_multi_horizon | quantile | gaussian | residual_correction",
    "Treat profileDerivedSearchDirectives as high-priority search priors unless they conflict with runtime constraints.",
    "Include training_strategy with loss, optimizer, scheduler, regularization, and budget sub-objects.",
    `\nEXAMPLE (follow this exact structure):\n${JSON.stringify(EXAMPLE_CANDIDATE, null, 2)}`,
  ].join("\n")
}

function numberFromRecord(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : []
}

function profileRecord(taskFingerprint: unknown) {
  if (!isRecord(taskFingerprint)) return {}
  return isRecord(taskFingerprint.datasetProfile) ? taskFingerprint.datasetProfile : {}
}

function profileDerivedSearchDirectives(taskFingerprint: unknown) {
  const fingerprint = isRecord(taskFingerprint) ? taskFingerprint : {}
  const profile = profileRecord(fingerprint)
  const biases = new Set(stringList(fingerprint.searchBiases))
  const directives: string[] = []

  if ((numberFromRecord(profile, "seasonalityStrength") ?? 0) >= 0.4 || biases.has("seasonal")) {
    const period = numberFromRecord(profile, "acfMainPeriod")
    directives.push(
      [
        "seasonal: prefer frequency embedding, series_decomposition, seasonal_differencing, or dlinear/timesnet-style seasonal structure.",
        period === undefined ? undefined : `acfMainPeriod=${period} can guide decomposition kernel, seasonal period, or n_freq.`,
      ]
        .filter((item): item is string => Boolean(item))
        .join(" "),
    )
  }
  if ((numberFromRecord(profile, "crossVarCorrelation") ?? 0) >= 0.5 || biases.has("cross_var_correlated")) {
    directives.push("cross_var_correlated: prefer invert/calendar embeddings with feature, gated_hybrid, or graph fusion.")
  }
  if ((numberFromRecord(profile, "missingRate") ?? 0) > 0 || biases.has("missing_values")) {
    directives.push("missing_values: include missing_mask preprocessing and avoid recipes that assume dense targets.")
  }
  if ((numberFromRecord(profile, "distributionShift") ?? 0) >= 0.5 || biases.has("distribution_shift")) {
    directives.push("distribution_shift: include sample_reweighting or instance_norm and use robust huber loss.")
  }
  if ((numberFromRecord(profile, "trendStrength") ?? 0) >= 0.2 || biases.has("trend")) {
    directives.push("trend: preserve long lookback context and consider residual_correction or decomposition-aware heads.")
  }
  if (biases.has("probabilistic")) {
    directives.push("probabilistic: prefer quantile or gaussian prediction_head with matching loss.")
  }

  return directives
}

function pushUniqueBy<T>(items: T[], item: T | undefined, key: (item: T) => string) {
  if (item === undefined) return
  const itemKey = key(item)
  if (items.some((existing) => key(existing) === itemKey)) return
  items.push(item)
}

function metricSortValue(run: DomainProposalContext["runs"][number]) {
  const value = run.metrics.val_avg_mse
  return typeof value === "number" && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
}

function representativeCandidates(context: DomainProposalContext) {
  const selected: DomainProposalContext["candidates"][number][] = []
  const byID = new Map(context.candidates.map((candidate) => [candidate.id, candidate]))
  pushUniqueBy(selected, context.champion === undefined ? undefined : byID.get(context.champion.candidateID), (item) => item.id)
  for (const run of [...context.runs].filter((item) => item.status === "succeeded").sort((a, b) => metricSortValue(a) - metricSortValue(b)).slice(0, 3)) {
    pushUniqueBy(selected, byID.get(run.candidateID), (item) => item.id)
  }
  pushUniqueBy(selected, context.candidates.find((item) => item.approvalStatus === "rejected"), (item) => item.id)
  pushUniqueBy(selected, byID.get(context.runs.find((item) => item.status === "failed")?.candidateID ?? ""), (item) => item.id)
  for (const candidate of context.candidates.slice(-5)) pushUniqueBy(selected, candidate, (item) => item.id)
  return selected.slice(0, 10)
}

function representativeRuns(context: DomainProposalContext) {
  const selected: DomainProposalContext["runs"][number][] = []
  const key = (run: DomainProposalContext["runs"][number]) => `${run.candidateID}:${run.stage}:${run.status}:${JSON.stringify(run.metrics)}`
  for (const run of context.runs.filter((item) => item.candidateID === context.champion?.candidateID)) {
    pushUniqueBy(selected, run, key)
  }
  pushUniqueBy(selected, context.runs.find((item) => item.status === "failed"), key)
  for (const run of [...context.runs].filter((item) => item.status === "succeeded").sort((a, b) => metricSortValue(a) - metricSortValue(b)).slice(0, 4)) {
    pushUniqueBy(selected, run, key)
  }
  for (const run of context.runs.slice(-6)) pushUniqueBy(selected, run, key)
  return selected.slice(0, 12)
}

function memoryWeight(item: DomainProposalContext["memory"][number], now: number) {
  if (typeof item.time !== "number" || !Number.isFinite(item.time)) return 1
  const ageMinutes = Math.max(0, (now - item.time) / 60_000)
  return 1 / (1 + ageMinutes / 60)
}

function memoryPromptRecord(item: DomainProposalContext["memory"][number], now: number) {
  return {
    ...item,
    memoryWeight: Number(memoryWeight(item, now).toFixed(4)),
  }
}

function representativeMemory(context: DomainProposalContext) {
  const selected: DomainProposalContext["memory"][number][] = []
  const key = (item: DomainProposalContext["memory"][number]) => `${item.outcome}:${item.lesson}`
  const now = Date.now()
  const byWeight = (left: DomainProposalContext["memory"][number], right: DomainProposalContext["memory"][number]) =>
    memoryWeight(right, now) - memoryWeight(left, now)
  for (const outcome of ["accepted", "rejected", "failed"]) {
    for (const item of context.memory.filter((memory) => memory.outcome === outcome).sort(byWeight).slice(0, 3)) {
      pushUniqueBy(selected, item, key)
    }
  }
  for (const item of [...context.memory].sort(byWeight).slice(0, 4)) pushUniqueBy(selected, item, key)
  return selected.slice(0, 12).map((item) => memoryPromptRecord(item, now))
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (!isRecord(value)) return JSON.stringify(value)
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`
}

function candidateSignatureFromMemory(item: DomainProposalContext["memory"][number]) {
  const summary = isRecord(item.candidateSummary) ? item.candidateSummary : {}
  const candidateSpec = isRecord(summary.candidateSpec) ? summary.candidateSpec : undefined
  const recipeID =
    typeof summary.recipeID === "string"
      ? summary.recipeID
      : candidateSpec && typeof candidateSpec.recipeID === "string"
        ? candidateSpec.recipeID
        : undefined
  const signatureSource = candidateSpec ?? (recipeID === undefined ? undefined : { recipeID })
  if (signatureSource === undefined) return undefined
  const hash = createHash("sha256").update(stableJson(signatureSource)).digest("hex").slice(0, 12)
  return `${recipeID ?? "candidate"}#${hash}`
}

function forbiddenCandidateSignatures(context: DomainProposalContext) {
  const signatures = context.memory
    .filter((item) => item.outcome === "failed" || item.outcome === "rejected")
    .map(candidateSignatureFromMemory)
    .filter((item): item is string => item !== undefined)
  return [...new Set(signatures)].slice(0, 24)
}

function buildUserPrompt(input: {
  readonly task: ResearchTask
  readonly proposalContext: DomainProposalContext
}) {
  const profile = profileRecord(input.proposalContext.taskFingerprint)
  const searchBiases = isRecord(input.proposalContext.taskFingerprint)
    ? stringList(input.proposalContext.taskFingerprint.searchBiases)
    : []
  return JSON.stringify(
    {
      task: {
        id: input.task.id,
        title: input.task.title,
        domainID: input.task.domainID,
        objective: input.task.objective,
        budget: input.task.budget,
        taskSpec: input.task.taskSpec,
      },
      taskFingerprint: input.proposalContext.taskFingerprint,
      datasetProfileSummary: profile,
      searchBiases,
      profileDerivedSearchDirectives: profileDerivedSearchDirectives(input.proposalContext.taskFingerprint),
      existingCandidates: representativeCandidates(input.proposalContext),
      runs: representativeRuns(input.proposalContext),
      memory: representativeMemory(input.proposalContext),
      forbidden_signatures: forbiddenCandidateSignatures(input.proposalContext),
      champion: input.proposalContext.champion,
      instruction:
        "Propose a new candidate that is different from existing candidates and suitable for the task; do not repeat forbidden_signatures. Prefer Chinese for explanatory natural-language fields while preserving required JSON/schema field names.",
    },
    null,
    2,
  )
}

async function requestOpenAICompatible(config: NeoCastLLMConfig, apiKey: string, system: string, user: string) {
  if (!config.baseURL) throw new Error("OPENAI-compatible provider requires llm.base_url")
  const response = await fetch(`${config.baseURL.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens,
      temperature: config.temperature,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  })
  const payload = await response.json().catch(async () => ({ error: { message: await response.text() } }))
  if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `${response.status}`)
  const text = payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.text
  if (typeof text !== "string" || !text.trim()) throw new Error("OpenAI-compatible API returned empty content")
  return text
}

async function requestAnthropic(config: NeoCastLLMConfig, apiKey: string, system: string, user: string) {
  const baseURL = config.baseURL ?? "https://api.anthropic.com/v1"
  const response = await fetch(`${baseURL.replace(/\/+$/, "")}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens,
      temperature: config.temperature,
      system,
      messages: [{ role: "user", content: user }],
    }),
  })
  const payload = await response.json().catch(async () => ({ error: { message: await response.text() } }))
  if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `${response.status}`)
  const text = Array.isArray(payload?.content)
    ? payload.content
        .filter((item: unknown) => isRecord(item) && item.type === "text" && typeof item.text === "string")
        .map((item: { text: string }) => item.text)
        .join("\n")
    : ""
  if (!text.trim()) throw new Error("Anthropic API returned empty content")
  return text
}

export async function requestNeoCastLLM(config: NeoCastLLMConfig, apiKey: string, system: string, user: string) {
  return config.provider === "anthropic"
    ? requestAnthropic(config, apiKey, system, user)
    : requestOpenAICompatible(config, apiKey, system, user)
}

function llmMetadata(config: NeoCastLLMConfig, status: string, extra: JsonRecord = {}): JsonRecord {
  return {
    llmStatus: status,
    llmProvider: config.provider,
    llmModel: config.model,
    ...(config.baseURL === undefined ? {} : { llmBaseURL: config.baseURL }),
    ...extra,
  }
}

type CandidateRiskLevel = "low" | "medium" | "high"

function riskRank(risk: CandidateRiskLevel) {
  return risk === "high" ? 2 : risk === "medium" ? 1 : 0
}

function maxRisk(current: CandidateRiskLevel, next: CandidateRiskLevel): CandidateRiskLevel {
  return riskRank(next) > riskRank(current) ? next : current
}

function numberField(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function candidateGovernance(candidateSpec: JsonRecord) {
  let risk: CandidateRiskLevel = "low"
  const preprocessing = isRecord(candidateSpec.preprocessing) ? candidateSpec.preprocessing : {}
  const actions = Array.isArray(preprocessing.actions) ? preprocessing.actions : []
  if (
    actions.some((action) => {
      if (!isRecord(action)) return false
      return typeof action.type === "string" && action.type !== "none"
    })
  ) {
    risk = maxRisk(risk, "medium")
  }

  const embedding = isRecord(candidateSpec.embedding) ? candidateSpec.embedding : {}
  const backbone = isRecord(candidateSpec.backbone) ? candidateSpec.backbone : {}
  const fusion = isRecord(candidateSpec.fusion) ? candidateSpec.fusion : {}
  const predictionHead = isRecord(candidateSpec.predictionHead) ? candidateSpec.predictionHead : {}
  const trainingStrategy = isRecord(candidateSpec.trainingStrategy) ? candidateSpec.trainingStrategy : {}
  const loss = isRecord(trainingStrategy.loss) ? trainingStrategy.loss : {}
  const scheduler = isRecord(trainingStrategy.scheduler) ? trainingStrategy.scheduler : {}
  const budget = isRecord(trainingStrategy.budget) ? trainingStrategy.budget : {}

  const embeddingType = typeof embedding.type === "string" ? embedding.type : undefined
  const backboneType = typeof backbone.type === "string" ? backbone.type : undefined
  const fusionType = typeof fusion.type === "string" ? fusion.type : undefined
  const headType = typeof predictionHead.type === "string" ? predictionHead.type : undefined
  const outputDistribution =
    typeof predictionHead.outputDistribution === "string" ? predictionHead.outputDistribution : undefined
  const lossBase = typeof loss.base === "string" ? loss.base : undefined
  const schedulerType = typeof scheduler.type === "string" ? scheduler.type : undefined

  if (embeddingType !== undefined && !["none", "patch"].includes(embeddingType)) risk = maxRisk(risk, "medium")
  if (backboneType !== undefined && !["linear", "mlp", "transformer"].includes(backboneType)) {
    risk = maxRisk(risk, "medium")
  }
  if (fusionType !== undefined && fusionType !== "temporal") risk = maxRisk(risk, "medium")
  if (headType !== undefined && headType !== "linear") risk = maxRisk(risk, "medium")
  if (outputDistribution !== undefined && outputDistribution !== "point") risk = maxRisk(risk, "medium")
  if (lossBase !== undefined && lossBase !== "mse") risk = maxRisk(risk, "medium")
  if (schedulerType !== undefined && schedulerType !== "none") risk = maxRisk(risk, "medium")

  const largeDimensions = [
    numberField(embedding, "dModel"),
    numberField(backbone, "hiddenDim"),
    numberField(backbone, "dModel"),
  ].some((value) => value !== undefined && value > 512)
  const deepBackbone = [numberField(backbone, "depth"), numberField(backbone, "nLayers"), numberField(backbone, "numLayers")]
    .some((value) => value !== undefined && value > 6)
  const aggressiveBudget =
    (numberField(budget, "timeBudgetS") ?? 0) > 1_200 ||
    (numberField(budget, "batchSize") ?? 0) > 1_024 ||
    (numberField(budget, "maxEpochs") ?? 0) > 100

  if (largeDimensions || deepBackbone || aggressiveBudget) risk = "high"

  return {
    riskLevel: risk,
    approvalStatus: risk === "low" ? "auto_approved" : "pending",
  } as const
}

export async function proposeLLMCandidate(input: {
  readonly task: ResearchTask
  readonly proposalContext: DomainProposalContext
  readonly workspaceRoot: string
  /** Fallback key+baseURL resolved from the opencode auth.json when env vars are absent. */
  readonly authJsonKey?: { readonly key: string; readonly baseURL: string; readonly model: string }
}): Promise<LLMProposalResult> {
  const runtime = isRecord(input.task.taskSpec.runtime) ? input.task.taskSpec.runtime : {}
  const neoCastProjectRoot = typeof runtime.neoCastProjectRoot === "string" ? runtime.neoCastProjectRoot : undefined
  const config = await resolveNeoCastLLMConfig({
    workspaceRoot: input.workspaceRoot,
    neoCastProjectRoot,
  })
  let apiKey = apiKeyFor(config)
  let effectiveConfig = config
  if (!apiKey && input.authJsonKey) {
    apiKey = input.authJsonKey.key
    effectiveConfig = {
      ...config,
      provider: "openai-compatible",
      model: input.authJsonKey.model,
      ...(input.authJsonKey.baseURL ? { baseURL: input.authJsonKey.baseURL } : {}),
    }
  }
  if (!apiKey) {
    return {
      metadata: llmMetadata(config, "not_configured", {
        llmError:
          config.provider === "anthropic"
            ? "ANTHROPIC_API_KEY is not set"
            : "NEO_CAST_LLM_API_KEY, OPENAI_API_KEY, or AIGCBEST_API_KEY is not set. Configure via TUI → Configure API Key.",
      }),
    }
  }

  try {
    const system = buildSystemPrompt()
    const user = buildUserPrompt(input)
    const text = await requestNeoCastLLM(effectiveConfig, apiKey, system, user)
    const candidateSpec = pruneCandidateSpec(camelizeKnown(extractJsonObject(text)))
    const governance = candidateGovernance(candidateSpec)
    return {
      proposal: {
        candidateSpec,
        rationale:
          typeof candidateSpec.hypothesis === "string"
            ? candidateSpec.hypothesis
            : "LLM-generated TSF candidate.",
        ...governance,
        generatedBy: "llm",
      },
      metadata: llmMetadata(effectiveConfig, "used"),
    }
  } catch (error) {
    return {
      metadata: llmMetadata(effectiveConfig, "failed", {
        llmError: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
      }),
    }
  }
}
