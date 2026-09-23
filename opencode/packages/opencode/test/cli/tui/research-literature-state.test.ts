import { expect, test } from "bun:test"
import { updateLiteratureView, literatureSummary, literatureResultRows } from "../../../src/cli/cmd/tui/routes/research-literature-state"

test("literature view isolates tasks, bounds streams, deduplicates progress and seals completion", () => {
  const emit = (type: string, properties: Record<string, unknown> = {}) => ({ type: `research.agent.literature.${type}`, properties: { taskID: "task_a", ...properties } })
  let state = updateLiteratureView(undefined, "task_a", emit("started"))
  expect(state?.status).toBe("running")
  for (let i = 0; i < 100; i++) state = updateLiteratureView(state, "task_a", emit("progress", { runID: "run_a", step: "parse", paperID: "paper_a", status: "running" }))
  expect(state?.rows).toHaveLength(1)
  state = updateLiteratureView(state, "task_a", emit("progress", { runID: "run_a", step: "assemble_evidence", status: "completed", cached: true }))
  expect(state?.rows.at(-1)?.text).toContain("缓存命中")
  expect(updateLiteratureView(state, "task_a", emit("failed", { taskID: "task_b" }))).toBe(state)
  for (let i = 0; i < 100; i++) state = updateLiteratureView(state, "task_a", emit("part.updated", { partID: String(i), kind: "text", text: "x".repeat(10000) }))
  expect(state?.rows.length).toBe(40)
  expect(state?.rows.every((row) => row.text.length <= 2000)).toBe(true)
  state = updateLiteratureView(state, "task_a", emit("completed", { metadata: { readiness: "ready_data_only", callPath: "direct", gapCount: 2 } }))
  expect(state?.status).toBe("completed")
  expect(state?.rows.at(-1)?.text).toContain("0 papers / 0 cards")
  expect(state?.rows.at(-1)?.text).toContain("ready_data_only")
  expect(state?.rows.some((row) => row.text.includes("x"))).toBe(true)
  expect(updateLiteratureView(state, "task_a", emit("progress"))).toBe(state)
  expect(updateLiteratureView(state, "task_b", emit("started", { taskID: "task_b" }))?.rows).toEqual([])
  expect(updateLiteratureView(state, "task_a", emit("failed"))?.status).toBe("failed")
  expect(literatureSummary({ readiness: "ready_data_only", callPath: "direct", summary: { paperBackedCardCount: 0 } })).toContain("ready_data_only · direct")
})

test("literature view retains tool receipts and renders selected papers and card claims", () => {
  const emit = (type: string, properties: Record<string, unknown> = {}) => ({ type: `research.agent.literature.${type}`, properties: { taskID: "task_a", ...properties } })
  let state = updateLiteratureView(undefined, "task_a", emit("started"))
  state = updateLiteratureView(state, "task_a", emit("progress", { runID: "run_a", step: "select", status: "completed", counts: { papers: 1 } }))
  state = updateLiteratureView(state, "task_a", emit("part.updated", { partID: "tool_1", kind: "tool", toolName: "literature_run",
    toolState: "completed", toolInput: { paperID: "paper_a" }, toolOutput: "validated receipt" }))
  state = updateLiteratureView(state, "task_a", emit("completed", { metadata: {
    readiness: "ready_with_evidence", literaturePaperCount: 1, paperBackedCardCount: 1, selectedEntryCount: 1,
    paperSummaries: [{ paperID: "paper_a", title: "Forecasting with Patches", status: "completed", acceptedCardCount: 1 }],
    cardSummaries: [{ cardID: "kc_a", paperID: "paper_a", cardType: "model_mechanism", claim: "Patches model local patterns." }],
  } }))
  expect(state?.rows.map((row) => row.text).join("\n")).toContain("1 papers")
  expect(state?.rows.map((row) => row.text).join("\n")).toContain("validated receipt")
  expect(state?.rows.map((row) => row.text).join("\n")).toContain("Forecasting with Patches")
  expect(state?.rows.map((row) => row.text).join("\n")).toContain("Patches model local patterns.")
  expect(updateLiteratureView(state, "task_a", emit("completed"))).toBe(state)
  expect(literatureResultRows({ cardSummaries: [{ cardID: "kc_a", claim: "Claim" }] }).at(-1)?.text).toContain("Claim")
})
