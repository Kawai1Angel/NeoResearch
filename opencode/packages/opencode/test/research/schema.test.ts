import { describe, expect, test } from "bun:test"
import { Research } from "../../src/research"

describe("Research schemas", () => {
  test("creates branded research ids with stable prefixes", () => {
    expect(Research.ResearchTaskID.ascending()).toStartWith("rtsk_")
    expect(Research.ResearchCandidateID.ascending()).toStartWith("rcnd_")
    expect(Research.ResearchRunID.ascending()).toStartWith("rrun_")
    expect(Research.ResearchArtifactID.ascending()).toStartWith("rart_")
    expect(Research.ResearchMemoryID.ascending()).toStartWith("rmem_")
    expect(Research.ResearchApprovalID.ascending()).toStartWith("rapr_")
  })

  test("decodes a task create input", () => {
    const parsed = Research.CreateTaskInput.zod.parse({
      title: "ETTh1 horizon 96 search",
      domainID: "tsf",
      mode: "review",
      taskSpec: { dataset: "ETTh1", horizon: 96 },
      objective: { primaryMetric: "mse", direction: "minimize" },
      budget: { maxRuns: 20, maxGpuHours: 8 },
    })

    expect(parsed).toMatchObject({
      title: "ETTh1 horizon 96 search",
      domainID: "tsf",
      mode: "review",
    })
  })

  test("exports zod static for json records", () => {
    expect(
      Research.JsonRecord.zod.parse({
        dataset: "ETTh1",
        horizon: 96,
        tags: ["smoke", "baseline"],
        nested: { enabled: true },
      }),
    ).toMatchObject({
      dataset: "ETTh1",
      horizon: 96,
    })
  })

  test("rejects an invalid task mode", () => {
    expect(() =>
      Research.CreateTaskInput.zod.parse({
        title: "bad mode",
        domainID: "tsf",
        mode: "manual",
        taskSpec: {},
        objective: {},
        budget: {},
      }),
    ).toThrow()
  })
})
