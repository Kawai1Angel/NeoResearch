# NeoResearch 外生变量端到端实验支持修改方案

日期：2026-06-29  
状态：提案  
范围：NeoResearch TUI、Intent Agent、TSF TaskSpec、Neo-Cast 数据契约、训练、评估与导出

## 1. 背景

当前用户可以在 NeoResearch TUI 中表达“使用全部外生变量”，Intent Agent 也可以把该信息记录到 `exogenous_variables`。但是，这个意图尚未形成完整的实验执行链路：

- `exogenous_variables` 主要保存在 intent metadata 中，没有稳定同步到 TSF dataset role 字段。
- Neo-Cast 数据准备命令目前主要根据 `targetCols` 构造 `--feature-cols`。
- `dataset.v1` 只有统一的 `feature_columns`，不能区分目标变量和外生变量。
- 当前窗口生成器从同一特征矩阵生成 `x` 和 `y`，加入外生列后会同时预测这些外生列。
- 模型、loss 和指标没有 target-only 输出契约。

因此，系统可能在需求确认、hypothesis 或 recipe 文本中声称使用了外生变量，但实际训练张量仍然只包含目标变量。

## 2. 目标行为

用户在 TUI 中输入：

```text
使用全部外生变量
```

系统应读取数据表头，将时间列和目标列以外的可用数值列展开为明确的外生变量集合。按照本方案要求，同一组外生变量同时承担以下两个角色：

- `observedPastCovariates`：模型可以看到预测起点之前的历史值。
- `knownFutureCovariates`：模型可以看到预测区间内的未来值。

模型只预测 `targetCols`，不预测外生变量。

以 `windy_power_full.csv` 为例，确认后的任务配置应等价于：

```json
{
  "targetCols": ["real_power"],
  "observedPastCovariates": [
    "direct_radiation",
    "wind_direction_80m",
    "wind_speed_80m",
    "temperature_2m",
    "relative_humidity_2m",
    "precipitation"
  ],
  "knownFutureCovariates": [
    "direct_radiation",
    "wind_direction_80m",
    "wind_speed_80m",
    "temperature_2m",
    "relative_humidity_2m",
    "precipitation"
  ],
  "staticCovariates": []
}
```

对应训练张量：

```text
target_history:   [batch, lookback, 1]
exogenous_past:   [batch, lookback, 6]
exogenous_future: [batch, horizon, 6]
target:           [batch, horizon, 1]
prediction:       [batch, horizon, 1]
```

## 3. 设计原则

1. 角色显式：目标、历史外生变量、未来已知外生变量必须分别声明。
2. 目标独立：模型输出、loss、metric 和反归一化只作用于目标列。
3. 重叠合法：同一列允许同时出现在 `observedPastCovariates` 和 `knownFutureCovariates`。
4. 历史去重：同时属于两个角色的列在历史输入中只出现一次。
5. 未来受控：只有 `knownFutureCovariates` 可以读取预测区间的数据。
6. 防止泄漏：未来实测值只有在真实预测时确实可获得时，才能声明为 known future。
7. 产物可审计：每次实验必须记录实际使用的列名和张量通道数。
8. 向后兼容：已有无外生变量任务和 `dataset.v1` 产物应继续可运行。

## 4. TUI 与 Intent Agent 修改

### 4.1 “全部外生变量”的确定性展开

TUI 不应把字符串 `"全部"` 或 `"all"` 直接保存为列名。Intent Agent 应读取 CSV schema，并按以下规则展开：

```text
all_covariates = numeric_columns
                 - timestamp_columns
                 - target_columns
                 - ignored_columns
```

展开结果必须是具体列名数组。

### 4.2 Intent slot 到 TSF TaskSpec 的映射

修改 `opencode/packages/opencode/src/research/taskspec-store.ts`：

- 保留 `metadata.intentSlots.exogenous_variables`，用于展示原始用户意图。
- 将展开后的列名同步到：
  - `taskSpec.dataset.observedPastCovariates`
  - `taskSpec.dataset.knownFutureCovariates`
- 不再只把外生变量保存在 metadata。

建议把原始意图和解析结果分开保存：

```json
{
  "metadata": {
    "intentSlots": {
      "exogenous_variables": ["all"]
    },
    "resolvedCovariates": {
      "policy": "all_non_target_numeric_columns",
      "columns": ["direct_radiation", "wind_speed_80m"],
      "resolvedAt": "2026-06-29T00:00:00Z"
    }
  }
}
```

### 4.3 Intent checkpoint

用户批准 Intent checkpoint 前，TUI 必须展示：

- 目标列。
- 历史外生列的具体名称。
- 未来已知外生列的具体名称。
- 外生变量数量。
- “未来值在真实推理时是否可获得”的风险提示。

如果未来可用性没有得到确认，checkpoint 应保持 pending，不能静默把未来实测值作为模型输入。

## 5. TSF TaskSpec 与数据契约修改

### 5.1 复用 TSF TaskSpec 角色字段

`opencode/packages/opencode/src/research/domains/tsf.ts` 已定义：

```text
targetCols
knownFutureCovariates
observedPastCovariates
staticCovariates
```

本方案不再引入平行字段，而是把这些字段作为跨 TUI、Data Analysis、HypoPlanner、TrainEval 的唯一规范来源。

### 5.2 新增 Neo-Cast dataset.v2

建议将 Neo-Cast 数据契约升级为 `dataset.v2`：

```json
{
  "schema_version": "dataset.v2",
  "task_id": "wind_power",
  "timestamp_col": "date",
  "target_columns": ["real_power"],
  "observed_past_covariates": [
    "direct_radiation",
    "wind_direction_80m",
    "wind_speed_80m",
    "temperature_2m",
    "relative_humidity_2m",
    "precipitation"
  ],
  "known_future_covariates": [
    "direct_radiation",
    "wind_direction_80m",
    "wind_speed_80m",
    "temperature_2m",
    "relative_humidity_2m",
    "precipitation"
  ],
  "static_covariates": [],
  "input_len": 336,
  "horizons": [96],
  "splits": {
    "train": [0, 16867],
    "val": [16867, 19277],
    "ref_test": [19277, 24096]
  },
  "normalization": {
    "type": "standard",
    "fit_split": "train"
  }
}
```

约束：

- `target_columns` 非空且唯一。
- target 不得出现在任何 covariate 集合中。
- observed 和 known future 之间允许重叠。
- 所有动态列必须存在于 CSV 中且为可转换的数值列。
- 时间列不得出现在动态列集合中。

### 5.3 CLI 参数

Neo-Cast `prepare-data` 增加：

```text
--target-cols
--observed-past-covariates
--known-future-covariates
--static-covariates
```

示例：

```bash
node ./bin/neo-cast.js prepare-data \
  --source /path/to/windy_power_full.csv \
  --target-cols real_power \
  --observed-past-covariates direct_radiation,wind_direction_80m,wind_speed_80m,temperature_2m,relative_humidity_2m,precipitation \
  --known-future-covariates direct_radiation,wind_direction_80m,wind_speed_80m,temperature_2m,relative_humidity_2m,precipitation
```

原 `--feature-cols` 保留用于 `dataset.v1` 兼容，但新任务不应再用它表达 target/covariate 角色。

### 5.4 NeoResearch 数据准备命令

修改 `opencode/packages/opencode/src/research/service.ts`：

- `tsfDatasetPreparationConfig()` 返回四类角色字段。
- `buildPrepareDatasetCommand()` 分别传递新 CLI 参数。
- 在执行前根据 CSV header 验证列存在性。
- 在数据准备 artifact 中记录原始角色配置和最终生效配置。

## 6. 数据物化与归一化

物化 CSV 应保留以下列的并集：

```text
timestamp
+ target_columns
+ observed_past_covariates
+ known_future_covariates
+ static_covariates
```

同一列在 observed 和 known future 中重叠时，物化文件只保存一份。

归一化器必须只在 train split 上拟合。建议分别维护：

- `target_scaler`
- `dynamic_covariate_scaler`
- 可选的 `static_covariate_encoder`

这样可以保证输出反归一化只依赖 target scaler，不会受输入通道顺序影响。

预处理产物至少记录：

```json
{
  "schema_version": "preprocess.v2",
  "target_names": ["real_power"],
  "observed_past_covariate_names": ["..."],
  "known_future_covariate_names": ["..."],
  "target_scaler": {},
  "covariate_scaler": {}
}
```

## 7. WindowDataset 与 batch 契约

`WindowDataset.__getitem__()` 不再返回 `(x, y)`，而应返回结构化 batch：

```python
{
    "target_history": target_values[start:context_end],
    "exogenous_past": past_covariates[start:context_end],
    "exogenous_future": future_covariates[context_end:target_end],
    "target": target_values[context_end:target_end],
}
```

形状约束：

```text
target_history   = [lookback, num_targets]
exogenous_past   = [lookback, num_past_covariates]
exogenous_future = [horizon, num_future_covariates]
target           = [horizon, num_targets]
```

历史外生列定义为：

```text
past_covariate_columns = stable_unique(
    observed_past_covariates + known_future_covariates
)
```

因此，同一列同时出现在两个集合时：

- 在 `exogenous_past` 中只出现一次。
- 在 `exogenous_future` 中出现一次。
- 不会产生重复历史通道。

## 8. 模型接口与融合结构

### 8.1 模型 forward 契约

统一模型接口：

```python
prediction = model(
    target_history=batch["target_history"],
    exogenous_past=batch["exogenous_past"],
    exogenous_future=batch["exogenous_future"],
)
```

输出必须满足：

```python
prediction.shape == batch["target"].shape
```

### 8.2 推荐模型包装层

为避免一次性重写所有现有 backbone，建议新增 `CovariateConditionedForecaster` 包装层：

```text
target_history + exogenous_past
                |
                v
       historical input projection
                |
                v
        existing recipe backbone
                |
                v
      historical forecast features
                |
                +---- exogenous_future encoder
                |                |
                +-------+--------+
                        v
              gated/concat fusion
                        |
                        v
                target-only head
                        |
                        v
             [batch, horizon, targets]
```

建议新增运行时配置：

```json
{
  "num_target_channels": 1,
  "num_past_covariate_channels": 6,
  "num_future_covariate_channels": 6,
  "covariate_fusion": "gated"
}
```

`covariate_fusion` 初始支持：

- `concat`：直接拼接后线性映射，作为可靠 baseline。
- `gated`：学习未来外生特征对各 horizon 的条件修正。
- `none`：消融实验使用。

### 8.3 输出约束

无论输入通道多少，prediction head 的输出通道数必须等于 `num_target_channels`。禁止通过截取“最后一个 feature channel”的隐式方式选择目标。

## 9. 训练与评估修改

训练循环应改为：

```python
prediction = model(
    target_history=batch["target_history"],
    exogenous_past=batch["exogenous_past"],
    exogenous_future=batch["exogenous_future"],
)
loss = loss_fn(prediction, batch["target"])
```

评估要求：

- MSE、MAE、pinball、CRPS 等指标只计算 target。
- inverse transform 只使用 target scaler。
- ref-test 和 blind-test 必须使用相同的列角色与顺序。
- 缺少任一 required future covariate 时，推理必须失败并给出列名，不能静默填零。

## 10. 数据泄漏约束

本方案允许模型读取预测区间内的外生变量，因此必须明确其可用性语义。

合法示例：

- 日历、节假日、计划价格等天然已知的未来变量。
- 在预测时可通过独立天气预报系统获得的天气预测值。

高风险示例：

- 直接把离线数据集中的未来实测天气值作为线上可用值。
- 使用预测区间结束后才能确定的事件、价格或统计量。

建议 dataset contract 增加来源说明：

```json
{
  "known_future_availability": {
    "source": "weather_forecast",
    "available_at_prediction_time": true,
    "verified_by": "user",
    "verified_at": "2026-06-29T00:00:00Z"
  }
}
```

若使用未来实测值进行上界实验，必须标记：

```json
{
  "experiment_scope": "oracle_covariate_upper_bound",
  "production_comparable": false
}
```

## 11. 实验产物与可审计性

每次 run 的 `metadata.json` 和 `preprocess.json` 必须包含：

```json
{
  "target_columns": ["real_power"],
  "used_observed_past_covariates": ["..."],
  "used_known_future_covariates": ["..."],
  "target_channels": 1,
  "past_exogenous_channels": 6,
  "future_exogenous_channels": 6,
  "model_input_channels": 7,
  "model_output_channels": 1,
  "covariate_fusion": "gated"
}
```

同时记录首个 batch 的 shape summary，但不保存原始敏感数据。

最终报告必须区分：

- target-only baseline。
- target + past exogenous。
- target + past/future exogenous。
- 是否为 oracle future covariate 实验。

## 12. 向后兼容策略

### 12.1 dataset.v1

读取旧 `dataset.v1` 时保持原行为：

```text
target_columns = feature_columns
observed_past_covariates = []
known_future_covariates = []
```

不得猜测旧 `feature_columns` 中哪些是外生变量。

### 12.2 无外生变量模型

当两个 covariate 集合均为空时：

- dataloader 返回 shape 中通道数为 0 的 covariate tensor，或由兼容 adapter 转换为旧 `(x, y)`。
- `CovariateConditionedForecaster` 退化为原模型。
- 旧 recipe 无需增加强制字段。

## 13. 测试计划

### 13.1 TUI 与 Intent

- 输入“使用全部外生变量”后展开为实际 CSV 列名。
- 时间列和目标列不会被选为外生变量。
- 展开后的列同时写入 observed 和 known future。
- checkpoint 展示完整列名及未来可用性警告。
- CSV schema 变化后要求重新确认，而不是复用旧展开结果。

### 13.2 数据契约

- target 与 covariate 重叠时验证失败。
- observed 与 known future 重叠时验证成功。
- 缺失列、重复列、非数值列给出明确错误。
- `dataset.v1` 兼容测试继续通过。

### 13.3 窗口与防泄漏

- `exogenous_past` 只覆盖 `[start, context_end)`。
- `exogenous_future` 只覆盖 `[context_end, target_end)`。
- 重叠角色不会产生重复历史通道。
- scaler 只在 train split 上拟合。
- validation 不会访问 ref-test 数据。

### 13.4 模型与训练

- 输入 1 个 target、6 个 past covariate、6 个 future covariate时，输出仍为 1 个 target。
- `concat`、`gated`、`none` 三种融合模式 forward shape 正确。
- loss 与 metric 只使用 target。
- checkpoint 保存和加载后预测一致。
- export/inference 缺少 future covariate 时明确失败。

### 13.5 端到端实验

至少运行以下固定 seed 对照：

1. 仅 target。
2. target + past exogenous。
3. target + past/future exogenous。

三组实验必须使用相同 split、lookback、horizon、模型预算和训练 seed。

## 14. 验收标准

功能验收：

- TUI 中“使用全部外生变量”被展开为具体列名。
- 这些列同时进入 `observedPastCovariates` 和 `knownFutureCovariates`。
- prepared dataset 同时保留目标与外生列。
- batch 中存在 past 和 future 两类外生张量。
- 模型输出只包含目标变量。

运行验收：

```text
target_channels=1
past_exogenous_channels=6
future_exogenous_channels=6
model_output_channels=1
```

可信度验收：

- 实验产物能证明列名和 tensor shape。
- loss、metric、inverse transform 均只针对 target。
- 未来外生变量来源和预测时可用性已记录。
- 报告明确区分真实可部署实验和 oracle upper-bound 实验。

## 15. 推荐实施顺序

### 阶段一：契约与 TUI

- 完成“全部”列解析。
- 完成 intent slot 到 TSF TaskSpec 的同步。
- 引入 `dataset.v2` schema 和 CLI 参数。

### 阶段二：数据与训练

- 重构 WindowDataset batch。
- 实现独立 target/covariate scaler。
- 实现 target-only loss 和 metric。

### 阶段三：模型与导出

- 实现 `CovariateConditionedForecaster`。
- 支持 past/future covariate fusion。
- 更新 checkpoint、export 和 inference schema。

### 阶段四：审计与消融

- 输出 covariate usage metadata。
- 增加数据泄漏校验。
- 完成三组固定条件消融实验。

## 16. 非目标

- 本方案不负责生成未来天气预报；它只消费任务声明为预测时可用的未来外生变量。
- 本方案不自动证明未来变量在线上一定可获得；必须由数据来源声明和 checkpoint 确认。
- 第一阶段不要求支持复杂静态类别特征 embedding，可先保留接口。
- 不以“把所有列都当成预测目标”的方式伪装外生变量支持。
