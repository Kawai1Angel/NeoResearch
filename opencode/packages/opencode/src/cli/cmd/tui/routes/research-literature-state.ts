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

export function literatureResultRows(meta: Record<string, unknown>) {
  const rows: LiteratureView["rows"] = [{ key: "summary", text: literatureSummary(meta) }]
  const oneLine = (value: string) => value.replace(/\s+/g, " ").trim()
  const papers = Array.isArray(meta.paperSummaries) ? meta.paperSummaries : []
  for (const [index, value] of papers.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const paper = value as Record<string, unknown>
    if (typeof paper.paperID !== "string") continue
    const title = typeof paper.title === "string" && paper.title.trim() ? paper.title : paper.paperID
    rows.push({ key: `paper-${index}`, text: `  论文 · ${oneLine(title)} (${paper.paperID}) · ${paper.status ?? "unknown"} · ${paper.acceptedCardCount ?? 0} cards` })
  }
  const cards = Array.isArray(meta.cardSummaries) ? meta.cardSummaries : []
  for (const [index, value] of cards.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const card = value as Record<string, unknown>
    if (typeof card.cardID !== "string" || typeof card.claim !== "string") continue
    rows.push({ key: `card-${index}`, text: `  ${card.selected === false ? "提取卡片" : "入选卡片"} · ${card.cardID} · ${card.paperID ?? ""} · ${card.cardType ?? ""}: ${oneLine(card.claim)}` })
  }
  return rows
}
export function updateLiteratureView(previous: LiteratureView | undefined, selectedTaskID: string | undefined,
  event: { type: string; properties?: Record<string, unknown> }): LiteratureView | undefined {
  const data = event.properties ?? {}
  if (!selectedTaskID || data.taskID !== selectedTaskID) return previous
  const state = previous?.taskID === selectedTaskID ? previous : { taskID: selectedTaskID, status: "running", rows: [] }
  const meta = (data.metadata ?? {}) as Record<string, unknown>
  if (event.type.endsWith(".started")) return { taskID: selectedTaskID, status: "running", rows: [] }
  if (event.type.endsWith(".completed")) return state.status === "completed" ? state : { ...state, status: "completed", sessionID: typeof meta.sessionID === "string" ? meta.sessionID : state.sessionID,
    rows: [...state.rows, ...literatureResultRows(meta)] }
  if (event.type.endsWith(".failed")) return state.status === "failed" ? state : { ...state, status: "failed", rows: [...state.rows,
    { key: "failure", text: "[LiteratureAgent] 失败 · 证据未交付，请检查子 session 或服务日志" }] }
  if (state.status !== "running") return state
  const key = event.type.endsWith(".progress") ? `${data.runID}:${data.step}:${data.paperID ?? ""}`
    : data.partID ? `part:${data.partID}` : state.textPartID ? `part:${state.textPartID}` : "text"
  const existing = state.rows.find((row) => row.key === key)?.text ?? ""
  const text = event.type.endsWith(".progress")
    ? `  ${data.cached ? "缓存命中 · " : ""}${data.step} · ${data.paperID ?? ""} · ${data.status}${data.counts ? ` · ${Object.entries(data.counts as Record<string, unknown>).map(([k, v]) => `${v} ${k}`).join(" / ")}` : ""}`
    : data.kind === "tool" ? `  ${data.toolName} · ${data.toolState}${data.toolDurationMs === undefined ? "" : ` · ${data.toolDurationMs} ms`}`
    : data.text !== undefined ? String(data.text) : existing + String(data.delta ?? "")
  const rows = state.rows.filter((row) => row.key !== key && !row.key.startsWith(`${key}:`) && !(data.kind === "text" && row.key === "text"))
  rows.push({ key, text: text.slice(-2000) })
  if (data.kind === "tool") {
    if (data.toolInput && typeof data.toolInput === "object") rows.push({ key: `${key}:input`, text: `      → ${JSON.stringify(data.toolInput).slice(0, 1000)}` })
    if (typeof data.toolOutput === "string" && data.toolOutput) rows.push({ key: `${key}:output`, text: `      ← ${data.toolOutput.slice(0, 2000)}` })
    if (typeof data.toolError === "string" && data.toolError) rows.push({ key: `${key}:error`, text: `      ✗ ${data.toolError.slice(0, 1000)}` })
  }
  return { ...state, sessionID: typeof data.sessionID === "string" ? data.sessionID : state.sessionID, textPartID: data.kind === "text" ? String(data.partID) : state.textPartID, rows: rows.slice(-40) }
}
