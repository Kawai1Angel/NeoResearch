# Recipe runtime v2 合同


> 2026-09-27 更新：删除 `direct_multi_horizon`（schema、registry、工厂及搜索入口）；旧配置明确拒绝，不转换为其他 head。`gated_depthwise_conv` / `timesnet_lite` 保留请求的偶数卷积核，以非对称 padding 保持长度。候选仅对缺失字段补默认值，显式非法值和不兼容 embedding 返回校验错误供 agent 修正。旧偶数核 checkpoint 不自动转换，需重训。
本文冻结 semantic correction plan 批次三的设计检查点。

- Proposal 使用 `recipe_schema_v2`；ModelRecipe DSL 仍为 `model_recipe.v1`，编译到 v2。checkpoint 必须带 `runtime_semantics_revision=2`，缺失或不匹配时要求重训。
- checkpoint 和 metadata.training_summary 保存每个 H 的 manifest 与合并的 `model_manifest_digest`。参数图摘要包含实际模块、参数 shape 及 dropout/gate/residual 等有效开关；独立导出加载时核对参数图。
- 所有 encoder 返回 `[B,C,D]`。实现内部允许 `[B*C,D]`，公开 `encode` 保持统一 shape。D 固定为 min(input_len,64)，独立于 horizon；head 独占 `[B,C,D] → [B,H,C]` 最终投影（decomposition 的独立 trend 分支除外）。
- Linear head 为共享线性投影；direct head 每个 lead step 一个非线性 tower。Quantile/Gaussian/residual head 直接消费 latent。跨任务预测长度共享不实现，每个 H 独立训练。
- Linear backbone 的 shared=false 为逐通道独立 encoder。变量 token 路径使用同一 latent 合同。`variate_attention` 在变量 token 上执行 self-attention；`feature_mlp` 在原序列通道轴上执行 MLP。
- Ordered fusion 在 latent 或输入上执行显式 gate/residual 公式，gate 为输入条件 channel gate。Gated hybrid 融合 temporal encoder 和独立 feature encoder 的 latent；time gate 指历史时间维（聚合为 latent 混合权重），不是 forecast horizon。
- Graph 的 correlation 在当前 train fold 拟合；static topology 必须提供带有序 channel_names 的 artifact。adjacency 随 model_config/state_dict 持久化并进入 manifest digest。
- Decomposition 属于 preprocessing wrapper：trend 用独立 Linear(T,H)，residual 用 recipe encoder/head。两支不共享参数。
- Dropout 仅保留模块级配置，移除 training regularization.dropout。missing mask 在物化填补前保存，模型接收已填补 values 和独立 mask；不再支持模型层 fill_policy。
- `missing_mask` 必须排在变换前，`mask_channel` 只允许 true，并要求跨变量 fusion，避免追加的 mask 对目标完全不可见。旧数据没有 mask 列时应重新物化。CV 根据原始 mask 恢复缺失位置并按各 fold 的 train rows 重新填补与拟合 scaler。
- 显式保留一项语义别名：`temporal/channel_mode=shared` 与 `feature_mlp` 都是原序列 ChannelMixer，manifest 的 `fusion_equivalence` 标记该关系；研究归因不能将二者计为不同机制。`sample_reweighting/uniform` 也明确表示无样本重加权。
- 导出 `history`/`target_history` 为已填补值，`missing_mask` 为与 target+past 顺序一致的 `[T,C]` 原始缺失标记（1=缺失），不会按 mask 再次覆写填补值。原始 NaN 的直接模型调用仅提供标准化空间零值兜底，不代替数据层清洗合同。
- `ssm` 改名 `gated_depthwise_conv`，state_dim 改为 hidden_dim；`timesnet` 改名 `timesnet_lite`，标记 paper_derived，不能归因为完整论文模型复现。
