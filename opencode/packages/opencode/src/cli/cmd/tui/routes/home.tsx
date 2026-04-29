import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, For, onCleanup, onMount, Show } from "solid-js"
import { useCommandDialog } from "@tui/component/dialog-command"
import { DialogProvider as ProviderAuthDialog } from "@tui/component/dialog-provider"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useToast } from "@tui/ui/toast"

export const NEO_RESEARCH_API_KEY_ENVS = [
  "ZHIPU_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "DASHSCOPE_API_KEY",
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

export function Home() {
  let input: TextareaRenderable | undefined
  let focusTimer: ReturnType<typeof setTimeout> | undefined
  const command = useCommandDialog()
  const dialog = useDialog()
  const route = useRoute()
  const sync = useOptionalSync()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const toast = useToast()

  const width = createMemo(() => Math.max(62, Math.min(96, dimensions().width - 8)))
  const top = createMemo(() => Math.max(2, Math.floor(dimensions().height * 0.22)))
  const providerConnected = createMemo(() => Boolean(sync?.data.provider_next.connected.length))
  const needsApiKey = createMemo(() => !hasNeoResearchApiKey() && !providerConnected())
  const actions = createMemo<HomeAction[]>(() =>
    needsApiKey() ? ["Configure API Key", "New CSV Task", "Open Cockpit", "Run Doctor"] : ["New CSV Task", "Open Cockpit", "Run Doctor"],
  )

  const openCockpit = () => route.navigate({ type: "cockpit" })
  const openProviderDialog = () => {
    if (!sync) {
      toast.show({
        variant: "info",
        message: "Set ZHIPU_API_KEY in your shell, then restart NeoResearch.",
        duration: 4000,
      })
      return
    }
    dialog.replace(() => <ProviderAuthDialog />)
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
        runSlashInput(researchGoal)
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
        openProviderDialog()
        dialog.clear()
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
        hintCockpit()
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
      hintCockpit()
      return
    }
    hintDoctor()
  }

  return (
    <box flexGrow={1} alignItems="center" paddingTop={top()}>
      <box width={width()} alignItems="center" gap={2}>
        <box alignItems="center" gap={1}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>
            NEORESEARCH
          </text>
          <text fg={theme.textMuted}>Autonomous TSF research workspace</text>
        </box>

        <box width={width()} backgroundColor={theme.backgroundPanel} paddingLeft={2} paddingRight={2} paddingTop={1}>
          <textarea
            height={1}
            keyBindings={[{ name: "return", action: "submit" }]}
            onSubmit={submitGoal}
            ref={(value: TextareaRenderable) => {
              input = value
            }}
            placeholder={'Ask research goal... "Forecast ETTh1 horizon=24"'}
            placeholderColor={theme.textMuted}
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.primary}
          />
          <box flexDirection="row" gap={2} paddingTop={1}>
            <text fg={theme.primary} attributes={TextAttributes.BOLD}>
              Planner
            </text>
            <text fg={theme.text}>Research Agent</text>
          </box>
        </box>

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
              <text fg={theme.text}>Set ZHIPU_API_KEY in your shell</text>
              <text fg={theme.textMuted}>or</text>
              <text fg={theme.primary} attributes={TextAttributes.BOLD} onMouseUp={openProviderDialog}>
                Connect Provider
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

        <box alignItems="center" gap={1} paddingTop={2}>
          <text fg={theme.textMuted}>Designed for Research OS</text>
          <box flexDirection="row" gap={2}>
            <text fg={theme.textMuted}>enter submit</text>
            <text fg={theme.textMuted}>ctrl+p api-key / cockpit / csv / doctor</text>
            <text fg={theme.textMuted}>doctor env</text>
          </box>
        </box>
      </box>
    </box>
  )
}
