# HypoPlanner Agent - TUI Fluid Rendering Scheme

> Target: As in CastClaw_own, original information such as LLM generation responses, tool calls, call results is rendered to TUI on a real-time basis instead of showing structured summaries only after the task has been completed.

---

## Situation analysis

### Call Path

HypoPlanner goes **neoresearch session engine path** instead of direct LLM API:

```
service.ts
  → requestViaSession()          # Create subsession, call LLM through sessionPrompt.prompt()
      → Session engine handles tool calls   # Provider-independent, centralized engine handling
      Send MessageV2.Event.PartDelta (BusEvent, text increment)
      Send MessageV2.Event.PartUpdated (SyncEvent, Partshot, with ToolPart)
```

This means:
- **Tool call capability already in place**, covered by the session engine, does not need to match SSE formats for individual processes
- **provider does not matter**: Anthropic, OpenAI-compat or any other provider follows the same logic

### What's the problem?

`requestViaSession` (`service.ts:3733-3744`) subscribes only to text increments:

```typescript
bus.subscribe(MessageV2.Event.PartDelta).pipe(
  Stream.filter((event) =>
    event.properties.sessionID === child.id &&
    event.properties.field === "text",  // ← Forward text deltas only
  ),
  Stream.runForEach((event) => onDelta(event.properties.delta)),
)
```

`MessageV2.Event.PartUpdated` contains complete `ToolPart` snapshots (tool name, input, state: pending/running/completed, output), but** is not subscribed to at all. Information is discarded on the session level and does not ejaculate into a search Bus, which TUI naturally cannot see.

### CastClaw_own approach

CastClaw direct consumption of `message.part.updated` event render full Part list:

```
Text text fluent text
Tool call for tool tool (including name, input, output, state: pending/running/completed/error)
```

TUI selects the rendering component by part type, Part Snapshot Replace (rather than Incremental Diff), `partID` remains unchanged to make Solid.js efficient.

---

## Design objectives

Take HypoPlanner, for example, to achieve the following TUI visible information:

```
[HypoPlanner] Start planning assumptions...
  ▸ text  "I will first read the current hypothesis pool, then..."   (streaming)
  ▸ tool  read_hypothesis_pool            (🔵 running)
          input:  { taskID: "abc123" }
  ▸ tool  read_hypothesis_pool            (✅ done, 12ms)
          output: { count: 3, hypotheses: [...] }
  ▸ text  "There are currently three hypotheses; the priority distribution..."  (streaming)
  ▸ tool  write_hypothesis                (✅ done, 8ms)
[HypoPlanner] Completed - Generate 4 assumptions
```

---

## Programme

### 1. Add Event Type (`research/event.ts`)

```typescript
// Snapshot of a single Part (Text Block or Tool Call)
export class ResearchAgentPart extends Schema.Class<ResearchAgentPart>("ResearchAgentPart")({
  taskID: ResearchTaskID,
  agent: Schema.String,
  partID: Schema.String,         // Stable ID (from MessageV2.PartID) for Solid.js key provision
  kind: Schema.Literals(["text", "tool"]),

  // kind === "text"
  text: Schema.optional(Schema.String),

  // kind === "tool"
  toolName: Schema.optional(Schema.String),
  toolInput: Schema.optional(Schema.Unknown),
  toolOutput: Schema.optional(Schema.Unknown),
  toolState: Schema.optional(Schema.Literals(["pending", "running", "completed", "error"])),
  toolDurationMs: Schema.optional(Schema.Number),
  toolError: Schema.optional(Schema.String),
}) {}

// Register in Event object
export const Event = {
  // There's been an incident.
  HypoPlannerAgentPartUpdated: BusEvent.define(
    "research.agent.hypoPlanner.part.updated",
    ResearchAgentPart,
  ),
}
```

> **Why "show" instead of incremental?**
> The state of `ToolPart` will be updated several times with a snapshot replacement easier than diff check;`partID` remains unchanged to make Solid.js efficient. Text part is the same, cumulatively replaced as a whole.

---

### 2. `requestViaSession` - Add `onPartUpdated`

Add an optional callback to the `requestViaSession` signature for the `service.ts:3711` function and subscribe additional `MessageV2.Event.PartUpdated` in the `Effect.scoped` block:

```typescript
const requestViaSession = (input: {
  readonly rootSessionID: string | undefined
  readonly agent: string
  readonly stageLabel: string
  readonly taskID: string
  readonly user: string
  readonly modelRef: NeoResearchModelRef | undefined
  readonly onDelta?: (delta: string) => Effect.Effect<void>
  readonly onPartUpdated?: (part: MessageV2.Part) => Effect.Effect<void>  // New
}) =>
  Effect.gen(function* () {
    if (!input.rootSessionID || !input.modelRef) return undefined
    const child = yield* session.create({ ... })

    const result = (input.onDelta || input.onPartUpdated)
      ? yield* Effect.scoped(
          Effect.gen(function* () {
            // Already: text delta subscription
            if (input.onDelta) {
              yield* Effect.forkScoped(
                bus.subscribe(MessageV2.Event.PartDelta).pipe(
                  Stream.filter((e) => e.properties.sessionID === child.id && e.properties.field === "text"),
                  Stream.runForEach((e) => input.onDelta!(e.properties.delta)),
                ),
              )
            }
            // New: Part Snapshot Subscriptions (with ToolPart)
            if (input.onPartUpdated) {
              yield* Effect.forkScoped(
                bus.subscribe(MessageV2.Event.PartUpdated).pipe(
                  Stream.filter((e) => e.properties.sessionID === child.id),
                  Stream.runForEach((e) => input.onPartUpdated!(e.properties.part)),
                ),
              )
            }
            return yield* sessionPrompt.prompt({ ... })
          }),
        )
      : yield* sessionPrompt.prompt({ ... })

    // ... follow-up text adhesion, usage extraction is the same
  })
```

> ** `PartUpdated` Go Bus is OK**: `SyncEvent.run()` Default `publish: true` (`sync/index.ts:245`), Internal `ProjectBus.publish()` (`sync/index.ts:163`).`session.ts:522` did not pass `{ publish: false }` when it triggers `PartUpdated`, so every change in Part status arrives at Bus, and `bus.subscribe(MessageV2.Event.PartUpdated)` can be used directly.

---

### 3. `service.ts` HypoPlanner Caller Use - Send Back Call and Forward to Research Bus

Add `onPartUpdated` to the `requestViaSession` call at `service.ts:7344`:

```typescript
const hypoSessionAttempt = yield* requestViaSession({
  rootSessionID: task.sessionID,
  agent: "research-hypo-planner",
  stageLabel: "HypoPlanner",
  taskID: task.id,
  user: buildHypoPlannerUserPrompt(...),
  modelRef: mapToModelRef(hypoConfig),
  onDelta: (delta) =>
    bus.publish(Event.HypoPlannerAgentStreamDelta, { taskID: task.id, agent: "HypoPlannerAgent", delta }),
  onPartUpdated: (part) => {  // New
    if (part.type === "text") {
      return bus.publish(Event.HypoPlannerAgentPartUpdated, {
        taskID: task.id,
        agent: "HypoPlannerAgent",
        partID: part.id,
        kind: "text",
        text: part.text,
      })
    }
    if (part.type === "tool") {
      const state = part.state
      return bus.publish(Event.HypoPlannerAgentPartUpdated, {
        taskID: task.id,
        agent: "HypoPlannerAgent",
        partID: part.id,
        kind: "tool",
        toolName: part.tool,
        toolInput: state.type !== "pending" ? state.input : undefined,
        toolOutput: state.type === "completed" ? state.output : undefined,
        toolState: state.type === "error" ? "error"
          : state.type === "completed" ? "completed"
          : state.type === "running" ? "running"
          : "pending",
        toolDurationMs: state.type === "completed" ? state.time?.end - state.time?.start : undefined,
        toolError: state.type === "error" ? state.output : undefined,
      })
    }
    return Effect.void
  },
})
```

> The existing `HypoPlannerAgentStreamDelta` remains unchanged and can be used for backward compatibility or simple log scenes.`HypoPlannerAgentPartUpdated` is a more complete alternative, and TUI can only consume this event.

---

### 4. `cockpit.tsx` - Subscribe and render Part Events

#### 4a. Status data structure

```typescript
// Part Map, partID is key
const [agentParts, setAgentParts] = createSignal<Map<string, ResearchAgentPartShape>>(new Map())
// Ordered partID list (deciding order)
const [agentPartOrder, setAgentPartOrder] = createSignal<string[]>([])
```

#### 4b. Event subscription (add to existing event handler switch)

```typescript
if (researchPayload.type === "research.agent.hypoPlanner.part.updated") {
  const data = researchPayload.properties as ResearchAgentPartShape
  if (task && data.taskID !== task.id) return

  setAgentParts((prev) => {
    const next = new Map(prev)
    next.set(data.partID, data)
    return next
  })
  setAgentPartOrder((prev) =>
    prev.includes(data.partID) ? prev : [...prev, data.partID],
  )
  return
}
```

#### 4c. Render components

```tsx
function AgentPartList(props: { parts: Map<string, ResearchAgentPartShape>; order: string[] }) {
  return (
    <For each={props.order}>
      {(partID) => {
        const part = () => props.parts.get(partID)!
        return (
          <Show when={part()}>
            <Switch>
              <Match when={part().kind === "text"}>
                <AgentTextPart text={part().text ?? ""} />
              </Match>
              <Match when={part().kind === "tool"}>
                <AgentToolPart part={part()} />
              </Match>
            </Switch>
          </Show>
        )
      }}
    </For>
  )
}

function AgentTextPart(props: { text: string }) {
  return (
    <For each={props.text.split("\n").filter(Boolean)}>
      {(line) => <text color="white">  {line}</text>}
    </For>
  )
}

function AgentToolPart(props: { part: ResearchAgentPartShape }) {
  const stateIcon = () => ({
    pending:   "⏳",
    running:   "🔵",
    completed: "✅",
    error:     "❌",
  })[props.part.toolState ?? "pending"]

  return (
    <box>
      <text color="cyan">  ▸ tool  {props.part.toolName}   {stateIcon()}</text>
      <Show when={props.part.toolInput !== undefined}>
        <text color="gray">          input:  {JSON.stringify(props.part.toolInput)}</text>
      </Show>
      <Show when={props.part.toolOutput !== undefined}>
        <text color={props.part.toolState === "error" ? "red" : "green"}>
          {"          output: " + JSON.stringify(props.part.toolOutput).slice(0, 120)}
        </text>
      </Show>
      <Show when={props.part.toolDurationMs !== undefined}>
        <text color="gray">          ({props.part.toolDurationMs}ms)</text>
      </Show>
    </box>
  )
}
```

#### 4d. Cleaning

```typescript
// Reset in HypoPlannerAgentStarted treatment (rather than Completed) to avoid last-round residue
if (researchPayload.type === "research.agent.hypoPlanner.started") {
  setAgentParts(new Map())
  setAgentPartOrder([])
  // The rest is logical.
}
```

---

### 5. Optional: Enduring to session stream.log

Reuse existing `persistResearchSessionStreamLines()` in `onPartUpdated` return:

```typescript
if (part.type === "tool" && part.state.type === "completed") {
  persistResearchSessionStreamLines(task.id, [
    { text: `[tool] ${part.tool} → ${durationMs}ms` },
    { text: `  input:  ${JSON.stringify(state.input).slice(0, 200)}` },
    { text: `  output: ${JSON.stringify(state.output).slice(0, 200)}` },
  ])
}
```

---

## Order of implementation

| Steps | Documentation | Workload |
|---|---|---|
| 1. Add `ResearchAgentPart` schemea+`HypoPlannerAgentPartUpdated` event | `research/event.ts` | Small |
| 2. `requestViaSession` Add `onPartUpdated` Callback +subscribe to `MessageV2.Event.PartUpdated` | `research/service.ts` | Small |
| 4. HypoPlanner for transfer to `onPartUpdated` and forward to research bus | `research/service.ts` | Small |
| 5. cockpit.tsx Add Part Status + Event Subscription + Rendering Component | `research-cockpit.tsx` | Medium |
| 6. Add tests: mock PartUpdated events → assert TUI state transitions | `test/research/` | Small |

---

## Reuse with other Agent

`onPartUpdated` echoes for `requestViaSession` are generic, and DataAnalysis and ReflectionAgent simply need to transfer back calls for their respective uses and register the corresponding `part.updated` event type in `Event` objects. Rendering components (`AgentPartList`/ `AgentToolPart`) can be reused directly.
