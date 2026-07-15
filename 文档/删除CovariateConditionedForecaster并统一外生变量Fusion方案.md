# 删除 CovariateConditionedForecaster 并统一外生变量 Fusion 方案

## 背景

当前 Neo-Cast 存在两套并行的通道与外生变量处理语义。

第一套是原生 recipe/factory fusion 系统：

```json
{
  "fusion": {
    "type": "temporal",
    "channel_mode": "independent"
  }
}
```

该系统已经在 `neo_cast/py/factory/build_model.py` 中真实生效：

- `temporal + independent`：不做 channel mixing，各 channel 独立走 temporal backbone。
- `temporal + shared`：输入前做 `ChannelMixer`。
- `feature`、`graph`、`gated_hybrid`、`temporal_then_feature`：使用对应 channel mixer。

第二套是外生变量 wrapper 系统。当前 `dataset.v2` 路径会额外包一层：

```python
CovariateConditionedForecaster(backbone, ...)
```

它负责拼接 `target_history + exogenous_past`，调用 backbone，将 backbone 输出投影回 target channels，并处理 `future covariates` 的 `concat/gated/none` 语义。

这导致外生变量支持没有真正并入 recipe fusion 系统，且 `covariate_fusion` 与 `fusion.channel_mode` 两套概念并存。

## 目标

删除 `CovariateConditionedForecaster` wrapper，将外生变量支持合并进现有 fusion 系统。

目标语义：

```text
target channels
+ observed past covariate channels
+ known future covariate channels
=> 由 recipe fusion/model builder 统一解释
```

保留现有高层 recipe 语义：

```json
{
  "fusion": {
    "type": "temporal",
    "channel_mode": "independent"
  }
}
```

不再引入独立的 `covariate_fusion` 体系。

## 设计原则

1. `fusion` 是唯一的通道融合入口。
2. `channel_mode=independent/shared` 继续表达 channel interaction 强度。
3. observed-past covariates 作为 history-side channels 进入模型。
4. known-future covariates 作为 horizon-side conditioning 信息进入模型，不能简单塞进历史序列。
5. 模型输出始终只预测 target channels，不预测 covariate channels。
6. 新 artifact 不再依赖 `covariate_model.py`。
7. 旧 artifact 可短期兼容，但新训练路径不再生成 wrapper checkpoint。

## 当前需要调整的主要位置

### Python 训练路径

文件：

```text
neo_cast/py/train.py
```

当前逻辑：

```python
if ACTIVE_SPEC.schema_version == "dataset.v1":
    return family_module.build_model(...)
historical_channels = NUM_CHANNELS + len(PAST_COVARIATE_COLUMNS)
model_config["num_channels"] = historical_channels
backbone = family_module.build_model(...)
return CovariateConditionedForecaster(...)
```

修改方向：

- 删除 `CovariateConditionedForecaster` 构造。
- `dataset.v2` 也直接 build 原生模型。
- `model_config` 增加明确的 channel role metadata：

```python
model_config["num_target_channels"] = NUM_CHANNELS
model_config["num_past_covariate_channels"] = len(PAST_COVARIATE_COLUMNS)
model_config["num_future_covariate_channels"] = len(KNOWN_FUTURE_COVARIATES)
model_config["num_input_channels"] = NUM_CHANNELS + len(PAST_COVARIATE_COLUMNS)
model_config["num_output_channels"] = NUM_CHANNELS
model_config["num_channels"] = model_config["num_input_channels"]
```

### Python recipe factory

文件：

```text
neo_cast/py/factory/build_model.py
```

当前 `RecipeModel.forward(x)` 只接受单个 tensor：

```python
x: [batch, input_len, channels]
```

需要扩展为兼容两类输入：

```python
model(x)
```

以及：

```python
model(
    target_history=...,
    exogenous_past=...,
    exogenous_future=...,
)
```

建议内部统一到一个结构：

```python
history = concat([target_history, exogenous_past], dim=-1)
future = exogenous_future
```

然后进入统一 forward pipeline。

### 输出 channel 裁剪或投影

当前原生 factory 会输出与输入 channel 数一致的预测：

```text
input channels -> output channels
```

但外生变量场景需要：

```text
target + past covariates -> target only
```

需要在 `RecipeModel` 中增加 output role projection：

```python
if num_output_channels < model_output_channels:
    y = y[..., :num_output_channels]
```

或者更明确地使用 `target_output_head`：

```python
self.target_output_head = nn.Linear(model_channels, num_output_channels)
```

第一阶段建议优先使用简单裁剪：

```python
target_forecast = forecast[..., :num_target_channels]
```

原因：

- 与当前 `target_history` 位于前 N 个 channel 的 dataset.v2 约定一致。
- 不引入额外参数，减少 checkpoint 迁移复杂度。
- 后续可再升级为 learnable target projection。

## Known future covariates 语义

这是删除 wrapper 时最需要明确的部分。

当前 wrapper 的 future covariates 实际支持较弱：

- `concat` 时拼到 forecast horizon 再线性投影。
- `gated` 当前没有真正启用 `future_correction` / `future_gate`。
- `none` 等价于忽略 future covariates。

建议将 future covariates 并入 fusion 系统，分阶段实现。

### 阶段 A：兼容删除 wrapper

先支持：

```text
known_future_covariates ignored unless fusion explicitly supports future conditioning
```

即：

- 保留输入校验。
- 允许 `exogenous_future` 存在。
- 默认 `temporal/independent` 不使用 future covariates。
- metadata 记录 future covariates 数量。
- 不再创建 wrapper。

这与当前 `gated` wrapper 的实际行为接近，因为 `future_gate` / `future_correction` 当前为 `None`。

### 阶段 B：新增 future conditioning fusion

扩展 fusion schema，例如：

```json
{
  "type": "temporal",
  "channel_mode": "independent",
  "future_covariate_mode": "none"
}
```

可选值：

```text
none
concat_head
gated_residual
cross_attention
```

第一版建议只实现：

```text
none
concat_head
```

其中 `concat_head` 行为等价于旧 wrapper 的 `concat`：

```python
forecast = target_or_history_forecast
future = exogenous_future
output = Linear(concat([forecast, future], dim=-1))
```

## Recipe schema 调整

可能涉及文件：

```text
neo_cast/py/schemas/recipe_schema.json
neo_cast/py/registry/action_specs.py
opencode/packages/opencode/src/research/domains/tsf.ts
```

第一阶段建议不扩大 opencode candidate schema。

保留现有：

```json
{
  "fusion": {
    "type": "temporal",
    "channel_mode": "independent"
  }
}
```

在 Python runner 内部根据 dataset role metadata 解释外生变量。

如果后续要显式暴露 future covariate 策略，再添加：

```json
{
  "future_covariate_mode": "none"
}
```

可选值：

```text
none
concat_head
```

但不要恢复 `covariate_fusion` 命名。

## 需要删除或替换的 wrapper 引用

需要处理这些位置：

```text
neo_cast/py/train.py
neo_cast/py/prepare_tsf.py
neo_cast/py/export.py
opencode/packages/opencode/script/evaluate-full-run-checkpoints.py
neo_cast/py/tests/test_exogenous_support.py
```

所有新路径不再 import：

```python
from covariate_model import CovariateConditionedForecaster
```

`covariate_model.py` 可分两步处理：

1. 第一阶段：保留文件，仅用于旧 artifact 兼容或旧测试。
2. 第二阶段：确认无旧 checkpoint 依赖后删除。

## Checkpoint 兼容策略

### 新 checkpoint

新 checkpoint 应包含：

```json
{
  "model_family": "recipe_factory",
  "model_config": {
    "recipe": {},
    "num_channels": 3,
    "num_target_channels": 1,
    "num_past_covariate_channels": 2,
    "num_future_covariate_channels": 0,
    "num_output_channels": 1
  }
}
```

不再包含：

```json
{
  "covariate_fusion": "gated"
}
```

### 旧 checkpoint

旧 checkpoint 可能包含 wrapper state dict。

建议策略：

- `train.py` 不再生成旧格式。
- `export.py` 和 evaluation scripts 可以临时检测旧 checkpoint。
- 如果 state dict 包含 wrapper key，例如 `backbone.*`、`target_head.*`、`concat_head.*`，走 legacy load path。
- 否则走新 native load path。

如果不要求旧 artifact 兼容，可以明确报错：

```text
Legacy CovariateConditionedForecaster checkpoints are no longer supported. Re-train the candidate with native fusion.
```

## 测试计划

### Unit tests

1. `dataset.v2` + no covariates
   - 输入：target only
   - 输出：target only
   - 不 import wrapper

2. `dataset.v2` + observed past covariates
   - 输入：
     ```text
     target_history: [B, L, T]
     exogenous_past: [B, L, P]
     ```
   - 内部 history channels = `T + P`
   - 输出 shape = `[B, H, T]`

3. `dataset.v2` + known future covariates
   - 默认 `future_covariate_mode=none`
   - forward 接收 `exogenous_future`
   - 输出 shape 正确
   - 不崩溃

4. `fusion.channel_mode=independent`
   - `channel_mixer` 是 `Identity`
   - 输出 shape 正确

5. `fusion.channel_mode=shared`
   - `channel_mixer` 是 `ChannelMixer`
   - 需要 `num_channels`
   - 输出 shape 正确

6. `fusion.type=feature / graph / gated_hybrid`
   - mixer 被真实构造
   - 输出 target-only

### Integration tests

1. `prepare-data` 生成 dataset.v2 spec。
2. `runner.py run` 完成训练。
3. `model.pt` 不包含 wrapper key。
4. `export.py` 可导出 target-only inference contract。
5. `evaluate-full-run-checkpoints.py` 可加载新 checkpoint。

## 风险点

### Future covariates 语义会变弱

如果直接删除 wrapper，默认 future covariates 可能被忽略。

缓解：

- 第一阶段明确记录为 `future_covariate_mode=none`。
- 第二阶段实现 `concat_head`。

### 输出 channel 从 input channels 裁剪可能过于隐式

缓解：

- 在 metadata 写清楚：
  ```json
  {
    "target_channel_indices": [0]
  }
  ```
- dataset builder 保证 target channels 始终在 history tensor 前部。

### 旧 checkpoint 不兼容

缓解：

- 短期保留 legacy load path。
- 或明确要求重训。

### opencode bridgeOnly 当前限制 shared

opencode 目前默认 `bridgeOnly=true` 时只允许：

```json
{
  "fusion": {
    "type": "temporal",
    "channelMode": "independent"
  }
}
```

如果希望外生变量更积极使用 channel mixing，需要后续放宽 bridgeOnly 校验。

## 推荐实施顺序

1. 在 `RecipeModel` 增加 channel role metadata 支持。
2. 让 `RecipeModel.forward` 支持 dict-style 外生变量输入。
3. 增加 target-only output 裁剪。
4. 修改 `train.py`，删除 `CovariateConditionedForecaster` 新训练路径。
5. 修改 `prepare_tsf.py` 和 eval load path。
6. 修改 `export.py`。
7. 更新 tests。
8. 删除或 legacy 化 `covariate_model.py`。
9. 后续再实现 `future_covariate_mode=concat_head`。

## 实施顺序说明

这套顺序的核心是：先让原生 `RecipeModel` 有能力表达 `dataset.v2` 的输入/输出语义，再把训练、评估、导出路径从 wrapper 切换到原生模型。

### 1. 在 `RecipeModel` 增加 channel role metadata 支持

当前 `RecipeModel` 主要知道一个总 channel 数：

```python
num_channels
```

但外生变量场景需要知道不同 channel 的角色：

```python
num_target_channels
num_past_covariate_channels
num_future_covariate_channels
num_output_channels
```

这样模型才能区分：

```text
输入历史 channel = target + past covariates
输出 channel = target only
```

没有这一步，模型只能默认“输入几个 channel 就输出几个 channel”，无法安全替代 wrapper 的 target-only 输出语义。

### 2. 让 `RecipeModel.forward` 支持 dict-style 外生变量输入

当前普通模型输入是：

```python
model(x)
```

其中 `x` 是：

```text
[batch, input_len, num_channels]
```

但 `dataset.v2` dataloader 返回的是结构化 batch：

```python
{
    "target_history": ...,
    "exogenous_past": ...,
    "exogenous_future": ...,
}
```

因此 `RecipeModel.forward` 需要支持：

```python
model(
    target_history=target_history,
    exogenous_past=exogenous_past,
    exogenous_future=exogenous_future,
)
```

内部再统一为 history-side 输入：

```python
history = torch.cat([target_history, exogenous_past], dim=-1)
```

这样外部不再需要 wrapper，模型本体就能消费 `dataset.v2` batch。

### 3. 增加 target-only output 裁剪

如果输入是：

```text
target 1 channel + past covariates 2 channels = 3 channels
```

原生模型默认会输出：

```text
[batch, horizon, 3]
```

但真实预测目标只应该是：

```text
[batch, horizon, 1]
```

所以需要在模型输出端做：

```python
y = y[..., :num_target_channels]
```

这是删除 wrapper 的关键，因为以前这个事情由 wrapper 的 `target_head` 或输出投影逻辑承担。

### 4. 修改 `train.py`，删除 `CovariateConditionedForecaster` 新训练路径

前三步完成后，模型本体已经能处理 `dataset.v2`，训练代码就可以从：

```python
backbone = build_model(...)
model = CovariateConditionedForecaster(backbone, ...)
```

改成：

```python
model = build_model(model_config, input_len, horizon)
```

这一步才是真正删除新训练路径里的 wrapper。如果先改 `train.py`，模型本体还不能吃结构化输入或 target-only 输出，训练会直接出现 shape mismatch。

### 5. 修改 `prepare_tsf.py` 和 eval load path

这些路径会加载训练好的 `model.pt` 做验证、`ref_test` 或 checkpoint 复评。

当前它们也可能按旧逻辑重建模型：

```python
backbone + CovariateConditionedForecaster
```

训练路径切换后，评估路径也必须同步，否则会出现 state dict 不匹配：

```text
missing keys / unexpected keys
```

因此这一步必须紧跟 `train.py` 修改之后。

### 6. 修改 `export.py`

`export.py` 会生成推理包、tool schema、example、MCP server 等。

删除 wrapper 后，导出逻辑也要知道：

```text
输入可以是 target_history / exogenous_past / exogenous_future
输出是 target only
```

否则导出的模型可能还按旧 wrapper contract 写 schema，或者在加载新 checkpoint 时失败。

### 7. 更新 tests

测试需要覆盖新语义：

- `dataset.v2` 不再 import wrapper。
- past covariates 能参与输入。
- 输出只包含 target channels。
- `fusion.channel_mode=independent/shared` 仍真实生效。
- export/eval 能加载新 checkpoint。

这一步放在 train/eval/export 主要路径改完之后，是为了让测试覆盖最终集成形态，而不是只验证中间状态。

### 8. 删除或 legacy 化 `covariate_model.py`

等 train/eval/export/tests 都切完后，再处理 `covariate_model.py`。

有两个选择：

- legacy 化：保留它，只用于加载旧 checkpoint。
- 删除：如果不要求旧 artifact 兼容，就删掉并让旧 checkpoint 明确报错。

不建议一开始就删除，因为训练、评估、导出路径中可能仍有隐式 import。先切换调用方，再移除实现，风险更低。

### 9. 后续再实现 `future_covariate_mode=concat_head`

known-future covariates 比 past covariates 更复杂。

Past covariates 很自然：

```text
和 target_history 同长度，直接拼 history channel
```

Future covariates 是：

```text
[batch, horizon, future_cov_channels]
```

它不在历史窗口里，不能直接进入当前 temporal backbone。需要单独设计 horizon-side conditioning，例如：

```python
y = concat_head(torch.cat([forecast, exogenous_future], dim=-1))
```

因此第一阶段可以先做到：

```text
接收 exogenous_future，但默认不使用
```

第二阶段再明确实现：

```json
{
  "future_covariate_mode": "concat_head"
}
```

这样可以把“删除 wrapper”和“增强 future covariates 建模能力”拆开，降低一次性改动的风险。

## 最终期望架构

```text
dataset.v2 batch
  target_history
  exogenous_past
  exogenous_future
      |
      v
RecipeModel native input adapter
      |
      v
history channels = target + observed-past covariates
      |
      v
fusion system
  temporal independent/shared
  feature
  graph
  gated_hybrid
      |
      v
temporal backbone
      |
      v
target-only output
      |
      v
optional future covariate conditioning
      |
      v
forecast: [batch, horizon, target_channels]
```

## 结论

`CovariateConditionedForecaster` 应删除为一条独立 wrapper 路径。

外生变量支持应回到现有 recipe factory 的 fusion 系统中：

```json
{
  "fusion": {
    "type": "temporal",
    "channel_mode": "independent"
  }
}
```

其中 observed-past covariates 作为 history-side channels 参与原生 channel fusion，known-future covariates 通过后续 `future_covariate_mode` 明确建模。第一阶段可以先实现 wrapper 删除和 target-only 输出语义，future covariates 默认不参与预测，以保持行为清晰、改动可控。
