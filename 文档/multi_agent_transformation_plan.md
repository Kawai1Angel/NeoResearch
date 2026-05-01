# NeoResearch 多智能体改造计划

> 日期：2026-05-01
> 目标：将 NeoResearch 改造为四阶段多智能体架构，每个阶段有独立的智能体角色、职责边界、通信协议
> 基础：当前系统已有约 65% 的 Vibe DS 闭环实现（见 `vibe_data_science_alignment_review.md`）

---

## 一、整体架构设计

### 1.1 四智能体流水线

```
用户输入
  │
  ▼
┌─────────────────────────────┐
│  Agent-1: 意图理解           │  IntentAgent
│  理解研究目标，收集基本信息    │
└────────────┬────────────────┘
             │ TaskSpec + DatasetPath
             ▼
┌─────────────────────────────┐
│  Agent-2: 数据分析           │  DataAnalysisAgent
│  定性 + 定量分析数据集         │
└────────────┬────────────────┘
             │ DatasetProfile + AnalysisReport
             ▼
┌─────────────────────────────┐
│  Agent-3: 网络架构搜索        │  NASAgent
│  初始化架构 → 训练 → 迭代      │
└────────────┬────────────────┘
             │ ChampionModel + ExperimentLogs
             ▼
┌─────────────────────────────┐
│  Agent-4: 结果发布           │  PublishAgent
│  导出模型代码 + 参数 + 报告    │
└─────────────────────────────┘
```

### 1.2 智能体通信协议

各阶段智能体通过**共享的 Research Task 上下文**通信，不直接调用彼此：

```
┌──────────────────────────────────────────────────────┐
│                  Research Task (DB)                    │
│                                                        │
│  status: idle → profiling → searching → publishing    │
│  taskSpec.fingerprint      ← Agent-2 写入             │
│  candidates / runs         ← Agent-3 写入             │
│  artifacts (report,model)  ← Agent-4 写入             │
│                                                        │
│  Event Bus: Task/Run/Candidate/Artifact events        │
└──────────────────────────────────────────────────────┘
```

每个 Agent 订阅特定事件，当前一阶段的状态到达触发条件时自动启动：

| 阶段过渡 | 触发条件 |
|---------|---------|
| Agent-1 → Agent-2 | `task.status = "profiling"` |
| Agent-2 → Agent-3 | `fingerprint.datasetProfile != null && analysisReport 写入` |
| Agent-3 → Agent-4 | `task.status = "completed"` 或 champion metric 达标 |

---

## 二、Agent-1：意图理解 (IntentAgent)

### 2.1 职责

1. 接收用户自然语言描述的研究目标
2. 通过 LLM + 结构化对话，引导用户补全必要信息：
   - 数据集路径 / 类型（CSV / 远程 URL）
   - 预测目标列、预测 horizon
   - 资源约束（参数量上限、训练时间）
   - 优化指标（val_avg_mse / 自定义）
   - 模式（autonomous / review）
3. 验证信息完整性，生成正式 `ResearchTask`

### 2.2 当前实现状态

| 功能 | 现状 |
|-----|------|
| 自然语言输入框 | ✅ `home.tsx` textarea |
| CSV 参数对话 | ✅ `createCsvTask` + `parseTsfCsvTaskInput` |
| 意图→TaskSpec | ✅ `createTaskFromPrompt` |
| 信息不完整时追问 | ❌ 直接创建，缺失字段用默认值填充 |
| 约束确认对话 | ❌ 没有"你确认要用这些参数吗"的检查步骤 |

### 2.3 新增内容

#### 新文件：`src/research/agents/intent-agent.ts`

```typescript
// 核心职责
export interface IntentAgentInput {
  rawGoal: string           // 用户原始输入
  existingTaskSpec?: JsonRecord
}

export interface IntentAgentResult {
  taskSpec: TSFTaskSpec
  clarificationsMade: string[]  // 追问了哪些字段
  confidence: number            // 信息完整度 0-1
}

// 核心行为
// 1. 调用 LLM 解析 rawGoal → 候选 TSFTaskSpec（目标列、horizon、约束）
// 2. 对缺失字段生成追问问题
// 3. 用户回答后 re-parse 补全
// 4. confidence >= 0.8 时停止追问，提交 createTask
```

#### 修改：`service.ts`

- 新增 `runIntentAgent(input)` Effect，状态机：`idle → intent_gathering → profiling`
- 当 `task.status = "idle"` 且有 `rawGoal` 时自动触发

#### 修改：`home.tsx` / `research-cockpit.tsx`

- Home 页输入后不直接 createTask，而是先进入 Intent 对话流
- Cockpit 底部 textarea 在 `idle` 状态时显示追问问题

#### 修改：`schema.ts`

```typescript
// 新增 task status
export const ResearchTaskStatus = Schema.Literals([
  "idle",           // 新增：待意图确认
  "intent_gathering",  // 新增：Agent-1 正在追问
  "profiling",
  "analyzing",      // 新增：Agent-2 正在分析
  "baselining",
  "searching",      // 新增：Agent-3 NAS 中（替代 researching）
  "publishing",     // 新增：Agent-4 正在导出
  "completed",
  "paused",
  "failed",
])
```

---

## 三、Agent-2：数据分析 (DataAnalysisAgent)

### 3.1 职责

1. 读取 CSV 数据，计算统计特征（定量分析）
2. 调用 LLM 把统计特征翻译为人类可读的定性分析
3. 生成 `dataset_analysis_report.md` artifact
4. 向 Agent-3 传递数据驱动的模型偏好建议（searchBiases）

### 3.2 当前实现状态

| 功能 | 现状 |
|-----|------|
| 5 个定量指标 | ✅ `profileTSFDataset`（trend/seasonality/missing/crossCorr/distShift）|
| 定性描述 | ❌ 只有 5 个数字，无 LLM 解读 |
| 可视化 | ❌ 无图表 |
| 分析报告 artifact | ❌ 没有独立的数据分析报告，只有统计数字进 fingerprint |
| 季节性去趋势（已知 bug V-B1）| ❌ |

### 3.3 新增内容

#### 新文件：`src/research/agents/data-analysis-agent.ts`

```typescript
export interface DataAnalysisAgentInput {
  taskID: ResearchTaskID
  taskSpec: TSFTaskSpec
}

export interface DataAnalysisAgentResult {
  profile: DatasetProfile           // 定量特征（扩展后的版本）
  qualitativeSummary: string        // LLM 生成的定性描述
  searchBiases: DatasetSearchBias[] // 传给 Agent-3 的偏好
  warnings: DatasetProfileWarning[]
  artifactID: ResearchArtifactID    // dataset_analysis_report
}

// 核心步骤
// Step 1: profileTSFDataset（修复 V-B1 去趋势问题）
// Step 2: 扩展分析（ACF 检测主导周期、跨列 Granger 相关）
// Step 3: LLM call：把 profile 结构化输入，让 LLM 写 2-3 段定性描述
// Step 4: 从定性描述提炼 searchBiases（如 "高季节性 → 推荐 patch embedding"）
// Step 5: 生成 dataset_analysis_report.md，写入 ResearchArtifact
```

#### 新文件：`neo_cast/py/analysis/dataset_analysis.py`（Python 侧扩展）

```python
# 扩展当前 profileTSFDataset 的能力
def extended_profile(df: pd.DataFrame, target_cols: list[str]) -> dict:
    # 1. 基础统计（已有）
    # 2. 去趋势后的季节性检测（修复 V-B1）
    # 3. ACF 主导周期（前 3 个峰值的 lag）
    # 4. 对每个目标列的 ADF 平稳性检验
    # 5. 跨列 Pearson 矩阵（不只是均值，保留矩阵）
    # 6. 生成 matplotlib 时序图 + ACF 图，保存为 PNG
```

#### 修改：`tsf.ts` `renderTSFArtifact`

- 新增 `"dataset_analysis_report"` artifact kind
- 报告包含：
  - 定量 profile 表格
  - 定性描述段落
  - 嵌入时序图和 ACF 图（base64 或外部 PNG 路径引用）
  - searchBiases 列表

#### 修改：`schema.ts`

```typescript
// 新增 artifact kind
export const ExportArtifactKind = Schema.Literals([
  "dataset_analysis_report",  // 新增
  "research_report_markdown",
  "model_export_package",     // 新增（Agent-4 用）
])
```

---

## 四、Agent-3：网络架构搜索 (NASAgent)

### 4.1 职责

1. 接收 `DatasetProfile` + `qualitativeSummary` + `searchBiases`
2. 基于数据特性初始化初始候选架构集（不再是固定 3 个 baseline）
3. 通过 LLM 生成带 hypothesis 的 recipe candidate
4. 运行 smoke → run 训练循环
5. 基于结果自主 mutate recipe，迭代直到 champion 达标
6. 维护 experiment memory（哪些改动有效/无效）

### 4.2 当前实现状态

| 功能 | 现状 |
|-----|------|
| 初始候选（baseline seeds）| ✅ `buildTSFBaselines` 3 个固定候选 |
| LLM 提案 + hypothesis | ✅ `proposeTSFCandidate` + schema 强制 hypothesis |
| 4 horizon 同时训练 | ✅ `train.py` |
| 基于 metric mutate | ✅ `mutate.py` + `no_improve_streak` |
| 数据驱动初始化 | ❌ baseline 是固定的，不看 datasetProfile |
| NAS 搜索空间缩减 | ❌ searchBiases 在 tsf.ts 里有但不驱动实际 baseline 选择 |
| Hypothesis 展示 | ❌ TUI 不显示 |
| target / plateau 停止 | ✅ 已实现（service.ts:3054-3057） |

### 4.3 新增内容

#### 新文件：`src/research/agents/nas-agent.ts`

```typescript
export interface NASAgentInput {
  taskID: ResearchTaskID
  datasetProfile: DatasetProfile
  qualitativeSummary: string
  searchBiases: DatasetSearchBias[]
  budget: ResearchBudget
}

export interface NASAgentIteration {
  iterationIndex: number
  candidateID: ResearchCandidateID
  hypothesis: string
  runID: ResearchRunID
  metric: number
  improvementVsBaseline: number
  mutationRationale: string  // 为什么做这个 mutation
}

export interface NASAgentResult {
  champion: ResearchCockpitChampion
  iterations: NASAgentIteration[]
  convergenceReason: "target_reached" | "plateau" | "max_iterations" | "time_budget"
  totalTrainingSeconds: number
}
```

#### 修改：`domains/tsf.ts` `buildTSFBaselines`

将 baseline 初始化由固定 3 个改为**数据驱动**：

```typescript
// 当前：固定 3 个
// nlinear + patch_mlp + tiny_transformer

// 改造后：根据 datasetProfile 动态选择
function buildDataDrivenBaselines(profile: DatasetProfile): TSFRecipeCandidate[] {
  const baselines: TSFRecipeCandidate[] = []
  // 必选：linear baseline（所有情况都要）
  baselines.push(nlinearBaseline())
  // 季节性强（> 0.6）→ 加 patch 系
  if (profile.seasonalityStrength > 0.6) baselines.push(patchMLPBaseline())
  // 跨通道相关高（> 0.5）→ 加 shared channel mixing
  if (profile.crossVarCorrelation > 0.5) baselines.push(channelMixingBaseline())
  // 数据量大（rowCount > 5000）→ 加 transformer
  if (profile.rowCount > 5000) baselines.push(tinyTransformerBaseline())
  // 分布偏移明显 → 加 instance norm
  if (profile.distributionShift > 0.3) baselines.push(instanceNormBaseline())
  return baselines
}
```

#### 修改：`mutate.py`

- 把 `DatasetProfile` 传入 mutate，让 mutation policy 根据数据特性调整搜索方向
- 高季节性数据：优先搜索 patch_size 和 n_patches
- 高多变量相关：优先搜索 channel_mode 在 shared/independent 间切换

#### 修改：TUI cockpit

- 主区显示 `NASAgent` 实时状态：
  - 当前 iteration index / total budget
  - 最新 hypothesis + mutation rationale
  - metric trend（简单文本进度条）
  - champion 历史最优

---

## 五、Agent-4：结果发布 (PublishAgent)

### 5.1 职责

1. 从 champion run 提取模型权重
2. 生成 **standalone 可运行** 的推理代码（`model.py` + `inference.py`）
3. 生成完整实验报告（含数据分析、假设验证、训练曲线）
4. 打包所有产物为标准 `model_export_package`

### 5.2 当前实现状态

| 功能 | 现状 |
|-----|------|
| 模型权重 `model.pt` | ✅ `train.py:476` torch.save |
| 实验报告 markdown | ✅ `renderTSFArtifact` 但缺可视化 |
| standalone `inference.py` | ❌ 未实现（最大缺口） |
| standalone `model.py` | ❌ 未实现 |
| 训练曲线嵌入报告 | ❌ 未实现 |
| 数据分析结果嵌入报告 | ❌ 未实现 |
| 假设验证结论 | ❌ 未实现 |

### 5.3 新增内容

#### 新文件：`neo_cast/py/export/model_exporter.py`

```python
"""
从 resolved_candidate.json + model.pt 生成 standalone 推理包。
不依赖 neo_cast.py.factory，只依赖 torch + numpy。
"""

class ModelExporter:
    def __init__(self, artifact_dir: Path):
        self.artifact_dir = artifact_dir
        self.candidate = json.loads((artifact_dir / "resolved_candidate.json").read_text())
        self.checkpoint = torch.load(artifact_dir / "model.pt", map_location="cpu")

    def export_standalone_package(self, output_dir: Path):
        """生成 self-contained 推理包"""
        # 1. 根据 model_family + model_config 渲染 model.py（PyTorch nn.Module 纯定义）
        model_code = self._render_model_code()
        (output_dir / "model.py").write_text(model_code)

        # 2. 生成 inference.py（CLI 入口：input CSV → output CSV）
        inference_code = self._render_inference_code()
        (output_dir / "inference.py").write_text(inference_code)

        # 3. 生成 preprocess.py（与训练时一致的归一化逻辑）
        preprocess_code = self._render_preprocess_code()
        (output_dir / "preprocess.py").write_text(preprocess_code)

        # 4. 复制 model.pt
        shutil.copy2(self.artifact_dir / "model.pt", output_dir / "model.pt")

        # 5. 生成 requirements.txt（最小依赖）
        (output_dir / "requirements.txt").write_text("torch>=2.0\nnumpy>=1.24\npandas>=2.0\n")

        # 6. 生成 README.md（使用说明）
        readme = self._render_readme()
        (output_dir / "README.md").write_text(readme)

    def _render_model_code(self) -> str:
        """根据 model_family 渲染对应的 nn.Module 代码（模板化）"""
        # 使用 Jinja2 模板：templates/nlinear.py.jinja2 等
        ...
```

#### 新目录：`neo_cast/py/export/templates/`

每个 model family 对应一个 Jinja2 模板：
- `nlinear.py.jinja2`
- `patch_mlp.py.jinja2`
- `tiny_transformer.py.jinja2`

模板接收 `model_config` 字段，直接内联参数，生成零依赖的 PyTorch 模型定义。

#### 新文件：`src/research/agents/publish-agent.ts`

```typescript
export interface PublishAgentInput {
  taskID: ResearchTaskID
  championRunID: ResearchRunID
}

export interface PublishAgentResult {
  reportArtifactID: ResearchArtifactID      // research_report_markdown（增强版）
  modelPackageArtifactID: ResearchArtifactID // model_export_package（新增）
  exportPath: string                         // 本地文件路径
}

// 步骤
// 1. 读 champion run 的 artifact_dir
// 2. 调用 neo_cast/py/export/model_exporter.py 生成 standalone package
// 3. 增强 research_report_markdown：
//    - 嵌入 dataset_analysis_report 内容
//    - 为每个 candidate 加 Hypothesis Verdict（confirmed/rejected/inconclusive）
//    - 嵌入 training_curves（ASCII 折线图或 base64 PNG）
//    - 加 champion 的 val metric vs baselines 对比表
// 4. 写入 model_export_package artifact
```

#### 修改：`tsf.ts` `renderTSFArtifact`

扩展报告结构：

```markdown
# {task.title}

## 研究摘要
- 用时 / 迭代次数 / 最终 champion metric / vs baseline 提升

## 数据集分析
{从 dataset_analysis_report artifact 提取}
- 定量 profile 表格
- 定性描述段落

## 假设与验证
| 候选 | Hypothesis | val_avg_mse | 判定 |
|-----|-----------|-------------|-----|
| H1  | "..." | 0.432 | ✅ 已确认 |
| H2  | "..." | 0.521 | ❌ 被证伪 |

## 架构搜索历史
- 训练曲线（champion 的 val_loss by epoch by horizon）
- Metric 演化（每次迭代的 val_avg_mse）

## Champion 模型
- 架构描述 / 参数量 / 推理耗时（CPU/GPU）
- 使用说明（export package 路径 + 命令）

## 所有候选对比
...
```

---

## 六、Agent 协调：状态机与事件流

### 6.1 任务状态机（新版）

```
idle
  │ Agent-1 启动
  ▼
intent_gathering
  │ 信息完整，createTask 成功
  ▼
profiling
  │ Agent-2 开始数据分析
  ▼
analyzing         ← 新增
  │ dataset_analysis_report 写入
  ▼
baselining
  │ Agent-3 建立 baseline candidates
  ▼
searching         ← 替代 researching
  │ champion 达标 或 budget 耗尽
  ▼
publishing        ← 新增
  │ model_export_package 和增强报告写入
  ▼
completed
```

### 6.2 智能体间消息格式

在 `Event Bus` 中新增以下事件：

```typescript
// src/research/schema.ts 中新增
export const ResearchEvent = {
  // 已有
  TaskCreated, TaskStatusUpdated, RunUpdated, ...

  // 新增
  IntentGatheringStarted: Schema.Struct({ taskID, question: Schema.String }),
  IntentGatheringCompleted: Schema.Struct({ taskID, clarificationsMade: Schema.Array(Schema.String) }),
  DataAnalysisStarted: Schema.Struct({ taskID }),
  DataAnalysisCompleted: Schema.Struct({ taskID, profileSummary: Schema.String, searchBiasCount: Schema.Number }),
  NASAgentStarted: Schema.Struct({ taskID, initialCandidateCount: Schema.Number }),
  NASIterationCompleted: Schema.Struct({ taskID, iterationIndex: Schema.Number, metric: Schema.Number, hypothesis: Schema.String }),
  PublishAgentStarted: Schema.Struct({ taskID, championRunID }),
  PublishAgentCompleted: Schema.Struct({ taskID, exportPath: Schema.String }),
}
```

### 6.3 Agent 触发规则（新增 service 方法）

```typescript
// service.ts 新增
const runFullPipeline = Effect.fn("Research.runFullPipeline")(function* (taskID) {
  // Agent-1 已在 createTaskFromPrompt 中完成
  // Agent-2
  yield* runDataAnalysisAgent({ taskID })
  // Agent-3（已有 autonomous loop，接入）
  yield* runAutonomousLoop({ taskID, maxIterations: 12, maxNoImprove: 4 })
  // Agent-4
  const champion = yield* getChampion(taskID)
  if (champion) yield* runPublishAgent({ taskID, championRunID: champion.runID })
})
```

---

## 七、改造工作量估算

### 7.1 按智能体划分

| Agent | 新增/修改文件 | 工作量 | 依赖 |
|-------|-------------|--------|------|
| Agent-1 (Intent) | `intent-agent.ts`、`home.tsx`、`cockpit.tsx`、`schema.ts` | 3-4 天 | LLM prompt 设计 |
| Agent-2 (Data) | `data-analysis-agent.ts`、`dataset_analysis.py`、`tsf.ts` | 4-5 天 | Python matplotlib、LLM 调用 |
| Agent-3 (NAS) | `nas-agent.ts`、`tsf.ts 数据驱动 baseline`、`mutate.py` | 2-3 天（大部分已有）| Agent-2 输出 |
| Agent-4 (Publish) | `publish-agent.ts`、`model_exporter.py`、Jinja2 模板 | 4-5 天 | 模板工程量 |
| 协调层 | `schema.ts`、`service.ts`、事件定义 | 2 天 | 全部 |

**总计：~15-18 天**

### 7.2 可复用现有实现

| 现有模块 | 复用比例 | 说明 |
|---------|---------|------|
| `runner.py` + `train.py` | 95% | 只加 timeout reason 修复（V-B5） |
| `mutate.py` | 80% | 加 datasetProfile 参数 |
| `service.ts` autonomous loop | 85% | 加 Agent-3 包装层 |
| `tsf.ts` recipe 定义 | 90% | 加数据驱动 baseline 选择 |
| `research_report_markdown` | 60% | 扩展报告 sections |
| TUI cockpit 状态机 | 70% | 加新 status 渲染 |

---

## 八、分阶段交付计划

### Milestone 1 — Bug 修复基座（1 周）

参照 `vibe_data_science_bug_review.md` P0/P1 修复：
- V-B1 seasonality 去趋势
- V-B2 maxIterations 默认值
- V-B3 smoke param budget
- V-B4/B5 timeout 处理
- 代码 Review P0：`metricDominates`、`session.js getBestSessionRow`

### Milestone 2 — Agent-2 数据分析（1.5 周）

- 扩展 `profileTSFDataset`（修 V-B1、加 ACF、加 ADF 检验）
- Python sidecar 生成时序图 + ACF 图
- LLM 调用生成定性描述
- `dataset_analysis_report` artifact
- TUI 展示 profile 摘要（cockpit 主区）

### Milestone 3 — Agent-3 NAS 强化（1 周）

- 数据驱动 baseline 初始化
- `mutate.py` 接入 datasetProfile
- NAS 迭代状态在 TUI 主区实时显示（假设文本 + metric 趋势）
- 修 TUI B1/B4/B6（主区候选列表、运行历史）

### Milestone 4 — Agent-4 结果发布（1.5 周）

- `model_exporter.py` + 三个 family 的 Jinja2 模板
- `inference.py` CLI（`python inference.py --input data.csv --horizon 96`）
- 增强 `research_report_markdown`（嵌入数据分析、假设验证、训练曲线）
- TUI "Export ^E" 后展示导出路径 + 使用说明

### Milestone 5 — Agent-1 意图收集（1 周）

- `intent-agent.ts`：LLM 解析 rawGoal，追问缺失字段
- cockpit 在 `intent_gathering` 状态展示追问对话
- 信息完整度检查（confidence >= 0.8 自动推进）

### Milestone 6 — 端到端集成 + 全流水线测试（1 周）

- `runFullPipeline` 串联四个 Agent
- 用 ETTh1 做端到端回归测试
- TUI 展示四阶段进度条（Agent-1 ✅ → Agent-2 ✅ → Agent-3 ⏳ → Agent-4 ○）

---

## 九、与现有文档的关系

| 文档 | 关系 |
|------|------|
| `vibe_data_science_bug_review.md` | Milestone 1 的修复任务来源 |
| `vibe_data_science_alignment_review.md` | 各 Agent 补全的功能缺口来源 |
| `tui_usability_gap_analysis_v2.md` | Milestone 3 TUI 改进的任务列表 |
| `代码Review结果.md` | Milestone 1 的补充修复任务 |

---

## 十、最终用户体验（改造完成后）

```
$ npx neo-research

> 欢迎使用 NeoResearch。请描述你的预测研究目标：
  "帮我预测 ETTh1 数据集未来 24 小时的 OT 温度"

[Agent-1 IntentAgent]
  ✓ 识别到：时序预测任务，目标列 = OT，horizon = 24h
  ? 请提供 CSV 文件路径：/data/ETTh1.csv
  ? 参数量上限（MB，默认 2.0）：1.0
  ✓ 任务信息完整，创建研究任务

[Agent-2 DataAnalysisAgent]
  ✓ 读取 17420 行 × 7 列
  ✓ trendStrength=0.12, seasonalityStrength=0.78（去趋势后）, crossCorr=0.65
  ✓ 定性分析：该数据集呈现明显的 24h 日周期，跨通道相关性较强，建议优先探索
    patch embedding + channel mixing 方案...
  ✓ 已生成 dataset_analysis_report.md

[Agent-3 NASAgent]
  ✓ 数据驱动初始化：选择 4 个初始候选（linear / patch_mlp / channel_mixing / patch_transformer）
  ● 迭代 1/12 [nlinear]  hypothesis: "linear baseline"  MSE=0.521
  ● 迭代 2/12 [patch_mlp] hypothesis: "patch embedding captures 24h motif"  MSE=0.468 ↑
  ● 迭代 3/12 [patch_mlp+shared] hypothesis: "shared mixing improves correlated channels"  MSE=0.443 ↑
  ● 迭代 4/12 [patch_mlp+shared+instNorm] ...  MSE=0.439 ↑
  ✓ 连续 3 轮改进 < 1% → plateau 停止。Champion: patch_mlp+shared MSE=0.443

[Agent-4 PublishAgent]
  ✓ 生成 inference.py（standalone，仅依赖 torch + pandas）
  ✓ 生成完整实验报告（含数据分析、假设验证、训练曲线）
  ✓ 导出路径：./neo-research-export/ETTh1_forecast_2026-05-01/

$ python ./neo-research-export/ETTh1_forecast_2026-05-01/inference.py \
    --input new_data.csv --horizon 24 --output predictions.csv
  ✓ 预测完成，已写入 predictions.csv
```
