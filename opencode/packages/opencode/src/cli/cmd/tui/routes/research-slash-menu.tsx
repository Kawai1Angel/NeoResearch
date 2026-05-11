import { TextAttributes, type ColorInput, type Renderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"

export type SlashOption = {
  display: string
  description?: string
  aliases?: string[]
  onSelect?: () => void
}

const slashPriority = [
  "/cockpit",
  "/csv",
  "/new",
  "/dataset",
  "/run",
  "/loop",
  "/task",
  "/candidate",
  "/runner",
  "/mode",
  "/seed",
  "/export",
  "/abort",
  "/help",
  "/home",
  "/doctor",
  "/api-key",
]

const slashWindowSize = 8

export function createResearchSlashSelection() {
  const selectedIndexes = new Map<string, number>()
  const [revision, setRevision] = createSignal(0)
  return {
    selectedIndexes,
    revision,
    bump: () => setRevision((value) => value + 1),
  }
}

export type ResearchSlashSelection = ReturnType<typeof createResearchSlashSelection>

export function resetResearchSlashMenuSelectionForTest() {
  return
}

export function slashInputQuery(value: string) {
  if (!value.startsWith("/")) return
  const query = value.slice(1).trimEnd()
  if (query.match(/\s/)) return
  return query.toLowerCase()
}

function slashSelectionKey(value: string, options: SlashOption[]) {
  const query = slashInputQuery(value)
  if (query === undefined) return
  return `${options.map((option) => option.display.trim()).join("\x00")}::/${query}`
}

function clampIndex(value: number, length: number) {
  if (length <= 0) return 0
  return Math.max(0, Math.min(value, length - 1))
}

function selectedIndexFor(value: string, options: SlashOption[], selection?: ResearchSlashSelection) {
  const key = slashSelectionKey(value, options)
  if (!key) return 0
  return clampIndex(selection?.selectedIndexes.get(key) ?? 0, slashOptionMatches(value, options).length)
}

export function moveSlashSelection(
  value: string,
  options: SlashOption[],
  direction: -1 | 1,
  selection?: ResearchSlashSelection,
) {
  const key = slashSelectionKey(value, options)
  const matches = slashOptionMatches(value, options)
  if (!key || matches.length === 0) return
  const next = (selectedIndexFor(value, options, selection) + direction + matches.length) % matches.length
  selection?.selectedIndexes.set(key, next)
  selection?.bump()
  return matches[next]
}

export function slashMenuHasOptions(value: string, options: SlashOption[]) {
  return slashInputQuery(value) !== undefined && slashOptionMatches(value, options).length > 0
}

function slashInputToken(value: string) {
  const token = value.trim().split(/\s+/, 1)[0]
  if (!token?.startsWith("/")) return
  return token.toLowerCase()
}

function priority(option: SlashOption) {
  const display = option.display.trim().toLowerCase()
  const index = slashPriority.indexOf(display)
  return index === -1 ? slashPriority.length : index
}

function slashNames(option: SlashOption) {
  return [option.display, ...(option.aliases ?? [])].map((value) => value.trim().toLowerCase())
}

function slashMatchRank(option: SlashOption, query: string) {
  const names = slashNames(option)
  if (names.some((name) => name.startsWith(`/${query}`) || name.startsWith(query))) return 0
  if (names.some((name) => name.includes(query))) return 1
  return 2
}

function rankOptions(options: SlashOption[], query: string) {
  if (query.length > 0) {
    return options.sort(
      (a, b) =>
        slashMatchRank(a, query) - slashMatchRank(b, query) ||
        priority(a) - priority(b) ||
        a.display.localeCompare(b.display),
    )
  }

  const byDisplay = new Map(options.map((option) => [option.display.trim().toLowerCase(), option]))
  const prioritized = slashPriority.flatMap((display) => {
    const option = byDisplay.get(display)
    return option ? [option] : []
  })
  const selected = new Set(prioritized)
  const rest = options
    .filter((option) => !selected.has(option))
    .sort((a, b) => a.display.localeCompare(b.display))
  return [...prioritized, ...rest]
}

export function slashOptionMatches(value: string, options: SlashOption[]) {
  const token = slashInputToken(value)
  if (token === undefined) return []
  const query = token.slice(1)
  return rankOptions(
    options.filter((option) => {
      if (!query) return true
      return slashNames(option).some((name) => name.includes(query))
    }),
    query,
  )
}

export function resolveSlashOption(value: string, options: SlashOption[], selection?: ResearchSlashSelection) {
  const token = slashInputToken(value)
  if (token === undefined) return
  const exact = options.find((option) => slashNames(option).some((name) => name === token))
  if (exact) return exact
  const matches = slashOptionMatches(value, options)
  return matches[selectedIndexFor(value, options, selection)]
}

function shortDescription(value: string | undefined) {
  if (!value) return ""
  return value.length > 48 ? `${value.slice(0, 45)}...` : value
}

export function ResearchSlashMenu(props: {
  value: string
  options: () => SlashOption[]
  anchor?: () => Renderable | undefined
  placement?: "above" | "below"
  colors: {
    panel: ColorInput
    border: ColorInput
    text: ColorInput
    textMuted: ColorInput
    primary: ColorInput
  }
  onSelect?: (option: SlashOption) => void
  selection?: ResearchSlashSelection
}) {
  const localSelection = createResearchSlashSelection()
  const selection = () => props.selection ?? localSelection
  const [positionTick, setPositionTick] = createSignal(0)
  const matches = createMemo(() => {
    const query = slashInputQuery(props.value)
    if (query === undefined) return []
    return slashOptionMatches(props.value, props.options())
  })
  const selectionKey = createMemo(() => slashSelectionKey(props.value, props.options()))
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const windowStart = createMemo(() => {
    const length = matches().length
    const selected = clampIndex(selectedIndex(), length)
    if (length <= slashWindowSize) return 0
    return Math.min(Math.max(0, selected - slashWindowSize + 2), length - slashWindowSize)
  })
  const visibleMatches = createMemo(() => matches().slice(windowStart(), windowStart() + slashWindowSize))
  const selectedOption = createMemo(() => matches()[clampIndex(selectedIndex(), matches().length)])
  const menuHeight = createMemo(() => Math.min(matches().length, slashWindowSize) + 1)
  const position = createMemo(() => {
    const anchor = props.anchor?.()
    if (!anchor) return
    positionTick()
    const parent = anchor.parent
    const parentX = parent?.x ?? 0
    const parentY = parent?.y ?? 0
    const anchorHeight = Math.max(1, anchor.height ?? 1)
    const left = Math.max(0, anchor.x - parentX)
    const parentWidth = parent?.width ?? anchor.width ?? 32
    const availableWidth = Math.max(anchor.width ?? 0, parentWidth - left - 1)
    return {
      left,
      top:
        props.placement === "above"
          ? anchor.y - parentY - menuHeight() - 1
          : anchor.y - parentY + anchorHeight,
      width: Math.max(48, Math.min(80, availableWidth)),
    }
  })
  const windowLabel = createMemo(() => {
    const length = matches().length
    if (length <= slashWindowSize) return ""
    const start = windowStart() + 1
    const end = Math.min(windowStart() + slashWindowSize, length)
    return `${start}-${end}/${length}`
  })
  let previousSelectionKey: string | undefined

  createEffect(() => {
    const currentSelection = selection()
    currentSelection.revision()
    const key = selectionKey()
    if (!key) {
      previousSelectionKey = undefined
      setSelectedIndex(0)
      return
    }
    if (key !== previousSelectionKey) {
      previousSelectionKey = key
      currentSelection.selectedIndexes.set(key, 0)
      setSelectedIndex(0)
      return
    }
    setSelectedIndex(clampIndex(currentSelection.selectedIndexes.get(key) ?? 0, matches().length))
  })

  createEffect(() => {
    if (matches().length === 0 || !props.anchor) return
    let last = { x: 0, y: 0, width: 0, height: 0 }
    const interval = setInterval(() => {
      const anchor = props.anchor?.()
      if (!anchor) return
      const next = { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height }
      if (next.x === last.x && next.y === last.y && next.width === last.width && next.height === last.height) return
      last = next
      setPositionTick((tick) => tick + 1)
    }, 50)
    onCleanup(() => clearInterval(interval))
  })

  useKeyboard((evt) => {
    const length = matches().length
    const key = selectionKey()
    if (!key || length === 0) return
    if (evt.name !== "up" && evt.name !== "down") return
    evt.preventDefault()
    const next =
      evt.name === "down"
        ? (selectedIndex() + 1) % length
        : (selectedIndex() - 1 + length) % length
    const currentSelection = selection()
    currentSelection.selectedIndexes.set(key, next)
    currentSelection.bump()
    setSelectedIndex(next)
  })

  function select(option: SlashOption) {
    if (props.onSelect) {
      props.onSelect(option)
      return
    }
    option.onSelect?.()
  }

  return (
    <Show when={matches().length > 0}>
      <box
        position={position() ? "absolute" : undefined}
        top={position()?.top}
        left={position()?.left}
        width={position()?.width}
        zIndex={200}
        height={menuHeight()}
        backgroundColor={props.colors.panel}
        border={["left"]}
        borderColor={props.colors.border}
        paddingLeft={1}
        paddingRight={1}
        gap={0}
      >
        <box height={1} width="100%" flexDirection="row" gap={2}>
          <text fg={props.colors.primary} attributes={TextAttributes.BOLD}>
            Commands
          </text>
          <Show when={selectedOption()}>
            {(option) => (
              <text fg={props.colors.text} wrapMode="none">
                Selected {option().display.trim()} {shortDescription(option().description)}
              </text>
            )}
          </Show>
          <Show when={windowLabel()}>
            <text fg={props.colors.textMuted}>{windowLabel()}</text>
          </Show>
        </box>
        <For each={visibleMatches()}>
          {(option, index) => (
            <box
              height={1}
              width="100%"
              flexDirection="row"
              gap={2}
              backgroundColor={windowStart() + index() === selectedIndex() ? props.colors.primary : undefined}
              onMouseUp={() => select(option)}
            >
              <text fg={windowStart() + index() === selectedIndex() ? props.colors.panel : props.colors.primary}>
                {option.display.trim()}
              </text>
              <text
                fg={windowStart() + index() === selectedIndex() ? props.colors.panel : props.colors.textMuted}
                wrapMode="none"
              >
                {shortDescription(option.description)}
              </text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}
