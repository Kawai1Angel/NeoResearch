# codex review NeoResearch 目标规划对齐缺口与待改进点

评估日期：2026-05-02

对齐依据：

- 规划文档：`文档/neo_research_目标与关键技术指导提示.md`
- 当前实现：`opencode/packages/opencode/src/research/`、`opencode/packages/opencode/src/cli/cmd/research*.ts`、`opencode/packages/opencode/src/cli/cmd/tui/routes/research-cockpit*.ts*`、`neo_cast/py/`

## 总体结论

当前 NeoResearch 已经具备一个可运行的 TSF 研究闭环骨架：可以创建 task，生成候选 recipe，调用 Neo-Cast runner 训练或 smoke 验证，记录 run/artifact/memory/approval，并通过 CLI/API/TUI 触发 pipeline。它已经不是单纯的 prompt demo。

但和规划文档相比，当前实现仍更接近“Research OS + TSF runner MVP”，还不是完整的 Autonomous Research Agent。主要差距集中在六处：

1. 交互模式还没有成为一等状态机能力，`companion` 被映射成 `review`，导致它不能真正走“伴随式自动执行 + checkpoint 确认”的路径。
2. Intent Agent 只是确定性槽位检查，没有多轮需求澄清状态、`intent_spec.md` 产物和真正的任务规格确认流程。
3. Data Analysis 已有 profile 和三份 markdown，但定量/定性/Main Agent 仍是同步函数生成的轻量报告，不是真正的 sub-agent team。
4. NAS Agent 已能跑 autonomous loop，但缺少规划文档要求的 `model_search_plan.md`、`leaderboard.md`、`experiment_log.md`、`reflection_notes.md` 等稳定文件契约。
5. Verifier、Reflection、Training、Evaluation、Report/Release Agent 目前大多是 service 内部函数或 runner 逻辑，不是独立 Agent I/O contract。
6. Skill、长期 Memory、Benchmark、Failure Recovery、Session filesystem、Human checkpoint environment 仍未形成完整工程机制。

## 已经基本对齐的部分

| 规划要求 | 当前实现 | 评价 |
| --- | --- | --- |
| TSF 作为第一阶段验证场景 | `TSFDomain`、Neo-Cast runner、recipe schema、dataset preparation、train/export 脚本已经存在 | 基本对齐 |
| Task/Candidate/Run/Artifact/Memory/Approval 基础对象 | `schema.ts` 已定义 `ResearchTask`、`ResearchCandidate`、`ResearchRun`、`ResearchArtifact`、`ResearchMemory`、`ResearchApproval` | 基本对齐 |
| 候选模型 recipe DSL | `domains/tsf.ts` 定义 `TSFCandidateRecipe`，并能转换为 Neo-Cast snake_case payload | 基本对齐 |
| 自动执行实验 | `runAutonomousIteration`、`runAutonomousLoop`、`executeRun` 能调用 Neo-Cast runner | 基本对齐 |
| Artifact 记录 | runner execution log、runner artifact、profile、data-analysis report、final bundle 都进入 artifact table | 基本对齐 |
| 简单 governance gate | candidate approval、budget approval、ref_test、blind_test、domain_action、protocol gate 已存在 | 部分对齐 |
| CLI/API/TUI 入口 | `research create/pipeline/vibe/export`、`/research/tasks/:taskID/pipeline`、TUI cockpit 已接入 | 部分对齐 |

## 核心不一致项

### 1. 交互模式没有成为一等 Session 配置

规划要求：

- 任务开始时选择 `socratic` 或 `cognitive_companion`。
- 两种模式都先通过 Intent Agent 充分澄清需求。
- `socratic` 在 `intent_spec.md` 确认后自主执行。
- `cognitive_companion` 在数据分析、搜索空间、预算扩大、最终模型选择等节点进入 Human Checkpoint。

当前实现：

- 核心 schema 只有 `ResearchMode = review | autonomous`，没有一等 `interaction_mode` 字段。
- `interactionMode` 主要写在 `taskSpec.metadata.interactionMode`。
- `taskModeForInteractionMode("companion")` 返回 `review`，`socratic` 返回 `autonomous`。
- `runFullPipeline` 明确要求 task mode 必须是 `autonomous`，所以 companion task 无法运行完整 pipeline。
- TUI cockpit prompt/new task 会弹出模式选择，但 Home 输入 goal 时直接默认 `socratic`。

代码证据：

- `opencode/packages/opencode/src/research/schema.ts`: `ResearchMode` 只有 `review`、`autonomous`。
- `opencode/packages/opencode/src/cli/cmd/tui/routes/research-cockpit-data.ts`: `taskModeForInteractionMode` 将 companion 映射为 review。
- `opencode/packages/opencode/src/research/service.ts`: `runFullPipeline` 拒绝非 autonomous task。
- `opencode/packages/opencode/src/cli/cmd/tui/routes/research-cockpit.tsx`: prompt 来源会选择模式，home 来源固定为 socratic。

差距影响：

- 现在的 companion 更像“人工 review 模式”，不是“自动执行过程中关键节点共决策”。
- 无法表达“自主执行但需要更多 checkpoint”的中间形态。
- 用户从 Home 开始任务时仍可能绕过模式选择。

建议：

- 在 `ResearchTask` 或独立 Session 配置中增加一等字段 `interactionMode: "socratic" | "cognitive_companion"`。
- 将 execution mode 与 interaction mode 解耦：是否自动执行不应只由 `review/autonomous` 决定。
- `runFullPipeline` 应支持 companion pipeline，但在 checkpoint 节点暂停并创建 checkpoint approval。
- Home goal flow 也必须先弹出交互模式选择。

优先级：P0。

### 2. Intent Agent 不是规划中的多轮意图澄清 Agent

规划要求：

- Intent Agent 需要抽取预测对象、数据来源、时间粒度、lookback、horizon、目标变量、外生变量、业务背景、指标、资源约束、复杂度、延迟、可解释性和交付要求。
- 如果输入不完整，应多轮对话补充确认。
- 输出 `intent_spec.md`，作为后续 Data Analysis 和 NAS 输入。

当前实现：

- `analyzeIntentTask` 只检查四类字段：`dataset.path`、`dataset.targetCols`、`predictionLengths`、`objective.primaryMetric`。
- 未写入 `intent_spec.md` artifact。
- 未保存多轮对话状态。
- pipeline 缺字段时创建 `protocol` approval 并暂停，但用户回答后没有自动把回答归并进 intent spec 的机制。

代码证据：

- `opencode/packages/opencode/src/research/agents/intent-agent.ts`
- `opencode/packages/opencode/src/research/service.ts`: `runIntentAgent`、`runFullPipeline`

差距影响：

- 需求澄清质量不足，无法稳定覆盖业务背景、评价偏好、部署约束、外生变量和交付要求。
- 后续 Data Analysis/NAS 拿到的是原始 `taskSpec`，不是经过确认的 `intent_spec.md`。
- Socratic 模式只是“缺槽位就暂停”，还不是“前期聊清楚，后期自主执行”。

建议：

- 增加 `intent_spec_markdown` artifact，文件路径建议为 `.neo-research/sessions/<taskID>/intent/intent_spec.md`。
- 增加 intent 状态：`INTENT_ELICITATION`、`INTENT_DRAFTED`、`INTENT_CONFIRMED`。
- 增加 `answerIntentQuestion` 或 `updateIntentSpec` API，将用户回答结构化写回 task/session。
- Intent Agent 的 slot schema 至少覆盖规划文档列出的字段。

优先级：P0。

### 3. 状态机和 Human Checkpoint 机制仍是松散状态

规划要求：

- 明确状态机：`INIT`、`INTENT_ELICITATION`、`INTENT_CONFIRMED`、`DATA_PROFILING`、`DATA_ANALYSIS_DONE`、`EXPERIMENT_RUNNING`、`EVALUATION_DONE`、`REFLECTION_DONE`、`REPORT_GENERATION`、`RELEASE_DONE` 等。
- companion 模式在关键节点插入 `WAITING_FOR_HUMAN_CONFIRMATION`。
- 失败状态需要区分 `DATA_ERROR`、`CODE_ERROR`、`TRAINING_FAILED`、`EVALUATION_FAILED`、`RECOVERY_RUNNING` 等。

当前实现：

- `ResearchTaskStatus` 是 `idle/intent_gathering/profiling/analyzing/data_analysis/baselining/searching/researching/publishing/paused/completed/failed`。
- 状态粒度偏执行状态，不能表达规划中的阶段确认、细分失败和恢复。
- `Approval` 可作为 gate，但没有专门的 checkpoint 类型、候选选项、推荐动作、阶段报告结构。
- `ResearchAgentStageChanged` event 有 started/completed/failed，但 TUI 刷新事件集合没有包含这些 agent event，阶段流无法稳定呈现。

代码证据：

- `opencode/packages/opencode/src/research/schema.ts`
- `opencode/packages/opencode/src/research/event.ts`
- `opencode/packages/opencode/src/cli/cmd/tui/routes/research-cockpit-data.ts`

差距影响：

- 长任务执行时，系统只能显示“正在 searching/publishing/paused”，无法说明暂停是等待 intent、数据分析确认、预算确认还是最终模型选择。
- companion 模式的 checkpoint 只能借用 approval，不能呈现“阶段结论、候选选项、推荐动作”。
- 失败后的恢复路径不可审计。

建议：

- 增加 `ResearchWorkflowState` 或 `taskSpec.workflow`，与现有 `status` 分层。
- 增加 `human_checkpoint` 类型 artifact/approval，字段包括 `phase`、`summary`、`options`、`recommendedOption`、`blocking`。
- TUI 订阅 `research.agent.*` events，并展示 agent timeline。
- 失败状态至少细分到 data/training/evaluation/export/code/runtime。

优先级：P0。

### 4. Data Analysis 仍是轻量 profile，不是完整数据诊断环境

规划要求：

- Quantitative Analysis Agent：ADF、KPSS、ACF、PACF、STL、频域分析、缺失、异常、滑动统计、相关性、滞后关系。
- Qualitative Analysis Agent：结合字段语义、业务机制、外部事件和领域知识。
- Main Agent 汇总定量和定性报告，生成 `data_analysis_summary.md`。
- 输出 `quantitative_analysis.md`、`qualitative_analysis.md`、`data_analysis_summary.md`。

当前实现：

- `profileTSFDataset` 能读 CSV 并计算基础 profile：行数、缺失率、趋势、季节性、cross correlation、distribution shift、outlier、固定候选 lag ACF、简化 ADF statistic、timestamp 质量。
- `buildDatasetAnalysisReports` 会生成三份 markdown artifact，但内容由同步函数模板化生成。
- 没有真实 sub-agent 调度，没有 LLM/领域知识输入，没有图表，没有 KPSS/PACF/STL/频域/变化点/滞后相关。
- 输出文件名是 `quantitative-subagent.md`、`qualitative-subagent.md`、`main-agent-summary.md`、`dataset-analysis-report.md`，不是规划中的标准路径。

代码证据：

- `opencode/packages/opencode/src/research/domains/tsf.ts`: `profileTSFDataset`
- `opencode/packages/opencode/src/research/service.ts`: `buildDatasetAnalysisReports`、`profileTask`
- `opencode/packages/opencode/src/research/agents/data-analysis-agent.ts`

差距影响：

- 数据分析已经能影响搜索 bias，但证据深度不足。
- qualitative 报告更像基于数值 profile 的解释模板，不是真正理解字段语义和业务背景。
- 后续 NAS Agent 不能稳定消费规划文档要求的 `data_analysis_summary.md` 契约。

建议：

- 将当前 profile 升级为 `dataset_profile.yaml/json`，单独作为 Data Workspace 产物。
- 增加 Python 侧统计诊断脚本，输出结构化 diagnostics 和图表路径。
- 将报告文件落到规划目录：`analysis/quantitative_analysis.md`、`analysis/qualitative_analysis.md`、`analysis/data_analysis_summary.md`。
- 在 companion 模式下，数据分析完成后生成 `data_analysis_done` checkpoint。

优先级：P1。

### 5. NAS Agent 是 autonomous loop 包装，不是完整模型配方搜索 Agent

规划要求：

- NAS Agent 应根据 `intent_spec.md` 和 `data_analysis_summary.md` 生成初始模型方案。
- 搜索对象包括模型结构、窗口、horizon、特征、归一化、loss、optimizer、batch、epoch、正则、外生变量融合和轻量化约束。
- 每轮记录假设、修改点、训练配置、评估结果和反思结论。
- 输出 `model_search_plan.md`、`experiment_log.md`、`leaderboard.md`、`best_model_config.yaml`、`best_model.py`、`training_script.py`、`evaluation_result.md`、`reflection_notes.md`。

当前实现：

- `NASAgent` 只是 `runAutonomousLoop` 的结果摘要。
- `runAutonomousLoop` 能循环选择候选、执行 runner、更新 champion、写 memory 和 loop artifact。
- `TSFDomain` 有固定 baseline、bridge frontier、native frontier、LLM proposal fallback 和 profile-aware proposal。
- 默认任务 `bridgeOnly=true`，数据 profile 驱动的候选只在 full recipe space 下更明显发挥作用。
- 没有标准 `model_search_plan.md`、`leaderboard.md`、`experiment_log.md`、`reflection_notes.md` 文件。
- 没有独立 Reflection Agent；反思信息主要散落在 memory、manager trace、selection artifact。

代码证据：

- `opencode/packages/opencode/src/research/agents/nas-agent.ts`
- `opencode/packages/opencode/src/research/service.ts`: `runAutonomousIteration`、`runAutonomousLoop`
- `opencode/packages/opencode/src/research/domains/tsf.ts`: `buildTSFBaselines`、`proposeTSFCandidate`、`rankTSFCandidateProposals`

差距影响：

- 当前可跑实验，但搜索过程不够“科研化”：用户很难按规划文档要求审计每轮假设、修改和反思。
- 搜索轨迹主要在 JSON artifact 和 DB 里，缺少人类可读的稳定文件结构。
- companion 模式无法在 search space 或最终模型选择前暂停确认。

建议：

- 在 NAS 开始前生成 `configs/search_space.yaml` 和 `experiments/model_search_plan.md`。
- 每轮后同步更新 `experiments/experiment_log.md`、`experiments/leaderboard.md`、`experiments/reflection_notes.md`。
- 将 `managerTrace` 和 memory 汇总为 Reflection Agent 产物。
- 增加 `search_space_confirmed` checkpoint。

优先级：P1。

### 6. Training/Evaluation/Verifier 还没有独立 Agent I/O contract

规划要求：

- Training Agent 输出训练日志、checkpoint、训练状态、命令、随机种子、代码版本、数据版本和资源消耗。
- Evaluation/Verifier Agent 输出 `evaluation_result.md` 和 verifier decision，覆盖 horizon-wise 表现、baseline 对比、过拟合、成本收益、数据泄露。
- Reflection Agent 根据评估结果生成下一轮计划。

当前实现：

- 训练主要在 Neo-Cast `train.py`、`runner.py` 内执行。
- Research Service 会记录 execution log、runner artifact、metrics、resourceUsage。
- `evaluateSucceededRun` 根据 primary metric 更新 champion 并写 memory。
- `recordFailedRunMemory` 会记录失败 run memory。
- 没有独立 `evaluation_result.md`，没有 verifier decision artifact。
- 没有数据泄露、过拟合、horizon collapse、cost-performance verifier。

代码证据：

- `neo_cast/py/train.py`
- `neo_cast/py/runner.py`
- `opencode/packages/opencode/src/research/service.ts`: `evaluateSucceededRun`、`recordFailedRunMemory`
- `opencode/packages/opencode/src/research/runtime.ts`: worker retry/dead-letter 基础能力

差距影响：

- 当前 champion 选择主要依赖 primary metric，不能充分证明“可信科研闭环”。
- 失败会进入 memory，但没有 `failure_log.md`，也没有结构化恢复动作。
- 无法系统性判断某次指标提升是否真实、稳定、值得增加复杂度。

建议：

- 增加 `evaluation_result.md` artifact，包含 avg/horizon-wise metrics、baseline comparison、resource cost、verifier decision。
- 增加 `VerifierDecision` schema，至少包含 `accepted/rejected/warn`、原因、检查项。
- 增加 `failure_log.md` 和 recovery action 记录。
- 将 worker retry 的运行时机制与 Research task 状态机联动。

优先级：P1。

### 7. Publish/Release 产物未完全匹配规划目录和可复现交付包

规划要求：

- 输出完整科研报告和模型交付包。
- 包含模型参数、代码、训练脚本、评估脚本、数据处理脚本、实验表格、搜索过程、失败案例、最终模型选择理由。
- 推荐目录含 `src/`、`configs/`、`checkpoints/`、`logs/`、`reports/`、`artifacts/`。

当前实现：

- `exportTaskArtifact` 能导出 `research_report_markdown`、`research_final_bundle`、`model_export_package`。
- bundle 包含 `report/`、`results/`、`model/`、`trace/` 和 `manifest.json`。
- 如果 champion runner artifact 中存在 `README.md`、`requirements.txt`、`mcp_server.py`、`tool_schema.json` 等文件，会复制到 model 目录。
- 默认 pipeline stage 是 `smoke`，`validate.py smoke` 会训练 smoke 模型并输出基础 artifact，但不会调用 `export.py` 生成完整 Neo-Cast 发布文件；完整 export 主要在 `runner.py run/ref-test` 路径触发。
- 研究报告是聚合型 markdown，不是规划中的 `final_report.md` 标准目录。

代码证据：

- `opencode/packages/opencode/src/research/service.ts`: `exportTaskArtifact`
- `neo_cast/py/export.py`
- `neo_cast/py/validate.py`
- `neo_cast/py/runner.py`

差距影响：

- smoke pipeline 的 `model_export_package` 可能缺少完整模型发布文件，如 `metadata.json`、`model_impl.py`、`inference.py`、`mcp_server.py`、`tool_schema.json`、`README.md`。
- 输出目录与规划文档推荐结构不一致。
- 最终报告缺少明确的消融分析、失败案例和复现说明章节。

建议：

- pipeline publish 前，如果目标是 `model_export_package`，应确保 champion artifact 已经过 Neo-Cast `export.py`。
- 将 `research-report.md` 同步命名或复制为 `reports/final_report.md`。
- 增加 `release_package.md`，说明复现命令、依赖、输入输出 contract 和文件清单。
- 对 full/ref_test/blind_test 不同阶段的导出完整性做验收检查。

优先级：P1。

### 8. Memory 仍是 run-level 经验记录，不是分层科研记忆

规划要求：

- Short-term memory、session memory、long-term research memory 分层。
- 当前任务保存 `session_summary.md`。
- 跨任务沉淀有效模型配方、数据模式、失败经验，并可更新 Skill。

当前实现：

- `ResearchMemory` 表记录 taskID/domainID/fingerprint/candidate/outcome/lesson。
- 成功或失败 run 会写 memory。
- `listRelatedMemory` 可在候选 proposal/ranking 中读取同 domain 历史 memory。
- 没有文件系统记忆结构，没有 `session_summary.md`，没有长期经验库治理策略。

代码证据：

- `opencode/packages/opencode/src/research/schema.ts`: `ResearchMemory`
- `opencode/packages/opencode/src/research/service.ts`: `createMemory`、`listRelatedMemory`

差距影响：

- 已有“轻量经验复用”，但不足以支撑规划文档里的长期自主科研能力。
- 经验没有版本、适用条件、失败案例归档和压缩摘要。

建议：

- 每个 task 生成 `memory/session_summary.md`。
- 设计 `research_memory_index.jsonl` 或 SQLite 表，记录适用数据画像、recipe 标签、效果和失败原因。
- 将 memory 与 Skill Registry 打通，允许任务结束后生成 skill update proposal。

优先级：P2。

### 9. Skill Registry 还没有变成 NeoResearch 的科研能力包

规划要求：

- NeoResearch 有 `skills/` 目录或 Skill Registry。
- 每个 Skill 包含 `skill.md`、`config.yaml`、`examples/`、`scripts/`、`templates/`。
- Agent 根据任务阶段和数据特征选择并组合 Skill。

当前实现：

- OpenCode 本身有通用 Skill/MCP 能力。
- NeoResearch TSF pipeline 没有自己的科研 Skill Registry。
- Data diagnosis、baseline training、error diagnosis、report generation 等还没有封装为可复用 skill。

代码证据：

- 通用 skill 在 `opencode/packages/opencode/src/skill/`。
- Research 代码中没有 NeoResearch 专属 `skills/` registry 调度。

差距影响：

- 当前能力复用主要靠 TypeScript 函数和固定 recipe，不是规划文档要求的一等科研能力资产。
- 历史任务经验不能自动反哺 skill。

建议：

- 建立 `.neo-research/skills/` 或 repo 级 `neo_research_skills/`。
- 先实现 MVP skills：`stationarity_analysis`、`seasonality_profile`、`baseline_training`、`error_diagnosis`、`report_generation`。
- 在 Data Analysis 和 NAS 阶段记录 skill 调用日志与成功/失败结果。

优先级：P2。

### 10. Session filesystem 未按规划结构落盘

规划要求：

```text
neoresearch-session/
├── intent/
├── data/
├── analysis/
├── configs/
├── skills/
├── src/
├── experiments/
├── checkpoints/
├── logs/
├── reports/
└── artifacts/
```

当前实现：

- 文件散落在 `.neo-research/profile`、`.neo-research/artifacts`、`.neo-research/run-plans`、`.neo-research/runner-executions`、`.neo-research/governance`、`.neo-research/runtime` 等目录。
- 这些目录支持运行，但不是规划中的 session-first 结构。
- task 与 session 的边界不够明显，`sessionID` 只是可选字段。

差距影响：

- 人类研究者审阅一个任务时，需要跨多个目录拼上下文。
- Agent 恢复任务时缺少一个稳定的 session root。

建议：

- 引入 `sessionRoot(taskID)`，例如 `.neo-research/sessions/<taskID>/`。
- 将现有 profile/artifacts/governance/run-plans 通过软迁移或 manifest 聚合到 session root。
- 生成 `manifest.json`，列出所有重要产物路径。

优先级：P2。

### 11. Benchmark 和系统级评估未接入 NeoResearch pipeline

规划要求：

- 评估模型层、实验层、搜索层和系统层。
- 系统级指标包括任务完成率、自动化程度、可复现性、实验成本、代码正确性、报告质量、人类介入次数。

当前实现：

- Neo-Cast 有 benchmark manifest/report 相关脚本。
- Research pipeline 尚未把 benchmark 作为系统评估环境接入。
- TUI/CLI 没有展示系统级指标。

代码证据：

- `neo_cast/py/dataset_contract.py`
- `neo_cast/py/benchmark_report.py`

差距影响：

- 目前只能证明单次 task 能跑，不容易证明 NeoResearch 作为 Autonomous Research Agent 的系统能力。

建议：

- 增加 `research benchmark` CLI。
- 将标准 task 运行结果汇总为 `benchmark_summary.md/json`。
- 记录人工介入次数、pipeline 完成率、artifact 完整率、复现成功率。

优先级：P3。

## 尚未研发或需要明显补强的模块清单

### P0：先补齐交互与状态机基础

- 一等 `interactionMode` 字段，解耦 interaction mode 和 execution mode。
- Home/Cockpit/CLI/API 全入口统一要求选择或显式传入交互模式。
- `IntentSpec` schema、`intent_spec.md` artifact、intent 多轮澄清 API。
- `WorkflowState` 与 `HumanCheckpoint` schema。
- companion pipeline 支持 checkpoint 暂停、确认、继续。
- TUI agent timeline 和 checkpoint 结构化展示。

### P1：补齐科研闭环 MVP 产物

- `dataset_profile.yaml/json`。
- `analysis/quantitative_analysis.md`、`analysis/qualitative_analysis.md`、`analysis/data_analysis_summary.md`。
- `configs/search_space.yaml`。
- `experiments/model_search_plan.md`、`experiments/experiment_log.md`、`experiments/leaderboard.md`、`experiments/reflection_notes.md`。
- `reports/final_report.md` 和 `artifacts/release_package.md`。
- `evaluation_result.md`、`verifier_decision.json`、`failure_log.md`。

### P1：增强 Data Analysis、Verifier、Reflection

- 统计诊断工具：ADF p-value、KPSS、ACF/PACF、STL、频域、变化点、滞后相关。
- 定性分析输入：字段说明、领域背景、用户补充知识、外部情境。
- Verifier：baseline 对比、horizon-wise、过拟合、数据泄露、成本收益。
- Reflection：将 run 结果转成下一轮实验假设，而不只是写 memory lesson。

### P2：补齐可复现交付和 Session Harness

- Session root 目录和 manifest。
- Publish 前 artifact completeness check。
- smoke/full/ref_test/blind_test 各阶段的发布策略。
- Neo-Cast export 与 Research publish 的强一致集成。
- `session_summary.md` 和长期 memory index。

### P2：补齐 Skill 和能力资产

- Research skill registry。
- TSF 常用分析 skill。
- Baseline/runner/evaluation/report skill。
- Skill 调用日志、成功率和失败案例沉淀。

### P3：补齐系统级 Benchmark 和 Governance

- 标准任务集、固定 split、固定预算、固定 baseline。
- 系统级指标：任务完成率、复现率、人工介入次数、报告质量、artifact 完整率。
- 安全治理：危险命令限制、敏感数据规则、测试集污染检查、过度调参检查。

## 推荐研发顺序

1. 先改交互模式和状态机。否则 companion/socratic 的产品定义会继续和执行逻辑混在一起。
2. 再补 Intent Spec 和 Human Checkpoint。这样用户开始任务、澄清需求、暂停确认、继续执行才有统一协议。
3. 接着补标准文件产物。规划文档的核心是“文件系统记忆 + 可审计产物”，需要先把文件契约稳定下来。
4. 然后增强 Data Analysis、Verifier、Reflection。这样闭环质量从“能跑”提升到“可信”。
5. 最后做 Skill/Memory/Benchmark。它们是长期能力积累层，应建立在稳定闭环之上。

## 验收标准建议

下一阶段可以用以下标准判断是否与规划文档显著对齐：

- 创建任务时，所有入口都能明确选择 `socratic` 或 `cognitive_companion`。
- Socratic 模式会生成并确认 `intent_spec.md`，之后自动完成 data analysis、search、publish。
- Companion 模式会在数据分析完成、搜索空间确认、预算扩大、最终模型选择前生成 checkpoint，并等待用户确认。
- 每个 task 都有稳定 session root，包含 intent、analysis、configs、experiments、reports、artifacts。
- 至少一个标准 CSV 数据集可以完整跑出 `final_report.md`、`leaderboard.md`、`evaluation_result.md` 和 `model_export_package`。
- Verifier 能拒绝至少三类不可信结果：指标缺失、baseline 对比无效、数据泄露或测试集污染风险。
- 失败 run 会产生 `failure_log.md`，并记录恢复建议或 dead-letter 原因。
