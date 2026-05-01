# NeoResearch Vibe DS 流水线 Bug Review

> 日期：2026-05-01
> 范围：仅看会**破坏 Vibe Data Science 八阶段闭环正确性**的 bug。代码风格 / Effect 错误处理 / 重复代码等已在 `代码Review结果.md` 覆盖，不再重复。
> 之前 review 已记录的不重复列出。

---

## 一、Critical（破坏流水线语义）

### V-B1. `profileSeasonality` 不去趋势 → 季节性指标对趋势序列严重失真

**位置**：`opencode/packages/opencode/src/research/domains/tsf.ts:1014-1027`

```typescript
function profileSeasonality(matrix: number[][]) {
  if (matrix.length < 8) return 0
  const candidateLags = [24, 48, 96, 12, 7].filter((lag) => lag < matrix.length / 2)
  ...
  for (let col = 0; col < matrix[0]!.length; col++) {
    const values = column(matrix, col)
    const best = Math.max(
      ...candidateLags.map((lag) => Math.abs(pearson(values.slice(lag), values.slice(0, values.length - lag)))),
    )
    ...
  }
}
```

**问题**：直接对原始序列做 lag-pearson。任何带强趋势的单调序列都会得到接近 1 的"季节性"分数，因为 `values[t]` 与 `values[t-lag]` 高度线性相关来自趋势而非周期。

**影响**：阶段 2（数据分析）。`datasetProfile.seasonalityStrength` 在大量真实 TSF 数据集上虚高 → 阶段 3 LLM 拿到错误信号 → 错误推荐 patch / transformer 模型。

**修复**：先减一阶差分或线性去趋势再算 lag pearson：
```typescript
const detrended = values.map((v, i) => i === 0 ? 0 : v - values[i-1])
```

---

### V-B2. autonomous loop `maxIterations` 默认值 = 1

**位置**：`opencode/packages/opencode/src/research/service.ts:2985`

```typescript
const maxIterations = Math.max(1, Math.min(Math.floor(input.maxIterations ?? 1), 50))
```

**问题**：用户从 cockpit `Agent Loop ^L` 触发时 `cockpit.tsx:567` 传 `maxIterations: 3`（写死 3），但通过 REST `/research/tasks/.../autonomous/loop` 直接调用且不传 `maxIterations` 时只跑 **1 次迭代**就结束。这与 "autonomous loop 持续迭代直到收敛" 的语义完全不符。

**影响**：阶段 6（自主迭代）。任何不通过 cockpit 触发的自主流程（API 集成、CI 脚本、未来的 web dashboard）都默认只跑一轮。

**修复**：默认值改为 task.budget 中的合理上限（如 `task.budget.maxRuns`），或最低 10。

---

### V-B3. `train.py` smoke 阶段 param budget 隐式 2 倍

**位置**：`neo_cast/py/train.py:537`

```python
if smoke and num_params_m > 2.0 * param_budget_m:
```

**问题**：smoke 校验允许参数量达到声明 budget 的 2 倍。这意味着 LLM 给出超预算 1.8x 的 recipe 仍能通过 smoke gate，但**没有任何下游环节再做参数量约束检查**——`train_models` 在 full 阶段不再校验，于是该候选会被正常训练。

**影响**：阶段 5（资源约束训练）。"按给定资源训练"承诺被破坏：用户声明的 `param_budget_m` 实际上只是软约束。

**修复**：smoke gate 应严格检查 `> param_budget_m`；或在 full 阶段开头加一次显式 budget 校验。

---

## 二、Major（影响阶段输出可信度）

### V-B4. `train.py` epoch 内层 break 不退出 epoch 外层循环

**位置**：`neo_cast/py/train.py:567-588`

```python
for epoch in range(1, max_epochs + 1):
    if time.time() - t_start >= time_budget_s:    # 外层 timeout 检查
        emit("timeout", ...)
        break
    active_horizons = [h for h in horizons if not stopped[h]]
    if not active_horizons:
        break
    for horizon in active_horizons:
        if time.time() - t_start >= time_budget_s:    # 内层 timeout 检查
            break    # 只 break 出内层！
        run_epoch(...)    # 这里可能跑很久
```

**问题**：内层 `break` 只退出 horizon 循环，外层 `for epoch` 继续到下一轮，再触发外层 timeout 检查。中间一次完整 epoch（4 个 horizon）的 run_epoch 浪费在已超预算时段。

**影响**：阶段 5 资源预算被偶发性突破，最大可达"一个 epoch 跨四 horizon"的额外开销（在 600s 预算下可能接近 1-2 分钟）。

**修复**：把内层 break 替换为外层标志或用 `else: break` 的双重退出。

---

### V-B5. `train.py` horizon_done 在 timeout 时仍报 reason="finished"

**位置**：`neo_cast/py/train.py:612-613`

```python
for horizon in horizons:
    models[horizon].load_state_dict(best_states[horizon])
    models[horizon].eval()
    if not stopped[horizon]:
        emit("horizon_done", horizon=horizon, best_val_loss=..., reason="finished")
```

**问题**：当 outer timeout 触发 break 后，没 early-stopped 的 horizon 仍发 `reason="finished"`。但实际它根本没收敛，只是被掐断。

**影响**：阶段 8b（实验报告）。报告生成或 mutate 策略读 NDJSON 事件时，看到 `finished` 会误判该 horizon 已收敛，从而忽略其 timeout 真相，导致后续 mutate 决策偏差。

**修复**：传入 timeout 标志，区分发送 `reason="timeout"` vs `reason="finished"`。

---

### V-B6. `profileDistributionShift` 常数 / 近常数列异常放大

**位置**：`opencode/packages/opencode/src/research/domains/tsf.ts:1041-1057`

```typescript
const scale = stdFinite(allValues) || 1
const meanShift = Math.abs(meanFinite(secondValues) - meanFinite(firstValues)) / scale
const stdShift = Math.abs(stdFinite(secondValues) - stdFinite(firstValues)) / scale
shifts.push(meanShift + 0.5 * stdShift)
```

**问题**：当列接近常数（std≈0）时，`scale` fallback 为 1。如果两半段均值差为 100（绝对值大但相对常数列还是稳定），归一化后得到 100 而非合理的"无偏移"。

**影响**：阶段 2 数据分析。带常数 / 类常数列的多通道数据集（如 ETT 系列里的某些近常数控制变量）的 distributionShift 被虚高，向 LLM 传错误信号。

**修复**：scale 为 0 时直接返回 0（视为无偏移），或者用 IQR 替代 std。

---

### V-B7. `runAutonomousIteration` 第一轮 `seedBaselines` 失败无 graceful 处理

**位置**：`opencode/packages/opencode/src/research/service.ts:2690-2695`

```typescript
let seeded: SeedBaselinesResult = { candidates: [], approvals: [] }
let candidates = yield* listCandidates(task.id)
if (candidates.length === 0) {
  seeded = yield* seedBaselines({ taskID: task.id })   // 任何 throw 直接外抛
  candidates = seeded.candidates
}
```

**问题**：`seedBaselines` 抛错时整个 iteration 中断，autonomous loop 的 `Effect.catchCause` 只捕 `ApprovalRequiredError`（service.ts:3023），其他错误直接抛出。这把 loop 整体打挂，无任何 iteration 记录，用户在 cockpit 看到 toast 后不知道是 baseline seed 还是 LLM 失败。

**影响**：阶段 3 / 6。新建任务首次跑 autonomous loop 时若 seed 失败（数据集 fingerprint 出错、DB 写冲突等），用户看到的现象与"模型训练失败"完全相同。

**修复**：catchCause 增加 SeedBaselinesError 分支，转成显式 stoppedReason: "seed_failed"。

---

### V-B8. `exportTaskArtifact` 不在事务内读取实体

**位置**：`opencode/packages/opencode/src/research/service.ts:2937-2980+`、`tsf.ts:2285+`

`renderTSFArtifact` 顺序读 `task / candidates / runs / approvals / memory / champion`，每次都是独立 DB 查询，没有事务。autonomous loop 并发跑时，导出的报告里 `runs` 数比 `candidates` 多对应不上、`champion` 引用的 run 在 runs 列表里不存在等不一致情况会出现。

**影响**：阶段 8b 实验报告可信度。

**修复**：`exportTaskArtifact` 用 `Effect.scoped` 把所有读包在一个事务里，或者用 db.transaction 显式串行化。

---

## 三、Minor

### V-B9. `profileTrend` 用 row index 当 time 轴

**位置**：`tsf.ts:1007-1012`
```typescript
const time = matrix.map((_, index) => index)
```
**问题**：缺失行（NaN）也占一个 index，导致时间轴不连续；带不规则时间戳的数据集 trend 估计有偏。
**影响**：阶段 2 数据分析。
**修复**：用真实 timestamp 列做 x 轴，或先重采样到等间距。

---

### V-B10. `attemptedCandidateIDsFromRuns` 重试阈值在 metric 缺失时不计入失败

**位置**：`service.ts:549-563`

只把 `run.status === "failed"` 计入 failedCounts，但 `succeeded` 但 metric 缺失（如 train.py 写 `eval_done` 但内容为空）的 run 既不入 failedCounts 也被 `attempted.add()`。后果：autonomous loop 不会重试该候选，但也无法用其 metric 决策，相当于把这个候选"软跳过"。

**影响**：阶段 6。极端情况下所有候选都进入这个状态时 loop 直接退出 max_iterations，但用户看到的是"全 succeeded 但无任何 metric"的诡异状态。

**修复**：把"succeeded 但 primaryMetric 缺失"显式分到 `inconclusive` 类别并暴露给 UI。

---

## 四、按 Vibe DS 流水线阶段映射

| 阶段 | 受影响 bug | 净影响 |
|------|-----------|--------|
| 2 数据分析 | V-B1, V-B6, V-B9 | seasonality / shift 失真 → 阶段 3 决策错信 |
| 3 假设/候选 | V-B7 | 第一轮 seed 失败用户无法定位 |
| 5 训练 | V-B3, V-B4, V-B5 | 资源预算被突破 + 收敛报告失真 |
| 6 迭代 | V-B2, V-B10 | API 默认 1 轮 / 软跳过候选不可见 |
| 8b 报告 | V-B5, V-B8 | 报告快照可能不一致 / horizon 状态误报 |

---

## 五、与已有文档的关系

| 文档 | 关注点 |
|------|--------|
| `代码Review结果.md` | 通用 bug、Effect 错误处理、发布边界 |
| `tui_usability_gap_analysis_v2.md` | TUI 用户能否跑通流程 |
| `vibe_data_science_alignment_review.md` | 八阶段功能完整性 |
| **本文档** | 已实现阶段的**正确性 bug**（聚焦数据分析失真、训练预算突破、loop 默认值、报告快照、seed 错误处理） |

---

## 六、修复优先级建议

| 优先级 | Bug | 文件 | 工作量 |
|--------|-----|------|--------|
| P0 | V-B1 seasonality 不去趋势 | tsf.ts:1014 | 30 分钟 |
| P0 | V-B2 maxIterations 默认 1 | service.ts:2985 | 10 分钟 |
| P0 | V-B3 smoke param budget 2x | train.py:537 | 10 分钟 |
| P1 | V-B4 epoch break 漏出 | train.py:567 | 30 分钟 |
| P1 | V-B5 horizon_done reason 误报 | train.py:612 | 20 分钟 |
| P1 | V-B6 distributionShift 常数列 | tsf.ts:1051 | 20 分钟 |
| P1 | V-B7 seedBaselines 错误处理 | service.ts:2693 | 1 小时 |
| P2 | V-B8 报告无事务快照 | service.ts:2937 | 1-2 小时 |
| P2 | V-B9 profileTrend 时间轴 | tsf.ts:1009 | 1 小时 |
| P2 | V-B10 inconclusive 候选追踪 | service.ts:549 | 1 小时 |

合计 ~6-8 小时即可修完所有，建议在补 Vibe DS 阶段 2/3/8c 缺口（见 `vibe_data_science_alignment_review.md`）之前先完成 P0/P1。
