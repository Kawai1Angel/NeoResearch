# NeoResearch TUI 可用性缺口分析 v2

> 日期：2026-05-01
> 基线：上一版 `tui_interaction_gaps.md`（2026-04-29）以及实测截图
> 范围：仅评估 TUI 距离"普通用户能跑通完整研究流程"的缺口

---

## 一、上一版缺口的当前状态

| 编号 | 上一版描述 | 当前状态 |
|------|-----------|---------|
| G1 / G2 | Home 页 Auto Mode / hint 文字 | ✅ 已修（home.tsx:333 显示 `ctrl+p api-key / cockpit / csv / doctor`） |
| G6 | Configure API Key 永远显示 | ✅ 已修（home.tsx:70 按 `needsApiKey()` 条件显示） |
| G8 | cockpit 无返回 home 路径 | ✅ 已修（菜单栏 `Home ^H` + ctrl+h keybind） |
| G9 | 多任务无切换 | ⚠️ 部分修（Previous/Next Task ^K/^J 已加，但**仍没有任务列表 UI**） |
| G10 / G11 / G12 | Ref/Blind exec、Gate、Seed Sweep | ⚠️ 部分修（命令面板已注册，但**候选行没有按钮**） |
| G15 | Champion 不显示 | ✅ 已修（cockpit.tsx:1591 Champion 区块） |
| G16 | runnerRoot 缺失无修复路径 | ✅ 已修（"Use Project Runner" 按钮 + `useProjectRunnerRoot` 命令） |
| G19 | LSP 占位区块 | 待验证（grep 未命中） |
| G20 | New CSV Task 默认 review 模式 | ✅ 已修（cockpit.tsx:1391 改成 `autonomous`） |
| G3 / G4 / G5 | esc interrupt / tab agents / tab tasks 死提示 | 待验证 |

**结论**：约 60% 的旧缺口已闭环，剩下的**最严重问题是主内容区的信息密度严重不足**。

---

## 二、当前最严重的缺口（按用户阻断度排序）

### B1 (Critical) — 主内容区信息密度极低，用户"看不见自己在做什么"

**现象**（来自实测截图）：
- 主内容区（占据 60%+ 屏宽）只渲染了 1 行：`rrun_de0787...smoke failed / –`
- 9 个 task、3 个 candidate、4 个 artifact、1 条 memory 全部退化为右侧 42 列侧栏的**纯数字计数**
- 用户无法看到：每个 candidate 是什么模型、metric 是多少、哪些 run 历史、artifact 是什么、memory 内容

**代码定位**：
- `research-cockpit.tsx:1420-1428` — 主内容区只 render `streamLines()`
- `streamLines` 在 `!hasConversation && run` 分支只 push 一行 `${run.id} ${run.stage} ${run.status} / ${metric}`（cockpit.tsx:1316）
- `taskArtifacts`、`candidates()`、`memory()` 都被 fetch 了但**从未在主区渲染**（cockpit.tsx:299-310）

**影响**：用户无法对当前研究状态做任何判断，必须靠 `cat .neo-cast/results.tsv` 或读 SQLite 才知道实际情况。这是当前 TUI 距"可用"差距最大的一块。

**修复方向**：
- 主区上方加 **Candidate Table**（候选 ID / family / approval status / smoke metric / run count）
- 主区中段加 **Run History**（最近 N 个 run，stage、status、metric、duration）
- 主区下段才是当前 streamLines（事件流）

---

### B2 (Critical) — Smoke 失败时没有可见错误原因

**现象**：截图里 `rrun_... smoke failed / –` 但**没有任何 stderr / 错误堆栈 / Python 输出**展示。

**代码定位**：
- `runAction()` 的 `catch` 分支把错误推到 `errorEvents`（cockpit.tsx:381-385），但这只是 REST 调用本身的错误
- 真正的训练失败原因来自 Python subprocess 的 stderr，被吞在 `.neo-cast/artifacts/<run-id>/run.log` 里
- 服务端 `research/runners/neo-cast-runner.ts` 收集了 NDJSON event，但 `error` event 没有暴露到 cockpit 视图

**影响**：用户面对 smoke failed 完全不知道是 Python 没装、CSV 路径错、还是 recipe 不合法，**这是 onboarding 阶段最常踩的坑**。

**修复方向**：
- run record 里加一个 `lastErrorMessage` / `failureReason` 字段（来自 Python NDJSON 的 `done:error` 事件 detail）
- cockpit 在 `latestRun().status === "failed"` 时把这段错误展开显示

---

### B3 (Major) — Progress checklist 步骤依赖丢失，状态混乱

**现象**：截图里 `[o] Profile dataset`（in-progress）和 `[o] Run smoke experiments`（in-progress）**同时**为 active，但逻辑上 profile 必须先于 smoke 完成。

**代码定位**：`research-cockpit-data.ts:248`
```typescript
status: hasSucceededRun ? "done" : hasCandidates && runnerReady ? "active" : "todo"
```
缺少 `hasProfile &&` 前置依赖。

**修复**：在条件里加 `hasProfile &&`，这样 profile 没完成时 smoke 显示为 `todo` 而非 `active`。已在前一次 review 报告 P0 项里。

---

### B4 (Major) — 候选行没有任何操作按钮

**现象**：candidate 数据从未渲染成可交互列表，操作只能走 `ctrl+p` 命令面板。

**代码定位**：
- `prepareCandidate` / `executeCandidate` / `requestRefTestGate` / `executeCandidateSeedSweep` 都已实现（cockpit.tsx:618-672）
- 命令面板已注册（cockpit.tsx:1242-1290）
- **但主区没有 `<For each={candidates()}>` 渲染**，更别说每行 candidate 旁边的按钮

**影响**：上一版 G10/G11/G12 只闭环了一半 — 命令存在，UI 入口缺失。新手不知道命令名字，等于功能不存在。

**修复**：在主区加 candidate 列表，每行附 `Smoke / Ref Prep / Ref Exec / Blind Prep / Blind Exec / Seed Sweep` 按钮组。

---

### B5 (Major) — `runnerReady()` 检查太弱，给出虚假绿灯

**现象**：截图右侧栏底部显示 `NeoResearch alpha`（success 颜色，意味 `runnerReady() === true`），但 smoke 实际失败。

**代码定位**：`research-cockpit-data.ts:569-573`
```typescript
return typeof root === "string" && root.trim().length > 0
```
只判断 `neoCastProjectRoot` 是不是非空字符串，**不检查**：
1. 该路径下的 Python venv 是否真的存在（`neo-cast init-runtime` 跑过没）
2. `doctor` 是否通过
3. `prepare_tsf.py` 准备好的数据集是否存在

**影响**：用户被误导以为环境就绪，触发 smoke 后失败再来排查环境。

**修复方向**：
- 服务端加 `/research/runner/health` 端点跑实时 doctor 检查
- cockpit 启动时 fetch 一次，把"绿灯"绑到真实健康状态而非配置存在性

---

### B6 (Major) — 主内容区无任务列表 / 无候选列表 / 无 run 历史

合并 B1 的展开。当前从主区**完全无法**看到：

| 数据 | fetch 了？ | 渲染了？ |
|------|-----------|---------|
| `tasks()` (9 个) | ✅ | ❌ 只有 Previous/Next 切换 + `Task 1/9` 计数 |
| `candidates()` (3 个) | ✅ | ❌ 只有 `Candidate 1/3` 计数 |
| `runs()` (含 smoke 失败) | ✅ | ❌ 只显示 `latestRun()` 一行 |
| `artifacts()` (4 个) | ✅ | ❌ 只有 `Artifacts 4` 数字 |
| `memory()` (1 条) | ✅ | ❌ 只有 `Memory 1` 数字 |
| `approvals()` | ✅ | ❌ 只有 `Approvals 0` 数字 + pending toast |

每个数据 resource 都已经做了 `createResource` 拉取并 build 进 `stats()`，但没有任何 `<For each>` 把它们展开。

---

### B7 (Major) — 长任务（autonomous loop）无进度反馈

**现象**：`busy()` 触发后只是按钮变灰，主区显示 `Running create-autonomous...` 一行（cockpit.tsx:1339）。autonomous loop 可能跑数分钟，期间用户无法判断是否在工作。

**修复方向**：
- `busy()` 时在 header 区加 spinner + 已耗时（接 `Date.now()` 起算）
- 服务端 LLM 调用 / Python 训练阶段事件流式 push 到 cockpit
- 至少把 `actionEvents` 的最后一条做成 sticky 顶部状态条

---

### B8 (Major) — 错误历史只保留最近 2 条且静默清空

**代码定位**：`cockpit.tsx:1574` `errorEvents().slice(-2)` + `cockpit.tsx:271` `setError(undefined)` 每次新动作清空当前 error。

**影响**：调试链路断裂。多次失败后用户只看到最后两条，没法回溯。

**修复方向**：errorEvents 增加 ring buffer（保留最近 20 条）+ 主区下方加可滚动 Error Log 子区。

---

## 三、Onboarding 阶段的"第一次失败"路径

模拟新手第一次跑：

1. ✅ `npx neo-research` 启动 → Home 页正常显示
2. ✅ `ctrl+p` → cockpit / api-key / csv 都走得通
3. ⚠️ 输入 csv 路径 → 立即创建 task（**不验证路径是否存在**，B5）
4. ⚠️ 顶栏 `Seed Baselines ^B` 一键播种 3 个 candidate（**不展示候选内容**，B6）
5. ❌ `Agent Loop ^L` → smoke failed → `rrun_... smoke failed / –`（**不知道为什么失败**，B2）
6. ❌ 用户尝试再次触发 → 还是 fail，无任何新信息 → 放弃

**结论**：当前 TUI 在 step 5 阻断了所有新手。这个阻断的根因是 B2 + B5 的组合。

---

## 四、缺口优先级与修复成本

| 编号 | 类别 | 阻断度 | 修复成本 |
|------|------|--------|---------|
| **B2** | smoke 失败原因不可见 | Critical | 中（需要 runner 链路传 stderr） |
| **B5** | runnerReady 假阳性 | Critical | 中（需 `/health` 端点） |
| **B1 / B6** | 主区不渲染列表 | Critical | 中-大（需要重新设计主区布局） |
| **B3** | progress checklist 依赖错乱 | Major | 小（一行条件） |
| **B4** | 候选行无按钮 | Major | 小（候选列表落地后顺带加） |
| **B7** | 长任务无进度反馈 | Major | 中（spinner + 计时） |
| **B8** | 错误历史只 2 条 | Minor | 小 |
| 旧 G3 / G4 / G5 | 死提示 | Minor | 小 |

---

## 五、最小可发布的 TUI（MVP）需要补的功能集

按"第一次完整跑通一个 ETTh1 任务"的最小集：

1. **B2 修复** — smoke fail 时主区显示 Python stderr 最后 N 行
2. **B5 修复** — `runnerReady()` 改成真实健康检查（venv 是否存在 + doctor 是否绿灯）
3. **主区 candidate 列表** — `<For each={candidates()}>`，每行：`{id} {family} {status} smoke=metric ref=metric`
4. **主区 run history** — 最近 5 个 run，能看到 stage 切换链 `profile → smoke → ref_test`
5. **B3 修复** — progress checklist 加 hasProfile 依赖
6. **busy 进度提示** — 至少在主区顶部 sticky 显示当前 action + 已耗时

一次 PR 应该能闭环 5/6 项，B5 单独走（涉及服务端）。

---

## 六、长期路线（不阻断 MVP）

- **Task list 主区面板** — 9 个 task 用列表展示，可键盘选择 + 删除
- **Artifact preview** — 点击 artifact 用 `less` 弹窗 / 或主区面板预览前 N 行
- **Memory 内容浏览** — 当前只显示数量，应该至少弹个 `ctrl+p` → "View memory entries"
- **Multi-task parallel run dashboard** — 同时多个 task 跑时的总览面板
- **Telemetry overlay** — 按 `ctrl+t` 显示 LLM token / 时间 / cost 累计

---

## 七、与代码 Review v1 (`代码Review结果.md`) 的关系

本文档关注**用户视角的功能缺口**，与代码 Review v1 关注的**实现层面 bug** 互补：

| 关注点 | v1 (Review) | 本文档 (Gap) |
|--------|------------|-------------|
| 范围 | 代码正确性、Effect 错误处理、发布边界 | 用户能否跑通完整流程 |
| 粒度 | 文件:行号 | 用户体验路径 |
| 优先级标准 | bug 严重性 | 阻断 MVP 程度 |

两者结合后，下一阶段的 PR 应同时覆盖：v1 的 P0/P1（C1、M1-M4）+ 本文档的 B2/B3/B5/B6。
