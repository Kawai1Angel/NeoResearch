# NeoResearch 执行契约一致性门禁修改方案

## 1. 背景

NeoResearch 的研究控制链路已经支持以下闭环：

```text
ReflectionAgent
  -> 生成结构化反思和 nextStepRecommendation
  -> HypoPlannerAgent 读取最新 Reflection
  -> 保留、精炼、放弃或新增研究假设
  -> ModelDesignerAgent 生成下一个 candidate
```

ReflectionAgent 和 HypoPlannerAgent 的职责是研究推理和假设管理，不负责修改 runner、renderer、model factory 或其他实验执行代码。

当 candidate recipe 在解析或执行过程中静默变成另一个模型时，问题不是 Reflection 缺少 pipeline 修复能力，而是实验执行层没有建立不可绕过的一致性门禁。系统可能将一次实际未执行原假设的运行当作有效实验，进而：

- 消耗 full-run 预算；
- 更新 champion 或 plateau 统计；
- 将无效结果写入 research memory；
- 误导 Reflection 对原假设作出支持或否定判断；
- 触发 HypoPlanner 产生替代假设，而原假设从未被真正检验。

本方案在不扩大 Reflection/HypoPlanner 职责边界的前提下，建立执行契约校验、结构化 blocker、任务暂停与原假设恢复机制。

## 2. 目标与非目标

### 2.1 目标

1. 在 full run 前确认“选中的假设、candidate recipe、resolved recipe、实际实例化模型”相互一致。
2. 不一致时立即终止实验，不产生可用于研究判断的指标。
3. 将运行标记为 `invalid`，将该运行对原假设的证据结论标记为 `inconclusive`。
4. `invalid` 运行不计入 full-run 预算、plateau、champion 和有效/无效实验统计。
5. 暂停当前 research task，并输出可审计的结构化 blocker。
6. 由现有人工 checkpoint、开发维护流程或独立工程 Agent 处理 pipeline 问题。
7. 修复后重新验证原 candidate 和原假设，不调用 HypoPlanner 产生替代方向。

### 2.2 非目标

- 不让 ReflectionAgent 或 HypoPlannerAgent 修改代码。
- 不让研究 Agent 自动绕过 schema、artifact 追踪或执行安全边界。
- 不根据执行层故障放弃或改写原假设。
- 不将 `invalid` 等同于模型训练失败。
- 不在本阶段改造 Reflection 的 `continue/stop/request_human` 决策模型。

## 3. 职责边界

```text
研究控制面
ReflectionAgent -> HypoPlannerAgent -> ModelDesignerAgent
职责：分析结果、管理假设、提出下一实验

执行可信层
Candidate Validator -> Renderer -> Runner -> Model Factory -> Contract Checker
职责：保证实验被忠实执行，不一致时 fail closed

系统维护面
Pipeline Maintainer / 人工 Checkpoint / 独立工程 Agent
职责：定位和修复 pipeline 实现缺陷
```

研究控制面只允许消费通过执行一致性校验的实验结果。

## 4. 目标状态流

### 4.1 正常流程

```text
HypoPlanner 选择 H1
        |
        v
ModelDesigner 生成 Candidate C1
并持久化 hypothesis_id=H1
        |
        v
Gate A: Hypothesis <-> Candidate Recipe
        |
        +-- 不一致 --> invalid + blocker + task paused
        |
        v
Smoke: Renderer -> Python Factory 实例化模型
        |
        v
Python 输出 ExecutedModelManifest
        |
        v
Gate B: Candidate/Resolved Recipe <-> Executed Model
        |
        +-- 不一致 --> smoke run invalid
        |                 hypothesis evidence=inconclusive
        |                 task paused
        |                 创建 protocol checkpoint
        |
        v
contract_verified
        |
        v
允许创建 full run
```

### 4.2 恢复流程

```text
Pipeline Maintainer 修复执行管线
        |
        v
批准/恢复 execution-contract checkpoint
        |
        v
系统锁定原 Candidate C1 和原 Hypothesis H1
        |
        v
重新执行 smoke verification
        |
        +-- 仍不一致 --> 生成新 blocker，继续 paused
        |
        v
一致 --> blocker resolved
          --> task 恢复 searching
          --> 执行 C1 full run
```

## 5. 数据模型修改

### 5.1 Candidate 与 Hypothesis 建立结构化关联

当前 candidate 和 hypothesis 的关系主要依赖 candidate 中的文本字段和正则推断，不足以支持安全的“恢复原假设”。

建议为 `research_candidate` 增加可空字段：

```sql
ALTER TABLE research_candidate
ADD COLUMN hypothesis_id TEXT;
```

TypeScript 模型增加：

```ts
hypothesisID?: ResearchHypothesisID
```

创建 candidate 时直接写入当前 `selectedHypothesis.id`，不再依靠以下内容恢复关系：

- `candidateSpec.hypothesis` 自然语言文本；
- `rationale` 文本；
- 对 candidate 文本正则提取 hypothesis ID。

历史 candidate 的 `hypothesis_id` 保持 `NULL`，以保证数据库兼容。

### 5.2 ExecutionContract

新增 TypeScript/Python 共用的执行契约：

```json
{
  "schema_version": "research_execution_contract.v1",
  "task_id": "rtsk_xxx",
  "hypothesis_id": "rhyp_xxx",
  "candidate_id": "rcand_xxx",
  "candidate_spec_sha256": "...",
  "expected": {
    "recipe_version": "recipe_schema_v1",
    "preprocessing": ["instance_norm"],
    "embedding": "none",
    "backbone": "timesnet",
    "fusion": "temporal",
    "channel_mode": "independent",
    "prediction_head": "direct_multi_horizon",
    "target_channels": 1,
    "past_exogenous_channels": 6,
    "future_exogenous_channels": 0,
    "output_channels": 1
  }
}
```

第一版只比较会改变模型语义的字段：

- preprocessing action 类型和顺序；
- embedding；
- backbone；
- fusion 和 channel mode；
- prediction head；
- target/past/future/output channel 数；
- candidate spec digest。

第一版不需要比较所有浮点超参数。后续可在发现训练参数传递偏差时扩展。

### 5.3 ExecutedModelManifest

Python model factory 在实例化模型后生成实际执行清单：

```json
{
  "event": "executed_model_manifest",
  "schema_version": "executed_model_manifest.v1",
  "candidate_id": "rcand_xxx",
  "candidate_spec_sha256": "...",
  "actual": {
    "model_class": "RecipeModel",
    "preprocessing": ["InstanceNormAction"],
    "embedding": "none",
    "backbone": "timesnet",
    "backbone_module_class": "TimesNetCore",
    "fusion": "temporal",
    "prediction_head": "DirectMultiHorizonHead",
    "target_channels": 1,
    "past_exogenous_channels": 6,
    "future_exogenous_channels": 0,
    "output_channels": 1,
    "num_parameters": 48321
  }
}
```

`actual` 必须从实例化后的 Python 对象读取，不能通过重新读取 recipe 生成。否则 renderer 或 factory 发生静默退化时，契约校验仍可能假通过。

## 6. 两道一致性门禁

### 6.1 Gate A：Hypothesis 到 Candidate Recipe

位置：candidate 创建之后、smoke run 创建之前。

建议提供纯函数：

```ts
function validateCandidateAgainstHypothesis(
  hypothesis: HypothesisObject,
  candidate: ResearchCandidate,
): ContractMismatch[]
```

校验规则：

1. candidate 必须具有结构化 `hypothesisID`。
2. `candidate.hypothesisID` 必须等于本轮 `selectedHypothesis.id`。
3. 若 `suggestedBackbones` 非空，candidate backbone 必须属于该集合。
4. 若 ModelDesigner 已选定具体 backbone，必须将其写入 `expected.backbone`。
5. candidate 使用的 preprocessing 必须与本轮最终选定方案一致。
6. candidate 声明使用的 observed-past/known-future covariates 必须在 task contract 中存在。

示例 mismatch：

```json
{
  "path": "backbone",
  "expected": ["timesnet"],
  "actual": "mlp",
  "source": "hypothesis_candidate_gate"
}
```

该门禁负责捕获“假设要求 TimesNet，但 ModelDesigner 生成的 candidate 本身已经是 NLinear/MLP”的情况。此时不启动 Python smoke。

### 6.2 Gate B：Resolved Candidate 到 Executed Model

位置：smoke 中模型实例化之后、第一批训练开始之前。

现有 smoke 已会执行 renderer 和 `train.py --smoke`，因此 `validate.py` 是合适的门禁入口。

Python 在模型完成实例化后、进入任何 epoch 前输出 `executed_model_manifest`。校验通过时输出：

```json
{
  "event": "execution_contract_verified",
  "contract_digest": "...",
  "candidate_id": "rcand_xxx",
  "status": "verified"
}
```

校验失败时输出：

```json
{
  "event": "execution_contract_violation",
  "status": "invalid",
  "contract_digest": "...",
  "mismatches": [
    {
      "path": "backbone",
      "expected": "timesnet",
      "actual": "nlinear_mlp"
    }
  ]
}
```

失败后使用专用 exit code，例如 `5`，并且不进入训练循环。

## 7. `invalid` 与 `inconclusive` 语义

`invalid` 和 `inconclusive` 不应作为同一层状态混用。

### 7.1 Run 状态

```ts
type ResearchRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "rejected"
  | "invalid"
```

`invalid` 表示实验契约不成立，该运行没有研究解释价值。

### 7.2 Hypothesis 证据结论

该运行对原假设的证据结论是：

```text
inconclusive
```

其含义是：假设没有被正确执行，当前结果既不能支持，也不能否定它。

对应行为：

- hypothesis 保持原状态，不进入 `abandoned`；
- 不调用 HypoPlanner；
- Reflection 不将该 run 计入 effective/ineffective changes；
- 不增加 plateau streak 和 crash streak；
- 不写入“该模型方向失败”的 research memory；
- 可写入一条 `execution_invalid` 类型的系统性 memory，但不得用于否定假设。

## 8. 预算语义

### 8.1 统计规则

预算查询调整为：

```text
profile/ref_test/blind_test：沿用现有规则
invalid：不计入 maxRuns
invalid：不计入 stage run limit
queued/running：仍计入并发限制
```

为防止无限制产生 invalid run，只要出现执行契约违规，当前 task 必须立即暂停，不允许自动尝试下一 candidate。

### 8.2 Full-run 创建门禁

禁止 full run 消耗预算不应只依赖事后退还，而应通过前置约束保证 full run 根本不会开始：

1. 每个 candidate 必须存在同一 `contract_digest` 的成功 smoke verification。
2. 没有 `execution_contract_verified` artifact 时，禁止创建 full run。
3. contract violation 必须在 smoke 阶段发现。
4. 因此错配时数据库中不会产生对应的 full-run 记录。

即使通过 CLI 或其他入口直接请求 full stage，`prepareRunInternal()` 也必须拒绝：

```text
No verified smoke contract for candidate C1 and contract digest D1.
```

## 9. 结构化 Blocker

新增 artifact kind：

```text
execution_contract_violation_json
```

内容示例：

```json
{
  "schema_version": "execution_contract_violation.v1",
  "blocker_id": "ecb_xxx",
  "type": "execution_contract_violation",
  "status": "open",
  "task_id": "rtsk_xxx",
  "hypothesis_id": "rhyp_xxx",
  "candidate_id": "rcand_xxx",
  "invalid_run_id": "rrun_xxx",
  "stage": "smoke",
  "contract_digest": "...",
  "expected": {
    "backbone": "timesnet"
  },
  "actual": {
    "backbone": "nlinear_mlp"
  },
  "mismatches": [
    {
      "path": "backbone",
      "expected": "timesnet",
      "actual": "nlinear_mlp"
    }
  ],
  "recommended_owner": "pipeline_maintainer",
  "resume_requirement": {
    "same_hypothesis": true,
    "same_candidate": true,
    "required_stage": "smoke",
    "required_event": "execution_contract_verified"
  }
}
```

同时执行：

- `task.status = "paused"`；
- 创建现有 `protocol` approval/checkpoint；
- `PipelineBlockedError.reason` 增加 `execution_contract_violation`；
- error 中携带 blocker、candidate、hypothesis 和 invalid run 的 ID。

建议错误结构：

```ts
{
  taskID: ResearchTaskID
  reason: "execution_contract_violation"
  blockerArtifactID: ResearchArtifactID
  candidateID: ResearchCandidateID
  hypothesisID: ResearchHypothesisID
  invalidRunID?: ResearchRunID
}
```

checkpoint 展示文本：

```text
[checkpoint:execution_contract_violation:<contract_digest>]

实验执行契约不一致，任务已暂停。
Expected backbone: timesnet
Actual backbone: nlinear_mlp
Candidate: rcand_xxx
Hypothesis: rhyp_xxx
Blocker artifact: rart_xxx
Recommended owner: pipeline_maintainer

修复后 approve 以启动原 candidate 的 smoke verification。
```

blocker 必须由确定性契约校验器产生，不依赖 Reflection 或 LLM 对执行曲线的推测。

## 10. ModelCompilerAgent 修改

当前 ModelCompilerAgent 主要检查 smoke 是否成功、指标是否有限、是否 timeout 以及 metric 是否爆炸。建议扩展状态：

```ts
type ModelCompilerStatus =
  | "passed"
  | "failed"
  | "timeout"
  | "contract_invalid"
```

只有同时满足以下条件才能返回 `passed`：

```text
smoke succeeded
metric finite
executed_model_manifest 存在
execution_contract_verified 存在
manifest contract_digest 与当前 candidate 一致
```

manifest 缺失时必须 fail closed，不能因为 smoke metric 存在而降级通过。

## 11. 暂停与恢复机制

### 11.1 暂停

契约违规后：

1. Gate A 失败时不创建 smoke run；Gate B 失败时将已有 smoke run 标记为 `invalid`。
2. 创建 `execution_contract_violation_json` artifact。
3. 创建 `protocol` checkpoint。
4. 将 task 设为 `paused`。
5. 终止当前 autonomous iteration。
6. 不运行本轮 Reflection 和后续 HypoPlanner。

### 11.2 恢复

增加恢复前置步骤：

```ts
resumeExecutionContractCheckpoint(taskID)
```

处理流程：

1. 查找当前 task 最新的 execution-contract checkpoint。
2. checkpoint 仍为 `pending` 时保持 `paused`。
3. checkpoint 被批准后读取关联 blocker。
4. 固定使用 blocker 中的原 `hypothesisID` 和 `candidateID`。
5. 重新创建 smoke verification run。
6. 在 smoke verification 结束前禁止调用 HypoPlanner 和 ModelDesigner。
7. 验证通过后创建 `execution_contract_verified_json` artifact。
8. 将 task 恢复为 `searching`，继续执行原 candidate 的 full run。

`execution_contract_verified_json` 至少包含：

- 原 blocker ID；
- verification smoke run ID；
- contract digest；
- expected/actual manifest；
- verified timestamp。

若重新验证仍失败：

- 新 smoke run 仍标记为 `invalid`；
- 生成新 blocker/checkpoint；
- task 继续保持 `paused`；
- 仍不修改假设。

不能因为旧 checkpoint 已被批准就永久放行。每次验证失败都应产生带 attempt 编号的新 checkpoint：

```text
execution_contract_violation:<contract_digest>:attempt-2
```

## 12. 与现有研究逻辑的集成规则

### 12.1 Champion

- `invalid` run 不参与 champion 排序。
- 只有同时具备 `succeeded` 和 `execution_contract_verified` 的 full run 可以更新 champion。

### 12.2 Reflection

- Reflection 不将 `invalid` run 归类为 effective、ineffective 或 training failure。
- `invalid` run 不得增加 plateau streak。
- 若 Reflection 工具查询到该 run，应显示 `evidence_disposition: inconclusive`。

### 12.3 HypoPlanner

- 契约违规时不调用 HypoPlanner。
- 原 hypothesis 不得被放弃、替换或降低优先级。
- 恢复后首先验证原 candidate，而不是从 hypothesis pool 重新选择。

### 12.4 Memory

- 不产生“TimesNet 失败”这类研究性记忆。
- 可以生成系统性记忆：“candidate C1 因 backbone 执行不一致而 invalid”。
- HypoPlanner 读取 memory 时必须区分 `research_evidence` 和 `execution_incident`。

## 13. 建议修改文件

### 13.1 TypeScript

| 文件 | 修改内容 |
|---|---|
| `opencode/packages/opencode/src/research/schema.ts` | 增加 run `invalid`、candidate `hypothesisID`、execution contract/blocker 类型 |
| `opencode/packages/opencode/src/research/research.sql.ts` | `research_candidate` 增加 `hypothesis_id` |
| `opencode/packages/opencode/migration/<timestamp>_candidate_hypothesis_execution_contract/migration.sql` | 新增兼容迁移 |
| `opencode/packages/opencode/src/research/service.ts` | Gate A、smoke manifest 解析、invalid 处理、预算排除、blocker/checkpoint、恢复原 candidate、full-run 前置门禁 |
| `opencode/packages/opencode/src/research/agents/model-compiler-agent.ts` | 增加 `contract_invalid` 和 fail-closed 判定 |
| `opencode/packages/opencode/src/research/runners/neo-cast-runner.ts` | smoke 命令传入 execution contract 路径 |
| `opencode/packages/opencode/src/tool/research-context.ts` | `experiment_results` 直接返回 `hypothesisID`，将 invalid 表示为 inconclusive evidence |
| `opencode/packages/opencode/src/research/event.ts` | 增加 contract violation/verified 事件，便于 TUI 和外部监控 |

### 13.2 Python

| 文件 | 修改内容 |
|---|---|
| `neo_cast/py/schemas/execution_contract_schema.json` | ExecutionContract JSON Schema |
| `neo_cast/py/execution_contract.py` | canonicalize、digest、model introspection、compare |
| `neo_cast/py/factory/build_model.py` | 提供实例化模型描述能力 |
| `neo_cast/py/train.py` | 模型创建后输出 actual manifest，第一个 epoch 前校验 |
| `neo_cast/py/validate.py` | smoke 接收 contract，转发并识别 violation/verified event |
| `neo_cast/py/runner.py` | full stage 前复核 verified contract，防止绕过 smoke |

## 14. 测试方案

### 14.1 Python 单元测试

1. TimesNet expected + TimesNet actual：返回 verified。
2. TimesNet expected + MLP actual：返回 violation。
3. preprocessing 顺序改变：返回 violation。
4. future covariate channel 数不一致：返回 violation。
5. recipe 文本声称 TimesNet，但实际 Python 对象是 MLP：返回 violation。
6. manifest 缺失：fail closed。
7. contract digest 不一致：fail closed。

### 14.2 TypeScript 单元测试

1. candidate `hypothesisID` 与当前 hypothesis 不符时，Gate A 拒绝。
2. candidate backbone 不在 hypothesis 允许集合内时，Gate A 拒绝。
3. `invalid` run 不进入 champion。
4. `invalid` run 不增加 plateau 或 crash streak。
5. `invalid` run 不计入 `maxRuns` 和 stage budget。
6. `invalid` run 不导致 hypothesis abandon。
7. 无 verified smoke artifact 时直接请求 full run 被拒绝。
8. contract digest 变化后，旧 smoke verification 不得被复用。

### 14.3 端到端失败路径

```text
Hypothesis TimesNet
  -> Candidate TimesNet
  -> mock factory 强制返回 MLP
  -> smoke invalid
  -> full run 记录数增加 0
  -> task paused
  -> blocker artifact 存在
  -> protocol checkpoint pending
  -> champion/plateau/hypothesis 状态不变
```

### 14.4 端到端恢复路径

```text
approve checkpoint
  -> 固定恢复原 candidate
  -> factory 恢复 TimesNet
  -> smoke contract verified
  -> blocker resolved
  -> task searching
  -> 原 candidate 进入 full run
  -> HypoPlanner 未新增、放弃或替换假设
```

### 14.5 绕过尝试

```text
直接请求 full run
  + 无 matching verified smoke
  -> 请求被拒绝
  -> full run 数据库记录未创建
```

## 15. 分阶段实施计划

| Wave | 实施内容 | 验收结果 |
|---|---|---|
| 1 | Candidate-Hypothesis 关联、ExecutionContract、Python actual manifest、契约比较器 | 可靠识别 TimesNet -> MLP 错配 |
| 2 | ModelCompiler、`invalid` 状态、budget/champion/Reflection 排除 | 错配不污染研究结果，不消耗 full-run 预算 |
| 3 | 结构化 blocker、protocol checkpoint、task pause | 执行违规后任务可审计地暂停 |
| 4 | 原 hypothesis/candidate 恢复和 smoke re-verification | 修复后继续原实验，不生成替代假设 |
| 5 | CLI/TUI 展示、旁路防护、回归测试 | 用户可定位 blocker 并安全恢复 |

### 15.1 Wave 1：契约基础

- 增加 `hypothesis_id` 持久化。
- 定义 ExecutionContract、ExecutedModelManifest 和 ContractMismatch。
- 实现 TypeScript/Python 一致的 canonicalization 与 digest 规则。
- 实现 Gate A 和 Gate B 的纯函数测试。
- Python 实际模型对象输出 manifest。

### 15.2 Wave 2：执行门禁

- 将 contract 路径注入 smoke runner command。
- ModelCompilerAgent 识别 `contract_invalid`。
- 限制 full run 必须关联成功的 verified smoke contract。
- 将 invalid run 从 budget、champion、plateau、Reflection 和 research memory 中排除。

### 15.3 Wave 3：暂停和 Blocker

- 生成 `execution_contract_violation_json`。
- 创建带 contract digest 的 protocol checkpoint。
- 将 task 转为 `paused`。
- 在 CLI/TUI 显示 expected、actual、mismatch 和 recommended owner。

### 15.4 Wave 4：可验证恢复

- checkpoint approved 后锁定原 candidate 执行 smoke verification。
- 验证成功后创建 verified artifact 并恢复 task。
- 验证失败时生成新 attempt checkpoint。
- 保证整个过程不调用 HypoPlanner 变更假设。

### 15.5 Wave 5：端到端验收

- 覆盖 Gate A 和 Gate B 错配。
- 覆盖直接 full-run 旁路。
- 覆盖修复后恢复成功与重复失败。
- 运行 `opencode/packages/opencode` package-scope Bun 测试。
- 运行 `neo_cast` Node 和 Python 回归测试。

## 16. 验收标准

所有以下条件都满足时，本方案才算完成：

1. 架构错配在第一个训练 epoch 前被发现。
2. 错配时 full-run 记录增加数为 0。
3. `invalid` run 的 full-run 预算消耗为 0。
4. `invalid` run 不更新 champion、plateau 和 crash streak。
5. Reflection 不根据 `invalid` run 支持或否定 hypothesis。
6. blocker 包含 expected、actual、mismatch、candidate、hypothesis 和 recommended owner。
7. 出现 blocker 后 task 自动进入 `paused`。
8. 修复后执行的是原 hypothesis 和原 candidate。
9. 恢复前必须重新完成 smoke contract verification。
10. 没有 verified smoke contract 时，任何入口都无法启动 full run。
11. 历史 candidate 和现有 research task 可继续读取。
12. 新增的 Python、Node/Bun 和端到端测试全部通过。

## 17. 兼容性与发布策略

### 17.1 历史数据

- 历史 candidate 的 `hypothesis_id` 允许为 `NULL`。
- 历史 run 不要回溯生成 verified contract，避免伪造实验证据。
- 已完成历史 task 可继续查看和导出，但不得使用历史 smoke 解锁新 full run。

### 17.2 分阶段启用

建议使用短期 feature flag：

```text
research.execution_contract_gate = shadow | enforce
```

- `shadow`：生成 manifest 和 mismatch 报告，但不暂停任务，只用于验证契约提取是否准确。
- `enforce`：mismatch 必须 fail closed，并启用 blocker/checkpoint。

shadow 模式只用于开发回归，不应用于新的正式研究任务。正式任务默认使用 `enforce`。

## 18. 预期效果

完成本方案后，NeoResearch 的研究闭环将具备如下保证：

```text
研究 Agent 只提出和管理假设
          +
执行层确定性保证假设被忠实实现
          +
工程故障由研究流程外部处理
          +
修复后恢复原实验，不污染研究结论
```

该修改不直接提高模型指标，但它使“某个模型是否超过 baseline”的研究结论变得可信，并避免将 full-run 预算浪费在与研究假设不一致的实验上。
