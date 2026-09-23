import { createResource, createSignal } from "solid-js"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { createDebouncedSignal } from "@tui/util/signal"
import type { ResumeState } from "@/research/recovery"

type HistoryPage = {
  items: Array<{ id: string; title: string; mode: string; time: { updated: number }; recovery: ResumeState }>
  nextCursor: string | null
  error?: string
}

export function DialogResearchHistory() {
  const sdk = useSDK()
  const route = useRoute()
  const dialog = useDialog()
  const [search, setSearch] = createDebouncedSignal("", 150)
  const [cursor, setCursor] = createSignal<string>()
  const [page] = createResource(
    () => ({ search: search(), cursor: cursor() }),
    async (query): Promise<HistoryPage> => {
      try {
        const url = new URL("/research/history", sdk.url)
        if (sdk.directory) url.searchParams.set("directory", sdk.directory)
        url.searchParams.set("search", query.search)
        if (query.cursor) url.searchParams.set("cursor", query.cursor)
        const response = await sdk.fetch(url)
        if (!response.ok) throw new Error(await response.text())
        return (await response.json()) as HistoryPage
      } catch (error) {
        return { items: [], nextCursor: null, error: String(error) }
      }
    },
  )
  return (
    <DialogSelect<string>
      title={page()?.error ? `历史研究：${page()?.error}` : page.loading ? "历史研究 · 加载中" : "历史研究"}
      placeholder="搜索标题或研究 ID"
      skipFilter
      onFilter={(query) => {
        setCursor(undefined)
        setSearch(query)
      }}
      options={[
        ...(page()?.items ?? []).map((task) => ({
          title: task.title,
          value: task.id,
          description: `${task.mode} · ${task.recovery.currentPhase} · ${task.recovery.summary}`,
          footer: `${task.recovery.completedRuns} 次完成 · ${new Date(task.time.updated).toLocaleString()}`,
        })),
        ...(page()?.nextCursor ? [{ title: "下一页 →", value: "__next__" }] : []),
        ...(cursor() ? [{ title: "← 返回首页", value: "__first__" }] : []),
      ]}
      onSelect={(option) => {
        if (option.value === "__next__") {
          setCursor(page()?.nextCursor ?? undefined)
          return
        }
        if (option.value === "__first__") {
          setCursor(undefined)
          return
        }
        route.navigate({ type: "cockpit", taskID: option.value })
        dialog.clear()
      }}
    />
  )
}
