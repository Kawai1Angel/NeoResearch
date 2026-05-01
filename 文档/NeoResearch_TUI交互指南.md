# NeoResearch TUI 交互指南

> 适用对象：第一次使用 NeoResearch TUI 的研究者或开发者  
> 适用界面：Home 启动页 + Cockpit 研究工作区  
> 当前快捷键以代码中的最新 TUI 为准：Home 返回为 `alt+h`，Candidate 切换为 `alt+left` / `alt+right`

---

## 1. TUI 的两个主界面

NeoResearch TUI 主要分成两个界面：

| 界面 | 用途 |
|---|---|
| Home | 启动页。输入研究目标、创建 CSV 任务、打开 Cockpit、查看 doctor 提示。 |
| Cockpit | 研究工作区。查看任务、候选模型、运行记录、数据画像、实验 artifact、记忆、Champion，并执行下一步操作。 |

典型使用路径：

```text
Home 输入研究目标或创建 CSV Task
  → 进入 Cockpit
  → 配置 runner
  → /next 或 /agent-loop 开始实验
  → 查看 Candidate / Run / Champion
  → Export Bundle
```

---

## 2. Home 启动页

Home 页包含：

- 顶部 `NEO RESEARCH` ASCII banner
- 中间输入框
- `Planner / Research Agent` 状态行
- 操作入口：`New CSV Task`、`Open Cockpit`、`Run Doctor`
- 底部提示：`enter submit`、`ctrl+p api-key / cockpit / csv / doctor`

### 2.1 直接输入研究目标

在 Home 的输入框中输入自然语言目标，然后按 `Enter`：

```text
Forecast ETTh1 horizon=24 target=OT context=96
```

结果：

1. TUI 进入 Cockpit。
2. 系统先弹出 `Interaction mode`，要求选择交互模式。
3. 选择 `1 companion` 会创建偏人工确认的 `review` task；选择 `2 socratic` 会创建偏自主执行的 `autonomous` task。
4. 如果选择 `socratic` 且 Neo-Cast runner 已就绪，会自动进入 prepare/profile/loop 流程。
5. 如果 runner 未就绪，只创建任务，不会强行启动失败的实验。

适合场景：

- 你还没有具体 CSV 参数，只想先描述研究目标。
- 你希望系统自动生成完整 recipe，并进入自主研究流程。

### 2.2 从 CSV 创建任务

点击 `New CSV Task`，或按 `ctrl+n`，或在输入框输入：

```text
/csv
```

进入 Cockpit 后会先弹出 `Interaction mode`，选择模式后再弹出 `CSV dataset path` 输入框，填写：

```text
/path/to/ETTh1.csv target=OT horizon=24 context=96 full
```

也支持多目标、多 horizon：

```text
/data/ETTh1.csv target=OT,HUFL horizon=24,48 context=192 preset=etth1 full
```

参数含义：

| 参数 | 示例 | 含义 |
|---|---|---|
| CSV 路径 | `/data/ETTh1.csv` | 本地数据集文件路径。 |
| `target=` | `target=OT` | 预测目标列，多个列用逗号分隔。 |
| `horizon=` | `horizon=24,48` | 预测长度，多个 horizon 用逗号分隔。 |
| `context=` | `context=96` | 输入上下文长度。 |
| `preset=` | `preset=etth1` | 数据集预设。 |
| `full` | `full` | 使用 full-recipe 模式。 |
| `bridge` | `bridge` | 使用 bridge-only 兼容模式。 |

建议：

- 想测试最新完整能力，用 `full`。
- 想保证和 Neo-Cast 现有 runner 兼容，用 `bridge`。

### 2.3 打开 Cockpit

点击 `Open Cockpit`，或输入：

```text
/cockpit
```

只进入 Cockpit，不会自动创建新任务。

### 2.4 查看环境提示

点击 `Run Doctor`，或输入：

```text
/doctor
```

TUI 会提示你在 shell 中运行：

```bash
neo-research doctor
```

用于检查 API key、Neo-Cast runner、Python runtime 等环境。

---

## 3. Slash 命令菜单

Home 和 Cockpit 都支持 slash 命令。

### 3.1 打开命令菜单

在输入框输入：

```text
/
```

会出现 `Commands` 浮层。

常用操作：

| 操作 | 按键 |
|---|---|
| 向下选择 | `↓` 或 `ctrl+n` |
| 向上选择 | `↑` 或 `ctrl+p` |
| 执行选中命令 | `Enter` 或 `Tab` |

也可以直接输入完整命令后按 `Enter`：

```text
/next
```

### 3.2 命令面板

除 slash 菜单外，也可以按：

```text
ctrl+p
```

打开命令面板，再搜索命令。

---

## 4. Cockpit 工作区结构

Cockpit 左侧是主工作区，右侧是状态栏。

### 4.1 顶部导航栏

顶部导航栏位于 Cockpit 主区域最上方，分两行阅读：

```text
NeoResearch Workspace
Home alt+h  Previous Task ^K  Next Task ^J  New CSV Task ^N  Seed Baselines ^B  Agent Loop ^L  Export Bundle ^E
```

第一行是当前位置标题，表示你正在 Cockpit 工作区。第二行是全局操作入口，按从左到右的顺序分成四组：

| 区域 | 入口 | 用途 |
|---|---|---|
| 返回 | `Home alt+h` | 回到 Home 启动页。适合重新输入研究目标、打开 doctor 或创建新任务。 |
| 任务切换 | `Previous Task ^K`、`Next Task ^J` | 在已有 research tasks 之间切换。右侧 `Task N/M` 会同步变化。 |
| 任务/候选生成 | `New CSV Task ^N`、`Seed Baselines ^B` | 创建新的 CSV 任务，或给当前任务生成 baseline candidates。 |
| 自动化/导出 | `Agent Loop ^L`、`Export Bundle ^E` | 启动 autonomous loop，或导出当前研究 bundle。 |

导航项的显示规则：

- 橙色：当前可以执行，可以点击，也可以按对应快捷键。
- 灰色：当前条件不足，入口会保留但不会执行。例如没有 task 时 `Seed Baselines` 会灰掉；runner 未 ready 时 `Agent Loop` 会灰掉。
- 文案中的 `^K`、`^J`、`^N`、`^B`、`^L`、`^E` 分别表示 `ctrl+k`、`ctrl+j`、`ctrl+n`、`ctrl+b`、`ctrl+l`、`ctrl+e`。
- `alt+h` 用于返回 Home。这里不用 `ctrl+h`，因为很多终端会把 `ctrl+h` 当成 Backspace。
- 顶部导航是“常用快捷入口”；同样的能力也可以通过 `ctrl+p` 命令面板或 slash 命令执行。

顶部常见操作：

| 操作 | 快捷键 | 含义 |
|---|---|---|
| Home | `alt+h` | 返回 Home。 |
| Previous Task | `ctrl+k` | 切换到上一个 task。 |
| Next Task | `ctrl+j` | 切换到下一个 task。 |
| New CSV Task | `ctrl+n` | 先选择交互模式，再创建 CSV task。 |
| Seed Baselines | `ctrl+b` | 为当前任务生成 baseline candidates。 |
| Agent Loop | `ctrl+l` | 启动 autonomous loop。 |
| Export Bundle | `ctrl+e` | 导出当前研究 bundle。 |

注意：旧文档中出现过 `ctrl+h`、`ctrl+[`、`ctrl+]`，这些和终端 Backspace / Esc 存在冲突。当前交互应使用 `alt+h`、`alt+left`、`alt+right`。

### 4.2 主工作区

主工作区会展示：

- `Research Stream`：用户输入、Research Agent 输出、错误和运行状态。
- `Candidate Table`：候选模型列表。
- `Run History`：运行记录。
- `Dataset Profile`：数据集画像。
- `Artifacts`：报告、runner plan、manager trace、selection json 等。
- `Memory`：跨实验经验记忆。
- `Error Log`：最近错误记录。

### 4.3 右侧状态栏

右侧栏展示：

- 当前 task 名称、序号、状态
- 当前 candidate 序号
- runner 是否 ready
- `Progress` 工作流进度
- `Context` 数量统计
- `Recent Errors`
- `Champion`
- 当前路径与版本标记

Progress 里的 Forecaster 标记含义：

| 标记 | 含义 |
|---|---|
| `[ ]` | 尚未有成功实验。 |
| `[o]` | 已有部分成功实验。 |
| `[x]` | 成功实验数达到预算。 |

---

## 5. 创建任务后如何开始

进入 Cockpit 后，推荐优先使用：

```text
/next
```

`/next` 会执行系统推荐的下一步。它的优先级大致是：

```text
pending approval
  → profile dataset
  → seed baselines
  → run autonomous loop
  → run smoke execution
  → export report
```

如果你不知道下一步该做什么，直接用 `/next`。

---

## 6. 常用 Cockpit 命令

### 6.1 任务级命令

| 命令 | 含义 |
|---|---|
| `/next` | 执行推荐下一步。 |
| `/profile` | 生成数据集画像。 |
| `/seed-baselines` | 创建 baseline candidates。别名：`/seed`、`/baselines`。 |
| `/iterate` | 执行一次 autonomous iteration。 |
| `/agent-loop` | 执行多轮 autonomous loop。别名：`/loop`。 |
| `/approve` | 批准当前 pending approval。 |
| `/export` | 导出研究报告。别名：`/report`。 |
| `/home` | 返回 Home。 |

### 6.2 创建任务命令

| 命令 | 含义 |
|---|---|
| `/task` | 创建 autonomous TSF task。别名：`/autonomous`。 |
| `/task-full` | 创建 full-recipe autonomous task。别名：`/autonomous-full`。 |
| `/csv` | 先选择交互模式，再从 CSV 创建 task。别名：`/dataset`。 |
| `/csv-full` | 先选择交互模式，再从 CSV 创建 full-recipe task。别名：`/dataset-full`。 |
| `/review` | 创建 review task。 |
| `/review-full` | 创建 full-recipe review task。 |
| `/review-csv` | 从 CSV 创建 review task。 |
| `/review-csv-full` | 从 CSV 创建 full-recipe review task。 |

### 6.3 Runner 配置命令

| 命令 | 含义 |
|---|---|
| `/use-project-runner` | 使用当前项目路径作为 Neo-Cast runner root。别名：`/runner-root`。 |
| `/edit-runner-root` | 手动编辑 Neo-Cast runner root。 |

如果右侧栏显示 `Runner not ready` 或 `Runner runtime not ready`，先用这两个命令修复 runner。

### 6.4 Candidate 导航命令

| 命令 | 快捷键 | 含义 |
|---|---|---|
| `/candidate-next` | `alt+right` | 切换到下一个 candidate。 |
| `/candidate-previous` | `alt+left` | 切换到上一个 candidate。 |
| `/task-next` | `ctrl+j` | 切换到下一个 task。 |
| `/task-previous` | `ctrl+k` | 切换到上一个 task。 |

Candidate 命令别名：

- `/cand-next`
- `/candidate-prev`
- `/cand-prev`
- `/task-prev`

### 6.5 Candidate 操作命令

| 命令 | 含义 |
|---|---|
| `/ref-gate` | 请求 reference test approval。别名：`/ref`。 |
| `/seed-sweep` | 对当前 candidate 执行 smoke seed sweep。 |
| `/ref-exec` | 执行 reference test。 |
| `/blind-gate` | 请求 blind test approval。别名：`/blind`。 |
| `/blind-exec` | 执行 blind test。 |

Candidate 表格中也有同名按钮：

```text
Smoke Prep  Smoke Exec  Seed Sweep
Ref Gate    Ref Prep    Ref Exec
Blind Gate  Blind Prep  Blind Exec
```

含义：

| 操作 | 含义 |
|---|---|
| `Prep` | 创建并排队 runner plan，不一定立即执行。 |
| `Exec` | 调用 runner 执行对应 stage。 |
| `Gate` | 创建 approval request。 |
| `Seed Sweep` | 多 seed 稳定性评估。 |

---

## 7. 推荐工作流

### 7.1 最快开始：自然语言任务

```text
Home 输入：
Forecast ETTh1 horizon=24 target=OT context=96

进入 Cockpit 后：
/next
```

如果 runner ready，系统会继续执行。  
如果 runner 未 ready，先执行：

```text
/use-project-runner
/next
```

### 7.2 标准 CSV 实验

```text
Home:
/csv
```

CSV 对话框输入：

```text
/data/ETTh1.csv target=OT horizon=24 context=96 full
```

进入 task 后：

```text
/profile
/seed-baselines
/agent-loop
```

或者直接：

```text
/next
```

### 7.3 手动推进 Candidate

当已有 candidate 后：

```text
/candidate-next
/ref-gate
/approve
/ref-exec
/blind-gate
/approve
/blind-exec
/export
```

适合你希望显式控制 gate 和 promoted evaluation 的场景。

### 7.4 自动研究循环

当 task、runner、profile 都准备好后：

```text
/agent-loop
```

系统会让 Research Agent 在设计、执行、分析、记忆之间循环推进。

---

## 8. API Key 与环境

Home 页会检测这些环境变量：

```text
NEO_CAST_LLM_API_KEY
OPENAI_API_KEY
AIGCBEST_API_KEY
ANTHROPIC_API_KEY
```

没有 key 时，Home 会显示 `Configure API Key` 面板。

可以输入：

```text
/api-key
```

或通过 `ctrl+p` 搜索 provider/auth 相关命令。

---

## 9. 常见状态与处理

### 9.1 Runner not ready

现象：

- 右侧栏显示 `Runner not ready`
- `Agent Loop` 变灰
- 执行类命令不会启动

处理：

```text
/use-project-runner
```

如果当前路径不是 Neo-Cast 项目：

```text
/edit-runner-root
```

填入包含 Neo-Cast runtime 的项目根目录。

### 9.2 Runner runtime not ready

现象：

- 右侧栏显示 `Runner runtime not ready`
- 通常是 Python venv 尚未初始化，或 Python 版本不满足要求

处理：

在 runner root 下执行：

```bash
node ./bin/neo-cast.js init-runtime
```

然后回到 TUI，重新执行：

```text
/next
```

### 9.3 输入普通文字没有创建任务

在 Cockpit 中，普通文字会作为 chat prompt 发给 Research Agent，不会自动创建新任务。  
要创建新任务，用：

```text
/task
/csv
```

或者回 Home 输入研究目标。

### 9.4 `/agent-loop` 没反应

通常原因：

- 当前 task 不是 `autonomous`
- runner 未 ready
- 当前已有操作在 busy
- 任务缺少 profile 或 candidate，需要先 `/next`

建议先执行：

```text
/next
```

---

## 10. 快捷键速查

| 快捷键 | 位置 | 作用 |
|---|---|---|
| `Enter` | Home / Cockpit 输入框 | 提交输入。 |
| `ctrl+p` | 全局 | 打开命令面板；在 slash menu 中也可向上选择。 |
| `ctrl+n` | Cockpit | 新建 CSV task；在 slash menu 中也可向下选择。 |
| `ctrl+b` | Cockpit | Seed Baselines。 |
| `ctrl+l` | Cockpit | Agent Loop。 |
| `ctrl+e` | Cockpit | Export Bundle。 |
| `ctrl+j` | Cockpit | 下一个 task。 |
| `ctrl+k` | Cockpit | 上一个 task。 |
| `alt+h` | Cockpit | 返回 Home。 |
| `alt+right` | Cockpit | 下一个 candidate。 |
| `alt+left` | Cockpit | 上一个 candidate。 |
| `↑ / ↓` | Slash menu | 上下选择命令。 |
| `Tab` | Slash menu | 执行当前选中命令。 |

---

## 11. 一句话操作建议

如果你是第一次用：

```text
Home 输入研究目标 → Enter → Cockpit 执行 /next
```

如果你有本地 CSV：

```text
/csv → 填 CSV 参数 → /next
```

如果不知道下一步：

```text
/next
```

如果执行不了实验：

```text
/use-project-runner
```
