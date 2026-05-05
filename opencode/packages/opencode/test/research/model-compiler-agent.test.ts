import { expect, test } from "bun:test"
import { buildModelCompilerResult } from "../../src/research/agents/model-compiler-agent"
import type { ResearchRun } from "../../src/research/schema"

function smokeRun(input: {
  status: ResearchRun["status"]
  metrics?: Record<string, unknown>
  error?: string
  resourceUsage?: Record<string, unknown>
}): ResearchRun {
  return {
    id: "rrun_smoke",
    taskID: "rtsk_compile",
    candidateID: "rcnd_compile",
    stage: "smoke",
    status: input.status,
    metrics: input.metrics ?? {},
    resourceUsage: input.resourceUsage ?? {},
    artifactRefs: [],
    error: input.error,
    time: { created: 1, updated: 1 },
  } as unknown as ResearchRun
}

test("buildModelCompilerResult passes succeeded smoke runs with bounded finite metrics", () => {
  const result = buildModelCompilerResult({
    taskID: "rtsk_compile" as never,
    candidateID: "rcnd_compile" as never,
    smokeRun: smokeRun({ status: "succeeded", metrics: { val_avg_mse: 0.12 } }),
  })

  expect(result).toMatchObject({
    agent: "ModelCompilerAgent",
    taskID: "rtsk_compile",
    candidateID: "rcnd_compile",
    runID: "rrun_smoke",
    status: "passed",
    smokeMetric: 0.12,
  })
  expect(result.compileReportMarkdown).toContain("PASSED")
})

test("buildModelCompilerResult allows metricless successful smoke runs for later metric analysis", () => {
  const result = buildModelCompilerResult({
    taskID: "rtsk_compile" as never,
    candidateID: "rcnd_compile" as never,
    smokeRun: smokeRun({ status: "succeeded" }),
  })

  expect(result.status).toBe("passed")
  expect(result.smokeMetric).toBeUndefined()
  expect(result.compileReportMarkdown).toContain("Metric: n/a")
})

test("buildModelCompilerResult fails non-succeeded smoke runs", () => {
  const result = buildModelCompilerResult({
    taskID: "rtsk_compile" as never,
    candidateID: "rcnd_compile" as never,
    smokeRun: smokeRun({ status: "failed", error: "shape mismatch" }),
  })

  expect(result.status).toBe("failed")
  expect(result.failureReason).toContain("shape mismatch")
  expect(result.compileReportMarkdown).toContain("FAILED")
})

test("buildModelCompilerResult fails exploding or non-finite smoke metrics", () => {
  const exploding = buildModelCompilerResult({
    taskID: "rtsk_compile" as never,
    candidateID: "rcnd_compile" as never,
    smokeRun: smokeRun({ status: "succeeded", metrics: { val_avg_mse: 1_000_000 } }),
  })
  const nonFinite = buildModelCompilerResult({
    taskID: "rtsk_compile" as never,
    candidateID: "rcnd_compile" as never,
    smokeRun: smokeRun({ status: "succeeded", metrics: { val_avg_mse: Number.NaN } }),
  })

  expect(exploding.status).toBe("failed")
  expect(exploding.failureReason).toContain("exploded")
  expect(nonFinite.status).toBe("failed")
  expect(nonFinite.failureReason).toContain("non-finite")
})

test("buildModelCompilerResult reports timeouts separately", () => {
  const result = buildModelCompilerResult({
    taskID: "rtsk_compile" as never,
    candidateID: "rcnd_compile" as never,
    smokeRun: smokeRun({ status: "failed", error: "Process timeout exceeded" }),
  })

  expect(result.status).toBe("timeout")
  expect(result.failureReason).toContain("timeout")
})

test("buildModelCompilerResult recognizes resource usage timeout flags", () => {
  const result = buildModelCompilerResult({
    taskID: "rtsk_compile" as never,
    candidateID: "rcnd_compile" as never,
    smokeRun: smokeRun({ status: "failed", resourceUsage: { timedOut: true } }),
  })

  expect(result.status).toBe("timeout")
  expect(result.compileReportMarkdown).toContain("TIMEOUT")
})
