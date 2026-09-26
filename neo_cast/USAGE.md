# neo-cast 使用指南

当前默认生成 `model_recipe.v2`，执行为 `recipe_schema_v3`。新增 diagonal SSM、TimesBlock encoder、Mamba-1 及受限双分支组合；旧版输入继续兼容。版本、去重和 CPU/CUDA 边界请参见 [v3 实施说明](docs/recipe_runtime_v3_contract.md)。下文旧版示例仍可执行，但不代表新版本全部能力。

> **neo-cast** 是一个 CLI 工具：你描述对时序预测模型的需求，它自动设计、训练候选模型，输出可部署的模型制品（权重 + MCP 工具 + 推理代码 + 评估报告）。

---

## 目录

1. [安装](#1-安装)
2. [配置 API Key](#2-配置-api-key)
3. [初始化项目环境](#3-初始化项目环境)
4. [两种交互模式](#4-两种交互模式)
5. [输入](#5-输入)
6. [超参数参考](#6-超参数参考)
7. [输出](#7-输出)
8. [常用命令速查](#8-常用命令速查)

---

## 1. 安装

### 方式 A：npm 全局安装（推荐普通用户）

```bash
npm install -g neo-cast
```

安装完成后即可在任何目录使用 `neo-cast` 命令。

### 方式 B：源码安装（推荐开发者）

```bash
git clone https://github.com/ustc-time-series/neo_cast.git
cd neo_cast
npm install
npm link          # 将 neo-cast 注册为全局命令（修改源码即时生效）
```

> 详细调试配置（VS Code、Inspector）见 `DEVELOPMENT.md`。

---

## 2. 配置 API Key

neo-cast 通过 LLM 生成候选模型配置，支持两类 API。

### 方案 A：Anthropic Claude（默认）

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

或写入项目根目录的 `.env` 文件（从模板复制）：

```bash
cp .env.example .env
# 编辑 .env，填入 ANTHROPIC_API_KEY=sk-ant-...
```

用户级持久配置（所有项目生效）：

```bash
neo-cast config init          # 生成 ~/.config/neo-cast/config.json
```

编辑该文件：

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "max_tokens": 1024,
    "temperature": 0.3
  }
}
```

### 方案 B：OpenAI 兼容接口（AIGCBEST、本地 vLLM 等）

```bash
export NEO_CAST_LLM_API_KEY="your-key"
```

用户级配置：

```json
{
  "llm": {
    "provider": "openai-compatible",
    "base_url": "https://api.aigcbest.top/v1",
    "model": "gpt-4o-mini",
    "max_tokens": 1024,
    "temperature": 0.3
  }
}
```

### 无 API Key 模式（开发调试）

加 `--mock-llm` 标志，或设置 `NEO_CAST_USE_MOCK=1`，使用内置启发式规则生成候选，完全离线。未配置 LLM API Key 时，`doctor` 会给出 warn 和 mock fallback 提示，不再阻塞本地 alpha demo：

```bash
neo-cast design --requirement "test model" --mock-llm
NEO_CAST_USE_MOCK=1 neo-cast design --requirement "test model"
```

验证当前配置是否正确：

```bash
neo-cast doctor
# 正常输出示例：
# [OK] python3: Python 3.12.x [runtime venv]
# [OK] uv: Detected uv 0.x.x
# [OK] anthropic_api_key: ANTHROPIC_API_KEY is set.
# [OK] config: Resolved config is valid.
# [OK] runtime: Project runtime is ready at ...
```

---

## 3. 初始化项目环境

**每个项目目录只需执行一次。** 在你的工作目录（非 neo-cast 源码目录）中运行：

```bash
# 1. 创建 Python 运行时（在 .neo-cast/runtime/.venv）
neo-cast init-runtime

# 2. 准备数据集（需要 ETTh1.csv）
#    下载：https://github.com/thuml/Time-Series-Library → dataset/ETT-small/ETTh1.csv
neo-cast prepare-data --source /path/to/ETTh1.csv

# 3. 生成结构化研究任务合同（Task DSL）
neo-cast task-spec init --from-dataset .neo-cast/dataset_spec.json
neo-cast task-spec validate .neo-cast/task_spec.json

# 4. 验证环境
neo-cast doctor
```

完成后，工作目录中会出现 `.neo-cast/` 子目录，后续所有实验产物都存放在这里。
每次训练导出的 artifact 会包含 `research_trace.json`，同时 `.neo-cast/research_trace.jsonl`
会追加记录关键研究决策的依据、预期效果和验证计划。

ModelDesigner 会生成 `model_recipe.v1` 高层模型配方，包含 `model_name / input / architecture / training / constraints`。
Runtime 会把它编译成可执行的 `recipe_schema_v2`，再进入 smoke、训练、评估和导出流程。旧 recipe/checkpoint 需要迁移并重训；运行时语义版本为 2，详见 [v2 合同](docs/recipe_runtime_v2_contract.md)。

需要把模型方案确认变成 Runtime gate 时，可以启用 human checkpoint：

```bash
neo-cast design \
  --requirement "use a compact baseline" \
  --mode companion \
  --max-candidates 1 \
  --mock-llm \
  --require-approval

neo-cast checkpoint status
neo-cast checkpoint approve model_design --note "确认该模型方案"
neo-cast runner run --description "approved model design"
```

确认状态写入 `.neo-cast/approval_state.json`。如果 `model_design` 仍是 pending/rejected，
runner 会拒绝进入训练阶段。

需要纠正系统误判时，把反馈写入 Human Feedback Memory，而不是只留在聊天记录里：

```bash
neo-cast correction add \
  --scope data_schema \
  --field temperature_forecast \
  --correction "available only at prediction time"

neo-cast correction add \
  --scope split_policy \
  --correction "data must be split in chronological order only"

neo-cast correction list
```

这些记录写入 `.neo-cast/user_corrections.json`。后续 `design` 与 reflection 会把 active corrections
作为用户权威约束注入任务上下文。

---

## 4. 两种交互模式

### 模式一：苏格拉底模式（Socratic）

**适用场景**：需求模糊，希望在开始训练前先明确约束。

**交互流程**：neo-cast 先通过对话收集你的需求细节，确认后再自动批量训练。

```bash
neo-cast design \
  --requirement "我需要一个预测效果好的 ETTh1 模型" \
  --mode socratic \
  --max-candidates 5
```

**终端交互示例**：

```
Model preference (transformer / nlinear / patch_mlp, blank to skip): transformer
Parameter budget in millions (blank for default):
Latency priority (low / medium / high, blank for default): medium
Any extra notes? (blank to skip): 长 horizon 要稳

Proceed with:
  Base requirement: 我需要一个预测效果好的 ETTh1 模型
  Model preference: transformer
  ...
Proceed? [Y/n]: Y

[设计循环开始，无需再交互]
```

**跳过交互**（CI/脚本使用）：通过 flags 直接提供所有信息：

```bash
neo-cast design \
  --requirement "efficient ETTh1 model" \
  --mode socratic \
  --model-preference transformer \
  --latency-priority medium \
  --yes \
  --max-candidates 5
```

---

### 模式二：认知伴随模式（Companion）

**适用场景**：需求已明确，希望实时看到每一轮的设计决策和训练进展，可随时叫停。

**交互流程**：立即开始训练，每轮输出模型的假设、训练参数、验证结果，允许你在轮间输入 `stop` 提前结束。

```bash
neo-cast design \
  --requirement "transformer based model for ETTh1" \
  --mode companion \
  --max-candidates 5
```

**终端输出示例**：

```
┌────────────────────────────┐
│  neo-cast companion mode   │
└────────────────────────────┘
[requirement ]  transformer based model for ETTh1
[max rounds  ]  5
  I will explain each decision as we go. Type "stop" to end early.

[Round 1     ]  trying TINY_TRANSFORMER
[hypothesis  ]  Patch transformer: captures temporal patterns with multi-head attention over patched windows.
[source      ]  Claude API
[lr          ]  0.001
[batch_size  ]  32
  Training…

[val_avg_mse ]  0.412847
[decision    ]  ✓ KEEP
[note        ]  new best — artifact saved

[Round 2     ]  trying PATCH_MLP
...

┌────────────────────────────┐
│  design complete           │
└────────────────────────────┘
[best model  ]  tiny_transformer
[val_avg_mse ]  0.412847
[run_id      ]  20260425-143022-abc123
[artifact    ]  .neo-cast/artifacts/run_20260425-143022-abc123/

  Run inference:  python .neo-cast/artifacts/run_.../example.py
  Start MCP tool: python .neo-cast/artifacts/run_.../mcp_server.py
```

**实时停止**：在训练过程中（两轮之间）输入 `stop` 并回车，系统会在当前轮完成后退出。

---

### 两种模式对比

| 维度 | Socratic 苏格拉底 | Companion 认知伴随 |
|---|---|---|
| 开始前交互 | 是（对话收集需求） | 否（立即开始） |
| 运行中交互 | 否 | 是（可输入 `stop`） |
| 适合场景 | 需求不清晰时 | 需求明确、想观察过程 |
| 适合脚本/CI | 加 `--yes` 后可以 | 天然适合（非交互输出） |

---

## 5. 输入

### 必须提供

| 输入 | 说明 |
|---|---|
| `--requirement "..."` | 自然语言需求描述（英文或中文均可） |
| ETTh1.csv | 一次性通过 `prepare-data` 导入，后续自动使用 |

### 可选参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--mode` | `socratic` | 交互模式：`socratic` 或 `companion` |
| `--max-candidates` | `1` | 最多尝试几个候选模型 |
| `--mock-llm` | 关 | 用启发式规则代替 LLM，无需 API Key |
| `--skip-smoke` | 关 | 跳过 smoke 验证（加速调试） |
| `--latency-priority` | `medium` | `low` / `medium` / `high` |
| `--notes` | — | 额外约束（追加到 requirement 文本） |

### 需求描述示例

```bash
# 轻量线性基线
--requirement "small nlinear baseline, parameter budget under 0.1M"

# 长 horizon 场景
--requirement "a model that performs well on horizon 720, transformer preferred"

# 低延迟推理
--requirement "patch mlp model optimized for low inference latency"
```

---

## 6. 超参数参考

neo-cast 的超参分为三层：**固定任务常量**（代码写死，不可改）、**训练超参**（LLM 按需生成，可在 requirement 中约束）、**模型超参**（每个模型族独立）。

---

### 6.1 固定任务常量（`prepare_tsf.py`，不可修改）

| 常量 | 值 | 说明 |
|---|---|---|
| `INPUT_LEN` | **512** | 输入窗口长度（时间步） |
| `HORIZONS` | **96 / 192 / 336 / 720** | 四个预测 horizon，全部训练并平均 |
| `NUM_CHANNELS` | **7** | ETTh1 通道数（HUFL/HULL/MUFL/MULL/LUFL/LULL/OT） |
| `SEED` | **42** | 全局随机种子 |
| `TIME_BUDGET` | **600 s** | 每次训练的最大壁钟时间（10 分钟） |
| `PARAM_BUDGET` | **1,000,000** | 软性参数量上限（1M 参数） |
| 数据分割 | train [0, 8640) / val [8640, 11520) / ref_test [11520, 14400) | 按时间步索引，不随机打乱 |
| 归一化 | `StandardScaler`（按训练集 fit） | 验证/测试集使用训练集的均值和方差 |

---

### 6.2 训练超参（`train_config`，LLM 生成）

由 LLM 在 candidate JSON 的 `train_config` 字段中指定，经 `renderer.py` 解析后生效。

| 超参 | 类型 | 范围 | 默认值 | 说明 |
|---|---|---|---|---|
| `lr` | float | (0, 1.0] | `0.001` | 学习率（Adam 优化器） |
| `batch_size` | int | [1, 512] | `32` | mini-batch 大小 |
| `max_epochs` | int | [1, 1000] | `100` | 最大训练轮数（早停会提前终止） |
| `patience` | int | [1, 100] | **7** | 早停耐心（val_loss 连续无改善轮数） |
| `weight_decay` | float | [0, 1.0] | **0.0** | L2 正则化系数 |
| `seed` | int | [0, 2147483647] | **42** | 本次实验随机种子 |

> `patience` / `weight_decay` / `seed` 是可选字段，LLM 未指定时由 `renderer.py` 填入默认值。

**Smoke run 配置**（自动缩减，用于快速验证 candidate 合法性）：

| 参数 | Smoke 值 | 说明 |
|---|---|---|
| horizon | 96 | 只跑最短 horizon |
| batch_size | 16 | 强制缩小 |
| max_epochs | 2 | 只跑 2 轮 |
| timeout | 60 s | 超时即判 FAIL |

---

### 6.3 模型超参（`model_config`，按族分类）

#### nlinear — 通道独立线性映射

最轻量的 baseline，参数量 = `INPUT_LEN × HORIZON × NUM_CHANNELS`。

| 超参 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `residual` | bool | `true` | 是否先减去最后一个时间步再做线性映射（NLinear 原文做法，强烈推荐开启） |

实现细节：逐通道独立，`nn.Linear(512, horizon)`，无共享参数跨通道。

---

#### tiny_transformer — Patch Transformer

将输入窗口分成不重叠的 patch，做 token 嵌入后送入 Transformer Encoder，GlobalAvgPool 后接线性预测头。

| 超参 | 类型 | 范围 | 推荐值 | 说明 |
|---|---|---|---|---|
| `d_model` | int | [8, 1024] | 32 / 64 / 128 | Transformer 隐层维度，**必须能被 n_heads 整除** |
| `n_heads` | int | [1, 32] | 4 | 注意力头数，需满足 `d_model % n_heads == 0` |
| `n_layers` | int | [1, 24] | 1 / 2 / 3 | Encoder 层数 |
| `patch_size` | int | [2, 512] | 8 / 16 / 32 | patch 长度（同时也是 stride，不重叠） |
| `dropout` | float | [0.0, 0.9] | 0.0 / 0.1 | Dropout 率（应用于 FFN 和 Attention） |
| `ffn_mult` | float | [1.0, 16.0] | **4.0** | FFN 隐层维度倍数（`d_model × ffn_mult`），可选 |

**约束**：
- `d_model % n_heads == 0`（否则 validator 拒绝）
- `patch_size <= INPUT_LEN`（即 ≤ 512）
- stride 固定等于 patch_size（non-overlapping）

**参数量估算**（单个 horizon 模型）：
```
num_patches = 1 + (512 - patch_size) // patch_size
patch_embed: patch_size × d_model
pos_embed: num_patches × d_model
encoder × n_layers: ~4 × d_model²
head: d_model × horizon
```

---

#### patch_mlp — Patch MLP-Mixer

将输入分成 patch 后嵌入隐层，经过 n 个 MixerBlock（LayerNorm + 2 层 MLP + 残差），GlobalAvgPool 后线性预测。

| 超参 | 类型 | 范围 | 推荐值 | 说明 |
|---|---|---|---|---|
| `patch_size` | int | [2, 512] | 8 / 16 / 32 | patch 长度 |
| `stride` | int | [1, 512] | 通常 = patch_size / 2 | 滑动步长，**必须 ≤ patch_size** |
| `hidden_dim` | int | [8, 4096] | 64 / 128 / 256 | MLP 隐层维度（FFN 内部扩展为 2× hidden_dim） |
| `n_layers` | int | [1, 24] | 1 / 2 / 3 | MixerBlock 层数 |
| `dropout` | float | [0.0, 0.9] | 0.0 / 0.1 | Dropout 率 |

**约束**：
- `stride <= patch_size`（否则 validator 拒绝）
- `patch_size <= INPUT_LEN`

---

### 6.4 资源约束（`constraints`，可选）

可在 requirement 描述中用自然语言说明，LLM 会据此填入 candidate 的 `constraints` 字段。

| 字段 | 类型 | 上限 | 说明 |
|---|---|---|---|
| `params_max_million` | float | 1.0 M | 参数量软上限（超过不自动报错，但 LLM 会避免） |
| `time_budget_seconds` | int | 600 s | 训练时间上限（超过强制终止） |
| `latency_priority` | string | — | `low` / `medium` / `high`，影响 LLM 的架构选择倾向 |

---

### 6.5 在 requirement 中控制超参

你不需要直接写 JSON，只要在 `--requirement` 中用自然语言描述约束，LLM 会自动翻译：

```bash
# 倾向轻量模型
neo-cast design --requirement "a model under 0.1M params, nlinear preferred"

# 指定模型结构细节
neo-cast design --requirement "tiny transformer, d_model=64, 2 layers, patch_size=16"

# 资源约束
neo-cast design --requirement "fast inference (latency_priority=high), training budget 5 minutes"

# 多目标
neo-cast design --requirement "patch mlp, hidden_dim around 128, good on horizon 720"
```

---

## 7. 输出

每次成功的 `design` 运行会在 `.neo-cast/artifacts/run_<run_id>/` 生成 **10 个文件**的完整制品包：

```
run_20260425-143022-abc123/
├── model.pt              # PyTorch 模型权重
├── metadata.json         # 完整实验元数据（candidate、训练配置、评估结果）
├── model_impl.py         # 模型类定义（可独立使用）
├── inference.py          # 推理封装（load_model / predict API）
├── mcp_server.py         # MCP 工具服务器（供 AI Agent 调用）
├── tool_schema.json      # MCP 工具的 JSON Schema 描述
├── eval_report.md        # 评估报告（各 horizon MSE/MAE、与 baseline 对比）
├── README.md             # 制品使用说明
├── requirements.txt      # Python 依赖列表
└── example.py            # 快速推理示例脚本
```

### 如何使用输出

**直接运行推理：**

```bash
python .neo-cast/artifacts/run_<id>/example.py
# 输入：随机生成的 512 步历史数据（7 个通道）
# 输出：96/192/336/720 四个 horizon 的预测结果
```

**作为 AI Agent 工具（MCP）：**

```bash
python .neo-cast/artifacts/run_<id>/mcp_server.py
# 暴露 forecast(history, horizon) 工具
# history: [512][7] 的浮点数组
# horizon: 96 | 192 | 336 | 720
# 返回: [horizon][7] 的预测值
```

**查看评估报告：**

```bash
open -a Typora .neo-cast/artifacts/run_<id>/eval_report.md
# 包含各 horizon MSE/MAE，与 nlinear baseline 对比
```

**查看所有实验历史：**

```bash
neo-cast runner status
# 显示 results.tsv 中的历史记录
```

**运行参考测试集评估：**

```bash
neo-cast runner ref-test
# 在 ref_test split（时间步 11520–14400）上评估当前最优模型
# 评估结果追加到 eval_report.md
```

### 结果文件

`.neo-cast/results.tsv` 记录每次训练的摘要：

| 列 | 说明 |
|---|---|
| `run_id` | 唯一运行 ID |
| `candidate_id` | LLM 生成的候选 ID |
| `model_family` | 模型族（nlinear / tiny_transformer / patch_mlp） |
| `val_avg_mse` | 四个 horizon 平均验证 MSE |
| `status` | `keep` / `discard` / `crash` |
| `is_best` | `1` 表示截止目前最优 |

---

## 8. 常用命令速查

```bash
# 环境检查
neo-cast doctor

# 初始化运行时（首次）
neo-cast init-runtime

# 导入数据（首次）
neo-cast prepare-data --source /path/to/ETTh1.csv

# 苏格拉底模式：先问需求，自动训练 5 轮
neo-cast design \
  --requirement "long horizon transformer for ETTh1" \
  --mode socratic \
  --max-candidates 5

# 认知伴随模式：立即开始，实时叙述，最多 3 轮
neo-cast design \
  --requirement "efficient patch mlp model" \
  --mode companion \
  --max-candidates 3

# 无 API Key 的 mock 模式（调试用）
neo-cast design \
  --requirement "test" \
  --mode companion \
  --max-candidates 2 \
  --mock-llm

# 查看当前最优结果
neo-cast runner status

# 在参考测试集上评估
neo-cast runner ref-test

# 查看已生成的制品
ls .neo-cast/artifacts/

# 查看当前配置
neo-cast config show
```
