# 实验方案：zero 模式下的广架构探索与知识、经验验证（100 轮）

本实验在基础 NeoResearch-zero 协议上增加架构覆盖与证据验证目标，将搜索预算和搜索连续无提升轮数均设为 100。本文是待执行协议，不表示新实验已启动。执行流程沿用 [Agent 执行手册](Agent执行手册_数据集任务启动_Intent澄清_监控修复续跑.md)，发生参数冲突时以本文和当前两轮回复为准。

## 1. 实验设置

| 项目 | 本实验设置 |
|---|---|
| 实验标识 | `zero-coverage-100`，仅用于目录和报告标记 |
| 实际变体开关 | `taskSpec.metadata.researchVariant="zero"` |
| 架构目标 | 在可实现且适用的范围内尽可能多地探索不同架构和机制 |
| 证据目标 | 尽可能多地用真实实验验证已准入知识卡片和全局共享经验中的可检验内容 |
| 搜索预算 | `budget.loop.maxIterations=100` |
| 搜索 patience | `budget.loop.maxNoImprove=100`，连续无提升的搜索轮数 |
| 单模型训练 patience | 保持原 zero 设置；本实验不将 `trainingStrategy.budget.patience` 改为 100 |
| 执行顺序 | ETTh1 → NP → PJM → mopex，每个数据集独立任务 |
| 监控与接续 | 每 5 分钟完整巡检；一个数据集验收完成后自动启动下一个 |
| 其他条件 | 与原 zero 相同，包括 DeepSeek 模型、runtime、数据协议、种子设置、文献策略、并发、验证和导出要求 |

`zero-coverage-100` 不是新的 `researchVariant` 值，不能替代 `zero`。首轮仍是自主 `exploratory` 设计，不建立预置 baseline；后续可用本任务已验证的自主模型作为明确声明的对照。不能把其他任务的候选、训练记录或 champion 导入为本任务的初始结果。

本实验同时改变探索指令、搜索预算和搜索停止阈值，应与此前 25 轮 zero 分开报告，不能将结果差异单独归因于某一个因素。

## 2. 两轮回复与数据协议

当前 `response/1/` 的四份文件已保留原预测对象、目标列和辅助变量，并加入广架构探索、知识卡片与共享经验验证的明确要求。当前 `response/2/` 的四份文件设置 100 轮搜索预算和 100 轮连续无提升阈值。两份回复仍必须依次通过原 Intent 会话提交，各自等待落库并回读，最后才批准最新 checkpoint。

| 数据集 | 第一轮回复 | 第二轮回复 | 最终窗口、预测长度与切分 |
|---|---|---|---|
| ETTh1 | `response/1/ETTh1.txt` | `response/2/ETTh1.txt` | context=96，horizon=96，时间顺序 6:2:2 |
| NP | `response/1/NP.txt` | `response/2/NP.txt` | context=168，horizon=24，时间顺序 7:1:2 |
| PJM | `response/1/PJM.txt` | `response/2/PJM.txt` | context=168，horizon=24，时间顺序 7:1:2 |
| mopex | `response/1/mopex.txt` | `response/2/mopex.txt` | context=96，horizon=96，时间顺序 7:1:2 |

目标列及 observed-past 辅助变量继续以各自第一轮回复为准。第二轮未修改的字段保留原 zero 初始值。主指标保持 `cv_avg_mse`，测试集只用于最终评估，不用于挑选架构或确认搜索经验。

## 3. 启动前检查搜索 patience 的 Intent 传递

先检查运行中服务实际加载的代码，再提交第二轮回复。不能只确认源码文件已修改，就认定旧进程支持该字段。

当前源码的对应关系如下：

| 用户要求 | Intent 工具 slot | 落库后的执行字段 |
|---|---|---|
| 搜索预算 100 轮 | `max_iterations=100` | `budget.loop.maxIterations=100` |
| 搜索 patience=100 | `max_no_improve=100` | `budget.loop.maxNoImprove=100` |

当前版本已通过隔离验证：`applySlotUpdates` 写入这两个值后，任务预算和 `readTaskspecSlots` 均回读为 100。`patience` 本身不是合法 Intent slot；必须让 IntentAgent 将自然语言映射到 `max_no_improve`。本检查证明工具到预算的传递可用，真实启动时仍需检查 IntentAgent 是否实际调用了正确工具并成功落库。

依据：[Intent slot 定义](../opencode/packages/opencode/src/research/agents/intent-agent.ts)、[Intent 工具](../opencode/packages/opencode/src/tool/research-taskspec.ts)、[预算落库实现](../opencode/packages/opencode/src/research/taskspec-store.ts)。不要把单模型训练 patience 或 `budget.maxRuns` 当成搜索 patience。

### 3.1 实际任务的回读门槛

在批准最新 Intent checkpoint、进入数据分析和创建搜索 cycle 之前，保存任务详情、Intent 工具调用和回读结果，确认：

```json
{
  "budget": {
    "loop": { "maxIterations": 100, "maxNoImprove": 100 }
  }
}
```

同时核对 `taskSpec.metadata.intentSlots.max_iterations` 和 `max_no_improve` 均为 100。对自然语言摘要里写着“100”、但执行预算仍是 25/7 的情况，不允许直接批准或开跑。

先沿原 Intent 会话要求 agent 使用 `update_taskspec` 写入正确 slot，再使用 `read_taskspec` 独立回读。若检查发现当前运行版本不支持该 slot，或原会话无法正确落库，由 Codex 在任务尚未开跑时手动调整执行预算，不把无法传递的问题交给用户重复回答。

### 3.2 Codex 手动兜底

1. 保存原任务、完整预算、checkpoint 和失败原因；确认没有 active operation、运行中的训练或已经锁定的搜索 cycle。
2. 在当前任务上使用受支持的预算更新 API：`PATCH /research/tasks/<taskID>/budget`。从回读的完整预算复制所有字段，仅将 `loop.maxIterations` 和 `loop.maxNoImprove` 改为 100，保留 `maxRuns`、并发、资源限制及其他 loop 字段。
3. 回读服务返回的任务预算；检查旧 Intent slots 是否仍会覆盖新值。优先经 Intent 工具同步两个 slot；若当前版本不支持，则通过受支持的 taskSpec 更新接口修正已有的冲突 slot，不能留下 25/7 与 100/100 并存的状态。不要直接改 SQLite 或伪造审批状态。
4. 手动修改可能使旧 checkpoint 过期。使用当前版本支持的 Intent 检查流程重新取得有效 checkpoint；再次核对任务、预算与摘要一致后才批准。不能绕过 checkpoint。
5. 开跑后检查实际 cycle policy 的 `maxIterations`、`maxNoImprove` 均为 100，并检查规划输入的剩余预算及停止阈值。若发现旧值，先暂停并诊断，通过支持的恢复流程修正，不以新建 cycle 或清空历史规避问题。

将修改前后值、更新接口、原因和回读结果记入控制目录。单模型训练的 `trainingStrategy.budget.patience` 不在本次手动调整范围内。

## 4. 架构、知识卡片与经验的验证方式

优先增加有适用条件和可检验问题的架构覆盖；在 backbone、表征、embedding、fusion、预测头及组合机制之间主动探索。让 agent 依据模型能力、数据特征和已完成实验安排顺序，不预先指定固定架构清单、运行顺序或成功数量。无效配方、重复配置和只改随机种子的运行不计作新架构。

知识卡片验证只使用当前任务已审核准入的卡片与版本，保留断言、适用条件、实现差异和迁移边界。文献仍采用 `reuse_only`，不因覆盖目标自动引入未准入结论或重新抓取所有论文。需要原文时按卡片 ID/版本分页读取。

共享经验通过 `read_experiences(scope="shared")` 按具体机制或迁移问题检索，必要时按经验 ID 获取完整事实。每项实验在运行前声明来源经验、当前任务适用条件、干预、真实对照及可证伪判据。外部经验可以形成假设，但当前任务的受控对比应使用本任务已验证的比较运行。

每个数据集维护 `coverage.json` 或等价审计记录，至少包含：

- 实际尝试的架构家族、候选及 run ID，smoke/full 阶段、完成状态和配置重复情况。
- 知识卡片 ID/版本、待检验断言、实验假设、干预与对照、支持/反对/证据不足的结果。
- 经验 ID、来源项目及运行、迁移假设、对应的本任务实验与验证结论。
- 无法验证的项目及原因，包括机制不支持、数据条件不满足、缺少合法对照或预算不足。
- 知识确认和经验写入的真实接口回执，以及证据校验拒绝原因。

区分“已读取”“已引用”“已提交实验”“获得可判定证据”“接口确认成功”；不能把阅读、引用、训练成功或同一次实验的多次确认累计成多项独立验证。支持和反对结果都保留。只有满足现有证据校验时才确认知识卡片或写经验；跨数据集规律仍需独立数据内容及合格对照，不能为提高覆盖率自动升级。

## 5. 环境、运行与自动接续

复用原 zero 的实际 Bun、Python、CUDA、LLM、知识库及全局经验库环境。启动前验证实际读写链路：经验库路径为 `/root/.neo-research/experience.db`（或本次明确配置的同一共享路径），服务加载共享读写实现，已有经验能读出，并记录数量、来源和 SQLite 一致性快照。记录知识卡片快照和经验库起始快照以便复核；后续新增经验仍按原共享机制保存。

四个数据集各创建新实验任务，使用独立控制目录，例如 `.neo-research/agent-control/zero-coverage-100/<数据集名>/`，不要续接此前已完成的 25 轮任务或覆盖其报告。服务可复用；任务、cycle、回复文件 SHA-256 和产物必须独立记录。同一新任务发生故障后仍沿用原 taskID 修复续跑。

创建预算可直接使用 `loop={maxIterations:100,maxNoImprove:100}`，但仍执行两轮 Intent 交互和最终回读。其他参数沿用原 zero：`maxRuns=200` 是独立安全上限，`maxParallel=1`，四折 CV 并发为 4；不得用 `maxRuns=100` 代替 100 轮搜索。安全上限按运行阶段和重试实际计数，不能为凑满 100 轮自动扩大其他预算。

控制器必须按本协议核对 100/100，不能复用旧控制器中硬编码的 25/7 验收条件。完整巡检间隔为 300 秒；保存恢复状态、事件、训练进度、资源、审批、覆盖记录和共享经验写入结果。遇到设计契约或训练错误自行修复并续跑，保留预算与历史，不能将设计阻塞标成正常完成。验收一个数据集后自动提交下一个数据集的两份对应回复并运行。

100 轮是搜索上限，不保证有 100 个成功 full 训练。预算耗尽后拒绝自动加轮；agent 若依法提前停止，必须记录真实停止原因与尚未验证的方向。模型导出、有效 full/ref_test、独立最终测试和报告完整性要求与原 zero 相同。

## 6. 最终报告

按数据集报告实际搜索轮数、成功/拒绝/失败的 full 数量、停止原因、实际 cycle patience、最佳 CV 指标、测试集 MSE/MAE、模型包与报告路径。另附去重后的架构覆盖、卡片断言验证和共享经验验证汇总，包含未完成验证及原因。原 25 轮结果单列为历史实验，不与本协议结果混合。

本次文档和回复文件准备未启动新任务；运行前必须再次执行第 3 节的真实 Intent 回读检查。

## 7. 运行中协议修订（2026-10-17）

按用户要求修复文献流程，并取消固定性能阈值对模型的自动拒绝。当前实验已启动，具体生效边界、原 taskID/cycle、已有训练数和修复回执记录在 `.neo-research/agent-control/zero-coverage-100/repairs/curation-reflection/`。

- 文献最终整理必须恰好覆盖所有已审核决策；漏项、重复、未知 ID 的错误返回明确 ID。无效缓存允许重新请求，保留成功的独立来源审核。最终整理修复仍失败时阻止后续规划，不再作为 `ready_data_only` 成功交接。完整审核后明确选择零项仍是合法结果。
- 取消相对比较模型退步 20%、验证/训练损失比 3 倍、长短 horizon 误差比 8 倍及固定参数收益率不足等性能自动拒绝规则。保留原始指标、差值和比率供 ReflectionAgent 结合曲线、数据和对照分析，不将通过执行检查等同于科学假设成立。
- 取消 reflection 内额外的连续 4 轮 plateau 停止建议；搜索仍受实际 cycle 的 `maxIterations=100` 和 `maxNoImprove=100` 控制。单模型训练 patience 保持原设置。
- 有限主指标、有效评估协议、执行契约及用户明确资源上限仍需满足。知识确认和共享经验写入仍需真实、可归因的实验与合格对照。
- 修复后恢复原任务和 cycle，保留已使用预算及历史记录。修复前没有准入卡片的训练不追认为已验证文献；报告区分修订前后结果，历史拒绝记录不改写。
- 共享经验检索取消整句连续子串匹配，改用带字段权重的 BM25 关键词排序，支持常见中英文术语及代码命名格式；按相关性排序后限制数量，仍保留领域、任务、项目和证据校验。默认返回摘要并控制上下文大小，完整事实按 ID 请求；无匹配不再解释为全局库为空。回放查询、真实 agent 工具调用和原 cycle 续跑回执记录在 `.neo-research/agent-control/zero-coverage-100/repairs/experience-retrieval/`。检索相关性不代表经验已在本任务验证。


### 共享经验表示与召回质量修复（2026-10-17）

本轮接入 `experience_evidence.v2` 派生表示与 `grounded_bm25_v2` 检索。原始全局库的 v1 证据、经验 ID、运行结果及反证保留；每次读取从真实运行快照生成干预路径、对照、数值差值和适用范围。模型的解释、诊断、未知问题和未来计划分开标注为未验证内容，不充当默认召回的事实依据。背景线索通过 `includeBackground=true` 显式请求，同一证据组保留所有经验 ID 但不重复占用查询名额。

验收包含此前真实误召回案例：MLP hiddenDim 64→128、仅未来计划提及频域、cuDNN RNN backward 报错，以及跨运行拼接数据集/架构条件的反例。缺少真实证据时允许返回 0 条；不再以非空率作为相关性验收。数值方向、单种子观察、联合干预及历史性能规则拒绝均不得提升为机制定论。新运行记录 Python 源码摘要，历史缺失的实现/依赖版本保持未知。

更新在训练完成并落盘的边界接入；保留当前任务、研究 cycle、已完成轮数、研究预算 100 与连续无提升 patience=100。四数据集自动衔接和 300 秒监控继续由既有队列控制器负责。训练 epoch patience 沿用既定方案。

接入验收：78 项测试与类型检查通过；冻结 149 条历史经验逐条生成表示与来源校验收据。实际代理完成 5 次只读检索验证，维护期间全局库 153 条记录的内容哈希一致。NP 原研究 cycle 和 100/100 策略保留，自动队列已恢复；重载后的完整训练 `rrun_148b51d05001ZBUszayIOfa4oO` 成功，记录了 45 个 Python 源文件的摘要。审计位置：`.neo-research/agent-control/zero-coverage-100/repairs/experience-representation-v2/`。


### 经验查询优先修复 1—3（2026-10-17）

接入 `intent_grounded_bm25_v3`：原生工具、direct experience_request 与 CLI 均支持 auto／报错／配置／干预／比较／架构探索意图。配置查询把实际算子和分支角色绑定到同一次运行；比较查询核对具有真实契约关系的完整对照臂；探索查询按候选架构的析取检索。GRU/LSTM 保留独立 cell 约束，父类 RNN 报错不能证明 LSTM 已测试。分解算子、原生 trend/residual 路由和数据条件逐项核对；背景结果明确列出 matchedRequiredConditions / missingRequiredConditions。没有统计口径和判定条件的“弱相关”保持未知，不以默认性能阈值拒绝模型。

验收：87 项测试、475 项断言及类型检查通过；154 条冻结经验回放后，GRU 报错 3 条、LSTM 0 条；普通 TCN 不再作为分解配置的直接证据，linear vs TCN 命中 2 条真实对照记录。另完成 6 次真实代理工具调用，检索期间库内容哈希、原 cycle／研究 100/100 策略及运行历史保持不变。审计位于 `.neo-research/agent-control/zero-coverage-100/repairs/experience-intent-v3/`。

同时诊断 NP 的 model_design_repair 检查点：源码和 CPU 前向证明全局中心化先于分解，secondary.representation.latentDim 可独立生效（primary=64、secondary=64/32 均输出有限 [2,24,1] 张量）。已纠正可变设计反馈和提示，保留原始阻塞工件与已完成实验，批准同一任务继续重新规划；诊断不计为训练轮次或质量证据。既有四数据集顺序队列和 300 秒监控保留。

最终接入补充：88 项测试／481 项断言和类型检查通过，最终 7 次真实代理读取验证通过；检索期间 155 条经验内容哈希不变。机制效果查询要求对应机制确实改变，不能由“在同一归一化配置下改变学习率”的对照替代。新完成的 NP 分解运行 rrun_148e69312001x7ld8gRkQt1W1N 已形成经验 rmem_148e89bc9001584WIH60NvxoRg，能被趋势／残差 TCN 配置查询正确召回；原普通 TCN 记录仍仅是缺少分解条件的背景。NP 后续完整训练 rrun_148eb52b900127OG8vpNzYQzGC 也已落盘，原队列已释放继续。最终在线验证收据位于上述审计目录的 final-deploy/。
