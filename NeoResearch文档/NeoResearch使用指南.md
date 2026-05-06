# NeoResearch 使用指南

> 适用版本：v0.1.0-alpha.0

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

## 三、交互模式 vs 任务模式

这是理解"自动"与"按钮"并存的关键。系统有**两个独立维度**：

### 3.1 交互模式（和 LLM 的对话风格）

| 模式 | 说明 | 适合场景 |
|---|---|---|
| **Socratic（苏格拉底）** | LLM 主动追问缺失信息，逐个确认 slot | 需求不明确时 |
| **Companion（认知伴随）** | LLM 先汇总理解，一次性确认后直接推进 | 需求已明确，求效率 |

切换命令：`/mode-socratic` 或 `/mode-companion`

### 3.2 任务模式（NAS 搜索的自动化程度）

| 模式 | 说明 | 何时执行下一轮 |
|---|---|---|
| **Review（评审模式）** | 每轮训练后等待人工审阅，按需手动触发下一个候选 | 人工按键 |
| **Autonomous（自主模式）** | 按下 `Agent Loop` 后，循环自动生成候选 → 训练 → 选优 | 自动，直到预算耗尽 |

---

## 四、为什么"自动"还需要"按按钮"？

这**不是矛盾**，而是有意设计的**人类监督门控**（Human Checkpoint）。

系统把整个研究分为几个阶段，**阶段内**尽量自动，**阶段之间**必须人工确认：

```
[阶段边界：人工门控]          [阶段内：自动化]
        │                           │
配置数据集 ──────────────── 自动计算数据 profile
        │
确认意图 ────────────────── LLM 自动填写 task spec
        │
启动 Agent Loop ─────────── 自动：提案 → smoke → 训练 → 选优
（只按一次）                 自动循环直到：预算/no-improve/时间上限
        │
（可选）批准预算追加 ─────── 继续自动循环
        │
导出 Bundle ─────────────── 自动打包结果
```

**门控的意义：**
- 防止系统拿错数据集就开始烧 GPU
- 让研究者在搜索前确认目标（horizon、指标、约束）
- 预算耗尽时给人类一个"要不要继续"的决策机会

---

## 五、完整使用流程

### Step 1：启动 TUI

```bash
cd opencode
neo-research
```

### Step 2：创建任务

**方式 A — 标准 ETTh1 等内置数据集**

按 `n`（New Task）→ 选择交互模式 → 系统会对话澄清意图

**方式 B — 自定义 CSV 数据集**

按 `c`（New CSV Task），输入格式：

```
/path/to/your.csv target=OT horizon=24,48 context=96
```

可选关键字：
- `target=列名,列名`  预测目标列
- `horizon=24,48`    预测步长（可多个）
- `context=96`       lookback 窗口
- `preset=etth1`     使用内置数据集分割策略（只对已知标准数据集用）
- `full` / `bridge`  是否启用完整模型空间

> 注意：自定义 CSV **不要**加 `preset=etth1`，系统会自动做 60/20/20 自适应分割。

### Step 3：完成意图对话

**Socratic 模式**：逐条回答 LLM 的追问，直到所有 slot 确认 ✓

**Companion 模式**：LLM 一次性列出理解摘要，确认后继续

### Step 4：准备数据集

TUI 右侧状态栏显示 `Runner dataset mismatch` 时，按 `Enter` 选择 `Prepare Dataset`（或 `/prepare-dataset`）。

这一步会：
1. 调用 `neo-cast prepare-data --source ... --input-len ... --horizons ...`
2. 在 neo_cast 目录下生成 `visible_*.csv`（训练集可见部分）和 `ref_test.csv`（测试集，训练时不可见）
3. 写入 `dataset_spec.json`

**只需执行一次**（除非更换数据集或修改 horizon）。

### Step 5：（可选）Seed Baselines

按 `s`（Seed Baselines）让 LLM 生成 3 个固定基准候选：nlinear / tiny_transformer / patch_mlp。

用于建立初始 champion，帮助后续的 NAS 反射机制有比较基准。

### Step 6：启动 Agent Loop（核心步骤）

**只按一次**，之后系统完全自动：

```
按 A → Agent Loop
```

每一轮（iteration）自动完成：
1. 调用 LLM（或 mutation / reflection 策略）生成候选 JSON
2. 执行 smoke（60 s 冒烟检查，验证代码可运行）
3. 执行 full run（600 s 完整训练 + 评估）
4. 与 Champion 比较，决定 keep / discard
5. 更新 Memory（记录 `[dataset:xxx.csv] candidate X 成为 champion`）
6. 自动进入下一轮

循环停止条件（任一满足即停）：

| 条件 | 默认值 |
|---|---|
| 最大 Run 次数 | `budget.maxRuns`（默认 12） |
| 连续不改善轮数 | `maxNoImprove`（默认 8） |
| 时间预算 | `timeBudgetSeconds`（如有） |
| 连续 crash | 5 次 |
| 人工 Abort | 按 `Ctrl+C` 或 `/abort` |

### Step 7：查看结果与导出

- 右侧状态栏实时显示 Champion 指标
- `tab` → Agents 面板：查看各 Agent 进度
- 按 `e`（Export Bundle）：导出完整实验包（含模型配置、metrics、eval report）

---

## 六、Review 模式 vs Autonomous 模式操作对比

| 操作 | Review 模式 | Autonomous 模式 |
|---|---|---|
| 生成一个候选并训练 | 手动按 `r`（Run Candidate） | 由 Agent Loop 自动循环 |
| 查看结果再决定下一步 | 每轮都等人工 | 自动决策 keep/discard |
| 什么时候用 | 想精细控制每个候选 | 想"放手"让系统跑 |
| 何时需要人工介入 | 每一轮 | 预算耗尽 / 报错 |

**典型使用场景：**
- **第一次用新数据集**：先用 Review 模式跑 2-3 个候选，确认 pipeline 正常，再切换到 Autonomous
- **批量探索**：直接 Autonomous，设置 `maxRuns=20`，去喝咖啡

---

## 七、常见问题

### Q：`Runner dataset mismatch` 是什么意思？

数据集文件已变更（换了 CSV 或修改了 horizon），需要重新运行 `prepare-dataset`。

### Q：`Missing py/validate.py` 是什么意思？

Runner root 没有配置，或者配置的路径不包含 `neo_cast` 目录。  
用 `/edit-runner-root` 命令手动指定：
```
/edit-runner-root
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

可以。`/mode-companion` 或 `/mode-socratic` 随时切换，不影响已有实验。

---

## 八、一句话总结

> **NeoResearch 的"自动"是指 NAS 搜索循环（生成候选 → 训练 → 选优）自动；**  
> **"按按钮"是在几个关键边界点给人类一个确认机会，防止系统拿错数据乱跑。**  
> 两者不矛盾——这是有意为之的**人类监督 + 机器执行**架构。
