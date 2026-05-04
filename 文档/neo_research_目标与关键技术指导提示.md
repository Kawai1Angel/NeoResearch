# NeoResearch 目标与关键技术指导提示

## 1. 项目目标与定位

NeoResearch 定位为面向数据科学的自主科研智能体系统（Autonomous Research Agent for Data Science）。它的核心目标不是简单地调用已有模型，也不是只完成一次性的数据分析任务，而是构建一个能够理解用户科研意图、分析数据特征、自动探索模型结构、执行实验迭代、沉淀过程经验并生成可复现研究结果的智能体系统。

在当前阶段，NeoResearch 将首先在 Time Series Forecasting 领域进行实例化。时间序列预测任务具有明确的数据输入、预测目标、评估指标和实验闭环，因此适合作为 Autonomous Research Agent 的验证场景。系统应围绕“让时序预测小模型创造更简单”这一目标，帮助用户从需求描述出发，逐步完成数据理解、建模假设生成、模型结构搜索、训练调优、结果评估和实验报告整理。

NeoResearch 的长期定位可以概括为：面向时间序列预测的数据科学模型工厂（Model Factory for Time Series Forecasting）。它应当支持用户以自然语言提出任务需求，并通过多智能体协作、工具调用、实验执行和反思迭代，自动构建满足约束条件的预测模型。系统最终输出的不只是一个预测结果，而是一套可解释、可复现、可交付的研究产物，包括模型代码、模型参数、训练日志、实验结果、搜索过程记录和总结报告。

### 1.1 核心 Claim 与系统边界

NeoResearch 的核心 Claim 可以表述为：NeoResearch transforms time series forecasting model development from manual trial-and-error into a harnessed agentic research workflow, where agents can understand user intent, diagnose data, design model recipes, run controlled experiments, verify outcomes, reflect on failures, and deliver reproducible forecasting artifacts.

这一 Claim 的重点不在于 NeoResearch 使用了某个大模型，也不在于它简单封装了若干时间序列模型，而在于它将时间序列预测的小模型研发过程转化为一个可交互、可执行、可验证、可复现、可积累经验的 Agentic Research Workflow。

因此，NeoResearch 需要明确自身与已有系统的边界。它不同于传统 AutoML。AutoML 通常关注模型选择、超参数搜索和自动化训练，而 NeoResearch 更关注完整科研流程，包括用户意图澄清、数据诊断、模型假设生成、实验执行、结果验证、反思迭代和报告交付。它也不同于一般 AutoTS 系统。AutoTS 更偏向自动寻找时间序列模型，而 NeoResearch 更强调 Agent 在科研流程中的自主规划、工具调用、经验沉淀和产物交付。它也不只是普通 LLM Agent。普通 LLM Agent 往往容易停留在自然语言规划和工具调用层面，而 NeoResearch 需要在 Harness Environment 中完成受控执行、科学验证和可复现实验。

从系统边界看，NeoResearch 的第一阶段不追求完全自动发现颠覆性新模型，而是优先完成一个可信的小模型自动研发闭环。它需要能够基于用户需求和数据特征，自动生成合理模型配方，运行受控实验，验证实验结果，并输出可复现的研究产物。随着 Skill、Memory 和 Benchmark 的积累，NeoResearch 可以逐步从任务执行系统发展为具备长期经验积累能力的自主科研系统。

## 2. 总体设计原则

NeoResearch 应遵循以下几个基本原则。

第一，系统应从“模型调用”转向“科研流程自动化”。NeoResearch 不应只是封装某个 forecasting model，而应覆盖从用户意图理解到实验报告发布的完整流程。

第二，系统应从“单 Agent 回答”转向“多 Agent 协作”。不同 Agent 应承担不同职责，例如意图理解、数据定量分析、数据定性分析、模型搜索、训练执行、结果评估、报告生成等。每个 Agent 都应产出结构化中间文档，便于后续模块读取、追踪和复用。

第三，系统应从“prompt 驱动”转向“harness 驱动”。NeoResearch 的关键不只是写好提示词，而是构建一个稳定的运行环境，包括文件系统记忆、工具协议、上下文管理、实验执行、结果验证和日志记录。

第四，系统应从“一次生成”转向“闭环迭代”。模型设计、训练和评估应形成自动循环。系统需要根据验证集或测试集反馈，持续调整模型结构、超参数、特征处理方式和训练策略。

第五，系统应强调可复现性和可审计性。每一次 Agent 决策、代码修改、实验运行、指标变化和模型选择都应有记录。最终报告应能够回溯模型是如何被发现、训练和选择出来的。

第六，系统应将 Skill 作为一等能力进行管理。NeoResearch 不应只依赖临时 Prompt 或一次性工具调用，而应将高频、稳定、可复用的科研操作封装为 Skill。Skill 可以包含领域知识、操作流程、工具接口、代码模板、诊断规则、失败案例和报告模板。随着任务积累，Skill 应逐步成为 NeoResearch 的能力资产。

### 2.1 交互模式设计：苏格拉底式与认知伴随式

NeoResearch 应支持两种交互模式，以适配不同用户、不同任务和不同研究阶段的需求。两种模式都需要在任务开始时通过 Intent Agent 进行充分交互，把用户需求、预测目标、数据条件、领域知识、实验约束、评价指标和交付要求尽可能聊清楚。二者的区别在于后续执行过程中，人类是否继续参与关键节点确认。

第一种模式是苏格拉底式交互模式（Socratic Mode）。在该模式下，NeoResearch 会在意图理解阶段与用户进行较充分的引导式对话。系统通过连续追问帮助用户澄清任务目标、数据条件、业务背景、建模约束和结果偏好。例如，系统可以追问预测对象是什么、预测窗口多长、是否存在外生变量、最关注哪个误差指标、是否需要轻量化部署、是否有可解释性要求等。待 `intent_spec.md` 确认完成后，系统进入高度自主执行状态。后续的数据分析、模型搜索、训练迭代、评估反思和报告生成原则上不再频繁打扰用户，直到任务完成后输出最终结果。

苏格拉底式模式适合目标较明确、用户希望减少干预、任务可以通过自动实验闭环完成的场景。该模式的核心特点是“前期充分澄清，后期自主执行”。它强调通过高质量的前置交互降低后续过程中的不确定性，使 Agent 能够独立完成较长链条的科研任务。

第二种模式是认知伴随式交互模式（Cognitive Companion Mode）。在该模式下，NeoResearch 同样会在意图理解阶段与用户充分交互，并形成 `intent_spec.md`。但与苏格拉底式模式不同，系统会在后续关键节点主动向用户汇报阶段性结果，并请求用户确认或选择。用户不是只在开始和结束时参与，而是作为认知伙伴参与关键决策。

认知伴随式模式可以设置若干 Human Checkpoints。例如，在数据分析完成后，系统可以请用户确认数据解释是否符合领域知识；在模型搜索计划生成后，系统可以请用户确认是否接受当前搜索空间和预算；在若干轮实验后，系统可以请用户判断是否继续扩大搜索；在最终模型选择前，系统可以展示不同模型在精度、复杂度和可解释性之间的权衡，并请求用户确认最终交付方案。

认知伴随式模式适合任务较复杂、领域知识较强、实验成本较高、模型选择涉及业务权衡的场景。该模式的核心特点是“前期澄清目标，后期关键节点共决策”。它强调 NeoResearch 不是完全替代研究者，而是陪伴研究者共同完成数据理解、模型设计、实验判断和结果解释。

从系统实现上，NeoResearch 可以在 Session 配置中增加 `interaction_mode` 字段，用于选择 `socratic` 或 `cognitive_companion`。在 `socratic` 模式下，系统只在必要错误、重大风险或任务完成时请求用户介入。在 `cognitive_companion` 模式下，系统需要维护一组 Human Checkpoints，并在每个关键节点生成简洁的阶段报告、候选方案和推荐决策，等待用户确认后继续执行。

这两种交互模式体现了 NeoResearch 的两个不同使用形态。苏格拉底式模式强调自主完成任务，适合自动化模型工厂。认知伴随式模式强调人机协同推理，适合复杂科研探索。二者可以共享同一套 Agent、Skill、Memory 和 Harness，只是在用户参与频率和关键节点确认机制上有所不同。

#### 2.1.1 Human Checkpoints 的信息呈现方式

在认知伴随式模式中，Human Checkpoints 不应让用户阅读大量底层日志，而应把复杂执行结果压缩为易于判断的决策信息。每个 Checkpoint 建议包含三类内容：阶段性结论、候选选项和推荐动作。

阶段性结论用于说明系统已经完成了什么、发现了什么，以及当前阶段的关键风险。候选选项用于列出后续可以采取的几种合理路径。推荐动作用于给出系统建议选择哪一种路径，并说明原因。

例如，在数据分析完成后，系统可以展示数据中是否存在明显趋势、季节性、异常点、缺失值和外生变量依赖，并提示这些发现对模型选择的影响。在模型搜索阶段，系统可以给出三种选项：继续搜索轻量模型、扩大搜索空间、停止搜索并发布当前最优模型。在最终模型选择阶段，系统可以展示精度、复杂度、训练成本和可解释性之间的权衡，并给出推荐交付方案。

这种设计可以避免人类被底层执行细节淹没，也可以保留研究者对关键科研判断的控制权。

## 3. 系统总体流程

NeoResearch 的整体流程可以划分为四个主要阶段：用户意图理解、数据分析、模型搜索与训练迭代、结果发布与交付。

### 3.1 用户意图理解 Agent

用户意图理解 Agent 是 NeoResearch 的入口模块。它的任务是通过与用户交互，明确 Time Series Forecasting 任务所需的关键信息，并将交互结果整理成结构化 Markdown 文档。

该 Agent 需要从用户输入中抽取以下信息：预测对象、数据来源、时间粒度、lookback window、prediction horizon、预测变量、外生变量、业务背景、评估指标、资源约束、模型复杂度约束、延迟要求、可解释性要求以及实验交付要求。

如果用户输入不完整，Intent Agent 应通过多轮对话进行补充确认。例如，它可以询问数据是否存在缺失值、是否包含节假日或天气等外部情境信息、预测目标更关注短期趋势还是长期趋势、是否需要轻量化部署、是否有特定指标要求等。

该阶段的输出应为 `intent_spec.md`。该文档至少包括任务定义、数据描述、业务背景、预测目标、评估指标、实验约束、用户偏好和开放问题。这个文档将作为后续数据分析 Agent 和 NAS Agent 的输入。

### 3.2 数据分析阶段

数据分析阶段由一个 Data Analysis Main Agent 负责任务调度，并初始化两个 Sub-agent：定量分析 Agent 和定性分析 Agent。二者分别从不同角度理解数据，并生成独立的 Markdown 分析报告。

#### 3.2.1 定量数据分析 Agent

定量数据分析 Agent 主要负责调用统计工具和时间序列分析工具，对数据进行可计算的特征诊断。它可以分析数据长度、采样频率、缺失率、异常值比例、趋势性、季节性、周期性、平稳性、自相关性、分布偏移、变量相关性和多变量依赖关系。

该 Agent 可以调用常见的时间序列统计工具，例如 ADF 检验、KPSS 检验、自相关函数、偏自相关函数、STL 分解、频域分析、缺失值检测、异常点检测、滑动窗口统计、相关性分析和跨变量滞后关系分析。对于多变量时间序列，该 Agent 还应分析变量之间的相关结构，以及外生变量对预测目标的潜在影响。

该阶段输出为 `quantitative_analysis.md`，内容包括主要统计结果、关键图表说明、数据风险点、建模建议和需要进一步确认的问题。

#### 3.2.2 定性数据分析 Agent

定性数据分析 Agent 主要负责结合用户提供的领域知识、数据字段语义和业务背景，对时间序列数据进行语义层面的解释。它需要理解每个变量的含义、数据背后的业务机制、可能影响预测目标的外部因素，以及异常变化是否可能来自真实事件。

例如，在能源预测任务中，定性分析 Agent 应关注天气、节假日、工作日、用电行为、装机容量、设备状态和政策事件等因素。在医疗时间序列任务中，它应关注病人生理状态、药物干预、手术阶段和临床事件等因素。定性分析的核心作用是弥补纯统计分析难以覆盖的领域背景。

该阶段输出为 `qualitative_analysis.md`，内容包括变量语义解释、领域背景梳理、潜在影响因素、异常事件解释、数据使用风险和建模建议。

#### 3.2.3 Data Analysis Main Agent

Data Analysis Main Agent 负责汇总定量分析和定性分析结果，并生成统一的数据分析报告。它应综合统计证据和领域知识，形成对当前数据的整体判断。

该阶段输出为 `data_analysis_summary.md`，内容包括数据整体画像、主要模式、关键风险、适合的模型方向、特征处理建议、验证方案建议和对 NAS Agent 的建模提示。该文档应成为后续模型搜索与训练迭代的重要依据。

### 3.3 NAS Agent：模型搜索与训练迭代

NAS Agent 是 NeoResearch 的核心执行模块。它需要根据 `intent_spec.md` 和 `data_analysis_summary.md` 初始化一个适合当前任务的神经网络模型，并在给定约束下进行训练、评估和迭代搜索。

这里的 NAS 不应被狭义理解为传统神经网络架构搜索，而应被理解为面向时间序列预测的模型配方搜索（Model Recipe Search）。搜索对象可以包括模型结构、输入窗口长度、预测窗口设置、特征处理方式、归一化策略、损失函数、优化器、学习率、batch size、训练轮数、正则化方式、外生变量融合方式和轻量化约束。

NAS Agent 的基本循环如下：首先，它根据任务目标和数据分析结果生成一个初始模型方案；然后，它调用训练工具执行实验；接着，它读取验证集和测试集结果；然后，它分析当前模型的不足；最后，它提出下一轮修改方案并继续实验。这个循环应持续进行，直到达到资源预算、指标阈值或收敛条件。

在迭代过程中，NAS Agent 需要重点记录每次实验的假设、修改点、训练配置、评估结果和反思结论。系统不应只保留最优模型，而应保留完整的探索轨迹。这些轨迹本身是 NeoResearch 的重要科研产物，也可以作为后续经验记忆，用于改进新的任务。

该阶段应输出多个文件，包括 `model_search_plan.md`、`experiment_log.md`、`leaderboard.md`、`best_model_config.yaml`、`best_model.py`、`training_script.py`、`evaluation_result.md` 和 `reflection_notes.md`。

### 3.4 结果发布与实验报告整理

结果发布阶段负责将前面所有阶段的产物整理为可交付结果。它不只是简单输出最终指标，而是要形成完整的科研报告和模型交付包。

最终输出应包括模型参数、模型代码、训练脚本、评估脚本、数据处理脚本、实验结果表格、模型探索过程记录、关键失败案例、最终模型选择理由和完整实验报告。实验报告应清楚说明任务目标、数据情况、建模过程、搜索过程、最终结果、消融分析和后续改进方向。

该阶段的核心输出为 `final_report.md`。同时，系统应生成可复现的项目目录，例如 `src/`、`configs/`、`checkpoints/`、`logs/`、`reports/` 和 `artifacts/`。如果面向论文或项目交付，还可以进一步生成摘要、图表、方法说明和结果对比表。

### 3.5 Agent I/O contract：智能体输入输出契约

为了让 NeoResearch 从概念系统变成可执行系统，需要为每个 Agent 定义明确的输入输出契约。Agent I/O Contract 的作用是规定每个 Agent 能读取什么、必须生成什么、关键字段是什么、失败状态如何记录。这样可以减少不同 Agent 之间的上下文混乱，也方便系统进行暂停、恢复、审计和复现。

Intent Agent 的输入包括用户自然语言需求、可选数据描述和历史交互上下文。输出为 `intent_spec.md`。关键字段包括任务目标、预测对象、目标变量、时间粒度、lookback window、prediction horizon、外生变量、评价指标、资源约束、交互模式和开放问题。

Quantitative Analysis Agent 的输入包括 `intent_spec.md`、原始数据、预处理数据和 `dataset_profile.yaml`。输出为 `quantitative_analysis.md`。关键字段包括缺失值情况、异常值情况、平稳性检验、趋势性、季节性、自相关性、分布漂移、变量相关性和建模建议。

Qualitative Analysis Agent 的输入包括 `intent_spec.md`、字段说明、领域知识和定量分析摘要。输出为 `qualitative_analysis.md`。关键字段包括变量语义、业务机制、外部情境、可能事件、数据风险和领域建模建议。

Data Analysis Main Agent 的输入包括 `quantitative_analysis.md`、`qualitative_analysis.md` 和 `dataset_profile.yaml`。输出为 `data_analysis_summary.md`。关键字段包括数据整体画像、主要模式、关键风险、特征工程建议、模型方向建议和验证策略建议。

NAS Agent 的输入包括 `intent_spec.md`、`data_analysis_summary.md`、`search_space.yaml` 和历史实验记录。输出为 `model_search_plan.md`、`experiment_log.md`、`leaderboard.md` 和 `best_model_config.yaml`。关键字段包括模型配方、搜索动作、修改理由、训练配置、评估结果和下一步计划。

Training Agent 的输入包括模型配置、数据版本、训练脚本和资源约束。输出为训练日志、checkpoint 和训练状态。关键字段包括训练命令、随机种子、代码版本、数据版本、训练时间、资源消耗和失败状态。

Evaluation/Verifier Agent 的输入包括预测结果、真实值、baseline 结果、训练日志和模型配置。输出为 `evaluation_result.md` 和 verifier decision。关键字段包括指标结果、horizon-wise 表现、baseline 对比、过拟合检查、成本收益判断、数据泄露检查和是否接受该实验结果。

Reflection Agent 的输入包括 `evaluation_result.md`、`experiment_log.md`、`leaderboard.md` 和历史经验。输出为 `reflection_notes.md` 和 `next_experiment_plan.md`。关键字段包括失败原因、有效改动、无效改动、下一轮假设和是否继续迭代。

Report Agent 的输入包括所有中间文档、实验记录、最优模型配置和评估结果。输出为 `final_report.md` 和 `release_package.md`。关键字段包括任务背景、数据分析、模型搜索过程、最终结果、失败案例、最终模型选择理由和复现说明。

Agent I/O Contract 的基本原则是：每个 Agent 的输出都应当成为后续 Agent 的可读输入，每个关键决策都应当落到文件中，每个失败状态都应当能够被恢复或审计。

### 3.6 Workflow state machine：系统状态机

NeoResearch 是一个长流程系统，因此需要定义清晰的 Workflow State Machine。状态机用于描述任务从初始化到最终发布的状态流转，也用于支持暂停、恢复、失败回滚和人类确认。

NeoResearch 的基本状态可以包括：`INIT`、`INTENT_ELICITATION`、`INTENT_CONFIRMED`、`DATA_PROFILING`、`DATA_ANALYSIS_RUNNING`、`DATA_ANALYSIS_DONE`、`MODEL_RECIPE_INITIALIZED`、`EXPERIMENT_RUNNING`、`EVALUATION_DONE`、`REFLECTION_DONE`、`ITERATION_CONTINUE`、`ITERATION_STOP`、`REPORT_GENERATION` 和 `RELEASE_DONE`。

在苏格拉底式模式下，系统通常在 `INTENT_CONFIRMED` 后进入自主执行路径，只有在必要错误、重大风险或任务完成时请求用户介入。在认知伴随式模式下，系统可以在关键状态之间插入 `WAITING_FOR_HUMAN_CONFIRMATION`。例如，数据分析完成后、搜索空间确定前、实验预算扩大前、最终模型发布前，都可以进入等待确认状态。

状态机还需要支持失败状态，例如 `DATA_ERROR`、`CODE_ERROR`、`TRAINING_FAILED`、`EVALUATION_FAILED`、`VERIFIER_REJECTED` 和 `RECOVERY_RUNNING`。当系统进入失败状态时，应记录失败类型、失败原因、相关日志、恢复动作和恢复结果。

通过状态机设计，NeoResearch 可以避免长任务执行过程中的混乱。系统能够明确知道当前处于哪个阶段，下一步允许执行什么动作，是否需要用户确认，以及失败后应该回滚到哪个状态。

## 4. Harness Engineering 设计

NeoResearch 的关键技术基础是 Harness Engineering。它的核心思想是为 Agent 构建一个可执行、可验证、可记忆和可迭代的运行环境。相比单纯依赖 Prompt Engineering，Harness Engineering 更关注工具、文件、协议、上下文、执行环境和反馈机制的系统化设计。

### 4.1 Memory as File Systems

NeoResearch 可以采用 Memory as File Systems 的思想，将 Agent 的中间结果、实验记录、模型配置、错误日志和反思结论都存储为文件。文件系统不仅是存储空间，也是 Agent 的长期记忆结构。

例如，用户意图理解结果保存为 `intent_spec.md`，数据分析结果保存为 `data_analysis_summary.md`，模型搜索轨迹保存为 `experiment_log.md`，最优配置保存为 `best_model_config.yaml`。这种设计可以让 Agent 在不同阶段稳定读取上下文，也方便人工检查和修改。

文件系统记忆应具备层级结构。短期记忆可以用于当前实验轮次，中期记忆可以用于当前任务，长期记忆可以存储跨任务可复用的模型配方、数据模式和失败经验。随着任务积累，NeoResearch 可以逐步形成经验库。

### 4.2 Sub-agent 与 Agent Teams

NeoResearch 应采用 Sub-agent 和 Agent Teams 的思想。系统不应让一个 Agent 处理所有任务，而应将复杂科研流程拆分为多个具备明确职责的 Agent。

典型 Agent Team 可以包括 Intent Agent、Quantitative Analysis Agent、Qualitative Analysis Agent、Data Analysis Main Agent、NAS Agent、Training Agent、Evaluation Agent、Reflection Agent、Report Agent 和 Release Agent。每个 Agent 都应有清晰输入、输出和边界。

Agent Teams 的优势在于可以降低单个 Agent 的上下文负担，使不同 Agent 专注于不同任务，并通过结构化文档实现协作。后续也可以引入 Reviewer Agent，对模型搜索计划、实验结论和最终报告进行审查。

### 4.3 Planning：To Do Lists

NeoResearch 应将 Planning 作为核心机制。每个阶段开始前，Agent 需要生成明确的 To Do Lists，并在执行过程中更新任务状态。

例如，数据分析阶段的 To Do List 可以包括：检查数据格式、识别时间戳、统计缺失值、分析季节性、检测异常点、生成图表和撰写报告。NAS 阶段的 To Do List 可以包括：初始化 baseline、训练初始模型、记录指标、分析误差、修改模型结构、重新训练和更新 leaderboard。

To Do Lists 的作用是让长任务可管理、可追踪和可中断恢复。它也有助于减少 Agent 在长流程中的遗忘和重复执行。

### 4.4 Bash is all you need

NeoResearch 应重视命令行和脚本化执行能力。对于模型训练、数据处理、评估、日志整理和文件管理，Bash 可以作为通用执行接口。Agent 可以通过 Bash 调用 Python 脚本、运行训练命令、检查文件目录、读取日志、启动评估流程和打包结果。

这种设计的优点是简单、通用、可复现。只要训练脚本、配置文件和命令记录完整，人工研究者和 Agent 都可以复现实验过程。NeoResearch 的实验执行应尽量避免隐藏式操作，而应将关键命令写入日志。

### 4.5 MCP：标准化工具调用协议

NeoResearch 可以引入 MCP 或类似的标准化工具调用协议，用于连接数据分析工具、训练工具、评估工具、可视化工具、模型库和外部知识库。MCP 的作用是让 Agent 能够以标准方式调用工具，而不是为每个工具单独编写临时接口。

在 Time Series Forecasting 场景中，MCP 工具可以包括数据读取工具、统计诊断工具、特征工程工具、模型训练工具、指标评估工具、绘图工具、日志解析工具、代码修改工具和报告生成工具。工具调用应有明确输入输出，并尽量返回结构化结果。

### 4.6 Skill：可复用科研能力包

NeoResearch 应支持 Skill 机制。这里的 Skill 不是单个工具，而是一种可复用的科研能力包。它可以将某一类稳定任务所需的知识、流程、工具和模板封装起来，使 Agent 在执行复杂研究任务时能够按需调用。

在 Time Series Forecasting 场景中，Skill 可以包括数据读取 Skill、缺失值处理 Skill、异常检测 Skill、平稳性分析 Skill、季节性分解 Skill、频域分析 Skill、时序特征工程 Skill、外生变量融合 Skill、baseline 训练 Skill、深度模型训练 Skill、模型评估 Skill、误差诊断 Skill、可视化报告 Skill 和模型发布 Skill。对于具体领域，还可以进一步构建能源预测 Skill、光伏预测 Skill、水文径流预测 Skill、医疗时序预警 Skill 和交通流量预测 Skill。

每个 Skill 应包含明确的元信息，例如 Skill 名称、适用场景、触发条件、输入格式、输出格式、依赖工具、执行步骤、约束条件、常见失败模式和示例调用。这样可以让 Agent 在面对新任务时，不需要从零开始规划，而是能够从 Skill Registry 中选择合适能力，并组合多个 Skill 完成任务。

Skill 的作用可以从三个层面理解。第一，它是经验沉淀机制。NeoResearch 可以把历史任务中的有效分析方法、模型配方和调参策略沉淀为 Skill。第二，它是能力复用机制。不同 Agent 可以调用同一个 Skill，从而减少重复实现。第三，它是上下文压缩机制。复杂的操作流程可以被封装在 Skill 内部，Agent 只需要理解何时调用、如何传参、如何读取输出。

NeoResearch 的 Skill 不应是静态的。系统可以在任务完成后对 Skill 进行更新。例如，如果某个光伏预测任务中发现“晴雨切换场景下误差显著增大”，系统可以将该经验写入光伏预测 Skill 的失败案例部分。如果某个模型搜索策略在多个数据集上有效，系统可以将其抽象为新的模型搜索 Skill。通过这种方式，NeoResearch 可以逐步从单任务执行系统发展为具备经验积累能力的自主科研系统。

从工程实现上，NeoResearch 可以设置一个 `skills/` 目录或 Skill Registry，用于统一管理所有 Skill。每个 Skill 可以由 `skill.md`、`config.yaml`、`examples/`、`scripts/` 和 `templates/` 组成。Agent 在执行任务时，可以先读取 Skill 的说明文档，再调用对应脚本或工具。这样可以把自然语言指导、程序化执行和经验知识统一起来。

### 4.7 Session 与上下文管理

NeoResearch 需要设计 Session 和上下文管理机制。每个用户任务都应对应一个独立 Session。Session 内部保存用户意图、数据文件、分析结果、实验配置、模型输出和历史对话。不同任务之间应避免上下文污染。

对于长任务，系统应支持上下文压缩。Agent 可以定期将当前状态总结为 `session_summary.md`，其中包括已完成任务、当前最优结果、未解决问题、下一步计划和关键文件路径。这样可以让系统在长流程中保持稳定，也方便任务恢复。

### 4.8 Harness environment taxonomy：科研环境定义体系

从 Harness Engineering 的角度看，NeoResearch 不应只定义工具和 Agent，还需要定义一组可执行、可观察、可验证、可恢复的科研环境。Agent 不是在抽象对话中完成研究，而是在一套经过约束和设计的环境中理解任务、分析数据、生成模型方案、执行实验、验证结果、反思失败并交付产物。

NeoResearch 的 Harness Environment 可以理解为系统运行的基础底座。它需要明确每个环境中的状态、动作、观测、验证机制、产物和失败恢复方式。这样才能让 Agent 的行为从“自然语言生成”变成“受控科研行动”。

#### 4.8.1 Session environment：任务会话环境

Session environment 是 NeoResearch 的最外层任务环境。每一个用户任务都应被封装为一个独立 Session。该环境负责管理用户需求、交互模式、任务状态、数据路径、中间文档、实验配置、工具调用历史、Human Checkpoints 和最终产物。

该环境需要回答几个核心问题：当前任务进行到哪里了，哪些信息已经确认，哪些文件是当前任务的有效上下文，哪些实验已经完成，哪些结果可以恢复。Session environment 是长任务执行、上下文治理和任务恢复的基础。

一个 Session 可以包含以下核心字段：`session_id`、`interaction_mode`、`task_status`、`intent_spec`、`data_profile`、`experiment_registry`、`memory_files`、`human_checkpoints` 和 `final_artifacts`。

#### 4.8.2 Intent elicitation environment：意图澄清环境

Intent elicitation environment 是用户意图理解 Agent 所处的环境。它不是普通聊天环境，而是一个有目标的需求抽取环境。Agent 的动作不是随意回复，而是通过苏格拉底式提问逐步补全任务规格。

该环境中的状态是当前已经获得的任务信息，动作包括提问、确认、总结和生成 `intent_spec.md`，观测包括用户回复、已有数据和上下文信息，终止条件是任务定义达到可执行状态。该环境的核心产物是 `intent_spec.md`。

这个环境的目标是将用户自然语言需求转化为结构化任务规格，使后续数据分析、模型搜索和实验执行能够稳定开展。

#### 4.8.3 Data workspace environment：数据工作区环境

Data workspace environment 负责管理数据文件、元数据、预处理结果和数据版本。NeoResearch 需要明确数据从哪里来、如何读取、如何切分、如何预处理，以及如何防止数据泄露。

该环境可以划分为 raw data zone、processed data zone、metadata zone、train/validation/test split zone、data version registry 和 data leakage checker。它的核心作用是保证数据处理过程可复现、可审计，并为后续建模提供稳定输入。

#### 4.8.4 Data diagnosis environment：数据诊断环境

Data diagnosis environment 是 Quantitative Analysis Agent 和 Qualitative Analysis Agent 使用的环境。它需要封装时间序列诊断工具、统计检验工具、领域知识分析工具和图表生成工具。

该环境中的动作包括平稳性分析、季节性分析、异常检测、缺失检测、变化点检测、频域分析、分布漂移分析和领域解释。观测包括统计结果、图表路径、诊断摘要和风险提示。核心输出包括 `quantitative_analysis.md`、`qualitative_analysis.md` 和 `data_analysis_summary.md`。

该环境的目标是让 Agent 在建模前充分理解数据，而不是直接套用模型。

#### 4.8.5 Model recipe environment：模型配方设计环境

Model recipe environment 是 NAS Agent 设计模型方案的环境。它不应直接等同于代码环境，而应首先定义一个可操作的 Model Recipe Space。

该环境需要定义 Agent 可以执行的建模动作，例如选择 backbone、调整 lookback window、调整 prediction horizon、选择归一化策略、选择损失函数、加入外生变量、加入分解模块、加入 attention 模块、修改 channel-independent 或 channel-mixing 策略、调整学习率、调整 batch size、调整 epoch、控制参数量和推理延迟等。

该环境的核心作用是让模型设计从模糊的自然语言建议，变成可搜索、可执行、可验证的 Action Space。

#### 4.8.6 Code and execution environment：代码与执行环境

Code and execution environment 是 Agent 真正运行代码的环境。它需要支持 Bash、Python、配置文件、训练脚本、评估脚本、日志读取和错误捕获。

该环境需要定义 allowed commands、forbidden commands、executable scripts、runtime dependencies、environment variables、working directory、error handling rules 和 rollback points。Agent 不应在无限制环境中随意改代码和运行命令，而应在受控执行环境中完成代码修改、脚本运行和实验执行。

该环境的目标是让每一次代码修改和命令执行都可追踪、可复现、可回滚。

#### 4.8.7 Experiment environment：实验运行环境

Experiment environment 是模型训练、验证和结果记录的环境。每一次实验都应被注册为一个独立 Run，并保存完整的实验信息。

每个 Run 至少应记录 run ID、model config、data version、code version、random seed、training command、metric results、checkpoint path、log path、failure status 和 cost record。该环境需要解决的问题是：每一次实验能否复现，每一次指标变化来自哪里，每一次失败是否能够定位原因。

该环境是 NeoResearch 从自动试错系统走向可信科研系统的关键基础。

#### 4.8.8 Verifier environment：评估与验证环境

Verifier environment 是 NeoResearch 的判断环境。Agent 不能只根据某个指标是否提升来判断实验成功。Verifier environment 需要综合判断模型表现、稳定性、成本、可信度和可复现性。

该环境可以包括 metric verifier、data leakage verifier、overfitting verifier、baseline comparison verifier、cost-performance verifier、stability verifier 和 horizon-wise performance verifier。例如，某个模型虽然在验证集上小幅提升，但参数量和训练成本显著增加，Verifier 应指出该改动的性价比不足。某个模型在短 horizon 上表现更好，但在长 horizon 上明显退化，Verifier 应指出这种 trade-off。

该环境是 NeoResearch 可信闭环的核心。

#### 4.8.9 Reflection environment：反思与决策环境

Reflection environment 负责将实验结果转化为下一步科研决策。它需要把实验指标、错误诊断、Verifier 结论和历史经验结合起来，形成新的实验计划。

该环境中的观测包括当前实验结果、失败案例、误差分析和 Verifier 判断。动作包括继续搜索、缩小搜索空间、调整模型结构、调整特征、停止实验、回滚配置或请求人类确认。核心输出包括 `reflection_notes.md` 和 `next_experiment_plan.md`。

该环境的价值在于让 NeoResearch 不只是运行实验，而是能够根据实验反馈进行有依据的迭代。

#### 4.8.10 Skill environment：技能调用环境

Skill environment 负责管理 Skill 的检索、调用、组合、更新和评估。Skill 不只是文件夹，也需要对应的运行环境。

该环境需要定义 skill registry、skill metadata、skill trigger condition、skill input/output schema、skill dependency、skill execution log、skill success/failure record 和 skill update policy。Agent 在执行任务时，可以根据当前任务阶段和数据特征选择合适 Skill，并将多个 Skill 组合成一个 workflow。

该环境使 NeoResearch 能够从一次性执行系统发展为能力持续积累系统。

#### 4.8.11 Memory environment：记忆环境

Memory environment 负责管理 NeoResearch 的多层记忆。建议至少区分三类记忆：short-term memory、session memory 和 long-term research memory。

Short-term memory 用于保存当前阶段的临时状态。Session memory 用于保存当前任务的完整过程记录。Long-term research memory 用于保存跨任务可复用的经验、Skill、模型配方和失败案例。

该环境需要明确什么内容应该被记住，什么内容应该被压缩，什么内容应该被遗忘，什么内容可以迁移到下一个任务。记忆环境是 NeoResearch 形成长期科研能力的重要基础。

#### 4.8.12 Human checkpoint environment：人类确认环境

Human checkpoint environment 主要服务于认知伴随式模式。该环境需要定义哪些节点需要用户确认，以及如何将复杂结果压缩成人类容易判断的内容。

典型 Human Checkpoints 包括任务定义确认、数据分析结果确认、搜索空间确认、实验预算确认、阶段性结果确认、最终模型选择确认和报告发布确认。该环境的目标是让人类参与关键判断，而不是被大量底层日志和执行细节打扰。

#### 4.8.13 Report and artifact environment：报告与产物环境

Report and artifact environment 负责管理最终交付物。NeoResearch 最终交付的不只是模型，而是一组可阅读、可运行、可复现和可发布的科研产物。

该环境需要管理 `final_report.md`、`best_model.py`、`best_model_config.yaml`、checkpoint、`training_script.py`、`evaluation_script.py`、`leaderboard.md`、`experiment_log.md` 和 `release_package.md`。该环境应确保最终结果能够被用户审阅、复现实验并进一步部署。

#### 4.8.14 Governance and safety environment：治理与安全环境

Governance and safety environment 负责约束 NeoResearch 的自动执行行为。由于系统会读取数据、修改代码、运行实验、调用工具并生成模型结果，因此需要基本的治理机制。

该环境需要定义权限边界、数据访问规则、危险命令限制、测试集保护规则、日志审计机制、异常操作报警、隐私与敏感数据处理规则。对于科研任务，该环境还应关注测试集污染、过度调参、不当指标选择和不可复现实验等问题。

该环境可以与 Verifier environment 配合，保证 NeoResearch 的实验过程更加可信。

#### 4.8.15 Benchmark environment：基准测试环境

Benchmark environment 用于评估 NeoResearch 自身的系统能力，而不只是评估某个预测模型。若 NeoResearch 未来作为论文系统或开源平台，该环境非常重要。

该环境需要定义标准数据集、标准任务、固定 train/validation/test split、固定预算、固定 baseline、系统级指标和复现实验协议。系统级指标可以包括任务完成率、代码可运行率、实验复现率、人工介入次数、平均搜索成本、最终模型提升幅度、报告质量和 Skill 复用率。

该环境有助于证明 NeoResearch 作为 Autonomous Research Agent 的价值。

#### 4.8.16 环境分层总结

NeoResearch 的 Harness Environment 可以进一步划分为五个层次。

第一层是 user-facing environment，包括 Intent elicitation environment 和 Human checkpoint environment。它负责用户交互、需求澄清和关键节点确认。

第二层是 research workspace environment，包括 Session environment、Data workspace environment、Memory environment 和 Report and artifact environment。它负责组织任务空间、数据空间、记忆空间和产物空间。

第三层是 data and modeling environment，包括 Data diagnosis environment、Model recipe environment 和 Skill environment。它负责理解数据、设计模型配方和调用可复用技能。

第四层是 execution and evaluation environment，包括 Code and execution environment、Experiment environment、Verifier environment 和 Reflection environment。它负责代码执行、实验运行、结果验证和反思迭代。

第五层是 governance and benchmark environment，包括 Governance and safety environment 和 Benchmark environment。它负责安全治理、系统评估和长期可持续运行。

对于每一个环境，NeoResearch 都应尽量明确六个基本要素：State 表示当前环境状态，Action 表示 Agent 可以执行的动作，Observation 表示 Agent 可以获得的反馈，Verifier 表示如何判断结果是否有效，Artifact 表示该环境产生的文件，Failure handling 表示失败后如何恢复。

因此，NeoResearch 的核心不只是 Agent、NAS 或工具调用，而是构建一个面向时间序列预测的科研 Harness Environment。这个环境能够支持 Agent 将用户意图转化为可执行模型配方，运行受控实验，验证实验结果，反思失败原因，并交付可复现的 forecasting artifacts。

### 4.9 Failure recovery：失败恢复与调试机制

NeoResearch 必须具备失败恢复能力。对于一个自主科研智能体而言，失败不是异常情况，而是长流程科研执行中的常态。系统需要能够识别失败、定位原因、采取恢复动作，并将失败经验记录到 Memory 或 Skill 中。

失败恢复机制可以采用“失败类型—检测信号—恢复动作—记录方式”的结构。数据读取失败时，系统应检查文件路径、格式、编码、时间戳字段和字段类型，并生成数据读取错误报告。数据切分异常时，系统应检查时间顺序、训练集与测试集边界、窗口构造方式和数据泄露风险。缺失值或异常值处理失败时，系统应回滚到原始数据版本，并尝试更保守的预处理策略。

训练阶段可能出现显存不足、loss 变为 NaN、模型不收敛、训练过慢、checkpoint 丢失等问题。显存不足时，系统可以降低 batch size、缩小模型规模、减少 lookback window、启用 gradient accumulation 或切换到轻量模型。loss 变为 NaN 时，系统可以降低学习率、检查归一化策略、替换损失函数或检查异常输入。模型不收敛时，系统可以调整优化器、训练轮数、初始化方式或特征处理策略。

代码执行阶段可能出现脚本错误、依赖缺失、配置不匹配和输出文件缺失等问题。系统应优先通过受控 patch、单元测试和回滚点进行恢复，而不是让 Agent 无约束地反复修改代码。每次代码修改都应记录修改原因、修改位置、测试结果和回滚路径。

评估阶段可能出现指标异常、验证集提升但测试集退化、horizon-wise collapse、baseline 比较不公平或测试集污染等问题。此时 Verifier 应拒绝该实验结果，并触发反思与恢复流程。系统需要重新检查数据切分、评估脚本、指标计算方式和随机种子。

失败恢复的目标不是掩盖失败，而是让失败变成可审计、可学习和可迁移的经验。每一次失败都应写入 `failure_log.md`，其中包括失败类型、检测信号、恢复动作、恢复是否成功和可复用经验。若某类失败多次出现，NeoResearch 可以将其沉淀为新的 Skill 或更新已有 Skill 的失败案例部分。

## 5. 工具集封装与研发类型

NeoResearch 的工具集是 Agent 能够真正执行科研任务的基础。工具集不应只是若干 Python 函数的简单堆叠，而应被设计为一套可被 Agent 稳定调用、可被 Skill 组合复用、可被日志系统追踪、可被 Verifier 检查的标准化能力接口。每类工具都应具备清晰的输入输出、异常处理、执行日志和结果文件路径。工具研发的目标是让 Agent 能够从“会想”进一步走向“会做、会验证、会复现”。

### 5.1 数据接入与数据管理工具

第一类是数据接入与数据管理工具。该类工具负责读取、解析和管理不同来源的时间序列数据，包括 CSV、Excel、Parquet、JSON、数据库、API、传感器数据和云端存储数据。它需要支持时间戳识别、采样频率推断、变量类型识别、数据切分、元数据生成和数据版本记录。

这类工具的核心输出不只是原始数据表，而应包括结构化的数据描述文件，例如 `metadata.md` 或 `dataset_profile.yaml`。该文件需要记录数据字段、时间范围、采样间隔、目标变量、外生变量、缺失情况、数据版本和切分策略，为后续分析与建模提供统一入口。

### 5.2 数据预处理与清洗工具

第二类是数据预处理与清洗工具。该类工具负责处理缺失值、异常值、重复时间戳、不规则采样、时间对齐、单位转换、归一化、标准化、滑动窗口构造和多变量拼接等问题。对于 Time Series Forecasting，这类工具尤其重要，因为数据清洗质量会直接影响模型训练和评估可信度。

预处理工具应支持多种策略选择。例如，缺失值可以采用前向填充、后向填充、插值、模型填补或掩码建模；异常值可以采用统计阈值、局部离群因子、滑动窗口检测或领域规则检测。工具不仅要执行处理，还要记录采用了哪种策略、为什么采用该策略，以及处理前后的数据变化。

### 5.3 时间序列诊断与统计分析工具

第三类是时间序列诊断与统计分析工具。该类工具用于帮助 Agent 理解数据自身的统计特征和动态模式。它可以包括平稳性检验、趋势分析、季节性分解、周期性分析、自相关分析、偏自相关分析、频域分析、分布漂移检测、变化点检测、滞后相关分析和多变量依赖分析。

这类工具应成为 Quantitative Analysis Agent 的核心能力。它们的输出应尽量结构化，例如输出检验统计量、p-value、图表路径、主要发现和建模建议。Agent 不能只看到图，还需要能够读取工具返回的结论性摘要，并据此判断后续是否需要差分、去趋势、加入季节性模块、调整窗口长度或引入外生变量。

### 5.4 领域知识与情境信息工具

第四类是领域知识与情境信息工具。时间序列预测往往不仅依赖数值序列本身，还依赖领域背景、外部事件和情境变量。NeoResearch 需要支持对领域知识的接入、整理和调用。

在能源预测中，这类工具可以接入天气、节假日、工作日、装机容量、设备状态和政策事件等信息。在医疗时序任务中，它可以整理手术阶段、药物干预、生命体征、诊疗事件和临床规则。在交通预测中，它可以接入道路结构、节假日、天气、事故和拥堵事件。这类工具的作用是让 Agent 不只做统计拟合，而能开展情境感知的建模判断。

### 5.5 特征工程与表示构造工具

第五类是特征工程与表示构造工具。该类工具负责生成可用于模型训练的输入特征，包括时间特征、日历特征、滞后特征、滚动统计特征、频域特征、趋势特征、季节性特征、事件特征、外生变量特征和多尺度窗口特征。

对于深度学习模型，该类工具还可以支持 patch 构造、channel-independent 输入、channel-mixing 输入、多尺度 token、时间位置编码和变量嵌入等表示构造方式。它应与模型配方搜索模块配合，使 NAS Agent 能够把“加入某类特征”作为可执行动作，而不是只停留在自然语言建议。

### 5.6 模型库与模型构建工具

第六类是模型库与模型构建工具。该类工具负责封装不同类型的预测模型，包括统计模型、机器学习模型、深度学习模型和基础模型接口。统计模型可以包括 ARIMA、ETS、Theta、Prophet 等；机器学习模型可以包括 XGBoost、LightGBM、Random Forest 等；深度学习模型可以包括 LSTM、TCN、N-BEATS、DLinear、PatchTST、iTransformer、TimesNet、Autoformer 等；基础模型接口可以包括 Chronos、TimesFM、Moirai、TimeGPT 等。

这类工具的关键不只是收集模型，而是统一模型的输入输出协议、训练接口、预测接口和评估接口。NAS Agent 应能够在同一个协议下选择模型、修改配置、启动训练和读取结果。模型库还应支持模型复杂度估计，例如参数量、推理延迟、显存占用和训练成本。

### 5.7 Model Recipe DSL 与编译工具

第七类是 Model Recipe DSL 与编译工具。NeoResearch 需要将 Agent 提出的模型方案转化为可执行配置和代码。为此，可以设计一种面向时间序列预测的 Model Recipe DSL，用于描述数据处理、特征构造、模型结构、训练策略、评估指标和搜索空间。

例如，Agent 可以用 DSL 表达“使用 96 步 lookback、24 步 horizon、PatchTST backbone、加入节假日特征、使用 MAE loss、训练 30 epoch、以验证集 RMSE 选择最优 checkpoint”。编译工具负责将该 DSL 转化为配置文件、训练脚本和评估命令。这样可以降低 Agent 直接修改代码带来的不稳定性，也有利于实验复现。

#### 5.7.1 Model Recipe DSL 的推荐字段

Model Recipe DSL 应尽量采用结构化配置表示。它至少需要覆盖任务定义、数据处理、特征构造、模型结构、训练策略、评估协议和资源约束。一个示例 DSL 如下：

```yaml
task:
  type: forecasting
  target: load
  horizon: 24
  lookback: 96
  granularity: 15min

interaction:
  mode: cognitive_companion
  human_checkpoints:
    - data_analysis_done
    - search_space_confirmed
    - final_model_selection

data:
  split: chronological
  train_ratio: 0.7
  val_ratio: 0.1
  test_ratio: 0.2
  normalization: z_score
  missing_value_strategy: interpolation
  exogenous_variables:
    - weather
    - holiday

features:
  calendar_features: true
  lag_features: true
  rolling_statistics: true
  decomposition_features: false

model:
  backbone: PatchTST
  channel_strategy: channel_independent
  decomposition: true
  attention: temporal_attention
  parameter_budget: 5M

training:
  loss: mae
  optimizer: adamw
  learning_rate: 0.0005
  batch_size: 32
  epochs: 30
  early_stopping: true
  seed: 2026

evaluation:
  metrics:
    - mae
    - rmse
    - smape
  selection_metric: rmse
  compare_with_baselines: true

resource:
  max_trials: 30
  max_runtime_hours: 12
  gpu_required: true
```

NAS Agent 的动作应尽量落到 DSL 字段的修改上。例如，它可以调整 `lookback`、修改 `backbone`、启用 `decomposition`、加入外生变量、改变损失函数或缩小参数预算。这样可以避免 Agent 直接进行不受控代码修改，也可以让每一次实验差异更加清晰。

Model Recipe DSL 的核心作用是充当自然语言研究假设与可执行训练流程之间的中间表示。它既方便 Agent 规划，也方便编译器生成训练命令、配置文件和实验记录。

### 5.8 训练执行与资源调度工具

第八类是训练执行与资源调度工具。该类工具负责启动训练、监控训练过程、管理 GPU/CPU 资源、处理日志、保存 checkpoint、捕获错误和中断恢复。它可以通过 Bash、Python runner、任务队列或集群调度系统执行。

这类工具应支持标准化命令记录。例如，每一次训练都应记录运行命令、配置文件、随机种子、代码版本、数据版本、开始时间、结束时间、资源消耗和异常信息。对于训练失败的情况，工具需要返回结构化错误，方便 Agent 判断是数据问题、代码问题、显存问题、模型不收敛问题还是环境依赖问题。

### 5.9 评估、验证与 Verifier 工具

第九类是评估、验证与 Verifier 工具。该类工具负责计算预测指标、生成误差分析、比较 baseline、检测过拟合、检查数据泄露、分析不同 horizon 上的性能变化，并判断某次迭代是否构成真实改进。

Verifier 工具是 NeoResearch 的关键。它不应只返回一个指标，而应综合验证模型表现、稳定性、成本和可信度。例如，某个模型虽然在验证集上提升很小，但显著增加了参数量和训练成本，Verifier 应能够提醒该改动性价比不足。某个模型在短 horizon 上表现更好，但在长 horizon 上退化明显，Verifier 应指出这种 trade-off。

### 5.10 误差诊断与反思工具

第十类是误差诊断与反思工具。该类工具负责分析模型在哪里失败、为什么失败、下一步如何改进。它可以从 horizon 维度、时间区间维度、变量维度、事件维度和样本难度维度分析预测误差。

例如，工具可以识别模型是否在趋势突变处表现较差、是否在节假日附近误差增大、是否对高峰负荷预测不足、是否对低值区间过拟合、是否存在系统性偏差。Reflection Agent 可以基于这些诊断结果提出下一轮修改方案，例如调整损失函数、加入事件特征、改变窗口长度、引入分解模块或降低模型复杂度。

### 5.11 可视化与报告生成工具

第十一类是可视化与报告生成工具。该类工具负责生成数据分析图、预测结果图、误差分布图、模型对比图、消融实验图、搜索过程图和最终报告。它需要服务于两个目标：一是帮助 Agent 理解实验结果，二是帮助用户快速审阅系统产物。

报告生成工具应支持将中间文档自动组织为 `final_report.md`，并可进一步生成 PDF、HTML 或项目交付包。报告不应只是罗列指标，而应说明任务背景、数据特征、建模过程、搜索轨迹、关键发现、最终模型、失败案例和后续建议。

### 5.12 代码生成、代码修改与测试工具

第十二类是代码生成、代码修改与测试工具。NeoResearch 在探索新模型结构时，可能需要生成或修改模型代码、训练脚本和评估脚本。因此，系统需要具备代码编辑、静态检查、单元测试、运行测试和错误回滚能力。

这类工具应尽量避免 Agent 直接进行无约束代码修改。更合理的方式是让 Agent 通过 DSL、模板或受限 patch 修改代码，并通过测试工具验证代码是否可运行。每次代码修改都应记录修改原因、修改文件、测试结果和回滚点。

### 5.13 实验管理与版本控制工具

第十三类是实验管理与版本控制工具。该类工具负责管理实验编号、配置版本、模型版本、数据版本、代码版本、日志版本和结果版本。它可以维护 `leaderboard.md`、`experiment_log.md` 和 `run_registry.yaml`，使每次实验都可以被追踪和复现。

版本控制工具还应支持比较不同实验之间的差异。例如，某次指标提升到底来自模型结构变化、特征变化、训练策略变化，还是随机种子变化。没有版本管理，NeoResearch 很容易变成不可审计的自动试错系统。

### 5.14 Skill Registry 与工具编排工具

第十四类是 Skill Registry 与工具编排工具。该类工具负责管理、检索、调用和更新 Skill。它需要根据当前任务阶段和数据特征，选择合适 Skill，并将多个 Skill 组合成一个可执行 workflow。

例如，当系统发现数据存在明显季节性时，可以调用 `seasonality_decomposition` Skill；当模型在突变区间误差较大时，可以调用 `change_point_analysis` Skill；当需要生成最终报告时，可以调用 `report_generation` Skill。Skill Registry 应记录每个 Skill 的适用条件、调用历史、成功率和失败案例。

### 5.15 人机交互与确认工具

第十五类是人机交互与确认工具。该类工具主要服务于苏格拉底式模式和认知伴随式模式。它需要支持需求澄清、阶段报告展示、候选方案对比、Human Checkpoint 确认、用户偏好记录和用户反馈整理。

在苏格拉底式模式下，该工具主要用于前期意图澄清和最终结果展示。在认知伴随式模式下，该工具需要在关键节点向用户展示简洁结果、风险提示和推荐决策，并等待用户确认。它的目标是让用户参与关键判断，而不是被大量底层日志打扰。

### 5.16 部署、发布与交付工具

第十六类是部署、发布与交付工具。该类工具负责将最终模型和实验结果整理为可使用的交付包。交付内容可以包括模型权重、模型配置、推理脚本、训练脚本、评估脚本、数据处理流程、环境依赖、使用说明和最终报告。

如果任务需要部署，该类工具还可以进一步支持模型导出、轻量化、ONNX 转换、API 服务封装、批量预测脚本和监控接口。这样 NeoResearch 不仅能发现模型，还能把模型交付给实际使用场景。

### 5.17 安全、权限与治理工具

第十七类是安全、权限与治理工具。由于 NeoResearch 会读取数据、运行代码、调用外部工具并生成模型结果，因此需要基本的安全机制。系统需要限制危险命令，管理文件访问权限，记录工具调用日志，并对敏感数据进行保护。

对于科研任务，治理工具还应关注数据泄露、测试集污染、不当指标选择、过度调参和不可复现实验等问题。它可以与 Verifier 工具配合，保证 NeoResearch 的实验过程更加可信。

总体来看，NeoResearch 的工具集可以分为五个层次：底层执行工具、数据分析工具、模型实验工具、验证反思工具和交付治理工具。底层执行工具保证 Agent 能运行任务；数据分析工具帮助 Agent 理解数据；模型实验工具帮助 Agent 生成和训练模型；验证反思工具帮助 Agent 判断结果并改进方案；交付治理工具保证最终结果可复现、可审计和可使用。

## 6. 关键技术模块

NeoResearch 可以围绕以下关键技术模块进行研发。

第一，任务意图建模模块。该模块负责将自然语言需求转化为结构化任务规格。它需要支持多轮澄清、约束抽取和任务文档生成。

第二，时间序列数据诊断模块。该模块负责从统计和语义两个角度分析时间序列数据，为后续建模提供证据。

第三，模型配方生成模块。该模块负责根据任务规格和数据特征，生成初始模型结构、训练配置和实验计划。

第四，自动实验执行模块。该模块负责调用训练脚本、运行实验、收集日志、保存结果和更新 leaderboard。

第五，评估与反思模块。该模块负责分析实验结果，识别模型失败原因，并提出下一轮迭代方向。

第六，记忆与经验复用模块。该模块负责将历史任务中的成功经验和失败经验抽象为可复用知识，例如某类数据适合的窗口长度、模型结构、归一化策略和损失函数。

第七，Skill 管理与调度模块。该模块负责维护 Skill Registry，并根据任务需求、数据特征和当前执行阶段选择合适的 Skill。它需要支持 Skill 检索、Skill 组合、Skill 调用、Skill 版本管理和 Skill 迭代更新。该模块是 NeoResearch 从一次性 Agent 流程走向长期能力积累的重要基础。

第八，报告生成与发布模块。该模块负责将全部过程整理为结构化报告和可复现代码包。

## 7. 推荐的项目目录结构

NeoResearch 可以采用如下目录结构：

```text
neoresearch-session/
├── intent/
│   └── intent_spec.md
├── data/
│   ├── raw/
│   ├── processed/
│   └── metadata.md
├── analysis/
│   ├── quantitative_analysis.md
│   ├── qualitative_analysis.md
│   └── data_analysis_summary.md
├── configs/
│   ├── search_space.yaml
│   ├── baseline_config.yaml
│   └── best_model_config.yaml
├── skills/
│   ├── stationarity_analysis/
│   │   ├── skill.md
│   │   ├── config.yaml
│   │   └── scripts/
│   ├── seasonality_decomposition/
│   ├── forecasting_baseline/
│   ├── error_diagnosis/
│   └── report_generation/
├── src/
│   ├── models/
│   ├── data_pipeline/
│   ├── training/
│   └── evaluation/
├── experiments/
│   ├── experiment_log.md
│   ├── leaderboard.md
│   └── reflection_notes.md
├── checkpoints/
├── logs/
├── reports/
│   └── final_report.md
└── artifacts/
    ├── best_model.py
    ├── training_script.py
    ├── evaluation_result.md
    └── release_package.md
```

这个目录结构的核心作用是让所有中间结果都有明确位置，使 Agent 能够稳定读取和更新文件，也方便人工研究者检查系统执行过程。其中，`skills/` 目录用于沉淀可复用能力。它可以把常用时间序列分析流程、模型训练流程、误差诊断流程和报告生成流程封装为 Skill，使 NeoResearch 能够在后续任务中复用已有经验。

## 8. 评估与验证机制

NeoResearch 的评估不应只关注最终预测误差，还应关注系统作为 Autonomous Research Agent 的整体能力。

在模型层面，可以使用 MAE、MSE、RMSE、MAPE、SMAPE、MASE、CRPS 等指标，并根据具体任务选择合适指标。在实验层面，需要保证训练集、验证集和测试集严格隔离，避免数据泄露。在搜索层面，需要记录每轮迭代是否带来有效改进，以及 Agent 的修改是否具有合理依据。

在系统层面，可以评估 NeoResearch 的任务完成率、自动化程度、可复现性、实验成本、代码正确性、报告质量和人类介入次数。一个理想的 NeoResearch 系统不一定每次都找到全局最优模型，但应能够稳定地产生合理模型、清晰记录过程，并给出可信的改进路径。

## 11. MVP 版本范围

由于 NeoResearch 的长期目标较大，第一阶段需要明确 MVP 范围。MVP 的目标不是一次性实现完整自主科研系统，而是完成从用户需求到 baseline 模型交付的最小闭环。

MVP 建议优先实现六个模块：Intent Agent、Data Analysis Agent、Baseline Model Search Agent、Experiment Logger、Simple Verifier 和 Final Report Generator。Intent Agent 负责形成 `intent_spec.md`。Data Analysis Agent 负责生成基础数据分析报告。Baseline Model Search Agent 负责在有限模型库中选择和训练若干 baseline。Experiment Logger 负责记录配置、命令、日志和指标。Simple Verifier 负责检查指标、baseline 对比和基本数据泄露风险。Final Report Generator 负责生成最终实验报告和交付包。

MVP 阶段可以暂时不做复杂 NAS、不做大规模分布式训练、不做长期跨任务记忆、不做多领域 Skill 自动进化，也不做完全自动代码生成。这样可以降低研发风险，并尽快验证 NeoResearch 的核心闭环是否成立。

MVP 的成功标准可以定义为：系统能够在一个标准时间序列数据集上完成需求澄清、数据分析、baseline 训练、结果评估、实验记录和最终报告生成；所有实验可以复现；最终报告能够清楚说明数据特征、模型结果和后续改进方向。

## 12. 技术栈建议

NeoResearch 的技术栈应服务于稳定执行、可复现和可扩展。Agent orchestration 可以采用 LangGraph、AutoGen 或自研 runtime。工具协议可以采用 MCP-style tool interface。执行层可以采用 Bash、Python runner 和标准化命令模板。配置管理可以采用 YAML、Hydra 或 OmegaConf。数据处理可以采用 pandas、numpy、polars 和 pyarrow。

时间序列诊断可以使用 statsmodels、scipy、sklearn 和自定义诊断工具。模型训练可以使用 PyTorch、PyTorch Lightning 或其他轻量训练框架。实验管理可以使用 MLflow、Weights & Biases 或自定义 `run_registry.yaml`。报告生成可以采用 Markdown、HTML 和 PDF 管线。存储层可以采用文件系统、SQLite 和轻量对象存储。

在早期阶段，建议优先采用轻量、透明、容易调试的技术方案。例如，可以先使用文件系统和 YAML 管理 Session、配置和实验记录，而不是一开始引入复杂平台。随着任务规模扩大，再逐步引入数据库、分布式调度和更完整的运行时系统。

## 13. 总结

NeoResearch 的核心价值在于将 Time Series Forecasting 的模型构建过程从人工经验驱动，推进到智能体自主探索驱动。它不是简单的 AutoML，也不是单纯的 LLM wrapper，而是一个基于 Harness Engineering 的自主科研智能体系统。它通过用户意图理解、数据分析、模型搜索、实验执行、结果评估和报告生成，形成一个完整的科研闭环。

在 Time Series Forecasting 场景中，NeoResearch 可以作为小模型创造和优化的自动化平台。它既能帮助研究者快速找到有效模型，也能记录模型探索过程，沉淀经验知识，并逐步发展为面向数据科学的 Autonomous Research Agent。
