# NeoResearch 当前工作流说明

本文档描述当前 NeoResearch 在 `opencode/packages/opencode` 内的实际工作流。它不是单纯的聊天流程，而是围绕 `Task / Candidate / Run / Artifact / Approval / Memory / Champion` 这些持久化对象运行的研究状态机。

当前主场景是 TSF（time-series forecasting）自主研究：从一个预测目标或 CSV 数据集出发，生成任务、分析数据、搜索模型候选、调用 Neo-Cast runner 执行实验、验证结果、沉淀经验，并导出最终报告或模型包。

## 一句话流程

```text
研究目标/CSV
  -> Research Task
  -> Intent Agent 澄清任务
  -> Data Analysis Agent 分析数据
  -> NAS Agent 搜索和运行候选模型
  -> Verifier/Analyst/Librarian 校验、评估、记忆
  -> Reflection Agent 复盘和决策
  -> Publish Agent 导出报告或模型包
```

## 核心对象

| 对象 | 作用 | 典型来源 |
| --- | --- | --- |
| `ResearchTask` | 一次研究任务，保存领域、任务规格、目标指标、预算和状态。 | `research create`、TUI `New CSV Task`、自然语言创建任务。 |
| `ResearchCandidate` | 一个候选模型或 recipe。 | domain baseline、LLM proposal、mutation、人工创建。 |
| `ResearchRun` | 一次候选执行记录，包含阶段、状态、指标、资源和错误。 | `prepareRun` / `executeRun` / autonomous loop。 |
| `ResearchArtifact` | 文件产物索引，例如 profile、runner plan、报告、模型包。 | 各 Agent、runner、exporter。 |
| `ResearchApproval` | 人工审批点，例如 candidate、budget、protocol、ref_test、blind_test。 | checkpoint、风险候选、权限门。 |
| `ResearchMemory` | 研究经验，记录候选与结果的经验教训。 | 成功、失败、rejected run 后自动写入。 |
| `ResearchChampion` | 当前最佳候选和对应 run。 | 成功 run 评估后更新。 |

这些对象写入本地 Research DB；文件型产物通常落在 `.neo-research/` 下。

## 入口

### TUI 入口

TUI Cockpit 是当前主要交互入口：

- `New CSV Task`：从 CSV 创建 TSF 任务。
- 输入自然语言目标：可从 prompt 或 home 创建任务。
- `Seed Baselines`：生成初始候选。
- `Agent Loop`：运行多轮 autonomous iteration。
- `Export Bundle`：导出最终 bundle。
- `Mode ...`：切换交互模式。
- `Use Project Runner` / `Edit Runner Root`：修复 Neo-Cast runner 配置。
- slash command：通过 `/seed`、`/profile`、`/agent-loop`、`/export`、`/approve`、`/reject` 等命令驱动同一套 API。

当从自然语言创建 autonomous 任务且 runner 已就绪时，TUI 会直接调用 `/research/tasks/:taskID/pipeline`，跑完整多 Agent pipeline。

### CLI 入口

主要 CLI 命令包括：

| 命令 | 作用 |
| --- | --- |
| `research create` | 创建 TSF research task。 |
| `research profile <taskID>` | 生成 task profile 和数据分析产物。 |
| `research prepare-dataset <taskID>` | 把任务数据准备成 Neo-Cast dataset contract。 |
| `research seed <taskID>` | 生成 baseline candidates 和审批。 |
| `research iterate <taskID>` | 执行一轮自主研究。 |
| `research loop <taskID>` | 执行多轮自主研究。 |
| `research pipeline <taskID>` | 执行完整多 Agent pipeline。 |
| `research vibe <goal...>` | 从自然语言目标创建任务并运行 pipeline。 |
| `research export <taskID>` | 导出报告或模型包。 |
| `research worker-once` / `research worker-loop` | 消费 file-runtime queue 中的已准备 run。 |

### HTTP API 入口

TUI 通过 Research HTTP routes 调用服务层。关键 API 包括：

| API | 作用 |
| --- | --- |
| `POST /research/tasks` | 创建任务。 |
| `POST /research/tasks/:taskID/profile` | 生成 profile。 |
| `POST /research/tasks/:taskID/prepare-dataset` | 准备 Neo-Cast 数据集。 |
| `POST /research/tasks/:taskID/baselines` | 生成 baseline。 |
| `POST /research/tasks/:taskID/autonomous/iterate` | 运行一轮 autonomous iteration。 |
| `POST /research/tasks/:taskID/autonomous/loop` | 运行多轮 autonomous loop。 |
| `POST /research/tasks/:taskID/pipeline` | 运行完整 pipeline。 |
| `POST /research/tasks/:taskID/export` | 导出产物。 |
| `POST /research/approvals/:approvalID/reply` | 回复人工审批。 |

## 交互模式

当前有两种用户侧交互模式：

| 模式 | 代码值 | 行为 |
| --- | --- | --- |
| 认知伴随 | `companion` | 系统在关键节点暂停，要求用户 review、approve 或 reject。适合人机协作研究。 |
| 苏格拉底 | `socratic` | 系统先通过 Intent Agent 澄清任务意图，字段齐全后进入自动流程。适合目标不完整时逐步提问。 |

底层任务还有 `mode`：

- `review`：偏人工 review。
- `autonomous`：允许自主循环和自动候选执行。

`runFullPipeline` 要求任务是 `autonomous`，但 `companion` 模式允许在非完全自动前提下以 checkpoint 方式推进。

## 完整 Pipeline 阶段

`Research.Service.runFullPipeline(...)` 是当前完整工作流的主编排器。阶段如下：

```text
intent_gathering
  -> data_analysis
  -> searching
  -> reflection
  -> publishing
```

### 1. Intent Agent

目标：

- 读取当前 task。
- 分析用户目标、领域、数据集、指标、预测长度、约束和交互模式。
- 生成 `intent_spec_markdown` artifact。

可能结果：

- 字段完整：继续后续流程。
- 字段缺失：创建 `protocol` approval，把任务状态置为 `paused`，等待用户回答澄清问题。

相关状态：

- task status: `intent_gathering`
- artifact: `intent_spec_markdown`
- blocker: `intent_clarification_required`

### 2. Dataset Preparation

TSF 任务可以在进入数据分析前准备 Neo-Cast 数据集：

- 根据 taskSpec 中的数据路径、目标列、context length、prediction lengths 生成 Neo-Cast dataset contract。
- 调用 Neo-Cast project runner 下的命令完成 materialization。
- 写入 `dataset_preparation_json` artifact。

如果 TUI 右侧出现 `Runner dataset mismatch`，通常说明 Neo-Cast 已准备的数据集和当前任务 spec 不一致，需要重新 prepare dataset 或清理旧 dataset spec 后重跑。

### 3. Data Analysis Agent

目标：

- 调用 domain fingerprint/profile。
- 分析数据行数、目标列、缺失值、趋势、季节性、交叉相关、分布漂移、异常值、时间戳质量等。
- 生成统一的数据分析报告。

主要产物：

- `task_profile_json`
- `dataset_quantitative_analysis_markdown`
- `dataset_qualitative_analysis_markdown`
- `dataset_main_analysis_markdown`
- `dataset_analysis_report`
- 可能包含 plot artifact

在 `companion` 模式下，数据分析完成后会触发人工 checkpoint：

```text
data_analysis_done
```

用户需要确认数据分析是否符合领域认知，审批后才进入搜索空间确认和模型搜索。

### 4. Search Space Checkpoint

在 `companion` 模式下，开始模型搜索前会生成搜索空间确认 checkpoint：

```text
search_space_confirmed
```

内容包括：

- 根据 dataset profile 得出的 search biases。
- 计划尝试的 baseline recipes。
- 建议用户确认搜索方向是否合理。

如果 checkpoint pending，任务会暂停在 `paused`。

### 5. NAS Agent / Autonomous Loop

NAS Agent 调用 `runAutonomousLoop(...)`，每一轮调用 `runAutonomousIteration(...)`。

单轮 autonomous iteration 的内部步骤：

1. 构建 task fingerprint。
2. 合并 Reflection Agent 写入的 `reflectionHypotheses`。
3. 如果没有候选，先执行 `seedBaselines(...)`。
4. 从已 approved / auto_approved 的候选里选一个未尝试候选。
5. 如果没有可用候选，尝试 LLM proposal，再回退到 domain proposal。
6. 对新候选执行 domain validation。
7. 低风险 autonomous 候选可自动 `auto_approved`，高风险或需要人工判断的候选会创建 approval。
8. 调用 `executeRun(...)` 执行候选。
9. Verifier Agent 对成功且有 primary metric 的 run 做验证。
10. Analyst 读取主指标，判断 run 是否有效。
11. Librarian 写入 research memory。
12. 写入 candidate selection artifact 和 manager trace artifact。

NAS loop 的停止条件：

| 停止原因 | 含义 |
| --- | --- |
| `max_iterations` | 达到最大迭代数。 |
| `budget_exhausted` | 预算耗尽，需要预算审批。 |
| `approval_required` | 有候选、权限或 protocol approval 等待人工处理。 |
| `seed_failed` | baseline 生成失败。 |
| `target_reached` | 达到目标指标。 |
| `plateau` | 连续多轮无有效提升。 |
| `time_budget_exhausted` | 时间预算耗尽。 |
| `crash_streak_exceeded` | 连续失败次数达到上限。 |

NAS Agent 会生成搜索相关产物：

- `nas_model_search_plan_md`
- `nas_experiment_log_md`
- `nas_leaderboard_md`
- `nas_evaluation_result_md`
- `nas_reflection_notes_md`
- `nas_search_space_yaml`
- `nas_best_model_config_yaml`
- `nas_best_model_py`
- `nas_training_script_py`

在 `companion` 模式下，NAS 后还有人工 checkpoint：

- `experiment_budget_extended`：达到迭代上限时，确认是否扩展预算。
- `final_model_selection`：确认最终 champion 或接受当前结果。

### 6. Runner Execution

TSF run plan 由 domain 生成，然后交给 Neo-Cast runner 执行。

当前 TSF runner 约定：

| 阶段 | 脚本 | 典型指标 |
| --- | --- | --- |
| `smoke` | `py/validate.py smoke ...` | `val_avg_mse`, `val_avg_mae` |
| `low_fidelity` / `full` / `baseline` | `py/runner.py run ...` | `val_avg_mse`, `val_avg_mae` |
| `ref_test` | `py/runner.py ref-test` | `ref_test_avg_mse`, `ref_test_avg_mae` |
| `blind_test` | `py/runner.py blind-test` | `blind_test_avg_mse`, `blind_test_avg_mae` |

Runner root 可以来自：

- taskSpec.runtime.neoCastProjectRoot
- `NEO_RESEARCH_NEO_CAST_ROOT`
- `NEO_CAST_ROOT`
- package 内置相对路径探测

TUI 侧会额外检查：

- runner root 是否存在。
- `py/validate.py` 是否存在。
- runtime python 是否存在并可用。
- prepared dataset spec 是否和当前 task 匹配。

### 7. Verifier Agent

当 run 成功且包含 primary metric 时，会执行 verifier 检查。

当前 verifier 包括：

- metric 合法性。
- horizon 覆盖。
- baseline 对比。
- cost/performance。
- overfitting 风险。
- data leakage 风险。

Verifier 会生成：

- `evaluation_result_md`
- `verifier_decision_json`

如果 verifier 拒绝，该 run 状态会被改成 `rejected`，并写入失败原因和恢复建议。

### 8. Reflection Agent

Reflection Agent 在 NAS 后运行，目标是复盘：

- 哪些变更有效。
- 哪些变更无效。
- 失败 run 的类别和恢复动作。
- 是否继续、停止或请求人工介入。
- 下一轮实验假设。

主要产物：

- `reflection_notes_md`
- `next_experiment_plan_md`
- `failure_log_md`

如果 Reflection 决策是 `request_human`，pipeline 会创建 protocol approval 并暂停。

### 9. Publish Agent

Publish Agent 负责最终导出：

- 默认导出 `model_export_package`。
- 也支持 `research_final_bundle` 和 `research_report_markdown`。

模型包通常包含：

- `report/research-report.md`
- `reports/final_report.md`
- `results/runs.json`
- `results/candidates.json`
- `results/champion.json`
- `results/artifacts.json`
- `results/approvals.json`
- `results/memory.json`
- `configs/search_space.yaml`
- `configs/best_model_config.yaml`
- `experiments/*`
- `model/*`
- `manifest.json`

发布成功后，task status 变为 `completed`。

在 `companion` 模式下，发布前会有最后一个 checkpoint：

```text
report_release
```

## Immediate Run 与 Queue Worker

当前有两条执行路径：

| 路径 | 用途 | 行为 |
| --- | --- | --- |
| `executeRun(...)` | 本地开发、TUI 即时执行、确定性测试。 | 直接在 OpenCode 进程里写 run plan、调用 subprocess、解析 runner 输出。 |
| `prepareRun(...)` + worker | 类生产队列模型。 | 创建 queued run、写 run plan artifact、入队 file-runtime job，由 `worker-once` 或 `worker-loop` 消费。 |

这两条路径共享 `DomainRunPlan`，因此后续替换成生产 queue/object store 时，domain 层不需要重写。

## 恢复与重复运行

`runFullPipeline` 使用 taskSpec metadata 中的 workflow 信息记录已完成阶段：

```text
completedPhases: data_analysis / searching / reflection / publishing
lastCheckpoint: ...
```

当 pipeline 重新运行时：

- 已完成 `data_analysis`：从 `dataset_analysis_report` artifact 恢复。
- 已完成 `searching`：从 `research_autonomous_loop_json` artifact 恢复。
- 已完成 `reflection`：从 reflection artifacts 恢复。
- 已完成 `publishing`：从 export artifact 恢复。

如果调用 `updateTaskSpec(...)` 修改任务 spec，workflow 进度会被清理，避免旧的 profile / NAS / publish 结果错误复用到新任务上。

## 状态流转

常见 task status：

```text
created
  -> intent_gathering
  -> data_analysis
  -> searching
  -> publishing
  -> completed
```

可能的中断状态：

| 状态 | 含义 |
| --- | --- |
| `paused` | 等待用户审批、澄清或修复配置。 |
| `failed` | 阶段执行失败。 |
| `researching` | 任务处于研究过程中。 |
| `idle` | 当前无主动执行。 |

常见 run status：

```text
queued -> running -> succeeded
queued -> running -> failed
queued -> running -> rejected
```

## 常见阻塞点

| 阻塞 | 表现 | 处理方式 |
| --- | --- | --- |
| Intent 信息不足 | `intent_clarification_required`，任务 `paused`。 | 回答 Intent Agent 的问题，补齐 slots。 |
| Runner root 缺失 | TUI 显示 `Runner root missing`。 | 点击 `Use Project Runner` 或设置 `taskSpec.runtime.neoCastProjectRoot`。 |
| `py/validate.py` 缺失 | TUI 显示 `Runner script missing`。 | 确认 runner root 指向 Neo-Cast 项目根目录。 |
| Runtime python 缺失 | TUI 显示 `Runner Python missing`。 | 在 Neo-Cast runner root 初始化 runtime。 |
| Dataset mismatch | TUI 显示 `Runner dataset mismatch`。 | 重新 prepare dataset，确保 dataset spec 与任务一致。 |
| 候选需要审批 | loop 停在 `approval_required`。 | approve/reject candidate approval。 |
| ref/blind test 权限 | `ref_test` 或 `blind_test` 阶段需要 gate。 | 申请并 approve 对应 approval。 |
| 预算耗尽 | loop 停在 `budget_exhausted`。 | 批准 budget 或调整 task budget。 |
| Verifier 拒绝 | run 变成 `rejected`。 | 查看 `verifier_decision_json`，按恢复建议调整候选或数据。 |
| Reflection 请求人工 | `reflection_requested_human_review`。 | 读取 reflection notes，人工决定继续、停止或调整任务。 |

## 当前工作流边界

当前实现已经具备：

- TSF domain plugin。
- TUI / CLI / HTTP API 三套入口。
- 多 Agent pipeline。
- Neo-Cast subprocess runner 集成。
- 本地 file-runtime queue 原型。
- 数据分析、NAS、verifier、reflection、publish 产物链。
- workflow metadata 恢复机制。
- approval/checkpoint 机制。

仍属于本地 alpha 形态的部分：

- 生产级 queue / object store / metrics store 尚未替换本地 file driver。
- 长任务 supervisor、分布式 worker 和租约恢复仍是后续演进方向。
- runner 环境、数据集准备和模型 API 仍依赖本机配置。
- TUI 里部分操作仍是即时 API 调用，适合本地研究而非多人生产调度。

## 推荐操作顺序

对于一个新的 TSF 任务，建议按以下顺序推进：

1. 创建任务，确认 dataset、target、context、horizon、metric。
2. 设置或修复 Neo-Cast runner root。
3. 运行 dataset preparation，确保 runner dataset 与 taskSpec 匹配。
4. 运行 Data Analysis，检查 profile 是否符合预期。
5. 在 companion 模式下审批 data analysis 和 search space checkpoint。
6. 启动 Agent Loop 或 full pipeline。
7. 检查 NAS leaderboard、verifier decision、champion。
8. 审批最终模型选择。
9. 运行 Publish Agent / Export Bundle。
10. 查看 `manifest.json`、final report 和 model package。
