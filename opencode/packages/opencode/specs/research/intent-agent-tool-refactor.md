# IntentAgent 工具化重构方案

> 状态：提案 / 未实现。本文档仅描述设计，代码尚未改动。

## 1. 背景

`IntentAgent` 当前完全是**纯函数批处理**，不经过 Agent/Session/Tool 框架：

- `src/research/agents/intent-agent.ts` 导出
  `analyzeIntentTask` / `analyzeIntentTaskWithLLM` /
  `parseSlotInputsWithLLM` / `interpretSlotModificationWithLLM`
  四个函数，全部是普通 TS（同步或基于 `requestNeoCastLLM()` 直接发
  HTTP），不使用 `Effect.gen`、不创建 session、没有工具定义。
- `service.ts` 中的调用点：
  - `runIntentAgent()`（约 service.ts:6503-6534）：任务进入
    `intent_gathering` 状态时跑一次 `analyzeIntentTaskWithLLM()`，把
    `clarifyingQuestions` 写成一个 `kind: "protocol"` 的
    `ResearchApproval`（reason 里塞 `"- question1\n- question2..."`
    文本列表）。
  - `answerIntentQuestion()`（约 6555-6645）：用户提交
    `{ slots: {...} }` 后，调用 `parseSlotInputsWithLLM()` 把原始文本
    粗粒度转成类型化值，再调用 `updateTaskSpec()`，然后
    `analyzeIntentTask()` 重新计算缺失字段，决定是否还要再问。
  - `interpretAndApplySlotModification()`（约 6650-6680）：自由文本
    "意图修改" 走 `interpretSlotModificationWithLLM()`，同样落到
    `updateTaskSpec()`。
- TUI（`research-cockpit.tsx` / `research-cockpit-data.ts`）通过
  `buildSocraticClarificationState()` 从 approval 文本里**反向解析**
  出问题列表和 slot 映射（`slotFromSocraticQuestion()`），相当脆弱
  ——问题文案变了，TUI 解析就可能跟丢。
- 对照组：`research-hypo-planner` / `research-reflection` /
  `research-data-analysis` 都是通过 `Agent.Service` + session 跑的
  "真" agent，能在一次 session 里多轮调用工具
  （`requestViaSession()`，service.ts 约 6844-6912）。

**问题**：
1. IntentAgent 不是一个可以"读 → 问 → 听 → 改 → 再读 → 判断"循环的
   agent，而是每次用户答一次就整段重跑一次 `analyzeIntentTask`，
   LLM 没有机会在一次会话中连续操作 taskSpec、连续追问。
2. LLM 看不到“数据集分析结果”这一信号来源（当前 slot 抽取只看
   `task.taskSpec` / `objective` / `budget`，不读
   `analyzeDataset()` 产出的 profile），所以无法用“先分析数据集”
   驱动意图收集。
3. TUI 靠解析 approval reason 文本拿到问题列表，是一种隐式协议，
   工具化之后应该有更结构化的方式呈现"待问问题"。
4. 没有显式的"信息是否足够，可以进入 Checkpoint"判断点——目前是
   `missingFields.length === 0` 这种硬编码规则,而非 LLM 自主判断。

## 1.1 范围声明

本提案**仅覆盖 `intent_gathering` 阶段**的工具化改造。Companion 模式
下 `humanCheckpointPhases` 列出的其余阶段
（`data_analysis_done` / `search_space_confirmed` /
`experiment_budget_extended` / `final_model_selection` /
`report_release`，intent-agent.ts:85-91）不在本次改动范围内，
继续按现有机制运作，不受影响。

## 2. 目标

把 IntentAgent 改造成一个**真正的 session-based agent**，运行在
Agent/Tool 框架内，循环执行：

```
1. LLM 分析已上传数据集（沿用 AnalyzeDatasetTool 产出的画像）
2. LLM 调用 ReadTaskspec 读取当前 taskSpec / 已收集 slots
3. LLM 判断哪些 slots 缺失，生成澄清问题（可一次问多个）
4. 工具/runtime 把问题呈现给用户，阻塞等待用户输入
5. 用户回答后，LLM 做意图理解，调用 UpdateTaskspec 写回 taskSpec
6. LLM 再次调用 ReadTaskspec 确认最新状态
7. 回到 3，直到 LLM 自己判断信息足够
8. LLM 调用 CheckTaskspec，进入 Checkpoint 阶段
```

这是一个**多轮、有人类参与（human-in-the-loop）的 agent 循环**，
与 `research-hypo-planner` 那种"模型连续调用多个工具直到产出结果"
不同之处在于：**中间必须真正暂停等待用户输入**，不能在一次
session turn 内伪造继续。这是本方案最大的工程难点（见第 7 节）。

## 3. 现有基础设施盘点

| 能力 | 现状 | 是否够用 |
|---|---|---|
| Tool 定义模式 | `Tool.define(id, Effect.gen(...))`，见
  `tool/research-hypothesis.ts` / `tool/research-context.ts` | ✅ 直接复用 |
| Session 多轮工具调用 | `requestViaSession()`（service.ts ~6844-6912）：
  创建 child session，`sessionPrompt.prompt()`，订阅
  `MessageV2.Event.PartUpdated` 流式拿 tool 执行结果 | ✅ 但目前是
  "一口气跑完直到模型不再调用工具"的模式，**没有"暂停等用户"** |
| Agent 定义 + 权限 | `agent.ts` `Agent.Info`，按 agent name 配置
  `permission` allowlist 决定可见工具 | ✅ 直接复用 |
| taskSpec 读/写 | `updateTaskSpec()`（service.ts 3378-3402，走
  `UpdateTaskSpecInput`）；slot 抽取
  `collectedIntentSlots()`（intent-agent.ts:173） | ✅ 可复用，需要
  包一层工具 |
| 数据集画像 | `AnalyzeDatasetTool`（`tool/research-data-analysis.ts`）
  读取 `analyzeDataset()` 的 profile artifact | ✅ 直接给 IntentAgent
  agent 授权即可复用 |
| 向用户提问 + 等待回复 | approval 机制（`ResearchApproval`,
  kind: "protocol"）+ TUI 文本解析 | ⚠️ 目前是"写 approval reason
  文本，TUI 反解析"，需要改造为结构化 |
| "Checkpoint" 概念 | `humanCheckpointPhases` 列表 +
  `ResearchCheckpointAutoApproved` 事件 + `ResearchApproval` 状态机
  （pending/approved/rejected） | ✅ 概念已存在，CheckTaskspec 工具
  只是显式触发它 |

## 4. 四个新工具设计

新文件 `src/tool/research-taskspec.ts`，遵循
`tool/research-hypothesis.ts` 的写法（`Tool.define` + 共享 store
模块，避免循环依赖）。除用户要求的 `ReadTaskspec` / `UpdateTaskspec`
/ `CheckTaskspec` 外，新增 `AskUser`（见 7.1 节决策），用作显式的
"暂停等待用户输入"信号。

### 4.1 `ReadTaskspec`

- 参数：无（或可选 `{ includeRawTaskSpec?: boolean }`）
- 行为：
  - 通过 `resolveTaskIDBySessionID(ctx.sessionID)` 拿到 `taskID`
  - 调用现有 `collectedIntentSlots(task)` 逻辑（需要从
    intent-agent.ts 导出，目前是模块内私有函数）
  - **新增**：合并已上传数据集的画像摘要（若存在），让 LLM 在第一轮
    就能看到 schema/列名/缺失率等信息，辅助猜测
    `target_columns` / `time_grain` / `data_source` 等 slot
- 返回：
  ```ts
  {
    taskID, interactionMode,
    slots: Record<SlotID, { value: unknown; missing: boolean; required: boolean }>,
    missingRequiredSlots: SlotID[],
    datasetProfileSummary?: string,  // 若已跑过 AnalyzeDatasetTool
  }
  ```
- 只读，不发事件。

### 4.2 `UpdateTaskspec`

- 参数：`{ updates: Partial<Record<SlotID, unknown>> }`
  （键名沿用 16 个 snake_case slot id，复用现有
  `normalizeIntentSlotKeys` 做别名容错）
- 行为：
  - 把 `updates` 映射回 taskSpec 的真实路径（`metadata.intentSlots.xxx`
    为主，`data_source`/`target_columns` 额外双写 `dataset.path` /
    `dataset.targetCols`，见 7.3 节修正后的结论），实现为新增的
    `applySlotUpdates(taskID, updates)` 辅助函数
  - 写入前用 `DomainRegistry.createTaskSpec()` 重新校验合并后的
    taskSpec（domain schema 是 `.strict()`，详见 7.3 节），校验失败
    时返回一段错误文本给 LLM，不抛异常中断整个 session
  - **不**做"自由文本理解"——这一步应在工具调用前由 LLM 自己完成
    （即 LLM 读到用户回答后，直接构造结构化 `updates` 调用工具，
    而不是把原始文本传给工具内部再跑一次 LLM）。这意味着
    `parseSlotInputsWithLLM` / `interpretSlotModificationWithLLM`
    这两个"工具内部偷偷再调 LLM"的函数可以**整体退役**，因为外层
    session 本身就是 LLM，理解能力已经在 prompt 循环里了。
- 返回：更新后的 `slots` 快照（同 `ReadTaskspec` 的 `slots` 字段），
  方便 LLM 不必紧跟着再调一次 `ReadTaskspec`（但 prompt 仍应引导
  LLM 调用 `ReadTaskspec` 做独立确认，按用户原始需求的步骤来）。

### 4.3 `CheckTaskspec`

- 参数：`{ confidence: number; rationale: string }`
  （LLM 自评的信息完整度 + 简短理由，便于审计/展示）
- 行为：
  - 校验 `missingRequiredSlots` 是否确实为空（防止 LLM 误判就强行
    进入 checkpoint——**服务端二次校验，不完全信任 LLM 自报**）
  - 若校验通过：**直接复用现有触发逻辑**，不新造状态机——调用
    `runFullPipeline({ taskID })`（service.ts:6631-6638 现有调用
    方式），由其内部的 `ensureIntentCheckpoint()`（service.ts:3877）
    走既有路径：创建/解析 `ResearchApproval(kind: "protocol")`，
    若仍为 `pending` 则任务状态置为 `"paused"` 并
    `throw PipelineBlockedError`（service.ts:7845-7863，此行为对
    socratic / companion 两种模式一致，均需要人工确认后才能进入
    `data_analysis`）；若已被批准过，则照现有逻辑把
    `"intent_gathering"` 写入 `completedPhases`、推进到
    `data_analysis`（service.ts:7865-7872）。`CheckTaskspec` 工具
    本身不引入新的事件或状态转换，只是把"slots 是否足够"的判断权
    交给 LLM，触发之后完全沿用现状。
  - 若校验不通过：返回错误 + 仍缺失的字段列表，**不**调用
    `runFullPipeline()`，引导 LLM 回到 `ReadTaskspec` 继续追问
- 返回：`{ ok: boolean; missingRequiredSlots: SlotID[]; checkpointID?: string }`

### 4.4 `AskUser`

- 参数：`{ questions: string[] }`
- 行为：不调用 LLM、不读写 taskSpec；把问题原文落库（复用
  `ResearchApproval(kind: "protocol")`，reason 直接存问题列表原文）
  并发布 `IntentAgentAwaitingUser` 事件
- 返回：`{ acknowledged: true }`（仅用于让模型的工具调用有个收尾）
- 这是本轮 session "挂起"的唯一合法信号，详见 7.1 节

### 4.5 共享实现细节

复用 `hypothesis-store.ts` 的模式，新增
`src/research/taskspec-store.ts`：

| 函数 | 说明 |
|---|---|
| `resolveTaskIDBySessionID` | 已存在于 `hypothesis-store.ts`，直接复用，无需重复实现 |
| `readTaskspecSlots(taskID)` | 包装 `collectedIntentSlots` + 数据集画像合并 |
| `applySlotUpdates(taskID, updates)` | 正向映射 slot → taskSpec 路径，调用 `updateTaskSpec()` |
| `checkTaskspecReadiness(taskID)` | 服务端校验 + 触发 checkpoint |

## 5. Agent / Session 改造

### 5.1 新 agent：`research-intent-agent`

在 `agent.ts` 按 `research-hypo-planner` 的模板新增：

```ts
"research-intent-agent": {
  mode: "subagent",
  prompt: PROMPT_RESEARCH_INTENT_AGENT,  // 新文件 prompt/research-intent-agent.txt
  permission: {
    "read_taskspec": "allow",
    "update_taskspec": "allow",
    "check_taskspec": "allow",
    "ask_user": "allow",
    "analyze_dataset": "allow",   // 复用现成的数据集分析工具
    "*": "deny",
  },
}
```

### 5.2 Session 驱动方式必须改变

`requestViaSession()` 现状是"喂一个 prompt，模型自己跑到不再调用
工具为止，取最终文本"——这适合 hypo-planner（无需用户介入）。
IntentAgent 需要的是**多轮、可中断**的对话：

- 方案 A（推荐）：**把"一次用户问答"映射成"一次新的 session
  turn"**，session 本身在多次 HTTP 请求之间保持存活（已有
  session 概念支持跨请求复用，参考 `answerIntentQuestion` 当前
  也是跨 HTTP 请求的）。即：
  1. 第一次进入 `intent_gathering`：开一个 session，
     `sessionPrompt.prompt()` 跑到模型调用 `ReadTaskspec` 了解
     现状后，再调用 `AskUser({ questions: [...] })` 提问
  2. service.ts 在 part-update 回调里观测到 `AskUser` 被调用，
     即视为本轮"挂起"，把 `questions` 展示给用户（见 7.1 节决策）
  3. 用户答题 → service.ts 对**同一个 session** 追加一条 user
     message（"用户回答：...")，再次 `sessionPrompt.prompt()`
  4. 模型这一轮调用 `UpdateTaskspec`、`ReadTaskspec`，再产出新一批
     问题或调用 `CheckTaskspec`
  5. 重复 3-4，直到模型调用 `CheckTaskspec` 成功

  这与现状的本质区别：现状每次用户回答都是**全新调用一个无状态
  纯函数**（`analyzeIntentTask`），新方案是**同一个 session 持续
  累积对话历史**，模型能记住之前问过什么、为什么问。

- 方案 B（不推荐）：每次都开新 session，把"已收集 slots +
  历史问答"整段塞进 prompt 重新开始。能工作，但失去了"模型自己
  决定提问策略的连续性"，且每轮都要重新建立上下文，token 成本更高，
  与用户需求"LLM 用 ReadTaskspec 再确认"的设计初衷（强调状态是
  外部化在 taskspec 里、靠工具读取，而不是靠对话历史）更贴近——
  **实际上方案 B 可能更符合用户描述的"每轮都 ReadTaskspec 确认"**，
  因为如果 session 历史本身就记得所有内容，"再读一次 Taskspec"
  这个动作的意义就弱化为"双重确认"而非"恢复状态"。

  建议：**两者结合**——同一个 session 持续存活（保留对话连续性，
  避免重复解释背景），但 prompt 强制要求"每次决定提问或终止前，
  必须先调用 ReadTaskspec 重新确认最新状态"，不依赖对话记忆里的
  slot 值（因为 `UpdateTaskspec` 可能被其他渠道——如用户在 TUI
  直接编辑——绕过当前 session 修改，对话记忆会过期）。

### 5.3 "一次问多个问题"如何呈现

- 由新增的 `AskUser({ questions: string[] })` 工具承担（见 4.4
  节、7.1 节），一次调用即可携带多个问题，数量上限交给 prompt 层
  约束。
- service.ts 在 `AskUser.execute()` 内把 `questions` 落库（复用
  现有 `ResearchApproval` 结构，reason 字段直接存问题原文 JSON/
  文本列表），不再需要 TUI 做"反向解析 slotFromSocraticQuestion"
  ——一次性把这层脆弱的字符串匹配去掉。
- TUI 改动：`buildSocraticClarificationState()` 简化为"展示
  `AskUser` 落库的问题列表原文"，用户输入的回答整段作为新 user
  message 发回 session，不再需要前端先猜 slot id。

## 6. Prompt 设计要点（`research-intent-agent.txt`）

- 明确写出本方案第 2 节的 8 步循环
- 强调："不要凭空假设 slot 值；無法從數據集畫像或既有
  taskSpec 推斷的字段，必须通过提问获取"
- 强调："每次提问前/每次判断是否足够前，必须先调用
  ReadTaskspec，不要依赖你记忆中的旧状态"
- 给出 companion / socratic 两种模式的问题数量上限提示（复用现有
  `maxQuestionsPerTurn` 这个数字，作为 prompt 里的硬约束文案，
  而不是代码层强制截断——因为现在 `buildResult()` 里的截断逻辑
  以后要挪到哪一层需要决定，见第 7.4 节开放问题）
- 明确 CheckTaskspec 的调用前提："仅当 ReadTaskspec 返回
  missingRequiredSlots 为空时才能调用"

## 7. 主要风险与开放问题

### 7.1 "暂停等待用户输入"——已决定新增显式 `AskUser` 工具

> 决策（已与用户确认）：采用显式工具方案，而非"无工具调用即视为
> 提问"的隐式信号。

新增第四个工具 `AskUser`，作为本方案工具集的一部分：

- 参数：`{ questions: string[] }`（一次可问多个，数量上限交给
  prompt 层约束，参考第 6 节）
- 行为：**不调用 LLM、不读写 taskSpec**，只是把 `questions` 落库
  （复用现有 `ResearchApproval(kind: "protocol")` 或类似结构，
  reason 直接存这批问题原文，不再需要 TUI 反向解析）并发布一个
  事件（如 `IntentAgentAwaitingUser`）
- 关键点：service.ts 在 `requestViaSession()` 的 part-update 回调
  里，**只要观测到 `AskUser` 被调用**，就立刻判定本轮 session
  "挂起"，不必等模型产出最终文本——可以在 `AskUser` 执行完后
  主动结束这一轮 prompt（或者让模型在调用完 `AskUser` 后自然收尾，
  service.ts 仅做标记，二者皆可，倾向于让模型简单收尾一句话即可，
  不强行打断模型的 turn）
- 这样暂停信号变成显式的"调用了 AskUser → 暂停，等待下一次
  HTTP 请求把用户回答作为新消息追加"，不存在"模型既想解释又想
  调用 ReadTaskspec 导致误判"的歧义问题——只要没调用 AskUser，
  无论模型调用多少其他工具、说多少话，都不会被当成"在等用户"。
- prompt 层需要明确写：**唯一能让用户看到问题、暂停等待回答的
  方式就是调用 AskUser**；如果只是输出文本说"我有几个问题"而不
  调用该工具，问题不会展示给用户，session 会继续往下跑（可能导致
  模型在没有答案的情况下被迫调用 ReadTaskspec/UpdateTaskspec，
  需要在 prompt 里反复强调这一点，避免模型"嘴上问了但没真正调用
  工具"的常见 LLM 失误）。
- 各 agent 工具集相应变为四个：`ReadTaskspec` / `UpdateTaskspec`
  / `CheckTaskspec` / `AskUser`，第 4 节、第 5.3 节、第 9 节的描述
  需同步更新（见下方修订）。

### 7.2 Session 生命周期与现有 task 状态机的对齐

- 已调研确认（`session/session.ts`、`session/session.sql.ts`）：
  session 持久化在 SQLite（`SessionTable`/`MessageTable`/`PartTable`），
  不是只活在进程内存里，进程重启不丢失；`ResearchTask` 已有
  `session_id` 列（`research.sql.ts`），`taskID → task.sessionID` 的
  稳定映射本来就存在（`getTask()`，service.ts:3272-3283）。**基础设施
  上支持"跨 HTTP 请求继续同一个 session"**。
- 但**这个用法目前在代码里没有先例**：现有 `requestViaSession()`
  （service.ts:3172-3234）每次调用都是"为 rootSessionID 建一个全新
  child session，prompt 一次就完"，从未有"取回已存在的 session、
  追加新 user message、再次 prompt()"这种路径，也没有任何测试覆盖
  它。`Session.Service` 暴露的 `get`/`messages`/`updateMessage` +
  `sessionPrompt.prompt({ sessionID, ... })` 理论上拼得出这个流程，
  但相当于本仓库第一次这么用，需要在实现阶段当成**新功能**去写测试
  验证，而不是当作"现成能力直接调用即可"。
- 仍待实现时确认/决定的细节：
  - session 在用户长时间不回答时如何处理（超时？保留？）
  - 多个并发请求打到同一个 session（比如用户连续点了两次"提交回答"）
    如何排队，避免 race condition 写脏 taskSpec

### 7.3 `UpdateTaskspec` 的正向映射比反向映射更难维护 —— 已排查，结论：可以收敛为单一规范路径

**已验证消费方范围**（grep + 代码阅读，非猜测）：

- 这些散落字段（`taskSpec.dataset.*` / `contextLength` /
  `predictionLengths` / `taskSpec.intent.slots.*` /
  `taskSpec.metadata.intentSlots.*` 等）**几乎只有 IntentAgent
  自己在写**。任务创建时 `objective`/`budget` 是作为
  `ResearchTask` 的两个独立顶层列（`research.sql.ts:34-35`）原样
  写入的，之后只有 IntentAgent 通过 `updateTaskSpec()`
  （service.ts:6624）改写这些路径。
- 只读消费方仅 3 个，且各自只读取一小部分、互不重叠：
  - `data-analysis-agent.ts`（174-180 行）：读
    `taskSpec.dataset` / `taskSpec.runtime`，用于数据集 profiling
    ——这部分是**真实操作配置**，不是"意图槽位的副本"
  - `hypo-planner-agent.ts`（180、184 行）：读
    `taskSpec.metadata` / `taskSpec.datasetProfile`（profiling
    产出，不是 intent 槽位）
  - `reflection-agent.ts`（267-268 行）：读
    `taskSpec.profile` / `taskSpec.datasetProfile`（同上）
- `neo_cast/py/` 训练层确认**不读** `taskSpec` 任何路径，只读
  独立 resolve 出的 `current_candidate.json` /
  `resolved_candidate.json`，与 `taskSpec` 完全脱钩。

**结论**：散落不是"多个系统组件并发写入造成的真实冲突"，而是
IntentAgent 自己在不同时期换过命名风格留下的历史痕迹（早期贴近
`neo_cast` candidate JSON 的 camelCase 字段 → 后来加
`intent.slots.*` → 又加了一份几乎同义的 `metadata.intentSlots.*`）。
`collectedIntentSlots()` 那一长串候选链，本质上是为兼容数据库里
已存在的历史任务记录,而不是要兼容"现在仍在持续写入"的多个活跃
写入方。

**因此可以、也应该**维护单一规范 JSON 命名空间——**但实现阶段发现
一个本节最初没考虑到的硬约束，把目标路径从 `taskSpec.intent.slots.*`
改成了 `taskSpec.metadata.intentSlots.*`**：

> 修正（实现阶段发现）：domain taskSpec schema（如
> `domains/tsf.ts` 的 `TSFTaskSpec`）是
> `z.object({...}).strict()`，顶层只有 `metadata` 一个被显式设计成
> 自由扩展字段（`metadata: JsonObject.default({})`），新增任何其他
> 顶层 key（比如 `intent`）都会被 `.strict()` 拒绝，
> `DomainRegistry.createTaskSpec()` 直接抛 ZodError。也就是说
> "新增一个全新顶层命名空间"这个方案本身不可行——legacy 代码当年选
> `metadata.intentSlots` 不是历史随意命名,而是**唯一**能逃过
> `.strict()` 校验的位置。结论修正为：

- `UpdateTaskspec` 工具只写 `taskSpec.metadata.intentSlots.<slot_id>`
  （16 个 slot 统一走这一处，不再分散到其它候选路径）——这恰好就是
  legacy 代码已经在用的路径，只是现在变成**唯一**写入目标，而不是
  众多候选来源之一
- 例外：`data_source` / `target_columns` 这两个槽位具有"双重身份"
  ——`data-analysis-agent.ts` 真的会读 `taskSpec.dataset.path` /
  `taskSpec.dataset.targetCols` 作为 profiling 的实际输入，因此
  `UpdateTaskspec` 写这两个槽位时需要**同时**同步写一份到
  `taskSpec.dataset.path` / `taskSpec.dataset.targetCols`，
  而不能只写 `metadata.intentSlots.*`
- `ReadTaskspec` 对新任务只读 `metadata.intentSlots.*`（+ 上述两个
  槽位的 `dataset.*` 同步值做一致性校验）；`collectedIntentSlots()`
  里那一长串旧候选链（`taskSpec.forecastObject` /
  `taskSpec.contextLength` 等扁平字段）降级为**仅兼容历史任务**的
  fallback，待存量任务清理后可整段删除
- 迁移步骤：
  1. `applySlotUpdates()` 实现时按上述规则只写规范路径（+
     `data_source`/`target_columns` 双写）
  2. `readTaskspecSlots()` 优先读规范路径，读不到才落回旧的
     `firstKnown()` 候选链（保证存量任务不报错/不丢数据）
  3. 不需要额外的"数据迁移脚本"——旧任务靠 fallback 链继续可读，
     新任务/任意一次被 `UpdateTaskspec` 写过之后即转为规范路径

### 7.4 现有"问题数量截断 / 置信度计算"逻辑要不要保留

`buildResult()` 里的 `confidenceFor()` / `maxQuestionsPerTurn`
截断是确定性规则，如果改为 LLM 自主判断"信息是否足够"
（即用户需求里的"由 LLM 判断信息是否足够"），这套规则的角色变成
什么？建议：
- `confidenceFor()` 这类硬编码评分**保留**，作为 `CheckTaskspec`
  服务端二次校验的依据之一（即 7.# 节提到的"不完全信任 LLM 自报"），
  防止 LLM 过早或错误地判断"足够"
- `maxQuestionsPerTurn` 截断从代码层移到 prompt 层（即第 6 节），
  因为现在问题不再是"统一走 buildResult 函数生成"，而是模型
  自由生成文本，代码层不好再做"取前 N 条"这种截断

### 7.5 旧路径（`runIntentAgent` / `answerIntentQuestion` /
`interpretAndApplySlotModification`）是否保留为 fallback

参考 `hypothesis-pool-tools.md` 的先例（全量替换路径保留作
fallback），建议：
- **不建议长期双轨**：因为 IntentAgent 的核心价值就是"对话连续性
  + 工具驱动状态"，双轨会导致 TUI 要同时兼容两套协议
  （approval 文本反解析 vs session 消息流），复杂度提升不划算
- 建议直接切换，但保留一个 feature flag（类似现有
  `NEO_RESEARCH_INTENT_LLM` 环境变量的模式）用于回滚，灰度期过后
  删除旧函数（`parseSlotInputsWithLLM` / `interpretSlotModificationWithLLM`
  /旧版 `runIntentAgent` 中的纯函数调用部分）

### 7.6 测试影响面

- `intent-agent.ts` 当前导出的 4 个函数有直接单测覆盖
  （需要 grep 确认具体测试文件，初步看 `test/research/` 下应有
  对应文件，需要在实现阶段定位并改写）
- 新增：
  - `test/tool/research-taskspec.test.ts`（四个工具的 execute 行为）
  - `test/research/taskspec-store.test.ts`（正向映射 / 服务端校验）
  - session 级集成测试：模拟"提问 → 用户回答 → 再提问 → 信息足够 →
    CheckTaskspec 触发 checkpoint"的完整多轮流程（可能需要 mock
    `sessionPrompt.prompt()` 或对照 `service.test.ts` 里已有的
    hypo-planner session 测试写法）
- TUI 测试：`research-cockpit-data.test.ts` 中
  `buildSocraticClarificationState` 相关用例需要按新协议（原文
  展示而非反解析）重写

## 8. 建议的实现顺序

1. ~~确认 7.1 的开放问题~~ 已确认：采用显式 `AskUser` 工具方案
2. `src/research/taskspec-store.ts`：`readTaskspecSlots` /
   `applySlotUpdates`（含正向映射表）/ `checkTaskspecReadiness`
3. 把 `collectedIntentSlots` / `slotDefinitions` 等从
   `intent-agent.ts` 导出（或整体迁移进 `taskspec-store.ts`），
   供工具层复用，避免重复实现
4. `src/tool/research-taskspec.ts`：四个 `Tool.define(...)`
   （`ReadTaskspec` / `UpdateTaskspec` / `CheckTaskspec` / `AskUser`）
5. `tool/registry.ts` 注册新工具
6. `agent.ts` 新增 `research-intent-agent`，配置 permission
7. `src/agent/prompt/research-intent-agent.txt`
8. `service.ts`：
   - 改造 `runIntentAgent()` 走 `requestViaSession()`
   - 新增"恢复 session 并追加用户回答"的入口替换
     `answerIntentQuestion()` / `interpretAndApplySlotModification()`
   - 处理 session 暂停/恢复的状态持久化
9. TUI：简化 `buildSocraticClarificationState()`，去掉反向解析
10. 测试（第 7.6 节）
11. 灰度：保留旧路径 + feature flag 一段时间，验证后删除
    `parseSlotInputsWithLLM` / `interpretSlotModificationWithLLM`

## 9. 与用户原始描述的对应关系

| 用户描述 | 本方案对应 |
|---|---|
| LLM 分析上传的数据集 | 复用 `AnalyzeDatasetTool`，授权给 `research-intent-agent` |
| 利用 ReadTaskspec 看任务信息 | 4.1 节 |
| 确认 slots 缺失，一次问多个问题 | 4.1 节 `missingRequiredSlots` + 4.4 节 `AskUser` 工具 + 6 节 prompt 数量约束 |
| LLM 意图理解后调用 UpdateTaskspec | 4.2 节；同时退役 `parseSlotInputsWithLLM`/`interpretSlotModificationWithLLM` 这两个"工具内部再调 LLM"的旧函数 |
| 再用 ReadTaskspec 确认新信息 | 5.2 节"每轮强制重新读取"的 prompt 约束 |
| LLM 判断信息是否足够 → CheckTaskspec → Checkpoint | 4.3 节，服务端二次校验 + 复用现有 `ResearchApproval`/checkpoint 事件机制 |
