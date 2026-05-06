# NeoResearch 自主小模型设计任务使用指南

> 适用场景：使用 NeoResearch TUI 完成一次 time-series forecasting 小模型设计任务。  
> 推荐对象：希望用本地 CSV 数据集、Neo-Cast runner 和多 Agent 流程自动搜索轻量模型的研究者。  
> 示例任务：在 `ETTh1.csv` 或 `electricity.csv` 上预测目标列 `OT`，输入窗口 `96`，预测长度 `24`，优化 `val_avg_mse`。

## 1. 你要完成的任务是什么

NeoResearch 的一次自主小模型设计任务，不是单次训练命令，而是一条可追踪的研究流程：

```text
确认预测目标
  -> 创建 Research Task
  -> 准备 Neo-Cast dataset contract
  -> Data Analysis Agent 分析数据
  -> HypoPlanner Agent 形成建模假设
  -> ModelDesigner Agent 生成候选小模型
  -> ModelCompiler Agent 转成可运行 recipe
  -> TrainEval Agent 调用 runner 训练/验证
  -> Reflection Agent 复盘结果并决定下一轮
  -> Publish Agent 导出 bundle
```

所谓“小模型”，在当前 TSF 场景里通常指：

- 参数量优先受控，例如偏好 `2M` 参数以下。
- 模型结构尽量可解释，例如 DLinear、Patch-based、轻量 MLP、instance normalization、简单 season/trend decomposition。
- 指标接近时优先选择更轻、更稳定、更容易部署的 candidate。

## 2. 启动前检查

进入项目后，建议先确认 Neo-Cast runner 可用：

```bash
cd neo_cast
npm install
node ./bin/neo-cast.js init-runtime
node ./bin/neo-cast.js doctor
```

如果你主要在 TUI 中操作，可以从 `opencode/packages/opencode` 启动 NeoResearch TUI。具体启动命令以你的本地入口为准，常见路径是：

```bash
cd opencode/packages/opencode
bun run src/index.ts
```

关键目录含义：

| 路径 | 用途 |
| --- | --- |
| `neo_cast/` | Neo-Cast runner 根目录，必须能找到 `py/validate.py`。 |
| `.neo-research/` | Research Task、Candidate、Run、Artifact、Memory 等研究状态。 |
| `neo_cast/.neo-cast/` | Neo-Cast runtime、prepared dataset、runner artifact。 |
| `datasets/*.csv` | 本地时间序列数据集。 |

## 3. 推荐交互模式

NeoResearch TUI 里常见两种交互模式：

| 模式 | 适合场景 | 行为 |
| --- | --- | --- |
| `socratic` / 苏格拉底 | 任务信息还不完整，需要系统先追问。 | Intent Agent 会问清楚数据集、目标列、horizon、指标，再继续。 |
| `companion` / 认知伴随 | 你希望系统推进，但关键节点要你确认。 | Data analysis、search space、candidate gate 等阶段会出现 checkpoint。 |

如果目标是“自主小模型设计”，建议：

1. 第一次跑新数据集，用 `socratic`，让系统帮你补齐任务规格。
2. 已经清楚数据集和指标，用 `companion`，在关键阶段做人工确认。
3. runner 和 dataset 都稳定后，用 `Agent Loop` 进入自动搜索。

## 4. 创建一个 TSF 任务

### 方式 A：从 Home 输入自然语言目标

在 Home 输入框中输入：

```text
Forecast ETTh1 target OT horizon 24 context 96, optimize val_avg_mse, prefer small models under 2M params.
```

然后选择交互模式。系统会创建一个 Research Task，并进入 Cockpit。

### 方式 B：从 CSV 创建任务

点击顶部 `New CSV Task`，或输入 slash command：

```text
/csv
```

在数据集输入框中填写：

```text
/Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf/datasets/ETTh1.csv target=OT horizon=24 context=96 full
```

常用参数：

| 参数 | 示例 | 含义 |
| --- | --- | --- |
| CSV 路径 | `/path/to/ETTh1.csv` | 本地数据集。 |
| `target=` | `target=OT` | 被预测目标列。 |
| `horizon=` | `horizon=24` | 预测长度。 |
| `context=` | `context=96` | lookback/input window。 |
| `full` | `full` | 使用完整 recipe 能力。 |
| `bridge` | `bridge` | 使用兼容 Neo-Cast 的桥接模式。 |

创建成功后，左侧会显示 onboarding 信息，右侧会显示当前任务、下一步建议、runner 状态和 AutoResearch 进展。

## 5. 读懂 Cockpit 界面

Cockpit 可以按四块理解：

| 区域 | 作用 |
| --- | --- |
| 顶部导航 | 切换任务、创建任务、seed baselines、启动 agent loop、导出 bundle、中止操作、切换模式。 |
| 左侧主工作区 | 显示用户输入、Research Agent 输出、checkpoint、运行事件和错误。 |
| 底部交互框 | 输入自然语言、slash command、审批或请求导出。Working 时会显示动作名、动态条和计时。 |
| 右侧状态栏 | 判断当前是否能继续，重点看 `下一步`、`Runner`、`AutoResearch进展`。 |

底部交互框示例：

```text
Working / prepare-dataset / 3s [===>    ]

请求建议、批准 checkpoint，或导出 bundle...

认知伴随 Data Analysis Agent GLM-5.1
```

这表示当前正在执行 `prepare-dataset`，已经运行 3 秒。空闲时 Working 行会消失。

## 6. 先让 Runner 变成 ready

右侧 `Runner` 是能否真正执行训练/验证的关键。

常见状态和处理方式：

| Runner 状态 | 含义 | 处理方式 |
| --- | --- | --- |
| `ready` | runner 可用，dataset 也匹配当前 task。 | 可以继续 seed、agent loop 或 train/eval。 |
| `Runner root missing` | 当前 task 没有 Neo-Cast runner root。 | 点击 `Use Project Runner`，或运行推荐动作。 |
| `Runner script missing` | runner root 指错目录，找不到 `py/validate.py`。 | 把 runner root 修正到 `neo_cast/`。 |
| `Runner dataset mismatch` | 已准备 dataset 与当前 task 不匹配。 | 点击 `Prepare Dataset` 或在输入框说“开始预测”。 |

如果右侧显示：

```text
Runner dataset mismatch
Prepared dataset does not match task
Prepare Dataset
```

说明 runner 路径已经找到了，但 dataset contract 不匹配。此时优先执行 `Prepare Dataset`，不要急着点 `Agent Loop`。

可用操作：

```text
/prepare-dataset
```

或直接在交互框输入：

```text
开始预测
```

系统会把它理解为执行右侧推荐动作。

## 7. 生成初始候选模型

当 runner ready 后，通常先生成 baseline candidates：

```text
/seed-baselines
```

也可以点击顶部：

```text
Seed Baselines
```

成功后，右侧任务区会从类似：

```text
Candidate 0/0
```

变成：

```text
Candidate 1/3
```

这说明系统已经有可评估的候选模型。baseline 通常包括简单统计模型、DLinear 类模型、轻量 patch 模型或启发式 fallback。

如果点击没有反应，先看右侧：

- Runner 是否还不是 `ready`。
- 是否有 pending checkpoint。
- 顶部按钮是否是灰色。
- 底部 Working 是否正在执行另一个动作。

## 8. 启动自主小模型设计循环

runner ready 且有候选后，可以启动自动研究循环：

```text
/agent-loop
```

或点击顶部：

```text
Agent Loop
```

Agent Loop 会尝试完成这些事情：

1. 根据数据画像和历史结果设计候选。
2. 编译候选为 runner 可执行 recipe。
3. 调用 Neo-Cast runner 训练和验证。
4. 读取 `val_avg_mse` 等指标。
5. 更新 champion。
6. 记录失败原因和经验。
7. 进入下一轮，直到预算、plateau、approval 或目标条件触发停止。

推荐给 Agent 的目标可以写得更具体：

```text
请围绕 OT 预测做小模型搜索，优先尝试 2M 参数以下、推理稳定、可解释的候选。主指标 val_avg_mse，辅助看 val_avg_mae。如果指标接近，选择更轻量的模型。
```

如果正在运行，顶部 `Abort` 会变亮，底部交互框会显示 Working 动态条。需要中止时可以点 `Abort` 或按 `Esc`。

## 9. 读懂 AutoResearch 进展

右侧 `AutoResearch进展` 是判断阶段的核心。

符号含义：

| 符号 | 含义 |
| --- | --- |
| `✓` | 已完成。 |
| `→` | 当前阶段或下一步重点。 |
| `•` | 尚未开始或等待前置条件。 |

阶段含义：

| Agent | 作用 | 你应该关注什么 |
| --- | --- | --- |
| `Intent Agent` | 解析目标、数据集、指标、预算和约束。 | 目标列、horizon、context 是否正确。 |
| `Data Analysis Agent` | 生成 profile，分析缺失、趋势、季节性、shift、相关性。 | 数据画像是否符合你的领域认知。 |
| `HypoPlanner Agent` | 根据 profile 提出建模假设。 | 是否适合小模型，例如 trend/seasonal 是否明显。 |
| `ModelDesigner Agent` | 设计候选模型或 recipe。 | 候选是否满足轻量、稳定、可解释。 |
| `ModelCompiler Agent` | 把候选转成可运行配置。 | 是否出现 schema 或 recipe 编译错误。 |
| `TrainEval Agent` | 调 runner 训练/验证。 | run 是否成功，主指标是否改善。 |
| `Reflection Agent` | 分析成败，提出下一轮改进。 | 是否陷入无改进、失败重复或预算不足。 |
| `Publish Agent` | 汇总 champion 和 evidence，导出报告。 | 是否已经有可交付结果。 |

## 10. Checkpoint 和审批

在 `companion` 模式下，系统可能暂停并等待你确认。

常见 checkpoint：

| checkpoint | 意义 | 推荐回复 |
| --- | --- | --- |
| requirements confirmed | 任务规格确认。 | “确认，继续。” |
| data analysis done | 数据分析完成。 | “分析合理，继续。” 或指出异常。 |
| search space confirmed | 搜索空间确认。 | “优先小模型，继续。” |
| candidate approval | 候选需要批准。 | `/approve` 或 `/reject`。 |

你可以直接输入：

```text
确认，继续
```

或者使用 slash command：

```text
/approve
/reject
```

## 11. 如何判断结果是否可用

一个自主小模型设计任务通常至少要看到这些结果：

| 检查项 | 说明 |
| --- | --- |
| 至少一个 succeeded run | 说明 runner 成功训练/验证过候选。 |
| 有 primary metric | 例如 `val_avg_mse=0.049124`。 |
| 有 champion | 当前最佳 candidate 已被记录。 |
| 有 reflection | 系统解释为什么选择或放弃某些方向。 |
| 有 artifact | 包含 profile、run plan、leaderboard、report 或 bundle。 |

右侧如果出现类似：

```text
最佳 run=run_...
最佳 val_avg_mse=...
```

说明至少已经形成可比较结果。

不要只看“Agent 说完成了”。以右侧任务状态、Run History、Champion 和导出 artifact 为准。

## 12. 导出最终 bundle

当你看到有 champion 或 Publish Agent 进入可执行状态时，可以导出：

```text
/export
```

或点击：

```text
Export Bundle
```

导出 bundle 应包含：

- 任务规格：dataset、target、context、horizon、metric。
- 数据画像和分析报告。
- 候选模型列表。
- run history 和主指标。
- champion 及选择理由。
- 失败实验和反思记录。
- 可复现实验配置或 runner artifact。

## 13. 一条推荐操作路径

如果你只是想完成一次标准自主小模型设计，可以按这个路径走：

```text
1. New CSV Task
2. 选择 socratic 或 companion
3. 输入 CSV path target=OT horizon=24 context=96 full
4. 看右侧 Runner
5. 如果 dataset mismatch，执行 Prepare Dataset
6. Runner ready 后执行 Seed Baselines
7. 确认 Candidate > 0
8. 执行 Agent Loop
9. 根据 checkpoint 输入“确认，继续”或 /approve
10. 查看 best metric 和 champion
11. Export Bundle
```

对应可复制输入：

```text
/csv
```

```text
/path/to/ETTh1.csv target=OT horizon=24 context=96 full
```

```text
/prepare-dataset
```

```text
/seed-baselines
```

```text
/agent-loop
```

```text
/export
```

## 14. 常见问题

### 为什么 `Abort` 是灰色的

灰色表示当前没有正在执行的可中止操作。只有正在请求模型、准备数据集、seed baseline、agent loop 或 runner 执行时，`Abort` 才会变亮。

### 为什么刚开始右侧进展已经显示很多 Agent

右侧进展是“完整研究流程地图”，不是全部都已经执行。看符号：

- `✓` 才是完成。
- `→` 是当前或下一步。
- `•` 是未开始。

### 为什么显示 `Prepared dataset does not match task`

这是 dataset contract 不一致。常见原因：

- 上一次准备的是 `ETTh1.csv`，这次任务是 `ETTm2.csv`。
- 上一次 horizon 是 `[96,192,336,720]`，这次任务是 `[24]`。
- 目标列、context length 或 CSV 路径变化。

处理方式：执行 `Prepare Dataset`，让 `.neo-cast/dataset_spec.json` 重新匹配当前 task。

### 为什么 Seed Baselines 没反应

优先检查：

1. Runner 是否 ready。
2. 当前是否已有 busy action。
3. 是否有 checkpoint pending。
4. 顶部按钮是否灰色。
5. 是否可以用 `/seed-baselines` 触发同一动作。

### 什么时候用自然语言，什么时候用 slash command

| 输入方式 | 适合场景 |
| --- | --- |
| 自然语言 | 解释状态、提出约束、要求建议、审批 checkpoint。 |
| slash command | 明确执行动作，例如 prepare、seed、loop、export。 |

例如：

```text
请解释当前为什么不能开始 Agent Loop
```

适合自然语言。

```text
/agent-loop
```

适合明确启动动作。

## 15. 小模型设计建议

为了让系统更容易找到可用小模型，可以在任务描述里明确这些偏好：

```text
优先小模型，参数量控制在 2M 以下；指标接近时选择更轻量、更稳定、更可解释的模型；避免复杂 ensemble；允许 DLinear、Patch-based backbone、instance_norm、AdamW、cosine schedule。
```

也可以追加约束：

```text
如果连续 3 轮 val_avg_mse 没有改善，请停止扩大模型，优先做输入窗口、归一化、学习率和 trend/seasonal decomposition 的小范围搜索。
```

这样 Reflection Agent 和 ModelDesigner Agent 会更容易围绕“小而稳”的方向迭代。

