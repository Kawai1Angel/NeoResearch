# Claude Code NeoResearch 目标对齐缺口与待研发清单

> 生成日期：2026-05-02
> 对照目标文档：`文档/neo_research_目标与关键技术指导提示.md`
> 对照代码范围：`opencode/packages/opencode/src/research/`、`opencode/packages/opencode/src/cli/`、`neo_cast/py`、`neo_cast/src`
> 上一版参考：`文档/multi_agent_transformation_alignment_gaps.md`（2026-05-01，多数 P0 已落地）

## 一、总体判断

目标文档的定位是 **面向时间序列预测的自主科研智能体系统（Autonomous Research Agent for TSF）**，强调 Harness Engineering、四阶段多智能体协作、Skill 一等公民、Memory as File Systems、可复现 / 可审计 / 可发布的科研产物。

当前代码相对于目标的对齐度约 **45–55%**：

- ✅ 多智能体骨架已落地（`agents/intent-agent.ts`、`data-analysis-agent.ts`、`nas-agent.ts`、`publish-agent.ts`），`runFullPipeline` 已在 service 层串接四阶段。
- ✅ `ResearchTaskStatus` 已扩展为 `intent_gathering / data_analysis / searching / publishing` 等状态；事件总线已发布 Agent 阶段事件。
- ✅ profile → autonomous loop → final bundle 端到端闭环可跑通；TUI cockpit 已分四阶段呈现。
- ✅ Approval / Human Checkpoint 机制已在 intent 缺口环节通过 `ensurePendingApproval` 阻塞推进（部分对齐认知伴随式）。
- ⚠️ 但绝大多数 Agent 仍是 **格式化器 / 摘要器**，并未承担"理解、对话、判断、反思"的实际研究职责。
- ❌ Skill 子系统、Reflection Agent、Verifier Agent、Failure Recovery、长程记忆、Model Recipe DSL、可视化、外生变量支持等核心能力**完全缺失或仅有雏形**。

下面按目标文档章节顺序列出缺口、影响及落地建议。

---

## 二、与目标文档的具体差距

### G1. IntentAgent 仍是规则式字段检查，远不是苏格拉底式对话

**目标（§2.1 / §3.1）：** Intent Agent 通过多轮追问澄清预测对象、lookback、horizon、外生变量、业务背景、误差偏好、轻量化 / 可解释性 / 部署约束、交互模式，最终生成结构化 `intent_spec.md`。

**2026-05-02 进展：最小闭环已落地。**
- `opencode/packages/opencode/src/research/agents/intent-agent.ts` 已从四字段规则检查扩展为结构化 Intent Agent，输出 `IntentSpec`、`intentSpecMarkdown`、`dialogueStrategy`、`llm.status`、`confidence`、`missingFields` 和 `clarifyingQuestions`。
- IntentSpec 已覆盖 `interaction_mode`、预测对象、数据来源、target columns、lookback、horizon、外生变量、业务背景、`primary_metric`、`secondary_metrics`、误差偏好、`latency_budget`、`parameter_budget`、`interpretability`、`deployment_target`、`open_questions`。
- 已加入 opt-in LLM-backed refinement：设置 `NEO_RESEARCH_INTENT_LLM=1` 后，Intent Agent 使用 Neo-Cast LLM 配置生成下一轮澄清问题并可补全可合理推断的 slots；无 key 或未启用时走 deterministic fallback，避免测试/本地环境意外联网。
- `runIntentAgent` 会写入 `.neo-research/sessions/<taskID>/intent/intent_spec.md`，并登记 `intent_spec_markdown` artifact。
- `socratic` 与 `companion` 已映射为不同追问策略：Socratic 一次只问一个深度问题、阈值更高；Companion 一次最多三个紧凑问题，并声明后续 checkpoint phases。
- `runFullPipeline` 对 Companion task 不再直接因 `review` mode 拒绝，而是在 Data Analysis 完成后创建 `[checkpoint:data_analysis_done]` protocol approval 并暂停，形成第一处 Human Checkpoint 注入。

**剩余待研发：**
1. 增加 `answerIntentQuestion` / `updateIntentSpec` API，把用户回答结构化合并回 task/session，而不是只靠 taskSpec 初始字段。
2. 将 LLM-backed dialogue 从 opt-in 升级为可配置策略，例如 per-project intent LLM 开关、模型选择、失败重试和审计日志。
3. 将 Companion checkpoint 从当前 `data_analysis_done` 扩展到 `search_space_confirmed`、`experiment_budget_extended`、`final_model_selection`、`report_release`，并为 approval 增加结构化 `summary/options/recommended` metadata。
4. TUI 的 Socratic slot 面板仍需从旧四槽位升级为读取 `intent_spec_markdown` / expanded slots。

### G2. DataAnalysisAgent 缺少真正的统计检验、可视化、领域 LLM 解读

**目标（§3.2）：** 定量分析 Agent 调用 ADF/KPSS、ACF/PACF、STL 分解、频域分析、变化点检测、跨变量滞后；定性分析 Agent 用 LLM 结合字段语义产出业务级解读；Main Agent 汇总成 `data_analysis_summary.md`。

**现状：**
- Python 侧 `prepare_tsf.py` 计算了基础 profile（trendStrength、seasonalityStrength、acfMainPeriod、adfStatistic、crossVarCorrelation、distributionShift、outlierRate）。
- TypeScript 侧 `data-analysis-agent.ts` 只是把 profile 渲染成 markdown，无真正分析逻辑。
- "定性分析" 仍为模板文本，不是 LLM 生成。
- 没有 matplotlib 图表 artifact（无 `*.png`）。
- 没有 KPSS、PACF、STL、频域、变化点、滞后相关分析。
- 没有 `data_analysis_summary.md` 与 quantitative/qualitative 三分文档的清晰分工，仅有合并的 `dataset_analysis_report`。

**待研发：**
1. `neo_cast/py/analysis/` 新增 dedicated 分析模块：`stationarity.py`（ADF + KPSS）、`seasonality.py`（STL + 频域）、`changepoint.py`、`crosslag.py`、`plots.py`（matplotlib 输出 PNG）。
2. DataAnalysisAgent 调用 LLM 产出 `qualitative_analysis.md`：输入 = 字段名 + intent_spec + 定量摘要；输出 = 业务机制、外部因素、潜在事件、风险、领域建模建议。
3. 三分 artifact kind 复活：`quantitative_analysis_md`、`qualitative_analysis_md`、`data_analysis_summary_md`，并在最终报告中嵌入完整文本而非仅引用。
4. PNG 图表落到 artifact dir，并在 markdown 中以相对路径引用。

### G3. NASAgent 还不是数据驱动的模型配方搜索

**目标（§3.3 / §5.7）：** NAS Agent 基于 `data_analysis_summary.md` 与 `intent_spec.md` 选择 backbone、调整 lookback、注入分解 / 注意力 / 外生变量、调整归一化与损失。每轮记录假设、改动点、训练配置、评估、反思。

**现状：**
- `nas-agent.ts` 25 行，纯 summarizer，不参与生成。
- baseline 由 `buildTSFBaselines` 固定生成 3 条（linear / patch_mlp / patch_transformer），**未读取 datasetProfile / searchBiases 进行条件选择**。
- mutation 策略 `neo_cast/py/search/mutate.py` 不接收 dataset profile / search bias，主要按 metric / status 决策。
- 高季节性 / 高跨变量相关 / distribution shift 等数据特征**没有定向影响搜索路径**。
- TUI 没有显示 iteration index、hypothesis、mutation rationale、metric trend。

**待研发：**
1. 让 baseline 生成器消费 `searchBiases`：例如高季节性 → 注入 series_decomposition；高跨变量相关 → 启用 channel-mixing / fusion；distribution shift → 强制 instance_norm。
2. 把 `datasetProfile + searchBiases` 透传到 LLM proposal prompt 与 mutation policy。
3. 在 NASAgentResult 中暴露 per-iteration `hypothesis`、`mutationRationale`、`expectedImprovement`、`actualDelta`，并写入 `experiment_log.md`。
4. TUI 增加 "Hypothesis & Mutation" 子面板。

### G4. **Reflection Agent 完全缺失**

**目标（§3.5）：** 独立 Reflection Agent，输入 `evaluation_result.md / experiment_log.md / leaderboard.md / 历史经验`，输出 `reflection_notes.md` 与 `next_experiment_plan.md`，关键字段：失败原因、有效改动、无效改动、下一轮假设、是否继续迭代。

**现状：**
- 只有 `neo_cast/src/reflect.js`（CLI 旧式 reflection loop）和 `service.ts` 内部隐含的 ranking / utility 计算。
- TypeScript 侧没有 ReflectionAgent 文件、没有 `reflection_notes` artifact kind、没有 `next_experiment_plan` 产物。
- 所谓 "反思" 当前等同于 mutation policy 与 stop policy，缺少结构化文字反思。

**待研发：**
1. 新增 `agents/reflection-agent.ts` + `runReflectionAgent` service 方法，在每轮 NAS iteration 完成后或 plateau 触发时调用。
2. LLM 输入：last N runs metrics、candidateSpec diffs、verifier signals；输出结构化 JSON → 渲染为 `reflection_notes.md`。
3. 触发 NASAgent 读取 `next_experiment_plan.md` 影响下一轮 mutation。

### G5. **Verifier Agent / Verifier Environment 缺失**

**目标（§4.8.8 / §5.9）：** 综合判断 metric 提升、稳定性、成本、可信度、horizon-wise trade-off、数据泄露、过拟合、baseline 公平性。

**现状：**
- 只有 `utilityScore`、`isMeaningfulMetricImprovement`、`paretoDominates` 等数字逻辑分布在 `service.ts`。
- 没有 leakage_verifier、overfitting_verifier、horizon-wise verifier 这些概念落到代码模块。
- 没有 verifier decision artifact，也没有把 verifier 拒绝事件做成可见的中断点。

**待研发：**
1. `src/research/verifiers/` 目录，按目标文档拆分多个 verifier，每个返回 `{ accepted: bool, reason: string, evidence: JsonRecord }`。
2. `evaluation_result.md` artifact kind 新增，结构化记录每个 verifier 的判定。
3. 在 NAS iteration 结束时强制走 verifier，未通过则 `run.status = "rejected"` 并向事件总线发 `RunRejected`。

### G6. **Skill 子系统完全缺失（目标文档 §2 第六原则、§4.6、§4.8.10、§5.14、§7 都强调）**

**目标：** Skill 是一等能力包，含 `skill.md / config.yaml / examples/ / scripts/ / templates/`，覆盖：缺失值处理、平稳性分析、季节性分解、频域分析、外生融合、baseline 训练、误差诊断、报告生成、领域 Skill（光伏 / 能源 / 交通 / 医疗）。Skill Registry 支持检索、调用、组合、版本、成功率、失败案例。

**现状：**
- 仓库无 `skills/` 目录、无 SkillRegistry 模块、无 skill schema、无 skill metadata 字段。
- `domain-registry.ts` 只是 domain plugin（TSF 一种），与 Skill 概念不重合。

**待研发（这是当前最大的结构性缺口）：**
1. 新增 `skills/` 顶层目录与若干 seed Skill：`stationarity_analysis/`、`seasonality_decomposition/`、`forecasting_baseline/`、`error_diagnosis/`、`report_generation/`。
2. `src/research/skills/registry.ts`：解析 skill.md 元数据 / 触发条件 / IO schema / 依赖工具。
3. Agent 在每个阶段先 query Skill Registry 取候选 Skill，再编排调用。
4. 任务结束后将"被采用"的 Skill + 失败案例回写 long-term memory，形成更新闭环。
5. 落 `skills/<name>/skill.md` 作为人可读 + 机器可读双向格式。

### G7. **Memory 仅有单任务实验记忆，缺少 short-term / session / long-term 三层结构**

**目标（§4.1 / §4.8.11）：** Memory as File Systems，三层：short-term（当前迭代）、session（当前任务全过程）、long-term（跨任务可复用：模型配方、数据模式、失败经验）。

**现状：**
- `ResearchMemory` SQL 表只有 per-task 记忆（fingerprintSummary、candidateSummary、outcome、lesson）。
- 没有跨任务召回机制（new task 来时不会基于历史 fingerprint 检索经验）。
- 文件系统记忆未明确：artifact 是产物，但没有 `session_summary.md`、`failure_log.md`、`skills_index.md` 等记忆维度文件。

**待研发：**
1. 新增 `long_term_memory` 表 + 服务方法 `recallByFingerprint(fingerprint)`，在 NAS baseline 初始化、reflection 阶段被调用。
2. Session 级压缩：每 N 轮自动生成 `session_summary.md`，限制上下文长度。
3. 把 long-term 经验写入 fingerprint 邻域召回的 prompt 模板，形成"经验注入"。

### G8. Companion 模式的 Human Checkpoints 仅在 intent 缺口处生效

**目标（§2.1.1 / §4.8.12）：** 在 `data_analysis_done`、`search_space_confirmed`、`experiment_budget_extended`、`final_model_selection`、`report_release` 等节点都应弹 Human Checkpoint，并以 "结论 + 候选 + 推荐动作" 三段式压缩呈现。

**现状：**
- `runFullPipeline` 只在 IntentAgent 发现缺口时挂起 approval；后续阶段一路自动跑完。
- TUI 有 approval 入口但不主动触发上述其它检查点。
- `recommendedAction` / `candidateOptions` 数据结构未建。

**待研发：**
1. 在 service 中按 `interactionMode === "companion"` 在 4 个关键节点插入 `ensurePendingApproval`。
2. 扩展 ResearchApproval 的 metadata：增加 `summary`、`options[]`、`recommended`，前端按结构化方式渲染。
3. 相应 TUI / web dashboard 增加 "Checkpoint Card" 组件。

### G9. **Model Recipe DSL 未对外暴露 / 未覆盖目标 schema**

**目标（§5.7.1）：** YAML DSL 至少覆盖 `task / interaction / data / features / model / training / evaluation / resource` 八大块，含 `exogenous_variables`、`calendar_features`、`decomposition_features`、`channel_strategy`、`parameter_budget`、`max_trials` 等字段。NAS Agent 的修改动作落在 DSL 字段上。

**现状：**
- 只有 internal `candidateSpec`（JsonRecord）与 `recipe_factory.py`，未对外提供独立 DSL 文件、未提供 yaml schema、未文档化字段集。
- Action space 不含外生变量、不含日历特征、不含 parameter_budget / latency_budget / max_trials 显式约束。

**待研发：**
1. 在 `neo_cast/schemas/recipe_dsl.schema.yaml` 出对外 DSL 标准；编译器 `recipe_bridge.py` 翻译为内部 candidateSpec。
2. Action space 扩展：`exogenous`（none / weather / calendar / event）、`calendar_features`（hour / weekday / holiday）、`channel_strategy`（independent / mixing）。
3. Budget schema 扩展：`max_trials`、`max_runtime_hours`、`max_params`、`max_latency_ms`，在 service 层强制校验。

### G10. **Failure recovery 体系尚未形成**

**目标（§4.9）：** "失败类型—检测信号—恢复动作—记录方式"四元组；显存不足 / NaN / 不收敛 / 数据泄露各有恢复策略；多次失败沉淀为新 Skill；产物 `failure_log.md`。

**现状：**
- 仅有 `maxCrashStreak`、`maxFailedCandidateRetries`、`runner` 异常透传。
- 没有结构化失败分类（OOM / NAN / NOT_CONVERGE / SCRIPT_ERROR / LEAKAGE）。
- 没有恢复策略表 / 没有 `failure_log.md` artifact / 没有失败 → Skill 沉淀链路。

**待研发：**
1. Runner 输出标准化错误码（`oom / nan / not_converge / script_error / dataset_error / leakage`）。
2. ReflectionAgent 读取错误码 → 选择恢复动作（缩 batch、降 lr、换 loss 等）→ 自动生成下一 candidate。
3. `failure_log.md` artifact 持续追加；同类失败 ≥3 次时建议生成 Skill。

### G11. Visualization & Report 嵌入度不足

**目标（§3.4 / §5.11）：** 报告需嵌入数据分析图、预测对比图、误差分布、消融、搜索过程。

**现状：**
- 没有 PNG 图表 artifact。
- `research_report_markdown` 主要罗列数字与 artifact 链接，未嵌图、未嵌训练曲线、未嵌 horizon-wise 对比。

**待研发：**
1. `neo_cast/py/plots.py` 输出固定命名的图表（ts_overview.png、acf.png、horizon_mse.png、search_trace.png）。
2. ReportAgent 渲染 markdown 时按相对路径引入。
3. 最终 bundle 复制图表到 release 包。

### G12. Governance & Benchmark 环境未建

**目标（§4.8.14 / §4.8.15）：** Governance 限制危险命令、保护测试集、审计；Benchmark 评估系统级指标（任务完成率、代码可运行率、复现率、平均搜索成本、人工介入次数、Skill 复用率）。

**现状：** 完全缺失，无 sandbox / no leak guard / no benchmark suite。

**待研发：**
1. Runner 端加白名单命令、禁止访问 `ref_test / blind_test` 数据切片（除非到对应 stage）。
2. 新增 `benchmarks/system_eval/`：跑 ETTh1 / ETTh2 / Electricity 三个标准任务的固定 protocol，记录系统级指标，生成 `system_benchmark_report.md`。

### G13. MCP / 工具协议层未标准化

**目标（§4.5）：** Agent 通过 MCP 风格协议调用所有工具。

**现状：** Python 侧通过 subprocess + JSON manifest，TS 侧直接函数调用，未标准化为 MCP 工具描述符。

**待研发（次优先级）：**
1. 把 `neo_cast/py` 的核心能力（profile / smoke / run / ref_test / blind_test / export）注册为 MCP server。
2. Agent 端通过 MCP client 调用，便于第三方工具接入。

### G14. Data Workspace 分区与版本控制薄弱

**目标（§4.8.3）：** raw / processed / metadata / split / version registry / leakage checker。

**现状：** `prepare-data` 输出固定切分但没有 zone 分层，没有 `dataset_version_registry.yaml`，`metadata.md` 不完整。

**待研发：** 引入 `data/raw, data/processed, data/metadata.md, data/dataset_versions.yaml`，并在所有训练命令记录数据版本指纹。

### G15. Project 目录结构与目标 §7 不一致

**目标 §7 推荐：**
```
neoresearch-session/
├── intent/intent_spec.md
├── data/{raw,processed,metadata.md}
├── analysis/{quantitative,qualitative,summary}
├── configs/{search_space,baseline,best_model}
├── skills/...
├── src/{models,data_pipeline,training,evaluation}
├── experiments/{experiment_log.md, leaderboard.md, reflection_notes.md}
├── checkpoints/, logs/, reports/, artifacts/
```

**现状：** 当前以 `.neo-cast/` + `.neo-research/` 隐藏目录组织，缺少 `intent/`, `analysis/`, `skills/`, `experiments/leaderboard.md`, `experiments/reflection_notes.md` 等可被人类直接 cd 浏览的产物。

**待研发：** Session bootstrap 时初始化目标目录骨架；每个 Agent 输出落到对应位置；不破坏现有 `.neo-cast/` 内部状态。

---

## 三、本次回顾相对前一版（2026-05-01）的进展

| 项 | 2026-05-01 状态 | 2026-05-02 状态 |
| --- | --- | --- |
| `agents/` 目录与 4 个 Agent 文件 | ❌ | ✅ 已新增（仍偏 summarizer） |
| Task status 扩展 | ❌ | ✅ idle/intent_gathering/data_analysis/searching/publishing 已加 |
| Agent 阶段事件 | ❌ | ✅ IntentAgent / DataAnalysisAgent / NASAgent / PublishAgent Started/Completed/Failed 均已发布 |
| `runFullPipeline` service 方法 | ❌ | ✅ 已落地，含 intent gap → approval 阻塞 |
| 数据分析三分文档 | ✅ markdown 三件套 | ✅ 仍三件套，并新增统一 `dataset_analysis_report` |
| `model_export_package` artifact kind | ❌ | ✅ 已加入 schema |

---

## 四、按价值与风险排序的研发优先级

### P0（决定 NeoResearch 是否真的能"自主科研"）

1. **G1 – Socratic IntentAgent**：从规则字段检查升级为 LLM 多轮追问；落 `intent_spec.md`。
2. **G4 – Reflection Agent**：补齐 NAS 后的反思闭环，否则迭代等同盲搜。
3. **G5 – Verifier Agent**：实现 leakage / overfitting / horizon-wise / cost-perf 多检查器，让 "improvement" 真正可信。
4. **G3.1/G3.2 – 数据驱动 NAS baseline + LLM proposal 接入 profile**：让数据分析真正影响搜索。

### P1（科研产物的可读性与可复用性）

5. **G6 – Skill 子系统**：先落最小 SkillRegistry + 5 个 seed Skill，避免后续每次 from scratch。
6. **G2 – LLM 定性分析 + 真实统计检验 + 图表**：报告才有领域价值。
7. **G9 – Model Recipe DSL**：让人 / Agent 都能稳定描述"配方"。
8. **G15 – 目录结构**：Session 落到目标 §7 结构，方便人类介入。

### P2（系统化 / 长期能力）

9. **G7 – 三层 Memory & 跨任务召回**。
10. **G10 – Failure Recovery 分类与 failure_log**。
11. **G8 – Companion 全节点 Human Checkpoints**。
12. **G11 – 图表嵌入报告**。
13. **G14 – Data workspace 分区与版本指纹**。

### P3（开放与基准）

14. **G12 – Governance / Benchmark 环境**。
15. **G13 – MCP 协议层标准化**。

---

## 五、与目标文档 §11 MVP 范围的对照

目标文档建议 MVP = 6 模块：IntentAgent / DataAnalysisAgent / BaselineSearch / ExperimentLogger / SimpleVerifier / FinalReport。

当前已具备：BaselineSearch（autonomous loop + 3 baselines）、ExperimentLogger（runs / artifacts / champion / leaderboard 数据）、FinalReport（research_report_markdown + final_bundle）。

**仍欠**：真正的 IntentAgent（G1）、真正的 DataAnalysisAgent（G2）、SimpleVerifier（G5 的轻量版）。

> 也即：完成 G1 + G2 + G5 的最小版即可宣称 MVP 闭环成立；当前大概率还差 **2–3 周** 的工程量。

---

## 六、附：建议的下一步动作

1. 把本文件 G1 / G4 / G5 / G6 拆成 4 个 issue / RFC。
2. 在 `agents/` 下新建 `reflection-agent.ts` 与 `verifier/`，先用 stub 跑通管线，再渐进填充逻辑。
3. 启动 `skills/` 目录与 1 个示例 Skill（建议 `seasonality_decomposition`），跑通 registry → agent 调用全链路。
4. 为 Socratic IntentAgent 设计独立 prompt + slot schema，并在 `tests/research/intent-agent.test.ts` 引入 LLM mock 用例。
5. 把目标文档 §7 目录结构作为 `make session-init` 输出，给后续所有产物一个稳定的归位。
