# NeoResearch（neo-cast）使用说明

> 版本 0.1.0 · 2026-04-29

---

## 一、系统是什么

**NeoResearch / neo-cast** 是一个自主时序预测模型构建工具。你用自然语言描述需求，它自动完成：

1. **设计**：用 LLM 将需求翻译成模型架构方案（Recipe JSON）
2. **训练**：编译 Recipe 为 PyTorch 模型并在给定数据集上训练
3. **评估**：在验证集 / 参考测试集上计算 MSE/MAE
4. **导出**：生成完整制品包（权重、推理代码、MCP 工具、评估报告）
5. **迭代**：根据结果决定保留（keep）或丢弃（discard），进入下一轮

整个流程以 **Recipe DSL**（`recipe_schema_v1`）为核心中间表示，LLM 不直接写代码，而是填写结构化 JSON，系统再编译执行。

---

## 二、目录结构

```
neo_cast/
├── bin/neo-cast.js          ← CLI 入口
├── src/
│   ├── cli.js               ← 命令路由
│   ├── llm.js               ← LLM 候选生成
│   ├── python-bridge.js     ← JS → Python subprocess 桥接
│   ├── runtime.js           ← Python venv 管理
│   └── modes/
│       ├── socratic.js      ← 苏格拉底交互模式
│       └── companion.js     ← 认知伴随模式
├── py/
│   ├── prepare_tsf.py       ← 数据准备（冻结）
│   ├── train.py             ← 训练循环
│   ├── runner.py            ← 实验状态机
│   ├── renderer.py          ← Recipe → resolved_candidate
│   ├── validate.py          ← Schema 校验 + smoke gate
│   ├── export.py            ← 制品包导出
│   ├── factory/
│   │   └── build_model.py   ← Recipe 编译器（核心）
│   ├── search/
│   │   └── mutate.py        ← 规则 mutation
│   └── schemas/
│       └── recipe_schema.json
├── .neo-cast/               ← 运行时状态目录（自动创建）
│   ├── current_candidate.json
│   ├── resolved_candidate.json
│   ├── runner_state.json
│   ├── results.tsv
│   ├── dataset/             ← 准备好的数据集
│   ├── artifacts/           ← 每次实验的制品
│   └── runtime/             ← Python venv
└── docs/
    ├── NeoResearch_使用说明.md   ← 本文件
    └── llm_reflection_agent_design.md
```

---

## 三、环境要求

| 依赖 | 版本要求 | 说明 |
|---|---|---|
| Node.js | ≥ 20 | 运行 CLI 和 LLM 调用 |
| uv | 任意版本 | 管理 Python venv |
| Python | ≥ 3.10 | 通过 uv 自动创建，不需要手动安装 |
| GPU | 可选 | CPU 也能跑，训练会更慢 |

---

## 四、快速上手

### 4.1 当前环境状态（本机已就绪）

本机的 `neo_cast/` 目录已完成初始化，**以下内容已经存在，无需重新执行**：

```
.neo-cast/runtime/.venv/   ← Python 3.12 venv，已安装所有依赖
.neo-cast/dataset/         ← ETTh1 数据集（可见集 + 参考测试集）
.neo-cast/runner_state.json ← 已有 session，13 次实验记录
```

验证环境：

```bash
cd neo_cast
node bin/neo-cast.js doctor
```

预期输出（当前）：
```
[FAIL] python3: Python 3.9.6 [runtime venv]   ← 系统 python 旧，但 venv 已就绪，不影响运行
[OK]   uv: Detected uv 0.10.8
[OK]   config: Resolved config is valid.
[OK]   runtime: Project runtime is ready at .neo-cast/runtime/.venv/bin/python
```

### 4.2 配置 API Key

当前 `~/.config/neo-cast/config.json` 已配置使用 aigcbest.top（OpenAI 兼容接口），只需在 shell 里设置 key：

```bash
export NEO_CAST_LLM_API_KEY="your-aigcbest-key"
```

写入 `~/.zshrc` 可持久生效：

```bash
echo 'export NEO_CAST_LLM_API_KEY="your-key"' >> ~/.zshrc
```

> **无 API Key 调试**：加 `--mock-llm` 参数，使用内置启发式规则生成候选，完全离线。

---

## 五、核心命令

### 5.1 `design` — 主命令

触发完整的"设计 → 训练 → 评估 → 迭代"循环。

```bash
node bin/neo-cast.js design \
  --requirement "..." \
  --mode socratic|companion \
  --max-candidates 3 \
  [--mock-llm] \
  [--use-reflection] \
  [--use-mutation] \
  [--stop-on-keep] \
  [--skip-smoke]
```

**参数说明**

| 参数 | 默认 | 说明 |
|---|---|---|
| `--requirement` | 必填 | 自然语言需求（中英文均可） |
| `--mode` | `socratic` | 交互模式，见下节 |
| `--max-candidates` | `1` | 最多尝试几个候选 |
| `--mock-llm` | 关 | 用启发式规则代替 LLM，不需要 API Key |
| `--use-reflection` | 关 | attempt > 1 时用反思 agent 分析上一轮结果并提出候选 |
| `--use-mutation` | 关 | attempt > 1 时用规则 mutation 而非重新生成 |
| `--stop-on-keep` | 关 | 某轮 keep 后提前停止；默认会跑满 `--max-candidates` |
| `--skip-smoke` | 关 | 跳过 smoke 验证（加速调试） |

**两种交互模式**

| 模式 | 行为 |
|---|---|
| `socratic`（苏格拉底） | 先通过问答收集需求细节（模型偏好、参数预算、延迟要求），确认后开始训练 |
| `companion`（认知伴随） | 立即开始训练，每轮打印决策过程，训练中可输入 `stop` 提前结束 |

**需求描述示例**

```bash
# 轻量线性基线
--requirement "small nlinear baseline, parameter budget under 0.1M"

# 长 horizon 场景
--requirement "a model that performs well on horizon 720, 关注长时依赖"

# 指定架构
--requirement "patch mlp with multiscale embedding, hidden_dim around 128"

# 中文需求
--requirement "适合多变量预测的模型，通道间相关性强"
```

### 5.2 `runner` — 底层实验控制

```bash
# 查看当前最优结果和 session 状态
node bin/neo-cast.js runner status

# 在参考测试集上评估当前最优模型（一次性）
node bin/neo-cast.js runner ref-test

# 手动触发一次训练（需要 current_candidate.json 已就绪）
node bin/neo-cast.js runner run --description "manual baseline"

# 重新初始化 session（清除历史状态，开启新一轮搜索）
node bin/neo-cast.js runner init --force
```

### 5.3 `validate` — 方案校验

```bash
# 校验一个 Recipe JSON 是否合法
node bin/neo-cast.js validate recipe /path/to/recipe.json

# 校验 + 快速 smoke run（2 epoch，验证能跑通）
node bin/neo-cast.js validate smoke

# 校验数据集 spec
node bin/neo-cast.js validate dataset .neo-cast/dataset_spec.json
```

### 5.4 其他命令

```bash
# 环境诊断
node bin/neo-cast.js doctor

# 查看当前配置（敏感信息脱敏）
node bin/neo-cast.js config show

# 准备新数据集（首次使用其他数据集时）
node bin/neo-cast.js prepare-data --source /path/to/ETTh1.csv

# 初始化 Python 运行时（首次或重建时）
node bin/neo-cast.js init-runtime
```

---

## 六、典型使用场景

### 场景 A：快速调试（无 GPU，无 API Key）

用 `--mock-llm` + `FAST_E2E` 验证流程是否正常，每轮约 30 秒：

```bash
cd neo_cast
export NEO_CAST_FAST_E2E=1  # 压缩训练至 2 epoch，加速验证

node bin/neo-cast.js design \
  --requirement "dlinear baseline for etth1" \
  --mode companion \
  --max-candidates 2 \
  --mock-llm
```

预期输出：
```
[requirement ]  dlinear baseline for etth1
[max rounds  ]  2

[Round 1     ]  trying recipe:none+linear
[source      ]  heuristic_mock
  Training…
[val_avg_mse ]  1.091770
[decision    ]  ✓ KEEP

design complete
[best model  ]  recipe:none+linear
[val_avg_mse ]  1.091770
```

### 场景 B：真实 LLM 搜索（有 API Key）

```bash
cd neo_cast
export NEO_CAST_LLM_API_KEY="your-key"

node bin/neo-cast.js design \
  --requirement "patch transformer for etth1, focus on reducing h720 MSE" \
  --mode companion \
  --max-candidates 5 \
  --use-reflection
```

每一轮结束后会打印：
```
design_attempt=2
candidate_source=anthropic
candidate_family=recipe:patch+transformer
candidate_id=recipe_patch_transformer_etth1_h720
runner_status=keep
runner_val_avg_mse=0.842310
```

### 场景 C：苏格拉底模式（需求不明确时）

```bash
node bin/neo-cast.js design \
  --requirement "我需要一个预测效果好的 ETTh1 模型" \
  --mode socratic \
  --max-candidates 3
```

终端会出现交互问答：
```
Model preference (transformer / dlinear / tcn / nbeats / timesnet / patch_mlp, blank to skip): transformer
Parameter budget in millions (blank for default):
Latency priority (low / medium / high, blank for default): medium
Any extra notes? (blank to skip): 长 horizon 720 要稳

Proceed? [Y/n]: Y
[设计循环开始，无需再交互]
```

跳过交互（CI 场景）：

```bash
node bin/neo-cast.js design \
  --requirement "efficient ETTh1 model" \
  --mode socratic \
  --model-preference transformer \
  --latency-priority medium \
  --yes \
  --max-candidates 3
```

### 场景 D：查看历史实验并评估

```bash
# 查看所有实验记录
node bin/neo-cast.js runner status

# 在参考测试集上评估最优模型（仅可调用有限次）
node bin/neo-cast.js runner ref-test

# 查看评估报告
open -a Typora .neo-cast/artifacts/run_20260429-010200-hbrp/eval_report.md
```

---

## 七、输出制品

每次成功训练在 `.neo-cast/artifacts/run_<run_id>/` 生成 **17 个文件**：

```
run_20260429-010200-hbrp/
├── model.pt               ← PyTorch 模型权重（per-horizon state dict）
├── model_impl.py          ← 模型类定义（可独立 import）
├── inference.py           ← 推理封装（load_model / predict API）
├── example.py             ← 快速推理示例
├── mcp_server.py          ← MCP 工具服务器（供 AI Agent 调用）
├── tool_schema.json       ← MCP 工具的 JSON Schema
├── eval_report.md         ← 评估报告（验证集 + 参考测试集 MSE/MAE）
├── val_metrics.json       ← 验证集指标（程序读取用）
├── training_summary.json  ← 架构摘要（backbone/params/训练时间）
├── preprocess.json        ← StandardScaler 参数（均值/方差）
├── metadata.json          ← 完整元数据
├── model_spec.json        ← 模型规格（用于部署校验）
├── patch_bundle.json      ← Recipe patch 包（实验复现用）
├── resolved_candidate.json ← 完整解析后的候选配置
├── README.md              ← 制品说明
├── requirements.txt       ← Python 依赖列表
└── ref_test_metrics.json  ← 参考测试集指标（如已评估）
```

**当前最优制品示例**（`run_20260429-010200-hbrp`）：

```
模型：linear + none embedding（NLinear baseline）
参数量：0.69 M
训练时间：5.3 秒

验证集（standard_scaled 空间）：
  avg  MSE=1.092  MAE=0.709
  h96  MSE=0.691  MAE=0.566
  h720 MSE=1.510  MAE=0.853

参考测试集：
  avg  MSE=0.438  MAE=0.444
  h96  MSE=0.404  MAE=0.419
  h720 MSE=0.471  MAE=0.479
```

### 使用推理接口

```python
# 直接运行示例脚本
python .neo-cast/artifacts/run_20260429-010200-hbrp/example.py

# 在自己代码里调用
from inference import load_model, predict

model = load_model("model.pt", "preprocess.json")
# history: shape [512, 7]，最近 512 步，7 个通道，原始（未归一化）值
predictions = predict(model, history, horizon=96)
# predictions: shape [96, 7]
```

### 启动 MCP 工具服务器

```bash
python .neo-cast/artifacts/run_20260429-010200-hbrp/mcp_server.py
# 暴露 forecast(history, horizon) 工具
# AI Agent 可通过 MCP 协议调用
```

---

## 八、固定协议参数（不可修改）

以下参数在 `py/prepare_tsf.py` 中固化，所有实验共享，保证实验可比性：

| 参数 | 值 | 说明 |
|---|---|---|
| `INPUT_LEN` | **512** | 输入窗口长度（时间步） |
| `HORIZONS` | **96 / 192 / 336 / 720** | 4 个预测长度，平均 MSE 作为主指标 |
| `NUM_CHANNELS` | **7** | ETTh1 通道数（HUFL/HULL/MUFL/MULL/LUFL/LULL/OT） |
| `SEED` | **42** | 全局随机种子 |
| `TIME_BUDGET` | **600 s** | 每次训练最大时间（10 分钟） |
| `PARAM_BUDGET` | **1,000,000** | 参数量软上限（1M） |
| 数据分割 | train [0, 8640) / val [8640, 11520) / ref_test [11520, 14400) | 按时间步，不随机打乱 |
| 归一化 | StandardScaler（按 train split fit） | val/test 用同一 scaler |

---

## 九、Recipe 动作空间

LLM 生成的候选必须符合 `recipe_schema_v1`，支持以下组合：

### Preprocessing（可叠加多个 action）

| type | 参数 | 说明 |
|---|---|---|
| `none` | — | 无预处理 |
| `instance_norm` | `affine`, `eps` | 实例归一化 |
| `series_decomposition` | `method="moving_average"`, `kernel_size` | 趋势/季节分解 |
| `seasonal_differencing` | `period`, `order` | 季节差分 |
| `missing_mask` | `mask_channel`, `fill_policy` | 缺失值掩码 |
| `sample_reweighting` | `scheme` | 样本重加权 |

### Embedding

| type | 说明 |
|---|---|
| `none` | 不嵌入，直接送 backbone |
| `patch` | 固定 patch 分割 + 线性投影 |
| `multiscale_patch` | 多尺度 patch 分支 + 跨尺度融合；`num_blocks` 控制处理深度 |
| `invert` | iTransformer 风格：逐变量归一化、对通道建 token；Transformer 路径不使用变量位置编码 |
| `frequency` | FFT 频域特征 |
| `calendar` | 时间特征（小时/星期/月） |

### Backbone（10 种）

| type | 适用场景 |
|---|---|
| `linear` | 最强轻量基线 |
| `mlp` | 局部特征学习 |
| `transformer` | 全局注意力，长序列 |
| `rnn` (gru/lstm) | 序列建模，有状态 |
| `dlinear` | 趋势/季节分解线性预测 |
| `tcn` | 因果卷积，局部-中程依赖 |
| `nbeats` | 残差回溯预测块 |
| `timesnet` | FFT 周期建模 + 2D 卷积 |
| `ssm` | 状态空间模型 |
| `mixer` | MLP-Mixer 时序版本 |

### Fusion

| type | 说明 |
|---|---|
| `temporal` (independent/shared) | 时间维度融合，独立/共享通道 |
| `feature` | 特征维度融合 |
| `temporal_then_feature` | 先时间后特征 |
| `feature_then_temporal` | 先特征后时间 |
| `graph` | 可学习邻接矩阵的图卷积 |
| `gated_hybrid` | 门控混合融合 |

### Prediction Head

| type | 说明 |
|---|---|
| `linear` | 点预测线性头 |
| `direct_multi_horizon` | 每个 horizon 独立头 |
| `quantile` | 分位数预测（不确定性） |
| `gaussian` | 高斯分布输出 |
| `residual_correction` | 残差修正头 |

---

## 十、实验管理

### 查看历史

```bash
# 控制台摘要
node bin/neo-cast.js runner status

# 完整结果表（TSV 格式）
cat .neo-cast/results.tsv | column -t

# 用 Python 分析
python3 -c "
import pandas as pd
df = pd.read_csv('.neo-cast/results.tsv', sep='\t')
print(df[['candidate_id','val_avg_mse','val_h96_mse','val_h720_mse','params_M','status']].to_string())
"
```

### 当前实验状态（2026-04-29）

```
session: 20260429-010149
实验次数: 13（含本次 session）
keep 次数: 1
当前最优: val_avg_mse=1.0918（linear+none，0.69M 参数）
最优 run_id: 20260429-010200-hbrp
```

> **注意**：历史实验均使用 `--mock-llm` 的启发式规则，都产出了相同的 linear 架构。使用真实 LLM 后才会出现架构多样性。

### 开始新一轮搜索

如果想清空当前 session 重新开始：

```bash
node bin/neo-cast.js runner init --force
# 之后正常运行 design 命令
```

旧的 artifacts 不会被删除，results.tsv 会重新初始化。

---

## 十一、常见问题

**Q：训练完所有轮次后只看到 1 个 keep，其他都是 discard，正常吗？**

A：正常。`--use-mutation` 模式下，mutation 规则的 `poor_val_mse=1.1` 阈值会让 linear 架构看起来"还 OK"，不会自动切换更复杂的架构。解决方法：
1. 默认不加 `--stop-on-keep`，让流程跑满所有轮
2. 加上 `--use-reflection` 启用 LLM 反思
3. 在 `--requirement` 里明确指定想要的架构（如 "transformer based"）

**Q：val_avg_mse 比参考文献高很多，怎么回事？**

A：val 集（时间步 8640-11520）的 MSE 在 StandardScaler 归一化空间下计算，与原始值不直接可比。ref_test 集的 MSE 更接近文献数值（当前最优 ref_test avg MSE=0.438）。

**Q：怎么在自己的数据集上跑？**

A：
```bash
# 替换为你的 CSV 文件，必须有 timestamp 列和特征列
node bin/neo-cast.js prepare-data \
  --source /path/to/your_data.csv \
  --task-id mytask \
  --feature-cols col1,col2,col3 \
  --timestamp-col timestamp \
  --force
```

**Q：`--use-reflection` 是什么？**

A：LLM 反思 agent 会在每次训练后分析 loss 曲线和 per-horizon 指标，生成有推理链的下一个候选。设计文档见 `docs/llm_reflection_agent_design.md`。

**Q：如何复现某次实验？**

A：每个 artifact 目录里的 `resolved_candidate.json` 包含完整的模型配置和训练参数（含固定随机种子 seed=42）：

```bash
cp .neo-cast/artifacts/run_20260429-010200-hbrp/resolved_candidate.json \
   .neo-cast/current_candidate.json
node bin/neo-cast.js runner run --description "reproduce" --skip-smoke
```

---

## 十二、命令速查表

```bash
# ── 环境 ──────────────────────────────────────────────────
node bin/neo-cast.js doctor                    # 环境诊断
node bin/neo-cast.js config show               # 查看配置
node bin/neo-cast.js init-runtime              # 初始化 Python venv

# ── 设计搜索（主工作流）────────────────────────────────────
# mock 模式（无 API Key，调试用）
export NEO_CAST_FAST_E2E=1
node bin/neo-cast.js design \
  --requirement "dlinear baseline" \
  --mode companion --max-candidates 2 --mock-llm

# 真实 LLM 搜索
export NEO_CAST_LLM_API_KEY="your-key"
node bin/neo-cast.js design \
  --requirement "patch transformer, focus on h720" \
  --mode companion --max-candidates 5 --use-reflection

# ── 实验管理 ──────────────────────────────────────────────
node bin/neo-cast.js runner status             # 当前最优和 session 信息
node bin/neo-cast.js runner ref-test           # 参考测试集评估（次数有限）
node bin/neo-cast.js runner init --force       # 重置 session

# ── 校验 ──────────────────────────────────────────────────
node bin/neo-cast.js validate recipe /path/to/recipe.json
node bin/neo-cast.js validate smoke            # smoke gate

# ── 制品查看 ──────────────────────────────────────────────
ls .neo-cast/artifacts/                        # 所有 run
open -a Typora .neo-cast/artifacts/run_<id>/eval_report.md
python .neo-cast/artifacts/run_<id>/example.py  # 运行推理示例
python .neo-cast/artifacts/run_<id>/mcp_server.py  # 启动 MCP 服务
```
