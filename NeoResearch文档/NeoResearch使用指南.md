# NeoResearch 新版交互用户指南（Case 版）

> 适用版本：v0.2.0-alpha 交互改造版
> 本文不是功能清单，而是一份可以照着走的新版 cockpit 使用 Case。

---

## 一、系统是什么

NeoResearch 是一个 **半自动化 TSF（时序预测）研究平台**，由两个子系统组成：

| 子系统 | 职责 |
|---|---|
| **opencode**（Bun/TS） | TUI 驾驶舱、REST 服务、意图对话、进度追踪 |
| **neo_cast**（Node + Python） | 实际训练候选模型、评估指标、管理实验记录 |

用户面对的是 **TUI 驾驶舱**（`neo-research`）；驾驶舱背后调度 Python 训练循环完成繁重工作。

---

## 二、核心概念

```
Task（研究任务）
  ├── Candidate（候选模型配置，LLM 生成）
  │     └── Run（一次实际训练 + 评估）
  │           └── Metrics（val_avg_mse / val_avg_mae）
  └── Champion（当前最优候选）
```

- **Task**：锁定数据集、目标列、horizon、指标——整个实验的边界
- **Candidate**：LLM 提出的一组模型超参（model family + 训练策略）
- **Run**：对某个 Candidate 执行 smoke（60 s 冒烟）→ 全量训练（600 s）→ 记录指标
- **Champion**：历史 Run 中 `val_avg_mse` 最低的那个 Candidate

---

## 三、新版交互原则

v0.2.0-alpha 的驾驶舱不再要求用户记一堆按钮。现在的核心模型是：

```
一个输入框 + 一个 Next Best Action + 一组斜杠命令
```

用户有两种输入方式：

| 输入方式 | 用法 | 适合场景 |
|---|---|---|
| 自然语言 | 直接描述你想做什么 | 提需求、问原因、让 Agent 解释状态 |
| 斜杠命令 | 输入 `/new csv`、`/dataset prepare` 等 | 明确要执行某个动作 |

驾驶舱会根据当前状态推导一条 **Next Best Action（NBA）**。当输入框为空时，按 `Enter` 会执行这条推荐动作。

### 3.1 保留的核心快捷键

| 键 | 行为 |
|---|---|
| `Enter` | 输入框为空时执行 NBA；有文字时发送消息或执行 slash |
| `Esc` | 取消当前 action proposal / 中断当前操作 |
| `Ctrl+J` / `Ctrl+K` | 切换任务 |
| `Ctrl+L` | 清空当前对话流显示，不删除研究数据 |
| `Ctrl+C` | abort 当前 chat / run / loop |

旧快捷键如 `Ctrl+N`、`Ctrl+B`、`Ctrl+E`、`Alt+H`、`Alt+Left/Right` 已迁移到斜杠命令。首次按下会显示迁移提示。

### 3.2 常用斜杠命令

| 命令 | 作用 |
|---|---|
| `/new csv` | 创建本地 CSV 预测任务 |
| `/dataset prepare` | 准备 Neo-Cast 数据集缓存 |
| `/dataset profile` | 生成数据诊断 profile |
| `/seed` | 生成基线候选 |
| `/run smoke` | 对当前候选做 smoke run |
| `/loop start` | 启动 autonomous loop |
| `/candidate approve` | 批准当前 pending candidate / gate |
| `/export bundle` | 导出完整研究交付包 |
| `/runner check` | 检查 Neo-Cast runner 配置 |
| `/mode companion` / `/mode socratic` | 切换对话风格 |
| `/abort` | 中断当前操作 |
| `/help` | 查看命令提示 |

---

## 四、Case：用本地 CSV 完成一次自动 TSF 研究

下面这个 Case 展示新版推荐路径：用户主要跟随 NBA，不需要找按钮。

### Case 背景

你有一个本地时序 CSV，希望让 NeoResearch 自动探索小模型。

示例目标：

- 数据：`/Users/me/data/traffic.csv`
- 预测列：`speed`
- 输入窗口：`96`
- 预测 horizon：`12,24`
- 指标：`val_avg_mse`
- 模式：Autonomous，尽量让系统自动跑完

### Step 1：启动 cockpit

```bash
cd opencode
neo-research cockpit
```

首次进入会看到欢迎气泡：

```text
欢迎来到 NeoResearch。
本系统主要通过对话使用，直接告诉我你想做什么即可。
常用斜杠命令：/new csv、/dataset prepare、/loop start、/help。
核心快捷键：Enter、Esc、Ctrl+J/K、Ctrl+L、Ctrl+C。
```

这个提示只展示一次，状态记录在：

```text
~/.local/share/neo-research/onboarded.json
```

### Step 2：创建 CSV 任务

如果当前没有任务，NBA 会显示：

```text
▶ Next: Create CSV task (/new csv)
Enter 执行 · 可直接输入其他问题来追问或跳过
```

此时直接按 `Enter`，或手动输入：

```text
/new csv
```

随后在弹出的 CSV 输入框里填写：

```text
/Users/me/data/traffic.csv target=speed horizon=12,24 context=96 full
```

常用字段说明：

| 字段 | 示例 | 说明 |
|---|---|---|
| CSV 路径 | `/Users/me/data/traffic.csv` | 本地 CSV 文件路径 |
| `target=` | `target=speed` | 预测目标列；多个列用逗号分隔 |
| `horizon=` | `horizon=12,24` | 预测步长 |
| `context=` | `context=96` | lookback 窗口 |
| `full` | `full` | 启用完整模型空间 |

> 自定义 CSV 通常不要写 `preset=etth1`。除非你明确要复用标准数据集协议，否则系统会自动使用自适应切分。

### Step 3：选择交互模式

创建任务时系统会询问交互模式：

| 模式 | 适合场景 |
|---|---|
| Companion | 需求已经比较明确，希望系统少打扰、快推进 |
| Socratic | 需求还不完整，希望系统逐步追问确认 |

本 Case 推荐选择 **Companion**。后续可随时切换：

```text
/mode companion
/mode socratic
```

### Step 4：跟随 NBA 准备数据

任务创建后，如果 runner 数据缓存还没准备好，NBA 通常会变成：

```text
▶ Next: Prepare dataset (/dataset prepare)
```

直接按 `Enter`。

这一步会调用 Neo-Cast 准备数据，生成训练可见数据、ref test 数据和 `dataset_spec.json`。如果你修改了 CSV、target、horizon 或 context，需要重新执行：

```text
/dataset prepare
```

### Step 5：生成数据 profile

数据准备完成后，NBA 可能会建议：

```text
▶ Next: Profile dataset (/dataset profile)
```

继续按 `Enter`。

profile 会让系统了解数据规模、缺失率、周期性、趋势强度、目标列分布等特征。后续 ModelDesigner 会参考这些信息生成候选。

### Step 6：Seed baseline

如果当前还没有候选，NBA 会建议：

```text
▶ Next: Seed baseline candidates (/seed)
```

继续按 `Enter`。

这一步会创建若干基线候选，用于建立最初的比较对象。它的意义不是“找到最终模型”，而是给 autonomous loop 一个可靠起点。

### Step 7：启动 autonomous loop

当数据、profile、候选都就绪后，NBA 会建议：

```text
▶ Next: Run autonomous loop (/loop start)
```

继续按 `Enter`。

启动后系统会循环执行：

1. 根据数据 profile、历史 memory 和当前 champion 生成候选
2. 编译候选 recipe
3. 运行 smoke / full run
4. 记录指标
5. 更新 champion
6. 写入 reflection / memory
7. 判断是否继续下一轮

运行中 NBA 会隐藏，conversation pane 会显示 runner progress、run summary 和失败原因摘要。

### Step 8：处理中途审批

有些动作需要人工确认，例如候选晋级、ref test gate、预算追加。此时 NBA 可能显示：

```text
▶ Next: Approve candidate (/candidate approve)
```

如果你认可系统建议，按 `Enter`。如果不认可，可以输入：

```text
/candidate reject
```

如果 Agent 返回 action proposal，界面会显示：

```text
我建议执行：/dataset prepare
原因：当前 task 的 dataset_spec 与已准备的不匹配
[Enter 执行]   [Esc 取消]
```

规则很简单：

- `Enter`：确认执行
- `Esc`：取消 proposal
- 想追问原因：直接输入自然语言，例如“为什么要先执行这一步？”

### Step 9：导出 bundle

当已有成功 run 且研究可以交付时，NBA 会建议：

```text
▶ Next: Export bundle (/export bundle)
```

按 `Enter` 或手动输入：

```text
/export bundle
```

导出包通常包含：

- task spec
- candidates
- runs / metrics
- champion metadata
- evaluation report
- model artifacts
- memory / reflection trace

---

## 五、Case：用户只用自然语言推进

新版 cockpit 允许你不记命令，直接用自然语言表达意图。涉及副作用动作时，系统会尽量转成 action proposal，让你确认后再执行。

示例对话：

```text
用户：我想用 traffic.csv 预测 speed，输入 96，预测 12 和 24 步，先自动跑一轮。
Agent：我需要创建一个 CSV 任务。建议执行：/new csv
用户：Enter
```

如果 Agent 发现数据没有准备好：

```text
Agent：我建议执行：/dataset prepare
原因：当前任务的数据配置还没有同步到 Neo-Cast runner。
用户：Enter
```

如果用户不想执行：

```text
用户：Esc
用户：为什么要先 prepare？
Agent：因为训练 runner 只读取准备后的 dataset_spec.json 和可见训练集...
```

这个模式适合新用户，但高级用户仍然可以随时用 slash 精确控制。

---

## 六、Review 模式 vs Autonomous 模式

| 操作 | Review 模式 | Autonomous 模式 |
|---|---|---|
| 候选生成 | 人工更频繁确认 | 系统自动生成 |
| 训练推进 | 常用 `/run smoke`、`/run full` | 常用 `/loop start` |
| 审批节奏 | 每个关键候选都看一眼 | 只在 gate / 预算 / 异常时介入 |
| 适合场景 | 新数据集首次验证、想精细控制 | 批量探索、希望系统自主迭代 |

推荐做法：

1. 第一次接入新 CSV：用 Companion + `/dataset profile` + `/seed` 先确认 pipeline 正常。
2. 确认数据和 runner 没问题后：切到 Autonomous，跟随 NBA 执行 `/loop start`。
3. 如果结果异常：用 `/abort` 停止，再问 Agent “为什么当前 champion 不稳定？”

---

## 七、常见问题

### Q：`Runner dataset mismatch` 是什么意思？

数据集文件已变更（换了 CSV 或修改了 horizon），需要重新运行 `/dataset prepare`。

### Q：`Missing py/validate.py` 是什么意思？

Runner root 没有配置，或者配置的路径不包含 `neo_cast` 目录。  
用 `/runner edit-root` 命令手动指定：
```
/runner edit-root
输入：/path/to/neo-research/neo_cast
```

### Q：自定义 CSV 的行数限制是什么？

理论下限：`input_len + max_horizon` 的约 5 倍（保证 60/20/20 分割后各段都有足够样本）。  
实测以 `context=96 horizon=24` 为例，约需 **600 行以上**。

### Q：LLM 没有 API Key 怎么办？

驾驶舱右下角显示 `model -`，意味着没有配置。  
设置方式（任一）：
```bash
export ANTHROPIC_API_KEY=sk-...          # Anthropic
export NEO_CAST_LLM_API_KEY=...          # 通用（OpenAI 兼容）
# 或写入 ~/.local/share/neo-research/auth.json
```

无 LLM 时仍可手动触发 Run，但无法自动提案候选。

### Q：可以中途切换交互模式吗？

可以。`/mode companion` 或 `/mode socratic` 随时切换，不影响已有实验。

### Q：我还需要记 `/prepare-dataset`、`/agent-loop` 这些旧命令吗？

不需要。旧命令保留兼容，但新版推荐使用：

| 旧命令 | 新命令 |
|---|---|
| `/prepare-dataset` | `/dataset prepare` |
| `/profile` | `/dataset profile` |
| `/agent-loop` | `/loop start` |
| `/seed-baselines` | `/seed` |
| `/task-next` | `/task next` |
| `/candidate-next` | `/candidate next` |

### Q：为什么输入框为空时按 Enter 会执行动作？

这是新版交互的核心：空输入代表“接受系统推荐的下一步”。如果不想执行，可以直接输入其他自然语言问题或 slash 命令。

---

## 八、一句话总结

> **新版 NeoResearch 的默认交互不是“找按钮”，而是“看建议、问原因、按 Enter 推进”。**
> 斜杠命令负责精确控制，Next Best Action 负责告诉你下一步，Action Proposal 负责让 Agent 把动作端到你面前。
> 用户仍然掌握确认权，但不再需要在按钮森林里找路。
