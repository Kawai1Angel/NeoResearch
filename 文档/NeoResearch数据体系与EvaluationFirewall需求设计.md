# NeoResearch 数据体系与 Evaluation Firewall 需求设计

日期：2026-05-05

## 1. 背景

NeoResearch 面向 Data Science 自主研究任务，数据层决定了后续 Intent Agent、Data Analysis Agent、HypoPlanner Agent、ModelDesigner Agent、TrainEval Agent、Reflection Agent 和 Publish Agent 的可靠性上限。当前系统在 TSF 场景已经具备部分能力：

- `neo_cast/py/prepare_tsf.py` 支持 CSV materialize、`dataset.v1`、train/val/ref_test 切分、train-only scaler、ref_test runner-only 查询。
- `neo_cast/src/versioning.js` 支持 task/data/recipe/experiment/release lineage。
- `opencode/packages/opencode/src/research/domains/tsf.ts` 支持 TSF dataset profile 和 search bias。
- `opencode/packages/opencode/src/research/verifiers/data-leakage-verifier.ts` 支持运行后 leakage 信号检查。
- `opencode/packages/opencode/src/research/service.ts` 已有 ref_test、blind_test、shadow_holdout、protocol approval gate。

但这些能力仍是分散的运行时片段，还没有形成跨领域统一的数据层契约，也没有把评估集访问边界提升为一等安全机制。尤其在 Time Series Forecasting 中，若系统反复使用 test/ref_test 结果进行 Reflection 和模型迭代，会造成评估污染，最终报告失去可信度。

## 2. 目标

建设标准化 Data Layer，让不同领域的时序数据都能被 NeoResearch 统一读取、诊断、切分、评估、版本化和发布。

核心目标：

- 统一数据上传与连接入口。
- 自动识别 schema、timestamp、采样频率、目标列、外生变量和静态变量。
- 生成结构化数据诊断，包括缺失值、异常值、重复时间戳、频率不规则、分布漂移和潜在数据泄漏。
- 提供严格的 train/val/test/hidden_test 切分协议。
- 建立 Evaluation Firewall，限制各 Agent 对 split、metric 和原始数据的访问能力。
- 生成 Data Card，作为 Data Analysis、HypoPlanner、TrainEval、Reflection、Publish 的正式数据契约。
- 把数据版本、切分版本、诊断版本和评估访问日志纳入 lineage。

非目标：

- P0 不做完整数据湖、在线特征平台或通用 DB connector。
- P0 不要求所有领域一次性完全支持；先完成 TSF，接口预留给 anomaly detection、classification、tabular forecasting 等领域。
- P0 不允许通过 LLM 自由读取 hidden_test 原始数据或标签。

## 3. 设计原则

1. 数据先于建模：Intent 确认后必须先经过 Data Layer，才能进入 Data Analysis 和 HypoPlanner。
2. 切分不可漂移：同一研究任务的 split plan 一旦确认，模型搜索期间不得随候选变化而改变。
3. 训练只看训练：scaler、imputer、encoder、normalizer、feature selector 只能 fit train split。
4. 验证可迭代，测试受控：val 可用于模型选择；test/ref_test 只用于受控里程碑；hidden_test/blind_test 只用于最终评估。
5. 反思不污染评估：Reflection Agent 默认只能使用 train/val 证据，不能把 test/hidden_test 结果写回下一轮搜索记忆。
6. 数据产物可审计：每次数据接入、清洗、切分、评估查询都要产生机器可读 artifact。
7. 领域适配不破坏核心契约：TSF 可以有 horizon-aware split，但必须挂在统一 Data Layer contract 下。

## 4. 总体架构

建议新增逻辑层 `NeoResearch Data Layer`，位于 Intent Agent 和 Data Analysis Agent 之间。

```text
Intent Agent
  -> requirements_confirmed checkpoint
  -> Data Connector
  -> Schema Profiler
  -> Time Index Resolver
  -> Frequency Detector
  -> Quality Diagnostics
  -> Split Planner
  -> Leakage Auditor
  -> Evaluation Firewall Policy
  -> Data Card
  -> Data Analysis Agent
  -> HypoPlanner Agent
  -> ModelDesigner / ModelCompiler / TrainEval
  -> Reflection Agent
  -> Publish Agent
```

Data Layer 分为两层：

- Core Data Layer：跨领域通用，负责 source、schema、version、quality、split、firewall、Data Card。
- Domain Data Adapter：领域扩展，TSF Adapter 负责 timestamp、frequency、horizon、lookback、rolling window、known future covariate 等逻辑。

## 5. Data Layer 模块需求

### 5.1 DataConnector

职责：把外部数据源接入 NeoResearch，并生成不可变 source manifest。

P0 支持：

- 本地 CSV 路径。
- TUI/CLI 提供的 uploaded CSV 文件。
- Neo-Cast benchmark preset：ETTh1、ETTm1、Weather、Traffic。

P1 支持：

- 目录数据集。
- URL 下载。
- parquet。

P2 支持：

- SQL query。
- S3/OSS/GCS。
- Feature store connector。

输出 artifact：

- `data/source_manifest.json`
- `data/raw_sample.csv`
- `data/source_hash.txt`

`source_manifest.json` 必须包含：

```json
{
  "schema_version": "data_source_manifest.v1",
  "source_id": "source_etth1_001",
  "source_type": "local_csv",
  "uri": "/abs/path/ETTh1.csv",
  "content_hash": "sha256:...",
  "size_bytes": 123456,
  "created_at": "2026-05-05T00:00:00Z",
  "declared_owner": "user",
  "privacy_level": "local",
  "ingestion_mode": "copy"
}
```

### 5.2 SchemaProfiler

职责：识别字段类型和语义角色。

必须识别：

- column name
- physical dtype
- logical dtype：numeric、categorical、datetime、boolean、text
- missing count/rate
- unique count
- constant column
- numeric range
- timestamp candidate score
- target candidate score
- covariate role candidate

TSF 角色：

- `timestamp`
- `target`
- `known_future_covariate`
- `observed_past_covariate`
- `static_covariate`
- `ignored`

输出 artifact：

- `data/schema_profile.json`

### 5.3 TimeIndexResolver

职责：解析时间戳并检查时序合法性。

必须检查：

- timestamp parse success rate
- timezone policy
- monotonic increasing
- duplicate timestamp count/rate
- backward jump count
- gap count
- first timestamp / last timestamp
- timestamp granularity candidates

默认策略：

- timestamp 无法解析：阻塞。
- duplicate timestamp：P0 默认阻塞；除非用户选择 aggregate policy。
- 非单调时间：P0 默认按 timestamp 排序并记录警告；若排序后仍重复或缺失严重则阻塞。
- timezone 不明确：按 naive/local 处理，但写入 Data Card 风险。

输出 artifact：

- `data/time_index_profile.json`

### 5.4 FrequencyDetector

职责：识别采样频率和不规则程度。

必须输出：

- inferred frequency
- median delta
- mode delta
- irregular interval ratio
- longest gap
- gap histogram
- frequency confidence

默认策略：

- `irregular_interval_ratio <= 0.01`：可视为规则采样。
- `0.01 < irregular_interval_ratio <= 0.05`：允许继续，但 Data Card 标记 warning。
- `irregular_interval_ratio > 0.05`：默认阻塞，除非 taskSpec 显式允许 row-based windowing 或 resampling。

输出 artifact：

- `data/frequency_profile.json`

### 5.5 DataQualityDiagnostics

职责：对数据质量做结构化诊断。

必须覆盖：

- 缺失值检测：总体、按列、按时间段、连续缺失 run。
- 异常值检测：IQR、robust z-score、突变点。
- 分布漂移：train/val/test 时间段之间的均值、方差、分位数漂移。
- 目标泄漏候选：未来目标、同名滞后不明确字段、直接包含 target future 的字段。
- 低质量字段：常量列、近常量列、高缺失列、极高基数类别列。
- 多变量 TSF：cross correlation、lead-lag correlation。

TSF 额外诊断：

- ACF/PACF。
- stationarity diagnostics。
- seasonal strength。
- trend strength。
- dominant period/frequency。
- horizon/context feasibility。

输出 artifact：

- `data/quality_report.json`
- `analysis/quantitative_diagnostics.md`
- `analysis/plots/*.png`

### 5.6 SplitPlanner

职责：生成不可变 split plan。

统一 split：

- `train`
- `validation`
- `test`
- `hidden_test`

Neo-Cast 当前的 `ref_test` 应映射为 `test` 或 `reference_test`，但对外统一称为 locked test；`blind_test` 映射为 hidden_test。

TSF 默认切分：

- 禁止随机切分。
- 使用时间顺序切分。
- 默认比例：train 70%、validation 10%、test 20%；benchmark preset 可使用官方固定切分。
- 对每个 split 记录 row range 和 timestamp range。
- train/validation/test label 区间不得重叠。
- validation/test window 可以使用前一 split 尾部作为 context，但 target/label 必须完全落在自身 split。
- 所有 preprocessing fit 只允许使用 train rows。

输出 artifact：

- `data/split_plan.json`

`split_plan.json` 示例：

```json
{
  "schema_version": "split_plan.v1",
  "strategy": "chronological_fixed",
  "split_version": "split_etth1_v1",
  "context_policy": "previous_split_tail_context_allowed",
  "label_policy": "labels_must_stay_inside_split",
  "splits": {
    "train": { "row_range": [0, 12000], "visible_to_agents": true },
    "validation": { "row_range": [12000, 14000], "visible_to_agents": true },
    "test": { "row_range": [14000, 18000], "visible_to_agents": false },
    "hidden_test": { "row_range": null, "visible_to_agents": false }
  },
  "preprocessing_fit_scope": "train",
  "max_horizon": 720,
  "input_length": 96,
  "created_at": "2026-05-05T00:00:00Z"
}
```

### 5.7 LeakageAuditor

职责：在训练前、训练后和发布前检查数据泄漏。

训练前检查：

- split 是否按时间顺序。
- label window 是否跨 split。
- scaler/imputer/encoder 是否声明 `fit_scope=train`。
- future covariate 是否标记为 known at prediction time。
- target 变换是否包含未来信息。
- 是否存在 duplicate rows 跨 split。
- 是否存在 timestamp overlap。

训练后检查：

- val 显著优于 train 的异常。
- 长 horizon 反常优于短 horizon。
- horizon metrics 几乎完全相同。
- test query 次数是否超预算。
- Reflection 是否引用 test/hidden_test 结果生成下一轮候选。

输出 artifact：

- `data/leakage_audit.json`
- `governance/evaluation_firewall_audit.jsonl`

### 5.8 DataVersionRegistry

职责：把数据相关 artifact 纳入 lineage。

版本对象：

- `source_version`
- `schema_version`
- `cleaning_version`
- `split_version`
- `profile_version`
- `data_card_version`
- `firewall_policy_version`

每次变更触发新版本：

- 数据源 hash 改变。
- schema role 改变。
- timestamp/frequency policy 改变。
- missing/anomaly handling policy 改变。
- split boundary 改变。
- firewall policy 改变。

输出 artifact：

- `.neo-research/data/lineage/index.json`
- `.neo-research/data/lineage/*.json`

### 5.9 DataCardGenerator

职责：生成供人和 Agent 共用的 Data Card。

输出：

- `data/data_card.json`
- `data/data_card.md`

Data Card 必须包含：

- task id / dataset id / domain id
- source manifest reference
- schema summary
- timestamp/frequency summary
- target/covariate roles
- quality diagnostics summary
- split plan summary
- leakage audit summary
- evaluation firewall policy summary
- known risks
- recommended modeling implications

Data Analysis Agent、HypoPlanner Agent 和 Publish Agent 必须优先读取 Data Card，而不是各自重新扫描原始 CSV。

`data_card.json` 最小字段：

```json
{
  "schema_version": "data_card.v1",
  "task_id": "researchTask_...",
  "domain_id": "tsf",
  "dataset_id": "etth1",
  "source_manifest_ref": "data/source_manifest.json",
  "schema_profile_ref": "data/schema_profile.json",
  "time_index_profile_ref": "data/time_index_profile.json",
  "frequency_profile_ref": "data/frequency_profile.json",
  "quality_report_ref": "data/quality_report.json",
  "split_plan_ref": "data/split_plan.json",
  "leakage_audit_ref": "data/leakage_audit.json",
  "firewall_policy_ref": "governance/evaluation_firewall_policy.json",
  "summary": {
    "rows": 17420,
    "targets": ["OT"],
    "frequency": "hourly",
    "missing_rate": 0.0,
    "outlier_rate": 0.01,
    "split_strategy": "chronological_fixed",
    "leakage_status": "passed_with_warnings"
  },
  "modeling_implications": [
    "Use chronological validation only.",
    "Fit normalization on train split.",
    "Do not expose locked test metrics to Reflection Agent."
  ],
  "risks": [
    {
      "severity": "medium",
      "code": "distribution_shift",
      "message": "Validation period has measurable distribution shift."
    }
  ]
}
```

### 5.10 标准产物清单

每个任务完成 Data Layer 后，至少应有以下文件：

| 路径 | 类型 | 消费方 |
| --- | --- | --- |
| `data/source_manifest.json` | source contract | Data Layer, Publish |
| `data/schema_profile.json` | schema contract | Data Analysis, ModelCompiler |
| `data/time_index_profile.json` | time contract | Data Analysis, SplitPlanner |
| `data/frequency_profile.json` | frequency contract | Data Analysis, HypoPlanner |
| `data/quality_report.json` | diagnostics contract | Data Analysis, HypoPlanner |
| `data/split_plan.json` | split contract | TrainEval, Evaluation Firewall |
| `data/leakage_audit.json` | leakage contract | Verifier, Reflection, Publish |
| `data/data_card.json` | canonical machine-readable card | all downstream agents |
| `data/data_card.md` | human-readable card | TUI, Publish |
| `governance/evaluation_firewall_policy.json` | access policy | TrainEval, Reflection |
| `governance/evaluation_firewall_audit.jsonl` | access audit | Publish, governance review |

## 6. Evaluation Firewall

Evaluation Firewall 是独立治理层，不只是 approval gate。它控制：

- 哪个 Agent 能访问哪个 split。
- 哪个 Agent 能看到哪些 metric。
- test/hidden_test 查询次数。
- test/hidden_test 结果是否允许进入 Reflection 和 Memory。
- 发布报告是否满足评估隔离要求。

### 6.1 Split 访问级别

| Split | 内部名称 | 可见性 | 默认用途 |
| --- | --- | --- | --- |
| train | `train` | agent-visible | 训练、fit preprocessing、训练诊断 |
| validation | `validation` / `val` | agent-visible | 模型选择、迭代反思 |
| locked test | `test` / `ref_test` | runner-only, approved metrics | 受控里程碑评估 |
| hidden test | `hidden_test` / `blind_test` | external-only | 最终发布评估 |

### 6.2 Agent 访问矩阵

| Agent | train data/profile | val data/profile | test metrics | hidden metrics | 原始 test/hidden rows |
| --- | --- | --- | --- | --- | --- |
| Intent Agent | summary only | no | no | no | no |
| Data Analysis Agent | yes | yes | no | no | no |
| HypoPlanner Agent | summary/card | summary/card | no | no | no |
| ModelDesigner Agent | summary/card | summary/card | no | no | no |
| ModelCompiler Agent | schema/preprocess contract | schema/preprocess contract | no | no | no |
| TrainEval Agent | train/val execution | val metrics | approved, budgeted | final only | no |
| Reflection Agent | train/val metrics | val metrics | masked or final-only | no | no |
| Publish Agent | summary | summary | locked final | locked final | no |

### 6.3 Metric 暴露策略

训练迭代期间：

- 允许暴露 `train_*`、`val_*`。
- 禁止将 `test_*`、`ref_test_*` 作为 candidate ranking 的默认输入。
- 禁止将 `hidden_test_*` 进入 Memory。

里程碑评估：

- test/ref_test 需要 approval。
- test/ref_test 需要 query budget。
- test/ref_test 默认只允许 champion 或少量候选查询。
- 查询结果必须写入 audit log。

最终发布：

- hidden_test/blind_test 只能由外部 sidecar 或 runner-only service 执行。
- Publish Agent 可以读取最终 locked metrics，但不能再触发模型修改。

### 6.4 Firewall Policy

输出 artifact：

- `governance/evaluation_firewall_policy.json`

示例：

```json
{
  "schema_version": "evaluation_firewall_policy.v1",
  "policy_id": "firewall_tsf_default_v1",
  "train_visible_to_agents": true,
  "validation_visible_to_agents": true,
  "test_raw_access": "runner_only",
  "hidden_test_raw_access": "external_only",
  "test_metric_policy": {
    "requires_approval": true,
    "max_queries_per_task": 2,
    "eligible_candidates": "champion_only",
    "visible_to_reflection": "masked_summary_only"
  },
  "hidden_test_metric_policy": {
    "requires_approval": true,
    "max_queries_per_task": 1,
    "eligible_candidates": "final_champion_only",
    "visible_to_reflection": "never"
  },
  "memory_policy": {
    "allow_train_val_lessons": true,
    "allow_test_metric_lessons": false,
    "allow_hidden_test_metric_lessons": false
  }
}
```

### 6.5 Audit Log

每次评估访问必须写入：

- `task_id`
- `candidate_id`
- `run_id`
- `agent`
- `stage`
- `split`
- `metric_keys`
- `approval_id`
- `query_index`
- `reason`
- `timestamp`
- `allowed`
- `deny_reason`

输出：

- `governance/evaluation_firewall_audit.jsonl`

## 7. Pipeline 集成需求

### 7.1 新增标准阶段

建议 workflow phase：

```text
intent_gathering
intent_confirmed
data_ingestion
schema_profiled
time_frequency_profiled
quality_diagnosed
split_planned
leakage_audited
data_card_ready
data_analysis
hypo_planning
model_design
model_compile
train_eval
reflection
publish
```

Intent 确认后，必须完成 `data_card_ready`，才允许进入 `data_analysis` 和 `hypo_planning`。

### 7.2 与现有 Neo-Cast 的兼容

P0 不废弃 `dataset.v1`，而是作为 TSF adapter 的 runner-level contract。

映射关系：

- `dataset.v1` -> `split_plan.v1` + `preprocess_contract.v1`
- `*_visible.csv` -> train + validation agent-visible materialization
- `*_ref_test.csv` -> locked test runner-only materialization
- `query_ref_test` -> Evaluation Firewall 的 test query backend
- `query_blind_test` -> Evaluation Firewall 的 hidden_test backend

### 7.3 TUI 展示需求

右侧 Agent 进度中新增 Data Layer 子阶段：

```text
AutoResearch进展
  Intent Agent
  Data Layer
    Source connected
    Schema profiled
    Frequency detected
    Quality diagnosed
    Split planned
    Leakage audited
    Data Card ready
  Data Analysis Agent
  HypoPlanner Agent
  ...
```

TUI 必须展示：

- Data Card 状态。
- 当前 split policy。
- Firewall 状态：test locked / hidden locked。
- test query budget 使用量。
- 评估污染风险 warning。

## 8. CLI/API 需求

P0 CLI：

```bash
neo-cast prepare-data --source /path/to/data.csv --dataset-preset etth1 --force
neo-cast data-card --task-id etth1
neo-cast leakage-audit --task-id etth1
```

P0 opencode research API：

- `prepareTaskDataLayer(taskID)`
- `getTaskDataCard(taskID)`
- `getEvaluationFirewallStatus(taskID)`
- `requestEvaluationAccess(taskID, candidateID, split, reason)`
- `recordEvaluationQuery(taskID, candidateID, runID, split, metrics)`

P1 CLI/API：

- `research data connect`
- `research data profile`
- `research data split`
- `research data card`
- `research eval-firewall status`

## 9. 需求编号清单

### 9.1 Functional Requirements

| 编号 | 需求 | 优先级 |
| --- | --- | --- |
| FR-DL-001 | 系统必须支持从本地 CSV 和 benchmark preset 创建数据源。 | P0 |
| FR-DL-002 | 系统必须为每个数据源生成 `source_manifest.json` 和 content hash。 | P0 |
| FR-DL-003 | 系统必须自动识别列类型、timestamp 候选、target 列和 covariate 角色。 | P0 |
| FR-DL-004 | 系统必须解析 timestamp，检测无效、重复、非单调和 gap。 | P0 |
| FR-DL-005 | 系统必须识别采样频率和 irregular interval ratio。 | P0 |
| FR-DL-006 | 系统必须生成缺失值、异常值、分布漂移和低质量字段诊断。 | P0 |
| FR-DL-007 | TSF 任务必须使用时间顺序 split，禁止随机 split。 | P0 |
| FR-DL-008 | SplitPlanner 必须保证 label window 不跨 split。 | P0 |
| FR-DL-009 | 所有 preprocessing fit scope 必须默认为 train。 | P0 |
| FR-DL-010 | 系统必须生成 `data_card.json` 和 `data_card.md`。 | P0 |
| FR-DL-011 | Data Analysis Agent 必须以 Data Card 为主要输入。 | P1 |
| FR-DL-012 | Publish bundle 必须包含 Data Card、split plan 和 leakage audit。 | P1 |
| FR-EF-001 | 系统必须区分 train、validation、locked test、hidden test。 | P0 |
| FR-EF-002 | locked test 查询必须经过 approval 和 query budget。 | P0 |
| FR-EF-003 | hidden test 查询必须只允许 final champion，并需要独立 approval。 | P1 |
| FR-EF-004 | 每次 test/hidden_test 评估访问必须写入 audit log。 | P0 |
| FR-EF-005 | Reflection Agent 默认不得读取 test/hidden_test metric 明细。 | P0 |
| FR-EF-006 | Memory 默认不得写入 test/hidden_test 指标驱动的下一轮搜索经验。 | P0 |
| FR-EF-007 | Candidate ranking 默认只能使用 train/validation 证据。 | P0 |
| FR-EF-008 | Publish Agent 只能在最终发布阶段读取 locked final test/hidden metrics。 | P1 |
| FR-TUI-001 | TUI 必须展示 Data Layer 阶段状态。 | P1 |
| FR-TUI-002 | TUI 必须展示 Firewall lock 状态和 test query budget。 | P1 |

### 9.2 Non-functional Requirements

| 编号 | 需求 | 优先级 |
| --- | --- | --- |
| NFR-001 | 数据接入、切分、诊断和评估查询必须可审计。 | P0 |
| NFR-002 | 同一 source hash、taskSpec 和 split policy 应生成稳定 Data Card。 | P0 |
| NFR-003 | Data Layer artifact 必须是机器可读 JSON，并有对应 markdown 摘要。 | P0 |
| NFR-004 | P0 不应引入大型外部服务依赖，保持本地 TSF MVP 可运行。 | P0 |
| NFR-005 | Data Layer 失败时必须给出可操作错误，而不是让后续 Agent 继续运行。 | P0 |
| NFR-006 | Evaluation Firewall 的 deny reason 必须可在 TUI/API 中展示。 | P1 |

## 10. 验收标准

P0 验收：

1. 任意 TSF CSV 任务在 Intent 确认后自动生成 Data Card。
2. Data Card 包含 source、schema、timestamp、frequency、missing、outlier、split、leakage、firewall summary。
3. train/val/test 切分按时间顺序且不可重叠。
4. scaler/imputer 只能 fit train，测试中必须覆盖。
5. Data Analysis Agent 读取 Data Card，而不是重复实现一套 CSV profile。
6. ref_test 查询必须经过 approval + query budget。
7. Reflection Agent 默认不读取 ref_test/blind_test metrics。
8. Publish bundle 包含 Data Card、split plan、leakage audit、firewall audit 和 release manifest。

P1 验收：

1. TUI 展示 Data Layer 阶段和 Firewall 状态。
2. 数据诊断图表进入 artifact。
3. Data Layer 支持 local CSV、uploaded CSV、benchmark preset。
4. test/ref_test metrics 若进入报告，必须标记为 locked final evaluation。
5. Memory 只沉淀 train/val 经验，除非发布后以 final locked summary 形式归档。

P2 验收：

1. 支持 parquet、URL、SQL connector。
2. 支持自定义 split policy，但必须通过 LeakageAuditor。
3. hidden_test sidecar 可替换为外部评测服务。
4. 多领域 Data Adapter 可以复用 Core Data Layer。

## 11. 分阶段实现计划

### P0：Data Layer Contract 和 TSF Firewall

目标：先把数据契约和评估隔离做实。

任务：

- 新增 `data_layer.v1`、`data_card.v1`、`split_plan.v1`、`leakage_audit.v1`、`evaluation_firewall_policy.v1` schema。
- 在 Neo-Cast prepare-data 后生成 Data Card。
- 将现有 `dataset_profile.v1` 扩展为 Data Layer profile。
- 将 `ref_test` 查询纳入 firewall audit log。
- 在 opencode service 中把 Data Layer 阶段插入 Intent 和 Data Analysis 之间。
- 更新 tests 覆盖 train-only fit、split non-overlap、ref_test budget、Reflection metric filtering。

### P1：TUI 和 Agent 消费契约

目标：让用户能看见并信任数据层。

任务：

- TUI 右侧加入 Data Layer 子阶段。
- Data Analysis Agent 改为消费 Data Card。
- HypoPlanner Agent 的输入加入 Data Card summary。
- Publish bundle 输出 Data Card、split plan、firewall audit。
- 增加 Data Card markdown 展示。

### P2：多连接器和多领域扩展

目标：从 TSF MVP 走向 Data Science 平台能力。

任务：

- 增加 parquet/URL/SQL connector。
- 抽象 `DomainDataAdapter`。
- 增加 anomaly detection / classification 领域 split adapter。
- 支持用户自定义 split policy，但需要 human checkpoint 和 leakage audit 通过。

### P3：严格外部评测与组织级审计

目标：让 hidden_test 和发布结果达到论文/竞赛/生产审计级别。

任务：

- external blind-test sidecar 标准化。
- 支持一次性 final evaluation token。
- 支持报告中的 evaluation provenance section。
- 支持组织级数据访问审计导出。

## 12. 风险与处理

风险：Data Layer 过重，影响 TSF MVP 迭代速度。  
处理：P0 只做 TSF local CSV + benchmark preset，保留扩展接口。

风险：test/ref_test 被完全锁住后，用户难以判断泛化能力。  
处理：允许少量 approval + budgeted locked test query，但禁止其进入下一轮自动搜索。

风险：Data Analysis Agent 与 Data Layer 职责重叠。  
处理：Data Layer 产出事实和诊断；Data Analysis Agent 负责解释、建模启发和实验建议。

风险：历史 Memory 已包含 test 指标。  
处理：新增 Memory scope 和 metric source 标记，后续 ranker 默认过滤 test/hidden metric。

## 13. 研发优先级

建议优先级：

1. P0-1：Data Card schema 和生成器。
2. P0-2：SplitPlanner + LeakageAuditor。
3. P0-3：Evaluation Firewall policy + audit log。
4. P0-4：Service pipeline 接入 Data Layer。
5. P0-5：Reflection/Memory metric filtering。
6. P1-1：TUI Data Layer/Firewall 展示。
7. P1-2：Publish bundle 完整数据产物。

这条路径能最小化改造风险：先把现有 Neo-Cast 的 `dataset.v1`、`ref_test` 和 opencode 的 approval gate 统一起来，再逐步增强 UI、连接器和多领域能力。
