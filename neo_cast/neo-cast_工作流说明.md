# neo-cast 工作流说明

本文描述当前 `neo-cast` CLI 的实际工作流：从数据准备、候选模型生成、验证、训练、评估、筛选，到最终导出 artifact 和 ref-test 报告。

当前版本可以理解为：

```text
准备一个标准化时序预测任务
  -> 根据自然语言需求生成小模型 candidate
  -> 验证 candidate 是否可运行
  -> 训练并评估
  -> 根据 val_avg_mse keep/discard
  -> 导出可推理 artifact
  -> 对最佳 artifact 做 runner-only ref-test
```

## 总览

`neo-cast` 的主工作流围绕 `.neo-cast/` 工作目录展开：

```text
source CSV
  -> prepare-data
  -> .neo-cast/dataset_spec.json
  -> .neo-cast/dataset/<task_id>_visible.csv
  -> .neo-cast/dataset/<task_id>_ref_test.csv

natural-language requirement
  -> design mode
  -> LLM / mock heuristic
  -> .neo-cast/current_candidate.json
  -> renderer
  -> .neo-cast/resolved_candidate.json

resolved candidate
  -> smoke validation
  -> full training
  -> validation metrics
  -> runner keep/discard
  -> .neo-cast/results.tsv
  -> .neo-cast/artifacts/run_<run_id>/

best artifact
  -> runner ref-test
  -> ref_test_metrics.json
  -> updated metadata.json / eval_report.md
```

## 0. 环境初始化

进入 `neo_cast/` 目录后，先安装 Node 依赖：

```bash
npm install
```

初始化项目级 Python runtime：

```bash
node ./bin/neo-cast.js init-runtime
```

该命令会在项目内创建：

```text
.neo-cast/runtime/.venv/
.neo-cast/runtime/.uv-cache/
```

之后所有 Python 后端脚本默认使用：

```text
.neo-cast/runtime/.venv/bin/python
```

可以用下面命令检查环境：

```bash
node ./bin/neo-cast.js doctor
```

`doctor` 会检查：

- Python runtime
- `uv`
- LLM API key
- config 是否合法
- `.neo-cast/runtime/.venv` 是否存在

如果只是本地 mock 演示，没有真实 API key 也可以继续使用 `--mock-llm`。

## 1. 数据准备阶段

当前 `neo-cast` 使用 `dataset.v1` 数据契约。默认任务仍然是 ETTh1，但现在 `prepare-data` 已经支持用参数描述一般 numeric multivariate CSV。

默认 ETTh1 示例：

```bash
node ./bin/neo-cast.js prepare-data \
  --source "datasets (1)/ETTh1.csv" \
  --force
```

自定义 numeric CSV 示例：

```bash
node ./bin/neo-cast.js prepare-data \
  --source /path/to/data.csv \
  --task-id custom_task \
  --timestamp-col date \
  --feature-cols value_a,value_b,value_c \
  --input-len 96 \
  --horizons 24,48 \
  --train-rows 0:1000 \
  --val-rows 1000:1200 \
  --ref-test-rows 1200:1400 \
  --force
```

数据准备会生成：

```text
.neo-cast/dataset_spec.json
.neo-cast/dataset/dataset_spec.json
.neo-cast/dataset/<task_id>_visible.csv
.neo-cast/dataset/<task_id>_ref_test.csv
.neo-cast/dataset/<task_id>_profile.json
```

其中：

- `visible.csv` 包含 train + val，可被训练和验证流程读取
- `ref_test.csv` 是 runner-only final evaluation 用的数据
- `dataset_spec.json` 记录 task id、特征列、input length、horizons、split 边界、标准化协议
- `profile.json` 记录数据行数、特征列、时间戳频率、irregular ratio 等基础 profile

当前 loader 的核心限制：

- 特征列必须是数值列
- 时间戳必须可解析、单调递增、无重复
- split 必须连续：`train -> val -> ref_test`
- 当前训练使用 row-based window
- 当前数据清洗能力仍有限，不应把任意脏 CSV 直接视为可用输入

## 2. 设计入口：`neo-cast design`

用户通过自然语言提出建模需求：

```bash
node ./bin/neo-cast.js design \
  --requirement "small forecasting model, low MSE, compact parameters" \
  --mode companion \
  --max-candidates 3 \
  --mock-llm
```

`design` 是主编排命令，它负责：

1. 读取用户 requirement
2. 读取 `.neo-cast/dataset_spec.json` 作为 task context
3. 根据交互模式整理需求
4. 调用 LLM 或 mock heuristic 生成 candidate
5. 把 candidate 写入 `.neo-cast/current_candidate.json`
6. 调用 Python runner 执行验证、训练和导出
7. 根据结果决定是否继续下一轮候选

## 3. 交互模式

当前 `design` 支持两种模式：

```text
socratic
companion
```

### Socratic 模式

`socratic` 是默认模式：

```bash
node ./bin/neo-cast.js design \
  --requirement "small model for long horizon forecasting" \
  --mode socratic
```

在交互式终端中，系统会先问几个澄清问题：

- 模型偏好
- 参数量预算
- 延迟优先级
- 额外备注

然后生成 requirement summary，并让用户确认是否继续。

如果使用 `--yes` 或处于非交互式环境，则不会停下来提问，而是直接用命令行参数和默认值构造 summary。

### Companion 模式

`companion` 是边运行边解释的模式：

```bash
node ./bin/neo-cast.js design \
  --requirement "compact transformer-like model" \
  --mode companion \
  --max-candidates 3
```

它会直接开始候选生成和训练，并在每轮输出：

- candidate id
- model family
- hypothesis
- candidate 来源：mock / Anthropic / OpenAI-compatible / heuristic fallback
- 关键训练参数
- 本轮 `val_avg_mse`
- keep/discard/crash 结果
- 当前最佳 artifact 路径

交互式终端中可以输入：

```text
stop
```

当前语义是：收到 `stop` 后，等当前训练轮次结束，再停止后续候选。

## 4. 候选模型生成

候选生成由 `src/llm.js` 负责。

当前有三类来源：

- `--mock-llm`：使用本地 heuristic，不调用外部 API
- Anthropic：默认真实 LLM provider
- OpenAI-compatible：支持 GLM / relay / vLLM 等兼容 ChatCompletions 接口

候选模型不是任意 Python 代码，而是结构化 JSON：

```text
.neo-cast/current_candidate.json
```

核心字段包括：

```json
{
  "schema_version": "candidate.v1",
  "candidate_id": "cand_xxx",
  "hypothesis": "...",
  "model_family": "nlinear",
  "model_config": {},
  "train_config": {
    "lr": 0.001,
    "batch_size": 32,
    "max_epochs": 8,
    "patience": 4,
    "seed": 42
  },
  "constraints": {
    "params_max_million": 1.0,
    "time_budget_seconds": 600,
    "latency_priority": "medium"
  }
}
```

当前支持的模型族：

- `nlinear`
- `tiny_transformer`
- `patch_mlp`

这一步的边界很明确：LLM 只负责提出候选结构和超参，不直接写训练代码，也不能创建任意模型文件。

## 5. Candidate 解析与验证

Runner 会先把 candidate 交给 `renderer.py`：

```text
.neo-cast/current_candidate.json
  -> py/renderer.py
  -> .neo-cast/resolved_candidate.json
```

`resolved_candidate.json` 会把候选补全为稳定运行配置，包括：

- candidate id
- model family
- model config
- train config
- constraints
- smoke config
- 当前 dataset task 信息：`task_id`、`input_len`、`horizons`、`num_channels`

如果没有 `--skip-smoke`，runner 会继续执行 smoke gate：

```text
candidate schema validation
  -> renderer
  -> short smoke training
  -> smoke evaluation
```

smoke 的目标不是得到好指标，而是尽早发现：

- JSON schema 不合法
- 模型配置不合法
- tensor shape 错误
- 训练入口崩溃
- 参数量明显超预算

开发调试时可以跳过 smoke：

```bash
node ./bin/neo-cast.js design \
  --requirement "use nlinear baseline" \
  --mode companion \
  --mock-llm \
  --skip-smoke
```

## 6. 训练与验证

完整训练由 `py/train.py` 执行。

训练过程按 horizon 分别构建模型和 dataloader：

```text
horizon 96
horizon 192
horizon 336
horizon 720
```

如果是自定义任务，则 horizon 来自 `dataset_spec.json`。

训练数据处理逻辑：

- 从 `<task_id>_visible.csv` 读取 train + val
- 用 train split 拟合 StandardScaler
- train / val 都在 standard-scaled 空间训练和评估
- 使用 sliding window 形成 `x: [input_len, num_channels]`
- 目标为 `y: [horizon, num_channels]`

训练过程会输出 NDJSON 事件，例如：

```text
stage_start
epoch_end
horizon_done
eval_done
artifact_ready
done
```

训练结束后会生成一个 run 目录：

```text
.neo-cast/artifacts/run_<run_id>/
```

训练阶段先写入：

```text
model.pt
val_metrics.json
training_summary.json
resolved_candidate.json
preprocess.json
```

其中 `model.pt` 保存 PyTorch 权重和 candidate payload。

## 7. Runner 决策：keep / discard / crash

`py/runner.py` 是实验状态机。

它维护：

```text
.neo-cast/runner_state.json
.neo-cast/results.tsv
```

每个 candidate 训练完成后，runner 读取 `val_avg_mse`，并和当前 best 比较：

```text
如果 val_avg_mse 更低 -> keep
否则 -> discard
如果验证、训练或导出失败 -> crash / invalid / smoke_fail
```

`results.tsv` 记录：

- `session_id`
- `run_id`
- `candidate_id`
- `model_family`
- `val_avg_mse`
- `val_h96_mse`
- `val_h720_mse`
- `params_M`
- `status`
- `is_best`
- `timestamp`

当前主搜索指标是：

```text
val_avg_mse
```

`ref_test` 不参与搜索，只用于最终报告。

默认情况下，如果某一轮产生了新的 best 且没有传入 `--force-all-candidates`，`design` 会提前停止。想强制跑满候选数，可以使用：

```bash
node ./bin/neo-cast.js design \
  --requirement "compare compact model variants" \
  --mode companion \
  --max-candidates 5 \
  --force-all-candidates
```

## 8. Artifact 导出

训练成功后，runner 会调用 `py/export.py` 把 run 目录补全为可交付 artifact。

完整 artifact 目录结构如下：

```text
.neo-cast/artifacts/run_<run_id>/
  model.pt
  metadata.json
  val_metrics.json
  training_summary.json
  preprocess.json
  resolved_candidate.json
  model_impl.py
  inference.py
  mcp_server.py
  tool_schema.json
  eval_report.md
  README.md
  example.py
  requirements.txt
```

各文件含义：

- `model.pt`：训练好的模型权重和 candidate payload
- `metadata.json`：结构化元数据，包括 task、模型族、指标、文件清单
- `val_metrics.json`：验证集指标
- `training_summary.json`：训练耗时、参数量、显存等
- `preprocess.json`：特征顺序、标准化均值方差、input length、horizons
- `model_impl.py`：该模型族的模型定义
- `inference.py`：加载模型和推理的 Python API
- `mcp_server.py`：把模型暴露为 MCP tool
- `tool_schema.json`：MCP tool 的输入 schema
- `eval_report.md`：面向人读的实验报告
- `example.py`：最小推理样例
- `requirements.txt`：artifact 运行依赖

这就是 `neo-cast` 的主要输出 artifact。

## 9. 最终 ref-test

当已经有 best run 后，可以运行：

```bash
node ./bin/neo-cast.js runner ref-test
```

或指定 run：

```bash
node ./bin/neo-cast.js runner ref-test --run-id <run_id>
```

当前 ref-test 路径主要按默认 ETTh1 工作流验证过。虽然数据准备和训练已经支持 `dataset.v1` 自定义 task，但 runner 的 ref-test 调用仍带有 ETTh1 默认假设；自定义 task 的 ref-test 应视为需要进一步验证和修正的路径。

ref-test 的逻辑是：

```text
读取 best artifact
  -> 临时设置 runner-only promotion token
  -> 加载 ref_test split
  -> 评估所有 horizons
  -> 写入 ref_test_metrics.json
  -> 重新导出 metadata.json / eval_report.md
```

输出文件：

```text
.neo-cast/artifacts/run_<run_id>/ref_test_metrics.json
.neo-cast/artifacts/run_<run_id>/metadata.json
.neo-cast/artifacts/run_<run_id>/eval_report.md
```

设计原则是：

- `val` 用于搜索
- `ref_test` 只用于最终报告
- `ref_test` 不参与 keep/discard

这避免在自动搜索过程中反复用 test 集调参。

## 10. 推理与部署

导出的 artifact 可以直接运行：

```bash
cd .neo-cast/artifacts/run_<run_id>/
python example.py
```

也可以作为 MCP tool 启动：

```bash
python mcp_server.py
```

推理入口在 `inference.py`：

```python
from inference import load_model, predict_raw

bundle = load_model()
prediction = predict_raw(bundle, history, horizon)
```

输入：

```text
history: [input_len, num_channels]
horizon: dataset_spec.json 中声明的某个 horizon
```

输出：

```text
[horizon, num_channels]
```

注意：当前 `predict_raw()` 会把 raw input 标准化后送入模型，但输出仍是模型的 standard-scaled 空间预测值。后续如果要面向真实业务使用，应补充 inverse transform 或明确输出空间。

## 11. 当前工作流的关键边界

当前 `neo-cast` 已经不是纯 ETTh1-only 的硬编码流程，但仍然是受限 MVP：

- 只支持 numeric multivariate forecasting CSV
- 模型空间限制在三个已注册 family
- LLM 只能生成 candidate JSON，不能写任意模型代码
- 训练协议仍然是监督式 sliding-window forecasting
- 主要搜索指标仍然是 `val_avg_mse`
- `results.tsv` 仍保留 `val_h96_mse` / `val_h720_mse` 这类 legacy 列；自定义 horizons 的完整指标应看 artifact 内的 `val_metrics.json`
- 默认 ETTh1 的 ref-test 路径可用；自定义 task 的 ref-test 仍需进一步产品化
- 多数据集统计检验、multi-seed 搜索、效率指标搜索还没有成为主流程
- MCP server 已生成，但真实 MCP client 集成仍需单独验证

因此，当前工作流最适合：

- 本地演示小模型自动设计闭环
- 验证 candidate schema / artifact contract
- 对固定或标准化 CSV 任务做受限模型搜索
- 为后续 TimeRecipe 式模块级 action space 打基础

不适合直接声称：

- 找到了 LTSF 通用 champion
- 已经支持任意 AutoML
- 已经能处理任意脏数据和任意任务类型

## 12. 最短可运行路径

本地 mock 演示的最短路径：

```bash
cd /Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf/neo_cast

npm install

node ./bin/neo-cast.js init-runtime

node ./bin/neo-cast.js prepare-data \
  --source "datasets (1)/ETTh1.csv" \
  --force

node ./bin/neo-cast.js design \
  --requirement "small ETTh1 forecasting model, low MSE, compact parameters" \
  --mode companion \
  --max-candidates 1 \
  --mock-llm \
  --skip-smoke

node ./bin/neo-cast.js runner ref-test
```

完成后查看：

```bash
node ./bin/neo-cast.js runner status
cat .neo-cast/results.tsv
ls .neo-cast/artifacts/
```

最佳 run 的最终产物在：

```text
.neo-cast/artifacts/run_<best_run_id>/
```
