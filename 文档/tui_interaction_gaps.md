# NeoResearch TUI 交互缺口全量分析

> 日期：2026-04-29  
> 基于对 `home.tsx`、`research-cockpit.tsx`、`research-cockpit-data.ts`、`thread.ts`、`app.tsx` 及测试文件的完整阅读

---

## 一、测试合同违背（代码与测试断言不一致，现在就会 fail）

### G1 — Home 页 `[ ] Auto Mode` 不应出现

```
// research-home-render.test.tsx:139
expect(frame).not.toContain("[ ] Auto Mode")

// home.tsx:207 — 实际渲染
<text fg={theme.textMuted}>[ ] Auto Mode</text>
```

测试明确断言该文字不应出现，但代码仍在渲染它。**这是一个当前 failing 的测试。**

---

### G2 — Home 页 hint 文字内容与测试不匹配

```
// research-home-render.test.tsx:137
expect(frame).toContain("ctrl+p api-key / cockpit / csv / doctor")

// home.tsx:250 — 实际渲染
<text fg={theme.textMuted}>ctrl+p commands</text>
```

测试期望展示具体的斜杠命令名，但代码只显示泛称 `commands`。**这是另一个 failing 的测试。**

---

## 二、死代码 UI 元素（渲染出来但完全没有交互效果）

### G3 — Cockpit 底部 `esc interrupt` 没有绑定

```tsx
// research-cockpit.tsx:971
<text fg={cockpitColors.textMuted}>.. esc interrupt</text>
```

`busy()` 信号存在但没有取消机制。Esc 键在 cockpit 内没有任何 `useKeyboard` / keybind 监听，显示的提示是误导性的。

---

### G4 — Cockpit 底部 `tab agents` 没有绑定

```tsx
// research-cockpit.tsx:973
<text fg={cockpitColors.textMuted}>tab agents</text>
```

cockpit 内没有任何 Tab 键处理，点 Tab 会将焦点移出 textarea 到 opentui 下一个可聚焦元素，不会打开 agent 列表。

---

### G5 — Home 页 `tab tasks` 没有绑定

```tsx
// home.tsx:249
<text fg={theme.textMuted}>tab tasks</text>
```

Home 页没有任何 Tab 键逻辑，该提示无效。

---

### G6 — Home 页 `Configure API Key` 按钮永远显示

```ts
// home.tsx:29-36
const actions = [
  "Configure API Key",   // ← 永远在列表中
  "New CSV Task",
  "Open Cockpit",
  ...
] as const
```

`<Show when={needsApiKey()}>` banner 是条件显示的，但按钮行里 `Configure API Key` 永远渲染。API Key 已配置的用户看到该按钮点击后弹 toast 提示重启，体验混乱。

---

### G7 — Home 页 `Resume Last Task` / `Export Report` 功能一样

```ts
// home.tsx:165
if (action === "Open Cockpit" || action === "Resume Last Task" || action === "Export Report") {
  openCockpit()
  return
}
```

三个按钮导向同一个 `openCockpit()`，对用户没有区分意义。`Resume Last Task` 应该附带 task ID，`Export Report` 应该直接触发导出。

---

## 三、缺失的导航与切换

### G8 — Cockpit 无返回 Home 的路径

cockpit 内没有任何 `route.navigate({ type: "home" })` 调用，也没有键位或按钮。用户只能通过 `ctrl+p → New session` 间接回到 Home，路径完全不直观。

---

### G9 — 多任务存在时无任务列表 UI

```ts
// research-cockpit.tsx:135, 234
const [selectedIndex, setSelectedIndex] = createSignal(0)
const sortedTasks = createMemo(() => sortResearchCockpitTasks(tasks() ?? []))
const selectedTask = createMemo(() => sortedTasks()[selectedIndex()])
```

`selectedIndex` 逻辑存在，但没有任何 UI 渲染任务列表，也没有上/下键绑定。当有多个任务时，永远只显示第一个，`selectedIndex` 状态完全无用。

---

## 四、候选操作不完整

### G10 — `Ref Exec` / `Blind Exec` 按钮缺失

```tsx
// research-cockpit.tsx — 候选操作行
<text onMouseUp={() => void prepareCandidate(candidate)}>Smoke Prep</text>
<text onMouseUp={() => void executeCandidate(candidate)}>Smoke Exec</text>
<text onMouseUp={() => void prepareCandidate(candidate, "ref_test")}>Ref Prep</text>
<text onMouseUp={() => void prepareCandidate(candidate, "blind_test")}>Blind Prep</text>
// ← Ref Exec、Blind Exec 未渲染，但 executeCandidate(candidate, "ref_test/blind_test") 已实现
```

`Ref Prep` 完成后，下一步是执行 ref_test run，但按钮不存在，只能绕道命令面板（命令面板里也没有这两个命令）。

---

### G11 — `Request Ref Gate` / `Request Blind Gate` 无 UI 触发点

```ts
// research-cockpit.tsx:371-402
async function requestRefTestGate(candidate) { ... }
async function requestBlindTestGate(candidate) { ... }
```

两个函数实现完整，但候选操作行没有对应按钮，命令面板也没有注册这两个命令。用户无法从 UI 触发 gate 申请，只能等后台流程自动走。

---

### G12 — `Seed Sweep` 无候选操作行按钮

```ts
// research-cockpit.tsx:437
async function executeCandidateSeedSweep(candidate) { ... }
```

函数存在但未接入任何 UI，命令面板里也没有注册。

---

### G13 — 候选列表最多显示 3 条，无翻页

```tsx
// research-cockpit.tsx:800-801
<For each={(candidates() ?? []).slice(0, 3)} ...>
```

超过 3 个 candidate 时用户无法看到更多，也无法翻页或展开。

---

## 五、反馈与状态可见性缺口

### G14 — `busy()` 期间无进度显示

操作运行时只有按钮颜色变灰，没有加载动画、时间计时、操作名称展示。长时间运行（Agent Loop 可能数分钟）用户完全不知道是否在工作。

---

### G15 — Champion 数据取回但从不显示

```ts
// research-cockpit.tsx:213-218
const [champion] = createResource(selectedTaskSource, async (source) => {
  return researchRequest<ResearchCockpitChampion | null>(
    sdk,
    `/research/tasks/${encodeURIComponent(source.taskID)}/champion`,
  )
})
```

`champion` 用于计算 `workflowItems` 和 `recommendation`，但 champion 的具体信息（哪个 candidate、primary metric、utility score）从未在 UI 中展示，用户不知道当前冠军是谁。

---

### G16 — `neoCastProjectRoot` 缺失时 Agent Loop 禁用但无修复路径

```ts
// research-cockpit-data.ts:531-536
export function canExecuteResearchCockpitTask(task) {
  const root = runtime.neoCastProjectRoot
  return typeof root === "string" && root.trim().length > 0
}
```

`neoCastProjectRoot` 未设置时，`runnerReady()` 为 `false`，Agent Loop 按钮变灰，Next Action 显示 `Configure Neo-Cast runner`，但没有任何 UI 支持用户在 cockpit 内修改 taskSpec。用户只能删掉任务重建。

---

### G17 — 错误消息在下次操作时静默消失

```ts
// research-cockpit.tsx:271
setError(undefined)   // ← 每次新操作时清空
```

上次的错误信息会在下一次操作开始时立刻清空，没有错误历史，日志不可查。

---

## 六、右侧边栏布局问题

### G18 — `Workflow` 在右侧边栏渲染两次

```tsx
// research-cockpit.tsx:994-1027  — "Progress" 区块内
<For each={workflowItems().slice(0, 2)}>...
<For each={workflowItems().slice(2, 4)}>...
<For each={workflowItems().slice(4)}>...

// research-cockpit.tsx:1047-1058 — 独立 "Workflow" 区块
<text attributes={BOLD}>Workflow</text>
<For each={workflowItems()}>...
```

同样的 `workflowItems` 数据在右侧边栏出现两次（Progress 区块的拆分渲染 + Workflow 区块的完整渲染），占用了珍贵的 42 列宽度，且在截图中清晰可见。

---

### G19 — `LSP` 区块永远是占位文字

```tsx
// research-cockpit.tsx:1043-1045
<text attributes={BOLD}>LSP</text>
<text fg={cockpitColors.textMuted}>LSPs will activate as files are read</text>
```

无任何动态数据来源，永远显示同一句话，占用了右侧边栏空间但没有信息价值。

---

## 七、交互流程 UX 逻辑问题

### G20 — "New CSV Task" 默认创建 `review` 模式任务导致 Agent Loop 不可用

```tsx
// research-cockpit.tsx:699-703
<text onMouseUp={() => void createCsvTask("review")}>
  New CSV Task
</text>
```

顶部导航栏的 "New CSV Task" 用 `review` 模式创建任务，但 Agent Loop 要求 `mode === "autonomous"`：

```tsx
// research-cockpit.tsx:716-718
fg={
  selectedTask()?.mode !== "autonomous" || !runnerReady() || busy()
    ? cockpitColors.textMuted  // ← review 模式下按钮灰掉
    : cockpitColors.primary
}
```

新手流程：点 New CSV Task → 创建 review 任务 → 试点 Agent Loop → 按钮永远灰，无报错说明。

---

### G21 — Cockpit textarea 存在三重焦点竞争

```tsx
// research-cockpit.tsx:948-951  — ref 回调
ref={(value: TextareaRenderable) => {
  promptInput = value
  queueMicrotask(() => value.focus())     // 第一个 focus
}}
focused                                    // 第二个：静态 prop

// research-cockpit.tsx:141-143  — onMount
onMount(() => {
  focusTimer = setTimeout(() => promptInput?.focus(), 0)  // 第三个 focus
})
```

`queueMicrotask`、`focused` prop、`setTimeout` 三路同时触发 focus，在不同渲染节拍下可能相互覆盖，在某些终端下焦点落到意外元素。

---

### G22 — `promptEvents` 溢出时无滚动

```ts
// research-cockpit.tsx:503-511
setPromptEvents((events) => [...events.slice(-4), { ... }])
```

保留最近 5 条事件，每条渲染为一个 `border-left` 文本块，终端窗口高度不足时会溢出，opentui 不会自动滚动该区域。

---

## 八、缺口优先级汇总

| 编号 | 类别 | 影响 | 修复难度 |
|---|---|---|---|
| G1, G2 | 测试 fail | CI 红 | 低（改 2 行文字） |
| G20 | UX 流程 | 新手必踩坑 | 低（改 `"review"` → `"autonomous"`） |
| G8 | 导航 | 用户被困 cockpit | 低（加 `←` 按钮） |
| G3, G4, G5 | 死提示 | 误导用户 | 低（删除或实现） |
| G6, G7 | 死按钮 | 首屏体验差 | 低（逻辑修复） |
| G9 | 多任务 | 功能缺失 | 中（加任务列表面板） |
| G10, G11, G12 | 候选操作 | 关键流程不完整 | 中（加按钮 + cmd 注册） |
| G14 | 进度反馈 | 长任务体验差 | 中（加 busy 状态展示） |
| G15 | Champion 展示 | 结果不可见 | 中（加右侧 Champion 区块） |
| G16 | 配置修复路径 | 任务卡死无出路 | 中（加内联编辑或 prompt） |
| G18, G19 | 侧边栏冗余 | 浪费布局空间 | 低（删重复区块） |
| G13 | 候选分页 | 多候选不可见 | 中 |
| G17, G22 | 错误/溢出 | 调试体验差 | 中 |
| G21 | 焦点竞争 | 偶发失去焦点 | 低（删两个冗余 focus） |

---

## 九、最小可合并 PR 清单（按优先级）

### PR-1：修复 failing 测试 + 死代码（2 小时）

**文件**：`home.tsx`
- 删除 `[ ] Auto Mode` 文字（G1）
- 将 hint 改为 `ctrl+p api-key / cockpit / csv / doctor`（G2）
- 从 actions 数组中按条件显示 `Configure API Key`（G6）
- `Resume Last Task` 和 `Export Report` 拆分逻辑（G7）

**文件**：`research-cockpit.tsx`
- 删除右侧边栏重复的 `Workflow` 区块（G18）
- 删除 `LSP` 占位区块或替换为有意义内容（G19）
- 删除 `onMount` 里的第三个 focus（G21）

---

### PR-2：修复首屏新手流程（2 小时）

**文件**：`research-cockpit.tsx`
- "New CSV Task" 改为创建 `autonomous` 模式任务（G20）
- 加 `←` 返回 Home 的按钮或 Esc 绑定（G8）
- 把 `esc interrupt` / `tab agents` 死提示替换为实际可用的 hint（G3、G4）

---

### PR-3：补全候选操作（半天）

**文件**：`research-cockpit.tsx`
- 候选操作行补 `Ref Exec`、`Blind Exec` 按钮（G10）
- 候选操作行补 `Request Ref Gate`、`Request Blind Gate`（G11）
- 候选操作行补 `Seed Sweep`（G12）
- 命令面板补注册以上三类操作（G10–G12）
- 候选列表加"展开更多"（G13）

---

### PR-4：状态可见性（半天）

**文件**：`research-cockpit.tsx`
- `busy()` 时在顶部 header 区显示操作名 + 耗时（G14）
- Champion 区块：显示 `candidateID`、`primaryMetric`、`utility`（G15）
- 错误区块改为可累积日志（G17）
- `neoCastProjectRoot` 缺失时在 Next Action 区提供内联 prompt（G16）

---

### PR-5：多任务导航（一天）

**文件**：`research-cockpit.tsx`
- 在主内容区顶部或左侧加任务选择列表（G9）
- 绑定 `j`/`k` 或 `↑`/`↓` 键切换 `selectedIndex`
