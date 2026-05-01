# Vibe Data Science 愿景对齐度 Review

> 日期：2026-05-01
> 目标：评估当前 NeoResearch 系统是否实现了 Vibe Data Science 的完整闭环（在 TSF 领域实例化）
> 评估对象：`neo_cast/` + `opencode/`

---

## 一、需求分解

用户描述的 Vibe Data Science 闭环包含 8 个阶段：

| # | 阶段 | 核心动作 |
|---|------|---------|
| 1 | 用户需求提出 | 接收自然语言/数据集路径 |
| 2 | Data 自动定性 + 定量分析 | 描述数据的统计特性、模式 |
| 3 | 自主假设 | 基于数据特性形成可验证的研究假设 |
| 4 | 小模型设计规划 | 把假设转成具体的模型方案 |
| 5 | 资源约束训练 | 在给定算力/时间预算内训练 |
| 6 | 自主迭代 | 基于上轮结果调整设计 |
| 7 | 收敛判定 | "迭代出一个不错的小模型" |
| 8 | 整理输出 | 实验结果 + 实验报告 + 模型代码 + 训练参数 |

---

## 二、逐阶段对齐度评估

### 阶段 1 — 用户需求提出 ✅ 完全实现

**实现位置**：
- `home.tsx:292-306` — 自然语言输入 textarea，`Forecast ETTh1 horizon=24` 等
- `research-cockpit.tsx:410-424` — `createCsvTask` 弹出 CSV 路径 + 参数对话框（解析 `target=OT horizon=24 context=96 preset=etth1 full|bridge`）
- `parseTsfCsvTaskInput` 把字符串解析为 `TsfResearchTaskDefaults`

**评分**：✅ 满足。两条入口（自由文本研究目标 + CSV 路径配置）均可用。

---

### 阶段 2 — Data 自动定性 + 定量分析 ⚠️ 浅层实现

**实现位置**：`opencode/packages/opencode/src/research/domains/tsf.ts:1062-1130`

`profileTSFDataset()` 读取 CSV 后产出 5 个标量指标：

```typescript
profile: {
  rowCount, targetCount, numericColumnCount,
  missingRate,
  trendStrength,        // 趋势强度
  seasonalityStrength,  // 季节性强度
  crossVarCorrelation,  // 多变量相关
  distributionShift,    // 训练/测试分布偏移
}
```

**已有的能力**：
- ✅ 缺失率检测
- ✅ 趋势 / 季节性强度估计
- ✅ 跨通道相关性
- ✅ 分布偏移检测
- ✅ TUI 在 fingerprint 中已展示（`research-cockpit-data.ts:486-515`）

**严重不足**：
- ❌ **无可视化** — 没有时序曲线、ACF/PACF、谱分析、缺失模式热图
- ❌ **无定性描述** — 只有 5 个数字，没有 "这个数据集呈现明显日周期 + 弱长期趋势 + 通道间高度相关" 这样的人类可读叙述
- ❌ **无异常检测** — outlier、structural break 不分析
- ❌ **不分析 horizon 适配性** — 给定 horizon=96/192/336/720 是否对该数据集合理，无判断

**评分**：⚠️ 算定量分析的最小集，但远未达到"自动定性 + 定量"的描述。

---

### 阶段 3 — 自主假设 ⚠️ 隐式存在但工作流不清晰

**实现位置**：
- `domains/tsf.ts:415` — `hypothesis: z.string().min(8).max(1200)` **强制要求**每个 candidate spec 携带一段假设文本
- `domains/tsf.ts:1228, 1237, 1246, 1275` — baseline 候选都有具体 hypothesis 句子，例如 "Patch embedding plus a small transformer should test whether attention improves the task"
- `llm-proposal.ts:340` — LLM 生成的 candidate 也通过 schema 校验 hypothesis 字段

**已有的能力**：
- ✅ 数据结构层强制要求"提出 candidate = 提出假设"
- ✅ baseline candidates 自带可读 hypothesis
- ✅ LLM proposal 的 prompt 引导其产出 hypothesis

**严重不足**：
- ❌ **没有独立的 "假设生成" 阶段** — Hypothesis 直接嵌在 recipe 提案里，没有 "基于 datasetProfile 先列 5 个假设 → 用户/Critic 选 → 再展开为 recipe" 的两阶段工作流
- ❌ **TUI 完全不显示 hypothesis** — `grep hypothesis` 在 cockpit/home/cockpit-data 全部 0 命中。用户看到的是 candidate ID + family + metric，看不到 "为什么选这个候选"
- ❌ **没有假设的"反驳/支持"判定** — run 完成后没有把 metric 回写为对原假设的 confirmation/rejection 评注

**评分**：⚠️ 数据结构上有，工作流和可见性双双缺失。

---

### 阶段 4 — 小模型设计规划 ✅ 完全实现

**实现位置**：
- `neo_cast/py/schemas/recipe_schema.json` — recipe schema v1
- `neo_cast/py/registry/action_specs.py` — semantic 跨字段约束（`d_model % n_heads == 0` 等）
- `neo_cast/py/renderer.py` — recipe JSON → 具体 PyTorch 配置
- `neo_cast/py/factory/build_model.py` — 配置 → 模型实例

**已有的模型族**（`neo_cast/py/models/`）：
- `nlinear` — 简单线性 baseline
- `tiny_transformer` — 小型注意力模型
- `patch_mlp` — patch embedding + MLP

**已有的设计自由度**：
- backbone：linear / dlinear / tcn / nbeats / timesnet / patch_mlp / tiny_transformer / ssm
- embedding：none / patch / multi_scale_patch / frequency
- preprocessing：none / instance_norm
- fusion：independent / shared channel mixing
- head + optimizer

**评分**：✅ 满足。设计空间清晰、可枚举、可组合，且双层校验保证生成的 recipe 可执行。

---

### 阶段 5 — 资源约束训练 ✅ 完全实现

**实现位置**：
- `neo_cast/py/prepare_tsf.py` 冻结常量：`INPUT_LEN=512, HORIZONS=[96,192,336,720], NUM_CHANNELS=7, SEED=42, TIME_BUDGET=600s`
- `neo_cast/py/train.py` — 600 秒 wall clock 训练上限
- `neo_cast/py/validate.py` — 60 秒 smoke 验证作为快速门
- `neo_cast/runner-manifest.json` — `smoke / run / ref_test / blind_test` 四阶段协议

**评分**：✅ 满足。TIME_BUDGET 严格、smoke 门有效、四阶段协议规范，与 Karpathy `autoresearch` 的 5 分钟思想一致。

---

### 阶段 6 — 自主迭代 ✅ 基本完整

**实现位置**：
- `neo_cast/py/search/mutate.py:321` — `mutate_recipe(recipe, metrics, index, state_path, policy)` 基于上一轮 metric 决定变异策略
- `neo_cast/py/runner.py:64,124,450,454` — `RunnerState.no_improve_streak` 跟踪连续未改善次数
- `opencode/packages/opencode/src/research/service.ts:115` — `AutonomousLoopStoppedReason = "max_iterations" | "budget_exhausted" | "approval_required"`
- `service.ts:2843` — autonomous loop 的循环驱动 + 终止处理

**已有的能力**：
- ✅ 基于 metric 反馈的 recipe 变异（不是随机搜索）
- ✅ no_improve_streak 用于切换 mutation policy
- ✅ Critic gate 机制（ref_test / blind_test 需要 approval）
- ✅ 三种终止原因覆盖正常路径

**评分**：✅ 满足。是整个系统设计最完整的部分。

---

### 阶段 7 — 收敛判定（"迭代出一个不错的小模型"）⚠️ 简陋

**当前停止条件**（`service.ts:115`）：
- `max_iterations` — 达到迭代次数上限
- `budget_exhausted` — 训练总时间预算耗尽
- `approval_required` — 等待人工审核

**严重不足**：
- ❌ **没有"足够好"的客观判定** — 例如：
  - val_avg_mse 低于某阈值
  - 与 baseline（DLinear / NLinear）的相对改进达到 X%
  - 连续 N 轮无改善触发 early stop
- ❌ **Champion 选择是被动的** — 当前 best 由 `is_best=1` 标记的最低 MSE 决定，但没有"我已经达到目标"的语义
- ❌ **不知道何时该停** — 用户必须在 Agent Loop 启动时手动设 `max_iterations`，否则一直跑到耗尽预算

**评分**：⚠️ 能停，但停得不智能。距离"不错的小模型"的意图还差一个收敛判定层。

---

### 阶段 8 — 整理输出

#### 8a 实验结果 ✅ 完整

**实现位置**：
- `.neo-cast/results.tsv` — 全量实验记录（commit, val_bpb, memory_gb, status, description, is_best, no_improve_streak）
- `.neo-cast/runner_state.json` — 当前 session 状态
- `.neo-cast/artifacts/run_<id>/` — 每个 run 的产物目录

**评分**：✅ 满足。

#### 8b 实验报告 ✅ 内容完整但浅

**实现位置**：`opencode/packages/opencode/src/research/domains/tsf.ts:2285-2396` `renderTSFArtifact("research_report_markdown")`

报告 sections：
- Task（id, domain, mode, status, objective, budget, taskSpec）
- Champion（candidate ID, run ID, primary metric, utility）
- TSF Recipe Summary（每个 candidate 的 pipeline 概要）
- Candidates（每个 candidate 的 ID, approval, risk, generated_by, rationale, full spec JSON）
- Runs（每个 run 的 stage / status / metric）
- Approvals
- Memory（lessons learned）

**已有的优势**：
- ✅ 字段全面，能复现一切元数据
- ✅ 通过 `exportTaskArtifact` API + cockpit "Export Report ^E" 入口可触发

**严重不足**：
- ❌ **无可视化** — 没有训练曲线图、metric 对比柱状图、Pareto 散点
- ❌ **不展示 datasetProfile** — `profileTSFDataset` 算的 5 个指标没进报告
- ❌ **不展示 hypothesis 验证情况** — 每个 candidate 的 hypothesis 没单独 section 对照其 metric 来给出 "假设成立 / 不成立" 的判定
- ❌ **不展示训练曲线** — `training_curves.json`（`runner.py:235`）已写盘但报告里不引用
- ❌ **不导出可独立阅读的 standalone HTML** — 只有 markdown

**评分**：✅ 信息齐全，⚠️ 但分析深度浅。

#### 8c 小模型代码 ❌ 未实现

**当前状态**：
- `neo_cast/py/train.py:476` 只把 `state_dicts` torch.save 到 `model.pt`
- `resolved_candidate.json` 保存了 recipe，但需要回到 `neo_cast/py/factory/build_model.py` 才能重建模型
- **没有产出"可独立运行"的推理脚本**

**用户得到的产物**：
```
artifacts/run_<id>/
  ├── model.pt              # 权重 + state_dict_layout
  ├── resolved_candidate.json  # recipe
  ├── preprocess.json       # 预处理参数
  ├── val_metrics.json
  └── training_summary.json
```

**用户得不到的产物**：
- ❌ 一个 `inference.py` 能 `python inference.py --input data.csv --output pred.csv` 跑起来
- ❌ 一个 `model.py` 把 PyTorch 模型类抽出来，不依赖 `neo_cast.py.factory` 整套代码
- ❌ requirements.txt / 推理依赖列表
- ❌ 模型卡片（model card）

**影响**：用户拿到 `model.pt` 后**离开 NeoResearch 项目就无法使用模型**，必须把整个 `neo_cast/py/` 抱走。这与"小模型作为产物交付"的初衷完全不符。

**评分**：❌ 未实现。是 Vibe Data Science 闭环最大的缺口。

#### 8d 训练好的参数 ✅ 完整

**实现位置**：`neo_cast/py/train.py:470-490`

```python
torch.save({
    "run_id": run_id,
    "candidate": candidate,
    "model_family": candidate["model_family"],
    "state_dict_layout": family_spec["state_dict_layout"],
    "state_dicts": {str(h): model.state_dict() for h, model in models.items()},
}, model_path)
```

**评分**：✅ 满足。每个 horizon 的 state_dict 都保存，含元数据。

---

## 三、整体闭环对齐度评分

| 阶段 | 状态 | 完成度 |
|------|------|--------|
| 1. 用户需求 | ✅ | 100% |
| 2. 数据分析 | ⚠️ 仅定量浅层 | 40% |
| 3. 自主假设 | ⚠️ 隐式 | 30% |
| 4. 模型设计 | ✅ | 100% |
| 5. 资源约束训练 | ✅ | 100% |
| 6. 自主迭代 | ✅ | 90% |
| 7. 收敛判定 | ⚠️ 仅迭代次数 | 30% |
| 8a. 实验结果 | ✅ | 100% |
| 8b. 实验报告 | ⚠️ 无可视化 / 不带训练曲线 / 不带假设验证 | 60% |
| 8c. 模型代码 | ❌ 未导出 | 0% |
| 8d. 训练参数 | ✅ | 100% |

**加权完成度（按工程量）**：约 **65%**

---

## 四、关键缺口（按对 Vibe DS 闭环的破坏性排序）

### 缺口 V1 (Critical) — 模型代码未独立导出

**问题**：用户跑完一次 NeoResearch session，拿到 `model.pt` 后无法脱离 `neo_cast/py/factory` 使用模型。Vibe Data Science 的承诺是"我帮你做完研究，给你一个能用的小模型"，目前是"我给你一些权重，模型怎么用你自己回到 neo_cast 项目去查"。

**修复方向**：
- 在 `train.py` 的 save 阶段加一步：根据 candidate 渲染出 standalone `inference.py`（包含模型类定义 + 加载逻辑 + preprocess 函数 + CLI 入口）
- 把模型类源码（PyTorch nn.Module 子类）通过 inspect 模块或模板生成嵌入到 `model.py`
- 同时打包 `requirements.txt`（torch + numpy 即可）
- artifact 目录变成 self-contained：`model.pt + model.py + inference.py + preprocess.py + requirements.txt + README.md`

**优先级**：P0。这是闭环成立的根本前提。

---

### 缺口 V2 (Critical) — 数据定性分析缺失

**问题**：当前只有 5 个标量指标，没有"这个数据集是什么样子"的人类可读描述，也没有任何可视化。Vibe DS 的"自动定性 + 定量"承诺只兑现了一半。

**修复方向**：
- 在 `profileTSFDataset` 之上加 `summarizeDatasetCharacteristics(profile)` 函数，把 5 个数字翻译成自然语言段落
- 引入 LLM call：把 profile 数据作为 system prompt，让 LLM 写一段定性描述（"这个数据集呈现明显的日周期，但跨通道相关性较低，建议..."）
- artifact 输出 `dataset_profile.md` 含图片：matplotlib 渲染时序曲线、ACF/PACF、pairplot
- 该 artifact 自动嵌入 `research_report_markdown`

**优先级**：P0。

---

### 缺口 V3 (Major) — 假设工作流不显式

**问题**：`hypothesis` 字段虽强制存在但 TUI 完全不展示，且没有"先生成假设再实验"的两阶段工作流。

**修复方向**：
- TUI cockpit 在 candidate 行展示 hypothesis 文本（截断 + 点击展开）
- run 完成后，在 candidate 详情中加 "Hypothesis verdict"：基于 metric 自动判定 confirmed / rejected / inconclusive
- 在 LLM proposal 阶段拆出独立的 `proposeHypotheses(profile, taskSpec) → string[]` 步骤，让 LLM 先列 N 个假设、用户/Critic 选择，再展开为 recipe

**优先级**：P1。

---

### 缺口 V4 (Major) — 收敛判定过于简陋

**问题**：当前只有 `max_iterations / budget_exhausted / approval_required` 三种终止，没有"模型已经足够好"的客观判定。"迭代出一个不错的小模型"在代码层无对应概念。

**修复方向**：
- 在 `task.objective` 中加可选 `targetMetric: number`（如 val_avg_mse < 0.45），autonomous loop 在 metric 达标时主动停止并发 toast "champion reached target"
- 加 `relativeImprovementOverBaseline: number`（如 vs DLinear 改进 ≥ 5%）
- 加 early stopping：连续 N 轮 no_improve 主动退出（已有 `no_improve_streak`，只缺触发逻辑）
- AutonomousLoopStoppedReason 加新枚举值：`target_reached / improvement_plateau`

**优先级**：P1。

---

### 缺口 V5 (Major) — 实验报告缺训练曲线和假设验证

**问题**：报告内容齐全但浅，缺少：
- 训练曲线图（数据已存，但报告不引用）
- 每个 candidate 的 hypothesis verdict
- datasetProfile section
- candidates 的 metric 对比图

**修复方向**：
- `renderTSFArtifact` 输出时同时生成 PNG/SVG（matplotlib via Python sidecar）并以 markdown image 引用
- 增加 `## Dataset Profile` section
- 每个 candidate section 加 `### Hypothesis Verdict` 子节
- 输出 `research-report.html`（markdown 转 + 嵌入图）

**优先级**：P1。

---

## 五、实现成本估算

| 缺口 | 工作量 | 涉及子系统 |
|------|--------|----------|
| V1 模型代码导出 | 3-5 天 | neo_cast/py（新增 export 模块）+ schema 升级 |
| V2 数据定性分析 | 3-4 天 | opencode + neo_cast Python sidecar 渲图 + LLM 调用 |
| V3 假设工作流 | 2-3 天 | TUI + service.ts + LLM proposal |
| V4 收敛判定 | 1-2 天 | service.ts + autonomous loop + schema |
| V5 报告增强 | 2-3 天 | tsf.ts renderTSFArtifact + Python sidecar |

**总估算**：~2-3 周可以从 65% 推到 90%+ 完成度。

---

## 六、最小验收 Demo（修复后）

跑一次完整 Vibe Data Science 闭环应该是这样：

1. `npx neo-research`，输入 "ETTh1 forecast 24h ahead，最快 30 分钟出结果"
2. 系统自动 profile 数据 → **展示**：日周期强（seasonality=0.78），趋势弱（0.12），通道高度相关（0.65）。**渲染时序曲线 + ACF**
3. LLM 提出 5 个假设：
   - H1: 日周期主导 → 简单 NLinear 应该已经够好（baseline）
   - H2: 通道相关高 → 共享 channel mixing 应有效
   - H3: 短依赖足够 → patch-MLP 优于 transformer
   - ...
4. 用户/Critic 通过 4 个假设 → 系统展开为 4 个 recipe
5. autonomous loop 启动，每轮跑完更新 hypothesis verdict
6. **当 val_avg_mse < 0.45 或连续 5 轮无改进** → 主动停止，宣布 champion
7. Export Report：
   - 含数据描述、假设列表 + 验证结论
   - 训练曲线、metric 对比图
   - 推荐模型的 source code（model.py + inference.py + requirements.txt）
8. 用户拿走 artifact 目录，**离开 NeoResearch 也能跑**：`pip install -r requirements.txt && python inference.py --input new_data.csv`

当前能做到 1、2（浅版本）、4、5、7（残缺版本）。

---

## 七、与已有代码 Review 文档的关系

| 文档 | 关注点 | 与本文档关系 |
|------|--------|------------|
| `代码Review结果.md` | 代码层 bug、Effect 错误处理 | 互补：bug 修了不影响 Vibe DS 闭环对齐度 |
| `tui_usability_gap_analysis_v2.md` | TUI 用户能否跑通流程 | 互补：TUI 修了能让用户体验流程，但产物缺口本文档独有 |
| 本文档 | 系统能否兑现 Vibe DS 八阶段承诺 | 高层愿景对齐 |

**下一阶段建议优先级**：

1. **P0 — V1 模型代码导出**（闭环根本）
2. **P0 — V2 数据定性分析**（aha moment 关键）
3. **P0 — TUI 主区列表渲染**（来自 v2 gap 分析）
4. **P1 — V3 假设工作流 + V4 收敛判定 + V5 报告增强**

完成上述后，NeoResearch 才真正具备 "Vibe Data Science 在 TSF 领域的可发布实例" 的资格。
