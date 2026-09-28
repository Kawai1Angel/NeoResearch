# Recipe Runtime 语义一致性四批次修正方案

> 2026-09-27 更新：用户已要求删除 `direct_multi_horizon`。该 action 已从当前 schema、注册表、工厂和搜索入口移除，旧方案中对其恢复/重新定义的描述不再适用。

> 状态：剩余方案已实现；批次四选择轻量模块正式改名路线，非完整论文模型实现
> 适用范围：`neo_cast` 从 `recipe_schema_v1` 升级到 `recipe_schema_v2`，包括 recipe factory、训练数据流、执行契约与语义测试
> 目标：确保每个可搜索 action 或参数都能真实改变模型结构、前向计算、训练目标或运行约束；无法兑现的能力不得继续被静默接受  
> 本方案不包含已知未来外生变量的实现。该能力在重新设计前暂时下线。

### 实施记录（2026-09-23）

- B1-01 / B1-02：CLI、数据合同、物化、训练配置、factory 和导出拒绝非空 future/static 配置，固定错误码为 `UNSUPPORTED_COVARIATE`。保留旧空字段兼容；不再生成 `used_known_future_covariates`。observed-past 导出推理无需提供空 future 数组。
- B1-04：五类 action schema 改为按 `type` 区分的严格 `oneOf`；错误定位到所选分支的 JSON path。高层 ModelRecipe 编译结果和直接 `resolve_recipe` 调用均经过低层校验。
- B1-05：Python registry、训练入口和 OpenCode domain 统一 point/quantile/Gaussian 的 head–distribution–loss 组合；quantile levels 必须有序、唯一且与 loss 一致，禁止点预测广播为多分位数。
- B1-06：季节性 mutation 使用合法 moving-average decomposition；mutation 返回前通过 schema 与 registry，切换 fusion 时清除旧 action 字段，并同步 transformer 的 embedding width。
- B1-07（部分）：新增非法参数、完整输出组合矩阵、quantile/Gaussian 参数梯度、mutation 校验、future/static 拒绝、observed-past 输入敏感性及导出输入测试。

后续实施已补齐剩余项：

- B1-03 / B1-07：删除跨 horizon 共享、旧 feature 开关、base_head、fill_policy、graph_type 和全局 dropout 等无效字段；Python/OpenCode 严格校验同步。增加全 backbone/embedding/preprocessing/fusion/head 结构、输入梯度、配置差异测试与 action 集合同步测试。
- B2：逐通道独立 linear、模块 dropout、per-variable affine norm、显式 last-value centering、ordered fusion 四种 gate/residual 组合；mask 在物化前保存，覆盖 train/val/ref-test/export，并在 CV fold 内重新填补和拟合 scaler。
- B3：冻结 [v2 合同](recipe_runtime_v2_contract.md)，encoder 输出 `[B,C,min(T,64)]`，五类真实参数化 head 独占最终 horizon 投影；variate attention、双支 gated hybrid、可训练 trend 分支和 train-only/static/learned graph 已接入。manifest 含实际参数图 digest、head 参数量、dropout、shared、gate 和 adjacency 来源/digest。
- 兼容：checkpoint/metadata 带 `runtime_semantics_revision=2`；导出检查版本和参数图，旧模型须重训。CV protocol 纳入语义版本，避免旧 champion 与新语义混比。
- B4：采用方案 B：SSM proxy 正式更名 `gated_depthwise_conv`，TimesNet 轻量路径更名 `timesnet_lite` 并标记 `paper_derived`。完成 [ETTh1 同预算 sanity comparison](recipe_runtime_v2_sanity.md)。完整 SSM、完整 TimesNet、跨配置 horizon 共享属于原方案可选后续工作，本次不宣称实现。
- 验证：`npm test`（Node 71 项及 Python wrapper）、Python 全量 180 项通过；OpenCode 相关 78 项通过，并完成 typecheck。新增测试包含独立导出往返、旧 checkpoint 拒绝、训练 fold graph/填补隔离、真实物化 mask 的 train/val/ref-test 路径。
- 扩大检查：`bun test test/research` 为 326 通过、2 失败。两项不属于本次 recipe/runtime 修正：`hypothesis-evidence-tools.test.ts` 的 fixture 未创建 `quantitative.json`；`service.test.ts` 的 plateau 测试期望 25 轮，而当前实现返回 7 轮。未修改这些功能的行为以迎合旧断言。

以下章节保留原问题分析、候选方案与验收要求；最终选择以 v2 合同和上述实施记录为准。保留并明确声明 `temporal/shared` 与 `feature_mlp` 的计算等价关系，禁止将其当作独立机制归因。

## 1. 背景

现有系统已经完成过一轮高层 `model_recipe.v1` 一致性修复，解决了 attention、Gaussian、invert、multiscale patch、DLinear 重复分解、calendar、预算传递等问题。

本轮发现的问题主要位于低层 `recipe_schema_v1` 和 recipe runtime：

- 某些 action 名称不同，但运行时结构和输出完全相同；
- schema 接受了 factory 从未读取的参数；
- backbone 已经输出最终 horizon，prediction head 没有真正拥有输出投影；
- 部分模块有实际计算，但实现弱于名称宣称的语义；
- 数据准备会提前消除某些机制需要的信息，例如缺失位置；
- 测试偏重 schema、shape 和“能否执行”，没有验证机制是否真正生效。

这些问题会污染自动研究循环：Agent 可能把无效参数变化当作新模型，把相同计算图的候选当作独立证据，并在 Reflection 阶段形成错误归因。

## 2. 已锁定决策

### 2.1 暂时下线未来外生变量

当前不实现 known-future covariate conditioning。处理原则是“明确拒绝”，而不是继续静默清空或记录虚假使用状态。

暂时下线的表面能力包括：

- `known_future_covariates`；
- `known_future_source`；
- `known_future_available`；
- `future_covariate_mode`；
- `num_future_covariate_channels`；
- `used_known_future_covariates` 和其他暗示模型已消费未来变量的元数据；
- 未接入当前 runtime 的 legacy covariate wrapper。

兼容策略：

- 已有 dataset artifact 可以继续读取，但只要上述字段非空，就在训练前给出明确的 unsupported 错误；
- 不允许把非空输入自动改成空列表；
- CLI、Agent prompt、README 示例和 schema 必须保持同一口径；
- 未来重新接入时使用新的显式版本或 capability flag，不复用当前“存在但无效”的行为。

### 2.2 修复优先原则

1. 先保证实验诚实，再扩大 action space。
2. 一个配置字段必须满足以下条件之一：
   - 改变参数图；
   - 改变前向计算；
   - 改变 loss 或训练调度；
   - 改变明确可测的运行约束。
3. 不满足上述条件的字段必须删除、拒绝或标记 deprecated，不能仅用于日志标签。
4. 名称弱于实现可以接受；名称强于实现不可接受。
5. 每恢复一个 action，必须同时恢复 schema、prompt、factory、执行契约、导出和语义测试。

## 3. 修正范围总表

| 问题 | 当前状态 | 目标批次 | 目标处理 |
|---|---|---:|---|
| 未来外生变量 | 输入被清空或忽略 | 1 | 暂时下线并明确拒绝 |
| 静态协变量 | 声明后不进入模型 | 1 | 暂时下线，等待多序列/entity 合同 |
| 无效 action 参数 | schema 接受但 factory 不读取 | 1 | 删除或拒绝 |
| Quantile 组合矩阵 | point head 可配 quantile loss | 1 | 严格组合校验 |
| 无效 mutation | 生成不符合 schema 的 decomposition | 1 | 修正模板 |
| 语义测试缺失 | 只检查 shape/类名 | 1 | 增加结构、敏感性和梯度测试 |
| `linear.shared` | true/false 相同 | 2 | 实现共享与逐通道两条路径 |
| dropout 双重来源 | `regularization.dropout` 无效 | 2 | 建立唯一优先级或删除重复字段 |
| missing mask | 数据层先消除 NaN | 2 | 保留原始 mask 并传入模型 |
| 隐式 last-value centering | 所有非 invert backbone 默认启用 | 2 | 改成显式 action |
| affine instance norm | 只有全局标量参数 | 2 | 改成逐变量参数 |
| ordered fusion 开关 | `gate/residual` 无效 | 2 | 实现开关语义 |
| backbone/head 边界 | backbone 已输出 horizon | 3 | 建立统一 latent contract |
| linear/direct head | 两者都是 Identity | 3 | 重新定义并实现，或删除冗余 action |
| feature fusion | 与 feature-then-temporal 别名 | 3 | 实现变量 token 路径 |
| gated hybrid | 原输入与 feature mixer 门控 | 3 | 实现 temporal/feature 双分支 |
| graph source | 始终 learned dense | 3 | 接入 train-only correlation/static topology |
| decomposition | 残差单分支 + 常数趋势 | 3 | trend/residual 双分支 |
| SSM | 实际为门控 depthwise conv | 4 | 真正实现 SSM，或正式改名 |
| TimesNet | Lite 版本以完整名称暴露 | 4 | 补全论文级核心，或正式改名 |
| 跨预测长度共享 | 每个配置 horizon 独立模型 | 4 | 单独设计 multi-task horizon 合同 |

## 4. 批次一：让搜索结果先变得可信

### 4.1 目标

这一批不追求增加模型能力，只保证：

- 搜索空间中不存在已知无效变量；
- 不支持的能力会在候选进入 smoke 前被拒绝；
- 两个被声明为不同的候选，至少在结构、计算或训练目标上存在可验证差异；
- 错误信息能直接指出字段和修复方向。

### 4.2 工作项

#### B1-01：下线未来外生变量

涉及位置：

- `py/schemas/dataset_schema.json`
- `py/dataset_contract.py`
- `py/prepare_tsf.py`
- `py/train.py`
- `py/export.py`
- `py/schemas/metadata_schema.json`
- `src/cli.js`
- `README.md`
- Agent prompt 中的数据能力说明

处理方式：

1. validator 遇到非空 future covariate 配置时返回固定错误码和可读说明；
2. 删除“接收后清空”的行为；
3. 训练摘要不再写入“已使用未来协变量”；
4. CLI 暂时不展示相关参数，或者保留参数但立即报 unsupported；
5. 移除当前 README 中暗示该能力可用的示例；
6. legacy checkpoint 如果包含 future covariate wrapper，继续明确拒绝并要求重训。

验收：

- 非空 future covariate 配置不能进入 candidate resolved 状态；
- 空配置保持 dataset.v1/v2 的 target 和 observed-past 路径可用；
- 不再产生误导性的 future covariate metadata。

#### B1-02：暂时下线静态协变量

当前 runtime 没有 entity/batch 级静态特征合同，单序列任务中静态值也通常是常数。现阶段采用与 future covariate 相同的显式拒绝策略。

验收：非空 `static_covariates` 在数据物化前失败，不再出现“已配置但未进入 batch”的状态。

#### B1-03：收缩无效 action 字段

第一阶段先保留已真实执行的最小集合。

建议暂时移除或拒绝：

| Action | 暂时移除的字段/值 | 保留能力 |
|---|---|---|
| `linear` head | `share_across_horizons` | action 本身也在批次三前暂停搜索 |
| `direct_multi_horizon` | 整个 action | 等待批次三重新定义 |
| `feature` | `variate_token`、`cross_attention` | 若保留，只能明确命名为 channel MLP |
| `feature_then_temporal` | 与 `feature` 重复的 action | 暂时只保留一个 |
| ordered fusion | `gate`、`residual` | 在批次二实现前使用固定行为 |
| `graph` | `static`、`correlation`、`sparsity` | 只保留 learned dense graph |
| `gated_hybrid` | `gate_type` 枚举 | 只保留当前 channel-like gate，并改准确名称 |
| `residual_correction` | `base_head` | 只保留 `correction_dim`，或固定说明 base 为 backbone forecast |
| training regularization | `dropout` | 在批次二确定唯一来源前只保留 `grad_clip` |

同步修改：

- `py/schemas/recipe_schema.json`
- `py/registry/action_specs.py`
- `src/llm.js`
- `src/reflect.js`
- OpenCode TSF domain schema 与 ModelDesigner prompt
- 示例 recipe 与使用说明

#### B1-04：使用 discriminated schema

把 preprocessing、embedding、backbone、fusion、head 从“一个对象包含所有可能字段”改成以 `type` 为 discriminator 的 `oneOf`。

示例目标：

```json
{
  "oneOf": [
    {
      "properties": {
        "type": {"const": "linear"},
        "shared": {"type": "boolean"},
        "bias": {"type": "boolean"}
      },
      "required": ["type", "shared", "bias"],
      "additionalProperties": false
    }
  ]
}
```

验收：

- `linear` backbone 携带 `top_k` 必须失败；
- `graph` fusion 携带 `cross_attention` 必须失败；
- `linear` head 携带 `quantiles` 必须失败；
- 错误信息包含完整 JSON path。

#### B1-05：补齐输出分布—head—loss 组合矩阵

合法组合：

| Head | Output distribution | Loss |
|---|---|---|
| point head | `point` | `mse`、`mae`、`huber`、`distillation` |
| quantile head | `quantile` | `quantile` |
| Gaussian head | `gaussian` | `gaussian_nll` |

附加规则：

- quantile head 与 quantile loss 的 levels 必须一致；
- quantile levels 必须严格递增且不重复；
- 不允许 point prediction 通过广播冒充多个 quantile；
- 不允许只训练 quantile 中位数却导出完整 quantile distribution；
- Gaussian scale 分支必须存在非零梯度。

#### B1-06：修复无效 mutation

将季节性 bias mutation 修正为合法配置：

```json
{
  "type": "series_decomposition",
  "method": "moving_average",
  "kernel_size": 25
}
```

mutation 输出在返回前必须同时经过 schema 和 registry validator，不能把无效 recipe 交给后续 candidate 流程。

#### B1-07：增加语义级测试

新增测试原则：

1. **结构差异测试**：声称改变结构的字段必须改变模块类型、参数名或参数数量。
2. **输入敏感性测试**：声称消费某个输入时，扰动该输入必须改变输出或对应梯度。
3. **开关测试**：布尔值两侧必须产生预期差异；否则字段必须被拒绝。
4. **梯度测试**：新机制参数在匹配 loss 下必须获得非零梯度。
5. **端到端测试**：覆盖 materialize → loader → model → loss，而不只测试独立类。
6. **等价检测测试**：同 seed 下不应允许不同 action 生成完全相同的 state dict 结构和输出，除非该等价关系被显式声明。

建议新增：

- `py/tests/test_recipe_semantics.py`
- `py/tests/test_recipe_action_sensitivity.py`
- Node/OpenCode 侧的 action-space 同步测试

### 4.3 批次一完成门槛

- schema、registry、LLM prompt 和 runtime action 集合完全一致；
- 不存在已知未读取字段；
- future/static covariate 非空时明确失败；
- quantile/Gaussian 组合矩阵全覆盖；
- mutation 生成的每个候选都能通过同一套 validator；
- 所有 action 都至少有一个结构、敏感性或梯度测试；
- 执行契约不再把两个 Identity 子类视为足够的语义证明。

## 5. 批次二：修复成本较低的真实语义

### 5.1 目标

恢复已有字段的实际作用，修正隐藏的全局行为，并让数据流保留 action 所需信息。

### 5.2 工作项

#### B2-01：实现 `backbone.linear.shared`

定义：

- `shared=true`：所有变量共享一个 `Linear(input_len, horizon)`；
- `shared=false`：每个变量具有独立 `Linear(input_len, horizon)`；
- `fusion.channel_mode` 只描述跨变量融合，不再代替 backbone 参数共享语义。

实现注意：

- 构建时必须知道有效通道数；
- missing-mask 追加通道不能与 target/past 通道权重错误对应；
- structured input 最终仍只输出 target channels；
- 参数预算要反映逐通道参数增长。

验收：

- true/false 参数量不同；
- false 时不同通道权重对象不同；
- 任一通道的 loss 能只更新对应独立层；
- execution manifest 记录真实 shared 状态。

#### B2-02：统一 dropout 来源

建议合同：

- `training_strategy.regularization.dropout` 是全局默认；
- action 内显式 `dropout` 是局部 override；
- 编译后的 resolved recipe 必须写出每个模块最终使用的 dropout；
- 禁止两个字段存在但优先级不明确。

如果不需要全局 default，则删除 regularization dropout，只保留模块级 dropout。两种方案只能选择一种。

验收：只改变有效 dropout 字段时，模型中的 `nn.Dropout.p` 和训练输出必须发生变化。

#### B2-03：重建 missing-mask 数据流

目标数据合同：

```text
raw values
  ├─ missing mask ───────────────────────┐
  └─ train-fitted imputation → values ──┼→ WindowDataset
                                        └→ MissingMaskAction
```

要求：

- mask 在任何 fill/drop 前生成；
- train/val/ref-test 使用同一含义；
- scaler 只使用有效训练值拟合，或明确使用填补后的训练值；
- `mask_channel=true` 追加真实 mask；
- `fill_policy` 与 dataset-level missing strategy 不重复执行；
- 导出推理支持值与 mask 一起输入。

建议把“数据清洗策略”和“模型缺失建模策略”拆成两个不同字段，避免同名职责冲突。

#### B2-04：显式化 last-value centering

当前所有非 invert 路径都会隐式执行：

```text
series = x - x[:, -1:, :]
forecast = model(series) + x[:, -1:, :]
```

修正方案：

1. 增加显式 preprocessing action，例如 `last_value_centering`；
2. `preprocessing=none` 不再做实例级动态变换；
3. NLinear baseline recipe 显式加入该 action；
4. DLinear、TCN、TimesNet、N-BEATS 等默认不再继承 NLinear 偏置；
5. invert 保留自身明确记录的 per-variable mean/std normalization。

兼容影响：所有旧 checkpoint 应视为旧计算图，不得无提示加载到新语义模型。

#### B2-05：逐变量 affine instance normalization

将 affine 参数改为 `[1,1,C]`，并处理 mask 追加前后的通道数。若未来允许动态通道数，则使用 lazy initialization 或在模型构建时冻结输入合同。

验收：不同变量可学习不同 scale/shift，逆变换恢复正确。

#### B2-06：实现 ordered fusion 的开关

建议语义：

| 配置 | 行为 |
|---|---|
| `gate=false,residual=false` | 直接串行输出 |
| `gate=false,residual=true` | `x + branch(x)` |
| `gate=true,residual=false` | `g * branch(x)` |
| `gate=true,residual=true` | `g * branch(x) + (1-g) * x` |

必须明确 gate 的 shape 和归一化位置，并分别覆盖 `temporal_then_feature` 与 `feature_then_temporal`。

### 5.3 批次二完成门槛

- `linear.shared`、dropout、gate、residual 的每个取值都通过差异测试；
- missing mask 在真实物化数据上包含原始缺失信息；
- `preprocessing=none` 不再执行未声明的动态变换；
- NLinear baseline 通过显式 action 保持原行为；
- 旧 artifact 加载时能识别语义版本并给出重训提示；
- full test、导出推理测试和至少一个端到端 smoke 通过。

## 6. 批次三：重建模型组合边界

### 6.1 设计检查点

批次三开始编码前，必须冻结以下合同：

1. backbone latent 的统一 shape；
2. channel-independent 与 variable-token 路径是否使用同一 latent contract；
3. prediction head 是否唯一拥有 horizon 投影；
4. “horizon”指单模型 lead step，还是任务中的预测长度配置；
5. linear 与 direct-multi-horizon 的数学差异；
6. decomposition 是否属于 preprocessing、backbone wrapper 或 fusion graph；
7. recipe schema 是否升级为新版本。

推荐使用 `recipe_schema_v2`，避免让旧 recipe 在同一版本号下改变计算语义。

### 6.2 统一 latent contract

建议基础合同：

```text
channel-independent latent: [B, C, D]
temporal-token latent:      [B, C, T, D]  （可选）
variate-token latent:       [B, C, D]
point forecast:             [B, H, C]
quantile forecast:          [B, H, C, Q]
distribution forecast:      mean/scale [B, H, C]
```

backbone 提供 `encode()` 或等价接口；prediction head 独占最终 horizon 输出。原始序列 backbone 若天然输出 forecast，可以通过 `ForecastBackboneAdapter` 明确标记，而不是伪装成 latent backbone。

### 6.3 重新定义 prediction head

#### Linear head

- 输入 `[B,C,D]`；
- 输出 `[B,H,C]`；
- 是默认 point forecast head。

#### Direct multi-horizon head

必须先选择一种真正不同的定义。推荐：

- 每个 lead step 使用独立的小 head/tower；
- 可选共享第一层，但最终输出参数独立；
- `horizon_specific=true` 表示每个 `t+k` 都有独立 tower；
- 不用于表示任务配置中多个 H 模型之间的共享。

如果最终只是 `Linear(D,H)`，则它与普通 linear head 没有足够差异，应永久删除该 action。

#### Quantile/Gaussian/Residual head

- 直接读取 latent，而不是读取 backbone 已经生成的点预测；
- quantile head 为每个 lead step 输出 Q 个值；
- Gaussian head 输出 mean 和 positive scale；
- residual correction 显式持有 base head，并对 base forecast 学习 correction。

### 6.4 实现真正的 feature fusion

建议区分：

- `feature_mlp`：沿变量维做 ChannelMixer；
- `variate_attention`：把变量作为 token 做 self-attention；
- `temporal_then_feature`：先得到每变量 temporal latent，再进行变量融合；
- `feature_then_temporal`：先融合每个时间点的变量，再进行时间建模。

不要继续用宽泛的 `feature` 名称同时表示多种不同机制。

### 6.5 实现真正的 gated hybrid

目标结构：

```text
input
  ├─ temporal branch ─┐
  └─ feature branch ──┼─ gate(scalar/channel/time) → fused latent
```

gate 定义：

| `gate_type` | 建议 shape |
|---|---|
| `scalar` | `[B,1,1]` |
| `channel` | `[B,1,C]` 或 `[B,C,1]`，取决于 latent layout |
| `time` | `[B,T,1]` |
| `learned` | 静态可学习参数，必须明确与输入条件 gate 的区别 |

每个 gate 类型必须产生不同参数图，并有梯度测试。

### 6.6 扩展 graph fusion

- `learned`：当前 dense adjacency，可选 top-k sparsity；
- `correlation`：只使用 train split 计算并持久化；
- `static`：从显式 topology artifact 读取，并校验节点/通道顺序；
- 所有 adjacency 都必须进入 artifact digest 和执行契约；
- ref-test 数据不得参与 correlation graph 拟合。

### 6.7 双分支 decomposition

目标：

```text
x → moving average → trend ─────→ trend model ─────┐
 └───────────────→ residual ────→ residual model ──┼→ forecast
```

需要决定两支是否共享 backbone 类型、hidden size 和 head。第一版建议固定轻量 trend linear branch，residual 使用 recipe backbone，控制搜索空间规模。

### 6.8 批次三完成门槛

- `recipe_schema_v2` 或等价版本化合同完成；
- backbone latent 与 head 输出边界唯一且有 shape contract；
- linear/direct/quantile/Gaussian/residual head 均拥有真实参数和梯度；
- feature、ordered feature、gated hybrid 不再存在结构别名；
- graph adjacency 来源可追溯且无数据泄漏；
- decomposition 的 trend 参数获得非零梯度；
- execution contract 校验结构语义，而不只校验类名；
- 旧 v1 artifact 明确拒绝或通过显式兼容适配器加载。

## 7. 批次四：论文级或大型模块

### 7.1 目标

处理名称明显强于实现的高级 backbone，并评估是否值得承担长期维护成本。每个模块允许两种完成方式：

1. 实现与名称相符的核心计算图；
2. 保留当前轻量实现，但正式改名为 Lite/Derived，不再声称是完整模型。

### 7.2 SSM

当前模块是门控 depthwise convolution，不包含显式状态递推或 selective scan。

方案 A：实现真正 SSM：

- 明确选择 S4、DSS、Mamba-like selective SSM 或项目自定义 state-space block；
- `state_dim` 必须对应真实状态维度；
- 支持长序列线性复杂度；
- 增加长依赖、复杂度和状态梯度测试。

方案 B：保留当前实现并改名：

- action 改为 `gated_depthwise_conv`；
- 类名、文档、prompt、实验报告同步修改；
- 历史 SSM 结果标记为 legacy proxy，不用于 SSM 论文归因。

推荐先采用方案 B，再独立开发方案 A。

### 7.3 TimesNet

当前 `TimesNetLiteCore` 已实现 FFT 周期选择和 2D 卷积，不是占位模块。

方案 A：补齐更完整的 TimesNet 核心：

- prediction-length temporal extension；
- 多尺度/多核 Inception 风格 2D block；
- 每层周期发现与加权聚合；
- 与公开实现进行 shape、参数量和小样本数值行为对照。

方案 B：公开命名为 `timesnet_lite`：

- 保留现有轻量实现；
- 禁止在报告中把结果写成完整 TimesNet 复现；
- 文献归因标记为 `paper_derived`。

推荐短期采用方案 B。

### 7.4 跨预测长度共享

只有明确需要一个模型同时覆盖多个配置 horizon 时才实施。

候选方案：

- 训练最大 horizon，较短 horizon 直接切片；
- 一个共享 encoder，多个 horizon-specific heads；
- horizon token/embedding 条件化 decoder。

需要同步修改：

- 训练循环和 optimizer 生命周期；
- early stopping；
- 参数预算统计；
- checkpoint/state_dict 格式；
- execution contract；
- 导出和推理 API；
- CV 与各 horizon 指标归因。

在该合同完成前，系统继续保持“每个配置 horizon 一个模型”，并禁止出现暗示跨模型共享的字段。

### 7.5 批次四完成门槛

- 高级模块名称与真实计算图一致；
- Lite/Derived 模块在 recipe、artifact 和报告中带准确标签；
- 若实现跨 horizon 共享，参数预算和指标归因有新的明确口径；
- 至少完成标准数据集上的同预算 sanity comparison；
- 文献级名称不得仅凭类名或 prompt 声明。

## 8. 文件级影响矩阵

| 文件/模块 | 批次 | 主要修改 |
|---|---:|---|
| `py/schemas/recipe_schema.json` | 1–3 | action 收缩、discriminated union、v2 合同 |
| `py/schemas/dataset_schema.json` | 1–2 | 暂停 future/static；补 missing mask 数据合同 |
| `py/registry/action_specs.py` | 1–3 | action 能力、必需字段、组合校验 |
| `py/model_recipe.py` | 1–3 | 编译结果与低层合同同步 |
| `py/factory/build_model.py` | 2–4 | shared linear、显式 normalization、latent/head、fusion、高级 backbone |
| `py/prepare_tsf.py` | 1–2 | future/static 拒绝、保存 missing mask |
| `py/train.py` | 1–4 | loss 矩阵、dropout、模型构建、multi-horizon 可选改造 |
| `py/export.py` | 1–4 | artifact 兼容、mask、head 输出、新 schema 版本 |
| `py/execution_contract.py` | 1–4 | 从类名校验升级为结构/能力校验 |
| `py/search/mutate.py` | 1 | 合法 mutation 和生成后验证 |
| `src/llm.js`、`src/reflect.js` | 1–4 | prompt action space 与 runtime 同步 |
| OpenCode TSF domain/agents | 1–4 | proposal、contract 和 reflection 语义同步 |
| `py/tests/`、`test/` | 1–4 | 结构、敏感性、梯度、端到端测试 |

## 9. 测试策略

### 9.1 每个 action 的最低测试合同

每个可搜索 action 至少需要以下四类测试中的三类：

- schema/registry 合法性；
- 参数图或模块结构；
- 输入/配置敏感性；
- 目标 loss 下的梯度流。

数据相关 action 还必须有 materialize-to-model 端到端测试。

### 9.2 建议语义断言

```text
same seed + same config         → same initialization/output
same seed + structural change  → different state structure or parameter count
same seed + behavioral toggle  → controlled output difference
claimed input perturbed        → output or target gradient changes
disabled capability requested  → validation error, never silent fallback
```

### 9.3 防等价候选检查

为 smoke verification 增加可选 semantic fingerprint：

- 模块类型序列；
- 参数名称与 shape；
- 关键 capability 标志；
- 固定 seed/probe input 下的输出摘要；
- 可选关键输入梯度摘要。

它不能替代正式测试，但可以阻止明显相同的 action 被当成独立实验。

## 10. Artifact 与兼容策略

### 10.1 需要重训的变化

以下变化不得复用旧 checkpoint：

- last-value centering 显式化；
- shared/unshared linear 修复；
- per-channel affine instance norm；
- backbone/head 边界重构；
- feature/gated/decomposition 新结构；
- SSM 或 TimesNet 完整实现。

### 10.2 版本建议

- 批次一和批次二若只收缩/修正 v1，可增加 `runtime_semantics_revision`；
- 批次三应优先升级为 `recipe_schema_v2`；
- artifact 中写入 schema version、runtime semantics revision 和 model manifest digest；
- export loader 不允许仅凭字段名猜测旧模型语义。

## 11. 风险与控制

| 风险 | 控制措施 |
|---|---|
| 搜索空间骤减 | 先保证每个维度真实，再逐项恢复 |
| 旧实验不可直接比较 | 报告中分隔 legacy/new semantics，要求重训 |
| 大重构同时改变多个变量 | 每批建立独立 baseline 和语义快照 |
| graph correlation 数据泄漏 | 仅在 train fold 拟合并进入 artifact digest |
| missing mask 与 scaler 冲突 | 明确 mask 生成、imputation、scaler fit 顺序 |
| Lite 模块被误当论文复现 | action、类名和报告统一带 Lite/Derived 标签 |
| execution contract 只验证标签 | 加入参数图、capability 和 probe 校验 |

## 12. 推荐交付顺序

每个批次单独提交和验证，不把四批合成一次大改。

1. **Batch 1A：能力下线与 schema 收缩**
2. **Batch 1B：组合校验、mutation 和语义测试**
3. **Batch 2A：shared/dropout/instance norm**
4. **Batch 2B：missing mask 与显式 centering**
5. **Batch 2C：ordered fusion 开关**
6. **Batch 3A：冻结 v2 latent/head 合同**
7. **Batch 3B：实现 prediction heads**
8. **Batch 3C：实现 feature/gated/graph/decomposition**
9. **Batch 4A：Lite 模块准确改名**
10. **Batch 4B：按研究优先级选择完整 SSM、TimesNet 或跨 horizon 共享**

## 13. 最终完成定义

本方案完成时应满足：

- Agent 能提出的每个字段都在 runtime 中有可证明的作用；
- 不支持的能力会在候选构建前明确失败；
- 不再存在仅靠不同类名区分的相同计算图；
- `none`、`shared`、`gate`、`residual` 等词与实际行为一致；
- 概率输出的 head、loss、评估和导出语义一致；
- 数据 action 能在真实数据流中获得所需信息；
- Lite/Derived 实现不再使用完整论文模型名称；
- 执行契约、artifact 和测试能够证明上述事实，而不是只记录配置标签。
