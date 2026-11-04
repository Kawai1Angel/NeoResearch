import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { Show, createEffect, onCleanup, onMount, type JSX } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { Spinner } from "../component/spinner"

export type DialogPromptProps = {
  title: string
  description?: () => JSX.Element
  placeholder?: string
  value?: string
  busy?: boolean
  busyText?: string
  onChange?: (value: string) => void
  onConfirm?: (value: string) => void
  onCancel?: () => void
}

export function DialogPrompt(props: DialogPromptProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  let textarea: TextareaRenderable | undefined
  let disposed = false
  let focusTimer: ReturnType<typeof setTimeout> | undefined
  let changeTimer: ReturnType<typeof setTimeout> | undefined
  let submitTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    disposed = true
    textarea?.destroy()
    textarea = undefined
    clearTimeout(focusTimer)
    clearTimeout(changeTimer)
    clearTimeout(submitTimer)
  })

  useKeyboard((evt) => {
    if (props.busy) {
      if (evt.name === "escape") return
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
    // The textarea's submit binding handles Enter once. Calling onConfirm here
    // as well can replace/destroy the dialog while native input is dispatching.
  })

  onMount(() => {
    dialog.setSize("medium")
    focusTimer = setTimeout(() => {
      if (disposed) return
      if (!textarea || textarea.isDestroyed) return
      if (props.busy) return
      textarea.focus()
    }, 1)
    textarea?.gotoLineEnd()
  })

  createEffect(() => {
    if (!textarea || textarea.isDestroyed) return
    const traits = props.busy
      ? {
          suspend: true,
          status: "BUSY",
        }
      : {}
    textarea.traits = traits
    if (props.busy) {
      textarea.blur()
      return
    }
    textarea.focus()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1}>
        {props.description}
        <textarea
          onSubmit={() => {
            if (props.busy || !textarea || submitTimer) return
            const value = textarea.plainText
            submitTimer = setTimeout(() => {
              submitTimer = undefined
              if (!disposed && !props.busy) props.onConfirm?.(value)
            }, 0)
          }}
          height={3}
          onContentChange={() => {
            if (props.busy || !textarea) return
            const value = textarea.plainText
            clearTimeout(changeTimer)
            // Validation can change layout or replace the dialog. Let the
            // native edit-buffer callback finish before applying those updates.
            changeTimer = setTimeout(() => {
              changeTimer = undefined
              if (!disposed && !props.busy) props.onChange?.(value)
            }, 0)
          }}
          keyBindings={props.busy ? [] : [{ name: "return", action: "submit" }]}
          ref={(val: TextareaRenderable) => {
            textarea = val
          }}
          initialValue={props.value}
          placeholder={props.placeholder ?? "Enter text"}
          placeholderColor={theme.textMuted}
          textColor={props.busy ? theme.textMuted : theme.text}
          focusedTextColor={props.busy ? theme.textMuted : theme.text}
          cursorColor={props.busy ? theme.backgroundElement : theme.text}
        />
        <Show when={props.busy}>
          <Spinner color={theme.textMuted}>{props.busyText ?? "Working..."}</Spinner>
        </Show>
      </box>
      <box paddingBottom={1} gap={1} flexDirection="row">
        <Show when={!props.busy} fallback={<text fg={theme.textMuted}>processing...</text>}>
          <text fg={theme.text}>
            enter <span style={{ fg: theme.textMuted }}>submit</span>
          </text>
        </Show>
      </box>
    </box>
  )
}

DialogPrompt.show = (dialog: DialogContext, title: string, options?: Omit<DialogPromptProps, "title">) => {
  return new Promise<string | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogPrompt title={title} {...options} onConfirm={(value) => resolve(value)} onCancel={() => resolve(null)} />
      ),
      () => resolve(null),
    )
  })
}
