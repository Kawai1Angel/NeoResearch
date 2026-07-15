# Reflection Agent Tool-Fetch Migration Plan

## Background

HypoPlanner 通过工具调用（`read_reflection`、`experiment_results`、`hypothesis_list` 等）主动拉取所需数据。Reflection Agent 目前的模式相反：service.ts 在调用前把所有数据预加载，序列化成一个 fat JSON 通过 `buildReflectionLLMUserPrompt` 注入给 LLM。

本计划新增两个工具（`read_training_curve`、`read_memory_lessons`），使 Reflection 也能切换到工具驱动的数据获取模式。

---

## 现状分析

### service.ts 预加载逻辑（7659–7712 行）

`runReflectionAgent` 在进入 session 之前完成以下工作：

| 预加载项 | 来源 | 对应工具 |
|---|---|---|
| 近期 run 结果（status、metric、error） | `listRuns` + 排序 | `experiment_results`（已有） |
| 上一轮 Reflection 产物 | 读文件系统 | `read_reflection`（已有） |
| 最新 training curve | 查 `runner_progress_jsonl` artifact → 读 JSONL 文件 | **`read_training_curve`（新增）** |
| recent memory lessons（最近 2 条） | `listMemory` + 排序 | **`read_memory_lessons`（新增）** |
| best memory lesson（历史最优 metric 对应） | 同上，遍历找最优 | **`read_memory_lessons`（新增）** |

新增两个工具后，`ReflectionLLMContext` 构造和 `buildReflectionLLMUserPrompt` 的 fat JSON 可随之删除。

---

## 新增工具规格

### Tool 1: `read_training_curve`

**文件：** `src/tool/research-context.ts`

**描述：**
Read the training curve (epoch-by-epoch val loss) for a run in the current research task.
Returns an ordered array of `{ epoch, valLoss, horizon?, elapsedS? }` points, uniformly
sampled to `maxPoints` if the raw log is longer. Returns `{ available: false }` if no
progress artifact exists for the requested run.

**参数：**

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `runID` | `string?` | 省略 | 指定 run；省略则自动选最近一次 `succeeded` run，再 fallback 到最近任意 run |
| `maxPoints` | `number?` | `60` | 返回点数上限（1–120），超出则均匀采样，始终保留首尾点 |

**执行流程：**
1. `resolveTaskIDBySessionID(ctx.sessionID)` → taskID；未解析返回 `NOT_IN_RESEARCH_SESSION`
2. 若传了 `runID`，查 `ResearchRunTable` 验证归属；否则按 `time_updated DESC` 找最近 `succeeded`，再 fallback 到最新任意 run
3. 查 `ResearchArtifactTable` where `task_id = taskID AND run_id = runID AND kind = "runner_progress_jsonl"` 取 `uri`
4. 读取文件（`file://` 前缀去掉），按行解析 JSONL：`{ epoch, val_loss|valLoss, horizon?, elapsed_s|elapsedS? }`，跳过解析失败行
5. 若点数 > maxPoints：均匀采样，`step = (n-1)/(maxPoints-1)`，始终包含第 0 和最后一个点
6. 返回：
```json
{
  "available": true,
  "runID": "...",
  "runStatus": "succeeded",
  "pointCount": 42,
  "curve": [{ "epoch": 1, "valLoss": 0.45 }, ...]
}
```
找不到 artifact 时返回 `{ "available": false }`

**依赖搬移：** `extractTrainingCurve` 当前是 `service.ts` 私有函数，需提取到 `research-context.ts`（或单独的 `src/research/training-curve.ts`）并 export；`service.ts` 改为 import。

---

### Tool 2: `read_memory_lessons`

**文件：** `src/tool/research-context.ts`

**描述：**
Read historical experiment memory for the current research task. Returns the most recent
lessons and, optionally, the lesson from the run that achieved the best primary metric.
Use this to avoid repeating known-failing designs and to ground new hypotheses in evidence.

**参数：**

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `recentLimit` | `number?` | `2` | 最近 N 条 lesson（1–10） |
| `includeBest` | `boolean?` | `true` | 是否返回历史最优 metric 对应的 lesson（去重，不与 recent 重复） |

**执行流程：**
1. `resolveTaskIDBySessionID(ctx.sessionID)` → taskID
2. 查 `ResearchMemoryTable` where `task_id = taskID`，按 `time_created DESC` 取全量
3. 取前 `recentLimit` 条 → `recentLessons: string[]`
4. 若 `includeBest`：
   - 额外查 `ResearchTaskTable.objective` 拿 `direction`（`"minimize"` | `"maximize"`）
   - 遍历全量 memories，读 `candidate_summary.bestMetric`（number），按 direction 找最优
   - 若最优 memory 不在 recentLessons 里 → `bestLesson: string`
5. 返回：
```json
{
  "totalMemories": 7,
  "recentLessons": ["...", "..."],
  "bestLesson": "..."
}
```
无记录时 `recentLessons: []`，`bestLesson` 省略

---

## 变更文件列表

| 文件 | 变更类型 | 内容 |
|---|---|---|
| `src/tool/research-context.ts` | 新增 | `ReadTrainingCurveTool`、`ReadMemoryLessonsTool`；搬入 `extractTrainingCurve` 逻辑 |
| `src/tool/registry.ts` | 修改 | import 两个新工具；`yield*` 初始化；加入 `tool map` 和 `builtin` 列表 |
| `src/research/service.ts` | 修改 | import `extractTrainingCurve`（若提取为独立文件）；**后续阶段**删除 7659–7712 预加载块、`ReflectionLLMContext`、`buildReflectionLLMUserPrompt` |
| `src/agent/prompt/research-reflection.txt` | 修改 | **后续阶段**改为 HypoPlanner 风格 workflow，描述 4 步工具调用流程 |

> `src/research/service.ts` 和 prompt 的修改属于**后续阶段**，不在本次范围内。本次只交付两个工具 + registry 注册。

---

## 注册方式（registry.ts）

```ts
// import
import {
  ReadReflectionTool,
  ExperimentResultsTool,
  ReadTrainingCurveTool,   // 新增
  ReadMemoryLessonsTool,   // 新增
} from "./research-context"

// Layer 内 yield*
const readTrainingCurve = yield* ReadTrainingCurveTool
const readMemoryLessons = yield* ReadMemoryLessonsTool

// tool map
readTrainingCurve: Tool.init(readTrainingCurve),
readMemoryLessons: Tool.init(readMemoryLessons),

// builtin 列表（紧跟 readReflection / experimentResults）
tool.readTrainingCurve,
tool.readMemoryLessons,
```

---

## 后续阶段：Reflection prompt workflow（参考）

工具添加完成后，`research-reflection.txt` 改为：

```
## Workflow
1. Call experiment_results(limit=20) — review recent run outcomes.
2. Call read_reflection              — read what the previous Reflection cycle concluded.
   If { available: false }, this is the first iteration.
3. Call read_training_curve()        — load the training curve for the latest run.
4. Call read_memory_lessons()        — retrieve recent and best historical lessons.
5. Output the 7-key JSON object.
```

`buildReflectionLLMUserPrompt` 的 fat JSON payload 和 service.ts 7659–7712 的预加载块随之删除。

---

## 实现顺序

1. 提取 `extractTrainingCurve` 逻辑（从 service.ts 搬到 research-context.ts）
2. 实现 `ReadTrainingCurveTool`
3. 实现 `ReadMemoryLessonsTool`
4. 更新 `registry.ts`
5. 跑 typecheck + 相关 tests
6. （后续）service.ts 预加载删除 + prompt 改写
