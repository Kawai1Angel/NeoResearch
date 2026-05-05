**NeoResearch-TSF: Toward autonomous model discovery for time series forecasting**

****

> **NeoResearch：让数据科学研究从人工驱动走向智能体自主研究**
>
> **NeoResearch-TSF：面向时间序列预测的自主模型发现智能体**

> **NeoResearch 不是一个只会回答问题的 AI 助手，而是一个能够真正进入研究工作区、读取数据、调用工具、执行实验、反思结果并发布成果的数据科学研究智能体。它帮助用户把一个模糊的研究想法，逐步变成一个可运行的模型、可复现的实验和可交付的研究报告。**

> **NeoResearch（智多星）是一款面向数据科学研究的自主研究智能体产品。用户只需通过自然语言描述研究目标并提供数据，系统即可在苏格拉底式或认知伴随式交互模式下，自动完成任务澄清、数据诊断、模型设计、实验执行、结果反思与成果发布。与传统 AutoML 工具不同，NeoResearch 不只关注模型选择和超参数优化，而是围绕完整研究流程构建 Agent Runtime，使用户能够获得可复现的模型代码、训练参数、实验结果、研究过程记录和标准化实验报告。当前系统首先在 Time Series Forecasting 场景中落地，致力于让时序预测小模型的发现、训练和交付变得更加自主、高效和可信。**

**NeoResearch（智多星）面向数据科学研究场景，提供从任务理解、数据诊断、模型构建、实验执行、反思优化到结果发布的一站式自主研究体验。用户只需要提供研究目标、数据集和基本约束，系统就能够以 Agent Runtime 为底座，自动组织多个研究智能体完成后续流程，并最终输出可复现的实验报告、模型代码、训练参数和实验结果。**

从用户使用角度看，NeoResearch 的第一个特色是 **自然语言驱动的研究任务创建**。用户不需要一开始就明确所有建模细节，而是可以直接用自然语言描述任务，例如“我希望对某个电力负荷数据进行未来 24 小时预测，并希望模型尽量轻量、可解释”。系统会自动引导用户补充预测目标、预测窗口、评价指标、数据字段、业务约束和输出要求，从而将模糊需求转化为结构化研究任务。

第二个特色是 **双模式交互体验**。NeoResearch 提供“苏格拉底式模式”和“认知伴随式模式”。在苏格拉底式模式下，系统会在任务开始阶段通过引导式提问充分澄清目标、数据和约束，之后尽可能自主完成数据分析、模型设计、实验执行和报告生成。这个模式适合用户希望“前期讲清楚，后面交给系统”的场景。在认知伴随式模式下，系统会在关键研究节点主动向用户汇报进展，例如数据诊断结果、模型设计方案、实验失败原因和最终报告重点，并邀请用户参与确认和修正。这个模式适合高价值、高不确定性或强领域知识任务。

第三个特色是 **项目工作区式的研究体验**。NeoResearch 不只是一个对话窗口，而是一个面向研究任务的 project workspace。每个任务都会形成独立工作区，里面保存数据描述、需求文档、数据诊断报告、模型设计方案、实验配置、训练日志、评估结果、反思记录和最终报告。用户可以随时查看当前任务进展，也可以追溯系统为什么做出某个建模选择。

第四个特色是 **自主数据诊断与建模假设生成**。用户上传数据后，NeoResearch 不会直接盲目训练模型，而是先对数据进行系统诊断。例如在 Time Series Forecasting 场景中，它会分析趋势、周期、异常值、缺失值、非平稳性、变量相关性和分布漂移等特征，并基于诊断结果生成建模假设。比如系统可能提示：“该序列具有明显日周期和周周期，建议引入周期特征和分解式建模结构。”这使用户获得的不只是模型结果，还有对数据本身的理解。

第五个特色是 **自动模型设计与小模型生成**。NeoResearch 的目标不是简单从已有模型库中选择一个模型，而是根据任务需求和数据特征生成模型配方。它可以自动设计轻量化时序预测小模型，包括输入处理方式、模型结构、训练策略、损失函数和评估方案。对于用户来说，这意味着系统不仅能“选择模型”，还能“构建模型”。

第六个特色是 **实验自动执行与持续优化**。系统可以自动运行训练、评估、对比实验和消融实验，并根据结果进行反思和下一轮优化。如果某个模型表现不佳，NeoResearch 会分析可能原因，例如欠拟合、过拟合、窗口长度不合适、协变量无效、长期预测误差累积等，然后自动调整实验方案。用户看到的是一个持续迭代的研究过程，而不是一次性输出结果。

第七个特色是 **基于 Skills 的可复用研究能力**。NeoResearch 内置多种数据科学技能，例如时序数据清洗、统计诊断、异常检测、频域分析、特征工程、模型训练、结果可视化、误差分析和报告生成。用户不需要自己反复写这些基础工具，系统可以根据任务需要自动调用相应技能。随着使用次数增加，NeoResearch 还可以沉淀更多领域技能和实验经验。

第八个特色是 **结果发布 Agent 提供完整交付**。这是 NeoResearch 与普通 AutoML 工具的重要区别。实验完成后，结果发布 Agent 会自动整理自主设计的小模型代码、训练好的参数、实验配置、训练日志、评估结果、预测结果、图表和实验过程，并生成标准化实验报告。最终用户拿到的不是一个零散结果，而是一个完整的研究交付包。

第九个特色是 **可复现、可审计、可追踪**。NeoResearch 会记录每次实验的配置、随机种子、数据划分、模型版本、训练日志和关键决策过程。这样用户不仅知道“哪个结果最好”，还知道“为什么这样做”“中间尝试了什么”“失败原因是什么”“下一步还能如何改进”。这对于科研场景尤其重要。

第十个特色是 **面向 Time Series Forecasting 的专门优化**。NeoResearch 首先在时间序列预测领域实例化，因此它不是通用 LLM Agent 的简单包装，而是内置了大量面向时序预测的任务理解、数据诊断、模型设计和实验评估能力。它可以更好地处理预测窗口、历史窗口、周期性、趋势变化、非平稳性、分布漂移、多变量关系和长期预测误差等 TSF 特有问题。

## 研究背景~NeoResearch 拟解决的痛点问题

当前数据科学研究与工程实践仍然高度依赖人工经验。尤其在 Time Series Forecasting 场景中，一个高质量预测模型的构建通常需要经历任务理解、数据清洗、统计诊断、特征工程、模型选择、参数调优、实验对比、结果解释和报告整理等多个环节。虽然已有 AutoML、AutoTS 和大模型辅助编程工具能够在部分环节提升效率，但它们大多仍停留在“自动调参”“自动选模”或“代码生成”的层面，缺少对完整研究流程的自主组织、持续反思和结果交付能力。因此，真实数据科学任务中仍然存在若干关键痛点。

**第一，领域数据科学建模过程复杂，人工试错成本高。**
在真实时序预测任务中，工程师往往需要反复分析数据特征、调整输入窗口、选择模型结构、设计训练策略和比较实验结果。这个过程高度依赖研究者经验，也需要大量脚本编写和重复实验。对于电力负荷、云服务流量、工业传感器、气象环境、医疗监测等领域，不同数据具有不同的趋势、周期、噪声、非平稳性和分布漂移特征。单一固定流程很难直接适配多样化场景，导致模型开发周期长、迁移成本高、经验难以复用。

**第二，现有自动化建模工具偏重模型搜索，缺少数据理解与研究推理。**
传统 AutoML 或 AutoTS 工具通常将问题简化为候选模型选择、超参数搜索和指标优化。这种方式能够提升局部效率，但较少回答更深层的问题：数据为什么难预测，哪些因素影响模型表现，当前模型失败的原因是什么，下一步应该如何调整实验方案。对于 Time Series Forecasting 来说，数据诊断和建模假设往往比盲目搜索更重要。缺少数据理解和研究推理，会使自动化系统容易陷入黑箱调参，难以形成可信的建模决策。

**第三，大模型工具具备代码生成能力，但缺少面向数据科学研究的执行闭环。**
现有 LLM Coding Agent 可以帮助用户写代码、修改脚本和解释报错，但数据科学研究并不只是写代码。它还需要维护长期实验状态、管理数据版本、保存模型配置、执行训练流程、分析实验结果、记录失败原因，并在多轮迭代中形成可复现结论。如果缺少专门的 Agent Runtime 和 Harness Engineering 设计，大模型容易停留在“对话建议”或“局部代码辅助”层面，难以稳定完成长程、复杂、可追踪的数据科学研究任务。

**第四，时序小模型设计缺少面向任务和数据特征的自动化生产机制。**
在很多实际场景中，用户并不一定需要一个通用大模型，而是需要一个能够适配具体数据、具体约束和具体部署环境的轻量化小模型。例如工业现场可能要求模型推理速度快，云服务预测可能要求快速更新，能源预测可能强调周期建模和稳定性，医疗时序任务可能强调可靠性和可解释性。当前小模型设计仍然高度依赖人工经验，缺少一个能够根据数据特征和任务需求自动设计、训练、评估和发布专用模型的 Model Factory。

**第五，实验过程难以复现，研究产物交付不完整。**
很多自动化实验系统只输出最终指标或最优模型，但没有系统保存完整实验过程。用户往往难以追溯某个模型为什么被选择，某次实验为什么失败，参数如何设置，数据如何切分，训练日志和中间结果在哪里。对于科研和工程交付来说，结果本身并不够，用户还需要代码、参数、配置、日志、图表、实验记录和标准化报告。缺少结果发布与过程审计能力，会降低系统在科研复现、项目汇报和工程落地中的可用性。

**第六，人机交互方式单一，难以兼顾自动化效率与用户可控性。**
不同用户对自动化程度的需求并不相同。有些用户希望在任务开始时把目标和约束说明清楚，之后让系统尽可能自主完成；有些用户则希望在数据诊断、模型设计、实验反思和结果发布等关键节点持续参与判断。现有系统通常缺少灵活的人机协同机制，要么过度自动化导致用户难以掌控，要么过度依赖人工确认导致自动化效率不足。因此，需要一种能够在“自主执行”和“人类可控”之间灵活切换的交互模式。

------

## NeoResearch 的研发 Motivation

NeoResearch 的研发动机来自一个核心判断：**未来的数据科学研究不应只是由人类手动组织工具、编写代码和反复试错，而应逐步走向由智能体驱动的自主研究闭环。** 在这一范式下，AI 不再只是回答问题或生成代码，而是能够进入真实研究环境，理解任务目标，诊断数据特征，设计模型方案，执行实验流程，分析失败原因，并将最终成果整理为可复现的研究交付包。

对于 Time Series Forecasting 领域，这一需求尤为突出。时序预测任务广泛存在于电力能源、工业制造、交通物流、云计算、气象环境、金融经济和医疗健康等场景中。不同领域的时序数据具有显著差异，模型设计往往需要结合趋势、周期、异常、噪声、非平稳性、分布漂移和外部情境变量等多种因素。传统方法依赖人工经验进行建模，已有自动化方法又难以充分理解数据和任务语境。因此，构建一个面向时序预测的 autonomous research agent，可以为数据科学自动化提供一个具有代表性的验证场景。

NeoResearch 希望解决的不是单点工具效率问题，而是完整研究流程的自动化问题。它将数据科学任务组织为一个长程可执行工作流，并通过 Harness Engineering 构建 Agent Runtime。系统以文件系统作为长期记忆，保存需求、数据诊断、模型配方、实验配置、训练日志、评估结果和反思记录；以 Skills 封装可复用的数据科学能力；以 Planning / To-do Lists 管理复杂任务进度；以 Sub-agents 实现角色分工；以 MCP / Action 工具连接真实执行环境；以 Session and Context Management 保持长程研究状态的连续性。通过这些机制，NeoResearch 能够从“会说的数据科学助手”升级为“会做的数据科学研究智能体”。

从产品使用角度看，NeoResearch 的 Motivation 是降低领域数据挖掘工程师构建高质量时序模型的门槛。用户不需要从零开始组织建模流程，而是可以通过自然语言描述任务目标和约束，由系统引导完成需求澄清，并自动开展数据诊断、模型设计、实验执行和结果发布。这样可以显著减少重复性工作，让工程师将更多精力投入到领域知识理解、业务目标定义和结果决策分析中。

从 Agentic AI 生态角度看，NeoResearch 的 Motivation 是构建一个面向数据科学任务的 **Model Factory**。未来的智能体不应只会调用已有模型，也应能够根据任务需求和数据分布按需创造模型。NeoResearch 可以为上层 Agent 自动生成专用小模型，并提供模型代码、训练参数、实验报告和调用接口。这样，Agent 可以从“使用模型”进一步走向“生产模型”，从而形成更加自主、可扩展和可持续演化的智能体生态。

因此，NeoResearch 的核心研发目标可以概括为：

> **NeoResearch 致力于构建一个面向 Data Science 的自主研究智能体系统，通过任务理解、数据诊断、模型设计、实验执行、反思优化和结果发布，推动数据科学研究从人工经验驱动走向智能体自主研究闭环。当前系统首先在 Time Series Forecasting 领域实例化验证，重点探索智能体如何帮助领域工程师迭代和设计时序小模型，并进一步作为 Model Factory 服务于更广义的 Agentic AI 系统。**

更凝练的 Motivation 表述可以写成：

> **NeoResearch 的研发动机在于，让数据科学研究从“人类手动试错”走向“智能体自主探索”，从“单点工具辅助”走向“完整研究闭环”，从“调用已有模型”走向“按需生产模型”。它希望通过先进的 Agent Runtime 和 Harness Engineering 设计，构建一个能够理解任务、诊断数据、设计模型、执行实验、反思优化和发布成果的自主研究智能体，为 Time Series Forecasting 小模型研发和未来 Agentic AI 生态提供基础设施。**

## NeoResearch定位

> **NeoResearch 将 Data Science 重新表述为一个自主研究闭环：智能体不再只是执行固定建模流程，而是在任务理解、数据诊断、模型构建、实验执行和反思优化之间持续交互，从而实现面向真实数据科学任务的自主研究能力。**

> **NeoResearch（智多星）是一个面向 Data Science 的自主研究智能体系统，旨在通过意图理解、数据分析、模型构建、实验执行、结果反思与持续优化，实现数据科学研究流程的自主化与自动化。当前系统首先在 Time Series Forecasting 领域进行实例化验证，探索智能体如何从数据与任务需求出发，自主构建、评估并迭代高质量预测模型。**

> **NeoResearch（智多星）是一个面向 Data Science 的自主研究智能体系统。它能够围绕用户给定的数据科学任务，完成任务理解、数据诊断、模型构建、实验执行、反思优化与结果发布，并首先在 Time Series Forecasting 领域进行实例化验证。通过结果发布 Agent，NeoResearch 能够将自主设计的小模型、训练参数、实验结果和研究过程整理为标准化交付包，从而实现从自动建模到可复现研究产出的完整闭环。**

## NeoResearch工作流

**第一，Intent understanding：任务意图理解。**
 该模块负责将用户的自然语言需求转化为结构化的数据科学任务描述。对于 TSF，它需要明确预测对象、输入变量、预测步长、历史窗口、评价指标、业务目标、计算预算、可解释性需求和部署约束。这个模块的价值在于避免系统一开始就盲目建模，而是先把“要解决什么问题”讲清楚。

**第二，Data diagnosis：数据诊断与研究假设生成。**
 该模块负责对数据进行自动理解，包括时序统计特征、趋势周期结构、噪声水平、非平稳性、异常点、缺失模式、协变量有效性、跨变量关系和数据切分合理性等。更重要的是，它不仅输出 EDA 结果，还要形成建模假设，例如“该数据具有明显周期性，适合引入频域特征”“该数据存在漂移，需要使用自适应建模策略”“外部变量可能对预测有帮助，需要做协变量融合”。

**第三，Model recipe generation：模型方案生成。**
 NeoResearch 不应只从已有模型列表中选择模型，而应根据数据诊断结果生成“模型配方”。这个配方可以包括输入处理方式、特征工程策略、模型主干、损失函数、训练策略、验证方式和推理策略。对于 TSF，可以生成类似 PatchTST、iTransformer、TimesNet、N-BEATS、Chronos-style model、VAE-Transformer、Flow-based model 或 hybrid model 的候选方案，也可以组合成新的小模型结构。

**第四，Experiment execution：实验执行与结果管理。**
 该模块负责自动运行实验、记录配置、保存日志、整理结果，并生成可复现的实验报告。这里需要一个清晰的 experiment harness，包括数据版本、模型配置、随机种子、评价指标、训练日志和错误栈信息。这个部分是 NeoResearch 从“聊天式智能体”走向“真正可用研究系统”的关键。

**第五，Reflection and refinement：反思与迭代优化。**
 这是 NeoResearch 与普通 AutoML 的重要区别。系统不只是报告哪个模型表现最好，而是要解释为什么失败、为什么提升、下一步应该如何改。比如模型欠拟合时调整容量，过拟合时增强正则或数据增强，长期预测误差大时改进多步预测策略，分布漂移明显时引入自适应机制。这个模块体现 autonomous research agent 的“研究思维”。

**第六，Knowledge and skill memory：知识与技能记忆。**
 NeoResearch 应该逐步沉淀模型经验、数据集经验、失败案例和可复用技能。比如“电力负荷数据通常需要考虑日周期和周周期”“高噪声小数据集不适合过深模型”“强季节数据可以先尝试 decomposition-based architecture”。这部分可以让系统从单次自动化工具升级为可持续进化的研究智能体。

在 Time Series Forecasting 场景中，NeoResearch 可以围绕如下闭环展开：

用户首先提供<u>**预测任务、数据集、应用背景和约束条件**</u>；

Intent Agent 通过交互理解任务目标、预测窗口、评价指标、业务约束和领域知识，并形成结构化任务说明；

Data Analysis Agent 对时间序列数据进行**<u>定量和定性分析</u>**，包括趋势、周期性、异常值、非平稳性、缺失值、分布漂移和变量相关性等；

Model Design Agent 根据数据诊断结果生成候选模型方案，例如统计模型、机器学习模型、深度学习模型、基础模型或混合模型；

Experiment Agent 负责训练、评估和对比；

Reflection Agent 分析失败原因、性能瓶颈和可改进方向；

Optimization Agent 根据反馈继续调整特征、模型结构、训练策略或实验设计，形成可持续迭代的研究循环。

Result Publishing Agent **负责将 NeoResearch 自主探索得到的小模型、训练参数、实验日志、评估结果、消融分析和过程记录，整理为标准化、可复现、可审计的研究交付包。该模块使 NeoResearch 不仅能够自主完成模型设计与实验迭代，还能够自动生成面向研究复现、项目汇报和开源发布的完整实验报告。**

> **意图理解 → 数据诊断 → 模型设计 → 实验执行 → 反思优化 → 结果发布**

其中“结果发布”是最后一公里。它将前面所有 agent 的过程性产物整合起来，形成结构化输出。

在完成模型探索与实验优化后，NeoResearch 进一步引入结果发布 Agent。该智能体面向研究成果交付，自动整理自主设计的小模型代码、训练好的模型参数、实验配置、运行日志、评估结果和关键决策过程，并生成标准化实验报告。通过该模块，NeoResearch 能够将一次自动化实验转化为可复现、可审计、可传播的研究成果，从而形成从问题理解到成果发布的完整自主研究闭环。

具体来说，结果发布 Agent 可以负责六类产物。

第一类是 **模型代码包**。它需要整理自主设计的小模型代码，包括模型结构、数据加载、训练脚本、评估脚本和推理脚本。这里最好要求代码具有统一接口，例如 `model.py`、`train.py`、`evaluate.py`、`predict.py`、`config.yaml`，便于后续复现和迁移。

第二类是 **训练参数与模型权重**。它需要保存最优模型参数、训练配置、超参数设置、随机种子、训练轮数、优化器、学习率策略、数据划分方式等。这样可以避免只给出结果而无法复现实验。

第三类是 **实验结果汇总**。它需要整理不同模型、不同配置、不同实验轮次的结果，包括主实验、对比实验、消融实验和鲁棒性实验。对于 Time Series Forecasting，可以重点输出 MAE、MSE、RMSE、MAPE、SMAPE 等指标，但报告中不必机械罗列所有指标，而应突出整体趋势和关键发现。

第四类是 **实验过程记录**。这是 autonomous research agent 的特色。结果发布 Agent 不只是输出最终结果，还应记录系统如何做出关键决策。例如为什么选择某个模型结构，为什么调整窗口长度，为什么引入某种特征，为什么放弃某些失败配置。这部分可以形成一种“research trace”，体现智能体的研究过程。

第五类是 **结果解释与失败分析**。它需要总结模型在哪些预测场景表现较好，在哪些场景存在不足，可能原因是什么，下一步可以如何改进。对于 TSF，这部分可以分析模型对趋势、周期、突变、异常点、分布漂移和长期预测的适应情况。

第六类是 **标准化实验报告**。最终输出可以是一个 Markdown、PDF 或网页形式的报告，内容包括任务背景、数据描述、方法设计、实验设置、结果分析、模型产物、复现说明和后续建议。

最终输出的目录结构可以设计成这样：

```
neoresearch_output/
├── report/
│   ├── experiment_report.md
│   ├── experiment_report.pdf
│   └── figures/
├── model/
│   ├── model.py
│   ├── config.yaml
│   └── checkpoint.pt
├── scripts/
│   ├── train.py
│   ├── evaluate.py
│   └── predict.py
├── results/
│   ├── metrics.csv
│   ├── ablation_results.csv
│   └── prediction_outputs.csv
├── logs/
│   ├── training_log.txt
│   ├── agent_trace.json
│   └── experiment_history.json
└── README.md
```

这里最有研究价值的是 `agent_trace.json` 和 `experiment_history.json`。它们可以记录 NeoResearch 的自主研究轨迹，包括每一步做了什么、为什么做、依据是什么、结果如何、下一步如何调整。这可以让 NeoResearch 与普通 AutoML 系统明显区分开来。

**NeoResearch 的目标不是只生成一个预测结果，而是生成一个可复现的研究对象。结果发布 Agent 将模型、参数、实验、日志和推理过程统一封装，使自主研究过程从“黑箱自动化”走向“可审计的研究自动化”。**

## NeoResearch交互模式

> **为适配不同数据科学任务的复杂度与用户参与需求，NeoResearch 设计了两种交互模式。苏格拉底式模式通过前置式引导提问充分澄清任务目标和研究约束，使系统能够在较少人工干预下自主完成后续研究流程。认知伴随式模式则在自主研究过程中引入关键节点的人类确认机制，使用户能够持续参与数据诊断、模型设计、实验反思和结果发布等重要环节。通过这两种模式，NeoResearch 在自动化效率与人类可控性之间建立了灵活平衡，为复杂数据科学任务提供更加可信、可解释和可协同的自主研究范式。**

NeoResearch 提供两种交互模式：**苏格拉底式模式**与**认知伴随式模式**。二者共同目标是降低用户使用数据科学智能体的门槛，同时保证研究过程的可控性、可解释性和可复现性。

**苏格拉底式模式**强调<u>前置式意图澄清</u>。系统在任务开始阶段通过一系列引导式问题，帮助用户明确数据科学任务的目标、数据属性、预测对象、预测窗口、评价指标、业务约束、领域知识和期望输出。一旦任务边界被充分澄清，NeoResearch 将尽可能自主完成后续流程，包括数据诊断、模型设计、实验执行、反思优化和结果发布。该模式适合目标较清晰、用户希望减少中途干预的场景。

**认知伴随式模式**强调<u>持续式人机协同</u>。系统同样会在前期完成任务理解和约束澄清，但在关键研究节点主动向用户汇报阶段性发现，并请求用户确认或修正。例如，在数据诊断后确认建模假设，在模型设计后确认候选方案，在实验失败后确认调整方向，在结果发布前确认报告重点。该模式适合高价值、高不确定性或领域知识较强的任务，能够将用户的专业判断融入智能体的研究过程。

> **苏格拉底式模式强调“前期深度澄清，后续自主执行”；认知伴随式模式强调“全程阶段协同，关键节点共决策”。**

放入系统架构中，可以这样描述：

| 交互模式       | 核心特点                   | 适用场景                           | 人类参与方式         |
| -------------- | -------------------------- | ---------------------------------- | -------------------- |
| 苏格拉底式模式 | 前期充分提问，后续自主执行 | 目标较明确、用户希望自动完成       | 主要参与任务启动阶段 |
| 认知伴随式模式 | 阶段性汇报，关键节点确认   | 高价值、高不确定性、强领域知识任务 | 持续参与关键决策节点 |

这两个模式也能强化 NeoResearch 的研究 claim。它说明 NeoResearch 不是一个完全黑箱的自动化工具，而是一个可以根据用户需求在 **自主性** 与 **可控性** 之间调节的人机协同研究系统。

> **双模式人机协同机制：从苏格拉底式意图澄清到认知伴随式研究共创。**

## 关键技术原理

> **NeoResearch 不是简单调用大模型完成若干数据科学步骤，而是基于 Harness Engineering 构建面向数据科学研究的 Agent Runtime。该 Runtime 将文件系统记忆、技能机制、子智能体协作、任务规划、工具调用与上下文管理统一组织起来，使智能体能够在真实研究环境中持续感知、执行、反思和迭代。**

| Runtime 组件                       | 在 NeoResearch 中的作用              | TSF 场景中的实例                                             |
| ---------------------------------- | ------------------------------------ | ------------------------------------------------------------ |
| **File Systems as Memory**         | 将文件系统作为长期记忆与研究状态载体 | 保存数据诊断报告、实验配置、模型代码、训练日志、评估结果、agent trace |
| **Skills**                         | 将可复用研究能力封装为技能           | 时序平稳性检测、频域分析、异常检测、模型训练、结果可视化、报告生成 |
| **Planning / To-do Lists**         | 将复杂研究任务拆解为可执行步骤       | 任务澄清 → 数据分析 → 模型设计 → 实验训练 → 反思优化 → 结果发布 |
| **Action / MCP Tools**             | 提供可执行工具接口                   | 读写文件、运行 Python、训练模型、调用评估脚本、生成图表、管理实验结果 |
| **Session and Context Management** | 管理长程研究上下文，避免上下文污染   | 记录当前任务目标、已完成步骤、失败实验、下一步计划           |
| **Sub-agents / Agent Teams**       | 通过角色分工提升复杂任务处理能力     | Intent Agent、Data Diagnosis Agent、Model Design Agent、Experiment Agent、Reflection Agent、Result Publishing Agent |

这里最重要的 insight 是：**NeoResearch 的能力不只来自大模型本身，而来自大模型被放入一个可执行、可记忆、可验证、可复用的研究 Runtime 中。

> **NeoResearch 的核心并不是让 LLM 直接“想出一个模型”，而是为 LLM 构建一个可执行的研究环境，使其能够通过文件记忆保存状态，通过 Skills 复用专业能力，通过 Planning 管理长程任务，通过 Sub-agents 完成角色分工，通过工具调用执行实验，并通过上下文管理持续推进研究过程。**

**第一，Memory layer：文件系统记忆层。**
 NeoResearch 可以将所有研究过程写入文件系统，例如 `intent.md`、`data_diagnosis.md`、`model_recipe.yaml`、`experiment_plan.md`、`results.csv`、`reflection.md`、`final_report.md`。这样文件系统不只是存储空间，而是 Agent 的长期工作记忆。它使 NeoResearch 能够跨轮次、跨实验、跨任务保持研究状态。

**第二，Skill layer：研究技能层。**
 Skills 可以封装数据科学研究中的可复用能力。对于 TSF，可以包括数据清洗技能、统计诊断技能、频域分析技能、特征工程技能、模型训练技能、超参数搜索技能、结果可视化技能、误差分析技能和实验报告生成技能。这样 NeoResearch 不需要每次从零生成代码，而是可以调用稳定、可审计、可复用的研究能力。

**第三，Planning layer：任务规划层。**
 Planning / To-do Lists 负责将复杂研究任务拆解成可跟踪、可执行、可检查的步骤。它不仅记录“要做什么”，还记录每一步的输入、输出、状态、失败原因和下一步计划。对于 autonomous research agent，这个层很关键，因为它决定系统能否处理长程、多阶段、不确定的研究任务。

**第四，Tool/action layer：工具执行层。**
 这一层通过 MCP 或本地工具接口连接真实环境，包括文件读写、代码执行、模型训练、实验评估、日志解析、图表生成和报告导出。它使 NeoResearch 从“生成建议”走向“执行研究”。这里可以强调，工具调用不是附加能力，而是 Agent Runtime 的核心行动接口。

**第五，Session and context layer：会话与上下文治理层。**
 NeoResearch 的任务往往很长，涉及多轮实验和大量中间结果。如果没有上下文治理，很容易出现信息遗漏、历史污染和错误累积。因此系统需要维护 session state、任务摘要、关键决策记录和上下文压缩机制。它可以类似 Claude Code 的 `/compact` 思路，将长程历史压缩成结构化研究状态。

**第六，Agent team layer：子智能体协作层。**
 NeoResearch 可以通过多个角色化子智能体协作完成研究流程。例如 Intent Agent 负责需求澄清，Data Diagnosis Agent 负责数据分析，Model Design Agent 负责模型方案生成，Experiment Agent 负责训练和评估，Reflection Agent 负责失败归因与下一轮优化，Result Publishing Agent 负责整理代码、权重、结果和报告。这样系统不是单体 Agent，而是一个面向数据科学研究的 agent team。

> **NeoResearch 采用基于 Harness Engineering 的 Agent Runtime，将数据科学研究组织为一个长程可执行工作流。该 Runtime 以文件系统作为持久化记忆，以 Skills 作为可复用研究能力，以 Planning/To-do Lists 作为任务控制机制，以 MCP 工具作为行动接口，以 Session and Context Management 作为上下文治理机制，并通过 Sub-agents 实现角色化协作。**

> **Memory 保存研究状态，Skills 提供可复用能力，Planning 管理长程任务，Tools 执行真实操作，Context 保证过程连续与可控，Sub-agents 实现复杂研究流程的角色分工。**



## 上下文管理

在 NeoResearch 中，最合理的设计是让每个 Agent 都有自己的私有上下文，只在需要时读取共享工作区中的标准化文件。例如 IntentScope Agent 负责生成 `task_spec.yaml` 和 `intent.md`；DataDiagnoser Agent 只需要读取任务说明和数据元信息，不需要看到 IntentScope 的全部对话过程；HypoPlanner Agent 读取 `task_spec.yaml`、`data_diagnosis_report.md` 和 `literature_review.md`，然后生成 `hypotheses.md` 和 `experiment_plan.md`；ModelDesigner Agent 再根据这些结构化产物生成 `model_recipe.yaml`。这样，每个 Agent 都有清晰输入和输出，系统不会因为上下文过长或信息混杂而失控。

一个比较理想的设计是：

| 层次                        | 是否共享   | 作用                                                     |
| --------------------------- | ---------- | -------------------------------------------------------- |
| **Project Workspace**       | 共享       | 保存任务说明、诊断报告、实验计划、模型代码、结果、报告等 |
| **Agent Private Context**   | 隔离       | 保存每个 Agent 自己的临时推理、局部任务状态和执行细节    |
| **Handoff Artifacts**       | 有选择共享 | 通过标准文件把上一个 Agent 的关键结论传给下一个 Agent    |
| **Runtime State**           | 共享但受控 | 保存任务进度、To-do List、当前阶段、失败状态和下一步计划 |
| **Raw Logs / Full History** | 默认不共享 | 仅在需要调试或反思时按需读取，避免污染上下文             |

因此，NeoResearch 的上下文机制可以设计成三类。

第一类是 **全局共享上下文**，也就是所有 Agent 都可以读取的核心任务状态。它包括用户目标、数据路径、任务类型、预测窗口、评价指标、计算约束、交互模式、当前任务阶段和最终输出要求。这部分可以保存在 `project_state.yaml`、`task_spec.yaml` 或 `research_brief.md` 中。它是整个系统的共同任务边界。

第二类是 **阶段性共享产物**，也就是 Agent 之间交接时使用的文件。例如 DataDiagnoser Agent 输出 `data_diagnosis_report.md`，HypoPlanner Agent 输出 `hypotheses.md` 和 `experiment_plan.md`，ModelDesigner Agent 输出 `model_recipe.yaml`，TrainEval Agent 输出 `metrics.csv` 和 `training_log_summary.md`，Reflector Agent 输出 `reflection.md`，ResultPublisher Agent 最后生成 `final_report.md`。这些文件是 Agent 间协作的主要媒介。

第三类是 **Agent 私有上下文**，也就是每个 Agent 在执行任务时的局部上下文。例如 DataDiagnoser Agent 的统计分析细节、ModelDesigner Agent 的候选结构草案、TrainEval Agent 的临时错误栈、Reflector Agent 的局部失败归因过程等。这些内容不应默认暴露给所有 Agent，而应经过压缩、筛选和结构化后再写入共享工作区。

可以将 NeoResearch 的 Context 设计成如下形式：

```
neoresearch_workspace/
├── project_state.yaml              # 全局任务状态，所有 Agent 可读
├── task_spec.yaml                   # IntentScope 输出的结构化任务说明
├── intent.md                        # 用户需求与约束总结
├── literature/
│   ├── literature_review.md
│   └── knowledge_cards.json
├── data_diagnosis/
│   ├── quant_diagnosis.md
│   ├── qual_diagnosis.md
│   ├── modeling_risks.md
│   └── data_diagnosis_report.md
├── planning/
│   ├── hypotheses.md
│   ├── experiment_plan.md
│   └── research_todo.md
├── model_design/
│   ├── model_recipe.yaml
│   └── model_design_rationale.md
├── experiments/
│   ├── configs/
│   ├── logs/
│   ├── metrics.csv
│   └── training_log_summary.md
├── reflection/
│   └── reflection.md
└── release/
    ├── final_report.md
    ├── README.md
    └── artifact_manifest.json
```

在这个设计中，**文件系统就是共享记忆**，但共享记忆不是杂乱的聊天记录，而是结构化的研究产物。每个 Agent 进入工作时，只读取自己需要的文件。例如：

| Agent                     | 主要读取                                                     | 主要写入                                                  |
| ------------------------- | ------------------------------------------------------------ | --------------------------------------------------------- |
| **IntentScope Agent**     | 用户输入、交互记录                                           | `task_spec.yaml`、`intent.md`                             |
| **DataDiagnoser Agent**   | `task_spec.yaml`、数据文件、数据元信息                       | `data_diagnosis_report.md`、`modeling_risks.md`           |
| **HypoPlanner Agent**     | `task_spec.yaml`、`literature_review.md`、`data_diagnosis_report.md` | `hypotheses.md`、`experiment_plan.md`、`research_todo.md` |
| **ModelDesigner Agent**   | `hypotheses.md`、`experiment_plan.md`、`data_diagnosis_report.md` | `model_recipe.yaml`、模型代码草案                         |
| **TrainEval Agent**       | `model_recipe.yaml`、数据配置、实验计划                      | `metrics.csv`、训练日志、checkpoint                       |
| **Reflector Agent**       | `metrics.csv`、`training_log_summary.md`、`experiment_plan.md` | `reflection.md`、下一轮改进建议                           |
| **ResultPublisher Agent** | 全部关键产物的摘要和 manifest                                | `final_report.md`、`README.md`、发布包                    |

这样做有几个好处。

第一，**避免上下文污染**。如果所有 Agent 都共享完整历史，ModelDesigner Agent 可能被早期不成熟想法影响，TrainEval Agent 可能被无关文献细节干扰，ResultPublisher Agent 也可能把失败的临时方案误写进报告。上下文隔离可以让每个 Agent 专注于自己的职责。

第二，**降低 token 成本和长上下文风险**。自主研究任务通常很长，包含数据分析、代码、日志、图表、实验结果和多轮反思。如果全部上下文一直放在 prompt 中，成本会很高，也容易出现遗漏和冲突。结构化文件交接可以显著降低运行成本。

第三，**增强可复现性和可审计性**。如果 Agent 之间靠文件交接，那么系统每一步都有明确输入和输出。后续可以追踪：某个模型设计来自哪个假设，某个假设来自哪些数据诊断和文献证据，某次实验失败后 Reflector 做了什么修正。这对科研系统非常重要。

第四，**便于多 Agent 并行和模块替换**。如果上下文完全共享，Agent 之间会强耦合；如果使用标准化 artifact 交接，就可以替换某个 Agent。例如未来可以把 ModelDesigner Agent 替换成更强的模型生成器，而不影响前后的 IntentScope、HypoPlanner 和 TrainEval。

第五，**更符合“大胆假设，小心求证”的科研逻辑**。HypoPlanner Agent 提出假设之后，后续 ModelDesigner 和 TrainEval 只需要围绕这些假设做验证。Reflector 再根据实验结果判断假设是否成立。这样上下文流动是有方向、有证据链的，而不是所有信息混在一起。

所以，我建议 NeoResearch Runtime 采用下面这个原则：

> **Centralized memory, decentralized cognition, explicit handoff.**

中文可以写成：

> **中心化记忆，分布式认知，显式化交接。**

也就是说，NeoResearch 有一个统一的共享工作区作为长期记忆，但每个 Agent 的认知过程相对隔离。Agent 之间通过结构化文件、任务状态和 handoff summary 进行协作，而不是共享完整上下文。

更进一步，可以为每次 Agent 交接设计一个统一的 **Context Capsule**，也就是上下文胶囊。它不是完整历史，而是下一个 Agent 执行任务所需的最小充分上下文。例如：

```
task_id: "tsf_energy_001"
current_stage: "hypothesis_planning"
input_artifacts:
  - task_spec.yaml
  - literature_review.md
  - data_diagnosis_report.md
key_findings:
  - "The series shows strong daily and weekly seasonality."
  - "Distribution shift is observed in the test period."
  - "External temperature may be useful as a covariate."
constraints:
  - "Model should be lightweight."
  - "Prediction horizon is 24 steps."
expected_output:
  - hypotheses.md
  - experiment_plan.md
  - research_todo.md
```

这样每个 Agent 接收到的是一个“任务包”，而不是所有历史。这个设计非常适合 NeoResearch 的 Agent Runtime。

> **NeoResearch 采用混合式上下文架构。各 Agent 不共享完整对话历史，而是在相互隔离的私有上下文中执行任务，并通过共享文件系统记忆、结构化研究产物和显式交接胶囊进行协作。该设计能够减少上下文污染，提升可复现性，并支撑长程自主研究工作流。**

# Agent Runtime

## 1. Workflow orchestration：不要只是 Agent 串联，而要有状态机

NeoResearch 不应让 Agent 自由聊天式地依次调用，而应设计一个明确的 workflow controller。每个阶段都应该有状态、输入、输出、完成条件和失败处理机制。

例如：

> IntentScope → LiteratureSearch → DataDiagnoser → HypoPlanner → ModelDesigner → TrainEval → Reflector → ResultPublisher

这条链路应该由 Runtime 调度，而不是靠 prompt 自发推进。每个 Agent 完成后，Runtime 检查其输出是否合格，再决定进入下一阶段、重试、回滚，还是请求用户确认。

可以设计一个 `project_state.yaml`：

```
task_id: "tsf_energy_001"
current_stage: "data_diagnosis"
status: "running"
interaction_mode: "cognitive_copilot"
completed_stages:
  - intent_scope
pending_stages:
  - data_diagnosis
  - hypothesis_planning
  - model_design
  - train_eval
  - reflection
  - result_publish
```

这样 NeoResearch 才能从“多 Agent 对话”变成“可控的研究流程”。

## 2. Artifact protocol：每个 Agent 都要有标准输入输出协议

这是最关键的工程设计之一。每个 Agent 不能随意输出一段自然语言，而要输出标准化 artifact。否则后续 Agent 很难稳定接上。

例如：

| Agent           | 输入                 | 输出                                             |
| --------------- | -------------------- | ------------------------------------------------ |
| IntentScope     | 用户需求、交互记录   | `task_spec.yaml`、`intent.md`                    |
| DataDiagnoser   | 数据、任务说明       | `data_diagnosis_report.md`、`data_profile.json`  |
| HypoPlanner     | 任务、文献、数据诊断 | `hypotheses.md`、`experiment_plan.yaml`          |
| ModelDesigner   | 假设与实验计划       | `model_recipe.yaml`、`model_code/`               |
| TrainEval       | 模型配方、数据配置   | `metrics.csv`、`checkpoints/`、`training_log.md` |
| Reflector       | 实验结果、日志       | `reflection.md`、`next_iteration_plan.yaml`      |
| ResultPublisher | 全部关键产物         | `final_report.md`、`artifact_manifest.json`      |

我建议你把 **Artifact Protocol** 作为 NeoResearch Runtime 的核心设计点。它能保证系统可复现、可审计、可扩展。

一句话可以概括为：

> **Agent 之间不直接传递杂乱上下文，而是通过标准化研究产物进行交接。**

## 3. Tool execution layer：工具调用要可控、可审计、可恢复

NeoResearch 需要大量真实执行动作，包括读取数据、运行统计分析、生成模型代码、训练模型、评估指标、绘图、保存 checkpoint、生成报告等。因此 Runtime 必须有稳定的 Tool / Action 层。

这里需要注意三点。

第一，工具要有明确接口。例如 `run_training(config)`、`evaluate_model(checkpoint)`、`plot_forecast_result(result_file)`，而不是让 Agent 每次临时写脚本。

第二，工具调用要有权限边界。例如删除文件、覆盖 checkpoint、启动大规模训练、访问外部网络、发布结果等操作，应该需要 Runtime 审核或用户确认。

第三，工具执行要有日志。每一次 tool call 都要记录输入、输出、耗时、错误、生成文件和对应 Agent。

这部分可以叫：

> **Action Runtime / Tool Harness / MCP Tool Layer**

它决定 NeoResearch 是“会说”还是“会做”。

## 4. Experiment harness：实验必须可复现

NeoResearch 的核心场景是 Data Science，尤其是 Time Series Forecasting，因此实验复现能力非常重要。Runtime 必须管理实验生命周期，而不能只让 Agent 生成代码后随便跑。

需要记录：

```
数据版本
数据切分方式
预测窗口
历史窗口
模型配置
训练超参数
随机种子
运行环境
评价指标
训练日志
模型 checkpoint
预测结果
实验结论
```

建议每次实验都有唯一 `run_id`：

```
experiments/
├── run_001_baseline/
│   ├── config.yaml
│   ├── metrics.csv
│   ├── training.log
│   ├── checkpoint.pt
│   └── summary.md
├── run_002_multiscale/
│   ├── config.yaml
│   ├── metrics.csv
│   ├── training.log
│   ├── checkpoint.pt
│   └── summary.md
```

这样 Reflector Agent 才能真正分析“哪次实验为什么好，哪次实验为什么失败”。

## 5. Verification layer：每个阶段都要有 Verifier

NeoResearch 不能只相信 Agent 输出。每个关键阶段都应该有 Verifier 进行检查。

例如：

| 阶段            | 需要验证什么                             |
| --------------- | ---------------------------------------- |
| IntentScope     | 任务目标、预测窗口、指标、约束是否完整   |
| DataDiagnoser   | 数据统计是否正确，是否存在数据泄漏       |
| HypoPlanner     | 假设是否可验证，实验计划是否可执行       |
| ModelDesigner   | 模型代码是否能运行，输入输出维度是否匹配 |
| TrainEval       | 指标计算是否正确，训练过程是否异常       |
| Reflector       | 反思是否基于证据，是否过度解释           |
| ResultPublisher | 报告是否包含代码、参数、结果和复现说明   |

这个设计非常重要。因为 autonomous research agent 最大的问题之一是“看起来很合理，但实际不可执行或不可复现”。Verifier 可以把系统从“语言生成”拉回“证据闭环”。

可以形成一个核心原则：

> **No artifact should enter the next stage without verification.**

中文可以写成：

> **任何研究产物在进入下一阶段前，都需要经过结构化验证。**

## 6. Skill registry：Skills 要能注册、检索、测试和复用

你前面提到 NeoResearch 要使用 Skills，这个很好。但 Skills 不能只是 prompt 片段，而应该是 Runtime 中可管理的能力单元。

每个 Skill 最好包含：

```
skill_name: "stationarity_test"
description: "Perform stationarity diagnosis for time series."
inputs:
  - data_path
  - target_column
outputs:
  - stationarity_report.md
  - test_statistics.json
tools:
  - python
  - statsmodels
status: "verified"
```

NeoResearch 可以有这些 Skills：

```
数据清洗 Skill
缺失值分析 Skill
异常检测 Skill
平稳性检验 Skill
周期性分析 Skill
频域分析 Skill
协变量相关性分析 Skill
基线模型训练 Skill
深度模型训练 Skill
误差分析 Skill
报告生成 Skill
```

这样系统会越来越像一个可以成长的 Research Runtime，而不是一次性 Agent Demo。

## 7. Human control：两种交互模式要落实到 Runtime 机制

你设计了“苏格拉底式”和“认知伴随式”两种模式，这需要 Runtime 级支持，而不只是界面选项。

在 **苏格拉底式模式** 下，Runtime 可以只在任务开始阶段要求用户确认，后续大部分自动执行。

在 **认知伴随式模式** 下，Runtime 应该在关键节点暂停并请求用户确认，例如：

```
任务规格确认
数据诊断确认
研究假设确认
模型方案确认
实验预算确认
结果发布确认
```

这可以通过 `approval_required` 实现：

```
stage: "model_design"
approval_required: true
reason: "Multiple model design options are available."
```

这样 NeoResearch 的“人机协同”就不是口号，而是可执行机制。

## 8. Observability：要能看到 Agent 做了什么

NeoResearch 的运行过程会很长。用户和开发者都需要知道系统当前在做什么、做过什么、为什么这么做。

建议 Runtime 记录：

```
Agent 调用轨迹
工具调用轨迹
文件生成轨迹
实验运行轨迹
错误与重试轨迹
关键决策轨迹
用户确认轨迹
```

可以生成一个 `agent_trace.json`：

```
{
  "stage": "hypothesis_planning",
  "agent": "HypoPlanner Agent",
  "input_artifacts": [
    "task_spec.yaml",
    "data_diagnosis_report.md",
    "literature_review.md"
  ],
  "output_artifacts": [
    "hypotheses.md",
    "experiment_plan.yaml"
  ],
  "decision_summary": "Prioritized seasonality modeling and drift adaptation based on diagnosis evidence.",
  "status": "completed"
}
```

这对于科研系统非常关键，因为用户不仅需要结果，还需要知道“研究过程是否可信”。

## 9. Failure recovery：失败恢复和回滚机制

Autonomous research 很容易失败，例如代码运行失败、数据格式错误、模型训练爆炸、GPU 内存不足、指标异常、外部搜索失败等。NeoResearch Runtime 必须支持失败恢复。

可以设计几类策略：

```
自动重试：小错误自动修复后重跑
降级执行：复杂模型失败时退回 baseline
局部回滚：回到上一个稳定 artifact
请求确认：重大失败时询问用户
反思修复：交给 Reflector Agent 分析失败原因
```

这会让 NeoResearch 更稳定，也更像真实产品。

## 10. Cost and resource control：计算预算必须被管理

NeoResearch 面向 TSF 小模型设计，可能会跑很多实验。如果没有预算管理，系统很容易无限探索。

Runtime 需要管理：

```
最大实验次数
最大训练时长
最大 GPU 使用量
最大搜索轮数
最大模型参数量
最大数据采样规模
停止条件
```

例如：

```
budget:
  max_trials: 20
  max_training_hours: 6
  max_model_params: "5M"
  early_stop_patience: 5
  stop_if_no_improvement_rounds: 3
```

这对 Model Factory 特别重要，因为未来 NeoResearch 如果服务于其他 Agent，必须能按预算生产模型。

## 11. Knowledge memory：文献知识和实验经验要沉淀

NeoResearch 不应每次从零开始。Runtime 应该把 Literature Search Agent、DataDiagnoser Agent、Reflector Agent 的知识沉淀下来。

例如：

```
某类数据适合哪些模型
某类失败通常如何修复
某类领域任务常见评价指标
某类时序数据常见周期结构
某个模型在哪些场景表现稳定
```

这可以形成：

```
knowledge_base/
├── paper_cards/
├── dataset_cards/
├── model_cards/
├── experiment_lessons/
└── failure_cases/
```

这样 NeoResearch 会逐步从“单次任务执行器”变成“持续成长的研究智能体”。

## 12. Result release standard：结果发布要有 manifest

ResultPublisher Agent 最终发布的不是一份报告，而是一个完整研究交付包。建议每次发布都生成 `artifact_manifest.json`，记录所有产物。

例如：

```
{
  "task_id": "tsf_energy_001",
  "best_model": "model/checkpoint.pt",
  "model_code": "model/model.py",
  "config": "experiments/run_006/config.yaml",
  "metrics": "experiments/run_006/metrics.csv",
  "report": "release/final_report.md",
  "reproducibility": {
    "seed": 42,
    "dataset_version": "v1",
    "environment": "requirements.txt"
  }
}
```

这会让 NeoResearch 的输出真正可交付、可复现、可审计。

我建议你把 NeoResearch Runtime 的设计原则总结为五句话：

> **第一，Agent 不共享完整上下文，而通过共享工作区和标准化 artifact 协作。**
>  **第二，Workflow 不靠自由对话推进，而由 Runtime 状态机调度。**
>  **第三，所有关键研究产物都需要经过 Verifier 检查后才能进入下一阶段。**
>  **第四，所有实验都必须由 Experiment Harness 管理，保证可复现、可追踪、可回滚。**
>  **第五，NeoResearch 的长期能力来自 Skills、Knowledge Memory 和 Research Trace 的持续积累。**

最终可以形成一个很有辨识度的表述：

> **NeoResearch 的 Agent Runtime 本质上是一个面向数据科学研究的 Harness Engine。它通过工作流编排、文件系统记忆、标准化产物协议、工具执行、实验管理、过程验证、失败恢复和结果发布机制，将多个研究 Agent 组织成一个可执行、可复现、可持续演化的自主研究系统。**

# NeoResearch Harness Engineering

有，而且我觉得 **NeoResearch 的 Harness Engineering 还需要特别注意一个核心点**：不要把 Harness 理解成“给 Agent 接一堆工具”，而要把它理解成 **一套让 Agent 可执行、可约束、可验证、可复现、可演化的研究环境**。

也就是说，NeoResearch 的 Harness 不只是 Runtime 的实现细节，而是整个系统能否从 Demo 变成 Research Infrastructure 的关键。

## 1. Task DSL：把研究任务形式化

NeoResearch 不应只依赖自然语言描述任务。用户需求经过 IntentScope Agent 澄清后，最好转化为一个结构化的 **Task DSL / Task Spec**。例如：

```
task_type: time_series_forecasting
target_column: load
history_window: 96
prediction_horizon: 24
frequency: hourly
metrics:
  - mse
  - mae
constraints:
  max_model_params: 5M
  max_training_hours: 3
  prefer_lightweight_model: true
output:
  report: true
  model_code: true
  checkpoint: true
```

这个 Task Spec 是后续所有 Agent 的“任务合同”。它能减少歧义，也方便 Runtime 检查每个阶段是否偏离目标。

## 2. Environment contract：明确 Agent 能做什么、不能做什么

Harness Engineering 的关键不是“让 Agent 自由行动”，而是给 Agent 一个边界清楚的环境。NeoResearch 应该定义每个 Agent 的权限范围。例如：

IntentScope Agent 可以读用户输入、写任务说明；DataDiagnoser Agent 可以读数据、运行统计诊断，但不能修改原始数据；ModelDesigner Agent 可以生成模型代码，但不能直接启动大规模训练；TrainEval Agent 可以运行实验，但必须受预算约束；ResultPublisher Agent 可以生成报告，但不能自动公开发布，除非用户确认。

这可以形成一个 **Agent Capability Matrix**：

| Agent           | 可读            | 可写         | 可执行       | 需要确认的操作   |
| --------------- | --------------- | ------------ | ------------ | ---------------- |
| IntentScope     | 用户需求        | task spec    | 无           | 任务边界确认     |
| DataDiagnoser   | 数据、task spec | 诊断报告     | 统计工具     | 数据切分策略     |
| HypoPlanner     | 诊断、文献      | 假设、计划   | 无           | 高成本实验计划   |
| ModelDesigner   | 假设、计划      | 模型代码     | 单元测试     | 覆盖已有模型代码 |
| TrainEval       | 模型、数据      | 结果、日志   | 训练评估     | 长时间训练       |
| Reflector       | 结果、日志      | 反思报告     | 少量验证实验 | 大方向调整       |
| ResultPublisher | 全部产物        | 报告、发布包 | 打包导出     | 对外发布         |

这会让 NeoResearch 更安全、更稳定，也更像一个真实产品。

## 3. Dataset and evaluation guardrail：防止数据泄漏和评估污染

这是 TSF 自动研究系统里非常容易忽视的问题。NeoResearch 如果自动切分数据、自动调参、自动反思，很容易出现数据泄漏、验证集过拟合、测试集反复使用等问题。

建议 Runtime 明确区分：

```
train set
validation set
test set
hidden test set
```

并规定：ModelDesigner 和 TrainEval 可以基于训练集和验证集迭代；Reflector 可以看验证结果；最终测试集只能在结果发布前调用有限次数。否则 NeoResearch 很可能“自动优化到测试集”，这在科研上会有风险。

可以设置一个 **Evaluation Firewall**：

> 测试集不是普通工具资源，而是受保护的评估环境。

这对 FutureCast 这类 Benchmark 也很重要。

## 4. Code harness：生成代码必须能测试、能复现、能回滚

ModelDesigner Agent 生成的小模型代码不能直接进入训练阶段。中间应该有 Code Harness：

```
代码生成 → 静态检查 → 单元测试 → 输入输出维度测试 → 小样本 smoke test → 正式训练
```

尤其是 TSF 模型，很容易出现维度错位、窗口切分错误、多变量输入输出不匹配、预测长度不一致等问题。建议每个模型都必须通过：

```
forward shape test
data loader test
loss computation test
one-batch training test
inference output test
```

这样 TrainEval Agent 才不会被大量低级错误拖垮。

## 5. Skill lifecycle：Skill 要有生命周期管理

你前面提到 Skills，这个方向非常对。但 Skills 不应只是“提示词片段”或“脚本集合”。NeoResearch 需要一个 Skill Registry，并管理 Skill 的生命周期：

```
创建 Skill
测试 Skill
验证 Skill
注册 Skill
调用 Skill
更新 Skill
废弃 Skill
```

每个 Skill 最好包含版本号、输入输出协议、依赖库、测试样例、适用场景和失败边界。例如：

```
skill_name: seasonality_diagnosis
version: 0.1.0
inputs:
  - data_path
  - target_column
outputs:
  - seasonality_report.md
  - seasonality_features.json
verified: true
applicable_to:
  - hourly_series
  - daily_series
limitations:
  - unreliable_for_short_series
```

这样 NeoResearch 的能力可以持续积累，而不是每次重新写代码。

## 6. Knowledge hygiene：文献知识和经验记忆要防污染

NeoResearch 具备自主 Search 和读文献能力后，会引入一个新问题：**外部知识不一定可靠，也不一定适用于当前任务**。

Literature Search Agent 不能把所有论文观点都直接注入 ModelDesigner。建议加入知识过滤机制：

```
是否来自可信来源
是否与当前任务相关
是否有实验支撑
是否适合当前数据规模
是否符合当前计算预算
是否只是论文 claim
是否存在相反证据
```

更进一步，可以把知识分成几类：

| 知识类型   | 是否可直接使用 |
| ---------- | -------------- |
| 方法结构   | 可作为候选设计 |
| 实验经验   | 可作为参考     |
| 论文 claim | 需要验证       |
| 数据集结论 | 需判断迁移性   |
| 失败案例   | 可用于规避风险 |

一句话：

> **文献知识不是答案，而是假设来源。**

这和“大胆假设，小心求证”完全一致。

## 7. Research trace：记录“为什么这样做”

NeoResearch 的价值不只是产出模型，而是产出一条可审计的研究轨迹。因此 Harness 需要记录每个关键决策的原因。

例如：

```
{
  "decision": "use multi-scale temporal convolution",
  "made_by": "ModelDesigner Agent",
  "evidence": [
    "DataDiagnoser found strong daily and weekly seasonality",
    "HypoPlanner proposed multi-scale periodic modeling hypothesis"
  ],
  "expected_effect": "improve long-horizon forecasting stability",
  "verification_plan": "compare with baseline and single-scale model"
}
```

这类 trace 会让 ResultPublisher Agent 最后生成报告时更有依据，也让用户知道 NeoResearch 不是“凭空造模型”。

## 8. Stop condition：定义什么时候停止探索

自主研究系统很容易陷入无限迭代。NeoResearch 必须定义停止条件，例如：

```
达到最大实验次数
达到最大训练预算
连续若干轮无提升
当前模型已超过 baseline 目标
假设验证完成
用户要求停止
结果已经足够交付
```

否则 Agent 会不断提出新想法、新模型、新实验，导致成本失控。

建议 HypoPlanner 和 Reflector 都必须受 budget 限制。Reflector 不能无限提出“再试一个”。

## 9. Human checkpoint：把用户确认设计成 Runtime 机制

你提出的两种模式非常重要。Harness 层面要支持不同级别的 human checkpoint。

苏格拉底式模式可以是：

```
任务确认一次 → 后续自主执行 → 最终结果确认
```

认知伴随式模式可以是：

```
任务确认
数据诊断确认
假设确认
模型方案确认
实验预算确认
结果发布确认
```

这里关键是：用户确认不是聊天，而是 Runtime 状态迁移条件。例如用户确认模型方案后，系统才从 `model_design_pending_approval` 进入 `train_eval_running`。

## 10. Benchmark mode：把 NeoResearch 自己也放进评测环境

NeoResearch 既是系统，也应该能被评测。建议 Runtime 支持 Benchmark Mode，用于评估不同 Agent 版本、不同 workflow、不同模型基座、不同 Skills 对最终结果的影响。

例如评估：

```
完成率
实验成功率
代码可运行率
指标提升幅度
成本
运行时间
复现率
报告质量
假设验证质量
用户干预次数
```

这样 NeoResearch 本身也可以持续迭代，甚至形成论文实验部分。

## 11. Model factory interface：输出模型要能被其他 Agent 调用

既然你希望 NeoResearch 服务于 Agent，成为 Model Factory，那么 ResultPublisher 不能只输出报告，还要输出标准化模型接口。例如：

```
predict(input_series, context=None)
load_model(checkpoint_path)
get_model_card()
get_required_features()
get_input_schema()
get_output_schema()
```

最终交付包最好包含：

```
model_card.md
api_schema.yaml
inference.py
checkpoint.pt
requirements.txt
artifact_manifest.json
```

这样上层 Agent 才能真正调用 NeoResearch 生产的小模型。

## 12. 最重要的一条：Harness 要约束 Agent，而不是迁就 Agent

NeoResearch 的核心设计哲学可以概括为：

> **不要期待 Agent 自己变得可靠，而要通过 Harness 让 Agent 的行为变得可靠。**

也就是说，可靠性不主要来自“更会说的大模型”，而来自：

```
结构化任务协议
受控工具环境
标准化产物交接
阶段性验证器
实验复现机制
权限与预算控制
失败恢复机制
研究轨迹记录
```

最终可以将 NeoResearch 的 Harness Engineering 总结为一句话：

> **NeoResearch 的 Harness Engineering 目标，是把 LLM 的开放式推理能力嵌入一个受控、可验证、可复现的科研执行环境中，使其能够从“提出建议”走向“完成研究”。**

> **Harness 不是工具封装层，而是约束、验证并促进自主智能体持续演化的科研环境。**

## 相关工作对比

| 类型             | 主要目标           | 局限                       | NeoResearch 的差异               |
| ---------------- | ------------------ | -------------------------- | -------------------------------- |
| AutoML           | 自动模型选择与调参 | 偏重搜索，缺少研究推理     | 强调完整研究闭环                 |
| AutoDS           | 自动数据处理与建模 | 流程较固定，解释与反思不足 | 强调任务理解、数据诊断和实验反思 |
| LLM Coding Agent | 自动写代码和调试   | 不一定理解数据科学目标     | 面向数据科学任务构建专用 Harness |
| NeoResearch      | 自主数据科学研究   | 目标是形成可迭代研究能力   | 任务—数据—模型—实验—反思闭环     |

> **NeoResearch（智多星）希望让数据科学研究从人工驱动的经验流程，走向智能体驱动的自主研究闭环，使模型构建、实验验证和结果优化变得更加自动化、可解释和可持续演化。**

从研究视角看，NeoResearch 的关键不应只强调“自动训练模型”，而应强调 **research workflow automation**。传统 AutoML 更多关注模型选择、超参数搜索和训练调优，而 NeoResearch 更进一步关注“研究过程”本身：它需要理解用户目标，分析数据特征，形成建模假设，设计实验方案，执行模型训练，阅读实验反馈，并基于失败原因进行反思和下一轮改进。因此，它更像一个面向数据科学的“自主研究员”，而不是一个单一的建模工具。

## 潜在影响

NeoResearch（智多星）的潜在影响在于，它有望将数据科学建模从依赖人工经验的反复试错过程，推进到智能体驱动的自主设计、实验验证与持续优化过程。一方面，NeoResearch 可以服务于领域数据挖掘工程师，尤其是在电力能源、工业制造、云服务流量、气象环境、医疗健康等时序数据密集场景中，帮助工程师快速理解数据特征、生成建模假设、设计轻量化时序预测小模型，并通过自动实验、结果反思和模型迭代不断优化模型性能。它不只是降低建模门槛，更重要的是将工程师从大量重复性的数据处理、模型调参和实验整理工作中释放出来，使其能够将更多精力投入到领域问题理解、业务约束建模和结果决策分析中。另一方面，NeoResearch 也可以服务于更广义的 Agent 系统，作为面向数据科学任务的 Model Factory。对于需要预测、分析和决策能力的智能体而言，NeoResearch 能够根据具体任务、数据分布和应用约束，自动构建、训练、评估并发布专用小模型，为上层智能体提供可调用、可复现、可持续优化的模型能力。由此，NeoResearch 不仅是一个面向人类工程师的自主研究助手，也可以成为智能体生态中的基础模型生产设施，支撑未来 Agent 从“调用已有模型”走向“按需创造模型”的新阶段。



细节点：

- 中间的轨迹要保存下来，而不是覆盖！



# 未来规划

## **Literature Search Agent**

> **为增强自主研究过程中的知识支撑能力，NeoResearch 进一步引入文献研读与知识注入 Agent。该 Agent 能够围绕用户给定的数据科学任务，自主检索相关论文、技术报告、开源项目和基准数据集，并对文献中的方法思想、模型结构、实验设置、数据集特征、主要结论和局限性进行结构化解析。不同于传统文献摘要工具，该 Agent 的目标不是简单生成论文总结，而是将外部科研知识转化为当前任务可用的建模假设、模型设计建议、实验配置参考和结果反思依据。通过该模块，NeoResearch 能够在数据驱动建模的基础上进一步引入知识驱动研究能力，从而形成“文献知识—数据诊断—模型设计—实验验证—反思优化”的自主研究闭环。**

从系统架构看，可以加入一个新的核心模块：

| Agent 模块                  | 主要职责                           | 输出产物                                       |
| --------------------------- | ---------------------------------- | ---------------------------------------------- |
| Intent Agent                | 澄清任务目标、数据、约束和评价标准 | `intent.md`                                    |
| **Literature Search Agent** | 检索、阅读并提炼相关文献知识       | `literature_review.md`、`knowledge_cards.json` |
| Data Diagnosis Agent        | 分析数据特征并生成建模假设         | `data_diagnosis.md`                            |
| Model Design Agent          | 结合数据诊断和文献知识生成模型配方 | `model_recipe.yaml`                            |
| Experiment Agent            | 训练、评估和记录实验结果           | `results.csv`、`logs/`                         |
| Reflection Agent            | 分析失败原因并提出迭代方向         | `reflection.md`                                |
| Result Publishing Agent     | 整理代码、参数、结果和报告         | `final_report.md`                              |

这里最有价值的输出是 `knowledge_cards.json`。每篇文献可以形成一个结构化知识卡片，例如：

```
{
  "paper_title": "Example Paper",
  "problem": "Long-term time series forecasting",
  "core_method": "Decomposition-based Transformer",
  "useful_idea": "Separate trend and seasonal components before modeling",
  "applicable_scenario": "Data with strong seasonality and long prediction horizon",
  "possible_integration": "Use as a candidate model recipe in NeoResearch",
  "limitations": "May be less effective under abrupt distribution shift"
}
```

这样 Literature Search Agent 就不只是“查论文”，而是为 NeoResearch 提供可计算、可调用、可沉淀的研究知识。

> **知识增强的自主研究：NeoResearch 能够主动检索、研读和提炼科研文献，并将外部知识注入模型设计、实验配置和反思优化过程。**

## **HypoPlanner Agent**

> **HypoPlanner Agent = Hypothesis Formulation + Experiment Planning**
>
> 它负责综合 `intent.md`、`literature_review.md`、`knowledge_cards.json` 和 `data_diagnosis.md`，先提出若干可验证的研究假设，再为每个假设生成实验计划、优先级和 To-do List。这样模块职责清晰，也符合“大胆假设，小心求证”的科研逻辑。

HypoPlanner Agent 是连接文献知识、数据诊断与模型设计的认知桥梁。它负责提出可验证的研究假设，并将这些假设转化为可执行的实验规划，从而指导后续模型设计、训练评估与反思迭代。

研究假设与实验规划 Agent 负责综合用户任务意图、文献知识和数据诊断结果，提出可验证的建模假设，并将其转化为分阶段实验计划。该 Agent 在 Model Design Agent 之前发挥承上启下的作用，使后续模型设计不再是直接生成结构，而是围绕明确假设、评价目标和实验路线展开。

这样整个流程会更有“研究味道”。否则流程容易变成：

> 数据分析 → 直接设计模型 → 跑实验

但加入这个 Agent 后，就变成：

> 数据分析 + 文献知识 → 提出研究假设 → 制定实验计划 → 设计模型 → 执行验证

这个变化很重要。因为真正的数据科学研究不是直接“造模型”，而是先形成判断：当前任务的关键难点是什么？哪些因素可能影响预测效果？应该优先验证哪些方向？模型设计应该服务于什么假设？

例如在 Time Series Forecasting 中，这个 Agent 可以提出类似的假设：

> 该数据存在明显日周期和周周期，因此引入多尺度周期建模可能提升预测性能。

> 该数据存在非平稳趋势和局部突变，因此纯粹基于固定历史窗口的模型可能不足，需要引入漂移感知或自适应建模机制。

> 外部情境变量与目标序列存在滞后相关，因此协变量融合可能比单变量建模更有效。

> 数据规模较小且噪声较强，因此过深的 Transformer 模型可能过拟合，轻量化卷积或分解式结构可能更稳健。

这些假设随后可以指导 Model Design Agent 生成模型配方，而不是让 Model Design Agent 盲目从模型库中挑模型。

我建议将这个 Agent 的输出设计成三个文件：

```
hypotheses.md
experiment_plan.md
research_todo.md
```

其中，`hypotheses.md` 记录研究假设；`experiment_plan.md` 记录每个假设对应的验证实验；`research_todo.md` 则作为 NeoResearch 后续执行流程的 To-do List。

可以把它的核心输入与输出设计为：

| 模块                    | 输入                                                         | 输出                                                      |
| ----------------------- | ------------------------------------------------------------ | --------------------------------------------------------- |
| Research Planning Agent | `intent.md`、`literature_review.md`、`knowledge_cards.json`、`data_diagnosis.md` | `hypotheses.md`、`experiment_plan.md`、`research_todo.md` |

更具体来说，这个 Agent 可以承担四个功能。

第一，**提出研究假设**。它要根据数据诊断和文献知识判断当前任务的主要建模难点，并提出若干可验证假设。例如是否需要趋势分解、周期建模、协变量融合、非平稳建模、不确定性建模、轻量化结构或长程依赖建模。

第二，**划分优先级**。不是所有假设都值得马上验证。系统需要根据用户目标、计算预算、任务复杂度和预期收益，对假设进行排序。比如先验证低成本高收益的 baseline 与轻量改进，再验证复杂模型结构。

第三，**制定实验路线**。它需要把每个假设转化为可执行实验。例如“验证周期建模是否有效”可以对应为 baseline、加入时间特征、加入频域特征、加入多尺度模块四组实验。

第四，**生成研究 To-do List**。这一步可以和你前面提到的 Planning / To-do Lists 机制结合。该 Agent 不只是写一个计划，而是生成后续 Agent 可以执行、检查和更新的任务列表。

加入该 Agent 后，NeoResearch 的流程可以更新为：

| Agent 模块                  | 主要职责                                             | 输出产物                                                  |
| --------------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| Intent Agent                | 澄清任务目标、数据、约束和评价标准                   | `intent.md`                                               |
| Literature Search Agent     | 检索、阅读并提炼相关文献知识                         | `literature_review.md`、`knowledge_cards.json`            |
| Data Diagnosis Agent        | 分析数据特征，识别趋势、周期、异常、非平稳性等       | `data_diagnosis.md`                                       |
| **Research Planning Agent** | 综合任务、文献和数据诊断，提出研究假设并制定实验计划 | `hypotheses.md`、`experiment_plan.md`、`research_todo.md` |
| Model Design Agent          | 根据研究假设和实验计划生成模型配方                   | `model_recipe.yaml`                                       |
| Experiment Agent            | 训练、评估和记录实验结果                             | `results.csv`、`logs/`                                    |
| Reflection Agent            | 分析实验结果，判断假设是否成立，并提出下一轮迭代方向 | `reflection.md`                                           |
| Result Publishing Agent     | 整理代码、参数、结果和报告                           | `final_report.md`                                         |

这里还有一个值得强调的关系：**Research Planning Agent 和 Runtime 中的 Planning / To-do Lists 不是一回事，但二者应该协同。**

Runtime 中的 Planning / To-do Lists 更像底层执行机制，负责记录任务状态、步骤进度和执行顺序；而 Research Planning Agent 是一个高层认知模块，负责提出“为什么要做这些实验”和“应该如何验证假设”。也就是说：

> **Planning / To-do Lists 是执行层计划，Research Planning Agent 是研究层计划。**

或者更清楚地说：

> **Runtime Planning 管理任务怎么执行，Research Planning Agent 决定研究应该往哪里走。**

这会让 NeoResearch 的层次更清楚。

> **NeoResearch 并不是直接搜索模型，而是先形成研究假设，再围绕假设设计模型与实验。**

这句话很有辨识度，也能凸显 autonomous research agent 的研究属性。





**早期版本不需要分开，先合并为一个 HypoPlanner Agent；系统成熟后，可以拆成 Hypothesis Agent 和 Planning Agent 两个模块。**

原因是，**假设提出与实验规划在科研过程中高度耦合**。一个好的研究假设必须天然带有“如何验证”的思路；一个好的实验计划也必须服务于明确假设。如果过早拆开，容易导致 Hypothesis Agent 提出很多看似合理但不可验证的想法，而 Planning Agent 只能被动把这些想法转成实验，系统链路会变长，调试成本也会增加。

所以在 NeoResearch 的 MVP 阶段，我更推荐这样设计：

> **HypoPlanner Agent = Hypothesis Formulation + Experiment Planning**

它负责综合 `intent.md`、`literature_review.md`、`knowledge_cards.json` 和 `data_diagnosis.md`，先提出若干可验证的研究假设，再为每个假设生成实验计划、优先级和 To-do List。这样模块职责清晰，也符合“大胆假设，小心求证”的科研逻辑。

**Hypothesis Agent** 更偏研究认知，负责提出“可能是什么原因”“应该探索什么方向”“哪些机制可能有效”。它强调创造性、归纳能力和领域知识整合。例如它会提出：该数据存在多尺度周期，因此多尺度周期建模可能有效；该序列存在趋势漂移，因此需要自适应机制；外部协变量存在滞后相关，因此需要情境融合。

**Planning Agent** 更偏执行管理，负责把假设转化为可运行的实验路线。它强调可操作性、优先级、资源约束和任务调度。例如它会决定先跑哪些 baseline，如何设计消融实验，哪些实验并行执行，哪些实验作为下一轮迭代，什么时候停止探索。

因此，如果未来 NeoResearch 要做成更复杂的 Research Agent System，可以拆成：

| Agent                         | 主要职责                                 | 输出                                     |
| ----------------------------- | ---------------------------------------- | ---------------------------------------- |
| **Hypothesis Agent**          | 提出研究假设，解释建模难点，形成探索方向 | `hypotheses.md`                          |
| **Experiment Planning Agent** | 将假设转化为实验路线、优先级和执行计划   | `experiment_plan.md`、`research_todo.md` |

