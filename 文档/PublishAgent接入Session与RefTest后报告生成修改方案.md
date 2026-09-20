# PublishAgent 接入 Session 与 Ref Test 后报告生成修改方案

## 1. 目标

不新增 ReportAgent，也不增加新的 Agent 类型。由当前研究流程最后一个 Agent——`PublishAgent`——继续承担最终阶段职责，并在 champion 的 `ref_test` 成功后，通过当前 research task 的 Session 汇总研究全过程、生成可复现的最终报告并完成发布。

目标流程：

```text
NAS / Evaluation / Reflection 完成
  -> champion 固化
  -> ref_test approval / gate
  -> champion ref_test 成功
  -> PublishAgent 构建报告输入快照
  -> PublishAgent 通过 Session 撰写 final_report.md
  -> 校验报告
  -> PublishAgent 生成 release_package.md 与 manifest.json
  -> task.status = completed
```

需要实现原定 Report Agent 的内容，但这些内容成为 PublishAgent 的一个内部工作阶段，而不是新 Agent：

- 汇总所有中间文档、实验记录、最优模型配置和最终评估结果。
- 描述任务背景、数据分析、模型搜索过程和最终结果。
- 总结失败案例和无效尝试。
- 解释最终模型选择理由。
- 提供完整复现说明和产物索引。
- 输出 `reports/final_report.md`、`artifacts/release_package.md` 和可复现交付包。

## 2. 当前实现与缺口

### 2.1 已有能力

OpenCode Research Service 当前已经具备：

- `ResearchTask.sessionID`，其他研究 Agent 已使用 `requestViaSession(...)` 接入根 Session。
- task、candidate、run、approval、artifact、memory 和 champion 的统一存储。
- `runPublishAgent()`：读取 champion，并在发布前补跑缺失的 `ref_test`。
- `exportTaskArtifact()`：生成 `research_report_markdown`、`research_final_bundle` 或 `model_export_package`。
- final bundle 已能输出报告、实验记录、模型文件、ref-test 文件和 `manifest.json`。
- companion 模式已有最终 `report_release` checkpoint。

Neo-Cast 当前已经具备：

- session 内最佳 run 定位。
- `runner.py ref-test` 特权评估。
- `ref_test_metrics.json`、更新后的 `metadata.json` 和 `eval_report.md`。
- `ref_test_done` 结构化事件。

### 2.2 主要缺口

1. PublishAgent 目前主要负责触发 `ref_test` 和确定性文件导出，没有通过 Session 理解和叙述完整研究过程。
2. `final_report.md` 主要来自模板拼接，尚未充分整合数据分析、搜索轨迹、失败经验、选择理由和复现步骤。
3. PublishAgent 内部的 ref-test、报告撰写、校验和打包职责没有明确分阶段。
4. 报告缺少受控输入快照、幂等键和一致性校验。
5. 当前 ref-test 失败后仍可能降级继续导出，容易产生看似完整但缺少最终评估的报告。

## 3. 核心设计

### 3.1 不新增 Agent，只扩展 PublishAgent

保留现有 `runPublishAgent()` 作为最终流程入口，在其内部拆成四个明确步骤：

```ts
const runPublishAgent = Effect.fn("Research.runPublishAgent")(function* (input) {
  const refTest = yield* ensureChampionRefTest(input.taskID)
  const snapshot = yield* buildPublishReportSnapshot(input.taskID, refTest)
  const report = yield* generateFinalReportViaSession(snapshot)
  const validated = yield* validateAndPersistFinalReport(report, snapshot)
  return yield* exportTaskArtifact({
    ...input,
    finalReportArtifactID: validated.artifact.id,
  })
})
```

以上 helper 都是 PublishAgent 的内部能力，不作为独立 Agent 暴露，不新增 `runReportAgent()`，不增加 `ReportAgentStarted` 等事件。

### 3.2 PublishAgent 的内部阶段

PublishAgent 对外仍只有 `publishing` 生命周期，对内记录子阶段：

| 子阶段 | 作用 |
| --- | --- |
| `ref_test` | 确保 champion 已完成最终参考测试 |
| `report_context` | 构建受控报告输入快照 |
| `report_generation` | 通过 Session 生成最终报告 |
| `report_validation` | 校验章节、数值、证据和敏感信息 |
| `release_packaging` | 打包模型、配置、报告和 manifest |

无需为 task status 新增 `reporting`。task 在整个最终阶段保持 `publishing`，只有成功完成报告与发布后才改为 `completed`。

## 4. Ref Test 触发边界

### 4.1 抽取 `ensureChampionRefTest()`

把当前 `runPublishAgent()` 中检查和执行 `ref_test` 的代码抽成内部 helper：

```ts
type ChampionRefTestResult = {
  champion: ResearchChampion
  run: ResearchRun
  metrics: Record<string, number>
}
```

行为：

1. 读取当前 champion。
2. 查找该 champion 已成功的 `ref_test` run。
3. 若不存在，则沿用当前 approval/gate 和 `executeRun({ stage: "ref_test" })` 链路。
4. 再次读取并确认 run 状态为 `succeeded`。
5. 仅返回 `ref_test_*` 结构化指标和对应 artifact 引用。

### 4.2 隔离约束

- `ref_test` 只能在 champion 固化之后执行。
- `ref_test` 不参与 candidate keep/discard、Reflection、NAS 或 champion 重新选择。
- PublishAgent 可以在最终报告中解释 ref-test 表现，但不得据此恢复搜索。
- PublishAgent 不读取 ref-test 原始数据或标签，只读取获准发布的汇总指标和评估 artifact。

### 4.3 Ref Test 失败

推荐默认行为：

- ref-test 成功：继续生成最终报告。
- ref-test 失败：停止正式发布，task 保持可恢复状态，并发布 `PublishAgentFailed`。
- 用户显式请求降级发布时，允许生成报告，但必须明确标注“最终参考测试未完成”，manifest integrity 为 `degraded`。

不应在 ref-test 失败时静默生成一份看起来完整的最终报告。

## 5. PublishAgent 报告输入契约

### 5.1 受控输入快照

PublishAgent 在调用 Session 前构建 `PublishReportSnapshot`：

```ts
type PublishReportSnapshot = {
  schemaVersion: "neo_research_publish_report_input.v1"
  generatedAt: string
  task: ResearchTask
  champion: ResearchChampion
  championCandidate: ResearchCandidate
  refTestRun: ResearchRun
  refTestMetrics: Record<string, number>
  candidates: ResearchCandidate[]
  runs: ResearchRun[]
  approvals: ResearchApproval[]
  memories: ResearchMemory[]
  evidence: Array<{
    artifactID: string
    kind: string
    uri: string
    runID?: string
    digest?: string
  }>
  reproducibility: {
    datasetSpec: JsonRecord
    bestModelConfig?: JsonRecord
    commands: string[]
    codeVersion?: string
    seeds: number[]
    environment?: JsonRecord
  }
}
```

保存位置：

```text
.neo-research/sessions/<task_id>/publish/report_input.json
```

注册 artifact：

```text
kind = publish_report_input_snapshot_json
```

### 5.2 允许读取的内容

- intent、task spec、objective 和 budget。
- quantitative、qualitative 和 main data analysis 文档及已注册图表。
- search space、model search plan、experiment log 和 leaderboard。
- candidate、run 的公开可报告字段。
- Evaluation/Verifier、Reflection、failure log 和 memory。
- champion 配方、配置、模型元数据、资源消耗和复现信息。
- champion 的最终 `ref_test_*` 指标。

### 5.3 必须排除的内容

- ref-test 原始数据、标签和未经批准的逐样本输出。
- provider key、token、环境变量值和用户本地配置。
- 未注册的任意工作区文件。
- 其他 task/session 的产物。
- blind-test 私有明细。

PublishAgent 的 Session prompt 只接收该快照和白名单 evidence，不能任意遍历文件系统。

## 6. Session 接入方式

### 6.1 复用当前 task 的根 Session

在 PublishAgent 的 `report_generation` 子阶段调用：

```ts
requestViaSession({
  rootSessionID: task.sessionID,
  agent: "research-publish",
  stageLabel: "PublishReport",
  taskID: task.id,
  user: buildPublishReportPrompt(snapshot),
  modelRef: mapToModelRef(publishLLMConfig),
  onDelta: ...,
  onPartUpdated: ...,
})
```

关键点：

- agent 名称保持 `research-publish`，不出现 `research-report`。
- 对外事件仍归属 `PublishAgent`。
- Session 子任务只是 PublishAgent 的报告撰写步骤，不代表新 Agent。
- `stageLabel` 用于日志和 UI 区分内部阶段，不参与 Agent 注册。

### 6.2 报告提示词原则

PublishAgent 的系统提示必须明确：

1. 只能依据输入快照和列出的 evidence 写作。
2. 不得虚构指标、命令、消融实验或失败原因。
3. 关键数字必须来自结构化字段，并附 run ID 或 artifact ID。
4. `val` 是搜索和模型选择信号，`ref_test` 只是最终泛化评估信号。
5. 不得依据 `ref_test` 更换 champion 或提出继续搜索动作。
6. 缺失信息要写“未提供/未执行”，不能补造。
7. 只输出 Markdown 正文。

固定章节：

```text
1. 执行摘要
2. 任务背景与目标
3. 数据与切分协议
4. 数据分析与建模启示
5. 模型搜索方法与搜索轨迹
6. 实验设置与评价协议
7. 验证集结果与候选比较
8. 最终 Ref Test 结果
9. 失败案例、无效尝试与经验
10. 最终模型选择理由
11. 局限性与风险
12. 复现步骤
13. 产物与证据索引
```

## 7. 报告生成与降级

### 7.1 正常路径

Session 返回 Markdown 后，PublishAgent：

1. 去除可能的外层 Markdown 代码围栏。
2. 执行结构与事实校验。
3. 保存为 `.neo-research/sessions/<task_id>/publish/final_report.md`。
4. 注册 `final_report_md` artifact。
5. final bundle 优先复制该 artifact 到 `reports/final_report.md`。

### 7.2 降级路径

保留当前确定性 renderer，避免最终发布完全依赖 LLM：

```text
Session 成功且校验通过 -> 使用 Session 生成报告
Session 失败             -> direct LLM fallback（若配置允许）
LLM 全部失败             -> deterministic renderer
```

无论采用哪条路径，都是 PublishAgent 的输出。artifact metadata 记录：

```json
{
  "generator": "publish-agent",
  "callPath": "session | direct | deterministic",
  "inputSnapshotArtifactID": "...",
  "validationStatus": "passed | degraded",
  "refTestRunID": "..."
}
```

## 8. 报告校验

新增纯函数 `validateFinalReport(report, snapshot)`，至少检查：

1. 固定章节齐全。
2. task ID、champion candidate ID、champion run ID 和 ref-test run ID 正确。
3. 核心 `val_*`、`ref_test_*` 数值与快照一致。
4. 没有把 `ref_test` 描述为搜索或 champion 选择依据。
5. run/candidate/artifact ID 均可在快照中找到。
6. 包含复现命令、环境、随机种子和产物索引；缺失项有明确声明。
7. 不包含 token、密钥、敏感环境变量值或私有数据路径。

第一次校验失败时，PublishAgent 可在同一个 Session 子任务中携带错误列表修订一次。第二次仍失败则使用确定性报告，并把 validation 状态记为 `degraded`。

## 9. 输出与 Artifact 契约

### 9.1 Session 工作目录

```text
.neo-research/sessions/<task_id>/publish/
├── report_input.json
├── final_report.md
├── report_validation.json
└── publish_trace.json
```

### 9.2 最终发布目录

沿用现有结构：

```text
<export>/<task_id>/
├── reports/final_report.md
├── artifacts/release_package.md
├── results/
├── configs/
├── experiments/
├── model/
├── ref_test/
│   ├── ref_test_metrics.json
│   └── eval_report.md
├── trace/
└── manifest.json
```

### 9.3 新增 artifact kind

- `publish_report_input_snapshot_json`
- `final_report_md`
- `report_validation_json`
- `publish_agent_trace_json`

`research_report_markdown` 保留为通用即时导出；`final_report_md` 表示 PublishAgent 在最终评估后生成并校验的正式报告。

`research_final_bundle` / `model_export_package` 应优先复制与当前 champion 和 ref-test run 匹配的最新 `final_report_md`。不存在时才使用确定性 renderer。

## 10. 幂等、恢复与一致性

### 10.1 幂等键

使用以下内容计算报告输入摘要：

```text
task_id + champion_run_id + ref_test_run_id + artifact_snapshot_digest + prompt_version
```

摘要未变化且已有校验通过的 `final_report_md` 时，重复 publish 直接复用，避免重复调用 Session/LLM。

### 10.2 快照一致性

PublishAgent 开始撰写前一次性读取 export snapshot。报告生成期间不反复查询可变数据；报告、release package 和 manifest 都引用同一个 snapshot artifact ID。

### 10.3 Champion 变化

若 champion ID 或 champion run ID 变化：

- 旧报告标记为 `superseded`。
- 新 champion 重新经过 ref-test。
- PublishAgent 用新快照重新生成报告。

## 11. 事件与界面

不新增 ReportAgent 事件。扩展现有 PublishAgent 事件 metadata，并增加可选的 PublishAgent 内部进度事件或统一进度字段：

```text
PublishAgentStarted        phase=ref_test
PublishAgentProgress       phase=report_context
PublishAgentProgress       phase=report_generation
PublishAgentProgress       phase=report_validation
PublishAgentProgress       phase=release_packaging
PublishAgentCompleted
PublishAgentFailed
```

如果当前事件体系不适合新增 `PublishAgentProgress`，可继续使用 `PublishAgentStarted/Completed/Failed`，通过 Session 流式事件携带 `agent=PublishAgent`、`stage=publishing`、`phase=report_generation`。

完成事件 metadata 建议包含：

```json
{
  "agent": "PublishAgent",
  "stage": "publishing",
  "callPath": "session",
  "inputSnapshotArtifactID": "...",
  "finalReportArtifactID": "...",
  "refTestRunID": "...",
  "validationStatus": "passed",
  "reportPath": "...",
  "releasePath": "..."
}
```

Web Dashboard 与 TUI 只需展示 PublishAgent 的内部阶段：“最终评估”“汇总报告”“校验报告”“打包发布”。

## 12. 预计代码改动

### 12.1 OpenCode Research Service

重点修改：

- `opencode/packages/opencode/src/research/service.ts`
  - 从 `runPublishAgent()` 抽取 `ensureChampionRefTest()`。
  - 新增 `buildPublishReportSnapshot()`。
  - 新增 `generateFinalReportViaSession()`，但它只是 PublishAgent helper。
  - 新增 `validateAndPersistFinalReport()`。
  - final bundle 优先复制 `final_report_md`。
- `opencode/packages/opencode/src/research/schema.ts`
  - 补充报告输入、校验结果或 artifact metadata schema。
  - 不新增 Agent schema。
- Research event 定义
  - 扩展 PublishAgent progress/metadata。
  - 不新增 ReportAgent 生命周期事件。
- `opencode/packages/opencode/src/research/domains/tsf.ts`
  - 保留当前 TSF renderer 作为 deterministic fallback。
  - 提取结构化事实摘要 helper，供 prompt 和 validator 共用。
- CLI、HTTP、TUI/Web research cockpit
  - 展示 PublishAgent 报告生成阶段和最终路径。

### 12.2 Neo-Cast

第一阶段无需修改训练和搜索逻辑，只需保持：

- `ref_test_done` 事件稳定。
- `ref_test_metrics.json`、`metadata.json` 和 `eval_report.md` 契约稳定。
- ref-test runner artifact 能准确关联到 Research Service 的 ref-test run。

可选增强：为 ref-test metrics 添加 schema version、dataset spec digest、model artifact digest、run ID 和评估时间。

## 13. 测试方案

在 `opencode/packages/opencode/test/research/service.test.ts` 增加：

1. champion 无 ref-test 时，PublishAgent 先执行 ref-test，再生成报告。
2. 已有成功 ref-test 时不重复执行。
3. 报告由 PublishAgent 使用 task root Session 生成，agent 标识仍为 `research-publish`。
4. 不产生 ReportAgent 记录或事件。
5. 输入包含完整研究 artifact 和 ref-test 指标，但不包含 ref-test 原始数据。
6. `final_report.md` 包含规定章节、champion 和 ref-test 指标。
7. final bundle 复制 PublishAgent 生成的正式报告。
8. Session 失败时 direct/deterministic fallback 正常。
9. ref-test 失败时默认不生成正式完成报告。
10. 同一输入重复 publish 复用已有报告。
11. champion 变化后旧报告不会被复用。
12. 报告数字不一致时触发修订或 fallback。
13. manifest 中报告、ref-test、model 和 reproducibility 引用完整。

补充路由和 UI 测试：

- HTTP/CLI 返回 PublishAgent 报告 artifact 和状态。
- TUI/Web 正确展示 PublishAgent 内部阶段。
- companion 模式下 `report_release` checkpoint 位于报告校验后、最终打包前。

Neo-Cast 契约测试：

- `runner ref-test` 事件包含 run ID 和指标路径。
- `eval_report.md` 与 `ref_test_metrics.json` 数值一致。
- ref-test 不改变 session champion，不参与后续搜索。

## 14. 分阶段实施

### Phase 1：整理 PublishAgent 最终链路

- 抽取 `ensureChampionRefTest()`。
- 建立 ref-test 成功后才能进入报告生成的硬边界。
- 增加 PublishAgent 内部 phase 记录。

验收：顺序稳定为 `ref_test_done -> report_generation -> PublishAgentCompleted`。

### Phase 2：Session 报告生成

- 实现 `PublishReportSnapshot`。
- PublishAgent 通过 `requestViaSession()` 生成 Markdown。
- 保存并注册 `final_report_md`。
- 保留 deterministic fallback。

验收：完整 TSF task 由 PublishAgent 生成包含规定章节的最终报告，全程没有新增 Agent。

### Phase 3：校验和打包

- 实现 validator 和一次自动修订。
- final bundle 优先复制正式报告。
- manifest 绑定 snapshot、champion 和 ref-test run。

验收：报告数字与结构化结果一致，bundle integrity 为 `complete`。

### Phase 4：可视化与体验

- 用相对路径嵌入数据图、预测对比、horizon 指标和搜索轨迹图。
- Web/TUI 展示 PublishAgent 的报告生成进度、证据链接和预览。
- 增加人工报告质量评测。

## 15. 最小可行修改范围

MVP 建议只做：

1. 保留 `runPublishAgent()` 外部接口和 PublishAgent 身份。
2. ref-test 成功后构建压缩的 `PublishReportSnapshot`。
3. PublishAgent 使用 `requestViaSession()`，agent 名称为 `research-publish`。
4. 输出 `.neo-research/sessions/<task_id>/publish/final_report.md` 并注册 `final_report_md`。
5. `exportTaskArtifact()` 构建 bundle 时优先复制该文件。
6. 校验必需章节、champion ID 和 ref-test 指标一致性。
7. Session 失败时回退当前 deterministic renderer。

该 MVP 不新增 Agent，不修改 Neo-Cast 训练/评估核心，也不要求一次完成全部图表和复杂自然语言事实校验。

## 16. 验收标准

- 系统中没有新增 ReportAgent 类型、注册、Session agent 名称或生命周期事件。
- 当前最后一个 PublishAgent 在 champion ref-test 成功后自动执行报告汇总。
- PublishAgent 的报告步骤接入当前 task 的 Session。
- `final_report.md` 包含任务背景、数据分析、搜索过程、实验结果、失败案例、选择理由和复现说明。
- 报告明确区分 validation 与 ref-test，且 ref-test 不影响 champion 选择。
- 核心数字可追溯到 run/artifact 并通过一致性校验。
- 最终 bundle 包含报告、release package、配置、实验记录、ref-test 结果、模型和 manifest。
- 报告生成可重试、可降级且幂等。
- 只有报告校验和发布完成后 task 才进入 `completed`。
