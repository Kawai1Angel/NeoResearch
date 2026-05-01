# NeoResearch Vibe Data Science(TSF) 系统代码 Review（含 Bug）

日期：2026-05-01

## 结论

当前 NeoResearch 已经具备 Time Series Forecasting 方向的本地 alpha 能力：可以创建 TSF research task、做轻量数据 fingerprint、生成/筛选候选模型、调用 Neo-Cast runner 训练、记录 run/artifact/memory/champion，并导出 markdown 研究报告。

但它还没有完整实现“Vibe Data Science”的端到端产品闭环。主要问题不是单点算法能力，而是流程编排与跨组件状态一致性：自然语言需求没有真正转成 task spec，数据准备没有和 runner 数据契约打通，自治循环没有“足够好/平台期/时间预算”停止策略，最终交付也没有把报告、模型代码、训练参数和权重打成统一 bundle。

按当前代码状态评估：

| 层级 | 完成度 | 判断 |
|---|---:|---|
| TSF local alpha 能力 | 75%-85% | 单项能力大多存在，可手动串起来 |
| Vibe Data Science 端到端产品 | 55%-65% | 关键闭环缺少统一 orchestrator 和质量停止策略 |
| 可稳定发布给外部用户 | 35%-45% | 数据契约、失败重试、最终交付和一键体验仍有 P0/P1 缺口 |

## 修复状态（2026-05-01）

本轮已按本文 P0/P1 问题逐项修复，并补充了对应回归测试。原问题描述保留在下文，作为审计记录。

| 编号 | 状态 | 修复摘要 |
|---|---|---|
| P0-1 | 已修复 | 新增 goal 解析能力，TUI home prompt 和 CLI `research vibe` 可从自然语言/结构化文本中提取 CSV path、target、horizon、context、preset、max runs、time budget，并生成 TSF task spec。 |
| P0-2 | 已修复 | 新增 `prepareTaskDataset()` 服务与 `/research/tasks/:taskID/prepare-dataset` API，调用 Neo-Cast `prepare-data`，持久化 `dataset_preparation_json` artifact；TUI readiness 会校验 prepared dataset spec 与 task spec 是否一致。 |
| P0-3 | 已修复 | `AutonomousLoopInput` 增加 target metric、minimum improvement、plateau、time budget、crash streak 等策略；loop 可返回 `target_reached`、`plateau`、`time_budget_exhausted`、`crash_streak_exceeded`。 |
| P0-4 | 已修复 | 新增 `research_final_bundle` export，统一输出 report、runs、candidates、champion、artifacts、memory、trace、manifest，并复制 champion 模型代码/权重/metadata 到最终 bundle。 |
| P1-1 | 已修复 | TUI home prompt 路径改为 `parse goal -> create task -> prepare dataset -> profile -> autonomous loop`，不再绕过 profile/prepare 直接跑 iterate。 |
| P1-2 | 已修复 | 候选 attempted 集合改为 retry-aware；失败候选默认允许一次重试，避免 transient runner 失败永久消耗候选探索空间。 |
| P1-3 | 已修复 | runner readiness 增加 dataset contract 维度，区分缺失 dataset spec、dataset spec mismatch、runtime/script/python readiness。 |
| P1-4 | 已修复 | existing ready frontier 也会写 candidate-selection ranking artifact，记录确定性选择依据。 |
| P1-5 | 已修复 | failed run 的 manager trace 不再标记 runner/analyst completed；runner 写 blocked，缺 metric 时 analyst 写 skipped。 |
| P2-1 | 部分增强 | TSF profile 增加 outlier rate、timestamp column、duplicate timestamp rate、monotonic timestamp、irregular interval ratio 等诊断字段；完整图表/STL/ACF/PACF 仍属于后续增强。 |
| P2-2 | 已修复 | 新增 CLI `research vibe <goal...>` 一键 pipeline：创建 task、prepare dataset、profile、autonomous loop、export final bundle。 |

## P0 Findings

### P0-1：自然语言需求没有真正解析为 TSF task spec

用户从 TUI home 输入一个 research goal 时，`createTaskFromPrompt()` 固定调用 `buildDefaultTsfResearchTask("autonomous", ...)`，只把原始文本放入 `metadata.userPrompt`，没有解析 dataset path、horizon、context、target、resource budget、objective 等字段。

证据：

- `opencode/packages/opencode/src/cli/cmd/tui/routes/research-cockpit.tsx:952` 创建 prompt task。
- `opencode/packages/opencode/src/cli/cmd/tui/routes/research-cockpit.tsx:954` 使用默认 TSF task。
- `opencode/packages/opencode/src/cli/cmd/tui/routes/research-cockpit.tsx:960`-`967` 只写入 `metadata.userPrompt`。
- `opencode/packages/opencode/src/cli/cmd/tui/routes/research-cockpit-data.ts:881`-`910` 默认 task 固定为 `contextLength=96`、`predictionLengths=[24]`、`loaderID=etth1_tslib_v1`、`targetCols=["OT"]`。

影响：

用户说“用某个 CSV、预测 96、资源限制 10 分钟、目标列 HUFL”时，prompt 路径不会自动生效。只有 `New CSV Task` 对话框会解析结构化输入。这不满足“从用户需求提出”自动进入 Data Science 流程的要求。

建议：

新增 `parseResearchGoalToTaskSpec()` 或 LLM/规则混合 extractor，把自然语言 goal 解析成 `CreateResearchTaskInput`。至少要覆盖 dataset path、target、horizon、context、preset、forecast mode、max runs、max training seconds、metric。

### P0-2：数据 profile 使用 task.dataset.path，但 Neo-Cast 训练使用 `.neo-cast/dataset_spec.json`，两者可能不一致

NeoResearch 的 TSF profile 直接读取 `task.taskSpec.dataset.path`；Neo-Cast runner 的训练/验证通过 `prepare_tsf.py` 模块加载 `.neo-cast/dataset_spec.json` 和 materialized splits。当前 opencode 侧没有在 create/profile/iterate 之间调用 `neo-cast prepare-data`，也没有校验 runner dataset spec 是否与 task spec 匹配。

证据：

- `opencode/packages/opencode/src/research/domains/tsf.ts:1062`-`1129` 的 `profileTSFDataset()` 直接读取 `task.dataset.path`。
- `opencode/packages/opencode/src/research/service.ts:3011`-`3027` 的 `profileTask()` 只写 `.neo-research/profile/.../task-profile.json`。
- `opencode/packages/opencode/src/research/domains/tsf.ts:893`-`899` 的 run plan 只写 current candidate payload，不写 dataset spec。
- `neo_cast/src/cli.js:302`-`340` 存在 `prepare-data` 命令，但 opencode 流程没有自动调用。
- `neo_cast/py/prepare_tsf.py:62`-`76` 在模块加载时从 dataset contract 读取 active spec。
- `opencode/packages/opencode/src/cli/cmd/tui/routes/research-cockpit-data.ts:616`-`728` 的 runner readiness 只检查 root、script、python version，不检查 dataset spec/splits。

影响：

可能出现“NeoResearch profile 的是 A.csv，但 Neo-Cast runner 实际训练的是旧的 B dataset spec”的严重错误。这个错误会污染实验指标、champion 选择和最终报告。

建议：

新增 `prepareDatasetForTask()` 服务步骤：

1. 从 `taskSpec.dataset`、`contextLength`、`predictionLengths`、`targetCols` 生成 `neo-cast prepare-data` 参数。
2. 执行 `node ./bin/neo-cast.js prepare-data --source ...`。
3. 将 dataset spec fingerprint 写入 ResearchArtifact。
4. `runnerReady` 增加 dataset contract readiness：`.neo-cast/dataset_spec.json` 必须存在，并且 source/path/horizon/target/context 与 task spec 匹配。

### P0-3：NeoResearch 自治循环没有“足够好/平台期/时间预算”停止策略

Neo-Cast CLI loop 已有 `maxNoImprove`、time budget、crash streak 等停止条件，但 NeoResearch opencode service 的 `runAutonomousLoop()` 只有三种停止原因：`max_iterations`、`budget_exhausted`、`approval_required`。

证据：

- `opencode/packages/opencode/src/research/service.ts:115` 停止原因类型只有三种。
- `opencode/packages/opencode/src/research/schema.ts:466`-`470` 的 `AutonomousLoopInput` 只支持 `maxIterations`。
- `opencode/packages/opencode/src/research/service.ts:2808`-`2843` 只按 iteration count、run budget、approval gate 停止。
- `neo_cast/src/loop.js:35`-`58` 已有 `time_budget_exhausted`、`max_candidates_reached`、`no_improve_plateau`、`crash_streak_exceeded`，但没有被 NeoResearch service 暴露为统一策略。

影响：

系统现在只能“跑 N 轮然后停”，不能表达“直到不错的小模型”这个产品语义。用户需要的应该是 target metric、相对提升阈值、平台期轮数、最大时长、失败熔断共同决定停止。

建议：

扩展 `AutonomousLoopInput` 和 task budget：

- `targetMetricValue`
- `minRelativeImprovement`
- `maxNoImprove`
- `timeBudgetSeconds`
- `maxCrashStreak`
- `requireChampionBeforeStop`

并在 `runAutonomousLoop()` 中基于 champion/run history 判断 `target_reached`、`plateau`、`time_budget_exhausted`、`crash_streak_exceeded`。

### P0-4：最终 export 只有 markdown report，没有统一交付 bundle

Neo-Cast 训练 artifact 本身会生成模型权重、代码、推理脚本和元数据；但 NeoResearch 的 `exportTaskArtifact()` 只输出 markdown report，不会把 champion 的 artifact 目录汇总成一个最终交付包。

证据：

- `opencode/packages/opencode/src/research/service.ts:2937`-`3008` 的 `exportTaskArtifact()` 写出 `research-report.md` 并记录 `research_report_markdown`。
- `neo_cast/py/export.py:657`-`685` 会在 runner artifact 中生成 `metadata.json`、`model_impl.py`、`inference.py`、`model_spec.json`、`patch_bundle.json`、`README.md` 等文件。
- `neo_cast/py/export.py:24` 声明 `model.pt`，runner artifact 中存在训练权重。
- `opencode/packages/opencode/test/research/service.test.ts:1516`-`1565` 的 export 测试也只断言 markdown report。

影响：

用户要求的“实验结果、实验报告、小模型代码和训练好的参数”没有以 NeoResearch 的最终产物形式交付。现在需要用户自己去 runner artifact 目录拼装。

建议：

新增 `exportFinalBundle()`：

- `report/research-report.md`
- `results/runs.json`
- `results/champion.json`
- `model/model.pt`
- `model/model_impl.py`
- `model/inference.py`
- `model/model_spec.json`
- `model/preprocess.json`
- `trace/autonomous-loop.json`
- `manifest.json`

并在 TUI 中将 `Export Report` 改为 `Export Bundle`，或同时提供两个动作。

## P1 Findings

### P1-1：从 home prompt 创建任务后会直接提交 autonomous iterate，绕过显式 profile/prepare 阶段

`createTaskFromPrompt()` 在创建 task 后，如果 runner ready，会立即调用 `/autonomous/iterate` 跑 smoke。这个路径没有先调用 `profileTask()`，也没有调用 Neo-Cast `prepare-data`。

证据：

- `opencode/packages/opencode/src/cli/cmd/tui/routes/research-cockpit.tsx:976`-`987` 创建 task 后直接 POST `/autonomous/iterate`。
- `opencode/packages/opencode/src/research/service.ts:2508`-`2524` 的 `runAutonomousIteration()` 会做 in-memory fingerprint，但不会 materialize dataset。

影响：

UI checklist 说先 profile dataset，再 design/run；实际 prompt 路径可能先 run。结合 P0-2，会放大 dataset mismatch 风险。

建议：

home prompt 路径应改为：

`parse goal -> create task -> prepare dataset -> profileTask -> seed baselines -> autonomous loop`

如果缺 dataset path 或 runner dataset 未就绪，应停在可解释的 setup 状态，而不是直接 run。

### P1-2：失败 run 会让 candidate 永久进入 attempted 集合，自治循环不会重试

`runAutonomousIteration()` 和 `getAutonomousLoopStopReason()` 用所有 runs 的 `candidateID` 构造 attempted set，没有区分 succeeded/failed/crash/timeout。一次 transient runtime failure 会让该 candidate 被跳过。

证据：

- `opencode/packages/opencode/src/research/service.ts:2533`-`2548` 从所有 runs 收集 `attemptedCandidateIDs` 并排除候选。
- `opencode/packages/opencode/src/research/service.ts:2789`-`2797` loop stop 判断也用所有 runs 排除 ready candidate。
- `opencode/packages/opencode/src/research/service.ts:2258`-`2270` runner 非零退出会更新 run 为 `failed`，但 `executePreparedRun()` 正常返回。

影响：

环境抖动、timeout、runtime 未初始化、CSV 读取失败等错误会被当成“该架构已尝试”，而不是“执行失败可重试”。这会降低搜索质量，并且让系统更难从临时故障恢复。

建议：

增加 retry policy：

- succeeded/discarded/accepted 才计入 final attempted。
- failed 根据 `errorKind` 和 retry count 决定是否重试。
- runtime/dataset setup 类错误应阻断 loop，不应消耗候选探索预算。

### P1-3：runner ready 不代表 dataset ready

TUI 当前 `runnerReady()` 只说明 Neo-Cast root、python、validate.py 可用；不说明数据已经 prepare，也不说明 `.neo-cast/dataset_spec.json` 匹配当前 task。

证据：

- `opencode/packages/opencode/src/cli/cmd/tui/routes/research-cockpit-data.ts:667`-`728` 只验证 runner script 和 python version。
- `opencode/packages/opencode/src/cli/cmd/tui/routes/research-cockpit.tsx:1033`、`1486` 等多处用 `runnerReady()` 开启 agent/run 操作。

影响：

用户看到“Agent Loop 可运行”，但实际 runner 可能用错数据或 smoke 失败。这属于交互层误导。

建议：

把 readiness 拆成：

- `runnerConfigured`
- `runtimeReady`
- `datasetPrepared`
- `datasetMatchesTask`
- `candidateExecutable`

TUI 只在全部满足时开启训练动作。

### P1-4：已有候选的选择缺少 ranking 解释

`runAutonomousIteration()` 只有在没有 existing ready candidate 时才调用 `DomainRegistry.rankCandidateProposals()`。如果已有候选可跑，系统直接取第一个 ready candidate，selection artifact 里的 `rankings` 为空。

证据：

- `opencode/packages/opencode/src/research/service.ts:2550`-`2555` 初始化 `rankings=[]`。
- `opencode/packages/opencode/src/research/service.ts:2555`-`2616` 只有 `!candidate` 时才计算 rankings。
- `opencode/packages/opencode/src/research/service.ts:2647`-`2673` 后续 trace 记录 ranking count，但已有候选路径会是 0。

影响：

报告无法解释“为什么先跑这个候选”。这削弱了自主研究过程的可审计性。

建议：

对 existing frontier 也执行 ranking，或者至少记录 deterministic policy，例如 `oldest_auto_approved_unattempted`、`best_predicted_utility`。

### P1-5：失败 run 的 manager trace 仍显示 runner/analyst completed

`executePreparedRun()` 对 runner 非零退出会把 run 标为 failed，但 `runAutonomousIteration()` 后续仍然写入 `runner completed` 和 `analyst completed`。

证据：

- `opencode/packages/opencode/src/research/service.ts:2258`-`2270` 非零退出会生成 failed run。
- `opencode/packages/opencode/src/research/service.ts:2706`-`2714` 无条件写 runner `completed`。
- `opencode/packages/opencode/src/research/service.ts:2717`-`2728` 无条件写 analyst `completed`。

影响：

UI 和报告会显得“执行和分析成功完成”，但实际没有有效 metric。这会干扰用户判断系统状态。

建议：

根据 `executed.run.status` 写 trace：

- `succeeded` -> runner/analyst completed
- `failed` -> runner failed，analyst skipped 或 failed
- 无 primary metric -> analyst status 应为 skipped，并记录原因

## P2 Findings

### P2-1：数据自动分析还偏轻量，不足以称为完整定性+定量分析

当前 `profileTSFDataset()` 已有 row count、missing rate、trend/seasonality/correlation/distribution shift 等 heuristic，但还没有 TSF 常见的数据诊断能力：频率识别解释、重复/乱序时间戳、异常值、ACF/PACF、STL 分解、train/val/test 漂移、泄漏检查、图表和自然语言 diagnosis。

证据：

- `opencode/packages/opencode/src/research/domains/tsf.ts:1062`-`1129` profile 字段有限。

影响：

候选设计已经会消费 `searchBiases`，但这个 fingerprint 还不足以稳定驱动高质量模型假设。

建议：

把 Neo-Cast `prepare-data` 中已有的 timestamp/missing/irregular 分析和 NeoResearch profile 合并，并新增 profile markdown/html artifact。

### P2-2：没有顶层 `vibe` / one-click pipeline 命令

代码中没有独立的 `vibe` 命令或 service API，把 create、prepare、profile、seed、loop、export bundle 串成一个可复用流程。现在用户需要通过 TUI 多个动作或 API 调用拼接。

证据：

- 对 `opencode/packages/opencode/src`、`neo_cast/src`、`neo_cast/py` 搜索 `vibe` 没有命中。

影响：

系统有很多零件，但不是一个“提出需求 -> 自动产出研究结果”的产品化入口。

建议：

新增 `neo-research vibe tsf` 或 `research/vibe/run`：

`goal + dataset + resource budget -> final bundle path`

并让 TUI home 的 submit 调用这个 pipeline，而不是只创建默认 task。

## 需求链路完成度矩阵

| 用户要求环节 | 当前实现 | 完成度 | 主要问题 |
|---|---|---:|---|
| 用户需求提出 | TUI prompt、CSV dialog、task API | 部分完成 | prompt 不解析 task spec |
| data 自动定性与定量分析 | `profileTask()` + TSF fingerprint | 部分完成 | 分析浅，未和 prepare-data 合并 |
| 自主假设 | seed baselines、domain proposal、LLM proposal、memory | 基本完成 | 依赖 profile 质量，trace 可解释性不足 |
| 规划小模型设计 | TSF recipe schema、Neo-Cast factory、多 backbone/fusion/head | 基本完成 | prompt/factory action space 已对齐，但候选选择 ranking 有缺口 |
| 按资源训练 | Neo-Cast runner、max epochs/time budget、run budget | 部分完成 | runner dataset readiness 未被 NeoResearch 验证 |
| 自主迭代一步模型设计 | `runAutonomousIteration()`、`runAutonomousLoop()` | 部分完成 | 缺 good-enough/plateau/time stop；失败重试弱 |
| 迭代出不错的小模型 | champion、utility、memory | 部分完成 | “不错”没有目标条件，只能按固定轮数停止 |
| 输出实验结果 | run metrics、runner logs、report markdown | 部分完成 | 没有统一结果 bundle |
| 输出实验报告 | `research-report.md` | 基本完成 | markdown 可用，但需要关联最终 bundle |
| 输出小模型代码 | Neo-Cast artifact 有 `model_impl.py`、`inference.py` | 部分完成 | NeoResearch export 未汇总 |
| 输出训练参数/权重 | Neo-Cast artifact 有 `model.pt`、metadata | 部分完成 | NeoResearch export 未汇总 |

## 建议修复顺序

1. **先修数据契约桥接**：实现 `prepareDatasetForTask()`，并让 runner readiness 校验 dataset spec 与 task spec 一致。
2. **实现 one-click Vibe TSF pipeline**：`goal -> parse task -> prepare data -> profile -> seed/design -> loop -> final bundle`。
3. **补自治循环停止策略**：target metric、no-improve plateau、time budget、crash streak、minimum improvement。
4. **实现最终 bundle export**：把 report、runs、champion、Neo-Cast artifact 统一复制/索引到 `.neo-research/final/<taskID>/`。
5. **修失败重试和 trace 语义**：failed run 不应默认永久消耗 candidate；trace 状态要反映真实失败。
6. **增强数据 profile**：合并 prepare-data profile，补 TSF 诊断图表和自然语言 diagnosis。
7. **增强 prompt extractor**：让 home prompt 可以真正创建 dataset-backed task。

## Review 过程

本次 review 采用静态代码审计为主，重点检查了以下入口：

- TUI task 创建和 prompt 提交：`research-cockpit.tsx`
- TUI workflow/readiness：`research-cockpit-data.ts`
- Research service：`service.ts`
- TSF domain/profile/run plan：`domains/tsf.ts`
- Neo-Cast CLI/loop/runner/export：`neo_cast/src/cli.js`、`neo_cast/src/loop.js`、`neo_cast/py/runner.py`、`neo_cast/py/export.py`

未发现 LLM prompt action space 仍缺 rnn/ssm/mixer 的旧问题；`neo_cast/src/llm.js` 当前已经列出 rnn、ssm、mixer、graph、gated_hybrid、quantile、gaussian 等能力。

修复后验证命令：

```bash
/Users/chengmingyue/.bun/bin/bun run typecheck
/Users/chengmingyue/.bun/bin/bun test test/cli/tui/research-cockpit-render.test.tsx test/cli/tui/renderer-config.test.ts --timeout 30000
/Users/chengmingyue/.bun/bin/bun test test/research/service.test.ts test/research/tsf-domain.test.ts test/cli/research-data.test.ts test/cli/tui/research-cockpit-data.test.ts --timeout 30000
node --test test/e2e.test.js test/loop.test.js test/llm-prompt.test.js
uv run pytest py/tests/test_dataset_presets.py py/tests/test_e2e_contract.py py/tests/test_export_contract.py
git diff --check
```

结果：

- typecheck：通过。
- TUI render/config：38 pass，0 fail。
- Research service / TSF domain / CLI data / cockpit data：99 pass，0 fail。
- Neo-Cast Node tests：13 pass，0 fail。
- Neo-Cast Python contract tests：10 pass，0 fail。
- `git diff --check`：通过。

总体判断：P0/P1 的端到端阻塞问题已补齐，NeoResearch 已具备更接近“Vibe Data Science for TSF”的本地闭环能力；P2-1 的深度数据诊断仍可继续增强。
