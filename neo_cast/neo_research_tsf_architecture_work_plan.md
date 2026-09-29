# NeoResearch TSF 架构对齐工作计划

生成日期：2026-04-28

## 对比对象

- 最新思考稿：`/Users/chengmingyue/Desktop/NeoResearch-TSF-v2.md`
- 当前架构稿：`/Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf/neo_cast/neo_research_tsf_architecture.md`

## 总体判断

当前 `neo_research_tsf_architecture.md` 与 `NeoResearch-TSF-v2.md` 的方向大体一致，已经覆盖了 Time-Series Profiler、模块化 Action Space、CandidateRecipe、实验闭环、研究记忆、约束执行和阶段路线图。

但当前架构文档更偏 **engineering execution architecture / autoresearch-style MVP**，而最新思考稿更强调 **Action-Space-Based Auto Model Construction for Time-Series Forecasting**。

因此当前文档的问题不是“方向错”，而是几个核心研究主张还没有被提升为一等模块：

1. 用户研究意图形式化不足。
2. action trajectory 没有成为核心数据结构。
3. Model Compiler 的角色不够突出。
4. hybrid / router / expert 等 meta-architecture 创新线不够清晰。
5. 最终 research artifact / report 还不是核心产物接口。

可以粗略判断：当前架构与最新思考约 **70% 一致**，剩余 30% 主要集中在“论文主张”和“研究贡献表达”层面。

---

## 1. 缺少 Requirement Formalizer / ResearchIntent 层

### 最新思考中的主张

最新思考稿的系统输入不是单纯数据集，而是完整 forecasting research task：

```yaml
dataset:
  path: ./data/electricity.csv
  target_cols: all

task:
  forecasting_type: multivariate
  lookback_length: 336
  horizon: 96
  metric:
    primary: MSE
    secondary: MAE

user_intent:
  objective: high accuracy with moderate latency
  preference:
    - lightweight model
    - interpretable variable interaction
    - robust long-horizon forecasting

constraints:
  max_experiments: 30
  max_params: 5M
  max_training_time_per_model: 30min
  max_latency: 20ms
```

总体流程中也明确包含：

```text
User Intent + Dataset
        ↓
Requirement Formalizer
        ↓
Time-Series Profiler
```

### 当前架构中的状态

当前架构从 `TaskSpec`、`EvalSpec`、`BudgetSpec`、`SearchSpaceSpec` 开始，强调协议、预算、切分和评测安全。这是工程上正确的，但没有把 `user_intent`、自然语言偏好、soft objectives 和 search priors 作为单独层来建模。

当前人类角色中有“设定研究目标与迭代方向”，但主要落在 `program.md`，还没有形成结构化的 `ResearchIntent`。

### 影响

如果没有 Requirement Formalizer，系统会更像一个“给定固定任务后的自动实验系统”，而不是能从用户研究偏好出发构建模型的 AutoResearch agent。

它会削弱以下卖点：

- 自然语言研究目标到可执行搜索目标的转化。
- hard constraints / soft objectives / search priors 的分离。
- 用户偏好对 action space 裁剪和 reward 权重的影响。

### 建议补充

在当前架构中新增一节：

```text
Research Intent Layer
```

建议数据结构：

```python
@dataclass
class ResearchIntent:
    raw_text: str
    objective: str
    hard_constraints: dict
    soft_preferences: list[str]
    search_priors: list[str]
    report_preferences: list[str]
```

并在 `TaskSpec` 中增加：

```python
research_intent: ResearchIntent
```

Requirement Formalizer 的输出应至少包括：

- `hard_constraints`：参数量、延迟、实验次数、训练时间、显存。
- `soft_objectives`：轻量、可解释、稳定、长 horizon 鲁棒。
- `search_priors`：patch、invert embedding、feature fusion、decomposition、router、distillation。
- `reward_weights`：accuracy、latency、params、robustness、simplicity 的权重。

---

## 2. Action Trajectory 没有成为一等数据结构

### 最新思考中的主张

最新思考明确强调：

```text
Architecture A = a_1 ∘ a_2 ∘ ... ∘ a_T
```

agent 的输出不是模型名，也不只是最终 recipe，而是一条 construction trajectory：

```text
AddPreprocess(RevIN)
AddPreprocess(SeriesDecomposition)
SetEmbedding(PatchEmbedding)
SetBackbone(MLP)
SetFusion(TemporalFusion)
AddBranch(InvertEmbedding + Transformer)
AddFusion(GatedFusion)
SetHead(LinearHead)
SetLoss(HorizonWeightedMSE)
```

这是 v2 的核心贡献之一：把 forecasting architecture design 形式化为 typed modular action space 上的 sequential architecture construction problem。

### 当前架构中的状态

当前架构已经有 `CandidateRecipe`，也有 action registry，但主要表达的是最终 recipe 状态：

```text
preprocessing -> embedding -> backbone -> fusion -> head -> training_strategy
```

它没有显式记录：

- 每一步 action 是什么。
- action 的 parent state 是什么。
- action 为什么被提出。
- action 是否通过 compiler / validator。
- action 对最终结构贡献了什么。

因此当前更像 “recipe search”，而不是 “action-space construction”。

### 影响

缺少 action trajectory 会影响三件事：

1. 论文贡献不够尖：难以强调 sequential architecture construction。
2. 反思闭环不够细：无法分析是哪一步 action 导致收益或失败。
3. report 不够强：不能输出完整 action trajectory 和结构演化过程。

### 建议补充

新增数据结构：

```python
@dataclass
class ArchitectureAction:
    action_id: str
    action_type: Literal[
        "add_module",
        "remove_module",
        "replace_module",
        "split_branch",
        "merge_branch",
        "change_fusion",
        "change_head",
        "change_loss",
        "change_training_protocol"
    ]
    target_path: str
    params: dict
    rationale: str
    expected_effect: str
    constraints_checked: list[str]

@dataclass
class ActionTrajectory:
    trajectory_id: str
    parent_recipe_id: str
    actions: list[ArchitectureAction]
    resulting_recipe_id: str
    hypothesis: str
```

并让 `Proposal` 从：

```python
candidate_recipe: CandidateRecipe
```

扩展为：

```python
action_trajectory: ActionTrajectory
candidate_recipe: CandidateRecipe
```

---

## 3. Model Compiler 的角色不够突出

### 最新思考中的主张

v2 把 Model Compiler 放在核心位置：

```text
Model Recipe DSL
        ↓
Model Compiler
        ↓
Training / Evaluation Engine
```

Compiler 不只是 `build_model`，还要负责：

```text
1. 检查 action sequence 是否合法
2. 检查 tensor shape 是否匹配
3. 自动调整 hidden dimension
4. 自动连接 branch input/output
5. 自动处理 normalization/post-processing 配对
6. 自动生成 PyTorch model
7. 自动生成 training script
8. 自动记录 architecture graph
```

### 当前架构中的状态

当前架构有：

- `Search Space Registry`
- `build_model(candidate_recipe)`
- `Static Validator`
- `Patch Generator`
- `ModelSpec`

这些模块已经接近 compiler 的组成部分，但没有把它们统一命名和组织成 **Executable Model Recipe Compiler**。

当前表达更像：

```text
recipe -> runtime 组装 PyTorch 模型
```

而不是：

```text
typed action sequence -> recipe graph -> shape-checked architecture graph -> executable model
```

### 影响

如果 compiler 不够突出，系统容易被理解为“带 registry 的 AutoML DSL”，而不是一个能把 agent actions 编译成合法 architecture 的研究系统。

这会削弱 v2 的 Contribution 3：

```text
Executable Model Recipe Compiler
```

### 建议补充

新增一节：

```text
Model Compiler Layer
```

建议接口：

```python
def compile_actions(
    task_spec: TaskSpec,
    base_recipe: CandidateRecipe,
    trajectory: ActionTrajectory,
) -> CompiledRecipeGraph:
    ...

def validate_recipe_graph(
    graph: CompiledRecipeGraph,
    registry: ActionRegistry,
    budget: BudgetSpec,
) -> ValidationResult:
    ...

def emit_model_spec(
    graph: CompiledRecipeGraph,
) -> ModelSpec:
    ...
```

建议数据结构：

```python
@dataclass
class CompiledRecipeGraph:
    graph_id: str
    nodes: list[dict]
    edges: list[dict]
    input_contract: dict
    output_contract: dict
    shape_trace: list[dict]
    estimated_params: int
    estimated_flops: float | None
    estimated_latency_ms: float | None
```

Compiler 应明确承担以下职责：

- action sequence legality check
- branch graph construction
- tensor shape propagation
- module compatibility validation
- preprocessing/postprocessing pairing
- architecture graph logging
- PyTorch model generation

---

## 4. Meta-Architecture / Hybrid Construction 主线不够突出

### 最新思考中的主张

v2 把 Level 6 Meta-Architecture Actions 视为与 TimeRecipe 拉开差距的地方：

```text
A6.1  SplitTrendSeasonalBranches
A6.2  AddResidualBranch
A6.3  AddDualEmbeddingBranches
A6.4  AddProfileConditionedRouter
A6.5  AddExpertForTrend
A6.6  AddExpertForSeasonality
A6.7  AddExpertForFeatureDependency
A6.8  AddMixtureOfExperts
A6.9  AddEnsembleHead
A6.10 PruneBranch
```

并且提出第三阶段个人创新点：

```text
Profile-Conditioned Forecasting Router
```

它让不同变量、窗口或时序模式路由到不同 expert：

```text
router(z) -> {
  trend_expert,
  seasonal_expert,
  feature_dependency_expert,
  frequency_expert,
  residual_expert
}
```

### 当前架构中的状态

当前架构中已有一些相关元素：

- `gated_hybrid`
- `temporal_then_feature`
- `feature_then_temporal`
- `residual_correction`
- 多尺度 branch 的研究方向提示

但这些目前是零散 action 或提示，没有形成清晰的阶段性创新主线。

当前路线图中的 Milestone 2 仍主要是 TimeRecipe 风格模块组合搜索；Milestone 6 才轻描淡写提到 template patch、distillation、多任务迁移。Profile-conditioned router 没有作为明确阶段目标出现。

### 影响

当前文档能说明“系统可以组合模块”，但还不够说明“系统能构建超出现有模型库和 TimeRecipe 固定组合的新结构”。

这会削弱 v2 的 Contribution 5：

```text
Hybrid Forecasting Architectures
```

### 建议补充

在 Search Space Layer 中新增：

```text
Meta-Architecture Action Space
```

初始 action：

```text
split_trend_seasonal_branches
add_residual_branch
add_dual_embedding_branches
add_gated_fusion
add_grouped_feature_fusion
add_profile_conditioned_router
add_expert_branch
prune_branch
```

新增阶段路线：

```text
Milestone 3: Hybrid Architecture Construction
```

目标：

- 支持 dual-branch architecture。
- 支持 trend / seasonal / dependency expert。
- 支持 gated fusion。
- 支持 branch pruning。

再新增：

```text
Milestone 4: Profile-Conditioned Forecasting Router
```

目标：

- 为变量或窗口计算 profile vector。
- 根据 profile router 选择 expert。
- 比较 fixed architecture vs profile-conditioned architecture。
- 验证 router 是否提升跨变量、跨 horizon、跨数据集鲁棒性。

---

## 5. Research Artifact / Report Generator 没有成为核心接口

### 最新思考中的主张

v2 明确输出不是模型名，而是完整 research artifact：

```text
1. 自动构建出的 best model recipe
2. 可运行的 PyTorch model code
3. 训练配置
4. 实验排行榜
5. 每轮 action trajectory
6. 每轮假设与失败分析
7. per-horizon / per-variable error analysis
8. 消融实验
9. 最终 research report
10. 下一步研究建议
```

### 当前架构中的状态

当前架构只在研究产物、Milestone 5 和 `AnalysisReport` 中提到报告。

当前 `AnalysisReport` 比较轻：

```python
@dataclass
class AnalysisReport:
    summary: str
    metric_breakdown: dict
    failure_analysis: dict
    next_suggestions: list[str]
```

它不足以承载完整 research artifact。

### 影响

如果报告只是最后的附属产物，系统会更像自动实验平台，而不是 AutoResearch。

AutoResearch 的研究价值需要通过报告体现：

- 为什么这样设计？
- 每轮 hypothesis 是什么？
- 哪些 action 有效？
- 哪些失败了？
- 结构如何演化？
- 是否做了消融？
- 与 baseline 和 oracle 差多少？
- 下一步研究方向是什么？

### 建议补充

新增：

```text
Research Artifact Layer
```

建议数据结构：

```python
@dataclass
class ResearchArtifact:
    task_id: str
    best_recipe: CandidateRecipe
    best_model_spec: ModelSpec
    action_trajectory: ActionTrajectory
    training_config: dict
    leaderboard: list[ExperimentRecord]
    hypothesis_log: list[dict]
    failure_analysis: list[dict]
    error_analysis: dict
    ablation_plan: list[dict]
    ablation_results: list[ExperimentRecord]
    baseline_comparison: dict
    oracle_comparison: dict | None
    next_research_suggestions: list[str]
```

同时扩展 Report Generator：

```python
def generate_research_artifact(
    task: TaskRecord,
    champion: ChampionRecord,
    trajectory: ActionTrajectory,
    experiments: list[ExperimentRecord],
    memories: list[MemoryItem],
    baselines: list[ExperimentRecord],
    oracle: ExperimentRecord | None,
) -> ResearchArtifact:
    ...
```

---

## 建议的文档改写优先级

### P0：必须补

1. `Research Intent Layer`
2. `ActionTrajectory`
3. `Model Compiler Layer`

这些决定当前文档是否真正对齐 v2 的核心主张。

### P1：强烈建议补

1. `Meta-Architecture Action Space`
2. `Profile-Conditioned Forecasting Router`
3. `ResearchArtifact / Report Generator`

这些决定方案是否具备论文贡献感。

### P2：后续扩展

1. 完整文献/benchmark prior library。
2. 训练 surrogate predictor。
3. 多数据集 profile-conditioned routing 验证。
4. 自动生成消融实验计划。

---

## 建议加入当前架构文档的新目录结构

可以把当前 `neo_research_tsf_architecture.md` 调整为：

```text
1. 系统定位与核心主张
2. Research Intent Layer
3. Time-Series Profiler Layer
4. Modular Action Space Layer
5. Architecture Action Trajectory
6. Model Recipe DSL
7. Executable Model Compiler Layer
8. Agent Orchestration Layer
9. Reflection-Based Research Loop
10. Evaluation / Reward / Promotion Protocol
11. Research Memory Layer
12. Research Artifact / Report Layer
13. Execution Governance Layer
14. MVP Implementation Plan
15. Milestones
16. Expected Contributions
```

这样会让文档从“工程架构说明”更接近 v2 的“研究方案 + 系统设计 + 论文贡献”。

---

## 一句话总结

当前 `neo_research_tsf_architecture.md` 已经具备可落地的工程闭环，但还需要把 **Requirement Formalizer、Action Trajectory、Executable Compiler、Hybrid/Router Construction、Research Artifact** 五个模块补上，才能完全对齐 `NeoResearch-TSF-v2.md` 中 “Action-Space-Based Auto Model Construction for Time-Series Forecasting” 的最新主张。
