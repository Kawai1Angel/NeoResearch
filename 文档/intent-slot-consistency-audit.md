# Intent slot 一致性检查

本次检查覆盖 17 个已支持字段的工具输入、数据库写入、独立回读及下游读取位置。并非所有 slot 都是训练参数；描述性需求与可执行约束在下表中区分。

| Slot | 持久化及消费位置 | 检查结果与处理 |
| --- | --- | --- |
| interaction_mode | metadata.interactionMode；检查点策略 | 原先只更新 intentSlots，模式读取不到；已同步并校验取值 |
| forecast_object | intentSlots、metadata.forecastObject；Agent 上下文 | 原先 intent 回读正常；补齐元数据映射 |
| data_source | dataset.path；画像和数据准备 | 已有映射；修复同次更新外生变量仍读取旧 CSV 的问题 |
| target_columns | dataset.targetCols；画像及训练 | 已有映射；增加输入类型校验 |
| lookback_window | contextLength；执行配置 | 原先仅 intent 回读变新，执行值未变；已同步 |
| prediction_horizon | predictionLengths；执行配置 | 原先旧执行值遮盖新 slot；已同步 |
| time_grain | intentSlots、metadata.timeGrain；规划上下文 | 原先别名存在但工具/快照遗漏；补为可选 slot，不自动重采样 |
| exogenous_variables | observedPastCovariates、knownFutureCovariates | 已有映射；更换 CSV 后 all 按新文件重新解析 |
| future_covariate_availability | futureCovariateAvailability、knownFutureAvailability、数据角色 | 已有映射；补齐工具公开的 slot 列表 |
| business_context | intentSlots、metadata.businessContext；Agent 上下文 | 原先 intent 回读正常；补齐元数据映射 |
| primary_metric | objective.primaryMetric、evaluation.metricPrimary | 原先旧 objective 遮盖新 slot；两处同步并经 TSF 指标枚举验证 |
| secondary_metrics | objective.secondaryMetrics | 原先旧列表遮盖新 slot；支持替换和清空。不自动转成多目标排序或 tie-breaker |
| error_preferences | objective.errorPreferences；规划上下文 | 补齐 objective 映射；不自动改写 loss 权重 |
| latency_budget | budget.latencyBudget；检索及规划上下文 | 补齐 budget 映射；当前不提供推理延迟硬限制，也不将其误用为训练时限 |
| parameter_budget | budget.parameterBudget、constraints.maxParams、cost verifier | 明确整数/5M 等规格转为绝对参数个数并进入 recipe 的 max_params；统一 verifier 单位。自由文本只作为偏好 |
| interpretability | intentSlots、metadata.interpretability；Agent 上下文 | 补齐元数据映射；不保证自动选择某一架构 |
| deployment_target | runtime.deploymentTarget；运行配置及规划上下文 | 原先只更新 slot；已同步 runtime，不自动部署或分配硬件 |

所有 slot 仍保留在 `metadata.intentSlots` 供意图记录使用。具有执行含义的字段在同一次数据库更新中同步到 taskSpec、objective 或 budget。仅同步此次明确修改的字段，避免后续无关编辑把旧 slot 再覆盖回执行配置。

错误 slot 名、非法类型、非法模式/指标、非法 horizon/lookback 在写入前报错。工具公开列表与 slot 定义共用同一份常量，避免文档和实现再次漏项。

参数预算的数值输入表示绝对参数个数；`5M` 表示 5,000,000。修改为自由文本或无硬约束后，会移除该 slot 对应的旧 maxParams，避免隐藏旧限制。旧任务没有该标记时保留原 verifier 的兼容读取逻辑。

验证覆盖：全部 slot 写入后独立回读、执行字段一致性、清空列表/硬上限、更换 CSV、非法输入整次不落库、参数个数到百万单位的换算，以及既有 Intent/Verifier/Research service 测试。

已针对当前任务 `rtsk_0c82430eb001y6PsuLevHdyF9r` 修复之前已写入的 horizon 意图与执行值不一致：两处均为 `[96, 192, 336, 720]`，并记录 repair 日志。其余历史任务未批量改写。
