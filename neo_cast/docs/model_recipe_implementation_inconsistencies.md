# ModelRecipe 现有字段实现一致性审查

## 实现更新（保留字段和选项）

以下正文保留整改前的审查记录。本轮采用补全机制、修正数据流和约束校验的方案，未删除 ModelRecipe 原有字段或枚举值。

| 问题 | 当前实现 |
|---|---|
| MR-001 | `none` 不使用注意力；`lightweight` 使用正特征映射的线性复杂度注意力；`full` 使用 softmax 注意力。Transformer 在 token 骨干中执行，其他骨干使用输入时间维残差注意力模块。 |
| MR-002/004 | Gaussian 提供均值与正标准差输出；新增 `training.loss=gaussian_nll`，监督均值与方差。schema/编译器校验 point、quantile、gaussian 与损失的对应关系；评估记录 Gaussian NLL 和分位数指标。 |
| MR-003 | invert 输入按变量执行 detached mean/std 归一化并保持 `[B,C,L]`，投影为 `[B,C,D]`；变量作为 token 进入骨干，Transformer 路径不添加变量位置编码，预测后逐变量反归一化。非 Transformer 组合保留为项目扩展。 |
| MR-005 | 显式不兼容 embedding 报错；兼容的显式请求保留，包括 linear+patch。auto 仍可为原始序列骨干选择 none。 |
| MR-006 | multiscale_blocks 控制多尺度处理深度（1–4），不再冒充尺度数量；每层先在各 patch 尺度内独立处理，再通过尺度摘要 attention 交换跨尺度信息。兼容的默认尺度由 history_window 决定，layers 仍单独控制骨干深度。 |
| MR-007/008 | heads 不可整除时报错；显式 channel_fusion 优先于 covariates。 |
| MR-009 | DLinear 的 decomposition=true 由其内部分解兑现，不再额外叠加 preprocessing 分解；decomposition_kernel 传入内部模块。 |
| MR-010 | 偶数窗口保留原值，左侧 padding=floor((kernel-1)/2)，右侧补足 kernel-1，保持长度。 |
| MR-011 | time_budget_s 传入运行约束，训练在 batch 边界检查截止时间；max_params 超过系统上限明确报错；显式 max_latency_ms 实际测量并执行超限失败，不再从 latency_sensitive 推导隐含硬上限。 |
| MR-012 | calendar 使用各窗口真实时间戳的 UTC 小时、星期、日、月；训练、验证、ref-test 和导出推理均传递日历输入，缺失时明确报错。 |

### 使用与兼容说明

- 输出与损失：point → mse/mae/huber/distillation；quantile → quantile；gaussian → gaussian_nll。原有损失选项全部保留。概率候选不会被自动 mutation 改为 Huber。
- Python 模型的 `forward_distribution()` 返回 `(mean, scale)`，scale 是标准差；普通 `forward()` 保留点均值接口。导出的 `predict_distribution_normalized/raw()` 返回 `{mean, scale}`，raw 同时正确反归一化均值和尺度。MCP 工具也返回这两个分布字段。
- calendar 的内部输入为 `[B,L,4]`，依次是 hour、dayofweek、day、month。导出调用可以传 `{"history": [...], "timestamps": [...]}`；dataset.v2 在原有结构化输入中附加 timestamps。时间按 UTC 解释，无时区输入视作 UTC；不得用每个窗口重新开始的位置编号代替日历值。
- 延迟定义：当前设备、batch=1、逐 horizon，3 次预热后测量 10 次，取中位数；GPU 完成同步后计时，以各 horizon 最大值与上限比较。摘要保留各 horizon 实测值；该上限与设备有关，不等同于跨设备服务 SLA。
- 原来借 multiscale_blocks 设置原始序列骨干深度的配置改用 layers。DLinear 仍然是自带分解的模型。invert 的归一化路径和 multiscale_patch 的参数结构均已改变，旧 checkpoint 应重新训练；旧 calendar/Gaussian 或 attention 被忽略时训练的权重同样不能视为已具备修正后的机制。
- 本轮高层 DSL 可用的 Gaussian 组合均已接通；低层独有的输出通道混合、逆季节差分与 Gaussian 组合因需要联合协方差，明确拒绝，不假装保持高斯分布。

### 论文一致性边界

- `invert + transformer + full attention + independent fusion` 对齐 iTransformer 的变量 token、逐变量归一化和无变量位置编码；叠加其他 fusion/preprocessing 或改用其他 backbone 时属于 `paper_derived` 扩展。
- `lightweight` 是 ELU+1 正特征映射的核化线性注意力，依据 Linear Transformer，而不是 Informer ProbSparse、LogSparse 或 Pyraformer 的等价实现。
- `multiscale_patch` 是受多分辨率 patch 模型启发的 `paper_derived` 组合模块，不声称复现 Scaleformer、MICN、TimeMixer 或 Pathformer 的完整计算图。
- `calendar`、直接多步 Gaussian head、`gated_hybrid` 和偶数 DLinear kernel 均保留为可组合机制或兼容扩展，不分别等同于完整 GLAFF、DeepAR、TFT 或原始 DLinear。

示例：`py/schemas/model_recipe_gaussian_calendar.example.json`、`py/schemas/model_recipe_invert.example.json`。回归见 `py/tests/test_model_recipe_consistency.py` 与 `test_train_execution.py`，覆盖跨变量梯度、方差梯度、真实窗口日历、四尺度、偶数窗口、预算、延迟超限和导出合同。

验证结果：recipe 相关 54 项测试通过，新增示例及原生 recipe 示例通过 CLI 校验。完整 Python 测试 139/140 通过；剩余失败是现有研究记录已改用 cv_avg_mse，但旧断言仍要求 val_avg_mse。`npm test` 的 Node 阶段 67/69 通过，两处失败分别为本地缺少 `datasets (1)/ETTh1.csv`、现有低层 scheduler 枚举与提示词清单不一致。随后新增的默认值测试通过；提示词单独复跑为 10/11，仍仅上述 scheduler 失败。本轮未更改这些已有问题。

> 审查日期：2026-09-20  
> 审查对象：`py/schemas/model_recipe_schema.json` 中已经存在的字段。  
> 不在范围内：未来协变量问题、低层 `recipe_schema_v1` 独有字段、高层 DSL 扩展建议。

## 1. 结论

本次仅检查 ModelRecipe 当前字段从 schema、编译器到运行时是否保持同一语义，共发现 12 类不一致：

- **P0：4 项**：字段合法但不生效，或输出/训练语义不成立。
- **P1：7 项**：字段被静默改写、串义、重复执行或没有约束不兼容组合。
- **P2：1 项**：字段名称与当前实现语义存在偏差。

本文不建议增加任何字段。每项整改只采用三种方式之一：

1. 按字段当前名称实现其语义；
2. 对不支持的值或组合明确报错；
3. 从现有 schema 删除尚未实现的字段或枚举值。

## 2. 问题总表

| ID | 优先级 | 现有字段 | 当前行为 | 判定 |
|---|---|---|---|---|
| MR-001 | P0 | `architecture.attention` | 编译器完全不读取，三个枚举值生成相同模型 | 字段无效 |
| MR-002 | P0 | `architecture.output_distribution=gaussian` | 方差被丢弃且无 Gaussian 损失 | 机制未实现 |
| MR-003 | P0 | `architecture.embedding=invert` | 通道先展平进 batch，没有形成变量 token | 机制语义不符 |
| MR-004 | P0 | `architecture.output_distribution` + `training.loss` | 可形成无监督输出分支或语义冲突组合 | 缺少组合校验 |
| MR-005 | P1 | `architecture.embedding` + `backbone` | 部分显式 embedding 请求被静默改成 `none` | 静默降级 |
| MR-006 | P1 | `architecture.multiscale_blocks` | 同时控制尺度数和骨干深度，值 4 仍只有 3 个尺度 | 参数串义 |
| MR-007 | P1 | `architecture.heads` | 不可整除时被静默递减 | 静默改写 |
| MR-008 | P1 | `input.covariates` + `architecture.channel_fusion` | `covariates=true` 会覆盖显式 `independent` | 显式配置被覆盖 |
| MR-009 | P1 | `architecture.decomposition` + `backbone=dlinear` | 外部和 DLinear 内部各执行一次分解 | 重复机制 |
| MR-010 | P1 | `decomposition_kernel` | 偶数值通过 schema 后被运行时加一 | 静默改写 |
| MR-011 | P1 | `training.time_budget_s`、`constraints.max_latency_ms`、`constraints.max_params` | 时间预算被默认值替代；延迟上限未执行；参数上限可能被静默收紧 | 约束不一致 |
| MR-012 | P2 | `architecture.embedding=calendar` | 使用位置索引合成周期特征，不读取真实日历值 | 名称语义偏差 |

## 3. 详细问题

### MR-001：`architecture.attention` 完全不生效

**声明**

高层 schema 接受 `none`、`lightweight`、`full`，见 [`model_recipe_schema.json`](../py/schemas/model_recipe_schema.json#L100)。

**实际行为**

[`_compile_backbone()`](../py/model_recipe.py#L151) 不读取 `attention`。Transformer 始终构造相同的 `nn.TransformerEncoder`，见 [`build_model.py`](../py/factory/build_model.py#L987)；其他 backbone 也不会使用该字段。

**影响**

三个合法取值编译为同一个模型。搜索过程可能把无效变化当成新设计，实验记录也会错误归因。

**整改方式**

- 若当前版本不准备实现不同注意力路径，从 schema 和提示词删除该字段。
- 若保留，三个值必须产生不同的低层配置或模块结构。

**验收**

改变 `attention` 后，编译结果或模型结构必须变化；否则校验必须失败。

### MR-002：`output_distribution=gaussian` 没有形成概率输出

**声明**

`architecture.output_distribution` 接受 `gaussian`，见 [`model_recipe_schema.json`](../py/schemas/model_recipe_schema.json#L152)。编译器据此生成 Gaussian head，见 [`model_recipe.py`](../py/model_recipe.py#L231)。

**实际行为**

[`GaussianPointHead.forward()`](../py/factory/build_model.py#L746) 虽计算方差，却立即丢弃，只返回均值。训练端的 [`_build_train_loss()`](../py/train.py#L325) 没有 Gaussian NLL，预测路径也没有返回均值与尺度的分布接口。

**影响**

该字段不会产生可训练、可评估或可导出的 Gaussian 分布；方差分支没有有效监督。

**整改方式**

- 完整实现均值、正尺度输出和 Gaussian NLL；或
- 在完成前从 `output_distribution` 枚举中删除 `gaussian`。

**验收**

Gaussian 输出合同明确包含均值与尺度，且方差分支参数反向传播后获得非零梯度。

### MR-003：`embedding=invert` 没有实现变量 token

**声明**

ModelRecipe 将 `invert` 作为 embedding 选项，提示词也把它用于 variate-token modeling。

**实际行为**

[`_prepare_flat_series()`](../py/factory/build_model.py#L1170) 先把 `[B, L, C]` 变成 `[B*C, L]`。随后 [`InvertEmbedding`](../py/factory/build_model.py#L234) 将每条单变量序列投影成一个 `[B*C, 1, D]` token。

变量维在 embedding 前已经进入 batch，变量之间不会作为 token 参与 Transformer、RNN、SSM 或 Mixer 的主干计算。

**影响**

该字段当前更接近“每条单变量序列压缩为一个 token”，不是 inverted/variate-token 建模。字段名称、提示词假设与执行图不一致。

**整改方式**

- 保留字段名时，应让变量维作为 token 进入主干；或
- 若维持现有实现，删除 `invert` 选项，避免把它当作变量 token 机制。

### MR-004：`output_distribution` 与 `training.loss` 缺少兼容性校验

**声明**

两个字段分别独立枚举：

- `output_distribution`: point、quantile、gaussian；
- `loss`: mse、mae、huber、quantile、distillation。

schema 没有约束二者组合。

**实际行为**

- `output_distribution=quantile` 配 MSE/MAE/Huber 时，[`_point_prediction()`](../py/train.py#L314) 只取中间 quantile，其他 quantile 输出没有相应监督。
- `output_distribution=point` 配 quantile loss 时，训练路径只形成单个 0.5 quantile，和通常的多分位预测含义不同。
- `output_distribution=gaussian` 配任何现有 loss 都只训练均值。

**影响**

schema 合法不等于训练语义合法；部分组合会产生闲置输出参数或与字段名称不同的目标。

**整改方式**

不增加字段，只增加现有字段的组合校验。建议当前允许矩阵为：

| 输出分布 | 允许的 loss |
|---|---|
| point | mse、mae、huber、distillation |
| quantile | quantile |
| gaussian | 暂不允许，直至 Gaussian NLL 完成 |

### MR-005：显式 embedding 请求会被静默删除

**声明**

schema 允许任意 `embedding` 与任意 `backbone` 组合，没有跨字段限制。

**实际行为**

对 DLinear、TCN、N-BEATS、TimesNet，`_compile_embedding()` 无条件返回 `{"type": "none"}`，见 [`model_recipe.py`](../py/model_recipe.py#L122)。

因此以下配置均能通过高层 schema，但 embedding 会消失：

```json
{"backbone": "timesnet", "embedding": "frequency"}
```

```json
{"backbone": "temporal_conv", "embedding": "multiscale_patch"}
```

**影响**

实际模型与用户显式选择、hypothesis 和搜索记录不一致。

**整改方式**

- `embedding=auto` 可以由编译器选择 `none`。
- 任何显式非 `none` 请求若与 backbone 不兼容，都应在编译前报错，不能静默改写。

### MR-006：`multiscale_blocks` 同时控制两个不同机制

**声明**

字段名称表示多尺度块数，schema 允许 0–4。

**实际行为**

- [`_compile_embedding()`](../py/model_recipe.py#L122) 用它决定 multiscale patch 的尺度数量。
- [`_compile_backbone()`](../py/model_recipe.py#L151) 又在 `layers` 缺省时把它作为通用 backbone 深度。
- 内置 `DEFAULT_SCALES` 只有三项，因此 `multiscale_blocks=3` 与 `4` 生成相同的 embedding 尺度。
- 对强制 `embedding=none` 的原始序列 backbone，该字段仍可能改变 TCN 层数、N-BEATS block 数或 TimesNet 层数。

**影响**

一个字段同时改变 embedding 与 backbone，无法进行干净消融；值 4 又不能兑现四尺度语义。

**整改方式**

不新增字段：

- 让 `multiscale_blocks` 只控制 multiscale embedding；
- backbone 深度只使用已经存在的 `layers`；
- 如果暂不支持 4 个尺度，将 schema 最大值改为 3，或对 4 明确报错。

### MR-007：`heads` 会被静默递减

**声明**

`architecture.heads` 允许 1–32，`d_model` 允许 8–1024。schema 未要求整除关系。

**实际行为**

Transformer 编译时，如果 `d_model % heads != 0`，编译器循环减小 `heads` 直到可整除，见 [`model_recipe.py`](../py/model_recipe.py#L162)。例如 `d_model=64, heads=6` 会被改成 4。

**影响**

用户请求、候选记录和实际模型头数不同，且没有诊断信息。

**整改方式**

保留现有字段，但对不可整除组合直接报错。不要替用户选择另一个 head 数。

### MR-008：`input.covariates` 会覆盖显式 `channel_fusion=independent`

> 本项只讨论现有布尔字段与通道融合的编译关系，不讨论未来协变量的传递或消费。

**声明**

`channel_fusion` 明确允许 `independent` 和 `shared`。

**实际行为**

[`_compile_fusion()`](../py/model_recipe.py#L219) 使用如下条件：只要 `input.covariates` 为真，就编译成 `channel_mode="shared"`，即使用户显式指定了 `channel_fusion="independent"`。

**影响**

显式架构选择被另一个字段静默覆盖。`independent` 在存在协变量时不再具有字面语义。

**整改方式**

让显式 `channel_fusion` 始终优先；如果某种输入形式不支持 independent，应明确报错，而不是自动改为 shared。

### MR-009：`decomposition=true` 与 DLinear 造成双重分解

**声明**

schema 允许 `decomposition=true` 与 `backbone="dlinear"` 同时出现。

**实际行为**

- 编译器生成外部 `series_decomposition` preprocessing，见 [`model_recipe.py`](../py/model_recipe.py#L108)。
- [`DLinearCore`](../py/factory/build_model.py#L362) 内部再次执行 moving-average trend/seasonal decomposition。
- 提示词虽写有“不要组合”的自然语言警告，见 [`src/llm.js`](../src/llm.js#L402)，机器合同没有阻止。

**影响**

合法 recipe 可意外执行两次分解；正确性依赖 LLM 遵守提示，而不是 schema/编译器保证。

**整改方式**

对 `dlinear + decomposition=true` 明确报错，或在 schema 中禁止该组合。不要静默取消其中一个字段。

### MR-010：偶数 `decomposition_kernel` 被静默加一

**声明**

schema 接受 2–255 的所有整数，没有奇数限制。

**实际行为**

外部分解的 [`SeriesDecompositionAction`](../py/factory/build_model.py#L50) 和 [`DLinearCore`](../py/factory/build_model.py#L362) 都会把偶数 kernel 自动加一。例如 24 实际执行 25。

**影响**

recipe 记录的超参数与执行值不同，影响实验复现和参数搜索归因。

**整改方式**

将现有字段限制为奇数，偶数输入直接报错；或者真正实现保持序列长度的偶数窗口定义。不得继续静默修改。

### MR-011：已有预算与约束字段没有按声明执行

#### `training.time_budget_s`

编译器正确写入 `training_strategy.budget.time_budget_s`，但 [`resolve_recipe()`](../py/renderer.py#L39) 构造运行约束时使用固定的 `DEFAULT_TIME_BUDGET_S`，没有读取该值。训练端最终消费的是被替换后的运行约束。

结果：用户设置 60 秒或 1200 秒，正常运行时都可能仍使用全局默认值。

#### `constraints.max_latency_ms`

编译器将它写入低层 constraints，见 [`model_recipe.py`](../py/model_recipe.py#L268)，但 renderer 不把它带入运行约束，训练与验收也没有延迟测量或超限失败逻辑。

结果：该字段当前只存在于编译产物，不构成约束。

#### `constraints.max_params`

renderer 使用 `min(用户上限, DEFAULT_PARAM_BUDGET_M)`，见 [`renderer.py`](../py/renderer.py#L70)。小于全局上限时能正确收紧；大于全局上限时则被静默改小。

**整改方式**

- `time_budget_s` 应直接传递给运行约束。
- `max_latency_ms` 在实现测量与判定前应从 schema 删除，或明确拒绝非默认使用。
- 超过全局参数上限时明确报错并说明系统上限，不要静默 clamp。

### MR-012：`embedding=calendar` 实际是周期位置编码

**声明**

字段名称和提示词将其描述为 calendar embedding。

**实际行为**

[`CalendarEmbedding`](../py/factory/build_model.py#L262) 对 `0..input_len-1` 的位置索引按 24、7、31、12 等周期生成 sin/cos 特征。它没有读取样本的真实时间戳、小时、星期或月份。

**影响**

当窗口起点不同、采样频率不是小时级、存在缺测或不规则采样时，同一位置会获得相同“日历”表示。当前语义是 cyclic positional embedding，不是真实 calendar embedding。

**整改方式**

- 若保留 `calendar` 名称，必须基于真实日历值执行；或
- 在当前版本从 embedding 枚举删除 `calendar`。

本项不讨论未来协变量，只判断现有 `calendar` 字段名称与运行时语义是否一致。

## 4. 已检查且暂未发现明显不一致的字段

下列现有字段在当前执行链中有明确消费路径，暂不列为问题：

- `schema_version`、`model_name`、`hypothesis`、`notes`；
- `input.history_window`、`prediction_horizon`、`prediction_horizons`；
- `architecture.backbone`；
- 适用于对应 backbone 时的 `hidden_dim`、`d_model`、`layers`、`kernel_size`、`patch_len`、`stride`、`dropout`；
- `training.optimizer`、`learning_rate`、`weight_decay`、`batch_size`、`max_epochs`、`patience`、`seed`、`grad_clip`、`warmup_ratio`；
- `constraints.latency_sensitive` 会被编译为延迟优先级元数据，但它目前不是可执行的硬延迟约束。

这里的“暂未发现”不代表所有 backbone 下都适用。当前 schema 将多数架构参数设为全局可选字段，因此将参数放到不适用的 backbone 下通常会被忽略。建议采用下面的统一规则处理，而不是逐个增加新字段。

## 5. 统一整改规则

### 5.1 显式值不得静默改写

以下行为都应改为报错：

- 不兼容 backbone 的显式 embedding 被改为 `none`；
- `heads` 被自动递减；
- 偶数 `decomposition_kernel` 被加一；
- `max_params` 被全局上限静默 clamp；
- `channel_fusion=independent` 被 `covariates=true` 改为 shared。

### 5.2 每个已有字段必须满足“生效、报错或删除”

对 `model_recipe_schema.json` 的每个字段进行 mutation test：

```text
改变合法字段值
  ├─ 编译产物或运行时结构/行为发生可观测变化 → 通过
  ├─ 当前组合不支持并给出明确错误              → 通过
  └─ 输出不变且没有错误                          → 不一致
```

### 5.3 增加现有字段之间的组合校验

至少覆盖：

- `embedding × backbone`；
- `d_model × heads`；
- `decomposition × backbone`；
- `output_distribution × loss`；
- `covariates × channel_fusion`；
- backbone 与其适用参数。

### 5.4 执行清单记录最终值

在修复完成前，执行清单至少应记录编译后的实际 heads、kernel、embedding、融合方式和预算，并与原始 ModelRecipe 比较；发现静默差异即阻止运行。

## 6. 建议整改顺序

1. **先删除虚假有效性**：处理 `attention` 和未完成的 Gaussian。
2. **阻止训练语义错误**：增加 `output_distribution × loss` 组合校验。
3. **消除静默改写**：embedding、heads、channel fusion、kernel、参数预算。
4. **修复参数串义**：让 `multiscale_blocks` 不再充当 `layers`。
5. **修复运行约束传递**：`time_budget_s`、`max_latency_ms`、全局参数上限诊断。
6. **校准机制名称**：`invert` 和 `calendar` 要么兑现当前名称，要么从现有枚举移除。

## 7. 完成定义

在不增加 ModelRecipe 字段的前提下，满足以下条件即可视为本轮一致性整改完成：

1. schema 中每个现有字段都被消费，或在不适用组合下明确报错。
2. 编译器不再静默替换任何显式值。
3. `output_distribution` 与 `loss` 的合法组合可机器验证。
4. 运行时预算与 ModelRecipe 声明一致；未实现的硬约束不再对外宣称有效。
5. `invert`、`calendar`、`gaussian` 等机制名称与实际执行语义一致。
6. 全部规则有 schema/编译/运行时三级回归测试。

未来协变量问题继续独立跟踪，不计入以上完成定义。
