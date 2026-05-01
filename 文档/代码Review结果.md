# NeoResearch 代码 Review 综合报告

> 审查范围：`neo_cast/` + `opencode/packages/opencode/`
> 审查日期：2026-05-01

## 总体评价

两个子系统的架构思路清晰，分层合理：`neo_cast` 的 NDJSON 事件协议 + 双层校验（JSON Schema + semantic registry）+ heuristic fallback 链是系统最优雅的部分；`opencode` 的 Effect pipeline 可读性高，发布边界测试机制完善。主要问题集中在**边界条件处理、Effect 错误通道滥用、少量硬编码逻辑破坏了设计不变量**。

---

## 一、neo_cast 子系统

### Critical

#### C1. `runner.py` — `skip_smoke=True` 分支 `_candidate_context()` 调用时序错误

`py/runner.py:347–395` — `skip_smoke=True` 时只调用了 renderer，但 `_candidate_context()` 在第 395 行（训练后）才执行，若 resolved 文件缺失，记录到 TSV 的元信息会出错。应在 renderer 成功后立即调用。

#### C2. `runner-manifest.json` 参数与 `runner.py` 内部硬编码路径存在双重来源

manifest 声明了 `--candidate-path` 等占位参数，但 `runner.py` 内部直接使用全局常量，opencode 层若严格展开 manifest 参数会产生路径歧义。

#### C3. `session.js:29` — `getBestSessionRow` 用 `.find()` 从头查，返回可能是旧的 `is_best=1`

```js
// 当前（错误）
return rows.find((row) => row.is_best === "1") || null;

// 应改为
return [...rows].reverse().find(row => row.is_best === "1") || null;
```

`runner.py` 的 `clear_best_for_session` 会把旧 `is_best=1` 重置为 `0` 再追加新的 `is_best=1`，新的最佳行在文件末尾，`.find()` 会错误地返回历史最佳行。

---

### Major

| # | 位置 | 问题 |
|---|------|------|
| M1 | `py/runner.py:235` | 浮点解析失败时填 `0.0` 而非 `continue`，污染 training_curves.json，干扰 TUI 曲线绘制 |
| M2 | `py/search/mutate.py:170` | `_switch_to_raw_backbone` 不重置 `fusion.channel_mode`，产生未经验证的 `embedding=none + channel_mode=shared` 组合 |
| M3 | `py/renderer.py:133` | resolved 文件写磁盘失败时仍打印 `done:success`，缺乏 try/except 保护，上层误认为 smoke 成功 |
| M4 | `src/python-bridge.js:237` | 两处空 catch 块静默掩盖文件读取失败，下游 TUI 训练曲线静默出空 |
| M5 | `src/llm.js:42` | heuristic fallback 某些路径下 `n_freq` 未覆盖，特定组合过不了 validate 的 `required_fields`，浪费 smoke 时间 |

---

### Minor

| # | 位置 | 问题 |
|---|------|------|
| m1 | `src/cli.js:166` / `src/loop.js:59` | `describeCandidateId` / `describeCandidateFamily` 重复实现两份，应提取到 `src/candidate-utils.js` |
| m2 | `py/runner.py:189` / `py/validate.py:95` | `assert proc.stdout is not None` 应改为显式 `if proc.stdout is None: raise RuntimeError(...)`，避免被 `python -O` 关闭 |
| m3 | `src/config.js:11` | 默认 model `"claude-sonnet-4"` 与 `llm.js` 的 fallback `"claude-sonnet-4-6"` 不一致，`config show` 展示与实际行为脱节 |
| m4 | `src/session.js:11` | `loadRunnerState` 无 try/catch，文件损坏会抛未捕获异常；`python-bridge.js` 的 `readRunnerState` 有保护但此处没有 |
| m5 | `py/registry/action_specs.py:178` | `preprocessing_types in (["none"],)` 应改为 `preprocessing_types == ["none"]`，语义更清晰，与前面 set 检查风格统一 |
| m6 | `runner-manifest.json` | `run` / `ref_test` / `blind_test` 命令缺少 `timeout_ms` 字段，opencode 侧需硬编码超时，不如集中在 manifest 维护 |

---

### 亮点

1. **NDJSON 事件协议**（`emit()` + `_run_and_capture`）：subprocess stdout 全量用 NDJSON 传递，父进程即时转发并解析，是整套系统最优雅的设计决策。
2. **recipe_schema + action_specs 双层验证**：JSON Schema 处理结构和类型，`validate_recipe_against_registry` 处理跨字段语义约束（`d_model % n_heads == 0` 等），职责划分清晰，两层分别有测试覆盖。
3. **`runPythonCommand` 的信号处理**：SIGTERM → 等 2s → SIGKILL 两阶段终止，配合 `AbortSignal` 监听和 `settled` 标志防双重 resolve，是相对完整的 subprocess 生命周期管理。
4. **heuristic fallback 降级链**：LLM 失败时回退到 heuristic，任何 attempt 都不阻断实验循环，`source` 字段完整追溯来源，适合 CI/offline 场景。
5. **`RunnerState` 的向后兼容 backfill**：`session_started_at` / `no_improve_streak` 等字段有 backfill 逻辑并有对应测试（`test_load_state_backfills_autonomous_fields_for_legacy_state`），体现良好版本意识。

---

## 二、opencode 子系统

### Critical

#### C1. `service.ts:765` — `metricDominates` 条件冗余，逻辑意图模糊

```typescript
// 当前（a <= b && a < b 等价于 a < b，冗余条件隐藏意图）
return direction === "minimize"
  ? left.metricMean <= right.metricMean && left.metricMean < right.metricMean
  : left.metricMean >= right.metricMean && left.metricMean > right.metricMean

// 应改为
return direction === "minimize"
  ? left.metricMean < right.metricMean
  : left.metricMean > right.metricMean
```

虽然两种写法结果一致，但冗余条件会使维护者误读为"dominates 要求不等加严格不等"，将来引入第三个条件时极可能被错误模仿，**建议立即修正**。

---

### Major

| # | 位置 | 问题 |
|---|------|------|
| M1 | `service.ts:178` | `db` helper 用 `Effect.sync` 包裹 DB 调用——DB 抛出时异常逃逸 Effect 错误通道导致运行时崩溃，应改为 `Effect.trySync` 统一封装到错误通道 |
| M2 | `research-cockpit.tsx:667` + `research-slash-menu.tsx:12` | `/doctor`、`/api-key` 在 `slashPriority` 中声明，但 cockpit `runSlashPrompt` 无对应 handler，用户输入后得到 "Unknown command" toast，体验断裂 |
| M3 | `research-cockpit.tsx:808` | `createTaskFromPrompt` 与 `actionQueue` 存在竞态，`routedGoalHandled` 检查不在队列内，`researchGoal` 快速变化时可能重复提交 |
| M4 | `llm-proposal.ts:336–340` | `riskLevel: "low"` 和 `approvalStatus: "auto_approved"` 硬编码，绕过 DomainRegistry 风险评估，所有 LLM 方案在自主模式下直接跳过人工审核 |

---

### Minor

| # | 位置 | 问题 |
|---|------|------|
| m1 | `research-slash-menu.tsx:28–29` | `selectedSlashIndexes` / `selectionRevision` 是模块级单例，测试用例间状态互污，应移入组件 context 或在 `afterEach` 中重置 |
| m2 | `prepublish-check.ts:47` | 新增的 `research-slash-menu.test.tsx` 未加入发布门控命令，`release-boundary.test.ts` 不会发现，slash menu TUI 渲染测试游离于发布检查之外 |
| m3 | `service.ts:1344` | insert 后 `.get()` 无 null 检查，`mapTask(undefined)` 会产生含 undefined 字段的实体而非明确错误，应补充 `if (!row) throw ...` |
| m4 | `research-cockpit.tsx:635–656` | 用 `recommendation().title` 字符串做路由决策，措辞改动会静默破坏路由；建议引入 discriminated union（如 `action: "profile" \| "seed" \| ...`） |

---

### 亮点

1. **`schema.ts` 双套校验**：每个类型同时支持 Effect Schema + Zod，`JsonRecord` 的 `ZodOverride` 注解优雅解决了两者的阻抗差异，类型系统完整一致。
2. **Service 层 Effect pipeline**：`Effect.fn("name")(function* ...)` 命名模式使 tracing 自然，`bus.publish` 事件总线调用集中，`missing()` helper 统一 not-found 路径。
3. **`llm-proposal.ts` 配置解析**：四层优先级覆盖链（default → env → user config → workspace → runner）+ `normalizeConfig` 的类型检查和范围 clamp + markdown code fence 去除，生产级鲁棒性完善。
4. **`research-slash-menu.tsx` 的窗口化分页**：`slashWindowSize`、`windowStart` 计算、`windowLabel` 显示以及 Ctrl+N/P 快捷键支持完整，测试覆盖了窗口移动边界情况。
5. **`release-boundary.test.ts`**：对 package.json 字段、CLI 命令注册、bin 包装、README sections、publish 脚本、GitHub workflow 全链路做字符串级验证，有效防止发布配置漂移。
6. **实验分析层次清晰**：`analyzeExperimentResults` → `summarizeCandidateMetrics` → `addUtilityScores` → `paretoDominates` 各层职责分明，多 seed 方差、CI95、utility penalty 函数设计有理论依据。

---

## 优先处理建议

| 优先级 | 子系统 | 位置 | 动作 |
|--------|--------|------|------|
| P0 | opencode | `service.ts:765` | 修复 `metricDominates` 冗余条件 |
| P0 | neo_cast | `session.js:29` | `.find()` 改为 `[...rows].reverse().find()` |
| P1 | opencode | `service.ts:178` | `Effect.sync` → `Effect.trySync` 包裹 DB 调用 |
| P1 | opencode | `llm-proposal.ts:336` | 移除硬编码 `riskLevel/approvalStatus`，由 domain validation 推断 |
| P1 | opencode | `prepublish-check.ts:47` | 将 `research-slash-menu.test.tsx` 加入发布门控命令 |
| P1 | neo_cast | `py/renderer.py:133` | try/except 包裹文件写入，控制 `done:success` 发出时序 |
| P1 | neo_cast | `py/runner.py:347` | `skip_smoke` 分支提前调用 `_candidate_context()` |
| P2 | opencode | `research-cockpit.tsx:635` | 用 action 枚举替换 `recommendation().title` 字符串路由 |
| P2 | opencode | `research-slash-menu.tsx:28` | 模块级单例状态移入组件 context |
| P2 | neo_cast | `src/config.js:11` | 统一默认 model 为 `"claude-sonnet-4-6"` |
| P3 | neo_cast | `py/runner.py:189` | `assert` 改为显式 `raise RuntimeError` |
| P3 | neo_cast | `src/session.js:11` | `loadRunnerState` 补充 try/catch |
| P3 | opencode | `service.ts:1344` | insert 后 `.get()` 补充 null 检查 |
| P3 | opencode | `cockpit.tsx` + `slash-menu.tsx` | `/doctor`、`/api-key` 在 cockpit 内做 fallthrough 至 home 路由 |
