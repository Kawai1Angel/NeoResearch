# NeoResearch UX 流程缺口分析

> 日期：2026-05-01
> 范围：NeoResearch Home 启动页、Cockpit 工作区、CSV task 创建、交互模式、Research Agent 对话、Runner 状态、结果导出
> 目标：把当前代码实现与期望的 Vibe Data Science TSF 使用流程逐步对齐，明确已实现能力、残余缺口、修复优先级和验收标准。

---

## 一、目标 UX

NeoResearch 的理想体验不是一个“命令集合”，而是一个从自然语言目标到可复现实验结果的研究工作流。

### 1.1 Home 自然语言目标流

```text
Home
  │
  ├─ 用户输入研究目标
  │   "Forecast ETTh1 horizon=24 target=OT context=96"
  │
  ▼
Cockpit
  │
  ├─ 创建 TSF research task
  ├─ 默认进入 socratic/autonomous 工作流
  ├─ 若 runner ready：自动 prepare dataset / profile / autonomous loop / export bundle
  └─ 若 runner not ready：清楚提示修复入口，避免静默失败
```

这个入口适合“我先说目标，你帮我完成研究”的场景，应尽量减少阻塞式弹窗。

### 1.2 CSV Task 引导流

```text
Home 或 Cockpit
  │
  ├─ New CSV Task / ctrl+n / /csv
  │
  ▼
[Step 1] 选择交互模式
  │
  ├─ 1 Companion：认知伴随，偏人工确认，对应 review task
  └─ 2 Socratic：苏格拉底，偏自主执行，对应 autonomous task
  │
  ▼
[Step 2] 输入 CSV 参数
  │
  └─ /path/to/ETTh1.csv target=OT horizon=24 context=96 full
  │
  ▼
Cockpit
  │
  ├─ 主区显示任务创建与下一步
  ├─ 右侧显示阶段、交互模式、Progress、Runner、Champion
  └─ 底部输入框继续与 Research Agent 对话
```

这个入口适合“我已经有数据路径，先建一个数据驱动的 task”的场景。

---

## 二、当前实现快照

### 2.1 已实现

| 能力 | 当前状态 | 代码位置 |
| --- | --- | --- |
| Home 可输入研究目标并进入 Cockpit | 已实现 | `home.tsx` 路由到 `cockpit`，`research-cockpit.tsx` 处理 `researchGoal` |
| CSV task 入口 | 已实现 | `New CSV Task`、`ctrl+n`、`/csv`、`/dataset` |
| Interaction mode 弹窗 | 已实现 | `InteractionModeDialog` + `chooseInteractionMode()` |
| 交互模式到任务模式映射 | 已实现 | `companion -> review`，`socratic -> autonomous` |
| CSV 参数解析 | 已实现 | `parseTsfCsvTaskInput()` 支持 `target=`、`horizon=`、`context=`、`preset=`、`full`、`bridge` |
| Cockpit 主区 stream | 已实现 | prompt events、action events、error events、busy state |
| 右侧阶段与 Progress | 已实现 | `用户需求输入`、`Data Profile`、`自主探索`、`结果整理` |
| Runner readiness 展示 | 已实现 | runner title、detail、`Use Project Runner` |
| Autonomous loop 入口 | 已实现 | `Agent Loop`、`/agent-loop`、`/loop` |
| Export bundle 入口 | 已实现 | `Export Bundle`、`/export`、`/report` |

### 2.2 当前交互模式的实际语义

| 模式 | UI 标签 | 内部 task mode | 当前行为 |
| --- | --- | --- | --- |
| `companion` | 认知伴随 | `review` | 更偏人工确认；低风险候选不会因为模式而直接进入 autonomous loop。 |
| `socratic` | 苏格拉底 | `autonomous` | 更偏自主执行；runner ready 时可触发 autonomous loop / pipeline。 |

注意：当前两种模式已经落入 task metadata，并影响 `review/autonomous` task mode；但 Research Agent 的 chat prompt 还没有充分体现“伴随式”和“苏格拉底式”的对话差异。

---

## 三、逐步流程核查

### Step 1：模式选择

**当前状态：已实现，但入口策略还需要收敛。**

`InteractionModeDialog` 已提供两个明确选项：

```text
1 Companion
2 Socratic
enter submit
1/2 choose
up/down move
```

`createCsvTask()` 在未指定 `mode` 时会先调用 `chooseInteractionMode()`，然后再弹 CSV dataset path。这个流程符合 CSV task 的引导预期。

当前需要确认的是 Home 自然语言目标入口：源码中的 `createTaskFromPrompt()` 仍会调用 `chooseInteractionMode()`。如果产品目标是“Home 输入目标后默认走 Socratic，直接开始研究”，这里应改成 Home source 默认 `socratic`，避免多一个阻塞步骤。

**判断：**
- CSV task：正确。
- Home goal：产品策略待统一。建议默认 `socratic`，不要弹模式选择。

---

### Step 2：CSV 路径与数据参数输入

**当前状态：已实现。**

当前 placeholder：

```text
/path/to/ETTh1.csv target=OT horizon=24 context=96 full
```

支持参数：

| 参数 | 示例 | 说明 |
| --- | --- | --- |
| CSV 路径 | `/tmp/ETTh1.csv` | 数据文件路径 |
| target | `target=OT` 或 `target=OT,HUFL` | 预测目标列 |
| horizon | `horizon=24` 或 `horizon=24,48` | 预测长度 |
| context | `context=96` | 输入窗口长度 |
| preset | `preset=etth1` | 数据集 preset |
| full | `full` | full-recipe runtime |
| bridge | `bridge` | bridge-only runtime |

**残余问题：**
- CSV 路径不存在时，用户通常要等到后续 runner/prepare 才看到失败，输入框阶段没有即时校验。
- 参数解析错误时缺少结构化错误提示，例如 horizon 非数字、target 空值、context 不合法。
- 没有把解析后的参数在确认前展示给用户复核。

---

### Step 3：任务创建后的主动引导

**当前状态：部分实现，仍有 UX 缺口。**

当前主区在没有事件时会显示：

```text
Research output will appear here as the agent runs.
```

这能避免空白，但它是被动占位，不是 Research Agent 主动引导。理想行为是任务创建后立即出现一条面向当前模式的引导消息。

建议：

**Socratic 模式：一次只问一个关键问题。**

```text
任务已创建。为了开始 TSF 研究，我先确认一个问题：
你这次最优先优化的是预测精度、推理速度、模型大小，还是训练成本？
```

**Companion 模式：一次给出完整 checklist。**

```text
任务已创建。请补充这些约束，我会据此给出候选设计建议：
1. 目标列与预测 horizon
2. 精度、速度、参数量、训练时长的优先级
3. 是否需要概率预测或分位数输出
4. 是否有必须使用或避免的模型家族
```

缺口本质：
- 没有 `onboarding` event。
- 没有 `intent_gathering` 状态。
- prompt placeholder 没有根据“刚建 task、等待补充需求”变化。

---

### Step 4：Research Agent 对话行为

**当前状态：基础对话已实现，模式化行为不足。**

已实现：

- 用户输入会进入 chat session。
- 系统会把 task、objective、budget、candidate、latest run 注入上下文。
- Agent 回复会进入主区 stream。
- 没有 API key 时会提示配置 provider。

当前缺口：

| 缺口 | 影响 |
| --- | --- |
| system prompt 不区分 `companion/socratic` | 两种模式在聊天时像同一种模式。 |
| Socratic 没有“一问一答”的状态机 | Agent 可能一次输出太多问题，用户体验不像苏格拉底式澄清。 |
| Companion 没有“旁路建议 + 风险提示 + 可选动作”结构 | 用户看不到伴随式辅助的稳定格式。 |
| Agent 回复和可执行 action 没有强绑定 | 用户读完建议后仍要自己判断该点哪个命令。 |

建议将 chat prompt 拆成三层：

1. **通用身份层**：NeoResearch Research Agent，TSF cockpit 上下文。
2. **模式层**：
   - Socratic：只问一个最关键问题；拿到答案后再建议下一步。
   - Companion：给完整上下文、建议、风险、可选命令。
3. **状态层**：根据 `promptPhaseLabel()` 注入当前阶段目标。

---

### Step 5：阶段、Progress 与 Runner 展示

**当前状态：已实现，但仍可提升信息密度。**

当前阶段：

```text
用户需求输入
Data Profile
自主探索
结果整理
```

右侧 Progress：

```text
▾ Progress
✓ 用户需求输入
✓ Data Profile
• 自主探索 0/12 runs
• 结果整理
```

Runner 区域已展示：

- `ready` 或具体问题标题。
- 详细原因，例如 `taskSpec.runtime.neoCastProjectRoot is not configured.`
- `Use Project Runner` 快捷修复入口。

残余问题：
- Progress 只有完成/未完成，缺少“当前 active”的明显标记。
- `Data Profile` 阶段没有展示 profile 摘要，例如行数、目标列、horizon、缺失值。
- `自主探索` 没有显示当前候选 family、best metric、no-improve streak。
- Runner 修复成功后最好显示一条 action event，说明 runtime 已切换到哪个 root。

---

### Step 6：自动研究与结果交付

**当前状态：后端能力存在，TUI 的解释层还不够产品化。**

当前能力：

- autonomous task 可运行 loop。
- pipeline 路由可执行多代理研究流程。
- export 可产出 research report 或 final bundle。
- Champion 会在右侧展示 candidate、metric、utility。

UX 缺口：

- 用户不知道“当前是在跑 smoke、ref test、blind test 还是 export”。
- loop 结束原因需要更可读，例如 `approval_required`、`budget_exhausted`、`target_reached`。
- Export 完成后应明确告诉用户产物路径、包含内容、下一步怎么复现。
- 缺少“研究完成页”或“final summary block”，导致结果散落在 action stream 和右侧栏。

---

## 四、缺口清单

| ID | 优先级 | 缺口 | 当前影响 | 建议修复 |
| --- | --- | --- | --- | --- |
| U1 | P0 | Home goal 是否默认 `socratic` 未收敛 | 可能多弹一次模式框，打断自然语言快速启动 | Home source 默认 `socratic`；CSV source 保留模式选择 |
| U2 | P0 | 任务创建后无主动 onboarding | 用户看到 idle 文案，不知道下一步该说什么 | 创建 task 后注入 mode-aware onboarding event |
| U3 | P0 | Chat prompt 不区分交互模式 | Companion/Socratic 名义存在，行为差异不足 | 按 interactionMode 注入不同 system instruction |
| U4 | P1 | CSV 输入缺少即时校验 | 路径或参数错误发现太晚 | 输入后先 parse + fs 校验，错误直接显示在 dialog |
| U5 | P1 | Progress 缺少 active 状态与阶段摘要 | 用户知道阶段，但不知道具体卡在哪里 | 增加 active marker、profile summary、best metric |
| U6 | P1 | 自动 loop / pipeline 的解释层弱 | 用户不理解当前 agent 在做什么 | 将 loop iteration、stop reason、candidate selection 转成可读事件 |
| U7 | P1 | Export 后缺少 final summary | 用户不知道报告、代码、权重、配置是否齐全 | 导出后显示 final bundle summary block |
| U8 | P2 | Companion 模式缺少审批式 UX | review task 仍像普通任务列表 | 增加 pending approval、approve/reject、why now 的清晰入口 |
| U9 | P2 | Socratic 模式缺少澄清状态机 | 不能稳定地“一次只问一个问题” | 增加 intent slots 与 next-question builder |

---

## 五、建议修复设计

### 5.1 P0：Home goal 与 CSV task 分流

目标：

- Home 输入自然语言目标：默认 `socratic`，直接创建 autonomous task。
- New CSV Task：保留 `Interaction mode`，因为用户是在显式创建数据任务，可以接受一步选择。

建议逻辑：

```typescript
async function createTaskFromPrompt(value, source = "prompt") {
  const interactionMode = source === "home" ? "socratic" : await chooseInteractionMode()
  ...
}
```

验收标准：

- Home 输入 `Forecast ETTh1 horizon=24` 后不出现 `Interaction mode`。
- 创建出来的 task metadata 包含 `interactionMode: "socratic"` 和 `source: "home"`。
- `/csv`、`ctrl+n`、New CSV Task 仍先出现 `Interaction mode`。

### 5.2 P0：Mode-aware onboarding

目标：

创建 task 后不要只显示 idle 文案，而是由 Research Agent 主动发出第一条引导。

建议新增：

```typescript
function buildOnboardingMessage(input: {
  mode: ResearchInteractionMode
  datasetPath?: string
  targetCols?: string[]
  predictionLengths?: number[]
}) {
  if (input.mode === "socratic") return "..."
  return "..."
}
```

事件注入位置：

- `createCsvTask()` 创建 task 成功后。
- `createTaskFromPrompt()` 创建 task 成功后，如果没有立即跑 pipeline，也应注入。

验收标准：

- CSV task 创建后主区第一屏出现 onboarding 消息。
- Socratic 文案一次只问一个关键问题。
- Companion 文案给完整 checklist。
- 该消息进入 stream，不只是 toast。

### 5.3 P0：模式化 Research Agent prompt

目标：

让交互模式不只是 metadata，而是真正影响 Agent 的回答策略。

建议 prompt 结构：

```text
You are NeoResearch's Research Agent inside a TSF cockpit.

Current interaction mode:
- Socratic: ask one focused question at a time; do not dump a checklist unless asked.
- Companion: provide concise context, suggested action, risk, and command shortcut.

Current phase:
- 用户需求输入 / Data Profile / 自主探索 / 结果整理

Workspace state:
- task, objective, budget, selected candidate, latest run
```

验收标准：

- Socratic 下，用户说“下一步呢”，Agent 只问或建议一个最关键动作。
- Companion 下，Agent 给出“建议 / 原因 / 风险 / 可执行命令”四段式回复。
- 两种模式在 snapshot test 中可区分。

---

## 六、验收测试建议

### TUI render tests

新增或更新：

1. `home goal defaults to socratic without opening interaction mode`
2. `csv task asks interaction mode before dataset input`
3. `socratic csv task shows one-question onboarding`
4. `companion csv task shows checklist onboarding`
5. `chat context includes interaction mode instruction`
6. `runner missing shows detail and use project runner action`

### Data helper tests

新增：

1. `buildOnboardingMessage returns socratic first question`
2. `buildOnboardingMessage returns companion checklist`
3. `interactionModeForTask prefers metadata over task mode`
4. `taskModeForInteractionMode maps companion to review and socratic to autonomous`

### Manual smoke

```bash
bun test test/cli/tui/research-cockpit-render.test.tsx --timeout 30000
bun test test/cli/tui/research-cockpit-data.test.ts --timeout 30000
bun run typecheck
```

---

## 七、完成定义

这一轮 UX 修复完成，需要同时满足：

1. Home 自然语言目标能无阻塞进入默认 Socratic autonomous 流程。
2. CSV task 仍有明确模式选择和路径输入两步。
3. 创建 task 后主区有主动 onboarding，而不是只显示 idle placeholder。
4. Companion 与 Socratic 的 chat 行为有可测试差异。
5. 右侧 Progress、Runner、Champion 能解释当前状态和下一步。
6. Export 后能看到 final bundle 的路径与内容摘要。

---

## 八、结论

当前 NeoResearch TUI 已经具备主流程骨架：Home、Cockpit、CSV task、Interaction mode、Progress、Runner、Agent Loop、Export 都已经接上。主要缺口不再是“入口不可用”，而是“研究助理的产品化引导不足”。

最高优先级是三个 P0：

1. Home goal 默认 Socratic，避免模式弹窗打断自然语言启动。
2. task 创建后注入主动 onboarding。
3. Research Agent prompt 真正区分 Companion / Socratic。

这三项完成后，NeoResearch 的 TUI 会从“可操作的研究控制台”更接近“Vibe Data Science 工作台”。
