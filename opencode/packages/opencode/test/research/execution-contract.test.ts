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
import { addHypothesisToPool, listHypothesesInPool } from "../../src/research/hypothesis-store"
import { analyzeReflection } from "../../src/research/agents/reflection-agent"
import { candidateAttemptStateFromRuns } from "../../src/research/agents/model-designer-agent"
import type { ExecutionContract } from "../../src/research/execution-contract"
import type { HypothesisObject } from "../../src/research/agents/hypo-planner-agent"

const run = <A>(fn: (svc: Research.Interface) => Effect.Effect<A>) =>
  Effect.runPromise(Research.Service.use(fn).pipe(Effect.provide(Research.defaultLayer)))
afterEach(resetDatabase)
const hypothesis = {
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
async function fixtureRunner(root: string, mismatch: boolean) {
  await mkdir(path.join(root, "py"), { recursive: true })
  const script = `const fs = require("fs"), crypto = require("crypto")
const canonical = v => Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}" : JSON.stringify(v)
const c = JSON.parse(fs.readFileSync(process.env.NEO_CAST_EXECUTION_CONTRACT))
const d = crypto.createHash("sha256").update(canonical(c)).digest("hex")
const actual = { ...c.expected, backbone: ${mismatch ? '"mlp"' : "c.expected.backbone"} }
const manifest = { event: "executed_model_manifest", candidate_id: c.candidate_id, candidate_spec_sha256: c.candidate_spec_sha256, contract_digest: d, actual }
console.log(JSON.stringify(manifest))
if (${mismatch}) { console.log(JSON.stringify({event: "execution_contract_violation", mismatches: [{path: "backbone", expected: c.expected.backbone, actual: "mlp"}]})); process.exit(5) }
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
        run((svc) => svc.runNASAgent({ taskID: task.id, stage: "full", maxIterations: 1 })),
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
      expect(analysis.failures).toEqual([])
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
