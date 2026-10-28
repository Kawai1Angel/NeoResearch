import { afterEach, expect } from "bun:test"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { rm } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { Research } from "../../src/research"
import { resumeState } from "../../src/research/recovery"
import { Database, eq } from "../../src/storage"
import { ResearchArtifactTable, ResearchRunTable } from "../../src/research/research.sql"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

afterEach(resetDatabase)
const it = testEffect(CrossSpawnSpawner.defaultLayer)

it.live("collected verified smoke directories do not block long searches while durable and full artifacts remain required", () =>
  provideTmpdirInstance((directory) => Effect.gen(function* () {
    const svc = yield* Research.Service
    const task = yield* svc.createTask({ title: "100-round smoke retention", domainID: "tsf", mode: "autonomous",
      taskSpec: { contextLength: 96, predictionLengths: [96], metadata: { researchVariant: "zero" },
        dataset: { loaderID: "etth1_tslib_v1", targetCols: ["OT"] } },
      objective: { primaryMetric: "cv_avg_mse", direction: "minimize" },
      budget: { maxRuns: 200, loop: { maxIterations: 100, maxNoImprove: 100 } } })
    const recipe = Research.DomainRegistry.buildBaselines("tsf", {
      contextLength: 96, predictionLengths: [96], runtime: { bridgeOnly: true },
      dataset: { loaderID: "etth1_tslib_v1", targetCols: ["OT"] },
    })[0]!.candidateSpec
    const candidate = yield* svc.createCandidate({ taskID: task.id, domainID: "tsf", candidateSpec: recipe,
      rationale: "Recovery-only fixture", riskLevel: "low", approvalStatus: "auto_approved", generatedBy: "human" })
    const run = yield* svc.createRun({ taskID: task.id, candidateID: candidate.id, stage: "smoke", status: "succeeded",
      resourceUsage: { executionContract: { status: "verified" } } })
    const artifact = (kind: string, file: string, stage = "smoke") => {
      const id = Research.ResearchArtifactID.ascending()
      Database.use((db) => db.insert(ResearchArtifactTable).values({ id, task_id: task.id, run_id: run.id,
        kind, uri: pathToFileURL(file).href, metadata: { stage }, time_created: 1, time_updated: 1 }).run())
      return id
    }
    const optional = path.join(directory, ".neo-cast/artifacts/smoke/run_collected")
    const refs = [artifact("runner_artifact", optional)]
    const receipts = ["runner_progress_jsonl", "runner_execution_log_json", "execution_contract_verified_json"]
    const files: string[] = []
    for (const kind of receipts) {
      const file = path.join(directory, "durable", kind)
      yield* Effect.promise(() => Bun.write(file, "durable fixture receipt"))
      files.push(file)
      refs.push(artifact(kind, file))
    }
    Database.use((db) => db.update(ResearchRunTable).set({ artifact_refs: refs }).where(eq(ResearchRunTable.id, run.id)).run())
    expect(resumeState(Instance.project.id, task.id)?.recoveryState).toBe("resumable")
    expect(resumeState(Instance.project.id, task.id)?.blockers).toEqual([])
    // Removing an independent durable receipt must restore blocking, including
    // the smoke checkpoint that can no longer rely on complete evidence.
    yield* Effect.promise(() => rm(files[0]!))
    expect(resumeState(Instance.project.id, task.id)?.blockers).toContain(`Missing artifact:${files[0]}`)
    expect(resumeState(Instance.project.id, task.id)?.blockers).toContain(`Missing artifact:${optional}`)
    yield* Effect.promise(() => Bun.write(files[0]!, "durable fixture receipt"))
    Database.use((db) => db.update(ResearchRunTable).set({ resource_usage: {} }).where(eq(ResearchRunTable.id, run.id)).run())
    expect(resumeState(Instance.project.id, task.id)?.blockers).toContain(`Missing artifact:${optional}`)
    Database.use((db) => db.update(ResearchRunTable).set({ resource_usage: { executionContract: { status: "verified" } }, stage: "full" }).where(eq(ResearchRunTable.id, run.id)).run())
    expect(resumeState(Instance.project.id, task.id)?.blockers).toContain(`Missing artifact:${optional}`)
    Database.use((db) => db.update(ResearchRunTable).set({ stage: "ref_test" }).where(eq(ResearchRunTable.id, run.id)).run())
    expect(resumeState(Instance.project.id, task.id)?.blockers).toContain(`Missing artifact:${optional}`)
    Database.use((db) => db.update(ResearchRunTable).set({ stage: "smoke", status: "failed" }).where(eq(ResearchRunTable.id, run.id)).run())
    expect(resumeState(Instance.project.id, task.id)?.blockers).toContain(`Missing artifact:${optional}`)
    Database.use((db) => db.update(ResearchRunTable).set({ status: "succeeded" }).where(eq(ResearchRunTable.id, run.id)).run())
    const required = path.join(directory, "models/champion.pt")
    artifact("model_weights", required)
    expect(resumeState(Instance.project.id, task.id)?.blockers).toEqual([`Missing artifact:${required}`])
    expect(resumeState(Instance.project.id, task.id)?.recoveryState).toBe("blocked")
    expect((yield* svc.getTask(task.id)).budget.loop).toMatchObject({ maxIterations: 100, maxNoImprove: 100 })
  }).pipe(Effect.provide(Research.defaultLayer)), { config: { formatter: false, lsp: false } }), 30_000)
