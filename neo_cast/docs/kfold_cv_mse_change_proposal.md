# 基于比例时间序列 K-Fold 的 MSE 优化指标修改方案

## 1. 背景与目标

当前 NeoCast 使用 `val_avg_mse` 作为候选模型的 keep/discard 主指标。该指标是在固定 validation split 上，对配置的多个预测 horizon 的 MSE 取平均：

```text
val_avg_mse = mean(val_h{H}_mse for H in horizons)
```

本方案将候选优化指标改为基于时间顺序的 K-Fold 验证指标 `cv_avg_mse`，同时满足以下约束：

- 不复用或覆盖 `val_avg_mse`；两个指标语义保持独立。
- 不使用随机 K-Fold，避免未来数据泄漏。
- fold 按数据集可见区间长度的比例划分，以适配长度不同的数据集。
- `cv_avg_mse` 只负责候选排序和 keep/discard。
- 最终保存的 checkpoint 仍由原始 train split 训练，并用原始 val split 做 early stopping 和验证。
- `ref_test` 不参与 fold 构造、归一化、训练、early stopping 或候选选择。
- 尽量复用现有 `train.py`、`WindowDataset`、评估函数和 artifact 协议，控制修改范围。

## 2. 非目标

第一版不处理以下能力：

- 随机 K-Fold 或打乱时间点的交叉验证。
- Sliding-window CV、fold 并行和多 seed × 多 fold。
- 将 fold 模型组成 ensemble。
- 使用 `cv_std_mse` 改写主目标，例如 `mean + lambda * std`。
- 自动把不满足要求的数据集静默降级为更少 folds。
- 使用某个 fold 的 checkpoint 作为最终 checkpoint。

## 3. 最终执行协议

每个候选的正式执行顺序为：

```text
smoke test
    │
    ├── 失败：crash，停止
    │
    └── 成功
          │
          ▼
比例 expanding-window K-Fold
    │
    ├── 任一 fold 失败：crash，停止
    │
    └── 全部成功：生成 cv_metrics.json
          │
          ▼
原始 train split 训练 + 原始 val split 验证
    │
    ├── 生成 val_metrics.json
    ├── 保存正式 checkpoint
    └── 生成标准 training_summary.json
          │
          ▼
Runner 使用 cv_avg_mse 执行 keep/discard
```

采用先 CV、后标准训练的顺序，是为了避免 CV 已失败的候选继续消耗一次标准训练预算。标准训练必须在不带 fold override 的独立子进程中运行，确保 checkpoint 和 scaler 均来自原始 train/val 协议。

## 4. 指标定义

### 4.1 标准验证指标

`val_avg_mse` 保持现有定义和产出路径：

```text
val_avg_mse = mean_H(val_hH_mse)
```

它描述最终 checkpoint 在原始 val split 上的表现，不参与新版 keep/discard。

### 4.2 Fold 内指标

每个 fold 继续复用现有验证逻辑，产生：

```text
fold_i_hH_mse
fold_i_avg_mse = mean_H(fold_i_hH_mse)
```

子进程内部仍可输出 `val_avg_mse`，因为对该子进程而言，它确实是在当前 fold 的 validation split 上评估；父级聚合时必须将其映射成 fold 明细，不能将它写入父 artifact 的标准 `val_metrics.json`。

### 4.3 CV 聚合指标

```text
cv_avg_mse = mean_i(fold_i_avg_mse)
cv_std_mse = population_std_i(fold_i_avg_mse)
cv_hH_mse = mean_i(fold_i_hH_mse)
```

第一版使用 fold 宏平均，使每个时间区间具有相同权重。所有 fold 的验证比例相同，仅可能因行边界取整相差一行。

候选决策规则为：

```python
improved = best_cv_avg_mse is None or cv_avg_mse < best_cv_avg_mse
```

`cv_std_mse` 仅用于诊断和反思，不参与排序。

## 5. 按比例生成 Fold

### 5.1 可见区间

CV 只使用原始 train 和 val 的联合区间：

```python
cv_start = BORDER_TRAIN[0]
cv_end = BORDER_VAL[1]
visible_rows = (cv_start, cv_end)
```

必须满足：

```text
cv_end <= BORDER_TEST[0]
```

### 5.2 默认配置

```json
{
  "strategy": "expanding_window_ratio",
  "num_folds": 4,
  "initial_train_ratio": 0.6,
  "min_train_windows": 1,
  "min_eval_windows": 1
}
```

每个 fold 的验证比例自动计算：

```text
fold_val_ratio = (1 - initial_train_ratio) / num_folds
```

默认配置对应：

```text
Fold 0: train 0%–60%, val 60%–70%
Fold 1: train 0%–70%, val 70%–80%
Fold 2: train 0%–80%, val 80%–90%
Fold 3: train 0%–90%, val 90%–100%
```

这里的百分比均相对于 `train + val` 可见区间，而不是完整数据集。

### 5.3 行边界算法

为了避免不同数据长度和逐段取整造成的累计误差，直接计算每个比例分界点，并将最后一个 fold 的 `val_end` 强制设为 `visible_end`：

```python
def build_ratio_folds(
    visible_rows: tuple[int, int],
    *,
    num_folds: int,
    initial_train_ratio: float,
) -> list[TimeSeriesFold]:
    visible_start, visible_end = visible_rows
    visible_length = visible_end - visible_start
    fold_val_ratio = (1.0 - initial_train_ratio) / num_folds
    folds = []

    for fold_index in range(num_folds):
        train_end_ratio = initial_train_ratio + fold_index * fold_val_ratio
        val_end_ratio = initial_train_ratio + (fold_index + 1) * fold_val_ratio

        train_end = visible_start + round(visible_length * train_end_ratio)
        val_start = train_end
        val_end = (
            visible_end
            if fold_index == num_folds - 1
            else visible_start + round(visible_length * val_end_ratio)
        )

        folds.append(
            TimeSeriesFold(
                fold_index=fold_index,
                train_rows=(visible_start, train_end),
                val_rows=(val_start, val_end),
            )
        )

    return folds
```

要求：

- `num_folds >= 2`。
- `0 < initial_train_ratio < 1`。
- train 区间随 fold 单调扩张。
- val 区间按时间连续、互不重叠。
- 最后一个 val 的结束位置严格等于 `visible_end`。

### 5.4 窗口有效性

验证集可以使用训练尾部作为 lookback，但预测目标必须完全位于 fold val 区间。因此：

```text
required_train_length = input_len + max_horizon + min_train_windows - 1
required_val_length = max_horizon + min_eval_windows - 1
```

所有 fold 在启动训练前统一校验。如果任何 fold 不满足要求，应给出包含数据长度、fold 边界和最低要求的明确错误，不允许静默减少 folds。

## 6. 最小侵入实现

### 6.1 新增 `py/cv_train.py`

该文件作为现有 `train.py` 的编排包装器，负责：

1. 从原始 task spec 读取可见区间。
2. 按比例生成并校验 folds。
3. 为每个 fold 启动独立的 `train.py` 子进程。
4. 解析每个子进程的 `eval_done` 和 artifact 事件。
5. 聚合并写入 `cv_metrics.json`。
6. 在不设置 split override 的环境中运行一次标准 `train.py`。
7. 将 `cv_metrics.json` 附加到标准训练产生的 artifact。
8. 对 Runner 输出同时包含 `val_*` 与 `cv_*` 的统一事件。

使用独立子进程可以复用当前模块级 `BORDER_TRAIN`、`BORDER_VAL` 和 `_VISIBLE_BUNDLE`，同时保证不同 fold 的 scaler、模型、optimizer、scheduler 和 early-stopping 状态互相隔离。

### 6.2 `prepare_tsf.py` 增加受控 split override

仅 CV 子进程设置：

```text
NEO_CAST_TRAIN_ROWS=0:6000
NEO_CAST_VAL_ROWS=6000:7000
NEO_CAST_CV_FOLD_INDEX=0
```

`prepare_tsf.py` 增加严格解析与校验：

- train 和 val override 必须同时提供。
- 只允许在原始 `train + val` 可见区间内覆盖。
- 不允许触及 `ref_test`。
- `train_end <= val_start`。
- 范围必须为整数且非空。

标准训练前必须显式从子进程环境中移除这些变量，确保正式 checkpoint 使用原始 split。

### 6.3 Runner 修改

正式训练入口在启用 CV 时从 `train.py` 切换到 `cv_train.py`，smoke 仍使用原 `train.py`。

`RunnerState` 增加：

```python
best_cv_avg_mse: float | None = None
```

标准训练完成后分别读取：

```python
val_avg_mse = float(val_metrics["val_avg_mse"])
cv_avg_mse = float(cv_metrics["cv_avg_mse"])
```

keep/discard 只比较 `cv_avg_mse`。旧 session 没有 `best_cv_avg_mse` 时可以读取，但启用 CV 后应开始新 session，避免旧 `val_avg_mse` champion 与 CV champion 混用。

### 6.4 Results 与展示

`results.tsv` 增加：

```text
cv_avg_mse
cv_std_mse
```

保留 `val_avg_mse`。`is_best` 根据 `cv_avg_mse` 计算。

Node 会话、companion 输出、reflection 和 LLM 上下文应同时显示：

- `cv_avg_mse`：主指标。
- `cv_std_mse`：跨时间段稳定性。
- `val_avg_mse`：正式 checkpoint 的标准 split 指标。
- fold 明细：用于分析时间漂移。

Mutation 中原本依赖 `val_avg_mse` 的阈值判断应迁移到 `cv_avg_mse`，但字段名和状态字段不能通过别名兼容。

## 7. Artifact 协议

最终 artifact 以标准 train/val 训练结果为主体：

```text
artifacts/run_<run_id>/
├── model.pt                 # 原始 train split 训练的正式 checkpoint
├── candidate.json
├── preprocess.json          # 原始 train split 拟合的 scaler/预处理信息
├── training_summary.json    # 标准训练摘要
├── val_metrics.json         # 原始 val split 指标
└── cv_metrics.json          # K-Fold 聚合及明细
```

临时 fold artifact 不进入最终 checkpoint 集合。成功后只复制指标和必要日志；fold checkpoint 可由临时 artifact 生命周期清理。失败时保留足够的 fold 索引、命令退出码和日志位置用于排查。

`cv_metrics.json` 建议格式：

```json
{
  "schema_version": "cv_metrics.v1",
  "protocol": {
    "strategy": "expanding_window_ratio",
    "protocol_id": "expanding_window_ratio_k4_train60_v1",
    "num_folds": 4,
    "initial_train_ratio": 0.6,
    "fold_val_ratio": 0.1,
    "visible_rows": [0, 10000],
    "input_len": 336,
    "horizons": [96, 192, 336, 720]
  },
  "cv_avg_mse": 0.4478,
  "cv_std_mse": 0.0131,
  "cv_avg_mae": 0.5012,
  "cv_h96_mse": 0.3914,
  "cv_h192_mse": 0.4218,
  "cv_h336_mse": 0.4582,
  "cv_h720_mse": 0.5198,
  "folds": [
    {
      "fold_index": 0,
      "train_rows": [0, 6000],
      "val_rows": [6000, 7000],
      "val_avg_mse": 0.4612
    }
  ]
}
```

`protocol_id` 必须由所有影响可比性的配置确定，包括 strategy、fold 数、初始训练比例、horizons、input length 和窗口规则。Runner 不应直接比较 protocol 不同的候选。

## 8. 错误处理

以下任一情况使整个候选 CV 失败：

- fold 边界非法或窗口不足。
- 任一 fold 子进程退出码非零。
- 任一 fold 缺少 `eval_done` 或 artifact 事件。
- 任一必要指标缺失、为 NaN 或 Inf。
- 实际完成 fold 数与配置不一致。
- fold 使用范围触及 ref-test。
- 标准 train/val 训练失败。

不能丢弃失败 fold 后对剩余 fold 求平均，否则困难时间区间失败的候选可能得到虚假的更优分数。

## 9. 文件级修改清单

### 必需修改

- `py/cv_train.py`
  - 新增比例 fold 生成、校验、子进程调度、聚合和标准训练编排。
- `py/prepare_tsf.py`
  - 增加受控的 train/val 边界 override。
- `py/runner.py`
  - 读取 `cv_avg_mse`，新增 state 字段并切换 keep/discard。
- `py/search/mutate.py`
  - 将指标驱动的 mutation 从 `val_avg_mse` 切换到 `cv_avg_mse`。
- `src/session.js`
  - 按 `cv_avg_mse` 推导 session champion。
- `src/loop.js`、`src/output.js`、`src/reflect.js`、`src/llm.js`
  - 展示和描述独立 CV 指标。
- `py/schemas/metadata_schema.json`
  - 增加严格的 CV metrics 元数据结构。

### 测试与文档

- `py/tests/test_cv_train.py`
- 与 `prepare_tsf` split/scaler 相关的现有测试模块。
- `py/tests/test_runner_curves.py` 或新的 runner CV 测试。
- Node session、loop、output 相关测试。
- README、使用说明和架构文档中的主指标描述。

## 10. 测试计划

### 10.1 Fold 生成

- 10,000 行、12,347 行等不同长度的比例边界正确。
- 最后一个 val 精确结束于可见区间末尾。
- train 单调扩张，val 连续且不重叠。
- 非法比例、fold 数和不足窗口得到明确错误。
- 任何 fold 都不触及 ref-test。

### 10.2 数据泄漏

构造 train 与 val 分布明显不同的数据，确认每个 fold 的 scaler 只拟合该 fold train。

确认验证样本可使用 train 尾部作为 lookback，但所有预测 target 均落在 fold val 内。

### 10.3 训练隔离

- 每个 fold 使用全新模型、optimizer、scheduler 和 early-stopping 状态。
- 相同 seed 规则可复现。
- 标准训练进程没有 fold override。
- 最终 `model.pt` 与 `preprocess.json` 来自标准 train/val 运行，而非最后一个 fold。

### 10.4 指标聚合

- `cv_avg_mse`、`cv_std_mse` 和各 horizon 平均计算正确。
- 父级 `val_metrics.json` 未被 fold 指标覆盖。
- NaN、Inf、缺失指标或 fold 失败导致整体失败。

### 10.5 Runner 与兼容性

- `cv_avg_mse` 更低时 keep，更高或相同时 discard。
- `val_avg_mse` 更低但 `cv_avg_mse` 更高时仍 discard。
- 不同 `protocol_id` 不直接比较。
- 旧 state 可被读取，但启用 CV 后不会把旧 val champion 当作 CV champion。
- smoke 行为和原有标准训练 artifact 契约保持兼容。

完整修改后运行：

```bash
cd neo_cast
npm test
node ./bin/neo-cast.js validate recipe py/schemas/recipe_native.example.json
```

## 11. 实施步骤

### 步骤一：CV 执行器与数据边界

实现纯函数 fold 生成与校验、split override 和 `cv_train.py` 子进程编排。此时先生成 `cv_metrics.json`，但不切换 Runner 主指标。

验收重点：fold 比例正确、无泄漏、标准 checkpoint 来源正确。

### 步骤二：主指标切换

增加 Runner state/results 字段，将 keep/discard、session champion 和 mutation 切换到 `cv_avg_mse`。保留 `val_avg_mse` 作为标准 checkpoint 的诊断指标。

验收重点：构造 `val_avg_mse` 与 `cv_avg_mse` 排名相反的测试，确认系统严格按 CV 决策。

### 步骤三：Schema、输出与文档收口

补齐 metadata schema、export、LLM prompt、reflection、CLI 展示和使用文档，冻结 `cv_metrics.v1` 与 `protocol_id` 口径。

验收重点：Python、Node、artifact 和文档对两个指标的语义完全一致。

## 12. 性能与后续优化

该方案每个候选需要约 `K + 1` 次正式训练；默认 K=4 时约为 5 次。第一版优先保证协议正确。

如果成本不可接受，后续可以增加两阶段评估：

```text
screening：最近一个 fold，小预算，不具备 champion 资格
full_cv：完整 K folds，具备 champion 资格
standard：原始 train/val，生成正式 checkpoint
```

所有进入 champion 比较的候选仍必须完成相同的 full-CV protocol，不能将 screening 指标与 `cv_avg_mse` 混合比较。

## 13. 建议默认决策

- CV 类型：expanding-window。
- folds：4。
- 初始训练比例：60%。
- 每 fold 验证比例：自动均分剩余 40%。
- gap：0；未来如任务存在标签发布延迟，再增加 gap 配置。
- fold seed：使用 candidate 的相同基础 seed，不使用 `seed + fold_index`。
- 聚合：fold 宏平均。
- 方差：总体标准差，仅报告。
- 小数据集：启动前失败，不静默改变协议。
- checkpoint：始终保存原始 train/val 标准训练结果。
- champion：只按 `cv_avg_mse` 决定。

