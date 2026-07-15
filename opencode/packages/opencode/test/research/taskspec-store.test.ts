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
          forecast_object: "OT 列时间序列",
          primary_metric: "val_avg_mse",
        })
        expect(snapshot.slots.data_source?.value).toBe("/data/etth1.csv")
        expect(snapshot.slots.data_source?.missing).toBe(false)
        expect(snapshot.slots.forecast_object?.value).toBe("OT 列时间序列")

        const updated = await runResearch(Research.Service.use((svc) => svc.getTask(task.id)))
        expect(updated.taskSpec).toMatchObject({
          metadata: { intentSlots: { data_source: "/data/etth1.csv" } },
          dataset: { path: "/data/etth1.csv" },
        })
      },
    })
  })

  test("all exogenous variables resolve to non-target numeric columns and both dynamic roles", async () => {
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
        await applySlotUpdates(task.id, {
          data_source: `${tmp.path}/wind.csv`,
          target_columns: ["real_power"],
          exogenous_variables: ["all"],
          future_covariate_availability: "weather forecast available at prediction time",
        })
        const updated = await runResearch(Research.Service.use((svc) => svc.getTask(task.id)))
        expect(updated.taskSpec).toMatchObject({
          dataset: {
            targetCols: ["real_power"],
            observedPastCovariates: ["wind_speed", "temperature"],
            knownFutureCovariates: ["wind_speed", "temperature"],
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
        await recordAskUserQuestions(task.id, ["数据集路径是什么？"])
        await recordAskUserQuestions(task.id, ["目标列是什么？"])
        const approvals = await runResearch(Research.Service.use((svc) => svc.listApprovals({ taskID: task.id })))
        const pending = approvals.filter((a) => a.status === "pending")
        expect(pending).toHaveLength(1)
        expect(pending[0]?.reason).toContain("目标列是什么？")
      },
    })
  })

  test("enterIntentCheckpoint deletes any leftover pending ask_user approval when opening the checkpoint", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const task = await createTask()
        const before = await checkTaskspecReadiness(task.id)
        await applySlotUpdates(task.id, Object.fromEntries(before.missingRequiredSlots.map((id) => [id, fillerValueFor(id)])))
        await recordAskUserQuestions(task.id, ["还需要确认一下业务背景"])
        await enterIntentCheckpoint(task.id)
        const approvals = await runResearch(Research.Service.use((svc) => svc.listApprovals({ taskID: task.id })))
        const pending = approvals.filter((a) => a.status === "pending")
        expect(pending).toHaveLength(1)
        expect(pending[0]?.reason).toContain("[checkpoint:intent_confirmed]")
      },
    })
  })
})

function fillerValueFor(slotID: string): unknown {
  if (slotID === "exogenous_variables") return []
  if (slotID === "prediction_horizon") return [24]
  if (slotID === "lookback_window") return 96
  if (slotID === "latency_budget" || slotID === "parameter_budget") return "no_constraint"
  return `filler for ${slotID}`
}
