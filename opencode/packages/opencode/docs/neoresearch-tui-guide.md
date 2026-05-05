# NeoResearch TUI 界面说明

本文档说明 NeoResearch Cockpit TUI 中各个按钮、区域和状态的含义。该界面面向 TSF 自主研究任务，用于创建任务、检查数据、驱动 Agent 搜索候选模型、运行 Neo-Cast runner、导出结果，并在需要时进行人工确认。

## 整体布局

界面分为四个主要区域：

- 顶部导航栏：任务切换、任务创建、运行控制和模式切换。
- 左侧主工作区：展示 Research Agent 的日志、提示、checkpoint 和操作结果。
- 底部输入区：输入自然语言指令、审批 checkpoint、调用 slash command。
- 右侧状态栏：显示当前任务、下一步建议、runner 健康状态、AutoResearch 阶段进展和上下文信息。

## 顶部导航栏

| 按钮 | 功能 | 典型使用场景 |
| --- | --- | --- |
| `Home` | 返回 NeoResearch 工作台首页。 | 查看任务列表或退出当前 cockpit 视图。 |
| `Previous Task` | 切换到上一个研究任务。 | 当前 workspace 有多个 research task，需要快速查看前一个任务状态。 |
| `Next Task` | 切换到下一个研究任务。 | 多任务并行时切换查看。 |
| `New CSV Task` | 从 CSV 创建新的 TSF 研究任务。 | 导入新的时间序列数据集，创建预测任务。 |
| `Seed Baselines` | 为当前任务生成或补齐基础候选模型。 | 任务刚创建后，需要先生成 baseline 候选。 |
| `Agent Loop` | 启动自动研究循环。 | runner 就绪后，让系统自动执行候选生成、运行、评估、反思和下一轮搜索。 |
| `Export Bundle` | 导出当前任务结果包。 | 保存实验报告、候选模型、指标、运行日志等产物。 |
| `Abort` | 中止当前正在执行的操作。 | 后台请求、Agent 输出或长时间运行卡住时使用。灰色表示当前没有可中止任务。 |
| `Mode ...` | 切换交互模式。 | 在认知伴随 / 苏格拉底等模式之间切换人工参与强度。 |

按钮颜色通常表示可用性：

- 高亮橙色：当前可执行或主要操作。
- 灰色：当前不可执行，通常因为没有选中任务、runner 未就绪、已有任务忙碌中，或该动作不适用于当前模式。

## 左侧主工作区

左侧大区域是 Cockpit 的主输出流。它会显示：

- Research Agent 的状态消息。
- 用户输入过的指令。
- 系统执行动作后的结果，例如 `runner root set for TSF Autonomous Research`。
- Companion checkpoint 提示。
- 后台执行过程中的动态输出和错误信息。

如果看到：

```text
Companion checkpoint: review the proposed next step, approve gates, or ask for a recommendation.
Research Agent: runner root set for TSF Autonomous Research
```

表示当前处于认知伴随模式，系统会在关键步骤前停下来让用户确认；同时 runner root 修复动作已经执行过。

## 底部输入区

底部输入框用于和 Research Agent 交互。可以输入：

- 自然语言请求，例如“继续下一步”“分析为什么 runner 不 ready”“导出当前结果”。
- checkpoint 审批，例如“同意”“继续”“批准”。
- slash command，通过 `ctrl+p commands` 或输入 `/` 调出命令菜单。

输入框下方状态行通常显示：

```text
认知伴随 Intent Agent GLM-5.1
```

含义是当前交互模式、当前 Agent 阶段和当前模型。

底部快捷提示：

| 提示 | 含义 |
| --- | --- |
| `esc interrupt` | 使用 `Esc` 中断当前交互或后台输出。 |
| `tab agents` | 使用 `Tab` 切换或查看 Agent 相关入口。 |
| `ctrl+p commands` | 打开命令面板。 |

## 右侧状态栏

右侧状态栏是判断当前系统是否能继续运行的主要区域。

### 标题区

显示当前选中的任务名称，例如：

```text
TSF Autonomous Research
```

### 任务区

```text
任务
Task 1/3 · Candidate 0/0
```

表示当前是任务列表中的第 1 个任务，共 3 个任务；当前候选模型数量是 0，共 0 个候选。

### 下一步区

```text
下一步
Configure Neo-Cast runner
Set runner root before runs.
```

表示系统认为当前最优先要处理 runner 配置。只有 runner ready 后，`Agent Loop` 和实际实验运行才有意义。

### Runner 区

常见状态包括：

| 状态 | 含义 | 处理方式 |
| --- | --- | --- |
| `ready` | runner 已配置且可运行。 | 可以继续 Agent Loop 或候选执行。 |
| `Runner root missing` | 任务没有配置 `taskSpec.runtime.neoCastProjectRoot`。 | 点击 `Use Project Runner` 或手动填写 runner root。 |
| `Runner script missing` / `Missing py/validate.py` | runner root 指到了错误目录，目录下没有 `py/validate.py`。 | 把 runner root 改成 Neo-Cast 项目根目录。 |
| `Runner Python missing` | Neo-Cast runtime 还没初始化。 | 在 runner root 下初始化 runtime。 |
| `Runner dataset mismatch` | runner 已准备的数据集 spec 与当前任务不一致。 | 重新准备数据集，确保 dataset spec 与 taskSpec 匹配。 |

`Use Project Runner` 会自动把当前项目中的 Neo-Cast runner root 写入任务配置。它适合解决 runner root 缺失或指错路径的问题；如果路径正确但仍然 `dataset mismatch`，需要重新准备数据集。

## AutoResearch 进展区

```text
▾ AutoResearch进展
✓ Intent Agent
→ Data Analysis Agent
• NAS Agent 0/12 runs
• Publish Agent
```

符号含义：

| 符号 | 状态 |
| --- | --- |
| `✓` | 已完成。 |
| `→` | 当前进行中或下一步应该执行。 |
| `•` | 未开始或等待前置条件。 |

各 Agent 含义：

| Agent | 作用 |
| --- | --- |
| `Intent Agent` | 解析研究目标、任务类型、数据集、指标和约束。 |
| `Data Analysis Agent` | 检查数据集、生成 profile、识别缺失值、趋势、季节性、相关性和目标列。 |
| `NAS Agent` | 根据预算搜索候选模型并运行实验。`0/12 runs` 表示最多 12 次运行，目前 0 次完成。 |
| `Publish Agent` | 汇总最佳结果，生成报告、bundle 或可交付产物。 |

数据摘要示例：

```text
需求摘要 指标=val_avg_mse
数据=ETTh1.csv / 目标=OT / 预测=24 /
Profile rows=17420 / targets=1
missing=0 / trend=0.623583
seasonal=0.154844 / xcorr=0
shift=1.08905
```

这表示主要优化指标、数据集、目标列、预测步长和 Data Analysis Agent 提取的数据特征。

## Context 区

```text
Context
model GLM-5.1
session -
```

表示当前调用模型和 session 信息。`session -` 表示当前没有绑定外部 session ID，或 session 信息未展示。

## 版本区

右下角通常显示：

```text
.../opencode
NeoResearch v0.1.0-alpha.0
```

表示当前 TUI 所在工作目录尾部和 NeoResearch 版本。

## 当前截图状态判断

如果右侧显示：

```text
Runner dataset mismatch
Prepared dataset does not match task
```

说明 runner root 和 `py/validate.py` 已经找到了，但 `.neo-cast/dataset_spec.json` 中记录的数据集、预测长度、输入长度或目标列，与当前任务的 `taskSpec` 不匹配。

推荐处理顺序：

1. 确认当前任务确实要使用目标数据集、目标列和预测长度。
2. 确认 runner root 指向当前项目的 `neo_cast` 目录。
3. 重新执行数据准备或 Data Analysis 流程，让 `.neo-cast/dataset_spec.json` 与当前任务一致。
4. 右侧 Runner 变为 `ready` 后，再点击 `Agent Loop`。
