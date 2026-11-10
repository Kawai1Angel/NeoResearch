import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { readFile, writeFile } from "fs/promises"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Research } from "../../src/research"
import { addHypothesisToPool, listHypothesesInPool, updateHypothesisInPool, loadTaskEvidenceForTask } from "../../src/research/hypothesis-store"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(resetDatabase)

test("literature phase persists evidence, repairs cache and hands data-only evidence to HypoPlanner", async () => {
  await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
  await Instance.provide({ directory: tmp.path, fn: async () => {
    await Effect.runPromise(Research.Service.use((svc) => Effect.gen(function* () {
      const task = yield* svc.createTask({
        title: "Literature handoff", domainID: "tsf", mode: "review",
        taskSpec: { contextLength: 96, predictionLengths: [24], dataset: { loaderID: "etth1_tslib_v1", targetCols: ["OT"] },
          runtime: {}, metadata: { businessContext: "benchmark", interpretability: "none_required", deploymentTarget: "local_research" } },
        objective: { primaryMetric: "val_avg_mse", direction: "minimize" }, budget: { maxRuns: 2 },
      })
      const reportPath = path.join(tmp.path, "quantitative.json")
      yield* Effect.promise(() => writeFile(reportPath, JSON.stringify({
        schemaVersion: "dataset_quantitative_analysis_v1", taskID: task.id, domain: "electricity_load",
        dataset: { samplingFrequency: "hourly", targetColumns: ["OT"], observedPastCovariates: [], knownFutureCovariates: [], staticCovariates: [] },
        forecast: { contextLength: 96, predictionLengths: [24], horizonContextRatio: 0.25 },
        profile: { rowCount: 1000, missingRate: 0, trendStrength: 0.2, seasonalityStrength: 0.8, crossVarCorrelation: 0, distributionShift: 0, outlierRate: 0, irregularIntervalRatio: 0 },
        statistics: { stationarity: {}, acf: {}, decomposition: {}, frequency: { spectralPeaks: [] }, changepoint: {}, crossLag: {} },
        warnings: [], sourceArtifactIDs: [],
      })))
      yield* svc.createArtifact({ taskID: task.id, kind: "dataset_quantitative_analysis_json", uri: `file://${reportPath}`, metadata: {} })
      const result = yield* svc.runRetrieveAgent({ taskID: task.id })
      expect(result.schemaVersion).toBe("retrieve_result_v2")
      expect(result.taskEvidence.readiness).toBe("ready_data_only")
      const artifacts = yield* svc.listArtifacts(task.id)
      const bundleArtifact = artifacts.find((item) => item.kind === "task_evidence_bundle_json")!
      expect(bundleArtifact.metadata.paperSummaries).toEqual([])
      expect(bundleArtifact.metadata.cardSummaries).toEqual([])
      expect(yield* Effect.promise(() => loadTaskEvidenceForTask(task.id))).toEqual(result.taskEvidence)
      const resultArtifact = artifacts.find((item) => item.kind === "literature_retrieve_result_json")!
      yield* Effect.promise(() => writeFile(resultArtifact.uri.slice(7), "broken cache"))
      const rebuilt = yield* svc.runRetrieveAgent({ taskID: task.id, force: true })
      expect(rebuilt.retrieveRunID).toBe(result.retrieveRunID)
      const plan = yield* svc.runHypoPlannerAgent({ taskID: task.id, taskEvidenceArtifactID: bundleArtifact.id })
      expect(plan.plan.hypotheses.length).toBeGreaterThan(0)
      expect(plan.plan.hypotheses.every((item) => item.evidenceLevel === "data_only")).toBe(true)
      const draft = { ...plan.plan.hypotheses[0]!, id: "H_roundtrip", datasetEvidencePaths: ["profile.seasonalityStrength"],
        literatureEvidence: [{ cardID: "kc_fixture", cardRevision: 2, role: "supports_mechanism" as const }],
        applicabilityAssumptions: ["Stable seasonality"], falsificationCriteria: ["MSE fails to improve"], evidenceLevel: "paper_supported" as const }
      yield* Effect.promise(() => addHypothesisToPool(task.id, draft))
      yield* Effect.promise(() => updateHypothesisInPool(task.id, draft.id, { applicabilityAssumptions: ["Stable hourly seasonality"] }))
      const stored = (yield* Effect.promise(() => listHypothesesInPool(task.id))).find((item) => item.id === draft.id)!
      expect(stored.literatureEvidence).toEqual(draft.literatureEvidence)
      expect(stored.falsificationCriteria).toEqual(draft.falsificationCriteria)
      expect(stored.applicabilityAssumptions).toEqual(["Stable hourly seasonality"])
      const bundlePath = bundleArtifact.uri.slice(7)
      const bundle = JSON.parse(yield* Effect.promise(() => readFile(bundlePath, "utf8")))
      yield* Effect.promise(() => writeFile(bundlePath, JSON.stringify({ ...bundle, taskID: "wrong_task" })))
      yield* Effect.promise(async () => { await expect(loadTaskEvidenceForTask(task.id)).rejects.toThrow("provenance mismatch") })
    })).pipe(Effect.provide(Research.defaultLayer)))
  } })
}, 30_000)
