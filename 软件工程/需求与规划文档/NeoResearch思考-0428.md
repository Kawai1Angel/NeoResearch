这个 **AutoResearch 想法是有潜力的**，而且方向比单纯 AutoML 更有意思。它真正有价值的地方不是“自动调参”，而是把 **需求理解、文献调研、数据分析、模型设计、实验迭代、报告生成** 串成一个闭环。

核心设想可以概括成：

> 给定一个研究需求、一些背景知识和数据，让系统自动完成小模型的设计、训练、调优、实验分析，并输出模型参数、网络结构和实验报告。

这个方向很合理，尤其适合放在 **小模型自动设计与调试** 这个场景里。因为小模型相比大模型有几个优势：

1. **实验成本可控**
   可以真的跑很多轮实验，而不是只停留在“生成想法”。
2. **搜索空间明确**
   网络结构、训练策略、超参数、蒸馏方案、剪枝策略、路由结构等都可以形式化。
3. **结果容易验证**
   accuracy、latency、FLOPs、参数量、显存、推理速度、泛化能力都能量化。
4. **比通用 AutoResearch 更容易做出闭环系统**
   如果一开始就说“自动做科研”，范围太大；但如果说“自动进行面向小模型设计的研究循环”，就更具体、更可落地。

## 这个想法最亮的点

我觉得最有价值的是这条链路：

**用户需求 / vibe → 知识与数据 → 自动调研 → 自动假设生成 → 模型搜索 → 训练迭代 → 实验报告**

这比传统 AutoML 多了两层东西：

第一，**研究语义层**。
传统 AutoML 往往只接受一个固定任务和指标，比如“在 CIFAR-10 上最大化 accuracy”。但你的系统可以接受更模糊、更研究型的需求，例如：

> 我想要一个轻量、可解释、适合边缘端部署的分类模型。
> 我希望模型结构有一点个性化 routing。
> 我希望在小数据场景下效果稳定。

这就不是普通 NAS 或 HPO 能直接处理的。

第二，**文献等先验知识和实验设计调参Action双驱的搜索层**。
模型搜索不应该是盲搜，而应该根据文献、历史实验和用户给的 prior 来决定搜索方向。例如看到用户提到 “CAN~Router”，系统就应该优先探索 router、conditional computation、personalized network、mixture-of-experts-like lightweight routing 等相关结构。

这会让你的 AutoResearch 和普通 AutoML / Data Science Agent 区分开。

## 现在最需要加强的地方

目前 slide 里的结构有点像功能列表，但还没有体现出“研究闭环”的机制。

我建议你把它明确成一个 loop：

**1. Understand**
把用户输入的 vibe、知识、数据转成可优化目标。

例如：

```text
需求：轻量、个性化、适合小数据
转化为：
- 参数量 < 5M
- latency < 20ms
- accuracy 最大化
- 支持 personalized routing
- 小样本验证集表现稳定
```

**2. Research**
自动调研相关方法，提取可用设计先验。

**3. Propose**
生成若干候选研究假设。

例如：

```text
H1: 在 shared backbone 上加入轻量 router 可以提升个性化效果。
H2: 使用 task-aware routing 比固定结构更适合多用户数据。
H3: 在小数据下，先蒸馏再路由搜索比端到端搜索更稳定。
```

**4. Coding and Excuation**
自动写代码、训练、记录结果、分析失败原因。

**5. Reflect and Iteration**
根据结果决定下一轮实验，而不是随机继续搜索。

例如：

```text
如果 router 提升 accuracy 但 latency 超标：
下一轮减少 expert 数量或使用 top-1 routing。

如果模型过拟合：
下一轮增加正则、数据增强或冻结 backbone。
```

**6. Report**
输出不仅是结果，还包括“为什么这样设计”。

这一步很重要，因为你强调的是 Research，不只是 AutoML。

## 强调的核心创新点

我建议你不要把它包装成“通用 AutoResearch”，而是包装成：

> **Autonomous Research Agent for Small Model Design and Optimization**

或者更具体一点：

> **A Literature-Guided Autonomous Research Framework for Small Model Architecture Design**

它和已有方向的区别可以这样讲：

| 方向                       | 做什么                       | 局限                             | 你的系统补充                     |
| -------------------------- | ---------------------------- | -------------------------------- | -------------------------------- |
| AutoML / NAS               | 自动搜索模型结构或超参数     | 目标通常固定，缺少研究语义       | 加入用户需求、文献知识、实验反思 |
| Data Science Agent         | 自动分析数据、写代码、跑实验 | 不一定能做模型结构创新           | 加入架构搜索和训练闭环           |
| FARS / AutoResearch 类系统 | 自动做科研流程               | 可能太泛，实验验证弱             | 聚焦小模型，实验成本可控         |
| LLM Agent                  | 生成想法和代码               | 容易 hallucination，不一定能验证 | 强制每轮实验验证和报告           |

这样你的定位会清楚很多。

## 我觉得一个更强的系统图可以这样画

你现在的结构是：

```text
Input → Search → Output
```

可以改成：

```text
User Requirement
     ↓
Requirement Formalizer
     ↓
Literature & Knowledge Retriever
     ↓
Hypothesis Generator
     ↓
Experiment Planner
     ↓
Model / Training Search Engine
     ↓
Evaluator
     ↓
Reflection & Next-round Planning
     ↓
Research Report + Best Model
```

其中最关键的是 **Evaluator → Reflection → Planner** 这个闭环。
没有这个闭环，它像 AutoML；有了这个闭环，才像 AutoResearch。

## 我会建议你把“vibe”具体化

“给出需求 vibe”这个表达很有意思，但在正式讲的时候可以换成：

> high-level research intent
> soft design preference
> natural-language research objective

例如用户输入：

```text
我想要一个轻量、个性化、适合边缘端部署的小模型。
```

系统需要自动解析成：

```text
Hard constraints:
- 参数量 < 3M
- latency < 10ms
- 显存 < 1GB

Soft objectives:
- 个性化能力强
- 泛化稳定
- 结构可解释

Search priors:
- router-based architecture
- conditional computation
- lightweight adapter
- knowledge distillation
```

这会让“自然语言科研需求 → 可执行实验目标”成为你的一个亮点。

## 可能的风险

最大风险是范围太大。

如果你说系统能“自动调研文献、自动做数据分析、自动搜索模型、自动训练、自动写报告”，听众可能会觉得像一个大而全的 agent，创新点不够聚焦。

所以我建议你强调三个关键词：

**小模型设计、文献引导、闭环实验。**

也就是：

> 不是泛泛地自动做科研，而是自动完成小模型架构设计中的研究循环。

第二个风险是“自动调研文献”容易变成表面功能。
你需要说明文献不是拿来总结的，而是变成 search prior，例如：

```text
论文发现：router-based personalization 在异构数据上有效。
系统动作：扩大 routing module 的搜索空间，优先尝试 top-k router。
```

第三个风险是“实验报告”不能只是把日志整理出来。
好的 AutoResearch 报告应该包括：

```text
- 最终模型结构
- 训练配置
- 搜索过程
- 每轮实验假设
- 失败实验分析
- 消融实验
- 与 baseline 对比
- 下一步建议
```

这样才有研究价值。

