# HypoPlanner Agent — TUI 流式渲染方案

> 目标：像 CastClaw_own 那样，将 LLM 的生成回复、工具调用、调用结果等原始信息实时渲染到 TUI 上，而不是只在任务完成后显示结构化摘要。

---

## 现状分析

### 调用路径

HypoPlanner 走的是 **opencode session 引擎路径**，而不是直接调 LLM API：

```
service.ts
  → requestViaSession()          # 创建子 session，通过 sessionPrompt.prompt() 调用 LLM
      → session 引擎处理工具调用   # provider 无关，引擎统一处理
      → 发出 MessageV2.Event.PartDelta    (BusEvent，文本增量)
      → 发出 MessageV2.Event.PartUpdated  (SyncEvent，Part 快照，含 ToolPart)
```

这意味着：
- **工具调用能力已经有了**，由 session 引擎负责，不需要针对各 provider 的 SSE 格式做适配
- **provider 无关**：Anthropic、OpenAI-compat 或其他任何 provider 都走同一套逻辑

### 问题所在

`requestViaSession`（`service.ts:3733-3744`）只订阅了文本增量：

```typescript
bus.subscribe(MessageV2.Event.PartDelta).pipe(
  Stream.filter((event) =>
    event.properties.sessionID === child.id &&
    event.properties.field === "text",  // ← 只转发文本 delta
  ),
  Stream.runForEach((event) => onDelta(event.properties.delta)),
)
```

`MessageV2.Event.PartUpdated` 包含完整的 `ToolPart` 快照（tool name、input、state: pending/running/completed、output），但**完全没被订阅**，信息在 session 层就被丢弃了，不会冒泡到 research bus，TUI 自然看不到。

### CastClaw_own 的做法

CastClaw 直接消费 `message.part.updated` 事件渲染完整 Part 列表：

```
text  → 流式文字内容
tool  → 工具调用（含 name, input, output, state: pending/running/completed/error）
```

TUI 按 part 类型选择渲染组件，Part 快照替换（而非增量 diff），`partID` 不变让 Solid.js 高效 reconcile。

---

## 设计目标

以 HypoPlanner 为例，实现以下 TUI 可见信息：

```
[HypoPlanner] 开始规划假设 ...
  ▸ text  "我将先读取当前假设池，然后..."   (流式滚动)
  ▸ tool  read_hypothesis_pool            (🔵 running)
          input:  { taskID: "abc123" }
  ▸ tool  read_hypothesis_pool            (✅ done, 12ms)
          output: { count: 3, hypotheses: [...] }
  ▸ text  "当前有 3 个假设，优先级分布..."  (流式滚动)
  ▸ tool  write_hypothesis                (✅ done, 8ms)
[HypoPlanner] 完成 — 生成 4 个假设
```

---

## 方案

### 1. 新增事件类型（`research/event.ts`）

```typescript
// 单个 Part（文本块 or 工具调用）的快照
export class ResearchAgentPart extends Schema.Class<ResearchAgentPart>("ResearchAgentPart")({
  taskID: ResearchTaskID,
  agent: Schema.String,
  partID: Schema.String,         // 稳定 ID（来自 MessageV2.PartID），用于 Solid.js key reconciliation
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

// 在 Event 对象中注册
export const Event = {
  // ... 已有事件 ...
  HypoPlannerAgentPartUpdated: BusEvent.define(
    "research.agent.hypoPlanner.part.updated",
    ResearchAgentPart,
  ),
}
```

> **为什么用「快照」而不是增量？**
> `ToolPart` 的 state 会经历 pending → running → completed 多次更新，快照替换比 diff patch 更简单；`partID` 不变可让 Solid.js 高效 reconcile。文本 part 同理，累积后整体替换。

---

### 2. `requestViaSession` — 增加 `onPartUpdated` 回调

在 `service.ts:3711` 的 `requestViaSession` 函数签名中增加一个可选回调，并在 `Effect.scoped` 块内额外订阅 `MessageV2.Event.PartUpdated`：

```typescript
const requestViaSession = (input: {
  readonly rootSessionID: string | undefined
  readonly agent: string
  readonly stageLabel: string
  readonly taskID: string
  readonly user: string
  readonly modelRef: OpencodeModelRef | undefined
  readonly onDelta?: (delta: string) => Effect.Effect<void>
  readonly onPartUpdated?: (part: MessageV2.Part) => Effect.Effect<void>  // ← 新增
}) =>
  Effect.gen(function* () {
    if (!input.rootSessionID || !input.modelRef) return undefined
    const child = yield* session.create({ ... })

    const result = (input.onDelta || input.onPartUpdated)
      ? yield* Effect.scoped(
          Effect.gen(function* () {
            // 已有：文本 delta 订阅
            if (input.onDelta) {
              yield* Effect.forkScoped(
                bus.subscribe(MessageV2.Event.PartDelta).pipe(
                  Stream.filter((e) => e.properties.sessionID === child.id && e.properties.field === "text"),
                  Stream.runForEach((e) => input.onDelta!(e.properties.delta)),
                ),
              )
            }
            // 新增：Part 快照订阅（含 ToolPart）
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

    // ... 后续 text 拼接、usage 提取不变
  })
```

> **`PartUpdated` 走 bus 是确定的**：`SyncEvent.run()` 默认 `publish: true`（`sync/index.ts:245`），内部调 `ProjectBus.publish()`（`sync/index.ts:163`）。`session.ts:522` 触发 `PartUpdated` 时没有传 `{ publish: false }`，所以每次 Part 状态变化都会实时到达 bus，`bus.subscribe(MessageV2.Event.PartUpdated)` 可以直接用。

---

### 3. `service.ts` HypoPlanner 调用处 — 传入回调并转发到 research bus

在 `service.ts:7344` 的 `requestViaSession` 调用中增加 `onPartUpdated`：

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
  onPartUpdated: (part) => {  // ← 新增
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

> 现有的 `HypoPlannerAgentStreamDelta` 保持不变，可用于向后兼容或简单日志场景。`HypoPlannerAgentPartUpdated` 是更完整的替代，TUI 可只消费这一个事件。

---

### 4. `cockpit.tsx` — 订阅 Part 事件并渲染

#### 4a. 状态数据结构

```typescript
// Part 快照 map，partID 为 key
const [agentParts, setAgentParts] = createSignal<Map<string, ResearchAgentPartShape>>(new Map())
// 有序 partID 列表（决定渲染顺序）
const [agentPartOrder, setAgentPartOrder] = createSignal<string[]>([])
```

#### 4b. 事件订阅（在现有 event handler switch 中添加）

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

#### 4c. 渲染组件

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

#### 4d. 清理

```typescript
// 在 HypoPlannerAgentStarted 处理中重置（而不是 Completed），避免上一轮残留
if (researchPayload.type === "research.agent.hypoPlanner.started") {
  setAgentParts(new Map())
  setAgentPartOrder([])
  // ... 其余已有逻辑
}
```

---

### 5. 可选：持久化到 session stream.log

在 `onPartUpdated` 回调中可复用现有的 `persistResearchSessionStreamLines()`：

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

## 实施顺序

| 步骤 | 文件 | 工作量 |
|---|---|---|
| 1. 新增 `ResearchAgentPart` schema + `HypoPlannerAgentPartUpdated` event | `research/event.ts` | 小 |
| 2. `requestViaSession` 增加 `onPartUpdated` 回调 + 订阅 `MessageV2.Event.PartUpdated` | `research/service.ts` | 小 |
| 4. HypoPlanner 调用处传入 `onPartUpdated`，转发到 research bus | `research/service.ts` | 小 |
| 5. cockpit.tsx 添加 part 状态 + 事件订阅 + 渲染组件 | `research-cockpit.tsx` | 中 |
| 6. 补充测试：mock PartUpdated 事件序列 → 断言 TUI state 变化 | `test/research/` | 小 |

---

## 与其他 Agent 的复用

`requestViaSession` 的 `onPartUpdated` 回调是通用的，DataAnalysis 和 Reflection Agent 只需在各自的调用处传入回调，并在 `Event` 对象中注册对应的 `part.updated` 事件类型，渲染组件（`AgentPartList` / `AgentToolPart`）可直接复用。
