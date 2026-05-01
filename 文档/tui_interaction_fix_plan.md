# TUI 交互问题修复方案

> 日期：2026-04-29  
> 问题来源：`bun run --conditions=browser ./src/index.ts` 启动后 TUI 无法交互  
> 文件路径：`opencode/packages/opencode/`

---

## 问题诊断

### 问题 1 — Home 页输入框无法接收键盘输入

**现象**：光标显示在输入框中，但敲键盘无响应。

**根本原因**：`app.tsx` 中 `rendererConfig()` 设置了 `autoFocus: false`，依赖 `onMount` 里的 `input?.focus()` 来手动聚焦。但 opentui 渲染器在 `render()` 完成前就触发了 `onMount`，此时渲染器的键盘事件循环尚未就绪，`focus()` 调用实际上无效。

```ts
// app.tsx:69-90
function rendererConfig(_config: TuiConfig.Info): CliRendererConfig {
  return {
    autoFocus: false,   // ← 关闭自动聚焦，但手动聚焦时序有误
    ...
  }
}

// home.tsx:100-102
onMount(() => {
  input?.focus()        // ← 在渲染器就绪前调用，不生效
})
```

**修复方案**：

1. 将 `autoFocus` 改回 `true`（最简方案，副作用最小）；**或**
2. 用 `queueMicrotask` / `setTimeout(0)` 延迟 `focus()` 调用，让渲染器事件循环先启动。

```ts
// 方案 A：app.tsx — 恢复自动聚焦
autoFocus: true,

// 方案 B：home.tsx — 延迟聚焦（保持 autoFocus: false 时）
onMount(() => {
  setTimeout(() => input?.focus(), 0)
})
```

同理 `research-cockpit.tsx:140-142` 的 `onMount(() => { promptInput?.focus() })` 需要同样处理。

---

### 问题 2 — Home 页动作按钮只能鼠标点击，无法键盘操作

**现象**：`New CSV Task / Open Cockpit / Run Doctor / Resume Last Task / Export Report` 这些按钮只绑定了 `onMouseUp`，无法用 Tab/Enter/方向键选中执行。

**根本原因**：

```tsx
// home.tsx:237-244
<For each={actions}>
  {(action) => (
    <text fg={theme.primary} onMouseUp={() => runAction(action)}>
      {action}
    </text>
  )}
</For>
```

`<text>` 元素没有 `focusable` 属性，键盘无法聚焦到它们。

**修复方案**：将按钮列表改为可聚焦的 `<box>` 或使用 `ctrl+p` 命令面板路由替代鼠标操作。短期最小改动：

```tsx
// home.tsx — 在 actions 行上面加快捷键提示，并把常用操作接入 command palette
// 已有 command.register() 注册了 "Open Cockpit"、"Create CSV task" 等命令
// 只需修改 hint 文字，引导用户用 ctrl+p 触发
<text fg={theme.textMuted}>ctrl+p open cockpit / new csv task / doctor</text>
```

长期方案：给每个按钮加 `focusable` 属性并绑定 `onKeyDown` 处理 Enter 键。

---

### 问题 3 — Home 页 "[ ] Auto Mode" 是死代码

**现象**：`[ ] Auto Mode` 永远不变，点击无响应。

**根本原因**：

```tsx
// home.tsx:205-207
<text fg={theme.textMuted}>* </text>
<text fg={theme.textMuted}>[ ] Auto Mode</text>
```

纯静态文本，没有 signal、没有 `onMouseUp` 处理器。

**修复方案**（两选一）：

```tsx
// 方案 A：删除 Auto Mode 显示（最快，避免用户困惑）
// 直接删除这两行

// 方案 B：接入实际 signal
const [autoMode, setAutoMode] = createSignal(false)

<text
  fg={autoMode() ? theme.primary : theme.textMuted}
  onMouseUp={() => setAutoMode(v => !v)}
>
  {autoMode() ? "[x] Auto Mode" : "[ ] Auto Mode"}
</text>
```

---

### 问题 4 — Cockpit 主区域空白（无任务时无 empty state）

**现象**：进入 Cockpit 后主区域全黑，右侧显示 "No research task selected"，没有任何引导。

**根本原因**：

```tsx
// research-cockpit.tsx:144-146
const [tasks] = createResource(refresh, async () => {
  return researchRequest<ResearchCockpitTask[]>(sdk, "/research/tasks?limit=30")
})
```

当数据库没有 task 记录时，`tasks()` 返回 `[]`，`selectedTask()` 为 `undefined`，渲染器进入空状态但没有空状态 UI 分支。

**修复方案**：在主内容区加 `<Show when={!selectedTask()}>` 的 empty state 提示：

```tsx
<Show
  when={selectedTask()}
  fallback={
    <box alignItems="center" justifyContent="center" flexGrow={1}>
      <text fg={cockpitColors.textMuted}>No research task yet.</text>
      <text fg={cockpitColors.textMuted}>
        Press <text fg={cockpitColors.primary}>N</text> to create a CSV task,
        or run <text fg={cockpitColors.primary}>neo-research doctor</text> to verify your environment.
      </text>
    </box>
  }
>
  {/* existing task detail UI */}
</Show>
```

---

### 问题 5 — Cockpit 右侧 Todo 列表是硬编码静态数据

**现象**：右侧 Progress/Todo 始终显示 DLinear/PatchTST/TimesNet/Chronos 固定条目，不反映实际任务状态。

**根本原因**：

```ts
// research-cockpit.tsx:90-97
const forecastTodoItems = [
  { label: "Round 1: DLinear (decomposition baseline)", status: "done" },
  { label: "Round 1: PatchTST (patch-based transformer)", status: "active" },
  ...
] as const
```

这是写死的演示数据，不从 `candidates()` / `runs()` / `selectedTask()` 派生。

**修复方案**：从 `candidates()` 动态生成 todo 项目：

```ts
const dynamicTodoItems = createMemo(() => {
  const cs = candidates() ?? []
  if (cs.length === 0) return forecastTodoItems  // fallback to demo data
  return cs.map(c => ({
    label: `${c.title ?? c.id}`,
    status: c.status === "succeeded" ? "done"
           : c.status === "running" || c.status === "queued" ? "active"
           : "todo",
  }))
})
```

---

### 问题 6 — 直接用 dev 命令启动时 Worker 路径解析可能失败

**现象**：运行 `bun run --conditions=browser ./src/index.ts` 时，`thread.ts` 内的 `target()` 函数先找编译产物 `./cli/cmd/tui/worker.js`，找不到再 fallback 到源码 `./worker.ts`。但在 `--conditions=browser` 模式下，Bun Worker 加载 `.ts` 源文件时模块条件与主进程不一致，可能导致 `#db`、`#pty` 等条件导入解析失败，Worker 内部静默崩溃。

**验证方法**：

```bash
cd opencode/packages/opencode
PATH=/Users/chengmingyue/.bun/bin:$PATH bun run --conditions=browser ./src/index.ts 2>&1 | head -50
# 或打开 opentui console overlay: ctrl+p → "Toggle console"
```

**修复方案**：

```bash
# 开发时改用 make dev-cli，它通过 scripts/dev_cli.sh 正确设置环境
make dev-cli

# 或先 build 再运行
cd opencode/packages/opencode
npm run build
./bin/neo-research
```

若必须用源码模式，在 `thread.ts` 的 `Worker` 构造时显式传递 `smol: false` 和正确的 `env` 条件：

```ts
const worker = new Worker(file, {
  env,
  // Bun Worker 默认不继承父进程的 --conditions，需要显式传递
})
```

---

## 修复优先级与工作量

| 优先级 | 问题 | 文件 | 工作量 |
|---|---|---|---|
| P0 | 问题 6：Worker 条件导入失败导致完全无响应 | `thread.ts` | 改用 `make dev-cli` 启动，无需改代码 |
| P0 | 问题 1：输入框焦点时序错误 | `home.tsx:101`, `research-cockpit.tsx:141` | 2 行改动 |
| P1 | 问题 4：Cockpit 无 empty state | `research-cockpit.tsx` | ~15 行新增 |
| P1 | 问题 3：Auto Mode 死代码 | `home.tsx:205-207` | 删除 2 行或加 signal |
| P2 | 问题 5：Todo 硬编码 | `research-cockpit.tsx:90-97` | ~15 行改动 |
| P2 | 问题 2：按钮无键盘导航 | `home.tsx:237-244` | 改 hint 文字即可缓解 |

---

## 快速验证步骤

```bash
# Step 1：用正确方式启动
cd /Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf/neo-research
make dev-cli
# 或：
cd opencode/packages/opencode
npm run build && ./bin/neo-research

# Step 2：确认键盘响应
# 启动后立即在终端敲字，应在 Home 输入框出现
# 若无响应，按 ctrl+p 看命令面板是否弹出

# Step 3：创建第一个 task 验证 Cockpit
# 在 Home 页按 ctrl+p → "Open research cockpit"
# 在 Cockpit 页按 ctrl+p → "Create CSV research task"，输入 CSV 路径

# Step 4：验证修复后的焦点
# 应用 问题1 修复后，重新 build，启动时输入框应立即接受键盘输入
```

---

## 最小可合并 PR 清单

1. **`home.tsx`**：`onMount(() => setTimeout(() => input?.focus(), 0))` + 删除 `[ ] Auto Mode` 死代码 + hint 文字更新为 `ctrl+p` 引导
2. **`research-cockpit.tsx`**：`onMount` 同样修复 + 加 empty state UI + `forecastTodoItems` 改为从 `candidates()` 派生
3. **`Makefile` / README**：明确开发启动命令为 `make dev-cli` 而非 `bun run --conditions=browser ./src/index.ts`
