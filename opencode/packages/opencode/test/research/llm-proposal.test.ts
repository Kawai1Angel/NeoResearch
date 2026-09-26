import { afterEach, expect, test } from "bun:test"
import { mkdtemp } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { buildUserPrompt, proposeLLMCandidate } from "../../src/research/llm-proposal"
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
    budget: { max_epochs: 200, time_budget_s: 1_800, batch_size: 4_096, patience: 10, seed: 42 },
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

test("ModelDesigner prompt summarizes correlation matrices and other unbounded arrays", () => {
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
  expect(prompt.taskFingerprint.datasetProfileAnalysis.correlationStructure).toMatchObject({
    kind: "correlation_matrix_summary",
    rows: width,
    columns: width,
  })
  expect(prompt.taskFingerprint.datasetProfileAnalysis.metrics.crossVarCorrelation).toMatchObject({
    value: 0.5,
    assessment: expect.any(String),
    modelingImplication: expect.any(String),
  })
  expect(prompt.taskFingerprint.datasetProfileAnalysis.correlationStructure.strongestPairs.length).toBeLessThanOrEqual(12)
  expect(prompt.memory[0].fingerprintSummary).toBeUndefined()
  expect(prompt.memory[0].fingerprintAnalysis).toEqual({ relationship: "same_task" })
  expect(prompt.runs[0].metrics.perTargetMSE).toMatchObject({
    kind: "numeric_array_analysis",
    count: width,
    mean: expect.any(Number),
    standardDeviation: expect.any(Number),
    analysis: expect.any(String),
  })
  expect(prompt.runs[0].metrics.residualMatrix).toMatchObject({
    kind: "numeric_matrix_analysis",
    rows: 2,
    columns: 3,
    valueDistribution: expect.objectContaining({
      mean: 3,
      analysis: expect.any(String),
    }),
    rowMeanDistribution: expect.objectContaining({ analysis: expect.any(String) }),
    columnMeanDistribution: expect.objectContaining({ analysis: expect.any(String) }),
  })
  expect(prompt.runs[0].metrics.trainingCurve).toMatchObject({
    kind: "training_curve_analysis",
    rawPointCount: 3,
    validPointCount: 3,
    analysis: expect.stringContaining("independently"),
  })
  expect(prompt.runs[0].metrics.trainingCurve.series).toHaveLength(2)
  expect(prompt.runs[0].metrics.trainingCurve.series[0]).toMatchObject({
    firstValLoss: 0.5,
    lastValLoss: 0.4,
    analysis: expect.stringContaining("improved"),
  })
  expect(prompt.task.taskSpec.dataset.targetCols).toMatchObject({
    kind: "collection_analysis",
    count: width,
    uniqueCount: width,
    analysis: expect.any(String),
  })
  expect(prompt.dataAnalysisReport).not.toContain("FULL_MATRIX_SENTINEL")
  expect(prompt.dataAnalysisReport).toContain("Full matrix omitted from LLM context")
  expect(JSON.stringify(prompt).length).toBeLessThan(50_000)
})

test("LLM proposal prompt samples representative candidate, run, and memory history", async () => {
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
  expect(userPrompt.existingCandidates.map((item: { id: string }) => item.id)).toContain("candidate_champion_origin")
  expect(userPrompt.runs.map((item: { candidateID: string }) => item.candidateID)).toContain("candidate_champion_origin")
  expect(userPrompt.memory.map((item: { lesson: string }) => item.lesson)).toContain("accepted lesson from early champion")
  expect(userPrompt.memory.map((item: { lesson: string }) => item.lesson)).toContain("failed lesson from late crash")
})

test("LLM proposal prompt weights memory by recency and exposes forbidden failed signatures", async () => {
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
  expect(userPrompt.memory).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        lesson: "ancient failed MLP recipe should not be repeated",
        memoryWeight: expect.any(Number),
      }),
      expect.objectContaining({
        lesson: "recent rejected transformer recipe should not be repeated",
        memoryWeight: expect.any(Number),
      }),
    ]),
  )
  const ancient = userPrompt.memory.find((item: { lesson: string }) => item.lesson.startsWith("ancient failed"))
  const recent = userPrompt.memory.find((item: { lesson: string }) => item.lesson.startsWith("recent rejected"))
  expect(recent.memoryWeight).toBeGreaterThan(ancient.memoryWeight)
  expect(userPrompt.forbidden_signatures).toEqual(
    expect.arrayContaining([
      expect.stringContaining("ancient_failed_mlp"),
      expect.stringContaining("recent_rejected_transformer"),
    ]),
  )
  expect(userPrompt.instruction).toContain("do not repeat")
})
