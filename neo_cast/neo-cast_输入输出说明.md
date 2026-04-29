# neo-cast 输入输出说明

本文说明当前 `neo-cast` CLI 版本的实际输入与输出。当前版本不是三选一地输出“小模型评测指标 / 训练好的网络参数 / 实验报告”，而是三类产物都会生成：

1. 设计出来的小模型规格
2. 小模型评测指标
3. 训练好的模型权重、可推理 artifact 与实验报告

## 输入是什么

当前 `neo-cast` 的输入主要分为三层。

### 1. 数据输入

数据输入是完整的 `ETTh1.csv`：

```bash
node ./bin/neo-cast.js prepare-data --source /path/to/ETTh1.csv
```

CSV 的列顺序固定为：

```text
date,HUFL,HULL,MUFL,MULL,LUFL,LULL,OT
```

`prepare-data` 会把完整数据切成：

- agent 可见的 `train + val`
- runner-only 的 `ref_test`

### 2. 设计需求输入

用户通过自然语言输入建模需求，例如：

```bash
node ./bin/neo-cast.js design \
  --requirement "small ETTh1 forecasting model, low MSE" \
  --mode companion \
  --max-candidates 1
```

这类输入用于引导 LLM 或 mock heuristic 生成候选模型规格。

### 3. 候选模型输入

LLM 或 mock heuristic 会生成候选模型 JSON：

```text
.neo-cast/current_candidate.json
```

它不是任意 Python 模型代码，而是受限结构，主要包含：

- `model_family`
- `model_config`
- `train_config`
- `constraints`
- `hypothesis`

当前支持的 `model_family` 只有：

- `nlinear`
- `tiny_transformer`
- `patch_mlp`

也就是说，当前 `neo-cast` 不是自由生成网络代码，而是在固定模型族里自动选择结构和超参数。

## 交互模式设计

当前 `neo-cast design` 支持两种主要交互模式：

- `socratic`
- `companion`

此外，还支持 mock LLM、真实 LLM、跳过 smoke、多候选强制运行等控制开关。

### 1. Socratic 模式

`socratic` 是当前默认模式：

```bash
node ./bin/neo-cast.js design \
  --requirement "small ETTh1 forecasting model, low MSE" \
  --mode socratic
```

如果在交互式终端中运行，并且没有传入 `--yes`，CLI 会先询问几个澄清问题：

- 模型偏好：例如 `transformer` / `nlinear` / `patch_mlp`
- 参数量预算：单位为 million
- 延迟优先级：`low` / `medium` / `high`
- 额外备注

随后 CLI 会展示整理后的 requirement summary，并询问是否继续。

如果用户确认继续，系统会把原始需求和澄清答案合并为最终 requirement，再交给 LLM 或 mock heuristic 生成候选模型。

如果处于非交互式环境，或者传入 `--yes`，则不会停下来提问，而是直接使用命令行参数和默认值构造 requirement summary。

### 2. Companion 模式

`companion` 是边运行边解释的模式：

```bash
node ./bin/neo-cast.js design \
  --requirement "compact forecasting model for ETTh1" \
  --mode companion \
  --max-candidates 3
```

这个模式不会先做多轮澄清，而是直接开始候选生成和实验运行。

每一轮会输出：

- 当前是第几轮
- 候选模型来自哪里：mock / Anthropic / OpenAI-compatible / heuristic fallback
- candidate id
- model family
- hypothesis
- 学习率、batch size 等关键训练配置
- 训练后的 `val_avg_mse`
- 本轮决策：`keep` / `discard` / `crash`
- 当前最佳 run id 和 artifact 路径

如果在交互式终端中运行，用户可以输入：

```text
stop
```

当前版本的语义是：收到 `stop` 后，CLI 会等当前训练轮次结束，再停止后续候选，并输出当前最优结果。

### 3. Mock LLM 与真实 LLM

开发和测试时可以使用 mock 模式：

```bash
node ./bin/neo-cast.js design \
  --requirement "use nlinear baseline" \
  --mode companion \
  --max-candidates 1 \
  --mock-llm
```

`--mock-llm` 不调用外部 API，而是使用本地 heuristic 生成候选模型。它适合用于本地冒烟、e2e 测试和无 API key 场景。

不加 `--mock-llm` 时，CLI 会根据配置使用真实 LLM：

- 默认 provider: `anthropic`
- 可选 provider: `openai-compatible`

Anthropic 路径依赖：

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

OpenAI-compatible 路径依赖：

```bash
export NEO_CAST_LLM_PROVIDER=openai-compatible
export NEO_CAST_LLM_BASE_URL=https://example.com/v1
export NEO_CAST_LLM_MODEL=your-model
export NEO_CAST_LLM_API_KEY="sk-..."
```

当前代码里，如果真实 LLM 调用失败，候选生成会 fallback 到 heuristic candidate。也就是说，真实 LLM 失败不一定直接导致整个 design 命令失败，但会影响候选质量和可解释性。

### 4. 设计循环如何运行

一次 `design` 的内部流程是：

```text
用户 requirement
  -> socratic / companion 整理需求
  -> 生成 candidate JSON
  -> 写入 .neo-cast/current_candidate.json
  -> renderer 生成 .neo-cast/resolved_candidate.json
  -> validate smoke
  -> full train
  -> export artifact
  -> 更新 .neo-cast/results.tsv
  -> 输出当前最佳结果
```

默认情况下：

- `--max-candidates` 默认为 `1`
- 如果某轮结果是 `keep`，且没有传入 `--force-all-candidates`，design 会提前停止
- 如果某轮结果是 `discard`，CLI 会继续尝试下一个 candidate，直到达到 `--max-candidates`
- 如果出现严重失败，CLI 会停止当前 design 循环

如果想强制跑完所有候选，可以使用：

```bash
node ./bin/neo-cast.js design \
  --requirement "compare compact model variants" \
  --mode companion \
  --max-candidates 5 \
  --force-all-candidates
```

### 5. Smoke 与训练控制

默认每个 candidate 会先经过 smoke gate：

```text
candidate schema validation
  -> renderer
  -> short smoke training
  -> smoke evaluation
```

smoke 通过后才会进入完整训练。

开发调试时可以跳过 smoke：

```bash
node ./bin/neo-cast.js design \
  --requirement "use nlinear baseline" \
  --mode companion \
  --mock-llm \
  --skip-smoke
```

`--skip-smoke` 能加快调试速度，但会降低候选进入 full train 前的安全检查强度。

### 6. 当前交互模式的定位

当前交互模式更接近“受限自动研究循环”，而不是通用聊天式 AutoML：

- 用户给出自然语言目标
- CLI 只在固定 ETTh1 任务上工作
- 模型空间限制在三个已注册 family 内
- LLM 只生成结构化 candidate JSON
- Python 后端负责验证、训练、评估、导出
- `val_avg_mse` 是搜索信号
- `ref_test` 只在最终最佳 artifact 上做报告用途

因此，当前版本的交互重点不是让用户手写模型，而是让用户用自然语言描述偏好，然后系统在固定协议内自动提出、训练并筛选小模型。

## 输出是什么

主要输出都在 `.neo-cast/` 目录下。

### 1. 小模型设计结果

候选模型与解析后的候选模型分别保存为：

```text
.neo-cast/current_candidate.json
.neo-cast/resolved_candidate.json
```

`current_candidate.json` 是原始候选规格，`resolved_candidate.json` 是经过 renderer 归一化后的训练配置。

### 2. 实验指标

整体实验结果保存在：

```text
.neo-cast/results.tsv
```

主要字段包括：

- `val_avg_mse`
- `val_h96_mse`
- `val_h720_mse`
- `params_M`
- `status`: `keep` / `discard` / `crash`
- `is_best`

其中 `val_avg_mse` 是当前搜索主指标，`ref_test` 只用于最终报告。

### 3. 训练好的模型参数

每次成功训练会生成：

```text
.neo-cast/artifacts/run_<run_id>/model.pt
```

`model.pt` 保存的是训练好的 PyTorch 权重，包含：

- `run_id`
- candidate 配置
- `model_family`
- 每个 horizon 对应的 `state_dict`

### 4. 完整 artifact 包

每个成功 run 会导出一个完整 artifact 目录：

```text
.neo-cast/artifacts/run_<run_id>/
  model.pt
  metadata.json
  val_metrics.json
  ref_test_metrics.json
  training_summary.json
  preprocess.json
  model_impl.py
  inference.py
  mcp_server.py
  tool_schema.json
  eval_report.md
  README.md
  example.py
  requirements.txt
```

这个目录是当前版本对外交付的主要产物。

### 5. 实验报告

实验报告主要有两种形式：

- `eval_report.md`: 面向人读的 Markdown 报告
- `metadata.json`: 面向机器读的结构化报告

报告内容包括：

- 模型族
- candidate id
- run id
- 参数量
- 训练耗时
- validation 指标
- ref-test 指标
- artifact 文件清单

## 推理时的输入输出

导出的 artifact 里，`inference.py` 提供推理接口。

推理输入：

- `history`: shape 为 `[512, 7]`
- `horizon`: `96 / 192 / 336 / 720`

推理输出：

- shape 为 `[horizon, 7]` 的预测数组

当前 `predict_raw()` 会接收 raw-space 输入并做标准化，但输出仍是 `standard_scaled` 空间，没有 inverse transform 回原始数值空间。这个命名容易造成误解，后续产品化时建议补充 `predict_raw_inverse()` 或让 `predict_raw()` 返回原始数值空间。

## 一句话总结

当前 `neo-cast` 的输入是：

```text
ETTh1.csv + 自然语言建模需求 + 受限候选模型 JSON
```

当前 `neo-cast` 的输出是：

```text
小模型设计规格 + 评测指标 + 训练好的模型权重 + 可推理 artifact + 实验报告
```
