import { createResource, onCleanup } from "solid-js"
import { researchCockpitArtifactTarget } from "../routes/research-cockpit-data"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"

export function DialogResearchResults(props: { taskID: string }) {
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  const sdk = useSDK()
  const dialog = useDialog()
  const { theme } = useTheme()
  async function read<T>(path: string): Promise<T> {
    const url = new URL(path, sdk.url)
    if (sdk.directory) url.searchParams.set("directory", sdk.directory)
    const response = await sdk.fetch(url)
    if (!response.ok) throw new Error(await response.text())
    return response.json()
  }
  const [artifacts] = createResource(async () => {
    try {
      return {
        items: await read<Array<{ id: string; kind: string; uri: string }>>(
          `/research/tasks/${encodeURIComponent(props.taskID)}/artifacts`,
        ),
        error: "",
      }
    } catch (error) {
      return { items: [], error: String(error) }
    }
  })
  const artifactTitle = (kind: string) => kind === "final_report_md" ? "Final research report" : kind
  return (
    <DialogSelect
      title={artifacts()?.error || "Research results and artifacts"}
      options={(artifacts()?.items ?? []).toSorted((left, right) => {
        if (left.kind === "final_report_md") return right.kind === "final_report_md" ? 0 : -1
        if (right.kind === "final_report_md") return 1
        return 0
      }).map((artifact) => ({
        title: artifactTitle(artifact.kind),
        description: artifact.uri,
        value: artifact,
      }))}
      onSelect={async ({ value: artifact }) => {
        let text = artifact.uri
        if (artifact.uri.startsWith("file:") && /\.(md|json|txt|log|jsonl)$/i.test(artifact.uri)) {
          try {
            const content = await read<{ type: string; content: string }>(
              `/file/content?path=${encodeURIComponent(researchCockpitArtifactTarget(artifact))}`,
            )
            if (content.type === "text") text = content.content.slice(0, 64_000)
          } catch (error) {
            text = `${artifact.uri}\n\n${error}`
          }
        }
        if (disposed) return
        dialog.replace(() => (
          <box padding={1} gap={1}>
            <text fg={theme.text}>{artifactTitle(artifact.kind)}</text>
            <scrollbox height={20}>
              <text fg={theme.text}>{text}</text>
            </scrollbox>
            <text fg={theme.textMuted}>{artifact.uri} · Esc to go back</text>
          </box>
        ))
      }}
    />
  )
}
