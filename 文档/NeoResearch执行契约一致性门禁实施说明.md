# NeoResearch 执行契约一致性门禁实施说明

本次按《NeoResearch执行契约一致性门禁修改方案》实现假设关联、实例化模型校验、无效实验隔离及原候选恢复。已有暂存修改保持原状，本次未提交 Git commit。

## 实现范围

- Candidate 增加可空的 `hypothesisID`，数据库增加 `hypothesis_id` 迁移；已有记录可以读取，新 TSF 实验必须关联假设池中的结构化 ID。该 ID 是假设池的 `H1` 等标识，不是数据库行 ID，也不从 rationale 文本推断。
- Gate A 校验假设关联及允许的 backbone；模型别名同时校验其 embedding 约束。Designer 最终 recipe 的 backbone、预处理顺序和声明的输入协变量也参与校验。
- TS/Python 共用排序对象键、保持数组顺序的 canonical JSON 和 SHA-256。Candidate 摘要以写给 Python 的 bridge payload 为准，包含运行 seed；不能混用前端 camelCase recipe 的摘要。
- Python 在实例化全部模型后、创建 optimizer 和开始 epoch 前，输出 `executed_model_manifest`，检查实际模块、resolved recipe、通道数、candidate 摘要及 contract 摘要。未知模块、缺失或过期证明按不一致处理。
- `baseline`、`low_fidelity`、`full` 创建前必须已有当前 candidate/seed 的成功 smoke、有限指标及匹配的模型证明。`--skip-smoke` 只可复用有效证明。正式 NeoResearch 服务、队列 worker 和 CLI worker 都接入门禁，独立 worker 也检查执行计划及证明。
- 不一致时退出码为 `5`，运行记为 `invalid`，指标清空，假设证据为 `inconclusive`；不进入预算、champion、plateau、研究 memory、Reflection 统计或模型失败重试。输出 violation artifact 并暂停任务。
- 每次失败产生独立的 `execution_contract_violation` protocol checkpoint。未批准时阻止继续执行和研究规划；批准后锁定原 candidate、hypothesis 和 seed，先重新 smoke，再执行 full。再次失败产生新 checkpoint；成功后关联 smoke 证明并解决同一 candidate 的历史未关闭 blocker。并发的旧运行不能解除新 blocker。
- SDK、CLI/TUI 和 dashboard 数据类型支持 `invalid`，cockpit 显示修复及批准 checkpoint 的提示。

## 恢复入口与兼容性

沿用现有 protocol checkpoint 批准机制。批准后继续 pipeline 会优先处理执行契约恢复；服务也提供 `resumeExecutionContractCheckpoint(taskID)`。恢复不会调用 HypoPlanner 或 Designer 生成替代方向。

正式 NeoResearch TSF 路径默认强制门禁。独立 NeoCast CLI 通过 contract/proof 参数或 `NEO_CAST_EXECUTION_CONTRACT`、`NEO_CAST_CONTRACT_CANDIDATE`、`NEO_CAST_CONTRACT_VERIFICATION` 启用；未携带契约的历史独立调用保持兼容。本次没有增加可绕过正式门禁的 shadow 开关。

## 验证与限制

- Python 新门禁及已有 recipe factory 定向测试：49 项通过，包括 TimesNet 被替换成 MLP、预处理顺序变化、通道变化、过期摘要，以及不一致时 optimizer/epoch 尚未启动。
- Bun 六组门禁、compiler、reflection、designer、runner client、runtime 定向回归：54 项通过。端到端覆盖 full 零记录、NAS 暂停、invalid 不计预算和统计、未批准阻止恢复、再次失败独立 checkpoint、修复后原候选 smoke/full。
- `bun run typecheck` 通过。
- 已运行 `neo_cast` 的 `npm test`，Node 部分 67/69 通过；剩余失败为本地缺少 `datasets (1)/ETTh1.csv` 和 prompt 未包含 schema 中的部分 scheduler 名称。该命令在 Node 失败后未继续 Python 部分。
- 单独运行 Python 全量回归，112/113 通过；剩余 `test_research_trace` 仍要求 `val_avg_mse`，当前 CV trace 输出使用 `cv_avg_mse`。以上全量结果取自新增最后一项 optimizer 门禁测试前的检查。
- 已运行旧 `service.test.ts`，34/72 通过。失败包含未提供结构化假设/已验证 smoke 的旧 full-run fixture、假设允许 linear/dlinear 却生成 MLP 的旧自动研究流程，以及现有 baseline 数量和 blind-test 前提断言。本次新增端到端测试使用显式契约证明；旧 service 测试尚未全部迁移，因此全量回归不能宣称通过。

定向测试使用确定性本地 runner fixture 验证服务状态流；实际 PyTorch 模块检查由 Python 测试覆盖。本次未运行真实数据集的长时间 full-training 或线上发布。
