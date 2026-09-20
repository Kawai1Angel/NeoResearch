# ModelRecipe 机制—论文覆盖审查

> 审查日期：2026-09-20  
> ModelRecipe 合同：`py/schemas/model_recipe_schema.json`  
> 文献快照：`.neo-cast/literature-source/catalog/papers.jsonl`，共 640 篇，其中 26 篇为 1964–2022 historical foundations。  
> 补强检索：期刊/会议官方页面、出版社 DOI 元数据和正式 proceedings。  
> 排除项：未来协变量；`none`/`auto` 控制值；纯尺寸超参数；预算和部署约束。

## 1. 统计口径

本报告把会改变模型结构、数据表征、通道融合、输出分布或训练目标的 ModelRecipe 现有取值视为一个“机制项”。同一概念出现在不同合同位置时分别计数，例如 quantile distribution 和 quantile loss 是两个机制项。

覆盖状态定义：

- **直接覆盖**：当前目录中存在明确研究该模型或机制的时序预测论文。
- **间接覆盖**：存在强相关论文，但论文机制与 ModelRecipe 的宽泛名称或当前参数化不完全等价。
- **通用基础项**：没有目录内专门论文，但属于通用预测定义或基础损失，不应据此判断时序文献缺口。
- **未覆盖**：当前目录中没有找到足以支持该机制的论文记录。

这是一份“目录级机制映射”，不是对 640 篇目录记录逐篇全文标注。直接覆盖优先使用论文标题、模型名称和已知核心机制；无法确认精确等价时降级为间接覆盖。

## 2. 总体结果

共统计 **31 个机制项**：

| 状态 | 数量 | 占全部 31 项 |
|---|---:|---:|
| 直接覆盖 | 28 | 90.3% |
| 间接覆盖 | 0 | 0.0% |
| 通用基础项 | 3 | 9.7% |
| 未覆盖 | 0 | 0.0% |

排除 point、MSE、MAE 三个通用基础项后，共有 **28 个研究型机制项**：

- 直接覆盖：28/28，**100%**；
- 完全未覆盖：0/28，**0%**。

## 3. 本轮已补强的机制

### `training.loss = huber`

**状态：直接覆盖**

本轮向 historical foundations 补入了 Huber loss 的原始依据、现代统计理论和直接时序预测应用：

| 目录记录 | 论文 | 权威性与用途 |
|---|---|---|
| `tsf-1964-a6797e9fe718` | [Huber, *Robust Estimation of a Location Parameter*, 1964](https://doi.org/10.1214/aoms/1177703732) | Huber loss/M-estimation 的原始经典论文；*The Annals of Mathematical Statistics* |
| `tsf-2020-7905a5fd3b88` | [Hao, Zhao & Wang, *Forecasting the real prices of crude oil using robust regression models with regularization constraints*, 2020](https://doi.org/10.1016/j.eneco.2020.104683) | *Energy Economics* 正式期刊论文，明确使用 Huber loss 进行样本外时间序列预测 |
| `tsf-2020-ef2d99a2daa2` | [Sun, Zhou & Fan, *Adaptive Huber Regression*, 2020](https://doi.org/10.1080/01621459.2018.1543124) | *Journal of the American Statistical Association*；为重尾数据下 Huber regression 提供现代统计理论 |

三篇均通过出版社 DOI 元数据核验并保持 `journal` track。Huber 1964 与 Hao et al. 2020 解决“原始方法归属 + 时间序列直接证据”，Adaptive Huber Regression 补充重尾数据下的现代理论。因此 Huber 已由“未覆盖”升级为“直接覆盖”。当前没有为这三篇登记可由构建器稳定取得的合法 PDF；目录会诚实记录为 `no_public_pdf`。

## 4. 原先薄弱、经权威来源核验后可直接覆盖的机制

实现一致性采用三级标记：`paper_exact` 表示核心计算图与论文一致；`paper_derived` 表示保留核心机制但为了组合能力有所扩展；`custom` 表示工程扩展。目录级“直接覆盖”只回答是否存在论文依据，不自动等于 `paper_exact`。

| ModelRecipe 机制 | 权威对应论文 | 覆盖依据 |
|---|---|---|
| `architecture.attention=lightweight` | [Linear Transformer, ICML 2020](https://arxiv.org/abs/2006.16236) | 当前实现采用 ELU+1 正特征映射与矩阵乘法结合律实现线性复杂度 attention，标记为 `paper_derived`。LogTrans、Informer 和 Pyraformer仅保留为轻量时序 attention 家族背景，不再作为当前算法的直接实现依据 |
| `architecture.channel_fusion=gated_hybrid` | `tsf-2021-457cad6723e1` [Temporal Fusion Transformer, IJF 2021](https://doi.org/10.1016/j.ijforecast.2021.03.012) | TFT 为 gating 与变量融合提供机制依据；当前仅保留 residual gate，标记为 `paper_derived`，不等同于完整 TFT |
| `architecture.output_distribution=gaussian` | `tsf-2020-0d6e52f8db41` [DeepAR, IJF 2020](https://doi.org/10.1016/j.ijforecast.2019.07.001) | DeepAR 为 Gaussian likelihood 提供直接依据；当前用 softplus 参数化方差后开方得到标准差，并直接输出多步对角分布，标记为 `paper_derived` |

因此，Gaussian 与 gated hybrid 仍有直接机制依据，但均不标记为完整论文复现；`lightweight` 的实现合同已明确为 kernel linear attention，不能将实验结果归因于 ProbSparse、LogSparse 或 pyramidal attention。

## 5. 已有直接论文覆盖的机制

### 5.1 结构与全局机制

| ModelRecipe 机制 | 状态 | 代表论文记录 |
|---|---|---|
| `decomposition=true` | 直接覆盖 | `tsf-2021-573d5a46f739` Autoformer；`tsf-2022-49ef214b7314` FEDformer；`tsf-2024-bc9830c69d8c` TimeMixer |
| `multiscale_blocks>0` | `paper_derived` | `tsf-2024-81d89be55a54` Pathformer；`tsf-2023-1d41be144a74` Scaleformer。当前实现具有分尺度 patch 分支、尺度身份和跨尺度融合，但不复现 adaptive pathways 或迭代预测细化 |
| `attention=full` | 直接覆盖 | `tsf-2024-8ca54a57a05d` *Are Self-Attentions Effective for Time Series Forecasting?*；`tsf-2019-58a027d76dae` TPA-LSTM |
| `attention=lightweight` | `paper_derived` | [Linear Transformer](https://arxiv.org/abs/2006.16236)；LogTrans、Informer、Pyraformer 仅作相关机制背景 |

说明：`attention=none` 是关闭机制的控制值，不计入覆盖率。

### 5.2 Embedding

| ModelRecipe 机制 | 状态 | 代表论文记录 |
|---|---|---|
| `embedding=patch` | 直接覆盖 | `tsf-2023-5b92d321a75b` PatchTST，*A Time Series is Worth 64 Words* |
| `embedding=multiscale_patch` | 直接覆盖 | `tsf-2026-5373d3619110` *Multi-Scale Patch Recursion*；`tsf-2024-6b78d05017b6` HDMixer |
| `embedding=invert` | `paper_exact` / `paper_derived` | `tsf-2024-377434807809` iTransformer；Transformer+full+independent fusion 路径对齐核心计算图，叠加其他 fusion/preprocessing 或改用其他 backbone 时为派生扩展 |
| `embedding=frequency` | 直接覆盖 | `tsf-2022-49ef214b7314` FEDformer；`tsf-2023-166d9ed96ceb` FreTS |
| `embedding=calendar` | `paper_derived` | `tsf-2021-2e806d4bfdc1` Informer temporal embedding。当前是周期日历协变量 embedding，不是 GLAFF 的独立 timestamp 全局分支与自适应融合 |

这里的“直接覆盖”表示论文明确覆盖相应表征思路，不表示当前代码已经忠实复现论文实现。

### 5.3 Backbone

| ModelRecipe 机制 | 状态 | 代表论文记录 |
|---|---|---|
| `backbone=linear` | 直接覆盖 | `tsf-2024-122aec87c615` *An Analysis of Linear Time Series Forecasting Models* |
| `backbone=mlp` | 直接覆盖 | `tsf-2023-e9f68dfbe1fc` TSMixer；`tsf-2023-166d9ed96ceb` FreTS |
| `backbone=transformer` | 直接覆盖 | `tsf-2023-5b92d321a75b` PatchTST；`tsf-2021-2e806d4bfdc1` Informer |
| `backbone=temporal_conv` | 直接覆盖 | `tsf-2022-0c10635342b5` SCINet；`tsf-2023-5f9bf1c14bdd` MICN |
| `backbone=dlinear` | 直接覆盖 | `tsf-2023-02ee589196be` *Are Transformers Effective for Time Series Forecasting?* |
| `backbone=nbeats` | 直接覆盖 | `tsf-2020-d861326263db` N-BEATS |
| `backbone=timesnet` | 直接覆盖 | `tsf-2023-db842b3fd591` TimesNet |
| `backbone=rnn` | 直接覆盖 | `tsf-2020-0d6e52f8db41` DeepAR；`tsf-2019-58a027d76dae` TPA-LSTM |
| `backbone=ssm` | 直接覆盖 | `tsf-2025-9982bd073b30` SDE；`tsf-2018-b6b1aa73ba72` Deep State Space Models |
| `backbone=mixer` | 直接覆盖 | `tsf-2023-e9f68dfbe1fc` TSMixer；`tsf-2024-bc9830c69d8c` TimeMixer |

Backbone 覆盖为 **10/10**。其中 `temporal_conv` 与 `ssm` 是模型家族级直接覆盖，不代表当前 runtime block 与某篇论文结构完全一致。

### 5.4 Channel fusion

| ModelRecipe 机制 | 状态 | 代表论文记录 |
|---|---|---|
| `channel_fusion=independent` | 直接覆盖 | `tsf-2023-5b92d321a75b` PatchTST；`tsf-2023-02ee589196be` DLinear |
| `channel_fusion=shared` | 直接覆盖 | `tsf-2023-262e2d29cb03` Crossformer；`tsf-2023-e9f68dfbe1fc` TSMixer |
| `channel_fusion=feature` | 直接覆盖 | `tsf-2024-819392e3c1ca` SOFTS；`tsf-2023-e9f68dfbe1fc` TSMixer |
| `channel_fusion=gated_hybrid` | `paper_derived` | `tsf-2021-457cad6723e1` Temporal Fusion Transformer；当前仅采用 residual gating，不声称复现完整 TFT 变量选择与时序骨干 |

### 5.5 输出分布

| ModelRecipe 机制 | 状态 | 代表论文记录 |
|---|---|---|
| `output_distribution=point` | 通用基础项 | 点预测是默认任务定义，不对应单一模型论文 |
| `output_distribution=quantile` | 直接覆盖 | `tsf-2025-c0131f5ae1ef` QuantileFormer；`tsf-2021-457cad6723e1` TFT |
| `output_distribution=gaussian` | `paper_derived` | `tsf-2020-0d6e52f8db41` DeepAR；`tsf-2018-b6b1aa73ba72` Deep State Space Models。当前为直接多步 diagonal Gaussian likelihood head，不是 DeepAR 自回归结构 |

### 5.6 Loss

| ModelRecipe 机制 | 状态 | 代表论文记录或说明 |
|---|---|---|
| `loss=mse` | 通用基础项 | 通用回归目标，不要求时序专门论文 |
| `loss=mae` | 通用基础项 | 通用回归目标，不要求时序专门论文 |
| `loss=huber` | 直接覆盖 | `tsf-1964-a6797e9fe718` Huber 原始论文；`tsf-2020-7905a5fd3b88` 直接时序预测应用；`tsf-2020-ef2d99a2daa2` Adaptive Huber Regression |
| `loss=quantile` | 直接覆盖 | `tsf-2025-c0131f5ae1ef` QuantileFormer；`tsf-2021-457cad6723e1` TFT |
| `loss=distillation` | 直接覆盖 | `tsf-2026-30b49f913bcf` TimeDistill；另有 S²-KD 等记录 |

## 6. 不计入机制覆盖率的已有字段

以下字段存在于 ModelRecipe，但不纳入 31 项机制统计：

| 类别 | 字段/取值 | 原因 |
|---|---|---|
| 控制值 | `embedding=none/auto`、`attention=none` | 表示关闭机制或交给编译器选择，不是研究机制 |
| 优化器 | SGD、Adam、AdamW | 通用优化基础设施；当前时序目录并未收录其原始优化论文 |
| 容量参数 | hidden dim、d_model、layers、heads、kernel、patch length、stride、dropout | 超参数，不对应独立论文机制 |
| 训练预算 | batch size、epochs、patience、seed、warmup ratio、grad clip | 训练控制项，不属于时序机制覆盖 |
| 约束 | max params、latency flags/limits | 系统与部署约束，不属于论文机制 |

若采用“每个枚举值都必须有引用”的最严格口径，则 SGD、Adam、AdamW 以及 MSE、MAE 也缺少当前目录内的原始方法论文。但这些不应与 Huber 的时序机制追溯缺口混为一谈，建议放在通用 ML 基础参考库，而不是 forecasting 主目录。

## 7. 已补入的经典方法学基础

除 Huber 外，本轮还把以下经典论文写入 historical foundations，使 loss/output 引用链从“现代模型论文”延伸到“方法原始依据”：

| 对应机制 | 目录记录与经典论文 | 价值 |
|---|---|---|
| point / MSE / MAE | `tsf-2011-b362ba033a6d` [Gneiting, *Making and Evaluating Point Forecasts*, JASA 2011](https://doi.org/10.1198/jasa.2011.r10138) | 系统说明损失函数与最优点预测统计量之间的关系，覆盖 squared/absolute error 的正确解释 |
| quantile loss | `tsf-1978-8c44dce7823c` [Koenker & Bassett, *Regression Quantiles*, Econometrica 1978](https://doi.org/10.2307/1913643) | 分位回归的经典原始论文 |
| 概率输出与评估 | `tsf-2007-c5446981fcfe` [Gneiting & Raftery, *Strictly Proper Scoring Rules, Prediction, and Estimation*, JASA 2007](https://doi.org/10.1198/016214506000001437) | 概率预测、log score、CRPS 与 proper scoring rule 的权威基础 |

这三篇均通过 DOI 元数据核验并成功缓存公开 PDF。historical foundations 的明确 allowlist 边界已从 2018 调整到 1964，类别也扩展为方法学基础；2023+ 主目录政策没有改变。

## 8. 结论

ModelRecipe 并不存在大面积“有机制、无论文”的问题：

- 10 个 backbone 全部有代表论文；
- 5 个非空 embedding 全部有代表论文；
- decomposition、多尺度、完整 attention 和轻量 attention 均有正式会议论文直接覆盖；
- 4 个 channel fusion 机制均有直接机制依据；
- quantile、Gaussian 与 distillation 均有正式论文直接覆盖；
- **Huber loss 已完成“原始方法 + 现代理论 + 时序直接应用”的三层补强。**

ModelRecipe 的 28 个研究型机制现在达到 **28/28（100%）目录级文献覆盖**。目录共 640 篇；26 篇 historical foundations 中 25 篇通过正式 proceedings 或出版社元数据核验，新增 6 篇全部为 `publisher_metadata`。Gaussian、gated hybrid 和 lightweight attention 无需继续扩大检索。

需要注意，论文覆盖不等于实现忠实度。某个字段有相关论文，只说明文献源中存在理论或模型依据；当前代码是否复现该论文机制，应由独立的实现一致性审查判断。
