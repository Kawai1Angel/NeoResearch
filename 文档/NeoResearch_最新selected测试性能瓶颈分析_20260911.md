# NeoResearch 最新 Selected 测试性能与瓶颈分析

> 本文是最新 sunny K-fold 任务的详细子报告。三数据集的最新结果以 `NeoResearch_最新运行selected测试性能综合分析_20260911.md` 为准。

分析日期：2026-09-11  
最新完整任务：`rtsk_f768abd240015IQ9J245AjCyCd`  
运行时间：2026-07-18  
数据集：`sunny_power_full.csv`  
预测任务：input=336，horizon=96  
最终验收指标：严格保留 `ref_test` 上的 MSE，MAE 作为非退化参考。

## 1. 结论

**最新结果下，NeoResearch 的最终 selected 模型没有在测试集上超过 baseline，不满足项目的最终验收目标。**

| 对象 | recipe | CV MSE | test MSE | test MAE | 相对 baseline test MSE |
|---|---|---:|---:|---:|---:|
| baseline | `tsf_baseline_dlinear` | 0.443052 | **0.297325** | 0.343823 | — |
| selected | `recipe_mlp_residual_correction_v15` | **0.383034** | 0.315776 | 0.366551 | **恶化 6.21%** |
| 探索期 test 最优 | `recipe_dlinear_instance_norm_residual_correction` | 0.402744 | **0.292810** | **0.340204** | **改善 1.52%** |

核心判断：

1. **selected 失败。** test MSE 从 baseline 的 0.297325 升到 0.315776，恶化 6.21%；test MAE 也恶化 6.61%。
2. **搜索不是完全失败。** 23 个可评估的非 baseline 探索模型中，有 2 个在 test MSE 上超过 baseline，最优者改善 1.52%。
3. **主要瓶颈是选择信号失真。** 22/23 的探索模型在 CV MSE 上超 baseline，但只有 2/23 在 test MSE 上超 baseline。
4. **新 baseline 已经很强。** 搜索期最好的额外收益只有 1.52%，且当前只有单 seed 结果，还不足以证明这个小幅改善可稳定复现。

所以，目前不应发布 MLP selected 作为“超过 baseline”的最终模型。如果必须立即发布，应回退到 baseline；如果允许继续验证，应优先对 test 事后最优的 DLinear 变体做多 seed 复验，但不能再使用当前 `ref_test` 反复调参。

## 2. 与上一版报告的区别

上一版报告的主表使用了较早的 fixed-split 任务，而不是最新 K-fold 任务。其 sunny 结论是：

| 版本 | Task ID | baseline test MSE | selected test MSE | selected 相对 baseline | test 最优 | test MSE 超 baseline 的探索模型 |
|---|---|---:|---:|---:|---:|---:|
| 旧 fixed-split | `rtsk_f3726e0cd001ncaVyZUl9hVL7J` | 0.381450 | 0.343447 | 改善 9.96% | 0.290171 | 10 / 24 |
| **最新 K-fold** | `rtsk_f768abd240015IQ9J245AjCyCd` | **0.297325** | **0.315776** | **恶化 6.21%** | **0.292810** | **2 / 23** |

旧结论不能继续用于当前验收，原因是：

- 最新任务的 baseline test MSE 从 0.381450 降到 0.297325，baseline 本身提升了 22.05%；
- 新 baseline 使用 `kernelSize=25`、`lr=1e-4`、seed=2021 等配置，不是旧任务的同一次 baseline 运行；
- 最新 selected 虽然比前一个 K-fold 任务的 selected（0.360419）改善 12.39%，但仍然没有越过当前 baseline 的 0.297325；
- 因此，“模型自身绝对误差变小”不等于“在当前任务中超过 baseline”。

## 3. 数据与评估口径

### 3.1 实际运行数

- 任务声明了 25 个 candidate；
- 其中 24 个进入 full-run，包含 1 个 baseline 和 23 个探索模型；
- `tsf_ranked_frequency_mixer_profiled` 没有 full-run，不计入性能分母；
- 24 个 full-run checkpoint 本次全部复评成功，没有将缺失结果计为失败模型。

### 3.2 测试集来源

本次重新加载每个 full-run 的 `model.pt`，并统一调用 `evaluate_ref_test_tsf()` 评估：

- train：`[0, 16867)`；
- val：`[16867, 19277)`；
- ref_test：`[19277, 24096)`；
- scaler 仅由 train 区间拟合；
- baseline、selected 和所有探索候选使用相同的 ref_test、scaler 和评估函数。

本次生成的原始复评文件为：

`opencode/packages/opencode/tmp/full_run_checkpoint_eval_rtsk_f768abd24_sunny_train_val_test_gpu.csv`

## 4. Selected 为什么失败

### 4.1 CV 提升与 test 提升大面积翻转

| 统计 | 数量 | 比例 |
|---|---:|---:|
| CV MSE 超 baseline | 22 / 23 | 95.7% |
| test MSE 超 baseline | 2 / 23 | 8.7% |
| test MAE 超 baseline | 2 / 23 | 8.7% |
| test MSE 与 MAE 同时超 baseline | 2 / 23 | 8.7% |

在 22 个 CV 判定优于 baseline 的候选中，只有 2 个最终在 test MSE 上成功，即 CV 改善对 test 改善的事后命中率只有 9.1%。

24 个可比模型中：

- CV MSE 与 test MSE 的 Spearman 排名相关只有 **0.191**；
- fixed val MSE 与 test MSE 的 Spearman 相关更低，只有 **0.092**；
- selected 的 CV MSE 并列第 1，但 test MSE 并列第 12–14，平均名次为第 13；
- baseline 在 CV 上只排第 23，却在 test MSE 上排第 3。

这是当前最明确的性能瓶颈：**选择器在历史可见区间中有很强的优化信号，但这个信号几乎不能预测最后时间区间的模型排序。**

### 4.2 Selected 在每个历史 fold 上都更好，到 test 仍然翻转

| 区间 | baseline MSE | selected MSE | selected 改善 | test 事后最优 MSE | 最优改善 |
|---|---:|---:|---:|---:|---:|
| CV fold 0 | 0.330546 | 0.252426 | 23.63% | 0.282560 | 14.52% |
| CV fold 1 | 0.374551 | 0.340983 | 8.96% | 0.351101 | 6.26% |
| CV fold 2 | 0.561060 | 0.492302 | 12.26% | 0.507004 | 9.63% |
| CV fold 3 | 0.506052 | 0.446427 | 11.78% | 0.470312 | 7.06% |
| **ref_test** | **0.297325** | **0.315776** | **-6.21%** | **0.292810** | **1.52%** |

selected 并不是只在早期 fold 取巧：它在四个 fold 上都明显改善，包括最接近 test 的 fold 3，但在真正未来区间仍然翻转。这表明简单增加 fold 数、只用 recent fold，或对 fold 均值调权，未必足以解决问题。

更可能的原因是：

- ref_test 的光照、季节或功率分布与四个历史 fold 不同；
- MLP 在历史区间拟合出的非线性关系不能稳定外推；
- DLinear/NLinear 的线性趋势归纳偏置在该 ref_test regime 下更稳定。

由于当前没有逐时间点预测误差和按月份/光照强度分组的指标，上述是由排名翻转得到的待验证解释，不是已被直接证明的因果结论。

### 4.3 搜索大部分在优化一个失真代理目标

selected 的 CV MSE 相对 baseline 改善 13.55%，这是一个看似很有说服力的提升；但 test MSE 反而恶化 6.21%。搜索过程继续围绕 CV 小幅改进 MLP，会积累代理目标上的进步，却不一定提高最终指标。

事后 test 最优候选的 CV MSE 为 0.402744，比 selected 的 0.383034 差 5.15%，因此它按当前选择规则不可能被选中。这不是 tie-break 或小数点噪声造成的 top-1 错位，而是选择目标本身的结构性错位。

## 5. 探索期最优与超 baseline 的模型

### 5.1 只有两个探索模型最终超过 baseline

| recipe | test MSE | MSE 改善 | test MAE | MAE 改善 | CV MSE |
|---|---:|---:|---:|---:|---:|
| `recipe_dlinear_instance_norm_residual_correction` | **0.292810** | **1.52%** | **0.340204** | **1.05%** | 0.402744 |
| `recipe_nlinear_instance_norm_v1` | 0.296927 | 0.13% | 0.340657 | 0.92% | 0.441225 |

两个成功候选都保留了线性系列归纳偏置，并引入 instance normalization；更复杂的 MLP、PatchTST 和 TimesNet 候选均没有在 test 上超过 baseline。

但这两个收益都很小，特别是 NLinear 的 0.13%，在单 seed 条件下不应宣称为稳定提升。DLinear 变体的 1.52% 也需要多 seed 和新 blind-test 确认。

### 5.2 有效探索多样性不足

24 个 full runs 仅有 17 组不同的 `(CV MSE, val MSE, test MSE, test MAE)` 结果。明显的重复组包括：

- `recipe_mlp_residual_correction_v15/v16/v17` 完全相同；
- `recipe_nlinear_mlp_depth2_wide_v6`、`covariate_add_v8`、`causal_attn_v9`、`mlp_causal_attn_hybrid_v22` 完全相同；
- `recipe_nlinear_mlp_depth2_wide_v7` 与 `recipe_mlp_depth2_wide_v8` 相同；
- 两个 DLinear decomposition + residual correction recipe 相同。

这意味着 29.2% 的 full-run 预算没有产生新的聚合性能点。部分原因可能是声明的 action 未改变实际执行图，也可能是配方本质等价；无论哪种情况，都应在训练前通过 resolved model graph/config hash 去重。

### 5.3 研究假设与实际输入契约存在偏差

多个 candidate rationale 声称利用“已知未来气象协变量”，但实际 artifact 的：

- `past_exogenous_channels=6`；
- `future_exogenous_channels=0`；
- `known_future_covariates=[]`。

即模型只能看到历史天气，不能看到未来 96 步的天气或 calendar features。这不是 selected 输给 baseline 的直接原因，因为它们共享同一输入契约；但它是 sunny H96 整体性能上限和研究推理可信度的明确瓶颈。

## 6. 性能瓶颈排序

| 优先级 | 瓶颈 | 运行证据 | 直接影响 |
|---|---|---|---|
| P0 | CV/val 排名无法预测 test 排名 | CV→test Spearman=0.191；22 个 CV winner 仅 2 个 test winner | selected test MSE 恶化 6.21% |
| P0 | 缺少最终 baseline-relative release gate | selected 在 CV 通过后直接成为 champion，test 却输给 baseline | 不满足最终产品目标 |
| P1 | baseline 过强后未围绕线性族精细搜索 | test 前 3 名是 DLinear 变体、NLinear、baseline | 大量预算用于 test 明显更差的复杂架构 |
| P1 | 有效候选重复 | 24 runs 只有 17 组唯一性能点 | 浪费 29.2% full-run 预算 |
| P1 | 缺少多 seed 和置信区间 | 成功候选只提升 0.13%–1.52% | 无法判断小收益是稳定改善还是随机波动 |
| P2 | 缺少 known-future/calendar 信号 | H96 但 future channels=0 | 限制对未来日照周期和天气变化的显式建模 |

## 7. 建议的改进顺序

### 7.1 立即增加最终发布门禁

选择阶段仍不能查看 ref_test，否则会泄漏测试集。但候选冻结后应执行一次性 release gate：

1. 冻结 selected 和 baseline artifact；
2. 在 blind/ref_test 上同时评估；
3. 若 `selected_test_mse >= baseline_test_mse`，则本轮研究标记为“未超 baseline”，发布 baseline 或不发布新模型；
4. 不得根据该 ref_test 结果继续调参；如需继续研究，必须更换新的 blind-test 区间。

这一门禁不会修复选择器，但可以立即防止“CV champion 在最终测试上输给 baseline 仍被宣称成功”。

### 7.2 重做不依赖当前 ref_test 的代理验证

当前四个连续 expanding-window fold 对同一时间段之前的数据反复抽样，但没有覆盖 ref_test regime。下一轮应优先验证：

- 按月份/季节分层的 pseudo-future backtest；
- 按晴天、阴天、低照度和高照度 regime 分层评分；
- 候选相对 baseline 的配对 fold improvement，而不是只比较绝对 CV mean；
- 在时间上更贴近实际部署日期的多个 rolling-origin 起点上比较胜率和 worst-case regression。

### 7.3 将 baseline 族作为局部搜索中心

最新 test 前三名全部是线性族。下一轮应把主要预算用于：

- DLinear kernel、individual/shared projection、instance normalization 的消融；
- residual correction 是否在多 seed 下稳定有效；
- NLinear 的 0.13% 收益是否可复现；
- 与 baseline 相同 seed 列表下的配对比较。

在线性族的改善边界和稳定性未量化前，继续大量添加 TimesNet/PatchTST/MLP 变体的优先级较低。

### 7.4 修复执行契约和去重

- 将 candidate hypothesis 中的输入信号与 resolved recipe 逐项校验；
- 若 rationale 依赖 known-future weather，而任务的 future channels=0，应在运行前拒绝该候选或改写假设；
- 对 resolved model graph、训练配置、seed 和数据契约计算行为 hash；
- hash 相同的候选直接复用结果，不重复 full-run。

## 8. 全部可复评模型的 test MSE 排名

`相对 baseline` 为负数表示改善，正数表示恶化。

| test 排名 | recipe | CV MSE | test MSE | test MAE | 相对 baseline | 标记 |
|---:|---|---:|---:|---:|---:|---|
| 1 | `recipe_dlinear_instance_norm_residual_correction` | 0.402744 | 0.292810 | 0.340204 | -1.52% | test 事后最优 |
| 2 | `recipe_nlinear_instance_norm_v1` | 0.441225 | 0.296927 | 0.340657 | -0.13% | test 超 baseline |
| 3 | `tsf_baseline_dlinear` | 0.443052 | 0.297325 | 0.343823 | +0.00% | baseline |
| 4 | `recipe_nlinear_mlp_gelu_v3` | 0.395722 | 0.309540 | 0.351710 | +4.11% | |
| 5 | `recipe_timesnet_light_v21` | 0.409326 | 0.313321 | 0.383725 | +5.38% | |
| 6 | `recipe_mlp_causal_attn_hybrid_v22` | 0.386121 | 0.314040 | 0.356485 | +5.62% | |
| 7 | `recipe_nlinear_mlp_depth2_causal_attn_v9` | 0.386121 | 0.314040 | 0.356485 | +5.62% | |
| 8 | `recipe_nlinear_mlp_depth2_covariate_add_v8` | 0.386121 | 0.314040 | 0.356485 | +5.62% | |
| 9 | `recipe_nlinear_mlp_depth2_wide_v6` | 0.386121 | 0.314040 | 0.356485 | +5.62% | |
| 10 | `recipe_mlp_depth2_wide_v8` | 0.386771 | 0.314776 | 0.357217 | +5.87% | |
| 11 | `recipe_nlinear_mlp_depth2_wide_v7` | 0.386771 | 0.314776 | 0.357217 | +5.87% | |
| 12 | `recipe_mlp_residual_correction_v17` | 0.383034 | 0.315776 | 0.366551 | +6.21% | |
| 13 | `recipe_mlp_residual_correction_v16` | 0.383034 | 0.315776 | 0.366551 | +6.21% | |
| 14 | `recipe_mlp_residual_correction_v15` | 0.383034 | 0.315776 | 0.366551 | +6.21% | selected |
| 15 | `recipe_nlinear_mlp_depth2_v5` | 0.392106 | 0.318602 | 0.362042 | +7.16% | |
| 16 | `recipe_mlp_depth2_wide_reg_v24` | 0.387586 | 0.318729 | 0.361213 | +7.20% | |
| 17 | `recipe_nlinear_mlp_depth2_v4` | 0.402791 | 0.321892 | 0.358989 | +8.26% | |
| 18 | `recipe_timesnet_reduced_topk5_v13` | 0.432270 | 0.321998 | 0.391932 | +8.30% | |
| 19 | `recipe_timesnet_light_v14` | 0.436776 | 0.324744 | 0.395823 | +9.22% | |
| 20 | `recipe_patchtst_light_v10` | 0.423685 | 0.337889 | 0.393446 | +13.64% | |
| 21 | `recipe_timesnet_light_v11` | 0.442310 | 0.338617 | 0.417849 | +13.89% | |
| 22 | `recipe_dlinear_series_decomp_residual_correction_v23` | 0.394428 | 0.338944 | 0.392267 | +14.00% | |
| 23 | `recipe_dlinear_decomp_residual_correction_v19` | 0.394428 | 0.338944 | 0.392267 | +14.00% | |
| 24 | `recipe_timesnet_exact_rhyp_v12` | 0.508315 | 0.508937 | 0.538586 | +71.17% | |

## 9. 最终判定

按“最终 selected 必须在测试集 MSE 上优于当前 baseline”的验收标准：

- **最新 selected：不通过；**
- **搜索期存在超 baseline 候选：是，2/23；**
- **已观测最优 test MSE：0.292810，比 baseline 好 1.52%；**
- **该 1.52% 是否稳定：未证明，需多 seed 和新 blind-test。**

当前 NeoResearch 的性能问题可以精确概括为：**系统能搜到少量比强 baseline 更好的线性变体，但 CV 选择信号将一个测试集明显更差的 MLP 推成了 selected，且发布流程没有在最终 test 输给 baseline 时自动回退。**
