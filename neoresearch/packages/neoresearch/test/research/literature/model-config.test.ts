import { afterEach, expect, test } from "bun:test"
import path from "path"
import { mkdir, writeFile } from "fs/promises"
import { tmpdir } from "../../fixture/fixture"
import { resolveLiteratureLLMConfig, resolveLiteraturePaperMode } from "../../../src/research/literature/model-config"
import { requestNeoCastLLM, resolveEffectiveLLMConfig } from "../../../src/research/llm-proposal"
import { ConfiguredPrincipleModel } from "../../../src/research/literature/principle-model"

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }
afterEach(() => {
  globalThis.fetch = originalFetch
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
})

test("literature credentials and model do not replace the GLM design configuration", async () => {
  await using tmp = await tmpdir()
  await mkdir(path.join(tmp.path, ".neo-cast"))
  await writeFile(path.join(tmp.path, ".neo-cast/config.json"), JSON.stringify({ llm: {
    provider: "openai-compatible", model: "glm-5.2", base_url: "https://open.bigmodel.cn/api/paas/v4", max_tokens: 32768,
  } }))
  process.env.NEO_CAST_LLM_API_KEY = "fixture-glm-key"
  delete process.env.OPENAI_BASE_URL
  delete process.env.ANTHROPIC_BASE_URL
  const input = { workspaceRoot: tmp.path, neoCastProjectRoot: tmp.path }
  const literature = await resolveLiteratureLLMConfig(input, {
    NEO_RESEARCH_LITERATURE_LLM_MODEL: "deepseek-flash",
    NEO_RESEARCH_LITERATURE_LLM_API_KEY: "fixture-deepseek-key",
  })
  expect(literature?.apiKey).toBe("fixture-deepseek-key")
  expect(literature?.config).toMatchObject({ model: "deepseek-flash", baseURL: "https://api.deepseek.com", maxTokens: 32768 })
  const design = await resolveEffectiveLLMConfig(input)
  expect(design?.apiKey).toBe("fixture-glm-key")
  expect(design?.config.model).toBe("glm-5.2")
  const fallback = await resolveLiteratureLLMConfig(input, {})
  expect(fallback?.config).toMatchObject({ model: "glm-5.2", maxTokens: 16384 })
})

test("a selected literature model fails closed without its own key", async () => {
  await expect(resolveLiteratureLLMConfig({ workspaceRoot: "/unused" }, {
    NEO_RESEARCH_LITERATURE_LLM_MODEL: "deepseek-flash", NEO_CAST_LLM_API_KEY: "fixture-glm-key",
  })).rejects.toThrow("dedicated API key")
  await expect(resolveLiteratureLLMConfig({ workspaceRoot: "/unused" }, {
    NEO_RESEARCH_LITERATURE_LLM_API_KEY: "fixture-key", NEO_RESEARCH_LITERATURE_LLM_MAX_TOKENS: "0",
  })).rejects.toThrow("max tokens")
})

test("DeepSeek audit requests use the selected model, bounded thinking and JSON output", async () => {
  const resolved = (await resolveLiteratureLLMConfig({ workspaceRoot: "/unused" }, {
    NEO_RESEARCH_LITERATURE_LLM_MODEL: "deepseek-flash", NEO_RESEARCH_LITERATURE_LLM_API_KEY: "fixture-deepseek-key",
  }))!
  const calls: { url: string; headers: Headers; body: any }[] = []
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"accepted":true}' }, finish_reason: "stop" }], usage: {} }))
  }) as typeof fetch
  const result = await requestNeoCastLLM(resolved.config, resolved.apiKey, "Return JSON", "Review the supplied evidence")
  expect(result.text).toBe('{"accepted":true}')
  expect(calls[0]!.url).toBe("https://api.deepseek.com/chat/completions")
  expect(calls[0]!.headers.get("authorization")).toBe("Bearer fixture-deepseek-key")
  expect(calls[0]!.body).toMatchObject({ model: "deepseek-flash", max_tokens: 32768,
    thinking: { type: "enabled" }, reasoning_effort: "low", response_format: { type: "json_object" } })
})

test("truncated output is rejected even if its prefix is valid JSON", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "length" }] }))) as unknown as typeof fetch
  await expect(requestNeoCastLLM({ provider: "openai-compatible", model: "deepseek-flash", baseURL: "https://api.deepseek.com", maxTokens: 32, temperature: 0.2 },
    "fixture-key", "Return JSON", "Review")).rejects.toThrow("truncated at max_tokens=32")
})

test("non-thinking literature requests omit reasoning effort and preserve JSON output", async () => {
  const resolved = (await resolveLiteratureLLMConfig({ workspaceRoot: "/unused" }, {
    NEO_RESEARCH_LITERATURE_LLM_MODEL: "deepseek-flash", NEO_RESEARCH_LITERATURE_LLM_API_KEY: "fixture-key",
    NEO_RESEARCH_LITERATURE_LLM_THINKING: "disabled",
  }))!
  let body: any
  globalThis.fetch = (async (_url, init) => {
    body = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }))
  }) as typeof fetch
  await requestNeoCastLLM(resolved.config, resolved.apiKey, "Return JSON", "Review")
  expect(body).toMatchObject({ model: "deepseek-flash", thinking: { type: "disabled" }, response_format: { type: "json_object" } })
  expect(body).not.toHaveProperty("reasoning_effort")
  await expect(resolveLiteratureLLMConfig({ workspaceRoot: "/unused" }, {
    NEO_RESEARCH_LITERATURE_LLM_API_KEY: "fixture-key", NEO_RESEARCH_LITERATURE_LLM_THINKING: "typo",
  })).rejects.toThrow("thinking must be")
})

test("paper selection mode is explicit and invalid values cannot enable extraction", () => {
  expect(resolveLiteraturePaperMode("reuse_only")).toBe("reuse_only")
  expect(resolveLiteraturePaperMode("extract_missing")).toBe("extract_missing")
  expect(() => resolveLiteraturePaperMode("typo")).toThrow("must be")
})

test("audit generation settings invalidate cached reviews without putting credentials in their identity", async () => {
  process.env.NEO_RESEARCH_LITERATURE_LLM_MODEL = "deepseek-flash"
  process.env.NEO_RESEARCH_LITERATURE_LLM_API_KEY = "fixture-literature-secret"
  process.env.NEO_RESEARCH_LITERATURE_LLM_TEMPERATURE = "0.2"
  const input = { workspaceRoot: "/unused", neoCastRoot: "/unused" }
  const first = (await ConfiguredPrincipleModel.create(input))!
  expect(first.modelIdentifier).not.toContain("fixture-literature-secret")
  process.env.NEO_RESEARCH_LITERATURE_LLM_TEMPERATURE = "0.5"
  const changed = (await ConfiguredPrincipleModel.create(input))!
  expect(changed.modelIdentifier).not.toBe(first.modelIdentifier)
  process.env.NEO_RESEARCH_LITERATURE_LLM_API_KEY = "other-fixture-secret"
  const sameSettings = (await ConfiguredPrincipleModel.create(input))!
  expect(sameSettings.modelIdentifier).toBe(changed.modelIdentifier)
  process.env.NEO_RESEARCH_LITERATURE_LLM_THINKING = "disabled"
  const withoutThinking = (await ConfiguredPrincipleModel.create(input))!
  expect(withoutThinking.modelIdentifier).not.toBe(sameSettings.modelIdentifier)
  expect(withoutThinking.modelIdentifier).toContain(":thinking=disabled:effort=none:")
})
