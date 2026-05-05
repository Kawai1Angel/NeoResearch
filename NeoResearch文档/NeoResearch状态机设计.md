**NeoResearch（智多星）各 Agent 的状态机设计**。核心思想是：每个 Agent 都不是一次性 Prompt 调用，而是一个具有 **输入检查、执行、验证、失败恢复、产物交接** 的小型状态机；NeoResearch Runtime 则作为全局调度器，把这些 Agent 状态机组织成一个可回退、可迭代、可审计的自主研究流程。

------

# NeoResearch agent state machine design

NeoResearch 的状态机可以分为两层：第一层是 **全局研究流程状态机**，负责管理整个项目从任务创建到结果发布的阶段流转；第二层是 **单个 Agent 内部状态机**，负责管理每个 Agent 在本阶段的输入读取、任务执行、输出验证和产物交接。两层状态机共同保证 NeoResearch 不是简单的 Agent 串联，而是一个可执行、可恢复、可复现的 autonomous research workflow。

------

## 1. 全局研究流程状态机

NeoResearch 的全局流程可以设计为：

```text
PROJECT_CREATED
  ↓
INTENT_SCOPING
  ↓
LITERATURE_SEARCH
  ↓
DATA_DIAGNOSIS
  ↓
HYPOTHESIS_PLANNING
  ↓
MODEL_DESIGN
  ↓
MODEL_COMPILE
  ↓
TRAIN_EVAL
  ↓
REFLECTION
  ↓
[ITERATE or PUBLISH]
  ↓
RESULT_PUBLISHING
  ↓
PROJECT_COMPLETED
```

其中，`REFLECTION` 是最重要的分叉点。Reflector Agent 会根据实验结果判断下一步是返回 `HYPOTHESIS_PLANNING`、返回 `MODEL_DESIGN`、返回 `MODEL_COMPILE`、继续 `TRAIN_EVAL`，还是进入 `RESULT_PUBLISHING`。

可以将全局状态机设计为：

| 全局状态              | 说明               | 进入条件                   | 退出条件                                               |
| --------------------- | ------------------ | -------------------------- | ------------------------------------------------------ |
| `PROJECT_CREATED`     | 创建项目工作区     | 用户发起任务               | 初始化 `project_state.yaml`                            |
| `INTENT_SCOPING`      | 需求澄清与任务定界 | 用户输入初始需求           | 生成并验证 `task_spec.yaml`                            |
| `LITERATURE_SEARCH`   | 文献检索与知识注入 | 任务边界明确               | 生成 `knowledge_cards.jsonl` 与 `literature_review.md` |
| `DATA_DIAGNOSIS`      | 数据诊断           | 数据可读取，任务定义清楚   | 生成 `data_diagnosis_report.md`                        |
| `HYPOTHESIS_PLANNING` | 假设提出与实验规划 | 有任务、文献、数据诊断证据 | 生成 `hypotheses.md` 与 `experiment_plan.yaml`         |
| `MODEL_DESIGN`        | 模型配方设计       | 假设与实验计划通过验证     | 生成 `model_recipe.yaml`                               |
| `MODEL_COMPILE`       | 模型编译           | 模型配方合法               | 生成可运行 `compiled_model/`                           |
| `TRAIN_EVAL`          | 训练评估           | 编译模型通过 smoke test    | 生成 `metrics.csv`、checkpoint、logs                   |
| `REFLECTION`          | 反思与迭代决策     | 至少完成一轮实验           | 决定迭代、回退或发布                                   |
| `RESULT_PUBLISHING`   | 结果发布           | 实验结论足够支撑交付       | 生成 release package                                   |
| `PROJECT_COMPLETED`   | 项目完成           | 发布包验证通过             | 归档项目                                               |

同时需要设计几个横向状态：

| 横向状态              | 说明                                 |
| --------------------- | ------------------------------------ |
| `PAUSED_FOR_APPROVAL` | 等待用户确认，常见于认知伴随式模式   |
| `RECOVERING`          | 出现错误后进入恢复状态               |
| `FAILED`              | 超过重试次数或关键产物无法生成       |
| `CANCELLED`           | 用户主动终止                         |
| `BUDGET_EXHAUSTED`    | 实验预算耗尽，进入发布或请求用户决策 |

------

## 2. 通用 Agent 内部状态机

每个 Agent 都可以遵循一套统一的内部生命周期：

```text
IDLE
  ↓
INITIALIZING
  ↓
LOAD_CONTEXT
  ↓
VALIDATE_INPUTS
  ↓
PLAN_ACTIONS
  ↓
EXECUTE
  ↓
VALIDATE_OUTPUTS
  ↓
WRITE_ARTIFACTS
  ↓
GENERATE_HANDOFF
  ↓
COMPLETED
```

失败时统一进入：

```text
ERROR_DETECTED
  ↓
RECOVER_OR_RETRY
  ↓
[RETRY EXECUTE / REQUEST_USER_INPUT / FALLBACK / FAILED]
```

通用状态说明如下：

| 状态               | 含义                                                     |
| ------------------ | -------------------------------------------------------- |
| `IDLE`             | Agent 未启动，等待 Runtime 调度                          |
| `INITIALIZING`     | 初始化 Agent 配置、权限、工作目录                        |
| `LOAD_CONTEXT`     | 从共享工作区读取必要 artifact                            |
| `VALIDATE_INPUTS`  | 检查输入是否完整、格式是否正确、是否满足运行条件         |
| `PLAN_ACTIONS`     | 生成本阶段内部执行计划                                   |
| `EXECUTE`          | 执行核心任务，例如检索文献、诊断数据、设计模型、训练评估 |
| `VALIDATE_OUTPUTS` | 验证输出是否合格                                         |
| `WRITE_ARTIFACTS`  | 写入标准化研究产物                                       |
| `GENERATE_HANDOFF` | 生成交接摘要和下游读取提示                               |
| `COMPLETED`        | 当前 Agent 阶段完成                                      |
| `ERROR_DETECTED`   | 出现错误或输出不合格                                     |
| `RECOVER_OR_RETRY` | 尝试修复、重试、降级或请求用户介入                       |
| `FAILED`           | 当前 Agent 无法完成任务                                  |

这套通用状态机可以让每个 Agent 的执行过程可观测、可恢复、可审计。

------

# 3. IntentScope Agent 状态机

**职责：** 需求澄清、任务定界、生成结构化任务说明。

```text
IDLE
  ↓
COLLECT_USER_REQUEST
  ↓
ELICIT_REQUIREMENTS
  ↓
DRAFT_TASK_SPEC
  ↓
CHECK_COMPLETENESS
  ↓
USER_CONFIRMATION? 
  ↓
WRITE_INTENT_ARTIFACTS
  ↓
GENERATE_HANDOFF
  ↓
COMPLETED
```

| 状态                     | 作用                                             | 主要产物                                                  |
| ------------------------ | ------------------------------------------------ | --------------------------------------------------------- |
| `COLLECT_USER_REQUEST`   | 收集用户初始需求、数据说明和交互模式             | raw request                                               |
| `ELICIT_REQUIREMENTS`    | 通过苏格拉底式提问澄清目标、约束、指标、预测窗口 | requirement notes                                         |
| `DRAFT_TASK_SPEC`        | 将自然语言需求转化为结构化任务说明               | `task_spec.yaml`                                          |
| `CHECK_COMPLETENESS`     | 检查目标列、时间列、预测窗口、指标、预算是否完整 | validation result                                         |
| `USER_CONFIRMATION`      | 认知伴随式模式下请求用户确认任务边界             | approval record                                           |
| `WRITE_INTENT_ARTIFACTS` | 写入需求产物                                     | `intent.md`、`research_brief.md`、`user_constraints.yaml` |
| `GENERATE_HANDOFF`       | 生成交接摘要                                     | `handoff_capsule.yaml`                                    |

关键转移条件：

```text
如果 task_spec 完整 → 进入 WRITE_INTENT_ARTIFACTS
如果缺少关键信息 → 回到 ELICIT_REQUIREMENTS
如果用户选择认知伴随式 → 进入 USER_CONFIRMATION
如果用户拒绝任务定义 → 回到 DRAFT_TASK_SPEC
```

------

# 4. Literature Search Agent 状态机

**职责：** 自主检索、阅读和提炼文献知识。

```text
IDLE
  ↓
LOAD_TASK_SPEC
  ↓
BUILD_SEARCH_QUERIES
  ↓
SEARCH_SOURCES
  ↓
SCREEN_RESULTS
  ↓
READ_AND_EXTRACT
  ↓
DISTILL_KNOWLEDGE
  ↓
VERIFY_RELEVANCE
  ↓
WRITE_KNOWLEDGE_ARTIFACTS
  ↓
GENERATE_HANDOFF
  ↓
COMPLETED
```

| 状态                        | 作用                                     | 主要产物                                               |
| --------------------------- | ---------------------------------------- | ------------------------------------------------------ |
| `BUILD_SEARCH_QUERIES`      | 根据任务、领域、数据特征生成检索 query   | `search_queries.json`                                  |
| `SEARCH_SOURCES`            | 检索论文、开源项目、benchmark、技术报告  | `search_log.json`                                      |
| `SCREEN_RESULTS`            | 筛选高相关、高质量文献                   | candidate papers                                       |
| `READ_AND_EXTRACT`          | 阅读并抽取方法、数据集、实验设置、局限性 | paper notes                                            |
| `DISTILL_KNOWLEDGE`         | 将文献内容转化为知识卡片                 | `knowledge_cards.jsonl`                                |
| `VERIFY_RELEVANCE`          | 判断知识是否适用于当前任务               | relevance scores                                       |
| `WRITE_KNOWLEDGE_ARTIFACTS` | 写入文献综述和知识摘要                   | `literature_review.md`、`knowledge_injection_brief.md` |

关键转移条件：

```text
如果检索结果不足 → 回到 BUILD_SEARCH_QUERIES，扩大 query
如果文献相关性低 → 回到 SCREEN_RESULTS
如果知识可转化为假设来源 → 进入 WRITE_KNOWLEDGE_ARTIFACTS
如果无法联网或检索失败 → 生成 partial_success，并允许流程继续
```

------

# 5. DataDiagnoser Agent 状态机

**职责：** 进行面向建模的数据诊断，生成数据证据。

```text
IDLE
  ↓
LOAD_DATA_AND_TASK_SPEC
  ↓
INFER_SCHEMA
  ↓
BUILD_DATA_SEMANTICS
  ↓
CHECK_DATA_QUALITY
  ↓
RUN_QUANT_DIAGNOSIS
  ↓
RUN_QUAL_DIAGNOSIS
  ↓
CHECK_LEAKAGE_AND_RISKS
  ↓
SUMMARIZE_MODELING_INSIGHTS
  ↓
VALIDATE_DIAGNOSIS
  ↓
WRITE_DIAGNOSIS_ARTIFACTS
  ↓
GENERATE_HANDOFF
  ↓
COMPLETED
```

| 状态                          | 作用                                                         | 主要产物                    |
| ----------------------------- | ------------------------------------------------------------ | --------------------------- |
| `INFER_SCHEMA`                | 识别时间列、目标列、变量类型、频率                           | `data_profile.json`         |
| `BUILD_DATA_SEMANTICS`        | 区分 target、observed covariate、known future covariate、leakage variables | `data_semantic_schema.yaml` |
| `CHECK_DATA_QUALITY`          | 检查缺失、异常、重复、时间戳连续性                           | quality report              |
| `RUN_QUANT_DIAGNOSIS`         | 趋势、周期、平稳性、自相关、漂移等定量诊断                   | `quant_diagnosis.md`        |
| `RUN_QUAL_DIAGNOSIS`          | 字段语义、领域背景、数据生成机制、业务约束                   | `qual_diagnosis.md`         |
| `CHECK_LEAKAGE_AND_RISKS`     | 检查未来信息泄漏、评估污染、训练测试分布差异                 | `modeling_risks.md`         |
| `SUMMARIZE_MODELING_INSIGHTS` | 生成后续建模启发                                             | `modeling_insights.md`      |
| `VALIDATE_DIAGNOSIS`          | 验证诊断结果是否覆盖关键风险                                 | diagnosis validation        |

关键转移条件：

```text
如果数据无法读取 → ERROR_DETECTED
如果 schema 不清楚 → REQUEST_USER_INPUT
如果发现高风险泄漏变量 → 暂停并请求用户确认
如果诊断完整 → WRITE_DIAGNOSIS_ARTIFACTS
```

------

# 6. HypoPlanner Agent 状态机

**职责：** 提出研究假设，制定实验计划。

```text
IDLE
  ↓
LOAD_EVIDENCE
  ↓
GENERATE_HYPOTHESES
  ↓
CHECK_TESTABILITY
  ↓
PRIORITIZE_HYPOTHESES
  ↓
DESIGN_EXPERIMENT_PLAN
  ↓
CHECK_BUDGET_AND_CONSTRAINTS
  ↓
USER_CONFIRMATION?
  ↓
WRITE_PLANNING_ARTIFACTS
  ↓
GENERATE_HANDOFF
  ↓
COMPLETED
```

| 状态                           | 作用                                       | 主要产物                              |
| ------------------------------ | ------------------------------------------ | ------------------------------------- |
| `LOAD_EVIDENCE`                | 读取任务、文献知识、数据诊断证据           | evidence bundle                       |
| `GENERATE_HYPOTHESES`          | 提出可验证研究假设                         | `hypothesis_objects.yaml`             |
| `CHECK_TESTABILITY`            | 检查假设是否能通过实验验证                 | hypothesis validation                 |
| `PRIORITIZE_HYPOTHESES`        | 根据收益、成本、风险、任务约束排序         | priority list                         |
| `DESIGN_EXPERIMENT_PLAN`       | 为每个假设设计 baseline、variant、ablation | `experiment_plan.yaml`                |
| `CHECK_BUDGET_AND_CONSTRAINTS` | 检查实验数量、训练时长、模型规模           | budget validation                     |
| `USER_CONFIRMATION`            | 认知伴随式下确认研究路线                   | approval record                       |
| `WRITE_PLANNING_ARTIFACTS`     | 写入假设、计划、To-do List                 | `hypotheses.md`、`research_todo.yaml` |

关键转移条件：

```text
如果假设不可验证 → 回到 GENERATE_HYPOTHESES
如果实验超预算 → 回到 PRIORITIZE_HYPOTHESES
如果用户不认可假设 → 回到 GENERATE_HYPOTHESES
如果计划通过验证 → 进入 MODEL_DESIGN
```

这个 Agent 的核心原则是：

```text
不允许生成无法验证的假设。
不允许生成不受预算约束的实验计划。
不允许跳过 baseline 直接设计复杂模型。
```

------

# 7. ModelDesigner Agent 状态机

**职责：** 根据假设与实验计划生成结构化模型配方。

```text
IDLE
  ↓
LOAD_HYPOTHESES_AND_PLAN
  ↓
SELECT_MODELING_STRATEGY
  ↓
SELECT_COMPONENTS
  ↓
DRAFT_MODEL_RECIPE
  ↓
CHECK_RECIPE_CONSTRAINTS
  ↓
GENERATE_DESIGN_RATIONALE
  ↓
VALIDATE_MODEL_RECIPE
  ↓
WRITE_MODEL_DESIGN_ARTIFACTS
  ↓
GENERATE_HANDOFF
  ↓
COMPLETED
```

| 状态                        | 作用                                                     | 主要产物                    |
| --------------------------- | -------------------------------------------------------- | --------------------------- |
| `SELECT_MODELING_STRATEGY`  | 选择整体建模路线，例如分解式、卷积式、多尺度、协变量融合 | strategy notes              |
| `SELECT_COMPONENTS`         | 从组件库中选择模块                                       | `component_selection.yaml`  |
| `DRAFT_MODEL_RECIPE`        | 生成结构化模型配方                                       | `model_recipe.yaml`         |
| `CHECK_RECIPE_CONSTRAINTS`  | 检查参数量、输入输出、训练预算、组件兼容性               | recipe check                |
| `GENERATE_DESIGN_RATIONALE` | 解释每个组件对应的假设和证据                             | `model_design_rationale.md` |
| `VALIDATE_MODEL_RECIPE`     | 检查 recipe 是否可编译                                   | validation report           |

关键转移条件：

```text
如果组件不存在 → 回到 SELECT_COMPONENTS
如果 recipe 超过预算 → 回到 DRAFT_MODEL_RECIPE
如果输入输出维度不完整 → 回到 DRAFT_MODEL_RECIPE
如果 recipe 通过验证 → 进入 MODEL_COMPILE
```

这里要注意：ModelDesigner Agent 不直接生成完整代码，而是输出 `model_recipe.yaml`，交给 ModelCompiler。

------

# 8. ModelCompiler 状态机

**职责：** 将模型配方编译为可运行、可测试、可复现的模型工程。

```text
IDLE
  ↓
LOAD_MODEL_RECIPE
  ↓
VALIDATE_RECIPE_SCHEMA
  ↓
RESOLVE_COMPONENTS
  ↓
GENERATE_CODE
  ↓
STATIC_CHECK
  ↓
RUN_UNIT_TESTS
  ↓
RUN_SMOKE_TEST
  ↓
GENERATE_COMPILE_REPORT
  ↓
WRITE_COMPILED_MODEL
  ↓
GENERATE_HANDOFF
  ↓
COMPLETED
```

| 状态                      | 作用                                                       | 主要产物                 |
| ------------------------- | ---------------------------------------------------------- | ------------------------ |
| `VALIDATE_RECIPE_SCHEMA`  | 检查 recipe 字段是否完整、合法                             | schema validation        |
| `RESOLVE_COMPONENTS`      | 从组件库映射到具体代码模块                                 | component map            |
| `GENERATE_CODE`           | 生成 `model.py`、`train.py`、`evaluate.py`、`inference.py` | `compiled_model/`        |
| `STATIC_CHECK`            | 静态语法检查、依赖检查、接口检查                           | static check result      |
| `RUN_UNIT_TESTS`          | dataloader、forward shape、loss computation 测试           | `unit_test_results.json` |
| `RUN_SMOKE_TEST`          | one-batch training 与 inference test                       | smoke test log           |
| `GENERATE_COMPILE_REPORT` | 记录编译过程、警告、测试结果                               | `compile_report.md`      |
| `WRITE_COMPILED_MODEL`    | 写入完整模型工程包                                         | `compiled_model/`        |

关键转移条件：

```text
如果 recipe schema 不合法 → 返回 ModelDesigner
如果组件无法解析 → 返回 ModelDesigner
如果静态检查失败 → 修复并重试
如果 unit test 失败 → 尝试自动修复，超过次数返回 ModelDesigner
如果 smoke test 通过 → 进入 TrainEval
```

ModelCompiler 是 NeoResearch 的关键稳定器。它把“模型想法”变成“可运行模型”，并把大量低级错误挡在 TrainEval 之前。

------

# 9. TrainEval Agent 状态机

**职责：** 执行正式训练、评估和实验记录。

```text
IDLE
  ↓
LOAD_COMPILED_MODEL_AND_PLAN
  ↓
PREPARE_DATA_SPLITS
  ↓
LOCK_EVALUATION_PROTOCOL
  ↓
PREPARE_RUN_CONFIGS
  ↓
RUN_TRAINING
  ↓
MONITOR_TRAINING
  ↓
RUN_VALIDATION_EVAL
  ↓
SAVE_CHECKPOINTS_AND_LOGS
  ↓
AGGREGATE_RESULTS
  ↓
VALIDATE_EXPERIMENT_RESULTS
  ↓
GENERATE_HANDOFF
  ↓
COMPLETED
```

| 状态                          | 作用                                   | 主要产物            |
| ----------------------------- | -------------------------------------- | ------------------- |
| `PREPARE_DATA_SPLITS`         | 准备 train / val / test，防止数据泄漏  | split config        |
| `LOCK_EVALUATION_PROTOCOL`    | 锁定指标、数据切分、随机种子           | evaluation protocol |
| `PREPARE_RUN_CONFIGS`         | 为每个 run 生成配置                    | run configs         |
| `RUN_TRAINING`                | 执行训练                               | logs                |
| `MONITOR_TRAINING`            | 监控 loss、NaN、过拟合、超时、资源占用 | monitor log         |
| `RUN_VALIDATION_EVAL`         | 在 validation set 上评估               | metrics             |
| `SAVE_CHECKPOINTS_AND_LOGS`   | 保存 checkpoint、日志、预测结果        | checkpoints         |
| `AGGREGATE_RESULTS`           | 汇总多实验结果                         | `metrics.csv`       |
| `VALIDATE_EXPERIMENT_RESULTS` | 检查指标是否合理、是否遵守预算         | validation report   |

关键转移条件：

```text
如果训练脚本失败 → ERROR_DETECTED → RECOVER_OR_RETRY
如果 GPU/时间预算不足 → BUDGET_EXHAUSTED
如果指标异常或 NaN → 进入 failure analysis
如果实验结果完整 → 进入 Reflection
```

这里建议加入两条重要 guard：

```text
禁止反复使用 protected test set。
禁止在没有记录 seed 和 data split 的情况下写入正式结果。
```

------

# 10. Reflector Agent 状态机

**职责：** 反思实验结果，判断假设是否成立，决定下一步。

```text
IDLE
  ↓
LOAD_RESULTS_AND_HYPOTHESES
  ↓
COMPARE_WITH_BASELINES
  ↓
VERIFY_HYPOTHESES
  ↓
ANALYZE_FAILURES
  ↓
ASSESS_CONFIDENCE_AND_RISKS
  ↓
DECIDE_NEXT_ACTION
  ↓
WRITE_REFLECTION_ARTIFACTS
  ↓
GENERATE_HANDOFF
  ↓
COMPLETED
```

| 状态                          | 作用                                                 | 主要产物                       |
| ----------------------------- | ---------------------------------------------------- | ------------------------------ |
| `COMPARE_WITH_BASELINES`      | 比较 baseline、variant、ablation                     | comparison table               |
| `VERIFY_HYPOTHESES`           | 判断每个假设支持、部分支持或不支持                   | `hypothesis_verification.yaml` |
| `ANALYZE_FAILURES`            | 分析失败类型：数据、模型、训练、评估、资源、推理错误 | `failure_analysis.md`          |
| `ASSESS_CONFIDENCE_AND_RISKS` | 给出可信度和风险边界                                 | confidence notes               |
| `DECIDE_NEXT_ACTION`          | 决定回退、迭代、继续训练或发布                       | `next_iteration_plan.yaml`     |
| `WRITE_REFLECTION_ARTIFACTS`  | 写入反思报告                                         | `reflection.md`                |

Reflector 的核心分叉逻辑：

```text
如果假设被支持且结果达到目标 → RESULT_PUBLISHING
如果模型设计有问题 → MODEL_DESIGN
如果模型代码或测试有问题 → MODEL_COMPILE
如果训练不足或实验未完成 → TRAIN_EVAL
如果假设不成立且需要新方向 → HYPOTHESIS_PLANNING
如果数据问题严重 → DATA_DIAGNOSIS
如果预算耗尽 → RESULT_PUBLISHING 或 PAUSED_FOR_APPROVAL
```

Reflector Agent 是 NeoResearch 的闭环控制器。它决定系统是继续探索，还是停止并发布。

------

# 11. ResultPublisher Agent 状态机

**职责：** 整理研究产物，生成可复现交付包。

```text
IDLE
  ↓
LOAD_ALL_KEY_ARTIFACTS
  ↓
VERIFY_ARTIFACT_COMPLETENESS
  ↓
BUILD_EVIDENCE_LINEAGE
  ↓
GENERATE_REPORT
  ↓
GENERATE_MODEL_CARD
  ↓
GENERATE_API_SCHEMA
  ↓
PACKAGE_RELEASE
  ↓
RUN_REPRODUCIBILITY_CHECK
  ↓
USER_FINAL_CONFIRMATION?
  ↓
FINALIZE_RELEASE
  ↓
COMPLETED
```

| 状态                           | 作用                                         | 主要产物                 |
| ------------------------------ | -------------------------------------------- | ------------------------ |
| `LOAD_ALL_KEY_ARTIFACTS`       | 读取任务、文献、诊断、假设、模型、实验、反思 | artifact bundle          |
| `VERIFY_ARTIFACT_COMPLETENESS` | 检查代码、权重、结果、日志、报告是否完整     | completeness report      |
| `BUILD_EVIDENCE_LINEAGE`       | 建立从数据证据、假设、实验到结论的链路       | evidence lineage         |
| `GENERATE_REPORT`              | 生成最终实验报告                             | `final_report.md/pdf`    |
| `GENERATE_MODEL_CARD`          | 生成模型卡片                                 | `model_card.md`          |
| `GENERATE_API_SCHEMA`          | 生成上层 Agent 调用接口                      | `api_schema.yaml`        |
| `PACKAGE_RELEASE`              | 打包代码、checkpoint、config、结果、日志     | release package          |
| `RUN_REPRODUCIBILITY_CHECK`    | 检查复现脚本和环境说明是否完整               | repro check              |
| `USER_FINAL_CONFIRMATION`      | 需要对外发布时请求用户确认                   | approval record          |
| `FINALIZE_RELEASE`             | 归档发布版本                                 | `artifact_manifest.json` |

关键转移条件：

```text
如果 artifact 不完整 → 回到对应上游阶段补齐
如果 evidence lineage 不完整 → 回到 Reflector 或 TrainEval
如果复现检查失败 → 回到 ModelCompiler 或 TrainEval
如果用户确认发布 → PROJECT_COMPLETED
```

ResultPublisher 不只是写报告，而是保证 NeoResearch 的输出是一个完整的 **Research Release Package**。

------

# 12. Coordinator / Runtime 状态机控制逻辑

虽然每个 Agent 都有自己的状态机，但 NeoResearch 还需要一个全局 Coordinator 管理状态流转。它可以是确定性 Runtime，也可以结合一个 Research Coordinator Agent。

核心控制逻辑如下：

```python
while project_state not in ["PROJECT_COMPLETED", "FAILED", "CANCELLED"]:
    current_stage = runtime.get_current_stage()
    agent = runtime.load_agent(current_stage)

    agent.load_context()
    input_status = agent.validate_inputs()

    if input_status == "missing_required_artifact":
        runtime.route_to_required_previous_stage()
        continue

    result = agent.run()

    if result.status == "success":
        runtime.validate_outputs(result.output_artifacts)
        runtime.write_handoff(result.handoff_capsule)
        runtime.transition_to_next_stage(result.next_stage)

    elif result.status == "partial_success":
        runtime.decide_continue_or_request_user()

    elif result.status == "failed":
        if runtime.can_retry(agent):
            runtime.retry(agent)
        elif runtime.can_fallback(agent):
            runtime.apply_fallback(agent)
        else:
            runtime.pause_for_user_or_fail()
```

全局 Runtime 需要维护：

```yaml
project_state:
  task_id: "tsf_energy_001"
  current_stage: "MODEL_COMPILE"
  current_agent: "ModelCompiler"
  completed_stages:
    - "INTENT_SCOPING"
    - "LITERATURE_SEARCH"
    - "DATA_DIAGNOSIS"
    - "HYPOTHESIS_PLANNING"
    - "MODEL_DESIGN"
  pending_stages:
    - "TRAIN_EVAL"
    - "REFLECTION"
    - "RESULT_PUBLISHING"
  iteration_id: 1
  retry_count:
    ModelCompiler: 1
  budget:
    max_trials: 10
    used_trials: 2
    max_training_hours: 3
    used_training_hours: 0.8
  approval_status:
    hypothesis_plan: "approved"
    model_design: "pending"
```

------

# 13. 关键状态转移规则

NeoResearch 的状态机最好设置一些统一规则。

**第一，任何 Agent 进入下一阶段前，必须通过 artifact validation。**

```text
Agent output invalid → 不允许进入下一阶段。
```

**第二，任何高成本操作前，需要检查预算。**

```text
budget check failed → 降级实验 / 请求用户确认 / 终止探索。
```

**第三，任何模型进入正式训练前，必须通过 ModelCompiler 的 smoke test。**

```text
smoke test failed → 禁止进入 TrainEval。
```

**第四，任何结论写入最终报告前，必须有 evidence lineage。**

```text
unsupported claim → 标记为 tentative hypothesis，不能写成 verified finding。
```

**第五，认知伴随式模式下，关键节点必须进入 approval state。**

```text
after data diagnosis → approval optional
after hypothesis planning → approval required
after model design → approval required
before result publishing → approval required
```

**第六，苏格拉底式模式下，系统只在开头和结尾强制确认。**

```text
task spec confirmation → required
final release confirmation → required
middle-stage approval → optional
```

------

# 14. 推荐的状态命名规范

为了工程实现清晰，建议统一使用如下命名：

```text
IDLE
INITIALIZING
LOAD_CONTEXT
VALIDATE_INPUTS
EXECUTE
VALIDATE_OUTPUTS
WRITE_ARTIFACTS
GENERATE_HANDOFF
COMPLETED
ERROR_DETECTED
RECOVERING
PAUSED_FOR_APPROVAL
FAILED
```

对于每个 Agent 的业务状态，可以加前缀，例如：

```text
DataDiagnoser.RUN_QUANT_DIAGNOSIS
HypoPlanner.GENERATE_HYPOTHESES
ModelCompiler.RUN_SMOKE_TEST
TrainEval.RUN_VALIDATION_EVAL
Reflector.DECIDE_NEXT_ACTION
ResultPublisher.PACKAGE_RELEASE
```

这样日志和 trace 会非常清楚。

------

# 15. 总结

NeoResearch 的状态机设计可以概括为：

> **全局 Runtime 管理研究流程状态，每个 Agent 管理阶段内部状态；Agent 之间不共享完整上下文，而是通过标准化 artifact 和 handoff capsule 交接；每个阶段都设置输入验证、输出验证、失败恢复、预算检查和用户确认机制。**

更凝练地说：

> **NeoResearch 的状态机不是简单控制 Agent 顺序执行，而是将数据科学研究转化为一个可验证、可回退、可迭代、可发布的研究工作流。**

最终完整链路是：

```text
IntentScope
  → Literature Search
  → DataDiagnoser
  → HypoPlanner
  → ModelDesigner
  → ModelCompiler
  → TrainEval
  → Reflector
  → ResultPublisher
```

其中 Reflector 形成迭代闭环，ModelCompiler 保证模型想法可运行，ResultPublisher 保证研究结果可复现交付。这三个模块是 NeoResearch 从普通自动化建模工具升级为 autonomous research agent / model factory 的关键。