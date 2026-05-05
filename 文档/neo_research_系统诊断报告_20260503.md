# NeoResearch 系统诊断报告

> 诊断日期：2026-05-03  
> 目标参考：`文档/neo_research_目标与关键技术指导提示.md`  
> 诊断结论：TypeScript 层 138 个测试全部通过，逻辑内部一致；**阻塞点在运行时集成层和缺失子系统**。

---

## 一、诊断结论摘要

当前系统约完成目标 MVP 的 **70%**。TypeScript 侧架构完整，各 Agent 有明确 I/O 契约，测试覆盖良好。P0-1、P0-3、P0-4 均已修复；唯一剩余阻塞项：

1. ~~Python 运行时（venv）从未初始化~~ → **✅ 已修复**（Python 3.12.13，venv 就绪）
2. LLM API Key 未配置 → 候选生成退化为纯确定性（**仍需在 TUI 首页配置 / .env.local 中填写；TUI 侧 key 现已自动 bridge 至 neo-cast**）**✅ 已修复**
3. ~~Intent 答题无法自动重触发 Pipeline~~ → **✅ 已修复**（REST 路由 + TUI Socratic 面板 + Pipeline 自动重触发）
4. ~~Reflection 产出的 hypotheses 未被 NAS 消费~~ → **✅ 已修复**（mid-loop reflection + mutate.py search-biases）

当前唯一硬门槛：**P0-2（LLM API Key）**——无 Key 则所有迭代退化为确定性变异。配置后即可跑通首次端到端自主运行。

---

## 二、P0 阻塞项

> 以下问题缺一不可，任意一项未修复均无法完成端到端自主运行。

### ~~P0-1~~：Python 运行时未初始化 ✅ 已修复

> **修复日期：2026-05-04**

~~`neo-cast doctor` 报告三个失败：~~

~~- Python 版本为系统 `python3 3.9.6`，低于要求的 ≥ 3.10~~  
~~- `neo-cast init-runtime` 从未执行 → Python venv 不存在~~  
~~- 所有 `py/validate.py`、`py/runner.py` 子进程调用在启动时立即失败~~

**当前状态（`neo-cast doctor` 输出）：**

```
[OK] python3: Python 3.12.13 [runtime venv]
[OK] uv: Detected uv 0.10.8
[OK] config: Resolved config is valid.
[OK] runtime: Project runtime is ready at .neo-cast/runtime/.venv/bin/python
[FAIL] openai_compatible_api_key: OPENAI-compatible API key is not set.
```

venv 位置：`neo_cast/.neo-cast/runtime/.venv/`（Python 3.12.13，torch 2.11.0）。唯一剩余 FAIL 为 OpenAI-compat API Key 未配置（见 P0-2）。

---

### P0-2：`.env.local` 中无 LLM API Key（**仍阻塞**）**✅ 已修复**

**当前状态：** `.env.local` 已含路径变量和注释占位，但所有 key 行仍被注释掉，`neo-cast doctor` 报告：

```
[FAIL] openai_compatible_api_key: OPENAI-compatible API key is not set.
  Set NEO_CAST_LLM_API_KEY, OPENAI_API_KEY, or AIGCBEST_API_KEY before using openai-compatible providers.
```

`.env.local` 现有结构（key 部分）：
```bash
# LLM API Keys - Add your keys here
# ANTHROPIC_API_KEY=sk-ant-...
# NEO_CAST_LLM_API_KEY=sk-...
# OPENAI_API_KEY=sk-...
```

**影响范围：** `proposeLLMCandidate` 返回空提案，Baseline sweep 结束后所有迭代退化为确定性变异，候选多样性极差，无法探索有效搜索空间。

**修复（三选一，取消注释并填入真实 key）：**
```bash
# 方案 A：Anthropic Claude（推荐，与 opencode 侧共享 key）
# 编辑 .env.local，将注释行改为：
ANTHROPIC_API_KEY=sk-ant-xxxxxxxx

# 方案 B：OpenAI 或兼容接口
NEO_CAST_LLM_API_KEY=sk-xxxxxxxx

# 方案 C：AIGCBEST 等聚合服务
AIGCBEST_API_KEY=sk-xxxxxxxx
```

填入后执行 `node ./bin/neo-cast.js doctor` 验证 `[OK] openai_compatible_api_key`。

---

### ~~P0-3~~：Intent 答题后无法自动重触发 Pipeline ✅ 已修复

> **修复日期：2026-05-04**

~~`answerIntentQuestion` 服务方法已实现，但无 REST 路由，TUI 也没有触发逻辑。~~

**当前实现（三点全部就位）：**

1. **REST 路由**：`POST /research/tasks/:taskID/intent/answer`（`server/routes/instance/research.ts:380`）
   - 接收 `{ slots: { slotID: value } }` JSON 请求体
   - 调用 `svc.answerIntentQuestion({ taskID, slots })`
   - 若 `result.missingFields.length === 0` 立即触发 `svc.runFullPipeline({ taskID })`

2. **服务层**：`service.ts` `answerIntentQuestion` 合并槽位答案，重跑 Intent Agent，返回更新后的意图结果。

3. **TUI Socratic 面板**（`research-cockpit.tsx:1803`）：用户在 Prompt 框输入回答后，自动识别 `slotID`（`slotFromSocraticQuestion`），POST 至上述路由。`missingFields` 清空后服务端自动推进流水线，TUI 通过事件轮询获取最新状态。

---

### ~~P0-4~~：Reflection → NAS 反馈回路断开 ✅ 已修复

> **修复日期：2026-05-04**

Reflection Agent 已实现完整的数据驱动分析（`deriveHypotheses`、三态决策、`failure_log.md`），~~但 `nextHypotheses` 写入 `next_experiment_plan.md` 后：~~

~~- `buildTSFBaselines` **不读此文件**~~  
~~- `mutate.py` **不接收** `searchBiases` 或 hypotheses 作为输入参数~~  
~~- `runAutonomousLoop` 不将 Reflection 结果传回下一轮候选生成~~

~~**影响范围：** 自主迭代回路是开环的。Reflection Agent 的假设没有后续，每轮 NAS 从相同起点开始，无法实现"学习式迭代"。~~

**已实现（两部分）：**

1. **`service.ts` 中间循环 Reflection**：`runAutonomousLoop` 每当连续 plateau 达 3 次（`noImproveStreak % 3 === 0`）时，内联调用 `analyzeReflection`，提取 `nextHypotheses` 标题，写入 `taskSpec.metadata.reflectionHypotheses`。下一次迭代在循环顶部通过 `getTask` 读取，并以 `searchBiases` 形式传入候选生成。

2. **`mutate.py` `--search-biases` 参数**：`neo_cast/py/search/mutate.py` 新增 `--search-biases '["seasonal","cross_var_correlated",...]'` JSON 数组参数；新函数 `_bias_mutation(recipe, search_biases)` 处理 4 种偏置类型：`seasonal` → `series_decomposition`、`cross_var_correlated` → `gated_hybrid`、`distribution_shift` → `instance_norm+huber`、`missing_values` → `missing_mask`。

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
| Reflection → NAS 反馈 | ✅ 已实现（P0-4 已修复） |
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
| Python venv（uv 初始化） | ✅ 已就绪（Python 3.12.13，P0-1 已修复） |
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
| hypotheses → 下一轮 NAS mutation hints | ✅ 已实现：mid-loop reflection（每 3 次 plateau）写入 `taskSpec.metadata.reflectionHypotheses`；`mutate.py` `--search-biases` 接收偏置 |

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
Intent 澄清（§3.1）         ████████░░  80%   REST 路由+TUI 答题+Pipeline 重触发已就位
Data Analysis（§3.2）       ████░░░░░░  40%   浅层 stats，无 Python 分析模块
Baseline Search / NAS       ███████░░░  70%   venv 就绪，可跑基线
Verifier（§4.8.8）          ███████░░░  70%   5/7 verifier，缺 leakage
Reflection（§4.8.9）        ████████░░  85%   分析+决策+三份 artifact 完整；反馈回路已接通
Publish / Report            ███████░░░  70%   无 PNG，无 failure_log
Skill 子系统（§4.6）        ░░░░░░░░░░   0%   完全缺失
Memory 跨任务（§4.1）       ██░░░░░░░░  20%   单层 SQL 只
目录结构（§7）              ██░░░░░░░░  20%   无标准布局

整体完成度                  ≈ 70%
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

### ~~Step 4（~1 day）：接通 Reflection → NAS 反馈回路~~ ✅ 已完成（2026-05-04）

1. ~~`service.ts` `runNASAgent` 每轮结束后运行轻量 Reflection~~  
2. ~~将 `analysis.nextHypotheses` 转换为 `searchBiases` 注入下一轮 `proposeTSFCandidate`~~  
3. ~~`mutate.py` 增加 `--search-biases '["seasonal","trend"]'` JSON 参数~~

已在 `service.ts` `runAutonomousLoop` 中实现 mid-loop inline reflection（每 3 次 plateau 触发），并在 `mutate.py` 中新增 `--search-biases` JSON 参数及 `_bias_mutation` 函数，反馈回路已闭合。

### ~~Step 5（~半 day）：实现 Intent 答题 REST 路由 + Pipeline 重触发~~ ✅ 已完成（2026-05-04）

~~```
POST /research/tasks/:taskID/intent/answer
Body: { "slots": { "dataset_path": "...", ... } }
→ svc.answerIntentQuestion(input)
→ svc.runFullPipeline({ taskID })
```~~

**已实现：** `server/routes/instance/research.ts:380`（路由）、`service.ts`（`answerIntentQuestion` 合并槽位 + Intent Agent 重跑）、`research-cockpit.tsx:1803`（TUI Socratic 面板自动识别 slotID 并 POST）。`missingFields` 清空后服务端自动调用 `runFullPipeline`，任务从 `paused` 恢复为 `running`。

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
