# neo-cast 可落地改造路线图

> 目标：把当前的本地研究闭环改造成一个可安装的 CLI 工具，支持用户提出时序建模需求，在固定协议下自动设计小模型、运行实验，并输出可复现的 artifact。

---

## 1. 产品定义

### 1.1 第一版真正要交付什么

第一版 `neo-cast` 不是“通用 AutoML 平台”，也不是“任意数据集都能自动建模”的大而全产品。  
它的范围先收敛为：

- 单任务：`ETTh1`
- 固定数据协议：沿用当前 `prepare_tsf.py`
- 固定搜索主指标：`val_avg_mse`
- 固定可编辑面：`train.py`
- 固定产物：训练结果、模型权重、可加载推理接口、最终评估报告

第一版主命令目标形态：

```bash
neo-cast design
```

用户体验目标：

1. 用户输入建模需求
2. CLI 通过对话澄清必要约束
3. 系统在固定协议下做若干轮候选实验
4. 系统输出最佳候选的 artifact 与报告

### 1.2 第一版暂不承诺什么

以下能力明确不纳入首版范围：

- 多数据集支持
- 多 seed 严格统计验证
- 跨任务研究记忆系统
- Blind test 在线服务
- 任意 Python 代码自由生成
- 从任意 `train.py` 自动提取完美 `model.py`

### 1.3 平台与版本支持

第一版**仅支持 macOS 与 Linux**，不支持 Windows（受 `uv` 与 shell 行为差异限制，Windows 留待 Phase 6+）。

最低版本要求：

- Node.js **>= 20**（ESM 模块格式）
- Python **>= 3.10**
- `uv`（最新稳定版）
- macOS 12+ / Ubuntu 22.04+

### 1.4 用户从零到第一个 artifact 的完整流程（Quickstart）

第一版的 onboarding 路径必须明确，避免用户卡在"装完不知道下一步"。

```bash
# 1. 安装 CLI
npm install -g neo-cast

# 2. 配置 API key（环境变量或写入用户级 config）
export ANTHROPIC_API_KEY="sk-ant-..."
neo-cast config init        # 生成 ~/.config/neo-cast/config.json

# 3. 检查环境（python3 / uv / API key / 网络）
neo-cast doctor

# 4. 创建项目级 Python runtime
mkdir my-tsf-project && cd my-tsf-project
neo-cast init-runtime       # 在 .neo-cast/runtime/.venv 安装 torch 等依赖

# 5. 准备数据（用户需先自行下载 ETTh1.csv）
# 下载来源：https://github.com/thuml/Time-Series-Library
neo-cast prepare-data --source ~/Downloads/ETTh1.csv

# 6. 开始设计模型
neo-cast design                     # 默认苏格拉底模式
# 或：neo-cast design --mode companion --max-candidates 10

# 7. 完成后查看 artifact
ls .neo-cast/artifacts/run_*/
# → model.pt, metadata.json, mcp_server.py, inference.py, README.md, ...

# 8. 部署使用
# 方式一：人类直接 inference
cd .neo-cast/artifacts/run_<id>/
pip install -r requirements.txt
python example.py

# 方式二：作为 agent tool（MCP）
python mcp_server.py        # stdio transport，等待 MCP client 连接
```

每一步都有对应的 CLI 命令或文档支撑，用户不需要去翻源码。

---

## 2. 关键产品原则

### 2.1 先 contract，后 agent

先把下面 12 个 contract 定死，再做 Node.js 对话层和 LLM 自动化：

1. Runtime contract（运行时环境）
2. Source Layout contract（源码目录）
3. Artifact ABI contract（产物格式）
4. Candidate contract（候选结构）
5. Data Preparation contract（数据准备）
6. Workspace & Session contract（工作目录与会话）
7. Crash Recovery contract（异常处理）
8. Test Exposure contract（测试集暴露）
9. API Config contract（密钥与配置）
10. Renderer contract（候选 → 训练脚本）
11. IPC Protocol contract（Python ↔ Node.js 事件流）
12. Exit Code contract（子进程退出码语义）

### 2.2 `val` 是搜索信号，`ref_test` 是最终报告信号

第一版里：

- `val_avg_mse` 是唯一高频决策指标
- `ref_test` 只在最终最佳候选上执行一次，进入最终报告
- `ref_test` 不能作为每轮 keep/discard 的搜索信号

这样做是为了避免产品流程一开始就把 test 集用坏。

### 2.3 不做“事后代码抽取”，改做“受限导出”

与其从任意 LLM 生成的 `train.py` 中事后提取干净 `model.py`，更稳的方式是：

- 先规定一个可导出的模型接口
- 候选模型必须遵循这个接口
- `export.py` 基于这个接口生成推理包

也就是说，导出能力来自**设计时约束**，不是事后 AST 魔法。

### 2.4 先做 validator / smoke run，再做自动多轮搜索

自动生成代码最容易失败的地方不是“模型不够聪明”，而是：

- 代码不合法
- shape 不对
- 输出格式不对
- 训练直接 crash

所以 validator 和 smoke harness 必须前置，不能推后。

---

## 3. 收紧后的整体架构

```
用户 CLI 输入
     │
     ▼
┌──────────────────────────────────────┐
│            Node.js CLI 层             │
│  需求澄清 │ 任务编排 │ LLM 调用 │ 输出呈现 │
└──────────────────┬───────────────────┘
                   │ spawn Python
                   ▼
┌──────────────────────────────────────┐
│           Python Runtime 层           │
│  prepare_tsf.py   固定数据/评估协议   │
│  train.py         候选模型执行入口     │
│  runner.py        keep/discard 状态机 │
│  validate.py      新增，静态检查/烟测  │
│  export.py        新增，artifact 导出 │
└──────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│             Artifact 层               │
│  model.pt / metadata.json / report.md │
│  inference.py / model_impl.py         │
└──────────────────────────────────────┘
```

---

## 4. 必须先定死的 contract

### 4.1 Runtime Contract

第一版不承诺“安装 npm 包就自动带好 Python 运行时”。  
第一版明确采用：

- npm CLI + 本机 Python 环境
- 本机 `python3 >= 3.10`
- 本机 `uv`
- 首次运行时由 CLI 引导安装 Python 依赖

也就是说：

- `npm install -g neo-cast` 负责安装 CLI
- `neo-cast doctor` 负责检查环境
- `neo-cast init-runtime` 负责在本地创建运行环境

这比单靠 `postinstall` 检查更可执行。

### 4.2 Source Layout Contract

避免双份源码漂移。  
第一版只保留一份 Python 源码目录，例如：

```text
neo-cast/
  bin/
  src/
  py/
    prepare_tsf.py
    train.py
    runner.py
    validate.py
    export.py
    pyproject.toml
```

Node.js 永远只调用 `py/` 下的代码，不再维护“根目录一份 + python/ 一份”的双轨结构。

### 4.3 Artifact ABI

第一版统一规定每次成功候选导出**一个完整的、可独立交付的小模型代码库**：

```text
artifacts/run_<id>/
  ├── model.pt                ← 训练好的权重 + 最小配置
  ├── metadata.json           ← 任务/模型/需求溯源/探索过程的结构化元数据
  ├── preprocess.json         ← 推理前处理 contract（特征顺序、scaler 统计量、输入空间）
  ├── model_impl.py           ← 推理所需的模型定义（无训练代码）
  ├── inference.py            ← 人类直接 Inference 的统一 Python API
  ├── mcp_server.py           ← agent tool-call 形态的 MCP server 启动器
  ├── tool_schema.json        ← MCP tool schema（输入/输出 JSON Schema）
  ├── eval_report.md          ← 验证集 + 测试集评估报告
  ├── README.md               ← 该代码库为什么需求定制 + 两种使用方式
  ├── requirements.txt        ← 运行依赖（torch>=2.2、numpy、anthropic-mcp 等）
  └── example.py              ← 最小可运行调用样例
```

字段 contract：

- `model.pt`：只保存权重与最小必要配置
- `metadata.json`：ABI 核心，下文详述
- `preprocess.json`：保存 `feature_names`、`input_space`、`output_space`、`scaler_mean`、`scaler_std`
- `model_impl.py`：只包含推理所需模型定义
- `inference.py`：暴露统一 `load_model()` / `predict()` 接口（人类 Inference 用）
- `mcp_server.py`：用 MCP 协议把模型暴露为可被 agent 调用的工具（tool-call 用），基于官方 [`mcp>=1.0`](https://pypi.org/project/mcp/) Python SDK 实现，artifact `requirements.txt` 必须列出 `mcp>=1.0`
- `tool_schema.json`：MCP tool 的输入/输出 schema 与自然语言描述
- `eval_report.md`：最终结果与参考基线
- `README.md`：把 metadata.json 的需求溯源信息可读化呈现，包含 quickstart
- `requirements.txt`：运行依赖，用户能 `pip install -r requirements.txt` 即用
- `example.py`：一个最小调用样例，验证 artifact 能跑通

关键点：

- `metadata.json` 才是 ABI 核心，不是 `train.py` 本身
- artifact 必须是**自包含的**——拿走整个目录，删掉 neo-cast，仍然能 inference
- 后续允许多个模型家族共存，只要它们都遵循同一导出 ABI

补充约定：

- artifact 必须同时支持两种输入口径：
  - `predict_normalized(history, horizon)`：输入为标准化空间
  - `predict_raw(history, horizon)`：输入为原始数值空间，由 `inference.py` 读取 `preprocess.json` 完成标准化
- `tool_schema.json` / `mcp_server.py` / `README.md` 必须明确声明当前对外暴露的是哪一种输入口径
- 第一版默认对外暴露 **raw space** 接口；标准化空间接口只作为内部高级接口保留

#### `metadata.json` 字段规范

```json
{
  "artifact_version": "v1",
  "task_id": "etth1",
  "model_family": "tiny_transformer",
  "model_impl_entry": "model_impl.py:build_model",
  "state_dict_layout": "per_horizon",
  "input_len": 512,
  "horizons": [96, 192, 336, 720],
  "num_channels": 7,
  "normalization_space": "standard_scaled",
  "feature_names": ["HUFL", "HULL", "MUFL", "MULL", "LUFL", "LULL", "OT"],
  "preprocess_entry": "preprocess.json",

  "user_requirement": "用户原始需求文本（natural language）",
  "design_hypothesis": "LLM 选择 tiny_transformer 是因为用户提到长 horizon + 季节性",
  "exploration_log": [
    {
      "candidate_id": 1,
      "model_family": "nlinear",
      "model_config": {},
      "verdict": "keep",
      "val_avg_mse": 0.4521,
      "reason": "baseline，初始 best"
    },
    {
      "candidate_id": 2,
      "model_family": "tiny_transformer",
      "model_config": {"d_model": 64, "n_heads": 4, "n_layers": 2, "patch_size": 16, "dropout": 0.1},
      "verdict": "keep",
      "val_avg_mse": 0.4387,
      "reason": "patch + attention 在长 horizon 上比 nlinear 改善 0.013"
    }
  ],

  "val_metrics": {
    "val_avg_mse": 0.4387,
    "val_h96_mse": 0.391,
    "val_h720_mse": 0.482
  },
  "ref_test_metrics": {
    "ref_test_avg_mse": 0.4534,
    "ref_test_h96_mse": 0.398,
    "ref_test_h720_mse": 0.491
  }
}
```

补充约定：

- `artifact_version` 用于未来 ABI 迁移
- `model_impl_entry` 指定恢复模型时的构造入口
- `state_dict_layout` 明确是 `single_model`、`per_horizon` 还是 `shared_backbone`
- `normalization_space` 明确 `predict()` 输入输出所在空间，避免推理时口径漂移
- `feature_names` 必须与 `preprocess.json` 中的顺序一致，禁止推理时自行猜测列顺序
- `user_requirement` / `design_hypothesis` / `exploration_log` 提供**需求溯源能力**，让 artifact 真正"为某个需求专门定制"

#### Tool-call 形态规范（MCP server）

`mcp_server.py` 用 [Model Context Protocol](https://modelcontextprotocol.io) 把模型封装为 agent 可直接调用的 tool。第一版只暴露一个 tool：

```python
# mcp_server.py 启动后注册一个 tool
{
  "name": "etth1_forecast",
  "description": "Forecast ETTh1 multivariate time series. Input a 512-step history window of 7 channels, output predictions for the requested horizon.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "history": {
        "type": "array",
        "description": "Shape [512, 7] in raw ETTh1 feature space, ordered as feature_names in preprocess.json",
        "items": {"type": "array", "items": {"type": "number"}}
      },
      "horizon": {
        "type": "integer",
        "enum": [96, 192, 336, 720]
      }
    },
    "required": ["history", "horizon"]
  }
}
```

启动方式：

```bash
# 在 artifact 目录下
python mcp_server.py        # 默认 stdio transport
python mcp_server.py --http # 可选 HTTP transport
```

Agent 端通过 MCP client 直接 `tools/list` + `tools/call` 即可调用，无需额外胶水代码。`tool_schema.json` 是上述 schema 的独立文件版本，方便其他 client 静态读取。

### 4.4 Candidate Contract

LLM 不能直接输出”任意 `train.py`”。  
第一版收紧为输出一个结构化候选：

```json
{
  “hypothesis”: “短 patch + 轻量 self-attention 更适合 ETTh1”,
  “model_family”: “tiny_transformer”,
  “model_config”: {
    “d_model”: 64,
    “n_heads”: 4,
    “n_layers”: 2,
    “dropout”: 0.1
  },
  “train_config”: {
    “lr”: 0.001,
    “batch_size”: 32,
    “max_epochs”: 50
  }
}
```

candidate JSON 由 Node.js 写入 `<project>/.neo-cast/current_candidate.json`，再由 Python 侧的 `renderer.py` 读取、校验、归一化为 `<project>/.neo-cast/resolved_candidate.json`。固定的 `train.py` 只读取 `resolved_candidate.json` 并 dispatch 到对应模型族。Node.js 不理解模型 config 语义，也不生成 Python 代码。

#### 第一版支持的模型族（`candidate_schema.json`）

第一版只支持以下三个受限模型族，validator 和 LLM 都必须在此范围内生成候选：

```json
{
  “model_families”: {
    “nlinear”: {
      “description”: “Channel-Independent NLinear，最简线性基线，无额外 model_config”,
      “model_config”: {}
    },
    “tiny_transformer”: {
      “description”: “轻量 Patch Transformer，CI 建模，patch 化输入 + 多头自注意力”,
      “model_config”: {
        “d_model”:    { “type”: “int”,   “choices”: [32, 64, 128] },
        “n_heads”:    { “type”: “int”,   “choices”: [2, 4, 8] },
        “n_layers”:   { “type”: “int”,   “choices”: [1, 2, 3, 4] },
        “patch_size”: { “type”: “int”,   “choices”: [8, 16, 32] },
        “dropout”:    { “type”: “float”, “choices”: [0.0, 0.1, 0.2] }
      }
    },
    “patch_mlp”: {
      “description”: “Patch MLP-Mixer，CI 建模，patch 化后用 MLP 做时间维度 mixing”,
      “model_config”: {
        “patch_size”:  { “type”: “int”,   “choices”: [8, 16, 32] },
        “stride”:      { “type”: “int”,   “choices”: [4, 8, 16] },
        “hidden_dim”:  { “type”: “int”,   “choices”: [64, 128, 256] },
        “dropout”:     { “type”: “float”, “choices”: [0.0, 0.1, 0.2] }
      }
    }
  },
  “train_config_schema”: {
    “lr”:         { “type”: “float”, “range”: [1e-4, 1e-2] },
    “batch_size”: { “type”: “int”,   “choices”: [16, 32, 64] },
    “max_epochs”: { “type”: “int”,   “range”: [10, 100] }
  }
}
```

约定：
- `model_family` 必须是上述三者之一，否则 validator 直接拒绝
- `model_config` 中的字段值必须在对应 `choices` 或 `range` 内，否则 validator 拒绝
- `nlinear` 的 `model_config` 必须为空对象 `{}`
- 扩展新模型族需同步更新 `candidate_schema.json`，不允许直接在 candidate 中使用未注册的族

#### 预算来源与默认值

第一版把实验预算视为 task preset，而不是散落在各脚本里的魔法数。默认来源优先级：

1. CLI flags（若实现）
2. 项目级 config
3. candidate `constraints`（只允许收紧，不允许放宽平台上限）
4. task preset 默认值

ETTh1 第一版默认值：

- `PARAM_BUDGET = 1.0`（单位：million parameters）
- `TIME_BUDGET = 1800`（单位：seconds，单 candidate full run）

`renderer.py` 必须把最终生效的 `param_budget_m` / `time_budget_s` 写入 `resolved_candidate.json`，后续 `validate.py`、`train.py`、`runner.py` 一律只消费 resolved 值，不再各自设默认数。

### 4.5 Data Preparation Contract

第一版规定数据准备由用户侧完成，CLI 提供引导工具，不内置自动下载。

#### 用户流程

```bash
# 1. 用户自行下载 ETTh1.csv（来源：Time-Series-Library 数据集）
# 2. 初始化数据
neo-cast prepare-data --source /path/to/ETTh1.csv

# 检查数据是否就绪
neo-cast doctor
```

`prepare-data` 命令内部调用 `prepare_tsf.py --materialize-visible`，生成：
- `~/.cache/neo_research_tsf/dataset/ETT-small/ETTh1_visible.csv`（train+val，Agent 可见）
- `~/.cache/neo_research_tsf/dataset/ETT-small/ETTh1_ref_test.csv`（test，仅 CLI 最终评估时使用）

#### 边界约定

- 数据路径支持环境变量覆盖：`NEO_TSF_DATA_ROOT`
- `neo-cast design` 启动时若检测到数据未就绪，给出明确提示并引导执行 `prepare-data`
- 第一版不支持用户传入自定义 CSV，若传入非 ETTh1 格式文件，给出友好报错

### 4.6 Workspace & Session Contract

第一版需要明确所有运行时状态放在哪里，避免 `config`、candidate、`results.tsv`、artifact 四处散落。

默认采用：

- 项目级状态目录：`<project>/.neo-cast/`
- 项目级 runtime：`<project>/.neo-cast/runtime/.venv`
- 项目级会话目录：`<project>/.neo-cast/sessions/<session_id>/`
- 项目级结果表：`<project>/.neo-cast/results.tsv`
- 项目级 candidate 文件：`<project>/.neo-cast/current_candidate.json`
- 项目级 artifact 目录：`<project>/.neo-cast/artifacts/run_<id>/`

其中：

- 用户级 config 仍放 `~/.config/neo-cast/config.json`
- 项目级 config 放 `<project>/.neo-cast/config.json`
- Python bridge、runner、exporter 一律只读写项目级状态目录

`session_id` 第一版建议采用：

- `YYYYMMDD-HHMMSS-<short_random>`

这样做的好处是：

- 删除项目目录即可清理项目状态
- 不同项目互不污染
- `python-bridge` 不需要猜测结果文件放在哪里

### 4.7 Crash Recovery Contract

训练过程中 crash 是常见情况（OOM、shape 错误、NaN loss 等），第一版规定统一处理策略：

| 情形 | 判定条件 | 处理方式 |
|---|---|---|
| Smoke run crash | smoke run 非零退出或超时 | 标记 candidate 为 `invalid`，跳过，不进入 full run |
| Full run crash | full run 非零退出或超时 | 标记为 `crash`，记录到 `results.tsv`，丢弃本次 workdir，保留当前 best run 指针 |
| NaN 指标 | stdout 中 val_avg_mse = NaN | 等同 crash 处理 |
| 超出 TIME_BUDGET | runner 检测到超时 | 截断训练，用已有最优 checkpoint 评估，不视为 crash |

重试策略：
- **不自动重试**，crash 后直接跳过当前 candidate，由 LLM 提出下一个 candidate
- 连续 3 次 crash 后暂停循环，向用户报告并等待指令

补充说明：

- 第一版的“回滚”语义不是 `git reset`
- “回滚”只表示 best pointer 不前移，当前 candidate 对应 workdir 和临时文件被丢弃
- `runner.py` 通过 `best_run_id` 或 `best_artifact_path` 维护当前最佳状态，而不是依赖 git 历史

### 4.8 Test Exposure Contract

第一版规定：

- 普通实验循环只看 validation
- `evaluate_ref_test()` 只对最终最佳候选调用
- 最终 CLI 输出可以展示 test 结果
- 中间过程不把 `ref_test` 回灌给下一轮搜索

### 4.9 API Config Contract

第一版默认只实现一个 provider：`anthropic`。  
但配置层从一开始就要做成 provider-aware，避免后面把 `llm.js` 写死。

#### 密钥与配置的职责分离

- 密钥只放环境变量或系统安全存储
- 非敏感项放配置文件
- 项目配置允许覆盖用户级默认配置

第一版默认约定：

- `ANTHROPIC_API_KEY`
- 可选：`ANTHROPIC_BASE_URL`

#### 配置文件位置

建议同时支持两层配置：

- 用户级：`~/.config/neo-cast/config.json`
- 项目级：`<project>/.neo-cast/config.json`

#### 配置优先级

统一采用：

1. CLI flags
2. 项目级 config
3. 用户级 config
4. 环境变量
5. 默认值

#### 第一版建议配置结构

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4",
    "base_url": null,
    "max_tokens": 4000,
    "temperature": 0.2,
    "timeout_seconds": 120
  }
}
```

#### Node.js 侧 contract

`src/llm.js` 不应该在各处直接散读环境变量。  
更稳的做法是：

- `src/config.js` 统一解析 env / 用户级 config / 项目级 config / CLI flags
- `src/llm.js` 只消费一个已经合并好的 `resolvedConfig.llm`

#### CLI 命令建议

为了让 API 配置真正可用，第一版建议增加：

- `neo-cast doctor`
  检查 `ANTHROPIC_API_KEY`、网络连通性、model 配置合法性
- `neo-cast config init`
  生成用户级默认配置文件
- `neo-cast config show`
  展示当前生效配置，隐藏密钥

#### 安全边界

- API key 不写入项目仓库
- `.neo-cast/config.json` 若包含敏感字段，必须默认加入 `.gitignore`
- CLI 输出配置时必须 mask key
- 日志中不得打印完整请求头

### 4.10 Renderer Contract（方案 A：动态注册）

`renderer.py` 不生成新的 `train.py` 文件，而是把 `current_candidate.json` 归一化成稳定的 `resolved_candidate.json`，供固定的 `train.py` 读取并 dispatch 到对应模型族。

#### 目录结构

```text
py/
  train.py                   ← 固定入口，不由 LLM 修改
  renderer.py                ← candidate 校验 + 归一化辅助
  candidate_schema.json
  families/
    __init__.py              ← 注册表：FAMILY_REGISTRY = {"nlinear": ..., ...}
    nlinear.py               ← 实现 build_model(model_config, input_len, horizon) -> nn.Module
    tiny_transformer.py
    patch_mlp.py
```

#### 每个 family 模块的契约

```python
# py/families/tiny_transformer.py
import torch.nn as nn

def build_model(model_config: dict, input_len: int, horizon: int) -> nn.Module:
    """
    从 candidate 的 model_config 构建模型。
    必须返回一个 forward(x: [B, input_len, 7]) -> [B, horizon, 7] 的 nn.Module。
    """
    ...

# 每个 family 同时导出一个 FAMILY_SPEC
FAMILY_SPEC = {
    "name": "tiny_transformer",
    "model_impl_template": "families/tiny_transformer.py",  # export.py 复制到 model_impl.py
    "state_dict_layout": "per_horizon",
}
```

#### `train.py` 的 dispatch 流程

```python
# 固定 train.py 伪码
candidate = json.load(open(".neo-cast/resolved_candidate.json"))

family_module = FAMILY_REGISTRY[candidate["model_family"]]
models = {
    h: family_module.build_model(candidate["model_config"], INPUT_LEN, h).to(device)
    for h in HORIZONS
}
# ...使用 candidate["train_config"] 设 lr / batch_size / max_epochs
```

关键点：

- 这是**方案 A（动态注册）**，不是代码生成
- LLM 永远不写 Python 代码，只产生 candidate JSON
- 扩展新模型族 = 新增 `py/families/<name>.py` + 更新 `candidate_schema.json`
- `renderer.py` 的职责是“校验 + 归一化 + 生成稳定运行时配置”，不是代码生成
- `export.py` 复制 `py/families/<model_family>.py` 作为 artifact 的 `model_impl.py`，配合 `metadata.json` 中 `model_impl_entry: "model_impl.py:build_model"` 即可独立恢复模型

### 4.11 IPC Protocol Contract（stdout 事件流）

Python 子进程通过 **NDJSON（每行一个 JSON 对象）** 在 stdout 汇报事件，Node.js 按行解析。

#### 事件类型

```jsonl
{"event":"stage_start","stage":"smoke","candidate_id":3}
{"event":"smoke_pass","elapsed_s":42.1}
{"event":"stage_start","stage":"full","candidate_id":3}
{"event":"epoch_end","horizon":96,"epoch":1,"val_loss":0.512}
{"event":"epoch_end","horizon":96,"epoch":2,"val_loss":0.478}
{"event":"horizon_done","horizon":96,"best_val_loss":0.391}
{"event":"eval_done","val_avg_mse":0.4387,"val_h96_mse":0.391,"val_h720_mse":0.482}
{"event":"artifact_ready","artifact_dir":"/abs/path/.neo-cast/artifacts/run_<id>"}
{"event":"done","status":"success"}
```

错误路径：

```jsonl
{"event":"error","kind":"shape_mismatch","message":"expected [B,96,7] got [B,96,1]","candidate_id":3}
{"event":"done","status":"crash"}
```

#### 约定

- 每行必须是合法 JSON，禁止跨行（Node.js 按 `\n` 分割即可）
- 非事件输出（如 Python warning / torch 噪声）一律走 stderr，不走 stdout
- `done` 必须是最后一条事件
- companion 模式只消费 `stage_start` / `epoch_end` / `horizon_done` / `eval_done` / `error`
- socratic 模式只消费 `done` + `artifact_ready` + `error`

### 4.12 Exit Code Contract

所有 Python 子进程（`train.py` / `validate.py` / `renderer.py` / `export.py`）必须遵循统一退出码：

| Code | 含义 | 典型触发 |
|---|---|---|
| 0 | 成功 | 正常结束，`done: success` 已打印 |
| 1 | 训练 crash | OOM、NaN loss、shape mismatch、forward 异常 |
| 2 | candidate schema 非法 | validator 拒绝，不进入训练 |
| 3 | smoke run 失败 | smoke 阶段未输出合法 `smoke_eval_done` / `eval_done` 事件 |
| 4 | 环境缺失 | 数据未 materialize、模型族未注册 |
| 124 | 超时 | 沿用 unix `timeout` 约定 |

Node.js 侧基于退出码做分支：

```javascript
switch (exitCode) {
  case 0:   return "success";
  case 1:   return "crash";       // 记 results.tsv, 丢弃 workdir
  case 2:   return "invalid";     // 不计入 crash_count，让 LLM 重新生成
  case 3:   return "smoke_fail";  // 同 invalid
  case 4:   return "env_error";   // 中止，提示用户跑 doctor
  case 124: return "timeout";     // 等同 crash
  default:  return "unknown";
}
```

---

## 5. 重排后的阶段路线

### Phase 0：基础重构与 contract 落地

**目标：** 先把现有仓库改造成后续 CLI 可以稳定调用的内核。

**要做的事：**

- 把 Python 源码收敛到单一 `py/` 目录
- 补 `metadata.json` 规范
- 明确 artifact 目录结构
- 明确 `.neo-cast/` 目录结构
- 明确 `runner.py` 在 CLI 产品中的职责
- 把 `ref_test` 的触发边界写死

**需要落地的文件：**

- `py/prepare_tsf.py`
- `py/train.py`
- `py/runner.py`
- `py/renderer.py`（新增，candidate JSON → resolved_candidate.json）
- `py/export.py`
- `py/candidate_schema.json`（三个模型族的字段与取值约束）
- `py/ARTIFACT_SPEC.md` 或在 README/ROADMAP 中内嵌
- `.neo-cast/README.md` 或在 README/ROADMAP 中内嵌状态目录规范

**里程碑验收：**

- [ ] Python 侧只有一份源代码
- [ ] 成功训练后能稳定生成 `artifacts/run_<id>/`
- [ ] `metadata.json` 字段稳定，可被外部程序读取
- [ ] `.neo-cast/` 目录布局固定，bridge/runner/export 共用同一套路径
- [ ] `ref_test` 只在最终导出阶段执行

---

### Phase 1：Runtime 与 CLI 外壳

**目标：** 让 npm 安装和本地运行环境真正闭环。

**Node.js 技术栈（已选定）：**

```json
{
  "type": "module",
  "engines": { "node": ">=20" },
  "dependencies": {
    "commander": "^12",                  // CLI 框架（轻量）
    "@inquirer/prompts": "^5",           // 交互式提问（苏格拉底澄清）
    "@anthropic-ai/sdk": "^0.30",        // 官方 LLM SDK
    "picocolors": "^1"                   // 极轻量颜色输出
  }
}
```

约定：
- 模块格式：**ESM**（`"type": "module"`）
- 文件后缀统一 `.js`，import 时显式带后缀
- 不引入 TypeScript（首版避免编译步骤）
- 不引入 oclif / yargs / chalk（更重的替代品，第一版不需要）

**新增文件结构：**

```text
neo-cast/
  package.json
  bin/neo-cast.js
  src/cli.js
  src/config.js
  src/doctor.js
  src/runtime.js
  py/
```

**建议命令：**

- `neo-cast --version`
- `neo-cast doctor`
- `neo-cast config init`
- `neo-cast config show`
- `neo-cast init-runtime`
- `neo-cast prepare-data --source /path/to/ETTh1.csv`
- `neo-cast design`

**运行时策略：**

- `doctor` 检查 `python3`、`uv`、CUDA 可用性、Anthropic API Key、LLM 配置
- `init-runtime` 默认在 `<project>/.neo-cast/runtime/.venv` 创建项目级运行环境
- `design` 若发现 runtime 未就绪，先提示执行 `init-runtime`
- `python-bridge` 默认使用 `<project>/.neo-cast/runtime/.venv` 中的解释器；缺失时再回退到系统 `python3`

**里程碑验收：**

- [ ] `npm install -g neo-cast && neo-cast --version` 正常
- [ ] `neo-cast doctor` 能明确告诉用户缺什么
- [ ] `neo-cast config init/show` 能正确生成并展示脱敏后的配置
- [ ] `neo-cast init-runtime` 能完成 Python 依赖安装

---

### Phase 2：Python 导出与最终评估

**目标：** 先把“能训练”升级成“能交付结果”。

#### 2.1 `train.py`

训练结束后保存：

- 权重文件
- 最小配置
- validation 结果
- 候选标识

stdout 只输出 NDJSON 事件，例如：

```jsonl
{"event":"artifact_ready","artifact_dir":"/abs/path/<project>/.neo-cast/artifacts/run_1710000000"}
{"event":"eval_done","val_avg_mse":0.438700}
{"event":"done","status":"success"}
```

这里的 `artifact_dir` 必须是项目级绝对路径，不能依赖当前 shell cwd。若要输出给人看的摘要文本，应走 stderr 或由 Node.js 在收到事件后再格式化展示。

#### 2.2 `prepare_tsf.py`

新增最终评估接口：

```python
def evaluate_ref_test(final_models: dict, device: torch.device) -> dict:
    ...
```

要求：

- 只能在最终导出或显式 promotion 步骤调用
- 不进入日常 keep/discard 循环

#### 2.3 `export.py`

不做”从任意脚本提取模型类”，改为基于受限模型模板生成完整 artifact 目录：

- `model.pt`（权重）
- `preprocess.json`（特征顺序 + scaler 统计量 + 输入输出空间）
- `model_impl.py`（从模型族模板渲染）
- `inference.py`（统一接口）
- `mcp_server.py`（MCP 协议 server，暴露 `forecast` tool）
- `tool_schema.json`（MCP tool schema 独立文件版）
- `metadata.json`（含 user_requirement / design_hypothesis / exploration_log）
- `eval_report.md`（val + test 结果）
- `README.md`（需求 + 两种使用方式：直接 inference / MCP tool）
- `requirements.txt`（torch、numpy，以及 MCP 相关依赖）
- `example.py`（最小调用样例）

**里程碑验收：**

- [ ] 每个成功 run 都有完整 artifact 目录（11 个文件齐全）
- [ ] `model.pt + metadata.json` 足够恢复模型
- [ ] `preprocess.json + inference.py` 足够处理 raw input 并完成推理
- [ ] `inference.py` 可独立 load 并推理
- [ ] `python mcp_server.py` 启动后能被 MCP client 正常 list/call
- [ ] `metadata.json` 中的 `user_requirement` / `exploration_log` 字段非空
- [ ] artifact 目录脱离 neo-cast 仓库后仍可独立运行（`pip install -r requirements.txt && python example.py`）
- [ ] 最终 `eval_report.md` 与真实数值一致

---

### Phase 3：Validator 与最小自动搜索

**目标：** 在接 LLM 前先把“生成候选 -> 检查 -> 烟测 -> 正式训练”的保护链补上。

**新增文件：**

```text
py/
  renderer.py          ← candidate JSON → resolved_candidate.json
  validate.py          ← schema 校验 + smoke run
  candidate_schema.json  ← 三个模型族的字段与取值约束
```

**最小执行顺序：**

1. 生成结构化 candidate
2. schema 校验
3. 归一化为运行时配置（`resolved_candidate.json`）
4. smoke run（见下方定义）
5. full validation run
6. keep/discard
7. 仅对最终最佳候选做 `ref_test`

**Smoke run 定义：**

Smoke run 是 full run 的最小子集，目的只是提前拦截"必然 crash"的候选，不作为精度评估依据。

第一版 smoke run 采用固定策略：
- 只跑 **2 个 epoch**
- 只用 **horizon=96**（最短 horizon，最快出结果）
- batch size 固定为 `16`（小内存友好）
- 超时上限：**60 秒**，超时即视为 crash

smoke run 通过的标准：
- 训练无异常退出
- 至少输出一条 `smoke_eval_done` 或 `eval_done` 事件，且其中 `val_h96_mse` 非 NaN
- 参数量不超过 `2 × PARAM_BUDGET`

smoke run **不作为** keep/discard 依据，不进入 results.tsv，只作为 pass/fail 的门控。

**validator 需要覆盖：**

- 必填字段
- 模型族是否合法
- 参数预算是否合法
- 输出 shape 是否符合 `[B, horizon, 7]`
- stdout NDJSON 事件流是否符合协议

**里程碑验收：**

- [ ] 非法 candidate 会在训练前被拒绝
- [ ] smoke run 能提前拦住大多数 shape/runtime 错误
- [ ] keep/discard 逻辑继续可用
- [ ] 每次 run 的 workdir 与 artifact 目录可定位、可清理

---

### Phase 4：Node.js 对话流与 LLM 调用

**目标：** 打通“用户需求 -> 候选配置 -> 实验循环 -> 最终交付”主路径。

**新增文件结构：**

```text
src/
  cli.js
  config.js
  session.js
  llm.js
  python-bridge.js
  output.js
  modes/
    socratic.js
    companion.js
py/
  renderer.py        ← 新增，candidate JSON → resolved_candidate.json
```

> `codegen.js` 从 JS 侧移除。candidate 归一化逻辑统一在 Python 侧 `renderer.py` 完成，Node.js 只负责把 candidate JSON 写文件并触发 Python。

#### 4.1 `design` 命令 flags

```bash
neo-cast design                         # 默认苏格拉底模式
neo-cast design --mode companion        # 认知伴随模式
neo-cast design --max-candidates 10     # 最多尝试 N 个候选（默认 10）
neo-cast design --mode companion --max-candidates 5
```

用户随时可以输入 `stop` 中断循环，CLI 输出当前最优结果后退出。

#### 4.2 循环停止条件

第一版采用以下停止逻辑，按优先级依次检查：

| 条件 | 触发 | 说明 |
|---|---|---|
| 用户输入 `stop` | 随时 | 立即停止，输出当前最优 |
| 达到 `max_candidates` 上限 | 每轮 | 默认 10，可通过 flag 覆盖 |
| 连续 3 次 crash | 每轮 | 暂停并报告，等待用户指令 |
| 所有候选均 discard（连续 5 次） | 每轮 | 提示用户调整需求后继续或退出 |

不做自动收敛判断（如"连续改善 < 阈值则停止"），第一版不值得引入这个复杂度。

#### 4.3 LLM 层职责收紧

LLM 不直接写任意 Python 文件。  
第一版职责限定为：

- 澄清需求（socratic 模式）
- 生成结构化 candidate JSON（必须在 `candidate_schema.json` 范围内）
- 给出假设说明（`hypothesis` 字段）
- 解释为什么 keep / discard（companion 模式）

`llm.js` 消费统一的 `resolvedConfig.llm`，不在调用点散读 env：

```javascript
// llm.js 接受已合并好的配置，不直接读 process.env
export async function generateCandidate(requirement, history, resolvedConfig) {
  const { provider, model, base_url, max_tokens, temperature } = resolvedConfig.llm;
  // ...
}
```

#### 4.4 两种交互模式

`socratic`（默认）：

1. 最多 5 轮澄清问题（数据特征、资源约束、建模偏好）
2. 展示需求摘要，用户确认
3. 全自动跑完 `max_candidates` 轮
4. 结束时统一输出结果，不中间打扰

`companion`：

1. 收集需求后立即开始（无确认步骤）
2. 每轮实验前打印：假设、预期改善、选择原因
3. 训练中实时 pipe 关键日志行
4. 每轮实验后打印：结果、keep/discard 决定及理由
5. 用户可随时输入 `stop` / `why` / `next`

#### 4.5 Python bridge 职责

Node.js 侧只负责编排，不包含任何模型或训练逻辑：

1. 把 candidate JSON 写入 `<project>/.neo-cast/current_candidate.json`
2. spawn `uv run py/renderer.py` → 生成 `resolved_candidate.json`
3. spawn `uv run py/validate.py` → smoke run + schema 校验
4. spawn `uv run py/runner.py run` → full training
5. 解析 stdout NDJSON 事件流
6. 读取 `<project>/.neo-cast/artifacts/run_<id>/` 中的结果

**里程碑验收：**

- [ ] `neo-cast design` / `neo-cast design --mode companion` 均能启动对话
- [ ] LLM 输出的是合法 candidate，validator 能拒绝非法候选
- [ ] `renderer.py` 能将 candidate JSON 归一化为稳定的 `resolved_candidate.json`
- [ ] Python 后端能消费 candidate 并返回结构化结果
- [ ] 两种交互模式都可跑通一轮完整流程
- [ ] `stop` 命令能正确中断并输出当前最优结果

---

### Phase 5：结果整合与最终产品化

**目标：** 把中间产物整理成用户可直接消费的输出。

最终每次成功设计输出：

```text
artifacts/run_<id>/
  model.pt
  metadata.json
  model_impl.py
  inference.py
  eval_report.md
```

CLI 展示内容：

- 任务摘要
- 最佳候选说明
- validation 结果
- final `ref_test` 结果
- artifact 路径

**里程碑验收：**

- [ ] 用户能从 CLI 输出直接找到 artifact
- [ ] `eval_report.md` 可读且可复现
- [ ] `inference.py` 可以脱离训练代码运行

---

## 6. `runner.py` 的重新定位

当前 `runner.py` 不能再简单地被视为“完全不动”。  
在 CLI 产品里，它应该收敛成一个明确职责的内部组件：

- 读取当前 candidate
- 执行 validation run
- 记录 keep/discard
- 管理 `results.tsv`
- 管理当前 best run
- 管理项目级 workdir 生命周期

它不再承担这些职责：

- 与用户直接对话
- 直接控制 LLM
- 管理 npm runtime

另外，既然 CLI 可能在任意项目目录下运行，就不能把 `git reset --hard` 当作默认回滚机制。  
第一版更稳的策略应是：

- 每个 run 在独立工作目录下执行
- keep/discard 主要通过 artifact 和结果表管理
- git 只作为开发期辅助工具，不作为最终用户产品的必要前提

---

## 7. 现实推进顺序

真正推荐的顺序不是原来的 `npm -> Python -> LLM -> 输出`，而是：

```text
Phase 0  →  Phase 1  →  Phase 2  →  Phase 3  →  Phase 4  →  Phase 5
contract    runtime     artifact    validator    dialogue     product
```

原因很简单：

- 没有 runtime，CLI 只是空壳
- 没有 artifact ABI，输出无法稳定
- 没有 validator，LLM 自动化会非常脆
- 对话层应该建立在稳定执行内核之上

---

## 8. 首版建议削减项

为了提高第一版成功率，建议主动削减：

- 不做 `npm postinstall` 自动搞定一切，只做 `doctor + init-runtime`
- 不做“从任意 `train.py` 抽取干净模型代码”
- 不做“每轮都展示 test 集结果”
- 不做“任意模型家族自由生成”

首版先支持 2 到 3 个受限模型族就够了，例如：

- `nlinear`
- `tiny_transformer`
- `patch_mlp`

只要这条链路能跑通，后面再扩模型家族会容易很多。

---

## 9. `results.tsv` 新 schema

弃用基于 git commit 的旧 schema，改用 `run_id`（与 artifact 目录名一致）作为主键：

```tsv
session_id	run_id	candidate_id	model_family	val_avg_mse	val_h96_mse	val_h720_mse	params_M	status	is_best	timestamp
20260424-103000-a1b2	20260424-103022-a1b2	1	nlinear	0.452100	0.398200	0.498700	0.07	keep	0	2026-04-24T10:32:18
20260424-103000-a1b2	20260424-103201-c3d4	2	tiny_transformer	0.438700	0.391200	0.481900	0.34	keep	1	2026-04-24T10:38:42
20260424-103000-a1b2	20260424-103805-e5f6	3	tiny_transformer	NA	NA	NA	NA	crash	0	2026-04-24T10:39:01
20260424-103000-a1b2	20260424-103820-g7h8	4	patch_mlp	0.441500	0.394800	0.484200	0.21	discard	0	2026-04-24T10:45:11
```

字段说明：

- `session_id`：本次 `design` 会话主键，用于隔离不同 session 的 best run
- `run_id`：与 `artifacts/run_<id>/` 目录名一致，对外稳定主键
- `candidate_id`：本次 session 内的候选序号（1-based）
- `is_best`：当前是否为最优 run（同一 `session_id` 内只有一行 `is_best=1`）
- `status` ∈ `{keep, discard, crash, invalid, smoke_fail}`，与 Exit Code Contract 对齐
- crash 行的指标列写 `NA`，参与 `is_best` 计算时被自动过滤

`runner.py` 通过 `(session_id, is_best)` 定位当前最优 artifact 路径，不再使用 `last_keep_commit`。

---

## 10. 测试策略

第一版**不追求高覆盖率**，但必须有最小可信验证集，避免改一处崩三处：

### 10.1 Python 单元测试（pytest）

```text
py/tests/
  test_families.py        ← 每个 family 的 build_model + forward shape 测试
  test_renderer.py        ← schema 校验通过/拒绝的边界用例
  test_runner.py          ← keep/discard 状态机
  test_export.py          ← artifact 目录完整性 + metadata schema
```

最小要求：
- 三个 family 的 `forward(x: [2, 512, 7], horizon=96) -> [2, 96, 7]` 必须断言通过
- `validate_candidate` 对非法字段必须返回明确 error code

### 10.2 Node.js 单元测试（node:test）

不引入 Jest/Vitest，直接用 Node 内置 `node:test`：

```text
test/
  cli.test.js             ← commander 解析 + flag 默认值
  config.test.js          ← 用户级/项目级 config 合并优先级
  ipc.test.js             ← NDJSON 事件流解析
```

### 10.3 端到端冒烟测试

第一版只要求 **1 个 E2E**：用 mock LLM（返回固定 candidate）跑通完整 design 循环，断言 artifact 目录完整。

```text
test/e2e/
  smoke.test.js           ← 用 fixture 数据 + mock LLM，5 分钟内跑完
  fixtures/
    mock_llm_responses.json
    mini_etth1.csv        ← 100 行的 ETTh1 子集，用于加速
```

CI 跑这个 E2E 即可保证主路径不退化。

---

## 11. 一句话结论

这条路线是可行的，但必须从“愿景驱动”改成“contract 驱动”。  
`neo-cast` 第一版最重要的不是做出最会聊天的 agent，而是先做出一个：

**可安装、可运行、可导出、可复现、不会被自动代码生成轻易打崩的 TSF 小模型设计 CLI。**
