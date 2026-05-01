import { TextareaRenderable, TextAttributes, type KeyEvent } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useCommandDialog } from "@tui/component/dialog-command"
import { DialogProvider as ProviderAuthDialog } from "@tui/component/dialog-provider"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useToast } from "@tui/ui/toast"
import {
  createResearchSlashSelection,
  ResearchSlashMenu,
  moveSlashSelection,
  resolveSlashOption,
  slashMenuHasOptions,
  type SlashOption,
} from "./research-slash-menu"

export const NEO_RESEARCH_API_KEY_ENVS = [
  "NEO_CAST_LLM_API_KEY",
  "OPENAI_API_KEY",
  "AIGCBEST_API_KEY",
  "ANTHROPIC_API_KEY",
] as const

type ApiKeyEnv = Record<string, string | undefined>

export function hasNeoResearchApiKey(env: ApiKeyEnv = process.env) {
  return NEO_RESEARCH_API_KEY_ENVS.some((key) => Boolean(env[key]?.trim()))
}

type HomeAction = "Configure API Key" | "New CSV Task" | "Open Cockpit" | "Run Doctor"

function useOptionalSync() {
  try {
    return useSync()
  } catch {
    return undefined
  }
}

export const NEO_RESEARCH_HOME_BANNER = [
  "N   N EEEE  OOO  RRR  EEEE  SSS  EEEE  A   RRR   CCC H  H",
  "NN  N E    O   O R  R E    S     E    A A  R  R C    H  H",
  "N N N EEE  O   O RRR  EEE   SSS  EEE  AAA  RRR  C    HHHH",
  "N  NN E    O   O R R  E       S  E    A   A R R  C    H  H",
  "N   N EEEE  OOO  R  R EEEE SSS   EEEE A   A R  R  CCC H  H",
] as const

export function Home() {
  let input: TextareaRenderable | undefined
  let focusTimer: ReturnType<typeof setTimeout> | undefined
  let promptedForApiKey = false
  const command = useCommandDialog()
  const dialog = useDialog()
  const route = useRoute()
  const sync = useOptionalSync()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const toast = useToast()
  const slashSelection = createResearchSlashSelection()
  const [inputValue, setInputValue] = createSignal("")

  const width = createMemo(() => Math.max(62, Math.min(96, dimensions().width - 8)))
  const compactHeight = createMemo(() => dimensions().height < 42)
  const top = createMemo(() => (compactHeight() ? 1 : Math.max(2, Math.floor(dimensions().height * 0.22))))
  const verticalGap = createMemo(() => (compactHeight() ? 1 : 2))
  const providerConnected = createMemo(() => Boolean(sync?.data.provider_next.connected.length))
  const needsApiKey = createMemo(() => !hasNeoResearchApiKey() && !providerConnected())
  const actions = createMemo<HomeAction[]>(() =>
    needsApiKey() ? ["Configure API Key", "New CSV Task", "Open Cockpit", "Run Doctor"] : ["New CSV Task", "Open Cockpit", "Run Doctor"],
  )

  const openCockpit = () => route.navigate({ type: "cockpit" })
  const openCsvTask = () => route.navigate({ type: "cockpit", newCsvTask: true })
  const showApiKeyHelp = () =>
    toast.show({
      variant: "info",
      message: "Set NEO_CAST_LLM_API_KEY, OPENAI_API_KEY, AIGCBEST_API_KEY, or ANTHROPIC_API_KEY, then restart NeoResearch.",
      duration: 6000,
    })
  const openProviderDialog = () => {
    if (!sync) {
      showApiKeyHelp()
      return false
    }
    dialog.replace(() => <ProviderAuthDialog />)
    return true
  }
  const hintDoctor = () =>
    toast.show({
      variant: "info",
      message: "Run `neo-research doctor` in your shell to check Neo-Cast and Python.",
      duration: 4000,
    })
  const hintCockpit = () => {
    openCockpit()
    toast.show({
      variant: "info",
      message: "Use New CSV Task in Cockpit to create a TSF task from a local dataset.",
      duration: 4000,
    })
  }
  const submitGoal = () => {
    const researchGoal = input?.plainText.trim()
    if (researchGoal) {
      if (researchGoal.startsWith("/")) {
        if (!runVisibleSlashInput(researchGoal)) runSlashInput(researchGoal)
        input?.clear()
        setInputValue("")
        return
      }
      route.navigate({ type: "cockpit", researchGoal })
      toast.show({
        variant: "info",
        message: "Research goal captured. Cockpit will create an autonomous task.",
        duration: 4000,
      })
      return
    }
    hintCockpit()
  }

  function selectSlashOption(option: SlashOption) {
    option.onSelect?.()
    input?.clear()
    setInputValue("")
  }

  function runVisibleSlashInput(value: string) {
    const option = resolveSlashOption(value, command.slashes(), slashSelection)
    if (!option) return false
    selectSlashOption(option)
    return true
  }

  function handleSlashKeyDown(evt: KeyEvent) {
    const value = input?.plainText ?? inputValue()
    const options = command.slashes()
    if (!slashMenuHasOptions(value, options)) return
    const name = evt.name?.toLowerCase()
    const ctrlOnly = evt.ctrl && !evt.meta && !evt.shift
    if (name === "down" || (ctrlOnly && name === "n")) {
      evt.preventDefault()
      moveSlashSelection(value, options, 1, slashSelection)
      return
    }
    if (name === "up" || (ctrlOnly && name === "p")) {
      evt.preventDefault()
      moveSlashSelection(value, options, -1, slashSelection)
      return
    }
    if (name === "return" || name === "tab") {
      const option = resolveSlashOption(value, options, slashSelection)
      if (!option) return
      evt.preventDefault()
      selectSlashOption(option)
    }
  }

  function runSlashInput(value: string) {
    const command = value.slice(1).trim().toLowerCase()
    if (command === "cockpit") {
      openCockpit()
      return
    }
    if (command === "csv" || command === "dataset") {
      hintCockpit()
      return
    }
    if (command === "doctor") {
      hintDoctor()
      return
    }
    if (command === "api-key" || command === "provider" || command === "auth") {
      openProviderDialog()
      return
    }
    toast.show({
      variant: "info",
      message: `Unknown research command: /${command}`,
      duration: 4000,
    })
  }

  onMount(() => {
    focusTimer = setTimeout(() => input?.focus(), 0)
  })

  createEffect(() => {
    if (promptedForApiKey) return
    if (!needsApiKey()) return
    promptedForApiKey = true
    setTimeout(() => {
      if (!needsApiKey()) return
      showApiKeyHelp()
    }, 0)
  })

  onCleanup(() => {
    if (focusTimer) clearTimeout(focusTimer)
  })

  command.register(() => [
    {
      title: "Open research cockpit",
      value: "research.cockpit.open",
      category: "Research",
      suggested: true,
      slash: {
        name: "cockpit",
      },
      onSelect: (dialog) => {
        openCockpit()
        dialog.clear()
      },
    },
    {
      title: "Configure API key",
      value: "research.provider.configure",
      category: "Research",
      suggested: needsApiKey(),
      slash: {
        name: "api-key",
        aliases: ["provider", "auth"],
      },
      onSelect: (dialog) => {
        if (!openProviderDialog()) dialog.clear()
      },
    },
    {
      title: "Create CSV research task",
      value: "research.csv.new",
      category: "Research",
      suggested: true,
      slash: {
        name: "csv",
        aliases: ["dataset"],
      },
      onSelect: (dialog) => {
        openCsvTask()
        dialog.clear()
      },
    },
    {
      title: "Run environment doctor",
      value: "research.doctor.show",
      category: "Research",
      slash: {
        name: "doctor",
      },
      onSelect: (dialog) => {
        hintDoctor()
        dialog.clear()
      },
    },
  ])

  function runAction(action: HomeAction) {
    if (action === "Configure API Key") {
      openProviderDialog()
      return
    }
    if (action === "Open Cockpit") {
      openCockpit()
      return
    }
    if (action === "New CSV Task") {
      openCsvTask()
      return
    }
    hintDoctor()
  }

  return (
    <box flexGrow={1} alignItems="center" paddingTop={top()}>
      <box width={width()} alignItems="center" gap={verticalGap()}>
        <box alignItems="center" gap={0}>
          <For each={NEO_RESEARCH_HOME_BANNER}>
            {(line) => (
              <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                {line}
              </text>
            )}
          </For>
          <Show when={!compactHeight()}>
            <box height={1} />
          </Show>
          <text fg={theme.textMuted}>Autonomous TSF research workspace</text>
        </box>

        <box width={width()} backgroundColor={theme.backgroundPanel} paddingLeft={2} paddingRight={2} paddingTop={1}>
          <textarea
            height={1}
            keyBindings={[{ name: "return", action: "submit" }]}
            onSubmit={submitGoal}
            onKeyDown={handleSlashKeyDown}
            onContentChange={() => setInputValue(input?.plainText ?? "")}
            ref={(value: TextareaRenderable) => {
              input = value
            }}
            placeholder={'Ask research goal... "Forecast ETTh1 horizon=24"'}
            placeholderColor={theme.textMuted}
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.primary}
          />
          <ResearchSlashMenu
            value={inputValue()}
            options={() => command.slashes()}
            anchor={() => input}
            placement="below"
            colors={{
              panel: theme.backgroundPanel,
              border: theme.border,
              text: theme.text,
              textMuted: theme.textMuted,
              primary: theme.primary,
            }}
            onSelect={selectSlashOption}
            selection={slashSelection}
          />
          <box flexDirection="row" gap={2} paddingTop={1}>
            <text fg={theme.primary} attributes={TextAttributes.BOLD}>
              Planner
            </text>
            <text fg={theme.text}>Research Agent</text>
          </box>
        </box>

        <Show when={compactHeight()}>
          <box alignItems="center" gap={0}>
            <box flexDirection="row" gap={2}>
              <text fg={theme.textMuted}>enter submit</text>
              <text fg={theme.textMuted}>ctrl+p api-key / cockpit / csv / doctor</text>
              <text fg={theme.textMuted}>doctor env</text>
            </box>
          </box>
        </Show>

        <Show when={needsApiKey()}>
          <box
            width={width()}
            backgroundColor={theme.backgroundPanel}
            border={["left"]}
            borderColor={theme.primary}
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
            gap={1}
          >
            <text fg={theme.primary} attributes={TextAttributes.BOLD}>
              Configure API Key
            </text>
            <text fg={theme.textMuted}>NeoResearch needs a model provider key before running the research agent.</text>
            <box flexDirection="row" gap={2}>
              <text fg={theme.text}>Set NEO_CAST_LLM_API_KEY in your shell</text>
              <text fg={theme.textMuted}>or</text>
              <text fg={theme.primary} attributes={TextAttributes.BOLD} onMouseUp={showApiKeyHelp}>
                Show Setup Hint
              </text>
            </box>
          </box>
        </Show>

        <box flexDirection="row" gap={2} justifyContent="center">
          <For each={actions()}>
            {(action) => (
              <text fg={theme.primary} onMouseUp={() => runAction(action)}>
                {action}
              </text>
            )}
          </For>
        </box>

        <Show when={!compactHeight()}>
          <box alignItems="center" gap={1} paddingTop={2}>
            <text fg={theme.textMuted}>Designed for Research OS</text>
            <box flexDirection="row" gap={2}>
              <text fg={theme.textMuted}>enter submit</text>
              <text fg={theme.textMuted}>ctrl+p api-key / cockpit / csv / doctor</text>
              <text fg={theme.textMuted}>doctor env</text>
            </box>
          </box>
        </Show>
      </box>
    </box>
  )
}
