import { For, Show, createMemo, createSignal } from "solid-js"
import { TextAttributes, type RGBA } from "@opentui/core"
import type { LoopState } from "@/research/loop-state-schema"
import { loopBudgetLines, loopPhaseLabel, loopRecoveryLine } from "../routes/research-loop-state"

type Colors = {
  text: string | RGBA
  textMuted: string | RGBA
  primary: string | RGBA
  success: string | RGBA
  warning: string | RGBA
}
const short = (value: string) => value.slice(0, 8)
const record = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" ? (input as Record<string, unknown>) : {}
const training = (strategy: Record<string, unknown>) =>
  `${record(strategy.loss).base ?? "loss unspecified"} · ${record(strategy.optimizer).type ?? "optimizer"} lr=${record(strategy.optimizer).lr ?? "?"} · batch=${record(strategy.budget).batchSize ?? "?"}`
const fixedRecipeSummary = (recipe: Record<string, unknown>) =>
  [
    ...(Array.isArray(record(recipe.preprocessing).actions)
      ? (record(recipe.preprocessing).actions as unknown[]).map((action) => record(action).type)
      : []),
    ...["embedding", "backbone", "fusion", "predictionHead"].map((key) => record(recipe[key]).type),
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" → ")
const value = (input: unknown) => JSON.stringify(input)?.slice(0, 180) ?? "null"

export function ResearchLoopPanel(props: {
  state: LoopState
  now: number
  colors: Colors
  compact?: boolean
  minimal?: boolean
  onOpenHistory?: () => void
}) {
  const [expanded, setExpanded] = createSignal<string>()
  const designs = createMemo(() =>
    props.compact
      ? props.state.designs.filter(
          (design) => design.id === (props.state.activeDesignID ?? props.state.designs.at(-1)?.id),
        )
      : props.state.designs,
  )
  return (
    <box flexDirection="column" gap={0}>
      <Show when={!props.minimal}>
        <text fg={props.colors.primary} attributes={TextAttributes.BOLD}>
          Dual-loop search
        </text>
      </Show>
      <For each={loopBudgetLines(props.state, props.now)}>
        {(line) => (
          <text fg={props.colors.text} width="100%" wrapMode="word">
            {line}
          </text>
        )}
      </For>
      <text
        fg={
          props.state.recovery.recoveryState === "needs_reconciliation" ? props.colors.warning : props.colors.textMuted
        }
        width="100%"
        wrapMode={props.minimal ? "none" : "word"}
        overflow={props.minimal ? "hidden" : undefined}
      >
        {loopRecoveryLine(props.state)}
      </text>
      <Show when={!props.minimal && props.state.bestModel}>
        {(best) => (
          <text fg={props.colors.textMuted} wrapMode="word">
            Cycle best: {best().metric}={best().value} · {short(best().runID)}
          </text>
        )}
      </Show>
      <Show when={!props.state.cycleID}>
        <text fg={props.colors.textMuted}>Training policy binds when the search starts.</text>
      </Show>
      <For each={designs()}>
        {(design) => (
          <box flexDirection="column" paddingTop={props.minimal ? 0 : 1}>
            <text
              fg={design.active ? props.colors.primary : props.colors.text}
              attributes={TextAttributes.BOLD}
              width="100%"
              wrapMode="word"
            >
              Design {design.index}
              {design.reference ? " [reference]" : ""} · {design.hypothesisID ?? "no hypothesis"} ·{" "}
              {design.phase ? loopPhaseLabel(design.phase) : design.status}
            </text>
            <Show when={!props.minimal}>
              <text fg={props.colors.textMuted} wrapMode="word">
                Trials {design.trials.length}/
                {design.reference ? 1 : (props.state.policy?.maxTrialsPerDesign ?? "unbound")} · no improvement{" "}
                {design.noImprove}/{props.state.policy?.maxNoImprovePerDesign ?? "unbound"}
              </text>
            </Show>
            <Show when={!props.compact && fixedRecipeSummary(design.fixedRecipe)}>
              <text fg={props.colors.textMuted} wrapMode="word">
                Fixed design: {fixedRecipeSummary(design.fixedRecipe)}
              </text>
            </Show>
            <Show when={design.bestModel}>
              {(best) => (
                <text fg={props.colors.success} wrapMode="word">
                  Design best: {best().metric}={best().value} · {short(best().runID)}
                </text>
              )}
            </Show>
            <For
              each={
                props.minimal
                  ? design.trials.filter((trial) => trial.id === design.currentTrialID)
                  : props.compact
                    ? design.trials.slice(-3)
                    : design.trials
              }
            >
              {(trial) => (
                <box flexDirection="column" paddingLeft={2}>
                  <text
                    fg={trial.eligibleForRanking ? props.colors.text : props.colors.textMuted}
                    width="100%"
                    wrapMode="word"
                    onMouseUp={() =>
                      props.compact && props.onOpenHistory
                        ? props.onOpenHistory()
                        : setExpanded(expanded() === trial.id ? undefined : trial.id)
                    }
                  >
                    {expanded() === trial.id ? "▾" : "▸"} Trial {trial.index} ·{" "}
                    {trial.full
                      ? `full ${trial.full.status}`
                      : trial.smoke
                        ? `smoke ${trial.smoke.status}`
                        : trial.status}
                    {trial.metricValue !== null ? ` · ${props.state.primaryMetric}=${trial.metricValue}` : ""}
                    {design.bestModel?.runID === trial.full?.id
                      ? " [design best]"
                      : trial.duplicate
                        ? " [cache/duplicate]"
                        : trial.full && !trial.eligibleForRanking
                          ? " [not ranked]"
                          : ""}
                  </text>
                  <Show when={!props.compact || expanded() === trial.id}>
                    <text fg={props.colors.textMuted} wrapMode="word">
                      Full budget charged: {trial.charged ? 1 : 0} · diagnosis {trial.trainingReflection.status} ·
                      optimizer {String(trial.optimizerDecision?.action ?? "pending")}
                    </text>
                    <text fg={props.colors.textMuted} wrapMode="word">
                      Training: {training(trial.trainingStrategy)}
                    </text>
                    <Show when={typeof trial.optimizerDecision?.rationale === "string"}>
                      <text fg={props.colors.textMuted} wrapMode="word">
                        Optimizer: {String(trial.optimizerDecision?.rationale)}
                      </text>
                    </Show>
                    <For each={trial.changes}>
                      {(change) => (
                        <text fg={props.colors.textMuted} wrapMode="word">
                          {change.path}: {value(change.before)} → {value(change.after)}
                        </text>
                      )}
                    </For>
                    <Show when={trial.full?.error ?? trial.smoke?.error}>
                      {(error) => (
                        <text fg={props.colors.warning} wrapMode="word">
                          {error()}
                        </text>
                      )}
                    </Show>
                    <Show when={trial.trainingReflection.summary}>
                      {(summary) => (
                        <text fg={props.colors.textMuted} wrapMode="word">
                          Training reflection: {summary()}
                        </text>
                      )}
                    </Show>
                    <For each={trial.trainingReflection.memoryWrites}>
                      {(write) => (
                        <text fg={props.colors.textMuted} wrapMode="word">
                          Memory {write.purpose}: {write.status}
                          {write.error ? ` · ${write.error}` : ""}
                        </text>
                      )}
                    </For>
                  </Show>
                </box>
              )}
            </For>
            <Show when={props.compact && design.trials.length > 3}>
              <text fg={props.colors.textMuted}>Earlier trials are in Design / Trial history.</text>
            </Show>
            <Show when={!props.compact}>
              <text fg={props.colors.textMuted} wrapMode="word">
                Architecture reflection: {design.architectureReflection.status} · architecture evidence:{" "}
                {String(design.architectureEvidence?.status ?? "pending")}
              </text>
              <For
                each={
                  Array.isArray(design.architectureEvidence?.reasons)
                    ? (design.architectureEvidence!.reasons as string[])
                    : []
                }
              >
                {(reason) => (
                  <text fg={props.colors.textMuted} wrapMode="word">
                    {reason}
                  </text>
                )}
              </For>
              <Show when={design.architectureReflection.summary}>
                {(summary) => (
                  <text fg={props.colors.textMuted} wrapMode="word">
                    {summary()}
                  </text>
                )}
              </Show>
              <For each={design.architectureReflection.memoryWrites}>
                {(write) => (
                  <text fg={props.colors.textMuted} wrapMode="word">
                    Memory {write.purpose}: {write.status}
                    {write.error ? ` · ${write.error}` : ""}
                  </text>
                )}
              </For>
            </Show>
            <Show when={design.stopReason}>
              <text fg={props.colors.textMuted} wrapMode="word">
                Design stopped: {design.stopReason}
              </text>
            </Show>
          </box>
        )}
      </For>
    </box>
  )
}
