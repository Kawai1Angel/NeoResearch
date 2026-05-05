## NeoResearch工作流设计

> **IntentScope Agent → Literature Search Agent → DataDiagnoser Agent → HypoPlanner Agent → ModelDesigner Agent → ModelCompiler → TrainEval Agent → Reflector Agent → ResultPublisher Agent**

> **需求定界 → 文献研读 → 数据诊断 → 假设规划 → 模型设计 → 模型编译 → 训练评估 → 反思优化 → 结果发布**

下面给一版可以直接写入 **NeoResearch（智多星）系统设计文档** 的 **Agent 输入输出协议（Agent I/O Protocol）**。核心原则是：**Agent 不直接共享完整上下文，而是通过标准化研究产物进行交接**。每个 Agent 都应明确“读取什么、生成什么、交给谁、如何被验证”。

------

### NeoResearch agent I/O protocol

NeoResearch 中每个 Agent 都遵循统一的 Artifact Protocol。所有 Agent 的输入不是完整对话历史，而是来自共享工作区的结构化文件；所有 Agent 的输出也不只是自然语言，而是可被下游 Agent 读取、验证和复现的研究产物。每个 Agent 完成后，都需要生成 `handoff_capsule.yaml` 和 `agent_output_manifest.yaml`，用于说明本阶段完成了什么、生成了哪些文件、关键结论是什么、下游模块应重点读取什么。

统一输入协议可以定义为：

```yaml
agent_input:
  task_id: string
  current_stage: string
  input_artifacts:
    - path: string
      type: string
      required: true
  runtime_state:
    interaction_mode: socratic | cognitive_copilot
    budget:
      max_trials: int
      max_training_hours: float
      max_model_params: string
    approval_policy:
      require_user_approval: bool
  constraints:
    - string
  expected_outputs:
    - path: string
```

统一输出协议可以定义为：

```yaml
agent_output:
  task_id: string
  stage: string
  status: success | partial_success | failed
  output_artifacts:
    - path: string
      type: string
      description: string
  key_findings:
    - string
  evidence:
    - artifact_path: string
      summary: string
  risks:
    - string
  confidence: high | medium | low
  next_stage: string
  handoff_summary: string
```

------

## 1. IntentScope Agent

**定位：** 将用户模糊需求转化为结构化数据科学任务说明。该 Agent 是 NeoResearch 的入口模块，负责明确研究目标、任务边界、数据条件、评价指标、预算约束和交付要求。

| 项目     | 内容                                                         |
| -------- | ------------------------------------------------------------ |
| 输入     | 用户自然语言需求、上传数据基本信息、用户选择的交互模式、领域背景信息 |
| 输出     | `task_spec.yaml`、`intent.md`、`user_constraints.yaml`、`research_brief.md` |
| 下游     | Literature Search Agent、DataDiagnoser Agent                 |
| 验证重点 | 任务目标是否清楚，预测对象、预测窗口、评价指标、约束和交付物是否完整 |

推荐输出协议：

```yaml
task_spec:
  task_id: "tsf_energy_001"
  task_type: "time_series_forecasting"
  domain: "electric_load_forecasting"
  target_column: "load"
  time_column: "timestamp"
  frequency: "hourly"
  history_window: 96
  prediction_horizon: 24
  metrics:
    - "mae"
    - "mse"
  constraints:
    max_model_params: "5M"
    max_training_hours: 3
    prefer_lightweight_model: true
  interaction_mode: "cognitive_copilot"
  deliverables:
    report: true
    model_code: true
    checkpoint: true
    inference_api: true
```

`intent.md` 负责记录自然语言版本的需求说明，包括用户目标、业务背景、重要约束和期望输出。`user_constraints.yaml` 记录硬约束，例如预算、模型规模、运行时间、可解释性需求和部署限制。

------

## 2. Literature Search Agent

**定位：** 围绕当前任务主动检索、阅读和提炼文献知识，将外部科研知识转化为当前任务可用的假设来源、模型设计启发和实验参考。

| 项目     | 内容                                                         |
| -------- | ------------------------------------------------------------ |
| 输入     | `task_spec.yaml`、`research_brief.md`、可选 `domain_card.yaml` |
| 输出     | `literature_review.md`、`knowledge_cards.jsonl`、`search_log.json`、`knowledge_injection_brief.md` |
| 下游     | HypoPlanner Agent、ModelDesigner Agent、ResultPublisher Agent |
| 验证重点 | 文献是否相关，知识是否结构化，是否区分“论文 claim”和“可验证假设” |

推荐知识卡片协议：

```json
{
  "paper_id": "paper_001",
  "title": "A lightweight model for long-term time series forecasting",
  "problem": "long-term time series forecasting",
  "core_method": "decomposition-based lightweight temporal model",
  "useful_idea": "separate trend and seasonal components before forecasting",
  "applicable_scenario": "strong seasonality and limited model budget",
  "possible_integration": "use decomposition block in Model Recipe",
  "limitations": "may not handle abrupt distribution shift well",
  "evidence_level": "reported_experiment",
  "relevance_to_task": "high"
}
```

`knowledge_injection_brief.md` 是给 HypoPlanner 和 ModelDesigner 的简短知识摘要，重点回答：哪些文献思想值得转化为假设？哪些模型组件值得尝试？哪些实验设置可以参考？哪些风险需要避免？

------

## 3. DataDiagnoser Agent

**定位：** 面向建模的数据诊断，不只是做 EDA，而是识别数据质量、统计规律、语义风险和建模难点，为假设生成提供证据。

| 项目     | 内容                                                         |
| -------- | ------------------------------------------------------------ |
| 输入     | `task_spec.yaml`、原始数据路径、数据 schema、可选 `domain_card.yaml`、可选文献摘要 |
| 输出     | `data_profile.json`、`data_semantic_schema.yaml`、`quant_diagnosis.md`、`qual_diagnosis.md`、`modeling_risks.md`、`modeling_insights.md`、`data_diagnosis_report.md` |
| 下游     | HypoPlanner Agent、ModelDesigner Agent                       |
| 验证重点 | 是否正确识别时间列、目标列、协变量类型、缺失、异常、周期、漂移和数据泄漏风险 |

推荐输出协议：

```yaml
data_profile:
  num_samples: 35040
  frequency: "hourly"
  target_column: "load"
  missing_ratio: 0.012
  anomaly_ratio: 0.018
  trend_strength: "medium"
  seasonality:
    daily: "strong"
    weekly: "strong"
  stationarity: "non_stationary"
  distribution_shift: "moderate"
  covariate_relationships:
    temperature:
      correlation: 0.62
      lag_effect: "possible"
```

数据语义协议：

```yaml
data_semantic_schema:
  target_variable:
    - "load"
  observed_covariates:
    - "historical_temperature"
  known_future_covariates:
    - "holiday_flag"
    - "hour_of_day"
    - "day_of_week"
  static_covariates:
    - "region_id"
  leakage_risk_variables:
    - "future_observed_load"
```

`modeling_insights.md` 应该明确写出对后续建模有用的结论，例如“存在强日周期和周周期，建议优先验证多尺度周期建模假设”；`modeling_risks.md` 应该记录数据泄漏、分布漂移、样本不足、异常点过多等风险。

------

## 4. HypoPlanner Agent

**定位：** 连接文献知识、数据诊断与模型设计。它负责提出可验证的研究假设，并将假设转化为实验规划和 To-do List。

| 项目     | 内容                                                         |
| -------- | ------------------------------------------------------------ |
| 输入     | `task_spec.yaml`、`knowledge_injection_brief.md`、`data_diagnosis_report.md`、`modeling_insights.md`、`modeling_risks.md` |
| 输出     | `hypotheses.md`、`hypothesis_objects.yaml`、`experiment_plan.yaml`、`research_todo.yaml` |
| 下游     | ModelDesigner Agent、TrainEval Agent、Reflector Agent        |
| 验证重点 | 假设是否可验证，实验计划是否可执行，是否符合预算和任务目标   |

推荐假设对象协议：

```yaml
hypotheses:
  - hypothesis_id: "H1"
    statement: "Multi-scale seasonality modeling can improve forecasting accuracy."
    motivation:
      - "DataDiagnoser found strong daily and weekly seasonality."
      - "Literature suggests decomposition-based models are useful for seasonal data."
    expected_effect: "lower MAE and MSE on validation set"
    verification_plan:
      baseline: "simple_tcn"
      proposed_variant: "multiscale_decomposition_tcn"
      ablation:
        - "remove_decomposition"
        - "remove_multiscale_block"
    priority: "high"
    risk: "seasonality may be unstable under distribution shift"
    confidence: "medium"
```

实验计划协议：

```yaml
experiment_plan:
  objective: "verify seasonality-aware lightweight forecasting model"
  runs:
    - run_id: "run_001"
      purpose: "baseline"
      model_recipe: "baseline_tcn"
    - run_id: "run_002"
      purpose: "test H1"
      model_recipe: "multiscale_decomposition_tcn"
  budget:
    max_trials: 10
    max_training_hours: 3
  stop_condition:
    no_improvement_rounds: 3
    target_improvement_over_baseline: 0.05
```

------

## 5. ModelDesigner Agent

**定位：** 根据研究假设和实验计划生成结构化模型配方，而不是直接自由生成完整代码。它的核心输出是 `model_recipe.yaml`。

| 项目     | 内容                                                         |
| -------- | ------------------------------------------------------------ |
| 输入     | `task_spec.yaml`、`hypothesis_objects.yaml`、`experiment_plan.yaml`、`data_profile.json`、`data_semantic_schema.yaml` |
| 输出     | `model_recipe.yaml`、`model_design_rationale.md`、`component_selection.yaml` |
| 下游     | ModelCompiler                                                |
| 验证重点 | 模型配方是否结构化，组件是否可用，是否符合输入输出维度、预算和任务约束 |

推荐模型配方协议：

```yaml
model_recipe:
  recipe_id: "recipe_002"
  model_name: "MultiScaleTinyForecaster"
  task_type: "time_series_forecasting"
  linked_hypothesis:
    - "H1"
  input:
    history_window: 96
    prediction_horizon: 24
    target_dim: 1
    observed_covariates: true
    known_future_covariates: true
  architecture:
    preprocessing:
      normalization: "reversible_instance_norm"
      decomposition: "moving_average"
    backbone:
      type: "temporal_convolution"
      hidden_dim: 64
      num_layers: 3
    modules:
      multiscale_blocks: 3
      covariate_fusion: "gated_fusion"
      attention: "lightweight_temporal_attention"
    output_head:
      type: "direct_multi_step_forecasting"
  training:
    loss: "mse"
    optimizer: "adamw"
    learning_rate: 0.001
    batch_size: 64
    epochs: 30
  constraints:
    max_model_params: "5M"
    latency_sensitive: true
```

`model_design_rationale.md` 需要解释模型为什么这样设计，并明确每个组件对应哪个假设或数据诊断证据。

------

## 6. ModelCompiler

**定位：** 将 ModelDesigner 生成的结构化模型配方编译为可运行、可测试、可复现的模型工程。严格来说，ModelCompiler 可以是一个确定性系统模块，也可以包含 LLM 辅助，但不建议完全依赖自由生成。

| 项目     | 内容                                                         |
| -------- | ------------------------------------------------------------ |
| 输入     | `model_recipe.yaml`、`component_selection.yaml`、`task_spec.yaml`、`data_profile.json` |
| 输出     | `compiled_model/`、`compile_report.md`、`unit_test_results.json`、`compile_manifest.yaml` |
| 下游     | TrainEval Agent                                              |
| 验证重点 | 代码能否运行，输入输出维度是否正确，是否通过 one-batch smoke test |

推荐输出目录：

```text
compiled_model/
├── model.py
├── config.yaml
├── dataloader.py
├── train.py
├── evaluate.py
├── inference.py
├── requirements.txt
├── unit_tests/
│   ├── test_forward_shape.py
│   ├── test_dataloader.py
│   └── test_one_batch_train.py
├── unit_test_results.json
└── compile_report.md
```

编译报告协议：

```yaml
compile_report:
  recipe_id: "recipe_002"
  compile_status: "success"
  generated_files:
    - "model.py"
    - "train.py"
    - "evaluate.py"
    - "inference.py"
  tests:
    forward_shape_test: "passed"
    dataloader_test: "passed"
    one_batch_train_test: "passed"
  estimated_params: 1250000
  warnings:
    - "covariate fusion assumes known future covariates are available"
```

------

## 7. TrainEval Agent

**定位：** 负责正式训练、评估、结果记录和实验管理。它不应修改模型设计逻辑，只应按照编译后的模型工程和实验计划执行训练评估。

| 项目     | 内容                                                         |
| -------- | ------------------------------------------------------------ |
| 输入     | `compiled_model/`、`experiment_plan.yaml`、`task_spec.yaml`、训练/验证/测试数据路径 |
| 输出     | `experiment_runs/`、`metrics.csv`、`training_log_summary.md`、`checkpoints/`、`prediction_outputs.csv` |
| 下游     | Reflector Agent、ResultPublisher Agent                       |
| 验证重点 | 数据切分是否正确，指标计算是否正确，实验是否可复现，是否遵守预算 |

推荐实验运行协议：

```yaml
experiment_run:
  run_id: "run_002"
  recipe_id: "recipe_002"
  linked_hypothesis:
    - "H1"
  dataset_version: "v1"
  split:
    train: "2021-01-01 to 2022-12-31"
    val: "2023-01-01 to 2023-06-30"
    test: "protected"
  seed: 42
  metrics:
    val_mae: 0.214
    val_mse: 0.087
  checkpoint_path: "checkpoints/run_002/best.pt"
  status: "completed"
```

`metrics.csv` 应该统一记录所有实验的主指标、模型规模、训练时间和相对 baseline 提升。`training_log_summary.md` 应该总结训练是否稳定、是否过拟合、是否早停、是否出现异常。

------

## 8. Reflector Agent

**定位：** 基于实验结果、训练日志和研究假设进行反思，判断假设是否成立，并提出下一轮迭代方向。

| 项目     | 内容                                                         |
| -------- | ------------------------------------------------------------ |
| 输入     | `hypothesis_objects.yaml`、`experiment_plan.yaml`、`metrics.csv`、`training_log_summary.md`、`prediction_outputs.csv` |
| 输出     | `reflection.md`、`hypothesis_verification.yaml`、`next_iteration_plan.yaml`、`failure_analysis.md` |
| 下游     | ModelDesigner Agent、HypoPlanner Agent、ResultPublisher Agent |
| 验证重点 | 反思是否基于实验结果，是否避免无证据推断，下一轮计划是否可执行 |

推荐假设验证协议：

```yaml
hypothesis_verification:
  - hypothesis_id: "H1"
    status: "partially_supported"
    evidence:
      - "run_002 improves val_mae by 6.8% over run_001"
      - "ablation without multiscale block reduces improvement"
    limitations:
      - "test set has not been used yet"
      - "distribution shift period remains challenging"
    decision: "keep multiscale module and test drift adaptation next"
    confidence: "medium"
```

下一轮计划协议：

```yaml
next_iteration_plan:
  action: "revise_model_recipe"
  reason: "model performs poorly during distribution-shift periods"
  suggested_changes:
    - "add drift-aware normalization"
    - "increase robustness evaluation"
  priority: "high"
  requires_user_approval: true
```

Reflector Agent 的输出不能只是“模型还可以优化”，而应明确失败类型、证据来源、修复建议和是否需要回退到前序阶段。

------

## 9. ResultPublisher Agent

**定位：** 将代码、参数、实验结果、实验过程和研究结论整理为完整研究交付包。它是 NeoResearch 从自动实验走向可复现研究发布的关键模块。

| 项目     | 内容                                                         |
| -------- | ------------------------------------------------------------ |
| 输入     | `task_spec.yaml`、`literature_review.md`、`data_diagnosis_report.md`、`hypotheses.md`、`model_recipe.yaml`、`compile_report.md`、`metrics.csv`、`reflection.md`、最优模型代码和 checkpoint |
| 输出     | `final_report.md/pdf`、`README.md`、`model_card.md`、`artifact_manifest.json`、`api_schema.yaml`、发布包目录 |
| 下游     | 用户、上层 Agent、模型调用系统                               |
| 验证重点 | 报告是否完整，产物是否可复现，模型接口是否清楚，结论是否有证据链 |

推荐发布包目录：

```text
release/
├── final_report.md
├── final_report.pdf
├── README.md
├── model_card.md
├── artifact_manifest.json
├── api_schema.yaml
├── model/
│   ├── model.py
│   ├── checkpoint.pt
│   └── config.yaml
├── scripts/
│   ├── train.py
│   ├── evaluate.py
│   └── inference.py
├── results/
│   ├── metrics.csv
│   └── prediction_outputs.csv
└── logs/
    ├── training_log_summary.md
    └── agent_trace.json
```

发布清单协议：

```json
{
  "task_id": "tsf_energy_001",
  "release_version": "v1.0",
  "best_model": {
    "recipe_id": "recipe_002",
    "checkpoint": "model/checkpoint.pt",
    "config": "model/config.yaml"
  },
  "main_results": {
    "val_mae": 0.214,
    "val_mse": 0.087,
    "improvement_over_baseline": "6.8%"
  },
  "reproducibility": {
    "seed": 42,
    "dataset_version": "v1",
    "environment": "requirements.txt"
  },
  "interfaces": {
    "inference_script": "scripts/inference.py",
    "api_schema": "api_schema.yaml"
  },
  "reports": {
    "final_report": "final_report.md",
    "model_card": "model_card.md"
  }
}
```

`model_card.md` 应该说明模型适用场景、输入输出格式、性能指标、限制条件和风险提示。`api_schema.yaml` 应该服务于上层 Agent 调用。

------

### 总体交接链路

NeoResearch 的完整 I/O 链路可以概括为：

```text
User Request
  ↓
IntentScope Agent
  outputs: task_spec.yaml, intent.md
  ↓
Literature Search Agent
  outputs: literature_review.md, knowledge_cards.jsonl
  ↓
DataDiagnoser Agent
  outputs: data_profile.json, data_diagnosis_report.md
  ↓
HypoPlanner Agent
  outputs: hypotheses.md, experiment_plan.yaml
  ↓
ModelDesigner Agent
  outputs: model_recipe.yaml, model_design_rationale.md
  ↓
ModelCompiler
  outputs: compiled_model/, compile_report.md
  ↓
TrainEval Agent
  outputs: metrics.csv, checkpoints/, training_log_summary.md
  ↓
Reflector Agent
  outputs: reflection.md, next_iteration_plan.yaml
  ↓
ResultPublisher Agent
  outputs: final_report.md, model_card.md, artifact_manifest.json
```

这套协议的核心价值在于：**每个 Agent 都不是随意生成文本，而是在一个受控的 Research Object 流程中生产可验证、可复现、可交接的研究产物。**

可以将这一设计总结为一句话：

> **NeoResearch organizes autonomous data science research through explicit artifact contracts: each Agent consumes structured research objects, produces verified artifacts, and hands off compact evidence-grounded context to the next stage.**

中文可以写成：

> **NeoResearch 通过显式产物协议组织自主数据科学研究：每个 Agent 读取结构化研究对象，生成经过验证的研究产物，并将基于证据的紧凑上下文交接给下一阶段。**



## 1. Task DSL：把研究任务形式化

NeoResearch 不应只依赖自然语言描述任务。用户需求经过 IntentScope Agent 澄清后，最好转化为一个结构化的 **Task DSL / Task Spec**。例如：

```
task_type: time_series_forecasting
target_column: load
history_window: 96
prediction_horizon: 24
frequency: hourly
metrics:
  - mse
  - mae
constraints:
  max_model_params: 5M
  max_training_hours: 3
  prefer_lightweight_model: true
output:
  report: true
  model_code: true
  checkpoint: true
```

这个 Task Spec 是后续所有 Agent 的“任务合同”。它能减少歧义，也方便 Runtime 检查每个阶段是否偏离目标。

## 2. Environment contract：明确 Agent 能做什么、不能做什么

Harness Engineering 的关键不是“让 Agent 自由行动”，而是给 Agent 一个边界清楚的环境。NeoResearch 应该定义每个 Agent 的权限范围。例如：

IntentScope Agent 可以读用户输入、写任务说明；DataDiagnoser Agent 可以读数据、运行统计诊断，但不能修改原始数据；ModelDesigner Agent 可以生成模型代码，但不能直接启动大规模训练；TrainEval Agent 可以运行实验，但必须受预算约束；ResultPublisher Agent 可以生成报告，但不能自动公开发布，除非用户确认。

这可以形成一个 **Agent Capability Matrix**：

| Agent           | 可读            | 可写         | 可执行       | 需要确认的操作   |
| --------------- | --------------- | ------------ | ------------ | ---------------- |
| IntentScope     | 用户需求        | task spec    | 无           | 任务边界确认     |
| DataDiagnoser   | 数据、task spec | 诊断报告     | 统计工具     | 数据切分策略     |
| HypoPlanner     | 诊断、文献      | 假设、计划   | 无           | 高成本实验计划   |
| ModelDesigner   | 假设、计划      | 模型代码     | 单元测试     | 覆盖已有模型代码 |
| TrainEval       | 模型、数据      | 结果、日志   | 训练评估     | 长时间训练       |
| Reflector       | 结果、日志      | 反思报告     | 少量验证实验 | 大方向调整       |
| ResultPublisher | 全部产物        | 报告、发布包 | 打包导出     | 对外发布         |

这会让 NeoResearch 更安全、更稳定，也更像一个真实产品。

## 3. Dataset and evaluation guardrail：防止数据泄漏和评估污染

这是 TSF 自动研究系统里非常容易忽视的问题。NeoResearch 如果自动切分数据、自动调参、自动反思，很容易出现数据泄漏、验证集过拟合、测试集反复使用等问题。

建议 Runtime 明确区分：

```
train set
validation set
test set
hidden test set
```

并规定：ModelDesigner 和 TrainEval 可以基于训练集和验证集迭代；Reflector 可以看验证结果；最终测试集只能在结果发布前调用有限次数。否则 NeoResearch 很可能“自动优化到测试集”，这在科研上会有风险。

可以设置一个 **Evaluation Firewall**：

> 测试集不是普通工具资源，而是受保护的评估环境。

这对 FutureCast 这类 Benchmark 也很重要。

## 4. Code harness：生成代码必须能测试、能复现、能回滚

ModelDesigner Agent 生成的小模型代码不能直接进入训练阶段。中间应该有 Code Harness：

```
代码生成 → 静态检查 → 单元测试 → 输入输出维度测试 → 小样本 smoke test → 正式训练
```

尤其是 TSF 模型，很容易出现维度错位、窗口切分错误、多变量输入输出不匹配、预测长度不一致等问题。建议每个模型都必须通过：

```
forward shape test
data loader test
loss computation test
one-batch training test
inference output test
```

这样 TrainEval Agent 才不会被大量低级错误拖垮。

## 7. Research trace：记录“为什么这样做”

NeoResearch 的价值不只是产出模型，而是产出一条可审计的研究轨迹。因此 Harness 需要记录每个关键决策的原因。

例如：

```
{
  "decision": "use multi-scale temporal convolution",
  "made_by": "ModelDesigner Agent",
  "evidence": [
    "DataDiagnoser found strong daily and weekly seasonality",
    "HypoPlanner proposed multi-scale periodic modeling hypothesis"
  ],
  "expected_effect": "improve long-horizon forecasting stability",
  "verification_plan": "compare with baseline and single-scale model"
}
```

这类 trace 会让 ResultPublisher Agent 最后生成报告时更有依据，也让用户知道 NeoResearch 不是“凭空造模型”。

## 8. Stop condition：定义什么时候停止探索

自主研究系统很容易陷入无限迭代。NeoResearch 必须定义停止条件，例如：

```
达到最大实验次数
达到最大训练预算
连续若干轮无提升
当前模型已超过 baseline 目标
假设验证完成
用户要求停止
结果已经足够交付
```

否则 Agent 会不断提出新想法、新模型、新实验，导致成本失控。

建议 HypoPlanner 和 Reflector 都必须受 budget 限制。Reflector 不能无限提出“再试一个”。

## 9. Human checkpoint：把用户确认设计成 Runtime 机制

你提出的两种模式非常重要。Harness 层面要支持不同级别的 human checkpoint。

苏格拉底式模式可以是：

```
任务确认一次 → 后续自主执行 → 最终结果确认
```

认知伴随式模式可以是：

```
任务确认
数据诊断确认
假设确认
模型方案确认
实验预算确认
结果发布确认
```

这里关键是：用户确认不是聊天，而是 Runtime 状态迁移条件。例如用户确认模型方案后，系统才从 `model_design_pending_approval` 进入 `train_eval_running`。



### Verification layer：每个阶段都要有 Verifier

NeoResearch 不能只相信 Agent 输出。每个关键阶段都应该有 Verifier 进行检查。

例如：

| 阶段            | 需要验证什么                             |
| --------------- | ---------------------------------------- |
| IntentScope     | 任务目标、预测窗口、指标、约束是否完整   |
| DataDiagnoser   | 数据统计是否正确，是否存在数据泄漏       |
| HypoPlanner     | 假设是否可验证，实验计划是否可执行       |
| ModelDesigner   | 模型代码是否能运行，输入输出维度是否匹配 |
| TrainEval       | 指标计算是否正确，训练过程是否异常       |
| Reflector       | 反思是否基于证据，是否过度解释           |
| ResultPublisher | 报告是否包含代码、参数、结果和复现说明   |

这个设计非常重要。因为 autonomous research agent 最大的问题之一是“看起来很合理，但实际不可执行或不可复现”。Verifier 可以把系统从“语言生成”拉回“证据闭环”。

可以形成一个核心原则：

> **No artifact should enter the next stage without verification.**

中文可以写成：

> **任何研究产物在进入下一阶段前，都需要经过结构化验证。**





