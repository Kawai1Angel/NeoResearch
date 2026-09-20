# 当前数据集领域分析与 Agent 判断机制说明

核对日期：2026-09-18。本文依据当前工作区代码，说明 NeoResearch 在数据分析阶段如何确定任务领域、如何形成业务领域理解、定性 Agent 具体分析哪些内容，以及这些判断如何传递给后续模型搜索。

本文描述的是当前实现机制，不代表某个具体数据集的分析结论。定量指标的计算细节另见 [当前数据集定量分析特征说明](./当前数据集定量分析特征说明.md)。

## 1. 先区分两种“领域”

当前系统中的“领域”至少有两个不同含义：

| 层次 | 示例 | 当前如何确定 |
| --- | --- | --- |
| 系统任务领域（research domain） | `tsf`，即 Time Series Forecasting | 创建任务时由调用方直接写入 `domainID`；由 DomainRegistry 验证和路由 |
| 业务语义领域（business domain） | 电力负荷、风电功率、天气、交通流量、设备传感器、金融指标等 | 定性 Agent 根据任务描述、字段角色、字段名和统计特征进行自然语言解释 |

这两个层次不能混为一谈。

当前代码**不会读取 CSV 后自动把系统任务领域分类为电力、天气或交通**。它先知道这是一个 TSF 任务，再尝试理解这组时间序列在业务上可能代表什么。

## 2. 系统任务领域是如何确定的

### 2.1 当前只有一个内置 research domain

`DomainRegistry` 当前只注册了：

```text
id: tsf
displayName: Time Series Forecasting
```

它对应 `TSFDomain`，负责：

- 校验 TSF 任务结构；
- 生成数据集 fingerprint；
- 构造 baseline 和候选模型；
- 校验候选 recipe；
- 生成执行计划；
- 评价和导出实验结果。

因此当前系统尚不存在一个“先观察数据，再在分类、回归、时间序列预测等领域之间自动选择”的通用领域路由器。

### 2.2 `domainID="tsf"` 在任务创建时写入

CLI 和 TUI 的默认 TSF 任务创建逻辑都会直接设置：

```text
domainID = "tsf"
```

创建任务时，`DomainRegistry.createTaskSpec(domainID, taskSpec)` 根据该 ID 找到 `TSFDomain`，随后用 `TSFTaskSpec` 校验输入。不存在对应注册项时直接报 “Research domain not found”。

所以这里是**显式任务类型选择 + schema 验证**，不是 Agent 推断。

### 2.3 TSF schema 如何确认任务确实可按时间序列预测处理

`TSFTaskSpec` 要求或规范化以下信息：

| 配置 | 作用 |
| --- | --- |
| `taskType="forecasting"` | 固定为预测任务 |
| `forecastMode` | 点预测或概率预测 |
| `seriesType` | 单变量或多变量声明 |
| `contextLength` | 输入历史窗口 |
| `predictionLengths` | 需要预测的未来步数 |
| `dataset.loaderID` | 数据加载标识 |
| `dataset.targetCols` | 预测目标列 |
| 三类 covariates | 区分历史可见、未来已知和静态信息 |
| `evaluation` | 时间序列评价协议、指标和随机种子 |
| `constraints` | 参数、训练时间、GPU 和试验次数限制 |
| `runtime` | Neo-Cast 执行环境和产物位置 |

schema 还检查目标列与协变量不能重叠、每类列名不能重复。通过这些约束，系统确认任务契约符合 TSF 工作流，但它仍没有确认“业务上属于电力还是交通”。

## 3. 业务领域理解依赖哪些证据

定性 Agent 并没有单独的 `business_domain` 输入字段或分类标签。它接收一组上下文，再自行组织领域解读。

### 3.1 Intent Agent 收集的用户语义

在 Data Analysis 之前，Intent Agent 会收集或确认：

| Intent 信息 | 对业务领域理解的作用 |
| --- | --- |
| `forecast_object` | 预测对象及被预测现象，是最直接的业务语义 |
| `data_source` | 数据来源路径，可能通过文件名透露数据集身份 |
| `target_columns` | 目标列名称，例如 power、load、temperature |
| `time_grain` | 小时、天、周等业务时间尺度 |
| `exogenous_variables` | 天气、节假日、价格、事件等外部驱动 |
| `future_covariate_availability` | 外生变量在真实预测时是否可获得 |
| `business_context` | 预测服务的业务决策或研究判断 |
| 指标、误差偏好和约束 | 哪些错误更重要，以及生产部署要求 |

其中 `forecast_object`、`business_context`、`time_grain` 等保存在 `taskSpec.metadata.intentSlots`；目标列和数据路径还会同步到 `taskSpec.dataset`。

Intent 阶段因此承担了当前业务领域识别中最关键的“人工提供语义”部分。字段名不清楚时，领域判断质量主要取决于这些用户说明是否充分。

### 3.2 定性 Agent 实际收到的结构化上下文

`buildQualitativeUserPrompt()` 会向 Agent 提供一个 JSON 上下文，主要包含：

#### 任务层信息

- task ID、任务标题；
- `domainID`；
- 优化目标和方向；
- 完整 `taskSpec`，其中包含 `metadata.intentSlots`，所以 Agent 能看到预测对象、业务背景和时间粒度等已确认信息。

#### 数据角色信息

- `targetCols`；
- `loaderID`；
- `observedPastCovariates`；
- `knownFutureCovariates`；
- `staticCovariates`；
- 未来协变量在预测时是否可用及其来源；
- 当前实验是生产候选、仅历史协变量方案，还是 oracle upper-bound；
- 结果是否可与真实生产场景直接比较。

#### 基础定量画像

- 行数和目标数；
- 缺失率；
- 趋势和季节性强度；
- 跨目标相关；
- 分布漂移；
- 极端值比例；
- ACF 候选主周期；
- ADF 风格平稳性结果。

#### 扩展统计诊断

- KPSS 风格结果；
- ACF/PACF 代表性 lag；
- 趋势/季节/残差分解；
- 主频周期与功率占比；
- 变化点位置、分数和等级；
- 最强跨目标 lead-lag 关系。

这些数值是定性推理的证据，不是业务领域标签。例如 `period=24` 只能说明约 24 步重复；只有结合“小时间隔”和“电力负荷”语义，才可以进一步提出日周期假设。

### 3.3 Agent 可以看到但当前没有专门结构化的语义

完整 `taskSpec` 和 metadata 允许 Agent 读取用户提供的自由文本，但当前没有：

- 标准化行业 taxonomy；
- `businessDomain=electricity` 这类明确字段；
- 数据字典或字段单位的强制 schema；
- 设备、站点、区域等实体关系 schema；
- 业务领域分类概率或置信度；
- 对领域判断的规则校验器。

这意味着业务领域理解是基于上下文的生成式解释，而不是一个可审计的分类模型输出。

## 4. 定性 Agent 的实际执行链路

当前 Data Analysis 阶段按下列顺序运行：

```text
创建并确认 TSF 任务
        ↓
生成 task fingerprint 和定量画像
        ↓
构造扩展统计分析 context
        ↓
优先启动 research-data-analysis Session Agent
        ↓
Agent 调用 analyze_dataset 获取权威定量报告
        ↓
结合完整 taskSpec 做定性与领域解读
        ↓
输出 Reading / 领域解读 / Search Preferences
        ↓
写入 qualitative_analysis.md，并提取搜索偏好
```

### 4.1 优先使用 Session Agent

系统优先以隐藏的原生 Agent `research-data-analysis` 运行。这个 Agent 被允许使用：

- `analyze_dataset`；
- read、grep、glob、list；
- `webfetch`。

其他工具默认拒绝。其系统提示明确要求先调用 `analyze_dataset`，然后基于返回数字做解释，不得虚构统计值。

`analyze_dataset` 会读取当前 task 最近的 `task_profile_json`，重新构造定量上下文，并返回 Markdown 定量报告。这样，Agent 使用的是当前任务对应的数据画像，而不是仅凭提示词中的几个摘要字段自由推测。

虽然 `webfetch` 权限存在，但当前提示词没有强制要求联网查找领域知识、没有指定资料源，也没有生成引用清单。因此不能把领域解读视为经过外部资料验证的行业研究。

### 4.2 Session 失败后使用 direct LLM 回退

如果 Session Agent 没有成功返回，系统改用 Neo-Cast LLM bridge 直接请求模型，最大输出 token 为 8192，超时为 120 秒。

direct 路径使用同一份 system prompt 和 user prompt，但没有 Session 工具执行过程；因此它依赖 user prompt 内嵌的 `datasetProfile` 与 `extendedStatistics` 作为 fallback。

如果没有可用 API key、请求超时或发生异常，LLM 结果为不可用，系统再生成固定规则版定性报告。

### 4.3 无 LLM 时的确定性回退

无 LLM 结果时，`renderDatasetQualitativeAnalysis()` 根据固定阈值输出领域解读：

| 信号 | 规则 | 固定解释方向 |
| --- | --- | --- |
| 季节性 | `seasonalityStrength >= 0.4` | 可能对应生产节律、日历周期或批处理节奏 |
| 趋势 | `trendStrength >= 0.2` | 建议用 baseline 和 residual design 处理趋势 |
| 跨目标联动 | `crossVarCorrelation >= 0.5` | 考虑共享驱动、特征融合或图结构候选 |
| 分布漂移 | `distributionShift >= 0.5` | 关注离线验证与未来表现差异，考虑稳健处理 |
| 缺失 | `missingRate > 0` | 考虑 missing-aware preprocessing |
| 变化点 | 始终报告位置和 severity | 提醒核对口径、设备或环境变化 |
| 跨目标滞后 | 存在 `crossLag.source` | 关注 source 到 target 的 lead-lag 关系 |

这个回退模板不会真正判断“电力”“天气”或“交通”。它只把统计模式映射为通用业务机制描述。

## 5. Agent 如何形成业务领域判断

当前没有一段代码直接执行：

```text
if column contains "power" then domain = electricity
```

业务领域判断主要发生在 LLM 推理中，可以概括为以下证据组合。

### 5.1 第一优先级：用户明确描述

如果 `forecast_object` 或 `business_context` 已写明“预测风电场未来发电功率”，Agent 可以直接识别为能源/风电预测场景。此时字段名和统计结构主要用于细化解释，不需要重新猜领域。

### 5.2 第二优先级：数据集及字段语义

Agent 可以从以下名称推测业务含义：

- 任务标题；
- `loaderID`，例如 weather、traffic、ETTh1；
- `targetCols`；
- observed-past、known-future 和 static covariate 名称；
- 完整 taskSpec 中的 metadata。

这种推测依赖名称是否清晰。`OT`、`HUFL`、`MULL` 等缩写若没有数据字典，Agent 很难可靠还原含义；最多能结合已知数据集名称做推测，不能证明字段业务定义。

### 5.3 第三优先级：时间结构与变量关系

Agent 用定量证据提出业务机制假设，例如：

| 统计现象 | 可形成的领域假设 | 不能直接推出的结论 |
| --- | --- | --- |
| 24 步强周期，时间粒度为小时 | 可能存在日周期、班次或昼夜行为 | 不能仅凭周期确认是用电需求 |
| 168 步周期，小时数据 | 可能存在周内工作日/周末规律 | 不能证明节假日就是原因 |
| 多变量同步高相关 | 可能有共同天气、市场或上游驱动 | 不能证明变量之间有因果关系 |
| A 领先 B 三步 | A 可能是 B 的前置指示信号 | 不能证明 A 导致 B |
| 高分布漂移或变化点 | 可能发生设备、政策、季节或口径变化 | 不能自动确定具体事件是什么 |
| 高异常率 | 可能有故障、极端天气或业务峰值 | 不能自动区分错误与真实事件 |

系统 prompt 要求这些解释必须以统计结果或任务上下文为基础，但不会自动验证“可能原因”是否在现实中真实发生。

### 5.4 外生变量可用性参与领域判断

Agent 不只看“有哪些变量”，还必须看它们在预测时是否可获得。

例如天气变量在离线数据中存在，但未来真实值在生产时不可得：

- 如果使用真实未来天气，只能视为 oracle upper-bound；
- 如果使用天气预报值，可以成为生产候选，但需要记录来源；
- 如果未来不可用，只能作为历史协变量，不能直接喂给未来区间。

Intent 更新逻辑会把用户回答规范化为：

| metadata | 含义 |
| --- | --- |
| `knownFutureAvailability.availableAtPredictionTime` | 预测时是否可用 |
| `knownFutureAvailability.source` | 用户说明的来源 |
| `experimentScope="production_candidate"` | 可按生产候选评估 |
| `experimentScope="oracle_covariate_upper_bound"` | 只代表使用离线真值的性能上界 |
| `experimentScope="past_covariates_only"` | 未来不可用，只能利用历史 |
| `productionComparable` | 是否可直接与生产方案比较 |

这部分是当前领域分析中很重要的现实约束：语义上相关的变量不等于预测时合法可用。

## 6. 领域分析具体输出什么

LLM 被要求只输出三个 Markdown section。

### 6.1 `## Reading`

要求 2～4 个要点，用统计模式解释模型设计含义，典型内容包括：

- 趋势是否足以支持 decomposition 或 trend-aware baseline；
- 季节性和主频是否一致，是否值得测试 frequency-aware 模块；
- 平稳性证据是否矛盾，是否需要差分或归一化；
- 跨变量结构是否值得使用 feature/channel fusion；
- 漂移、异常和变化点是否会威胁时间切分验证。

这一节处在“统计结果”与“模型方向”之间，属于技术解释。

### 6.2 `## 领域解读`

要求 4～6 个要点，提示词指定六个分析角度：

| 角度 | 当前应回答的问题 |
| --- | --- |
| 字段语义 | 目标列和协变量可能表示什么，各自角色是什么？ |
| 业务机制 | 趋势、周期和变量联动可能由哪些业务过程产生？ |
| 外部因素 | 天气、节假日、价格、事件、设备状态等是否可能影响目标？ |
| 潜在事件 | 变化点或异常对应的时段是否需要人工核对？ |
| 风险 | 漂移、缺失、未来变量不可用或信息泄漏会怎样影响结论？ |
| 领域建模建议 | 在当前业务和数据条件下优先测试哪些处理与模型？ |

提示词要求这部分使用中文，同时保留技术术语、指标名和模块名的英文写法。

### 6.3 `## Search Preferences`

要求 3～5 条英文、独立且数据驱动的搜索偏好，例如：

```text
Prefer dlinear as a baseline given the strong trend component.
```

系统用正则找到该 section，逐行去掉项目符号，过滤过短文本，最多保留 8 条，然后写入：

```text
.neo-research/sessions/<taskID>/analysis/search_preferences.json
```

HypoPlanner 后续读取该文件。如果存在有效偏好，它会**替换**默认模型方法库中的 `preferences` 列表，再据此生成研究假设；默认 backbones 和 preprocessing 说明仍保留。

所以领域分析不是只生成一份供人阅读的文字。它可以直接改变后续假设规划的模型搜索偏好。

## 7. LLM 报告与固定规则报告的差异

| 能力 | LLM 成功时 | LLM 不可用时 |
| --- | --- | --- |
| 识别具体业务语境 | 可结合完整 taskSpec 和自由文本 | 基本没有，只输出通用模板 |
| 使用字段名和协变量角色 | 可详细解释 | 仅简单列出 target 和 loader |
| 解释统计证据组合 | 可联合多项指标 | 逐个阈值映射 |
| 分析未来协变量合法性 | prompt 明确要求 | 固定模板没有完整展开 |
| 形成数据特定搜索偏好 | 可以，且传给 HypoPlanner | 不生成 `Search Preferences`，不会写偏好文件 |
| 外部知识 | Session 有 `webfetch` 权限，但未强制使用或引用 | 无 |
| 可重复性 | 受模型、提示和采样影响 | 相同输入确定性输出 |

`qualitative_analysis.md` 的 artifact metadata 使用 `llmGenerated` 标识是否注入了 LLM 文本。但目前只判断 `llmQualitative !== undefined`，没有再验证它是否严格满足三个 section 的格式或内容真实性。

## 8. Main Agent 如何汇总领域分析

Data Analysis 阶段会生成：

| 文件 | 作用 |
| --- | --- |
| `quantitative_analysis.md` | 定量指标、统计诊断和图表引用 |
| `qualitative_analysis.md` | LLM 或固定规则生成的领域解读 |
| `main_agent_summary.md` | 按固定规则生成模型搜索建议 |
| `data_analysis_summary.md` | 合并画像、相关矩阵和三份来源报告 |

需要注意：当前 `renderDatasetMainAnalysisSummary()` 的参数只有 task、fingerprint 和 quantitative context，**没有读取 LLM 定性文本作为推理输入**。它会声明自己审阅了 qualitative sub-agent，但其推荐内容实际由固定规则生成：

- 总是先跑 linear 和 patch baseline；
- 跨目标相关高时优先跨变量候选；
- 季节性高时测试分解或频率感知模型；
- 漂移高或存在缺失时考虑稳健 loss 或 preprocessing；
- 高等级变化点作为验证风险。

LLM 的领域分析真正影响后续搜索的主要路径，是 `search_preferences.json` 被 HypoPlanner 读取；另一路是完整的 `data_analysis_summary.md` 被当作数据分析上下文传递。Main Agent 固定摘要本身没有对 LLM 领域结论进行二次验证或冲突消解。

## 9. 当前如何保证 Agent 不乱解释

现有约束包括：

1. system prompt 要求先调用 `analyze_dataset`。
2. 明确禁止编造工具或 user message 中不存在的统计值。
3. 完整 `taskSpec` 被声明为权威任务契约。
4. 明确要求读取目标、历史协变量、未来协变量和静态协变量角色。
5. 特别提醒 `targetCount` 只表示预测目标数，不能据此认定没有外生变量。
6. 存在未来协变量时，必须讨论真实预测时的可用性和 oracle/production 范围。
7. 输出 section 和项目数受到提示词限制。
8. `Search Preferences` 只能从指定 section 解析，最多保留 8 条。

但这些主要是提示词约束和格式提取，不是强类型结果验证。当前没有自动检查：

- 每一条业务结论是否有对应数值证据；
- Agent 是否误解了字段缩写；
- 是否真的调用过 `analyze_dataset`；
- 三个 section 是否齐全；
- 搜索偏好中的模型是否一定受 recipe registry 支持；
- 外部事实是否有引用；
- 不同 Agent 的定量与定性结论是否矛盾。

## 10. 领域判断的可信度边界

### 10.1 CSV 本身通常无法唯一决定业务领域

一列名为 `value`、呈现 24 步周期的序列，可能是负荷、流量、温度、访问量或设备状态。统计形状只能描述行为，不能唯一还原语义。

最可靠的业务领域证据顺序通常是：

1. 用户明确提供的预测对象和业务背景；
2. 有定义和单位的数据字典；
3. 明确的数据集 ID、来源和字段角色；
4. 字段名称；
5. 统计模式；
6. Agent 的常识推断。

当前实现能够使用第 1、3、4、5、6 类证据，但没有强制的数据字典结构。

### 10.2 “可能”是领域假设，不是已验证事件

领域报告中的以下表达应当视为待核查假设：

- “可能对应生产节律”；
- “可能受到天气影响”；
- “可能存在设备或口径变化”；
- “变量 A 可能领先变量 B”。

变化点索引需要映射回时间戳，并与业务日志、设备维护记录、节假日日历或数据版本记录核对，才能确认具体原因。

### 10.3 目标分析不等于目标与外生变量关系分析

当前定量 pipeline 主要分析目标列。即使 taskSpec 列出了天气或价格协变量，现有相关矩阵和 cross-lag 通常也不自动评估“协变量 → 目标”的关系。

因此定性 Agent 可以根据变量名称和业务上下文说某变量“可能有影响”，但当前报告未必提供了相应的数值相关证据。这是领域分析与定量分析之间的一个重要缺口。

### 10.4 没有业务领域置信度

当前输出不会给出：

```text
electricity: 0.85
weather: 0.10
traffic: 0.05
```

也不会在领域证据不足时自动标记 `unknown_business_domain`。如果业务背景和字段含义缺失，LLM 仍可能生成看起来合理但证据较弱的解释。

## 11. 如何阅读和审核领域分析报告

建议按以下顺序审核：

1. **先看任务契约。** 核对预测对象、业务背景、时间粒度、目标和协变量角色。
2. **再看统计证据。** 领域报告提到趋势、周期、漂移或变化点时，在定量报告中找到对应数值。
3. **区分观察与解释。** “24 步周期”是观察；“每日用电模式”是结合领域语义的解释。
4. **检查未来可用性。** 确认 known-future covariates 在部署时确实可以获得。
5. **核对潜在事件。** 把变化点索引映射到真实时间，并检查业务日志。
6. **把建议当作实验假设。** 通过严格的时间切分实验验证模型方向，而不是把 Agent 建议当成效果保证。

一个较可靠的领域结论应该能写成：

```text
任务上下文说明这是小时级风电功率预测；目标 real_power 呈现接近 24 步的周期，
天气协变量被声明为预测时可获得，因此优先测试日周期表示与天气特征融合。
```

这里同时包含任务语义、统计证据和数据可用性。相反，“数据显示典型能源周期，因此一定是风电数据”就超出了现有证据。

## 12. 当前实现尚未完成的领域分析能力

当前尚未实现：

- 基于 ontology 的业务领域自动分类；
- 领域标签及置信度输出；
- 强制字段数据字典、单位、量纲和取值约束；
- 字段缩写自动消歧并要求来源；
- 目标与全部外生变量之间的定量相关、互信息和滞后分析；
- 行业日历、天气、政策、维护日志等外部事件的自动对齐；
- 带引用的领域知识检索和事实核查；
- 领域结论到定量证据的逐条 provenance；
- 对 qualitative 输出的 schema 验证与事实一致性检查；
- 定量 Agent、定性 Agent 和 Main Agent 之间的显式冲突检测；
- Main Agent 基于完整定性文本重新综合，而不是固定阈值摘要。

所以当前领域分析的准确定位是：**在明确的 TSF 任务内，结合用户意图、字段角色和统计特征生成业务解释与模型搜索假设。** 它不是一个从匿名 CSV 自动、确定地识别行业领域的分类系统。

## 13. 代码定位

| 代码 | 与领域分析的关系 |
| --- | --- |
| [domain-registry.ts](../opencode/packages/opencode/src/research/domain-registry.ts) | 注册和选择系统任务领域；当前只注册 TSF |
| [tsf.ts](../opencode/packages/opencode/src/research/domains/tsf.ts) | TSF task schema、domain metadata、fingerprint 与模型搜索规则 |
| [intent-agent.ts](../opencode/packages/opencode/src/research/agents/intent-agent.ts) | 收集预测对象、业务背景、时间粒度、外生变量等意图信息 |
| [taskspec-store.ts](../opencode/packages/opencode/src/research/taskspec-store.ts) | 将 Intent slots 写入 taskSpec，并规范化协变量及未来可用性 |
| [research-data-analysis.txt](../opencode/packages/opencode/src/agent/prompt/research-data-analysis.txt) | 定性 Agent 的系统提示、语言策略和三段输出协议 |
| [research-data-analysis.ts](../opencode/packages/opencode/src/tool/research-data-analysis.ts) | `analyze_dataset` 工具，向 Agent 提供当前任务的权威定量报告 |
| [data-analysis-agent.ts](../opencode/packages/opencode/src/research/agents/data-analysis-agent.ts) | 定量上下文、报告和图表生成 |
| [service.ts](../opencode/packages/opencode/src/research/service.ts) | 定性 prompt、Session/direct 回退、固定规则报告、偏好提取和产物写入 |
| [agent.ts](../opencode/packages/opencode/src/agent/agent.ts) | 注册 `research-data-analysis` Agent 及其工具权限 |

## 14. 产物位置与后续影响

在正常 profile/data-analysis 流程中，领域分析相关文件位于：

```text
.neo-research/sessions/<taskID>/analysis/
├── quantitative_analysis.md
├── qualitative_analysis.md
├── main_agent_summary.md
├── data_analysis_summary.md
├── search_preferences.json        # 仅成功解析 LLM Search Preferences 时存在
└── quantitative/plots/*.png
```

`qualitative_analysis.md` 是查看领域判断最直接的文件；`data_analysis_summary.md` 将它和定量报告、Main Agent 摘要放在一起，适合检查证据链；`search_preferences.json` 则体现领域分析是否实际改变了后续 HypoPlanner 的搜索偏好。
