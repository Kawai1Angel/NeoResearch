# HypoPlanner 假设池工具化方案

> 状态：提案 / 未实现。本文档仅描述设计，代码尚未改动。

## 1. 背景与目标

目前 `research-hypo-planner` agent 在 session 模式下只能输出文本，由
`parseLLMHypotheses()` 事后解析，再通过 `updateTaskHypothesisPlan()`
（service.ts:3971-4037）整体删除并重建 `ResearchHypothesisTable`。

问题：

- 没有原子的增/改/删操作，每次都是"全量替换"，丢失增量语义
- LLM 无法在多轮交互中渐进式维护假设池（添加新假设、修正已有假设、放弃不再有效的假设）
- 历史假设一旦被替换就丢失，Reflection 阶段无法回溯"为什么放弃过某个方向"

目标：为 `research-hypo-planner` 增加四个内建工具，让 LLM 在 session 内直接对假设池做
CRUD：

- `hypothesis_add`
- `hypothesis_update`
- `hypothesis_abandon`（软删除）
- `hypothesis_list`（只读，便于 LLM 在多轮中先查询当前池子状态再决策）

## 2. 数据模型与状态机

### 2.1 状态枚举

`ResearchHypothesisTable.status`（research.sql.ts:164-188）当前只用 `"pending"`。
扩展为：

```
pending | active | testing | confirmed | rejected | abandoned
```

- `pending`：新增但尚未被采纳进当前实验计划
- `active`：当前计划中正在验证的假设
- `testing`：已提交实验、等待结果
- `confirmed` / `rejected`：实验结果支持/否定该假设
- `abandoned`：被 HypoPlanner 主动放弃（软删除）

状态转换由 HypoPlanner / Reflection 通过 `hypothesis_update` /
`hypothesis_abandon` 驱动，不在本提案中强制约束转换图，仅做合法值校验。

### 2.2 软删除字段

`AbandonHypothesis` 不做物理删除：

- `status` 置为 `"abandoned"`
- 新增列 `abandon_reason: text()`（nullable）
- 新增列 `abandoned_at: integer()`（timestamp，nullable）

历史行保留在表中，供 `hypothesis_list` 按需过滤（默认排除 `abandoned`，但支持
`includeAbandoned` 参数）。

### 2.3 `HypothesisObject` 类型扩展

`hypo-planner-agent.ts:3-13` 的 `HypothesisObject` 增加：

```ts
status: "pending" | "active" | "testing" | "confirmed" | "rejected" | "abandoned"
abandonReason?: string
```

## 3. Service / Store 层：原子 CRUD

新增共享模块 `src/research/hypothesis-store.ts`（避免 `tool/` ↔ `service.ts`
循环依赖，两者都依赖这个底层模块）：

| 函数 | 说明 |
|---|---|
| `resolveTaskIDBySessionID(sessionID)` | 查询 `ResearchTaskTable WHERE session_id = ?`，返回 `taskID`（用于工具从 `ctx.sessionID` 反查所属任务） |
| `addHypothesisToPool(taskID, hypothesis)` | insert 单行，`id` 用 `ResearchHypothesisID.ascending()` 生成，`status` 默认 `"pending"`，返回新 `hypoID` |
| `updateHypothesisInPool(taskID, hypoID, patch)` | 局部字段更新；校验 `hypoID` 属于该 `taskID`，否则报错 |
| `abandonHypothesisInPool(taskID, hypoID, reason)` | `status="abandoned"` + 写入 `abandon_reason`/`abandoned_at` |
| `listHypothesesInPool(taskID, { includeAbandoned? })` | 复用现有 `mapHypothesisRow()`（service.ts:746-759）映射为 `HypothesisObject[]` |

所有写操作复用 `validateLLMHypothesisItem()`（service.ts:2650-2687）做字段校验。

`updateTaskHypothesisPlan()`（全量替换）保留，作为 **fallback（无 session /
raw LLM 模式）** 的写入路径，不删除。

## 4. 工具定义

新文件 `src/tool/research-hypothesis.ts`，使用 `Tool.define(...)`
（Effect-native，参考 `specs/effect/tools.md` 与 `tool/bash.ts` 的写法）。

### 4.1 `hypothesis_add`

- 参数：`HypothesisObject` 去掉 `id`/`status`/`abandonReason`
  （`statement, motivation[], expectedOutcome, suggestedBackbones[],
  suggestedPreprocessing[], priority, risk, testable`）
- 行为：调用 `addHypothesisToPool`，`status` 默认 `pending`
- 返回：`{ hypoID, status: "pending" }`

### 4.2 `hypothesis_update`

- 参数：`{ hypoID: string, patch: Partial<HypothesisObject 可写字段 + status> }`
- 行为：调用 `updateHypothesisInPool`；若 `hypoID` 不属于当前任务，返回错误供
  LLM 自我纠正（不抛致命异常）
- 返回：更新后的完整 `HypothesisObject`

### 4.3 `hypothesis_abandon`

- 参数：`{ hypoID: string, reason: string }`
- 行为：调用 `abandonHypothesisInPool`（软删除）
- 返回：`{ hypoID, status: "abandoned", abandonReason: reason }`

### 4.4 `hypothesis_list`

- 参数：`{ includeAbandoned?: boolean, status?: HypothesisStatus[] }`（均可选）
- 行为：调用 `listHypothesesInPool`，默认排除 `abandoned`
- 返回：`HypothesisObject[]`（含 `id/status`），供 LLM 在调用
  add/update/abandon 前先了解池子当前状态，避免重复添加或更新不存在的
  `hypoID`

### 4.5 公共实现细节

`execute(args, ctx)` 统一通过：

```ts
const taskID = yield* resolveTaskIDBySessionID(ctx.sessionID)
```

获取所属任务；若 `taskID` 缺失（非研究 session 中误调用），返回明确错误信息。

## 5. 注册为框架内建工具

按用户决策，直接作为框架内建工具插入：

- 在 `tool/registry.ts` 的内建工具列表（~189-207）追加
  `hypothesis_add` / `hypothesis_update` / `hypothesis_abandon` /
  `hypothesis_list` 四个 `Tool.Def`
- 全局注册不代表全局可用 —— 实际可见性仍由各 agent 的 permission allowlist
  控制（见第 6 节），其余 agent 默认 `"*": "deny"`，不受影响

## 6. Agent 权限调整（agent.ts）

`research-hypo-planner`（agent.ts:258-278）permission allowlist 追加：

```
"hypothesis_add": "allow"
"hypothesis_update": "allow"
"hypothesis_abandon": "allow"
"hypothesis_list": "allow"
```

其余三个研究 agent（`research-data-analysis` / `research-reflection` /
`research-model-designer`）暂不改动。后续如需让 Reflection 只读访问假设池，
可单独追加 `hypothesis_list: "allow"`（本提案不在此范围内，留待后续）。

## 7. Prompt 调整（research-hypo-planner.txt）

- 明确告知模型：假设池的"真值"通过工具维护，不再要求把全部假设重复输出为
  markdown/JSON 块
- 建议的工作流：
  1. 调用 `hypothesis_list` 了解当前池子状态（含历史 `abandoned` 项，避免重复尝试已验证失败的方向）
  2. 对新方向调用 `hypothesis_add`
  3. 对已有假设根据最新实验结果调用 `hypothesis_update`（如 priority、status
     调整）或 `hypothesis_abandon`（附 reason）
- 保留一段简短的人类可读摘要（Reading 部分）用于 TUI 展示，但不作为解析来源

## 8. 与现有流程的衔接

- **Session 模式（有工具）**：
  - 不再调用 `updateTaskHypothesisPlan()`（避免覆盖工具产生的增量结果）
  - 不再依赖 `parseLLMHypotheses()`
  - turn 结束后，`HypoPlannerResult.hypotheses` 通过
    `listHypothesesInPool(taskID)` 读取最新池子状态用于摘要/事件 payload
- **Fallback（无 session / raw LLM）**：
  - 保持现状：`generateLLMHypotheses()` + `updateTaskHypothesisPlan()`
    全量替换不变

## 9. 事件 / 流式更新（event.ts）

新增 `HypoPlannerAgentHypothesisChanged` 事件，在每次
add/update/abandon 工具 `execute` 成功后 publish：

```ts
{
  taskID,
  action: "add" | "update" | "abandon",
  hypoID,
  snapshot: HypothesisObject  // 变更后的完整对象
}
```

`hypothesis_list` 为只读查询，不发事件。

TUI / Web 假设池视图监听该事件做增量刷新，无需等待整轮 agent 结束。

## 10. 测试计划

- **store 层单测**（`test/research/service.test.ts` 或新文件
  `hypothesis-store.test.ts`）：
  - `addHypothesisToPool` / `updateHypothesisInPool` /
    `abandonHypothesisInPool` / `listHypothesesInPool` 基本行为
  - `resolveTaskIDBySessionID` 正确性
  - 越权场景：`hypoID` 不属于当前 `taskID` 时 update/abandon 报错
  - `abandon` 后 `listHypothesesInPool` 默认排除、`includeAbandoned` 时包含
- **工具单测**（`test/tool/research-hypothesis.test.ts`）：
  - mock `ctx.sessionID`，校验四个工具的 execute 返回值与 DB 状态
  - 非研究 session 调用时的错误路径
- **集成/渲染测试**（`tsf-domain.test.ts`、cockpit 渲染测试）：
  - 假设池增量更新后 UI 中 active/abandoned 分类展示正确
  - `HypoPlannerAgentHypothesisChanged` 事件触发 UI 刷新

## 11. 实现顺序建议

1. `research.sql.ts`：新增 `abandon_reason` / `abandoned_at` 列，扩展
   `status` 取值（迁移脚本）
2. `hypothesis-store.ts`：原子 CRUD + `resolveTaskIDBySessionID`
3. `src/tool/research-hypothesis.ts`：四个 `Tool.define(...)`
4. `tool/registry.ts`：注册四个内建工具
5. `agent.ts`：`research-hypo-planner` permission allowlist
6. `research-hypo-planner.txt`：prompt 改写
7. `service.ts`：session 模式下移除
   `updateTaskHypothesisPlan`/`parseLLMHypotheses` 依赖，改为
   `listHypothesesInPool` 摘要
8. `event.ts` + 发布点：`HypoPlannerAgentHypothesisChanged`
9. 测试（第 10 节）

## 12. 剩余开放问题

- 状态转换图是否需要强约束（例如 `confirmed`/`rejected` 之后是否允许再
  `update`）？本提案暂不限制，仅做枚举值校验
- `hypothesis_list` 默认分页/数量上限：池子假设数量预期较小（个位数到十几个），
  暂不分页，后续若需要可加 `limit`
