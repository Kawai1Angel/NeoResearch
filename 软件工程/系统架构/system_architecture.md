# NeoResearch 系统架构说明

## 1. 项目定位

NeoResearch 是一个基于 OpenCode fork 改造的 Research OS。

当前版本的目标不是继续做通用 coding agent，而是把 CLI、TUI、Web、Server、session、event、runtime 等基础设施重构为围绕研究任务运转的系统：

- 创建研究任务；
- 生成候选方案；
- 准备实验；
- 执行实验；
- 记录指标；
- 选择 champion；
- 沉淀 memory；
- 导出 artifact；
- 支持 agent 自主迭代。

当前第一个内置研究 domain 是 TSF，即 time series forecasting。对应 runner 是 Neo-Cast。

## 2. 顶层代码结构

当前代码主要分为两个目录：

```text
neo-research/
  opencode/   # NeoResearch OS 主体，基于 OpenCode fork 改造
  neo_cast/   # TSF / Neo-Cast domain runner
```

### 2.1 `opencode`

`opencode` 是 Research OS shell。

它负责：

- CLI；
- TUI Cockpit；
- Web Dashboard；
- Server / API；
- session / event；
- research task lifecycle；
- candidate lifecycle；
- run lifecycle；
- approval / governance；
- artifact / memory / champion；
- local file runtime；
- worker queue；
- worker execution result sync。

### 2.2 `neo_cast`

`neo_cast` 是 TSF domain runner。

它负责：

- TimeRecipe schema；
- candidate recipe 解析；
- Python model build；
- train / validate / ref-test / blind-test；
- probabilistic metrics；
- benchmark report；
- model export；
- JSONL runner events；
- artifact 文件输出。

## 3. 架构分层

当前 NeoResearch 可以理解为六层：

```text
┌──────────────────────────────────────────────┐
│ UI Layer                                     │
│ Web Dashboard / TUI Cockpit / CLI             │
├──────────────────────────────────────────────┤
│ Research API / Service Layer                  │
│ Task / Candidate / Run / Artifact / Memory    │
├──────────────────────────────────────────────┤
│ Domain Layer                                  │
│ ResearchDomain / TSF Domain / RunPlan         │
├──────────────────────────────────────────────┤
│ Runtime Layer                                 │
│ Queue / Worker / ArtifactStore / MetricsStore │
├──────────────────────────────────────────────┤
│ Runner Layer                                  │
│ Neo-Cast Python subprocess runner             │
├──────────────────────────────────────────────┤
│ Artifact & Memory Layer                       │
│ execution logs / metrics / champion / memory  │
└──────────────────────────────────────────────┘
```

## 4. UI Layer

UI Layer 有三个入口：

1. CLI；
2. TUI Cockpit；
3. Web Dashboard。

### 4.1 CLI

主要命令集中在：

```text
opencode/packages/opencode/src/cli/cmd/research.ts
```

当前已有命令包括：

- `research list`
- `research create`
- `research status`
- `research profile`
- `research seed`
- `research prepare`
- `research run`
- `research seed-sweep`
- `research iterate`
- `research loop`
- `research worker-once`
- `research worker-loop`
- `research artifacts`
- `research memory`
- `research approvals`
- `research request-ref-test`
- `research request-blind-test`
- `research request-shadow-holdout`
- `research approve`
- `research reject`
- `research export`

CLI 当前仍处在 OpenCode fork 的命令体系中。发布前需要决定是否改为 `neo-research` 或其他 bin 名。

### 4.2 TUI Cockpit

TUI Cockpit 负责终端内研究驾驶舱。

它覆盖：

- task 列表；
- task detail；
- candidate 列表；
- per-candidate prepare；
- per-candidate execute；
- seed sweep；
- autonomous iteration；
- autonomous loop；
- artifact；
- memory；
- profile summary；
- governance 状态。

相关代码主要在：

```text
opencode/packages/opencode/src/cli/cmd/tui/
```

### 4.3 Web Dashboard

Web Dashboard 是浏览器端研究看板。

它覆盖：

- task 创建；
- task 状态；
- candidate 操作；
- run 状态；
- metrics；
- champion；
- artifact；
- memory；
- profile；
- approval gate。

相关代码主要在：

```text
opencode/packages/app/src/pages/
```

## 5. Research Service Layer

Research Service 是系统核心业务层。

主要代码：

```text
opencode/packages/opencode/src/research/service.ts
opencode/packages/opencode/src/research/schema.ts
opencode/packages/opencode/src/research/research.sql.ts
```

它负责管理以下核心对象。

### 5.1 ResearchTask

ResearchTask 表示一个研究任务。

关键字段：

- task id；
- project id；
- title；
- domain id；
- mode；
- status；
- task spec；
- objective；
- budget。

当前支持两种 mode：

- `review`
- `autonomous`

### 5.2 ResearchCandidate

ResearchCandidate 表示一个候选实验方案。

关键字段：

- candidate id；
- task id；
- domain id；
- candidate spec；
- rationale；
- risk level；
- approval status；
- generator。

在 TSF domain 下，candidate spec 是 TimeRecipe 风格 recipe。

### 5.3 ResearchRun

ResearchRun 表示一次候选方案执行。

关键字段：

- run id；
- task id；
- candidate id；
- stage；
- status；
- metrics；
- resource usage；
- artifact refs；
- error；
- started / finished time。

当前 stage 包括：

- `baseline`
- `profile`
- `smoke`
- `low_fidelity`
- `full`
- `ref_test`
- `blind_test`

### 5.4 ResearchArtifact

ResearchArtifact 表示可追踪产物。

常见 artifact：

- `runner_plan_json`
- `runner_execution_log_json`
- `runner_artifact`
- `task_profile_json`
- `research_candidate_selection_json`
- `research_autonomous_loop_json`
- `research_report_markdown`
- `governance_log_json`

### 5.5 ResearchMemory

ResearchMemory 用于沉淀实验经验。

它记录：

- task fingerprint；
- candidate summary；
- outcome；
- lesson；
- domain id。

memory 会影响后续 autonomous proposal / ranking。

### 5.6 ResearchChampion

ResearchChampion 表示当前任务下最优候选。

当 succeeded run 的 primary metric 优于当前 champion 时，系统会更新 champion，并写入 memory。

### 5.7 ResearchApproval

ResearchApproval 表示治理审批。

当前支持：

- candidate approval；
- domain action approval；
- ref test approval；
- blind test approval；
- shadow holdout approval；
- budget approval。

## 6. Domain Layer

Domain Layer 把通用 Research OS 和具体研究领域解耦。

主要代码：

```text
opencode/packages/opencode/src/research/domain.ts
opencode/packages/opencode/src/research/domain-registry.ts
opencode/packages/opencode/src/research/domains/tsf.ts
```

### 6.1 ResearchDomain

ResearchDomain 负责定义某个领域的能力。

当前 TSF domain 提供：

- task summary；
- baseline candidates；
- candidate validation；
- candidate proposal；
- candidate ranking；
- run plan creation；
- run evaluation；
- profile support；
- privileged evaluation capability。

### 6.2 DomainRunPlan

DomainRunPlan 是 Research OS 到 runner 的核心契约。

它描述：

- domain id；
- runner id；
- runner kind；
- stage；
- approval required；
- validation；
- writes；
- command；
- expected events；
- expected metrics；
- expected artifacts；
- notes。

当前 TSF run plan 会把 TimeRecipe candidate 渲染成 Neo-Cast runner 可执行 payload。

## 7. TSF / TimeRecipe Domain

TSF domain 是当前第一个 domain。

核心文件：

```text
opencode/packages/opencode/src/research/domains/tsf.ts
```

TSF candidate schema 已经从旧的“选模型族 + 配模型参数”升级为 TimeRecipe 风格模块组合：

```text
preprocessing actions
embedding action
backbone action
fusion action
prediction head
training strategy
```

当前支持的 action 空间包括：

- patch；
- multiscale patch；
- invert；
- frequency；
- calendar；
- transformer；
- patch_mlp；
- dlinear；
- tcn；
- nbeats；
- timesnet；
- rnn；
- ssm；
- mixer；
- temporal fusion；
- feature fusion；
- graph fusion；
- gated hybrid fusion；
- direct multi-horizon head；
- quantile head；
- gaussian head；
- huber / quantile / distillation loss；
- one-cycle / plateau scheduler。

## 8. Runtime Layer

Runtime Layer 负责把 prepared run 从 Research Service 交给 worker 执行。

主要代码：

```text
opencode/packages/opencode/src/research/runtime.ts
```

核心组件包括：

- `ResearchJob`
- `ResearchQueueDriver`
- `FileResearchQueueDriver`
- `ArtifactStoreDriver`
- `FileArtifactStoreDriver`
- `MetricsStoreDriver`
- `FileMetricsStoreDriver`
- `FailureRecoveryPolicy`
- `runResearchWorkerOnce(...)`
- `executeSubprocessResearchJob(...)`
- `createFileResearchRuntime(...)`

### 8.1 prepareRun 入队

`Research.Service.prepareRun(...)` 会：

1. 校验 task；
2. 校验 candidate；
3. 检查 approval / governance；
4. 创建 queued run；
5. 生成 DomainRunPlan；
6. 写入 `runner_plan_json` artifact；
7. 转成 ResearchJob；
8. 入队到 `.neo-research/runtime/queue`。

### 8.2 worker-once

`research worker-once` 会：

1. 从 local file queue lease 一个 job；
2. 标记对应 run 为 running；
3. materialize plan writes；
4. 执行 Neo-Cast subprocess；
5. 解析 JSONL runner records；
6. 记录 file-runtime metrics；
7. 记录 file-runtime artifacts；
8. 写 `runner_execution_log_json`；
9. 创建 runner artifact；
10. 更新 run status；
11. 更新 metrics / resource usage；
12. 触发 champion / memory 更新。

### 8.3 worker-loop

`research worker-loop --max-jobs <N>` 会重复执行 worker-once 路径，直到：

- 达到 `max-jobs`；
- 或 queue idle。

它是 long-running supervisor 之前的 bounded local worker 基础。

## 9. Runner Layer：Neo-Cast Python

Neo-Cast Python runner 位于：

```text
neo_cast/py/
```

关键文件：

```text
neo_cast/py/validate.py
neo_cast/py/runner.py
neo_cast/py/train.py
neo_cast/py/factory/build_model.py
neo_cast/py/prepare_tsf.py
neo_cast/py/export.py
neo_cast/py/benchmark_report.py
```

### 9.1 validate.py

`validate.py` 负责 smoke validation。

它读取 candidate payload，解析 recipe，构建或验证模型，并输出 JSONL events。

### 9.2 runner.py

`runner.py` 负责更完整的 stage 执行，包括：

- run；
- ref-test；
- blind-test。

### 9.3 train.py

`train.py` 负责训练执行。

它已经支持：

- point forecast；
- quantile forecast；
- quantile loss；
- scheduler；
- resource summary；
- training summary artifact。

### 9.4 build_model.py

`factory/build_model.py` 是 TimeRecipe 到 PyTorch model 的核心实现。

它支持：

- patch / multiscale / invert / frequency / calendar embedding；
- transformer / rnn / ssm / mixer 等 backbone；
- feature / graph / gated hybrid fusion；
- direct / quantile / gaussian prediction head；
- output mixer；
- probabilistic forward path。

## 10. 端到端数据流

典型的 NeoResearch-TSF 执行流如下：

```text
User
  ↓
CLI / TUI / Web
  ↓
Research Service
  ↓
ResearchTask + ResearchCandidate
  ↓
DomainRegistry.createRunPlan(...)
  ↓
DomainRunPlan
  ↓
runner_plan_json artifact
  ↓
ResearchJob queue
  ↓
research worker-once / worker-loop
  ↓
Neo-Cast Python subprocess
  ↓
JSONL runner events
  ↓
metrics / resource usage / artifacts
  ↓
ResearchRun update
  ↓
Champion update
  ↓
Memory write
  ↓
Dashboard / Cockpit refresh
```

## 11. Governance 架构

Governance 由 Research Service 执行。

主要策略：

- review mode candidate approval；
- autonomous low-risk auto approval；
- domain action approval；
- stage promotion approval；
- ref test approval；
- blind test approval；
- blind/ref query limit；
- budget approval；
- shadow holdout approval；
- governance log artifact。

原则是：

> OpenCode/NeoResearch 在 enqueue 前完成治理检查，worker 只执行已授权 job，并保留审计记录。

## 12. Autonomous Research Loop

当前 autonomous loop 已具备基础闭环。

它包括：

- diagnostic / profile context；
- baseline seeding；
- heuristic frontier；
- candidate mutation；
- rank predictor artifact；
- memory-aware reranking；
- benchmark memory reranking；
- prepare + execute；
- result analysis；
- memory update；
- loop summary artifact。

当前还不是完整多角色 Research Manager。

长期目标是拆成：

- Diagnostic；
- Design；
- Coder；
- Runner；
- Analyst；
- Librarian。

## 13. Artifact 架构

Artifact 是 Research OS 的可审计产物层。

当前重要 artifact：

### runner_plan_json

记录一次 prepared run 的 DomainRunPlan。

### runner_execution_log_json

记录一次 runner execution 的：

- command；
- exit code；
- stdout；
- stderr；
- parsed JSONL records。

### runner_artifact

指向 Neo-Cast 输出目录。

### task_profile_json

记录 dataset profile 和 task fingerprint。

### research_candidate_selection_json

记录 candidate ranking / proposal / rank predictor features。

### research_report_markdown

导出的研究报告。

### governance_log_json

记录 approval 创建和回复。

## 14. Memory 架构

Memory 用于把实验结果转化为后续搜索经验。

当前 memory 来源：

- succeeded run；
- failed run；
- champion update；
- benchmark memory；
- autonomous iteration。

memory 会影响：

- candidate ranking；
- autonomous proposal；
- cross-task benchmark reuse。

## 15. 当前验证覆盖

最近验证覆盖包括：

- Research service tests；
- TSF domain tests；
- runtime tests；
- CLI research command tests；
- TUI cockpit data/render tests；
- Web dashboard helper tests；
- OpenCode typecheck；
- App typecheck；
- Neo-Cast Python tests；
- E2E shell dry-run。

最近一轮结果：

- OpenCode research / CLI / TUI 目标测试：102 pass；
- Web Dashboard helper 测试：16 pass；
- Neo-Cast Python 测试：57 tests OK；
- Typecheck：通过；
- E2E dry-run：通过。

## 16. 当前架构边界

当前系统已经形成清晰边界：

```text
opencode = Research OS
neo_cast = TSF Domain Runner
```

但两者之间还需要产品化：

- runner discovery；
- domain manifest；
- version contract；
- packaging strategy；
- npm install experience；
- domain plugin installer。

因此当前不建议把两个目录硬合并。

更合理的方向是让 `neo_cast` 成为第一个正式 domain plugin。

## 17. 后续演进方向

建议后续演进：

1. Release hardening；
2. NeoResearch package / bin 重命名；
3. Neo-Cast runner discovery；
4. domain manifest；
5. npm alpha packaging；
6. Web/TUI 真实截图验收；
7. long-running worker supervisor；
8. production queue / object store / metrics backend；
9. 多角色 Research Manager；
10. 多 domain plugin abstraction。

## 18. 一句话总结

NeoResearch 当前架构已经从 OpenCode fork 演化为 Research OS + TSF runner 的本地 alpha 系统：`opencode` 负责研究任务、UI/API、governance、runtime 和 memory，`neo_cast` 负责 TSF 实验执行；两者通过 DomainRunPlan、ResearchJob、JSONL events、metrics 和 artifacts 连接。
