# NeoResearch UX 改造方案：对话优先 + 斜杠命令

> 状态：核心改造已落地，剩余增强项见第八节
> 目标版本：v0.2.0-alpha
> 作者：Mingyue Cheng
> 日期：2026-05-08
> 最近更新：2026-05-08

---

## 〇、当前实现摘要

本方案的核心目标已经在 `opencode/packages/opencode/src/cli/cmd/tui/routes/research-cockpit.tsx` 及相关模块中落地：

- **对话优先入口**：驾驶舱顶部按钮森林已收敛为轻量命令提示，主输入框承担自然语言与斜杠命令双入口。
- **正交斜杠命令**：`/new`、`/dataset`、`/run`、`/loop`、`/task`、`/candidate`、`/runner`、`/mode`、`/seed`、`/export`、`/abort`、`/help`、`/home` 已注册；旧命令保留为 alias 兼容。
- **Next Best Action**：新增 `selectNextBestAction(...)` 纯函数，驾驶舱渲染唯一推荐动作卡片；输入框为空时按 `Enter` 会执行当前 proposal 或 NBA。
- **Action Proposal**：驾驶舱可解析 LLM 返回的 `action_proposal` JSON，并渲染成“我建议执行 / 原因 / Enter 执行”的确认气泡。
- **快捷键收敛**：保留核心键位；已移除的旧快捷键首次按下时显示迁移提示，不再直接触发旧动作。
- **新用户引导**：首次进入 cockpit 会显示一次欢迎气泡，并写入 `~/.local/share/neo-research/onboarded.json`。
- **运行输出归入对话流**：runner progress、run summary、错误摘要已经在 conversation pane 中显示；专门的可折叠 Run Block 与 `Tab` 展开仍作为后续增强项。

本轮验证结果：

```bash
cd opencode/packages/opencode && bun typecheck
cd opencode/packages/opencode && bun test
```

结果：`bun typecheck` 通过；`bun test` 通过（`2530 pass, 0 fail`）。

## 一、问题诊断

改造前，驾驶舱（`research-cockpit.tsx`）暴露了 **30+ 个动作入口**，且每一个都同时拥有：

- 一个英文标题（命令面板）
- 一个 `slash` 名称（含别名）
- 部分还有一个 `keybind`（`alt+h / ctrl+n / ctrl+b / ctrl+l / ctrl+j / ctrl+k / alt+left / alt+right / ctrl+e`）

带来的实际体验问题：

1. **入口三套并行，认知负担重**：用户既要记快捷键，又要认按钮，还要会斜杠命令。
2. **动作语义割裂**：`/review`、`/review-full`、`/review-csv`、`/review-csv-full`、`/task`、`/task-full`、`/csv`、`/csv-full` 八个新建任务命令，本质只是两个 axis（review/autonomous × etth1/csv × bridge/full）的笛卡尔积——让用户在斜杠面板里对着八个相似词条选择。
3. **门控按钮过多**：`/ref-gate`、`/ref-exec`、`/blind-gate`、`/blind-exec`、`/seed-sweep`、`/approve`、`/reject`、`/iterate`、`/agent-loop`、`/next`，看似精细但实际语义重叠（"下一步该做什么"在大多数场景下是确定的）。
4. **状态—动作的耦合不清晰**：用户不知道当前**应该**按哪个，因为驾驶舱没有"系统建议的下一步"作为单一焦点，反而把所有可能的动作平铺出来。
5. **对话区只是一个旁路**：当时的 chat 区域承担"和 LLM 澄清意图"职能，但**所有运行控制依然依赖快捷键/按钮**——对话和控制是两套并行系统，违反了"对话优先"的直觉。

> 一句话总结：**驾驶舱被设计成了"控制台"，而它本应是"研究伙伴"**。

---

## 二、设计原则

改造后的 UX 遵循 **三条核心原则**：

### 2.1 对话是默认入口

- 用户的主输入框始终是 **chat / `:` 命令行**（同一个区域，模式自动切换）。
- 自然语言进入 LLM 路由 → 由 LLM 判断意图并调用相应内部 action。
- 显式控制走斜杠：`/<command>`。
- **取消"按按钮"作为正常路径**——按钮只在异常或不可逆操作（abort、export、删除）时出现。

### 2.2 单一焦点：Next Best Action

驾驶舱右上角始终显示**一条**系统推荐动作，比如：

```
▶ Next: Prepare dataset (METR-LA.csv mismatch)
```

按 `Enter` 直接执行；其他动作通过对话或斜杠命令获取。再不需要在十几个按钮里挑一个。

### 2.3 命令收敛：少而正交

把当前 30+ 命令收敛到 **约 13 个正交根命令**（核心研究命令 + `/home` 导航命令），所有变体通过参数表达：

```
/new <type> [--csv <path>] [--full] [--mode review|autonomous]
/run [--smoke|--full|--ref|--blind]
/loop [start|stop|status]
/task [next|prev|list <pattern>]
/candidate [next|prev|approve|reject]
/dataset [prepare|profile|status]
/runner [check|edit-root|use-project]
/mode [companion|socratic]
/seed
/abort
/export [bundle|report]
/help [command]
/home
```

---

## 三、新版交互架构

### 3.1 三区布局

```
┌─────────────────────────────────────────────────────────────────┐
│ ① Conversation Pane（左 60%）                                    │
│    ─ 用户消息                                                    │
│    ─ Agent 消息（含可点击的 Action chips）                       │
│    ─ Run / Stream 输出嵌入对话流（折叠展示）                     │
│                                                                  │
│    ┌───────────────────────────────────────────────────────┐    │
│    │ ▶ Next: Prepare dataset (METR-LA.csv mismatch)        │    │ ← 单一焦点
│    │   [Enter] 执行   [/skip] 跳过   [/why] 询问理由        │    │
│    └───────────────────────────────────────────────────────┘    │
│                                                                  │
│    [输入框：自然语言 或 /command]                                │
├─────────────────────────────────────────────────────────────────┤
│ ② Status Strip（右 40%，竖向）                                   │
│    ─ Task 选择器（下拉 + ↑↓）                                    │
│    ─ Champion 卡（指标 + 配置）                                  │
│    ─ Runner 状态（ready / mismatch / error，单行）              │
│    ─ Agent Loop 进度条（迭代/预算/champion 改进次数）            │
│    ─ Memory & Reflection（最近 3 条要点）                        │
└─────────────────────────────────────────────────────────────────┘
```

**关键变化**：把"按钮区/动作面板"从 UI 中**完全移除**。所有可执行项要么由 Next Best Action 推送，要么由对话/斜杠唤起。

### 3.2 用户消息 → 行为路由

```
┌──────────────────────────────────────────┐
│ 用户在输入框敲了 Enter                     │
└──────────────┬───────────────────────────┘
               │
        ┌──────┴───────┐
        │  以 / 开头？  │
        └─┬──────────┬─┘
          │ 是        │ 否
          ▼          ▼
   斜杠命令解析    LLM Intent Router
   （本地直连）    （Companion / Socratic）
          │          │
          │          ├─→ 检测到可执行意图？
          │          │   是：生成 Action chip，
          │          │   等待用户 Enter 确认
          │          │   否：自然语言回复
          │          ▼
          ▼     LLM 输出
       执行 action
          │
          ▼
   结果以"Agent 消息"流式回写到对话区
```

目标上游 LLM Intent Router 输出结构化意图（zod schema 约束），驾驶舱据此渲染 Action chip。**不让 LLM 直接执行**——所有副作用动作必须由用户按 Enter 二次确认（除非是只读的 profile/status/check 类）。当前版本已完成 cockpit 端解析与确认，上游 intent-agent schema 约束仍待增强。

### 3.3 对话内嵌 Run Output

改造前，Run 的 stdout/stderr 在右侧滚动条里独立显示，跟对话脱钩。当前已完成第一步迁移：live runner progress、run summary 和 failure reason 会作为 conversation stream 的一部分显示。

后续增强目标：

- Run 启动 → 在对话区插入一个**可折叠 Run Block**：

  ```
  ⏵ Run #42  candidate=patch_mlp  smoke …
     [折叠]  当前 epoch 1/2  loss 0.412
  ```

- 用户可通过后续定义的展开操作查看完整 stdout，但默认折叠，让对话主线干净。
- Run 结束自动写入摘要到 Agent 消息：

  ```
  ✓ Run #42 完成  val_avg_mse=0.367  ⬆新 champion
  ```

当前实现说明：

- 已有：runner progress line、run summary、failure summary 进入 conversation pane。
- 未完成：独立 Run Block 组件、默认折叠状态、`Tab` 展开完整 stdout。
- 注意：`Tab` 目前仍用于切换底部 research stage agent，不应在当前版本改成展开 run block，除非先重新设计焦点模型。

---

## 四、命令表（改造后）

> 总数：13 个根命令 + 子命令（其中 `/home` 是导航命令）；快捷键收敛到 5 个最高频。

### 4.1 根命令

| 命令 | 子命令 / 参数 | 替代了哪些旧命令 / 当前状态 |
|---|---|---|
| `/new` | `[task\|csv\|review\|autonomous\|preset] [--mode] [--full]` | 已落地；替代 `/review`、`/review-full`、`/review-csv`、`/review-csv-full`、`/task`、`/task-full`、`/csv`、`/csv-full` |
| `/task` | `[next\|prev\|list\|select <id>]` | 已落地；替代 `/task-next`、`/task-previous` |
| `/candidate` | `[next\|prev\|approve\|reject]` | 已落地；替代 `/candidate-next`、`/candidate-previous`、`/approve`、`/reject` |
| `/dataset` | `[prepare\|profile\|status]` | 已落地；替代 `/prepare-dataset`、`/profile` |
| `/run` | `[smoke\|full\|ref\|blind\|seed-sweep]` | 已落地；替代 `/iterate`、`/ref-gate`、`/ref-exec`、`/blind-gate`、`/blind-exec`、`/seed-sweep` |
| `/loop` | `[start\|stop\|status]` | 已落地；替代 `/agent-loop`、loop 子集的 stop/status |
| `/mode` | `[companion\|socratic]` | 已落地；替代 `/mode-companion`、`/mode-socratic` |
| `/runner` | `[check\|edit-root\|use-project]` | 已落地；替代 `/use-project-runner`、`/edit-runner-root` |
| `/seed` | `/run seed-sweep` 的高频别名 | 已落地；替代 `/seed-baselines` |
| `/export` | `[bundle\|report]` | 已落地 |
| `/abort` | — | 已落地；取消当前 chat/run/loop |
| `/help` | `[command]` | 已落地；当前为简明 help notice |
| `/home` | — | 已落地 |

### 4.2 收敛后的 5 个核心快捷键

| 键 | 行为 | 设计理由 |
|---|---|---|
| `Enter` | 执行 Next Best Action（输入框为空时）/ 发送消息（输入框非空时） | **最高频** |
| `Esc` | 取消当前对话气泡的 Action chip / 取消正在编辑的 slash | **可逆性** |
| `Ctrl+J` / `Ctrl+K` | 任务切换 | 唯一保留的"导航类"快捷键 |
| `Ctrl+L` | 清屏对话（不影响数据） | 高频整洁需求 |
| `Ctrl+C` | abort 当前 run/loop（不退出 TUI） | 标准约定 |

> **删除**的快捷键：`alt+h`、`ctrl+n`、`ctrl+b`、`ctrl+e`、`alt+left/right`——全部走斜杠。
> 这些动作不在"每分钟都要按"的频次档，不值得占用键位预算。

---

## 五、Next Best Action（NBA）规则

驾驶舱基于状态机推导**唯一**推荐动作。优先级从高到低：

| 状态条件 | 推荐 NBA |
|---|---|
| 没有 task | `/new csv` |
| 正在 queued/running | 隐藏 NBA |
| Runner 不健康（`runnerReady=false`，缺 venv/路径错） | `/runner check` |
| 数据集 mismatch（`prepared.json` 不匹配 task spec） | `/dataset prepare` |
| Task 创建后未澄清意图（`intentSlots` 有空缺） | 显示 LLM 追问气泡，无 NBA 按钮 |
| 有 pending approval | `/candidate approve` 或 `/candidate reject` |
| 没有 baselines 且 mode=autonomous | `/seed` |
| Champion 已确立但用户未启动 loop | `/loop start` |
| Loop 运行中 | （NBA 隐藏，显示进度） |
| Loop 完成且预算未耗尽 | `/loop start` 或 `/export bundle` |
| 一切就绪、无后续 | `/export bundle` |

实现位置：

- `opencode/packages/opencode/src/cli/cmd/tui/routes/research-cockpit-data.ts`
- `selectNextBestAction(input) → ResearchCockpitNbaAction | null`

当前优先级实现要点：

1. 无 task → `/new csv`
2. queued/running run → 隐藏 NBA
3. pending approval → `/candidate approve`
4. runner dataset repair → `/dataset prepare`
5. runner 其他问题 → `/runner check`
6. intent 未确认 → 无 NBA，保留 Socratic/Companion 追问
7. 无 profile → `/dataset profile`
8. 无 candidates → `/seed`
9. autonomous task → `/loop start`
10. 可运行 candidate → `/run smoke`
11. 成功 run 但无 final bundle → `/export bundle`

---

## 六、对话路由：意图到 Action 的契约

LLM 可以输出符合下面 schema 的结构化结果，驾驶舱据此渲染 Action chip。当前 cockpit 已经实现解析与确认；上游 `intent-agent` prompt/schema 的系统化约束仍是后续增强项。

```ts
type AgentReply =
  | { kind: "chat"; text: string }
  | { kind: "intent"; slots: IntentSlots; followups: string[] }
  | {
      kind: "action_proposal"
      title: string                     // "为 METR-LA 准备数据集"
      command: string                   // "/dataset prepare"
      reason: string                    // "数据集指纹不匹配"
      reversible: boolean
      requireConfirm: boolean           // 默认 true
    }
```

`requireConfirm=true` 时驾驶舱渲染：

```
🤖 我建议执行：/dataset prepare
   原因：当前 task 的 dataset_spec 与已准备的不匹配
   [Enter 执行]   [Esc 取消]   [/why 详细说明]
```

如此实现"对话即控制"——用户不需要去找按钮，LLM 主动把动作端到嘴边。

当前实现细节：

- 支持裸 JSON 或 fenced JSON（```json ... ```）。
- `command` 必须以 `/` 开头，否则不会被当作可执行 proposal。
- `Enter`：输入框为空时，优先确认当前 proposal；没有 proposal 时执行 NBA。
- `Esc`：取消当前 proposal 或中断当前 active operation。
- 持久化到对话流时不展示原始 JSON，而记录为 `action-proposal: accepted <command>: <reason>`。

---

## 七、迁移与兼容

### 7.1 旧斜杠命令保留为别名（≥ 1 个 minor 版本）

```ts
// 旧 → 新
"prepare-dataset"   → "/dataset prepare"
"agent-loop"        → "/loop start"
"task-next"         → "/task next"
"review-csv"        → "/new csv --mode review"
...
```

当前实现：旧斜杠命令通过 `aliases` 和 `runSlashPrompt(...)` 转发到新命令语义；自动补全面板主要展示新根命令，避免继续强化旧入口。

后续可选：为旧 slash 命令增加一次性 UI 迁移角标或埋点统计。

### 7.2 旧快捷键

被删除的快捷键（如 `Ctrl+N`）首次按下时，**不执行**而是显示提示：

```
ⓘ Ctrl+N 已移除。请使用 /new csv 或在对话中说"新建一个 CSV 任务"。
```

按一次提示，第二次直接静默——避免用户被反复打断。

### 7.3 新用户引导

首次进入 cockpit 时插入一段欢迎气泡：

```
👋 欢迎来到 NeoResearch。
   本系统主要通过对话使用——直接告诉我你想做什么即可。
   常用斜杠命令：/new csv、/dataset prepare、/loop start、/help。
   只有 5 个快捷键：Enter、Esc、Ctrl+J/K、Ctrl+L、Ctrl+C。
```

存进 `~/.local/share/neo-research/onboarded.json`，只展示一次。

---

## 八、分阶段实施

### Phase 1：清理与折叠

状态：**已完成核心项**

- 已把 `/review*`、`/task*`、`/csv*` 等新建任务入口收敛到 `/new`。
- 已更新 `research-cockpit.tsx` 的 `command.register(...)` 列表，隐藏旧命令面板项，仅保留兼容 value/alias。
- 已更新 `research-cockpit-render.test.tsx` 和 slash menu 相关测试。
- 说明：`Ctrl+J` / `Ctrl+K` 仍通过 command keybind 注册保留；其他旧快捷键改为迁移提示。

### Phase 2：Next Best Action 引擎

状态：**已完成**

- 已新增 `selectNextBestAction(input) → ResearchCockpitNbaAction | null`。
- 已在驾驶舱 prompt 上方渲染 NBA 卡片。
- 已实现空输入 `Enter` 执行当前 proposal 或 NBA。
- 已增加单测覆盖优先级与 active run 隐藏逻辑。

### Phase 3：对话嵌入 Run Output

状态：**部分完成**

- 已完成：stream 输出、run summary、failure reason 进入 conversation pane。
- 待完成：独立可折叠 Run Block、完整 stdout 展开、节流合并策略。
- 设计调整：`Tab` 当前用于 stage agent 切换，Run Block 展开需要另选焦点规则或快捷键。

### Phase 4：LLM Action Proposal

状态：**cockpit 端已完成，上游 intent-agent 待增强**

- 已完成：cockpit 解析 `action_proposal` JSON，渲染确认气泡。
- 已完成：mock LLM 返回 proposal → 用户 `Enter` → slash action 触发的渲染测试。
- 待完成：把 `action_proposal` schema 明确接入 `intent-agent` 输出契约与提示词。

### Phase 5：迁移提示与文档

状态：**迁移提示与 onboarding 已完成，文档持续更新**

- 已完成：旧快捷键首次按下显示迁移提示。
- 已完成：首次进入 cockpit 的欢迎气泡。
- 已完成：`~/.local/share/neo-research/onboarded.json` 持久化。
- 本文档已更新为当前落地状态。
- 待完成：`NeoResearch使用指南.md` 和 README 的用户向 walkthrough 可继续补充。

### 当前改动文件

- `opencode/packages/opencode/src/cli/cmd/tui/routes/research-cockpit-data.ts`
- `opencode/packages/opencode/src/cli/cmd/tui/routes/research-cockpit.tsx`
- `opencode/packages/opencode/src/cli/cmd/tui/routes/research-slash-menu.tsx`
- `opencode/packages/opencode/test/cli/tui/research-cockpit-data.test.ts`
- `opencode/packages/opencode/test/cli/tui/research-cockpit-render.test.tsx`

---

## 九、风险与权衡

| 风险 | 缓解 |
|---|---|
| 旧用户依赖现有快捷键 | Phase 5 的提示 + 别名兼容期 ≥ 1 个 minor |
| LLM 不可用时对话路由失效 | 保留斜杠命令作为完整后备；NBA 由本地状态机驱动，不依赖 LLM |
| Run 输出嵌入对话可能拖慢渲染 | 当前只保留 bounded runner output buffer；后续 Run Block 默认折叠 + 节流 |
| Action proposal 误判执行错动作 | 当前严格走用户 `Enter` 确认；只读免确认暂不默认开放 |
| NBA 永远只推一条会让用户感觉受限 | 对话区始终能直接打 `/<other-cmd>`；NBA 是"提示"不是"约束" |

---

## 十、成功指标

改造完成后，下面三项是验证 UX 是否真的变好的硬指标。当前代码层验证已经通过，产品指标仍需真实使用数据：

1. **完成一次完整实验所需的"按按钮/快捷键"次数 ≤ 5**（改造前 ≥ 12）
2. **用户首次进入 cockpit 到发起第一个 Run 的中位时间 ≤ 3 分钟**
3. **30 天内被使用过的旧快捷键数 ≤ 2**（说明用户已迁移到对话/斜杠）

### 10.1 当前工程验收

| 验收项 | 状态 |
|---|---|
| `selectNextBestAction` 单测 | 通过 |
| Cockpit slash command 渲染测试 | 通过 |
| 空输入 `Enter` 执行 NBA | 通过 |
| `action_proposal` 确认执行测试 | 通过 |
| onboarding 一次性展示测试 | 通过 |
| `bun typecheck` | 通过 |
| `bun test` | 通过（`2530 pass, 0 fail`） |

---

## 十一、一句话总结

> **把驾驶舱从"按钮森林"改造为"研究伙伴"**：
> 一个对话框、一个 Next Best Action、一组正交的斜杠命令——
> 让用户告诉系统"我想做什么"，而不是去研究"该按哪里"。
