import { ResearchApprovalID } from "../../src/research/schema"
import { INTENT_SLOT_IDS } from "../../src/research/agents/intent-agent"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Research } from "../../src/research"
import {
  applySlotUpdates,
  checkTaskspecReadiness,
  enterIntentCheckpoint,
  readTaskspecSlots,
  recordAskUserQuestions,
} from "../../src/research/taskspec-store"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(resetDatabase)

function runResearch<A, E>(fx: Effect.Effect<A, E, Research.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(Research.defaultLayer)))
}

function createTask() {
  return runResearch(
    Research.Service.use((svc) =>
      svc.createTask({
        title: "ETTh1 taskspec-store test",
        domainID: "tsf",
        mode: "review",
        taskSpec: {
          contextLength: 96,
          predictionLengths: [24],
          dataset: { loaderID: "etth1_tslib_v1", targetCols: ["OT"] },
          metadata: { businessContext: "TSF benchmark experiment" },
        },
        objective: { primaryMetric: "val_avg_mse", direction: "minimize" },
        budget: { maxRuns: 12 },
      }),
    ),
  )
}

describe("taskspec-store", () => {
  test("readTaskspecSlots reports slots already filled by createTask as not missing", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTask()
        const snapshot = await readTaskspecSlots(task.id)
        expect(snapshot.slots.target_columns?.missing).toBe(false)
        expect(snapshot.slots.target_columns?.value).toEqual(["OT"])
        expect(snapshot.slots.lookback_window?.value).toBe(96)
        // forecast_object/data_source/primary_metric etc. were never set — still missing.
        expect(snapshot.missingRequiredSlots.length).toBeGreaterThan(0)
        expect(snapshot.missingRequiredSlots).toContain("data_source")
      },
    })
  })

  test("applySlotUpdates writes to the canonical metadata.intentSlots path and mirrors data_source/target_columns into dataset", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTask()
        const snapshot = await applySlotUpdates(task.id, {
          data_source: "/data/etth1.csv",
          forecast_object: "OT column time series",
          primary_metric: "val_avg_mse",
        })
        expect(snapshot.slots.data_source?.value).toBe("/data/etth1.csv")
        expect(snapshot.slots.data_source?.missing).toBe(false)
        expect(snapshot.slots.forecast_object?.value).toBe("OT column time series")

        const updated = await runResearch(Research.Service.use((svc) => svc.getTask(task.id)))
        expect(updated.taskSpec).toMatchObject({
          metadata: { intentSlots: { data_source: "/data/etth1.csv" } },
          dataset: { path: "/data/etth1.csv" },
        })
      },
    })
  })

  test("horizon and lookback edits update the persisted execution contract and independent readback", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await Instance.provide({ directory: tmp.path, fn: async () => {
      const task = await createTask()
      const horizons = [96, 192, 336, 720]
      const result = await applySlotUpdates(task.id, { prediction_horizon: horizons, lookback_window: 336 })
      expect(result.slots.prediction_horizon?.value).toEqual(horizons)
      expect(result.slots.lookback_window?.value).toBe(336)
      const reread = await readTaskspecSlots(task.id)
      expect(reread.slots.prediction_horizon?.value).toEqual(horizons)
      const stored = await runResearch(Research.Service.use((svc) => svc.getTask(task.id)))
      expect(stored.taskSpec).toMatchObject({
        predictionLengths: horizons, contextLength: 336,
        metadata: { intentSlots: { prediction_horizon: horizons, lookback_window: 336 } },
      })
      await applySlotUpdates(task.id, { business_context: "updated description" })
      expect((await readTaskspecSlots(task.id)).slots.prediction_horizon?.value).toEqual(horizons)
    } })
  })

  test("data split defaults to 7:1:2 and can switch between ratios and explicit row ranges", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await Instance.provide({ directory: tmp.path, fn: async () => {
      const task = await createTask()
      const initial = await readTaskspecSlots(task.id)
      expect(initial.slots.data_split_method?.value).toBe("ratio")
      expect(initial.slots.data_split_ratios?.value).toEqual([7, 1, 2])

      await applySlotUpdates(task.id, { data_split_ratios: [6, 2, 2] })
      let stored = await runResearch(Research.Service.use((svc) => svc.getTask(task.id)))
      expect(stored.taskSpec.dataset).toMatchObject({ split: { method: "ratio", ratios: [6, 2, 2] } })

      const ranges = { train: [0, 600], validation: [600, 800], test: [800, 1000] }
      await applySlotUpdates(task.id, { data_split_method: "row_ranges", data_split_row_ranges: ranges })
      const snapshot = await readTaskspecSlots(task.id)
      expect(snapshot.slots.data_split_method?.value).toBe("row_ranges")
      expect(snapshot.slots.data_split_row_ranges?.value).toEqual(ranges)
      stored = await runResearch(Research.Service.use((svc) => svc.getTask(task.id)))
      expect(stored.taskSpec.dataset).toMatchObject({
        split: {
          method: "row_ranges",
          trainRows: [0, 600],
          validationRows: [600, 800],
          testRows: [800, 1000],
        },
      })
      await applySlotUpdates(task.id, { data_split_ratios: [8, 1, 1] })
      const ratioSnapshot = await readTaskspecSlots(task.id)
      expect(ratioSnapshot.slots.data_split_method?.value).toBe("ratio")
      expect(ratioSnapshot.slots.data_split_ratios?.value).toEqual([8, 1, 1])
      expect(ratioSnapshot.slots.data_split_row_ranges?.value).toBeUndefined()
    } })
  })

  test("invalid data split updates fail without changing the task", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await Instance.provide({ directory: tmp.path, fn: async () => {
      const task = await createTask()
      for (const updates of [
        { data_split_method: "random" },
        { data_split_ratios: [7, 0, 3] },
        { data_split_ratios: [7, 3] },
        { data_split_method: "row_ranges", data_split_row_ranges: { train: [1, 60], validation: [60, 80], test: [80, 100] } },
        { data_split_method: "row_ranges", data_split_row_ranges: { train: [0, 60], validation: [61, 80], test: [80, 100] } },
      ]) {
        await expect(applySlotUpdates(task.id, updates)).rejects.toThrow()
        const stored = await runResearch(Research.Service.use((svc) => svc.getTask(task.id)))
        expect(stored.taskSpec).toEqual(task.taskSpec)
      }
    } })
  })

  test("invalid horizon or lookback updates fail before any task data is changed", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await Instance.provide({ directory: tmp.path, fn: async () => {
      const task = await createTask()
      for (const updates of [
        { prediction_horizon: [] }, { prediction_horizon: [96, -1] },
        { prediction_horizon: [96, 1.5] }, { prediction_horizon: [96, 9000] },
        { lookback_window: 0 },
      ]) {
        await expect(applySlotUpdates(task.id, updates)).rejects.toThrow()
        const stored = await runResearch(Research.Service.use((svc) => svc.getTask(task.id)))
        expect(stored.taskSpec).toEqual(task.taskSpec)
      }
    } })
  })

  test("every supported slot round-trips and mirrors its downstream fields", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await Instance.provide({ directory: tmp.path, fn: async () => {
      const task = await createTask()
      const updates = {
        interaction_mode: "socratic", forecast_object: "power forecasting", data_source: "/data/new.csv",
        target_columns: ["power"], lookback_window: 336, prediction_horizon: [96, 192, 336, 720],
        data_split_method: "ratio", data_split_ratios: [7, 1, 2],
        time_grain: "1 hour", exogenous_variables: ["wind"], future_covariate_availability: "unavailable",
        business_context: "dispatch planning", primary_metric: "cv_avg_mae", secondary_metrics: ["cv_avg_mse"],
        error_preferences: "short horizon", latency_budget: 200, parameter_budget: "5M",
        max_iterations: 30, max_no_improve: 7,
        interpretability: "simple models", deployment_target: "cpu",
      }
      await applySlotUpdates(task.id, updates)
      const snapshot = await readTaskspecSlots(task.id)
      expect(Object.keys(snapshot.slots).sort()).toEqual([...INTENT_SLOT_IDS].sort())
      for (const [key, value] of Object.entries(updates)) expect(snapshot.slots[key as keyof typeof updates]?.value).toEqual(value)
      const stored = await runResearch(Research.Service.use((svc) => svc.getTask(task.id)))
      expect(stored.interactionMode).toBe("socratic")
      expect(stored.objective).toMatchObject({ primaryMetric: "cv_avg_mae", secondaryMetrics: ["cv_avg_mse"], errorPreferences: "short horizon" })
      expect(stored.budget).toMatchObject({
        latencyBudget: 200,
        parameterBudget: "5M",
        loop: { maxIterations: 30, maxNoImprove: 7 },
      })
      expect(stored.taskSpec).toMatchObject({
        contextLength: 336, predictionLengths: [96, 192, 336, 720],
        evaluation: { metricPrimary: "cv_avg_mae" }, constraints: { maxParams: 5_000_000 },
        runtime: { deploymentTarget: "cpu" },
        dataset: { path: "/data/new.csv", targetCols: ["power"], observedPastCovariates: ["wind"], knownFutureCovariates: [] },
        metadata: { interactionMode: "socratic", timeGrain: "1 hour", forecastObject: "power forecasting", businessContext: "dispatch planning", interpretability: "simple models" },
      })
      await applySlotUpdates(task.id, { secondary_metrics: [], parameter_budget: "no_constraint" })
      const cleared = await runResearch(Research.Service.use((svc) => svc.getTask(task.id)))
      expect(cleared.objective.secondaryMetrics).toEqual([])
      expect(cleared.taskSpec.constraints).not.toHaveProperty("maxParams")
      expect((await readTaskspecSlots(task.id)).slots.secondary_metrics?.value).toEqual([])
    } })
  })

  test("changing the CSV recomputes all covariates using the new file", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await Bun.write(`${tmp.path}/old.csv`, "date,OT,old_feature\n2026-01-01,1,2\n")
    await Bun.write(`${tmp.path}/new.csv`, "date,OT,new_feature\n2026-01-01,1,3\n")
    await Instance.provide({ directory: tmp.path, fn: async () => {
      const task = await createTask()
      await applySlotUpdates(task.id, { data_source: `${tmp.path}/old.csv`, exogenous_variables: ["all"] })
      await applySlotUpdates(task.id, { data_source: `${tmp.path}/new.csv` })
      const stored = await runResearch(Research.Service.use((svc) => svc.getTask(task.id)))
      expect(stored.taskSpec.dataset).toMatchObject({ path: `${tmp.path}/new.csv`, observedPastCovariates: ["new_feature"] })
    } })
  })

  test("unknown slot names, unsupported metrics and invalid modes cannot silently succeed", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await Instance.provide({ directory: tmp.path, fn: async () => {
      const task = await createTask()
      for (const updates of [{ prediction_horizonn: [96] }, { primary_metric: "imaginary_metric" }, { interaction_mode: "typo" }, { parameter_budget: -1 }, { max_iterations: 0 }, { max_no_improve: 1.5 }, { business_context: {} }, { target_columns: [123] }, { latency_budget: false }]) {
        await expect(applySlotUpdates(task.id, updates)).rejects.toThrow()
        const stored = await runResearch(Research.Service.use((svc) => svc.getTask(task.id)))
        expect(stored.taskSpec).toEqual(task.taskSpec)
        expect(stored.objective).toEqual(task.objective)
        expect(stored.budget).toEqual(task.budget)
      }
    } })
  })

  test("all exogenous variables resolve to observed-past only and explicit future requests fail", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await Bun.write(`${tmp.path}/wind.csv`, [
      "date,real_power,wind_speed,temperature,site",
      "2026-01-01,1,3.2,18,A",
      "2026-01-02,2,4.1,19,A",
    ].join("\n"))
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTask()
        await expect(applySlotUpdates(task.id, {
          data_source: `${tmp.path}/wind.csv`,
          target_columns: ["real_power"],
          exogenous_variables: ["all"],
          future_covariate_availability: "weather forecast available at prediction time",
        })).rejects.toThrow("UNSUPPORTED_COVARIATE")
        await applySlotUpdates(task.id, {
          data_source: `${tmp.path}/wind.csv`, target_columns: ["real_power"], exogenous_variables: ["all"],
          future_covariate_availability: "unavailable",
        })
        const updated = await runResearch(Research.Service.use((svc) => svc.getTask(task.id)))
        expect(updated.taskSpec).toMatchObject({
          dataset: {
            targetCols: ["real_power"],
            observedPastCovariates: ["wind_speed", "temperature"],
            knownFutureCovariates: [],
          },
          metadata: {
            intentSlots: { exogenous_variables: ["all"] },
            resolvedCovariates: {
              policy: "all_non_target_numeric_columns",
              columns: ["wind_speed", "temperature"],
            },
          },
        })
      },
    })
  })

  test("checkTaskspecReadiness reflects ok:false until all required slots are filled, then ok:true", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTask()
        const before = await checkTaskspecReadiness(task.id)
        expect(before.ok).toBe(false)
        expect(before.missingRequiredSlots.length).toBeGreaterThan(0)

        await applySlotUpdates(task.id, Object.fromEntries(before.missingRequiredSlots.map((id) => [id, fillerValueFor(id)])))

        const after = await checkTaskspecReadiness(task.id)
        expect(after.ok).toBe(true)
        expect(after.missingRequiredSlots).toEqual([])
      },
    })
  })

  test("recordAskUserQuestions deletes the previous pending ask_user approval instead of leaving it stale", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTask()
        await recordAskUserQuestions(task.id, ["What is the dataset path?"])
        await recordAskUserQuestions(task.id, ["What are the target columns?"])
        const approvals = await runResearch(Research.Service.use((svc) => svc.listApprovals({ taskID: task.id })))
        const pending = approvals.filter((a) => a.status === "pending")
        expect(pending).toHaveLength(1)
        expect(pending[0]?.reason).toContain("What are the target columns?")
      },
    })
  })

  test("horizon edits supersede stale checkpoints and reject approval of the old snapshot", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await Instance.provide({ directory: tmp.path, fn: async () => {
      const task = await createTask()
      await applySlotUpdates(task.id, { prediction_horizon: [96] })
      const old = await enterIntentCheckpoint(task.id)
      await applySlotUpdates(task.id, { prediction_horizon: [96, 192, 336, 720] })
      const current = await enterIntentCheckpoint(task.id)
      expect(current.approvalID).not.toBe(old.approvalID)
      const approvals = await runResearch(Research.Service.use((svc) => svc.listApprovals({ taskID: task.id })))
      expect(approvals.filter((item) => item.status === "pending")).toHaveLength(1)
      expect(approvals.find((item) => item.id === current.approvalID)?.reason).toContain("Prediction lengths: 96,192,336,720")
      await expect(runResearch(Research.Service.use((svc) => svc.replyApproval({
        approvalID: ResearchApprovalID.make(old.approvalID), status: "approved",
      })))).rejects.toThrow("outdated")
      await runResearch(Research.Service.use((svc) => svc.replyApproval({
        approvalID: ResearchApprovalID.make(current.approvalID), status: "approved",
      })))
      expect((await enterIntentCheckpoint(task.id)).status).toBe("approved")
    } })
  })

  test("enterIntentCheckpoint deletes any leftover pending ask_user approval when opening the checkpoint", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTask()
        const before = await checkTaskspecReadiness(task.id)
        await applySlotUpdates(task.id, Object.fromEntries(before.missingRequiredSlots.map((id) => [id, fillerValueFor(id)])))
        await recordAskUserQuestions(task.id, ["The business context still needs confirmation"])
        await enterIntentCheckpoint(task.id)
        const approvals = await runResearch(Research.Service.use((svc) => svc.listApprovals({ taskID: task.id })))
        const pending = approvals.filter((a) => a.status === "pending")
        expect(pending).toHaveLength(1)
        expect(pending[0]?.reason).toContain("[checkpoint:intent_confirmed]")
        expect(pending[0]?.reason).toContain("NAS planned iterations: 25")
        expect(pending[0]?.reason).toContain("Stop after no improvement: 7")
        expect(pending[0]?.reason).not.toContain("Budget max runs")
      },
    })
  })
})

function fillerValueFor(slotID: string): unknown {
  if (slotID === "exogenous_variables") return []
  if (slotID === "prediction_horizon") return [24]
  if (slotID === "lookback_window") return 96
  if (slotID === "latency_budget" || slotID === "parameter_budget") return "no_constraint"
  if (slotID === "max_iterations") return 20
  if (slotID === "max_no_improve") return 5
  return `filler for ${slotID}`
}
