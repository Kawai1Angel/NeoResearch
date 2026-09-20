# NeoResearch 最终 Selected 模型预测质量瓶颈分析

> **历史版本，不再代表最新运行结论。** 本文主表使用 2026-07-06–07 的 fixed-split 任务。最新三数据集结论请以 `NeoResearch_最新运行selected测试性能综合分析_20260911.md` 为准。

分析日期：2026-09-10  
分析对象：NeoResearch 在 ETTh1、sunny power、windy power 三个完整任务中最终发布的 selected/champion 模型，以及 sunny power 上后续引入 expanding-window K-fold 后的回归结果。  
“性能”定义：最终冻结模型在严格保留的 `ref_test`/test 上的预测质量，不讨论训练速度、显存或 CLI 吞吐。

## 1. 结论摘要

从最终预测质量看，NeoResearch 的搜索**确实能找到比 baseline 更好的模型**，但未能稳定地把已经找到的最好模型选为 selected。因此，当前首要瓶颈不是“探索不出好模型”，而是**候选选择指标与未来测试区间的排序不一致**。

以 test MSE 为主指标，三项 fixed-split 任务的核心结果是：

| 数据集 | baseline test MSE | selected test MSE | selected 超 baseline | 探索期事后最优 test MSE | 最优超 baseline | selected 相对最优的劣化 | test MSE 超 baseline 的探索模型 |
|---|---:|---:|---:|---:|---:|---:|---:|
| ETTh1 | 0.120613 | 0.098523 | 18.31% | 0.091621 | 24.04% | +7.53% | 19 / 24（79.2%） |
| sunny | 0.381450 | 0.343447 | 9.96% | 0.290171 | 23.93% | +18.36% | 10 / 24（41.7%） |
| windy | 1.457120 | 1.388087 | 4.74% | 1.341241 | 7.95% | +3.49% | 21 / 24（87.5%） |

合计 72 个非 baseline 探索模型中，**50 个（69.4%）在最终 test MSE 上超过 baseline**。然而 selected 只捕获了当前候选集中可实现 MSE 改善的 76.2%（ETTh1）、41.6%（sunny）和 59.6%（windy）。sunny 是选模损失最大的任务：搜索期最优可改善 23.93%，最终 selected 只改善 9.96%。

这里的 “test oracle” 只用于离线诊断，即在已经完成的 25 个候选中事后找到 test MSE 最低者；它不能用于在线选模，否则会污染 `ref_test`。

最重要的五点判断如下：

1. **P0：selection protocol 是最大瓶颈。** ETTh1、sunny、windy 的 val→test Spearman 排名相关分别为 0.866、0.392、0.316。探索候选已大量超过 baseline，但 selected 在 test 上只排第 10、6、16；ETTh1 总体相关性尚可，但 top-1 仍错位，sunny 和 windy 的验证集不足以可靠区分顶部候选。
2. **P0：时间分布漂移没有进入选择目标。** selected 的 test 相对 val，ETTh1 恶化 52.93%，windy 恶化 25.88%；sunny 的 test 反而比 val 容易 25.09%。三个任务的漂移方向都不同，说明单个固定 val block 不是稳定的未来代理。
3. **P0：任务契约可能在进入搜索前丢失关键信号。** windy 原始 CSV 有风速、风向、温度等 6 个外生列，但任务最终被定义成 target-only；selected artifact 的输入只有 `real_power` 一个通道。对 H96 风电预测，这是比换 backbone 更根本的上限。
4. **P1：当前“稳健性验证”不足。** 三个最终 artifact 都只对应一个 checkpoint/seed；windy 模型虽命名为 `multiseed_robustness`，最终发布的实际 recipe 仅运行了 seed=99，没有形成 3-seed 均值、标准差或模型选择规则。
5. **P1：搜索空间的有效多样性不足。** 25 个候选中，ETTh1、sunny、windy 分别只有 20、23、21 组不同的 `(train,val,test)` MSE 三元组；多组声明不同的 recipe 得到完全相同的结果，表明部分 action 没有产生有效行为差异，或重复实验占用了搜索预算。

因此，近期最值得投入的方向是：**重做不触碰 ref-test 的时间外推选模协议、修复数据/协变量契约、增加多 seed 和行为等价去重**。继续横向增加新 backbone 的优先级较低。

## 2. 证据范围与口径

### 2.1 核心运行

本报告使用三个 NeoResearch 完整任务，每个任务 25 个 full-run checkpoint：

| 数据集 | Task ID | 数据 | 输入/预测长度 | 选择指标 |
|---|---|---|---|---|
| ETTh1 | `rtsk_f365a1d5e0010W7eUFTNZV7bft` | `ETTh1.csv`, target=`OT` | 336 / 96 | fixed-split `val_avg_mse` |
| sunny | `rtsk_f3726e0cd001ncaVyZUl9hVL7J` | `sunny_power_full.csv`, target=`real_power` | 336 / 96 | fixed-split `val_avg_mse` |
| windy | `rtsk_f38056b41001pi4xHz0xS4Sr44` | `windy_power_full.csv`, target=`real_power` | 336 / 96 | fixed-split `val_avg_mse` |

核心明细来自：

- `opencode/packages/opencode/tmp/full_run_checkpoint_eval_rtsk_f365a1d5e_ETTh1_train_val_test_gpu.csv`
- `opencode/packages/opencode/tmp/full_run_checkpoint_eval_rtsk_f3726e0cd_sunny_train_val_test_gpu.csv`
- `opencode/packages/opencode/tmp/full_run_checkpoint_eval_rtsk_f38056b41_windy_train_val_test_gpu.csv`
- 各任务的 `results/champion.json`、`model/metadata.json` 和 `reports/final_report.md`

### 2.2 指标解释

- 本文的 baseline 是每项任务中设计顺序第 1 的完整运行，其余设计顺序 2–25 计为 24 个探索模型；这是 NeoResearch 的任务内部 baseline，不等同于公开 benchmark 的全球 SOTA baseline。
- 所有 MSE/MAE 均在各任务自己的 train-fitted standard scaling 空间中计算。
- **不同数据集之间不能用 MSE 绝对值直接比较难度**；只能比较同一数据集内模型、split 和基线的相对变化。
- 三个任务都只有 H96，因此 `avg` 与 `h96` 完全相同，当前结果不能支持“不同 horizon 的退化曲线”分析。
- 现有发布物只有聚合 MSE/MAE，没有逐时间点预测、逐步长误差或峰谷分段误差。因此本文能定位选择与泛化瓶颈，但不能精确回答误差集中在夜间、爬坡段、峰值还是第 72–96 步。

### 2.3 Test 指标来源复核

本文的 test 结果确实来自严格保留的 `ref_test` 区间，不是 val 结果或训练过程中的 champion score。复核链路如下：

1. `evaluate-full-run-checkpoints.py` 对每个 full-run checkpoint 调用 `evaluate_ref_test_tsf(...)`；
2. 函数返回的原始字段是 `ref_test_avg_mse` 和 `ref_test_avg_mae`；
3. 导出脚本只是将这两个字段原样复制为 `test_avg_mse` 和 `test_avg_mae`；
4. 对三项任务的 75 个 checkpoint 逐行复核，`test_avg_* == ref_test_avg_*` 全部成立。

实际 `ref_test` 原始行区间为：

| 数据集 | train | val | ref_test |
|---|---:|---:|---:|
| ETTh1 | `[0, 12194)` | `[12194, 13936)` | `[13936, 17420)` |
| sunny | `[0, 16867)` | `[16867, 19277)` | `[19277, 24096)` |
| windy | `[0, 16867)` | `[16867, 19277)` | `[19277, 24096)` |

baseline、selected 和其余 24 个探索候选均使用同一任务的上述 `ref_test` 区间、同一 scaler 和同一评估函数。

## 3. Fixed-split 三项任务的量化结果

### 3.1 Selected 相对首个基线

| 数据集 | baseline test MSE | selected test MSE | MSE 改善 | baseline test MAE | selected test MAE | MAE 改善 |
|---|---:|---:|---:|---:|---:|---:|
| ETTh1 | 0.120613 | 0.098523 | 18.31% | 0.262267 | 0.242039 | 7.71% |
| sunny | 0.381450 | 0.343447 | 9.96% | 0.421452 | 0.393267 | 6.69% |
| windy | 1.457120 | 1.388087 | 4.74% | 0.797759 | 0.876752 | **-9.90%** |

这说明系统的搜索不是完全无效：三个 selected 的 test MSE 都优于首个设计基线。但收益不稳定，且 windy 出现 MSE 改善、MAE 反而恶化的指标冲突。windy selected 可能减少了少量大误差，从而改善平方损失，同时增加了大量普通样本的绝对误差。只按 MSE 排序无法约束这种退化。

因此，验收结论取决于“最终指标”的严格定义：

- 若唯一主指标是 **test MSE**，三个 selected 都超过 baseline；
- 若要求 **test MSE 和 test MAE 都不退化**，ETTh1 和 sunny 通过，windy 失败；
- 若项目另有未写入当前 artifact 的最终指标，则需用该指标重新评估，不能由 MSE 结果代替。

### 3.2 探索期最优性能相对 baseline

下表的“探索最优”是在其余 24 个候选中，事后按严格保留 test MSE 取最小值。它用于衡量搜索空间已经找到的上限，不能作为实际选模方法。

| 数据集 | 探索最优设计顺序 | 主要结构 | baseline test MSE | 探索最优 test MSE | 相对 baseline 改善 | 对应 test MAE |
|---|---:|---|---:|---:|---:|---:|
| ETTh1 | 17 | InstanceNorm + independent Linear + Huber | 0.120613 | 0.091621 | 24.04% | 0.232176 |
| sunny | 21 | iTransformer 类 variate-token Transformer | 0.381450 | 0.290171 | 23.93% | 0.352005 |
| windy | 12 | SSM(state=64) + graph fusion | 1.457120 | 1.341241 | 7.95% | 0.846232 |

三项任务都已经探索到明显优于 baseline 的候选；ETTh1 和 sunny 的搜索上限提升均约 24%。因此，当前不应把主要问题归因为搜索空间太弱。更直接的损失发生在“已找到”到“最终选中”之间：

- ETTh1 selected 仅实现了可用 MSE 改善的 76.2%；
- sunny 仅实现 41.6%，是三者中选择效率最低的；
- windy 实现 59.6%，同时 selected MAE 退化，说明仅用 MSE 衡量“最优”也不充分。

### 3.3 最终超过 baseline 的探索模型数量

统计对象为每项任务的 24 个非 baseline 候选；“超过”指最终 test 指标严格小于同任务 baseline，相等不计入。

| 数据集 | val MSE 超 baseline | test MSE 超 baseline | test MAE 超 baseline | MSE、MAE 同时超 baseline |
|---|---:|---:|---:|---:|
| ETTh1 | 18 / 24（75.0%） | 19 / 24（79.2%） | 19 / 24（79.2%） | 19 / 24（79.2%） |
| sunny | 24 / 24（100.0%） | 10 / 24（41.7%） | 15 / 24（62.5%） | 10 / 24（41.7%） |
| windy | 23 / 24（95.8%） | 21 / 24（87.5%） | 0 / 24（0.0%） | 0 / 24（0.0%） |
| **合计** | **65 / 72（90.3%）** | **50 / 72（69.4%）** | **34 / 72（47.2%）** | **29 / 72（40.3%）** |

这组数据给出了比单看 selected 更完整的判断：

1. **搜索有产出能力。** 总计 69.4% 的探索候选在 test MSE 上超 baseline，并非只有极少数偶然成功的模型。
2. **sunny 最能暴露 val 过度乐观。** 24/24 在 val MSE 上都超 baseline，到 test 只剩 10/24；候选是否改善的判断有 14 个在时间外推后翻转。
3. **windy 的 MSE 胜率需要谨慎解读。** 21/24 的 MSE 更好，但没有任何一个探索模型的 MAE 超过 baseline。这证明搜索结果存在系统性的 MSE–MAE 取舍，而不是对所有误差口径的无条件改善。由于当前缺少逐样本预测误差，还不能确定该取舍是否具体来自“少量大误差降低、大量普通误差升高”。
4. **全局上只有 29/72（40.3%）同时改善 MSE 和 MAE。** 如果产品目标不允许平均绝对误差退化，则真正可视为“全面超过 baseline”的候选比例应按 40.3% 而非 69.4% 理解。

### 3.4 验证排序能否预测测试排序

| 数据集 | Pearson(val,test) | Spearman(val,test) | selected val 排名 | selected test 排名 | val 第一领先第二 |
|---|---:|---:|---:|---:|---:|
| ETTh1 | 0.847 | 0.866 | 1 / 25 | 10 / 25 | 2.276% |
| sunny | 0.409 | 0.392 | 1 / 25 | 6 / 25 | **0.0015%** |
| windy | 0.673 | 0.316 | 1 / 25 | 16 / 25 | 0.198% |

解释：

- Pearson 衡量数值线性关系，Spearman 更接近“用 val 排名能否选中 test 好模型”这一实际问题。
- sunny 的第一、第二名 val MSE 只差 `0.00000694`，相对差 0.0015%，远小于一个单 seed 训练通常需要警惕的随机波动量级；当前系统却把它当成确定性胜负。
- windy 的 selected 在 val 上第一，但在 test 上仅第 16。Pearson 看似有 0.673，主要说明差模型往往仍然差；顶部候选的次序由 Spearman 0.316 更真实地暴露出来。
- ETTh1 的整体排序较好，但 val 第一的 TimesNet 在 test 上仍被多组简单 NLinear/线性配置反超。

### 3.5 Split 间泛化差距

| 数据集 | selected train MSE | selected val MSE | selected test MSE | test 相对 val |
|---|---:|---:|---:|---:|
| ETTh1 | 0.156927 | 0.064425 | 0.098523 | +52.93% |
| sunny | 0.238772 | 0.458459 | 0.343447 | -25.09% |
| windy | 0.701963 | 1.102690 | 1.388087 | +25.88% |

这里不能简单把差距解释成常规过拟合：ETTh1 的 train MSE 反而高于 val MSE，sunny 的 test 又明显比 val 容易。更合理的解释是三个时间区间的目标尺度、波动性和事件组成不同，固定 block 指标主要反映区间难度，而不是稳定的模型能力。

## 4. 分数据集分析

### 4.1 ETTh1：架构搜索有效，但 top-1 选择过度偏向 val

最终 selected：

- recipe：`recipe_timesnet_freq_dual_scale_v1`
- 结构：`instance_norm -> TimesNet -> temporal fusion -> linear head`
- 参数量：1.672419M
- 输入：`OT` + 6 个 observed-past covariates
- val MSE：0.064425
- test MSE / MAE：0.098523 / 0.242039

积极结果：相对首个 DLinear 基线，test MSE 改善 18.31%，说明周期建模与归一化确实带来收益。

但它并不是已运行候选中的 test 最优。事后 test 最优候选的 MSE 为 0.091621，val MSE 0.067389，只排 val 第 10；selected 的 test MSE 比它高 7.53%。此外，多组 NLinear 配置以约 0.065927 的 val MSE、0.091748 的 test MSE稳定复现，也优于最终 TimesNet。

因此 ETTh1 的瓶颈不是“搜不到强模型”，而是：

1. val 上 2.28% 的优势不能保证下一个时间区间仍成立；
2. 选择器没有奖励跨重复运行稳定复现的 NLinear 平台；
3. 没有把模型复杂度和鲁棒性纳入接近候选的 tie-break。1.67M TimesNet 在 test 上输给更简单的线性族时，继续放大模型容量没有证据支持。

建议：ETTh1 应以 recent-fold/worst-fold 稳健分数选择，在误差差距落入统计等价区间时优先选择多次复现、参数更少的候选。

### 4.2 sunny：单 fixed val 的排序能力弱，后续 K-fold 也未解决

fixed-split 最终 selected：

- recipe：`recipe_dlinear_invert_residual_v14`
- 结构：`series_decomposition -> DLinear -> feature fusion -> residual_correction`
- 参数量：0.077575M
- 输入：target + 6 个 observed-past weather covariates
- val MSE：0.458459
- test MSE / MAE：0.343447 / 0.393267

该模型相对首个基线的 test MSE 改善 9.96%，但只排 test 第 6。事后 test 最优是一个 val MSE 为 0.516515 的 iTransformer 类候选，test MSE 为 0.290171；它在 val 仅排第 8，却比 selected 的 test MSE 低 15.51%。

sunny 任务中 25 个候选的平均 `test - val` MSE 为 -0.207，所有候选在 test 上都比 val 更容易。也就是说，当前 val block 的难度或数据机制与 ref-test 明显不同。此时继续围绕 val 的小数点后三位做优化，容易优化特定区间而非真正的未来泛化。

#### K-fold 回归证据

后续 sunny 任务引入 4-fold expanding-window CV 后，问题仍存在：

- 23 个 full 尝试中仅 14 个具有可用 checkpoint，9 个因临时 fold 目录缺少 `model.pt` 无法复评，失败率 39.1%。
- 14 个可比候选中，`cv_avg_mse` 与 test MSE 的 Spearman 相关为 **-0.161**；原始 val 与 test 的 Spearman 为 **-0.333**。
- CV selected `recipe_tide_lr_half_v2`：CV MSE 0.375472，test MSE 0.360419。
- 同轮 DLinear baseline：CV MSE 0.443052，test MSE 0.297325。按 CV 选择的模型在 test 上反而比 baseline 差 21.22%。
- 后续 `recipe_mlp_residual_correction_v15` 的 CV MSE 0.383035，比 CV champion 差 2.01%，但 test MSE 0.315776，比 CV champion 好 12.39%。它仍比 DLinear baseline 的 test MSE 高 6.21%。

这说明“从一个 fixed val 改成所有历史 fold 的简单均值”还不够。当前 4 个 fold 等权平均，早期区间对分数影响过大；但生产目标是外推到可见区间之后，越靠近时间边界的 fold 通常越有代表性。

sunny 的下一步不应只是增加 fold 数，而应测试：

- recent-weighted CV；
- 只用最后一到两个 pseudo-future fold 作为主排序，较早 fold 作为稳定性约束；
- `mean + λ·std` 或 `max(fold_mse)` 风险分数；
- 按白天/夜间、日出日落爬坡和高功率区间分别报告误差；
- 从 timestamp 自动构造可在预测时确定的 calendar future features。当前没有 known-future covariates，模型无法显式知道未来 96 个 15 分钟点对应的时刻。

### 4.3 windy：上限首先受任务输入约束，而不是 SSM 容量

最终 selected：

- recipe：`recipe_ssm_champion_multiseed_robustness_v17`
- 结构：`none -> SSM(state_dim=96, depth=2) -> graph fusion -> direct_multi_horizon`
- 参数量：0.048485M
- 输入：仅 `real_power`，没有任何外生变量
- val MSE：1.102690
- test MSE / MAE：1.388087 / 0.876752

主要问题有三层。

第一，任务契约将 windy 定义为 target-only。原 CSV 明明包含 `wind_speed_80m`、`wind_direction_80m`、温度、湿度、辐射和降水，但最终 task spec 的 `observedPastCovariates` 和 `knownFutureCovariates` 都为空；artifact 的 `model_input_channels=1`、`past_exogenous_channels=0` 也证实这些列没有进入模型。对 24 小时 H96 风电预测，仅依赖历史功率很难预测由未来风况变化引起的爬坡事件。

第二，selected 的 graph fusion 在单通道输入下基本失去“变量图”的意义。此处继续调 graph sparsity、SSM state dimension 或增加层数，很难突破信息不足造成的上限。

第三，主指标与次指标发生冲突。selected 相对首个基线 test MSE 改善 4.74%，但 test MAE 恶化 9.90%。最终发布没有设置 MAE non-regression gate，因此“主指标变好”掩盖了典型绝对误差变差。

此外，selected 名称声称是 multi-seed robustness，但发布物记录的实际配置只是 seed=99；说明文字也承认这是三个计划种子中的第一个。没有发现 seed 99/123/2024 的聚合均值和标准差。因此当前“稳健”结论尚未被运行结果支持。

windy 的最高优先级实验应是严格的输入消融，而非继续换 backbone：

1. target-only；
2. target + observed-past wind/weather；
3. target + observed-past + 真实可获得的 future weather forecast；
4. 在相同选模协议和多 seed 下比较 MSE、MAE、爬坡段误差。

## 5. 跨任务根因链

### 5.1 根因一：优化目标只最小化点估计，没有估计选择不确定性

当前 champion 规则本质上是：

```text
selected = argmin(candidate.val_avg_mse)
```

它没有考虑 seed 方差、fold 方差、顶部候选的统计等价性、模型复杂度或 MAE 退化。sunny 第一和第二的 val 差仅 0.0015%，windy 第一领先第二也只有 0.198%；这种差距不足以支撑确定性的架构结论。

### 5.2 根因二：CV 目标与真正的时间外推目标不一致

expanding-window CV 是正确方向，但当前使用所有 fold 的等权宏平均：

```text
cv_avg_mse = mean(fold_0, fold_1, fold_2, fold_3)
```

当数据存在长期漂移时，早期 fold 的低误差可能掩盖最近 fold 的退化。sunny 的 DLinear baseline folds 为 0.3305/0.3746/0.5611/0.5061，TiDE 为 0.2522/0.3360/0.5027/0.4110；CV 明确偏爱 TiDE，但真正 ref-test 却偏爱 DLinear。这表明需要让选择协议更接近“从当前边界向未来外推”，而不是简单衡量整个历史期平均拟合能力。

### 5.3 根因三：数据契约和模型搜索之间缺少硬性特征审计

sunny 正确保留了 6 个 observed-past covariates，windy 却在同样列结构下变成 target-only。系统目前允许这种差异静默进入搜索和发布。应在训练前输出并确认：

- 原始可用数值列；
- target、observed-past、known-future、unused 四类映射；
- 模型实际输入通道；
- 每个声明的 fusion 是否在当前通道数下有效。

若 `graph/feature fusion` 只有一个输入通道，应该直接发出强警告或判为无效 recipe。

### 5.4 根因四：recipe 名称/假设与实际执行证据可能不一致

典型例子是 windy 的 `multiseed_robustness`：hypothesis 描述 3 个新 seed，实际 artifact 只有 seed=99。另一类证据是多组不同 recipe 得到完全相同的 train/val/test 三元组。

建议每个候选记录：

- canonical compiled recipe hash；
- trainable parameter hash/数量；
- 数据输入签名；
- seed；
- 训练曲线 hash；
- 与父候选相比真正生效的模块 diff。

若 compiled hash 相同，除非明确进行 seed/reproducibility 实验，否则不应再次占用架构搜索预算。

### 5.5 根因五：发布指标太少，无法驱动有针对性的 reflection

当前只有聚合 H96 MSE/MAE。Reflection Agent 看不到：

- 第 1–96 步误差随 horizon step 的曲线；
- bias、误差方差和相关性；
- 高/低功率区间误差；
- sunny 的白天/夜间、日出日落；
- windy 的 ramp event；
- ETTh1 的变点前后表现；
- naive persistence、seasonal naive、线性基线的逐段差值。

在缺乏这些证据时，reflection 容易把问题归因到新 backbone 或学习率，而不能定位是哪种样本和哪段 horizon 造成失分。

### 5.6 次要但需要修复：状态与任务隔离不清晰

当前 `neo_cast/.neo-cast/runner_state.json` 同时保留历史 `best_val_avg_mse=0.062759` 和当前 sunny 的 `best_cv_avg_mse=0.375472`，session 从 2026-05-28 延续到多个数据任务。虽然 NeoResearch 上层另有 task-scoped champion，但底层全局状态、`results.tsv` 和 reflection 上下文存在跨数据集混淆风险。

最佳值必须至少以 `(dataset fingerprint, split protocol id, target signature, horizon, metric)` 为 key；协议或数据变化时不能沿用同一个全局 best。

## 6. 改进优先级

| 优先级 | 改进项 | 直接解决的问题 | 建议验收标准 |
|---|---|---|---|
| P0 | recent-aware nested time selection | val/CV 排名与未来错位 | 在历史 replay 中提高 top-k test recall；Spearman 稳定为正且显著高于现协议 |
| P0 | 数据/协变量契约审计 | windy 丢失关键输入 | CSV 数值列全部被显式归类；单通道 graph/feature fusion 阻断或告警 |
| P0 | baseline safety gate | selected 可能不如简单基线 | robust score 与 MAE 均不得显著劣于 baseline；等价时选择简单模型 |
| P1 | 3–5 seed 聚合与置信区间 | 微小 val 差被当成确定性提升 | 发布 mean/std/median；候选差小于噪声时标记 tie |
| P1 | compiled-behavior 去重 | 不同 recipe 重复相同行为 | 默认跳过同 hash 候选；重复仅用于显式复现 |
| P1 | 保存预测和细粒度误差切片 | reflection 缺少可诊断证据 | 发布 step-wise、segment-wise、bias、naive-relative 指标 |
| P1 | fold checkpoint 生命周期修复 | K-fold 39.1% 复评失败 | full/CV 成功运行 100% 可复评，artifact 不依赖已删除的 `/tmp` |
| P2 | 数据集专用结构探索 | 在协议可靠后提升模型上限 | 所有架构结论必须跨 seed、跨 recent fold 成立 |

## 7. 建议的选模规则

第一阶段不触碰 ref-test，只在 visible 数据内构造 nested pseudo-future replay。建议候选分数：

```text
recent_score = 0.15 * fold_0
             + 0.20 * fold_1
             + 0.25 * fold_2
             + 0.40 * fold_3

risk_score = recent_score
           + lambda_std * std(fold_mse)
           + lambda_mae * normalized_recent_mae
```

权重和 λ 不应凭经验直接固化，应使用多份历史任务的 replay 数据选择；`ref_test` 只允许在最终冻结后做一次确认。

建议 champion 决策流程：

```text
候选成功完成所有 folds
  -> 检查 compiled hash 和输入签名
  -> 计算 recent/risk score
  -> 与同协议 baseline 比较
  -> top candidates 做 3–5 seeds
  -> 差异小于不确定性阈值时判定 tie
  -> tie 中按 MAE、最坏 fold、参数量依次决胜
  -> 冻结一次
  -> 最后查询 ref_test
```

注意：不能根据这三次 ref-test 的具体结果手工调整权重后再声称泛化提升。权重必须在更多历史 replay task 上预注册，再用新的未见任务验证。

## 8. 最小验证实验矩阵

### 实验 A：selection protocol replay

- 数据：ETTh1、sunny、windy，以及现有 k-fold ETTm1/weather/load 工作区。
- 候选：复用已经训练完成的 checkpoint，不先增加新模型。
- 对比：fixed val、CV mean、last-fold、recent-weighted、mean+std、worst-fold。
- 输出：每种规则的 Spearman、selected test rank、oracle regret、baseline win rate。
- 目标：先证明新的 selection rule 比现有规则稳定，再恢复大规模架构搜索。

### 实验 B：windy covariate contract

- target-only；
- observed-past weather；
- observed-past + calendar future；
- 若业务可获得，再加 forecasted future weather。

每组固定 DLinear/NLinear、TCN、SSM 三种代表模型，3 个 seed。优先判断信息增益，而不是在单一 target-only SSM 上继续调 state dimension。

### 实验 C：顶部候选不确定性

对每个数据集取 robust-score top 3，各跑 5 seeds，报告：

- val/CV mean ± std；
- last-fold mean ± std；
- 参数量；
- 训练失败率；
- 最终冻结前的统计 tie 判断。

### 实验 D：细粒度误差

每个 artifact 保存压缩预测数组和索引，至少生成：

- horizon step 1–96 MSE/MAE；
- bias 与 error std；
- target 分位段误差；
- persistence/seasonal-naive skill score；
- sunny day/night/ramp；
- windy ramp magnitude buckets；
- ETTh1 changepoint 前后。

## 9. 对当前三个 Selected 的最终判断

| 数据集 | 当前判断 | 是否可直接称为“最优模型” |
|---|---|---|
| ETTh1 | 有明确基线增益，整体候选排序较可靠，但 top-1 错位且复杂 TimesNet 输给多组简单线性候选 | 只能称“按 fixed val 选出的 champion”，不能称 test 最优 |
| sunny | 有基线增益，但 fixed val 排序较弱；K-fold mean 进一步显示与未来区间错位 | 不建议称为稳定最优，需要重做 recent-aware selection |
| windy | MSE 仅小幅改善、MAE 明显退化，且任务错误地丢弃所有气象协变量；多 seed 声称未完成 | 不应作为生产质量 champion，最多是 target-only baseline champion |

总体上，NeoResearch 已具备“搜索出比初始基线更好的候选”的能力，但尚未稳定具备“从已搜索候选中选出未来表现最好者”的能力。现阶段的性能上限主要由**选模统计协议、任务输入契约和实验可验证性**共同决定，而不是由模型库宽度决定。

## 10. 可复核证据索引

- ETTh1 champion：`opencode/packages/opencode/.neo-research/artifacts/rtsk_f365a1d5e0010W7eUFTNZV7bft/results/champion.json`
- ETTh1 发布模型：`opencode/packages/opencode/.neo-research/artifacts/rtsk_f365a1d5e0010W7eUFTNZV7bft/model/metadata.json`
- sunny champion：`opencode/packages/opencode/.neo-research/artifacts/rtsk_f3726e0cd001ncaVyZUl9hVL7J/results/champion.json`
- sunny 发布模型：`opencode/packages/opencode/.neo-research/artifacts/rtsk_f3726e0cd001ncaVyZUl9hVL7J/model/metadata.json`
- windy champion：`opencode/packages/opencode/.neo-research/artifacts/rtsk_f38056b41001pi4xHz0xS4Sr44/results/champion.json`
- windy 发布模型：`opencode/packages/opencode/.neo-research/artifacts/rtsk_f38056b41001pi4xHz0xS4Sr44/model/metadata.json`
- 当前 sunny K-fold 状态：`neo_cast/.neo-cast/runner_state.json`、`neo_cast/.neo-cast/results.tsv`
- K-fold DLinear：`neo_cast/.neo-cast/artifacts/run_20260717-041936-z8rp/metadata.json`
- K-fold TiDE：`neo_cast/.neo-cast/artifacts/run_20260717-073501-z8rp/metadata.json`
- K-fold residual correction：`neo_cast/.neo-cast/artifacts/run_20260718-212336-hbrp/metadata.json`
