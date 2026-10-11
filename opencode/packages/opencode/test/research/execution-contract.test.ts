import { comparisonRecipe } from "../../src/research/comparison-run"
import { ExperimentConstraints } from "../../src/research/experiment-constraints"
import { readDesignHistory } from "../../src/research/design-history"
import { TSFDomain } from "../../src/research/domains/tsf"
import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, writeFile, readFile } from "fs/promises"
import path from "path"
import { Research } from "../../src/research"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import {
  canonicalize,
  digest,
  validateCandidateAgainstHypothesis,
  verifyExecutionRecords,
} from "../../src/research/execution-contract"
import { addHypothesisToPool, listHypothesesInPool, selectNextExperimentInPool, updateHypothesisInPool } from "../../src/research/hypothesis-store"
import { Database, eq } from "../../src/storage"
import { ResearchHypothesisTable } from "../../src/research/research.sql"
import { analyzeReflection } from "../../src/research/agents/reflection-agent"
import { candidateAttemptStateFromRuns } from "../../src/research/agents/model-designer-agent"
import { MODEL_CAPABILITIES, candidateMechanisms } from "../../src/research/model-capabilities"
import type { ExecutionContract } from "../../src/research/execution-contract"
import type { HypothesisObject } from "../../src/research/agents/hypo-planner-agent"

const run = <A>(fn: (svc: Research.Interface) => Effect.Effect<A>) =>
  Effect.runPromise(Research.Service.use(fn).pipe(Effect.provide(Research.defaultLayer)))
afterEach(resetDatabase)
const hypothesis = {
  experimentContract: { mode: "exploratory", changes: [], frozenPaths: [], requiredValues: [], forbiddenMechanisms: [] },
  id: "H1",
  statement: "TimesNet",
  suggestedBackbones: ["timesnet_lite"],
  suggestedPreprocessing: [],
  motivation: [],
  expectedOutcome: "improve",
  priority: "high",
  risk: "low",
  testable: true,
  datasetEvidencePaths: [],
  literatureEvidence: [],
  applicabilityAssumptions: [],
  falsificationCriteria: ["Reject if the candidate does not improve the target metric."],
  evidenceLevel: "data_only",
} satisfies HypothesisObject

test("a persisted snake_case frequency contract resumes through explicit mode replanning and trains faithfully", async () => {
  await using tmp = await tmpdir({ git: true })
  const previousFetch = globalThis.fetch
  const keys = ["NEO_CAST_LLM_PROVIDER", "NEO_CAST_LLM_BASE_URL", "NEO_CAST_LLM_MODEL", "NEO_CAST_LLM_API_KEY"] as const
  const previous = keys.map((key) => process.env[key])
  process.env.NEO_CAST_LLM_PROVIDER = "openai-compatible"
  process.env.NEO_CAST_LLM_BASE_URL = "http://llm.test/v1"
  process.env.NEO_CAST_LLM_MODEL = "test-model"
  process.env.NEO_CAST_LLM_API_KEY = "test-key"
  try {
    await Instance.provide({ directory: tmp.path, fn: async () => {
      const root = path.join(tmp.path, "runner")
      const { task, candidate } = await setup(root)
      await fixtureRunner(root, false)
      const anchorHypothesis = await addHypothesisToPool(task.id, { ...hypothesis, id: "H-mlp", suggestedBackbones: ["mlp"] })
      const anchor = await run((svc) => svc.createCandidate({
        taskID: task.id, domainID: "tsf", hypothesisID: anchorHypothesis.id,
        candidateSpec: { ...candidate.candidateSpec, recipeID: "mlp_anchor", recipeVersion: "recipe_schema_v3",
          representation: { layout: "channel_latent", readout: "none", latentDim: 64 }, composition: { type: "single" },
          backbone: { type: "mlp", hiddenDim: 128, depth: 2, activation: "gelu", dropout: 0.1 } },
        rationale: "Matched MLP anchor", generatedBy: "human", riskLevel: "low", approvalStatus: "auto_approved",
      }))
      const prior = await run((svc) => svc.createRun({
        taskID: task.id, candidateID: anchor.id, stage: "full", status: "succeeded", metrics: { cv_avg_mse: 0.4 },
        resourceUsage: { executionContract: { status: "verified", manifest: { actual: { backbone: "mlp" } } } },
      }))
      const legacy: ExperimentConstraints = { mode: "controlled", comparisonRunID: prior.id,
        changes: [
          { operation: "set", path: "embedding.type", before: "none", after: "frequency" },
          { operation: "add", path: "embedding.n_freq", after: 16 },
          { operation: "add", path: "embedding.d_model", after: 64 },
        ], frozenPaths: ["backbone", "training_strategy", "prediction_head", "preprocessing", "composition", "representation", "fusion"],
        requiredValues: [{ path: "embedding.n_freq", value: 16 }, { path: "embedding.d_model", value: 64 }], forbiddenMechanisms: [],
      }
      const original = await addHypothesisToPool(task.id, { ...hypothesis, id: "H-frequency",
        statement: "Test magnitude-only frequency features with frozen MLP and training settings.",
        suggestedBackbones: ["mlp"], experimentContract: legacy,
      })
      expect(original.experimentContract!.changes[1]!.path).toBe("embedding.nFreq")
      // Simulate an existing task written before alias normalization was available.
      Database.use((d) => d.update(ResearchHypothesisTable).set({ experiment_contract: legacy })
        .where(eq(ResearchHypothesisTable.hypo_id, original.id)).run())
      await selectNextExperimentInPool(task.id, { action: "experiment", hypothesisID: original.id, rationale: "Test the amplitude-only intervention." })
      let replans = 0
      let designs = 0
      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        const prompt = JSON.parse(body.messages.at(-1).content)
        let response: unknown
        if (prompt.designFeedback) {
          replans++
          expect(designs).toBe(0)
          expect(prompt.designFeedback.conflicts[0].field).toBe("embedding.complexMode")
          expect(prompt.designFeedback.hypothesisSnapshot.experimentContract.changes[1].path).toBe("embedding.nFreq")
          expect(await run((svc) => svc.listRuns(task.id))).toHaveLength(1)
          response = { hypotheses: [{ ...original, id: "H-frequency-fixed", experimentContract: {
            ...legacy, changes: [...legacy.changes, { operation: "add", path: "embedding.complex_mode", after: "magnitude" }],
            requiredValues: [...legacy.requiredValues, { path: "embedding.complex_mode", value: "magnitude" }],
          } }], nextExperiment: { action: "experiment", hypothesisID: "H-frequency-fixed", rationale: "Explicitly preserve the amplitude-only scientific question." } }
        } else {
          designs++
          expect(prompt.taskFingerprint.selectedHypothesis.experimentContract.changes.at(-1)).toEqual({ operation: "add", path: "embedding.complexMode", after: "magnitude" })
          response = { ...anchor.candidateSpec, recipeID: "frequency_magnitude_control",
            embedding: { type: "frequency", n_freq: 16, d_model: 64, complex_mode: "magnitude" } }
        }
        const content = JSON.stringify(response)
        return new Response(body.stream ? `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`
          : JSON.stringify({ choices: [{ message: { content } }] }),
          { headers: { "content-type": body.stream ? "text/event-stream" : "application/json" } })
      }) as typeof fetch
      const result = await run((svc) => svc.runAutonomousIteration({ taskID: task.id, stage: "full" }))
      expect(replans).toBe(1)
      expect(designs).toBe(1)
      expect(result.run.status).toBe("succeeded")
      expect(result.candidate.candidateSpec.embedding).toEqual({ type: "frequency", nFreq: 16, dModel: 64, complexMode: "magnitude" })
      expect(result.candidate.candidateSpec.trainingStrategy).toEqual(anchor.candidateSpec.trainingStrategy)
      expect(await run((svc) => svc.listApprovals({ taskID: task.id }))).toHaveLength(0)
    } })
  } finally {
    globalThis.fetch = previousFetch
    for (const [index, key] of keys.entries()) {
      if (previous[index] === undefined) delete process.env[key]
      else process.env[key] = previous[index]
    }
  }
})

test("Gate A rejects a different hypothesis and backbone", () => {
  expect(
    validateCandidateAgainstHypothesis(hypothesis, {
      hypothesisID: "H2",
      candidateSpec: { backbone: { type: "mlp" } },
    } as any).map((item) => item.path),
  ).toEqual(["hypothesis_id", "backbone"])
})
test("canonical digest preserves action order and ECMAScript number encoding", () => {
  expect(canonicalize({ z: 1e-5, a: [1, "中文", 1e-7, 1e21] })).toBe('{"a":[1,"中文",1e-7,1e+21],"z":0.00001}')
  expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }))
  expect(digest(["a", "b"])).not.toBe(digest(["b", "a"]))
})
test("Gate B fails closed for missing or stale manifests", () => {
  const contract = {
    schema_version: "research_execution_contract.v1",
    task_id: "task",
    candidate_id: "candidate",
    hypothesis_id: "H1",
    candidate_spec_sha256: "sha",
    expected: { backbone: "timesnet_lite" },
  } as ExecutionContract
  expect(verifyExecutionRecords(contract, [])).toHaveLength(2)
  const record = { candidate_id: "candidate", candidate_spec_sha256: "sha", contract_digest: digest(contract) }
  const records = [
    { ...record, event: "executed_model_manifest", actual: { backbone: "timesnet_lite" } },
    { ...record, event: "execution_contract_verified", status: "verified" },
  ]
  expect(verifyExecutionRecords(contract, records)).toEqual([])
  expect(
    verifyExecutionRecords(contract, [...records, { event: "execution_contract_violation", mismatches: [] }]).length,
  ).toBeGreaterThan(0)
  expect(
    verifyExecutionRecords(contract, [{ ...records[0], candidate_id: "other" }, ...records]).length,
  ).toBeGreaterThan(0)
  expect(verifyExecutionRecords({ ...contract, expected: { backbone: "mlp" } }, records).length).toBeGreaterThan(0)
})

// Deterministic subprocess fixture. Python unit tests independently check actual module introspection.
async function fixtureRunner(root: string, mismatch: boolean | string) {
  await mkdir(path.join(root, "py"), { recursive: true })
  const script = `const fs = require("fs"), crypto = require("crypto")
const canonical = v => Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}" : JSON.stringify(v)
const c = JSON.parse(fs.readFileSync(process.env.NEO_CAST_EXECUTION_CONTRACT))
const d = crypto.createHash("sha256").update(canonical(c)).digest("hex")
const fails = ${typeof mismatch === "string" ? `c.candidate_id === ${JSON.stringify(mismatch)}` : mismatch}
const actual = { ...c.expected, backbone: fails ? "mlp" : c.expected.backbone }
const manifest = { event: "executed_model_manifest", candidate_id: c.candidate_id, candidate_spec_sha256: c.candidate_spec_sha256, contract_digest: d, actual }
console.log(JSON.stringify(manifest))
if (fails) { console.log(JSON.stringify({event: "execution_contract_violation", mismatches: [{path: "backbone", expected: c.expected.backbone, actual: "mlp"}]})); process.exit(5) }
console.log(JSON.stringify({event: "execution_contract_verified", candidate_id: c.candidate_id, candidate_spec_sha256: c.candidate_spec_sha256, contract_digest: d, status: "verified", manifest}))
console.log(JSON.stringify({event: "smoke_eval_done", val_avg_mse: 0.1}))
console.log(JSON.stringify({event: "cv_eval_done", cv_avg_mse: 0.1, cv_std_mse: 0.01, val_avg_mse: 0.1}))
console.log(JSON.stringify({event: "done", status: "success"}))
`
  await writeFile(path.join(root, "py", "validate.py"), script)
  await writeFile(path.join(root, "py", "runner.py"), script)
}

async function setup(root: string) {
  const taskSpec = {
    contextLength: 96,
    predictionLengths: [24],
    dataset: { loaderID: "etth1_tslib_v1", targetCols: ["OT"] },
    runtime: { pythonExecutable: process.execPath, neoCastProjectRoot: root, bridgeOnly: false },
  }
  const task = await run((svc) =>
    svc.createTask({
      title: "execution contract",
      domainID: "tsf",
      mode: "autonomous",
      taskSpec,
      objective: { primaryMetric: "cv_avg_mse", direction: "minimize" },
      budget: { maxRuns: 3 },
    }),
  )
  // No hypothesis tool/LLM calls are involved in this fixture; link identity is explicit.
  const baseline = Research.DomainRegistry.buildBaselines("tsf", task.taskSpec)[0]!.candidateSpec
  const spec = {
    ...baseline,
    embedding: { type: "none" },
    backbone: { type: "timesnet_lite", hiddenDim: 8, nLayers: 1, topK: 2, kernelSize: 3, dropout: 0 },
  }
  await addHypothesisToPool(task.id, hypothesis)
  await selectNextExperimentInPool(task.id, { action: "experiment", hypothesisID: hypothesis.id, rationale: "Verify and, if needed, repair this exact experiment." })
  const candidate = await run((svc) =>
    svc.createCandidate({
      taskID: task.id,
      domainID: "tsf",
      hypothesisID: "H1",
      candidateSpec: spec,
      rationale: "same original candidate",
      generatedBy: "human",
      riskLevel: "low",
      approvalStatus: "auto_approved",
    }),
  )
  return { task, candidate }
}

test("violation pauses, consumes no full run, preserves evidence, and approval re-verifies original candidate", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const root = path.join(tmp.path, "runner")
      await fixtureRunner(root, true)
      await mkdir(path.join(tmp.path, ".neo-cast"), { recursive: true })
      await writeFile(path.join(tmp.path, ".neo-cast", "runner_state.json"), "{}")
      const { task, candidate } = await setup(root)
      await expect(
        run((svc) => svc.executeRun({ taskID: task.id, candidateID: candidate.id, stage: "full" })),
      ).rejects.toThrow("No verified smoke contract")
      expect(await run((svc) => svc.listRuns(task.id))).toHaveLength(0)
      await expect(
        run((svc) => svc.executeRun({ taskID: task.id, candidateID: candidate.id, stage: "smoke" })),
      ).rejects.toThrow()
      const invalidRuns = await run((svc) => svc.listRuns(task.id))
      expect(invalidRuns.map((r) => r.status)).toEqual(["invalid"])
      expect(invalidRuns[0]!.metrics).toEqual({})
      expect((await run((svc) => svc.getTask(task.id))).status).toBe("paused")
      expect(await run((svc) => svc.getChampion(task.id))).toBeUndefined()
      expect(await run((svc) => svc.listMemory(task.id))).toEqual([])
      expect((await listHypothesesInPool(task.id))[0]!.status).toBe("pending")
      const analysis = analyzeReflection({ task, candidates: [candidate], runs: invalidRuns })
      expect(analysis.plateauStreak).toBe(0)
      expect(analysis.failures).toHaveLength(1)
      expect(analysis.failedRuns).toBe(0)
      expect(analysis.effectiveChanges).toEqual([])
      expect(analysis.ineffectiveChanges).toEqual([])
      expect(candidateAttemptStateFromRuns({ runs: invalidRuns, maxFailedRetries: 0 }).attemptedCandidateIDs.size).toBe(
        0,
      )
      const approvals = await run((svc) => svc.listApprovals({ taskID: task.id }))
      expect(approvals[0]!.reason).toContain("Recommended owner: pipeline_maintainer")
      await expect(run((svc) => svc.resumeExecutionContractCheckpoint(task.id))).rejects.toThrow()
      await run((svc) => svc.replyApproval({ approvalID: approvals[0]!.id, status: "approved" }))
      // Still broken: a new invalid attempt and a fresh pending checkpoint.
      await expect(run((svc) => svc.resumeExecutionContractCheckpoint(task.id))).rejects.toThrow()
      const retryApprovals = await run((svc) => svc.listApprovals({ taskID: task.id }))
      expect(retryApprovals[0]!.reason).toContain("attempt-2")
      expect((await run((svc) => svc.listRuns(task.id))).every((r) => r.status === "invalid")).toBe(true)
      await fixtureRunner(root, false)
      await run((svc) => svc.replyApproval({ approvalID: retryApprovals[0]!.id, status: "approved" }))
      const resumed = await run((svc) => svc.resumeExecutionContractCheckpoint(task.id))
      expect(resumed!.run.candidateID).toBe(candidate.id)
      expect(resumed!.run.stage).toBe("full")
      expect(resumed!.run.status).toBe("succeeded")
      expect((await run((svc) => svc.getTask(task.id))).status).toBe("searching")
      const artifacts = await run((svc) => svc.listArtifacts(task.id))
      const blocker = artifacts.find((a) => a.kind === "execution_contract_violation_json" && a.metadata.attempt === 2)!
      expect(JSON.parse(await readFile(blocker.uri.slice(7), "utf8")).status).toBe("resolved")
      expect((await run((svc) => svc.listCandidates(task.id)))[0]!.hypothesisID).toBe("H1")
      expect(await listHypothesesInPool(task.id)).toHaveLength(1)
      expect((await listHypothesesInPool(task.id))[0]!.status).toBe("pending")
    },
  })
})

test("Gate A creates a blocker without starting Python smoke", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { task, candidate } = await setup(path.join(tmp.path, "no-runner"))
      const wrongCandidate = await run((svc) =>
        svc.createCandidate({
          taskID: task.id,
          domainID: "tsf",
          hypothesisID: "H1",
          candidateSpec: { ...candidate.candidateSpec, backbone: { type: "linear" } },
          rationale: "incorrect backbone",
          generatedBy: "human",
          riskLevel: "low",
          approvalStatus: "auto_approved",
        }),
      )
      await expect(
        run((svc) => svc.executeRun({ taskID: task.id, candidateID: wrongCandidate.id, stage: "smoke" })),
      ).rejects.toThrow()
      expect(await run((svc) => svc.listRuns(task.id))).toEqual([])
      expect((await run((svc) => svc.getTask(task.id))).status).toBe("paused")
      expect(
        (await run((svc) => svc.listArtifacts(task.id))).some((a) => a.kind === "execution_contract_violation_json"),
      ).toBe(true)
    },
  })
})

for (const exhausted of [false, true]) {
  test(exhausted ? "autonomous contract repair requests human help only after two unsuccessful repairs" : "autonomous contract repair asks ModelDesigner for a replacement and re-verifies smoke before full", async () => {
    await using tmp = await tmpdir({ git: true })
    const previousFetch = globalThis.fetch
    const keys = ["NEO_CAST_LLM_PROVIDER", "NEO_CAST_LLM_BASE_URL", "NEO_CAST_LLM_MODEL", "NEO_CAST_LLM_API_KEY"] as const
    const previous = keys.map((key) => process.env[key])
    const prompts: any[] = []
    let replacement: Record<string, unknown>
    process.env.NEO_CAST_LLM_PROVIDER = "openai-compatible"
    process.env.NEO_CAST_LLM_BASE_URL = "http://llm.test/v1"
    process.env.NEO_CAST_LLM_MODEL = "test-model"
    process.env.NEO_CAST_LLM_API_KEY = "test-key"
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      prompts.push(JSON.parse(body.messages.at(-1).content))
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        ...replacement,
        recipeID: `contract_repaired_${prompts.length}`,
        backbone: { type: "timesnet_lite", hiddenDim: 8 + prompts.length, nLayers: 1, topK: 2, kernelSize: 3, dropout: 0 },
      }) } }] }), { headers: { "content-type": "application/json" } })
    }) as typeof fetch
    try {
      await Instance.provide({ directory: tmp.path, fn: async () => {
        const root = path.join(tmp.path, "runner")
        const { task, candidate } = await setup(root)
        await run((svc) => svc.updateTaskBudget({ taskID: task.id, budget: { maxRuns: 10 } }))
        replacement = candidate.candidateSpec
        await fixtureRunner(root, exhausted ? true : candidate.id)
        if (exhausted) {
          await expect(run((svc) => svc.runAutonomousIteration({ taskID: task.id, stage: "full" }))).rejects.toThrow()
          expect(prompts).toHaveLength(2)
          const approvals = await run((svc) => svc.listApprovals({ taskID: task.id }))
          expect(approvals).toHaveLength(1)
          expect(approvals[0]!.reason).toContain("Agent 已尝试 2 次自动修复")
          expect((await run((svc) => svc.getTask(task.id))).status).toBe("paused")
          expect((await run((svc) => svc.listRuns(task.id))).map((item) => item.status)).toEqual(["invalid", "invalid", "invalid"])
          expect(await run((svc) => svc.getChampion(task.id))).toBeUndefined()
          expect(await run((svc) => svc.listMemory(task.id))).toEqual([])
        } else {
          const result = await run((svc) => svc.runAutonomousIteration({ taskID: task.id, stage: "full" }))
          expect(prompts).toHaveLength(1)
          expect(result.run.status).toBe("succeeded")
          expect(result.run.stage).toBe("full")
          expect(result.candidate.id).not.toBe(candidate.id)
          expect(result.candidate.hypothesisID).toBe(candidate.hypothesisID)
          expect(await run((svc) => svc.listApprovals({ taskID: task.id }))).toEqual([])
          expect((await run((svc) => svc.getTask(task.id))).status).not.toBe("paused")
          const runs = await run((svc) => svc.listRuns(task.id))
          expect(runs.toSorted((a, b) => a.time.created - b.time.created).map((item) => [item.stage, item.status])).toEqual([["smoke", "invalid"], ["smoke", "succeeded"], ["full", "succeeded"]])
          const incident = (await run((svc) => svc.listArtifacts(task.id))).find((item) => item.kind === "execution_contract_violation_json")!
          expect(incident.metadata).toMatchObject({ status: "superseded", autoRecoveryStatus: "recovered", replacementCandidateID: result.candidate.id })
        }
        expect(prompts[0].candidateValidationFeedback.rejectedCandidate).toEqual(candidate.candidateSpec)
        expect(prompts[0].candidateValidationFeedback.issues).toContainEqual(expect.objectContaining({ path: "backbone", actual: "mlp" }))
        expect((await run((svc) => svc.listCandidates(task.id))).find((item) => item.id === candidate.id)?.approvalStatus).toBe("rejected")
      } })
    } finally {
      globalThis.fetch = previousFetch
      for (const [index, key] of keys.entries()) {
        if (previous[index] === undefined) delete process.env[key]
        else process.env[key] = previous[index]
      }
    }
  })
}

test("rejecting a contract checkpoint supersedes the bad candidate and returns the task to design", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { task, candidate } = await setup(path.join(tmp.path, "no-runner"))
      const wrongCandidate = await run((svc) =>
        svc.createCandidate({
          taskID: task.id,
          domainID: "tsf",
          hypothesisID: "H1",
          candidateSpec: { ...candidate.candidateSpec, backbone: { type: "linear" } },
          rationale: "incorrect backbone",
          generatedBy: "human",
          riskLevel: "low",
          approvalStatus: "auto_approved",
        }),
      )
      await expect(
        run((svc) => svc.executeRun({ taskID: task.id, candidateID: wrongCandidate.id, stage: "smoke" })),
      ).rejects.toThrow()
      const approval = (await run((svc) => svc.listApprovals({ taskID: task.id })))[0]!
      await run((svc) => svc.replyApproval({ approvalID: approval.id, status: "rejected" }))

      expect(await run((svc) => svc.resumeExecutionContractCheckpoint(task.id))).toBeUndefined()
      expect((await run((svc) => svc.getTask(task.id))).status).toBe("searching")
      const rejected = (await run((svc) => svc.listCandidates(task.id))).find((item) => item.id === wrongCandidate.id)
      expect(rejected?.approvalStatus).toBe("rejected")
      const blocker = (await run((svc) => svc.listArtifacts(task.id))).find(
        (item) => item.kind === "execution_contract_violation_json" && item.metadata.candidateID === wrongCandidate.id,
      )!
      expect(blocker.metadata.status).toBe("superseded")
      expect(JSON.parse(await readFile(blocker.uri.slice(7), "utf8"))).toMatchObject({
        status: "superseded",
        superseded_reason: "candidate_rejected_for_redesign",
      })
    },
  })
})

test("Gate A preserves selected preprocessing order and task covariate declarations", () => {
  const candidate = {
    hypothesisID: "H1",
    candidateSpec: {
      backbone: { type: "timesnet_lite" },
      preprocessing: { actions: [{ type: "none" }, { type: "instance_norm" }] },
      input: { knownFutureCovariates: ["missing"] },
    },
  } as any
  const mismatches = validateCandidateAgainstHypothesis(
    hypothesis,
    candidate,
    { preprocessing: { actions: [{ type: "instance_norm" }, { type: "none" }] } },
    { dataset: { knownFutureCovariates: ["calendar"] } },
  )
  expect(mismatches.map((item) => item.path)).toEqual(["preprocessing", "knownFutureCovariates"])
})


test("mechanism gate rejects NBeats names standing in for fixed bases or multirate", () => {
  const candidate = { hypothesisID: "H1", candidateSpec: { backbone: { type: "nbeats" }, embedding: { type: "none" } } } as any
  const h = { ...hypothesis, suggestedBackbones: ["nbeats"], requiredMechanisms: ["fixed_trend_basis", "multirate_sampling"] as const }
  expect(validateCandidateAgainstHypothesis(h, candidate).map((m) => m.path)).toEqual([
    "requiredMechanisms.fixed_trend_basis", "requiredMechanisms.multirate_sampling",
  ])
  expect(validateCandidateAgainstHypothesis({ ...h, requiredMechanisms: ["learned_residual_backcast"] }, candidate)).toEqual([])
})


test("packaged capabilities stay synchronized with the Python registry", async () => {
  const registry = JSON.parse(await readFile(new URL("../../../../../neo_cast/py/registry/model_capabilities.json", import.meta.url), "utf8"))
  expect(MODEL_CAPABILITIES).toEqual(registry)
  expect(candidateMechanisms({ backbone: { type: "nbeats" }, embedding: { type: "none" } })).toEqual(["learned_residual_backcast"])
})


test("every runtime action has factual semantics, with encoder sharing and fixed decomposition stated explicitly", () => {
  const registry = TSFDomain.info.actionRegistry!
  for (const [category, actions] of Object.entries(registry)) {
    for (const name of Object.keys(actions)) {
      expect((MODEL_CAPABILITIES.component_semantics as any)[category]?.[name]).toBeString()
    }
  }
  expect(MODEL_CAPABILITIES.component_semantics.preprocessing.series_decomposition).toContain("NOT a learnable")
  expect(MODEL_CAPABILITIES.backbones.linear.implementation).toContain("shared=false")
  expect(MODEL_CAPABILITIES.component_semantics.preprocessing.sample_reweighting).toContain("recency weighting is unsupported")
})

test("unavailable design regenerates a hypothesis before training; history is fetched only on request", async () => {
  await using tmp = await tmpdir({ git: true })
  const previousFetch = globalThis.fetch
  const keys = ["NEO_CAST_LLM_PROVIDER", "NEO_CAST_LLM_BASE_URL", "NEO_CAST_LLM_MODEL", "NEO_CAST_LLM_API_KEY"] as const
  const previous = keys.map((key) => process.env[key])
  process.env.NEO_CAST_LLM_PROVIDER = "openai-compatible"
  process.env.NEO_CAST_LLM_BASE_URL = "http://llm.test/v1"
  process.env.NEO_CAST_LLM_MODEL = "test-model"
  process.env.NEO_CAST_LLM_API_KEY = "test-key"
  try {
    await Instance.provide({ directory: tmp.path, fn: async () => {
      const root = path.join(tmp.path, "runner")
      const { task, candidate } = await setup(root)
      const prior = await run((svc) => svc.createRun({ taskID: task.id, candidateID: candidate.id, stage: "full", status: "succeeded", metrics: { cv_avg_mse: 0.5, cv_h96_mse: 0.6 } }))
      await fixtureRunner(root, false)
      let designs = 0
      let replans = 0
      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        const prompt = JSON.parse(body.messages.at(-1).content)
        let response: unknown
        if (prompt.designFeedback) {
          replans++
          expect(prompt.designFeedback.hypothesisID).toBe(candidate.hypothesisID)
          expect(prompt.designFeedback.reason).toBe("No recency weighting exists.")
          expect(prompt.memoryLessons).toBeUndefined()
          expect(prompt.experiences).toBeUndefined()
          expect(prompt.methodLibrary).toBeUndefined()
          expect((await run((svc) => svc.listRuns(task.id)))).toHaveLength(1)
          response = { hypotheses: [{ ...hypothesis, id: "H-replanned", statement: "Test the supported TimesNet proxy at width 9.", requiredMechanisms: [] }],
            nextExperiment: { action: "experiment", hypothesisID: "H-replanned", rationale: "Replace the unavailable recency experiment with an explicit supported comparison." } }
        } else {
          designs++
          expect(prompt.memory).toBeUndefined()
          expect(prompt.searchBiases).toBeUndefined()
          expect(prompt.hypothesisPlan).toBeUndefined()
          if (designs === 1) response = { status: "unavailable", hypothesisID: candidate.hypothesisID,
            reason: "No recency weighting exists.", conflicts: [{ field: "preprocessing.scheme", requested: "recency", supported: "outlier_robust only" }], suggestedRevision: "Generate a hypothesis using a supported mechanism." }
          else if (designs === 2) response = { status: "history_request", request: { runID: prior.id } }
          else {
            expect(prompt.requestedHistory[0].result.runs[0].runID).toBe(prior.id)
            expect(prompt.requestedHistory[0].result.runs[0].metrics.cv_h96_mse).toBe(0.6)
            expect(prompt.taskFingerprint.selectedHypothesis.id).toBe("H-replanned")
            response = { ...candidate.candidateSpec, recipeID: "replanned_supported_recipe", backbone: { type: "timesnet_lite", hiddenDim: 9, nLayers: 1, topK: 2, kernelSize: 3, dropout: 0 } }
          }
        }
        if (body.stream) return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(response) } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }), { headers: { "content-type": "application/json" } })
      }) as typeof fetch
      const result = await run((svc) => svc.runAutonomousIteration({ taskID: task.id, stage: "full" }))
      expect(replans).toBe(1)
      expect(designs).toBe(3)
      expect(result.run.status).toBe("succeeded")
      expect(result.candidate.hypothesisID).toBe("H-replanned")
      expect(await run((svc) => svc.listApprovals({ taskID: task.id }))).toHaveLength(0)
      expect((await run((svc) => svc.listArtifacts(task.id))).some((a) => a.kind === "model_design_unavailable_json")).toBe(true)
      expect((await run((svc) => svc.getTask(task.id))).taskSpec.metadata).toMatchObject({ designFeedback: null })
      const other = await run((svc) => svc.createTask({ title: "other", domainID: "tsf", mode: "autonomous", taskSpec: task.taskSpec, objective: task.objective, budget: task.budget }))
      expect((await readDesignHistory(other.id, { runID: prior.id })).runs).toEqual([])
      expect((await readDesignHistory(task.id, { hypothesisID: candidate.hypothesisID })).runs.map((r) => r.runID)).toContain(prior.id)
    } })
  } finally {
    globalThis.fetch = previousFetch
    for (const [index, key] of keys.entries()) {
      if (previous[index] === undefined) delete process.env[key]
      else process.env[key] = previous[index]
    }
  }
})


test("contradictory candidate-arm mechanisms are rejected on write and legacy plans replan before design", async () => {
  await using tmp = await tmpdir({ git: true })
  const previousFetch = globalThis.fetch
  const keys = ["NEO_CAST_LLM_PROVIDER", "NEO_CAST_LLM_BASE_URL", "NEO_CAST_LLM_MODEL", "NEO_CAST_LLM_API_KEY"] as const
  const previous = keys.map((key) => process.env[key])
  process.env.NEO_CAST_LLM_PROVIDER = "openai-compatible"
  process.env.NEO_CAST_LLM_BASE_URL = "http://llm.test/v1"
  process.env.NEO_CAST_LLM_MODEL = "test-model"
  process.env.NEO_CAST_LLM_API_KEY = "test-key"
  try {
    await Instance.provide({ directory: tmp.path, fn: async () => {
      const { task, candidate } = await setup(path.join(tmp.path, "runner"))
      await run((svc) => svc.createRun({ taskID: task.id, candidateID: candidate.id, stage: "full",
        status: "succeeded", metrics: { cv_avg_mse: 0.5 } }))
      const contract = ExperimentConstraints.parse({ mode: "exploratory", forbiddenMechanisms: ["moving_average_decomposition"] })
      const requirements = ["moving_average_decomposition"] as const
      await expect(addHypothesisToPool(task.id, { ...hypothesis, id: "contradictory", experimentContract: contract,
        requiredMechanisms: requirements })).rejects.toThrow("both require and forbid")
      await expect(updateHypothesisInPool(task.id, hypothesis.id, { experimentContract: contract,
        requiredMechanisms: requirements })).rejects.toThrow("both require and forbid")
      expect(await listHypothesesInPool(task.id)).toHaveLength(1)
      expect((await listHypothesesInPool(task.id))[0]?.requiredMechanisms).toEqual([])
      // Simulate a persisted plan written before consistency checks existed.
      Database.use((d) => d.update(ResearchHypothesisTable).set({ experiment_contract: contract,
        required_mechanisms: [...requirements] }).where(eq(ResearchHypothesisTable.task_id, task.id)).run())
      await expect(selectNextExperimentInPool(task.id, { action: "experiment", hypothesisID: hypothesis.id,
        rationale: "Select legacy plan" })).rejects.toThrow("both require and forbid")
      let calls = 0
      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        calls++
        const body = JSON.parse(String(init?.body))
        const user = JSON.parse(body.messages.at(-1).content)
        expect(user.designFeedback.hypothesisID).toBe(hypothesis.id)
        expect(user.designFeedback.conflicts[0].field).toBe("requiredMechanisms.moving_average_decomposition")
        const content = JSON.stringify({ hypotheses: [], nextExperiment: { action: "stop", rationale: "No feasible replacement yet." } })
        return new Response(body.stream ? `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`
          : JSON.stringify({ choices: [{ message: { content } }] }),
          { headers: { "content-type": body.stream ? "text/event-stream" : "application/json" } })
      }) as typeof fetch
      const result = await run((svc) => svc.runAutonomousLoop({ taskID: task.id, stage: "full", maxIterations: 2 }))
      expect(result.stoppedReason).toBe("planner_stopped")
      expect(calls).toBe(1)
      expect(result.iterations).toHaveLength(0)
      expect(await run((svc) => svc.listApprovals({ taskID: task.id }))).toHaveLength(0)
      expect((await listHypothesesInPool(task.id)).find((h) => h.id === hypothesis.id)?.status).not.toBe("abandoned")
    } })
  } finally {
    globalThis.fetch = previousFetch
    for (const [index, key] of keys.entries()) {
      if (previous[index] === undefined) delete process.env[key]
      else process.env[key] = previous[index]
    }
  }
})

test("ModelDesigner checkpoint reports the last response failure instead of stale retry feedback", async () => {
  await using tmp = await tmpdir({ git: true })
  const previousFetch = globalThis.fetch
  const keys = ["NEO_CAST_LLM_PROVIDER", "NEO_CAST_LLM_BASE_URL", "NEO_CAST_LLM_MODEL", "NEO_CAST_LLM_API_KEY"] as const
  const previous = keys.map((key) => process.env[key])
  process.env.NEO_CAST_LLM_PROVIDER = "openai-compatible"
  process.env.NEO_CAST_LLM_BASE_URL = "http://llm.test/v1"
  process.env.NEO_CAST_LLM_MODEL = "test-model"
  process.env.NEO_CAST_LLM_API_KEY = "test-key"
  try {
    await Instance.provide({ directory: tmp.path, fn: async () => {
      const { task, candidate } = await setup(path.join(tmp.path, "runner"))
      const anchor = await run((svc) => svc.createRun({ taskID: task.id, candidateID: candidate.id,
        stage: "full", status: "succeeded", metrics: { cv_avg_mse: 0.5 } }))
      await updateHypothesisInPool(task.id, hypothesis.id, { experimentContract: ExperimentConstraints.parse({
        mode: "controlled", comparisonRunID: anchor.id,
        changes: [{ operation: "set", path: "backbone.hiddenDim", before: 8, after: 9 }],
      }) })
      let calls = 0
      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        const content = ++calls < 3 ? '{"status":"unavailable","reason":"invalid "quote""}'
          : JSON.stringify({ ...candidate.candidateSpec, comparisonRunID: anchor.id })
        return new Response(body.stream ? `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`
          : JSON.stringify({ choices: [{ message: { content } }] }),
          { headers: { "content-type": body.stream ? "text/event-stream" : "application/json" } })
      }) as typeof fetch
      await expect(run((svc) => svc.runAutonomousIteration({ taskID: task.id, stage: "full" }))).rejects.toThrow()
      expect(calls).toBe(3)
      const approvals = await run((svc) => svc.listApprovals({ taskID: task.id }))
      expect(approvals[0]?.reason).toContain("comparisonRunID")
      expect(approvals[0]?.reason).not.toContain("Invalid JSON")
      expect(approvals[0]?.reason).not.toContain("found 0")
      expect(await run((svc) => svc.listRuns(task.id))).toHaveLength(1)
    } })
  } finally {
    globalThis.fetch = previousFetch
    for (const [index, key] of keys.entries()) {
      if (previous[index] === undefined) delete process.env[key]
      else process.env[key] = previous[index]
    }
  }
})

for (const mode of ["stop", "repeat"] as const) {
  test(`unavailable design ${mode} stops without proxy runs or refutation`, async () => {
    await using tmp = await tmpdir({ git: true })
    const previousFetch = globalThis.fetch
    const keys = ["NEO_CAST_LLM_PROVIDER", "NEO_CAST_LLM_BASE_URL", "NEO_CAST_LLM_MODEL", "NEO_CAST_LLM_API_KEY"] as const
    const previous = keys.map((key) => process.env[key])
    process.env.NEO_CAST_LLM_PROVIDER = "openai-compatible"
    process.env.NEO_CAST_LLM_BASE_URL = "http://llm.test/v1"
    process.env.NEO_CAST_LLM_MODEL = "test-model"
    process.env.NEO_CAST_LLM_API_KEY = "test-key"
    try {
      await Instance.provide({ directory: tmp.path, fn: async () => {
        const { task, candidate } = await setup(path.join(tmp.path, "runner"))
        await run((svc) => svc.createRun({ taskID: task.id, candidateID: candidate.id, stage: "full", status: "succeeded", metrics: { cv_avg_mse: 0.5 } }))
        let designs = 0
        let replans = 0
        globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body))
          const prompt = JSON.parse(body.messages.at(-1).content)
          let response: unknown
          if (prompt.designFeedback) {
            replans++
            const replacement = { ...hypothesis, id: `H-replan-${replans}`, statement: `Unsupported design revision ${replans}` }
            response = { hypotheses: [replacement], nextExperiment: mode === "stop"
              ? { action: "stop", rationale: "No useful feasible experiment remains." }
              : { action: "experiment", hypothesisID: replacement.id, rationale: "Try the revised hypothesis." } }
          } else {
            designs++
            response = { status: "unavailable", hypothesisID: prompt.taskFingerprint.selectedHypothesis.id,
              reason: "The requested mechanism cannot be implemented.", conflicts: [{ field: "preprocessing", requested: "recency", supported: "amplitude weighting" }],
              suggestedRevision: "Remove the unavailable recency treatment." }
          }
          const content = JSON.stringify(response)
          return new Response(body.stream
            ? `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`
            : JSON.stringify({ choices: [{ message: { content } }] }),
            { headers: { "content-type": body.stream ? "text/event-stream" : "application/json" } })
        }) as typeof fetch
        const result = await run((svc) => svc.runAutonomousLoop({ taskID: task.id, stage: "full", maxIterations: 2 }))
        expect(result.stoppedReason).toBe("planner_stopped")
        expect(result.iterations).toHaveLength(0)
        expect(designs).toBe(mode === "stop" ? 1 : 4)
        expect(replans).toBe(mode === "stop" ? 1 : 3)
        expect(await run((svc) => svc.listRuns(task.id))).toHaveLength(1)
        expect(await run((svc) => svc.listCandidates(task.id))).toHaveLength(1)
        expect(await run((svc) => svc.listApprovals({ taskID: task.id }))).toHaveLength(0)
        const original = (await listHypothesesInPool(task.id)).find((h) => h.id === candidate.hypothesisID)
        expect(original?.testable).toBe(false)
        expect(original?.status).not.toBe("abandoned")
        expect((await run((svc) => svc.listArtifacts(task.id))).filter((a) => a.kind === "model_design_unavailable_json")).toHaveLength(designs)
      } })
    } finally {
      globalThis.fetch = previousFetch
      for (const [index, key] of keys.entries()) {
        if (previous[index] === undefined) delete process.env[key]
        else process.env[key] = previous[index]
      }
    }
  }, 30_000)
}


test("controlled preflight resolves only verified comparisons under the captured task protocol", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({ directory: tmp.path, fn: async () => {
    const { task, candidate } = await setup(path.join(tmp.path, "runner"))
    const comparison = await run((svc) => svc.createRun({ taskID: task.id, candidateID: candidate.id, stage: "full", status: "succeeded", metrics: { cv_avg_mse: 0.4 }, resourceUsage: {} }))
    expect(comparisonRecipe(task.id, comparison.id)).toBeUndefined()
    await run((svc) => svc.updateRunStatus({ runID: comparison.id, status: "succeeded", resourceUsage: { ...comparison.resourceUsage, executionContract: { status: "verified", manifest: { actual: { backbone: "timesnet_lite" } } } } }))
    expect(comparisonRecipe(task.id, comparison.id)).toEqual(candidate.candidateSpec)
    const controlled = { ...hypothesis, experimentContract: ExperimentConstraints.parse({ mode: "controlled", comparisonRunID: comparison.id, changes: [{ operation: "set", path: "backbone.hiddenDim", before: 8, after: 16 }] }) }
    const trial = { ...candidate, candidateSpec: { ...candidate.candidateSpec, backbone: { ...(candidate.candidateSpec.backbone as object), hiddenDim: 16 } } }
    expect(validateCandidateAgainstHypothesis(controlled, trial)).toEqual([])
    await run((svc) => svc.updateTaskSpec({ taskID: task.id, taskSpec: { ...task.taskSpec, contextLength: 192 } }))
    expect(validateCandidateAgainstHypothesis(controlled, trial).map((issue) => issue.path)).toContain("comparisonRunID")
  } })
})

test("schema-restored bias removal replans before design and trains the corrected matched control", async () => {
  await using tmp = await tmpdir({ git: true })
  const previousFetch = globalThis.fetch
  const keys = ["NEO_CAST_LLM_PROVIDER", "NEO_CAST_LLM_BASE_URL", "NEO_CAST_LLM_MODEL", "NEO_CAST_LLM_API_KEY"] as const
  const previous = keys.map((key) => process.env[key])
  process.env.NEO_CAST_LLM_PROVIDER = "openai-compatible"
  process.env.NEO_CAST_LLM_BASE_URL = "http://llm.test/v1"
  process.env.NEO_CAST_LLM_MODEL = "test-model"
  process.env.NEO_CAST_LLM_API_KEY = "test-key"
  try {
    await Instance.provide({ directory: tmp.path, fn: async () => {
      const root = path.join(tmp.path, "runner")
      const { task, candidate } = await setup(root)
      await fixtureRunner(root, false)
      const anchorHypothesis = await addHypothesisToPool(task.id, {
        ...hypothesis, id: "H-dlinear", suggestedBackbones: ["dlinear"],
      })
      const anchor = await run((svc) => svc.createCandidate({
        taskID: task.id, domainID: "tsf", hypothesisID: anchorHypothesis.id,
        candidateSpec: { ...candidate.candidateSpec, recipeID: "dlinear_anchor", recipeVersion: "recipe_schema_v3",
          representation: { layout: "channel_latent", readout: "none", latentDim: 64 }, composition: { type: "single" },
          backbone: { type: "dlinear", kernelSize: 25, individual: false, bias: true } },
        rationale: "Decomposition anchor", generatedBy: "human", riskLevel: "low", approvalStatus: "auto_approved",
      }))
      const comparison = await run((svc) => svc.createRun({
        taskID: task.id, candidateID: anchor.id, stage: "full", status: "succeeded", metrics: { cv_avg_mse: 0.4 },
        resourceUsage: { executionContract: { status: "verified", manifest: { actual: { backbone: "dlinear" } } } },
      }))
      const changes = [
        { operation: "set", path: "backbone.type", before: "dlinear", after: "linear" },
        { operation: "remove", path: "backbone.kernelSize", before: 25 },
        { operation: "remove", path: "backbone.individual", before: false },
        { operation: "remove", path: "backbone.bias", before: true },
        { operation: "add", path: "backbone.shared", after: true },
      ]
      const invalid = await addHypothesisToPool(task.id, {
        ...hypothesis, id: "H-control", statement: "Test a matched control without decomposition.",
        suggestedBackbones: ["linear"], requiredMechanisms: [],
        experimentContract: ExperimentConstraints.parse({ mode: "controlled", comparisonRunID: comparison.id, changes }),
      })
      await selectNextExperimentInPool(task.id, { action: "experiment", hypothesisID: invalid.id, rationale: "Isolate decomposition." })
      let designs = 0
      let replans = 0
      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        const prompt = JSON.parse(body.messages.at(-1).content)
        let response: unknown
        if (prompt.designFeedback) {
          replans++
          expect(designs).toBe(0)
          expect(prompt.designFeedback.conflicts[0].field).toBe("backbone.bias")
          expect(prompt.designFeedback.hypothesisSnapshot.experimentContract).toEqual(invalid.experimentContract)
          expect((await listHypothesesInPool(task.id)).find((h) => h.id === invalid.id)?.testable).toBe(false)
          expect(await run((svc) => svc.listRuns(task.id))).toHaveLength(1)
          response = { hypotheses: [{ ...invalid, id: "H-control-fixed", experimentContract: {
            ...invalid.experimentContract, changes: changes.filter((change) => change.path !== "backbone.bias"),
          } }], nextExperiment: { action: "experiment", hypothesisID: "H-control-fixed", rationale: "Preserve the supported bias field." } }
        } else {
          designs++
          expect(prompt.taskFingerprint.selectedHypothesis.id).toBe("H-control-fixed")
          response = { ...anchor.candidateSpec, recipeID: "linear_control", backbone: { type: "linear", shared: true, bias: true } }
        }
        const content = JSON.stringify(response)
        return new Response(body.stream
          ? `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`
          : JSON.stringify({ choices: [{ message: { content } }] }),
          { headers: { "content-type": body.stream ? "text/event-stream" : "application/json" } })
      }) as typeof fetch
      const result = await run((svc) => svc.runAutonomousIteration({ taskID: task.id, stage: "full" }))
      expect(replans).toBe(1)
      expect(designs).toBe(1)
      expect(result.run.status).toBe("succeeded")
      expect(result.candidate.candidateSpec.backbone).toEqual({ type: "linear", shared: true, bias: true })
      expect(validateCandidateAgainstHypothesis((await listHypothesesInPool(task.id)).find((h) => h.id === "H-control-fixed")!, result.candidate)).toEqual([])
      expect(await run((svc) => svc.listApprovals({ taskID: task.id }))).toHaveLength(0)
    } })
  } finally {
    globalThis.fetch = previousFetch
    for (const [index, key] of keys.entries()) {
      if (previous[index] === undefined) delete process.env[key]
      else process.env[key] = previous[index]
    }
  }
})
