下面给你构思一版可以作为 **项目方案 / 论文方案 / 开题材料** 使用的版本。我建议项目名暂定为：

# NeoResearch-TSF：面向时间序列预测的自主模型构建研究智能体

## 1. 核心定位

**NeoResearch-TSF** 不是一个普通的 AutoForecasting 系统，也不是在 DLinear、PatchTST、iTransformer、TimesNet 等已有模型中自动选择一个最优模型。它的核心目标是：给定时间序列数据、预测任务、用户研究偏好与实验预算，系统能够基于模块化 Action Space 自动构建新的时间序列预测模型，自动完成数据画像分析、结构假设生成、模型 recipe 设计、代码编译、训练评估、失败诊断、结构反思与迭代优化，最终输出一个可运行的 forecasting architecture 及完整实验报告。

这个方向可以概括为一句话：

> **NeoResearch-TSF aims to build, evaluate, and refine forecasting models automatically, rather than merely selecting models from a fixed model zoo.**

中文表达可以是：

> **NeoResearch-TSF 的目标不是自动选择已有预测模型，而是让智能体在一个可执行的模块化模型构建空间中，自主组合归一化、分解、嵌入、融合、骨干网络、预测头与训练策略，从而自动构建适配特定时间序列场景的新型预测模型。**

------

## 2. 研究背景与动机

当前时间序列预测领域已经形成了大量模型，包括统计模型、线性模型、MLP 模型、Transformer 模型、分解模型、频域模型和时间序列基础模型。问题在于，没有一个模型能够在所有数据集、所有预测长度、所有领域中稳定占优。不同数据具有不同的趋势性、季节性、平稳性、变量相关性和分布漂移特征，因此固定模型往往难以适配所有场景。

TIMERECIPE 这类工作已经说明，时间序列预测模型可以被拆解为若干模块，包括 **pre-processing、embedding、feed-forward modeling、projection 和 post-processing**，并且不同模块组合可以覆盖 PatchTST、iTransformer、DLinear、Autoformer、Informer 等已有模型。它进一步通过大规模实验发现，模块级设计空间的系统探索能够在很多场景下超过已有 SOTA 模型。

但是，TIMERECIPE 本质上更接近一个 **模块级 benchmark 与 toolkit**。它证明了模块组合空间很重要，但还没有进一步解决一个更 agentic 的问题：**智能体能否根据数据特征和实验反馈，自主决定下一步如何修改模型结构？** 这正是 NeoResearch-TSF 可以切入的核心位置。

因此，我们可以把研究问题定义为：

> 给定一个时间序列预测任务，是否可以构建一个自主研究智能体，使其在模块化 Action Space 中自动执行模型构建动作，并通过实验反馈持续改进模型结构，从而在固定实验预算下获得更优的预测性能、效率与鲁棒性？

------

## 3. 总体目标

NeoResearch-TSF 需要解决三个层次的问题。

第一，**从数据到研究假设**。系统需要自动分析时间序列数据的性质，包括趋势强度、季节性、平稳性、分布漂移、变量相关性、缺失值、异常值、horizon-lookback ratio 等，并将这些数据画像转化为模型构建假设。例如，如果数据具有强趋势和强季节性，系统可以优先考虑 series decomposition、patch embedding、frequency embedding 或双分支结构；如果多变量相关性很强，系统可以考虑 invert embedding、feature fusion 或变量关系建模模块。TIMERECIPE 也强调，模块有效性与 trend、seasonality、stationarity、shifting、transition、correlation、N-Feature 和 HL-Ratio 等数据属性相关。

第二，**从模型选择到模型构建**。系统不是简单选择一个现成模型，而是通过 action sequence 构建模型。例如，系统可以依次执行 `AddRevIN`、`AddSeriesDecomposition`、`AddPatchEmbedding`、`AddInvertEmbeddingBranch`、`AddTemporalMLP`、`AddFeatureTransformer`、`AddGatedFusion`、`SetDirectMultiHorizonHead` 等动作，最终形成一个新的 forecasting architecture。

第三，**从一次实验到自主研究闭环**。系统需要在每轮实验后进行诊断和反思，不只是记录 MSE / MAE，而是分析不同 horizon、不同变量、不同趋势/季节成分上的误差，并根据失败原因提出下一轮结构修改方案。例如，如果 patch branch 在短期预测上有效但长期趋势误差较大，系统可以增加 trend branch 或 horizon-weighted loss；如果 feature fusion 提升整体表现但部分变量误差增大，系统可以加入 grouped feature fusion 或 profile-conditioned router。

------

## 4. 系统总体框架

NeoResearch-TSF 可以设计为如下闭环：

```text
User Intent + Dataset
        ↓
Requirement Formalizer
        ↓
Time-Series Profiler
        ↓
Action Space Constructor
        ↓
Architecture Planner
        ↓
Model Recipe DSL
        ↓
Model Compiler
        ↓
Training & Evaluation Engine
        ↓
Result Analyzer
        ↓
Reflection Agent
        ↓
Next Architecture Action
        ↓
Best Constructed Model + Research Report
```

其中最关键的不是 LLM 本身，而是 **Action Space + Model Recipe DSL + Model Compiler + Reflection Loop**。LLM 负责提出研究假设、解释实验结果和规划下一步动作；真正保证系统可靠性的，是受约束的模型构建空间和可执行的编译器。

------

## 5. 输入与输出定义

系统输入可以包括四类信息。

第一类是数据与任务信息，例如数据路径、时间戳字段、目标变量、协变量、采样频率、lookback length、forecast horizon、预测类型以及评价指标。第二类是用户研究偏好，例如希望模型轻量、低延迟、可解释、适合长周期预测、适合能源场景或适合多变量交互建模。第三类是实验预算，例如最大实验次数、最大训练时间、最大参数量、最大延迟和可用 GPU 资源。第四类是外部知识，包括已有文献、历史实验结果、benchmark 统计规律和团队已有经验。

输出则不应该只是一个模型名，而应该是一个完整的 research artifact，包括最终模型 recipe、可运行代码、训练配置、实验轨迹、每轮结构修改原因、性能排行榜、失败实验分析、消融实验、最终实验报告和下一步研究建议。

一个理想输出不是：

```text
Best model: PatchTST
```

而应该是：

```text
Best constructed architecture:
RevIN + Series Decomposition
+ Seasonal Branch: Patch Embedding + Temporal MLP
+ Dependency Branch: Invert Embedding + Feature Transformer
+ Gated Fusion
+ Direct Multi-Horizon Prediction Head
```

这就体现了 **model construction**，而不是 **model selection**。

------

## 6. 核心模块一：Time-Series Profiler

Time-Series Profiler 是整个系统的感知模块。它负责将原始时间序列数据转化为结构化 data profile。这个 profile 会作为后续模型构建的 state。

可以包含以下属性：

```yaml
basic_profile:
  forecasting_type: multivariate
  num_variables: 321
  sequence_length: 26304
  frequency: hourly
  lookback: 336
  horizon: 96
  hl_ratio: 0.286

data_quality:
  missing_ratio: 0.01
  outlier_score: 0.13
  irregular_timestamp: false

temporal_properties:
  trend_strength: high
  seasonality_strength: high
  stationarity: low
  shifting: medium
  transition: medium
  autocorrelation: high

multivariate_properties:
  cross_correlation: high
  variable_redundancy: medium
  covariate_relevance: high
```

这些 profile 不是展示用的，而是直接参与 action prior 的生成。例如，强趋势可以激活 decomposition 和 trend branch；强季节性可以激活 patch / frequency embedding；强变量相关性可以激活 invert embedding、feature fusion 和 cross-variable attention；高分布漂移可以激活 RevIN、instance normalization 或 adaptive normalization。

------

## 7. 核心模块二：Modular Action Space

这是 NeoResearch-TSF 和普通 AutoML 的根本区别。普通 AutoML 的动作通常是“选择模型”和“调整超参数”，而 NeoResearch-TSF 的动作是“修改模型结构”。

可以将 Action Space 设计为七层。

**第一层是数据处理动作**，包括缺失值填补、异常值裁剪、时间特征构造、协变量编码、lookback 调整、rolling-origin validation 切分等。

**第二层是预处理动作**，包括 AddInstanceNorm、AddRevIN、AddSeriesDecomposition、ChangeDecompositionKernel、AddDifferencing、AddFrequencyTransform 等。TIMERECIPE 中也将 instance normalization 和 series decomposition 作为重要 pre-processing 组件进行评估。

**第三层是嵌入动作**，包括 SetEmbedding(None)、SetEmbedding(TokenEmbedding)、SetEmbedding(PatchEmbedding)、SetEmbedding(InvertEmbedding)、SetEmbedding(FrequencyEmbedding)、AddVariableIdentityEmbedding、AddTimeFeatureEmbedding、ChangePatchLength 和 ChangePatchStride。TIMERECIPE 中比较了 no embedding、token embedding、patch embedding、invert embedding 和 frequency embedding 等代表性嵌入策略。

**第四层是骨干网络动作**，包括 SetBackbone(MLP)、SetBackbone(RNN)、SetBackbone(Transformer)、SetBackbone(TCN)、SetBackbone(SSM)、ChangeDepth、ChangeHiddenDim、AddResidualConnection 和 AddDropout。MVP 阶段可以先只支持 MLP、RNN 和 Transformer，这样已经足以覆盖大量代表性组合。

**第五层是融合动作**，包括 SetFusion(TemporalFusion)、SetFusion(FeatureFusion)、AddGatedFusion、AddGroupedFeatureFusion、AddAttentionFusion、AddRouterFusion、AddChannelIndependentBranch 和 AddChannelMixingBranch。TIMERECIPE 区分 temporal fusion 和 feature fusion，但 NeoResearch-TSF 可以进一步扩展为双分支、多分支、门控融合和路由融合。

**第六层是预测头与损失函数动作**，包括 SetHead(DirectMultiHorizonHead)、SetHead(AutoregressiveHead)、SetHead(ResidualCorrectionHead)、SetHead(QuantileHead)、SetLoss(MSE)、SetLoss(MAE)、SetLoss(HorizonWeightedMSE)、SetLoss(VariableWeightedMSE) 和 AddAuxiliaryTrendLoss。

**第七层是元架构动作**，这是最能体现创新的部分，包括 SplitTrendSeasonalBranches、AddResidualBranch、AddDualEmbeddingBranches、AddProfileConditionedRouter、AddMixtureOfExperts、AddExpertForTrend、AddExpertForSeasonality、AddExpertForFeatureDependency 和 PruneBranch。

通过这些动作，系统能够生成超出现成模型库的新结构。例如：

```text
RevIN
+ Series Decomposition
+ Trend MLP Expert
+ Seasonal Patch MLP Expert
+ Feature Dependency Transformer Expert
+ Profile-Conditioned Router
+ Gated Fusion
+ Residual Multi-Horizon Head
```

这个模型不是简单的 PatchTST，也不是简单的 iTransformer，而是由 agent 基于数据特性和实验反馈构建出来的新型混合结构。

------

## 8. 核心模块三：Model Recipe DSL 与 Compiler

为了避免 LLM 直接生成不可控代码，NeoResearch-TSF 需要设计一个中间表示，也就是 **Model Recipe DSL**。LLM 不直接写 PyTorch 代码，而是输出结构化 recipe，再由 compiler 转化为可运行模型。

例如：

```yaml
model_id: NeoResearch_TSF_017

input:
  lookback: 336
  horizon: 96
  variables: 321

preprocess:
  - type: RevIN
  - type: SeriesDecomposition
    kernel_size: 25

branches:
  seasonal_branch:
    input: seasonal
    embedding:
      type: PatchEmbedding
      patch_len: 16
      stride: 8
      hidden_dim: 128
    backbone:
      type: MLP
      depth: 3
      hidden_dim: 256
      dropout: 0.1
    fusion:
      type: TemporalFusion

  dependency_branch:
    input: raw
    embedding:
      type: InvertEmbedding
      hidden_dim: 128
    backbone:
      type: Transformer
      depth: 2
      num_heads: 4
      dropout: 0.1
    fusion:
      type: FeatureFusion

fusion:
  type: GatedFusion
  inputs:
    - seasonal_branch
    - dependency_branch

head:
  type: DirectMultiHorizonHead
  horizon: 96

loss:
  type: HorizonWeightedMSE

postprocess:
  - type: DeNormalize
  - type: TrendSeasonalReconstruction
```

Compiler 需要负责检查 action sequence 是否合法、检查 tensor shape 是否匹配、自动调整 hidden dimension、自动连接分支输入输出、自动处理 normalization 与 denormalization 的配对、生成 PyTorch model、生成训练脚本，并记录 architecture graph。TIMERECIPE 本身也强调其框架可以自动调整 hidden dimensions、module connections 和 forward-pass tensor operations，这一点可以作为 NeoResearch-TSF compiler 设计的重要参考。

------

## 9. 核心模块四：Architecture Planner

Architecture Planner 是智能体的大脑。它的输入是 data profile、用户偏好、实验预算、当前 recipe、历史实验结果和文献/benchmark 先验；输出是下一轮模型构建动作。

为了保证可靠性，Planner 不应完全依赖 LLM。更稳妥的设计是：

```text
LLM Planner
+ Rule-based Prior
+ Surrogate Performance Predictor
+ Constraint Checker
+ Experiment Memory
```

其中，Rule-based Prior 可以来自 TIMERECIPE 类 benchmark 的经验规律。例如，多变量且相关性强时，可以提高 invert embedding、feature fusion 和 Transformer 的先验概率；趋势强时，可以提高 patch embedding、series decomposition 和 temporal fusion 的先验概率；shift 强时，可以提高 normalization 类模块的先验概率。TIMERECIPE 的结果也显示，不同模块在不同数据属性下具有不同有效性，例如 multivariate 场景下 invert embedding 更适合高特征数和高相关性设置，patch embedding 更适合强趋势设置，Transformer 更适合高相关性和高季节性设置。

Surrogate Performance Predictor 可以使用 LightGBM、XGBoost 或小型神经网络实现，输入是 `data_profile + architecture_recipe_encoding`，输出是该 recipe 的预测 rank、预测误差和不确定性。TIMERECIPE 已经使用过基于数据特征和模型配置的 training-free 选择机制，其思路是将 dataset characteristics 和 model configurations 映射到 rank scores。NeoResearch-TSF 可以将这一思路从“选择配置”扩展为“指导下一步动作”。

------

## 10. 核心模块五：Experiment-Reflection Loop

这是 NeoResearch-TSF 真正区别于 AutoML 的地方。

普通 AutoML 的逻辑是：

```text
跑模型 → 得到分数 → 继续搜索
```

NeoResearch-TSF 的逻辑应该是：

```text
构建模型 → 训练评估 → 误差诊断 → 失败归因 → 提出假设 → 修改结构 → 再训练
```

每轮实验后，系统不仅计算总体 MSE 和 MAE，还需要分析：

```text
per-horizon error
per-variable error
trend component error
seasonal component error
short-term vs long-term error
high-shift segment error
high-correlation variable group error
latency / params / FLOPs / memory
```

例如第一轮模型是：

```text
RevIN + PatchEmbedding + Temporal Transformer + DirectHead
```

实验结果显示：

```text
短 horizon 表现较好，但长 horizon 误差明显增大；趋势成分误差较高；模型延迟偏大。
```

Reflection Agent 应该生成如下诊断：

```text
Observation:
Patch embedding captures local temporal patterns, but long-horizon trend extrapolation remains weak.

Diagnosis:
The current architecture lacks an explicit trend modeling path. Transformer may also be too expensive under the latency constraint.

Next actions:
1. Add SeriesDecomposition.
2. Add a trend-specific MLP branch.
3. Replace the temporal Transformer with a lighter Temporal MLP.
4. Add GatedFusion to combine trend and seasonal branches.
```

于是第二轮模型变为：

```text
RevIN + SeriesDecomposition
+ Trend MLP Branch
+ Seasonal Patch MLP Branch
+ GatedFusion
+ DirectHead
```

这就形成了一个真正的自动研究闭环。

------

## 11. 形式化建模

可以将 NeoResearch-TSF 定义为一个序贯决策问题。

系统状态为：

```text
s_t = {
  data_profile,
  user_intent,
  constraints,
  current_recipe,
  experiment_history,
  module_prior,
  failure_diagnosis
}
```

系统动作为：

```text
a_t ∈ A(s_t)
```

其中动作可以是添加模块、删除模块、替换模块、分支拆分、分支合并、改变融合方式、改变预测头、改变损失函数或改变训练策略。

状态转移为：

```text
s_{t+1} = Execute(Compile(a_t, recipe_t), dataset)
```

奖励函数可以设计为：

```text
r_t =
  - validation_error
  - λ1 * model_size
  - λ2 * latency
  - λ3 * training_cost
  + λ4 * improvement_over_previous_round
  + λ5 * robustness_score
  - λ6 * invalid_architecture_penalty
```

其中 validation error 可以根据任务选择 MSE、MAE、SMAPE、MASE 或 OWA。对于 LTSF 和 PEMS 数据集可以使用 MSE / MAE，对于 M4 数据集可以使用 SMAPE / MASE / OWA，这与 TIMERECIPE 的评价设置也保持一致。

------

## 12. MVP 版本设计

第一版不建议做得过大。建议先做一个基于 TIMERECIPE-style action space 的 MVP。

MVP 的 action space 可以控制在：

```text
Pre-processing:
  IN: {on, off}
  SD: {on, off}

Embedding:
  {none, token, patch, invert, frequency}

Fusion:
  {temporal, feature}

Backbone:
  {MLP, RNN, Transformer}

Head:
  direct multi-horizon linear head
```

这样组合规模约为：

```text
2 × 2 × 5 × 2 × 3 = 120
```

这个空间已经能覆盖很多经典模型的结构变体，也可以产生不少不是现成模型的组合。TIMERECIPE 也说明，通过这些模块级组合可以覆盖超过 100 种模型结构，并且可以映射到 iTransformer、FITS、PatchTST、DLinear、Autoformer、Informer 等已有方法。

MVP 中可以设置固定预算，例如每个 dataset / horizon 最多 20 或 30 次实验，然后比较：

```text
Random Search over action space
Bayesian Optimization over action space
TIMERECIPE-style training-free selector
LLM-only planner without reflection
NeoResearch-TSF without data profile
NeoResearch-TSF full system
Exhaustive Search as oracle
```

核心问题是：在同样实验预算下，NeoResearch-TSF 是否能更快找到接近 exhaustive oracle 的结构？是否能比普通搜索方法得到更好的 accuracy-cost tradeoff？是否能通过反思机制稳定提升下一轮模型？

------

## 13. 第二阶段扩展：Hybrid Architecture Construction

MVP 完成后，可以进入第二阶段，加入真正的结构创新动作。重点不是再扩大超参数搜索，而是加入更具研究性的 model construction actions：

```text
AddDualBranch
SplitTrendSeasonalBranches
AddGatedFusion
AddGroupedFeatureFusion
AddResidualCorrectionHead
AddProfileConditionedRouter
AddExpertBranch
PruneIneffectiveBranch
```

这样系统就能够自动生成更复杂的混合结构。例如：

```text
RevIN
+ SeriesDecomposition
+ Trend Branch: Non-Embedding + MLP
+ Seasonal Branch: PatchEmbedding + Temporal MLP
+ Dependency Branch: InvertEmbedding + Feature Transformer
+ Profile-Conditioned Router
+ GatedFusion
+ ResidualCorrectionHead
```

这个阶段可以作为论文的主要创新点。因为它已经不只是 TIMERECIPE 固定组合空间内的搜索，而是 agent 在模块化设计空间上的结构扩展和自主构建。

------

## 14. 第三阶段扩展：Profile-conditioned forecasting router

我建议把 **Profile-Conditioned Forecasting Router** 作为 NeoResearch-TSF 的一个标志性创新。

时间序列预测中的一个核心问题是异质性。同一个数据集中，不同变量、不同窗口、不同时间段可能具有完全不同的动态模式。有的窗口趋势强，有的窗口季节性强，有的变量与其他变量高度相关，有的变量噪声更大，有的时间段存在明显分布漂移。因此，固定结构对所有样本一视同仁，可能不是最优策略。

可以为每个样本窗口构建 profile vector：

```text
z = [
  trend_strength,
  seasonality_strength,
  stationarity,
  shifting,
  autocorrelation,
  cross_correlation,
  missingness,
  horizon,
  frequency_embedding
]
```

Router 根据 profile 决定调用哪些 expert：

```text
router(z) → {
  trend_expert,
  seasonal_expert,
  feature_dependency_expert,
  frequency_expert,
  residual_expert
}
```

这样可以形成一个很强的核心观点：

> 不同时间序列模式应该由不同的预测模块处理，NeoResearch-TSF 不仅自动构建一个全局模型，还能构建 profile-conditioned hybrid architecture，使模型结构与数据模式动态匹配。

------

## 15. 实验设计

数据集可以分三类。

第一类是经典 LTSF benchmark，包括 ETTh1、ETTh2、ETTm1、ETTm2、Electricity、Weather、Exchange、ILI。第二类是交通预测数据集，包括 PEMS03、PEMS04、PEMS07、PEMS08。第三类是更真实或更大规模的数据集，例如 M4 / M5 子集、电力负荷预测、光伏发电预测或水文径流预测。TIMERECIPE 也在 LTSF、PEMS 和 M4 等数据集上进行了大规模评估，因此这些数据集有利于对齐和比较。

Baseline 可以包括四类。第一类是已有预测模型，如 DLinear、PatchTST、iTransformer、Autoformer、Informer、TimesNet、FITS、N-HiTS、TSMixer。第二类是搜索方法，如 random search、Bayesian optimization、evolutionary search 和 TIMERECIPE training-free selector。第三类是 Agent ablation，如 LLM-only planner、without profiler、without reflection、without compiler。第四类是 oracle，即在同一 action space 上的 exhaustive search，用于衡量系统与最优结构之间的差距。

评价指标不要只看预测误差，还应包括搜索效率和研究质量。预测指标包括 MSE、MAE、SMAPE、MASE、OWA。效率指标包括实验次数、GPU hours、训练时间、推理延迟、参数量、FLOPs 和显存。搜索质量指标包括 best metric under budget、time-to-best、improvement per round、distance to exhaustive oracle 和 valid architecture rate。研究质量可以通过 hypothesis validity、reflection usefulness、ablation meaningfulness 和 report quality 进行人工或半自动评价。

------

## 16. 预期贡献

这项工作可以形成五个贡献点。

第一，提出 **Action-Space-Based Forecasting Model Construction**。它将时间序列预测模型设计形式化为一个基于模块化动作空间的序贯结构构建问题，而不是传统的模型选择或超参数优化问题。

第二，提出 **Data-Profile-Guided Architecture Planning**。系统利用趋势、季节性、平稳性、漂移、变量相关性、horizon-lookback ratio 等数据画像信息，指导模型结构的初始设计和后续修改。

第三，提出 **Executable Model Recipe DSL and Compiler**。系统通过结构化 recipe 表示模型，并将智能体动作编译成合法可运行的 PyTorch forecasting architecture，从而避免 LLM 直接生成代码带来的不稳定性。

第四，提出 **Experiment-Reflection-Based Research Loop**。系统根据 per-horizon、per-variable、trend/seasonal component 等误差诊断结果，自动提出下一轮结构修改动作，形成实验—诊断—假设—改结构—再实验的闭环。

第五，探索 **Hybrid and Profile-Conditioned Forecasting Architecture**。系统可以自动构建 trend-seasonal dual branch、temporal-feature gated fusion、profile-conditioned router 等混合结构，为下一代自适应时间序列预测模型提供新的思路。

------

## 17. 可以写进 proposal 的摘要版本

可以这样写：

> 本项目拟研究面向时间序列预测的自主模型构建智能体 NeoResearch-TSF。不同于现有 AutoML 方法主要聚焦于模型选择、超参数搜索或自动特征工程，本项目将时间序列预测模型设计建模为一个基于模块化 Action Space 的序贯决策过程。系统首先对输入时间序列进行数据画像分析，提取趋势性、季节性、平稳性、分布漂移、变量相关性和预测跨度等关键属性；随后结合文献知识、benchmark 先验和历史实验记忆，自动生成模型结构假设，并通过可执行的 Model Recipe DSL 组合归一化、序列分解、嵌入方式、融合机制、骨干网络、预测头和训练策略等模块；最后，系统将模型 recipe 编译为可训练代码，完成训练评估，并基于多粒度误差诊断进行反思和结构修改。通过上述闭环，NeoResearch-TSF 不仅能够在固定实验预算下自动构建高性能预测模型，还能够输出完整的实验轨迹、失败分析、消融结果和研究报告，从而推动时间序列预测从模型选择式 AutoML 走向自主模型构建式 AutoResearch。

------

## 18. 最核心的卖点

这个方案最核心的卖点可以浓缩为三句话：

> **第一，NeoResearch-TSF 不是选择模型，而是构建模型。**
> **第二，它不是盲目搜索，而是基于数据画像、模块先验和实验反馈进行结构化动作规划。**
> **第三，它不是一次性 AutoML pipeline，而是一个能够持续提出假设、执行实验、诊断失败并修改结构的自主研究闭环。**

我建议后续就围绕这个定位展开：

> **From AutoForecasting to AutoResearch: autonomous construction of time-series forecasting architectures through executable action spaces.**