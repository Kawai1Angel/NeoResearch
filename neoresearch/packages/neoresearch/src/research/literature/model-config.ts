import { resolveEffectiveLLMConfig, type NeoCastLLMConfig } from "../llm-proposal"

export type LiteraturePaperMode = "extract_missing" | "reuse_only"

export function resolveLiteraturePaperMode(value = process.env.NEO_RESEARCH_LITERATURE_PAPER_MODE): LiteraturePaperMode {
  if (value === undefined || value === "extract_missing") return "extract_missing"
  if (value === "reuse_only") return "reuse_only"
  throw new Error("NEO_RESEARCH_LITERATURE_PAPER_MODE must be extract_missing or reuse_only")
}

function numberSetting(value: string | undefined, fallback: number, name: string, min: number, max: number) {
  const number = value === undefined ? fallback : Number(value)
  if ((value !== undefined && !value.trim()) || !Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${name} is outside its supported range`)
  }
  return number
}

export async function resolveLiteratureLLMConfig(
  input: { workspaceRoot: string; neoCastProjectRoot?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ apiKey: string; config: NeoCastLLMConfig } | undefined> {
  const selected = ["MODEL", "BASE_URL", "API_KEY", "PROVIDER"].some((name) => env[`NEO_RESEARCH_LITERATURE_LLM_${name}`] !== undefined)
  if (!selected) {
    const resolved = await resolveEffectiveLLMConfig(input)
    return resolved ? { ...resolved, config: { ...resolved.config, maxTokens: 16_384 } } : undefined
  }
  const provider = env.NEO_RESEARCH_LITERATURE_LLM_PROVIDER ?? "openai-compatible"
  if (provider !== "openai-compatible" && provider !== "anthropic") throw new Error("Unsupported literature LLM provider")
  const baseURL = env.NEO_RESEARCH_LITERATURE_LLM_BASE_URL ?? (provider === "openai-compatible" ? "https://api.deepseek.com" : undefined)
  const model = env.NEO_RESEARCH_LITERATURE_LLM_MODEL ?? "deepseek-flash"
  const deepseek = baseURL !== undefined && new URL(baseURL).hostname === "api.deepseek.com"
  const thinking = env.NEO_RESEARCH_LITERATURE_LLM_THINKING ?? "enabled"
  if (thinking !== "enabled" && thinking !== "disabled") throw new Error("Literature thinking must be enabled or disabled")
  const apiKey = env.NEO_RESEARCH_LITERATURE_LLM_API_KEY ?? (deepseek ? env.DEEPSEEK_API_KEY : undefined)
  if (!apiKey?.trim()) throw new Error("The selected literature model requires its dedicated API key")
  if (!model.trim()) throw new Error("The literature model must not be empty")
  const maxTokens = numberSetting(env.NEO_RESEARCH_LITERATURE_LLM_MAX_TOKENS, 32_768, "Literature max tokens", 1, 393_216)
  if (!Number.isInteger(maxTokens)) throw new Error("Literature max tokens must be an integer")
  return { apiKey, config: {
    provider, model, ...(baseURL ? { baseURL } : {}), maxTokens,
    temperature: numberSetting(env.NEO_RESEARCH_LITERATURE_LLM_TEMPERATURE, 0.2, "Literature temperature", 0, 2),
    ...(deepseek ? { thinking, ...(thinking === "enabled" ? { reasoningEffort: "low" as const } : {}), responseFormat: "json_object" as const } : {}),
  } }
}
