# LiteratureAgent Phase → HypoPlanner 任务证据桥接实施方案

规则补充（2026-09-27，待实现与验收）：第 5.2、5.7 节增加知识卡类型完整性和机制角色门槛，对齐[知识卡规则](../../文档/LiteratureAgent与知识库独立实现方案.md#641-按类型强制执行的知识卡规则)。下列既有实现进度不代表本次补充已经落地。

实现进度（2026-09-21）：桥接功能、持久化、恢复路径及离线验收已实现；全仓测试仍有下列既有失败。
下文保留原设计与验收要求，不把完整训练/发布流水线标记为全绿。

| 实施波次 | 已完成内容 | 验收位置（相对 `opencode/packages/opencode/`） |
| --- | --- | --- |
| Wave 1 | 严格证据契约、逐卡语义绑定、适用性、覆盖/多样性/预算、冲突及排除审计 | `test/research/retrieve/task-evidence-builder.test.ts` |
| Wave 2 | deterministic/direct LLM 引用校验、非法整批回退、Markdown/YAML readiness | `test/research/hypo-planner-agent.test.ts` |
| Wave 3 | 旧行迁移默认值、真实 add/update/list、service/store 一致性、会话固定证据 artifact | `test/research/hypothesis-evidence-{migration,tools}.test.ts` |
| Wave 4 | DataAnalysis → Literature → HypoPlanner、重复恢复、缓存修复后下游重规划、损坏源契约阻塞 | `test/research/literature-{phase,pipeline}.test.ts` |
| Wave 5 | v1 诊断兼容、v2-only 运行、真实 KnowledgeStore 集成、service 示例及回归记录 | `test/research/retrieve/retrieve-agent.test.ts`、`src/research/retrieve/README.md` |

实现细节：预算上限仍有效；未入选的 warning claim 会进入 excluded detail 和同 intent 已选条目的
limitations，contradiction 关系即使一侧被预算排除仍会呈现。HypoPlanner 不再用额外 top-3 截掉这些警告。
单篇失败由 Literature 的 processed 状态降级；全局 bridge 异常和损坏契约必须失败。恢复可以从有效源报告
重建缓存，但不能绕过损坏源报告；重新构建 Literature 会清除下游完成标记，避免复用旧假设。

验证记录：本桥接定向测试 **75 通过、0 失败（16 个文件，351 个断言）**，类型检查、迁移一致性检查通过。
完整 `service.test.ts --timeout 60000`
本轮为 **26 通过、46 失败**，失败集中于既有 execution-contract/champion 约束及旧 checkpoint 预期。
`neo_cast/npm test` 最近一次 Node 阶段为 **66 通过、4 失败**：测试 Python 缺少 `jsonschema`（2 项）、
缺少 ETTh1 fixture（1 项）、既有 scheduler prompt 覆盖不完整（1 项），因此未进入 Python 阶段。
这些失败按第 11.6 节记录，未通过修改无关模块或削弱约束来绕过。

## 1. 目标与已确定决策

本方案把检索、论文理解和任务证据组装整体视为一个对外的 `LiteratureAgent` phase，并补齐该 phase 到
`HypoPlanner` 的桥接，使 HypoPlanner 能使用知识库中已经验证的 KnowledgeCard 生成可追溯、可证伪的研究假设。

已确定的架构决策：

1. 不新增 Agent；
2. 对外只暴露一个 `LiteratureAgent` phase；RetrieveAgent 和现有 LiteratureAgent 是该 phase 内部按职责拆分的实现；
3. 现有 LiteratureAgent 内核保持任务无关，只负责论文解析、claim 提取、证据验证和 canonical KnowledgeCard；
4. 所有任务级后处理放在 RetrieveAgent 内部；
5. Evidence Bundle 是 LiteratureAgent phase 的结构化产物，不是独立 Agent 或 workflow phase；
6. 任务相关性、BM25 分数和假设引用不得写回 canonical KnowledgeCard；
7. HypoPlanner 不直接扫描 KnowledgeStore，也不重新执行检索；
8. 首版使用确定性匹配规则，不引入新的 LLM 分类调用；
9. 没有合格文献证据时允许 HypoPlanner 以 `data_only` 模式继续；契约损坏或 provenance 不一致时必须失败。

最终边界：

```text
DataAnalysisAgent
        ↓ dataset_quantitative_analysis_v1
LiteratureAgent phase
        └─ RetrieveAgent.run()
             ├─ Retrieve 前处理
             │    ├─ 数据证据 → 科学概念 → 检索意图
             │    └─ BM25 召回与论文选择
             ├─ LiteratureAgent.run()（论文理解内核）
             │    └─ verified canonical KnowledgeCards
             └─ Retrieve 后处理
                  ├─ 加载 accepted cards
                  ├─ card ↔ intent ↔ dataset evidence 绑定
                  ├─ 可信度与适用性过滤
                  ├─ 跨论文冲突、覆盖和预算处理
                  └─ task_evidence_bundle_v1
                            ↓
                       HypoPlanner
                            ├─ 数据证据 + 文献证据 → 假设
                            ├─ cardID/revision 引用
                            └─ 适用假设与证伪条件
```

因此，外部主流水线只展示：

```text
DataAnalysisAgent → LiteratureAgent → HypoPlanner
```

`Retrieve(pre) → Literature(core) → Retrieve(post)` 只属于 LiteratureAgent phase 的内部执行拓扑。

## 2. 当前基础与缺口

### 2.1 已有能力

当前代码已经提供：

- `dataset_quantitative_analysis_v1`，包含 domain、数据角色、预测跨度、规模、缺失、周期、趋势、漂移、频谱、变点和 cross-lag；
- `DatasetEvidence → ScientificConcept → MethodConcept → RetrievalIntent`；
- BM25 candidate、paper/intents 聚合和 LiteratureAgent bridge；
- `KnowledgeCard` 的 applicability、evidence、limitations、implementation、confidence、status 和 provenance；
- `RetrieveResult` 中 paper、intent、candidate 和 acceptedCardIDs 的论文级链路；
- KnowledgeStore 的 card revision、card relation 和精确 evidence span；
- HypoPlanner 的 deterministic/LLM/session 三条生成路径及 hypothesis pool 持久化。

### 2.2 需要补齐的缺口

当前链路停留在：

```text
paper.intentIDs[] + paper.acceptedCardIDs[]
```

尚未建立：

```text
cardID
→ matched intentID
→ transformationID
→ conceptID
→ datasetEvidencePath
→ applicability decision
→ hypothesis evidence reference
```

同时存在以下工程缺口：

- RetrieveAgent 没有从 KnowledgeStore 加载 LiteratureAgent 返回的 card；
- 同一 paper 的所有 accepted cards 目前共享一组 intentIDs，尚未做 card 级归因；
- HypoPlanner input、prompt、输出和 YAML 不包含文献证据；
- session-mode 通过 `hypothesis_add/update` 落库，数据库当前没有证据引用字段；
- autonomous pipeline 当前直接从 DataAnalysis 进入 HypoPlanner；
- workflow recovery 没有对外的 `literature` phase；
- 没有 task evidence artifact、readiness 或 evidence gap 测试。

## 3. 范围

### 3.1 本期实现

- RetrieveAgent 内部的 task evidence 后处理；
- task context、task evidence、exclusion、gap、conflict 严格 schema；
- card 级 intent/concept/data-evidence 绑定；
- 确定性 eligibility 和 applicability 检查；
- 跨 paper 去重、冲突保留、覆盖和预算选择；
- RetrieveResult v2 和 `task_evidence_bundle.json`；
- HypoPlanner 输入、输出、prompt、tool 和持久化扩展；
- 主 pipeline 时序、恢复和降级策略；
- 单元、集成、迁移和端到端测试。

### 3.2 本期不实现

- 新 Agent；
- LiteratureAgent task-aware prompt；
- 修改 canonical KnowledgeCard 保存任务匹配结果；
- 向量检索、reranker 或在线论文 API；
- LLM card-intent classifier；
- 自动 Search → Learn → Search 多轮循环；
- 根据单个任务实验结果修改 KnowledgeCard status；
- 自动生成新的跨论文科学结论。

## 4. 契约设计

### 4.1 RetrieveTaskContext

`DatasetQuantitativeAnalysis` 已经覆盖主要数据特征，但不包含完整研究目标和运行约束。Research Service 在调用 RetrieveAgent 时应传入一个规范化、最小化的任务上下文，而不是把完整数据库对象传给 retrieve 模块。

```ts
export const RetrieveTaskContextSchema = z.object({
  taskType: z.string().min(1),
  domain: z.string().min(1),
  objective: z.object({
    primaryMetric: z.string().min(1).optional(),
    probabilistic: z.boolean(),
  }).strict(),
  constraints: z.object({
    computeProfile: z.enum(["low", "medium", "high", "unknown"]),
    latencyBudget: z.number().finite().positive().optional(),
    parameterBudget: z.number().finite().positive().optional(),
  }).strict(),
}).strict()
```

`RetrieveAgentInput` 增加：

```ts
readonly taskContext?: RetrieveTaskContext
```

为了保留独立 CLI 和测试能力，未传入时从 quantitative report 推导：

- `taskType = forecasting`；
- `domain = report.domain`；
- `probabilistic = false`；
- `computeProfile = unknown`。

manifest 必须记录 context 来源是 `research_task` 还是 `report_fallback`。

### 4.2 TaskEvidenceEntry

```ts
export const TaskEvidenceEntrySchema = z.object({
  evidenceEntryID: z.string().regex(/^te_[a-f0-9]{16}$/),
  cardID: z.string().regex(/^kc_[a-f0-9]{12}$/),
  cardRevision: z.number().int().positive(),
  paperID: z.string().min(1),
  cardType: z.enum(CARD_TYPES),
  cardStatus: z.enum(["paper_backed", "corroborated", "contradicted"]),
  claim: z.string().min(1),

  linkage: z.object({
    intentIDs: z.array(z.string()).min(1),
    candidateIDs: z.array(z.string()).min(1),
    transformationIDs: z.array(z.string()).min(1),
    conceptIDs: z.array(z.string()).min(1),
    methodConceptIDs: z.array(z.string()),
    datasetEvidencePaths: z.array(z.string().startsWith("$.")).min(1),
  }).strict(),

  roles: z.array(z.enum([
    "supports_mechanism",
    "supports_applicability",
    "suggests_implementation",
    "defines_evaluation",
    "warns_limitation",
    "contradicts",
  ])).min(1),

  relevance: z.object({
    score: z.number().min(0).max(1),
    matchedTerms: z.array(z.string()),
    reasons: z.array(z.string()).min(1),
  }).strict(),

  applicability: z.object({
    status: z.enum(["matched", "partial", "conflicted", "unknown"]),
    matchedConditions: z.array(z.string()),
    violatedConditions: z.array(z.string()),
    uncertainConditions: z.array(z.string()),
  }).strict(),

  evidenceRefs: z.array(z.object({
    evidenceID: z.string(),
    chunkID: z.string(),
    section: z.string(),
    pageStart: z.number().int().positive(),
    pageEnd: z.number().int().positive(),
    directness: z.enum(["direct", "indirect", "inferred"]),
    verification: z.enum(["exact_span", "normalized_span", "manual_required"]),
  }).strict()).min(1),

  limitations: z.array(z.string()),
  implementation: z.object({
    recipeConcepts: z.array(z.string()),
    registryMappings: z.array(z.string()),
    estimatedComplexity: z.enum(["low", "medium", "high", "unknown"]),
    notes: z.array(z.string()),
  }).strict().optional(),

  confidence: z.object({
    sourceQuality: z.number().min(0).max(1),
    extractionConfidence: z.number().min(0).max(1),
    evidenceDirectness: z.number().min(0).max(1),
    transferability: z.number().min(0).max(1),
  }).strict(),
}).strict()
```

`relevance.score` 只表示 card 与当前 intent 的相关程度，不表示论文可信度。四维 confidence 保持分离，不合并成单一 trust score。

### 4.3 ExcludedTaskEvidence

所有 acceptedCardID 都必须有去向：进入 entries，或带原因进入 excluded。禁止静默丢弃。

```ts
export const ExcludedTaskEvidenceSchema = z.object({
  cardID: z.string(),
  paperID: z.string(),
  reasons: z.array(z.enum([
    "card_not_found",
    "paper_mismatch",
    "status_not_eligible",
    "no_direct_exact_evidence",
    "no_intent_match",
    "hard_applicability_conflict",
    "duplicate_claim",
    "selection_budget",
  ])).min(1),
  detail: z.array(z.string()),
}).strict()
```

### 4.4 TaskEvidenceBundle

```ts
export const TaskEvidenceBundleSchema = z.object({
  schemaVersion: z.literal("task_evidence_bundle_v1"),
  retrieveRunID: z.string(),
  taskID: z.string(),
  quantitativeReportArtifactID: z.string(),
  taskContextDigest: z.string().regex(/^[a-f0-9]{64}$/),
  readiness: z.enum([
    "ready_with_evidence",
    "ready_data_only",
    "partial_evidence",
    "evidence_conflict",
  ]),
  entries: z.array(TaskEvidenceEntrySchema),
  excluded: z.array(ExcludedTaskEvidenceSchema),
  conflicts: z.array(z.object({
    relationID: z.string(),
    sourceCardID: z.string(),
    targetCardID: z.string(),
    rationale: z.string(),
    confidence: z.number().min(0).max(1),
  }).strict()),
  gaps: z.array(z.object({
    intentID: z.string(),
    conceptIDs: z.array(z.string()),
    mustCover: z.boolean(),
    reason: z.enum([
      "no_candidate",
      "no_local_pdf",
      "literature_failed",
      "no_accepted_card",
      "no_eligible_card",
      "selection_budget",
    ]),
  }).strict()),
  summary: z.object({
    acceptedCardCount: z.number().int().nonnegative(),
    selectedEntryCount: z.number().int().nonnegative(),
    excludedCardCount: z.number().int().nonnegative(),
    coveredIntentCount: z.number().int().nonnegative(),
    uncoveredMustCoverIntentCount: z.number().int().nonnegative(),
    conflictCount: z.number().int().nonnegative(),
  }).strict(),
}).strict()
```

### 4.5 RetrieveResult 版本

新增 `retrieve_result_v2`，包含必填 `taskEvidence`：

```ts
{
  schemaVersion: "retrieve_result_v2",
  // 原 v1 字段
  taskEvidence: TaskEvidenceBundle
}
```

兼容策略：

- 保留 `RetrieveResultV1Schema`，使旧 artifact 仍可被诊断工具读取；
- `RetrieveAgent.run()` 只返回 v2；
- run digest 加入 `taskEvidenceMappingVersion` 和 `taskContextDigest`，因此不会错误复用旧 v1 run；
- Research Service 只把 v2 交给 HypoPlanner；
- 旧 v1 artifact 不执行原地升级，因为当时 card revision 和 KnowledgeStore 状态可能已经变化。

## 5. RetrieveAgent 后处理算法

### 5.1 KnowledgeStore 访问

在 `RetrieveAgent` 中增加只用于后处理的 store 依赖：

```ts
type TaskEvidenceKnowledgeSource = {
  getCard(cardID: string): KnowledgeCard | undefined
  listRelations(): CardRelation[]
}
```

构造器支持注入 `knowledgeSource` 以便 fixture 测试。生产环境在 Literature bridge 完成后使用：

```text
<knowledgeRoot>/knowledge.db
```

创建 `KnowledgeStore` 读取卡片，RetrieveAgent 关闭时同时关闭自有连接。不得访问 LiteratureAgent 的 private store，也不得修改卡片。

### 5.2 accepted card 完整性检查

逐一处理 `literatureResults[].acceptedCardIDs`：

1. `getCard(cardID)` 必须存在；
2. `card.paperID` 必须等于 literature result paperID；
3. 保存实际 `card.revision`，禁止假设 revision 为 1；
4. 同一 cardID 被多个 paper result 引用属于契约错误；
5. 缺失或 paper mismatch 进入 excluded，并使 readiness 至少为 `partial_evidence`；
6. 不修改 canonical card。

新增类型完整性检查：按知识卡规则执行条件校验，`model_mechanism` 必须具备非空 `problem` 和完整 `mechanism`，且有对应版本的类型、语义完整性与证据覆盖验证记录。仅有 `paper_backed` 状态或有效引用不够；不得从标签、模型名或检索词临时补出机制。缺少字段进入 excluded，原因为 `mechanism_incomplete`；缺少新版验证记录进入 excluded，原因为 `card_validation_required`；已确认类型错误记录 `card_type_mismatch`。保留 cardID、revision 和排除理由，并据剩余有效证据重算 coverage/readiness。

旧卡仍可读取和审计，但不得绕过上述门槛。重新验证或抽取由 LiteratureAgent 创建新 revision，桥接层不改写 canonical card；新规则启用后重建受影响的 evidence bundle，保留旧 bundle 的版本引用以便复现。

### 5.3 eligibility gate

正向支持证据必须满足：

- status 为 `paper_backed` 或 `corroborated`；
- 至少一个 evidence 的 `directness=direct`；
- 至少一个 evidence 的 `verification=exact_span`；
- evidence type 不是 `agent_inference`。

其他状态处理：

| Card status | 处理 |
| --- | --- |
| `paper_backed` | 可作为正向证据 |
| `corroborated` | 可作为正向证据，并优先于单篇结果 |
| `contradicted` | 只进入 `contradicts`/warning，不作为正向支持 |
| `extracted` | excluded：尚未达到论文证据门槛 |
| `inconclusive` | excluded，但保留原因 |
| `deprecated` | excluded |

BM25 分数不得参与 eligibility 判断。

### 5.4 card → intent 绑定

每张卡只在其所属 paper 已关联的 intentIDs 中匹配，不扫描其他任务 intent。

构建 card term set：

```text
normalizedClaim.subject/predicate/object
+ claim
+ mechanism.name/principle/components
+ applicability.taskTypes/dataFeatures/domains/horizonProfile/computeProfile
+ implementation.recipeConcepts/registryMappings
+ tags
```

构建 intent term set：

```text
scientificConcept.conceptID/label/paperTerms
+ methodConcept.conceptID/label/paperTerms
+ paperLanguage task/phenomenon/method/domain terms
```

首版确定性匹配维度：

| 维度 | 默认权重 | 说明 |
| --- | ---: | --- |
| scientific/data feature exact or taxonomy alias | 0.35 | 当前数据现象 |
| method/mechanism exact or taxonomy alias | 0.30 | 方法机制 |
| task type | 0.15 | forecasting 等 |
| domain | 0.10 | 仅作辅助，不可单独通过 |
| card type 与 intent question 的角色兼容 | 0.10 | mechanism/limitation/evaluation 等 |

规则要求：

- domain-only 命中不能建立 card-intent binding；
- 至少命中一个 scientific/data-feature 或 method/mechanism term；
- 保存每个维度的匹配原因；
- 一个 card 可以绑定多个 intent；
- 无 intent 通过阈值的 card 进入 `no_intent_match`；
- score 只用于当前 bundle 排序，不写回 KnowledgeCard。

阈值和 alias 放入版本化配置：

```text
retrieve/config/tsf-task-evidence.v1.json
```

### 5.5 provenance 展开

对每个 matched intent：

```text
intent.transformationID
→ transformation.scientificConcepts[].conceptID
→ transformation.methodConcepts[].conceptID
→ transformation.datasetEvidence[].path
```

所有引用必须通过现有 ID 查表得到，禁止根据字符串重新推测 evidence path。

### 5.6 applicability gate

使用 quantitative report、RetrieveTaskContext 和 card applicability 做分维度判断：

- task type；
- domain；
- data features；
- data scale；
- horizon profile；
- compute profile；
- `notApplicableWhen`。

规则：

1. 明确命中负向条件时为 `conflicted`；
2. card 声明了条件但任务侧无法判断时为 `unknown/partial`，不能猜测；
3. 空 applicability 数组表示“论文未明确说明”，不是自动匹配；
4. `notApplicableWhen` 只解析版本化配置中支持的受控谓词；无法解析的自然语言进入 `uncertainConditions`；
5. 硬冲突卡片不作为正向机制或实现建议，但可以作为 limitation/conflict 保留；
6. confidence.transferability 只参与排序和提示，不覆盖硬冲突。

TSF 首版派生事实：

- `regular_sampling`：`irregularIntervalRatio < 0.05`；
- `irregular_sampling`：`irregularIntervalRatio >= 0.05`；
- `long_horizon`：沿用现有 `horizonContextRatio >= 1`；
- data scale 和 compute profile 阈值全部进入配置，不散落在代码中。

### 5.7 role 映射

默认从 cardType 映射：

| cardType | roles |
| --- | --- |
| `model_mechanism` | `supports_mechanism` |
| `empirical_finding` | `supports_applicability` |
| `applicability_rule` | `supports_applicability`；负向条件时 `warns_limitation` |
| `limitation` | `warns_limitation` |
| `evaluation_protocol` | `defines_evaluation` |
| `implementation_hint` | `suggests_implementation` |
| status=`contradicted` 或 contradiction relation | `contradicts` |

首版 role 由确定性规则产生，不由 claim 中的乐观措辞决定。

上述映射仅对通过第 5.2 节及 eligibility 检查的卡片生效。`supports_mechanism` 还必须通过机制完整性与证据覆盖检查；仅描述 context length、prediction length、数据划分或评估指标的卡，即使误标为 `model_mechanism`，也不得进入该角色。

`evaluation_protocol` 只能在与评估有关的任务需求中提供 `defines_evaluation`，不能计入机制问题的证据覆盖。其他类型同样按问题与角色的兼容性使用；匹配了相同 horizon 或数据集，不等于支持模型设计机制。HypoPlanner 的结构假设必须引用合格机制卡，或明确标注为待实验检验的 Agent 假设，不能把协议卡包装成论文支持。

验收须包含端到端反例：只有“输入长度 96，预测长度 96/192/336/720”的卡，即使原文真实、BM25 分数高且状态为 `paper_backed`，也不能输出 `supports_mechanism` 或填补机制 intent 的覆盖；正确分类并验证后可为评估需求提供协议参考。另需验证完整机制正例正常通过、旧版缺字段卡被排除、同一输入的规则升级不会复用旧版合格缓存。

### 5.8 跨论文冲突、去重与选择预算

读取 `KnowledgeStore.listRelations()`，只保留 bundle card 集合内部的 relation：

- `duplicates`：保留证据更直接、status 更强、revision 更新的 entry，另一项进入 excluded；
- `supports`：两项均可保留，但选择预算优先保证不同 paper；
- `contradicts`：两项均保留并加入 conflicts，不做平均或静默选择；
- `refines`：保留关系，排序时更具体的卡片优先。

在 `RetrievalBudgets` 增加：

```ts
maxTaskEvidenceEntries: 12
maxTaskEvidencePerIntent: 3
```

选择顺序：

1. 先保证每个 must-cover intent 至少一个合格 entry；
2. 再补齐每个 intent 的 limitation/contradiction；
3. 再按 relevance、card status、directness、transferability 排序；
4. 同分优先不同 paper；
5. 最后以 `paperID/cardID` 稳定排序，保证可复现。

### 5.9 readiness 与 gap

```text
ready_with_evidence
  所有 must-cover intent 均有合格 entry，且无未呈现的高置信冲突

partial_evidence
  至少有一个合格 entry，但存在 must-cover gap、card 缺失或 literature partial/failed

evidence_conflict
  关键 intent 存在高置信 contradiction，必须向 HypoPlanner 显式展示

ready_data_only
  没有合格 card；HypoPlanner 允许继续，但只能输出 data_only 假设
```

无 PDF、无候选和 LiteratureAgent 单篇失败属于 gap，不是整个 RetrieveAgent 的异常。schema/provenance/KnowledgeStore 损坏属于硬失败。

## 6. RetrieveAgent 代码改动

新增：

```text
opencode/packages/opencode/src/research/retrieve/
├── task-evidence-builder.ts
├── card-intent-binder.ts
├── applicability-matcher.ts
└── config/tsf-task-evidence.v1.json
```

修改：

```text
retrieve/contract.ts
retrieve/retrieve-agent.ts
retrieve/retrieve-store.ts
retrieve/report-renderer.ts
retrieve/index.ts
research/service.ts
research/event.ts（仅在需要补充 metadata 时修改，不新增 Agent event）
```

`RetrieveAgent.run()` 的新增步骤位于 Literature bridge 之后、构造 result 之前：

```ts
const taskEvidence = buildTaskEvidence({
  report,
  taskContext,
  transformations,
  intents,
  candidates,
  literatureResults,
  knowledgeSource,
  budgets,
})

const result = RetrieveResultV2Schema.parse({
  ...,
  taskEvidence,
})
```

RetrieveStore 新增落盘文件：

```text
.neo-cast/literature-retrieval/runs/<retrieve-run-id>/
├── task_evidence_bundle.json
├── task_evidence_excluded.jsonl
└── 其余现有文件
```

`report.md` 增加：

- readiness；
- intent coverage；
- selected cards 和 roles；
- applicability conflicts；
- excluded cards 和原因；
- evidence gaps；
- card → evidence path → paper page 的可读链路。

## 7. HypoPlanner 桥接

### 7.1 输入

`HypoPlannerInput` 增加：

```ts
readonly taskEvidence?: TaskEvidenceBundle
```

可选是为了兼容手工调用和旧测试；缺失时等价于 `ready_data_only`，不得伪造文献支持。

### 7.2 HypothesisObject

增加必填字段，并为现有 deterministic fallback 提供空值：

```ts
readonly datasetEvidencePaths: readonly string[]
readonly literatureEvidence: readonly {
  cardID: string
  cardRevision: number
  role: TaskEvidenceRole
}[]
readonly applicabilityAssumptions: readonly string[]
readonly falsificationCriteria: readonly string[]
readonly evidenceLevel: "data_only" | "paper_supported" | "conflicted"
```

约束：

- `paper_supported` 至少引用一个 bundle entry；
- `conflicted` 必须引用或说明相关 conflict；
- `data_only` 的 literatureEvidence 必须为空；
- cardID/revision/role 必须与 bundle 完全一致；
- 每个 datasetEvidencePath 必须属于引用 entry 的 linkage；
- 论文 evidence 只能支撑机制和条件，不能把 reported effect 改写为当前任务保证；
- 每条非 baseline-control 假设至少一个 falsification criterion。

### 7.3 deterministic hypotheses

现有 hardcoded hypothesis rules 保留为无文献或 LLM 失败时的 fallback。增强规则：

- 根据 rule bias 找到 bundle 中匹配 concept/method 的 entries；
- 有 entry 时补充 literatureEvidence、limitations 和 assumptions；
- 无 entry 时保持 `data_only`；
- 不因存在 KnowledgeCard 自动更换 suggested backbone；实现建议只能来自 entry 的 registryMappings 或既有 method library。

### 7.4 LLM prompt

`buildHypoPlannerUserPrompt()` 增加压缩后的 `taskEvidence`，不传入整个 KnowledgeStore，也不传完整 evidenceSpan：

```json
{
  "readiness": "ready_with_evidence",
  "entries": [
    {
      "cardID": "kc_xxx",
      "revision": 2,
      "claim": "...",
      "roles": ["supports_mechanism"],
      "conceptIDs": ["multiple_seasonalities"],
      "datasetEvidencePaths": ["$.statistics.frequency.spectralPeaks"],
      "applicability": { "status": "matched" },
      "limitations": []
    }
  ],
  "conflicts": [],
  "gaps": []
}
```

prompt 规则：

- 只能引用给定 cardID/revision；
- 不得把 BM25 或 relevance score 当成真实性；
- 有 contradicting evidence 时必须反映在 risk/assumptions；
- 没有合格 entry 时必须输出 `data_only`；
- expectedOutcome 是待验证预测，不是论文保证；
- 每条假设给出证伪标准。

### 7.5 输出校验

在 HypoPlanner 模块内增加纯函数：

```ts
validateHypothesisEvidence(hypotheses, taskEvidence)
```

它不是 Agent，不创建事件或状态机。直接校验：

- 未知 cardID；
- revision mismatch；
- role mismatch；
- evidence path 越权；
- conflicted card 被当作无条件正向证据；
- evidenceLevel 与引用不一致；
- 缺失 falsification criteria。

direct LLM 路径若校验失败，整批 LLM hypotheses 视为失败并使用 deterministic fallback，禁止静默删除非法引用后继续。

## 8. session-mode 与持久化

这是本方案的必做项。当前主路径优先通过 `hypothesis_add/update` 工具写入数据库；如果只修改 prompt 和内存类型，文献引用会在落库时丢失。

### 8.1 数据库迁移

`research_hypothesis` 增加：

```sql
dataset_evidence_paths    TEXT JSON NOT NULL DEFAULT '[]'
literature_evidence      TEXT JSON NOT NULL DEFAULT '[]'
applicability_assumptions TEXT JSON NOT NULL DEFAULT '[]'
falsification_criteria   TEXT JSON NOT NULL DEFAULT '[]'
evidence_level           TEXT NOT NULL DEFAULT 'data_only'
```

同时修改：

- `research/research.sql.ts`；
- 新 migration SQL；
- `research/hypothesis-store.ts` 的 map/add/update；
- `research/service.ts` 内重复的 row mapper 和直接 insert；
- recovery path；
- hypothesis changed event snapshot。

### 8.2 hypothesis tools

扩展 `hypothesis_add` 和 `hypothesis_update` 参数：

- `datasetEvidencePaths`；
- `literatureEvidence`；
- `applicabilityAssumptions`；
- `falsificationCriteria`；
- `evidenceLevel`。

工具执行前从当前 task 最新的 `task_evidence_bundle_json` artifact 加载 bundle，并调用同一个 `validateHypothesisEvidence()`。不得在 tool 层复制一套规则。

`hypothesis_list` 返回完整证据字段，使后续 reflection turn 能看到先前引用。

## 9. Research Service 与 pipeline

### 9.1 Artifact

`runRetrieveAgent()` 除现有 retrieve result artifact 外，注册：

```text
kind = task_evidence_bundle_json
schemaVersion = task_evidence_bundle_v1
retrieveRunID
readiness
selectedEntryCount
uncoveredMustCoverIntentCount
```

HypoPlanner 通过 artifact URI 加载 bundle，不自行计算 knowledgeRoot 路径。

### 9.2 Workflow phase

在 `PipelineWorkflowPhases` 增加：

```text
literature
```

该 key 的对外显示名称和 phase owner 均为 `LiteratureAgent`。现有 RetrieveAgent/LiteratureAgent started/completed/failed
事件可继续作为内部 substage 事件，不把 Retrieve 前处理和后处理注册成额外 workflow phase。

主 pipeline 调整为：

```text
data_analysis
→ literature
→ hypo_planning
→ searching
```

增加 `recoverRetrieveResult()`：

- 只接受 `retrieve_result_v2`；
- 校验 taskID、quantitativeReportArtifactID 和 task evidence schema；
- recovery 失败时重新运行 RetrieveAgent，不复用损坏 artifact。

### 9.3 调用时序

```ts
const literature = completed("literature")
  ? recoverRetrieveResult(task)
  : runRetrieveAgent({ taskID }).tap(markWorkflowPhase)

const hypoPlanning = completed("hypo_planning")
  ? recoverHypoPlanning(task)
  : runHypoPlannerAgent({
      taskID,
      taskEvidenceArtifactID: literature.taskEvidenceArtifactID,
    })
```

`runHypoPlannerAgent()` 加载并传递同一 bundle 给：

- deterministic draft；
- session prompt；
- direct LLM prompt；
- final result builder；
- hypothesis tool validation。

### 9.4 失败和降级

| 情况 | 行为 |
| --- | --- |
| 没有 BM25 candidate | 生成 `ready_data_only` bundle，继续 HypoPlanner |
| 没有本地 PDF | 记录 gap，继续 |
| 单篇 Literature 失败 | `partial_evidence`，继续 |
| 所有卡片均不合格 | `ready_data_only`，继续 |
| 存在 contradiction | `evidence_conflict`，继续但 HypoPlanner 必须展示风险 |
| cardID 不存在或 paper mismatch | `partial_evidence`；记录 excluded；若全部 provenance 损坏则失败 |
| bundle schema/provenance 损坏 | pipeline 失败，不允许无声降级 |
| KnowledgeStore 无法打开 | pipeline 失败并保留 RetrieveAgentFailed event |

## 10. 文件级实施清单

### Wave 1：Retrieve task evidence 核心

新增：

- `research/retrieve/task-evidence-builder.ts`
- `research/retrieve/card-intent-binder.ts`
- `research/retrieve/applicability-matcher.ts`
- `research/retrieve/config/tsf-task-evidence.v1.json`

修改：

- `research/retrieve/contract.ts`
- `research/retrieve/retrieve-agent.ts`
- `research/retrieve/retrieve-store.ts`
- `research/retrieve/report-renderer.ts`
- `research/retrieve/index.ts`

验收：RetrieveAgent 单次运行直接产出严格校验的 `task_evidence_bundle_v1`，每个 selected/excluded card 都可审计。

### Wave 2：HypoPlanner 契约与 deterministic/direct LLM

修改：

- `research/agents/hypo-planner-agent.ts`
- `research/service.ts` 中 prompt、parser 和 direct LLM 调用
- `agent/prompt/research-hypo-planner.txt`
- `research/index.ts`

验收：无卡片时稳定产生 `data_only`；有卡片时假设引用合法 cardID/revision，并带 evidence paths、assumptions 和 falsification criteria。

### Wave 3：session tools 与数据库

新增：

- `migration/<timestamp>_research_hypothesis_evidence/migration.sql`

修改：

- `research/research.sql.ts`
- `research/hypothesis-store.ts`
- `tool/research-hypothesis.ts`
- `research/service.ts` 的 DB insert/map/recovery

验收：`hypothesis_add → DB → hypothesis_list → recoverHypoPlanning` 往返后证据字段完全一致；非法 card 引用在 tool 执行阶段被拒绝。

### Wave 4：pipeline 和 artifacts

修改：

- `research/service.ts`
- 必要时 `research/event.ts` 的 metadata schema
- 对应 service tests

验收：外部 pipeline 顺序为 DataAnalysisAgent → LiteratureAgent → HypoPlanner，LiteratureAgent phase 内部执行
Retrieve(pre) → Literature(core) → Retrieve(post)，并支持 phase recovery；无文献不是阻塞，损坏 bundle 是阻塞。

### Wave 5：回归与文档

修改：

- `research/retrieve/README.md`
- 当前实施方案状态；
- CLI/service 示例；
- schema/registry exports。

验收：相关 targeted tests、migration check 和项目测试通过；不存在未说明的兼容性变化。

## 11. 测试计划

### 11.1 Retrieve 单元测试

新增 `test/research/retrieve/task-evidence-builder.test.ts`，至少覆盖：

1. 同一 paper 命中多个 intent，但 card 只绑定语义匹配的 intent；
2. card provenance 展开到正确 transformation/concept/evidence path；
3. `paper_backed + direct + exact_span` 可作为正向证据；
4. extracted/inconclusive/deprecated 不能作为正向证据；
5. contradicted card 只能作为反证；
6. missing card 和 paper mismatch 不被静默忽略；
7. `notApplicableWhen` 已知谓词命中时产生硬冲突；
8. 未知自然语言条件进入 uncertain，而不是误判；
9. domain-only 不建立 binding；
10. must-cover intent 缺证据时产生 gap；
11. duplicate/supports/contradicts/refines relation 正确处理；
12. 预算优先保证 intent coverage 和 paper diversity；
13. 输入顺序变化不影响稳定输出；
14. BM25 高分不能绕过 evidence gate。

### 11.2 Retrieve 集成测试

扩展现有 `retrieve-agent.test.ts`：

- fixture LiteratureAgent 写入真实 KnowledgeStore；
- RetrieveAgent 返回 taskEvidence；
- `task_evidence_bundle.json` 和 report 落盘；
- 重复运行复用相同 v2 run；
- task context 或 mapping version 改变会生成不同 runID。

### 11.3 HypoPlanner 测试

扩展 `hypo-planner-agent.test.ts`：

- data-only fallback；
- paper-supported hypothesis；
- conflict hypothesis；
- revision mismatch；
- bundle 外 cardID；
- role mismatch；
- evidence path 越权；
- 缺失 falsification criteria；
- Markdown/YAML 展示引用和 readiness；
- invalid LLM output 回退 deterministic hypotheses。

### 11.4 Store/tool/migration 测试

- 新 migration 可从现有 hypothesis schema 升级；
- 旧行获得安全默认值；
- add/update/list round-trip；
- service 内两处 row mapper 行为一致；
- session tool 拒绝非法 card 引用；
- recovery 后证据字段不丢失。

### 11.5 Service/pipeline 测试

- 验证外部 DataAnalysisAgent → LiteratureAgent → HypoPlanner 顺序；
- 验证 LiteratureAgent phase 内部 Retrieve(pre) → Literature(core) → Retrieve(post) 顺序；
- Retrieve artifact 被 HypoPlanner 使用；
- `ready_data_only` 不阻塞；
- Literature partial 不阻塞；
- bundle schema 损坏阻塞；
- 已完成 literature phase 可以恢复；
- force/retry 不重复创建同 retrieveRunID artifact。

### 11.6 建议命令

```bash
cd opencode/packages/opencode
bun test test/research/retrieve
bun test test/research/literature
bun test test/research/hypo-planner-agent.test.ts
bun test test/research/model-designer-agent.test.ts
bun test test/research/service.test.ts
bun run script/check-migrations.ts
bun typecheck
```

最后运行仓库约定的完整测试；记录与本变更无关的既有失败，不修改无关模块。

## 12. 完成标准

满足以下条件才算完成桥接：

1. 不新增 Agent；
2. LiteratureAgent contract 不接收 task context，canonical card 不包含 task match；
3. RetrieveAgent v2 输出 `task_evidence_bundle_v1`；
4. 所有 accepted card 都进入 selected 或 excluded，且有明确原因；
5. 每个 selected entry 可追溯到 card revision、paper evidence、intent、concept transformation 和 dataset evidence path；
6. BM25 relevance 与 card confidence 明确分离；
7. must-cover intent 的覆盖或 gap 可审计；
8. contradiction 和 limitation 不被 top-K 排序隐藏；
9. HypoPlanner 不能引用 bundle 外 card；
10. paper-supported hypothesis 有适用假设和证伪条件；
11. 无文献时 HypoPlanner 显式标记 `data_only`；
12. session tool、数据库、artifact 和 recovery 往返不丢失证据；
13. 默认 pipeline 已接入对外的 LiteratureAgent phase，内部包含完整 Retrieve/Literature/Retrieve 拓扑；
14. 单篇论文失败不会中断任务，契约或 provenance 损坏不会无声降级；
15. targeted tests、migration check 和类型检查通过。

## 13. 建议实施顺序

建议严格按以下顺序执行：

```text
1. TaskEvidence schema + deterministic builder
2. RetrieveAgent v2 + store/report artifacts
3. HypoPlanner in-memory contract + validator
4. hypothesis DB/tool persistence
5. pipeline wiring + recovery
6. full regression
```

不要先修改 prompt 或 pipeline。只有 task evidence builder 的确定性契约和测试稳定后，才允许 HypoPlanner 消费该产物；否则任务匹配逻辑会散落在 prompt、service 和 Agent 代码中，后续无法审计。
