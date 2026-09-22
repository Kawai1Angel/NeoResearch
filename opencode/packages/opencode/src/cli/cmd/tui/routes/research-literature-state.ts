export type LiteratureView = {
  taskID: string
  status: string
  sessionID?: string
  textPartID?: string
  rows: Array<{ key: string; text: string }>
}
export function literatureSummary(meta: Record<string, unknown>) {
  const summary = (meta.summary ?? meta) as Record<string, unknown>
  return `[LiteratureAgent] 完成 · ${summary.literaturePaperCount ?? 0} papers / ${summary.paperBackedCardCount ?? 0} cards / ${meta.selectedEntryCount ?? 0} selected / ${meta.gapCount ?? meta.uncoveredMustCoverIntentCount ?? 0} gaps · ${meta.readiness ?? "unknown"} · ${meta.callPath ?? "direct"}${meta.reason ? ` (${meta.reason})` : ""}`
}
export function updateLiteratureView(previous: LiteratureView | undefined, selectedTaskID: string | undefined,
  event: { type: string; properties?: Record<string, unknown> }): LiteratureView | undefined {
  const data = event.properties ?? {}
  if (!selectedTaskID || data.taskID !== selectedTaskID) return previous
  const state = previous?.taskID === selectedTaskID ? previous : { taskID: selectedTaskID, status: "running", rows: [] }
  const meta = (data.metadata ?? {}) as Record<string, unknown>
  if (event.type.endsWith(".started")) return { taskID: selectedTaskID, status: "running", rows: [] }
  if (event.type.endsWith(".completed")) return { ...state, status: "completed", sessionID: typeof meta.sessionID === "string" ? meta.sessionID : state.sessionID,
    rows: [{ key: "summary", text: literatureSummary(meta) }] }
  if (event.type.endsWith(".failed")) return { ...state, status: "failed", rows: [{ key: "failure", text: "[LiteratureAgent] 失败 · 证据未交付，请检查子 session 或服务日志" }] }
  if (state.status !== "running") return state
  const key = event.type.endsWith(".progress") ? `${data.runID}:${data.step}:${data.paperID ?? ""}`
    : data.partID ? `part:${data.partID}` : state.textPartID ? `part:${state.textPartID}` : "text"
  const existing = state.rows.find((row) => row.key === key)?.text ?? ""
  const text = event.type.endsWith(".progress")
    ? `  ${data.cached ? "缓存命中 · " : ""}${data.step} · ${data.paperID ?? ""} · ${data.status}${data.counts ? ` · ${Object.entries(data.counts as Record<string, unknown>).map(([k, v]) => `${v} ${k}`).join(" / ")}` : ""}`
    : data.kind === "tool" ? `  ${data.toolName} · ${data.toolState}${data.toolDurationMs === undefined ? "" : ` · ${data.toolDurationMs} ms`}`
    : data.text !== undefined ? String(data.text) : existing + String(data.delta ?? "")
  const rows = state.rows.filter((row) => row.key !== key && !(data.kind === "text" && row.key === "text"))
  rows.push({ key, text: text.slice(-2000) })
  return { ...state, sessionID: typeof data.sessionID === "string" ? data.sessionID : state.sessionID, textPartID: data.kind === "text" ? String(data.partID) : state.textPartID, rows: rows.slice(-40) }
}
