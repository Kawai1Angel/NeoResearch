# NeoResearch TUI 进展 Review

> 日期：2026-05-01  
> 基于提交 `5bd5c6e` → `331d4ff` → `274226a` 的完整代码阅读  
> 测试状态：TUI + Research 195 tests pass，typecheck clean

---

## 一、总体进展

三次提交在上次分析（tui_interaction_gaps.md）基础上关闭了绝大多数缺口。

### 已修复项（原 22 个缺口中的 17 个）

| 项目 | 原缺口编号 |
|---|---|
| `[ ] Auto Mode` 死代码删除 | G1 |
| hint 文字改为 `ctrl+p api-key / cockpit / csv / doctor` | G2 |
| `Configure API Key` 按钮按需显示（只在无 key 时出现） | G6 |
| `Resume Last Task` / `Export Report` 逻辑拆分 | G7 |
| Home `onMount` 焦点时序修复（`setTimeout(..., 0)` 模式） | 焦点 Bug |
| cockpit `focused` prop 三重焦点竞争消除 | G21 |
| `Home ^H` 返回按钮 + `ctrl+h` keybind | G8 |
| Previous / Next Task 导航（`ctrl+j` / `ctrl+k`） | G9 |
| New CSV Task 默认改为 `autonomous` 模式 | G20 |
| Ref Gate / Seed Sweep / Ref Exec / Blind Gate / Blind Prep / Blind Exec 按钮全部接入 UI | G10–G12 |
| Candidate 分页（Previous / Next Candidate + `ctrl+]` / `ctrl+[`） | G13 |
| Champion 在右侧边栏展示 | G15 |
| `busy()` 期间显示操作名 + 锁定提示 | G14 |
| 错误日志持久化（最近 10 条，侧边栏 + 主内容区双显） | G17 |
| `neoCastProjectRoot` 缺失时提供内联修复按钮（Use Project Runner / Edit Runner Root） | G16 |
| `/slash` 命令系统（25 个命令全注册）+ `ResearchSlashMenu` 浮层 | G3–G5 |
| Home 输入目标通过 `researchGoal` 字段传入 cockpit，自动创建 task + 触发 iterate | — |
| `actionQueue` Promise 链串行化并发操作，防止竞态 | — |

### 新增能力（本轮新引入，非原缺口）

- **ASCII art banner**（`NEO_RESEARCH_HOME_BANNER`）替代原来的纯文字标题
- **`compactHeight` 响应式布局**：终端高度 < 42 行时自动收紧间距
- **`parseTsfCsvTaskInput`**：CSV task 对话框支持解析 `target=OT horizon=24 context=96 full` 参数字符串
- **`updateResearchCockpitTaskRunnerRoot`**：内联修改 taskSpec 的 runner root，无需删任务重建
- **`runRecommendedAction`**：一键执行当前 recommendation，优先级链完整（pending gate → profile → seed → loop → execute → export）
- **`promptEventHistoryLimit = 20`**：prompt 历史上限从 5 提升到 20 条

---

## 二、当前代码状态速览

```
Home
  ├─ ASCII banner（5行）
  ├─ textarea + ResearchSlashMenu（placement=below）
  ├─ 条件显示 API Key 配置 banner
  ├─ 动态 actions（有 key 时不含 Configure API Key）
  └─ compactHeight 分支 hint

Cockpit
  ├─ 顶部导航栏：Home ^H / Previous Task ^K / Next Task ^J /
  │              New CSV Task ^N / Seed Baselines ^B / Agent Loop ^L / Export Report ^E
  ├─ error log（最近 3 条，height 自适应）
  ├─ busy 提示 banner
  ├─ 主内容区（Switch）
  │   ├─ [有 task] Workflow / State / Next Action(+Run Next+Runner配置) /
  │   │          Forecaster候选列表(分页) / Research Notes(Champion+Artifacts+Memory)
  │   └─ [无 task] Workflow + Next Action
  ├─ Prompt History（>0 条时显示）
  ├─ prompt textarea + ResearchSlashMenu（placement=above）
  ├─ 底部 hint：enter submit / ctrl+p commands
  └─ 右侧边栏（42列）：
      Task N/M / Candidate N/M / status / Use Project Runner（条件）/
      Progress / Context / Recent Errors（条件）/ Champion / 路径+alpha

右侧边栏 Champion 区块：
  ├─ 有 champion → candidate 短ID / metric / utility（绿色）
  └─ 无 champion → "No champion selected"（灰色）
```

---

## 三、剩余 Bug

### Bug 1 — `ctrl+h` / `ctrl+[` 终端键冲突【高危，真实终端必踩】

**位置**：`research-cockpit.tsx:911, 1203`

```ts
keybind: "ctrl+h",   // POSIX 终端：0x08 = Backspace/DEL
keybind: "ctrl+[",   // VT100 标准：0x1B = ESC
```

**现象**：在 cockpit 的 prompt 输入框中：
- 用户按退格键删字符 → `ctrl+h` 触发"返回 Home"，整个 cockpit 路由被切走
- 用户按 Esc 关闭浮层 → `ctrl+[` 触发"上一个 Candidate"

opentui 配置了 `useKittyKeyboard: {}` 可以在支持 Kitty Keyboard Protocol 的终端中区分这些键（iTerm2/Ghostty/Wezterm 支持），但 **macOS Terminal.app 不支持**，是最常用的开发终端。

**修复方案**：
```ts
// 改为不冲突的绑定
keybind: "alt+h",      // 替换 ctrl+h（Home）
keybind: "alt+left",   // 替换 ctrl+[（Previous Candidate）
keybind: "alt+right",  // 替换 ctrl+]（Next Candidate）
```

---

### Bug 2 — Candidate 操作行 9 个按钮在 80 列终端被截断【高危，标准宽度下功能不可见】

**位置**：`research-cockpit.tsx`，候选 `<For>` 渲染块内的操作行

```tsx
<box flexDirection="row" gap={1}>
  Smoke Prep  Smoke Exec  Ref Gate  Seed Sweep  Ref Prep  Ref Exec  Blind Gate  Blind Prep  Blind Exec
  // 最小宽度估算：9×9字符标签 + 8×1间距 ≈ 89 字符
</box>
```

标准 80 列终端中，主内容区可用宽度 ≈ `80 - 42(sidebar) - 3(padding) = 35 列`。宽屏（160 列）约 `115 列`。  
在任何 80 列终端中，后 3~4 个按钮（`Blind Gate`/`Blind Prep`/`Blind Exec`）完全不可见。

**修复方案**：
```tsx
// 方案 A：拆成两行
<box flexDirection="row" gap={1}>  {/* 第一行：smoke + ref */}
  Smoke Prep  Smoke Exec  Ref Gate  Ref Prep  Ref Exec
</box>
<box flexDirection="row" gap={1}>  {/* 第二行：blind + sweep */}
  Blind Gate  Blind Prep  Blind Exec  Seed Sweep
</box>

// 方案 B：缩短标签
SmkP  SmkX  RefG  Sweep  RefP  RefX  BlndG  BlndP  BlndX
// 约 51 字符，80 列终端可容纳
```

---

### Bug 3 — `ResearchSlashMenu` 模块级可变状态跨路由泄漏【中危】

**位置**：`research-slash-menu.tsx:28-29`

```ts
// 模块顶层（所有实例共享）
const selectedSlashIndexes = new Map<string, number>()
const [selectionRevision, setSelectionRevision] = createSignal(0)
```

**问题**：
1. `selectionRevision` 是全局 SolidJS signal，任何实例变更它都会触发**所有** `ResearchSlashMenu` 实例的 `createEffect` 重新执行
2. `selectedSlashIndexes` 积累历史 key 不清理，从 Cockpit 切回 Home 后，之前的菜单选择位置残留，第二次打开同名命令的菜单时默认选中非预期项

**修复**：将两个变量从模块级移入组件内部：
```ts
export function ResearchSlashMenu(props: ...) {
  const selectedSlashIndexes = new Map<string, number>()  // 组件实例独立
  const [selectionRevision, setSelectionRevision] = createSignal(0)
  // ...
}
```

---

### Bug 4 — `createTaskFromPrompt` 无条件触发 `/autonomous/iterate`【中危】

**位置**：`research-cockpit.tsx:821-828`

```ts
const executableTask = canExecuteResearchCockpitTask(task)
  ? task
  : { ...task, taskSpec: payload.taskSpec }

if (executableTask.mode === "autonomous" && canExecuteResearchCockpitTask(executableTask)) {
  await researchRequest(..., `/research/tasks/${task.id}/autonomous/iterate`, ...)
}
```

`payload.taskSpec` 中 `neoCastProjectRoot = sdk.directory ?? process.cwd()`，任何非空路径都能通过 `canExecuteResearchCockpitTask` 的检查（它只验证字段存在且非空，不验证路径有效性）。

**结果**：当前目录不是合法 neo_cast 项目时：
- toast 显示 `"task created"` ✅（成功）
- 随即 error log 出现 iterate 失败 ❌
- 用户同时看到 success + error，无法判断任务状态

**修复**：在自动触发 iterate 前加一层验证，或明确只在 runner 就绪状态下自动 iterate：
```ts
// 仅当 runner 真正可执行时才自动触发
const shouldAutoIterate = executableTask.mode === "autonomous"
  && canExecuteResearchCockpitTask(executableTask)
  && runnerReady()  // 增加检查

if (shouldAutoIterate) { ... }
```

---

### Bug 5 — 右侧边栏 `Forecaster` 行 mark 硬编码 `[ ]`【低危】

**位置**：`research-cockpit.tsx:1594-1597`

```tsx
<text fg={cockpitColors.text}>
  [ ] Forecaster {succeededRuns()}/{maxRuns()} experiments
</text>
```

`[ ]` 永远不更新，即使实验跑完（`succeededRuns() >= maxRuns()`）也不变成 `[x]`，与主内容区的动态 `workflowMark()` 不一致。

**修复**：
```tsx
const forecasterMark = createMemo(() => {
  if (maxRuns() > 0 && succeededRuns() >= maxRuns()) return "[x]"
  if (succeededRuns() > 0) return "[o]"
  return "[ ]"
})

<text fg={...}>
  {forecasterMark()} Forecaster {succeededRuns()}/{maxRuns()} experiments
</text>
```

---

### Bug 6 — `StreamLine` 类型与 `streamLineColor` 函数定义但未使用【低危 / 清理】

**位置**：`research-cockpit.tsx:126-145`

```ts
type StreamLine = { id: string; text: string; tone?: "text" | "muted" | ... }
function streamLineColor(tone: StreamLine["tone"]) { ... }
```

两者均未在 JSX 中使用，是规划中的流式输出功能的遗留占位。不影响运行，但增加维护成本。

**修复**：直接删除，等真正实现流式输出时再引入。

---

### Bug 7 — 空态 cockpit 中 `Workflow` 内容在主区域和右侧边栏各渲染一遍【低危 / 清理】

**位置**：主内容区 `Match when={true}` 分支（约 1585 行）和右侧边栏 Progress 区块（约 1724 行）

无任务时，主内容区渲染完整 `workflowItems`（全为 `[ ] todo`），右侧边栏 Progress 区块也渲染同样的三段 `workflowItems`。内容完全相同，浪费 42 列边栏的宝贵空间。

**修复**：空态下右侧边栏只保留 Context 计数，隐藏 Progress 区块。

---

## 四、修复优先级汇总

| 编号 | 严重程度 | 描述 | 修复难度 |
|---|---|---|---|
| Bug 1 | **必须修** | `ctrl+h`/`ctrl+[` 在标准终端中触发 Backspace/ESC | 低（改 keybind 字符串） |
| Bug 2 | **必须修** | 候选操作行 9 个按钮在 80 列终端被截断 | 低（拆两行或缩短标签） |
| Bug 3 | 应修 | SlashMenu 模块级状态跨路由泄漏 | 低（移入组件内部） |
| Bug 4 | 应修 | 创建 task 时立即 iterate 导致 success+error 双重反馈 | 低（加一行 `runnerReady()` 检查） |
| Bug 5 | 可修 | Forecaster mark 硬编码 `[ ]` | 极低（加 `createMemo`） |
| Bug 6 | 清理 | `StreamLine` 死代码 | 极低（删两段代码） |
| Bug 7 | 清理 | 空态 Workflow 重复渲染 | 低（加条件隐藏） |

---

## 五、结论

**TUI 交互骨架已完整，测试全绿**。距离"在真实终端中可正常使用"还差：

1. **Bug 1**（keybind 冲突）——在 macOS Terminal.app 中，退格 = 切换 Home，Esc = 换候选，严重破坏交互
2. **Bug 2**（按钮截断）——标准 80 列终端下，Blind Gate / Blind Prep / Blind Exec 三个操作完全不可见

其余均是体验层面的打磨，不影响核心功能路径。
