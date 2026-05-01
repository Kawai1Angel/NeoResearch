# NeoResearch 多智能体改造未对齐项

> 日期：2026-05-01
> 对照文档：`文档/multi_agent_transformation_plan.md`
> 对照范围：`opencode/packages/opencode/src/research`、TUI cockpit/home、research CLI、server research routes、`neo_cast/py`

## 一、总体结论

当前 NeoResearch 还没有完全对齐 `multi_agent_transformation_plan.md` 里的四阶段多智能体架构。

现状更接近：

```text
ResearchService 单体编排
  -> 手动或 CLI/TUI 触发 profile
  -> seed/autonomous loop
  -> export/report/final bundle
```

目标架构是：

```text
IntentAgent
  -> DataAnalysisAgent
  -> NASAgent
  -> PublishAgent
```

并且四个 Agent 应通过 Research Task 状态、artifact、event bus 进行阶段化通信和自动推进。目前底座已有不少，但 Agent 边界、事件驱动状态机、意图追问、数据分析增强、数据驱动 NAS、发布 Agent 仍未真正落地。

## 二、未对齐项

### G1. 四个独立 Agent 文件与职责边界不存在

计划要求新增：

- `src/research/agents/intent-agent.ts`
- `src/research/agents/data-analysis-agent.ts`
- `src/research/agents/nas-agent.ts`
- `src/research/agents/publish-agent.ts`

当前代码中没有 `src/research/agents/` 目录。核心流程仍集中在：

- `opencode/packages/opencode/src/research/service.ts`
- `opencode/packages/opencode/src/research/domains/tsf.ts`

影响：

- 现在的“agent”更多是文案、trace role 或 artifact role，不是独立可测试、可组合、可事件触发的 Agent 单元。
- 各阶段之间没有清晰输入输出协议，例如 `IntentAgentResult`、`DataAnalysisAgentResult`、`NASAgentResult`、`PublishAgentResult`。

### G2. Research Task 状态机未升级

计划状态机：

```text
idle
  -> intent_gathering
  -> profiling
  -> analyzing
  -> baselining
  -> searching
  -> publishing
  -> completed
```

当前 `ResearchTaskStatus` 只有：

```text
created
profiling
baselining
researching
paused
completed
failed
```

缺失状态：

- `idle`
- `intent_gathering`
- `analyzing`
- `searching`
- `publishing`

此外，`createTask` 当前直接写入 `status: "created"`，而不是先进入 `idle` 或 `intent_gathering`。

影响：

- TUI 和 service 无法准确表达四阶段 Agent 的运行进度。
- Agent 之间无法通过 task status 做明确触发。
- `researching` 仍然承担了搜索/NAS 的含义，没有替换为文档要求的 `searching`。

### G3. Event Bus 缺少 Agent 阶段事件

计划新增事件包括：

- `IntentGatheringStarted`
- `IntentGatheringCompleted`
- `DataAnalysisStarted`
- `DataAnalysisCompleted`
- `NASAgentStarted`
- `NASIterationCompleted`
- `PublishAgentStarted`
- `PublishAgentCompleted`

当前 research event 只有通用事件：

- `TaskCreated`
- `TaskUpdated`
- `CandidateCreated`
- `CandidateUpdated`
- `RunCreated`
- `RunUpdated`
- `ArtifactCreated`
- `MemoryCreated`
- `ChampionUpdated`
- `ApprovalCreated`
- `ApprovalUpdated`

影响：

- 事件流只能表达实体变化，不能表达 Agent 阶段语义。
- 没有看到基于这些事件自动触发下一 Agent 的订阅逻辑。
- 当前 pipeline 更多是 CLI/TUI 主动调用，不是事件驱动自动推进。

### G4. Agent-1 IntentAgent 未实现

计划要求 IntentAgent：

1. 接收自然语言研究目标。
2. 用 LLM 解析目标。
3. 对缺失字段追问。
4. 收集数据集路径、target、horizon、资源约束、指标、交互模式。
5. 生成正式 `ResearchTask`。

当前实现：

- Home 输入目标后只是进入 Cockpit，并携带 `researchGoal`。
- `createTaskFromPrompt` 会直接构造 task。
- goal 解析主要靠规则解析，例如 `target=`、`horizon=`、`context=`、CSV 路径。
- 缺失字段会用默认值填充。
- 没有 confidence。
- 没有 Intent 对话状态。
- 没有参数确认步骤。

影响：

- 用户输入不完整时不会追问。
- `socratic` 模式目前只体现在入口选择/metadata 上，没有形成“前置澄清需求、目标、约束”的真实流程。
- 资源约束、目标指标、数据集上下文的收集仍然薄弱。

### G5. Agent-2 DataAnalysisAgent 只是部分模拟

计划要求 DataAnalysisAgent：

1. 读取 CSV，计算扩展统计特征。
2. 修复 seasonality 去趋势。
3. 计算 ACF 主导周期、ADF 平稳性、跨列 Pearson 矩阵。
4. 生成可视化图。
5. 调用 LLM 生成定性分析。
6. 生成统一 `dataset_analysis_report.md` artifact。
7. 产出 `searchBiases` 交给 NAS。

当前已具备：

- `profileTSFDataset` 能从 CSV 计算基础 profile。
- `summarizeTSFTask` 会生成 `datasetProfile` 和 `searchBiases`。
- `profileTask` 会生成三个 markdown artifact：
  - `dataset_quantitative_analysis_markdown`
  - `dataset_qualitative_analysis_markdown`
  - `dataset_main_analysis_markdown`

仍未对齐：

- 没有独立 `data-analysis-agent.ts`。
- 没有 `neo_cast/py/analysis/dataset_analysis.py`。
- 没有 ACF 主导周期。
- 没有 ADF 平稳性检验。
- 没有保留完整跨列 Pearson 矩阵。
- 没有 matplotlib 图表。
- “定性分析”是规则模板文本，不是 LLM 生成。
- 没有统一 artifact kind：`dataset_analysis_report`。

影响：

- 数据分析阶段还不是文档定义的独立 Agent。
- 数据分析输出不能充分驱动后续 NAS 搜索。
- 最终报告无法嵌入完整数据分析结论和图表。

### G6. Agent-3 NASAgent 没有正式包装

计划要求 NASAgent：

1. 接收 `DatasetProfile`、`qualitativeSummary`、`searchBiases`。
2. 数据驱动初始化 baseline。
3. 生成带 hypothesis 的 recipe candidate。
4. 运行训练循环。
5. 基于结果 mutate。
6. 维护 experiment memory。
7. 输出 `NASAgentResult`。

当前已具备：

- `proposeTSFCandidate` / LLM proposal 支持 hypothesis。
- `runAutonomousLoop` 有多轮 loop。
- `runAutonomousIteration` 有 manager trace。
- 有 memory 机制。
- 有 target、plateau、time budget、crash streak 等停止条件。

仍未对齐：

- 没有 `nas-agent.ts`。
- `buildTSFBaselines` 仍固定生成 3 个候选：
  - linear raw baseline
  - patch MLP baseline
  - patch transformer baseline
- baseline 初始化没有根据 `datasetProfile` 条件分支。
- `searchBiases` 被用于 ranking feature，但没有驱动 baseline 选择。
- `mutate.py` 没有接收 dataset profile/search bias 参数。
- mutation policy 主要按 metric/status/state 决策，不按高季节性、高跨变量相关、distribution shift 等数据特征定向搜索。
- TUI 没有清晰显示 `NASAgent` 状态、iteration index、hypothesis、mutation rationale、metric trend。

影响：

- 当前搜索更像“固定种子 + 通用 autonomous loop”，而不是数据驱动 NAS Agent。
- 数据分析输出与架构搜索之间的耦合不足。

### G7. Agent-4 PublishAgent 未实现为独立发布阶段

计划要求 PublishAgent：

1. 从 champion run 提取模型权重。
2. 生成 standalone `model.py`。
3. 生成 standalone `inference.py` CLI。
4. 生成 `preprocess.py`、`requirements.txt`、README。
5. 生成增强报告。
6. 写入 `model_export_package` artifact。

当前已具备：

- `train.py` 会保存 `model.pt`。
- `neo_cast/py/export.py` 会生成 artifact 包。
- `research_final_bundle` 会复制 champion run 中的部分模型产物：
  - `model.pt`
  - `model_impl.py`
  - `inference.py`
  - `metadata.json`
  - `model_spec.json`
  - `preprocess.json`
- `exportTaskArtifact` 能导出 `research_report_markdown` 和 `research_final_bundle`。

仍未对齐：

- 没有 `publish-agent.ts`。
- 没有 `neo_cast/py/export/model_exporter.py`。
- 没有 `neo_cast/py/export/templates/`。
- 没有 standalone `model.py`。
- 当前 `inference.py` 是函数库式接口，缺少计划中的 CLI 形式：

```bash
python inference.py --input data.csv --horizon 96 --output predictions.csv
```

- schema 中没有 `model_export_package` artifact kind。
- 报告没有完整嵌入数据分析、假设验证、训练曲线、champion vs baseline 对比。

影响：

- 结果发布阶段还只是 bundle/export 功能，不是独立 Agent。
- 最终交付物距离“用户拿走即可独立推理”的目标仍有差距。

### G8. `runFullPipeline` 未在 service 层实现

计划要求新增：

```typescript
runFullPipeline(taskID)
  -> runDataAnalysisAgent
  -> runAutonomousLoop
  -> runPublishAgent
```

当前没有 service-level `runFullPipeline`。

已有相似能力：

- CLI `research vibe <goal...>` 会串起：
  - `createTask`
  - `prepareTaskDataset`
  - `profileTask`
  - `runAutonomousLoop`
  - `exportTaskArtifact(kind: "research_final_bundle")`

差异：

- 该 pipeline 只存在于 CLI command handler。
- server API 没有对应 endpoint。
- TUI 没有使用统一 pipeline service。
- 没有通过 Agent 状态机和 event bus 串联。

影响：

- 端到端流程难以被 TUI、CLI、API 复用。
- 流程控制散落在入口层，不利于测试和扩展。

### G9. TUI 进度显示仍是阶段摘要，不是 Agent 级实时状态

当前 TUI 侧边栏显示：

- 用户需求输入
- Data Profile
- 自主探索
- 结果整理

这与四阶段方向接近，但仍缺少文档要求的细节：

- IntentAgent 追问问题展示。
- DataAnalysisAgent 的定性/定量分析摘要。
- NASAgent 当前 iteration、hypothesis、mutation rationale。
- metric trend。
- PublishAgent 导出路径和使用说明。
- Agent 阶段事件流。

影响：

- 用户看到的是阶段状态，而不是多智能体协作过程。
- 对“认知伴随式”的关键节点确认、选择、解释支持不够。

### G10. Artifact kind 与报告结构未完全对齐

计划新增 artifact kind：

- `dataset_analysis_report`
- `model_export_package`

当前 `ExportArtifactKind` 只有：

- `research_report_markdown`
- `research_final_bundle`

当前数据分析 artifact 是三个分散的 markdown kind，不是统一 report。当前 `renderTSFArtifact` 中的数据分析部分也只是列 artifact 链接，没有把内容嵌入报告主体。

影响：

- 下游 PublishAgent 无法稳定读取统一的数据分析报告。
- 最终报告难以形成计划中的结构：
  - 研究摘要
  - 数据集分析
  - 假设与验证
  - 架构搜索历史
  - Champion 模型
  - 所有候选对比

## 三、已经部分对齐的能力

以下能力已经具备或接近目标，可以作为后续改造基础：

- Research Task 共享上下文。
- SQLite 持久化 task/candidate/run/artifact/memory/champion/approval。
- 通用 research event bus。
- `profileTask` 能生成 task profile 和数据分析类 artifact。
- `summarizeTSFTask` 能生成 `datasetProfile` 和 `searchBiases`。
- LLM candidate proposal 和 hypothesis 字段已经存在。
- autonomous loop 已支持多轮迭代。
- stop policy 已有 target、plateau、time budget、budget exhausted、crash streak 等条件。
- experiment memory 已有基础实现。
- final bundle 已能复制部分模型产物。
- TUI 已有四阶段进度摘要。
- 交互模式 `companion/socratic` 已落入 task metadata。

## 四、建议优先级

### P0：先补架构骨架

1. 新增 `src/research/agents/` 目录。
2. 定义四个 Agent 的输入输出类型。
3. 扩展 `ResearchTaskStatus`。
4. 扩展 Research Event。
5. 在 service 层新增 `runFullPipeline`。

原因：

- 这是让系统从“单体流程”变成“多智能体流水线”的前提。
- 后续 Data/NAS/Publish 都需要稳定的状态和事件协议。

### P1：落地 IntentAgent 与 DataAnalysisAgent

1. IntentAgent 实现缺失字段追问和参数确认。
2. DataAnalysisAgent 统一产出 `dataset_analysis_report`。
3. TUI 在 `intent_gathering` 状态展示追问。
4. TUI 展示数据分析摘要。

原因：

- 这两块直接决定用户体验是否符合“苏格拉底式”和“认知伴随式”。
- 数据分析输出是数据驱动 NAS 的输入。

### P2：强化 NASAgent

1. `buildTSFBaselines` 改为数据驱动。
2. `mutate.py` 接入 dataset profile/search biases。
3. TUI 展示 NAS iteration、hypothesis、mutation rationale、metric trend。

原因：

- 当前搜索能力已有基础，改造成本相对可控。
- 数据驱动初始化能显著提升“多智能体协作”可信度。

### P3：补 PublishAgent 与 standalone export

1. 新增 `model_export_package`。
2. 生成 standalone `model.py`。
3. 增强 `inference.py` CLI。
4. 报告嵌入数据分析、假设验证、训练曲线。

原因：

- 这是最终交付体验的关键，但依赖 Agent-2/3 输出稳定后再做更合理。

## 五、最小闭环建议

如果要快速让实现与文档显著对齐，建议按这个最小路径推进：

```text
1. schema/event/service 加 Agent 状态和事件
2. 新增 runFullPipeline
3. IntentAgent 先做规则解析 + 缺失字段追问，不急于 LLM
4. DataAnalysisAgent 先整合现有三份 markdown 为 dataset_analysis_report
5. NASAgent 先包装现有 autonomous loop
6. PublishAgent 先包装 research_final_bundle
```

这样可以先把“多智能体架构边界”跑通，再逐步把每个 Agent 内部能力替换为完整计划版本。
