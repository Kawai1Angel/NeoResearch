import { createSignal, For } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import type { DialogContext } from "../ui/dialog"
import {
  LoopConfigurationSchema,
  type LoopConfiguration,
  type LoopConfigurationState,
} from "@/research/loop-control-schema"

export const loopConfigurationFields: Array<{ key: keyof LoopConfiguration; label: string; help: string }> = [
  {
    key: "maxIterations",
    label: "Shared full-training limit",
    help: "Shared across all Designs. Each reserved full-training attempt uses one slot.",
  },
  {
    key: "maxTrialsPerDesign",
    label: "Trials per Design",
    help: "Includes the initial Trial. The architecture and preprocessing remain fixed.",
  },
  {
    key: "maxNoImprovePerDesign",
    label: "No-improvement Trials per Design",
    help: "Stop tuning this Design after this many eligible Trials without improvement.",
  },
  {
    key: "maxNoImprove",
    label: "Global no-improvement limit",
    help: "Stop the search after this many eligible full runs without improvement.",
  },
  {
    key: "maxRuns",
    label: "Run-record safety limit",
    help: "Smoke and full runs consume this separate task-wide limit. Maximum 200.",
  },
  {
    key: "timeBudgetSeconds",
    label: "Global deadline (seconds)",
    help: "Wall-clock budget for this cycle, including pauses. Enter none for no deadline.",
  },
  {
    key: "targetMetricValue",
    label: "Target metric",
    help: "Stop once the objective reaches this value. Enter none to disable.",
  },
  {
    key: "minRelativeImprovement",
    label: "Minimum relative improvement",
    help: "Improvement threshold used to count global plateau runs. Example: 0.01.",
  },
  {
    key: "maxCrashStreak",
    label: "Consecutive crash limit",
    help: "Stop after this many failed training attempts in a row.",
  },
]

export function parseLoopConfigurationField(draft: LoopConfiguration, key: keyof LoopConfiguration, text: string) {
  const value = text.trim().toLowerCase()
  const nullable = key === "timeBudgetSeconds" || key === "targetMetricValue"
  const next = nullable && ["", "none", "off"].includes(value) ? null : value === "" ? NaN : Number(value)
  return LoopConfigurationSchema.safeParse({ ...draft, [key]: next })
}

/** Keep an unapplied draft until Save; closing or editing never starts training. */
export function openLoopConfiguration(
  dialog: DialogContext,
  state: LoopConfigurationState,
  save: (value: LoopConfiguration) => Promise<void>,
) {
  let draft = structuredClone(state.configuration)
  let saving = false
  let error = ""
  const show = () =>
    dialog.replace(() => (
      <box>
        <box paddingLeft={4} paddingRight={4}>
          <text>
            {state.locked ? state.lockReason : "Applied before this cycle starts. Starting the cycle fixes its policy."}
          </text>
          {error ? <text>{error}</text> : null}
        </box>
        <DialogSelect
          title={
            saving ? "Saving loop configuration..." : state.locked ? "Loop configuration (fixed)" : "Loop configuration"
          }
          options={[
            ...loopConfigurationFields.map((field) => ({
              title: field.label,
              value: field.key,
              description: String(draft[field.key] ?? "none"),
              onSelect: () => {
                if (state.locked || saving) return
                dialog.replace(() => {
                  const [issues, setIssues] = createSignal<string[]>([])
                  return (
                    <DialogPrompt
                      title={field.label}
                      value={String(draft[field.key] ?? "none")}
                      description={() => (
                        <box>
                          <text>{field.help}</text>
                          <For each={issues()}>{(issue) => <text>{issue}</text>}</For>
                        </box>
                      )}
                      onChange={(value) => {
                        const parsed = parseLoopConfigurationField(draft, field.key, value)
                        setIssues(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message))
                      }}
                      onConfirm={(value) => {
                        const parsed = parseLoopConfigurationField(draft, field.key, value)
                        if (!parsed.success) {
                          setIssues(parsed.error.issues.map((issue) => issue.message))
                          return
                        }
                        draft = parsed.data
                        show()
                      }}
                    />
                  )
                })
              },
            })),
            ...(!state.locked && !saving
              ? [
                  {
                    title: "Save configuration",
                    value: "save",
                    onSelect: () => {
                      saving = true
                      show()
                      const entry = dialog.stack.at(-1)
                      void save(draft)
                        .then(() => {
                          if (dialog.stack.at(-1) === entry) dialog.clear()
                        })
                        .catch((cause) => {
                          error = cause instanceof Error ? cause.message : String(cause)
                          saving = false
                          if (dialog.stack.at(-1) === entry) show()
                        })
                    },
                  },
                ]
              : []),
          ]}
        />
      </box>
    ))
  show()
}
