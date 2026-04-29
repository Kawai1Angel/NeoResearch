# NeoResearch 本地源码安装测试教程

本文档用于从零在本机用源码方式安装、启动、测试 NeoResearch，并用本地 ETTh1 CSV 数据集创建一个 TSF 研究任务。

适用项目路径：

```bash
/Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf/neo-research
```

NeoResearch 当前由两个源码目录组成：

```text
neo-research/
  opencode/   # NeoResearch 主体：CLI/TUI/Web/Server/Research OS
  neo_cast/   # TSF domain runner：数据准备、候选 recipe、训练、评估、artifact
  scripts/    # 本地 bootstrap、doctor、dev、test、smoke 脚本
```

## 1. 先理解本地源码安装方式

当前 NeoResearch 还不是最终 npm 发布版，推荐使用“源码开发安装”方式：

```bash
cd /Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf/neo-research
make setup
make doctor
make test
```

这三个命令分别做：

```text
make setup   初始化本地开发环境，写 .env.local，安装 opencode workspace 依赖
make doctor  检查 node/npm/bun/python3、目录、Python 依赖、Neo-Cast smoke dry-run
make test    跑 NeoResearch quick verification suite
```

如果只想检查会做什么，不想写文件或安装依赖：

```bash
./scripts/bootstrap_local_dev.sh --dry-run
```

## 2. 前置环境

本机需要能找到这些命令：

```bash
node --version
npm --version
python3 --version
bun --version
```

如果 `bun` 找不到，但存在：

```bash
~/.bun/bin/bun
```

项目脚本也能自动识别。

Python 侧至少需要能 import：

```bash
python3 - <<'PY'
import numpy
import torch
print("python deps ok")
PY
```

如果这里失败，`make doctor` 会提示 `Python cannot import numpy and torch`。这时需要先补 Python ML 依赖，再跑真实训练；但不影响你先看 CLI/Web 基础能力。

## 3. 进入项目根目录

后续命令默认都在这个目录执行：

```bash
cd /Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf/neo-research
```

确认当前目录正确：

```bash
pwd
ls
```

应该能看到：

```text
opencode
neo_cast
scripts
Makefile
文档
```

## 4. Bootstrap 本地开发环境

先做 dry-run：

```bash
./scripts/bootstrap_local_dev.sh --dry-run
```

如果没有明显 `FAIL`，执行正式初始化：

```bash
make setup
```

这一步会做几件事：

```text
1. 检查 node/npm/python3/bun
2. 检查 opencode/ 和 neo_cast/ 目录
3. 写入 neo-research/.env.local
4. 创建 .neo-research/runtime 本地运行目录
5. 创建 XDG data/config/cache/state 本地隔离目录
6. 创建 neo_cast/.neo-cast/artifacts
7. 在 opencode/ 下执行 bun install
```

生成的 `.env.local` 类似：

```bash
NEO_CAST_ROOT=/Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf/neo-research/neo_cast
NEO_RESEARCH_RUNTIME_ROOT=/Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf/neo-research/.neo-research/runtime
XDG_DATA_HOME=/Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf/neo-research/.neo-research/runtime/xdg/data
XDG_CONFIG_HOME=/Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf/neo-research/.neo-research/runtime/xdg/config
XDG_CACHE_HOME=/Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf/neo-research/.neo-research/runtime/xdg/cache
XDG_STATE_HOME=/Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf/neo-research/.neo-research/runtime/xdg/state
```

这些路径的作用是把 NeoResearch 本地数据隔离在当前源码目录下，避免污染系统级配置。

## 5. 运行 Doctor 检查

执行：

```bash
make doctor
```

成功时最后会看到类似：

```text
OK: NeoResearch local development environment looks ready
```

如果只想快速检查，跳过较慢 smoke dry-run：

```bash
./scripts/doctor.sh --quick
```

常见失败解释：

```text
bun runtime not found
  安装 Bun，或确认 ~/.bun/bin/bun 存在。

opencode/node_modules missing
  运行 make setup，或者 cd opencode && bun install。

Python cannot import numpy and torch
  Python ML 依赖缺失。基础 CLI 可看，但 Neo-Cast 真训练会失败。

Neo-Cast smoke dry-run failed
  通常是 Python 依赖、路径、candidate schema 或 Neo-Cast 环境问题。
```

## 6. 跑项目级测试

执行 quick verification：

```bash
make test
```

等价于：

```bash
./scripts/test_all.sh --quick
```

它会跑：

```text
1. OpenCode Research OS targeted tests
2. opencode package typecheck
3. Web Dashboard helper tests
4. app package typecheck
5. Neo-Cast Python unit tests
6. Neo-Cast smoke dry-run
```

成功时最后会看到：

```text
OK: quick local alpha verification completed
```

## 7. 单独测试 Neo-Cast

如果只想确认 TSF runner 的 smoke dry-run：

```bash
make smoke
```

等价于：

```bash
./scripts/smoke_tsf.sh
```

这默认只 dry-run，不真正训练。

如果要真的跑 smoke stage：

```bash
./scripts/smoke_tsf.sh --run
```

真实 smoke 会调用：

```text
neo_cast/scripts/neo_research_tsf_e2e.sh
neo_cast/py/validate.py
neo_cast/py/runner.py
```

## 8. 使用源码 CLI

查看 Research CLI：

```bash
./scripts/dev_cli.sh research --help
```

常用命令：

```bash
./scripts/dev_cli.sh research list
./scripts/dev_cli.sh research create --help
./scripts/dev_cli.sh research status <taskID>
./scripts/dev_cli.sh research profile <taskID>
./scripts/dev_cli.sh research seed <taskID>
./scripts/dev_cli.sh research run <taskID> <candidateID> --stage smoke
./scripts/dev_cli.sh research artifacts <taskID>
./scripts/dev_cli.sh research memory <taskID>
./scripts/dev_cli.sh research export <taskID>
```

这里的 `dev_cli.sh` 会自动：

```text
1. 读取 .env.local
2. 设置 NEO_CAST_ROOT
3. 设置 NEO_RESEARCH_RUNTIME_ROOT
4. 设置 XDG 本地隔离目录
5. 从 opencode/packages/opencode/src/index.ts 直接启动源码 CLI
```

所以不需要先 npm link，也不需要全局安装。

## 9. 用本地 ETTh1.csv 创建任务

本地数据集路径：

```bash
DATASET=/Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf/datasets/ETTh1.csv
```

确认文件存在：

```bash
ls "$DATASET"
```

创建 review 模式任务：

```bash
./scripts/dev_cli.sh research create \
  --mode review \
  --title "ETTh1 local source test" \
  --dataset-path "$DATASET" \
  --dataset-preset etth1_tslib_v1 \
  --target-cols OT \
  --context-length 96 \
  --prediction-lengths 24 \
  --format table
```

创建 autonomous 模式任务：

```bash
./scripts/dev_cli.sh research create \
  --mode autonomous \
  --title "ETTh1 autonomous local test" \
  --dataset-path "$DATASET" \
  --dataset-preset etth1_tslib_v1 \
  --target-cols OT \
  --context-length 96 \
  --prediction-lengths 24 \
  --format table
```

如果希望允许 TimeRecipe 风格的完整 phase-two/full recipe search space：

```bash
./scripts/dev_cli.sh research create \
  --mode autonomous \
  --title "ETTh1 full recipe search local test" \
  --dataset-path "$DATASET" \
  --dataset-preset etth1_tslib_v1 \
  --target-cols OT \
  --context-length 96 \
  --prediction-lengths 24 \
  --full-recipe-space \
  --format table
```

创建后输出里会出现 `taskID`，后面记为：

```bash
TASK_ID=<你的 taskID>
```

## 10. 查看任务和状态

列出任务：

```bash
./scripts/dev_cli.sh research list
```

查看某个任务完整状态：

```bash
./scripts/dev_cli.sh research status "$TASK_ID"
```

如果想要 JSON 输出，方便后续脚本处理：

```bash
./scripts/dev_cli.sh research status "$TASK_ID" --format json
```

## 11. 跑 Dataset Profile / Diagnose

对任务做数据画像：

```bash
./scripts/dev_cli.sh research profile "$TASK_ID"
```

查看 artifacts：

```bash
./scripts/dev_cli.sh research artifacts "$TASK_ID"
```

Profile 会读取 task spec 里的 dataset path，并生成 diagnostic/profile artifact。对于 ETTh1，它会基于 CSV 得到行数、字段、缺失、目标列等诊断信息。

## 12. 生成 baseline candidates

给任务种 baseline：

```bash
./scripts/dev_cli.sh research seed "$TASK_ID"
```

再看状态：

```bash
./scripts/dev_cli.sh research status "$TASK_ID"
```

输出里会出现 candidate 列表。选择一个 candidate ID，记为：

```bash
CANDIDATE_ID=<你的 candidateID>
```

## 13. Prepare 一个 candidate run

Prepare 只生成 runner plan，不直接执行训练：

```bash
./scripts/dev_cli.sh research prepare "$TASK_ID" "$CANDIDATE_ID" \
  --stage smoke \
  --description "local prepare smoke"
```

Prepare 成功后会把 runner command plan 持久化，并进入本地 file runtime queue。

默认 runtime root 是：

```bash
.neo-research/runtime
```

## 14. 执行 queued worker job

跑一个 queued job：

```bash
./scripts/dev_cli.sh research worker-once
```

如果想一次性跑多个，直到队列空或达到上限：

```bash
./scripts/dev_cli.sh research worker-loop --max-jobs 5
```

执行后查看状态：

```bash
./scripts/dev_cli.sh research status "$TASK_ID"
./scripts/dev_cli.sh research artifacts "$TASK_ID"
```

## 15. 直接 Run 一个 candidate

如果不想分 prepare/worker 两步，也可以直接执行：

```bash
./scripts/dev_cli.sh research run "$TASK_ID" "$CANDIDATE_ID" \
  --stage smoke \
  --description "local direct smoke"
```

可选 stage：

```text
baseline
smoke
low_fidelity
full
ref_test
blind_test
```

日常本地调试建议先用：

```text
smoke
```

不要一开始就跑 `full`，训练时间和资源消耗会更大。

## 16. 跑 seed sweep

对同一个 candidate 用多个 seed 运行：

```bash
./scripts/dev_cli.sh research seed-sweep "$TASK_ID" "$CANDIDATE_ID" \
  --stage smoke \
  --seeds 1,2,3 \
  --description "local smoke seed sweep"
```

查看结果：

```bash
./scripts/dev_cli.sh research status "$TASK_ID"
./scripts/dev_cli.sh research artifacts "$TASK_ID"
```

## 17. Autonomous 模式

如果任务是 autonomous 模式，可以运行一轮自主研究：

```bash
./scripts/dev_cli.sh research iterate "$TASK_ID" \
  --stage smoke \
  --description "local autonomous iteration"
```

运行多轮：

```bash
./scripts/dev_cli.sh research loop "$TASK_ID" \
  --stage smoke \
  --max-iterations 3 \
  --description "local autonomous loop"
```

Autonomous loop 会尝试：

```text
1. 根据任务和历史结果提出候选
2. 准备/执行 runner plan
3. 记录 metrics/artifacts
4. 更新 memory
5. 生成下一轮候选
```

如果遇到预算或 governance gate，它会停止并生成相应 approval 或 summary artifact。

## 18. Approval / Governance 操作

查看审批：

```bash
./scripts/dev_cli.sh research approvals "$TASK_ID"
./scripts/dev_cli.sh research approvals "$TASK_ID" --status pending
```

批准一个 approval：

```bash
./scripts/dev_cli.sh research approve <approvalID> \
  --message "local test approved"
```

拒绝一个 approval：

```bash
./scripts/dev_cli.sh research reject <approvalID> \
  --message "local test rejected"
```

请求 reference test：

```bash
./scripts/dev_cli.sh research request-ref-test "$TASK_ID" "$CANDIDATE_ID" \
  --reason "candidate passed smoke locally"
```

请求 blind test：

```bash
./scripts/dev_cli.sh research request-blind-test "$TASK_ID" "$CANDIDATE_ID" \
  --reason "final candidate validation"
```

## 19. 导出研究 artifact

导出任务报告：

```bash
./scripts/dev_cli.sh research export "$TASK_ID"
```

指定输出目录：

```bash
./scripts/dev_cli.sh research export "$TASK_ID" \
  --output-dir ./exports
```

查看 memory：

```bash
./scripts/dev_cli.sh research memory "$TASK_ID"
```

查看 artifacts：

```bash
./scripts/dev_cli.sh research artifacts "$TASK_ID"
```

## 20. 启动 Web Dashboard

启动 Web：

```bash
make dev-web
```

等价于：

```bash
./scripts/dev_web.sh
```

该脚本会进入：

```bash
opencode/packages/app
```

然后执行：

```bash
bun run dev
```

终端会输出本地访问地址，通常类似：

```text
http://localhost:5173
```

打开浏览器后，Web 默认是 Research Dashboard。它和 CLI/TUI 共用同一套 Research service、task、candidate、run、artifact、memory 数据。

## 21. 使用 TUI / Cockpit

当前源码 CLI 中 Research Cockpit 属于 opencode TUI 侧能力。先看入口帮助：

```bash
./scripts/dev_cli.sh --help
```

如果 TUI command 可用，可以从源码 CLI 进入 Cockpit；如果只是调试 Research 功能，优先使用：

```bash
./scripts/dev_cli.sh research list
./scripts/dev_cli.sh research status "$TASK_ID"
./scripts/dev_web.sh
```

Web Dashboard 和 TUI Cockpit 的目标是对齐：创建研究任务、查看 candidates、Prepare/Execute、查看 champion、导出 artifacts。

## 22. 推荐的最小完整测试流程

下面是一条从安装到跑通 ETTh1 smoke 的最小路径：

```bash
cd /Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf/neo-research

make setup
make doctor
make test

DATASET=/Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf/datasets/ETTh1.csv

./scripts/dev_cli.sh research create \
  --mode review \
  --title "ETTh1 local source test" \
  --dataset-path "$DATASET" \
  --dataset-preset etth1_tslib_v1 \
  --target-cols OT \
  --context-length 96 \
  --prediction-lengths 24 \
  --format table

./scripts/dev_cli.sh research list
```

从 `research list` 输出里复制 `taskID`：

```bash
TASK_ID=<复制出来的 taskID>
```

继续：

```bash
./scripts/dev_cli.sh research profile "$TASK_ID"
./scripts/dev_cli.sh research seed "$TASK_ID"
./scripts/dev_cli.sh research status "$TASK_ID"
```

从 `status` 输出里复制一个 `candidateID`：

```bash
CANDIDATE_ID=<复制出来的 candidateID>
```

执行 smoke：

```bash
./scripts/dev_cli.sh research run "$TASK_ID" "$CANDIDATE_ID" \
  --stage smoke \
  --description "local ETTh1 smoke"
```

检查结果：

```bash
./scripts/dev_cli.sh research status "$TASK_ID"
./scripts/dev_cli.sh research artifacts "$TASK_ID"
./scripts/dev_cli.sh research memory "$TASK_ID"
```

## 23. 目录里会产生哪些本地文件

运行后常见本地状态：

```text
neo-research/.env.local
neo-research/.neo-research/runtime/
neo-research/opencode/node_modules/
neo-research/neo_cast/.neo-cast/
```

其中：

```text
.env.local
  本地环境变量。

.neo-research/runtime
  NeoResearch file runtime、队列、XDG data/config/cache/state。

opencode/node_modules
  Bun/npm workspace 依赖。

neo_cast/.neo-cast
  Neo-Cast candidate、runner state、artifacts、results。
```

这些都是本地开发状态，不是核心源码。

## 24. 常见问题排查

### 24.1 `bun runtime not found`

检查：

```bash
which bun
ls ~/.bun/bin/bun
```

如果都没有，需要安装 Bun。安装后重新执行：

```bash
make setup
```

### 24.2 `opencode/node_modules missing`

执行：

```bash
make setup
```

或手动：

```bash
cd opencode
bun install
```

### 24.3 `Python cannot import numpy and torch`

检查：

```bash
python3 - <<'PY'
import numpy
import torch
print(numpy.__version__)
print(torch.__version__)
PY
```

如果失败，需要给当前 `python3` 安装 Neo-Cast 训练依赖。依赖没补齐时，Research CLI 可以创建任务和看状态，但真实训练会失败。

### 24.4 `Runtime not initialized. Run: neo-cast init-runtime`

这是 Neo-Cast CLI 直接运行时可能出现的提示。NeoResearch 正常走 `NEO_CAST_ROOT` 和 runner plan；如果你单独调 `neo_cast/bin/neo-cast.js design`，需要先在 `neo_cast` 下初始化 runtime。

本地源码联调优先用：

```bash
./scripts/dev_cli.sh research ...
```

而不是直接调 `neo_cast/bin/neo-cast.js design`。

### 24.5 `dataset path` 找不到

确认：

```bash
ls /Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf/datasets/ETTh1.csv
```

创建任务时路径要传绝对路径：

```bash
--dataset-path /Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf/datasets/ETTh1.csv
```

### 24.6 训练时间太长

先只跑：

```bash
--stage smoke
```

不要直接跑：

```bash
--stage full
```

如果只是检查命令和 artifact 流程，可以先跑：

```bash
make smoke
```

它默认是 dry-run。

### 24.7 Approval gate 阻塞

查看 pending approvals：

```bash
./scripts/dev_cli.sh research approvals "$TASK_ID" --status pending
```

批准：

```bash
./scripts/dev_cli.sh research approve <approvalID> --message "approved for local test"
```

再重新执行 run 或 worker。

## 25. 推荐日常开发命令速查

```bash
# 进入项目
cd /Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf/neo-research

# 安装/准备
make setup

# 环境检查
make doctor
./scripts/doctor.sh --quick

# 项目测试
make test

# Neo-Cast smoke dry-run
make smoke

# Neo-Cast smoke 真实执行
./scripts/smoke_tsf.sh --run

# CLI
./scripts/dev_cli.sh research --help
./scripts/dev_cli.sh research list

# Web Dashboard
make dev-web

# 创建 ETTh1 任务
DATASET=/Users/chengmingyue/human_agent_collaboration/research_working/idea/neo_research_for_tsf/datasets/ETTh1.csv
./scripts/dev_cli.sh research create --mode review --dataset-path "$DATASET" --target-cols OT --context-length 96 --prediction-lengths 24

# 查看任务
./scripts/dev_cli.sh research status "$TASK_ID"

# Profile
./scripts/dev_cli.sh research profile "$TASK_ID"

# Seed baselines
./scripts/dev_cli.sh research seed "$TASK_ID"

# Run candidate
./scripts/dev_cli.sh research run "$TASK_ID" "$CANDIDATE_ID" --stage smoke

# 查看 artifacts/memory
./scripts/dev_cli.sh research artifacts "$TASK_ID"
./scripts/dev_cli.sh research memory "$TASK_ID"

# 导出报告
./scripts/dev_cli.sh research export "$TASK_ID"
```

## 26. 当前能力边界

当前本地源码版已经支持：

```text
1. bootstrap 本地开发环境
2. doctor 环境检查
3. Research CLI 创建 TSF task
4. dataset path / preset / target-cols / context-length / prediction-lengths 参数
5. review / autonomous 两种模式
6. bridge-only / full-recipe-space 两类候选搜索空间
7. profile / diagnose task
8. seed baseline candidates
9. prepare / run / worker-once / worker-loop
10. artifacts / memory / export
11. Web Dashboard 源码启动
12. Neo-Cast Python runner 调用
13. Python runner 异步执行，不再用 spawnSync 阻塞 Node 进程
```

仍然要注意：

```text
1. 这不是 npm 正式发布安装教程，而是源码安装测试教程。
2. 真实训练依赖 Python ML 环境，尤其是 numpy/torch。
3. full recipe search 和 full stage 会比 smoke 消耗更多时间。
4. Web/TUI 的真实视觉截图验收需要单独启动服务后执行 UI 验证。
```

