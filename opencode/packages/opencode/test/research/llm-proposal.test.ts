import { afterEach, expect, test } from "bun:test"
import { mkdtemp } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { proposeLLMCandidate } from "../../src/research/llm-proposal"
import type { DomainProposalContext } from "../../src/research/domain"
import type { ResearchTask } from "../../src/research/schema"

const previousEnv = {
  provider: process.env.NEO_CAST_LLM_PROVIDER,
  baseURL: process.env.NEO_CAST_LLM_BASE_URL,
  model: process.env.NEO_CAST_LLM_MODEL,
  key: process.env.NEO_CAST_LLM_API_KEY,
}

const previousFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = previousFetch
  if (previousEnv.provider === undefined) delete process.env.NEO_CAST_LLM_PROVIDER
  else process.env.NEO_CAST_LLM_PROVIDER = previousEnv.provider
  if (previousEnv.baseURL === undefined) delete process.env.NEO_CAST_LLM_BASE_URL
  else process.env.NEO_CAST_LLM_BASE_URL = previousEnv.baseURL
  if (previousEnv.model === undefined) delete process.env.NEO_CAST_LLM_MODEL
  else process.env.NEO_CAST_LLM_MODEL = previousEnv.model
  if (previousEnv.key === undefined) delete process.env.NEO_CAST_LLM_API_KEY
  else process.env.NEO_CAST_LLM_API_KEY = previousEnv.key
})

function llmRecipe() {
  return {
    recipe_version: "recipe_schema_v1",
    recipe_id: "recipe_llm_native_candidate",
    hypothesis: "LLM proposes a native candidate.",
    preprocessing: { actions: [{ type: "none" }] },
    embedding: { type: "frequency", n_freq: 16, complex_mode: "magnitude", d_model: 64 },
    backbone: { type: "mixer", hidden_dim: 128, depth: 2, temporal_mixing: "mlp", channel_mixing: "mlp", dropout: 0.1 },
    fusion: { type: "gated_hybrid", gate_type: "learned" },
    prediction_head: { type: "linear", output_distribution: "point" },
    training_strategy: {
      loss: { base: "mse", horizon_weighting: "uniform" },
      optimizer: { type: "adamw", lr: 0.001, weight_decay: 0.01 },
      scheduler: { type: "none", warmup_steps: 0 },
      regularization: { dropout: 0.1, grad_clip: 1 },
      budget: { max_epochs: 5, time_budget_s: 120, batch_size: 16, patience: 2, seed: 42 },
    },
  }
}

function task(bridgeOnly: boolean): ResearchTask {
  return {
    id: "task_llm_governance",
    projectID: "project_test",
    title: "LLM governance",
    domainID: "tsf",
    mode: "autonomous",
    status: "researching",
    taskSpec: {
      runtime: {
        bridgeOnly,
      },
    },
    objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
    budget: { maxRuns: 12 },
    time: { created: 1, updated: 1 },
  } as unknown as ResearchTask
}

const proposalContext: DomainProposalContext = {
  taskSpec: { runtime: { bridgeOnly: false } },
  candidates: [],
  runs: [],
  memory: [],
}

test("full-recipe LLM proposals require review instead of auto-approval", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "opencode-llm-proposal-"))
  process.env.NEO_CAST_LLM_PROVIDER = "openai-compatible"
  process.env.NEO_CAST_LLM_BASE_URL = "http://llm.test/v1"
  process.env.NEO_CAST_LLM_MODEL = "test-model"
  process.env.NEO_CAST_LLM_API_KEY = "test-key"
  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    const [, init] = args
    requestBody = JSON.parse(String(init?.body ?? "{}"))
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(llmRecipe()) } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as ReturnType<typeof fetch>
  }) as unknown as typeof fetch

  const result = await proposeLLMCandidate({
    task: task(false),
    proposalContext,
    workspaceRoot,
  })

  expect(result.proposal).toMatchObject({
    generatedBy: "llm",
    riskLevel: "medium",
    approvalStatus: "pending",
  })
  expect(JSON.stringify(requestBody)).toContain("中文")
  expect(JSON.stringify(requestBody)).toContain("JSON 字段")
})

test("LLM proposal prompt exposes profile-derived search directives", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "opencode-llm-proposal-profile-"))
  process.env.NEO_CAST_LLM_PROVIDER = "openai-compatible"
  process.env.NEO_CAST_LLM_BASE_URL = "http://llm.test/v1"
  process.env.NEO_CAST_LLM_MODEL = "test-model"
  process.env.NEO_CAST_LLM_API_KEY = "test-key"
  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    const [, init] = args
    requestBody = JSON.parse(String(init?.body ?? "{}"))
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(llmRecipe()) } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as ReturnType<typeof fetch>
  }) as unknown as typeof fetch

  await proposeLLMCandidate({
    task: task(false),
    proposalContext: {
      ...proposalContext,
      taskFingerprint: {
        searchBiases: ["seasonal", "cross_var_correlated", "missing_values", "distribution_shift"],
        datasetProfile: {
          source: "dataset.path",
          path: "/tmp/profiled.csv",
          rowCount: 2048,
          targetCount: 5,
          numericColumnCount: 5,
          missingRate: 0.03,
          trendStrength: 0.22,
          seasonalityStrength: 0.88,
          crossVarCorrelation: 0.71,
          distributionShift: 0.64,
          acfMainPeriod: 24,
        },
      },
    },
    workspaceRoot,
  })

  const prompt = JSON.stringify(requestBody)
  expect(prompt).toContain("profileDerivedSearchDirectives")
  expect(prompt).toContain("series_decomposition")
  expect(prompt).toContain("missing_mask")
  expect(prompt).toContain("sample_reweighting")
  expect(prompt).toContain("huber")
  expect(prompt).toContain("acfMainPeriod")
})
