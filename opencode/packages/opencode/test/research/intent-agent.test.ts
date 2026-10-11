import { afterEach, expect, test } from "bun:test"
import { analyzeIntentTask, analyzeIntentTaskWithLLM } from "../../src/research/agents/intent-agent"
import type { ResearchTask } from "../../src/research/schema"

const previousEnv = {
  provider: process.env.NEO_CAST_LLM_PROVIDER,
  baseURL: process.env.NEO_CAST_LLM_BASE_URL,
  key: process.env.NEO_CAST_LLM_API_KEY,
  intentLLM: process.env.NEO_RESEARCH_INTENT_LLM,
}
const previousFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = previousFetch
  if (previousEnv.provider === undefined) delete process.env.NEO_CAST_LLM_PROVIDER
  else process.env.NEO_CAST_LLM_PROVIDER = previousEnv.provider
  if (previousEnv.baseURL === undefined) delete process.env.NEO_CAST_LLM_BASE_URL
  else process.env.NEO_CAST_LLM_BASE_URL = previousEnv.baseURL
  if (previousEnv.key === undefined) delete process.env.NEO_CAST_LLM_API_KEY
  else process.env.NEO_CAST_LLM_API_KEY = previousEnv.key
  if (previousEnv.intentLLM === undefined) delete process.env.NEO_RESEARCH_INTENT_LLM
  else process.env.NEO_RESEARCH_INTENT_LLM = previousEnv.intentLLM
})

function task(input: {
  interactionMode?: "socratic" | "companion"
  taskSpec?: Record<string, unknown>
  objective?: Record<string, unknown>
  budget?: Record<string, unknown>
} = {}): ResearchTask {
  const interactionMode = input.interactionMode ?? "socratic"
  return {
    id: "task_intent",
    projectID: "project_intent",
    title: "ETTh1 oil temperature forecast",
    domainID: "tsf",
    mode: interactionMode === "companion" ? "review" : "autonomous",
    status: "intent_gathering",
    taskSpec: {
      contextLength: 96,
      predictionLengths: [24, 96],
      dataset: {
        path: "/tmp/etth1.csv",
        targetCols: ["OT"],
        exogenousCols: [],
      },
      metadata: {
        interactionMode,
        userPrompt: "Forecast transformer oil temperature for operations planning.",
      },
      businessContext: "Operations team needs reliable transformer oil temperature forecasts.",
      interpretability: "prefer clear ablations and simple components when metrics are close",
      deploymentTarget: "local CPU batch scoring",
      ...input.taskSpec,
    },
    objective: {
      primaryMetric: "val_avg_mse",
      secondaryMetrics: ["val_avg_mae"],
      errorPreferences: "minimize average error, watch long-horizon degradation",
      direction: "minimize",
      ...input.objective,
    },
    budget: {
      maxRuns: 12,
      latencyBudget: "batch inference under 500ms",
      parameterBudget: "under 2M parameters preferred",
      loop: { maxIterations: 20, maxNoImprove: 5 },
      ...input.budget,
    },
    time: { created: 1, updated: 1 },
  } as unknown as ResearchTask
}

test("socratic intent spec uses expanded slots and asks one focused question", () => {
  const result = analyzeIntentTask({
    task: task({
      taskSpec: {
        businessContext: undefined,
        metadata: { interactionMode: "socratic" },
      },
    }),
  })

  expect(result.intentSpec.interaction_mode).toBe("socratic")
  expect(result.intentSpec.lookback_window).toBe(96)
  expect(result.intentSpec.prediction_horizon).toEqual([24, 96])
  expect(result.intentSpec.data_split_method).toBe("ratio")
  expect(result.intentSpec.data_split_ratios).toEqual([7, 1, 2])
  expect(result.intentSpec.exogenous_variables).toEqual([])
  expect(result.intentSpec.max_iterations).toBe(20)
  expect(result.intentSpec.max_no_improve).toBe(5)
  expect(result.missingFields).toEqual(["intent.business_context"])
  expect(result.clarifyingQuestions).toHaveLength(1)
  expect(result.dialogueStrategy.maxQuestionsPerTurn).toBe(1)
  expect(result.intentSpecMarkdown).toContain("# Intent Spec")
  expect(result.intentSpecMarkdown).toContain("## Open Questions")
  expect(result.intentSpecMarkdown).toContain("NAS planned iterations: 20")
  expect(result.intentSpecMarkdown).toContain("Stop after no improvement: 5")
  expect(result.intentSpecMarkdown).toContain("Data split ratios (train/validation/test): 7, 1, 2")
})

test("observed-past covariates do not require future availability to complete TSF intent", () => {
  const result = analyzeIntentTask({
    task: task({
      taskSpec: {
        dataset: {
          path: "/tmp/etth1.csv",
          targetCols: ["OT"],
          observedPastCovariates: ["HUFL", "HULL"],
          knownFutureCovariates: [],
        },
      },
    }),
  })

  expect(result.intentSpec.exogenous_variables).toEqual(["HUFL", "HULL"])
  expect(result.intentSpec.future_covariate_availability).toBeUndefined()
  expect(result.missingFields).toEqual([])
  expect(result.clarifyingQuestions).toEqual([])
})

test("intent agent reads explicit row-range split settings", () => {
  const result = analyzeIntentTask({
    task: task({
      taskSpec: {
        dataset: {
          path: "/tmp/etth1.csv",
          targetCols: ["OT"],
          exogenousCols: [],
          split: {
            method: "row_ranges",
            trainRows: [0, 700],
            validationRows: [700, 800],
            testRows: [800, 1000],
          },
        },
      },
    }),
  })

  expect(result.intentSpec.data_split_method).toBe("row_ranges")
  expect(result.intentSpec.data_split_row_ranges).toEqual({
    train: [0, 700],
    validation: [700, 800],
    test: [800, 1000],
  })
  expect(result.missingFields).not.toContain("dataset.split.rowRanges")
})

test("socratic intent applies optional NAS defaults without asking extra questions", () => {
  const result = analyzeIntentTask({ task: task({ budget: { loop: {} } }) })

  expect(result.intentSpec.max_iterations).toBe(25)
  expect(result.intentSpec.max_no_improve).toBe(7)
  expect(result.missingFields).toEqual([])
  expect(result.clarifyingQuestions).toEqual([])
  expect(result.intentSpecMarkdown).toContain("NAS planned iterations: 25")
  expect(result.intentSpecMarkdown).toContain("Stop after no improvement: 7")
  expect(result.intentSpecMarkdown).not.toContain("Max runs")
})

test("companion intent spec uses compact question batches and checkpoint phases", () => {
  const result = analyzeIntentTask({
    task: task({
      interactionMode: "companion",
      taskSpec: {
        businessContext: undefined,
        interpretability: undefined,
        metadata: { interactionMode: "companion" },
      },
      budget: {
        latencyBudget: undefined,
      },
    }),
  })

  expect(result.intentSpec.interaction_mode).toBe("companion")
  expect(result.clarifyingQuestions).toHaveLength(3)
  expect(result.dialogueStrategy.maxQuestionsPerTurn).toBe(3)
  expect(result.dialogueStrategy.humanCheckpointPhases).toEqual([
    "data_analysis_done",
    "search_space_confirmed",
    "experiment_budget_extended",
    "final_model_selection",
    "report_release",
  ])
})

test("intent agent can use an LLM to refine the next Socratic question", async () => {
  process.env.NEO_RESEARCH_INTENT_LLM = "1"
  process.env.NEO_CAST_LLM_PROVIDER = "openai-compatible"
  process.env.NEO_CAST_LLM_BASE_URL = "http://llm.test/v1"
  process.env.NEO_CAST_LLM_API_KEY = "test-key"
  globalThis.fetch = ((..._args: Parameters<typeof fetch>) =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  confidence: 0.74,
                  clarifying_questions: ["这个业务场景中，OT 预测主要服务调度、告警还是容量规划？"],
                  slots: {
                    business_context: "LLM inferred operations planning context",
                  },
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )) as unknown as typeof fetch

  const result = await analyzeIntentTaskWithLLM({
    task: task({
      taskSpec: {
        businessContext: undefined,
        metadata: { interactionMode: "socratic" },
      },
    }),
    workspaceRoot: "/tmp/workspace",
  })

  expect(result.llm.status).toBe("used")
  expect(result.clarifyingQuestions).toEqual(["这个业务场景中，OT 预测主要服务调度、告警还是容量规划？"])
  expect(result.intentSpec.business_context).toBe("LLM inferred operations planning context")
})
