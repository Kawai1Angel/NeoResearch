# NeoResearch 系统诊断报告

> 诊断日期：2026-05-03  
> 目标参考：`文档/neo_research_目标与关键技术指导提示.md`  
> 诊断结论：TypeScript 层 138 个测试全部通过，逻辑内部一致；**阻塞点在运行时集成层和缺失子系统**。

---

## 一、诊断结论摘要

当前系统约完成目标 MVP 的 **55%**。TypeScript 侧架构完整，各 Agent 有明确 I/O 契约，测试覆盖良好。核心问题集中在：

1. Python 运行时（venv）从未初始化 → 任何训练都无法执行
2. LLM API Key 未配置 → 候选生成退化为纯确定性
3. Intent 答题无法自动重触发 Pipeline → 缺字段时永远卡住
4. Reflection 产出的 hypotheses 未被 NAS 消费 → 自主迭代回路断开

以上四项 P0 问题中，**P0-1（Python venv）是所有问题的硬门槛**，不修复则任何端到端运行都不可能完成。

---

## 二、P0 阻塞项

> 以下问题缺一不可，任意一项未修复均无法完成端到端自主运行。

### P0-1：Python 运行时未初始化

`neo-cast doctor` 报告三个失败：

- Python 版本为系统 `python3 3.9.6`，低于要求的 ≥ 3.10
- `neo-cast init-runtime` 从未执行 → Python venv 不存在
- 所有 `py/validate.py`、`py/runner.py` 子进程调用在启动时立即失败

**影响范围：** `prepareTaskDataset`、`smoke`、`run`、`ref_test`、`blind_test` 全部失败。

**修复：**
```bash
cd <NEO_CAST_ROOT>          # taskSpec.runtime.neoCastProjectRoot 的值
node ./bin/neo-cast.js init-runtime   # 用 uv 创建 Python 3.10+ venv 并安装依赖
```

---

### P0-2：`.env.local` 中无 LLM API Key

`.env.local` 仅含路径变量（`NEO_CAST_ROOT`、`NEO_RESEARCH_RUNTIME_ROOT` 等），**无 `ANTHROPIC_API_KEY`，无 OpenAI-compat key**。

**影响范围：** `proposeLLMCandidate` 返回空提案，Baseline sweep 结束后所有迭代退化为确定性变异，候选多样性极差，无法探索有效搜索空间。

**修复：**
```bash
# 追加到 .env.local
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env.local
```

---

### P0-3：Intent 答题后无法自动重触发 Pipeline

`answerIntentQuestion` 服务方法已实现（`service.ts` line ~4887），但：

- 没有对应的 REST 路由（`POST /research/tasks/:id/intent/answer` 缺失）
- TUI 中无任何动作在用户回答澄清问题后调用此方法并重触发 `runFullPipeline`

**影响范围：** 任何 `missingFields.length > 0` 的任务会被 `PipelineBlockedError(intent_clarification_required)` 卡住，状态永远停在 `paused`，无法自行恢复。

**修复：**
1. 在 `src/server/routes/instance/httpapi/research.ts` 加路由 `POST /tasks/:taskID/intent/answer`
2. 该路由调用 `svc.answerIntentQuestion` 后立即调用 `svc.runFullPipeline`
3. TUI Socratic 面板提交答案后轮询 task status

---

### P0-4：Reflection → NAS 反馈回路断开

Reflection Agent 已实现完整的数据驱动分析（`deriveHypotheses`、三态决策、`failure_log.md`），但 `nextHypotheses` 写入 `next_experiment_plan.md` 后：

- `buildTSFBaselines` **不读此文件**
- `mutate.py` **不接收** `searchBiases` 或 hypotheses 作为输入参数
- `runAutonomousLoop` 不将 Reflection 结果传回下一轮候选生成

**影响范围：** 自主迭代回路是开环的。Reflection Agent 的假设没有后续，每轮 NAS 从相同起点开始，无法实现"学习式迭代"。

**修复：**
1. `service.ts` 的 `runNASAgent` / `runAutonomousLoop` 在每轮结束后调用 `runReflectionAgent`
2. 将 `analysis.nextHypotheses` 作为 `searchBiases` 注入下一轮 `proposeTSFCandidate`
3. `mutate.py` 增加 `--search-biases` JSON 参数接口

---

## 三、各层现状详查

### 3.1 Intent Agent

| 项目 | 状态 |
|------|------|
| 15-slot 结构化意图收集 | ✅ 已实现 |
| Socratic / Companion 双模式问题生成 | ✅ 已实现 |
| LLM 精炼（`NEO_RESEARCH_INTENT_LLM=1`） | ⚠️ opt-in 环境变量，无 UI 配置 |
| `intent_spec.md` artifact 写入 | ✅ 已实现 |
| `answerIntentQuestion` 服务方法 | ✅ 已实现 |
| REST 路由 + Pipeline 重触发 | ❌ **缺失（P0-3）** |
| TUI 15-slot 面板 | ❌ 停留在旧版 4-slot 布局 |

---

### 3.2 Data Analysis Agent

| 项目 | 状态 |
|------|------|
| 7 个统计摘要（来自 `prepare_tsf.py`） | ✅ 已实现 |
| TypeScript 层 markdown artifact 渲染 | ✅ 已实现 |
| 三份 artifact（quantitative / qualitative / main summary） | ✅ 已实现 |
| 4 张 PNG 图表（simplePng 生成） | ✅ 已实现（纯 TS 实现，无 matplotlib） |
| KPSS / STL-style / FFT / changepoint 计算 | ✅ 已实现（TS 层，近似实现） |
| LLM 生成定性分析 | ⚠️ 已加调用，25s 超时后退回模板 |
| 专用 Python `analysis/` 模块 | ❌ `neo_cast/py/analysis/` 不存在 |
| matplotlib PNG chart artifacts | ❌ 无 Python 侧图表 |

---

### 3.3 NAS / 候选生成

| 项目 | 状态 |
|------|------|
| Profile 驱动的 Baseline 选择 | ✅ 已实现（seasonality / cross-var / shift / missing 四路分支） |
| `ACTION_REGISTRY`（10 个 action 维度） | ✅ 已实现 |
| `experiment_log.md` per-iteration 摘要 | ✅ 已实现 |
| LLM candidate proposal | ⚠️ 依赖 P0-2 API Key |
| `mutate.py` 接收 `datasetProfile` | ❌ **缺失** |
| Reflection → NAS 反馈 | ❌ **缺失（P0-4）** |
| phase2 backbone 可运行（rnn / tcn / ssm / nbeats…） | ❌ 全部 `bridgeSupported: false` |
| 外生变量 / calendar 特征 action space | ❌ 缺失 |
| Model Recipe DSL（YAML） | ❌ `candidateSpec` 是 opaque JSON |

---

### 3.4 Runner（Python 侧）

| 项目 | 状态 |
|------|------|
| runner-manifest.json（runner.v1） | ✅ 已实现 |
| `validate.py`、`runner.py`、`renderer.py` | ✅ 文件存在 |
| `nlinear`、`patch_mlp`、`tiny_transformer` model families | ✅ 已实现 |
| Python venv（uv 初始化） | ❌ **未创建（P0-1）** |
| `mutate.py` 接收 profile / biases | ❌ 缺失 |

---

### 3.5 Verifier Agent

| 项目 | 状态 |
|------|------|
| metric_verifier | ✅ |
| baseline_comparison_verifier | ✅ |
| cost_perf_verifier | ✅ |
| horizon_verifier | ✅ |
| overfitting_verifier | ✅ |
| data_leakage_verifier | ❌ **缺失（目标 §4.8.8 明确要求）** |
| `VerifierAgentResult.artifact` | ⚠️ 始终为 `undefined` |

---

### 3.6 Reflection Agent

| 项目 | 状态 |
|------|------|
| 错误分类（oom / nan / not_converge / script_error / rejected / other） | ✅ 已实现 |
| plateau streak / crash streak 检测 | ✅ 已实现 |
| `reflection_notes.md` 生成（含 Run Summary / Effective Changes / Failures / Decision） | ✅ 已实现 |
| `next_experiment_plan.md` 生成（含数据驱动 Hypotheses + Recommended Next Action） | ✅ 已实现 |
| `failure_log.md` 生成（schema v1，含 recovery_action / recovery_summary） | ✅ 已实现 |
| 数据驱动 hypotheses（seasonality / drift / cross-var / OOM / NaN / plateau） | ✅ 已实现（`deriveHypotheses`） |
| Reflection 决策三态（continue / stop / request_human） | ✅ 已实现（`decide`） |
| LLM synthesis | ❌ 硬关闭（`llm: { status: "disabled" }`） |
| hypotheses → 下一轮 NAS mutation hints | ❌ **断开（P0-4）**：`nextHypotheses` 写入文件后 `mutate.py` 不读取 |

---

### 3.7 Publish / Report

| 项目 | 状态 |
|------|------|
| `model_export_package` 生成 | ✅ 已实现 |
| 4 个 Companion checkpoint | ✅ 已实现 |
| PNG 嵌入最终报告 | ❌ 缺失 |
| `failure_log.md` 纳入 bundle | ❌ 缺失 |
| `reflection_notes.md` 纳入 bundle | ❌ 缺失 |
| checkpoint `options[]` / `recommended` 字段 | ❌ 缺失 |

---

### 3.8 Skill 子系统

**状态：完全缺失。**

无 `skills/` 目录，无 `SkillRegistry`，无 seed skills，无 skill schema，无 skill 触发机制。这是相对目标 §4.6、§4.8.10 的最大结构性缺口。

---

### 3.9 Memory

| 项目 | 状态 |
|------|------|
| 单层 SQL 内存（per-task lesson） | ✅ 已实现 |
| 跨任务 recall（`recallByFingerprint`） | ❌ 缺失 |
| `session_summary.md` 压缩 | ❌ 缺失 |
| 长期记忆表 | ❌ 缺失 |
| `skills_index.md` | ❌ 缺失 |

---

## 四、目标对齐度（vs 目标 §11 MVP 标准）

```
Intent 澄清（§3.1）         ███████░░░  70%   back-channel 缺失
Data Analysis（§3.2）       ████░░░░░░  40%   浅层 stats，无 Python 分析模块
Baseline Search / NAS       ██████░░░░  60%   可跑但 venv 未建
Verifier（§4.8.8）          ███████░░░  70%   5/7 verifier，缺 leakage
Reflection（§4.8.9）        ███████░░░  70%   分析+决策+三份 artifact 完整；反馈回路断开
Publish / Report            ███████░░░  70%   无 PNG，无 failure_log
Skill 子系统（§4.6）        ░░░░░░░░░░   0%   完全缺失
Memory 跨任务（§4.1）       ██░░░░░░░░  20%   单层 SQL 只
目录结构（§7）              ██░░░░░░░░  20%   无标准布局

整体完成度                  ≈ 55%
```

---

## 五、解锁首次成功自主运行的最小步骤

> 按优先级排序。完成前 3 步即可跑出第一次端到端运行（浅层）；完成全部 5 步后系统真正"自主迭代"。

### Step 1（~30 min）：初始化 Python 运行时

```bash
cd <NEO_CAST_ROOT>
node ./bin/neo-cast.js init-runtime
node ./bin/neo-cast.js doctor          # 验证通过
```

### Step 2（~5 min）：配置 LLM API Key

```bash
echo "ANTHROPIC_API_KEY=sk-ant-..." >> \
  /path/to/neo-research/.env.local
```

### Step 3（~1 hr）：准备完整 taskSpec 绕过 Intent Clarification

准备一个 15 个槽位全部填好的 `taskSpec`（以 ETTh1 为例），直接调用 `runFullPipeline` API，避免触发 `intent_clarification_required`。在系统稳定前以此作为"已知良好"的起点。

**最小可运行 taskSpec 示例：**
```json
{
  "dataset": {
    "path": "/absolute/path/to/ETTh1.csv",
    "targetCols": ["OT"],
    "loaderID": "etth1"
  },
  "runtime": {
    "neoCastProjectRoot": "/absolute/path/to/neo_cast"
  },
  "contextLength": 512,
  "predictionLengths": [96, 192, 336, 720],
  "metadata": {
    "businessContext": "ETTh1 electricity transformer benchmark",
    "interpretability": "none_required",
    "deploymentTarget": "local_research",
    "interactionMode": "socratic"
  }
}
```

### Step 4（~1 day）：接通 Reflection → NAS 反馈回路

1. `service.ts` `runNASAgent` 每轮结束后运行轻量 Reflection
2. 将 `analysis.nextHypotheses` 转换为 `searchBiases` 注入下一轮 `proposeTSFCandidate`
3. `mutate.py` 增加 `--search-biases '["seasonal","trend"]'` JSON 参数

### Step 5（~半 day）：实现 Intent 答题 REST 路由 + Pipeline 重触发

```
POST /research/tasks/:taskID/intent/answer
Body: { "slots": { "dataset_path": "...", ... } }
→ svc.answerIntentQuestion(input)
→ svc.runFullPipeline({ taskID })
```

---

## 六、后续 P1 任务（MVP 稳定后）

| 任务 | 预估工期 | 目标章节 |
|------|---------|---------|
| Data Leakage Verifier | 3 天 | §4.8.8 |
| Python `analysis/` 模块（真实 KPSS/STL/FFT） | 3 天 | §3.2 |
| `matplotlib` PNG chart artifacts | 2 天 | §5.11 |
| Skill Registry + 3 个 seed skills | 1 周 | §4.6, §4.8.10 |
| 跨任务 Memory recall | 2 天 | §4.1 |
| Session 目录标准布局（§7） | 1 天 | §7 |
| phase2 backbone 接入（dlinear / tcn / rnn） | 2 天 | §3.3 |
| Reflection LLM synthesis 开启 | 1 天 | §4.8.9 |

---

*本文档由 Claude Code 自动生成，基于 2026-05-03 代码库快照。*
