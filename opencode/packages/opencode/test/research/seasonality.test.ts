import { describe, expect, test } from "bun:test"
import { analyzeSeasonality, decomposeSeasonality } from "../../src/research/seasonality"
import { summarizeTSFTask } from "../../src/research/domains/tsf"
import { tmpdir } from "../fixture/fixture"

function timestamps(length: number, minutes: number) {
  return Array.from({ length }, (_, index) => Date.UTC(2024, 0, 1) + index * minutes * 60_000)
}

function noise() {
  let state = 42
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32 - 0.5
  }
}

describe("seasonal period diagnostics", () => {
  test("passes a supported daily period to search even when only some channels are periodic", async () => {
    await using tmp = await tmpdir()
    const dates = timestamps(96 * 20, 15)
    const random = noise()
    const csv = [
      "date,a,b,c,d,e,f,g",
      ...dates.map((time, index) => {
        const cycle = Math.sin((2 * Math.PI * index) / 96)
        return [
          new Date(time).toISOString(),
          cycle + random() * 0.2,
          -cycle + random() * 0.2,
          ...Array.from({ length: 5 }, random),
        ].join(",")
      }),
    ].join("\n")
    const source = `${tmp.path}/daily.csv`
    await Bun.write(source, csv)
    const fingerprint = summarizeTSFTask({
      contextLength: 336,
      predictionLengths: [96, 720],
      dataset: { loaderID: "local_csv", path: source, targetCols: ["a", "b", "c", "d", "e", "f", "g"] },
    })
    expect(fingerprint.datasetProfile).toMatchObject({ acfMainPeriod: 96 })
    expect((fingerprint.datasetProfile as { seasonalityStrength: number }).seasonalityStrength).toBeLessThan(0.4)
    expect(fingerprint.searchBiases).toContain("seasonal")
  })

  test("detects a noisy daily cycle in 15-minute observations with drift", () => {
    const random = noise()
    const rows = Array.from({ length: 96 * 30 }, (_, index) => [
      index * 0.02 + Math.sin((2 * Math.PI * index) / 96) + random() * 0.8,
    ])
    const result = analyzeSeasonality(rows, timestamps(rows.length, 15))
    expect(result.period).toBe(96)
    expect(result.strength).toBeGreaterThan(0.7)
    expect(decomposeSeasonality(rows, result.period).seasonalVarianceShare).toBeGreaterThan(0)
  })

  test("converts hourly and daily calendar cycles to observation counts", () => {
    const hourly = Array.from({ length: 24 * 20 }, (_, index) => [Math.sin((2 * Math.PI * index) / 24)])
    const weekly = Array.from({ length: 7 * 20 }, (_, index) => [Math.sin((2 * Math.PI * index) / 7)])
    expect(analyzeSeasonality(hourly, timestamps(hourly.length, 60)).period).toBe(24)
    expect(analyzeSeasonality(weekly, timestamps(weekly.length, 1440)).period).toBe(7)
    const tenMinute = Array.from({ length: 144 * 20 }, (_, index) => [Math.sin((2 * Math.PI * index) / 144)])
    expect(analyzeSeasonality(tenMinute, timestamps(tenMinute.length, 10)).period).toBe(144)
  })

  test("does not turn pure drift or strong autoregressive persistence into seasonality", () => {
    const trend = Array.from({ length: 96 * 30 }, (_, index) => [index * 10])
    const random = noise()
    let value = 0
    const persistent = trend.map(() => {
      value = 0.97 * value + random()
      return [value]
    })
    for (const rows of [trend, persistent]) {
      const result = analyzeSeasonality(rows, timestamps(rows.length, 15))
      expect(result.period).toBeUndefined()
      expect(result.strength).toBeLessThan(0.2)
      expect(decomposeSeasonality(rows, result.period)).toEqual({})
    }
  })

  test("requires three cycles and leaves unavailable decomposition unset", () => {
    const rows = Array.from({ length: 96 * 2 }, (_, index) => [Math.sin((2 * Math.PI * index) / 96)])
    expect(analyzeSeasonality(rows, timestamps(rows.length, 15)).period).toBeUndefined()
    expect(decomposeSeasonality(rows, undefined)).toEqual({})
    expect(decomposeSeasonality(rows, 96)).toEqual({})
  })

  test("period detection does not depend on channel units", () => {
    const rows = Array.from({ length: 96 * 20 }, (_, index) => [1e-8 * Math.sin((2 * Math.PI * index) / 96)])
    expect(analyzeSeasonality(rows, timestamps(rows.length, 15)).period).toBe(96)
  })

  test("preserves missing-value alignment and does not cancel opposite-phase channels", () => {
    const rows = Array.from({ length: 96 * 20 }, (_, index) => {
      const value = Math.sin((2 * Math.PI * index) / 96)
      return [index % 113 === 0 ? Number.NaN : value, -1000 * value]
    })
    const result = analyzeSeasonality(rows, timestamps(rows.length, 15))
    expect(result.period).toBe(96)
    expect(result.strength).toBeGreaterThan(0.9)
    const decomposition = decomposeSeasonality(rows, result.period)
    expect(decomposition.seasonalVarianceShare).toBeGreaterThan(0.9)
    expect(decomposition.residualVarianceShare).toBeLessThan(0.02)
  })
})
