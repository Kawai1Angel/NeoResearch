# ModelRecipe：真实序列编码器、搜索去重与受控组合修改方案

> 日期：2026-09-23
> 状态：主要功能已实施；实际契约、验收边界与未实现项见 [v3 实施说明](recipe_runtime_v3_contract.md)。下文保留原始设计目标，不将目标描述直接视为全部验收通过。
> 基线：[v2 运行时契约](recipe_runtime_v2_contract.md)及[上一轮修正记录](recipe_runtime_semantic_correction_plan.md)。
> 用户确认：新增 `diagonal_ssm`、`timesblock_encoder`、`mamba`；不新增原生 TimesNet；本轮不实现跨 H 共享。

## 1. 目标与范围

本轮从“配置与执行一致”进一步推进到“真实模型机制、可靠搜索身份、可检查的模型组合”。保留 v2 已修复的数据隔离、缺失 mask、概率输出、graph 来源及 artifact 校验。

### 1.1 纳入范围

1. 配置规范化、已知等价规则、执行前重复实验检查及行为相似诊断。
2. 带轴语义的 encoder/adapter/head 接口，以及可配置 latent 宽度。
3. 真实 `diagonal_ssm`、TimesBlock 编码器、Mamba-1 编码器。
4. 受限双分支、可配置 decomposition 分支、历史时间级与预测步级融合。
5. Schema、registry、编译器、mutation、提示词、训练、导出和执行 manifest 同步。
6. 机制测试、参考实现对齐及可复现的训练验证。

### 1.2 明确不做

- 原生 TimesNet 完整预测模型及其论文指标复现。
- 跨 H 共享 encoder、联合训练或共享 checkpoint。仍然是每个 H 一套独立模型、优化器及训练状态。
- Mamba-2/3、预训练语言模型接入、任意深度 DAG 或任意模块排列。
- 未来/静态协变量恢复、原始数据清洗流程整体打包导出。
- 用 probe 相似度证明任意两个模型数学等价。
- 将现有 `gated_depthwise_conv`、`timesnet_lite` 改名冒充新增模型。

2026-09-27 更正：`direct_multi_horizon` 已按用户要求删除，旧候选不迁移为其他 head。此前关于它的描述不再是当前可用能力。

## 2. 当前实现基线与需要改变的位置

| 现状 | 本轮处理 |
| --- | --- |
| `model_recipe.v1` 编译到 `recipe_schema_v2` | 引入显式新版本及迁移，不在旧版本下静默改变语义 |
| encoder 统一压缩到 `[B,C,min(T,64)]` | 扩展带轴语义的表示；pooling 必须显式声明 |
| `temporal/shared` 与 `feature_mlp` 已声明等价 | 新搜索入口归一，保留旧输入迁移和来源记录 |
| manifest 有参数图摘要，但没有行为 probe | 增加规范配置身份、训练实验身份及诊断 probe |
| OpenCode 有基于候选内容的提示词签名 | 保留提示用途，增加执行入口的权威去重检查 |
| decomposition trend 固定为 `Linear(T,H)` | 新版本支持两支独立、受限配置的 encoder/head |
| hybrid time gate 最终汇总为 latent 权重 | 新增显式保留时间轴的 gate，不重新解释旧字段 |
| 多 H 为逐 H 建模、训练和导出 | 保持不变；新接口不能顺带引入共享参数 |

主要现有入口：`py/model_recipe.py`、`py/factory/build_model.py`、`py/registry/action_specs.py`、`py/search/mutate.py`、`py/execution_contract.py`、`py/train.py`、`py/export.py`、`src/candidate-utils.js`，以及 OpenCode 的 TSF domain、proposal 和 research service。

## 3. 搜索身份与去重

### 3.1 三种身份分开记录

| 身份 | 内容 | 用途 |
| --- | --- | --- |
| `architecture_id` | 规范化有效模型配置、算子语义版本、轴/连接/共享关系、adapter、输入输出规格 | 判断是否同一架构；不包含名称、说明、候选 ID、随机种子 |
| `experiment_id` | 架构身份、数据及列顺序摘要、fold/split、填补/缩放协议、loss、优化器、调度、预算、seed、H、精度和解析后的后端版本 | 判断是否同一训练实验，可否复用完成结果 |
| `behavior_probe` | 固定 probe 协议、初始化/权重标识、输出及输入梯度摘要、比较距离 | 发现疑似无效字段和相似候选；不能单独作为跳过依据 |

模型身份随输入 shape 改变时必须显式反映 T、C、目标列及 H。外部 graph 等资源不能只记录路径，须记录内容摘要和列顺序。

不要把架构身份当作实验身份：不同 seed 的重复实验、不同 loss/学习率/训练预算仍应允许执行。

### 3.2 配置规范化规则

- 先严格验证，再补齐声明的默认值；未知、非法和不适用字段报错，不靠删除字段掩盖错误。
- 去除仅用于展示的名称、描述和 provenance 后计算身份，原始提案完整保留。
- 只排序对象键；不能排序 preprocessing、分支、通道等具有顺序语义的数组。
- 将已经验证的 `temporal/channel_mode=shared` 迁移为 `feature_mlp`，保留迁移规则版本；新生成器只产生后者。
- 训练中的明确 no-op 如 uniform reweighting 归入规范默认值；不擅自交换算子顺序或折叠可训练模块。
- Python 为规范化结果的权威实现；Node/OpenCode 调用 bridge 获取身份，避免三端独立实现产生不一致。使用跨端 golden fixtures 验收。
- 参数 shape、模块列表摘要仅作证据，不足以判定执行等价。等价跳过必须来自规范化或经测试的白名单规则。

### 3.3 执行入口与恢复

在 LLM proposal、mutation、手动提交汇入训练的统一入口执行检查，不能只靠提示词提醒。

1. 校验并编译配置，生成架构身份。
2. 解析数据、预算、后端和运行协议，生成实验身份。
3. 对同一研究作用域内的实验身份原子占位，防止并发重复训练。
4. `completed` 且 artifact 完整、协议匹配时，复用结果并记录来源；不伪造一次新的独立实验。
5. `running` 不重复启动；失效占位应有租约/恢复规则。
6. `failed` 不永久封禁。区分配置失败、环境失败、训练失败，允许修复环境后重试并保留 attempt 记录。

去重事件不计作新的性能证据，也不直接增加 plateau 的失败计数。设置有限的重新提案次数，耗尽后以“未找到新候选”结束该轮，避免无限重提。

### 3.4 行为 probe 的边界

使用多组确定性输入：常量、脉冲、周期、随机、缺失 mask 和单变量扰动。记录 probe 版本、dtype、device、初始化方法和容差。

- `eval` 模式用于可重复前向；dropout 等训练机制另设 `train` 模式测试。
- 输出/梯度相似只生成诊断告警，不自动复用训练分数。
- 固定 seed 并不保证不同模块构建顺序具有相同参数；只有明确权重映射的实现对齐测试才要求数值一致。
- 有效性测试按字段指定结构、梯度、训练行为或资源约束证据，不能要求所有字段都改变一次 eval 输出。

## 4. 模型接口：有限类型，而非任意 DAG

### 4.1 表示类型

| 类型 | Shape | 语义 |
| --- | --- | --- |
| `channel_latent` | `[B,C,D]` | 每变量一个向量，兼容现有 head |
| `sequence_latent` | `[B,T,D]` | 变量已嵌入到特征维的序列，不能把 D 当成变量数 |
| `channel_sequence` | `[B,C,T,D]` | 同时保留变量轴和历史时间轴 |
| `forecast` | point 为 `[B,H,C_target]` | 最终预测；quantile/Gaussian 使用已有显式输出合同 |

模块声明输入/输出类型、轴、宽度、是否改变时间长度、是否混合变量、mask 使用方式及资源约束。编译期校验连接合法性，运行时再校验 shape。

新 encoder 默认只处理历史窗口 T，不在 backbone 内扩展到 T+H；最终 head 拥有预测映射。本轮没有原生 TimesNet，因此无需为它新增原生预测入口。

### 4.2 首批 adapter 与 head 路径

- `channel_sequence -> channel_latent`：显式 `last` 或 `mean` 历史读出，随后使用现有 head。
- `sequence_latent -> channel_latent`：显式池化，再经可训练投影产生 `C_target × D_head` 个元素；不使用 reshape 冒充变量解码。
- 历史序列做保长融合后再执行上述读出；第一版不支持任意 patch/unpatch 组合，长度不同则拒绝。
- 预测步融合的每支 head 先产生同一 `[B,H,C_target]`，再融合；不能将历史 gate 换名为预测步 gate。
- `latent_dim` 和 adapter 输出宽度显式配置，并纳入参数预算；迁移旧 recipe 时显式固定原 `min(T,64)` 行为。
- 所有新 encoder 必须验证 observed-past 对目标的有效路径。联合 embedding 消费 mask 时要区分目标、辅助变量和 mask，不能将 mask 当作预测目标。

本轮新 encoder 首先提供 joint 的 `[B,T,D]` 路径和 channel-independent 的 `[B,C,T,D]` 路径；后者可复用共享时间编码器。布局及是否共享必须显式声明。不兼容的 fusion/embedding 组合在训练前拒绝。

## 5. 三个新编码器

### 5.1 `diagonal_ssm`

定位：真正的实数对角线性状态空间模块，不宣称完整 S4/S4D 论文复现，也不称为 Mamba。

最小机制：

- 连续状态参数 `A = -exp(A_log)`、正步长 `delta`，保证每个固定参数状态转移为收缩形式。
- 第一版使用明确的 ZOH 离散化：`A_bar = exp(delta*A)`，`B_bar = expm1(delta*A)/A * B`，小量区间使用稳定计算。
- 递推 `s_t = A_bar*s_(t-1) + B_bar*u_t`，输出 `y_t = C*s_t + D_skip*u_t`，配合输入/输出投影。
- 状态维与通道维分开；`state_dim` 真正改变状态张量和参数量。
- 固定支持一种离散化，不暴露尚未实现的 method 枚举。

首批有效参数：`d_model`、`state_dim`、`depth`、模块 `dropout`；初始化与步长边界固定并记录版本，不一开始全部加入搜索。

参考实现为纯 PyTorch scan，支持 CPU 和普通 PyTorch device；是否加速是后续性能优化，不得换成卷积 proxy。正稳定转移不等于整网绝对稳定，仍需梯度裁剪与长序列数值测试。

验收：逐步/整段/分块状态递推一致；单脉冲响应；A/B/C/步长有梯度；不同 state_dim 改变真实图；长序列有限值；独立窗口状态不串用。

### 5.2 `timesblock_encoder`

定位：保留真实 TimesBlock 的核心机制，整体为 TimesNet-derived encoder，不包含官方预测路径的 T→T+H 扩展，也不使用 `timesnet` 名称。

处理链：FFT 非零频率选择 → 周期二维重排 → 多尺度 Inception 2D 卷积 → 回到历史时间轴 → 幅值权重聚合 → 残差及层归一化。参考 [TimesNet 官方代码](https://github.com/thuml/Time-Series-Library/blob/main/models/TimesNet.py)。

首批参数：`d_model`、`d_ff`、`depth`、`top_k`、`num_kernels`、模块 `dropout`。

关键设计决策：

- 默认按样本选择周期，避免一个样本的预测随同批其他样本改变；这与官方 batch 聚合周期选择存在明确差异，必须写入实现标签。
- 不将 `batch_shared` 作为首批搜索开关；对齐测试以官方 block 的逐样本执行为基准。
- 排除 DC；静态校验 `top_k <= floor(T/2)`，不在运行时静默裁剪配置。
- 常量/全零序列使用确定性非零频率 tie-break；短序列、非整除 padding、多个频率映射同一周期需明确且可复现。
- 第一版保留 top-k 频率对应的各聚合项，不擅自合并相同周期改变权重语义。
- 只基于输入历史求周期，禁止读取标签或完整数据集；FFT 选频索引不可导，但被选幅值与卷积路径应获得梯度。

验收：合成周期恢复、不同 batch 组成下的单样本输出一致、二维 reshape/padding 往返、卷积及幅值梯度、共享权重的逐样本参考对齐。不是完整 TimesNet 指标复现。

### 5.3 `mamba`

定位：Mamba-1 block 编码器；variant 固定并记录为 `mamba1`，不实现一个含糊的通用 Mamba 枚举。

保留输入投影、因果 depthwise conv、输入相关 delta/B/C、selective scan、skip、门控和输出投影。外层 residual/norm 堆叠方式显式固定。参考 [Mamba-1 官方 block](https://github.com/state-spaces/mamba/blob/main/mamba_ssm/modules/mamba_simple.py)及[论文](https://arxiv.org/abs/2312.00752)。

首批参数：`d_model`、`d_state`、`d_conv`、`expand`、`depth`、外层模块 `dropout`；`dt_rank` 初期按固定规则解析并记录有效值，避免额外无效搜索维度。

后端政策：

- 必须提供可在 CPU 单元测试中运行的 `torch_reference`。对齐官方 Mamba-1 运算及初始化规则；不能直接套用 diagonal SSM 的 ZOH 输入离散化来替代 Mamba 的 scan。
- `cuda_optimized` 为可选后端，只接入固定上游版本并经权重映射、前向和梯度对齐验证的实现。
- 显式请求不可用后端时报 capability 错误；自动选择只能选择数学机制相同且经过验证的后端，并在训练前固定实际选择。
- 不允许自动回退到 `gated_depthwise_conv` 或 `diagonal_ssm`。加速后端不是新架构，环境及后端版本属于实验身份。
- 默认测试不能要求安装 CUDA 扩展；不在本轮方案阶段安装依赖。实施时单独维护可选依赖及 doctor 能力检测。
- 保留 delta 初始化和特殊参数精度、weight-decay 处理；通用初始化器不得覆写这些约束。

验收：参考前向/梯度对齐、完整与逐步/分块一致（包括卷积缓存和 SSM state）、输入改变时选择参数改变、因果性、状态重置、短序列与长序列有限值。无 CUDA 时加速验收标记未验证，不能宣称已完成。

## 6. 受控模型组合

### 6.1 组合语法边界

首批仅允许三种顶层结构：`single`、`parallel_two_branch`、`decomposition_two_branch`。每个分支是有限的 embedding → encoder → adapter → head 路径，不允许分支再次嵌套组合。

两支默认不共享参数；本轮不新增任意分支参数共享配置。总参数量按实际唯一参数统计，包含 adapter、gate、两支 head。限制最大层数、序列展开大小和预算，超限在训练前报告。

### 6.2 decomposition

- moving average 得到 trend，residual = input - trend；两支可以独立选择已注册 encoder/head。
- 第一版在预测空间相加，限定 point 输出；禁止直接相加 Gaussian 方差或 quantile 得到未经定义的概率分布。
- 允许 trend 使用 linear、residual 使用 SSM/TimesBlock/Mamba 等受验证组合。
- 分解只作用于数值历史，不分解缺失标记；mask 作为独立条件送入各支。
- 归一化由外层统一负责，最终预测只逆变换一次；禁止各支重复逆变换。
- 拒绝与自带内部 decomposition 的模块重复分解。旧 wrapper 迁移为等价 trend-linear/residual 路径，不能假定所有新分支与旧模型数值等价。

### 6.3 融合语义

- `latent_gate`：两支为相同轴语义的 latent，经声明的宽度投影后融合。
- `history_time_gate`：两支保持同一历史 T，产生逐时刻权重；不得先池化再声称时间级融合。
- `forecast_step_gate`：两支已经产生同一 H 和目标列，权重由历史表征与 lead index 生成；不能使用真实未来标签。
- 两支加权混合统一为 `g*z1 + (1-g)*z2`。如有 residual，必须明确相加对象，不沿用含糊布尔字段。
- 第一版预测空间组合限定 point；latent/历史融合之后可连接已有合法概率 head。
- 旧 hybrid time gate 保留其旧身份或显式迁移名称，不能自动解释为新 history/forecast gate。

## 7. Schema、版本和 artifact

建议新设计使用 `model_recipe.v2` → `recipe_schema_v3`，运行时 `runtime_semantics_revision=3`。版本号是本方案拟定值，实施时须一次性贯穿 Python、Node、OpenCode 及导出。

- 新结构采用严格 discriminated union，`additionalProperties: false`；不同 encoder 只接受真实适用参数。
- 新版默认只生成 v3；提供显式 v1/v2 配置迁移，输出迁移报告与旧行为固定值，不静默升级已保存实验。
- 不将旧 `ssm`/`timesnet` 名称自动映射到新增真实模块；旧 proxy 按已知版本迁移到原轻量名称，版本不明则拒绝猜测。
- 旧 checkpoint 不重标版本；需要新组合、新 encoder 时重训。已有自包含 v2 导出包仍按其旧环境使用，不覆盖其代码或权重。
- 新 manifest 包含类型连接、adapter、有效参数、共享关系、模块实现版本、实际后端、架构身份和实验身份；保留参数图摘要与 graph 数据来源。
- CV protocol 纳入新语义版本，旧新 champion 不混比。每个 H 仍独立保存权重和指标，可在一个 bundle 内组织但不代表共享。
- 导出复制/打包必要本地模块，并声明可选后端依赖。参考后端的自包含推理不得偶然 import CUDA 扩展。
- 对外 `history`、`missing_mask` 及 point/quantile/Gaussian 输出合同不因内部类型扩展而静默改变。

## 8. 实施批次与修改落点

| 批次 | 交付物 | 主要落点 | 退出条件 |
| --- | --- | --- | --- |
| P1 可靠搜索身份 | 规范化、身份、持久化去重、事件及恢复 | 新 `py/recipe_identity.py`、bridge、candidate-utils、mutation、OpenCode proposal/service | 默认值/别名去重；不同 seed/loss/预算不误合并；并发和恢复测试通过 |
| P2 类型与版本 | 新 schema、表示类型、adapter、配置迁移、manifest | schemas、model_recipe、registry；新 `py/factory/representations.py`、`adapters.py` | 旧语义显式迁移；非法连接训练前失败；CPU 导出往返 |
| P3 真实 encoder | diagonal SSM → TimesBlock → Mamba-1 | 新 `py/factory/encoders/`；factory、registry、doctor、可选依赖 | 三者各自机制/梯度/参考对齐；能力不足明确拒绝 |
| P4 受控组合 | 双分支、decomposition、历史/预测步 gate | 新组合模块、编译器、head、预算检查、mutation | 不嵌套、不隐式共享；gate、mask、归一化与概率限制测试通过 |
| P5 集成验收 | 跨端一致性、搜索循环、训练与导出、验证报告 | train/cv/export、execution_contract、prompts、examples、tests、docs | 每项已验证/未验证证据明确，研究循环不重复计证据 |

P1 可先作用于 v2，P2 引入 v3 后扩展身份协议并递增规范化版本。每批都同步相关测试，不将测试全部推迟到 P5。新增逻辑拆成模块，不继续把所有实现塞入 `build_model.py`。

OpenCode 涉及的 schema/prompt/service 文件实施前须遵循其子项目 AGENTS.md；本方案阶段不修改该子项目代码。

## 9. 验证矩阵与验收标准

### 9.1 自动化测试

1. Schema/registry/compiler：新增动作、非法参数、类型连接、旧配置迁移及三端 golden fixtures。
2. 机制：状态递推、TimesBlock 周期与二维卷积、Mamba selection、gate 权重、分支梯度、字段有效性。
3. 数据隔离：mask 可达目标、fold 内拟合 graph/填补/缩放；不因新模块读取验证或 ref-test 标签。
4. 去重：更换名字不能绕过；同架构不同 seed/loss 不误删；失败可重试；并发只执行一次；缺损 artifact 不复用；预算耗尽能结束。
5. 训练与导出：三个 encoder 的 point/quantile/Gaussian 合法单分支路径、point 双分支、保存加载数值往返、每 H 权重独立。
6. 资源：参考后端 CPU 可用；显式不可用 CUDA 请求报错；adapter/branch/gate 参数都计入预算；无隐式降级。

建议复用现有测试入口并新增专门的 identity、typed composition、各 encoder 测试模块。完整运行 `neo_cast` 的 `npm test` 和 Python unittest；OpenCode 运行相关 research 测试、typecheck，并报告全量 research 结果。

上一轮完整 research 检查的两个失败（缺少 `quantitative.json` fixture、plateau 25/7 轮不一致）须在实施前重新确认基线；若 P1 触及 plateau/计数，应新增针对本轮语义的测试并排查关联，不能直接归为旧失败而忽略新回归。

### 9.2 数值与实验验证

- 上游参考代码在实施时固定 commit、记录许可证/来源。不能以可变 `main` 作为长期复现标识。
- 小尺寸 FP32 前向和梯度对齐先使用 `atol=1e-5, rtol=1e-4`；不满足时调查差异，不静默放宽。长序列及混合精度单列容差与原因。
- 第一层：合成任务、短 CPU 训练确认 loss/梯度有限；不据此宣称效果更好。
- 第二层：沿用 ETTh1 训练区间内部 holdout，至少三个 seed；固定输入窗口、采样、优化器和更新预算，同时报告参数量、耗时和内存。
- 比较 linear、现有两个轻量模块、三个新 encoder；相同更新次数不等于相同算力，报告不得混淆。
- 对 P4 至少验证 linear+SSM、linear+TimesBlock、linear+Mamba 的分解组合以及时间 gate 消融；效果不升不自动算实现失败，但机制无效必须修正。
- 若硬件无法完成 Mamba 加速对齐，则只能验收参考后端，明确保留加速未验证状态。不下载大型预训练权重，不动 ref-test，不自动晋升 champion。

## 10. 完成定义与风险

完成需要：P1—P5 的适用退出条件全部满足；三个名称对应真实机制；同实验可可靠去重；不同有效机制和独立重复实验不会误删；模型组合在类型、数据、输出分布与预算上可检查；训练/导出一致；新旧版本及每 H 独立性明确。

主要风险及约束：

- Mamba 参考 scan 较慢：限制默认搜索预算，性能不作为机制真实性替代品。
- TimesBlock 逐样本选频与官方 batch 选频不同：公开差异、逐样本对齐，不宣称原生复现。
- `[B,C,T,D]` 内存增长：预估张量规模并限制搜索，不能自动池化改变模型。
- 双分支搜索空间膨胀：只有两个分支、一层组合、有限融合点；新增配置先有有效性测试再进入生成器。
- 去重错误比漏去重风险更大：只对白名单等价硬去重，对行为相似保留诊断。

跨 H 共享和原生 TimesNet 不属于完成标准，也不为它们预埋未实现的可选配置。

## 11. 设计参考

- [Diagonal SSM 参数化与初始化论文](https://arxiv.org/abs/2206.11893)：提供背景；本方案的实数 diagonal SSM 不宣称完整 S4D 复现。
- [TimesNet 官方实现](https://github.com/thuml/Time-Series-Library/blob/main/models/TimesNet.py)：TimesBlock 机制来源；本方案明确改变周期选择批次语义并省略原生预测扩展。
- [Mamba 论文](https://arxiv.org/abs/2312.00752)与[Mamba-1 block](https://github.com/state-spaces/mamba/blob/main/mamba_ssm/modules/mamba_simple.py)：用于固定 variant、selective scan 和参考对齐边界。
