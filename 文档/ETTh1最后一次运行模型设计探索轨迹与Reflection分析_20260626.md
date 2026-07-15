# ETTh1.csv 最后一次模型设计探索轨迹与 Reflection 分析

本文分析 `neo_cast/.neo-cast` 中针对 `ETTh1.csv` 的最后一轮模型设计探索。结论基于以下本地证据：

- 数据契约：`neo_cast/.neo-cast/dataset_spec.json`
- 数据画像：`neo_cast/.neo-cast/dataset/local_csv_profile.json`
- 全局轨迹：`neo_cast/.neo-cast/research_trace.jsonl`
- 最后训练产物：`neo_cast/.neo-cast/artifacts/run_20260625-133702-hbrp`
- 最后训练后的当前候选：`neo_cast/.neo-cast/current_candidate.json`
- 冻结/带 ref-test 指标产物：`neo_cast/.neo-cast/artifacts/run_20260625-094411-hbrp`

需要先澄清一点：当前 trace 中没有单独的 `made_by: ReflectionAgent` 事件。ReflectionAgent 的 LLM 输出被写入了 ModelDesigner 的 `Candidate hypothesis`、`notes` 或 `current_candidate.notes` 中。因此本文引用的 Reflection 内容，实际是“ModelDesigner 在设计候选时记录下来的 ReflectionAgent 结论”。

## 1. 最后一次运行范围

artifact 目录中最后一个训练 run 是：

| 项 | 值 |
|---|---|
| run_id | `run_20260625-133702-hbrp` |
| candidate_id | `recipe_champion_direct_repro_v2` |
| created_at | `2026-06-25T13:37:23Z` |
| task_id | `local_csv` |
| dataset | `ETTh1.csv` |
| target | `OT` |
| input_len | `336` |
| horizon | `96` |
| val_avg_mse | `0.062759` |
| val_avg_mae | `0.189977` |
| params | `0.955201M` |

`current_candidate.json` 在 `2026-06-26 09:54` 被更新为 `recipe_timesnet_topk7_nlinear_v1`，但它没有对应更新的 `run_20260626-*` artifact。因此本文将其视为“最后设计状态/候选状态”，而不是“最后已训练运行”。最后已训练运行仍是 `recipe_champion_direct_repro_v2`。

## 2. 数据与任务画像

数据契约显示，本轮任务是单变量长序列预测：

| 项 | 值 |
|---|---|
| source_csv | `/mnt/d/kawai10726/work/codes/kawai1/NeoResearch/opencode/packages/opencode/dataset/ETTh1.csv` |
| feature_columns | `OT` |
| rows | `17420` |
| timestamp_col | `date` |
| inferred_frequency | hourly |
| train split | `[0, 12194)` |
| val split | `[12194, 13936)` |
| ref_test split | `[13936, 17420)` |
| normalization | train split standard scaling |

数据画像中，`OT` 无缺失值，时间戳单调递增，无重复时间戳，无不规则间隔。因此本轮设计的主要矛盾不是数据清洗，而是：

1. `OT` 序列存在强趋势/强自相关，模型容易退化为局部复制或简单线性外推。
2. 单窗口尺度漂移明显，需要窗口级归一化或类似 RevIN 的稳定机制。
3. H96 预测需要同时保留局部趋势、周期残差和多步输出稳定性。

## 3. 总体探索路线

这轮探索不是一次性寻找复杂模型，而是逐步收敛：

1. 先用 DLinear / decomposition MLP 建立低复杂度分解基线，确认 `0.072-0.076` 是保守下限。
2. 发现 series decomposition + MLP 没有突破 DLinear 后，切换到原始序列上的 Transformer，验证 attention 是否能从残差中提取非线性模式。
3. Transformer 平台稳定在 `0.065-0.066`，说明单纯扩大 attention 容量收益有限。
4. TimesNet 引入 multi-period / 2D FFT folding 后首次突破到 `0.0638`，证明周期建模是关键方向。
5. Reflection 将不稳定性归因到归一化、学习率、top_k 和梯度统计，促使设计转向 RevIN/NLinear 稳定基座。
6. `TimesNet + NLinear/RevIN + top_k=7` 达到 `0.062759`。
7. 最后通过 Huber/MSE、top_k=1、直接复现等消融确认：核心增益主要来自 FFT multi-period/top_k=7，而 Huber 是小幅稳定项。

## 4. 逐模型设计分析

### 4.1 DLinear 与分解基线

代表候选：

| candidate | val_mse | 设计目的 |
|---|---:|---|
| `tsf_baseline_dlinear` | `0.072132` | 建立移动平均 trend/seasonal 分解基线 |
| `recipe_decomp_mlp_v1` | `0.075260` | 在分解后用 MLP 增强非线性容量 |
| `recipe_decomp_mlp_stabilized_v2` | `0.075104` | 加 `instance_norm`、低 LR、warmup 和 grad clip 验证是否只是训练不稳 |
| `recipe_decomp_dual_dlinear_late_fusion_v1` | `0.075532` | trend/seasonal 分量独立投影再 late fusion |

为什么这样设计：

- ETTh1/OT 是强趋势序列，DLinear 的 trend/seasonal 分解是合理的第一基线。
- MLP 和 dual-DLinear 试图在保留 decomposition 先验的同时增加容量或减少 trend/seasonal 拼接混淆。
- 结果没有超过 DLinear，说明这一分解前端没有释放有效增益，甚至可能破坏了局部尺度信息。

设计结论：分解基线能工作，但性能停在 `0.072+`。后续必须转换范式。

### 4.2 轻量 Transformer 与容量放大

代表候选：

| candidate | val_mse | 设计目的 |
|---|---:|---|
| `recipe_lightweight_transformer_v1` | `0.066070` | 抛弃 decomposition，直接用 self-attention 建模原始序列残差 |
| `recipe_transformer_scaled_v2` | `0.066377` | 2 层 128 扩到 3 层 256 |
| `recipe_transformer_stabilized_scaled_v3` | `0.066144` | 降 LR、加 weight decay，修正大模型训练不稳 |
| `recipe_transformer_best_epoch_checkpoint_v4` | `0.066144` | 将瓶颈从训练稳定性转到 best epoch checkpoint |
| `recipe_transformer_shortwarmup_v5` | `0.066643` | 按 Reflection 缩短 warmup，匹配早期收敛 |
| `recipe_transformer_2layer_revin_v2` | `0.065672` | 在 RevIN 稳定基座上恢复 2 层 128 容量 |
| `recipe_gated_fft_transformer_v1` | `0.065672` | 给稳定 Transformer 加可控 FFT 分支 |

关键 Reflection 引用：

> Reflection 明确指出 "15-epoch warmup is mismatched for a model that converges by epoch 4"，且 "shorter warmup could prevent the post-peak cosine decay causing epoch 5-7 degradation"。

> Reflection 确认前次 3 层 256-dim 的失败归因于训练配方与大容量不匹配：`LR=5e-5` 对 `d_model=256` 过于激进，无 weight decay 导致模型快速记忆线性趋势。

为什么这样设计：

- 分解模型已失效，所以 Transformer 用来测试原始窗口上的非线性残差建模。
- `instance_norm` 被保留，因为它明显改善了分布偏移下的训练。
- 扩大到 3 层 256 是为了释放容量；后续降 LR、加 WD 是为了隔离“架构无效”和“训练不稳”。
- 缩短 warmup 是因为模型最佳 epoch 很早出现，过长 warmup 会让有效学习率窗口错位。

设计结论：Transformer 是有效的范式切换，能从 `0.072+` 跳到 `0.066` 左右；但普通 attention 的平台期明显，扩大容量和调 scheduler 都没有突破 TimesNet 的 `0.063` 区间。

### 4.3 TimesNet：周期归纳偏置成为主线

代表候选：

| candidate | val_mse | 设计目的 |
|---|---:|---|
| `recipe_timesnet_acf7_v1` | `0.066002` | 用 ACF 主周期 7 做 multi-period folding |
| `recipe_timesnet_wider_plateau_v2` | `0.063867` | hidden_dim 64 -> 96，提升跨周期表示容量 |
| `recipe_timesnet_wider_cosine_v3` | `0.066949` | 替换 plateau 为 cosine，验证 scheduler 稳定性 |
| `recipe_timesnet_stable_revert_v4` | `0.066258` | 回退 hidden_dim=64，排查 wider 配置是否不稳 |
| `recipe_timesnet_revin_diagnostic_v5` | `0.063867` | 用 RevIN 排查 instance_norm running stats drift |
| `recipe_timesnet_revin_only_mse_v7` | `0.063448` | TimesNet+RevIN 上测试 MSE 是否更直接 |

关键 Reflection 引用：

> Reflection 的 attributionAnalysis 明确将训练中期发散归因于 `instance_norm` 的 running statistics drift：epoch 7-14 后 valLoss 从 `0.066` 飙升至 `0.13-0.20`。

> Reflection 确认 hidden_dim=96 在两种 scheduler 下均在 epoch 7 附近触发灾难性发散，冠军 `0.063867` 可能只是提前收敛的偶然而非真实模型质量。

为什么这样设计：

- ACF 主周期 7 强，TimesNet 的 2D folding/卷积与“周期内 + 跨周期”建模高度匹配。
- hidden_dim 从 64 到 96 是为了提高多周期残差表示容量，结果首次达到 `0.063867`。
- 随后的 cosine、stable revert、RevIN 诊断不是盲目调参，而是围绕“这个提升是否稳定可复现”进行归因。
- Reflection 认为发散与归一化统计、top_k 频率分支和学习率共同有关，因此后续设计转向更稳定的 NLinear/RevIN 基座。

设计结论：TimesNet 是本轮首次真正突破 Transformer 平台的模型家族，但直接 TimesNet top_k=3/hidden_dim=96 存在训练稳定性疑问，需要与 NLinear/RevIN 结合。

### 4.4 NLinear + RevIN 稳定基座

代表候选：

| candidate | val_mse | 设计目的 |
|---|---:|---|
| `recipe_nlinear_revin_huber_cosine_v2` | `0.067765` | 用 RevIN + subtract-last 构造稳定低容量基线 |
| `recipe_nlinear_revin_mse_v3` | `0.067904` | 在稳定基座上比较 MSE 与 Huber |
| `recipe_nlinear_revin_mse_long_v4` | `0.067781` | 延长训练验证 NLinear 是否只是欠训练 |
| `recipe_nlinear_revin_mse_plateau_exit_v5` | `0.067776` | 用更长 patience 尝试突破平台 |

关键 Reflection 引用：

> 基于 reflection 的明确建议：先稳定训练再测试新架构。回退到 NLinear+RevIN 基座，MSE vs huber 的比较必须在稳定基座上公平进行。

> Reflection 确认 NLinear 的 subtract-last 去趋势是必要的稳定化组件，而非容量瓶颈。

为什么这样设计：

- NLinear 的 subtract-last 相当于每个样本窗口做局部去水平，适合强自相关、强趋势的 `OT`。
- RevIN 不维护 running statistics，每个样本独立归一化后预测再反归一化，用来避免 `instance_norm` 的训练中期漂移。
- NLinear 自身不够强，稳定在 `0.0678`，但它提供了可信的优化基座。

设计结论：NLinear+RevIN 不是最终赢家，但它是后续 TimesNet top_k=7 能稳定比较的基础设施。

### 4.5 Champion：TimesNet top_k=7 + NLinear/RevIN

代表候选：

| candidate | val_mse | 说明 |
|---|---:|---|
| `recipe_timesnet_topk7_nlinear_v1` | `0.062759` | 首次达到 champion |
| `recipe_timesnet_topk5_lr3e5_v2` | `0.062795` | top_k=5 + 低 LR，几乎持平 |
| `recipe_champion_repro_timesnet_topk7_nlinear_v1` | `0.062759` | 复现 champion，测试 head 差异 |
| `recipe_champion_direct_repro_v2` | `0.062759` | 最后一次训练 run，精确复现并固化 |

核心设计：

| 组件 | 选择 |
|---|---|
| preprocessing | `instance_norm`，在设计语义中映射为 NLinear/RevIN 稳定基座 |
| backbone | `timesnet` |
| hidden_dim | `96` |
| n_layers | `2` |
| top_k | `7` |
| kernel_size | `7` |
| loss | `huber` |
| optimizer | Adam, `lr=5e-5` |
| scheduler | cosine, `warmup_steps=15` |
| grad_clip | `1.0` |
| max_epochs | `50` |
| patience | `7` |

关键 Reflection/设计引用：

> 在 NLinear+RevIN 稳定基座上，将 TimesNet 的 top_k 频率参数从 3 提升至 7，匹配 ACF 主周期 7 的强度 0.950，让 TimesNet 的 2D FFT 卷积同时捕获除 dominant frequency 之外的次主导周期模式。

> 当前候选 notes 记录：`NLinear+RevIN 基座必须保留，仅变 encoder 组件`；top_k 从 3 提升至 7 的依据是 `ACF 主周期=7 强度 0.950`，并且 dominant frequency 周期 6097 占 34.4% 频谱能量，可能掩盖次主导周期模式。

为什么这样设计：

- NLinear/RevIN 负责稳定局部尺度与趋势，避免模型把主要容量浪费在绝对水平漂移上。
- TimesNet 负责对去趋势后的残差做多周期建模。
- top_k=7 不是随意增大，而是为了在 dominant frequency 很长、超出 context 窗口时，仍能覆盖 ACF 周期 7 及其附近频率。
- `hidden_dim=96` 是早期 TimesNet 首次突破 `0.064` 的关键容量点。
- Huber 和 grad_clip 保持训练对 outlier/多周期重建误差更稳。

设计结论：这是最终可复现的 champion。最后一次已训练运行 `recipe_champion_direct_repro_v2` 明确说它的目标是“确认 champion 的可复现性并作为任务最终成果固化”，并且验证 MSE 复现到 `0.062759`。

### 4.6 top_k 与 loss 消融

代表候选：

| candidate | val_mse | 消融含义 |
|---|---:|---|
| `recipe_champion_ablation_mse_v1` | `0.063537` | Huber -> MSE，原 LR 下不够稳定 |
| `recipe_champion_ablation_mse_stabilized_v2` | `0.062866` | MSE + 低 LR + 更紧 grad clip，几乎持平 |
| `recipe_champion_ablation_topk1_v3` | `0.067263` | top_k=7 -> 1，直接退化 |
| `recipe_champion_ablation_topk1_stabilized_v4` | `0.065346` | top_k=1 稳定化后仍明显差于 champion |

关键 Reflection 引用：

> Reflection 明确归因为 MSE loss 的无界梯度与 FFT-based TimesNet 的多周期重建 outlier 交互触发了梯度爆炸。

> Reflection 明确归因为 champion 的 `LR=5e-5` 和 `grad_clip=1.0` 是与 `top_k=7` 多频率梯度均值效应共同校准的；collapse 到 1 分支后改变了梯度统计量，优化器需要调整。

为什么这样设计：

- Huber/MSE 消融用来判断 champion 是否依赖鲁棒 loss。稳定化 MSE 只差 `+0.17%`，说明 Huber 不是主要增益来源，但有稳定训练价值。
- top_k=1 消融用来判断 FFT multi-period 是否是核心。即使稳定化后仍为 `0.065346`，比 champion 差约 `4.1%`，说明 top_k=7 的多周期覆盖是核心设计原则。

设计结论：最终模型的主因不是 Huber，而是 `NLinear/RevIN 稳定基座 + TimesNet top_k=7 multi-period` 的组合。

### 4.7 PatchTST、Mixer、SSM、RNN 等替代家族

代表候选：

| family | candidate | val_mse | 设计原因 |
|---|---|---:|---|
| RNN | `tsf_ranked_invert_rnn_feature_profiled` | `0.067085` | 测试 inverted embedding / feature fusion |
| Mixer | `recipe_mixer_revin_stabilized_v3` | `0.066746` | 用全局 time-mixing MLP 避免 FFT 不稳 |
| SSM | `tsf_ranked_ssm_graph_profiled` | `0.066556` | 测试长程状态空间建模 |
| SSM + champion base | `recipe_ssm_nlinear_champion_recipe_v1` | `0.067149` | 用 SSM 替换 TimesNet backbone，保留冠军配方 |
| PatchTST | `recipe_patchtst_v2_encoder_only` | `0.066225` | patch embedding 破坏复制 lag-1 的 fallback |
| PatchTST dense | `recipe_patchtst_v3_dense_patch` | `0.066179` | 增加 patch token 与 encoder 容量 |

关键 Reflection 引用：

> PatchTST 是 Reflection 明确推荐的下一方向：patch-based multi-scale embedding 可避免 FFT 的梯度冲突问题。

> SSM 设计中记录：Reflection 确认 NLinear 是必要的稳定化组件而非容量瓶颈。

为什么这样设计：

- PatchTST 用 patch 压缩 336 点上下文，试图避免模型直接复制 lag-1。
- Mixer 用全局 MLP time mixing 测试非 attention/非 FFT 的稳定容量。
- SSM 用线性复杂度长程状态建模测试是否能替代 TimesNet 的频域建模。
- 这些家族多数稳定，但都停在 `0.066` 左右，没有突破 champion。

设计结论：替代架构排除了“只要换大模型就能更好”的假设。对这个单变量 ETTh1/H96 任务，最关键的是周期归纳偏置与局部尺度稳定，而不是架构复杂度本身。

## 5. 完整候选轨迹表

| 时间 UTC | candidate | val_mse | 主要意图 |
|---|---|---:|---|
| 07:24 | `tsf_baseline_dlinear` | `0.072132` | 分解线性基线 |
| 07:31 | `recipe_decomp_mlp_v1` | `0.075260` | 分解后加 MLP |
| 07:37 | `recipe_decomp_mlp_stabilized_v2` | `0.075104` | 分解 MLP 稳定化 |
| 07:44 | `recipe_decomp_dual_dlinear_late_fusion_v1` | `0.075532` | trend/seasonal 独立线性再融合 |
| 07:50 | `recipe_lightweight_transformer_v1` | `0.066070` | 切换到原始序列 self-attention |
| 07:56 | `recipe_transformer_scaled_v2` | `0.066377` | 扩大 Transformer 容量 |
| 08:03 | `recipe_transformer_stabilized_scaled_v3` | `0.066144` | 大 Transformer 降 LR 加 WD |
| 08:10 | `recipe_transformer_best_epoch_checkpoint_v4` | `0.066144` | best epoch checkpoint |
| 08:16 | `tsf_ranked_invert_rnn_feature_profiled` | `0.067085` | RNN/inverted embedding |
| 08:23 | `recipe_transformer_shortwarmup_v5` | `0.066643` | 缩短 warmup |
| 08:30 | `recipe_timesnet_acf7_v1` | `0.066002` | TimesNet ACF=7 |
| 08:37 | `recipe_timesnet_wider_plateau_v2` | `0.063867` | TimesNet hidden_dim=96 |
| 08:44 | `recipe_timesnet_wider_cosine_v3` | `0.066949` | scheduler 诊断 |
| 08:51 | `recipe_timesnet_stable_revert_v4` | `0.066258` | 回退稳定 TimesNet |
| 08:58 | `recipe_timesnet_revin_diagnostic_v5` | `0.063867` | RevIN 诊断 |
| 09:05 | `recipe_nlinear_revin_huber_cosine_v2` | `0.067765` | NLinear+RevIN 稳定基座 |
| 09:12 | `recipe_timesnet_revin_only_corrected_v6` | `0.063867` | TimesNet+RevIN |
| 09:22 | `recipe_timesnet_revin_only_mse_v7` | `0.063448` | TimesNet+RevIN+MSE |
| 09:29 | `tsf_ranked_frequency_mixer_profiled` | `0.076235` | frequency mixer |
| 09:36 | `recipe_nlinear_revin_mse_v3` | `0.067904` | NLinear 基座 MSE |
| 09:44 | `recipe_timesnet_topk7_nlinear_v1` | `0.062759` | 首次 champion |
| 09:52 | `recipe_timesnet_topk5_lr3e5_v2` | `0.062795` | top_k=5 稳定化 |
| 10:00 | `recipe_mini_transformer_revin_v1` | `0.066356` | 极轻 Transformer |
| 10:08 | `recipe_transformer_2layer_revin_v2` | `0.065672` | RevIN + 2 层 Transformer |
| 10:18 | `recipe_gated_fft_transformer_v1` | `0.065672` | gated FFT Transformer |
| 10:25 | `recipe_mixer_revin_huber_v1` | `0.067370` | MLP-Mixer |
| 10:32 | `recipe_mixer_revin_stabilized_v2` | `0.066966` | Mixer 稳定化 |
| 10:40 | `recipe_mixer_revin_stabilized_v3` | `0.066746` | Mixer 进一步稳定 |
| 10:47 | `recipe_nlinear_revin_residual_v1` | `0.069711` | NLinear + residual correction |
| 10:54 | `recipe_dlinear_residual_correction_v1` | `0.076407` | DLinear + residual correction |
| 11:03 | `recipe_encoder_decoder_transformer_v1` | `0.066162` | Encoder-Decoder Transformer |
| 11:13 | `recipe_encoder_decoder_deep_v2` | `0.066312` | 深 encoder-decoder |
| 11:20 | `recipe_nlinear_revin_mse_long_v4` | `0.067781` | NLinear 长训练 |
| 11:27 | `tsf_ranked_ssm_graph_profiled` | `0.066556` | SSM |
| 11:34 | `tsf_mutation_35_recipe_timesnet_topk7_nlinear_v1` | `0.065941` | champion mutation |
| 11:41 | `recipe_patchtst_encoder_only_v1` | `0.066295` | PatchTST v1 |
| 11:47 | `recipe_nlinear_revin_mse_plateau_exit_v5` | `0.067776` | NLinear plateau exit |
| 11:56 | `recipe_champion_repro_timesnet_topk7_nlinear_v1` | `0.062759` | champion 复现 |
| 12:07 | `recipe_stable_timesnet_topk7_lowlr_v1` | `0.063245` | top_k=7 低 LR |
| 12:17 | `recipe_timesnet_stable_topk7_v2` | `0.064016` | top_k=7 稳定化 |
| 12:25 | `recipe_timesnet_topk5_layer_norm_v3` | `0.064016` | top_k=5 + LayerNorm |
| 12:32 | `recipe_patchtst_v2_encoder_only` | `0.066225` | PatchTST encoder-only |
| 12:40 | `recipe_patchtst_v3_dense_patch` | `0.066179` | dense PatchTST |
| 12:47 | `recipe_patchtst_v4_short_warmup` | `0.066282` | PatchTST short warmup |
| 12:53 | `recipe_ssm_nlinear_champion_recipe_v1` | `0.067149` | SSM + champion base |
| 13:04 | `recipe_champion_ablation_mse_v1` | `0.063537` | Huber -> MSE 消融 |
| 13:13 | `recipe_champion_ablation_mse_stabilized_v2` | `0.062866` | MSE 稳定化消融 |
| 13:21 | `recipe_champion_ablation_topk1_v3` | `0.067263` | top_k=1 消融 |
| 13:28 | `recipe_champion_ablation_topk1_stabilized_v4` | `0.065346` | top_k=1 稳定化消融 |
| 13:37 | `recipe_champion_direct_repro_v2` | `0.062759` | 最后一次训练 run，精确复现 |

## 6. 最终模型为什么这样设计

最终模型可以概括为：

> 先用窗口级归一化/NLinear 思路消除局部尺度和趋势漂移，再用 TimesNet 的 top_k=7 multi-period FFT/2D convolution 学习去趋势残差中的多个周期成分，最后用线性 head 输出 H96 点预测。

最终选择的原因：

| 设计点 | 原因 |
|---|---|
| `instance_norm` / RevIN 语义 | ETTh1/OT 的局部尺度漂移明显；Reflection 多次指出 running statistics drift 和 per-sample normalization 是稳定性关键 |
| NLinear/subtract-last 基座 | 稳定梯度流，防止模型被绝对水平和趋势支配 |
| TimesNet backbone | ACF 主周期强，2D folding/卷积比普通 attention 更适合周期残差 |
| `top_k=7` | top_k=1 消融退化到 `0.065346`，证明多周期覆盖是核心收益 |
| `hidden_dim=96` | TimesNet 首次突破 `0.064` 的容量点 |
| Huber loss | 不是主要增益，但对 FFT outlier 与训练稳定有帮助 |
| `lr=5e-5` + `grad_clip=1.0` | 与 top_k=7 的多频率梯度统计共同校准；改变 top_k 后需要重新调优化器 |
| cosine warmup=15 | 在 champion 配置下可复现，配合 patience=7 固化最佳点 |

## 7. 逐候选设计原因索引

本节按最后一轮实际运行顺序，逐一说明每个候选为什么这样设计。

| # | candidate | 设计原因 | 结果解读 |
|---:|---|---|---|
| 1 | `tsf_baseline_dlinear` | 用 moving-average decomposition 分离 trend/seasonal，并用线性层预测；这是强趋势时间序列的经典低复杂度基线。 | `0.072132` 建立了 decomposition-aware 下限。 |
| 2 | `recipe_decomp_mlp_v1` | 保留 DLinear 的分解先验，但将线性层替换为浅层 MLP，测试非线性容量能否突破 DLinear。 | `0.075260` 反而更差，说明简单加 MLP 没有利用好分解特征。 |
| 3 | `recipe_decomp_mlp_stabilized_v2` | 在分解 MLP 上加入 `instance_norm`、低 LR、cosine warmup 和 grad clip，验证上一轮失败是否来自训练不稳定。 | `0.075104` 仍差，说明瓶颈主要是架构/归纳偏置而非训练配方。 |
| 4 | `recipe_decomp_dual_dlinear_late_fusion_v1` | trend 和 seasonal 分量分别线性投影，再学习 late fusion 权重，避免拼接后特征混淆。 | `0.075532` 未改善，分解路线基本确认到顶。 |
| 5 | `recipe_lightweight_transformer_v1` | 放弃 decomposition，在 `instance_norm` 后直接用 2 层 Transformer 学习原始序列残差；Reflection/trace 认为分解尝试已聚类在 `0.075-0.076`，必须转换范式。 | `0.066070` 大幅优于分解模型，说明 self-attention 范式有效。 |
| 6 | `recipe_transformer_scaled_v2` | 将 Transformer 从 2 层 128 扩到 3 层 256；Reflection 记录“仅 0.2% 的 768-dim 权重向量被使用”，推断容量仍有余量。 | `0.066377` 没有提升，单纯扩容无效。 |
| 7 | `recipe_transformer_stabilized_scaled_v3` | 保持大 Transformer，但降低 LR、加 weight decay；Reflection 将上一轮失败归因于 `LR=5e-5` 对大模型过激、无 WD 易记忆线性趋势。 | `0.066144` 稍好但仍在平台区。 |
| 8 | `recipe_transformer_best_epoch_checkpoint_v4` | 保持大 Transformer 和稳定训练配方，只改为 best-epoch checkpoint；Reflection 认为瓶颈从训练稳定转为 early stopping 校准。 | `0.066144` 与前一轮相同，checkpoint 未带来实际突破。 |
| 9 | `tsf_ranked_invert_rnn_feature_profiled` | 用 profile-ranked inverted embedding + RNN/feature fusion，测试跨变量/特征融合路径是否能改善预测。 | `0.067085` 接近 Transformer 平台但不优。 |
| 10 | `recipe_transformer_shortwarmup_v5` | 缩短 warmup 到 3 epoch；Reflection 明确指出 “15-epoch warmup is mismatched for a model that converges by epoch 4”。 | `0.066643` 变差，说明 warmup 错配不是主要瓶颈。 |
| 11 | `recipe_timesnet_acf7_v1` | 根据 ACF 主周期 7，将序列做 TimesNet multi-period folding，用 2D 卷积捕获周期内/跨周期模式。 | `0.066002` 略优于 Transformer，周期归纳偏置开始有效。 |
| 12 | `recipe_timesnet_wider_plateau_v2` | hidden_dim 从 64 增至 96，并用 plateau 调度保留最佳 epoch；Reflection 认为 hidden_dim=64 可能欠参数化。 | `0.063867` 首次明显突破平台，但后续需要验证稳定性。 |
| 13 | `recipe_timesnet_wider_cosine_v3` | 保持 wider TimesNet，改回 cosine 并缩短 warmup；Reflection 指出 plateau 后期 valLoss 飙升，cosine 历史上更稳。 | `0.066949` 退化，说明调度切换没有保住 wider 收益。 |
| 14 | `recipe_timesnet_stable_revert_v4` | 回退 hidden_dim=64，保留 TimesNet 周期结构，验证 `0.063867` 是否只是 wider 的不稳定早期快照。 | `0.066258` 回到平台区，提示 hidden_dim=96 容量重要但不稳定。 |
| 15 | `recipe_timesnet_revin_diagnostic_v5` | 用 RevIN 替换有 running statistics 的 instance_norm；Reflection attributionAnalysis 将中期发散归因于 running statistics drift。 | `0.063867` 复现 wider 收益，RevIN/实例归一化方向成立。 |
| 16 | `recipe_nlinear_revin_huber_cosine_v2` | 构建 NLinear+RevIN 稳定基座；subtract-last 适配强趋势和 ACF lag-1 高相关。 | `0.067765` 不够强，但提供稳定训练基线。 |
| 17 | `recipe_timesnet_revin_only_corrected_v6` | 将 RevIN 与原始 TimesNet 结合，不加 NLinear，测试能否既消除 drift 又保留完整容量。 | `0.063867` 与 wider TimesNet 持平，说明 RevIN 稳定但还需进一步提升。 |
| 18 | `recipe_timesnet_revin_only_mse_v7` | 在 TimesNet+RevIN 上把 Huber 换成 MSE；设计假设是 MSE 与 RevIN denormalization 梯度更直接。 | `0.063448` 小幅提升，但未到 champion。 |
| 19 | `tsf_ranked_frequency_mixer_profiled` | profile-ranked frequency embedding + Mixer，测试频域嵌入和 MLP mixing 是否能捕获季节结构。 | `0.076235` 明显失败，频率 Mixer 路线不适合当前配置。 |
| 20 | `recipe_nlinear_revin_mse_v3` | 按 Reflection 建议“先稳定训练再测试新架构”，在 NLinear+RevIN 基座上公平比较 MSE 与 Huber。 | `0.067904` 与 Huber 几乎持平，NLinear 容量不足。 |
| 21 | `recipe_timesnet_topk7_nlinear_v1` | 在 NLinear+RevIN 稳定基座上，将 TimesNet `top_k` 从 3 提到 7，以覆盖 ACF 主周期 7 及次主导频率；Reflection 强调基座必须保留，仅变 encoder。 | `0.062759` 首次 champion，证明多周期 FFT 是核心突破。 |
| 22 | `recipe_timesnet_topk5_lr3e5_v2` | 根据 Reflection，将 top_k 从 7 降到 5、LR 降到 `3e-5`，减少 top_k=7 可能引入的噪声频带和优化不稳。 | `0.062795` 几乎持平，说明 top_k=5/7 都在有效多周期区间。 |
| 23 | `recipe_mini_transformer_revin_v1` | 用极轻 Transformer + RevIN，避免 TimesNet FFT 梯度冲突，测试无 FFT 的稳定 attention 下限。 | `0.066356` 稳定但不够强。 |
| 24 | `recipe_transformer_2layer_revin_v2` | 在 mini Transformer 稳定基础上恢复 2 层 128 容量，尝试接近 champion。 | `0.065672` 到达 Transformer 平台，仍不如 TimesNet。 |
| 25 | `recipe_gated_fft_transformer_v1` | 在稳定 Transformer 上加 gated FFT 分支，让模型可学习地启用/抑制频率增强。 | `0.065672` 与纯 Transformer 相同，FFT gating 未释放增益。 |
| 26 | `recipe_mixer_revin_huber_v1` | 用 MLP-Mixer + RevIN 做全局 time mixing，测试非 attention/非 FFT 的稳定容量。 | `0.067370` 略差于 Transformer。 |
| 27 | `recipe_mixer_revin_stabilized_v2` | 增大/稳定 Mixer，降低 LR、调整正则，排查 v1 是否只是训练不稳。 | `0.066966` 有改善但仍不突破。 |
| 28 | `recipe_mixer_revin_stabilized_v3` | 根据 Reflection 继续降低 LR、加 dropout/WD、改 plateau scheduler，针对 epoch 11 后过拟合发散。 | `0.066746` 稳定但仍在平台上方。 |
| 29 | `recipe_nlinear_revin_residual_v1` | 在 NLinear 后加 residual_correction head，显式建模局部线性预测后的残差漂移。 | `0.069711` 残差头没有有效发挥，反而损害稳定基座。 |
| 30 | `recipe_dlinear_residual_correction_v1` | 用 DLinear decomposition 替代 NLinear subtract-last，再接 residual correction；Reflection 认为 subtract-last 可能过度丢趋势。 | `0.076407` 明显失败，DLinear+残差校正不适合。 |
| 31 | `recipe_encoder_decoder_transformer_v1` | 用 encoder-decoder Transformer 和 96 个 learnable query tokens，通过 cross-attention 直接映射 336->96。 | `0.066162` 稳定但仍是 Transformer 平台。 |
| 32 | `recipe_encoder_decoder_deep_v2` | 加深 encoder 到 4 层，并用 query-generator MLP 区分预测 query；回应 Reflection 对 encoder 表示不足、query 区分差的担忧。 | `0.066312` 没有提升。 |
| 33 | `recipe_nlinear_revin_mse_long_v4` | 在 NLinear+RevIN 上延长到 80 epoch、提高 patience，验证 MSE 是否只是收敛不够。 | `0.067781` 与原 NLinear 持平，容量瓶颈确认。 |
| 34 | `tsf_ranked_ssm_graph_profiled` | 用 SSM + correlation graph fusion 测试长程状态空间结构和图融合。 | `0.066556` 稳定但不优。 |
| 35 | `tsf_mutation_35_recipe_timesnet_topk7_nlinear_v1` | 对 champion 做小规模 bridge-safe mutation，测试局部变体是否能继续改进。 | `0.065941` 退化，champion 配方较敏感。 |
| 36 | `recipe_patchtst_encoder_only_v1` | 用重叠 patch embedding 压缩 336 点为约 40 token，破坏直接复制 lag-1 的 fallback 路径。 | `0.066295` 未突破，但验证 PatchTST 路线稳定。 |
| 37 | `recipe_nlinear_revin_mse_plateau_exit_v5` | NLinear+RevIN 延长到 100 epoch、patience 20，测试是否能靠更长训练离开 `0.0678` 平台。 | `0.067776` 仍平台，NLinear 上限明确。 |
| 38 | `recipe_champion_repro_timesnet_topk7_nlinear_v1` | 直接复现 champion，但将 prediction head 改为 direct_multi_horizon，测试 champion 是否依赖 head 类型。 | `0.062759` 复现成功，说明核心不是 head 小差异。 |
| 39 | `recipe_stable_timesnet_topk7_lowlr_v1` | 按 Reflection 建议将 LR 降到 `1e-5`、grad_clip 收紧到 `0.5`，验证 top_k=7 在稳定训练下是否仍有效。 | `0.063245` 稍差但仍优于平台，top_k=7 方向有效。 |
| 40 | `recipe_timesnet_stable_topk7_v2` | 放松 grad_clip 到 `0.8`、恢复 warmup=15、patience=7，平衡低 LR 过慢和梯度截断过强。 | `0.064016` 稳定但不如 champion。 |
| 41 | `recipe_timesnet_topk5_layer_norm_v3` | top_k=5 减少噪声频带，并在 head 前加 LayerNorm 平滑 FFT 特征到线性投影的梯度流；这是 Reflection 建议的最后 TimesNet 方向。 | `0.064016` 未突破，LayerNorm/top_k5 不是更优解。 |
| 42 | `recipe_patchtst_v2_encoder_only` | Reflection 推荐 patch-based multi-scale embedding 避免 FFT 梯度冲突；使用 patch_size=16/stride=8 + direct linear head。 | `0.066225` 稳定但不接近 champion。 |
| 43 | `recipe_patchtst_v3_dense_patch` | patch_size=8/stride=4 产生更多 token，3 层 256 encoder + MLP head 提升表示容量。 | `0.066179` 仅微幅改善，容量增加收益有限。 |
| 44 | `recipe_patchtst_v4_short_warmup` | Reflection 指出 15 epoch warmup 消耗过多有效训练窗口，因此 dense PatchTST 缩短 warmup 到 5。 | `0.066282` 未改善，PatchTST 平台确认。 |
| 45 | `recipe_ssm_nlinear_champion_recipe_v1` | 用 SSM 替换 TimesNet backbone，保留 champion 的 NLinear/RevIN、Huber、LR、warmup 和 grad_clip；测试长程状态空间能否替代 FFT。 | `0.067149` 失败，TimesNet 的周期归纳偏置不可简单替代。 |
| 46 | `recipe_champion_ablation_mse_v1` | 对 champion 做 Huber->MSE 消融，其余完全不变，量化 loss 的边际贡献。 | `0.063537` 稍差且有不稳迹象，需要稳定化重跑。 |
| 47 | `recipe_champion_ablation_mse_stabilized_v2` | 按 Reflection 将 LR 降到 `2e-5`、grad_clip 收紧到 `0.5`，隔离 MSE loss 的真实影响。 | `0.062866` 仅比 champion 差 `0.17%`，Huber 非核心。 |
| 48 | `recipe_champion_ablation_topk1_v3` | top_k=7->1，禁用多周期分支，直接测试 FFT multi-period 的边际贡献。 | `0.067263` 明显退化，但原优化器可能与 top_k=7 共适配。 |
| 49 | `recipe_champion_ablation_topk1_stabilized_v4` | 对 top_k=1 消融做稳定化：LR 降到 `2e-5`、grad_clip 收紧到 `0.5`；Reflection 认为 collapse 到 1 分支改变梯度统计。 | `0.065346` 仍比 champion 差约 `4.1%`，确认 multi-period 是核心。 |
| 50 | `recipe_champion_direct_repro_v2` | 精确复现 champion 全配置：TimesNet top_k=7/hidden_dim=96 + NLinear/RevIN-style instance norm + Huber + `lr=5e-5` + warmup=15 + grad_clip=1.0。 | `0.062759` 再次复现，作为最后已训练运行和最终固化结果。 |

## 8. ref-test 与发布风险

`run_20260625-094411-hbrp` 是带 ref-test 指标的冻结产物：

| 指标 | 值 |
|---|---:|
| val_avg_mse | `0.062759` |
| val_avg_mae | `0.189977` |
| ref_test_avg_mse | `0.098356` |
| ref_test_avg_mae | `0.241023` |

验证集到 ref-test 的 gap 较大，说明最终模型虽然在 validation 上稳定复现，但对后段分布仍可能敏感。若要作为 benchmark 发布，应补充：

1. 多 seed 结果，至少 `42/0/1234`。
2. 冻结 test-only 流程，避免在 ref-test 上反复选择。
3. 按时间段切片的误差分析，确认是否存在 ETTh1 后段分布漂移。
4. top_k=5 与 top_k=7 的多 seed 对比，因为 `top_k5_lr3e5_v2` 已达到 `0.062795`，可能更稳。

## 9. 总结

本轮 ETTh1.csv 模型设计的核心思路是从“分解线性基线”逐步转向“稳定局部归一化 + 多周期频域建模”。DLinear 和 decomposition MLP 建立了下限，Transformer 证明原始序列 attention 有效但有平台期，TimesNet 证明周期归纳偏置是突破方向，NLinear/RevIN 解决训练稳定性，最后 top_k=7 的多周期覆盖带来主要性能增益。

最终 `recipe_champion_direct_repro_v2` 不是偶然堆复杂度，而是经过多轮 Reflection 归因和消融后得到的组合：`TimesNet(top_k=7, hidden_dim=96) + NLinear/RevIN-style instance normalization + Huber + cosine warmup + calibrated LR/grad_clip`。其中最关键的可验证结论是：`top_k=1` 稳定消融退化到 `0.065346`，而 Huber->MSE 稳定消融仍有 `0.062866`，因此 champion 的主要设计原因是 multi-period FFT/top_k=7，而不是 loss 函数本身。
