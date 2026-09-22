# LiteratureAgent 工具化与 TUI 接入实施方案

状态：待实施

范围：`opencode/packages/opencode` 的 Research 流水线、session 工具与 Research Cockpit TUI

前置实现：[RetrieveAgent → HypoPlanner 证据桥接方案](./retrieve_hypoplanner_bridge_implementation_plan.md)

## 1. 目标与边界

将现有 `DataAnalysisAgent → LiteratureAgent → HypoPlanner` 流水线中的 Literature phase 接入 OpenCode child session，使用户能在 TUI 中看到检索、逐篇处理、证据组装及失败/降级状态。工具是可审计的执行入口，不改变 KnowledgeCard 和 TaskEvidenceBundle 的权威验证规则。

本方案完成后应满足：

1. 主流水线仍只有一个对外 `literature` phase；`Retrieve(pre) → Literature(core) → Retrieve(post)` 是其内部步骤。
2. Literature phase 有独立 child session，工具调用生成 OpenCode message/tool parts；Research Cockpit 可实时展示并在重启后回放关键结果。
3. 与当前直接运行路径产生兼容的 `retrieve_result_v2`、`task_evidence_bundle_v1`、KnowledgeCard 和 provenance；HypoPlanner 仍只读取经校验的 Evidence Bundle。
4. 没有 PDF、没有候选、单篇失败以及未配置 LLM 的情况按既有规则降级；schema、缓存或 KnowledgeStore 损坏继续硬失败。
5. 不增加在线论文搜索、任意文件路径访问、自动下载 PDF、由模型直接写 KnowledgeStore，亦不让模型自行扩大预算或宣布证据为 `paper_backed`。

这里的“主 session 接入”指研究任务 root session 下有可导航的 Literature child session，以及 Cockpit 中可见的工具轨迹；不把全文或完整工具输出复制成 root session 的 assistant 消息。

## 2. 现状与改造切口

- `research/service.ts` 的 `runFullPipeline()` 已按 `data_analysis → literature → hypo_planning` 执行，`runRetrieveAgent()` 直接构造 `RetrieveAgent`、注册两个 artifact、发布 `RetrieveAgentStarted/Completed/Failed`。
- `retrieve/retrieve-agent.ts` 直接调用概念映射、BM25、候选筛选、`LiteratureAgent.run()` 和任务证据组装；`literature/extraction-model.ts` 对抽取/验证发起直接 LLM 请求。
- `requestViaSession()` 可创建 child session 并转发 text/tool parts，但只把最终文本返回；纯工具调用可能被当成“无结果”。
- `tool/registry.ts` 和 `agent/agent.ts` 已提供 `Tool.define`、工具白名单、隐藏研究 agent 的实现范式；`hypothesis-store.ts` 已有 child session 解析所属 task 的逻辑。
- TUI 有 DataAnalysis/HypoPlanner 的实时 Part/Delta 处理和工作流节点，但没有 Literature 节点，也不消费 Retrieve 的专属展示事件。
- `literature/README.md` 中“仅 standalone、未注册到服务”的描述已与当前流水线实现不一致，实施时须同步修订。

这些源码处于正在变动的工作区；实施前以当时的代码为准核对接口，不覆盖无关改动。

## 3. 工具边界与推荐清单

采用“服务层控制 phase、工具执行受限操作、确定性代码作最终裁决”的混合编排。工具输入只暴露 task 内标识符，不暴露任意 `taskID`、`neoCastRoot`、PDF 路径或 KnowledgeStore 路径。

| 工具 | 输入 | 结果摘要 | 副作用 | 阶段 |
| --- | --- | --- | --- | --- |
| `literature_run` | 无；可选受控 `force=false` 仅由服务端指定 | `retrieveRunID`、缓存命中、论文/卡片计数、readiness、gap/失败计数、artifact 路径标识 | 执行完整现有 Literature phase | 第一阶段必做 |
| `literature_list_intents` | 无 | `intentID`、问题、优先级、mustCover、query、预算 | 无 | 第二阶段 |
| `literature_search` | `intentID`、服务端上限内的 `topK` | 候选论文、BM25 rank/score、匹配字段、PDF 可用性、决策理由 | 无 | 第二阶段 |
| `literature_read_paper` | 已入选的 `paperID`，可选 section/chunk 游标、页大小 | 带 `chunkID`/页码的有限摘录及解析警告 | 可能触发可缓存 PDF 解析；不写卡片 | 第二阶段 |
| `literature_get_results` | 已完成的 `retrieveRunID` 或默认当前 run；分页 | 论文状态、卡片 ID/claim 摘要、排除原因、gap/conflict、review 标识 | 无 | 第二阶段 |
| `literature_process_papers` | 经服务端批准的 `paperID[]` | 逐篇 runID、状态、卡片数、错误摘要 | 解析、抽取、验证和写入 KnowledgeStore | 可选第三阶段 |
| `literature_finalize` | 当前 run ID | 经 schema/provenance 校验的 Evidence Bundle 摘要 | 组装并持久化任务证据 | 可选第三阶段 |

第一阶段**只让 `literature_run` 成为写入入口**，保持现有检索结果和缓存身份不变。第二阶段的探索工具提供真实、可见的检索与阅读步骤，但不允许模型以其搜索结果绕过既有候选选择器。只有在第一、二阶段验收后，才考虑把执行拆为逐篇处理和 finalize；届时要有服务端强制完成条件，不能因为 agent 提前结束就遗漏 must-cover intent。

不单独工具化 `searchBM25` 内部打分、claim schema 检查、exact-span 校验、去重、卡片写入事务或 Evidence Bundle 裁决。这些是受信任实现细节。抽取与验证 LLM 调用在第一阶段仍属于 `literature_run` 的内部执行；**一个外层工具调用不等于已把内部每次 LLM 请求变成 OpenCode tool part**。需要细粒度模型调用轨迹时，另行设计 session extraction adapter，并验证其与既有缓存、prompt 版本、调用记录完全兼容。

## 4. 执行架构

```text
Research Service（phase owner、状态/恢复、artifact 注册）
  ├─ 创建 Literature child session，并绑定 task + 定量报告快照
  ├─ SessionPrompt(research-literature)
  │    └─ literature_run 工具
  │         └─ 共享 LiteraturePhaseExecutor
  │              └─ RetrieveAgent → LiteratureAgent → Evidence Bundle
  ├─ 读取并校验工具回执 + retrieve_result_v2 + bundle provenance
  ├─ 注册/刷新现有两个 artifact，更新 workflow.literature
  └─ 传递 taskEvidenceArtifactID 给 HypoPlanner
```

### 4.1 共享执行入口，避免依赖环

不要让 `tool/research-literature.ts` 直接依赖 `Research.Service`：Research Service 依赖 `SessionPrompt`，后者依赖工具注册表，直接反向注入容易形成循环。把 `runRetrieveAgent()` 中可复用的“确定根目录 → 构造模型 → 运行 RetrieveAgent → 关闭资源”提取为不依赖 SessionPrompt/ToolRegistry 的 `research/literature-phase-executor.ts`。Service 和工具都可调用这一入口；artifact 注册、workflow 更新和 phase 事件仍归 Service 所有。

工具通过 `ctx.sessionID` 解析所属 task，要求当前 agent 为 `research-literature`，并读取本轮绑定的定量报告 artifact ID/digest 与预算快照。调用参数不能覆盖这些值。绑定可采用 service 管理的 session 上下文；进程重启后不恢复半截 LLM 对话，而由现有 workflow recovery 重新校验已持久化结果并安全重跑。若实现持久化绑定，需保证 sessionID、taskID 和 artifactID 一致且不可跨任务重用。

### 4.2 工具回执而非最终文本

为 Literature 新增专用 session 运行器，订阅 child session 的 `MessageV2.Event.PartUpdated/PartDelta`，并从**已完成的 `literature_run` tool part**解析结构化回执（建议含 `schemaVersion`, `taskID`, `quantitativeReportArtifactID`, `retrieveRunID`, `resultDigest`）。不得仅解析 agent 最终自然语言，也不得沿用 `requestViaSession()` 当前“无文本即返回 `undefined`”的判断。将订阅到的文本/工具 part 转发为 Research 专属 `LiteratureAgentStreamDelta/PartUpdated` 事件，供 Cockpit 按 `taskID` 消费；直接路径只发 phase/progress 事件。

Service 必须重新从持久化文件读取 `RetrieveResultSchema`/`TaskEvidenceBundleSchema`，验证回执、task、定量报告、task context digest、run ID 和 bundle 内容相互一致，再注册 artifact。工具输出仅作进度/定位信息，不能作为证据事实来源。session/provider 不可用，或能证实工具尚未开始执行时，可记录原因并走现有直接路径；如果工具已经开始而结果不确定，先按 runDigest 对账缓存/KnowledgeStore，不能盲目重跑。工具回执与持久化结果不一致、schema/provenance 损坏属于硬失败，不得伪装为 `ready_data_only` 或静默 fallback。需区分“工具成功但 agent 最终回复失败”（可从有效回执恢复）与“工具未执行”（才触发直接执行），防止重复成本。

### 4.3 缓存、并发和强制重跑

沿用当前 `retrieveRunID` 与 Literature 的 `inputDigest`，不得把 sessionID、toolCallID 或展示文案加入结果缓存身份。同一 task/report/index/budget 的重复工具调用返回同一已校验结果；并发调用按 runDigest 去重或锁定，避免对同一 KnowledgeStore 写入竞争。`force` 不开放给 LLM；仅服务端 recovery/人工显式操作可触发，且仍须复用或刷新同一 artifact 注册，不产生陈旧的 readiness 元数据。

### 4.4 权限与不可信输入

- 在 `agent/agent.ts` 注册隐藏的 `research-literature`，只授权文献工具及必要的只读工具；默认拒绝 bash、写文件、任务修改和通用网络搜索。
- 工具必须校验 session→task 归属、当前 phase、允许的 `intentID`/`paperID`、top-K/逐篇预算；不可接受任意本地路径。
- PDF 文本作为不可信数据展示和传给模型，保留现有 prompt-injection 防护；工具输出过滤密钥、完整 prompt、长 PDF 正文及文件系统内部路径。长内容分页并截断，但持久化 artifact 保留完整审计数据。
- `literature_process_papers` 若实施，只接受候选选择器准入且去重后的论文；exact-span、`includeAgentInference=false`、卡片验证与 KnowledgeStore 事务不可由工具参数关闭。

## 5. 事件、主 session 与 TUI 合约

对外 phase 统一标记 `LiteratureAgent`；保留 `RetrieveAgent` 事件作为内部 substage，避免现有订阅方立即失效。新增 phase 事件和可选逐篇进度事件，字段使用小型结构化摘要，不发送全文：

```ts
research.agent.literature.started   { taskID, phase: "literature", sessionID?, runID? }
research.agent.literature.progress  { taskID, runID?, step, paperID?, status, counts?, cached? }
research.agent.literature.stream.delta / part.updated { taskID, agent, delta 或 part 字段 }
research.agent.literature.completed { taskID, retrieveRunID, resultArtifactID, taskEvidenceArtifactID,
                                      readiness, summary, callPath: "session_tool" | "direct" }
research.agent.literature.failed    { taskID, step?, paperID?, code, message, recoverable }
```

`progress.step` 固定为 `prepare_intents | search | select | parse | extract | verify | assemble_evidence`；只有确实发生的步骤才发布，缓存命中单独标记。事件顺序应为 Literature started → 内部进度 → completed/failed → HypoPlanner started。单篇失败作为 `progress` 警告和 bundle gap，不发布整个 phase 的 failed；全局损坏才发布 failed。

Research Cockpit 改造：

1. 在 `research-cockpit-data.ts` 的 workflow 中插入 `LiteratureAgent`，位于 DataAnalysis 与 HypoPlanner 之间。done 依据有效的 `task_evidence_bundle_json`/workflow phase，active 依据 phase 事件或 task status `literature`，不能因为“有论文卡片”就误判完成；`ready_data_only` 也是成功完成但显示零证据及 gap。
2. 同步 `researchAgentWorkflowOrder`、`researchAgentFullStageOrder` 和 live overlay，使开始/结束事件正确切换 sidebar 当前 agent；修正下一步推荐在 `data_analysis` 已完成但 `literature` 未完成时跳过 Literature 的问题。现有 `/pipeline hypo-planning` 可以继续驱动整体 pipeline，不一定新增独立命令。
3. 在 `research-cockpit.tsx` 消费 Literature stage/progress 与 child session Part/Delta，展示 `[LiteratureAgent]` 区块：意图/候选计数、正在处理的论文、工具名/状态/耗时、卡片与 gap 摘要。与 DataAnalysis/HypoPlanner 一样支持实时文本/工具 part，但不把原始 JSON 或全文直接放进滚动区。
4. 完成时将精简摘要写入已有 `stream.log` 和有界内存缓冲；重新打开 TUI 时从 artifact 元数据/结果报告恢复持久完成状态，避免仅靠易丢失的 SSE。重复事件按 `taskID + retrieveRunID + step/paperID` 去重，切换任务时过滤旧事件。
5. 主研究 root session 可导航至 Literature child session；Cockpit 不把工具 call/结果重复写入 root session message。没有配置模型时采用 direct path，仍显示 phase 事件与结果摘要，并明确标注 `direct` 或 `llm_not_configured`。

建议渲染样例：

```text
[LiteratureAgent] 检索中 · 6 intents / 24 candidates
  ✓ literature_search · 24 candidates · 82 ms
  ● paper-123 · parse/extract/verify
  ⚠ paper-456 · local PDF unavailable
[LiteratureAgent] 完成 · 2 papers / 5 cards / 3 selected / 1 gap · partial_evidence
```

## 6. 分阶段实施与文件清单

### 阶段 A：最小工具化，结果不变

1. 新增 `src/research/literature-phase-executor.ts`，从 Service 提取可复用的执行逻辑；直接路径继续调用同一 executor。
2. 新增 `src/tool/research-literature.ts` 的 `literature_run`；在 `src/tool/registry.ts` 注册，在 `src/agent/agent.ts` 注册 `research-literature` 与最小权限，新增 `src/agent/prompt/research-literature.txt`。
3. 新增专用 session 运行器，读取已完成工具 part 的结构化回执；Service 校验和登记 artifact 后更新 workflow。保留 provider/session 不可用时的直接路径。
4. 增加 phase started/completed/failed 和 `callPath`；不立即删除旧 RetrieveAgent 事件。

验收：同一离线 fixture 的工具路径与直接路径得到等价 Evidence Bundle；空目录得到 `ready_data_only`；纯工具调用即使最终文本为空也不会被当作失败；重复调用与恢复不重复生成卡片或 artifact。

### 阶段 B：检索与阅读工具

1. 增加 `literature_list_intents`、`literature_search`、`literature_read_paper`、`literature_get_results`，复用现有 intent、index、BM25、解析缓存及 schemas。list/search 读取同一次定量报告与索引快照生成的意图和候选；即使工具先于 `literature_run` 调用，也必须与最终 run 的输入 digest 对齐，索引变化则重建快照而非混用两次结果。
2. 增加逐步 progress 与逐篇状态；固定每次返回的长度、分页和预算。第一阶段的 `literature_run` 仍是唯一最终写入入口。
3. 若需要 session 决定论文处理顺序，再试验 `literature_process_papers` + `literature_finalize`；必须由服务端检查所有被选候选均有最终 disposition，且最终结果与旧路径通过同一 schema/provenance 验证。此项可延后，不阻塞 TUI 接入。

验收：无效 `intentID`/`paperID`、越权 session、超预算、任意路径、重复/并发调用均被拒绝或安全去重；模型不能通过工具参数放松证据门槛。

### 阶段 C：TUI 与文档

1. 更新 `src/cli/cmd/tui/routes/research-cockpit-data.ts` 和 `research-cockpit.tsx` 的节点、live overlay、事件处理、摘要与回放。
2. 更新 `src/research/event.ts`、相关 API 响应说明和 `src/research/literature/README.md`；在用户文档说明 session_tool/direct 两条调用路径。
3. 为 `test/cli/tui/research-cockpit-render.test.tsx` 增加 started/progress/completed/failed、任务切换、缓存命中、重进 TUI 和 `ready_data_only` 用例。

验收：TUI 展示顺序为 DataAnalysis → LiteratureAgent → HypoPlanner；Literature 子 session 的工具状态可见；关闭重开后仍显示完成状态与结果摘要；连续 progress 不造成滚动区膨胀或重复行。

## 7. 回归测试与完成判据

| 测试层 | 必测场景 |
| --- | --- |
| 工具单测 | session/task 归属、参数 schema、权限、分页/预算、tool receipt、取消/超时、敏感输出截断 |
| Literature/Retrieve 单测 | 搜索排序与筛选不变、单篇失败、无 PDF、无 LLM、缓存命中、并发去重、force/recovery |
| Service 集成测试 | session_tool 与 direct 结果等价；纯工具无文本；异常分支只执行一次；artifact ID/readiness 更新；错误 bundle 拒绝交给 HypoPlanner |
| TUI 测试 | 事件顺序、节点状态、逐篇进度、回放、任务切换、重复事件、长流输出上限 |
| E2E | Companion checkpoint 后完成 DataAnalysis → Literature → HypoPlanner；有效文献与 data-only 两条路径均成功 |

在 `opencode/packages/opencode` 运行新增的 package-scoped Bun 测试与 `bun typecheck`，不要在 `opencode/` 根目录运行 `npm test`。第一阶段上线前保留直接路径开关/降级能力；只有工具路径在真实任务中通过缓存、故障恢复和 TUI 回放验证后，才考虑让它成为默认。无需为本文档修改数据库或现有 artifact schema；若第三阶段引入新的运行状态持久化，再单独评估 migration 与版本升级。
