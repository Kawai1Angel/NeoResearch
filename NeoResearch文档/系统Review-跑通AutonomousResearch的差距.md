# NeoResearch 系统 Review：跑通 Autonomous TSF Research 还差什么

> 状态：P0 + P1 + P2 已全部修复 ✅
> Review 范围：v0.1.0-alpha（commit `cd6c67f` 时点）
> Reviewer：Claude（Opus 4.7） · 受 Mingyue 委托
> 初稿日期：2026-05-08 · 最后更新：2026-05-08

---

## 0. TL;DR

NeoResearch 的整体骨架（TUI cockpit · Effect Service · DomainRegistry · Neo-Cast subprocess runner · Verifier/Reflection agents）已经搭起来了，但**真正端到端把一个 autonomous loop 跑成功并稳定迭代 12 次**这条主路径上有若干**会直接破功**的 bug，以及一批**会让结果不可信**的契约漏洞。优先级按"是否阻塞首次跑通 → 是否影响实验可信度 → 是否仅是体验问题"排序，本文档给出具体位置 + 修复方向。

| 类别 | 数量 | 状态 |
|---|---:|---|
| **P0 阻塞类**（首次跑就会失败 / 严重浪费 GPU） | 4 | ✅ 全部已修复（含 legacy CLI 副作用闭环） |
| **P1 高风险类**（结果可信度 / 体验崩坏） | 8 | ✅ 全部已修复并补回归测试 |
| **P2 改进类**（正确但不优雅 / 边界场景） | 9 | ✅ 全部已修复并补回归测试 |
| **架构缺口** | 5 | 待处理（中长期演进点） |

---

## 1. P0：阻塞 autonomous loop 跑通的 bug

> **✅ 全部已修复（2026-05-08）**，alpha-check 测试 244/244 通过，typecheck clean。

---

### P0-1. ✅ Smoke 阶段在每次 full run 上**重复执行**（已修复）
**原位置**：`opencode/packages/opencode/src/research/runners/neo-cast-runner.ts:61-65` + `neo_cast/runner-manifest.json:22`

**根因**：TS `runAutonomousIteration` 已经先单独跑了 `validate.py smoke`（60 s），紧接着调 `runner.py run` 时未传 `--skip-smoke`，导致 Python 端再跑一次完整 smoke，每个候选浪费 ~60 s、artifacts 目录翻倍。

**已落地修复**：

```diff
// neo-cast-runner.ts DEFAULT_NEO_CAST_MANIFEST
- args: ["run", "--description", "{description}"],
+ args: ["run", "--description", "{description}", "--skip-smoke"],
```

```diff
// neo_cast/runner-manifest.json
- "args": ["run", "--description", "{description}"],
+ "args": ["run", "--description", "{description}", "--skip-smoke"],
```

**验证**：`bun test test/research/neo-cast-runner-client.test.ts test/research/tsf-domain.test.ts` → 28 pass。

---

### P0-2. ✅ `runner_state.json` 在 TS 主路径上**从未被初始化**（已修复）
**原位置**：`neo_cast/py/runner.py:104-108` + `opencode/packages/opencode/src/research/service.ts`（`executeRunnerPlan`）

**根因**：`runner.py run` 要求 `.neo-cast/runner_state.json` 存在（由 `runner.py init` 创建），但 TS 驱动路径从不调 init；仅 legacy `neo-cast design` CLI 会通过 `ensureRunnerInitialized` 触发。首次使用 TUI 跑 autonomous loop → `FileNotFoundError` → exitCode=1 → run 标 `failed` → crashStreak 累计。

**已落地修复**：在 `service.ts` 的 `executeRunnerPlan` 顶部新增 `ensureRunnerStateInitialized(plan)` 辅助函数：

```ts
async function ensureRunnerStateInitialized(plan: DomainRunPlan) {
  const cwd = plan.command.cwd ?? process.cwd()
  if (existsSync(path.join(cwd, ".neo-cast", "runner_state.json"))) return
  // 仅对 runner.py 脚本触发，validate.py 不需要 state
  const scriptArg = plan.command.args[0] ?? ""
  if (!scriptArg.endsWith("runner.py")) return
  const result = await Process.run(
    [plan.command.executable, scriptArg, "init"],
    { cwd, env: plan.command.env, nothrow: true, timeout: 30_000 },
  )
  if (result.code !== 0)
    throw new Error(`Neo-Cast runner init failed (exit ${result.code}) at ${cwd}`)
}
```

调用位置：`executeRunnerPlan` 第一行，writes loop 和 `Process.runStreaming` 之前。

**验证**：`bun test test/research/service.test.ts test/research/runtime.test.ts` → 72 pass；typecheck clean。

---

### P0-3. ✅ `TIME_BUDGET=600s` 的"不可变契约"**实际不被强制**（已修复）
**原位置**：`neo_cast/py/renderer.py:73`

**根因**：`min(int(budget["time_budget_s"]), DEFAULT_TIME_BUDGET_S)` 允许 LLM 提案 200 s 的候选真正跑 200 s，使 `val_avg_mse` 跨候选不可比（短跑 candidate 可能收敛不充分却被选为 champion）。

**已落地修复**：

```diff
# renderer.py
- "time_budget_s": min(int(budget["time_budget_s"]), DEFAULT_TIME_BUDGET_S),
+ "time_budget_s": DEFAULT_TIME_BUDGET_S,
```

所有 resolved candidate 强制使用全局 `TIME_BUDGET = 600 s`，无论 LLM 在 recipe 里写什么值。

**验证**：`uv run pytest py/tests/ -x -q` → 45 pass；`budget` 字典其他字段（`max_epochs`、`batch_size`、`patience`、`seed`）不受影响。

---

### P0-4. ✅ **两个独立的 "best" 跟踪器**长期不同步（已修复 + legacy CLI 副作用闭环）
**原位置**：
- TS 端：`research_champion` 表（`service.ts:3754`）
- Python 端：`runner_state.best_val_avg_mse` + `results.tsv` 的 `is_best=1` 列

**根因**：两边独立判断 "improved" 并各自写入，任何一边异常均永久 desync。TUI 显示的 champion 与 `results.tsv is_best=1` 行不一致，`/export` leaderboard 对不齐。

**已落地修复（两步）**：

**Step 1 — Python（`runner.py`）停止写 `is_best=1`：**
- `_write_result_row` 中 `is_best` 参数废弃，`results.tsv` 的 `is_best` 列永远写 `"0"`。
- 移除 `clear_best_for_session()` 函数（唯一调用方已消失）。
- `runner_state.json` 内部的 `best_val_avg_mse` / `no_improve_streak` 等计数器保留不变（legacy CLI 的停止条件仍依赖这些）。
- 添加注释：`is_best` 权威来源是 TS `research_champion` 表，`results.tsv` 退化为 trace 日志。

**Step 2 — Legacy CLI JS（`session.js` / `output.js` / `companion.js` / `cli.js` / `loop.js`）用 status 派生 "best"：**

| 文件 | 改动 |
|---|---|
| `session.js:getBestSessionRow` | 改为扫描 session 内 `val_avg_mse` 最小值（跳过 crash/smoke_fail/invalid 行）；不再依赖 `is_best="1"` |
| `output.js:32` | `BEST=${row.is_best}` → `BEST=${row.status === "keep" ? "1" : "0"}` |
| `modes/companion.js:186` | `if (row.is_best === "1")` → `if (row.status === "keep")` |
| `cli.js`（3 处）+ `loop.js`（3 处）| lineage metadata `is_best: row.is_best \|\| null` → `is_best: row.status === "keep" ? "1" : "0"` |

`status === "keep"` 即 Python 本地 best 改进信号，与原 `is_best=1` 的"session-local 最优"语义等价；`getBestSessionRow` 直接从 `val_avg_mse` 数值重算，兜底健壮。

**设计清晰度**：
- **TS DB `research_champion`** = 全局 champion 真相源（cockpit 显示、LLM 上下文、export）
- **`status="keep"`** = session-local 改进标记（legacy CLI 内部展示）
- **`results.tsv.is_best`** = 永远 "0"，schema 列保留为向后兼容占位符

**验证**：`cd neo_cast && npm test` → 59 JS + 1 Python = 60 pass；session.test.js（`getBestSessionRow` 用例）继续通过。

---

## 2. P1：影响结果可信度 / 体验崩坏的问题

> **✅ 全部已修复（2026-05-08）**。覆盖测试：`bun test ./test/research/service.test.ts ./test/research/llm-proposal.test.ts` → 68 pass；`python3 -m unittest neo_cast.py.tests.test_dataset_presets` → 4 pass。

### P1-1. ✅ 短数据集（<2000 行）走自动 60/20/20 分割直接抛错（已修复）
**位置**：`neo_cast/py/dataset_contract.py:244`（`infer_contiguous_splits`）

```python
def infer_contiguous_splits(total_rows, input_len, max_horizon):
    train_end = int(total_rows * 0.6)
    ...
    if train_end < min_segment or val_end - train_end < max_horizon or ref_end - val_end < max_horizon:
        raise ValueError("Dataset is too short for automatic 60/20/20 splits ...")
```

`input_len=512, max_horizon=720, total_rows=966`（illness.csv）→ `train_end=579 < min_segment=1232` → 直接抛错。**用户的体验是点 Prepare Dataset → 一闪而过的红字 stderr → "怎么又失败了"**。

**修复**：
1. **TS 预校验**：`buildPrepareDatasetCommand` 调用前在 cockpit 显示 "数据集只有 966 行，最小需要 ~2050 行"，并提示是否**降低 input_len / 减少 horizon**。
2. **Python 自适应**：`_build_materialize_spec` 若检测到 `total_rows < 5*(input_len+max_horizon)`，自动 clamp `input_len/horizon` 到可行域并 emit warning。
3. 文档（`使用指南.md` 已经写了"约 600 行以上"）需要更新成更准确的数字。

**已落地修复**：
- TS `buildPrepareDatasetCommand` 在执行 `neo-cast prepare-data` 前按当前 split 策略、`input_len`、最大 horizon 计算最小行数；短数据集直接返回包含 `rows/minimumRows/input_len/max_horizon` 的友好错误。
- 覆盖测试：`prepare dataset fails early with a friendly message when a custom CSV is too short`。

---

### P1-2. ✅ `running` 状态的 run 在重启后**永远卡住**（已修复）
**位置**：`opencode/packages/opencode/src/research/service.ts`（`updateRunStatus`），无启动期 reconcile 逻辑。

**场景**：
1. 用户启动 loop → run #1 状态变 `running` → time_started 写入。
2. 用户 `Ctrl+C` 退 TUI（process kill），子进程的 python 也死了。
3. 重启 TUI → run #1 在 DB 里**永远是 running**，不会被任何代码标 `failed`。
4. autonomous loop 看到 "有 running run" 不会启动新一轮（`maxParallel` 检查），陷入死锁。

**修复**：在 `Service` 启动时（`Layer.effect` 或 `getTask` 第一次调用）做一次 reconcile：
```ts
UPDATE research_run
SET status = 'failed', error = 'TUI restart while running', time_finished = NOW
WHERE status IN ('running', 'queued') AND time_updated < NOW - 5min
```
门槛建议：5 min 没有 heartbeat 视为僵死。

**已落地修复**：
- Research service 启动时执行 `reconcileStaleRuns`，将当前 project 中超过 5 分钟未更新的 `queued/running` run 标记为 `failed` 并发布 `RunUpdated` 事件。
- 覆盖测试：`stale queued and running runs are reconciled to failed when the service starts`。

---

### P1-3. ✅ Run 子进程没有 **stdout 心跳超时 / NaN 看门狗**（已修复）
**位置**：`service.ts:2501-2526`（`executeRunnerPlan`）

`Process.runStreaming` 设了 `timeout: 900000`（15 min），但：
- 没有 "180 s 没收到任何 stdout 行就 kill 子进程" 的 watchdog。
- 没有 "连续 N 个 epoch_end 的 val_loss=NaN 就 kill" 的运行时检测。

实际后果：训练脚本 hang 在 dataloader（数据集太小、batch_size 太大、worker 死锁）→ 等满 15 min。NaN 训练曲线 → 等满 15 min 才发现没有 metric。

**修复**：
- 给 `Process.runStreaming` 加 `idleTimeout`（180 s 无 stdout）。
- 在 `parseProgressLine` 检测到 `val_loss=NaN` 时 emit 事件，TS 累计 ≥ 3 次后 kill 该子进程。

**已落地修复**：
- `executeRunnerPlan` 增加 180s stdout/stderr idle watchdog；超时会 abort runner 并把错误写入 run stderr。
- `executeRunnerPlan` 对连续 3 条 `val_loss=NaN` 触发 NaN watchdog，直接 abort 当前 run。
- 覆盖测试：`runner execution aborts after repeated NaN validation losses`。

---

### P1-4. ✅ `infer_contiguous_splits` 与 `infer_tsl_custom_splits` 重复且不一致（已修复）
**位置**：`dataset_contract.py:244-275`

`infer_contiguous_splits` 是 60/20/20，`infer_tsl_custom_splits` 是 70/10/20，两个函数仅在 `dataset_preset` 是 `tsl_custom_70_10_20` 时才走第二个，且**只对内置 preset 启用**——自定义 CSV 永远只走 60/20/20，与 TSL 文献基线对不齐。这会让 LLM 用 "vs TSL 基准" 的语言提案时出现错位（基准是 70/10/20 的，自己是 60/20/20 的）。

**修复**：让自定义 CSV 也支持 `--split-strategy` 参数，默认沿用 70/10/20 与 TSL 对齐。

**已落地修复**：
- `prepare_tsf.py` 新增 `--split-strategy {tsl_custom_70_10_20,contiguous_60_20_20}`。
- 自定义 CSV 默认使用 `tsl_custom_70_10_20`，仍可显式选择 legacy `contiguous_60_20_20`。
- TS `prepare-data` 命令对 custom CSV 显式传 `--split-strategy tsl_custom_70_10_20`。
- 覆盖测试：`test_custom_task_id_without_preset_uses_tsl_custom_splits_by_default` 和 `test_custom_task_id_can_request_legacy_contiguous_splits`。

---

### P1-5. ✅ Memory 按 `basename(dataset.path)` 做 key，存在跨数据集污染（已修复）
**位置**：`service.ts:3781`、`service.ts:3809`

```ts
const evalSourceCsv = typeof evalDataset.path === "string"
  ? path.basename(evalDataset.path)
  : (typeof evalDataset.loaderID === "string" ? evalDataset.loaderID : "unknown")
```

- `/data/projA/ETTh1.csv` 和 `/data/projB/ETTh1.csv` 共享同一个 memory bucket。
- 当 `dataset.path` 不存在时 fallback 到 "unknown"，所有未指定路径的任务挤在一个 bucket 里。

**修复**：用 **绝对路径 + sha256(前 1MB)** 做 key，保证唯一性；UI 上仍可显示 basename。

**已落地修复**：
- run memory 的 `sourceCsv` 改为 `absolute_path#sha256_1mb=<hash>`；无路径时使用 `loader:<loaderID>`。
- 成功和失败 run memory 均使用同一个 `datasetSourceKey` helper。
- 覆盖测试：`research memory keys distinguish same-basename datasets by path and file hash`。

---

### P1-6. ✅ 静默 `Effect.catchCause(() => Effect.void)` 吞错（已修复）
**位置**：至少 4 处，举例 `service.ts:4904`（mid-loop reflection）、`service.ts:6047`（LLM reflection synthesis）。

```ts
}).pipe(Effect.catchCause(() => Effect.void))
```

任何反思阶段失败（zod 解析挂了、文件写挂了、LLM 没钱了）→ 静默吞掉，loop 继续；用户看不到任何信号。

**修复**：把这些 `catchCause(() => Effect.void)` 改成 `catchCause((cause) => bus.publish(Event.AgentFailed, { stage: "reflection", cause }))`，至少在 stream 区显示一行警告。

**已落地修复**：
- research service 中残留的静默 `catchCause(() => Effect.void)` 已移除。
- mid-loop reflection 失败会发布 `ReflectionAgentFailed` 事件，metadata 中包含错误类型和 message。

---

### P1-7. ✅ LLM 候选生成上下文**严重截断**（已修复）
**位置**：`llm-proposal.ts:313-316`

```ts
existingCandidates: input.proposalContext.candidates.slice(-8),
runs: input.proposalContext.runs.slice(-12),
memory: input.proposalContext.memory.slice(0, 8),
```

- 过去 8 个候选、12 个 run、8 条 memory。当 loop 跑到第 15 轮时，第 1-3 轮的成功/失败经验已经从上下文里掉出去，LLM **会重复提案早期已被否决的候选**。
- 没有 "代表性采样"（按 metric 分位 / 失败类别分层）。

**修复**：
- `existingCandidates`: 取 top-K 接近 champion + 最近 5 个 + 至少 1 个失败案例。
- `memory`: 按 outcome 分层（accepted / rejected / failed 各取 N 条）。
- `runs`: 同 candidates 策略。

**已落地修复**：
- `llm-proposal.ts` 改为代表性采样：champion / top succeeded / rejected / failed / recent candidates，champion + failed + top + recent runs，accepted/rejected/failed 分层 memory。
- 覆盖测试：`LLM proposal prompt samples representative candidate, run, and memory history`。

---

### P1-8. ✅ `--feature-cols` 静默丢列（已修复）
**位置**：`service.ts:2592-2598`（`buildPrepareDatasetCommand`）

```ts
const validCols = csvHeaders.length > 0
  ? config.targetCols.filter((col) => csvHeaders.includes(col))
  : config.targetCols
if (validCols.length > 0) args.push("--feature-cols", validCols.join(","))
```

- 用户配 `targetCols=["A","B","C"]`，CSV 里只有 "A"，就只传 `--feature-cols A`。"B" 和 "C" 没了，但也没有任何告警。
- 当全部列都不在 CSV header 时（METR-LA 例），完全不传 `--feature-cols`，让 Python 自动推断——**结果靠运气**。

**修复**：
- `csvHeaderColumns` 失败或全不匹配时，TS 应当抛错给 cockpit："你的目标列在 CSV 中找不到，先 /dataset profile 看看吧"。
- 部分匹配时显式 warning："只能匹配 1/3 列，将以此继续"。

**已落地修复**：
- 全部目标列都匹配失败时直接抛错，错误包含 requested columns 和 CSV header。
- 部分匹配时继续运行，但把 warning 写入 `dataset-preparation.json` 的 `command.warnings` 以及 artifact metadata。
- 覆盖测试：`prepare dataset reports missing target columns instead of silently dropping them`。

---

## 3. P2：正确性 / 可读性 / 边界场景

### P2-1. ✅ Renderer 每个候选跑 2-3 次（已修复）
`validate.py smoke` 内部跑一次 `renderer.py`，紧接着 `runner.py run`（fix 掉 P0-1 后）也会跑一次。同一份 candidate 渲染两次，浪费 ~1-2 s/candidate。

**已落地修复**：
- `validate.py smoke` 成功 resolve 后 emit `resolved_candidate_ready`，包含 `resolved_candidate_path`。
- `runner.py run --skip-smoke` 新增 `_resolved_candidate_is_fresh()`，当 `resolved_candidate.json` 比 `current_candidate.json` 更新且字段完整时直接复用，不再重复调用 renderer。
- 覆盖测试：`test_skip_smoke_reuses_fresh_resolved_candidate_without_rendering_again`。

---

### P2-2. ✅ Smoke 的 artifact 子目录污染 `.neo-cast/artifacts/`（已修复）
- `train.py:651-664` 每次 run（包括 smoke）都创建 `run_<id>/` 并 emit `artifact_ready`。
- Smoke 的 artifact 一般没人看，但永久留存。
- **跑 100 个候选 = 200 个 run_id 目录**（fix P0-1 后是 100 个，仍然多）。

**已落地修复**：
- `train.py` 将 smoke artifact 写入 `.neo-cast/artifacts/smoke/run_<id>/`，full run 仍写 `.neo-cast/artifacts/run_<id>/`。
- smoke artifact GC 保留最近 30 个目录。
- 覆盖测试：`test_smoke_artifacts_are_isolated_and_old_smoke_runs_are_collected`。

---

### P2-3. ✅ 单 seed 的 val metric 上 champion，方差未估计（已修复）
- `evaluateSucceededRun` 比较 `primaryMetric` 单值。
- `executeSeedSweep` 存在但只能手动 `/seed-sweep`。
- 同一 candidate seed=42 vs seed=43 的 `val_avg_mse` 差异可能 > champion 切换阈值，导致 champion 频繁震荡。

**已落地修复**：
- `evaluateSucceededRun` 读取 `taskSpec.evaluation.seeds`；当任务配置了多 seed 且已有 champion 时，challenger 在覆盖足够 seed 之前不会替换 champion。
- 达到 seed 覆盖后使用样本均值进行 champion 比较；若双方都有多 seed 样本且 95% CI 重叠，则判为不确定，不切换 champion。
- memory 中记录 `seedGate`（required/observed/mean/std/ci95/status），便于复盘。
- 覆盖测试：`requires configured seed coverage before replacing an existing champion`。

---

### P2-4. ✅ Manifest 的 `timeout_ms: 900000` 与 candidate 的 `time_budget_s` 不互动（已修复）
即使 candidate 自报 `time_budget_s=300`，TS 仍会等 15 min。

**已落地修复**：`createTSFRunPlan` 在 low/full 阶段根据 recipe `trainingStrategy.budget.timeBudgetS` 覆盖 runner command timeout：`max(120, time_budget_s + 120) * 1000`。覆盖测试：phase-two runner plan 断言 120s budget → 240000ms。

---

### P2-5. ✅ `objective.primaryMetric` 默认为 `val_avg_mse`，但 LLM 可在 candidate 里输出 quantile/gaussian head（已修复）
模型 head 是 quantile/gaussian 时，`val_avg_mse` 仍然被计算（中位数 → MSE），但**与点预测的 MSE 不可比**。Memory/champion 比较时是在拿苹果跟橘子对比。

**已落地修复**：
- `evaluateTSFRun` 根据 candidate `predictionHead.outputDistribution` 选择主指标：quantile → `val_avg_pinball`；gaussian → `val_avg_crps_approx`；point → 原 objective metric。
- 如果概率头缺少对应概率指标，则 `primaryMetric` 为 `undefined`，不会进入 champion 比较。
- 覆盖测试：`keeps probabilistic heads on probabilistic validation metrics`。

---

### P2-6. ✅ `riskLevel` 与 `bridgeOnly` 强耦合（已修复）
**位置**：`llm-proposal.ts:435-438`

```ts
const bridgeOnly = runtime.bridgeOnly !== false
const governance = bridgeOnly
  ? ({ riskLevel: "low", approvalStatus: "auto_approved" } as const)
  : ({ riskLevel: "medium", approvalStatus: "pending" } as const)
```

`bridgeOnly` 是一个**架构开关**（候选是否可以走非 bridge 模型），但被当成 risk 评估代理。结果：bridge mode 下任何 candidate 都被 auto_approve（即使其 num_params=10M、超出 param_budget）；full mode 下任何 candidate 都需要人工审批（即使是非常保守的 nlinear）。

**已落地修复**：
- `llm-proposal.ts` 新增 `candidateGovernance()`，基于 candidate 内容评估 risk，而不是直接用 `bridgeOnly` 代理。
- bridge-safe 且预算保守的候选可 `low/auto_approved`；使用 native/概率/复杂 ops 时进入 `medium/pending`；超大 batch、超长 time budget、过深/过宽模型进入 `high/pending`。
- 覆盖测试：保守 full-mode LLM 候选可自动通过；bridge-mode 下激进预算候选需要人工 review。

---

### P2-7. ✅ `metricsFromRecords` 抓取 `val_*` 与 `ref_test_*` 但不区分 stage（已修复）
**位置**：`service.ts:434-444`

如果一次 run 的 stdout 包含历史 ref_test 残余日志（例如 train 子进程读了上次的 cache），`val_avg_mse` 与 `ref_test_avg_mse` 会被混合写入同一 metrics 字典。

**已落地修复**：P1 修复中已完成，`metricsFromRecords(records, stage)` 按 stage 过滤；`ref_test/blind_test` 只接收对应前缀，训练阶段只接收 `val_*`。覆盖在 service runner tests 中。

---

### P2-8. ✅ 缺少 reproducibility seal（已修复）
没有任何 run 记录会写入：git SHA、`pyproject.toml` lock 哈希、`prepare_tsf.py` 的 SHA、数据集文件 SHA。出 paper / bundle 时无法证明"这就是当时的代码 + 数据"。

**已落地修复**：
- runner 成功后 `executePreparedRun` 写入 `run.resourceUsage.reproducibility`：
```json
{"gitSHA": "...", "lockHash": "...", "datasetSHA": "...", "preprocessSHA": "..."}
```
- final bundle 的 `manifest.json` 将 champion run 的 reproducibility seal 提升到顶层 `reproducibility` 字段。
- 覆盖测试：runner plan 执行后断言 `datasetSHA/lockHash/preprocessSHA` 存在。

---

### P2-9. ✅ TUI 退出/重启会丢失进行中的 stream 缓冲（已修复）
当前 `streamLines` 是 in-memory（`createMemo`），重启后 chat / runner output 全部消失。用户看到 "Champion 突然出现在右上角但没有过程"。

**已落地修复**：
- `executePreparedRun` 将 runner progress 持久化为 `.neo-research/runner-progress/<task>/<run>.jsonl`，并创建 `runner_progress_jsonl` artifact。
- artifact metadata 写入最近 30 条 `previewLines`；TUI `streamLines` 会在没有 live buffer 或 run 已结束时从 `previewLines` replay 最新 run 进度。
- 未新增 sqlite 表，避免迁移成本；后续若需要跨端全量 event replay，可再升级为 `research_event` 表。
- 覆盖测试：runner progress artifact 创建、JSONL 内容包含 `stage_start/epoch_end`；失败 run 也保留 progress artifact。

---

## 4. 架构 / 设计缺口

### A-1. 状态分两份：TS DB + `.neo-cast/`
| 在哪 | 存什么 |
|---|---|
| TS sqlite | tasks · candidates · runs · champion · approvals · memory · artifacts |
| `.neo-cast/` | runner_state.json · results.tsv · approval_state.json · artifacts/ · current/resolved_candidate.json |

两份状态没有定期对账机制。Cockpit "Runner dataset mismatch" 之类的提示已经在试图调和，但每次新加一个状态字段都要在两边各写一遍。

**演进方向**：
- 让 `.neo-cast/` 只保留**输入**（current_candidate.json）和**临时输出**（artifacts/）；删除 results.tsv 和 runner_state.json 的"决策状态"职能（移到 TS DB）。
- `approval_state.json` 直接由 TS DB 镜像；Python 只读不写。

### A-2. `DomainRegistry` 抽象**只服务 TSF**，但代价是高复杂度
- 5 张接口（domain.ts 共 212 行）+ 一个注册器（domain-registry.ts 102 行）+ 一个全 2897 行的 tsf 实现。
- 短期内不会加第二个域，多出来的接口层让每次改 schema 都要 5 处同步（schema · DomainRegistry · 例子 · prompts · tests，在 CLAUDE.md 里也明示了）。

**演进方向**：要么真正引入第二个域（Tabular / NLP）来验证抽象；要么把 TSF 的 domain 直接合并到 `service.ts`，等需要再抽。

### A-3. 没有 GPU-aware scheduling
`maxParallel` 默认 1，但即使 >1 也没人协调显存。多用户共享一台 H100 时会 OOM 撞车。

**演进方向**：引入一个 GPU 资源池（基于 CUDA_VISIBLE_DEVICES 切分），run plan 携带 estimated_vram_mb。

### A-4. CI 不覆盖端到端 autonomous loop
`make smoke` 只跑 design pipeline；`bun test` 只跑单元 + service.test.ts；**TUI 启动 → /loop start → Python 训练完成 → 2 个候选 → champion 切换** 这条主路径没有任何自动化测试。

**演进方向**：加一个 `e2e_autonomous_loop.test.ts`，用 `--mock-llm` 跑 2 轮 nlinear baseline，跑通 smoke + run + champion 切换 + export bundle，目标 < 60 s。

### A-5. 没有 "experiment lineage"
- `parent_candidate_id` 字段在 `research_candidate` 表里**已经存在**（`research.sql.ts:50`），但 `createCandidate` 调用时**从未传值**，所有 candidate 都是孤立节点。
- 失去了 "这个 candidate 是从那个 candidate mutate 出来的" 这条线索 → reflection 无法画 mutation tree → 不能可视化"哪条搜索路径产出 champion"。

**修复**：当 LLM 提案显式说 "based on candidate-X" 时，渲染到 `parentCandidateID`；本地 mutation 也要记录。

---

## 5. 验证矩阵：跑通 alpha 应该过的最小测试

| # | 场景 | 命令 | 期望 |
|---|---|---|---|
| 1 | 健康检查 | `make doctor` | python ≥3.10 / venv ok / runner_state.json ok / API key set |
| 2 | 内置数据集 | `/new task --preset etth1` → `/loop start --maxRuns 2` | 2 个候选成功，champion 切换 |
| 3 | 自定义 CSV | `/new csv path=ETTh1.csv` → `/dataset prepare` → `/loop start` | 同上，默认走 TSL 70/10/20；可显式切 legacy 60/20/20 |
| 4 | LLM 不可用 | `unset ANTHROPIC_API_KEY` → 同 #2 | seed baselines 仍可执行，loop 完成 3 个内置 baseline |
| 5 | 短数据集 | `/new csv path=illness.csv (966行)` | 用户友好的错误："数据集太短" |
| 6 | TUI 重启 | loop 跑到一半 `Ctrl+C` → 重新进 → reconcile | running 的 run 在 5 分钟内被标 failed |
| 7 | NaN 训练 | 故意构造一个 lr=10 的 candidate | watchdog 在 ~30 s 内 kill 进程 |
| 8 | OOM | 故意构造 batch_size=4096 | run 标 failed，reflection 推荐降 batch |
| 9 | 重复跑 | 同样 task 第二次 `/loop start` | runs/champion 不重置；results.tsv 增量 |
| 10 | Export | `/export bundle` | 包含 champion run 的 model.pt / val_metrics / git SHA |

当前已通过单元/服务层回归覆盖：P2-1~P2-9，以及 P1 相关的 feature-cols、memory key、LLM 上下文采样、split strategy。完整端到端矩阵仍需后续 e2e 测试验证。

---

## 6. 修复路线图

### Sprint 1（1 周）：让 alpha 真正能跑
- [x] **P0-1** 给 manifest 加 `--skip-smoke` ✅ 已完成
- [x] **P0-2** TS 自动 `runner.py init` ✅ 已完成（`ensureRunnerStateInitialized`）
- [x] **P0-3** `renderer.py` 强制 `time_budget_s = TIME_BUDGET` ✅ 已完成
- [x] **P0-4** Python 端不再决策 best，`results.tsv is_best` 永远 "0"；legacy CLI 副作用全部闭环 ✅ 已完成
- [x] **P1-2** 启动时 reconcile running runs ✅ 已完成（`reconcileStaleRuns`）
- [x] **P1-3** runner idle timeout 与 NaN watchdog ✅ 已完成（`executeRunnerPlan`）
- [x] **P1-1** 短数据集预校验 + 友好提示 ✅ 已完成
- [ ] **A-4** e2e_autonomous_loop.test.ts（1.5 天）

### Sprint 2（1 周）：可信度与可观测性
- [x] **P1-5** Memory key 改为绝对路径 + 文件 hash ✅ 已完成
- [x] **P1-6** 把 `Effect.catchCause(() => Effect.void)` 全部替换成事件发布 ✅ 已完成
- [x] **P1-7** LLM 上下文分层采样 ✅ 已完成
- [x] **P1-8** `--feature-cols` 缺失时显式抛错 ✅ 已完成
- [x] **P2-3** Champion 切换前 seed 覆盖与不确定性门控 ✅ 已完成
- [x] **P2-8** Reproducibility seal ✅ 已完成

### Sprint 3+：架构演进
- A-1 状态合并、A-3 GPU 池、A-5 lineage、A-2 等到第二个域出现再决定。

---

## 7. 一句话总结

> P0 + P1 + P2 已经清掉：首次跑通主路径、数据集准备、runner 僵死恢复、NaN/idle 看门狗、memory 隔离、LLM 上下文采样、feature-cols 契约、seed 门控、复现 seal、runner progress 持久化都已有回归测试。
> 下一步重点不再是"能不能跑"，而是补 e2e autonomous loop 和更长期的状态收敛。
