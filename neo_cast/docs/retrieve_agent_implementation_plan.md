# RetrieveAgent 实施方案（BM25 本地检索版）

## 1. 目标

本方案在 NeoResearch 中增加一个首版 `RetrieveAgent`。它接收
`DataAnalysisAgent` 生成的定量分析报告，将数据证据逐层转换为科学概念、方法概念和论文常用语言，
然后使用本地 BM25 检索论文，并把高相关候选交给现有 `LiteratureAgent` 进行全文解析、claim 抽取和
证据验证。

首版闭环为：

```text
Current Dataset
      ↓
DataAnalysisAgent
      ↓
Quantitative Analysis Report
      ↓
RetrieveAgent
  ├─ Dataset Evidence Reader
  ├─ Scientific Concept Mapper
  ├─ Method Concept Mapper
  ├─ Paper-language Translator
  └─ Local BM25 Retriever
      ↓
Ranked Candidate Papers
      ↓
LiteratureAgent
  ├─ PDF parsing
  ├─ claim extraction
  ├─ evidence verification
  └─ KnowledgeCard generation
      ↓
Retrieve Result + KnowledgeCards
```

这一版本的终点是完成 `RetrieveAgent → LiteratureAgent` 桥接，不接入 `HypoPlannerAgent`。

## 2. 首版范围

### 2.1 本期实现

- DataAnalysis 输出机器可读的定量分析报告；
- 从定量报告提取有来源的 Dataset Evidence；
- 完成 `Dataset Evidence → Scientific Concepts → Method Concepts → Paper Language` 转换；
- 每个 Retrieval Intent 只生成一个论文语言查询；
- 使用本地 BM25 进行一次召回；
- 对 BM25 结果进行去重、证据层级判断和简单筛选；
- 将有本地 PDF 的高优先级论文交给 `LiteratureAgent`；
- 收集 `LiteratureAgent` 返回的 KnowledgeCard 和失败状态；
- 保存完整的输入、转换、查询、候选和桥接轨迹。

### 2.2 本期不实现

- 不配置学术乐问或其他论文检索 API；
- 不实现同一 Intent 的多 Query Expansion；
- 不实现 Reciprocal Rank Fusion（RRF）；
- 不实现向量检索或 embedding rerank；
- 不实现 Search → Learn → Search 的多轮循环；
- 不实现 citation/reference expansion；
- 不自动下载论文使用的数据集重新 profiling；
- 不与 HypoPlanner 或 ModelDesigner 桥接；
- 不让 RetrieveAgent 直接生成模型假设或修改模型代码。

如果一个数据集形成多个 Retrieval Intent，每个 Intent 可以各执行一次 BM25，但结果按 Intent 分开保存。
这不属于“同一意图的多查询召回”，也不进行跨查询 RRF 融合。

## 3. 组件职责

### 3.1 DataAnalysisAgent

负责从原始数值数据产生客观分析结果，例如：

- 趋势强度；
- 周期性强度；
- ACF/PACF；
- 频谱峰；
- ADF/KPSS；
- distribution shift；
- change point；
- missing/outlier/irregular interval；
- cross-variate 和 cross-lag 关系；
- observed-past、known-future 和 static covariate 角色。

DataAnalysisAgent 不负责生成论文检索词。

### 3.2 RetrieveAgent

负责：

- 读取定量报告；
- 判断哪些数据证据足以形成科学概念；
- 为科学概念映射可能相关的方法概念；
- 将内部概念翻译成论文标题、摘要和方法部分常见的英文表达；
- 构造一个 BM25 查询；
- 检索和筛选本地论文；
- 决定哪些论文交给 LiteratureAgent。

RetrieveAgent 产生的是“检索相关性”，不是论文事实。

### 3.3 LiteratureAgent

现有 `LiteratureAgent` 继续负责：

- 解析本地 PDF；
- 将论文分 section 和 chunk；
- 抽取 candidate claim；
- 验证 claim 是否被原文支持；
- 生成 KnowledgeCard；
- 保存 evidence span、页码、section 和 provenance；
- 处理重复卡片和冲突关系。

只有 LiteratureAgent 验证通过的 claim 才能标记为 `paper_backed`。

## 4. DataAnalysis 定量报告契约

### 4.1 双产物

DataAnalysis 应从同一个内存对象生成：

1. `dataset_quantitative_analysis_markdown`：供人阅读；
2. `dataset_quantitative_analysis_json`：供 RetrieveAgent 读取。

RetrieveAgent 不从 Markdown 表格中用正则提取数值。JSON 是机器交接的权威来源，Markdown 只是其可读视图。

### 4.2 JSON 示例

```json
{
  "schemaVersion": "dataset_quantitative_analysis_v1",
  "taskID": "researchTask_xxx",
  "domain": "electricity_load",
  "dataset": {
    "samplingFrequency": "hourly",
    "targetColumns": ["load"],
    "observedPastCovariates": ["temperature"],
    "knownFutureCovariates": ["temperature", "holiday"],
    "staticCovariates": []
  },
  "forecast": {
    "contextLength": 168,
    "predictionLengths": [24, 168],
    "horizonContextRatio": 1.0
  },
  "profile": {
    "rowCount": 20000,
    "missingRate": 0.0,
    "trendStrength": 0.63,
    "seasonalityStrength": 0.91,
    "crossVarCorrelation": 0.52,
    "distributionShift": 0.44,
    "outlierRate": 0.02,
    "irregularIntervalRatio": 0.0
  },
  "statistics": {
    "stationarity": {
      "adfStatistic": -2.31,
      "adfStationary": false,
      "kpssStatistic": 0.71,
      "kpssStationary": false
    },
    "acf": {
      "topLag": 24,
      "topCorrelation": 0.88,
      "pacfTopLag": 24,
      "pacfTopCorrelation": 0.62
    },
    "decomposition": {
      "period": 24,
      "trendVarianceShare": 0.28,
      "seasonalVarianceShare": 0.57,
      "residualVarianceShare": 0.15
    },
    "frequency": {
      "dominantPeriod": 24,
      "dominantPowerShare": 0.49,
      "spectralPeaks": [
        {"period": 24, "powerShare": 0.49, "significant": true},
        {"period": 168, "powerShare": 0.21, "significant": true}
      ]
    },
    "changepoint": {
      "index": 12600,
      "score": 0.68,
      "severity": "medium"
    },
    "crossLag": {
      "source": "temperature",
      "target": "load",
      "lag": 2,
      "correlation": 0.58
    }
  },
  "warnings": [],
  "sourceArtifactIDs": ["researchArtifact_xxx"]
}
```

### 4.3 必要补充

当前分析实现只有一个 dominant frequency。为了识别 multiple seasonalities，需要增加
`spectralPeaks`，至少记录 period、power share、significance 和可选的 peak stability across windows。

如果只有一个显著频谱峰，RetrieveAgent 只能转换为 `seasonality`，不能转换为
`multiple_seasonalities`。

calendar/holiday effect 只有在 task 中确实存在相应字段，并且 DataAnalysis 做过分组分析后才能作为
Dataset Evidence。否则保持 `unknown`。

## 5. 多层科学概念转换

### 5.1 转换模型

RetrieveAgent 不直接把数值拼进 Query，而是构造四层表示：

```text
Dataset Evidence
      ↓
Scientific Concepts
      ↓
Method Concepts
      ↓
Paper Language
      ↓
BM25 Query
```

各层含义：

- `Dataset Evidence`：DataAnalysis 实际计算或 task spec 明确给出的事实；
- `Scientific Concepts`：学术界对这种数据现象或问题的称呼；
- `Method Concepts`：可能针对该问题的方法机制，属于检索假设，不代表已决定使用；
- `Paper Language`：论文标题、摘要和方法章节中更可能出现的英文术语或短语。

### 5.2 转换契约

```ts
type ConceptTransformation = {
  transformationID: string
  datasetEvidence: Array<{
    path: string
    metric: string
    value: unknown
    interpretation: string
  }>
  scientificConcepts: Array<{
    conceptID: string
    label: string
    paperTerms: string[]
    confidence: number
    basis: "deterministic_rule" | "llm_supported"
  }>
  modelingChallenges: string[]
  methodConcepts: Array<{
    conceptID: string
    label: string
    paperTerms: string[]
    rationale: string
    status: "retrieval_hypothesis"
  }>
  paperLanguage: {
    taskTerms: string[]
    phenomenonTerms: string[]
    methodTerms: string[]
    domainTerms: string[]
    queryText: string
  }
}
```

Method Concept 必须标记为 `retrieval_hypothesis`。例如发现强周期性后可以检索
frequency-domain modeling，但不能在检索前就声称 frequency-domain method 一定适合当前数据。

### 5.3 转换示例

#### 示例一：多周期

```text
Dataset Evidence
- spectral peak at 24, power share 0.49
- spectral peak at 168, power share 0.21

Scientific Concepts
- multiple seasonalities
- multi-periodicity
- heterogeneous periodic patterns

Method Concepts
- frequency-domain modeling
- multi-scale temporal modeling
- seasonal decomposition

Paper Language
- multiple seasonalities in time series forecasting
- multi-periodic temporal patterns
- frequency-domain forecasting
- multi-scale seasonal modeling
```

#### 示例二：趋势与非平稳性

```text
Dataset Evidence
- trendStrength = 0.63
- ADF stationary = false
- KPSS stationary = false
- distributionShift = 0.44

Scientific Concepts
- non-stationary time series
- temporal distribution shift
- evolving trend dynamics

Method Concepts
- trend-seasonal decomposition
- adaptive normalization
- distribution-shift-aware forecasting

Paper Language
- non-stationary time series forecasting
- temporal distribution shift forecasting
- adaptive normalization for forecasting
- trend decomposition forecasting
```

只有 `trendStrength` 高、但平稳性检验和 shift 不支持时，Scientific Concept 应保持为
`trend dynamics`，不能升级为 `non-stationarity`。

#### 示例三：变化点

```text
Dataset Evidence
- changePointScore = 0.68
- severity = medium

Scientific Concepts
- potential structural break
- regime transition
- temporal regime shift

Method Concepts
- change-point-aware forecasting
- regime-adaptive modeling
- mixture-of-experts routing

Paper Language
- forecasting under structural breaks
- regime shift time series forecasting
- change-point-aware forecasting model
- regime-adaptive temporal modeling
```

由于 change-point detector 也可能误报，concept 使用 `potential structural break`，而不是断言已存在确定的
structural break。

#### 示例四：未来协变量

```text
Dataset Evidence
- knownFutureCovariates = [temperature, holiday]

Scientific Concepts
- exogenous variable dependence
- covariate-conditioned forecasting
- future-known information

Method Concepts
- covariate fusion
- exogenous attention
- static/dynamic variable selection

Paper Language
- time series forecasting with known future covariates
- exogenous variable forecasting model
- covariate-conditioned probabilistic forecasting
- future covariate fusion
```

#### 示例五：跨变量依赖

```text
Dataset Evidence
- crossVarCorrelation = 0.72
- cross-lag temperature → load, lag = 2, correlation = 0.58

Scientific Concepts
- cross-series dependency
- inter-variable correlation
- lead-lag relationship

Method Concepts
- channel mixing
- cross-variable attention
- lag-aware feature fusion

Paper Language
- multivariate time series forecasting with cross-variable dependencies
- channel mixing forecasting model
- lead-lag dependency modeling
- cross-variable attention for forecasting
```

### 5.4 推荐的转换表

| Dataset evidence | Scientific concepts | Method concepts | Paper-language terms |
| --- | --- | --- | --- |
| strong seasonality + ACF/频域支持 | seasonality, recurrent temporal patterns | seasonal decomposition, periodic encoding | seasonal time series forecasting, periodic dependency modeling |
| 两个以上显著频谱峰 | multiple seasonalities, multi-periodicity | frequency modeling, multi-scale modeling | multiple seasonalities forecasting, multi-periodic forecasting |
| high trend strength | trend dynamics, long-term evolution | detrending, trend decomposition | trend-aware forecasting, trend decomposition forecasting |
| ADF/KPSS/shift 联合支持 | non-stationarity, temporal distribution shift | adaptive normalization, shift-aware learning | non-stationary forecasting, distribution shift forecasting |
| high change-point score | potential structural break, regime transition | change-point-aware modeling, regime adaptation | forecasting under structural breaks, regime shift forecasting |
| known-future covariates | covariate-conditioned forecasting, exogenous dependence | covariate fusion, exogenous attention | forecasting with known future covariates, exogenous variable forecasting |
| high cross-variate correlation | cross-series dependency | channel mixing, cross-variable attention | cross-variable dependency forecasting, channel mixing model |
| significant cross-lag | lead-lag relationship, delayed effect | lag-aware fusion, temporal cross-attention | lead-lag forecasting, lagged covariate modeling |
| high outlier rate | contaminated observations, heavy-tailed noise | robust loss, robust normalization | robust time series forecasting, outlier-resistant forecasting |
| high missing rate | incomplete observations | masked modeling, missingness-aware encoder | missing-aware forecasting, masked time series modeling |
| irregular intervals | irregularly sampled time series | continuous-time modeling, time-gap encoding | irregular time series forecasting, irregular sampling model |
| high horizon/context ratio | long-horizon dependency | multi-scale context, efficient long-range modeling | long-term time series forecasting, long-horizon forecasting |
| holiday 分组效应有实证支持 | calendar effect, special-day effect | calendar embedding, event-aware gating | holiday load forecasting, calendar-aware forecasting |
| variance changes over time | heteroscedasticity, time-varying uncertainty | probabilistic head, scale modeling | heteroscedastic forecasting, probabilistic time series forecasting |

### 5.5 确定性规则与 LLM 分工

确定性规则负责：

- 根据报告字段和值决定允许出现哪些 Scientific Concepts；
- 阻止 unsupported concept；
- 从版本化词表加载 Method Concepts 和 paper terms；
- 为每个 concept 保存 source path 和 confidence。

LLM 只负责：

- 在允许的 concepts 内选择更自然的论文表达；
- 把术语组织成一个简洁的英文检索字符串；
- 去掉重复、口语化或数值化表达。

LLM 不允许：

- 修改 DataAnalysis 数值；
- 添加报告中没有证据支持的 Scientific Concept；
- 把 Method Concept 写成已经成立的方法结论；
- 把 `seasonalityStrength=0.91` 这类内部字段名直接作为论文关键词；
- 自动修改正式 taxonomy。

LLM 输出必须通过严格 Zod schema，并检查每个 `datasetEvidence.path` 都能在报告中解析。

## 6. Retrieval Intent 与论文语言查询

### 6.1 Intent 结构

```json
{
  "intentID": "intent_multi_periodicity",
  "question": "How can forecasting models represent multiple periodic structures?",
  "transformationID": "transform_multi_periodicity",
  "priority": 0.94,
  "mustCover": true,
  "paperLanguageQuery": {
    "taskTerms": ["time series forecasting"],
    "phenomenonTerms": ["multiple seasonalities", "multi-periodic patterns"],
    "methodTerms": ["frequency-domain modeling", "multi-scale temporal modeling"],
    "domainTerms": ["electricity load"],
    "queryText": "time series forecasting multiple seasonalities multi-periodic frequency-domain multi-scale"
  }
}
```

### 6.2 单查询约束

首版每个 Intent 只产生一个 `queryText`：

- 不为 phenomenon、method、domain 分别生成查询；
- 不为同义词生成多个查询；
- 不执行 query paraphrase；
- 不使用 RRF 合并结果；
- 不进行第二轮 query refinement。

同义词可以作为同一个 BM25 查询中的 terms，但仍然只执行一次检索。

### 6.3 论文语言转换规则

查询应优先使用论文可能出现的表达：

| 内部表达 | 不推荐直接检索 | 推荐论文语言 |
| --- | --- | --- |
| `seasonalityStrength=0.91` | strong seasonality 0.91 | seasonal patterns, periodic dependencies |
| `spectralPeaks=[24,168]` | period 24 period 168 | multiple seasonalities, multi-periodic patterns |
| `distributionShift=0.7` | strong distribution shift 0.7 | temporal distribution shift, non-stationary forecasting |
| `changePointScore=0.68` | change point score 0.68 | structural breaks, regime transitions |
| `knownFutureCovariates` | future variables available | known future covariates, exogenous variables |
| `crossVarCorrelation=0.72` | variables highly correlated | cross-variable dependencies, inter-series correlation |

数字只保留在 provenance 和结果解释中，不进入首版 BM25 query；`24-hour`、`weekly` 等具有明确科学含义的
周期描述可以例外，但必须由 sampling frequency 和 period 联合确定。

## 7. 本地 BM25 检索

### 7.1 本地语料来源

| Evidence level | 来源 | 可支持的用途 |
| --- | --- | --- |
| `metadata_only` | catalog title、year、venue、publication status | 初步召回 |
| `document_available` | abstract、introduction、method、results chunks | 相关性判断和全文检查 |
| `paper_backed` | 已验证 KnowledgeCard 和 evidence span | 论文事实与机制证据 |

当前 `paper_record` schema 没有 abstract 字段。因此只有 catalog、没有解析 PDF 的论文只能用标题参与 BM25，
不能被标记为全文支持。

### 7.2 索引目录

```text
neo_cast/.neo-cast/literature-retrieval/
├── index/
│   ├── retrieval.db
│   ├── index_manifest.json
│   └── document_fingerprints.jsonl
└── runs/<retrieve-run-id>/
```

`retrieval.db` 使用 SQLite/FTS5：

- `paper`：paperID、title、year、venue、publication status、PDF 状态；
- `paper_text`：各 section 的聚合文本；
- `paper_fts`：title、abstract、introduction、method、results、limitations；
- `card_projection`：KnowledgeCard 的 claim、mechanism、applicability；
- `index_source`：源文件 digest、parser version、taxonomy version。

首版不建立 citation graph，不建立向量索引。

### 7.3 字段权重

BM25 建议字段权重：

```text
title             = 4.0
abstract          = 3.0
knowledge_card    = 3.0
method            = 2.0
introduction      = 1.5
results/ablation  = 1.5
limitations       = 1.0
```

如果 FTS5 的字段权重接口不能稳定满足需求，可在单元测试固定的 BM25 实现中显式计算 field score；
仍然保持单查询、单阶段 BM25，不增加第二种召回器。

### 7.4 检索过程

每个 Intent 的检索过程固定为：

```text
paper-language query
      ↓
normalize terms
      ↓
one BM25 search
      ↓
top K results
      ↓
deduplicate by paperID / DOI / arXiv ID
      ↓
attach matched fields and evidence level
      ↓
select papers for LiteratureAgent
```

首版保留 BM25 原始 rank 和可解释命中信息，不再叠加复杂综合公式。

### 7.5 候选结构

```json
{
  "schemaVersion": "retrieval_candidate_v1",
  "candidateID": "rc_xxx",
  "paperID": "tsf-2024-xxxxxxxxxxxx",
  "intentID": "intent_multi_periodicity",
  "queryText": "time series forecasting multiple seasonalities multi-periodic frequency-domain multi-scale",
  "bm25": {
    "rank": 1,
    "score": 12.84,
    "matchedFields": ["title", "abstract", "method"],
    "matchedTerms": ["multiple seasonalities", "frequency-domain"]
  },
  "evidenceLevel": "document_available",
  "localPDF": true,
  "decision": "send_to_literature_agent",
  "decisionReasons": [
    "top BM25 result for intent_multi_periodicity",
    "local PDF and method section are available"
  ]
}
```

### 7.6 简单筛选规则

- 每个 Intent 默认取 BM25 top 20；
- 每个 Intent 最多向 LiteratureAgent 发送 top 5；
- 同一论文被多个 Intent 命中时只解析一次，但保留全部 `intentID`；
- 没有本地 PDF 的论文保留在结果中，状态为 `skipped_pdf_unavailable`；
- `references` section 的命中不计入正文匹配；
- 只有 domain term 命中、没有 scientific/method term 命中的候选降级为 `domain_only`；
- watchlist/preprint 不删除，但显式保留 publication status；
- BM25 分数不能转换为“论文结论可信度”。

## 8. RetrieveAgent 与 LiteratureAgent 桥接

### 8.1 桥接原则

RetrieveAgent 只向 LiteratureAgent 传递本地可解析的论文：

```text
BM25 Candidate
  ├─ local PDF exists
  │      ↓
  │  LiteratureAgent.run(catalog_paper)
  │      ↓
  │  completed / partial / failed
  │      ↓
  │  KnowledgeCard IDs
  │
  └─ no local PDF
         ↓
     skipped_pdf_unavailable
```

### 8.2 Bridge 输入

```ts
type RetrieveLiteratureBridgeInput = {
  retrieveRunID: string
  candidates: Array<{
    paperID: string
    intentIDs: string[]
    bm25Rank: number
    bm25Score: number
  }>
  literatureOptions: {
    includeAgentInference: false
    requireExactEvidenceSpan: true
    maxCardsPerPaper: number
  }
}
```

集成模式默认：

```json
{
  "includeAgentInference": false,
  "requireExactEvidenceSpan": true,
  "maxCardsPerPaper": 30
}
```

### 8.3 Bridge 输出

```ts
type RetrieveLiteratureBridgeResult = {
  retrieveRunID: string
  papers: Array<{
    paperID: string
    intentIDs: string[]
    status:
      | "completed"
      | "partial"
      | "failed"
      | "skipped_pdf_unavailable"
    literatureRunID?: string
    acceptedCardIDs: string[]
    rejectedCandidateCount: number
    warningCount: number
    reviewPath?: string
    error?: string
  }>
}
```

### 8.4 关联关系

RetrieveAgent 需要额外保存：

```text
Dataset Evidence
→ Concept Transformation
→ Retrieval Intent
→ BM25 Candidate
→ LiteratureAgent Run
→ KnowledgeCard
```

KnowledgeCard 本身保持跨任务、跨检索运行的 canonical knowledge，不写入 BM25 score。
BM25 score、intent 和 DataAnalysis 来源保存在 RetrieveAgent 的运行记录中。

### 8.5 幂等与失败处理

- 相同 PDF digest、parser version、prompt version 已有 completed LiteratureAgent run 时复用结果；
- 单篇论文解析失败不能中止整个 RetrieveAgent run；
- `ocr_required` 记录为 partial；
- 没有 PDF 不是错误，记录为 skipped；
- 所有失败保留 paperID、intentID 和原因；
- RetrieveAgent 最终状态允许为 `completed_with_warnings`。

## 9. 首版状态机

首版是单轮流水线，不进行自主循环：

```text
READ_REPORT
    ↓
EXTRACT_DATASET_EVIDENCE
    ↓
MAP_SCIENTIFIC_CONCEPTS
    ↓
MAP_METHOD_CONCEPTS
    ↓
TRANSLATE_TO_PAPER_LANGUAGE
    ↓
BM25_RECALL
    ↓
SELECT_LOCAL_PAPERS
    ↓
RUN_LITERATURE_AGENT
    ↓
COLLECT_KNOWLEDGE_CARDS
    ↓
FINISH
```

状态机没有 `SEARCH_AGAIN`、`EXPAND_CITATIONS` 或 `UPDATE_QUERY` action。

默认预算：

```json
{
  "maxIntents": 6,
  "maxCandidatesPerIntent": 20,
  "maxLiteraturePapersPerIntent": 5,
  "maxLiteraturePapersTotal": 12
}
```

## 10. RetrieveAgent 最终产物

### 10.1 运行目录

```text
.neo-cast/literature-retrieval/runs/<retrieve-run-id>/
├── input.json
├── dataset_evidence.json
├── concept_transformations.json
├── retrieval_intents.json
├── bm25_results.jsonl
├── selected_candidates.jsonl
├── literature_bridge_results.json
├── retrieve_result.json
├── report.md
└── run_manifest.json
```

### 10.2 Retrieve Result

```json
{
  "schemaVersion": "retrieve_result_v1",
  "retrieveRunID": "retrieve_xxx",
  "taskID": "researchTask_xxx",
  "quantitativeReportArtifactID": "researchArtifact_xxx",
  "transformations": [],
  "intents": [],
  "candidates": [],
  "literatureResults": [
    {
      "paperID": "tsf-2024-xxxxxxxxxxxx",
      "intentIDs": ["intent_multi_periodicity"],
      "status": "completed",
      "acceptedCardIDs": ["kc_xxx", "kc_yyy"],
      "reviewPath": ".neo-cast/literature-knowledge/runs/lerun_xxx/review.md"
    }
  ],
  "summary": {
    "intentCount": 3,
    "bm25CandidateCount": 44,
    "literaturePaperCount": 8,
    "paperBackedCardCount": 15,
    "missingPDFCount": 2,
    "failedPaperCount": 0
  }
}
```

这个产物先供人工检查和后续模块开发使用，本期不由 HypoPlanner 消费。

## 11. 代码组织

建议新增：

```text
opencode/packages/opencode/src/research/retrieve/
├── contract.ts
├── retrieve-agent.ts
├── quantitative-report-reader.ts
├── dataset-evidence.ts
├── scientific-concept-mapper.ts
├── method-concept-mapper.ts
├── paper-language-translator.ts
├── retrieval-intent.ts
├── local-index-builder.ts
├── bm25-search.ts
├── candidate-selector.ts
├── literature-bridge.ts
├── retrieve-store.ts
├── report-renderer.ts
└── config/
    ├── tsf-scientific-concepts.v1.json
    ├── tsf-method-concepts.v1.json
    └── tsf-paper-language.v1.json
```

建议新增 schema：

```text
neo_cast/literature_knowledge/
├── dataset_quantitative_analysis.schema.json
├── concept_transformation.schema.json
├── retrieval_intent.schema.json
├── retrieval_candidate.schema.json
├── retrieve_literature_bridge_result.schema.json
└── retrieve_result.schema.json
```

现有 `opencode/.../research/literature/` 保持为论文理解和 KnowledgeCard 模块。RetrieveAgent 通过
`literature-bridge.ts` 调用它，不复制其解析、验证或存储逻辑。

## 12. 索引与运行可复现性

`index_manifest.json` 至少记录：

- catalog SHA-256；
- 每个 normalized document/chunk 文件的 SHA-256；
- KnowledgeCard export digest；
- tokenizer version；
- BM25 参数；
- taxonomy version；
- 建立时间。

`run_manifest.json` 至少记录：

- quantitative report digest；
- index digest；
- scientific concept mapping version；
- method concept mapping version；
- paper-language mapping version；
- LLM model/prompt version（如果使用）；
- 每个 Intent 的 queryText；
- top K 和 LiteratureAgent 预算；
- LiteratureAgent run IDs；
- status、warnings 和 errors。

相同 report digest、index digest 和配置版本默认复用 RetrieveAgent 结果，除非显式指定 `force`。

## 13. 测试方案

### 13.1 DataAnalysis contract

- JSON 和 Markdown 来自同一个分析对象；
- JSON schema 严格拒绝未知字段；
- 所有 evidence path 可以解析；
- spectral peaks 为空时不会产生 multiple seasonalities；
- 没有 holiday 字段时不会产生 calendar effect。

### 13.2 Concept conversion

- 强周期性转换为 seasonality；
- 两个显著频谱峰转换为 multiple seasonalities；
- 单频谱峰不能转换为 multiple seasonalities；
- 只有 trend strength 时不能直接断言 non-stationarity；
- known-future covariates 转换为 covariate-conditioned forecasting；
- method concepts 全部带 `retrieval_hypothesis`；
- LLM 不能添加 allowlist 外的 scientific concept；
- 内部指标名和数值不会原样进入 query。

### 13.3 Paper-language translation

- 每个 Intent 恰好产生一个 queryText；
- query 使用英语学术术语；
- query 包含 task term 和至少一个 scientific term；
- query 不生成 paraphrase 列表；
- query 不产生第二轮 refinement；
- 相同输入和配置得到稳定结果。

### 13.4 BM25

建立固定 fixture corpus：

- 一篇 multiple-seasonality/frequency 论文；
- 一篇 non-stationarity 论文；
- 一篇仅 domain 相同但机制无关的论文；
- 一篇只有 title、没有 PDF 的论文；
- 一篇已有 KnowledgeCard 的论文。

验证：

- 对应 scientific/method terms 的论文排在前列；
- 纯 domain 匹配不会被错误标为全文证据；
- title-only 结果 evidence level 为 metadata_only；
- references section 不参与正文匹配；
- BM25 rank 和 matched fields 可以复现；
- 不存在 RRF 或向量分数。

### 13.5 LiteratureAgent bridge

- 有本地 PDF 的候选能调用 LiteratureAgent；
- 同一论文被多个 Intent 命中时只解析一次；
- completed run 可以复用；
- no PDF 返回 skipped 而不是 failed；
- 单篇失败不会中止其他论文；
- acceptedCardIDs 可以追溯到 paperID、candidateID、intentID 和 DataAnalysis evidence；
- integrated mode 禁止 agent-inference card 进入 accepted cards。

### 13.6 端到端测试

```text
quantitative report JSON
→ dataset evidence
→ scientific concepts
→ method concepts
→ paper language
→ one BM25 retrieval per intent
→ candidate selection
→ LiteratureAgent
→ KnowledgeCards
→ retrieve_result.json
```

## 14. 分阶段实施

### Phase 1：定量报告与概念转换

- 增加 `dataset_quantitative_analysis_json`；
- 定义严格 schema；
- 增加 `spectralPeaks`；
- 实现 Dataset Evidence 提取；
- 实现 Scientific Concept、Method Concept 和 Paper Language 三层 mapper；
- 完成正例、反例和 unsupported concept 测试。

验收：每个论文语言 term 都能反向追溯到 Dataset Evidence。

### Phase 2：本地 BM25

- 构建 catalog/chunk/card FTS5 索引；
- 实现每 Intent 单 query BM25；
- 实现 matched field/term 解释；
- 实现 candidate 去重、evidence level 和 PDF availability；
- 生成 BM25 检索报告。

验收：没有多查询扩展、RRF、向量检索或在线 API 调用。

### Phase 3：LiteratureAgent 桥接

- 实现 candidate → LiteratureAgent input 转换；
- 实现调用预算和同 paper 去重；
- 接收 completed/partial/failed/skipped 状态；
- 关联 acceptedCardIDs；
- 生成 `retrieve_result.json` 和 `report.md`。

验收：从定量报告到 paper-backed KnowledgeCard 的 provenance 链完整。

### Phase 4：稳定性与可恢复性

- 增加 index/run manifest；
- 增加 digest 幂等复用；
- 增加部分失败恢复；
- 增加 fixture e2e；
- 在 Research Service 中注册 RetrieveAgent 的 started/completed/failed events。

验收：一篇论文失败不影响其余结果，重复运行不会重复解析相同 PDF。

## 15. 后续版本再考虑

以下能力明确留到首版完成之后：

- 同 Intent 多查询扩展；
- BM25 + vector hybrid retrieval；
- RRF 或 learned reranker；
- Search → Learn → Search 术语迭代；
- citation/reference expansion；
- 学术乐问等在线 API provider；
- 公开论文数据集的 computed profile；
- Retrieve Result 与 HypoPlanner 的桥接；
- 根据实验结果反向调整检索意图。

## 16. MVP 完成标准

第一版达到以下条件即可认为完成：

1. 不配置外部论文 API 也能运行；
2. RetrieveAgent 直接消费结构化定量分析报告；
3. 完成 Dataset Evidence → Scientific Concepts → Method Concepts → Paper Language；
4. 所有 Scientific Concepts 都有数值或 task contract 依据；
5. Method Concepts 明确标记为 retrieval hypothesis；
6. 每个 Intent 只执行一次 BM25；
7. 不存在多查询融合、RRF、向量召回和多轮检索；
8. 有本地 PDF 的候选能够正确桥接到 LiteratureAgent；
9. 没有 PDF 的候选保持 metadata-only/skipped，不生成 paper-backed claim；
10. KnowledgeCard 能追溯到 paper、intent、concept transformation 和 DataAnalysis evidence；
11. RetrieveAgent 的结果先独立落盘，不依赖 HypoPlanner；
12. 所有中间产物和版本信息可审计、可复现。
