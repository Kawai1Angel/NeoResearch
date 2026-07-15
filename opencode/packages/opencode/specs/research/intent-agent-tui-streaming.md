# IntentAgent — TUI 流式渲染方案

> 状态：提案 / 未实现。本文档仅描述设计，代码尚未改动。
>
> 前置依赖：[intent-agent-tool-refactor.md](./intent-agent-tool-refactor.md)（已实现）——
> IntentAgent 现在跑在一个真实、可恢复的 opencode session 里
> （`service.ts` 的 `runIntentAgentTurn`/`runIntentAgent`/
> `continueIntentAgentSession`），调用
> `read_taskspec`/`update_taskspec`/`ask_user`/`check_taskspec`
> 四个工具。本文档与
> [hypo-planner-tui-streaming.md](./hypo-planner-tui-streaming.md)
> 是同一套基础设施（`ResearchAgentPartUpdated` 事件 + cockpit 的
> `pushHypoPartLines()` 通用渲染器），后者**已经实现并在用**
> （DataAnalysis / HypoPlanner / Reflection 三个 agent 都已接上），
> 本提案是把 IntentAgent 接成第四个。

## 1. 目标

1. IntentAgent 的 session 里每一次工具调用（`read_taskspec` /
   `update_taskspec` / `ask_user` / `check_taskspec`）和模型的文本
   回复，都像 HypoPlanner 一样实时滚动渲染到 streamLine 上。
2. 不再在 `intent_gathering` / 等待用户回答阶段一开始就把 15 个
   slot 的完整 checklist 摆出来——这部分信息现在改为通过观察工具
   调用日志（尤其是 `read_taskspec` 的输出、`ask_user` 的输入）
   自然呈现，不需要 TUI 自己再画一份。

## 2. 现状盘点

### 2.1 已有的通用基础设施（HypoPlanner 已验证可用）

- `research/event.ts` 已有 `ResearchAgentPartUpdated` schema 和
  `HypoPlannerAgentPartUpdated` / `DataAnalysisAgentPartUpdated` /
  `ReflectionAgentPartUpdated` 三个事件
- `research-cockpit.tsx`：
  - 每个 agent 各有一对信号 `xxxPartMap` / `xxxPartOrder`
    （如 `hypoPartMap`/`hypoPartOrder`，约 1208-1209 行）
  - 通用渲染函数 `pushHypoPartLines()`（4134-4176 行）——名字带
    "Hypo" 但实现完全通用，接收
    `(lines, order, map, streamID, done)`，DataAnalysis/Reflection
    都直接复用它（4219、4320 行），IntentAgent 也可以直接复用，
    不需要再写一个新的渲染函数
  - 事件订阅 switch（约 1617-1758 行区间）：收到
    `*.started` 时清空 `xxxPartMap`/`xxxPartOrder` 并把 stream 标记
    `done:false`；收到 `*.part.updated` 时把 part 快照写入
    map+order；收到 `*.completed`/`*.failed` 时把 `done:true`

### 2.2 IntentAgent 这一侧目前缺什么

- `service.ts` 的 `runIntentAgentTurn`（6548-6581 行）**直接手写了
  session create + `sessionPrompt.prompt()`**，不是走
  `requestViaSession()`（因为需要"找到已存在的 session 并续聊"这个
  `requestViaSession` 不支持的能力）。所以它也**没有**
  `requestViaSession` 那一套 `onDelta`/`onPartUpdated` 回调和
  `Effect.scoped` + `bus.subscribe(MessageV2.Event.PartUpdated)`
  订阅逻辑——这部分需要在 `runIntentAgentTurn` 内部重新接一份
  （逻辑可以照抄 `requestViaSession` 里那段，见 hypo-planner 文档
  第 2 节）
- `event.ts` 还没有 `IntentAgentPartUpdated`（已有的只是
  `IntentAgentStarted`/`Completed`/`Failed`/`AwaitingUser`）
- `runIntentAgent()`（6622 行起）目前每次被 `runFullPipeline()`
  调用时都会经过一次"已满足则跳过 session"的判断（见
  intent-agent-tool-refactor.md 实现记录）——**只有在
  `!alreadySatisfied` 时才会真正跑 `runIntentAgentTurn`**，已满足
  的情况下不会有任何 part 事件，这是预期行为（不应该为了"省事"在
  已经问完的情况下还要展示一次空的 stream）
- `continueIntentAgentSession()`（6694 行起，承接用户每一次回答/
  自由文本修改）**目前完全没有发布任何 Started/PartUpdated/
  Completed 事件**——这是本提案要补的最关键的一块，因为用户回答后
  的每一轮追问，才是 TUI 上最需要看到"模型在干什么"的时刻
- cockpit.tsx 里 `clarification.active` 为真时的渲染分支
  （4378-4396 行）目前是整段 slot checklist + "Next question"；
  这是本提案要替换掉的部分

## 3. 方案

### 3.1 `event.ts`：新增 `IntentAgentPartUpdated`

复用已有的 `ResearchAgentPartUpdated` schema，照抄
`HypoPlannerAgentPartUpdated` 的定义方式：

```ts
IntentAgentPartUpdated: BusEvent.define("research.agent.intent.part.updated", ResearchAgentPartUpdated),
```

不新增单独的 `IntentAgentStreamDelta`——IntentAgent 的文本回复通常
很短（提问前的一两句话），工具调用才是主要信息量，跟 part 事件一起
走即可，没必要再加一路文本 delta（HypoPlanner 当年两路都加是因为
它的文本回复本身就是主产出之一；IntentAgent 不是）。如果后续发现
逐字流式效果也需要，再补 `IntentAgentStreamDelta`，不在本次范围内。

### 3.2 `service.ts`：`runIntentAgentTurn` 内联订阅 + 回调

在 `runIntentAgentTurn`（6548 行）里加 `onPartUpdated` 回调参数，
内部按 `requestViaSession`（3172-3234 行）同款写法接
`Effect.scoped` + `bus.subscribe(MessageV2.Event.PartUpdated)`：

```ts
const runIntentAgentTurn = Effect.fn("Research.runIntentAgentTurn")(function* (input: {
  readonly task: ResearchTask
  readonly userMessage: string
  readonly modelRef: OpencodeModelRef | undefined
  readonly onPartUpdated?: (part: MessageV2.Part) => Effect.Effect<void>
}) {
  if (!input.task.sessionID || !input.modelRef) return undefined
  const existingSessionID = yield* findIntentAgentSessionID(input.task)
  const sessionID = existingSessionID ?? (yield* session.create({ ... })).id
  const promptEffect = sessionPrompt.prompt({ sessionID, agent: "research-intent-agent", model: ..., parts: [...] })
  const result = input.onPartUpdated
    ? yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(
            bus.subscribe(MessageV2.Event.PartUpdated).pipe(
              Stream.filter((e) => e.properties.sessionID === sessionID),
              Stream.runForEach((e) => input.onPartUpdated!(e.properties.part as MessageV2.Part)),
            ),
          )
          return yield* promptEffect
        }),
      )
    : yield* promptEffect.pipe(Effect.catchCause(() => Effect.succeed(undefined)))
  // ... 其余 checkOk 提取逻辑不变
})
```

> 注意：现有代码对 `promptEffect` 的失败用
> `.pipe(Effect.catchCause(() => Effect.succeed(undefined)))` 兜底；
> 套了 `Effect.scoped` 之后这个 catch 需要包住整个 scoped 块,而不是
> 只包 `promptEffect` 自己，否则订阅期间抛错会被 scoped 往外抛、
> 不会被这层 catch 接住——写法上要参考 `requestViaSession` 实际是
> 怎么处理这一层的（它在最外层统一 `.pipe(Effect.catchCause(...))`，
> 而不是分别包），照搬即可。

### 3.3 `service.ts`：发布事件的位置——按"整个 session"算边界

> 决策（已与用户确认）：`started`/`completed` 的粒度按**整个
> session**算，不是按"每一次 turn"算。即同一个 task 的 intent
> gathering 从第一次 `runIntentAgent()` 跑起，到最终
> `check_taskspec` 成功为止，TUI 上是**同一段持续累积的日志**，
> 中间用户每提交一次回答、触发一次新的 `runIntentAgentTurn`，都是
> 往同一段日志后面继续追加，不清空、不重开。

具体到代码：

- `IntentAgentStarted` 只在 `runIntentAgent()` 里发**一次**（已有
  逻辑不变）——即整个 intent_gathering 阶段刚开始的那一刻
- `continueIntentAgentSession()`（用户每次回答触发）**不发**
  `IntentAgentStarted`，只传 `onPartUpdated` 回调,把新一轮的 part
  事件继续追加进同一份 `intentPartMap`/`intentPartOrder`
- `IntentAgentCompleted` 只在真正"intent gathering 整体完成"时发——
  也就是 `runFullPipeline()` 那边判定 `missingFields.length === 0`
  并往后推进、或者 `runIntentAgent`/`continueIntentAgentSession`
  调用链最终让 `check_taskspec` 成功的那一刻，不是每次
  `runIntentAgentTurn` 调用完就发。中间几轮如果模型只是调用了
  `ask_user` 暂停等用户，**不发** `Completed`，也不发 `Failed`——
  这两个事件现在只表示"整段结束"（正常结束/异常结束），不是
  "这一轮结束"
- cockpit.tsx 只在收到 `IntentAgentStarted` 时清空一次
  `intentPartMap`/`intentPartOrder`（对应"这个任务开始一段新的
  intent gathering 流程"，比如同一个任务可能因为后续被驳回又重新
  触发一轮全新的 intent_gathering，那时才需要清空）；收到
  `part.updated` 只追加,不清空；收到 `Completed`/`Failed` 才把
  `done` 置为 `true`，让 streamLine 渲染器知道"不用再显示加载中的
  省略号了"

### 3.4 cockpit.tsx：信号 + 订阅 + 渲染

完全照抄 HypoPlanner 那一套（hypo-planner-tui-streaming.md 第 4
节），只是前缀换成 `intent`：

```ts
const [intentStream, setIntentStream] = createSignal<{ id: number; taskID?: string; done: boolean } | undefined>()
const [intentPartMap, setIntentPartMap] = createSignal<Map<string, HypoPartEntry>>(new Map())
const [intentPartOrder, setIntentPartOrder] = createSignal<string[]>([])
```

事件 switch 里加三个 case（`research.agent.intent.started` /
`research.agent.intent.part.updated` / `research.agent.intent.completed`
和 `...failed`），渲染时复用 `pushHypoPartLines()`，不需要新写
渲染组件。

### 3.5 替换掉的渲染分支

`streamLines` memo 里 4378-4396 行（`clarification.active &&
!clarification.reviewMode` 分支）目前是：

```
Socratic clarification: slots: <missing slot id 列表>
Next question: <下一题文案>
<15 个 slot 的 checklist>
```

改为：

```ts
} else if (clarification.active && !clarification.reviewMode) {
  // 不再展示整张 slot checklist；展示 IntentAgent session 的实时
  // 工具调用 / 文本流（跟 HypoPlanner 同款），用户从 ask_user 的
  // 工具调用日志里看到具体问题。
  const istream = intentStream()
  if (istream && (!task || !istream.taskID || istream.taskID === task.id)) {
    persistentLines.push({ id: `intent-stream-${istream.id}-header`, text: "[IntentAgent]", tone: "muted" })
    pushHypoPartLines(persistentLines, intentPartOrder(), intentPartMap(), istream.id, istream.done)
  }
  // 仍保留一行"当前问题"作为醒目提示，数据来源不变（ask_user 落库
  // 的 approval reason，经 buildSocraticClarificationState 解析）
  if (clarification.nextQuestion) {
    persistentLines.push({
      id: "socratic-next-question",
      text: `Next question: ${clarification.nextQuestion}`,
      tone: "primary",
    })
  }
}
```

**保留 "Next question" 这一行**：即使有了完整的工具调用日志，用户
也需要一个不用往上翻日志就能看到的"现在该回答什么"提示——这一行
的数据来源（`socraticClarification()` → `buildSocraticClarificationState`
→ 读最新 pending 的 `ask_user` approval）完全不需要改动,本提案只是
不再连带渲染下面那一长串 slot checklist。

**不动的部分**（按用户这次的描述,范围只针对"一开始展示整个
slots"这一点,不包括以下两处,需要的话另外讨论）：

- `clarification.reviewMode` 分支（4365-4377 行，intent 被驳回后的
  人工修改界面）——这是用户主动要求逐项核对/修改的场景,展示完整
  checklist 是该场景的核心交互,不应该跟着去掉
- `idle`、无 run 时的 onboarding 提示（4415-4431 行）——这是任务还
  没真正进入 intent_gathering、用户也没开始回答时的引导信息,跟"已
  经在追问中"是不同状态,本提案不涉及

### 3.6 是否要在 part 日志里特别高亮 `ask_user` 调用

`pushHypoPartLines()` 现在对所有工具一视同仁地渲染
`[图标] toolName  → input  ← output`。`ask_user` 工具的 input 就是
`{questions: [...]}`,作为日志的一部分会被 JSON 截断显示
（`JSON.stringify(...).slice(0, 120)`），可读性一般。建议：

- 不在 `pushHypoPartLines()` 里加 `ask_user` 特判（保持这个函数
  通用、跟其他三个 agent 共享的状态不变）
- 继续依赖 3.5 节保留的 "Next question" 那一行做高亮——它是从
  approval 原文解析出来的完整问题文本,不受 120 字符截断影响,
  已经解决了"日志里看不清问题"的问题

## 4. 实施顺序

| 步骤 | 文件 | 工作量 |
|---|---|---|
| 1. `event.ts` 新增 `IntentAgentPartUpdated` | `research/event.ts` | 小 |
| 2. `runIntentAgentTurn` 加 `onPartUpdated` 参数 + scoped 订阅 | `research/service.ts` | 小 |
| 3. `runIntentAgent()` 传入回调,转发到 bus | `research/service.ts` | 小 |
| 4. `continueIntentAgentSession()` 传入 `onPartUpdated` 回调（不发 Started/Completed，沿用同一段日志） | `research/service.ts` | 小 |
| 5. cockpit.tsx 加 `intentStream`/`intentPartMap`/`intentPartOrder` 信号 + 事件订阅 case | `research-cockpit.tsx` | 小 |
| 6. cockpit.tsx 替换 4378-4396 行渲染分支 | `research-cockpit.tsx` | 小 |
| 7. 测试：mock `IntentAgentPartUpdated` 事件序列,断言 streamLines 输出；回归 `research-cockpit-data.test.ts` 里跟 `buildSocraticClarificationState` 相关的用例（数据层没变,不应受影响） | `test/` | 小 |

## 5. 开放问题

- ~~`done` 按 turn 还是按 session~~ 已确认：按整个 session（见
  3.3 节）。

- **新增（按 session 之后才暴露的问题）：TUI 信号是纯前端内存
  状态，不会持久化。** 按 turn 设计时，单段日志生命周期短，用户
  中途切走再切回来丢失得也不多；改成按 session 累积后，一次
  intent gathering 可能跨好几轮、持续很久（用户去忙别的事再回来
  回答），如果期间用户切到别的 task 再切回来，或者刷新/重开了
  cockpit，`intentPartMap`/`intentPartOrder` 这两个信号会被重置为
  空——之前几轮的工具调用记录就看不到了，只能看到下一次
  `part.updated` 之后才有的新内容,体验上跟"按 session 持续累积"
  的初衷是矛盾的。
  - 需要决定：是否要在 cockpit **挂载/切换到某个 task 时**，主动
    把这个 session 已有的历史消息读出来重建一遍 `intentPartMap`/
    `intentPartOrder`（用 `session.messages({sessionID})` 拿到完整
    历史，反查出其中的 tool parts 重放一遍），而不是只依赖"实时
    事件流"。这部分目前 HypoPlanner 等三个 agent 都没有做（它们的
    每次调用本身就很短,没有这个问题），IntentAgent 引入"按 session
    累积"之后，是本提案独有的新需求,需要单独评估实现成本
  - 如果暂时不做历史重建,至少要在文档/产品层面接受这个限制：
    "刷新/切换 task 之后，只能看到接下来发生的新工具调用,看不到
    之前几轮的"——这是否可以接受需要你确认
