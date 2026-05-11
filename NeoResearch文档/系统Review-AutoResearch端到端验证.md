# NeoResearch 系统 Review：AutoResearch 端到端跑通的剩余缺口

> 范围：v0.1.0-alpha · commit `531ff23` 时点
> 目标：用一个 TSF 小模型（ETTh1 / 小参数量 transformer-class）真正跑完 autonomous loop，输出可信 champion + reproducible bundle
> 撰写：Claude（Opus 4.7）· 受 Mingyue 委托
> 日期：2026-05-09
> R 类修复：Codex · 2026-05-10
> C 类修复：Codex · 2026-05-10
> 上一次 Review 已闭环：P0×4 / P1×8 / P2×9（参见 `系统Review-跑通AutonomousResearch的差距.md`）

---

## 0. TL;DR

| 类别 | 数量 | 说明 |
|---|---:|---|
| **B 阻塞 UI 跑通** | 3 | ✅ 全部已修复（2026-05-09）；249/249 alpha-check 测试通过 |
| **R 阻塞首次跑通** | 0 | ✅ 已修复（2026-05-10）：LLM key 缺失降级为 warn + mock fallback；A-4 e2e 自动回归已落地 |
| **C 影响结果可信** | 0 | ✅ 已修复（2026-05-10）：champion 增加长 horizon standoff、reflection memory 加权与 forbidden signatures、loop exploration 策略、cockpit repro seal |
| **D 架构演进** | 4 | 双状态源、DomainRegistry 单域、GPU 池、experiment lineage |

> **当前状态**：B / R / C 类已闭环。alpha 主路径已经覆盖无 key mock fallback、2 轮 e2e autonomous loop、可信 champion 选择保护、reflection 记忆约束、探索调节与 cockpit 复现 seal；剩余主要是 D 类长期架构演进。

---

## 1. B 类：UI 阻塞跑通（✅ 已修复）

> 三个 bug 在 2026-05-09 修复，alpha-check 249/249 通过，typecheck clean。

### B-1. ✅ `streamLines` 头部 hardcoded line 把动态内容压扁
**位置**：`opencode/packages/opencode/src/cli/cmd/tui/routes/research-cockpit.tsx:2911-3094`

**现象**：cockpit 左侧对话框只显示固定 2 行 header + 1 行 run summary，中间大片空白。点击各个按钮 / 斜杠命令后没有"操作回执"流入。

**根因**：
1. `streamLines` 始终先 push 一条 `Research Agent: 当前研究 ... / candidate X/Y / latest run status` 占位信息。
2. 旧版按钮被 UX 改造移除后（参见 `UX改造方案-对话优先.md`），动作回执的注入路径残缺：`actionEvents` 信号在 `appendCockpitNotice` / `appendActionEvent` 之外极少被调用，多数 slash 命令直接通过 REST 走，结果 silently 写入 DB 但不在 UI 显示。
3. `runner_progress_jsonl` artifact 的 `previewLines` replay（P2-9 修复）只在 run 结束后回放，不在按下按钮的瞬间反馈。

**已落地修复**：
- 顶栏 `/new /dataset /run /loop /export /help` 改成 `cockpitColors.primary` 颜色（与 Home 一致），并绑定 `onMouseUp` 调用新增的 `insertSlashPrefix(prefix)` 把斜杠命令预填到 textarea 并 focus。用户点击瞬间就能看到命令出现在输入栏，再按 Enter 即触发——避免"点了但没反应"的黑盒感。
- `streamLines` 的 idle 占位文案补一行 actionable 提示："点击顶栏 /loop 启动自主搜索，或 /run baseline 跑一个手动候选"。任务未选时同理提示 `/new` 与 `/help`。
- `runAction` 的 success/error 路径已经在写 `actionEvents`（line 1360 / 1375），不需要再加；本次只清理了"按钮点不动"的入口问题。

---

### B-2. ✅ Context 侧栏 token 计数永远空
**位置**：`research-cockpit.tsx:3132-3149`（`contextWindowLine` / `sessionTokenLines`）+ `:916`（`chatUsageByMessage`）

**现象**：右侧 Context 区显示 `model GLM-5.1 / session rtsk_e06 / task rtsk_e06 researching` 但**永远没有**`tokens in=... out=... cache=...` 行。

**根因**：`chatUsageByMessage` 仅在 `streamingChat` 模式下被 `recordChatUsage(info)` 写入。但用户从按钮 / 斜杠命令走的 API 路径（`researchRequest` → `executeAction`）调用 LLM 时，token usage 写在 server-side message metadata 里，**没回流到 cockpit 的 signal**。

**已落地修复（轻量）**：
- `contextWindowLine` 改为：当 `latestChatUsage()` 为空但 `chatMetadata().modelLimit` 已就绪时，显示 `— / <limit> (chat-only)`，让用户至少看到模型上下文上限和数据来源限制。
- 长期方案（仍待做）：把 server side 的 LLM usage 通过 response 回传到 cockpit，并在 `enqueueAction` 完成后 `recordChatUsage()`，使 action API 调用也能贡献 token 计数。当前修复属于过渡——保证 Context 区不再永久空白。

---

### B-3. ✅ AutoResearch 进度立即全部 ✓（不真实跳跃）
**位置**：`research-cockpit-data.ts:294-361`（`buildResearchCockpitAgentWorkflow`）

**现象**：刚进入 cockpit、还没启动 loop，AutoResearch 工作流 7 个 stage 全部显示 ✓ "done"。

**根因**：
```ts
const trainEvalDone = hasTrainEvalEvidence(input) || Boolean(input.champion)
const hasHypothesisPlan =
  ... ||
  (hasProfile && (hasCandidates || hasCompletedCompilerRun(input) || hasTrainEvalEvidence(input) || Boolean(input.champion)))
const hasCompilerEvidence = ... || Boolean(input.champion)
```

只要 DB 里曾经存在 champion / candidate / completed run（哪怕来自上一次 session），所有 stage 都立即变 done。
`research_champion` 表是任务级历史快照，不应作为"本轮 loop 已完成"的判据。

**已落地修复**：
- `buildResearchCockpitAgentWorkflow` 中 `trainEvalDone`、`hasCompilerEvidence`、`hasHypothesisPlan` 三处都移除了 `|| Boolean(input.champion)` 后缀，stage 进度只来源于 per-run / per-artifact / per-candidate 证据。
- `reflectionActive` 同样去掉 `|| Boolean(input.champion)`，避免历史 champion 把 Reflection Agent 永久推到 active。
- 因此当一个新 task 只有 champion 但没有当前训练 run 时，prompt agent label 由 `automaticPromptAgentLabel` 的 `validChampion()` 短路命中，回到语义正确的 "Publish Agent"（而不是误显示为 Reflection Agent）。
- 已同步更新两条 render 测试用例：默认 fixture（含 smoke 成功 run + champion）的 active stage 由 Reflection Agent → TrainEval Agent；results 阶段的 prompt label 由 Reflection Agent → Publish Agent。

**回归**：`bun test test/cli/tui/research-cockpit-data.test.ts test/cli/tui/research-cockpit-render.test.tsx` → 121 pass。完整 alpha-check 8 文件 → 249 pass。typecheck clean。

---

## 2. R 类：阻塞 alpha 端到端跑通（✅ 已修复）

### R-1. ✅ LLM API key 未配置 / fallback 路径未充分宣传
原问题：`make doctor` 会直接 fail：
```
[FAIL] openai_compatible_api_key: OPENAI-compatible API key is not set.
```
但 `--mock-llm` 完全可用（heuristic candidate factory 仍能产 nlinear / dlinear / patch_mlp 候选），文档 / cockpit 没有明确告诉用户"没有 key 时打开 mock 模式"。

**修复结果（2026-05-10）**：
- `neo_cast/src/doctor.js`：`anthropic_api_key` / `openai_compatible_api_key` 缺失时降级为 `[WARN]`，`doctor` 总体不再因此失败，并提示 `--mock-llm` / `NEO_CAST_USE_MOCK=1`。
- `neo_cast/src/mock-mode.js`：新增统一 mock 开关，兼容 `--mock-llm`、`NEO_CAST_MOCK_LLM`、`NEO_CAST_USE_MOCK=1`。
- `neo_cast/src/cli.js`、`neo_cast/src/llm.js`、`neo_cast/src/reflect.js`：统一使用 mock 开关；`design` 在 mock 模式下跳过 LLM config validation blocking。
- `neo_cast/README.md`、`neo_cast/USAGE.md`、`neo-cast help`：补充 no API key mock fallback 说明。
- 注：TUI banner 仍可作为体验增强继续做，但已不再是 R 类端到端跑通阻塞项。

---

### R-2. ✅ A-4 e2e_autonomous_loop.test.ts 仍未落地（上一轮 sprint 残留）
原有 `bun test` 覆盖：单元 / domain registry / runner client / runtime / cockpit data。
**原未覆盖**：`/new task` → `/dataset prepare` → `/loop start` → 2 轮 mock LLM → champion 切换 → `/export bundle` 这条主路径。

**原修复方向（最小 e2e 草案）**：
```ts
// opencode/packages/opencode/test/research/e2e-autonomous-loop.test.ts
import { test, expect } from "bun:test"
import { ResearchService } from "@/research/service"

test("autonomous loop completes 2 mock rounds and selects champion", async () => {
  const svc = await spawnService({ mockLLM: true, fixtures: ["etth1_small"] })
  const task = await svc.createTask({ title: "ETTh1 mock", dataset: "etth1_small" })
  await svc.prepareDataset(task.id)
  await svc.startLoop(task.id, { maxRuns: 2, maxNoImprove: 5 })
  await svc.waitUntilLoopIdle(task.id, { timeoutMs: 60_000 })
  const champion = await svc.getChampion(task.id)
  expect(champion).toBeDefined()
  expect(champion.primaryMetric).toBeGreaterThan(0)
  const bundle = await svc.exportBundle(task.id)
  expect(bundle.manifest.reproducibility.gitSHA).toBeDefined()
}, 90_000)
```

**修复结果（2026-05-10）**：
- 新增 `opencode/packages/opencode/test/research/e2e-autonomous-loop.test.ts`。
- 覆盖路径：create autonomous TSF task → `prepareTaskDataset` → `runAutonomousLoop(maxIterations=2)` → champion 存在且 primary metric 有效 → `exportTaskArtifact(kind=research_final_bundle)` → manifest 含 model files 和 reproducibility seal。
- `opencode/packages/opencode/script/prepublish-check.ts` 纳入 `bun test test/research/e2e-autonomous-loop.test.ts --timeout 120000`。
- 根 `Makefile smoke` 同步执行该 e2e smoke。

**验证命令**：
```bash
cd neo_cast && node --test test/doctor.test.js test/design-loop.test.js
cd opencode/packages/opencode && bun test test/release-boundary.test.ts test/research/e2e-autonomous-loop.test.ts --timeout 120000
```

---

## 3. C 类：影响结果可信度（✅ 已修复）

### C-1. ✅ Champion 切换只看 `val_avg_mse`，缺多目标 Pareto
当前 `evaluateSucceededRun` 用 `taskSpec.objective.primaryMetric` 单值。但 TSF 任务自然是多 horizon × 多指标（MSE/MAE/MAPE × {96,192,336,720}），单值排序会让"短 horizon 强但长 horizon 崩"的候选错误获胜。

**修复结果（2026-05-10）**：
- `opencode/packages/opencode/src/research/service.ts`：champion 比较增加 secondary tie-breaker，默认 `val_avg_mse` → `val_h720_mse`，也支持 `objective.secondaryMetric` / `tieBreakerMetric` / `longHorizonMetric` 覆盖。
- 当 challenger 的 primary 更好但 `val_h720_mse` 相对当前 champion 退化时，不切 champion，并在 research memory 写入 `championStandoff`（含 challenger/champion primary、secondary、runID/candidateID）。
- 新增回归：`champion selection records a standoff when long-horizon metric regresses`。

**策略**：
- primary: `val_avg_mse`
- tie-breaker: `val_h720_mse`（长程稳定性）
- 当两者方向冲突时不切换，记 `championStandoff` memory event。

---

### C-2. ✅ Reflection 上下文仍以"最近 N 条"为主，缺时间衰减
`llm-proposal.ts` 已经按 outcome 分层（P1-7 修），但仍按时间近邻选样。当 loop 跑过 30+ 轮后，最古老的失败案例会从分层窗口里再次掉出去，可能复现"重蹈覆辙"。

**修复结果（2026-05-10）**：
- `opencode/packages/opencode/src/research/llm-proposal.ts`：representative memory 按 outcome 分层后再使用时间衰减权重排序，并把 `memoryWeight` 写入 LLM prompt，便于模型理解样本新旧。
- `failed` / `rejected` memory 中的 candidate spec 生成稳定 hash，注入 `forbidden_signatures`，prompt 指令明确 `do not repeat forbidden_signatures`。
- `opencode/packages/opencode/src/research/service.ts`：proposalContext memory 增加 `time`，使权重可按真实 memory 更新时间计算。
- 新增回归：`LLM proposal prompt weights memory by recency and exposes forbidden failed signatures`。

**策略**：
- 给每条 memory 加 `weight = 1 / (1 + age_minutes / 60)` 并加权采样。
- failed candidate 的 hash 加入 `forbidden_signatures` 集合，下一轮 prompt 显式列出 "do not repeat: ..."

---

### C-3. ✅ Autonomous loop 没有"探索/利用"调节
默认策略：每轮直接调 LLM 生成新 candidate（reflection on / off），没有 epsilon-greedy / Thompson sampling 之类的探索控制，长期容易陷在某个 backbone 家族不出来。

**修复结果（2026-05-10）**：
- `AutonomousLoopInput` / `RunFullPipelineInput` 增加 `explorationRate`，`AutonomousIterationInput` 增加 `forceExplore`。
- `runAutonomousLoop` 根据 `explorationRate` 计算探索间隔；例如 `explorationRate=0.3` 约每 3 轮强制 explore，`1` 表示每轮 explore。
- forced explore 会跳过现有 ready frontier exploitation，进入 domain proposal 路径，并向 fingerprint 写入 `explore_untried_backbone` bias；若 domain 无 proposal 才 fallback 到 ready frontier。
- REST 路由与 CLI 透传：`research loop <taskID> --exploration 0.3`、`research pipeline <taskID> --exploration 0.3`、`research iterate <taskID> --force-explore`。
- 新增回归：`autonomous loop forced exploration creates a new domain proposal instead of exploiting ready frontier`。

---

### C-4. ✅ Reproducibility seal 已写但 cockpit 未显示
P2-8 已修复 `run.resourceUsage.reproducibility = {gitSHA, lockHash, datasetSHA, preprocessSHA}`，但 cockpit / web dashboard / `/export bundle` 之外的页面**不展示**这个字段。用户若不打开 manifest.json 永远看不到。

**修复结果（2026-05-10）**：
- `opencode/packages/opencode/src/cli/cmd/tui/routes/research-cockpit.tsx`：右侧 Context 的 model 行显示当前 champion run 的复现 seal，格式为 `repro g@5bd5c6e d@a3f1 c@7b21`，其中 g/d/c 分别对应 git、dataset、code/preprocess。
- 展示逻辑从 champion.runID 定位 run.resourceUsage.reproducibility，不依赖打开 final bundle manifest。
- 新增回归：`shows the champion run reproducibility seal in the cockpit context`。

---

## 4. D 类：架构演进（不阻塞跑通）

| ID | 主题 | 现状 | 演进信号 |
|---|---|---|---|
| D-1 | 双状态源（TS DB + `.neo-cast/`） | 仅 `is_best` 列已收敛，仍有 results.tsv / runner_state.json | 等接入第二个 runner 时强制收敛 |
| D-2 | DomainRegistry 仅 TSF | 5 张接口为单域服务支撑 | 引入 Tabular / NLP 之前不动 |
| D-3 | 无 GPU-aware scheduling | maxParallel=1 无 vram 调度 | 多 H100 共享时再做 |
| D-4 | experiment lineage 表存在但 createCandidate 不传 parent | `parent_candidate_id` 永远 null | reflection 想画 mutation tree 时优先补 |

---

## 5. 跑通 ETTh1 端到端的最小验证矩阵

| # | 步骤 | 命令（CLI 路径） | 期望 |
|---|---|---|---|
| 1 | doctor | `node neo_cast/bin/neo-cast.js doctor` | runtime ok（LLM key 仅 warn） |
| 2 | dataset | 已存在 `.neo-cast/dataset/etth1_visible.csv` 11521 行 | profile 成功 |
| 3 | mock loop 1 轮 | `node neo_cast/bin/neo-cast.js design --requirement "small TSF baseline" --mode companion --max-candidates 1 --mock-llm` | 1 候选成功跑完 |
| 4 | mock autonomous 3 轮 | 同上 + `--autonomous --time-budget 30m --max-candidates 3 --mock-llm --use-mutation` | 3 候选跑完，至少 1 个 keep |
| 5 | results.tsv 完整性 | `cat .neo-cast/results.tsv` | header + ≥3 行 + is_best 全为 0 |
| 6 | runner_state | `cat .neo-cast/runner_state.json` | best_val_avg_mse 数值合理 |
| 7 | artifact 完整性 | `ls .neo-cast/artifacts/run_*/` | model.pt + val_metrics.json + metadata.json |
| 8 | (可选) export | TUI 内 `/export bundle` | manifest 含 reproducibility seal |

> 表中 #3-#7 即为本次实操要跑的最小路径，#8 依赖 cockpit。

---

## 6. 修复路线图（优先级排序）

### 立即（让 alpha 体验完整）
- [x] **B-3** 剥离 `Boolean(input.champion)` 让 stage 不立刻 done ✅
- [x] **B-1** 顶栏 slash 标签可点击预填命令 + idle 提示 ✅
- [x] **B-2** Context 区显示 modelLimit 占位（chat-only）✅；usage 全链回流仍待做
- [x] **R-1** doctor 把 LLM key 降级为 warn + 提示 mock fallback ✅

### 短期（上线前）
- [x] **R-2** e2e_autonomous_loop.test.ts（≤60s mock loop 2 轮）✅
- [x] **C-4** cockpit 显示 reproducibility seal ✅
- [x] **C-1** champion tie-breaker（val_h720_mse）✅

### 中期（演进）
- [x] **C-2 / C-3** reflection 时间衰减 + 探索调节 ✅
- [ ] **D-4** experiment lineage 真正记录 parent

### 长期（等需求触发）
- [ ] **D-1 / D-2 / D-3**

---

## 7. 跑通的实操结果

> 见同目录的 `AutoResearch端到端跑通日志.md`（接下来生成）。

**C 类修复验证（2026-05-10）**：
```bash
cd opencode/packages/opencode && bun test test/research/service.test.ts --timeout 120000
cd opencode/packages/opencode && bun test test/research/llm-proposal.test.ts --timeout 120000
cd opencode/packages/opencode && bun test test/cli/tui/research-cockpit-render.test.tsx --timeout 120000
cd opencode/packages/opencode && bun typecheck
```

结果：
- `service.test.ts`：68 pass
- `llm-proposal.test.ts`：6 pass
- `research-cockpit-render.test.tsx`：78 pass
- `bun typecheck`：通过

---

## 8. 一句话

> 真要跑通 alpha 不缺骨架；B / R / C 类已经补上。下一步主要剩 D 类长期架构演进，当前版本已经能 demo，且 champion、reflection、exploration、repro seal 都有可信度护栏。
