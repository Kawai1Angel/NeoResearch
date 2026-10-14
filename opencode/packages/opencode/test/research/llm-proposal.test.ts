import { afterEach, expect, test } from "bun:test"
import { mkdtemp } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { buildUserPrompt, proposeLLMCandidate, camelizeKnown, pruneCandidateSpec, buildLLMProposalFromText, ZERO_USAGE } from "../../src/research/llm-proposal"
import type { DomainProposalContext } from "../../src/research/domain"
import { tmpdir as testTmpdir } from "../fixture/fixture"
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
    recipe_version: "recipe_schema_v2",
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
      regularization: { grad_clip: 1 },
      budget: { max_epochs: 5, time_budget_s: 120, batch_size: 16, patience: 2, seed: 42 },
    },
  }
}

function bridgeSafeLLMRecipe(overrides: Record<string, unknown> = {}) {
  return {
    recipe_version: "recipe_schema_v2",
    recipe_id: "recipe_llm_bridge_safe",
    hypothesis: "LLM proposes a conservative bridge-safe candidate.",
    preprocessing: { actions: [{ type: "none" }] },
    embedding: { type: "patch", patch_len: 16, stride: 8, d_model: 32 },
    backbone: { type: "mlp", hidden_dim: 64, depth: 2, activation: "gelu", dropout: 0.1 },
    fusion: { type: "temporal", channel_mode: "independent" },
    prediction_head: { type: "linear", output_distribution: "point" },
    training_strategy: {
      loss: { base: "mse", horizon_weighting: "uniform" },
      optimizer: { type: "adamw", lr: 0.001, weight_decay: 0.01 },
      scheduler: { type: "none", warmup_steps: 0 },
      regularization: { grad_clip: 1 },
      budget: { max_epochs: 5, time_budget_s: 120, batch_size: 16, patience: 2, seed: 42 },
    },
    ...overrides,
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

test("direct design transport accepts bounded evidence requests and passes exact requested pages back to the model", () => {
  const request = { cardID: "kn_example", cardRevision: 1, section: "sources" as const, limit: 4000 }
  const config = { provider: "openai-compatible" as const, model: "test-model", maxTokens: 8192, temperature: 0.2 }
  const result = buildLLMProposalFromText(JSON.stringify({ status: "evidence_request", request }), ZERO_USAGE, config)
  expect(result.evidenceRequest).toEqual(request)
  expect(result.proposal).toBeUndefined()
  const page = { cardID: request.cardID, text: "Exact stored quote", nextOffset: null }
  expect(JSON.parse(buildUserPrompt({ task: task(false), proposalContext, requestedEvidence: [page] })).requestedEvidence).toEqual([page])
  expect(buildLLMProposalFromText(JSON.stringify({ status: "evidence_request", request: { ...request, limit: 12001 } }), ZERO_USAGE, config).evidenceRequest).toBeUndefined()
})

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

test("full-recipe LLM proposals can be auto-approved when content is bridge-safe and conservative", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "opencode-llm-proposal-low-risk-"))
  process.env.NEO_CAST_LLM_PROVIDER = "openai-compatible"
  process.env.NEO_CAST_LLM_BASE_URL = "http://llm.test/v1"
  process.env.NEO_CAST_LLM_MODEL = "test-model"
  process.env.NEO_CAST_LLM_API_KEY = "test-key"
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(bridgeSafeLLMRecipe()) } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )) as unknown as typeof fetch

  const result = await proposeLLMCandidate({
    task: task(false),
    proposalContext,
    workspaceRoot,
  })

  expect(result.proposal).toMatchObject({
    generatedBy: "llm",
    riskLevel: "low",
    approvalStatus: "auto_approved",
  })
})

test("bridge-mode LLM proposals require review when the content raises execution risk", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "opencode-llm-proposal-high-risk-"))
  process.env.NEO_CAST_LLM_PROVIDER = "openai-compatible"
  process.env.NEO_CAST_LLM_BASE_URL = "http://llm.test/v1"
  process.env.NEO_CAST_LLM_MODEL = "test-model"
  process.env.NEO_CAST_LLM_API_KEY = "test-key"
  const riskyTrainingStrategy = {
    loss: { base: "mse", horizon_weighting: "uniform" },
    optimizer: { type: "adamw", lr: 0.001, weight_decay: 0.01 },
    scheduler: { type: "none", warmup_steps: 0 },
    regularization: { grad_clip: 1 },
    budget: { max_epochs: 200, time_budget_s: 1_800, batch_size: 512, patience: 10, seed: 42 },
  }
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  bridgeSafeLLMRecipe({ training_strategy: riskyTrainingStrategy }),
                ),
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    )) as unknown as typeof fetch

  const result = await proposeLLMCandidate({
    task: task(true),
    proposalContext: { ...proposalContext, taskSpec: { runtime: { bridgeOnly: true } } },
    workspaceRoot,
  })

  expect(result.proposal).toMatchObject({
    generatedBy: "llm",
    riskLevel: "high",
    approvalStatus: "pending",
  })
})

test("LLM proposal prompt excludes search directives and exposes factual component semantics", async () => {
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
  expect(prompt).not.toContain("profileDerivedSearchDirectives")
  expect(prompt).toContain("series_decomposition")
  expect(prompt).toContain("missing_mask")
  expect(prompt).toContain("sample_reweighting")
  expect(prompt).toContain("huber")
  expect(prompt).not.toContain("acfMainPeriod")
})

test("ModelDesigner omits unrelated history and preserves the exact task contract", () => {
  const width = 321
  const columns = Array.from({ length: width }, (_, index) => String(index))
  const values = Array.from({ length: width }, (_, left) =>
    Array.from({ length: width }, (_, right) => left === right ? 1 : Number((1 / (1 + Math.abs(left - right))).toFixed(6))),
  )
  const datasetProfile = {
    targetCount: width,
    crossVarCorrelation: 0.5,
    correlationMatrix: { columns, values },
  }
  const prompt = JSON.parse(buildUserPrompt({
    task: {
      ...task(false),
      taskSpec: { dataset: { targetCols: columns } },
    },
    proposalContext: {
      ...proposalContext,
      taskFingerprint: { datasetProfile },
      runs: [{
        candidateID: "candidate_large_metrics",
        stage: "full",
        status: "failed",
        metrics: {
          perTargetMSE: Array.from({ length: width }, (_, index) => index / width),
          residualMatrix: [[1, 2, 3], [2, 4, 6]],
          trainingCurve: [
            { phase: "cv", foldIndex: 1, horizon: 96, epoch: 1, valLoss: 0.5 },
            { phase: "cv", foldIndex: 1, horizon: 96, epoch: 2, valLoss: 0.4 },
            { phase: "cv", foldIndex: 2, horizon: 96, epoch: 1, valLoss: 0.7 },
          ],
        },
      }],
      memory: [{
        scope: "task",
        outcome: "failed",
        lesson: "large fingerprint must be summarized",
        fingerprintSummary: { datasetProfile },
        candidateSummary: {},
      }],
    },
    dataAnalysisMarkdown: [
      "# Dataset Analysis Report",
      "",
      "## Correlation Matrix",
      "",
      "FULL_MATRIX_SENTINEL",
      "",
      "## Search Handoff",
      "",
      "- cross_var_correlated",
    ].join("\n"),
  }))

  expect(prompt.taskFingerprint.datasetProfile).toBeUndefined()
  expect(prompt.taskFingerprint.datasetProfileAnalysis).toBeUndefined()
  expect(prompt.memory).toBeUndefined()
  expect(prompt.runs).toBeUndefined()
  expect(prompt.task.taskSpec.dataset.targetCols).toEqual(columns)
  expect(prompt.dataAnalysisReport).toBeUndefined()
  expect(JSON.stringify(prompt)).not.toContain("FULL_MATRIX_SENTINEL")
  expect(JSON.stringify(prompt).length).toBeLessThan(50_000)
})

test("LLM proposal prompt retains only the factual current champion and on-demand history access", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "opencode-llm-proposal-sampling-"))
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
      candidates: Array.from({ length: 14 }, (_, index) => ({
        id: index === 0 ? "candidate_champion_origin" : `candidate_${index}`,
        candidateSpec: { recipeID: index === 0 ? "champion_origin" : `candidate_${index}` },
        approvalStatus: index === 2 ? "rejected" : "auto_approved",
        generatedBy: "llm",
      })),
      runs: Array.from({ length: 16 }, (_, index) => ({
        candidateID: index === 0 ? "candidate_champion_origin" : `candidate_${index}`,
        stage: "full",
        status: index === 1 ? "failed" : "succeeded",
        metrics: { val_avg_mse: index === 0 ? 0.1 : 1 + index },
      })),
      memory: [
        {
          outcome: "accepted",
          lesson: "accepted lesson from early champion",
          candidateSummary: {},
        },
        ...Array.from({ length: 10 }, (_, index) => ({
          outcome: "rejected",
          lesson: `rejected lesson ${index}`,
          candidateSummary: {},
        })),
        {
          outcome: "failed",
          lesson: "failed lesson from late crash",
          candidateSummary: {},
        },
      ],
      champion: {
        candidateID: "candidate_champion_origin",
        primaryMetric: 0.1,
        utility: -0.1,
      },
    },
    workspaceRoot,
  })

  const body = requestBody as { messages: Array<{ role: string; content: string }> }
  const userPrompt = JSON.parse(body.messages.find((message) => message.role === "user")?.content ?? "{}")
  expect(userPrompt.currentChampion.candidateID).toBe("candidate_champion_origin")
  expect(userPrompt.existingCandidates).toBeUndefined()
  expect(userPrompt.runs).toBeUndefined()
  expect(userPrompt.memory).toBeUndefined()
  expect(userPrompt.historyAccess.filters).toContain("runID")
})

test("LLM proposal prompt does not preload memory or turn negative narratives into forbidden designs", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "opencode-llm-proposal-memory-policy-"))
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

  const now = Date.now()
  await proposeLLMCandidate({
    task: task(false),
    proposalContext: {
      ...proposalContext,
      memory: [
        {
          outcome: "failed",
          lesson: "ancient failed MLP recipe should not be repeated",
          candidateSummary: {
            recipeID: "ancient_failed_mlp",
            candidateSpec: { recipeID: "ancient_failed_mlp", backbone: { type: "mlp" } },
          },
          time: now - 10 * 60 * 60 * 1000,
        },
        {
          outcome: "rejected",
          lesson: "recent rejected transformer recipe should not be repeated",
          candidateSummary: {
            recipeID: "recent_rejected_transformer",
            candidateSpec: { recipeID: "recent_rejected_transformer", backbone: { type: "transformer" } },
          },
          time: now - 10 * 60 * 1000,
        },
      ] as DomainProposalContext["memory"],
    },
    workspaceRoot,
  })

  const body = requestBody as { messages: Array<{ role: string; content: string }> }
  const userPrompt = JSON.parse(body.messages.find((message) => message.role === "user")?.content ?? "{}")
  expect(userPrompt.memory).toBeUndefined()
  expect(userPrompt.forbidden_signatures).toBeUndefined()
  expect(JSON.stringify(userPrompt)).not.toContain("ancient failed MLP")
  expect(JSON.stringify(userPrompt)).not.toContain("recent rejected transformer")
})


test("v2 fills omitted numeric fields while rejecting explicit invalid values", () => {
  const base = camelizeKnown(llmRecipe()) as any
  for (const [section, key, fallback] of [
    ["backbone", "hiddenDim", 128], ["embedding", "dModel", 64],
    ["trainingStrategy.optimizer", "lr", 0.001],
    ["trainingStrategy.budget", "timeBudgetS", 1200],
    ["trainingStrategy.budget", "maxEpochs", 30],
    ["trainingStrategy.budget", "batchSize", 32],
    ["trainingStrategy.budget", "patience", 5],
  ] as const) {
    const get = (value: any) => section.split(".").reduce((obj, field) => obj[field], value)
    const missing = structuredClone(base)
    delete get(missing)[key]
    expect(get(pruneCandidateSpec(missing))[key]).toBe(fallback)
    for (const invalid of ["64", null, true, NaN, Infinity, 0, -1, 1.5]) {
      // Learning rates are positive real numbers; integer-only limits apply to other fields.
      if (key === "lr" && invalid === 1.5) continue
      const spec = structuredClone(base)
      get(spec)[key] = invalid
      expect(() => pruneCandidateSpec(spec)).toThrow()
      expect(get(spec)[key]).toEqual(invalid)
    }
  }
})

test("v2 never replaces malformed preprocessing, head or incompatible embedding with defaults", () => {
  const base = camelizeKnown(llmRecipe()) as any
  for (const preprocessing of [null, [], { actions: "none" }, { actions: null }, { actions: [] }]) {
    expect(() => pruneCandidateSpec({ ...base, preprocessing })).toThrow()
  }
  const omitted = structuredClone(base)
  delete omitted.preprocessing
  expect(pruneCandidateSpec(omitted).preprocessing).toEqual({ actions: [{ type: "none" }] })
  const quantile = { ...base, trainingStrategy: { ...base.trainingStrategy, loss: { base: "quantile" } }, predictionHead: { type: "quantile", outputDistribution: "quantile" } }
  expect(pruneCandidateSpec(quantile).predictionHead).toHaveProperty("quantiles", [0.1, 0.5, 0.9])
  for (const quantiles of [null, "0.5", [], [0], [1], ["0.5"]]) {
    expect(() => pruneCandidateSpec({ ...quantile, predictionHead: { type: "quantile", quantiles } })).toThrow()
  }
  expect(pruneCandidateSpec({ ...base, predictionHead: { type: "residual_correction" } }).predictionHead).toHaveProperty("correctionDim", 64)
  for (const correctionDim of [null, "64", NaN, 0, -1]) {
    expect(() => pruneCandidateSpec({ ...base, predictionHead: { type: "residual_correction", correctionDim } })).toThrow()
  }
  for (const type of ["timesnet_lite", "dlinear", "tcn", "nbeats"]) {
    expect(() => pruneCandidateSpec({ ...base, backbone: { type } })).toThrow(`${type} requires embedding.type=none`)
  }
})

test("removed direct head is rejected in v2 and v3 without conversion", () => {
  const base = camelizeKnown(llmRecipe()) as any
  for (const recipeVersion of ["recipe_schema_v2", "recipe_schema_v3"]) {
    const spec = { ...base, recipeVersion, predictionHead: { type: "direct_multi_horizon", outputDistribution: "point" } }
    expect(() => pruneCandidateSpec(spec)).toThrow()
    expect(spec.predictionHead.type).toBe("direct_multi_horizon")
  }
})

test("proposal errors carry the actual invalid field back to ModelDesigner", () => {
  const spec = llmRecipe()
  Object.assign(spec.backbone, { hidden_dim: "64" })
  const result = buildLLMProposalFromText(JSON.stringify(spec), ZERO_USAGE, {
    provider: "openai-compatible", model: "test", maxTokens: 1000, temperature: 0,
  })
  expect(result?.proposal).toBeUndefined()
  expect(result?.metadata.llmError).toContain("backbone.hiddenDim")
})

test("direct transport feeds validation errors to the agent before retrying", async () => {
  await using tmp = await testTmpdir()
  const workspaceRoot = tmp.path
  process.env.NEO_CAST_LLM_PROVIDER = "openai-compatible"
  process.env.NEO_CAST_LLM_BASE_URL = "http://llm.test/v1"
  process.env.NEO_CAST_LLM_MODEL = "test-model"
  process.env.NEO_CAST_LLM_API_KEY = "test-key"
  const requests: string[] = []
  globalThis.fetch = ((_url: unknown, init: any) => {
    requests.push(String(init.body))
    const spec = llmRecipe()
    if (requests.length === 1) (spec.backbone as any).hidden_dim = "64"
    return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(spec) } }] }), {
      status: 200, headers: { "content-type": "application/json" },
    }))
  }) as unknown as typeof fetch
  const result = await proposeLLMCandidate({ task: task(false), proposalContext, workspaceRoot })
  expect(result.proposal).toBeDefined()
  expect(requests).toHaveLength(2)
  expect(requests[1]).toContain("backbone.hiddenDim")
})


test("unavailable is a normal design result and cannot carry a proxy candidate", () => {
  const config = { provider: "openai-compatible" as const, model: "fixture", maxTokens: 1000, temperature: 0 }
  const response = { status: "unavailable" as const, hypothesisID: "H-recency", reason: "Runtime has no time-index weighting.",
    conflicts: [{ field: "sample_reweighting.scheme", requested: "recency", supported: "uniform|horizon_tail|outlier_robust" }],
    suggestedRevision: "Generate a separate hypothesis for amplitude-based weighting, or choose another supported intervention." }
  const result = buildLLMProposalFromText(JSON.stringify(response), ZERO_USAGE, config)
  expect(result.unavailable).toEqual(response)
  expect(result.proposal).toBeUndefined()
  expect(result.metadata.llmStatus).toBe("used")
  const prose = 'The comparison is [{"type":"none"}], while the declaration uses {"after":"instance_norm"}.\n'
  expect(buildLLMProposalFromText(prose + JSON.stringify(response), ZERO_USAGE, config).unavailable).toEqual(response)
  expect(buildLLMProposalFromText(prose + '```json\n' + JSON.stringify(response) + '\n```', ZERO_USAGE, config).unavailable).toEqual(response)
  expect(buildLLMProposalFromText(JSON.stringify(response) + '\n' + JSON.stringify(response), ZERO_USAGE, config).metadata.llmStatus).toBe("invalid")
  expect(buildLLMProposalFromText(prose + JSON.stringify(response).slice(0, -1), ZERO_USAGE, config).metadata.llmStatus).toBe("invalid")
  expect(buildLLMProposalFromText(JSON.stringify({ ...response, candidate: llmRecipe() }), ZERO_USAGE, config).unavailable).toBeUndefined()
})

test("historical facts can be requested by ID without preloading memory", () => {
  const result = buildLLMProposalFromText(JSON.stringify({ status: "history_request", request: { runID: "comparison-run" } }), ZERO_USAGE,
    { provider: "openai-compatible", model: "fixture", maxTokens: 1000, temperature: 0 })
  expect(result.historyRequest).toEqual({ runID: "comparison-run" })
  expect(result.proposal).toBeUndefined()
})

test("malformed response envelopes retain the JSON error instead of reporting zero objects", () => {
  const config = { provider: "openai-compatible" as const, model: "fixture", maxTokens: 16000, temperature: 0 }
  const malformed = '{"status":"unavailable","hypothesisID":"H-control","reason":"requiredMechanisms=["moving_average_decomposition"] conflicts with the control","conflicts":[],"suggestedRevision":"Revise the candidate arm"}'
  const result = buildLLMProposalFromText(malformed, ZERO_USAGE, config)
  expect(result.metadata.llmStatus).toBe("invalid")
  expect(result.metadata.llmError).toContain("Invalid JSON in ModelDesigner response")
  expect(result.metadata.llmError).not.toContain("found 0")
  expect(result.proposal).toBeUndefined()
  // A malformed envelope must not be silently ignored in favor of another design.
  expect(buildLLMProposalFromText(malformed + '\n' + JSON.stringify(llmRecipe()), ZERO_USAGE, config).proposal).toBeUndefined()
  const wrongField = buildLLMProposalFromText(JSON.stringify({ ...llmRecipe(), recipe_version: "recipe_schema_v3",
    representation: { layout: "channel_latent", readout: "none", latent_dim: 64 }, composition: { type: "single" },
    comparisonRunID: "anchor" }), ZERO_USAGE, config)
  expect(wrongField.metadata.llmError).toContain("comparisonRunID")
})

test("v3 linear designs cannot silently inherit non-shared encoder defaults", () => {
  const result = buildLLMProposalFromText(JSON.stringify({ ...bridgeSafeLLMRecipe(), recipe_version: "recipe_schema_v3",
    representation: { layout: "channel_latent", readout: "none", latent_dim: 64 }, composition: { type: "single" },
    backbone: { type: "linear" }, embedding: { type: "none" } }), ZERO_USAGE,
    { provider: "openai-compatible", model: "fixture", maxTokens: 1000, temperature: 0 })
  expect(result.proposal).toBeUndefined()
  expect(result.metadata.llmError).toContain("shared must be explicitly")
})
