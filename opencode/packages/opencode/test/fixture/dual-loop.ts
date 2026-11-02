import { Effect } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Research } from "../../src/research"
import { TSFCandidateRecipe, buildTSFBaselines } from "../../src/research/domains/tsf"
import { addHypothesisToPool, selectNextExperimentInPool } from "../../src/research/hypothesis-store"

export const createDualLoopFixture = Effect.fn(function* (
  root: string,
  options: {
    rejectTuned?: boolean
    failFullLR?: number
    failSmokeLR?: number
    delayFullMs?: number
  } = {},
) {
  const service = yield* Research.Service
  const runner = path.join(root, "runner")
  yield* Effect.promise(() => mkdir(path.join(runner, "py"), { recursive: true }))
  const script = `const fs = require("fs"), crypto = require("crypto")
if (process.argv.includes("init")) process.exit(0)
const canonical = v => Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}" : JSON.stringify(v)
const c = JSON.parse(fs.readFileSync(process.env.NEO_CAST_EXECUTION_CONTRACT))
const recipe = JSON.parse(fs.readFileSync(process.env.NEO_CAST_CONTRACT_CANDIDATE))
const lr = (recipe.training_strategy || recipe.model_config?.recipe?.training_strategy)?.optimizer?.lr || 0.001
const metric = lr === 0.0005 ? ${options.rejectTuned ? -0.2 : 0.2} : lr === 0.0001 ? 0.25 : 0.3
const smoke = process.argv.includes("smoke")
fs.appendFileSync(${JSON.stringify(path.join(root, "training-calls.jsonl"))}, JSON.stringify({ candidateID: c.candidate_id, stage: smoke ? "smoke" : "full", lr, pid: process.pid }) + "\\n")
const d = crypto.createHash("sha256").update(canonical(c)).digest("hex")
const manifest = { event: "executed_model_manifest", candidate_id: c.candidate_id, candidate_spec_sha256: c.candidate_spec_sha256, contract_digest: d, actual: c.expected }
console.log(JSON.stringify(manifest))
console.log(JSON.stringify({ event: "execution_contract_verified", candidate_id: c.candidate_id, candidate_spec_sha256: c.candidate_spec_sha256, contract_digest: d, status: "verified", manifest }))
if (smoke ? lr === ${options.failSmokeLR ?? -1} : lr === ${options.failFullLR ?? -1}) {
  console.error("CUDA out of memory during training")
  console.log(JSON.stringify({ event: "done", status: "failed" }))
  process.exit(1)
}
if (!smoke && ${options.delayFullMs ?? 0} > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${options.delayFullMs ?? 0})
console.log(JSON.stringify({ event: "epoch_end", epoch: 1, horizon: 8, val_loss: metric }))
console.log(JSON.stringify({ event: "smoke_eval_done", val_avg_mse: metric }))
console.log(JSON.stringify({ event: "eval_done", val_avg_mse: metric, val_h8_mse: metric, val_avg_mae: 0.4 }))
console.log(JSON.stringify({ event: "cv_eval_done", cv_avg_mse: metric, cv_std_mse: 0.01, val_avg_mse: metric }))
console.log(JSON.stringify({ event: "done", status: "success" }))
`
  yield* Effect.promise(() =>
    Promise.all(["validate.py", "runner.py"].map((file) => writeFile(path.join(runner, "py", file), script))),
  )
  const taskSpec = {
    contextLength: 12,
    predictionLengths: [8],
    dataset: { loaderID: "local_csv", targetCols: ["OT"] },
    evaluation: { protocol: "fixed_split", metricPrimary: "val_avg_mse", seeds: [42] },
    runtime: { pythonExecutable: process.execPath, neoCastProjectRoot: runner, bridgeOnly: true },
  }
  const recipe = TSFCandidateRecipe.parse(buildTSFBaselines(taskSpec)[0]!.candidateSpec)
  const task = yield* service.createTask({
    title: "Dual-loop fixture",
    domainID: "tsf",
    mode: "autonomous",
    taskSpec: { ...taskSpec, metadata: { researchVariant: "zero" } },
    objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
    budget: { maxRuns: 20 },
  })
  const hypothesis = yield* Effect.promise(() =>
    addHypothesisToPool(task.id, {
      id: "H-fixed",
      statement: "A fixed temporal design tests the observed signal.",
      suggestedBackbones: [recipe.backbone.type],
      suggestedPreprocessing: [],
      requiredMechanisms: [],
      motivation: ["Current-task temporal observations"],
      expectedOutcome: "Lower validation MSE",
      risk: "low",
      testable: true,
      datasetEvidencePaths: [],
      literatureEvidence: [],
      applicabilityAssumptions: [],
      falsificationCriteria: ["No validation improvement"],
      evidenceLevel: "data_only",
      experimentContract: {
        mode: "exploratory",
        changes: [],
        frozenPaths: [],
        requiredValues: [],
        forbiddenMechanisms: [],
      },
    }),
  )
  yield* Effect.promise(() =>
    selectNextExperimentInPool(task.id, {
      action: "experiment",
      hypothesisID: hypothesis.id,
      rationale: "Execute the fixed design first",
    }),
  )
  const candidate = yield* service.createCandidate({
    taskID: task.id,
    domainID: "tsf",
    hypothesisID: hypothesis.id,
    candidateSpec: recipe as Research.JsonRecord,
    rationale: "Initial fixed design",
    generatedBy: "human",
    riskLevel: "low",
    approvalStatus: "auto_approved",
  })
  return { task, candidate, hypothesis, recipe }
})

export function optimizerFixture() {
  const keys = ["NEO_CAST_LLM_PROVIDER", "NEO_CAST_LLM_BASE_URL", "NEO_CAST_LLM_MODEL", "NEO_CAST_LLM_API_KEY"] as const
  const previous = keys.map((key) => process.env[key])
  const original = globalThis.fetch
  process.env.NEO_CAST_LLM_PROVIDER = "openai-compatible"
  process.env.NEO_CAST_LLM_BASE_URL = "http://dual-loop.fixture/v1"
  process.env.NEO_CAST_LLM_MODEL = "fixture-model"
  process.env.NEO_CAST_LLM_API_KEY = "fixture-key"
  const calls = {
    optimizer: 0,
    planner: 0,
    reflection: 0,
    trainingReflection: 0,
    interruptTrainingReflection: false,
    interruptArchitectureReflection: false,
    invalidTrainingReflection: false,
    forceArchitectureSupport: false,
    hangTrainingReflection: false,
    interrupt: false,
    invalidDesign: false,
    hangOptimizer: false,
    aborted: false,
  }
  const inputs = { training: [] as any[], architecture: [] as any[], optimizer: [] as any[], planner: [] as any[] }
  const order: string[] = []
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    const system: string = body.messages[0].content
    let result: unknown
    if (system.startsWith("You are OptimizerAgent")) {
      if (calls.interrupt) throw new Error("simulated optimizer interruption")
      calls.optimizer++
      if (calls.hangOptimizer)
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => {
            calls.aborted = true
            reject(new Error("fixture request aborted"))
          }
          if (init?.signal?.aborted) abort()
          else init?.signal?.addEventListener("abort", abort, { once: true })
        })
      const input = JSON.parse(body.messages[1].content)
      inputs.optimizer.push(input)
      order.push("optimizer")
      const strategy = structuredClone(input.recipe.trainingStrategy)
      strategy.optimizer.lr = calls.optimizer === 1 ? 0.0005 : 0.0001
      result = {
        action: "tune",
        rationale: "The measured convergence supports testing another learning rate",
        trainingStrategy: strategy,
        ...(calls.invalidDesign ? { backbone: { type: "mlp" } } : {}),
      }
    } else if (system.startsWith("You are ReflectionAgent in training mode")) {
      if (calls.interruptTrainingReflection) throw new Error("simulated training reflection interruption")
      calls.trainingReflection++
      inputs.training.push(JSON.parse(body.messages[1].content))
      order.push("training")
      if (calls.hangTrainingReflection)
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => {
            calls.aborted = true
            reject(new Error("fixture request aborted"))
          }
          if (init?.signal?.aborted) abort()
          else init?.signal?.addEventListener("abort", abort, { once: true })
        })
      result = {
        executionAssessment: "Execution outcome follows the supplied exact records.",
        trainingHealthAssessment: "A single observed epoch cannot establish convergence or generalization.",
        nextTrainingQuestions: ["Which bounded learning rate intervention improves validation MSE?"],
        limitations: ["No architectural hypothesis is assessed in training mode."],
        ...(calls.invalidTrainingReflection
          ? { hypothesisAssessment: { status: "supported", reason: "invalid cross-scope verdict" } }
          : {}),
      }
    } else if (system.startsWith("You are ReflectionAgent in architecture mode")) {
      if (calls.interruptArchitectureReflection) throw new Error("simulated architecture reflection interruption")
      calls.reflection++
      inputs.architecture.push(JSON.parse(body.messages[1].content))
      order.push("architecture")
      result = {
        hypothesisAssessment: {
          status: calls.forceArchitectureSupport ? "supported" : "inconclusive",
          reason: "The supplied design summary distinguishes selected performance from matched architecture evidence.",
        },
        designAssessment: "The best eligible trial guides search; training comparisons do not isolate architecture.",
        trainingConfounders: [],
        nextArchitectureQuestions: ["Choose a matched architecture comparison."],
        limitations: ["One dataset does not establish universal transferability."],
      }
    } else if (system.startsWith("You are the NeoResearch HypoPlanner")) {
      calls.planner++
      inputs.planner.push(JSON.parse(body.messages[1].content))
      order.push("planner")
      result = {
        hypotheses: [],
        nextExperiment: { action: "stop", rationale: "The completed design answers this fixture's question" },
      }
    } else {
      calls.reflection++
      result = Object.fromEntries(
        [
          "trainingHealthAssessment",
          "hypothesisValidation",
          "attributionAnalysis",
          "historicalComparison",
          "modelDesignReflection",
          "nextStepRecommendation",
          "distillableMemory",
        ].map((key) => [key, "Observed fixed-design training results; no independent architectural attribution."]),
      )
    }
    const content = JSON.stringify(result)
    return body.stream
      ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      : new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          headers: { "content-type": "application/json" },
        })
  }) as typeof fetch
  return {
    calls,
    inputs,
    order,
    restore() {
      globalThis.fetch = original
      keys.forEach((key, i) => {
        if (previous[i] === undefined) delete process.env[key]
        else process.env[key] = previous[i]
      })
    },
  }
}
