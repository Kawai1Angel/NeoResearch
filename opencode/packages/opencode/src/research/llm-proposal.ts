import { readFile } from "fs/promises"
import { createHash } from "crypto"
import os from "os"
import path from "path"
import type { DomainCandidateProposal, DomainProposalContext } from "./domain"
import type { JsonRecord, ResearchTask } from "./schema"
import PROMPT_RESEARCH_MODEL_DESIGNER from "../agent/prompt/research-model-designer.txt"

type LLMProvider = "anthropic" | "openai-compatible"

export type LLMTokenUsage = {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

type LLMResponse = { text: string; usage: LLMTokenUsage }

export const ZERO_USAGE: LLMTokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

export type OpencodeModelRef = { readonly providerID: string; readonly modelID: string }

/**
 * Maps a resolved neo-cast LLM config to an opencode {providerID, modelID} pair, when possible.
 * The Anthropic-native path (no custom baseURL) maps directly to opencode's "anthropic" provider.
 * openai-compatible configs map to a known opencode provider when their baseURL matches one of
 * OPENCODE_PROVIDER_BASE_URLS (e.g. deepseek, zhipuai); other custom baseURLs have no equivalent
 * among opencode's @ai-sdk/* providers and are treated as unmappable.
 */
export function mapToModelRef(config: NeoCastLLMConfig): OpencodeModelRef | undefined {
  if (config.provider === "anthropic" && !config.baseURL) {
    return { providerID: "anthropic", modelID: config.model }
  }
  if (config.provider === "openai-compatible" && config.baseURL) {
    const normalized = config.baseURL.replace(/\/+$/, "")
    for (const [providerID, baseURL] of Object.entries(OPENCODE_PROVIDER_BASE_URLS)) {
      if (baseURL && baseURL.replace(/\/+$/, "") === normalized) {
        return { providerID, modelID: config.model }
      }
    }
  }
  return undefined
}

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
  share_across_horizons: "shareAcrossHorizons",
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
  post_processing: "postProcessing",
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

export function camelizeKnown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeKnown)
  if (!isRecord(value)) return value
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    result[keyMap[key] ?? key] = camelizeKnown(item)
  }
  return result
}

// Valid top-level keys in TSFCandidateRecipe (schema is .strict()).
const RECIPE_ALLOWED_KEYS = new Set([
  "recipeVersion", "recipeID", "hypothesis", "preprocessing",
  "embedding", "backbone", "fusion", "predictionHead", "trainingStrategy", "notes",
])

// Allowed camelCase keys per backbone type (schema is .strict()).
const BACKBONE_ALLOWED_KEYS: Record<string, readonly string[]> = {
  linear: ["type", "shared", "bias"],
  mlp: ["type", "depth", "hiddenDim", "activation", "dropout"],
  transformer: ["type", "dModel", "nHeads", "nLayers", "dropout", "ffnMult"],
  dlinear: ["type", "kernelSize", "bias", "individual"],
  tcn: ["type", "hiddenDim", "nLayers", "kernelSize", "activation", "dropout"],
  nbeats: ["type", "hiddenDim", "nBlocks", "nLayers", "activation", "dropout"],
  timesnet: ["type", "hiddenDim", "nLayers", "topK", "kernelSize", "dropout"],
  rnn: ["type", "cell", "hiddenDim", "numLayers", "dropout"],
  ssm: ["type", "stateDim", "depth", "dropout"],
  mixer: ["type", "hiddenDim", "depth", "temporalMixing", "channelMixing", "dropout"],
}

// Safe defaults for required integer fields that LLMs frequently omit.
const BACKBONE_REQUIRED_DEFAULTS: Record<string, Record<string, number>> = {
  mlp: { depth: 2, hiddenDim: 128 },
  transformer: { dModel: 64, nHeads: 4, nLayers: 2 },
  dlinear: { kernelSize: 25 },
  tcn: { hiddenDim: 128, nLayers: 3, kernelSize: 5 },
  nbeats: { hiddenDim: 128, nBlocks: 4, nLayers: 3 },
  timesnet: { hiddenDim: 128, nLayers: 3, topK: 5, kernelSize: 5 },
  rnn: { hiddenDim: 128, numLayers: 2 },
  ssm: { stateDim: 64, depth: 2 },
  mixer: { hiddenDim: 128, depth: 2 },
}

const EMBEDDING_ALLOWED_KEYS: Record<string, readonly string[]> = {
  none: ["type"],
  patch: ["type", "patchLen", "stride", "dModel"],
  invert: ["type", "dModel"],
  frequency: ["type", "nFreq", "complexMode", "dModel"],
  calendar: ["type", "fields", "embedDim"],
  multiscale_patch: ["type", "scales", "dModel"],
}

const EMBEDDING_REQUIRED_DEFAULTS: Record<string, Record<string, number>> = {
  patch: { patchLen: 16, stride: 8, dModel: 64 },
  invert: { dModel: 64 },
  frequency: { nFreq: 16, dModel: 64 },
  calendar: { embedDim: 32 },
}

// Backbones that only support embedding.type='none' (domain constraint in tsf.ts).
const BACKBONE_REQUIRES_NONE_EMBEDDING = new Set(["timesnet", "dlinear", "rnn", "ssm", "nbeats"])

const FUSION_ALLOWED_KEYS: Record<string, readonly string[]> = {
  temporal: ["type", "channelMode"],
  feature: ["type", "variateToken", "crossAttention"],
  temporal_then_feature: ["type", "gate", "residual"],
  feature_then_temporal: ["type", "gate", "residual"],
  graph: ["type", "adjacencySource", "sparsity"],
  gated_hybrid: ["type", "gateType"],
}

function applyAllowedAndDefaults(
  obj: Record<string, unknown>,
  allowed: readonly string[] | undefined,
  defaults: Record<string, number>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  for (const key of allowed ?? Object.keys(obj)) {
    if (key in obj) next[key] = obj[key]
  }
  for (const [key, value] of Object.entries(defaults)) {
    if (typeof next[key] !== "number" || !Number.isFinite(next[key] as number)) next[key] = value
  }
  return next
}

function normalizeNumber(obj: Record<string, unknown>, key: string, fallback: number) {
  if (typeof obj[key] !== "number" || !Number.isFinite(obj[key] as number)) obj[key] = fallback
}

export function pruneCandidateSpec(value: unknown): JsonRecord {
  // Strip top-level keys not in the schema (TSFCandidateRecipe is .strict()).
  const raw = isRecord(value) ? value : {}
  const spec: Record<string, unknown> = {}
  for (const key of RECIPE_ALLOWED_KEYS) {
    if (key in raw) spec[key] = raw[key]
  }

  // Guarantee preprocessing.actions is a valid array.
  const preprocessing = spec.preprocessing
  if (!isRecord(preprocessing) || !Array.isArray(preprocessing.actions)) {
    spec.preprocessing = { actions: [{ type: "none" }] }
  } else {
    preprocessing.actions = preprocessing.actions.map((action) => {
      if (!isRecord(action)) return action
      const next = { ...action }
      if (next.type === "series_decomposition") delete next.method
      return next
    })
  }

  // Normalize backbone: strip unknown keys, fill required number defaults.
  const backboneType = isRecord(spec.backbone) && typeof spec.backbone.type === "string"
    ? spec.backbone.type : undefined
  if (isRecord(spec.backbone)) {
    spec.backbone = applyAllowedAndDefaults(
      spec.backbone,
      backboneType !== undefined ? BACKBONE_ALLOWED_KEYS[backboneType] : undefined,
      backboneType !== undefined ? (BACKBONE_REQUIRED_DEFAULTS[backboneType] ?? {}) : {},
    )
  }

  // Normalize embedding: strip unknown keys, fill required number defaults.
  // Certain backbones require embedding.type='none' (domain constraint).
  if (backboneType !== undefined && BACKBONE_REQUIRES_NONE_EMBEDDING.has(backboneType)) {
    spec.embedding = { type: "none" }
  } else if (isRecord(spec.embedding)) {
    const emb = spec.embedding
    const type = typeof emb.type === "string" ? emb.type : undefined
    spec.embedding = applyAllowedAndDefaults(
      emb,
      type !== undefined ? EMBEDDING_ALLOWED_KEYS[type] : undefined,
      type !== undefined ? (EMBEDDING_REQUIRED_DEFAULTS[type] ?? {}) : {},
    )
  }

  // Normalize fusion: strip unknown keys (each variant is .strict()).
  if (isRecord(spec.fusion)) {
    const fusionType = typeof spec.fusion.type === "string" ? spec.fusion.type : undefined
    const allowed = fusionType !== undefined ? FUSION_ALLOWED_KEYS[fusionType] : undefined
    if (allowed !== undefined) {
      const next: Record<string, unknown> = {}
      for (const key of allowed) {
        if (key in spec.fusion) next[key] = spec.fusion[key]
      }
      spec.fusion = next
    }
  }

  // Normalize predictionHead: strip shareAcrossHorizons; fill required quantiles default.
  if (isRecord(spec.predictionHead)) {
    const ph = spec.predictionHead
    if (ph.type === "linear") delete ph.shareAcrossHorizons
    if (ph.type === "quantile" && !Array.isArray(ph.quantiles)) {
      ph.quantiles = [0.1, 0.5, 0.9]
    }
    if (ph.type === "residual_correction" && (typeof ph.correctionDim !== "number" || !Number.isFinite(ph.correctionDim as number))) {
      ph.correctionDim = 64
    }
  }

  // Normalize trainingStrategy: fill required number fields with safe defaults.
  if (isRecord(spec.trainingStrategy)) {
    const ts = spec.trainingStrategy
    if (isRecord(ts.optimizer)) normalizeNumber(ts.optimizer, "lr", 0.001)
    if (isRecord(ts.budget)) {
      normalizeNumber(ts.budget, "maxEpochs", 30)
      normalizeNumber(ts.budget, "timeBudgetS", 600)
      normalizeNumber(ts.budget, "batchSize", 32)
      normalizeNumber(ts.budget, "patience", 5)
    }
  }

  return spec as JsonRecord
}

function buildSystemPrompt() {
  return PROMPT_RESEARCH_MODEL_DESIGNER
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
  const value = run.metrics.cv_avg_mse ?? run.metrics.val_avg_mse
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

export function buildUserPrompt(input: {
  readonly task: ResearchTask
  readonly proposalContext: DomainProposalContext
  readonly dataAnalysisMarkdown?: string
  readonly hypoPlanMarkdown?: string
  readonly previousReflectionMarkdown?: string
  readonly validationFeedback?: {
    readonly attempt: number
    readonly issues: readonly {
      readonly path: string
      readonly message: string
      readonly expected?: unknown
      readonly actual?: unknown
    }[]
    readonly rejectedCandidate?: JsonRecord
  }
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
      ...(input.dataAnalysisMarkdown ? { dataAnalysisReport: input.dataAnalysisMarkdown } : {}),
      ...(input.hypoPlanMarkdown ? { hypothesisPlan: input.hypoPlanMarkdown } : {}),
      ...(input.previousReflectionMarkdown ? { previousSessionReflection: input.previousReflectionMarkdown } : {}),
      existingCandidates: representativeCandidates(input.proposalContext),
      runs: representativeRuns(input.proposalContext),
      memory: representativeMemory(input.proposalContext),
      forbidden_signatures: forbiddenCandidateSignatures(input.proposalContext),
      champion: input.proposalContext.champion,
      ...(input.validationFeedback
        ? {
            candidateValidationFeedback: {
              ...input.validationFeedback,
              instruction:
                "Correct the rejected candidate while preserving its intended experiment and selected hypothesis. Return one complete replacement JSON object.",
            },
          }
        : {}),
      instruction:
        "Propose a new candidate that is different from existing candidates and suitable for the task; do not repeat forbidden_signatures. Prefer Chinese for explanatory natural-language fields while preserving required JSON/schema field names.",
    },
    null,
    2,
  )
}

async function requestOpenAICompatible(config: NeoCastLLMConfig, apiKey: string, system: string, user: string): Promise<LLMResponse> {
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
  const u = payload?.usage
  const usage: LLMTokenUsage = typeof u === "object" && u !== null
    ? {
        inputTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0,
        outputTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
        cacheReadTokens: typeof u.prompt_tokens_details?.cached_tokens === "number" ? u.prompt_tokens_details.cached_tokens : 0,
        cacheWriteTokens: 0,
      }
    : ZERO_USAGE
  return { text, usage }
}

async function requestAnthropic(config: NeoCastLLMConfig, apiKey: string, system: string, user: string): Promise<LLMResponse> {
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
  const u = payload?.usage
  const usage: LLMTokenUsage = typeof u === "object" && u !== null
    ? {
        inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : 0,
        outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : 0,
        cacheReadTokens: typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0,
        cacheWriteTokens: typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0,
      }
    : ZERO_USAGE
  return { text, usage }
}

export async function requestNeoCastLLM(config: NeoCastLLMConfig, apiKey: string, system: string, user: string): Promise<LLMResponse> {
  return config.provider === "anthropic"
    ? requestAnthropic(config, apiKey, system, user)
    : requestOpenAICompatible(config, apiKey, system, user)
}

async function requestAnthropicStream(
  config: NeoCastLLMConfig,
  apiKey: string,
  system: string,
  user: string,
  onDelta: (delta: string) => void,
): Promise<LLMResponse> {
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
      stream: true,
    }),
  })
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(async () => ({ error: { message: await response.text() } }))
    throw new Error(payload?.error?.message || payload?.message || `${response.status}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let fullText = ""
  let usage: LLMTokenUsage = ZERO_USAGE
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue
      const data = line.slice(6).trim()
      if (data === "[DONE]" || !data) continue
      try {
        const event = JSON.parse(data) as Record<string, unknown>
        if (event.type === "content_block_delta") {
          const delta = (event.delta as Record<string, unknown> | undefined)
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            onDelta(delta.text)
            fullText += delta.text
          }
        } else if (event.type === "message_delta" || event.type === "message_start") {
          const u = (event.usage ?? (event.message as Record<string, unknown> | undefined)?.usage) as Record<string, unknown> | undefined
          if (u && typeof u === "object") {
            usage = {
              inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : usage.inputTokens,
              outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : usage.outputTokens,
              cacheReadTokens: typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : usage.cacheReadTokens,
              cacheWriteTokens: typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : usage.cacheWriteTokens,
            }
          }
        }
      } catch {}
    }
  }
  if (!fullText.trim()) throw new Error("Anthropic streaming API returned empty content")
  return { text: fullText, usage }
}

async function requestOpenAICompatibleStream(
  config: NeoCastLLMConfig,
  apiKey: string,
  system: string,
  user: string,
  onDelta: (delta: string) => void,
): Promise<LLMResponse> {
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
      stream: true,
      stream_options: { include_usage: true },
    }),
  })
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(async () => ({ error: { message: await response.text() } }))
    throw new Error(payload?.error?.message || payload?.message || `${response.status}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let fullText = ""
  let usage: LLMTokenUsage = ZERO_USAGE
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue
      const data = line.slice(6).trim()
      if (data === "[DONE]" || !data) continue
      try {
        const event = JSON.parse(data) as Record<string, unknown>
        const choices = Array.isArray(event.choices) ? event.choices : []
        const delta = (choices[0] as Record<string, unknown> | undefined)?.delta
        const content = typeof (delta as Record<string, unknown> | undefined)?.content === "string"
          ? (delta as Record<string, unknown>).content as string
          : undefined
        if (content) {
          onDelta(content)
          fullText += content
        }
        const u = event.usage as Record<string, unknown> | undefined
        if (u && typeof u === "object") {
          usage = {
            inputTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : usage.inputTokens,
            outputTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : usage.outputTokens,
            cacheReadTokens: typeof (u.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens === "number"
              ? (u.prompt_tokens_details as Record<string, unknown>).cached_tokens as number
              : usage.cacheReadTokens,
            cacheWriteTokens: 0,
          }
        }
      } catch {}
    }
  }
  if (!fullText.trim()) throw new Error("OpenAI-compatible streaming API returned empty content")
  return { text: fullText, usage }
}

export async function requestNeoCastLLMStream(
  config: NeoCastLLMConfig,
  apiKey: string,
  system: string,
  user: string,
  onDelta: (delta: string) => void,
): Promise<LLMResponse> {
  return config.provider === "anthropic"
    ? requestAnthropicStream(config, apiKey, system, user, onDelta)
    : requestOpenAICompatibleStream(config, apiKey, system, user, onDelta)
}

export function usageToMetadata(usage: LLMTokenUsage): JsonRecord {
  if (usage.inputTokens === 0 && usage.outputTokens === 0) return {}
  return {
    llmInputTokens: usage.inputTokens,
    llmOutputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens > 0 ? { llmCacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens > 0 ? { llmCacheWriteTokens: usage.cacheWriteTokens } : {}),
  }
}

export function llmMetadata(config: NeoCastLLMConfig, status: string, extra: JsonRecord = {}, usage?: LLMTokenUsage): JsonRecord {
  return {
    llmStatus: status,
    llmProvider: config.provider,
    llmModel: config.model,
    ...(config.baseURL === undefined ? {} : { llmBaseURL: config.baseURL }),
    ...(usage ? usageToMetadata(usage) : {}),
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

export function candidateGovernance(candidateSpec: JsonRecord) {
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

/**
 * Parses an LLM-generated candidate proposal from raw response text. Returns undefined when the
 * text doesn't contain a valid candidate JSON object — callers should treat this as a failed attempt.
 */
export function buildLLMProposalFromText(text: string, usage: LLMTokenUsage, config: NeoCastLLMConfig): LLMProposalResult | undefined {
  try {
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
      metadata: llmMetadata(config, "used", {}, usage),
    }
  } catch {
    return undefined
  }
}

export async function proposeLLMCandidate(input: {
  readonly task: ResearchTask
  readonly proposalContext: DomainProposalContext
  readonly workspaceRoot: string
  /** Fallback key+baseURL resolved from the opencode auth.json when env vars are absent. */
  readonly authJsonKey?: { readonly key: string; readonly baseURL: string; readonly model: string }
  readonly dataAnalysisMarkdown?: string
  readonly hypoPlanMarkdown?: string
  readonly previousReflectionMarkdown?: string
  readonly validationFeedback?: Parameters<typeof buildUserPrompt>[0]["validationFeedback"]
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
    // Empty baseURL signals Anthropic native path (auth.json stores "" for anthropic).
    const isAnthropicNative = !input.authJsonKey.baseURL
    effectiveConfig = {
      ...config,
      provider: isAnthropicNative ? "anthropic" : "openai-compatible",
      model: isAnthropicNative ? config.model : input.authJsonKey.model,
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

  const system = buildSystemPrompt()
  const user = buildUserPrompt({
    task: input.task,
    proposalContext: input.proposalContext,
    dataAnalysisMarkdown: input.dataAnalysisMarkdown,
    hypoPlanMarkdown: input.hypoPlanMarkdown,
    previousReflectionMarkdown: input.previousReflectionMarkdown,
    validationFeedback: input.validationFeedback,
  })
  const maxAttempts = 3
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { text, usage } = await requestNeoCastLLM(effectiveConfig, apiKey, system, user)
      const result = buildLLMProposalFromText(text, usage, effectiveConfig)
      if (!result) throw new Error("Failed to parse LLM proposal JSON")
      return result
    } catch (error) {
      lastError = error
      if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt))
    }
  }
  {
    const error = lastError
    return {
      metadata: llmMetadata(effectiveConfig, "failed", {
        llmError: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
      }),
    }
  }
}

// ---------------------------------------------------------------------------
// Auth.json key resolution — shared between service.ts and intent-agent.ts
// ---------------------------------------------------------------------------

export const OPENCODE_PROVIDER_BASE_URLS: Record<string, string> = {
  zhipuai: "https://open.bigmodel.cn/api/paas/v4",
  "zhipuai-coding-plan": "https://open.bigmodel.cn/api/paas/v4",
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  anthropic: "",
}

const OPENCODE_PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  zhipuai: "glm-4-flash",
  "zhipuai-coding-plan": "glm-4-flash",
  openai: "gpt-4o-mini",
  deepseek: "deepseek-chat",
}

export interface AuthJsonKeyResult {
  readonly key: string
  readonly baseURL: string
  readonly model: string
}

export async function resolveApiKeyFromAuthJson(): Promise<AuthJsonKeyResult | undefined> {
  if (process.env.OPENCODE_TEST_HOME) return undefined
  const candidates = [
    process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, "neo-research", "auth.json") : undefined,
    path.join(os.homedir(), ".local", "share", "neo-research", "auth.json"),
    path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
  ].filter((p): p is string => p !== undefined)
  for (const authPath of candidates) {
    try {
      const raw = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>
      const priority = ["anthropic", "openai", ...Object.keys(OPENCODE_PROVIDER_BASE_URLS)]
      const order = [...new Set(priority)]
      for (const providerID of order) {
        const entry = raw[providerID]
        if (!entry || typeof entry !== "object") continue
        const rec = entry as Record<string, unknown>
        if (rec.type !== "api" || typeof rec.key !== "string" || !rec.key) continue
        const baseURL = OPENCODE_PROVIDER_BASE_URLS[providerID] ?? ""
        const model = OPENCODE_PROVIDER_DEFAULT_MODELS[providerID] ?? "gpt-4o-mini"
        return { key: rec.key, baseURL, model }
      }
    } catch {
      // file missing or unreadable
    }
  }
  return undefined
}

// Resolves the effective LLM config + API key, falling back to auth.json when env vars are absent.
export async function resolveEffectiveLLMConfig(input: {
  readonly workspaceRoot: string
  readonly neoCastProjectRoot?: string
}): Promise<{ apiKey: string; config: NeoCastLLMConfig } | undefined> {
  const config = await resolveNeoCastLLMConfig(input)
  let apiKey = apiKeyFor(config)
  let effectiveConfig = config
  if (!apiKey) {
    const authEntry = await resolveApiKeyFromAuthJson()
    if (!authEntry) return undefined
    apiKey = authEntry.key
    const isAnthropicNative = !authEntry.baseURL
    effectiveConfig = {
      ...config,
      provider: isAnthropicNative ? "anthropic" : "openai-compatible",
      model: isAnthropicNative ? config.model : authEntry.model,
      ...(authEntry.baseURL ? { baseURL: authEntry.baseURL } : {}),
    }
  }
  return { apiKey, config: effectiveConfig }
}
