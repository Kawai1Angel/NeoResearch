import { describe, expect, test } from "bun:test"
import {
  buildPublishReportPrompt,
  buildPublishReportSnapshot,
  PUBLISH_REPORT_SECTIONS,
  renderDeterministicFinalReport,
  stripMarkdownFence,
  validateFinalReport,
} from "../../src/research/publish-report"

function snapshot() {
  return buildPublishReportSnapshot({
    task: {
      id: "task_publish_001",
      title: "Forecast demand",
      objective: { primaryMetric: "val_avg_mse" },
      taskSpec: { dataset: { split: "time-ordered" }, runtime: { apiKey: "must-not-leak" } },
    } as any,
    champion: { candidateID: "cand_001", runID: "run_val_001", primaryMetric: 0.2, utility: 1 } as any,
    championCandidate: { id: "cand_001", candidateSpec: { backbone: "dlinear" } } as any,
    refTestRun: {
      id: "run_ref_001",
      candidateID: "cand_001",
      stage: "ref_test",
      status: "succeeded",
      metrics: { ref_test_avg_mse: 0.25, val_avg_mse: 0.2 },
    } as any,
    candidates: [{ id: "cand_001", candidateSpec: { backbone: "dlinear" } }] as any,
    runs: [
      { id: "run_val_001", candidateID: "cand_001", stage: "evaluate", status: "succeeded", metrics: { val_avg_mse: 0.2 }, resourceUsage: { seed: 7 } },
      { id: "run_ref_001", candidateID: "cand_001", stage: "ref_test", status: "succeeded", metrics: { ref_test_avg_mse: 0.25 }, resourceUsage: {} },
    ] as any,
    approvals: [] as any,
    artifacts: [
      { id: "art_eval", kind: "nas_evaluation_result_md", uri: "file:///tmp/eval.md", metadata: {} },
      { id: "art_private", kind: "ref_test_raw_labels_json", uri: "file:///tmp/labels.json", metadata: {} },
    ] as any,
    memories: [] as any,
    generatedAt: "2026-07-22T00:00:00.000Z",
  })
}

describe("PublishAgent final report", () => {
  test("builds a controlled snapshot without private ref-test evidence", () => {
    const value = snapshot()
    expect(value.refTestMetrics).toEqual({ ref_test_avg_mse: 0.25 })
    expect(value.evidence.map((item) => item.artifactID)).toEqual(["art_eval"])
    expect(value.reproducibility.seeds).toEqual([7])
    expect(JSON.stringify(value)).not.toContain("must-not-leak")
  })

  test("uses the PublishAgent session identity and fixed sections", () => {
    const prompt = buildPublishReportPrompt(snapshot())
    expect(prompt).toContain("PublishAgent")
    for (const section of PUBLISH_REPORT_SECTIONS) expect(prompt).toContain(`## ${section}`)
  })

  test("renders a valid deterministic fallback with traceable metrics", () => {
    const value = snapshot()
    const report = renderDeterministicFinalReport(value)
    expect(validateFinalReport(report, value)).toEqual([])
    expect(report).toContain("ref_test_avg_mse")
    expect(report).toContain("0.25")
  })

  test("rejects incomplete reports and strips a single outer fence", () => {
    const report = stripMarkdownFence("```markdown\n## 执行摘要\ntext\n```")
    expect(report).toBe("## 执行摘要\ntext")
    expect(validateFinalReport(report, snapshot()).length).toBeGreaterThan(0)
  })
})
