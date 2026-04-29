# neo_cast 代码解读

> NeoResearch-TSF Phase 0 / MVP —— 面向时间序列预测的自主研究智能体执行核

---

## 一、整体定位

`neo_cast` 不是一个时序预测模型库，也不是一个开放式 AI 助手。它的定位是：

> **Forecast Research Operating System 的最小执行核（MVP）**

灵感直接来自 Karpathy 的 `autoresearch`：让 AI Agent 在严格约束下持续修改模型代码、跑实验、保留有效改动、丢弃无效改动，从而形成一个可持续迭代的小模型研究闭环。

核心差异点：autoresearch 针对 LLM 预训练（val_bpb），neo_cast 针对时间序列多步预测（val_avg_mse）。

---

## 二、文件结构一览

```
neo_cast/
├── prepare_tsf.py               ← 【冻结层】固定数据/评估协议，Agent 不可修改
├── train.py                     ← 【实验层】Agent 唯一可编辑文件
├── runner.py                    ← 【辅助工具】实验循环管理脚本
├── program.md                   ← 【策略层】面向 Agent 的行为协议
├── neo_research_tsf_architecture.md  ← 完整七层架构设计文档
├── results.tsv                  ← 本地实验日志（不提交 git）
├── pyproject.toml               ← 依赖声明（numpy/pandas/sklearn/torch）
└── datasets (1)/                ← 额外数据集（非当前 ETTh1 默认流程）
```

三个核心文件与 autoresearch 完全同构：

| autoresearch | neo_cast | 角色 |
|---|---|---|
| `prepare.py` | `prepare_tsf.py` | 冻结层，不可动 |
| `train.py` | `train.py` | 实验层，Agent 专属 |
| `program.md` | `program.md` | 策略层，人类编写 |
| `val_bpb` | `val_avg_mse` | 主优化指标 |

---

## 三、`prepare_tsf.py`：冻结层深解

### 3.1 核心固定常量

```python
DATASET       = "ETTh1"
NUM_CHANNELS  = 7          # HUFL, HULL, MUFL, MULL, LUFL, LULL, OT
INPUT_LEN     = 512        # look-back 窗口，Agent 不可修改
HORIZONS      = (96, 192, 336, 720)   # 四个预测长度，同步评估
TIME_BUDGET   = 600        # 单次实验最大训练时长（秒）
PARAM_BUDGET  = 10_000_000 # 参数量软上限（10M）
SEED          = 42
```

### 3.2 数据切分（与 TSL 完全对齐）

```
train:     行 [0,     8640)   → 12个月 × 30天 × 24小时
val:       行 [8640, 11520)   → 再 4个月（Agent 决策信号）
ref_test:  行 [11520,14400)   → 再 4个月（Runner/人类特权，Agent 不可读）
```

这个切分与 Time-Series-Library（thuml）的 `Dataset_ETT_hour` 完全一致，保证结果可与 TSL 论文对齐。

### 3.3 数据可见性隔离

这是设计中最重要的安全机制之一：

```
ETTh1_visible.csv   ← train + val（11520行），Agent 可见
ETTh1_ref_test.csv  ← test（2880行），仅 Runner/人类 gate 持有
```

`materialize_visible_splits()` 负责从原始 ETTh1.csv 切出这两份文件，防止 Agent 读到测试标签。

### 3.4 标准化协议

使用 `sklearn.StandardScaler`，**仅在 train fold 上 fit**，并将同一组统计量复用到 val 和 ref_test：

```python
scaler.fit(feature_values[BORDER_TRAIN[0]:BORDER_TRAIN[1]])  # 只在 train 段 fit
scaled_values = scaler.transform(feature_values)              # 应用到全部可见数据
```

评估在 **scaled space** 中计算 MSE/MAE（不做 inverse transform），与 TSL 默认行为（`args.inverse=False`）一致。

> **为什么不用 RevIN？** RevIN 是实例级动态归一化，会在 forward 时改变归一化状态，让 Agent 设计 loss 时需要额外感知。固定 StandardScaler 让 Agent 专注于架构本身。

### 3.5 WindowDataset 实现

```python
class WindowDataset(Dataset):
    # 每个样本: x = values[start:start+INPUT_LEN], y = values[start+INPUT_LEN:start+INPUT_LEN+horizon]
    # val 集的 context_start = BORDER_VAL[0] - INPUT_LEN（允许用 train 尾部作 context）
```

val 窗口刻意向前延伸 `INPUT_LEN`，使 val 集的第一个窗口能看到 train 末尾的数据，与 TSL 语义对齐。

### 3.6 evaluate_val_tsf —— 主指标定义

```python
def evaluate_val_tsf(model_or_models, device) -> dict:
    # 返回: val_avg_mse, val_avg_mae, val_h{H}_mse, val_h{H}_mae
    # val_avg_mse = mean(val_h96_mse, val_h192_mse, val_h336_mse, val_h720_mse)
```

**`val_avg_mse` 是 keep/discard 的唯一决策信号。** 多 horizon 平均防止 Agent 只优化短期预测而牺牲长期（或反之）。

### 3.7 query_ref_test —— Runner-only 特权接口

```python
def query_ref_test(artifact_uri, task_id, promotion_token) -> dict:
    # MVP 阶段仅为占位符
    # 需要环境变量 NEO_TSF_PROMOTION_TOKEN 才能调用
    # Agent 进程中没有该 token，物理上无法调用
```

这是整个系统的 blind test gate。MVP 阶段接口已定义，但实现留空（`NotImplementedError`），待后续 Runner sidecar 实现。

---

## 四、`train.py`：实验层深解

### 4.1 基线模型：Channel-Independent NLinear

```python
class TSFModel(nn.Module):
    def __init__(self, input_len, horizon):
        self.linear = nn.Linear(input_len, horizon)

    def forward(self, x):          # x: [B, L, C]
        last_value = x[:, -1:, :]  # NLinear 的去均值技巧：减去最后一个值
        x = x - last_value
        # Channel-Independent: [B, L, C] → [B*C, L] → linear → [B*C, H] → [B, H, C]
        ...
        return pred + last_value   # 再加回去（实例归一化 + 还原）
```

这是 DLinear/NLinear（AAAI 2023）的 CI 实现。每个 channel 独立做线性映射，是 TSF 领域已知的最强轻量 baseline 之一。

**当前 `train.py` 相比架构文档中的"初始样例"多了两个改进：**
1. 增加了 `early stopping`（`PATIENCE=7`）
2. 用 `copy.deepcopy` 保存最优权重（比 `torch.save` 到 `/tmp` 更干净）

### 4.2 多 horizon 并行训练

```python
models    = {h: TSFModel(INPUT_LEN, h).to(device) for h in HORIZONS}
optimizers = {h: torch.optim.Adam(...) for h in HORIZONS}
train_loaders = {h: make_dataloader("train", h, ...) for h in HORIZONS}
```

每个 horizon 维护一个独立的模型 + 优化器 + 数据流，在同一个 epoch 循环中**轮流训练**。当某个 horizon early stop 后跳过，直到所有 horizon 都停止或超过 `TIME_BUDGET`。

### 4.3 输出格式（固定，供 grep 解析）

```
---
val_avg_mse:      1.057427
val_h96_mse:      0.665714   val_h96_mae:     0.618...
training_seconds: 17.5
peak_vram_mb:     0.0
num_params_M:     0.69
```

格式固定是核心设计选择，`runner.py` 和 `program.md` 都依赖这个格式做自动解析。

### 4.4 Agent 的改动自由度

Agent **只能修改 `train.py`**，但在这个文件内拥有完整自由度：

| 可改内容 | 示例 |
|---|---|
| 模型架构 | 换 Transformer / MLP / TCN / SSM |
| Channel 策略 | CI → CD（建模通道间依赖） |
| Patch 设计 | patch_size=16/32, stride=8/16 |
| 损失函数 | MSE → MAE / Huber / 分位数 |
| 优化器 | Adam → AdamW / SGD |
| 学习率 schedule | cosine warmup/decay |
| 数据增强 | 仅对训练集 |

**不可改的内容：** `prepare_tsf.py` 中的任何内容，数据切分，评估协议。

---

## 五、`runner.py`：实验循环管理

### 5.1 状态机设计

runner 的核心是一个 `RunnerState` 结构：

```python
@dataclass
class RunnerState:
    repo_root: str
    branch: str
    last_keep_commit: str        # keep/discard 的回滚锚点
    best_val_avg_mse: float      # 当前最优分数
    keep_count: int              # 累计 keep 次数
    promotion_interval: int      # 每隔多少次 keep 触发晋级检查
    initialized_at: float
```

状态持久化到 `.neo_runner_state.json`，跨次调用保持一致。

### 5.2 三个子命令

```bash
python runner.py init                             # 初始化状态和 results.tsv
python runner.py run --description "baseline"     # 执行一次实验
python runner.py status                           # 查看当前状态
```

### 5.3 keep/discard 逻辑

```python
if val_avg_mse < state.best_val_avg_mse:
    # keep：更新 last_keep_commit，累加 keep_count
    state.last_keep_commit = current_commit_full
    state.best_val_avg_mse = val_avg_mse
else:
    # discard：git reset --hard last_keep_commit
    run_git(["reset", "--hard", state.last_keep_commit])
```

**discard 的语义很关键：** 不只是恢复 `train.py` 的文件内容，而是让 git HEAD 真正回到 `last_keep_commit`，rejected commit 从分支历史中消失。

### 5.4 安全检查

runner 在执行前会检查：

1. 当前 branch 与 state 中记录的 branch 一致
2. 工作区没有未提交的 tracked changes
3. 如果 cwd 不是 repo root，需要显式 `--allow-nonroot-repo` 才允许执行 `git reset`

这些检查防止 runner 在错误的 context 下误操作 git 历史。

### 5.5 日志解析

```python
def parse_summary(log_text: str) -> dict:
    # 解析固定格式的 stdout 输出
    # 关注: val_avg_mse, val_h96_mse, val_h720_mse, num_params_M
```

如果解析结果中没有 `val_avg_mse`，自动判定为 crash，记录 `NA` 并回滚。

---

## 六、`program.md`：Agent 行为协议

### 6.1 三个区分

- **人类负责的内容：** 定义任务、设 `program.md`、审批晋级
- **Agent 负责的内容：** 提出假设、改 `train.py`、跑实验、记录结果、keep/discard
- **Runner/Gate 负责的内容：** reference test 查询、`promotion.tsv` 写入

### 6.2 实验循环（核心协议）

```
LOOP FOREVER:
1. 检查当前 commit
2. 提出一个研究假设
3. 修改 train.py
4. git commit
5. uv run train.py > run.log 2>&1
6. grep "^val_avg_mse:\|^num_params_M:\|^WARNING" run.log
7. 若 grep 为空 → tail run.log 排查 crash
8. 追加结果到 results.tsv
9. val_avg_mse 降低 → keep；否则 → discard（git reset --hard）
10. 每 PROMOTION_INTERVAL 次 keep → 触发 reference test（写 promotion.tsv）
```

### 6.3 研究方向优先级

**优先探索：**
- CI → CD 策略切换
- Patching（patch_size=16/32, stride=8/16）
- 去趋势分解（moving average + remainder）
- MLP-Mixer 替代 Attention
- FFT 频域辅助特征

**后续探索：**
- 跨 horizon 共享 backbone + 各自 head
- 多尺度分支融合
- 非对称 loss
- 基于 foundation model 的蒸馏

### 6.4 简洁性标准（继承自 autoresearch）

| 情况 | 决策 |
|---|---|
| val_avg_mse 明显改善，代码简洁 | 必须 keep |
| val_avg_mse 持平，代码更简洁 | keep（简化胜利） |
| val_avg_mse 微弱改善，新增大量复杂代码 | discard |
| 参数量增加 >5M，改善 <0.010 | discard |

---

## 七、`neo_research_tsf_architecture.md`：长期七层架构

这份文档描述了从 MVP 到完整 Forecast Research Operating System 的演进蓝图。

### 7.1 七层架构

```
Human Control Layer       ← 人类定义边界、审批晋级
Agent Orchestration Layer ← Research Manager + 5个子Agent
Search Space Layer        ← 模型/loss/数据变换/训练策略 DSL
Protocol Layer            ← TaskSpec、评估协议、预算约束
Execution Layer           ← Sandbox、Static Validator、Artifact Store
Evaluation Layer          ← 多阶段筛选、晋级判定、误差诊断
Memory Layer              ← 实验谱系、失败模式、跨任务元记忆
```

### 7.2 与 AutoML 的核心区别

普通 AutoML：结构化搜索空间 + 自动调参。  
neo-research：

1. **研究记忆** —— 每次实验的假设/结论沉淀为经验，跨任务迁移
2. **多目标 Champion** —— 精度 + 参数量 + 延迟 + 稳定性综合评分（`Utility`）
3. **人机协同** —— 人定义规则，Agent 执行高频试验
4. **受控搜索** —— 先 Config Search（L1）→ Registry Composition（L2）→ Template Patch（L3），不一开始就放开全仓代码修改

### 7.3 三层评估协议

| 层次 | 名称 | 频率 | 可见性 |
|---|---|---|---|
| L1 | Dev Validation（val） | 每次实验 | Agent 可见 |
| L2 | Reference Test | 每 N 次 keep | Runner/人类特权 |
| L3 | Blind Test | 仅最终 champion | Phase 5 独立服务 |

### 7.4 Utility 评分公式

```
Utility = 1.00 * AccuracyGain
        - 0.20 * ModelSizePenalty
        - 0.10 * LatencyPenalty
        - 0.30 * VariancePenalty
        - 2.00 * FailurePenalty
        - 0.05 * ComplexityPenalty
```

系统朝"小而稳"方向天然演化，精度提升和代码复杂度、参数量增加之间有明确的 trade-off 量化。

---

## 八、数据流与调用关系

```
ETTh1.csv（人类提供）
    │
    ▼
prepare_tsf.py::materialize_visible_splits()
    ├── ETTh1_visible.csv（train+val，11520行）→ Agent 可见
    └── ETTh1_ref_test.csv（test，2880行）→ Runner 专属
              │
              ▼
prepare_tsf.py::_load_visible_bundle()
    → StandardScaler（fit on train）→ VisibleDataBundle
              │
              ▼
WindowDataset("train"/"val", horizon)
    → DataLoader → (x:[B,512,7], y:[B,H,7])
              │
              ▼
train.py::TSFModel（Agent 自由修改）
    → 训练循环（TIME_BUDGET 内）
    → evaluate_val_tsf() → val_avg_mse, val_h{H}_mse/mae
              │
              ▼
stdout 固定格式
    │
    ├── runner.py::parse_summary() → keep/discard/crash 决策
    └── Agent 直接 grep run.log
```

---

## 九、当前状态与局限

### 9.1 当前可以做到

- ETTh1 多变量预测的完整本地闭环
- Agent 自主提出假设 → 改 `train.py` → 跑实验 → 记录结果 → keep/discard
- 最小 runner 工具链（init/run/status）

### 9.2 MVP 的已知简化

| 功能 | MVP 状态 | 完整系统目标 |
|---|---|---|
| 低保真筛选（smoke run） | 无 | Phase 1+ |
| Static Validator | 无 | Phase 1+ |
| 多 seed 验证 | 无（单 seed=42） | Phase 3+ |
| 研究记忆系统 | 无 | Phase 3+ |
| reference test evaluator | 接口占位，NotImplementedError | Phase 1+ |
| 多数据集 | 仅 ETTh1 | Phase 1+ |
| 模型注册表 / DSL | 无（直接改代码） | Phase 2+ |

### 9.3 关键设计权衡

1. **为什么 Agent 直接改代码而不用 DSL？**  
   Phase 0 的首要目标是验证闭环是否可行，DSL 引入太早反而增加摩擦。Phase 1 开始应逐步收敛到 Registry + DSL，防止 Agent 完全失控。

2. **为什么用 val 而不是 test 作为 keep/discard 信号？**  
   防止 test 集泄漏，也防止 Agent 过拟合 test 集的噪声。val 是唯一合法的高频查询信号。

3. **为什么多 horizon 平均？**  
   防止 Agent 专门优化短期（h=96）牺牲长期（h=720）。多 horizon 均值是更公平、更全面的优化目标。

---

## 十、快速上手

```bash
# 1. 安装依赖
uv sync

# 2. 准备数据（需要原始 ETTh1.csv）
uv run prepare_tsf.py --materialize-visible --source-csv /path/to/ETTh1.csv

# 3. 验证数据就绪
uv run prepare_tsf.py

# 4. 跑一次 baseline
uv run train.py

# 5. 初始化 runner 并开始循环
python runner.py init
python runner.py run --description "baseline: NLinear CI + early_stop"
python runner.py status
```

数据集下载：ETTh1.csv 来自 [Time-Series-Library](https://github.com/thuml/Time-Series-Library) 的 `dataset/ETT-small/` 目录。

---

## 十一、与相关工作的对比

| 维度 | autoresearch | TSL | neo_cast |
|---|---|---|---|
| 目标 | LLM 预训练优化 | TSF 模型 benchmark | TSF 自主研究循环 |
| Agent 角色 | 改 train.py | 无 | 改 train.py |
| 数据切分 | 固定 token 流 | 参数化 border | 与 TSL 对齐，固定 |
| 主指标 | val_bpb | MSE/MAE | val_avg_mse（scaled） |
| 训练预算 | 5 min | 无限制 | 10 min |
| 测试集保护 | 无此概念 | 无隔离 | 3层评估隔离 |
| 参数约束 | VRAM 软约束 | 无 | 10M 参数软约束 |
| 记忆系统 | 无 | 无 | 设计有，MVP 未实现 |
