import { readFile } from "fs/promises"
import os from "os"
import path from "path"
import type { DomainCandidateProposal, DomainProposalContext } from "./domain"
import type { JsonRecord, ResearchTask } from "./schema"

type LLMProvider = "anthropic" | "openai-compatible"

type NeoCastLLMConfig = {
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

async function resolveNeoCastLLMConfig(input: { readonly workspaceRoot: string; readonly neoCastProjectRoot?: string }) {
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

function apiKeyFor(config: NeoCastLLMConfig) {
  if (config.provider === "anthropic") return process.env.ANTHROPIC_API_KEY
  return process.env.NEO_CAST_LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.AIGCBEST_API_KEY
}

function extractJsonObject(text: string) {
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

function buildSystemPrompt() {
  return [
    "You are the NeoResearch TSF model-design planner.",
    "Return exactly one JSON object using Neo-Cast recipe_schema_v1 snake_case field names.",
    "Do not return markdown or prose outside JSON.",
    "Use only these modules: preprocessing none, instance_norm, series_decomposition, seasonal_differencing, missing_mask, sample_reweighting; embedding none, patch, multiscale_patch, invert, frequency, calendar; backbone linear, mlp, transformer, dlinear, tcn, nbeats, timesnet, rnn, ssm, mixer; fusion temporal, feature, temporal_then_feature, feature_then_temporal, graph, gated_hybrid; prediction_head linear, direct_multi_horizon, quantile, gaussian, residual_correction.",
    "Include training_strategy.loss, optimizer, scheduler, regularization, and budget.",
  ].join("\n")
}

function buildUserPrompt(input: {
  readonly task: ResearchTask
  readonly proposalContext: DomainProposalContext
}) {
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
      existingCandidates: input.proposalContext.candidates.slice(-8),
      runs: input.proposalContext.runs.slice(-12),
      memory: input.proposalContext.memory.slice(0, 8),
      champion: input.proposalContext.champion,
      instruction: "Propose a new candidate that is different from existing candidates and suitable for the task.",
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

function llmMetadata(config: NeoCastLLMConfig, status: string, extra: JsonRecord = {}): JsonRecord {
  return {
    llmStatus: status,
    llmProvider: config.provider,
    llmModel: config.model,
    ...(config.baseURL === undefined ? {} : { llmBaseURL: config.baseURL }),
    ...extra,
  }
}

export async function proposeLLMCandidate(input: {
  readonly task: ResearchTask
  readonly proposalContext: DomainProposalContext
  readonly workspaceRoot: string
}): Promise<LLMProposalResult> {
  const runtime = isRecord(input.task.taskSpec.runtime) ? input.task.taskSpec.runtime : {}
  const neoCastProjectRoot = typeof runtime.neoCastProjectRoot === "string" ? runtime.neoCastProjectRoot : undefined
  const config = await resolveNeoCastLLMConfig({
    workspaceRoot: input.workspaceRoot,
    neoCastProjectRoot,
  })
  const apiKey = apiKeyFor(config)
  if (!apiKey) {
    return {
      metadata: llmMetadata(config, "not_configured", {
        llmError:
          config.provider === "anthropic"
            ? "ANTHROPIC_API_KEY is not set"
            : "NEO_CAST_LLM_API_KEY, OPENAI_API_KEY, or AIGCBEST_API_KEY is not set",
      }),
    }
  }

  try {
    const system = buildSystemPrompt()
    const user = buildUserPrompt(input)
    const text =
      config.provider === "anthropic"
        ? await requestAnthropic(config, apiKey, system, user)
        : await requestOpenAICompatible(config, apiKey, system, user)
    const candidateSpec = pruneCandidateSpec(camelizeKnown(extractJsonObject(text)))
    const bridgeOnly = runtime.bridgeOnly !== false
    const governance = bridgeOnly
      ? ({ riskLevel: "low", approvalStatus: "auto_approved" } as const)
      : ({ riskLevel: "medium", approvalStatus: "pending" } as const)
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
      metadata: llmMetadata(config, "used"),
    }
  } catch (error) {
    return {
      metadata: llmMetadata(config, "failed", {
        llmError: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
      }),
    }
  }
}
