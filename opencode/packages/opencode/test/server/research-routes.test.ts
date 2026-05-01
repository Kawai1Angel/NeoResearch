import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "fs/promises"
import { tmpdir as osTmpdir } from "os"
import type { UpgradeWebSocket } from "hono/ws"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Research } from "../../src/research"
import { ErrorMiddleware } from "../../src/server/middleware"
import { InstanceRoutes } from "../../src/server/routes/instance"
import { ResearchPaths } from "../../src/server/routes/instance/httpapi/research"
import { Log } from "../../src/util"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const websocket = (() => () => new Response(null, { status: 501 })) as unknown as UpgradeWebSocket

function app() {
  return InstanceRoutes(websocket).onError(ErrorMiddleware)
}

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function validTsfTaskSpec() {
  return {
    contextLength: 96,
    predictionLengths: [24],
    dataset: {
      loaderID: "etth1_tslib_v1",
      targetCols: ["OT"],
    },
  }
}

async function writeProfileDataset() {
  const root = await mkdtemp(path.join(osTmpdir(), "opencode-research-route-profile-"))
  const csvPath = path.join(root, "train.csv")
  const lines = ["date,a,b,c"]
  for (let index = 0; index < 96; index++) {
    const seasonal = index % 24
    const trend = index * 0.5
    const a = trend + seasonal
    const b = trend + seasonal * 2
    const c = index < 48 ? a : a + 30
    lines.push(`2024-01-${String((index % 28) + 1).padStart(2, "0")},${a},${index === 10 ? "" : b},${c}`)
  }
  await writeFile(csvPath, `${lines.join("\n")}\n`, "utf8")
  return csvPath
}

async function json<T>(response: Response) {
  if (response.status !== 200) throw new Error(await response.text())
  return (await response.json()) as T
}

async function writeFakeNeoCastRunner(root: string) {
  await mkdir(path.join(root, "py"), { recursive: true })
  await writeFile(
    path.join(root, "py", "validate.py"),
    `#!/usr/bin/env bash
set -euo pipefail
mkdir -p .neo-cast/artifacts/run_fake
cat > .neo-cast/artifacts/run_fake/model_impl.py <<'PY'
class Model:
    pass
PY
cat > .neo-cast/artifacts/run_fake/inference.py <<'PY'
def predict(rows):
    return rows
PY
printf '{"event":"candidate_resolved"}\\n'
printf '{"event":"smoke_eval_done","val_avg_mse":0.123,"val_avg_mae":0.456}\\n'
printf '{"event":"artifact_ready","run_id":"fake","artifact_dir":"%s"}\\n' "$(pwd)/.neo-cast/artifacts/run_fake"
printf '{"event":"done","status":"success"}\\n'
`,
    "utf8",
  )
}

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
})

describe("research routes", () => {
  test("exposes TSF domain metadata, baselines, and candidate validation", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }
    const taskSpec = validTsfTaskSpec()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const domains = await json<Research.DomainInfo[]>(await app().request(ResearchPaths.domains, { headers }))
        expect(domains.map((item) => item.id)).toContain("tsf")

        const domain = await json<Research.DomainInfo>(
          await app().request(pathFor(ResearchPaths.domain, { domainID: "tsf" }), { headers }),
        )
        expect(domain.actionRegistry.embedding.patch.bridgeSupported).toBe(true)

        const baselines = await json<Research.DomainCandidateProposal[]>(
          await app().request(pathFor(ResearchPaths.domainBaselines, { domainID: "tsf" }), {
            method: "POST",
            headers,
            body: JSON.stringify({ taskSpec }),
          }),
        )
        expect(baselines).toHaveLength(3)

        const validation = await json<Research.DomainValidationResult>(
          await app().request(pathFor(ResearchPaths.domainValidateCandidate, { domainID: "tsf" }), {
            method: "POST",
            headers,
            body: JSON.stringify({
              taskSpec,
              candidateSpec: baselines[0]!.candidateSpec,
            }),
          }),
        )
        expect(validation.ok).toBe(true)
        expect(validation.issues).toEqual([])

        const plan = await json<Research.DomainRunPlan>(
          await app().request(pathFor(ResearchPaths.domainRunPlan, { domainID: "tsf" }), {
            method: "POST",
            headers,
            body: JSON.stringify({
              taskSpec,
              candidateSpec: baselines[0]!.candidateSpec,
              stage: "smoke",
            }),
          }),
        )
        expect(plan.validation.ok).toBe(true)
        expect(plan.writes[0]!.path).toBe(".neo-cast/current_candidate.json")
        expect(plan.writes[0]!.content.recipe_version).toBe("recipe_schema_v1")
      },
    })
  })

  test("normalizes TSF task specs through the domain plugin", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "TSF normalized task",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 3 },
            }),
          }),
        )

        expect(task.taskSpec.taskType).toBe("forecasting")
        expect(task.taskSpec.runtime).toEqual({
          bridgeOnly: true,
          pythonExecutable: "python3",
          currentCandidatePath: ".neo-cast/current_candidate.json",
          resolvedCandidatePath: ".neo-cast/resolved_candidate.json",
          artifactsDir: ".neo-cast/artifacts",
        })

        const fingerprint = await json<Research.JsonRecord>(
          await app().request(pathFor(ResearchPaths.taskFingerprint, { taskID: task.id }), { headers }),
        )
        expect(fingerprint).toMatchObject({
          taskType: "forecasting",
          loaderID: "etth1_tslib_v1",
          targetCount: 1,
          contextLength: 96,
          maxPredictionLength: 24,
          horizonContextRatio: 0.25,
          bridgeOnly: true,
        })
      },
    })
  })

  test("updates a task spec through an explicit repair route", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "Repair Neo-Cast root",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 3 },
            }),
          }),
        )

        const taskSpec = {
          ...task.taskSpec,
          runtime: {
            ...(task.taskSpec.runtime as Record<string, unknown>),
            neoCastProjectRoot: tmp.path,
          },
        }

        const updated = await json<Research.ResearchTask>(
          await app().request(pathFor(ResearchPaths.taskSpec, { taskID: task.id }), {
            method: "PATCH",
            headers,
            body: JSON.stringify({ taskSpec }),
          }),
        )

        expect(updated.id).toBe(task.id)
        expect(updated.taskSpec.runtime).toMatchObject({
          bridgeOnly: true,
          pythonExecutable: "python3",
          neoCastProjectRoot: tmp.path,
        })
        expect(updated.taskSpec.taskType).toBe("forecasting")
        expect(updated.time.updated).toBeGreaterThanOrEqual(task.time.updated)

        const fetched = await json<Research.ResearchTask>(
          await app().request(pathFor(ResearchPaths.task, { taskID: task.id }), { headers }),
        )
        expect(fetched.taskSpec.runtime).toMatchObject({ neoCastProjectRoot: tmp.path })
      },
    })
  })

  test("profiles a task through an explicit diagnostic route", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }
    const datasetPath = await writeProfileDataset()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "Profile TSF task",
              domainID: "tsf",
              mode: "review",
              taskSpec: {
                contextLength: 96,
                predictionLengths: [24],
                dataset: {
                  loaderID: "local_csv",
                  path: datasetPath,
                  targetCols: ["a", "b", "c"],
                },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 3 },
            }),
          }),
        )

        const profile = await json<Research.ProfileTaskResult>(
          await app().request(pathFor(ResearchPaths.taskProfile, { taskID: task.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ outputDir: ".neo-research/profile" }),
          }),
        )

        expect(profile.fingerprint.datasetProfile).toMatchObject({
          rowCount: 96,
          targetCount: 3,
        })
        expect(profile.run.stage).toBe("profile")
        expect(profile.run.status).toBe("succeeded")
        expect(profile.run.candidateID).toBeUndefined()
        expect(profile.artifact.kind).toBe("task_profile_json")
        expect(profile.artifact.runID).toBe(profile.run.id)
      },
    })
  })

  test("rejects candidate specs outside the task domain action registry", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "TSF strict candidate task",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 3 },
            }),
          }),
        )

        const response = await app().request(ResearchPaths.candidates, {
          method: "POST",
          headers,
          body: JSON.stringify({
            taskID: task.id,
            domainID: "tsf",
            candidateSpec: { approach: "seasonal-naive" },
            rationale: "This bypasses the action registry.",
            riskLevel: "low",
            approvalStatus: "pending",
            generatedBy: "human",
          }),
        })
        expect(response.status).toBe(400)
        const body = (await response.json()) as { name: string; data: { issues: Array<{ path: string }> } }
        expect(body.name).toBe("ResearchCandidateValidationError")
        expect(body.data.issues.map((item) => item.path)).toContain("recipeVersion")

        const candidates = await json<Research.ResearchCandidate[]>(
          await app().request(pathFor(ResearchPaths.taskCandidates, { taskID: task.id }), { headers }),
        )
        expect(candidates).toHaveLength(0)
      },
    })
  })

  test("direct run creation requires an approved candidate", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "TSF direct run approval",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 3 },
            }),
          }),
        )
        const seeded = await json<{
          candidates: Research.ResearchCandidate[]
          approvals: Research.ResearchApproval[]
        }>(
          await app().request(pathFor(ResearchPaths.taskBaselines, { taskID: task.id }), {
            method: "POST",
            headers,
          }),
        )

        const response = await app().request(ResearchPaths.runs, {
          method: "POST",
          headers,
          body: JSON.stringify({
            taskID: task.id,
            candidateID: seeded.candidates[0]!.id,
            stage: "smoke",
            status: "queued",
          }),
        })
        expect(response.status).toBe(400)
        const body = (await response.json()) as { name: string; data: { kind: string; candidateID: string } }
        expect(body.name).toBe("ResearchApprovalRequiredError")
        expect(body.data).toMatchObject({ kind: "candidate", candidateID: seeded.candidates[0]!.id })
      },
    })
  })

  test("direct ref_test run creation requires an approved ref_test gate", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "TSF direct ref test gate",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 3 },
            }),
          }),
        )
        const seeded = await json<{
          candidates: Research.ResearchCandidate[]
          approvals: Research.ResearchApproval[]
        }>(
          await app().request(pathFor(ResearchPaths.taskBaselines, { taskID: task.id }), {
            method: "POST",
            headers,
          }),
        )
        const candidate = seeded.candidates[0]!

        await json<Research.ResearchApproval>(
          await app().request(pathFor(ResearchPaths.approvalReply, { approvalID: seeded.approvals[0]!.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ status: "approved" }),
          }),
        )

        const blocked = await app().request(ResearchPaths.runs, {
          method: "POST",
          headers,
          body: JSON.stringify({
            taskID: task.id,
            candidateID: candidate.id,
            stage: "ref_test",
            status: "queued",
          }),
        })
        expect(blocked.status).toBe(400)
        const body = (await blocked.json()) as { name: string; data: { kind: string; candidateID: string } }
        expect(body.name).toBe("ResearchApprovalRequiredError")
        expect(body.data).toMatchObject({ kind: "ref_test", candidateID: candidate.id })

        const gate = await json<Research.ResearchApproval>(
          await app().request(ResearchPaths.approvals, {
            method: "POST",
            headers,
            body: JSON.stringify({
              taskID: task.id,
              candidateID: candidate.id,
              kind: "ref_test",
              reason: "Allow direct reference test record.",
            }),
          }),
        )
        await json<Research.ResearchApproval>(
          await app().request(pathFor(ResearchPaths.approvalReply, { approvalID: gate.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ status: "approved" }),
          }),
        )

        const run = await json<Research.ResearchRun>(
          await app().request(ResearchPaths.runs, {
            method: "POST",
            headers,
            body: JSON.stringify({
              taskID: task.id,
              candidateID: candidate.id,
              stage: "ref_test",
              status: "queued",
            }),
          }),
        )
        expect(run.stage).toBe("ref_test")
      },
    })
  })

  test("seeds review baselines and prepares an approved candidate run", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeFakeNeoCastRunner(fakeNeoCastRoot)

        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "TSF review baseline workflow",
              domainID: "tsf",
              mode: "review",
              taskSpec: {
                ...validTsfTaskSpec(),
                runtime: {
                  bridgeOnly: true,
                  neoCastProjectRoot: fakeNeoCastRoot,
                  pythonExecutable: "bash",
                },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12 },
            }),
          }),
        )

        const seeded = await json<{
          candidates: Research.ResearchCandidate[]
          approvals: Research.ResearchApproval[]
        }>(
          await app().request(pathFor(ResearchPaths.taskBaselines, { taskID: task.id }), {
            method: "POST",
            headers,
          }),
        )
        expect(seeded.candidates).toHaveLength(3)
        expect(seeded.approvals).toHaveLength(3)

        const approved = await json<Research.ResearchApproval>(
          await app().request(pathFor(ResearchPaths.approvalReply, { approvalID: seeded.approvals[0]!.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ status: "approved" }),
          }),
        )
        expect(approved.status).toBe("approved")

        const prepared = await json<{ run: Research.ResearchRun; runPlan: Research.DomainRunPlan }>(
          await app().request(
            pathFor(ResearchPaths.taskCandidatePrepareRun, {
              taskID: task.id,
              candidateID: seeded.candidates[0]!.id,
            }),
            {
              method: "POST",
              headers,
              body: JSON.stringify({ stage: "smoke", description: "approved baseline smoke run" }),
            },
          ),
        )
        expect(prepared.run.status).toBe("queued")
        expect(prepared.runPlan.validation.ok).toBe(true)

        const researching = await json<Research.ResearchTask>(
          await app().request(pathFor(ResearchPaths.task, { taskID: task.id }), { headers }),
        )
        expect(researching.status).toBe("researching")

        const executed = await json<{ run: Research.ResearchRun; runPlan: Research.DomainRunPlan }>(
          await app().request(
            pathFor(ResearchPaths.taskCandidateExecuteRun, {
              taskID: task.id,
              candidateID: seeded.candidates[0]!.id,
            }),
            {
              method: "POST",
              headers,
              body: JSON.stringify({ stage: "smoke", description: "execute approved baseline smoke run" }),
            },
          ),
        )
        expect(executed.run.status).toBe("succeeded")
        expect(executed.run.metrics.val_avg_mse).toBe(0.123)

        const sweep = await json<Research.SeedSweepResult>(
          await app().request(
            pathFor(ResearchPaths.taskCandidateSeedSweep, {
              taskID: task.id,
              candidateID: seeded.candidates[0]!.id,
            }),
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                stage: "smoke",
                description: "execute approved baseline seed sweep",
                seeds: [2, 4],
              }),
            },
          ),
        )
        expect(sweep.seeds).toEqual([2, 4])
        expect(sweep.runs.map((item) => item.run.status)).toEqual(["succeeded", "succeeded"])
        expect(sweep.runs.map((item) => item.run.resourceUsage.seed)).toEqual([2, 4])
      },
    })
  })

  test("baseline seeding is idempotent by recipe id", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "TSF baseline idempotency",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12 },
            }),
          }),
        )

        const first = await json<{
          candidates: Research.ResearchCandidate[]
          approvals: Research.ResearchApproval[]
        }>(
          await app().request(pathFor(ResearchPaths.taskBaselines, { taskID: task.id }), {
            method: "POST",
            headers,
          }),
        )
        const second = await json<{
          candidates: Research.ResearchCandidate[]
          approvals: Research.ResearchApproval[]
        }>(
          await app().request(pathFor(ResearchPaths.taskBaselines, { taskID: task.id }), {
            method: "POST",
            headers,
          }),
        )

        expect(first.candidates).toHaveLength(3)
        expect(first.approvals).toHaveLength(3)
        expect(second.candidates).toHaveLength(0)
        expect(second.approvals).toHaveLength(0)

        const candidates = await json<Research.ResearchCandidate[]>(
          await app().request(pathFor(ResearchPaths.taskCandidates, { taskID: task.id }), { headers }),
        )
        const approvals = await json<Research.ResearchApproval[]>(
          await app().request(pathFor(ResearchPaths.taskApprovals, { taskID: task.id }), { headers }),
        )
        expect(candidates).toHaveLength(3)
        expect(approvals).toHaveLength(3)
      },
    })
  })

  test("runs one autonomous iteration", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeFakeNeoCastRunner(fakeNeoCastRoot)

        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "TSF autonomous iteration",
              domainID: "tsf",
              mode: "autonomous",
              taskSpec: {
                ...validTsfTaskSpec(),
                runtime: {
                  bridgeOnly: true,
                  neoCastProjectRoot: fakeNeoCastRoot,
                  pythonExecutable: "bash",
                },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12 },
            }),
          }),
        )

        const iteration = await json<{
          candidate: Research.ResearchCandidate
          seededCandidates: Research.ResearchCandidate[]
          approvals: Research.ResearchApproval[]
          run: Research.ResearchRun
          runPlan: Research.DomainRunPlan
          managerTrace: Research.ResearchManagerTraceStep[]
        }>(
          await app().request(pathFor(ResearchPaths.taskAutonomousIterate, { taskID: task.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ stage: "smoke", description: "autonomous route smoke" }),
          }),
        )
        expect(iteration.seededCandidates).toHaveLength(3)
        expect(iteration.approvals).toHaveLength(0)
        expect(iteration.candidate.approvalStatus).toBe("auto_approved")
        expect(iteration.run.status).toBe("succeeded")
        expect(iteration.managerTrace.map((step) => step.role)).toEqual([
          "diagnostic",
          "design",
          "coder",
          "runner",
          "analyst",
          "librarian",
        ])

        const artifacts = await json<Research.ResearchArtifact[]>(
          await app().request(pathFor(ResearchPaths.taskArtifacts, { taskID: task.id }), { headers }),
        )
        const managerTraceArtifact = artifacts.find((artifact) => artifact.kind === "research_manager_trace_json")
        expect(managerTraceArtifact?.runID).toBe(iteration.run.id)
        expect(iteration.run.artifactRefs).toContain(managerTraceArtifact!.id)
        expect(managerTraceArtifact?.metadata).toMatchObject({
          candidateID: iteration.candidate.id,
          runID: iteration.run.id,
          stage: "smoke",
          roleCount: 6,
        })
        const managerTraceRecord = JSON.parse(await readFile(managerTraceArtifact!.uri.replace("file://", ""), "utf8"))
        expect(managerTraceRecord.managerTrace.map((step: { role: string }) => step.role)).toEqual([
          "diagnostic",
          "design",
          "coder",
          "runner",
          "analyst",
          "librarian",
        ])
      },
    })
  })

  test("runs an autonomous loop for multiple budgeted iterations", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeFakeNeoCastRunner(fakeNeoCastRoot)

        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "TSF autonomous loop",
              domainID: "tsf",
              mode: "autonomous",
              taskSpec: {
                ...validTsfTaskSpec(),
                runtime: {
                  bridgeOnly: true,
                  neoCastProjectRoot: fakeNeoCastRoot,
                  pythonExecutable: "bash",
                },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12, maxParallel: 1 },
            }),
          }),
        )

        const response = await app().request(`/research/tasks/${encodeURIComponent(task.id)}/autonomous/loop`, {
          method: "POST",
          headers,
          body: JSON.stringify({ stage: "smoke", maxIterations: 2, description: "autonomous loop smoke" }),
        })
        expect(response.status).toBe(200)
        const loop = (await response.json()) as {
          iterations: Array<{ candidate: Research.ResearchCandidate; run: Research.ResearchRun }>
          stoppedReason: string
          artifact: Research.ResearchArtifact
        }
        expect(loop.stoppedReason).toBe("max_iterations")
        expect(loop.iterations).toHaveLength(2)
        expect(loop.iterations.map((iteration) => iteration.run.status)).toEqual(["succeeded", "succeeded"])
        expect(loop.artifact.kind).toBe("research_autonomous_loop_json")
        expect(loop.artifact.metadata).toMatchObject({
          stoppedReason: "max_iterations",
          iterationCount: 2,
          succeededCount: 2,
        })

        const runs = await json<Research.ResearchRun[]>(
          await app().request(pathFor(ResearchPaths.taskRuns, { taskID: task.id }), { headers }),
        )
        expect(runs).toHaveLength(2)
        const loopRecord = JSON.parse(await readFile(loop.artifact.uri.replace("file://", ""), "utf8"))
        expect(loopRecord.iterations.map((iteration: { runID: string }) => iteration.runID)).toEqual(
          loop.iterations.map((iteration) => iteration.run.id),
        )
      },
    })
  })

  test("runs the multi-agent research pipeline through the API", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }
    const datasetPath = await writeProfileDataset()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeFakeNeoCastRunner(fakeNeoCastRoot)

        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "TSF pipeline route",
              domainID: "tsf",
              mode: "autonomous",
              taskSpec: {
                ...validTsfTaskSpec(),
                dataset: {
                  loaderID: "local_csv",
                  path: datasetPath,
                  targetCols: ["a", "b", "c"],
                },
                runtime: {
                  bridgeOnly: true,
                  neoCastProjectRoot: fakeNeoCastRoot,
                  pythonExecutable: "bash",
                },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12, maxParallel: 1 },
            }),
          }),
        )

        const response = await app().request(pathFor(ResearchPaths.taskPipeline, { taskID: task.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({
            stage: "smoke",
            maxIterations: 1,
            description: "api pipeline smoke",
            outputDir: ".neo-research/api-pipeline",
          }),
        })
        expect(response.status).toBe(200)
        const pipeline = (await response.json()) as Research.RunFullPipelineResult

        expect(pipeline.intent.taskID).toBe(task.id)
        expect(pipeline.dataAnalysis.artifact.kind).toBe("dataset_analysis_report")
        expect(pipeline.nas.loop.stoppedReason).toBe("max_iterations")
        expect(pipeline.publish.artifact.kind).toBe("model_export_package")
        expect(pipeline.task.status).toBe("completed")
      },
    })
  })

  test("pipeline API rejects review companion tasks without starting NAS", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }
    const datasetPath = await writeProfileDataset()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeFakeNeoCastRunner(fakeNeoCastRoot)

        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "TSF review pipeline route",
              domainID: "tsf",
              mode: "review",
              taskSpec: {
                ...validTsfTaskSpec(),
                dataset: {
                  loaderID: "local_csv",
                  path: datasetPath,
                  targetCols: ["a", "b", "c"],
                },
                runtime: {
                  bridgeOnly: true,
                  neoCastProjectRoot: fakeNeoCastRoot,
                  pythonExecutable: "bash",
                },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12, maxParallel: 1 },
            }),
          }),
        )

        const response = await app().request(pathFor(ResearchPaths.taskPipeline, { taskID: task.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({
            stage: "smoke",
            maxIterations: 1,
          }),
        })
        expect(response.status).toBe(500)
        const body = await response.json()
        expect(body).toMatchObject({
          name: "ResearchPipelineBlockedError",
          data: {
            taskID: task.id,
            reason: "pipeline_requires_autonomous",
          },
        })

        const runs = await json<Research.ResearchRun[]>(
          await app().request(pathFor(ResearchPaths.taskRuns, { taskID: task.id }), { headers }),
        )
        expect(runs).toHaveLength(0)
      },
    })
  })

  test("autonomous loop returns partial iterations when run budget is exhausted", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeFakeNeoCastRunner(fakeNeoCastRoot)

        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "TSF autonomous budget loop",
              domainID: "tsf",
              mode: "autonomous",
              taskSpec: {
                ...validTsfTaskSpec(),
                runtime: {
                  bridgeOnly: true,
                  neoCastProjectRoot: fakeNeoCastRoot,
                  pythonExecutable: "bash",
                },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 1, maxParallel: 1 },
            }),
          }),
        )

        const response = await app().request(`/research/tasks/${encodeURIComponent(task.id)}/autonomous/loop`, {
          method: "POST",
          headers,
          body: JSON.stringify({ stage: "smoke", maxIterations: 3, description: "autonomous loop budget" }),
        })
        expect(response.status).toBe(200)
        const loop = (await response.json()) as {
          iterations: Array<{ run: Research.ResearchRun }>
          stoppedReason: string
        }
        expect(loop.stoppedReason).toBe("budget_exhausted")
        expect(loop.iterations).toHaveLength(1)
        expect(loop.iterations[0]?.run.status).toBe("succeeded")
      },
    })
  })

  test("autonomous loop stops when candidate approval is required", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeFakeNeoCastRunner(fakeNeoCastRoot)
        const taskSpec = {
          ...validTsfTaskSpec(),
          runtime: {
            bridgeOnly: true,
            neoCastProjectRoot: fakeNeoCastRoot,
            pythonExecutable: "bash",
          },
        }
        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "TSF autonomous approval loop",
              domainID: "tsf",
              mode: "autonomous",
              taskSpec,
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12, maxParallel: 1 },
            }),
          }),
        )
        const baselines = await json<Research.DomainCandidateProposal[]>(
          await app().request(pathFor(ResearchPaths.domainBaselines, { domainID: "tsf" }), {
            method: "POST",
            headers,
            body: JSON.stringify({ taskSpec }),
          }),
        )
        await json<Research.ResearchCandidate>(
          await app().request(ResearchPaths.candidates, {
            method: "POST",
            headers,
            body: JSON.stringify({
              taskID: task.id,
              domainID: "tsf",
              candidateSpec: baselines[0]!.candidateSpec,
              rationale: "approval required candidate",
              riskLevel: "medium",
              approvalStatus: "pending",
              generatedBy: "llm",
            }),
          }),
        )

        const response = await app().request(pathFor(ResearchPaths.taskAutonomousLoop, { taskID: task.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({ stage: "smoke", maxIterations: 3, description: "autonomous approval loop" }),
        })
        expect(response.status).toBe(200)
        const loop = (await response.json()) as {
          iterations: Array<{ run: Research.ResearchRun }>
          stoppedReason: string
        }
        expect(loop.stoppedReason).toBe("approval_required")
        expect(loop.iterations).toHaveLength(0)

        const runs = await json<Research.ResearchRun[]>(
          await app().request(pathFor(ResearchPaths.taskRuns, { taskID: task.id }), { headers }),
        )
        expect(runs).toHaveLength(0)
      },
    })
  })

  test("TSF evaluator uses taskSpec evaluation metric when objective omits primaryMetric", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeFakeNeoCastRunner(fakeNeoCastRoot)

        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "TSF domain evaluator",
              domainID: "tsf",
              mode: "autonomous",
              taskSpec: {
                ...validTsfTaskSpec(),
                evaluation: { protocol: "fixed_split", metricPrimary: "val_avg_mae", seeds: [42] },
                runtime: {
                  bridgeOnly: true,
                  neoCastProjectRoot: fakeNeoCastRoot,
                  pythonExecutable: "bash",
                },
              },
              objective: { direction: "minimize" },
              budget: { maxRuns: 3 },
            }),
          }),
        )

        const iteration = await json<{ run: Research.ResearchRun }>(
          await app().request(pathFor(ResearchPaths.taskAutonomousIterate, { taskID: task.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ stage: "smoke", description: "domain evaluator smoke" }),
          }),
        )
        expect(iteration.run.metrics).toMatchObject({ val_avg_mse: 0.123, val_avg_mae: 0.456 })

        const champion = await json<Research.ResearchChampion | null>(
          await app().request(pathFor(ResearchPaths.taskChampion, { taskID: task.id }), { headers }),
        )
        expect(champion?.primaryMetric).toBe(0.456)

        const memory = await json<Research.ResearchMemory[]>(
          await app().request(pathFor(ResearchPaths.taskMemory, { taskID: task.id }), { headers }),
        )
        expect(memory[0]?.fingerprintSummary.primaryMetricName).toBe("val_avg_mae")
      },
    })
  })

  test("run status updates evaluate champion and memory", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "TSF external runner evaluation",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 3 },
            }),
          }),
        )
        const seeded = await json<{
          candidates: Research.ResearchCandidate[]
          approvals: Research.ResearchApproval[]
        }>(
          await app().request(pathFor(ResearchPaths.taskBaselines, { taskID: task.id }), {
            method: "POST",
            headers,
          }),
        )
        const candidate = seeded.candidates[0]!

        await json<Research.ResearchApproval>(
          await app().request(pathFor(ResearchPaths.approvalReply, { approvalID: seeded.approvals[0]!.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ status: "approved" }),
          }),
        )

        const run = await json<Research.ResearchRun>(
          await app().request(ResearchPaths.runs, {
            method: "POST",
            headers,
            body: JSON.stringify({
              taskID: task.id,
              candidateID: candidate.id,
              stage: "smoke",
              status: "running",
            }),
          }),
        )

        await json<Research.ResearchRun>(
          await app().request(pathFor(ResearchPaths.runStatus, { runID: run.id }), {
            method: "PATCH",
            headers,
            body: JSON.stringify({ status: "succeeded", metrics: { val_avg_mse: 0.111 } }),
          }),
        )

        const champion = await json<Research.ResearchChampion | null>(
          await app().request(pathFor(ResearchPaths.taskChampion, { taskID: task.id }), { headers }),
        )
        expect(champion).toMatchObject({
          candidateID: candidate.id,
          runID: run.id,
          primaryMetric: 0.111,
        })

        const memory = await json<Research.ResearchMemory[]>(
          await app().request(pathFor(ResearchPaths.taskMemory, { taskID: task.id }), { headers }),
        )
        expect(memory).toHaveLength(1)
        expect(memory[0]!.candidateSummary).toMatchObject({ runID: run.id, primaryMetric: 0.111 })
      },
    })
  })

  test("direct succeeded run creation evaluates champion and memory", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "TSF direct succeeded run evaluation",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 3 },
            }),
          }),
        )
        const seeded = await json<{
          candidates: Research.ResearchCandidate[]
          approvals: Research.ResearchApproval[]
        }>(
          await app().request(pathFor(ResearchPaths.taskBaselines, { taskID: task.id }), {
            method: "POST",
            headers,
          }),
        )
        const candidate = seeded.candidates[0]!

        await json<Research.ResearchApproval>(
          await app().request(pathFor(ResearchPaths.approvalReply, { approvalID: seeded.approvals[0]!.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ status: "approved" }),
          }),
        )

        const run = await json<Research.ResearchRun>(
          await app().request(ResearchPaths.runs, {
            method: "POST",
            headers,
            body: JSON.stringify({
              taskID: task.id,
              candidateID: candidate.id,
              stage: "smoke",
              status: "succeeded",
              metrics: { val_avg_mse: 0.109 },
            }),
          }),
        )

        const champion = await json<Research.ResearchChampion | null>(
          await app().request(pathFor(ResearchPaths.taskChampion, { taskID: task.id }), { headers }),
        )
        expect(champion).toMatchObject({
          candidateID: candidate.id,
          runID: run.id,
          primaryMetric: 0.109,
        })

        const memory = await json<Research.ResearchMemory[]>(
          await app().request(pathFor(ResearchPaths.taskMemory, { taskID: task.id }), { headers }),
        )
        expect(memory).toHaveLength(1)
        expect(memory[0]!.lesson).toContain(`Candidate ${candidate.id} became champion`)
      },
    })
  })

  test("failed run status updates create failed research memory", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "TSF failed runner memory",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 3 },
            }),
          }),
        )
        const seeded = await json<{
          candidates: Research.ResearchCandidate[]
          approvals: Research.ResearchApproval[]
        }>(
          await app().request(pathFor(ResearchPaths.taskBaselines, { taskID: task.id }), {
            method: "POST",
            headers,
          }),
        )
        const candidate = seeded.candidates[0]!

        await json<Research.ResearchApproval>(
          await app().request(pathFor(ResearchPaths.approvalReply, { approvalID: seeded.approvals[0]!.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ status: "approved" }),
          }),
        )

        const run = await json<Research.ResearchRun>(
          await app().request(ResearchPaths.runs, {
            method: "POST",
            headers,
            body: JSON.stringify({
              taskID: task.id,
              candidateID: candidate.id,
              stage: "smoke",
              status: "running",
            }),
          }),
        )

        await json<Research.ResearchRun>(
          await app().request(pathFor(ResearchPaths.runStatus, { runID: run.id }), {
            method: "PATCH",
            headers,
            body: JSON.stringify({ status: "failed", error: "bridge timeout" }),
          }),
        )

        const memory = await json<Research.ResearchMemory[]>(
          await app().request(pathFor(ResearchPaths.taskMemory, { taskID: task.id }), { headers }),
        )
        expect(memory).toHaveLength(1)
        expect(memory[0]).toMatchObject({
          outcome: "failed",
          lesson: `Candidate ${candidate.id} failed during smoke: bridge timeout`,
        })
        expect(memory[0]!.candidateSummary).toMatchObject({ runID: run.id, status: "failed" })
      },
    })
  })

  test("direct failed run creation creates failed research memory", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "TSF direct failed runner memory",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 3 },
            }),
          }),
        )
        const seeded = await json<{
          candidates: Research.ResearchCandidate[]
          approvals: Research.ResearchApproval[]
        }>(
          await app().request(pathFor(ResearchPaths.taskBaselines, { taskID: task.id }), {
            method: "POST",
            headers,
          }),
        )
        const candidate = seeded.candidates[0]!

        await json<Research.ResearchApproval>(
          await app().request(pathFor(ResearchPaths.approvalReply, { approvalID: seeded.approvals[0]!.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ status: "approved" }),
          }),
        )

        const run = await json<Research.ResearchRun>(
          await app().request(ResearchPaths.runs, {
            method: "POST",
            headers,
            body: JSON.stringify({
              taskID: task.id,
              candidateID: candidate.id,
              stage: "smoke",
              status: "failed",
            }),
          }),
        )

        const memory = await json<Research.ResearchMemory[]>(
          await app().request(pathFor(ResearchPaths.taskMemory, { taskID: task.id }), { headers }),
        )
        expect(memory).toHaveLength(1)
        expect(memory[0]).toMatchObject({
          outcome: "failed",
          lesson: `Candidate ${candidate.id} failed during smoke: failed`,
        })
        expect(memory[0]!.candidateSummary).toMatchObject({ runID: run.id, status: "failed" })
      },
    })
  })

  test("autonomous iteration proposes a modular frontier recipe after seeded candidates are exhausted", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeFakeNeoCastRunner(fakeNeoCastRoot)

        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "TSF autonomous mutation",
              domainID: "tsf",
              mode: "autonomous",
              taskSpec: {
                ...validTsfTaskSpec(),
                runtime: {
                  bridgeOnly: true,
                  neoCastProjectRoot: fakeNeoCastRoot,
                  pythonExecutable: "bash",
                },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12 },
            }),
          }),
        )

        for (let index = 0; index < 3; index++) {
          await json<{
            candidate: Research.ResearchCandidate
            run: Research.ResearchRun
          }>(
            await app().request(pathFor(ResearchPaths.taskAutonomousIterate, { taskID: task.id }), {
              method: "POST",
              headers,
              body: JSON.stringify({ stage: "smoke", description: `baseline ${index}` }),
            }),
          )
        }

        const iteration = await json<{
          candidate: Research.ResearchCandidate
          seededCandidates: Research.ResearchCandidate[]
          run: Research.ResearchRun
        }>(
          await app().request(pathFor(ResearchPaths.taskAutonomousIterate, { taskID: task.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ stage: "smoke", description: "mutation after baselines" }),
          }),
        )

        expect(iteration.seededCandidates).toHaveLength(0)
        expect(iteration.candidate.generatedBy).toBe("mutation")
        expect(iteration.candidate.approvalStatus).toBe("auto_approved")
        expect(iteration.candidate.candidateSpec.recipeID).toBe("tsf_bridge_patch_mlp_wide_adamw")
        expect(iteration.run.status).toBe("succeeded")

        const candidates = await json<Research.ResearchCandidate[]>(
          await app().request(pathFor(ResearchPaths.taskCandidates, { taskID: task.id }), { headers }),
        )
        expect(candidates).toHaveLength(4)
      },
    })
  })

  test("autonomous iteration stops when maxRuns budget is exhausted", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fakeNeoCastRoot = path.join(tmp.path, "fake-neo-cast")
        await writeFakeNeoCastRunner(fakeNeoCastRoot)

        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "TSF autonomous budget",
              domainID: "tsf",
              mode: "autonomous",
              taskSpec: {
                ...validTsfTaskSpec(),
                runtime: {
                  bridgeOnly: true,
                  neoCastProjectRoot: fakeNeoCastRoot,
                  pythonExecutable: "bash",
                },
              },
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 1 },
            }),
          }),
        )

        const first = await json<{ run: Research.ResearchRun }>(
          await app().request(pathFor(ResearchPaths.taskAutonomousIterate, { taskID: task.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ stage: "smoke", description: "first budgeted run" }),
          }),
        )
        expect(first.run.status).toBe("succeeded")

        const response = await app().request(pathFor(ResearchPaths.taskAutonomousIterate, { taskID: task.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({ stage: "smoke", description: "over budget run" }),
        })
        expect(response.status).toBe(400)
        const body = (await response.json()) as { name: string; data: { limit: number; used: number } }
        expect(body.name).toBe("ResearchBudgetExceededError")
        expect(body.data).toMatchObject({ limit: 1, used: 1 })

        const runs = await json<Research.ResearchRun[]>(
          await app().request(pathFor(ResearchPaths.taskRuns, { taskID: task.id }), { headers }),
        )
        expect(runs).toHaveLength(1)
      },
    })
  })

  test("prepare-run enforces maxParallel active run budget", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "TSF parallel budget",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 5, maxParallel: 1 },
            }),
          }),
        )

        const seeded = await json<{
          candidates: Research.ResearchCandidate[]
          approvals: Research.ResearchApproval[]
        }>(
          await app().request(pathFor(ResearchPaths.taskBaselines, { taskID: task.id }), {
            method: "POST",
            headers,
          }),
        )

        for (const approval of seeded.approvals.slice(0, 2)) {
          await json<Research.ResearchApproval>(
            await app().request(pathFor(ResearchPaths.approvalReply, { approvalID: approval.id }), {
              method: "POST",
              headers,
              body: JSON.stringify({ status: "approved" }),
            }),
          )
        }

        const first = await json<{ run: Research.ResearchRun }>(
          await app().request(
            pathFor(ResearchPaths.taskCandidatePrepareRun, {
              taskID: task.id,
              candidateID: seeded.candidates[0]!.id,
            }),
            {
              method: "POST",
              headers,
              body: JSON.stringify({ stage: "smoke", description: "first active run" }),
            },
          ),
        )
        expect(first.run.status).toBe("queued")

        const blocked = await app().request(
          pathFor(ResearchPaths.taskCandidatePrepareRun, {
            taskID: task.id,
            candidateID: seeded.candidates[1]!.id,
          }),
          {
            method: "POST",
            headers,
            body: JSON.stringify({ stage: "smoke", description: "second active run" }),
          },
        )
        expect(blocked.status).toBe(400)
        const body = (await blocked.json()) as { name: string; data: { limit: number; used: number } }
        expect(body.name).toBe("ResearchBudgetExceededError")
        expect(body.data).toMatchObject({ limit: 1, used: 1 })

        await json<Research.ResearchRun>(
          await app().request(pathFor(ResearchPaths.runStatus, { runID: first.run.id }), {
            method: "PATCH",
            headers,
            body: JSON.stringify({ status: "succeeded", metrics: { val_avg_mse: 0.2 } }),
          }),
        )

        const released = await json<{ run: Research.ResearchRun }>(
          await app().request(
            pathFor(ResearchPaths.taskCandidatePrepareRun, {
              taskID: task.id,
              candidateID: seeded.candidates[1]!.id,
            }),
            {
              method: "POST",
              headers,
              body: JSON.stringify({ stage: "smoke", description: "second released run" }),
            },
          ),
        )
        expect(released.run.status).toBe("queued")
      },
    })
  })

  test("autonomous iteration does not create proposal candidates when maxParallel is full", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "TSF autonomous parallel budget",
              domainID: "tsf",
              mode: "autonomous",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 12, maxParallel: 1 },
            }),
          }),
        )

        const seeded = await json<{
          candidates: Research.ResearchCandidate[]
          approvals: Research.ResearchApproval[]
        }>(
          await app().request(pathFor(ResearchPaths.taskBaselines, { taskID: task.id }), {
            method: "POST",
            headers,
          }),
        )
        expect(seeded.candidates).toHaveLength(3)

        for (const [index, candidate] of seeded.candidates.entries()) {
          await json<Research.ResearchRun>(
            await app().request(ResearchPaths.runs, {
              method: "POST",
              headers,
              body: JSON.stringify({
                taskID: task.id,
                candidateID: candidate.id,
                stage: "smoke",
                status: index === 2 ? "queued" : "succeeded",
                metrics: index === 2 ? {} : { val_avg_mse: 0.3 + index / 10 },
              }),
            }),
          )
        }

        const response = await app().request(pathFor(ResearchPaths.taskAutonomousIterate, { taskID: task.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({ stage: "smoke", description: "parallel full mutation" }),
        })
        expect(response.status).toBe(400)
        const body = (await response.json()) as { name: string; data: { limit: number; used: number } }
        expect(body.name).toBe("ResearchBudgetExceededError")
        expect(body.data).toMatchObject({ limit: 1, used: 1 })

        const candidates = await json<Research.ResearchCandidate[]>(
          await app().request(pathFor(ResearchPaths.taskCandidates, { taskID: task.id }), { headers }),
        )
        expect(candidates).toHaveLength(3)
      },
    })
  })

  test("ref_test candidate runs require an approved ref_test gate", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "TSF ref test gate",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 3 },
            }),
          }),
        )

        const seeded = await json<{
          candidates: Research.ResearchCandidate[]
          approvals: Research.ResearchApproval[]
        }>(
          await app().request(pathFor(ResearchPaths.taskBaselines, { taskID: task.id }), {
            method: "POST",
            headers,
          }),
        )
        const candidate = seeded.candidates[0]!

        await json<Research.ResearchApproval>(
          await app().request(pathFor(ResearchPaths.approvalReply, { approvalID: seeded.approvals[0]!.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ status: "approved" }),
          }),
        )

        const blocked = await app().request(
          pathFor(ResearchPaths.taskCandidatePrepareRun, {
            taskID: task.id,
            candidateID: candidate.id,
          }),
          {
            method: "POST",
            headers,
            body: JSON.stringify({ stage: "ref_test", description: "blind ref test" }),
          },
        )
        expect(blocked.status).toBe(400)
        const blockedBody = (await blocked.json()) as {
          name: string
          data: { kind: string; candidateID: string }
        }
        expect(blockedBody.name).toBe("ResearchApprovalRequiredError")
        expect(blockedBody.data).toMatchObject({ kind: "ref_test", candidateID: candidate.id })

        const gate = await json<Research.ResearchApproval>(
          await app().request(ResearchPaths.approvals, {
            method: "POST",
            headers,
            body: JSON.stringify({
              taskID: task.id,
              candidateID: candidate.id,
              kind: "ref_test",
              reason: "Allow one blind ref test.",
            }),
          }),
        )
        await json<Research.ResearchApproval>(
          await app().request(pathFor(ResearchPaths.approvalReply, { approvalID: gate.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ status: "approved" }),
          }),
        )

        const prepared = await json<{ run: Research.ResearchRun; runPlan: Research.DomainRunPlan }>(
          await app().request(
            pathFor(ResearchPaths.taskCandidatePrepareRun, {
              taskID: task.id,
              candidateID: candidate.id,
            }),
            {
              method: "POST",
              headers,
              body: JSON.stringify({ stage: "ref_test", description: "approved blind ref test" }),
            },
          ),
        )
        expect(prepared.run.stage).toBe("ref_test")
        expect(prepared.runPlan.approvalRequired).toBe(true)
      },
    })
  })

  test("exports a research task report through the API", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "TSF export route",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 3 },
            }),
          }),
        )
        const baselines = await json<Research.DomainCandidateProposal[]>(
          await app().request(pathFor(ResearchPaths.domainBaselines, { domainID: "tsf" }), {
            method: "POST",
            headers,
            body: JSON.stringify({ taskSpec: task.taskSpec }),
          }),
        )
        const candidate = await json<Research.ResearchCandidate>(
          await app().request(ResearchPaths.candidates, {
            method: "POST",
            headers,
            body: JSON.stringify({
              taskID: task.id,
              domainID: "tsf",
              candidateSpec: baselines[0]!.candidateSpec,
              rationale: "Route export smoke candidate.",
              riskLevel: "low",
              approvalStatus: "auto_approved",
              generatedBy: "heuristic",
            }),
          }),
        )
        const run = await json<Research.ResearchRun>(
          await app().request(ResearchPaths.runs, {
            method: "POST",
            headers,
            body: JSON.stringify({
              taskID: task.id,
              candidateID: candidate.id,
              stage: "smoke",
              status: "succeeded",
              metrics: { val_avg_mse: 0.25 },
            }),
          }),
        )
        await json<Research.ResearchChampion>(
          await app().request(ResearchPaths.champions, {
            method: "POST",
            headers,
            body: JSON.stringify({
              taskID: task.id,
              candidateID: candidate.id,
              runID: run.id,
              primaryMetric: 0.25,
              utility: -0.25,
            }),
          }),
        )

        const exported = await json<Research.ExportTaskArtifactResult>(
          await app().request(pathFor(ResearchPaths.taskExport, { taskID: task.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({}),
          }),
        )

        expect(exported.artifact.kind).toBe("research_report_markdown")
        expect(exported.artifact.taskID).toBe(task.id)
        expect(exported.artifact.metadata).toMatchObject({ domainID: "tsf", exporter: "tsf-domain" })
        const report = await readFile(exported.path, "utf8")
        expect(report).toContain("TSF export route")
        expect(report).toContain("## TSF Recipe Summary")
      },
    })
  })

  test("creates and reads research task resources", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await json<Research.ResearchTask>(
          await app().request(ResearchPaths.tasks, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "TSF review task",
              domainID: "tsf",
              mode: "review",
              taskSpec: validTsfTaskSpec(),
              objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
              budget: { maxRuns: 3 },
            }),
          }),
        )
        expect(task.id.startsWith("rtsk_")).toBe(true)

        const tasks = await json<Research.ResearchTask[]>(
          await app().request(`${ResearchPaths.tasks}?domainID=tsf`, { headers }),
        )
        expect(tasks.map((item) => item.id)).toContain(task.id)

        const updated = await json<Research.ResearchTask>(
          await app().request(pathFor(ResearchPaths.taskStatus, { taskID: task.id }), {
            method: "PATCH",
            headers,
            body: JSON.stringify({ status: "researching" }),
          }),
        )
        expect(updated.status).toBe("researching")

        const baselines = await json<Research.DomainCandidateProposal[]>(
          await app().request(pathFor(ResearchPaths.domainBaselines, { domainID: "tsf" }), {
            method: "POST",
            headers,
            body: JSON.stringify({ taskSpec: task.taskSpec }),
          }),
        )
        const candidate = await json<Research.ResearchCandidate>(
          await app().request(ResearchPaths.candidates, {
            method: "POST",
            headers,
            body: JSON.stringify({
              taskID: task.id,
              domainID: "tsf",
              candidateSpec: baselines[0]!.candidateSpec,
              rationale: "Simple baseline for review.",
              riskLevel: "low",
              approvalStatus: "pending",
              generatedBy: "human",
            }),
          }),
        )
        expect(candidate.taskID).toBe(task.id)

        const approval = await json<Research.ResearchApproval>(
          await app().request(ResearchPaths.approvals, {
            method: "POST",
            headers,
            body: JSON.stringify({
              taskID: task.id,
              candidateID: candidate.id,
              kind: "candidate",
              reason: "Review Mode requires a human decision before execution.",
            }),
          }),
        )
        expect(approval.status).toBe("pending")

        const approvals = await json<Research.ResearchApproval[]>(
          await app().request(`${pathFor(ResearchPaths.taskApprovals, { taskID: task.id })}?status=pending`, {
            headers,
          }),
        )
        expect(approvals.map((item) => item.id)).toContain(approval.id)

        const approved = await json<Research.ResearchApproval>(
          await app().request(pathFor(ResearchPaths.approvalReply, { approvalID: approval.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({
              status: "approved",
              replyMessage: "Approved for smoke run.",
            }),
          }),
        )
        expect(approved.status).toBe("approved")

        const run = await json<Research.ResearchRun>(
          await app().request(ResearchPaths.runs, {
            method: "POST",
            headers,
            body: JSON.stringify({
              taskID: task.id,
              candidateID: candidate.id,
              stage: "smoke",
              status: "running",
              metrics: {},
              resourceUsage: {},
              artifactRefs: [],
            }),
          }),
        )
        expect(run.candidateID).toBe(candidate.id)

        const champion = await json<Research.ResearchChampion>(
          await app().request(ResearchPaths.champions, {
            method: "POST",
            headers,
            body: JSON.stringify({
              taskID: task.id,
              candidateID: candidate.id,
              runID: run.id,
              primaryMetric: 0.12,
              utility: 0.88,
            }),
          }),
        )
        expect(champion.taskID).toBe(task.id)
      },
    })
  })
})
