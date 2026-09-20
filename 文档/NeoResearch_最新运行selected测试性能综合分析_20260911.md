# NeoResearch 最新运行 Selected 测试性能综合分析

分析日期：2026-09-11  
分析目标：仅考察最终 selected 在严格保留 test/ref_test 上是否超过同任务 baseline，同时考察探索期事后最优性能和超 baseline 的候选数量。

## 1. 此前报告使用了什么结果

此前报告的主表使用了 2026-07-06–07 的三个 fixed-split 任务：

| 数据集 | 旧 Task ID | 旧 selected test MSE 相对 baseline | 旧 test MSE winner 数 |
|---|---|---:|---:|
| ETTh1 | `rtsk_f365a1d5e0010W7eUFTNZV7bft` | 改善 18.31% | 19 / 24 |
| sunny | `rtsk_f3726e0cd001ncaVyZUl9hVL7J` | 改善 9.96% | 10 / 24 |
| windy | `rtsk_f38056b41001pi4xHz0xS4Sr44` | 改善 4.74% | 21 / 24 |
| 合计 | — | 3 / 3 selected 的 MSE 超 baseline | 50 / 72 |

这组数据的计算本身来自 ref_test，但它已不是各数据集的最新运行，因此“3/3 selected 都超 baseline”不能用作当前验收结论。

## 2. 本报告使用的最新结果

| 数据集 | 最新任务 | 运行日期 | 候选/可复评 full-run | 选择协议 |
|---|---|---|---:|---|
| ETTh1 | `rtsk_f417e43fb001e9cF1GTXgt8Ep2` | 2026-07-10 | 25 / 25 | fixed val MSE |
| sunny | `rtsk_f768abd240015IQ9J245AjCyCd` | 2026-07-18 | 25 candidates / 24 full-run | 4-fold expanding-window CV MSE |
| windy | `rtsk_f3ba37cd10018c1yd1FOnsWcft` | 2026-07-07–08 | 25 / 25 | fixed val MSE，但 champion 错指 smoke run |

复评文件：

- `opencode/packages/opencode/tmp/full_run_checkpoint_eval_rtsk_f417e43fb_ETTh1_train_val_test_gpu.csv`
- `opencode/packages/opencode/tmp/full_run_checkpoint_eval_rtsk_f768abd24_sunny_train_val_test_gpu.csv`
- `opencode/packages/opencode/tmp/full_run_checkpoint_eval_rtsk_f3ba37cd_windy_train_val_test_gpu.csv`
- `opencode/packages/opencode/tmp/ref_test_eval_rtsk_f3ba37cd_selected_export.json`

所有 test 数值都由 `evaluate_ref_test_tsf()` 在同任务的保留区间上重新计算，不是 val/CV 分数的改名。

## 3. 最终 Selected 是否在 test MSE 上超过 baseline

| 数据集 | baseline test MSE | selected test MSE | MSE 变化 | baseline test MAE | selected test MAE | MAE 变化 | MSE 验收 |
|---|---:|---:|---:|---:|---:|---:|---|
| ETTh1 | 0.094223 | 0.093071 | **改善 1.22%** | 0.237253 | 0.237487 | 恶化 0.10% | **通过** |
| sunny | 0.297325 | 0.315776 | **恶化 6.21%** | 0.343823 | 0.366551 | 恶化 6.61% | **失败** |
| windy | 1.410835 | 1.277059 | **改善 9.48%** | 0.862848 | 0.881903 | 恶化 2.21% | **数值通过，发布链路不通过** |

按用户明确指定的“最终 test MSE 必须优于 baseline”标准：

- ETTh1 selected 通过；
- sunny selected 失败；
- windy 导出的 selected checkpoint 经直接复评后数值通过，但原始 ref-test run 失败，不能视为完整、可审计的官方验收成功。

因此，最新三任务不是“3/3 全部通过”，而是**1 项完整通过、1 项明确失败、1 项数值通过但发布证据链失败**。

如果还要求 test MSE 和 MAE 同时改善，则三个 selected 全部不通过。

### 3.1 Windy 的 selected 口径说明

windy 任务存在特殊的产物问题：

- `champion.json` 指向 `rrun_f3c2b2617...`，该 run 的 stage 是 `smoke`，不是 `full`；
- 同 candidate 的 full-run `rrun_f3c2c917c...` 存在，但 champion 没有指向它；
- 官方 ref-test run `rrun_f3da5c96e...` 失败；
- `manifest.json` 标记 `integrity.status=incomplete`，缺少 `model/model.py`；
- 本报告为了定位数值性能，直接加载导出的 `model/model.pt` 重新评估，得到 test MSE=1.277059。

因此 windy 的数值可用于诊断，但必须同时修复 champion stage 和发布完整性，才能作为最终可交付结果。

## 4. 探索期事后最优性能

| 数据集 | baseline test MSE | 探索期 test 最优 recipe | 最优 test MSE | 相对 baseline 改善 | selected 与最优的差距 |
|---|---:|---|---:|---:|---:|
| ETTh1 | 0.094223 | `recipe_itransformer_stabilized_v2` | **0.091200** | **3.21%** | selected 高 2.05% |
| sunny | 0.297325 | `recipe_dlinear_instance_norm_residual_correction` | **0.292810** | **1.52%** | selected 高 7.84% |
| windy | 1.410835 | `recipe_pure_linear_covariate_gate_light_v18` | **1.243140** | **11.89%** | selected 高 2.73% |

三项任务都在探索期出现了 test MSE 优于 baseline 的候选，因此搜索空间并非完全无效。但是：

- ETTh1 selected 只实现了当前可观测最大 MSE 改善的约 38.1%；
- sunny selected 不仅没捕获 1.52% 的可用收益，还掉到 baseline 之后；
- windy selected 数值改善较明显，但仍没有选中 full-run 中 test 最优的轻量线性变体。

需要强调：“test 事后最优”只用于分析搜索上限和选择损失，不能用当前 ref_test 将其重新选为模型，否则会造成测试泄漏。

## 5. 最终 test 超过 baseline 的探索模型数量

| 数据集 | 可复评探索模型 | test MSE 超 baseline | test MAE 超 baseline | MSE、MAE 同时超 baseline |
|---|---:|---:|---:|---:|
| ETTh1 | 24 | **17 / 24（70.8%）** | 16 / 24（66.7%） | 13 / 24（54.2%） |
| sunny | 23 | **2 / 23（8.7%）** | 2 / 23（8.7%） | 2 / 23（8.7%） |
| windy | 24 | **8 / 24（33.3%）** | 11 / 24（45.8%） | 6 / 24（25.0%） |
| **合计** | **71** | **27 / 71（38.0%）** | **29 / 71（40.8%）** | **21 / 71（29.6%）** |

这与旧报告的 50/72（69.4%）存在本质差异。在最新任务中，只有 38.0% 的探索模型在 test MSE 上超 baseline，且同时改善 MSE 和 MAE 的仅有 29.6%。

不同任务的搜索难度差异很大：

- ETTh1 的 baseline 仍然有大量候选可超越；
- sunny 的新 DLinear baseline 很强，探索成功率从旧任务的 41.7% 降到 8.7%；
- windy 的 MSE 和 MAE 存在明显冲突，MSE winner 并不必然是 MAE winner。

## 6. 最主要的性能瓶颈

### 6.1 P0：val/CV 的候选排序几乎不能预测 test 排序

| 数据集 | 选择指标→test MSE Spearman | selected test 表现 |
|---|---:|---|
| ETTh1 | **0.072** | 第 9 / 25 |
| sunny | **0.191** | 并列第 12–14 / 24 |
| windy | **-0.202** | 导出 selected 复评约为第 3，但 champion stage 错误 |

三项最新任务的排名相关全部接近 0，windy 甚至为负。这说明当前选择指标不是“精度还不够高”，而是与真正未来区间的候选顺序结构性错位。

sunny 是最典型的反例：22/23 的探索模型在 CV MSE 上超 baseline，但仅 2/23 在 test MSE 上超 baseline。selected 的 CV MSE 改善 13.55%，test MSE 却恶化 6.21%。

### 6.2 P0：缺少 baseline-relative 最终发布门禁

当前系统会将 val/CV champion 导出为 selected，即使它在最终 test 上输给 baseline。sunny 已经证明这不是理论风险，而是实际发生的验收失败。

正确流程应为：

1. 仅基于 train/val/CV 冻结 selected；
2. 冻结后一次性查询 blind test；
3. 若 selected test MSE 不优于 baseline，标记研究失败并回退 baseline；
4. 不得使用该 test 结果继续调参；继续研究必须更换新 blind-test。

### 6.3 P1：搜索空间和强 baseline 不匹配

sunny 最新 baseline 的 test MSE 比旧 baseline 改善 22.05%，搜索期事后最好也只能再改善 1.52%。此时搜索仍将大量预算用于 MLP、TimesNet 和 PatchTST，而test 前 3 名却全部是 DLinear/NLinear 线性族。

这表明在 baseline 已经很强时，搜索器应转入 baseline-centered local search，而不是继续大范围更换 backbone。

### 6.4 P1：有效候选重复和假设执行偏差

sunny 的 24 个 full runs 仅产生 17 组不同的 `(CV,val,test)` 性能点，windy 的 25 个 full runs 仅有 20 组。多个声明不同的 recipe 得到完全相同的结果，说明行为去重仍然不足。

同时，sunny 的多个 candidate rationale 声称使用 known-future weather，但实际 artifact 中 `future_exogenous_channels=0`。这表明研究假设、resolved recipe 和真正执行图之间缺少强校验。

### 6.5 P1：缺少多 seed，小收益不可确认

ETTh1 selected 的 MSE 收益只有 1.22%，sunny 最优候选仅提升 1.52%，NLinear 候选甚至只提升 0.13%。当前 baseline 与候选不是统一的多 seed 配对实验，因此这些小收益可能落在训练随机性范围内。

## 7. 优先改进顺序

| 优先级 | 动作 | 验收方式 |
|---|---|---|
| P0 | 实现 selected-vs-baseline blind-test release gate | selected test MSE 不优于 baseline 时自动标记失败并回退 |
| P0 | 修复 champion 只能指向成功 full-run 的约束 | 禁止 smoke run 成为可发布 champion；ref-test 失败时 manifest 不得宣称可交付 |
| P0 | 重设 pseudo-future 验证 | 使用季节/天气 regime 分层 rolling-origin，测量新 blind-test 上的排名相关 |
| P1 | 对强 baseline 开展线性族局部搜索 | DLinear/NLinear 消融在统一 seed 列表下超 baseline |
| P1 | resolved graph/config hash 去重 | 行为相同的 candidate 不再重复 full-run |
| P1 | baseline 与 shortlist 做配对多 seed | 报告 mean、std、置信区间和超 baseline 概率 |
| P2 | 加入 calendar/known-future 可用信号 | 确保 rationale 声明的 future features 在 artifact 中 `future_exogenous_channels>0` |

## 8. 最终结论

基于各数据集的最新运行，NeoResearch 目前没有稳定实现“最终 selected 在 test MSE 上超过 baseline”：

- sunny 明确失败，selected 恶化 6.21%；
- ETTh1 虽通过，但收益只有 1.22%，且 MAE 轻微恶化；
- windy 数值上改善 9.48%，但 champion/ref-test/导出证据链不完整，MAE 也恶化 2.21%。

探索过程确实在三项任务中都遇到过 test MSE 优于 baseline 的候选，但合计只有 27/71（38.0%）超 baseline，而且选择指标与 test 排名的 Spearman 相关仅为 -0.202–0.191。

因此当前最主要的性能瓶颈是：**NeoResearch 能生成部分有效候选，但它的 val/CV 选择信号无法稳定找到真正的未来优势，同时发布流程又没有将“test 必须超 baseline”执行为硬门禁。**
