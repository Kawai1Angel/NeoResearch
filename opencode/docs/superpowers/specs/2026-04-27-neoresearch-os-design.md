# NeoResearch OS on OpenCode Fork：设计说明

日期：2026-04-27

## 1. 背景

目标是直接 fork OpenCode，并把它从通用 coding agent 产品重构为通用 Research OS。第一版内置 TSF / Neo-Cast 作为第一个 domain plugin，但架构需要为后续接入其他科研领域保留清晰边界。

当前 Neo-Cast 已经具备候选驱动 runtime、CandidateRecipe、TSF 数据协议、训练评估、runner、artifact 导出等能力。OpenCode 则具备成熟的 provider、server、event bus、session、TUI/Web、permission、tool registry、plugin/MCP 基础。NeoResearch 应复用 OpenCode 的 agent runtime 基建，但把默认产品对象从 coding session 切换为 research task。

## 2. 设计目标

- 把 OpenCode fork 改造成 Research-first 产品，而不是在原产品里增加一个小功能。
- 保留 TUI + Web + CLI + Server API，所有入口共用同一套 research task / run / event / artifact API。
- Web 默认是 Research Dashboard，TUI 默认是 Research Cockpit。
- 支持两种交互模式：
  - Review Mode：Agent 提出候选和实验计划，Human 批准后执行。
  - Autonomous Mode：Human 批准任务和预算后，Agent 在预算内自主 propose / run / evaluate / memory，关键节点请求批准。
- 第一版内置 TSF domain plugin，跑通 CandidateRecipe -> smoke/full train -> metrics -> champion -> memory -> artifact 的自主研究闭环。
- 保留 OpenCode 原有 coding tools 作为 debug/admin 能力，但不再作为默认主体验。

## 3. 非目标

- v0.1 不追求支持所有科研领域，只要求 domain plugin 抽象足够稳定。
- v0.1 不追求完整替换 OpenCode 所有旧 session/UI 代码，可以先隐藏或降级旧 coding 入口。
- v0.1 不做论文写作 Agent、开放式文献综述 Agent 或生产部署平台。
- v0.1 不要求多租户企业治理，只保留未来可扩展的权限和审计边界。

## 4. OpenCode 改造边界

保留并复用：

- `provider`：模型供应商、认证、模型配置。
- `server`：统一 HTTP/API 和事件流。
- `bus/event`：运行态事件广播。
- `permission`：作为 research approval policy 的底层机制。
- `storage/session`：迁移为 research task / run / memory 的持久层。
- `TUI/Web`：保留渲染和订阅事件的技术基础，重做信息架构。
- `plugin/MCP`：后续用于 domain plugin 和 artifact tool 扩展。

弱化或迁移：

- `bash/read/edit/write/apply_patch` 等 coding tools 不再是主入口，只在 debug/admin agent 中启用。
- 原来的 chat-to-edit-code 体验迁入 legacy/debug namespace。
- 原 coding prompt 和 agent mode 不再作为默认启动路径。

新增核心目录建议：

```text
packages/opencode/src/research/
  task/
  run/
  domain/
  candidate/
  evaluator/
  memory/
  artifact/
  approval/
  orchestrator/
  event/
```

产品默认路径切换为 NeoResearch。旧 OpenCode coding session 可以保留在隐藏命令或 debug mode 中，避免第一阶段大面积删除带来不必要风险。

## 5. 核心数据模型

NeoResearch 的业务核心不再是 `Session -> Message -> Part`，而是：

```text
ResearchTask
  -> ResearchRun
  -> Candidate
  -> Evaluation
  -> Champion
  -> Artifact
  -> MemoryItem
```

OpenCode session 仍可作为用户和 Agent 的交互容器：

```text
ResearchSession = 围绕某个 ResearchTask 的交互、日志和事件流
ResearchTask = 可独立运行、评估和复现的科研任务实体
```

核心实体：

```ts
type ResearchTask = {
  id: string
  title: string
  domainId: string
  taskSpec: unknown
  objective: ResearchObjective
  mode: "review" | "autonomous"
  status: "created" | "profiling" | "baselining" | "researching" | "paused" | "completed" | "failed"
  budget: ResearchBudget
  createdAt: string
  updatedAt: string
}

type Candidate = {
  id: string
  taskId: string
  parentCandidateId?: string
  domainId: string
  candidateSpec: unknown
  rationale: string
  riskLevel: "low" | "medium" | "high"
  approvalStatus: "pending" | "approved" | "auto_approved" | "rejected"
  generatedBy: "llm" | "heuristic" | "mutation" | "human"
}

type ResearchRun = {
  id: string
  taskId: string
  candidateId: string
  stage: "profile" | "baseline" | "smoke" | "low_fidelity" | "full" | "ref_test"
  status: "queued" | "running" | "succeeded" | "failed" | "rejected"
  metrics: Record<string, unknown>
  resourceUsage: Record<string, unknown>
  artifactRefs: string[]
}

type Champion = {
  taskId: string
  candidateId: string
  runId: string
  primaryMetric: number
  utility: number
  acceptedAt: string
}

type MemoryItem = {
  id: string
  taskId: string
  domainId: string
  fingerprintSummary: Record<string, unknown>
  candidateSummary: Record<string, unknown>
  outcome: "accepted" | "rejected" | "failed"
  lesson: string
}
```

Research state 必须从这些实体推导，不能依赖聊天历史反推。

## 6. Domain Plugin 抽象

NeoResearch 是通用 Research OS，domain plugin 负责领域特定逻辑。第一版只内置 TSF，但接口按通用形式设计。

```ts
interface ResearchDomain {
  id: string
  displayName: string
  schemas: DomainSchemas
  createTask(input: unknown): Promise<TaskSpec>
  profileTask(task: ResearchTask): Promise<TaskFingerprint>
  buildBaselines(task: ResearchTask): Promise<Candidate[]>
  proposeCandidates(input: ProposalInput): Promise<Candidate[]>
  validateCandidate(candidate: Candidate): Promise<ValidationResult>
  runCandidate(input: RunInput): Promise<RunResult>
  evaluateRun(input: EvaluationInput): Promise<EvaluationResult>
  compareChampion(input: ChampionInput): Promise<ChampionDecision>
  writeMemory(input: MemoryInput): Promise<MemoryItem>
  exportArtifact(input: ArtifactInput): Promise<ArtifactRef>
}
```

TSF domain plugin 对应 Neo-Cast：

- `TaskSpec`：数据集、horizons、context length、目标列、预算、评估协议。
- `CandidateSpec`：CandidateRecipe。
- `Evaluator`：val/ref-test MSE/MAE、utility、Pareto。
- `ArtifactExporter`：模型 checkpoint、metadata、preprocess、inference、MCP forecast tool。

Domain plugin 不直接控制 UI。UI 只消费统一的 research API 和 domain-provided schema metadata。

## 7. 两种运行模式

### Review Mode

流程：

```text
Task created
-> Domain profiler
-> Baseline
-> Agent proposes Candidate
-> Human reviews candidate and run plan
-> Approved candidate enters smoke/full run
-> Evaluation updates champion and memory
-> Agent proposes next candidate
```

Review Mode 适合早期任务、高风险实验、预算敏感场景。TUI/Web 需要清晰显示 candidate diff、预估成本、风险原因和批准按钮。

### Autonomous Mode

流程：

```text
Human approves task + budget + policy
-> Agent loops within budget
-> Low-risk candidates auto-approved
-> Smoke/full run
-> Evaluation and champion update
-> Memory update
-> Stop on budget, convergence, crash streak, or human stop
```

Autonomous Mode 的审批策略：

- ref-test / blind-test 查询必须人工批准。
- 超预算、使用新 domain action、修改评估协议必须人工批准。
- 低风险候选可自动批准。
- 连续 crash 达到阈值自动暂停。

## 8. Research Orchestrator

OpenCode 原 SessionPrompt / SessionProcessor 处理的是 LLM stream 和 tool call。NeoResearch 需要新增 ResearchOrchestrator，处理 research loop。

核心循环：

```text
load task state
load task/domain memory
ask domain proposer or LLM proposer for candidates
validate candidate
apply approval policy
run smoke
run full if smoke passes
evaluate metrics
compare champion
write memory
emit events
repeat until stop condition
```

Orchestrator 输出结构化 ResearchEvent，而不是依赖任意文本：

- `task.created`
- `task.profiled`
- `candidate.proposed`
- `approval.requested`
- `run.started`
- `run.metric`
- `run.finished`
- `champion.updated`
- `memory.written`
- `artifact.exported`
- `task.paused`
- `task.completed`

OpenCode 的 event bus 可以继续承载这些事件。

## 9. TUI 和 Web

### TUI：Research Cockpit

TUI 默认面向实时操作：

- 当前 task 状态。
- Agent 当前步骤。
- 候选队列。
- 审批请求。
- 最新 run 日志和指标。
- 当前 champion。
- Stop / pause / approve / reject 操作。

TUI 不是完整分析平台，重点是快速监督和干预。

### Web：Research Dashboard

Web 默认面向总览和分析：

- Task list。
- 单 task dashboard。
- Runs table。
- Metrics trend。
- Champion / challenger 对比。
- Candidate lineage。
- Artifact browser。
- Memory / lessons。

Web 通过同一 server API 和 event stream 读取状态，不直接调用 domain runner。

## 10. TSF v0.1 Vertical Slice

第一版内置 `domainId = "tsf"`，目标是跑通完整自主研究闭环。

TSF v0.1 能力：

- 创建 TSF ResearchTask。
- 绑定本地 CSV 或现有 Neo-Cast dataset contract。
- 生成 TaskFingerprint。
- 运行 NLinear baseline。
- 让 Agent 生成 CandidateRecipe。
- 支持 Review / Autonomous 两种 mode。
- 运行 smoke/full train。
- 记录 val metrics。
- 更新 champion。
- 写 memory。
- 导出 artifact。

TSF v0.1 的 CandidateRecipe 初始 action space：

- preprocessing：`none`, `instance_norm`, `series_decomposition`
- embedding：`none`, `patch`, `multiscale_patch`
- backbone：`linear`, `mlp`, `transformer`, `dlinear`, `tcn`
- fusion：`temporal`
- head：`linear`
- loss：`mse`, `huber`
- optimizer：`adam`, `adamw`

可以先从 Neo-Cast 现有 Python runtime 迁入或作为子进程调用，再逐步收敛为 OpenCode fork 内部 domain runner。

## 11. Storage 和 API

v0.1 使用 OpenCode 现有 storage/sql 基建，新增 research tables：

- `research_task`
- `research_candidate`
- `research_run`
- `research_metric`
- `research_artifact`
- `research_memory`
- `research_approval`

Server API 建议：

```text
POST   /research/tasks
GET    /research/tasks
GET    /research/tasks/:id
POST   /research/tasks/:id/start
POST   /research/tasks/:id/pause
POST   /research/tasks/:id/stop
GET    /research/tasks/:id/runs
GET    /research/tasks/:id/candidates
POST   /research/approvals/:id/reply
GET    /research/tasks/:id/artifacts
GET    /research/events?taskId=...
```

旧 session API 可以保留，但 Web/TUI 默认使用 research API。

## 12. 与 OpenCode Tool / Permission 的关系

NeoResearch 不应让 LLM 默认拥有开放 coding tools。默认 Agent 能力应改为：

- `propose_candidate`
- `validate_candidate`
- `run_experiment`
- `evaluate_run`
- `write_memory`
- `export_artifact`
- `ask_approval`

这些可以实现为 ResearchTool，也可以直接是 Orchestrator service method。通用 coding tools 只在 debug/admin mode 下启用。

Permission 层改造成 ApprovalPolicy：

```text
tool permission -> research action permission
ask/allow/deny -> approve/auto_approve/reject
```

这样能复用 OpenCode 的 permission event 和 UI 交互，但语义更贴合研究过程。

## 13. 迁移步骤

建议分 5 个阶段推进。

### Stage 1：Research data model and API skeleton

- 新增 `src/research` 模块。
- 新增 research storage schema。
- 新增 task/run/candidate/artifact/memory service。
- 新增 server routes。
- Web/TUI 能展示 mock research task。

### Stage 2：TSF domain plugin adapter

- 接入 Neo-Cast runtime，先允许子进程调用。
- 实现 TSF TaskSpec、CandidateRecipe schema、runner adapter。
- 跑通 baseline 和一次候选 full run。

### Stage 3：Review Mode

- Agent 生成候选。
- UI 展示 candidate 和 run plan。
- Human approve/reject。
- 批准后执行 smoke/full/eval。

### Stage 4：Autonomous Mode

- 加入 budget policy。
- 加入 autonomous loop。
- 加入 crash streak、budget exhausted、no improvement stop condition。
- 写 memory。

### Stage 5：Research-first UX

- TUI 默认 Cockpit。
- Web 默认 Dashboard。
- 旧 coding mode 隐藏到 debug/legacy command。
- 完善 artifact browser 和 champion lineage。

## 14. 测试策略

单元测试：

- ResearchTask status transition。
- ApprovalPolicy。
- DomainPlugin contract。
- TSF CandidateRecipe validation。
- Champion decision。

集成测试：

- 创建 TSF task。
- baseline run。
- Review Mode approve 后执行 run。
- Autonomous Mode 在小预算内完成至少一轮 propose/run/evaluate/memory。
- artifact export。

端到端测试：

- CLI 创建任务并启动。
- TUI 接收 approval event。
- Web dashboard 展示 run 和 champion。

回归测试：

- Provider config 仍可工作。
- Server event stream 仍可被 TUI/Web 消费。
- Debug coding tools 不影响 research default mode。

## 15. 风险与控制

主要风险：

- OpenCode 原 session/chat 逻辑和 research task 逻辑混杂。
- 第一版同时保留 TUI/Web/Agent loop，范围偏大。
- TSF runtime 与 TypeScript server 的进程边界可能复杂。
- Autonomous Mode 早期可能浪费预算或反复生成低质量候选。

控制方式：

- ResearchTask 成为唯一业务状态源，Session 只做交互容器。
- 先用 TSF 子进程 adapter，避免一次性重写训练 runtime。
- Review Mode 先落地，Autonomous Mode 复用同一 approval policy。
- 所有 autonomous loop 必须有 budget、crash streak 和 stop condition。
- 旧 coding tools 默认关闭，只在 debug/admin mode 开启。

## 16. 成功标准

v0.1 成功标准：

- 能在 OpenCode fork 中创建 TSF ResearchTask。
- Web dashboard 能展示 task、runs、metrics、champion、artifact。
- TUI cockpit 能显示当前 agent loop、run event、approval prompt。
- Review Mode 能完成一轮 Human-approved candidate run。
- Autonomous Mode 能在预算内完成多轮 propose/run/evaluate/memory。
- TSF artifact 可导出并包含 metadata、model、preprocess、eval report。
- 旧 coding agent 不再是默认产品入口，但保留 debug/admin 可用性。

