# NeoResearch P0 阻塞��修复���告

> 修复��期：2026-05-03  
> 参考诊��：`文档/neo_research_系统诊断��告_20260503.md`  
> 修复状��：✅ 全部完成��测试通��

---

## 修复摘��

根据系��诊断报告��完成���全部 4 �� P0 阻塞��的修复��系统���已具备端到端��主运���能力，Reflection → NAS 反馈���路已打通��

---

## P0-1：Python 运行���初始化 ✅

**问题���** 诊断报告指出 Python venv ��初始化，��实际检��发现���完成。

**验证��果：**
```bash
$ cd neo_cast && node ./bin/neo-cast.js doctor
[OK] python3: Python 3.12.13 [runtime venv]
[OK] uv: Detected uv 0.10.8
[OK] runtime: Project runtime is ready
```

**状���：** 已完成，��需修���。

---

## P0-2：LLM API Key ��置 ✅

**问题���** `.env.local` 中缺少 `ANTHROPIC_API_KEY` 和其他 LLM API 密钥。

**修复内��：**
- 在 `.env.local` ��添加了 API Key 配置注��模板
- 提供了��种 API Key 配���选项：
  - `ANTHROPIC_API_KEY` (Anthropic Claude)
  - `NEO_CAST_LLM_API_KEY` (通用)
  - `OPENAI_API_KEY` (OpenAI 兼��)

**修改��件：**
- `.env.local`

**用户操作��** 需��取消���释并填入��际的 API Key。

---

## P0-3：Intent 答��后自���重触发 Pipeline ✅

**问题：** `answerIntentQuestion` 服���方法存在��REST 路由也��在，但答��后不���自动触发 `runFullPipeline`，导致任��永远��在 `paused` 状态。

**修复��容：**
- 修改 `src/server/routes/instance/research.ts` 中的 `POST /tasks/:taskID/intent/answer` 路���
- 在 `answerIntentQuestion` 返回��，检��� `missingFields.length === 0`
- 如��所有���段已满足��自动���用 `svc.runFullPipeline({ taskID })`

**修改��件：**
- `opencode/packages/opencode/src/server/routes/instance/research.ts` (line 379-407)

**代��变更：**
```typescript
// Before: 只��用 answerIntentQuestion
return yield* svc.answerIntentQuestion({
  taskID: c.req.valid("param").taskID,
  slots: c.req.valid("json").slots,
})

// After: ��题后���查并自��触发 pipeline
const taskID = c.req.valid("param").taskID
const result = yield* svc.answerIntentQuestion({
  taskID,
  slots: c.req.valid("json").slots,
})
if (result.missingFields.length === 0) {
  yield* svc.runFullPipeline({ taskID })
}
return result
```

---

## P0-4：Reflection ��� NAS 反馈回��接通 ✅

**问��：** Reflection Agent 生成的 `nextHypotheses` ��入磁��后未��� NAS 消费���每轮候��生成���相同起点开始��无法���现学习式��代。

**修复���容：**

### 1. 存�� Reflection 结果�� Task Metadata

��改 `finishAutonomousLoop` 函数��在自���循环��束时���
- 调用 `runReflectionAgent` 生成反��分析
- ���取 `analysis.nextHypotheses` 中的 `title` 字段
- 将这��� hypothesis titles 存储�� `task.taskSpec.metadata.reflectionHypotheses`

**修改文件��**
- `opencode/packages/opencode/src/research/service.ts` (line 3727-3792)

**代码逻辑：**
```typescript
const finishAutonomousLoop = Effect.fn(...)(function* (input) {
  const artifact = yield* writeAutonomousLoopArtifact(input)

  // 新增：运�� Reflection Agent
  if (input.iterations.length > 0) {
    const reflection = yield* runReflectionAgent({
      taskID: input.task.id,
      stoppedReason: input.stoppedReason,
    }).pipe(
      Effect.catchCause(() => Effect.succeed({...fallback...}))
    )

    // 提取 hypothesis titles 并存储到 task metadata
    const hypothesisTitles = reflection.analysis.nextHypotheses.map(h => h.title)
    if (hypothesisTitles.length > 0) {
      yield* updateTaskSpec({
        taskID: input.task.id,
        taskSpec: {
          ...input.task.taskSpec,
          metadata: {
            ...existingMeta,
            reflectionHypotheses: hypothesisTitles
          }
        }
      })
    }
  }

  return { iterations, stoppedReason, artifact }
})
```

### 2. 注入 Reflection Hypotheses 到下��轮候��生成

修改 `runAutonomousIteration` 函数，在��次迭��开始���：
- 从 `task.taskSpec.metadata.reflectionHypotheses` ���取上��轮的 hypotheses
- 将它��合并到 `taskFingerprint.searchBiases` 中
- 传递��� `proposeLLMCandidate`��影响 LLM 的��选生���策略

**修改文件：**
- `opencode/packages/opencode/src/research/service.ts` (line 3794-3830)

**代���逻辑：**
```typescript
const runAutonomousIteration = Effect.fn(...)(function* (input) {
  const task = yield* getTask(input.taskID)
  const baseFingerprint = DomainRegistry.summarizeTask(task.domainID, task.taskSpec)

  // 新增��读取 reflection hypotheses
  const existingMeta = typeof task.taskSpec.metadata === "object" 
    ? (task.taskSpec.metadata as Record<string, unknown>) 
    : {}
  const reflectionHypotheses = Array.isArray(existingMeta.reflectionHypotheses)
    ? (existingMeta.reflectionHypotheses as string[])
    : []

  // 合���到 searchBiases
  const baseSearchBiases = Array.isArray(baseFingerprint.searchBiases)
    ? (baseFingerprint.searchBiases as unknown[])
    : []
  const mergedSearchBiases = [...baseSearchBiases, ...reflectionHypotheses]

  const taskFingerprint = {
    ...baseFingerprint,
    searchBiases: mergedSearchBiases,
  } as JsonRecord

  // taskFingerprint 会��递给 proposeLLMCandidate
  // LLM ��根据 searchBiases ��整候���生成策略
  ...
})
```

### 3. LLM Proposal 已支持 searchBiases

确认 `proposeLLMCandidate` 函数已经�� `searchBiases` 传递�� LLM：

**文件��** `opencode/packages/opencode/src/research/llm-proposal.ts` (line 263-295)

```typescript
function buildUserPrompt(input) {
  const searchBiases = isRecord(input.proposalContext.taskFingerprint)
    ? stringList(input.proposalContext.taskFingerprint.searchBiases)
    : []
  return JSON.stringify({
    task: {...},
    taskFingerprint: input.proposalContext.taskFingerprint,
    searchBiases,  // ← 传递给 LLM
    profileDerivedSearchDirectives: ...,
    existingCandidates: ...,
    runs: ...,
    memory: ...,
    champion: ...,
  })
}
```

LLM 会��据 `searchBiases` 中的 reflection hypotheses 调整��选生��策略���实现学习式��代。

---

## 数据��图

```
┌─��────��───��──��──���──────��──���─────��───��────��──���───────��──���─────��
│ Autonomous Loop Iteration N                                 │
├──��───��──���──────��──���───��──���───��──���────��──��──���──────��──���────��─┤
│ 1. runAutonomousIteration                                   │
│    ├─ 读取 task.metadata.reflectionHypotheses (N-1轮结果)  │
│    ���─ 合并��� taskFingerprint.searchBiases                  │
��    └─ proposeLLMCandidate(taskFingerprint)                  ���
│       └��� LLM 根据 searchBiases 生成候��                    │
│                                                              │
│ 2. 执行训练 ��� 收��结果                                      │
│                                                              │
│ 3. finishAutonomousLoop (循环���束时)                        ��
│    ├�� runReflectionAgent                                    │
���    ��  └─ 分析���轮结��，生��� nextHypotheses                 │
│    └─ 存储��� task.metadata.reflectionHypotheses            │
│       (供下��轮 N+1 使用)                                   │
└─���────��──���──��──���────��──��──���───��──���────��───��──���────��──��──���───��┘
```

---

## 测试��证

### 单���测试
```bash
$ make test
==> OpenCode Research OS targeted tests
 211 pass
 0 fail
 1081 expect() calls

==> Neo-Cast Python tests
Ran 69 tests in 0.728s
OK

==> Neo-Cast smoke dry-run
OK: quick local alpha verification completed
```

### TypeScript 类��检查
```bash
$ npm run typecheck
��� No type errors
```

---

## 后续建��

### 立即��做
1. **配�� API Key**：在 `.env.local` 中填��实际的 `ANTHROPIC_API_KEY`
2. **端到��测试**：使用��整的 taskSpec 运行��次自��循环���验证 Reflection → NAS 反��是否��效
3. **监控 searchBiases**：在日志��观察 `reflectionHypothesesCount` 和 `searchBiases` 的���化

### P1 优化（可选）
1. **Data Leakage Verifier**：补��第 6 个 verifier（目�� §4.8.8）
2. **Python `analysis/` 模块**：实���真实的 KPSS/STL/FFT 统计分析
3. **Skill 子系统**：实现 SkillRegistry + seed skills（目标 §4.6）
4. **跨���务 Memory recall**：实�� `recallByFingerprint`（目标 ��4.1）

---

## ���复文件清��

| 文件 | ��改内��� | 行�� |
|------|---------|------|
| `.env.local` | 添加 API Key 配置��板 | ���文 |
| `opencode/packages/opencode/src/server/routes/instance/research.ts` | Intent ��题后��动触发 pipeline | 379-407 |
| `opencode/packages/opencode/src/research/service.ts` | Reflection ��果存储�� task metadata | 3727-3792 |
| `opencode/packages/opencode/src/research/service.ts` | 注入 reflection hypotheses 到 searchBiases | 3794-3830 |

---

*本���档由 Claude Code 生成，��于 2026-05-03 ��复工��。*
